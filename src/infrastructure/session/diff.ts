import {
  CONVERSATION_FORMAT,
  type BindingWrite, type CommandRow, type ContentRefRow, type Conversation, type ConversationRun, type HeadJson, type HeldItem, type ItemFields, type ItemRow, type ItemWrite, type Mutation,
  type OriginHistoryRow, type RunWrite, type SwitchWrite, type TextAppend,
} from "../../contracts/conversation.js";
import type { RelayRows } from "../../contracts/relay.js";
import { SessionError, type EventDraft, type PublicSwitch, type SessionEvent, type SessionId } from "../../contracts/session.js";
import { bindingRowOf, canonicalJson, commandRowOf, itemRowOf, listMarksOf, runColumns, runRowOf, sourceThroughOrdinal, switchRowOf, utf8Length } from "./rows.js";

/*
 * Stage 1 of ADR-057: the Runtime still reduces a whole `Conversation` and the store finds what changed. `diffConversation` compares the
 * conversation before a commit with the one the reducer returned and makes the Mutation that writes the difference. It compares by object
 * identity first: a Run, a binding, a switch or an item that is the same object is the same, and the loop over the Runs of a long
 * conversation is a pointer comparison each; a Run that finished is never compared again (nothing of a finished Run changes, and its items
 * are not held), and only the items and the text of the Runs not finished are looked into, the text by the number of chunks it grew.
 * The cost of a commit is therefore the size of what changed and of the Turn in progress, not of the history.
 *
 * It refuses, as INVALID_TRANSITION, what no commit may do and what could only be written wrongly: a Run, a command, a binding or an item
 * taken away; a chunk of text that is not the one it was; a finished Run rewritten. Saying it here says it before anything is written, and in words about the conversation.
 */

/** A Mutation with the numbers the store gave it: the events as committed (their seqs), and the rows with the seqs, offsets and counts filled in. */
export interface Applied { readonly events: readonly SessionEvent[]; readonly changes: Mutation }

export interface DiffContext {
  /** The events of the commit, as the reducer returned them beside the conversation. */
  readonly events?: readonly EventDraft[];
  readonly relay?: RelayRows;
  /** The quoted messages a new conversation starts from (an import's, a branch's): the conversation holds only a summary of them. */
  readonly originHistory?: readonly OriginHistoryRow[];
  /** The fingerprints of the Harness notices shown for the first time in this commit. */
  readonly noticePrints?: readonly string[];
  /** The columns of the head the conversation does not carry: the title (from the first input) and the time of the commit. */
  readonly title: string;
  readonly updatedAt: number;
  /**
   * Which event of `events` made an item, by its index, when the default is not right. The default: the `user` item is the `message.accepted` event
   * of its Run, and any other item is the one event of a commit that has exactly one; with several events and no answer the item has no `createdSeq`.
   */
  readonly createdBy?: (run: ConversationRun, item: HeldItem) => number | undefined;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "unknown"]);
const finished = (status: string): boolean => TERMINAL.has(status);
const transition = (message: string): SessionError => new SessionError("INVALID_TRANSITION", message);

function headOf(after: Conversation): HeadJson {
  return { configuration: after.configuration, selection: after.selection, ...(after.retainNative === undefined ? {} : { retainNative: after.retainNative }),
    ...(after.retained === undefined ? {} : { retained: after.retained }), ...(after.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: after.relayRecoveryFailed }),
    ...(after.origin === undefined ? {} : { origin: after.origin }), ...(after.delegation === undefined ? {} : { delegation: after.delegation }), ...(after.delegationsTold === undefined ? {} : { delegationsTold: after.delegationsTold }),
    ...(after.taskBoard === undefined ? {} : { taskBoard: after.taskBoard }), ...(after.taskBoardTold === undefined ? {} : { taskBoardTold: after.taskBoardTold }), ...(after.taskEditsTold === undefined ? {} : { taskEditsTold: after.taskEditsTold }), ...(after.parentWordsTold === undefined ? {} : { parentWordsTold: after.parentWordsTold }),
    ...listMarksOf(after) };
}
function eventIndex(events: readonly EventDraft[], accept: (event: EventDraft) => boolean): number | undefined {
  const index = events.findIndex(accept);
  return index < 0 ? undefined : index;
}
const acceptedBy = (events: readonly EventDraft[], run: string): number | undefined => eventIndex(events, event => event.type === "message.accepted" && event.data.runId === run);
/** The event that ended a Run: its `run.ended`, or the `session.recovered` that ended it. */
const endedBy = (events: readonly EventDraft[], run: string): number | undefined => eventIndex(events, event => (event.type === "run.ended" && event.data.runId === run)
  || (event.type === "session.recovered" && [event.data.unknownRunIds, event.data.cancelledRunIds].some(list => Array.isArray(list) && list.includes(run))));

