// SPDX-License-Identifier: MIT
import path from "node:path";
import type { ConfigValue } from "../formats/index.js";
import {
  outputLimit,
  withSelected,
  type AdapterEnvironment,
  type FileLocation,
  type WiringAdapter,
  type WiringModel,
} from "./types.js";

/** How every id of a HarnessHub custom model begins; Droid picks one as this plus its Model Ref. */
const ID = "custom:harnesshub/";

/**
 * Factory's Droid reads `settings.json` in `${FACTORY_HOME_OVERRIDE:-~}/.factory`.
 * Models of the user's own are the `customModels` array; HarnessHub adds one
 * element per gateway model, `id: "custom:harnesshub/<ref>"`, and owns only
 * those: the user's entries keep their place and order, ours are updated in
 * place and removed on unwire. Each model is asked on the protocol its
 * provider serves natively, so the gateway passes it through: Chat as
 * `generic-chat-completion-api` at `<gateway>/v1`, Responses as `openai`,
 * Anthropic Messages as `anthropic` at the gateway root (the Anthropic SDK
 * adds `/v1`). `sessionDefaultSettings.model` selects the chosen model.
 * Follows Magpie's `droid.go`.
 */
export const droid: WiringAdapter = {
  id: "droid",
  name: "Droid",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["droid"],
  files: [{ id: "settings", format: "json", locate: droidFile }],
  baseUrlField: {
    file: "settings",
    path: (model) => ["customModels", { match: { id: ID + model } }, "baseUrl"],
  },
  settings(target) {
    return [
      ...withSelected(target.models, target.model).map((model) => ({
        file: "settings",
        path: ["customModels", { match: { id: ID + model.ref } }],
        value: entry(model, target.baseUrl, target.keyText),
      })),
      {
        file: "settings",
        path: ["sessionDefaultSettings", "model"],
        value: ID + target.model,
      },
    ];
  },
};

function entry(
  model: WiringModel,
  gateway: string,
  key: string,
): Record<string, ConfigValue> {
  const native = model.nativeProtocols ?? [];
  const [provider, baseUrl] = native.includes("chat")
    ? ["generic-chat-completion-api", `${gateway}/v1`]
    : native.includes("responses")
      ? ["openai", `${gateway}/v1`]
      : native.includes("anthropic")
        ? ["anthropic", gateway]
        : ["generic-chat-completion-api", `${gateway}/v1`];
  const output = outputLimit(model);
  return {
    model: model.ref,
    id: ID + model.ref,
    displayName: model.ref,
    baseUrl,
    apiKey: key,
    provider,
    ...(model.contextWindow ? { maxContextLimit: model.contextWindow } : {}),
    ...(output ? { maxOutputTokens: output } : {}),
    // Droid takes a Chat Completions model for one without images unless told.
    noImageSupport: !model.images,
  };
}

function droidFile(environment: AdapterEnvironment): FileLocation {
  const base = environment.directory("FACTORY_HOME_OVERRIDE");
  const file = path.join(base ?? environment.home, ".factory", "settings.json");
  return { candidates: [file], create: file, root: base ?? environment.home };
}
