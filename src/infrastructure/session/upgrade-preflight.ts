import { closeSync, constants, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { verify as verifyConversation } from "../../contexts/session/domain/conversation-verify.js";
import { normalizeTool } from "../../contexts/session/domain/protocol/index.js";
import { sound } from "../../contexts/session/domain/store-conversion.js";
import { SessionError, sessionId, type PublicTool } from "../../contracts/session.js";
import { databaseBytes, freeBytesOf } from "./backup.js";
import { convertConversation, migrationState, upgradeSchema } from "./migrate-v14.js";
import { UnreadableHolders, heldTwice, liveHoldings, recordMoves, resolveSharedSessions, type NativeMove } from "./shared-sessions.js";
import { all, one } from "./statements.js";
import { ladderFaults, reasonOf, repeatedRunIds, type UpgradeFault } from "./upgrade-check.js";

/*
 * `sessions check-upgrade`: what the upgrade of a data directory would do, found out without doing it (review of the cut, finding 7 and the suspicions after it). The real data
 * of an installation is a v12 library, and neither stage of its upgrade has ever run on one; this runs both, in memory, one conversation at a time, with the very functions the
 * upgrade is made of, and says which conversations would stop it and why.
 *
 * WHAT IT DOES NOT DO. It opens the library read-only and creates, changes and removes nothing: no backup, no copy of the data, no file of any kind. It takes no ownership and no lock,
 * so it can be run while the service is running. A library with a write-ahead log beside it (the service has it open) is read through the log, as one consistent state; a library
 * with none is opened as immutable, which makes SQLite read the file and nothing else (a plain read-only open would make the two files of the log beside a database that was closed),
 * and a change to the file while it was read is told as a failure of the check, not as an answer. The content store is looked at for whether its files exist and nothing more.
 *
 * WHAT IT SAYS. Counts, the ids of the conversations that would fail and the rule that fails them, and nothing a conversation says: no title, no text, no path, no reference to a
 * native session. A rule's words are the program's own (`reasonOf`).
 *
 * HOW. The first stage (the old ladder to version 13) is `ladderFaults` over the library as it is: the very function the upgrade uses to name a conversation its ladder cannot take. The
 * second stage (the rows) takes each conversation that passes the first into a database of its own in memory, made of the library's own schema and the rows of that conversation, and
 * runs `upgradeSchema` and `convertConversation` on it: the first transaction, the conversion, every check of the conversion and the whole-conversation check. What two conversations
 * do to each other (a native session they both hold) is decided on the library as it is (`resolveSharedSessions`, the same rule) and given to each conversation's database as the
 * upgrade gives it. The time and the memory are the ones this run took.
 */

/** The marks the other stores of the data directory are known by (provider/service.ts, management/storage.ts, session/content-store.ts), and the schema versions this build opens. */
const PROVIDER_MARKER = '{"application":"harness-gateway-provider","schemaVersion":1}', MANAGEMENT_MARKER = '{"application":"harness-management","version":1}', CONTENT_MARKER = '{"application":"harness-gateway-content","schemaVersion":1}';

export interface StoreFinding {
  readonly store: "providers" | "management" | "content";
  readonly present: boolean;
  readonly schema: number | null;
  /** What would make the start fail on it, in words that name no path; null when nothing would. */
  readonly problem: string | null;
}
export interface UpgradeCheck {
  /** Whether the upgrade would get through: no conversation fails, there is room for the backup, and the other stores open. */
  readonly ok: boolean;
  /** `empty`: no tables yet; `upgrade`: version 1 to 13; `under-way`: version 14 with conversations not converted; `current`: version 14 and whole; `newer`: a version this build does not know. */
  readonly state: "empty" | "upgrade" | "under-way" | "current" | "newer";
  readonly version: number;
  readonly mode: "snapshot" | "immutable";
  readonly database: { readonly bytes: number; readonly freeBytes: number | null; readonly needBytes: number; readonly roomForBackup: boolean | null } | null;
  readonly counts: { readonly conversations: number; readonly turns: number; readonly events: number; readonly longestConversationTurns: number; readonly branches: number; readonly imports: number; readonly taskListCalls: number };
  readonly firstStage: { readonly applies: boolean; readonly checked: number; readonly failing: readonly UpgradeFault[] };
  readonly secondStage: { readonly checked: number; readonly skipped: number; readonly failing: readonly UpgradeFault[] };
  /** The native sessions two conversations hold: how many are held twice, in how many conversations the upgrade archives a binding, and which bindings. */
  readonly sharedSessions: { readonly groups: number; readonly conversations: number; readonly archived: number; readonly moves: readonly NativeMove[] };
  /** The Runs the upgrade places at the conversation's last event for want of an end that anything placed (a count, and the conversations they are in). */
  readonly endedSeqPlaced: { readonly runs: number; readonly conversations: number };
  /** The conversations with an id (a call's, an activity's, a call's parent, a native session's reference) that holds half of a surrogate pair: the upgrade keeps and restores them. */
  readonly halfPairIds: readonly string[];
  readonly stores: readonly StoreFinding[];
  /** `seconds`: what the conversion took here, in memory; `upgradeSeconds`: about what the upgrade takes writing to disk; `peakMemoryBytes`: the resident memory at the peak of this check. */
  readonly estimate: { readonly seconds: number; readonly upgradeSeconds: number; readonly peakMemoryBytes: number };
  /** The upgrade under way, when there is one: how many conversations are not converted, and where it stopped. */
  readonly underWay: { readonly remaining: number; readonly stoppedAt: string | null; readonly reason: string | null } | null;
  /** What would stop the upgrade, other than a conversation: no room for the backup, a store that does not open. */
  readonly problems: readonly string[];
}
export interface CheckOptions {
  /** The free bytes of the volume of the data directory, when the system's answer is not wanted (tests). */
  readonly freeBytes?: () => number;
  /** Told which conversation is being worked on, for a person who waits (the command line writes it to the error stream). */
  readonly progress?: (done: number, total: number) => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Opening the library without leaving a trace
// ---------------------------------------------------------------------------------------------------------------------
interface Opened { readonly db: DatabaseSync; readonly mode: "snapshot" | "immutable"; changed(): boolean; close(): void }
const SIDES = ["-wal", "-shm", "-journal"] as const;
function openForCheck(file: string): Opened {
  if (SIDES.some(suffix => existsSync(file + suffix))) {
    // Someone has it open (or left a log): read through the log. A deferred transaction pins the state the first read finds, so that everything below is one state.
    const db = new DatabaseSync(file, { readOnly: true, timeout: 1000, allowExtension: false });
    try { db.exec("PRAGMA temp_store=MEMORY; BEGIN"); one(db, "SELECT COUNT(*) AS n FROM sqlite_master"); } catch (error) { db.close(); throw error; }
    return { db, mode: "snapshot", changed: () => false, close: () => { try { if (db.isTransaction) db.exec("ROLLBACK"); } finally { db.close(); } } };
  }
  const fingerprint = (): string => { const info = statSync(file); return info.size + ":" + info.mtimeMs + ":" + info.ino + ":" + SIDES.map(suffix => existsSync(file + suffix) ? "x" : "-").join(""); };
  const before = fingerprint(), address = pathToFileURL(file);
  address.searchParams.set("mode", "ro"); address.searchParams.set("immutable", "1");
  const db = new DatabaseSync(address.href, { readOnly: true, allowExtension: false });
  db.exec("PRAGMA temp_store=MEMORY");
  return { db, mode: "immutable", changed: () => fingerprint() !== before, close: () => { db.close(); } };
}

/** The schema version in the first 100 bytes of a SQLite file; 0 for an empty file; null when it is not a database. (The other stores keep no log: their header is their version.) */
function schemaOf(path: string): number | null {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const head = Buffer.alloc(100), got = readSync(descriptor, head, 0, 100, 0);
    if (got === 0) return 0;
    return got < 100 || head.toString("latin1", 0, 16) !== "SQLite format 3\u0000" ? null : head.readUInt32BE(60);
  } finally { closeSync(descriptor); }
}
function markerOf(path: string): string | null {
  try { return statSync(path).size > 4096 ? "" : readFileSync(path, "utf8").trim(); } catch { return null; }
}
/** What the start would meet in the other stores of the data directory (the provider library, the management library, the content store) that it opens after the conversations. */
export function checkStores(root: string): readonly StoreFinding[] {
  const found: StoreFinding[] = [];
  const store = (name: StoreFinding["store"], folder: string, marker: string, markerFile: string, database: string, versions: readonly number[], extra?: (dir: string) => string | null): void => {
    const directory = join(root, folder);
    if (!existsSync(directory)) { found.push({ store: name, present: false, schema: null, problem: null }); return; }
    const said = markerOf(join(directory, markerFile)), file = join(directory, database), schema = existsSync(file) ? schemaOf(file) : null;
    let problem: string | null = null;
    if (said !== null && said !== marker) problem = "its ownership marker is not the one this build writes";
    else if (said === null && existsSync(file)) problem = "it has no ownership marker";
    else if (existsSync(file) && schema === null) problem = "its database file is not a database";
    else if (schema !== null && !versions.includes(schema)) problem = "its schema version " + schema + " is not one this build opens";
    else problem = extra?.(directory) ?? null;
    found.push({ store: name, present: true, schema, problem });
  };
  store("providers", "providers", PROVIDER_MARKER, ".harness-gateway-provider.json", "providers.sqlite", [0, 1], directory => existsSync(join(directory, "providers.sqlite")) && !existsSync(join(directory, "master.key")) ? "its database has no master key beside it" : null);
  store("management", "management", MANAGEMENT_MARKER, ".harness-management.json", "management.sqlite", [0, 1, 2, 3, 4, 5, 6]);
  store("content", "content", CONTENT_MARKER, ".harness-gateway-content.json", "content.sqlite", [0, 1]);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// One conversation in a database of its own
// ---------------------------------------------------------------------------------------------------------------------
const quoted = (name: string): string => '"' + name.replace(/"/gu, '""') + '"';
/** A database in memory with the schema of `source` and the rows of one conversation (and every table that holds nothing of one conversation, which is small), the log and the indexes last. */
function scratchOf(source: DatabaseSync, id: string): DatabaseSync {
  const scratch = new DatabaseSync(":memory:", { allowExtension: false });
  try {
    scratch.exec("PRAGMA foreign_keys=OFF; PRAGMA synchronous=OFF");
    const objects = all(source, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'");
    // A full-text index (a library of this build's own, never one of the versions that are upgraded) is derived data with tables of its own; it is not copied.
    const virtual = objects.filter(item => /^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(String(item.sql))).map(item => String(item.name));
    const derived = (name: string): boolean => virtual.some(prefix => name === prefix || name.startsWith(prefix + "_"));
    const tables = objects.filter(item => item.type === "table" && !derived(String(item.name)));
    for (const table of tables) scratch.exec(String(table.sql));
    scratch.exec("BEGIN");
    for (const table of tables) {
      const name = String(table.name), columns = all(source, "PRAGMA table_info(" + quoted(name) + ")").map(column => String(column.name)), list = columns.map(quoted).join(",");
      const filter = name === "sessions" ? " WHERE id=?" : columns.includes("session_id") ? " WHERE session_id=?" : "";
      const select = source.prepare("SELECT " + list + " FROM " + quoted(name) + filter), insert = scratch.prepare("INSERT INTO " + quoted(name) + "(" + list + ") VALUES(" + columns.map(() => "?").join(",") + ")");
      select.setReadBigInts(true);
      for (const row of filter === "" ? select.iterate() : select.iterate(id)) insert.run(...columns.map(column => row[column] as SQLInputValue));
    }
    scratch.exec("COMMIT");
    for (const kind of ["index", "view", "trigger"]) for (const item of objects.filter(entry => entry.type === kind && !derived(String(entry.name)))) scratch.exec(String(item.sql));
    return scratch;
  } catch (error) { scratch.close(); throw error; }
}

interface Stats { readonly turns: number; readonly taskListCalls: number; readonly halfPair: boolean; readonly origin: "fork" | "import" | null }
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** What the check counts that only the snapshot says, read from its JSON without the frozen parse (a conversation that does not parse is a finding of its own, not a reason to count nothing). */
function statsOf(text: string): Stats {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { turns: 0, taskListCalls: 0, halfPair: false, origin: null }; }
  const state = record(value), runs = Array.isArray(state?.runs) ? state.runs as unknown[] : [];
  let taskListCalls = 0, halfPair = false;
  const odd = (text_: unknown): boolean => typeof text_ === "string" && sound(text_).marks.length > 0;
  for (const run of runs) {
    const item = record(run);
    for (const tool of Array.isArray(item?.tools) ? item.tools as unknown[] : []) {
      const call = record(tool);
      if (call === null) continue;
      if (odd(call.id) || odd(call.parentId)) halfPair = true;
      try { if (!normalizeTool(call as unknown as PublicTool, { seq: 0, detail: null, turn: "ended" }).row) taskListCalls++; } catch { /* a call no rule can read is not a task list */ }
    }
    for (const activity of Array.isArray(item?.activities) ? item.activities as unknown[] : []) if (odd(record(activity)?.id)) halfPair = true;
  }
  for (const binding of Array.isArray(state?.nativeBindings) ? state.nativeBindings as unknown[] : []) if (odd(record(binding)?.checkpoint)) halfPair = true;
  const origin = record(state?.origin)?.kind;
  return { turns: runs.length, taskListCalls, halfPair, origin: origin === "fork" || origin === "import" ? origin : null };
}

// ---------------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------------
const count = (db: DatabaseSync, sql: string): number => Number(one(db, sql)?.n ?? 0);

/** What the upgrade of the data directory `root` would do (see the top of this file). Throws when there is no library there, or when it changed while it was read. */
export function checkUpgrade(root: string, options: CheckOptions = {}): UpgradeCheck {
  const file = join(root, "gateway.sqlite");
  if (!existsSync(file)) throw new SessionError("INVALID_INPUT", "there is no conversation library in this data directory");
  const stores = checkStores(root), problems: string[] = [];
  for (const finding of stores) if (finding.problem !== null) problems.push("the " + finding.store + " store: " + finding.problem);
  const opened = openForCheck(file);
  try {
    const check = inspect(root, opened, stores, problems, options);
    if (opened.changed()) throw changed();
    return check;
  } catch (error) {
    // A read that fails because the file under it was changed is the change, not a finding.
    if (opened.changed() && !(error instanceof SessionError && error.code === "DATABASE_CHANGED")) throw changed();
    throw error;
  } finally { opened.close(); }
}
const changed = (): SessionError => new SessionError("DATABASE_CHANGED", "the conversation library changed while it was being read: run the check again when nothing writes to it");

function inspect(root: string, opened: Opened, stores: readonly StoreFinding[], problems: string[], options: CheckOptions): UpgradeCheck {
  const db = opened.db, version = Number(one(db, "PRAGMA user_version")?.user_version);
  const nothing = { conversations: 0, turns: 0, events: 0, longestConversationTurns: 0, branches: 0, imports: 0, taskListCalls: 0 };
  const base = { version, mode: opened.mode, database: null, counts: nothing, firstStage: { applies: false, checked: 0, failing: [] as UpgradeFault[] }, secondStage: { checked: 0, skipped: 0, failing: [] as UpgradeFault[] },
    sharedSessions: { groups: 0, conversations: 0, archived: 0, moves: [] as NativeMove[] }, endedSeqPlaced: { runs: 0, conversations: 0 }, halfPairIds: [] as string[], stores,
    estimate: { seconds: 0, upgradeSeconds: 0, peakMemoryBytes: 0 }, underWay: null };
  if (!Number.isSafeInteger(version) || version < 0) throw new SessionError("INVALID_DATA", "the library has no readable schema version");
  if (version === 0) return { ...base, ok: problems.length === 0, state: "empty", problems };
  if (version > 14) return { ...base, ok: false, state: "newer", problems: [...problems, "the library is version " + version + ", which this build does not know"] };
  if (version === 14) {
    const state = migrationState(db);
    if (state.kind !== "converting") return { ...base, ok: problems.length === 0, state: "current", problems };
    return { ...base, ok: problems.length === 0 && state.stopped === null, state: "under-way", underWay: { remaining: state.remaining, stoppedAt: state.stopped?.sessionId ?? null, reason: state.stopped?.reason ?? null }, problems };
  }

  // The library as it is: its size, the room for the backup, how many of everything.
  const bytes = databaseBytes(root), need = 2 * bytes;
  let free: number | null = null;
  try { free = options.freeBytes === undefined ? freeBytesOf(root) : options.freeBytes(); } catch { free = null; }
  const room = free === null ? null : Number.isFinite(free) && free >= need;
  if (room === false) problems.push("the volume has " + Math.max(0, Math.floor(free ?? 0)) + " bytes free and the upgrade needs about twice the size of the library (" + need + ")");
  const ids = all(db, "SELECT id FROM sessions ORDER BY rowid").map(row => String(row.id));
  const longest = Number(one(db, "SELECT MAX(json_array_length(snapshot,'$.runs')) AS n FROM sessions")?.n ?? 0);
  const events = count(db, "SELECT COUNT(*) AS n FROM events");

  // The first stage: the old ladder, over every conversation.
  options.progress?.(0, ids.length);
  const first: UpgradeFault[] = [...ladderFaults(db, version)], broken = new Set(first.map(fault => fault.sessionId));
  // What two conversations do to each other. A conversation that cannot be read cannot be asked who used a native session last: the upgrade refuses it (as it does in its first
  // transaction), and so it is one of the conversations of the first stage that fail, and is not tried in the second.
  let moves: readonly NativeMove[] = [];
  try { moves = resolveSharedSessions(db, "snapshot"); } catch (error) {
    if (!(error instanceof UnreadableHolders)) throw error;
    for (const fault of error.faults) if (!broken.has(fault.sessionId)) { first.push(fault); broken.add(fault.sessionId); }
  }

  // A Run id two conversations hold is refused by the upgrade in its first transaction too (the tables keep a Run id once); each such conversation passes the second stage alone.
  for (const fault of repeatedRunIds(db, "snapshot")) if (!first.some(known => known.sessionId === fault.sessionId)) first.push(fault);

  // The second stage: each conversation in a database of its own.
  const second: UpgradeFault[] = [], stats: Stats[] = [], halfPairIds: string[] = [];
  let endedRuns = 0, endedConversations = 0, skipped = 0, seconds = 0, peak = process.memoryUsage().rss;
  for (const [at, id] of ids.entries()) {
    try {
      const stat = statsOf(String(one(db, "SELECT snapshot FROM sessions WHERE id=?", id)?.snapshot));
      stats.push(stat); if (stat.halfPair) halfPairIds.push(id);
    } catch (error) { if (!broken.has(id)) { first.push({ sessionId: id, reason: reasonOf(error) }); broken.add(id); } }
    if (broken.has(id)) { skipped++; options.progress?.(at + 1, ids.length); continue; }
    let scratch: DatabaseSync | null = null;
    try {
      scratch = scratchOf(db, id);
      const started = performance.now();
      upgradeSchema(scratch, version);
      recordMoves(scratch, moves.filter(move => move.sessionId === id));
      convertConversation(scratch, sessionId(id), { verify: verifyConversation, note: note => { if (note.endedSeqPlaced > 0) { endedRuns += note.endedSeqPlaced; endedConversations++; } } });
      seconds += (performance.now() - started) / 1000;
    } catch (error) {
      // A conversation that passed the first stage and fails in the first transaction of its database is told as the first stage failing (the cause is the ladder's).
      const refused = error instanceof SessionError && error.code === "MIGRATION_REFUSED";
      (refused ? first : second).push({ sessionId: id, reason: reasonOf(refused && error.cause !== undefined ? error.cause : error) });
    } finally { scratch?.close(); }
    peak = Math.max(peak, process.memoryUsage().rss);
    options.progress?.(at + 1, ids.length);
  }
  const position = new Map(ids.map((id, at) => [id, at] as const));
  first.sort((left, right) => (position.get(left.sessionId) ?? 0) - (position.get(right.sessionId) ?? 0));
  return { ...base, ok: first.length + second.length === 0 && problems.length === 0, state: "upgrade", database: { bytes, freeBytes: free, needBytes: need, roomForBackup: room },
    counts: { conversations: ids.length, turns: stats.reduce((sum, item) => sum + item.turns, 0), events, longestConversationTurns: Number.isFinite(longest) ? longest : 0,
      branches: stats.filter(item => item.origin === "fork").length, imports: stats.filter(item => item.origin === "import").length, taskListCalls: stats.reduce((sum, item) => sum + item.taskListCalls, 0) },
    firstStage: { applies: version < 13, checked: ids.length, failing: first }, secondStage: { checked: ids.length - skipped, skipped, failing: second },
    sharedSessions: { groups: heldTwice(liveHoldings(db, "snapshot")), conversations: new Set(moves.map(move => move.sessionId)).size, archived: moves.length, moves },
    endedSeqPlaced: { runs: endedRuns, conversations: endedConversations }, halfPairIds,
    // Measured on a library of 313 MB (40 conversations of 256 Turns): the upgrade took 1.5 times the conversion in memory, and its peak memory was a little under the check's.
    estimate: { seconds, upgradeSeconds: seconds * 2, peakMemoryBytes: peak }, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// Telling it
// ---------------------------------------------------------------------------------------------------------------------
const group = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
const SHOWN = 20;
function listed(faults: readonly UpgradeFault[]): string[] {
  return [...faults.slice(0, SHOWN).map(fault => "  " + fault.sessionId + ": " + fault.reason), ...(faults.length > SHOWN ? ["  and " + (faults.length - SHOWN) + " more"] : [])];
}
/** How long a count of seconds is, in a word: the measure is the order of it, not the number. */
export function orderOfTime(seconds: number): string {
  return seconds < 10 ? "under ten seconds" : seconds < 100 ? "tens of seconds" : seconds < 600 ? "minutes" : seconds < 6000 ? "tens of minutes" : "hours";
}
export function orderOfBytes(bytes: number): string {
  return bytes < 1 << 27 ? "under 128 MB" : bytes < 1 << 28 ? "about 128 to 256 MB" : bytes < 1 << 29 ? "about 256 to 512 MB" : bytes < 1 << 30 ? "about half a gigabyte to a gigabyte" : "over a gigabyte";
}
/** The lines a person reads: counts, ids and rules, no conversation's words. */
export function describeCheck(check: UpgradeCheck): string[] {
  const lines: string[] = [];
  if (check.state === "empty") lines.push("The library has no tables yet: a start makes a new one. Nothing to upgrade.");
  else if (check.state === "newer") lines.push("The library is version " + check.version + ", newer than this build knows.");
  else if (check.state === "current") lines.push("The library is version 14 and whole. Nothing to upgrade.");
  else if (check.state === "under-way" && check.underWay !== null) {
    lines.push("An upgrade is under way: the library is version 14 and " + check.underWay.remaining + " conversation" + (check.underWay.remaining === 1 ? " is" : "s are") + " not converted yet.");
    if (check.underWay.stoppedAt !== null) lines.push("It stopped at " + check.underWay.stoppedAt + ": " + check.underWay.reason + ". The next start goes on from there.");
    else lines.push("The next start goes on from there; this check does not look at those conversations.");
  } else {
    const { counts, database } = check;
    lines.push("Library: version " + check.version + ", " + group(counts.conversations) + " conversation" + (counts.conversations === 1 ? "" : "s") + ", " + group(counts.turns) + " Turns, " + group(counts.events) + " events; the longest conversation has "
      + group(counts.longestConversationTurns) + " Turns.");
    if (database !== null) lines.push("Size: " + group(database.bytes) + " bytes" + (database.freeBytes === null ? "; the free space could not be read" : "; " + group(Math.floor(database.freeBytes)) + " bytes free, the backup and the upgrade need about " + group(database.needBytes) + ": " + (database.roomForBackup ? "enough" : "NOT ENOUGH")) + ".");
    lines.push("Branches: " + counts.branches + ", continued native sessions: " + counts.imports + ", task-list calls: " + group(counts.taskListCalls) + ".");
    lines.push("First stage (" + (check.firstStage.applies ? "the old format read up to version 13; " : "") + "who keeps a native session two conversations hold; no Run id in two conversations): "
      + (check.firstStage.checked - check.firstStage.failing.length) + " of " + check.firstStage.checked + " conversations pass; nothing is changed until all do.");
    lines.push(...listed(check.firstStage.failing));
    lines.push("Second stage (version 13 to the tables): " + (check.secondStage.checked - check.secondStage.failing.length) + " of " + check.secondStage.checked + " conversations pass" + (check.secondStage.skipped > 0 ? " (" + check.secondStage.skipped + " not tried: the first stage fails for them)" : "") + ".");
    lines.push(...listed(check.secondStage.failing));
    lines.push("Native sessions two conversations hold: " + check.sharedSessions.groups + (check.sharedSessions.archived === 0 ? "." : "; " + check.sharedSessions.archived + " binding" + (check.sharedSessions.archived === 1 ? "" : "s") + " in "
      + check.sharedSessions.conversations + " conversation" + (check.sharedSessions.conversations === 1 ? "" : "s") + " would be archived (the one that used it last keeps it; the other opens a new native session at its next Turn and carries its history):"));
    for (const move of check.sharedSessions.moves.slice(0, SHOWN)) lines.push("  " + move.sessionId + " gives up its " + move.harnessId + "/" + move.controlId + " binding " + move.ordinal + " to " + move.keptBy);
    if (check.sharedSessions.moves.length > SHOWN) lines.push("  and " + (check.sharedSessions.moves.length - SHOWN) + " more");
    lines.push("Runs whose end is placed at the conversation's last event for want of any other: " + group(check.endedSeqPlaced.runs) + " in " + check.endedSeqPlaced.conversations + " conversation" + (check.endedSeqPlaced.conversations === 1 ? "" : "s") + ".");
    lines.push("Conversations with an id that holds half of a surrogate pair (kept and restored as they are): " + check.halfPairIds.length + (check.halfPairIds.length === 0 ? "." : ": " + check.halfPairIds.slice(0, SHOWN).join(", ") + (check.halfPairIds.length > SHOWN ? " and " + (check.halfPairIds.length - SHOWN) + " more" : "") + "."));
    lines.push("Estimate: " + check.estimate.seconds.toFixed(1) + " s of conversion in memory here; the upgrade, writing to disk, is " + orderOfTime(check.estimate.upgradeSeconds) + "; memory " + orderOfBytes(check.estimate.peakMemoryBytes)
      + " (" + group(Math.round(check.estimate.peakMemoryBytes / 1048576)) + " MB at the peak of this check).");
  }
  for (const finding of check.stores) lines.push("Store " + finding.store + ": " + (finding.present ? (finding.problem === null ? "ok" + (finding.schema === null ? "" : " (schema " + finding.schema + ")") : "WOULD FAIL, " + finding.problem) : "not there yet (a start makes it)") + ".");
  for (const problem of check.problems) if (!check.stores.some(finding => finding.problem !== null && problem === "the " + finding.store + " store: " + finding.problem)) lines.push("Problem: " + problem + ".");
  lines.push(check.ok ? "Verdict: the upgrade would pass." : "Verdict: the upgrade would NOT pass.");
  return lines;
}
