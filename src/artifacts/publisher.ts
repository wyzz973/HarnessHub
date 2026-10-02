import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import type { ArtifactId, ArtifactRecord, RunId } from "../domain/types.js";
import {
  ensurePrivateDirectories,
  verifyPrivatePaths,
} from "../platform/windows-acl.js";
import type { WindowsFileSession } from "../platform/windows-file-session.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
type DirectoryIdentity = { path: string; dev: bigint; ino: bigint };

function sameIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function directories(directory: string): Promise<DirectoryIdentity[]> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  const result: DirectoryIdentity[] = [];
  for (const part of absolute.slice(current.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new HubError(
        "INVALID_ARTIFACT_PATH",
        "Artifact directory is not a regular directory",
        403,
      );
    result.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return result;
}

async function verifyDirectories(chain: DirectoryIdentity[]) {
  for (const entry of chain) {
    const info = await lstat(entry.path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !sameIdentity(entry, info)
    )
      throw new HubError(
        "ARTIFACT_CHANGED",
        "Artifact directory changed during access",
        409,
      );
  }
}

async function privateDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  const info = await lstat(directory, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)
  )
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Artifact directory must be private and cannot be a symlink",
      403,
    );
}

async function artifactBase(root: string, create: boolean) {
  const absolute = path.resolve(root);
  const parent = await realpath(path.dirname(absolute));
  if (path.relative(parent, path.dirname(absolute)) !== "")
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Artifact root ancestors cannot be symlinks",
      403,
    );
  const directory = path.join(parent, path.basename(absolute));
  if (create) await privateDirectory(directory);
  await directories(directory);
  return directory;
}

function checkedPath(
  base: string,
  artifact: Pick<ArtifactRecord, "runId" | "id" | "path">,
) {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(artifact.runId) ||
    !/^[a-zA-Z0-9_-]+$/.test(artifact.id)
  )
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Invalid artifact identity",
      403,
    );
  const expected = path.join(base, artifact.runId, artifact.id);
  // Stored paths may use macOS's /var alias for /private/var. The caller's root is
  // canonicalized before new records are made; no artifact path is realpathed here.
  if (path.relative(path.resolve(artifact.path), expected) !== "")
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Artifact path differs from its registered identity",
      403,
    );
  return expected;
}

async function removeOwnedFile(
  file: string,
  chain: DirectoryIdentity[],
  identity: BigIntStats,
) {
  await verifyDirectories(chain);
  let info: BigIntStats;
  try {
    info = await lstat(file, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || !sameIdentity(identity, info))
    throw new HubError(
      "ARTIFACT_CHANGED",
      "Refusing to remove a replaced artifact",
      409,
    );
  await unlink(file);
}

/**
 * Publishes bounded bytes into an exclusive private file and fsyncs before returning.
 * The Gateway owns subsequent metadata registration; failures remove the unregistered
 * file, and callers must discard returned records if their registration does not commit.
 */
export async function publishArtifactBytes(
  root: string,
  runId: RunId,
  value: { name: string; mediaType: string; bytes: Buffer },
  signal?: AbortSignal,
  windows?: WindowsFileSession,
): Promise<ArtifactRecord> {
  signal?.throwIfAborted();
  if (value.bytes.length > MAX_FILE_BYTES)
    throw new HubError(
      "ARTIFACT_TOO_LARGE",
      "Artifact exceeds the 16 MiB file limit",
      413,
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(runId))
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Invalid artifact run identity",
      403,
    );
  const base = await artifactBase(root, true);
  const directory = path.join(base, runId);
  await privateDirectory(directory);
  const chain = await directories(directory);
  if (process.platform === "win32") {
    if (windows) await windows.ensurePrivateDirectories([base, directory]);
    else await ensurePrivateDirectories([base, directory]);
    await verifyDirectories(chain);
  }
  const id = randomUUID() as ArtifactId;
  const file = path.join(directory, id);
  const handle = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let identity: BigIntStats | undefined;
  try {
    identity = await handle.stat({ bigint: true });
    for (let offset = 0; offset < value.bytes.length;) {
      signal?.throwIfAborted();
      const { bytesWritten } = await handle.write(
        value.bytes,
        offset,
        Math.min(CHUNK_BYTES, value.bytes.length - offset),
      );
      if (bytesWritten === 0)
        throw new HubError(
          "ARTIFACT_IO_ERROR",
          "Artifact write made no progress",
          500,
        );
      offset += bytesWritten;
    }
    await handle.sync();
    await verifyDirectories(chain);
    const info = await lstat(file, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !sameIdentity(identity, info) ||
      info.nlink !== 1n ||
      info.size !== BigInt(value.bytes.length)
    )
      throw new HubError(
        "ARTIFACT_CHANGED",
        "Artifact changed during publication",
        409,
      );
    signal?.throwIfAborted();
    await handle.close();
    return {
      id,
      runId,
      name: value.name,
      mediaType: value.mediaType,
      size: value.bytes.length,
      sha256: createHash("sha256").update(value.bytes).digest("hex"),
      path: file,
      createdAt: Date.now(),
    };
  } catch (error) {
    await handle.close();
    try {
      if (identity) await removeOwnedFile(file, chain, identity);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Artifact publication and cleanup failed",
      );
    }
    throw error;
  }
}

