import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { DirectorySessionBindingFactory, prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { SqliteSessionReader } from "../../src/infrastructure/session/sqlite-store.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

const cli = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));
const sessionsCli = fileURLToPath(new URL("../../src/cli/sessions.js", import.meta.url));
const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
const source = { repository: "fixture", revision: "test", upstreamId: "session-peer", url: "https://example.invalid/session-peer" };
interface Fixture { readonly root: string; readonly home: string; readonly workspace: string; readonly data: string; readonly temporary: string; readonly manifest: string; readonly trace: string; readonly children: Set<ChildProcessWithoutNullStreams> }
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function records(text: string): readonly Record<string, unknown>[] {
  return text.trim() ? text.trim().split("\n").map(line => record(JSON.parse(line))) : [];
}
async function fixture(t: test.TestContext, scenario = "basic"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-session-cli-"));
  const f = { root, home: join(root, "host-home"), workspace: join(root, "workspace"), data: join(root, "data"), temporary: join(root, "temporary"), manifest: join(root, "manifest.json"), trace: join(root, "trace.ndjson"), children: new Set<ChildProcessWithoutNullStreams>() };
  await mkdir(f.home); await mkdir(f.workspace); await mkdir(f.temporary);
  t.after(async () => {
    for (const child of f.children) if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGINT"); const emergency = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await closed; } finally { clearTimeout(emergency); }
    }
    // Kill only process groups explicitly created and recorded by this test fixture.
    try { for (const entry of records(await readFile(f.trace, "utf8"))) if (entry.kind === "spawn") {
      const pid = Number(entry.pid); if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try { process.kill(-pid, "SIGKILL"); } catch (error: unknown) { if (record(error).code !== "ESRCH") throw error; }
    } } catch (error: unknown) { if (record(error).code !== "ENOENT") throw error; }
    await rm(root, { recursive: true, force: true });
  });
  const definitions = ["a", "b", "bad"].map(name => ({ id: `session-${name}`, name: `Session ${name}`, aliases: [`alias-${name}`], binaryNames: [], configHints: [],
    controls: [{ id: `session-${name}-control`, protocol: name === "b" ? "codex-app-server" : "acp-v1", executableNames: ["fixture-peer"],
      args: [peer, name === "b" ? "codex-app-server" : "acp-v1", name, name === "bad" ? "initialize-failure" : scenario],
      env: { FIXTURE_TRACE: f.trace, FIXTURE_EXPECT_HISTORY: JSON.stringify({ first: [], second: ["first"], third: ["first", "second"], fourth: ["first", "second", "third"] }),
        HOME: "/forbidden-host-home", CODEX_HOME: "/forbidden-host-codex-home", TMPDIR: "/forbidden-host-tmp" },
      package: null, distribution: null, requiredExecutables: [], source }] }));
  await writeFile(f.manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(definition => [definition.controls[0]!.id, { executable: process.execPath }])) }));
  return f;
}
function env(f: Fixture): NodeJS.ProcessEnv {
  return { PATH: join(f.root, "empty-path"), HOME: f.home, TMPDIR: f.temporary, LANG: "C", TEST_HOST_SECRET: "must-not-reach-harness" };
}
function args(f: Fixture, extra: readonly string[] = []): string[] {
  return ["--data-dir", f.data, "--cwd", f.workspace, "--manifest", f.manifest, "--path-only", "--json", ...extra];
}
interface CliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly result: Promise<{ readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }>;
  readonly output: readonly Record<string, unknown>[];
  wait(predicate: (entry: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  send(line: string): void;
}
function start(t: test.TestContext, f: Fixture, extra: readonly string[]): CliProcess {
  const child = spawn(process.execPath, [cli, ...args(f, extra)], { cwd: f.root, env: env(f), stdio: ["pipe", "pipe", "pipe"] });
  f.children.add(child);
  let stdout = "", stderr = "", partial = "", length = 0;
  const output: Record<string, unknown>[] = [];
  const pending = new Set<{ predicate: (entry: Record<string, unknown>) => boolean; resolve: (entry: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const result = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      for (const waiter of pending) waiter.reject(new Error(`CLI ended before expected output: ${code}/${signal}: ${stderr}\n${stdout}`));
      pending.clear(); resolve({ code, signal, stdout, stderr });
    });
  });
  void result.catch(() => {});
  child.stdout.on("data", (chunk: string) => {
    length += Buffer.byteLength(chunk); assert.ok(length < 4 * 1024 * 1024, "CLI output exceeds its budget");
    stdout += chunk; partial += chunk;
    for (;;) {
      const end = partial.indexOf("\n"); if (end < 0) break;
      const line = partial.slice(0, end); partial = partial.slice(end + 1);
      if (!line.trim()) continue;
      const entry = record(JSON.parse(line)); output.push(entry);
      for (const waiter of pending) if (waiter.predicate(entry)) { pending.delete(waiter); waiter.resolve(entry); }
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    const emergency = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await result; } finally { clearTimeout(emergency); clearTimeout(watchdog); }
  });
  return { child, result, output, send(line) { child.stdin.write(line + "\n"); }, wait(predicate) {
    const prior = output.find(predicate); if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => pending.add({ predicate, resolve, reject }));
  } };
}
function event(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (entry.type === "event") return record(entry.event);
  return typeof entry.seq === "number" ? entry : null;
}
function hasEvent(type: string, count = 1): (entry: Record<string, unknown>) => boolean {
  let seen = 0;
  return entry => { if (event(entry)?.type === type) ++seen; return seen === count; };
}
async function persisted(f: Fixture): Promise<SessionSnapshot> {
  const reader = new SqliteSessionReader(f.data);
  try { const list = reader.list(); assert.equal(list.length, 1); return list[0]!; } finally { reader.close(); }
}
async function trace(f: Fixture): Promise<readonly Record<string, unknown>[]> { return records(await readFile(f.trace, "utf8")); }
async function assertClean(f: Fixture): Promise<void> {
  const traces = await trace(f);
  for (const entry of traces.filter(entry => entry.kind === "spawn")) {
    assert.equal(entry.hostSecret, null, "host secrets leaked to a Harness");
    assert.notEqual(entry.home, "/forbidden-host-home"); assert.notEqual(entry.codexHome, "/forbidden-host-codex-home");
    assert.throws(() => process.kill(Number(entry.pid), 0), (error: unknown) => record(error).code === "ESRCH", "Harness process remains alive");
  }
  assert.deepEqual(await readdir(f.temporary), [], "owned temporary roots remain after close");
}

