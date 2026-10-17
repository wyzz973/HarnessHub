import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer, type WebServerOptions } from "../../src/web/server.js";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { LocalProviderService } from "../../src/infrastructure/provider/service.js";
import { DirectorySessionBindingFactory } from "../../src/infrastructure/session/binding-factory.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import type { ManagementInstallerPort, ManagementMetadataPort } from "../../src/contracts/management.js";
import { fileURLToPath } from "node:url";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
interface Fixture { readonly root: string; readonly data: string; readonly workspace: string; gateway: WebServer; origin: string; cookie: string; csrf: string; expectedCloseCode: string | null }
async function fixture(t: test.TestContext, compose?: WebServerOptions["application"]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-web-management-")), workspace = join(root, "workspace"), assets = join(root, "assets"), data = join(root, "data");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>Management fixture</title>");
  const configuration = await prepareConfiguration({ workspace, pathOnly: true });
  const gateway = await startWebServer({ root: data, configuration, assetsDirectory: assets, ...(compose === undefined ? { workspaceLockRoot: join(root, "locks") } : { application: compose }) });
  const f: Fixture = { root, data, workspace: configuration.workspace, gateway, origin: new URL(gateway.url).origin, cookie: "", csrf: "", expectedCloseCode: null };
  t.after(async () => {
    try { if (f.expectedCloseCode === null) await f.gateway.close(); else await assert.rejects(f.gateway.close(), (error: unknown) => record(error).code === f.expectedCloseCode); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await authenticate(f, gateway.url); return f;
}
async function authenticate(f: Fixture, startupUrl: string): Promise<void> {
  const token = new URLSearchParams(new URL(startupUrl).hash.slice(1)).get("token");
  const response = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 200); const cookie = response.headers.get("set-cookie"); assert.ok(cookie);
  f.cookie = cookie.split(";", 1)[0]!; f.csrf = String(record(await response.json()).csrfToken);
}
async function call(f: Fixture, path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}): Promise<{ readonly status: number; readonly data: unknown; readonly text: string }> {
  const response = await fetch(f.origin + path, { method, headers: { Cookie: f.cookie, Origin: f.origin,
    ...(method === "GET" ? {} : { "X-CSRF-Token": f.csrf, "Content-Type": "application/json" }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); return { status: response.status, text, data: JSON.parse(text) as unknown };
}
const sessionPeer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
class ExternalInstallFixture {
  version = "1.0.0";
  hold = false;
  harnessHold = false;
  management: LocalHarnessManagement | null = null;
  readonly installed: { readonly pid: number; readonly version: string; readonly stage: string }[] = [];
  readonly metadata: ManagementMetadataPort = { resolve: async (recipe, signal) => {
    signal.throwIfAborted(); return { recipe, version: this.version, artifactUrl: null, integrity: null, engines: { node: ">=24" }, dependencies: [] };
  } };
  readonly installer: ManagementInstallerPort = { install: async (spec, context) => {
    assert.ok(spec.recipe.packageName);
    const node = await realpath(process.execPath), directory = join(context.stage, "node_modules", spec.recipe.packageName), entry = join(directory, "fixture-entry.mjs");
    const peer = await readFile(sessionPeer, "utf8"); context.assertOwned();
    const script = "process.argv = [process.argv[0], process.argv[1], 'codex-app-server', " + JSON.stringify(spec.version) + ", " + JSON.stringify(this.harnessHold ? "hold" : "basic") + "];\n" + peer;
    const data = { directory, entry, name: spec.recipe.packageName, version: spec.version, binName: spec.recipe.binName, script, hold: this.hold };
    const program = `const fs=require('node:fs');const d=JSON.parse(process.argv[1]);fs.mkdirSync(d.directory,{recursive:true,mode:448});fs.writeFileSync(d.entry,d.script,{mode:448});fs.writeFileSync(d.directory+'/package.json',JSON.stringify({name:d.name,version:d.version,bin:{[d.binName]:'fixture-entry.mjs'}}),{mode:384});process.stdout.write('installed '+d.name+' '+d.version+'\\n');if(d.hold){process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);}`;
    const child = spawn(node, ["-e", program, JSON.stringify(data)], { cwd: context.stage, env: { HOME: context.stage, PATH: dirname(node), LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(child.pid); this.installed.push({ pid: child.pid, version: spec.version, stage: context.stage });
    child.stdout.on("data", (chunk: Buffer) => context.log("stdout", chunk.toString("utf8"))); child.stderr.on("data", (chunk: Buffer) => context.log("stderr", chunk.toString("utf8")));
    const abort = () => { child.kill("SIGTERM"); }; context.signal.addEventListener("abort", abort, { once: true }); if (context.signal.aborted) abort();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
      context.assertOwned(); context.signal.throwIfAborted(); assert.equal(result.code, 0); assert.equal(result.signal, null);
      return { command: { executable: node, args: [entry, ...spec.recipe.args], env: {} }, observedVersion: spec.version, artifactSha256: null };
    } finally { clearTimeout(timeout); context.signal.removeEventListener("abort", abort); }
  } };
  compose(): NonNullable<WebServerOptions["application"]> {
    return (root, publish) => {
      const store = new SqliteSessionStore(root), owner = () => store.assertOwner();
      const providers = new LocalProviderService(root, owner);
      const management = this.management = new LocalHarnessManagement(root, { installationMode: "private-fixture", assertOwner: owner, ownerGeneration: store.ownerGeneration, metadata: this.metadata, installer: this.installer, nodeExecutable: process.execPath });
      const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(root, "workspace-locks")), owner, "any", providers, management,
        { home: root, values: { HOME: root, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } });
      const content = new LocalContentStore(root, owner);
      const runtime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), fingerprint: value => createHash("sha256").update(value).digest("hex"), publish, content });
      return { store, content, providers, management, factory, runtime };
    };
  }
}
async function waitJob(f: Fixture, id: string, predicate: (job: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const output = await call(f, "/api/v1/installation-jobs/" + id); assert.equal(output.status, 200, output.text); const job = record(output.data); if (predicate(job)) return job; await delay(20); }
  throw new Error("Job did not reach expected state: " + (await call(f, "/api/v1/installation-jobs/" + id)).text);
}
async function submit(f: Fixture, commandId: string, action: "install" | "upgrade" = "install", expectedDefaultRevision?: number): Promise<string> {
  const output = await call(f, "/api/v1/installation-jobs", "POST", { harnessId: "codex", controlId: "codex-native", action, commandId, ...(expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision }) });
  assert.equal(output.status, 202, output.text); return String(record(output.data).id);
}

