import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type HarnessControl, type NativeCommand, type NativeUsage, type TurnText } from "../../src/contracts/control.js";
import { RelayError, parseVendorKey, type RelayCapabilities, type RelayKeyPort, type VendorKey, type VendorObservation } from "../../src/contracts/relay.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { RelayKeys } from "../../src/infrastructure/session/relay-keys.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, peerRoot } from "../fixtures/relay-drivers.js";
import { strictRelay } from "../fixtures/relay-settings.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import { openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { DirectorySessionBindingFactory } from "../../src/infrastructure/session/binding-factory.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

// G072 (ADR-055 §6.1, §7.3, §9, §10.4; relay-architecture §17 G072-C01–C05, C07, C10): the coordinator's gates through the
// formal SessionRuntime and a real SqliteSessionStore (with recoverRelay, as the composition root builds it) on temporary data
// roots. The Harnesses are in-process fake controls behind a binding factory that answers the Drivers' static declarations
// (relayCapabilities), as the Gateway's own factory does; what reached each one is read back from them, what the Hub
// concluded from the Store. Nothing here runs a Harness. The Claude Driver's mapping of "no such session" runs the real
// ClaudeControl against the relay peer (tests/fixtures/relay-control-peer.mjs), a child process on stdio.

const NOW = Date.UTC(2026, 10, 10, 12);
const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
function temporary(t: TestContext): string { const root = mkdtempSync(join(tmpdir(), "g072-relay-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

/**
 * A fake Driver's relay declaration: probed unless said otherwise, verify none, success proves the input recorded; its vendor
 * key is read from what it observed (the observation's authKind carries the key here, so a test can change the vendor).
 */
function declared(o: { readonly probed?: boolean; readonly title?: RelayCapabilities["title"]; readonly maxInput?: RelayCapabilities["placement"]["maxInput"]; readonly window?: RelayCapabilities["window"];
    readonly successProvesRecorded?: boolean; readonly classify?: RelayCapabilities["commands"]["classify"] } = {}): RelayCapabilities {
  return { ...dshRelayCapabilities, probed: o.probed ?? true, execution: "process", compactionEvidence: "event",
    delivery: { live: "none", verify: "none", successProvesRecorded: o.successProvesRecorded ?? true, lateDelivery: false },
    commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: o.classify ?? sharedClassify },
    placement: { parts: "single", maxInput: o.maxInput ?? null, pointersAfterUser: true, measure: measureBy("single", o.maxInput?.unit ?? "chars", ["file"]) },
    window: o.window ?? "session_report", title: o.title ?? "none", resolveVendor: observed => observed.authKind === null ? "unknown:fake" as VendorKey : parseVendorKey(observed.authKind) };
}
/** An observation whose vendor key is `vendor` (see declared). */
export function seen(vendor: string, modelKey = ""): VendorObservation { return { model: modelKey || null, modelKey, authKind: vendor, endpoint: null, loopback: false }; }
const COMMANDS: readonly NativeCommand[] = [{ name: "compact", description: "compact", contextEffect: "compact" }, { name: "clear", description: "clear", contextEffect: "clear" },
  { name: "undo", description: "undo", contextEffect: "rewind" }, { name: "skill:review", description: "skill", contextEffect: "keep" }];

/**
 * In-process fake Harnesses behind a factory that answers the static declarations (`declarations[harnessId]`, null: declares
 * none). Each prompt is recorded with the session it reached; `observed[harnessId]` is what its Driver reports as its vendor
 * (absent: the Driver has no relayVendor); `usage` what a Turn reports; `script` how a prompt ends; `hold` keeps prompts running
 * until released; `onAuthorized` runs when the Runtime enables permissions (after the authorization, before dispatch).
 */
class Fakes implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string; readonly turn: TurnText; readonly session: string }[] = [];
  readonly titles: { readonly harnessId: string; readonly title: string }[] = [];
  readonly opens: { readonly harnessId: string; readonly checkpoint: string | undefined }[] = [];
  readonly observed: Record<string, VendorObservation | null> = {};
  readonly usage: Record<string, NativeUsage> = {};
  /** The declaration a connection carries, when it differs from the factory's static one (a Driver's own, defence in depth). */
  readonly own: Record<string, RelayCapabilities | null> = {};
  /** How a prompt ends; `unrecorded`: the Driver knows nothing of the input reaching the history. */
  script: (harnessId: string, input: string) => Partial<BackendResult> & { readonly unrecorded?: true } = () => ({});
  hold = false;
  closeUnconfirmed = false;
  readonly held: (() => void)[] = [];
  onAuthorized: ((harnessId: string) => void) | null = null;
  titleFails = false;
  prepared = 0;
  private opened = 0;
  constructor(readonly declarations: Readonly<Record<string, RelayCapabilities | null>>) {}
  relayCapabilities(selection: HarnessSelection): RelayCapabilities | null { return this.declarations[selection.harnessId] ?? null; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!(request.harnessId in this.declarations)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp", ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }) };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId; this.prepared += 1;
    let session: string | null = null;
    const declaration = harnessId in this.own ? this.own[harnessId] : this.declarations[harnessId];
    const control: HarnessControl = {
      ...(declaration === null || declaration === undefined ? {} : { relayCapabilities: declaration }),
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { this.opens.push({ harnessId, checkpoint }); session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session,
      healthy: () => true,
      models: async () => ({ models: [{ id: "model-a", name: "A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: COMMANDS }),
      ...(harnessId in this.observed ? { relayVendor: async () => this.observed[harnessId] ?? null } : {}),
      setTitle: async (_id, title) => { if (this.titleFails) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "refused"); this.titles.push({ harnessId, title }); },
      enablePermissions: () => { this.onAuthorized?.(harnessId); },
      startText: async (_id, turn, output) => {
        const input = typeof turn === "string" ? turn : turn.user;
        this.prompts.push({ harnessId, text: singleText(turn), turn, session: session! });
        output({ type: "text", text: "reply from " + harnessId });
        if (this.usage[harnessId] !== undefined) output({ type: "usage", usage: this.usage[harnessId]! });
        const { unrecorded, ...rest } = this.script(harnessId, input);
        const ending: BackendResult = { status: "completed", reason: "fake", ...(unrecorded === true ? {} : { input: "recorded" as const }), ...rest };
        const result = this.hold ? new Promise<BackendResult>(resolve => { this.held.push(() => resolve(ending)); }) : Promise.resolve(ending);
        return { result, requestStop: async () => { for (const release of this.held.splice(0)) release(); return { requested: true }; } };
      },
      close: async () => { if (this.closeUnconfirmed) throw new SessionError("CLEANUP_FAILED", "the program's end could not be confirmed"); return clean; },
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  to(harnessId: string): readonly { readonly text: string; readonly turn: TurnText; readonly session: string }[] { return this.prompts.filter(row => row.harnessId === harnessId); }
  release(): void { for (const release of this.held.splice(0)) release(); }
}
interface World { readonly data: string; store: SqliteSessionStore; readonly configuration: SessionConfiguration; runtime(factory: SessionBindingFactory, options?: { readonly isolated?: boolean; readonly keys?: RelayKeyPort }): SessionRuntime }
/** The strict design's world (P9): these cases are about its gates and questions, so every strict preference is on; the permissive defaults are tested in relay-permissive.test.ts. */
function world(t: TestContext, strict = true): World {
  const root = temporary(t), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  const runtimes: SessionRuntime[] = [];
  const w: World = { data, store: new SqliteSessionStore(data, { recoverRelay }),
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    runtime(factory, options = {}) {
      let next = 0;
      const app = new SessionRuntime(w.store, factory, { id: () => "g072-" + ++next + "-" + runtimes.length, now: () => new Date(NOW), publish: () => {},
        fingerprint: value => createHash("sha256").update(value).digest("hex"), relayIsolated: () => options.isolated ?? true, ...(options.keys === undefined ? {} : { relayKeys: options.keys }) });
      runtimes.push(app); return app;
    } };
  if (strict) strictRelay(w.store);
  t.after(async () => {
    for (const app of runtimes) { try { await app.close(); } catch { /* a runtime whose store was closed under it ends failed */ } }
    try { w.store.close(); } catch { /* closed by the test */ }
  });
  return w;
}
let grants = 0;
function consent(store: SqliteSessionStore, id: SessionId | null, vendor: string, decision: "acknowledged" | "goal_only" | "revoked" = "acknowledged"): number {
  return store.appendRelayLog({ commandId: "test-consent-" + ++grants, vendor: vendor as VendorKey, scope: id === null ? { kind: "global" } : { kind: "session", sessionId: id }, decision,
    categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: NOW }).logSeq;
}
async function turn(app: SessionRuntime, id: SessionId, text: string, key: string, relay?: RelayChoice): Promise<PublicRun> {
  const receipt = app.send(id, text, key, [], relay);
  await app.wait(id).catch((error: unknown) => { if (!(error instanceof SessionError && error.code === "SESSION_BLOCKED")) throw error; });
  return app.read(id).runs.find(row => row.id === receipt.runId)!;
}
async function to(app: SessionRuntime, id: SessionId, harnessId: string, key: string): Promise<void> { app.switch(id, { harnessId }, key); await app.wait(id); assert.equal(app.read(id).selection.harnessId, harnessId); }
function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
function eventOf(store: SqliteSessionStore, id: SessionId, type: string, run: string): SessionEvent | undefined { return events(store, id).findLast(row => row.type === type && row.data.runId === run); }
function relayOf(state: SessionSnapshot, harnessId: string) { return state.nativeBindings!.find(row => row.harnessId === harnessId && row.status !== "archived")!.relay!; }
/** What a send was refused with ("CODE{reason}"), and that the refusal made no Run and started nothing. */
function refusedAt(app: SessionRuntime, fakes: Fakes, id: SessionId, text: string, key: string, relay?: RelayChoice): string {
  const runs = app.read(id).runs.length, prepared = fakes.prepared;
  try { app.send(id, text, key, [], relay); }
  catch (error) {
    assert.equal(app.read(id).runs.length, runs, "no Run is made"); assert.equal(fakes.prepared, prepared, "no program is started");
    if (error instanceof RelayError) return error.code + "{" + error.reason + "}";
    if (error instanceof SessionError) return error.code;
    throw error;
  }
  return "accepted";
}
/** alpha (anthropic) with one Turn, a1; then the conversation switched to `target`. */
async function fromAlpha(t: TestContext, declarations: Readonly<Record<string, RelayCapabilities | null>>, target: string, options: { readonly isolated?: boolean; readonly strict?: boolean } = {}) {
  const w = world(t, options.strict ?? true), fakes = new Fakes({ alpha: declared(), ...declarations });
  fakes.observed.alpha = seen("anthropic");
  const app = w.runtime(fakes, options), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  const a1 = await turn(app, id, "a1 a fact on alpha", "a1");
  await to(app, id, target, "to-" + target);
  return { w, fakes, app, id, a1 };
}

test("G072-C01 an idle switch takes effect without building a packet or starting the target; the next message prepares the target's binding and carries what it is owed (the installation's defaults: no probe, consent or data root preset)", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared() }, "bravo", { strict: false });
  fakes.observed.bravo = seen("openai");
  assert.equal(fakes.to("bravo").length, 0, "nothing reached bravo"); assert.equal(fakes.prepared, 1, "only alpha's program ran");
  assert.deepEqual(w.store.relayPackets(id), [], "no packet at the switch");
  assert.equal(app.read(id).nativeBindings!.some(row => row.harnessId === "bravo"), false, "no binding yet");
  const b1 = await turn(app, id, "b1 carries a1", "b1");
  assert.equal(b1.status, "completed"); assert.deepEqual(b1.sourceRunIds, [a1.id]);
  assert.equal(typeof fakes.to("bravo")[0]!.turn, "object", "the packet went with b1");
  assert.equal(w.store.relayPackets(id).length, 1);
  const relay = relayOf(app.read(id), "bravo");
  assert.equal(relay.consentKey, "openai", "the epoch's vendor key is the one the first packet went to");
  assert.deepEqual(relay.vendorObserved, seen("openai"), "the observation is cached for the next admission");
});

test("G072-C02 admission's refusals (§6.1, §9): each one synchronous, no Run, no program — the probe gate, the data root, the user's choice, consent, MIN_PACKET; an input sent alone and a single-Harness conversation are never stopped", async t => {
  // The probe gate: unprobed and undeclared targets take no history; allowUnprobed opens both (development only).
  {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ probed: false }), charlie: null }, "bravo");
    assert.equal(refusedAt(app, fakes, id, "b1 would carry a1", "b1"), "RELAY_TARGET_UNVERIFIED{unprobed}");
    assert.equal((await turn(app, id, "b1 alone", "b1-alone", { attach: "none" })).status, "completed", "an input sent alone goes");
    assert.equal(fakes.to("bravo").at(-1)!.text, "b1 alone");
    await to(app, id, "charlie", "to-c");
    assert.equal(refusedAt(app, fakes, id, "c1 would carry", "c1"), "RELAY_TARGET_UNVERIFIED{undeclared}");
    w.store.setPref("relay.allowUnprobed", "true");
    assert.equal(refusedAt(app, fakes, id, "c1 would carry", "c1b"), "RELAY_CONSENT_REQUIRED{missing}", "past the probe gate, consent is next");
  }
  // A single-Harness conversation on an unprobed Driver is never asked.
  {
    const w = world(t), fakes = new Fakes({ solo: declared({ probed: false }) }), app = w.runtime(fakes);
    const id = (await app.create(w.configuration, { harnessId: "solo" }, "create")).id;
    for (const key of ["s1", "s2", "s3"]) assert.equal((await turn(app, id, key + " on solo", key)).status, "completed");
    assert.deepEqual(fakes.to("solo").map(row => row.text), ["s1 on solo", "s2 on solo", "s3 on solo"], "every input as typed");
  }
  // The data root: a cross-vendor handoff into a workspace the data directory is not out of reach of; same-vendor goes.
  {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared(), delta: declared() }, "bravo", { isolated: false });
    fakes.observed.bravo = seen("openai"); fakes.observed.delta = seen("anthropic");
    consent(w.store, id, "unknown:bravo"); consent(w.store, null, "openai");
    assert.equal(refusedAt(app, fakes, id, "b1 would carry a1 to another vendor", "b1"), "RELAY_UNAVAILABLE{data_root_in_workspace}");
    await to(app, id, "delta", "to-d");
    // delta's first Turn caches its vendor (anthropic, alpha's own): the handoff is then same-vendor and goes.
    assert.equal((await turn(app, id, "d0 alone", "d0", { attach: "none" })).status, "completed");
    const d1 = await turn(app, id, "d1 carries a1 to the same vendor", "d1");
    assert.equal(d1.status, "completed"); assert.equal(typeof fakes.to("delta").at(-1)!.turn, "object");
  }
  // The user's choice: a pending packet whose automatic resend is spent (delivery_unconfirmed); a suspect binding (verify_required).
  {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ successProvesRecorded: false }) }, "bravo");
    fakes.observed.bravo = seen("openai"); consent(w.store, id, "unknown:bravo"); consent(w.store, null, "openai");
    fakes.script = harnessId => harnessId === "bravo" ? { unrecorded: true } : {};
    assert.equal((await turn(app, id, "b1 carries a1, unconfirmed", "b1")).status, "completed");
    assert.equal((await turn(app, id, "b2 resends it once", "b2")).status, "completed");
    assert.equal(relayOf(app.read(id), "bravo").sync.kind, "pending");
    assert.equal(refusedAt(app, fakes, id, "b3", "b3"), "RELAY_CHOICE_REQUIRED{delivery_unconfirmed}");
    assert.equal((await turn(app, id, "b3 alone", "b3-alone", { attach: "none" })).status, "completed");
  }
  {
    // A mark on a packet that a rewind put in doubt, and a Driver that cannot check: nothing at the open could settle it.
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
    fakes.observed.bravo = seen("openai"); consent(w.store, id, "unknown:bravo"); consent(w.store, null, "openai");
    assert.equal((await turn(app, id, "b1 carries a1", "b1")).status, "completed");
    assert.equal((await turn(app, id, "/undo", "undo")).status, "completed");
    assert.equal(relayOf(app.read(id), "bravo").sync.kind, "suspect");
    assert.equal(refusedAt(app, fakes, id, "b2", "b2"), "RELAY_CHOICE_REQUIRED{verify_required}");
    assert.equal((await turn(app, id, "b2 alone", "b2-alone", { attach: "none" })).status, "completed", "只发这条消息 is offered");
  }
  // Consent, and MIN_PACKET on the window the target reported (16k: its hard cap is 800 tokens, below 1,350).
  {
    const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
    fakes.observed.bravo = seen("openai");
    assert.equal(refusedAt(app, fakes, id, "b1 would carry a1", "b1"), "RELAY_CONSENT_REQUIRED{missing}");
    fakes.usage.bravo = { context: { used: 2000, size: 16_000 } };
    assert.equal((await turn(app, id, "b0 alone", "b0", { attach: "none" })).status, "completed");
    assert.equal(relayOf(app.read(id), "bravo").cache.contextSize, 16_000, "the window its usage reported is kept");
    consent(w.store, id, "openai");
    assert.equal(refusedAt(app, fakes, id, "b1 would carry a1", "b1b"), "RELAY_INPUT_LIMIT{min_packet}");
    assert.equal((await turn(app, id, "b1 alone", "b1-alone", { attach: "none" })).status, "completed", "只发这条消息 is left");
  }
});