/** The content a Run's inputs and an item refer to, as the references the collector keeps. */
function itemRefs(sessionId: SessionId, run: ConversationRun, item: HeldItem, role?: "superseded_detail"): ContentRefRow[] {
  const fields = item.fields as ItemFields & { readonly detail?: { readonly id: string }; readonly content?: { readonly id: string } };
  const refs: ContentRefRow[] = [];
  if (fields.detail !== undefined) refs.push({ contentId: fields.detail.id, sessionId, runId: run.id, itemSeq: item.seq, role: role ?? "tool_detail" });
  if (fields.content !== undefined && role === undefined) refs.push({ contentId: fields.content.id, sessionId, runId: run.id, itemSeq: item.seq, role: "output" });
  return refs;
}
const sameJson = (left: unknown, right: unknown): boolean => left === right || canonicalJson(left) === canonicalJson(right);
const sameItem = (left: HeldItem, right: HeldItem): boolean => left.type === right.type && left.status === right.status && left.startedAt === right.startedAt && left.endedAt === right.endedAt
  && left.parentId === right.parentId && sameJson(left.fields, right.fields);

interface ItemChanges { readonly items: ItemWrite[]; readonly text: TextAppend[]; readonly refs: ContentRefRow[] }
/** The items and the text a Run gained between two versions of it; `before` is absent for a Run that is new. */
function diffItems(sessionId: SessionId, before: ConversationRun | undefined, after: ConversationRun, createdBy: (run: ConversationRun, item: HeldItem) => number | undefined): ItemChanges {
  const result: ItemChanges = { items: [], text: [], refs: [] };
  const was = before?.items ?? [], now = after.items ?? [];
  let i = 0;
  for (let j = 0; j < now.length; j++) {
    const item = now[j]!;
    if (j > 0 && item.seq <= now[j - 1]!.seq) throw new SessionError("INVALID_DATA", "the items of a Run are held in place order");
    if (i < was.length && was[i]!.seq < item.seq) throw transition("item " + was[i]!.seq + " of " + after.id + " was taken away: items are never removed");
    const old = i < was.length && was[i]!.seq === item.seq ? was[i++] : undefined;
    if (old === undefined) {
      const created = createdBy(after, item);
      result.items.push({ op: "insert", row: { ...itemRowOf(item), textBytes: 0, textChunks: 0 }, ...(created === undefined ? {} : { createdByEvent: created }) });
      result.refs.push(...itemRefs(sessionId, after, item));
      let offset = 0;
      for (let chunk = 0; chunk < item.text.length; chunk++) { const text = item.text[chunk]!; result.text.push({ runId: after.id, itemSeq: item.seq, chunk, text, byteOffset: offset }); offset += utf8Length(text); }
      continue;
    }
    if (old === item) continue;
    if (old.itemId !== item.itemId) throw transition("an item's place and id never change (" + old.itemId + " at " + item.seq + ")");
    if (!sameItem(old, item)) {
      result.items.push({ op: "update", row: itemRowOf(item) });
      // A reference an update brings is written once; the detail an update replaces stays referenced, as the one it superseded.
      const had = new Set(itemRefs(sessionId, after, old).map(ref => ref.contentId + "\u0000" + ref.role));
      for (const ref of itemRefs(sessionId, after, item)) if (!had.has(ref.contentId + "\u0000" + ref.role)) result.refs.push(ref);
      const kept = new Set(itemRefs(sessionId, after, item).map(ref => ref.contentId));
      for (const ref of itemRefs(sessionId, after, old, "superseded_detail")) if (!kept.has(ref.contentId)) result.refs.push(ref);
    }
    // Text only grows: the chunks that were there are the same chunks, and the new ones start where the old ended.
    if (item.text.length < old.text.length) throw transition("the text of item " + item.seq + " of " + after.id + " shrank: text is only appended");
    for (let chunk = 0; chunk < old.text.length; chunk++) if (item.text[chunk] !== old.text[chunk]) throw transition("chunk " + chunk + " of item " + item.seq + " of " + after.id + " changed: text is only appended");
    let offset = old.textBytes;
    for (let chunk = old.text.length; chunk < item.text.length; chunk++) { const text = item.text[chunk]!; result.text.push({ runId: after.id, itemSeq: item.seq, chunk, text, byteOffset: offset }); offset += utf8Length(text); }
  }
  if (i < was.length) throw transition("item " + was[i]!.seq + " of " + after.id + " was taken away: items are never removed");
  return result;
}

/**
 * The Mutation that takes `before` to `after`. `before` is null for a conversation that is new (everything is written, its head first). The head
 * is always written: it is the compare-and-swap of the commit, carrying the version `before` had and the cursor after the events.
 */