test("management HTTP state exposes explicit install capabilities and initially empty persisted Jobs", async t => {
  const f = await fixture(t), state = await call(f, "/api/v1/state"); assert.equal(state.status, 200, state.text);
  const value = record(state.data); assert.deepEqual(value.jobs, []); assert.ok(Array.isArray(value.harnesses));
  const codex = value.harnesses.map(record).find(item => item.id === "codex"); assert.ok(codex); assert.ok(codex.management !== null && typeof codex.management === "object");
  const listed = await call(f, "/api/v1/installation-jobs?limit=50"); assert.equal(listed.status, 200); assert.deepEqual(listed.data, []);
  assert.equal(state.text.includes("npmrc"), false); assert.equal(state.text.includes("master.key"), false);
});

test("installation API rejects cross-site requests and missing CSRF before creating any Job", async t => {
  const f = await fixture(t), body = { harnessId: "codex", action: "install", commandId: "hostile-install" };
  const foreign = await call(f, "/api/v1/installation-jobs", "POST", body, { Origin: "https://attacker.invalid" }); assert.equal(foreign.status, 403);
  const csrf = await call(f, "/api/v1/installation-jobs", "POST", body, { "X-CSRF-Token": "wrong" }); assert.equal(csrf.status, 403);
  const check = await call(f, "/api/v1/harnesses/check-updates", "POST", {}, { Origin: "https://attacker.invalid" }); assert.equal(check.status, 403);
  assert.deepEqual((await call(f, "/api/v1/installation-jobs")).data, []);
});

test("installation API validates unknown fields, actions, CAS versions and bounded cursors without launching tools", async t => {
  const f = await fixture(t);
  for (const body of [
    { harnessId: "codex", action: "uninstall", commandId: "invalid-action" },
    { harnessId: "codex", action: "install", commandId: "arbitrary-shell", shell: "touch /not-allowed" },
    { harnessId: "codex", action: "install", commandId: "bad-cas", expectedDefaultRevision: -1 },
    { action: "install", commandId: "no-harness" },
  ]) assert.equal((await call(f, "/api/v1/installation-jobs", "POST", body)).status, 400);
  for (const path of ["/api/v1/installation-jobs?limit=0", "/api/v1/installation-jobs?limit=101", "/api/v1/installation-jobs?limit=1&limit=2", "/api/v1/installation-jobs?afterSeq=1"])
    assert.equal((await call(f, path)).status, 400);
  for (const body of [{ harnessIds: ["codex", "codex"] }, { harnessIds: ["../bad"] }, { commandId: "unknown-check-field" }, { harnessIds: Array(129).fill("codex") }])
    assert.equal((await call(f, "/api/v1/harnesses/check-updates", "POST", body)).status, 400);
  assert.deepEqual((await call(f, "/api/v1/installation-jobs")).data, []);
});

