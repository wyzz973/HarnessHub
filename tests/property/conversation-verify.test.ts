import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, ConversationReader, ConversationRun, HeldItem } from "../../src/contracts/conversation.js";
import type { BindingRelayState } from "../../src/contracts/relay.js";
import type { CommandRecord, NativeSessionBinding, PublicSwitch } from "../../src/contracts/session.js";
import { TRANSITION_RULES, VERIFY_RULES, verify, verifyTransition, type TransitionRule, type VerifyRule } from "../../src/contexts/session/domain/conversation-verify.js";
import { fixtureConversation, fixtureConversations, headOf, readerOf, rowOf, stored, type BuiltConversation, type StoreOverrides } from "../fixtures/storage/v13/conversations.js";
import type { V13FixtureName } from "../fixtures/storage/v13/database.js";

// The whole-conversation check of ADR-057 3.3 (src/contexts/session/domain/conversation-verify.ts): it finds nothing in the conversations of the v13
// fixtures as the new storage holds them (each Run converted by toItems), it finds exactly the rule that a conversation is broken at when one thing
// is broken, in a transition as in a state, it never throws, and its time grows with the size of the conversation, not with its square.

const CLEAN = { closed: true as const, exitCode: 0, signal: null, protocolFailure: null };
const FINGERPRINT = "f".repeat(64);
const brand = <T>(value: string): T => value as never;
const rules = (found: readonly { readonly rule: string }[]): readonly string[] => [...new Set(found.map(violation => violation.rule))].sort();

// ---------------------------------------------------------------------------------------------------------------------------------
// Making one thing wrong
// ---------------------------------------------------------------------------------------------------------------------------------
type RunPatch = Partial<ConversationRun> | ((run: ConversationRun) => ConversationRun);
const run = (c: Conversation, index: number, patch: RunPatch): Conversation => ({ ...c, runs: c.runs.map((row, at) => at !== index ? row : typeof patch === "function" ? patch(row) : { ...row, ...patch }) });
const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => { const { [key]: _gone, ...rest } = value; return rest; };
const change = (c: Conversation, index: number, patch: Partial<PublicSwitch>): Conversation => ({ ...c, switches: c.switches.map((row, at) => at === index ? { ...row, ...patch } : row) });
const bind = (c: Conversation, index: number, patch: (binding: NativeSessionBinding) => NativeSessionBinding): Conversation => ({ ...c, nativeBindings: c.nativeBindings!.map((row, at) => at === index ? patch(row) : row) });
const commandsOf = (c: Conversation, change: (commands: readonly CommandRecord[]) => readonly CommandRecord[]): Conversation => ({ ...c, commands: change(c.commands) });
const last = (c: Conversation): number => c.runs.length - 1;

