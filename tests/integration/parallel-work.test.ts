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
import { SessionError, STREAM_WINDOW_MS, resolveTurnBudgets, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { oldShape } from "../fixtures/old-shape.js";

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
    const lease = this.lease.acquire(configuration.workspace, session, run), env = { LANG: "C.UTF-8", FIXTURE_RESUME_MODELS: "1", FIXTURE_SESSION_ID: "session-fixture-" + session, FIXTURE_THREAD_ID: "thread-fixture-" + session };
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
/** Timers the test fires itself: an ADR-047 window never waits for real time here. */
class ManualTimers {
  private readonly armed = new Map<number, () => void>();
  private count = 0;
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    assert.equal(ms, STREAM_WINDOW_MS, "a window is armed for the contract's window");
    const id = ++this.count; this.armed.set(id, fn); return () => { this.armed.delete(id); };
  };
  get pending(): number { return this.armed.size; }
  /** Runs every timer armed so far, in order, and says how many. */
  fire(): number { const due = [...this.armed.values()]; this.armed.clear(); for (const fn of due) fn(); return due.length; }
}
async function setup(t: test.TestContext, maxParallel?: number, limits: { readonly executionBudgetMs?: number; readonly waitBudgetMs?: number; readonly stopGraceMs?: number; readonly schedule?: (fn: () => void, ms: number) => () => void;
    readonly pacing?: { readonly hintsMs?: readonly number[]; readonly quietMs?: number } } = {},
  scenario?: (session: SessionId) => string) {
  const root = await mkdtemp(join(tmpdir(), "harness-parallel-")), store = appStore(join(root, "data")), factory = new CountingFactory(root, scenario);
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

test("conversations run at once up to an operator's limit, when there is one, and the next starts when one ends", async t => {
  const { app, workspace, until, factory } = await setup(t, 2);
  const sessions: SessionId[] = [];
  for (const name of ["one", "two", "three"]) sessions.push((await app.create(await workspace(name), { harnessId: "alpha" }, "create-" + name)).id);
  for (const [index, id] of sessions.entries()) app.send(id, "approve this", "send-" + index);
  await until(() => app.attention().length === 2);
  assert.deepEqual(app.attention().map(item => item.sessionId).sort(), sessions.slice(0, 2).sort(), "two run at once; the third waits for a slot");
  assert.equal(oldShape(app, sessions[2]!).runs[0]!.status, "queued"); assert.deepEqual(factory.started.length, 2);
  assert.deepEqual(app.slotWait(sessions[2]!) && { running: app.slotWait(sessions[2]!)!.running, limit: app.slotWait(sessions[2]!)!.limit }, { running: 2, limit: 2 }, "the third says that two run");
  await decide(app, sessions[0]!, "allow_once", "decide-0"); await app.wait(sessions[0]!);
  await until(() => app.attention().some(item => item.sessionId === sessions[2]));
  await decide(app, sessions[1]!, "deny", "decide-1"); await decide(app, sessions[2]!, "allow_once", "decide-2");
  for (const id of sessions) await app.wait(id);
  assert.deepEqual(sessions.map(id => oldShape(app, id).runs[0]!.status), ["completed", "completed", "completed"]);
});

test("without a limit every conversation runs at once, however many; none waits for a slot", async t => {
  const { app, workspace, until, factory } = await setup(t);
  const sessions: SessionId[] = [];
  for (let index = 0; index < 7; index++) sessions.push((await app.create(await workspace("many-" + index), { harnessId: "alpha" }, "create-" + index)).id);
  for (const [index, id] of sessions.entries()) app.send(id, "approve this", "send-" + index);
  await until(() => app.attention().length === 7);
  assert.equal(factory.started.length, 7, "all seven started their programs");
  assert.ok(sessions.every(id => app.slotWait(id) === null), "none waits for a slot");
  for (const [index, id] of sessions.entries()) await decide(app, id, "allow_once", "decide-" + index);
  for (const id of sessions) await app.wait(id);
  assert.deepEqual(sessions.map(id => oldShape(app, id).runs[0]!.status), Array(7).fill("completed"));
});

test("conversations that share a workspace all run at once: the Turn that comes second does not wait, and says another conversation is there", async t => {
  const { app, workspace, until, events, factory } = await setup(t);
  const shared = await workspace("shared");
  const holder = await app.create(shared, { harnessId: "alpha" }, "create-holder"), other = await app.create(shared, { harnessId: "alpha" }, "create-other");
  app.send(holder.id, "approve this", "holder-send");
  await until(() => app.attention().length === 1);
  // The holder waits for the user's decision; the other conversation's Turn does not wait for it, in the same directory.
  app.send(other.id, "turn", "other-send");
  await app.wait(other.id);
  const run = oldShape(app, other.id).runs[0]!;
  assert.equal(run.status, "completed"); assert.equal(run.error, null);
  assert.deepEqual(events(other.id, "run.waiting"), [], "it waited for nothing");
  assert.deepEqual(events(other.id, "run.workspace_shared"), [{ runId: run.id, otherSessionIds: [holder.id] }]);
  assert.deepEqual(run.notices?.map(notice => [notice.severity, notice.title]), [["info", "另一个对话也在这个目录里工作"]]);
  assert.match(run.notices![0]!.detail!, /没有让这一轮等它/u);
  assert.equal(factory.started.length, 2, "both programs ran in the directory");
  // The one that was there first is not told: it was not joined by anyone when it started.
  assert.equal(oldShape(app, holder.id).runs[0]!.notices, undefined);
  await decide(app, holder.id, "allow_once", "decide-holder"); await app.wait(holder.id);
  assert.equal(oldShape(app, holder.id).runs[0]!.status, "completed"); assert.equal(oldShape(app, holder.id).runs[0]!.notices, undefined);
});

test("conversations in one workspace start in the order their work was accepted, and each later one is told how many others are there", async t => {
  const { app, workspace, until, events, factory } = await setup(t);
  const shared = await workspace("fifo"), sessions: SessionId[] = [];
  for (const name of ["first", "second", "third", "fourth"]) sessions.push((await app.create(shared, { harnessId: "alpha" }, "create-" + name)).id);
  for (const [index, id] of sessions.entries()) { app.send(id, "approve this", "send-" + index); await until(() => app.attention().length === index + 1); }
  assert.deepEqual(factory.started, sessions, "first accepted, first served");
  const notices = sessions.map(id => oldShape(app, id).runs[0]!.notices?.map(notice => notice.detail) ?? []);
  assert.deepEqual(notices[0], []); assert.match(notices[1]![0]!, /^另一个对话正在/u); assert.match(notices[2]![0]!, /^另外 2 个对话正在/u); assert.match(notices[3]![0]!, /^另外 3 个对话正在/u);
  assert.deepEqual(sessions.map(id => events(id, "run.workspace_shared").map(data => (data.otherSessionIds as string[]).length)), [[], [1], [2], [3]]);
  for (const [index, id] of sessions.entries()) await decide(app, id, "allow_once", "decide-" + index);
  for (const id of sessions) await app.wait(id);
  assert.deepEqual(sessions.map(id => oldShape(app, id).runs[0]!.status), Array(4).fill("completed"));
  // Once they are done, a new Turn of one finds nobody there and is told nothing.
  app.send(sessions[2]!, "turn", "again"); await app.wait(sessions[2]!);
  assert.equal(oldShape(app, sessions[2]!).runs[1]!.notices, undefined);
});

test("a conversation waiting for a slot goes before another conversation's later Turn, in the order they were accepted", async t => {
  const { app, workspace, until, factory } = await setup(t, 1);
  const first = await app.create(await workspace("slot-a"), { harnessId: "alpha" }, "create-a"), second = await app.create(await workspace("slot-b"), { harnessId: "alpha" }, "create-b");
  app.send(first.id, "approve this", "a-1"); await until(() => app.attention().length === 1);
  app.send(second.id, "turn", "b-1"); app.send(first.id, "turn", "a-2");
  await decide(app, first.id, "allow_once", "decide-a");
  for (const id of [first.id, second.id]) await app.wait(id);
  assert.deepEqual(factory.started, [first.id, second.id, first.id], "the slot goes to the work accepted first, not to the conversation that held it");
  assert.deepEqual([...oldShape(app, first.id).runs, ...oldShape(app, second.id).runs].map(run => run.status), ["completed", "completed", "completed"]);
});

test("a Turn waiting for a slot says how many conversations run, can be cancelled, and starts nothing", async t => {
  const { app, workspace, until, events, factory } = await setup(t, 1);
  const first = await app.create(await workspace("slot-one"), { harnessId: "alpha" }, "create-one"), second = await app.create(await workspace("slot-two"), { harnessId: "alpha" }, "create-two");
  app.send(first.id, "approve this", "send-one"); await until(() => app.attention().length === 1);
  app.send(second.id, "turn", "send-two");
  await until(() => app.slotWait(second.id) !== null);
  const waiting = app.slotWait(second.id)!;
  assert.equal(waiting.runId, oldShape(app, second.id).runs[0]!.id); assert.equal(waiting.running, 1); assert.equal(waiting.limit, 1);
  assert.deepEqual(events(second.id, "run.waiting"), [{ runId: waiting.runId, kind: "slot", running: 1 }]);
  app.cancel(second.id, "cancel-two", waiting.runId);
  await until(() => app.slotWait(second.id) === null);
  assert.equal(oldShape(app, second.id).runs[0]!.status, "cancelled"); assert.equal(events(second.id, "run.waiting_ended")[0]?.kind, "slot");
  await decide(app, first.id, "allow_once", "decide-one"); await app.wait(first.id); await app.wait(second.id);
  assert.deepEqual(factory.started, [first.id], "the cancelled Turn never started");
});

test("a stop the Runtime decided stays its reason when the program completes the Turn within the stop grace", async t => {
  const { app, workspace } = await setup(t, undefined, { executionBudgetMs: 300 }, () => "complete-on-cancel");
  const session = await app.create(await workspace("late-complete"), { harnessId: "alpha" }, "create");
  app.send(session.id, "complete late", "send"); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "cancelled"); assert.equal(run.error?.code, "RUN_TIMEOUT");
  assert.equal(run.backend?.status, "completed", "what the program said is kept apart from the Turn's status");
  assert.equal(oldShape(app, session.id).status, "open");
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
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed"); assert.equal(run.error, null);
  assert.deepEqual(events(session.id, "run.waiting").map(data => data.kind), ["user"]);
  const ended = events(session.id, "run.waiting_ended"); assert.equal(ended[0]?.kind, "user"); assert.ok(Number(ended[0]?.waitedMs) >= 850);
});

