// SPDX-License-Identifier: MIT
import { codexWiringCatalog } from "../../configuration/codex-models.js";
import type { ConfigValue } from "../formats/index.js";
import { overridable, withSelected, type WiringAdapter } from "./types.js";

/** Where the gateway forwards Codex's own ChatGPT-backend requests as they are. */
export const CODEX_BACKEND_PATH = "/backend-api/codex";

/**
 * Codex reads `config.toml` in `${CODEX_HOME:-~/.codex}`. Two modes, chosen
 * by the `codexAuth` option:
 *
 * - `gateway-key` (default): a `harnesshub` model provider speaks Responses
 *   to `<gateway>/v1` with the key as its bearer token and becomes
 *   `model_provider`; `model_catalog_json` names `harnesshub-models.json`
 *   next to the configuration, which HarnessHub generates with every listed
 *   model's window, reasoning levels and image input (Codex reads its model
 *   metadata from there, as Magpie's codexcat writes it), and the effort goes
 *   to `model_reasoning_effort`.
 * - `chatgpt`: the user's ChatGPT sign-in stays as it is and only
 *   `openai_base_url` points Codex's built-in OpenAI provider at
 *   `<gateway>/backend-api/codex`, which forwards Codex's requests, signed in
 *   by Codex itself, to ChatGPT. No key is written and Codex keeps its own
 *   models. A `model_provider` of the user's other than OpenAI bypasses it.
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
    {
      id: "catalog",
      format: "json",
      generated: true,
      locate: (environment) =>
        overridable(
          environment,
          "CODEX_HOME",
          [".codex"],
          ["harnesshub-models.json"],
        ),
    },
  ],
  baseUrlField: {
    file: "config",
    path: ["model_providers", "harnesshub", "base_url"],
  },
  baseUrlFieldFor: (options) =>
    options.codexAuth === "chatgpt"
      ? { file: "config", path: ["openai_base_url"] }
      : codex.baseUrlField,
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  options: { codexAuth: ["gateway-key", "chatgpt"] },
  keyless: (options) => options.codexAuth === "chatgpt",
  settings(target, files) {
    if (target.options.codexAuth === "chatgpt")
      return [
        {
          file: "config",
          path: ["openai_base_url"],
          value: `${target.baseUrl}${CODEX_BACKEND_PATH}`,
        },
      ];
    const catalog = codexWiringCatalog(
      withSelected(target.models, target.model).map((model) => ({
        slug: model.ref,
        ...(model.contextWindow !== undefined
          ? { contextWindow: model.contextWindow }
          : {}),
        efforts: model.efforts ?? [],
        images: model.images ?? false,
      })),
    );
    return [
      { file: "config", path: ["model_provider"], value: "harnesshub" },
      { file: "config", path: ["model"], value: target.model },
      {
        file: "config",
        path: ["model_catalog_json"],
        value: files.path("catalog"),
      },
      ...(target.effort !== undefined
        ? [
            {
              file: "config",
              path: ["model_reasoning_effort"],
              value: target.effort,
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
      {
        file: "catalog",
        path: ["models"],
        value: catalog.models as ConfigValue,
      },
    ];
  },
};