interface Broken { readonly conversation: Conversation; readonly store?: StoreOverrides }
interface Case { readonly rule: VerifyRule; readonly on: readonly [V13FixtureName, number?]; readonly make: (c: Conversation, built: BuiltConversation) => Conversation | Broken }
const items = (index: number, edit: (items: readonly HeldItem[]) => readonly HeldItem[]): StoreOverrides => ({ items: { [index]: edit } });
const CASES: readonly Case[] = [
  // identity and order
  { rule: "run-ordinals-are-indexes", on: ["switches"], make: c => run(c, last(c), { ordinal: 99 }) },
  { rule: "run-ids-unique", on: ["commands"], make: c => {
    const duplicate = run(c, 8, { id: c.runs[7]!.id }), old = c.runs[8]!.id;
    return commandsOf(duplicate, commands => commands.map(command => command.kind === "send" && command.resultId === old ? { ...command, resultId: c.runs[7]!.id } : command)); } },
  { rule: "message-ids-unique", on: ["commands"], make: c => run(c, 8, { assistantMessageId: c.runs[7]!.assistantMessageId }) },
  { rule: "switch-ids-unique", on: ["switches"], make: c => {
    const old = c.switches[1]!.id, duplicate = change(c, 1, { id: c.switches[0]!.id });
    return commandsOf(duplicate, commands => commands.map(command => command.kind === "switch" && command.resultId === old ? { ...command, resultId: c.switches[0]!.id } : command)); } },
  { rule: "command-ids-unique", on: ["kept-process"], make: c => commandsOf(c, commands => [...commands, commands[1]!]) },
  { rule: "run-user-seqs-increase", on: ["switches"], make: c => ({ conversation: run(c, 3, { userSeq: c.runs[2]!.userSeq }),
    store: items(3, list => list.map((item, at) => at === 0 ? { ...item, createdSeq: c.runs[2]!.userSeq } : item)) }) },
  { rule: "run-ended-seq-placed", on: ["switches"], make: c => run(c, 0, { endedSeq: 1 }) },
  { rule: "run-effects-belong-to-commands", on: ["switches"], make: c => run(c, 0, { settledEffect: "compact" }) },
  // the head
  { rule: "one-active-run", on: ["running-crash"], make: c => run(c, 2, { status: "preparing" }) },
  { rule: "head-active-run", on: ["switches"], make: c => ({ ...c, activeRunId: c.runs[0]!.id }) },
  { rule: "one-pending-switch", on: ["running-crash"], make: c => ({ ...c, switches: [...c.switches, { id: brand("switch-extra"), commandId: brand("extra-switch-command"), requested: { harnessId: "alpha" }, requestedSeq: 3, target: null, status: "requested", throughSeq: 0, sourceRunIds: [], error: null }],
    commands: [...c.commands, { id: brand("extra-switch-command"), kind: "switch", fingerprint: FINGERPRINT, resultId: "switch-extra" }] }) },
  { rule: "head-pending-switch", on: ["running-crash"], make: c => ({ ...c, pendingSwitchId: null }) },
  { rule: "closed-conversation-idle", on: ["running-crash"], make: c => ({ ...c, status: "closed" }) },
  // unknown Runs and their acknowledgement
  { rule: "open-conversation-unclaimed-unknown", on: ["unknown-recovered"], make: c => run(c, 1, current => without(current, "acknowledgedBy")) },
  { rule: "acknowledgement-materialized", on: ["unknown-recovered"], make: c => run({ ...c, status: "blocked" }, 1, current => without(current, "acknowledgedBy")) },
  { rule: "acknowledgement-is-first-claim", on: ["unknown-recovered"], make: c => run(c, 1, { acknowledgedBy: brand("switch-nope") }) },
  { rule: "acknowledged-run-is-unknown", on: ["unknown-recovered"], make: c => run(c, 0, { acknowledgedBy: c.switches[0]!.id }) },
  // epochs and selection
  { rule: "epoch-counts-effective-switches", on: ["switches"], make: c => ({ ...c, epoch: 7 }) },
  { rule: "selection-is-last-effective-target", on: ["switches"], make: c => ({ ...c, selection: { harnessId: "bravo", controlId: "bravo-acp" } }) },
  { rule: "run-epoch-within-conversation", on: ["switches"], make: c => run(c, 0, { epoch: 9 }) },
  { rule: "run-context-within-events", on: ["switches"], make: c => run(c, 0, { contextThroughSeq: c.lastSeq + 5 }) },
  { rule: "switch-seqs-within-events", on: ["switches"], make: c => change(c, 0, { throughSeq: c.lastSeq + 1 }) },
  // commands
  { rule: "one-create-command", on: ["switches"], make: c => commandsOf(c, commands => commands.filter(command => command.kind !== "create")) },
  { rule: "run-send-command", on: ["switches"], make: c => commandsOf(c, commands => commands.filter(command => !(command.kind === "send" && command.resultId === c.runs[last(c)]!.id))) },
  { rule: "switch-switch-command", on: ["switches"], make: c => commandsOf(c, commands => commands.filter(command => !(command.kind === "switch" && command.resultId === c.switches[0]!.id))) },
  { rule: "command-result-exists", on: ["switches"], make: c => commandsOf(c, commands => [...commands, { id: brand("close-command"), kind: "close", fingerprint: FINGERPRINT, resultId: "session-other" }]) },
  // Runs
  { rule: "queued-run-without-execution", on: ["running-crash"], make: c => run(c, 2, { contextThroughSeq: 3 }) },
  { rule: "queued-run-without-execution", on: ["running-crash"], make: c => run(c, 2, current => ({ ...current, items: [...current.items!, { ...current.items![0]!, seq: 2, itemId: "text:1", type: "assistant_message", createdSeq: null }] })) },
  { rule: "running-run-unsettled", on: ["running-crash"], make: c => run(c, 1, { cleanup: CLEAN }) },
  { rule: "settling-run-has-backend", on: ["running-crash"], make: c => run(c, 1, { status: "settling" }) },
  { rule: "completed-run-settled-and-closed", on: ["switches"], make: c => run(c, 0, { backend: null }) },
  { rule: "run-sources-unique", on: ["switches"], make: c => run(c, 2, { sourceRunIds: [c.runs[2]!.sourceRunIds[0]!, c.runs[2]!.sourceRunIds[0]!] }) },
  { rule: "run-awaits-existing-switch", on: ["switches"], make: c => run(c, 0, { awaitingSwitchId: brand("switch-nope") }) },
  { rule: "run-sources-finished-and-earlier", on: ["switches"], make: c => run(c, 2, { sourceRunIds: [...c.runs[2]!.sourceRunIds, c.runs[3]!.id] }) },
  { rule: "run-sources-within-watermark", on: ["switches"], make: c => run(c, 2, { contextThroughSeq: 1 }) },
  { rule: "retained-run-completed-without-cleanup", on: ["kept-process"], make: c => run(c, 0, { cleanup: CLEAN }) },
  { rule: "reused-run-started-native", on: ["running-crash"], make: c => run(c, 2, { reused: true }) },
  { rule: "run-executed-on-own-selection", on: ["switches"], make: c => run(c, 0, current => ({ ...current, relay: { ...current.relay!, executedOn: { harnessId: "bravo", controlId: "bravo-acp", nativeEpoch: 1 } } })) },
  { rule: "kept-process-belongs-to-handing-run", on: ["kept-process"], make: c => ({ ...c, retained: { ...c.retained!, runId: brand("run-nope") } }) },
  // switches
  { rule: "switch-target-present", on: ["switches"], make: c => change(c, 0, { target: null }) },
  { rule: "switch-sources-unique", on: ["switches"], make: c => change(c, 0, { sourceRunIds: [c.switches[0]!.sourceRunIds[0]!, c.switches[0]!.sourceRunIds[0]!] }) },
  { rule: "switch-sources-finished", on: ["switches"], make: c => change(c, 0, { sourceRunIds: [...c.switches[0]!.sourceRunIds, brand("run-nope")] }) },
  { rule: "switch-sources-before-request", on: ["switches"], make: c => change(c, 0, { requestedSeq: 3 }) },
  { rule: "acknowledged-unknown-valid", on: ["unknown-recovered"], make: c => change(c, 0, { acknowledgedUnknown: [c.runs[0]!.id] }) },
  // bindings and origins
  { rule: "binding-has-relay-state", on: ["switches"], make: c => bind(c, 0, binding => without(binding, "relay")) },
  { rule: "binding-lineage", on: ["commands"], make: c => bind(c, 1, binding => ({ ...binding, relay: { ...binding.relay!, epoch: 1 } })) },
  { rule: "one-live-binding-per-control", on: ["switches"], make: c => ({ ...c, nativeBindings: [...c.nativeBindings!, { ...c.nativeBindings![0]!, checkpoint: "native-extra", throughRunId: null, relay: { ...c.nativeBindings![0]!.relay!, epoch: 2 } }] }) },
  { rule: "native-cursor-finished-native-run", on: ["switches"], make: c => bind(c, 0, binding => ({ ...binding, throughRunId: brand("run-nope") })) },
  { rule: "native-cursor-settled-and-closed", on: ["running-crash"], make: c => bind(c, 1, binding => ({ ...binding, status: "ready", throughRunId: c.runs[3]!.id })) },
  { rule: "opens-new-binding-shape", on: ["switches"], make: c => bind(c, 0, binding => ({ ...binding, opensNew: true })) },
  { rule: "fork-binding-has-fork-origin", on: ["branch-pending", 1], make: c => without(c, "origin") },
  { rule: "import-origin-has-native-reference", on: ["import"], make: c => ({ ...c, nativeBindings: [] }) },
  { rule: "relay-recovery-failed-within-events", on: ["switches"], make: c => ({ ...c, relayRecoveryFailed: c.lastSeq + 3 }) },
  { rule: "branch-not-from-itself", on: ["branch-pending", 1], make: c => ({ ...c, origin: { ...c.origin!, sessionId: c.id } as never }) },
  // items
  { rule: "run-has-user-item", on: ["switches"], make: c => ({ conversation: c, store: items(0, list => list.slice(1)) }) },
  { rule: "item-seqs-increase", on: ["tools"], make: c => ({ conversation: c, store: items(0, list => list.map((item, at) => at === 3 ? { ...item, seq: list[2]!.seq } : item)) }) },
  { rule: "item-ids-unique", on: ["tools"], make: c => ({ conversation: c, store: items(0, list => list.map((item, at) => at === 3 ? { ...item, itemId: list[2]!.itemId } : item)) }) },
  { rule: "finished-run-no-open-item", on: ["switches"], make: c => ({ conversation: c, store: items(0, list => list.map((item, at) => at === 1 ? { ...item, status: "running" } : item)) }) },
  { rule: "item-chunks-well-formed", on: ["switches"], make: c => ({ conversation: c, store: items(0, list => list.map((item, at) => at === 1 ? stored({ ...item, text: ["bad\ud83d"] }) : item)) }) },
  { rule: "item-text-counts", on: ["switches"], make: c => ({ conversation: c, store: items(0, list => list.map((item, at) => at === 1 ? { ...item, textBytes: item.textBytes + 1 } : item)) }) },
  // content
  { rule: "content-refs-complete", on: ["tools"], make: c => ({ conversation: c, store: { references: ids => new Set([...ids].slice(1)) } }) },
  { rule: "content-refs-complete", on: ["tools"], make: c => ({ conversation: c, store: { references: () => new Set() } }) },
  { rule: "content-refs-complete", on: ["branch"], make: c => ({ conversation: c, store: { references: () => new Set() } }) },
  // what the store holds
  { rule: "head-agrees", on: ["switches"], make: c => ({ conversation: c, store: { head: head => ({ ...head, runCount: 99 }) } }) },
  { rule: "run-row-agrees", on: ["switches"], make: c => ({ conversation: c, store: { rows: { 0: row => ({ ...row, cancelRequested: true }) } } }) },
];