test("real management HTTP persists one idempotent install, verifies its package and re-discovers the committed managed entry", async t => {
  const external = new ExternalInstallFixture(), f = await fixture(t, external.compose());
  const id = await submit(f, "install-once"); assert.equal(await submit(f, "install-once"), id);
  const job = await waitJob(f, id, value => value.status === "completed"); assert.equal(job.resolvedVersion, "1.0.0"); assert.ok(job.installationId);
  assert.equal(external.installed.length, 1);
  const conflict = await call(f, "/api/v1/installation-jobs", "POST", { harnessId: "gemini", action: "install", commandId: "install-once" }); assert.equal(conflict.status, 409, conflict.text);
  const state = record((await call(f, "/api/v1/state")).data); assert.ok(Array.isArray(state.harnesses)); assert.ok(Array.isArray(state.jobs));
  const codex = state.harnesses.map(record).find(item => item.id === "codex"); assert.ok(codex); assert.equal(codex.installed, true);
  assert.equal(codex.defaultControlId, "codex-native", "managed control was not projected as the default");
  const managed = record(codex.management); assert.equal(managed.source, "managed"); assert.equal(managed.installedVersion, "1.0.0"); assert.equal(managed.installationId, job.installationId);
  assert.ok(Array.isArray(codex.controls)); assert.equal(codex.controls.map(record).find(item => item.id === "codex-native")?.available, true);
  assert.equal(JSON.stringify(state).includes(external.installed[0]!.stage), false, "private staging path leaked to API views");
  const page = record((await call(f, `/api/v1/installation-jobs/${id}/logs?afterSeq=0&limit=1`)).data); assert.ok(Array.isArray(page.entries)); assert.ok(page.entries.length <= 1); assert.ok(Number(page.nextSeq) > 0);
});

test("upgrade CAS preserves immutable old installation and only switches the managed default after verification", async t => {
  const external = new ExternalInstallFixture(), f = await fixture(t, external.compose()), initial = await submit(f, "initial-install"); await waitJob(f, initial, value => value.status === "completed");
  const list = (await call(f, "/api/v1/harnesses")).data; assert.ok(Array.isArray(list)); const first = record(list.map(record).find(item => item.id === "codex")?.management);
  const prior = external.management?.resolveControl("codex", "codex-native"); assert.ok(prior); const oldEntry = prior.command.args[0]; assert.ok(oldEntry); const originalBytes = await readFile(oldEntry);
  external.version = "2.0.0";
  const checked = await call(f, "/api/v1/harnesses/check-updates", "POST", { harnessIds: ["codex"] }); assert.equal(checked.status, 200, checked.text); assert.ok(Array.isArray(checked.data));
  const available = record(checked.data.map(record).find(item => item.id === "codex")?.management); assert.equal(available.latestVersion, "2.0.0"); assert.equal(available.updateStatus, "available");
  const upgraded = await submit(f, "upgrade-two", "upgrade", Number(first.defaultRevision)); await waitJob(f, upgraded, value => value.status === "completed");
  const after = (await call(f, "/api/v1/harnesses")).data; assert.ok(Array.isArray(after)); const current = record(after.map(record).find(item => item.id === "codex")?.management);
  assert.equal(current.installedVersion, "2.0.0"); assert.notEqual(current.installationId, first.installationId); assert.equal(Number(current.defaultRevision), Number(first.defaultRevision) + 1);
  const stale = await call(f, "/api/v1/installation-jobs", "POST", { harnessId: "codex", action: "upgrade", commandId: "stale-upgrade", expectedDefaultRevision: first.defaultRevision }); assert.equal(stale.status, 409, stale.text);
  assert.deepEqual(external.installed.map(item => item.version), ["1.0.0", "2.0.0"]);
  assert.deepEqual(await readFile(oldEntry), originalBytes, "upgrade rewrote an immutable previous version");
});

