import type {
  Conversation, ConversationReader, ConversationRun, HeldItem, RunRow, TurnItems, Violation, VerifyConversation, VerifyTransition,
} from "../../../contracts/conversation.js";
import type { EventDraft, NativeSessionBinding, PublicSwitch, SessionId } from "../../../contracts/session.js";
import type { BindingRelayState } from "../../../contracts/relay.js";
import { runEnded } from "./protocol/index.js";

/*
 * The whole-conversation check of ADR-057 3.3 (task T8). The relations that `parseSession` checked on every commit of the old store (state.ts
 * 350-468) now stand over the rows of a `Conversation`, with maps in place of its two searches inside searches, so that a conversation of ten
 * thousand Turns is checked in time that grows with its size; and the transitions it checked (state.ts 523-599, `assertSessionTransition`) over
 * a conversation and the one a commit made of it. Both return the violations they find and never throw. The ADR's table says who guarantees each
 * invariant in production (a key, an index, a trigger, a check on the rows a commit changed); this is the one place that checks them all
 * from outside, in three places that are not the commit path: the tests after every commit, the migration after every conversation it
 * converted, and a maintenance command. It reads no store: what it needs of Turns that are not in memory it asks the `ConversationReader`.
 *
 *   `verify(conversation, reader)`    what must be true of a conversation at any one moment (rows 1 to 8 of review M6, and the rest of
 *                                     the relations of parseSession).
 *   `verifyTransition(before, after)` what must be true of a conversation and the next one a commit made (rows 9 and 10: who may change a binding,
 *                                     that a relay state only goes forward, that what a dispatched Run was given is fixed; and the rest of
 *                                     assertSessionTransition): a state cannot tell these.
 *
 * WHAT IS NOT HERE, ON PURPOSE (ADR 3.3, the last two rows): the relation of a message to its Run, its seq and its status (a message is an item,
 * and `userSeq` cannot change), and every count and byte limit (there are none).
 */

/** The names a `Violation.rule` of `verify` takes, grouped as the checks below are. */
export const VERIFY_RULES = [
  // identity and order
  "run-ordinals-are-indexes", "run-ids-unique", "message-ids-unique", "switch-ids-unique", "command-ids-unique", "run-user-seqs-increase", "run-ended-seq-placed", "run-effects-belong-to-commands",
  // the head
  "one-active-run", "head-active-run", "one-pending-switch", "head-pending-switch", "closed-conversation-idle",
  // unknown Runs and their acknowledgement (the floor: an open conversation holds no unknown Run nobody acknowledged)
  "open-conversation-unclaimed-unknown", "acknowledgement-materialized", "acknowledgement-is-first-claim", "acknowledged-run-is-unknown",
  // epochs and selection
  "epoch-counts-effective-switches", "selection-is-last-effective-target", "run-epoch-within-conversation", "run-context-within-events", "switch-seqs-within-events",
  // commands
  "one-create-command", "run-send-command", "switch-switch-command", "command-result-exists",
  // Runs
  "queued-run-without-execution", "running-run-unsettled", "settling-run-has-backend", "completed-run-settled-and-closed", "run-sources-unique", "run-awaits-existing-switch",
  "run-sources-finished-and-earlier", "run-sources-within-watermark", "retained-run-completed-without-cleanup", "reused-run-started-native", "run-executed-on-own-selection", "kept-process-belongs-to-handing-run",
  // switches
  "switch-target-present", "switch-sources-unique", "switch-sources-finished", "switch-sources-before-request", "acknowledged-unknown-valid",
  // bindings and origins
  "binding-has-relay-state", "binding-lineage", "one-live-binding-per-control", "native-cursor-finished-native-run", "native-cursor-settled-and-closed",
  "opens-new-binding-shape", "fork-binding-has-fork-origin", "import-origin-has-native-reference", "relay-recovery-failed-within-events", "branch-not-from-itself",
  // items (of the Runs held in memory, and of the others as the reader gives them)
  "run-has-user-item", "item-seqs-increase", "item-ids-unique", "finished-run-no-open-item", "item-chunks-well-formed", "item-text-counts",
  // what the store holds
  "head-agrees", "run-row-agrees",
  // content: what the rows mention is what the collector keeps
  "content-refs-complete",
] as const;
export type VerifyRule = typeof VERIFY_RULES[number];

/** The names a `Violation.rule` of `verifyTransition` takes. */
export const TRANSITION_RULES = [
  "transition-identity-fixed", "transition-origin-fixed", "transition-history-append-only", "transition-commands-fixed", "transition-no-implicit-reopen", "transition-epoch-step",
  "transition-bindings-kept", "transition-binding-owner", "transition-binding-archive", "transition-relay-forward", "transition-relay-recovery-failed",
  "transition-run-fixed-when-finished", "transition-run-input-fixed", "transition-run-tombstones-kept", "transition-run-evidence-once", "transition-run-selection-fixed", "transition-run-context-fixed",
  "transition-switch-evidence-fixed", "transition-switch-request-fixed", "transition-acknowledgement-by-recovery", "transition-acknowledgement-once", "transition-items-append-only",
] as const;
export type TransitionRule = typeof TRANSITION_RULES[number];

// ---------------------------------------------------------------------------------------------------------------------------------
// Small things both checks use
// ---------------------------------------------------------------------------------------------------------------------------------

