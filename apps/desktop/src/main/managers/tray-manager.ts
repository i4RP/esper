import { app, Tray, Menu, nativeImage } from "electron";
import * as path from "path";
import { logger } from "../logger";
import type { WindowManager } from "../core/window-manager";
import { isMacOS, isWindows } from "../../utils/platform";
import { initMainI18n } from "../../i18n/main";

export class TrayManager {
  private static instance: TrayManager | null = null;
  private tray: Tray | null = null;
  private windowManager: WindowManager | null = null;

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
  ): Promise<void> {
    this.windowManager = windowManager;
    const i18n = await initMainI18n(locale);
    const t = i18n.t.bind(i18n);

    // Create tray icon: a small status dot (gray = idle, green = Caps Lock
    // sleep guard active, red = sleep guard error). Colored deliberately, so
    // no template image.
    const iconPath = this.getIconPath("off");
    logger.main.info(`Loading tray icon from: ${iconPath}`);

    const icon = nativeImage.createFromPath(iconPath);
    this.tray = new Tray(icon);

    // Set tooltip
    this.tray.setToolTip(t("tray.tooltip"));

    // Create context menu
    const contextMenu = Menu.buildFromTemplate([
      {
        label: t("tray.openConsole"),
        click: async () => {
          logger.main.info("Open console requested from tray");
          if (this.windowManager) {
            // During onboarding, focus the wizard instead of opening the main
            // window beside it (same guard as activate / second-instance).
            const onboardingWindow = this.windowManager.getOnboardingWindow();
            if (onboardingWindow && !onboardingWindow.isDestroyed()) {
              onboardingWindow.show();
              onboardingWindow.focus();
              return;
            }
            await this.windowManager.createOrShowMainWindow();
          }
        },
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

    // Set the context menu
    this.tray.setContextMenu(contextMenu);

    logger.main.info("Tray initialized successfully");
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
