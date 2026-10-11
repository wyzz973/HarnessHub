import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import type { ControlOptions } from "../../src/contracts/control.js";
import { ControlError, JsonRpcProcess } from "../../src/infrastructure/control/json-rpc-process.js";

const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1500,
  maxFrameBytes: 4096, maxDiagnosticBytes: 128, closeGraceMs: 150 };
const fixture = resolve("tests/fixtures/control-peer.mjs");
function peer(scenario: string, extra: Record<string, string> = {}, overrides: Partial<ControlOptions> = {}): JsonRpcProcess {
  return new JsonRpcProcess({ protocol: "acp-v1", executable: process.execPath, args: [fixture, "acp-v1", scenario], env: extra },
    { ...options, ...overrides }, { notification: () => {}, request: () => { throw new ControlError("METHOD_NOT_FOUND", "unsupported"); }, failure: () => {} });
}
async function closed(rpc: JsonRpcProcess): Promise<void> { assert.equal((await rpc.close()).closed, true); }
test("JSON-RPC uses real process framing with UTF-8 split across chunks", async () => {
  const rpc = peer("split");
  try { await rpc.request("initialize", {}); assert.deepEqual(await rpc.request("ping", { text: "中文" }), { echoed: { text: "中文" } }); }
  finally { await closed(rpc); }
});
for (const [scenario, code] of [["bad-json", "INVALID_FRAME"], ["bad-utf8", "INVALID_FRAME"], ["huge", "FRAME_LIMIT"],
  ["half", "INCOMPLETE_FRAME"], ["unknown-response", "UNKNOWN_RESPONSE"], ["invalid-response", "INVALID_PROTOCOL"]])
  test(`reject ${scenario} and await process cleanup`, async () => {
    const rpc = peer(scenario ?? "");
    try { await assert.rejects(rpc.request("initialize", {}), error => error instanceof ControlError && error.code === code); }
    finally { await closed(rpc); }
  });
