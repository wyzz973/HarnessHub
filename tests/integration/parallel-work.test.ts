import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { PiControl } from "../../src/adapters/control/pi.js";
import type { CleanupEvidence } from "../../src/contracts/control.js";
import { SessionError, resolveTurnBudgets, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const piPeer = fileURLToPath(new URL("../../../tests/fixtures/pi-rpc-peer.mjs", import.meta.url));

/** Hermes-like ACP fixture processes (they ask before "approve" commands) behind real workspace leases; every start is counted. */
class CountingFactory implements SessionBindingFactory {
  readonly started: string[] = [];
  private readonly lease: SqliteWorkspaceLeaseProvider;
  /** `scenario` per conversation creation order: "hermes" asks before "approve" commands, "stop" works until it is stopped. */
  constructor(root: string, private readonly scenario: (session: SessionId) => string = () => "hermes") { this.lease = new SqliteWorkspaceLeaseProvider(join(root, "leases")); }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: "alpha", controlId: "alpha-acp" };
  }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    const lease = this.lease.acquire(configuration.workspace, session, run), env = { LANG: "C.UTF-8", FIXTURE_RESUME_MODELS: "1" };
    this.started.push(session);
    // "codex:<scenario>" and "pi:<scenario>" run the other two drivers against their fixtures; anything else is ACP.
    const scenario = this.scenario(session), options = { cwd: configuration.workspace, env, requestTimeoutMs: 2000, runTimeoutMs: 20_000, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 };
    const control = scenario.startsWith("codex:") ? new CodexControl({ protocol: "codex-app-server", executable: process.execPath, args: [peer, "codex-app-server", scenario.slice(6)], env }, options)
      : scenario.startsWith("pi:") ? new PiControl({ protocol: "pi-rpc", executable: process.execPath, args: [piPeer, scenario.slice(3)], env }, options)
      : new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [peer, "acp-v1", scenario], env }, options);
    let close: Promise<CleanupEvidence> | null = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence: CleanupEvidence | null = null; try { evidence = await control.close(); return evidence; } finally { lease.release(evidence?.closed === true); } })();
      return close;
    } };
  }
}
async function setup(t: test.TestContext, maxParallel?: number, limits: { readonly executionBudgetMs?: number; readonly waitBudgetMs?: number; readonly stopGraceMs?: number } = {},
  scenario?: (session: SessionId) => string) {
  const root = await mkdtemp(join(tmpdir(), "harness-parallel-")), store = new SqliteSessionStore(join(root, "data")), factory = new CountingFactory(root, scenario);
  let id = 0, clock = 1_791_000_000_000;
  const app = new SessionRuntime(store, factory, { id: () => "par-" + String(++id), now: () => new Date(clock += 1), publish: () => {},
    fingerprint: value => createHash("sha256").update(value).digest("hex"), ...(maxParallel === undefined ? {} : { maxParallel }), ...limits });
  t.after(async () => { try { await app.close(); } finally { store.close(); await rm(root, { recursive: true, force: true }); } });
  const workspace = async (name: string): Promise<SessionConfiguration> => {
    const path = join(root, name); await mkdir(path, { recursive: true });
    return { workspace: path, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  };
  const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check(), "condition not reached"); };
  const events = (session: SessionId, type: string) => store.events(session, 0).filter(event => event.type === type).map(event => event.data as Record<string, unknown>);
  return { store, factory, app, workspace, until, events };
}
const decide = async (app: SessionRuntime, session: SessionId, option: string, key: string) => {
  const [request] = app.permissionRequests(session); assert.ok(request !== undefined, "a request waits"); await app.decidePermission(session, request.id, option, key);
};

