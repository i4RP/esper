import { app, Tray, Menu, nativeImage } from "electron";
import * as path from "path";
import { logger } from "../logger";
import type { WindowManager } from "../core/window-manager";
import type { ServiceManager } from "./service-manager";
import { isMacOS, isWindows } from "../../utils/platform";
import { initMainI18n } from "../../i18n/main";

export class TrayManager {
  private static instance: TrayManager | null = null;
  private tray: Tray | null = null;
  private windowManager: WindowManager | null = null;
  private serviceManager: ServiceManager | null = null;
  private t: ((key: string, options?: Record<string, unknown>) => string) | null =
    null;

  private constructor() {}

  static getInstance(): TrayManager {
    if (!TrayManager.instance) {
      TrayManager.instance = new TrayManager();
    }
    return TrayManager.instance;
  }

  async initialize(
    windowManager: WindowManager,
    locale?: string | null,
    serviceManager?: ServiceManager,
  ): Promise<void> {
    this.windowManager = windowManager;
    this.serviceManager = serviceManager ?? null;
    const i18n = await initMainI18n(locale);
    this.t = i18n.t.bind(i18n);

    // Create tray icon: a small LED-style status dot (gray = idle, green =
    // Caps Lock sleep guard active, red = sleep guard error). Colored
    // deliberately, so no template image.
    const iconPath = this.getIconPath("off");
    logger.main.info(`Loading tray icon from: ${iconPath}`);

    const icon = nativeImage.createFromPath(iconPath);
    this.tray = new Tray(icon);
    this.tray.setToolTip(this.t("tray.tooltip"));

    await this.rebuildMenu();

    // Keep the dynamic labels fresh: the toggle item follows the recording
    // state, the microphone item follows the configured priority chain.
    if (this.serviceManager) {
      try {
        const recordingManager =
          this.serviceManager.getService("recordingManager");
        recordingManager?.on("state-changed", () => {
          void this.rebuildMenu();
        });
        const settingsService =
          this.serviceManager.getService("settingsService");
        settingsService?.on("recording-settings-changed", () => {
          void this.rebuildMenu();
        });
        settingsService?.on("audio-devices-changed", () => {
          void this.rebuildMenu();
        });
      } catch (error) {
        logger.main.warn("Tray dynamic menu wiring skipped", { error });
      }
    }

    logger.main.info("Tray initialized successfully");
  }

