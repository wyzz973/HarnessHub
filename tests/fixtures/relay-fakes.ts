import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { nativeConversationId, sharedReading, singleText, type BackendResult, type CleanupEvidence, type HarnessControl, type NativeCommand, type NativeUsage, type TurnText } from "../../src/contracts/control.js";
import type { RelayCapabilities, RelayKeyPort } from "../../src/contracts/relay.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { SessionRuntime, type RelayChoice } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// Fixture Harnesses and a world of real parts for the relay (slim.md): a real SqliteSessionStore with recoverRelay on a
// temporary data root, the formal SessionRuntime, and in-process fake Harnesses behind a binding factory that answers the
// Drivers' static declarations (relayCapabilities), as the Gateway's own factory does. Each fake keeps a native history of the
// user entries it was given (a prompt appends its flattened text; `/undo` removes the last, `/clear` empties it), so what a
// Harness holds and what the Hub concluded can be read side by side. Nothing here runs a Harness.

export const NOW = Date.UTC(2026, 10, 11, 12);
export const CLEAN: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
export function temporary(t: TestContext, prefix = "relay-flow-"): string { const root = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

export interface Declared {
  readonly live?: RelayCapabilities["delivery"]["live"]; readonly successProvesRecorded?: boolean; readonly execution?: RelayCapabilities["execution"];
  readonly maxInput?: RelayCapabilities["placement"]["maxInput"]; readonly title?: RelayCapabilities["title"];
}
/**
 * A fake Driver's relay declaration: a process Driver whose normal end proves the input recorded and that reports nothing live —
 * unless said otherwise. Its commands are read as every native side reads them (the listed ones are commands).
 */
export function declared(o: Declared = {}): RelayCapabilities {
  return { probed: true, delivery: { live: o.live ?? "none", verify: "none", successProvesRecorded: o.successProvesRecorded ?? true, lateDelivery: false }, execution: o.execution ?? "process",
    commands: { unlistedSlash: "text", hidden: [], classify: (text, catalog) => sharedReading(text, catalog === null ? null : (name, args) => {
      const entry = catalog.find(row => row.name === name);
      return entry === undefined ? undefined : { effect: typeof entry.effect === "string" ? entry.effect : entry.effect.byArgs(args) };
    }) },
    placement: { parts: "single", maxInput: o.maxInput ?? null, pointersAfterUser: true, measure: turn => typeof turn === "string" ? [...turn].length : [...turn.relay.body].length + [...turn.user].length + 2 },
    window: "session_report", fixedPrefix: null, cacheTtl: "unknown", compactionEvidence: "none", resolveVendor: () => "unknown:fake", normalizeModel: model => model ?? "", title: o.title ?? "none",
    hostPathRead: "none", sessionTools: null };
}
/** A Driver that reports the input as an event (E1) and whose normal end proves nothing. */
export const LIVE: Declared = { live: "recorded_event", successProvesRecorded: false };
/** A Driver that can never show a delivery: nothing it does confirms an input. */
export const BLIND: Declared = { live: "none", successProvesRecorded: false };

export const COMMANDS: readonly NativeCommand[] = [{ name: "compact", description: "compact", contextEffect: "compact" }, { name: "clear", description: "clear", contextEffect: "clear" },
  { name: "undo", description: "undo", contextEffect: "rewind" }, { name: "skill:review", description: "skill", contextEffect: "keep" }];

/** How one prompt ends. `result`: the Driver knows it recorded, knows nothing, knows it refused it, loses its connection, or holds until released. */
export interface Script {
  readonly result?: "recorded" | "unrecorded" | "not_recorded" | "lost" | "hold";
  /** true: the Driver reports the input as an event (E1) before it answers. */
  readonly live?: boolean;
  /** false: the native side does not write the prompt (a lost Turn that never arrived). */
  readonly insert?: boolean;
  /**
   * true: the Driver confirms the clear (`native.cleared`) in place, as Hermes' fixed receipt does (`replaced` null). `{ replaced }`:
   * the Driver gave the native session up and opens a new one, as Claude Code's synthesized clear does.
   */
  readonly cleared?: boolean | { readonly replaced: { readonly checkpoint: string | null } };
}
/** In-process fake Harnesses. `declarations[harnessId]` is the Driver's static declaration (null: declares none). */
export class Fakes implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string; readonly turn: TurnText; readonly session: string }[] = [];
  readonly titles: { readonly harnessId: string; readonly title: string }[] = [];
  readonly opens: { readonly harnessId: string; readonly checkpoint: string | undefined }[] = [];
  readonly usage: Record<string, NativeUsage> = {};
  /** The user entries each native session holds. */
  readonly history = new Map<string, string[]>();
  script: (harnessId: string, input: string) => Script = () => ({});
  prepared = 0;
  /** Prompts that hold until released: `stop` ends them cancelled (the Turn was stopped), `release` completes them without a word on the input. */
  readonly held: { readonly stop: () => void; readonly release: () => void }[] = [];
  private opened = 0;
  constructor(readonly declarations: Readonly<Record<string, RelayCapabilities | null>>) {}
  /** true: the Hub cannot read the known secrets a packet must hide (RELAY_PREPARE_FAILED, as the factory reports it). */
  secretsFail = false;
  /** Runs when the Runtime enables permissions: after the Turn's authorization, right before its dispatch. */
  onAuthorized: ((harnessId: string) => void) | null = null;
  relayCapabilities(selection: HarnessSelection): RelayCapabilities | null { return this.declarations[selection.harnessId] ?? null; }
  async relaySecrets(): Promise<readonly string[]> {
    if (this.secretsFail) throw new SessionError("RELAY_PREPARE_FAILED", "没能准备交接单：读取交接单必须隐去的凭据时出错，这条消息没有发出。");
    return [];
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
      setTitle: async (_id, title) => { this.titles.push({ harnessId, title }); },
      enablePermissions: () => { this.onAuthorized?.(harnessId); },
      startText: async (_id, turn, output) => {
        const input = typeof turn === "string" ? turn : turn.user, plan = this.script(harnessId, input);
        this.prompts.push({ harnessId, text: singleText(turn), turn, session: session! });
        const rows = entries(), name = /^\/(\S+)/u.exec(input)?.[1];
        if (name === "undo") rows.pop(); else if (name === "clear") rows.length = 0; else if (plan.insert !== false) rows.push(singleText(turn));
        if (plan.live === true) output({ type: "input_recorded", ...(typeof turn === "object" ? { packetId: turn.relay.packetId } : {}) });
        output({ type: "text", text: "reply from " + harnessId });
        if (this.usage[harnessId] !== undefined) output({ type: "usage", usage: this.usage[harnessId]! });
        const extra: Partial<BackendResult> = plan.cleared === true ? { native: { cleared: true, replaced: null } } : plan.cleared ? { native: { cleared: true, replaced: plan.cleared.replaced } } : {};
        let result: Promise<BackendResult>;
        switch (plan.result ?? "recorded") {
          case "recorded": result = Promise.resolve({ status: "completed", reason: "fake", input: "recorded", ...extra }); break;
          case "unrecorded": result = Promise.resolve({ status: "completed", reason: "fake", ...extra }); break;
          case "not_recorded": result = Promise.resolve({ status: "failed", reason: "refused", input: "not_recorded", error: { code: "REMOTE_ERROR", message: "the native side refused the input" } }); break;
          case "lost": result = new Promise<BackendResult>((_resolve, reject) => { setImmediate(() => reject(new SessionError("CONTROL_FAILED", "the connection ended without a result"))); }); break;
          case "hold": result = new Promise<BackendResult>(resolve => { this.held.push({ stop: () => resolve({ status: "cancelled", reason: "stopped" }), release: () => resolve({ status: "completed", reason: "fake" }) }); }); break;
        }
        return { result, requestStop: async () => { for (const held of this.held.splice(0)) held.stop(); return { requested: true }; } };
      },
      close: async () => CLEAN,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  /** What reached `harnessId`, in order. */
  to(harnessId: string): readonly { readonly text: string; readonly turn: TurnText; readonly session: string }[] { return this.prompts.filter(row => row.harnessId === harnessId); }
  /** How many prompts to `harnessId` carried a relay packet. */
  carried(harnessId: string): number { return this.to(harnessId).filter(row => typeof row.turn === "object").length; }
  release(): void { for (const held of this.held.splice(0)) held.release(); }
  /** Resolves when `count` prompts reached `harnessId` (a held Turn is then running). */
  async reached(harnessId: string, count: number): Promise<void> { for (let tries = 0; tries < 2000 && this.to(harnessId).length < count; tries++) await new Promise(resolve => setTimeout(resolve, 5)); }
}

