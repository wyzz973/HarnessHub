// SPDX-License-Identifier: MIT
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WiringError } from "./errors.js";

/** Lowercase hex SHA-256 of bytes. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A configuration file's location after following symlinks. */
export interface ResolvedFile {
  /** The path the agent reads; it may be a symlink, which wiring keeps. */
  path: string;
  /** Where bytes are written: the final symlink target, or `path` itself. */
  realPath: string;
}

/**
 * Resolves `file` through every symlink and requires the result to stay
 * inside one of `roots` (the explicit home, or a directory named by the
 * agent's own environment override), compared by real path. A symlink that
 * leaves them fails with WIRING_SYMLINK_ESCAPE instead of being followed; a
 * dangling symlink or a non-regular file fails with WIRING_NOT_REGULAR_FILE.
 * Missing trailing components are allowed: they are created on write.
 */
export async function resolveFile(
  file: string,
  roots: readonly string[],
): Promise<ResolvedFile> {
  const allowed = await Promise.all(roots.map(realExisting));
  const real = await realExisting(file);
  if (
    !allowed.some((root) => {
      const relative = path.relative(root, real);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      );
    })
  )
    throw new WiringError(
      "WIRING_SYMLINK_ESCAPE",
      "The configuration file resolves through a symlink to a location outside the home directory; wiring does not follow it",
      { path: file },
    );
  const target = await statOrUndefined(real);
  if (target && !target.isFile())
    throw new WiringError(
      "WIRING_NOT_REGULAR_FILE",
      "The configuration path is not a regular file",
      { path: file },
    );
  return { path: file, realPath: real };
}

/**
 * The real path of the deepest existing ancestor joined with the missing
 * rest. A dangling or looping symlink on the way is refused rather than
 * treated as a missing directory.
 */
async function realExisting(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (
        isCode(error, "ELOOP") ||
        (isCode(error, "ENOENT") && (await lstatOrUndefined(current)))
      )
        throw new WiringError(
          "WIRING_NOT_REGULAR_FILE",
          "The configuration path goes through a dangling or looping symlink",
          { path: current },
        );
      if (isCode(error, "ENOTDIR"))
        throw new WiringError(
          "WIRING_NOT_REGULAR_FILE",
          "A directory of the configuration path is a file",
          { path: current },
        );
      if (!isCode(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** The current bytes and metadata of a resolved file, or `exists: false`. */
export type FileState =
  | { exists: false }
  | {
      exists: true;
      bytes: Buffer;
      hash: string;
      mode: number;
      links: number;
      mtimeMs: number;
    };

export async function readState(realPath: string): Promise<FileState> {
  let bytes: Buffer;
  try {
    bytes = await readFile(realPath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return { exists: false };
    throw error;
  }
  const info = await stat(realPath);
  return {
    exists: true,
    bytes,
    hash: sha256(bytes),
    mode: info.mode & 0o7777,
    links: info.nlink,
    mtimeMs: info.mtimeMs,
  };
}

/** Text of a UTF-8 file, with its byte order mark recorded rather than edited. */
export function decodeText(
  bytes: Uint8Array,
  file: string,
): { text: string; bom: boolean } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bom ? bytes.subarray(3) : bytes,
      ),
      bom,
    };
  } catch {
    throw new WiringError(
      "WIRING_CONFIG_UNPARSEABLE",
      "The configuration file is not UTF-8 text",
      { path: file },
    );
  }
}

