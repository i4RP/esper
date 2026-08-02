import type { AcpAgentSpec } from "./providers/acp";

/**
 * Agents Esper knows how to launch over ACP.
 *
 * Every entry costs one row here and nothing else — the protocol client is
 * shared — which is why supporting the ACP ecosystem is cheap while each
 * native integration is expensive. Entries are listed whether or not the CLI
 * is installed; availability is resolved per machine at runtime, so the UI can
 * show "install this" rather than hiding agents the user could add.
 *
 * `command` is the executable name; it is resolved against well-known install
 * locations because a packaged app does not inherit the shell's PATH. `args`
 * are whatever puts that CLI into ACP mode.
 *
 * ⚠️ Only the entries marked "verified" have had their flags confirmed against
 * that CLI's own documentation. The rest follow the common `acp` convention and
 * are unverified — an agent whose real flag differs will fail to launch until
 * its row is corrected. `ESPER_ACP_<ID>_ARGS` overrides `args` at runtime so a
 * wrong row can be worked around without a rebuild, and is how to find the
 * right value when adding one.
 */
export const ACP_CATALOG: readonly AcpAgentSpec[] = [
  // verified: documented flag
  {
    id: "acp:gemini",
    label: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
  },
  // unverified below — see the note above

  {
    id: "acp:copilot",
    label: "GitHub Copilot CLI",
    command: "copilot",
    args: ["--acp"],
  },
  {
    id: "acp:cursor",
    label: "Cursor",
    command: "cursor-agent",
    args: ["--acp"],
  },
  { id: "acp:goose", label: "goose", command: "goose", args: ["acp"] },
  {
    id: "acp:qwen",
    label: "Qwen Code",
    command: "qwen",
    args: ["--experimental-acp"],
  },
  { id: "acp:cline", label: "Cline", command: "cline", args: ["acp"] },
  { id: "acp:amp", label: "Amp", command: "amp", args: ["acp"] },
  { id: "acp:auggie", label: "Auggie CLI", command: "auggie", args: ["acp"] },
  {
    id: "acp:codebuddy",
    label: "Codebuddy Code",
    command: "codebuddy",
    args: ["acp"],
  },
  { id: "acp:crush", label: "Crush", command: "crush", args: ["acp"] },
  { id: "acp:droid", label: "Factory Droid", command: "droid", args: ["acp"] },
  { id: "acp:grok", label: "Grok CLI", command: "grok", args: ["acp"] },
  { id: "acp:junie", label: "Junie", command: "junie", args: ["acp"] },
  { id: "acp:kilo", label: "Kilo Code", command: "kilo", args: ["acp"] },
  { id: "acp:kimi", label: "Kimi Code", command: "kimi", args: ["acp"] },
  { id: "acp:mistral", label: "Mistral Vibe", command: "vibe", args: ["acp"] },
  { id: "acp:stakpak", label: "Stakpak", command: "stakpak", args: ["acp"] },
  { id: "acp:trae", label: "TRAE CLI", command: "trae", args: ["acp"] },
] as const;

/** Runtime override for a catalog entry's launch arguments. */
export const acpArgsEnvVar = (id: string): string =>
  `ESPER_ACP_${id
    .replace(/^acp:/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}_ARGS`;

/**
 * Applies any `ESPER_ACP_<ID>_ARGS` override (space-separated) to the catalog,
 * so a wrong or newly-changed flag can be fixed without shipping a build.
 */
export function resolveCatalog(
  env: NodeJS.ProcessEnv = process.env,
): AcpAgentSpec[] {
  return ACP_CATALOG.map((spec) => {
    const override = env[acpArgsEnvVar(spec.id)]?.trim();
    return override ? { ...spec, args: override.split(/\s+/) } : { ...spec };
  });
}
