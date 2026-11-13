import type { Conversation, ConversationRun, HeldItem, RecoverConversation } from "../../../contracts/conversation.js";
import type { BindingRelayState } from "../../../contracts/relay.js";
import { SessionError, type EventDraft, type MessageId, type NativeSessionBinding, type PublicSwitch, type RunId } from "../../../contracts/session.js";
import { settleItems, type TerminalStatus } from "./items-place.js";
import { terminal } from "./state.js";
import { restored, sound } from "./store-conversion.js";

/*
 * The reducers of a conversation held as rows (ADR-057 3.3, stage 1) and the checks made of the rows a commit changed. The conversation is the head, every
 * Run as a light row, and the items of the Runs not finished; a reducer returns the next one and changes only what it names, so that the store finds what
 * changed by comparing object identity (infrastructure/session/diff.ts). What is checked here is what no key or trigger of the tables can say: who may
 * change a binding, that a selection moves only with an epoch, that a Run's context sources and a switch's are earlier Runs that finished. The relations of
 * the whole conversation (`verify`) are checked in the tests, the migration and a maintenance command, never in a commit; and nothing here counts or measures
 * anything of a conversation's size or content.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------------------------------------

/** The place of a Run among the Runs (it is looked for from the end: the Runs that move are the last ones), or -1. */
export function runIndex(runs: readonly ConversationRun[], id: string): number {
  for (let at = runs.length - 1; at >= 0; at--) if (runs[at]!.id === id) return at;
  return -1;
}
export function runIn(state: Pick<Conversation, "runs">, id: string): ConversationRun | undefined {
  const at = runIndex(state.runs, id);
  return at < 0 ? undefined : state.runs[at];
}
/** The conversation with one Run changed by `patch`; every other Run is the same object. */
export function updatedRun(state: Conversation, id: string, patch: Partial<ConversationRun>): Conversation {
  const at = runIndex(state.runs, id);
  if (at < 0) throw new SessionError("IDENTITY_MISMATCH", "Run is not owned by this Session");
  const runs = state.runs.slice();
  runs[at] = { ...state.runs[at]!, ...patch };
  return { ...state, runs };
}
/**
 * The items a Run holds after a commit that gives it the Turn's: an item of the Turn that is the item the conversation holds (nothing of it changed) is that very
 * object, so that the next comparison passes it by its identity; one that changed keeps what the store wrote into the one it replaces (the seq of the event that made
 * it, which `place` leaves for the store to write), and a new one is as the Turn has it. Both lists are in the order of the items' seq.
 */
export function heldItems(held: readonly HeldItem[] | undefined, items: readonly HeldItem[]): readonly HeldItem[] {
  if (held === undefined || held.length === 0) return items;
  const result: HeldItem[] = [];
  let at = 0;
  for (const item of items) {
    while (at < held.length && held[at]!.seq < item.seq) at++;
    const was = at < held.length && held[at]!.seq === item.seq ? held[at]! : undefined;
    if (was === undefined) result.push(item);
    else if (was === item || (was.status === item.status && was.endedAt === item.endedAt && was.startedAt === item.startedAt && was.parentId === item.parentId && was.type === item.type && was.fields === item.fields
      && was.textChunks === item.textChunks && was.textBytes === item.textBytes && was.itemId === item.itemId)) result.push(was);
    else result.push(was.createdSeq === null || item.createdSeq === was.createdSeq ? item : { ...item, createdSeq: was.createdSeq });
  }
  return result;
}
/** The conversation with the items of a Run not finished replaced by the Turn's (`items`: items-place.ts `itemsOf`), merged with what the conversation holds of them (`heldItems`). */
export function withItems(state: Conversation, id: string, items: readonly HeldItem[]): Conversation { return updatedRun(state, id, { items: heldItems(runIn(state, id)?.items, items) }); }

/** The first item of a Run: the input it was accepted with, as a user message of one chunk. */
export function userItemOf(run: { readonly id: RunId; readonly userMessageId: MessageId }, input: string, at: number): HeldItem {
  const { text, marks } = sound(input);
  return { runId: run.id, seq: 1, itemId: "user", type: "user_message", status: "completed", startedAt: at, endedAt: at, parentId: null, createdSeq: null, textBytes: new TextEncoder().encode(text).byteLength, textChunks: 1,
    fields: marks.length === 0 ? { type: "user_message", messageId: run.userMessageId } : { type: "user_message", messageId: run.userMessageId, native: { surrogates: marks } }, text: [text] };
}
/** The input of a Run not finished (the text of its `user` item); a finished Run holds no items, and its input is read by Turn. */
export function inputOf(run: ConversationRun): string {
  const user = run.items?.find(item => item.itemId === "user");
  if (user === undefined) throw new SessionError("INVALID_DATA", "the input of Run " + run.id + " is not held: only a Run not finished holds its items");
  return restored(user);
}

