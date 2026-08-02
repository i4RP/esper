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

import { AgentService } from "../../src/services/agent/agent-service";
import type {
  AgentPermissionRequest,
  AgentSessionSummary,
} from "../../src/services/agent/types";

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

/**
 * Stand-in for the SDK's Query: an async generator we can feed messages into
 * from the test, plus the control methods the service calls.
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

/** Lets a test wait for the service's async pump to process emitted messages. */
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

describe("AgentService", () => {
  let service: AgentService;
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
    service = new AgentService(silentLogger);
  });

  describe("session lifecycle", () => {
    it("creates a session and lists it", () => {
      const summary = service.createSession({ cwd: "/tmp/project" });

      expect(summary.cwd).toBe("/tmp/project");
      expect(summary.state).toBe("starting");
      expect(summary.title).toBeNull();
      expect(service.listSessions()).toHaveLength(1);
      expect(service.getSession(summary.id)).toMatchObject({ id: summary.id });
    });

    // The id the service hands out must be the id the SDK persists the
    // transcript under, or resume can never find the session again.
    it("passes its own session id and cwd through to the SDK", () => {
      const summary = service.createSession({ cwd: "/tmp/project" });

      expect(queryMock).toHaveBeenCalledTimes(1);
      const options = queryMock.mock.calls[0][0].options;
      expect(options.sessionId).toBe(summary.id);
      expect(options.cwd).toBe("/tmp/project");
      expect(options.permissionMode).toBe("default");
    });

    it("forwards resume and fork when resuming", () => {
      service.createSession({
        cwd: "/tmp/p",
        resume: "prev-session",
        fork: true,
      });

      const options = queryMock.mock.calls[0][0].options;
      expect(options.resume).toBe("prev-session");
      expect(options.forkSession).toBe(true);
    });

    it("titles the session from the first turn only", () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });

      service.sendMessage(id, "add a health endpoint");
      expect(service.getSession(id)?.title).toBe("add a health endpoint");

      service.sendMessage(id, "now add tests");
      expect(service.getSession(id)?.title).toBe("add a health endpoint");
    });

    // Without an absolute path the SDK falls back to PATH, which a packaged
    // macOS app doesn't inherit — so the resolved path must reach the SDK.
    it("hands the SDK an absolute path to the executable", () => {
      service.createSession({ cwd: "/tmp/p" });

      expect(
        queryMock.mock.calls[0][0].options.pathToClaudeCodeExecutable,
      ).toBe("/opt/test/claude");
    });

    it("reports availability from the resolver", () => {
      expect(service.isAvailable()).toBe(true);

      resolveExecutableMock.mockReturnValue(null);
      expect(service.isAvailable()).toBe(false);
    });

    it("refuses to start a session when Claude Code isn't installed", () => {
      resolveExecutableMock.mockReturnValue(null);

      expect(() => service.createSession({ cwd: "/tmp/p" })).toThrow(
        /Claude Code was not found/,
      );
      expect(queryMock).not.toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(0);
    });

    it("throws on operations against an unknown session", () => {
      expect(() => service.sendMessage("nope", "hi")).toThrow(
        /Unknown agent session/,
      );
    });

    it("removes the session and closes the SDK query on close", () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });

      service.closeSession(id);

      expect(fake.close).toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(0);
    });

    it("closes every session on shutdown", () => {
      service.createSession({ cwd: "/tmp/a" });
      service.createSession({ cwd: "/tmp/b" });

      service.shutdown();

      expect(service.listSessions()).toHaveLength(0);
    });
  });

  describe("timeline", () => {
    it("records the user turn and streamed assistant text", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      service.sendMessage(id, "hello");

      fake.emit(assistantWithText("hi there"));
      await flush();

      expect(service.getTimeline(id).map((e) => e.kind)).toEqual([
        "user",
        "assistant",
      ]);
    });

    it("goes back to idle when the turn produces a result", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      service.sendMessage(id, "hello");
      expect(service.getSession(id)?.state).toBe("running");

      fake.emit(successResult());
      await flush();

      expect(service.getSession(id)?.state).toBe("idle");
    });

    it("emits entries to subscribers as they arrive", async () => {
      const entries: string[] = [];
      service.on("session-entry", (event) => entries.push(event.entry.kind));

      const { id } = service.createSession({ cwd: "/tmp/p" });
      service.sendMessage(id, "hello");
      fake.emit(assistantWithText("hi"));
      await flush();

      expect(entries).toEqual(["user", "assistant"]);
    });
  });

  describe("tool permissions", () => {
    it("parks the tool call and reports the request", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      const requests: AgentPermissionRequest[] = [];
      service.on("permission-requested", (r) => requests.push(r));

      let settled = false;
      const decision = canUseTool("Bash", { command: "rm -rf /" }, {} as never);
      void decision.then(() => {
        settled = true;
      });
      await flush();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ toolName: "Bash", sessionId: id });
      expect(service.getSession(id)?.state).toBe("awaiting_permission");
      // Still parked — nothing may run until the user answers.
      expect(settled).toBe(false);
    });

    it("allows the call when approved", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      let request!: AgentPermissionRequest;
      service.on("permission-requested", (r) => (request = r));

      const decision = canUseTool("Read", { file: "a.ts" }, {} as never);
      await flush();
      service.resolvePermission(id, request.id, { allow: true });

      expect(await decision).toEqual<PermissionResult>({ behavior: "allow" });
    });

    it("denies with the reason so the agent can adapt", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      let request!: AgentPermissionRequest;
      service.on("permission-requested", (r) => (request = r));

      const decision = canUseTool("Bash", {}, {} as never);
      await flush();
      service.resolvePermission(id, request.id, {
        allow: false,
        reason: "Use the test runner instead.",
      });

      expect(await decision).toEqual<PermissionResult>({
        behavior: "deny",
        message: "Use the test runner instead.",
      });
    });

    // A late answer from a slow UI (or a phone on a flaky link) must not throw.
    it("ignores decisions for requests that no longer exist", () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      expect(() =>
        service.resolvePermission(id, "stale-request", { allow: true }),
      ).not.toThrow();
    });

    // Without this the SDK child process waits on a promise that can never
    // settle, and the session leaks for the lifetime of the app.
    it("denies parked requests when the session is closed", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      const decision = canUseTool("Bash", {}, {} as never);
      await flush();

      service.closeSession(id);

      expect(await decision).toMatchObject({ behavior: "deny" });
    });

    it("denies parked requests when the session errors out", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      const decision = canUseTool("Bash", {}, {} as never);
      await flush();

      fake.fail(new Error("claude process exited"));
      await flush();

      expect(await decision).toMatchObject({ behavior: "deny" });
      expect(service.getSession(id)).toMatchObject({
        state: "error",
        error: "claude process exited",
      });
    });
  });

  describe("live controls", () => {
    it("interrupts and settles back to idle", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });
      service.sendMessage(id, "long task");

      await service.interrupt(id);

      expect(fake.interrupt).toHaveBeenCalled();
      expect(service.getSession(id)?.state).toBe("idle");
    });

    it("records the mode and model it applied", async () => {
      const { id } = service.createSession({ cwd: "/tmp/p" });

      await service.setPermissionMode(id, "plan");
      await service.setModel(id, "claude-opus-5");

      expect(fake.setPermissionMode).toHaveBeenCalledWith("plan");
      expect(fake.setModel).toHaveBeenCalledWith("claude-opus-5");
      expect(service.getSession(id)).toMatchObject({
        permissionMode: "plan",
        model: "claude-opus-5",
      });
    });

    it("publishes state changes to subscribers", async () => {
      const states: AgentSessionSummary[] = [];
      service.on("session-updated", (s) => states.push(s));

      const { id } = service.createSession({ cwd: "/tmp/p" });
      service.sendMessage(id, "hello");
      fake.emit(successResult());
      await flush();

      expect(states.map((s) => s.state)).toContain("running");
      expect(states.at(-1)?.state).toBe("idle");
    });
  });
});
