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

/** The variable dsh resolves the key from: its `.env` holds it. */
const KEY_VARIABLE = "HARNESSHUB_GATEWAY_KEY";

/** dsh's thinking levels (pi-ai's), in its order, with the effort each asks for. */
const LEVELS: ReadonlyArray<readonly [string, ReasoningEffort]> = [
  ["off", "none"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
];

/**
 * DeepSeek Harness (dsh) 0.1.5 keeps the user's settings in
 * `${DSH_HOME:-~/.dsh}/settings.yaml`, one section per namespace, read live
 * and layered over the profile's patch lists (whose entries are only the
 * base of each section). HarnessHub adds a custom provider there,
 * `llm-pi-ai.providers.harnesshub`, as dsh's Models page does: Chat
 * Completions at `<gateway>/v1`, the key named by `apiKeyEnv` and kept in
 * dsh's `.env` (dsh takes the process environment and its own credential
 * store first), and the gateway's models with their window, output limit,
 * image input and `reasoningEfforts` (dsh's levels to the effort each asks
 * for; `false` for a model without levels). `agent-default-model` selects
 * the model new sessions start on, with the effort as its `reasoningEffort`
 * (`off` for none). A model picked in dsh afterwards replaces that entry,
 * which is drift: unlike Magpie, which rewrites dsh's patch lists every 30
 * seconds, HarnessHub leaves the file to the user until wired again.
 */
export const dsh: WiringAdapter = {
  id: "dsh",
  name: "DeepSeek Harness",
  protocol: "chat",
  keyDelivery: "env-file",
  executables: ["dsh"],
  files: [
    {
      id: "settings",
      format: "yaml",
      locate: (e) => overridable(e, "DSH_HOME", [".dsh"], ["settings.yaml"]),
    },
    {
      id: "env",
      format: "dotenv",
      locate: (e) => overridable(e, "DSH_HOME", [".dsh"], [".env"]),
    },
  ],
  baseUrlField: {
    file: "settings",
    path: ["llm-pi-ai", "providers", "harnesshub", "baseURL"],
  },
  efforts: LEVELS.map(([, effort]) => effort),
  settings(target) {
    const level = LEVELS.find(([, effort]) => effort === target.effort)?.[0];
    return [
      {
        file: "settings",
        path: ["llm-pi-ai", "providers", "harnesshub"],
        value: {
          displayName: "HarnessHub",
          apiKeyEnv: KEY_VARIABLE,
          api: "openai-completions",
          baseURL: `${target.baseUrl}/v1`,
          models: withSelected(target.models, target.model).map(dshModel),
        },
      },
      {
        file: "settings",
        path: ["agent-default-model"],
        value: {
          provider: "harnesshub",
          model: target.model,
          ...(level !== undefined ? { reasoningEffort: level } : {}),
        },
      },
      { file: "env", path: [KEY_VARIABLE], value: target.keyText },
    ];
  },
};

/** One gateway model as dsh's route lists it. */
function dshModel(model: WiringModel): ConfigValue {
  const efforts = model.efforts ?? [];
  const levels = Object.fromEntries(
    LEVELS.filter(([, effort]) => efforts.includes(effort)),
  );
  const output = outputLimit(model);
  return {
    id: model.ref,
    name: model.ref,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(output ? { maxTokens: output } : {}),
    ...(model.images !== undefined
      ? { input: model.images ? ["text", "image"] : ["text"] }
      : {}),
    // dsh refuses a model that offers off alone.
    reasoningEfforts: Object.keys(levels).some((level) => level !== "off")
      ? levels
      : false,
  };
}
