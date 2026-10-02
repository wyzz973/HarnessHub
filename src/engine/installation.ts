import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import type { EngineProfile, JsonObject } from "../domain/types.js";
import { locateExecutable } from "./executables.js";
import { fileURLToPath } from "node:url";

const MAX_STARTUP_FILES = 8;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024;
const CODE_EXTENSION = /\.(?:[cm]?js|py|rb|sh|ps1|cmd|bat)$/i;
const PORTABLE_LAUNCHER = fileURLToPath(
  new URL("../../../scripts/launch-engine.mjs", import.meta.url),
);
const ENV_ASSIGNMENT = /^[a-zA-Z_][a-zA-Z0-9_]*=/;
const BOOLEAN_FLAGS = new Set([
  "--no-warnings",
  "--enable-source-maps",
  "--experimental-strip-types",
  "--disable-proto=throw",
  "--disable-proto=delete",
]);

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function unchanged(before: BigIntStats, after: BigIntStats) {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function failure(message: string, code = "ENGINE_INSTALLATION_INVALID") {
  return new HubError(code, message, 409);
}

async function executable(
  command: string,
  pathEnv: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (path.isAbsolute(command)) return command;
  if (command.includes("/") || command.includes("\\"))
    throw failure(
      "Relative engine launchers cannot be resolved without an explicit absolute path",
    );
  for (const directory of pathEnv.split(path.delimiter)) {
    signal?.throwIfAborted();
    const root = directory.replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(root)) continue;
    const candidate = await locateExecutable([command], [root]);
    signal?.throwIfAborted();
    if (candidate) return candidate;
  }
  throw failure(
    "Configured engine launcher was not found on the supplied PATH",
    "ENGINE_INSTALLATION_MISSING",
  );
}

async function launchFiles(
  command: string[],
  pathEnv: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const first = command[0];
  if (!first) throw failure("Engine has no configured launcher");
  const candidates = [await executable(first, pathEnv, signal)];
  let position = 1;
  const notes: string[] = [];
  if (command[1] === PORTABLE_LAUNCHER) {
    candidates.push(PORTABLE_LAUNCHER);
    position = 2;
    while (ENV_ASSIGNMENT.test(command[position] ?? "")) position++;
    if (command[position++] !== "--" || !command[position])
      throw failure("Portable launcher does not identify an engine executable");
    candidates.push(await executable(command[position++]!, pathEnv, signal));
  }
  if (path.basename(first) === "env") {
    for (; position < command.length; position++) {
      const item = command[position]!;
      if (item === "--") {
        position++;
        break;
      }
      if (
        ENV_ASSIGNMENT.test(item) ||
        item === "-i" ||
        item === "--ignore-environment"
      )
        continue;
      if (item === "-u" || item === "--unset") {
        position++;
        continue;
      }
      if (item.startsWith("--unset=")) continue;
      if (item.startsWith("-"))
        throw failure(
          "Engine installation inspection does not support this env launcher option",
        );
      break;
    }
    const actual = command[position++];
    if (!actual) throw failure("env does not identify an engine executable");
    candidates.push(await executable(actual, pathEnv, signal));
  }
  let flagValue = false;
  for (; position < command.length; position++) {
    const item = command[position]!;
    if (flagValue) {
      flagValue = false;
      continue;
    }
    if (ENV_ASSIGNMENT.test(item)) continue;
    if (item.startsWith("-")) {
      if (item === "--") break;
      flagValue = !item.includes("=") && !BOOLEAN_FLAGS.has(item);
      continue;
    }
    if (!CODE_EXTENSION.test(item)) continue;
    if (path.isAbsolute(item)) candidates.push(item);
    else if (!notes.includes("relative-script-paths-not-inspected"))
      notes.push("relative-script-paths-not-inspected");
  }
  return { candidates, notes };
}

