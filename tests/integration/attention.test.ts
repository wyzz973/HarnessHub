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
import type { CleanupEvidence } from "../../src/contracts/control.js";
import { SessionError, type AttentionItem, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const owner = fileURLToPath(new URL("../../../tests/fixtures/kept-owner.mjs", import.meta.url));
const build = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Hermes-like ACP fixture processes (they ask before a command) behind real workspace leases, with this test's Turn deadline. */
class AskingFactory implements SessionBindingFactory {
  private readonly lease: SqliteWorkspaceLeaseProvider;
  constructor(root: string, private readonly runTimeoutMs: number) { this.lease = new SqliteWorkspaceLeaseProvider(join(root, "leases")); }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: "alpha", controlId: "alpha-acp" };
  }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding> {
    const lease = this.lease.acquire(configuration.workspace, session, run), env = { LANG: "C.UTF-8", FIXTURE_RESUME_MODELS: "1" };
    const control = new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [peer, "acp-v1", "hermes"], env },
      { cwd: configuration.workspace, env, requestTimeoutMs: 2000, runTimeoutMs: this.runTimeoutMs, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 });
    let close: Promise<CleanupEvidence> | null = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence: CleanupEvidence | null = null; try { evidence = await control.close(); return evidence; } finally { lease.release(evidence?.closed === true); } })();
      return close;
    } };
  }
}
async function setup(t: test.TestContext, runTimeoutMs = 5000, root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), "harness-attention-")), store = new SqliteSessionStore(join(directory, "data"));
  let id = 0;
  const app = new SessionRuntime(store, new AskingFactory(directory, runTimeoutMs), { id: () => "attention-" + String(++id), now: () => new Date(), publish: () => {},
    fingerprint: value => createHash("sha256").update(value).digest("hex") });
  t.after(async () => { try { await app.close(); } finally { store.close(); if (root === undefined) await rm(directory, { recursive: true, force: true }); } });
  const workspace = async (name: string): Promise<SessionConfiguration> => {
    const path = join(directory, name); await mkdir(path, { recursive: true });
    return { workspace: path, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  };
  const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(check(), "condition not reached"); };
  return { root: directory, store, app, workspace, until };
}

test("a waiting approval is listed with its deadline for whichever conversation is open, until it is decided", async t => {
  const { store, app, workspace, until } = await setup(t, 5000);
  const first = await app.create(await workspace("one"), { harnessId: "alpha" }, "create-one"), second = await app.create(await workspace("two"), { harnessId: "alpha" }, "create-two");
  const before = Date.now();
  // The Runtime runs one Turn at a time: the second conversation's Turn waits until the first one's has ended.
  app.send(first.id, "approve this", "send-one"); app.send(second.id, "approve this", "send-two");
  await until(() => app.attention().length === 1);
  const [item] = app.attention();
  assert.ok(item !== undefined);
  assert.deepEqual([item.sessionId, item.harnessId, item.kind, item.expiresBy], [first.id, "alpha", "approval", "turn"]);
  // The Runtime turns the driver's remaining wait into a time on its own clock: here the Turn's deadline.
  assert.ok(item.requestedAt >= before && item.expiresAt !== undefined && item.expiresAt - item.requestedAt <= 5000 && item.expiresAt - item.requestedAt > 3000, JSON.stringify(item));
  assert.deepEqual(Object.keys(item).sort(), ["expiresAt", "expiresBy", "harnessId", "kind", "permissionId", "requestedAt", "runId", "sessionId"], "the title and details stay in the conversation");
  const [request] = app.permissionRequests(first.id);
  assert.equal(request?.expiresAt, item.expiresAt); assert.equal(request?.requestedAt, item.requestedAt);
  const logged = store.events(first.id, 0).find(event => event.type === "permission.requested")?.data as { expiresAt?: number; expiresBy?: string };
  assert.equal(logged.expiresBy, "turn"); assert.equal(logged.expiresAt, request?.expiresAt);
  // A decided request no longer waits, whether or not the program has continued yet; then the other conversation asks.
  await app.decidePermission(first.id, request!.id, "deny", "decide-one");
  assert.ok(!app.attention().some(value => value.sessionId === first.id));
  await until(() => app.attention().some(value => value.sessionId === second.id));
  await app.decidePermission(second.id, app.permissionRequests(second.id)[0]!.id, "allow_once", "decide-two");
  assert.deepEqual(app.attention(), []);
  await app.wait(first.id); await app.wait(second.id);
  assert.deepEqual([app.read(first.id).runs[0]!.status, app.read(second.id).runs[0]!.status], ["completed", "completed"]);
});

test("a request still waiting at the Turn's deadline expires: the Turn times out and the program never receives a decision", async t => {
  const { store, app, workspace, until } = await setup(t, 900);
  const session = await app.create(await workspace("deadline"), { harnessId: "alpha" }, "create");
  app.send(session.id, "approve this", "send");
  await until(() => app.attention().length === 1);
  // The program was ended mid-Turn, so the Turn's outcome is unknown and the conversation waits for explicit recovery,
  // as after any Turn deadline (DESIGN §5); nothing is sent again.
  await assert.rejects(app.wait(session.id), { code: "SESSION_BLOCKED" });
  const run = app.read(session.id).runs[0]!;
  assert.equal(run.status, "unknown"); assert.equal(run.error?.code, "RUN_TIMEOUT");
  assert.deepEqual(run.notices?.at(-1), { severity: "warning", title: "回合期限已到", detail: "HarnessHub 的回合期限已到，本回合超时结束；原程序没有收到你的决定。" });
  const closed = store.events(session.id, 0).filter(event => event.type === "permission.closed").map(event => event.data as { reason?: string });
  assert.deepEqual(closed.map(data => data.reason), ["expired"]);
  assert.deepEqual(app.attention(), []); assert.deepEqual(app.permissionRequests(session.id), []);
});

test("a restarted owner lists no request its predecessor left waiting", { skip: process.platform === "win32" ? "the fixture owner is killed with a POSIX signal" : false }, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-attention-")), workspacePath = join(root, "asked"); await mkdir(workspacePath);
  const leaderFile = join(root, "leader.pid");
  // Runs after the later owner closed (hooks run in the order they were added, and setup adds its own below).
  t.after(async () => { try { process.kill(-Number(await readFile(leaderFile, "utf8")), "SIGKILL"); } catch { /* already ended */ } });
  const child = spawn(process.execPath, [owner, build, join(root, "data"), join(root, "leases"), workspacePath, peer, "0", "ask"],
    { env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8", FIXTURE_PID: leaderFile }, stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  const line = await new Promise<string>((done, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("the owner asked nothing in time")), 15_000);
    child.stdout.on("data", (chunk: string) => { output += chunk; const end = output.indexOf("\n"); if (end >= 0) { clearTimeout(timer); done(output.slice(0, end)); } });
    child.once("exit", code => { clearTimeout(timer); reject(new Error("the owner exited first (" + String(code) + ")")); });
  });
  const asked = JSON.parse(line) as { readonly session: SessionId; readonly attention: readonly AttentionItem[] };
  assert.equal(asked.attention.length, 1, "the previous owner had a request waiting");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const { app } = await setup(t, 5000, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(app.attention(), [], "nothing can answer a request its process no longer holds");
  assert.deepEqual(app.permissionRequests(asked.session), []);
  assert.equal(app.read(asked.session).runs[0]?.status, "unknown", "the Turn's outcome is unknown, as after any crash");
});
