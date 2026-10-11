import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ControlEvent, ControlOptions } from "../../src/contracts/control.js";
import { CodexControl } from "../../src/adapters/control/codex.js";

const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1500,
  maxFrameBytes: 65536, maxDiagnosticBytes: 1024, closeGraceMs: 150 };
function control(scenario = "basic", env: Record<string, string> = {}, overrides: Partial<ControlOptions> = {}): CodexControl {
  return new CodexControl({ protocol: "codex-app-server", executable: process.execPath,
    args: [resolve("tests/fixtures/control-peer.mjs"), "codex-app-server", scenario], env }, { ...options, ...overrides });
}
async function ready(driver: CodexControl) { await driver.initialize(); return driver.open(process.cwd()); }
test("Codex initialization acknowledgement, original thread policies, streaming and two distinct turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-")), trace = join(directory, "trace");
  const driver = control("split", { FIXTURE_TRACE: trace });
  try {
    assert.equal((await driver.initialize()).protocol, "codex-app-server");
    const id = await driver.open(process.cwd()), events: ControlEvent[] = [];
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await driver.startText(id, "hello", event => events.push(event))).result, { status: "completed", reason: "completed" });
    assert.equal(events.filter(event => event.type === "text").length, 2);
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(messages[0].params.capabilities, { experimentalApi: false, requestAttestation: false });
    assert.equal(messages[1].method, "initialized");
    assert.deepEqual(messages[2].params, { cwd: process.cwd(), ephemeral: true });
    assert.deepEqual(messages[3].params.input, [{ type: "text", text: "hello", text_elements: [] }]);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("Codex completion notification may precede the turn/start response", async () => {
  const driver = control("early-complete");
  try { const id = await ready(driver), run = await driver.startText(id, "hello", () => {}); assert.equal((await run.result).status, "completed"); }
  finally { await driver.close(); }
});
test("Codex interrupt acknowledgement is separate from cancelled settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-stop-")), trace = join(directory, "trace");
  const driver = control("slow-start", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver), run = await driver.startText(id, "hello", () => {});
    await assert.rejects(driver.startText(id, "other", () => {}), /already active/);
    let settled = false; void run.result.then(() => { settled = true; });
    const first = run.requestStop(); assert.equal(run.requestStop(), first);
    assert.deepEqual(await first, { requested: true }); assert.equal(settled, false);
    assert.deepEqual(await run.result, { status: "cancelled", reason: "interrupted" });
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(messages.filter(message => message.method === "turn/interrupt").length, 1);
    assert.deepEqual(messages.find(message => message.method === "turn/interrupt").params, { threadId: "thread-fixture", turnId: "turn-1" });
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("Codex approvals default to decline and expose permission evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-permission-")), trace = join(directory, "trace");
  const driver = control("permission", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver), events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event)); await run.result;
    assert.ok(events.some(event => event.type === "permission" && event.decision === "denied"));
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(messages.find(message => message.id === "permission-1").result, { decision: "decline" });
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("Codex approvals arriving during interruption return cancel", async () => {
  const driver = control("stop-permission");
  try {
    const id = await ready(driver), events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event));
    await run.requestStop(); assert.equal((await run.result).status, "cancelled");
    assert.ok(events.some(event => event.type === "permission" && event.decision === "cancelled"));
  } finally { await driver.close(); }
});
for (const [scenario, expected] of [["wrong-identity", /another thread/], ["wrong-turn", /identity changed/],
  ["duplicate-permission", /repeated an RPC request/], ["exit-zero", /exited/], ["no-settlement", /deadline/]])
  test(`Codex rejects ${scenario} and awaits cleanup`, async () => {
    const driver = control(scenario as string, {}, { runTimeoutMs: 100 });
    try { const id = await ready(driver), run = await driver.startText(id, "hello", () => {}); await assert.rejects(run.result, expected as RegExp); }
    finally { assert.equal((await driver.close()).closed, true); }
  });
test("Codex consumer exception fails the active result and closes owned resources", async () => {
  const driver = control();
  try { const id = await ready(driver), run = await driver.startText(id, "hello", () => { throw new Error("consumer failed"); }); await assert.rejects(run.result, /consumer failed/); }
  finally { await driver.close(); }
});
test("Codex failed backend status remains failed", async () => {
  const driver = control("failed");
  try { const id = await ready(driver), run = await driver.startText(id, "hello", () => {}); assert.equal((await run.result).status, "failed"); }
  finally { await driver.close(); }
});
test("Codex connection does not create a second thread", async () => {
  const driver = control();
  try { await ready(driver); await assert.rejects(driver.open(process.cwd()), /already owns/); }
  finally { await driver.close(); }
});
test("Codex close settles a run even when turn/start was acknowledged", async () => {
  const driver = control("no-settlement");
  const id = await ready(driver);
  let delivered!: () => void; const textDelivered = new Promise<void>(resolve => { delivered = resolve; });
  const run = await driver.startText(id, "hello", event => { if (event.type === "text") delivered(); });
  await textDelivered;
  const rejected = assert.rejects(run.result, /closed/); await driver.close(); await rejected;
  await assert.rejects(driver.initialize(), /closed/);
});
test("Codex closing an unstarted control prevents future process startup", async () => {
  const driver = control(); await driver.close(); await assert.rejects(driver.initialize(), /closed/);
  await assert.rejects(driver.open(process.cwd()), /closed/);
});
test("Codex passive unknown notifications expose only method diagnostics", async () => {
  const driver = control("passive");
  try {
    const id = await ready(driver), events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event)); await run.result;
    assert.ok(events.some(event => event.type === "diagnostic" && event.message.includes("fixture/passive")));
    assert.ok(!JSON.stringify(events).includes("must-not-leak"));
  } finally { await driver.close(); }
});
test("Codex duplicate completion retains first backend fact but exposes connection failure at close", async () => {
  const driver = control("duplicate-complete");
  try {
    const id = await ready(driver), run = await driver.startText(id, "hello", () => {});
    assert.deepEqual(await run.result, { status: "completed", reason: "completed" });
    const cleanup = await driver.close(); assert.equal(cleanup.closed, true);
    assert.equal(cleanup.protocolFailure?.code, "INVALID_STATE");
  } finally { await driver.close(); }
});

test("an explicit Codex rejection before a turn exists fails the request without manufacturing an unknown execution", async () => {
  const driver = control("prompt-rejected");
  try {
    const id = await ready(driver), output: ControlEvent[] = [], run = await driver.startText(id, "rejected request", value => output.push(value));
    assert.deepEqual(await run.result, { status: "failed", reason: "request_rejected" }); assert.deepEqual(output, []);
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
