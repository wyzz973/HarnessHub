import type { DatabaseSync } from "node:sqlite";
import type { ContentRefRow, HeadJson, Mutation, RunRow, StorageConversion, VerifyConversation } from "../../contracts/conversation.js";
import type { ContextEffect } from "../../contracts/control.js";
import type { ExecutedOn, RelayIndexRow } from "../../contracts/relay.js";
import { SessionError, type PublicRun, type SessionEvent, type SessionId, type SessionSnapshot } from "../../contracts/session.js";
import { conversationTitle } from "../../contracts/web.js";
import { noticePrint } from "../../contexts/session/domain/items-place.js";
import { originToRows, storageConversion } from "../../contexts/session/domain/store-conversion.js";
import type { RelayFact } from "../../contexts/session/domain/relay/delivery.js";
import { applyMutation } from "./apply.js";
import { backupBeforeV14 } from "./backup.js";
import { WHOLE, loadConversation, readItems } from "./load.js";
import { LegacyRelayLedger } from "./legacy/ledger.js";
import { climbToV13 } from "./legacy/ladder.js";
import { dispatched } from "./legacy/advance.js";
import { legacyContentReferences } from "./legacy/references.js";
import { RELAY_MAX_SEQ, parseExecutedOn } from "./legacy/relay-contract.js";
import { parseSession, terminal } from "./legacy/state.js";
import { ConversationTables } from "./read.js";
import { RELAY_V14_REBUILD, schemaV14Statements } from "./schema-v14.js";
import { repairRelayPrefs } from "./relay-tables.js";
import { bindingColumns, bindingRowFrom, bindingRowOf, canonicalJson, commandRowOf, itemRowOf, runRowFrom, sourceThroughOrdinal, switchColumns, switchRowFrom, switchRowOf, utf8Length } from "./rows.js";
import { snapshotFromRows } from "./snapshot-adapter.js";
import { all, one, prepared } from "./statements.js";

/*
 * The migration of a database to store v14 (ADR-057 3.6): from the one-snapshot-per-conversation tables of v1 to v13 to the rows of v14, once, in the order
 * the ADR gives:
 *
 *   1. backup (backup.ts; nothing is changed if it fails or the disk is too small), then
 *   2. THE FIRST TRANSACTION (`upgradeSchema`): the old ladder from the database's version to v13 (legacy/ladder.ts), the relay tables rebuilt without the sizes
 *      they were held to, `sessions` altered (`snapshot` becomes `head`; every row `format` 13) and the v14 tables made, the migration's bookkeeping made, the
 *      version set to 14. After it the database is v14 and every conversation is still the snapshot it was; an old build refuses it.
 *   3. EACH CONVERSATION IN A TRANSACTION OF ITS OWN (`convertConversation`): its snapshot is read with the frozen parse, its Runs made into rows by the storage
 *      conversion (T3), the facts of the event log and of the relay's index that a Run needs placed on its row (below), the rows written (apply.ts) with its
 *      head last and `format` 14, the rows read back with the readers the store will use and held to the snapshot (below). Only then is it committed.
 *   4. THE REFERENCES: when the last conversation is converted, the set of content ids the old code worked out for every conversation is held to the one the
 *      collector will use; they must be equal before the collector may delete anything (`collectionGate`).
 *
 * A conversation that cannot be converted or does not check ends the migration: its transaction is rolled back, the database stays v14 with that conversation
 * (and those after it) still the snapshot they were, the reason is kept in the conversation's `last_error` and told in the report. NOTHING IS QUARANTINED: the
 * start does not go on with a conversation it could not read. A build that fixes the cause runs `migrateToV14` again: the conversations done are not done again,
 * the rest follow, and every id and seq comes from the data, so a conversation converted after a stop is the same rows as one converted without. A process killed at
 * any moment is a stop (SQLite rolls back what was not committed) with no reason to tell.
 *
 * THE FACTS A RUN GETS FROM THE EVENTS AND THE INDEX (review I1; the relay sends again what it cannot place, and loses nothing):
 *   ended_seq        the first of its `run.ended` and the `session.recovered` that names it in `unknownRunIds` or `cancelledRunIds`; else its `relay_index` row's
 *                    seq (a Run made before v13); else NULL, which a reader takes as ABOVE the relay's mark (never 0, never skipped). Not the conversation's `lastSeq`.
 *   is_command       a `run.native_command` names the Run, or (before v13) its index row has a command effect. command_effect: the effect the command was read with (the
 *                    last `run.native_command`'s), settled_effect the one its first `run.ended` settled. A command whose effect cannot be read is `is_command` with
 *                    neither. For a Run made before v13 the index row's effect IS the settled one (the v13 migration worked it out from the end and the outcome), and
 *                    that is what `settled_effect` holds for it; with no index row a finished, dispatched command Run is settled `unknown`. This is what makes the new reading
 *                    (a command is a fact when `settled_effect ?? command_effect` is `keep`) give what the old ledger gave.
 *   executed_*       before v13 a Run has no `relay`: where it ran is the index row's `executedOn`, which the column holds (its `run_json` has no `relay`, as the Run had none).
 *   acknowledged_by  for an `unknown` Run: the first effective switch whose `sourceRunIds` or `acknowledgedUnknown` has it (review I2: not "an ordinal at or below
 *                    the switch's sources", which a Run that queued while the switch was asked for, or ended unknown after it, would satisfy wrongly).
 *
 * WHAT IS CHECKED, in the transaction, before the commit (a difference is a mistake of the program, never a thing to put up with): the conversation read back from the
 * tables with the readers the store is made of (`readItems`, the row decoders, `loadConversation`) deep-equals the snapshot it came from (every Run with its messages, the
 * commands, the bindings with their relay states, the switches, the origin and its quoted history verbatim, the head's small objects); the counts of Runs, commands,
 * bindings, switches, quoted messages and events; the head's columns that no snapshot holds (title, kept, run count); where a row holds a fact twice (a binding's or a
 * switch's column and its JSON) that the two agree, and that each stored Run is the row that converting what it reads back as writes; on every place a Run ran, every
 * binding of the conversation and one no Run ran at, the old ledger's facts equal the new reading's; the content references written equal the set the old code worked out;
 * no unknown Run an open conversation holds is unacknowledged; and `verify` (the whole-conversation checker), when one is given, finds nothing. What a check reports is
 * where a difference is and what kind, never a value: the conversation's words do not go into a log.
 *
 * The full-text indexes are not written (derived data; `rebuildSearchIndex` makes them, as a step of its own), and nothing here runs a Harness or reads any other
 * file of the data root than the database and its backups. It is called by tests only until the cut.
 */

