import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isRelativeFilePath } from "../domain/files.js";
import { Ajv } from "ajv";
import {
  engineConfigurationSchema,
  type EngineConfiguration,
} from "../domain/engine-configuration.js";
import type { BundleManifest, BundledEngine } from "./types.js";

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(`${label} must be non-empty text`);
  return value;
}
export function keys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`Unknown ${label} field: ${key}`);
}
/** Resolve a manifest path without allowing drive names, traversal or an external root. */
export function bundlePath(root: string, value: unknown): string {
  const name = string(value, "bundle path").replaceAll("\\", "/");
  if (!isRelativeFilePath(name))
    throw new Error(`Invalid bundle-relative path: ${name}`);
  return path.join(root, ...name.split("/"));
}
const validConfiguration = new Ajv({
  allErrors: true,
}).compile<EngineConfiguration>(engineConfigurationSchema);
function engine(value: unknown): BundledEngine {
  const row = object(value, "bundled engine");
  keys(
    row,
    [
      "id",
      "name",
      "version",
      "driver",
      "command",
      "env",
      "configuration",
      "cli",
      "acp",
      "credentialEnv",
      "requiredFiles",
      "notes",
    ],
    "engine",
  );
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(string(row.id, "engine id")))
    throw new Error("Invalid engine id");
  string(row.name, "engine name");
  string(row.version, "engine version");
  if (row.driver !== "acp" && row.driver !== "cli")
    throw new Error("Unsupported bundled driver");
  if (
    !Array.isArray(row.command) ||
    !row.command.length ||
    row.command.length > 128
  )
    throw new Error("Invalid bundled command");
  for (const arg of row.command) string(arg, "command argument");
  if (row.env !== undefined)
    for (const [name, value] of Object.entries(object(row.env, "engine env"))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error("Invalid bundle environment name");
      string(value, "engine env value");
    }
  for (const field of ["requiredFiles", "credentialEnv", "notes"] as const) {
    if (row[field] !== undefined) {
      if (!Array.isArray(row[field]))
        throw new Error(`${field} must be an array`);
      for (const entry of row[field]) string(entry, field);
    }
  }
  const result: BundledEngine = {
    id: string(row.id, "engine id"),
    name: string(row.name, "engine name"),
    version: string(row.version, "engine version"),
    driver: row.driver,
    command: row.command.map((arg: unknown) => string(arg, "command argument")),
  };
  if (row.env !== undefined)
    result.env = Object.fromEntries(
      Object.entries(object(row.env, "engine env")).map(([key, value]) => [
        key,
        string(value, "engine env value"),
      ]),
    );
  if (row.configuration !== undefined) {
    if (!validConfiguration(row.configuration))
      throw new Error("Invalid bundled engine configuration");
    result.configuration = row.configuration;
  }
  if (row.cli !== undefined) {
    const cli = object(row.cli, "CLI");
    keys(cli, ["inputMode", "maxOutputBytes"], "CLI");
    result.cli = {};
    if (cli.inputMode !== undefined) {
      if (cli.inputMode !== "stdin" && cli.inputMode !== "argv")
        throw new Error("Invalid CLI inputMode");
      result.cli.inputMode = cli.inputMode;
    }
    if (cli.maxOutputBytes !== undefined) {
      if (
        !Number.isSafeInteger(cli.maxOutputBytes) ||
        Number(cli.maxOutputBytes) <= 0
      )
        throw new Error("Invalid CLI output limit");
      result.cli.maxOutputBytes = Number(cli.maxOutputBytes);
    }
  }
  if (row.acp !== undefined) {
    const acp = object(row.acp, "ACP");
    keys(acp, ["sessionMode", "initializeTimeoutMs"], "ACP");
    result.acp = {};
    if (acp.sessionMode !== undefined) {
      if (acp.sessionMode !== "resume")
        throw new Error("Invalid ACP session mode");
      result.acp.sessionMode = "resume";
    }
    if (acp.initializeTimeoutMs !== undefined) {
      if (
        !Number.isInteger(acp.initializeTimeoutMs) ||
        Number(acp.initializeTimeoutMs) < 1 ||
        Number(acp.initializeTimeoutMs) > 60000
      )
        throw new Error("Invalid ACP initialization timeout");
      result.acp.initializeTimeoutMs = Number(acp.initializeTimeoutMs);
    }
  }
  for (const field of ["requiredFiles", "credentialEnv", "notes"] as const)
    if (Array.isArray(row[field]))
      result[field] = row[field].map((entry: unknown) => string(entry, field));
  return result;
}
/** Read the generated release inventory without executing any engine or parsing native authentication files. */
export async function readBundle(root: string): Promise<BundleManifest> {
  const location = path.join(root, "bundle.json");
  const info = await lstat(location);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
    throw new Error("Invalid bundle inventory");
  const value = object(
    JSON.parse(await readFile(location, "utf8")) as unknown,
    "bundle",
  );
  keys(
    value,
    [
      "schemaVersion",
      "platform",
      "arch",
      "nodeVersion",
      "consoleEntry",
      "engines",
      "components",
      "files",
    ],
    "bundle",
  );
  if (
    value.schemaVersion !== 1 ||
    value.platform !== "win32" ||
    (value.arch !== "arm64" && value.arch !== "x64")
  )
    throw new Error("Unsupported bundle format/platform");
  string(value.nodeVersion, "nodeVersion");
  bundlePath(root, value.consoleEntry);
  if (
    !Array.isArray(value.engines) ||
    !value.engines.length ||
    value.engines.length > 64
  )
    throw new Error("Bundle must include engines");
  const engines = value.engines.map(engine);
  if (new Set(engines.map((item) => item.id)).size !== engines.length)
    throw new Error("Duplicate bundled engine");
  if (
    !Array.isArray(value.components) ||
    !Array.isArray(value.files) ||
    !value.files.length
  )
    throw new Error("Bundle inventory is empty");
  const identities = new Set<string>();
  const files = value.files.map((entry: unknown) => {
    const file = object(entry, "inventory file");
    keys(file, ["path", "size", "sha256"], "inventory file");
    const relative = string(file.path, "file path");
    bundlePath(root, relative);
    const identity = relative
      .replaceAll("\\", "/")
      .normalize("NFC")
      .toLowerCase();
    if (
      identity === "bundle.json" ||
      identity.startsWith("state/") ||
      identities.has(identity)
    )
      throw new Error("Invalid/duplicate inventory identity");
    identities.add(identity);
    if (
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      !/^[a-f0-9]{64}$/.test(string(file.sha256, "SHA-256"))
    )
      throw new Error("Invalid inventory size/hash");
    return {
      path: relative,
      size: Number(file.size),
      sha256: String(file.sha256),
    };
  });
  for (const required of [
    String(value.consoleEntry),
    "runtime/node.exe",
    "scripts/launch-engine.mjs",
    ...engines.flatMap((item) => item.requiredFiles ?? []),
  ]) {
    bundlePath(root, required);
    if (
      !identities.has(
        required.replaceAll("\\", "/").normalize("NFC").toLowerCase(),
      )
    )
      throw new Error(
        `Required bundle file has no inventory hash: ${required}`,
      );
  }
  return {
    schemaVersion: 1,
    platform: "win32",
    arch: value.arch as "arm64" | "x64",
    nodeVersion: String(value.nodeVersion),
    consoleEntry: String(value.consoleEntry),
    engines,
    components: value.components,
    files,
  };
}
/** Verify immutable payload bytes; failures identify the file, never credentials or file contents. */
export async function verifyBundle(
  root: string,
  manifest: BundleManifest,
  full: boolean,
) {
  const physicalRoot = await realpath(root);
  let bytes = 0;
  for (const file of manifest.files) {
    const target = bundlePath(root, file.path);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size)
      throw new Error(`Bundle file changed: ${file.path}`);
    const physical = await realpath(target);
    const relative = path.relative(physicalRoot, physical);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error(`Bundle link escapes root: ${file.path}`);
    if (full) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(target))
        hash.update(chunk as Buffer);
      if (hash.digest("hex") !== file.sha256)
        throw new Error(`Bundle hash mismatch: ${file.path}`);
    }
    bytes += info.size;
  }
  return { files: manifest.files.length, bytes, hashesVerified: full };
}
