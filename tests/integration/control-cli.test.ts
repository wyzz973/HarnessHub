import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ControlProtocol } from "../../src/contexts/catalog/domain/discovery.js";

const cli = fileURLToPath(new URL("../../src/cli/control.js", import.meta.url));
const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
const source = { repository: "fixture", revision: "test", upstreamId: "fixture", url: "https://example.invalid/fixture" };

interface Fixture {
  readonly root: string;
  readonly hostHome: string;
  readonly temporary: string;
  readonly manifest: string;
  readonly pid: string;
  readonly trace: string;
  readonly capture: string;
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-control-cli-"));
  const result = { root, hostHome: join(root, "host-home"), temporary: join(root, "temporary"), manifest: join(root, "manifest.json"), pid: join(root, "peer.pid"), trace: join(root, "trace.ndjson"), capture: join(root, "isolation.json") };
  await mkdir(result.hostHome); await mkdir(result.temporary);
  t.after(async () => {
    try {
      const pid = Number(await readFile(result.pid, "utf8"));
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return result;
}
function environment(f: Fixture): NodeJS.ProcessEnv {
  // Synthetic host values only; never copy the running test's credentials/environment.
  return { PATH: join(f.root, "empty-path"), HOME: f.hostHome, TMPDIR: f.temporary, LANG: "C", TEST_HOST_SECRET: "synthetic-secret" };
}
function invoke(f: Fixture, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cli, ...args, "--path-only", "--allow-unofficial", "--manifest", f.manifest], { cwd: f.root, env: environment(f), encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
}
function records(output: string): readonly Record<string, unknown>[] {
  return output.trim() ? output.trim().split("\n").map((line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  }) : [];
}
async function traces(f: Fixture): Promise<readonly Record<string, unknown>[]> { return records(await readFile(f.trace, "utf8")); }
async function assertClosed(f: Fixture): Promise<void> {
  const pid = Number(await readFile(f.pid, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => errorCode(error) === "ESRCH", "owned peer process still exists");
  assert.deepEqual(await readdir(f.temporary), [], "owned private directories were not removed");
}
function definition(protocol: ControlProtocol, args: readonly string[], env: Readonly<Record<string, string>>, second = false) {
  const control = (id: string) => ({ id, protocol, executableNames: ["fixture-control"], args, env, package: null, distribution: null, requiredExecutables: [], source });
  return { id: "cli-fixture", name: "CLI Fixture", aliases: ["fixture-alias"], binaryNames: [], configHints: [], controls: [control("fixture-primary"), ...(second ? [control("fixture-secondary")] : [])] };
}
async function manifest(f: Fixture, protocol: ControlProtocol, scenario = "basic", options: { second?: boolean; executable?: string; wrapper?: string; extraEnv?: Readonly<Record<string, string>> } = {}): Promise<void> {
  const value = definition(protocol, [options.wrapper ?? peer, protocol, scenario], { FIXTURE_PID: f.pid, FIXTURE_TRACE: f.trace, ...options.extraEnv }, options.second);
  await writeFile(f.manifest, JSON.stringify({ version: 2, definitions: [value], overrides: { "fixture-primary": { executable: options.executable ?? process.execPath }, ...(options.second ? { "fixture-secondary": { executable: process.execPath } } : {}) } }));
}

for (const protocol of ["acp-v1", "codex-app-server"] as const) {
  test("formal CLI " + protocol + " probe initializes without opening a conversation or prompting", async (t) => {
    const f = await fixture(t); await manifest(f, protocol);
    const result = invoke(f, ["probe", "--harness", "fixture-alias", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const output = records(result.stdout);
    assert.deepEqual(output.map((entry) => entry.type), ["protocol", "cleanup"]);
    const trace = await traces(f);
    assert.equal(trace[0]?.method, "initialize");
    assert.ok(!trace.some((entry) => ["session/new", "session/prompt", "thread/start", "turn/start"].includes(String(entry.method))));
    await assertClosed(f);
  });

  test("formal CLI " + protocol + " run streams separate chunks before result and cleanup", async (t) => {
    const f = await fixture(t); await manifest(f, protocol, "chunks");
    const result = invoke(f, ["run", "--harness", "cli-fixture", "--prompt", "fixture prompt", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const output = records(result.stdout);
    assert.deepEqual(output.map((entry) => entry.type), ["protocol", "event", "event", "result", "cleanup"]);
    assert.deepEqual(output.filter((entry) => entry.type === "event").map((entry) => entry.event), [{ type: "text", text: "first " }, { type: "text", text: "second" }]);
    assert.deepEqual(output.find((entry) => entry.type === "result")?.result, { status: "completed", reason: protocol === "acp-v1" ? "end_turn" : "completed", ...(protocol === "acp-v1" ? { input: "recorded" } : {}) });
    const trace = await traces(f);
    const prompt = trace.find((entry) => entry.method === (protocol === "acp-v1" ? "session/prompt" : "turn/start"));
    assert.ok(prompt); assert.match(JSON.stringify(prompt), /fixture prompt/);
    await assertClosed(f);
  });

  test("formal CLI " + protocol + " rejects permissions and exposes that decision", async (t) => {
    const f = await fixture(t); await manifest(f, protocol, "permission");
    const result = invoke(f, ["run", "--harness", "cli-fixture", "--prompt", "permission fixture", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(records(result.stdout).some((entry) => entry.type === "event" && JSON.stringify(entry.event).includes('"decision":"denied"')));
    const decision = (await traces(f)).find((entry) => entry.id === "permission-1");
    assert.ok(decision); assert.match(JSON.stringify(decision), protocol === "acp-v1" ? /reject/ : /decline/);
    await assertClosed(f);
  });

  test("formal CLI " + protocol + " initialize timeout reports failure and closes its process", async (t) => {
    const f = await fixture(t); await manifest(f, protocol, "timeout");
    const result = invoke(f, ["probe", "--harness", "cli-fixture", "--timeout-ms", "100", "--json"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HarnessGateway:/);
    assert.deepEqual(records(result.stdout).map((entry) => entry.type), ["cleanup"]);
    await assertClosed(f);
  });

  test("formal CLI " + protocol + " exit zero during execution is not reported as completion", async (t) => {
    const f = await fixture(t); await manifest(f, protocol, "exit-zero");
    const result = invoke(f, ["run", "--harness", "cli-fixture", "--prompt", "unexpected exit", "--json"]);
    assert.notEqual(result.status, 0);
    assert.ok(!records(result.stdout).some((entry) => entry.type === "result" && JSON.stringify(entry.result).includes('"status":"completed"')));
    assert.equal(records(result.stdout).at(-1)?.type, "cleanup");
    await assertClosed(f);
  });

  test("formal CLI " + protocol + " preserves completion but fails the invocation on duplicate terminal messages", async (t) => {
    const f = await fixture(t); await manifest(f, protocol, "duplicate-complete");
    const result = invoke(f, ["run", "--harness", "cli-fixture", "--prompt", "duplicate terminal fixture", "--json"]);
    assert.notEqual(result.status, 0, result.stderr);
    const output = records(result.stdout);
    assert.deepEqual(output.find((entry) => entry.type === "result")?.result, { status: "completed", reason: protocol === "acp-v1" ? "end_turn" : "completed", ...(protocol === "acp-v1" ? { input: "recorded" } : {}) });
    const cleanup = output.find((entry) => entry.type === "cleanup")?.cleanup;
    assert.ok(cleanup && typeof cleanup === "object" && "closed" in cleanup && cleanup.closed === true && "protocolFailure" in cleanup && cleanup.protocolFailure !== null);
    assert.match(result.stderr, /connection failed/);
    await assertClosed(f);
  });
}

test("formal CLI accepts a v1 custom recipe without changing its argument data", async (t) => {
  const f = await fixture(t), wrapper = join(f.root, "legacy-wrapper.mjs");
  await writeFile(wrapper, "process.env.FIXTURE_PID=" + JSON.stringify(f.pid) + ";process.env.FIXTURE_TRACE=" + JSON.stringify(f.trace) + ";await import(" + JSON.stringify(pathToFileURL(peer).href) + ");\n");
  await writeFile(f.manifest, JSON.stringify({ version: 1, recipes: [{ id: "legacy-fixture", name: "Legacy Fixture", binary: "legacy-fixture-bin", protocol: "acp-v1", args: [wrapper, "acp-v1", "basic"] }], overrides: { "legacy-fixture": { binary: process.execPath } } }));
  const result = invoke(f, ["run", "--harness", "legacy-fixture", "--prompt", "legacy prompt", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(records(result.stdout).some((entry) => entry.type === "event"));
  assert.match(JSON.stringify(await traces(f)), /legacy prompt/);
  await assertClosed(f);
});

test("formal CLI ambiguous controls require explicit selection and unavailable selection never falls back", async (t) => {
  const f = await fixture(t); await manifest(f, "acp-v1", "basic", { second: true });
  const ambiguous = invoke(f, ["probe", "--harness", "cli-fixture", "--json"]);
  assert.equal(ambiguous.status, 2); assert.match(ambiguous.stderr, /multiple available controls/);
  await assert.rejects(() => readFile(f.pid), (error: unknown) => errorCode(error) === "ENOENT");
  await manifest(f, "acp-v1", "basic", { second: true, executable: join(f.root, "missing-primary") });
  const blocked = invoke(f, ["probe", "--harness", "cli-fixture", "--control", "fixture-primary", "--json"]);
  assert.equal(blocked.status, 2); assert.match(blocked.stderr, /selected control is unavailable/);
  await assert.rejects(() => readFile(f.pid), (error: unknown) => errorCode(error) === "ENOENT");
  const explicit = invoke(f, ["probe", "--harness", "cli-fixture", "--control", "fixture-secondary", "--json"]);
  assert.equal(explicit.status, 0, explicit.stderr); await assertClosed(f);
});

test("formal CLI rejects bad invocation arguments without launching", async (t) => {
  const f = await fixture(t); await manifest(f, "acp-v1");
  for (const args of [
    ["unknown"],
    ["probe", "--harness", "cli-fixture", "--prompt", "not a probe"],
    ["run", "--harness", "cli-fixture"], ["run", "--harness", "cli-fixture", "--prompt", " "],
    ["probe", "--harness", "unknown"], ["probe", "--harness", "cli-fixture", "--timeout-ms", "99"],
    ["probe", "--harness", "cli-fixture", "--cwd", "relative"], ["probe", "--unknown"],
  ]) {
    const result = invoke(f, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, ""); assert.match(result.stderr, /HarnessGateway:/);
  }
  await assert.rejects(() => readFile(f.pid), (error: unknown) => errorCode(error) === "ENOENT");
  assert.deepEqual(await readdir(f.temporary), []);
});

test("formal CLI default reuses the native host profile without forwarding unrelated host secrets", async (t) => {
  const f = await fixture(t), wrapper = join(f.root, "isolation-wrapper.mjs"), hostConfig = join(f.hostHome, "user-config.json");
  await writeFile(hostConfig, "unchanged private user fixture\n");
  await writeFile(wrapper, "import {writeFileSync} from 'node:fs';import {join} from 'node:path';\nwriteFileSync(" + JSON.stringify(f.capture) + ",JSON.stringify({home:process.env.HOME,cwd:process.cwd(),codexHome:process.env.CODEX_HOME,claudeHome:process.env.CLAUDE_CONFIG_DIR,opencodeHome:process.env.OPENCODE_CONFIG_DIR,config:process.env.XDG_CONFIG_HOME,hostSecretPresent:process.env.TEST_HOST_SECRET!==undefined,bindingValue:process.env.TEST_BINDING_VALUE}));\nwriteFileSync(join(process.env.HOME,'fixture-created-config'),'fixture');await import(" + JSON.stringify(pathToFileURL(peer).href) + ");\n");
  await manifest(f, "acp-v1", "basic", { wrapper, extraEnv: { HOME: f.hostHome, CODEX_HOME: f.hostHome, CLAUDE_CONFIG_DIR: f.hostHome, OPENCODE_CONFIG_DIR: f.hostHome, XDG_CONFIG_HOME: f.hostHome, TEST_BINDING_VALUE: "explicit-binding" } });
  const result = invoke(f, ["probe", "--harness", "cli-fixture", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const capture: unknown = JSON.parse(await readFile(f.capture, "utf8"));
  assert.ok(capture && typeof capture === "object" && "home" in capture && typeof capture.home === "string" && "cwd" in capture && typeof capture.cwd === "string");
  const home = capture.home, cwd = capture.cwd;
  assert.equal(home, f.hostHome); assert.notEqual(cwd, f.root);
  assert.ok("hostSecretPresent" in capture && capture.hostSecretPresent === false);
  assert.ok("bindingValue" in capture && capture.bindingValue === "explicit-binding");
  assert.equal("claudeHome" in capture, false, "an unset native CLAUDE_CONFIG_DIR must remain unset to preserve ~/.claude.json login");
  // Unset profile variables stay unset, as in the user's own terminal: a synthesized XDG_CONFIG_HOME moves Cursor from
  // ~/.cursor to ~/.config/cursor, and a catalog descriptor must not redirect any native profile either.
  for (const field of ["codexHome", "opencodeHome", "config"] as const) assert.equal(field in capture, false, field + " must follow the native program default");
  assert.equal(await readFile(hostConfig, "utf8"), "unchanged private user fixture\n");
  assert.equal((await stat(home)).isDirectory(), true);
  await assert.rejects(() => stat(cwd), (error: unknown) => errorCode(error) === "ENOENT");
  await assertClosed(f);
});

test("formal CLI respects explicit private configuration/workspace ownership during cleanup", async (t) => {
  const f = await fixture(t), home = join(f.root, "prepared-home"), cwd = join(f.root, "prepared-workspace");
  await mkdir(home); await mkdir(cwd); await writeFile(join(home, "config.json"), "prepared config");
  await manifest(f, "codex-app-server");
  const result = invoke(f, ["run", "--harness", "cli-fixture", "--prompt", "private cwd", "--cwd", cwd, "--config-home", home, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(home, "config.json"), "utf8"), "prepared config");
  assert.ok((await stat(cwd)).isDirectory()); assert.ok((await stat(home)).isDirectory());
  const thread = (await traces(f)).find((entry) => entry.method === "thread/start");
  assert.ok(thread && typeof thread.params === "object" && thread.params !== null && "cwd" in thread.params && thread.params.cwd === cwd);
  await assertClosed(f);
});

test("formal CLI signal waits for backend cancellation and reports a separate cleanup", async (t) => {
  const f = await fixture(t); await manifest(f, "acp-v1", "stop");
  const child = spawn(process.execPath, [cli, "run", "--harness", "cli-fixture", "--prompt", "stop fixture", "--json", "--path-only", "--allow-unofficial", "--manifest", f.manifest], { cwd: f.root, env: environment(f), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const completed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let sent = false;
  child.stdout.on("data", (value: string) => { stdout += value; if (!sent && stdout.includes('"type":"event"')) { sent = true; child.kill("SIGINT"); } });
  child.stderr.on("data", (value: string) => { stderr += value; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(async () => { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await completed; });
  const result = await completed; clearTimeout(watchdog);
  assert.equal(sent, true); assert.equal(result.signal, null); assert.equal(result.code, 1, stderr);
  const output = records(stdout);
  assert.deepEqual(output.find((entry) => entry.type === "result")?.result, { status: "cancelled", reason: "cancelled", input: "recorded" });
  assert.equal(output.at(-1)?.type, "cleanup");
  assert.ok((await traces(f)).some((entry) => entry.method === "session/cancel"));
  await assertClosed(f);
});

for (const protocol of ["acp-v1", "codex-app-server"] as const) {
  test("formal CLI " + protocol + " keeps signal ownership throughout probe cleanup", async (t) => {
    const f = await fixture(t), cleanupStarted = join(f.root, "stdin-ended"), resistantPeer = join(f.root, "resistant-peer.mjs");
    await writeFile(resistantPeer, [
      "import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';",
      "writeFileSync(process.env.FIXTURE_PID,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
      "process.stdin.on('end',()=>writeFileSync(" + JSON.stringify(cleanupStarted) + ", 'closing'));",
      "createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.method!=='initialize')return;",
      "const result=process.argv[2]==='acp-v1'?{protocolVersion:1,agentCapabilities:{},authMethods:[],agentInfo:{name:'resistant-fixture',version:'1.0'}}:{userAgent:'resistant-codex-fixture/1.0'};",
      "process.stdout.write(JSON.stringify({...((process.argv[2]==='acp-v1')?{jsonrpc:'2.0'}:{}),id:msg.id,result})+'\\n');});",
    ].join("\n"));
    await manifest(f, protocol, "basic", { wrapper: resistantPeer });
    const child = spawn(process.execPath, [cli, "probe", "--harness", "cli-fixture", "--json", "--path-only", "--allow-unofficial", "--manifest", f.manifest], { cwd: f.root, env: environment(f), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => { stdout += value; });
    child.stderr.on("data", (value: string) => { stderr += value; });
    const completed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
    t.after(async () => { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await completed; });
    let closingObserved = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { await stat(cleanupStarted); closingObserved = true; break; }
      catch (error: unknown) { if (errorCode(error) !== "ENOENT") throw error; }
      await delay(10);
    }
    assert.equal(closingObserved, true, "peer input was not closed by cleanup");
    assert.equal(child.kill("SIGTERM"), true);
    const result = await completed; clearTimeout(watchdog);
    assert.equal(result.signal, null, "CLI lost its signal handler during cleanup");
    assert.equal(result.code, 1, stderr);
    const output = records(stdout);
    assert.equal(output[0]?.type, "protocol");
    assert.equal(output.at(-1)?.type, "cleanup");
    const cleanup = output.at(-1)?.cleanup;
    assert.ok(cleanup && typeof cleanup === "object" && "closed" in cleanup && cleanup.closed === true);
    await assertClosed(f);
  });
}
