// SPDX-License-Identifier: MIT
/**
 * HarnessHub-managed secrets: `{kind: "store", value: <uuid>}` references
 * (07-data-security section 4). Each secret has an entry file
 * `<dataDir>/secrets/v1/<id>.json` that names its backend:
 *
 * - `file`: the value encrypted with AES-256-GCM under a key derived (HKDF-SHA-256)
 *   from the 32-byte master key in `<configDir>/secrets.key`;
 * - `keychain` (macOS login keychain) or `dpapi` (Windows): the ID of an
 *   immutable item held by the platform helper, which this entry points to.
 *
 * Entries are replaced atomically (write, fsync, rename), so a reader sees the
 * old or the new value, never a mix. Rotation therefore keeps the reference:
 * the file backend re-encrypts under the next version; a native backend
 * creates a new item, switches the entry to it and then deletes the old item.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import type { ProcessLauncher } from "@harnesshub/core/process-launcher";
import { secretHelperPath } from "./native-helper.js";
import { helperRequest, resolveSecret, validSecretValue } from "./secrets.js";

export type SecretBackendKind = "keychain" | "dpapi" | "file";
/** The `secrets.backend` setting; `auto` picks the platform's default. */
export type SecretBackendSetting = "auto" | SecretBackendKind;

/**
 * The backend new secrets are created in. `auto` is the macOS Keychain on
 * macOS, DPAPI on Windows and the encrypted file elsewhere (the Linux Secret
 * Service backend of 07 section 4.1 is not implemented yet). Naming a native
 * backend on another platform fails; nothing falls back silently.
 *
 * @throws HubError `SECRET_BACKEND_UNAVAILABLE` (500).
 */
export function selectSecretBackend(
  setting: SecretBackendSetting,
  platform: NodeJS.Platform,
): SecretBackendKind {
  const native =
    platform === "darwin" ? "keychain" : platform === "win32" ? "dpapi" : null;
  switch (setting) {
    case "auto":
      return native ?? "file";
    case "file":
      return "file";
    case "keychain":
    case "dpapi":
      if (setting !== native)
        throw new HubError(
          "SECRET_BACKEND_UNAVAILABLE",
          `The ${setting} secret backend is not available on this platform; use "file"`,
          500,
        );
      return setting;
  }
}

const ENTRY_LIMIT = 65_536;
const KEY_FILE_LIMIT = 1_024;
const ALGORITHM = "A256GCM";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** POSIX ownership and mode checks; Windows relies on the directory ACL. */
const posix = process.platform !== "win32";

interface FileEntry {
  v: 1;
  id: string;
  version: number;
  backend: "file";
  alg: typeof ALGORITHM;
  kid: string;
  nonce: string;
  ct: string;
  tag: string;
  createdAt: string;
  rotatedAt?: string;
}

interface NativeEntry {
  v: 1;
  id: string;
  version: number;
  backend: "keychain" | "dpapi";
  /** The helper item that holds the current value. */
  item: string;
  /** Earlier items whose deletion failed; deleted again on the next write. */
  retired?: string[];
  createdAt: string;
  rotatedAt?: string;
}

type Entry = FileEntry | NativeEntry;

function unavailable(stage: string): HubError {
  const error = new HubError(
    "SECRET_UNAVAILABLE",
    "The credential reference is missing, locked or unreadable",
    400,
  );
  error.cause = { stage };
  return error;
}

/** Only the error code: file system messages carry paths. */
function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "unknown";
}

function writeFailed(stage: string, code: string): HubError {
  const error = new HubError(
    "SECRET_WRITE_FAILED",
    "The secret could not be stored or removed",
    500,
  );
  error.cause = { stage, code };
  return error;
}

function invalidValue(): HubError {
  return new HubError(
    "INVALID_SECRET",
    "Credential must be a non-empty single-line value up to 8 KiB",
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const base64url = (value: unknown, bytes?: number): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]+$/.test(value) &&
  (bytes === undefined || Buffer.from(value, "base64url").length === bytes);

function isEntry(value: unknown, id: string): value is Entry {
  if (
    !object(value) ||
    value.v !== 1 ||
    value.id !== id ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.createdAt !== "string" ||
    (value.rotatedAt !== undefined && typeof value.rotatedAt !== "string")
  )
    return false;
  if (value.backend === "file")
    return (
      value.alg === ALGORITHM &&
      typeof value.kid === "string" &&
      /^[0-9a-f]{16}$/.test(value.kid) &&
      base64url(value.nonce, 12) &&
      base64url(value.ct) &&
      base64url(value.tag, 16)
    );
  return (
    (value.backend === "keychain" || value.backend === "dpapi") &&
    typeof value.item === "string" &&
    UUID.test(value.item) &&
    (value.retired === undefined ||
      (Array.isArray(value.retired) &&
        value.retired.every(
          (item) => typeof item === "string" && UUID.test(item),
        )))
  );
}

/**
 * Open a regular file for reading without following a final symbolic link,
 * and check it from the open handle: on POSIX it must belong to this user and
 * give the group and others no access.
 */
async function readPrivateFile(
  file: string,
  limit: number,
): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      return undefined;
    throw unavailable("open");
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > limit ||
      (posix && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw unavailable("permissions");
    return await handle.readFile();
  } catch (error) {
    throw error instanceof HubError ? error : unavailable("read");
  } finally {
    await handle.close();
  }
}

