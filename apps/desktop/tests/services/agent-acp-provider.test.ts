import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpProvider } from "../../src/services/agent/providers/acp";
import type { JsonRpcProcess } from "../../src/services/agent/jsonrpc-stdio";
import type { ProviderEvent } from "../../src/services/agent/provider";
import { resolveExecutable } from "../../src/services/agent/resolve-executable";

vi.mock(
  "../../src/services/agent/resolve-executable",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/agent/resolve-executable")
      >();
    return { ...actual, resolveExecutable: vi.fn(() => "/opt/test/agent") };
  },
);

/** Stands in for a real ACP agent process. */
class FakeRpc {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly closed = vi.fn();
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();
  private readonly requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >();

  /** Responses keyed by method; `session/prompt` may be left pending. */
  responses: Record<string, unknown> = {
    initialize: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    },
    "session/new": { sessionId: "acp-session-1" },
    "session/prompt": { stopReason: "end_turn" },
  };
  /** When set, session/prompt hangs until resolved by the test. */
  promptGate: (() => void) | null = null;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "session/prompt" && this.promptGate === null) {
      // Default: resolve immediately.
    }
    if (method === "session/prompt" && this.promptGate) {
      await new Promise<void>((resolve) => {
        this.promptGate = resolve;
      });
    }
    const response = this.responses[method];
    if (response instanceof Error) {
      throw response;
    }
    return response ?? null;
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(
    method: string,
    handler: (params: unknown) => unknown | Promise<unknown>,
  ): void {
    this.requestHandlers.set(method, handler);
  }

  close(): void {
    this.closed();
  }

  /** Simulates the agent pushing a session/update. */
  update(update: Record<string, unknown>): void {
    this.notificationHandlers.get("session/update")?.({
      sessionId: "acp-session-1",
      update,
    });
  }

  /** Simulates the agent asking for permission. Resolves with the reply. */
  askPermission(options: unknown[]): Promise<unknown> {
    const handler = this.requestHandlers.get("session/request_permission");
    return Promise.resolve(
      handler?.({
        sessionId: "acp-session-1",
        toolCall: { toolCallId: "call_1", title: "Run command" },
        options,
      }),
    );
  }
}