test("the conversations of the v13 fixtures, converted and read as the new storage holds them, break no rule; and nothing changes in no transition", () => {
  const all = fixtureConversations();
  assert.ok(all.length >= 45, "the fixtures hold the conversations this test is about");
  let runs = 0;
  for (const built of all) {
    runs += built.conversation.runs.length;
    assert.deepEqual(verify(built.conversation, readerOf(built.conversation, built)), [], built.name);
    assert.deepEqual(verifyTransition(built.conversation, built.conversation, []), [], built.name + " (no change)");
  }
  assert.ok(runs >= 170);
});

test("every rule has a conversation broken at it alone, and the check reports that rule and no other", () => {
  assert.deepEqual([...new Set(CASES.map(item => item.rule))].sort(), [...VERIFY_RULES].sort(), "a case for each rule, and no rule without one");
  for (const item of CASES) {
    const built = fixtureConversation(item.on[0], item.on[1] ?? 0), made = item.make(built.conversation, built);
    const broken = "conversation" in made ? made : { conversation: made }, found = verify(broken.conversation, readerOf(broken.conversation, built, broken.store));
    assert.deepEqual(rules(found), [item.rule], item.rule + " on " + built.name + ": " + JSON.stringify(found.slice(0, 3)));
    assert.ok(found.every(violation => violation.where !== "" && violation.detail !== ""), "a violation says where and what");
  }
});

