import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ControlEvent, ControlOptions } from "../../src/contracts/control.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { contentId } from "../../src/contracts/content.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";

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
// G074-F4 (probe record 2026-11-10, Codex 0.166.0): Codex answers turn/start at once, but takes an interrupt only after the user's
// hooks ran and it reported the turn (turn/started); before that turn/interrupt is refused with -32600 "no active turn to interrupt".
// The driver used to take that refusal for a protocol failure: the connection broke and the turn's result was lost. It is the
// answer of a turn that has not begun, not a failure: the stop waits for the turn to begin and interrupts then.
test("G074-F4 Codex a stop requested before the turn has begun waits for it and interrupts then: the first interrupt is refused (-32600 no active turn), the receipt is the second one's acknowledgement, the result is cancelled, and the connection runs the next turn", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-early-stop-")), trace = join(directory, "trace");
  const driver = control("hooks", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver), run = await driver.startText(id, "hello hooks", () => {});
    let settled = false; void run.result.then(() => { settled = true; });
    const stop = run.requestStop(); assert.equal(run.requestStop(), stop);
    assert.deepEqual(await stop, { requested: true }); assert.equal(settled, false, "the receipt acknowledges the interrupt; the turn's end is separate");
    assert.deepEqual(await run.result, { status: "cancelled", reason: "interrupted" });
    assert.equal(driver.healthy(), true, "the refusal did not break the connection");
    const interrupts = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "turn/interrupt");
    assert.ok(interrupts.length >= 2, "refused before the turn began, asked again after: " + interrupts.length);
    for (const message of interrupts) assert.deepEqual(message.params, { threadId: "thread-fixture", turnId: "turn-1" });
    // The connection is still the turn's owner: the next turn runs on it.
    assert.deepEqual(await (await driver.startText(id, "finish this one", () => {})).result, { status: "completed", reason: "completed" });
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("G074-F4 Codex a stop requested before the turn began, for a turn that then ends by itself, ends as \"turn ended before interruption was requested\" and leaves the connection usable", { timeout: 30000 }, async () => {
  const driver = control("hooks");
  try {
    const id = await ready(driver), run = await driver.startText(id, "finish by itself", () => {});
    await assert.rejects(run.requestStop(), (error: unknown) => error instanceof ControlError && error.code === "INVALID_STATE" && /ended before interruption/.test(error.message));
    assert.deepEqual(await run.result, { status: "completed", reason: "completed" });
    assert.equal(driver.healthy(), true);
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
// The invalid samples: only that refusal is the answer of a turn that has not begun; and the wait has an end.
test("G074-F4 Codex an interrupt refused in other words is still a protocol failure, and a turn Codex never begins is not retried without end: the Run's own deadline ends the wait", { timeout: 30000 }, async () => {
  const other = control("hooks", { FIXTURE_INTERRUPT_REFUSAL: "turn cannot be interrupted" });
  try {
    const id = await ready(other), run = await other.startText(id, "hello hooks", () => {});
    const lost = assert.rejects(run.result, (error: unknown) => error instanceof ControlError && error.code === "REMOTE_ERROR");
    await assert.rejects(run.requestStop(), (error: unknown) => error instanceof ControlError && error.code === "REMOTE_ERROR" && error.remoteCode === -32600);
    await lost; assert.equal(other.healthy(), false);
  } finally { assert.equal((await other.close()).protocolFailure?.code, "REMOTE_ERROR"); }
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-never-begins-")), trace = join(directory, "trace");
  const never = control("hooks", { FIXTURE_START_MS: "60000", FIXTURE_TRACE: trace }, { runTimeoutMs: 700 });
  try {
    const id = await ready(never), run = await never.startText(id, "hello hooks", () => {});
    const ended = assert.rejects(run.result, /deadline/);
    await assert.rejects(run.requestStop(), /deadline/);
    await ended;
    const interrupts = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(message => message.method === "turn/interrupt").length;
    assert.ok(interrupts >= 2 && interrupts <= 8, "asked again while it waited, not without end: " + interrupts);
  } finally { assert.equal((await never.close()).closed, true); await rm(directory, { recursive: true, force: true }); }
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
test("Codex names the item an approval is about", async () => {
  const driver = control("permission");
  try {
    const id = await ready(driver); driver.enablePermissions();
    const events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event));
    for (let i = 0; i < 100 && !events.some(event => event.type === "permission_requested"); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const asked = events.find(event => event.type === "permission_requested");
    assert.ok(asked?.type === "permission_requested"); assert.equal(asked.forCall, "tool-1");
    await driver.decidePermission(asked.id, "decline"); await run.result;
  } finally { await driver.close(); }
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
    assert.deepEqual(await run.result, { status: "failed", reason: "request_rejected", input: "not_recorded" }); assert.deepEqual(output, []);
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
test("Codex carries a native question's freeform answer of any size: the frame bound is the only limit, a NUL is still refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-native-big-")), trace = join(root, "trace"), driver = control("native-question", { FIXTURE_TRACE: trace }, { maxFrameBytes: 4 * 1024 * 1024, runTimeoutMs: 5000 });
  const answer = "答".repeat(50_000), decisions: Promise<void>[] = []; // 150,000 bytes: past the 64 KiB an answer once had to fit
  try {
    const id = await ready(driver); driver.enablePermissions();
    const run = await driver.startText(id, "native questions", event => {
      if (event.type !== "permission_requested") return;
      if (event.input) { decisions.push(driver.decidePermission(event.id, "submit", "a\0b").then(() => assert.fail("a NUL answer is refused"), (error: unknown) => assert.ok(error instanceof ControlError && error.code === "INVALID_INPUT")).then(() => driver.decidePermission(event.id, "submit", answer))); }
      else decisions.push(driver.decidePermission(event.id, "answer-1"));
    });
    assert.equal((await run.result).status, "completed"); await Promise.all(decisions);
    const frames = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(frames.find(frame => frame.id === "native-question").result, { answers: { "native-choice": { answers: ["Second"] }, "native-text": { answers: [answer] } } });
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
test("Codex reports a command's output whole, however long: nothing is cut to a preview at the driver", async () => {
  const driver = control("big-output", {}, { maxFrameBytes: 4 * 1024 * 1024, runTimeoutMs: 5000 });
  try {
    const events: ControlEvent[] = [], run = await driver.startText(await ready(driver), "go", event => events.push(event));
    assert.equal((await run.result).status, "completed");
    const outputs = events.flatMap(event => event.type === "tool" && event.id === "cmd-big" && event.detail?.output !== undefined ? [event.detail.output.length] : []);
    assert.equal(outputs.at(-1), 4 * 100 * 1024 + 3, "the last report holds the whole output");
    assert.ok(Math.max(...outputs) === outputs.at(-1) && outputs.every(length => length <= 4 * 100 * 1024 + 3), "and no report holds less than the one before it");
    assert.equal(events.some(event => event.type === "tool" && event.detail?.truncated === true), false, "nothing says it was cut");
  } finally { await driver.close(); }
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
    assert.deepEqual(events.filter(event => event.type === "usage").map(event => event.type === "usage" ? event.usage : null), [{ turn: { input: 400, output: 200, cachedInput: 200, cacheWrite: 0, reasoning: 50, total: 600 }, context: { used: 600, size: 100000 },
      // G069 phase two (ADR-055 VF2-09): the report's own request, from its `last` counts.
      requests: [{ input: 400, cachedInput: 200 }] }]);
    assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.type === "activity" ? [event.kind, event.status] : null), [["compaction", "running"], ["subagent", "completed"], ["retry", "running"]]);
    assert.deepEqual(events.filter(event => event.type === "notice").map(event => event.type === "notice" ? event.title : null), ["模型已由服务端改路由"]);
    const image = events.find(event => event.type === "output");
    assert.ok(image?.type === "output" && image.output.kind === "content" && image.output.mediaType === "image/png" && image.output.data.length === 11, "a saved image read after item/completed is delivered before the turn ends");
    assert.equal(final("img-1")?.detail?.input, "a chart"); assert.match(final("img-1")?.detail?.locations?.[0] ?? "", /codex-fixture-\d+\.png$/u);
    assert.equal(final("cmd-2")?.detail?.output, "line1", "throttled output pending at settlement is delivered");
  } finally { await driver.close(); }
});

function attachment(directory: string, name: string, mediaType: string, kind: "image" | "audio" | "file", data: Buffer) {
  const path = join(directory, name); writeFileSync(path, data);
  return { id: contentId("content-" + name.replace(/[^a-z0-9]/giu, "")), name, mediaType, kind, bytes: data.length, sha256: "0".repeat(64), path };
}
test("Codex gives images to the opened model by path, names files in text, and refuses inputs the model does not list", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-attachments-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const png = attachment(directory, "shot.png", "image/png", "image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
  const pdf = attachment(directory, "doc.pdf", "application/pdf", "file", Buffer.from("%PDF-1.4"));
  const wav = attachment(directory, "voice.wav", "audio/wav", "audio", Buffer.from("RIFF\0\0\0\0WAVE"));
  const driver = control("attachments", { FIXTURE_TRACE: trace });
  try {
    await driver.initialize();
    assert.deepEqual((await driver.models()).models.map(model => [model.id, model.inputs]), [["native-model-a", { image: true, audio: true, file: true }], ["native-model-b", { image: false, audio: false, file: true }]]);
    const id = await driver.open(process.cwd());
    await driver.checkAttachments([png, wav, pdf]);
    assert.equal((await (await driver.startText(id, "look", () => {}, [png, wav, pdf])).result).status, "completed");
    const input = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.method === "turn/start").params.input;
    assert.deepEqual(input, [{ type: "text", text: "look\n\n[Attached file] doc.pdf (application/pdf, 8 bytes, read-only copy): " + pdf.path, text_elements: [] }, { type: "localImage", path: png.path }, { type: "localAudio", path: wav.path }]);
  } finally { await driver.close(); }
  const textOnly = control("attachments");
  try {
    await textOnly.initialize(); await textOnly.open(process.cwd(), "native-model-b");
    for (const item of [png, wav]) await assert.rejects(textOnly.checkAttachments([item]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_UNSUPPORTED" && error.message.includes(item.name));
    await textOnly.checkAttachments([pdf]);
  } finally { await textOnly.close(); }
});

test("Codex thread permission settings come from the native configuration, apply to the Hub's thread and are verified", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-permissions-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = control("permissions-settings", { FIXTURE_TRACE: trace });
  try {
    await driver.initialize();
    const options = (await driver.models()).options ?? [];
    assert.deepEqual(options.map(option => [option.id, option.currentValue, option.values.map(value => value.value)]), [["collaboration_mode", "default", ["default", "plan"]],
      ["approval_policy", "never", ["untrusted", "on-request", "never"]], ["sandbox", "danger-full-access", ["read-only", "workspace-write", "danger-full-access"]]]);
    await driver.open(process.cwd(), undefined, { approval_policy: "on-request", sandbox: "read-only" });
    const start = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.method === "thread/start");
    assert.equal(start.params.approvalPolicy, "on-request"); assert.equal(start.params.sandbox, "read-only");
  } finally { await driver.close(); }
  for (const [scenario, native, code] of [["permissions-settings", { sandbox: "everything" }, "NATIVE_OPTION_UNAVAILABLE"], ["ignore-permissions", { approval_policy: "on-request" }, "NATIVE_OPTION_MISMATCH"]] as const) {
    const other = control(scenario);
    try { await other.initialize(); await assert.rejects(other.open(process.cwd(), undefined, native), (error: unknown) => error instanceof ControlError && error.code === code, scenario); }
    finally { await other.close(); }
  }
});

test("Codex /compact runs the native compaction turn instead of a prompt", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-compact-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = control("basic", { FIXTURE_TRACE: trace });
  try {
    await driver.initialize();
    assert.deepEqual((await driver.models()).commands?.map(command => command.name), ["compact", "export"]);
    const id = await driver.open(process.cwd()), events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(id, "/compact", event => events.push(event))).result).status, "completed");
    assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.type === "activity" ? event.status : null), ["running", "completed"]);
    const methods = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line).method);
    assert.ok(methods.includes("thread/compact/start")); assert.equal(methods.includes("turn/start"), false);
    // The next ordinary prompt still binds its own turn.
    assert.equal((await (await driver.startText(id, "hello", () => {})).result).status, "completed");
  } finally { await driver.close(); }
});

