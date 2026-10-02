import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import { isRelativeFilePath } from "../domain/files.js";
import { canonicalDirectory, missing, PackageReader } from "./files.js";
import {
  canonicalJson,
  FORBIDDEN_ENVIRONMENT,
  hash,
  isStdioMcp,
  limits,
  MANIFEST_NAME,
  packageError,
  parseManifest,
  remoteUrlProblem,
  SECRET_VALUE,
  SLOT_NAME,
} from "./manifest.js";
import { inspectLocal, installGenerated, installLocal } from "./store.js";
import {
  SESSION_WORKSPACE_PLACEHOLDER,
  type InstalledToolPackage,
  type ToolPackageArgument,
  type ToolPackageCli,
  type ToolPackageDefaultSecretBinding,
  type ToolPackageFile,
  type ToolPackageManifest,
  type ToolPackageMcp,
} from "./types.js";

export type ToolPackImportKind = "auto" | "skills" | "mcp" | "cli";
export const importKinds: readonly ToolPackImportKind[] = [
  "auto",
  "skills",
  "mcp",
  "cli",
];

export interface ToolPackImportOptions {
  kind?: ToolPackImportKind;
  /** Package id; derived from the source directory (or JSON file) name when absent. */
  id?: string;
  /** Package version; `auto-<content fingerprint>` when absent, so changed content gets a new version. */
  version?: string;
  displayName?: string;
}
export interface ToolPackImportResult {
  installed: InstalledToolPackage;
  /** `tool-package` installed an existing manifest unchanged; `generated` was built from simple formats. */
  format: "tool-package" | "generated";
  counts: { skills: number; mcp: number; cli: number };
  /** Non-fatal adjustments the caller must see, e.g. secret values converted to references. */
  warnings: string[];
}

/** What {@link importLocal} would register for a source; see {@link inspectImport}. */
export interface ToolPackImportInspection {
  manifest: ToolPackageManifest;
  /** Digest the store would record: SHA-256 of the canonical manifest, which lists every payload hash. */
  digest: string;
  format: "tool-package" | "generated";
  counts: { skills: number; mcp: number; cli: number };
  warnings: string[];
}

/** Root-level MCP configuration files recognised in a source directory, in merge order. */
export const MCP_CONFIG_FILES = [
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  ".cursor/mcp.json",
  "claude_desktop_config.json",
] as const;
export const CLI_CONFIG_FILE = "cli.json";

/** Package runners that fetch code when a server starts; unusable offline. */
const DOWNLOAD_RUNNERS = new Set(["npx", "pnpx", "bunx", "uvx", "pipx"]);
const PACKAGE_MANAGERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "uv",
  "pip",
  "deno",
  "docker",
  "podman",
]);
const NODE_SCRIPT = /\.(?:js|mjs|cjs)$/i;
/** Version-control and editor metadata never belongs to a tool package. */
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vscode",
  ".cursor",
  ".idea",
  "__MACOSX",
]);
/** Operating-system metadata files, skipped without a warning. */
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "Icon\r"]);
/** Broader than the manifest rule: anything that might be a credential becomes a reference. */
const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL|PRIVATE/i;
const WORKSPACE_VARIABLE = /\$\{(?:workspaceFolder|workspaceRoot)\}/g;
const REFERENCE_HINT =
  "Set it before starting the Gateway or pass secretBindings; while it is unset, Sessions of engines using this pack fail with SECRET_UNAVAILABLE";
const WALK_DIRECTORIES = 20_000;
const CONFIG_BYTES = 1024 * 1024;
const GENERIC_CONFIG_NAMES =
  /^(?:\.?mcp|cli|claude_desktop_config|settings|config|servers)\.json$/i;

function sourceError(message: string): HubError {
  return packageError("INVALID_TOOL_PACKAGE_SOURCE", message);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isAbsoluteAnywhere(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}
/** Configuration files written on Windows commonly use backslashes. */
function nativePath(value: string): string {
  return value.replaceAll("\\", "/").split("/").join(path.sep);
}
/** Root-relative POSIX path of `absolute`, or undefined when it escapes the root. */
function inside(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return undefined;
  return relative.split(path.sep).join("/");
}
function variables(value: string): string[] {
  return [...value.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]!);
}
function onlyWorkspaceVariables(value: string): boolean {
  return variables(value).every(
    (name) => name === "workspaceFolder" || name === "workspaceRoot",
  );
}
/** Upper-case environment spelling of an arbitrary identifier. */
function environmentName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^[^A-Z]+/, "")
    .slice(0, 64);
}
/**
 * The environment variable a whole value refers to: `${env:NAME}`,
 * `${input:id}` (VS Code prompt, mapped to an env name) or `${NAME}` with an
 * upper-case name (Claude Code expansion). VS Code predefined variables such
 * as `${workspaceFolder}` or `${userHome}` are not environment references.
 */
function referencedEnvironment(value: string): string | undefined {
  const match =
    /^\$\{(?:(env|input):([A-Za-z_][A-Za-z0-9_.-]*)|([A-Z_][A-Z0-9_]*))\}$/.exec(
      value.trim(),
    );
  if (!match) return undefined;
  return environmentName(match[2] ?? match[3]!) || undefined;
}

