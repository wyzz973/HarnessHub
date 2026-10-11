import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ControlEvent, ControlOptions } from "../../src/contracts/control.js";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { OpenClawControl } from "../../src/adapters/control/factory.js";
import { CursorControl } from "../../src/adapters/control/cursor.js";
import { OpenCodeControl, parseOpenCodeModels } from "../../src/adapters/control/opencode.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { bindNativeDependencies } from "../../src/adapters/control/native-dependencies.js";
import { contentId } from "../../src/contracts/content.js";

const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1500,
  maxFrameBytes: 65536, maxDiagnosticBytes: 1024, closeGraceMs: 150 };
test("Claude ACP resolves the original native executable and never substitutes a bundled CLI for a missing explicit path", async t => {
  const root = await mkdtemp(join(tmpdir(), "claude-native-dependency-")); t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(process.execPath, join(root, "claude"));
  const launch = { executable: process.execPath, args: [], env: { PATH: root, HOME: root }, protocol: "acp-v1" as const };
  assert.equal((await bindNativeDependencies("claude", launch)).env.CLAUDE_CODE_EXECUTABLE, process.execPath);
  await assert.rejects(bindNativeDependencies("claude", { ...launch, env: { ...launch.env, CLAUDE_CODE_EXECUTABLE: join(root, "absent") } }), /explicitly selected native/);
});
function control(scenario = "basic", env: Record<string, string> = {}, overrides: Partial<ControlOptions> = {}): AcpControl {
  return new AcpControl({ protocol: "acp-v1", executable: process.execPath,
    args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", scenario], env }, { ...options, ...overrides });
}
async function ready(driver: AcpControl) { await driver.initialize(); return driver.open(process.cwd()); }

test("ACP handshake, sequential prompts and exact client capability declaration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-")), trace = join(directory, "trace");
  const driver = control("split", { FIXTURE_TRACE: trace });
  try {
    const observation = await driver.initialize(); assert.equal(observation.protocolVersion, 1);
    assert.equal(observation.agentName, "fixture"); assert.deepEqual(observation.authenticationMethods, ["fixture-login"]);
    const id = await driver.open(process.cwd()), events: ControlEvent[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await driver.startText(id, "hello", event => events.push(event));
      assert.deepEqual(await run.result, { status: "completed", reason: "end_turn" });
    }
    assert.deepEqual(events.filter(event => event.type === "text"), [{ type: "text", text: "你好 fixture" }, { type: "text", text: "你好 fixture" }]);
    const messages: unknown[] = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    // Only session notice/compaction updates are requested; filesystem and terminal capabilities stay undeclared.
    assert.ok(messages.some(message => JSON.stringify(message).includes('"clientCapabilities":{"session":{"notices":{},"compaction":{}}}')));
    assert.ok(messages.some(message => JSON.stringify(message).includes('"mcpServers":[]')));
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("ACP rejects incompatible protocol negotiation and closes its process", async () => {
  const driver = control("version");
  try { await assert.rejects(driver.initialize(), /ACP v1/); } finally { assert.equal((await driver.close()).closed, true); }
});
test("ACP validates operation ordering and connection ownership", async () => {
  const driver = control();
  try {
    await assert.rejects(driver.open(process.cwd()), /not initialized/);
    const id = await ready(driver); await assert.rejects(driver.open(process.cwd()), /already owns/);
    await assert.rejects(driver.startText(id, "", () => {}), /contain text/);
  } finally { await driver.close(); }
});
test("ACP stops are idempotent receipts distinct from the prompt result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-stop-")), trace = join(directory, "trace");
  const driver = control("stop", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver), run = await driver.startText(id, "hello", () => {});
    await assert.rejects(driver.startText(id, "other", () => {}), /already active/);
    let settled = false; void run.result.then(() => { settled = true; });
    const first = run.requestStop(); assert.equal(run.requestStop(), first);
    assert.deepEqual(await first, { requested: true }); assert.equal(settled, false);
    assert.deepEqual(await run.result, { status: "cancelled", reason: "cancelled" });
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(messages.filter(message => message.method === "session/cancel").length, 1);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("ACP permission selects the actual reject option rather than approving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-permission-")), trace = join(directory, "trace");
  const driver = control("permission", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver), events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event));
    await run.result;
    assert.deepEqual(events[0], { type: "permission", id: "permission-1", decision: "denied" });
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(messages.find(message => message.id === "permission-1").result, { outcome: { outcome: "selected", optionId: "reject" } });
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("ACP permission arriving during stop is cancelled", async () => {
  const driver = control("stop-permission");
  try {
    const id = await ready(driver), events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event));
    await run.requestStop(); assert.equal((await run.result).status, "cancelled");
    assert.ok(events.some(event => event.type === "permission" && event.decision === "cancelled"));
  } finally { await driver.close(); }
});
test("ACP unknown client method is explicitly unsupported and audited on the Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-unknown-")), trace = join(directory, "trace");
  const driver = control("unknown-method", { FIXTURE_TRACE: trace });
  try {
    const events: ControlEvent[] = [], id = await ready(driver), run = await driver.startText(id, "hello", event => events.push(event));
    assert.equal((await run.result).status, "completed");
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(messages.find(message => message.id === "unsupported").error.code, -32601);
    assert.ok(events.some(event => event.type === "diagnostic" && event.message === "Harness called unsupported client method fixture/unsupported"));
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
for (const [scenario, expected] of [["wrong-identity", /another session/], ["duplicate-permission", /repeated an RPC request/],
  ["exit-zero", /exited/], ["no-settlement", /deadline/]]) test(`ACP rejects ${scenario} without manufacturing a result`, async () => {
    const driver = control(scenario as string, {}, { runTimeoutMs: 100 });
    try { const id = await ready(driver), run = await driver.startText(id, "hello", () => {}); await assert.rejects(run.result, expected as RegExp); }
    finally { await driver.close(); }
  });
test("ACP callback exception aborts the run and still cleans owned resources", async () => {
  const driver = control();
  try { const id = await ready(driver), run = await driver.startText(id, "hello", () => { throw new Error("consumer failed"); }); await assert.rejects(run.result, /consumer failed/); }
  finally { assert.equal((await driver.close()).closed, true); }
});
test("ACP refusal is a failed backend outcome rather than task success", async () => {
  const driver = control("refusal");
  try { const id = await ready(driver), run = await driver.startText(id, "hello", () => {}); assert.equal((await run.result).status, "failed"); }
  finally { await driver.close(); }
});
test("ACP close during an active unsettled prompt rejects its result", async () => {
  const driver = control("no-settlement");
  const id = await ready(driver), run = await driver.startText(id, "hello", () => {});
  const rejected = assert.rejects(run.result, /closed/);
  await driver.close(); await rejected; await assert.rejects(driver.initialize(), /closed/);
});
test("ACP closing an unstarted control prevents future process startup", async () => {
  const driver = control(); await driver.close(); await assert.rejects(driver.initialize(), /closed/);
  await assert.rejects(driver.open(process.cwd()), /closed/);
});
test("ACP passive unknown notifications expose only method diagnostics", async () => {
  const driver = control("passive");
  try {
    const id = await ready(driver), events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event)); await run.result;
    assert.ok(events.some(event => event.type === "diagnostic" && event.message.includes("fixture/passive")));
    assert.ok(!JSON.stringify(events).includes("must-not-leak"));
  } finally { await driver.close(); }
});
test("ACP duplicate terminal response retains first backend fact but exposes connection failure at close", async () => {
  const driver = control("duplicate-complete");
  try {
    const id = await ready(driver), run = await driver.startText(id, "hello", () => {});
    assert.deepEqual(await run.result, { status: "completed", reason: "end_turn" });
    const cleanup = await driver.close(); assert.equal(cleanup.closed, true);
    assert.equal(cleanup.protocolFailure?.code, "UNKNOWN_RESPONSE");
  } finally { await driver.close(); }
});

