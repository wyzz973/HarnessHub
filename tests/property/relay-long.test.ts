import assert from "node:assert/strict";
import test from "node:test";
import { RELAY_INDEX_BYTES, RELAY_MANIFEST_BYTES, RELAY_MAX_SEQ, packRunIndexes, parseBindingRelayState, parseRelayPacket, relayPacketId, type RelayPacket } from "../../src/contracts/relay.js";
import { SessionError, type PublicRun, type SessionSnapshot } from "../../src/contracts/session.js";
import { RelayLedger, packetManifest } from "../../src/contexts/session/application/relay-coordinator.js";
import type { ConversationRun } from "../../src/contracts/conversation.js";
import { migrateSession, type MigrationEvent } from "../../src/infrastructure/session/legacy/migrate.js";

// The relay's parsers and its packet manifest on conversations past what the Session once held (16,384 events, 256 Turns): the
// relay's numbers have no bound of a conversation's size (decided 2026-11-12). The Store still holds a conversation to its own
// limits until the tables replace the snapshot, so a real run cannot get here; these cases are the pure layer under it: a v12
// conversation migrated, a manifest quoting every Turn, the ledger reading the index of a migration. Nothing here opens a store.

const TURNS = 300, STRIDE = 34;
const control = (name: string) => ({ harnessId: name, controlId: name + "-acp" });
const hex = (char: string) => char.repeat(64);

/** A v12 conversation of `turns` finished Turns that take `harnesses` in turn, each Turn taking `stride` seqs (two events). */
function longConversation(turns: number, stride: number, harnesses: readonly string[] = ["alpha", "bravo"]): { readonly state: SessionSnapshot; readonly events: readonly MigrationEvent[] } {
  const runs: PublicRun[] = [], events: MigrationEvent[] = [{ seq: 1, type: "session.created", data: { continuity: "public_context_rehydrate" } }];
  let seq = 1;
  for (let index = 0; index < turns; index++) {
    const name = harnesses[index % harnesses.length]!, id = "run-" + index;
    runs.push({ id, commandId: "send-" + index, input: "input " + index, userMessageId: "message-" + index + "-user", assistantMessageId: "message-" + index + "-reply", selection: control(name), epoch: 1, status: "completed",
      cancelRequested: false, contextThroughSeq: Math.max(0, seq - 1), sourceRunIds: [], backend: { status: "completed", reason: "model", input: "recorded" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null },
      error: null, stopRequested: false, awaitingSwitchId: null, timing: { acceptedAt: 10, dispatchedAt: 12, endedAt: 20 } } as unknown as PublicRun);
    seq += stride;
    events.push({ seq, type: "native.binding_prepared", data: { runId: id, ...control(name), resumed: index >= harnesses.length } });
    seq += stride;
    events.push({ seq, type: "run.ended", data: { runId: id, status: "completed", input: "recorded" } });
  }
  const last = (name: string) => [...runs].reverse().find(run => run.selection.harnessId === name)!.id;
  const bindings = harnesses.map(name => ({ ...control(name), checkpoint: "native-" + name, throughRunId: last(name), status: "ready" }));
  return { state: { schemaVersion: 12, id: "session-long", version: seq, lastSeq: seq, epoch: 1, status: "open", selection: control("alpha"), activeRunId: null, pendingSwitchId: null, runs, messages: [], switches: [], commands: [], nativeBindings: bindings } as unknown as SessionSnapshot, events };
}

test("PR-06 a v12 conversation of 300 Turns and 20,000 events migrates: every state it infers reads, every index row fits, no fact is lost to a bound", () => {
  // One Harness all along: its native session holds every Turn, so its mark is the last Turn's context, far past 16,384. Two Harnesses in turn: each is owed the other's.
  for (const harnesses of [["alpha"], ["alpha", "bravo"], ["alpha", "bravo", "gamma"]]) {
    const { state, events } = longConversation(TURNS, STRIDE, harnesses);
    assert.ok(events.at(-1)!.seq > 20_000, "the conversation reaches past 20,000 events: " + events.at(-1)!.seq);
    const migrated = migrateSession(state, events);
    assert.equal(migrated.bindings.length, harnesses.length); assert.equal(migrated.runs.length, TURNS, "every finished Turn is indexed");
    for (const binding of migrated.bindings) assert.deepEqual(parseBindingRelayState(JSON.parse(JSON.stringify(binding))), binding, "the inferred state reads: " + JSON.stringify(binding));
    if (harnesses.length === 1) assert.ok(migrated.bindings[0]!.mark > 16_384, "its mark is a fact seq past the old bound of 16,384: " + migrated.bindings[0]!.mark);
    for (const [at, row] of migrated.runs.entries()) {
      assert.equal(row.index, at, "the Run index counts from 0 like the Run array");
      assert.ok(Buffer.byteLength(JSON.stringify(row)) <= RELAY_INDEX_BYTES, "an index row fits its bound");
      assert.ok(Number.isSafeInteger(row.seq) && row.seq <= RELAY_MAX_SEQ);
    }
    assert.ok(migrated.runs.at(-1)!.seq > 20_000);
  }
});

