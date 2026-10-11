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
    assert.deepEqual(messages[2].params, { cwd: process.cwd(), ephemeral: false });
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
// app-server attaches every connection to every thread it creates, so another thread's output is ignored, never attributed.
test("Codex never attributes output of a thread it does not own", async () => {
  const driver = control("wrong-identity", {}, { runTimeoutMs: 100 }), events: ControlEvent[] = [];
  try { const id = await ready(driver), run = await driver.startText(id, "hello", event => events.push(event)); await assert.rejects(run.result, /deadline/); assert.equal(events.some(event => event.type === "text"), false); }
  finally { assert.equal((await driver.close()).closed, true); }
});
for (const [scenario, expected] of [["wrong-turn", /identity changed/],
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

test("Codex resumes the original durable thread and rejects replacement identity", async () => {
  const first = control(); let checkpoint: string | null = null;
  try { const id = await ready(first); await (await first.startText(id, "first", () => {})).result; checkpoint = await first.checkpoint(); }
  finally { await first.close(); }
  assert.ok(checkpoint);
  const restored = control();
  try { await restored.initialize(); const id = await restored.open(process.cwd(), undefined, undefined, checkpoint); assert.equal(id, checkpoint); assert.equal((await (await restored.startText(id, "second", () => {})).result).status, "completed"); }
  finally { await restored.close(); }
  const wrong = control("resume-wrong-identity");
  try { await wrong.initialize(); await assert.rejects(wrong.open(process.cwd(), undefined, undefined, checkpoint), error => error !== null && typeof error === "object" && "code" in error && error.code === "IDENTITY_MISMATCH"); }
  finally { await wrong.close(); }
});

test("Codex native questions return actual option labels and freeform values, and native reasoning stays visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-question-")), trace = join(root, "trace"), driver = control("native-question", { FIXTURE_TRACE: trace });
  const events: ControlEvent[] = [], decisions: Promise<void>[] = [];
  try {
    const id = await ready(driver); driver.enablePermissions();
    const run = await driver.startText(id, "native questions", event => {
      events.push(event);
      if (event.type === "permission_requested") decisions.push(driver.decidePermission(event.id, event.input ? "submit" : "answer-1", event.input ? "synthetic answer\nsecond line" : undefined));
    });
    assert.equal((await run.result).status, "completed"); await Promise.all(decisions);
    assert.ok(events.some(event => event.type === "thinking" && event.text === "native reasoning summary"));
    assert.ok(events.some(event => event.type === "permission_requested" && event.input?.kind === "secret"));
    const frames = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(frames.find(frame => frame.id === "native-question").result, { answers: { "native-choice": { answers: ["Second"] }, "native-text": { answers: ["synthetic answer\nsecond line"] } } });
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});
test("Codex ignores attached foreign threads, surfaces sub-agent approvals and never approves unrelated work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-foreign-")), trace = join(directory, "trace");
  const driver = control("foreign-thread", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver); driver.enablePermissions(); const events: ControlEvent[] = [];
    const run = await driver.startText(id, "delegate", event => events.push(event));
    assert.deepEqual(await run.result, { status: "completed", reason: "completed" });
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.type === "text" ? event.text : ""), ["你好 fixture"]);
    const asked = events.flatMap(event => event.type === "permission_requested" ? [event] : []);
    assert.deepEqual(asked.map(event => [event.id, event.title]), [["child-approval", "子 Agent · ls"]]);
    // close() ends input and awaits the peer, so every answer written before it is in the trace.
    assert.equal((await driver.close()).protocolFailure, null);
    const wire = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { id?: unknown; result?: unknown });
    assert.deepEqual(wire.find(row => row.id === "unrelated-approval")?.result, { decision: "decline" });
    assert.deepEqual(wire.find(row => row.id === "child-approval")?.result, { decision: "cancel" });
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("Codex classifies failures by native codexErrorInfo before message text", async () => {
  const driver = control("typed-failure");
  try {
    const result = await (await driver.startText(await ready(driver), "hello", () => {})).result;
    assert.equal(result.status, "failed"); assert.equal(result.error?.code, "NATIVE_QUOTA_EXCEEDED");
  } finally { await driver.close(); }
});
test("Codex maps item details, streamed output, plan, turn usage, notices and activities", async () => {
  const driver = control("native-activity");
  try {
    const events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(await ready(driver), "work", event => events.push(event))).result).status, "completed");
    const final = (id: string) => events.flatMap(event => event.type === "tool" && event.id === id ? [event] : []).at(-1);
    const command = final("cmd-1");
    assert.equal(command?.title, "printf 'a' printf 'b'"); assert.equal(command?.status, "completed");
    assert.deepEqual(command?.detail, { kind: "execute", name: "shell", input: "printf 'a'\nprintf 'b'", output: "ab", exitCode: 0, locations: ["/w"] });
    assert.equal(final("patch-1")?.detail?.diff, "--- a/w/a.txt\n+++ b/w/a.txt\n@@ -1 +1 @@\n-old\n+new\n");
    assert.deepEqual(final("mcp-1")?.detail, { kind: "mcp", name: "docs/search", input: "{\n  \"q\": \"acp\"\n}", output: "found" });
    assert.deepEqual(events.find(event => event.type === "plan"), { type: "plan", entries: [{ content: "Inspect", status: "completed" }, { content: "Patch", status: "in_progress" }], explanation: "two steps" });
    assert.deepEqual(events.filter(event => event.type === "usage").map(event => event.type === "usage" ? event.usage : null), [{ turn: { input: 400, output: 200, cachedInput: 200, cacheWrite: 0, reasoning: 50, total: 600 }, context: { used: 600, size: 100000 } }]);
    assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.type === "activity" ? [event.kind, event.status] : null), [["compaction", "running"], ["subagent", "completed"], ["retry", "running"]]);
    assert.deepEqual(events.filter(event => event.type === "notice").map(event => event.type === "notice" ? event.title : null), ["模型已由服务端改路由"]);
    const image = events.find(event => event.type === "output");
    assert.ok(image?.type === "output" && image.output.kind === "content" && image.output.mediaType === "image/png" && image.output.data.length === 11, "a saved image read after item/completed is delivered before the turn ends");
    assert.equal(final("img-1")?.detail?.input, "a chart"); assert.match(final("img-1")?.detail?.locations?.[0] ?? "", /codex-fixture-\d+\.png$/u);
    assert.equal(final("cmd-2")?.detail?.output, "line1", "throttled output pending at settlement is delivered");
  } finally { await driver.close(); }
});
