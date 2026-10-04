// SPDX-License-Identifier: MIT
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import type { ConfigValue } from "../formats/index.js";
import {
  outputLimit,
  overridable,
  withSelected,
  type WiringAdapter,
  type WiringModel,
} from "./types.js";

/** Pi's thinking levels, lowest first (pi-ai's EXTENDED_THINKING_LEVELS). */
const PI_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/**
 * Pi reads `settings.json` and `models.json` in
 * `${PI_CODING_AGENT_DIR:-~/.pi/agent}`. A `harnesshub` provider speaks Chat
 * Completions to `<gateway>/v1` with the key as a literal `apiKey` and
 * becomes the default. As in Magpie, each model is asked on the protocol its
 * provider serves natively, so the gateway passes the request through: a
 * provider without Chat but with Responses gets `api: openai-responses`, one
 * with only Anthropic Messages `api: anthropic-messages` and the gateway
 * root as `baseUrl`; route groups and the rest stay on Chat. Each model
 * carries its window, output limit, image input and, with known reasoning
 * levels, `reasoning` and a `thinkingLevelMap` from Pi's levels to the
 * model's own. The effort goes to `defaultThinkingLevel` (`none` is Pi's
 * `off`).
 */
export const pi: WiringAdapter = {
  id: "pi",
  name: "Pi",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["pi"],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (e) =>
        overridable(
          e,
          "PI_CODING_AGENT_DIR",
          [".pi", "agent"],
          ["settings.json"],
        ),
    },
    {
      id: "models",
      format: "json",
      locate: (e) =>
        overridable(
          e,
          "PI_CODING_AGENT_DIR",
          [".pi", "agent"],
          ["models.json"],
        ),
    },
  ],
  baseUrlField: {
    file: "models",
    path: ["providers", "harnesshub", "baseUrl"],
  },
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  settings(target) {
    return [
      { file: "settings", path: ["defaultProvider"], value: "harnesshub" },
      { file: "settings", path: ["defaultModel"], value: target.model },
      ...(target.effort !== undefined
        ? [
            {
              file: "settings",
              path: ["defaultThinkingLevel"],
              value: target.effort === "none" ? "off" : target.effort,
            },
          ]
        : []),
      {
        file: "models",
        path: ["providers", "harnesshub"],
        value: {
          baseUrl: `${target.baseUrl}/v1`,
          api: "openai-completions",
          apiKey: target.keyText,
          models: withSelected(target.models, target.model).map((model) =>
            piModel(model, target.baseUrl),
          ),
        },
      },
    ];
  },
};

function piModel(model: WiringModel, gateway: string): ConfigValue {
  const native = model.nativeProtocols ?? [];
  const api = native.includes("chat")
    ? undefined
    : native.includes("responses")
      ? { api: "openai-responses" }
      : native.includes("anthropic")
        ? { api: "anthropic-messages", baseUrl: gateway }
        : undefined;
  const efforts = model.efforts ?? [];
  const output = outputLimit(model);
  return {
    id: model.ref,
    name: model.ref,
    ...api,
    reasoning: efforts.length > 0,
    input: model.images ? ["text", "image"] : ["text"],
    ...(efforts.length ? { thinkingLevelMap: thinkingLevels(efforts) } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(output ? { maxTokens: output } : {}),
  };
}

/**
 * Pi's levels mapped to the model's: its own level where it has it, else the
 * nearest one below (the lowest when none is), so every level Pi offers asks
 * for one the model takes. `off` is the model's `none` when it has one and
 * Pi's own behaviour otherwise; `xhigh` and `max`, which Pi offers only when
 * mapped, are mapped only when the model has them. (Magpie hides the other
 * levels with null, which HarnessHub's editors do not write.)
 */
export function thinkingLevels(
  efforts: readonly ReasoningEffort[],
): Record<string, string> {
  const order: readonly string[] = PI_LEVELS;
  const own = efforts.filter((effort) => effort !== "none");
  const map: Record<string, string> = {};
  if (efforts.includes("none")) map.off = "none";
  for (const level of PI_LEVELS.slice(1)) {
    if ((own as readonly string[]).includes(level)) map[level] = level;
    else if (level === "xhigh" || level === "max" || !own.length) continue;
    else
      map[level] =
        own
          .filter((effort) => order.indexOf(effort) < order.indexOf(level))
          .at(-1) ?? own[0]!;
  }
  return map;
}
