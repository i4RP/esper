import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTimelineEntry } from "../types";

/**
 * Content blocks are read structurally rather than through the SDK's imported
 * Anthropic types. The block shapes are stable wire JSON; the type packages
 * they live in are transitive dependencies of the SDK, and importing them here
 * would make this file break on an SDK dependency bump for no benefit.
 */
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Blocks may be a bare string (the shorthand form) or an array of blocks. */
const readBlocks = (content: unknown): UnknownRecord[] => {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

/**
 * Flattens a tool_result's content, which is either a string or a block list.
 * Non-text blocks (images) are named rather than dropped silently, so a result
 * that produced only an image doesn't render as an empty bubble.
 */
const flattenToolResultContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  return readBlocks(content)
    .map((block) => {
      const text = readString(block.text);
      if (text !== null) {
        return text;
      }
      const type = readString(block.type) ?? "unknown";
      return `[${type}]`;
    })
    .join("\n");
};

const entryId = (): string => randomUUID();

/**
 * Converts one SDK message into zero or more timeline entries.
 *
 * Zero is the common case: most of the SDK's ~35 message variants are progress
 * and lifecycle signals (hooks, retries, token counters) that the session state
 * machine handles separately. Only content belongs on the timeline.
 */
export function normalizeMessage(
  message: SDKMessage,
  at: number,
): AgentTimelineEntry[] {
  switch (message.type) {
    case "assistant": {
      const entries: AgentTimelineEntry[] = [];
      const content = isRecord(message.message)
        ? message.message.content
        : undefined;

      for (const block of readBlocks(content)) {
        const type = readString(block.type);

        if (type === "text") {
          const text = readString(block.text);
          if (text && text.trim().length > 0) {
            entries.push({ kind: "assistant", id: entryId(), at, text });
          }
          continue;
        }

        if (type === "thinking") {
          const text = readString(block.thinking);
          // Thinking is empty-by-default on current models (display: omitted);
          // an empty block is a progress signal, not content.
          if (text && text.trim().length > 0) {
            entries.push({ kind: "thinking", id: entryId(), at, text });
          }
          continue;
        }

        if (type === "tool_use") {
          entries.push({
            kind: "tool_use",
            id: entryId(),
            at,
            toolUseId: readString(block.id) ?? entryId(),
            name: readString(block.name) ?? "unknown",
            input: block.input,
          });
        }
      }

      return entries;
    }

    case "user": {
      const entries: AgentTimelineEntry[] = [];
      const content = isRecord(message.message)
        ? message.message.content
        : undefined;

      for (const block of readBlocks(content)) {
        const type = readString(block.type);

        if (type === "tool_result") {
          entries.push({
            kind: "tool_result",
            id: entryId(),
            at,
            toolUseId: readString(block.tool_use_id) ?? "",
            text: flattenToolResultContent(block.content),
            isError: block.is_error === true,
          });
          continue;
        }

        if (type === "text") {
          const text = readString(block.text);
          // Synthetic user turns carry tool plumbing the user never typed;
          // only echo real input back onto the timeline.
          if (text && text.trim().length > 0 && !message.isSynthetic) {
            entries.push({ kind: "user", id: entryId(), at, text });
          }
        }
      }

      return entries;
    }

    case "result": {
      const isError = message.subtype !== "success" || message.is_error;
      return [
        {
          kind: "result",
          id: entryId(),
          at,
          success: !isError,
          durationMs: message.duration_ms ?? null,
          costUsd: message.total_cost_usd ?? null,
          text: message.subtype === "success" ? message.result : null,
        },
      ];
    }

    default:
      return [];
  }
}
