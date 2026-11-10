import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { ControlEvent, ControlOptions } from "../../src/contracts/control.js";
import { AcpControl } from "../../src/adapters/control/acp.js";
import { OpenClawControl } from "../../src/adapters/control/factory.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";

// The OpenClaw driver on a minimal bridge (tests/fixtures/openclaw-bridge-peer.mjs) whose Gateway each test answers: what
// the driver does follows what the program reports (its capabilities, agents.list, models.list, the session row), never
// a version number (ADR-053). Nothing here runs OpenClaw.
const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1500, maxFrameBytes: 65536, maxDiagnosticBytes: 1024, closeGraceMs: 150 };
type Gateway = (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
interface Sent { readonly method?: string; readonly params?: { readonly sessionId?: string; readonly _meta?: { readonly sessionKey?: string; readonly requireExistingSession?: boolean } } }
const unexpected: Gateway = async method => { throw new Error("unexpected OpenClaw method " + method); };
/** Rejects as a Gateway without the method makes the original CLI fail. */
const missing = (): Promise<never> => Promise.reject(new ControlError("NATIVE_REQUEST_FAILED", "original native CLI request failed"));

/**
 * A driver on the bridge fixture in a private home: `config` is written as openclaw.json (null leaves it missing), the
 * Gateway answers through `gateway`, every Gateway call is recorded in order, and `sent()` reads what the bridge received.
 */
async function bridge(t: TestContext, config: string | null, gateway: Gateway = unexpected, fixture: Readonly<Record<string, string>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "openclaw.json"), trace = join(root, "trace");
  if (config !== null) await writeFile(path, config);
  const env = { HOME: root, OPENCLAW_CONFIG_PATH: path, FIXTURE_TRACE: trace, ...fixture }, calls: string[] = [];
  const driver = new OpenClawControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/openclaw-bridge-peer.mjs"), "acp"], env }, { ...options, env },
    async (method, params) => { calls.push(method); return gateway(method, params); });
  const sent = async (): Promise<readonly Sent[]> => { try { return (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Sent); } catch { return []; } };
  return { driver, calls, sent };
}
/** The Hub session key the bridge received with session/new; undefined when no session was created. */
async function newKey(sent: () => Promise<readonly Sent[]>): Promise<string | undefined> { return (await sent()).find(row => row.method === "session/new")?.params?._meta?.sessionKey; }
const selectionRequired = (error: unknown) => error instanceof ControlError && error.code === "NATIVE_CONFIGURATION_INVALID" && error.message.includes("HarnessHub 不替你选");
const catalog = { models: [{ provider: "deepseek", id: "x", name: "X" }, { provider: "file", id: "model", name: "File" }] };

test("OpenClaw runs a new session as the Gateway's own default agent (agents.list) with that agent's primary model; a restored one keeps its key and asks nothing (ADR-053)", async t => {
  // The fields the driver reads, and the whole result as 2026.10.5 answers it (gateway/agent-list.ts and session-utils-store.ts).
  const minimal = { defaultId: "ops", agents: [{ id: "ops", model: { primary: "deepseek/x" }, workspace: "~/ws" }] };
  const full = { defaultId: "ops", ownership: "explicit", selectionRequired: false, mainKey: "main", scope: "per-sender",
    agents: [{ id: "ops", kind: "agent", workspace: "/Users/someone/ws", workspaceGit: false, model: { primary: "deepseek/x", fallbacks: ["file/model"] }, thinkingDefault: "adaptive" }, { id: "main", model: { primary: "file/model" } }] };
  // Without a configuration file, and with a keyed roster whose own marker names another agent: the Gateway's answer decides.
  for (const [config, roster] of [[null, minimal], [null, full], ["{ agents: { entries: { main: { default: true, model: 'file/model' }, ops: {} } } }", full]] as const) {
    const gateway: Gateway = async method => method === "agents.list" ? roster : method === "models.list" ? catalog : unexpected(method, {});
    const { driver, calls, sent } = await bridge(t, config, gateway, { FIXTURE_SESSION_CAPS: "latest" });
    let checkpoint: string | null;
    try {
      await driver.initialize(); await driver.open(process.cwd());
      assert.equal((await driver.models()).defaultModel, "deepseek/x", String(config));
      checkpoint = await driver.checkpoint();
    } finally { await driver.close(); }
    const key = await newKey(sent);
    assert.match(String(key), /^agent:ops:harnesshub:[0-9a-f-]{36}$/u, String(config));
    assert.deepEqual(calls, ["agents.list", "models.list"], "the roster is read once, and nothing is written");
    assert.ok(checkpoint);
    // A restored session keeps its own key, so the roster is not asked again; the bridge declares resume, so it resumes.
    const restored = await bridge(t, config, gateway, { FIXTURE_SESSION_CAPS: "latest" });
    try { await restored.driver.initialize(); await restored.driver.open(process.cwd(), undefined, undefined, checkpoint); }
    finally { await restored.driver.close(); }
    const resumed = (await restored.sent()).find(row => row.method === "session/resume");
    assert.deepEqual([resumed?.params?._meta?.sessionKey, resumed?.params?._meta?.requireExistingSession], [key, true]);
    assert.deepEqual(restored.calls, [], "restoring asks the Gateway nothing");
  }
});

