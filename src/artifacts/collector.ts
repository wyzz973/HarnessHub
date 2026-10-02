import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import { validateFileOutputs } from "../domain/files.js";
import type { ArtifactRecord, FileOutput, RunId } from "../domain/types.js";
import { WindowsFileSession } from "../platform/windows-file-session.js";
import { discardArtifacts, publishArtifactBytes } from "./publisher.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip": "application/zip",
};
type DirectoryIdentity = { path: string; dev: bigint; ino: bigint };

function errorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function directoryChain(
  root: string,
  relative: string,
): Promise<DirectoryIdentity[] | undefined> {
  const result: DirectoryIdentity[] = [];
  let directory = path.parse(root).root;
  const parts = [
    ...root.slice(directory.length).split(path.sep),
    ...relative.split("/").slice(0, -1),
  ];
  for (const part of parts) {
    if (part) directory = path.join(directory, part);
    let info: BigIntStats;
    try {
      info = await lstat(directory, { bigint: true });
    } catch (error) {
      if (errorCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new HubError(
        "INVALID_ARTIFACT_PATH",
        "Output ancestors must be regular directories",
        403,
      );
    result.push({ path: directory, dev: info.dev, ino: info.ino });
  }
  return result;
}

async function verifyChain(chain: DirectoryIdentity[]) {
  for (const entry of chain) {
    const info = await lstat(entry.path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== entry.dev ||
      info.ino !== entry.ino
    )
      throw new HubError(
        "ARTIFACT_CHANGED",
        "Output directory changed during collection",
        409,
      );
  }
}

function unchanged(before: BigIntStats, after: BigIntStats) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function readOutput(
  root: string,
  relative: string,
  remaining: number,
  signal: AbortSignal,
  windows: WindowsFileSession | undefined,
): Promise<Buffer | undefined> {
  signal.throwIfAborted();
  const chain = await directoryChain(root, relative);
  if (!chain) return undefined;
  const file = path.join(root, relative);
  let before: BigIntStats;
  try {
    before = await lstat(file, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (before.isSymbolicLink())
    throw new HubError(
      "INVALID_ARTIFACT_PATH",
      "Output files cannot be symlinks",
      403,
    );
  if (!before.isFile() || before.nlink !== 1n)
    throw new HubError(
      "ARTIFACT_NOT_REGULAR",
      "Output must be a regular file with one hard link",
    );
  if (before.size > BigInt(MAX_FILE_BYTES) || before.size > BigInt(remaining))
    throw new HubError(
      "ARTIFACT_TOO_LARGE",
      "Output exceeds the 16 MiB file or 64 MiB total limit",
      413,
    );
  const read = async () => {
    // O_NONBLOCK prevents a replacement FIFO from blocking open before fstat rejects it.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!unchanged(before, opened))
        throw new HubError(
          "ARTIFACT_CHANGED",
          "Output changed before it could be opened",
          409,
        );
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
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
      await verifyChain(chain);
      signal.throwIfAborted();
      if (
        !unchanged(opened, after) ||
        !unchanged(opened, current) ||
        length !== Number(opened.size)
      )
        throw new HubError(
          "ARTIFACT_CHANGED",
          "Output changed during collection",
          409,
        );
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  };
  return windows ? windows.withReadLock(file, read) : read();
}

/**
 * Collects only explicit workspace-relative outputs after the backend finishes. Missing
 * files are returned as names for independent grading. Unsafe, changing or oversized
 * files fail the whole collection and remove this call's unpublished files. The caller
 * owns Store registration and must discard returned records if commit loses a deadline
 * or cancellation race. This is bounded filesystem validation, not an OS sandbox.
 */
export function createFileArtifactCollector(root: string) {
  return async (
    runId: RunId,
    cwd: string,
    outputs: FileOutput[],
    signal: AbortSignal,
  ): Promise<{ artifacts: ArtifactRecord[]; missing: string[] }> => {
    validateFileOutputs(outputs);
    signal.throwIfAborted();
    const workspace = path.resolve(cwd);
    if (path.relative(await realpath(cwd), workspace) !== "")
      throw new HubError(
        "INVALID_ARTIFACT_PATH",
        "Workspace path must retain its registered canonical directory",
        403,
      );
    const artifacts: ArtifactRecord[] = [];
    const missing: string[] = [];
    let remaining = MAX_TOTAL_BYTES;
    const windows =
      process.platform === "win32"
        ? await WindowsFileSession.create(signal)
        : undefined;
    try {
      for (const output of outputs) {
        const bytes = await readOutput(
          workspace,
          output.path,
          remaining,
          signal,
          windows,
        );
        if (bytes === undefined) {
          missing.push(output.name);
          continue;
        }
        remaining -= bytes.length;
        artifacts.push(
          await publishArtifactBytes(
            root,
            runId,
            {
              name: output.name,
              mediaType:
                output.mediaType ??
                MEDIA_TYPES[path.extname(output.path).toLowerCase()] ??
                "application/octet-stream",
              bytes,
            },
            signal,
            windows,
          ),
        );
      }
      signal.throwIfAborted();
      return { artifacts, missing };
    } catch (error) {
      try {
        await discardArtifacts(root, artifacts);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "File collection and cleanup failed",
        );
      }
      if (error instanceof HubError || signal.aborted) throw error;
      if (
        errorCode(error, "ELOOP") ||
        errorCode(error, "ENOENT") ||
        errorCode(error, "ENOTDIR")
      )
        throw new HubError(
          "ARTIFACT_CHANGED",
          "Output path changed during collection",
          409,
        );
      throw new HubError(
        "ARTIFACT_IO_ERROR",
        "Output files could not be collected",
        500,
      );
    } finally {
      await windows?.close();
    }
  };
}