export interface World { readonly data: string; store: SqliteSessionStore; readonly configuration: SessionConfiguration; runtime(factory: SessionBindingFactory, options?: { readonly keys?: RelayKeyPort }): SessionRuntime }
/** A world of real parts on a temporary data root. */
export function world(t: TestContext, prefix = "relay-flow-"): World {
  const root = temporary(t, prefix), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  const runtimes: SessionRuntime[] = [];
  const w: World = { data, store: new SqliteSessionStore(data, { recoverRelay }),
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    runtime(factory, options = {}) {
      let next = 0;
      const app = new SessionRuntime(w.store, factory, { id: () => "flow-" + ++next + "-" + runtimes.length, now: () => new Date(NOW), publish: () => {},
        fingerprint: value => createHash("sha256").update(value).digest("hex"), ...(options.keys === undefined ? {} : { relayKeys: options.keys }) });
      runtimes.push(app); return app;
    } };
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
  return events(store, id).findLast(row => row.type === type && row.data.runId === run);
}
/** The relay state of the active binding of a Harness. */
export function relayOf(state: SessionSnapshot, harnessId: string) { return state.nativeBindings!.find(row => row.harnessId === harnessId && row.status !== "archived")!.relay!; }
/** The relay decision a Turn recorded (`run.context_prepared.data.relay.decision`), or undefined when it recorded none. */
export function decisionOf(store: SqliteSessionStore, id: SessionId, run: string): Record<string, unknown> | undefined {
  const relay = eventOf(store, id, "run.context_prepared", run)?.data.relay as Record<string, unknown> | undefined;
  return relay?.decision as Record<string, unknown> | undefined;
}
/**
 * alpha with one Turn, a1; then the conversation switched to `target`, which is now owed a1. `declarations` adds the targets.
 */
export async function fromAlpha(t: TestContext, declarations: Readonly<Record<string, RelayCapabilities | null>>, target: string, options: { readonly alpha?: RelayCapabilities } = {}) {
  const w = world(t), fakes = new Fakes({ alpha: options.alpha ?? declared(), ...declarations });
  const app = w.runtime(fakes), id = (await app.create(w.configuration, { harnessId: "alpha" }, "create")).id;
  const a1 = await turn(app, id, "a1 a fact on alpha", "a1");
  await to(app, id, target, "to-" + target);
  return { w, fakes, app, id, a1 };
}