/** Derives a package id from a file or directory name; empty when nothing usable remains. */
export function slug(value: string): string {
  const text = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return /^[a-z][a-z0-9-]{0,31}$/.test(text) ? text : "";
}
function serverName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 31)
    .replace(/-+$/, "");
}

interface Scan {
  /** Root-relative POSIX path → absolute path, size and POSIX owner-execute bit. */
  files: Map<string, { absolute: string; size: number; executable: boolean }>;
  directories: Set<string>;
  warnings: string[];
}

/**
 * Walks `directories` (root-relative, "" = root) without following links.
 * Version-control/editor directories, OS metadata, .env files and `exclude`
 * are omitted; node_modules only when `nodeModules` is false. Enforces the
 * package file, byte and directory limits while walking.
 */
async function scan(
  root: string,
  directories: string[],
  options: { nodeModules: boolean; exclude: ReadonlySet<string> },
): Promise<Scan> {
  const result: Scan = {
    files: new Map(),
    directories: new Set(),
    warnings: [],
  };
  const links: string[] = [];
  const special: string[] = [];
  const environments: string[] = [];
  let visited = 0;
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (++visited > WALK_DIRECTORIES || depth > 64)
      throw packageError(
        "TOOL_PACKAGE_TOO_LARGE",
        "Import source exceeds 20,000 directories or 64 levels",
      );
    if (relative) result.directories.add(relative);
    const absolute = relative ? path.join(root, nativePath(relative)) : root;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) links.push(name);
      else if (entry.isDirectory()) {
        if (
          !EXCLUDED_DIRECTORIES.has(entry.name) &&
          (options.nodeModules || entry.name !== "node_modules")
        )
          await walk(name, depth + 1);
      } else if (JUNK_FILES.has(entry.name) || options.exclude.has(name)) {
        continue;
      } else if (entry.name === ".env" || entry.name.startsWith(".env.")) {
        environments.push(name);
      } else if (!entry.isFile()) {
        special.push(name);
      } else {
        if (!isRelativeFilePath(name) || name.split("/").length > 64)
          throw packageError(
            "INVALID_TOOL_PACKAGE_PATH",
            `${name} is not a portable file name (Windows reserved names, trailing dots or spaces and control characters are rejected)`,
          );
        const info = await lstat(path.join(root, nativePath(name)));
        if (info.size > limits.fileBytes)
          throw packageError(
            "TOOL_PACKAGE_TOO_LARGE",
            `${name} exceeds the 128 MiB file limit`,
          );
        total += info.size;
        if (result.files.size >= limits.files || total > limits.totalBytes)
          throw packageError(
            "TOOL_PACKAGE_TOO_LARGE",
            "Import content exceeds 10,000 files or 256 MiB; import a narrower directory",
          );
        result.files.set(name, {
          absolute: path.join(root, nativePath(name)),
          size: info.size,
          executable: process.platform !== "win32" && (info.mode & 0o100) !== 0,
        });
      }
    }
  };
  const selected = [...new Set(directories)].sort();
  for (const directory of selected)
    if (
      !selected.some(
        (other) =>
          other !== directory &&
          (other === "" || directory.startsWith(`${other}/`)),
      )
    )
      await walk(directory, directory ? directory.split("/").length : 0);
  const listed = (names: string[]) =>
    `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
  if (links.length)
    result.warnings.push(
      `Skipped ${links.length} symbolic links or junctions: ${listed(links)}`,
    );
  if (special.length)
    result.warnings.push(`Skipped non-regular files: ${listed(special)}`);
  if (environments.length)
    result.warnings.push(
      `Skipped environment files that may contain secrets: ${listed(environments)}`,
    );
  return result;
}

/** Finds `SKILL.md` files, skipping links, version control and node_modules. */
async function discoverSkills(root: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (++visited > WALK_DIRECTORIES || depth > 64)
      throw packageError(
        "TOOL_PACKAGE_TOO_LARGE",
        "Import source exceeds 20,000 directories or 64 levels",
      );
    const absolute = relative ? path.join(root, nativePath(relative)) : root;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          !EXCLUDED_DIRECTORIES.has(entry.name) &&
          entry.name !== "node_modules"
        )
          await walk(name, depth + 1);
      } else if (entry.isFile() && entry.name === "SKILL.md") found.push(name);
    }
  };
  await walk("", 0);
  return found.sort();
}

async function readJson(
  reader: PackageReader,
  file: string,
  label: string,
): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await reader.read(file, CONFIG_BYTES, { allowHardLinks: true });
  } catch (error) {
    if (error instanceof HubError && error.code === "TOOL_PACKAGE_TOO_LARGE")
      throw sourceError(`${label} exceeds 1 MiB`);
    throw error;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text.replace(/^﻿/, "")) as unknown;
  } catch {
    throw sourceError(
      `${label} must be strict UTF-8 JSON (comments and trailing commas are not supported)`,
    );
  }
}

interface Context {
  root: string;
  /** Directory of the JSON file being interpreted; relative paths start here. */
  base: string;
  files: Scan;
  problems: string[];
  warnings: string[];
  /** Secret slot → default environment reference. */
  defaults: Map<string, ToolPackageDefaultSecretBinding>;
  /** Entries started directly, which must be marked executable. */
  nativeEntries: Set<string>;
}
function exists(context: Context, relative: string) {
  return context.files.files.has(relative)
    ? "file"
    : context.files.directories.has(relative)
      ? "directory"
      : undefined;
}

/**
 * Converts one imported argument. `${workspaceFolder}` as a whole argument
 * becomes a workspace anchor; inside a longer MCP argument it becomes the
 * Session placeholder (substituted by the Worker). `./x`, `../x` and absolute
 * paths naming files inside the import become package anchors.
 */
function argument(
  raw: unknown,
  context: Context,
  label: string,
  embeddedWorkspace: boolean,
): ToolPackageArgument | undefined {
  if (typeof raw === "number" || typeof raw === "boolean") raw = String(raw);
  if (record(raw)) {
    if (raw.anchor === "workspace" && Object.keys(raw).length === 1)
      return { anchor: "workspace" };
    if (
      raw.anchor === "package" &&
      typeof raw.path === "string" &&
      Object.keys(raw).length === 2
    )
      return { anchor: "package", path: raw.path };
  }
  if (typeof raw !== "string" || !raw.length || raw.length > 8192) {
    context.problems.push(`${label}: arguments must be non-empty strings`);
    return undefined;
  }
  if (variables(raw).length) {
    if (!onlyWorkspaceVariables(raw)) {
      context.problems.push(
        `${label}: unsupported variable in argument ${JSON.stringify(raw)}; only \${workspaceFolder} is supported`,
      );
      return undefined;
    }
    if (/^\$\{(?:workspaceFolder|workspaceRoot)\}$/.test(raw))
      return { anchor: "workspace" };
    if (!embeddedWorkspace) {
      context.problems.push(
        `${label}: CLI arguments may use \${workspaceFolder} only as a whole argument`,
      );
      return undefined;
    }
    return raw.replace(WORKSPACE_VARIABLE, SESSION_WORKSPACE_PLACEHOLDER);
  }
  const relative = /^\.{1,2}[\\/]/.test(raw);
  if (!relative && !isAbsoluteAnywhere(raw)) return raw;
  const target = inside(
    context.root,
    path.resolve(context.base, nativePath(raw)),
  );
  if (target && exists(context, target))
    return { anchor: "package", path: target };
  if (relative && target === undefined) {
    context.problems.push(
      `${label}: argument ${raw} points outside the import directory`,
    );
    return undefined;
  }
  context.warnings.push(
    `${label}: argument ${raw} is kept verbatim because it is not a file inside the import directory`,
  );
  return raw;
}

/** Resolves a file that will be started; it must be copied into the package. */
function entry(
  raw: string,
  context: Context,
  label: string,
): { relative: string; node: boolean } | undefined {
  if (variables(raw).length) {
    context.problems.push(
      `${label}: variables are not supported in the command or entry (${raw})`,
    );
    return undefined;
  }
  const relative = inside(
    context.root,
    path.resolve(context.base, nativePath(raw)),
  );
  if (!relative) {
    context.problems.push(
      `${label}: ${raw} is outside the import directory; offline Tool Packs only start files they contain`,
    );
    return undefined;
  }
  if (exists(context, relative) !== "file") {
    context.problems.push(
      `${label}: ${raw} is not a regular file inside the import directory`,
    );
    return undefined;
  }
  if (/\.ps1$/i.test(relative)) {
    context.problems.push(
      `${label}: PowerShell scripts cannot be started directly; wrap ${raw} in a .cmd file`,
    );
    return undefined;
  }
  return { relative, node: NODE_SCRIPT.test(relative) };
}

/** Maps an MCP `command` + `args` onto a package entry, rejecting runtime downloads and PATH lookups. */
function launch(
  rawCommand: unknown,
  rawArgs: unknown,
  context: Context,
  label: string,
): { launch: "node" | "native"; entry: string; args: unknown[] } | undefined {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    context.problems.push(`${label}: command must be a non-empty string`);
    return undefined;
  }
  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    context.problems.push(`${label}: args must be an array`);
    return undefined;
  }
  const args: unknown[] = [...((rawArgs as unknown[] | undefined) ?? [])];
  const command = rawCommand.trim();
  const portable = command.replaceAll("\\", "/");
  const bare = !portable.includes("/") && !isAbsoluteAnywhere(command);
  const base = path.posix
    .basename(portable)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/, "");
  const first = typeof args[0] === "string" ? args[0].toLowerCase() : "";
  if (
    DOWNLOAD_RUNNERS.has(base) ||
    (base === "npm" && ["exec", "x"].includes(first)) ||
    (base === "pnpm" && ["dlx", "exec"].includes(first)) ||
    (base === "yarn" && first === "dlx") ||
    (base === "bun" && first === "x") ||
    (base === "uv" && ["tool", "run"].includes(first))
  ) {
    context.problems.push(
      `${label}: ${command} downloads packages when the server starts, which cannot work offline. Install the server into the import directory (for example node_modules) and start it with node and a relative script path, or package an executable`,
    );
    return undefined;
  }
  if (
    base === "node" &&
    (bare ||
      !inside(context.root, path.resolve(context.base, nativePath(command))))
  ) {
    // Any external Node is replaced by the bundled Node executable.
    const script = args.shift();
    if (typeof script !== "string" || script.startsWith("-")) {
      context.problems.push(
        `${label}: node must be followed directly by a script inside the import directory (Node options are not supported)`,
      );
      return undefined;
    }
    const resolved = entry(script, context, label);
    return resolved && { launch: "node", entry: resolved.relative, args };
  }
  let candidate = command;
  if (bare) {
    const names = path.posix.extname(portable)
      ? [portable]
      : [portable, `${portable}.exe`, `${portable}.cmd`, `${portable}.bat`];
    const local = names.find((name) => {
      const relative = inside(context.root, path.resolve(context.base, name));
      return relative !== undefined && exists(context, relative) === "file";
    });
    if (!local) {
      context.problems.push(
        PACKAGE_MANAGERS.has(base)
          ? `${label}: ${command} resolves dependencies through a package manager at run time; copy the server files into the import directory and start them with node or a relative executable`
          : `${label}: ${command} would be looked up on PATH; offline Tool Packs only start files inside the import directory (use a relative path)`,
      );
      return undefined;
    }
    candidate = `./${local}`;
  }
  const resolved = entry(candidate, context, label);
  return (
    resolved && {
      launch: resolved.node ? "node" : "native",
      entry: resolved.relative,
      args,
    }
  );
}

/** Registers a secret slot whose default binding is an environment variable. */
function secretSlot(
  context: Context,
  preferred: string,
  variable: string,
  server: string,
): string {
  let slot = preferred;
  const previous = context.defaults.get(slot);
  if (previous && previous.value !== variable)
    slot = `${server}-${preferred}`.slice(0, 64);
  if (!SLOT_NAME.test(slot)) slot = `slot-${hash(slot).slice(0, 12)}`;
  context.defaults.set(slot, { kind: "env", value: variable });
  return slot;
}

function environment(
  raw: unknown,
  context: Context,
  label: string,
  server: string,
): { env?: Record<string, string>; secretEnv?: Record<string, string> } {
  if (raw === undefined) return {};
  if (!record(raw)) {
    context.problems.push(`${label}: env must be an object`);
    return {};
  }
  const env: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(raw)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || FORBIDDEN_ENVIRONMENT.test(name)) {
      context.problems.push(
        `${label}: environment name ${name} must use upper-case letters, digits and underscores and must not override process settings`,
      );
      continue;
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      context.problems.push(`${label}: env ${name} must be a string`);
      continue;
    }
    const value = String(rawValue);
    const reference = referencedEnvironment(value);
    if (reference || SECRET_NAME.test(name) || SECRET_VALUE.test(value)) {
      const variable = reference ?? name;
      secretEnv[name] = secretSlot(context, name, variable, server);
      context.warnings.push(
        `${label}: env ${name} ${
          SECRET_NAME.test(name) || SECRET_VALUE.test(value)
            ? "looks like a secret, so its value was not stored; it is"
            : "is"
        } read from environment variable ${variable} when a Session starts. ${REFERENCE_HINT}`,
      );
      continue;
    }
    if (!onlyWorkspaceVariables(value)) {
      context.problems.push(
        `${label}: unsupported variable in env ${name}; only \${workspaceFolder}, \${env:NAME} and \${input:NAME} are supported`,
      );
      continue;
    }
    if (!value.length || value.includes("\0")) {
      context.problems.push(`${label}: env ${name} must be a non-empty string`);
      continue;
    }
    env[name] = value.replace(
      WORKSPACE_VARIABLE,
      SESSION_WORKSPACE_PLACEHOLDER,
    );
  }
  return {
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(secretEnv).length ? { secretEnv } : {}),
  };
}

function headers(
  raw: unknown,
  context: Context,
  label: string,
  server: string,
): {
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string>;
} {
  if (raw === undefined) return {};
  if (!record(raw)) {
    context.problems.push(`${label}: headers must be an object`);
    return {};
  }
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9!#$%&'*+.^_`|~-]{0,63}$/.test(name) ||
      typeof value !== "string" ||
      !value.length ||
      /[\r\n\0]/.test(value)
    ) {
      context.problems.push(`${label}: invalid header ${name}`);
      continue;
    }
    const reference = referencedEnvironment(value);
    if (reference || SECRET_NAME.test(name) || SECRET_VALUE.test(value)) {
      const variable = reference ?? environmentName(name);
      secret[name] = secretSlot(context, variable, variable, server);
      context.warnings.push(
        `${label}: header ${name} was not stored; its complete value (for example "Bearer ...") is read from environment variable ${variable} when a Session starts. ${REFERENCE_HINT}`,
      );
      continue;
    }
    if (variables(value).length) {
      context.problems.push(
        `${label}: header ${name} uses an unsupported variable; use \${env:NAME}`,
      );
      continue;
    }
    plain[name] = value;
  }
  return {
    ...(Object.keys(plain).length ? { headers: plain } : {}),
    ...(Object.keys(secret).length ? { secretHeaders: secret } : {}),
  };
}

