import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { NativeManagement } from "../../src/infrastructure/management/native.js";
import { NativeInstallationLocks } from "../../src/infrastructure/management/native-lock.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { ManagementError, type ManagementMetadataPort, type ManagementRecipe } from "../../src/contracts/management.js";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { managementStorage } from "../../src/infrastructure/management/storage.js";
import { DatabaseSync } from "node:sqlite";

const recipe: ManagementRecipe = { harnessId: "native-fixture", controlId: "native-fixture-npm", kind: "npm", packageName: "fixture-agent", referenceVersion: "1.0.0", binName: "fixture-agent", args: [], archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] };
async function fixture(t: test.TestContext, attack = false, beforeCleanup?: () => Promise<void>, verificationAttack = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-install-test-"))), home = join(root, "user-home"), prefix = join(root, "global"), data = join(root, "data"), packageRoot = join(prefix, "lib", "node_modules", "fixture-agent"), entry = join(prefix, "bin", "fixture-agent"), npm = join(root, "npm");
  await mkdir(home); await mkdir(packageRoot, { recursive: true }); await mkdir(dirname(entry), { recursive: true });
  const config = join(home, ".claude.json"); await writeFile(config, '{"model":"keep-model","login":"synthetic-login"}');
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-agent", version: "1.0.0", bin: { "fixture-agent": "entry.mjs" } }));
  await writeFile(join(packageRoot, "entry.mjs"), "#!" + process.execPath + "\nimport{readFileSync,writeFileSync}from'node:fs';import{dirname,join}from'node:path';" + (verificationAttack ? "writeFileSync(" + JSON.stringify(config) + ",'changed during version check');" : "") + "console.log(JSON.parse(readFileSync(join(dirname(process.argv[1]),'package.json'))).version);\n", { mode: 0o700 });
  await symlink(join(packageRoot, "entry.mjs"), entry);
  const code = "#!" + process.execPath + "\nimport{writeFile}from'node:fs/promises';const a=process.argv.slice(2);if(a[0]==='prefix'){if(process.env.HOME!==" + JSON.stringify(home) + ")throw Error('prefix query lost native HOME');console.log(" + JSON.stringify(prefix) + ");process.exit(0);}if(a[0]!=='install')throw Error('unexpected command');" + (attack ? "await writeFile(" + JSON.stringify(config) + ",'changed');" : "") + "const version=a.at(-1).split('@').at(-1);await writeFile(" + JSON.stringify(join(packageRoot, "package.json")) + ",JSON.stringify({name:'fixture-agent',version,bin:{'fixture-agent':'entry.mjs'}}));console.log('native package updated');\n";
  await writeFile(npm, code, { mode: 0o700 });
  let version = "2.0.0", binNames = [recipe.binName];
  const metadata: ManagementMetadataPort = { resolve: async original => ({ recipe: original, version: original.referenceVersion === "latest" ? version : original.referenceVersion, artifactUrl: null, integrity: null, engines: {}, binNames, dependencies: [] }) };
  const environment = { home, values: { HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } };
  const native = new NativeManagement(npm, null, process.execPath, environment, metadata), store = new SqliteSessionStore(data), locks = new NativeInstallationLocks(join(root, "locks"));
  const manager = new LocalHarnessManagement(data, { assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, recipes: [recipe], native, nativeLocks: locks });
  manager.setSystemObservations([{ harnessId: recipe.harnessId, controlId: recipe.controlId, command: { executable: entry, args: [], env: {} }, packageVersion: "1.0.0" }]);
  await manager.refreshNativeCapabilities();
  t.after(async () => { await beforeCleanup?.(); await manager.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, manager, locks, config, packageRoot, native, environment, entry, setVersion: (value: string) => { version = value; }, setBins: (value: string[]) => { binNames = value; } };
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
  assert.throws(() => a.write("fixture", "job"), /active|unresolved/); first.release(); second.release();
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
  assert.equal(migrated.db.prepare("PRAGMA user_version").get()?.user_version, 2);
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
    application: (root, publish) => application(root, publish, { nativeEnvironment: f.environment, management: { native: f.native, recipes: [recipe], nativeLocks: f.locks } }) });
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
