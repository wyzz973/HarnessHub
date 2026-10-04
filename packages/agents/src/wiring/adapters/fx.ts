// SPDX-License-Identifier: MIT
import path from "node:path";
import type { ConfigValue } from "../formats/index.js";
import { keyPathV1 } from "./key-path.js";
import { withSelected, type WiringAdapter, type WiringModel } from "./types.js";

/** How many models fx takes in a provider's `model_metadata`; past it fx refuses the whole file. */
const FX_MAX_MODELS = 256;

/**
 * fx (fx.sh, Vercel Labs) keeps its settings in `~/.fx/settings.json`: the
 * provider it talks to under `provider`, each provider's model under
 * `models`, and providers of the user's own under `providers`. HarnessHub
 * adds `providers.harnesshub`, Chat Completions without authentication of
 * fx's own (`auth: {type: "none"}`, so the key goes in the base URL's path,
 * ADR 0033), with the gateway's models as its `model_metadata` (the chosen
 * one first, at most 256: fx refuses more), and selects it with `provider`
 * and `models.harnesshub`. fx sends no effort to a provider of the user's
 * own, so there is none to set. Follows Magpie's `fx.go`.
 */
export const fx: WiringAdapter = {
  id: "fx",
  name: "fx",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["fx"],
  files: [
    {
      id: "settings",
      format: "json",
      locate: (environment) => {
        const file = path.join(environment.home, ".fx", "settings.json");
        return { candidates: [file], create: file, root: environment.home };
      },
    },
  ],
  baseUrlField: {
    file: "settings",
    path: ["providers", "harnesshub", "base_url"],
  },
  settings(target) {
    const listed = withSelected(target.models, target.model);
    const chosen = listed.filter((model) => model.ref === target.model);
    const metadata: Record<string, ConfigValue> = {};
    for (const model of [
      ...chosen,
      ...listed.filter((model) => model.ref !== target.model),
    ].slice(0, FX_MAX_MODELS))
      metadata[model.ref] = fxModel(model);
    return [
      {
        file: "settings",
        path: ["providers", "harnesshub"],
        value: {
          protocol: "openai-chat-completions",
          base_url: keyPathV1(target),
          auth: { type: "none" },
          tool_choice_mode: "send",
          model_metadata: metadata,
        },
      },
      { file: "settings", path: ["provider"], value: "harnesshub" },
      {
        file: "settings",
        path: ["models", "harnesshub"],
        value: target.model,
      },
    ];
  },
};

function fxModel(model: WiringModel): ConfigValue {
  const { contextWindow: window, maxOutputTokens: output } = model;
  return {
    supports_tool_use: true,
    supports_vision: model.images ?? false,
    ...(window ? { context_window: window } : {}),
    // fx refuses an output limit that is not below the window.
    ...(output && (!window || output < window)
      ? { max_output_tokens: output }
      : {}),
  };
}
