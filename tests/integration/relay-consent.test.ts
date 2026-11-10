import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nativeConversationId, singleText, type BackendResult, type HarnessControl, type TurnText } from "../../src/contracts/control.js";
import { RelayError, parseVendorKey, type EndpointLayer, type RelayCapabilities, type VendorKey, type VendorObservation } from "../../src/contracts/relay.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId } from "../../src/contracts/session.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { consentStanding, type ConsentView } from "../../src/contexts/session/application/relay-coordinator.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G072-C06, G072-C08 (ADR-055 §10.4, INV-33; relay-architecture §17, CS-01–CS-04): consent by the target's vendor key through
// the formal SessionRuntime and a real SqliteSessionStore whose installation log (relay_log) is the consent's authority. The
// Harnesses are in-process fakes behind a factory that answers the Drivers' static declarations; each fake's Driver reports the
// endpoint and model it runs on (relayVendor), from which its declaration's resolveVendor gives the key. Nothing here runs a
// Harness.

const NOW = Date.UTC(2026, 10, 10, 12);
function temporary(): string { return mkdtempSync(join(tmpdir(), "g072-consent-")); }
/** A probed declaration whose vendor key is the observation's: a gateway for an endpoint, else the key its authKind carries. */
const DECLARED: RelayCapabilities = { ...dshRelayCapabilities, probed: true, execution: "process",
  delivery: { live: "none", verify: "none", successProvesRecorded: true, lateDelivery: false },
  commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: sharedClassify },
  placement: { parts: "single", maxInput: null, pointersAfterUser: true, measure: measureBy("single", "chars", ["file"]) },
  resolveVendor: observed => observed.endpoint !== null ? ("gateway:" + observed.endpoint.host) as VendorKey : observed.authKind === null ? "unknown:fake" as VendorKey : parseVendorKey(observed.authKind) };
const at = (vendor: string): VendorObservation => ({ model: null, modelKey: "", authKind: vendor, endpoint: null, loopback: false });
const gateway = (host: string, layer: EndpointLayer): VendorObservation => ({ model: null, modelKey: "", authKind: null, endpoint: { host, layer }, loopback: false });

