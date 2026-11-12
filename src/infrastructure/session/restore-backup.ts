import { createHash } from "node:crypto";
import { constants, closeSync, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionError } from "../../contracts/session.js";
import { BACKUP_BEFORE_V14, freeBytesOf } from "./backup.js";
import { ownerGenerations } from "./owner-generations.js";
import { inspectRoot, initializeFile, processMayBeAlive, sqliteError } from "./store-root.js";
import { reasonOf } from "./upgrade-check.js";

/*
 * `sessions restore-backup`: the way back from the upgrade to the conversation library of version 14, made safe.
 *
 * The backup the upgrade takes (`backups/gateway-v<from>-before-v14.sqlite`, backup.ts) is a whole library of the version it was upgraded from, and the build that made that
 * library opens it. But a library put back by hand — copy the file over `gateway.sqlite`, delete the log — is refused by that build: the library remembers the owner generation
 * of the moment of the backup, and the management library and the capability store remember the one of every start since (owner-generations.ts), and each refuses an owner whose
 * generation is below what it remembers. So the restore is this command, which does the same and one thing more:
 *
 *   - the service must be stopped: the command takes the lock of the data directory (`owner.sqlite`) the way the service does, and refuses when it cannot; it takes no generation.
 *   - it deletes NOTHING. The library in use (with its log merged into it first) is set aside as a copy, byte for byte, under `backups/gateway-v<its version>-set-aside-<UTC>.sqlite`
 *     (a copy-on-write clone where the volume has them, which APFS does, so it costs neither time nor space), with its modification time; the backup is COPIED and stays where it is.
 *   - the backup is held to what its name says (a regular file of this data directory's `backups/`, `quick_check` ok, the version in it the one in the name) on the copy, which is
 *     byte for byte the backup (digests compared after the copy was written and synced).
 *   - the copy gets one number changed: its owner generation becomes the largest any library of the data directory remembers (so the build that takes it over takes the next one).
 *   - at no moment is there no `gateway.sqlite` (a start finding none would make an empty library), and at no moment is it anything but one library with one name: the copy of the
 *     backup is built beside it (`gateway.sqlite.restoring`), the library in use is copied aside and the copy read back against it, and only then is the copy of the backup renamed
 *     over `gateway.sqlite`, which is atomic. Killed at any point and run again, it ends as an uninterrupted run does: a copy not finished is made again; a copy of the library in
 *     use that was made is found again (same bytes) and not made twice; a restore that was done is told as done (the library is no longer version 14). Killed before the swap
 *     the data directory is what it was and a start would go on with it (plus files of this command's that it ignores). A run that FAILS before the swap (an exception, not a
 *     kill) takes away what it made.
 *
 * It says what it did in file names (relative to the data directory), versions and generations, and what it does not bring back. It never prints a conversation's words or a path.
 */

export type RestorePhase = "locked" | "chosen" | "merged" | "copied" | "edited" | "verified" | "aside" | "swapped" | "cleaned";
export interface RestoreOptions {
  /** The name of the backup under `backups/`; without it the only one there is. */
  readonly backup?: string;
  readonly now?: () => Date;
  /** The free bytes of the data directory's volume, when the system's answer is not wanted (tests). */
  readonly freeBytes?: () => number;
  /** Called after each phase with its name; a test stops the command at a chosen one. */
  readonly step?: (phase: RestorePhase, detail: string) => void;
}
interface Generations { readonly backup: number | null; readonly library: number | null; readonly management: number | null; readonly capabilities: number | null; readonly now: number | null }
export interface Restored {
  readonly outcome: "restored";
  readonly backup: { readonly name: string; readonly version: number; readonly bytes: number; readonly conversations: number; readonly events: number };
  /** The library that was in use, now kept under this name in `backups/`; null when there was none. */
  readonly setAside: { readonly name: string; readonly version: number | null; readonly generation: number | null } | null;
  readonly generation: Generations;
  /** The library version a build must read to take the restored library over. */
  readonly startWith: number;
  /**
   * The backup was taken while its owner row still said an owner was active (the build before was killed, not stopped), and a process with that id is running now: the build before
   * refuses to take a library over while the process it marks may be alive (OWNER_UNCONFIRMED). The row is not touched (the copy differs from the backup in one number); this says so.
   */
  readonly ownerMarked: { readonly pid: number } | null;
}
export interface AlreadyRestored {
  readonly outcome: "already";
  readonly version: number;
  readonly generation: number | null;
  /** The libraries set aside by an earlier restore, newest last. */
  readonly setAsides: readonly string[];
  readonly startWith: number;
}
export type RestoreReport = Restored | AlreadyRestored;