test("a Turn that works past its execution budget is stopped with the normal stop chain and recorded as cancelled", async t => {
  const { app, workspace, events } = await setup(t, undefined, { executionBudgetMs: 400 }, () => "stop");
  const session = await app.create(await workspace("budget"), { harnessId: "alpha" }, "create");
  app.send(session.id, "work until stopped", "send"); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "cancelled"); assert.equal(run.error?.code, "RUN_TIMEOUT"); assert.equal(run.stopRequested, true);
  assert.equal(run.notices?.at(-1)?.title, "执行期限已到"); assert.deepEqual(events(session.id, "run.budget_expired").map(data => data.kind), ["execution"]);
  assert.equal(oldShape(app, session.id).status, "open");
});

test("a program that does not settle after a stop is ended once the grace has passed, and its Turn is unknown", async t => {
  const { app, workspace } = await setup(t, undefined, { executionBudgetMs: 300, stopGraceMs: 300 }, () => "ignore-cancel");
  const session = await app.create(await workspace("grace"), { harnessId: "alpha" }, "create");
  const started = Date.now();
  app.send(session.id, "ignore the stop", "send");
  await assert.rejects(app.wait(session.id), { code: "SESSION_BLOCKED" });
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "unknown"); assert.equal(run.error?.code, "RUN_TIMEOUT"); assert.ok(Date.now() - started < 5000, "ended by the grace, not by the driver's own timeout");
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
    const run = oldShape(app, session.id).runs[0]!;
    assert.equal(run.status, "completed", JSON.stringify(run.error)); assert.equal(run.error, null);
    assert.deepEqual(events(session.id, "run.waiting").map(data => data.kind), ["user"]); assert.equal(events(session.id, "run.waiting_ended").length, 1);
  });
}