const SERVER_FIELDS = new Set([
  "command",
  "args",
  "env",
  "url",
  "headers",
  "type",
  "transport",
  "cwd",
  "envFile",
  "disabled",
  "enabled",
  "name",
  "description",
]);
const TRANSPORTS: Record<string, "stdio" | "http" | "sse"> = {
  stdio: "stdio",
  http: "http",
  "streamable-http": "http",
  streamableHttp: "http",
  streamable_http: "http",
  sse: "sse",
};

/** Whether an MCP document declares any local command (needs the file index). */
function declaresCommand(value: unknown): boolean {
  if (!record(value)) return false;
  const servers = value.mcpServers ?? value.servers;
  return (
    record(servers) &&
    Object.values(servers).some(
      (definition) => !record(definition) || definition.url === undefined,
    )
  );
}

function mcpServers(
  value: unknown,
  context: Context,
  label: string,
): ToolPackageMcp[] {
  if (!record(value)) {
    context.problems.push(`${label}: expected a JSON object`);
    return [];
  }
  if (value.mcpServers !== undefined && value.servers !== undefined) {
    context.problems.push(`${label}: use either mcpServers or servers`);
    return [];
  }
  const servers = value.mcpServers ?? value.servers;
  if (!record(servers)) {
    context.problems.push(
      `${label}: expected {"mcpServers": {...}} or {"servers": {...}}`,
    );
    return [];
  }
  const result: ToolPackageMcp[] = [];
  for (const [rawName, definition] of Object.entries(servers)) {
    const where = `${label} server ${rawName}`;
    if (!record(definition)) {
      context.problems.push(`${where}: definition must be an object`);
      continue;
    }
    if (definition.disabled === true || definition.enabled === false) {
      context.warnings.push(`${where}: disabled in the source, not imported`);
      continue;
    }
    const name = serverName(rawName);
    if (!name || name.toLowerCase() === "cli") {
      context.problems.push(
        `${where}: the server name needs letters or digits and cannot be "cli"`,
      );
      continue;
    }
    if (name !== rawName)
      context.warnings.push(`${where}: imported as ${name}`);
    const ignored = Object.keys(definition).filter(
      (key) => !SERVER_FIELDS.has(key),
    );
    if (ignored.length)
      context.warnings.push(`${where}: ignored fields ${ignored.join(", ")}`);
    let blocked = false;
    for (const field of ["cwd", "envFile"])
      if (definition[field] !== undefined) {
        blocked = true;
        context.problems.push(
          `${where}: ${field} is not supported; servers start in the Session directory and env must be declared explicitly`,
        );
      }
    if (blocked) continue;
    const rawType = definition.type ?? definition.transport;
    const type =
      rawType === undefined
        ? typeof definition.url === "string" && definition.command === undefined
          ? "http"
          : "stdio"
        : typeof rawType === "string" && Object.hasOwn(TRANSPORTS, rawType)
          ? TRANSPORTS[rawType]
          : undefined;
    if (!type) {
      context.problems.push(
        `${where}: unsupported transport ${String(rawType)}`,
      );
      continue;
    }
    if (type !== "stdio") {
      if (
        definition.command !== undefined ||
        definition.args !== undefined ||
        definition.env !== undefined
      ) {
        context.problems.push(
          `${where}: remote servers cannot also declare command, args or env`,
        );
        continue;
      }
      const url = definition.url;
      const problem =
        typeof url !== "string" || variables(url).length
          ? "url must be a literal HTTP(S) URL"
          : remoteUrlProblem(url);
      if (problem || typeof url !== "string") {
        context.problems.push(`${where}: ${problem}`);
        continue;
      }
      result.push({
        name,
        type,
        url,
        ...headers(definition.headers, context, where, name),
      });
      continue;
    }
    if (definition.url !== undefined || definition.headers !== undefined) {
      context.problems.push(
        `${where}: stdio servers cannot declare url or headers`,
      );
      continue;
    }
    const started = launch(definition.command, definition.args, context, where);
    if (!started) continue;
    const args = started.args.map((raw) => argument(raw, context, where, true));
    if (args.some((item) => item === undefined)) continue;
    if (started.launch === "native") context.nativeEntries.add(started.entry);
    result.push({
      name,
      launch: started.launch,
      entry: started.entry,
      ...(args.length ? { args: args as ToolPackageArgument[] } : {}),
      ...environment(definition.env, context, where, name),
    });
  }
  return result;
}

