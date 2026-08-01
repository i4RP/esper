import { describe, expect, it } from "vitest";

import {
  RemoteConfigSchema,
  type RemoteConfig,
} from "../../src/types/remote-config";
import {
  getActiveRemoteConfigSurfaces,
  isRemoteConfigSurfaceActive,
  isSafeRemoteConfigRoute,
  isSafeRemoteConfigUrl,
  resolveSurfaceIcon,
} from "../../src/utils/remote-config";
import { BRAND } from "../../src/constants/brand";

const config: RemoteConfig = {
  version: 1,
  surfaces: [
    {
      id: "active",
      kind: "banner",
      priority: 1,
      content: { body: "Active" },
    },
    {
      id: "higher-priority",
      kind: "side_slot",
      priority: 10,
      content: { body: "Higher priority" },
    },
    {
      id: "expired",
      kind: "banner",
      expiresAt: "2025-01-01T00:00:00.000Z",
      content: { body: "Expired" },
    },
  ],
};

describe("remote config helpers", () => {
  it("retains boolean feature flags", () => {
    const parsed = RemoteConfigSchema.parse({
      version: 1,
      surfaces: [],
      flags: { "desktop-background-updates": false },
    });

    expect(parsed.flags).toEqual({ "desktop-background-updates": false });
  });

  it("filters expired and dismissed surfaces, then sorts by priority", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const active = getActiveRemoteConfigSurfaces(
      config,
      { active: now.getTime() + dayMs }, // dismissed until tomorrow → still hidden
      now,
    );

    expect(active.map((surface) => surface.id)).toEqual(["higher-priority"]);
  });

  it("re-shows a surface once its dismissal window has lapsed", () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;
    const cfg: RemoteConfig = {
      version: 1,
      surfaces: [
        { id: "hidden", kind: "banner", content: { body: "a" } },
        { id: "lapsed", kind: "banner", content: { body: "b" } },
      ],
    };
    const active = getActiveRemoteConfigSurfaces(
      cfg,
      {
        hidden: now.getTime() + 5 * dayMs, // window not up yet → hidden
        lapsed: now.getTime() - dayMs, // window passed → shows again
      },
      now,
    );

    expect(active.map((surface) => surface.id)).toEqual(["lapsed"]);
  });

  it("treats a malformed expiry as inactive (fails closed)", () => {
    expect(
      isRemoteConfigSurfaceActive(
        {
          id: "bad-date",
          kind: "banner",
          expiresAt: "not-a-date",
          content: { body: "Bad date" },
        },
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  // BRAND.domain is null while no backend exists, so the allowlist is empty and
  // every remote URL is rejected — the shell can't be steered anywhere at all.
  // The host-matching rules themselves are covered in tests/constants/brand.test.ts.
  it("rejects every remote URL while no brand domain is configured", () => {
    expect(BRAND.domain).toBeNull();
    expect(isSafeRemoteConfigUrl("https://example.com")).toBe(false);
    expect(isSafeRemoteConfigUrl("https://app.example.com/banner")).toBe(false);
    expect(isSafeRemoteConfigUrl("http://example.com/banner")).toBe(false);
    expect(isSafeRemoteConfigUrl("https://evil.example/banner")).toBe(false);
    expect(isSafeRemoteConfigUrl("not-a-url")).toBe(false);
  });

  it("only allows CTA routes on the known-route allowlist", () => {
    expect(isSafeRemoteConfigRoute("/settings/vocabulary")).toBe(true);
    expect(isSafeRemoteConfigRoute("/notes")).toBe(false);
    expect(isSafeRemoteConfigRoute("/settings/unknown")).toBe(false);
    expect(isSafeRemoteConfigRoute("https://evil.example")).toBe(false);
  });

  // With no brand domain no iconUrl can pass the allowlist, so the named icon
  // always wins — the remote payload can never make us fetch a third-party asset.
  it("ignores every iconUrl while no brand domain is configured", () => {
    expect(
      resolveSurfaceIcon({
        body: "x",
        icon: "cloud",
        iconUrl: "https://cdn.example.com/surfaces/promo.svg",
      }),
    ).toEqual({ kind: "name", name: "cloud" });
  });

  it("ignores an off-allowlist iconUrl and falls back to the named icon", () => {
    expect(
      resolveSurfaceIcon({
        body: "x",
        icon: "lightbulb",
        iconUrl: "https://evil.example/icon.svg",
      }),
    ).toEqual({ kind: "name", name: "lightbulb" });
  });

  it("falls back to the tone's default glyph when no icon is given", () => {
    expect(resolveSurfaceIcon({ body: "x" })).toEqual({
      kind: "name",
      name: "sparkles",
    });
    expect(resolveSurfaceIcon({ body: "x" }, "warning")).toEqual({
      kind: "name",
      name: "triangle-alert",
    });
  });

  it("passes a named icon through (the renderer validates against lucide)", () => {
    expect(resolveSurfaceIcon({ body: "x", icon: "totally-made-up" })).toEqual({
      kind: "name",
      name: "totally-made-up",
    });
  });
});