const PARTIAL = "gateway.sqlite.restoring";
const SET_ASIDE = /^gateway-v(\d+|unreadable)-set-aside-(\d{8}T\d{6}Z)(?:-(\d+))?\.sqlite$/u;
const stamp = (when: Date): string => when.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");

// ---------------------------------------------------------------------------------------------------------------------
// The lock of the data directory
// ---------------------------------------------------------------------------------------------------------------------
/** Takes the lock the service holds for as long as it runs (an exclusive transaction on `owner.sqlite`), or says the service is running. Takes no generation. */
function lockRoot(root: string): { readonly release: () => void } {
  const path = join(root, "owner.sqlite");
  initializeFile(path);
  const owner = new DatabaseSync(path, { timeout: 0, allowExtension: false });
  try { owner.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE"); }
  catch (error) {
    owner.close();
    if (sqliteError(error) && (error as { errcode?: unknown }).errcode === 5) throw new SessionError("OWNER_BUSY", "another process holds this data directory (is the service running? stop it, and run this again); nothing was changed");
    throw error;
  }
  return { release: () => { try { if (owner.isTransaction) owner.exec("ROLLBACK"); } finally { owner.close(); } } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------------
function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function digestOf(path: string): { readonly bytes: number; readonly sha256: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1 << 20);
    let bytes = 0;
    for (;;) { const read = readSync(descriptor, buffer, 0, buffer.length, bytes); if (read === 0) break; hash.update(buffer.subarray(0, read)); bytes += read; }
    return { bytes, sha256: hash.digest("hex") };
  } finally { closeSync(descriptor); }
}
/** A byte-for-byte copy to a new file of mode 0600, synced; returns the digest of what was read. */
function copyNew(source: string, target: string): { readonly bytes: number; readonly sha256: string } {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(input).isFile()) throw new SessionError("BACKUP_INVALID", "the backup is not a regular file");
    const output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(output, 0o600);
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1 << 20);
      let bytes = 0;
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, bytes);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        for (let written = 0; written < read;) written += writeSync(output, buffer, written, read - written);
        bytes += read;
      }
      fsyncSync(output);
      return { bytes, sha256: hash.digest("hex") };
    } finally { closeSync(output); }
  } finally { closeSync(input); }
}
const removeIfThere = (path: string): void => { try { unlinkSync(path); } catch (error) { if ((error as { code?: unknown }).code !== "ENOENT") throw error; } };
/** What an unfinished copy of ours may have left beside it. */
function removeCopy(root: string): void { for (const suffix of ["", "-journal", "-wal", "-shm"]) removeIfThere(join(root, PARTIAL + suffix)); }

