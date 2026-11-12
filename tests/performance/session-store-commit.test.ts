import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { nativeConversationId, type CleanupEvidence, type HarnessControl } from "../../src/contracts/control.js";
import type { HarnessSelection, PreparedSessionBinding, SelectionRequest, SessionBindingFactory, SessionConfiguration, SessionId } from "../../src/contracts/session.js";
import type { RelayCapabilities } from "../../src/contracts/relay.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { initialBindingRelay } from "../../src/contexts/session/domain/relay/delivery.js";
import { appStore } from "../fixtures/runtime-store.js";
import { Scenario, created, event, newConversation } from "../fixtures/store-helpers.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";

// G075-C01 (ADR-055 §11.2, ADR-057): from acceptance to dispatch through the formal SessionRuntime and a real SqliteConversationStore, with R6's zero-delay in-process fake
// Harness (round1/r6-performance-caching.md §2.6.4) so that only the Hub's own work is counted. What a Turn asks of the store (its commits, its loads, the events and relay
// rows it reads) is asserted against a baseline, and against the same Turn on a conversation of 400 finished Turns: it must not depend on how much history there is. Milliseconds
// are recorded, and CI asserts none of them (relay-architecture §11.1); nothing here runs a Harness.

/**
 * Per Turn of the fixed flow below, from the input to its end. A change to the Runtime's flow that adds a commit or a load changes these on purpose, with its reason.
 * G068 phase two (ADR-055 §6.1): run.context_prepared and run.authorized are one transaction; an ordinary Turn (nothing owed, the binding synced) reads no event
 * (the ledger reads the Runs' rows, ADR-057), no relay row and no log, and asks no Driver anything about its history.
 */
const HISTORY = 400, TURNS = 10;
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };

