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
  const engines: EngineProfile[] = entries.map((entry: unknown) => {
    const e = object(entry);
    keys(e, [
      "id",
      "driver",
      "enabled",
      "command",
      "model",
      "maxConcurrency",
      "credentialEnv",
    ]);
    if (e.enabled !== undefined && typeof e.enabled !== "boolean")
      throw new HubError("INVALID_CONFIG", "enabled must be a boolean");
    if (
      e.credentialEnv !== undefined &&
      (!Array.isArray(e.credentialEnv) ||
        !e.credentialEnv.every(
          (v: unknown) => typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v),
        ))
    )
      throw new HubError(
        "INVALID_CONFIG",
        "credentialEnv must contain environment variable names only",
      );
    if (e.driver !== "acp")
      throw new HubError(
        "INVALID_CONFIG",
        "Configured engines must use the acp driver",
      );
    if (
      !Array.isArray(e.command) ||
      !e.command.length ||
      !e.command.every((v: unknown) => typeof v === "string" && v.length > 0)
    )
      throw new HubError(
        "INVALID_CONFIG",
        "command must be a non-empty argv array",
      );
    const profile = {
      id: string(e.id, "engine.id"),
      driver: "acp" as const,
      enabled: e.enabled !== false,
      command: e.command as string[],
      ...(e.model !== undefined ? { model: string(e.model, "model") } : {}),
      ...(e.credentialEnv !== undefined
        ? { credentialEnv: e.credentialEnv as string[] }
        : {}),
      maxConcurrency: integer(e.maxConcurrency, 1),
      // Configured expectations are not verified runtime capabilities.
      capabilities: { resume: false, permissions: true, images: false },
    };
    return {
      ...profile,
      revision: createHash("sha256")
        .update(JSON.stringify(profile))
        .digest("hex"),
    };
  });
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
    !defaultEngine ||
    !engines.some((e) => e.id === defaultEngine && e.enabled) ||
    !defaultWorkspace ||
    !workspaces.some((w) => w.id === defaultWorkspace)
  )
    throw new HubError(
      "INVALID_CONFIG",
      "Register a default engine/workspace using --config or enable --demo",
    );
  return freeze({
    engines,
    workspaces,
    defaultEngine,
    defaultWorkspace,
    maxConcurrency: integer(raw.maxConcurrency, 4),
    maxWorkers: integer(raw.maxWorkers, 16),
    maxQueuedRuns: integer(raw.maxQueuedRuns, 1000),
    defaultTimeoutMs: integer(raw.defaultTimeoutMs, 60_000),
    cancelGraceMs: integer(raw.cancelGraceMs, 500),
  });
}