export interface MigrationOptions {
  /** The data root: `gateway.sqlite` is in it, and the backup under `backups/`. */
  readonly root: string;
  /** The free bytes of the volume of the root, when the system's answer is not wanted (tests). */
  readonly freeBytes?: () => number;
  /** Runs first inside the first transaction, before anything is changed: where the store confirms that the owner before it has exited. A throw rolls the upgrade back. */
  readonly confirmOwnerExited?: (db: DatabaseSync) => void;
  /** Runs inside the first transaction, after the schema is made and before it commits: where the store claims its owner generation. A throw rolls the upgrade back. */
  readonly claim?: (db: DatabaseSync) => void;
  /** The whole-conversation checker (ADR-057 3.3, `verify`): called on each conversation converted, with it and the reader; a violation stops the migration. */
  readonly verify?: VerifyConversation;
  /** The storage conversion; the one of the domain unless a test gives another (to see what a wrong one does). */
  readonly conversion?: StorageConversion;
  readonly log?: (line: string) => void;
  /** Called at each point of the work with its name and what it is about; a test or a peer process waits here to be stopped at a chosen point. */
  readonly step?: (phase: "backup" | "backed-up" | "upgraded" | "written" | "converted" | "finished", detail: string) => void;
}
export interface MigrationReport {
  /** The version the database was at when this call began. */
  readonly from: number;
  /** The backup taken by this call; null when the database was already v14 (a resumed migration). */
  readonly backup: string | null;
  /** The conversations this call converted, and those that were converted before it. */
  readonly converted: number;
  readonly alreadyConverted: number;
  /** The conversation that ended the migration and why, or null. */
  readonly stopped: { readonly sessionId: SessionId; readonly reason: string } | null;
  /** The content references compared (when every conversation is converted); null until then. */
  readonly references: ReferenceReport | null;
}
export interface ReferenceReport {
  readonly equal: boolean;
  /** Ids the old code referenced and the collector would not (the ones it would delete), and ids it would keep that nothing referenced: at most 20 of each, and their counts. */
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly missingCount: number;
  readonly extraCount: number;
}

const CLOSED = "('completed','cancelled','failed','unknown')";
const isSqliteError = (error: unknown): boolean => error instanceof Error && (error as { code?: unknown }).code === "ERR_SQLITE_ERROR";
const userVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA user_version").get()?.user_version);
const hasTable = (db: DatabaseSync, name: string): boolean => one(db, "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?", name) !== undefined;
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => Number(one(db, sql, ...args)?.n);

// ---------------------------------------------------------------------------------------------------------------------
// The bookkeeping and what a reader or the collector asks of it
// ---------------------------------------------------------------------------------------------------------------------

