import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  AgentProviderClient,
  ProviderEvent,
  ProviderSession,
} from "./provider";
import type {
  AgentPermissionDecision,
  AgentPermissionMode,
  AgentPermissionRequest,
  AgentProviderInfo,
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
  provider: AgentProviderClient;
  session: ProviderSession;
  timeline: AgentTimelineEntry[];
  unsubscribe: () => void;
  /** Permission requests awaiting an answer, by request id. */
  pending: Set<string>;
}

/**
 * Runs coding-agent sessions and exposes them as observable, addressable
 * objects.
 *
 * Providers own how their agent is launched and spoken to; this service owns
 * what is common to all of them — which sessions exist, what state each is in,
 * a live timeline for UI, and routing tool-permission questions to whoever is
 * watching (a settings pane today, a phone later).
 */
export class AgentService extends EventEmitter {
  private readonly providers = new Map<string, AgentProviderClient>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly logger: AgentLogger) {
    super();
  }

  register(provider: AgentProviderClient): void {
    this.providers.set(provider.id, provider);
  }

  /** Every registered provider with its current availability. */
  listProviders(): AgentProviderInfo[] {
    return [...this.providers.values()].map((provider) => {
      const availability = provider.checkAvailability();
      return {
        id: provider.id,
        label: provider.label,
        available: availability.available,
        reason: availability.reason,
        capabilities: provider.capabilities,
      };
    });
  }

  /** Whether any provider can currently start a session. */
  isAvailable(): boolean {
    return this.listProviders().some((provider) => provider.available);
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

  async createSession(
    input: CreateAgentSessionInput,
  ): Promise<AgentSessionSummary> {
    const provider = this.resolveProvider(input.providerId);

    const availability = provider.checkAvailability();
    if (!availability.available) {
      throw new Error(
        availability.reason ?? `${provider.label} is not available.`,
      );
    }

    const id = randomUUID();
    const now = Date.now();
    const summary: AgentSessionSummary = {
      id,
      providerId: provider.id,
      nativeSessionId: null,
      cwd: input.cwd,
      title: null,
      state: "starting",
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? "default",
      createdAt: now,
      lastActivityAt: now,
      error: null,
    };

    const providerSession = await provider.createSession({
      cwd: input.cwd,
      model: input.model,
      permissionMode: input.permissionMode,
      resume: input.resume,
      fork: input.fork,
    });

    const session: Session = {
      summary,
      provider,
      session: providerSession,
      timeline: [],
      unsubscribe: () => {},
      pending: new Set(),
    };

    session.unsubscribe = providerSession.subscribe((event) =>
      this.handleProviderEvent(session, event),
    );
    // Providers that know their id up front (Claude Code) never emit
    // "session-id", so seed it here.
    summary.nativeSessionId = providerSession.nativeSessionId;

    this.sessions.set(id, session);
    this.logger.info("Agent session created", {
      sessionId: id,
      provider: provider.id,
      cwd: input.cwd,
      resume: input.resume ?? null,
    });

    return summary;
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);

    await session.session.send(text);

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
    if (!session.session.interrupt) {
      throw new Error(`${session.provider.label} cannot interrupt a turn.`);
    }
    await session.session.interrupt();
  }

  async setPermissionMode(
    sessionId: string,
    mode: AgentPermissionMode,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.session.setPermissionMode) {
      throw new Error(`${session.provider.label} has no permission modes.`);
    }
    await session.session.setPermissionMode(mode);
    session.summary.permissionMode = mode;
    this.touch(session);
  }

  async setModel(sessionId: string, model: string | undefined): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.session.setModel) {
      throw new Error(`${session.provider.label} cannot change model.`);
    }
    await session.session.setModel(model);
    session.summary.model = model ?? null;
    this.touch(session);
  }

  /**
   * Answers a pending tool-permission question. Unknown ids are ignored rather
   * than thrown: a request is also resolved by the session closing or being
   * interrupted, so a slow UI (or a phone on a flaky link) can easily answer
   * one that no longer exists.
   */
  async resolvePermission(
    sessionId: string,
    requestId: string,
    decision: AgentPermissionDecision,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.pending.has(requestId)) {
      return;
    }
    await session.session.respondToPermission?.(requestId, decision);
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.unsubscribe();
    void session.session.close();
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

  private handleProviderEvent(session: Session, event: ProviderEvent): void {
    switch (event.type) {
      case "entry":
        this.appendEntry(session, event.entry);
        return;

      case "state":
        this.setState(
          session,
          // A provider reporting "running" while a question is outstanding
          // must not clear the prompt the user is looking at.
          session.pending.size > 0 && event.state === "running"
            ? "awaiting_permission"
            : event.state,
        );
        return;

      case "permission": {
        session.pending.add(event.requestId);
        const request: AgentPermissionRequest = {
          id: event.requestId,
          sessionId: session.summary.id,
          toolName: event.toolName,
          input: event.input,
          at: Date.now(),
        };
        this.setState(session, "awaiting_permission");
        this.emit("permission-requested", request);
        this.logger.debug("Agent tool permission requested", {
          sessionId: session.summary.id,
          toolName: event.toolName,
        });
        return;
      }

      case "permission-resolved":
        session.pending.delete(event.requestId);
        this.emit("permission-resolved", {
          requestId: event.requestId,
          sessionId: session.summary.id,
        });
        if (session.pending.size === 0) {
          this.setState(session, "running");
        }
        return;

      case "session-id":
        // Providers that assign their own id (ACP) report it once known; it is
        // what a later resume has to be given.
        session.summary.nativeSessionId = event.sessionId;
        this.touch(session);
        return;

      case "error":
        session.summary.error = event.message;
        this.setState(session, "error");
        this.logger.error("Agent session failed", {
          sessionId: session.summary.id,
          error: event.message,
        });
        return;
    }
  }

  private resolveProvider(providerId?: string): AgentProviderClient {
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        throw new Error(`Unknown agent provider: ${providerId}`);
      }
      return provider;
    }

    // With one provider installed, asking the caller to name it is friction for
    // no benefit. With several it is ambiguous, so make the caller choose.
    const available = [...this.providers.values()].filter(
      (provider) => provider.checkAvailability().available,
    );
    if (available.length === 1) {
      return available[0];
    }
    if (available.length === 0) {
      throw new Error(
        "No coding agent is installed. Install Claude Code or another supported agent.",
      );
    }
    throw new Error(
      `Several agents are available (${available
        .map((provider) => provider.id)
        .join(", ")}); specify which to use.`,
    );
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
