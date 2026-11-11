import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_EFFECTS, DELIVERY_STATUSES, LEGACY_CONTINUITY, MAX_BINDING_RELAY_BYTES, MAX_RUN_RELAY_BYTES, RELAY_MAX_RUNS, RELAY_MAX_SEQ, RELAY_PREF_KEYS,
  deliveryTransitionAllowed, packetsOf, parseBindingRelayState, parseContinuityLevel, parseDeliveryOutcome, parseHandoffRecord, parseRelayPref,
  parseRunRelay, parseRunRelayRequest, parseSwitchTiming, type DeliveryStatus,
} from "../../src/contracts/relay.js";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { MAX_RUNS, MAX_SESSION_EVENTS, assertSessionTransition, parseSession } from "../../src/contexts/session/domain/state.js";

// The relay contract's parsers and bounds (ADR-055 §4, §14.3; slim.md), and the v13 rules of assertSessionTransition, each
// with an invalid sample. Pure: nothing here opens a store or runs a Harness.

const hex = (char: string) => char.repeat(64);
const packet = (char: string) => "relay-" + char.repeat(20);
const clean = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const alpha = { harnessId: "alpha", controlId: "alpha-acp" }, bravo = { harnessId: "bravo", controlId: "bravo-acp" };
type Plain = Record<string, unknown>;
function relay(extra: Plain = {}): Plain { return { epoch: 1, mark: 3, floor: -1, pending: null, resendAll: false, ...extra }; }
function run(suffix: string, seq: number, selection: Plain = alpha, extra: Plain = {}): Plain {
  return { id: "run-" + suffix, commandId: "send-" + suffix, input: "input " + suffix, userMessageId: "message-user-" + suffix, assistantMessageId: "message-assistant-" + suffix,
    selection, epoch: 1, status: "completed", cancelRequested: false, contextThroughSeq: seq - 1, sourceRunIds: [],
    backend: { status: "completed", reason: "fixture" }, cleanup: clean, error: null, stopRequested: false, awaitingSwitchId: null,
    timing: { acceptedAt: 10, preparingAt: 11, contextReadyAt: 12, readyAt: 13, dispatchedAt: 14, endedAt: 20 }, ...extra };
}
/** A v13 conversation on alpha: Run one finished at seq 2, Run two either finished (seq 4) or running as the binding's writer. */
function state(options: { busy?: boolean; bindings?: Plain[]; runs?: Plain[]; extra?: Plain; schemaVersion?: number } = {}): Plain {
  const one = run("one", 2), two = options.busy ? run("two", 4, alpha, { status: "running", backend: null, cleanup: null, timing: { acceptedAt: 10, preparingAt: 11, contextReadyAt: 12, readyAt: 13 } }) : run("two", 4);
  const runs = options.runs ?? [one, two];
  return { schemaVersion: options.schemaVersion ?? 13, id: "session-relay", version: 4, lastSeq: 4, epoch: 1, status: "open",
    configuration: { workspace: "/workspace", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    selection: alpha, activeRunId: options.busy ? "run-two" : null, pendingSwitchId: null, runs,
    messages: runs.flatMap((row, index) => [
      { id: row.userMessageId, runId: row.id, role: "user", text: row.input, seq: index * 2 + 1, status: row.status },
      ...(row.status === "queued" ? [] : [{ id: row.assistantMessageId, runId: row.id, role: "assistant", text: "answer", seq: index * 2 + 2, status: row.status }])]),
    switches: [], commands: [{ id: "create", kind: "create", fingerprint: hex("a"), resultId: "session-relay" }, ...runs.map(row => ({ id: row.commandId, kind: "send", fingerprint: hex("a"), resultId: row.id }))],
    nativeBindings: options.bindings ?? [{ ...alpha, checkpoint: "native-alpha", throughRunId: options.busy ? "run-one" : "run-two", status: options.busy ? "unconfirmed" : "ready", relay: relay() }],
    ...options.extra };
}
const parsed = (value: Plain): SessionSnapshot => parseSession(value);
function rejects(before: Plain, after: Plain, pattern: RegExp, events: readonly { type: string; data: Plain }[] = []): void {
  assert.throws(() => assertSessionTransition(parsed(before), parsed(after), events), (error: unknown) => error instanceof SessionError && error.code === "INVALID_TRANSITION" && pattern.test(error.message));
}
function accepts(before: Plain, after: Plain, events: readonly { type: string; data: Plain }[] = []): void { assertSessionTransition(parsed(before), parsed(after), events); }
function withBinding(value: Plain, index: number, patch: Plain): Plain {
  const bindings = [...(value.nativeBindings as Plain[])]; bindings[index] = { ...bindings[index], ...patch };
  return { ...value, nativeBindings: bindings };
}
function withRelay(value: Plain, index: number, patch: Plain): Plain {
  const bindings = value.nativeBindings as Plain[];
  return withBinding(value, index, { relay: { ...(bindings[index]!.relay as Plain), ...patch } });
}

test("the relay contract's closed enums and bounds agree with the Session domain", () => {
  assert.equal(RELAY_MAX_SEQ, MAX_SESSION_EVENTS); assert.equal(RELAY_MAX_RUNS, MAX_RUNS);
  assert.deepEqual([...CONTEXT_EFFECTS].sort(), ["clear", "compact", "keep", "none", "rewind", "unknown"]);
  assert.deepEqual(Object.keys(LEGACY_CONTINUITY).sort(), ["native_fork", "native_import", "native_resume", "public_context_rehydrate"]);
  assert.deepEqual([...RELAY_PREF_KEYS], ["relay.attach"]);
  // The delivery table: a row moves from in flight to any decided outcome, and a decided one only to itself.
  const allowed = new Set(["in_flight>recorded", "in_flight>not_recorded", "in_flight>unknown", "unknown>unknown", "not_recorded>not_recorded", "recorded>recorded"]);
  for (const from of DELIVERY_STATUSES) for (const to of DELIVERY_STATUSES) assert.equal(deliveryTransitionAllowed(from as DeliveryStatus, to as DeliveryStatus), allowed.has(from + ">" + to), from + ">" + to);
});

test("binding relay states parse field by field and reject what the contract does not allow", () => {
  const pending = { packetId: packet("b"), fromSeq: 6, throughSeq: 9, autoResends: 1 };
  const state = parseBindingRelayState(relay({ pending, mark: 5 }));
  assert.equal(state.mark, 5); assert.deepEqual(packetsOf(state), [packet("b")]); assert.deepEqual(packetsOf(parseBindingRelayState(relay())), []);
  assert.deepEqual(parseBindingRelayState(relay({ mark: -1, floor: 7, resendAll: true })), { epoch: 1, mark: -1, floor: 7, pending: null, resendAll: true });
  for (const [label, value] of [
    ["unknown field", relay({ extra: 1 })], ["the old sync state", relay({ sync: { kind: "synced" } })], ["epoch 0", relay({ epoch: 0 })], ["floor below -1", relay({ floor: -2 })], ["mark below -1", relay({ mark: -2 })],
    ["mark beyond the Session", relay({ mark: RELAY_MAX_SEQ + 1 })], ["epoch beyond the Session", relay({ epoch: RELAY_MAX_SEQ + 2 })],
    ["bad packet id", relay({ pending: { ...pending, packetId: "relay-UPPERCASEUPPERCASE00" } })], ["two automatic resends", relay({ pending: { ...pending, autoResends: 2 } })],
    ["a pending range that runs backwards", relay({ pending: { ...pending, fromSeq: 10, throughSeq: 9 } })], ["a pending packet with an unknown field", relay({ pending: { ...pending, attachOverride: true } })],
    ["resendAll not a boolean", relay({ resendAll: 1 })], ["pending missing", { epoch: 1, mark: 3, floor: -1, resendAll: false }],
  ] as const) assert.throws(() => parseBindingRelayState(value), SessionError, label);
});

test("a handoff log row is the first handoff to one Harness", () => {
  assert.deepEqual(parseHandoffRecord({ logSeq: 1, harnessId: "codex", firstAt: 5 }), { logSeq: 1, harnessId: "codex", firstAt: 5 });
  for (const value of [{ logSeq: 0, harnessId: "codex", firstAt: 5 }, { logSeq: 1, harnessId: "Codex", firstAt: 5 }, { logSeq: 1, harnessId: "codex", firstAt: -1 }, { logSeq: 1, harnessId: "codex", firstAt: 5, vendor: "x" }])
    assert.throws(() => parseHandoffRecord(value), SessionError);
});

test("continuity levels are objects in snapshots and read v12's strings only as legacy", () => {
  assert.deepEqual(parseContinuityLevel({ kind: "native_resume_delta", tier: "standard", runs: 2 }), { kind: "native_resume_delta", tier: "standard", runs: 2 });
  assert.deepEqual(parseContinuityLevel("public_context_rehydrate", true), { kind: "rehydrate", tier: "standard", complete: false });
  assert.deepEqual(parseContinuityLevel("native_fork", true), { kind: "native_fork" });
  for (const value of ["public_context_rehydrate", { kind: "rehydrate", tier: "standard" }, { kind: "blocked", code: "ELSEWHERE" }, { kind: "native_resume", extra: 1 }])
    assert.throws(() => parseContinuityLevel(value), SessionError);
  for (const value of ["constructor", "toString", "blocked", "unsupported"]) assert.throws(() => parseContinuityLevel(value, true), SessionError, value);
  assert.deepEqual(parseRunRelay({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...alpha, nativeEpoch: 2 } }).executedOn?.nativeEpoch, 2);
  assert.throws(() => parseRunRelay({ packetId: packet("a"), kind: null, continuity: { kind: "native_resume" }, executedOn: null }), /go together/u);
  assert.deepEqual(parseRunRelayRequest({ attach: "none", fingerprint: hex("b") }), { attach: "none", fingerprint: hex("b") });
  for (const value of [{ resend: true, fingerprint: hex("b") }, { fingerprint: "b" }, { attach: "maybe", fingerprint: hex("b") }, { attach: "auto", fingerprint: hex("b") }]) assert.throws(() => parseRunRelayRequest(value), SessionError);
  assert.deepEqual(parseSwitchTiming({ requestedAt: 5, validatedAt: 6, effectiveAt: 6 }), { requestedAt: 5, validatedAt: 6, effectiveAt: 6 });
  for (const value of [{ requestedAt: 5, validatedAt: 4 }, { requestedAt: 5, effectiveAt: 4 }, { validatedAt: 5 }]) assert.throws(() => parseSwitchTiming(value), SessionError);
  assert.deepEqual(parseDeliveryOutcome({ kind: "unknown", reason: "owner_ended", decidedSeq: 3, decidedAt: 9 }).kind, "unknown");
  assert.deepEqual(parseDeliveryOutcome({ kind: "recorded", evidence: "E1", decidedSeq: 3, decidedAt: 9 }).kind, "recorded");
  for (const value of [{ kind: "unknown", reason: "lost", decidedSeq: 3, decidedAt: 9 }, { kind: "recorded", evidence: "E2", decidedSeq: 3, decidedAt: 9 }, { kind: "recorded", evidence: "E1", decidedSeq: 3, decidedAt: 9, verifiedInRun: null }, { kind: "in_flight", reason: "x" }])
    assert.throws(() => parseDeliveryOutcome(value), SessionError);
  assert.deepEqual(parseRelayPref("relay.attach", "off"), { key: "relay.attach", value: "off" });
  for (const [key, value] of [["relay.other", "x"], ["relay.attach", "yes"], ["relay.crossVendor", "allow"], ["relay.attach", "x".repeat(65)]] as const) assert.throws(() => parseRelayPref(key, value), SessionError);
});

