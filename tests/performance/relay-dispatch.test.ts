import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { nativeConversationId, type BackendResult, type HarnessControl } from "../../src/contracts/control.js";
import { parseVendorKey, type RelayCapabilities, type VendorKey } from "../../src/contracts/relay.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId } from "../../src/contracts/session.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G072-C09 (ADR-055 §11.1 "派发路径增量", §14.2; relay-architecture §17): what G072's gates cost on the dispatch path, counted
// the way CI may assert it (§11.1: counts only; milliseconds go to the verification record). With the formal SessionRuntime and
// a real SqliteSessionStore, zero-latency fake Harnesses behind a factory that answers the Drivers' declarations:
// - an ordinary Turn (a single Harness, or one sent alone) commits as many times as before G072, adds no event and reads no
//   consent, preference or window: the gates are asked only of an input that carries another Harness's history;
// - a carrying Turn commits no more than an ordinary one (E1 aside, A14: its Driver here has none) and adds at most 3 events, plus
//   the consent's mirror when the request gave one;
// - the ABBA pairs of attach auto and none on the same snapshot give the paired difference, printed for the record.

const DECLARED: RelayCapabilities = { ...dshRelayCapabilities, probed: true, execution: "process",
  delivery: { live: "none", verify: "none", successProvesRecorded: true, lateDelivery: false },
  commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: sharedClassify },
  placement: { parts: "single", maxInput: null, pointersAfterUser: true, measure: measureBy("single", "chars", ["file"]) },
  title: "set", resolveVendor: observed => parseVendorKey(observed.authKind ?? "unknown:fake") };
