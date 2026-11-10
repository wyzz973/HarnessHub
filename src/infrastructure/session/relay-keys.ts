import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EPHEMERAL_KEY_ID, RelayError, hmacDigest, redactionTag, type HmacDigest, type RedactionTag, type RelayKeyPort } from "../../contracts/relay.js";
import type { SessionId } from "../../contracts/session.js";

/**
 * The installation's relay key (ADR-055 §10.2 "标签", D5, INV-29, INV-36; G072): 32 random bytes in one file of this user,
 * mode 0600, created with O_EXCL, outside the data directory and the business database (macOS:
 * `~/Library/Application Support/HarnessHub/relay-key`; the composition checks it lies outside the data directory). It is never
 * exported, logged or backed up; what leaves this module are HMACs under a subkey derived per Session
 * (HMAC(key, "relay-tag/1" ‖ sessionId)), so that one value keys differently in every Session.
 *
 * What is found on opening (§10.2 "异常语义", VF3-17):
 * - a regular file of this user with 32 bytes: used; a mode other than 0600 is set back to 0600 and reported;
 * - a regular file of this user with another length: refused (the relay then fails every Turn that would carry relay content
 *   with RELAY_PREPARE_FAILED{redaction_failed} and says why), never overwritten, since it may be a key being written — except
 *   an empty one that has stood for more than EMPTY_KEY_MS: a key is written at once, so that is one whose creation was cut short
 *   (a crash between creating the file and writing it), and it is rotated like the files below (G072 review m5);
 * - a file of another user, or a link or a FIFO (anything that is not a regular file and not a directory): rotated — a new key is
 *   written beside it and renamed over it, with a new identity; rows keyed by the old identity can no longer be checked (不可复核);
 * - a directory: refused and left as it is — its contents are not the relay's to replace, and a file cannot be renamed over one;
 *   the relay says so and the user moves it or sets another key path (G072 review m5).
 *
 * The key identity (`keyId`) is derived from the key and never EPHEMERAL_KEY_ID ("ephemeral" is reserved, A17).
 */

/** Where the relay key lives unless the composition says otherwise (D5): beside, never inside, HarnessHub's own data. */
export function defaultRelayKeyPath(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "HarnessHub", "relay-key");
}
const KEY_BYTES = 32;
/** How long an empty key file must have stood before it counts as a creation that was cut short and not one being written. */
const EMPTY_KEY_MS = 10_000;
function keyIdOf(key: Buffer): string {
  const id = "k" + createHmac("sha256", key).update("relay-key-id/1", "utf8").digest("hex").slice(0, 23);
  if (id === EPHEMERAL_KEY_ID) throw new Error("unreachable: a key identity never spells the reserved one");
  return id;
}
function refused(why: string): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "redaction_failed" }, "没能准备交接单：HarnessHub 的接力密钥文件不能用（" + why + "），这条消息没有发出。可以只发这条消息，不带交接单；修好密钥文件后再交接。");
}
/** Writes a new key at `path` with O_EXCL and mode 0600, durably; throws EEXIST when one is there. */
function create(path: string): Buffer {
  const key = randomBytes(KEY_BYTES);
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let written = 0;
    while (written < key.length) written += writeSync(descriptor, key, written, key.length - written);
    fchmodSync(descriptor, 0o600); fsyncSync(descriptor);
  } catch (error) { closeSync(descriptor); try { unlinkSync(path); } catch { /* never leave a short key behind */ } throw error; }
  closeSync(descriptor);
  return key;
}

