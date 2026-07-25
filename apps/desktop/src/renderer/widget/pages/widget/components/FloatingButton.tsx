import React, { useState, useRef, useEffect } from "react";
import { Settings, Triangle, Maximize2, Pencil } from "lucide-react";
import { Waveform } from "@/components/Waveform";
import type { RecordingStatus } from "@/hooks/useRecording";
import { api } from "@/trpc/react";
import { setPassThroughReason } from "../../../pass-through";
import { useTranslation } from "react-i18next";

const NUM_WAVEFORM_BARS = 6;
const DEBOUNCE_DELAY = 100; // milliseconds

// Indigo pencil marking a draft (instruct) session in the FAB (dictating + processing).
const DraftPen: React.FC = () => (
  <Pencil
    className="w-[13px] h-[13px] text-brand shrink-0 mr-2"
    strokeWidth={2}
  />
);

// Processing indicator (stopping / finalizing). Draft sessions add the pen glyph.
const ProcessingIndicator: React.FC<{ isDraft?: boolean }> = ({ isDraft }) => (
  <div className="flex gap-1.5 items-center justify-center flex-1 h-full">
    {isDraft && <DraftPen />}
    <div className="flex gap-[4px] items-center">
      <div className="w-[4px] h-[4px] bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
      <div className="w-[4px] h-[4px] bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
      <div className="w-[4px] h-[4px] bg-blue-500 rounded-full animate-bounce" />
    </div>
  </div>
);

// Six softly pulsing dots shown while the session is starting up.
const StartingDots: React.FC = () => (
  <div className="flex gap-[5px] items-center justify-center flex-1 h-full">
    {Array.from({ length: 6 }).map((_, index) => (
      <div
        key={index}
        className="w-[4px] h-[4px] bg-white/80 rounded-full animate-pulse"
        style={{ animationDelay: `${index * 120}ms` }}
      />
    ))}
  </div>
);

// Voice-reactive waveform bars.
const WaveformVisualization: React.FC<{
  isRecording: boolean;
  audioLevels: number[];
}> = ({ isRecording, audioLevels }) => (
  <>
    {Array.from({ length: NUM_WAVEFORM_BARS }).map((_, index) => (
      <Waveform
        key={index}
        isRecording={isRecording}
        level={audioLevels[index] ?? 0}
        baseHeight={70}
        silentHeight={20}
      />
    ))}
  </>
);

// Round icon button used in the expanded idle pill.
const PillIconButton: React.FC<{
  onClick: (e: React.MouseEvent) => void;
  label: string;
  children: React.ReactNode;
}> = ({ onClick, label, children }) => (
  <button
    onClick={onClick}
    aria-label={label}
    title={label}
    className="flex items-center justify-center w-[28px] h-[28px] rounded-full text-white/85 hover:text-white hover:bg-white/15 transition-colors"
  >
    {children}
  </button>
);

interface FloatingButtonProps {
  recordingStatus: RecordingStatus;
  audioLevels: number[];
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  dismissRecording: () => Promise<void>;
}