/** Equal as JSON values are: the same keys (an absent key and an undefined one are the same) with equal values, whatever order they were written in. */
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) { const other = right as readonly unknown[]; return left.length === other.length && left.every((item, at) => same(item, other[at])); }
  const a = left as Readonly<Record<string, unknown>>, b = right as Readonly<Record<string, unknown>>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined), count = Object.keys(b).filter(key => b[key] !== undefined).length;
  return keys.length === count && keys.every(key => same(a[key], b[key]));
}
const OPEN_ITEM = new Set(["pending", "running", "waiting"]);
const ACTIVE_RUN = new Set(["preparing", "running", "settling"]);
const PENDING_SWITCH = new Set(["requested", "validated"]);
/** Whether a Run's closure is confirmed: its process closed and no protocol failure with it. */
function closedClean(run: ConversationRun): boolean { return run.cleanup?.closed === true && run.cleanup.protocolFailure === null; }
/** Whether an effective switch claims a Run as acknowledged: its own list has it or, in a conversation from before the lists, its sources do. */
function claims(entry: PublicSwitch, run: string): boolean { return (entry.acknowledgedUnknown as readonly string[] | undefined)?.includes(run) === true || (entry.sourceRunIds as readonly string[]).includes(run); }
const hasLoneSurrogate = (text: string): boolean => /[\ud800-\udfff]/u.test(text);
const encoder = new TextEncoder();
/** A Turn as the store holds it, or null when it holds none (or cannot say). `whole`: nothing left out for its size (an item's JSON longer than a page is whole). */
function reading(reader: ConversationReader, id: SessionId, ordinal: number, whole = false): TurnItems | null {
  try { return whole ? reader.turnAt(id, ordinal, { inlineBytes: Infinity }) : reader.turnAt(id, ordinal); } catch { return null; }
}
const CONTENT_ID = /^content-[A-Za-z0-9-]{1,96}$/u;
/**
 * The content a JSON value mentions: the id of every object in it that is a content reference (an id of content together with the digest of its bytes). It looks at
 * the shape and not at where the writers put references, so that a place the writers forgot is found all the same.
 */
export function mentionedContent(value: unknown, found: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 32 || value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) { for (const entry of value) mentionedContent(entry, found, depth + 1); return found; }
  const row = value as Readonly<Record<string, unknown>>;
  if (typeof row.id === "string" && CONTENT_ID.test(row.id) && typeof row.sha256 === "string") found.add(row.id);
  for (const entry of Object.values(row)) mentionedContent(entry, found, depth + 1);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Every relation the old store checked of a whole conversation, over the rows. `reader` supplies what is not in memory: the items of the
 * Runs that are finished (a Turn's messages are among them, for the watermark a Run's sources must stay under) and the head and Run rows
 * the store holds, which must say what the conversation says. A violation has the rule that failed, where, and what.
 */