function cliTools(
  value: unknown,
  context: Context,
  label: string,
): ToolPackageCli[] {
  if (!record(value) || !Array.isArray(value.cliTools)) {
    context.problems.push(`${label}: expected {"cliTools": [...]}`);
    return [];
  }
  const unknownFields = Object.keys(value).filter((key) => key !== "cliTools");
  if (unknownFields.length)
    context.problems.push(
      `${label}: unknown fields ${unknownFields.join(", ")}`,
    );
  const result: ToolPackageCli[] = [];
  for (const [index, item] of value.cliTools.entries()) {
    let where = `${label} cliTools[${index}]`;
    if (!record(item)) {
      context.problems.push(`${where}: must be an object`);
      continue;
    }
    const extra = Object.keys(item).filter(
      (key) =>
        !["name", "description", "entry", "launch", "args"].includes(key),
    );
    if (extra.length)
      context.problems.push(`${where}: unknown fields ${extra.join(", ")}`);
    if (
      typeof item.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/.test(item.name)
    ) {
      context.problems.push(
        `${where}: name must be 1-31 letters, digits, underscores or hyphens`,
      );
      continue;
    }
    where = `${label} CLI ${item.name}`;
    if (
      item.description !== undefined &&
      (typeof item.description !== "string" ||
        !item.description.length ||
        item.description.length > 512)
    ) {
      context.problems.push(`${where}: description must be 1-512 characters`);
      continue;
    }
    if (
      item.launch !== undefined &&
      item.launch !== "node" &&
      item.launch !== "native"
    ) {
      context.problems.push(`${where}: launch must be node or native`);
      continue;
    }
    if (typeof item.entry !== "string" || !item.entry.length) {
      context.problems.push(`${where}: entry must be a relative file path`);
      continue;
    }
    const resolved = entry(item.entry, context, where);
    if (!resolved) continue;
    if (item.args !== undefined && !Array.isArray(item.args)) {
      context.problems.push(`${where}: args must be an array`);
      continue;
    }
    const args = ((item.args as unknown[] | undefined) ?? []).map((raw) =>
      argument(raw, context, where, false),
    );
    if (args.some((value) => value === undefined)) continue;
    const started: "node" | "native" =
      item.launch ?? (resolved.node ? "node" : "native");
    if (started === "native") context.nativeEntries.add(resolved.relative);
    result.push({
      name: item.name,
      ...(typeof item.description === "string"
        ? { description: item.description }
        : {}),
      launch: started,
      entry: resolved.relative,
      ...(args.length ? { args: args as ToolPackageArgument[] } : {}),
    });
  }
  return result;
}