test("G072-C03 S5: a switch asked during a Turn waits for its boundary; stop-and-switch ends the Turn first; a stop that cannot be confirmed fails the pending switch and the input waiting for it", async t => {
  const w = world(t), fakes = new Fakes({ alpha: declared(), bravo: declared() }), app = w.runtime(fakes);
  const id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  fakes.hold = true;
  const running = app.send(id, "a1 runs", "a1");
  for (let i = 0; i < 200 && fakes.held.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  app.switch(id, { harnessId: "bravo" }, "to-b");
  assert.equal(app.read(id).selection.harnessId, "alpha", "wait_current: not before the boundary");
  assert.notEqual(app.read(id).pendingSwitchId, null);
  fakes.hold = false; fakes.release(); await app.wait(id);
  assert.equal(app.read(id).selection.harnessId, "bravo", "effective at the boundary");
  assert.equal(app.read(id).runs.find(row => row.id === running.runId)!.status, "completed", "the Turn ended as it did");
  // Stop and switch: the user's stop ends the Turn, then the switch takes effect.
  fakes.hold = true;
  const second = app.send(id, "b1 alone", "b1", [], { attach: "none" });
  for (let i = 0; i < 200 && fakes.held.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  app.switch(id, { harnessId: "alpha" }, "to-a"); app.cancel(id, "stop-b1");
  fakes.hold = false; await app.wait(id);
  assert.equal(app.read(id).runs.find(row => row.id === second.runId)!.status, "cancelled"); assert.equal(app.read(id).selection.harnessId, "alpha");
  // A stop that cannot be confirmed: the Turn is unknown, the pending switch fails and the input waiting for it is not dispatched.
  fakes.hold = true; fakes.closeUnconfirmed = true;
  app.send(id, "a2 alone", "a2", [], { attach: "none" });
  for (let i = 0; i < 200 && fakes.held.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  app.switch(id, { harnessId: "bravo" }, "to-b2");
  const waiting = app.send(id, "waits for the switch", "w1", [], { attach: "none" });
  app.cancel(id, "stop-a2");
  await app.wait(id).catch(() => {});
  const state = app.read(id);
  assert.equal(state.status, "blocked"); assert.equal(state.switches.at(-1)!.status, "failed");
  assert.equal(state.runs.find(row => row.id === waiting.runId)!.error?.code, "SWITCH_NOT_EFFECTIVE");
  assert.equal(fakes.to("bravo").some(row => row.text === "waits for the switch"), false, "never dispatched");
});

test("G072-C04 failures after the open (§9 \"open 之后\"): a vendor that changed, a refined window too small, a reading that changed, a connection's own declaration unprobed — the Run fails undispatched, its native session and binding kept, no packet, delivery row or pending", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai"); consent(w.store, id, "unknown:bravo"); consent(w.store, null, "openai"); consent(w.store, null, "anthropic");
  assert.equal((await turn(app, id, "b1 carries a1", "b1")).status, "completed");
  await to(app, id, "alpha", "to-a"); assert.equal((await turn(app, id, "a2 another fact", "a2")).status, "completed");
  await to(app, id, "bravo", "to-b");
  const before = () => ({ packets: w.store.relayPackets(id).length, rows: w.store.relayDeliveries(id).length, sync: JSON.stringify(relayOf(app.read(id), "bravo").sync), checkpoint: app.read(id).nativeBindings!.find(row => row.harnessId === "bravo" && row.status !== "archived")!.checkpoint });
  const unchanged = (run: PublicRun, code: string, mark: ReturnType<typeof before>) => {
    assert.equal(run.status, "failed"); assert.equal(run.error?.code, code); assert.equal(run.timing?.dispatchedAt, undefined, "never dispatched");
    const now = before();
    assert.deepEqual({ packets: now.packets, rows: now.rows, sync: now.sync, checkpoint: now.checkpoint }, mark, "relay state unchanged, the native session kept");
  };
  // The vendor the open saw is not the epoch's (openai → deepseek): vendor_changed, recorded; the observation is cached, so the
  // next admission refuses synchronously.
  let mark = before();
  fakes.observed.bravo = seen("deepseek");
  const changed = await turn(app, id, "b2 would carry a2", "b2");
  unchanged(changed, "RELAY_CONSENT_REQUIRED", mark);
  const recorded = events(w.store, id).findLast(row => row.type === "relay.vendor_changed")!;
  assert.deepEqual({ ...recorded.data }, { harnessId: "bravo", controlId: "bravo-acp", from: "openai", to: "deepseek", observedInRun: changed.id });
  assert.deepEqual(relayOf(app.read(id), "bravo").vendorObserved, seen("deepseek"));
  assert.equal(refusedAt(app, fakes, id, "b3 would carry a2", "b3"), "RELAY_CONSENT_REQUIRED{vendor_changed}", "the next admission already knows");
  // The user's consent to the new vendor, in this request, settles it: the packet goes and the epoch's key follows.
  const agreed = await turn(app, id, "b3 carries a2", "b3b", { consent: { vendor: "deepseek" as VendorKey, decision: "acknowledged", scope: "session" } });
  assert.equal(agreed.status, "completed"); assert.equal(relayOf(app.read(id), "bravo").consentKey, "deepseek");
  // A refined window: the observed model's window (relay_windows, 16k) is smaller than admission's (assumed): min_packet at the open.
  await to(app, id, "alpha", "to-a2"); assert.equal((await turn(app, id, "a3", "a3")).status, "completed"); await to(app, id, "bravo", "to-b2");
  w.store.upsertWindow({ harnessId: "bravo", controlId: "bravo-acp", modelKey: "small", size: 16_000, firstTurnUsed: null, observedAt: NOW });
  mark = before(); fakes.observed.bravo = seen("deepseek", "small");
  unchanged(await turn(app, id, "b4 would carry a3", "b4"), "RELAY_INPUT_LIMIT", mark);
  // The observation is cached with the failed Turn: the next admission already reads the small window.
  assert.equal(refusedAt(app, fakes, id, "b4 again", "b4-again"), "RELAY_INPUT_LIMIT{min_packet}");
  fakes.observed.bravo = seen("deepseek");
  assert.equal((await turn(app, id, "b4 alone, the model changed back", "b4-alone", { attach: "none" })).status, "completed");
  // A connection whose own declaration is unprobed while the factory's says probed: the open's probe gate holds.
  fakes.own.bravo = declared({ probed: false });
  mark = before();
  unchanged(await turn(app, id, "b5 would carry a3", "b5"), "RELAY_TARGET_UNVERIFIED", mark);
  delete fakes.own.bravo;
  assert.equal((await turn(app, id, "b6 carries a3", "b6")).status, "completed", "the next Turn resumes the kept native session and carries it");
  assert.equal(fakes.opens.filter(row => row.harnessId === "bravo").at(-1)!.checkpoint, mark.checkpoint);
});

test("G072-C04/C7 a reading that changed between admission and the open fails the Run before dispatch (classification_changed) only when it matters: a definite command admission skipped that the catalog reads as content and that would carry; a command that owes nothing goes", async t => {
  // The static reading says every slash word is a command; the catalog lists only its own commands.
  const reading: RelayCapabilities["commands"]["classify"] = (text, catalog, attachments) => text.startsWith("/") && catalog === null ? { kind: "command", name: text.slice(1).split(" ")[0]!, args: "", effect: "keep" } : sharedClassify(text, catalog, attachments);
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ classify: reading }) }, "bravo");
  fakes.observed.bravo = seen("openai"); consent(w.store, id, "unknown:bravo"); consent(w.store, null, "openai");
  const failed = await turn(app, id, "/notlisted carries a1", "b1");
  assert.equal(failed.status, "failed"); assert.equal(failed.error?.code, "RELAY_PREPARE_FAILED"); assert.equal(eventOf(w.store, id, "run.ended", failed.id)?.data.relay && (eventOf(w.store, id, "run.ended", failed.id)!.data.relay as { reason?: string }).reason, "classification_changed");
  assert.equal(fakes.to("bravo").length, 0, "nothing was sent");
  // Once nothing is owed, the same change goes as typed (content, nothing to carry).
  assert.equal((await turn(app, id, "b2 carries a1", "b2")).status, "completed");
  assert.equal((await turn(app, id, "/notlisted now", "b3")).status, "completed");
  assert.equal(fakes.to("bravo").at(-1)!.text, "/notlisted now");
});