test("OpenClaw leaves the default agent to openclaw.json when the Gateway does not provide agents.list: keyed agents.entries by their ownership, the legacy array as before (ADR-053)", async t => {
  const gateway = (roster: () => Promise<unknown>): Gateway => async method => method === "agents.list" ? roster() : method === "models.list" ? catalog : unexpected(method, {});
  const marked = "{ agents: { defaults: { model: 'file/default' }, entries: { main: {}, ops: { default: true, model: { primary: 'file/ops' } } } } }";
  // [configuration, how the Gateway fails, agent, configured model]
  const cases: readonly (readonly [string | null, () => Promise<unknown>, string, string | null])[] = [
    [marked, missing, "ops", "file/ops"], [marked, async () => { throw new Error("unexpected OpenClaw method agents.list"); }, "ops", "file/ops"],
    [marked, async () => undefined, "ops", "file/ops"], [marked, async () => ({ models: [] }), "ops", "file/ops"],
    ["{ agents: { entries: { solo: { model: 'file/solo' } } } }", missing, "solo", "file/solo"],
    ["{ agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'Coord' }, model: 'file/default' }, entries: { writer: { model: 'file/writer' }, coord: {} } } }", missing, "coord", "file/default"],
    [null, missing, "main", null]];
  for (const [config, roster, agent, model] of cases) {
    const { driver, calls, sent } = await bridge(t, config, gateway(roster));
    try { await driver.initialize(); await driver.open(process.cwd()); assert.equal((await driver.models()).defaultModel, model, String(config)); }
    finally { await driver.close(); }
    assert.match(String(await newKey(sent)), new RegExp("^agent:" + agent + ":harnesshub:[0-9a-f-]{36}$", "u"), String(config));
    assert.deepEqual(calls, ["agents.list", "models.list"], String(config));
  }
  // A legacy array: the default-marked entry, else the first; only Gateways that predate keyed rosters run with one, so the file decides.
  for (const [config, agent, model] of [["{ agents: { list: [{ id: 'first' }, { id: 'chosen', default: true, model: 'file/chosen' }], defaults: { model: 'file/default' } } }", "chosen", "file/chosen"],
    ["{ agents: { list: [{ id: 'first' }, { id: 'second' }], defaults: { model: { primary: 'file/default' } } } }", "first", "file/default"]] as const) {
    const { driver, calls, sent } = await bridge(t, config, gateway(missing));
    try { await driver.initialize(); await driver.open(process.cwd()); assert.equal((await driver.models()).defaultModel, model, config); }
    finally { await driver.close(); }
    assert.match(String(await newKey(sent)), new RegExp("^agent:" + agent + ":harnesshub:[0-9a-f-]{36}$", "u"), config);
    assert.deepEqual(calls, ["models.list"], "a legacy array is not asked of the Gateway: " + config);
  }
});

