import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { NativeManagement } from "../../src/infrastructure/management/native.js";
import { NativeInstallationLocks } from "../../src/infrastructure/management/native-lock.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { ManagementError, type ManagementMetadataPort, type ManagementRecipe, type NativeProgramUsers } from "../../src/contracts/management.js";
import { systemProgramHost, type ProgramHost } from "../../src/infrastructure/management/program-usage.js";
import { compareReleases, isolatedSandboxProfile, isPrerelease } from "../../src/infrastructure/management/native.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { managementStorage } from "../../src/infrastructure/management/storage.js";
import { parseManagementJob } from "../../src/contexts/management/domain/state.js";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const recipe: ManagementRecipe = { harnessId: "native-fixture", controlId: "native-fixture-npm", kind: "npm", packageName: "fixture-agent", referenceVersion: "1.0.0", binName: "fixture-agent", args: [], archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] };
/** launchd as a test sees it: jobs running the fixture's programs, what `print` says after each restart, and every restart asked for. */
interface FakeLaunchd {
  readonly services: readonly { readonly label: string; readonly pid: number; readonly args: (packageRoot: string) => readonly string[] }[];
  readonly after: (label: string, restarts: number) => { readonly state: string; readonly pid: number | null; readonly runs: number } | null;
  readonly listening?: (pid: number) => string;
  readonly kicked: string[];
}
const jobText = (pid: number, args: readonly string[]) => "{\n\t\"Label\" = \"fixture\";\n\t\"PID\" = " + pid + ";\n\t\"Program\" = \"" + args[0] + "\";\n\t\"ProgramArguments\" = (\n" + args.map(arg => "\t\t\"" + arg + "\";\n").join("") + "\t);\n};\n";
const printText = (state: { readonly state: string; readonly pid: number | null; readonly runs: number }) => "x = {\n\tstate = " + state.state + "\n\truns = " + state.runs + (state.pid === null ? "" : "\n\tpid = " + state.pid) + "\n\tenvironment = {\n\t\tTOKEN => never-read\n\t}\n}\n";
/** The real process table with launchd replaced: no jobs unless a test gives some, and a clock that runs as fast as it is read. */
function fakeHost(packageRoot: string, launchd: FakeLaunchd | undefined): ProgramHost {
  let clock = 0;
  const service = (target: string) => launchd?.services.find(item => target.endsWith("/" + item.label));
  return { ...systemProgramHost(), platform: launchd === undefined ? process.platform : "darwin",
    jobs: async () => "PID\tStatus\tLabel\n" + (launchd?.services ?? []).map(item => item.pid + "\t0\t" + item.label + "\n").join(""),
    job: async label => { const item = launchd?.services.find(entry => entry.label === label); return item ? jobText(item.pid, item.args(packageRoot)) : null; },
    print: async target => { const item = service(target); if (!item || !target.startsWith("gui/")) return null; const restarts = launchd!.kicked.filter(entry => entry === target).length;
      const state = restarts === 0 ? { state: "running", pid: item.pid, runs: 1 } : launchd!.after(item.label, restarts); return state === null ? null : printText(state); },
    kickstart: async target => { launchd?.kicked.push(target); }, listening: async pid => launchd?.listening?.(pid) ?? "", openers: async () => "",
    sleep: async () => {}, now: () => (clock += 250) };
}
async function fixture(t: test.TestContext, attack = false, beforeCleanup?: () => Promise<void>, verificationAttack = false,
  extra: { readonly recipe?: ManagementRecipe; readonly launchd?: FakeLaunchd; readonly users?: NativeProgramUsers; readonly pause?: { readonly started: string; readonly go: string } } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-install-test-"))), home = join(root, "user-home"), prefix = join(root, "global"), data = join(root, "data"), packageRoot = join(prefix, "lib", "node_modules", "fixture-agent"), entry = join(prefix, "bin", "fixture-agent"), npm = join(root, "npm");
  await mkdir(home); await mkdir(packageRoot, { recursive: true }); await mkdir(dirname(entry), { recursive: true });
  const config = join(home, ".claude.json"); await writeFile(config, '{"model":"keep-model","login":"synthetic-login"}');
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-agent", version: "1.0.0", bin: { "fixture-agent": "entry.mjs" } }));
  await writeFile(join(packageRoot, "entry.mjs"), "#!" + process.execPath + "\nimport{readFileSync,writeFileSync}from'node:fs';import{dirname,join}from'node:path';" + (verificationAttack ? "writeFileSync(" + JSON.stringify(config) + ",'changed during version check');" : "") + "console.log(JSON.parse(readFileSync(join(dirname(process.argv[1]),'package.json'))).version);\n", { mode: 0o700 });
  await symlink(join(packageRoot, "entry.mjs"), entry);
  const code = "#!" + process.execPath + "\nimport{writeFile}from'node:fs/promises';const a=process.argv.slice(2);if(a[0]==='prefix'){if(process.env.HOME!==" + JSON.stringify(home) + ")throw Error('prefix query lost native HOME');console.log(" + JSON.stringify(prefix) + ");process.exit(0);}if(a[0]!=='install')throw Error('unexpected command');" + (attack ? "await writeFile(" + JSON.stringify(config) + ",'changed');" : "")
    + (extra.pause ? "await writeFile(" + JSON.stringify(extra.pause.started) + ",'1');const{existsSync}=await import('node:fs');while(!existsSync(" + JSON.stringify(extra.pause.go) + "))await new Promise(r=>setTimeout(r,20));" : "") + "const version=a.at(-1).split('@').at(-1);await writeFile(" + JSON.stringify(join(packageRoot, "package.json")) + ",JSON.stringify({name:'fixture-agent',version,bin:{'fixture-agent':'entry.mjs'}}));console.log('native package updated');\n";
  await writeFile(npm, code, { mode: 0o700 });
  let version = "2.0.0", binNames = [recipe.binName], engines: Record<string, string> = {};
  const metadata: ManagementMetadataPort = { resolve: async original => ({ recipe: original, version: original.referenceVersion === "latest" ? version : original.referenceVersion, artifactUrl: null, integrity: null, engines, binNames, dependencies: [] }) };
  const environment = { home, values: { HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } };
  const native = new NativeManagement(npm, null, process.execPath, environment, metadata, fakeHost(packageRoot, extra.launchd)), store = new SqliteSessionStore(data), locks = new NativeInstallationLocks(join(root, "locks"));
  const manager = new LocalHarnessManagement(data, { assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, recipes: [extra.recipe ?? recipe], native, nativeLocks: locks });
  if (extra.users) manager.attachProgramUsers(extra.users);
  manager.setSystemObservations([{ harnessId: recipe.harnessId, controlId: recipe.controlId, command: { executable: entry, args: [], env: {} }, packageVersion: "1.0.0" }]);
  await manager.refreshNativeCapabilities();
  t.after(async () => { await beforeCleanup?.(); await manager.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, manager, locks, config, packageRoot, native, environment, entry, setVersion: (value: string) => { version = value; }, setBins: (value: string[]) => { binNames = value; }, setEngines: (value: Record<string, string>) => { engines = value; } };
}
async function settled(manager: LocalHarnessManagement, id: string) {
  const until = Date.now() + 10000;
  for (;;) { const job = manager.readJob(id); if (["completed", "failed", "cancelled", "unknown"].includes(job.status)) return job; assert.ok(Date.now() < until); await new Promise<void>(resolve => setImmediate(resolve)); }
}
test("native maintenance uses the actual global package and verifies the executable without activating a private copy", async t => {
  const f = await fixture(t), capability = f.manager.views([recipe.harnessId])[0]!.native!;
  assert.equal(capability.channel, "npm"); assert.equal(capability.canUpgrade, true);
  if (process.platform !== "darwin") return assert.equal((await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "native", expectedNativeFingerprint: capability.fingerprint }).id)).status, "failed");
  const request = { harnessId: recipe.harnessId, action: "upgrade" as const, commandId: "native", expectedNativeFingerprint: capability.fingerprint };
  const job = f.manager.submit(request); assert.equal(f.manager.submit(request).id, job.id);
  const result = await settled(f.manager, job.id); assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(result.installationId, null);
  assert.equal(result.native?.actualVersion, "2.0.0"); assert.equal(result.native?.configurationPreserved, true); assert.equal(f.manager.resolveControl(recipe.harnessId, recipe.controlId), null);
  assert.equal(JSON.parse(await readFile(join(f.packageRoot, "package.json"), "utf8")).version, "2.0.0"); assert.equal((await readFile(f.config, "utf8")), '{"model":"keep-model","login":"synthetic-login"}');
});
test("shared native usage and maintenance locks reject concurrent mutation and retain unknown state", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-lock-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const a = new NativeInstallationLocks(root), b = new NativeInstallationLocks(root), first = a.read("fixture"), second = b.read("fixture");
  assert.throws(() => a.write("fixture", "job"), error => error instanceof ManagementError && error.code === "HARNESS_BUSY"); first.release(); second.release();
  const writer = b.write("fixture", "job"); assert.throws(() => a.read("fixture"), ManagementError); writer.release(false);
  assert.throws(() => a.read("fixture"), error => error instanceof ManagementError && error.code === "NATIVE_INSTALLATION_UNKNOWN");
  const inspection = a.write("fixture", "job", true); inspection.assertOwned(); inspection.release(true);
  const resumed = b.read("fixture"); resumed.release();
});
test("a corrupt native lock schema is a storage failure rather than a fabricated busy program", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-lock-corruption-")); t.after(() => rm(root, { recursive: true, force: true }));
  const locks = new NativeInstallationLocks(root), lease = locks.read("fixture"); lease.release();
  const db = new DatabaseSync(join(root, "fixture", "access.sqlite")); db.exec("PRAGMA user_version=99"); db.close();
  assert.throws(() => locks.read("fixture"), error => error instanceof ManagementError && error.code === "INVALID_STORAGE");
});
test("native installation writes to a protected model/login configuration are actually denied", async t => {
  const f = await fixture(t, true), before = await readFile(f.config), capability = f.manager.views([recipe.harnessId])[0]!.native!;
  const job = f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "deny-config-write", expectedNativeFingerprint: capability.fingerprint });
  const result = await settled(f.manager, job.id);
  assert.equal(result.status, process.platform === "darwin" ? "unknown" : "failed"); assert.deepEqual(await readFile(f.config), before);
  if (process.platform === "darwin") assert.throws(() => f.locks.read(recipe.harnessId), /pending maintenance/);
  if (process.platform === "darwin") {
    const inspected = await f.manager.inspectNativeResult(job.id);
    assert.equal(inspected.status, "failed"); assert.equal(inspected.error?.code, "NATIVE_RESULT_INSPECTED"); assert.equal(inspected.native?.actualVersion, "1.0.0");
    const lease = f.locks.read(recipe.harnessId); lease.release(); assert.deepEqual(await readFile(f.config), before);
    assert.equal(JSON.parse(await readFile(join(f.packageRoot, "package.json"), "utf8")).version, "1.0.0", "inspection must not replay the failed installer");
  }
});
test("stale native observations are rejected before a management job is created", async t => {
  const f = await fixture(t);
  assert.throws(() => f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "stale", expectedNativeFingerprint: "0".repeat(64) }), error => error instanceof ManagementError && error.code === "NATIVE_INSTALLATION_CHANGED");
  assert.equal(f.manager.listJobs().length, 0);
});
test("a native npm package cannot overwrite an executable belonging to another installed program", async t => {
  const f = await fixture(t); await symlink(process.execPath, join(dirname(f.entry), "other-program")); f.setBins([recipe.binName, "other-program"]);
  const capability = f.manager.views([recipe.harnessId])[0]!.native!;
  const result = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "reject-other-bin", expectedNativeFingerprint: capability.fingerprint }).id);
  assert.equal(result.status, "failed"); assert.equal(result.error?.code, "NATIVE_DESTINATION_CONFLICT"); assert.equal(result.native?.dispatched, false);
  assert.equal(JSON.parse(await readFile(join(f.packageRoot, "package.json"), "utf8")).version, "1.0.0");
});
test("native npm prefix lookup retains the real user profile and version verification cannot write its configuration", async t => {
  const f = await fixture(t, false, undefined, true), before = await readFile(f.config);
  const plan = await f.native.describe(recipe, undefined, null, { stage: f.root, signal: new AbortController().signal, assertOwned() {}, log() {} });
  assert.equal(plan.entry, f.entry);
  const capability = f.manager.views([recipe.harnessId])[0]!.native!;
  const result = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "protected-version", expectedNativeFingerprint: capability.fingerprint }).id);
  assert.equal(result.status, process.platform === "darwin" ? "unknown" : "failed"); assert.deepEqual(await readFile(f.config), before);
  if (process.platform === "darwin") assert.equal(JSON.parse(await readFile(join(f.packageRoot, "package.json"), "utf8")).version, "2.0.0", "actual upgrade happened before the protected version check failed");
});
test("native uv plans keep the configured host tool and executable directories", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-uv-paths-")); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), uv = join(root, "uv"), toolRoot = join(root, "custom-tools"), binRoot = join(root, "custom-bin"); await mkdir(home);
  await writeFile(uv, "#!" + process.execPath + "\nif(process.env.HOME!==" + JSON.stringify(home) + ")throw Error('host profile changed');console.log(process.argv.includes('--bin')?process.env.UV_TOOL_BIN_DIR:process.env.UV_TOOL_DIR);\n", { mode: 0o700 });
  const native = new NativeManagement(null, uv, process.execPath, { home, values: { HOME: home, UV_TOOL_DIR: toolRoot, UV_TOOL_BIN_DIR: binRoot } });
  const python = { ...recipe, kind: "python" as const, packageName: "fixture-agent" };
  const plan = await native.describe(python, undefined, null, { stage: root, signal: new AbortController().signal, assertOwned() {}, log() {} });
  assert.equal(plan.prefix, toolRoot); assert.equal(plan.entry, join(binRoot, recipe.binName)); assert.equal(plan.channel, "uv");
});
test("legacy management v1 migration preserves job history and rolls back an invalid native table", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-migration-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = managementStorage(root, 1), id = "management-876453de-07ea-47b5-8e29-c0271c9faabb";
  const view = { id, harnessId: "fixture", controlId: "fixture-control", action: "install", status: "failed", phase: "failed", cancelRequested: false, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", resolvedVersion: null, installationId: null, error: { code: "OLD_FAILURE", message: "historical fixture" }, logCursor: 0 };
  storage.db.prepare("INSERT INTO management_jobs VALUES(?,?,?,?,?,?,?)").run(id, "fixture", "failed", "old-command", "f".repeat(64), 0, JSON.stringify(view));
  storage.db.exec("DROP TABLE management_native_plans; PRAGMA user_version=1"); storage.db.close();
  const migrated = managementStorage(root, 2);
  assert.equal(migrated.db.prepare("PRAGMA user_version").get()?.user_version, 6, "v3 only marks the job facts of ADR-043, and v4, v5 and v6 add the uninstall targets, install requests and installation upgrades of ADR-044; the rows stay as they were");
  assert.deepEqual(JSON.parse(String(migrated.db.prepare("SELECT view_json FROM management_jobs WHERE id=?").get(id)?.view_json)), view);
  migrated.db.exec("DROP TABLE management_native_plans; CREATE VIEW management_native_plans AS SELECT id FROM management_jobs; PRAGMA user_version=1"); migrated.db.close();
  assert.throws(() => managementStorage(root, 3));
  const inspect = new DatabaseSync(join(root, "management", "management.sqlite"));
  try { assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 1); assert.equal(inspect.prepare("SELECT count(*) AS count FROM management_jobs").get()?.count, 1); }
  finally { inspect.close(); }
});
test("formal authenticated HTTP owns native upgrades and their real SQLite/installation facts", async t => {
  let closeGateway: (() => Promise<void>) | undefined;
  const f = await fixture(t, false, async () => { await closeGateway?.(); }), manifest = join(f.root, "web-catalog.json");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [{ id: recipe.harnessId, name: "Native fixture", aliases: [], binaryNames: [recipe.binName], configHints: [], controls: [{ id: recipe.controlId, protocol: "acp-v1", executableNames: [recipe.binName], args: [], env: {}, package: null, distribution: null, requiredExecutables: [], source: { repository: "fixture", revision: "pinned", upstreamId: "fixture", url: "https://example.invalid/fixture" } }] }], overrides: { [recipe.controlId]: { executable: f.entry } } }));
  const gateway = await startWebServer({ root: join(f.root, "web-data"), configuration: await prepareConfiguration({ workspace: f.root, manifestPath: manifest, pathOnly: true }),
    application: (root, publish) => application(root, publish, { installations: "any", nativeEnvironment: f.environment, management: { native: f.native, recipes: [recipe], nativeLocks: f.locks }, workspaceLockRoot: join(f.root, "locks") }) });
  closeGateway = () => gateway.close();
  const url = new URL(gateway.url), origin = url.origin, response = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const auth: unknown = await response.json(); assert.ok(auth && typeof auth === "object" && "csrfToken" in auth);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!, headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": String(auth.csrfToken) };
  const state = await (await fetch(origin + "/api/v1/state", { headers })).json();
  const selected = state.harnesses.find((row: { id: string }) => row.id === recipe.harnessId); assert.ok(selected.management.native);
  const input = { harnessId: recipe.harnessId, action: "upgrade", commandId: "http-native-upgrade", expectedNativeFingerprint: selected.management.native.fingerprint };
  const accepted = await fetch(origin + "/api/v1/installation-jobs", { method: "POST", headers, body: JSON.stringify(input) }); assert.equal(accepted.status, 202, await accepted.clone().text());
  const receipt = await accepted.json(); let result;
  const until = Date.now() + 10000;
  for (;;) {
    result = await (await fetch(origin + "/api/v1/installation-jobs/" + receipt.id, { headers })).json();
    if (["completed", "failed", "unknown"].includes(result.status)) break;
    assert.ok(Date.now() < until, "native HTTP task did not settle");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(result.status, process.platform === "darwin" ? "completed" : "failed", JSON.stringify(result));
  if (process.platform === "darwin") { assert.equal(result.native.actualVersion, "2.0.0"); assert.equal(result.installationId, null); }
  assert.equal((await (await fetch(origin + "/api/v1/installation-jobs", { method: "POST", headers, body: JSON.stringify(input) })).json()).id, receipt.id);
});
const AGENT = "com.example.fixture-agent", HELPER = "com.example.fixture-helper";
const serviceRecipe: ManagementRecipe = { ...recipe, processNames: ["fixture-agent-daemon"], pluginDirectory: ".fixture/extensions",
  services: [{ label: AGENT, name: "Fixture Agent", restart: true, portFlag: "--port" }, { label: HELPER, name: "Fixture Helper", restart: false, restartCommand: "fixture-agent helper restart" }] };