// ---------------------------------------------------------------------------------------------------------------------
// The backups
// ---------------------------------------------------------------------------------------------------------------------
interface Candidate { readonly name: string; readonly version: number; readonly bytes: number }
function privateFolder(folder: string): void {
  const info = lstatSync(folder);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new SessionError("INVALID_STORAGE", "the backups directory must be a private directory owned by this user");
}
function candidates(folder: string): readonly Candidate[] {
  if (!existsSync(folder)) return [];
  privateFolder(folder);
  const found: Candidate[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const match = entry.isFile() ? BACKUP_BEFORE_V14.exec(entry.name) : null;
    if (match !== null) found.push({ name: entry.name, version: Number(match[1]), bytes: lstatSync(join(folder, entry.name)).size });
  }
  return found.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
function choose(list: readonly Candidate[], wanted: string | undefined): Candidate {
  const names = list.map(item => item.name).join(", ");
  if (wanted !== undefined) {
    if (!BACKUP_BEFORE_V14.test(wanted)) throw new SessionError("INVALID_INPUT", "--backup names a file of backups/ called gateway-v<version>-before-v14.sqlite" + (list.length === 0 ? "; there is none" : "; the ones there are: " + names));
    const found = list.find(item => item.name === wanted);
    if (found === undefined) throw new SessionError("BACKUP_NOT_FOUND", "there is no backup of that name in backups/" + (list.length === 0 ? "" : "; the ones there are: " + names));
    return found;
  }
  if (list.length === 0) throw new SessionError("BACKUP_NOT_FOUND", "there is no backup of an upgrade (backups/gateway-v<version>-before-v14.sqlite) in this data directory");
  if (list.length > 1) throw new SessionError("BACKUP_CHOICE", "there are several backups and none is guessed: " + list.map(item => item.name + " (library version " + item.version + ", " + item.bytes + " bytes)").join("; ") + "; run again with --backup <name>");
  return list[0]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// The library in use
// ---------------------------------------------------------------------------------------------------------------------
interface InUse { readonly exists: boolean; readonly version: number | null; readonly generation: number | null; readonly identity: { readonly dev: bigint; readonly ino: bigint } | null }
const notMerged = (): SessionError => new SessionError("LIBRARY_NOT_MERGED", "the write-ahead log of the library in use could not be merged into it (something still has it open, or it is damaged); close what uses it, or move gateway.sqlite, gateway.sqlite-wal and gateway.sqlite-shm together into backups/ by hand, and run this again; nothing was changed");
/**
 * Looks at the library in use, and merges its log into it: opened and closed by the one connection there is, which checkpoints and removes the log. What is left of the log after
 * that is not merged (something still has the library open, or it is damaged), and the command stops, since a library set aside without its log is not the library.
 */
function inUse(root: string): InUse {
  const file = join(root, "gateway.sqlite"), log = file + "-wal";
  const logged = (): boolean => existsSync(log) && lstatSync(log).size > 0;
  if (!existsSync(file)) {
    if (logged()) throw notMerged();
    return { exists: false, version: null, generation: null, identity: null };
  }
  const info = lstatSync(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) throw new SessionError("INVALID_STORAGE", "gateway.sqlite is not a regular file; nothing was changed");
  let version: number | null = null, generation: number | null = null, db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { timeout: 0, allowExtension: false });
    version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='owner_metadata'").get() !== undefined) {
      const row = db.prepare("SELECT owner_generation FROM owner_metadata WHERE singleton=1").get();
      generation = typeof row?.owner_generation === "number" ? row.owner_generation : null;
    }
  } catch { version = null; generation = null; }
  // The merge: a checkpoint that truncates the log, and the close of the one connection, which removes it. If it cannot be done the log is looked at below.
  try { db?.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { /* the log is looked at below */ }
  try { db?.close(); } catch { /* the log is looked at below */ }
  if (logged()) throw notMerged();
  return { exists: true, version, generation, identity: { dev: info.dev, ino: info.ino } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------------------------------------------------
interface Prepared { readonly own: number | null; readonly after: number | null; readonly conversations: number; readonly events: number; readonly active: { readonly pid: number } | null }
/**
 * Holds the copy to what the backup's name says and changes its one number: `quick_check` ok, `user_version` the one in the name, its counts noted; then its owner generation set
 * to the largest of its own and `others` (the owner row is read back whole and differs in that and nothing else). Returns the generation it had and the one it has.
 */
function prepareCopy(file: string, version: number, others: number): Prepared {
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { timeout: 0, allowExtension: false }); }
  catch (error) { throw new SessionError("BACKUP_INVALID", "the backup cannot be opened as a database (" + reasonOf(error) + "); nothing was changed"); }
  try {
    db.exec("PRAGMA synchronous=FULL");
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0]?.quick_check !== "ok") throw new SessionError("BACKUP_INVALID", "the backup does not pass the database's own check (quick_check); nothing was changed");
    const found = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (found !== version) throw new SessionError("BACKUP_INVALID", "the backup is a library of version " + found + " and its name says " + version + "; nothing was changed");
    const count = (table: string): number => Number(db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"').get()?.n);
    let conversations: number, events: number;
    try { conversations = count("sessions"); events = count("events"); } catch (error) { throw new SessionError("BACKUP_INVALID", "the backup is not a library of conversations (" + reasonOf(error) + "); nothing was changed"); }
    const hasOwner = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='owner_metadata'").get() !== undefined;
    const owner = hasOwner ? db.prepare("SELECT * FROM owner_metadata WHERE singleton=1").get() : undefined;
    const own = typeof owner?.owner_generation === "number" ? owner.owner_generation : null;
    const active = owner !== undefined && owner.owner_active === 1 && typeof owner.owner_pid === "number" && processMayBeAlive(owner.owner_pid) ? { pid: owner.owner_pid } : null;
    if (owner === undefined || own === null) return { own: null, after: null, conversations, events, active };
    const target = Math.max(own, others);
    if (target !== own) {
      const done = db.prepare("UPDATE owner_metadata SET owner_generation=? WHERE singleton=1").run(target);
      if (Number(done.changes) !== 1) throw new SessionError("BACKUP_INVALID", "the owner row of the copy could not be updated; nothing was changed");
      const after = db.prepare("SELECT * FROM owner_metadata WHERE singleton=1").get();
      if (after === undefined || after.owner_generation !== target || after.owner_pid !== owner.owner_pid || after.owner_token !== owner.owner_token || after.owner_active !== owner.owner_active)
        throw new SessionError("BACKUP_INVALID", "the owner row of the copy differs in more than its generation; nothing was changed");
      const again = db.prepare("PRAGMA quick_check").all();
      if (again.length !== 1 || again[0]?.quick_check !== "ok" || count("sessions") !== conversations || count("events") !== events) throw new SessionError("BACKUP_INVALID", "the copy does not read back as the backup after its generation was set; nothing was changed");
    }
    return { own, after: target, conversations, events, active };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw new SessionError("BACKUP_INVALID", "the backup cannot be read as a database (" + reasonOf(error) + "); nothing was changed");
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// The restore
// ---------------------------------------------------------------------------------------------------------------------
const SET_ASIDE_PARTIAL = /^gateway-v(\d+|unreadable)-set-aside-\d{8}T\d{6}Z(?:-\d+)?\.sqlite\.partial$/u;
/** A copy of exactly this library that an earlier run of this command set aside (same size, same bytes): found, not made again. */
function existingAside(folder: string, library: string, digest: { readonly bytes: number; readonly sha256: string }): string | null {
  if (!existsSync(folder)) return null;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !SET_ASIDE.test(entry.name)) continue;
    const path = join(folder, entry.name);
    if (lstatSync(path).size === digest.bytes && digestOf(path).sha256 === digest.sha256) return entry.name;
  }
  return null;
}
/** Sets the library in use aside as a copy under a name of its own: written under a `.partial` name, read back against the library, synced, and only then given its name. */
function setAside(folder: string, library: string, version: number | null, digest: { readonly bytes: number; readonly sha256: string }, when: Date): string {
  const base = "gateway-v" + (version === null ? "unreadable" : String(version)) + "-set-aside-" + stamp(when);
  let name = base + ".sqlite";
  for (let n = 2; existsSync(join(folder, name)) || existsSync(join(folder, name + ".partial")); n++) name = base + "-" + n + ".sqlite";
  const partial = join(folder, name + ".partial");
  try {
    copyFileSync(library, partial, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const descriptor = openSync(partial, constants.O_RDWR | constants.O_NOFOLLOW);
    try { fchmodSync(descriptor, 0o600); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const info = lstatSync(library);
    utimesSync(partial, info.atime, info.mtime);
    const copy = digestOf(partial);
    if (copy.bytes !== digest.bytes || copy.sha256 !== digest.sha256) throw new SessionError("INVALID_STORAGE", "the copy of the library in use does not read back as the library; nothing was changed except the unfinished copy");
    renameSync(partial, join(folder, name));
  } catch (error) {
    removeIfThere(partial);
    if (error instanceof SessionError) throw error;
    throw new SessionError("INVALID_STORAGE", "the library in use could not be copied aside in backups/ (" + String((error as { code?: unknown }).code ?? "failed") + "); nothing was changed except the unfinished copy");
  }
  return name;
}
function asides(folder: string): readonly string[] {
  return existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && SET_ASIDE.test(entry.name)).map(entry => entry.name).sort() : [];
}

/** Puts the backup of the upgrade back as the library (see the top of this file). Throws a SessionError that says why and that nothing was changed (or what was); never prints. */
export function restoreBackup(root: string, options: RestoreOptions = {}): RestoreReport {
  const dataRoot = inspectRoot(root).root, folder = join(dataRoot, "backups"), library = join(dataRoot, "gateway.sqlite"), partial = join(dataRoot, PARTIAL);
  const lock = lockRoot(dataRoot);
  try {
    options.step?.("locked", "");
    const backup = choose(candidates(folder), options.backup);
    options.step?.("chosen", backup.name);

    // The library in use, with its log merged into it. A library of an older version is the restore already done (or an upgrade never made).
    const current = inUse(dataRoot);
    options.step?.("merged", "");
    if (current.version !== null && current.version >= 1 && current.version < 14)
      return { outcome: "already", version: current.version, generation: current.generation, setAsides: asides(folder), startWith: current.version };
    if (current.version !== null && current.version > 14) throw new SessionError("LIBRARY_TOO_NEW", "the library in use is version " + current.version + ", newer than the upgrade this command undoes (14); nothing was changed");

    // The generations every library of the data directory remembers: a generation that cannot be read stops the command, since it cannot be left out of the largest.
    let known: ReturnType<typeof ownerGenerations>;
    try { known = ownerGenerations(dataRoot, current.generation); }
    catch (error) { throw error instanceof SessionError ? new SessionError(error.code, error.message + "; nothing was changed") : error; }

    // The copy, beside the library in use: whatever an earlier run left of it is ours and goes. A run that fails before the swap takes away what it made, so that it fails with the
    // data directory as it was.
    removeCopy(dataRoot);
    if (existsSync(folder)) for (const entry of readdirSync(folder)) if (SET_ASIDE_PARTIAL.test(entry)) removeIfThere(join(folder, entry));
    let kept: string | null = null, swapped = false;
    try {
      const own = current.exists ? lstatSync(library).size : 0;
      const free = options.freeBytes === undefined ? freeBytesOf(dataRoot) : options.freeBytes();
      const need = (backup.bytes + own) * 1.25 + (1 << 20);
      if (!Number.isFinite(free) || free < need) throw new SessionError("INSUFFICIENT_SPACE", "the copy of the backup and the library set aside need about " + Math.ceil(need) + " bytes free in the data directory (a copy-on-write clone needs less, but is not counted on) and the disk has " + (Number.isFinite(free) ? Math.max(0, Math.floor(free)) : 0) + "; nothing was changed");
      const copied = copyNew(join(folder, backup.name), partial);
      if (digestOf(partial).sha256 !== copied.sha256 || copied.bytes !== backup.bytes) throw new SessionError("BACKUP_INVALID", "the copy of the backup does not read back as the backup; nothing was changed");
      options.step?.("copied", backup.name);
      const prepared = prepareCopy(partial, backup.version, known.largest);
      options.step?.("edited", String(prepared.after ?? ""));
      // Nothing of the copy but its one number differs from the backup; no file of a log is beside it; it is synced.
      for (const suffix of ["-journal", "-wal", "-shm"]) if (existsSync(partial + suffix)) throw new SessionError("BACKUP_INVALID", "the copy has the files of a log beside it; nothing was changed");
      syncPath(partial);
      options.step?.("verified", "");

      // The library in use is set aside as a copy (read back against it). A copy of exactly this library that an earlier run made is found, not made again.
      let aside: string | null = null;
      if (current.exists) {
        const digest = digestOf(library);
        aside = existingAside(folder, library, digest);
        if (aside === null) { aside = kept = setAside(folder, library, current.version, digest, (options.now ?? (() => new Date()))()); }
        syncPath(folder);
      }
      options.step?.("aside", aside ?? "");

      // The swap: one rename, atomic. Before it gateway.sqlite is the library in use, after it the restored one; at no moment is there none.
      renameSync(partial, library);
      swapped = true;
      syncPath(dataRoot);
      options.step?.("swapped", "");

      // What the library in use left of a log was empty or derived (the merge above left nothing else); beside the restored library it has no place.
      for (const suffix of ["-wal", "-shm"]) removeIfThere(library + suffix);
      syncPath(dataRoot);
      options.step?.("cleaned", "");
      return { outcome: "restored", backup: { name: backup.name, version: backup.version, bytes: backup.bytes, conversations: prepared.conversations, events: prepared.events },
        setAside: aside === null ? null : { name: aside, version: current.version, generation: current.generation },
        generation: { backup: prepared.own, library: current.generation, management: known.management, capabilities: known.capabilities, now: prepared.after }, startWith: backup.version, ownerMarked: prepared.active };
    } catch (error) {
      removeCopy(dataRoot);
      if (kept !== null && !swapped) removeIfThere(join(folder, kept));
      throw error;
    }
  } finally { lock.release(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Telling it
// ---------------------------------------------------------------------------------------------------------------------
const group = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
/** The lines a person reads: what was done, in file names relative to the data directory, versions and generations; what is not brought back; no path and no word of a conversation. */
export function describeRestore(report: RestoreReport): string[] {
  if (report.outcome === "already") {
    return ["Nothing to restore: the library is version " + report.version + ", not 14. It is the library of an upgrade's backup (a restore that was cut short is complete), or an upgrade was never made.",
      report.setAsides.length === 0 ? "No library is kept in backups/ by an earlier restore." : "Kept by an earlier restore in backups/: " + report.setAsides.join(", ") + ".",
      "Start it with a build that reads library version " + report.startWith + "."];
  }
  const { backup, setAside, generation } = report;
  const lines = ["Restored the library of version " + backup.version + " from backups/" + backup.name + " (" + group(backup.conversations) + " conversation" + (backup.conversations === 1 ? "" : "s") + ", " + group(backup.events) + " events); the backup stays where it is."];
  lines.push(setAside === null ? "There was no library in use to set aside."
    : "The library in use (version " + (setAside.version ?? "unreadable") + (setAside.generation === null ? "" : ", owner generation " + setAside.generation) + ") is kept as backups/" + setAside.name + ".");
  const seen = [generation.library === null ? null : "conversation library " + generation.library, generation.management === null ? null : "management library " + generation.management,
    generation.capabilities === null ? null : "capability store " + generation.capabilities].filter((item): item is string => item !== null);
  lines.push("Owner generation of the restored library: " + (generation.backup ?? "none") + " -> " + (generation.now ?? "none") + ", the largest any library of the data directory remembers"
    + (seen.length === 0 ? "" : " (" + seen.join(", ") + ")") + "; the build that takes it over takes " + ((generation.now ?? 0) + 1) + ". Nothing else of the library was changed.");
  lines.push("Start it with a build that reads library version " + report.startWith + " (the build the library was upgraded from). The current build, started on it, backs it up and upgrades it again.");
  if (report.ownerMarked !== null) lines.push("Warning: the restored library marks the process " + report.ownerMarked.pid + " as its active owner, and a process with that id is running now: the build before refuses to take the library over (OWNER_UNCONFIRMED) until that process has exited.");
  lines.push("What is not brought back: the conversations and Turns made since the upgrade are not in the restored library; they are in the kept version 14 library"
    + (setAside === null ? "" : " (backups/" + setAside.name + ")") + ". The build before collects, when it starts, the stored content (attachments, tool details) that the restored library does not refer to, so the kept version 14 library may not read in full afterwards.");
  return lines;
}