/** Made in the first transaction and gone when the first start after the migration has reported (`acknowledgeFirstStart`). */
const BOOKKEEPING: readonly string[] = [
  "CREATE TABLE migration_v14(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID",
  // The content ids the OLD code worked out for each conversation before it was converted: kept in the same transaction as the conversion, so that a resumed migration compares all of them.
  "CREATE TABLE migration_v14_refs(session_id TEXT NOT NULL, content_id TEXT NOT NULL, PRIMARY KEY(session_id, content_id)) STRICT, WITHOUT ROWID",
];
function mark(db: DatabaseSync, key: string, value: string): void { prepared(db, "INSERT INTO migration_v14(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
function marked(db: DatabaseSync, key: string): string | undefined { const row = hasTable(db, "migration_v14") ? one(db, "SELECT value FROM migration_v14 WHERE key=?", key) : undefined; return row === undefined ? undefined : String(row.value); }

export type MigrationState =
  /** A database of store v1 to v13: nothing is converted. */
  | { readonly kind: "not-started"; readonly version: number }
  /** A v14 database some of whose conversations are still the snapshot they were: the migration is under way, or stopped (`stopped` says where and why). */
  | { readonly kind: "converting"; readonly remaining: number; readonly converted: number; readonly stopped: { readonly sessionId: string; readonly reason: string } | null; readonly message: string }
  | { readonly kind: "done" };
/**
 * Where a database is in the migration, from its rows alone (read-only: a reader on another connection, the command line's tools, calls it). Between the first
 * transaction and the last conversation the database is v14 and its rows are 13 and 14 mixed (review I12); a reader that finds `converting` says so and reads
 * nothing of the unconverted conversations as v14.
 */
export function migrationState(db: DatabaseSync): MigrationState {
  const version = userVersion(db);
  if (!Number.isSafeInteger(version) || version < 1 || version > 14) throw new SessionError("INVALID_DATA", "unknown business database schema version");
  if (version < 14) return { kind: "not-started", version };
  const remaining = count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format<14");
  if (remaining === 0) return { kind: "done" };
  const failed = one(db, "SELECT id, last_error FROM sessions WHERE format<14 AND last_error IS NOT NULL ORDER BY rowid LIMIT 1");
  const stopped = failed === undefined ? null : { sessionId: String(failed.id), reason: String(failed.last_error) };
  const converted = count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format=14");
  return { kind: "converting", remaining, converted, stopped, message: "the database is being upgraded to the new storage: " + remaining + " conversation" + (remaining === 1 ? " is" : "s are") + " not converted yet"
    + (stopped === null ? "" : "; the upgrade stopped at " + stopped.sessionId + " (" + stopped.reason + ")") };
}

export interface CollectionGate {
  readonly allowed: boolean;
  /** The first start after the migration: the collector reports what it would collect and deletes nothing. */
  readonly reportOnly: boolean;
  readonly reason: string | null;
}
/**
 * Whether the content collector may delete (ADR-057 M2, the one loss of content a backup cannot bring back): not while a conversation is not converted, not
 * before the references of the conversion were compared and found equal, and on the first start after the migration only to report. A database that never
 * had a migration (made as v14) is free to collect.
 */
export function collectionGate(db: DatabaseSync): CollectionGate {
  const unconverted = count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format<14");
  if (unconverted > 0) return { allowed: false, reportOnly: false, reason: unconverted + " conversation" + (unconverted === 1 ? " is" : "s are") + " not converted to the new storage yet: nothing is collected until all are" };
  if (!hasTable(db, "migration_v14")) return { allowed: true, reportOnly: false, reason: null };
  const references = marked(db, "references");
  if (references !== "equal") return { allowed: false, reportOnly: false, reason: references === undefined || references === "pending" ? "the content the conversations refer to was not compared with what the old code referred to yet"
    : "the content the converted conversations refer to differs from what the old code referred to (" + references.replace(/^differ: /u, "") + "): nothing is collected" };
  return { allowed: false, reportOnly: true, reason: "the first start after the upgrade only reports what would be collected and deletes nothing" };
}
/** The first start after the migration has reported: the bookkeeping is dropped and the collector is free. */
export function acknowledgeFirstStart(db: DatabaseSync): void {
  if (!hasTable(db, "migration_v14")) return;
  if (marked(db, "references") !== "equal" || count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format<14") > 0) throw new SessionError("INVALID_TRANSITION", "the migration did not end with equal references: its bookkeeping stays");
  db.exec("DROP TABLE migration_v14"); if (hasTable(db, "migration_v14_refs")) db.exec("DROP TABLE migration_v14_refs");
}
/**
 * Holds the references the collector will use (`ConversationTables.contentReferences`: the references of the converted conversations) to the ones the old code
 * worked out before each was converted. Records the answer in the bookkeeping. Equal is the condition of `collectionGate` letting the collector run.
 */
export function compareReferences(db: DatabaseSync): ReferenceReport {
  const before = new Set(all(db, "SELECT DISTINCT content_id FROM migration_v14_refs").map(row => String(row.content_id)));
  const after = new ConversationTables(db).contentReferences();
  const missing = [...before].filter(id => !after.has(id)).sort(), extra = [...after].filter(id => !before.has(id)).sort();
  const report: ReferenceReport = { equal: missing.length === 0 && extra.length === 0, missing: missing.slice(0, 20), extra: extra.slice(0, 20), missingCount: missing.length, extraCount: extra.length };
  mark(db, "references", report.equal ? "equal" : "differ: " + missing.length + " ids the old code kept are not kept, " + extra.length + " ids are kept that it did not");
  return report;
}

// ---------------------------------------------------------------------------------------------------------------------
// The first transaction
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The first transaction: a database of version `from` (1 to 13) becomes a v14 database whose conversations are all still snapshots. All or nothing: a failure
 * leaves the database as it was. `PRAGMA foreign_keys=OFF` comes before the transaction (it does nothing inside one) because the relay tables are rebuilt, and the
 * keys are checked, and put back on, before it ends (SQLite's way of rebuilding a table other tables point at).
 */
export function upgradeSchema(db: DatabaseSync, from: number, options: Pick<MigrationOptions, "confirmOwnerExited" | "claim"> = {}): void {
  if (!Number.isSafeInteger(from) || from < 1 || from > 13) throw new SessionError("INVALID_INPUT", "only a database of version 1 to 13 is upgraded");
  const keys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      options.confirmOwnerExited?.(db);
      climbToV13(db, from);
      // A v13 database made while the contract listed fewer preference keys keeps its preferences under the current list.
      repairRelayPrefs(db);
      for (const sql of RELAY_V14_REBUILD) db.exec(sql);
      for (const sql of schemaV14Statements("v13")) db.exec(sql);
      for (const sql of BOOKKEEPING) db.exec(sql);
      mark(db, "from", String(from)); mark(db, "phase", "converting"); mark(db, "references", "pending");
      options.claim?.(db);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new SessionError("INVALID_DATA", "the upgrade left " + violations.length + " broken foreign keys");
      db.exec("PRAGMA user_version=14");
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.exec("PRAGMA foreign_keys=" + (keys ? "ON" : "OFF")); }
}

// ---------------------------------------------------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------------------------------------------------

interface EventFacts {
  readonly ended: ReadonlyMap<string, number>;
  readonly settled: ReadonlyMap<string, ContextEffect>;
  readonly commands: ReadonlyMap<string, ContextEffect | undefined>;
}
const CONTEXT_EFFECTS: readonly string[] = ["keep", "none", "compact", "clear", "rewind", "unknown"];
const effectOf = (value: unknown): ContextEffect | undefined => typeof value === "string" && CONTEXT_EFFECTS.includes(value) ? value as ContextEffect : undefined;
const stringsOf = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** What the event log says of the Runs the relay places by it: the same reading as the old ledger's (legacy/ledger.ts), once, from the start. */
function scanEvents(db: DatabaseSync, id: string): EventFacts {
  const ended = new Map<string, number>(), settled = new Map<string, ContextEffect>(), commands = new Map<string, ContextEffect | undefined>();
  for (const row of all(db, "SELECT seq, event_json FROM events WHERE session_id=? AND json_extract(event_json,'$.type') IN ('run.ended','run.native_command','session.recovered') ORDER BY seq", id)) {
    const event = JSON.parse(String(row.event_json)) as { readonly type?: unknown; readonly data?: unknown }, seq = Number(row.seq);
    const data = event.data !== null && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : {}, run = typeof data.runId === "string" ? data.runId : null;
    if (event.type === "run.ended" && run !== null && !ended.has(run)) { ended.set(run, seq); const effect = effectOf(data.contextEffect); if (effect !== undefined) settled.set(run, effect); }
    else if (event.type === "run.native_command" && run !== null) commands.set(run, effectOf(data.contextEffect));
    else if (event.type === "session.recovered") for (const named of [...stringsOf(data.unknownRunIds), ...stringsOf(data.cancelledRunIds)]) if (!ended.has(named)) ended.set(named, seq);
  }
  return { ended, settled, commands };
}
interface IndexFacts { readonly seq: number | undefined; readonly executedOn: ExecutedOn | null; readonly commandEffect: ContextEffect | null }
/** The index rows the v12 to v13 migration wrote: where a Run made before v13 ran, and its command effect and end. */
function indexRows(db: DatabaseSync, id: string): { readonly facts: ReadonlyMap<string, IndexFacts>; readonly rows: readonly RelayIndexRow[] } {
  const facts = new Map<string, IndexFacts>(), rows: RelayIndexRow[] = [];
  for (const row of all(db, "SELECT run_id, index_json FROM relay_index WHERE session_id=? ORDER BY run_index", id)) {
    const index = JSON.parse(String(row.index_json)) as Record<string, unknown>;
    rows.push({ runId: String(row.run_id) as RelayIndexRow["runId"], index });
    if (facts.has(String(row.run_id))) continue;
    let executedOn: ExecutedOn | null = null;
    if (index.executedOn !== null && index.executedOn !== undefined) { try { executedOn = parseExecutedOn(index.executedOn); } catch { executedOn = null; } }
    const seq = typeof index.seq === "number" && Number.isSafeInteger(index.seq) && index.seq >= 1 && index.seq <= RELAY_MAX_SEQ ? index.seq : undefined;
    facts.set(String(row.run_id), { seq, executedOn, commandEffect: effectOf(index.commandEffect) ?? null });
  }
  return { facts, rows };
}
function throughOrdinal(db: DatabaseSync, source: string, run: string): number {
  const converted = one(db, "SELECT ordinal FROM runs WHERE session_id=? AND run_id=?", source, run);
  if (converted !== undefined) return Number(converted.ordinal);
  const old = one(db, "SELECT j.key AS key FROM sessions s, json_each(s.head,'$.runs') j WHERE s.id=? AND s.format<14 AND json_extract(j.value,'$.id')=?", source, run);
  return old === undefined ? -1 : Number(old.key);
}

type ConversionAt = Parameters<StorageConversion["toItems"]>[2];
/** What each Run was converted with: the facts of the events and the index it was given, and where the index says it ran (for a Run made before v13, whose own facts say nothing). */
interface RunContext { readonly at: ConversionAt; readonly executedOn: ExecutedOn | null }
interface Prepared { readonly mutation: Mutation; readonly contexts: readonly RunContext[] }
/** The Mutation that writes a conversation: its snapshot as rows, the head last (apply.ts writes it so, with `format` 14). */
function prepare(db: DatabaseSync, state: SessionSnapshot, version: number, conversion: StorageConversion): Prepared {
  const id = state.id, events = scanEvents(db, id), { facts: index } = indexRows(db, id);
  const messages = new Map(state.messages.map(message => [message.id as string, message]));
  const mutation: { -readonly [K in keyof Mutation]: Mutation[K] } = { events: [] }, prints = new Set<string>();
  const contexts: RunContext[] = [], runs: NonNullable<Mutation["runs"]>[number][] = [], items: NonNullable<Mutation["items"]>[number][] = [], text: NonNullable<Mutation["text"]>[number][] = [], refs: ContentRefRow[] = [];
  state.runs.forEach((run: PublicRun, ordinal) => {
    const user = messages.get(run.userMessageId), assistant = messages.get(run.assistantMessageId);
    if (user === undefined) throw new SessionError("INVALID_DATA", "Run " + ordinal + " has no user message");
    const legacy = run.relay === undefined, found = index.get(run.id), finished = terminal(run.status) && dispatched(run);
    const isCommand = events.commands.has(run.id) || (legacy && found?.commandEffect != null);
    // The effects: see the top of this file.
    let commandEffect: ContextEffect | undefined, settledEffect: ContextEffect | undefined;
    if (isCommand && legacy) { commandEffect = events.commands.get(run.id) ?? found?.commandEffect ?? undefined; settledEffect = found?.commandEffect ?? (finished ? "unknown" : undefined); }
    else if (isCommand) { commandEffect = events.commands.get(run.id); settledEffect = events.settled.get(run.id); }
    const endedSeq = events.ended.get(run.id) ?? found?.seq;
    const claimed = run.status === "unknown" ? state.switches.find(change => change.status === "effective" && (change.sourceRunIds.includes(run.id) || change.acknowledgedUnknown?.includes(run.id) === true)) : undefined;
    const at: ConversionAt = { sessionId: id, ordinal, ...(endedSeq === undefined ? {} : { endedSeq }), ...(isCommand ? { isCommand: true } : {}),
      ...(commandEffect === undefined ? {} : { commandEffect }), ...(settledEffect === undefined ? {} : { settledEffect }), ...(claimed === undefined ? {} : { acknowledgedBy: claimed.id }) };
    const converted = conversion.toItems(run, { user, ...(assistant === undefined ? {} : { assistant }) }, at);
    // A Run made before v13 has no `relay` of its own: where it ran is in the column, from the index, and not in its facts (which are what it was).
    const executedOn = legacy ? found?.executedOn ?? null : null, row: RunRow = executedOn !== null ? { ...converted.row, executedOn } : converted.row;
    contexts.push({ at, executedOn }); runs.push({ op: "insert", row });
    for (const item of converted.items) {
      items.push({ op: "insert", row: { ...itemRowOf(item), textBytes: 0, textChunks: 0 } });
      let offset = 0;
      item.text.forEach((chunk, at) => { text.push({ runId: run.id, itemSeq: item.seq, chunk: at, text: chunk, byteOffset: offset }); offset += utf8Length(chunk); });
    }
    refs.push(...converted.contentRefs);
    // A notice this Run showed is one shown in the conversation: a Harness started again after the upgrade repeats its start-up warnings, and the old code showed a notice once per conversation.
    for (const notice of run.notices ?? []) prints.add(noticePrint(notice));
  });
  if (prints.size > 0) mutation.noticePrints = [...prints];
  const head: HeadJson = { configuration: state.configuration, selection: state.selection, ...(state.retainNative === undefined ? {} : { retainNative: state.retainNative }), ...(state.retained === undefined ? {} : { retained: state.retained }),
    ...(state.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: state.relayRecoveryFailed }) };
  let headJson = head;
  if (state.origin !== undefined) {
    const parts = originToRows(id, state.origin, state.origin.kind === "fork" ? throughOrdinal(db, state.origin.sessionId, state.origin.throughRunId) : 0);
    headJson = { ...head, origin: parts.stored }; mutation.originHistory = parts.rows; refs.push(...parts.contentRefs);
  }
  const last = one(db, "SELECT json_extract(event_json,'$.timestamp') AS at FROM events WHERE session_id=? AND seq=?", id, state.lastSeq), parsed = last === undefined ? NaN : Date.parse(String(last.at));
  const updatedBy = Number.isFinite(parsed) ? parsed : 0;
  mutation.head = { row: { id, version, lastSeq: state.lastSeq, format: 14, status: state.status, epoch: state.epoch, activeRunId: state.activeRunId, pendingSwitchId: state.pendingSwitchId, kept: state.retained !== undefined,
    title: conversationTitle(state), runCount: state.runs.length, updatedAt: updatedBy, deletedAt: null, lastError: null, head: headJson } };
  mutation.commands = state.commands.map((command, ordinal) => commandRowOf(id, ordinal, command));
  mutation.runs = runs; mutation.items = items; mutation.text = text;
  if (state.nativeBindings !== undefined && state.nativeBindings.length > 0) mutation.bindings = state.nativeBindings.map((binding, ordinal) => ({ op: "insert" as const, row: bindingRowOf(id, ordinal, binding) }));
  if (state.switches.length > 0) mutation.switches = state.switches.map((change, ordinal) => ({ op: "insert" as const, row: switchRowOf(id, ordinal, change, sourceThroughOrdinal(change.sourceRunIds, at => state.runs[at]?.id)) }));
  if (refs.length > 0) mutation.contentRefs = refs;
  return { mutation, contexts };
}

/** Where two plain values first differ, as a path and the kinds of what differs: never a value, so that nothing of a conversation's words reaches a log. */
function firstDifference(left: unknown, right: unknown, path = "snapshot"): string | null {
  if (Object.is(left, right)) return null;
  const kind = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "list of " + value.length : typeof value === "string" ? "text of " + value.length : typeof value;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return path + ": " + kind(left) + " and " + kind(right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path + ": " + kind(left) + " and " + kind(right);
    if (left.length !== right.length) return path + ": " + kind(left) + " and " + kind(right);
    for (let at = 0; at < left.length; at++) { const found = firstDifference(left[at], right[at], path + "[" + at + "]"); if (found !== null) return found; }
    return null;
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(key in a)) return path + "." + key + ": missing in the snapshot, " + kind(b[key]) + " in the rows";
    if (!(key in b)) return path + "." + key + ": " + kind(a[key]) + " in the snapshot, missing in the rows";
    const found = firstDifference(a[key], b[key], path + "." + key);
    if (found !== null) return found;
  }
  return null;
}
const mismatch = (message: string): SessionError => new SessionError("MIGRATION_MISMATCH", message);
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/** The facts the new reading gives: the finished, dispatched Runs foreign to a binding, from the Runs' columns alone. A Run whose end no event placed is taken as ABOVE any mark (`lastSeq`). */
export function relayFactsFromRows(db: DatabaseSync, id: SessionId, lastSeq: number, binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }): readonly RelayFact[] {
  const facts: RelayFact[] = [];
  for (const row of all(db, "SELECT run_id, ended_seq, executed_harness_id, executed_control_id, executed_epoch, is_command, command_effect, settled_effect FROM runs WHERE session_id=? AND dispatched=1 AND status IN " + CLOSED + " ORDER BY ordinal", id)) {
    const executedOn: ExecutedOn | null = row.executed_harness_id === null ? null : { harnessId: String(row.executed_harness_id), controlId: String(row.executed_control_id), nativeEpoch: Number(row.executed_epoch) };
    if (executedOn !== null && executedOn.harnessId === binding.harnessId && executedOn.controlId === binding.controlId && executedOn.nativeEpoch === binding.nativeEpoch) continue;
    // A command is a fact only when it entered the context like a message: what its end settled, else what it was read with, is `keep`.
    if (row.is_command === 1 && (row.settled_effect ?? row.command_effect) !== "keep") continue;
    facts.push({ runId: String(row.run_id) as RelayFact["runId"], seq: row.ended_seq === null ? lastSeq : Number(row.ended_seq), executedOn });
  }
  return facts;
}