/** Publishes complete text to an exclusive file; the caller commits the resulting metadata. */
export function createArtifactPublisher(root: string) {
  return async (
    runId: RunId,
    value: { name: string; mediaType: string; text: string },
  ): Promise<ArtifactRecord> => {
    if (Buffer.byteLength(value.text) > 4 * 1024 * 1024)
      throw new HubError(
        "ARTIFACT_TOO_LARGE",
        "Artifact exceeds the 4 MiB transport limit",
      );
    return publishArtifactBytes(root, runId, {
      name: path.basename(value.name),
      mediaType: value.mediaType,
      bytes: Buffer.from(value.text),
    });
  };
}

/**
 * Removes only unregistered records returned by this publisher. The Gateway must not
 * call this after a successful Store commit; every target is checked for root ownership.
 */
export async function discardArtifacts(
  root: string,
  artifacts: ArtifactRecord[],
): Promise<void> {
  if (!artifacts.length) return;
  const base = await artifactBase(root, false);
  const failures: unknown[] = [];
  for (const artifact of artifacts) {
    try {
      const file = checkedPath(base, artifact);
      const chain = await directories(path.dirname(file));
      const info = await lstat(file, { bigint: true });
      await removeOwnedFile(file, chain, info);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Unregistered artifact cleanup failed");
}

/** Reads registered content with bounded I/O and integrity verification before disclosure. */
export async function readArtifact(
  root: string,
  artifact: ArtifactRecord,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0 ||
    artifact.size > MAX_FILE_BYTES
  )
    throw new HubError(
      "ARTIFACT_CORRUPT",
      "Invalid registered artifact size",
      409,
    );
  const base = await artifactBase(root, false);
  // Previous text records were written using the configured root, which can contain
  // the platform's /var alias. Only that known root prefix is normalized for v1 data.
  const configuredFile = path.join(
    path.resolve(root),
    artifact.runId,
    artifact.id,
  );
  const legacyPath =
    process.platform === "darwin" && artifact.path.startsWith("/var/")
      ? `/private${artifact.path}`
      : artifact.path;
  const normalized =
    artifact.path === configuredFile
      ? { ...artifact, path: path.join(base, artifact.runId, artifact.id) }
      : { ...artifact, path: legacyPath };
  const file = checkedPath(base, normalized);
  const chain = await directories(path.dirname(file));
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Artifact must be a regular unlinked file",
      403,
    );
  if (process.platform === "win32") {
    await verifyPrivatePaths([base, path.dirname(file), file]);
    await verifyDirectories(chain);
  }
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameIdentity(before, opened) ||
      opened.size !== BigInt(artifact.size)
    )
      throw new HubError(
        "ARTIFACT_CORRUPT",
        "Artifact integrity check failed",
        409,
      );
    const bytes = Buffer.alloc(artifact.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        Math.min(CHUNK_BYTES, bytes.length - length),
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    await verifyDirectories(chain);
    if (
      length !== artifact.size ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      after.nlink !== 1n ||
      !sameIdentity(opened, after) ||
      !sameIdentity(opened, current) ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      opened.mtimeNs !== current.mtimeNs ||
      opened.ctimeNs !== current.ctimeNs ||
      current.size !== opened.size ||
      after.size !== opened.size ||
      createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !==
        artifact.sha256
    )
      throw new HubError(
        "ARTIFACT_CORRUPT",
        "Artifact integrity check failed",
        409,
      );
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
