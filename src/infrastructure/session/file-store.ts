import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_FORMAT, PAGE,
  type Conversation, type ConversationCommit, type ConversationMutation, type ConversationRun, type ConversationStore, type ConversationStoreOptions, type DeferredWork, type HeadRow, type HeldItem,
  type ItemPage, type ItemRow, type ItemWrite, type Mutation, type OriginHistoryRow, type ReadOptions, type RunRow, type RunWrite, type SearchHit, type SessionListCursor, type SessionListPage,
  type SessionListQuery, type SessionListRow, type StartupSample, type TextAppend, type TextRange, type TurnBranch, type TurnRelayCounts, type TurnCursor, type TurnItems, type TurnWindow,
} from "../../contracts/conversation.js";
import { WORK_TYPES, type ItemType } from "../../contracts/protocol.js";
import {
  DELIVERY_TRANSITIONS, RELAY_BODY_BYTES, RelayError, packetsOf, parseDeliveryOutcome, parseDeliveryRecord, parseHandoffRecord, parseRelayPacket, parseRelayPref, spanOf,
  RELAY_PREF_KEYS,
  type DeliveryRecord, type DeliveryStatus, type HandoffRecord, type RelayIndexRow, type RelayLogPort, type RelayPacket, type RelayPrefKey, type RelayRecoveredDelivery, type RelayRows, type RelayStorePort,
} from "../../contracts/relay.js";
import {
  SessionError, commandId, sessionId,
  type CommandId, type EventDraft, type NativeSessionBinding, type PublicMessage, type PublicRun, type PublicSwitch, type RunId, type SessionEvent, type SessionId, type SessionOrigin, type SessionSnapshot,
} from "../../contracts/session.js";
import { conversationTitle } from "../../contracts/web.js";
import { isDispatched, runRowOf } from "../../contexts/session/domain/run-row.js";
import { fromItems, originFromRows } from "../../contexts/session/domain/store-conversion.js";
import { turnRelayCounts } from "../../contexts/session/domain/relay/narration.js";
import { outlineOfRecord } from "../../contexts/session/domain/turn-source.js";
import { diffConversation, settleConversation, type Applied } from "./diff.js";
import { readJson, readOwner, seedGeneration, writeOwner, writeWhole, type OwnerFile } from "./file-owner.js";
import { emptyFields } from "./item-fields.js";
import { canonicalJson, itemRowOf, utf8Length } from "./rows.js";
import {
  SESSION_FILE_VERSION, conversationOf, entryId, entryLine, fileStamp, headJsonOf, headStateOf, itemFinished, lines, loadSession, pathsOf, readPacketBody, readRange, readRunItems, runFinished,
  sessionsDir, storedItemOf, workspaceSlug,
  factsOfItems, lineHeads, linesBackward, noFacts, readOrigin, sidecarOf, type Loaded, type OriginPlace, type TurnLineFacts, type PacketPlace, type ParentSession, type SessionHeader, type SessionPaths, type StoredPacket, type StoredRun, type TurnStart,
} from "./session-file.js";
import { SessionIndex, handoffsOf, indexRowOf, type IndexRow } from "./session-index.js";
import { drafts, pageLimit, PAGE_BYTES } from "./store-events.js";
import { initializeFile, initializeRoot, pathIdentity, processMayBeAlive, sameFile, sqliteError, storageFailure, type FileIdentity } from "./store-root.js";

/*
 * The store of conversations kept as files (session-file.ts says what a file is): `ConversationStore` over one append-only JSONL file per conversation, the one a Gateway
 * owns for its data root. The contract is the one the store of tables had: synchronous transactions compared by version, events with the commit, one commit per frame;
 * nothing a conversation holds is limited.
 *
 * A COMMIT is worked out whole before anything is written (the comparison of diff.ts, the numbers the store gives, the checks of the relay), then written, then taken into
 * memory: the completed facts go to the conversation's file as lines, what a Turn in progress has not finished goes to its WIP log, the events to the event log beside it.
 * A refusal writes nothing; a write that fails is a failure of the storage, and the store takes no more commits.
 *
 * MEMORY: per conversation opened, its head, a light row per Turn and the byte range of each finished Turn's lines; the items of the Turns not finished. A finished Turn's
 * items are read from its range when asked for (and a few are kept). The list is the cache of session-index.ts, never the files.
 *
 * START: the root is locked (an exclusive SQLite transaction on `owner.sqlite`, held until close), the generation in `owner.json` taken one further, the list made sure of,
 * and each conversation with work not finished (a Turn open, a switch pending, a WIP log left) given to the domain's recovery: the WIP log is laid over the file, the
 * recovery's commit writes what it decided (a Turn whose result is unknown says so, nothing is run again), and the WIP log goes.
 */

const activeRoots = new Set<string>();
const BESIDE = new Set<ItemType>(["notice", "error", "plan", "recap", "artifact", "context_event"]);
const WORK = new Set<string>(WORK_TYPES);
const ROW_BYTES = 64;
const SEARCHED = new Set(["user_message", "assistant_message"]);
const TURN_CACHE_BYTES = 32 * 1024 * 1024;

export interface FileConversationStoreOptions extends ConversationStoreOptions {
  /** Where the store says what it found (a list made again, an old library left alone, a file it could not read). */
  readonly log?: (line: string) => void;
}
/** An edit of a conversation (a file change with a stored detail) and where it is. */
export interface EditRef { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly seq: number }
/** What the Runs of a conversation say as a whole. */
export interface RunSummary {
  readonly runs: number; readonly open: number; readonly unknown: number; readonly unclosed: boolean;
  readonly branchable: { readonly runId: RunId; readonly ordinal: number } | null;
  readonly ran: readonly { readonly harnessId: string; readonly controlId: string; readonly turns: number }[];
}

interface RunPlace { ordinal: number; span: { from: number; to: number } | null; endEntry: string | null; facts: TurnLineFacts }
interface EventPlaces { readonly seqs: number[]; readonly offsets: number[]; readonly lengths: number[]; size: number }
interface Held {
  readonly id: SessionId;
  readonly paths: SessionPaths;
  readonly file: string;
  readonly header: SessionHeader;
  conversation: Conversation;
  title: string;
  headJson: string;
  leaf: string | null;
  nextEntry: number;
  size: number;
  endsInNewline: boolean;
  updatedAt: number;
  mtimeMs: number;
  readonly runs: Map<string, RunPlace>;
  /** Where every Turn of the file starts in the tree, on the current path or not. */
  readonly starts: TurnStart[];
  /** For each Turn not finished, its items whose file line says what memory holds (by the object memory holds). */
  readonly mainItems: Map<string, Map<number, HeldItem>>;
  readonly origin: OriginPlace[];
  readonly prints: Set<string>;
  readonly packets: Map<string, { readonly runId: RunId; readonly packet: RelayPacket }>;
  readonly bodies: Map<string, PacketPlace>;
  readonly deliveries: Map<string, DeliveryRecord>;
  wip: boolean;
  events: EventPlaces | null;
}
interface Plan {
  readonly held: Held | null;
  readonly create: { readonly paths: SessionPaths; readonly file: string; readonly header: SessionHeader } | null;
  readonly settled: Conversation;
  readonly commit: ConversationCommit;
  readonly title: string;
  readonly headJson: string;
  readonly main: string;
  readonly wipLine: string | null;
  readonly endWip: boolean;
  readonly eventLines: readonly string[];
  readonly leaf: string | null;
  readonly nextEntry: number;
  readonly spans: ReadonlyMap<string, { from: number; to: number }>;
  readonly ends: ReadonlyMap<string, string>;
  readonly placed: ReadonlyMap<string, number>;
  readonly written: ReadonlyMap<string, ReadonlySet<number>>;
  readonly finished: ReadonlySet<string>;
  readonly starts: readonly TurnStart[];
  /** The Turns a branch left on the path they were on (no more the conversation's). */
  readonly left: readonly string[];
  readonly origin: readonly OriginPlace[];
  readonly facts: ReadonlyMap<string, TurnLineFacts>;
  readonly prints: readonly string[];
  readonly packets: readonly StoredPacket[];
  readonly packetLine: { readonly offset: number; readonly length: number } | null;
  readonly deliveries: readonly DeliveryRecord[];
}

/** A value frozen all the way down (what is frozen already is passed over). */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
function freezeNew<T extends object>(list: readonly T[] | undefined, was: readonly T[] | undefined): void {
  if (list === undefined || list === was) return;
  for (let index = 0; index < list.length; index++) if (list[index] !== was?.[index]) deepFreeze(list[index]);
  Object.freeze(list);
}
function freezeConversation(after: Conversation, before: Conversation | null): Conversation {
  freezeNew(after.runs, before?.runs); freezeNew(after.commands, before?.commands); freezeNew(after.switches, before?.switches); freezeNew(after.nativeBindings, before?.nativeBindings);
  for (const key of Object.keys(after) as (keyof Conversation)[]) {
    if (key === "runs" || key === "commands" || key === "switches" || key === "nativeBindings") continue;
    if (after[key] !== before?.[key]) deepFreeze(after[key]);
  }
  return Object.freeze(after);
}
function invalid(code: string, message: string): never { throw new SessionError(code, message); }
function counted(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== "number" || !Number.isSafeInteger(chosen) || chosen < 1) invalid("INVALID_INPUT", label + " must be a whole number from 1");
  return chosen;
}
function positive(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== "number" || Number.isNaN(chosen) || chosen < 1) invalid("INVALID_INPUT", label + " must be at least 1");
  return chosen;
}
function wholeNumber(value: unknown, label: string, code = "INVALID_INPUT"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(code, label + " must be a whole number from 0");
  return value;
}
export function encodeTurnCursor(payload: { readonly ordinal: number; readonly lastSeq: number }): TurnCursor { return Buffer.from(JSON.stringify({ ordinal: payload.ordinal, lastSeq: payload.lastSeq }), "utf8").toString("base64url") as TurnCursor; }
export function decodeTurnCursor(cursor: string): { readonly ordinal: number; readonly lastSeq: number } {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return invalid("INVALID_CURSOR", "the cursor is not one this conversation gave"); }
  if (value === null || typeof value !== "object") return invalid("INVALID_CURSOR", "the cursor is not one this conversation gave");
  const row = value as Record<string, unknown>;
  return { ordinal: wholeNumber(row.ordinal, "the cursor's Turn", "INVALID_CURSOR"), lastSeq: wholeNumber(row.lastSeq, "the cursor's cursor", "INVALID_CURSOR") };
}
function encodeListCursor(updatedAt: number, id: string): SessionListCursor { return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url") as SessionListCursor; }
function decodeListCursor(cursor: string): { readonly updatedAt: number; readonly id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt) && typeof value.id === "string") return { updatedAt: value.updatedAt, id: value.id };
  } catch { /* told below */ }
  return invalid("INVALID_CURSOR", "the cursor is not one this list gave");
}
function boundary(buffer: Buffer, index: number): number {
  let at = Math.max(0, index);
  while (at < buffer.length && (buffer[at]! & 0xc0) === 0x80) at++;
  return at;
}
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function prepareFailed(reason: "render" | "render_mismatch" | "storage", message: string): RelayError { return new RelayError({ code: "RELAY_PREPARE_FAILED", reason }, message); }
function asRender<T>(check: () => T, message: string): T {
  try { return check(); }
  catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") throw prepareFailed("render", message + ": " + error.message); throw error; }
}
/** What a relay packet's ledger counts of a finished Turn (relay/narration.ts); null when it cannot be worked out (the Turn is then read when a packet needs it). */
function relayCountsOf(row: RunRow, items: readonly HeldItem[]): TurnRelayCounts | null {
  try {
    const { run, messages } = fromItems({ row, items: [...items], contentRefs: [] });
    const user = messages.find(message => message.role === "user"), assistant = messages.find(message => message.role === "assistant");
    if (user === undefined) return null;
    return turnRelayCounts(outlineOfRecord({ ordinal: row.ordinal, run, user, assistant, legacyOrder: row.legacyOrder }));
  } catch { return null; }
}
/** Whether an item says what the line written for it says (the Runtime may hold an equal item as another object). */
function sameAsWritten(written: HeldItem | undefined, item: HeldItem): boolean {
  if (written === undefined) return false;
  if (written === item) return true;
  return written.status === item.status && written.startedAt === item.startedAt && written.endedAt === item.endedAt && written.parentId === item.parentId && written.text.length === item.text.length
    && (written.fields === item.fields || canonicalJson(written.fields) === canonicalJson(item.fields));
}
const storedRun = (row: RunRow): StoredRun => { const { sessionId: _session, ...rest } = row; return rest; };
function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
}
function append(path: string, text: string, sync: boolean): void {
  const fd = openSync(path, "a", 0o600);
  try { writeAll(fd, text); if (sync) fsyncSync(fd); } finally { closeSync(fd); }
}

