import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { InputQueue } from "../input-queue";
import { normalizeMessage } from "./claude-code-normalize";
import {
  CLAUDE_NOT_FOUND_MESSAGE,
  resolveClaudeExecutable,
} from "../resolve-executable";
import type {
  AgentCapabilities,
  AgentProviderClient,
  CreateProviderSessionInput,
  ProviderAvailability,
  ProviderEvent,
  ProviderSession,
} from "../provider";
import type { AgentPermissionDecision, AgentPermissionMode } from "../types";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";

const CAPABILITIES: AgentCapabilities = {
  resume: true,
  interrupt: true,
  toolPermissions: true,
  selectModel: true,
  // Claude Code has plan mode, but the SDK exposes it through permissionMode
  // rather than a mode list, so it's surfaced as a permission mode instead.
  modes: false,
  reasoningStream: true,
};

class ClaudeCodeSession implements ProviderSession {
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly pendingPermissions = new Map<
    string,
    (result: PermissionResult) => void
  >();
  private readonly queue = new InputQueue();
  private readonly query: Query;

  constructor(
    readonly nativeSessionId: string,
    input: CreateProviderSessionInput,
    executable: string,
  ) {
    this.query = query({
      // Always streaming input: interrupt(), setModel() and setPermissionMode()
      // are unavailable in single-prompt mode.
      prompt: this.queue.stream(),
      options: {
        cwd: input.cwd,
        sessionId: nativeSessionId,
        permissionMode: input.permissionMode ?? "default",
        // Absolute path: a packaged app does not inherit the shell's PATH, so
        // the SDK's own PATH lookup would fail there.
        pathToClaudeCodeExecutable: executable,
        ...(input.model ? { model: input.model } : {}),
        ...(input.resume
          ? { resume: input.resume, forkSession: input.fork ?? false }
          : {}),
        canUseTool: this.canUseTool,
      },
    });

    void this.pump();
  }

  send(text: string): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      // Marks this as typed (or dictated) by a person. The SDK fails closed at
      // trust gates on unattributed input.
      origin: { kind: "human" },
      session_id: this.nativeSessionId,
    });
    this.emit({ type: "state", state: "running" });
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt();
    this.emit({ type: "state", state: "idle" });
  }

  async setModel(model: string | undefined): Promise<void> {
    await this.query.setModel(model);
  }

  async setPermissionMode(mode: AgentPermissionMode): Promise<void> {
    await this.query.setPermissionMode(mode);
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
    resolve(
      decision.allow
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            message: decision.reason ?? "Denied by the user.",
          },
    );
    this.emit({ type: "permission-resolved", requestId });
  }

  close(): void {
    // Deny anything still parked, or the child process sits on a promise that
    // can never settle and never exits.
    this.denyAllPending("Session closed.");
    this.queue.close();
    this.query.close();
    this.listeners.clear();
  }

  private readonly canUseTool: CanUseTool = (toolName, input) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      this.pendingPermissions.set(requestId, resolve);
      this.emit({ type: "permission", requestId, toolName, input });
    });

  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.handleMessage(message);
      }
      this.emit({ type: "state", state: "closed" });
    } catch (error) {
      // Terminal for this session: no further messages arrive, so anything
      // waiting on a permission would hang forever.
      this.denyAllPending("Session ended.");
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleMessage(message: SDKMessage): void {
    for (const entry of normalizeMessage(message, Date.now())) {
      this.emit({ type: "entry", entry });
    }

    if (message.type === "result") {
      this.emit({ type: "state", state: "idle" });
    }
  }

  private denyAllPending(message: string): void {
    for (const [requestId, resolve] of this.pendingPermissions) {
      resolve({ behavior: "deny", message });
      this.emit({ type: "permission-resolved", requestId });
    }
    this.pendingPermissions.clear();
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/**
 * Claude Code, driven through the Agent SDK.
 *
 * The SDK owns session lifecycle, transcript persistence, resume/fork and
 * interruption; this adapter only translates between its message stream and
 * Esper's provider contract.
 */
export class ClaudeCodeProvider implements AgentProviderClient {
  readonly id = CLAUDE_CODE_PROVIDER_ID;
  readonly label = "Claude Code";
  readonly capabilities = CAPABILITIES;

  checkAvailability(): ProviderAvailability {
    const path = resolveClaudeExecutable();
    return {
      available: path !== null,
      path,
      reason: path === null ? CLAUDE_NOT_FOUND_MESSAGE : null,
    };
  }

  async createSession(
    input: CreateProviderSessionInput,
  ): Promise<ProviderSession> {
    const { path } = this.checkAvailability();
    if (!path) {
      throw new Error(CLAUDE_NOT_FOUND_MESSAGE);
    }

    // The SDK persists the transcript under the id we supply, so generating it
    // here is what makes resume able to find the session later.
    return new ClaudeCodeSession(randomUUID(), input, path);
  }
}