test("upgrade leaves the current actual Harness process on its pinned version and the next Turn uses the new managed version", async t => {
  const external = new ExternalInstallFixture(); external.harnessHold = true; const f = await fixture(t, external.compose());
  const first = await submit(f, "old-version"); await waitJob(f, first, value => value.status === "completed");
  const created = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "codex", controlId: "codex-native" }, commandId: "managed-chat" }); assert.equal(created.status, 201, created.text); const id = String(record(created.data).id);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first-turn" });
  const waitSnapshot = async (predicate: (value: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = record((await call(f, "/api/v1/sessions/" + id)).data); if (predicate(value)) return value; await delay(20); }
    throw new Error("managed Session did not reach expected state");
  };
  await waitSnapshot(value => Array.isArray(value.messages) && value.messages.map(record).some(message => message.text === "1.0.0:first"));
  const before = external.management?.resolveControl("codex", "codex-native"); assert.ok(before); const entry = before.command.args[0]; assert.ok(entry); const bytes = await readFile(entry);
  external.version = "2.0.0"; external.harnessHold = false;
  const upgraded = await submit(f, "new-version", "upgrade", before.revision); await waitJob(f, upgraded, value => value.status === "completed");
  const active = record((await call(f, "/api/v1/sessions/" + id)).data); assert.ok(Array.isArray(active.runs)); assert.equal(record(active.runs[0]).status, "running");
  assert.deepEqual(await readFile(entry), bytes);
  assert.equal((await call(f, `/api/v1/sessions/${id}/cancel`, "POST", { commandId: "cancel-old-run" })).status, 202);
  await waitSnapshot(value => Array.isArray(value.runs) && record(value.runs[0]).status === "cancelled");
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "second", commandId: "second-turn" });
  const final = await waitSnapshot(value => Array.isArray(value.runs) && value.runs.length === 2 && record(value.runs[1]).status === "completed");
  assert.ok(Array.isArray(final.messages)); assert.ok(final.messages.map(record).some(message => message.text === "2.0.0:second"));
});

test("closing a browser request does not cancel installation, while explicit cancellation settles its actual child process", async t => {
  const external = new ExternalInstallFixture(); external.hold = true; const f = await fixture(t, external.compose()), id = await submit(f, "hold-install");
  await waitJob(f, id, value => value.status === "installing" && Number(value.logCursor) > 0);
  const abort = new AbortController(), request = fetch(f.origin + `/api/v1/installation-jobs/${id}/logs?afterSeq=0`, { headers: { Cookie: f.cookie }, signal: abort.signal }); abort.abort(); await assert.rejects(request);
  assert.equal((await waitJob(f, id, () => true)).cancelRequested, false);
  const receipt = await call(f, `/api/v1/installation-jobs/${id}/cancel`, "POST", { commandId: "cancel-install" }); assert.equal(receipt.status, 202, receipt.text); assert.equal(record(receipt.data).cancelRequested, true);
  await waitJob(f, id, value => value.status === "cancelled");
  assert.throws(() => process.kill(external.installed[0]!.pid, 0), (error: unknown) => record(error).code === "ESRCH");
  const replay = await call(f, `/api/v1/installation-jobs/${id}/cancel`, "POST", { commandId: "cancel-install" }); assert.equal(replay.status, 202); assert.equal(record(replay.data).id, id);
  const commandConflict = await call(f, "/api/v1/installation-jobs", "POST", { harnessId: "gemini", action: "install", commandId: "cancel-install" });
  assert.equal(commandConflict.status, 409, "cancel and submit command identities must share the same conflict contract: " + commandConflict.text);
});

test("web shutdown waits for the installer and reopening preserves the durable cancelled Job", async t => {
  const external = new ExternalInstallFixture(); external.hold = true; const compose = external.compose(), f = await fixture(t, compose), id = await submit(f, "shutdown-install");
  await waitJob(f, id, value => value.status === "installing" && Number(value.logCursor) > 0); await f.gateway.close();
  assert.throws(() => process.kill(external.installed[0]!.pid, 0), (error: unknown) => record(error).code === "ESRCH");
  f.gateway = await startWebServer({ root: f.data, configuration: await prepareConfiguration({ workspace: f.workspace, pathOnly: true }), application: compose });
  f.origin = new URL(f.gateway.url).origin; await authenticate(f, f.gateway.url);
  const recovered = await waitJob(f, id, () => true); assert.equal(recovered.status, "cancelled"); assert.equal(external.installed.length, 1);
});

test("lost owner identity still closes the actual installer before web shutdown reports the failure", async t => {
  const external = new ExternalInstallFixture(); external.hold = true; const f = await fixture(t, external.compose()), id = await submit(f, "owner-loss-install");
  await waitJob(f, id, value => value.status === "installing" && Number(value.logCursor) > 0);
  const pid = external.installed[0]!.pid;
  await rename(join(f.data, "owner.sqlite"), join(f.data, "owner-moved.sqlite"));
  await writeFile(join(f.data, "owner.sqlite"), Buffer.alloc(0), { mode: 0o600 });
  f.expectedCloseCode = "OWNER_LOST";
  try {
    await assert.rejects(f.gateway.close(), (error: unknown) => record(error).code === "OWNER_LOST");
    assert.throws(() => process.kill(pid, 0), (error: unknown) => record(error).code === "ESRCH", "installer survived owner-loss shutdown");
  } finally {
    // Only this fixture's recorded child is eligible for emergency cleanup after an assertion fails.
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (record(error).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) { try { process.kill(pid, 0); await delay(20); } catch (error) { if (record(error).code === "ESRCH") break; throw error; } }
  }
});