// ---------------------------------------------------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------------------------------------------------

/** The latest time a Run recorded: its last phase, or when it was accepted; 0 for a Run from before v10, which has no times. */
function lastTime(run: ConversationRun): number {
  const timing = run.timing;
  if (timing === undefined) return 0;
  return Math.max(timing.acceptedAt, timing.preparingAt ?? 0, timing.contextReadyAt ?? 0, timing.readyAt ?? 0, timing.dispatchedAt ?? 0, timing.firstOutputAt ?? 0, timing.endedAt ?? 0, timing.recordedAt ?? 0);
}
/** The items of a Run as they are left when it ends as `status` (items-place.ts `settleItems`: what was open is told as what it was left as, never as done). */
export function settledItems(items: readonly HeldItem[], status: TerminalStatus, at: number): readonly HeldItem[] {
  const writes = settleItems(items, status, at);
  if (writes.length === 0) return items;
  const rows = new Map(writes.map(write => [write.row.seq, write.row] as const));
  return items.map(item => { const row = rows.get(item.seq); return row === undefined ? item : { ...item, status: row.status, endedAt: row.endedAt }; });
}
/**
 * Recovery creates public unknown facts; it never reconstructs a dispatch or kills a PID. A previous owner's Runs that had not finished end as unknown (or
 * cancelled, when they were only queued), with their items told as the table of items-place.ts says (a request that waited is cancelled, an action that was
 * open is unknown), and a switch it left pending fails. A process kept by the previous owner stays recorded here: the new owner's runtime recognizes and ends its
 * group, then records the outcome (ADR-030).
 */
export const recoverConversation: RecoverConversation = current => {
  const unfinished = current.runs.filter(run => !terminal(run.status));
  const pending = current.pendingSwitchId !== null;
  if (unfinished.length === 0 && !pending) return null;
  const unknown = unfinished.some(run => run.status !== "queued");
  const runs = current.runs.map((run): ConversationRun => {
    if (terminal(run.status)) return run;
    const status = run.status === "queued" ? "cancelled" as const : "unknown" as const;
    const items = run.items === undefined ? undefined : settledItems(run.items, status, lastTime(run));
    return { ...run, status, error: { code: "OWNER_ENDED", message: "previous owner ended without confirmed settlement; input was not replayed" }, ...(items === undefined ? {} : { items }) };
  });
  const switches = current.switches.map(entry => entry.id === current.pendingSwitchId ? { ...entry, status: "failed" as const, error: { code: "OWNER_ENDED", message: "pending switch was not activated after owner exit" } } : entry);
  return { next: { ...current, status: unknown ? "blocked" : current.status, activeRunId: null, pendingSwitchId: null, runs, switches },
    events: [{ type: "session.recovered", data: { unknownRunIds: runs.filter(run => run.status === "unknown").map(run => run.id), cancelledRunIds: unfinished.filter(run => run.status === "queued").map(run => run.id), replayed: false } }] };
};

// ---------------------------------------------------------------------------------------------------------------------
// What a commit may do
// ---------------------------------------------------------------------------------------------------------------------

function same(left: unknown, right: unknown): boolean { return left === right || JSON.stringify(left) === JSON.stringify(right); }
const transition = (message: string): SessionError => new SessionError("INVALID_TRANSITION", message);
/** Whether a `run.ended` event's `relay` says its relay part was refused and left out (G068 fix batch, R6). */
function relayFailed(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (value as Readonly<Record<string, unknown>>).failed === true;
}
/** Whether a `run.ended` event's `native` says its Driver cleared the native history (ADR-055 §7.5, F04). */
function clearedNative(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (value as Readonly<Record<string, unknown>>).cleared === true;
}
/**
 * One binding's relay state moving on (ADR-055 §14.3): its native epoch never goes back and its clear floor never goes down;
 * within one epoch its mark never goes down. A clear starts a new epoch, so the mark it drops is no decrease within one.
 */
function relayStep(old: BindingRelayState | undefined, next: BindingRelayState | undefined): void {
  if (next === undefined) { if (old !== undefined) throw transition("a binding's relay state cannot be dropped"); return; }
  if (old === undefined) return;
  if (next.epoch < old.epoch) throw transition("a binding's native epoch cannot go back");
  if (next.floor < old.floor) throw transition("a binding's clear floor cannot go down");
  if (next.epoch === old.epoch && next.mark < old.mark) throw transition("a binding's mark cannot go down within an epoch");
}

