import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_EFFECTS, DELIVERY_STATUSES, EMPTY_CHAIN, LEGACY_CONTINUITY, MAX_BINDING_RELAY_BYTES, MAX_RUN_RELAY_BYTES, RELAY_MAX_RUNS, RELAY_MAX_SEQ, RELAY_PREF_KEYS,
  deliveryTransitionAllowed, markOf, packetsOf, parseBindingRelayState, parseConsentRecord, parseContinuityLevel, parseDeliveryOutcome, parseDeliveryPosition, parseRelayPref,
  parseRunRelay, parseRunRelayRequest, parseSwitchTiming, parseVendorKey, type DeliveryStatus,
} from "../../src/contracts/relay.js";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { MAX_RUNS, MAX_SESSION_EVENTS, assertSessionTransition, parseSession } from "../../src/contexts/session/domain/state.js";

// G066 (ADR-055 §4, §14.3): the relay contract's parsers and bounds, and the v13 rules of assertSessionTransition, each
// with an invalid sample (G066-C06). Pure: nothing here opens a store or runs a Harness.

const hex = (char: string) => char.repeat(64);
const packet = (char: string) => "relay-" + char.repeat(20);
const clean = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const alpha = { harnessId: "alpha", controlId: "alpha-acp" }, bravo = { harnessId: "bravo", controlId: "bravo-acp" };
type Plain = Record<string, unknown>;
function mark(throughSeq: number, extra: Plain = {}): Plain { return { throughSeq, chain: EMPTY_CHAIN, lastPacketId: null, evidence: "legacy", basis: "legacy", ...extra }; }
function relay(extra: Plain = {}): Plain {
  return { nativeEpoch: 1, sync: { kind: "synced", mark: mark(3) }, originIncluded: false, reanchor: false, packetsInEpoch: 0, epochFloor: -1,
    compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null, cache: { lastRequestStartedAt: null, contextUsed: null, contextSize: null }, ...extra };
}
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

test("G066 the relay contract's closed enums and bounds agree with the Session domain", () => {
  assert.equal(RELAY_MAX_SEQ, MAX_SESSION_EVENTS); assert.equal(RELAY_MAX_RUNS, MAX_RUNS);
  assert.deepEqual([...CONTEXT_EFFECTS].sort(), ["clear", "compact", "keep", "none", "rewind", "unknown"]);
  assert.deepEqual(Object.keys(LEGACY_CONTINUITY).sort(), ["native_fork", "native_import", "native_resume", "public_context_rehydrate"]);
  assert.deepEqual([...RELAY_PREF_KEYS].sort(), ["relay.allowUnprobed", "relay.crossVendor", "relay.localModelsOffline", "relay.returnPreference"]);
  // The delivery table of relay-architecture §4, all 16 pairs.
  const allowed = new Set(["in_flight>recorded", "in_flight>not_recorded", "in_flight>unknown", "unknown>unknown", "unknown>recorded", "unknown>not_recorded", "not_recorded>recorded", "recorded>recorded"]);
  for (const from of DELIVERY_STATUSES) for (const to of DELIVERY_STATUSES) assert.equal(deliveryTransitionAllowed(from as DeliveryStatus, to as DeliveryStatus), allowed.has(from + ">" + to), from + ">" + to);
});

