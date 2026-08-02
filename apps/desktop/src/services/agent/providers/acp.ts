import { randomUUID } from "node:crypto";
import { JsonRpcProcess } from "../jsonrpc-stdio";
import type { JsonRpcProcessOptions } from "../jsonrpc-stdio";
import { notInstalledMessage, resolveExecutable } from "../resolve-executable";
import type {
  AgentCapabilities,
  AgentProviderClient,
  CreateProviderSessionInput,
  ProviderAvailability,
  ProviderEvent,
  ProviderSession,
} from "../provider";
import type { AgentPermissionDecision, AgentTimelineEntry } from "../types";

/** The ACP revision this client speaks. */
const PROTOCOL_VERSION = 1;

/** One entry in the ACP catalog — an agent that speaks ACP over stdio. */
export interface AcpAgentSpec {
  /** Provider id, namespaced to avoid colliding with native providers. */
  id: string;
  label: string;
  /** Executable name, resolved against well-known install locations. */
  command: string;
  /** Arguments that put the CLI into ACP mode. */
  args: string[];
}

/**
 * Capabilities claimed before an agent is launched.
 *
 * ACP agents differ — `loadSession` is optional, thinking streams are optional
 * — but capabilities are read by surfaces before any process exists. These are
 * the protocol's baseline: cancellation and permission requests are mandatory,
 * so they are always safe to promise. Per-agent facts (does it support resume)
 * are only knowable after `initialize`, and are reported per session.
 */
const CAPABILITIES: AgentCapabilities = {
  resume: false,
  interrupt: true,
  toolPermissions: true,
  selectModel: false,
  modes: false,
  reasoningStream: true,
};

interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: { loadSession?: boolean };
  authMethods?: unknown[];
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Pulls plain text out of ACP's content-block shapes. */
const readContentText = (content: unknown): string => {
  if (!isRecord(content)) {
    return "";
  }
  const direct = readString(content.text);
  if (direct !== null) {
    return direct;
  }
  // tool_call_update wraps the block one level deeper.
  if (isRecord(content.content)) {
    return readString(content.content.text) ?? "";
  }
  return "";
};

class AcpSession implements ProviderSession {
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly pendingPermissions = new Map<
    string,
    (optionId: string | null) => void
  >();
  /** Streamed assistant/thought text, buffered per kind until flushed. */
  private buffers: { assistant: string; thinking: string } = {
    assistant: "",
    thinking: "",
  };
  private sessionId: string | null = null;
  private supportsLoadSession = false;
  private closed = false;

  constructor(
    private readonly rpc: JsonRpcProcess,
    private readonly label: string,
  ) {
    this.rpc.onNotification("session/update", (params) =>
      this.handleUpdate(params),
    );
    this.rpc.onRequest("session/request_permission", (params) =>
      this.handlePermissionRequest(params),
    );
  }

  get nativeSessionId(): string | null {
    return this.sessionId;
  }

  get canResume(): boolean {
    return this.supportsLoadSession;
  }

  /** Runs `initialize` then `session/new` (or `session/load` when resuming). */
  async start(input: CreateProviderSessionInput): Promise<void> {
    const initialized = await this.rpc.request<InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      // Declared honestly: Esper does not serve filesystem or terminal methods
      // back to the agent, so agents must use their own tools for that.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this.supportsLoadSession =
      initialized?.agentCapabilities?.loadSession === true;

    if (input.resume && this.supportsLoadSession) {
      await this.rpc.request("session/load", {
        sessionId: input.resume,
        cwd: input.cwd,
        mcpServers: [],
      });
      this.sessionId = input.resume;
    } else {
      const created = await this.rpc.request<{ sessionId?: string }>(
        "session/new",
        { cwd: input.cwd, mcpServers: [] },
      );
      const sessionId = readString(created?.sessionId);
      if (!sessionId) {
        throw new Error(`${this.label} did not return a session id.`);
      }
      this.sessionId = sessionId;
    }

    this.emit({ type: "session-id", sessionId: this.sessionId });
    this.emit({ type: "state", state: "idle" });
  }