test("G072-C7 the Runtime reads an input by the Driver's declaration: a command whose arguments become a prompt (acceptsRelay, a skill) is a content Turn that carries what is owed; a plain command carries nothing", async t => {
  const skills: RelayCapabilities["commands"]["classify"] = (text, catalog, attachments) => {
    const reading = sharedClassify(text, catalog, attachments);
    return reading.kind === "command" && reading.name.startsWith("skill:") ? { ...reading, acceptsRelay: true } : reading;
  };
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared({ classify: skills }) }, "bravo");
  fakes.observed.bravo = seen("openai"); consent(w.store, id, "unknown:bravo"); consent(w.store, null, "openai"); consent(w.store, null, "anthropic");
  const skill = await turn(app, id, "/skill:review the change", "b1");
  assert.equal(skill.status, "completed"); assert.deepEqual(skill.sourceRunIds, [a1.id]);
  const sent = fakes.to("bravo").at(-1)!;
  assert.equal(typeof sent.turn === "object" && sent.turn.user, "/skill:review the change", "the packet went with the skill's words");
  assert.equal(eventOf(w.store, id, "run.native_command", skill.id), undefined, "no native command recorded for it");
  await to(app, id, "alpha", "to-a"); await turn(app, id, "a2", "a2"); await to(app, id, "bravo", "to-b");
  const compact = await turn(app, id, "/compact", "b2");
  assert.equal(compact.status, "completed"); assert.equal(fakes.to("bravo").at(-1)!.text, "/compact", "a plain command as typed");
  assert.notEqual(eventOf(w.store, id, "run.native_command", compact.id), undefined);
});