test("an explicit ACP prompt rejection is a failed backend result with a cleanly owned connection", async () => {
  const driver = control("prompt-rejected");
  try {
    const id = await ready(driver), output: ControlEvent[] = [], run = await driver.startText(id, "rejected request", value => output.push(value));
    assert.deepEqual(await run.result, { status: "failed", reason: "request_rejected" }); assert.deepEqual(output, []);
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
for (const [scenario, code] of [["quota-rejected", "NATIVE_QUOTA_EXCEEDED"], ["auth-rejected", "NATIVE_AUTH_REQUIRED"]] as const)
  test(`ACP ${scenario} exposes an actionable category without remote secrets`, async () => {
    const driver = control(scenario);
    try {
      const result = await (await driver.startText(await ready(driver), "test", () => {})).result;
      assert.equal(result.status, "failed"); assert.equal(result.error?.code, code);
      assert.equal(JSON.stringify(result).includes("private-synthetic-key"), false);
      assert.equal((await driver.close()).protocolFailure, null);
    } finally { await driver.close(); }
  });
test("an unsupported native client fails session creation with a safe reason and awaited cleanup", async () => {
  const driver = control("unsupported-client");
  try {
    await assert.rejects(ready(driver), error => error !== null && typeof error === "object" && "code" in error && error.code === "NATIVE_CLIENT_UNSUPPORTED" && !String(error).includes("private-synthetic-key"));
    assert.equal((await driver.close()).protocolFailure?.code, "NATIVE_CLIENT_UNSUPPORTED");
  } finally { await driver.close(); }
});

test("ACP preserves an installed peer's configured model outside its suggested catalog", async () => {
  const driver = control("legacy-configured-model");
  try {
    await driver.initialize(); const id = await driver.open(process.cwd(), "configured-model");
    const catalog = await driver.models();
    assert.equal(catalog.defaultModel, "configured-model"); assert.equal(catalog.canSelect, true);
    assert.deepEqual(catalog.models.map(row => row.id), ["suggested-model", "configured-model"]);
    assert.equal((await (await driver.startText(id, "keep the configured model", () => {})).result).status, "completed");
  } finally { assert.equal((await driver.close()).closed, true); }
});
test("ACP model discovery still rejects duplicate model identities", async () => {
  const driver = control("duplicate-models");
  try { await driver.initialize(); await assert.rejects(driver.open(process.cwd()), /identity mismatch/); }
  finally { assert.equal((await driver.close()).closed, true); }
});
test("ACP accepts owned initialization metadata before session/new returns, as installed OpenClaw does", async () => {
  const driver = control("opening-metadata");
  try { const id = await ready(driver), run = await driver.startText(id, "hello", () => {}); assert.equal((await run.result).status, "completed"); }
  finally { assert.equal((await driver.close()).protocolFailure, null); }
});
for (const scenario of ["opening-wrong-identity", "opening-flood", "opening-text"]) test(`ACP rejects ${scenario} during session creation`, async () => {
  const driver = control(scenario);
  try { await driver.initialize(); await assert.rejects(driver.open(process.cwd())); }
  finally { assert.equal((await driver.close()).closed, true); }
});
test("OpenClaw uses the configured default agent and a canonical normal chat namespace without exposing native credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-openclaw-")), trace = join(root, "trace"), config = join(root, "openclaw.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(config, '{agents:{list:[{id:"first"},{id:"chosen",default:true}],defaults:{model:{primary:"configured/model"}}},models:{secret:"synthetic-private-secret"}}');
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: config, FIXTURE_TRACE: trace };
  const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "opening-metadata"], env }, { ...options, env }, async () => ({ models: [{provider:"configured",id:"model",name:"Configured"}] }));
  try {
    const id = await ready(driver); assert.equal((await (await driver.startText(id, "test", () => {})).result).status, "completed");
    const models = await driver.models(); assert.equal(models.defaultModel, "configured/model"); assert.equal(models.canSelect, true);
    const wire = await readFile(trace, "utf8"), sent = wire.trim().split("\n").map(row => JSON.parse(row)).find(row => row.method === "session/new");
    assert.match(sent.params._meta.sessionKey, /^agent:chosen:harnesshub:[0-9a-f-]{36}$/u); assert.equal(wire.includes("synthetic-private-secret"), false);
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP restores native state in another original process without duplicating replayed output", async () => {
  const first = control("native-resume"); let checkpoint: string | null = null;
  try { const id = await ready(first); await (await first.startText(id, "first", () => {})).result; checkpoint = await first.checkpoint(); }
  finally { await first.close(); }
  assert.ok(checkpoint);
  const restored = control("native-resume");
  try {
    await restored.initialize(); const id = await restored.open(process.cwd(), undefined, undefined, checkpoint);
    assert.equal(await restored.checkpoint(), checkpoint);
    const events: ControlEvent[] = []; await (await restored.startText(id, "second", event => events.push(event))).result;
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), ["你好 fixture"]);
    assert.equal(events.filter(event => event.type === "tool").length, 0);
  } finally { await restored.close(); }
});
for (const scenario of ["basic", "resume-fails", "resume-wrong-identity"]) test(`ACP ${scenario} refuses unavailable or misowned restore without a new conversation`, async () => {
  const driver = control(scenario);
  try { await driver.initialize(); await assert.rejects(driver.open(process.cwd(), undefined, undefined, "session-fixture")); }
  finally { assert.equal((await driver.close()).closed, true); }
});