  async send(text: string): Promise<void> {
    const sessionId = this.requireSessionId();
    this.emit({ type: "state", state: "running" });

    try {
      // Resolves only when the whole turn ends; streamed output arrives as
      // session/update notifications in the meantime.
      const result = await this.rpc.request<{ stopReason?: string }>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
      );
      this.flushBuffers();
      this.emitTurnResult(readString(result?.stopReason) ?? "end_turn");
    } catch (error) {
      this.flushBuffers();
      if (!this.closed) {
        this.emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    // Cancellation is a notification: the in-flight session/prompt resolves
    // with stopReason "cancelled" rather than this call returning anything.
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  respondToPermission(
    requestId: string,
    decision: AgentPermissionDecision,
  ): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    resolve(decision.allow ? "allow" : "deny");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Cancel anything parked: the agent is blocked on our reply and would
    // never exit otherwise.
    for (const resolve of this.pendingPermissions.values()) {
      resolve(null);
    }
    this.pendingPermissions.clear();
    this.rpc.close();
    this.listeners.clear();
  }

  private handleUpdate(params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const update = isRecord(params.update) ? params.update : params;
    const kind = readString(update.sessionUpdate);

    switch (kind) {
      case "agent_message_chunk":
        this.buffers.assistant += readContentText(update.content);
        return;

      case "agent_thought_chunk":
        this.buffers.thinking += readContentText(update.content);
        return;

      case "tool_call": {
        // Text streamed before a tool call belongs above it in the transcript.
        this.flushBuffers();
        this.push({
          kind: "tool_use",
          id: randomUUID(),
          at: Date.now(),
          toolUseId: readString(update.toolCallId) ?? randomUUID(),
          name: readString(update.title) ?? readString(update.kind) ?? "tool",
          input: update.rawInput ?? null,
        });
        return;
      }

      case "tool_call_update": {
        const status = readString(update.status);
        // pending/in_progress are progress ticks; only a finished call has a
        // result worth showing.
        if (status !== "completed" && status !== "failed") {
          return;
        }
        const content = Array.isArray(update.content) ? update.content : [];
        this.push({
          kind: "tool_result",
          id: randomUUID(),
          at: Date.now(),
          toolUseId: readString(update.toolCallId) ?? "",
          text: content.map(readContentText).filter(Boolean).join("\n"),
          isError: status === "failed",
        });
        return;
      }

      default:
        // plan, usage_update, available_commands_update and anything added in a
        // later ACP revision: ignored rather than fatal.
        return;
    }
  }

  private handlePermissionRequest(params: unknown): Promise<unknown> {
    const request = isRecord(params) ? params : {};
    const options: PermissionOption[] = Array.isArray(request.options)
      ? (request.options.filter(isRecord) as unknown as PermissionOption[])
      : [];
    const toolCall = isRecord(request.toolCall) ? request.toolCall : {};

    return new Promise((resolve) => {
      const requestId = randomUUID();

      this.pendingPermissions.set(requestId, (choice) => {
        if (choice === null) {
          resolve({ outcome: { outcome: "cancelled" } });
          this.emit({ type: "permission-resolved", requestId });
          return;
        }

        const wanted =
          choice === "allow"
            ? ["allow_once", "allow_always"]
            : ["reject_once", "reject_always"];
        const option = options.find((candidate) =>
          wanted.includes(candidate.kind),
        );

        // An agent that offered no matching option leaves nothing to select;
        // cancelling is the only truthful answer.
        resolve(
          option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
        this.emit({ type: "permission-resolved", requestId });
      });

      this.flushBuffers();
      this.emit({
        type: "permission",
        requestId,
        toolName:
          readString(toolCall.title) ??
          readString(toolCall.toolCallId) ??
          "tool",
        input: toolCall.rawInput ?? toolCall,
      });
    });
  }

  /** Turns buffered stream text into timeline entries. */
  private flushBuffers(): void {
    const { thinking, assistant } = this.buffers;
    this.buffers = { assistant: "", thinking: "" };

    if (thinking.trim()) {
      this.push({
        kind: "thinking",
        id: randomUUID(),
        at: Date.now(),
        text: thinking,
      });
    }
    if (assistant.trim()) {
      this.push({
        kind: "assistant",
        id: randomUUID(),
        at: Date.now(),
        text: assistant,
      });
    }
  }

  private emitTurnResult(stopReason: string): void {
    this.push({
      kind: "result",
      id: randomUUID(),
      at: Date.now(),
      success: stopReason === "end_turn" || stopReason === "cancelled",
      durationMs: null,
      costUsd: null,
      text: null,
    });
    this.emit({ type: "state", state: "idle" });
  }

  private push(entry: AgentTimelineEntry): void {
    this.emit({ type: "entry", entry });
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error(`${this.label} session is not ready.`);
    }
    return this.sessionId;
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/**
 * Any agent that speaks the Agent Client Protocol.
 *
 * One implementation covers the whole ACP catalog — Cursor, GitHub Copilot,
 * Gemini CLI, goose, Qwen Code and the rest — because they differ only in
 * which binary to launch. That is why this is worth more than any single
 * native integration.
 */
export class AcpProvider implements AgentProviderClient {
  readonly id: string;
  readonly label: string;
  readonly capabilities = CAPABILITIES;

  /**
   * `createProcess` exists so tests can drive the protocol without spawning a
   * real agent; production always uses the default.
   */
  constructor(
    private readonly spec: AcpAgentSpec,
    private readonly createProcess: (
      options: JsonRpcProcessOptions,
    ) => JsonRpcProcess = (options) => new JsonRpcProcess(options),
  ) {
    this.id = spec.id;
    this.label = spec.label;
  }

  checkAvailability(): ProviderAvailability {
    const path = resolveExecutable(this.spec.command);
    return {
      available: path !== null,
      path,
      reason:
        path === null
          ? notInstalledMessage(this.spec.label, this.spec.command)
          : null,
    };
  }

  async createSession(
    input: CreateProviderSessionInput,
  ): Promise<ProviderSession> {
    const { path, reason } = this.checkAvailability();
    if (!path) {
      throw new Error(reason ?? `${this.label} is not installed.`);
    }

    const rpc = this.createProcess({
      command: path,
      args: this.spec.args,
      cwd: input.cwd,
    });
    const session = new AcpSession(rpc, this.label);

    try {
      await session.start(input);
    } catch (error) {
      // Leaving the process running after a failed handshake would leak a
      // child per attempt.
      session.close();
      throw error;
    }

    return session;
  }
}
