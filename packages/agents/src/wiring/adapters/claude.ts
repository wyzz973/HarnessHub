// SPDX-License-Identifier: MIT
import type { ReasoningEffort, WiringTier } from "@harnesshub/core/model-plane";
import {
  overridable,
  type AdapterSetting,
  type AdapterTarget,
  type WiringAdapter,
  type WiringModel,
} from "./types.js";

/** Claude Code accepts at most this many output tokens. */
const CLAUDE_MAXIMUM_OUTPUT = 128_000;

/** Windows at least this large are marked `[1m]`; Claude Code takes any other model for 200K. */
const ONE_MILLION = 1_000_000;
const MARK_1M = "[1m]";

/** The aliases Claude Code resolves (`/model opus`, a subagent's `model: haiku`). */
const TIERS = ["opus", "sonnet", "haiku", "fable"] as const;

/** `settings.json` keeps these; `max` lasts only a session there, so it goes to the environment. */
const SETTINGS_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];
const EFFORT_ENV = "CLAUDE_CODE_EFFORT_LEVEL";

/** `CLAUDE_CODE_MODEL_CAPABILITIES` is cut to this many characters, the chosen models first. */
const CAPABILITIES_LIMIT = 8000;

/**
 * Claude Code reads `settings.json` in `${CLAUDE_CONFIG_DIR:-~/.claude}` and
 * applies its `env` block at startup. The gateway root is the Anthropic base
 * URL (Claude appends `/v1/messages`) and the key is the bearer token. As
 * Magpie's Claude wiring does (internal/agent/claude.go):
 *
 * - `ANTHROPIC_MODEL` and the top-level `model` name the main model, and each
 *   of `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` its tier's model
 *   (the main one unless chosen); `ANTHROPIC_SMALL_FAST_MODEL` follows haiku.
 *   `CLAUDE_CODE_SUBAGENT_MODEL` is the chosen subagent model, else the main
 *   model while every tier is on it; with tiers of their own it is removed,
 *   so it cannot override the tier a subagent asks for.
 * - A model whose window is at least 1M is written with `[1m]`, which Claude
 *   Code strips before asking; without it Claude Code assumes 200K and
 *   compacts long before the model runs out.
 * - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is the window of the main model, or with
 *   the main model marked `[1m]`, the smallest window of the tiers that are
 *   not; unknown windows leave it as the user had it.
 * - `CLAUDE_CODE_MODEL_CAPABILITIES` tells Claude Code which listed models
 *   take an effort (`effort`, `xhigh_effort`, `max_effort`), so it sends one.
 * - An effort goes where Claude Code reads it: `max` to
 *   `CLAUDE_CODE_EFFORT_LEVEL`; other levels to `modelSettings.<claude
 *   model>.effortLevel` for a Claude model and to the top-level
 *   `effortLevel` for models before Opus 5.5 and other vendors' models.
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
  tiers: [...TIERS, "subagent"],
  efforts: [...SETTINGS_EFFORTS, "max"],
  settings(target) {
    const env = (name: string, value: string): AdapterSetting => ({
      file: "settings",
      path: ["env", name],
      value,
    });
    const mark = marker(target.models);
    const main = mark(target.model);
    const tier = (name: WiringTier) => mark(target.tiers[name] ?? target.model);
    const same = TIERS.every((name) => tier(name) === main);
    const subagent = target.tiers.subagent;
    const window = contextWindow(target, main, tier);
    const output = target.selected?.maxOutputTokens;
    const capabilities = capabilitiesOf(target);
    return [
      env("ANTHROPIC_BASE_URL", target.baseUrl),
      env("ANTHROPIC_AUTH_TOKEN", target.keyText),
      env("ANTHROPIC_MODEL", main),
      { file: "settings", path: ["model"], value: main },
      ...TIERS.map((name) =>
        env(`ANTHROPIC_DEFAULT_${name.toUpperCase()}_MODEL`, tier(name)),
      ),
      env("ANTHROPIC_SMALL_FAST_MODEL", tier("haiku")),
      subagent !== undefined
        ? env("CLAUDE_CODE_SUBAGENT_MODEL", mark(subagent))
        : same
          ? env("CLAUDE_CODE_SUBAGENT_MODEL", main)
          : {
              file: "settings",
              path: ["env", "CLAUDE_CODE_SUBAGENT_MODEL"],
              remove: true,
            },
      ...(window
        ? [env("CLAUDE_CODE_MAX_CONTEXT_TOKENS", String(window))]
        : []),
      ...(output
        ? [
            env(
              "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
              String(Math.min(output, CLAUDE_MAXIMUM_OUTPUT)),
            ),
          ]
        : []),
      ...(capabilities
        ? [env("CLAUDE_CODE_MODEL_CAPABILITIES", capabilities)]
        : []),
      ...effortSettings(target),
    ];
  },
};

/** Marks a model `[1m]` when its known window is at least 1M tokens. */
function marker(models: readonly WiringModel[]): (ref: string) => string {
  const windows = new Map(
    models.map((model) => [model.ref, model.contextWindow ?? 0]),
  );
  return (ref) =>
    (windows.get(ref) ?? 0) >= ONE_MILLION ? ref + MARK_1M : ref;
}

