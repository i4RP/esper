import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AgentProviderInfo } from "@/services/agent/types";

export interface NewSessionInput {
  providerId: string;
  cwd: string;
}

/**
 * Starts a session. The working directory is the one input that matters — it
 * is the whole scope of what the agent can see and change — so it is required
 * rather than defaulted to something surprising.
 */
export function NewSessionForm({
  providers,
  pending,
  error,
  onCreate,
}: {
  providers: AgentProviderInfo[];
  pending: boolean;
  error: string | null;
  onCreate: (input: NewSessionInput) => void;
}) {
  const [providerId, setProviderId] = React.useState(providers[0]?.id ?? "");
  const [cwd, setCwd] = React.useState("");

  // Keep the choice valid as availability changes underneath (an agent can
  // finish installing while this page is open).
  React.useEffect(() => {
    if (!providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0]?.id ?? "");
    }
  }, [providers, providerId]);

  const canCreateSession =
    cwd.trim().length > 0 && providerId !== "" && !pending;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              size="sm"
              variant={provider.id === providerId ? "default" : "outline"}
              onClick={() => setProviderId(provider.id)}
            >
              {provider.label}
            </Button>
          ))}
        </div>

        <div className="flex gap-2">
          <Input
            value={cwd}
            placeholder="Working directory, e.g. /Users/you/project"
            onChange={(event) => setCwd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canCreateSession) {
                onCreate({ providerId, cwd: cwd.trim() });
              }
            }}
          />
          <Button
            disabled={!canCreateSession}
            onClick={() => onCreate({ providerId, cwd: cwd.trim() })}
          >
            {pending ? "Starting…" : "Start"}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