test("Codex /export copies the thread's own rollout record as an output and fails clearly without one", async () => {
  const driver = control("rollout");
  try {
    await driver.initialize(); const id = await driver.open(process.cwd()), events: ControlEvent[] = [];
    assert.deepEqual(await (await driver.startText(id, "/export", event => events.push(event))).result, { status: "completed", reason: "exported", input: "not_recorded" });
    const output = events.find(event => event.type === "output");
    assert.ok(output?.type === "output" && output.output.kind === "content" && output.output.mediaType === "application/x-ndjson" && Buffer.from(output.output.data).toString() === '{"type":"session_meta"}\n');
  } finally { await driver.close(); }
  const ephemeral = control("basic");
  try {
    await ephemeral.initialize(); const id = await ephemeral.open(process.cwd());
    const result = await (await ephemeral.startText(id, "/export", () => {})).result;
    assert.equal(result.status, "failed"); assert.equal(result.error?.code, "NATIVE_EXPORT_UNAVAILABLE");
  } finally { await ephemeral.close(); }
});

test("Codex forks a stored thread on its own connection and reports refusals as unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-fork-")), trace = join(directory, "trace");
  const driver = control("basic", { FIXTURE_TRACE: trace });
  try {
    await driver.initialize();
    assert.equal(await driver.fork("thread-source", process.cwd()), "thread-forked");
    const fork = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.method === "thread/fork");
    assert.deepEqual(fork.params, { threadId: "thread-source", cwd: process.cwd(), excludeTurns: true });
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
  for (const [scenario, code] of [["fork-refused", "NATIVE_FORK_UNAVAILABLE"], ["fork-same", "IDENTITY_MISMATCH"]] as const) {
    const other = control(scenario);
    try { await other.initialize(); await assert.rejects(other.fork("thread-source", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === code, scenario); }
    finally { await other.close(); }
  }
});

