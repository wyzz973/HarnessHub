// SPDX-License-Identifier: MIT
import type { ConfigValue } from "../formats/index.js";
import { overridable, withSelected, type WiringAdapter } from "./types.js";

/**
 * MiniMax Code (the `mcode` CLI and the desktop app on the same runtime)
 * reads `config.yaml` in `${MINIMAX_DATA_DIR:-~/.minimax}`. A
 * `custom_provider.harnesshub` entry speaks Anthropic Messages to the gateway
 * root (the SDK appends `/v1/messages`) with the key as `options.apiKey`, and
 * lists the gateway's models with their known limits; `defaultModel` selects
 * `custom_provider:harnesshub/<ref>` (Magpie's `minimax.go`). Magpie's
 * User-Agent header is left out: the agent-scoped key names the caller.
 */
export const minimaxCode: WiringAdapter = {
  id: "minimax-code",
  name: "MiniMax Code",
  protocol: "anthropic",
  keyDelivery: "config-file",
  executables: ["mcode"],
  files: [
    {
      id: "config",
      format: "yaml",
      locate: (e) =>
        overridable(e, "MINIMAX_DATA_DIR", [".minimax"], ["config.yaml"]),
    },
  ],
  baseUrlField: {
    file: "config",
    path: ["custom_provider", "harnesshub", "options", "baseURL"],
  },
  settings(target) {
    const models: Record<string, ConfigValue> = {};
    for (const model of withSelected(target.models, target.model)) {
      const limit = {
        ...(model.contextWindow ? { context: model.contextWindow } : {}),
        ...(model.maxOutputTokens ? { output: model.maxOutputTokens } : {}),
      };
      models[model.ref] = {
        name: model.ref,
        ...(Object.keys(limit).length ? { limit } : {}),
        reasoning: false,
      };
    }
    return [
      {
        file: "config",
        path: ["custom_provider", "harnesshub"],
        value: {
          name: "HarnessHub",
          kind: "custom",
          enabled: true,
          api: "anthropic-messages",
          options: {
            apiKey: target.keyText,
            baseURL: target.baseUrl,
            authMode: "api-key",
          },
          models,
        },
      },
      {
        file: "config",
        path: ["defaultModel"],
        value: `custom_provider:harnesshub/${target.model}`,
      },
    ];
  },
};
