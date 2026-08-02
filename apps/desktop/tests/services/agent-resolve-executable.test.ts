import { afterEach, describe, expect, it, vi } from "vitest";
import { accessSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_PATH_ENV_VAR,
  resolveClaudeExecutable,
  resolveExecutable,
} from "../../src/services/agent/resolve-executable";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(),
    // No version manager installed unless a test says otherwise.
    readdirSync: vi.fn(() => {
      throw new Error("ENOENT");
    }),
  };
});

const HOME = "/Users/tester";

/** Marks exactly the given paths as existing-and-executable. */
const onlyExecutable = (...paths: string[]) => {
  vi.mocked(accessSync).mockImplementation((target) => {
    if (!paths.includes(String(target))) {
      throw new Error("ENOENT");
    }
  });
};

afterEach(() => {
  vi.mocked(accessSync).mockReset();
});

describe("node version managers", () => {
  // Most of the ACP catalog runs through npx. Version managers put it under a
  // per-version directory that only a shell profile adds to PATH, so a
  // packaged app would otherwise find no npx and hide those agents.
  it("finds npx under an nvm-managed node", () => {
    const npx = join(
      HOME,
      ".nvm",
      "versions",
      "node",
      "v22.22.2",
      "bin",
      "npx",
    );
    vi.mocked(readdirSync).mockImplementation(((target: string) =>
      String(target).endsWith(join(".nvm", "versions", "node"))
        ? ["v20.1.0", "v22.22.2"]
        : (() => {
            throw new Error("ENOENT");
          })()) as unknown as typeof readdirSync);
    onlyExecutable(npx);

    expect(resolveExecutable("npx", { env: {}, home: HOME })).toBe(npx);
  });

  // A version manager's copy is a fallback, not the preferred one.
  it("prefers a system install over a managed one", () => {
    const managed = join(
      HOME,
      ".nvm",
      "versions",
      "node",
      "v22.22.2",
      "bin",
      "npx",
    );
    vi.mocked(readdirSync).mockImplementation((() => [
      "v22.22.2",
    ]) as unknown as typeof readdirSync);
    onlyExecutable(managed, "/opt/homebrew/bin/npx");

    expect(resolveExecutable("npx", { env: {}, home: HOME })).toBe(
      "/opt/homebrew/bin/npx",
    );
  });

  it("copes with no version manager present", () => {
    onlyExecutable();
    expect(resolveExecutable("npx", { env: {}, home: HOME })).toBeNull();
  });
});

describe("resolveClaudeExecutable", () => {
  it("returns null when Claude Code isn't installed anywhere", () => {
    onlyExecutable();
    expect(
      resolveClaudeExecutable({ env: { PATH: "/usr/bin" }, home: HOME }),
    ).toBeNull();
  });

  // Where Claude Code's own installer puts it — and precisely the directory a
  // packaged macOS app does not get on its PATH.
  it("finds the installer's location without consulting PATH", () => {
    const installed = join(HOME, ".local", "bin", "claude");
    onlyExecutable(installed);

    expect(resolveClaudeExecutable({ env: {}, home: HOME })).toBe(installed);
  });

  it("falls back to the legacy install location", () => {
    const legacy = join(HOME, ".claude", "local", "claude");
    onlyExecutable(legacy);

    expect(resolveClaudeExecutable({ env: {}, home: HOME })).toBe(legacy);
  });

  it("prefers the installer's location over a package manager copy", () => {
    const installed = join(HOME, ".local", "bin", "claude");
    onlyExecutable(installed, "/opt/homebrew/bin/claude");

    expect(resolveClaudeExecutable({ env: {}, home: HOME })).toBe(installed);
  });

  it("searches PATH as a last resort", () => {
    onlyExecutable("/custom/tools/claude");

    expect(
      resolveClaudeExecutable({
        env: { PATH: "/usr/bin:/custom/tools" },
        home: HOME,
      }),
    ).toBe("/custom/tools/claude");
  });

  it("ignores a non-executable file with the right name", () => {
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(
      resolveClaudeExecutable({ env: { PATH: "/usr/bin" }, home: HOME }),
    ).toBeNull();
  });

  describe("explicit override", () => {
    it("wins over every well-known location", () => {
      onlyExecutable(
        "/opt/custom/claude",
        join(HOME, ".local", "bin", "claude"),
      );

      expect(
        resolveClaudeExecutable({
          env: { [CLAUDE_PATH_ENV_VAR]: "/opt/custom/claude" },
          home: HOME,
        }),
      ).toBe("/opt/custom/claude");
    });

    // A broken override is a misconfiguration: silently running a different
    // binary would make it look like the setting took effect when it didn't.
    it("returns null rather than falling through when it is wrong", () => {
      onlyExecutable(join(HOME, ".local", "bin", "claude"));

      expect(
        resolveClaudeExecutable({
          env: { [CLAUDE_PATH_ENV_VAR]: "/opt/missing/claude" },
          home: HOME,
        }),
      ).toBeNull();
    });

    it("ignores a blank override", () => {
      const installed = join(HOME, ".local", "bin", "claude");
      onlyExecutable(installed);

      expect(
        resolveClaudeExecutable({
          env: { [CLAUDE_PATH_ENV_VAR]: "   " },
          home: HOME,
        }),
      ).toBe(installed);
    });
  });
});
