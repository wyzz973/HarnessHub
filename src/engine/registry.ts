import {
  parseEngineConfiguration,
  pinConfigurationSkills,
} from "./configuration.js";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { HubError } from "../domain/errors.js";
import type { EngineProfile, Workspace } from "../domain/types.js";

export interface HubConfig {
  engines: EngineProfile[];
  workspaces: Workspace[];
  defaultEngine: string;
  defaultWorkspace: string;
  maxConcurrency: number;
  maxWorkers: number;
  maxQueuedRuns: number;
  defaultTimeoutMs: number;
  cancelGraceMs: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HubError("INVALID_CONFIG", "Expected a configuration object");
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new HubError("INVALID_CONFIG", `${field} must be a non-empty string`);
  return value;
}
function integer(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 86_400_000
  )
    throw new HubError(
      "INVALID_CONFIG",
      "Limits must be positive bounded integers",
    );
  return value as number;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  const invalid = Object.keys(value).find((key) => !allowed.includes(key));
  if (invalid)
    throw new HubError(
      "INVALID_CONFIG",
      `Unknown configuration field: ${invalid}`,
    );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Parse configuration/API/manifest input into a frozen, content-addressed execution revision. */
export function normalizeEngine(input: unknown): EngineProfile {
  const e = object(input);
  keys(e, [
    "id",
    "driver",
    "enabled",
    "command",
    "model",
    "maxConcurrency",
    "credentialEnv",
    "configuration",
    "cli",
    "acp",
  ]);
  const id = string(e.id, "engine.id");
  if (["fake", "default", "discover", "registry", "reload"].includes(id))
    throw new HubError(
      "ENGINE_RESERVED",
      "Engine id is reserved by the Gateway",
      400,
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(id))
    throw new HubError(
      "INVALID_CONFIG",
      "Engine id must be 1-100 letters, digits, dots, underscores or hyphens",
    );
  if (e.enabled !== undefined && typeof e.enabled !== "boolean")
    throw new HubError("INVALID_CONFIG", "enabled must be a boolean");
  if (
    e.credentialEnv !== undefined &&
    (!Array.isArray(e.credentialEnv) ||
      !e.credentialEnv.every(
        (v: unknown) => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v),
      ) ||
      new Set(e.credentialEnv).size !== e.credentialEnv.length)
  )
    throw new HubError(
      "INVALID_CONFIG",
      "credentialEnv must contain unique environment variable names only",
    );
  if (e.driver !== "acp" && e.driver !== "cli")
    throw new HubError(
      "INVALID_CONFIG",
      "Configured engines must use acp or cli",
    );
  if (
    !Array.isArray(e.command) ||
    !e.command.length ||
    e.command.length > 256 ||
    !e.command.every(
      (v: unknown) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 8192 &&
        !v.includes("\0"),
    )
  )
    throw new HubError(
      "INVALID_CONFIG",
      "command must be a bounded non-empty argv array without NUL bytes",
    );
  // Common secret arguments must be references via credentialEnv/config files instead.
  // Arbitrary script contents cannot be classified; callers must never embed secrets there.
  if (
    e.command.some(
      (arg: string) =>
        /^(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)|TOKEN)=/i.test(
          arg,
        ) ||
        /^--?(?:api[-_]?(?:key|token)|access[-_]?token|auth[-_]?token|token|password|secret|authorization)(?:=|$)/i.test(
          arg,
        ),
    )
  )
    throw new HubError(
      "INVALID_CONFIG",
      "Use credentialEnv names or configuration file references instead of secret command arguments",
    );
  let cli: EngineProfile["cli"];
  if (e.driver === "cli") {
    const c = e.cli === undefined ? {} : object(e.cli);
    keys(c, ["inputMode", "maxOutputBytes"]);
    const inputMode = c.inputMode ?? "stdin";
    if (inputMode !== "stdin" && inputMode !== "argv")
      throw new HubError(
        "INVALID_CONFIG",
        "CLI inputMode must be stdin or argv",
      );
    if (
      inputMode === "argv" &&
      (e.command[0] === "{prompt}" ||
        e.command.filter((v) => v === "{prompt}").length !== 1)
    )
      throw new HubError(
        "INVALID_CONFIG",
        "CLI argv input requires exactly one standalone {prompt} argument",
      );
    const maxOutputBytes = integer(c.maxOutputBytes, 4 * 1024 * 1024);
    if (maxOutputBytes > 4 * 1024 * 1024)
      throw new HubError(
        "INVALID_CONFIG",
        "CLI output must fit the 4 MiB result limit",
      );
    cli = { inputMode, maxOutputBytes };
  } else if (e.cli !== undefined) {
    throw new HubError("INVALID_CONFIG", "cli options require the cli driver");
  }
  let acp: EngineProfile["acp"];
  if (e.acp !== undefined) {
    const a = object(e.acp);
    keys(a, ["sessionMode", "initializeTimeoutMs"]);
    if (
      e.driver !== "acp" ||
      (a.sessionMode !== undefined && a.sessionMode !== "resume")
    )
      throw new HubError(
        "INVALID_CONFIG",
        "acp sessionMode resume requires the ACP driver",
      );
    acp = {};
    if (a.sessionMode === "resume") acp.sessionMode = "resume";
    if (a.initializeTimeoutMs !== undefined) {
      const timeout = integer(a.initializeTimeoutMs, 10_000);
      if (timeout > 60_000)
        throw new HubError(
          "INVALID_CONFIG",
          "ACP initializeTimeoutMs must not exceed 60000 ms",
        );
      acp.initializeTimeoutMs = timeout;
    }
  }
  if (
    e.configuration &&
    typeof e.configuration === "object" &&
    "provider" in e.configuration &&
    e.command.some((arg: string) =>
      /launch-(?:pi|opencode|dsh|openclaw)-acp\.mjs$/.test(arg),
    )
  )
    throw new HubError(
      "ENGINE_CONFIGURATION_UNSUPPORTED",
      "该自定义启动脚本固定了 Provider；请先选择标准启动模板",
    );
  const profile: Omit<EngineProfile, "revision"> = {
    id,
    driver: e.driver,
    enabled: e.enabled !== false,
    command: [...e.command] as string[],
    ...(e.model !== undefined ? { model: string(e.model, "model") } : {}),
    ...(e.credentialEnv !== undefined
      ? { credentialEnv: [...(e.credentialEnv as string[])] }
      : {}),
    ...(e.configuration !== undefined
      ? {
          configuration: parseEngineConfiguration(
            e.configuration,
            e.driver,
            typeof e.model === "string" ? e.model : undefined,
          ),
        }
      : {}),
    ...(cli ? { cli } : {}),
    ...(acp ? { acp } : {}),
    maxConcurrency: integer(e.maxConcurrency, 1),
    capabilities: {
      resume: acp?.sessionMode === "resume",
      permissions: e.driver === "acp",
      images: false,
    },
  };
  return freeze({
    ...profile,
    revision: createHash("sha256")
      .update(JSON.stringify(profile))
      .digest("hex"),
  });
}
/** Resolve all deployment defaults once; no environment access occurs in run execution. */
export async function loadConfig(options: {
  file?: string;
  demo: boolean;
  cwd: string;
  defaultEngine?: string;
}): Promise<HubConfig> {
  const raw: Record<string, unknown> = options.file
    ? object(parse(await readFile(options.file, "utf8")) as unknown)
    : {};
  keys(raw, [
    "engines",
    "workspaces",
    "defaultEngine",
    "defaultWorkspace",
    "maxConcurrency",
    "maxWorkers",
    "maxQueuedRuns",
    "defaultTimeoutMs",
    "cancelGraceMs",
  ]);
  const entries = raw.engines ?? [];
  const spaces = raw.workspaces ?? [{ id: "default", path: options.cwd }];
  if (!Array.isArray(entries) || !Array.isArray(spaces))
    throw new HubError(
      "INVALID_CONFIG",
      "engines and workspaces must be arrays",
    );
  const base = options.file
    ? path.dirname(path.resolve(options.file))
    : options.cwd;
  const engines: EngineProfile[] = await Promise.all(
    entries.map(prepareEngine),
  );
  if (options.demo)
    engines.push({
      id: "fake",
      driver: "fake",
      revision: "fake-v1",
      enabled: true,
      maxConcurrency: 4,
      capabilities: { resume: false, permissions: true, images: false },
    });
  const workspaces = await Promise.all(
    spaces.map(async (entry: unknown): Promise<Workspace> => {
      const w = object(entry);
      keys(w, ["id", "path"]);
      const location = await realpath(
        path.resolve(base, string(w.path, "workspace.path")),
      );
      if (!(await stat(location)).isDirectory())
        throw new HubError("INVALID_CONFIG", "Workspace must be a directory");
      return { id: string(w.id, "workspace.id"), path: location };
    }),
  );
  if (
    new Set(engines.map((e) => e.id)).size !== engines.length ||
    new Set(workspaces.map((w) => w.id)).size !== workspaces.length
  )
    throw new HubError("INVALID_CONFIG", "Duplicate engine or workspace id");
  const defaultEngine =
    options.defaultEngine ??
    (typeof raw.defaultEngine === "string"
      ? raw.defaultEngine
      : engines.find((e) => e.enabled)?.id);
  const defaultWorkspace =
    typeof raw.defaultWorkspace === "string"
      ? raw.defaultWorkspace
      : workspaces[0]?.id;
  if (
    (defaultEngine !== undefined &&
      !engines.some((e) => e.id === defaultEngine && e.enabled)) ||
    !defaultWorkspace ||
    !workspaces.some((w) => w.id === defaultWorkspace)
  )
    throw new HubError(
      "INVALID_CONFIG",
      "Configured default engine/workspace is not available",
    );
  return freeze({
    engines,
    workspaces,
    defaultEngine: defaultEngine ?? "",
    defaultWorkspace,
    maxConcurrency: integer(raw.maxConcurrency, 4),
    maxWorkers: integer(raw.maxWorkers, 16),
    maxQueuedRuns: integer(raw.maxQueuedRuns, 1000),
    defaultTimeoutMs: integer(raw.defaultTimeoutMs, 60_000),
    cancelGraceMs: integer(raw.cancelGraceMs, 500),
  });
}

/** Resolve local skill fingerprints before publishing a configuration revision. */
export async function prepareEngine(input: unknown): Promise<EngineProfile> {
  const profile = await pinConfigurationSkills(normalizeEngine(input));
  const {
    revision: _revision,
    capabilities: _capabilities,
    ...registration
  } = profile;
  return normalizeEngine(registration);
}
