import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import type { CleanupEvidence } from "../../src/contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { PosixProcessGroups } from "../../src/infrastructure/control/process-group.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const keptOwner = fileURLToPath(new URL("../../../tests/fixtures/kept-owner.mjs", import.meta.url));
const build = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOW = new Date("2026-10-12T00:00:00Z");

/** Real ACP fixture processes behind real workspace leases; every prepared connection is recorded. */
class KeptFactory implements SessionBindingFactory {
  readonly prepared: { readonly run: string; readonly trace: string; readonly pid: string; readonly outsider: string | null; closed: boolean }[] = [];
  private readonly lease: SqliteWorkspaceLeaseProvider;
  /** `outsiders`: each program starts a background task in its own process group, its id written next to its trace. */
  constructor(private readonly root: string, private readonly protocol: "acp-v1" | "codex-app-server" = "acp-v1", private readonly outsiders = false) { this.lease = new SqliteWorkspaceLeaseProvider(join(root, "leases")); }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: "alpha", controlId: "alpha-acp", ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }) };
  }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    const lease = this.lease.acquire(configuration.workspace, session, run);
    const index = this.prepared.length, trace = join(this.root, "trace-" + index + ".ndjson"), pid = join(this.root, "peer-" + index + ".pid");
    const outsider = this.outsiders ? join(this.root, "outsider-" + index + ".pid") : null;
    const entry = { run, trace, pid, outsider, closed: false }; this.prepared.push(entry);
    const env = { FIXTURE_TRACE: trace, FIXTURE_PID: pid, FIXTURE_SESSION_ID: "session-fixture-" + session, FIXTURE_THREAD_ID: "thread-fixture-" + session, FIXTURE_RESUME_MODELS: "1", LANG: "C.UTF-8", ...(outsider === null ? {} : { FIXTURE_OUTSIDER: outsider }) };
    // The Hermes-like ACP fixture declares session/resume and load, and every Codex thread can be resumed, so the native
    // session is confirmed after every Turn.
    const options = { cwd: configuration.workspace, env, requestTimeoutMs: 2000, runTimeoutMs: 5000, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 };
    const control = this.protocol === "acp-v1" ? new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [peer, "acp-v1", "hermes"], env }, options)
      : new CodexControl({ protocol: "codex-app-server", executable: process.execPath, args: [peer, "codex-app-server", "basic"], env }, options);
    let close: Promise<CleanupEvidence> | null = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence: CleanupEvidence | null = null; try { evidence = await control.close(); return evidence; } finally { lease.release(evidence?.closed === true); entry.closed = true; } })();
      return close;
    } };
  }
  releaseAbandonedLease(configuration: SessionConfiguration, session: SessionId): boolean { return this.lease.releaseAbandoned(configuration.workspace, session); }
}
async function setup(t: test.TestContext, keptIdleMs?: number, protocol: "acp-v1" | "codex-app-server" = "acp-v1", keptLimit?: number) {
  const root = await mkdtemp(join(tmpdir(), "harness-kept-process-")), store = appStore(join(root, "data")), factory = new KeptFactory(root, protocol);
  let id = 0;
  const app = new SessionRuntime(store, factory, { id: () => String(++id), now: () => NOW, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"),
    ...(keptIdleMs === undefined ? {} : { keptIdleMs }), ...(keptLimit === undefined ? {} : { keptLimit }) });
  t.after(async () => { try { await app.close(); } finally { store.close(); await rm(root, { recursive: true, force: true }); } });
  const workspace = async (name: string): Promise<SessionConfiguration> => {
    const path = join(root, name); await mkdir(path, { recursive: true });
    return { workspace: path, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  };
  const methods = async (index: number) => (await readFile(factory.prepared[index]!.trace, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { method?: string }).method ?? "");
  const closes = (session: SessionId) => store.events(session, 0).filter(event => event.type === "native.process_closed").map(event => event.data as { reason: string; cleanup: CleanupEvidence | null; backgroundUpdates: number });
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check(), "condition not reached"); };
  return { root, store, factory, app, workspace, methods, closes, until };
}