test("G072-C05 a queued input's admission is done again before it starts (prePlan): a consent withdrawn, or the probe gate closed, while it waited fails it with the same code before any program starts", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ probed: false }) }, "bravo");
  w.store.setPref("relay.allowUnprobed", "true");
  fakes.observed.bravo = seen("openai"); consent(w.store, id, "unknown:bravo"); consent(w.store, id, "openai");
  fakes.hold = true;
  app.send(id, "b0 alone holds", "b0", [], { attach: "none" });
  for (let i = 0; i < 200 && fakes.held.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const queued = app.send(id, "b1 queued, would carry a1", "b1");
  consent(w.store, id, "openai", "revoked");
  const prepared = fakes.prepared;
  fakes.hold = false; fakes.release(); await app.wait(id);
  const failed = app.read(id).runs.find(row => row.id === queued.runId)!;
  assert.equal(failed.status, "failed"); assert.equal(failed.error?.code, "RELAY_CONSENT_REQUIRED"); assert.equal(failed.timing?.dispatchedAt, undefined);
  assert.equal(fakes.prepared, prepared, "no program started for it");
  assert.equal(failed.relay?.continuity.kind, "blocked");
  // The probe gate closed while an input waited.
  consent(w.store, id, "openai");
  fakes.hold = true;
  app.send(id, "b2 alone holds", "b2", [], { attach: "none" });
  for (let i = 0; i < 200 && fakes.held.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const second = app.send(id, "b3 queued, would carry a1", "b3");
  w.store.setPref("relay.allowUnprobed", "false");
  fakes.hold = false; fakes.release(); await app.wait(id);
  assert.equal(app.read(id).runs.find(row => row.id === second.runId)!.error?.code, "RELAY_TARGET_UNVERIFIED");
});