test("G066 binding relay states parse field by field and reject what the contract does not allow", () => {
  // Since G068 (ADR-055, the approval agent's decisions of 2026-11-09 and 2026-11-10): a suspect state of a CARRIED_CAUSES cause
  // may keep the packet that was pending, a pending sync's prior carries none, and only an unconfirmed clear is marked rewound.
  const carrying = { kind: "suspect", mark: mark(5), cause: "unknown_turn", floorCandidate: null,
    carried: { prior: { kind: "fresh", basis: "new" }, packetId: packet("a"), range: { fromSeq: 0, throughSeq: 5, fromRun: 0, throughRun: 2 }, attachOverride: true }, rewound: false };
  const pending = { kind: "pending", prior: { kind: "suspect", mark: mark(5), cause: "rewind", floorCandidate: null, carried: null, rewound: false },
    packetId: packet("b"), range: { fromSeq: 6, throughSeq: 9, fromRun: 3, throughRun: 4 }, autoResends: 1, manualResends: 0, attachOverride: false };
  const state = parseBindingRelayState(relay({ sync: pending, consentKey: "gateway:relay.example.com" }));
  assert.equal(markOf(state.sync)?.throughSeq, 5); assert.deepEqual(packetsOf(state.sync), [packet("b")]);
  assert.deepEqual(packetsOf(parseBindingRelayState(relay({ sync: carrying })).sync), [packet("a")]);
  for (const cause of ["rewind", "unknown_command", "clear_unconfirmed"]) assert.doesNotThrow(() => parseBindingRelayState(relay({ sync: { ...carrying, cause } })), cause);
  assert.equal(parseBindingRelayState(relay({ sync: { ...carrying, cause: "clear_unconfirmed", floorCandidate: 9, rewound: true } })).sync.kind, "suspect");
  assert.equal(markOf(parseBindingRelayState(relay({ sync: { kind: "fresh", basis: "user_cleared" } })).sync), null);
  for (const [label, value] of [
    ["unknown field", relay({ extra: 1 })], ["epoch 0", relay({ nativeEpoch: 0 })], ["floor below -1", relay({ epochFloor: -2 })],
    ["seq beyond the Session", relay({ sync: { kind: "synced", mark: mark(RELAY_MAX_SEQ + 1) } })],
    ["bad chain", relay({ sync: { kind: "synced", mark: mark(1, { chain: "x" }) } })], ["bad packet id", relay({ sync: { ...pending, packetId: "relay-UPPERCASEUPPERCASE00" } })],
    ["pending inside pending", relay({ sync: { ...pending, prior: pending } })], ["two automatic resends", relay({ sync: { ...pending, autoResends: 2 } })],
    ["carried by a cause that carries none", relay({ sync: { ...carrying, cause: "legacy" } })], ["carried by marker_absent", relay({ sync: { ...carrying, cause: "marker_absent" } })],
    ["carried inside carried", relay({ sync: { ...carrying, carried: { ...carrying.carried, prior: carrying } } })],
    ["a pending prior that carries", relay({ sync: { ...pending, prior: carrying } })],
    ["rewound with a cause other than an unconfirmed clear", relay({ sync: { ...carrying, rewound: true } })],
    ["carried without its attach override", relay({ sync: { ...carrying, carried: { ...carrying.carried, attachOverride: undefined } } })],
    ["carried attach override not a boolean", relay({ sync: { ...carrying, carried: { ...carrying.carried, attachOverride: "true" } } })],
    ["a suspect state without rewound", relay({ sync: { ...carrying, rewound: undefined } })], ["rewound not a boolean", relay({ sync: { ...carrying, cause: "clear_unconfirmed", rewound: 1 } })],
    ["unknown sync kind", relay({ sync: { kind: "lost" } })], ["vendor key", relay({ consentKey: "gateway:Upper.Example" })],
    ["host too long", relay({ consentKey: "gateway:" + "h".repeat(254) })], ["model too long", relay({ vendorObserved: { model: "m".repeat(97), modelKey: "", authKind: null, endpoint: null, loopback: false } })],
    ["endpoint layer", relay({ vendorObserved: { model: null, modelKey: "", authKind: null, endpoint: { host: "a.example", layer: "elsewhere" }, loopback: false } })],
  ] as const) assert.throws(() => parseBindingRelayState(value), SessionError, label);
  for (const key of ["anthropic", "local", "gateway:api.example.com", "gateway:[::1]", "router:open-router", "provider:my.provider_1", "unknown:claude-code"]) assert.equal(parseVendorKey(key), key);
  for (const key of ["", "gateway:", "gateway:a..b", "router:", "unknown:Claude", "elsewhere:x", "anthropic:x"]) assert.throws(() => parseVendorKey(key), SessionError, key);
});

