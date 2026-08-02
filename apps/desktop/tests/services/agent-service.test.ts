import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../../src/services/agent/agent-service";
import { NO_CAPABILITIES } from "../../src/services/agent/provider";
import type {
  AgentProviderClient,
  CreateProviderSessionInput,
  ProviderAvailability,
  ProviderEvent,
  ProviderSession,
} from "../../src/services/agent/provider";
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

/** A provider under the test's control — no SDK, no child process. */
class FakeSession implements ProviderSession {
  readonly listeners = new Set<(event: ProviderEvent) => void>();
  readonly sent: string[] = [];
  readonly closed = vi.fn();
  readonly interrupted = vi.fn();
  readonly permissionAnswers: Array<{ requestId: string; allow: boolean }> = [];
  model: string | undefined;

  constructor(public nativeSessionId: string | null) {}

  send(text: string): void {
    this.sent.push(text);
  }

  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    this.interrupted();
    this.emit({ type: "state", state: "idle" });
  }

  async setModel(model: string | undefined): Promise<void> {
    this.model = model;
  }

  respondToPermission(requestId: string, decision: { allow: boolean }): void {
    this.permissionAnswers.push({ requestId, allow: decision.allow });
    this.emit({ type: "permission-resolved", requestId });
  }

  close(): void {
    this.closed();
  }

  emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeProvider implements AgentProviderClient {
  readonly capabilities = {
    ...NO_CAPABILITIES,
    interrupt: true,
    selectModel: true,
  };
  lastSession: FakeSession | null = null;
  availability: ProviderAvailability = {
    available: true,
    path: "/opt/test/agent",
    reason: null,
  };
  lastInput: CreateProviderSessionInput | null = null;

  constructor(
    readonly id: string,
    readonly label: string,
  ) {}

  checkAvailability(): ProviderAvailability {
    return this.availability;
  }

  async createSession(
    input: CreateProviderSessionInput,
  ): Promise<ProviderSession> {
    this.lastInput = input;
    this.lastSession = new FakeSession(`native-${this.id}`);
    return this.lastSession;
  }
}

const entry = (text: string) =>
  ({ kind: "assistant", id: "e1", at: 1, text }) as const;