/**
 * The rule of who may change what, over the rows a commit changed (never the whole conversation: a Run, a binding or a switch that is the same object in both is
 * not looked at, and the loops that remain are over what changed). What the keys and triggers of the tables refuse (the identity of a Run, its accepted input, a
 * finished Run, the relay's epochs along a control, the head's pointers) is not repeated; this is the rest of the old `assertSessionTransition`:
 *
 *   - the configuration and the origin never change, and a selection changes only with one epoch;
 *   - a binding is changed only by the Run that owns it (the writer), by a native reset, or by the branch's own native fork; it is archived only by a native
 *     reset, a failed fork, the end of a Run whose Driver gave the native session up, or a Run the Hub opens a new native session for because the old one is nearly full; its relay state only goes forward; none is taken away;
 *   - the relay recovery failure is recorded by recovery (or by a Run's end committed without its relay part) and cleared by a new native session;
 *   - a closed conversation stays closed and a blocked one reopens only with the effective switch that was pending and no unknown Run left with open resources;
 *   - the sources of a Run's context and of a switch are earlier Runs that finished, and unknown Runs are acknowledged only by a recovery switch of a blocked conversation.
 */
export function assertConversationTransition(before: Conversation, after: Conversation, events: readonly EventDraft[] = []): void {
  if (before.id !== after.id || !same(before.configuration, after.configuration)) throw transition("Session identity/configuration reference is immutable");
  if (!same(before.origin, after.origin)) throw transition("branch origin is immutable");
  if (after.epoch < before.epoch || after.epoch > before.epoch + 1 || (after.epoch === before.epoch && !same(before.selection, after.selection))) throw transition("selection can change only with one effective switch epoch");
  if ((before.status === "closed" && after.status !== "closed") || (before.status === "blocked" && after.status === "open" &&
      (after.epoch !== before.epoch + 1 || !after.switches.some(sw => sw.id === before.pendingSwitchId && sw.status === "effective") || after.runs.some(run => run.status === "unknown" && run.cleanup?.closed !== true))))
    throw transition("closed or blocked Session cannot reopen implicitly");

  const oldBindings = before.nativeBindings ?? [], newBindings = after.nativeBindings ?? [];
  if (newBindings.length < oldBindings.length) throw transition("native state references cannot be silently erased");
  const added = after.commands.slice(before.commands.length);
  const writer = runIn(after, before.activeRunId ?? after.activeRunId ?? "");
  const nativeCleared = writer !== undefined && events.some(event => event.type === "run.ended" && event.data.runId === writer.id && clearedNative(event.data.native));
  // The Hub gave the writer's native session a successor before the Turn ran, because its window was nearly full (2026-11-13).
  const reseated = writer !== undefined && events.some(event => event.type === "native.binding_reseated" && event.data.runId === writer.id);
  // A branch inside the conversation (a message sent again from an earlier place, another branch chosen) gives up every native session: they hold Turns the path no longer has.
  const branched = events.some(event => event.type === "conversation.branched");
  if (before.nativeBindings !== after.nativeBindings) {
    for (let index = 0; index < newBindings.length; index++) {
      const old: NativeSessionBinding | undefined = oldBindings[index], next = newBindings[index]!;
      if (old === next || (old !== undefined && same(old, next))) continue;
      if (old?.status === "archived" || old !== undefined && (old.harnessId !== next.harnessId || old.controlId !== next.controlId)) throw transition("native state ownership or archived state changed");
      // An archived binding keeps the relay state it had: archiving freezes it (ADR-055 §4).
      const frozen = old !== undefined && same(old.relay, next.relay);
      const reset = old !== undefined && frozen && next.status === "archived" && next.checkpoint === old.checkpoint && next.throughRunId === old.throughRunId
        && (branched || after.selection.harnessId === next.harnessId && after.selection.controlId === next.controlId && added.some(command => command.kind === "native-reset"));
      // A branch's native fork advances without a Run: pending → dispatched → ready with the new reference, or archived unchanged.
      const forked = old !== undefined && frozen && next.throughRunId === null && (old.status === "fork-pending" && next.status === "forking" && next.checkpoint === old.checkpoint
        || old.status === "forking" && next.status === "ready" || (old.status === "fork-pending" || old.status === "forking") && next.status === "archived" && next.checkpoint === old.checkpoint);
      if (!reset && !forked && (!writer || writer.selection.provider !== undefined || writer.selection.harnessId !== next.harnessId || writer.selection.controlId !== next.controlId || next.throughRunId !== null && next.throughRunId !== old?.throughRunId && next.throughRunId !== writer.id))
        throw transition("native state changed without its original Run owner");
      // A Run archives its own binding only when its end reports the Driver replaced the cleared native session; it may then add
      // the new binding of the same Harness control (the Hub's clear, F04).
      if (!reset && !forked && old !== undefined && next.status === "archived" && (!(nativeCleared || reseated) || !frozen)) throw transition("a native binding is archived only by a native reset, a failed branch, a confirmed native clear or the Hub's own successor to a full one");
      relayStep(old?.relay, next.relay);
    }
  }
  if (before.relayRecoveryFailed !== after.relayRecoveryFailed) {
    // Recorded by recovery, or by a writer Run's end committed without the relay part the Store refused (`relay.failed`, R6).
    const failedEnd = (event: EventDraft) => event.type === "run.ended" && writer !== undefined && event.data.runId === writer.id && relayFailed(event.data.relay);
    const recorded = after.relayRecoveryFailed !== undefined && events.some((event, index) => (event.type === "session.recovered" || failedEnd(event)) && before.lastSeq + index + 1 === after.relayRecoveryFailed);
    const renewed = added.some(entry => entry.kind === "native-reset") || newBindings.length > oldBindings.length || branched;
    if (after.relayRecoveryFailed !== undefined ? !recorded : !renewed) throw transition("a relay recovery failure is recorded by recovery and cleared by a new native session");
  }

  // The Runs that changed: the sources of a context, once they are set, are Runs that finished before this input was accepted. Only a new Run and the active one can have
  // had them set by this commit (a Run gets its sources when it is prepared to run, and a finished Run changes no more).
  if (after.runs !== before.runs) {
    let byId: Map<string, ConversationRun> | undefined;
    const active = runIndex(after.runs, before.activeRunId ?? after.activeRunId ?? ""), candidates = [...(active < 0 ? [] : [active]), ...Array.from({ length: Math.max(0, after.runs.length - before.runs.length) }, (_, at) => before.runs.length + at)];
    for (const index of candidates) {
      const run = after.runs[index]!, was = before.runs[index];
      if (run === was || run.sourceRunIds.length === 0 || was?.sourceRunIds === run.sourceRunIds) continue;
      byId ??= new Map(after.runs.map(row => [row.id, row] as const));
      if (new Set(run.sourceRunIds).size !== run.sourceRunIds.length) throw transition("a Run's context sources are not unique");
      for (const id of run.sourceRunIds) {
        const source = byId.get(id);
        if (source === undefined || source.id === run.id || !terminal(source.status) || source.userSeq >= run.userSeq) throw transition("Run context sources are inconsistent or from future input");
      }
      if (run.contextThroughSeq > after.lastSeq + events.length) throw transition("Run context watermark is after the Session's events");
    }
  }
  // The switches that changed or are new: their sources finished (or are the active Run of a switch not yet effective) and came before the request; what was acknowledged ended unknown, closed.
  if (after.switches !== before.switches) {
    let byId: Map<string, ConversationRun> | undefined;
    for (let index = 0; index < after.switches.length; index++) {
      const entry: PublicSwitch = after.switches[index]!, was = before.switches[index];
      if (entry === was) continue;
      if (was !== undefined && (was.status === "effective" || was.status === "failed")) continue;
      byId ??= new Map(after.runs.map(row => [row.id, row] as const));
      const preparing = entry.status === "requested" || entry.status === "validated";
      if (new Set(entry.sourceRunIds).size !== entry.sourceRunIds.length) throw transition("switch sources are not unique");
      for (const id of entry.sourceRunIds) {
        const source = byId.get(id);
        if (source === undefined || !(terminal(source.status) || (preparing && source.id === after.activeRunId)) || source.userSeq >= entry.requestedSeq) throw transition("switch watermark/sources are inconsistent");
      }
      for (const id of entry.acknowledgedUnknown ?? []) {
        const source = byId.get(id);
        if (source === undefined || source.status !== "unknown" || source.cleanup?.closed !== true || source.userSeq >= entry.requestedSeq) throw transition("an acknowledged Run is not an earlier unknown Run with closed resources");
      }
      // Only a recovery switch acknowledges unknown Runs, and only a blocked conversation takes one (RT1-m10).
      if (was === undefined && entry.acknowledgedUnknown?.length && before.status !== "blocked") throw transition("unknown Runs are acknowledged only by a recovery switch");
    }
  }
}
