/**
 * Wire types for agent sessions.
 *
 * These are deliberately *not* the SDK's own message types. The Agent SDK's
 * `SDKMessage` union has ~35 variants that track Claude Code's internals and
 * change with it; every consumer that speaks these types instead — the settings
 * UI today, a phone over WebSocket later — would otherwise be coupled to an SDK
 * upgrade. Normalizing at the service boundary keeps that churn in one file.
 */

export type AgentSessionState =
  | "starting"
  | "idle"
  | "running"
  | "awaiting_permission"
  | "closed"
  | "error";

export interface AgentSessionSummary {
  id: string;
  /** Which agent runs this session, e.g. "claude-code" or "acp:cursor". */
  providerId: string;
  /**
   * The provider's own session id — what `resume` must be given. Null until the
   * provider reports it (ACP assigns it after `session/new`).
   */
  nativeSessionId: string | null;
  /** Working directory the agent operates in. */
  cwd: string;
  /** Derived from the first user turn until the session is renamed. */
  title: string | null;
  state: AgentSessionState;
  model: string | null;
  permissionMode: AgentPermissionMode;
  createdAt: number;
  lastActivityAt: number;
  /** Set when state is "error". */
  error: string | null;
}

/**
 * Mirrors the SDK's PermissionMode. Re-declared rather than re-exported so the
 * wire protocol doesn't silently gain a mode when the SDK adds one — a new mode
 * should be a deliberate change here, not an implicit widening of what a remote
 * client may ask for.
 */
export type AgentPermissionMode =
  | "default"
  | "dontAsk"
  | "plan"
  | "bypassPermissions";

export type AgentTimelineEntry =
  | { kind: "user"; id: string; at: number; text: string }
  | { kind: "assistant"; id: string; at: number; text: string }
  | { kind: "thinking"; id: string; at: number; text: string }
  | {
      kind: "tool_use";
      id: string;
      at: number;
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      id: string;
      at: number;
      toolUseId: string;
      text: string;
      isError: boolean;
    }
  | {
      kind: "result";
      id: string;
      at: number;
      success: boolean;
      durationMs: number | null;
      costUsd: number | null;
      text: string | null;
    }
  | { kind: "error"; id: string; at: number; message: string };

/**
 * A tool call the agent wants to make while `permissionMode` is "default".
 * The session is parked until `resolvePermission` is called — the SDK's
 * `canUseTool` promise is what actually blocks, so an unanswered request
 * stalls that session (and only that session) indefinitely.
 */
export interface AgentPermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  at: number;
}

export interface AgentPermissionDecision {
  allow: boolean;
  /** Shown to the agent on denial so it can adapt instead of retrying. */
  reason?: string;
}

export interface CreateAgentSessionInput {
  /** Defaults to the only available provider when exactly one is installed. */
  providerId?: string;
  cwd: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  /** Resume a previous session by id; the SDK reloads its transcript. */
  resume?: string;
  /** With `resume`, branch into a new session instead of continuing it. */
  fork?: boolean;
}

/** A provider offered to the user, with whether its CLI is actually installed. */
export interface AgentProviderInfo {
  id: string;
  label: string;
  available: boolean;
  /** Why it is unavailable, phrased for a user. Null when available. */
  reason: string | null;
  capabilities: import("./provider").AgentCapabilities;
}

export interface AgentServiceEvents {
  "session-updated": [AgentSessionSummary];
  "session-entry": [{ sessionId: string; entry: AgentTimelineEntry }];
  "permission-requested": [AgentPermissionRequest];
  "permission-resolved": [{ requestId: string; sessionId: string }];
}