export interface RelayKeyOpening {
  readonly keys: RelayKeys;
  /** What opening found and did, for the service log (never the key, never its digest). */
  readonly notes: readonly ("created" | "mode_repaired" | "rotated_foreign_owner" | "rotated_not_regular" | "rotated_empty" | "refused_length" | "refused_directory")[];
}
export class RelayKeys implements RelayKeyPort {
  readonly keyId: string;
  readonly path: string | null;
  /** Kept only in this object: never returned, logged or serialized. */
  readonly #key: Buffer | null;
  readonly #refusal: string | null;
  private constructor(path: string | null, key: Buffer | null, refusal: string | null) {
    this.path = path; this.#key = key; this.#refusal = refusal;
    this.keyId = key === null ? "k-refused" : keyIdOf(key);
  }
  /**
   * Opens the installation key at `path`, creating it (and its directory, 0700) when there is none. Synchronous: the
   * composition opens it once at start. Never throws for what it finds in the file (see the module comment); throws only when
   * the directory cannot be made or the file cannot be created or read at all.
   */
  static open(path: string): RelayKeyOpening {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const notes: RelayKeyOpening["notes"][number][] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      let descriptor: number;
      try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          try { const key = create(path); notes.push("created"); return { keys: new RelayKeys(path, key, null), notes }; }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code === "EEXIST") continue; throw failure; }
        }
        // A symbolic link (ELOOP with O_NOFOLLOW) is no key file of this user: rotated.
        if (code === "ELOOP") { notes.push("rotated_not_regular"); return { keys: RelayKeys.rotate(path), notes }; }
        throw error;
      }
      try {
        const info = fstatSync(descriptor), uid = process.getuid?.();
        if (info.isDirectory()) { notes.push("refused_directory"); return { keys: new RelayKeys(path, null, "这个路径是一个目录，HarnessHub 不会替换它；请把它移走，或另指一个密钥文件路径"), notes }; }
        if (!info.isFile()) { notes.push("rotated_not_regular"); return { keys: RelayKeys.rotate(path), notes }; }
        if (uid !== undefined && info.uid !== uid) { notes.push("rotated_foreign_owner"); return { keys: RelayKeys.rotate(path), notes }; }
        // An empty file that has stood a while is a creation cut short (a key is written at once); a young one may be being written.
        if (info.size === 0 && Date.now() - info.mtimeMs > EMPTY_KEY_MS) { notes.push("rotated_empty"); return { keys: RelayKeys.rotate(path), notes }; }
        if (info.size !== KEY_BYTES) { notes.push("refused_length"); return { keys: new RelayKeys(path, null, "长度是 " + info.size + " 字节，应为 32 字节"), notes }; }
        if ((info.mode & 0o777) !== 0o600) { fchmodSync(descriptor, 0o600); notes.push("mode_repaired"); }
        const key = Buffer.alloc(KEY_BYTES);
        let read = 0;
        while (read < KEY_BYTES) { const chunk = readSync(descriptor, key, read, KEY_BYTES - read, read); if (chunk === 0) break; read += chunk; }
        if (read !== KEY_BYTES) { notes.push("refused_length"); return { keys: new RelayKeys(path, null, "读到 " + read + " 字节，应为 32 字节"), notes }; }
        return { keys: new RelayKeys(path, key, null), notes };
      } finally { closeSync(descriptor); }
    }
    throw new Error("the relay key file kept changing while it was opened");
  }
  /** A new key written beside `path` and renamed over it: what was there (another user's file, a link) is replaced, never read. */
  private static rotate(path: string): RelayKeys {
    const beside = path + ".new-" + randomBytes(12).toString("hex");
    const key = create(beside);
    try { renameSync(beside, path); } catch (error) { try { unlinkSync(beside); } catch { /* nothing more to undo */ } throw error; }
    return new RelayKeys(path, key, null);
  }
  /** A key kept only in this process (tests and a composition without a key file); it takes no file and no lasting identity. */
  static memory(): RelayKeys { return new RelayKeys(null, randomBytes(KEY_BYTES), null); }
  private subkey(session: SessionId): Buffer {
    if (this.#key === null) throw refused(this.#refusal ?? "不可用");
    return createHmac("sha256", this.#key).update("relay-tag/1", "utf8").update("\0", "utf8").update(session, "utf8").digest();
  }
  inputHmac(session: SessionId, text: string): HmacDigest {
    return hmacDigest(createHmac("sha256", this.subkey(session)).update("input\0", "utf8").update(text, "utf8").digest("hex"));
  }
  setTag(session: SessionId, secrets: readonly string[]): RedactionTag {
    const hmac = createHmac("sha256", this.subkey(session)).update("secret-set\0", "utf8");
    for (const value of [...new Set(secrets)].sort()) hmac.update(value, "utf8").update("\0", "utf8");
    return redactionTag(hmac.digest("hex").slice(0, 8));
  }
  requestFingerprint(session: SessionId, canonical: string): HmacDigest {
    return hmacDigest(createHmac("sha256", this.subkey(session)).update("request\0", "utf8").update(canonical, "utf8").digest("hex"));
  }
}
/** Whether `path` (or, when it does not exist, its directory) lies inside `root`, by device and inode along its parents (INV-36). */
export function insideByIdentity(path: string, root: string): boolean {
  const identity = (at: string) => { const info = statSync(at, { bigint: true }); return info.dev + ":" + info.ino; };
  let ancestor: string;
  try { ancestor = identity(root); } catch { return false; }
  let current = path;
  for (;;) {
    try { if (identity(current) === ancestor) return true; } catch { /* a part that does not exist yet proves nothing */ }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
