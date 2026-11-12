import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_FORMAT,
  type ContentRefRow, type Conversation, type ConversationCommit, type ConversationMutation, type ConversationReader, type ConversationStore, type ConversationStoreOptions, type HeadRow, type ItemPage,
  type Mutation, type OriginHistoryRow, type ReadOptions, type RunFacts, type SearchHit, type SessionListPage, type SessionListQuery, type StartupSample, type TextRange, type TurnCursor, type TurnItems, type TurnWindow,
} from "../../contracts/conversation.js";
import type { HandoffRecord, RelayIndexRow, RelayLogPort, RelayPacket, RelayPrefKey, RelayRecoveredDelivery, RelayStorePort, DeliveryRecord } from "../../contracts/relay.js";
import { RELAY_SESSION_BODY_BYTES } from "../../contracts/relay.js";
import {
  SessionError, commandId, sessionId,
  type CommandId, type EventDraft, type PublicMessage, type PublicRun, type RunId, type SessionEvent, type SessionId, type SessionSnapshot,
} from "../../contracts/session.js";
import { conversationTitle } from "../../contracts/web.js";
import { verify as verifyConversation } from "../../contexts/session/domain/conversation-verify.js";
import { fromItems, originFromRows } from "../../contexts/session/domain/store-conversion.js";
import { applyMutation } from "./apply.js";
import { ConversationCache, TurnCache, deepFreeze, type CacheEntry, type ConversationCacheStats, type OldTurn, type TurnCacheStats } from "./conversation-cache.js";
import { diffConversation, settleConversation } from "./diff.js";
import { RELAY_DDL_V13 } from "./legacy/ladder.js";
import { WHOLE, loadConversation, readItems } from "./load.js";
import {
  acknowledgeFirstStart, collectionGate, migrateToV14, type CollectionGate, type MigrationOptions, type MigrationReport,
} from "./migrate-v14.js";
import { ConversationTables } from "./read.js";
import { readDeliveriesV14, checkPacketReferencesV14, writeRelayRowsV14 } from "./relay-rows-v14.js";
import { handoffNamed, handoffRows, logHandoff, readPrefs, writePref } from "./relay-log.js";
import { readIndexRows, readPacket, readPacketBody, readPackets, repairRelayPrefs } from "./relay-tables.js";
import { originHistoryRowFrom, runRowFrom, runRowOf, utf8Length } from "./rows.js";
import { schemaV14Statements, RELAY_V14_REBUILD } from "./schema-v14.js";
import { rebuildSearchIndex } from "./search-index.js";
import { all, insertInto, one, refused, updateRow } from "./statements.js";
import { readEvents, drafts, pageLimit } from "./store-events.js";
import {
  initializeFile, initializeRoot, integer, object, ownerRow, pathIdentity, processMayBeAlive, sameFile, sqliteError, storageFailure,
  type FileIdentity, type OwnerRow,
} from "./store-root.js";

/*
 * The store of conversations kept as tables (ADR-057): `ConversationStore` over SQLite, the one a Gateway owns for its data root. It replaces the store that kept a
 * conversation as one snapshot JSON, with the same contract of ownership and of a commit, and none of its walls (no count or size of a conversation is limited here).
 *
 * OWNERSHIP. Opening a root takes the OS lock on `owner.sqlite` (an EXCLUSIVE transaction held until `close`), checks that the data root and its files are the ones it
 * was given and stay so, and claims an owner generation: the next number, written with this process's pid and a token of its own, after finding that the owner before it
 * has exited. Every call asks again whether the lock, the files, the schema version and the generation are still this store's (`assertOwner`); a store that finds they are
 * not is lost for good (OWNER_LOST), and so is one whose SQLite fails (STORAGE_UNAVAILABLE). Nothing else disables it: a refused write, a version conflict, a relay
 * failure, a validation each end their one request and leave the store as it was (docs/research/limits-audit-2026-11-12.md, D21).
 *
 * START (ADR-057 3.6), in this order and nothing else:
 *   1. an empty root is made a v14 database at once; a database of version 1 to 13 goes through the migration (migrate-v14.ts: backup, a first transaction that confirms
 *      the owner before has exited, climbs the old ladder, makes the tables and claims the generation, then each conversation in a transaction of its own and checked);
 *      a v14 database claims the generation in a short transaction and, if conversations are left that are not converted (an upgrade that was stopped), carries on with them;
 *   2. what the upgrade could not convert or check ends the start with a SessionError that names the conversation and the kind of cause (never its words), the lock is
 *      released and the owner marked as gone, and the database stays as the upgrade left it: the next start goes on from there;
 *   3. recovery: the conversations with work not finished (`unfinished`, the partial indexes: never a scan of every conversation) are given to the recovery the domain
 *      injected, each in a transaction of its own; the relay's part of it runs in a SAVEPOINT of its own, and when it or its writes fail only its rows are rolled back and the
 *      conversation is recovered without them, marked `relayRecoveryFailed`.
 *
 * MEMORY. `get` returns the conversation as the Runtime reduces it: the head, a small row per Turn, and the items of the Turns not finished (load.ts). One object per
 * version, deeply frozen, so that a commit finds what changed by comparing objects (diff.ts) at a cost that follows the Turn in progress and not the history. The store
 * holds at most `conversations` of them and `runs` Turns between them (conversation-cache.ts); the one used last always stays; one that was let go is read again from its
 * rows. A finished Turn in the OLD shape (`snapshot`, for the readers that have not moved to items) is made once and kept within a byte budget.
 *
 * A conversation that was deleted is hidden, not removed (`deleteSession`): the Runtime's calls (`get`, `transact`, `snapshot`, `events`, `findByCreateKey`) find it no more, while
 * the reader methods (`head`, `window`, `turnAt`, …) still read its rows, because another conversation may quote it, and say in `head().deletedAt` that it is gone.
 */