test("v13 snapshots carry relay state on every binding and v13 fields only from v13", () => {
  const value = state(), current = parsed(value);
  assert.equal(current.schemaVersion, 13); assert.equal(current.nativeBindings?.[0]?.relay?.mark, 3);
  const v12: Plain = { ...value, schemaVersion: 12, nativeBindings: [{ ...alpha, checkpoint: "native-alpha", throughRunId: "run-two", status: "ready" }],
    runs: (value.runs as Plain[]).map(row => ({ ...row, timing: { acceptedAt: 10, preparingAt: 11, readyAt: 13, dispatchedAt: 14, endedAt: 20 } })) };
  assert.equal(parsed(v12).schemaVersion, 12, "a v12 snapshot still reads, for the migration");
  const runs = value.runs as Plain[];
  for (const [label, invalid] of [
    ["a v13 binding without relay", withBinding(value, 0, { relay: undefined })],
    ["relay on a v12 binding", { ...v12, nativeBindings: [{ ...(v12.nativeBindings as Plain[])[0], relay: relay() }] }],
    ["contextReadyAt before v13", { ...v12, runs: (v12.runs as Plain[]).map(row => ({ ...row, timing: { acceptedAt: 10, contextReadyAt: 11 } })) }],
    ["backend input before v13", { ...v12, runs: (v12.runs as Plain[]).map(row => ({ ...row, backend: { status: "completed", reason: "fixture", input: "recorded" } })) }],
    ["relayRecoveryFailed before v13", { ...v12, relayRecoveryFailed: 3 }], ["relayRecoveryFailed after the events", { ...value, relayRecoveryFailed: 5 }],
    ["executedOn of another Harness", { ...value, runs: [runs[0], { ...runs[1], relay: { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...bravo, nativeEpoch: 1 } } }] }],
    ["recordedAt before dispatch", { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, dispatchedAt: 14, recordedAt: 13, endedAt: 20 } }] }],
    ["recordedAt without dispatch", { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, recordedAt: 13 } }] }],
    ["contextReadyAt after readyAt", { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, readyAt: 12, contextReadyAt: 13 } }] }],
    ["an epoch that does not grow along a lineage", { ...value, nativeBindings: [{ ...(value.nativeBindings as Plain[])[0], status: "archived" }, { ...alpha, checkpoint: "native-alpha-2", throughRunId: null, status: "ready", relay: relay({ mark: -1 }) }] }],
    ["a floor that goes down along a lineage", { ...value, nativeBindings: [{ ...(value.nativeBindings as Plain[])[0], status: "archived", relay: relay({ floor: 2 }) }, { ...alpha, checkpoint: "native-alpha-2", throughRunId: null, status: "ready", relay: relay({ epoch: 2, floor: 1, mark: -1 }) }] }],
  ] as const) assert.throws(() => parsed(invalid as Plain), SessionError, label);
  const timed = { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, preparingAt: 11, contextReadyAt: 12, readyAt: 13, dispatchedAt: 14, recordedAt: 15, firstOutputAt: 15, endedAt: 20 } }] };
  assert.equal(parsed(timed).runs[1]?.timing?.recordedAt, 15);
  const lineage = { ...value, nativeBindings: [{ ...(value.nativeBindings as Plain[])[0], status: "archived", relay: relay({ floor: 2 }) }, { ...alpha, checkpoint: "native-alpha-2", throughRunId: null, status: "ready", relay: relay({ epoch: 2, floor: 2, mark: -1 }) }] };
  assert.equal(parsed(lineage).nativeBindings?.[1]?.relay?.epoch, 2);
});