function launchd(after: FakeLaunchd["after"], listening?: FakeLaunchd["listening"]): FakeLaunchd {
  return { kicked: [], after, ...(listening === undefined ? {} : { listening }), services: [
    { label: AGENT, pid: 41001, args: root => [process.execPath, join(root, "entry.mjs"), "serve", "--port", "18999"] },
    { label: HELPER, pid: 41002, args: root => [process.execPath, join(root, "entry.mjs"), "helper"] },
    { label: "com.example.unrelated", pid: 41003, args: () => ["/usr/bin/true"] }] };
}
function users(list: ReturnType<NativeProgramUsers["list"]>): NativeProgramUsers & { closed: number } {
  const port = { closed: 0, list: () => list, closeIdle: async () => { port.closed++; return list.filter(item => !item.busy).length; } };
  return port;
}
const logs = (f: Awaited<ReturnType<typeof fixture>>, id: string) => f.manager.logs(id, 0, 1000).map(entry => entry.text);
const version = async (f: Awaited<ReturnType<typeof fixture>>) => JSON.parse(await readFile(join(f.packageRoot, "package.json"), "utf8")).version;
const target = (label: string) => "gui/" + process.getuid!() + "/" + label;

test("G011-UP2 an upgrade restarts the agreed service right after verifying the new version, leaves the others running, and records each (ADR-043)", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  const daemon = launchd(() => ({ state: "running", pid: 42001, runs: 2 }), pid => pid === 42001 ? "p42001\nf3\nn127.0.0.1:18999\n" : ""), port = users([{ sessionId: "idle-conversation", busy: false }]);
  const f = await fixture(t, false, undefined, false, { recipe: serviceRecipe, launchd: daemon, users: port });
  for (const name of ["fixture-channel", ".fixture-install-backups"]) await mkdir(join(f.environment.home, ".fixture", "extensions", name), { recursive: true });
  await writeFile(join(f.environment.home, ".fixture", "extensions", "not-a-directory"), "");
  const check = await f.manager.maintenance(recipe.harnessId);
  assert.deepEqual(check.restart, [{ label: AGENT, name: "Fixture Agent", pid: 41001, command: "launchctl kickstart -k " + target(AGENT), portKnown: true }]);
  assert.deepEqual(check.resident, [{ label: HELPER, name: "Fixture Helper", pid: 41002, restartCommand: "fixture-agent helper restart" }]);
  assert.deepEqual(check.conversations, [{ sessionId: "idle-conversation", busy: false }]); assert.deepEqual(check.otherUsers, []); assert.equal(check.staleRecords, 0);
  assert.equal(check.rollback, "npm install --global fixture-agent@1.0.0"); assert.equal(check.currentVersion, "1.0.0");
  // Only plugin directories are listed: not hidden ones such as a product's own install backups, and never their contents.
  assert.deepEqual(check.plugins, ["fixture-channel"]);
  assert.deepEqual(daemon.kicked, [], "the check restarts nothing"); assert.equal(port.closed, 0, "the check closes nothing");
  const job = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "restart", expectedNativeFingerprint: check.fingerprint, restartServices: [AGENT] }).id);
  assert.equal(job.status, "completed", JSON.stringify(job)); assert.equal(await version(f), "2.0.0");
  assert.deepEqual(daemon.kicked, [target(AGENT)], "only the agreed service restarts, once");
  assert.deepEqual(job.native?.services, [{ label: AGENT, outcome: "restarted", pid: 42001, ready: true }]);
  assert.equal(job.native?.closedConversations, 1); assert.deepEqual(job.native?.restartServices, [AGENT]); assert.equal(job.native?.configurationChangedByService, undefined);
  const text = logs(f, job.id), verified = text.findIndex(line => line.startsWith("已核实本机程序为 2.0.0")), restart = text.indexOf("正在重启 " + AGENT + "：launchctl kickstart -k " + target(AGENT));
  assert.ok(verified >= 0 && restart > verified, "the restart follows the verified version: " + JSON.stringify(text));
  assert.ok(text.some(line => line.startsWith("这些程序不会被关闭") && line.includes(HELPER)), JSON.stringify(text));
  assert.ok(text.includes(AGENT + " 已重新运行（进程 42001），正在端口 18999 上监听。"), JSON.stringify(text));
  const reread = f.manager.readJob(job.id); assert.deepEqual(reread, job, "the v3 facts read back as written");
});

