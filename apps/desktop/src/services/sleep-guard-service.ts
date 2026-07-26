import { EventEmitter } from "events";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { screen } from "electron";
import type { HelperEvent } from "@amical/types";
import type { NativeBridge } from "./platform/native-bridge-service";
import { logger } from "../main/logger";

export const SLEEP_GUARD_HELPER_PATH =
  "/Library/PrivilegedHelperTools/esper-pmset";
const SUDOERS_PATH = "/etc/sudoers.d/esper-sleep-guard";

export interface SleepGuardStatus {
  installed: boolean;
  capsLockOn: boolean;
  // sleep is actually disabled right now (verified via pmset)
  engaged: boolean;
  error: boolean;
}

/**
 * Caps Lock–driven keep-awake (Capsomnia-style). While Caps Lock is on,
 * system sleep is disabled via `pmset -a disablesleep 1`, so the Mac keeps
 * running even with the lid closed. pmset needs root, so a tiny fixed-purpose
 * helper is installed once (with an admin prompt) at
 * /Library/PrivilegedHelperTools/esper-pmset plus a sudoers rule that allows
 * ONLY that helper's three modes without a password.
 *
 * The Swift helper polls the Caps Lock/clamshell state and pushes
 * capsLockStateChanged events; this service applies + verifies the pmset
 * state, requests display sleep when the lid closes with no external display
 * (so the panel isn't kept lit), and always restores normal sleep on quit.
 */
export class SleepGuardService extends EventEmitter {
  private capsLockOn = false;
  private clamshellClosed: boolean | null = null;
  private lastApplied: boolean | null = null;
  private errorState = false;
  private displaySleepRequested = false;
  private installedCache: boolean | null = null;
  private applying = false;

  constructor(private nativeBridge: NativeBridge) {
    super();
  }

  initialize(): void {
    if (process.platform !== "darwin") return;
    this.nativeBridge.on("helperEvent", (event: HelperEvent) => {
      if (event.type === "capsLockStateChanged") {
        void this.handleState(
          event.payload.capsLockOn,
          event.payload.clamshellClosed ?? null,
        );
      }
    });
    logger.main.info("SleepGuardService initialized", {
      installed: this.isInstalled(),
    });
  }

  getStatus(): SleepGuardStatus {
    return {
      installed: this.isInstalled(),
      capsLockOn: this.capsLockOn,
      engaged: this.lastApplied === true,
      error: this.errorState,
    };
  }

  /** Helper binary present AND the sudoers rule authorizes it for this user. */
  isInstalled(): boolean {
    if (this.installedCache !== null) return this.installedCache;
    if (process.platform !== "darwin" || !existsSync(SLEEP_GUARD_HELPER_PATH)) {
      this.installedCache = false;
      return false;
    }
    const probe = spawnSync(
      "/usr/bin/sudo",
      ["-n", "-l", SLEEP_GUARD_HELPER_PATH, "on"],
      { timeout: 3000 },
    );
    this.installedCache = probe.status === 0;
    return this.installedCache;
  }

  /**
   * One-time privileged install: writes the pmset helper and a sudoers rule
   * restricted to exactly its three modes. Shows the macOS administrator
   * prompt (osascript "with administrator privileges").
   */
  async install(): Promise<boolean> {
    const username = os.userInfo().username;
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      logger.main.error("Sleep guard install: unsupported username", {
        username,
      });
      return false;
    }