interface Counts { commits: number; loads: number; eventReads: number; relayReads: number; logCalls: number; snapshots: number }
/** The Runtime's view of the real store, counting what it asks for. */
function counting(inner: SqliteConversationStore): { readonly store: SqliteConversationStore; readonly counts: () => Counts } {
  const counts: Counts = { commits: 0, loads: 0, eventReads: 0, relayReads: 0, logCalls: 0, snapshots: 0 };
  const names: Record<string, keyof Counts> = { transact: "commits", get: "loads", events: "eventReads", relayDeliveries: "relayReads", relayPackets: "relayReads", relayIndex: "relayReads", relayPacket: "relayReads", relayPacketBody: "relayReads",
    logHandoff: "logCalls", handoffs: "logCalls", handoffUsed: "logCalls", setPref: "logCalls", relayPrefs: "logCalls", snapshot: "snapshots" };
  const store = new Proxy(inner, { get(target, key) {
    const value: unknown = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    const counted = typeof key === "string" ? names[key] : undefined;
    return (...args: unknown[]) => { if (counted !== undefined) counts[counted] += 1; return (value as (...rest: unknown[]) => unknown).apply(target, args); };
  } });
  return { store, counts: () => ({ ...counts }) };
}
/** A Harness whose every step completes at once and that resumes its native session. */
class ZeroDelayHarness implements SessionBindingFactory {
  dispatchedAt: number | null = null;
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "zero-delay", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-" + selected.harnessId); },
      // A native session has one holder in the whole store: each conversation's is its own.
      checkpoint: async () => opened ? "private-native-" + selected.harnessId + "-" + session : null,
      startText: async (_id, _text, output) => {
        this.dispatchedAt = performance.now();
        output({ type: "text", text: "继续好了" });
        return { result: Promise.resolve({ status: "completed", reason: "zero-delay", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}
const configurationOf = (workspace: string): SessionConfiguration => ({ workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true });

/** `count` finished Turns written through the store as a Runtime commits them, each with a call, on the Harness `alpha`, which holds them all as its native session's. */
function seed(store: SqliteConversationStore, workspace: string, count: number): SessionId {
  const conversation = newConversation(workspace, "history");
  created(store, conversation);
  const scenario = new Scenario(store, conversation.id, "run-seed"), executedOn = { harnessId: "alpha", controlId: "alpha-acp", nativeEpoch: 1 };
  for (let index = 0; index < count; index++) {
    const run = scenario.accept("请继续第 " + index + " 步：" + "需".repeat(256), { relay: { packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn } });
    scenario.start(run.ordinal); scenario.tool(run.ordinal, "read-" + index); scenario.say(run.ordinal, "```ts\n" + "const value = compute(input);\n".repeat(40) + "\n```"); scenario.finish(run.ordinal);
  }
  const last = store.get(conversation.id).runs.at(-1)!;
  // The native session of `alpha` is at the last of them, with nothing owed: the next input carries nothing (as R6 measured).
  store.transact(conversation.id, store.get(conversation.id).version, current => ({ next: { ...current, nativeBindings: [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "private-native-alpha-" + conversation.id, throughRunId: last.id, status: "ready" as const,
    relay: { ...initialBindingRelay([], "alpha", "alpha-acp", "new"), mark: store.get(conversation.id).lastSeq } }] }, events: [event("test.bound")] }));
  return conversation.id;
}

test("G075-C01 a Turn asks the store for the same number of commits and loads whether the conversation holds none or 400 finished Turns, and acceptance to dispatch is timed", { timeout: 300_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "g075-commit-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const real = appStore(join(root, "data")), { store, counts } = counting(real), harness = new ZeroDelayHarness();
  let next = 0;
  const app = new SessionRuntime(store, harness, { id: () => "p" + String(++next), now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } finally { try { real.close(); } finally { await rm(root, { recursive: true, force: true }); } } });
  const configuration = configurationOf(workspace);
  // A conversation made by the Runtime itself: its first Turn opens the binding, the rest are ordinary Turns.
  const fresh = await app.create(configuration, { harnessId: "alpha" }, "create-fresh");
  const old = seed(real, workspace, HISTORY);
  const dispatch: number[] = [], whole: number[] = [], perTurn: { readonly fresh: unknown[]; readonly old: unknown[] } = { fresh: [], old: [] };
  const turn = async (id: SessionId, label: "fresh" | "old", at: number) => {
    const before = counts(), seq = real.get(id).lastSeq;
    harness.dispatchedAt = null;
    const started = performance.now(), receipt = app.send(id, "继续下一步 " + at, label + "-" + at);
    await app.wait(id);
    const ended = performance.now(), after = counts(), state = real.get(id), run = state.runs.find(row => row.id === receipt.runId);
    assert.equal(run?.status, "completed", JSON.stringify(run?.error));
    assert.ok(harness.dispatchedAt !== null, "the input reached the Harness");
    dispatch.push(harness.dispatchedAt - started); whole.push(ended - started);
    return { commits: after.commits - before.commits, loads: after.loads - before.loads, events: state.lastSeq - seq, eventReads: after.eventReads - before.eventReads, relayReads: after.relayReads - before.relayReads, logCalls: after.logCalls - before.logCalls };
  };
  await turn(fresh.id, "fresh", -1);
  for (let at = 0; at < TURNS; at++) {
    const young = await turn(fresh.id, "fresh", at), aged = await turn(old, "old", at);
    perTurn.fresh.push(young); perTurn.old.push(aged);
    assert.deepEqual(aged, young, "Turn " + at + ": the same commits, loads and reads on 400 finished Turns as on a conversation of " + (at + 2));
    assert.deepEqual({ eventReads: aged.eventReads, relayReads: aged.relayReads, logCalls: aged.logCalls }, { eventReads: 0, relayReads: 0, logCalls: 0 }, "an ordinary Turn reads no event, no relay row and no log");
  }
  t.diagnostic(`G075-C01 machine: ${cpus()[0]?.model ?? "unknown"}, ${cpus().length} logical cores, ${Math.round(totalmem() / 2 ** 30)} GiB; Node ${process.version}, SQLite ${process.versions.sqlite}`);
  t.diagnostic(`G075-C01 ${dispatch.length} Turns; per Turn ${JSON.stringify(perTurn.old[0])}; acceptance→dispatch p50 ${percentile(dispatch, 0.5).toFixed(1)} ms, p95 ${percentile(dispatch, 0.95).toFixed(1)} ms; whole Turn p50 ${percentile(whole, 0.5).toFixed(1)} ms`);
});

/** A Harness whose Turn makes `calls` tool calls at once, each finished, and then answers. */
class ManyCalls implements SessionBindingFactory {
  calls = 0;
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "many-calls", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-" + selected.harnessId); },
      checkpoint: async () => opened ? "private-native-" + selected.harnessId + "-" + session : null,
      startText: async (_id, _text, output) => {
        for (let index = 0; index < this.calls; index++) output({ type: "tool", id: "call-" + index, title: "step " + index, status: "completed" });
        output({ type: "text", text: "done" });
        return { result: Promise.resolve({ status: "completed", reason: "many-calls", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}

test("a Turn of many tool calls keeps every one, each call being a commit of its own, and the time a call takes does not run away with the calls before it", { timeout: 300_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "many-calls-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const real = appStore(join(root, "data")), harness = new ManyCalls();
  let next = 0;
  const app = new SessionRuntime(real, harness, { id: () => "m" + String(++next), now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } finally { try { real.close(); } finally { await rm(root, { recursive: true, force: true }); } } });
  const perCall: Record<number, number> = {};
  for (const calls of [500, 2000, 5000]) {
    harness.calls = calls;
    const session = await app.create(configurationOf(workspace), { harnessId: "alpha" }, "create-" + calls);
    const started = performance.now();
    app.send(session.id, "many " + calls, "send-" + calls); await app.wait(session.id);
    perCall[calls] = (performance.now() - started) / calls;
    const turn = real.turnAt(session.id, 0, { inlineBytes: Infinity })!;
    assert.equal(real.get(session.id).runs[0]?.status, "completed");
    assert.equal(turn.items.filter(item => item.type === "tool").length, calls, "every call is an item");
  }
  t.diagnostic(`many calls: ms per call ${JSON.stringify(Object.fromEntries(Object.entries(perCall).map(([calls, ms]) => [calls, Number(ms.toFixed(3))])))}`);
  // A call that cost as much as every call before it (work that grows with the Turn) would take ten times as long per call at 5,000 as at 500; the measure is about one and a half.
  assert.ok(perCall[5000]! < perCall[500]! * 5, "the time a call takes grows with the number of calls before it: " + JSON.stringify(perCall));
});

/** The fakes' relay declaration for the commit count of E1: live entry reports (recorded_event), no check, success proves recorded. */
const LIVE: RelayCapabilities = { ...dshRelayCapabilities, delivery: { live: "recorded_event", successProvesRecorded: true } };
/** Zero-delay Harnesses alpha and bravo that resume their native sessions and report a packet's entry as recorded (E1) before replying. */
class LiveHarnesses implements SessionBindingFactory {
  async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" }; }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      relayCapabilities: LIVE,
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "zero-delay", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-" + selected.harnessId); },
      checkpoint: async () => opened ? "private-native-" + selected.harnessId : null,
      startText: async (_id, turn, output) => {
        if (typeof turn !== "string") output({ type: "input_recorded", packetId: turn.relay.packetId });
        output({ type: "text", text: "继续好了" });
        return { result: Promise.resolve({ status: "completed", reason: "zero-delay" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}

test("G068 fix R8/R10f (A9, A14) an ordinary Turn reads no relay row, no log or preference and asks no position and no check; a Turn that carries a packet and sees E1 makes one commit more than an ordinary one", async t => {
  const root = await mkdtemp(join(tmpdir(), "g068-commit-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const real = appStore(join(root, "data")), { store, counts } = counting(real), harness = new LiveHarnesses();
  let next = 0;
  const app = new SessionRuntime(store, harness, { id: () => String(++next), now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } finally { try { real.close(); } finally { await rm(root, { recursive: true, force: true }); } } });
  const session = await app.create(configurationOf(workspace), { harnessId: "alpha" }, "create"), id = session.id;
  const measured = async (text: string, key: string) => {
    const before = counts(), seq = real.get(id).lastSeq;
    const receipt = app.send(id, text, key); await app.wait(id);
    const after = counts(), run = real.get(id).runs.find(row => row.id === receipt.runId)!;
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    return { run, commits: after.commits - before.commits, relayReads: after.relayReads - before.relayReads, eventReads: after.eventReads - before.eventReads,
      logCalls: after.logCalls - before.logCalls, events: real.get(id).lastSeq - seq };
  };
  await measured("第一步", "a1");
  // Ordinary Turns on a binding that holds its own Turns: no relay row, no event, no log or preference (§11.1, R8).
  const ordinary = await measured("第二步", "a2");
  assert.deepEqual({ relayReads: ordinary.relayReads, eventReads: ordinary.eventReads, logCalls: ordinary.logCalls }, { relayReads: 0, eventReads: 0, logCalls: 0 });
  // bravo works, then alpha's next Turn carries bravo's Turn and its entry is reported: E1 is one transaction of its own (A14).
  app.switch(id, { harnessId: "bravo" }, "to-b"); await app.wait(id);
  await measured("在 bravo 上", "b1");
  app.switch(id, { harnessId: "alpha" }, "to-a"); await app.wait(id);
  const carrying = await measured("回到 alpha", "a3");
  assert.ok(carrying.run.relay?.packetId !== null && carrying.run.relay?.packetId !== undefined, "it carried a packet");
  assert.ok(real.events(id, 0, 100).some(row => row.type === "relay.input_recorded" && row.data.runId === carrying.run.id), "E1 was committed");
  assert.equal(carrying.commits, ordinary.commits + 1, "E1 adds one commit; the packet, its row and the authorization are one transaction");
  // The relay builds the packet from the Hub's own record: no relay row is read for a binding that holds its own Turns.
  assert.equal(carrying.relayReads, 0, "a binding that holds its own Turns has no row to read");
  // Back to ordinary on the binding that now holds that packet: the same commits, and no row, log or preference read. The ledger reads the Runs' rows, so it pages no
  // event at all (it used to page the events since its last read, once, to place bravo's Turn).
  const again = await measured("第三步", "a4");
  assert.equal(again.commits, ordinary.commits);
  assert.deepEqual({ relayReads: again.relayReads, eventReads: again.eventReads, logCalls: again.logCalls }, { relayReads: 0, eventReads: 0, logCalls: 0 });
  t.diagnostic("commits: ordinary " + ordinary.commits + ", carrying with E1 " + carrying.commits + "; reads after it " + JSON.stringify({ relayReads: again.relayReads, logCalls: again.logCalls }));
});