test("Session binding configuration requires real canonical directories and fingerprints a bounded regular manifest", async t => {
  const f = await fixture(t), alias = join(f.root, "workspace-alias"); await symlink(f.workspace, alias);
  const prepared = await prepareConfiguration({ workspace: alias, manifestPath: f.manifest, searchDirs: [f.workspace], configHome: f.home, pathOnly: true });
  assert.equal(prepared.workspace, await realpath(f.workspace)); assert.match(prepared.manifestSha256 ?? "", /^[a-f0-9]{64}$/u);
  await assert.rejects(prepareConfiguration({ workspace: join(f.root, "missing") }));
  await assert.rejects(prepareConfiguration({ workspace: f.workspace, configHome: "" }));
  const link = join(f.root, "manifest-link"); await symlink(f.manifest, link);
  await assert.rejects(prepareConfiguration({ workspace: f.workspace, manifestPath: link }));
  await assert.rejects(prepareConfiguration({ workspace: f.workspace, manifestPath: f.root }));
  await writeFile(f.manifest, Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest }));
});

test("Session binding validates aliases without launching a process and rejects manifest changes", async t => {
  const f = await fixture(t), configuration = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true });
  const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {});
  const selected = await factory.validate({ harnessId: "alias-a" }, configuration);
  assert.deepEqual(selected, { harnessId: "session-a", controlId: "session-a-control" });
  await assert.rejects(readFile(f.trace));
  await writeFile(f.manifest, "{}\n");
  await assert.rejects(factory.validate({ harnessId: "session-a" }, configuration), (error: unknown) => record(error).code === "CONFIGURATION_CHANGED");
  await assert.rejects(factory.prepare(selected, configuration, sessionId("session-fixture"), "run-fixture"), (error: unknown) => record(error).code === "CONFIGURATION_CHANGED");
  const lease = new SqliteWorkspaceLeaseProvider(join(f.root, "locks")).acquire(f.workspace, sessionId("session-retry"), "run-retry"); lease.release(true);
});