test("Codex lists its skills, MCP servers and installed plugins and invokes an enabled skill as its own skill input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-skills-")), trace = join(directory, "trace");
  const driver = control("skills", { FIXTURE_TRACE: trace });
  try {
    await driver.initialize();
    assert.deepEqual(await driver.extensions(), {
      skills: [{ name: "review-helper", description: "Reviews code in depth", scope: "user", enabled: true, command: "skill:review-helper" }, { name: "dormant", description: "Disabled skill", scope: "repo", enabled: false }],
      mcpServers: [{ name: "docs", status: "notStarted", auth: "unsupported", tools: 2, failed: false }, { name: "remote", status: "failed", auth: "notLoggedIn", tools: 0, failed: true }],
      plugins: [{ name: "github", enabled: true, version: "1.2.0", source: "openai-curated" }],
    });
    assert.deepEqual((await driver.models()).commands?.map(command => command.name), ["compact", "export", "skill:review-helper"], "only enabled skills become commands");
    const id = await driver.open(process.cwd());
    assert.equal((await (await driver.startText(id, "/skill:review-helper check the diff", () => {})).result).status, "completed");
    assert.equal((await (await driver.startText(id, "/skill:dormant hello", () => {})).result).status, "completed");
    const turns = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(row => row.method === "turn/start").map(row => row.params.input);
    assert.deepEqual(turns[0], [{ type: "text", text: "check the diff", text_elements: [] }, { type: "skill", name: "review-helper", path: "/skills/review-helper/SKILL.md" }]);
    assert.deepEqual(turns[1], [{ type: "text", text: "/skill:dormant hello", text_elements: [] }], "a disabled skill is not invoked");
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
  const older = control("no-skills");
  try { await older.initialize(); assert.deepEqual((await older.models()).commands?.map(command => command.name), ["compact", "export"], "an app-server without skills/list has no skills"); }
  finally { await older.close(); }
});

