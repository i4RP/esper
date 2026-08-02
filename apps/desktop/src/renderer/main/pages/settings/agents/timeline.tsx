import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { AgentTimelineEntry } from "@/services/agent/types";

/** Tool inputs are arbitrary JSON; show a compact one-liner, not a wall. */
const summarizeInput = (input: unknown): string => {
  if (input === null || input === undefined) {
    return "";
  }
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

const Row = ({
  label,
  tone = "default",
  children,
}: {
  label: string;
  tone?: "default" | "muted" | "error";
  children: React.ReactNode;
}) => (
  <div className="px-4 py-2.5">
    <div
      className={`mb-0.5 text-[11px] font-medium uppercase tracking-wide ${
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {label}
    </div>
    <div
      className={`whitespace-pre-wrap break-words text-sm ${
        tone === "muted" ? "text-muted-foreground" : ""
      } ${tone === "error" ? "text-destructive" : ""}`}
    >
      {children}
    </div>
  </div>
);

/** Renders one session's transcript. */
export function AgentTimeline({ entries }: { entries: AgentTimelineEntry[] }) {
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Follow the tail as output streams in; a long turn is otherwise unreadable
  // without constant scrolling.
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-xs text-muted-foreground">
          Nothing yet. Send a message to start.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="p-0 overflow-clip">
      <CardContent className="max-h-[420px] overflow-y-auto p-0">
        <div className="divide-y divide-border">
          {entries.map((entry) => {
            switch (entry.kind) {
              case "user":
                return (
                  <Row key={entry.id} label="You">
                    {entry.text}
                  </Row>
                );
              case "assistant":
                return (
                  <Row key={entry.id} label="Agent">
                    {entry.text}
                  </Row>
                );
              case "thinking":
                return (
                  <Row key={entry.id} label="Thinking" tone="muted">
                    {entry.text}
                  </Row>
                );
              case "tool_use":
                return (
                  <Row
                    key={entry.id}
                    label={`Tool · ${entry.name}`}
                    tone="muted"
                  >
                    {summarizeInput(entry.input)}
                  </Row>
                );
              case "tool_result":
                return (
                  <Row
                    key={entry.id}
                    label="Result"
                    tone={entry.isError ? "error" : "muted"}
                  >
                    {entry.text || "(no output)"}
                  </Row>
                );
              case "result":
                return (
                  <Row
                    key={entry.id}
                    label={entry.success ? "Done" : "Ended"}
                    tone={entry.success ? "muted" : "error"}
                  >
                    {[
                      entry.text,
                      entry.durationMs !== null
                        ? `${(entry.durationMs / 1000).toFixed(1)}s`
                        : null,
                      entry.costUsd !== null
                        ? `$${entry.costUsd.toFixed(4)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Turn finished"}
                  </Row>
                );
              case "error":
                return (
                  <Row key={entry.id} label="Error" tone="error">
                    {entry.message}
                  </Row>
                );
            }
          })}
        </div>
        <div ref={bottomRef} />
      </CardContent>
    </Card>
  );
}