async function readStable(
  file: string,
  limit: number,
  keepBytes: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const canonical = await realpath(file);
  signal?.throwIfAborted();
  const before = await lstat(canonical, { bigint: true });
  signal?.throwIfAborted();
  if (!before.isFile() || before.isSymbolicLink())
    throw failure("Configured startup path is not a regular file");
  if (before.size > BigInt(limit))
    throw failure(
      "Engine installation snapshot exceeds its bounded file limit",
      "ENGINE_INSTALLATION_TOO_LARGE",
    );
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal?.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!unchanged(before, opened))
      throw failure(
        "Engine startup file changed before inspection",
        "ENGINE_INSTALLATION_CHANGED",
      );
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, limit - size + 1),
        null,
      );
      signal?.throwIfAborted();
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit)
        throw failure(
          "Engine installation snapshot exceeds its bounded file limit",
          "ENGINE_INSTALLATION_TOO_LARGE",
        );
      hash.update(chunk.subarray(0, bytesRead));
      if (keepBytes) chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    const current = await lstat(canonical, { bigint: true });
    signal?.throwIfAborted();
    const currentPath = await realpath(file);
    signal?.throwIfAborted();
    if (
      !unchanged(opened, after) ||
      !unchanged(opened, current) ||
      BigInt(size) !== opened.size ||
      currentPath !== canonical
    )
      throw failure(
        "Engine startup file changed during inspection",
        "ENGINE_INSTALLATION_CHANGED",
      );
    return {
      canonical,
      size,
      mtimeMs: Number(opened.mtimeNs) / 1_000_000,
      sha256: hash.digest("hex"),
      bytes: keepBytes ? Buffer.concat(chunks) : undefined,
    };
  } finally {
    await handle.close();
  }
}

async function packageVersion(
  file: string,
  signal?: AbortSignal,
): Promise<JsonObject | null> {
  signal?.throwIfAborted();
  let directory = path.dirname(file);
  for (let depth = 0; depth < 3; depth++) {
    signal?.throwIfAborted();
    // A node_modules container is not the package owning a contained executable.
    if (path.basename(directory) === "node_modules") break;
    const manifest = path.join(directory, "package.json");
    let present: BigIntStats;
    try {
      present = await lstat(manifest, { bigint: true });
      signal?.throwIfAborted();
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
      continue;
    }
    if (!present.isFile() || present.isSymbolicLink())
      throw failure("Owning package manifest is not a regular file");
    const snapshot = await readStable(
      manifest,
      MAX_PACKAGE_BYTES,
      true,
      signal,
    );
    let value: unknown;
    try {
      value = JSON.parse(snapshot.bytes!.toString("utf8"));
    } catch {
      throw failure("Owning package manifest contains invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw failure("Owning package manifest must be an object");
    const name =
      "name" in value &&
      typeof value.name === "string" &&
      /^[a-zA-Z0-9@._/-]{1,255}$/.test(value.name)
        ? value.name
        : null;
    const version =
      "version" in value &&
      typeof value.version === "string" &&
      /^[a-zA-Z0-9.+_-]{1,128}$/.test(value.version)
        ? value.version
        : null;
    return { name, version };
  }
  return null;
}

/**
 * Reads a bounded snapshot of fixed launcher files without running commands or querying
 * providers. Composition supplies PATH; relative PATH entries, env assignments and flag
 * values are not read as files. Absolute positional code files are included. Binary
 * versions are never inferred from directory names; absent package metadata stays null.
 * Missing/replaced launch files or a limit violation fail explicitly. This identifies
 * local startup files, not all loaded dependencies or the eventual model in use.
 * Cancellation propagates the original AbortSignal reason and closes an opened file
 * after its in-flight bounded filesystem operation settles; no partial snapshot returns.
 */
export async function inspectEngineInstallation(
  profile: EngineProfile,
  options: { pathEnv: string; signal?: AbortSignal },
): Promise<JsonObject> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (profile.driver === "fake")
    return {
      source: "local-files",
      files: [],
      notes: ["fake-driver-has-no-external-launcher"],
    };
  if (!profile.command?.length)
    throw failure("Engine has no configured launcher");
  try {
    const { candidates, notes } = await launchFiles(
      profile.command,
      options.pathEnv,
      signal,
    );
    const seen = new Set<string>();
    const files: JsonObject[] = [];
    let remaining = MAX_TOTAL_BYTES;
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const resolved = await realpath(candidate);
      signal?.throwIfAborted();
      if (seen.has(resolved)) continue;
      if (seen.size >= MAX_STARTUP_FILES)
        throw failure(
          "Engine installation contains more than eight startup files",
          "ENGINE_INSTALLATION_TOO_LARGE",
        );
      const snapshot = await readStable(
        candidate,
        Math.min(MAX_FILE_BYTES, remaining),
        false,
        signal,
      );
      seen.add(snapshot.canonical);
      remaining -= snapshot.size;
      files.push({
        path: snapshot.canonical,
        size: snapshot.size,
        mtimeMs: snapshot.mtimeMs,
        sha256: snapshot.sha256,
        package: await packageVersion(snapshot.canonical, signal),
      });
    }
    signal?.throwIfAborted();
    return { source: "local-files", files, notes };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof HubError) throw error;
    if (isMissing(error))
      throw failure(
        "Configured engine startup file is missing",
        "ENGINE_INSTALLATION_MISSING",
      );
    throw failure("Engine installation files could not be inspected");
  }
}