test("OpenClaw without a default agent fails a new session with NATIVE_CONFIGURATION_INVALID before anything is created, and never guesses main (ADR-053)", async t => {
  const answer = (roster: unknown): Gateway => async method => method === "agents.list" ? roster : unexpected(method, {});
  const listed = { ownership: "explicit", mainKey: "main", scope: "per-sender", agents: [{ id: "a" }, { id: "b" }] };
  // The Gateway says so: without a defaultId, or with the one 2026.10.5 still names then (only its first configured agent).
  for (const roster of [{ ...listed, selectionRequired: true }, { ...listed, defaultId: "a", selectionRequired: true }]) {
    const { driver, sent } = await bridge(t, null, answer(roster));
    try { await driver.initialize(); await assert.rejects(driver.open(process.cwd()), selectionRequired, JSON.stringify(roster)); }
    finally { await driver.close(); }
    assert.equal(await newKey(sent), undefined, "no session was created");
  }
  // The file says so, when the Gateway does not provide the list.
  for (const config of ["{ agents: { ownership: 'explicit', entries: { a: {}, b: {} } } }", "{ agents: { entries: { a: {}, b: {} } } }", "{ agents: { entries: { a: { default: true }, b: { default: true } } } }",
    "{ agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'ghost' } }, entries: { a: {}, b: {} } } }", "{ agents: { ownership: 'explicit', entries: { a: { default: true }, b: {} } } }", "{ agents: { entries: {} } }"]) {
    const { driver, sent } = await bridge(t, config, async method => method === "agents.list" ? missing() : unexpected(method, {}));
    try { await driver.initialize(); await assert.rejects(driver.open(process.cwd()), selectionRequired, config); }
    finally { await driver.close(); }
    assert.equal(await newKey(sent), undefined, config);
  }
  // A conversation the Hub already has keeps its own key's agent, so it continues all the same.
  const checkpoint = JSON.stringify({ conversation: "session-bridge", key: "agent:a:harnesshub:00000000-0000-0000-0000-00000000000c" });
  const restored = await bridge(t, "{ agents: { ownership: 'explicit', entries: { a: {}, b: {} } } }", unexpected, { FIXTURE_SESSION_CAPS: "latest" });
  try { await restored.driver.initialize(); await restored.driver.open(process.cwd(), undefined, undefined, checkpoint); }
  finally { await restored.driver.close(); }
  assert.deepEqual(restored.calls, []);
});

