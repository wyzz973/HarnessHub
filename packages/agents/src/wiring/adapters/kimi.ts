// SPDX-License-Identifier: MIT
import { WiringError } from "../errors.js";
import {
  overridable,
  withSelected,
  type AdapterSetting,
  type WiringAdapter,
} from "./types.js";

/**
 * Kimi Code reads `config.toml` in `${KIMI_SHARE_DIR:-~/.kimi}`. A
 * `harnesshub` provider of type `openai_legacy` (Chat Completions) serves one
 * `models."<ref>"` entry per gateway model whose window is known, since Kimi
 * requires `max_context_size`; the chosen model becomes `default_model` and
 * must therefore have a known window. Kimi lets OPENAI_BASE_URL and
 * OPENAI_API_KEY in its environment override this provider's values.
 */
export const kimi: WiringAdapter = {
  id: "kimi",
  name: "Kimi Code",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["kimi"],
  files: [
    {
      id: "config",
      format: "toml",
      locate: (e) =>
        overridable(e, "KIMI_SHARE_DIR", [".kimi"], ["config.toml"]),
    },
  ],
  baseUrlField: {
    file: "config",
    path: ["providers", "harnesshub", "base_url"],
  },
  settings(target) {
    if (!target.selected?.contextWindow)
      throw new WiringError(
        "WIRING_TARGET_INVALID",
        "Kimi Code needs the context window of the chosen model",
      );
    const models = withSelected(target.models, target.model).flatMap(
      (model): AdapterSetting[] =>
        model.contextWindow
          ? [
              {
                file: "config",
                path: ["models", model.ref],
                value: {
                  provider: "harnesshub",
                  model: model.ref,
                  max_context_size: model.contextWindow,
                },
              },
            ]
          : [],
    );
    return [
      { file: "config", path: ["default_model"], value: target.model },
      {
        file: "config",
        path: ["providers", "harnesshub"],
        value: {
          type: "openai_legacy",
          base_url: `${target.baseUrl}/v1`,
          api_key: target.keyText,
        },
      },
      ...models,
    ];
  },
};