export const verify: VerifyConversation = (conversation: Conversation, reader: ConversationReader): readonly Violation[] => {
  const found: Violation[] = [];
  const say = (rule: VerifyRule, where: string, detail: string): void => { found.push({ rule, where, detail }); };
  const runs = conversation.runs, switches = conversation.switches, commands = conversation.commands, bindings = conversation.nativeBindings ?? [];
  const open = conversation.status === "open";

  // The maps that stand in for the searches: Runs by id, switches by id, commands by id (and the sends by the Run they answer).
  const byId = new Map<string, ConversationRun>(), firstAt = new Map<string, number>(), switchById = new Map<string, PublicSwitch>(), commandById = new Map<string, number>(), sends = new Map<string, number>();
  const messageIds = new Set<string>();
  runs.forEach((run, index) => {
    if (run.ordinal !== index) say("run-ordinals-are-indexes", "run " + run.id, "its ordinal is " + run.ordinal + " and it stands at index " + index);
    if (byId.has(run.id)) say("run-ids-unique", "run " + run.id, "two Runs have this identity"); else { byId.set(run.id, run); firstAt.set(run.id, index); }
    for (const id of [run.userMessageId, run.assistantMessageId]) { if (messageIds.has(id)) say("message-ids-unique", "run " + run.id, "the message identity " + id + " is declared twice"); messageIds.add(id); }
  });
  for (const entry of switches) { if (switchById.has(entry.id)) say("switch-ids-unique", "switch " + entry.id, "two switches have this identity"); else switchById.set(entry.id, entry); }
  for (const command of commands) {
    commandById.set(command.id, (commandById.get(command.id) ?? 0) + 1);
    if (command.kind === "send") sends.set(command.id + "\n" + command.resultId, (sends.get(command.id + "\n" + command.resultId) ?? 0) + 1);
  }
  for (const [id, count] of commandById) if (count > 1) say("command-ids-unique", "command " + id, "it is committed " + count + " times");

  // Who acknowledged each unknown Run: the first effective switch that claims it (a switch before the Run could not, and one after it only repeats the claim).
  const claimed = new Map<string, PublicSwitch>();
  for (const entry of switches) if (entry.status === "effective") for (const id of [...entry.acknowledgedUnknown ?? [], ...entry.sourceRunIds]) if (!claimed.has(id)) claimed.set(id, entry);

  // Order: the user messages of the Runs come one after another, the end of a Run lies after its start, and neither is after the last event.
  let previous = 0;
  for (const run of runs) {
    if (run.userSeq < 1 || run.userSeq > conversation.lastSeq || run.userSeq <= previous) say("run-user-seqs-increase", "run " + run.id, "the seq of its input is " + run.userSeq + " after " + previous + " (the conversation's last event is " + conversation.lastSeq + ")");
    previous = Math.max(previous, run.userSeq);
    if (run.endedSeq !== undefined && (!runEnded(run.status) || run.endedSeq <= run.userSeq || run.endedSeq > conversation.lastSeq))
      say("run-ended-seq-placed", "run " + run.id, "it ends at " + run.endedSeq + " (status " + run.status + ", input at " + run.userSeq + ", last event " + conversation.lastSeq + ")");
    if ((run.commandEffect !== undefined || run.settledEffect !== undefined) && !run.isCommand || run.settledEffect !== undefined && !runEnded(run.status))
      say("run-effects-belong-to-commands", "run " + run.id, "it has a context effect and is " + (run.isCommand ? "not finished" : "no native command"));
  }

  // The head: at most one active Run and it is the head's; at most one pending switch and it is the head's; a closed conversation takes no work.
  const active = runs.filter(run => ACTIVE_RUN.has(run.status)), pending = switches.filter(entry => PENDING_SWITCH.has(entry.status));
  if (active.length > 1) say("one-active-run", "conversation " + conversation.id, active.length + " Runs are active: " + active.map(run => run.id).join(", "));
  else if (conversation.activeRunId === null ? active.length !== 0 : active.length !== 1 || active[0]!.id !== conversation.activeRunId)
    say("head-active-run", "conversation " + conversation.id, "the head names " + (conversation.activeRunId ?? "no Run") + " as active and the Runs say " + (active.map(run => run.id).join(", ") || "none"));
  if (pending.length > 1) say("one-pending-switch", "conversation " + conversation.id, pending.length + " switches are pending: " + pending.map(entry => entry.id).join(", "));
  else if (conversation.pendingSwitchId === null ? pending.length !== 0 : pending.length !== 1 || pending[0]!.id !== conversation.pendingSwitchId)
    say("head-pending-switch", "conversation " + conversation.id, "the head names " + (conversation.pendingSwitchId ?? "no switch") + " as pending and the switches say " + (pending.map(entry => entry.id).join(", ") || "none"));
  if (conversation.status === "closed" && (conversation.activeRunId !== null || conversation.pendingSwitchId !== null || runs.some(run => run.status === "queued"))) say("closed-conversation-idle", "conversation " + conversation.id, "it is closed and still admits work");

  // The floor (ADR 3.3): an open conversation holds no unknown Run that nobody acknowledged, and a Run's acknowledgement is the first effective switch that claims it.
  for (const run of runs) {
    if (run.status !== "unknown") {
      if (run.acknowledgedBy !== undefined) say("acknowledged-run-is-unknown", "run " + run.id, "it is " + run.status + " and says " + run.acknowledgedBy + " acknowledged it");
      continue;
    }
    const first = claimed.get(run.id);
    if (run.acknowledgedBy === undefined) {
      if (open) say("open-conversation-unclaimed-unknown", "run " + run.id, "the conversation is open and no switch acknowledged this unknown Run");
      else if (first !== undefined) say("acknowledgement-materialized", "run " + run.id, "the effective switch " + first.id + " claims it and the Run does not say so");
    } else {
      const named = switchById.get(run.acknowledgedBy);
      if (named === undefined || named.status !== "effective" || !claims(named, run.id)) say("acknowledgement-is-first-claim", "run " + run.id, "it names " + run.acknowledgedBy + ", which is " + (named === undefined ? "no switch" : named.status === "effective" ? "not a claim on it" : "not effective"));
      else if (first !== undefined && first.id !== named.id) say("acknowledgement-is-first-claim", "run " + run.id, "it names " + named.id + " and " + first.id + " claimed it first");
      if (open && run.cleanup?.closed !== true) say("open-conversation-unclaimed-unknown", "run " + run.id, "the conversation is open and the resources of this unknown Run are not confirmed closed");
    }
  }

  // Epochs: one per effective switch, plus the first; the selection is the last target; a Run is not from a later epoch or a later event than the conversation's.
  const effective = switches.filter(entry => entry.status === "effective");
  if (conversation.epoch !== effective.length + 1) say("epoch-counts-effective-switches", "conversation " + conversation.id, "its epoch is " + conversation.epoch + " and " + effective.length + " switches are effective");
  const last = effective.at(-1);
  if (last?.target != null && !same(last.target, conversation.selection)) say("selection-is-last-effective-target", "switch " + last.id, "the conversation selects something other than the target of its last effective switch");
  for (const run of runs) {
    if (run.epoch < 1 || run.epoch > conversation.epoch) say("run-epoch-within-conversation", "run " + run.id, "its epoch is " + run.epoch + " and the conversation's is " + conversation.epoch);
    if (run.contextThroughSeq > conversation.lastSeq) say("run-context-within-events", "run " + run.id, "its context reaches event " + run.contextThroughSeq + " and the last is " + conversation.lastSeq);
  }
  for (const entry of switches) if (entry.requestedSeq > conversation.lastSeq || entry.throughSeq > conversation.lastSeq) say("switch-seqs-within-events", "switch " + entry.id, "it was asked for at " + entry.requestedSeq + " and reaches " + entry.throughSeq + " (last event " + conversation.lastSeq + ")");

  // Commands: one creation; a send per Run and a switch command per switch; every result exists.
  if (commands.filter(entry => entry.kind === "create").length !== 1) say("one-create-command", "conversation " + conversation.id, "it has " + commands.filter(entry => entry.kind === "create").length + " create commands");
  for (const run of runs) if (sends.get(run.commandId + "\n" + run.id) !== 1) say("run-send-command", "run " + run.id, "it answers " + (sends.get(run.commandId + "\n" + run.id) ?? 0) + " send commands named " + run.commandId);
  for (const entry of switches) if (commands.filter(command => command.id === entry.commandId && command.kind === "switch" && command.resultId === entry.id).length !== 1) say("switch-switch-command", "switch " + entry.id, "it does not answer exactly one switch command named " + entry.commandId);
  for (const command of commands) {
    const ok = command.kind === "send" ? byId.has(command.resultId) : command.kind === "switch" ? switchById.has(command.resultId) : command.kind === "cancel" ? command.resultId === "none" || byId.has(command.resultId)
      : command.kind === "permission" || command.kind === "steer" ? byId.has(command.resultId) : command.resultId === conversation.id;
    if (!ok) say("command-result-exists", "command " + command.id, "its " + command.kind + " result " + command.resultId + " is not there");
  }

  // Runs one by one.
  for (const run of runs) {
    const where = "run " + run.id;
    if (run.status === "queued" && (run.backend !== null || run.cleanup !== null || run.stopRequested || run.contextThroughSeq !== 0 || run.sourceRunIds.length !== 0 || (run.items ?? []).some(item => item.itemId !== "user")))
      say("queued-run-without-execution", where, "it is queued and holds evidence of an execution");
    if (run.status === "running" && (run.backend !== null || run.cleanup !== null)) say("running-run-unsettled", where, "it is running and holds settlement evidence");
    if (run.status === "settling" && run.backend === null) say("settling-run-has-backend", where, "it is settling and has no backend result");
    if (run.status === "completed" && (run.backend?.status !== "completed" || run.retained !== true && !closedClean(run))) say("completed-run-settled-and-closed", where, "it is completed without a completed backend and a clean closure");
    if (new Set(run.sourceRunIds).size !== run.sourceRunIds.length) say("run-sources-unique", where, "it names a source Run twice");
    if (run.awaitingSwitchId !== null && !switchById.has(run.awaitingSwitchId)) say("run-awaits-existing-switch", where, "it awaits " + run.awaitingSwitchId + ", which is no switch");
    if (run.retained === true && (run.status !== "completed" || run.cleanup !== null || run.backend === null)) say("retained-run-completed-without-cleanup", where, "it handed its process over and is not a completed Run without a closure of its own");
    if (run.reused === true && (run.status === "queued" || run.selection.provider !== undefined)) say("reused-run-started-native", where, "it reused a kept process and is not a started native Run");
    const on = run.relay?.executedOn;
    if (on != null && (run.selection.provider !== undefined || on.harnessId !== run.selection.harnessId || on.controlId !== run.selection.controlId)) say("run-executed-on-own-selection", where, "it ran on a native session that is not its own selection's");
  }

  // Each Run's Turn is read once: its items are checked (those held in memory, or those the store gives for a finished Run), the last of its messages
  // (what a later Run's context watermark must cover) is noted, and its row is kept for the comparison with the store at the end.
  const lastMessage: number[] = [], rows: (RunRow | null)[] = [], mentions: { readonly id: string; readonly where: string }[] = [];
  runs.forEach((run, position) => {
    const where = "run " + run.id, turn = reading(reader, conversation.id, run.ordinal), held = run.items !== undefined;
    rows[position] = turn?.run ?? null;
    let items: readonly HeldItem[] | null = held ? run.items! : turn === null ? null : turn.items;
    if (items === null) return;
    // What the items mention of content (an item whose JSON was left out for its size is read again whole).
    if (items.some(item => item.bodyOmitted === true)) items = reading(reader, conversation.id, run.ordinal, true)?.items ?? items;
    for (const item of items) for (const id of mentionedContent(item.fields)) mentions.push({ id, where: where + " item " + item.seq + " (" + item.itemId + ")" });
    if (items.length === 0 || items[0]!.itemId !== "user" || items[0]!.seq !== 1 || items[0]!.createdSeq !== run.userSeq) say("run-has-user-item", where, "its first item is not its user message at seq 1 created at " + run.userSeq);
    const ids = new Set<string>();
    let top = run.userSeq;
    items.forEach((item, at) => {
      const place = where + " item " + item.seq + " (" + item.itemId + ")";
      if (item.seq < 1 || at > 0 && item.seq <= items[at - 1]!.seq) say("item-seqs-increase", place, "its seq does not follow the item before it");
      if (ids.has(item.itemId)) say("item-ids-unique", place, "the id is used by an earlier item of the Run"); else ids.add(item.itemId);
      if (runEnded(run.status) && OPEN_ITEM.has(item.status)) say("finished-run-no-open-item", place, "the Run is " + run.status + " and the item is " + item.status);
      if (item.text.some(hasLoneSurrogate)) say("item-chunks-well-formed", place, "a chunk of its text holds half of a surrogate pair");
      // A text the reader left out for its size (`textOmitted`: it is read by range) has nothing here to count against.
      if (!held && item.textOmitted !== true && (item.textChunks !== item.text.length || item.textBytes !== item.text.reduce((total, chunk) => total + encoder.encode(chunk).byteLength, 0))) say("item-text-counts", place, "its counters say " + item.textChunks + " chunks and " + item.textBytes + " bytes and its chunks are not those");
      if ((item.type === "user_message" || item.type === "assistant_message") && item.createdSeq !== null) top = Math.max(top, item.createdSeq);
    });
    lastMessage[position] = top;
  });

  // Content: the collector keeps content by the references registered for a conversation and by nothing else, so every content the rows mention (the details and contents of
  // the items, the Runs' attachments, the history a branch quoted) must be among them; one that is not is content the next collection deletes while a Turn still shows it.
  if (reader.references !== undefined) {
    let registered: ReadonlySet<string> | null = null;
    try { registered = reader.references(conversation.id); } catch { registered = null; }
    if (registered !== null) {
      for (const run of runs) for (const id of mentionedContent({ ...run, items: undefined })) mentions.push({ id, where: "run " + run.id });
      let quoted: readonly { readonly message: unknown }[] = [];
      try { quoted = reader.originHistory?.(conversation.id) ?? []; } catch { quoted = []; }
      quoted.forEach((row, at) => { for (const id of mentionedContent(row.message)) mentions.push({ id, where: "conversation " + conversation.id + " quoted message " + at }); });
      const told = new Set<string>();
      for (const mention of mentions) {
        if (registered.has(mention.id) || told.has(mention.id + "\n" + mention.where)) continue;
        told.add(mention.id + "\n" + mention.where);
        say("content-refs-complete", mention.where, "it mentions the content " + mention.id + " and no reference to it is registered for the conversation");
      }
    }
  }

  // The sources a Run carries: finished, accepted before it, and no later than its context watermark (the user's words and the reply of each).
  for (const run of runs) {
    for (const id of run.sourceRunIds) {
      const source = byId.get(id);
      if (source === undefined || source.id === run.id || !runEnded(source.status) || source.userSeq >= run.userSeq) {
        say("run-sources-finished-and-earlier", "run " + run.id, "its source " + id + " is " + (source === undefined ? "no Run" : source.id === run.id ? "itself" : !runEnded(source.status) ? "not finished" : "not accepted before it"));
      } else if ((lastMessage[firstAt.get(id)!] ?? source.userSeq) > run.contextThroughSeq) say("run-sources-within-watermark", "run " + run.id, "its source " + id + " has a message at " + lastMessage[firstAt.get(id)!] + ", past its context watermark " + run.contextThroughSeq);
    }
  }

  // The process a conversation keeps belongs to the Run that handed it over.
  const kept = conversation.retained;
  if (kept !== undefined) {
    const handed = byId.get(kept.runId);
    if (handed === undefined || handed.retained !== true || handed.selection.provider !== undefined || handed.selection.harnessId !== kept.harnessId || handed.selection.controlId !== kept.controlId)
      say("kept-process-belongs-to-handing-run", "conversation " + conversation.id, "the kept process names " + kept.runId + ", which is not a Run of " + kept.harnessId + "/" + kept.controlId + " that handed its process over");
  }

  // Switches.
  for (const entry of switches) {
    const where = "switch " + entry.id, pendingNow = PENDING_SWITCH.has(entry.status);
    if ((entry.status === "validated" || entry.status === "effective") && entry.target === null) say("switch-target-present", where, "it is " + entry.status + " and has no target");
    if (new Set(entry.sourceRunIds).size !== entry.sourceRunIds.length) say("switch-sources-unique", where, "it names a source Run twice");
    for (const id of entry.sourceRunIds) {
      const source = byId.get(id);
      if (source === undefined || !(runEnded(source.status) || pendingNow && source.id === conversation.activeRunId)) say("switch-sources-finished", where, "its source " + id + " is " + (source === undefined ? "no Run" : "neither finished nor the active Run of a pending switch"));
      else if (source.userSeq >= entry.requestedSeq) say("switch-sources-before-request", where, "its source " + id + " was accepted at " + source.userSeq + ", not before the request at " + entry.requestedSeq);
    }
    if (entry.acknowledgedUnknown !== undefined) {
      if (new Set(entry.acknowledgedUnknown).size !== entry.acknowledgedUnknown.length) say("acknowledged-unknown-valid", where, "it acknowledges a Run twice");
      for (const id of entry.acknowledgedUnknown) {
        const run = byId.get(id);
        if (run === undefined || run.status !== "unknown" || run.cleanup?.closed !== true || run.userSeq >= entry.requestedSeq) say("acknowledged-unknown-valid", where, "the Run " + id + " it acknowledges is not an earlier unknown Run with closed resources");
      }
    }
  }

  // Bindings: the relay state of each; the lineage of each Harness control; one live binding per control (which also keeps one conversation from holding a native session twice); the native position.
  const lineage = new Map<string, BindingRelayState>(), live = new Map<string, number>();
  bindings.forEach((binding: NativeSessionBinding, index) => {
    const where = "binding " + index + " (" + binding.harnessId + "/" + binding.controlId + ")", key = binding.harnessId + "\n" + binding.controlId;
    if (binding.relay === undefined) say("binding-has-relay-state", where, "it has no relay state");
    else {
      const earlier = lineage.get(key);
      if (earlier !== undefined && (binding.relay.epoch <= earlier.epoch || binding.relay.floor < earlier.floor)) say("binding-lineage", where, "its native epoch " + binding.relay.epoch + " and clear floor " + binding.relay.floor + " do not go forward from " + earlier.epoch + " and " + earlier.floor);
      lineage.set(key, binding.relay);
    }
    if (binding.status !== "archived") { if (live.has(key)) say("one-live-binding-per-control", where, "the binding " + live.get(key) + " of this control is live too"); else live.set(key, index); }
    if (binding.throughRunId !== null) {
      const run = byId.get(binding.throughRunId);
      if (run === undefined || !runEnded(run.status) || run.selection.provider !== undefined || run.selection.harnessId !== binding.harnessId || run.selection.controlId !== binding.controlId)
        say("native-cursor-finished-native-run", where, "its native position " + binding.throughRunId + " is not a finished native Run of this control");
      else if (binding.status === "ready" && (run.backend === null || run.retained !== true && !closedClean(run))) say("native-cursor-settled-and-closed", where, "its native position " + binding.throughRunId + " has no settlement and closure behind it");
    }
    if (binding.opensNew !== undefined && (binding.opensNew !== true || binding.status !== "ready" && binding.status !== "archived" || binding.throughRunId !== null || binding.relay === undefined))
      say("opens-new-binding-shape", where, "a binding that opens a new native session is ready, without a native position, with its relay state");
    if ((binding.status === "fork-pending" || binding.status === "forking") && (conversation.origin?.kind !== "fork" || binding.throughRunId !== null)) say("fork-binding-has-fork-origin", where, "a native fork needs its branch origin and no native position");
  });
  const origin = conversation.origin;
  if (origin?.kind === "import" && !bindings.some(binding => binding.harnessId === origin.harnessId)) say("import-origin-has-native-reference", "conversation " + conversation.id, "a continued native session of " + origin.harnessId + " has no native reference");
  if (origin?.kind === "fork" && origin.sessionId === conversation.id) say("branch-not-from-itself", "conversation " + conversation.id, "it is a branch of itself");
  if (conversation.relayRecoveryFailed !== undefined && conversation.relayRecoveryFailed > conversation.lastSeq) say("relay-recovery-failed-within-events", "conversation " + conversation.id, "the failure is recorded at " + conversation.relayRecoveryFailed + " and the last event is " + conversation.lastSeq);

  // What the store holds says what the conversation says.
  let head;
  try { head = reader.head(conversation.id); } catch { head = null; }
  if (head === null) say("head-agrees", "conversation " + conversation.id, "the store has no head for it");
  else {
    const differs = (name: string, mine: unknown, theirs: unknown): void => { if (!same(mine, theirs)) say("head-agrees", "conversation " + conversation.id, "the head's " + name + " is " + JSON.stringify(theirs) + " and the conversation's is " + JSON.stringify(mine)); };
    differs("version", conversation.version, head.version); differs("lastSeq", conversation.lastSeq, head.lastSeq); differs("status", conversation.status, head.status); differs("epoch", conversation.epoch, head.epoch);
    differs("activeRunId", conversation.activeRunId, head.activeRunId); differs("pendingSwitchId", conversation.pendingSwitchId, head.pendingSwitchId);
    differs("kept", conversation.retained !== undefined, head.kept); differs("runCount", runs.length, head.runCount);
    differs("selection", conversation.selection, head.head.selection); differs("retained", conversation.retained, head.head.retained); differs("retainNative", conversation.retainNative, head.head.retainNative);
    differs("relayRecoveryFailed", conversation.relayRecoveryFailed, head.head.relayRecoveryFailed);
  }
  runs.forEach((run, position) => {
    const row = rows[position] ?? null;
    if (row === null) { say("run-row-agrees", "run " + run.id, "the store has no row for the Run at ordinal " + run.ordinal); return; }
    const differs = (name: string, mine: unknown, theirs: unknown): void => { if (!same(mine, theirs)) say("run-row-agrees", "run " + run.id, "the row's " + name + " is " + JSON.stringify(theirs) + " and the conversation's is " + JSON.stringify(mine)); };
    differs("run id", run.id, row.runId); differs("command id", run.commandId, row.commandId); differs("status", run.status, row.status); differs("epoch", run.epoch, row.epoch);
    differs("harness", run.selection.harnessId, row.harnessId); differs("control", run.selection.controlId, row.controlId); differs("user seq", run.userSeq, row.userSeq); differs("ended seq", run.endedSeq ?? null, row.endedSeq);
    differs("cancel", run.cancelRequested, row.cancelRequested); differs("stop", run.stopRequested, row.stopRequested); differs("acknowledgement", run.acknowledgedBy ?? null, row.acknowledgedBy);
    differs("command", run.isCommand, row.isCommand); differs("managed", run.selection.provider !== undefined, row.managed);
  });
  return found;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// verifyTransition
// ---------------------------------------------------------------------------------------------------------------------------------

/** One binding's relay state moving on (ADR-055 §14.3): the native epoch and the clear floor never go back, and the mark never goes down within an epoch. */
function relayForward(old: BindingRelayState | undefined, next: BindingRelayState | undefined): string | null {
  if (next === undefined) return old === undefined ? null : "a binding's relay state cannot be dropped";
  if (old === undefined) return null;
  if (next.epoch < old.epoch) return "a binding's native epoch cannot go back";
  if (next.floor < old.floor) return "a binding's clear floor cannot go down";
  if (next.epoch === old.epoch && next.mark < old.mark) return "a binding's mark cannot go down within an epoch";
  return null;
}
const relayFailed = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && (value as Readonly<Record<string, unknown>>).failed === true;
const clearedNative = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && (value as Readonly<Record<string, unknown>>).cleared === true;

/**
 * What must be true of `after`, the conversation a commit made of `before`, with the events it wrote (`assertSessionTransition` over the rows):
 * identity, configuration and origin fixed; history only added to; commands never rewritten; no implicit reopening; the epoch moves with one
 * switch; a binding is changed only by its writer Run, a native reset or a branch's fork, never taken over, archived only by a reset, a failed fork
 * or a confirmed clear, and its relay state only goes forward (review M6, row 9); what a Run was accepted with, what it was dispatched
 * with and what it was given as context stay (row 10); a finished Run, backend and cleanup evidence, the seq of an end, the cancel and the stop,
 * and a finished switch, are never rewritten; an unknown Run is acknowledged by a recovery switch, once.
 */
export const verifyTransition: VerifyTransition = (before: Conversation, after: Conversation, events: readonly EventDraft[] = []): readonly Violation[] => {
  const found: Violation[] = [];
  const say = (rule: TransitionRule, where: string, detail: string): void => { found.push({ rule, where, detail }); };
  const here = "conversation " + after.id;
  if (before.id !== after.id || before.format !== after.format || !same(before.configuration, after.configuration)) say("transition-identity-fixed", here, "the identity and configuration of a conversation never change");
  if (!same(before.origin, after.origin)) say("transition-origin-fixed", here, "the origin of a branch never changes");

  // History is only added to.
  const prefix = (name: string, older: readonly { readonly id: string }[], newer: readonly { readonly id: string }[]): void => {
    if (newer.length < older.length || older.some((entry, index) => newer[index]?.id !== entry.id)) say("transition-history-append-only", here, "the " + name + " were removed or reordered");
  };
  prefix("Runs", before.runs, after.runs); prefix("switches", before.switches, after.switches); prefix("commands", before.commands, after.commands);
  for (let index = 0; index < before.commands.length; index++) if (!same(before.commands[index], after.commands[index])) say("transition-commands-fixed", "command " + before.commands[index]!.id, "a committed command was rewritten");

  // Closed and blocked conversations do not reopen by themselves; the epoch moves with one switch.
  if (before.status === "closed" && after.status !== "closed" || before.status === "blocked" && after.status === "open" &&
      (after.epoch !== before.epoch + 1 || !after.switches.some(entry => entry.id === before.pendingSwitchId && entry.status === "effective") || after.runs.some(run => run.status === "unknown" && run.cleanup?.closed !== true)))
    say("transition-no-implicit-reopen", here, "a " + before.status + " conversation became " + after.status + " other than by a recovery switch that took effect");
  if (after.epoch < before.epoch || after.epoch > before.epoch + 1 || after.epoch === before.epoch && !same(before.selection, after.selection)) say("transition-epoch-step", here, "the selection changes only with one effective switch, which moves the epoch by one");

  // Bindings.
  const oldBindings = before.nativeBindings ?? [], newBindings = after.nativeBindings ?? [];
  if (newBindings.length < oldBindings.length) say("transition-bindings-kept", here, "a native binding was erased");
  const added = after.commands.slice(before.commands.length), writer = after.runs.find(run => run.id === (before.activeRunId ?? after.activeRunId));
  const cleared = writer !== undefined && events.some(event => event.type === "run.ended" && event.data.runId === writer.id && clearedNative(event.data.native));
  const reseated = writer !== undefined && events.some(event => event.type === "native.binding_reseated" && event.data.runId === writer.id);
  for (let index = 0; index < newBindings.length; index++) {
    const old = oldBindings[index], next = newBindings[index]!, where = "binding " + index + " (" + next.harnessId + "/" + next.controlId + ")";
    if (old !== undefined && same(old, next)) continue;
    if (old?.status === "archived" || old !== undefined && (old.harnessId !== next.harnessId || old.controlId !== next.controlId)) { say("transition-binding-owner", where, "native state ownership or archived state changed"); continue; }
    const frozen = old !== undefined && same(old.relay, next.relay);
    const reset = old !== undefined && frozen && next.status === "archived" && next.checkpoint === old.checkpoint && next.throughRunId === old.throughRunId && after.selection.harnessId === next.harnessId && after.selection.controlId === next.controlId && added.some(command => command.kind === "native-reset");
    const forked = old !== undefined && frozen && next.throughRunId === null && (old.status === "fork-pending" && next.status === "forking" && next.checkpoint === old.checkpoint
      || old.status === "forking" && next.status === "ready" || (old.status === "fork-pending" || old.status === "forking") && next.status === "archived" && next.checkpoint === old.checkpoint);
    if (!reset && !forked && (!writer || writer.selection.provider !== undefined || writer.selection.harnessId !== next.harnessId || writer.selection.controlId !== next.controlId || next.throughRunId !== null && next.throughRunId !== old?.throughRunId && next.throughRunId !== writer.id))
      say("transition-binding-owner", where, "native state changed without its original Run owner");
    if (!reset && !forked && old !== undefined && next.status === "archived" && (!(cleared || reseated) || !frozen)) say("transition-binding-archive", where, "a native binding is archived only by a native reset, a failed branch, a confirmed native clear or the Hub's own successor to a full one");
    const behind = relayForward(old?.relay, next.relay);
    if (behind !== null) say("transition-relay-forward", where, behind);
  }
  if (before.relayRecoveryFailed !== after.relayRecoveryFailed) {
    const failedEnd = (event: EventDraft): boolean => event.type === "run.ended" && writer !== undefined && event.data.runId === writer.id && relayFailed(event.data.relay);
    const recorded = after.relayRecoveryFailed !== undefined && events.some((event, index) => (event.type === "session.recovered" || failedEnd(event)) && before.lastSeq + index + 1 === after.relayRecoveryFailed);
    const renewed = added.some(entry => entry.kind === "native-reset") || newBindings.length > oldBindings.length;
    if (after.relayRecoveryFailed !== undefined ? !recorded : !renewed) say("transition-relay-recovery-failed", here, "a relay recovery failure is recorded by recovery and cleared by a new native session");
  }

  // Runs: those that were there, one by one.
  for (let index = 0; index < before.runs.length; index++) {
    const old = before.runs[index]!, next = after.runs[index];
    if (next === undefined || next === old) continue;
    const where = "run " + old.id;
    if (runEnded(old.status)) {
      // A finished Run changes in nothing but the acknowledgement of an unknown one, once (the one column the trigger leaves free).
      const { acknowledgedBy: _before, ...oldRest } = old, { acknowledgedBy: _after, ...nextRest } = next;
      if (!same(oldRest, nextRest)) say("transition-run-fixed-when-finished", where, "a finished Run was rewritten");
      if (old.acknowledgedBy !== undefined && next.acknowledgedBy !== old.acknowledgedBy) say("transition-acknowledgement-once", where, "an acknowledged Run was acknowledged again");
      else if (next.acknowledgedBy !== undefined && old.acknowledgedBy === undefined && old.status !== "unknown") say("transition-acknowledgement-once", where, "only an unknown Run is acknowledged");
      continue;
    }
    if (old.commandId !== next.commandId || old.userMessageId !== next.userMessageId || old.assistantMessageId !== next.assistantMessageId || old.awaitingSwitchId !== next.awaitingSwitchId || old.userSeq !== next.userSeq ||
        old.ordinal !== next.ordinal || !same(old.attachments, next.attachments) || !same(old.relayRequest, next.relayRequest)) say("transition-run-input-fixed", where, "accepted Run input and identities are immutable");
    if (old.cancelRequested && !next.cancelRequested || old.stopRequested && !next.stopRequested) say("transition-run-tombstones-kept", where, "cancel and stop tombstones cannot be undone");
    if (old.backend !== null && !same(old.backend, next.backend) || old.cleanup !== null && !same(old.cleanup, next.cleanup) || old.endedSeq !== undefined && old.endedSeq !== next.endedSeq) say("transition-run-evidence-once", where, "backend and cleanup evidence and the seq of an end cannot be overwritten");
    if (old.status !== "queued" && (!same(old.selection, next.selection) || old.epoch !== next.epoch)) say("transition-run-selection-fixed", where, "the selection of a dispatched Run is immutable");
    if ((old.status === "running" || old.status === "settling") && (old.contextThroughSeq !== next.contextThroughSeq || !same(old.sourceRunIds, next.sourceRunIds) || !same(old.relay, next.relay) || old.timing?.contextReadyAt !== next.timing?.contextReadyAt))
      say("transition-run-context-fixed", where, "what a Turn was given as context cannot change once it runs");
    // The items it holds only grow: the same place and id, and a text only gets longer.
    const oldItems = old.items ?? [], nextItems = next.items ?? [];
    if (old.items !== undefined && next.items !== undefined && (nextItems.length < oldItems.length || oldItems.some((item, at) => nextItems[at]?.itemId !== item.itemId || nextItems[at]?.seq !== item.seq || nextItems[at]!.text.join("").indexOf(item.text.join("")) !== 0)))
      say("transition-items-append-only", where, "an item was removed, moved or had its text changed");
  }

  // Switches: a finished one is never rewritten; a pending one keeps its request.
  for (let index = 0; index < before.switches.length; index++) {
    const old = before.switches[index]!, next = after.switches[index];
    if (next === undefined) continue;
    const where = "switch " + old.id;
    if (old.status === "effective" || old.status === "failed") { if (!same(old, next)) say("transition-switch-evidence-fixed", where, "terminal switch evidence cannot be rewritten"); continue; }
    if (old.commandId !== next.commandId || old.requestedSeq !== next.requestedSeq || !same(old.requested, next.requested) || next.throughSeq < old.throughSeq || old.target !== null && !same(old.target, next.target) || old.mode !== next.mode ||
        !same(old.acknowledgedUnknown, next.acknowledgedUnknown) || old.timing !== undefined && (next.timing?.requestedAt !== old.timing.requestedAt || old.timing.validatedAt !== undefined && next.timing.validatedAt !== old.timing.validatedAt || old.timing.effectiveAt !== undefined && next.timing.effectiveAt !== old.timing.effectiveAt))
      say("transition-switch-request-fixed", where, "a switch's request and its validated target cannot change");
  }
  // Only a recovery switch acknowledges unknown Runs, and only a blocked conversation takes one.
  if (after.switches.slice(before.switches.length).some(entry => entry.acknowledgedUnknown?.length && before.status !== "blocked")) say("transition-acknowledgement-by-recovery", here, "unknown Runs are acknowledged only by a recovery switch of a blocked conversation");
  return found;
};
