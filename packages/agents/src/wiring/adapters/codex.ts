// SPDX-License-Identifier: MIT
import { codexWiringCatalog } from "../../configuration/codex-models.js";
import type { ConfigValue } from "../formats/index.js";
import { isRecord } from "../formats/values.js";
import {
  overridable,
  withSelected,
  type AdapterSetting,
  type AdapterTarget,
  type WiringAdapter,
} from "./types.js";

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
 *
 * In both modes, as Magpie's Codex wiring does (internal/agent/codex.go):
 *
 * - `[model_providers.harnesshub]` is written, and unwire leaves it in place
 *   without the key: Codex reopens a thread only with the provider it was
 *   started on, so taking the table away would strand those threads.
 * - With a model named, `[agents] default_subagent_model` is the subagent
 *   tier's model, and a subagent model of the user's becomes the wired one;
 *   `default_subagent_reasoning_effort` is the wired effort when that model
 *   takes it, and a level it does not take is removed, as Codex refuses to
 *   start a subagent at such a level.
 * - `[desktop] enabled-reasoning-efforts` gains the levels the listed models
 *   take that the Codex app knows: its picker offers no other. The user's
 *   levels stay; nothing is written when nothing is missing.
 * - CC Switch's provider tables (`custom`, `cc-switch`, `cc-switch-<n>`, not
 *   named by a profile) are pointed at the gateway with the key, as threads
 *   CC Switch moved onto them reopen there, without the relay's headers;
 *   unwire puts their values back.
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
  tiers: ["subagent"],
  restartNotice:
    "Codex reads config.toml and builds its model list at start-up: restart the Codex app and open codex sessions to use this.",
  settings(target, files) {
    const current = files.current("config");
    const config = isRecord(current) ? current : {};
    const shared: AdapterSetting[] = [
      {
        file: "config",
        path: ["model_providers", "harnesshub"],
        value: {
          ...PROVIDER(target.baseUrl),
          experimental_bearer_token: target.keyText,
        },
        keep: PROVIDER(target.baseUrl),
      },
      ...subagentSettings(target, config),
      ...desktopEfforts(target, config),
      ...ccSwitchSettings(target, config),
    ];
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
        ...shared,
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
      ...shared,
      {
        file: "catalog",
        path: ["models"],
        value: catalog.models as ConfigValue,
      },
    ];
  },
};

/** The `harnesshub` provider table without its key: what stays after unwire. */
const PROVIDER = (baseUrl: string) => ({
  name: "HarnessHub",
  base_url: `${baseUrl}/v1`,
  wire_api: "responses",
});

/**
 * `[agents]`, as Magpie keeps it: a subagent tier puts subagents on its
 * model; a subagent model of the user's is replaced by the wired one, as
 * every model now goes where the wiring sends it. The subagent level is the
 * wired effort when that model takes it; otherwise a level that model does
 * not take goes, as Codex refuses to start a subagent at it
 * (core/src/agent/child_config.rs). Unset, subagents follow the session.
 */
function subagentSettings(
  target: AdapterTarget,
  config: Record<string, unknown>,
): AdapterSetting[] {
  if (target.ownModel) return [];
  const agents = isRecord(config.agents) ? config.agents : {};
  const chosen = target.tiers.subagent;
  const mine = agents.default_subagent_model;
  const model = chosen ?? target.model;
  const levels =
    target.models.find((entry) => entry.ref === model)?.efforts ?? [];
  const takes = (level: string) =>
    levels.length === 0 || (levels as readonly string[]).includes(level);
  const level = agents.default_subagent_reasoning_effort;
  const path = (name: string) => ["agents", name];
  return [
    ...(chosen !== undefined || mine !== undefined
      ? [{ file: "config", path: path("default_subagent_model"), value: model }]
      : []),
    // Removed also when none is there, so that a level an earlier wiring
    // removed is not put back by the next one.
    ...(target.effort !== undefined && takes(target.effort)
      ? [
          {
            file: "config",
            path: path("default_subagent_reasoning_effort"),
            value: target.effort,
          },
        ]
      : levels.length > 0 && (typeof level !== "string" || !takes(level))
        ? [
            {
              file: "config",
              path: path("default_subagent_reasoning_effort"),
              remove: true as const,
            },
          ]
        : []),
  ];
}

/** The levels the Codex app knows, in its order (its enabled-reasoning-efforts enum). */
const APP_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
];
/** Those it offers while the setting is unset. */
const APP_EFFORTS_ON = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "persistent",
];

/**
 * `[desktop] enabled-reasoning-efforts` with the levels the listed models
 * take added after the ones there (Magpie #310). Without the setting, only
 * when the app's default offer lacks one of them; with it, always, so that
 * a later wiring keeps what an earlier one added. Nothing when the setting
 * is not a list of names, or no listed model has a level the app knows.
 */
function desktopEfforts(
  target: AdapterTarget,
  config: Record<string, unknown>,
): AdapterSetting[] {
  const desktop = config.desktop;
  if (desktop !== undefined && !isRecord(desktop)) return [];
  const value = isRecord(desktop)
    ? desktop["enabled-reasoning-efforts"]
    : undefined;
  if (
    value !== undefined &&
    !(Array.isArray(value) && value.every((item) => typeof item === "string"))
  )
    return [];
  const needed = APP_EFFORTS.filter((level) =>
    target.models.some((model) =>
      (model.efforts as readonly string[] | undefined)?.includes(level),
    ),
  );
  const on = (value as string[] | undefined) ?? APP_EFFORTS_ON;
  const missing = needed.filter((level) => !on.includes(level));
  if (!needed.length || (value === undefined && !missing.length)) return [];
  return [
    {
      file: "config",
      path: ["desktop", "enabled-reasoning-efforts"],
      value: [...on, ...missing],
    },
  ];
}

/** CC Switch's provider ids; its `cc-switch-official` is its own proxy to OpenAI. */
const CC_SWITCH = /^(custom|cc-switch(-[0-9]+)?)$/;

/**
 * CC Switch's provider tables pointed at the gateway: its base URL with the
 * key as the bearer token, the relay's own authentication removed, and with
 * it the relay's headers (`http_headers`, `env_http_headers`), which may
 * carry its credentials and would go to the gateway instead. They go whole:
 * the TOML editor does not edit inside an inline table, the gateway needs
 * none of them, and unwire puts them back as they were. A table that a
 * profile names is the user's to pick and stays as it is.
 */
function ccSwitchSettings(
  target: AdapterTarget,
  config: Record<string, unknown>,
): AdapterSetting[] {
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : {};
  const profiles = isRecord(config.profiles) ? config.profiles : {};
  const named = new Set(
    Object.values(profiles).flatMap((profile) =>
      isRecord(profile) && typeof profile.model_provider === "string"
        ? [profile.model_provider]
        : [],
    ),
  );
  return Object.entries(providers).flatMap(([id, table]) => {
    if (
      !CC_SWITCH.test(id) ||
      named.has(id) ||
      !isRecord(table) ||
      typeof table.base_url !== "string"
    )
      return [];
    const at = (key: string) => ["model_providers", id, key];
    return [
      { file: "config", path: at("base_url"), value: `${target.baseUrl}/v1` },
      {
        file: "config",
        path: at("experimental_bearer_token"),
        value: target.keyText,
      },
      ...["env_key", "requires_openai_auth", "http_headers", "env_http_headers"]
        .filter((key) => table[key] !== undefined)
        .map((key) => ({
          file: "config",
          path: at(key),
          remove: true as const,
        })),
    ];
  });
}
