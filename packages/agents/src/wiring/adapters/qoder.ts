// SPDX-License-Identifier: MIT
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import {
  outputLimit,
  overridable,
  withSelected,
  type AdapterTarget,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/** The efforts Qoder takes for a model, in its order. */
const QODER_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Qoder CLI reads `settings.json` in `${QODER_CONFIG_DIR:-~/.qoder}`; Qoder
 * CN, the same CLI for the China site, in `${QODERCN_CONFIG_DIR:-~/.qoder-cn}`.
 * A `harnesshub` entry of `providers` speaks OpenAI Chat Completions to
 * `<gateway>/v1` with the key as `apiKey` and lists the gateway's models;
 * `model.name` selects `harnesshub/<ref>` (Magpie's `qoder.go`). Each model
 * says whether it takes images and which efforts (`capabilities.thinking`);
 * the effort is the chosen model's preference. Qoder
 * offers custom providers only to a signed-in account whose plan includes
 * BYOK; without it the provider is ignored.
 */
export const qoder: WiringAdapter = qoderBuild({
  id: "qoder",
  name: "Qoder",
  variable: "QODER_CONFIG_DIR",
  directory: ".qoder",
  executable: "qodercli",
});

/** Qoder CN: see `qoder`. */
export const qoderCn: WiringAdapter = qoderBuild({
  id: "qoder-cn",
  name: "Qoder CN",
  variable: "QODERCN_CONFIG_DIR",
  directory: ".qoder-cn",
  executable: "qoderclicn",
});

function qoderBuild(build: {
  id: string;
  name: string;
  variable: string;
  directory: string;
  executable: string;
}): WiringAdapter {
  return {
    id: build.id,
    name: build.name,
    protocol: "chat",
    keyDelivery: "config-file",
    executables: [build.executable],
    files: [
      {
        id: "settings",
        format: "json",
        locate: (e) =>
          overridable(e, build.variable, [build.directory], ["settings.json"]),
      },
    ],
    baseUrlField: {
      file: "settings",
      path: ["providers", "harnesshub", "baseUrl"],
    },
    efforts: QODER_EFFORTS,
    settings: qoderSettings,
  };
}

function qoderSettings(target: AdapterTarget): AdapterSetting[] {
  return [
    {
      file: "settings",
      path: ["providers", "harnesshub"],
      value: {
        displayName: "HarnessHub",
        protocol: "openai",
        baseUrl: `${target.baseUrl}/v1`,
        apiKey: target.keyText,
        model: target.model,
        models: withSelected(target.models, target.model).map((model) => {
          const levels = QODER_EFFORTS.filter((effort) =>
            (model.efforts ?? []).includes(effort),
          );
          const output = outputLimit(model);
          return {
            model: model.ref,
            displayName: model.ref,
            capabilities: {
              tools: true,
              vision: model.images ?? false,
              ...(levels.length
                ? {
                    thinking: {
                      modes: ["enabled"],
                      supportsEffort: true,
                      supportedEffortLevels: levels,
                      requiresBudgetForEnabled: false,
                    },
                  }
                : {}),
            },
            ...(model.contextWindow
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(output ? { maxOutputTokens: output } : {}),
          };
        }),
      },
    },
    {
      file: "settings",
      path: ["model", "name"],
      value: `harnesshub/${target.model}`,
    },
    // Each model's effort is its own preference (Qoder 1.1.6x); older Qoders
    // read model.reasoningEffort, which newer ones move into the preference.
    ...(target.effort !== undefined
      ? [
          {
            file: "settings",
            path: [
              "model",
              "preferences",
              `harnesshub/${target.model}`,
              "reasoning",
              "effort",
            ],
            value: target.effort,
          },
          {
            file: "settings",
            path: ["model", "reasoningEffort"],
            value: target.effort,
          },
        ]
      : []),
  ];
}
