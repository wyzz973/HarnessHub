import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type HarnessControl, type NativeCommand, type NativeUsage, type TurnText, type VerifyRequest } from "../../src/contracts/control.js";
import { RelayError, parseVendorKey, type DeliveryPosition, type RelayCapabilities, type RelayKeyPort, type VendorKey, type VendorObservation, type VerifyResult } from "../../src/contracts/relay.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { strictRelay } from "./relay-settings.js";

// Fixture Harnesses and a world of real parts for the relay's policy (permissive-defaults): a real SqliteSessionStore with
// recoverRelay on a temporary data root, the formal SessionRuntime, and in-process fake Harnesses behind a binding factory that
// answers the Drivers' static declarations (relayCapabilities), as the Gateway's own factory does. Each fake keeps a native
// history of the user entries it was given (a prompt appends its flattened text; `/undo` removes the last, `/clear` empties it),
// reads its position before a packet, and answers a check from that history, so what a Harness holds and what the Hub concluded
// can be read side by side. Nothing here runs a Harness.

export const NOW = Date.UTC(2026, 10, 10, 12);
export const CLEAN: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
export function temporary(t: TestContext, prefix = "relay-perm-"): string { const root = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

export interface Declared {
  readonly probed?: boolean; readonly verify?: RelayCapabilities["delivery"]["verify"]; readonly live?: RelayCapabilities["delivery"]["live"]; readonly successProvesRecorded?: boolean;
  readonly lateDelivery?: boolean; readonly execution?: RelayCapabilities["execution"]; readonly maxInput?: RelayCapabilities["placement"]["maxInput"]; readonly window?: RelayCapabilities["window"];
  readonly title?: RelayCapabilities["title"]; readonly compactionEvidence?: RelayCapabilities["compactionEvidence"]; readonly classify?: RelayCapabilities["commands"]["classify"];
}
/**
 * A fake Driver's relay declaration: probed, a process Driver, no way to check, a completed Turn proves the input recorded —
 * unless said otherwise. Its vendor key is read from what it observed (the observation's authKind carries the key, a gateway
 * for an endpoint), so a test can change the vendor a Harness runs on.
 */
export function declared(o: Declared = {}): RelayCapabilities {
  return { ...dshRelayCapabilities, probed: o.probed ?? true, execution: o.execution ?? "process", compactionEvidence: o.compactionEvidence ?? "event",
    delivery: { live: o.live ?? "none", verify: o.verify ?? "none", successProvesRecorded: o.successProvesRecorded ?? true, lateDelivery: o.lateDelivery ?? false },
    commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: o.classify ?? sharedClassify },
    placement: { parts: "single", maxInput: o.maxInput ?? null, pointersAfterUser: true, measure: measureBy("single", o.maxInput?.unit ?? "chars", ["file"]) },
    window: o.window ?? "session_report", title: o.title ?? "none",
    resolveVendor: observed => observed.endpoint !== null ? ("gateway:" + observed.endpoint.host) as VendorKey : observed.authKind === null ? "unknown:fake" as VendorKey : parseVendorKey(observed.authKind) };
}
/** A Driver that can show delivery by a check at the next open and does not prove it from a completed Turn: a send stays unknown until checked. */
export const CHECKING: Declared = { verify: "on_next_open", successProvesRecorded: false };
export function seen(vendor: string, modelKey = ""): VendorObservation { return { model: modelKey || null, modelKey, authKind: vendor, endpoint: null, loopback: false }; }
export function endpoint(host: string, layer: NonNullable<VendorObservation["endpoint"]>["layer"]): VendorObservation { return { model: null, modelKey: "", authKind: null, endpoint: { host, layer }, loopback: false }; }

export const COMMANDS: readonly NativeCommand[] = [{ name: "compact", description: "compact", contextEffect: "compact" }, { name: "clear", description: "clear", contextEffect: "clear" },
  { name: "undo", description: "undo", contextEffect: "rewind" }, { name: "skill:review", description: "skill", contextEffect: "keep" }];

/** How one prompt ends. `result`: the Driver knows it recorded, knows nothing, knows it refused it, loses its connection, or holds until released. */
export interface Script {
  readonly result?: "recorded" | "unrecorded" | "not_recorded" | "lost" | "hold";
  /** false: the native side does not write the prompt (a lost Turn that never arrived). */
  readonly insert?: boolean;
  /**
   * true: the Driver confirms the clear (`native.cleared`) from the native side's own signal, as Hermes' fixed receipt does
   * (`replaced` null). `{ replaced }`: the Driver gave the native session up and opens a new one, as Claude Code's synthesized clear does.
   */
  readonly cleared?: boolean | { readonly replaced: { readonly checkpoint: string | null } };
}
/**
 * In-process fake Harnesses. `declarations[harnessId]` is the Driver's static declaration (null: declares none); `observed` what
 * its Driver reports as its vendor (absent: it has no relayVendor); `usage` what a Turn reports; `script` how a prompt ends;
 * `readable` false makes every check answer unavailable; `hold` keeps a prompt running until `release()`.
 */
