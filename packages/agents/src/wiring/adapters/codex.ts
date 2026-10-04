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
 *   to `model_reasoning_effort`. Unless the chosen model's provider takes
 *   Responses natively or the gateway answers web search itself (a search
 *   backend is configured), `web_search = "disabled"` keeps Codex from
 *   sending its hosted web search tool, which the gateway could not
 *   translate (found by running Codex 0.144.5 against a Chat Completions
 *   upstream).
 * - `chatgpt`: the user's ChatGPT sign-in stays as it is and only
 *   `openai_base_url` points Codex's built-in OpenAI provider at
 *   `<gateway>/backend-api/codex/<key>`, which forwards Codex's requests for
 *   its own models, signed in by Codex itself, to ChatGPT, and serves
 *   HarnessHub's models, which it lists after ChatGPT's (Magpie's ChatGPT
 *   mode). That provider takes no header of HarnessHub's, so the key is a
 *   path segment, which the gateway takes out before anything is forwarded
 *   or recorded. Codex keeps its own model unless one is named; a named
 *   model (and effort) goes to `model` (and `model_reasoning_effort`). A
 *   `model_provider` of the user's other than OpenAI bypasses it.
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
  modelOptional: (options) => options.codexAuth === "chatgpt",
  settings(target, files) {
    if (target.options.codexAuth === "chatgpt")
      return [
        {
          file: "config",
          path: ["openai_base_url"],
          value: `${target.baseUrl}${CODEX_BACKEND_PATH}/${target.keyText}`,
        },
        ...(target.ownModel
          ? []
          : [{ file: "config", path: ["model"], value: target.model }]),
        ...(target.effort !== undefined
          ? [
              {
                file: "config",
                path: ["model_reasoning_effort"],
                value: target.effort,
              },
            ]
          : []),
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
      // Codex offers its hosted `web_search` tool to every model. Without
      // a search backend of its own, the gateway can serve it only by
      // passing Responses through to a provider that has it; translated to
      // another protocol, every turn would fail. Web search stays on when
      // the gateway searches itself or the model's provider takes Responses
      // natively.
      ...(target.gatewaySearch ||
      target.selected?.nativeProtocols?.includes("responses")
        ? []
        : [{ file: "config", path: ["web_search"], value: "disabled" }]),
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
