import { useEffect, useRef } from "react";
import { api } from "@/trpc/react";
import { useAudioDevices } from "@/hooks/useAudioDevices";

/**
 * Pushes the connected audio input devices to the main process (the main
 * process cannot enumerate microphones itself). The tray's microphone
 * submenu is built from this list. The widget is the reporter because it is
 * the renderer that is always running.
 */
export function useAudioDeviceReporter() {
  const { devices } = useAudioDevices(true);
  const report = api.settings.reportAudioInputDevices.useMutation();
  const lastJsonRef = useRef<string>("");

  useEffect(() => {
    if (devices.length === 0) return;
    const payload = devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
    }));
    const json = JSON.stringify(payload);
    if (json === lastJsonRef.current) return;
    lastJsonRef.current = json;
    report.mutate({ devices: payload });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices]);
}