test("G072-C07 A→B→A (§7.3): the return continues A's native session with a delta of B's Turns by default; relay.native \"new\" archives it and opens a new one with the whole packet; never while a Turn runs (the installation's defaults)", async t => {
  const { w, fakes, app, id, a1 } = await fromAlpha(t, { bravo: declared() }, "bravo", { strict: false });
  fakes.observed.bravo = seen("openai");
  const b1 = await turn(app, id, "b1 carries a1", "b1");
  await to(app, id, "alpha", "to-a");
  const alphaSession = app.read(id).nativeBindings!.find(row => row.harnessId === "alpha" && row.status !== "archived")!.checkpoint;
  const a2 = await turn(app, id, "a2 continues alpha", "a2");
  assert.equal(a2.status, "completed"); assert.deepEqual(a2.sourceRunIds, [b1.id], "only bravo's Turn is owed");
  assert.equal(fakes.opens.filter(row => row.harnessId === "alpha").at(-1)!.checkpoint, alphaSession, "the original native session continued");
  assert.equal(a2.relay?.kind, "delta");
  assert.equal(eventOf(w.store, id, "run.context_prepared", a2.id)?.data.returnChoice, "continue");
  // Back on bravo and again to alpha, this time a new native session with the whole packet.
  await to(app, id, "bravo", "to-b2"); const b2 = await turn(app, id, "b2", "b2"); await to(app, id, "alpha", "to-a2");
  const renewed = await turn(app, id, "a3 in a new native session", "a3", { native: "new" });
  assert.equal(renewed.status, "completed");
  assert.equal(fakes.opens.filter(row => row.harnessId === "alpha").at(-1)!.checkpoint, undefined, "a new native session");
  const alphas = app.read(id).nativeBindings!.filter(row => row.harnessId === "alpha");
  assert.deepEqual(alphas.map(row => row.status), ["archived", "ready"]);
  assert.equal(alphas[1]!.relay!.nativeEpoch, alphas[0]!.relay!.nativeEpoch + 1);
  assert.equal(renewed.relay?.kind, "packet"); assert.deepEqual(renewed.sourceRunIds, [a1.id, b1.id, a2.id, b2.id], "the new session holds nothing: every earlier Turn");
  assert.equal(events(w.store, id).some(row => row.type === "native.branch_requested" && row.data.by === "relay.native"), true);
  assert.equal(renewed.relayRequest?.native, "new");
  // Never while a Turn runs.
  fakes.hold = true;
  app.send(id, "a4 holds", "a4", [], { attach: "none" });
  assert.throws(() => app.send(id, "a5 new", "a5", [], { native: "new" }), (error: unknown) => error instanceof SessionError && error.code === "NATIVE_SESSION_BUSY");
  fakes.hold = false; fakes.release(); await app.wait(id);
});