test("G066 continuity levels are objects in snapshots and read v12's strings only as legacy", () => {
  assert.deepEqual(parseContinuityLevel({ kind: "native_resume_delta", tier: "standard", runs: 2 }), { kind: "native_resume_delta", tier: "standard", runs: 2 });
  assert.deepEqual(parseContinuityLevel("public_context_rehydrate", true), { kind: "rehydrate", tier: "standard", complete: false });
  assert.deepEqual(parseContinuityLevel("native_fork", true), { kind: "native_fork" });
  for (const value of ["public_context_rehydrate", { kind: "rehydrate", tier: "standard" }, { kind: "blocked", code: "ELSEWHERE" }, { kind: "native_resume", extra: 1 }])
    assert.throws(() => parseContinuityLevel(value), SessionError);
  for (const value of ["constructor", "toString", "blocked", "unsupported"]) assert.throws(() => parseContinuityLevel(value, true), SessionError, value);
  assert.deepEqual(parseRunRelay({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...alpha, nativeEpoch: 2 } }).executedOn?.nativeEpoch, 2);
  assert.throws(() => parseRunRelay({ packetId: packet("a"), kind: null, continuity: { kind: "native_resume" }, executedOn: null }), /go together/u);
  assert.deepEqual(parseRunRelayRequest({ attach: "none", fingerprint: hex("b") }), { attach: "none", fingerprint: hex("b") });
  for (const value of [{ resend: false, fingerprint: hex("b") }, { fingerprint: "b" }, { attach: "maybe", fingerprint: hex("b") }]) assert.throws(() => parseRunRelayRequest(value), SessionError);
  assert.deepEqual(parseSwitchTiming({ requestedAt: 5, validatedAt: 6, effectiveAt: 6 }), { requestedAt: 5, validatedAt: 6, effectiveAt: 6 });
  for (const value of [{ requestedAt: 5, validatedAt: 4 }, { requestedAt: 5, effectiveAt: 4 }, { validatedAt: 5 }]) assert.throws(() => parseSwitchTiming(value), SessionError);
  assert.deepEqual(parseDeliveryOutcome({ kind: "unknown", reason: "absent", decidedSeq: 3, decidedAt: 9 }).kind, "unknown");
  for (const value of [{ kind: "unknown", reason: "lost", decidedSeq: 3, decidedAt: 9 }, { kind: "recorded", evidence: "E4", decidedSeq: 3, decidedAt: 9, verifiedInRun: null }, { kind: "in_flight", reason: "x" }])
    assert.throws(() => parseDeliveryOutcome(value), SessionError);
  assert.throws(() => parseDeliveryPosition({ kind: "file_offset", path: "p".repeat(5000), bytes: 1 }), SessionError);
  assert.throws(() => parseConsentRecord({ logSeq: 1, commandId: "c", vendor: "openai", scope: { kind: "global" }, decision: "acknowledged", categories: ["user_text", "user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 }), SessionError);
  assert.deepEqual(parseRelayPref("relay.returnPreference", "ask"), { key: "relay.returnPreference", value: "ask" });
  for (const [key, value] of [["relay.other", "x"], ["relay.allowUnprobed", "yes"], ["relay.crossVendor", "x".repeat(65)]] as const) assert.throws(() => parseRelayPref(key, value), SessionError);
});

test("G066 v13 snapshots carry relay state on every binding and v13 fields only from v13", () => {
  const value = state(), current = parsed(value);
  assert.equal(current.schemaVersion, 13); assert.equal(current.nativeBindings?.[0]?.relay?.sync.kind, "synced");
  const v12: Plain = { ...value, schemaVersion: 12, nativeBindings: [{ ...alpha, checkpoint: "native-alpha", throughRunId: "run-two", status: "ready" }],
    runs: (value.runs as Plain[]).map(row => ({ ...row, timing: { acceptedAt: 10, preparingAt: 11, readyAt: 13, dispatchedAt: 14, endedAt: 20 } })) };
  assert.equal(parsed(v12).schemaVersion, 12, "a v12 snapshot still reads, for the migration");
  const runs = value.runs as Plain[];
  for (const [label, invalid] of [
    ["a v13 binding without relay", withBinding(value, 0, { relay: undefined })],
    ["relay on a v12 binding", { ...v12, nativeBindings: [{ ...(v12.nativeBindings as Plain[])[0], relay: relay() }] }],
    ["contextReadyAt before v13", { ...v12, runs: (v12.runs as Plain[]).map(row => ({ ...row, timing: { acceptedAt: 10, contextReadyAt: 11 } })) }],
    ["a relay command before v13", { ...v12, commands: [...(v12.commands as Plain[]), { id: "pin", kind: "relay-pin", fingerprint: hex("a"), resultId: "pin-1" }] }],
    ["backend input before v13", { ...v12, runs: (v12.runs as Plain[]).map(row => ({ ...row, backend: { status: "completed", reason: "fixture", input: "recorded" } })) }],
    ["relayRecoveryFailed before v13", { ...v12, relayRecoveryFailed: 3 }], ["relayRecoveryFailed after the events", { ...value, relayRecoveryFailed: 5 }],
    ["executedOn of another Harness", { ...value, runs: [runs[0], { ...runs[1], relay: { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...bravo, nativeEpoch: 1 } } }] }],
    ["recordedAt before dispatch", { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, dispatchedAt: 14, recordedAt: 13, endedAt: 20 } }] }],
    ["recordedAt without dispatch", { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, recordedAt: 13 } }] }],
    ["contextReadyAt after readyAt", { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, readyAt: 12, contextReadyAt: 13 } }] }],
    ["a relay command result that is no identity", { ...value, commands: [...(value.commands as Plain[]), { id: "pin", kind: "relay-pin", fingerprint: hex("a"), resultId: "has space" }] }],
    ["an epoch that does not grow along a lineage", { ...value, nativeBindings: [{ ...(value.nativeBindings as Plain[])[0], status: "archived" }, { ...alpha, checkpoint: "native-alpha-2", throughRunId: null, status: "ready", relay: relay({ sync: { kind: "fresh", basis: "reset" } }) }] }],
    ["a floor that goes down along a lineage", { ...value, nativeBindings: [{ ...(value.nativeBindings as Plain[])[0], status: "archived", relay: relay({ epochFloor: 2, sync: { kind: "synced", mark: mark(3) } }) }, { ...alpha, checkpoint: "native-alpha-2", throughRunId: null, status: "ready", relay: relay({ nativeEpoch: 2, epochFloor: 1, sync: { kind: "fresh", basis: "reset" } }) }] }],
  ] as const) assert.throws(() => parsed(invalid as Plain), SessionError, label);
  const timed = { ...value, runs: [runs[0], { ...runs[1], timing: { acceptedAt: 10, preparingAt: 11, contextReadyAt: 12, readyAt: 13, dispatchedAt: 14, recordedAt: 15, firstOutputAt: 15, endedAt: 20 } }] };
  assert.equal(parsed(timed).runs[1]?.timing?.recordedAt, 15);
  const lineage = { ...value, nativeBindings: [{ ...(value.nativeBindings as Plain[])[0], status: "archived", relay: relay({ epochFloor: 2, sync: { kind: "synced", mark: mark(3) } }) }, { ...alpha, checkpoint: "native-alpha-2", throughRunId: null, status: "ready", relay: relay({ nativeEpoch: 2, epochFloor: 2, sync: { kind: "fresh", basis: "reset" } }) }] };
  assert.equal(parsed(lineage).nativeBindings?.[1]?.relay?.nativeEpoch, 2);
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

