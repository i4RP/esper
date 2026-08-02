import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../../src/services/agent/providers/claude-code-normalize";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const AT = 1_800_000_000_000;

const assistant = (content: unknown[]): SDKMessage =>
  ({
    type: "assistant",
    message: { role: "assistant", content },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage;

const user = (content: unknown, extra: object = {}): SDKMessage =>
  ({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...extra,
  }) as unknown as SDKMessage;

describe("normalizeMessage — assistant content", () => {
  it("extracts text blocks", () => {
    const entries = normalizeMessage(
      assistant([{ type: "text", text: "Hello" }]),
      AT,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "assistant",
      text: "Hello",
      at: AT,
    });
  });

  it("extracts tool calls with their id, name and input", () => {
    const entries = normalizeMessage(
      assistant([
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls" },
        },
      ]),
      AT,
    );

    expect(entries[0]).toMatchObject({
      kind: "tool_use",
      toolUseId: "toolu_1",
      name: "Bash",
      input: { command: "ls" },
    });
  });

  it("keeps multiple blocks in order", () => {
    const entries = normalizeMessage(
      assistant([
        { type: "text", text: "Checking" },
        { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
      ]),
      AT,
    );

    expect(entries.map((e) => e.kind)).toEqual(["assistant", "tool_use"]);
  });

  // Thinking is empty-by-default on current models (display: "omitted"), so an
  // empty block is a progress signal — rendering it would produce blank bubbles.
  it("drops thinking blocks with no content but keeps ones with text", () => {
    expect(
      normalizeMessage(assistant([{ type: "thinking", thinking: "" }]), AT),
    ).toEqual([]);

    const entries = normalizeMessage(
      assistant([{ type: "thinking", thinking: "considering options" }]),
      AT,
    );
    expect(entries[0]).toMatchObject({
      kind: "thinking",
      text: "considering options",
    });
  });

  it("drops whitespace-only text", () => {
    expect(
      normalizeMessage(assistant([{ type: "text", text: "   \n " }]), AT),
    ).toEqual([]);
  });

  it("ignores block types it doesn't model", () => {
    expect(
      normalizeMessage(
        assistant([{ type: "redacted_thinking", data: "x" }]),
        AT,
      ),
    ).toEqual([]);
  });
});

describe("normalizeMessage — user content", () => {
  it("extracts tool results, flagging errors", () => {
    const entries = normalizeMessage(
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "command not found",
          is_error: true,
        },
      ]),
      AT,
    );

    expect(entries[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "toolu_1",
      text: "command not found",
      isError: true,
    });
  });

  it("flattens block-list tool result content", () => {
    const entries = normalizeMessage(
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      ]),
      AT,
    );

    expect(entries[0]).toMatchObject({
      text: "line one\nline two",
      isError: false,
    });
  });

  // A result that produced only an image would otherwise render as an empty
  // bubble, which reads as "the tool did nothing".
  it("names non-text blocks instead of dropping them", () => {
    const entries = normalizeMessage(
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "image", source: {} }],
        },
      ]),
      AT,
    );

    expect(entries[0]).toMatchObject({ text: "[image]" });
  });

  it("echoes typed user text", () => {
    const entries = normalizeMessage(user("what changed?"), AT);
    expect(entries[0]).toMatchObject({ kind: "user", text: "what changed?" });
  });

  // Synthetic turns are tool plumbing the SDK generates — echoing them would
  // show the user words they never wrote.
  it("does not echo synthetic user turns", () => {
    expect(
      normalizeMessage(user("auto-generated", { isSynthetic: true }), AT),
    ).toEqual([]);
  });
});

describe("normalizeMessage — result", () => {
  it("maps a successful result", () => {
    const entries = normalizeMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        total_cost_usd: 0.42,
        result: "done",
      } as unknown as SDKMessage,
      AT,
    );

    expect(entries[0]).toMatchObject({
      kind: "result",
      success: true,
      durationMs: 1234,
      costUsd: 0.42,
      text: "done",
    });
  });

  // is_error can be true on a success subtype; both must read as failure.
  it("treats is_error and non-success subtypes as failures", () => {
    const flagged = normalizeMessage(
      {
        type: "result",
        subtype: "success",
        is_error: true,
        duration_ms: 1,
        total_cost_usd: 0,
        result: "",
      } as unknown as SDKMessage,
      AT,
    );
    expect(flagged[0]).toMatchObject({ kind: "result", success: false });

    const errored = normalizeMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 5,
        total_cost_usd: 0,
      } as unknown as SDKMessage,
      AT,
    );
    expect(errored[0]).toMatchObject({
      kind: "result",
      success: false,
      text: null,
    });
  });
});

describe("normalizeMessage — unmodelled variants", () => {
  // Most of the SDK's ~35 variants are lifecycle/progress signals. They must
  // produce nothing rather than throwing, so an SDK upgrade that adds a variant
  // can't crash a running session.
  it("returns nothing for lifecycle and progress messages", () => {
    for (const type of [
      "system",
      "rate_limit_event",
      "stream_event",
      "status",
      "hook_started",
      "some_variant_added_in_a_future_sdk",
    ]) {
      expect(normalizeMessage({ type } as unknown as SDKMessage, AT)).toEqual(
        [],
      );
    }
  });
});
