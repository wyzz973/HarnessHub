import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeConversationId, type BackendResult, type HarnessControl } from "../../src/contracts/control.js";
import { EMPTY_CHAIN, RelayError, markOf, parseBindingRelayState, parseVendorKey, relayPacketId, type BindingRelayState, type BindingSync, type DeliveredMark, type RelayCapabilities, type SyncPrior, type VendorKey } from "../../src/contracts/relay.js";
import { SessionError, runId, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId } from "../../src/contracts/session.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { consentStanding, decideTurn, relayDeclaration } from "../../src/contexts/session/application/relay-coordinator.js";
import { step, type RelayFact } from "../../src/contexts/session/domain/relay/delivery.js";
import { estimateReturn, returnChoice, type ReturnPreference } from "../../src/contexts/session/domain/relay/return-policy.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G072-P01 and the state machine's new rules (relay-architecture §17 G072-P01; the approval agent's A7 point 4; §7.3): seeded
// random sequences, each case's seed printed in its failure.
// - P01 drives the formal SessionRuntime and a real SqliteSessionStore with switches, messages (as typed, alone, attached, with a
//   consent), consents and withdrawals in any order, and checks after every step: the Session's identity holds, at most one Turn
//   is active and none once it settles, the epoch counts the effective switches, a refused input makes no Run, and every packet
//   that reached a Harness did so while a consent to that Harness's vendor stood (or the request's own); the Store's transition
//   rules (marks never rise unchecked, floors never fall) hold on every commit or the Runtime would have failed.
// - A7 point 4: on a pending binding whose packet's facts are no longer owed, the decision is to send as typed and go back to the
//   prior, which never claims more than the prior did and touches no delivery row; on any other state the event is refused.
// - The return decision never chooses a new native session by itself except the cold, side-by-side case its preference names.

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
const VENDORS: Readonly<Record<string, VendorKey>> = { alpha: "anthropic", bravo: "openai", charlie: "deepseek" };
const DECLARED: RelayCapabilities = { ...dshRelayCapabilities, probed: true, execution: "process",
  delivery: { live: "none", verify: "none", successProvesRecorded: true, lateDelivery: false },
  commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: sharedClassify },
  placement: { parts: "single", maxInput: null, pointersAfterUser: true, measure: measureBy("single", "chars", ["file"]) },
  resolveVendor: observed => observed.authKind === null ? "unknown:fake" as VendorKey : parseVendorKey(observed.authKind) };

