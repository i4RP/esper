import { useState } from "react";
import { CircleDot } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/trpc/react";
import { keycodeToDisplay } from "@/utils/keycode-map";
import type { RecordingState } from "@/types/recording";

/**
 * "Get started" card on the Home (history) page: one click behaves exactly
 * like pressing the configured dictation key — starts a hands-free session
 * when idle, stops (and transcribes) when recording. The keycap badge on the
 * right mirrors the currently configured dictation key.
 */
export function StartRecordingCard() {
  const { t } = useTranslation();
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");

  const shortcutsQuery = api.settings.getShortcuts.useQuery();
  const signalStart = api.recording.signalStart.useMutation();
  const signalStop = api.recording.signalStop.useMutation();

  api.recording.stateUpdates.useSubscription(undefined, {
    onData: (update) => {
      setRecordingState(update.state);
    },
    onError: (error) => {
      console.error("Error subscribing to recording state updates", error);
    },
  });

  const keys = shortcutsQuery.data?.pushToTalk ?? [];
  const isActive =
    recordingState === "recording" || recordingState === "starting";
  const isBusy = recordingState === "stopping";

  const handleClick = () => {
    if (isBusy) return;
    if (isActive) {
      signalStop.mutate();
    } else {
      signalStart.mutate();
    }
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-muted-foreground mb-2">
        {t("settings.history.getStarted.heading")}
      </h2>
      <button
        type="button"
        onClick={handleClick}
        disabled={isBusy}
        className="w-full flex items-center gap-4 rounded-xl bg-muted/50 hover:bg-muted transition-colors px-4 py-3 text-left disabled:opacity-60"
      >
        <CircleDot
          className={`w-5 h-5 shrink-0 ${
            isActive ? "text-red-500 animate-pulse" : "text-foreground"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-foreground">
            {isActive
              ? t("settings.history.getStarted.stopTitle")
              : t("settings.history.getStarted.startTitle")}
          </div>
          <div className="text-sm text-muted-foreground">
            {t("settings.history.getStarted.subtitle")}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {keys.map((keycode) => (
            <kbd
              key={keycode}
              className="rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground border border-border"
            >
              {keycodeToDisplay(keycode)}
            </kbd>
          ))}
        </div>
      </button>
    </div>
  );
}