test("G072 the native title (§8.1, VF3-12): a session a handoff opened is named before its first prompt when its Driver declares title \"set\", with the conversation's first words (\"新对话\" when they hold a secret), recorded as relay.title_set; a refusal never fails the Turn", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared({ title: "set" }), charlie: declared({ title: "set" }), delta: declared() }, "bravo", { strict: false });
  for (const harness of ["bravo", "charlie", "delta"]) fakes.observed[harness] = seen("openai");
  const b1 = await turn(app, id, "b1 carries a1", "b1");
  assert.deepEqual(fakes.titles, [{ harnessId: "bravo", title: "a1 a fact on alpha" }]);
  assert.equal(eventOf(w.store, id, "relay.title_set", b1.id)?.data.result, "set");
  assert.equal((await turn(app, id, "b2", "b2")).status, "completed"); assert.equal(fakes.titles.length, 1, "only a session the handoff opened");
  fakes.titleFails = true; await to(app, id, "charlie", "to-c");
  const c1 = await turn(app, id, "c1 carries", "c1");
  assert.equal(c1.status, "completed"); assert.equal(eventOf(w.store, id, "relay.title_set", c1.id)?.data.result, "refused");
  fakes.titleFails = false; await to(app, id, "delta", "to-d");
  assert.equal((await turn(app, id, "d1 carries", "d1")).status, "completed"); assert.equal(fakes.titles.length, 1, "a Driver declaring none is not named");
  // First words the egress scan would redact never become a native title (§8.1): "新对话" instead. The key is built in parts.
  const other = world(t, false), named = new Fakes({ alpha: declared(), bravo: declared({ title: "set" }) });
  named.observed.alpha = seen("anthropic"); named.observed.bravo = seen("openai");
  const app2 = other.runtime(named), id2 = (await app2.create(other.configuration, { harnessId: "alpha" }, "create")).id;
  await turn(app2, id2, "use " + "sk-" + "ant-" + "api03-" + "Q".repeat(24) + "x9" + "Z".repeat(30) + " for the test", "a1"); await to(app2, id2, "bravo", "to-b");
  assert.equal((await turn(app2, id2, "b1 carries a1", "b1")).status, "completed");
  assert.deepEqual(named.titles, [{ harnessId: "bravo", title: "新对话" }]);
});

