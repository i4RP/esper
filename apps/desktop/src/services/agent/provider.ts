import type {
  AgentPermissionDecision,
  AgentPermissionMode,
  AgentSessionState,
  AgentTimelineEntry,
} from "./types";

/**
 * What a provider can do, declared rather than inferred.
 *
 * Providers differ widely: Claude Code persists transcripts and can resume,
 * some ACP agents cannot; some expose modes, most don't. Without a declared
 * capability set every surface ends up branching on provider id, and each new
 * provider means touching the UI again. Surfaces read these flags instead.
 */
export interface AgentCapabilities {
  /** Sessions can be resumed by id after the process exits. */
  resume: boolean;
  /** The running turn can be cancelled. */
  interrupt: boolean;
  /** Tool calls are gated on an approval round-trip. */
  toolPermissions: boolean;
  /** The model can be chosen or changed. */
  selectModel: boolean;
  /** Named operating modes (plan mode and similar). */
  modes: boolean;
  /** Reasoning/thinking is streamed separately from the answer. */
  reasoningStream: boolean;
}

export const NO_CAPABILITIES: AgentCapabilities = {
  resume: false,
  interrupt: false,
  toolPermissions: false,
  selectModel: false,
  modes: false,
  reasoningStream: false,
};

/**
 * Everything a provider reports upward. Providers emit these; the service turns
 * them into timelines, state and permission prompts. Deliberately small — a
 * provider that can't produce a given event simply never emits it.
 */
export type ProviderEvent =
  | { type: "entry"; entry: AgentTimelineEntry }
  | { type: "state"; state: AgentSessionState }
  | {
      type: "permission";
      requestId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "permission-resolved"; requestId: string }
  | { type: "error"; message: string }
  /** The provider learned its own session id (ACP assigns it after `session/new`). */
  | { type: "session-id"; sessionId: string };

export interface CreateProviderSessionInput {
  cwd: string;
  model?: string;
  permissionMode?: AgentPermissionMode;
  /** Provider-native session id to resume. Only meaningful with `resume`. */
  resume?: string;
  fork?: boolean;
}

/** One live conversation with one agent. */
export interface ProviderSession {
  /**
   * The provider's own session id, once known. Null until assigned — ACP agents
   * return it from `session/new`, so it isn't available at construction time.
   */
  readonly nativeSessionId: string | null;

  send(text: string): void | Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
  close(): void | Promise<void>;

  /** Present only when the matching capability is set. */
  interrupt?(): Promise<void>;
  respondToPermission?(
    requestId: string,
    decision: AgentPermissionDecision,
  ): void | Promise<void>;
  setModel?(model: string | undefined): Promise<void>;
  setPermissionMode?(mode: AgentPermissionMode): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  listModes?(): Promise<AgentMode[]>;
}

export interface AgentMode {
  id: string;
  label: string;
}

/** Availability of a provider's underlying CLI on this machine. */
export interface ProviderAvailability {
  available: boolean;
  /** Absolute path to the executable, when found. */
  path: string | null;
  /** Why it's unavailable, phrased for a user. */
  reason: string | null;
}

/**
 * A kind of agent Esper can run. One instance per provider, not per session.
 */
export interface AgentProviderClient {
  /** Stable id used in wire messages and settings, e.g. "claude-code". */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  readonly capabilities: AgentCapabilities;

  checkAvailability(): ProviderAvailability;
  createSession(input: CreateProviderSessionInput): Promise<ProviderSession>;
}
