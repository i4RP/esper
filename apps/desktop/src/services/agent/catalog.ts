import type { AcpAgentSpec } from "./providers/acp";

/**
 * Agents Esper can launch over ACP.
 *
 * Every entry costs one row here and nothing else — the protocol client is
 * shared — which is why supporting the ACP ecosystem is cheap while each
 * native integration is expensive.
 *
 * Most entries run through `npx`/`uvx` at a pinned version rather than a
 * pre-installed binary, so "is this agent available" usually reduces to "is
 * npx available". Entries are listed whether or not their runner is present;
 * availability is resolved per machine so the UI can offer to install rather
 * than hiding agents the user could add.
 *
 * `command[0]` is the executable (resolved against well-known install
 * locations, because a packaged app does not inherit the shell's PATH) and the
 * rest are arguments. Versions are pinned deliberately: an agent that
 * auto-updates can change its protocol behaviour under a running session.
 * `ESPER_ACP_<ID>_ARGS` overrides the arguments at runtime.
 */
export const ACP_CATALOG: readonly AcpAgentSpec[] = [
  {
    id: "acp:agoragentic",
    label: "Agoragentic",
    command: ["npx", "-y", "agoragentic-mcp@1.3.6", "--acp"],
  },
  { id: "acp:amp", label: "Amp", command: ["amp-acp"] },
  {
    id: "acp:auggie",
    label: "Auggie CLI",
    command: ["npx", "-y", "@augmentcode/auggie@0.33.0", "--acp"],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
  },
  {
    id: "acp:autohand",
    label: "Autohand Code",
    command: ["npx", "-y", "@autohandai/autohand-acp@0.2.1"],
  },
  {
    id: "acp:cline",
    label: "Cline",
    command: ["npx", "-y", "cline@3.0.46", "--acp"],
  },
  {
    id: "acp:codebuddy",
    label: "Codebuddy Code",
    command: ["codebuddy", "--acp"],
  },
  {
    id: "acp:codewhale",
    label: "CodeWhale",
    command: ["codewhale", "serve", "--acp"],
  },
  {
    id: "acp:cortex",
    label: "Cortex Code",
    command: ["cortex", "acp", "serve"],
  },
  { id: "acp:corust", label: "Corust Agent", command: ["corust-agent-acp"] },
  { id: "acp:crow", label: "crow-cli", command: ["crow-cli", "acp"] },
  { id: "acp:cursor", label: "Cursor", command: ["cursor-agent", "acp"] },
  {
    id: "acp:deepagents",
    label: "DeepAgents",
    command: ["npx", "-y", "deepagents-acp@0.1.20"],
  },
  { id: "acp:devin", label: "Devin CLI", command: ["devin", "acp"] },
  {
    id: "acp:dimcode",
    label: "DimCode",
    command: ["npx", "-y", "dimcode@0.2.36", "acp"],
  },
  {
    id: "acp:dirac",
    label: "Dirac",
    command: ["npx", "-y", "dirac-cli@0.4.22", "--acp"],
  },
  {
    id: "acp:droid",
    label: "Factory Droid",
    command: [
      "npx",
      "-y",
      "droid@0.179.0",
      "exec",
      "--output-format",
      "acp-daemon",
    ],
    env: {
      DROID_DISABLE_AUTO_UPDATE: "true",
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    },
  },
  {
    id: "acp:fast-agent",
    label: "fast-agent",
    command: [
      "uvx",
      "--from",
      "fast-agent-acp==0.9.22",
      "fast-agent-acp",
      "-x",
    ],
  },
  {
    id: "acp:gemini",
    label: "Gemini CLI",
    command: ["npx", "-y", "@google/gemini-cli@0.52.0", "--acp"],
  },
  {
    id: "acp:glm",
    label: "GLM Agent",
    command: ["npx", "-y", "glm-acp-agent@1.3.0"],
  },
  { id: "acp:goose", label: "goose", command: ["goose", "acp"] },
  { id: "acp:grok", label: "Grok", command: ["grok", "agent", "stdio"] },
  { id: "acp:hermes", label: "Hermes", command: ["hermes", "acp"] },
  { id: "acp:junie", label: "Junie", command: ["junie", "--acp", "true"] },
  { id: "acp:kilo", label: "Kilo", command: ["kilo", "acp"] },
  { id: "acp:kimi", label: "Kimi Code CLI", command: ["kimi", "acp"] },
  { id: "acp:kiro", label: "Kiro CLI", command: ["kiro-cli", "acp"] },
  {
    id: "acp:minion",
    label: "Minion Code",
    command: ["uvx", "--from", "minion-code==0.1.44", "minion-code", "acp"],
  },
  { id: "acp:mistral", label: "Mistral Vibe", command: ["vibe-acp"] },
  {
    id: "acp:nova",
    label: "Nova",
    command: ["npx", "-y", "@compass-ai/nova@1.1.29", "acp"],
  },
  { id: "acp:poolside", label: "Poolside", command: ["pool", "acp"] },
  {
    id: "acp:qoder",
    label: "Qoder CLI",
    command: ["npx", "-y", "@qoder-ai/qodercli@1.1.4", "--acp"],
  },
  {
    id: "acp:qwen",
    label: "Qwen Code",
    command: [
      "npx",
      "-y",
      "@qwen-code/qwen-code@0.20.1",
      "--acp",
      "--experimental-skills",
    ],
  },
  { id: "acp:sigit", label: "siGit Code", command: ["sigit"] },
  { id: "acp:stakpak", label: "Stakpak", command: ["stakpak", "acp"] },
  { id: "acp:trae", label: "TRAE CLI", command: ["traecli", "acp", "serve"] },
  {
    id: "acp:vtcode",
    label: "VT Code",
    command: ["vtcode", "acp"],
    env: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" },
  },
] as const;

/** Runtime override for a catalog entry's arguments (space-separated). */
export const acpArgsEnvVar = (id: string): string =>
  `ESPER_ACP_${id
    .replace(/^acp:/, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}_ARGS`;

/**
 * Applies any `ESPER_ACP_<ID>_ARGS` override, so a flag that changes upstream
 * can be corrected without shipping a build. The executable itself is not
 * overridable here — `ESPER_<NAME>_PATH` covers that.
 */
export function resolveCatalog(
  env: NodeJS.ProcessEnv = process.env,
): AcpAgentSpec[] {
  return ACP_CATALOG.map((spec) => {
    const override = env[acpArgsEnvVar(spec.id)]?.trim();
    if (!override) {
      return { ...spec, command: [...spec.command] };
    }
    return { ...spec, command: [spec.command[0], ...override.split(/\s+/)] };
  });
}
