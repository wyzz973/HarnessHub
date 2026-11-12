import type { ContentRef } from "../contracts/content.js";
import type { HeldItem, ItemFields, ItemRow, RunRow, TurnItems } from "../contracts/conversation.js";
import {
  PROTOCOL_VERSION,
  type ContextEventItem, type ErrorItem, type Executor, type ItemStatus, type PlanItem, type PlanStep, type SwitchItem,
} from "../contracts/protocol.js";
import type { RelayDecision } from "../contracts/relay.js";
import type { NativeSessionBinding, PublicTool, RunId, RunStatus, SessionId } from "../contracts/session.js";
import type { RelayDeliveryView, RunRelayView, WireItem, WireRun, WireTurn, WireTurnHeader } from "../contracts/web.js";
import { finalItemSeq } from "../contexts/session/domain/items-place.js";
import {
  errorClass, modelLabel, normalizeTool, planFromInput, runEnded, stopReason, turnStatus, turnUsage, type ToolDetailInput,
} from "../contexts/session/domain/protocol/index.js";
import { wireItem } from "./commit-frame.js";

/*
 * A Turn as the wire tells it (ADR-057 3.4): the Run's row and its items, made into the protocol's Turn (docs/proposals/protocol/hub-protocol.html §4-§5) the way the
 * step-1 projection (contexts/session/domain/protocol/project.ts) made it from the old fields, so that a conversation reads the same after it was kept as rows.
 *
 *  - THE HEADER (`WireTurnHeader`) is read from the Run's own facts: its state (a Turn that waits for the user's decision is `waiting`: an item of it does), why
 *    it ended, who ran it (the Harness by the name the catalog gives, the model as its selection named it, else, for the latest Turn of a control, as the native
 *    session reported it), its usage in the protocol's one meaning, when it began and how long it took, and `legacyOrder`.
 *  - THE LINES THAT ARE NOT ROWS: the hand-over line (`switch`, before the first item), the Run's own error and the clear (after the last). They are derived from
 *    the Run's facts and the relay's, never stored: a delivery changes after the Turn, and a copy of it would go stale (ItemId in contracts/conversation.ts). Their ids
 *    are the ones the projection gave (`hh:switch`, `hh:error`, `hh:clear`) and their places are `LINE_SEQ`.
 *  - THE ITEMS are the stored ones, as `wireItem` has them, with what the wire adds: a text (the chunks joined, the lone surrogates put back, a notice's label as it is now),
 *    the Turn's answer marked `final` once it completed, and, for a Turn converted from before v14, the command and path that only a stored detail names worked out
 *    again from the call's native facts (a conversion reads no detail). A call that is the Harness's task list is not a row: the Turn's plan stands for it (a plan
 *    of the Harness's own, else the one its input reads as), a sub-agent told both as a call and as an activity is one line, and a thinking that said nothing is no line,
 *    exactly as the projection did; the rows of all of them stay.
 *
 * What it does not do: hide an error notice because the Run also reports its error (the page does, where it assembles a Turn: both are kept here), and re-arrange
 * a converted Turn (its items stand in the fixed order of ADR-057 3.2, which `legacyOrder` tells). Pure; the only things it asks for are in `TurnFacts` and `TurnEnv`.
 */

/** The places of the lines of a Turn that are not rows: before every row (the stored items count from 1), and after every row. */
export const LINE_SEQ = { switch: 0, error: Number.MAX_SAFE_INTEGER - 1, clear: Number.MAX_SAFE_INTEGER } as const;

/** What the relay knows of one Run, which the Run's own row does not hold. */
export interface RunRelayReading {
  /** The state of the Run's packet; present for a Run that carried one (a packet no row tracks is `unknown`), absent for a Run that carried none and when it cannot be read. */
  readonly delivery?: RelayDeliveryView;
  /** What the relay decided for the Run's context, from the event that recorded it. */
  readonly decision?: RelayDecision;
}
/** What a Turn's header and lines are made of besides its own row and items; one per conversation read. */
export interface TurnFacts {
  /** The Run before this one in the conversation; null for the first. */
  previous(row: RunRow): RunRow | null;
  /** The ordinal of the last Run handed to a Harness control; null when none was. */
  lastDispatched(harnessId: string, controlId: string): number | null;
  bindings(): readonly NativeSessionBinding[];
  relay(row: RunRow): RunRelayReading;
  /** The row of the item that is the Turn's answer once the Turn completed, without its text; null when there is none. */
  answer?(row: RunRow): ItemRow | null;
}
/** The names and the details the display layer brings. */
export interface TurnEnv {
  /** A Harness's display name by its id (the catalog's name); null when it has none and the id is shown. */
  readonly harnessName: (harnessId: string) => string | null;
  readonly modelName?: ((harnessId: string, nativeModel: string) => string | null | undefined) | undefined;
  /** The head of a call's stored detail; null when it cannot be read now. Read only for the calls of Turns converted from before v14. */
  readonly detail?: ((ref: ContentRef) => ToolDetailInput | null) | undefined;
}

