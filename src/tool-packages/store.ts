import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalDirectory,
  directories,
  inspectDirectory,
  missing,
  PackageReader,
  privateDirectory,
  removeStaging,
} from "./files.js";
import {
  canonicalJson,
  hash,
  MANIFEST_NAME,
  packageError,
} from "./manifest.js";
import type {
  InstalledToolPackage,
  ToolPackageInspection,
  ToolPackageRecord,
} from "./types.js";

function identity(id: string, version: string): string {
  if (
    !/^[a-z][a-z0-9-]{0,31}$/.test(id) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version)
  )
    throw packageError("INVALID_TOOL_PACKAGE", "Invalid package id or version");
  return hash(`${id}\0${version}`);
}
function parseRecord(input: unknown): ToolPackageRecord {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw packageError(
      "TOOL_PACKAGE_REGISTRY_CORRUPT",
      "Invalid package registration record",
    );
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      "digest,id,installedAt,schemaVersion,status,version" ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.installedAt !== "number" ||
    !Number.isSafeInteger(value.installedAt) ||
    value.installedAt < 0 ||
    (value.status !== "installed" && value.status !== "removed")
  )
    throw packageError(
      "TOOL_PACKAGE_REGISTRY_CORRUPT",
      "Unsupported or corrupt package registration record",
    );
  identity(value.id, value.version);
  return {
    schemaVersion: 1,
    id: value.id,
    version: value.version,
    digest: value.digest,
    installedAt: value.installedAt,
    status: value.status === "installed" ? "installed" : "removed",
  };
}
async function recordAt(
  root: string,
  id: string,
  version: string,
  reader: PackageReader,
): Promise<ToolPackageRecord | undefined> {
  try {
    const bytes = await reader.read(
      path.join(root, "records", `${identity(id, version)}.json`),
      16384,
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw packageError(
        "TOOL_PACKAGE_REGISTRY_CORRUPT",
        "Package record is not valid JSON",
      );
    }
    const record = parseRecord(value);
    if (record.id !== id || record.version !== version)
      throw packageError(
        "TOOL_PACKAGE_REGISTRY_CORRUPT",
        "Package record identity differs from its registration",
      );
    return record;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function writeExclusive(
  file: string,
  bytes: Buffer | string,
  mode = 0o600,
): Promise<void> {
  await directories(path.dirname(file), true);
  const handle = await open(file, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function publishRecord(
  root: string,
  record: ToolPackageRecord,
): Promise<void> {
  const directory = path.join(root, "records");
  const temporary = path.join(directory, `${randomUUID()}.pending`);
  await writeExclusive(temporary, canonicalJson(record) + "\n");
  const original = await lstat(temporary, { bigint: true });
  try {
    await rename(
      temporary,
      path.join(directory, `${identity(record.id, record.version)}.json`),
    );
  } finally {
    try {
      const current = await lstat(temporary, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== original.dev ||
        current.ino !== original.ino
      )
        throw packageError(
          "TOOL_PACKAGE_CHANGED",
          "Refusing to remove a replaced registry temporary file",
        );
      await unlink(temporary);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
async function mutation<T>(
  requestedRoot: string,
  action: (root: string, reader: PackageReader) => Promise<T>,
): Promise<T> {
  await privateDirectory(requestedRoot);
  const root = await canonicalDirectory(requestedRoot);
  const lock = path.join(root, ".mutation-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw packageError(
        "TOOL_PACKAGE_BUSY",
        "Another package mutation owns this store; a stale lock requires explicit recovery after verifying its owner has stopped",
      );
    throw error;
  }
  const identity = await lstat(lock, { bigint: true });
  let reader: PackageReader | undefined;
  try {
    reader = await PackageReader.create();
    await writeExclusive(
      path.join(lock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        startedAt: Date.now(),
      }),
    );
    for (const child of ["objects", "records", ".staging"])
      await directories(path.join(root, child), true);
    return await action(root, reader);
  } finally {
    await reader?.close();
    await directories(root);
    const current = await lstat(lock, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw packageError(
        "TOOL_PACKAGE_CHANGED",
        "Package mutation lock was replaced",
      );
    try {
      await unlink(path.join(lock, "owner.json"));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rmdir(lock);
  }
}

/** Inspects an explicit local directory and all payload hashes without executing anything. */
export async function inspectLocal(
  source: string,
): Promise<ToolPackageInspection> {
  const root = await canonicalDirectory(source);
  const reader = await PackageReader.create();
  try {
    return await inspectDirectory(root, reader);
  } finally {
    await reader.close();
  }
}

/** Copies stable bytes to a content object, then atomically registers it. Same identity/hash is idempotent. */
export async function installLocal(
  source: string,
  requestedRoot: string,
): Promise<InstalledToolPackage> {
  const sourceRoot = await canonicalDirectory(source);
  return mutation(requestedRoot, async (root, reader) => {
    const stage = await mkdtemp(path.join(root, ".staging", "install-"));
    const stageIdentity = await lstat(stage, { bigint: true });
    let published = false;
    try {
      const inspection = await inspectDirectory(
        sourceRoot,
        reader,
        async (file, bytes) =>
          writeExclusive(
            path.join(stage, ...file.path.split("/")),
            bytes,
            file.executable ? 0o700 : 0o600,
          ),
      );
      await writeExclusive(
        path.join(stage, MANIFEST_NAME),
        canonicalJson(inspection.manifest) + "\n",
      );
      const copy = await inspectDirectory(stage, reader);
      if (copy.digest !== inspection.digest)
        throw packageError(
          "TOOL_PACKAGE_INTEGRITY",
          "Copied package identity differs from its source",
        );
      const previous = await recordAt(
        root,
        inspection.manifest.id,
        inspection.manifest.version,
        reader,
      );
      if (previous && previous.digest !== inspection.digest)
        throw packageError(
          "TOOL_PACKAGE_VERSION_CONFLICT",
          "This id/version already identifies different bytes; publish a new version",
        );
      const object = path.join(root, "objects", inspection.digest);
      let exists = true;
      try {
        await canonicalDirectory(object);
      } catch (error) {
        if (!missing(error)) throw error;
        exists = false;
      }
      if (exists) {
        if (
          (await inspectDirectory(object, reader)).digest !== inspection.digest
        )
          throw packageError(
            "TOOL_PACKAGE_INTEGRITY",
            "Existing content object is corrupt",
          );
      } else {
        await directories(path.dirname(object));
        await rename(stage, object);
        published = true;
      }
      const record: ToolPackageRecord = {
        schemaVersion: 1,
        id: inspection.manifest.id,
        version: inspection.manifest.version,
        digest: inspection.digest,
        installedAt: previous?.installedAt ?? Date.now(),
        status: "installed",
      };
      await publishRecord(root, record);
      return { ...inspection, record };
    } finally {
      if (!published) await removeStaging(root, stage, stageIdentity);
    }
  });
}

/** Lists atomic registration records only; full content verification is an explicit operation. */
export async function listInstalled(
  requestedRoot: string,
  options: { includeRemoved?: boolean } = {},
): Promise<ToolPackageRecord[]> {
  let root: string;
  try {
    root = await canonicalDirectory(requestedRoot);
    await directories(path.join(root, "records"));
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const reader = await PackageReader.create();
  try {
    const records: ToolPackageRecord[] = [];
    for (const entry of await readdir(path.join(root, "records"), {
      withFileTypes: true,
    })) {
      if (entry.name.endsWith(".pending")) continue;
      if (
        !/^[a-f0-9]{64}\.json$/.test(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      )
        throw packageError(
          "TOOL_PACKAGE_REGISTRY_CORRUPT",
          "Unexpected package registry entry",
        );
      let value: unknown;
      try {
        value = JSON.parse(
          (
            await reader.read(path.join(root, "records", entry.name), 16384)
          ).toString("utf8"),
        ) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError)
          throw packageError(
            "TOOL_PACKAGE_REGISTRY_CORRUPT",
            "Package record is not valid JSON",
          );
        throw error;
      }
      const record = parseRecord(value);
      if (`${identity(record.id, record.version)}.json` !== entry.name)
        throw packageError(
          "TOOL_PACKAGE_REGISTRY_CORRUPT",
          "Package registry filename differs from identity",
        );
      if (record.status === "installed" || options.includeRemoved)
        records.push(record);
    }
    return records.sort((a, b) =>
      `${a.id}\0${a.version}`.localeCompare(`${b.id}\0${b.version}`, "en"),
    );
  } finally {
    await reader.close();
  }
}

/** Revalidates every payload byte. Removed installations cannot create new bindings. */
export async function verifyInstalled(
  requestedRoot: string,
  id: string,
  version: string,
): Promise<InstalledToolPackage> {
  identity(id, version);
  const root = await canonicalDirectory(requestedRoot);
  const reader = await PackageReader.create();
  try {
    const record = await recordAt(root, id, version, reader);
    if (!record || record.status !== "installed")
      throw packageError(
        "TOOL_PACKAGE_NOT_FOUND",
        "The requested tool package is not installed",
      );
    const inspection = await inspectDirectory(
      await canonicalDirectory(path.join(root, "objects", record.digest)),
      reader,
    );
    if (
      inspection.digest !== record.digest ||
      inspection.manifest.id !== id ||
      inspection.manifest.version !== version
    )
      throw packageError(
        "TOOL_PACKAGE_INTEGRITY",
        "Installed manifest differs from its registered identity",
      );
    return { ...inspection, record };
  } finally {
    await reader.close();
  }
}

/** Unregisters idempotently, retaining content objects required by existing engine revisions. */
export async function removeInstalled(
  requestedRoot: string,
  id: string,
  version: string,
): Promise<ToolPackageRecord> {
  identity(id, version);
  return mutation(requestedRoot, async (root, reader) => {
    const previous = await recordAt(root, id, version, reader);
    if (!previous)
      throw packageError(
        "TOOL_PACKAGE_NOT_FOUND",
        "The requested tool package is not installed",
      );
    const record: ToolPackageRecord = { ...previous, status: "removed" };
    if (previous.status !== "removed") await publishRecord(root, record);
    return record;
  });
}