test("the floor: an open conversation that holds an unknown Run nobody acknowledged is reported, and a blocked one is allowed to", () => {
  const built = fixtureConversation("unknown-recovered", 4);
  assert.equal(built.conversation.status, "blocked");
  assert.ok(built.conversation.runs.some(item => item.status === "unknown" && item.acknowledgedBy === undefined), "the fixture holds a blocked conversation with an unknown Run left as it is");
  assert.deepEqual(verify(built.conversation, readerOf(built.conversation, built)), []);
  const opened = { ...built.conversation, status: "open" as const };
  assert.deepEqual(rules(verify(opened, readerOf(opened, built))), ["open-conversation-unclaimed-unknown"]);
  // And an unknown Run whose resources were not confirmed closed cannot be acknowledged into an open conversation.
  const acknowledged = fixtureConversation("unknown-recovered", 0), unknown = acknowledged.conversation.runs.findIndex(item => item.status === "unknown");
  const unclosed = run(acknowledged.conversation, unknown, { cleanup: null });
  assert.deepEqual(rules(verify(unclosed, readerOf(unclosed, acknowledged))), ["open-conversation-unclaimed-unknown"]);
});

test("a Run is acknowledged by the first effective switch that claims it, by its own list or by its sources, and a failed switch claims nothing (the arrangement of review I2)", () => {
  const built = fixtureConversation("unknown-recovered", 6), c = built.conversation;
  const unknown = c.runs.find(item => item.status === "unknown")!, failed = c.switches.find(entry => entry.status === "failed")!, recovery = c.switches.find(entry => entry.status === "effective")!;
  assert.ok(!failed.sourceRunIds.includes(unknown.id), "the failed switch skips the Run that was queued when it was asked for");
  assert.ok(failed.sourceRunIds.some(id => c.runs.find(other => other.id === id)!.ordinal > unknown.ordinal), "…although a later Run is among its sources");
  assert.equal(unknown.acknowledgedBy, recovery.id);
  assert.deepEqual(verify(c, readerOf(c, built)), []);
  // Naming the failed switch (what "an ordinal at or below its sources" would give) is not a claim.
  const wrong = run(c, unknown.ordinal, { acknowledgedBy: failed.id });
  assert.deepEqual(rules(verify(wrong, readerOf(wrong, built))), ["acknowledgement-is-first-claim"]);
  // The same Run acknowledged by the list of a switch (the form a later Runtime writes) is as good.
  const listed = fixtureConversation("unknown-acknowledged");
  assert.ok(listed.conversation.switches.some(entry => (entry.acknowledgedUnknown?.length ?? 0) > 0));
  assert.deepEqual(verify(listed.conversation, readerOf(listed.conversation, listed)), []);
});