/**
 * Where a row holds a fact twice (a column for the index, the JSON for the reader), the two are one fact: the columns a binding and a switch were written with are
 * the columns of what their JSON says, and a Run's stored row is the row that converting what it reads back as gives (so that a column no old reader looks at, which
 * the relay and the recovery do, is held to the same snapshot as the rest).
 */
function rowsAgree(db: DatabaseSync, state: SessionSnapshot, contexts: readonly RunContext[], conversion: StorageConversion): void {
  const id = state.id;
  for (const row of all(db, "SELECT * FROM bindings WHERE session_id=? ORDER BY ordinal", id)) {
    const decoded = bindingRowFrom(row), wanted = bindingColumns(bindingRowOf(id, decoded.ordinal, decoded.binding));
    for (const [key, value] of Object.entries(wanted)) if (key !== "binding_json" && row[key] !== value) throw mismatch("conversation " + id + ": native binding " + decoded.ordinal + " holds its " + key + " in its column and in its JSON and the two differ");
  }
  for (const row of all(db, "SELECT * FROM switches WHERE session_id=? ORDER BY ordinal", id)) {
    const decoded = switchRowFrom(row), wanted = switchColumns(switchRowOf(id, decoded.ordinal, decoded.switch, decoded.sourceThroughOrdinal));
    for (const [key, value] of Object.entries(wanted)) if (key !== "switch_json" && row[key] !== value) throw mismatch("conversation " + id + ": switch " + decoded.ordinal + " holds its " + key + " in its column and in its JSON and the two differ");
  }
  for (const row of all(db, "SELECT * FROM runs WHERE session_id=? ORDER BY ordinal", id)) {
    const stored = runRowFrom(row), context = contexts[stored.ordinal];
    if (context === undefined) throw mismatch("conversation " + id + ": Run " + stored.ordinal + " was not in the snapshot");
    const old = conversion.fromItems({ row: stored, items: readItems(db, stored.runId, WHOLE).items, contentRefs: [] });
    const user = old.messages.find(message => message.role === "user"), assistant = old.messages.find(message => message.role === "assistant");
    if (user === undefined) throw mismatch("conversation " + id + ": Run " + stored.ordinal + " reads back without its user message");
    const again = conversion.toItems(old.run, { user, ...(assistant === undefined ? {} : { assistant }) }, context.at).row;
    const expected = context.executedOn === null ? again : { ...again, executedOn: context.executedOn };
    if (canonicalJson(expected) !== canonicalJson(stored))
      throw mismatch("conversation " + id + ": Run " + stored.ordinal + " is stored as a row that converting what it reads back as would not write: " + (firstDifference(JSON.parse(canonicalJson(expected)), JSON.parse(canonicalJson(stored)), "run") ?? "they differ"));
  }
}

