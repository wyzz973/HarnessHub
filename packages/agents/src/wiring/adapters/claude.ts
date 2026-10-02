// SPDX-License-Identifier: MIT
import {
  overridable,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/** Claude Code accepts at most this many output tokens. */
const CLAUDE_MAXIMUM_OUTPUT = 128_000;

/**
 * Claude Code reads `settings.json` in `${CLAUDE_CONFIG_DIR:-~/.claude}` and
 * applies its `env` block at startup. The gateway root is the Anthropic base
 * URL (Claude appends `/v1/messages`); the key is the bearer token, and every
 * model role maps to the chosen model. The window variables are the ones
 * HarnessHub's isolated wiring uses with the pinned Claude Code.
 */
export const claude: WiringAdapter = {
  id: "claude",
  name: "Claude Code",
  protocol: "anthropic",
  keyDelivery: "config-file",
  executables: ["claude"],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (environment) =>
        overridable(
          environment,
          "CLAUDE_CONFIG_DIR",
          [".claude"],
          ["settings.json"],
        ),
    },
  ],
  baseUrlField: { file: "settings", path: ["env", "ANTHROPIC_BASE_URL"] },
  settings(target) {
    const env = (name: string, value: string): AdapterSetting => ({
      file: "settings",
      path: ["env", name],
      value,
    });
    const { contextWindow, maxOutputTokens } = target.selected ?? {};
    return [
      env("ANTHROPIC_BASE_URL", target.baseUrl),
      env("ANTHROPIC_AUTH_TOKEN", target.keyText),
      env("ANTHROPIC_MODEL", target.model),
      env("ANTHROPIC_DEFAULT_OPUS_MODEL", target.model),
      env("ANTHROPIC_DEFAULT_SONNET_MODEL", target.model),
      env("ANTHROPIC_DEFAULT_HAIKU_MODEL", target.model),
      ...(contextWindow
        ? [env("CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(contextWindow))]
        : []),
      ...(maxOutputTokens
        ? [
            env(
              "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
              String(Math.min(maxOutputTokens, CLAUDE_MAXIMUM_OUTPUT)),
            ),
          ]
        : []),
    ];
  },
};