test("OpenClaw does not emit a tool call the bridge streamed live again from the transcript and keeps its live title; a transcript-only call is still added (ADR-027, ADR-053)", async t => {
  const earlier = { role: "assistant", content: [{ type: "text", text: "earlier turn" }], __openclaw: { seq: 5 } };
  const turn = (failed: boolean) => [earlier, { role: "user", content: [{ type: "text", text: "go" }], __openclaw: { seq: 6 } },
    { role: "assistant", content: [{ type: "toolCall", id: "call-x", name: "exec", arguments: { command: "echo HH" } }, { type: "toolCall", id: "call-y", name: "read", arguments: { path: "/tmp/y" } }],
      usage: { input: 10, output: 2, totalTokens: 12 }, stopReason: "toolUse", __openclaw: { seq: 7 } },
    { role: "toolResult", toolCallId: "call-x", toolName: "exec", content: [{ type: "text", text: failed ? "boom" : "HH" }], isError: failed, __openclaw: { seq: 8 } },
    { role: "toolResult", toolCallId: "call-y", toolName: "read", content: [{ type: "text", text: "Y" }], isError: false, __openclaw: { seq: 9 } },
    { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 20, output: 3, totalTokens: 23 }, stopReason: "stop", __openclaw: { seq: 10 } }];
  // [what the bridge streams, whether the transcript's call-x failed, the tool events: id, title, status]
  const cases: readonly (readonly [string | undefined, boolean, readonly (readonly [string, string, string])[]])[] = [
    ["live", false, [["call-x", "Run echo HH", "in_progress"], ["call-x", "Run echo HH", "completed"], ["call-y", "read: /tmp/y", "completed"]]],
    // A streamed call the stream never settled takes the transcript's outcome, under its live title.
    ["open", true, [["call-x", "Run echo HH", "in_progress"], ["call-x", "Run echo HH", "failed"], ["call-y", "read: /tmp/y", "completed"]]],
    ["open", false, [["call-x", "Run echo HH", "in_progress"], ["call-x", "Run echo HH", "completed"], ["call-y", "read: /tmp/y", "completed"]]],
    // A bridge without live tool events (2026.3.23-2): both calls come from the transcript, as before.
    [undefined, false, [["call-x", "exec: echo HH", "completed"], ["call-y", "read: /tmp/y", "completed"]]]];
  for (const [tools, failed, expected] of cases) {
    let reads = 0;
    const { driver } = await bridge(t, null, async method => method === "agents.list" ? missing() : method === "sessions.get" ? { messages: reads++ === 0 ? [earlier] : turn(failed) }
      : method === "sessions.list" ? { sessions: [] } : method === "chat.history" ? { messages: [] } : unexpected(method, {}), tools === undefined ? {} : { FIXTURE_TOOLS: tools });
    const events: ControlEvent[] = [];
    try {
      await driver.initialize(); const id = await driver.open(process.cwd());
      assert.deepEqual(await (await driver.startText(id, "go", event => events.push(event))).result, { status: "completed", reason: "end_turn", input: "recorded" }, String(tools));
    } finally { await driver.close(); }
    const tool = events.flatMap(event => event.type === "tool" ? [event] : []);
    assert.deepEqual(tool.map(event => [event.id, event.title, event.status]), expected, String(tools) + (failed ? " failed" : ""));
    if (tools === "open") assert.equal(tool.filter(event => event.id === "call-x").at(-1)?.detail, undefined, "the outcome is a status update only");
    assert.deepEqual(events.find(event => event.type === "usage"), { type: "usage", usage: { turn: { input: 30, output: 5, cachedInput: 0, cacheWrite: 0, total: 35 }, requests: [{ input: 10 }, { input: 20 }] } }, "usage still comes from the transcript, request by request (G069 phase two)");
  }
});

test("OpenClaw reads settings back in the bridge's own values: unset fields report what the bridge announced, fast mode auto stays auto, the trace level is reported (ADR-053)", async t => {
  // [the Gateway session row, chat.history's fast mode, the options reported]
  const announced = { thought_level: "adaptive", fast_mode: "off", verbose_level: "off", trace_level: "off", reasoning_level: "off", response_usage: "inherit", elevated_level: "off" };
  const cases: readonly (readonly [Readonly<Record<string, unknown>>, unknown, Readonly<Record<string, string>>])[] = [
    [{ thinkingLevel: "high", fastMode: "auto", traceLevel: "on", queueMode: "steer" }, false, { ...announced, thought_level: "high", fast_mode: "auto", trace_level: "on" }],
    [{ effectiveFastMode: true, fastMode: false, responseUsage: "tokens", elevatedLevel: "ask" }, false, { ...announced, fast_mode: "on", response_usage: "tokens", elevated_level: "ask" }],
    [{ effectiveFastMode: "ultrafast" }, false, { ...announced, fast_mode: "on" }],
    [{ fastMode: false, verboseLevel: "full" }, true, { ...announced, verbose_level: "full" }],
    // A row without fast mode, as 2026.3.23-2 keeps it in chat.history only.
    [{ reasoningLevel: "stream" }, true, { ...announced, reasoning_level: "stream", fast_mode: "on" }]];
  for (const [row, fast, expected] of cases) {
    const { driver } = await bridge(t, null, async (method, params) => method === "agents.list" ? missing() : method === "sessions.get" ? { messages: [] }
      : method === "sessions.list" ? { sessions: [{ key: params.search, modelProvider: "deepseek", model: "x", ...row }] } : method === "chat.history" ? { messages: [], fastMode: fast } : unexpected(method, {}));
    try {
      await driver.initialize(); const id = await driver.open(process.cwd());
      await (await driver.startText(id, "/trace on", () => {})).result;
      assert.deepEqual(await driver.nativeConfig(), { model: "deepseek/x", options: expected }, JSON.stringify(row));
    } finally { await driver.close(); }
  }
});