test("G011-UP3 an upgrade that would restart a service the user did not agree to stops before closing or changing anything", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  const daemon = launchd(() => assert.fail("nothing restarts")), port = users([{ sessionId: "idle-conversation", busy: false }]);
  const f = await fixture(t, false, undefined, false, { recipe: serviceRecipe, launchd: daemon, users: port }), capability = f.manager.views([recipe.harnessId])[0]!.native!;
  const job = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "no-consent", expectedNativeFingerprint: capability.fingerprint }).id);
  assert.equal(job.status, "failed"); assert.equal(job.error?.code, "SERVICE_CONSENT_REQUIRED"); assert.match(job.error!.message, new RegExp(AGENT.replaceAll(".", "\\.")));
  assert.equal(job.native?.dispatched, false); assert.equal(job.native?.closedConversations, undefined); assert.equal(port.closed, 0); assert.deepEqual(daemon.kicked, []);
  assert.equal(await version(f), "1.0.0");
});

test("G011-UP4 a conversation in a Turn or another live HarnessHub process blocks an upgrade, and records left by ended ones are cleared and said", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  const busy = users([{ sessionId: "replying", busy: true }, { sessionId: "idle", busy: false }]);
  const blocked = await fixture(t, false, undefined, false, { users: busy }), capability = blocked.manager.views([recipe.harnessId])[0]!.native!;
  const refused = await settled(blocked.manager, blocked.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "busy", expectedNativeFingerprint: capability.fingerprint }).id);
  assert.equal(refused.status, "failed"); assert.equal(refused.error?.code, "HARNESS_BUSY"); assert.match(refused.error!.message, /1 个 HarnessHub 对话正在使用/u);
  assert.equal(busy.closed, 0, "an idle conversation is not closed for an upgrade that cannot run"); assert.equal(await version(blocked), "1.0.0");
  // A record whose writer ended (an exited process's id) is left over: the maintenance lock clears it and the log says so.
  const f = await fixture(t), directory = join(f.root, "locks", recipe.harnessId); f.locks.read(recipe.harnessId).release();
  const child = spawn(process.execPath, ["-e", ""]); await new Promise(resolve => child.once("exit", resolve));
  const marker = join(directory, "reader-" + randomUUID() + ".json"); await writeFile(marker, JSON.stringify({ harness: recipe.harnessId, pid: child.pid, token: randomUUID() }), { mode: 0o600 });
  assert.deepEqual(await f.locks.users(recipe.harnessId), { live: [], stale: 1 });
  // Another HarnessHub process's live lease holds the program: the upgrade waits for it and changes nothing.
  const other = new NativeInstallationLocks(join(f.root, "locks")).read(recipe.harnessId);
  const held = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "held", expectedNativeFingerprint: f.manager.views([recipe.harnessId])[0]!.native!.fingerprint }).id);
  assert.equal(held.status, "failed"); assert.equal(held.error?.code, "HARNESS_BUSY"); assert.equal(held.native?.dispatched, false); assert.equal(await version(f), "1.0.0");
  other.release();
  const job = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "cleared", expectedNativeFingerprint: f.manager.views([recipe.harnessId])[0]!.native!.fingerprint }).id);
  assert.equal(job.status, "completed", JSON.stringify(job)); assert.equal(job.native?.clearedRecords, 1);
  assert.ok(logs(f, job.id).includes("清除了一条旧的使用记录：写入它的 HarnessHub 进程 " + child.pid + " 已不再使用这个程序。"));
  await assert.rejects(readFile(marker), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("G011-UP5 a service that does not run again fails the upgrade with the installed version recorded, and nothing is rolled back or retried", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  const daemon = launchd(() => ({ state: "not running", pid: null, runs: 2 }));
  const f = await fixture(t, false, undefined, false, { recipe: serviceRecipe, launchd: daemon }), check = await f.manager.maintenance(recipe.harnessId);
  const job = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "down", expectedNativeFingerprint: check.fingerprint, restartServices: [AGENT] }).id);
  assert.equal(job.status, "failed"); assert.equal(job.error?.code, "SERVICE_NOT_RECOVERED");
  assert.equal(job.native?.dispatched, true); assert.equal(job.native?.actualVersion, "2.0.0"); assert.equal(job.native?.configurationPreserved, true);
  assert.deepEqual(job.native?.services, [{ label: AGENT, outcome: "not_recovered", pid: null, ready: null }]);
  assert.match(job.error!.message, /新版本 2\.0\.0 已安装/u); assert.ok(job.error!.message.includes("npm install --global fixture-agent@1.0.0"), job.error!.message);
  assert.deepEqual(daemon.kicked, [target(AGENT)]); assert.equal(await version(f), "2.0.0");
  // The installation is known, so the maintenance lock is released and the program can be used.
  f.locks.read(recipe.harnessId).release();
});

