import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { app, autoUpdater, net } from "electron";
import { AutoUpdaterService } from "../../src/main/services/auto-updater";
import { BRAND } from "../../src/constants/brand";

/**
 * The shipping configuration: BRAND.updateServer is null, so there is no feed
 * to ask. This is a security boundary, not a missing feature — an update feed
 * we do not control could hand arbitrary code to an app signed with our
 * certificate, so the updater must stay wired shut rather than fall back to
 * the upstream project's server. Deliberately unmocked, unlike
 * auto-updater.test.ts, which pins a stand-in server to exercise the state
 * machine.
 */
describe("AutoUpdaterService with no update feed configured", () => {
  let service: AutoUpdaterService;

  const initialize = () =>
    service.initialize(
      {
        getUpdateChannel: vi.fn().mockResolvedValue("stable"),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      } as any,
      {
        captureException: vi.fn(),
        getMachineId: vi.fn().mockReturnValue("machine-xyz"),
      } as any,
      {
        getConfig: vi.fn().mockReturnValue({
          version: 1,
          surfaces: [],
          flags: { "desktop-background-updates": true },
        }),
      } as any,
      Object.assign(new EventEmitter(), {
        getState: vi.fn(() => "idle"),
      }) as any,
    );

  beforeEach(() => {
    (app as unknown as { isPackaged: boolean }).isPackaged = true;
    autoUpdater.removeAllListeners();
    vi.clearAllMocks();
    vi.mocked(app.getVersion).mockReturnValue("0.1.0-test");
    service = new AutoUpdaterService();
  });

  afterEach(() => {
    service.cleanup();
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
  });

  it("ships with no update server", () => {
    expect(BRAND.updateServer).toBeNull();
  });

  // Squirrel resolves the feed at check time, so never handing it a URL is
  // what actually prevents a download — not merely skipping our own check.
  it("never points Squirrel at a feed URL", async () => {
    await initialize();

    expect(vi.mocked(autoUpdater.setFeedURL)).not.toHaveBeenCalled();
    expect(vi.mocked(autoUpdater.checkForUpdates)).not.toHaveBeenCalled();
  });

  it("makes no network request on an explicit check", async () => {
    await initialize();
    await service.checkForUpdates();

    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(autoUpdater.checkForUpdates)).not.toHaveBeenCalled();
  });

  // The About page spins until it hears back. Without this the user would sit
  // on a "checking…" that can never resolve.
  it("reports up to date so the About page settles", async () => {
    await initialize();

    const notAvailable = vi.fn();
    service.on("update-not-available", notAvailable);

    await service.checkForUpdates();

    expect(notAvailable).toHaveBeenCalledOnce();
    expect(service.getUpdateState()).toBe("not-available");
    expect(service.isDownloaded()).toBe(false);
  });

  it("stays quiet when checked repeatedly", async () => {
    await initialize();
    await service.checkForUpdates();
    await service.checkForUpdates();

    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
    expect(service.getUpdateState()).toBe("not-available");
  });
});