test("G066 a recovery switch acknowledges unknown Runs by acknowledgedUnknown as by its sources (K19)", () => {
  const unknown = run("two", 4, alpha, { status: "unknown", backend: null, error: { code: "OWNER_ENDED", message: "x" } });
  const base = state({ runs: [run("one", 2), unknown], bindings: [{ ...alpha, checkpoint: "native-alpha", throughRunId: "run-one", status: "ready", relay: relay() }] }), sw = { id: "switch-r", commandId: "recover", requested: { harnessId: "alpha" }, requestedSeq: 5, target: alpha, status: "effective", throughSeq: 5, sourceRunIds: [], error: null };
  const recovered = { ...base, lastSeq: 6, epoch: 2, switches: [{ ...sw, acknowledgedUnknown: ["run-two"], mode: "wait_current", timing: { requestedAt: 21, validatedAt: 22, effectiveAt: 23 } }],
    commands: [...(base.commands as Plain[]), { id: "recover", kind: "switch", fingerprint: hex("a"), resultId: "switch-r" }] };
  assert.deepEqual(parsed(recovered).switches[0]?.acknowledgedUnknown, ["run-two"]);
  assert.equal(parsed({ ...recovered, switches: [{ ...sw, sourceRunIds: ["run-two"] }] }).status, "open", "the old form still reads");
  assert.throws(() => parsed({ ...recovered, switches: [{ ...sw }] }), /unknown execution/u);
  assert.throws(() => parsed({ ...recovered, switches: [{ ...sw, acknowledgedUnknown: ["run-one"] }] }), SessionError, "a completed Run is no unknown one");
  assert.throws(() => parsed({ ...recovered, switches: [{ ...sw, acknowledgedUnknown: ["run-two", "run-two"] }] }), SessionError);
  const late = { ...recovered, switches: [{ ...sw, requestedSeq: 2, acknowledgedUnknown: ["run-two"] }] };
  assert.throws(() => parsed(late), SessionError, "acknowledged input after the request");
  // Only a blocked Session takes a switch acknowledging unknown Runs.
  const requested = (status: string) => ({ ...base, status, lastSeq: 5, pendingSwitchId: "switch-r", switches: [{ ...sw, status: "requested", target: null, throughSeq: 0, acknowledgedUnknown: ["run-two"] }],
    commands: [...(base.commands as Plain[]), { id: "recover", kind: "switch", fingerprint: hex("a"), resultId: "switch-r" }] });
  accepts({ ...base, status: "blocked" }, requested("blocked"));
  const opened = { ...recovered, switches: [{ ...sw, sourceRunIds: ["run-two"] }] }, again = { ...sw, id: "switch-s", commandId: "again", requestedSeq: 7, status: "requested", target: null, throughSeq: 0, acknowledgedUnknown: ["run-two"] };
  rejects(opened, { ...opened, lastSeq: 7, pendingSwitchId: "switch-s", switches: [...opened.switches, again],
    commands: [...(opened.commands as Plain[]), { id: "again", kind: "switch", fingerprint: hex("a"), resultId: "switch-s" }] }, /only by a recovery switch/u);
});

