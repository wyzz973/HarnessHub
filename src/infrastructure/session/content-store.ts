import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_CONTENT_BYTES, MAX_RUN_ATTACHMENT_BYTES, contentId, contentKind, contentName, mediaType, type ContentBytes, type ContentOrigin, type ContentPort, type ContentRef, type ControlAttachment } from "../../contracts/content.js";
import { SessionError, commandId } from "../../contracts/session.js";

const MARKER = '{"application":"harness-gateway-content","schemaVersion":1}';
// The store holds no total of its own (a count of records, a sum of bytes): content is user data, and a Harness's output is kept whole however much there is; what the disk cannot
// take fails the write, and the writer says so on the item. What one UPLOAD may hold, and what one message may carry, is checked when the upload is staged and the message sent.
/** Unreferenced content is kept this long for an interrupted Turn to be inspected; referenced content is never collected. */
export const CONTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PARTIAL_RETENTION_MS = 60 * 60 * 1000;
interface Row { readonly id: string; readonly sha256: string; readonly name: string; readonly media_type: string; readonly kind: ContentRef["kind"]; readonly bytes: number; readonly origin: ContentOrigin; readonly workspace: string; readonly fingerprint: string | null; readonly discarded: 0 | 1; readonly created_at: number }
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid())) throw new SessionError("INVALID_STORAGE", "content storage directory must be private");
}
function code(error: unknown): string | undefined { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function readMarker(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) throw new SessionError("INVALID_STORAGE", "invalid content ownership marker");
    const buffer = Buffer.alloc(4097); let length = 0;
    for (;;) { const read = readSync(fd, buffer, length, buffer.length - length, length); if (read === 0) break; length += read; if (length > 4096) throw new SessionError("INVALID_STORAGE", "invalid content ownership marker"); }
    return buffer.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}
function parseRow(value: unknown): Row {
  if (value === null || typeof value !== "object") throw new SessionError("INVALID_DATA", "stored content record is invalid");
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256) || typeof item.name !== "string" || typeof item.media_type !== "string" ||
      (item.kind !== "image" && item.kind !== "audio" && item.kind !== "file") || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
      (item.origin !== "upload" && item.origin !== "output") || (item.origin === "upload" && item.bytes > MAX_CONTENT_BYTES) || typeof item.workspace !== "string" || !(item.fingerprint === null || typeof item.fingerprint === "string") ||
      (item.discarded !== 0 && item.discarded !== 1) || typeof item.created_at !== "number" || !Number.isSafeInteger(item.created_at))
    throw new SessionError("INVALID_DATA", "stored content record is invalid");
  return item as unknown as Row;
}
function reference(row: Row): ContentRef { return { id: contentId(row.id), name: row.name, mediaType: row.media_type, kind: row.kind, bytes: row.bytes, sha256: row.sha256 }; }

/**
 * Content-addressed native-output and tool-detail bytes for one data root. Records are immutable;
 * Session snapshots hold only ContentRef values. Collection removes only items no Session references.
 */