/** Fakes that check, as each packet arrives, that a consent to their vendor stands (`consented`, the test's own reading). */
class Fakes implements SessionBindingFactory {
  readonly violations: string[] = [];
  packets = 0;
  consented: (harnessId: string, input: string) => boolean = () => true;
  private opened = 0;
  relayCapabilities(): RelayCapabilities { return DECLARED; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!(request.harnessId in VENDORS)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId; let session: string | null = null;
    const control: HarnessControl = { relayCapabilities: DECLARED,
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session, healthy: () => true,
      relayVendor: async () => ({ model: null, modelKey: "", authKind: VENDORS[harnessId]!, endpoint: null, loopback: false }),
      startText: async (_id, turn, output) => {
        if (typeof turn !== "string") { this.packets += 1; if (!this.consented(harnessId, turn.user)) this.violations.push(harnessId + ": " + turn.user); }
        output({ type: "text", text: "reply from " + harnessId });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => ({ closed: true, exitCode: 0, signal: null, protocolFailure: null }) };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}

test("G072-P01 switches, messages, consents and withdrawals in any interleaving: one Session identity, at most one active Turn, the epoch the effective switches make, no Run for a refused input, and no packet without a consent to its target's vendor", { timeout: 240_000 }, async () => {
  const sequences = 24, steps = 20;
  let delivered = 0, refused = 0;
  for (let index = 0; index < sequences; index++) {
    const seed = 0x72_0000 + index, next = random(seed), root = mkdtempSync(join(tmpdir(), "g072-p01-"));
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const store = new SqliteSessionStore(join(root, "data"), { recoverRelay }), fakes = new Fakes();
    let ids = 0, keys = 0;
    const app = new SessionRuntime(store, fakes, { id: () => "p01-" + seed + "-" + ++ids, now: () => new Date(Date.UTC(2026, 10, 10, 12)), publish: () => {},
      fingerprint: value => createHash("sha256").update(value).digest("hex"), relayIsolated: () => true });
    const where = (label: string) => "seed " + seed.toString(16) + ", " + label;
    try {
      const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
      const id = (await app.create(configuration, { harnessId: pick(next, Object.keys(VENDORS)) }, "create")).id as SessionId;
      // The test's own reading of §10.4: a consent stands for the vendor (this conversation's latest record, else the latest
      // global one, else the preference, which covers these named vendors; a withdrawal is none), or the Run's own request gave
      // one (its mirror names the log seq) and no withdrawal of the vendor was logged after it.
      fakes.consented = (harnessId, input) => {
        const vendor = VENDORS[harnessId]!, records = store.relayConsents(), prefs = store.relayPrefs();
        const view = { session: id, records, crossVendor: (prefs["relay.crossVendor"] === "allow" ? "allow" : "ask") as "ask" | "allow", localModelsOffline: false, request: null };
        if (consentStanding(vendor, null, view).kind !== "missing") return true;
        const run = app.read(id).runs.find(row => row.input === input), mirror = run === undefined ? undefined : events(store, id).find(row => row.type === "relay.consent_recorded" && row.data.runId === run.id);
        if (mirror === undefined || mirror.data.vendor !== vendor) return false;
        const seq = Number(mirror.data.logSeq);
        return !records.some(record => record.vendor === vendor && record.decision === "revoked" && record.logSeq > seq && (record.scope.kind === "global" || record.scope.sessionId === id));
      };
      let effective = 0;
      for (let at = 0; at < steps; at++) {
        const action = pick(next, ["send", "send", "send", "switch", "grant", "grant", "revoke", "allow"] as const);
        const before = app.read(id);
        if (action === "send") {
          const text = "m" + at + " " + seed, choice = pick(next, [undefined, { attach: "none" }, { attach: "full" }, "consent"] as const);
          // A consent to the target's vendor, or to what admission can tell of a target not opened yet (unknown:<harnessId>).
          const named = pick(next, [VENDORS[before.selection.harnessId]!, ("unknown:" + before.selection.harnessId) as VendorKey]);
          const relay: RelayChoice | undefined = choice === "consent" ? { consent: { vendor: named, decision: "acknowledged", scope: named.startsWith("unknown:") ? "session" : pick(next, ["session", "global"] as const) } } : choice;
          try { app.send(id, text, "k" + ++keys, [], relay); }
          catch (error) {
            assert.ok(error instanceof RelayError || error instanceof SessionError, where("an expected refusal: " + String(error)));
            assert.equal(app.read(id).runs.length, before.runs.length, where("a refused input makes no Run"));
            refused += 1;
          }
        } else if (action === "switch") {
          const target = pick(next, Object.keys(VENDORS).filter(harness => harness !== before.selection.harnessId));
          app.switch(id, { harnessId: target }, "k" + ++keys); effective += 1;
        } else if (action === "grant" || action === "revoke") {
          const vendor = pick(next, [...Object.values(VENDORS), ...Object.keys(VENDORS).map(harness => ("unknown:" + harness) as VendorKey)]);
          store.appendRelayLog({ commandId: "c" + seed + "-" + ++keys, vendor, scope: vendor.startsWith("unknown:") || next() < 0.5 ? { kind: "session" as const, sessionId: id } : { kind: "global" as const },
            decision: action === "grant" ? "acknowledged" : "revoked", categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 });
        } else store.setPref("relay.crossVendor", pick(next, ["allow", "ask"]));
        await app.wait(id).catch((error: unknown) => { if (!(error instanceof SessionError && error.code === "SESSION_BLOCKED")) throw error; });
        const state = app.read(id);
        assert.equal(state.id, id, where("one Session identity")); assert.equal(state.activeRunId, null, where("nothing active once settled"));
        assert.ok(state.runs.filter(run => ["preparing", "running", "settling"].includes(run.status)).length <= 1, where("at most one active Turn"));
        assert.equal(state.epoch, 1 + state.switches.filter(sw => sw.status === "effective").length, where("the epoch counts the effective switches"));
        assert.ok(state.switches.length <= effective, where("one switch per request"));
        assert.deepEqual(fakes.violations, [], where("a packet reached a Harness without a consent to its vendor"));
      }
      delivered += fakes.packets;
    } finally { await app.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  }
  // Not vacuous: packets went and inputs were refused across the sequences.
  assert.ok(delivered >= 10, "packets delivered: " + delivered); assert.ok(refused >= 10, "inputs refused: " + refused);
});

// ---------------------------------------------------------------------------------------------------------------------
// A7 point 4: a pending binding with nothing owed goes back to its prior
// ---------------------------------------------------------------------------------------------------------------------

const X = { harnessId: "xray", controlId: "xray-acp" } as const;
const packet = (digit: number): ReturnType<typeof relayPacketId> => relayPacketId("relay-" + String(digit % 10).repeat(20));
function mark(throughSeq: number, withPacket: boolean): DeliveredMark {
  return { throughSeq, chain: withPacket ? createHash("sha256").update(String(throughSeq)).digest("hex") as DeliveredMark["chain"] : EMPTY_CHAIN, lastPacketId: withPacket ? packet(throughSeq) : null,
    evidence: withPacket ? "E2" : "native", basis: withPacket ? "evidence" : "native" };
}
function priorOf(next: () => number, through: number): SyncPrior {
  const kind = pick(next, ["fresh", "synced", "synced", "suspect"] as const);
  if (kind === "fresh") return { kind: "fresh", basis: pick(next, ["new", "reset", "user_cleared"] as const) };
  if (kind === "synced") return { kind: "synced", mark: mark(through, next() < 0.7) };
  return { kind: "suspect", mark: next() < 0.5 ? null : mark(through, true), cause: pick(next, ["rewind", "unknown_command", "legacy", "marker_absent"] as const), floorCandidate: null, carried: null, rewound: false };
}
function relayOf(sync: BindingSync, floor = -1): BindingRelayState {
  return parseBindingRelayState({ nativeEpoch: 1, sync, originIncluded: false, reanchor: false, packetsInEpoch: 1, epochFloor: floor, compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null,
    cache: { lastRequestStartedAt: null, contextUsed: null, contextSize: null } });
}

test("G072-A7.4 a pending binding whose packet's facts are no longer owed: the input goes as typed, the binding goes back to the packet's prior (never claiming more), no delivery row is touched and nobody is asked; with something owed the packet is resent or the user asked, never as typed", () => {
  const next = random(0xa7_04);
  for (let index = 0; index < 3000; index++) {
    const through = Math.floor(next() * 40), prior = priorOf(next, through);
    const sync: BindingSync = { kind: "pending", prior, packetId: packet(through + 1), range: { fromSeq: through + 1, throughSeq: through + 5, fromRun: 0, throughRun: 1 },
      autoResends: next() < 0.5 ? 0 : 1, manualResends: 0, attachOverride: false };
    const relay = relayOf(sync), base = markOf(prior)?.throughSeq ?? -1;
    // Facts at or below what the prior claims only (or none): nothing is owed.
    const owedNothing: readonly RelayFact[] = Array.from({ length: Math.floor(next() * 4) }, (_, n) => ({ runId: runId("run-f" + index + "-" + n), seq: base < 0 ? 0 : Math.floor(next() * (base + 1)), executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }))
      .filter(fact => fact.seq <= base);
    const decision = decideTurn({ relay, ...X, facts: owedNothing, originHistory: false, choices: {}, declaration: relayDeclaration(DECLARED), firstFromSeq: through + 1, pendingRun: runId("run-p"), recoveryFailed: false });
    assert.equal(decision.kind, "plain", "seed case " + index); assert.equal(decision.kind === "plain" && decision.owedNothing, true);
    const back = step(relay, { kind: "owed_nothing" });
    assert.equal(back.kind, "applied");
    if (back.kind !== "applied") continue;
    assert.deepEqual(back.relay.sync, prior, "the binding goes back to the prior");
    assert.equal(markOf(back.relay.sync)?.throughSeq ?? -1, base, "never claiming more than the prior did");
    assert.deepEqual(back.deliveries, [], "no delivery row is touched"); assert.equal(back.note.verified, "nothing_owed");
    // Something owed above the prior: never as typed.
    const owing: readonly RelayFact[] = [{ runId: runId("run-o" + index), seq: through + 1 + Math.floor(next() * 4), executedOn: { harnessId: "yankee", controlId: "yankee-acp", nativeEpoch: 1 } }];
    let kind: string;
    try { kind = decideTurn({ relay, ...X, facts: owing, originHistory: false, choices: {}, declaration: relayDeclaration(DECLARED), firstFromSeq: through + 1, pendingRun: runId("run-p"), recoveryFailed: false }).kind; }
    catch (error) { assert.ok(error instanceof RelayError && error.reason === "delivery_unconfirmed"); kind = "asked"; }
    assert.ok(kind === "carry" || kind === "asked", "with something owed: resent or asked, got " + kind);
    // On any other state the event is refused.
    for (const other of [relayOf(prior), relayOf({ kind: "fresh", basis: "new" })]) assert.equal(step(other, { kind: "owed_nothing" }).kind, "refused");
  }
});

test("G072 the return decision (§7.3, D9): without the request's relay.native it chooses a new native session only under new_when_cold, cold and shown beside; the window share alone shows it beside; a longer native context never makes continuing cheaper", () => {
  const next = random(0x73_0003), price = { write: 3e-6, read: 3e-7 };
  for (let index = 0; index < 4000; index++) {
    const now = 1_800_000_000_000, used = Math.floor(next() * 400_000), window = 20_000 + Math.floor(next() * 1_000_000);
    const input = { cache: { lastRequestStartedAt: next() < 0.5 ? now - Math.floor(next() * 600_000) : null, contextUsed: used, contextSize: window }, cacheTtl: pick(next, ["5m", "30m", "1h", "unknown", "auth_dependent"] as const),
      authKind: pick(next, [null, "account", "api_key"]), now, delta: Math.floor(next() * 4000), packet: 1000 + Math.floor(next() * 7000), input: Math.floor(next() * 500), fixedPrefix: 8000, window,
      price: next() < 0.5 ? price : null, prefill: 8000, requests: { requests: 1 + Math.floor(next() * 300), misses: Math.floor(next() * 10) } };
    const estimate = estimateReturn(input), preference = pick(next, ["continue", "new_when_cold", "ask"] as readonly ReturnPreference[]);
    const chosen = returnChoice(estimate, preference, undefined);
    if (chosen.choice === "new") assert.ok(preference === "new_when_cold" && !estimate.warm && estimate.sideBySide, "new only under new_when_cold, cold and side by side");
    if (used / window >= 0.85) assert.equal(estimate.sideBySide, true, "a full window is always shown beside");
    assert.equal(returnChoice(estimate, preference, "continue").choice, "continue"); assert.equal(returnChoice(estimate, preference, "new").choice, "new");
    if (input.price !== null) {
      const longer = estimateReturn({ ...input, cache: { ...input.cache, contextUsed: used + 10_000 } });
      assert.ok(longer.wholeDiff! >= estimate.wholeDiff! - 1e-9, "a longer native context never makes continuing cheaper");
    }
  }
});