test("conversations in different workspaces run at once, up to the limit, and the next starts when one ends", async t => {
  const { app, workspace, until, factory } = await setup(t, 2);
  const sessions: SessionId[] = [];
  for (const name of ["one", "two", "three"]) sessions.push((await app.create(await workspace(name), { harnessId: "alpha" }, "create-" + name)).id);
  for (const [index, id] of sessions.entries()) app.send(id, "approve this", "send-" + index);
  await until(() => app.attention().length === 2);
  assert.deepEqual(app.attention().map(item => item.sessionId).sort(), sessions.slice(0, 2).sort(), "two run at once; the third waits for a slot");
  assert.equal(app.read(sessions[2]!).runs[0]!.status, "queued"); assert.deepEqual(factory.started.length, 2);
  await decide(app, sessions[0]!, "allow_once", "decide-0"); await app.wait(sessions[0]!);
  await until(() => app.attention().some(item => item.sessionId === sessions[2]));
  await decide(app, sessions[1]!, "deny", "decide-1"); await decide(app, sessions[2]!, "allow_once", "decide-2");
  for (const id of sessions) await app.wait(id);
  assert.deepEqual(sessions.map(id => app.read(id).runs[0]!.status), ["completed", "completed", "completed"]);
});

test("a Turn waits, visibly, while another conversation's Turn holds their workspace, and starts once it ends", async t => {
  const { app, workspace, until, events, factory } = await setup(t);
  const shared = await workspace("shared");
  const holder = await app.create(shared, { harnessId: "alpha" }, "create-holder"), waiting = await app.create(shared, { harnessId: "alpha" }, "create-waiting");
  app.send(holder.id, "approve this", "holder-send");
  await until(() => app.attention().length === 1);
  app.send(waiting.id, "turn", "waiting-send");
  await until(() => app.queueState(waiting.id) !== null);
  const queued = app.queueState(waiting.id)!;
  assert.equal(queued.holderSessionId, holder.id); assert.equal(queued.holderWaitsForUser, true, "the holder waits for the user's decision");
  assert.equal(queued.runId, app.read(waiting.id).runs[0]!.id); assert.equal(app.read(waiting.id).runs[0]!.status, "queued");
  assert.deepEqual(events(waiting.id, "run.waiting"), [{ runId: queued.runId, kind: "workspace", holderSessionId: holder.id }]);
  assert.equal(factory.started.filter(id => id === waiting.id).length, 0, "the waiting Turn starts nothing");
  await decide(app, holder.id, "allow_once", "decide-holder");
  await app.wait(waiting.id);
  assert.equal(app.read(waiting.id).runs[0]!.status, "completed"); assert.equal(app.queueState(waiting.id), null);
  const ended = events(waiting.id, "run.waiting_ended");
  assert.equal(ended.length, 1); assert.equal(ended[0]!.kind, "workspace"); assert.ok(Number(ended[0]!.waitedMs) >= 0);
});

test("a waiting Turn can be cancelled, and conversations sharing a workspace take it in the order their work was accepted", async t => {
  const { app, workspace, until, events, factory } = await setup(t);
  const shared = await workspace("fifo");
  const holder = await app.create(shared, { harnessId: "alpha" }, "create-holder");
  const first = await app.create(shared, { harnessId: "alpha" }, "create-first"), second = await app.create(shared, { harnessId: "alpha" }, "create-second");
  const cancelled = await app.create(shared, { harnessId: "alpha" }, "create-cancelled");
  app.send(holder.id, "approve this", "holder-send"); await until(() => app.attention().length === 1);
  app.send(first.id, "turn", "first-send"); app.send(second.id, "turn", "second-send"); app.send(cancelled.id, "turn", "cancelled-send");
  await until(() => [first.id, second.id, cancelled.id].every(id => app.queueState(id) !== null));
  // Cancelling the waiting Turn names it: no Turn of that conversation is active yet.
  app.cancel(cancelled.id, "cancel-waiting", app.queueState(cancelled.id)!.runId);
  await until(() => app.queueState(cancelled.id) === null);
  assert.equal(app.read(cancelled.id).runs[0]!.status, "cancelled"); assert.equal(events(cancelled.id, "run.waiting_ended").length, 1);
  await decide(app, holder.id, "allow_once", "decide-holder");
  for (const id of [first.id, second.id]) await app.wait(id);
  assert.deepEqual(factory.started.filter(id => id !== holder.id), [first.id, second.id], "first accepted, first served");
  assert.equal(factory.started.includes(cancelled.id), false);
});

