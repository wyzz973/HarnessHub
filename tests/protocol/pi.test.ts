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
    // One state read per process before the prompt; a later read is the handled-prompt probe, not a relaunch.
    assert.equal(frames.filter(row => row.type === "set_model" || row.type === "new_session").length, 0); assert.equal(frames.slice(0, frames.findIndex(row => row.type === "prompt")).filter(row => row.type === "get_state").length, 2);
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

// Pi 0.85.1 editor dialogs send `prefill` and accept only `{value}` (rpc-mode.ts:254-271); `{text}` would read as a cancel.
for (const [scenario,option,input,field,expected] of [["ui-input","submit","typed input","value","typed input"],["ui-editor","submit","edited native text","value","edited native text"],["ui-select","choice-1",undefined,"value","Two"]] as const) test(`Pi ${scenario} surfaces native interaction and round-trips its response`, async t=>{
  const root=await mkdtemp(join(tmpdir(),"pi-native-ui-")), trace=join(root,"trace");t.after(()=>rm(root,{recursive:true,force:true})); const driver=control(scenario,trace);
  try { await driver.initialize();driver.enablePermissions(); const id=await driver.open(process.cwd()); let receive!:(event:Extract<import("../../src/contracts/control.js").ControlEvent,{type:"permission_requested"}>)=>void;
    const request=new Promise<Extract<import("../../src/contracts/control.js").ControlEvent,{type:"permission_requested"}>>(resolve=>{receive=resolve});
    const run=await driver.startText(id,"native UI",event=>{if(event.type==="permission_requested")receive(event)}),asked=await request;
    assert.equal(asked.id,"native-ui"); await driver.decidePermission(asked.id,option,input);assert.equal((await run.result).status,"completed");
    const wire=(await readFile(trace,"utf8")).trim().split("\n").map(line=>JSON.parse(line));assert.equal(wire.find(row=>row.type==="extension_ui_response")[field],expected);
  } finally {assert.equal((await driver.close()).closed,true);}
});

test("Pi recovers its original session file and rejects a replacement session", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-recovery-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "native.jsonl");
  const create = (scenario = "basic") => new PiControl({ executable: process.execPath, args: [resolve("tests/fixtures/pi-rpc-peer.mjs"), scenario], env: { FIXTURE_SESSION_FILE: path }, protocol: "pi-rpc" }, { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1000, closeGraceMs: 100, maxFrameBytes: 65536, maxDiagnosticBytes: 4096 });
  const first = create(); let saved: string | null = null;
  try { await first.initialize(); const id = await first.open(process.cwd(), "native/two"); await (await first.startText(id, "first", () => {})).result; saved = await first.checkpoint(); }
  finally { await first.close(); }
  assert.ok(saved); assert.deepEqual(JSON.parse(saved), { path, id: "pi-fixture" });
  const restored = create();
  try { await restored.initialize(); const id = await restored.open(process.cwd(), "native/two", undefined, saved); assert.equal((await (await restored.startText(id, "second", () => {})).result).status, "completed"); assert.equal(await restored.checkpoint(), saved); }
  finally { await restored.close(); }
  const wrong = create("restore-wrong");
  try { await wrong.initialize(); await assert.rejects(wrong.open(process.cwd(), undefined, undefined, saved), /owned session file/); }
  finally { await wrong.close(); }
});

