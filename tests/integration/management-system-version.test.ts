import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ManagementError, type SystemInstallationObservation } from "../../src/contracts/management.js";
import { observedPackageVersion, probeSystemVersion } from "../../src/infrastructure/management/system-version.js";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

interface Fixture { readonly root: string; readonly path: string; readonly trace: string; readonly node: string; readonly cleanup: (() => Promise<void>)[] }
async function fixture(t: test.TestContext, mode = "version", output = "Harness Fixture 1.2.3"): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-system-version-test-"))), path = join(root, "harness-fixture.mjs"), trace = join(root, "trace.json"), node = await realpath(process.execPath);
  const source = `#!${node}\nimport{writeFileSync}from'node:fs';
writeFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),home:process.env.HOME,tmp:process.env.TMPDIR,keys:Object.keys(process.env),systemSettings:process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH}));
if(${JSON.stringify(mode)}==='unsupported'){process.stderr.write('unsupported version option\\n');process.exit(2);}
if(${JSON.stringify(mode)}==='hold'){process.stdout.write('waiting\\n');setInterval(()=>{},1000);}else if(${JSON.stringify(mode)}==='overflow'){process.stdout.write('x'.repeat(65537));setInterval(()=>{},1000);}else if(${JSON.stringify(mode)}==='stderr'){process.stderr.write(${JSON.stringify(output)}+'\\n');}else{process.stdout.write(${JSON.stringify(output)}+'\\n');}
`;
  await writeFile(path, source, { mode: 0o700 });
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    let failure: unknown;
    for (const close of cleanup) try { await close(); } catch (error) { failure ??= error; }
    if (existsSync(trace)) {
      const value = await traceValue({ root, path, trace, node, cleanup });
      try { process.kill(value.pid, "SIGKILL"); } catch (error: unknown) { if (object(error).code !== "ESRCH") throw error; }
    }
    await rm(root, { recursive: true, force: true });
    if (failure) throw failure;
  });
  return { root, path, trace, node, cleanup };
}
function object(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
async function traceValue(f: Fixture): Promise<{ readonly pid: number; readonly tmp: string; readonly home: string; readonly args: readonly string[]; readonly keys: readonly string[] }> {
  const value = object(JSON.parse(await readFile(f.trace, "utf8"))); assert.ok(typeof value.pid === "number" && Number.isSafeInteger(value.pid)); assert.ok(typeof value.tmp === "string"); assert.ok(typeof value.home === "string"); assert.ok(Array.isArray(value.args)); assert.ok(Array.isArray(value.keys));
  return { pid: value.pid, tmp: value.tmp, home: value.home, args: value.args.map(String), keys: value.keys.map(String) };
}
function observation(f: Fixture, native = false): SystemInstallationObservation {
  return { harnessId: "codex", controlId: "codex-native", command: { executable: native ? f.path : f.node, args: native ? ["app-server"] : [f.path, "app-server"], env: { GEMINI_API_KEY: "synthetic-key-must-not-reach-version-process", NODE_OPTIONS: "--import /must-not-be-used" } } };
}
function assertStopped(pid: number): void { assert.throws(() => process.kill(pid, 0), (error: unknown) => object(error).code === "ESRCH", "version process survived completion"); }

test("explicit native version probe uses only --version, a private environment and awaited cleanup", async t => {
  const f = await fixture(t), result = await probeSystemVersion(observation(f, true), { signal: new AbortController().signal, assertOwned: () => {} });
  assert.deepEqual(result, { version: "1.2.3", reason: null });
  const trace = await traceValue(f); assert.deepEqual(trace.args, ["--version"]); assert.equal(trace.keys.includes("GEMINI_API_KEY"), false); assert.equal(trace.keys.includes("NODE_OPTIONS"), false);
  assert.notEqual(trace.home, f.root); assertStopped(trace.pid); assert.equal(existsSync(trace.tmp), false);
});

test("known Node package entry receives --version rather than probing the Node runtime version", async t => {
  const f = await fixture(t), result = await probeSystemVersion(observation(f), { signal: new AbortController().signal, assertOwned: () => {} });
  assert.equal(result.version, "1.2.3"); assert.deepEqual((await traceValue(f)).args, ["--version"]);
  const nodeOnly = await probeSystemVersion({ ...observation(f), command: { executable: f.node, args: [], env: {} } }, { signal: new AbortController().signal, assertOwned: () => {} });
  assert.equal(nodeOnly.version, null); assert.match(nodeOnly.reason ?? "", /Node runtime/u);
});

test("verified package metadata returns its version without launching a command or guessing its directory name", async t => {
  const f = await fixture(t), result = await probeSystemVersion({ ...observation(f), packageVersion: "4.5.6" }, { signal: new AbortController().signal, assertOwned: () => {} });
  assert.deepEqual(result, { version: "4.5.6", reason: null }); assert.equal(existsSync(f.trace), false);
  assert.equal(observedPackageVersion([{ code: "package_version_observed", detail: "installed=0.62.0; catalog-reference=0.63.0; protocol not probed" }]), "0.62.0");
  assert.equal(observedPackageVersion([{ code: "package_version_observed", detail: "managed=0.63.0; installation=installation-fixture" }]), undefined);
});

test("version output on stderr is accepted, while ambiguous or missing versions remain unknown", async t => {
  const stderr = await fixture(t, "stderr", "Fixture CLI v3.4.5-beta.1");
  assert.equal((await probeSystemVersion(observation(stderr), { signal: new AbortController().signal, assertOwned: () => {} })).version, "3.4.5-beta.1");
  const ambiguous = await fixture(t, "version", "Fixture primary 1.2.3 alternate 4.5.6");
  const result = await probeSystemVersion(observation(ambiguous), { signal: new AbortController().signal, assertOwned: () => {} }); assert.equal(result.version, null); assert.match(result.reason ?? "", /unambiguous/u);
  const unsupportedFormat = await fixture(t, "version", "Fixture 1.2.3.dev7");
  assert.equal((await probeSystemVersion(observation(unsupportedFormat), { signal: new AbortController().signal, assertOwned: () => {} })).version, null, "unsupported suffix was silently discarded");
});

test("unsupported --version exits unknown and closes the actual process", async t => {
  const f = await fixture(t, "unsupported"), result = await probeSystemVersion(observation(f), { signal: new AbortController().signal, assertOwned: () => {} });
  assert.equal(result.version, null); assert.match(result.reason ?? "", /does not support/u); assertStopped((await traceValue(f)).pid);
});

test("five-second version deadline closes a hanging CLI and reports an unknown version", { timeout: 10000 }, async t => {
  const f = await fixture(t, "hold"), started = Date.now(), result = await probeSystemVersion(observation(f), { signal: new AbortController().signal, assertOwned: () => {} });
  assert.equal(result.version, null); assert.match(result.reason ?? "", /five-second/u); assert.ok(Date.now() - started < 8000); const trace = await traceValue(f); assertStopped(trace.pid); assert.equal(existsSync(trace.tmp), false);
});

test("cancelled version probe waits for CLI shutdown and removes only its owned temporary root", async t => {
  const f = await fixture(t, "hold"), controller = new AbortController(), pending = probeSystemVersion(observation(f), { signal: controller.signal, assertOwned: () => {} });
  // The CLI has started once its trace is complete: the file can exist, still empty, before the fixture has written it.
  const traced = () => { try { JSON.parse(readFileSync(f.trace, "utf8")); return true; } catch { return false; } };
  const deadline = Date.now() + 3000; while (!traced() && Date.now() < deadline) await delay(10);
  assert.ok(traced()); controller.abort(); const result = await pending; assert.equal(result.version, null); assert.match(result.reason ?? "", /cancelled/u);
  const trace = await traceValue(f); assertStopped(trace.pid); assert.equal(existsSync(trace.tmp), false); assert.equal(existsSync(f.path), true);
});

test("version output budget closes an excessive writer without returning a guessed version", async t => {
  const f = await fixture(t, "overflow"), result = await probeSystemVersion(observation(f), { signal: new AbortController().signal, assertOwned: () => {} });
  assert.equal(result.version, null); assert.match(result.reason ?? "", /64 KiB/u); assertStopped((await traceValue(f)).pid);
});

test("owner loss during version output closes the child before surfacing the ownership failure", async t => {
  const f = await fixture(t, "hold");
  await assert.rejects(probeSystemVersion(observation(f), { signal: new AbortController().signal, assertOwned: () => { if (existsSync(f.trace)) throw new ManagementError("OWNERSHIP_LOST", "fixture owner ended"); } }), (error: unknown) => object(error).code === "OWNERSHIP_LOST");
  assertStopped((await traceValue(f)).pid);
});

test("real manager update check detects an observed system version and preserves managed defaults and job history", async t => {
  const f = await fixture(t), store = new SqliteSessionStore(join(f.root, "data"));
  const manager = new LocalHarnessManagement(join(f.root, "data"), { installationMode: "private-fixture", assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration,
    metadata: { resolve: async (recipe, signal) => { signal.throwIfAborted(); return { recipe, version: "2.0.0", artifactUrl: null, integrity: null, engines: {}, dependencies: [] }; } } });
  f.cleanup.push(async () => { try { await manager.shutdown(); } finally { store.close(); } });
  manager.setSystemObservations([observation(f)]);
  const before = manager.views(["codex"])[0]; assert.equal(before?.source, "system"); assert.equal(existsSync(f.trace), false, "observation triggered a version process");
  const checked = (await manager.checkUpdates(["codex"]))[0]; assert.equal(checked?.installedVersion, "1.2.3"); assert.equal(checked?.latestVersion, "2.0.0"); assert.equal(checked?.updateStatus, "available");
  assert.equal(checked?.defaultRevision, 0); assert.equal(checked?.installationId, null); assert.deepEqual(manager.listJobs(), []); assertStopped((await traceValue(f)).pid);
});

test("an adapter entry keeps its own version while the product reports the version of its own command, probed once", async t => {
  const f = await fixture(t), store = new SqliteSessionStore(join(f.root, "data")), probed: string[] = [];
  const manager = new LocalHarnessManagement(join(f.root, "data"), { installationMode: "private-fixture", assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration,
    // Like the real probe, an observed package version answers without running anything.
    systemVersionProbe: async observation => { if (observation.packageVersion) return { version: observation.packageVersion, reason: null };
      probed.push(observation.command.executable); return { version: observation.command.executable.endsWith("/claude") ? "2.1.296" : "0.89.1", reason: null }; } });
  f.cleanup.push(async () => { try { await manager.shutdown(); } finally { store.close(); } });
  manager.setSystemObservations([{ harnessId: "claude", controlId: "claude-acp-npm", command: { executable: "/opt/bin/claude-agent-acp", args: [], env: {} }, program: { executable: "/opt/bin/claude", args: [], env: {} } },
    { harnessId: "codex", controlId: "codex-native", command: { executable: "/opt/bin/codex", args: ["app-server"], env: {} }, packageVersion: "0.162.1" }]);
  // Nothing runs until versions are read, and an unread product version is unknown rather than the adapter's.
  assert.deepEqual(probed, []); assert.equal(manager.views(["claude"])[0]?.programVersion, null);
  await manager.refreshSystemVersions(); await manager.refreshSystemVersions();
  const [claude, codex] = manager.views(["claude", "codex"]);
  assert.equal(claude?.installedVersion, "0.89.1"); assert.equal(claude?.programVersion, "2.1.296");
  assert.equal(codex?.installedVersion, "0.162.1"); assert.equal(codex?.programVersion, "0.162.1");
  assert.deepEqual(probed.filter(path => path === "/opt/bin/claude"), ["/opt/bin/claude"]);
});
