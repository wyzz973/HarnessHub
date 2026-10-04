// SPDX-License-Identifier: MIT
import {
  overridable,
  withSelected,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/**
 * Grok Build (xAI's `grok` CLI) reads `config.toml` in
 * `${GROK_HOME:-~/.grok}`. Each gateway model becomes its own
 * `[model."harnesshub/<ref>"]` table on Chat Completions at `<gateway>/v1`,
 * each with the key: a model without a key of its own would be sent the
 * user's xAI sign-in. `[models] default` selects the chosen one, and
 * `[features] campaigns = false` stops xAI's remote campaigns from replacing
 * that default (Magpie's `grok.go`).
 */
export const grok: WiringAdapter = {
  id: "grok",
  name: "Grok Build",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["grok"],
  files: [
    {
      id: "config",
      format: "toml",
      locate: (e) => overridable(e, "GROK_HOME", [".grok"], ["config.toml"]),
    },
  ],
  baseUrlField: {
    file: "config",
    path: (model) => ["model", `harnesshub/${model}`, "base_url"],
  },
  settings(target) {
    const tables = withSelected(target.models, target.model).map(
      (model): AdapterSetting => ({
        file: "config",
        path: ["model", `harnesshub/${model.ref}`],
        value: {
          model: model.ref,
          name: model.ref,
          base_url: `${target.baseUrl}/v1`,
          api_key: target.keyText,
          api_backend: "chat_completions",
          ...(model.contextWindow
            ? { context_window: model.contextWindow }
            : {}),
        },
      }),
    );
    return [
      {
        file: "config",
        path: ["models", "default"],
        value: `harnesshub/${target.model}`,
      },
      { file: "config", path: ["features", "campaigns"], value: false },
      ...tables,
    ];
  },
};