const activeRoots = new Set<string>();
/** The business database version this build owns. */
const CURRENT_VERSION = CONVERSATION_FORMAT;
const OWNER_DDL = `CREATE TABLE owner_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=0),owner_pid INTEGER NOT NULL,owner_token TEXT NOT NULL,owner_active INTEGER NOT NULL CHECK(owner_active IN(0,1))) STRICT;
INSERT INTO owner_metadata VALUES(1,0,0,'',0);`;
const KEYS_DDL = "CREATE TABLE create_keys(command_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),fingerprint TEXT NOT NULL) STRICT";
const EVENTS_DDL = "CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT";
const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "unknown"]);

/** What the store takes beyond the contract's options: the sizes of its memory, the room for relay texts, and the handles tests use to see its start. */
export interface SqliteConversationStoreOptions extends ConversationStoreOptions {
  /** How many conversations and how many Turns between them the store holds in memory (see conversation-cache.ts for the defaults). */
  readonly cache?: { readonly conversations?: number; readonly runs?: number };
  /** The byte budget of the finished Turns kept in the old shape for `snapshot` (96 MiB by default). */
  readonly snapshotCacheBytes?: number;
  /** The most relay packet text a conversation keeps (RELAY_SESSION_BODY_BYTES by default); past it the oldest delivered texts are let go, and nothing is refused. */
  readonly relayBodyQuotaBytes?: number;
  /** The free bytes of the volume of the data root, when the system's answer is not wanted (the migration refuses to start without room for twice the database). */
  readonly freeBytes?: () => number;
  /** Called at each point of the migration (see MigrationOptions.step); tests stop a start at a chosen point. */
  readonly migrationStep?: MigrationOptions["step"];
  readonly log?: (line: string) => void;
}

interface Written { readonly entry: CacheEntry; readonly commit: ConversationCommit }

/** The relay recovery's answer read as the new shape: the conversation after it, and the deliveries it decided. */
interface RelayRecoveryResult { readonly next: Conversation; readonly deliveries: readonly RelayRecoveredDelivery[] }
function relayRecoveryOf(value: unknown): RelayRecoveryResult | null {
  if (value === null) return null;
  const row = object(value, "relay recovery"), next = row.next;
  if (next === null || typeof next !== "object" || (next as { readonly format?: unknown }).format !== CONVERSATION_FORMAT || !Array.isArray((next as { readonly runs?: unknown }).runs) || !Array.isArray(row.deliveries))
    throw new SessionError("INVALID_DATA", "the relay recovery did not give a conversation in the new shape");
  return { next: next as Conversation, deliveries: row.deliveries as readonly RelayRecoveredDelivery[] };
}

/** The title the head keeps (`conversationTitle`: the first input, else where the conversation came from, else "新对话"): worked out when the first Turn arrives and never again. */
function titleOf(previous: CacheEntry | null, next: Conversation, history: readonly OriginHistoryRow[] | undefined): string {
  if (previous !== null && previous.conversation.runs.length > 0) return previous.title;
  const first = next.runs[0]?.items?.find(item => item.itemId === "user")?.text.join("");
  // Nothing to name it by that the head does not already hold (no input with words in it, and the quoted history was given with the commit that made the conversation and not
  // since): the title stays what it is, "分支 · …" or "接续 · …" of a branch or an import included.
  if (previous !== null && history === undefined && (first === undefined || first.trim() === "")) return previous.title;
  const origin = next.origin === undefined || history === undefined ? null : originFromRows(next.origin, history);
  return conversationTitle({ messages: first === undefined ? [] : [{ role: "user", text: first }], ...(origin === null ? {} : { origin }) });
}
/** The references the collector keeps for the attachments of a quoted history: the conversation's own, with no Turn. */
function originReferences(id: SessionId, rows: readonly OriginHistoryRow[] | undefined): ContentRefRow[] {
  const seen = new Set<string>(), refs: ContentRefRow[] = [];
  for (const row of rows ?? []) for (const attachment of row.message.attachments ?? []) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id); refs.push({ contentId: attachment.id, sessionId: id, runId: null, itemSeq: null, role: "origin_attachment" });
  }
  return refs;
}
/** A list of objects frozen, as far as it is new: what the next version shares with the one before it was frozen already, and is passed over by the pointer. */
function freezeNew<T extends object>(list: readonly T[] | undefined, was: readonly T[] | undefined): void {
  if (list === undefined || list === was) return;
  for (let index = 0; index < list.length; index++) if (list[index] !== was?.[index]) deepFreeze(list[index]);
  Object.freeze(list);
}
/** The conversation frozen: what is not the very object of the version before it is frozen all the way down, the rest was. */
function freezeConversation(after: Conversation, before: Conversation | null): Conversation {
  freezeNew(after.runs, before?.runs); freezeNew(after.commands, before?.commands); freezeNew(after.switches, before?.switches); freezeNew(after.nativeBindings, before?.nativeBindings);
  for (const key of Object.keys(after) as (keyof Conversation)[]) {
    if (key === "runs" || key === "commands" || key === "switches" || key === "nativeBindings") continue;
    if (after[key] !== before?.[key]) deepFreeze(after[key]);
  }
  return Object.freeze(after);
}