test("ADR-047: four conversations streaming at once each hold their own window, and each window commits only its own conversation's text", async t => {
  const timers = new ManualTimers();
  const { app, workspace, until, events } = await setup(t, undefined, { schedule: timers.schedule }, () => "stop");
  const sessions: SessionId[] = [];
  for (const name of ["one", "two", "three", "four"]) sessions.push((await app.create(await workspace(name), { harnessId: "alpha" }, "create-" + name)).id);
  for (const [index, id] of sessions.entries()) app.send(id, "work until stopped", "send-" + index);
  // Every program streamed its greeting into its own Turn's window; none is committed before its window closes.
  await until(() => timers.pending === 4);
  assert.ok(sessions.every(id => !oldShape(app, id).messages.some(message => message.role === "assistant")), "an open window is not committed");
  assert.deepEqual(sessions.map(id => events(id, "run.output").length), [0, 0, 0, 0]);
  assert.equal(timers.fire(), 4);
  for (const id of sessions) {
    assert.equal(oldShape(app, id).messages.find(message => message.role === "assistant")?.text, "你好 fixture");
    assert.deepEqual(events(id, "run.output").map(data => data.event), [{ type: "text", text: "你好 fixture" }], "one window, with this conversation's text only");
  }
  for (const [index, id] of sessions.entries()) app.cancel(id, "cancel-" + index);
  for (const id of sessions) await app.wait(id);
  assert.deepEqual(sessions.map(id => oldShape(app, id).runs[0]!.status), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  assert.ok(sessions.every(id => oldShape(app, id).messages.find(message => message.role === "assistant")?.text === "你好 fixture"), "the text survives the stop");
});

test("the optional limits are whole numbers at least their minimum, none by default and no largest, and anything else fails before the service starts", () => {
  assert.deepEqual(resolveTurnBudgets(), {}, "no budget and no limit unless given");
  assert.deepEqual(resolveTurnBudgets({ executionSeconds: "30", waitMinutes: "1", maxParallel: "1" }), { executionBudgetMs: 30_000, waitBudgetMs: 60_000, maxParallel: 1 });
  assert.deepEqual(resolveTurnBudgets({ executionSeconds: "36000", waitMinutes: "1440" }), { executionBudgetMs: 36_000_000, waitBudgetMs: 86_400_000 }, "the former largest, 3,600 s and 120 min, are not one");
  assert.deepEqual(resolveTurnBudgets({ executionSeconds: "999999999" }), { executionBudgetMs: 999_999_999_000 });
  for (const input of [{ executionSeconds: "29" }, { executionSeconds: "1.5" }, { executionSeconds: "0" }, { executionSeconds: "-5" }, { executionSeconds: " 60" }, { executionSeconds: "1000000000" },
    { waitMinutes: "0" }, { waitMinutes: "30m" }, { waitMinutes: "" }, { maxParallel: "0" }, { maxParallel: "two" }])
    assert.throws(() => resolveTurnBudgets(input), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT", JSON.stringify(input));
});

test("a Turn has no time wall: without an operator's budget it works as long as it takes, says so at the marks of its working time, and stops only when the user stops it", async t => {
  const { app, workspace, until, events } = await setup(t, undefined, { pacing: { hintsMs: [150, 500], quietMs: 100 } }, () => "stop");
  const session = await app.create(await workspace("no-wall"), { harnessId: "alpha" }, "create");
  app.send(session.id, "work until stopped", "send");
  await until(() => oldShape(app, session.id).runs[0]?.status === "running" && (oldShape(app, session.id).runs[0]?.notices?.length ?? 0) === 2);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "running", "the hints stopped nothing"); assert.equal(run.stopRequested, false);
  assert.deepEqual(run.notices?.map(notice => [notice.severity, notice.title]), [["info", "已运行 150 毫秒，仍在工作"], ["info", "已运行 500 毫秒，仍在工作"]]);
  assert.match(run.notices![0]!.detail!, /不给回合设时间上限/u); assert.match(run.notices![0]!.detail!, /随时点停止/u);
  assert.match(run.notices![1]!.detail!, /没有收到这个 Harness 的任何动静/u, "the Harness has said nothing since its greeting, and the hint says for how long");
  assert.deepEqual(events(session.id, "run.still_working").map(data => data.workedMs), [150, 500]);
  assert.equal(events(session.id, "run.budget_expired").length, 0);
  app.cancel(session.id, "cancel"); await app.wait(session.id);
  const stopped = oldShape(app, session.id).runs[0]!;
  assert.equal(stopped.status, "cancelled"); assert.equal(stopped.error, null, "the user's stop is the only reason; no RUN_TIMEOUT"); assert.equal(oldShape(app, session.id).status, "open");
});

test("a Turn's working time does not run while it waits for the user: no hint comes then, and none after a short Turn", async t => {
  const { app, workspace, until, events } = await setup(t, undefined, { pacing: { hintsMs: [1000] } });
  const session = await app.create(await workspace("hint-pause"), { harnessId: "alpha" }, "create");
  app.send(session.id, "approve this", "send");
  await until(() => app.attention().length === 1);
  // Waiting for the user for more than twice the mark: that time is not working time.
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(oldShape(app, session.id).runs[0]!.notices, undefined); assert.equal(events(session.id, "run.still_working").length, 0);
  await decide(app, session.id, "allow_once", "decide"); await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "completed"); assert.equal(run.notices, undefined, "it worked for well under the mark");
});

