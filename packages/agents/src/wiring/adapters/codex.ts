// SPDX-License-Identifier: MIT
import { overridable, type WiringAdapter } from "./types.js";

/**
 * Codex reads `config.toml` in `${CODEX_HOME:-~/.codex}`. Wiring selects a
 * `harnesshub` model provider that speaks Responses to `<gateway>/v1` with
 * the key as its bearer token (Codex has no dotenv file of its own that 04
 * relies on, so the key is in the file). A ChatGPT login is left alone. The
 * window goes to `model_context_window`; Codex's own model catalog file is
 * not generated yet.
 */
export const codex: WiringAdapter = {
  id: "codex",
  name: "Codex CLI",
  protocol: "responses",
  keyDelivery: "config-file",
  executables: ["codex"],
  files: [
    {
      id: "config",
      format: "toml",
      locate: (environment) =>
        overridable(environment, "CODEX_HOME", [".codex"], ["config.toml"]),
    },
  ],
  baseUrlField: {
    file: "config",
    path: ["model_providers", "harnesshub", "base_url"],
  },
  settings(target) {
    const contextWindow = target.selected?.contextWindow;
    return [
      { file: "config", path: ["model_provider"], value: "harnesshub" },
      { file: "config", path: ["model"], value: target.model },
      ...(contextWindow
        ? [
            {
              file: "config",
              path: ["model_context_window"],
              value: contextWindow,
            },
          ]
        : []),
      {
        file: "config",
        path: ["model_providers", "harnesshub"],
        value: {
          name: "HarnessHub",
          base_url: `${target.baseUrl}/v1`,
          wire_api: "responses",
          experimental_bearer_token: target.keyText,
        },
      },
    ];
  },
};