export function encodeText(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/**
 * Replaces the file at `realPath` with `bytes`. The bytes go to a temporary
 * file in the same directory, are flushed, get `mode`, and are renamed over
 * the target; a file with several hard links is instead rewritten in place so
 * that every link sees the change. Immediately before the replacement the
 * current content is compared with `expectedHash` (undefined: the file must
 * not exist) and a difference fails with WIRING_CONCURRENT_MODIFICATION,
 * leaving the file untouched. The temporary file is removed on failure.
 */
export async function writeAtomic(
  realPath: string,
  bytes: Uint8Array,
  options: { mode: number; expectedHash: string | undefined; inPlace: boolean },
): Promise<void> {
  if (options.inPlace) {
    await checkUnchanged(realPath, options.expectedHash);
    const handle = await open(realPath, "r+");
    try {
      await handle.truncate(0);
      await handle.write(bytes, 0, bytes.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const directory = path.dirname(realPath);
  const temporary = path.join(
    directory,
    `${temporaryPrefix(realPath)}${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", options.mode);
  try {
    try {
      await handle.writeFile(bytes);
      // The process umask may have narrowed the creation mode.
      await handle.chmod(options.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkUnchanged(realPath, options.expectedHash);
    await renameReplacing(temporary, realPath);
  } catch (error) {
    await unlink(temporary).catch((cleanup: unknown) => {
      if (!isCode(cleanup, "ENOENT")) throw cleanup;
    });
    throw error;
  }
  await syncDirectory(directory);
}

/**
 * Removes temporary files that an interrupted write of `realPath` left
 * behind. Only regular files named by this module's pattern are removed; the
 * caller holds the adapter's lock, so no write of this process is running.
 */
export async function removeStaleTemporaries(realPath: string): Promise<void> {
  const prefix = temporaryPrefix(realPath);
  let names: string[];
  try {
    names = await readdir(path.dirname(realPath));
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  for (const name of names) {
    if (
      !name.startsWith(prefix) ||
      !/^[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))
    )
      continue;
    const candidate = path.join(path.dirname(realPath), name);
    const info = await lstatOrUndefined(candidate);
    if (info?.isFile()) await unlink(candidate);
  }
}

function temporaryPrefix(realPath: string): string {
  return `.${path.basename(realPath)}.hh-wiring-`;
}

async function checkUnchanged(
  realPath: string,
  expectedHash: string | undefined,
): Promise<void> {
  const current = await readState(realPath);
  const same = current.exists
    ? current.hash === expectedHash
    : expectedHash === undefined;
  if (!same)
    throw new WiringError(
      "WIRING_CONCURRENT_MODIFICATION",
      "The configuration file changed while wiring was writing it; plan again",
      { path: realPath },
    );
}

async function renameReplacing(from: string, to: string): Promise<void> {
  // Windows refuses to replace a file that another process holds open
  // without delete sharing; such holders are usually brief (04 section 4).
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 5 ||
        !(
          isCode(error, "EPERM") ||
          isCode(error, "EBUSY") ||
          isCode(error, "EACCES")
        )
      )
        throw error;
      await delay(100);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows cannot open a directory for flushing; NTFS journals the rename.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    // Some file systems do not support flushing a directory; the rename is
    // still complete, only its durability across a power loss is unknown.
    if (!isCode(error, "EINVAL") && !isCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Creates the missing directories above `file`, outermost first, with mode
 * 0700 and returns the ones it created, so that removal can be limited to
 * them.
 */
export async function createParents(file: string): Promise<string[]> {
  const missing: string[] = [];
  for (
    let current = path.dirname(path.resolve(file));
    !(await lstatOrUndefined(current));
    current = path.dirname(current)
  )
    missing.unshift(current);
  for (const directory of missing) await mkdir(directory, { mode: 0o700 });
  return missing;
}

/** Removes the given directories, innermost first, while they are empty. */
export async function removeEmptyDirectories(
  directories: readonly string[],
): Promise<void> {
  for (const directory of [...directories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      if (isCode(error, "ENOTEMPTY") || isCode(error, "EEXIST")) return;
      throw error;
    }
  }
}

/** Deletes a file wiring created; a missing file is already deleted. */
export async function deleteFile(realPath: string): Promise<void> {
  try {
    await unlink(realPath);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

/**
 * Runs `action` while holding the cross-process lock of one adapter's
 * wiring, a directory under `<dataDir>/backups/wiring/<adapterId>/`. A held
 * lock fails with WIRING_BUSY; a stale lock left by a crashed process needs
 * explicit removal after checking that its owner (owner.json) has stopped.
 */
export async function withAdapterLock<T>(
  dataDir: string,
  adapterId: string,
  action: () => Promise<T>,
): Promise<T> {
  const directory = backupDirectory(dataDir, adapterId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (isCode(error, "EEXIST"))
      throw new WiringError(
        "WIRING_BUSY",
        `Another wiring operation for ${adapterId} holds its lock; a stale lock is removed by hand after checking that its owner has stopped`,
        { path: lock },
      );
    throw error;
  }
  const owner = path.join(lock, "owner.json");
  try {
    await writeFile(
      owner,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: "wx", mode: 0o600 },
    );
    return await action();
  } finally {
    await deleteFile(owner);
    await rmdir(lock);
  }
}

/** Where one adapter's backups and lock live. */
export function backupDirectory(dataDir: string, adapterId: string): string {
  return path.join(dataDir, "backups", "wiring", adapterId);
}

async function lstatOrUndefined(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function statOrUndefined(target: string) {
  try {
    return await stat(target);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
