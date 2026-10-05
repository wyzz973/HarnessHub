// SPDX-License-Identifier: MIT
import type {
  ConfigDocument,
  ConfigValue,
  PathSegment,
} from "../formats/index.js";
import { getPath } from "../formats/values.js";
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
 * object form `{models: [...], availableModels: [...]}` or as a bare list of
 * models, and picks a change up without a restart. HarnessHub adds one
 * element per gateway model, `{id: <ref>, vendor: "harnesshub"}` with the
 * gateway's Chat Completions URL, the key, the window and output limit (at
 * most 128000) and the reasoning levels, to `models` or to the bare list,
 * keeping the form the file has (a new file takes the object form), and
 * owns only those. When the user keeps an `availableModels` list (which
 * limits the picker), HarnessHub's ids are added to it as elements too. The
 * model is picked per task in WorkBuddy's window, so no selection is
 * written. Follows Magpie's `workbuddy.go`.
 */
export const workbuddy: WiringAdapter = {
  id: "workbuddy",
  restartNotice: null,
  name: "WorkBuddy",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: [],
  files: [
    {
      id: "models",
      format: "json",
      arrayRoot: true,
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
    path: (model, document) => [...entryPath(model, document), "url"],
  },
  settings(target, files) {
    const models = withSelected(target.models, target.model);
    const document = files.current("models");
    const available = getPath(document, ["availableModels"]);
    const restricted =
      Array.isArray(available) &&
      available.length > 0 &&
      available.every((item) => typeof item === "string");
    return [
      ...models.map((model): AdapterSetting => ({
        file: "models",
        path: entryPath(model.ref, document),
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

/** HarnessHub's element for `model` in `models`, or in the file itself when it is a bare list. */
function entryPath(model: string, document: ConfigDocument): PathSegment[] {
  const element = { match: { id: model, vendor: VENDOR } };
  return Array.isArray(document) ? [element] : ["models", element];
}

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