test("G066-C06 a binding's relay state changes only by the Run that ran on it, a relay command, migration or recovery", () => {
  const busy = state({ busy: true });
  accepts(busy, withRelay(busy, 0, { sync: { kind: "synced", mark: mark(4, { basis: "native", evidence: "native" }) } }));
  // A Run of bravo changing alpha's relay state: invalid.
  const bravoRun = run("two", 4, bravo, { status: "running", backend: null, cleanup: null, timing: { acceptedAt: 10, preparingAt: 11 } });
  const foreign = state({ busy: true, runs: [run("one", 2), bravoRun] });
  rejects(foreign, withRelay(foreign, 0, { reanchor: true }), /without its original Run owner/u);
  // Without any Run (idle): invalid, unless the change only touches relay and comes with a relay command.
  const idle = state();
  rejects(idle, withRelay(idle, 0, { reanchor: true }), /without its original Run owner/u);
  const command = { id: "consent-1", kind: "relay-consent", fingerprint: hex("a"), resultId: "consent-1" };
  accepts(idle, { ...withRelay(idle, 0, { consentKey: "openai" }), commands: [...(idle.commands as Plain[]), command] });
  rejects(idle, { ...withBinding(withRelay(idle, 0, { consentKey: "openai" }), 0, { checkpoint: "elsewhere" }), commands: [...(idle.commands as Plain[]), command] }, /without its original Run owner/u);
});