test("G072 relay-keys in the rows (A17, INV-29): delivery rows and the request's fingerprint are keyed under the installation key the composition gives — never \"ephemeral\" — and the HMACs differ per Session", async t => {
  const root = temporary(t), keys = RelayKeys.open(join(root, "keys", "relay-key")).keys;
  const { w, fakes, app, id } = await (async () => {
    const w = world(t), fakes = new Fakes({ alpha: declared(), bravo: declared() }); fakes.observed.alpha = seen("anthropic"); fakes.observed.bravo = seen("openai");
    const app = w.runtime(fakes, { keys }), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
    await turn(app, id, "a1", "a1"); await to(app, id, "bravo", "to-b");
    return { w, fakes, app, id };
  })();
  consent(w.store, null, "openai");
  const b1 = await turn(app, id, "b1 carries a1", "b1", { consent: { vendor: "unknown:bravo" as VendorKey, decision: "acknowledged", scope: "session" } });
  assert.equal(b1.status, "completed");
  const row = w.store.relayDeliveries(id).find(item => item.runId === b1.id)!;
  assert.equal(row.redaction.keyId, keys.keyId); assert.notEqual(row.redaction.keyId, "ephemeral");
  assert.equal(row.inputHmac, keys.inputHmac(id, "b1 carries a1"));
  assert.notEqual(row.inputHmac, keys.inputHmac("session-other" as SessionId, "b1 carries a1"), "a subkey per Session");
  assert.equal(b1.relayRequest?.fingerprint, keys.requestFingerprint(id, JSON.stringify({ consent: { vendor: "unknown:bravo", decision: "acknowledged", scope: "session" } })));
  assert.equal(fakes.to("bravo").length, 1);
  assert.equal(JSON.stringify(app.read(id)).includes(createHash("sha256").update("b1 carries a1").digest("hex")), false, "no unsalted digest of the input anywhere in the snapshot");
});