test("an approval has no deadline of the Hub's unless an operator set a wait budget: it waits for the user, and a Turn that waits is not cancelled", async t => {
  const { app, workspace, until, events } = await setup(t, undefined, { executionBudgetMs: 400 });
  const session = await app.create(await workspace("no-wait-wall"), { harnessId: "alpha" }, "create");
  app.send(session.id, "approve this", "send");
  await until(() => app.attention().length === 1);
  const waiting = app.attention()[0]!;
  assert.equal(waiting.expiresAt, undefined); assert.equal(waiting.expiresBy, undefined, "no deadline of the Hub's, none of the program's");
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(oldShape(app, session.id).runs[0]!.status, "running", "waiting is not working: the execution budget did not run and no wait budget was set");
  assert.equal(events(session.id, "permission.closed").length, 0);
  await decide(app, session.id, "allow_once", "decide"); await app.wait(session.id);
  assert.equal(oldShape(app, session.id).runs[0]!.status, "completed"); assert.equal(oldShape(app, session.id).runs[0]!.error, null);
});

test("an operator's wait budget expires an approval nobody answered, cancels the Turn, and says so", async t => {
  const { app, workspace, until, events } = await setup(t, undefined, { waitBudgetMs: 400 });
  const session = await app.create(await workspace("wait-budget"), { harnessId: "alpha" }, "create");
  app.send(session.id, "approve this", "send");
  await until(() => app.attention().length === 1);
  assert.equal(app.attention()[0]!.expiresBy, "turn"); assert.ok(app.attention()[0]!.expiresAt! - app.attention()[0]!.requestedAt <= 400);
  await app.wait(session.id);
  const run = oldShape(app, session.id).runs[0]!;
  assert.equal(run.status, "cancelled"); assert.equal(run.error?.code, "WAIT_EXPIRED"); assert.equal(run.notices?.at(-1)?.title, "等待期限已到");
  assert.deepEqual(events(session.id, "run.budget_expired").map(data => data.kind), ["wait"]); assert.deepEqual(app.attention(), []);
});