export function diffConversation(before: Conversation | null, after: Conversation, context: DiffContext): Mutation {
  const session = after.id, events = context.events ?? [];
  if (before !== null && before.id !== session) throw new SessionError("INVALID_DATA", "a commit cannot change which conversation it is");
  const createdBy = context.createdBy ?? ((run: ConversationRun, item: HeldItem): number | undefined => item.itemId === "user" ? acceptedBy(events, run.id) : events.length === 1 ? 0 : undefined);

  // Commands only grow.
  const commands: CommandRow[] = [];
  const earlier = before?.commands ?? [];
  if (after.commands !== earlier) {
    if (after.commands.length < earlier.length) throw transition("a command was taken away: the commands of a conversation are kept");
    for (let index = 0; index < earlier.length; index++) if (after.commands[index] !== earlier[index] && !sameJson(after.commands[index], earlier[index])) throw transition("committed command identity and result are never rewritten");
    for (let index = earlier.length; index < after.commands.length; index++) commands.push(commandRowOf(session, index, after.commands[index]!));
  }

  // Runs: the same object is the same Run; a finished Run is not looked into (only its acknowledgement may be written).
  const runs: RunWrite[] = [], items: ItemWrite[] = [], text: TextAppend[] = [], refs: ContentRefRow[] = [];
  const previous = before?.runs ?? [];
  if (after.runs.length < previous.length) throw transition("a Run was taken away: the history of a conversation is kept");
  for (let index = 0; index < after.runs.length; index++) {
    const run = after.runs[index]!, was = previous[index];
    if (was === run) continue;
    if (run.ordinal !== index) throw new SessionError("INVALID_DATA", "a Run's ordinal is its place among the Runs (" + run.ordinal + " at " + index + ")");
    const row = runRowOf(session, run);
    if (was === undefined) {
      const accepted = acceptedBy(events, run.id), ended = finished(run.status) && run.endedSeq === undefined ? endedBy(events, run.id) : undefined;
      runs.push({ op: "insert", row, ...(accepted === undefined ? {} : { userSeqByEvent: accepted }), ...(ended === undefined ? {} : { endedByEvent: ended }) });
      for (const attachment of run.attachments ?? []) refs.push({ contentId: attachment.id, sessionId: session, runId: run.id, itemSeq: run.items?.find(item => item.itemId === "user")?.seq ?? null, role: "attachment" });
    } else {
      const old = runColumns(runRowOf(session, was)), now = runColumns(row);
      const changed = Object.keys(now).filter(column => old[column] !== now[column]);
      if (finished(was.status)) {
        if (changed.some(column => column !== "acknowledged_by")) throw transition("terminal Run evidence cannot be rewritten (Run " + run.id + ")");
        // A finished Run's items are read by Turn and are held no more; a reducer that puts some back means to write them, and nothing would, so it is told.
        if (run.items !== undefined) throw transition("the items of a finished Run are read by Turn and cannot be added to (Run " + run.id + ")");
        if (changed.length > 0) runs.push({ op: "update", row });
        continue;
      }
      const ended = finished(run.status) && run.endedSeq === undefined && was.endedSeq === undefined ? endedBy(events, run.id) : undefined;
      if (changed.length > 0) runs.push({ op: "update", row, ...(ended === undefined ? {} : { endedByEvent: ended }) });
    }
    if (run.items !== undefined || was?.items !== undefined) {
      if (was !== undefined && !finished(was.status) && was.items === undefined && run.items !== undefined) throw new SessionError("INVALID_DATA", "the items of a Run not finished are held (Run " + run.id + ")");
      const gained = diffItems(session, was, run, createdBy);
      items.push(...gained.items); text.push(...gained.text); refs.push(...gained.refs);
    }
  }

  // Native bindings and switches, by their place among the others.
  const bindings: BindingWrite[] = [], switches: SwitchWrite[] = [];
  const nativeBefore = before?.nativeBindings ?? [], nativeAfter = after.nativeBindings ?? [];
  if (nativeAfter.length < nativeBefore.length) throw transition("native state references cannot be silently erased");
  nativeAfter.forEach((binding, index) => {
    const old = nativeBefore[index];
    if (old === binding) return;
    if (old === undefined) bindings.push({ op: "insert", row: bindingRowOf(session, index, binding) });
    else if (!sameJson(old, binding)) bindings.push({ op: "update", row: bindingRowOf(session, index, binding) });
  });
  const switchesBefore = before?.switches ?? [];
  if (after.switches.length < switchesBefore.length) throw transition("a switch was taken away: the switches of a conversation are kept");
  after.switches.forEach((change, index) => {
    const old = switchesBefore[index];
    if (old === change) return;
    if (old === undefined) switches.push({ op: "insert", row: switchRowOf(session, index, change, sourceThroughOrdinal(change.sourceRunIds, index => after.runs[index]?.id)) });
    else if (!sameJson(old, change)) switches.push({ op: "update", row: switchRowOf(session, index, change, sourceThroughOrdinal(change.sourceRunIds, index => after.runs[index]?.id)) });
  });

  const head = { row: { id: session, version: before?.version ?? 0, lastSeq: (before?.lastSeq ?? 0) + events.length, format: CONVERSATION_FORMAT, status: after.status, epoch: after.epoch,
    activeRunId: after.activeRunId, pendingSwitchId: after.pendingSwitchId, kept: after.retained !== undefined, title: context.title, runCount: after.runs.length, updatedAt: context.updatedAt,
    deletedAt: after.deletedAt ?? null, lastError: null, head: headOf(after) } };
  return { head, ...(runs.length === 0 ? {} : { runs }), ...(items.length === 0 ? {} : { items }), ...(text.length === 0 ? {} : { text }), ...(bindings.length === 0 ? {} : { bindings }),
    ...(commands.length === 0 ? {} : { commands }), ...(switches.length === 0 ? {} : { switches }), ...(refs.length === 0 ? {} : { contentRefs: refs }),
    ...(context.originHistory === undefined || context.originHistory.length === 0 ? {} : { originHistory: context.originHistory }),
    ...(context.noticePrints === undefined || context.noticePrints.length === 0 ? {} : { noticePrints: context.noticePrints }), events, ...(context.relay === undefined ? {} : { relay: context.relay }) };
}