class Fakes implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string; readonly turn: TurnText }[] = [];
  readonly observed: Record<string, VendorObservation | null> = {};
  onAuthorized: ((harnessId: string) => void) | null = null;
  private opened = 0;
  constructor(readonly harnesses: readonly string[]) {}
  relayCapabilities(): RelayCapabilities { return DECLARED; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!this.harnesses.includes(request.harnessId)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId; let session: string | null = null;
    const control: HarnessControl = { relayCapabilities: DECLARED,
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session, healthy: () => true,
      relayVendor: async () => this.observed[harnessId] ?? null,
      enablePermissions: () => { this.onAuthorized?.(harnessId); },
      startText: async (_id, turn, output) => {
        this.prompts.push({ harnessId, text: singleText(turn), turn }); output({ type: "text", text: "reply from " + harnessId });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => ({ closed: true, exitCode: 0, signal: null, protocolFailure: null }) };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  carried(harnessId: string): number { return this.prompts.filter(row => row.harnessId === harnessId && typeof row.turn === "object").length; }
}
async function setup(t: TestContext, harnesses: readonly string[] = ["alpha", "bravo"]) {
  const root = temporary(), workspace = join(root, "workspace"); mkdirSync(workspace);
  const store = new SqliteSessionStore(join(root, "data"), { recoverRelay }), fakes = new Fakes(harnesses);
  let next = 0;
  const app = new SessionRuntime(store, fakes, { id: () => "g072c-" + ++next, now: () => new Date(NOW), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), relayIsolated: () => true });
  // The owner is closed before its data root is removed.
  t.after(async () => { try { await app.close(); store.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  return { store, fakes, app, configuration };
}
type Setup = Awaited<ReturnType<typeof setup>>;
let commands = 0;
function record(store: SqliteSessionStore, id: SessionId | null, vendor: string, decision: "acknowledged" | "goal_only" | "revoked" = "acknowledged"): number {
  return store.appendRelayLog({ commandId: "consent-" + ++commands, vendor: vendor as VendorKey, scope: id === null ? { kind: "global" } : { kind: "session", sessionId: id }, decision,
    categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: NOW }).logSeq;
}
async function turn(s: Setup, id: SessionId, text: string, key: string, relay?: RelayChoice): Promise<PublicRun> {
  const receipt = s.app.send(id, text, key, [], relay); await s.app.wait(id);
  return s.app.read(id).runs.find(row => row.id === receipt.runId)!;
}
function refusal(s: Setup, id: SessionId, text: string, key: string, relay?: RelayChoice): string {
  const runs = s.app.read(id).runs.length;
  try { s.app.send(id, text, key, [], relay); } catch (error) { assert.equal(s.app.read(id).runs.length, runs, "no Run"); if (error instanceof RelayError) return error.code + "{" + error.reason + "}"; throw error; }
  return "accepted";
}
function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
let conversations = 0;
/** A conversation whose alpha (anthropic) holds a fact, and whose bravo binding knows its vendor (`vendor`), now on bravo owing a1. */
async function owing(s: Setup, bravo: VendorObservation): Promise<SessionId> {
  s.fakes.observed.alpha = at("anthropic"); s.fakes.observed.bravo = bravo;
  const id = (await s.app.create(s.configuration, { harnessId: "bravo" }, "create-" + ++conversations)).id;
  assert.equal((await turn(s, id, "b0 alone, bravo's vendor is learnt", "b0", { attach: "none" })).status, "completed");
  s.app.switch(id, { harnessId: "alpha" }, "owing-to-a"); await s.app.wait(id);
  // alpha owes b0, which these cases do not send: its own input goes alone.
  assert.equal((await turn(s, id, "a1 a fact", "a1", { attach: "none" })).status, "completed");
  s.app.switch(id, { harnessId: "bravo" }, "owing-to-b"); await s.app.wait(id);
  assert.equal(s.app.read(id).selection.harnessId, "bravo");
  return id;
}

test("G072-C06 CS-01 a cross-vendor handoff without consent is refused (missing), no Run; the request's consent is recorded in the installation's log, mirrored once in the conversation, and the delivery row names its seq", async t => {
  const s = await setup(t), id = await owing(s, at("openai"));
  assert.equal(refusal(s, id, "b1 would carry a1", "b1"), "RELAY_CONSENT_REQUIRED{missing}");
  assert.equal(s.fakes.carried("bravo"), 0);
  const b1 = await turn(s, id, "b1 carries a1", "b1b", { consent: { vendor: "openai" as VendorKey, decision: "acknowledged", scope: "session" } });
  assert.equal(b1.status, "completed"); assert.equal(s.fakes.carried("bravo"), 1);
  const log = s.store.relayConsents().filter(row => row.vendor === "openai");
  assert.equal(log.length, 1); assert.deepEqual(log[0]!.scope, { kind: "session", sessionId: id });
  const mirrored = events(s.store, id).filter(row => row.type === "relay.consent_recorded");
  assert.equal(mirrored.length, 1); assert.equal(mirrored[0]!.data.logSeq, log[0]!.logSeq); assert.equal(mirrored[0]!.data.runId, b1.id);
  assert.equal(s.store.relayDeliveries(id).find(row => row.runId === b1.id)?.consentLogSeq, log[0]!.logSeq, "consentLogSeq is the real one");
  // A replay of the same send records nothing twice.
  assert.equal(s.app.send(id, "b1 carries a1", "b1b", [], { consent: { vendor: "openai" as VendorKey, decision: "acknowledged", scope: "session" } }).replayed, true);
  assert.equal(s.store.relayConsents().filter(row => row.vendor === "openai").length, 1);
  // Back to alpha: bravo's Turns (openai) owed to anthropic are cross-vendor too, and asked for alpha's vendor.
  s.app.switch(id, { harnessId: "alpha" }, "to-a"); await s.app.wait(id);
  assert.equal(refusal(s, id, "a2 would carry b1", "a2"), "RELAY_CONSENT_REQUIRED{missing}");
});

test("G072-C06 CS-02 scopes and the preference: a global record covers a named vendor in every conversation; relay.crossVendor allow covers named vendors but never unknown:*, gateway:*, router:* or provider:*; an unknown vendor and a workspace file's endpoint are asked in every conversation", async t => {
  const view = (records: ConsentView["records"], crossVendor: ConsentView["crossVendor"] = "ask"): ConsentView => ({ session: "session-one" as SessionId, records, crossVendor, localModelsOffline: false, request: null });
  const row = (vendor: string, scope: "global" | "session", decision: "acknowledged" | "revoked", logSeq: number, session = "session-one") =>
    ({ logSeq, commandId: "c" + logSeq, vendor: vendor as VendorKey, scope: scope === "global" ? { kind: "global" as const } : { kind: "session" as const, sessionId: session as SessionId }, decision, categories: [], policyVersion: "relay/1" as const, authKind: null, decidedAt: 1 });
  assert.equal(consentStanding("openai", null, view([row("openai", "global", "acknowledged", 1)])).kind, "given");
  assert.equal(consentStanding("openai", null, view([row("openai", "session", "acknowledged", 1, "session-two")])).kind, "missing", "another conversation's record");
  for (const vendor of ["unknown:codex", "gateway:api.example.com", "router:openrouter", "provider:ollama"]) assert.equal(consentStanding(vendor as VendorKey, null, view([], "allow")).kind, "missing", vendor + ": allow never covers it");
  assert.deepEqual(consentStanding("anthropic", null, view([], "allow")), { kind: "given", decision: "acknowledged", logSeq: null, via: "preference" });
  assert.equal(consentStanding("unknown:codex", null, view([row("unknown:codex", "global", "acknowledged", 1)])).kind, "missing", "an unknown vendor: only this conversation's own record");
  assert.equal(consentStanding("gateway:api.example.com", "workspace_file", view([row("gateway:api.example.com", "global", "acknowledged", 1)])).kind, "missing", "a workspace file's endpoint: every conversation");
  assert.equal(consentStanding("gateway:api.example.com", "user_config", view([row("gateway:api.example.com", "global", "acknowledged", 1)])).kind, "given", "a user setting's endpoint: a global record stands");
  // A withdrawal beats a broader consent and the preference.
  assert.deepEqual(consentStanding("openai", null, view([row("openai", "global", "acknowledged", 1), row("openai", "session", "revoked", 2)], "allow")), { kind: "missing", revoked: true });
  assert.deepEqual(consentStanding("openai", null, view([row("openai", "global", "revoked", 3)], "allow")), { kind: "missing", revoked: true });
  // Through the Runtime: a workspace file's endpoint asked again in a new conversation despite the first one's global consent.
  const s = await setup(t), first = await owing(s, gateway("api.example.com", "workspace_file"));
  assert.equal(refusal(s, first, "b1", "b1"), "RELAY_CONSENT_REQUIRED{missing}");
  assert.equal((await turn(s, first, "b1 carries a1", "b1b", { consent: { vendor: "gateway:api.example.com" as VendorKey, decision: "acknowledged", scope: "global" } })).status, "completed");
  const second = await owing(s, gateway("api.example.com", "workspace_file"));
  assert.equal(refusal(s, second, "b1 in another conversation", "b1"), "RELAY_CONSENT_REQUIRED{missing}");
  s.store.setPref("relay.crossVendor", "allow");
  assert.equal(refusal(s, second, "b1 still asked", "b1c"), "RELAY_CONSENT_REQUIRED{missing}", "allow never covers a gateway");
});

test("G072-C06 CS-03 a vendor that changes within an epoch needs consent anew (vendor_changed), at admission when the binding knows it, at the open when only the Driver saw it — recorded as relay.vendor_changed; a consent in the request settles it", async t => {
  const s = await setup(t), id = await owing(s, at("openai"));
  record(s.store, null, "openai"); record(s.store, null, "deepseek");
  assert.equal((await turn(s, id, "b1 carries a1", "b1")).status, "completed");
  s.app.switch(id, { harnessId: "alpha" }, "to-a"); await s.app.wait(id); await turn(s, id, "a2", "a2", { attach: "none" }); s.app.switch(id, { harnessId: "bravo" }, "to-b"); await s.app.wait(id);
  // The Harness now runs another vendor (it changed its model): the open sees it, a global consent to deepseek notwithstanding.
  s.fakes.observed.bravo = at("deepseek");
  const failed = await turn(s, id, "b2 would carry a2", "b2");
  assert.equal(failed.status, "failed"); assert.equal(failed.error?.code, "RELAY_CONSENT_REQUIRED"); assert.equal(failed.timing?.dispatchedAt, undefined);
  assert.equal(events(s.store, id).filter(row => row.type === "relay.vendor_changed").length, 1);
  assert.equal(refusal(s, id, "b3 would carry a2", "b3"), "RELAY_CONSENT_REQUIRED{vendor_changed}");
  const agreed = await turn(s, id, "b3 carries a2", "b3b", { consent: { vendor: "deepseek" as VendorKey, decision: "acknowledged", scope: "session" } });
  assert.equal(agreed.status, "completed");
  // A consent to a vendor admission could not tell (unknown) only says the explanation was read: the open's real vendor is asked.
  const fresh = await setup(t, ["alpha", "charlie"]);
  fresh.fakes.observed.alpha = at("anthropic"); fresh.fakes.observed.charlie = at("openai");
  const other = (await fresh.app.create(fresh.configuration, { harnessId: "alpha" }, "create")).id;
  await turn(fresh, other, "a1", "a1"); fresh.app.switch(other, { harnessId: "charlie" }, "to-c"); await fresh.app.wait(other);
  const first = await turn(fresh, other, "c1 carries a1", "c1", { consent: { vendor: "unknown:charlie" as VendorKey, decision: "acknowledged", scope: "session" } });
  assert.equal(first.status, "failed"); assert.equal(first.error?.code, "RELAY_CONSENT_REQUIRED", "the open saw openai, which nobody consented to");
  assert.equal(fresh.fakes.carried("charlie"), 0);
});

test("G072-C06 CS-04 local: with \"本机模型不出网\" (relay.localModelsOffline) no consent is asked; without it local is asked like any vendor; goal-only consent is no consent for a standard packet yet", async t => {
  const s = await setup(t), id = await owing(s, at("local"));
  assert.equal(refusal(s, id, "b1 to a local model", "b1"), "RELAY_CONSENT_REQUIRED{missing}");
  s.store.setPref("relay.localModelsOffline", "true");
  assert.equal((await turn(s, id, "b1 to a local model", "b1b")).status, "completed");
  assert.equal(s.store.relayDeliveries(id).at(-1)?.consentLogSeq, null, "no consent was needed, none is named");
  // goal_only stands for no packet the MVP can render (standard only): asked again, saying so.
  const g = await setup(t), other = await owing(g, at("openai"));
  record(g.store, other, "openai", "goal_only");
  let message = "";
  try { g.app.send(other, "b1", "b1"); } catch (error) { assert.ok(error instanceof RelayError); assert.equal(error.reason, "missing"); message = error.message; }
  assert.match(message, /只交目标/u);
});

test("G072-C06 a withdrawal makes the consent missing again; the vendor key is never stopped for a Turn that carries nothing", async t => {
  const s = await setup(t), id = await owing(s, at("openai"));
  record(s.store, id, "openai");
  assert.equal((await turn(s, id, "b1 carries a1", "b1")).status, "completed");
  record(s.store, id, "openai", "revoked");
  s.app.switch(id, { harnessId: "alpha" }, "to-a"); await s.app.wait(id); await turn(s, id, "a2", "a2", { attach: "none" }); s.app.switch(id, { harnessId: "bravo" }, "to-b"); await s.app.wait(id);
  assert.equal(refusal(s, id, "b2 would carry a2", "b2"), "RELAY_CONSENT_REQUIRED{revoked}");
  assert.equal((await turn(s, id, "b2 alone", "b2b", { attach: "none" })).status, "completed", "只发这条消息");
});

test("G072-C08 the consent is read again right before dispatch: withdrawn after the Turn was prepared, it is not dispatched (RELAY_CONSENT_REQUIRED{revoked}); its packet is not recorded and the binding goes back as it was", async t => {
  const s = await setup(t), id = await owing(s, at("openai"));
  record(s.store, id, "openai");
  s.fakes.onAuthorized = harnessId => { if (harnessId === "bravo") { record(s.store, id, "openai", "revoked"); s.fakes.onAuthorized = null; } };
  const before = s.app.read(id).nativeBindings!.find(row => row.harnessId === "bravo" && row.status !== "archived")!.relay!.sync;
  const run = await turn(s, id, "b1 would carry a1", "b1");
  assert.equal(run.status, "failed"); assert.equal(run.error?.code, "RELAY_CONSENT_REQUIRED"); assert.equal(run.timing?.dispatchedAt, undefined);
  assert.equal(s.fakes.carried("bravo"), 0, "nothing reached bravo");
  const row = s.store.relayDeliveries(id).find(item => item.runId === run.id)!;
  assert.equal(row.outcome.kind, "not_recorded");
  assert.deepEqual(s.app.read(id).nativeBindings!.find(item => item.harnessId === "bravo" && item.status !== "archived")!.relay!.sync, before, "back to the prior");
});
