import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ControlEvent, ControlLaunch, ControlOptions } from "../../src/contracts/control.js";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { OpenClawControl } from "../../src/adapters/control/factory.js";
import { CursorControl } from "../../src/adapters/control/cursor.js";
import { classifyRemoteFailure, ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { bindNativeDependencies } from "../../src/adapters/control/native-dependencies.js";
import { contentId } from "../../src/contracts/content.js";
import { HUB_PROGRESS_INSTRUCTIONS } from "../../src/contracts/table.js";
import { sessionEntryOf } from "../../src/contracts/flavor.js";
import { claudeFlavor } from "../../src/adapters/flavors/claude.js";

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

test("a start that is slow but not stuck is waited for: the handshake takes the startup time, not the plain request time, and a start that runs out of it names the step", async () => {
  // A program that answers its handshake after 400 ms, with a plain request deadline of 100 ms: without a startup time it fails, with one it starts.
  const slow = { FIXTURE_INITIALIZE_DELAY_MS: "400" };
  const refused = control("basic", slow, { requestTimeoutMs: 100, runTimeoutMs: 5000 });
  try { await assert.rejects(refused.initialize(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_INITIALIZE_TIMEOUT"); } finally { await refused.close(); }
  const patient = control("basic", slow, { requestTimeoutMs: 100, runTimeoutMs: 5000, startupTimeoutMs: 3000 });
  try { assert.equal((await patient.initialize()).protocolVersion, 1); } finally { await patient.close(); }
  // A handshake that never comes ends at the startup time, and the failure says it was the handshake that was waited for.
  const stuck = control("timeout", {}, { requestTimeoutMs: 100, startupTimeoutMs: 250 });
  const started = performance.now();
  try {
    await assert.rejects(stuck.initialize(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_INITIALIZE_TIMEOUT");
    assert.ok(performance.now() - started >= 240 && performance.now() - started < 2500, "waited the startup time, not the request time and not for ever");
  } finally { await stuck.close(); }
});

test("ACP handshake, sequential prompts and exact client capability declaration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-")), trace = join(directory, "trace");
  const driver = control("split", { FIXTURE_TRACE: trace });
  try {
    const observation = await driver.initialize(); assert.equal(observation.protocolVersion, 1);
    assert.equal(observation.agentName, "fixture"); assert.deepEqual(observation.authenticationMethods, ["fixture-login"]);
    const id = await driver.open(process.cwd()), events: ControlEvent[] = [];
    for (let i = 0; i < 2; i++) {
      const run = await driver.startText(id, "hello", event => events.push(event));
      assert.deepEqual(await run.result, { status: "completed", reason: "end_turn", input: "recorded" });
    }
    assert.deepEqual(events.filter(event => event.type === "text"), [{ type: "text", text: "你好 fixture" }, { type: "text", text: "你好 fixture" }]);
    const messages: unknown[] = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    // Only session notice/compaction updates are requested; filesystem and terminal capabilities stay undeclared.
    assert.ok(messages.some(message => JSON.stringify(message).includes('"clientCapabilities":{"session":{"notices":{},"compaction":{}},"elicitation":{"form":{}}}')));
    assert.ok(messages.some(message => JSON.stringify(message).includes('"mcpServers":[]')));
  } finally { await driver.close(); await rm(directory, { recursive: true, force: true }); }
});
test("remote failures are classified by the provider's own words, and only an ACP peer's -32000 means authentication", () => {
  const samples: readonly (readonly [string, string | undefined])[] = [
    ["Authentication Fails (no such user)", "NATIVE_AUTH_REQUIRED"], ["Error code: 401 - invalid api key", "NATIVE_AUTH_REQUIRED"],
    ["Insufficient Balance", "NATIVE_QUOTA_EXCEEDED"], ["You've hit your weekly limit", "NATIVE_QUOTA_EXCEEDED"],
    ["Rate Limit Reached", "NATIVE_RATE_LIMITED"], ["429 Too Many Requests", "NATIVE_RATE_LIMITED"], ["Overloaded", "NATIVE_RATE_LIMITED"],
    ["This model's maximum context length is 65536 tokens", "NATIVE_CONTEXT_EXCEEDED"], ["Model Not Exist", "NATIVE_MODEL_UNAVAILABLE"],
    ["fetch failed", "NATIVE_CONNECTION_FAILED"], ["something else went wrong", undefined],
  ];
  for (const [message, code] of samples) assert.equal(classifyRemoteFailure(message)?.code, code, message);
  assert.equal(classifyRemoteFailure("agent setup needed", -32000)?.code, "NATIVE_AUTH_REQUIRED");
  assert.equal(classifyRemoteFailure("agent setup needed"), undefined);
  assert.equal(classifyRemoteFailure("agent setup needed", -32001), undefined);
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
    assert.deepEqual(await run.result, { status: "cancelled", reason: "cancelled", input: "recorded" });
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
test("ACP names the call an approval is about by the id its program gave the call", async () => {
  const driver = control("permission");
  try {
    const id = await ready(driver); driver.enablePermissions();
    const events: ControlEvent[] = [], run = await driver.startText(id, "hello", event => events.push(event));
    for (let i = 0; i < 100 && !events.some(event => event.type === "permission_requested"); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const asked = events.find(event => event.type === "permission_requested");
    assert.ok(asked?.type === "permission_requested"); assert.equal(asked.forCall, "tool-1");
    await driver.decidePermission(asked.id, "reject"); await run.result;
  } finally { await driver.close(); }
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
    assert.deepEqual(await run.result, { status: "completed", reason: "end_turn", input: "recorded" });
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
for (const [scenario, code] of [["quota-rejected", "NATIVE_QUOTA_EXCEEDED"], ["auth-rejected", "NATIVE_AUTH_REQUIRED"], ["auth-code", "NATIVE_AUTH_REQUIRED"]] as const)
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
    assert.deepEqual(await (await driver.startText(id, "hello", event => events.push(event))).result, { status: "completed", reason: "end_turn", input: "recorded" });
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
    assert.equal(tool?.detail?.diff, "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\n\\ No newline at end of file\n"); assert.deepEqual(tool?.detail?.locations, ["/w/a.txt:2"]);
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
function hermes(trace: string, version?: string): ControlLaunch {
  return { protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "hermes"], env: { FIXTURE_TRACE: trace, ...(version === undefined ? {} : { FIXTURE_AGENT_VERSION: version }) } };
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
  const methods: string[] = [];
  const catalog = async (method: string) => { methods.push(method); return { models: [{ provider: "vision", id: "large", name: "Vision", input: ["text", "image"] }, { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", input: ["text"] }] }; };
  const image = { ...attachment(root, "big.png", "image/png", "image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), bytes: 5_000_001 };
  const unsupported = (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_UNSUPPORTED";
  // [configured model, model selected at open, check]. A selection decides from open() on, before the first prompt applies it.
  for (const [model, selected, check] of [["vision/large", undefined, async (driver: OpenClawControl) => {
    await assert.rejects(driver.checkAttachments([image]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_LIMIT" && error.message.includes("big.png"));
    await driver.checkAttachments([{ ...image, bytes: 5_000_000 }]);
  }], ["deepseek/deepseek-chat", undefined, async (driver: OpenClawControl) => {
    assert.deepEqual((await driver.models()).models.find(row => row.id === "deepseek/deepseek-chat")?.inputs, { image: false, audio: false, file: true });
    await assert.rejects(driver.checkAttachments([{ ...image, bytes: 10 }]), unsupported);
  }], ["vision/large", "deepseek/deepseek-chat", async (driver: OpenClawControl) => {
    await assert.rejects(driver.checkAttachments([{ ...image, bytes: 10 }]), unsupported, "the selected text-only model decides, not the configured vision model");
  }], ["deepseek/deepseek-chat", "vision/large", async (driver: OpenClawControl) => {
    await driver.checkAttachments([{ ...image, bytes: 10 }]);
  }]] as const) {
    const config = join(root, "openclaw.json"); await writeFile(config, `{agents:{list:[{id:"main",default:true}],defaults:{model:{primary:"${model}"}}}}`);
    const env = { HOME: root, OPENCLAW_CONFIG_PATH: config };
    const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "attachments"], env }, { ...options, env }, catalog);
    try { await driver.initialize(); await driver.open(process.cwd(), selected); await check(driver); } finally { await driver.close(); }
  }
  assert.deepEqual([...new Set(methods)], ["models.list"], "gating reads the catalog and writes nothing");
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
test("ACP waits for a fork as long as for opening a session; only -32601 says the agent cannot fork, and any other refusal leaves the copy unknown", async () => {
  // The copy answers after 1 s: past this Turn's deadline (0.5 s), within the request budget (3 s) that opening a session has.
  const slow = control("forkable", { FIXTURE_FORK_DELAY_MS: "1000" }, { requestTimeoutMs: 3000, runTimeoutMs: 500 });
  try { await slow.initialize(); assert.equal(await slow.fork("session-source", process.cwd()), "session-forked"); }
  finally { await slow.close(); }
  for (const [code, expected] of [["-32601", "NATIVE_FORK_UNAVAILABLE"], ["-32603", "REMOTE_ERROR"]] as const) {
    const driver = control("forkable", { FIXTURE_FORK_ERROR: code });
    try { await driver.initialize(); await assert.rejects(driver.fork("session-source", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === expected, code); }
    finally { await driver.close(); }
  }
});
test("an approval or a question the agent withdraws ($/cancel_request) closes as cancelled without an answer, and the Turn says why", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-withdrawn-")); t.after(() => rm(directory, { recursive: true, force: true }));
  // An approval asked with a numeric request id, and the first field of a form (its public id is `<request>:<field>`).
  for (const [scenario, asked, request, option] of [["permission-withdrawn", "41", 41, "allow"], ["elicitation-withdrawn", "elicit-1:0", "elicit-1", "answer-0"]] as const) {
    const trace = join(directory, scenario), driver = control(scenario, { FIXTURE_TRACE: trace }), events: ControlEvent[] = [];
    try {
      const id = await ready(driver); driver.enablePermissions();
      assert.deepEqual(await (await driver.startText(id, "hello", event => events.push(event))).result, { status: "completed", reason: "end_turn", input: "recorded" }, scenario);
      assert.deepEqual(events.flatMap(event => event.type === "permission_requested" ? [event.id] : []), [asked], scenario);
      assert.deepEqual(events.filter(event => event.type === "permission"), [{ type: "permission", id: asked, decision: "cancelled" }], scenario);
      // The withdrawn request, then one that nothing here waits for; neither is recorded as an unsupported notification.
      assert.deepEqual(events.flatMap(event => event.type === "diagnostic" ? [event.message] : []), ["原程序撤回了这项请求", "原程序撤回了一项已不在等待中的请求"], scenario);
      assert.deepEqual(texts(events), ["你好 fixture"], scenario);
      await assert.rejects(driver.decidePermission(asked, option), (error: unknown) => error instanceof ControlError && error.code === "PERMISSION_UNAVAILABLE", scenario);
    } finally { await driver.close(); }
    // The agent no longer waits for the request, so nothing was sent back for it.
    const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { id?: unknown; method?: string });
    assert.equal(sent.some(row => row.id === request && row.method === undefined), false, scenario);
  }
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
  for (const [stop, extra, expected] of [["stop", {}, { status: "completed", reason: "end_turn", input: "recorded" }],
    ["error", { errorMessage: "You've hit your weekly limit" }, { status: "failed", reason: "native_error", error: { code: "NATIVE_QUOTA_EXCEEDED", message: "这个 Harness 的账号额度或余额不足。可等待额度恢复或充值，也可以选择其他 Harness 继续。" }, input: "recorded" }]] as const) {
    let reads = 0;
    const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "basic"], env }, { ...options, env },
      async method => method === "sessions.get" ? { messages: reads++ === 0 ? [earlier] : turn(stop, extra) } : { models: [] });
    try {
      const id = await ready(driver), events: ControlEvent[] = [];
      assert.deepEqual(await (await driver.startText(id, "run it", event => events.push(event))).result, expected);
      const tool = events.find(event => event.type === "tool");
      assert.deepEqual(tool, { type: "tool", id: "call-1", title: "exec: echo HH", status: "completed", detail: { kind: "execute", name: "exec", input: "{\n  \"command\": \"echo HH\"\n}", output: "HH" } });
      assert.deepEqual(events.filter(event => event.type === "thinking").map(event => event.type === "thinking" ? event.text : ""), ["plan the command\n"]);
      // The context the Turn ends on is its last request's total.
      assert.deepEqual(events.find(event => event.type === "usage"), { type: "usage", usage: { turn: { input: 250, output: 25, cachedInput: 10, cacheWrite: 0, total: 285 }, context: { used: 155 }, cost: { amount: 0.003, currency: "USD", scope: "turn" },
        // G069 phase two (ADR-055 VF2-09): each of this turn's assistant rows is one model request.
        requests: [{ input: 100, cachedInput: 10, cacheWrite: 0 }, { input: 150, cachedInput: 0, cacheWrite: 0 }] } }, "only this turn's calls are counted");
    } finally { await driver.close(); }
  }
});

test("OpenClaw reads its settings back after each turn as slash commands leave them, and gates images on a restored session's own model", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-settings-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "openclaw.json"); await writeFile(config, '{agents:{list:[{id:"main",default:true}],defaults:{model:{primary:"deepseek/deepseek-chat"}}}}');
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: config }, launch = { protocol: "acp-v1" as const, executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "openclaw-settings"], env };
  // What the Gateway holds after `/think high`, `/verbose full` and the like; fast mode is only in chat.history.
  let row: Record<string, unknown> | null = { modelProvider: "vision", model: "large", thinkingLevel: "high", verboseLevel: "full", reasoningLevel: "stream", responseUsage: "tokens" };
  const calls: string[] = [];
  const request = async (method: string, params: Readonly<Record<string, unknown>>) => {
    calls.push(method);
    if (method === "sessions.get") return { messages: [] };
    if (method === "sessions.list") return { sessions: [{ key: "agent:main:harnesshub:00000000-0000-0000-0000-000000000000", modelProvider: "other", model: "x", thinkingLevel: "off" }, ...(row === null ? [] : [{ ...row, key: params.search }])] };
    if (method === "chat.history") return { messages: [], fastMode: true };
    if (method === "models.list") return { models: [{ provider: "vision", id: "large", name: "Vision", input: ["text", "image"] }, { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", input: ["text"] }] };
    throw new Error("unexpected OpenClaw method " + method);
  };
  const first = new OpenClawControl(launch, { ...options, env }, request);
  let checkpoint: string | null;
  try {
    const id = await ready(first);
    await assert.rejects(first.nativeConfig(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_CONFIG_UNAVAILABLE", "nothing is reported before a turn");
    assert.equal((await (await first.startText(id, "/think high", () => {})).result).status, "completed");
    // The bridge's modes only repeat its thinking levels, so thought_level alone reports them (G032-NC26).
    assert.deepEqual(await first.nativeConfig(), { model: "vision/large", options: { thought_level: "high", fast_mode: "on", verbose_level: "full", reasoning_level: "stream", response_usage: "tokens", elevated_level: "off" } });
    assert.ok(calls.includes("sessions.list") && calls.includes("chat.history"));
    checkpoint = await first.checkpoint(); assert.ok(checkpoint);
  } finally { await first.close(); }
  const image = attachment(root, "photo.png", "image/png", "image", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  // The restored session runs the model its row holds (vision), not the configured text-only model.
  const restored = new OpenClawControl(launch, { ...options, env }, request);
  try { await restored.initialize(); await restored.open(process.cwd(), undefined, undefined, checkpoint); await restored.checkAttachments([image]); }
  finally { await restored.close(); }
  // Without a row the configured model decides, and it cannot see images.
  row = null;
  const unlisted = new OpenClawControl(launch, { ...options, env }, request);
  try { await unlisted.initialize(); await unlisted.open(process.cwd(), undefined, undefined, checkpoint); await assert.rejects(unlisted.checkAttachments([image]), (error: unknown) => error instanceof ControlError && error.code === "ATTACHMENT_UNSUPPORTED"); }
  finally { await unlisted.close(); }
});

test("ACP reports the configuration the agent announced and records a mode it applied without an echo", async () => {
  const driver = new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "openclaw-settings"], env: {} }, options);
  try {
    await driver.initialize(); await driver.open(process.cwd(), undefined, { __mode: "high" });
    const reported = await driver.nativeConfig();
    assert.equal(reported.model, null, "an agent without a model selector reports no model");
    assert.deepEqual(reported.options, { thought_level: "adaptive", fast_mode: "off", verbose_level: "off", reasoning_level: "off", response_usage: "off", elevated_level: "off", __mode: "high" });
  } finally { await driver.close(); }
});

test("ACP lists the agent's own sessions of this workspace and reads one by replaying it, without prompting", async t => {
  const directory = await mkdtemp(join(tmpdir(), "acp-session-list-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const launch = (scenario: string) => ({ protocol: "acp-v1" as const, executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", scenario], env: { FIXTURE_TRACE: trace } });
  const driver = new AcpControl(launch("session-list"), options);
  try {
    await driver.initialize();
    assert.deepEqual(await driver.nativeSessions(process.cwd()), { sessions: [{ id: "native-a", title: "Earlier work", updatedAt: Date.parse("2026-10-01T10:00:00Z") }], nextCursor: "p2" });
    assert.deepEqual(await driver.importSession("native-b", process.cwd()), { checkpoint: "native-b", title: null, omitted: 0, complete: true, historyRead: true,
      history: [{ role: "user", text: "first question" }, { role: "assistant", text: "first answer" }, { role: "user", text: "second question" }, { role: "assistant", text: "second answer" }] }, "found on the second page; replayed chunks become messages");
  } finally { await driver.close(); }
  const elsewhere = new AcpControl(launch("session-list"), options);
  try { await elsewhere.initialize(); await assert.rejects(elsewhere.importSession("native-x", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_NOT_FOUND", "a session of another workspace is not listed here"); }
  finally { await elsewhere.close(); }
  assert.ok(!(await readFile(trace, "utf8")).includes("session/prompt"), "reading sessions sends no prompt");
  // An agent that does not declare session/list cannot list or continue its sessions here.
  const plain = new AcpControl(launch("basic"), options);
  try { await plain.initialize(); await assert.rejects(plain.nativeSessions(process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_LIST_UNAVAILABLE"); }
  finally { await plain.close(); }
  const root = await mkdtemp(join(tmpdir(), "openclaw-sessions-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "openclaw.json"); await writeFile(config, '{agents:{list:[{id:"main",default:true}]}}');
  const openclaw = new OpenClawControl({ ...launch("session-list"), env: { HOME: root, OPENCLAW_CONFIG_PATH: config } }, { ...options, env: { HOME: root, OPENCLAW_CONFIG_PATH: config } }, async () => ({}));
  try {
    await openclaw.initialize();
    await assert.rejects(openclaw.nativeSessions(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_LIST_UNAVAILABLE");
    await assert.rejects(openclaw.importSession(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_SESSION_LIST_UNAVAILABLE");
  } finally { await openclaw.close(); }
});

test("ACP forms are asked field by field: a choice, a typed answer for its Other box, skip and cancel, and unsupported fields declined", async () => {
  const ask = async (scenario: string, answers: readonly (readonly [string, string?])[], interactive = true) => {
    const driver = control(scenario), events: ControlEvent[] = [];
    try {
      const id = await ready(driver); if (interactive) driver.enablePermissions();
      let asked = 0;
      const run = await driver.startText(id, "ask me", event => {
        events.push(event);
        if (event.type === "permission_requested") { const [option, input] = answers[asked++]!; void driver.decidePermission(event.id, option, input); }
      });
      const result = await run.result, reply = events.flatMap(event => event.type === "text" ? [event.text] : []).join("");
      return { result, reply: JSON.parse(reply.replace(/^form /u, "")) as unknown, questions: events.filter(event => event.type === "permission_requested") };
    } finally { await driver.close(); }
  };
  const picked = await ask("elicitation", [["answer-1"], ["submit", "XL"]]);
  assert.deepEqual(picked.reply, { action: "accept", content: { question_0: "Blue", question_1_custom: "XL" } });
  assert.deepEqual(picked.questions.map(event => event.type === "permission_requested" ? [event.title, event.detail ?? null, event.options.map(option => option.id), event.input?.kind ?? null] : []), [
    ["Which color?", "Red：warm\nBlue：cool", ["answer-0", "answer-1", "submit", "skip", "cancel"], "text"],
    ["Which sizes?", null, ["answer-0", "answer-1", "submit", "skip", "cancel"], "text"]]);
  assert.deepEqual((await ask("elicitation", [["submit", "Green"], ["answer-0"]])).reply, { action: "accept", content: { question_0_custom: "Green", question_1: ["S"] } }, "a typed answer goes to the Other box; a multi-select pick is a list");
  assert.deepEqual((await ask("elicitation", [["skip"]])).reply, { action: "decline" });
  assert.deepEqual((await ask("elicitation", [["answer-0"], ["cancel"]])).reply, { action: "cancel" });
  const number = await ask("elicitation-number", []);
  assert.deepEqual(number.reply, { action: "decline" }); assert.equal(number.questions.length, 0);
  assert.deepEqual((await ask("elicitation", [], false)).reply, { action: "decline" }, "without an interactive chat nobody can answer, so the form is declined");
});

test("OpenClaw lists its workspace skills and plugin tool groups from the Gateway's own read-only reports", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-extensions-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "openclaw.json"); await writeFile(config, '{agents:{list:[{id:"main",default:true}]}}');
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: config }, calls: string[] = [];
  const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "basic"], env }, { ...options, env }, async (method, params) => {
    calls.push(method + " " + JSON.stringify(params));
    if (method === "skills.status") return { workspaceDir: "/w", skills: [
      { name: "weather", description: "Look up the weather", source: "openclaw-bundled", eligible: true, disabled: false, blockedByAllowlist: false },
      { name: "deploy", description: "Ship it", source: "openclaw-workspace", eligible: false, disabled: false },
      { name: "blocked", description: "", source: "agents-skills-personal", eligible: true, blockedByAllowlist: true }] };
    if (method === "tools.catalog") return { groups: [{ id: "fs", label: "Files", source: "core", tools: [{}, {}] }, { id: "plugin:feishu", label: "feishu", source: "plugin", pluginId: "feishu", tools: [{}, {}, {}] }] };
    throw new Error("unexpected " + method);
  });
  try {
    await driver.initialize();
    assert.deepEqual(await driver.extensions(), { mcpServers: [], skills: [
      { name: "weather", description: "Look up the weather", scope: "openclaw-bundled", enabled: true },
      { name: "deploy", description: "Ship it", scope: "openclaw-workspace", enabled: false },
      { name: "blocked", description: "", scope: "agents-skills-personal", enabled: false }], plugins: [{ name: "feishu", enabled: true, source: "3 个工具" }] });
    assert.deepEqual(calls, ["skills.status {}", "tools.catalog {\"includePlugins\":true}"], "only read-only reports are requested");
  } finally { await driver.close(); }
});

test("a request's wait is the program's own deadline, never negative; a program with none leaves the request without one", async () => {
  const { requestExpiry } = await import("../../src/contracts/control.js");
  assert.deepEqual(requestExpiry(3_000), { expiresInMs: 3_000, expiresBy: "native" });
  assert.deepEqual(requestExpiry(-5), { expiresInMs: 0, expiresBy: "native" });
  assert.deepEqual(requestExpiry(0.4), { expiresInMs: 0, expiresBy: "native" });
  assert.deepEqual(requestExpiry(null), {}, "no deadline of the program's, none of the driver's");
});
test("an ACP prompt given a deadline of its own by whoever owns the connection fails with RUN_TIMEOUT while its approval waits; the request's expiry is the program's, never that deadline's", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-hermes-")), trace = join(directory, "trace"); t.after(() => rm(directory, { recursive: true, force: true }));
  const driver = new AcpControl(hermes(trace), { ...options, runTimeoutMs: 600 });
  try {
    await driver.initialize(); driver.enablePermissions(); const id = await driver.open(process.cwd()), events: ControlEvent[] = [];
    const run = await driver.startText(id, "approve this", event => events.push(event));
    await assert.rejects(run.result, (error: unknown) => error instanceof Error && "code" in error && error.code === "RUN_TIMEOUT");
    const requested = events.find(event => event.type === "permission_requested");
    assert.ok(requested?.type === "permission_requested" && requested.expiresBy !== "turn", "the driver's deadline for the Turn is not the request's");
  } finally { await driver.close(); }
});

/** The reply text a Turn streamed, chunk by chunk. */
function texts(events: readonly ControlEvent[]): string[] { return events.flatMap(event => event.type === "text" ? [event.text] : []); }
const authRequired = (error: unknown) => error instanceof ControlError && error.code === "NATIVE_AUTH_REQUIRED";
/**
 * A driver for an agent whose sign-out report can be trusted: a reported "none" is missing, and any other report is ready.
 * It exercises the extension point the way Hermes's advertised methods exercise the "missing" state.
 */
class ReportedSignIn extends AcpControl {
  protected override extensionNotification(method: string, params: Readonly<Record<string, unknown>>): boolean {
    if (method !== "_auth/status_update") return false;
    const status = params.authStatus;
    this.setAuthentication(typeof status === "object" && status !== null && "kind" in status && status.kind === "none" ? "missing" : "ready");
    return true;
  }
}
test("G032-NC23 a sign-in state that a driver reads from its agent's own notification becomes the catalog's readiness; while it is missing, later sessions are refused and a running Turn is left alone (ADR-033)", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-acp-auth-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const peer = (trace: string, env: Record<string, string> = {}) => ({ protocol: "acp-v1" as const, executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "claude-auth"], env: { FIXTURE_TRACE: join(directory, trace), ...env } });
  // Pushed after the session opened, as a catalog read sees it: the state is missing, and another session is refused.
  const opened = new ReportedSignIn(peer("opened"), options);
  try {
    await opened.initialize(); await opened.open(process.cwd());
    assert.equal((await opened.models()).authentication, "missing");
    await assert.rejects(opened.open(process.cwd()), authRequired);
  } finally { await opened.close(); }
  // Pushed in the same chunk as the initialize response, before initialize() weighs the advertised methods: no session is
  // requested. Mutation check: if initialize() applies its methods over the report, open() sends session/new and resolves.
  const early = new ReportedSignIn(peer("early", { FIXTURE_AUTH_AT: "initialize" }), options);
  try { await early.initialize(); await assert.rejects(early.open(process.cwd()), authRequired); }
  finally { await early.close(); }
  const sent = (await readFile(join(directory, "early"), "utf8")).trim().split("\n").map(line => (JSON.parse(line) as { method?: string }).method ?? "");
  assert.equal(sent.some(method => method.startsWith("session/")), false, "a refused session sends nothing");
  // A push that arrives during a Turn leaves the Turn as the agent runs it; only later reads and sessions see the new state.
  const running = new ReportedSignIn(peer("running", { FIXTURE_AUTH_KIND: "account", FIXTURE_AUTH_TURN_KIND: "none" }), options);
  try {
    await running.initialize(); const id = await running.open(process.cwd());
    assert.equal((await running.models()).authentication, "ready");
    const events: ControlEvent[] = [];
    assert.deepEqual(await (await running.startText(id, "hello", event => events.push(event))).result, { status: "completed", reason: "end_turn", input: "recorded" });
    assert.deepEqual(texts(events), ["你好 fixture"]);
    assert.equal((await running.models()).authentication, "missing");
    await assert.rejects(running.open(process.cwd()), authRequired);
  } finally { await running.close(); }
});
test("G032-NC23 for any other ACP agent, _auth/status_update stays an unsupported notification: one diagnostic on the Run that names only the method, with the readiness untouched (ADR-033)", async () => {
  const driver = control("claude-auth", { FIXTURE_AUTH_KIND: "account", FIXTURE_AUTH_TURN_KIND: "none" });
  try {
    const id = await ready(driver);
    assert.equal((await driver.models()).authentication, "unknown", "the push after session creation is not read");
    const events: ControlEvent[] = [];
    assert.equal((await (await driver.startText(id, "hello", event => events.push(event))).result).status, "completed");
    assert.deepEqual(events.filter(event => event.type === "diagnostic"), [{ type: "diagnostic", message: "Unsupported ACP notification: _auth/status_update" }]);
    assert.equal(JSON.stringify(events).includes("private-"), false);
    assert.equal((await driver.models()).authentication, "unknown");
  } finally { await driver.close(); }
});
/**
 * An OpenClaw driver on the bridge fixture (`openclaw-settings`: it restores sessions and answers prompts) whose Gateway
 * a recorder answers. The configured model is deepseek/deepseek-chat; the catalog also lists vision/large and other/model.
 * sessions.list holds `row` under the searched key (none when absent; "unreadable" fails the read), and sessions.patch
 * resolves the model `resolves` returns. Every call is recorded and also marked in the fixture's trace, which so orders
 * the Gateway calls against the messages the bridge received.
 */
async function openclawGateway(root: string, name: string, gateway: { readonly row?: Readonly<Record<string, unknown>> | "unreadable"; readonly resolves?: (model: string) => string } = {}) {
  const config = join(root, name + ".json"), trace = join(root, name + ".trace");
  await writeFile(config, '{agents:{list:[{id:"main",default:true}],defaults:{model:{primary:"deepseek/deepseek-chat"}}}}');
  const calls: { readonly method: string; readonly params: Readonly<Record<string, unknown>> }[] = [];
  const request = async (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    calls.push({ method, params }); appendFileSync(trace, JSON.stringify({ gateway: method }) + "\n");
    if (method === "models.list") return { models: [{ provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", input: ["text"] }, { provider: "vision", id: "large", name: "Vision", input: ["text", "image"] }, { provider: "other", id: "model", name: "Other" }] };
    if (method === "sessions.patch") { const [provider, ...model] = (gateway.resolves ?? (value => value))(String(params.model)).split("/"); return { ok: true, key: params.key, resolved: { modelProvider: provider, model: model.join("/") } }; }
    if (method === "sessions.list") { if (gateway.row === "unreadable") throw new ControlError("NATIVE_REQUEST_FAILED", "original native CLI request failed"); return { sessions: gateway.row === undefined ? [] : [{ ...gateway.row, key: params.search }] }; }
    if (method === "sessions.get") return { messages: [] };
    if (method === "chat.history") return { messages: [], fastMode: false };
    throw new Error("unexpected OpenClaw method " + method);
  };
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: config, FIXTURE_TRACE: trace };
  const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "openclaw-settings"], env }, { ...options, env }, request);
  /** The trace, read once the driver is closed (the bridge has then logged every message it received). */
  const received = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { readonly method?: string; readonly gateway?: string; readonly params?: { readonly _meta?: { readonly sessionKey?: string } } });
  /** Model patches and prompts, in the order the trace holds them. */
  const order = async () => (await received()).flatMap(row => row.gateway === "sessions.patch" ? ["patch"] : row.method === "session/prompt" ? ["prompt"] : []);
  return { driver, calls, patches: () => calls.filter(call => call.method === "sessions.patch").map(call => call.params), received, order };
}
const turnEnded = { status: "completed", reason: "end_turn", input: "recorded" } as const;
test("G032-NC25 (a) OpenClaw writes nothing to its Gateway to run the configured model: neither opening with it nor the first prompt patches the session (T-OC-03)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc25-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { driver, patches, order } = await openclawGateway(root, "configured");
  try {
    await driver.initialize(); const id = await driver.open(process.cwd(), "deepseek/deepseek-chat");
    assert.deepEqual(patches(), [], "opening with the configured model");
    assert.deepEqual(await (await driver.startText(id, "hello", () => {})).result, turnEnded);
    assert.deepEqual(patches(), [], "the first prompt of a session that already runs it");
  } finally { await driver.close(); }
  assert.deepEqual(await order(), ["prompt"]);
});
test("G032-NC25 (b) another model is patched on the Hub's own key after open() and before the bridge receives the first prompt, then not again (T-OC-03)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc25-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { driver, patches, received, order } = await openclawGateway(root, "other");
  try {
    await driver.initialize(); const id = await driver.open(process.cwd(), "other/model");
    assert.deepEqual(patches(), [], "open() only checks the model against the catalog");
    for (const prompt of ["first", "second"]) assert.deepEqual(await (await driver.startText(id, prompt, () => {})).result, turnEnded, prompt);
  } finally { await driver.close(); }
  const key = (await received()).find(row => row.method === "session/new")?.params?._meta?.sessionKey;
  assert.match(String(key), /^agent:main:harnesshub:[0-9a-f-]{36}$/u);
  assert.deepEqual(patches(), [{ key, model: "other/model" }], "one patch, on the session's own key");
  assert.deepEqual(await order(), ["patch", "prompt", "prompt"], "the bridge received the first prompt only after the patch");
});
test("G032-NC25 (c) a Gateway that resolves another model fails the Turn with MODEL_MISMATCH before its prompt is sent (T-OC-03)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc25-")); t.after(() => rm(root, { recursive: true, force: true }));
  const { driver, patches, order } = await openclawGateway(root, "mismatch", { resolves: () => "deepseek/deepseek-chat" });
  try {
    await driver.initialize(); const id = await driver.open(process.cwd(), "vision/large"), events: ControlEvent[] = [];
    const run = await driver.startText(id, "hello", event => events.push(event));
    assert.deepEqual(await run.result, { status: "failed", reason: "model_not_applied", error: { code: "MODEL_MISMATCH", message: "OpenClaw 没有确认所选模型，这条消息没有发出。" }, input: "not_recorded" });
    assert.deepEqual(events, []);
    await assert.rejects(run.requestStop(), (error: unknown) => error instanceof ControlError && error.code === "INVALID_STATE", "there is no prompt to stop");
    assert.deepEqual(patches().map(params => params.model), ["vision/large"]);
  } finally { await driver.close(); }
  assert.deepEqual(await order(), ["patch"], "the bridge never received the prompt");
});
test("G032-NC25 (d) a restored session is patched before its first prompt only when the selection differs from its Gateway row's model, or the row cannot be read (T-OC-03)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc25-")); t.after(() => rm(root, { recursive: true, force: true }));
  const key = "agent:main:harnesshub:00000000-0000-0000-0000-00000000000d", checkpoint = JSON.stringify({ conversation: "session-fixture", key });
  // The restored row runs vision/large, so the configured deepseek/deepseek-chat is a change for it.
  for (const [name, row, model, patched] of [["same", { modelProvider: "vision", model: "large" }, "vision/large", false],
    ["configured", { modelProvider: "vision", model: "large" }, "deepseek/deepseek-chat", true], ["unreadable", "unreadable", "deepseek/deepseek-chat", true]] as const) {
    const { driver, patches, order } = await openclawGateway(root, name, { row });
    try {
      await driver.initialize(); const id = await driver.open(process.cwd(), model, undefined, checkpoint);
      assert.deepEqual(patches(), [], name + ": restoring writes nothing");
      assert.deepEqual(await (await driver.startText(id, "again", () => {})).result, turnEnded, name);
    } finally { await driver.close(); }
    assert.deepEqual(patches(), patched ? [{ key, model }] : [], name);
    assert.deepEqual(await order(), patched ? ["patch", "prompt"] : ["prompt"], name);
  }
});
test("G032-NC25 (e) a catalog read with a selected model opens, reads and closes without writing to the Gateway; an unlisted model is still refused (T-OC-03)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc25-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, model] of [["probe", "other/model"], ["unlisted", "missing/model"]] as const) {
    const { driver, calls } = await openclawGateway(root, name);
    try {
      await driver.initialize();
      // discoverModels: open with the selection, read the catalog, close; an unlisted selection is its selectionError.
      if (model === "missing/model") await assert.rejects(driver.open(process.cwd(), model), (error: unknown) => error instanceof ControlError && error.code === "MODEL_UNAVAILABLE");
      else await driver.open(process.cwd(), model);
      assert.equal((await driver.models()).defaultModel, "deepseek/deepseek-chat", name + ": the configured default, not the selection");
    } finally { await driver.close(); }
    assert.deepEqual(calls.map(call => call.method), ["models.list"], name + ": only the catalog was read");
  }
});
test("G032-NC26 OpenClaw offers its modes once, as thought_level, when they only repeat its thinking levels; modes with other values stay in its catalog and settings report (T-OC-08)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc26-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "openclaw.json"), trace = join(root, "trace"); await writeFile(config, '{agents:{list:[{id:"main",default:true}]}}');
  // What the Gateway holds after `/think high`; its row has no field for a mode.
  const request = async (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    if (method === "sessions.list") return { sessions: [{ key: params.search, thinkingLevel: "high" }] };
    if (method === "chat.history") return { messages: [], fastMode: false };
    if (method === "sessions.get") return { messages: [] };
    if (method === "models.list") return { models: [] };
    throw new Error("unexpected OpenClaw method " + method);
  };
  const launch = (env: Readonly<Record<string, string>>) => new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "openclaw-settings"], env }, { ...options, env }, request);
  const settings = ["thought_level", "fast_mode", "verbose_level", "reasoning_level", "response_usage", "elevated_level"];
  for (const [modes, mode] of [[undefined, undefined], ["distinct", "plan"]] as const) {
    const driver = launch({ HOME: root, OPENCLAW_CONFIG_PATH: config, ...(modes === undefined ? {} : { FIXTURE_OPENCLAW_MODES: modes }) });
    try {
      const id = await ready(driver), offered = (await driver.models()).options ?? [];
      assert.deepEqual(offered.map(option => option.id), mode === undefined ? settings : [...settings, "__mode"], modes ?? "repeated");
      if (mode !== undefined) assert.deepEqual(offered.find(option => option.id === "__mode")?.values.map(row => row.value), ["off", "minimal", "low", "medium", "high", "plan"]);
      assert.equal((await (await driver.startText(id, "/think high", () => {})).result).status, "completed");
      // A mode with other values has no Gateway field: the bridge's own current mode is reported for it.
      assert.deepEqual(await driver.nativeConfig(), { model: null, options: { thought_level: "high", fast_mode: "off", verbose_level: "off", reasoning_level: "off", response_usage: "off", elevated_level: "off", ...(mode === undefined ? {} : { __mode: mode }) } }, modes ?? "repeated");
    } finally { await driver.close(); }
  }
  // A selection that still carries the repeated mode is applied as before, since the bridge keeps offering it.
  const kept = launch({ HOME: root, OPENCLAW_CONFIG_PATH: config, FIXTURE_TRACE: trace });
  try { await kept.initialize(); await kept.open(process.cwd(), undefined, { __mode: "high" }); } finally { await kept.close(); }
  const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { readonly method?: string; readonly params?: { readonly modeId?: string } });
  assert.deepEqual(sent.filter(row => row.method === "session/set_mode").map(row => row.params?.modeId), ["high"]);
});
test("G032-NC27 OpenClaw reads the transcript back as far as the Turn goes: a window that starts after the Turn's first entry is asked for again, larger, and only a transcript past the largest window leaves entries unreconciled (T-OC-08, ADR-027)", async t => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-nc27-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "openclaw.json"); await writeFile(config, '{agents:{list:[{id:"main",default:true}]}}');
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: config }, before = 5;
  const earlier = { role: "assistant", content: [{ type: "text", text: "earlier turn" }], __openclaw: { seq: before } };
  // The latest `limit` entries of a transcript of `total` entries after seq `before`; the last two are a tool call and its result.
  const transcript = (total: number) => Array.from({ length: total }, (_, index) => ({ __openclaw: { seq: before + 1 + index },
    ...(index === total - 2 ? { role: "assistant", content: [{ type: "toolCall", id: "call-late", name: "exec", arguments: { command: "echo late" } }] }
      : index === total - 1 ? { role: "toolResult", toolCallId: "call-late", toolName: "exec", content: [{ type: "text", text: "late" }], isError: false }
      : { role: "assistant", content: [{ type: "text", text: "step " + index }] }) }));
  // [entries this Turn wrote, the limits it was asked for in turn after the first read of the position before the Turn]: 150 fit the first window; 900 need two more asks; 250 need one.
  for (const [total, asked] of [[150, [200]], [250, [200, 800]], [900, [200, 800, 3200]], [199, [200]]] as const) {
    const limits: number[] = [];
    const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/control-peer.mjs"), "acp-v1", "basic"], env }, { ...options, env },
      async (method, params) => {
        if (method !== "sessions.get") return { models: [] };
        const limit = (params as { readonly limit?: number }).limit ?? 0;
        if (limit === 1) return { messages: [earlier] };
        limits.push(limit); const all = transcript(total); return { messages: all.slice(-limit) };
      });
    try {
      const id = await ready(driver), events: ControlEvent[] = [];
      assert.deepEqual(await (await driver.startText(id, "go", event => events.push(event))).result, turnEnded);
      assert.deepEqual(limits, asked, `${total} entries`);
      assert.deepEqual(events.flatMap(event => event.type === "diagnostic" ? [event.message] : []), [], "every entry of the Turn was read");
      assert.deepEqual(events.flatMap(event => event.type === "tool" ? [event.id + " " + event.status] : []), ["call-late completed"], "the entries are reconciled");
    } finally { await driver.close(); }
  }
});

