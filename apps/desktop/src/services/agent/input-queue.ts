import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Push-driven async iterable feeding the Agent SDK's streaming input.
 *
 * `query({ prompt })` pulls from an AsyncIterable, but our messages arrive from
 * the outside (a UI turn, a dictation result, a phone) with no iterator asking
 * for them yet. This bridges the two: `push` hands a message to a waiting
 * consumer, or buffers it until one arrives.
 *
 * Streaming input is not just a convenience — `interrupt()`, `setModel()` and
 * `setPermissionMode()` only work in streaming-input mode, so every session
 * uses this even for a single-shot prompt.
 */
export class InputQueue {
  private readonly buffered: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) {
      return;
    }

    // A waiting consumer takes the message directly; the buffer is only for
    // messages that arrive between pulls.
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: message, done: false });
      return;
    }

    this.buffered.push(message);
  }

  /**
   * Ends the stream. The SDK treats iterator completion as "no more input",
   * which lets the underlying process exit cleanly.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const buffered = this.buffered.shift();
      if (buffered) {
        yield buffered;
        continue;
      }

      if (this.closed) {
        return;
      }

      const next = await new Promise<IteratorResult<SDKUserMessage>>(
        (resolve) => {
          this.waiting = resolve;
        },
      );

      if (next.done) {
        return;
      }

      yield next.value;
    }
  }
}