interface ResolvedSource {
  kind: ToolPackImportKind;
  /** Canonical source directory (the file's directory for a single file). */
  directory: string;
  /** Set when the source is one file. */
  file?: string;
  /** The directory holds `tool-package.json` and is used unchanged. */
  declared: boolean;
}

/** Shared input validation of {@link importLocal} and {@link inspectImport}. */
async function resolveSource(
  source: string,
  options: ToolPackImportOptions,
): Promise<ResolvedSource> {
  const kind = options.kind ?? "auto";
  if (!importKinds.includes(kind))
    throw sourceError("kind must be auto, skills, mcp or cli");
  if (options.id !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(options.id))
    throw sourceError(
      "id must start with a lower-case letter and contain at most 32 lower-case letters, digits or hyphens",
    );
  if (
    options.version !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.version)
  )
    throw sourceError(
      "version must be 1-64 letters, digits, dots, underscores or hyphens",
    );
  if (
    options.displayName !== undefined &&
    (!options.displayName.trim() || options.displayName.length > 128)
  )
    throw sourceError("displayName must be 1-128 characters");
  if (!path.isAbsolute(source))
    throw sourceError("source must be an absolute local directory or file");
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if (missing(error)) throw sourceError("source does not exist");
    throw error;
  }
  if (info.isSymbolicLink())
    throw sourceError("source cannot be a symbolic link or junction");
  if (!info.isFile() && !info.isDirectory())
    throw sourceError("source must be a regular directory or file");
  const file = info.isFile() ? path.basename(source) : undefined;
  const directory = await canonicalDirectory(
    file ? path.dirname(path.resolve(source)) : source,
  );
  let declared = false;
  if ((!file || file === MANIFEST_NAME) && kind === "auto") {
    const manifest = await lstat(path.join(directory, MANIFEST_NAME)).catch(
      (error: unknown) => {
        if (missing(error)) return undefined;
        throw error;
      },
    );
    if (manifest) {
      if (options.id || options.version || options.displayName)
        throw sourceError(
          "id, version and displayName come from the directory's tool-package.json",
        );
      declared = true;
    }
  }
  return { kind, directory, ...(file ? { file } : {}), declared };
}