test("verify does not throw: a store that holds nothing, or fails, is reported as what it is", () => {
  const built = fixtureConversation("switches");
  const empty: ConversationReader = { ...readerOf(built.conversation, built), head: () => { throw new Error("no such conversation"); }, turnAt: () => null };
  const found = verify(built.conversation, empty);
  assert.ok(rules(found).includes("head-agrees") && rules(found).includes("run-row-agrees"));
  const failing: ConversationReader = { ...readerOf(built.conversation, built), turnAt: () => { throw new Error("the store failed"); } };
  assert.ok(verify(built.conversation, failing).length > 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------------------------------------------
interface Step { readonly rule: TransitionRule; readonly on: readonly [V13FixtureName, number?]; readonly before?: (c: Conversation) => Conversation; readonly after: (c: Conversation) => Conversation }
const EXTRA_SWITCH: PublicSwitch = { id: brand("switch-extra"), commandId: brand("extra-switch-command"), requested: { harnessId: "alpha" }, requestedSeq: 3, target: null, status: "requested", throughSeq: 0, sourceRunIds: [], error: null };
const STEPS: readonly Step[] = [
  { rule: "transition-identity-fixed", on: ["switches"], after: c => ({ ...c, configuration: { ...c.configuration, workspace: "/elsewhere" } }) },
  { rule: "transition-origin-fixed", on: ["branch-pending", 1], after: c => ({ ...c, origin: { ...c.origin!, throughRunId: brand("run-other") } as never }) },
  { rule: "transition-history-append-only", on: ["switches"], after: c => ({ ...c, runs: c.runs.slice(0, -1) }) },
  { rule: "transition-commands-fixed", on: ["switches"], after: c => commandsOf(c, commands => commands.map((command, at) => at === 0 ? { ...command, fingerprint: "e".repeat(64) } : command)) },
  { rule: "transition-no-implicit-reopen", on: ["unknown-recovered", 5], after: c => ({ ...c, status: "open" }) },
  { rule: "transition-epoch-step", on: ["switches"], after: c => ({ ...c, epoch: c.epoch + 2 }) },
  { rule: "transition-bindings-kept", on: ["switches"], after: c => ({ ...c, nativeBindings: [c.nativeBindings![0]!] }) },
  { rule: "transition-binding-owner", on: ["running-crash"], after: c => bind(c, 0, binding => ({ ...binding, throughRunId: null })) },
  { rule: "transition-binding-archive", on: ["running-crash"], after: c => bind(c, 1, binding => ({ ...binding, status: "archived" })) },
  { rule: "transition-relay-forward", on: ["running-crash"], before: c => bind(c, 1, binding => ({ ...binding, relay: { ...binding.relay!, epoch: 2 } })), after: c => c },
  { rule: "transition-relay-recovery-failed", on: ["switches"], after: c => ({ ...c, relayRecoveryFailed: 5 }) },
  { rule: "transition-run-fixed-when-finished", on: ["switches"], after: c => run(c, 0, { error: { code: "X", message: "changed" } }) },
  { rule: "transition-run-input-fixed", on: ["running-crash"], after: c => run(c, 1, { commandId: brand("send-other") }) },
  { rule: "transition-run-tombstones-kept", on: ["running-crash"], before: c => run(c, 1, { cancelRequested: true }), after: c => c },
  { rule: "transition-run-evidence-once", on: ["running-crash"], before: c => run(c, 1, { status: "settling", backend: { status: "completed", reason: "a" } }), after: c => run(c, 1, { status: "settling", backend: { status: "completed", reason: "b" } }) },
  { rule: "transition-run-selection-fixed", on: ["running-crash"], after: c => run(c, 1, current => ({ ...current, selection: { ...current.selection, nativeModel: "model-other" } })) },
  { rule: "transition-run-context-fixed", on: ["running-crash"], after: c => run(c, 1, { contextThroughSeq: c.runs[1]!.contextThroughSeq + 1 }) },
  { rule: "transition-switch-evidence-fixed", on: ["switches"], after: c => change(c, 0, { error: { code: "X", message: "rewritten" } }) },
  { rule: "transition-switch-request-fixed", on: ["running-crash"], after: c => change(c, 1, { requestedSeq: c.switches[1]!.requestedSeq + 1 }) },
  { rule: "transition-acknowledgement-by-recovery", on: ["switches"], after: c => ({ ...c, switches: [...c.switches, { ...EXTRA_SWITCH, acknowledgedUnknown: [c.runs[0]!.id] }] }) },
  { rule: "transition-acknowledgement-once", on: ["unknown-recovered"], before: c => run(c, 1, { acknowledgedBy: c.switches[0]!.id }), after: c => run(c, 1, { acknowledgedBy: brand("switch-other") }) },
  { rule: "transition-items-append-only", on: ["running-crash"], after: c => run(c, 1, current => ({ ...current, items: current.items!.map((item, at) => at === 0 ? { ...item, text: ["changed"] } : item) })) },
];

test("every transition rule has a pair of conversations broken at it alone, and the check reports that rule and no other", () => {
  assert.deepEqual([...new Set(STEPS.map(item => item.rule))].sort(), [...TRANSITION_RULES].sort(), "a case for each rule, and no rule without one");
  for (const item of STEPS) {
    const built = fixtureConversation(item.on[0], item.on[1] ?? 0), before = item.before === undefined ? built.conversation : item.before(built.conversation), after = item.after(built.conversation);
    const found = verifyTransition(before, after, []);
    assert.deepEqual(rules(found), [item.rule], item.rule + " on " + built.name + ": " + JSON.stringify(found.slice(0, 3)));
  }
});

test("what a commit may do is not reported: a Run that goes on to its end, a Run and its command that are added, a switch that takes effect, a binding that moves forward under its writer, an unknown Run that a recovery acknowledges", () => {
  const crash = fixtureConversation("running-crash"), before = crash.conversation, running = before.runs[1]!;
  // The running Run settles, is closed and ends; its items are no longer held.
  const ended = run(before, 1, current => ({ ...without(current, "items"), status: "completed" as const, backend: { status: "completed" as const, reason: "end_turn" }, cleanup: CLEAN, endedSeq: before.lastSeq + 1 }));
  const finished: Conversation = { ...ended, lastSeq: before.lastSeq + 1, version: before.version + 1, activeRunId: null,
    nativeBindings: before.nativeBindings!.map(binding => binding.harnessId === running.selection.harnessId ? { ...binding, status: "ready", throughRunId: running.id, relay: { ...binding.relay!, mark: 3 } } : binding) };
  assert.deepEqual(verifyTransition(before, finished, [{ type: "run.ended", data: { runId: running.id } }]), []);
  // A Run and its send command are added; the queue's Run starts.
  const next: ConversationRun = { ...before.runs[2]!, id: brand("run-added"), ordinal: before.runs.length, commandId: brand("send-added"), userSeq: before.lastSeq + 1, userMessageId: brand("message-added-u"), assistantMessageId: brand("message-added-a") };
  const grown: Conversation = { ...before, lastSeq: before.lastSeq + 1, runs: [...before.runs, next], commands: [...before.commands, { id: brand("send-added"), kind: "send", fingerprint: FINGERPRINT, resultId: "run-added" }] };
  assert.deepEqual(verifyTransition(before, grown, []), []);
  const started = run(before, 2, { status: "preparing", selection: { ...before.runs[2]!.selection, nativeModel: "model-b" } });
  assert.deepEqual(verifyTransition({ ...before, activeRunId: null, runs: before.runs.map((row, at) => at === 1 ? { ...row, status: "completed" as const } : row) }, { ...started, activeRunId: before.runs[2]!.id, runs: started.runs.map((row, at) => at === 1 ? { ...row, status: "completed" as const } : row) }, []), []);
  // A recovery switch takes effect in a blocked conversation and acknowledges its unknown Run.
  const blocked = fixtureConversation("unknown-recovered", 4).conversation, unknown = blocked.runs.find(row => row.status === "unknown")!;
  const recovery: PublicSwitch = { ...EXTRA_SWITCH, id: brand("switch-recovery"), status: "requested", acknowledgedUnknown: [unknown.id] };
  assert.deepEqual(verifyTransition(blocked, { ...blocked, switches: [...blocked.switches, recovery] }, []), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------------------------------------------------
/** A conversation of `count` finished Turns on two Harnesses, a switch every hundred, each Turn carrying up to three before it, and a store that makes each Turn when asked. */
function synthetic(count: number): { readonly conversation: Conversation; readonly reader: ConversationReader } {
  const runs: ConversationRun[] = [], commands: CommandRecord[] = [{ id: brand("create"), kind: "create", fingerprint: FINGERPRINT, resultId: "session-big" }], switches: PublicSwitch[] = [];
  let seq = 1, epoch = 1;
  const turns = new Map<number, { readonly items: readonly HeldItem[] }>();
  for (let index = 0; index < count; index++) {
    if (index > 0 && index % 100 === 0) {
      const id = "switch-" + index, target = { harnessId: epoch % 2 ? "bravo" : "alpha", controlId: (epoch % 2 ? "bravo" : "alpha") + "-acp" };
      commands.push({ id: brand("switch-command-" + index), kind: "switch", fingerprint: FINGERPRINT, resultId: id });
      switches.push({ id: brand(id), commandId: brand("switch-command-" + index), requested: { harnessId: target.harnessId }, requestedSeq: ++seq, target, status: "effective", throughSeq: ++seq, sourceRunIds: runs.slice(-100).map(row => row.id), error: null });
      epoch++;
    }
    const harness = epoch % 2 ? "alpha" : "bravo", userSeq = ++seq, replySeq = ++seq, context = seq;
    ++seq; const endedSeq = ++seq;
    const id = brand<ConversationRun["id"]>("run-" + index);
    runs.push({ id, commandId: brand("send-" + index), userMessageId: brand("message-u-" + index), assistantMessageId: brand("message-a-" + index), selection: { harnessId: harness, controlId: harness + "-acp" }, epoch, status: "completed", cancelRequested: false,
      contextThroughSeq: context, sourceRunIds: runs.slice(-3).map(row => row.id), backend: { status: "completed", reason: "end_turn" }, cleanup: CLEAN, error: null, stopRequested: false, awaitingSwitchId: null,
      ordinal: index, userSeq, endedSeq, isCommand: false, legacyOrder: true });
    commands.push({ id: brand("send-" + index), kind: "send", fingerprint: FINGERPRINT, resultId: id });
    const item = (itemSeq: number, itemId: string, type: "user_message" | "assistant_message", createdSeq: number): HeldItem => stored({ runId: id, seq: itemSeq, itemId, type, status: "completed", startedAt: null, endedAt: null, parentId: null, createdSeq,
      textBytes: 0, textChunks: 0, fields: { type, messageId: brand("message") }, text: ["words of Turn " + index] });
    turns.set(index, { items: [item(1, "user", "user_message", userSeq), item(2, "text:1", "assistant_message", replySeq)] });
  }
  const binding = (harnessId: string, controlId: string): NativeSessionBinding => {
    const through = [...runs].reverse().find(row => row.selection.harnessId === harnessId)!;
    const relay: BindingRelayState = { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false };
    return { harnessId, controlId, checkpoint: "native-" + harnessId, throughRunId: through.id, status: "ready", relay };
  };
  const conversation: Conversation = { format: 14, id: brand("session-big"), version: 1000, lastSeq: seq + 1, epoch, status: "open", configuration: { workspace: "/w", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    selection: runs.at(-1)!.selection, activeRunId: null, pendingSwitchId: null, runs, switches, commands, nativeBindings: count > 100 ? [binding("alpha", "alpha-acp"), binding("bravo", "bravo-acp")] : [binding("alpha", "alpha-acp")] };
  const reader: ConversationReader = { head: () => headOf(conversation), turnAt: (_id, ordinal) => { const row = runs[ordinal]; return row === undefined ? null : { run: rowOf(row, undefined), items: turns.get(ordinal)!.items }; },
    window: () => { throw new Error("unused"); }, older: () => { throw new Error("unused"); }, items: () => { throw new Error("unused"); }, text: () => { throw new Error("unused"); }, search: () => { throw new Error("unused"); } };
  return { conversation, reader };
}
test("ten thousand Turns are checked in time that grows with their number, and a broken one among them is found", t => {
  const timings = new Map<number, number>();
  for (const count of [1000, 2500, 5000, 10000]) {
    const { conversation, reader } = synthetic(count);
    verify(conversation, reader);
    let best = Infinity, found: readonly unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) { const started = performance.now(); found = verify(conversation, reader); best = Math.min(best, performance.now() - started); }
    assert.deepEqual(found, [], count + " Turns");
    timings.set(count, best);
  }
  t.diagnostic([...timings].map(([count, ms]) => `${count} Turns: ${ms.toFixed(1)} ms`).join("; "));
  const ratio = timings.get(10000)! / timings.get(1000)!;
  assert.ok(ratio < 25, "ten times the Turns took " + ratio.toFixed(1) + " times as long (a quadratic check would take a hundred)");
  assert.ok(timings.get(10000)! < 5000, "ten thousand Turns took " + timings.get(10000)!.toFixed(0) + " ms");
  const { conversation, reader } = synthetic(10000), middle = 5000;
  const broken = run(conversation, middle, { sourceRunIds: [conversation.runs[middle + 1]!.id] });
  assert.deepEqual(rules(verify(broken, reader)), ["run-sources-finished-and-earlier"]);
});
