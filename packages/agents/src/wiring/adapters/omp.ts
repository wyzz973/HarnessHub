// SPDX-License-Identifier: MIT
import path from "node:path";
import { WiringError } from "../errors.js";
import type { ReasoningEffort } from "@harnesshub/core/model-plane";
import type { ConfigValue } from "../formats/index.js";
import {
  outputLimit,
  withSelected,
  type AdapterEnvironment,
  type FileLocation,
  type WiringAdapter,
  type WiringModel,
} from "./types.js";

/** A profile name omp accepts (pi-utils dirs.ts, normalizeProfileName). */
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * omp (oh-my-pi, a fork of Pi) reads `config.yml` and `models.yml` (or the
 * `.yaml` of each when only that exists) in its agent directory, found as
 * omp finds it (Magpie's `ompDir`): under `~/.omp`, or `~/$PI_CONFIG_DIR`,
 * a profile's `profiles/<name>/agent` for OMP_PROFILE (else PI_PROFILE;
 * `default` is none), else `$PI_CODING_AGENT_DIR`, else `agent`. A
 * `harnesshub` provider in `models.yml` speaks Chat Completions to
 * `<gateway>/v1` with the key as `apiKey` (as a user's own provider does;
 * Magpie's keyless gateway writes `auth: none` instead) and lists the
 * gateway's models with their protocol, image input and thinking levels
 * (`ompModel`); `modelRoles.default` selects `harnesshub/<ref>` and the
 * effort is `defaultThinkingLevel` (`none` is omp's `off`). omp
 * moves an older `models.json` into `models.yml` only while there is none,
 * so wiring refuses to create `models.yml` while that migration is pending.
 */
export const omp: WiringAdapter = {
  id: "omp",
  name: "oh-my-pi",
  protocol: "chat",
  keyDelivery: "config-file",
  executables: ["omp"],
  files: [
    { id: "config", format: "yaml", locate: (e) => ompFile(e, "config") },
    { id: "models", format: "yaml", locate: (e) => ompFile(e, "models") },
  ],
  baseUrlField: {
    file: "models",
    path: ["providers", "harnesshub", "baseUrl"],
  },
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  settings(target) {
    return [
      {
        file: "config",
        path: ["modelRoles", "default"],
        value: `harnesshub/${target.model}`,
      },
      ...(target.effort !== undefined
        ? [
            {
              file: "config",
              path: ["defaultThinkingLevel"],
              value: target.effort === "none" ? "off" : target.effort,
            },
          ]
        : []),
      {
        file: "models",
        path: ["providers", "harnesshub"],
        value: {
          baseUrl: `${target.baseUrl}/v1`,
          api: "openai-completions",
          apiKey: target.keyText,
          models: withSelected(target.models, target.model).map((model) =>
            ompModel(model, target.baseUrl),
          ),
        },
      },
    ];
  },
};

/** The thinking levels omp offers for a model, in its order. */
const OMP_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * One gateway model in `models.yml`, as Magpie's `ompProviderAt` writes it:
 * on the protocol its provider serves natively (Responses, or Anthropic
 * Messages at the gateway root, where omp thinks on a budget), with image
 * input when the model takes images, and its thinking levels. Which omp is
 * installed is not known, and omp before 16.4.0 refuses the whole file over
 * a `max` level, so `max` is never listed: a model whose top level is `max`
 * offers `xhigh` in its place, which the gateway fits to the model.
 */
function ompModel(model: WiringModel, gateway: string): ConfigValue {
  const native = model.nativeProtocols ?? [];
  const api = native.includes("chat")
    ? undefined
    : native.includes("responses")
      ? { api: "openai-responses" }
      : native.includes("anthropic")
        ? { api: "anthropic-messages", baseUrl: gateway }
        : undefined;
  const own = model.efforts ?? [];
  const efforts = OMP_EFFORTS.filter(
    (effort) =>
      own.includes(effort) || (effort === "xhigh" && own.includes("max")),
  );
  const output = outputLimit(model);
  return {
    id: model.ref,
    name: model.ref,
    ...api,
    reasoning: efforts.length > 0,
    ...(model.images ? { input: ["text", "image"] } : {}),
    ...(efforts.length
      ? {
          thinking: {
            mode: api?.api === "anthropic-messages" ? "budget" : "effort",
            efforts,
          },
        }
      : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(output ? { maxTokens: output } : {}),
  };
}

function ompFile(environment: AdapterEnvironment, name: string): FileLocation {
  const { directory, root } = ompDirectory(environment);
  return {
    candidates: [`${name}.yml`, `${name}.yaml`].map((file) =>
      path.join(directory, file),
    ),
    create: path.join(directory, `${name}.yml`),
    root,
    ...(name === "models"
      ? { migratedFrom: [path.join(directory, "models.json")] }
      : {}),
  };
}

function ompDirectory(environment: AdapterEnvironment): {
  directory: string;
  root: string;
} {
  const { home } = environment;
  const configDirectory = environment.variable("PI_CONFIG_DIR");
  // omp joins the variable to the home directory, even an absolute one.
  const base = path.join(home, configDirectory || ".omp");
  const inside = path.relative(home, base);
  if (inside === ".." || inside.startsWith(`..${path.sep}`))
    throw new WiringError(
      "WIRING_CONTEXT_INVALID",
      "PI_CONFIG_DIR must name a directory inside the home directory",
    );
  const profile = (
    environment.variable("OMP_PROFILE") ??
    environment.variable("PI_PROFILE") ??
    ""
  ).trim();
  if (
    profile !== "" &&
    profile !== "default" &&
    PROFILE.test(profile) &&
    !profile.endsWith(".")
  )
    return {
      directory: path.join(base, "profiles", profile, "agent"),
      root: home,
    };
  const override = environment.directory("PI_CODING_AGENT_DIR");
  return override !== undefined
    ? { directory: override, root: override }
    : { directory: path.join(base, "agent"), root: home };
}
