import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { InputQueue } from "./input-queue";
import { normalizeMessage } from "./normalize";
import type {
  AgentPermissionDecision,
  AgentPermissionMode,
  AgentPermissionRequest,
  AgentSessionState,
  AgentSessionSummary,
  AgentTimelineEntry,
  CreateAgentSessionInput,
} from "./types";

/**
 * Logging is injected rather than imported. The app's logger pulls in
 * `electron` (it reads `app.isPackaged`), and keeping this service free of
 * Electron is what lets it move into a standalone daemon process later without
 * touching its logic — the remote-access work needs exactly that.
 */
export interface AgentLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
}

/** Timeline entries held per session before older ones are dropped. */
const MAX_TIMELINE_ENTRIES = 2000;

interface Session {
  summary: AgentSessionSummary;
  queue: InputQueue;
  query: Query;
  timeline: AgentTimelineEntry[];
  /** Pending `canUseTool` promises, keyed by request id. */
  pendingPermissions: Map<string, (result: PermissionResult) => void>;
}

/**
 * Runs Claude Code sessions and exposes them as observable, addressable
 * objects.
 *
 * Session lifecycle, transcript persistence, resume/fork and interruption all
 * belong to the Agent SDK — this service owns the parts the SDK deliberately
 * leaves to the host: which sessions exist, what state each is in, a live
 * timeline for UI, and routing tool-permission questions to whoever is
 * watching (a settings pane today, a phone later).
 */