/** The reads of a conversation that `TurnFacts` is made from; `ConversationFacts` (infrastructure/session/facts.ts) is one. */
export interface ConversationFactsPort {
  runAt(id: SessionId, ordinal: number): RunRow | null;
  lastDispatched(id: SessionId, harnessId: string, controlId: string, options?: { readonly native?: boolean }): RunRow | null;
  bindings(id: SessionId): readonly NativeSessionBinding[];
  finalSeq(runId: RunId): number | null;
  item(runId: RunId, seq: number): ItemRow | null;
}
/** The facts of one conversation's Turns from its reads and from what the relay says of a Run. */
export function turnFactsOf(id: SessionId, facts: ConversationFactsPort, relay: (row: RunRow) => RunRelayReading): TurnFacts {
  return {
    previous: row => row.ordinal === 0 ? null : facts.runAt(id, row.ordinal - 1),
    lastDispatched: (harnessId, controlId) => facts.lastDispatched(id, harnessId, controlId)?.ordinal ?? null,
    bindings: () => facts.bindings(id),
    relay,
    answer: row => { const seq = facts.finalSeq(row.runId); return seq === null ? null : facts.item(row.runId, seq); },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Small readings of a stored item
// ---------------------------------------------------------------------------------------------------------------------

/** The text of an item as it was: its chunks joined and the lone surrogates it carried put back (a column holds U+FFFD for each, the item says which). */
export function textOf(item: Pick<HeldItem, "text" | "fields">): string {
  const joined = item.text.length === 1 ? item.text[0]! : item.text.join(""), marks = item.fields.native?.surrogates;
  if (marks === undefined || marks.length === 0) return joined;
  let text = "", from = 0;
  for (const [index, unit] of marks) {
    if (!Number.isInteger(index) || !Number.isInteger(unit) || index < from || index >= joined.length) continue;
    text += joined.slice(from, index) + String.fromCharCode(unit); from = index + 1;
  }
  return text + joined.slice(from);
}
const turnOf = (status: RunStatus): "going" | "ended" | "cancelled" => !runEnded(status) ? "going" : status === "cancelled" ? "cancelled" : "ended";
/** The call an item of a tool stands for, from what its Harness reported (the inverse of the conversion's `toItems`, which `fromItems` also does). */
function callOf(item: ItemRow): PublicTool {
  const native = item.fields.native, detail = (item.fields as { readonly detail?: ContentRef }).detail;
  return { id: native?.id ?? item.itemId.slice(5), title: native?.title ?? "", status: native?.status ?? item.status, ...(native?.kind === undefined ? {} : { kind: native.kind }),
    ...(native?.name === undefined ? {} : { name: native.name }), ...(item.parentId === null ? {} : { parentId: item.parentId.startsWith("tool:") ? item.parentId.slice(5) : item.parentId }),
    ...(native?.exitCode === undefined ? {} : { exitCode: native.exitCode }), ...(detail === undefined ? {} : { detail }) };
}

/**
 * Whether a stored item is a call to the Harness's task list: a plain tool call that the protocol reads as the Turn's plan and not as a row (`normalizeTool`). Whether it is then hidden
 * depends on the Turn (it has a plan of its own, or the call's stored input reads exactly), which is why a frame never tells such a call by itself (`ConversationRoutes.needsSnapshot`).
 */
export function isTaskListCall(row: ItemRow): boolean {
  if (row.type !== "tool" || !row.itemId.startsWith("tool:")) return false;
  try { return !normalizeTool(callOf(row), { seq: row.seq, detail: null, turn: "going" }).row; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------------
// The hand-over line (project.ts `switchOf` and `changed`, over a WireRun)
// ---------------------------------------------------------------------------------------------------------------------

/** Whether the Harness or the model changed from one Run to the next (the interface's own test of where a hand-over line goes). */
function changed(previous: RunRow, run: RunRow): boolean {
  const before = previous.facts.selection, after = run.facts.selection;
  return before.harnessId !== after.harnessId || before.nativeModel !== after.nativeModel || before.provider?.model !== after.provider?.model;
}
/** What the Run brought along from the executor before it, read from the relay facts the Run carries; a Run with none is from before the relay kept any, and nothing is claimed of it. */
function switchOf(run: WireRun, from: Executor, to: Executor): SwitchItem {
  const relay = run.relay, ended = runEnded(run.status), seq = LINE_SEQ.switch;
  if (relay === undefined) return { id: "hh:switch", seq, status: "completed", type: "switch", from, to, context: "unknown", session: "unknown" };
  const level = relay.continuity, decision = relay.decision, packetId = relay.packetId;
  const session: SwitchItem["session"] = level.kind === "rehydrate" || level.kind === "native_cleared" || level.kind === "native_fork" ? "new" : level.kind === "blocked" ? "unknown" : "resumed";
  let context: SwitchItem["context"], turns: number | undefined;
  if (packetId !== null) {
    // The same facts again are a resend whatever carried them; a packet for newer facts that also holds the unconfirmed one is what the target had missed.
    const resent = decision?.kind === "carry" && (decision.resend === "auto" || decision.resend === "all");
    if (resent) context = "resend";
    else if (level.kind === "native_resume_delta") context = "delta";
    else context = "full";
    turns = level.kind === "native_resume_delta" ? level.runs : run.sourceRunIds.length || undefined;
  } else if (level.kind === "native_cleared" || level.kind === "blocked" || run.backend?.reason === "cleared" || decision?.kind === "alone") context = "none";
  else context = "native";
  // What is known of the packet's arrival; a state nothing settled is "unconfirmed" once the Turn is over.
  let delivery: SwitchItem["delivery"];
  if (packetId !== null) {
    switch (relay.delivery?.state) {
      case "recorded": delivery = "confirmed"; break;
      case "not_recorded": delivery = "not_sent"; break;
      case "in_flight": case "unknown": case undefined: delivery = ended ? "unconfirmed" : "sending"; break;
    }
  }
  const status: ItemStatus = delivery === "sending" ? "running" : delivery === "unconfirmed" ? "unknown" : delivery === "not_sent" ? "failed" : "completed";
  return { id: "hh:switch", seq, status, type: "switch", from, to, context, ...(turns === undefined ? {} : { turns }), session,
    ...(delivery === undefined ? {} : { delivery }), ...(packetId === null ? {} : { packetId }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Made for one read of a conversation or one commit's frame, and let go: it remembers what it was asked of the conversation (the last Run handed to a control, its native
 * bindings) so that the Turns of a window ask once, and that is of the moment it was made.
 */
export class TurnView {
  private readonly dispatched = new Map<string, number | null>();
  private bound: readonly NativeSessionBinding[] | undefined;
  constructor(private readonly facts: TurnFacts, private readonly env: TurnEnv) {}

  private lastDispatched(harnessId: string, controlId: string): number | null {
    const key = harnessId + "\n" + controlId;
    let found = this.dispatched.get(key);
    if (found === undefined) { found = this.facts.lastDispatched(harnessId, controlId); this.dispatched.set(key, found); }
    return found;
  }
  /** The model a Run ran with as far as the record says: the one its selection named (a Hub Provider's model first), else, when it is the latest Turn of its control, the one the control's binding reported. */
  private nativeModel(row: RunRow): string | undefined {
    const selection = row.facts.selection, named = selection.provider?.model ?? selection.nativeModel;
    if (named !== undefined && named.trim() !== "") return named;
    if (this.lastDispatched(selection.harnessId, selection.controlId) !== row.ordinal) return undefined;
    this.bound ??= this.facts.bindings();
    const observed = this.bound.find(binding => binding.harnessId === selection.harnessId && binding.controlId === selection.controlId && binding.status !== "archived")?.observed?.model;
    return typeof observed === "string" && observed.trim() !== "" ? observed : undefined;
  }
  executor(row: RunRow): Executor {
    const harnessId = row.facts.selection.harnessId, native = this.nativeModel(row);
    return { harnessId, harness: this.env.harnessName(harnessId) ?? harnessId, ...(native === undefined ? {} : { model: modelLabel(harnessId, native, this.env.modelName?.(harnessId, native) ?? null) }) };
  }

  header(row: RunRow, waiting = false): WireTurnHeader {
    const facts = row.facts, timing = facts.timing;
    const reason = stopReason({ status: row.status, backend: facts.backend, error: facts.error, cancelRequested: row.cancelRequested });
    return { version: PROTOCOL_VERSION, runId: row.runId, n: row.ordinal + 1, status: turnStatus(row.status, waiting), ...(reason === undefined ? {} : { stopReason: reason }),
      executor: this.executor(row), usage: turnUsage(facts.selection.harnessId, facts.usage, row.status), ...(timing === undefined ? {} : { startedAt: timing.acceptedAt }),
      ...(timing !== undefined && runEnded(row.status) && timing.endedAt !== undefined ? { durationMs: Math.max(0, timing.endedAt - timing.acceptedAt) } : {}), ...(row.legacyOrder ? { legacyOrder: true as const } : {}) };
  }

  /** The Run as the wire has it: the facts it always had with the relay's delivery and decision read in, no display fields, and its Turn's header. */
  run(row: RunRow, waiting = false): WireRun {
    const facts = row.facts, read = facts.relay === undefined ? undefined : this.facts.relay(row);
    const relay: RunRelayView | undefined = facts.relay === undefined ? undefined
      : { ...facts.relay, ...(read?.delivery === undefined ? {} : { delivery: read.delivery }), ...(read?.decision === undefined ? {} : { decision: read.decision }) };
    return { id: row.runId, commandId: row.commandId, selection: facts.selection, epoch: row.epoch, status: row.status, cancelRequested: row.cancelRequested, contextThroughSeq: facts.contextThroughSeq,
      sourceRunIds: facts.sourceRunIds, backend: facts.backend, cleanup: facts.cleanup, error: facts.error, userMessageId: facts.userMessageId, assistantMessageId: facts.assistantMessageId,
      ...(facts.attachments === undefined ? {} : { attachments: facts.attachments }), ...(facts.timing === undefined ? {} : { timing: facts.timing }),
      ...(facts.retained === undefined ? {} : { retained: facts.retained }), ...(facts.reused === true || row.reused ? { reused: true as const } : {}), ...(relay === undefined ? {} : { relay }),
      stopRequested: row.stopRequested, awaitingSwitchId: facts.awaitingSwitchId, ordinal: row.ordinal, userSeq: row.userSeq, turn: this.header(row, waiting) };
  }

  /** The hand-over line of a Run, when it has one: the executor changed, or the same one went on and the message still carried the conversation (again, or what a clear had cut off) or went alone though something was owed. */
  private handOver(row: RunRow, run: WireRun): SwitchItem | null {
    const previous = this.facts.previous(row), to = this.executor(row);
    if (previous !== null && changed(previous, row)) return switchOf(run, this.executor(previous), to);
    if (run.relay !== undefined && (run.relay.packetId !== null || run.relay.decision?.kind === "alone")) return switchOf(run, to, to);
    return null;
  }
  /** The lines of a Run that end it: its own error when it failed or was left unknown, and the clear. */
  private endings(row: RunRow): (ErrorItem | ContextEventItem)[] {
    const facts = row.facts, lines: (ErrorItem | ContextEventItem)[] = [];
    if (facts.error !== null && (row.status === "failed" || row.status === "unknown")) {
      lines.push({ id: "hh:error", seq: LINE_SEQ.error, status: "failed", type: "error", class: errorClass(facts.error.code), code: facts.error.code, message: facts.error.message });
    }
    if (facts.backend?.reason === "cleared") lines.push({ id: "hh:clear", seq: LINE_SEQ.clear, status: "completed", type: "context_event", kind: "clear" });
    return lines;
  }
  /**
   * Everything of a Run that is made when it is read and no row holds: its hand-over line, the lines that end it, and, once it completed, its answer marked `final`.
   * A commit's frame carries these with the Run (the page replaces them by their places), so that what a stream builds is what a read gives.
   */
  derived(row: RunRow, run: WireRun = this.run(row)): readonly WireItem[] {
    const lines: WireItem[] = [], over = this.handOver(row, run);
    if (over !== null) lines.push(over);
    lines.push(...this.endings(row));
    if (row.status === "completed" && this.facts.answer !== undefined) {
      const answer = this.facts.answer(row);
      if (answer !== null) lines.push(wireItem(answer, { final: true }));
    }
    return lines;
  }

  // ---- the items ----------------------------------------------------------------------------------------------------

  /** The derived values of a call worked out again with the head of its stored detail, as the projection does; null when the call keeps what it has (no detail to read, or no row to make). */
  private rederived(row: RunRow, item: HeldItem): { readonly type: ItemRow["type"]; readonly fields: ItemFields } | null {
    const ref = (item.fields as { readonly detail?: ContentRef }).detail;
    if (ref === undefined || this.env.detail === undefined) return null;
    const head = this.env.detail(ref);
    if (head === null) return null;
    const found = normalizeTool(callOf(item), { seq: item.seq, detail: head, turn: turnOf(row.status) });
    if (!found.row) return null;
    const { id: _id, seq: _seq, status: _status, startedAt: _started, endedAt: _ended, parentId: _parent, ...fields } = found.item;
    return { type: found.item.type, fields: { ...fields, ...(item.fields.native === undefined ? {} : { native: item.fields.native }) } as ItemFields };
  }
  /** One stored item as the wire has it (a read of a page of items, the items of a Turn). `final`: it is the answer of a completed Turn. */
  item(row: RunRow, held: HeldItem, options: { readonly final?: boolean } = {}): WireItem {
    const leftOut = held.bodyOmitted === true || held.textOmitted === true;
    let source: ItemRow = held;
    if (row.legacyOrder && held.bodyOmitted !== true && held.itemId.startsWith("tool:")) {
      const again = this.rederived(row, held);
      if (again !== null) source = { ...held, type: again.type, fields: again.fields };
    }
    // A notice's label is `native.title`: a chunk is never changed, and the title of a retry or a review told as an activity may change while it runs.
    const label = held.type === "notice" && held.bodyOmitted !== true ? held.fields.native?.title : undefined;
    const text = label !== undefined ? label : held.textOmitted === true || held.text.length === 0 ? undefined : textOf(held);
    return wireItem(source, { stub: held.bodyOmitted === true, bodyOmitted: leftOut, ...(text === undefined ? {} : { text }), ...(leftOut && held.textBytes > 0 ? { textBytes: held.textBytes } : {}),
      ...(options.final === true ? { final: true } : {}) });
  }

  /** A Turn: its Run with its header, its items in the order of their places between its hand-over line and the lines that end it, and the stretch of work a window left out. */
  turn(read: TurnItems): WireTurn {
    const row = read.run, ended = runEnded(row.status), held = read.items;
    const waiting = !ended && held.some(item => item.status === "waiting");
    const run = this.run(row, waiting);
    const answer = row.status === "completed" ? finalItemSeq(held, row.status) : null;
    // The Harness's task list is the Turn's plan, not a row: a plan of its own stands for every such call; without one, the last call whose stored input reads exactly gives it.
    const hasPlan = held.some(item => item.itemId === "plan");
    const calls = new Set<string>(), hidden = new Set<number>();
    let derived: { readonly seq: number; readonly steps: readonly PlanStep[] } | null = null;
    for (const item of held) if (item.itemId.startsWith("tool:")) calls.add(item.fields.native?.id ?? item.itemId.slice(5));
    for (const item of held) {
      if (item.itemId.startsWith("tool:") && item.type === "tool" && item.bodyOmitted !== true) {
        const verdict = normalizeTool(callOf(item), { seq: item.seq, detail: null, turn: turnOf(row.status) });
        if (verdict.row) continue;
        const ref = (item.fields as { readonly detail?: ContentRef }).detail;
        const head = hasPlan || ref === undefined || this.env.detail === undefined ? null : this.env.detail(ref);
        const steps = hasPlan ? null : planFromInput(head?.input);
        if (hasPlan || steps !== null) { hidden.add(item.seq); if (steps !== null) derived = { seq: item.seq, steps }; }
      } else if (item.itemId.startsWith("activity:") && item.type === "subagent") {
        // A sub-agent the Harness reports as a call and as an activity is the call already listed.
        const id = item.fields.native?.id ?? item.itemId.slice(9);
        if (calls.has(id) || calls.has("agent:" + id.slice(0, 200))) hidden.add(item.seq);
      }
    }
    const items: WireItem[] = [];
    const over = this.handOver(row, run);
    if (over !== null) items.push(over);
    for (const item of held) {
      if (derived !== null && item.seq === derived.seq) {
        const plan: PlanItem = { id: "hh:plan", seq: item.seq, status: ended ? "completed" : "running", type: "plan", steps: derived.steps };
        items.push(plan); continue;
      }
      if (hidden.has(item.seq)) continue;
      // A thinking that was there and said nothing is kept in the rows (a conversion loses nothing) and is no line to draw.
      if (item.type === "reasoning" && item.textBytes === 0) continue;
      items.push(this.item(row, item, { final: item.seq === answer }));
    }
    items.push(...this.endings(row));
    return { run, items, ...(read.deferred === undefined ? {} : { deferred: read.deferred }) };
  }
}
