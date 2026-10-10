import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ManagementError, type InstallationJobView, type ManagementInstallContext, type ManagementInstallerPort, type ManagementMetadataPort, type ManagementRecipe } from "../../src/contracts/management.js";
import { LocalHarnessManagement, type ManagementOptions } from "../../src/infrastructure/management/service.js";
import { runManagementProcess } from "../../src/infrastructure/management/process.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/management-installer.mjs", import.meta.url));
const recipe = (id = "fixture-a"): ManagementRecipe => ({ harnessId: id, controlId: id + "-npm", kind: "npm", packageName: "fixture-" + id,
  referenceVersion: "1.0.0", binName: "fixture-bin", args: ["--acp"], archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] });
const code = (expected: string) => (error: unknown): boolean => error instanceof ManagementError && error.code === expected;
async function settled(manager: LocalHarnessManagement, id: string): Promise<InstallationJobView> {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const job = manager.readJob(id); if (["completed", "cancelled", "failed", "unknown"].includes(job.status)) return job; await new Promise<void>(done => setTimeout(done, 10)); }
  throw new Error("management fixture did not settle in its test budget");
}
function dependencies(configuration: { version?: () => string; mode?: () => string; ready?: (pid: number) => void; log?: string } = {}): { metadata: ManagementMetadataPort; installer: ManagementInstallerPort } {
  return {
    metadata: { resolve: async recipe => ({ recipe, version: configuration.version?.() ?? "1.0.0", artifactUrl: null, integrity: null, engines: {}, dependencies: [] }) },
    installer: { install: async (spec, context) => {
      const log = context.log;
      const local: ManagementInstallContext = { ...context, log: (stream, text) => {
        const match = text.match(/^WAIT_READY:([0-9]+)/u); if (match?.[1]) configuration.ready?.(Number(match[1])); log(stream, text);
      } };
      if (configuration.log) context.log("system", configuration.log);
      await runManagementProcess(process.execPath, [peer, context.stage, spec.recipe.packageName!, spec.version, spec.recipe.binName, configuration.mode?.() ?? "healthy"], context.stage,
        { PATH: "/usr/bin:/bin", HOME: context.stage, LANG: "C.UTF-8" }, local);
      context.assertOwned(); return { observedVersion: spec.version, artifactSha256: null,
        command: { executable: await realpath(process.execPath), args: [join(context.stage, "node_modules", spec.recipe.packageName!, "entry.mjs"), ...spec.recipe.args], env: {} } };
    } },
  };
}
async function fixture(fn: (root: string, manager: LocalHarnessManagement) => Promise<void>, options: Partial<ManagementOptions> = {}): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-management-test-")));
  const manager = new LocalHarnessManagement(root, { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [recipe(), recipe("fixture-b")], ...dependencies(), ...options });
  try { await fn(root, manager); } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
}
test("real management Job verifies external process package and publishes one immutable default", async () => fixture(async (_root, manager) => {
  const job = manager.submit({ harnessId: "fixture-a", action: "install", commandId: "install-1" }); assert.equal(job.status, "queued");
  assert.equal(manager.submit({ harnessId: "fixture-a", controlId: "fixture-a-npm", action: "install", commandId: "install-1" }).id, job.id);
  assert.throws(() => manager.submit({ harnessId: "fixture-b", action: "install", commandId: "install-1" }), code("COMMAND_CONFLICT"));
  const result = await settled(manager, job.id); assert.equal(result.status, "completed"); assert.equal(result.resolvedVersion, "1.0.0");
  const command = manager.resolveControl("fixture-a", "fixture-a-npm"); assert.ok(command); assert.equal(command.revision, 1); assert.equal(command.version, "1.0.0");
  assert.ok(command.command.args[0]?.includes(result.installationId!)); assert.equal(manager.views(["fixture-a"])[0]?.source, "managed");
  assert.ok(manager.logs(job.id, 0).some(log => log.text.includes("INSTALL_DONE")));
}));
test("management upgrade preserves old slot and switches default only after verified activation", async () => {
  let version = "1.0.0", metadataCalls = 0;
  const external = dependencies({ version: () => { metadataCalls++; return version; } });
  await fixture(async (root, manager) => {
    const first = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "install", commandId: "first" }).id); assert.equal(first.status, "completed");
    const old = manager.resolveControl("fixture-a", "fixture-a-npm")!; version = "2.0.0";
    const checked = (await manager.checkUpdates(["fixture-a"]))[0]!; assert.equal(checked.updateStatus, "available"); assert.equal(checked.latestVersion, "2.0.0");
    assert.throws(() => manager.submit({ harnessId: "fixture-a", action: "upgrade", commandId: "stale", expectedDefaultRevision: 0 }), code("DEFAULT_CONFLICT"));
    const second = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "upgrade", commandId: "upgrade", expectedDefaultRevision: 1 }).id);
    assert.equal(second.status, "completed"); const current = manager.resolveControl("fixture-a", "fixture-a-npm")!;
    assert.equal(current.version, "2.0.0"); assert.equal(current.revision, 2); assert.notEqual(current.installationId, old.installationId);
    assert.ok(await realpath(old.command.args[0]!));
    assert.equal(manager.views(["fixture-a"])[0]?.updateStatus, "current"); assert.equal(metadataCalls, 3);
    assert.equal((await manager.checkUpdates(["fixture-b"]))[0]?.updateStatus, "unchecked");
    assert.equal((await settled(manager, manager.submit({ harnessId: "fixture-b", action: "install", commandId: "first-after-check" }).id)).status, "completed");
    assert.equal(manager.views(["fixture-b"])[0]?.updateStatus, "current"); assert.equal(metadataCalls, 5);
    const db = new DatabaseSync(join(root, "management", "management.sqlite"));
    try {
      const original = db.prepare("SELECT view_json FROM management_updates WHERE harness_id='fixture-a'").get()?.view_json;
      assert.equal(typeof original, "string");
      for (const status of ["checking", "failed", "unsupported"]) {
        db.prepare("UPDATE management_updates SET view_json=? WHERE harness_id='fixture-a'").run(JSON.stringify({ latestVersion: "2.0.0", updateStatus: status, checkedAt: new Date().toISOString(), error: null }));
        assert.equal(manager.views(["fixture-a"])[0]?.updateStatus, status);
      }
      db.prepare("UPDATE management_updates SET view_json=? WHERE harness_id='fixture-a'").run(String(original));
    } finally { db.close(); }
    await manager.shutdown();
    const reopened = new LocalHarnessManagement(root, { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 2, recipes: [recipe(), recipe("fixture-b")], ...external });
    try { assert.equal(reopened.views(["fixture-a"])[0]?.updateStatus, "current"); assert.equal(reopened.views(["fixture-b"])[0]?.updateStatus, "current"); assert.equal(metadataCalls, 5); }
    finally { await reopened.shutdown(); }
  }, external);
});
test("exit zero with wrong package version or missing bin fails and preserves the last verified default", async () => {
  let mode = "healthy", version = "1.0.0";
  await fixture(async (_root, manager) => {
    assert.equal((await settled(manager, manager.submit({ harnessId: "fixture-a", action: "install", commandId: "initial" }).id)).status, "completed");
    const old = manager.resolveControl("fixture-a", "fixture-a-npm"); version = "2.0.0";
    for (const failure of ["wrong-version", "missing-bin", "nonzero"]) {
      mode = failure; const result = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "upgrade", commandId: failure }).id);
      assert.equal(result.status, "failed"); assert.deepEqual(manager.resolveControl("fixture-a", "fixture-a-npm"), old);
    }
  }, dependencies({ version: () => version, mode: () => mode }));
});
test("management cancellation waits for its actual child and command identities are shared both ways", async () => {
  let ready!: (pid: number) => void; const active = new Promise<number>(resolve => { ready = resolve; });
  await fixture(async (_root, manager) => {
    const job = manager.submit({ harnessId: "fixture-a", action: "install", commandId: "start" }), pid = await active;
    assert.throws(() => manager.cancel(job.id, "start"), code("COMMAND_CONFLICT"));
    const requested = manager.cancel(job.id, "cancel-key"); assert.equal(requested.cancelRequested, true);
    assert.throws(() => manager.submit({ harnessId: "fixture-b", action: "install", commandId: "cancel-key" }), code("COMMAND_CONFLICT"));
    const ended = await settled(manager, job.id); assert.equal(ended.status, "cancelled"); assert.throws(() => process.kill(pid, 0));
    assert.equal(manager.resolveControl("fixture-a", "fixture-a-npm"), null); assert.equal(manager.cancel(job.id, "cancel-key").id, job.id);
  }, dependencies({ mode: () => "wait", ready }));
});
test("one active installer and at most eight queued Jobs are admitted, with duplicate target rejection", async () => {
  let ready!: (pid: number) => void; const active = new Promise<number>(resolve => { ready = resolve; });
  const recipes = Array.from({ length: 11 }, (_, index) => recipe("fixture-" + index));
  await fixture(async (_root, manager) => {
    manager.submit({ harnessId: "fixture-0", action: "install", commandId: "active" }); await active;
    assert.throws(() => manager.submit({ harnessId: "fixture-0", action: "install", commandId: "duplicate-target" }), code("MANAGEMENT_BUSY"));
    for (let index = 1; index <= 8; index++) manager.submit({ harnessId: "fixture-" + index, action: "install", commandId: "queue-" + index });
    assert.throws(() => manager.submit({ harnessId: "fixture-9", action: "install", commandId: "queue-overflow" }), code("QUEUE_LIMIT"));
    await manager.shutdown(); assert.throws(() => manager.submit({ harnessId: "fixture-10", action: "install", commandId: "closed" }), code("MANAGEMENT_CLOSED"));
  }, { recipes, ...dependencies({ mode: () => "wait", ready }) });
});
test("management log chunks preserve all UTF8 text and sanitize before splitting", async () => {
  const original = "中😀".repeat(4000) + " synthetic-private-provider-key trailing";
  await fixture(async (_root, manager) => {
    const result = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "install", commandId: "long-log" }).id);
    assert.equal(result.status, "completed");
    const log = manager.logs(result.id, 0, 1000).filter(entry => entry.stream === "system").map(entry => entry.text).join("");
    assert.equal(log, original.replace("synthetic-private-provider-key", "[redacted]"));
    assert.ok(manager.logs(result.id, 0, 1000).every(entry => Buffer.byteLength(entry.text, "utf8") <= 4096));
  }, { ...dependencies({ log: original }), redactor: text => text.replaceAll("synthetic-private-provider-key", "[redacted]") });
});
test("a deadline terminates the real installer and never publishes its otherwise valid package", async () => fixture(async (_root, manager) => {
  const job = manager.submit({ harnessId: "fixture-a", action: "install", commandId: "timeout" });
  const result = await settled(manager, job.id); assert.equal(result.status, "failed"); assert.equal(result.error?.code, "INSTALL_TIMEOUT");
  assert.equal(manager.resolveControl("fixture-a", "fixture-a-npm"), null);
}, { ...dependencies({ mode: () => "wait" }), runTimeoutMs: 150 }));
test("update checks use resolved metadata and shutdown does not begin new requests after abort", async () => {
  let calls = 0;
  const metadata: ManagementMetadataPort = { resolve: (recipe, signal) => {
    calls++; return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ManagementError("CANCELLED", "fixture aborted")), { once: true });
      void resolve; void recipe;
    });
  } };
  await fixture(async (_root, manager) => {
    const ids = Array.from({ length: 12 }, (_, index) => "fixture-" + index), check = manager.checkUpdates(ids);
    assert.equal(calls, 4); await manager.shutdown(); await check; assert.equal(calls, 4);
  }, { recipes: Array.from({ length: 12 }, (_, index) => recipe("fixture-" + index)), metadata });
});
test("system version check probes a real private CLI, compares primary latest and preserves its cached observation across rescan", async () => {
  let latest = "2.0.0";
  await fixture(async (root, manager) => {
    const entry = join(root, "system-fixture.mjs"), count = join(root, "probe-count.txt");
    await writeFile(entry, 'import fs from "node:fs";const p=' + JSON.stringify(count) + ';fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0)+1));console.log("fixture-cli 1.0.0");');
    const observation = { harnessId: "fixture-a", controlId: "fixture-a-npm", command: { executable: process.execPath, args: [entry, "--acp"], env: {} } };
    manager.setSystemObservations([observation]); assert.equal(manager.views(["fixture-a"])[0]?.source, "system"); assert.equal(manager.views(["fixture-a"])[0]?.installedVersion, null);
    const checked = (await manager.checkUpdates(["fixture-a"]))[0]!; assert.equal(checked.installedVersion, "1.0.0"); assert.equal(checked.latestVersion, "2.0.0"); assert.equal(checked.updateStatus, "available");
    manager.setSystemObservations([observation]); assert.equal(manager.views(["fixture-a"])[0]?.installedVersion, "1.0.0");
    latest = "1.0.0"; const repeated = (await manager.checkUpdates(["fixture-a"]))[0]!; assert.equal(repeated.updateStatus, "current");
    assert.equal(await readFile(count, "utf8"), "2");
  }, dependencies({ version: () => latest }));
});
test("a real package version observation needs no process launch and the actual local program keeps precedence over a private copy", async () => fixture(async (root, manager) => {
  manager.setSystemObservations([{ harnessId: "fixture-a", controlId: "fixture-a-npm", command: { executable: join(root, "not-launched"), args: [], env: {} }, packageVersion: "0.5.0" }]);
  const checked = (await manager.checkUpdates(["fixture-a"]))[0]!; assert.equal(checked.source, "system"); assert.equal(checked.installedVersion, "0.5.0"); assert.equal(checked.updateStatus, "available");
  assert.throws(() => manager.submit({ harnessId: "fixture-a", action: "upgrade", commandId: "managed" }), error => error instanceof Error && "code" in error && error.code === "NATIVE_UPGRADE_UNSUPPORTED");
  assert.equal(manager.views(["fixture-a"])[0]?.source, "system"); assert.equal(manager.views(["fixture-a"])[0]?.installedVersion, "0.5.0");
}));
test("slot marker ownership loss before activation produces unknown and never publishes the damaged package", async () => {
  const base = dependencies();
  await fixture(async (_root, manager) => {
    const result = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "install", commandId: "marker-loss" }).id);
    assert.equal(result.status, "unknown"); assert.equal(result.error?.code, "OWNERSHIP_LOST"); assert.equal(manager.resolveControl("fixture-a", "fixture-a-npm"), null);
  }, { ...base, installer: { install: async (spec, context) => {
    const result = await base.installer.install(spec, context); await writeFile(join(context.stage, ".slot.json"), '{"foreign":true}'); return result;
  } } });
});
test("reopen cancels oldest queued and marks oldest active as unknown beyond the display window without replay", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-management-recovery-"))); const opts: ManagementOptions = { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [recipe()], ...dependencies() };
  const initial = new LocalHarnessManagement(root, opts); initial.close();
  const db = new DatabaseSync(join(root, "management", "management.sqlite")), time = new Date().toISOString(), oldest = "management-" + randomUUID(), queued = "management-" + randomUUID();
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare("INSERT INTO management_jobs(id,harness_id,status,command_id,fingerprint,expected_revision,view_json) VALUES(?,?,?,?,?,?,?)");
    for (let index = 0; index < 1022; index++) {
      const id = index === 0 ? oldest : index === 1 ? queued : "management-" + randomUUID(), status = index === 0 ? "resolving" : index === 1 ? "queued" : "cancelled";
      const view = { id, harnessId: "fixture-a", controlId: "fixture-a-npm", action: "install", status, phase: status, cancelRequested: false,
        createdAt: time, updatedAt: time, resolvedVersion: null, installationId: null, error: null, logCursor: 0 };
      insert.run(id, "fixture-a", status, "history-" + index, "a".repeat(64), 0, JSON.stringify(view));
    } db.exec("COMMIT");
  } finally { db.close(); }
  const reopened = new LocalHarnessManagement(root, { installationMode: "private-fixture", ...opts, ownerGeneration: 2 });
  try { assert.equal(reopened.readJob(oldest).status, "unknown"); assert.equal(reopened.readJob(queued).status, "cancelled"); assert.equal(reopened.views(["fixture-a"])[0]?.activeJobId, null); }
  finally { await reopened.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test("persisted SQL columns, watermarks and oversized payloads fail explicitly instead of being filtered out", async () => {
  for (const mutation of ["UPDATE management_jobs SET status='queued'", "UPDATE management_jobs SET view_json=json_set(view_json,'$.logCursor',99)", "UPDATE management_jobs SET view_json='" + "x".repeat(65537) + "'"]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-management-corrupt-"))), options: ManagementOptions = { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [recipe()], ...dependencies() };
    const manager = new LocalHarnessManagement(root, options); const job = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "install", commandId: "create" }).id);
    assert.equal(job.status, "completed"); await manager.shutdown(); const db = new DatabaseSync(join(root, "management", "management.sqlite"));
    try { db.exec(mutation); } finally { db.close(); }
    try { assert.throws(() => new LocalHarnessManagement(root, { installationMode: "private-fixture", ...options, ownerGeneration: 2 }), error => error instanceof ManagementError && error.code === "INVALID_DATA"); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
test("tampered slot namespace and command entry never become a usable default", async () => {
  for (const kind of ["slot", "entry", "args", "environment", "marker"]) await fixture(async (root, manager) => {
    const job = await settled(manager, manager.submit({ harnessId: "fixture-a", action: "install", commandId: "create" }).id); assert.equal(job.status, "completed");
    const db = new DatabaseSync(join(root, "management", "management.sqlite"));
    try {
      const row = db.prepare("SELECT record_json FROM management_installations WHERE id=?").get(job.installationId!); assert.equal(typeof row?.record_json, "string");
      const record = JSON.parse(String(row?.record_json));
      if (kind === "slot") { const other = join(root, "unrelated-private"); await mkdir(other, { mode: 0o700 }); record.slot = other; db.prepare("UPDATE management_installations SET record_json=? WHERE id=?").run(JSON.stringify(record), job.installationId!); }
      else if (kind === "entry") { record.command.args[0] = peer; db.prepare("UPDATE management_installations SET record_json=? WHERE id=?").run(JSON.stringify(record), job.installationId!); }
      else if (kind === "args") { record.command.args.push("--other-command"); db.prepare("UPDATE management_installations SET record_json=? WHERE id=?").run(JSON.stringify(record), job.installationId!); }
      else if (kind === "environment") { record.command.env.NODE_OPTIONS = "--import /outside"; db.prepare("UPDATE management_installations SET record_json=? WHERE id=?").run(JSON.stringify(record), job.installationId!); }
      else await writeFile(join(record.slot, ".slot.json"), JSON.stringify({ installationId: job.installationId, jobId: "management-" + randomUUID(), ownerGeneration: 1 }));
      assert.throws(() => manager.resolveControl("fixture-a", "fixture-a-npm"));
    } finally { db.close(); }
  });
});