  private async rebuildMenu(): Promise<void> {
    if (!this.tray || this.tray.isDestroyed() || !this.t) return;
    const t = this.t;

    const recordingManager = (() => {
      try {
        return this.serviceManager?.getService("recordingManager") ?? null;
      } catch {
        return null;
      }
    })();
    const recordingState = recordingManager?.getState() ?? "idle";
    const isRecordingActive =
      recordingState === "recording" || recordingState === "starting";

    const micMenu = await this.buildMicrophoneMenu();

    const openMainAt = async (route: string) => {
      if (!this.windowManager) return;
      const onboardingWindow = this.windowManager.getOnboardingWindow();
      if (onboardingWindow && !onboardingWindow.isDestroyed()) {
        onboardingWindow.show();
        onboardingWindow.focus();
        return;
      }
      await this.windowManager.navigateMainWindow(route);
    };

    const contextMenu = Menu.buildFromTemplate([
      {
        label: isRecordingActive
          ? t("tray.stopRecording")
          : t("tray.startRecording"),
        click: async () => {
          if (!recordingManager) return;
          const state = recordingManager.getState();
          if (state === "idle") {
            await recordingManager.signalStart();
          } else if (state === "recording" || state === "starting") {
            await recordingManager.signalStop();
          }
        },
      },
      { type: "separator" as const },
      {
        label: t("tray.history"),
        click: () => void openMainAt("/history"),
      },
      {
        label: t("tray.settings"),
        click: () => void openMainAt("/settings/preferences"),
      },
      { type: "separator" as const },
      micMenu,
      { type: "separator" as const },
      {
        label: t("tray.openConsole"),
        click: () => void openMainAt("/history"),
      },
      { type: "separator" as const },
      ...(isMacOS()
        ? [{ role: "about" as const }]
        : [
            {
              label: t("tray.about"),
              click: () => {
                app.showAboutPanel();
              },
            },
          ]),
      {
        label: t("menu.version", { version: app.getVersion() }),
        enabled: false,
      },
      { type: "separator" as const },
      {
        label: t("tray.quit"),
        click: () => {
          logger.main.info("Quit requested from tray");
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Microphone picker submenu: the connected input devices (reported by the
   * widget renderer), with the active one checked. Picking a device makes it
   * the top of the microphone priority chain; picking the system default
   * clears the chain. Falls back to a plain "open settings" item until the
   * device list has been reported.
   */
  private async buildMicrophoneMenu(): Promise<
    Electron.MenuItemConstructorOptions
  > {
    const t = this.t!;
    const fallbackLabel = t("tray.systemDefaultMic");
    try {
      const settingsService = this.serviceManager?.getService("settingsService");
      if (!settingsService) throw new Error("no settings service");
      const devices = settingsService.getAudioInputDevices();
      const recording = await settingsService.getRecordingSettings();
      const priority = recording?.microphonePriority ?? [];

      if (devices.length === 0) {
        const name = priority[0]?.name?.trim() || fallbackLabel;
        return {
          label: t("tray.microphone", { name }),
          click: () => {
            void this.windowManager?.navigateMainWindow("/settings/dictation");
          },
        };
      }

      // Active device: highest-ranked connected priority entry, else default.
      const activeId =
        priority.find((entry) =>
          devices.some((device) => device.deviceId === entry.deviceId),
        )?.deviceId ?? "default";
      const activeLabel =
        devices.find((device) => device.deviceId === activeId)?.label ??
        fallbackLabel;

      const selectDevice = async (deviceId: string, label: string) => {
        const current = await settingsService.getRecordingSettings();
        const base = {
          defaultFormat: "wav" as const,
          sampleRate: 16000 as const,
          autoStopSilence: true,
          silenceThreshold: 3,
          maxRecordingDuration: 60,
          ...current,
        };
        await settingsService.setRecordingSettings({
          ...base,
          microphonePriority:
            deviceId === "default" ? [] : [{ deviceId, name: label }],
        });
      };

      return {
        label: activeLabel,
        submenu: devices.map((device) => ({
          label: device.label,
          type: "radio" as const,
          checked: device.deviceId === activeId,
          click: () => void selectDevice(device.deviceId, device.label),
        })),
      };
    } catch {
      return {
        label: t("tray.microphone", { name: fallbackLabel }),
        click: () => {
          void this.windowManager?.navigateMainWindow("/settings/dictation");
        },
      };
    }
  }

  /**
   * Swap the tray dot to reflect the Caps Lock sleep-guard state.
   */
  setSleepGuardState(state: "off" | "on" | "error"): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const icon = nativeImage.createFromPath(this.getIconPath(state));
    this.tray.setImage(icon);
  }

  private getIconPath(state: "off" | "on" | "error"): string {
    const iconName = isWindows()
      ? "icon-256x256.png" // Windows uses standard icon
      : `tray-dot-${state}.png`;

    if (app.isPackaged) {
      // When packaged, assets are placed next to the bundled resources path
      return path.join(process.resourcesPath, "assets", iconName);
    }

    // In development, rely on the project root returned by Electron
    // This avoids brittle relative traversals from the transpiled directory structure
    return path.join(app.getAppPath(), "assets", iconName);
  }

  cleanup(): void {
    //! DO NOT MANUALLY DESTROY, THIS RESETS THE TRAY POSITION
    //! EVEN IF IT SHOULDN'T
    /* if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
      this.tray = null;
      logger.main.info("Tray cleaned up");
    } */
  }
}