test("G066-C06 native epochs, clear floors and marks only move forward, except a suspect binding's rollback and a confirmed clear", () => {
  const busy = state({ busy: true });
  rejects(withRelay(busy, 0, { nativeEpoch: 3 }), withRelay(busy, 0, { nativeEpoch: 2 }), /native epoch cannot go back/u);
  rejects(withRelay(busy, 0, { epochFloor: 3, sync: { kind: "synced", mark: mark(3) } }), withRelay(busy, 0, { epochFloor: 2, sync: { kind: "synced", mark: mark(3) } }), /clear floor cannot go down/u);
  rejects(busy, withRelay(busy, 0, { sync: { kind: "synced", mark: mark(2) } }), /goes back within an epoch/u);
  rejects(busy, withRelay(busy, 0, { sync: { kind: "fresh", basis: "new" } }), /goes back within an epoch/u);
  rejects(busy, withRelay(busy, 0, { epochFloor: 4, sync: { kind: "synced", mark: mark(3) } }), /below the clear floor/u);
  // A suspect binding's check moves its mark back, not below the floor.
  const suspect = withRelay(busy, 0, { sync: { kind: "suspect", mark: mark(3), cause: "rewind", floorCandidate: null, carried: null, rewound: false } });
  accepts(suspect, withRelay(busy, 0, { sync: { kind: "synced", mark: mark(1) } }));
  rejects(withRelay(suspect, 0, { epochFloor: 2 }), withRelay(busy, 0, { epochFloor: 2, sync: { kind: "synced", mark: mark(1) } }), /below the clear floor/u);
  // A confirmed clear starts a new epoch with a floor and no mark.
  accepts(busy, withRelay(busy, 0, { nativeEpoch: 2, epochFloor: 4, sync: { kind: "fresh", basis: "user_cleared" } }));
  // Moving forward within an epoch, or a pending sync keeping its prior's mark, is fine.
  accepts(busy, withRelay(busy, 0, { sync: { kind: "pending", prior: { kind: "synced", mark: mark(3) }, packetId: packet("c"), range: { fromSeq: 3, throughSeq: 3, fromRun: 1, throughRun: 1 }, autoResends: 0, manualResends: 0, attachOverride: false } }));
});

test("G066-C06 an archived binding's relay state is frozen, and a native reset archives it as it was", () => {
  const archived = state({ bindings: [{ ...alpha, checkpoint: "native-alpha", throughRunId: "run-two", status: "archived", relay: relay() }] });
  rejects(archived, withRelay(archived, 0, { reanchor: true }), /archived state changed/u);
  const idle = state(), reset = { id: "reset", kind: "native-reset", fingerprint: hex("a"), resultId: "session-relay" };
  accepts(idle, { ...withBinding(idle, 0, { status: "archived" }), commands: [...(idle.commands as Plain[]), reset] });
  rejects(idle, { ...withBinding(withRelay(idle, 0, { reanchor: true }), 0, { status: "archived" }), commands: [...(idle.commands as Plain[]), reset] }, /without its original Run owner/u);
});

