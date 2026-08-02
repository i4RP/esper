import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CanUseTool,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const queryMock = vi.fn();
// Default to "installed" so the suite doesn't depend on whether the machine
// running it happens to have Claude Code.
const resolveExecutableMock = vi.fn<() => string | null>(
  () => "/opt/test/claude",
);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => queryMock(params),
}));

vi.mock(
  "../../src/services/agent/resolve-executable",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/agent/resolve-executable")
      >();
    return {
      ...actual,
      resolveClaudeExecutable: () => resolveExecutableMock(),
    };
  },
);

import { ClaudeCodeProvider } from "../../src/services/agent/providers/claude-code";
import type { ProviderEvent } from "../../src/services/agent/provider";

/**
 * Stand-in for the SDK's Query: an async generator we can feed messages into,
 * plus the control methods the provider calls.
 */
class FakeQuery {
  readonly interrupt = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly close = vi.fn();

  private readonly pending: SDKMessage[] = [];
  private waiting: ((value: IteratorResult<SDKMessage>) => void) | null = null;
  private failure: Error | null = null;
  private ended = false;

  emit(message: SDKMessage): void {
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  fail(error: Error): void {
    this.failure = error;
    this.end();
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    while (true) {
      const buffered = this.pending.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<SDKMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}

/** Lets a test wait for the provider's async pump to process messages. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const assistantWithText = (text: string): SDKMessage =>
  ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

const successResult = (): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    total_cost_usd: 0.01,
    result: "ok",
  }) as unknown as SDKMessage;

describe("ClaudeCodeProvider", () => {
  let provider: ClaudeCodeProvider;
  let fake: FakeQuery;
  let canUseTool: CanUseTool;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveExecutableMock.mockReturnValue("/opt/test/claude");
    fake = new FakeQuery();
    queryMock.mockImplementation(
      (params: { options?: { canUseTool?: CanUseTool } }) => {
        if (params.options?.canUseTool) {
          canUseTool = params.options.canUseTool;
        }
        return fake;
      },
    );
    provider = new ClaudeCodeProvider();
  });

  const collect = (session: {
    subscribe: (l: (e: ProviderEvent) => void) => () => void;
  }) => {
    const events: ProviderEvent[] = [];
    session.subscribe((event) => events.push(event));
    return events;
  };

  describe("availability", () => {
    it("reports the resolved path", () => {
      expect(provider.checkAvailability()).toEqual({
        available: true,
        path: "/opt/test/claude",
        reason: null,
      });
    });

    it("explains how to fix an unavailable install", () => {
      resolveExecutableMock.mockReturnValue(null);

      const availability = provider.checkAvailability();
      expect(availability.available).toBe(false);
      expect(availability.reason).toMatch(/Claude Code was not found/);
    });

    it("refuses to create a session when it isn't installed", async () => {
      resolveExecutableMock.mockReturnValue(null);

      await expect(provider.createSession({ cwd: "/tmp/p" })).rejects.toThrow(
        /Claude Code was not found/,
      );
      expect(queryMock).not.toHaveBeenCalled();
    });
  });

  describe("launch options", () => {
    // Without an absolute path the SDK falls back to PATH, which a packaged
    // macOS app doesn't inherit.
    it("hands the SDK an absolute executable path", async () => {
      await provider.createSession({ cwd: "/tmp/p" });

      expect(queryMock.mock.calls[0][0].options).toMatchObject({
        cwd: "/tmp/p",
        pathToClaudeCodeExecutable: "/opt/test/claude",
        permissionMode: "default",
      });
    });

    // The SDK persists the transcript under the id we supply, so resume can
    // only find the session if the two agree.
    it("uses its own session id and reports it", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      expect(queryMock.mock.calls[0][0].options.sessionId).toBe(
        session.nativeSessionId,
      );
    });

    it("forwards resume and fork", async () => {
      await provider.createSession({
        cwd: "/tmp/p",
        resume: "prev",
        fork: true,
      });

      expect(queryMock.mock.calls[0][0].options).toMatchObject({
        resume: "prev",
        forkSession: true,
      });
    });
  });

  describe("streaming", () => {
    it("emits normalized entries and settles to idle on a result", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      fake.emit(assistantWithText("hi there"));
      fake.emit(successResult());
      await flush();

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "entry",
          entry: expect.objectContaining({
            kind: "assistant",
            text: "hi there",
          }),
        }),
      );
      expect(events).toContainEqual({ type: "state", state: "idle" });
    });

    it("reports a failed stream as an error", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      fake.fail(new Error("claude process exited"));
      await flush();

      expect(events).toContainEqual({
        type: "error",
        message: "claude process exited",
      });
    });
  });

  describe("tool permissions", () => {
    it("parks the call and reports the request", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      let settled = false;
      void canUseTool("Bash", { command: "rm -rf /" }, {} as never).then(() => {
        settled = true;
      });
      await flush();

      expect(events).toContainEqual(
        expect.objectContaining({ type: "permission", toolName: "Bash" }),
      );
      // Still parked — nothing may run until the user answers.
      expect(settled).toBe(false);
    });

    it("allows the call when approved", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      const decision = canUseTool("Read", { file: "a.ts" }, {} as never);
      await flush();

      const request = events.find((e) => e.type === "permission");
      session.respondToPermission!(
        (request as { requestId: string }).requestId,
        { allow: true },
      );

      expect(await decision).toEqual<PermissionResult>({ behavior: "allow" });
    });

    it("denies with the reason so the agent can adapt", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      const decision = canUseTool("Bash", {}, {} as never);
      await flush();

      const request = events.find((e) => e.type === "permission");
      session.respondToPermission!(
        (request as { requestId: string }).requestId,
        { allow: false, reason: "Use the test runner instead." },
      );

      expect(await decision).toEqual<PermissionResult>({
        behavior: "deny",
        message: "Use the test runner instead.",
      });
    });

    // Without this the SDK child process waits on a promise that can never
    // settle, and the session leaks for the lifetime of the app.
    it("denies parked requests when the session is closed", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      const decision = canUseTool("Bash", {}, {} as never);
      await flush();
      session.close();

      expect(await decision).toMatchObject({ behavior: "deny" });
      expect(fake.close).toHaveBeenCalled();
    });

    it("denies parked requests when the stream fails", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      const decision = canUseTool("Bash", {}, {} as never);
      await flush();
      fake.fail(new Error("gone"));
      await flush();

      expect(await decision).toMatchObject({ behavior: "deny" });
    });

    it("ignores an answer to an unknown request", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      expect(() =>
        session.respondToPermission!("stale", { allow: true }),
      ).not.toThrow();
    });
  });

  describe("live controls", () => {
    it("interrupts and reports idle", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });
      const events = collect(session);

      await session.interrupt!();

      expect(fake.interrupt).toHaveBeenCalled();
      expect(events).toContainEqual({ type: "state", state: "idle" });
    });

    it("applies model and permission-mode changes", async () => {
      const session = await provider.createSession({ cwd: "/tmp/p" });

      await session.setModel!("claude-opus-5");
      await session.setPermissionMode!("plan");

      expect(fake.setModel).toHaveBeenCalledWith("claude-opus-5");
      expect(fake.setPermissionMode).toHaveBeenCalledWith("plan");
    });

    it("declares the capabilities the service branches on", () => {
      expect(provider.capabilities).toMatchObject({
        resume: true,
        interrupt: true,
        toolPermissions: true,
        selectModel: true,
      });
    });
  });
});