test("request deadline closes a peer that never replies", async () => {
  const rpc = peer("timeout", {}, { requestTimeoutMs: 60 });
  try { await assert.rejects(rpc.request("initialize", {}), /deadline/); } finally { await closed(rpc); }
});
test("remote error is a rejection rather than a successful payload", async () => {
  const rpc = peer("remote-error");
  try { await assert.rejects(rpc.request("initialize", {}), error => error instanceof ControlError && error.code === "REMOTE_ERROR" && error.message.includes("-32001") && !error.message.includes("test remote error")); } finally { await closed(rpc); }
});
test("stderr capture is bounded while protocol operation continues", async () => {
  const rpc = peer("stderr");
  try { await rpc.request("initialize", {}); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(Buffer.byteLength(rpc.diagnostics), 128); assert.equal(rpc.diagnosticsTruncated, true); }
  finally { await closed(rpc); }
});
test("duplicate response makes the connection fail without retaining pending work", async () => {
  const rpc = peer("duplicate-response");
  try {
    await rpc.request("initialize", {});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(rpc.failure instanceof ControlError); assert.equal(rpc.failure.code, "UNKNOWN_RESPONSE");
    await assert.rejects(rpc.request("ping", {}), /no pending request/);
  } finally { assert.equal((await rpc.close()).protocolFailure?.code, "UNKNOWN_RESPONSE"); }
});
test("invalid launch and budgets reject before creating a child", () => {
  assert.throws(() => new JsonRpcProcess({ protocol: "acp-v1", executable: "node", args: [], env: {} }, options,
    { notification: () => {}, request: () => {}, failure: () => {} }), /absolute/);
  assert.throws(() => peer("basic", {}, { maxFrameBytes: 0 }), /positive/);
});
test("spawn failure rejects pending request and cleanup is idempotent", async () => {
  const rpc = new JsonRpcProcess({ protocol: "acp-v1", executable: "/does-not-exist-harnessgateway", args: [], env: {} }, options,
    { notification: () => {}, request: () => {}, failure: () => {} });
  await assert.rejects(rpc.request("initialize", {}), /ENOENT/);
  const first = rpc.close(); assert.equal(rpc.close(), first); await first;
});
test("close escalates a TERM-resistant owned peer to KILL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-rpc-"));
  const rpc = peer("resist", { FIXTURE_PID: join(directory, "pid") }, { requestTimeoutMs: 1000, closeGraceMs: 60 });
  const pending = rpc.request("initialize", {}); const rejected = assert.rejects(pending, /closed/);
  try {
    for (let i = 0; i < 50; i++) { try { await readFile(join(directory, "pid")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    const cleanup = await rpc.close(); await rejected; assert.equal(cleanup.signal, "SIGKILL");
    const pid = Number(await readFile(join(directory, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0));
  } finally { await rpc.close(); await rm(directory, { recursive: true, force: true }); }
});
test("close owns and terminates descendants in its process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-rpc-tree-"));
  const rpc = peer("descendant", { FIXTURE_CHILD_PID: join(directory, "child") }, { closeGraceMs: 120 });
  try {
    await rpc.request("initialize", {});
    const pid = Number(await readFile(join(directory, "child"), "utf8"));
    assert.equal((await rpc.close()).closed, true); assert.throws(() => process.kill(pid, 0));
  } finally { await rpc.close(); await rm(directory, { recursive: true, force: true }); }
});
test("many valid small frames cannot bypass the cumulative wire budget", async () => {
  const rpc = peer("flood", {}, { maxWireBytes: 16 * 1024 * 1024 });
  try {
    await rpc.request("initialize", {});
    for (let i = 0; i < 100 && !rpc.failure; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(rpc.failure instanceof ControlError); assert.equal(rpc.failure.code, "WIRE_LIMIT");
  } finally { assert.equal((await rpc.close()).closed, true); }
});
test("close remains idempotent when a failure observer calls close reentrantly", async () => {
  let observed: Promise<unknown> | null = null;
  const rpc = new JsonRpcProcess({ protocol: "acp-v1", executable: process.execPath,
    args: [fixture, "acp-v1", "basic"], env: {} }, options,
    { notification: () => {}, request: () => {}, failure: () => { observed = rpc.close(); } });
  await rpc.request("initialize", {});
  const first = rpc.close(); await first; assert.equal(observed, first);
});
test("oversized outbound frame rejects the operation and closes its peer", async () => {
  const rpc = peer("basic");
  try { await assert.rejects(rpc.request("initialize", { value: "x".repeat(10000) }), /outbound frame/); }
  finally { await rpc.close(); }
});
test("normal owner close has no protocol failure and preserves bounded failure snapshots", async () => {
  const normal = peer("basic");
  assert.deepEqual(await normal.close(), { closed: true, exitCode: null, signal: null, protocolFailure: null });
  const failed = peer("basic"); failed.abort(new Error("x".repeat(10000)));
  const cleanup = await failed.close(); assert.equal(cleanup.closed, true);
  assert.equal(cleanup.protocolFailure?.code, "CONTROL_FAILED"); assert.equal(cleanup.protocolFailure?.message.length, 512);
});

test("Gateway authentication failure is classified from private stderr without reflecting its credential text", async () => {
  const rpc = peer("gateway-auth-failure");
  try { await assert.rejects(rpc.request("initialize", {}), error => error instanceof ControlError && error.code === "GATEWAY_AUTH_REQUIRED" && !error.message.includes("never-public")); }
  finally {
    const evidence = await rpc.close(); assert.equal(evidence.closed, true); assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.protocolFailure?.code, "GATEWAY_AUTH_REQUIRED"); assert.equal(JSON.stringify(evidence).includes("never-public"), false);
  }
});
test("an incompatible native configuration reports a safe cause and independently confirms process closure", async () => {
  const rpc = peer("invalid-native-config");
  try { await assert.rejects(rpc.request("initialize", {}), error => error instanceof ControlError && error.code === "NATIVE_CONFIGURATION_INVALID" && !error.message.includes("never-public")); }
  finally {
    const cleanup = await rpc.close(); assert.equal(cleanup.closed, true); assert.equal(cleanup.exitCode, 1);
    assert.equal(cleanup.protocolFailure?.code, "NATIVE_CONFIGURATION_INVALID"); assert.equal(JSON.stringify(cleanup).includes("never-public"), false);
  }
});

