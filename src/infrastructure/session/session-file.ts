import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONVERSATION_FORMAT,
  type Conversation, type HeadJson, type HeldItem, type ItemFields, type OriginHistoryRow, type RunRow, type StoredOrigin, type TurnRelayCounts,
} from "../../contracts/conversation.js";
import type { ItemStatus, ItemType } from "../../contracts/protocol.js";
import type { DeliveryRecord, RelayPacket } from "../../contracts/relay.js";
import {
  SessionError,
  type CommandId, type CommandRecord, type ForkedMessage, type HarnessSelection, type NativeSessionBinding, type PublicSwitch, type RetainedProcess, type RunId, type SessionConfiguration, type SessionId,
  type SessionSnapshot, type SwitchId,
} from "../../contracts/session.js";
import { conversationRunOf } from "../../contexts/session/domain/run-row.js";
import { listMarksOf, utf8Length } from "./rows.js";

/*
 * A conversation as one append-only JSONL file (Pi's way of keeping a session, docs/decisions/LOG.md 2026-11-12): THE FILE IS THE FACT. Everything else the store keeps (the
 * list cache, the byte ranges of the Turns, the event log beside it) is worked out again from the files.
 *
 *   <root>/sessions/<slug of the workspace>/<timestamp>_<conversation id>.jsonl          the conversation: a header line, then one completed fact per line
 *   <root>/sessions/<slug of the workspace>/<timestamp>_<conversation id>.wip.jsonl      what a Turn in progress has not finished (removed when no Turn is open)
 *   <root>/sessions/<slug of the workspace>/<timestamp>_<conversation id>.events.jsonl   the commits' events, a diagnostic record beside the facts (not their source)
 *
 * The first line is the header (`type: "session"`). Every line after it has `type`, `id` (8 hex digits), `parentId` (the line it follows; null for the first), `timestamp`
 * and `seq` (the conversation's event cursor after the commit that wrote it). The lines form a tree by `parentId`; what the conversation is now is the path from the last line
 * (the leaf) to the root, so a line that is not on it takes no part (the lines are written as one chain today; a branch inside a conversation is a line written under an
 * older one). A line is a whole fact and is never changed: a fact that changes later is a new line that says it again (a Run's end, an item's revision, a binding's state).
 * A line of a type this build does not know is passed over and kept.
 */

export const SESSION_FILE_VERSION = 1;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "unknown"]);
export const runFinished = (status: string): boolean => TERMINAL.has(status);
const ITEM_TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "declined", "cancelled", "unknown"]);
export const itemFinished = (status: string): boolean => ITEM_TERMINAL.has(status);

export interface ParentSession { readonly id: string; readonly path: string; readonly entryId: string | null }
export interface SessionHeader {
  readonly type: "session"; readonly version: number; readonly id: string; readonly timestamp: string; readonly cwd: string;
  readonly createKey?: string; readonly parentSession?: ParentSession;
}
/** The part of a conversation's head that changes and is remembered (a `head` line is written when it changes). */
export interface HeadState {
  readonly status: SessionSnapshot["status"]; readonly epoch: number; readonly activeRunId: RunId | null; readonly pendingSwitchId: SwitchId | null;
  readonly configuration: SessionConfiguration; readonly selection: HarnessSelection;
  readonly retainNative?: true; readonly retained?: RetainedProcess; readonly relayRecoveryFailed?: number; readonly origin?: StoredOrigin;
  readonly delegation?: Conversation["delegation"]; readonly delegationsTold?: Conversation["delegationsTold"]; readonly taskBoard?: Conversation["taskBoard"]; readonly taskBoardTold?: number; readonly taskEditsTold?: Conversation["taskEditsTold"]; readonly parentWordsTold?: number;
  /**
   * What the user named and marked (2026-11-14): the name, the archive mark, the pin, the moment a reminder puts it aside until, when it was deleted; and the name its
   * Harness gave it. A file written before has none of these, and its conversation is then neither named nor marked nor deleted.
   */
  readonly userTitle?: string; readonly archived?: true; readonly pinned?: true; readonly snoozedUntil?: number; readonly deletedAt?: number; readonly harnessTitle?: string;
}
type UserMarks = Pick<HeadState, "userTitle" | "archived" | "pinned" | "snoozedUntil" | "deletedAt" | "harnessTitle">;
/** The user's names and marks of a conversation (and the name its Harness gave it), as the head line keeps them and the conversation carries them. */
const userMarks = (from: { readonly [Key in keyof UserMarks]?: UserMarks[Key] | undefined }): UserMarks =>
  ({ ...(typeof from.userTitle === "string" ? { userTitle: from.userTitle } : {}), ...listMarksOf(from),
    ...(typeof from.deletedAt === "number" && Number.isSafeInteger(from.deletedAt) ? { deletedAt: from.deletedAt } : {}), ...(typeof from.harnessTitle === "string" ? { harnessTitle: from.harnessTitle } : {}) });
