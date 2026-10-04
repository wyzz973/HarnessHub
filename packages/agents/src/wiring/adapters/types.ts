// SPDX-License-Identifier: MIT
import path from "node:path";
import type {
  ModelIdStyle,
  ReasoningEffort,
  WireProtocol,
  WiringTier,
} from "@harnesshub/core/model-plane";
import type {
  ConfigDocument,
  ConfigFormat,
  ConfigValue,
  KeyPath,
} from "../formats/index.js";

/** Metadata of one model the gateway exposes, as `/v1/models` reports it. */
export interface WiringModel {
  /** A Model Ref (`provider/model`) or a route group (`group/<id>`). */
  ref: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Reasoning levels the model takes, lowest first; absent or empty when it has none or they are unknown. */
  efforts?: readonly ReasoningEffort[];
  /** The model accepts image input. */
  images?: boolean;
  /**
   * Protocols the gateway passes through to the model's provider without
   * translating; empty or absent for a route group, whose members may differ.
   */
  nativeProtocols?: readonly WireProtocol[];
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
  /** A model per tier the adapter declares; a tier that is absent follows `model`. */
  tiers: Readonly<Partial<Record<WiringTier, string>>>;
  /** The level the agent starts with, one of the adapter's `efforts`; undefined leaves the agent's own. */
  effort: ReasoningEffort | undefined;
  /** Every option the adapter declares, the default where none was given. */
  options: Readonly<Record<string, string>>;
  /** Whether the gateway answers hosted web search tools itself, for any model. */
  gatewaySearch: boolean;
}

/** The adapter's files as located for this wiring. */
export interface LocatedFiles {
  /** The path of the file with this id; an id the adapter does not declare fails. */
  path(fileId: string): string;
  /**
   * The file's current content, parsed (its `initial` text, or empty, when
   * missing), for a setting that depends on what the user has, such as a
   * list of the user's own that wiring adds to only when it exists. A list
   * only for a file with `arrayRoot`. A file that does not parse fails as it
   * would when planned.
   */
  current(fileId: string): ConfigDocument;
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
  /**
   * A variable of the explicit environment map that is not a directory (a
   * profile name), exactly as given: "" when set empty, undefined when unset.
   */
  variable(name: string): string | undefined;
}

export interface FileLocation {
  /** Paths the agent reads, in its own order of preference; the first existing one is edited. */
  candidates: readonly string[];
  /** The path created when no candidate exists. */
  create: string;
  /** The directory a symlink must not leave: the home, or the override directory. */
  root: string;
  /**
   * Older files the agent moves into `create` only while no candidate
   * exists. While one of them is there and no candidate is, wiring fails with
   * WIRING_UNSUPPORTED_STRUCTURE instead of creating the file, which would
   * stop that migration and hide the older file's entries from the agent.
   */
  migratedFrom?: readonly string[];
}

export interface AdapterFile {
  readonly id: string;
  readonly format: ConfigFormat;
  /**
   * HarnessHub generates the whole file (such as Codex's model catalog), so a
   * preview summarises it instead of showing every line.
   */
  readonly generated?: boolean;
  locate(environment: AdapterEnvironment): FileLocation;
  /**
   * The text a missing file starts from before the settings are applied,
   * for an agent that refuses a file without some entry of its own (such as
   * a schema version); default: empty. Unwire of an unchanged file still
   * deletes it.
   */
  readonly initial?: string;
  /**
   * The file's root may be a list instead of an object (JSON only): its
   * elements are then addressed with an element selector as the first path
   * segment. A missing file is still created as an object.
   */
  readonly arrayRoot?: boolean;
}

/**
 * One entry an adapter owns: set to `value`, or removed (`remove: true`) so
 * that a value of the user's cannot override the wiring. Unwire puts back
 * what was there before either way.
 */
export type AdapterSetting =
  | {
      readonly file: string;
      readonly path: KeyPath;
      readonly value: ConfigValue;
    }
  | { readonly file: string; readonly path: KeyPath; readonly remove: true };

/** Where an adapter keeps the gateway URL: a fixed path, or one per wired model. */
export interface BaseUrlField {
  readonly file: string;
  readonly path:
    KeyPath | ((model: string, document: ConfigDocument) => KeyPath);
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
  /**
   * The setting that holds the gateway URL, for drift classification; a
   * function gives it for the wired model and the file as it is now, for an
   * agent that keeps the URL in each model's own entry.
   */
  readonly baseUrlField: BaseUrlField;
  /** The setting that holds the gateway URL with these options, when it is not `baseUrlField`. */
  baseUrlFieldFor?(options: Readonly<Record<string, string>>): BaseUrlField;
  /** Tiers whose models can differ from the main model; none when absent. */
  readonly tiers?: readonly WiringTier[];
  /** Levels the agent can be set to start with; none when absent. */
  readonly efforts?: readonly ReasoningEffort[];
  /**
   * How the agent's key lists and takes models: `claude-alias` for an agent
   * that keeps only model ids that read as Anthropic's (Claude Desktop), so
   * the gateway shows it each model by an alias. Model Refs when absent.
   */
  readonly modelIdStyle?: ModelIdStyle;
  /** Adapter options and their allowed values; the first value is the default. */
  readonly options?: Readonly<Record<string, readonly string[]>>;
  /**
   * Whether the agent, configured with these options, authenticates by
   * itself: it is then wired without a Gateway Key and without a model, and
   * its settings must not use `keyText` or `model`. Never when absent.
   */
  keyless?(options: Readonly<Record<string, string>>): boolean;
  settings(target: AdapterTarget, files: LocatedFiles): AdapterSetting[];
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

/**
 * The output limit to hand an agent for `model`: never above its window,
 * since some catalogs list a larger output than window. Undefined when the
 * output is unknown.
 */
export function outputLimit(model: WiringModel): number | undefined {
  const { contextWindow, maxOutputTokens } = model;
  return contextWindow !== undefined &&
    maxOutputTokens !== undefined &&
    maxOutputTokens > contextWindow
    ? contextWindow
    : maxOutputTokens;
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