test("Codex lists this workspace's threads and reads one for continuing it, newest turns first, without resuming it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-threads-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = control("threads", { FIXTURE_TRACE: trace });
  try {
    await driver.initialize();
    const first = await driver.nativeSessions(process.cwd());
    assert.deepEqual(first, { sessions: [{ id: "thread-recent", title: "Recent work", updatedAt: 1700000300000, source: "cli" }], nextCursor: "page-2" }, "other workspaces and ephemeral threads are left out");
    assert.deepEqual(await driver.nativeSessions(process.cwd(), "page-2"), { sessions: [{ id: "thread-older", title: "older question", updatedAt: 1700000100000, source: "subAgent" }], nextCursor: null });
    assert.deepEqual(await driver.importSession("thread-recent", process.cwd()), { checkpoint: "thread-recent", title: "Recent work", omitted: 0, complete: true, historyRead: true,
      history: [{ role: "user", text: "question 1" }, { role: "assistant", text: "answer 1" }, { role: "user", text: "question 2\n[图片]" }, { role: "assistant", text: "answer 2" }, { role: "user", text: "question 3" }, { role: "assistant", text: "answer 3" }] });
    await assert.rejects(driver.importSession("thread-elsewhere", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_WORKSPACE_MISMATCH");
    await assert.rejects(driver.importSession("thread-ephemeral", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_UNAVAILABLE");
    const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    assert.deepEqual(sent.find(row => row.method === "thread/list")?.params, { cwd: process.cwd(), limit: 50, sortKey: "updated_at", sortDirection: "desc", archived: false, sourceKinds: ["cli", "vscode", "exec", "appServer"] });
    assert.ok(!sent.some(row => row.method === "thread/resume" || row.method === "thread/start" || row.method === "turn/start"), "reading a thread never resumes it or sends anything");
  } finally { await driver.close(); }
});

test("Codex shows a sub-agent thread of the turn as an entry with its own tools nested under it, and never its text as the reply", async () => {
  const driver = control("child-tools");
  try {
    const id = await ready(driver), events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(id, "delegate", event => events.push(event))).result).status, "completed");
    const tools = new Map<string, ControlEvent & { type: "tool" }>();
    for (const event of events) if (event.type === "tool") tools.set(event.id, event);
    const agent = tools.get("agent:thread-child"), command = tools.get("thread-child/cmd-1"), nested = tools.get("thread-grandchild/cmd-2");
    assert.equal(agent?.title, "子 Agent · Researcher"); assert.equal(agent?.status, "completed"); assert.equal(agent?.detail?.output, "child report: SUB-OK");
    assert.equal(command?.detail?.parentId, "agent:thread-child"); assert.equal(command?.detail?.output, "SUB-OK"); assert.equal(command?.status, "completed");
    assert.equal(tools.get("agent:thread-grandchild")?.detail?.parentId, "agent:thread-child", "a sub-agent of a sub-agent nests under it");
    assert.equal(nested?.detail?.parentId, "agent:thread-grandchild");
    assert.ok(![...tools.keys()].some(key => key.includes("unrelated")), "work of unrelated threads is never shown");
    assert.equal(tools.get("agent:thread-helper")?.title, "子 Agent · /root/helper", "a sub-agent announced only by its activity item is known too");
    assert.equal(tools.get("thread-helper/cmd-4")?.detail?.parentId, "agent:thread-helper");
    assert.equal(events.filter(event => event.type === "text").map(event => event.type === "text" ? event.text : "").join(""), "你好 fixture", "the sub-agent's report is not the reply");
  } finally { await driver.close(); }
});
test("Codex plan mode is declared only by a connection opened with a chosen mode, and its proposed plan is the reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-plan-"));
  const sent = async (name: string) => (await readFile(join(directory, name), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  const experimental = async (name: string) => ((await sent(name)).find(row => row.method === "initialize")!.params!.capabilities as Record<string, unknown>).experimentalApi;
  // The settings the fixture's threads say they run with.
  const runs = { approval_policy: "never", sandbox: "danger-full-access" };
  try {
    // The app-server's version is kept as evidence; a catalog read never declares the experimental API.
    const reader = control("plan-mode", { FIXTURE_TRACE: join(directory, "reader") });
    try {
      assert.equal((await reader.initialize()).agentVersion, "0.162.1");
      assert.deepEqual((await reader.models()).options?.find(option => option.id === "collaboration_mode")?.values.map(value => value.value), ["default", "plan"]);
    } finally { await reader.close(); }
    assert.equal(await experimental("reader"), false);
    // An app-server that states an older version, or none, is offered the mode too, and plan mode works on it when it lists
    // the modes: what it answers decides, not the version it states (ADR-053).
    for (const scenario of ["plan-old", "basic"]) {
      const trace = join(directory, scenario), offered = control(scenario);
      try { assert.equal((await offered.initialize()).agentVersion, scenario === "plan-old" ? "0.161.0" : null); assert.deepEqual((await offered.models()).options?.find(option => option.id === "collaboration_mode")?.values.map(value => value.value), ["default", "plan"], scenario); }
      finally { await offered.close(); }
      const planning = control(scenario, { FIXTURE_TRACE: trace }, { selectedOptions: { collaboration_mode: "plan" } });
      try {
        await planning.initialize(); const id = await planning.open(process.cwd(), undefined, { collaboration_mode: "plan" });
        assert.equal((await (await planning.startText(id, "plan it", () => {})).result).status, "completed", scenario);
        assert.deepEqual(await planning.nativeConfig(), { model: null, options: { collaboration_mode: "plan", ...runs } }, scenario);
      } finally { await planning.close(); }
      assert.equal(((await sent(scenario)).find(row => row.method === "turn/start")!.params!.collaborationMode as { mode?: string }).mode, "plan", scenario);
    }
    // A Run that chose plan mode declares the API, sends the mode with its model and the plan preset's effort, and shows the plan.
    const planner = control("plan-mode", { FIXTURE_TRACE: join(directory, "planner") }, { selectedOptions: { collaboration_mode: "plan" } });
    try {
      await planner.initialize(); const id = await planner.open(process.cwd(), undefined, { collaboration_mode: "plan" }), events: ControlEvent[] = [];
      assert.equal((await (await planner.startText(id, "plan it", event => events.push(event))).result).status, "completed");
      assert.deepEqual(events.filter(event => event.type === "text").map(event => event.type === "text" ? event.text : ""), ["1. 读代码\n2. 改实现"], "the completed plan, not its drafts");
      // The experimental connection's thread/readState/changed is a known passive notification, not a diagnostic.
      assert.equal(events.some(event => event.type === "diagnostic"), false);
      // The thread keeps the mode this turn set; that is what the connection reports, with the settings the thread runs with.
      assert.deepEqual(await planner.nativeConfig(), { model: null, options: { collaboration_mode: "plan", ...runs } });
    } finally { await planner.close(); }
    // A new thread that follows the native configuration reports the settings it runs with; thread/start states no mode.
    const follower = control("plan-mode");
    try {
      await follower.initialize(); const id = await follower.open(process.cwd());
      assert.equal((await (await follower.startText(id, "continue", () => {})).result).status, "completed");
      assert.deepEqual(await follower.nativeConfig(), { model: null, options: runs });
    } finally { await follower.close(); }
    const planned = await sent("planner");
    assert.equal(await experimental("planner"), true);
    assert.deepEqual(planned.find(row => row.method === "turn/start")!.params!.collaborationMode, { mode: "plan", settings: { model: "native-model-a", reasoning_effort: "high", developer_instructions: null } });
    // Opening a thread validates the choice without the account or skill reads a catalog makes.
    assert.equal(planned.some(row => row.method === "account/read" || row.method === "skills/list"), false);
    // Choosing the default mode afterwards sends it explicitly, so the thread leaves plan mode.
    const back = control("plan-mode", { FIXTURE_TRACE: join(directory, "back") }, { selectedOptions: { collaboration_mode: "default" } });
    try {
      await back.initialize(); const id = await back.open(process.cwd(), undefined, { collaboration_mode: "default" }), events: ControlEvent[] = [];
      assert.equal((await (await back.startText(id, "do it", event => events.push(event))).result).status, "completed");
      assert.ok(events.some(event => event.type === "text" && event.text === "你好 fixture"));
      assert.deepEqual(await back.nativeConfig(), { model: null, options: { collaboration_mode: "default", ...runs } });
    } finally { await back.close(); }
    assert.deepEqual((await sent("back")).find(row => row.method === "turn/start")!.params!.collaborationMode, { mode: "default", settings: { model: "native-model-a", reasoning_effort: null, developer_instructions: null } });
    // A connection that was not prepared for the mode refuses it before a thread is opened.
    const unprepared = control("plan-mode", { FIXTURE_TRACE: join(directory, "unprepared") });
    try {
      await unprepared.initialize();
      await assert.rejects(unprepared.open(process.cwd(), undefined, { collaboration_mode: "plan" }), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_OPTION_UNAVAILABLE");
      assert.equal((await sent("unprepared")).some(row => row.method === "thread/start" || row.method === "collaborationMode/list"), false);
    } finally { await unprepared.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("a Codex without collaboration modes is still offered the option, and a Run that chooses one fails before any thread opens, saying why (ADR-053)", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-collab-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const reader = control("collab-missing");
  try { await reader.initialize(); assert.deepEqual((await reader.models()).options?.map(option => option.id), ["collaboration_mode", "approval_policy", "sandbox"], "the options are offered before anything is known"); }
  finally { await reader.close(); }
  const planning = control("collab-missing", { FIXTURE_TRACE: trace }, { selectedOptions: { collaboration_mode: "plan" } });
  try {
    await planning.initialize();
    await assert.rejects(planning.open(process.cwd(), undefined, { collaboration_mode: "plan" }), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_OPTION_UNAVAILABLE"
      && error.message === "这个 Codex 不提供协作模式：它没有 collaborationMode/list 方法（-32601）。");
  } finally { assert.equal((await planning.close()).protocolFailure?.code, "NATIVE_OPTION_UNAVAILABLE"); }
  const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { method?: string }).method);
  assert.ok(sent.includes("collaborationMode/list")); assert.equal(sent.some(method => method === "thread/start" || method === "turn/start"), false);
});
test("Codex reports a thread's settings as the thread states them: thread/resume's collaboration mode when following the native configuration, only values an option knows", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-report-")); t.after(() => rm(directory, { recursive: true, force: true }));
  /** One turn on a thread that follows the native configuration (resumed when a checkpoint is given), then the report. */
  const turn = async (driver: CodexControl, checkpoint?: string) => {
    await driver.initialize(); const id = await driver.open(process.cwd(), undefined, undefined, checkpoint);
    assert.equal((await (await driver.startText(id, "hello", () => {})).result).status, "completed"); return driver.nativeConfig();
  };
  const runs = { approval_policy: "never", sandbox: "danger-full-access" };
  // A resumed thread that follows the native configuration reports the mode thread/resume states.
  const resumed = control("basic", { FIXTURE_THREAD_MODE: "plan" });
  try { assert.deepEqual(await turn(resumed, "thread-fixture"), { model: null, options: { ...runs, collaboration_mode: "plan" } }); } finally { await resumed.close(); }
  // A mode the turn sets and Codex accepts is the thread's from then on, whatever the resume said before it.
  const chosen = control("basic", { FIXTURE_THREAD_MODE: "plan" }, { selectedOptions: { collaboration_mode: "default" } });
  try {
    await chosen.initialize(); const id = await chosen.open(process.cwd(), undefined, { collaboration_mode: "default" }, "thread-fixture");
    assert.equal((await (await chosen.startText(id, "hello", () => {})).result).status, "completed");
    assert.deepEqual(await chosen.nativeConfig(), { model: null, options: { ...runs, collaboration_mode: "default" } });
  } finally { await chosen.close(); }
  // A mode this connection chose that no turn confirmed is not the thread's: on a new thread only the settings are reported.
  const refused = control("prompt-rejected", {}, { selectedOptions: { collaboration_mode: "plan" } });
  try {
    await refused.initialize(); const id = await refused.open(process.cwd(), undefined, { collaboration_mode: "plan" });
    assert.equal((await (await refused.startText(id, "hello", () => {})).result).status, "failed");
    assert.deepEqual(await refused.nativeConfig(), { model: null, options: runs });
  } finally { await refused.close(); }
  // A resumed thread whose mode is not known reports nothing, so the mode reported earlier stands; so does one whose mode is
  // not a mode Codex offers.
  for (const env of [{}, { FIXTURE_THREAD_MODE: "review" }]) {
    const unknown = control("basic", env);
    try { assert.equal(await turn(unknown, "thread-fixture"), null, JSON.stringify(env)); } finally { await unknown.close(); }
  }
  // Values no option knows are left out, never replaced by a default.
  const odd = control("basic", { FIXTURE_THREAD_MODE: "default", FIXTURE_THREAD_POLICY: "odd" });
  try { assert.deepEqual(await turn(odd, "thread-fixture"), { model: null, options: { collaboration_mode: "default" } }); } finally { await odd.close(); }
  const nothing = control("basic", { FIXTURE_THREAD_POLICY: "odd" });
  try { assert.equal(await turn(nothing), null, "a new thread that states nothing an option knows"); } finally { await nothing.close(); }
});