/** Write `content` to `dir/name` atomically: temporary file, fsync, rename, fsync the directory. */
async function replaceFile(
  dir: string,
  name: string,
  content: string | Buffer,
): Promise<void> {
  const temporary = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(dir, name));
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Secret write and cleanup failed",
      );
    }
    throw error;
  }
  await syncDirectory(dir);
}

async function syncDirectory(dir: string): Promise<void> {
  // Windows cannot open a directory for fsync; NTFS commits the rename itself.
  if (!posix) return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    (posix && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new HubError(
      "SECRET_STORE_INSECURE",
      "The secret directory must be a private directory of this user (0700)",
      500,
    );
}

interface MasterKey {
  kid: string;
  dataKey: Buffer;
}

function deriveKey(master: Buffer): MasterKey {
  const kid = createHash("sha256")
    .update("harnesshub secrets kid v1")
    .update(master)
    .digest("hex")
    .slice(0, 16);
  return {
    kid,
    dataKey: Buffer.from(
      hkdfSync(
        "sha256",
        master,
        Buffer.from(kid, "utf8"),
        Buffer.from("harnesshub secrets v1", "utf8"),
        32,
      ),
    ),
  };
}

/** `secrets.key`: base64 of 32 random bytes, one line. */
function parseMasterKey(content: Buffer): Buffer {
  const text = content.toString("utf8").trim();
  const key = Buffer.from(text, "base64");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text) || key.length !== 32)
    throw unavailable("key");
  return key;
}

function aad(id: string, version: number): Buffer {
  return Buffer.from(`harnesshub/secret/v1/${id}/${version}`, "utf8");
}