test("a binding's relay state changes only by the Run that ran on it, migration or recovery", () => {
  const busy = state({ busy: true });
  accepts(busy, withRelay(busy, 0, { mark: 4 }));
  // A Run of bravo changing alpha's relay state: invalid.
  const bravoRun = run("two", 4, bravo, { status: "running", backend: null, cleanup: null, timing: { acceptedAt: 10, preparingAt: 11 } });
  const foreign = state({ busy: true, runs: [run("one", 2), bravoRun] });
  rejects(foreign, withRelay(foreign, 0, { resendAll: true }), /without its original Run owner/u);
  // Without any Run (idle): invalid, whatever else is committed with it.
  const idle = state();
  rejects(idle, withRelay(idle, 0, { resendAll: true }), /without its original Run owner/u);
});

test("native epochs, clear floors and marks only move forward, except a clear that starts the next epoch", () => {
  const busy = state({ busy: true });
  rejects(withRelay(busy, 0, { epoch: 3 }), withRelay(busy, 0, { epoch: 2 }), /native epoch cannot go back/u);
  rejects(withRelay(busy, 0, { floor: 3 }), withRelay(busy, 0, { floor: 2 }), /clear floor cannot go down/u);
  rejects(busy, withRelay(busy, 0, { mark: 2 }), /mark cannot go down within an epoch/u);
  rejects(busy, withRelay(busy, 0, { mark: -1 }), /mark cannot go down within an epoch/u);
  // A clear starts a new epoch with a floor and no mark.
  accepts(busy, withRelay(busy, 0, { epoch: 2, floor: 4, mark: -1 }));
  // Moving forward within an epoch, a pending packet and a resend-all mark are fine.
  accepts(busy, withRelay(busy, 0, { mark: 3, pending: { packetId: packet("c"), fromSeq: 3, throughSeq: 3, autoResends: 0 } }));
  accepts(busy, withRelay(busy, 0, { resendAll: true }));
});

