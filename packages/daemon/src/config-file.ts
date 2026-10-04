// SPDX-License-Identifier: MIT
/**
 * The daemon's configuration file, `<configDir>/config.jsonc` (07-data-security
 * section 1), resolved in one place for `hh serve` and `hh config`. Every
 * setting has a key path; its value comes from the first of a command-line
 * flag, a documented environment variable, the file and the default. The
 * file is JSON with comments, edited in place so comments survive; it never
 * holds secrets.
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HubError } from "@harnesshub/core/errors";
import { editors } from "@harnesshub/agents/wiring/formats/index";
import { resolveCatalogSettings } from "@harnesshub/gateway/catalog-refresh";
import { resolveHandlerLimits } from "@harnesshub/gateway/limits";
import type { SecretBackendSetting } from "@harnesshub/secrets/secret-store";
import { resolveWiringSettings } from "./agents-wiring.js";
import { resolveOtlpConfig } from "./otlp-export.js";

/**
 * The platform's HarnessHub config root (07-data-security section 1): macOS
 * `~/Library/Application Support/HarnessHub/config`, Windows
 * `%LOCALAPPDATA%\HarnessHub\config`, elsewhere `$XDG_CONFIG_HOME/harnesshub`
 * (an absolute XDG value only) or `~/.config/harnesshub`.
 */
export function defaultConfigDir(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "HarnessHub",
      "config",
    );
  if (platform === "win32")
    return path.win32.join(
      environment.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      "HarnessHub",
      "config",
    );
  const xdg = environment.XDG_CONFIG_HOME;
  return path.join(
    xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"),
    "harnesshub",
  );
}

/** The configuration file's name in the config root. */
export const CONFIG_FILE = "config.jsonc";

/** Where a setting's value came from. */
export type ConfigSource =
  | { kind: "default" }
  | { kind: "file" }
  | { kind: "env"; name: string }
  | { kind: "flag"; name: string };

/** One setting the file may hold. */
interface Setting {
  /** Dot-separated key path in the file. */
  path: string;
  description: string;
  /** The value as `startHub` takes it, or a message saying why it is not one. */
  check(value: unknown): { value: unknown } | { error: string };
  /** The command-line flag of `hh serve` that sets it, and how its text reads. */
  flag?: { name: string; parse(text: string, cwd: string): unknown };
  /** A documented environment variable that sets it, when set. */
  env?: { name: string; read(text: string): unknown };
  /** The value when nothing sets it; absent means unset. */
  fallback?: unknown;
  /** An object whose own keys the setting's resolver checks (`gateway.limits`, `otlp`). */
  open?: boolean;
}

const secretBackends = ["auto", "keychain", "dpapi", "file"] as const;

const ok = (value: unknown) => ({ value });
const fail = (error: string) => ({ error });

function absolutePath(value: unknown): { value: unknown } | { error: string } {
  return typeof value === "string" && value !== "" && path.isAbsolute(value)
    ? ok(path.normalize(value))
    : fail("must be an absolute path");
}

function pathFlag(text: string, cwd: string): string {
  return path.resolve(cwd, text);
}

