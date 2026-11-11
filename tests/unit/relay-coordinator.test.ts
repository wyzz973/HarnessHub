import assert from "node:assert/strict";
import test from "node:test";
import { RelayError, relayPacketId, type BindingRelayState, type RelayCapabilities, type RelayPacketId } from "../../src/contracts/relay.js";
import { SessionError, type RunId } from "../../src/contracts/session.js";
import type { PacketRef } from "../../src/contexts/session/domain/relay/delivery.js";
import { attentionOf, decisionRecord, parseRelayChoices, policyAloneOf, relayDeclaration, relaySettings, settleTurn, type SettleInput } from "../../src/contexts/session/application/relay-coordinator.js";

// The rules around the relay's state machine (slim.md): what a Driver's declaration says to it, how a send's choice and the
// installation's setting are read, what a Turn records of its decision, what a binding asks the user to look at, and how a Turn's
// end settles the binding. All pure; nothing here opens a store or runs a Harness. The state machine itself is relay-delivery.test.ts.

const packet = (char: string) => relayPacketId("relay-" + char.repeat(20)) as RelayPacketId;
const ref = (char: string, fromSeq: number, throughSeq: number): PacketRef => ({ id: packet(char), fromSeq, throughSeq });
const state = (extra: Partial<BindingRelayState> = {}): BindingRelayState => ({ epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false, ...extra });
const pending = (char: string, fromSeq: number, throughSeq: number, autoResends: 0 | 1 = 0) => ({ packetId: packet(char), fromSeq, throughSeq, autoResends });

const caps = (live: RelayCapabilities["delivery"]["live"], successProvesRecorded: boolean, execution: RelayCapabilities["execution"] = "process"): RelayCapabilities => ({ probed: true, delivery: { live, verify: "none", successProvesRecorded, lateDelivery: false }, execution,
  commands: { unlistedSlash: "text", hidden: [], classify: () => ({ kind: "content" }) }, placement: { parts: "single", maxInput: null, pointersAfterUser: true, measure: () => 0 }, window: "none", fixedPrefix: null,
  cacheTtl: "unknown", compactionEvidence: "none", resolveVendor: () => "local", normalizeModel: () => "", title: "none", hostPathRead: "none", sessionTools: null });

test("what a Driver's declaration says to the relay: whether a send can ever be confirmed, and where it runs", () => {
  assert.deepEqual([relayDeclaration(caps("none", false)).canConfirm, relayDeclaration(caps("recorded_event", false)).canConfirm, relayDeclaration(caps("agent_output", false)).canConfirm, relayDeclaration(caps("none", true)).canConfirm], [false, true, true, true]);
  assert.deepEqual(relayDeclaration(null), { declared: false, successProvesRecorded: false, canConfirm: false, execution: "gateway", channel: "single_text", capabilities: null });
  assert.equal(relayDeclaration(undefined).declared, false); assert.equal(relayDeclaration(caps("none", true, "gateway")).execution, "gateway");
});