test("an archived binding's relay state is frozen, and a native reset archives it as it was", () => {
  const archived = state({ bindings: [{ ...alpha, checkpoint: "native-alpha", throughRunId: "run-two", status: "archived", relay: relay() }] });
  rejects(archived, withRelay(archived, 0, { resendAll: true }), /archived state changed/u);
  const idle = state(), reset = { id: "reset", kind: "native-reset", fingerprint: hex("a"), resultId: "session-relay" };
  accepts(idle, { ...withBinding(idle, 0, { status: "archived" }), commands: [...(idle.commands as Plain[]), reset] });
  rejects(idle, { ...withBinding(withRelay(idle, 0, { resendAll: true }), 0, { status: "archived" }), commands: [...(idle.commands as Plain[]), reset] }, /without its original Run owner/u);
});

test("a Run's relay fields are fixed once it runs, and its relay request once accepted", () => {
  const executed = { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...alpha, nativeEpoch: 1 } };
  const runs = (relayField: Plain | undefined, timing: Plain, status = "running", request?: Plain) => [run("one", 2),
    run("two", 4, alpha, { status, backend: null, cleanup: null, timing, ...(relayField === undefined ? {} : { relay: relayField }), ...(request === undefined ? {} : { relayRequest: request }) })];
  const preparing = state({ busy: true, runs: runs(undefined, { acceptedAt: 10, preparingAt: 11 }, "preparing") });
  const running = state({ busy: true, runs: runs(executed, { acceptedAt: 10, preparingAt: 11, contextReadyAt: 12, readyAt: 13 }) });
  accepts(preparing, running);
  rejects(running, state({ busy: true, runs: runs({ ...executed, continuity: { kind: "rehydrate", tier: "standard", complete: true } }, { acceptedAt: 10, preparingAt: 11, contextReadyAt: 12, readyAt: 13 }) }), /dispatched context cannot change/u);
  rejects(running, state({ busy: true, runs: runs(executed, { acceptedAt: 10, preparingAt: 11, contextReadyAt: 13, readyAt: 13 }) }), /dispatched context cannot change/u);
  const request = { attach: "none", fingerprint: hex("c") };
  const queued = (relayRequest: Plain) => state({ runs: [run("one", 2), run("two", 4, alpha, { status: "queued", backend: null, cleanup: null, contextThroughSeq: 0, timing: { acceptedAt: 10 }, relayRequest })],
    bindings: [{ ...alpha, checkpoint: "native-alpha", throughRunId: "run-one", status: "ready", relay: relay() }] });
  rejects(queued(request), queued({ ...request, attach: "full" }), /input and identities are immutable/u);
});

