// SPDX-License-Identifier: MIT
import path from "node:path";
import type { WireProtocol } from "@harnesshub/core/model-plane";
import type { ConfigFormat, ConfigValue, KeyPath } from "../formats/index.js";

/** Metadata of one model the gateway exposes, as `/v1/models` reports it. */
export interface WiringModel {
  /** A Model Ref (`provider/model`) or a route group (`group/<id>`). */
  ref: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** What an adapter writes, after validation. */
export interface AdapterTarget {
  /** The gateway origin without a trailing slash, such as `http://127.0.0.1:3180`. */
  baseUrl: string;
  keyText: string;
  model: string;
  models: readonly WiringModel[];
  /** The metadata of `model`, when the gateway knows it. */
  selected: WiringModel | undefined;
}

/** Where an adapter's files live on this machine. */
export interface AdapterEnvironment {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /**
   * An agent directory override from the explicit environment map, or
   * undefined when it is unset or empty. A relative value fails with
   * WIRING_CONTEXT_INVALID.
   */
  directory(name: string): string | undefined;
}

export interface FileLocation {
  /** Paths the agent reads, in its own order of preference; the first existing one is edited. */
  candidates: readonly string[];
  /** The path created when no candidate exists. */
  create: string;
  /** The directory a symlink must not leave: the home, or the override directory. */
  root: string;
}

export interface AdapterFile {
  readonly id: string;
  readonly format: ConfigFormat;
  locate(environment: AdapterEnvironment): FileLocation;
}

export interface AdapterSetting {
  readonly file: string;
  readonly path: KeyPath;
  readonly value: ConfigValue;
}

/**
 * How one agent is wired globally: the files it reads and the values that
 * point it at the gateway. Settings name only entries that HarnessHub owns
 * or that select the gateway; an object value replaces that entry entirely,
 * so it must be HarnessHub's own (such as `provider.harnesshub`).
 */
export interface WiringAdapter {
  readonly id: string;
  readonly name: string;
  /** The protocol the agent speaks to the gateway. */
  readonly protocol: WireProtocol;
  /** Whether the key is written into the agent's configuration or into the dotenv file the agent loads itself. */
  readonly keyDelivery: "config-file" | "env-file";
  /** Command names looked up on PATH to tell whether the agent is installed; never run. */
  readonly executables: readonly string[];
  readonly files: readonly AdapterFile[];
  /** The setting that holds the gateway URL, for drift classification. */
  readonly baseUrlField: { readonly file: string; readonly path: KeyPath };
  settings(target: AdapterTarget): AdapterSetting[];
}

/**
 * A location under `${variable:-<home>/<fallback...>}`. `names` are the file
 * names the agent reads, most preferred first; `create` is the one created
 * when none exists (default: the first).
 */
export function overridable(
  environment: AdapterEnvironment,
  variable: string,
  fallback: readonly string[],
  names: readonly string[],
  create: string = names[0]!,
): FileLocation {
  const override = environment.directory(variable);
  const directory = override ?? path.join(environment.home, ...fallback);
  return {
    candidates: names.map((name) => path.join(directory, name)),
    create: path.join(directory, create),
    root: override ?? environment.home,
  };
}

/** The listed models, plus the selected one when the list lacks it. */
export function withSelected(
  models: readonly WiringModel[],
  selected: string,
): WiringModel[] {
  return models.some((model) => model.ref === selected)
    ? [...models]
    : [...models, { ref: selected }];
}
