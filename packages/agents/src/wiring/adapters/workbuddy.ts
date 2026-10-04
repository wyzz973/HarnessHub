// SPDX-License-Identifier: MIT
import type { ConfigValue } from "../formats/index.js";
import { appOutput, defaultLevel, thinkingLevels } from "./app-levels.js";
import {
  overridable,
  withSelected,
  type AdapterSetting,
  type WiringAdapter,
  type WiringModel,
} from "./types.js";

/** The vendor of HarnessHub's entries, which tells them from the user's own. */
const VENDOR = "harnesshub";

/**
 * WorkBuddy (Tencent's CodeBuddy desktop app) reads models of the user's own
 * from `models.json` in `${WORKBUDDY_CONFIG_DIR:-~/.workbuddy}`, in the
 * object form `{models: [...], availableModels: [...]}`, and picks a change
 * up without a restart. HarnessHub adds one element of `models` per gateway
 * model, `{id: <ref>, vendor: "harnesshub"}` with the gateway's Chat
 * Completions URL, the key, the window and output limit (at most 128000) and
 * the reasoning levels, and owns only those. When the user keeps an
 * `availableModels` list (which limits the picker), HarnessHub's ids are
 * added to it as elements too. The model is picked per task in WorkBuddy's
 * window, so no selection is written. A `models.json` that is a bare list,
 * the other form WorkBuddy reads, is refused: HarnessHub edits documents
 * whose root is an object. Follows Magpie's `workbuddy.go`.
 */
export const workbuddy: WiringAdapter = {
  id: "workbuddy",
  name: "WorkBuddy",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: [],
  files: [
    {
      id: "models",
      format: "json",
      locate: (environment) =>
        overridable(
          environment,
          "WORKBUDDY_CONFIG_DIR",
          [".workbuddy"],
          ["models.json"],
        ),
    },
  ],
  baseUrlField: {
    file: "models",
    path: (model) => [
      "models",
      { match: { id: model, vendor: VENDOR } },
      "url",
    ],
  },
  settings(target, files) {
    const models = withSelected(target.models, target.model);
    const available = files.current("models").availableModels;
    const restricted =
      Array.isArray(available) &&
      available.length > 0 &&
      available.every((item) => typeof item === "string");
    return [
      ...models.map((model): AdapterSetting => ({
        file: "models",
        path: ["models", { match: { id: model.ref, vendor: VENDOR } }],
        value: entry(model, target.baseUrl, target.keyText),
      })),
      ...(restricted
        ? models.map((model): AdapterSetting => ({
            file: "models",
            path: ["availableModels", { equals: model.ref }],
            value: model.ref,
          }))
        : []),
    ];
  },
};

function entry(
  model: WiringModel,
  gateway: string,
  key: string,
): Record<string, ConfigValue> {
  const output = appOutput(model);
  const levels = thinkingLevels(model.efforts ?? []);
  const start = defaultLevel(levels);
  return {
    name: model.ref,
    id: model.ref,
    vendor: VENDOR,
    apiKey: key,
    url: `${gateway}/v1/chat/completions`,
    ...(model.contextWindow ? { maxInputTokens: model.contextWindow } : {}),
    ...(output ? { maxOutputTokens: output } : {}),
    supportsToolCall: true,
    supportsImages: model.images ?? false,
    supportsReasoning: levels.length > 0,
    ...(levels.length && start
      ? {
          reasoning: {
            supportedEfforts: levels,
            canDisableThinking: (model.efforts ?? []).includes("none"),
            defaultEffort: start,
          },
        }
      : {}),
  };
}