export class SqliteConversationStore implements ConversationStore, RelayStorePort, RelayLogPort {
  /** What the migration did at this start (null when there was none: a new root, or a root that was current and whole). */
  readonly migration: MigrationReport | null = null;
  private generation = 0;
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly markerPath: string;
  private readonly markerIdentity: FileIdentity;
  private readonly ownerPath: string;
  private readonly ownerIdentity: FileIdentity;
  private readonly databasePath: string;
  private readonly databaseIdentity: FileIdentity;
  private readonly owner: DatabaseSync;
  private readonly database: DatabaseSync;
  private readonly tables: ConversationTables;
  private readonly token = randomUUID();
  private readonly clock: () => Date;
  private readonly options: SqliteConversationStoreOptions;
  private readonly cache: ConversationCache;
  private readonly turns: TurnCache;
  private readonly relayQuota: number;
  /** PRAGMA data_version when the memory was last known to match the database; another connection's commit changes it. */
  private dataVersion: number | null = null;
  private inTransaction = false;
  private claimed = false;
  private closed = false;
  private failed: SessionError | null = null;

  /**
   * Opens `root` as its single owner (see the top of this file for what that takes and what the start does). `options.recover` and `options.recoverRelay` are the domain's
   * recovery of a conversation and of its relay rows, given to the store because it knows no rule of the domain; `options.verify` is the whole-conversation check each
   * converted conversation is held to (the domain's by default).
   */
  constructor(root: string, options: SqliteConversationStoreOptions = {}) {
    if (!isAbsolute(root) || root.includes("\0") || utf8Length(root) > 4096) throw new SessionError("INVALID_INPUT", "data root must be a bounded absolute path");
    this.options = options;
    this.clock = options.now ?? (() => new Date());
    this.cache = new ConversationCache(options.cache?.conversations, options.cache?.runs);
    this.turns = new TurnCache(options.snapshotCacheBytes);
    this.relayQuota = options.relayBodyQuotaBytes ?? RELAY_SESSION_BODY_BYTES;
    if (!Number.isSafeInteger(this.relayQuota) || this.relayQuota < 1) throw new SessionError("INVALID_INPUT", "the relay text quota must be a positive integer");
    const initialized = initializeRoot(root);
    this.root = initialized.root; this.rootIdentity = pathIdentity(this.root, true);
    this.markerPath = initialized.markerPath; this.markerIdentity = initialized.markerIdentity;
    this.ownerPath = join(this.root, "owner.sqlite");
    this.databasePath = join(this.root, "gateway.sqlite");
    if (activeRoots.has(this.root)) throw new SessionError("OWNER_BUSY", "this process already owns this data root");
    activeRoots.add(this.root);
    try {
      this.ownerIdentity = initializeFile(this.ownerPath);
      this.owner = new DatabaseSync(this.ownerPath, { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
    } catch (error) { activeRoots.delete(this.root); throw error instanceof SessionError ? error : storageFailure(error); }
    let database: DatabaseSync | null = null;
    try {
      this.owner.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE");
      if (!sameFile(this.ownerIdentity, pathIdentity(this.ownerPath))) throw new SessionError("OWNER_LOST", "owner lock path changed during acquisition");
      this.databaseIdentity = initializeFile(this.databasePath);
      database = new DatabaseSync(this.databasePath, { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
      this.database = database;
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      this.tables = new ConversationTables(database);
      this.migration = this.start();
    } catch (error) {
      // A start that failed after it claimed the generation leaves the owner marked as gone, so that the next start (in this process or another) is not told an owner may be alive.
      if (this.claimed && database?.isOpen) {
        try { database.prepare("UPDATE owner_metadata SET owner_active=0 WHERE singleton=1 AND owner_generation=? AND owner_token=?").run(this.generation, this.token); } catch { /* the lock is released next */ }
      }
      if (database?.isOpen) database.close();
      if (this.owner.isOpen) this.owner.close();
      activeRoots.delete(this.root);
      if (sqliteError(error) && object(error, "SQLite error").errcode === 5) throw new SessionError("OWNER_BUSY", "another owner holds this data root");
      // SQLite's own failures are the storage's; anything else (a callback the domain gave, a mistake of ours) is told as what it is.
      throw error instanceof SessionError || !sqliteError(error) ? error : storageFailure(error);
    }
  }

  get ownerGeneration(): number { return this.generation; }

  assertOwner(): void {
    if (this.closed) throw new SessionError("STORE_CLOSED", "Session store is closed");
    if (this.failed) throw this.failed;
    try {
      this.assertPaths();
      const version = this.database.prepare("PRAGMA user_version").get();
      if (!version || version.user_version !== CURRENT_VERSION) throw new SessionError("OWNER_LOST", "business database schema no longer matches this owner");
      const metadata = this.readOwner();
      if (!metadata.active || metadata.generation !== this.generation || metadata.token !== this.token || metadata.pid !== process.pid) throw new SessionError("OWNER_LOST", "persistent owner generation no longer belongs to this process");
    } catch (error) {
      // A lost owner keeps nothing in memory: nothing reads it again, and it goes now rather than at close.
      this.clearMemory();
      this.failed = error instanceof SessionError && error.code === "OWNER_LOST" ? error : new SessionError("OWNER_LOST", "owner lock, path identity or generation could not be confirmed");
      if (this.failed !== error) this.failed.cause = error;
      throw this.failed;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The start
  // ---------------------------------------------------------------------------------------------------------------------

  private start(): MigrationReport | null {
    const db = this.database;
    const version = integer(object(db.prepare("PRAGMA user_version").get(), "database schema version").user_version, "database schema version");
    if (version > CURRENT_VERSION) throw new SessionError("INVALID_DATA", "unknown business database schema version");
    let report: MigrationReport | null = null;
    if (version === 0) this.makeNew();
    else if (version < CURRENT_VERSION) report = this.upgrade();
    else {
      this.reclaim();
      // An upgrade that was stopped (or killed) leaves conversations that are not converted: the start goes on with them, and does not go on without them.
      if (one(db, "SELECT 1 AS found FROM sessions WHERE format<14 LIMIT 1") !== undefined) report = this.upgrade();
    }
    this.recoverUnfinished();
    return report;
  }

  /** An empty root becomes a v14 database in one transaction: the tables of a new store, the relay tables as the migration leaves them, the generation claimed. */
  private makeNew(): void {
    const db = this.database;
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== 0) throw new SessionError("INVALID_DATA", "unversioned business database already contains data");
    // The relay tables are rebuilt (RELAY_V14_REBUILD), which SQLite does with the foreign keys off, decided before the transaction begins.
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(OWNER_DDL);
        for (const sql of schemaV14Statements("fresh")) db.exec(sql);
        db.exec(KEYS_DDL); db.exec(EVENTS_DDL); db.exec(RELAY_DDL_V13);
        for (const sql of RELAY_V14_REBUILD) db.exec(sql);
        repairRelayPrefs(db);
        // Nothing is stored yet, so both full-text indexes are complete: every segment that finishes is indexed by the commit that finishes it.
        const at = this.stamp().getTime();
        db.prepare("INSERT INTO derived(name,state,updated_at) VALUES('search_fts','ready',?),('search_chars','ready',?)").run(at, at);
        this.generation = this.claimOwner();
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) throw new SessionError("INVALID_DATA", "the new database has broken foreign keys");
        db.exec("PRAGMA user_version=" + CURRENT_VERSION);
        this.assertPaths();
        db.exec("COMMIT");
      } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    } finally { db.exec("PRAGMA foreign_keys=ON"); }
  }

  /** A v14 database: the generation is claimed in a short transaction of its own. */
  private reclaim(): void {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      repairRelayPrefs(db);
      this.generation = this.claimOwner();
      this.assertPaths();
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }

  /** The owner row, found to be the row of an owner that has exited: otherwise automatic takeover is refused (OWNER_UNCONFIRMED). */
  private confirmPriorOwnerExited(): OwnerRow {
    const prior = this.readOwner();
    if (prior.active && processMayBeAlive(prior.pid)) throw new SessionError("OWNER_UNCONFIRMED", "previous owner may still be alive; automatic takeover is refused");
    return prior;
  }
  /** Claims the next owner generation for this process, inside the transaction the caller has open. */
  private claimOwner(): number {
    const prior = this.confirmPriorOwnerExited(), generation = prior.generation + 1;
    if (!Number.isSafeInteger(generation)) throw new SessionError("INVALID_DATA", "owner generation exhausted");
    this.database.prepare("UPDATE owner_metadata SET owner_generation=?,owner_pid=?,owner_token=?,owner_active=1 WHERE singleton=1").run(generation, process.pid, this.token);
    this.claimed = true;
    return generation;
  }

  /**
   * The migration (migrate-v14.ts) with the store's hooks: the first transaction confirms the owner before has exited and claims the generation (a database of version
   * 1 to 13), and each conversation converted is held to the whole-conversation check. A conversation that cannot be converted ends the start.
   */
  private upgrade(): MigrationReport {
    const options: MigrationOptions = {
      root: this.root,
      confirmOwnerExited: () => { this.confirmPriorOwnerExited(); },
      claim: () => { this.generation = this.claimOwner(); },
      verify: this.options.verify ?? verifyConversation,
      ...(this.options.freeBytes === undefined ? {} : { freeBytes: this.options.freeBytes }),
      ...(this.options.migrationStep === undefined ? {} : { step: this.options.migrationStep }),
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    };
    const report = migrateToV14(this.database, options);
    if (report.stopped !== null) {
      const failure = new SessionError("MIGRATION_STOPPED", "the upgrade to the new storage stopped at conversation " + report.stopped.sessionId + ": " + report.stopped.reason
        + "; nothing was started and the data is as the upgrade left it, the upgrade goes on from there when the cause is fixed");
      throw failure;
    }
    return report;
  }

  /** Recovery (the top of this file): the conversations with work not finished, each in a transaction of its own. Without a recovery given there is nothing to do. */
  private recoverUnfinished(): void {
    if (this.options.recover === undefined) return;
    for (const id of this.tables.unfinished()) this.recover(id);
  }

  private recover(id: SessionId): void {
    const recover = this.options.recover!, recoverRelay = this.options.recoverRelay, db = this.database;
    let written: Written | null = null;
    this.transaction(() => {
      const entry = this.entry(id), current = entry.conversation, recovered = recover(current);
      if (recovered === null) return;
      const at = this.stamp();
      if (recoverRelay === undefined) { written = this.write(entry, recovered, at); return; }
      // The relay's part, in a SAVEPOINT of its own: when it fails only its rows are rolled back, and the conversation is recovered without them.
      db.exec("SAVEPOINT relay_recovery");
      try {
        const relay = relayRecoveryOf(recoverRelay(recovered.next, readDeliveriesV14(db, id), readPackets(db, id)));
        if (relay === null) written = this.write(entry, recovered, at);
        else {
          const events = recovered.events.map(event => event.type === "session.recovered" ? { type: event.type, data: { ...event.data, relay: {
            failed: false, deliveries: relay.deliveries.map(row => ({ runId: row.runId, outcome: row.outcome.kind })),
            bindings: (relay.next.nativeBindings ?? []).flatMap(binding => binding.relay === undefined ? [] : [{ harnessId: binding.harnessId, controlId: binding.controlId, epoch: binding.relay.epoch, pending: binding.relay.pending !== null }]) } } } : event);
          const decided = relay.deliveries.map(row => ({ kind: "outcome" as const, runId: row.runId, outcome: row.outcome }));
          written = this.write(entry, { ...recovered, next: relay.next, events, relay: { ...recovered.relay, deliveries: [...(recovered.relay?.deliveries ?? []), ...decided] } }, at);
        }
        db.exec("RELEASE relay_recovery");
      } catch (error) {
        if (!db.isTransaction) throw error;
        db.exec("ROLLBACK TO relay_recovery"); db.exec("RELEASE relay_recovery");
        const index = recovered.events.findIndex(event => event.type === "session.recovered");
        const events = recovered.events.map(event => event.type === "session.recovered" ? { type: event.type, data: { ...event.data, relay: { failed: true } } } : event);
        written = this.write(entry, { ...recovered, next: { ...recovered.next, relayRecoveryFailed: current.lastSeq + 1 + Math.max(0, index) }, events }, at);
      }
    }, () => { if (written !== null) this.cache.put(id, written.entry); });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Conversations: create, get, transact
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * A new conversation: its head, its Turns if it has any, its commands and its first events, in one transaction. A create command seen before returns the conversation it
   * made (nothing is written), or IDEMPOTENCY_CONFLICT when its fingerprint is another request's. `originHistory` is the history a branch or an import starts from, which
   * the conversation holds only a summary of; its attachments are kept for it.
   */
  create(conversation: Conversation, events: readonly EventDraft[], originHistory?: readonly OriginHistoryRow[]): ConversationCommit {
    this.assertOwner();
    if (conversation.format !== CONVERSATION_FORMAT || conversation.version !== 0 || conversation.lastSeq !== 0) throw new SessionError("INVALID_INPUT", "new Session must use format 14 and start at version and cursor zero");
    drafts(events);
    const id = sessionId(conversation.id), create = conversation.commands.find(entry => entry.kind === "create");
    if (!create) throw new SessionError("INVALID_DATA", "Session create command is missing");
    let written: Written | null = null;
    return this.transaction(() => {
      const db = this.database, prior = one(db, "SELECT session_id, fingerprint FROM create_keys WHERE command_id=?", create.id);
      if (prior !== undefined) {
        if (prior.fingerprint !== create.fingerprint) throw new SessionError("IDEMPOTENCY_CONFLICT", "create key already names another request");
        return { conversation: this.entry(sessionId(prior.session_id)).conversation, events: [], changes: { events: [] } };
      }
      if (one(db, "SELECT id FROM sessions WHERE id=?", id) !== undefined) throw new SessionError("SESSION_EXISTS", "Session identity already exists");
      written = this.write(null, { next: conversation, events, ...(originHistory === undefined ? {} : { originHistory }) }, this.stamp());
      try { insertInto(db, "create_keys", { command_id: create.id, session_id: id, fingerprint: create.fingerprint }); } catch (error) { throw refused(error); }
      return written.commit;
    }, () => { if (written !== null) this.cache.put(id, written.entry); });
  }

  get(id: SessionId): Conversation { this.assertOwner(); sessionId(id); return this.read(() => this.entry(id).conversation); }

  findByCreateKey(key: CommandId): Conversation | null {
    this.assertOwner(); commandId(key);
    return this.read(() => {
      const row = one(this.database, "SELECT session_id FROM create_keys WHERE command_id=?", key);
      return row === undefined ? null : this.entry(sessionId(row.session_id)).conversation;
    });
  }

  /**
   * One transaction on a conversation: the version is compared (VERSION_CONFLICT), the reducer is given the conversation as it is, and what it returns is written as the rows
   * that changed and the events, with the relay's rows when it brings them. A refusal of any kind (a rule of the tables, a relay check, a validation, a lost race) leaves the
   * conversation, its rows and the memory as they were, and ends this request only. `title` and `updatedAt` are the store's to set.
   */
  transact(id: SessionId, expectedVersion: number, mutate: (current: Conversation) => ConversationMutation): ConversationCommit {
    this.assertOwner(); sessionId(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof mutate !== "function") throw new SessionError("INVALID_INPUT", "transaction requires a positive expected version and synchronous mutation");
    let written: Written | null = null;
    return this.transaction(() => {
      const entry = this.entry(id);
      if (entry.conversation.version !== expectedVersion) throw new SessionError("VERSION_CONFLICT", "Session version changed before the mutation");
      const mutation = mutate(entry.conversation);
      if (mutation === null || typeof mutation !== "object" || "then" in mutation) throw new SessionError("INVALID_DATA", "Session mutation must be synchronous");
      if (mutation.relay !== undefined && (mutation.relay === null || typeof mutation.relay !== "object" || Array.isArray(mutation.relay))) throw new SessionError("INVALID_DATA", "relay rows must be an object");
      written = this.write(entry, mutation, this.stamp());
      return written.commit;
    }, () => { if (written !== null) this.cache.put(id, written.entry); });
  }

  /** Turns a mutation into rows and writes them, inside the transaction the caller has open. Touches no memory: the caller puts the result in the cache once the transaction has committed. */
  private write(previous: CacheEntry | null, mutation: ConversationMutation, at: Date): Written {
    const db = this.database, before = previous === null ? null : previous.conversation, next = mutation.next;
    if (next === null || typeof next !== "object" || next.format !== CONVERSATION_FORMAT) throw new SessionError("INVALID_DATA", "a mutation gives the conversation in the new shape");
    if (before !== null && next.id !== before.id) throw new SessionError("INVALID_DATA", "transaction cannot replace Session identity");
    if (before !== null && next.commands !== before.commands) {
      const was = before.commands[0], now = next.commands[0];
      if (was === undefined || now === undefined || JSON.stringify(was) !== JSON.stringify(now)) throw new SessionError("INVALID_DATA", "transaction cannot replace Session create identity");
    }
    const events = drafts(mutation.events), title = titleOf(previous, next, mutation.originHistory);
    const made = diffConversation(before, next, { events, ...(mutation.relay === undefined ? {} : { relay: mutation.relay }),
      ...(mutation.originHistory === undefined ? {} : { originHistory: mutation.originHistory }), ...(mutation.noticePrints === undefined ? {} : { noticePrints: mutation.noticePrints }),
      ...(mutation.createdBy === undefined ? {} : { createdBy: mutation.createdBy }), title, updatedAt: at.getTime() });
    const origin = originReferences(next.id, mutation.originHistory);
    const rows: Mutation = origin.length === 0 ? made : { ...made, contentRefs: [...(made.contentRefs ?? []), ...origin] };
    const applied = applyMutation(db, rows, { ownerGeneration: this.generation, timestamp: at.toISOString(), writeRelay: relay => { writeRelayRowsV14(db, next.id, relay, this.relayQuota); } });
    // A relay state that names a packet must find it kept: the rows of the commit are in, and a throw here takes the whole commit back.
    checkPacketReferencesV14(db, next.id, before, applied.changes);
    const settled = freezeConversation(settleConversation(next, applied), before);
    const entry: CacheEntry = { conversation: settled, title, ...(previous?.oldOrigin === undefined ? {} : { oldOrigin: previous.oldOrigin }) };
    return { entry, commit: { conversation: settled, events: applied.events, changes: applied.changes } };
  }

  /** The conversation as the Runtime reduces it, from memory or read from its rows (which is committed state, and so is kept even if the transaction that asked for it is rolled back). */
  private entry(id: SessionId): CacheEntry {
    this.observeWriters();
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const row = one(this.database, "SELECT deleted_at, title FROM sessions WHERE id=?", id);
    if (row === undefined || row.deleted_at !== null) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    const entry: CacheEntry = { conversation: freezeConversation(loadConversation(this.database, id), null), title: String(row.title) };
    this.cache.put(id, entry);
    return entry;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The old shape, for the readers that have not moved to items
  // ---------------------------------------------------------------------------------------------------------------------

  snapshot(id: SessionId): SessionSnapshot {
    this.assertOwner(); sessionId(id);
    return this.read(() => {
      const entry = this.entry(id), conversation = entry.conversation, runs: PublicRun[] = [], messages: PublicMessage[] = [];
      for (const run of conversation.runs) {
        const old = this.oldTurn(id, run);
        runs.push(old.run); messages.push(...old.messages);
      }
      // The messages were committed in the order of their seqs (a queued input is accepted before the reply of the Run in front of it ends).
      messages.sort((left, right) => left.seq - right.seq);
      if (conversation.origin !== undefined && entry.oldOrigin === undefined)
        entry.oldOrigin = originFromRows(conversation.origin, all(this.database, "SELECT * FROM origin_history WHERE session_id=? ORDER BY idx", id).map(originHistoryRowFrom));
      const origin = conversation.origin === undefined ? null : entry.oldOrigin as ReturnType<typeof originFromRows>;
      const bindings = conversation.nativeBindings ?? [];
      return Object.freeze({ schemaVersion: 13 as const, id: conversation.id, version: conversation.version, lastSeq: conversation.lastSeq, epoch: conversation.epoch, status: conversation.status, configuration: conversation.configuration,
        selection: conversation.selection, activeRunId: conversation.activeRunId, pendingSwitchId: conversation.pendingSwitchId, runs: Object.freeze(runs), messages: Object.freeze(messages), switches: conversation.switches, commands: conversation.commands,
        ...(bindings.length === 0 ? {} : { nativeBindings: bindings }), ...(origin === null ? {} : { origin }), ...(conversation.retainNative === undefined ? {} : { retainNative: conversation.retainNative }),
        ...(conversation.retained === undefined ? {} : { retained: conversation.retained }), ...(conversation.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: conversation.relayRecoveryFailed }) });
    });
  }

  /** A Turn in the old shape: a finished one is made once and kept (it never changes), one not finished is made from memory. */
  private oldTurn(id: SessionId, run: Conversation["runs"][number]): OldTurn {
    const finished = TERMINAL.has(run.status);
    if (finished) {
      const kept = this.turns.get(run.id);
      if (kept !== undefined) return kept;
    }
    let made: { readonly run: PublicRun; readonly messages: readonly PublicMessage[] };
    if (run.items !== undefined) {
      const row = runRowOf(id, run), empty = (run as unknown as { readonly emptyLists?: RunFacts["emptyLists"] }).emptyLists;
      made = fromItems({ row: empty === undefined ? row : { ...row, facts: { ...row.facts, emptyLists: empty } }, items: run.items, contentRefs: [] });
    } else {
      const stored = one(this.database, "SELECT * FROM runs WHERE session_id=? AND ordinal=?", id, run.ordinal);
      if (stored === undefined) throw new SessionError("INVALID_DATA", "the store has no row for Run " + run.ordinal);
      const row = runRowFrom(stored);
      made = fromItems({ row, items: readItems(this.database, row.runId, WHOLE).items, contentRefs: [] });
    }
    const turn: OldTurn = deepFreeze({ run: made.run, messages: made.messages, bytes: 1024 + JSON.stringify(made.run).length + made.messages.reduce((total, message) => total + message.text.length, 0) });
    if (finished) this.turns.put(run.id, turn);
    return turn;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Reading: the reader, the list, and what the Runtime and the collector ask by column and index
  // ---------------------------------------------------------------------------------------------------------------------

  head(id: SessionId): HeadRow { this.assertOwner(); sessionId(id); return this.read(() => this.tables.head(id)); }
  window(id: SessionId, options?: { readonly turns?: number; readonly bytes?: number }): TurnWindow { this.assertOwner(); sessionId(id); return this.read(() => this.tables.window(id, options)); }
  older(id: SessionId, before: TurnCursor, options?: { readonly turns?: number; readonly bytes?: number }): TurnWindow { this.assertOwner(); sessionId(id); return this.read(() => this.tables.older(id, before, options)); }
  turnAt(id: SessionId, ordinal: number, options?: ReadOptions): TurnItems | null { this.assertOwner(); sessionId(id); return this.read(() => this.tables.turnAt(id, ordinal, options)); }
  items(runId: RunId, afterSeq: number, limit: number, options?: ReadOptions): ItemPage { this.assertOwner(); return this.read(() => this.tables.items(runId, afterSeq, limit, options)); }
  text(runId: RunId, itemSeq: number, range?: { readonly from: number; readonly to?: number }): TextRange { this.assertOwner(); return this.read(() => this.tables.text(runId, itemSeq, range)); }
  search(query: string, scope: { readonly sessionId?: SessionId; readonly after?: number; readonly limit: number }): readonly SearchHit[] { this.assertOwner(); return this.read(() => this.tables.search(query, scope)); }
  list(query?: SessionListQuery): SessionListPage { this.assertOwner(); return this.read(() => this.tables.list(query)); }
  listKept(): readonly SessionId[] { this.assertOwner(); return this.read(() => this.tables.listKept()); }
  unfinished(): readonly SessionId[] { this.assertOwner(); return this.read(() => this.tables.unfinished()); }
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId> { this.assertOwner(); return this.read(() => this.tables.nativeOwners(harnessId, controlId)); }
  noticeShown(id: SessionId, print: string): boolean {
    this.assertOwner(); sessionId(id);
    return this.read(() => one(this.database, "SELECT 1 AS found FROM notice_prints WHERE session_id=? AND print=?", id, print) !== undefined);
  }
  contentReferences(): ReadonlySet<string> { this.assertOwner(); return this.read(() => this.tables.contentReferences()); }
  startupSamples(perEntry: number): readonly StartupSample[] { this.assertOwner(); return this.read(() => this.tables.startupSamples(perEntry)); }

  /** A page of the events of a conversation after `afterSeq` (store-events.ts for what a page is). */
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    this.assertOwner(); sessionId(id);
    const count = pageLimit(limit);
    return this.read(() => {
      const row = one(this.database, "SELECT deleted_at FROM sessions WHERE id=?", id);
      if (row === undefined || row.deleted_at !== null) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
      return readEvents(this.database, id, afterSeq, count);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Deleting, and what the collector and a maintenance command ask of the store
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * Deletes a closed conversation that keeps no native process: it is hidden (`deleted_at`), the native sessions it held are let go (its bindings are archived, so another
   * conversation can continue them), and its create key is freed. Its rows stay while another conversation may quote it; they are purged by a maintenance command, children
   * first (schema-v14.ts). Nothing of what was said in it is erased by this.
   */
  deleteSession(id: SessionId): void {
    this.assertOwner(); sessionId(id);
    this.transaction(() => {
      const db = this.database, state = this.entry(id).conversation;
      if (state.status !== "closed" || state.retained !== undefined) throw new SessionError("SESSION_BUSY", "only a closed conversation that keeps no native process is deleted");
      if (updateRow(db, "sessions", { deleted_at: this.stamp().getTime(), version: state.version + 1 }, { id, version: state.version }) !== 1) throw new SessionError("VERSION_CONFLICT", "Session compare-and-swap failed");
      db.prepare("DELETE FROM create_keys WHERE session_id=?").run(id);
    }, () => { this.cache.delete(id); this.turns.clear(); });
  }
  /** Whether the content collector may delete, and if it may only report (migrate-v14.ts `collectionGate`). */
  collectionGate(): CollectionGate { this.assertOwner(); return this.read(() => collectionGate(this.database)); }
  /** The first start after an upgrade has reported what the collector would collect: the upgrade's bookkeeping is dropped and the collector is free. */
  acknowledgeFirstStart(): void { this.assertOwner(); this.transaction(() => { acknowledgeFirstStart(this.database); }); }
  /** Makes both full-text indexes again from the text chunks (search-index.ts); returns how many items were indexed. A maintenance command. */
  rebuildSearchIndex(): number { this.assertOwner(); return this.transaction(() => rebuildSearchIndex(this.database, this.stamp().getTime())); }
  /** How the memory has been used, for diagnostics and tests. */
  cacheStats(): { readonly conversations: ConversationCacheStats; readonly oldTurns: TurnCacheStats } { return { conversations: this.cache.stats(), oldTurns: this.turns.stats() }; }

  // ---------------------------------------------------------------------------------------------------------------------
  // The relay's ports
  // ---------------------------------------------------------------------------------------------------------------------

  relayDeliveries(id: SessionId): readonly DeliveryRecord[] { this.assertOwner(); sessionId(id); return this.read(() => readDeliveriesV14(this.database, id)); }
  relayPackets(id: SessionId): readonly RelayPacket[] { this.assertOwner(); sessionId(id); return this.read(() => readPackets(this.database, id)); }
  relayPacket(id: SessionId, packetId: string): RelayPacket | null { this.assertOwner(); sessionId(id); return this.read(() => readPacket(this.database, id, packetId)); }
  relayPacketBody(id: SessionId, bodySha256: string): string | null { this.assertOwner(); sessionId(id); return this.read(() => readPacketBody(this.database, id, bodySha256)); }
  relayIndex(id: SessionId): readonly RelayIndexRow[] { this.assertOwner(); sessionId(id); return this.read(() => readIndexRows(this.database, id)); }
  logHandoff(harnessId: string): { readonly record: HandoffRecord; readonly created: boolean } {
    this.assertOwner();
    return this.transaction(() => logHandoff(this.database, harnessId, this.stamp().getTime()));
  }
  handoffs(): readonly HandoffRecord[] { this.assertOwner(); return this.read(() => handoffRows(this.database)); }
  handoffUsed(logSeq: number): boolean { this.assertOwner(); return this.read(() => handoffNamed(this.database, logSeq)); }
  setPref(key: RelayPrefKey, value: string): void { this.assertOwner(); this.transaction(() => { writePref(this.database, key, value, this.stamp().getTime()); }); }
  relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>> { this.assertOwner(); return this.read(() => readPrefs(this.database)); }

  close(): void {
    if (this.closed) return;
    let failure: unknown = null;
    try {
      this.assertOwner();
      this.transaction(() => { this.database.prepare("UPDATE owner_metadata SET owner_active=0 WHERE singleton=1 AND owner_generation=? AND owner_token=?").run(this.generation, this.token); });
    } catch (error) { failure = error; }
    this.closed = true;
    this.clearMemory();
    try { if (this.database.isOpen) this.database.close(); } catch (error) { failure ??= error; }
    try { if (this.owner.isOpen) this.owner.close(); } catch (error) { failure ??= error; }
    if (!this.owner.isOpen) activeRoots.delete(this.root);
    if (failure !== null) throw failure;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Under the calls
  // ---------------------------------------------------------------------------------------------------------------------

  private clearMemory(): void { this.cache.clear(); this.turns.clear(); }
  private stamp(): Date {
    let at: Date;
    try { at = this.clock(); } catch { throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date"); }
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date");
    return at;
  }
  private assertPaths(): void {
    if (!this.owner.isOpen || !this.owner.isTransaction || !this.database.isOpen || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath))
      || !sameFile(this.ownerIdentity, pathIdentity(this.ownerPath)) || !sameFile(this.databaseIdentity, pathIdentity(this.databasePath))) throw new SessionError("OWNER_LOST", "owner lock transaction or storage path identity was lost");
  }
  private readOwner(): OwnerRow { return ownerRow(this.database.prepare("SELECT owner_generation,owner_pid,owner_token,owner_active FROM owner_metadata WHERE singleton=1").get()); }
  /** Drops the memory once another connection committed to the database since this one last looked; this connection's own commits leave PRAGMA data_version as it is. */
  private observeWriters(): void {
    const version = integer(object(this.database.prepare("PRAGMA data_version").get(), "database data version").data_version, "database data version");
    if (this.dataVersion !== null && this.dataVersion !== version) this.clearMemory();
    this.dataVersion = version;
  }
  /**
   * Runs `mutate` in one IMMEDIATE transaction. `committed` runs only once COMMIT has succeeded, so the memory never takes what a rolled-back transaction wrote; a failure of the
   * storage or of the ownership clears the memory along with disabling the store, and nothing else disables it.
   */
  private transaction<T>(mutate: () => T, committed?: () => void): T {
    this.assertOwner();
    if (this.inTransaction) throw new SessionError("INVALID_INPUT", "a transaction cannot begin inside another");
    let result: T;
    this.inTransaction = true;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      // No other connection commits while this one holds the write lock, so this sees all they committed before.
      this.observeWriters();
      result = mutate();
      // Path and lock validation after the callback closes ownership windows without awaiting external work.
      this.assertPaths();
      const metadata = this.readOwner();
      if (metadata.generation !== this.generation || metadata.token !== this.token) throw new SessionError("OWNER_LOST", "owner generation changed inside transaction");
      this.database.exec("COMMIT");
    } catch (error) {
      try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); }
      catch (rollbackError) { this.failed = storageFailure(rollbackError); }
      if (sqliteError(error)) this.failed = storageFailure(error);
      if (error instanceof SessionError && error.code === "OWNER_LOST") this.failed = error;
      if (this.failed) this.clearMemory();
      throw this.failed ?? error;
    } finally { this.inTransaction = false; }
    committed?.();
    return result;
  }
  private read<T>(read: () => T): T {
    try { return read(); }
    catch (error) {
      if (sqliteError(error)) { this.failed = storageFailure(error); this.clearMemory(); throw this.failed; }
      throw error;
    }
  }
}