/**
 * The conversation as the store holds it after a commit: what the reducer returned with the numbers the store assigned put in (the version and
 * the cursor of the head, the seqs taken from events, what each item has counted), and without the items of the Runs that finished (they stay in the
 * tables and are read by Turn). A Run the commit did not touch is the very object it was, so the next `diffConversation` passes over it.
 */
export function settleConversation(after: Conversation, applied: Applied): Conversation {
  const head = applied.changes.head!.row;
  const byRun = new Map<string, { run: RunWrite | undefined; items: Map<number, ItemWrite>; grown: Map<number, { bytes: number; chunks: number }> }>();
  const entry = (runId: string) => { let found = byRun.get(runId); if (found === undefined) { found = { run: undefined, items: new Map(), grown: new Map() }; byRun.set(runId, found); } return found; };
  for (const write of applied.changes.runs ?? []) entry(write.row.runId).run = write;
  for (const write of applied.changes.items ?? []) entry(write.row.runId).items.set(write.row.seq, write);
  for (const append of applied.changes.text ?? []) entry(append.runId).grown.set(append.itemSeq, { bytes: append.byteOffset! + utf8Length(append.text), chunks: append.chunk + 1 });
  // Only the Runs the commit touched are made again, found from the end (the Runs not finished are there): a copy of the array, not a pass over it. A commit that touched no
  // Run keeps the array it has. (The copy is a spread, not `slice`: `slice` of a frozen array, which the store's conversations are, takes a path 60 times slower.)
  if (byRun.size === 0) return { ...after, version: head.version, lastSeq: head.lastSeq };
  const runs = [...after.runs];
  let remaining = byRun.size;
  for (let index = runs.length - 1; index >= 0 && remaining > 0; index--) {
    const run = runs[index]!, touched = byRun.get(run.id);
    if (touched === undefined) continue;
    remaining--;
    let items = run.items;
    const seqs = new Set([...touched.items.keys(), ...touched.grown.keys()]);
    if (items !== undefined && seqs.size > 0) {
      const copy = items.slice();
      let left = seqs.size;
      for (let at = copy.length - 1; at >= 0 && left > 0; at--) {
        const item = copy[at]!;
        if (!seqs.has(item.seq)) continue;
        left--;
        const written = touched.items.get(item.seq)?.row, grown = touched.grown.get(item.seq);
        copy[at] = { ...item, createdSeq: written?.createdSeq ?? item.createdSeq, textBytes: grown?.bytes ?? written?.textBytes ?? item.textBytes, textChunks: grown?.chunks ?? written?.textChunks ?? item.textChunks };
      }
      items = copy;
    }
    const row = touched.run?.row;
    const { items: _held, ...rest } = run;
    const settled: ConversationRun = { ...rest, ...(row === undefined ? {} : { userSeq: row.userSeq }), ...(row === undefined || row.endedSeq === null ? {} : { endedSeq: row.endedSeq }) };
    runs[index] = finished(run.status) || items === undefined ? settled : { ...settled, items };
  }
  return { ...after, version: head.version, lastSeq: head.lastSeq, runs };
}
