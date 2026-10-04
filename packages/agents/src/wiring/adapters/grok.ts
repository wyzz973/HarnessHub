// SPDX-License-Identifier: MIT
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import {
  overridable,
  withSelected,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/** The reasoning efforts Grok knows, in its order. */
const GROK_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Grok Build (xAI's `grok` CLI) reads `config.toml` in
 * `${GROK_HOME:-~/.grok}`. Each gateway model becomes its own
 * `[model."harnesshub/<ref>"]` table on Chat Completions at `<gateway>/v1`,
 * each with the key: a model without a key of its own would be sent the
 * user's xAI sign-in. `[models] default` selects the chosen one, and
 * `[features] campaigns = false` stops xAI's remote campaigns from replacing
 * that default (Magpie's `grok.go`). A model's known reasoning levels are its
 * `reasoning_efforts`, and the effort sessions start with is
 * `[models] default_reasoning_effort`.
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
  efforts: GROK_EFFORTS,
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
          ...(model.efforts?.length
            ? {
                reasoning_efforts: GROK_EFFORTS.filter((effort) =>
                  model.efforts!.includes(effort),
                ),
              }
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
      // The effort new sessions start with.
      ...(target.effort !== undefined
        ? [
            {
              file: "config",
              path: ["models", "default_reasoning_effort"],
              value: target.effort,
            },
          ]
        : []),
      ...tables,
    ];
  },
};