test("the request's choice and the installation's setting are read as a whole", () => {
  assert.equal(parseRelayChoices(undefined), undefined); assert.equal(parseRelayChoices({}), undefined); assert.equal(parseRelayChoices({ attach: "auto" }), undefined);
  assert.deepEqual(parseRelayChoices({ attach: "full" }), { attach: "full" }); assert.deepEqual(parseRelayChoices({ attach: "none" }), { attach: "none" });
  for (const value of [null, "full", ["full"], { attach: "everything" }, { attach: 1 }, { resend: true }, { native: "new" }, { attach: "full", tier: "goal" }]) assert.throws(() => parseRelayChoices(value), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT", JSON.stringify(value));
  assert.deepEqual(relaySettings({}), { attach: "auto" }); assert.deepEqual(relaySettings({ "relay.attach": "off" }), { attach: "off" }); assert.deepEqual(relaySettings({ "relay.attach": "auto" }), { attach: "auto" });
});

test("what a Turn records of its decision, and which failures only send the words alone", () => {
  const need = { facts: [], origin: false };
  assert.deepEqual(decisionRecord({ kind: "carry", need, by: "need", resend: null, whole: false, repeat: false }), { kind: "carry", by: "need" });
  assert.deepEqual(decisionRecord({ kind: "carry", need, by: "policy", resend: "auto", whole: false, repeat: true, cause: "delivery_unconfirmed" }), { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" });
  assert.deepEqual(decisionRecord({ kind: "alone", by: "policy", cause: "prepare_failed", reason: "render" }), { kind: "alone", by: "policy", cause: "prepare_failed", reason: "render" });
  assert.deepEqual(decisionRecord({ kind: "alone", by: "user" }), { kind: "alone", by: "user" });
  assert.deepEqual(decisionRecord({ kind: "plain", nothingToAttach: true }), { kind: "plain", by: "user" });
  assert.equal(decisionRecord({ kind: "plain", nothingToAttach: false }), null, "an ordinary Turn that owes nothing records none"); assert.equal(decisionRecord(null), null);
  const prepare = (reason: "render" | "storage" | "input_limit") => new RelayError({ code: "RELAY_PREPARE_FAILED", reason }, "failed");
  assert.deepEqual(policyAloneOf(prepare("storage"), {}), { cause: "prepare_failed", reason: "storage" });
  assert.deepEqual(policyAloneOf(prepare("input_limit"), {}), { cause: "input_limit", reason: "input_limit" });
  assert.deepEqual(policyAloneOf(new SessionError("RELAY_PREPARE_FAILED", "secrets"), {}), { cause: "prepare_failed", reason: "redaction_failed" });
  assert.deepEqual(policyAloneOf(new SessionError("CONTEXT_TOO_LARGE", "too large"), {}), { cause: "input_limit", reason: "context_too_large" });
  assert.equal(policyAloneOf(prepare("render"), { attach: "full" }), null, "what the user asked for fails the Turn");
  assert.equal(policyAloneOf(new SessionError("OWNERSHIP_LOST", "lost"), {}), null); assert.equal(policyAloneOf(new Error("boom"), {}), null);
});

test("what a binding asks the user to look at: a packet nothing confirmed, or a cleared conversation whose earlier part can be attached", () => {
  assert.equal(attentionOf({ relay: state({ mark: 3 }), owedRuns: 0, attachableRuns: 0 }), null);
  assert.deepEqual(attentionOf({ relay: state({ pending: pending("a", 1, 2, 1) }), owedRuns: 2, attachableRuns: 5 }),
    { cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 2, packets: 2 }, key: "delivery_unconfirmed:" + packet("a") }, "an unconfirmed packet is asked about first, and it went twice when its one resend was spent");
  assert.equal(attentionOf({ relay: state({ pending: pending("a", 1, 2, 0) }), owedRuns: 2, attachableRuns: 0 })?.counts.packets, 1, "it went once");
  assert.deepEqual(attentionOf({ relay: state({ epoch: 3, floor: 9 }), owedRuns: 0, attachableRuns: 4 }), { cause: "attach_available", options: ["attach_full"], counts: { runs: 4, packets: 0 }, key: "attach_available:3" });
});

const declaration = relayDeclaration(caps("none", true));
const settle = (relay: BindingRelayState, extra: Partial<SettleInput>) => settleTurn({ relay, runId: "run-9" as RunId, turn: { kind: "none" }, dispatched: true, status: "completed", input: undefined, noop: false, cleared: null, declaration,
  unknownTurn: false, endedSeq: 20, time: 100, ...extra });

test("the settlement of a Turn moves the binding by what the Turn showed", () => {
  const carrying = (recorded = false, autoResend = false) => ({ kind: "carry" as const, runId: "run-9" as RunId, packet: ref("a", 1, 4), autoResend, recorded });
  // A normal end proves the packet recorded where the Driver says so; the delivery row is decided with it.
  const proved = settle(state(), { turn: carrying() });
  assert.deepEqual([proved.relay, proved.deliveries.map(row => row.kind === "outcome" ? row.outcome.kind : null), proved.delivery], [state({ mark: 4 }), ["recorded"], { packetId: packet("a"), outcome: "recorded", evidence: "E3", mark: 4 }]);
  // Nothing proves it: the packet is pending, counted once when it was the automatic resend.
  const stopped = settle(state(), { turn: carrying(), status: "cancelled" });
  assert.deepEqual([stopped.relay.pending, stopped.deliveries.map(row => row.kind === "outcome" ? row.outcome.kind : null)], [pending("a", 1, 4, 0), ["unknown"]]);
  assert.deepEqual(settle(state({ pending: pending("z", 1, 4) }), { turn: carrying(false, true), status: "failed" }).relay.pending, pending("a", 1, 4, 1));
  // Known not to have been sent: the binding is as it was, and the row says so.
  const refused = settle(state({ mark: 1 }), { turn: carrying(), status: "failed", input: "not_recorded" });
  assert.deepEqual([refused.relay, refused.deliveries.map(row => row.kind === "outcome" ? row.outcome.kind : null)], [state({ mark: 1 }), ["not_recorded"]]);
  assert.deepEqual(settle(state(), { turn: carrying(), dispatched: false, status: null }).relay, state(), "never dispatched");
  // E1 decided it before the end: the state was moved then, and the settlement writes nothing.
  const early = settle(state({ mark: 4 }), { turn: carrying(true), status: "cancelled" });
  assert.deepEqual([early.relay, early.deliveries, early.delivery?.outcome], [state({ mark: 4 }), [], "recorded"]);
  // A Turn that carried nothing: when the native side evidently heard it, a binding that held nothing now holds the conversation as it stood.
  const quiet = relayDeclaration(caps("none", false)), plain = (agentOutput: boolean) => ({ kind: "plain" as const, contextThroughSeq: 6, agentOutput });
  assert.equal(settle(state(), { turn: plain(false) }).relay.mark, 6, "a normal end proves it where the Driver says so");
  assert.equal(settle(state(), { turn: plain(false), declaration: quiet }).relay.mark, -1, "and proves nothing where it does not");
  assert.equal(settle(state(), { turn: plain(true), declaration: quiet }).relay.mark, 6, "unless the agent answered");
  assert.equal(settle(state(), { turn: plain(false), declaration: quiet, input: "recorded" }).relay.mark, 6, "or the Driver said it was recorded");
  assert.equal(settle(state(), { turn: plain(false), status: "failed" }).relay.mark, -1, "a failed end proves nothing");
  assert.equal(settle(state(), { turn: plain(true), status: "failed", input: "not_recorded" }).relay.mark, -1, "refused");
  assert.equal(settle(state(), { turn: plain(true), dispatched: false, status: null }).relay.mark, -1, "never sent");
  assert.equal(settle(state({ mark: 3 }), { turn: plain(true) }).relay.mark, 3, "a binding that holds a part is left as it is");
  assert.deepEqual(settle(state(), { turn: { kind: "alone" } }).relay, state(), "sent alone changes nothing");
  // Commands: a rewind that ran sends everything again; a compaction nothing; a confirmed clear is the next epoch (a new binding when the Driver replaced the session).
  assert.equal(settle(state({ mark: 2 }), { turn: { kind: "command", declared: "rewind" } }).relay.resendAll, true);
  assert.deepEqual(settle(state({ mark: 2 }), { turn: { kind: "command", declared: "compact" } }).relay, state({ mark: 2 }));
  assert.deepEqual(settle(state({ mark: 2 }), { turn: { kind: "command", declared: "rewind" }, status: "failed", input: "not_recorded" }).relay, state({ mark: 2 }), "a refused command changed nothing");
  const cleared = settle(state({ mark: 2, pending: pending("a", 1, 2) }), { turn: { kind: "command", declared: "clear" }, cleared: { replaced: false } });
  assert.deepEqual([cleared.relay, cleared.replaced], [state({ epoch: 2, floor: 20 }), false]);
  const replaced = settle(state({ mark: 2 }), { turn: { kind: "command", declared: "clear" }, cleared: { replaced: true } });
  assert.deepEqual([replaced.relay, replaced.replaced], [state({ epoch: 2, floor: 20 }), true]);
  // A clear the Driver reported counts whatever the Turn was, and ends the pending packet's pursuit.
  const during = settle(state({ mark: 2 }), { turn: carrying(), status: "completed", cleared: { replaced: false } });
  assert.deepEqual([during.relay, during.delivery?.outcome], [state({ epoch: 2, floor: 20 }), "recorded"]);
  // An unknown Turn continued sends everything again, and a packet it carried is still waited for.
  const lost = settle(state(), { turn: carrying(), status: null, dispatched: true, unknownTurn: true });
  assert.deepEqual([lost.relay.pending, lost.relay.resendAll], [pending("a", 1, 4, 0), true]);
});

