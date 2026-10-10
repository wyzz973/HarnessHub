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
  const rpc = peer("flood");
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