/** The checks of a conversation just written (inside its transaction, head and all); a failure is a SessionError that says where, never what. */
function check(db: DatabaseSync, state: SessionSnapshot, version: number, contexts: readonly RunContext[], conversion: StorageConversion, options: Pick<MigrationOptions, "verify">): void {
  const id = state.id;
  const counts: [string, number, number][] = [["Runs", count(db, "SELECT COUNT(*) AS n FROM runs WHERE session_id=?", id), state.runs.length], ["commands", count(db, "SELECT COUNT(*) AS n FROM commands WHERE session_id=?", id), state.commands.length],
    ["native bindings", count(db, "SELECT COUNT(*) AS n FROM bindings WHERE session_id=?", id), state.nativeBindings?.length ?? 0], ["switches", count(db, "SELECT COUNT(*) AS n FROM switches WHERE session_id=?", id), state.switches.length],
    ["quoted messages", count(db, "SELECT COUNT(*) AS n FROM origin_history WHERE session_id=?", id), state.origin?.history.length ?? 0], ["the run count of the head", count(db, "SELECT run_count AS n FROM sessions WHERE id=?", id), state.runs.length],
    ["events", count(db, "SELECT COUNT(*) AS n FROM events WHERE session_id=?", id), state.lastSeq]];
  for (const [what, found, wanted] of counts) if (found !== wanted) throw mismatch("conversation " + id + ": " + found + " " + what + " were written and the snapshot had " + wanted);
  // The columns of the head that no snapshot holds, as the old reading of the snapshot gives them.
  const head = one(db, "SELECT title, kept, deleted_at, last_error FROM sessions WHERE id=?", id);
  if (head === undefined || head.title !== conversationTitle(state) || head.kept !== (state.retained !== undefined ? 1 : 0) || head.deleted_at !== null || head.last_error !== null)
    throw mismatch("conversation " + id + ": the head's title, kept flag, deletion mark or error are not what the snapshot gives");
  // The conversation read back as the store will read it, held to the snapshot it came from.
  const back = snapshotFromRows(db, id), expected = { ...state, version, nativeBindings: state.nativeBindings ?? [] };
  if (!same(expected, { ...back, nativeBindings: back.nativeBindings ?? [] })) {
    const where = firstDifference(JSON.parse(canonicalJson(expected)), JSON.parse(canonicalJson({ ...back, nativeBindings: back.nativeBindings ?? [] })));
    throw mismatch("conversation " + id + " does not read back as it was: " + (where ?? "they differ"));
  }
  rowsAgree(db, state, contexts, conversion);
  // The relay's facts: on every binding of the conversation, and on one that nothing ran on (every finished, dispatched Run that counts is foreign to it).
  const { rows, facts: indexed } = indexRows(db, id);
  const ledger = new LegacyRelayLedger((session, after, limit) => all(db, "SELECT event_json FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?", session, after, limit).map(row => JSON.parse(String(row.event_json)) as SessionEvent));
  // Every place a Run ran (the exclusion by where it ran is what a binding's facts are made of) and every binding: each is asked for its facts, and so is a place nothing ran at.
  const places = new Map<string, { harnessId: string; controlId: string; nativeEpoch: number }>();
  const place = (harnessId: string, controlId: string, nativeEpoch: number): void => { places.set(harnessId + "\u0000" + controlId + "\u0000" + nativeEpoch, { harnessId, controlId, nativeEpoch }); };
  for (const binding of state.nativeBindings ?? []) place(binding.harnessId, binding.controlId, binding.relay?.epoch ?? 1);
  for (const run of state.runs) if (run.relay?.executedOn != null) place(run.relay.executedOn.harnessId, run.relay.executedOn.controlId, run.relay.executedOn.nativeEpoch);
  for (const found of indexed.values()) if (found.executedOn !== null) place(found.executedOn.harnessId, found.executedOn.controlId, found.executedOn.nativeEpoch);
  place("none-ran-here", "none-ran-here", 1);
  for (const binding of places.values()) {
    const old = ledger.facts(state, rows, binding), now = relayFactsFromRows(db, id, state.lastSeq, binding);
    if (!same(old, now)) throw mismatch("conversation " + id + ": the relay's facts for " + binding.harnessId + "/" + binding.controlId + " (epoch " + binding.nativeEpoch + ") are not what the old reading gave: "
      + (firstDifference(JSON.parse(canonicalJson(old)), JSON.parse(canonicalJson(now)), "facts") ?? "they differ"));
  }
  // The references: the set the old code worked out is the set written.
  const before = legacyContentReferences(state), written = new Set(all(db, "SELECT DISTINCT content_id FROM content_refs WHERE session_id=?", id).map(row => String(row.content_id)));
  const lost = [...before].filter(ref => !written.has(ref)).length, gained = [...written].filter(ref => !before.has(ref)).length;
  if (lost > 0 || gained > 0) throw mismatch("conversation " + id + ": the content references written differ from the old ones (" + lost + " not written, " + gained + " not referenced before)");
  // The invariant the table will keep from now on: an open conversation has no unknown Run nobody acknowledged.
  if (state.status === "open" && count(db, "SELECT COUNT(*) AS n FROM runs WHERE session_id=? AND status='unknown' AND acknowledged_by IS NULL", id) > 0)
    throw mismatch("conversation " + id + " is open and holds an unknown Run that no switch acknowledged");
  // The commit path's own reader loads it, and what it holds in small tables is what the snapshot held.
  const loaded = loadConversation(db, id);
  if (loaded.runs.length !== state.runs.length || loaded.runs.some((run, at) => run.id !== state.runs[at]!.id || run.status !== state.runs[at]!.status) || !same({ commands: loaded.commands, switches: loaded.switches, bindings: loaded.nativeBindings ?? [] },
    { commands: state.commands, switches: state.switches, bindings: state.nativeBindings ?? [] })) throw mismatch("conversation " + id + ": the conversation the commit path loads is not the snapshot's");
  if (options.verify !== undefined) {
    const violations = options.verify(loaded, new ConversationTables(db));
    if (violations.length > 0) throw mismatch("conversation " + id + " does not verify: " + violations.slice(0, 5).map(item => item.rule + " at " + item.where).join("; ") + (violations.length > 5 ? " (and " + (violations.length - 5) + " more)" : ""));
  }
}

