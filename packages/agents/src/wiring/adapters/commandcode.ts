// SPDX-License-Identifier: MIT
import path from "node:path";
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import type { ConfigValue } from "../formats/index.js";
import { keyPathV1 } from "./key-path.js";
import {
  withSelected,
  type AdapterEnvironment,
  type AdapterSetting,
  type FileLocation,
  type WiringAdapter,
} from "./types.js";

/** The reasoning levels Command Code knows, in its order. */
const COMMAND_CODE_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Command Code (commandcode.ai) keeps its settings in
 * `~/.commandcode/settings.json`, the model as `provider/model`, and takes
 * providers of the user's own from `~/.commandcode/providers.json`.
 * HarnessHub adds `provider.harnesshub` there, Chat Completions with the
 * gateway's models and the reasoning levels each has; Command Code refuses
 * a key written into the file (`apiKey` stays `false`), so the key goes in
 * the base URL's path (ADR 0033). `model` is `harnesshub/<ref>`, which
 * Command Code splits at the first `/`, with `modelProvider`, and the
 * effort is that model's entry of `reasoningEffort`, which keeps one per
 * model. Command Code still asks for its own sign-in (`cmd login`) and
 * reads its settings at start-up. Follows Magpie's `commandcode.go`.
 */
export const commandcode: WiringAdapter = {
  id: "commandcode",
  name: "Command Code",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["command-code"],
  files: [
    {
      id: "providers",
      format: "json",
      locate: (e) => commandCodeFile(e, "providers.json"),
    },
    {
      id: "settings",
      format: "json",
      locate: (e) => commandCodeFile(e, "settings.json"),
    },
  ],
  baseUrlField: {
    file: "providers",
    path: ["provider", "harnesshub", "baseURL"],
  },
  efforts: COMMAND_CODE_EFFORTS,
  settings(target) {
    const models: Record<string, ConfigValue> = {};
    for (const model of withSelected(target.models, target.model)) {
      const levels = COMMAND_CODE_EFFORTS.filter((effort) =>
        (model.efforts ?? []).includes(effort),
      );
      models[model.ref] = {
        name: model.ref,
        ...(levels.length ? { reasoning: true, reasoningEfforts: levels } : {}),
      };
    }
    const selection = `harnesshub/${target.model}`;
    const settings: AdapterSetting[] = [
      {
        file: "providers",
        path: ["provider", "harnesshub"],
        value: {
          name: "HarnessHub",
          api: "openai-completions",
          baseURL: keyPathV1(target),
          apiKey: false,
          models,
        },
      },
      { file: "settings", path: ["model"], value: selection },
      { file: "settings", path: ["modelProvider"], value: "harnesshub" },
    ];
    if (target.effort !== undefined)
      settings.push({
        file: "settings",
        path: ["reasoningEffort", selection],
        value: target.effort,
      });
    return settings;
  },
};

function commandCodeFile(
  environment: AdapterEnvironment,
  name: string,
): FileLocation {
  const file = path.join(environment.home, ".commandcode", name);
  return { candidates: [file], create: file, root: environment.home };
}
