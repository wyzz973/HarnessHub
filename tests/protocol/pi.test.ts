import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PiControl } from "../../src/adapters/control/pi.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
function control(scenario = "basic", trace?: string, timeout = 1000) {
  return new PiControl({ executable: process.execPath, args: [resolve("tests/fixtures/pi-rpc-peer.mjs"), scenario], env: trace ? { FIXTURE_TRACE: trace } : {}, protocol: "pi-rpc" },
    { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: timeout, closeGraceMs: 100, maxFrameBytes: 65536, maxDiagnosticBytes: 4096 });
}
test("native Pi model selection relaunches the original command with runtime flags and never writes set_model", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-protocol-")), trace = join(root, "trace"); t.after(() => rm(root, { recursive: true, force: true }));
  const driver = control("basic", trace);
  try {
    assert.equal((await driver.initialize()).protocol, "pi-rpc"); assert.equal((await driver.models()).defaultModel, "native/one");
    const id = await driver.open(process.cwd(), "native/two"), events: string[] = [];
    assert.equal((await driver.models()).defaultModel, "native/two");
    assert.deepEqual(await (await driver.startText(id, "test", event => { if (event.type === "text") events.push(event.text); })).result, { status: "completed", reason: "stop" });
    assert.deepEqual(events, ["Pi native answer"]); assert.equal((await driver.close()).protocolFailure, null);
    const frames = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(frames.filter(row => row.type === "set_model" || row.type === "new_session").length, 0); assert.equal(frames.filter(row => row.type === "get_state").length, 2);
  } finally { await driver.close(); }
});
for (const scenario of ["pre-ack", "retry"]) test(`Pi ${scenario} waits for prompt acknowledgment and final settlement`, async () => {
  const driver = control(scenario);
  try {
    await driver.initialize(); const id = await driver.open(process.cwd()), output: string[] = [], run = await driver.startText(id, "test", event => { if (event.type === "text") output.push(event.text); });
    let finished = false; void run.result.then(() => { finished = true; }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(finished, false);
    assert.equal((await run.result).status, "completed"); assert.equal(output.length, scenario === "retry" ? 2 : 1);
  } finally { await driver.close(); }
});
test("Pi agent_end alone is insufficient and timeout closes the owned original process", async () => {
  const driver = control("end-only", undefined, 80);
  try { await driver.initialize(); const run = await driver.startText(await driver.open(process.cwd()), "test", () => {}); await assert.rejects(run.result, error => error instanceof ControlError && error.code === "RUN_TIMEOUT"); assert.equal((await driver.close()).closed, true); }
  finally { await driver.close(); }
});
test("Pi cancellation separates receipt, backend result and awaited cleanup", async () => {
  const driver = control("hold");
  try {
    await driver.initialize(); const run = await driver.startText(await driver.open(process.cwd()), "test", () => {});
    assert.deepEqual(await run.requestStop(), { requested: true }); assert.deepEqual(await run.result, { status: "cancelled", reason: "aborted" });
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
test("Pi rejects malformed wire, unavailable models and native authentication without leaking remote details", async () => {
  const bad = control("bad-json"); try { await assert.rejects(bad.initialize(), /valid UTF-8 JSON/); } finally { await bad.close(); }
  const driver = control("rejected");
  try {
    await driver.initialize(); await assert.rejects(driver.open(process.cwd(), "foreign/model"), /unavailable/);
    const result = await (await driver.startText(await driver.open(process.cwd()), "test", () => {})).result;
    assert.equal(result.error?.code, "NATIVE_AUTH_REQUIRED"); assert.equal(JSON.stringify(result).includes("private-key"), false); assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