test("G066-C06 a Run's relay fields are fixed once it runs, and its relay request once accepted", () => {
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

test("G066-C06 a writer Run archives its binding for a new one of the same Harness only when its end reports native.cleared", () => {
  const busy = state({ busy: true }), fresh = { ...alpha, checkpoint: "native-alpha-new", throughRunId: null, status: "unconfirmed", relay: relay({ nativeEpoch: 2, epochFloor: 4, sync: { kind: "fresh", basis: "user_cleared" } }) };
  const replaced = { ...withBinding(busy, 0, { status: "archived" }), nativeBindings: [{ ...(busy.nativeBindings as Plain[])[0], status: "archived" }, fresh] };
  const end = (native: Plain | undefined) => [{ type: "run.ended", data: { runId: "run-two", status: "completed", ...(native === undefined ? {} : { native }) } }];
  accepts(busy, replaced, end({ cleared: true, replaced: null }));
  rejects(busy, replaced, /archived only by a native reset/u, end(undefined));
  rejects(busy, replaced, /archived only by a native reset/u, end({ cleared: false }));
  rejects(busy, replaced, /archived only by a native reset/u, [{ type: "run.ended", data: { runId: "run-one", native: { cleared: true } } }]);
  // Archiving with native.cleared still freezes the relay state it had.
  rejects(busy, { ...replaced, nativeBindings: [{ ...(busy.nativeBindings as Plain[])[0], status: "archived", relay: relay({ reanchor: true }) }, fresh] }, /archived only by a native reset/u, end({ cleared: true }));
});

test("G066-C06 a relay recovery failure is recorded by recovery and cleared by a new native session", () => {
  const idle = state(), failed: Plain = { ...idle, lastSeq: 5, relayRecoveryFailed: 5 };
  rejects({ ...idle, lastSeq: 4 }, failed, /recorded by recovery/u);
  accepts({ ...idle, lastSeq: 4 }, failed, [{ type: "session.recovered", data: { relay: { failed: true } } }]);
  rejects(failed, { ...failed, relayRecoveryFailed: undefined }, /cleared by a new native session/u);
  const reset = { id: "reset", kind: "native-reset", fingerprint: hex("a"), resultId: "session-relay" };
  accepts(failed, { ...withBinding(failed, 0, { status: "archived" }), relayRecoveryFailed: undefined, commands: [...(failed.commands as Plain[]), reset] });
});

test("G066-C08 the longest legal relay state of a binding and of a Run stays within its byte bound", () => {
  // Every field at its longest: nested suspect states with packet marks, the longest cause and evidence names, "false"
  // rather than "true", a 253-byte gateway host twice, 96-byte models and the largest numbers. Since G068 a pending sync's
  // prior carries no packet and any of CARRIED_CAUSES may carry one, so the longest sync is a suspect state of the longest
  // cause (clear_unconfirmed) carrying a packet whose prior is a suspect state of that cause too (1,847 B, against 2,044 B
  // for the earlier pending shape, which widening the causes alone would have pushed to 2,049 B); the `rewound` flag of
  // 2026-11-10 adds `,"rewound":false` to both suspect layers (16 B each): 1,879 B; the carried packet's `,"attachOverride":false`
  // (23 B, the review of 2026-11-10) makes it 1,902 B.
  const longMark = (char: string) => mark(RELAY_MAX_SEQ, { lastPacketId: packet(char), evidence: "legacy", basis: "evidence" });
  const range = { fromSeq: RELAY_MAX_SEQ, throughSeq: RELAY_MAX_SEQ, fromRun: 255, throughRun: 255 };
  const inner = { kind: "suspect", mark: longMark("a"), cause: "clear_unconfirmed", floorCandidate: RELAY_MAX_SEQ, carried: null, rewound: false };
  const carrying = { kind: "suspect", mark: longMark("c"), cause: "clear_unconfirmed", floorCandidate: RELAY_MAX_SEQ, carried: { prior: inner, packetId: packet("b"), range, attachOverride: false }, rewound: false };
  const pendingShape = { kind: "pending", prior: { ...inner, mark: longMark("c") }, packetId: packet("d"), range, autoResends: 1, manualResends: 256, attachOverride: false };
  const fields = { nativeEpoch: RELAY_MAX_SEQ + 1, epochFloor: RELAY_MAX_SEQ, packetsInEpoch: 256, reanchor: false, originIncluded: false };
  assert.ok(Buffer.byteLength(JSON.stringify(parseBindingRelayState(relay({ ...fields, sync: pendingShape })))) < Buffer.byteLength(JSON.stringify(parseBindingRelayState(relay({ ...fields, sync: carrying })))), "the carrying suspect is the longer shape");
  const longest = relay({ ...fields,
    sync: carrying,
    compactionSeen: { count: 2_147_483_647, digest: hex("e") }, consentKey: "gateway:" + "h".repeat(253),
    vendorObserved: { model: "m".repeat(96), modelKey: "k".repeat(96), authKind: "a".repeat(16), endpoint: { host: "h".repeat(253), layer: "harness_default" }, loopback: false },
    cache: { lastRequestStartedAt: 8.64e15, contextUsed: 2_147_483_647, contextSize: 2_147_483_647 } });
  const bytes = Buffer.byteLength(JSON.stringify(parseBindingRelayState(longest)));
  assert.ok(bytes <= MAX_BINDING_RELAY_BYTES, bytes + " B"); assert.equal(bytes, 1902, "the longest value since G068's contract change");
  assert.ok(bytes < 2048, "below 2,048 B");
  const id = "a" + "b".repeat(95);
  // The longest continuity level is a delta of the most Runs at a long tier name; "resend" is the longest packet kind.
  const runRelay = { packetId: packet("f"), kind: "resend", continuity: { kind: "native_resume_delta", tier: "fidelity", runs: 256 }, executedOn: { harnessId: id, controlId: id, nativeEpoch: RELAY_MAX_SEQ + 1 } };
  const request = { tier: "fidelity", attach: "full", native: "continue", resend: true, fingerprint: hex("f") };
  const runBytes = Buffer.byteLength(JSON.stringify({ relay: parseRunRelay(runRelay), relayRequest: parseRunRelayRequest(request) }));
  assert.ok(runBytes <= MAX_RUN_RELAY_BYTES, runBytes + " B"); assert.ok(runBytes > MAX_RUN_RELAY_BYTES - 64, "the longest Run value is close to its bound: " + runBytes + " B");
});