export class LocalContentStore implements ContentPort {
  private readonly root: string;
  private readonly database: string;
  private readonly writing = new Set<string>();
  constructor(dataRoot: string, private readonly owner: () => void, private readonly now: () => number = Date.now) {
    owner();
    if (!isAbsolute(dataRoot) || /[\0\r\n]/u.test(dataRoot)) throw new SessionError("INVALID_INPUT", "content data root must be absolute");
    privateDirectory(dataRoot);
    this.root = join(realpathSync(dataRoot), "content"); privateDirectory(this.root);
    const marker = join(this.root, ".harness-gateway-content.json");
    if (!existsSync(marker)) {
      if (readdirSync(this.root).length) throw new SessionError("INVALID_STORAGE", "content storage has no ownership marker");
      const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, MARKER + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (readMarker(marker).trim() !== MARKER) throw new SessionError("INVALID_STORAGE", "invalid content ownership marker");
    privateDirectory(join(this.root, "blobs")); privateDirectory(join(this.root, "partial")); privateDirectory(join(this.root, "files"));
    const database = join(this.root, "content.sqlite");
    const fd = openSync(database, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new SessionError("INVALID_STORAGE", "invalid content database file"); } finally { closeSync(fd); }
    this.database = database;
    this.use(db => {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().length) throw new SessionError("INVALID_STORAGE", "unknown content storage format");
        db.exec("BEGIN IMMEDIATE; CREATE TABLE content(id TEXT PRIMARY KEY, sha256 TEXT NOT NULL CHECK(length(sha256)=64), name TEXT NOT NULL, media_type TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('image','audio','file')), bytes INTEGER NOT NULL CHECK(bytes>=0), origin TEXT NOT NULL CHECK(origin IN('upload','output')), workspace TEXT NOT NULL, command_id TEXT UNIQUE, fingerprint TEXT, created_at INTEGER NOT NULL, discarded INTEGER NOT NULL DEFAULT 0 CHECK(discarded IN(0,1))) STRICT; CREATE INDEX content_digest ON content(sha256); PRAGMA user_version=1; COMMIT");
      } else if (version !== 1) throw new SessionError("INVALID_STORAGE", "unsupported content storage schema");
    });
    for (const name of readdirSync(join(this.root, "blobs"))) {
      if (!/^[a-f0-9]{64}$/u.test(name)) throw new SessionError("INVALID_STORAGE", "unexpected file in content storage");
    }
  }
  /** Each operation owns its own connection, so the store has no handle for other owners to close. */
  private use<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.database);
    try { db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000"); return operation(db); }
    finally { db.close(); }
  }
  /**
   * Keeps what a Harness made (a tool call's detail, a file or image it produced) whole, of any size, written as it comes: the bytes can be given in pieces, so that
   * a detail of tens of MiB is never joined into one string or one buffer here. The caller persists the returned reference. Content of no bytes is refused (there is nothing to keep).
   */
  async storeOutput(input: { readonly workspace: string; readonly name: string; readonly mediaType: string; readonly data: ContentBytes }): Promise<ContentRef> {
    this.owner();
    const name = contentName(input.name), type = mediaType(input.mediaType);
    const pieces: AsyncIterable<unknown> | Iterable<Uint8Array> = input.data instanceof Uint8Array ? [input.data] : input.data;
    const written = await this.write(pieces, null);
    try {
      if (written.bytes < 1) throw new SessionError("OUTPUT_LIMIT", "native output content must contain at least 1 byte");
      let kind: ContentRef["kind"] = "file";
      try { kind = contentKind(type, written.head); } catch { /* A mislabeled native output is still kept, but only as an opaque file. */ }
      return this.publish(written, { name, type, kind, origin: "output", workspace: input.workspace, command: null, fingerprint: null });
    } finally { this.removePartial(written.path); }
  }
  /** Streams one upload under its byte budget, verifies the declared type against the bytes, then records it for the workspace. */
  async stage(input: { readonly workspace: string; readonly name: unknown; readonly mediaType: unknown; readonly commandId: string; readonly declaredBytes: number; readonly source: AsyncIterable<unknown> }): Promise<ContentRef> {
    this.owner();
    const key = commandId(input.commandId), name = contentName(input.name), type = mediaType(input.mediaType);
    if (!isAbsolute(input.workspace)) throw new SessionError("INVALID_INPUT", "attachment workspace must be absolute");
    if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 1 || input.declaredBytes > MAX_CONTENT_BYTES) throw new SessionError("ATTACHMENT_LIMIT", "attachments must contain 1 byte to 1 GiB");
    const written = await this.write(input.source, input.declaredBytes);
    try {
      const kind = contentKind(type, written.head);
      const fingerprint = createHash("sha256").update(JSON.stringify({ workspace: input.workspace, name, type, sha256: written.sha256 })).digest("hex");
      this.owner();
      const prior = this.use(db => db.prepare("SELECT * FROM content WHERE command_id=?").get(key));
      if (prior !== undefined) {
        const existing = parseRow(prior);
        if (existing.fingerprint !== fingerprint || existing.origin !== "upload") throw new SessionError("IDEMPOTENCY_CONFLICT", "attachment command key already names other content");
        return reference(existing);
      }
      return this.publish(written, { name, type, kind, origin: "upload", workspace: input.workspace, command: key, fingerprint });
    } finally { this.removePartial(written.path); }
  }
  /** Admission: each identity must be a staged, not withdrawn upload of this workspace whose bytes are still present. */
  resolve(ids: readonly string[], workspace: string): readonly ContentRef[] {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new SessionError("INVALID_INPUT", "attachments must be unique content identities");
    const refs = this.use(db => ids.map(value => {
      const stored = db.prepare("SELECT * FROM content WHERE id=?").get(contentId(value));
      if (stored === undefined) throw new SessionError("ATTACHMENT_UNAVAILABLE", "an attachment is no longer available; remove it and attach the file again");
      const item = parseRow(stored);
      if (item.workspace !== workspace || item.origin !== "upload" || item.discarded === 1) throw new SessionError("ATTACHMENT_UNAVAILABLE", "an attachment does not belong to this workspace or was removed");
      this.blob(item.sha256, item.bytes);
      return reference(item);
    }));
    if (refs.reduce((total, ref) => total + ref.bytes, 0) > MAX_RUN_ATTACHMENT_BYTES) throw new SessionError("ATTACHMENT_LIMIT", "attachments of one message exceed 4 GiB");
    return refs;
  }
  /** Withdraws a staged upload from future admission. Content already admitted by a Run stays referenced and kept. */
  discard(value: string, workspace: string): void {
    this.owner();
    const id = contentId(value);
    this.use(db => {
      const stored = db.prepare("SELECT * FROM content WHERE id=?").get(id);
      if (stored === undefined) return;
      const item = parseRow(stored);
      if (item.workspace !== workspace || item.origin !== "upload") throw new SessionError("ATTACHMENT_UNAVAILABLE", "attachment does not belong to this workspace");
      db.prepare("UPDATE content SET discarded=1 WHERE id=?").run(item.id);
    });
  }
  /**
   * One stable read-only copy per content item at `files/<id>/<name>`, so a native session can read it again in a later
   * Turn. An existing copy is re-verified against the digest and replaced if it was changed.
   */
  async materialize(refs: readonly ContentRef[]): Promise<readonly ControlAttachment[]> {
    this.owner();
    const result: ControlAttachment[] = [];
    for (const item of refs) {
      const id = contentId(item.id), name = contentName(item.name), source = this.blob(item.sha256, item.bytes);
      const parent = join(this.root, "files", id), target = join(parent, name);
      await mkdir(parent, { recursive: false, mode: 0o700 }).catch((error: unknown) => { if (code(error) !== "EEXIST") throw error; });
      privateDirectory(parent);
      if (!await this.matches(target, item)) {
        const staging = join(parent, "." + randomUUID());
        try {
          await copyFile(source, staging, constants.COPYFILE_EXCL);
          if (!await this.matches(staging, item)) throw new SessionError("INVALID_STORAGE", "stored content changed after admission");
          await chmod(staging, 0o400);
          await unlink(target).catch((error: unknown) => { if (code(error) !== "ENOENT") throw error; });
          await rename(staging, target);
        } catch (error) { await unlink(staging).catch(() => {}); throw error; }
      }
      result.push({ ...item, path: target });
    }
    return result;
  }
  private async matches(path: string, item: ContentRef): Promise<boolean> {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return false;
    if (!info.isFile() || info.size !== item.bytes) return false;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let total = 0;
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, total); if (bytesRead === 0) break; total += bytesRead; if (total > item.bytes) return false; hash.update(buffer.subarray(0, bytesRead)); }
      return total === item.bytes && hash.digest("hex") === item.sha256;
    } finally { await handle.close(); }
  }
  /** See ContentPort.readText: the bytes are read only when the record and the blob still match `ref`. */
  async readText(ref: ContentRef, maxBytes: number): Promise<string | null> {
    // Ownership and the index are checked first and their failures still throw (a record that is gone is null); a blob
    // that cannot be read, for whatever reason, is "not read" (m7: EACCES, ELOOP, EIO and the like must not fail the Turn
    // that only wanted to quote a tool's detail).
    this.owner();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || ref.bytes > maxBytes) return null;
    let found: ReturnType<LocalContentStore["read"]>;
    try { found = this.read(ref.id); } catch (error) { if (error instanceof SessionError) return null; throw error; }
    if (found.ref.sha256 !== ref.sha256 || found.ref.bytes !== ref.bytes) return null;
    let data: Buffer;
    try {
      const handle = await open(found.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { data = await handle.readFile(); } finally { await handle.close(); }
    } catch { return null; }
    if (data.byteLength !== ref.bytes || createHash("sha256").update(data).digest("hex") !== ref.sha256) return null;
    return data.toString("utf8");
  }
  /** See ContentPort.readChunks: the same checks as `readText` before the first piece; the digest when the last has been read. */
  async readChunks(ref: ContentRef): Promise<AsyncIterable<Uint8Array> | null> {
    this.owner();
    let found: ReturnType<LocalContentStore["read"]>;
    try { found = this.read(ref.id); } catch (error) { if (error instanceof SessionError) return null; throw error; }
    if (found.ref.sha256 !== ref.sha256 || found.ref.bytes !== ref.bytes) return null;
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(found.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
    try { if ((await handle.stat()).size !== ref.bytes) { await handle.close(); return null; } } catch { await handle.close().catch(() => {}); return null; }
    return (async function* (): AsyncGenerator<Uint8Array> {
      try {
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
        let total = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
          if (bytesRead === 0) break;
          total += bytesRead; hash.update(buffer.subarray(0, bytesRead));
          yield Uint8Array.prototype.slice.call(buffer, 0, bytesRead) as Uint8Array;
        }
        if (total !== ref.bytes || hash.digest("hex") !== ref.sha256) throw new SessionError("INVALID_STORAGE", "stored content changed while it was read");
      } finally { await handle.close(); }
    })();
  }
  /**
   * `readText` without waiting, for a reader that cannot wait (the web view of a conversation is made synchronously): the same checks, the same
   * answer, null for anything that is not read. For the small details of tool calls only: it blocks while the file is read.
   */
  readTextSync(ref: ContentRef, maxBytes: number): string | null {
    this.owner();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || ref.bytes > maxBytes) return null;
    let found: ReturnType<LocalContentStore["read"]>;
    try { found = this.read(ref.id); } catch (error) { if (error instanceof SessionError) return null; throw error; }
    if (found.ref.sha256 !== ref.sha256 || found.ref.bytes !== ref.bytes) return null;
    let data: Buffer;
    try {
      const fd = openSync(found.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { data = readFileSync(fd); } finally { closeSync(fd); }
    } catch { return null; }
    if (data.byteLength !== ref.bytes || createHash("sha256").update(data).digest("hex") !== ref.sha256) return null;
    return data.toString("utf8");
  }
  /** Owner-local lookup for serving content to the authenticated page. */
  read(value: string): { readonly ref: ContentRef; readonly workspace: string; readonly origin: ContentOrigin; readonly path: string } {
    const id = contentId(value), stored = this.use(db => db.prepare("SELECT * FROM content WHERE id=?").get(id));
    if (stored === undefined) throw new SessionError("CONTENT_NOT_FOUND", "content is not available");
    const item = parseRow(stored);
    return { ref: reference(item), workspace: item.workspace, origin: item.origin, path: this.blob(item.sha256, item.bytes) };
  }
  /** Startup collector for a quiescent owner. `referenced` must hold every content id in any Session snapshot. */
  collect(referenced: ReadonlySet<string>): { readonly records: number; readonly blobs: number; readonly files: number; readonly partial: number } {
    this.owner();
    if (this.writing.size) throw new SessionError("CONTENT_BUSY", "content collection requires a quiescent owner");
    let records = 0, blobs = 0, files = 0, partial = 0;
    const live = this.use(db => {
      for (const value of db.prepare("SELECT * FROM content WHERE discarded=1 OR created_at<?").all(this.now() - CONTENT_RETENTION_MS)) {
        const item = parseRow(value);
        if (referenced.has(item.id)) continue;
        db.prepare("DELETE FROM content WHERE id=?").run(item.id); records++;
      }
      return new Set(db.prepare("SELECT DISTINCT sha256 FROM content").all().map(value => String((value as { sha256?: unknown }).sha256)));
    });
    for (const name of readdirSync(join(this.root, "blobs"))) {
      if (live.has(name)) continue;
      unlinkSync(join(this.root, "blobs", name)); blobs++;
    }
    const recorded = this.use(db => new Set(db.prepare("SELECT id FROM content").all().map(value => String((value as { id?: unknown }).id))));
    for (const name of readdirSync(join(this.root, "files"))) {
      if (!/^content-[a-zA-Z0-9-]{1,96}$/u.test(name) || recorded.has(name)) continue;
      rmSync(join(this.root, "files", name), { recursive: true, force: true }); files++;
    }
    for (const name of readdirSync(join(this.root, "partial"))) {
      const path = join(this.root, "partial", name), info = lstatSync(path);
      if (info.isFile() && info.mtimeMs < this.now() - PARTIAL_RETENTION_MS) { unlinkSync(path); partial++; }
    }
    return { records, blobs, files, partial };
  }
  /**
   * Erases content that only conversations the user erased mentioned (2026-11-14; ContentPort.purge): the records named, then each one's copy in `files/`, then each blob no
   * record is left for (a blob is kept once per digest: another record, of another conversation or an upload not sent yet, may share it). One that is being written meanwhile
   * is a record of its own, made after this, and links its blob again. Ids it does not hold, or that are not content ids, are passed over.
   */
  purge(ids: ReadonlySet<string>): { readonly records: number; readonly blobs: number; readonly files: number } {
    this.owner();
    const named = [...ids].filter(value => /^content-[a-zA-Z0-9-]{1,96}$/u.test(value));
    if (named.length === 0) return { records: 0, blobs: 0, files: 0 };
    let records = 0, blobs = 0, files = 0;
    const digests = new Set<string>(), erased: string[] = [];
    const live = this.use(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const id of named) {
          const stored = db.prepare("SELECT * FROM content WHERE id=?").get(id);
          if (stored === undefined) continue;
          const item = parseRow(stored);
          db.prepare("DELETE FROM content WHERE id=?").run(item.id); records++; digests.add(item.sha256); erased.push(item.id);
        }
        db.exec("COMMIT");
      } catch (error) { try { db.exec("ROLLBACK"); } catch { /* the connection closes */ } throw error; }
      return new Set([...digests].filter(sha256 => db.prepare("SELECT 1 FROM content WHERE sha256=? LIMIT 1").get(sha256) !== undefined));
    });
    for (const id of erased) {
      const path = join(this.root, "files", id);
      if (existsSync(path)) { rmSync(path, { recursive: true, force: true }); files++; }
    }
    for (const sha256 of digests) {
      if (live.has(sha256)) continue;
      try { unlinkSync(join(this.root, "blobs", sha256)); blobs++; } catch (error) { if (code(error) !== "ENOENT") throw error; }
    }
    return { records, blobs, files };
  }
  /**
   * What `collect` would delete, counted and not deleted: the same records, then the blobs and files that would have nothing left to be kept for, and the partial uploads past
   * their retention. The first start after an upgrade reports this and collects nothing (ADR-057 3.6).
   */
  wouldCollect(referenced: ReadonlySet<string>): { readonly records: number; readonly blobs: number; readonly files: number; readonly partial: number } {
    this.owner();
    let records = 0, blobs = 0, files = 0, partial = 0;
    const dropped = new Set<string>(), kept = new Set<string>();
    this.use(db => {
      for (const value of db.prepare("SELECT * FROM content").all()) {
        const item = parseRow(value), old = item.discarded === 1 || item.created_at < this.now() - CONTENT_RETENTION_MS;
        if (old && !referenced.has(item.id)) { dropped.add(item.id); records++; } else { kept.add(item.id); }
      }
    });
    const liveBlobs = this.use(db => new Set(db.prepare("SELECT id, sha256 FROM content").all().filter(value => !dropped.has(String((value as { id?: unknown }).id))).map(value => String((value as { sha256?: unknown }).sha256))));
    for (const name of readdirSync(join(this.root, "blobs"))) if (!liveBlobs.has(name)) blobs++;
    for (const name of readdirSync(join(this.root, "files"))) if (/^content-[a-zA-Z0-9-]{1,96}$/u.test(name) && !kept.has(name)) files++;
    for (const name of readdirSync(join(this.root, "partial"))) {
      const info = lstatSync(join(this.root, "partial", name));
      if (info.isFile() && info.mtimeMs < this.now() - PARTIAL_RETENTION_MS) partial++;
    }
    return { records, blobs, files, partial };
  }
  private blob(sha256: string, bytes: number): string {
    const path = join(this.root, "blobs", sha256), info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) throw new SessionError("CONTENT_UNAVAILABLE", "stored content bytes are missing");
    if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes || (info.mode & 0o077) !== 0) throw new SessionError("INVALID_STORAGE", "stored content bytes are invalid");
    return path;
  }
  /** `declared`: the size an upload said it has, which it must have exactly and which is no more than an upload may hold; null for output, which is any size. */
  private async write(source: AsyncIterable<unknown> | Iterable<Uint8Array>, declared: number | null): Promise<{ readonly path: string; readonly sha256: string; readonly bytes: number; readonly head: Uint8Array }> {
    const path = join(this.root, "partial", randomUUID()); this.writing.add(path);
    const hash = createHash("sha256"), head = Buffer.alloc(16); let bytes = 0;
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for await (const value of source) {
          if (!(value instanceof Uint8Array)) throw new SessionError("INVALID_INPUT", "content body must be bytes");
          if (declared !== null && (bytes + value.byteLength > declared || bytes + value.byteLength > MAX_CONTENT_BYTES)) throw new SessionError("CONTENT_LIMIT", "content exceeds its declared size or 1 GiB");
          if (bytes < head.length) Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, head.length - bytes)).copy(head, bytes);
          hash.update(value); await handle.write(value); bytes += value.byteLength;
        }
        if (declared !== null && bytes !== declared) throw new SessionError("INVALID_INPUT", "content body does not match its declared size");
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) { this.removePartial(path); throw error; }
    return { path, sha256: hash.digest("hex"), bytes, head: head.subarray(0, Math.min(bytes, head.length)) };
  }
  private publish(blob: { readonly sha256: string; readonly bytes: number; readonly path: string }, meta: { readonly name: string; readonly type: string; readonly kind: ContentRef["kind"]; readonly origin: ContentOrigin; readonly workspace: string; readonly command: string | null; readonly fingerprint: string | null }): ContentRef {
    this.owner();
    const target = join(this.root, "blobs", blob.sha256);
    if (!existsSync(target)) {
      try { linkSync(blob.path, target); } catch (error) { if (code(error) !== "EEXIST") throw error; }
      const fd = openSync(join(this.root, "blobs"), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.blob(blob.sha256, blob.bytes);
    const id = contentId("content-" + randomUUID());
    this.use(db => db.prepare("INSERT INTO content(id,sha256,name,media_type,kind,bytes,origin,workspace,command_id,fingerprint,created_at,discarded) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)")
      .run(id, blob.sha256, meta.name, meta.type, meta.kind, blob.bytes, meta.origin, meta.workspace, meta.command, meta.fingerprint, this.now()));
    return { id, name: meta.name, mediaType: meta.type, kind: meta.kind, bytes: blob.bytes, sha256: blob.sha256 };
  }
  private removePartial(path: string): void {
    this.writing.delete(path);
    try { unlinkSync(path); } catch (error) { if (code(error) !== "ENOENT") throw error; }
  }
}