test("G072-C10 a crash in the middle of a carrying Turn (the owner ends with the packet dispatched): recovery leaves its row unknown{owner_ended} and the binding pending; the consent the request gave stays in the installation's log; the next owner goes on", async t => {
  const { w, fakes, app, id } = await fromAlpha(t, { bravo: declared() }, "bravo");
  fakes.observed.bravo = seen("openai"); const openai = consent(w.store, null, "openai");
  fakes.hold = true;
  const carried = app.send(id, "b1 carries a1", "b1", [], { consent: { vendor: "unknown:bravo" as VendorKey, decision: "acknowledged", scope: "session" } });
  for (let i = 0; i < 200 && fakes.held.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const logged = w.store.relayConsents().filter(record => record.vendor === "unknown:bravo");
  assert.equal(logged.length, 1); assert.equal(events(w.store, id).filter(row => row.type === "relay.consent_recorded").length, 1, "mirrored once");
  // The owner ends without closing (a crash): the Store is closed under it.
  w.store.close();
  w.store = new SqliteSessionStore(w.data, { recoverRelay });
  const recovered = w.store.get(id), row = w.store.relayDeliveries(id).find(item => item.runId === carried.runId)!;
  assert.equal(row.outcome.kind, "unknown"); assert.equal(row.outcome.kind === "unknown" && row.outcome.reason, "owner_ended");
  assert.equal(relayOf(recovered, "bravo").sync.kind, "pending");
  // The request consented to what admission could tell (unknown:bravo); the open saw openai, whose consent the dispatch rests on.
  assert.equal(row.consentLogSeq, openai, "the row names the consent its dispatch rested on");
  assert.deepEqual(w.store.relayConsents().filter(record => record.vendor === "unknown:bravo").map(record => record.logSeq), [logged[0]!.logSeq], "the log kept it");
  assert.equal(typeof recovered.runs.find(run => run.id === carried.runId)!.relayRequest?.fingerprint, "string", "the request's options are kept with the Run");
  fakes.hold = false; fakes.release();
});

test("G072 the Claude Driver maps claude-agent-acp's \"no such session\" (-32002 on session/load) to NATIVE_SESSION_NOT_FOUND, so the Runtime's empty-session fallback (C5) reads it; nothing else is mapped", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_UNPROMPTED_LOAD: "1" });
  const ahead = driver(t, "claude", peer); await ahead.initialize();
  const unprompted = await ahead.open(peer.workspace); await ahead.close();
  const other = driver(t, "claude", peer); await other.initialize();
  await assert.rejects(other.open(peer.workspace, undefined, undefined, unprompted), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_NOT_FOUND");
  // A session the native side has (prompted) is loaded as before; a refusal of another kind keeps its own code.
  const garbage = await peerRoot(t, { RELAY_LOAD_FAULT: "garbage" });
  const first = driver(t, "claude", garbage); await first.initialize(); const id = await first.open(garbage.workspace);
  await first.close();
  const second = driver(t, "claude", garbage); await second.initialize();
  await assert.rejects(second.open(garbage.workspace, undefined, undefined, id), (error: unknown) => error instanceof ControlError && error.code !== "NATIVE_SESSION_NOT_FOUND");
});

test("G072 step one (A8): the Gateway's own binding factory answers each selection's static declaration synchronously, without starting anything — by the built-in catalog's protocol of the control — and null for a Driver that declares none, a control it cannot place and a managed Provider", t => {
  const root = temporary(t), factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(root, "locks")), () => {}, "any");
  const cases: readonly (readonly [string, string, RelayCapabilities | null])[] = [
    ["claude", "claude-acp-npm", claudeRelayCapabilities], ["codex", "codex-native", codexRelayCapabilities], ["codex", "codex-acp-npm", null],
    ["opencode", "opencode-binary", openCodeRelayCapabilities], ["hermes", "hermes-native", hermesRelayCapabilities], ["openclaw", "openclaw-native", openClawRelayCapabilities],
    ["dsh", "dsh-native", dshRelayCapabilities], ["pi", "pi-native", null], ["cursor", "cursor-binary", null], ["claude", "a-manifest-control", null]];
  for (const [harnessId, controlId, expected] of cases) assert.equal(factory.relayCapabilities({ harnessId, controlId }), expected, harnessId + "/" + controlId);
  assert.equal(factory.relayCapabilities({ harnessId: "codex", controlId: "codex-native", provider: { providerId: "p", model: "m" } as never }), null, "a managed Provider carries no native relay");
});
