import { Button } from "@/components/ui/button";
import type { AgentPermissionRequest } from "@/services/agent/types";

export type PendingPermission = AgentPermissionRequest;

const describeInput = (input: unknown): string => {
  if (input === null || input === undefined) {
    return "";
  }
  const text =
    typeof input === "string" ? input : JSON.stringify(input, null, 2);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

/**
 * Asks the user to approve a tool call.
 *
 * The agent is blocked on this answer — its process is holding an unresolved
 * promise — so the prompt is deliberately prominent and always shows exactly
 * what was requested rather than just the tool's name.
 */
export function PermissionPrompt({
  request,
  onDecide,
}: {
  request: PendingPermission;
  onDecide: (allow: boolean) => void;
}) {
  const details = describeInput(request.input);

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="text-sm font-medium">
        Allow <span className="font-semibold">{request.toolName}</span>?
      </div>
      {details && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-xs">
          {details}
        </pre>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => onDecide(true)}>
          Allow
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide(false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}