test("Pi editor dialogs show the native prefill", async () => {
  const driver = control("ui-editor");
  try {
    await driver.initialize(); driver.enablePermissions(); const id = await driver.open(process.cwd());
    let receive!: (event: Extract<import("../../src/contracts/control.js").ControlEvent, { type: "permission_requested" }>) => void;
    const request = new Promise<Extract<import("../../src/contracts/control.js").ControlEvent, { type: "permission_requested" }>>(resolve => { receive = resolve; });
    const run = await driver.startText(id, "edit", event => { if (event.type === "permission_requested") receive(event); }), asked = await request;
    assert.deepEqual(asked.input, { kind: "editor", value: "native draft" });
    await driver.decidePermission(asked.id, "cancel"); assert.equal((await run.result).status, "completed");
  } finally { await driver.close(); }
});
test("Pi prompts handled by an extension command or input hook settle without waiting for a run", async () => {
  const driver = control("handled", undefined, 2000);
  try {
    await driver.initialize(); const started = Date.now(), run = await driver.startText(await driver.open(process.cwd()), "/extension-command", () => {});
    assert.deepEqual(await run.result, { status: "completed", reason: "handled" }); assert.ok(Date.now() - started < 1500);
    assert.equal((await driver.close()).protocolFailure, null);
  } finally { await driver.close(); }
});
test("Pi keeps the Turn when a handled command starts its run after the acknowledgement", async () => {
  const driver = control("late-run", undefined, 2000);
  try {
    await driver.initialize(); const output: string[] = [], run = await driver.startText(await driver.open(process.cwd()), "/extension-command", event => { if (event.type === "text") output.push(event.text); });
    assert.deepEqual(await run.result, { status: "completed", reason: "stop" }); assert.deepEqual(output, ["late native run"]);
  } finally { await driver.close(); }
});
test("Pi withdraws a timed native dialog at its deadline and rejects a late answer", async () => {
  const driver = control("ui-timeout");
  try {
    await driver.initialize(); driver.enablePermissions(); const events: import("../../src/contracts/control.js").ControlEvent[] = [];
    const run = await driver.startText(await driver.open(process.cwd()), "timed", event => events.push(event));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(events.some(event => event.type === "permission_requested" && event.id === "native-ui"));
    assert.ok(events.some(event => event.type === "permission" && event.id === "native-ui" && event.decision === "cancelled"));
    await assert.rejects(driver.decidePermission("native-ui", "choice-0"), /unavailable/);
    assert.equal((await run.result).status, "completed");
  } finally { await driver.close(); }
});
test("Pi treats a terminating tool batch as a completed run", async () => {
  const driver = control("terminate");
  try { await driver.initialize(); assert.deepEqual(await (await driver.startText(await driver.open(process.cwd()), "finish", () => {})).result, { status: "completed", reason: "toolUse" }); }
  finally { await driver.close(); }
});
test("Pi thinking levels come from the native RPC and native Model fields, never from Pi internals", async () => {
  const driver = control("basic");
  try {
    await driver.initialize(); const catalog = await driver.models();
    const level = (model: string) => catalog.models.find(row => row.id === model)?.options?.find(option => option.id === "thinking_level")?.values.map(value => value.value);
    assert.deepEqual(level("native/one"), ["off"]);
    assert.deepEqual(level("native/two"), ["off", "low", "medium", "high", "max"]);
  } finally { await driver.close(); }
});
test("Pi maps tool arguments, streamed and final results, per-call usage, compaction and extension notices", async () => {
  const driver = control("native-activity", undefined, 2000);
  try {
    await driver.initialize(); const events: import("../../src/contracts/control.js").ControlEvent[] = [];
    assert.equal((await (await driver.startText(await driver.open(process.cwd()), "work", event => events.push(event))).result).status, "completed");
    const final = (id: string) => events.flatMap(event => event.type === "tool" && event.id === id ? [event] : []).at(-1);
    assert.equal(final("bash-1")?.title, "bash: ls -la"); assert.deepEqual(final("bash-1")?.detail, { kind: "execute", name: "bash", input: "ls\n-la", output: "a.txt" });
    assert.equal(final("edit-1")?.title, "edit: /w/a.txt"); assert.equal(final("edit-1")?.detail?.diff, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n"); assert.deepEqual(final("edit-1")?.detail?.locations, ["/w/a.txt"]);
    const usage = events.flatMap(event => event.type === "usage" ? [event.usage] : []).at(-1);
    assert.deepEqual(usage?.turn, { input: 230, output: 50, cachedInput: 10, cacheWrite: 0, reasoning: 4, total: 290 }); assert.deepEqual(usage?.context, { used: 165, size: 64000 });
    assert.equal(usage?.cost?.scope, "turn"); assert.ok(Math.abs((usage?.cost?.amount ?? 0) - 0.003) < 1e-9);
    assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.type === "activity" ? event.status : null), ["running", "completed"]);
    assert.deepEqual(events.filter(event => event.type === "notice").map(event => event.type === "notice" ? [event.severity, event.title] : null), [["warning", "Extension says hi"], ["error", "Pi 扩展出错"]]);
  } finally { await driver.close(); }
});