/** The title the head keeps: worked out when the first Turn arrives and never again (`conversationTitle`). */
function titleOf(previous: Held | null, next: Conversation, history: readonly OriginHistoryRow[] | undefined): string {
  if (previous !== null && previous.conversation.runs.length > 0) return previous.title;
  const first = next.runs[0]?.items?.find(item => item.itemId === "user")?.text.join("");
  if (previous !== null && history === undefined && (first === undefined || first.trim() === "")) return previous.title;
  const origin = next.origin === undefined || history === undefined ? null : originFromRows(next.origin, history);
  return conversationTitle({ messages: first === undefined ? [] : [{ role: "user", text: first }], ...(origin === null ? {} : { origin }) });
}

/** The numbers only the store can know, put into a Mutation: the seqs of the events, where each chunk of text starts, what each item has counted, the new version. */
function numbered(before: Conversation | null, mutation: Mutation, generation: number, timestamp: string): Applied {
  const head = mutation.head!.row, events = mutation.events, first = head.lastSeq - events.length;
  if (first !== (before?.lastSeq ?? 0)) throw new SessionError("VERSION_CONFLICT", "the conversation moved before this commit");
  const seqOf = (index: number, what: string): number => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= events.length) throw new SessionError("INVALID_DATA", what + " names event " + index + " of a commit with " + events.length);
    return first + index + 1;
  };
  const runs = (mutation.runs ?? []).map((run): RunWrite => ({ op: run.op, row: { ...run.row, userSeq: run.userSeqByEvent === undefined ? run.row.userSeq : seqOf(run.userSeqByEvent, "a Run's input"),
    endedSeq: run.endedByEvent === undefined ? run.row.endedSeq : seqOf(run.endedByEvent, "a Run's end") } }));
  const beforeRuns = new Map<string, ConversationRun>();
  const beforeItem = (runId: string, seq: number): HeldItem | undefined => {
    if (before === null) return undefined;
    let run = beforeRuns.get(runId);
    if (run === undefined) { for (let index = before.runs.length - 1; index >= 0; index--) if (before.runs[index]!.id === runId) { run = before.runs[index]!; beforeRuns.set(runId, run); break; } }
    return run?.items?.find(item => item.seq === seq);
  };
  const key = (runId: string, seq: number): string => runId + "\u0000" + seq;
  const totals = new Map<string, { bytes: number; chunks: number; createdSeq: number | null }>();
  const items = (mutation.items ?? []).map((item): ItemWrite => {
    const createdSeq = item.createdByEvent === undefined ? item.row.createdSeq : seqOf(item.createdByEvent, "an item");
    if (item.op === "insert") totals.set(key(item.row.runId, item.row.seq), { bytes: 0, chunks: 0, createdSeq });
    else { const was = beforeItem(item.row.runId, item.row.seq); totals.set(key(item.row.runId, item.row.seq), { bytes: was?.textBytes ?? 0, chunks: was?.textChunks ?? 0, createdSeq: was?.createdSeq ?? createdSeq }); }
    return { ...item, row: { ...item.row, createdSeq } };
  });
  const text = (mutation.text ?? []).map((piece): TextAppend => {
    let total = totals.get(key(piece.runId, piece.itemSeq));
    if (total === undefined) {
      const was = beforeItem(piece.runId, piece.itemSeq);
      if (was === undefined) throw new SessionError("INVALID_DATA", "text of item " + piece.itemSeq + " of " + piece.runId + ", which does not exist");
      total = { bytes: was.textBytes, chunks: was.textChunks, createdSeq: was.createdSeq }; totals.set(key(piece.runId, piece.itemSeq), total);
    }
    if (piece.chunk !== total.chunks) throw new SessionError("INVALID_TRANSITION", "chunk " + piece.chunk + " of item " + piece.itemSeq + " does not follow chunk " + (total.chunks - 1));
    if (piece.byteOffset !== undefined && piece.byteOffset !== total.bytes) throw new SessionError("INVALID_TRANSITION", "chunk " + piece.chunk + " of item " + piece.itemSeq + " says it starts at byte " + piece.byteOffset + " and the text so far ends at " + total.bytes);
    const byteOffset = total.bytes;
    total.bytes += utf8Length(piece.text); total.chunks += 1;
    return { ...piece, byteOffset };
  });
  const committed = events.map((event, index): SessionEvent => ({ type: event.type, data: event.data, sessionId: head.id, seq: first + index + 1, ownerGeneration: generation, timestamp }));
  const version = (before?.version ?? 0) + 1;
  const written = items.map(item => { const total = totals.get(key(item.row.runId, item.row.seq))!; return { ...item, row: { ...item.row, createdSeq: total.createdSeq ?? item.row.createdSeq, textBytes: total.bytes, textChunks: total.chunks } }; });
  return { events: committed, changes: { ...mutation, head: { row: { ...head, version } }, ...(mutation.runs === undefined ? {} : { runs }), ...(mutation.items === undefined ? {} : { items: written }),
    ...(mutation.text === undefined ? {} : { text }), events: mutation.events } };
}

export class FileConversationStore implements ConversationStore, RelayStorePort, RelayLogPort {
  private generation = 0;
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly markerPath: string;
  private readonly markerIdentity: FileIdentity;
  private readonly ownerPath: string;
  private readonly ownerIdentity: FileIdentity;
  private readonly owner: DatabaseSync;
  private readonly token = randomUUID();
  private readonly clock: () => Date;
  private readonly options: FileConversationStoreOptions;
  private readonly log: (line: string) => void;
  private readonly index: SessionIndex;
  private readonly held = new Map<string, Held>();
  private readonly runOwner = new Map<string, SessionId>();
  private readonly createKeys = new Map<string, SessionId>();
  private readonly turnCache = new Map<string, { readonly items: readonly HeldItem[]; readonly bytes: number }>();
  private turnCacheBytes = 0;
  private readonly sidecars = new Set<SessionId>();
  private sidecarTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffLog: HandoffRecord[] = [];
  private prefs: Partial<Record<RelayPrefKey, string>> = {};
  private closed = false;
  private failed: SessionError | null = null;
  private inTransaction = false;

  constructor(root: string, options: FileConversationStoreOptions = {}) {
    if (!isAbsolute(root) || root.includes("\0") || utf8Length(root) > 4096) throw new SessionError("INVALID_INPUT", "data root must be a bounded absolute path");
    this.options = options;
    this.clock = options.now ?? (() => new Date());
    this.log = options.log ?? (line => { process.stderr.write("HarnessGateway: " + line + "\n"); });
    const initialized = initializeRoot(root);
    this.root = initialized.root; this.rootIdentity = pathIdentity(this.root, true);
    this.markerPath = initialized.markerPath; this.markerIdentity = initialized.markerIdentity;
    this.ownerPath = join(this.root, "owner.sqlite");
    if (activeRoots.has(this.root)) throw new SessionError("OWNER_BUSY", "this process already owns this data root");
    activeRoots.add(this.root);
    try {
      this.ownerIdentity = initializeFile(this.ownerPath);
      this.owner = new DatabaseSync(this.ownerPath, { timeout: 0, allowExtension: false });
    } catch (error) { activeRoots.delete(this.root); throw error instanceof SessionError ? error : storageFailure(error); }
    this.index = new SessionIndex(this.root, line => { this.log("SESSIONS (" + line + ")"); });
    let claimed = false;
    try {
      this.owner.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
      if (!sameFile(this.ownerIdentity, pathIdentity(this.ownerPath))) throw new SessionError("OWNER_LOST", "owner lock path changed during acquisition");
      const prior = readOwner(this.root);
      if (prior !== null && prior.active && prior.pid !== process.pid && processMayBeAlive(prior.pid)) throw new SessionError("OWNER_UNCONFIRMED", "previous owner may still be alive; automatic takeover is refused");
      const generation = Math.max(prior?.generation ?? 0, prior === null ? seedGeneration(this.root) : 0) + 1;
      writeOwner(this.root, { generation, pid: process.pid, token: this.token, active: true });
      this.generation = generation; claimed = true;
      if (existsSync(join(this.root, "gateway.sqlite"))) this.log("SESSIONS (旧格式的对话库不再读取：gateway.sqlite 留在原处，未读取、未改动)");
      this.handoffLog = this.readHandoffs(); this.prefs = this.readPrefs();
      this.index.open();
      for (const row of this.index.rows.values()) if (row.createKey !== null) this.createKeys.set(row.createKey, row.id);
      this.recoverUnfinished();
    } catch (error) {
      if (claimed) { try { writeOwner(this.root, { generation: this.generation, pid: process.pid, token: this.token, active: false }); } catch { /* the lock goes next */ } }
      try { this.index.close(); } catch { /* derived */ }
      if (this.owner.isOpen) this.owner.close();
      activeRoots.delete(this.root);
      if (sqliteError(error) && (error as { errcode?: unknown }).errcode === 5) throw new SessionError("OWNER_BUSY", "another owner holds this data root");
      throw error instanceof SessionError || !sqliteError(error) ? error : storageFailure(error);
    }
  }

  get ownerGeneration(): number { return this.generation; }