    const script = `#!/bin/sh
set -e
mkdir -p /Library/PrivilegedHelperTools
cat > ${SLEEP_GUARD_HELPER_PATH} <<'HELPER_EOF'
#!/bin/sh
case "$1" in
  on) exec /usr/bin/pmset -a disablesleep 1 ;;
  off) exec /usr/bin/pmset -a disablesleep 0 ;;
  display-sleep) exec /usr/bin/pmset displaysleepnow ;;
  *) echo "usage: esper-pmset on|off|display-sleep" >&2; exit 64 ;;
esac
HELPER_EOF
chown root:wheel ${SLEEP_GUARD_HELPER_PATH}
chmod 755 ${SLEEP_GUARD_HELPER_PATH}
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<SUDOERS_EOF
# Allow Esper to toggle only its fixed pmset helper.
${username} ALL=(root) NOPASSWD: ${SLEEP_GUARD_HELPER_PATH} on, ${SLEEP_GUARD_HELPER_PATH} off, ${SLEEP_GUARD_HELPER_PATH} display-sleep
SUDOERS_EOF
/usr/sbin/visudo -cf "$SUDOERS_TMP"
install -o root -g wheel -m 0440 "$SUDOERS_TMP" ${SUDOERS_PATH}
rm -f "$SUDOERS_TMP"
`;

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "esper-sleep-guard-"));
    const scriptPath = path.join(tmpDir, "install.sh");
    try {
      writeFileSync(scriptPath, script, { mode: 0o700 });
      const result = await this.run("/usr/bin/osascript", [
        "-e",
        `do shell script "/bin/sh ${scriptPath}" with administrator privileges`,
      ]);
      const ok = result.status === 0;
      logger.main.info("Sleep guard install finished", {
        status: result.status,
        stderr: result.stderr,
      });
      this.installedCache = null; // re-probe
      if (ok) {
        // Apply the current state immediately (e.g. Caps Lock already on).
        this.lastApplied = null;
        void this.handleState(this.capsLockOn, this.clamshellClosed);
      }
      return ok;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Restore normal sleep on shutdown if we disabled it. */
  async cleanup(): Promise<void> {
    if (this.lastApplied === true && this.isInstalled()) {
      const result = await this.runHelper("off");
      logger.main.info("Sleep guard restored on quit", {
        status: result.status,
      });
    }
  }

  private async handleState(
    capsLockOn: boolean,
    clamshellClosed: boolean | null,
  ): Promise<void> {
    const capsChanged = capsLockOn !== this.capsLockOn;
    this.capsLockOn = capsLockOn;
    this.clamshellClosed = clamshellClosed;

    if (!this.isInstalled()) {
      // Not installed: still surface Caps Lock state so the tray can hint.
      if (capsChanged) this.emitChanged();
      return;
    }

    if (this.applying) return;
    this.applying = true;
    try {
      if (this.lastApplied !== capsLockOn) {
        const result = await this.runHelper(capsLockOn ? "on" : "off");
        if (result.status !== 0) {
          this.errorState = true;
          logger.main.error("Sleep guard pmset toggle failed", {
            mode: capsLockOn ? "on" : "off",
            stderr: result.stderr,
          });
        } else {
          this.lastApplied = capsLockOn;
          const verified = await this.readSleepDisabled();
          this.errorState = verified !== null && verified !== capsLockOn;
          if (this.errorState) {
            logger.main.error("Sleep guard verification mismatch", {
              expected: capsLockOn,
              actual: verified,
            });
          }
          this.displaySleepRequested = false;
        }
      }

      // Lid closed while guarding with no external display: put the display
      // to sleep once so the panel/backlight state doesn't stay active.
      if (
        this.lastApplied === true &&
        this.clamshellClosed === true &&
        !this.displaySleepRequested &&
        !this.hasExternalDisplay()
      ) {
        const result = await this.runHelper("display-sleep");
        if (result.status === 0) {
          this.displaySleepRequested = true;
        }
      }
      if (this.clamshellClosed === false) {
        this.displaySleepRequested = false;
      }
    } finally {
      this.applying = false;
      this.emitChanged();
    }
  }

  private hasExternalDisplay(): boolean {
    try {
      return screen.getAllDisplays().some((display) => !display.internal);
    } catch {
      return false;
    }
  }

  private async readSleepDisabled(): Promise<boolean | null> {
    const result = await this.run("/usr/bin/pmset", ["-g"]);
    if (result.status !== 0) return null;
    for (const line of result.stdout.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields[0]?.toLowerCase() === "sleepdisabled") {
        if (fields[1] === "1") return true;
        if (fields[1] === "0") return false;
        return null;
      }
    }
    return null;
  }

  private runHelper(
    mode: "on" | "off" | "display-sleep",
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return this.run("/usr/bin/sudo", ["-n", SLEEP_GUARD_HELPER_PATH, mode]);
  }

  private run(
    command: string,
    args: string[],
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (error) =>
        resolve({ status: -1, stdout, stderr: String(error) }),
      );
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  private emitChanged(): void {
    this.emit("changed", this.getStatus());
  }
}
