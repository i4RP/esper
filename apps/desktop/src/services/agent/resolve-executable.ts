import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Finds an agent CLI on this machine.
 *
 * Every provider hits the same problem: the CLI is installed separately by the
 * user, and a packaged macOS app launched from Finder inherits launchd's PATH,
 * not the shell's — so `~/.local/bin` and `~/.npm-global/bin`, where these
 * tools install themselves, are simply absent. Resolving an absolute path here
 * and handing it to the provider is what makes a packaged build behave like
 * `pnpm start`.
 */

/** `ESPER_CLAUDE_PATH`, `ESPER_CODEX_PATH`, … — per-tool escape hatch. */
export const executableEnvVar = (name: string): string =>
  `ESPER_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PATH`;

const withExeSuffix = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name;

/**
 * Node version managers install `node`/`npx` under a per-version directory that
 * is only on PATH because a shell profile put it there — so a packaged app
 * never sees it. Most of the ACP catalog runs through `npx`, which would make
 * those agents silently undetectable. Newest version first, since that is what
 * an interactive shell would most likely resolve to.
 */
const versionManagerBinDirs = (home: string): string[] => {
  const roots = [
    join(home, ".nvm", "versions", "node"),
    join(home, ".fnm", "node-versions"),
    join(home, ".local", "share", "mise", "installs", "node"),
    join(home, ".asdf", "installs", "nodejs"),
  ];

  const dirs: string[] = [];
  for (const root of roots) {
    let versions: string[];
    try {
      versions = readdirSync(root);
    } catch {
      continue;
    }
    // Reverse lexicographic order approximates newest-first well enough for
    // picking a runner; exact semver ordering is not worth the complexity.
    for (const version of versions.sort().reverse()) {
      // fnm and asdf nest the actual bin one level deeper than nvm does.
      dirs.push(join(root, version, "bin"));
      dirs.push(join(root, version, "installation", "bin"));
    }
  }
  return dirs;
};

/**
 * Install locations searched ahead of PATH, in preference order. These are
 * where the agent CLIs and the package managers that install them put things.
 */
const wellKnownDirs = (home: string): string[] => {
  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".deno", "bin"),
  ];

  if (process.platform !== "win32") {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  }

  // Last among the well-known locations: a system-wide install should win over
  // whichever version a version manager happens to have selected.
  dirs.push(...versionManagerBinDirs(home));

  return dirs;
};

const isExecutable = (candidate: string): boolean => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Returns an absolute path to `name`, or null when it isn't installed.
 *
 * Null is an ordinary outcome — Esper works without any given agent CLI — so
 * callers surface "install X" rather than treating it as a failure.
 */
export function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const fileName = withExeSuffix(name);

  const override = env[executableEnvVar(name)]?.trim();
  if (override) {
    // A broken override is a misconfiguration worth surfacing: silently running
    // some other binary would look like the setting took effect when it didn't.
    return isExecutable(override) ? override : null;
  }

  for (const dir of wellKnownDirs(home)) {
    const candidate = join(dir, fileName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  // PATH last: populated under `pnpm start`, largely empty in a packaged app,
  // so it's a fallback rather than the source of truth.
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, fileName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Message shown when an agent CLI isn't installed. */
export const notInstalledMessage = (label: string, name: string): string =>
  `${label} was not found. Install it, or set ${executableEnvVar(name)} to the ` +
  `full path of the \`${name}\` executable.`;

/** Convenience wrapper for the Claude Code CLI. */
export function resolveClaudeExecutable(
  options: ResolveExecutableOptions = {},
): string | null {
  return resolveExecutable("claude", options);
}

export const CLAUDE_PATH_ENV_VAR = executableEnvVar("claude");

export const CLAUDE_NOT_FOUND_MESSAGE = notInstalledMessage(
  "Claude Code",
  "claude",
);