export class Fakes implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string; readonly turn: TurnText; readonly session: string }[] = [];
  readonly titles: { readonly harnessId: string; readonly title: string }[] = [];
  readonly opens: { readonly harnessId: string; readonly checkpoint: string | undefined }[] = [];
  readonly observed: Record<string, VendorObservation | null> = {};
  /** Harnesses whose vendor read fails (their Driver's relayVendor rejects), as a read that failed or came late does: the Hub learns nothing at the open. */
  readonly observeFails = new Set<string>();
  readonly usage: Record<string, NativeUsage> = {};
  /** The user entries each native session holds. */
  readonly history = new Map<string, string[]>();
  script: (harnessId: string, input: string) => Script = () => ({});
  readable = true;
  prepared = 0;
  readonly held: (() => void)[] = [];
  /** The prompts a Harness was given as typed (the text, flattened), by Harness. */
  private opened = 0;
  constructor(readonly declarations: Readonly<Record<string, RelayCapabilities | null>>) {}
  /** true: the Hub cannot read the known secrets a packet must hide (RELAY_PREPARE_FAILED, as the factory reports it). */
  secretsFail = false;
  /** The known secrets of the conversation's Harnesses, as the factory reports them (relaySecrets): what a packet and a native title must hide. */
  readonly secrets: string[] = [];
  /** Runs when the Runtime enables permissions: after the Turn's authorization, right before its dispatch. */
  onAuthorized: ((harnessId: string) => void) | null = null;
  relayCapabilities(selection: HarnessSelection): RelayCapabilities | null { return this.declarations[selection.harnessId] ?? null; }
  async relaySecrets(): Promise<readonly string[]> {
    if (this.secretsFail) throw new SessionError("RELAY_PREPARE_FAILED", "没能准备交接单：读取交接单必须隐去的凭据时出错，这条消息没有发出。");
    return this.secrets;
  }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!(request.harnessId in this.declarations)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp", ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }) };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId; this.prepared += 1;
    let session: string | null = null;
    const declaration = this.declarations[harnessId];
    const entries = (): string[] => { const rows = this.history.get(session!) ?? []; this.history.set(session!, rows); return rows; };
    const control: HarnessControl = {
      ...(declaration === null || declaration === undefined ? {} : { relayCapabilities: declaration }),
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { this.opens.push({ harnessId, checkpoint }); session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session, healthy: () => true,
      models: async () => ({ models: [{ id: "model-a", name: "A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: COMMANDS }),
      ...(harnessId in this.observed ? { relayVendor: async () => { if (this.observeFails.has(harnessId)) throw new SessionError("CONTROL_FAILED", "the vendor read failed"); return this.observed[harnessId] ?? null; } } : {}),
      setTitle: async (_id, title) => { this.titles.push({ harnessId, title }); },
      enablePermissions: () => { this.onAuthorized?.(harnessId); },
      deliveryPosition: async (): Promise<DeliveryPosition> => ({ kind: "seq", before: entries().length }),
      verifyDelivered: async (_id, request: VerifyRequest): Promise<VerifyResult> => {
        const rows = entries();
        return { markers: request.markers.map(marker => ({ packetId: marker.packetId,
            result: !this.readable ? "unavailable" as const : rows.slice(marker.position.kind === "seq" ? marker.position.before : 0).some(text => text.includes(marker.packetId)) ? "present" as const : "absent" as const })),
          historyEmpty: this.readable ? rows.length === 0 : null, compaction: null, foreignAfterLast: null, verifyMs: 0 };
      },
      startText: async (_id, turn, output) => {
        const input = typeof turn === "string" ? turn : turn.user, plan = this.script(harnessId, input);
        this.prompts.push({ harnessId, text: singleText(turn), turn, session: session! });
        const rows = entries(), name = /^\/(\S+)/u.exec(input)?.[1];
        if (name === "undo") rows.pop(); else if (name === "clear") rows.length = 0; else if (plan.insert !== false) rows.push(singleText(turn));
        output({ type: "text", text: "reply from " + harnessId });
        if (this.usage[harnessId] !== undefined) output({ type: "usage", usage: this.usage[harnessId]! });
        const extra: Partial<BackendResult> = plan.cleared === true ? { native: { cleared: true, replaced: null } } : plan.cleared ? { native: { cleared: true, replaced: plan.cleared.replaced } } : {};
        let result: Promise<BackendResult>;
        switch (plan.result ?? "recorded") {
          case "recorded": result = Promise.resolve({ status: "completed", reason: "fake", input: "recorded", ...extra }); break;
          case "unrecorded": result = Promise.resolve({ status: "completed", reason: "fake", ...extra }); break;
          case "not_recorded": result = Promise.resolve({ status: "failed", reason: "refused", input: "not_recorded", error: { code: "REMOTE_ERROR", message: "the native side refused the input" } }); break;
          case "lost": result = new Promise<BackendResult>((_resolve, reject) => { setImmediate(() => reject(new SessionError("CONTROL_FAILED", "the connection ended without a result"))); }); break;
          case "hold": result = new Promise<BackendResult>(resolve => { this.held.push(() => resolve({ status: "completed", reason: "fake", input: "recorded" })); }); break;
        }
        return { result, requestStop: async () => { for (const release of this.held.splice(0)) release(); return { requested: true }; } };
      },
      close: async () => CLEAN,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  /** What reached `harnessId`, in order. */
  to(harnessId: string): readonly { readonly text: string; readonly turn: TurnText; readonly session: string }[] { return this.prompts.filter(row => row.harnessId === harnessId); }
  /** How many prompts to `harnessId` carried a relay packet. */
  carried(harnessId: string): number { return this.to(harnessId).filter(row => typeof row.turn === "object").length; }
  release(): void { for (const release of this.held.splice(0)) release(); }
}

export interface World { readonly data: string; store: SqliteSessionStore; readonly configuration: SessionConfiguration; runtime(factory: SessionBindingFactory, options?: { readonly isolated?: boolean; readonly keys?: RelayKeyPort }): SessionRuntime }
/** A world of real parts on a temporary data root. `strict` turns every strict preference on (P9); the default world is the installation's own defaults. */
export function world(t: TestContext, strict = false, prefix = "relay-perm-"): World {
  const root = temporary(t, prefix), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  const runtimes: SessionRuntime[] = [];
  const w: World = { data, store: new SqliteSessionStore(data, { recoverRelay }),
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    runtime(factory, options = {}) {
      let next = 0;
      const app = new SessionRuntime(w.store, factory, { id: () => "perm-" + ++next + "-" + runtimes.length, now: () => new Date(NOW), publish: () => {},
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
export async function turn(app: SessionRuntime, id: SessionId, text: string, key: string, relay?: RelayChoice): Promise<PublicRun> {
  const receipt = app.send(id, text, key, [], relay);
  await app.wait(id).catch((error: unknown) => { if (!(error instanceof SessionError && error.code === "SESSION_BLOCKED")) throw error; });
  return app.read(id).runs.find(row => row.id === receipt.runId)!;
}
export async function to(app: SessionRuntime, id: SessionId, harnessId: string, key: string): Promise<void> {
  app.switch(id, { harnessId }, key); await app.wait(id);
  if (app.read(id).selection.harnessId !== harnessId) throw new Error("the switch to " + harnessId + " did not take effect");
}
export function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
export function eventOf(store: SqliteSessionStore, id: SessionId, type: string, run: string): SessionEvent | undefined {
  return events(store, id).findLast(row => row.type === type && (type === "relay.verified" ? row.data.inRunId : row.data.runId) === run);
}
export function relayOf(state: SessionSnapshot, harnessId: string) { return state.nativeBindings!.find(row => row.harnessId === harnessId && row.status !== "archived")!.relay!; }
/** What a send was refused with ("CODE{reason}"), or "accepted"; a refusal makes no Run and starts no program. */
export function refusedAt(app: SessionRuntime, fakes: Fakes, id: SessionId, text: string, key: string, relay?: RelayChoice): string {
  const runs = app.read(id).runs.length, prepared = fakes.prepared;
  try { app.send(id, text, key, [], relay); }
  catch (error) {
    if (app.read(id).runs.length !== runs || fakes.prepared !== prepared) throw new Error("a refused input made a Run or started a program");
    if (error instanceof RelayError) return error.code + "{" + error.reason + "}";
    if (error instanceof SessionError) return error.code;
    throw error;
  }
  return "accepted";
}
/**
 * alpha (anthropic, can show nothing but a recorded input) with one Turn, a1; then the conversation switched to `target`, which
 * is now owed a1. `declarations` adds the targets; `observed` the vendors they run on.
 */
export async function fromAlpha(t: TestContext, declarations: Readonly<Record<string, RelayCapabilities | null>>, target: string, options: { readonly strict?: boolean; readonly isolated?: boolean; readonly alpha?: RelayCapabilities } = {}) {
  const w = world(t, options.strict ?? false), fakes = new Fakes({ alpha: options.alpha ?? declared(), ...declarations });
  fakes.observed.alpha = seen("anthropic");
  const app = w.runtime(fakes, options.isolated === undefined ? {} : { isolated: options.isolated }), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  const a1 = await turn(app, id, "a1 a fact on alpha", "a1");
  await to(app, id, target, "to-" + target);
  return { w, fakes, app, id, a1 };
}