test("G011-UP6 the isolated sandbox of a read-only query (Homebrew's local records) writes only its stage and reaches no network, even a gateway listening on this computer", { skip: process.platform !== "darwin" && "the isolation uses the macOS sandbox" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-isolation-"))), stage = join(root, "stage"), config = join(root, "home", "openclaw.json");
  await mkdir(stage); await mkdir(dirname(config)); await writeFile(config, "{\"keep\":true}");
  let connections = 0; const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  const probe = "const fs=require('node:fs'),net=require('node:net');const r={};" +
    "try{fs.writeFileSync(process.argv[1]+'/ok','x');r.stage='written'}catch(e){r.stage=e.code}" +
    "try{fs.writeFileSync(process.argv[2],'migrated');r.config='written'}catch(e){r.config=e.code}" +
    "const s=net.connect(Number(process.argv[3]),'127.0.0.1');s.on('connect',()=>{r.net='connected';done()});s.on('error',e=>{r.net=e.code;done()});" +
    "function done(){process.stdout.write(JSON.stringify(r));process.exit(0)}";
  const child = spawn("/usr/bin/sandbox-exec", ["-p", isolatedSandboxProfile([stage]), process.execPath, "-e", probe, stage, config, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); await new Promise(resolve => child.once("exit", resolve));
  const result = JSON.parse(output) as Record<string, string>;
  assert.equal(result.stage, "written"); assert.equal(result.config, "EPERM"); assert.notEqual(result.net, "connected");
  assert.equal(connections, 0, "the listening service saw no connection"); assert.equal(await readFile(config, "utf8"), "{\"keep\":true}");
});

test("G011-UP7 the documented v3 to v2 downgrade keeps every job and leaves only the facts a v2 reader accepts", async t => {
  const root = await mkdtemp(join(tmpdir(), "native-downgrade-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = managementStorage(root, 1);
  // A v6 database goes back to v5, v4 and then v3 first (ADR-044); this test starts from there.
  storage.db.exec(await readFile(new URL("../../../tools/management-v6-to-v5.sql", import.meta.url), "utf8"));
  storage.db.exec(await readFile(new URL("../../../tools/management-v5-to-v4.sql", import.meta.url), "utf8"));
  storage.db.exec(await readFile(new URL("../../../tools/management-v4-to-v3.sql", import.meta.url), "utf8"));
  assert.equal(storage.db.prepare("PRAGMA user_version").get()?.user_version, 3);
  const native = { channel: "npm", location: "/opt/homebrew/bin/fixture-agent", beforeVersion: "1.0.0", actualVersion: "2.0.0", dispatched: true, configurationPreserved: true };
  const v3 = { id: "management-33333333-3333-4333-8333-333333333333", harnessId: "fixture", controlId: "fixture-control", action: "upgrade", status: "failed", phase: "failed", cancelRequested: false,
    createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:01:00.000Z", resolvedVersion: "2.0.0", installationId: null, error: { code: "SERVICE_NOT_RECOVERED", message: "重启后 60 秒内没有重新运行。" }, logCursor: 4,
    native: { ...native, restartServices: [AGENT], closedConversations: 1, clearedRecords: 2, services: [{ label: AGENT, outcome: "not_recovered", pid: null, ready: null }], configurationChangedByService: true } };
  const v2 = { ...v3, id: "management-44444444-4444-4444-8444-444444444444", status: "completed", phase: "completed", error: null, native };
  assert.deepEqual(parseManagementJob(v3), v3, "the v3 reader takes the new facts");
  for (const [view, command] of [[v3, "c3"], [v2, "c2"]] as const) storage.db.prepare("INSERT INTO management_jobs VALUES(?,?,?,?,?,?,?)").run(view.id, "fixture", view.status, command, "f".repeat(64), 0, JSON.stringify(view));
  storage.db.close();
  const db = new DatabaseSync(join(root, "management", "management.sqlite"));
  try {
    db.exec(await readFile(new URL("../../../tools/management-v3-to-v2.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    const rows = db.prepare("SELECT id,view_json FROM management_jobs ORDER BY id").all().map(row => JSON.parse(String(row.view_json)));
    // Every row is kept; each one's facts are exactly a v2 job's, so the v2 reader (whose field list this is) accepts it.
    assert.deepEqual(rows, [{ ...v3, native }, v2]);
    for (const row of rows) assert.deepEqual(Object.keys(row.native).sort(), ["actualVersion", "beforeVersion", "channel", "configurationPreserved", "dispatched", "location"]);
  } finally { db.close(); }
  // And this build opens it again (as v6), with nothing lost that the downgrade kept.
  const reopened = managementStorage(root, 2);
  try { assert.equal(reopened.db.prepare("PRAGMA user_version").get()?.user_version, 6); assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n, 2); } finally { reopened.db.close(); }
});

test("G011-UP8 a release whose Node.js range excludes the one that runs the program, or the one a restarted service starts, is said before confirming and refused before anything changes", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  // The agent's job starts a Homebrew-style Node.js of its own (a keg linked under opt/, as Homebrew lays it out) that reports 1.0.0;
  // the helper's job uses it too but is not restarted. The program itself runs with this test's Node.js (its #! line).
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-runtime-test-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const keg = join(root, "homebrew", "Cellar", "node", "1.0.0_1", "bin"), linked = join(root, "homebrew", "opt", "node", "bin", "node");
  await mkdir(keg, { recursive: true }); await writeFile(join(keg, "node"), "#!/bin/sh\necho v1.0.0\n", { mode: 0o755 });
  await mkdir(join(root, "homebrew", "opt"), { recursive: true }); await symlink(join(root, "homebrew", "Cellar", "node", "1.0.0_1"), join(root, "homebrew", "opt", "node"));
  const daemon: FakeLaunchd = { kicked: [], after: () => assert.fail("nothing restarts"), services: [
    { label: AGENT, pid: 41001, args: packageRoot => [linked, join(packageRoot, "entry.mjs"), "serve", "--port", "18999"] },
    { label: HELPER, pid: 41002, args: packageRoot => [linked, join(packageRoot, "entry.mjs"), "helper"] }] };
  const port = users([{ sessionId: "idle", busy: false }]);
  const f = await fixture(t, false, undefined, false, { recipe: serviceRecipe, launchd: daemon, users: port });
  await f.manager.checkUpdates([recipe.harnessId]).catch(() => {});
  // A range that excludes the program's own Node.js: said, and refused before anything changes.
  f.setEngines({ node: ">=99" });
  let check = await f.manager.maintenance(recipe.harnessId);
  assert.deepEqual(check.runtimes.map(runtime => [runtime.service, runtime.path, runtime.found, runtime.satisfied, runtime.restarted]), [
    [null, process.execPath, process.versions.node, false, true], [AGENT, linked, "1.0.0", false, true], [HELPER, linked, "1.0.0", false, false]]);
  assert.deepEqual(check.runtimes.slice(1).map(runtime => runtime.upgradeCommand), ["brew upgrade node", "brew upgrade node"]);
  let job = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "runtime", expectedNativeFingerprint: check.fingerprint, restartServices: [AGENT] }).id);
  assert.equal(job.status, "failed"); assert.equal(job.error?.code, "RUNTIME_INCOMPATIBLE"); assert.equal(job.native?.dispatched, false);
  assert.match(job.error!.message, new RegExp("^新版本 2\\.0\\.0 要求 Node\\.js >=99，运行它的 Node\\.js 是 " + process.versions.node.replaceAll(".", "\\.") + "（"));
  // The program's own Node.js meets the range, but the service it restarts would start the new version on one that does not.
  f.setEngines({ node: ">=2" });
  check = await f.manager.maintenance(recipe.harnessId);
  assert.deepEqual(check.runtimes.map(runtime => [runtime.service, runtime.satisfied]), [[null, true], [AGENT, false], [HELPER, false]]);
  job = await settled(f.manager, f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "service-runtime", expectedNativeFingerprint: check.fingerprint, restartServices: [AGENT] }).id);
  assert.equal(job.status, "failed"); assert.equal(job.error?.code, "RUNTIME_INCOMPATIBLE"); assert.equal(job.native?.dispatched, false);
  assert.equal(job.error?.message, "新版本 2.0.0 要求 Node.js >=2，" + AGENT + " 启动用的 Node.js 是 1.0.0（" + linked + "）。先升级 Node.js 再升级（可以运行 brew upgrade node）；HarnessHub 不替你升级 Node.js。没有升级。");
  assert.equal(port.closed, 0, "nothing is closed for an upgrade that cannot run"); assert.deepEqual(daemon.kicked, []); assert.equal(await version(f), "1.0.0");
});