/** A detached group: a leader and one child of its own, both idle; the child's pid is printed by the leader. */
async function group(leaderExits = false): Promise<{ readonly leader: number; readonly child: number }> {
  const { spawn } = await import("node:child_process");
  const script = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');" +
    (leaderExits ? "setTimeout(()=>process.exit(0),100);" : "setInterval(()=>{},1000);");
  const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const child = await new Promise<number>((done, fail) => { leader.stdout.once("data", chunk => done(Number(String(chunk).trim()))); leader.once("error", fail); });
  leader.stdout.destroy(); leader.unref();
  return { leader: leader.pid!, child };
}
function running(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); }

test("elapsed time from ps is read in all its forms, and nothing else is", async () => {
  const { elapsedSeconds } = await import("../../src/infrastructure/control/process-group.js");
  assert.equal(elapsedSeconds("05:03"), 303); assert.equal(elapsedSeconds(" 1:02:03\n"), 3723); assert.equal(elapsedSeconds("2-01:02:03"), 2 * 86400 + 3723);
  for (const text of ["", "3", "1:2:3:4", "a:bc", "-01:02"]) assert.equal(elapsedSeconds(text), null, text);
});

test("the processes that left a group are found below its members, with base names only; nothing to start from is no answer", async () => {
  const { outsidersOf } = await import("../../src/infrastructure/control/process-group.js");
  const now = 10_000, table = [
    "  100     1   100   01:00 /usr/local/bin/node",
    "  101   100   100   00:59 /bin/zsh",
    "  102   101   102   00:30 /bin/sleep",
    "  103   102   102   00:20 sleep",
    "  104     1   104   00:10 /usr/bin/unrelated",
    "  105   100   100   00:05 /Applications/Some App.app/Contents/MacOS/Some App",
    "  106   105   106   00:02 /Applications/Some App.app/Contents/MacOS/Helper Tool"].join("\n");
  assert.deepEqual(outsidersOf(table, 100, now), [{ pid: 102, startedAt: now - 30, command: "sleep" }, { pid: 106, startedAt: now - 2, command: "Helper Tool" }, { pid: 103, startedAt: now - 20, command: "sleep" }]);
  assert.deepEqual(outsidersOf(table, 104, now), [], "a group whose members started nothing outside: zero, not unknown");
  assert.equal(outsidersOf(table, 999, now), null, "no member left to start from: unknown");
  assert.equal(outsidersOf(table + "\nnot a ps row", 100, now), null, "an unreadable table: unknown");
  // A chain deeper than 32 levels is followed only that far.
  const chain = ["  200     1   200   01:00 leader", ...Array.from({ length: 40 }, (_, index) => `  ${201 + index}   ${200 + index}   ${201 + index}   00:10 child`)].join("\n");
  assert.equal(outsidersOf(chain, 200, now)?.length, 32);
});

test("a kept process group is ended only while it is the recorded one, members included", async () => {
  const { PosixProcessGroups } = await import("../../src/infrastructure/control/process-group.js");
  const groups = new PosixProcessGroups();
  // The recorded group: leader and member end together.
  const kept = await group(), startedAt = await groups.identify(kept.leader);
  assert.ok(startedAt !== null && Math.abs(Number(startedAt) - Date.now() / 1000) < 10);
  assert.equal(await groups.end({ group: kept.leader, startedAt: startedAt! }), "terminated");
  await until(() => !running(kept.child)); assert.equal(running(kept.leader), false); assert.equal(running(kept.child), false);
  assert.equal(await groups.identify(kept.leader), null);
  assert.equal(await groups.end({ group: kept.leader, startedAt: startedAt! }), "gone", "a group that no longer exists is gone");
  // A leader started at another time is another program: never signalled.
  const other = await group();
  try {
    const started = Number(await groups.identify(other.leader));
    assert.equal(await groups.end({ group: other.leader, startedAt: String(started - 3600) }), "gone");
    assert.equal(running(other.leader), true); assert.equal(running(other.child), true);
  } finally { try { process.kill(-other.leader, "SIGKILL"); } catch { /* already gone */ } }
  // A leader that exited first leaves its member in the recorded group, which is still ended.
  const orphaned = await group(true);
  await until(() => !running(orphaned.leader));
  assert.equal(await groups.identify(orphaned.leader), null); assert.equal(running(orphaned.child), true);
  assert.equal(await groups.end({ group: orphaned.leader, startedAt: "1" }), "terminated");
  await until(() => !running(orphaned.child)); assert.equal(running(orphaned.child), false);
});