const SETTINGS: readonly Setting[] = [
  {
    path: "server.host",
    description: "Address hh serve listens on",
    check: (value) =>
      typeof value === "string" && /^[A-Za-z0-9.:[\]-]{1,253}$/.test(value)
        ? ok(value)
        : fail("must be a host name or IP address"),
    flag: { name: "--host", parse: (text) => text },
    fallback: "127.0.0.1",
  },
  {
    path: "server.port",
    description: "Port hh serve listens on (0 picks a free one)",
    check: (value) =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 65_535
        ? ok(value)
        : fail("must be an integer from 0 to 65535"),
    flag: { name: "--port", parse: (text) => Number(text) },
    fallback: 3180,
  },
  {
    path: "dataDir",
    description: "Data root: database, backups, logs",
    check: absolutePath,
    flag: { name: "--data-dir", parse: pathFlag },
    fallback: "./data",
  },
  {
    path: "engines.configFile",
    description: "Engine registry file (YAML) of hh serve",
    check: absolutePath,
    flag: { name: "--config", parse: pathFlag },
  },
  {
    path: "engines.default",
    description: "Engine new Sessions use when they name none",
    check: (value) =>
      typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
        ? ok(value)
        : fail("must be an engine id"),
    flag: { name: "--engine", parse: (text) => text },
    env: { name: "AGENT_ENGINE", read: (text) => text },
  },
  {
    path: "secrets.backend",
    description: "Backend for new managed secrets",
    check: (value) =>
      typeof value === "string" &&
      (secretBackends as readonly string[]).includes(value)
        ? ok(value)
        : fail(`must be one of ${secretBackends.join(", ")}`),
    flag: { name: "--secrets-backend", parse: (text) => text },
    fallback: "auto",
  },
  {
    path: "toolPackages.root",
    description:
      "Installed Tool Package root (default <dataDir>/tool-packages)",
    check: absolutePath,
    flag: { name: "--tool-package-root", parse: pathFlag },
  },
  {
    path: "harnessModel.file",
    description: "Unified-model file (default <dataDir>/harness-model.json)",
    check: absolutePath,
    flag: { name: "--harness-model-file", parse: pathFlag },
  },
  {
    path: "catalog.autoRefresh",
    description: "Refresh the models.dev catalog in the background",
    check: (value) =>
      typeof value === "boolean" ? ok(value) : fail("must be true or false"),
    env: {
      name: "HH_OFFLINE",
      read: (text) => (text === "1" ? false : undefined),
    },
    fallback: true,
  },
  {
    path: "catalog.url",
    description: "Where the catalog is fetched from",
    check: (value) => {
      try {
        resolveCatalogSettings({ url: value }, {});
        return ok(value);
      } catch {
        return fail(
          "must be an HTTPS URL (HTTP only on loopback) without credentials",
        );
      }
    },
  },
  {
    path: "wiring.autoSync",
    description:
      "Rewrite wired agents' model lists when the gateway's models change",
    check: (value) =>
      typeof value === "boolean" ? ok(value) : fail("must be true or false"),
    fallback: true,
  },
  {
    path: "wiring.home",
    description: "Home directory whose agents global wiring edits",
    check: absolutePath,
    flag: { name: "--wiring-home", parse: pathFlag },
  },
  {
    path: "gateway.limits",
    description: "Overrides of the model gateway's limits",
    open: true,
    check: (value) => {
      try {
        resolveHandlerLimits(value);
        return ok(value);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    path: "otlp",
    description: "OTLP export of committed model calls (off when absent)",
    open: true,
    // hh serve reads the file named by --otlp-config and passes its text.
    flag: {
      name: "--otlp-config",
      parse: (text) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return Symbol("unparseable");
        }
      },
    },
    check: (value) => {
      try {
        resolveOtlpConfig(value);
        return ok(value);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  },
];

/** The settings' key paths, in the order `hh config show` lists them. */
export const CONFIG_PATHS: readonly string[] = SETTINGS.map(
  (setting) => setting.path,
);

/** The command-line flags `hh serve` reads into the configuration. */
export const CONFIG_FLAGS: readonly string[] = SETTINGS.flatMap((setting) =>
  setting.flag ? [setting.flag.name] : [],
);

/** One resolved setting. */
export interface ConfigEntry {
  path: string;
  description: string;
  /** Undefined when nothing sets it and it has no default. */
  value: unknown;
  source: ConfigSource;
}

/** The configuration as `hh serve` uses it. */
export interface ResolvedConfig {
  /** The configuration file read (it may not exist). */
  file: string;
  entries: ConfigEntry[];
}

/** A configuration file as read: absent, or its text and parsed document. */
export interface ConfigDocument {
  file: string;
  text: string | undefined;
  document: Record<string, unknown>;
}

function invalid(code: string, message: string): HubError {
  return new HubError(code, message, 400);
}

/**
 * Reads and checks `<configDir>/config.jsonc`: a missing file is an empty
 * configuration.
 *
 * @throws HubError `CONFIG_UNPARSEABLE` (not JSON with comments, or its root
 *   is not an object), `CONFIG_UNKNOWN_KEY`, `CONFIG_INVALID` or
 *   `CONFIG_SECRET`, each naming the file and the key path.
 */
export async function readConfigFile(
  configDir: string,
): Promise<ConfigDocument> {
  const file = path.join(configDir, CONFIG_FILE);
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const document = text === undefined ? {} : parseConfig(file, text);
  checkDocument(file, document);
  return { file, text, document };
}

function parseConfig(file: string, text: string): Record<string, unknown> {
  try {
    return editors.json.parse(text);
  } catch (error) {
    throw invalid(
      "CONFIG_UNPARSEABLE",
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The value at a dot-separated path of a plain document. */
function valueAt(document: unknown, dotted: string): unknown {
  let current = document;
  for (const key of dotted.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Checks a document's keys, values and secrets; the first problem fails
 * with its key path.
 */
function checkDocument(file: string, document: Record<string, unknown>): void {
  const walk = (value: unknown, prefix: string[]): void => {
    const dotted = prefix.join(".");
    const setting = SETTINGS.find((item) => item.path === dotted);
    if (setting) {
      const result = setting.check(value);
      if ("error" in result)
        throw invalid(
          "CONFIG_INVALID",
          // The block resolvers (otlp) name the setting themselves.
          `${file}: ${result.error.startsWith(`${dotted}`) ? result.error : `${dotted} ${result.error}`}`,
        );
      return;
    }
    const inner =
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (
      !inner ||
      !SETTINGS.some((item) =>
        item.path.startsWith(`${dotted ? `${dotted}.` : ""}`),
      )
    )
      throw invalid(
        "CONFIG_UNKNOWN_KEY",
        `${file}: ${dotted || "the document"} is not a setting; run hh config show for the settings`,
      );
    for (const [key, item] of Object.entries(value as object))
      walk(item, [...prefix, key]);
  };
  // Secrets first: a value that is one is refused as such, whatever else is wrong.
  checkSecrets(file, document, []);
  walk(document, []);
}

const SECRET_PREFIX =
  /^(?:sk-|sk_|hhk_|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abposr]-|AIza|AKIA|eyJ)/;
const SECRET_NAME =
  /api[-_]?key|token|secret|passw|credential|authorization|bearer|cookie/i;
const SECRET_KINDS = new Set(["env", "file", "keychain", "store"]);

/** Whether a string under `name` reads as a credential rather than a setting. */
export function looksLikeSecret(name: string, value: string): boolean {
  if (SECRET_PREFIX.test(value) || /^bearer\s+\S{8,}/i.test(value)) return true;
  if (SECRET_NAME.test(name) && value.length >= 8) return true;
  return (
    value.length >= 32 &&
    /^[A-Za-z0-9+/_=.-]+$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value) &&
    !path.isAbsolute(value)
  );
}

function checkSecrets(file: string, value: unknown, at: string[]): void {
  if (typeof value === "string") {
    if (looksLikeSecret(at.at(-1) ?? "", value))
      throw invalid(
        "CONFIG_SECRET",
        `${file}: ${at.join(".")} looks like a secret; the configuration file holds no secrets: store credentials with hh credential and name a secret here as {"kind": "env" | "file" | "keychain" | "store", "value": ...} where a setting takes one`,
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      checkSecrets(file, item, [...at, String(index)]),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  // A secret reference names where a secret is, not the secret itself.
  if (
    typeof record.kind === "string" &&
    SECRET_KINDS.has(record.kind) &&
    typeof record.value === "string" &&
    Object.keys(record).length === 2
  )
    return;
  for (const [key, item] of Object.entries(record))
    checkSecrets(file, item, [...at, key]);
}

/**
 * Resolves every setting: a flag given (by its name, as text) wins over the
 * setting's environment variable, which wins over the file, which wins over
 * the default. `cwd` resolves relative paths given as flags.
 *
 * @throws HubError `CONFIG_INVALID` naming the flag or variable whose value
 *   is not valid.
 */
export function resolveConfig(input: {
  config: ConfigDocument;
  env: Readonly<Record<string, string | undefined>>;
  flags?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}): ResolvedConfig {
  const entries = SETTINGS.map((setting): ConfigEntry => {
    const base = { path: setting.path, description: setting.description };
    const flagged = setting.flag ? input.flags?.[setting.flag.name] : undefined;
    if (setting.flag && flagged !== undefined) {
      const result = setting.check(
        setting.flag.parse(flagged, input.cwd ?? process.cwd()),
      );
      if ("error" in result)
        throw invalid("CONFIG_INVALID", `${setting.flag.name} ${result.error}`);
      return {
        ...base,
        value: result.value,
        source: { kind: "flag", name: setting.flag.name },
      };
    }
    const raw = setting.env ? input.env[setting.env.name] : undefined;
    const fromEnv =
      setting.env && raw !== undefined && raw !== ""
        ? setting.env.read(raw)
        : undefined;
    if (setting.env && fromEnv !== undefined) {
      const result = setting.check(fromEnv);
      if ("error" in result)
        throw invalid("CONFIG_INVALID", `${setting.env.name} ${result.error}`);
      return {
        ...base,
        value: result.value,
        source: { kind: "env", name: setting.env.name },
      };
    }
    const filed = valueAt(input.config.document, setting.path);
    if (filed !== undefined)
      return { ...base, value: filed, source: { kind: "file" } };
    return { ...base, value: setting.fallback, source: { kind: "default" } };
  });
  return { file: input.config.file, entries };
}

/** The `startHub` options the configuration sets. */
export function startOptions(config: ResolvedConfig): {
  host: string;
  port: number;
  dataDir: string;
  secretsBackend: SecretBackendSetting;
  configFile?: string;
  defaultEngine?: string;
  toolPackageRoot?: string;
  harnessModelFile?: string;
  catalog: { autoRefresh?: boolean; url?: string };
  wiring: { autoSync: boolean };
  wiringHome?: string;
  gatewayLimits?: unknown;
  otlp?: unknown;
} {
  const get = (dotted: string) =>
    config.entries.find((entry) => entry.path === dotted)?.value;
  const autoRefresh = config.entries.find(
    (entry) => entry.path === "catalog.autoRefresh",
  )!;
  const optional = <K extends string>(key: K, value: unknown) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, never>>;
  return {
    host: get("server.host") as string,
    port: get("server.port") as number,
    dataDir: get("dataDir") as string,
    secretsBackend: get("secrets.backend") as SecretBackendSetting,
    ...optional("configFile", get("engines.configFile")),
    ...optional("defaultEngine", get("engines.default")),
    ...optional("toolPackageRoot", get("toolPackages.root")),
    ...optional("harnessModelFile", get("harnessModel.file")),
    // HH_OFFLINE stays the catalog resolver's own: only a file or default
    // value is the setting.
    catalog: {
      ...(autoRefresh.source.kind === "env"
        ? {}
        : { autoRefresh: autoRefresh.value as boolean }),
      ...optional("url", get("catalog.url")),
    },
    wiring: resolveWiringSettings({ autoSync: get("wiring.autoSync") }),
    ...optional("wiringHome", get("wiring.home")),
    ...optional("gatewayLimits", get("gateway.limits")),
    ...optional("otlp", get("otlp")),
  };
}

/** A setting the daemon keeps in a file of its own and changes at run time. */
export interface RuntimeSetting {
  readonly name: string;
  readonly file: string;
  /** The command that shows and changes it (the API and the console also do). */
  readonly command: string;
}

/**
 * Where the settings that are not startup settings live: files under the
 * data root that the daemon changes at run time through the API, the
 * console or the CLI, and that this file and `hh config` never manage.
 */
export function runtimeSettings(config: ResolvedConfig): RuntimeSetting[] {
  const dataDir = config.entries.find((entry) => entry.path === "dataDir")!
    .value as string;
  return [
    // The files of lan-share.ts and gateway-features.ts, named here so
    // that hh config does not load the gateway.
    {
      name: "LAN sharing",
      file: path.join(dataDir, "gateway-sharing.json"),
      command: "hh gateway share",
    },
    {
      name: "Redaction, vision and search",
      file: path.join(dataDir, "gateway-features.json"),
      command: "hh gateway features",
    },
  ];
}

/**
 * Checks that `dotted` names a setting or a key inside an open one
 * (`gateway.limits.<name>`, `otlp.<...>`).
 *
 * @throws HubError `CONFIG_UNKNOWN_KEY`.
 */
export function checkConfigPath(dotted: string): string[] {
  const keys = dotted.split(".");
  if (
    keys.some((key) => key === "") ||
    !SETTINGS.some(
      (setting) =>
        setting.path === dotted ||
        (setting.open && dotted.startsWith(`${setting.path}.`)) ||
        setting.path.startsWith(`${dotted}.`),
    )
  )
    throw invalid(
      "CONFIG_UNKNOWN_KEY",
      `${dotted} is not a setting; run hh config show for the settings`,
    );
  return keys;
}

/**
 * Sets (or with `value` undefined removes) `dotted` in the file, keeping
 * comments and the rest of the text, after checking that the whole file is
 * still valid; nothing is written otherwise. The file and its directory are
 * created private (0600, 0700) when missing.
 *
 * @throws The errors of `readConfigFile` and `checkConfigPath`.
 */
export async function editConfigFile(
  configDir: string,
  dotted: string,
  value: unknown,
): Promise<ConfigDocument> {
  const keys = checkConfigPath(dotted);
  const current = await readConfigFile(configDir);
  const base =
    current.text ??
    "// HarnessHub configuration: hh config show lists the settings.\n{}\n";
  let text: string;
  if (value === undefined) {
    text = editors.json.remove(base, keys);
    // Groups left empty go too.
    for (let length = keys.length - 1; length > 0; length--) {
      const parent = valueAt(
        editors.json.parse(text),
        keys.slice(0, length).join("."),
      );
      if (
        typeof parent !== "object" ||
        parent === null ||
        Object.keys(parent).length
      )
        break;
      text = editors.json.remove(text, keys.slice(0, length));
    }
  } else
    text = editors.json.set(
      base,
      keys,
      value as Parameters<typeof editors.json.set>[2],
    );
  const document = parseConfig(current.file, text);
  checkDocument(current.file, document);
  if (text === current.text) return current;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const temporary = `${current.file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, current.file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { file: current.file, text, document };
}

/** A value as `hh config show` prints it. */
export function formatValue(value: unknown): string {
  return value === undefined
    ? "-"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}

/** A source as `hh config show` prints it. */
export function formatSource(source: ConfigSource): string {
  return source.kind === "env" || source.kind === "flag"
    ? `${source.kind} ${source.name}`
    : source.kind;
}
