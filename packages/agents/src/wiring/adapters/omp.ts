// SPDX-License-Identifier: MIT
import path from "node:path";
import { WiringError } from "../errors.js";
import {
  withSelected,
  type AdapterEnvironment,
  type FileLocation,
  type WiringAdapter,
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
 * gateway's models; `modelRoles.default` selects `harnesshub/<ref>`. omp
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
  settings(target) {
    return [
      {
        file: "config",
        path: ["modelRoles", "default"],
        value: `harnesshub/${target.model}`,
      },
      {
        file: "models",
        path: ["providers", "harnesshub"],
        value: {
          baseUrl: `${target.baseUrl}/v1`,
          api: "openai-completions",
          apiKey: target.keyText,
          models: withSelected(target.models, target.model).map((model) => ({
            id: model.ref,
            name: model.ref,
            reasoning: false,
            ...(model.contextWindow
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(model.maxOutputTokens
              ? { maxTokens: model.maxOutputTokens }
              : {}),
          })),
        },
      },
    ];
  },
};

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