test("OpenClaw leaves a model the Gateway reports unavailable out of the choice, refuses it at open with its reason, and names it once in the next Turn's diagnostics (ADR-053)", async t => {
  const until = Date.UTC(2026, 9, 22, 12, 0, 0);
  const models = { models: [{ provider: "deepseek", id: "x", name: "X" }, { provider: "openai", id: "gpt", name: "GPT", available: false, unavailableReason: "missing-auth" },
    { provider: "anthropic", id: "c", name: "C", available: false, unavailableReason: "cooldown", unavailableUntil: until }, { provider: "z", id: "ok", name: "OK", available: true }] };
  const gateway: Gateway = async method => method === "agents.list" ? missing() : method === "models.list" ? models : method === "sessions.get" ? { messages: [] }
    : method === "sessions.list" ? { sessions: [] } : method === "chat.history" ? { messages: [] } : unexpected(method, {});
  const config = "{ agents: { defaults: { model: 'deepseek/x' } } }";
  const listed = await bridge(t, config, gateway);
  try {
    await listed.driver.initialize(); await listed.driver.open(process.cwd());
    const offered = await listed.driver.models();
    assert.deepEqual([offered.models.map(row => row.id), offered.canSelect, offered.defaultModel], [["deepseek/x", "z/ok"], true, "deepseek/x"]);
  } finally { await listed.driver.close(); }
  for (const [model, reason] of [["openai/gpt", "missing-auth"], ["anthropic/c", "cooldown until 2026-10-22T12:00:00.000Z"]] as const) {
    const refused = await bridge(t, config, gateway);
    try { await refused.driver.initialize(); await assert.rejects(refused.driver.open(process.cwd(), model), (error: unknown) => error instanceof ControlError && error.code === "MODEL_UNAVAILABLE" && error.message.endsWith(reason), model); }
    finally { await refused.driver.close(); }
  }
  const chosen = await bridge(t, config, gateway), diagnostics: string[][] = [];
  try {
    await chosen.driver.initialize(); const id = await chosen.driver.open(process.cwd(), "deepseek/x");
    for (const prompt of ["first", "second"]) {
      const turn: string[] = []; diagnostics.push(turn);
      await (await chosen.driver.startText(id, prompt, event => { if (event.type === "diagnostic") turn.push(event.message); })).result;
    }
  } finally { await chosen.driver.close(); }
  assert.deepEqual(diagnostics, [["OpenClaw reports 2 model(s) unavailable, left out of the model choice: openai/gpt (missing-auth), anthropic/c (cooldown until 2026-10-22T12:00:00.000Z)"], []]);
  assert.ok(!chosen.calls.includes("sessions.patch"), "the configured model needs no patch");
});

test("OpenClaw forks as the bridge declares: refused by the generic check without session/fork, the generic fork with it (ADR-053)", async t => {
  assert.equal(Object.hasOwn(OpenClawControl.prototype, "fork"), false, "the driver adds no fork rule of its own");
  assert.equal(OpenClawControl.prototype.fork, AcpControl.prototype.fork);
  const undeclared = await bridge(t, null, unexpected, { FIXTURE_SESSION_CAPS: "latest" });
  try {
    await undeclared.driver.initialize();
    await assert.rejects(undeclared.driver.fork("session-source", process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_FORK_UNAVAILABLE" && /does not declare session\/fork/u.test(error.message));
  } finally { await undeclared.driver.close(); }
  assert.equal((await undeclared.sent()).some(row => row.method === "session/fork"), false, "nothing was sent");
  const declared = await bridge(t, null, unexpected, { FIXTURE_SESSION_CAPS: "fork" });
  try { await declared.driver.initialize(); assert.equal(await declared.driver.fork("session-source", process.cwd()), "session-bridge-fork"); }
  finally { await declared.driver.close(); }
  assert.deepEqual((await declared.sent()).filter(row => row.method === "session/fork").map(row => row.params?.sessionId), ["session-source"]);
  assert.deepEqual([undeclared.calls, declared.calls], [[], []]);
});
