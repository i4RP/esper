import { describe, expect, it } from "vitest";
import { InputQueue } from "../../src/services/agent/input-queue";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const message = (text: string): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  }) as SDKUserMessage;

const textOf = (msg: SDKUserMessage): unknown => msg.message.content;

describe("InputQueue", () => {
  it("delivers messages pushed before anything is reading", async () => {
    const queue = new InputQueue();
    queue.push(message("first"));
    queue.push(message("second"));
    queue.close();

    const received: unknown[] = [];
    for await (const msg of queue.stream()) {
      received.push(textOf(msg));
    }

    expect(received).toEqual(["first", "second"]);
  });

  // The live case: the SDK is already pulling and blocked when a turn arrives.
  it("delivers a message pushed while a consumer is waiting", async () => {
    const queue = new InputQueue();
    const iterator = queue.stream();

    const pending = iterator.next();
    queue.push(message("late"));

    const result = await pending;
    expect(result.done).toBe(false);
    expect(textOf(result.value as SDKUserMessage)).toBe("late");
  });

  it("ends the stream when closed while a consumer waits", async () => {
    const queue = new InputQueue();
    const iterator = queue.stream();

    const pending = iterator.next();
    queue.close();

    expect((await pending).done).toBe(true);
  });

  // Buffered input must still drain after close, or a message accepted from the
  // user moments before shutdown is silently swallowed.
  it("drains buffered messages before ending on close", async () => {
    const queue = new InputQueue();
    queue.push(message("buffered"));
    queue.close();

    const received: unknown[] = [];
    for await (const msg of queue.stream()) {
      received.push(textOf(msg));
    }

    expect(received).toEqual(["buffered"]);
  });

  it("ignores pushes after close", async () => {
    const queue = new InputQueue();
    queue.close();
    queue.push(message("ignored"));

    const received: unknown[] = [];
    for await (const msg of queue.stream()) {
      received.push(textOf(msg));
    }

    expect(received).toEqual([]);
  });

  it("is idempotent on repeated close", () => {
    const queue = new InputQueue();
    expect(() => {
      queue.close();
      queue.close();
    }).not.toThrow();
  });
});