test("ACP autonomous output after a prompt is never attributed and its permission request is cancelled without tearing down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-late-")), trace = join(directory, "trace");
  const driver = control("late-output", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver), events: ControlEvent[] = [];
    assert.deepEqual(await (await driver.startText(id, "hello", event => events.push(event))).result, { status: "completed", reason: "end_turn" });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.type === "text" ? event.text : ""), ["你好 fixture"]);
    const wire = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { id?: unknown; result?: unknown });
    assert.deepEqual(wire.find(row => row.id === "late-permission")?.result, { outcome: { outcome: "cancelled" } });
    assert.equal(driver.unattributedUpdates, 2);
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("ACP keeps a resumed model that its picker does not list instead of failing the session", async () => {
  const driver = control("unlisted-model");
  try {
    await ready(driver); const catalog = await driver.models();
    assert.ok(catalog.models.some(row => row.id === "resumed-unlisted")); assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
test("ACP merges repeated tool identities, sanitizes multi-line titles and survives non-text message content", async () => {
  const driver = control("tool-merge");
  try {
    const id = await ready(driver), events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(id, "hello", event => events.push(event))).result).status, "completed");
    const tools = events.flatMap(event => event.type === "tool" ? [event] : []);
    assert.deepEqual(tools.map(tool => [tool.id, tool.title, tool.status]), [["merged", "printf 'a' printf 'b'", "pending"], ["merged", "printf 'a' printf 'b'", "pending"], ["late-announced", "工具调用", "completed"]]);
    assert.ok(events.some(event => event.type === "output" && event.output.kind === "content" && event.output.mediaType === "image/png"));
    assert.ok(events.some(event => event.type === "text"));
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});

test("ACP keeps trailing session/load history out of the next reply", async () => {
  const driver = control("load-trailing-replay");
  try {
    await driver.initialize(); const id = await driver.open(process.cwd(), undefined, undefined, "session-fixture"), events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(id, "hello", event => events.push(event))).result).status, "completed");
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.type === "text" ? event.text : ""), ["你好 fixture"]);
  } finally { await driver.close(); }
});
test("Cursor exposes its native models read-only and never performs the global model switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-cursor-")), trace = join(directory, "trace");
  const launch = { protocol: "acp-v1" as const, executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "native-models"], env: { FIXTURE_TRACE: trace } };
  const reader = new CursorControl(launch, options), driver = new CursorControl(launch, options);
  try {
    await reader.initialize(); await reader.open(process.cwd()); const catalog = await reader.models();
    assert.equal(catalog.canSelect, false); assert.equal(catalog.selectionError?.code, "NATIVE_MODEL_SWITCH_GLOBAL"); assert.ok(catalog.models.length > 0);
    await driver.initialize(); await assert.rejects(driver.open(process.cwd(), "native-model-b"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_MODEL_SWITCH_GLOBAL");
    const wire = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string });
    assert.equal(wire.filter(row => row.method === "session/set_config_option" || row.method === "session/set_model").length, 0);
  } finally { await reader.close(); await driver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("ACP maps native tool detail, plan, usage, notices, compaction and non-text output", async () => {
  const driver = control("native-activity");
  try {
    const id = await ready(driver), events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(id, "work", event => events.push(event))).result).status, "completed");
    // Each update carries the fields it changed; the Runtime merges them the same way.
    const tool = { detail: Object.assign({}, ...events.flatMap(event => event.type === "tool" && event.id === "edit-1" ? [event.detail ?? {}] : [])) as import("../../src/contracts/control.js").NativeToolDetail };
    assert.equal(tool?.detail?.kind, "edit"); assert.equal(tool?.detail?.name, "Edit"); assert.equal(tool?.detail?.parentId, "parent-task");
    assert.equal(tool?.detail?.input, "{\n  \"file_path\": \"/w/a.txt\"\n}"); assert.equal(tool?.detail?.output, "edited");
    assert.equal(tool?.detail?.diff, "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n"); assert.deepEqual(tool?.detail?.locations, ["/w/a.txt:2"]);
    const shell = events.flatMap(event => event.type === "tool" && event.id === "shell-1" ? [event] : []).at(-1);
    assert.equal(shell?.detail?.input, "ls -la");
    assert.deepEqual(events.find(event => event.type === "plan"), { type: "plan", entries: [{ content: "Read", status: "completed", priority: "high" }, { content: "Edit", status: "in_progress", priority: "medium" }] });
    assert.deepEqual(events.filter(event => event.type === "usage").map(event => event.type === "usage" ? event.usage : null), [
      { context: { used: 1200, size: 200000 }, cost: { amount: 0.25, currency: "USD", scope: "session" } },
      { turn: { input: 900, output: 300, cachedInput: 50, total: 1250 } }]);
    assert.deepEqual(events.find(event => event.type === "notice"), { type: "notice", severity: "warning", title: "Model fallback", detail: "switched model" });
    assert.deepEqual(events.filter(event => event.type === "activity"), [
      { type: "activity", id: "compact-1", kind: "compaction", title: "上下文压缩", status: "running" },
      { type: "activity", id: "compact-1", kind: "compaction", title: "上下文压缩", status: "completed", detail: "summary text" }]);
    const outputs = events.flatMap(event => event.type === "output" ? [event.output] : []);
    assert.equal(outputs[0]?.kind, "content"); assert.equal(outputs[0]?.kind === "content" ? Buffer.from(outputs[0].data).toString() : "", "png!");
    assert.deepEqual(outputs[1], { kind: "link", uri: "https://example.invalid/report", name: "report", title: "Report" });
  } finally { await driver.close(); }
});