test("G011-UP9 a protected configuration another program writes while an upgrade installs is noted in its log, not a failure: the installer could not write it", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  const marks = await realpath(await mkdtemp(join(tmpdir(), "native-drift-"))); t.after(() => rm(marks, { recursive: true, force: true }));
  const started = join(marks, "started"), go = join(marks, "go");
  const f = await fixture(t, false, undefined, false, { pause: { started, go } });
  const capability = f.manager.views([recipe.harnessId])[0]!.native!;
  const job = f.manager.submit({ harnessId: recipe.harnessId, action: "upgrade", commandId: "drift", expectedNativeFingerprint: capability.fingerprint });
  // While npm installs, a running program (a Claude Code session, say) rewrites ~/.claude.json; then npm finishes.
  for (const end = Date.now() + 10000; !existsSync(started); ) { assert.ok(Date.now() < end, "the installer did not start"); await new Promise(resolve => setTimeout(resolve, 20)); }
  await writeFile(f.config, '{"model":"keep-model","login":"synthetic-login","numStartups":2}'); await writeFile(go, "1");
  const result = await settled(f.manager, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result.error)); assert.equal(result.native?.configurationPreserved, true);
  assert.ok(f.manager.logs(job.id, 0).some(entry => entry.text.startsWith("升级期间这些受保护的配置文件有了变化：~/.claude.json")));
});