test("PR-07 the ledger reads a Run's row at any seq: a Turn's fact keeps the seq its events gave it past 16,384, and a Run no event placed is above every mark", () => {
  const { state, events } = longConversation(TURNS, STRIDE), migrated = migrateSession(state, events);
  // The Runs' rows as the migration writes them: the seq of the event that ended each Turn, its place (a Run made before v13 has no `relay` of its own), and for one Run no seq at all.
  const unplaced = 7;
  const rows = state.runs.map((run, ordinal): ConversationRun => {
    const { input: _input, thinking: _thinking, tools: _tools, plan: _plan, notices: _notices, activities: _activities, outputs: _outputs, protocol: _protocol, relay: _relay, ...rest } = run as typeof run & Record<string, unknown>;
    return { ...rest, ordinal, userSeq: ordinal + 1, isCommand: false, ...(ordinal === unplaced ? {} : { endedSeq: migrated.runs[ordinal]!.seq }) } as ConversationRun;
  });
  const facts = new RelayLedger().facts({ runs: rows, lastSeq: state.lastSeq }, { harnessId: "alpha", controlId: "alpha-acp", nativeEpoch: 99 });
  assert.equal(facts.length, TURNS, "with another epoch every Turn is foreign to the binding");
  for (const [at, fact] of facts.entries()) assert.equal(fact.seq, at === unplaced ? state.lastSeq : migrated.runs[at]!.seq, "the fact at " + at + " has its own seq" + (at === unplaced ? " — none: above every mark, never zero" : ", not the Session's last"));
  assert.ok(facts.filter(fact => fact.seq > 16_384).length >= 50, "the last Turns of the conversation lie past the old bound");
});

test("PR-08 a packet quoting all 300 Turns is a few bytes of spans, and the coordinator's own manifest names every one of them", () => {
  const { state } = longConversation(TURNS, STRIDE);
  // The current input: a 301st Turn, queued, whose user message came after the others.
  const current = { ...state.runs[0]!, id: "run-current", userMessageId: "message-current-user", assistantMessageId: "message-current-reply", status: "running" } as PublicRun;
  const runs = [...state.runs, current], messages = runs.map((run, at) => ({ id: run.userMessageId, runId: run.id, role: "user", text: "x", seq: 10 + at * 2, status: run.status }));
  const snapshot = { ...state, runs, messages } as unknown as SessionSnapshot;
  const indexes = Array.from({ length: TURNS }, (_, at) => at);
  const manifest = (list: readonly unknown[], extra: Record<string, unknown> = {}): RelayPacket => parseRelayPacket({ id: relayPacketId("relay-" + "a".repeat(20)), kind: "packet", tier: "brief",
    target: { harnessId: "alpha", controlId: "alpha-acp", model: null, nativeEpoch: 1 }, range: { fromSeq: 0, throughSeq: 20_400, fromRun: 0, throughRun: TURNS - 1 }, runs: list, supersedes: null, policyVersion: "relay/1", language: "en",
    repeat: false, attachOverride: false, firstLineOmitted: null, redactions: 0, body: { sha256: hex("b"), bytes: 10, estTokens: 3 }, budget: { capTokens: 8000, window: 128_000, windowSource: "assumed", clampedBy: [] }, omissions: [], ...extra });
  const all = manifest(packRunIndexes(indexes));
  assert.deepEqual(all.runs, [[0, TURNS - 1]]);
  assert.ok(Buffer.byteLength(JSON.stringify(all)) < RELAY_MANIFEST_BYTES / 20, "a manifest quoting every Turn is small");
  // The coordinator's own manifest does not cut the list at 256: every quoted Turn is named (the old `slice(0, 256)` named the first 256 only).
  const built = packetManifest({ state: snapshot, run: current, relay: { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false }, runs: runs.slice(0, TURNS).map(run => run.id), range: all.range,
    body: "a packet", attachOverride: false, supersedes: null, firstLineOmitted: null,
    record: { packetId: "relay-" + "a".repeat(20), kind: "packet", tier: "brief", language: "en", repeat: false, redactions: 0, tokens: 3, budget: { cap: 8000, window: 128_000, windowSource: "assumed" }, items: { userMessages: { omitted: 0 }, replies: { omitted: 0 }, outputs: { omitted: 0 }, changes: { omitted: 0 }, calls: { omitted: 0 } }, complete: false } as never });
  assert.equal(built.runs.length === 1 && Array.isArray(built.runs[0]) ? built.runs[0][1] - built.runs[0][0] + 1 : built.runs.length, TURNS, "the manifest names all 300 Turns");
  // What a packet must not quote (a span reaching the Turn that is running, a span past the last Turn, a Turn accepted after the input) is checked against the Runs' rows by the store
  // (tests/integration/conversation-store-relay.test.ts), where the Turns are.
});