function attachment(directory: string, name: string, mediaType: string, kind: "image" | "audio" | "file", data: Buffer) {
  const path = join(directory, name); writeFileSync(path, data);
  return { id: contentId("content-" + name.replace(/[^a-z0-9]/giu, "")), name, mediaType, kind, bytes: data.length, sha256: "0".repeat(64), path };
}
test("ACP sends attachments as native content blocks within the agent's declared prompt capabilities", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-attachments-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const png = attachment(directory, "shot.png", "image/png", "image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
  const notes = attachment(directory, "notes.md", "text/markdown", "file", Buffer.from("# 标题\n"));
  const pdf = attachment(directory, "doc.pdf", "application/pdf", "file", Buffer.from("%PDF-1.4"));
  const wav = attachment(directory, "voice.wav", "audio/wav", "audio", Buffer.from("RIFF\0\0\0\0WAVE"));
  const driver = control("attachments", { FIXTURE_TRACE: trace });
  try {
    const id = await ready(driver);
    assert.deepEqual((await driver.models()).inputs, { image: true, audio: true, file: true });
    await driver.checkAttachments([png, wav, notes, pdf]);
    assert.equal((await (await driver.startText(id, "look", () => {}, [png, wav, notes, pdf])).result).status, "completed");
    const prompt = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(row => row.method === "session/prompt").params.prompt;
    assert.deepEqual(prompt, [
      { type: "text", text: "look" },
      { type: "image", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64"), mimeType: "image/png" },
      { type: "audio", data: Buffer.from("RIFF\0\0\0\0WAVE").toString("base64"), mimeType: "audio/wav" },
      { type: "resource", resource: { uri: pathToFileURL(notes.path).href, mimeType: "text/markdown", text: "# 标题\n" } },
      { type: "resource_link", uri: pathToFileURL(pdf.path).href, name: "doc.pdf", mimeType: "application/pdf", size: 8 },
    ]);
  } finally { await driver.close(); }
  // Without declared image or audio support, those are refused before anything is sent; files always have a link form.
  const plain = control("basic");
  try {
    await ready(plain); assert.deepEqual((await plain.models()).inputs, { image: false, audio: false, file: true });
    for (const item of [png, wav]) await assert.rejects(plain.checkAttachments([item]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_UNSUPPORTED" && error.message.includes(item.name));
    await plain.checkAttachments([pdf]);
  } finally { await plain.close(); }
});
test("OpenClaw refuses images its Gateway would drop or its running model cannot see", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-attachments-")); t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = async () => ({ models: [{ provider: "vision", id: "large", name: "Vision", input: ["text", "image"] }, { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", input: ["text"] }] });
  const image = { ...attachment(root, "big.png", "image/png", "image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), bytes: 5_000_001 };
  for (const [model, check] of [["vision/large", async (driver: OpenClawControl) => {
    await assert.rejects(driver.checkAttachments([image]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_LIMIT" && error.message.includes("big.png"));
    await driver.checkAttachments([{ ...image, bytes: 5_000_000 }]);
  }], ["deepseek/deepseek-chat", async (driver: OpenClawControl) => {
    assert.deepEqual((await driver.models()).models.find(row => row.id === "deepseek/deepseek-chat")?.inputs, { image: false, audio: false, file: true });
    await assert.rejects(driver.checkAttachments([{ ...image, bytes: 10 }]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_UNSUPPORTED");
  }]] as const) {
    const config = join(root, "openclaw.json"); await writeFile(config, `{agents:{list:[{id:"main",default:true}],defaults:{model:{primary:"${model}"}}}}`);
    const env = { HOME: root, OPENCLAW_CONFIG_PATH: config };
    const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "attachments"], env }, { ...options, env }, catalog);
    try { await ready(driver); await check(driver); } finally { await driver.close(); }
  }
});
test("OpenCode refines agent image support with each model's input kinds from the original CLI catalog", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencode-attachments-")); t.after(() => rm(root, { recursive: true, force: true }));
  const verbose = (id: string, image: boolean) => id + "\n" + JSON.stringify({ id: id.split("/")[1], providerID: id.split("/")[0], capabilities: { attachment: image, input: { text: true, audio: false, image, video: false, pdf: false } } }, null, 2) + "\n";
  assert.deepEqual([...parseOpenCodeModels(verbose("opencode/big-pickle", false) + "broken/model\n{\n  not json\n}\n" + verbose("vision/eye", true))], [["opencode/big-pickle", { image: false, audio: false }], ["vision/eye", { image: true, audio: false }]]);
  // An executable that is the original CLI for both `acp` and `models --verbose`.
  const shim = join(root, "opencode-fixture.mjs");
  await writeFile(shim, `#!${process.execPath}\nif (process.argv[2] === "models") { process.stdout.write(${JSON.stringify(verbose("native/model-a", false) + verbose("native/model-b", true))}); }\nelse { process.argv.splice(2, process.argv.length, "acp-v1", "attachments"); await import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/control-peer.mjs")).href)}); }\n`, { mode: 0o700 });
  const driver = new OpenCodeControl({ protocol: "acp-v1", executable: shim, args: ["acp"], env: {} }, options);
  const image = attachment(root, "shot.png", "image/png", "image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    await ready(driver);
    const catalog = await driver.models();
    assert.deepEqual(catalog.models.map(row => [row.id, row.inputs?.image]), [["native/model-a", false], ["native/model-b", true]]);
    await assert.rejects(driver.checkAttachments([image]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_UNSUPPORTED", "the configured model cannot see images");
  } finally { await driver.close(); }
  const vision = new OpenCodeControl({ protocol: "acp-v1", executable: shim, args: ["acp"], env: {} }, options);
  try { await vision.initialize(); await vision.open(process.cwd(), "native/model-b"); await vision.checkAttachments([image]); }
  finally { await vision.close(); }
  // Without the original catalog the agent-level declaration stands.
  const plain = new OpenCodeControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "attachments"], env: {} }, options);
  try { await ready(plain); assert.equal((await plain.models()).models.every(row => row.inputs === undefined), true); await plain.checkAttachments([image]); }
  finally { await plain.close(); }
});