/**
 * Homebrew as native maintenance meets it: the Library files its sandbox check reads, and a brew that logs every command
 * (a protected run's arguments are the ones its runner was given) into its temporary directory and answers for the name it
 * is given. Its own opencode is OpenCode 2 (2.1.2), anomalyco/tap's is OpenCode 1 (1.19.3); an upgrade installs the one named.
 */
async function tappedHomebrew(root: string): Promise<string> {
  const brew = join(root, "homebrew"), library = join(brew, "Library", "Homebrew");
  await mkdir(join(library, "extend", "os", "mac"), { recursive: true }); await mkdir(join(brew, "bin"), { recursive: true });
  await writeFile(join(library, "sandbox.rb"), "class Sandbox\n  def self.inherited_sandbox?\n  end\n  def run\n    command.sandbox_inheritance = inheritance\n  end\nend\n");
  await writeFile(join(library, "system_command.rb"), "Sandbox::INHERITANCE_FD\n"); await writeFile(join(library, "extend", "os", "mac", "sandbox.rb"), "# macOS\n");
  await writeFile(join(brew, "bin", "brew"), "#!" + process.execPath + "\nconst fs=require('node:fs'),path=require('node:path');const prefix=path.dirname(path.dirname(fs.realpathSync(process.argv[1])));"
    + "let a=process.argv.slice(2);if(a[0]==='ruby')a=JSON.parse(fs.readFileSync(path.join(path.dirname(a[1]),'homebrew-command.json'),'utf8')).args;"
    + "fs.appendFileSync(path.join(process.env.TMPDIR,'brew-calls.log'),a.join(' ')+'\\n');const target=n=>n==='anomalyco/tap/opencode'?'1.19.3':'2.1.2';"
    + "if(a[0]==='info'){process.stdout.write(JSON.stringify({formulae:[{name:'opencode',full_name:a[3],versions:{stable:target(a[3])},revision:0}],casks:[]}));}"
    + "else if(a[0]==='upgrade'){const v=target(a[2]),bin=path.join(prefix,'Cellar','opencode',v,'bin');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'opencode'),'#!/bin/sh\\necho '+v+'\\n',{mode:0o755});"
    + "fs.rmSync(path.join(prefix,'bin','opencode'));fs.symlinkSync(path.join(bin,'opencode'),path.join(prefix,'bin','opencode'));}else process.exit(2);\n", { mode: 0o755 });
  const keg = join(brew, "Cellar", "opencode", "1.18.35");
  await mkdir(join(keg, "bin"), { recursive: true }); await writeFile(join(keg, "bin", "opencode"), "#!/bin/sh\necho 1.18.35\n", { mode: 0o755 });
  await symlink(join(keg, "bin", "opencode"), join(brew, "bin", "opencode"));
  return brew;
}
test("G011-UG9 native maintenance reads and upgrades a formula from another tap by its full name, and the tap its receipt names is part of the plan's identity", { skip: process.platform !== "darwin" && "Homebrew maintenance is macOS only (ADR-044)" }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-homebrew-tap-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"); await mkdir(home);
  const brew = await tappedHomebrew(root), keg = join(brew, "Cellar", "opencode", "1.18.35");
  const receipt = (tap: string) => writeFile(join(keg, "INSTALL_RECEIPT.json"), JSON.stringify({ homebrew_version: "5.1.0", source: { tap, spec: "stable", versions: { stable: "1.18.35" } } }));
  const environment = { home, values: { HOME: home, PATH: join(brew, "bin") + ":/usr/bin:/bin" } };
  const metadata: ManagementMetadataPort = { resolve: async () => assert.fail("Homebrew's own records are read, never a package registry") };
  const native = new NativeManagement(null, null, process.execPath, environment, metadata);
  const opencode: ManagementRecipe = { harnessId: "opencode", controlId: "opencode", kind: "npm", packageName: "opencode-ai", referenceVersion: "latest", binName: "opencode", args: [], archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] };
  const observation = { harnessId: "opencode", controlId: "opencode", command: { executable: join(brew, "bin", "opencode"), args: [], env: {} } };
  let stages = 0;
  /** A fresh stage per step, as management gives each one; `calls` reads what brew logged in it. */
  const step = async () => { const stage = join(root, "stage-" + stages++); await mkdir(stage); return { stage, signal: new AbortController().signal, assertOwned() {}, log() {}, beginMutation() {} }; };
  const calls = async (context: { stage: string }) => (await readFile(join(context.stage, "brew-calls.log"), "utf8")).trim().split("\n");
  // Installed from Homebrew's own tap: the bare name, as before.
  await receipt("homebrew/core");
  const core = await native.describe(opencode, observation, "1.18.35", await step());
  assert.deepEqual([core.channel, core.reference, core.reason, core.actualEntry], ["brew-formula", "opencode", null, join(keg, "bin", "opencode")]);
  let context = await step();
  assert.equal(await native.latest(core, opencode, context), "2.1.2"); assert.deepEqual(await calls(context), ["info --json=v2 --formula opencode"]);
  // Installed from anomalyco/tap: another plan, and every Homebrew command names the tap's formula.
  await receipt("anomalyco/tap");
  const tapped = await native.describe(opencode, observation, "1.18.35", await step());
  assert.notEqual(tapped.fingerprint, core.fingerprint, "a receipt naming another tap changes what was confirmed");
  assert.equal(tapped.reference, "opencode", "the keg's own name stays the plan's reference");
  context = await step();
  assert.equal(await native.latest(tapped, opencode, context), "1.19.3"); assert.deepEqual(await calls(context), ["info --json=v2 --formula anomalyco/tap/opencode"]);
  await native.prepare(tapped, opencode, "1.19.3", await step());
  context = await step();
  assert.deepEqual(await native.execute(tapped, opencode, "1.19.3", context), { version: "1.19.3", configurationPreserved: true });
  assert.deepEqual(await calls(context), ["upgrade --formula anomalyco/tap/opencode"]);
  assert.equal(await realpath(join(brew, "bin", "opencode")), join(brew, "Cellar", "opencode", "1.19.3", "bin", "opencode"));
  assert.equal(existsSync(join(brew, "Cellar", "opencode", "2.1.2")), false, "Homebrew's own OpenCode 2 was never installed in its place");
});

