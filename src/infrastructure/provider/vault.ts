import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ProviderError } from "../../contracts/provider.js";

export interface FileIdentity { readonly dev: string; readonly ino: string }
export function fileIdentity(path: string, directory = false): FileIdentity {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1n) ||
      (info.mode & 0o077n) !== 0n)
    throw new ProviderError("INVALID_STORAGE", "Provider storage must be private and must not use links");
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}
export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
/** The byte limit applies before and during reading, even if another process grows the file. */
export function readPrivateFile(path: string, maximum: number, expected: FileIdentity): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o077n) !== 0n || info.size > BigInt(maximum) ||
        !sameIdentity(expected, { dev: info.dev.toString(), ino: info.ino.toString() }))
      throw new ProviderError("INVALID_STORAGE", "private Provider file identity or byte budget is invalid");
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) {
      const received = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (received === 0) break; length += received;
    }
    if (length > maximum || !sameIdentity(expected, fileIdentity(path))) throw new ProviderError("INVALID_STORAGE", "private Provider file changed or exceeded its byte budget");
    return buffer.subarray(0, length);
  } finally { closeSync(descriptor); }
}
/** SQLite holds only AES-256-GCM envelopes. The 0600 local master key is not protection against the same OS user. */
export class ProviderVault {
  private readonly master: Buffer;
  private readonly path: string;
  private readonly identity: FileIdentity;
  private closed = false;
  constructor(root: string, private readonly db: DatabaseSync) {
    this.path = join(root, "master.key");
    let descriptor: number;
    try { descriptor = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw new ProviderError("INVALID_STORAGE", "Provider master key cannot be opened");
      descriptor = -1;
    }
    if (descriptor >= 0) {
      const created = randomBytes(32);
      try { writeFileSync(descriptor, created); fsyncSync(descriptor); }
      finally { created.fill(0); closeSync(descriptor); }
    }
    this.identity = fileIdentity(this.path);
    this.master = readPrivateFile(this.path, 32, this.identity);
    if (this.master.length !== 32) { this.master.fill(0); throw new ProviderError("INVALID_STORAGE", "Provider master key has an invalid size"); }
    this.db.exec("CREATE TABLE IF NOT EXISTS provider_credentials (provider_id TEXT NOT NULL, revision INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(provider_id, revision)) STRICT");
  }
  assertOwned(): void {
    if (this.closed || !sameIdentity(this.identity, fileIdentity(this.path))) throw new ProviderError("OWNERSHIP_LOST", "Provider master key ownership changed");
  }
  fingerprint(value: string): string { this.assertOwned(); return createHmac("sha256", this.master).update(value).digest("hex"); }
  store(id: string, revision: number, secret: string): void {
    this.assertOwned();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.master, nonce);
    cipher.setAAD(Buffer.from(id + ":" + revision));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    this.db.prepare("INSERT INTO provider_credentials(provider_id,revision,nonce,ciphertext,tag) VALUES(?,?,?,?,?)")
      .run(id, revision, nonce.toString("base64"), ciphertext.toString("base64"), cipher.getAuthTag().toString("base64"));
  }
  read(id: string, revision: number): string | null {
    this.assertOwned();
    const budget = this.db.prepare("SELECT length(CAST(nonce AS BLOB)) AS nonce_bytes,length(CAST(ciphertext AS BLOB)) AS ciphertext_bytes,length(CAST(tag AS BLOB)) AS tag_bytes FROM provider_credentials WHERE provider_id=? AND revision=?").get(id, revision);
    if (!budget) return null;
    if (typeof budget.nonce_bytes !== "number" || budget.nonce_bytes !== 16 || typeof budget.tag_bytes !== "number" || budget.tag_bytes !== 24 ||
        typeof budget.ciphertext_bytes !== "number" || budget.ciphertext_bytes < 4 || budget.ciphertext_bytes > 10924)
      throw new ProviderError("INVALID_VAULT", "Provider credential envelope exceeds its byte budget");
    const row = this.db.prepare("SELECT nonce,ciphertext,tag FROM provider_credentials WHERE provider_id=? AND revision=? AND length(CAST(nonce AS BLOB))=16 AND length(CAST(tag AS BLOB))=24 AND length(CAST(ciphertext AS BLOB)) BETWEEN 4 AND 10924").get(id, revision);
    if (!row) throw new ProviderError("INVALID_VAULT", "Provider credential envelope changed during reading");
    try {
      if (typeof row.nonce !== "string" || typeof row.ciphertext !== "string" || typeof row.tag !== "string") throw new Error("invalid envelope");
      const nonce = Buffer.from(row.nonce, "base64"), tag = Buffer.from(row.tag, "base64"), ciphertext = Buffer.from(row.ciphertext, "base64");
      if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > 8192) throw new Error("invalid envelope size");
      const decipher = createDecipheriv("aes-256-gcm", this.master, nonce);
      decipher.setAAD(Buffer.from(id + ":" + revision)); decipher.setAuthTag(tag);
      const secret = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
      if (!secret.trim() || /[\x00-\x1f\x7f]/u.test(secret)) throw new Error("invalid credential");
      return secret;
    } catch { throw new ProviderError("INVALID_VAULT", "Provider credential could not be authenticated"); }
  }
  all(): readonly string[] {
    this.assertOwned();
    // How many credentials the vault holds is not bounded (one per revision of a Provider that has a key, 2026-11-12): the count of what
    // a user keeps must not be what keeps the service from starting; each credential's own identity is still checked.
    if (this.db.prepare("SELECT 1 FROM provider_credentials WHERE length(CAST(provider_id AS BLOB))>45 OR revision NOT BETWEEN 1 AND 9007199254740991 LIMIT 1").get())
      throw new ProviderError("INVALID_VAULT", "Provider credential identity exceeds its budget");
    const rows = this.db.prepare("SELECT provider_id,revision FROM provider_credentials ORDER BY provider_id,revision").all();
    return rows.map(row => {
      if (typeof row.provider_id !== "string" || typeof row.revision !== "number") throw new ProviderError("INVALID_VAULT", "invalid Provider credential identity");
      const secret = this.read(row.provider_id, row.revision);
      if (secret === null) throw new ProviderError("INVALID_VAULT", "Provider credential disappeared");
      return secret;
    });
  }
  close(): void { if (!this.closed) { this.master.fill(0); this.closed = true; } }
}