test("a writer Run archives its binding for a new one of the same Harness only when its end reports native.cleared", () => {
  const busy = state({ busy: true }), fresh = { ...alpha, checkpoint: "native-alpha-new", throughRunId: null, status: "unconfirmed", relay: relay({ epoch: 2, floor: 4, mark: -1 }) };
  const replaced = { ...withBinding(busy, 0, { status: "archived" }), nativeBindings: [{ ...(busy.nativeBindings as Plain[])[0], status: "archived" }, fresh] };
  const end = (native: Plain | undefined) => [{ type: "run.ended", data: { runId: "run-two", status: "completed", ...(native === undefined ? {} : { native }) } }];
  accepts(busy, replaced, end({ cleared: true, replaced: null }));
  rejects(busy, replaced, /archived only by a native reset/u, end(undefined));
  rejects(busy, replaced, /archived only by a native reset/u, end({ cleared: false }));
  rejects(busy, replaced, /archived only by a native reset/u, [{ type: "run.ended", data: { runId: "run-one", native: { cleared: true } } }]);
  // Archiving with native.cleared still freezes the relay state it had.
  rejects(busy, { ...replaced, nativeBindings: [{ ...(busy.nativeBindings as Plain[])[0], status: "archived", relay: relay({ resendAll: true }) }, fresh] }, /archived only by a native reset/u, end({ cleared: true }));
});

test("a relay recovery failure is recorded by recovery and cleared by a new native session", () => {
  const idle = state(), failed: Plain = { ...idle, lastSeq: 5, relayRecoveryFailed: 5 };
  rejects({ ...idle, lastSeq: 4 }, failed, /recorded by recovery/u);
  accepts({ ...idle, lastSeq: 4 }, failed, [{ type: "session.recovered", data: { relay: { failed: true } } }]);
  rejects(failed, { ...failed, relayRecoveryFailed: undefined }, /cleared by a new native session/u);
  const reset = { id: "reset", kind: "native-reset", fingerprint: hex("a"), resultId: "session-relay" };
  accepts(failed, { ...withBinding(failed, 0, { status: "archived" }), relayRecoveryFailed: undefined, commands: [...(failed.commands as Plain[]), reset] });
});

test("the longest legal relay state of a binding and of a Run stays within its byte bound", () => {
  // Every field at its longest: the largest numbers, a pending packet at its automatic resend, "false" rather than "true".
  const longest = relay({ epoch: RELAY_MAX_SEQ + 1, mark: RELAY_MAX_SEQ, floor: RELAY_MAX_SEQ, resendAll: false,
    pending: { packetId: packet("a"), fromSeq: RELAY_MAX_SEQ, throughSeq: RELAY_MAX_SEQ, autoResends: 1 } });
  const bytes = Buffer.byteLength(JSON.stringify(parseBindingRelayState(longest)));
  assert.ok(bytes <= MAX_BINDING_RELAY_BYTES, bytes + " B"); assert.ok(bytes > MAX_BINDING_RELAY_BYTES - 128, "the bound is close to the longest value: " + bytes + " B");
  const id = "a" + "b".repeat(95);
  // The longest continuity level is a delta of the most Runs at a long tier name; "resend" is the longest packet kind.
  const runRelay = { packetId: packet("f"), kind: "resend", continuity: { kind: "native_resume_delta", tier: "fidelity", runs: 256 }, executedOn: { harnessId: id, controlId: id, nativeEpoch: RELAY_MAX_SEQ + 1 } };
  const request = { attach: "full", fingerprint: hex("f") };
  const runBytes = Buffer.byteLength(JSON.stringify({ relay: parseRunRelay(runRelay), relayRequest: parseRunRelayRequest(request) }));
  assert.ok(runBytes <= MAX_RUN_RELAY_BYTES, runBytes + " B");
});