test("G011-UP1 releases are ordered by semver, with a calendar version's -N as a later revision of its base release, never a prerelease", () => {
  // OpenClaw numbers a rebuilt release 2026.3.23-2: it is newer than 2026.3.23 and older than the next release.
  for (const [older, newer] of [["2026.3.23", "2026.3.23-2"], ["2026.3.23-2", "2026.3.23-10"], ["2026.3.23-2", "2026.9.5"], ["2026.3.23-2", "2026.10.5"], ["2026.10.10-beta.3", "2026.10.10"],
    ["2026.3.23-beta.1", "2026.3.23-2"], ["0.2.0-rc.2", "0.2.1-rc.2"], ["0.2.1-alpha.5", "0.2.1-rc.2"], ["1.18.35", "1.19.3"], ["2.1.306", "2.1.307"]] as const) {
    assert.ok(compareReleases(older, newer)! < 0, older + " < " + newer); assert.ok(compareReleases(newer, older)! > 0, newer + " > " + older);
  }
  for (const version of ["2026.3.23-2", "2026.3.23", "0.2.1-rc.2"]) assert.equal(compareReleases(version, version), 0, version);
  // Only a calendar version's numeric suffix is a revision; anything that is no version compares to nothing.
  assert.ok(compareReleases("1.0.0", "1.0.0-1")! > 0, "a semver prerelease stays one");
  for (const [a, b] of [["latest", "2026.3.23"], ["2026.03.23-2", "2026.3.23"], ["1.18.35_1", "1.18.35"], ["", "1.0.0"]] as const) assert.equal(compareReleases(a, b), null, a + " vs " + b);
  // The same reading says which target is a prerelease: a calendar revision is a release.
  for (const version of ["2026.3.23-2", "2026.10.5", "1.19.3", "latest"]) assert.equal(isPrerelease(version), false, version);
  for (const version of ["0.2.1-rc.2", "0.2.1-alpha.5", "2026.10.10-beta.3", "1.0.0-1"]) assert.equal(isPrerelease(version), true, version);
});