test("Session binding owns its lease, isolates configuration and closes idempotently", async t => {
  const f = await fixture(t), configuration = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true });
  const leases = new SqliteWorkspaceLeaseProvider(join(f.root, "locks"));
  let owned = true;
  const factory = new DirectorySessionBindingFactory(leases, () => { if (!owned) throw new Error("owner lost"); });
  const selection = await factory.validate({ harnessId: "session-a" }, configuration);
  const binding = await factory.prepare(selection, configuration, sessionId("session-fixture"), "run-fixture");
  binding.assertOwned();
  assert.throws(() => leases.acquire(f.workspace, sessionId("session-other"), "run-other"));
  await binding.control.initialize(); await binding.control.open(configuration.workspace);
  owned = false; assert.throws(() => binding.assertOwned(), /owner lost/u);
  const cleanup = await binding.close(); assert.equal(cleanup.closed, true); assert.equal(await binding.close(), cleanup);
  assert.throws(() => binding.assertOwned());
  const next = leases.acquire(f.workspace, sessionId("session-other"), "run-other"); next.release(true);
  const spawn = (await trace(f)).find(entry => entry.kind === "spawn"); assert.ok(spawn);
  assert.notEqual(spawn.home, "/forbidden-host-home");
  await assert.rejects(readFile(String(spawn.temporary) + "/catalog-snapshot.json"));
});

test("formal chat persists one public Session through ACP A→Codex B→ACP A and an independent process reopen", async t => {
  const f = await fixture(t), chat = start(t, f, ["--harness", "alias-a"]);
  const first = hasEvent("run.ended"); chat.send("first"); await chat.wait(first);
  const switchedB = hasEvent("switch.effective"); chat.send(":harness session-b"); await chat.wait(switchedB);
  const second = hasEvent("run.ended", 2); chat.send("second"); await chat.wait(second);
  const switchedA = hasEvent("switch.effective", 2); chat.send(":harness session-a:session-a-control"); await chat.wait(switchedA);
  const third = hasEvent("run.ended", 3); chat.send("third"); await chat.wait(third);
  chat.send(":history"); chat.send(":quit"); const ended = await chat.result;
  assert.equal(ended.code, 0, ended.stderr); assert.equal(ended.signal, null);
  const original = await persisted(f);
  assert.equal(original.epoch, 3); assert.equal(original.status, "open"); assert.equal(original.runs.length, 3);
  assert.deepEqual(original.runs.map(run => run.selection.harnessId), ["session-a", "session-b", "session-a"]);
  assert.deepEqual(original.messages.map(message => message.text), ["first", "a:first", "second", "b:second", "third", "a:third"]);
  assert.ok(original.runs.every(run => run.status === "completed" && run.cleanup?.closed === true));
  const reopen = start(t, f, ["--session", original.id]);
  reopen.send(":history"); reopen.send("fourth"); await reopen.wait(hasEvent("run.ended")); reopen.send(":quit");
  const resumed = await reopen.result; assert.equal(resumed.code, 0, resumed.stderr);
  const recovered = await persisted(f); assert.equal(recovered.id, original.id); assert.equal(recovered.runs.length, 4);
  assert.deepEqual(recovered.runs[3]?.sourceRunIds, recovered.runs.slice(0, 3).map(run => run.id));
  const prompts = (await trace(f)).filter(entry => entry.kind === "prompt");
  assert.equal(prompts.length, 4, "prior inputs were unexpectedly replayed");
  assert.equal(new Set(prompts.map(entry => entry.nativeId)).size, 4, "fresh native bindings were not created");
  assert.ok(prompts.every(entry => entry.nativeId !== original.id));
  const lastContext = record(prompts[3]?.context);
  assert.ok(Array.isArray(lastContext.history)); assert.equal(lastContext.history.length, 3);
  await assertClean(f);
});