function declaredCounts(manifest: ToolPackageManifest) {
  return {
    skills: manifest.skills?.length ?? 0,
    mcp: manifest.mcpServers?.length ?? 0,
    cli: manifest.cliTools?.length ?? 0,
  };
}

/**
 * Imports an explicit local source into the package store without executing
 * anything or contacting the network.
 *
 * - A directory holding `tool-package.json` is installed unchanged (kind auto).
 * - Otherwise the manifest is generated: every `SKILL.md` directory with its
 *   resources (links, version control and node_modules skipped), MCP JSON in
 *   Claude Desktop/Cursor (`mcpServers`) or VS Code (`servers`) form and
 *   `cli.json` (`cliTools`), with sizes, SHA-256 and executable flags.
 * - Configuration files and `.env` files are never copied; secret-looking env
 *   or header values become environment references reported as warnings.
 * - Runtime downloaders (npx, uvx, pipx, bunx, ...), PATH commands and files
 *   outside the source are rejected, all problems in one error.
 *
 * Sources are read twice (hash, then copy); a change in between fails with
 * TOOL_PACKAGE_CHANGED and registers nothing.
 */
export async function importLocal(
  source: string,
  root: string,
  options: ToolPackImportOptions = {},
): Promise<ToolPackImportResult> {
  const resolved = await resolveSource(source, options);
  if (resolved.declared) {
    const installed = await installLocal(resolved.directory, root);
    return {
      installed,
      format: "tool-package",
      counts: declaredCounts(installed.manifest),
      warnings: [],
    };
  }
  const reader = await PackageReader.create();
  try {
    const planned = await generate(
      resolved.directory,
      resolved.file,
      resolved.kind,
      options,
      reader,
    );
    const installed = await installGenerated(
      planned.manifest,
      (declared) =>
        reader.read(
          planned.files.get(declared.path)!.absolute,
          limits.fileBytes,
          { allowHardLinks: true },
        ),
      root,
    );
    return {
      installed,
      format: "generated",
      counts: planned.counts,
      warnings: planned.warnings,
    };
  } finally {
    await reader.close();
  }
}