test("a conversation waiting for a slot goes before another conversation's later Turn, in the order they were accepted", async t => {
  const { app, workspace, until, factory } = await setup(t, 1);
  const first = await app.create(await workspace("slot-a"), { harnessId: "alpha" }, "create-a"), second = await app.create(await workspace("slot-b"), { harnessId: "alpha" }, "create-b");
  app.send(first.id, "approve this", "a-1"); await until(() => app.attention().length === 1);
  app.send(second.id, "turn", "b-1"); app.send(first.id, "turn", "a-2");
  await decide(app, first.id, "allow_once", "decide-a");
  for (const id of [first.id, second.id]) await app.wait(id);
  assert.deepEqual(factory.started, [first.id, second.id, first.id], "the slot goes to the work accepted first, not to the conversation that held it");
  assert.deepEqual([...app.read(first.id).runs, ...app.read(second.id).runs].map(run => run.status), ["completed", "completed", "completed"]);
});

test("a Turn's execution budget pauses while it waits for the user, and its wait is recorded", async t => {
  const { app, workspace, until, events } = await setup(t, undefined, { executionBudgetMs: 400, waitBudgetMs: 10_000 });
  const session = await app.create(await workspace("pause"), { harnessId: "alpha" }, "create");
  app.send(session.id, "approve this", "send");
  await until(() => app.attention().length === 1);
  // Waiting longer than the whole execution budget: it is paused, so the Turn goes on once the user decides.
  await new Promise(resolve => setTimeout(resolve, 900));
  await decide(app, session.id, "allow_once", "decide");
  await app.wait(session.id);
  const run = app.read(session.id).runs[0]!;
  assert.equal(run.status, "completed"); assert.equal(run.error, null);
  assert.deepEqual(events(session.id, "run.waiting").map(data => data.kind), ["user"]);
  const ended = events(session.id, "run.waiting_ended"); assert.equal(ended[0]?.kind, "user"); assert.ok(Number(ended[0]?.waitedMs) >= 850);
});

test("a Turn that works past its execution budget is stopped with the normal stop chain and recorded as cancelled", async t => {
  const { app, workspace, events } = await setup(t, undefined, { executionBudgetMs: 400 }, () => "stop");
  const session = await app.create(await workspace("budget"), { harnessId: "alpha" }, "create");
  app.send(session.id, "work until stopped", "send"); await app.wait(session.id);
  const run = app.read(session.id).runs[0]!;
  assert.equal(run.status, "cancelled"); assert.equal(run.error?.code, "RUN_TIMEOUT"); assert.equal(run.stopRequested, true);
  assert.equal(run.notices?.at(-1)?.title, "执行期限已到"); assert.deepEqual(events(session.id, "run.budget_expired").map(data => data.kind), ["execution"]);
  assert.equal(app.read(session.id).status, "open");
});

test("a program that does not settle after a stop is ended once the grace has passed, and its Turn is unknown", async t => {
  const { app, workspace } = await setup(t, undefined, { executionBudgetMs: 300, stopGraceMs: 300 }, () => "ignore-cancel");
  const session = await app.create(await workspace("grace"), { harnessId: "alpha" }, "create");
  const started = Date.now();
  app.send(session.id, "ignore the stop", "send");
  await assert.rejects(app.wait(session.id), { code: "SESSION_BLOCKED" });
  const run = app.read(session.id).runs[0]!;
  assert.equal(run.status, "unknown"); assert.equal(run.error?.code, "RUN_TIMEOUT"); assert.ok(Date.now() - started < 5000, "ended by the grace, not by the driver's own timeout");
});