const spec = {
  id: "acp:test",
  label: "Test Agent",
  command: ["test-agent", "acp"],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const allowOptions = [
  { optionId: "a1", name: "Allow once", kind: "allow_once" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
];

describe("AcpProvider", () => {
  let rpc: FakeRpc;
  let provider: AcpProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveExecutable).mockReturnValue("/opt/test/agent");
    rpc = new FakeRpc();
    provider = new AcpProvider(spec, () => rpc as unknown as JsonRpcProcess);
  });

  const collect = (session: {
    subscribe: (l: (e: ProviderEvent) => void) => () => void;
  }) => {
    const events: ProviderEvent[] = [];
    session.subscribe((event) => events.push(event));
    return events;
  };

  describe("availability", () => {
    it("resolves the CLI and reports it available", () => {
      expect(provider.checkAvailability()).toMatchObject({
        available: true,
        path: "/opt/test/agent",
      });
    });

    it("explains how to fix a missing CLI", () => {
      vi.mocked(resolveExecutable).mockReturnValue(null);

      const availability = provider.checkAvailability();
      expect(availability.available).toBe(false);
      expect(availability.reason).toMatch(/Test Agent was not found/);
    });
  });

  describe("handshake", () => {
    it("initializes then creates a session", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      expect(rpc.calls.map((c) => c.method)).toEqual([
        "initialize",
        "session/new",
      ]);
      expect(rpc.calls[1].params).toMatchObject({ cwd: "/tmp/p" });
      expect(session.nativeSessionId).toBe("acp-session-1");
    });

    it("declares the protocol version it speaks", async () => {
      await provider.createSession({ cwd: "/tmp/p" });
      expect(rpc.calls[0].params).toMatchObject({ protocolVersion: 1 });
    });

    it("loads an existing session when the agent supports it", async () => {
      await provider.createSession({ cwd: "/tmp/p", resume: "old-session" });

      expect(rpc.calls.map((c) => c.method)).toEqual([
        "initialize",
        "session/load",
      ]);
    });

    // Falling back to a new session is better than failing outright: the user
    // still gets a working agent, just without the old transcript.
    it("starts fresh when the agent cannot load sessions", async () => {
      rpc.responses.initialize = {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
      };

      await provider.createSession({ cwd: "/tmp/p", resume: "old-session" });

      expect(rpc.calls.map((c) => c.method)).toEqual([
        "initialize",
        "session/new",
      ]);
    });

    // Otherwise a failed handshake leaks one child process per attempt.
    it("kills the process when the handshake fails", async () => {
      rpc.responses.initialize = new Error("bad handshake");

      await expect(provider.createSession({ cwd: "/tmp/p" })).rejects.toThrow(
        /bad handshake/,
      );
      expect(rpc.closed).toHaveBeenCalled();
    });

    it("fails when the agent returns no session id", async () => {
      rpc.responses["session/new"] = {};

      await expect(provider.createSession({ cwd: "/tmp/p" })).rejects.toThrow(
        /did not return a session id/,
      );
    });
  });

  describe("streaming", () => {
    it("coalesces message chunks into one entry per turn", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      rpc.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello " },
      });
      rpc.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
      });
      await session.send("hi");

      const entries = events.filter((e) => e.type === "entry");
      expect(entries).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({
            kind: "assistant",
            text: "Hello world",
          }),
        }),
      );
    });

    it("separates thinking from the answer", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      rpc.update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "considering" },
      });
      await session.send("hi");

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "entry",
          entry: expect.objectContaining({ kind: "thinking" }),
        }),
      );
    });

    // Text streamed before a tool call belongs above it in the transcript.
    it("flushes pending text before a tool call", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      rpc.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Let me look" },
      });
      rpc.update({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Read file",
      });

      const kinds = events
        .filter((e) => e.type === "entry")
        .map((e) => (e as { entry: { kind: string } }).entry.kind);
      expect(kinds).toEqual(["assistant", "tool_use"]);
    });

    it("emits a tool result only once the call finishes", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      rpc.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "in_progress",
      });
      expect(events.filter((e) => e.type === "entry")).toHaveLength(0);

      rpc.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      });

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "entry",
          entry: expect.objectContaining({
            kind: "tool_result",
            text: "done",
            isError: false,
          }),
        }),
      );
    });

    it("marks a failed tool call as an error", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      rpc.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "boom" } }],
      });

      expect(events).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({
            kind: "tool_result",
            isError: true,
          }),
        }),
      );
    });

    // An unknown update must not be fatal, or a newer ACP revision breaks the
    // session mid-turn.
    it("ignores update kinds it does not model", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      expect(() => {
        rpc.update({ sessionUpdate: "plan", entries: [] });
        rpc.update({ sessionUpdate: "some_future_kind" });
      }).not.toThrow();
      expect(events.filter((e) => e.type === "entry")).toHaveLength(0);
    });

    it("settles to idle after the turn", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      await session.send("hi");

      expect(events.at(-1)).toEqual({ type: "state", state: "idle" });
    });

    it("reports a failed turn as an error", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      rpc.responses["session/prompt"] = new Error("agent crashed");
      await session.send("hi");

      expect(events).toContainEqual({
        type: "error",
        message: "agent crashed",
      });
    });
  });

  describe("tool permissions", () => {
    it("maps approval onto the agent's allow option", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      const reply = rpc.askPermission(allowOptions);
      await flush();

      const request = events.find((e) => e.type === "permission") as {
        requestId: string;
        toolName: string;
      };
      expect(request.toolName).toBe("Run command");

      session.respondToPermission!(request.requestId, { allow: true });
      expect(await reply).toEqual({
        outcome: { outcome: "selected", optionId: "a1" },
      });
    });

    it("maps denial onto the agent's reject option", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      const reply = rpc.askPermission(allowOptions);
      await flush();
      const request = events.find((e) => e.type === "permission") as {
        requestId: string;
      };

      session.respondToPermission!(request.requestId, { allow: false });
      expect(await reply).toEqual({
        outcome: { outcome: "selected", optionId: "r1" },
      });
    });

    // Cancelling is the only truthful reply when the agent offered nothing
    // that matches the user's answer.
    it("cancels when no matching option was offered", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      const reply = rpc.askPermission([
        { optionId: "x", name: "Always allow", kind: "allow_always" },
      ]);
      await flush();
      const request = events.find((e) => e.type === "permission") as {
        requestId: string;
      };

      session.respondToPermission!(request.requestId, { allow: false });
      expect(await reply).toEqual({ outcome: { outcome: "cancelled" } });
    });

    // Otherwise the agent blocks on a reply that never comes and never exits.
    it("cancels parked requests when the session closes", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      const reply = rpc.askPermission(allowOptions);
      await flush();
      session.close();

      expect(await reply).toEqual({ outcome: { outcome: "cancelled" } });
    });
  });

  describe("interrupt", () => {
    it("sends a cancel notification for the session", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      await session.interrupt!();

      expect(rpc.notifications).toContainEqual({
        method: "session/cancel",
        params: { sessionId: "acp-session-1" },
      });
    });
  });

  describe("close", () => {
    it("shuts the process down", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      session.close();

      expect(rpc.closed).toHaveBeenCalled();
    });

    it("is idempotent", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      session.close();
      session.close();

      expect(rpc.closed).toHaveBeenCalledTimes(1);
    });
  });
});