/**
 * Computes what {@link importLocal} would register for `source` — identity,
 * digest, counts and warnings — with the same validation and errors, but
 * without creating, locking or changing any package store. Payload files are
 * read and hashed once; nothing is executed. Two calls return the same digest
 * exactly when `importLocal` would register the same content, so callers can
 * detect a changed source before deciding to import it.
 */
export async function inspectImport(
  source: string,
  options: ToolPackImportOptions = {},
): Promise<ToolPackImportInspection> {
  const resolved = await resolveSource(source, options);
  if (resolved.declared) {
    const inspection = await inspectLocal(resolved.directory);
    return {
      manifest: inspection.manifest,
      digest: inspection.digest,
      format: "tool-package",
      counts: declaredCounts(inspection.manifest),
      warnings: [],
    };
  }
  const reader = await PackageReader.create();
  try {
    const planned = await generate(
      resolved.directory,
      resolved.file,
      resolved.kind,
      options,
      reader,
    );
    const inspection = parseManifest(planned.manifest);
    return {
      manifest: inspection.manifest,
      digest: inspection.digest,
      format: "generated",
      counts: planned.counts,
      warnings: planned.warnings,
    };
  } finally {
    await reader.close();
  }
}

interface GeneratedImport {
  manifest: ToolPackageManifest;
  /** Payload files by package-relative path. */
  files: Map<string, { absolute: string }>;
  counts: { skills: number; mcp: number; cli: number };
  warnings: string[];
}

