// SPDX-License-Identifier: MIT
import { overridable, withSelected, type WiringAdapter } from "./types.js";

/**
 * Pi reads `settings.json` and `models.json` in
 * `${PI_CODING_AGENT_DIR:-~/.pi/agent}`. A `harnesshub` provider speaks Chat
 * Completions to `<gateway>/v1` with the key as a literal `apiKey`, lists the
 * gateway's models with their known limits, and becomes the default.
 */
export const pi: WiringAdapter = {
  id: "pi",
  name: "Pi",
  protocol: "chat",
  keyDelivery: "config-file",
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
  settings(target) {
    return [
      { file: "settings", path: ["defaultProvider"], value: "harnesshub" },
      { file: "settings", path: ["defaultModel"], value: target.model },
      {
        file: "models",
        path: ["providers", "harnesshub"],
        value: {
          baseUrl: `${target.baseUrl}/v1`,
          api: "openai-completions",
          apiKey: target.keyText,
          models: withSelected(target.models, target.model).map((model) => ({
            id: model.ref,
            name: model.ref,
            reasoning: false,
            input: ["text"],
            ...(model.contextWindow
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(model.maxOutputTokens
              ? { maxTokens: model.maxOutputTokens }
              : {}),
          })),
        },
      },
    ];
  },
};