test("a Turn that waits for its workspace past its wait budget fails with WORKSPACE_BUSY naming the holder, and is not retried", async t => {
  const { app, workspace, until, events, factory } = await setup(t, undefined, { executionBudgetMs: 20_000, waitBudgetMs: 400 }, session => session === holderId ? "stop" : "hermes");
  let holderId = "" as SessionId;
  const shared = await workspace("shared-busy");
  const holder = await app.create(shared, { harnessId: "alpha" }, "create-holder"); holderId = holder.id;
  const waiting = await app.create(shared, { harnessId: "alpha" }, "create-waiting");
  app.send(holder.id, "work until stopped", "holder-send");
  await until(() => app.read(holder.id).runs[0]?.status === "running");
  app.send(waiting.id, "turn", "waiting-send");
  await app.wait(waiting.id);
  const run = app.read(waiting.id).runs[0]!;
  assert.equal(run.status, "failed"); assert.equal(run.error?.code, "WORKSPACE_BUSY"); assert.equal(app.busyHolderOf(run.id), holder.id);
  assert.equal(events(waiting.id, "run.ended").at(-1)?.holderSessionId, holder.id);
  assert.equal(factory.started.includes(waiting.id), false, "it never started"); assert.equal(app.queueState(waiting.id), null);
  app.cancel(holder.id, "cancel-holder"); await app.wait(holder.id);
});

for (const [driver, scenario, decision] of [["Codex", "codex:permission", "accept"], ["Pi", "pi:ui-confirm", "yes"]] as const) {
  test(`${driver}: the execution budget pauses while its request waits for the user`, async t => {
    const { app, workspace, until, events } = await setup(t, undefined, { executionBudgetMs: 400, waitBudgetMs: 10_000 }, () => scenario);
    const session = await app.create(await workspace(driver.toLowerCase()), { harnessId: "alpha" }, "create");
    app.send(session.id, "ask me", "send");
    await until(() => app.attention().length === 1);
    assert.equal(app.attention()[0]!.expiresBy, "turn"); assert.ok(app.attention()[0]!.expiresAt! - app.attention()[0]!.requestedAt > 9000, "the wait budget, not the execution budget");
    await new Promise(resolve => setTimeout(resolve, 900));
    await decide(app, session.id, decision, "decide");
    await app.wait(session.id);
    const run = app.read(session.id).runs[0]!;
    assert.equal(run.status, "completed", JSON.stringify(run.error)); assert.equal(run.error, null);
    assert.deepEqual(events(session.id, "run.waiting").map(data => data.kind), ["user"]); assert.equal(events(session.id, "run.waiting_ended").length, 1);
  });
}

test("the budgets are whole seconds and minutes within their bounds, and anything else fails before the service starts", () => {
  assert.deepEqual(resolveTurnBudgets(), { executionBudgetMs: 300_000, waitBudgetMs: 1_800_000 });
  assert.deepEqual(resolveTurnBudgets({ executionSeconds: "30", waitMinutes: "120" }), { executionBudgetMs: 30_000, waitBudgetMs: 7_200_000 });
  assert.deepEqual(resolveTurnBudgets({ executionSeconds: "3600", waitMinutes: "1" }), { executionBudgetMs: 3_600_000, waitBudgetMs: 60_000 });
  for (const input of [{ executionSeconds: "29" }, { executionSeconds: "3601" }, { executionSeconds: "1.5" }, { executionSeconds: "0" }, { executionSeconds: "-5" }, { executionSeconds: " 60" },
    { waitMinutes: "121" }, { waitMinutes: "0" }, { waitMinutes: "30m" }, { waitMinutes: "" }])
    assert.throws(() => resolveTurnBudgets(input), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT", JSON.stringify(input));
});

