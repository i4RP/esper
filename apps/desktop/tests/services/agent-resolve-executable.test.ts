import { afterEach, describe, expect, it, vi } from "vitest";
import { accessSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_PATH_ENV_VAR,
  resolveClaudeExecutable,
} from "../../src/services/agent/resolve-executable";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, accessSync: vi.fn() };
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