/** A Run's row as a `turn` line holds it (the conversation's id is the file's). */
export type StoredRun = Omit<RunRow, "sessionId">;
/** An item as an `item` line holds it: the row with its whole text, without the counts (they are the text's). */
export interface StoredItem {
  readonly seq: number; readonly itemId: string; readonly type: ItemType; readonly status: ItemStatus; readonly startedAt: number | null; readonly endedAt: number | null;
  readonly parentId: string | null; readonly createdSeq: number | null; readonly fields: ItemFields; readonly text: string;
}
export interface StoredPacket { readonly runId: RunId; readonly packet: RelayPacket; readonly body: string }

export function headStateOf(conversation: Conversation): HeadState {
  return { status: conversation.status, epoch: conversation.epoch, activeRunId: conversation.activeRunId, pendingSwitchId: conversation.pendingSwitchId,
    configuration: conversation.configuration, selection: conversation.selection, ...(conversation.retainNative === undefined ? {} : { retainNative: conversation.retainNative }),
    ...(conversation.retained === undefined ? {} : { retained: conversation.retained }), ...(conversation.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: conversation.relayRecoveryFailed }),
    ...(conversation.origin === undefined ? {} : { origin: conversation.origin }), ...(conversation.delegation === undefined ? {} : { delegation: conversation.delegation }), ...(conversation.delegationsTold === undefined ? {} : { delegationsTold: conversation.delegationsTold }),
    ...(conversation.taskBoard === undefined ? {} : { taskBoard: conversation.taskBoard }), ...(conversation.taskBoardTold === undefined ? {} : { taskBoardTold: conversation.taskBoardTold }), ...(conversation.taskEditsTold === undefined ? {} : { taskEditsTold: conversation.taskEditsTold }), ...(conversation.parentWordsTold === undefined ? {} : { parentWordsTold: conversation.parentWordsTold }),
    ...userMarks(conversation) };
}
export function headJsonOf(conversation: Conversation): HeadJson {
  return { configuration: conversation.configuration, selection: conversation.selection, ...(conversation.retainNative === undefined ? {} : { retainNative: conversation.retainNative }),
    ...(conversation.retained === undefined ? {} : { retained: conversation.retained }), ...(conversation.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: conversation.relayRecoveryFailed }),
    ...(conversation.origin === undefined ? {} : { origin: conversation.origin }), ...(conversation.delegation === undefined ? {} : { delegation: conversation.delegation }), ...(conversation.delegationsTold === undefined ? {} : { delegationsTold: conversation.delegationsTold }),
    ...(conversation.taskBoard === undefined ? {} : { taskBoard: conversation.taskBoard }), ...(conversation.taskBoardTold === undefined ? {} : { taskBoardTold: conversation.taskBoardTold }), ...(conversation.taskEditsTold === undefined ? {} : { taskEditsTold: conversation.taskEditsTold }), ...(conversation.parentWordsTold === undefined ? {} : { parentWordsTold: conversation.parentWordsTold }),
    ...listMarksOf(conversation) };
}
export function storedItemOf(item: HeldItem, createdSeq: number | null): StoredItem {
  return { seq: item.seq, itemId: item.itemId, type: item.type, status: item.status, startedAt: item.startedAt, endedAt: item.endedAt, parentId: item.parentId, createdSeq,
    fields: item.fields, text: item.text.join("") };
}
export function heldItemOf(runId: RunId, stored: StoredItem): HeldItem {
  const text = typeof stored.text === "string" ? stored.text : "";
  return { runId, seq: stored.seq, itemId: stored.itemId, type: stored.type, status: stored.status, startedAt: stored.startedAt ?? null, endedAt: stored.endedAt ?? null,
    parentId: stored.parentId ?? null, createdSeq: stored.createdSeq ?? null, textBytes: utf8Length(text), textChunks: text === "" ? 0 : 1, fields: stored.fields, text: text === "" ? [] : [text] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the files are
// ---------------------------------------------------------------------------------------------------------------------

/** Pi's name for a working directory's folder (`--Users-me-project--`); a very long one keeps its start and a digest. */
export function workspaceSlug(cwd: string): string {
  const safe = "--" + cwd.replace(/^[/\\]/u, "").replace(/[/\\:\0]/gu, "-") + "--";
  if (Buffer.byteLength(safe, "utf8") <= 160) return safe;
  return "--" + cwd.replace(/^[/\\]/u, "").replace(/[/\\:\0]/gu, "-").slice(0, 96) + "-" + createHash("sha256").update(cwd).digest("hex").slice(0, 12) + "--";
}
export function fileStamp(at: Date): string { return at.toISOString().replace(/[:.]/gu, "-"); }
export interface SessionPaths { readonly main: string; readonly wip: string; readonly events: string; readonly index: string }
/** The files of a conversation from its main file's path (the cache of its fold is `.index.json`). */
export function pathsOf(main: string): SessionPaths {
  const base = main.endsWith(".jsonl") ? main.slice(0, -".jsonl".length) : main;
  return { main, wip: base + ".wip.jsonl", events: base + ".events.jsonl", index: base + ".index.json" };
}
export function isMainFile(name: string): boolean { return name.endsWith(".jsonl") && !name.endsWith(".wip.jsonl") && !name.endsWith(".events.jsonl"); }
export function sessionsDir(root: string): string { return join(root, "sessions"); }

// ---------------------------------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------------------------------

/** An entry's id: its place among the file's entries in hex, eight digits (unique in the file by construction). */
export function entryId(number: number): string { return number.toString(16).padStart(8, "0"); }
/** One line of a file as it is written: the fixed keys first, so a reader (or `grep`) finds them at the start. */
export function entryLine(type: string, id: string, parentId: string | null, timestamp: string, seq: number, rest: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ type, id, parentId, timestamp, seq, ...rest });
}
const HEAD_OF_LINE = /^\{"type":"([a-z_]+)","id":"([0-9a-f]{8})","parentId":(null|"[0-9a-f]{8}")/u;

/** The lines of a buffer with where each starts; a last line without its newline (a write cut short) is told as `torn`. */
export function* lines(buffer: Buffer, base = 0): Generator<{ readonly offset: number; readonly length: number; readonly text: string; readonly torn: boolean }> {
  let at = 0;
  while (at < buffer.length) {
    const end = buffer.indexOf(10, at);
    const stop = end < 0 ? buffer.length : end;
    if (stop > at) yield { offset: base + at, length: stop - at, text: buffer.toString("utf8", at, stop), torn: end < 0 };
    at = stop + 1;
  }
}
function parse(text: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(text); return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
/** Reads `length` bytes at `offset` of a file. */
export function readRange(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const got = readSync(fd, buffer, read, length - read, offset + read); if (got === 0) break; read += got; }
    return read === length ? buffer : buffer.subarray(0, read);
  } finally { closeSync(fd); }
}
/** The `seq` of the last whole line of an events file (0 when it has none): read from the end, a growing piece at a time. */
export function lastEventSeq(path: string): number {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let take = Math.min(size, 64 * 1024);
    while (take > 0) {
      const buffer = Buffer.alloc(take);
      readSync(fd, buffer, 0, take, size - take);
      const text = buffer.toString("utf8");
      const end = text.endsWith("\n") ? text.length - 1 : text.lastIndexOf("\n");
      if (end <= 0) { if (take === size) return 0; take = Math.min(size, take * 4); continue; }
      const start = text.lastIndexOf("\n", end - 1);
      if (start < 0 && take < size) { take = Math.min(size, take * 4); continue; }
      const found = /^\{"seq":(\d+)/u.exec(text.slice(start + 1, end));
      return found === null ? 0 : Number(found[1]);
    }
    return 0;
  } finally { closeSync(fd); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a conversation
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A Run as the file says it: its latest row, and the items of a Run not finished (an item's `mainSeq` is the cursor of the line that last wrote it, 0 for one only the WIP log
 * has; `dirty`: the WIP log changed it after that line).
 */
export interface LoadedRun {
  row: RunRow;
  ended: boolean;
  items: Map<number, { item: HeldItem; mainSeq: number; dirty: boolean }> | null;
  /** The byte range of the file that holds the Run's item lines (it may hold lines of other Runs too: a reader picks the Run's own). */
  span: { from: number; to: number } | null;
  /** The id of the line that ended the Run. */
  endEntry: string | null;
  /** What the conversation's views ask of a finished Turn without reading it: its edits, its latest plan, the content it mentions. */
  facts: TurnLineFacts;
}
/** A Turn's file changes with a stored detail (their places), the place of its latest plan with steps, and the content ids its items mention. */
export interface TurnLineFacts { edits: number[]; plan: number | null; refs: string[]; relay?: TurnRelayCounts; recap?: number | null }
export const noFacts = (): TurnLineFacts => ({ edits: [], plan: null, refs: [] });
/** What one item adds to its Turn's facts. */
export function addItemFacts(facts: TurnLineFacts, item: Pick<HeldItem, "seq" | "type" | "fields">): void {
  const fields = item.fields as { readonly detail?: { readonly id?: unknown }; readonly content?: { readonly id?: unknown }; readonly steps?: unknown; readonly by?: unknown };
  // The Hub's own record of the workspace is an edit with or without a diff (a workspace that is not a repository, a binary file).
  if (item.type === "file_change" && (fields.detail !== undefined || fields.by === "hub") && !facts.edits.includes(item.seq)) facts.edits.push(item.seq);
  if (item.type === "plan" && Array.isArray(fields.steps) && fields.steps.length > 0 && (facts.plan === null || item.seq > facts.plan)) facts.plan = item.seq;
  if (item.type === "recap" && (facts.recap === undefined || facts.recap === null || item.seq > facts.recap)) facts.recap = item.seq;
  for (const id of [fields.detail?.id, fields.content?.id]) if (typeof id === "string" && !facts.refs.includes(id)) facts.refs.push(id);
}
export function factsOfItems(items: readonly HeldItem[]): TurnLineFacts { const facts = noFacts(); for (const item of items) addItemFacts(facts, item); facts.edits.sort((left, right) => left - right); return facts; }
/** Where a quoted message of a branch or an import is in the file (its words are read when asked for), and the content it attaches. */
export interface OriginPlace { readonly idx: number; readonly kind: "fork" | "import"; readonly offset: number; readonly length: number; readonly refs: readonly string[] }
export interface PacketPlace { readonly offset: number; readonly length: number; readonly index: number }
/**
 * Where a Turn starts in the tree, for every Turn of the file whether on the current path or not: its `turn start` line, and the line its commit was written under (the
 * anchor). Turns with one anchor are the alternatives of one place in the conversation (a message edited and sent again, a reply tried again).
 */
export interface TurnStart { readonly runId: string; readonly anchor: string | null; readonly entry: string }
export interface Loaded {
  readonly paths: SessionPaths;
  readonly header: SessionHeader;
  head: HeadState;
  title: string;
  readonly commands: CommandRecord[];
  readonly runs: LoadedRun[];
  readonly bindings: NativeSessionBinding[];
  readonly switches: PublicSwitch[];
  readonly origin: OriginPlace[];
  readonly prints: Set<string>;
  readonly packets: Map<string, { readonly runId: RunId; readonly packet: RelayPacket }>;
  /** Where the text of each packet body is: the line and the packet's place in it (texts are read when asked for, not held). */
  readonly bodies: Map<string, PacketPlace>;
  readonly deliveries: Map<string, DeliveryRecord>;
  readonly starts: TurnStart[];
  lastSeq: number;
  leaf: string | null;
  nextEntry: number;
  size: number;
  mtimeMs: number;
  /** Whether the file ends in a newline (a write cut short leaves it without one; the next write starts a line first). */
  endsInNewline: boolean;
  updatedAt: number;
  /** Lines that could not be read (a write cut short, a hand edit): passed over. */
  skipped: number;
  /** Whether a WIP log was found and laid over the file. */
  wip: boolean;
  /** Whether the fold came from the cache beside the file. */
  fromCache: boolean;
  /** The seq of the commit the fold is in, and the line its first line was written under (the anchor of a Turn whose line does not say it). */
  commitSeq: number;
  commitParent: string | null;
}

function invalid(message: string): never { throw new SessionError("INVALID_DATA", message); }
/** The lines that make up the conversation's Turns, which only the current path holds; every other line is a fact of the whole conversation, whichever branch it was written on. */
const PATH_TYPES: ReadonlySet<string> = new Set(["turn", "item"]);
interface LineHead { readonly id: string; readonly parent: string | null; readonly type: string }
function headOf(text: string): LineHead | null {
  const found = HEAD_OF_LINE.exec(text.slice(0, 96));
  if (found !== null) return { type: found[1]!, id: found[2]!, parent: found[3] === "null" ? null : found[3]!.slice(1, -1) };
  const value = parse(text);
  return value !== null && typeof value.id === "string" ? { type: String(value.type), id: value.id, parent: typeof value.parentId === "string" ? value.parentId : null } : null;
}
/** The ids of a file's lines and the line each was written under, in file order. */
export function lineHeads(buffer: Buffer, base = 0): (LineHead & { readonly offset: number })[] {
  const heads: (LineHead & { offset: number })[] = [];
  for (const line of lines(buffer, base)) { const head = headOf(line.text); if (head !== null) heads.push({ ...head, offset: line.offset }); }
  return heads;
}

function emptyLoaded(paths: SessionPaths, header: SessionHeader): Loaded {
  return { paths, header, head: null as unknown as HeadState, title: "", commands: [], runs: [], bindings: [], switches: [], origin: [], prints: new Set(), packets: new Map(), bodies: new Map(),
    deliveries: new Map(), starts: [], lastSeq: 0, leaf: null, nextEntry: 1, size: 0, mtimeMs: 0, endsInNewline: true, updatedAt: Date.parse(String(header.timestamp)) || 0, skipped: 0, wip: false,
    fromCache: false, commitSeq: -1, commitParent: null };
}
/** One line folded into what is read: `onPath` null when every line is on the path. */
function foldLine(loaded: Loaded, byRun: Map<string, LoadedRun>, value: Record<string, unknown>, line: { readonly offset: number; readonly length: number }, onPath: ReadonlySet<string> | null): void {
  const seq = typeof value.seq === "number" ? value.seq : 0, id = String(value.id);
  if (seq !== loaded.commitSeq) { loaded.commitSeq = seq; loaded.commitParent = typeof value.parentId === "string" ? value.parentId : null; }
  if (seq > loaded.lastSeq) loaded.lastSeq = seq;
  // A line of a commit that only named or marked the conversation (`marks`, ConversationMutation.marksOnly) does not say it moved on.
  const at = Date.parse(String(value.timestamp));
  if (value.marks !== true && Number.isFinite(at) && at > loaded.updatedAt) loaded.updatedAt = at;
  if (value.type === "turn" && value.phase === "start") {
    const runId = String((value.run as { runId?: unknown }).runId);
    loaded.starts.push({ runId, anchor: typeof value.anchor === "string" ? value.anchor : loaded.commitParent, entry: id });
  }
  if (PATH_TYPES.has(String(value.type)) && onPath !== null && !onPath.has(id)) return;
  const sessionId = loaded.header.id as SessionId;
  switch (value.type) {
    case "head": loaded.head = value.head as HeadState; break;
    case "session_info": if (typeof value.name === "string") loaded.title = value.name; break;
    case "command": loaded.commands[Number(value.ordinal)] = value.command as CommandRecord; break;
    case "binding": loaded.bindings[Number(value.ordinal)] = value.binding as NativeSessionBinding; break;
    case "switch": loaded.switches[Number(value.ordinal)] = value.switch as PublicSwitch; break;
    case "origin": loaded.origin.push({ idx: Number(value.idx), kind: value.kind === "import" ? "import" : "fork", offset: line.offset, length: line.length,
      refs: ((value.message as ForkedMessage | undefined)?.attachments ?? []).map(attachment => attachment.id) }); break;
    case "custom": if (value.customType === "notice_prints" && Array.isArray((value.data as { prints?: unknown })?.prints)) for (const print of (value.data as { prints: unknown[] }).prints) loaded.prints.add(String(print)); break;
    case "turn": {
      const row = { ...(value.run as StoredRun), sessionId } as RunRow;
      let run = byRun.get(row.runId);
      if (run === undefined) { run = { row, ended: false, items: new Map(), span: null, endEntry: null, facts: noFacts() }; byRun.set(row.runId, run); loaded.runs[row.ordinal] = run; }
      run.row = row;
      if (value.phase === "end" || runFinished(row.status)) { run.ended = true; run.items = null; if (value.phase === "end") run.endEntry = id; }
      if (value.phase === "end" && value.counts !== null && typeof value.counts === "object") run.facts.relay = value.counts as TurnRelayCounts;
      break;
    }
    case "item": {
      const run = byRun.get(String(value.runId));
      if (run === undefined) { loaded.skipped++; break; }
      run.span = run.span === null ? { from: line.offset, to: line.offset + line.length } : { from: Math.min(run.span.from, line.offset), to: Math.max(run.span.to, line.offset + line.length) };
      const item = heldItemOf(run.row.runId, value.item as StoredItem);
      addItemFacts(run.facts, item);
      if (run.items !== null) run.items.set(item.seq, { item, mainSeq: seq, dirty: false });
      break;
    }
    case "relay": {
      const packets = Array.isArray(value.packets) ? value.packets as StoredPacket[] : [];
      packets.forEach((stored, index) => {
        if (!loaded.packets.has(stored.packet.id)) loaded.packets.set(stored.packet.id, { runId: stored.runId, packet: stored.packet });
        if (!loaded.bodies.has(stored.packet.body.sha256)) loaded.bodies.set(stored.packet.body.sha256, { offset: line.offset, length: line.length, index });
      });
      for (const record of Array.isArray(value.deliveries) ? value.deliveries as DeliveryRecord[] : []) loaded.deliveries.set(record.runId, record);
      break;
    }
    default: break;
  }
}
/** Folds the lines of `buffer` (at `base` in the file) into `loaded`. */
function foldBuffer(loaded: Loaded, buffer: Buffer, base: number, onPath: ReadonlySet<string> | null, skipFirst: boolean): void {
  const byRun = new Map<string, LoadedRun>(loaded.runs.map(run => [run.row.runId as string, run]));
  let first = skipFirst;
  for (const line of lines(buffer, base)) {
    if (first) { first = false; continue; }
    const value = parse(line.text);
    if (value === null) { loaded.skipped++; continue; }
    foldLine(loaded, byRun, value, line, onPath);
  }
}
/** The path from `leaf` to the root, or null when every line is on it (each line written under the one before it). */
function pathOf(heads: readonly LineHead[], leaf: string | null, given: boolean): ReadonlySet<string> | null {
  let linear = !given;
  if (linear) for (let index = 0; index < heads.length; index++) if (heads[index]!.parent !== (index === 0 ? null : heads[index - 1]!.id)) { linear = false; break; }
  if (linear) return null;
  const parents = new Map(heads.map(head => [head.id, head.parent] as const)), path = new Set<string>();
  for (let at: string | null = leaf; at !== null && !path.has(at); at = parents.get(at) ?? null) path.add(at);
  return path;
}

/** The fold kept beside a file (`.index.json`): what reading it up to `size` gave, for a conversation with no Turn open. A cache: a reader that cannot use it reads the file. */
interface Sidecar {
  readonly version: 2; readonly size: number; readonly mtimeMs: number; readonly header: SessionHeader; readonly head: HeadState; readonly title: string;
  readonly commands: readonly CommandRecord[]; readonly runs: readonly { readonly row: StoredRun; readonly span: LoadedRun["span"]; readonly endEntry: string | null; readonly facts: TurnLineFacts }[];
  readonly bindings: readonly NativeSessionBinding[]; readonly switches: readonly PublicSwitch[]; readonly origin: readonly OriginPlace[]; readonly prints: readonly string[];
  readonly packets: readonly (readonly [string, { readonly runId: RunId; readonly packet: RelayPacket }])[]; readonly bodies: readonly (readonly [string, PacketPlace])[];
  readonly deliveries: readonly (readonly [string, DeliveryRecord])[]; readonly starts: readonly TurnStart[];
  readonly lastSeq: number; readonly leaf: string | null; readonly nextEntry: number; readonly endsInNewline: boolean; readonly updatedAt: number;
}
export function sidecarOf(loaded: Pick<Loaded, "header" | "head" | "title" | "commands" | "bindings" | "switches" | "origin" | "prints" | "packets" | "bodies" | "deliveries" | "starts" | "lastSeq" | "leaf"
  | "nextEntry" | "endsInNewline" | "updatedAt" | "size" | "mtimeMs"> & { readonly runs: readonly { readonly row: RunRow; readonly span: LoadedRun["span"]; readonly endEntry: string | null; readonly facts: TurnLineFacts }[] }): string {
  const sidecar: Sidecar = { version: 2, size: loaded.size, mtimeMs: loaded.mtimeMs, header: loaded.header, head: loaded.head, title: loaded.title, commands: loaded.commands,
    runs: loaded.runs.map(run => { const { sessionId: _session, ...row } = run.row; return { row, span: run.span, endEntry: run.endEntry, facts: run.facts }; }), bindings: loaded.bindings, switches: loaded.switches,
    origin: loaded.origin, prints: [...loaded.prints], packets: [...loaded.packets], bodies: [...loaded.bodies], deliveries: [...loaded.deliveries], starts: loaded.starts, lastSeq: loaded.lastSeq,
    leaf: loaded.leaf, nextEntry: loaded.nextEntry, endsInNewline: loaded.endsInNewline, updatedAt: loaded.updatedAt };
  return JSON.stringify(sidecar) + "\n";
}
/** What the cache beside the file says, carried on over what was written after it when that is one chain from where it stopped; null when the file must be read whole. */
function fromSidecar(paths: SessionPaths, size: number, mtimeMs: number): Loaded | null {
  if (!existsSync(paths.index)) return null;
  let cached: Sidecar;
  try { cached = JSON.parse(readFileSync(paths.index, "utf8")) as Sidecar; } catch { return null; }
  if (cached.version !== 2 || typeof cached.size !== "number" || cached.size > size || (cached.size === size && cached.mtimeMs !== mtimeMs) || !cached.endsInNewline) return null;
  const tail = cached.size === size ? Buffer.alloc(0) : readRange(paths.main, cached.size, size - cached.size);
  const heads = lineHeads(tail, cached.size);
  for (let index = 0; index < heads.length; index++) if (heads[index]!.type === "leaf" || heads[index]!.parent !== (index === 0 ? cached.leaf : heads[index - 1]!.id)) return null;
  const sessionId = cached.header.id as SessionId;
  const loaded: Loaded = { ...emptyLoaded(paths, cached.header), head: cached.head, title: cached.title, commands: [...cached.commands],
    runs: cached.runs.map(run => ({ row: { ...run.row, sessionId } as RunRow, ended: true, items: null, span: run.span, endEntry: run.endEntry, facts: run.facts ?? noFacts() })), bindings: [...cached.bindings], switches: [...cached.switches],
    origin: [...cached.origin], prints: new Set(cached.prints), packets: new Map(cached.packets), bodies: new Map(cached.bodies), deliveries: new Map(cached.deliveries), starts: [...cached.starts],
    lastSeq: cached.lastSeq, leaf: cached.leaf, nextEntry: cached.nextEntry, size: cached.size, endsInNewline: true, updatedAt: cached.updatedAt, fromCache: true };
  if (tail.length > 0) {
    loaded.fromCache = false;
    foldBuffer(loaded, tail, cached.size, null, false);
    loaded.leaf = heads.at(-1)?.id ?? loaded.leaf; loaded.size = size; loaded.endsInNewline = tail[tail.length - 1] === 10;
    for (const head of heads) { const number = parseInt(head.id, 16); if (Number.isSafeInteger(number) && number >= loaded.nextEntry) loaded.nextEntry = number + 1; }
  }
  return loaded;
}
/** The whole file read: its lines folded along the path from `leaf` (the last line when none is given). */
function scanWhole(paths: SessionPaths, buffer: Buffer, leafGiven: string | undefined): Loaded {
  const first = lines(buffer).next();
  const header = first.done === true ? null : parse(first.value.text);
  if (header === null || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") invalid("the conversation file has no header");
  const heads = lineHeads(buffer).filter(head => head.type !== "session");
  const leaf = leafGiven ?? heads.at(-1)?.id ?? null;
  if (leafGiven !== undefined && !heads.some(head => head.id === leafGiven)) invalid("the conversation file has no line " + leafGiven);
  const loaded = emptyLoaded(paths, header as unknown as SessionHeader);
  loaded.leaf = leaf; loaded.size = buffer.length; loaded.endsInNewline = buffer.length === 0 || buffer[buffer.length - 1] === 10;
  for (const head of heads) { const number = parseInt(head.id, 16); if (Number.isSafeInteger(number) && number >= loaded.nextEntry) loaded.nextEntry = number + 1; }
  foldBuffer(loaded, buffer, 0, pathOf(heads, leaf, leafGiven !== undefined), true);
  return loaded;
}

/**
 * Reads a conversation's file, and its WIP log laid over it, into what the store holds. Only the Turns not finished keep their items; a finished one keeps the range of its lines.
 * The cache beside the file is used when it is the file's (or the file only grew in one chain after it); `leaf` reads the conversation as the branch that ends at that line.
 */
export function loadSession(main: string, options: { readonly leaf?: string } = {}): Loaded {
  const paths = pathsOf(main), stat = statSync(main);
  const loaded = (options.leaf === undefined ? fromSidecar(paths, stat.size, stat.mtimeMs) : null) ?? scanWhole(paths, readFileSync(main), options.leaf);
  loaded.mtimeMs = stat.mtimeMs;
  if (loaded.head === null) invalid("the conversation file has no head");
  if (loaded.runs.some(run => run === undefined)) invalid("the conversation file misses a Turn");
  if (existsSync(paths.wip)) { overlayWip(loaded, paths.wip); loaded.wip = true; }
  loaded.lastSeq = Math.max(loaded.lastSeq, lastEventSeq(paths.events));
  return loaded;
}

/** The WIP log laid over what the file says: the rows and items of the Turns not finished, as their last commits left them; what the file wrote later wins. */
function overlayWip(loaded: Loaded, path: string): void {
  const byRun = new Map(loaded.runs.map(run => [run.row.runId as string, run]));
  const rowSeq = new Map<string, number>();
  for (const line of lines(readFileSync(path))) {
    const value = parse(line.text);
    if (value === null || value.type !== "wip") continue;
    const seq = typeof value.seq === "number" ? value.seq : 0;
    if (seq > loaded.lastSeq) loaded.lastSeq = seq;
    for (const stored of Array.isArray(value.runs) ? value.runs as StoredRun[] : []) {
      const run = byRun.get(stored.runId);
      if (run === undefined || run.ended || (rowSeq.get(stored.runId) ?? 0) > seq) continue;
      run.row = { ...stored, sessionId: run.row.sessionId }; rowSeq.set(stored.runId, seq);
    }
    for (const write of Array.isArray(value.items) ? value.items as { runId: string; item: Omit<StoredItem, "text"> }[] : []) {
      const run = byRun.get(write.runId);
      if (run === undefined || run.items === null) continue;
      const was = run.items.get(write.item.seq);
      if (was !== undefined && was.mainSeq >= seq) continue;
      const base = was?.item;
      run.items.set(write.item.seq, { mainSeq: was?.mainSeq ?? 0, dirty: true, item: { runId: run.row.runId, seq: write.item.seq, itemId: write.item.itemId, type: write.item.type, status: write.item.status, startedAt: write.item.startedAt ?? null,
        endedAt: write.item.endedAt ?? null, parentId: write.item.parentId ?? null, createdSeq: write.item.createdSeq ?? base?.createdSeq ?? null, fields: write.item.fields,
        textBytes: base?.textBytes ?? 0, textChunks: base?.textChunks ?? 0, text: base?.text ?? [] } });
    }
    for (const append of Array.isArray(value.text) ? value.text as { runId: string; itemSeq: number; text: string }[] : []) {
      const run = byRun.get(append.runId);
      const was = run?.items?.get(append.itemSeq);
      if (was === undefined || was.mainSeq >= seq || typeof append.text !== "string") continue;
      const item = was.item;
      was.item = { ...item, text: [...item.text, append.text], textBytes: item.textBytes + utf8Length(append.text), textChunks: item.textChunks + 1 }; was.dirty = true;
    }
  }
}

/** The conversation as the Runtime reduces it, from what was read. `version` starts at the cursor, so that it only goes up across restarts. */
export function conversationOf(loaded: Loaded): Conversation {
  const head = loaded.head;
  const runs = loaded.runs.map(run => conversationRunOf(run.row, run.items === null ? undefined : [...run.items.values()].map(entry => entry.item).sort((left, right) => left.seq - right.seq)));
  const bindings = loaded.bindings.filter(binding => binding !== undefined);
  return { id: loaded.header.id as SessionId, version: Math.max(1, loaded.lastSeq), lastSeq: loaded.lastSeq, format: CONVERSATION_FORMAT, epoch: head.epoch, status: head.status,
    configuration: head.configuration, selection: head.selection, activeRunId: head.activeRunId, pendingSwitchId: head.pendingSwitchId, runs,
    switches: loaded.switches.filter(change => change !== undefined), commands: loaded.commands.filter(command => command !== undefined),
    ...(bindings.length === 0 ? {} : { nativeBindings: bindings }), ...(head.origin === undefined ? {} : { origin: head.origin }), ...(head.delegation === undefined ? {} : { delegation: head.delegation }), ...(head.delegationsTold === undefined ? {} : { delegationsTold: head.delegationsTold }), ...(head.taskBoard === undefined ? {} : { taskBoard: head.taskBoard }), ...(head.taskBoardTold === undefined ? {} : { taskBoardTold: head.taskBoardTold }), ...(head.taskEditsTold === undefined ? {} : { taskEditsTold: head.taskEditsTold }), ...(head.parentWordsTold === undefined ? {} : { parentWordsTold: head.parentWordsTold }), ...(head.retainNative === undefined ? {} : { retainNative: head.retainNative }),
    ...(head.retained === undefined ? {} : { retained: head.retained }), ...(head.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: head.relayRecoveryFailed }), ...userMarks(head) };
}

/** The items of one Turn from the lines in `span` of the file: the Run's own, the last line of each item winning, in place order. */
export function readRunItems(path: string, runId: RunId, span: { readonly from: number; readonly to: number }): HeldItem[] {
  const found = new Map<number, HeldItem>();
  for (const line of lines(readRange(path, span.from, span.to - span.from), span.from)) {
    const value = parse(line.text);
    if (value === null || value.type !== "item" || value.runId !== runId) continue;
    const item = heldItemOf(runId, value.item as StoredItem);
    found.set(item.seq, item);
  }
  return [...found.values()].sort((left, right) => left.seq - right.seq);
}
/** The quoted messages a conversation started from, read from their places in its file. */
export function readOrigin(path: string, sessionId: SessionId, places: readonly OriginPlace[]): OriginHistoryRow[] {
  if (places.length === 0) return [];
  const from = Math.min(...places.map(place => place.offset)), to = Math.max(...places.map(place => place.offset + place.length)), rows: OriginHistoryRow[] = [];
  for (const line of lines(readRange(path, from, to - from), from)) {
    const value = parse(line.text);
    if (value === null || value.type !== "origin") continue;
    rows.push({ sessionId, idx: Number(value.idx), kind: value.kind === "import" ? "import" : "fork", message: value.message as ForkedMessage });
  }
  return rows.sort((left, right) => left.idx - right.idx);
}
/** The lines of a file from its end to its start, a piece at a time: a reader that stops early reads no more than it needed. */
export function* linesBackward(path: string, piece = 1024 * 1024): Generator<{ readonly offset: number; readonly length: number; readonly text: string }> {
  const fd = openSync(path, "r");
  try {
    let end = fstatSync(fd).size, carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - piece), chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      let buffer = carry.length === 0 ? chunk : Buffer.concat([chunk, carry]), stop = buffer.length;
      // Every line that starts inside this piece is whole now; what comes before the first newline joins the piece before it.
      for (let at = buffer.lastIndexOf(10, stop - 1); at >= 0; at = stop > 0 ? buffer.lastIndexOf(10, stop - 1) : -1) {
        if (stop - at - 1 > 0) yield { offset: start + at + 1, length: stop - at - 1, text: buffer.toString("utf8", at + 1, stop) };
        stop = at;
        if (at === 0) break;
      }
      carry = buffer.subarray(0, stop); end = start;
      if (start === 0 && carry.length > 0) { yield { offset: 0, length: carry.length, text: carry.toString("utf8") }; carry = Buffer.alloc(0); }
      buffer = Buffer.alloc(0);
    }
  } finally { closeSync(fd); }
}
/** The text of one packet body from the `relay` line that holds it. */
export function readPacketBody(path: string, place: PacketPlace): string | null {
  const value = parse(readRange(path, place.offset, place.length).toString("utf8"));
  const packets = value === null || !Array.isArray(value.packets) ? [] : value.packets as StoredPacket[];
  const body = packets[place.index]?.body;
  return typeof body === "string" ? body : null;
}
/** The header of a conversation file (its first line), without reading the rest. */
export function readHeader(main: string): SessionHeader | null {
  const fd = openSync(main, "r");
  try {
    let size = 4096;
    for (;;) {
      const buffer = Buffer.alloc(size), got = readSync(fd, buffer, 0, size, 0);
      const end = buffer.subarray(0, got).indexOf(10);
      if (end >= 0 || got < size) { const value = parse(buffer.toString("utf8", 0, end >= 0 ? end : got)); return value !== null && value.type === "session" ? value as unknown as SessionHeader : null; }
      size *= 4;
    }
  } finally { closeSync(fd); }
}
/** Whether a conversation holds a command id (its create key) among its first ones: used to tell an index's guess from the file. */
export function createKeyOf(header: SessionHeader): CommandId | null { return typeof header.createKey === "string" ? header.createKey as CommandId : null; }