test("Session binding preserves explicitly prepared private configuration and refuses an unimplemented protocol", async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, "prepared-config"), "synthetic private settings");
  const configuration = await prepareConfiguration({ workspace: f.workspace, configHome: f.home, manifestPath: f.manifest, pathOnly: true });
  const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {});
  const selection = await factory.validate({ harnessId: "session-a" }, configuration);
  const binding = await factory.prepare(selection, configuration, sessionId("session-config"), "run-config");
  await binding.control.initialize(); await binding.close();
  assert.equal(await readFile(join(f.home, "prepared-config"), "utf8"), "synthetic private settings");
  const manifest = record(JSON.parse(await readFile(f.manifest, "utf8")));
  assert.ok(Array.isArray(manifest.definitions));
  const definition = record(manifest.definitions[0]); assert.ok(Array.isArray(definition.controls));
  record(definition.controls[0]).protocol = "pi-rpc";
  await writeFile(f.manifest, JSON.stringify(manifest));
  const changed = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true });
  await assert.rejects(factory.validate({ harnessId: "session-a" }, changed), (error: unknown) => record(error).code === "UNSUPPORTED_CONTROL");
});

test("formal chat cancellation remains readable during a running external Harness", async t => {
  const f = await fixture(t, "hold"), chat = start(t, f, ["--harness", "session-a"]);
  chat.send("first"); await chat.wait(hasEvent("run.output"));
  chat.send(":cancel"); await chat.wait(hasEvent("run.ended")); chat.send(":quit");
  const ended = await chat.result; assert.equal(ended.signal, null);
  const state = await persisted(f); assert.equal(state.runs[0]?.status, "cancelled"); assert.equal(state.runs[0]?.cancelRequested, true);
  assert.equal(state.runs[0]?.cleanup?.closed, true); assert.ok((await trace(f)).some(entry => record(entry.message ?? {}).method === "session/cancel"));
  await assertClean(f);
});

test("formal chat failed target preparation keeps the active selection and public history", async t => {
  const f = await fixture(t), chat = start(t, f, ["--harness", "session-a"]);
  chat.send("first"); await chat.wait(hasEvent("run.ended"));
  chat.send(":harness session-bad"); await chat.wait(hasEvent("switch.failed")); chat.send(":quit");
  const ended = await chat.result; assert.equal(ended.signal, null);
  const state = await persisted(f); assert.equal(state.epoch, 1); assert.equal(state.selection.harnessId, "session-a");
  assert.equal(state.switches[0]?.status, "failed"); assert.equal(state.messages[0]?.text, "first");
  await assertClean(f);
});

test("formal chat management lists history and closes admission without launching a Harness", async t => {
  const f = await fixture(t), chat = start(t, f, ["--harness", "session-a"]);
  chat.send("first"); await chat.wait(hasEvent("run.ended")); chat.send(":quit"); assert.equal((await chat.result).code, 0);
  const state = await persisted(f), before = (await trace(f)).filter(entry => entry.kind === "spawn").length;
  for (const action of ["list", "show", "events"] as const) {
    const called = spawnSync(process.execPath, [sessionsCli, action, "--data-dir", f.data, "--json", ...(action === "list" ? [] : ["--session", state.id])], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 10000 });
    assert.equal(called.status, 0, called.stderr); assert.ok(called.stdout.trim());
  }
  const close = spawnSync(process.execPath, [sessionsCli, "close", "--data-dir", f.data, "--session", state.id, "--json"], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 10000 });
  assert.equal(close.status, 0, close.stderr); assert.equal((await persisted(f)).status, "closed");
  assert.equal((await trace(f)).filter(entry => entry.kind === "spawn").length, before);
  const resumed = start(t, f, ["--session", state.id]); resumed.child.stdin.end("another input\n"); assert.notEqual((await resumed.result).code, 0);
  await assertClean(f);
});