/**
 * Converts one conversation in a transaction of its own, or does nothing when it is converted. Throws what stopped it (a SessionError of the data or of a check)
 * after rolling its transaction back; an error of SQLite that is not a rule of the rows (a full disk) passes as it is.
 */
export function convertConversation(db: DatabaseSync, id: SessionId, options: Pick<MigrationOptions, "conversion" | "verify" | "step"> = {}): boolean {
  const row = one(db, "SELECT version, last_seq, head FROM sessions WHERE id=? AND format<14", id);
  if (row === undefined) return false;
  let value: unknown;
  try { value = JSON.parse(String(row.head)); } catch { throw new SessionError("INVALID_DATA", "conversation " + id + " is not valid JSON"); }
  const state = parseSession(value);
  if (state.schemaVersion !== 13 || state.id !== id || state.version !== row.version || state.lastSeq !== row.last_seq) throw new SessionError("INVALID_DATA", "conversation " + id + ": its row and its snapshot disagree");
  const logged = one(db, "SELECT COUNT(*) AS n, MIN(seq) AS first, MAX(seq) AS last FROM events WHERE session_id=?", id);
  if (Number(logged?.n) !== state.lastSeq || (state.lastSeq > 0 && (logged?.first !== 1 || logged.last !== state.lastSeq))) throw new SessionError("INVALID_DATA", "conversation " + id + ": its event log and its cursor disagree");
  const version = Number(row.version);
  db.exec("BEGIN IMMEDIATE");
  try {
    const conversion = options.conversion ?? storageConversion, { mutation, contexts } = prepare(db, state, version, conversion);
    // Written as a conversion: a Run may be finished at its insert and its items follow, because the conversation is not v14 until its head says so, last.
    applyMutation(db, mutation, { ownerGeneration: 1, timestamp: new Date(0).toISOString() });
    for (const ref of legacyContentReferences(state)) prepared(db, "INSERT INTO migration_v14_refs(session_id,content_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(id, ref);
    options.step?.("written", id);
    check(db, state, version + 1, contexts, conversion, options);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  options.step?.("converted", id);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// The whole migration
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Brings the database `db` (at `options.root`, owned by the caller, no transaction open) to v14: the backup and the first transaction when it is not v14 yet, then
 * every conversation that is not converted, in the order the rows were made, until one cannot be (the report says which and why; the database keeps everything
 * converted so far). Called again it goes on from there. Returns without error for a stop caused by the data; throws for what is not the data's fault (a refused
 * backup, a full disk, a database of a version this build does not know).
 */
export function migrateToV14(db: DatabaseSync, options: MigrationOptions): MigrationReport {
  const from = userVersion(db);
  if (!Number.isSafeInteger(from) || from < 1 || from > 14) throw new SessionError("INVALID_DATA", "unknown business database schema version");
  let backup: string | null = null;
  if (from < 14) {
    options.step?.("backup", String(from));
    backup = backupBeforeV14(db, from, { root: options.root, ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }) });
    options.step?.("backed-up", backup);
    upgradeSchema(db, from, options);
    options.step?.("upgraded", String(from));
  }
  const alreadyConverted = count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format=14");
  if (!hasTable(db, "migration_v14") && count(db, "SELECT COUNT(*) AS n FROM sessions WHERE format<14") > 0) for (const sql of BOOKKEEPING) db.exec(sql);
  let converted = 0;
  for (const row of all(db, "SELECT id FROM sessions WHERE format<14 ORDER BY rowid")) {
    const id = String(row.id) as SessionId;
    try { if (convertConversation(db, id, options)) converted++; }
    catch (error) {
      if (isSqliteError(error)) throw error;
      const reason = error instanceof Error ? error.message : "unknown failure";
      try { prepared(db, "UPDATE sessions SET last_error=? WHERE id=? AND format<14").run(reason, id); } catch { /* the reason is in the report */ }
      options.log?.("the upgrade stopped at conversation " + id + ": " + reason);
      return { from, backup, converted, alreadyConverted, stopped: { sessionId: id, reason }, references: null };
    }
  }
  // The references are compared once, when the last conversation is converted, and the answer kept with the phase in one transaction. A database that was compared and
  // then written to by a store that has started would differ by its new conversations: it is not compared again unless a tool asks (`compareReferences`).
  let references: ReferenceReport | null = null;
  if (hasTable(db, "migration_v14") && marked(db, "phase") !== "converted") {
    db.exec("BEGIN IMMEDIATE");
    try { references = compareReferences(db); mark(db, "phase", "converted"); db.exec("COMMIT"); } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    if (!references.equal) options.log?.("the content references after the upgrade differ from before: " + references.missingCount + " not kept, " + references.extraCount + " kept that were not referenced");
  }
  options.step?.("finished", String(converted));
  return { from, backup, converted, alreadyConverted, stopped: null, references };
}