test("a conversation that keeps its process reuses it for the next Turn, and turning it off closes it with evidence", async t => {
  const { factory, app, workspace, methods, closes } = await setup(t);
  const session = await app.create(await workspace("one"), { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep");
  app.send(session.id, "first", "first"); await app.wait(session.id);
  let state = app.read(session.id);
  const first = state.runs[0]!;
  assert.equal(first.status, "completed"); assert.equal(first.retained, true); assert.equal(first.cleanup, null);
  assert.deepEqual(state.retained, { harnessId: "alpha", controlId: "alpha-acp", runId: first.id, since: NOW.getTime() });
  assert.equal(factory.prepared[0]!.closed, false, "the process is kept, not closed");
  assert.equal(app.keptProcess(session.id)?.harnessId, "alpha");

  app.send(session.id, "second", "second"); await app.wait(session.id);
  state = app.read(session.id);
  const second = state.runs[1]!;
  assert.equal(second.status, "completed"); assert.equal(second.reused, true); assert.equal(second.retained, true);
  assert.equal(factory.prepared.length, 1, "the second Turn does not start the program again");
  const sent = await methods(0);
  assert.equal(sent.filter(method => method === "initialize").length, 1); assert.equal(sent.filter(method => method === "session/prompt").length, 2);
  assert.equal(sent.some(method => method === "session/load"), false, "the live native session is used as it is");
  assert.equal(state.retained?.runId, second.id); assert.equal(state.retained?.since, NOW.getTime());
  assert.equal(state.nativeBindings?.[0]?.status, "ready"); assert.equal(state.nativeBindings?.[0]?.throughRunId, second.id);

  app.setRetention(session.id, false, "release"); await app.wait(session.id);
  state = app.read(session.id);
  assert.equal(state.retained, undefined); assert.equal(state.retainNative, undefined); assert.equal(factory.prepared[0]!.closed, true);
  const [closed] = closes(session.id);
  assert.equal(closed?.reason, "disabled"); assert.equal(closed?.cleanup?.closed, true);
  app.send(session.id, "third", "third"); await app.wait(session.id);
  assert.equal(factory.prepared.length, 2, "without the option every Turn starts the program"); assert.equal(app.read(session.id).runs[2]!.retained, undefined);
  assert.equal(factory.prepared[1]!.closed, true);
});

test("a kept process counts background updates and is closed after its idle time", async t => {
  const { app, workspace, closes, until } = await setup(t, 400);
  const session = await app.create(await workspace("idle"), { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep");
  // The fixture sends one more update after the Turn ended: background activity, counted but never shown as content.
  app.send(session.id, "late tail", "first"); await app.wait(session.id);
  await until(() => (app.keptProcess(session.id)?.backgroundUpdates ?? 0) === 1);
  await until(() => app.read(session.id).retained === undefined);
  const [closed] = closes(session.id);
  assert.equal(closed?.reason, "idle"); assert.equal(closed?.backgroundUpdates, 1); assert.equal(closed?.cleanup?.closed, true);
  assert.equal(app.keptProcess(session.id), null);
});

test("switching, rebuilding, branching, closing and shutting down each close the kept process first", async t => {
  const { factory, app, workspace, closes } = await setup(t);
  const session = await app.create(await workspace("triggers"), { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep");
  const keep = async (key: string) => { app.send(session.id, "turn " + key, key); await app.wait(session.id); assert.notEqual(app.read(session.id).retained, undefined, key); };
  await keep("a");
  app.switch(session.id, { harnessId: "alpha", nativeModel: "deepseek:deepseek-v4-flash" }, "switch"); await app.wait(session.id);
  assert.equal(app.read(session.id).retained, undefined);
  await keep("b");
  app.resetNative(session.id, "reset", app.read(session.id).epoch); await app.wait(session.id);
  assert.equal(app.read(session.id).retained, undefined);
  await keep("c");
  const branch = app.fork(session.id, "branch"); await app.wait(session.id); await app.wait(branch.id);
  assert.equal(app.read(session.id).retained, undefined);
  await keep("d");
  await app.closeSession(session.id, "close");
  assert.equal(app.read(session.id).retained, undefined); assert.equal(app.read(session.id).status, "closed");
  const other = await app.create(await workspace("shutdown"), { harnessId: "alpha" }, "create-other");
  app.setRetention(other.id, true, "keep-other"); app.send(other.id, "turn", "other"); await app.wait(other.id);
  await app.close();
  assert.deepEqual(closes(session.id).map(close => close.reason), ["selection_changed", "native_reset", "branched", "conversation_closed"]);
  assert.deepEqual(closes(other.id).map(close => close.reason), ["gateway_shutdown"]);
  assert.ok([...closes(session.id), ...closes(other.id)].every(close => close.cleanup?.closed === true));
  assert.ok(factory.prepared.every(entry => entry.closed), "no process outlives its owner");
});

test("no fixed number of processes is kept: six conversations each keep theirs", async t => {
  const { factory, app, workspace } = await setup(t);
  const sessions = [];
  for (let index = 0; index < 6; index++) {
    const session = await app.create(await workspace("many-" + index), { harnessId: "alpha" }, "create-" + index);
    app.setRetention(session.id, true, "keep-" + index); app.send(session.id, "turn", "send-" + index); await app.wait(session.id);
    sessions.push(session.id);
  }
  assert.deepEqual(sessions.map(id => app.read(id).retained !== undefined), Array(6).fill(true));
  assert.ok(factory.prepared.every(entry => !entry.closed), "none was closed to make room");
  assert.equal(app.keptProcesses().length, 6);
});

test("an operator's limit on kept processes closes the process of a Turn over it as usual, and the Turn says it was not kept", async t => {
  const { factory, store, app, workspace } = await setup(t, undefined, "acp-v1", 2);
  const sessions = [];
  for (let index = 0; index < 3; index++) {
    const session = await app.create(await workspace("limit-" + index), { harnessId: "alpha" }, "create-" + index);
    app.setRetention(session.id, true, "keep-" + index); app.send(session.id, "turn", "send-" + index); await app.wait(session.id);
    sessions.push(session.id);
  }
  assert.deepEqual(sessions.map(id => app.read(id).retained !== undefined), [true, true, false]);
  assert.equal(factory.prepared[2]!.closed, true);
  assert.deepEqual(store.events(sessions[2]!, 0).filter(event => event.type === "native.retention_skipped").map(event => (event.data as { reason: string }).reason), ["limit"]);
  assert.equal(app.read(sessions[2]!).runs[0]!.cleanup?.closed, true);
  assert.deepEqual(app.read(sessions[2]!).runs[0]!.notices?.map(notice => [notice.severity, notice.title]), [["info", "这一轮的 Harness 进程没有保留"]]);
  assert.match(app.read(sessions[2]!).runs[0]!.notices![0]!.detail!, /已经保留了 2 个/u);
  assert.equal(app.read(sessions[0]!).runs[0]!.notices, undefined, "a Turn that was kept has nothing to say");
});

test("another conversation in the same workspace runs beside a kept process: they share the Gateway's lease and nothing needs ending", async t => {
  const { factory, app, workspace, closes } = await setup(t);
  const shared = await workspace("shared");
  const holder = await app.create(shared, { harnessId: "alpha" }, "create-holder");
  app.setRetention(holder.id, true, "keep"); app.send(holder.id, "turn", "holder-turn"); await app.wait(holder.id);
  const other = await app.create(shared, { harnessId: "alpha" }, "create-other");
  app.send(other.id, "beside it", "other-first"); await app.wait(other.id);
  const ran = app.read(other.id).runs[0]!;
  assert.equal(ran.status, "completed"); assert.equal(ran.error, null); assert.equal(app.read(other.id).status, "open");
  assert.equal(factory.prepared.length, 2, "both programs ran in the directory");
  assert.equal(app.read(holder.id).retained !== undefined, true, "the holder's kept process was not touched");
  assert.equal(factory.prepared[0]!.closed, false);
  assert.deepEqual(app.keptProcesses().map(row => [row.sessionId, row.workspace]), [[holder.id, shared.workspace]]);
  // The lease is released with the last holder: ending the kept process lets the workspace go.
  await app.endKept(holder.id, "end-holder");
  assert.equal(app.read(holder.id).retained, undefined); assert.equal(closes(holder.id)[0]?.reason, "ended_by_user");
  app.send(other.id, "now", "other-second"); await app.wait(other.id);
  assert.equal(app.read(other.id).runs[1]!.status, "completed");
});

test("a kept process that exited while idle is closed and the next Turn restores the native session as usual", async t => {
  const { factory, app, workspace, methods, closes, until } = await setup(t);
  const session = await app.create(await workspace("exited"), { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep"); app.send(session.id, "turn", "first"); await app.wait(session.id);
  process.kill(Number(await readFile(factory.prepared[0]!.pid, "utf8")), "SIGKILL");
  await new Promise(resolve => setTimeout(resolve, 200));
  app.send(session.id, "again", "second"); await app.wait(session.id);
  await until(() => closes(session.id).length === 1);
  assert.equal(closes(session.id)[0]?.reason, "exited");
  const second = app.read(session.id).runs[1]!;
  assert.equal(second.status, "completed"); assert.equal(second.reused, undefined); assert.equal(factory.prepared.length, 2);
  assert.ok((await methods(1)).includes("session/resume"), "the new process restores the native session");
});

test("a Codex app-server is kept and reused the same way", async t => {
  const { factory, app, workspace, methods, closes } = await setup(t, undefined, "codex-app-server");
  const session = await app.create(await workspace("codex"), { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep");
  app.send(session.id, "first", "first"); await app.wait(session.id);
  app.send(session.id, "second", "second"); await app.wait(session.id);
  const state = app.read(session.id);
  assert.deepEqual(state.runs.map(run => [run.status, run.reused ?? false, run.retained ?? false]), [["completed", false, true], ["completed", true, true]]);
  assert.equal(factory.prepared.length, 1);
  const sent = await methods(0);
  assert.equal(sent.filter(method => method === "initialize").length, 1); assert.equal(sent.filter(method => method === "turn/start").length, 2);
  assert.equal(sent.some(method => method === "thread/resume"), false);
  await app.close();
  assert.deepEqual(closes(session.id).map(close => [close.reason, close.cleanup?.closed]), [["gateway_shutdown", true]]);
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") return false; throw error; }
}
async function settle(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 150 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  return check();
}
/**
 * Runs a separate Gateway owner that keeps the native process of one conversation in `root`, then kills that owner with
 * SIGKILL, so nothing of it is closed. With `linger`, the kept program leaves a background task in its process group.
 */
/** `hold`: the kept program keeps running after its owner dies; `outsider`: it started a task in its own process group. */
async function crashedOwner(root: string, workspace: string, identify: boolean, linger: boolean, outsider = false, hold = false) {
  const leaderFile = join(root, "leader.pid"), memberFile = join(root, "member.pid"), outsiderFile = join(root, "outsider.pid");
  const owner = spawn(process.execPath, [keptOwner, build, join(root, "data"), join(root, "leases"), workspace, peer, identify ? "1" : "0"],
    { env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", FIXTURE_PID: leaderFile, ...(linger ? { FIXTURE_LINGER: "1", FIXTURE_CHILD_PID: memberFile } : {}), ...(outsider ? { FIXTURE_OUTSIDER: outsiderFile } : {}), ...(hold ? { FIXTURE_HOLD: "1" } : {}) }, stdio: ["ignore", "pipe", "inherit"] });
  owner.stdout.setEncoding("utf8");
  const line = await new Promise<string>((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("the owner kept no process in time")), 15_000);
    owner.stdout.on("data", (chunk: string) => { output += chunk; const end = output.indexOf("\n"); if (end >= 0) { clearTimeout(timer); done(output.slice(0, end)); } });
    owner.once("exit", code => { clearTimeout(timer); reject(new Error("the owner exited first (" + String(code) + ")")); });
  });
  const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
  const kept = JSON.parse(line) as { readonly session: string; readonly retained: { readonly runId: string; readonly process?: { readonly group: number; readonly startedAt: string } } | null };
  return { session: kept.session as SessionId, retained: kept.retained, leader: Number(await readFile(leaderFile, "utf8")), member: linger ? Number(await readFile(memberFile, "utf8")) : null,
    outsider: outsider ? Number(await readFile(outsiderFile, "utf8")) : null };
}
/** The owner that starts after a crashed one, on the same data and lease roots. */
function nextOwner(t: test.TestContext, root: string, cleanup: () => void) {
  const store = appStore(join(root, "data")), factory = new KeptFactory(root);
  let id = 0;
  const app = new SessionRuntime(store, factory, { id: () => "next-" + String(++id), now: () => NOW, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"),
    processes: new PosixProcessGroups() });
  t.after(async () => { try { await app.close(); } finally { store.close(); cleanup(); await rm(root, { recursive: true, force: true }); } });
  const lost = (session: SessionId) => store.events(session, 0).filter(event => event.type === "native.process_lost").map(event => event.data);
  return { store, factory, app, lost };
}
const posixOnly = { skip: process.platform === "win32" ? "process groups are POSIX; Windows is not verified (ADR-030)" : false };

test("a process kept under an owner that was killed is ended at the next start, its workspace released, and the next Turn restores the native session", posixOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-kept-orphan-")), workspace = join(root, "crash"); await mkdir(workspace);
  const crashed = await crashedOwner(root, workspace, true, true);
  const { app, factory, lost } = nextOwner(t, root, () => { try { process.kill(-crashed.leader, "SIGKILL"); } catch { /* already ended */ } });
  assert.equal(crashed.retained?.process?.group, crashed.leader, "the recorded group is the one the kept program leads");
  assert.ok(alive(crashed.member!), "the background task outlived its owner");
  // The program itself leaves once its input closes; its group lives on in the background task.
  assert.ok(await settle(() => !alive(crashed.leader)), "the program exits when its input closes");
  assert.notEqual(app.read(crashed.session).retained, undefined, "recovery keeps the record for the reaper");

  assert.deepEqual(await app.reapKept(), [{ sessionId: crashed.session, outcome: "terminated", leaseReleased: true }], "the outcomes it reports");
  assert.deepEqual(app.keptLoss(crashed.session), { outcome: "terminated", leaseReleased: true, at: NOW.getTime() });
  assert.ok(await settle(() => !alive(crashed.member!)), "the whole group ended, the background task included");
  assert.equal(app.read(crashed.session).retained, undefined);
  // The program left with its owner, so whatever it had started was adopted elsewhere: unknown, never zero.
  assert.deepEqual(lost(crashed.session), [{ runId: crashed.retained?.runId, harnessId: "alpha", controlId: "alpha-acp", reason: "owner_ended", outcome: "terminated", leaseReleased: true,
    outside: { state: "unknown" } }]);
  assert.equal(app.keptOutside(crashed.session), null);

  app.send(crashed.session, "again", "again"); await app.wait(crashed.session);
  const next = app.read(crashed.session).runs.at(-1)!;
  assert.equal(next.status, "completed", "the released workspace admits the next Turn");
  assert.equal(app.keptLoss(crashed.session), null, "the notice ends with the next Turn");
  const sent = (await readFile(factory.prepared[0]!.trace, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { method?: string }).method ?? "");
  assert.ok(sent.includes("session/resume"), "a new program restores the native session");
});

test("a kept program that ended with its owner is recorded as gone and its workspace released", posixOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-kept-orphan-")), workspace = join(root, "gone"); await mkdir(workspace);
  const crashed = await crashedOwner(root, workspace, true, false);
  const { app, lost } = nextOwner(t, root, () => { try { process.kill(-crashed.leader, "SIGKILL"); } catch { /* already ended */ } });
  assert.ok(await settle(() => !alive(crashed.leader)), "the program exits when its input closes");
  assert.deepEqual(await app.reapKept(), [{ sessionId: crashed.session, outcome: "gone", leaseReleased: true }], "the outcomes it reports");
  assert.deepEqual(app.keptLoss(crashed.session), { outcome: "gone", leaseReleased: true, at: NOW.getTime() });
  assert.deepEqual(lost(crashed.session).map(data => (data as { outcome: string }).outcome), ["gone"]);
  // The program and its group are gone, so its descendants, if any, were adopted elsewhere: they cannot be enumerated.
  assert.deepEqual(lost(crashed.session).map(data => (data as { outside: unknown }).outside), [{ state: "unknown" }]);
  app.send(crashed.session, "again", "again"); await app.wait(crashed.session);
  assert.equal(app.read(crashed.session).runs.at(-1)!.status, "completed");
});

test("a kept process without a recorded identity is never signalled and its workspace stays quarantined", posixOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-kept-orphan-")), workspace = join(root, "unknown"); await mkdir(workspace);
  const crashed = await crashedOwner(root, workspace, false, true);
  const { app, factory, lost } = nextOwner(t, root, () => { try { process.kill(-crashed.leader, "SIGKILL"); } catch { /* already ended */ } });
  assert.equal(crashed.retained?.process, undefined);
  assert.deepEqual(await app.reapKept(), [{ sessionId: crashed.session, outcome: "unconfirmed", leaseReleased: false }], "the outcomes it reports");
  assert.deepEqual(app.keptLoss(crashed.session), { outcome: "unconfirmed", leaseReleased: false, at: NOW.getTime() });
  assert.ok(alive(crashed.member!), "a group that cannot be recognized is left running");
  assert.deepEqual(lost(crashed.session).map(data => [(data as { outcome: string }).outcome, (data as { leaseReleased: boolean }).leaseReleased, (data as { outside: unknown }).outside]), [["unconfirmed", false, { state: "unknown" }]]);
  assert.equal(app.read(crashed.session).retained, undefined, "the record is resolved once; the quarantine carries on");
  app.send(crashed.session, "again", "again");
  await assert.rejects(app.wait(crashed.session), { code: "SESSION_BLOCKED" }, "an unresolved workspace blocks the conversation as before");
  const refused = app.read(crashed.session).runs.at(-1)!;
  assert.equal(refused.status, "unknown"); assert.equal(refused.error?.code, "WORKSPACE_QUARANTINED"); assert.equal(factory.prepared.length, 0);
});

test("a taken-over program that still runs: what left its group is recorded, left running and said once; none found is zero", posixOnly, async t => {
  // Without an outside task: the leader still runs, so finding none means none.
  const plain = await mkdtemp(join(tmpdir(), "harness-kept-outside-")), plainWorkspace = join(plain, "crash"); await mkdir(plainWorkspace);
  const quiet = await crashedOwner(plain, plainWorkspace, true, true, false, true);
  const first = nextOwner(t, plain, () => { try { process.kill(-quiet.leader, "SIGKILL"); } catch { /* already ended */ } });
  assert.ok(alive(quiet.leader), "the program outlived its owner");
  assert.deepEqual(await first.app.reapKept(), [{ sessionId: quiet.session, outcome: "terminated", leaseReleased: true }]);
  assert.deepEqual(first.lost(quiet.session).map(data => (data as { outside: unknown }).outside), [{ state: "enumerated", found: 0, remaining: 0, commands: [] }]);
  assert.equal(first.app.keptOutside(quiet.session), null);

  const root = await mkdtemp(join(tmpdir(), "harness-kept-outside-")), workspace = join(root, "crash"); await mkdir(workspace);
  const crashed = await crashedOwner(root, workspace, true, true, true, true);
  const { app, lost } = nextOwner(t, root, () => { for (const pid of [crashed.outsider!]) { try { process.kill(pid, "SIGKILL"); } catch { /* already ended */ } } try { process.kill(-crashed.leader, "SIGKILL"); } catch { /* already ended */ } });
  assert.ok(alive(crashed.outsider!) && alive(crashed.leader));
  assert.deepEqual(await app.reapKept(), [{ sessionId: crashed.session, outcome: "terminated", leaseReleased: true }]);
  assert.deepEqual(lost(crashed.session).map(data => (data as { outside: unknown }).outside), [{ state: "enumerated", found: 1, remaining: 1, commands: ["node"] }]);
  assert.ok(alive(crashed.outsider!), "the Hub never signals what left the group");
  assert.equal(app.keptOutside(crashed.session)?.count, 1);
  app.send(crashed.session, "again", "again"); await app.wait(crashed.session);
  assert.equal(app.keptOutside(crashed.session), null, "said until the next Turn");
});

test("closing a kept program records the background task that left its group, leaves it running and says so once", posixOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-kept-outside-")), workspace = join(root, "outside"); await mkdir(workspace);
  const store = appStore(join(root, "data")), factory = new KeptFactory(root, "acp-v1", true);
  let id = 0;
  const app = new SessionRuntime(store, factory, { id: () => "outside-" + String(++id), now: () => NOW, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), processes: new PosixProcessGroups() });
  t.after(async () => {
    try { await app.close(); } finally {
      store.close();
      for (const entry of factory.prepared) { try { process.kill(Number(await readFile(entry.outsider!, "utf8")), "SIGKILL"); } catch { /* already ended */ } }
      await rm(root, { recursive: true, force: true });
    }
  });
  const session = await app.create({ workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep"); app.send(session.id, "first", "first"); await app.wait(session.id);
  assert.notEqual(app.read(session.id).retained, undefined);
  const outsider = Number(await readFile(factory.prepared[0]!.outsider!, "utf8"));
  await app.endKept(session.id, "end");
  const closed = store.events(session.id, 0).filter(event => event.type === "native.process_closed").map(event => (event.data as { outside: unknown; reason: string }));
  assert.deepEqual(closed.map(data => [data.reason, data.outside]), [["ended_by_user", { state: "enumerated", found: 1, remaining: 1, commands: ["node"] }]]);
  assert.ok(alive(outsider), "the Hub never signals what left the group");
  assert.equal(app.keptOutside(session.id)?.count, 1);
  app.send(session.id, "again", "again"); await app.wait(session.id);
  assert.equal(app.keptOutside(session.id), null, "said until the next Turn");
});

test("G028-UP1 an upgrade of a Harness closes its idle kept processes and says so until the next Turn, and a Turn of it counts as busy (ADR-043)", async t => {
  const { factory, app, workspace, closes } = await setup(t);
  const session = await app.create(await workspace("upgrade"), { harnessId: "alpha" }, "create");
  app.setRetention(session.id, true, "keep");
  app.send(session.id, "first", "first"); await app.wait(session.id);
  assert.deepEqual(app.programUsers("alpha"), [{ sessionId: session.id, busy: false }]); assert.deepEqual(app.programUsers("beta"), []);
  assert.equal(await app.releaseForUpgrade("beta"), 0); assert.equal(factory.prepared[0]!.closed, false, "another Harness's upgrade leaves it");
  assert.equal(await app.releaseForUpgrade("alpha"), 1);
  assert.equal(factory.prepared[0]!.closed, true); assert.equal(app.read(session.id).retained, undefined); assert.deepEqual(app.programUsers("alpha"), []);
  // The reason is read back through the store's event parser, which has not changed since the deployed build 80a5246:
  // it checks an event's type name, shape and size, never the values inside its data, so that build reads it too.
  const [closed] = closes(session.id);
  assert.equal(closed?.reason, "harness_upgrade"); assert.equal(closed?.cleanup?.closed, true);
  assert.deepEqual(app.keptUpgrade(session.id), { harnessId: "alpha", at: NOW.getTime() });
  app.send(session.id, "second", "second");
  assert.deepEqual(app.programUsers("alpha"), [{ sessionId: session.id, busy: true }], "a Turn queued or running blocks an upgrade");
  assert.equal(app.keptUpgrade(session.id), null, "the next Turn starts the new version");
  await app.wait(session.id);
  assert.deepEqual(app.programUsers("alpha"), [{ sessionId: session.id, busy: false }], "kept again after the Turn");
});