const VENDORS: Readonly<Record<string, string>> = { alpha: "anthropic", bravo: "openai" };
class Fakes implements SessionBindingFactory {
  private opened = 0;
  relayCapabilities(): RelayCapabilities { return DECLARED; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!(request.harnessId in VENDORS)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let session: string | null = null;
    const control: HarnessControl = { relayCapabilities: DECLARED,
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { session = checkpoint ?? "native-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session, healthy: () => true,
      relayVendor: async () => ({ model: null, modelKey: "", authKind: VENDORS[selected.harnessId]!, endpoint: null, loopback: false }),
      setTitle: async () => {},
      startText: async (_id, _turn, output) => {
        output({ type: "text", text: "ok" });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => ({ closed: true, exitCode: 0, signal: null, protocolFailure: null }) };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
/** A Store whose commits and relay reads are counted. */
function counted(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "g072-perf-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const store = new SqliteSessionStore(join(root, "data"), { recoverRelay }), counts = { commits: 0, consents: 0, prefs: 0, windows: 0 };
  const transact = store.transact.bind(store), consents = store.relayConsents.bind(store), prefs = store.relayPrefs.bind(store), window = store.relayWindow.bind(store);
  store.transact = (...args) => { counts.commits += 1; return transact(...args); };
  store.relayConsents = () => { counts.consents += 1; return consents(); };
  store.relayPrefs = () => { counts.prefs += 1; return prefs(); };
  store.relayWindow = (...args) => { counts.windows += 1; return window(...args); };
  let next = 0;
  const app = new SessionRuntime(store, new Fakes(), { id: () => "perf-" + ++next, now: () => new Date(Date.UTC(2026, 10, 10, 12)), publish: () => {},
    fingerprint: value => createHash("sha256").update(value).digest("hex"), relayIsolated: () => true });
  t.after(async () => { try { await app.close(); store.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  return { store, app, counts, configuration };
}
function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
async function measured(c: ReturnType<typeof counted>, id: SessionId, text: string, key: string, relay?: RelayChoice) {
  const before = { ...c.counts }, seq = c.app.read(id).lastSeq, started = performance.now();
  c.app.send(id, text, key, [], relay); await c.app.wait(id);
  const ms = performance.now() - started, added = events(c.store, id).filter(row => row.seq > seq);
  return { ms, commits: c.counts.commits - before.commits, reads: c.counts.consents - before.consents + c.counts.prefs - before.prefs + c.counts.windows - before.windows,
    relayEvents: added.filter(row => row.type.startsWith("relay.")).map(row => row.type), events: added.length, status: c.app.read(id).runs.at(-1)!.status };
}

test("G072-C09 an ordinary Turn pays nothing for the gates: the same commits, no relay event and no consent, preference or window read, single-Harness or sent alone", async t => {
  const c = counted(t), id = (await c.app.create(c.configuration, { harnessId: "alpha" }, "create")).id;
  const first = await measured(c, id, "a1", "a1"), second = await measured(c, id, "a2", "a2"), third = await measured(c, id, "a3", "a3");
  assert.equal(second.commits, third.commits, "a steady single-Harness Turn commits the same each time");
  for (const ordinary of [second, third]) { assert.deepEqual(ordinary.relayEvents, []); assert.equal(ordinary.reads, 0, "no installation read"); }
  assert.ok(first.commits >= second.commits, "the first Turn prepares its binding once");
  c.app.switch(id, { harnessId: "bravo" }, "to-b"); await c.app.wait(id);
  const alone = await measured(c, id, "b1 alone", "b1", { attach: "none" }), alone2 = await measured(c, id, "b2 alone", "b2", { attach: "none" });
  assert.equal(alone2.reads, 0, "an input sent alone reads nothing for the gates"); assert.deepEqual(alone2.relayEvents, []);
  assert.equal(alone2.commits, third.commits, "and commits as an ordinary Turn");
  assert.ok(alone.commits >= alone2.commits);
});

test("G072-C09 a carrying Turn commits no more than an ordinary one (no E1 here) and adds at most 3 relay events, plus the consent's mirror; the ABBA paired difference of attach auto and none is printed for the record", async t => {
  const c = counted(t), id = (await c.app.create(c.configuration, { harnessId: "alpha" }, "create")).id;
  await measured(c, id, "a1", "a1"); const ordinary = await measured(c, id, "a2", "a2");
  c.app.switch(id, { harnessId: "bravo" }, "to-b"); await c.app.wait(id);
  for (const vendor of ["openai", "anthropic"]) c.store.appendRelayLog({ commandId: "grant-" + vendor, vendor: vendor as VendorKey, scope: { kind: "global" }, decision: "acknowledged", categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 });
  const carried = await measured(c, id, "b1 carries alpha's turns", "b1", { consent: { vendor: "unknown:bravo" as VendorKey, decision: "acknowledged", scope: "session" } });
  assert.equal(carried.status, "completed");
  // The first Turn of bravo's binding prepares it (one commit more than a steady Turn); a packet adds none of its own.
  const steadyCarry = await (async () => {
    c.app.switch(id, { harnessId: "alpha" }, "to-a"); await c.app.wait(id); await measured(c, id, "a3 carries b1", "a3");
    c.app.switch(id, { harnessId: "bravo" }, "to-b2"); await c.app.wait(id);
    return measured(c, id, "b2 carries a3", "b2");
  })();
  assert.equal(steadyCarry.status, "completed");
  assert.equal(steadyCarry.commits, ordinary.commits, "a carrying Turn on a prepared binding commits as an ordinary one");
  assert.ok(carried.relayEvents.filter(type => type !== "relay.consent_recorded").length <= 3, JSON.stringify(carried.relayEvents));
  assert.equal(carried.relayEvents.filter(type => type === "relay.consent_recorded").length, 1, "the consent's mirror, once");
  assert.ok(steadyCarry.relayEvents.length <= 3, JSON.stringify(steadyCarry.relayEvents));
  assert.ok(steadyCarry.reads > 0, "the gates read the installation's state for a carrying Turn only");
  // ABBA on the same snapshot shape: an input that would carry (auto) and the same sent alone, alternated.
  const pairs: number[] = [];
  for (let round = 0; round < 12; round++) {
    c.app.switch(id, { harnessId: "alpha" }, "abba-a-" + round); await c.app.wait(id);
    await measured(c, id, "a fact " + round, "abba-fact-" + round, { attach: "none" });
    c.app.switch(id, { harnessId: "bravo" }, "abba-b-" + round); await c.app.wait(id);
    const order = round % 2 === 0 ? ["none", "auto"] : ["auto", "none"];
    const times: Record<string, number> = {};
    for (const mode of order) times[mode] = (await measured(c, id, "abba " + mode + " " + round, "abba-" + mode + "-" + round, mode === "none" ? { attach: "none" } : undefined)).ms;
    pairs.push(times.auto! - times.none!);
  }
  const sorted = [...pairs].sort((a, b) => a - b), p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
  // For the verification record only (§11.1: no millisecond gate in CI).
  console.log("G072-C09 ABBA paired difference (auto − none) over " + pairs.length + " pairs, zero-latency fakes: p50 " + sorted[Math.floor(sorted.length / 2)]!.toFixed(2) + " ms, p95 " + p95.toFixed(2) + " ms");
  assert.equal(pairs.length, 12);
});
