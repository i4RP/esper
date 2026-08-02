import * as React from "react";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type {
  AgentSessionSummary,
  AgentTimelineEntry,
} from "@/services/agent/types";
import { AgentTimeline } from "./timeline";
import { NewSessionForm } from "./new-session-form";
import { PermissionPrompt, type PendingPermission } from "./permission-prompt";

/**
 * Drives coding-agent sessions: pick an agent, point it at a directory, talk to
 * it, approve its tool calls.
 *
 * Live data arrives over three subscriptions rather than polling, because a
 * turn can run for minutes and the interesting moments (a tool wants
 * permission) are pushed, not pulled.
 */
export default function AgentsSettingsPage() {
  const utils = api.useUtils();
  const providers = api.agent.listProviders.useQuery();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<AgentSessionSummary[]>([]);
  const [timeline, setTimeline] = React.useState<AgentTimelineEntry[]>([]);
  const [pending, setPending] = React.useState<PendingPermission[]>([]);
  const [draft, setDraft] = React.useState("");

  api.agent.sessionUpdates.useSubscription(undefined, {
    onData: (summary) => {
      setSessions((current) => {
        const next = current.filter((session) => session.id !== summary.id);
        return [summary, ...next].sort(
          (a, b) => b.lastActivityAt - a.lastActivityAt,
        );
      });
    },
  });

  api.agent.timelineUpdates.useSubscription(
    { sessionId: selectedId ?? "" },
    {
      enabled: selectedId !== null,
      onData: (entry) => setTimeline((current) => [...current, entry]),
    },
  );

  api.agent.permissionRequests.useSubscription(undefined, {
    onData: (event) => {
      setPending((current) =>
        event.type === "requested"
          ? [...current, event.request]
          : current.filter((request) => request.id !== event.requestId),
      );
    },
  });

  const createSession = api.agent.createSession.useMutation({
    onSuccess: (summary) => {
      setSelectedId(summary.id);
      setTimeline([]);
    },
  });
  const sendMessage = api.agent.sendMessage.useMutation();
  const interrupt = api.agent.interrupt.useMutation();
  const closeSession = api.agent.closeSession.useMutation({
    onSuccess: () => {
      setSelectedId(null);
      setTimeline([]);
      void utils.agent.listSessions.invalidate();
    },
  });
  const resolvePermission = api.agent.resolvePermission.useMutation();

  const selected =
    sessions.find((session) => session.id === selectedId) ?? null;
  const available = (providers.data ?? []).filter(
    (provider) => provider.available,
  );
  const missing = (providers.data ?? []).filter(
    (provider) => !provider.available,
  );

  // Only prompts for the session on screen — answering a question for a
  // session you can't see would be answering blind.
  const visiblePermissions = pending.filter(
    (request) => request.sessionId === selectedId,
  );

  const handleSend = () => {
    const text = draft.trim();
    if (!text || !selectedId) {
      return;
    }
    setDraft("");
    sendMessage.mutate({ sessionId: selectedId, text });
  };

  const openSession = async (session: AgentSessionSummary) => {
    setSelectedId(session.id);
    // Replaces the live-appended list with the authoritative one, so switching
    // back to a session shows everything it did while you were elsewhere.
    setTimeline(await utils.agent.getTimeline.fetch({ sessionId: session.id }));
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold">Agents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Run coding agents on your machine and talk to them from here.
        </p>
      </div>

      {providers.isLoading ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Looking for installed agents…
          </CardContent>
        </Card>
      ) : available.length === 0 ? (
        <Card>
          <CardContent className="space-y-2 p-8 text-center">
            <p className="text-sm font-medium">No coding agent found</p>
            <p className="text-xs text-muted-foreground">
              Install Claude Code, or any agent that speaks the Agent Client
              Protocol, and it will show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <NewSessionForm
            providers={available}
            pending={createSession.isPending}
            error={createSession.error?.message ?? null}
            onCreate={(input) => createSession.mutate(input)}
          />

          {sessions.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Sessions</h2>
              <Card className="p-0 overflow-clip">
                <CardContent className="p-0">
                  <div className="divide-y divide-border">
                    {sessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => void openSession(session)}
                        className={`flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 ${
                          session.id === selectedId ? "bg-muted/50" : ""
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {session.title ?? "New session"}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {session.providerId} · {session.cwd}
                          </div>
                        </div>
                        <Badge variant="secondary" className="ml-3 shrink-0">
                          {session.state}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </section>
          )}

          {selected && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  {selected.title ?? "Session"}
                </h2>
                <div className="flex gap-2">
                  {selected.state === "running" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        interrupt.mutate({ sessionId: selected.id })
                      }
                    >
                      Stop
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      closeSession.mutate({ sessionId: selected.id })
                    }
                  >
                    Close
                  </Button>
                </div>
              </div>

              {selected.error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {selected.error}
                </div>
              )}

              {visiblePermissions.map((request) => (
                <PermissionPrompt
                  key={request.id}
                  request={request}
                  onDecide={(allow) =>
                    resolvePermission.mutate({
                      sessionId: request.sessionId,
                      requestId: request.id,
                      allow,
                    })
                  }
                />
              ))}

              <AgentTimeline entries={timeline} />

              <div className="flex gap-2">
                <Input
                  value={draft}
                  placeholder="Ask the agent to do something…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                />
                <Button onClick={handleSend} disabled={!draft.trim()}>
                  Send
                </Button>
              </div>
            </section>
          )}

          {missing.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Not installed</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                {missing.length} more agents are supported. Install one and it
                appears above.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((provider) => (
                  <Badge
                    key={provider.id}
                    variant="outline"
                    className="text-[11px] font-normal text-muted-foreground"
                  >
                    {provider.label}
                  </Badge>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
