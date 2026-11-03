import assert from "node:assert/strict";
import test from "node:test";
import type { ContextEffect } from "../../src/contracts/control.js";
import { commandId, messageId, runId, type PublicRun } from "../../src/contracts/session.js";
import { advances, commandEffect, commandOutcome, dispatched, type CommandOutcome, type InputOutcome } from "../../src/contexts/session/domain/relay/advance.js";

// The v12 transition rules of ADR-055 §7.6 (G067). Nothing here reads a store or a clock: each rule is checked over every
// combination of its inputs against the rule as the design states it.

const EFFECTS: readonly ContextEffect[] = ["keep", "none", "compact", "clear", "rewind", "unknown"];

test("G067-C06 a command's declared effect applies only when it was executed; not recorded or a no-op changes nothing", () => {
  for (const declared of EFFECTS) {
    assert.equal(commandEffect(declared, "executed"), declared, declared);
    for (const outcome of ["not_recorded", "noop"] as const) assert.equal(commandEffect(declared, outcome), "none", declared + " " + outcome);
    // An unknown outcome leaves the context coherent only for effects that keep it as it is.
    assert.equal(commandEffect(declared, "unknown"), declared === "keep" || declared === "none" ? declared : "unknown", declared + " unknown");
  }
  // A clear that never ran (OpenCode's ignored command, Codex's refused compaction) or that answered a no-op does not clear.
  assert.equal(commandEffect("clear", "not_recorded"), "none"); assert.equal(commandEffect("compact", "noop"), "none");
});

test("G067-C06 a command Turn's outcome: undispatched or refused is not recorded, a completed one executed or, when its driver read a no-op, noop, anything else unknown", () => {
  const statuses = ["completed", "cancelled", "failed", null] as const, inputs: readonly InputOutcome[] = ["recorded", "not_recorded", "unknown"];
  for (const status of statuses) for (const input of inputs) for (const noop of [false, true]) {
    assert.equal(commandOutcome(false, status, input, noop), "not_recorded", "never dispatched");
    const expected: CommandOutcome = input === "not_recorded" ? "not_recorded" : status !== "completed" ? "unknown" : noop ? "noop" : "executed";
    assert.equal(commandOutcome(true, status, input, noop), expected, String(status) + " " + input + (noop ? " noop" : ""));
  }
  assert.equal(commandOutcome(true, "completed", "unknown"), "executed", "no word of a no-op is no no-op");
});

test("G067-C01 the native position moves only by advance ⇔ dispatched ∧ (due = ∅ ∨ carried ∧ (input = recorded ∨ input = unknown ∧ resent once))", () => {
  const inputs: readonly InputOutcome[] = ["recorded", "not_recorded", "unknown"];
  let combinations = 0;
  for (const dispatchedTurn of [false, true]) for (const due of [0, 1, 3]) for (const carried of [false, true]) for (const input of inputs) for (const resend of [false, true]) {
    const stated = dispatchedTurn && (due === 0 || carried && (input === "recorded" || input === "unknown" && resend));
    assert.equal(advances({ dispatched: dispatchedTurn, due, carried, input, resend }), stated, JSON.stringify({ dispatchedTurn, due, carried, input, resend }));
    combinations++;
  }
  assert.equal(combinations, 72);
  // The four cases of G067-C01, named: nothing owed; carried and recorded; carried and unknown, first and after one resend; not recorded.
  assert.equal(advances({ dispatched: true, due: 0, carried: false, input: "not_recorded", resend: false }), true, "nothing owed: even an input the native side never took advances");
  assert.equal(advances({ dispatched: true, due: 2, carried: true, input: "recorded", resend: false }), true);
  assert.equal(advances({ dispatched: true, due: 2, carried: true, input: "unknown", resend: false }), false);
  assert.equal(advances({ dispatched: true, due: 2, carried: true, input: "unknown", resend: true }), true);
  assert.equal(advances({ dispatched: true, due: 2, carried: true, input: "not_recorded", resend: true }), false);
  // A command, or an input sent alone, owing facts never advances, whatever its outcome.
  for (const input of inputs) assert.equal(advances({ dispatched: true, due: 1, carried: false, input, resend: false }), false, input);
});

test("a Run counts as dispatched by its recorded dispatch time, and a Run from before v10 by its settlement or unknown end", () => {
  const base: PublicRun = { id: runId("run-1"), commandId: commandId("send-1"), input: "x", userMessageId: messageId("message-1"), assistantMessageId: messageId("message-2"),
    selection: { harnessId: "alpha", controlId: "alpha-acp" }, epoch: 1, status: "cancelled", cancelRequested: true, contextThroughSeq: 0, sourceRunIds: [],
    backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null };
  assert.equal(dispatched({ ...base, timing: { acceptedAt: 1, preparingAt: 2 } }), false, "preparing only");
  assert.equal(dispatched({ ...base, timing: { acceptedAt: 1, dispatchedAt: 3 } }), true);
  // Times decide even against a settlement: a Run with times and no dispatch time never reached its Harness.
  assert.equal(dispatched({ ...base, status: "failed", backend: { status: "failed", reason: "x" }, timing: { acceptedAt: 1 } }), false);
  assert.equal(dispatched(base), false, "cancelled while queued, before v10");
  assert.equal(dispatched({ ...base, backend: { status: "cancelled", reason: "x" } }), true);
  assert.equal(dispatched({ ...base, status: "unknown" }), true, "an unknown end may have reached a Harness");
});