test("ACP catalog reads wait briefly for the agent's command announcement instead of racing it", async () => {
  const late = control("late-commands");
  try { await ready(late); const started = Date.now(); assert.deepEqual((await late.models()).commands, [{ name: "late", description: "arrives after session creation" }]); assert.ok(Date.now() - started < 1400, "the announcement ends the wait"); }
  finally { await late.close(); }
  const silent = control("basic");
  try { await ready(silent); assert.deepEqual((await silent.models()).commands, []); const started = Date.now(); await silent.models(); assert.ok(Date.now() - started < 200, "the bounded wait happens once"); }
  finally { await silent.close(); }
});

test("ACP forks a session only when the agent declares it, ignoring the copy's replay", async () => {
  const driver = control("forkable");
  try {
    await driver.initialize();
    assert.equal(await driver.fork("session-source", process.cwd()), "session-forked");
    assert.equal(driver.unattributedUpdates, 2, "the replayed history of the copy is counted, never attributed");
    await assert.rejects(driver.open(process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "INVALID_STATE", "a fork connection opens nothing else");
  } finally { await driver.close(); }
  const undeclared = control("basic");
  try { await undeclared.initialize(); await assert.rejects(undeclared.fork("session-source", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_FORK_UNAVAILABLE"); }
  finally { await undeclared.close(); }
});

test("OpenClaw reconciles each turn from its own transcript: tools, reasoning, usage and the real stop reason", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-transcript-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "openclaw.json"); await writeFile(config, '{agents:{list:[{id:"main",default:true}]}}');
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: config };
  const earlier = { role: "assistant", content: [{ type: "text", text: "earlier turn" }], usage: { input: 999, output: 999 }, stopReason: "stop", __openclaw: { seq: 5 } };
  const turn = (stop: string, extra: Record<string, unknown> = {}) => [earlier,
    { role: "user", content: [{ type: "text", text: "run it" }], __openclaw: { seq: 6 } },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan the command" }, { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "echo HH" } }], usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 130, cost: { total: 0.002 } }, stopReason: "toolUse", __openclaw: { seq: 7 } },
    { role: "toolResult", toolCallId: "call-1", toolName: "exec", content: [{ type: "text", text: "HH" }], isError: false, __openclaw: { seq: 8 } },
    { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 150, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 155, cost: { total: 0.001 } }, stopReason: stop, ...extra, __openclaw: { seq: 9 } }];
  for (const [stop, extra, expected] of [["stop", {}, { status: "completed", reason: "end_turn" }],
    ["error", { errorMessage: "You've hit your weekly limit" }, { status: "failed", reason: "native_error", error: { code: "NATIVE_QUOTA_EXCEEDED", message: "这个 Harness 的账号额度已用完。可等待额度恢复，或选择其他 Harness 继续。" } }]] as const) {
    let reads = 0;
    const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "basic"], env }, { ...options, env },
      async method => method === "sessions.get" ? { messages: reads++ === 0 ? [earlier] : turn(stop, extra) } : { models: [] });
    try {
      const id = await ready(driver), events: ControlEvent[] = [];
      assert.deepEqual(await (await driver.startText(id, "run it", event => events.push(event))).result, expected);
      const tool = events.find(event => event.type === "tool");
      assert.deepEqual(tool, { type: "tool", id: "call-1", title: "exec: echo HH", status: "completed", detail: { kind: "execute", name: "exec", input: "{\n  \"command\": \"echo HH\"\n}", output: "HH" } });
      assert.deepEqual(events.filter(event => event.type === "thinking").map(event => event.type === "thinking" ? event.text : ""), ["plan the command\n"]);
      assert.deepEqual(events.find(event => event.type === "usage"), { type: "usage", usage: { turn: { input: 250, output: 25, cachedInput: 10, cacheWrite: 0, total: 285 }, cost: { amount: 0.003, currency: "USD", scope: "turn" } } }, "only this turn's calls are counted");
    } finally { await driver.close(); }
  }
});