export const FloatingButton: React.FC<FloatingButtonProps> = ({
  recordingStatus,
  audioLevels,
  startRecording,
  stopRecording,
}) => {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const leaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const navigateMainWindow = api.widget.navigateMainWindow.useMutation();

  // Release the hover pass-through reason if the FAB unmounts mid-hover (e.g.
  // a draft review takes over the widget), so it can't pin the window
  // clickable after the FAB is gone.
  useEffect(() => {
    return () => {
      setPassThroughReason("hover", false);
    };
  }, []);

  // STARTING is a brief handshake before renderer capture begins.
  const isStarting = recordingStatus.state === "starting";
  const isRecording = recordingStatus.state === "recording";
  const isStopping = recordingStatus.state === "stopping";
  const isActiveSession = isStarting || isRecording || isStopping;
  const isDraft = recordingStatus.isDraft;

  const handleStartClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (recordingStatus.state === "idle") {
      await startRecording();
    }
  };

  const handleStopClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await stopRecording();
  };

  const handleOpenSettings = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigateMainWindow.mutate({ route: "/settings/preferences" });
  };

  const handleOpenApp = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigateMainWindow.mutate({ route: "/" });
  };

  // Debounced mouse leave handler
  const handleMouseLeave = () => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
    }
    leaveTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
      // Drop only the hover reason; the controller keeps the widget clickable
      // if a toast or draft review still needs it.
      setPassThroughReason("hover", false);
    }, DEBOUNCE_DELAY);
  };

  // Mouse enter handler - clears any pending leave timeout
  const handleMouseEnter = () => {
    if (leaveTimeoutRef.current) {
      clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
    setIsHovered(true);
    // Make the widget clickable while hovered.
    setPassThroughReason("hover", true);
  };

  // Pill geometry per state. Collapsed idle = a slim notch-handle capsule.
  const sizeClass = !isActiveSession
    ? isHovered
      ? "h-[36px] w-[128px]"
      : "h-[12px] w-[64px]"
    : isStopping
      ? "h-[26px] w-[96px]"
      : isStarting
        ? "h-[26px] w-[96px]"
        : isHovered
          ? "h-[36px] w-[176px]"
          : isDraft
            ? "h-[26px] w-[112px]"
            : "h-[26px] w-[96px]";

  const renderWidgetContent = () => {
    // Idle, collapsed: empty capsule (the pill itself is the visual).
    if (!isActiveSession && !isHovered) return null;

    // Idle, hovered: settings / start recording / open app.
    if (!isActiveSession) {
      return (
        <div className="flex items-center justify-between flex-1 h-full px-[5px]">
          <PillIconButton
            onClick={handleOpenSettings}
            label={t("widget.actions.openSettings")}
          >
            <Settings className="w-[15px] h-[15px]" strokeWidth={2.25} />
          </PillIconButton>
          <PillIconButton
            onClick={handleStartClick}
            label={t("widget.actions.startRecording")}
          >
            <Triangle className="w-[14px] h-[14px]" strokeWidth={2.5} />
          </PillIconButton>
          <PillIconButton
            onClick={handleOpenApp}
            label={t("widget.actions.openApp")}
          >
            <Maximize2 className="w-[14px] h-[14px]" strokeWidth={2.25} />
          </PillIconButton>
        </div>
      );
    }

    if (isStopping) {
      return <ProcessingIndicator isDraft={isDraft} />;
    }

    if (isStarting) {
      return <StartingDots />;
    }

    // Recording, hovered: red stop button + waveform.
    if (isHovered) {
      return (
        <>
          <div className="h-full items-center flex ml-[4px]">
            <button
              onClick={handleStopClick}
              aria-label={t("widget.actions.stopRecording")}
              title={t("widget.actions.stopRecording")}
              className="flex items-center justify-center w-[28px] h-[28px] rounded-full bg-red-900/70 hover:bg-red-800/80 transition-colors"
            >
              <Triangle
                className="w-[13px] h-[13px] text-red-400"
                strokeWidth={2.75}
              />
            </button>
          </div>
          <button
            className="justify-center items-center flex flex-1 gap-1 h-full min-w-0"
            onClick={handleStopClick}
          >
            {isDraft && <DraftPen />}
            <WaveformVisualization
              isRecording={isRecording}
              audioLevels={audioLevels}
            />
          </button>
        </>
      );
    }

    // Recording, not hovered: voice-reactive waveform.
    return (
      <div className="justify-center items-center flex flex-1 gap-1 h-full">
        {isDraft && <DraftPen />}
        <WaveformVisualization
          isRecording={isRecording}
          audioLevels={audioLevels}
        />
      </div>
    );
  };

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`
        transition-all duration-300 ease-out
        ${sizeClass}
        bg-black/80 rounded-full backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_2px_15px_0px_rgba(0,0,0,0.40)]
        before:content-[''] before:absolute before:inset-[1px] before:rounded-full before:outline before:outline-white/15 before:pointer-events-none
        mt-[2px] cursor-pointer select-none relative
      `}
      style={{ pointerEvents: "auto" }}
    >
      <div className="flex h-full w-full items-center justify-center overflow-hidden">
        {renderWidgetContent()}
      </div>
    </div>
  );
};