test("formal chat single-prompt command identity replays its public Run without re-dispatch and rejects changed input", async t => {
  const f = await fixture(t);
  const invoke = (extra: readonly string[]) => spawnSync(process.execPath, [cli, ...args(f, extra)], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const first = invoke(["--harness", "session-a", "--prompt", "first", "--command-id", "fixed-cli-input"]);
  assert.equal(first.status, 0, first.stderr);
  const state = await persisted(f);
  const before = (await trace(f)).filter(entry => entry.kind === "prompt").length;
  assert.equal(before, 1);
  const replay = invoke(["--session", state.id, "--prompt", "first", "--command-id", "fixed-cli-input"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal((await persisted(f)).runs.length, 1);
  assert.equal((await trace(f)).filter(entry => entry.kind === "prompt").length, before);
  const conflict = invoke(["--session", state.id, "--prompt", "changed input", "--command-id", "fixed-cli-input"]);
  assert.notEqual(conflict.status, 0);
  assert.equal((await persisted(f)).runs.length, 1);
  await assertClean(f);
});

test("formal chat initial command retry without a Session id retains the same public identity", async t => {
  const f = await fixture(t);
  const options = args(f, ["--harness", "session-a", "--prompt", "first", "--command-id", "fixed-create-input"]);
  const invoke = () => spawnSync(process.execPath, [cli, ...options], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 15000 });
  const first = invoke(); assert.equal(first.status, 0, first.stderr); const state = await persisted(f);
  const retry = invoke(); assert.equal(retry.status, 0, retry.stderr);
  const repeated = await persisted(f); assert.equal(repeated.id, state.id); assert.equal(repeated.runs.length, 1);
  assert.equal((await trace(f)).filter(entry => entry.kind === "prompt").length, 1);
  await assertClean(f);
});

test("formal chat rejects resume workspace changes and fails changed admitted manifests before native dispatch", async t => {
  const f = await fixture(t), chat = start(t, f, ["--harness", "session-a"]);
  chat.send("first"); await chat.wait(hasEvent("run.ended")); chat.send(":quit"); assert.equal((await chat.result).code, 0);
  const state = await persisted(f), alternate = join(f.root, "alternate-workspace"); await mkdir(alternate);
  const changedWorkspace = spawnSync(process.execPath, [cli, "--data-dir", f.data, "--session", state.id, "--cwd", alternate, "--prompt", "second", "--json"], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 10000 });
  assert.notEqual(changedWorkspace.status, 0);
  assert.ok(records(changedWorkspace.stdout).some(entry => record(entry.error ?? {}).code === "CONFIGURATION_CONFLICT"));
  assert.equal((await persisted(f)).runs.length, 1);
  await writeFile(f.manifest, await readFile(f.manifest, "utf8") + "\n");
  const changedManifest = spawnSync(process.execPath, [cli, "--data-dir", f.data, "--session", state.id, "--prompt", "second", "--json"], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 10000 });
  assert.notEqual(changedManifest.status, 0);
  const final = await persisted(f);
  assert.equal(final.runs.length, 2); assert.equal(final.runs[1]?.status, "failed"); assert.equal(final.runs[1]?.error?.code, "CONFIGURATION_CHANGED");
  assert.equal((await trace(f)).filter(entry => entry.kind === "prompt").length, 1, "changed source dispatched a native prompt");
  await assertClean(f);
});

test("formal human chat output streams assistant text from committed public events", async t => {
  const f = await fixture(t);
  const options = args(f, ["--harness", "session-a", "--prompt", "first"]).filter(value => value !== "--json");
  const invoked = spawnSync(process.execPath, [cli, ...options], { cwd: f.root, env: env(f), encoding: "utf8", timeout: 15000 });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.match(invoked.stdout, /a:first/u); assert.match(invoked.stdout, /public_context_rehydrate/u);
  assert.equal((await persisted(f)).messages.at(-1)?.text, "a:first");
  await assertClean(f);
});