/** Seal `value` for entry `id` at `version`; the AAD binds both. */
function seal(
  key: MasterKey,
  id: string,
  version: number,
  value: string,
): Pick<FileEntry, "kid" | "nonce" | "ct" | "tag"> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.dataKey, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad(id, version));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    kid: key.kid,
    nonce: nonce.toString("base64url"),
    ct: ct.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function unseal(key: MasterKey, entry: FileEntry): string {
  if (entry.kid !== key.kid) throw unavailable("key");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key.dataKey,
      Buffer.from(entry.nonce, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(aad(entry.id, entry.version));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(entry.ct, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw unavailable("decrypt");
  }
}

export interface SecretStoreOptions {
  /** Data root; entries are kept in `<dataDir>/secrets/v1`. */
  dataDir: string;
  /** Config root; the file backend's master key is `<configDir>/secrets.key`. */
  configDir: string;
  /** Backend for new secrets; `auto` by default (see `selectSecretBackend`). */
  backend?: SecretBackendSetting;
  /** Starts the platform helper; required when a native backend is used. */
  launcher?: ProcessLauncher;
}

/**
 * Store of `store` references. One process (the daemon) writes a data root;
 * writes to one secret are serialized within the process. Values exist only
 * in the caller's memory; errors never carry them, and file system details
 * are reduced to an error code.
 */
export class SecretStore {
  private readonly entries: string;
  private readonly keyFile: string;
  private readonly launcher: ProcessLauncher | undefined;
  private master: MasterKey | undefined;
  /** The last queued write per secret ID. */
  private readonly writes = new Map<string, Promise<unknown>>();

  private constructor(
    /** The backend new secrets are created in. */
    readonly backend: SecretBackendKind,
    options: SecretStoreOptions,
  ) {
    this.entries = path.join(options.dataDir, "secrets", "v1");
    this.keyFile = path.join(options.configDir, "secrets.key");
    this.launcher = options.launcher;
  }

  /**
   * Resolve the backend and prepare the private entry directory. The file
   * backend's master key is read, or generated with mode 0600, on first use.
   *
   * @throws HubError `SECRET_BACKEND_UNAVAILABLE` (500) for a backend this
   *   platform or build lacks (no helper binary, no launcher);
   *   `SECRET_STORE_INSECURE` (500) when the entry directory is not private.
   */
  static async open(options: SecretStoreOptions): Promise<SecretStore> {
    const backend = selectSecretBackend(
      options.backend ?? "auto",
      process.platform,
    );
    if (backend !== "file") {
      const helper = secretHelperPath(
        backend === "keychain" ? "darwin" : "win32",
      );
      if (!options.launcher || !existsSync(helper))
        throw new HubError(
          "SECRET_BACKEND_UNAVAILABLE",
          `The ${backend} secret helper is not available; use the "file" backend`,
          500,
        );
    }
    const store = new SecretStore(backend, options);
    await privateDirectory(store.entries);
    return store;
  }

  /**
   * Store a new value and return its reference. The value must be non-empty,
   * single-line and at most 8 KiB (`INVALID_SECRET`).
   *
   * @throws HubError `SECRET_WRITE_FAILED` (500) when nothing usable was stored.
   */
  async create(value: string): Promise<SecretReference> {
    if (!validSecretValue(value)) throw invalidValue();
    const id = randomUUID();
    const now = new Date().toISOString();
    if (this.backend === "file") {
      const key = await this.key(true);
      await this.writeEntry({
        v: 1,
        id,
        version: 1,
        backend: "file",
        alg: ALGORITHM,
        ...seal(key, id, 1, value),
        createdAt: now,
      });
    } else {
      const item = await this.createItem(value);
      try {
        await this.writeEntry({
          v: 1,
          id,
          version: 1,
          backend: this.backend,
          item,
          createdAt: now,
        });
      } catch (error) {
        await this.deleteItems(this.backend, [item], error);
        throw error;
      }
    }
    return { kind: "store", value: id };
  }

  /**
   * Replace the value under the same reference, in the backend the secret
   * already uses. Readers see the old or the new value until this resolves
   * and the new one afterwards. A native backend's old item is deleted after
   * the switch; if that fails it is recorded and deleted on the next write.
   *
   * @throws HubError `SECRET_UNAVAILABLE` (400) when the reference does not
   *   exist; `INVALID_SECRET`; `SECRET_WRITE_FAILED` (500), leaving the
   *   previous value in place.
   */
  async rotate(ref: SecretReference, value: string): Promise<void> {
    if (!validSecretValue(value)) throw invalidValue();
    const id = this.id(ref);
    await this.serialized(id, async () => {
      const entry = await this.readEntry(id);
      const now = new Date().toISOString();
      const version = entry.version + 1;
      if (entry.backend === "file") {
        const key = await this.key(false);
        await this.writeEntry({
          ...entry,
          version,
          ...seal(key, id, version, value),
          rotatedAt: now,
        });
        return;
      }
      const item = await this.createItem(value, entry.backend);
      const stale = [entry.item, ...(entry.retired ?? [])];
      try {
        await this.writeEntry({
          ...entry,
          version,
          item,
          retired: stale,
          rotatedAt: now,
        });
      } catch (error) {
        await this.deleteItems(entry.backend, [item], error);
        throw error;
      }
      const remaining = await this.tryDeleteItems(entry.backend, stale);
      const { retired: _previous, ...current } = entry;
      await this.writeEntry({
        ...current,
        version,
        item,
        rotatedAt: now,
        ...(remaining.length ? { retired: remaining } : {}),
      });
    });
  }

  /**
   * Delete the secret: its native items, then its entry. Returns false when
   * the reference does not exist. A failure leaves the entry, so the delete
   * can be repeated.
   */
  async delete(ref: SecretReference): Promise<boolean> {
    const id = this.id(ref);
    return this.serialized(id, async () => {
      const entry = await this.findEntry(id);
      if (!entry) return false;
      if (entry.backend !== "file") {
        const remaining = await this.tryDeleteItems(entry.backend, [
          entry.item,
          ...(entry.retired ?? []),
        ]);
        if (remaining.length) throw writeFailed("helper", "delete");
      }
      try {
        await rm(this.entryPath(id));
        await syncDirectory(this.entries);
      } catch (error) {
        throw writeFailed("entry", errorCode(error));
      }
      return true;
    });
  }

  /**
   * Resolve any reference kind: `store` from this store, `env`, `file` and
   * `keychain` as `resolveSecret` does. The caller owns the value and must
   * not log it.
   *
   * @throws HubError `SECRET_UNAVAILABLE` (400) with `cause.stage` only.
   */
  async resolve(
    ref: SecretReference,
    environment: Readonly<NodeJS.ProcessEnv>,
  ): Promise<string> {
    if (ref.kind !== "store")
      return resolveSecret(ref, environment, this.launcher);
    const entry = await this.readEntry(this.id(ref));
    const value =
      entry.backend === "file"
        ? unseal(await this.key(false), entry)
        : await this.readItem(entry.backend, entry.item);
    if (!validSecretValue(value)) throw unavailable("value");
    return value;
  }

  private id(ref: SecretReference): string {
    if (ref.kind !== "store" || !UUID.test(ref.value))
      throw unavailable("reference");
    return ref.value;
  }

  private entryPath(id: string): string {
    return path.join(this.entries, `${id}.json`);
  }

  private async serialized<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(id, settled);
    try {
      return await result;
    } finally {
      if (this.writes.get(id) === settled) this.writes.delete(id);
    }
  }

  private async readEntry(id: string): Promise<Entry> {
    const entry = await this.findEntry(id);
    if (!entry) throw unavailable("missing");
    return entry;
  }

  private async findEntry(id: string): Promise<Entry | undefined> {
    const content = await readPrivateFile(this.entryPath(id), ENTRY_LIMIT);
    if (!content) return undefined;
    let entry: unknown;
    try {
      entry = JSON.parse(content.toString("utf8"));
    } catch {
      throw unavailable("entry");
    }
    if (!isEntry(entry, id)) throw unavailable("entry");
    return entry;
  }

  private async writeEntry(entry: Entry): Promise<void> {
    try {
      await replaceFile(
        this.entries,
        `${entry.id}.json`,
        JSON.stringify(entry),
      );
    } catch (error) {
      throw writeFailed("entry", errorCode(error));
    }
  }

  /**
   * The master key, generated on first use when `create` is true. A new key
   * is written to a temporary file and hard-linked into place, so concurrent
   * first uses agree on one complete key file.
   */
  private async key(create: boolean): Promise<MasterKey> {
    if (this.master) return this.master;
    let content = await readPrivateFile(this.keyFile, KEY_FILE_LIMIT);
    if (!content && create) {
      const directory = path.dirname(this.keyFile);
      const temporary = path.join(
        directory,
        `.secrets.key.${randomUUID()}.tmp`,
      );
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${randomBytes(32).toString("base64")}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, this.keyFile);
        } catch (error) {
          // Another first use won; its key is complete and is read below.
          if (errorCode(error) !== "EEXIST") throw error;
        }
        await rm(temporary);
        await syncDirectory(directory);
      } catch (error) {
        const failure = writeFailed("key", errorCode(error));
        try {
          await rm(temporary, { force: true });
        } catch (cleanup) {
          throw new AggregateError(
            [failure, cleanup],
            "Key write and cleanup failed",
          );
        }
        throw failure;
      }
      content = await readPrivateFile(this.keyFile, KEY_FILE_LIMIT);
    }
    if (!content) throw unavailable("key");
    this.master = deriveKey(parseMasterKey(content));
    return this.master;
  }

  private helper(): ProcessLauncher {
    if (!this.launcher)
      throw new HubError(
        "PROCESS_LAUNCHER_NOT_INJECTED",
        "The secret helper needs a process launcher from the composition root",
        500,
      );
    return this.launcher;
  }

  private async createItem(
    value: string,
    backend: "keychain" | "dpapi" = this.native(),
  ): Promise<string> {
    this.platform(backend);
    const item = randomUUID();
    try {
      await helperRequest(this.helper(), "create", item, value);
    } catch (error) {
      throw writeFailed("helper", errorCode(error));
    }
    return item;
  }

  private async readItem(
    backend: "keychain" | "dpapi",
    item: string,
  ): Promise<string> {
    this.platform(backend);
    const value = await helperRequest(this.helper(), "read", item);
    if (value === undefined) throw unavailable("helper");
    return value;
  }

  /** Delete items; returns those whose deletion failed. */
  private async tryDeleteItems(
    backend: "keychain" | "dpapi",
    items: readonly string[],
  ): Promise<string[]> {
    this.platform(backend);
    const remaining: string[] = [];
    for (const item of items)
      try {
        await helperRequest(this.helper(), "delete", item);
      } catch {
        // Recorded in the entry and retried by the next write or delete.
        remaining.push(item);
      }
    return remaining;
  }

  /** Undo created items after `cause`; a failed undo joins the error. */
  private async deleteItems(
    backend: "keychain" | "dpapi",
    items: readonly string[],
    cause: unknown,
  ): Promise<void> {
    const remaining = await this.tryDeleteItems(backend, items);
    if (remaining.length)
      throw new AggregateError(
        [cause, writeFailed("helper", "delete")],
        "Secret write failed and its helper item could not be removed",
      );
  }

  private native(): "keychain" | "dpapi" {
    if (this.backend === "file") throw new Error("No native backend selected");
    return this.backend;
  }

  /** An entry of another platform's helper cannot be read here. */
  private platform(backend: "keychain" | "dpapi"): void {
    if (
      (backend === "keychain" && process.platform !== "darwin") ||
      (backend === "dpapi" && process.platform !== "win32")
    )
      throw unavailable("backend");
  }
}
