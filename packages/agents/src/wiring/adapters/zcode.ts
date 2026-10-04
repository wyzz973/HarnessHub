// SPDX-License-Identifier: MIT
import path from "node:path";
import type { ConfigValue } from "../formats/index.js";
import { getPath } from "../formats/values.js";
import { appOutput, defaultLevel } from "./app-levels.js";
import {
  withSelected,
  type AdapterEnvironment,
  type AdapterSetting,
  type FileLocation,
  type WiringAdapter,
  type WiringModel,
} from "./types.js";

const PROVIDER = "harnesshub";

/**
 * ZCode (Zhipu's desktop app) keeps model providers in `~/.zcode/v2`. Both
 * files are written, so older and newer versions see HarnessHub's models:
 *
 * - `config.json`, OpenCode's provider shape with a `kind`: `provider.harnesshub`
 *   speaks Anthropic Messages at the gateway root, with each model's window,
 *   output limit (at most 128000), input and reasoning levels (`none` is
 *   ZCode's `disabled`).
 * - `provider_config.json` (ZCode 3.14 and later, created with
 *   `schemaVersion: 1`): one element of `config.providerConfigRules.providerRules`
 *   with `providerId: harnesshub`, and one element of
 *   `config.modelConfigRules.providerModelRules` per model, keyed by
 *   `providerId` and `modelId`. Other providers' rules are left alone; a
 *   model with a manual rule of the user's (`manualProviderModelRules`)
 *   gets no rule of HarnessHub's.
 *
 * A provider switched off in ZCode stays off. The model is picked per task
 * in ZCode's window, so no selection is written. Follows Magpie's `zcode.go`.
 */
export const zcode: WiringAdapter = {
  id: "zcode",
  name: "ZCode",
  protocol: "anthropic",
  keyDelivery: "config-file",
  executables: [],
  files: [
    {
      id: "config",
      format: "json",
      locate: (environment) => zcodeFile(environment, "config.json"),
    },
    {
      id: "rules",
      format: "json",
      initial: '{\n  "schemaVersion": 1\n}\n',
      locate: (environment) => zcodeFile(environment, "provider_config.json"),
    },
  ],
  baseUrlField: {
    file: "config",
    path: ["provider", PROVIDER, "options", "baseURL"],
  },
  settings(target, files) {
    const models = withSelected(target.models, target.model);
    const config = files.current("config");
    const rules = files.current("rules");
    const enabled = (current: unknown) => current !== false;
    const manual = getPath(rules, [
      "config",
      "modelConfigRules",
      "manualProviderModelRules",
    ]);
    const byHand = new Set(
      (Array.isArray(manual) ? manual : []).flatMap((rule: unknown) =>
        getPath(rule, ["providerId"]) === PROVIDER &&
        typeof getPath(rule, ["modelId"]) === "string"
          ? [getPath(rule, ["modelId"]) as string]
          : [],
      ),
    );
    const ids = models.map((model) => model.ref);
    return [
      {
        file: "config",
        path: ["provider", PROVIDER],
        value: {
          name: "HarnessHub",
          kind: "anthropic",
          enabled: enabled(getPath(config, ["provider", PROVIDER, "enabled"])),
          source: "custom",
          options: { apiKey: target.keyText, baseURL: target.baseUrl },
          models: Object.fromEntries(
            models.map((model) => [model.ref, providerModel(model)]),
          ),
        },
      },
      {
        file: "rules",
        path: [
          "config",
          "providerConfigRules",
          "providerRules",
          { match: { providerId: PROVIDER } },
        ],
        value: {
          providerId: PROVIDER,
          providerName: "HarnessHub",
          enabled: enabled(
            ruleOf(rules, ["config", "providerConfigRules", "providerRules"])
              ?.enabled,
          ),
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: target.keyText },
            api: { type: "anthropic-messages", baseUrl: target.baseUrl },
            personalModelIds: ids,
            modelOrder: ids,
          },
        },
      },
      ...models
        .filter((model) => !byHand.has(model.ref))
        .map((model): AdapterSetting => ({
          file: "rules",
          path: [
            "config",
            "modelConfigRules",
            "providerModelRules",
            { match: { providerId: PROVIDER, modelId: model.ref } },
          ],
          value: modelRule(model),
        })),
    ];
  },
};

/** ZCode's names for a model's levels: `none` is `disabled`. */
function levelsOf(model: WiringModel): string[] {
  return [
    ...new Set(
      (model.efforts ?? []).map((effort) =>
        effort === "none" ? "disabled" : effort,
      ),
    ),
  ];
}

function providerModel(model: WiringModel): Record<string, ConfigValue> {
  const output = appOutput(model);
  const levels = levelsOf(model);
  const start = defaultLevel(levels);
  return {
    name: model.ref,
    ...(model.contextWindow
      ? {
          limit: {
            context: model.contextWindow,
            ...(output ? { output } : {}),
          },
        }
      : {}),
    modalities: {
      input: model.images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    ...(levels.length && start
      ? {
          reasoning: { enabled: true, variants: levels, defaultVariant: start },
        }
      : {}),
  };
}

function modelRule(model: WiringModel): Record<string, ConfigValue> {
  const output = appOutput(model);
  const levels = levelsOf(model);
  const specs: Record<string, ConfigValue> = {
    ...(output ? { maxOutputTokens: { max: output } } : {}),
    ...(levels.length ? { reasoningLevel: { values: levels } } : {}),
  };
  return {
    providerId: PROVIDER,
    modelId: model.ref,
    config: {
      properties: {
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        inputFormat: { supportsImage: model.images ?? false },
      },
      ...(Object.keys(specs).length ? { optionSpecs: specs } : {}),
    },
  };
}

/** HarnessHub's provider rule as the file holds it now, if any. */
function ruleOf(
  rules: Record<string, unknown>,
  list: string[],
): Record<string, unknown> | undefined {
  const items = getPath(rules, list);
  const found = Array.isArray(items)
    ? (items as unknown[]).find(
        (item) => getPath(item, ["providerId"]) === PROVIDER,
      )
    : undefined;
  return typeof found === "object" && found !== null
    ? (found as Record<string, unknown>)
    : undefined;
}

function zcodeFile(
  environment: AdapterEnvironment,
  name: string,
): FileLocation {
  const file = path.join(environment.home, ".zcode", "v2", name);
  return { candidates: [file], create: file, root: environment.home };
}