export class AgentService extends EventEmitter {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly logger: AgentLogger) {
    super();
  }

  listSessions(): AgentSessionSummary[] {
    return [...this.sessions.values()]
      .map((session) => session.summary)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  getSession(sessionId: string): AgentSessionSummary | null {
    return this.sessions.get(sessionId)?.summary ?? null;
  }

  getTimeline(sessionId: string): AgentTimelineEntry[] {
    return this.sessions.get(sessionId)?.timeline ?? [];
  }

  createSession(input: CreateAgentSessionInput): AgentSessionSummary {
    const id = randomUUID();
    const now = Date.now();
    const permissionMode = input.permissionMode ?? "default";

    const queue = new InputQueue();
    const summary: AgentSessionSummary = {
      id,
      cwd: input.cwd,
      title: null,
      state: "starting",
      model: input.model ?? null,
      permissionMode,
      createdAt: now,
      lastActivityAt: now,
      error: null,
    };

    const session: Session = {
      summary,
      queue,
      // Assigned immediately below; `query()` is synchronous and needs the
      // session object to exist first so `canUseTool` can close over it.
      query: undefined as unknown as Query,
      timeline: [],
      pendingPermissions: new Map(),
    };

    session.query = query({
      // Always streaming input: interrupt(), setModel() and setPermissionMode()
      // are unavailable in single-prompt mode.
      prompt: queue.stream(),
      options: {
        cwd: input.cwd,
        sessionId: id,
        permissionMode,
        ...(input.model ? { model: input.model } : {}),
        ...(input.resume
          ? { resume: input.resume, forkSession: input.fork ?? false }
          : {}),
        canUseTool: this.makeCanUseTool(session),
      },
    });

    this.sessions.set(id, session);
    void this.pump(session);

    this.logger.info("Agent session created", {
      sessionId: id,
      cwd: input.cwd,
      resume: input.resume ?? null,
    });

    return summary;
  }

  sendMessage(sessionId: string, text: string): void {
    const session = this.requireSession(sessionId);

    session.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      // Marks this as typed (or dictated) by a person rather than machine-
      // generated. The SDK fails closed at trust gates on unattributed input.
      origin: { kind: "human" },
      session_id: sessionId,
    });

    this.appendEntry(session, {
      kind: "user",
      id: randomUUID(),
      at: Date.now(),
      text,
    });

    // First real turn names the session, so a list of sessions is readable
    // without opening each one.
    if (session.summary.title === null) {
      session.summary.title = text.trim().slice(0, 80) || null;
    }

    this.setState(session, "running");
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.query.interrupt();
    this.setState(session, "idle");
  }

  async setPermissionMode(
    sessionId: string,
    mode: AgentPermissionMode,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.query.setPermissionMode(mode);
    session.summary.permissionMode = mode;
    this.touch(session);
  }

  async setModel(sessionId: string, model: string | undefined): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.query.setModel(model);
    session.summary.model = model ?? null;
    this.touch(session);
  }

  /**
   * Answers a pending tool-permission question. Unknown ids are ignored rather
   * than thrown: a request is also resolved by the session closing or being
   * interrupted, so a slow UI (or a phone on a flaky link) can easily answer
   * one that no longer exists.
   */
  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: AgentPermissionDecision,
  ): void {
    const session = this.sessions.get(sessionId);
    const resolve = session?.pendingPermissions.get(requestId);
    if (!session || !resolve) {
      return;
    }

    session.pendingPermissions.delete(requestId);
    resolve(
      decision.allow
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            message: decision.reason ?? "Denied by the user.",
          },
    );

    this.emit("permission-resolved", { requestId, sessionId });
    this.setState(
      session,
      session.pendingPermissions.size > 0 ? "awaiting_permission" : "running",
    );
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Deny anything still parked, or the SDK process would sit on a promise
    // that can never settle and never exit.
    this.denyAllPending(session, "Session closed.");

    session.queue.close();
    session.query.close();
    this.sessions.delete(sessionId);

    this.setState(session, "closed");
    this.logger.info("Agent session closed", { sessionId });
  }

  /** Closes every session. Call on app quit so no child process is orphaned. */
  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId);
    }
  }

  private makeCanUseTool(session: Session): CanUseTool {
    return (toolName, input) =>
      new Promise<PermissionResult>((resolve) => {
        const request: AgentPermissionRequest = {
          id: randomUUID(),
          sessionId: session.summary.id,
          toolName,
          input,
          at: Date.now(),
        };

        session.pendingPermissions.set(request.id, resolve);
        this.setState(session, "awaiting_permission");
        this.emit("permission-requested", request);

        this.logger.debug("Agent tool permission requested", {
          sessionId: session.summary.id,
          toolName,
        });
      });
  }

  private async pump(session: Session): Promise<void> {
    try {
      for await (const message of session.query) {
        this.handleMessage(session, message);
      }
      this.setState(session, "closed");
    } catch (error) {
      // The iterator throwing is terminal for this session: no further
      // messages arrive, so anything waiting on a permission is stuck.
      this.denyAllPending(session, "Session ended.");
      session.summary.error =
        error instanceof Error ? error.message : String(error);
      this.setState(session, "error");
      this.logger.error("Agent session failed", {
        sessionId: session.summary.id,
        error: session.summary.error,
      });
    }
  }

  private handleMessage(session: Session, message: SDKMessage): void {
    const at = Date.now();

    for (const entry of normalizeMessage(message, at)) {
      this.appendEntry(session, entry);
    }

    // A result message ends the turn — the agent is waiting on us again.
    if (message.type === "result") {
      this.setState(session, "idle");
      return;
    }

    if (message.type === "assistant") {
      this.setState(
        session,
        session.pendingPermissions.size > 0 ? "awaiting_permission" : "running",
      );
    }
  }

  private appendEntry(session: Session, entry: AgentTimelineEntry): void {
    session.timeline.push(entry);
    if (session.timeline.length > MAX_TIMELINE_ENTRIES) {
      session.timeline.splice(
        0,
        session.timeline.length - MAX_TIMELINE_ENTRIES,
      );
    }

    this.touch(session);
    this.emit("session-entry", { sessionId: session.summary.id, entry });
  }

  private denyAllPending(session: Session, message: string): void {
    for (const [requestId, resolve] of session.pendingPermissions) {
      resolve({ behavior: "deny", message });
      this.emit("permission-resolved", {
        requestId,
        sessionId: session.summary.id,
      });
    }
    session.pendingPermissions.clear();
  }

  private setState(session: Session, state: AgentSessionState): void {
    if (session.summary.state === state) {
      return;
    }
    session.summary.state = state;
    this.touch(session);
  }

  private touch(session: Session): void {
    session.summary.lastActivityAt = Date.now();
    this.emit("session-updated", { ...session.summary });
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown agent session: ${sessionId}`);
    }
    return session;
  }
}
