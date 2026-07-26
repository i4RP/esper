import {
  app,
  clipboard,
  globalShortcut,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
} from "electron";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuid } from "uuid";
import { logger } from "../main/logger";
import { initMainI18n } from "../i18n/main";
import type { ServiceManager } from "../main/managers/service-manager";

const POLL_INTERVAL_MS = 1000;
const MAX_HISTORY = 30;
const GROUP_SIZE = 10;
const LABEL_MAX_CHARS = 45;
const SUPPRESS_AFTER_PASTE_MS = 2000;

interface HistoryEntry {
  id: string;
  type: "text" | "image";
  text?: string;
  imagePath?: string;
  /** md5 of the PNG bytes — dedupes clipboard captures vs. file screenshots */
  hash?: string;
  at: number;
}

/**
 * Clipy-style clipboard history + snippet paste menu.
 *
 * Polls the system clipboard and keeps the last 30 copied texts/images
 * (screenshots copied to the clipboard included). Cmd+Shift+V pops a menu at
 * the cursor: history in groups of ten, the enabled snippet folders from the
 * settings snippet library, and a clear action. Picking an item pastes it
 * into the frontmost app (text via the native helper, images via clipboard +
 * a synthesized Cmd+V).
 */
export class ClipboardHistoryService {
  private history: HistoryEntry[] = [];
  private lastText: string | null = null;
  private lastImageHash: string | null = null;
  private suppressUntil = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private screenshotWatcher: fs.FSWatcher | null = null;
  private pendingScreenshots = new Map<string, NodeJS.Timeout>();
  private t: ((key: string, options?: Record<string, unknown>) => string) | null =
    null;

  constructor(private serviceManager: ServiceManager) {}

  private get storageDir(): string {
    return path.join(app.getPath("userData"), "clipboard-history");
  }

  private get historyFile(): string {
    return path.join(this.storageDir, "history.json");
  }

  async initialize(locale?: string | null): Promise<void> {
    const i18n = await initMainI18n(locale);
    this.t = i18n.t.bind(i18n);

    fs.mkdirSync(this.storageDir, { recursive: true });
    this.loadHistory();

    // Prime the dedup state with the current clipboard so long-standing
    // content isn't captured as a "new" entry on startup.
    this.lastText = clipboard.readText() || null;
    const image = clipboard.readImage();
    this.lastImageHash = image.isEmpty() ? null : this.hashImage(image.toPNG());

    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.startScreenshotWatcher();

    const ok = globalShortcut.register("CommandOrControl+Shift+V", () => {
      void this.showMenu();
    });
    logger.main.info("Clipboard history service initialized", {
      shortcutRegistered: ok,
      entries: this.history.length,
    });
  }

  cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    globalShortcut.unregister("CommandOrControl+Shift+V");
    this.screenshotWatcher?.close();
    for (const timer of this.pendingScreenshots.values()) clearTimeout(timer);
    this.saveHistory();
  }

  // ── capture ────────────────────────────────────────────────────────

  private poll(): void {
    try {
      if (Date.now() < this.suppressUntil) return;

      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        const png = image.toPNG();
        const hash = this.hashImage(png);
        if (hash !== this.lastImageHash) {
          this.lastImageHash = hash;
          this.lastText = clipboard.readText() || null;
          this.addImageEntry(png, hash);
        }
        return;
      }

      const text = clipboard.readText();
      if (text && text !== this.lastText) {
        this.lastText = text;
        this.lastImageHash = null;
        this.addEntry({ id: uuid(), type: "text", text, at: Date.now() });
      }
    } catch (error) {
      logger.main.debug("Clipboard poll failed", { error });
    }
  }

  private hashImage(png: Buffer): string {
    return createHash("md5").update(png).digest("hex");
  }

  private addImageEntry(png: Buffer, hash: string): void {
    // Dedupe: the same image may arrive twice (e.g. a screenshot saved to a
    // file AND copied to the clipboard).
    if (this.history.some((entry) => entry.hash === hash)) return;
    const id = uuid();
    const imagePath = path.join(this.storageDir, `img-${id}.png`);
    try {
      fs.writeFileSync(imagePath, png);
    } catch (error) {
      logger.main.warn("Failed to persist clipboard image", { error });
      return;
    }
    this.addEntry({ id, type: "image", imagePath, hash, at: Date.now() });
  }

  // ── screenshot watching ────────────────────────────────────────────
  // Normal screenshots (Cmd+Shift+3/4 without Ctrl) are saved as files, not
  // put on the clipboard — watch the configured screencapture folder and pull
  // new screenshot files into the history.

  private screencaptureLocation(): string {
    try {
      const raw = execFileSync(
        "/usr/bin/defaults",
        ["read", "com.apple.screencapture", "location"],
        { timeout: 2000 },
      )
        .toString()
        .trim();
      if (raw) {
        const expanded = raw.startsWith("~")
          ? path.join(app.getPath("home"), raw.slice(1))
          : raw;
        if (fs.existsSync(expanded)) return expanded;
      }
    } catch {
      // default location
    }
    return app.getPath("desktop");
  }

  private startScreenshotWatcher(): void {
    if (process.platform !== "darwin") return;
    const location = this.screencaptureLocation();
    try {
      this.screenshotWatcher = fs.watch(location, (_event, filename) => {
        if (!filename) return;
        this.handleScreenshotCandidate(location, filename.toString());
      });
      logger.main.info("Watching screenshot folder", { location });
    } catch (error) {
      logger.main.warn("Screenshot folder watch failed", { error, location });
    }
  }

  private handleScreenshotCandidate(dir: string, filename: string): void {
    // screencapture writes to a dotted temp name, then renames to the final
    // localized name ("スクリーンショット …", "Screenshot …", "Screen Shot …").
    if (filename.startsWith(".")) return;
    if (!/\.(png|jpg|jpeg)$/i.test(filename)) return;
    if (!/^(スクリーンショット|screen ?shot)/i.test(filename)) return;

    // Debounce per file: wait for the write to settle before reading.
    const existing = this.pendingScreenshots.get(filename);
    if (existing) clearTimeout(existing);
    this.pendingScreenshots.set(
      filename,
      setTimeout(() => {
        this.pendingScreenshots.delete(filename);
        try {
          const fullPath = path.join(dir, filename);
          const stat = fs.statSync(fullPath);
          if (!stat.isFile() || stat.size === 0) return;
          // Only ingest freshly created screenshots, not old files touched by
          // e.g. a folder sync.
          if (Date.now() - stat.birthtimeMs > 30_000) return;
          const png = fs.readFileSync(fullPath);
          this.addImageEntry(png, this.hashImage(png));
        } catch {
          // file vanished mid-write; the next event retries
        }
      }, 800),
    );
  }

  private addEntry(entry: HistoryEntry): void {
    this.history.unshift(entry);
    const evicted = this.history.splice(MAX_HISTORY);
    for (const old of evicted) {
      if (old.imagePath) fs.rmSync(old.imagePath, { force: true });
    }
    this.saveHistory();
  }

  private loadHistory(): void {
    try {
      const raw = fs.readFileSync(this.historyFile, "utf8");
      const parsed = JSON.parse(raw) as HistoryEntry[];
      this.history = parsed.filter(
        (entry) =>
          entry.type === "text" ||
          (entry.imagePath !== undefined && fs.existsSync(entry.imagePath)),
      );
    } catch {
      this.history = [];
    }
  }

  private saveHistory(): void {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history));
    } catch (error) {
      logger.main.warn("Failed to persist clipboard history", { error });
    }
  }

  clearHistory(): void {
    for (const entry of this.history) {
      if (entry.imagePath) fs.rmSync(entry.imagePath, { force: true });
    }
    this.history = [];
    this.saveHistory();
  }

  // ── menu ───────────────────────────────────────────────────────────

  private async showMenu(): Promise<void> {
    if (!this.t) return;
    const t = this.t;
    const template: MenuItemConstructorOptions[] = [];

    template.push({ label: t("clipboardMenu.history"), enabled: false });
    if (this.history.length === 0) {
      template.push({ label: t("clipboardMenu.empty"), enabled: false });
    } else {
      for (
        let start = 0;
        start < this.history.length;
        start += GROUP_SIZE
      ) {
        const group = this.history.slice(start, start + GROUP_SIZE);
        template.push({
          label: `${start + 1} - ${start + group.length}`,
          submenu: group.map((entry) => this.menuItemFor(entry)),
        });
      }
    }

    const library = await this.getSnippetLibrary();
    const enabledFolders = library.folders.filter(
      (folder) =>
        folder.enabled && folder.snippets.some((snippet) => snippet.enabled),
    );
    if (enabledFolders.length > 0) {
      template.push({ type: "separator" });
      template.push({ label: t("clipboardMenu.snippets"), enabled: false });
      for (const folder of enabledFolders) {
        template.push({
          label: folder.name,
          submenu: folder.snippets
            .filter((snippet) => snippet.enabled)
            .map((snippet) => ({
              label: this.truncate(snippet.title || snippet.content),
              click: () => void this.pasteText(snippet.content),
            })),
        });
      }
    }

    template.push({ type: "separator" });
    template.push({
      label: t("clipboardMenu.clear"),
      click: () => this.clearHistory(),
    });
    template.push({
      label: t("clipboardMenu.editSnippets"),
      click: () => void this.openMainWindowAt("/settings/snippet-editor"),
    });
    template.push({
      label: t("clipboardMenu.preferences"),
      click: () => void this.openMainWindowAt("/settings/preferences"),
    });

    const menu = Menu.buildFromTemplate(template);
    try {
      const windowManager = this.serviceManager.getService("windowManager");
      const widgetWindow = windowManager?.getWidgetWindow();
      if (widgetWindow && !widgetWindow.isDestroyed()) {
        menu.popup({ window: widgetWindow });
        return;
      }
    } catch {
      // fall through to a windowless popup
    }
    menu.popup({});
  }

  private menuItemFor(entry: HistoryEntry): MenuItemConstructorOptions {
    if (entry.type === "image" && entry.imagePath) {
      const thumbnail = nativeImage
        .createFromPath(entry.imagePath)
        .resize({ height: 22 });
      return {
        label: this.t ? this.t("clipboardMenu.image") : "Image",
        icon: thumbnail,
        click: () => void this.pasteImage(entry.imagePath!),
      };
    }
    return {
      label: this.truncate(entry.text ?? ""),
      click: () => void this.pasteText(entry.text ?? ""),
    };
  }

  private async openMainWindowAt(route: string): Promise<void> {
    try {
      const windowManager = this.serviceManager.getService("windowManager");
      await windowManager?.navigateMainWindow(route);
    } catch (error) {
      logger.main.warn("Failed to open main window from clipboard menu", {
        error,
      });
    }
  }

  private truncate(text: string): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    return singleLine.length > LABEL_MAX_CHARS
      ? `${singleLine.slice(0, LABEL_MAX_CHARS)}…`
      : singleLine || " ";
  }

  private async getSnippetLibrary() {
    try {
      const settingsService = this.serviceManager.getService("settingsService");
      return await settingsService.getSnippetLibrary();
    } catch {
      return { folders: [] };
    }
  }

  // ── paste ──────────────────────────────────────────────────────────

  private async pasteText(text: string): Promise<void> {
    if (!text) return;
    this.suppressUntil = Date.now() + SUPPRESS_AFTER_PASTE_MS;
    this.lastText = text;
    this.lastImageHash = null;
    try {
      const nativeBridge = this.serviceManager.getService("nativeBridge");
      await nativeBridge.call("pasteText", {
        transcript: text,
        preserveClipboard: false,
      });
    } catch (error) {
      logger.main.warn("Clipboard menu paste failed", { error });
      clipboard.writeText(text);
    }
  }

  private async pasteImage(imagePath: string): Promise<void> {
    this.suppressUntil = Date.now() + SUPPRESS_AFTER_PASTE_MS;
    const image = nativeImage.createFromPath(imagePath);
    if (image.isEmpty()) return;
    clipboard.writeImage(image);
    this.lastImageHash = this.hashImage(image.toPNG());
    this.lastText = null;
    // Synthesize Cmd+V into the frontmost app (accessibility permission is
    // already granted for dictation pasting).
    await new Promise<void>((resolve) => {
      const child = spawn("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to keystroke "v" using command down',
      ]);
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
  }
}