test("G011-UP1 an upgrade is refused as no update only when the channel's version is not newer by that order, and OpenClaw's npm upgrade is refused for its own updater before anything is resolved", async t => {
  const f = await fixture(t), context = { stage: f.root, signal: new AbortController().signal, assertOwned() {}, log() {} };
  const plan = await f.native.describe(recipe, { harnessId: recipe.harnessId, controlId: recipe.controlId, command: { executable: f.entry, args: [], env: {} } }, "1.0.0", context);
  // A calendar revision of the installed release is newer; the base release under its revision is not.
  await f.native.prepare({ ...plan, beforeVersion: "2026.3.23" }, recipe, "2026.3.23-2", context);
  for (const [before, target] of [["2026.3.23-2", "2026.3.23"], ["2026.3.23-2", "2026.3.23-2"], ["2026.9.5", "2026.3.23-2"]] as const)
    await assert.rejects(f.native.prepare({ ...plan, beforeVersion: before }, recipe, target, context), (error: unknown) => error instanceof ManagementError && error.code === "NO_UPDATE", before + " -> " + target);
  // OpenClaw: its npm upgrade waits for `openclaw update` (ADR-052); refused before its release is looked up, nothing installed.
  const unresolved = new NativeManagement(null, null, process.execPath, f.environment, { resolve: async () => assert.fail("OpenClaw's release is never looked up") });
  const openclaw = { ...plan, harnessId: "openclaw", controlId: "openclaw-native", beforeVersion: "2026.3.23" }, openclawRecipe = { ...recipe, harnessId: "openclaw", controlId: "openclaw-native" };
  await assert.rejects(unresolved.prepare(openclaw, openclawRecipe, "2026.3.23-2", context), (error: unknown) =>
    error instanceof ManagementError && error.code === "UNSUPPORTED_UPGRADE" && error.message === "OpenClaw 的升级由它自己的 openclaw update 完成（会运行 Doctor 迁移配置并重启 Gateway），HarnessHub 的 npm 直装路径不再用于 OpenClaw；路线见 ADR-052。");
  await assert.rejects(unresolved.prepare({ ...openclaw, beforeVersion: "2026.3.23-2" }, openclawRecipe, "2026.3.23", context), (error: unknown) => error instanceof ManagementError && error.code === "NO_UPDATE", "already newer is said first");
  assert.equal(await version(f), "1.0.0");
});

test("G011-UP1 through native maintenance, OpenClaw's npm upgrade fails with the reason before npm runs, instead of a configuration check of the target", { skip: process.platform !== "darwin" && "native upgrades need the macOS sandbox" }, async t => {
  // This management service closes before the fixture's directory is removed.
  let manager: LocalHarnessManagement | undefined;
  const f = await fixture(t, false, async () => { await manager?.shutdown(); }), openclaw: ManagementRecipe = { ...recipe, harnessId: "openclaw", controlId: "openclaw-native" };
  await mkdir(join(f.root, "data-openclaw"));
  manager = new LocalHarnessManagement(join(f.root, "data-openclaw"), { installationMode: "native", native: f.native, assertOwner: () => {}, ownerGeneration: 1, recipes: [openclaw],
    nativeEnvironment: f.environment, nativeLocks: new NativeInstallationLocks(join(f.root, "locks-openclaw")) });
  manager.setSystemObservations([{ harnessId: "openclaw", controlId: "openclaw-native", command: { executable: f.entry, args: [], env: {} }, packageVersion: "1.0.0" }]);
  await manager.refreshNativeCapabilities();
  const capability = manager.views(["openclaw"])[0]!.native!;
  assert.equal(capability.channel, "npm");
  const job = await settled(manager, manager.submit({ harnessId: "openclaw", action: "upgrade", commandId: "openclaw-npm", expectedNativeFingerprint: capability.fingerprint }).id);
  assert.equal(job.status, "failed"); assert.equal(job.error?.code, "UNSUPPORTED_UPGRADE"); assert.equal(job.native?.dispatched, false);
  assert.match(job.error!.message, /openclaw update/u); assert.match(job.error!.message, /ADR-052/u);
  assert.ok(!logs({ ...f, manager }, job.id).some(line => line.includes("校验")), "no configuration check of the target runs");
  assert.equal(await version(f), "1.0.0", "npm never ran");
});