  assertOwner(): void {
    if (this.closed) throw new SessionError("STORE_CLOSED", "Session store is closed");
    if (this.failed) throw this.failed;
    try {
      this.assertPaths();
      const owner = readOwner(this.root);
      if (owner === null || !owner.active || owner.generation !== this.generation || owner.token !== this.token || owner.pid !== process.pid) throw new SessionError("OWNER_LOST", "persistent owner generation no longer belongs to this process");
    } catch (error) {
      this.held.clear(); this.turnCache.clear();
      this.failed = error instanceof SessionError && error.code === "OWNER_LOST" ? error : new SessionError("OWNER_LOST", "owner lock, path identity or generation could not be confirmed");
      if (this.failed !== error) this.failed.cause = error;
      throw this.failed;
    }
  }
  private assertPaths(): void {
    if (!this.owner.isOpen || !this.owner.isTransaction || !sameFile(this.rootIdentity, pathIdentity(this.root, true)) || !sameFile(this.markerIdentity, pathIdentity(this.markerPath))
      || !sameFile(this.ownerIdentity, pathIdentity(this.ownerPath))) throw new SessionError("OWNER_LOST", "owner lock or storage path identity was lost");
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------------------------------------------------

  private recoverUnfinished(): void {
    const recover = this.options.recover;
    if (recover === undefined) return;
    const ids = [...this.index.rows.values()].filter(row => row.unfinished).map(row => row.id).sort();
    for (const id of ids) {
      try { this.recoverOne(id, recover); }
      catch (error) {
        if (this.failed !== null) throw this.failed;
        this.log("SESSIONS (a conversation left unfinished was not recovered: " + id + ": " + (error instanceof Error ? error.message : "unreadable") + ")");
      }
    }
  }
  private recoverOne(id: SessionId, recover: NonNullable<ConversationStoreOptions["recover"]>): void {
    const held = this.entry(id), current = held.conversation, recovered = recover(current);
    if (recovered === null) { this.endWipIfIdle(held); return; }
    const at = this.stamp(), recoverRelay = this.options.recoverRelay;
    let plan: Plan | null = null;
    if (recoverRelay !== undefined) {
      // The relay's part on its own: when it fails, the conversation is recovered without it and says so (relayRecoveryFailed).
      try {
        const relay = recoverRelay(recovered.next, this.deliveriesOf(held), [...held.packets.values()].map(entry => entry.packet));
        if (relay === null) plan = this.prepare(held, recovered, at);
        else {
          const events = recovered.events.map(event => event.type === "session.recovered" ? { type: event.type, data: { ...event.data, relay: {
            failed: false, deliveries: relay.deliveries.map((row: RelayRecoveredDelivery) => ({ runId: row.runId, outcome: row.outcome.kind })),
            bindings: (relay.next.nativeBindings ?? []).flatMap(binding => binding.relay === undefined ? [] : [{ harnessId: binding.harnessId, controlId: binding.controlId, epoch: binding.relay.epoch, pending: binding.relay.pending !== null }]) } } } : event);
          const decided = relay.deliveries.map((row: RelayRecoveredDelivery) => ({ kind: "outcome" as const, runId: row.runId, outcome: row.outcome }));
          plan = this.prepare(held, { ...recovered, next: relay.next, events, relay: { ...recovered.relay, deliveries: [...(recovered.relay?.deliveries ?? []), ...decided] } }, at);
        }
      } catch { plan = null; }
      if (plan === null) {
        const index = recovered.events.findIndex(event => event.type === "session.recovered");
        const events = recovered.events.map(event => event.type === "session.recovered" ? { type: event.type, data: { ...event.data, relay: { failed: true } } } : event);
        plan = this.prepare(held, { ...recovered, next: { ...recovered.next, relayRecoveryFailed: current.lastSeq + 1 + Math.max(0, index) }, events }, at);
      }
    } else plan = this.prepare(held, recovered, at);
    this.apply(plan);
  }
  private endWipIfIdle(held: Held): void {
    if (!held.wip || held.conversation.runs.some(run => !runFinished(run.status))) return;
    try { unlinkSync(held.paths.wip); } catch { /* gone already */ }
    held.wip = false;
    this.index.put({ ...this.index.rows.get(held.id)!, unfinished: held.conversation.pendingSwitchId !== null });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Conversations: create, get, transact
  // ---------------------------------------------------------------------------------------------------------------------

  create(conversation: Conversation, events: readonly EventDraft[], originHistory?: readonly OriginHistoryRow[]): ConversationCommit {
    this.assertOwner();
    if (conversation.format !== CONVERSATION_FORMAT || conversation.version !== 0 || conversation.lastSeq !== 0) throw new SessionError("INVALID_INPUT", "new Session must use format 14 and start at version and cursor zero");
    drafts(events);
    const id = sessionId(conversation.id), create = conversation.commands.find(entry => entry.kind === "create");
    if (!create) throw new SessionError("INVALID_DATA", "Session create command is missing");
    return this.transaction(() => {
      const prior = this.createKeys.get(create.id);
      if (prior !== undefined) {
        const existing = this.entry(prior).conversation;
        if (existing.commands[0]?.fingerprint !== create.fingerprint) throw new SessionError("IDEMPOTENCY_CONFLICT", "create key already names another request");
        return { conversation: existing, events: [], changes: { events: [] } };
      }
      if (this.index.rows.has(id)) throw new SessionError("SESSION_EXISTS", "Session identity already exists");
      const at = this.stamp(), slug = workspaceSlug(conversation.configuration.workspace);
      const main = join(sessionsDir(this.root), slug, fileStamp(at) + "_" + id + ".jsonl");
      if (existsSync(main)) throw new SessionError("SESSION_EXISTS", "Session identity already exists");
      const parentSession = this.parentOf(conversation);
      const header: SessionHeader = { type: "session", version: SESSION_FILE_VERSION, id, timestamp: at.toISOString(), cwd: conversation.configuration.workspace, createKey: create.id,
        ...(parentSession === null ? {} : { parentSession }) };
      const plan = this.prepare(null, { next: conversation, events, ...(originHistory === undefined ? {} : { originHistory }) }, at, { paths: pathsOf(main), file: relative(sessionsDir(this.root), main), header });
      this.apply(plan);
      return plan.commit;
    });
  }
  /** Where a branch came from, for its header: the source's file and the line that ended the Turn it branched after. */
  private parentOf(conversation: Conversation): ParentSession | null {
    const origin = conversation.origin;
    if (origin?.kind !== "fork") return null;
    const source = this.index.rows.get(origin.sessionId);
    if (source === undefined) return { id: origin.sessionId, path: "", entryId: null };
    let entry: string | null = null;
    try { entry = this.entry(origin.sessionId).runs.get(origin.throughRunId)?.endEntry ?? null; } catch { entry = null; }
    return { id: origin.sessionId, path: source.file, entryId: entry };
  }

  get(id: SessionId): Conversation { this.assertOwner(); sessionId(id); return this.entry(id).conversation; }

  findByCreateKey(key: CommandId): Conversation | null {
    this.assertOwner(); commandId(key);
    const id = this.createKeys.get(key);
    return id === undefined ? null : this.entry(id).conversation;
  }

  transact(id: SessionId, expectedVersion: number, mutate: (current: Conversation) => ConversationMutation): ConversationCommit {
    this.assertOwner(); sessionId(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof mutate !== "function") throw new SessionError("INVALID_INPUT", "transaction requires a positive expected version and synchronous mutation");
    return this.transaction(() => {
      const held = this.entry(id);
      if (held.conversation.version !== expectedVersion) throw new SessionError("VERSION_CONFLICT", "Session version changed before the mutation");
      const mutation = mutate(held.conversation);
      if (mutation === null || typeof mutation !== "object" || "then" in mutation) throw new SessionError("INVALID_DATA", "Session mutation must be synchronous");
      if (mutation.relay !== undefined && (mutation.relay === null || typeof mutation.relay !== "object" || Array.isArray(mutation.relay))) throw new SessionError("INVALID_DATA", "relay rows must be an object");
      const plan = this.prepare(held, mutation, this.stamp());
      this.apply(plan);
      return plan.commit;
    });
  }

  /** Works a commit out whole: what changed, the numbers, the relay's checks, the lines. Writes nothing and changes no memory; a throw refuses the commit. */
  private prepare(held: Held | null, mutation: ConversationMutation, at: Date, create?: Plan["create"], options: { readonly leafTo?: string } = {}): Plan {
    const whole = held?.conversation ?? null, next = mutation.next, branchAt = mutation.branch?.at;
    // A commit that goes on from an earlier place is compared with the conversation up to that place: the Turns after it stay on the branch they were on.
    if (branchAt !== undefined) {
      if (whole === null || !Number.isSafeInteger(branchAt) || branchAt < 0 || branchAt > whole.runs.length) throw new SessionError("INVALID_INPUT", "a branch starts at a Turn of the conversation");
      if (whole.runs.some(run => !runFinished(run.status)) || whole.pendingSwitchId !== null) throw new SessionError("BRANCH_BUSY", "回合进行中不能在旧位置重发：等这一轮结束或先停止它");
    }
    const before = whole === null || branchAt === undefined ? whole : { ...whole, runs: whole.runs.slice(0, branchAt) };
    if (next === null || typeof next !== "object" || next.format !== CONVERSATION_FORMAT) throw new SessionError("INVALID_DATA", "a mutation gives the conversation in the new shape");
    if (before !== null && next.id !== before.id) throw new SessionError("INVALID_DATA", "transaction cannot replace Session identity");
    if (before !== null && next.commands !== before.commands) {
      const was = before.commands[0], now = next.commands[0];
      if (was === undefined || now === undefined || JSON.stringify(was) !== JSON.stringify(now)) throw new SessionError("INVALID_DATA", "transaction cannot replace Session create identity");
    }
    const events = drafts(mutation.events), title = titleOf(held, next, mutation.originHistory), timestamp = at.toISOString();
    const made = diffConversation(before, next, { events, ...(mutation.relay === undefined ? {} : { relay: mutation.relay }),
      ...(mutation.originHistory === undefined ? {} : { originHistory: mutation.originHistory }), ...(mutation.noticePrints === undefined ? {} : { noticePrints: mutation.noticePrints }),
      ...(mutation.createdBy === undefined ? {} : { createdBy: mutation.createdBy }), title, updatedAt: at.getTime() });
    const applied = numbered(before, made, this.generation, timestamp);
    const settled = settleConversation(next, applied), changes = applied.changes, seq = changes.head!.row.lastSeq;
    const relay = mutation.relay === undefined ? { packets: [] as StoredPacket[], deliveries: [] as DeliveryRecord[] } : this.checkRelay(held, settled, mutation.relay);
    this.checkPacketReferences(held, before, changes, relay.packets);

    // The lines, in the order a reader takes them in: the conversation's name and quoted history, its commands, the Turns, the bindings and switches, the relay, the head.
    const base = (held?.size ?? 0) + (held !== null && !held.endsInNewline ? 1 : 0);
    // The lines of a branch are written under the line the Turn it replaces was written under; a change of branch first writes where the conversation now is.
    const branchAnchor = branchAt === undefined || whole === null || branchAt === whole.runs.length ? undefined : held!.starts.find(start => start.runId === whole.runs[branchAt]!.id)?.anchor;
    if (branchAt !== undefined && whole !== null && branchAt < whole.runs.length && branchAnchor === undefined) throw new SessionError("INVALID_DATA", "the Turn a branch replaces has no start in the file");
    let text = held !== null && !held.endsInNewline ? "\n" : "", offset = base, leaf = branchAnchor !== undefined ? branchAnchor : options.leafTo ?? held?.leaf ?? null, nextEntry = held?.nextEntry ?? 1;
    if (create !== null && create !== undefined) { const line = JSON.stringify(create.header) + "\n"; text += line; offset += Buffer.byteLength(line, "utf8"); }
    const placed = new Map<string, number>(), anchor = leaf, starts: TurnStart[] = [];
    const add = (type: string, rest: Readonly<Record<string, unknown>>): { readonly id: string; readonly offset: number; readonly length: number } => {
      const id = entryId(nextEntry++), line = entryLine(type, id, leaf, timestamp, seq, rest), length = Buffer.byteLength(line, "utf8");
      const where = { id, offset, length };
      text += line + "\n"; offset += length + 1; leaf = id;
      return where;
    };
    if (options.leafTo !== undefined) add("leaf", { targetId: options.leafTo });
    if (held === null || title !== held.title) add("session_info", { name: title });
    const originPlaces: OriginPlace[] = [];
    for (const row of mutation.originHistory ?? []) {
      const where = add("origin", { idx: row.idx, kind: row.kind, message: row.message });
      originPlaces.push({ idx: row.idx, kind: row.kind, offset: where.offset, length: where.length, refs: (row.message.attachments ?? []).map(attachment => attachment.id) });
    }
    for (const row of changes.commands ?? []) add("command", { ordinal: row.ordinal, command: row.command });

    const runWrites = new Map((changes.runs ?? []).map(write => [write.row.runId as string, write]));
    const itemWrites = new Map<string, Map<number, ItemWrite>>(), textWrites = new Map<string, Map<number, TextAppend[]>>();
    for (const write of changes.items ?? []) { let map = itemWrites.get(write.row.runId); if (map === undefined) { map = new Map(); itemWrites.set(write.row.runId, map); } map.set(write.row.seq, write); }
    for (const piece of changes.text ?? []) { let map = textWrites.get(piece.runId); if (map === undefined) { map = new Map(); textWrites.set(piece.runId, map); } const list = map.get(piece.itemSeq) ?? []; list.push(piece); map.set(piece.itemSeq, list); }
    const touched = new Set<string>([...runWrites.keys(), ...itemWrites.keys(), ...textWrites.keys()]);
    const ordinals = [...touched].map(runId => ({ runId, ordinal: runWrites.get(runId)?.row.ordinal ?? held?.runs.get(runId)?.ordinal ?? -1 })).sort((left, right) => left.ordinal - right.ordinal);
    const spans = new Map<string, { from: number; to: number }>(), ends = new Map<string, string>(), written = new Map<string, Set<number>>(), finished = new Set<string>(), facts = new Map<string, TurnLineFacts>();
    const wipRuns: StoredRun[] = [], wipItems: { runId: string; item: Omit<ReturnType<typeof storedItemOf>, "text"> }[] = [], wipText: { runId: string; itemSeq: number; text: string }[] = [];
    const spanOf = (runId: string, where: { offset: number; length: number }): void => {
      const was = spans.get(runId) ?? held?.runs.get(runId)?.span ?? null;
      spans.set(runId, was === null ? { from: where.offset, to: where.offset + where.length } : { from: Math.min(was.from, where.offset), to: Math.max(was.to, where.offset + where.length) });
    };
    for (const { runId, ordinal } of ordinals) {
      const run = next.runs[ordinal], was = before?.runs[ordinal], row = runWrites.get(runId)?.row;
      if (run === undefined || run.id !== runId) throw new SessionError("INVALID_DATA", "a commit changed a Run it does not hold");
      placed.set(runId, ordinal);
      if (was !== undefined && runFinished(was.status)) { if (row !== undefined) add("turn", { phase: "update", run: storedRun(row) }); continue; }
      // A Turn's start says the line its commit was written under: the Turns of one anchor are the alternatives of one place in the conversation.
      if (was === undefined) starts.push({ runId, anchor, entry: add("turn", { phase: "start", anchor, run: storedRun(row ?? runRowOf(next.id, run)) }).id });
      const endsNow = runFinished(run.status), inMain = held?.mainItems.get(runId), changedItems = itemWrites.get(runId), changedText = textWrites.get(runId);
      const wroteHere = new Set<number>();
      // The seq of the commit that made an item is on the item as this store settled it (`was`); the reducer's own copy of an item it did not touch has none.
      const madeAt = new Map((was?.items ?? []).map(item => [item.seq, item.createdSeq]));
      for (const item of run.items ?? (endsNow ? was?.items : undefined) ?? []) {
        const changed = changedItems?.has(item.seq) === true || changedText?.has(item.seq) === true;
        if (!changed && (!endsNow || sameAsWritten(inMain?.get(item.seq), item))) continue;
        const createdSeq = changedItems?.get(item.seq)?.row.createdSeq ?? item.createdSeq ?? madeAt.get(item.seq) ?? null;
        // One line per item: the user's message the moment it is accepted, every other item once, when its Turn ends. An item's own end is not its last change (a call's
        // stored detail is put on it by a later commit: items-place.ts asks the content store for it when the call ends), so until the Turn ends it lives in the WIP log.
        if (endsNow || item.type === "user_message") {
          spanOf(runId, add("item", { runId, item: storedItemOf(item, createdSeq) })); wroteHere.add(item.seq);
          continue;
        }
        const write = changedItems?.get(item.seq);
        if (write !== undefined) { const { text: _text, ...rest } = storedItemOf(item, createdSeq); wipItems.push({ runId, item: rest }); }
        for (const piece of changedText?.get(item.seq) ?? []) wipText.push({ runId, itemSeq: item.seq, text: piece.text });
      }
      if (endsNow) {
        if (row === undefined) throw new SessionError("INVALID_DATA", "a Run ended without its row");
        // What a packet's ledger counts of the Turn is recorded with its end, so that a packet that does not reach it need not read it.
        const items = run.items ?? was?.items ?? [], counts = relayCountsOf(row, items);
        ends.set(runId, add("turn", { phase: "end", run: storedRun(row), ...(counts === null ? {} : { counts }) }).id); finished.add(runId);
        facts.set(runId, { ...factsOfItems(items), ...(counts === null ? {} : { relay: counts }) });
      } else {
        if (was !== undefined && row !== undefined) wipRuns.push(storedRun(row));
        written.set(runId, wroteHere);
      }
    }
    for (const write of changes.bindings ?? []) add("binding", { ordinal: write.row.ordinal, binding: write.row.binding });
    for (const write of changes.switches ?? []) add("switch", { ordinal: write.row.ordinal, switch: write.row.switch });
    const prints = (changes.noticePrints ?? []).filter(print => held?.prints.has(print) !== true);
    if (prints.length > 0) add("custom", { customType: "notice_prints", data: { prints } });
    let packetLine: Plan["packetLine"] = null;
    if (relay.packets.length > 0 || relay.deliveries.length > 0) {
      const where = add("relay", { ...(relay.packets.length === 0 ? {} : { packets: relay.packets }), ...(relay.deliveries.length === 0 ? {} : { deliveries: relay.deliveries }) });
      if (relay.packets.length > 0) packetLine = { offset: where.offset, length: where.length };
    }
    const state = headStateOf(settled), headJson = JSON.stringify(state);
    if (held === null || headJson !== held.headJson) add("head", { head: state });

    const open = settled.runs.some(entry => !runFinished(entry.status));
    const endWip = !open;
    const wipLine = !open || (wipRuns.length === 0 && wipItems.length === 0 && wipText.length === 0) ? null
      : JSON.stringify({ type: "wip", seq, timestamp, ...(wipRuns.length === 0 ? {} : { runs: wipRuns }), ...(wipItems.length === 0 ? {} : { items: wipItems }), ...(wipText.length === 0 ? {} : { text: wipText }) }) + "\n";
    const eventLines = applied.events.map(event => JSON.stringify({ seq: event.seq, type: event.type, sessionId: event.sessionId, ownerGeneration: event.ownerGeneration, timestamp: event.timestamp, data: event.data }) + "\n");
    const frozen = freezeConversation(settled, before);
    return { held, create: create ?? null, settled: frozen, commit: { conversation: frozen, events: applied.events, changes }, title, headJson, main: text, wipLine, endWip, eventLines, leaf, nextEntry,
      spans, ends, placed, written, finished, starts, origin: originPlaces, facts, left: branchAt === undefined || whole === null ? [] : whole.runs.slice(branchAt).map(run => run.id as string), prints, packets: relay.packets, packetLine, deliveries: relay.deliveries };
  }

  /** Writes a commit worked out by `prepare` (the file first, then the WIP log, then the events), then takes it into memory. A write that fails fails the store. */
  private apply(plan: Plan): void {
    const paths = plan.held?.paths ?? plan.create!.paths;
    try {
      if (plan.create !== null) {
        mkdirSync(dirname(paths.main), { recursive: true, mode: 0o700 });
        const fd = openSync(paths.main, "wx", 0o600);
        try { writeAll(fd, plan.main); fsyncSync(fd); } finally { closeSync(fd); }
      } else if (plan.main !== "") append(paths.main, plan.main, true);
      if (plan.wipLine !== null) append(paths.wip, plan.wipLine, false);
      if (plan.eventLines.length > 0) append(paths.events, plan.eventLines.join(""), false);
      if (plan.endWip && (plan.held?.wip === true || plan.wipLine !== null)) { try { unlinkSync(paths.wip); } catch (error) { if ((error as { code?: unknown }).code !== "ENOENT") throw error; } }
    } catch (error) {
      this.failed = storageFailure(error);
      this.held.clear(); this.turnCache.clear();
      throw this.failed;
    }
    const held: Held = plan.held ?? { id: plan.settled.id, paths, file: plan.create!.file, header: plan.create!.header, conversation: plan.settled, title: plan.title, headJson: plan.headJson, leaf: null,
      nextEntry: 1, size: 0, endsInNewline: true, updatedAt: 0, mtimeMs: 0, runs: new Map(), starts: [], mainItems: new Map(), origin: [], prints: new Set(), packets: new Map(), bodies: new Map(), deliveries: new Map(),
      wip: false, events: null };
    const base = held.size;
    held.conversation = plan.settled; held.title = plan.title; held.headJson = plan.headJson; held.leaf = plan.leaf; held.nextEntry = plan.nextEntry;
    held.size = base + Buffer.byteLength(plan.main, "utf8"); held.endsInNewline = true; held.updatedAt = Date.parse(plan.commit.events[0]?.timestamp ?? "") || Date.now();
    for (const runId of plan.left) held.runs.delete(runId);
    for (const [runId, ordinal] of plan.placed) { if (!held.runs.has(runId)) held.runs.set(runId, { ordinal, span: null, endEntry: null, facts: noFacts() }); this.runOwner.set(runId, held.id); }
    for (const [runId, made] of plan.facts) held.runs.get(runId)!.facts = made;
    for (const [runId, span] of plan.spans) held.runs.get(runId)!.span = span;
    for (const [runId, entry] of plan.ends) held.runs.get(runId)!.endEntry = entry;
    for (const runId of plan.finished) held.mainItems.delete(runId);
    held.starts.push(...plan.starts);
    for (const [runId, seqs] of plan.written) {
      if (seqs.size === 0) continue;
      const map = held.mainItems.get(runId) ?? new Map<number, HeldItem>(), run = plan.settled.runs[held.runs.get(runId)!.ordinal];
      for (const item of run?.items ?? []) if (seqs.has(item.seq)) map.set(item.seq, item);
      held.mainItems.set(runId, map);
    }
    held.origin.push(...plan.origin);
    for (const print of plan.prints) held.prints.add(print);
    plan.packets.forEach((stored, index) => {
      if (!held.packets.has(stored.packet.id)) held.packets.set(stored.packet.id, { runId: stored.runId, packet: stored.packet });
      if (plan.packetLine !== null && !held.bodies.has(stored.packet.body.sha256)) held.bodies.set(stored.packet.body.sha256, { ...plan.packetLine, index });
    });
    for (const record of plan.deliveries) held.deliveries.set(record.runId, record);
    if (plan.wipLine !== null) held.wip = true;
    if (plan.endWip) held.wip = false;
    if (held.events !== null) {
      for (const line of plan.eventLines) {
        const length = Buffer.byteLength(line, "utf8");
        held.events.seqs.push(Number(/^\{"seq":(\d+)/u.exec(line)![1])); held.events.offsets.push(held.events.size); held.events.lengths.push(length - 1); held.events.size += length;
      }
    }
    this.held.set(held.id, held);
    if (plan.create !== null) this.createKeys.set(plan.create.header.createKey!, held.id);
    // The list's row follows every commit in memory; it is written out when the file it describes moved (a commit of the WIP log alone moves nothing it holds to).
    const was = this.index.rows.get(held.id), moved = plan.main !== "" || was === undefined || was.unfinished !== (held.wip || plan.settled.runs.some(run => !runFinished(run.status)) || plan.settled.pendingSwitchId !== null);
    if (plan.main !== "") { try { held.mtimeMs = statSync(paths.main).mtimeMs; } catch { /* derived */ } this.sidecarSoon(held.id); }
    const row = indexRowOf(held.conversation, held.file, { title: held.title, updatedAt: held.updatedAt, createKey: held.header.createKey ?? null, handoffs: handoffsOf(held), size: held.size, mtimeMs: held.mtimeMs || (was?.mtimeMs ?? 0) });
    this.index.put(held.wip ? { ...row, unfinished: true } : row, moved);
  }

  /** The conversation as the Runtime reduces it, from memory or read from its file. */
  private entry(id: SessionId): Held {
    const found = this.held.get(id);
    if (found !== undefined) return found;
    const row = this.index.rows.get(id);
    if (row === undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    let loaded: Loaded;
    try { loaded = loadSession(join(sessionsDir(this.root), row.file)); } catch (error) { if (error instanceof SessionError) throw error; throw storageFailure(error); }
    const held = this.heldFrom(id, row.file, loaded);
    this.held.set(id, held);
    // A file read whole (no cache, or one the file had gone past) leaves its fold beside it for the next start.
    if (!loaded.fromCache) this.sidecarSoon(id);
    return held;
  }
  private heldFrom(id: SessionId, file: string, loaded: Loaded, version?: number): Held {
    if (loaded.header.id !== id) throw new SessionError("INVALID_DATA", "the conversation file holds another conversation");
    const read = conversationOf(loaded), conversation = freezeConversation(version === undefined ? read : { ...read, version }, null);
    const held: Held = { id, paths: loaded.paths, file, header: loaded.header, conversation, title: loaded.title, headJson: JSON.stringify(headStateOf(conversation)), leaf: loaded.leaf,
      nextEntry: loaded.nextEntry, size: loaded.size, endsInNewline: loaded.endsInNewline, updatedAt: loaded.updatedAt, mtimeMs: loaded.mtimeMs, runs: new Map(), starts: loaded.starts, mainItems: new Map(), origin: loaded.origin, prints: loaded.prints,
      packets: loaded.packets, bodies: loaded.bodies, deliveries: loaded.deliveries, wip: loaded.wip, events: null };
    loaded.runs.forEach((run, ordinal) => {
      held.runs.set(run.row.runId, { ordinal, span: run.span, endEntry: run.endEntry, facts: run.facts });
      this.runOwner.set(run.row.runId, id);
      if (run.items === null) return;
      // The items the file says as memory holds them: those the WIP log did not change since.
      const map = new Map<number, HeldItem>(), items = conversation.runs[ordinal]?.items ?? [];
      for (const item of items) { const found = run.items.get(item.seq); if (found !== undefined && found.mainSeq > 0 && !found.dirty) map.set(item.seq, item); }
      held.mainItems.set(run.row.runId, map);
    });
    return held;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Branches inside a conversation
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * Makes the branch through the Turn `runId` the conversation's path, at the latest line written on it: the conversation as that path has it is given to `mutate`, and the
   * commit is written after a `leaf` line that says where the conversation now is (so it opens there again). Only while no Turn is open and no switch waits.
   */
  selectBranch(id: SessionId, expectedVersion: number, runId: RunId, mutate: (current: Conversation) => ConversationMutation): ConversationCommit {
    this.assertOwner(); sessionId(id);
    return this.transaction(() => {
      const held = this.entry(id), current = held.conversation;
      if (current.version !== expectedVersion) throw new SessionError("VERSION_CONFLICT", "Session version changed before the mutation");
      if (current.runs.some(run => !runFinished(run.status)) || current.pendingSwitchId !== null || held.wip) throw new SessionError("BRANCH_BUSY", "回合进行中不能切换分支：等这一轮结束或先停止它");
      const start = held.starts.find(entry => entry.runId === runId);
      if (start === undefined) throw new SessionError("BRANCH_NOT_FOUND", "这个对话里没有这一轮");
      let alternative: Held;
      try { alternative = this.heldFrom(id, held.file, loadSession(held.paths.main, { leaf: this.latestUnder(held, start.entry) }), current.version); }
      catch (error) { if (error instanceof SessionError) throw error; throw storageFailure(error); }
      const mutation = mutate(alternative.conversation);
      if (mutation === null || typeof mutation !== "object" || "then" in mutation) throw new SessionError("INVALID_DATA", "Session mutation must be synchronous");
      const plan = this.prepare(alternative, mutation, this.stamp(), undefined, { leafTo: alternative.leaf! });
      this.apply(plan);
      for (const runId of current.runs.map(run => run.id)) if (!alternative.runs.has(runId)) this.turnCache.delete(runId);
      return plan.commit;
    });
  }
  /** The latest line of the file under the line `entry` (the line itself when nothing was written under it). */
  private latestUnder(held: Held, entry: string): string {
    let heads: ReturnType<typeof lineHeads>;
    try { heads = lineHeads(readFileSync(held.paths.main)); } catch (error) { throw storageFailure(error); }
    const parents = new Map(heads.map(head => [head.id, head.parent] as const)), under = new Map<string, boolean>([[entry, true]]);
    for (let index = heads.length - 1; index >= 0; index--) {
      const walked: string[] = [];
      let at: string | null = heads[index]!.id, found = false;
      while (at !== null) {
        const known = under.get(at);
        if (known !== undefined) { found = known; break; }
        walked.push(at); at = parents.get(at) ?? null;
      }
      for (const id of walked) under.set(id, found);
      if (found) return heads[index]!.id;
    }
    return entry;
  }
  /** Where each Turn of the current path that has alternatives stands among them (the Turns written under one line, in the order they were written). */
  branches(id: SessionId): ReadonlyMap<RunId, TurnBranch> {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), byAnchor = new Map<string, string[]>(), found = new Map<RunId, TurnBranch>();
    for (const start of held.starts) { const key = start.anchor ?? ""; const list = byAnchor.get(key) ?? []; list.push(start.runId); byAnchor.set(key, list); }
    for (const start of held.starts) {
      if (!held.runs.has(start.runId)) continue;
      const list = byAnchor.get(start.anchor ?? "")!;
      if (list.length < 2) continue;
      const at = list.indexOf(start.runId);
      found.set(start.runId as RunId, { n: at + 1, of: list.length, prev: (list[at - 1] ?? null) as RunId | null, next: (list[at + 1] ?? null) as RunId | null });
    }
    return found;
  }

  /** The fold of a conversation is written beside its file soon (a cache: a start without it reads the file). */
  private sidecarSoon(id: SessionId): void {
    this.sidecars.add(id);
    if (this.sidecarTimer !== null) return;
    this.sidecarTimer = setTimeout(() => { this.sidecarTimer = null; this.flushSidecars(); }, 2000);
    this.sidecarTimer.unref();
  }
  private flushSidecars(): void {
    if (this.sidecarTimer !== null) { clearTimeout(this.sidecarTimer); this.sidecarTimer = null; }
    for (const id of this.sidecars) {
      const held = this.held.get(id);
      // Only a conversation with no Turn open: what an open Turn holds is the WIP log's, and the next start reads it from there with the file.
      if (held === undefined || held.wip || held.conversation.runs.some(run => !runFinished(run.status))) continue;
      try {
        const runs = held.conversation.runs.map(run => { const place = held.runs.get(run.id); return { row: runRowOf(id, run), span: place?.span ?? null, endEntry: place?.endEntry ?? null, facts: place?.facts ?? noFacts() }; });
        writeWhole(held.paths.index, sidecarOf({ ...held, head: headStateOf(held.conversation), commands: [...held.conversation.commands], runs, bindings: [...(held.conversation.nativeBindings ?? [])],
          switches: [...held.conversation.switches], lastSeq: held.conversation.lastSeq }));
      } catch { /* derived: the next start reads the file */ }
    }
    this.sidecars.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The relay's checks and rows
  // ---------------------------------------------------------------------------------------------------------------------

  private checkRelay(held: Held | null, settled: Conversation, rows: RelayRows): { packets: StoredPacket[]; deliveries: DeliveryRecord[] } {
    const byId = new Map(settled.runs.map(run => [run.id as string, run]));
    const runOf = (runId: string, label: string): ConversationRun => { const run = byId.get(runId); if (run === undefined) throw new SessionError("INVALID_DATA", label + " names a Run of another Session"); return run; };
    const packets: StoredPacket[] = [], fresh = new Map<string, RelayPacket>();
    for (const write of rows.packets ?? []) {
      const packet = asRender(() => parseRelayPacket(write.packet), "the relay packet manifest is invalid");
      const current = runOf(write.runId, "a relay packet");
      if (typeof write.body !== "string" || write.body.includes("\0")) throw prepareFailed("render", "the relay packet text is invalid");
      const bytes = Buffer.byteLength(write.body, "utf8"), digest = sha256(write.body);
      if (bytes < 1 || bytes > RELAY_BODY_BYTES || bytes !== packet.body.bytes || digest !== packet.body.sha256) throw prepareFailed("render", "the relay packet text does not match its manifest");
      if (packet.target.harnessId !== current.selection.harnessId || packet.target.controlId !== current.selection.controlId) throw prepareFailed("render", "the relay packet is for another Harness than its Turn's");
      for (const entry of packet.runs) {
        const [first, last] = spanOf(entry);
        for (let ordinal = first; ordinal <= last; ordinal++) {
          const quoted = settled.runs[ordinal];
          if (quoted === undefined || quoted.id === current.id || !runFinished(quoted.status)) throw prepareFailed("render", "the relay packet quotes a Turn that has not finished");
          if (quoted.userSeq >= current.userSeq) throw prepareFailed("render", "the relay packet quotes a Turn accepted after the current input");
        }
      }
      const existing = held?.packets.get(packet.id)?.packet ?? fresh.get(packet.id);
      if (existing !== undefined && existing.body.sha256 !== digest) throw prepareFailed("render_mismatch", "a relay packet with this identity holds another text");
      if (existing !== undefined) continue;
      fresh.set(packet.id, packet); packets.push({ runId: write.runId, packet, body: write.body });
    }
    const known = (packetId: string): boolean => fresh.has(packetId) || held?.packets.has(packetId) === true;
    const deliveries = new Map<string, DeliveryRecord>();
    for (const write of rows.deliveries ?? []) {
      if (write.kind === "insert") {
        const record = asRender(() => parseDeliveryRecord(write.record), "the relay delivery is invalid");
        runOf(record.runId, "a relay delivery");
        if (record.outcome.kind !== "in_flight") throw prepareFailed("render", "a relay delivery starts in flight");
        if (deliveries.has(record.runId) || held?.deliveries.has(record.runId) === true) throw prepareFailed("storage", "this Turn already has a relay delivery");
        if (!known(record.packetId)) throw prepareFailed("render", "a relay delivery names a packet that is not kept");
        deliveries.set(record.runId, record);
        continue;
      }
      const outcome = parseDeliveryOutcome(write.outcome);
      if (outcome.kind === "in_flight") throw new SessionError("INVALID_TRANSITION", "a delivery never goes back in flight");
      runOf(write.runId, "a relay delivery outcome");
      const stored = deliveries.get(write.runId) ?? held?.deliveries.get(write.runId);
      if (stored === undefined) throw new SessionError("INVALID_DATA", "a delivery outcome names a Turn without a delivery");
      const from = stored.outcome.kind as DeliveryStatus;
      if (!DELIVERY_TRANSITIONS[from].includes(outcome.kind)) throw new SessionError("INVALID_TRANSITION", "illegal delivery transition " + from + " → " + outcome.kind);
      deliveries.set(write.runId, { ...stored, outcome });
    }
    return { packets, deliveries: [...deliveries.values()] };
  }
  /** Every packet a relay state of the commit newly names is kept for the conversation. */
  private checkPacketReferences(held: Held | null, before: Conversation | null, changes: Mutation, fresh: readonly StoredPacket[]): void {
    const wanted = new Set<string>();
    for (const write of changes.bindings ?? []) {
      const relay = write.row.binding.relay;
      if (relay === undefined) continue;
      const was = before?.nativeBindings?.[write.row.ordinal]?.relay, had = was === undefined ? [] : packetsOf(was);
      for (const packetId of packetsOf(relay)) if (!had.includes(packetId)) wanted.add(packetId);
    }
    for (const write of changes.runs ?? []) {
      const named = write.row.facts.relay?.packetId;
      if (named === undefined || named === null) continue;
      if (before?.runs[write.row.ordinal]?.relay?.packetId !== named) wanted.add(named);
    }
    for (const packetId of wanted) if (held?.packets.has(packetId) !== true && !fresh.some(stored => stored.packet.id === packetId))
      throw new SessionError("INVALID_DATA", "a relay state names a packet this conversation does not keep");
  }
  /** The deliveries of the Turns on the current path, in their order. */
  private deliveriesOf(held: Held): DeliveryRecord[] {
    return [...held.deliveries.values()].filter(record => held.runs.has(record.runId)).sort((left, right) => (held.runs.get(left.runId)?.ordinal ?? 0) - (held.runs.get(right.runId)?.ordinal ?? 0) || (left.runId < right.runId ? -1 : 1));
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Turns and items
  // ---------------------------------------------------------------------------------------------------------------------

  /** Every item of a Turn, whole: from memory for a Turn not finished, from its lines for a finished one. */
  private allItems(held: Held, run: ConversationRun): readonly HeldItem[] {
    if (run.items !== undefined) return run.items;
    const cached = this.turnCache.get(run.id);
    if (cached !== undefined) { this.turnCache.delete(run.id); this.turnCache.set(run.id, cached); return cached.items; }
    const span = held.runs.get(run.id)?.span ?? null;
    let items: HeldItem[] = [];
    if (span !== null) {
      try { items = readRunItems(held.paths.main, run.id, span); } catch (error) { throw storageFailure(error); }
    }
    const bytes = 512 + items.reduce((total, item) => total + item.textBytes + 256, 0);
    this.turnCache.set(run.id, { items, bytes }); this.turnCacheBytes += bytes;
    for (const [key, value] of this.turnCache) { if (this.turnCacheBytes <= TURN_CACHE_BYTES || key === run.id) break; this.turnCache.delete(key); this.turnCacheBytes -= value.bytes; }
    return items;
  }
  private heldOfRun(runId: RunId): { held: Held; run: ConversationRun } | null {
    const id = this.runOwner.get(runId);
    if (id === undefined) return null;
    const held = this.entry(id), place = held.runs.get(runId);
    const run = place === undefined ? undefined : held.conversation.runs[place.ordinal];
    return run === undefined ? null : { held, run };
  }
  /** An item as a page carries it: a body longer than `inline` left out, and said so. */
  private paged(item: HeldItem, inline: number): { readonly item: HeldItem; readonly bytes: number } {
    const json = utf8Length(JSON.stringify(item.fields)), bodyOmitted = json > inline, textOmitted = item.textBytes > inline;
    if (!bodyOmitted && !textOmitted) return { item, bytes: ROW_BYTES + json + item.textBytes };
    return { item: { ...item, ...(bodyOmitted ? { fields: emptyFields(item.type), bodyOmitted: true as const } : {}), ...(textOmitted ? { text: [], textOmitted: true as const } : {}) },
      bytes: ROW_BYTES + (bodyOmitted ? 0 : json) + (textOmitted ? 0 : item.textBytes) };
  }
  private deferredOf(items: readonly HeldItem[]): DeferredWork | undefined {
    if (items.length <= PAGE.deferredAfter) return undefined;
    let best: { start: number; end: number; work: number } | undefined, start = -1, work = 0;
    const close = (end: number): void => { if (start >= 0 && work > PAGE.deferredAfter && (best === undefined || work > best.work)) best = { start, end, work }; start = -1; work = 0; };
    items.forEach((item, index) => {
      const action = WORK.has(item.type), done = item.status === "completed" && (action || item.type === "reasoning");
      if (!done) { close(index - 1); return; }
      if (start < 0) start = index;
      if (action) work++;
    });
    close(items.length - 1);
    if (best === undefined) return undefined;
    const chosen = best as { start: number; end: number; work: number };
    const from = chosen.start + PAGE.deferredKeep, to = chosen.end - PAGE.deferredKeep;
    return to < from ? undefined : { fromSeq: items[from]!.seq, toSeq: items[to]!.seq, count: to - from + 1 };
  }
  private turn(held: Held, ordinal: number, inline: number, fold: boolean): { readonly turn: TurnItems; readonly bytes: number } {
    const run = held.conversation.runs[ordinal]!, row = runRowOf(held.id, run), all = this.allItems(held, run), deferred = fold ? this.deferredOf(all) : undefined;
    let bytes = utf8Length(canonicalJson(row.facts));
    const items: HeldItem[] = [];
    for (const item of all) {
      if (deferred !== undefined && item.seq >= deferred.fromSeq && item.seq <= deferred.toSeq) continue;
      const page = this.paged(item, inline); items.push(page.item); bytes += page.bytes;
    }
    return { turn: { run: row, items, ...(deferred === undefined ? {} : { deferred }) }, bytes };
  }
  private collect(held: Held, below: number, turns: number, budget: number): TurnWindow {
    const found: TurnItems[] = [];
    let bytes = 0;
    for (let ordinal = below - 1; ordinal >= 0 && found.length < turns; ordinal--) {
      const turn = this.turn(held, ordinal, PAGE.itemInlineBytes, true);
      found.push(turn.turn); bytes += turn.bytes;
      if (bytes >= budget) break;
    }
    found.reverse();
    const oldest = found[0]?.run.ordinal ?? below, lastSeq = held.conversation.lastSeq;
    return { turns: found, older: oldest > 0 ? encodeTurnCursor({ ordinal: oldest, lastSeq }) : null, bytes, lastSeq };
  }

  head(id: SessionId): HeadRow {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), conversation = held.conversation;
    return { id, version: conversation.version, lastSeq: conversation.lastSeq, format: CONVERSATION_FORMAT, status: conversation.status, epoch: conversation.epoch, activeRunId: conversation.activeRunId,
      pendingSwitchId: conversation.pendingSwitchId, kept: conversation.retained !== undefined, title: held.title, runCount: conversation.runs.length, updatedAt: held.updatedAt, deletedAt: null, lastError: null,
      head: headJsonOf(conversation) };
  }
  window(id: SessionId, options: { readonly turns?: number; readonly bytes?: number } = {}): TurnWindow {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id);
    return this.collect(held, held.conversation.runs.length, counted(options.turns, PAGE.windowTurns, "turns"), positive(options.bytes, PAGE.windowBytes, "bytes"));
  }
  older(id: SessionId, before: TurnCursor, options: { readonly turns?: number; readonly bytes?: number } = {}): TurnWindow {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), cursor = decodeTurnCursor(before);
    if (cursor.ordinal > held.conversation.runs.length) return invalid("INVALID_CURSOR", "the cursor names a Turn this conversation does not have");
    return this.collect(held, cursor.ordinal, counted(options.turns, PAGE.olderTurns, "turns"), positive(options.bytes, PAGE.windowBytes, "bytes"));
  }
  turnAt(id: SessionId, ordinal: number, options: ReadOptions = {}): TurnItems | null {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id);
    wholeNumber(ordinal, "the Turn's ordinal");
    if (ordinal >= held.conversation.runs.length) return null;
    return this.turn(held, ordinal, options.inlineBytes ?? PAGE.itemInlineBytes, false).turn;
  }
  items(runId: RunId, afterSeq: number, limit: number, options: ReadOptions = {}): ItemPage {
    this.assertOwner();
    const count = counted(limit, 1, "limit"), after = wholeNumber(afterSeq, "the place after which items are read"), found = this.heldOfRun(runId);
    if (found === null) return { items: [], next: null };
    const inline = options.inlineBytes ?? PAGE.itemInlineBytes, all = this.allItems(found.held, found.run).filter(item => item.seq > after);
    const page = all.slice(0, count).map(item => this.paged(item, inline).item);
    return { items: page, next: all.length > count ? page[page.length - 1]!.seq : null };
  }
  text(runId: RunId, itemSeq: number, range: { readonly from: number; readonly to?: number } = { from: 0 }): TextRange {
    this.assertOwner();
    wholeNumber(itemSeq, "the item's place");
    const found = this.heldOfRun(runId), item = found === null ? undefined : this.allItems(found.held, found.run).find(entry => entry.seq === itemSeq);
    if (item === undefined) return invalid("ITEM_NOT_FOUND", "the item was not found");
    const buffer = Buffer.from(item.text.join(""), "utf8"), total = buffer.length;
    const wantFrom = Math.min(wholeNumber(range.from, "the range's start"), total), wantTo = Math.min(range.to === undefined ? total : wholeNumber(range.to, "the range's end"), total);
    if (wantTo < wantFrom) return invalid("INVALID_INPUT", "the range ends before it starts");
    if (total === 0 || wantFrom >= total) return { text: "", from: total, to: total, total };
    const start = boundary(buffer, wantFrom), end = Math.max(start, boundary(buffer, wantTo));
    return { text: buffer.subarray(start, end).toString("utf8"), from: start, to: end, total };
  }

  /**
   * The finished messages and segments that hold the words, newest first: a scan of the files (`via: "scan"`; there is no index). In one conversation a hit's id is its
   * line's place in the file, so a page goes on from the last hit whatever is written meanwhile; across conversations it is the hit's place in the scan.
   */
  search(query: string, scope: { readonly sessionId?: SessionId; readonly after?: number; readonly limit: number }): readonly SearchHit[] {
    this.assertOwner();
    const limit = counted(scope.limit, 1, "limit"), words = String(query).trim().toLowerCase();
    if (words === "") return [];
    const after = scope.after === undefined ? undefined : wholeNumber(scope.after, "the search's cursor");
    const hits: SearchHit[] = [];
    if (scope.sessionId !== undefined) {
      const held = this.entry(scope.sessionId);
      for (const hit of this.scan(held, words)) {
        const id = hit.offset + 1;
        if (after !== undefined && id >= after) continue;
        hits.push({ id, sessionId: held.id, runId: hit.runId, ordinal: hit.ordinal, itemSeq: hit.seq, type: hit.type, via: "scan" });
        if (hits.length >= limit) break;
      }
      return hits;
    }
    let place = 0;
    const rows = [...this.index.rows.values()].sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1));
    for (const row of rows) {
      let held: Held;
      try { held = this.entry(row.id); } catch { continue; }
      for (const hit of this.scan(held, words)) {
        place++;
        const id = Number.MAX_SAFE_INTEGER - place;
        if (after !== undefined && id >= after) continue;
        hits.push({ id, sessionId: held.id, runId: hit.runId, ordinal: hit.ordinal, itemSeq: hit.seq, type: hit.type, via: "scan" });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }
  /**
   * The finished messages and segments of the current path that hold the words, newest first: the file read from its end a piece at a time, so a search that has its page stops
   * reading (the last line of an item is the one that counts, and it is the first met from the end).
   */
  private *scan(held: Held, words: string): Generator<{ readonly offset: number; readonly runId: RunId; readonly ordinal: number; readonly seq: number; readonly type: ItemType }> {
    const seen = new Set<string>();
    let reader: Generator<{ readonly offset: number; readonly text: string }>;
    try { reader = linesBackward(held.paths.main); } catch (error) { throw storageFailure(error); }
    for (const line of reader) {
      if (!line.text.startsWith('{"type":"item"')) continue;
      let value: { runId?: unknown; item?: { seq?: unknown; type?: unknown; status?: unknown; text?: unknown } };
      try { value = JSON.parse(line.text) as typeof value; } catch { continue; }
      const item = value.item, runId = String(value.runId) as RunId, key = runId + "\u0000" + String(item?.seq);
      if (item === undefined || seen.has(key)) continue;
      seen.add(key);
      if (!SEARCHED.has(String(item.type)) || !itemFinished(String(item.status)) || typeof item.text !== "string" || item.text === "") continue;
      const ordinal = held.runs.get(runId)?.ordinal;
      if (ordinal === undefined || !item.text.toLowerCase().includes(words)) continue;
      yield { offset: line.offset, runId, ordinal, seq: Number(item.seq), type: item.type as ItemType };
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The list, and what the Runtime asks of every conversation
  // ---------------------------------------------------------------------------------------------------------------------

  list(query: SessionListQuery = {}): SessionListPage {
    this.assertOwner();
    const limit = counted(query.limit, PAGE.sessions, "limit"), after = query.after === undefined ? undefined : decodeListCursor(query.after);
    const rows = [...this.index.rows.values()].sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .filter(row => after === undefined || row.updatedAt < after.updatedAt || (row.updatedAt === after.updatedAt && row.id > after.id));
    const page = rows.slice(0, limit).map((row): SessionListRow => ({ id: row.id, title: row.title, status: row.status, workspace: row.workspace, selection: row.selection, updatedSeq: row.lastSeq,
      updatedAt: row.updatedAt, activeRunId: row.activeRunId, runCount: row.runCount, ...(row.parent === undefined ? {} : { parent: row.parent }) }));
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > limit && last !== undefined ? encodeListCursor(last.updatedAt, last.id) : null };
  }
  changedFiles(id: SessionId): readonly string[] {
    const files: string[] = [];
    for (const place of this.edits(id)) {
      const changes = (this.item(place.runId, place.seq)?.fields as { readonly changes?: readonly { readonly path?: unknown }[] } | undefined)?.changes ?? [];
      for (const change of changes) if (typeof change.path === "string" && change.path !== "" && !files.includes(change.path)) files.push(change.path);
    }
    return files;
  }
  changedSince(id: SessionId, after: number): { readonly files: readonly string[]; readonly through: number } {
    const places = this.edits(id), files: string[] = [];
    for (const place of places.slice(Math.max(0, after))) {
      const changes = (this.item(place.runId, place.seq)?.fields as { readonly changes?: readonly { readonly path?: unknown }[] } | undefined)?.changes ?? [];
      for (const change of changes) if (typeof change.path === "string" && change.path !== "" && !files.includes(change.path)) files.push(change.path);
    }
    return { files, through: places.length };
  }
  delegatedBy(id: SessionId): readonly SessionId[] {
    this.assertOwner();
    return [...this.index.rows.values()].filter(row => row.parent?.parentId === id).sort((left, right) => left.updatedAt - right.updatedAt).map(row => row.id);
  }
  listKept(): readonly SessionId[] { this.assertOwner(); return [...this.index.rows.values()].filter(row => row.kept).map(row => row.id); }
  unfinished(): readonly SessionId[] { this.assertOwner(); return [...this.index.rows.values()].filter(row => row.unfinished).map(row => row.id).sort(); }
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId> {
    this.assertOwner();
    const owners = new Map<string, SessionId>();
    for (const row of this.index.rows.values()) for (const binding of row.bindings) {
      if (binding.harnessId !== harnessId || binding.controlId !== controlId || (binding.status !== "ready" && binding.status !== "unconfirmed") || binding.opensNew === true) continue;
      if (owners.has(binding.checkpoint) && owners.get(binding.checkpoint) !== row.id) invalid("INVALID_DATA", "one native session is held by two Sessions");
      owners.set(binding.checkpoint, row.id);
    }
    return owners;
  }
  noticeShown(id: SessionId, print: string): boolean { this.assertOwner(); sessionId(id); return this.entry(id).prints.has(print); }
  startupSamples(perEntry: number): readonly StartupSample[] {
    this.assertOwner();
    const count = counted(perEntry, 1, "perEntry"), byEntry = new Map<string, StartupSample[]>();
    for (const row of this.index.rows.values()) for (const sample of row.samples) {
      const key = sample.harnessId + "\u0000" + sample.controlId, list = byEntry.get(key) ?? [];
      list.push(sample); byEntry.set(key, list);
    }
    return [...byEntry.keys()].sort().flatMap(key => byEntry.get(key)!.sort((left, right) => right.preparingAt - left.preparingAt).slice(0, count));
  }
  contentReferences(): ReadonlySet<string> {
    this.assertOwner();
    const all = new Set<string>();
    for (const row of this.index.rows.values()) { try { for (const id of this.references(row.id)) all.add(id); } catch { /* a file that cannot be read keeps nothing from here */ } }
    return all;
  }
  /** The content ids the conversation mentions: the details and outputs of its items, the attachments of its Turns and of the history it quoted (from what each Turn's end recorded). */
  references(id: SessionId): ReadonlySet<string> {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), found = new Set<string>();
    for (const place of held.origin) for (const ref of place.refs) found.add(ref);
    for (const run of held.conversation.runs) {
      for (const attachment of run.attachments ?? []) found.add(attachment.id);
      for (const ref of this.factsOf(held, run).refs) found.add(ref);
    }
    return found;
  }
  /** A Turn's facts: recorded at its end, or worked out from the items memory holds while it goes on. */
  private factsOf(held: Held, run: ConversationRun): TurnLineFacts { return run.items !== undefined ? factsOfItems(run.items) : held.runs.get(run.id)?.facts ?? noFacts(); }
  /** What a packet's ledger counts of a finished Turn of the path, as its end recorded it; null when it recorded none (or the Turn is not finished). */
  relayCounts(id: SessionId, runId: RunId): TurnRelayCounts | null { this.assertOwner(); sessionId(id); return this.entry(id).runs.get(runId)?.facts.relay ?? null; }
  originHistory(id: SessionId): readonly OriginHistoryRow[] {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id);
    try { return readOrigin(held.paths.main, id, held.origin); } catch (error) { throw storageFailure(error); }
  }
  harnessIds(id: SessionId): readonly string[] { this.assertOwner(); sessionId(id); return [...new Set(this.entry(id).conversation.runs.map(run => run.selection.harnessId))].sort(); }
  runOrdinal(id: SessionId, runId: RunId): number | null { this.assertOwner(); sessionId(id); return this.entry(id).runs.get(runId)?.ordinal ?? null; }

  /** A page of a conversation's events after `afterSeq`, from the event log beside its file. */
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    this.assertOwner(); sessionId(id);
    const count = pageLimit(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    const held = this.entry(id), lastSeq = held.conversation.lastSeq;
    if (afterSeq > lastSeq) throw new SessionError("INVALID_CURSOR", "event cursor is ahead of persistent history");
    if (afterSeq === lastSeq) return [];
    const places = this.eventPlaces(held);
    let low = 0, high = places.seqs.length;
    while (low < high) { const middle = (low + high) >> 1; if (places.seqs[middle]! <= afterSeq) low = middle + 1; else high = middle; }
    if (low >= places.seqs.length) return [];
    let last = low, bytes = 0;
    while (last < places.seqs.length && last - low < count && (last === low || bytes + places.lengths[last]! <= PAGE_BYTES)) { bytes += places.lengths[last]! + 1; last++; }
    const from = places.offsets[low]!, to = places.offsets[last - 1]! + places.lengths[last - 1]!;
    const result: SessionEvent[] = [];
    for (const line of lines(readRange(held.paths.events, from, to - from))) {
      try {
        const value = JSON.parse(line.text) as { seq: number; type: string; sessionId: string; ownerGeneration: number; timestamp: string; data: Record<string, unknown> };
        result.push({ type: value.type, data: value.data, sessionId: value.sessionId as SessionId, seq: value.seq, ownerGeneration: value.ownerGeneration, timestamp: value.timestamp });
      } catch { /* a line cut short is passed over: the log is a diagnostic record */ }
    }
    return result;
  }
  private eventPlaces(held: Held): EventPlaces {
    if (held.events !== null) return held.events;
    const places: EventPlaces = { seqs: [], offsets: [], lengths: [], size: 0 };
    if (existsSync(held.paths.events)) {
      const buffer = readFileSync(held.paths.events);
      for (const line of lines(buffer)) {
        const found = /^\{"seq":(\d+)/u.exec(line.text.slice(0, 32));
        if (found === null || line.torn) continue;
        places.seqs.push(Number(found[1])); places.offsets.push(line.offset); places.lengths.push(line.length);
      }
      places.size = buffer.length;
    }
    held.events = places;
    return places;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The small reads a conversation's view is made with (src/web/turn-view.ts, conversation-routes.ts)
  // ---------------------------------------------------------------------------------------------------------------------

  runAt(id: SessionId, ordinal: number): RunRow | null { this.assertOwner(); sessionId(id); const run = this.entry(id).conversation.runs[ordinal]; return run === undefined ? null : runRowOf(id, run); }
  runById(runId: RunId): RunRow | null { this.assertOwner(); const found = this.heldOfRun(runId); return found === null ? null : runRowOf(found.held.id, found.run); }
  lastDispatched(id: SessionId, harnessId: string, controlId: string, options: { readonly native?: boolean } = {}): RunRow | null {
    this.assertOwner(); sessionId(id);
    const runs = this.entry(id).conversation.runs;
    for (let index = runs.length - 1; index >= 0; index--) {
      const run = runs[index]!;
      if (run.selection.harnessId === harnessId && run.selection.controlId === controlId && isDispatched(run) && (options.native !== true || run.selection.provider === undefined)) return runRowOf(id, run);
    }
    return null;
  }
  dispatchedBefore(id: SessionId, harnessId: string, controlId: string, ordinal: number): boolean {
    this.assertOwner(); sessionId(id);
    return this.entry(id).conversation.runs.slice(0, Math.max(0, ordinal)).some(run => run.selection.harnessId === harnessId && run.selection.controlId === controlId && isDispatched(run));
  }
  bindings(id: SessionId): readonly NativeSessionBinding[] { this.assertOwner(); sessionId(id); return this.entry(id).conversation.nativeBindings ?? []; }
  lastSwitch(id: SessionId): PublicSwitch | null { this.assertOwner(); sessionId(id); return this.entry(id).conversation.switches.at(-1) ?? null; }
  origin(id: SessionId): SessionOrigin | null {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), stored = held.conversation.origin;
    if (stored === undefined) return null;
    const quoted = originFromRows(stored, this.originHistory(id));
    if (quoted !== null || stored.kind !== "fork") return quoted;
    return { kind: "fork", sessionId: stored.sessionId, throughRunId: stored.throughRunId, history: [] };
  }
  item(runId: RunId, seq: number): ItemRow | null {
    this.assertOwner();
    const found = this.heldOfRun(runId), item = found === null ? undefined : this.allItems(found.held, found.run).find(entry => entry.seq === seq);
    return item === undefined ? null : itemRowOf(item);
  }
  finalSeq(runId: RunId): number | null {
    this.assertOwner();
    const found = this.heldOfRun(runId);
    if (found === null) return null;
    const items = this.allItems(found.held, found.run);
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (BESIDE.has(item.type)) continue;
      return item.type === "assistant_message" ? item.seq : null;
    }
    return null;
  }
  plainTools(runId: RunId): readonly ItemRow[] {
    this.assertOwner();
    const found = this.heldOfRun(runId);
    return found === null ? [] : this.allItems(found.held, found.run).filter(item => item.type === "tool" && item.itemId.startsWith("tool:")).map(itemRowOf);
  }
  runSummary(id: SessionId): RunSummary {
    this.assertOwner(); sessionId(id);
    const runs = this.entry(id).conversation.runs, ran = new Map<string, { harnessId: string; controlId: string; turns: number; first: number }>();
    let open = 0, unknown = 0, unclosed = false, branchable: RunSummary["branchable"] = null;
    runs.forEach((run, ordinal) => {
      if (["queued", "preparing", "running", "settling"].includes(run.status)) open++;
      if (run.status === "unknown") { unknown++; if (run.cleanup?.closed !== true) unclosed = true; }
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") branchable = { runId: run.id, ordinal };
      if (isDispatched(run) && runFinished(run.status)) {
        const on = run.relay?.executedOn ?? run.executedOn ?? null, harnessId = on?.harnessId ?? run.selection.harnessId, controlId = on?.controlId ?? run.selection.controlId, key = harnessId + "\u0000" + controlId;
        const entry = ran.get(key) ?? { harnessId, controlId, turns: 0, first: ordinal };
        entry.turns++; ran.set(key, entry);
      }
    });
    return { runs: runs.length, open, unknown, unclosed, branchable, ran: [...ran.values()].sort((left, right) => left.first - right.first).map(({ harnessId, controlId, turns }) => ({ harnessId, controlId, turns })) };
  }
  edits(id: SessionId): readonly EditRef[] {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), found: EditRef[] = [];
    held.conversation.runs.forEach((run, ordinal) => { for (const seq of this.factsOf(held, run).edits) found.push({ ordinal, runId: run.id, harnessId: run.selection.harnessId, seq }); });
    return found;
  }
  latestPlan(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: ItemRow } | null {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), runs = held.conversation.runs;
    for (let ordinal = runs.length - 1; ordinal >= 0; ordinal--) {
      const run = runs[ordinal]!, seq = this.factsOf(held, run).plan;
      if (seq === null) continue;
      // Only the Turn that has it is read.
      const item = this.allItems(held, run).find(entry => entry.seq === seq);
      if (item !== undefined) return { ordinal, runId: run.id, harnessId: run.selection.harnessId, row: itemRowOf(item) };
    }
    return null;
  }

  /**
   * The wrap-up of the conversation's latest finished Turn (its `recap`, from the Hub's tool `hub_wrap_up`), with that Turn; null when that Turn has none. Only that Turn is read.
   * An older Turn's wrap-up is not the conversation's latest: a Turn that ended without one has none.
   */
  latestRecap(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: ItemRow } | null {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), runs = held.conversation.runs;
    for (let ordinal = runs.length - 1; ordinal >= 0; ordinal--) {
      const run = runs[ordinal]!;
      if (!runFinished(run.status)) continue;
      const seq = this.factsOf(held, run).recap;
      const item = seq === undefined || seq === null ? undefined : this.allItems(held, run).find(entry => entry.seq === seq);
      return item === undefined ? null : { ordinal, runId: run.id, harnessId: run.selection.harnessId, row: itemRowOf(item) };
    }
    return null;
  }

  /** The conversation in the old whole shape (`fromItems` over its Turns), for the tests that compare readers with it. Nothing in `src/` reads a conversation this way. */
  snapshot(id: SessionId): SessionSnapshot {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), conversation = held.conversation, runs: PublicRun[] = [], messages: PublicMessage[] = [];
    for (const run of conversation.runs) {
      const made = fromItems({ row: runRowOf(id, run), items: [...this.allItems(held, run)], contentRefs: [] });
      runs.push(made.run); messages.push(...made.messages);
    }
    messages.sort((left, right) => left.seq - right.seq);
    const origin = conversation.origin === undefined ? null : originFromRows(conversation.origin, this.originHistory(id));
    const bindings = conversation.nativeBindings ?? [];
    return deepFreeze({ schemaVersion: 13 as const, id: conversation.id, version: conversation.version, lastSeq: conversation.lastSeq, epoch: conversation.epoch, status: conversation.status, configuration: conversation.configuration,
      selection: conversation.selection, activeRunId: conversation.activeRunId, pendingSwitchId: conversation.pendingSwitchId, runs, messages, switches: conversation.switches, commands: conversation.commands,
      ...(bindings.length === 0 ? {} : { nativeBindings: bindings }), ...(origin === null ? {} : { origin }), ...(conversation.retainNative === undefined ? {} : { retainNative: conversation.retainNative }),
      ...(conversation.retained === undefined ? {} : { retained: conversation.retained }), ...(conversation.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: conversation.relayRecoveryFailed }) }) as SessionSnapshot;
  }
  /** Where a conversation's file is (for tools and tests). */
  fileOf(id: SessionId): string { this.assertOwner(); sessionId(id); return this.entry(id).paths.main; }

  // ---------------------------------------------------------------------------------------------------------------------
  // Deleting, and the relay's ports
  // ---------------------------------------------------------------------------------------------------------------------

  /** Deletes a closed conversation that keeps no native process: its files move to `trash/` (nothing is erased), and its create key is freed. */
  deleteSession(id: SessionId): void {
    this.assertOwner(); sessionId(id);
    this.transaction(() => {
      const held = this.entry(id), state = held.conversation;
      if (state.status !== "closed" || state.retained !== undefined) throw new SessionError("SESSION_BUSY", "only a closed conversation that keeps no native process is deleted");
      const trash = join(this.root, "trash", dirname(held.file));
      try {
        mkdirSync(trash, { recursive: true, mode: 0o700 });
        for (const path of [held.paths.main, held.paths.wip, held.paths.events, held.paths.index]) if (existsSync(path)) renameSync(path, join(trash, path.split("/").at(-1)!));
      } catch (error) { throw storageFailure(error); }
      this.held.delete(id); this.index.drop(id);
      if (held.header.createKey !== undefined) this.createKeys.delete(held.header.createKey);
      for (const runId of held.runs.keys()) { this.runOwner.delete(runId); this.turnCache.delete(runId); }
    });
  }
  relayDeliveries(id: SessionId): readonly DeliveryRecord[] { this.assertOwner(); sessionId(id); return this.deliveriesOf(this.entry(id)); }
  relayPackets(id: SessionId): readonly RelayPacket[] { this.assertOwner(); sessionId(id); return [...this.entry(id).packets.values()].map(entry => entry.packet); }
  relayPacket(id: SessionId, packetId: string): RelayPacket | null { this.assertOwner(); sessionId(id); return this.entry(id).packets.get(packetId)?.packet ?? null; }
  relayPacketBody(id: SessionId, bodySha256: string): string | null {
    this.assertOwner(); sessionId(id);
    const held = this.entry(id), place = held.bodies.get(bodySha256);
    if (place === undefined) return null;
    try { return readPacketBody(held.paths.main, place); } catch (error) { throw storageFailure(error); }
  }
  relayIndex(id: SessionId): readonly RelayIndexRow[] { this.assertOwner(); sessionId(id); this.entry(id); return []; }
  logHandoff(harnessId: string): { readonly record: HandoffRecord; readonly created: boolean } {
    this.assertOwner();
    const checked = parseHandoffRecord({ logSeq: 1, harnessId, firstAt: this.stamp().getTime() });
    const prior = this.handoffLog.find(row => row.harnessId === checked.harnessId);
    if (prior !== undefined) return { record: prior, created: false };
    const record: HandoffRecord = { logSeq: this.handoffLog.reduce((top, row) => Math.max(top, row.logSeq), 0) + 1, harnessId: checked.harnessId, firstAt: checked.firstAt };
    try { writeWhole(join(this.root, "relay-log.json"), JSON.stringify([...this.handoffLog, record]) + "\n"); } catch (error) { this.failed = storageFailure(error); throw this.failed; }
    this.handoffLog = [...this.handoffLog, record];
    return { record, created: true };
  }
  handoffs(): readonly HandoffRecord[] { this.assertOwner(); return this.handoffLog; }
  handoffUsed(logSeq: number): boolean { this.assertOwner(); return [...this.index.rows.values()].some(row => row.handoffs.includes(logSeq)); }
  setPref(key: RelayPrefKey, value: string): void {
    this.assertOwner();
    const pref = parseRelayPref(key, value), next = { ...this.prefs, [pref.key]: pref.value };
    try { writeWhole(join(this.root, "relay-prefs.json"), JSON.stringify(next) + "\n"); } catch (error) { this.failed = storageFailure(error); throw this.failed; }
    this.prefs = next;
  }
  relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>> { this.assertOwner(); return { ...this.prefs }; }
  private readHandoffs(): HandoffRecord[] {
    const value = readJson(join(this.root, "relay-log.json"));
    return Array.isArray(value) ? value.map(row => parseHandoffRecord(row)) : [];
  }
  private readPrefs(): Partial<Record<RelayPrefKey, string>> {
    const value = readJson(join(this.root, "relay-prefs.json")), prefs: Partial<Record<RelayPrefKey, string>> = {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) return prefs;
    for (const [key, stored] of Object.entries(value as Record<string, unknown>)) {
      if (!(RELAY_PREF_KEYS as readonly string[]).includes(key) || typeof stored !== "string") continue;
      try { const pref = parseRelayPref(key as RelayPrefKey, stored); prefs[pref.key] = pref.value; } catch { /* a value the contract no longer lists is not read */ }
    }
    return prefs;
  }

  close(): void {
    if (this.closed) return;
    let failure: unknown = null;
    try { this.flushSidecars(); } catch (error) { failure = error; }
    try { this.index.close(); } catch (error) { failure ??= error; }
    try {
      const owner: OwnerFile | null = readOwner(this.root);
      if (owner !== null && owner.generation === this.generation && owner.token === this.token) writeOwner(this.root, { ...owner, active: false });
    } catch (error) { failure ??= error; }
    this.closed = true;
    this.held.clear(); this.turnCache.clear();
    try { if (this.owner.isOpen) this.owner.close(); } catch (error) { failure ??= error; }
    if (!this.owner.isOpen) activeRoots.delete(this.root);
    if (failure !== null) throw failure;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Under the calls
  // ---------------------------------------------------------------------------------------------------------------------

  private stamp(): Date {
    let at: Date;
    try { at = this.clock(); } catch { throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date"); }
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new SessionError("INVALID_INPUT", "clock did not provide a valid Date");
    return at;
  }
  /** One commit at a time (none inside another); the owner is confirmed before and after. */
  private transaction<T>(work: () => T): T {
    this.assertOwner();
    if (this.inTransaction) throw new SessionError("INVALID_INPUT", "a transaction cannot begin inside another");
    this.inTransaction = true;
    try { const result = work(); return result; } finally { this.inTransaction = false; }
  }
}
