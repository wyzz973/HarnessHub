// SPDX-License-Identifier: MIT
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WiringError } from "./errors.js";
import { backupDirectory, deleteFile, isCode, sha256 } from "./files.js";
import type { ConfigFormat, ConfigValue } from "./formats/index.js";

/** What a file looked like before HarnessHub first wired it. */
export type OriginalFile =
  | { existed: false }
  | {
      existed: true;
      /** SHA-256 of the original bytes, which are stored under this name. */
      sha256: string;
      size: number;
      mode: number;
      mtimeMs: number;
    };

/**
 * The backup of one wired file. It is content-addressed: its id is the
 * SHA-256 of its JSON text. It never holds a key value: values HarnessHub
 * wrote are kept as templates in which the gateway key and base URL are
 * placeholders.
 */
export interface BackupManifest {
  schemaVersion: 1;
  adapterId: string;
  fileId: string;
  format: ConfigFormat;
  /** The path the agent reads, as wired. */
  path: string;
  /** The directory a symlink of `path` may not leave (the home or an override). */
  root: string;
  /** The gateway URL wired; drift detection compares against it by default. */
  baseUrl: string;
  original: OriginalFile;
  /**
   * Whether the original bytes may be restored as they are when the file is
   * unchanged since wiring. False after re-wiring over a file the user had
   * edited since the previous wiring, whose edits a byte restore would lose.
   */
  byteRestore: boolean;
  /** Directories wiring created for this file, outermost first. */
  createdDirectories: string[];
  /** Every key path HarnessHub has written in this file; unwire restores these. */
  owned: string[][];
  /** The values of the latest wiring, as templates (see `KEY_PLACEHOLDER`). */
  expected: Array<{ path: string[]; value: ConfigValue }>;
  /** Entries the latest wiring removed so that they cannot override it; absent in older manifests. */
  absent?: string[][];
}

/** Stands for the gateway key in stored templates. */
export const KEY_PLACEHOLDER = "{{harnesshub:gateway-key}}";
/** Stands for the gateway base URL in stored templates. */
export const BASE_URL_PLACEHOLDER = "{{harnesshub:base-url}}";

/**
 * Stores original bytes under their SHA-256 (mode 0600, written to a
 * temporary file and renamed). Storing the same bytes twice is a no-op after
 * the stored copy is verified.
 */
export async function saveOriginal(
  dataDir: string,
  adapterId: string,
  bytes: Uint8Array,
): Promise<string> {
  const hash = sha256(bytes);
  const file = path.join(objects(dataDir, adapterId), hash);
  if (await matches(file, hash)) return hash;
  await storeExclusive(file, bytes);
  return hash;
}

/** The original bytes with the given hash; corrupt or missing copies fail. */
export async function readOriginal(
  dataDir: string,
  adapterId: string,
  hash: string,
): Promise<Buffer> {
  const file = path.join(objects(dataDir, adapterId), hash);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isCode(error, "ENOENT"))
      throw new WiringError(
        "WIRING_BACKUP_INVALID",
        "The backup of the original file is missing",
        { path: file },
      );
    throw error;
  }
  if (sha256(bytes) !== hash)
    throw new WiringError(
      "WIRING_BACKUP_INVALID",
      "The backup of the original file does not match its hash",
      { path: file },
    );
  return bytes;
}

/** Stores a manifest and returns its id. */
export async function saveManifest(
  dataDir: string,
  manifest: BackupManifest,
): Promise<string> {
  const text = JSON.stringify(manifest, null, 2) + "\n";
  const id = sha256(text);
  const file = path.join(manifests(dataDir, manifest.adapterId), `${id}.json`);
  if (!(await matches(file, id))) await storeExclusive(file, Buffer.from(text));
  return id;
}

/** Loads and validates a manifest; a missing, altered or malformed one fails. */
export async function readManifest(
  dataDir: string,
  adapterId: string,
  backupId: string,
): Promise<BackupManifest> {
  if (!/^[0-9a-f]{64}$/.test(backupId))
    throw new WiringError(
      "WIRING_RECORD_INVALID",
      "The wiring record names an invalid backup id",
    );
  const file = path.join(manifests(dataDir, adapterId), `${backupId}.json`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT"))
      throw new WiringError(
        "WIRING_BACKUP_INVALID",
        "The backup manifest of a wired file is missing",
        { path: file },
      );
    throw error;
  }
  if (sha256(text) !== backupId)
    throw new WiringError(
      "WIRING_BACKUP_INVALID",
      "The backup manifest does not match its id",
      { path: file },
    );
  const manifest = validManifest(JSON.parse(text) as unknown);
  if (!manifest || manifest.adapterId !== adapterId)
    throw new WiringError(
      "WIRING_BACKUP_INVALID",
      "The backup manifest is malformed",
      { path: file },
    );
  return manifest;
}

function validManifest(value: unknown): BackupManifest | undefined {
  if (!isObject(value)) return undefined;
  const original = value.original;
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) && items.every((item) => typeof item === "string");
  const validOriginal =
    isObject(original) &&
    (original.existed === false ||
      (original.existed === true &&
        typeof original.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(original.sha256) &&
        typeof original.size === "number" &&
        typeof original.mode === "number" &&
        typeof original.mtimeMs === "number"));
  const valid =
    value.schemaVersion === 1 &&
    typeof value.adapterId === "string" &&
    typeof value.fileId === "string" &&
    ["json", "toml", "yaml", "dotenv"].includes(value.format as string) &&
    typeof value.path === "string" &&
    typeof value.root === "string" &&
    typeof value.baseUrl === "string" &&
    validOriginal &&
    typeof value.byteRestore === "boolean" &&
    strings(value.createdDirectories) &&
    Array.isArray(value.owned) &&
    value.owned.every(strings) &&
    Array.isArray(value.expected) &&
    value.expected.every(
      (entry) => isObject(entry) && strings(entry.path) && "value" in entry,
    ) &&
    (value.absent === undefined ||
      (Array.isArray(value.absent) && value.absent.every(strings)));
  return valid ? (value as unknown as BackupManifest) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objects(dataDir: string, adapterId: string): string {
  return path.join(backupDirectory(dataDir, adapterId), "objects");
}

function manifests(dataDir: string, adapterId: string): string {
  return path.join(backupDirectory(dataDir, adapterId), "manifests");
}

async function matches(file: string, hash: string): Promise<boolean> {
  try {
    if (sha256(await readFile(file)) === hash) return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
  throw new WiringError(
    "WIRING_BACKUP_INVALID",
    "A stored backup does not match its hash",
    { path: file },
  );
}

async function storeExclusive(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, file);
  } catch (error) {
    await deleteFile(temporary);
    throw error;
  }
}