/**
 * The window that serves every model not marked `[1m]`: the main model's,
 * or when it is marked, the smallest known window of the tiers that are not.
 */
function contextWindow(
  target: AdapterTarget,
  main: string,
  tier: (name: WiringTier) => string,
): number | undefined {
  const windows = new Map(
    target.models.map((model) => [model.ref, model.contextWindow]),
  );
  if (!main.endsWith(MARK_1M)) return windows.get(main);
  const known = TIERS.map(tier)
    .filter((ref) => !ref.endsWith(MARK_1M))
    .map((ref) => windows.get(ref))
    .filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : undefined;
}

function effortSettings(target: AdapterTarget): AdapterSetting[] {
  const effort = target.effort;
  if (effort === undefined) return [];
  if (effort === "max")
    return [{ file: "settings", path: ["env", EFFORT_ENV], value: "max" }];
  const name = claudeName(target.model);
  return [
    // The environment outranks settings, so a level left there would win.
    { file: "settings", path: ["env", EFFORT_ENV], remove: true },
    ...(readsTopEffort(name)
      ? [{ file: "settings", path: ["effortLevel"], value: effort }]
      : []),
    ...(name
      ? [
          {
            file: "settings",
            path: ["modelSettings", name, "effortLevel"],
            value: effort,
          },
        ]
      : []),
  ];
}

const CLAUDE_NAME =
  /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:[^0-9]|$)/;

/** The Claude model an id names (`claude-opus-5-5` in `anthropic/claude-opus-5-5-20261001`), or undefined. */
function claudeName(model: string): string | undefined {
  const match = CLAUDE_NAME.exec(model.toLowerCase());
  if (!match) return undefined;
  return `claude-${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ""}`;
}

/** Claude models that still read the top-level `effortLevel`; Opus 5.5 and later read only `modelSettings`. */
const TOP_EFFORT = new Set([
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
]);

function readsTopEffort(name: string | undefined): boolean {
  return name === undefined || TOP_EFFORT.has(name);
}

/**
 * The levels Claude Code sends a model at: none for older Claude models,
 * fewer for some, all of them for models it does not know (other vendors'
 * through the gateway, newer Claude models).
 */
function claudeEfforts(model: string): readonly ReasoningEffort[] {
  switch (claudeName(model)) {
    case "claude-opus-4-5":
      return ["low", "medium", "high"];
    case "claude-opus-4-6":
    case "claude-sonnet-4-6":
      return ["low", "medium", "high", "max"];
    case "claude-haiku-4-5":
    case "claude-sonnet-4-5":
    case "claude-opus-4":
    case "claude-sonnet-4":
      return [];
    case undefined:
      if (model.toLowerCase().includes("claude-3")) return [];
  }
  return [...SETTINGS_EFFORTS, "max"];
}

/**
 * `CLAUDE_CODE_MODEL_CAPABILITIES`: `<model>=effort[,xhigh_effort][,max_effort]`
 * per listed model with known levels, separated by `;`, in lower case; the
 * main and tier models first, the rest while they fit. Empty when no model
 * has levels.
 */
function capabilitiesOf(target: AdapterTarget): string {
  const chosen = new Set(
    [target.model, ...Object.values(target.tiers)].map((ref) =>
      ref.toLowerCase(),
    ),
  );
  const segments: Array<{ id: string; caps: string; chosen: boolean }> = [];
  for (const model of target.models) {
    const id = model.ref.toLowerCase();
    if (/[;=,]/.test(id) || id.endsWith("*")) continue;
    const allowed = claudeEfforts(id);
    const levels = (model.efforts ?? []).filter((level) =>
      allowed.includes(level),
    );
    if (!levels.length || segments.some((segment) => segment.id === id))
      continue;
    const caps = [
      "effort",
      ...(levels.includes("xhigh") ? ["xhigh_effort"] : []),
      ...(levels.includes("max") ? ["max_effort"] : []),
    ].join(",");
    segments.push({ id, caps, chosen: chosen.has(id) });
  }
  segments.sort((left, right) => Number(right.chosen) - Number(left.chosen));
  let result = "";
  for (const { id, caps } of segments) {
    const part = `${result ? ";" : ""}${id}=${caps}`;
    if (result.length + part.length > CAPABILITIES_LIMIT) break;
    result += part;
  }
  return result;
}
