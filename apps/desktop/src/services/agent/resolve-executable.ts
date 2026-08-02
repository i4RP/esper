import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Finds the `claude` executable to hand the Agent SDK.
 *
 * The SDK does not ship Claude Code — the npm package is a few MB and the real
 * binary is ~256MB, installed separately by the user. Left to its own devices
 * the SDK resolves it from PATH, which works in a terminal and fails in a
 * packaged app: a macOS app launched from Finder or the Dock inherits launchd's
 * PATH, not the shell's, so `~/.local/bin` (where the installer puts it) simply
 * isn't there. Resolving it ourselves and passing an absolute path is what
 * makes a packaged build behave the same as `pnpm start`.
 */

/** Overrides everything else — for non-standard installs and for testing. */
export const CLAUDE_PATH_ENV_VAR = "ESPER_CLAUDE_PATH";

const EXECUTABLE_NAME = process.platform === "win32" ? "claude.exe" : "claude";

/**
 * Install locations in preference order, ahead of PATH. The first two are where
 * Claude Code's own installer puts it (current and legacy layouts); the rest
 * cover package managers.
 */
const wellKnownPaths = (home: string): string[] => {
  if (process.platform === "win32") {
    return [
      join(home, ".local", "bin", EXECUTABLE_NAME),
      join(home, ".claude", "local", EXECUTABLE_NAME),
    ];
  }

  return [
    join(home, ".local", "bin", EXECUTABLE_NAME),
    join(home, ".claude", "local", EXECUTABLE_NAME),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
};

const isExecutable = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface ResolveClaudeExecutableOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Returns an absolute path to `claude`, or null when it isn't installed.
 *
 * Null is a normal outcome, not a failure: Esper is useful without Claude Code,
 * so callers surface "install Claude Code" rather than treating this as a bug.
 */
export function resolveClaudeExecutable(
  options: ResolveClaudeExecutableOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();

  const override = env[CLAUDE_PATH_ENV_VAR]?.trim();
  if (override) {
    // An explicit override that doesn't work is a misconfiguration worth
    // surfacing, so don't quietly fall through to a different binary.
    return isExecutable(override) ? override : null;
  }

  for (const candidate of wellKnownPaths(home)) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  // PATH last: it's populated when running from a terminal (`pnpm start`) and
  // largely empty in a packaged app, so it's a fallback rather than the source
  // of truth.
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, EXECUTABLE_NAME);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Message shown when Claude Code isn't installed. */
export const CLAUDE_NOT_FOUND_MESSAGE =
  "Claude Code was not found. Install it from https://code.claude.com, " +
  `or set ${CLAUDE_PATH_ENV_VAR} to the full path of the \`claude\` executable.`;