describe("AgentService", () => {
  let service: AgentService;
  let provider: FakeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AgentService(silentLogger);
    provider = new FakeProvider("fake", "Fake Agent");
    service.register(provider);
  });

  describe("providers", () => {
    it("lists registered providers with availability and capabilities", () => {
      expect(service.listProviders()).toEqual([
        {
          id: "fake",
          label: "Fake Agent",
          available: true,
          reason: null,
          capabilities: provider.capabilities,
        },
      ]);
    });

    it("reports overall availability from its providers", () => {
      expect(service.isAvailable()).toBe(true);

      provider.availability = {
        available: false,
        path: null,
        reason: "not installed",
      };
      expect(service.isAvailable()).toBe(false);
    });

    // With one agent installed, making the caller name it is friction; the
    // convenience must not extend to the ambiguous case below.
    it("defaults to the only available provider", async () => {
      const summary = await service.createSession({ cwd: "/tmp/p" });
      expect(summary.providerId).toBe("fake");
    });

    it("requires an explicit choice when several are available", async () => {
      service.register(new FakeProvider("other", "Other Agent"));

      await expect(service.createSession({ cwd: "/tmp/p" })).rejects.toThrow(
        /specify which to use/,
      );
    });

    it("reports when nothing is installed", async () => {
      provider.availability = {
        available: false,
        path: null,
        reason: "not installed",
      };

      await expect(service.createSession({ cwd: "/tmp/p" })).rejects.toThrow(
        /No coding agent is installed/,
      );
    });

    it("refuses an unavailable provider named explicitly", async () => {
      provider.availability = {
        available: false,
        path: null,
        reason: "Fake Agent was not found.",
      };

      await expect(
        service.createSession({ providerId: "fake", cwd: "/tmp/p" }),
      ).rejects.toThrow(/Fake Agent was not found/);
    });

    it("rejects an unknown provider id", async () => {
      await expect(
        service.createSession({ providerId: "nope", cwd: "/tmp/p" }),
      ).rejects.toThrow(/Unknown agent provider/);
    });
  });

  describe("session lifecycle", () => {
    it("creates a session and lists it", async () => {
      const summary = await service.createSession({ cwd: "/tmp/project" });

      expect(summary).toMatchObject({
        cwd: "/tmp/project",
        state: "starting",
        title: null,
        providerId: "fake",
      });
      expect(service.listSessions()).toHaveLength(1);
    });

    // resume needs the provider's own id, not the one Esper hands out.
    it("records the provider's native session id", async () => {
      const summary = await service.createSession({ cwd: "/tmp/p" });
      expect(summary.nativeSessionId).toBe("native-fake");
    });

    it("picks up a native id reported later", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      provider.lastSession!.emit({ type: "session-id", sessionId: "acp-42" });

      expect(service.getSession(id)?.nativeSessionId).toBe("acp-42");
    });

    it("forwards resume and fork to the provider", async () => {
      await service.createSession({
        cwd: "/tmp/p",
        resume: "prev",
        fork: true,
      });

      expect(provider.lastInput).toMatchObject({ resume: "prev", fork: true });
    });

    it("titles the session from the first turn only", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await service.sendMessage(id, "add a health endpoint");
      expect(service.getSession(id)?.title).toBe("add a health endpoint");

      await service.sendMessage(id, "now add tests");
      expect(service.getSession(id)?.title).toBe("add a health endpoint");
    });

    it("throws on operations against an unknown session", async () => {
      await expect(service.sendMessage("nope", "hi")).rejects.toThrow(
        /Unknown agent session/,
      );
    });

    it("closes the provider session and drops it", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });
      const session = provider.lastSession!;

      service.closeSession(id);

      expect(session.closed).toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(0);
    });

    it("closes every session on shutdown", async () => {
      await service.createSession({ cwd: "/tmp/a" });
      await service.createSession({ providerId: "fake", cwd: "/tmp/b" });

      service.shutdown();

      expect(service.listSessions()).toHaveLength(0);
    });

    // A closed session must stop mutating state, or a provider that emits on
    // its way down would resurrect entries for a session the user dismissed.
    it("stops listening to a closed session", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });
      const session = provider.lastSession!;

      service.closeSession(id);
      session.emit({ type: "entry", entry: entry("late") });

      expect(service.getTimeline(id)).toEqual([]);
    });
  });

  describe("timeline", () => {
    it("records the user turn and provider entries", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await service.sendMessage(id, "hello");
      provider.lastSession!.emit({ type: "entry", entry: entry("hi there") });

      expect(service.getTimeline(id).map((e) => e.kind)).toEqual([
        "user",
        "assistant",
      ]);
    });

    it("forwards the message text to the provider", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await service.sendMessage(id, "hello");

      expect(provider.lastSession!.sent).toEqual(["hello"]);
    });

    it("emits entries to subscribers as they arrive", async () => {
      const kinds: string[] = [];
      service.on("session-entry", (event) => kinds.push(event.entry.kind));

      const { id } = await service.createSession({ cwd: "/tmp/p" });
      await service.sendMessage(id, "hello");
      provider.lastSession!.emit({ type: "entry", entry: entry("hi") });

      expect(kinds).toEqual(["user", "assistant"]);
    });

    it("tracks state reported by the provider", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await service.sendMessage(id, "hello");
      expect(service.getSession(id)?.state).toBe("running");

      provider.lastSession!.emit({ type: "state", state: "idle" });
      expect(service.getSession(id)?.state).toBe("idle");
    });

    it("records provider errors", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      provider.lastSession!.emit({ type: "error", message: "process died" });

      expect(service.getSession(id)).toMatchObject({
        state: "error",
        error: "process died",
      });
    });
  });

  describe("tool permissions", () => {
    const request = (session: FakeSession, requestId = "req-1") =>
      session.emit({
        type: "permission",
        requestId,
        toolName: "Bash",
        input: { command: "ls" },
      });

    it("surfaces the request and parks the session", async () => {
      const requests: AgentPermissionRequest[] = [];
      service.on("permission-requested", (r) => requests.push(r));

      const { id } = await service.createSession({ cwd: "/tmp/p" });
      request(provider.lastSession!);

      expect(requests[0]).toMatchObject({ toolName: "Bash", sessionId: id });
      expect(service.getSession(id)?.state).toBe("awaiting_permission");
    });

    it("routes the decision to the provider session", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });
      const session = provider.lastSession!;
      request(session);

      await service.resolvePermission(id, "req-1", { allow: true });

      expect(session.permissionAnswers).toEqual([
        { requestId: "req-1", allow: true },
      ]);
      expect(service.getSession(id)?.state).toBe("running");
    });

    // A late answer from a slow UI (or a phone on a flaky link) must not throw.
    it("ignores decisions for requests that no longer exist", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await expect(
        service.resolvePermission(id, "stale", { allow: true }),
      ).resolves.toBeUndefined();
      expect(provider.lastSession!.permissionAnswers).toEqual([]);
    });

    // Otherwise a provider reporting progress mid-question would clear the
    // prompt the user is still looking at.
    it("stays parked while a question is outstanding", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });
      const session = provider.lastSession!;
      request(session);

      session.emit({ type: "state", state: "running" });

      expect(service.getSession(id)?.state).toBe("awaiting_permission");
    });

    it("stays parked until the last of several questions is answered", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });
      const session = provider.lastSession!;
      request(session, "req-1");
      request(session, "req-2");

      await service.resolvePermission(id, "req-1", { allow: true });
      expect(service.getSession(id)?.state).toBe("awaiting_permission");

      await service.resolvePermission(id, "req-2", { allow: false });
      expect(service.getSession(id)?.state).toBe("running");
    });
  });

  describe("live controls", () => {
    it("interrupts through the provider", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await service.interrupt(id);

      expect(provider.lastSession!.interrupted).toHaveBeenCalled();
      expect(service.getSession(id)?.state).toBe("idle");
    });

    it("records the model it applied", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await service.setModel(id, "claude-opus-5");

      expect(provider.lastSession!.model).toBe("claude-opus-5");
      expect(service.getSession(id)?.model).toBe("claude-opus-5");
    });

    // Capabilities differ per provider; asking for one a provider lacks must
    // fail with a clear message rather than a TypeError on an absent method.
    it("reports clearly when a provider lacks a control", async () => {
      const { id } = await service.createSession({ cwd: "/tmp/p" });

      await expect(service.setPermissionMode(id, "plan")).rejects.toThrow(
        /Fake Agent has no permission modes/,
      );
    });

    it("publishes state changes to subscribers", async () => {
      const states: AgentSessionSummary[] = [];
      service.on("session-updated", (s) => states.push(s));

      const { id } = await service.createSession({ cwd: "/tmp/p" });
      await service.sendMessage(id, "hello");
      provider.lastSession!.emit({ type: "state", state: "idle" });

      expect(states.map((s) => s.state)).toContain("running");
      expect(states.at(-1)?.state).toBe("idle");
    });
  });
});