/** Builds the manifest of a simple-format source; registers nothing. */
async function generate(
  directory: string,
  file: string | undefined,
  kind: ToolPackImportKind,
  options: ToolPackImportOptions,
  reader: PackageReader,
): Promise<GeneratedImport> {
  const exclude = new Set<string>([MANIFEST_NAME]);
  const configs = new Map<string, unknown>();
  const mcpFiles: string[] = [];
  const cliFiles: string[] = [];
  let skills: string[] = [];
  if (file) {
    if (file === "SKILL.md" && (kind === "auto" || kind === "skills"))
      skills = ["SKILL.md"];
    else if (kind === "skills")
      throw sourceError(
        "A skills source must be a directory or a SKILL.md file",
      );
    else {
      const value = await readJson(reader, path.join(directory, file), file);
      if (
        (kind === "auto" || kind === "mcp") &&
        record(value) &&
        (value.mcpServers !== undefined || value.servers !== undefined)
      )
        mcpFiles.push(file);
      if (
        (kind === "auto" || kind === "cli") &&
        record(value) &&
        value.cliTools !== undefined
      )
        cliFiles.push(file);
      if (!mcpFiles.length && !cliFiles.length)
        throw sourceError(
          kind === "cli"
            ? `${file} does not contain cliTools`
            : kind === "mcp"
              ? `${file} does not contain mcpServers or servers`
              : `${file} contains neither mcpServers/servers nor cliTools`,
        );
      configs.set(file, value);
      exclude.add(file);
    }
  } else {
    if (kind === "auto" || kind === "skills")
      skills = await discoverSkills(directory);
    const present = async (relative: string) =>
      (
        await lstat(path.join(directory, nativePath(relative))).catch(
          (error: unknown) => {
            if (missing(error)) return undefined;
            throw error;
          },
        )
      )?.isFile() === true;
    if (kind === "auto" || kind === "mcp")
      for (const candidate of MCP_CONFIG_FILES)
        if (await present(candidate)) mcpFiles.push(candidate);
    if ((kind === "auto" || kind === "cli") && (await present(CLI_CONFIG_FILE)))
      cliFiles.push(CLI_CONFIG_FILE);
    for (const relative of [...mcpFiles, ...cliFiles]) {
      configs.set(
        relative,
        await readJson(
          reader,
          path.join(directory, nativePath(relative)),
          relative,
        ),
      );
      exclude.add(relative);
    }
    if (kind === "skills" && !skills.length)
      throw sourceError("No SKILL.md file was found in the source directory");
    if (kind === "mcp" && !mcpFiles.length)
      throw sourceError(
        `No MCP configuration found; expected one of ${MCP_CONFIG_FILES.join(", ")}`,
      );
    if (kind === "cli" && !cliFiles.length)
      throw sourceError(`No ${CLI_CONFIG_FILE} found in the source directory`);
    if (!skills.length && !mcpFiles.length && !cliFiles.length)
      throw sourceError(
        `No tool-package.json, SKILL.md, ${[...MCP_CONFIG_FILES, CLI_CONFIG_FILE].join(", ")} found in the source directory`,
      );
  }
  if (skills.length > 16)
    throw packageError(
      "TOOL_PACKAGE_TOO_LARGE",
      `Found ${skills.length} SKILL.md files; one package holds at most 16 Skills, import subdirectories separately`,
    );
  // Local programs may depend on any file below the root (node_modules too),
  // so their packages copy the whole directory. Otherwise only Skill
  // directories are copied.
  const needsFiles =
    cliFiles.length > 0 ||
    mcpFiles.some((relative) => declaresCommand(configs.get(relative)));
  const everything = needsFiles
    ? await scan(directory, [""], { nodeModules: true, exclude })
    : undefined;
  const context: Context = {
    root: directory,
    base: directory,
    files: everything ?? {
      files: new Map(),
      directories: new Set(),
      warnings: [],
    },
    problems: [],
    warnings: [],
    defaults: new Map(),
    nativeEntries: new Set(),
  };
  const baseOf = (relative: string) =>
    path.dirname(path.join(directory, nativePath(relative)));
  const servers = mcpFiles.flatMap((relative) =>
    mcpServers(
      configs.get(relative),
      { ...context, base: baseOf(relative) },
      relative,
    ),
  );
  const tools = cliFiles.flatMap((relative) =>
    cliTools(
      configs.get(relative),
      { ...context, base: baseOf(relative) },
      relative,
    ),
  );
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.name.toLowerCase()))
      context.problems.push(
        `MCP server ${server.name} is declared more than once`,
      );
    seen.add(server.name.toLowerCase());
  }
  const toolNames = new Set(tools.map((tool) => tool.name.toLowerCase()));
  if (toolNames.size !== tools.length)
    context.problems.push("CLI tool names must be unique");
  if (servers.length > (tools.length ? 15 : 16))
    context.problems.push(
      `Found ${servers.length} MCP servers; a package holds at most 16 (15 when it also has CLI tools)`,
    );
  if (tools.length > 16)
    context.problems.push(`Found ${tools.length} CLI tools; the limit is 16`);
  if (context.problems.length)
    throw packageError(
      "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
      context.problems.length === 1
        ? context.problems[0]!
        : `${context.problems.length} problems: ${context.problems.join("; ")}`,
    );
  const local = tools.length > 0 || servers.some(isStdioMcp);
  const payload =
    local && everything
      ? everything
      : await scan(
          directory,
          skills.map((skill) => {
            const parent = path.posix.dirname(skill);
            return parent === "." ? "" : parent;
          }),
          { nodeModules: false, exclude },
        );
  for (const skill of skills) {
    const found = payload.files.get(skill);
    if (!found || found.size > 65536)
      throw packageError(
        "INVALID_TOOL_PACKAGE",
        `${skill} must be a regular file no larger than 64 KiB`,
      );
  }
  const files: ToolPackageFile[] = [];
  for (const [relative, found] of [...payload.files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const bytes = await reader.read(found.absolute, limits.fileBytes, {
      allowHardLinks: true,
    });
    files.push({
      path: relative,
      size: bytes.length,
      sha256: hash(bytes),
      ...(context.nativeEntries.has(relative) || found.executable
        ? { executable: true }
        : {}),
    });
  }
  const name =
    file && file !== "SKILL.md" && !GENERIC_CONFIG_NAMES.test(file)
      ? file.replace(/\.json$/i, "")
      : path.basename(directory);
  const id =
    options.id ?? (slug(name) || `pack-${hash(directory).slice(0, 10)}`);
  const displayName = (options.displayName ?? (name.trim() || id)).slice(
    0,
    128,
  );
  const declaration = {
    schemaVersion: 1 as const,
    id,
    displayName,
    files,
    ...(skills.length
      ? { skills: skills.map((skill) => ({ path: skill })) }
      : {}),
    ...(servers.length ? { mcpServers: servers } : {}),
    ...(tools.length ? { cliTools: tools } : {}),
    ...(context.defaults.size
      ? { defaultSecretBindings: Object.fromEntries(context.defaults) }
      : {}),
  };
  const manifest: ToolPackageManifest = {
    ...declaration,
    version:
      options.version ??
      `auto-${hash(canonicalJson(declaration)).slice(0, 12)}`,
  };
  return {
    manifest,
    files: payload.files,
    counts: { skills: skills.length, mcp: servers.length, cli: tools.length },
    warnings: [...payload.warnings, ...context.warnings],
  };
}
