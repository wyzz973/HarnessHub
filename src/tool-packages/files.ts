import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { HubError } from "../domain/errors.js";
import { WindowsFileSession } from "../platform/windows-file-session.js";
import { ensurePrivateDirectory } from "../platform/windows-acl.js";
import {
  hash,
  limits,
  MANIFEST_NAME,
  packageError,
  parseManifest,
} from "./manifest.js";
import type { ToolPackageFile, ToolPackageInspection } from "./types.js";

type Identity = { path: string; dev: bigint; ino: bigint };
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return (
    b.isFile() &&
    !b.isSymbolicLink() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.nlink === b.nlink &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Rejects links/reparse points on every ancestor, including the supplied root. */
export async function directories(
  directory: string,
  create = false,
): Promise<Identity[]> {
  if (!path.isAbsolute(directory))
    throw packageError(
      "INVALID_TOOL_PACKAGE_PATH",
      "An explicit absolute local directory is required",
    );
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  const result: Identity[] = [];
  const locations = [current];
  for (const part of absolute.slice(current.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    locations.push(current);
  }
  for (const location of locations) {
    let info: BigIntStats;
    try {
      info = await lstat(location, { bigint: true });
    } catch (error) {
      if (!create || !missing(error)) throw error;
      try {
        await mkdir(location, { mode: 0o700 });
      } catch (creationError) {
        if (!(
          creationError instanceof Error &&
          "code" in creationError &&
          creationError.code === "EEXIST"
        ))
          throw creationError;
      }
      info = await lstat(location, { bigint: true });
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw packageError(
        "INVALID_TOOL_PACKAGE_PATH",
        "Package directory ancestors must be regular directories without links",
      );
    result.push({ path: location, dev: info.dev, ino: info.ino });
  }
  return result;
}
async function verifyDirectories(chain: Identity[]): Promise<void> {
  for (const entry of chain) {
    const info = await lstat(entry.path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== entry.dev ||
      info.ino !== entry.ino
    )
      throw packageError(
        "TOOL_PACKAGE_CHANGED",
        "Package directory changed during access",
      );
  }
}
export async function canonicalDirectory(
  directory: string,
  create = false,
): Promise<string> {
  await directories(directory, create);
  const canonical = await realpath(directory);
  if (path.relative(canonical, path.resolve(directory)) !== "")
    throw packageError(
      "INVALID_TOOL_PACKAGE_PATH",
      "Package directory must retain its canonical identity",
    );
  return canonical;
}
export async function privateDirectory(directory: string): Promise<void> {
  await directories(directory, true);
  if (process.platform === "win32") await ensurePrivateDirectory(directory);
  else if (((await lstat(directory)).mode & 0o077) !== 0)
    throw packageError(
      "INVALID_TOOL_PACKAGE_PATH",
      "Package storage directory must be private",
    );
}

/** One operation owns the native read leases, bounded buffers, and awaited close. */
export class PackageReader {
  private constructor(
    private readonly windows: WindowsFileSession | undefined,
  ) {}
  static async create(): Promise<PackageReader> {
    return new PackageReader(
      process.platform === "win32"
        ? await WindowsFileSession.create(new AbortController().signal)
        : undefined,
    );
  }
  async close(): Promise<void> {
    await this.windows?.close();
  }
  async read(file: string, maximum: number): Promise<Buffer> {
    const chain = await directories(path.dirname(file));
    const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw packageError(
        "INVALID_TOOL_PACKAGE_PATH",
        "Package payloads must be regular files with one hard link",
      );
    if (before.size > BigInt(maximum))
      throw packageError(
        "TOOL_PACKAGE_TOO_LARGE",
        "Package file exceeds its declared size or resource limit",
      );
    const read = async () => {
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        if (!unchanged(before, opened))
          throw packageError(
            "TOOL_PACKAGE_CHANGED",
            "Package file changed before it could be opened",
          );
        const bytes = Buffer.alloc(Number(opened.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(
            bytes,
            length,
            Math.min(65536, bytes.length - length),
            null,
          );
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (
          !unchanged(opened, await handle.stat({ bigint: true })) ||
          !unchanged(opened, await lstat(file, { bigint: true })) ||
          length !== Number(opened.size)
        )
          throw packageError(
            "TOOL_PACKAGE_CHANGED",
            "Package file changed during access",
          );
        await verifyDirectories(chain);
        return bytes.subarray(0, length);
      } finally {
        await handle.close();
      }
    };
    try {
      return await (this.windows
        ? this.windows.withReadLock(file, read)
        : read());
    } catch (error) {
      if (error instanceof HubError && error.code === "ARTIFACT_CHANGED")
        throw packageError(
          "TOOL_PACKAGE_CHANGED",
          "Package bytes could not be held stable against Windows writers",
        );
      throw error;
    }
  }
}

/** Full manifest/hash validation; visitor receives exact stable bytes, never executable code. */
export async function inspectDirectory(
  root: string,
  reader: PackageReader,
  visitor?: (file: ToolPackageFile, bytes: Buffer) => Promise<void>,
): Promise<ToolPackageInspection> {
  const manifestBytes = await reader.read(
    path.join(root, MANIFEST_NAME),
    limits.manifestBytes,
  );
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    ) as unknown;
  } catch {
    throw packageError(
      "INVALID_TOOL_PACKAGE",
      "tool-package.json must be valid UTF-8 JSON",
    );
  }
  const inspection = parseManifest(input);
  const expected = new Map(
    inspection.manifest.files.map((file) => [file.path, file]),
  );
  const expectedDirectories = new Set<string>();
  for (const name of expected.keys()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      expectedDirectories.add(parts.slice(0, i).join("/"));
      if (expectedDirectories.size > 20_000)
        throw packageError(
          "TOOL_PACKAGE_TOO_LARGE",
          "Package exceeds 20,000 directories",
        );
    }
  }
  const found = new Set<string>();
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw packageError(
          "INVALID_TOOL_PACKAGE_PATH",
          "Package directories and files cannot contain links",
        );
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(name))
          throw packageError(
            "TOOL_PACKAGE_CONTENT_MISMATCH",
            "Package contains an undeclared directory",
          );
        await walk(name);
        continue;
      }
      if (name === MANIFEST_NAME) continue;
      const file = expected.get(name);
      if (!entry.isFile() || !file || found.has(name))
        throw packageError(
          "TOOL_PACKAGE_CONTENT_MISMATCH",
          "Package contains an undeclared or non-regular file",
        );
      const bytes = await reader.read(path.join(root, name), file.size);
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        throw packageError(
          "TOOL_PACKAGE_INTEGRITY",
          "Package payload size or SHA-256 differs from its manifest",
        );
      if (inspection.manifest.skills?.some((skill) => skill.path === name)) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw packageError(
            "INVALID_TOOL_PACKAGE",
            "Skill instructions must be valid UTF-8",
          );
        }
      }
      if (
        process.platform !== "win32" &&
        file.executable &&
        !((await lstat(path.join(root, name))).mode & 0o100)
      )
        throw packageError(
          "TOOL_PACKAGE_CONTENT_MISMATCH",
          "Declared executable is not owner-executable",
        );
      found.add(name);
      await visitor?.(file, bytes);
    }
  }
  await walk("");
  if (found.size !== expected.size)
    throw packageError(
      "TOOL_PACKAGE_CONTENT_MISMATCH",
      "Package is missing declared files",
    );
  if (
    !manifestBytes.equals(
      await reader.read(path.join(root, MANIFEST_NAME), limits.manifestBytes),
    )
  )
    throw packageError(
      "TOOL_PACKAGE_CHANGED",
      "Package manifest changed during inspection",
    );
  return inspection;
}

/** Removes only this operation's private staging directory after root/identity checks. */
export async function removeStaging(
  root: string,
  stage: string,
  identity: BigIntStats,
): Promise<void> {
  const resolved = await canonicalDirectory(stage);
  const relative = path.relative(root, resolved);
  const current = await lstat(resolved, { bigint: true });
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  )
    throw packageError(
      "TOOL_PACKAGE_CHANGED",
      "Refusing to remove a replaced staging directory",
    );
  await rm(resolved, { recursive: true });
}
