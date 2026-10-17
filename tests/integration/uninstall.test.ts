import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ManagementError, type InstallationJobView, type InstallationObservation, type InstallationRemovalPort, type NativeProgramUsers } from "../../src/contracts/management.js";
import { productChannels, productMaintenance } from "../../src/adapters/catalog-channels.js";
import { executeScriptRemoval, planScriptRemoval } from "../../src/infrastructure/management/uninstall.js";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { NativeInstallationLocks } from "../../src/infrastructure/management/native-lock.js";
import { managementStorage } from "../../src/infrastructure/management/storage.js";
import { parseManagementJob } from "../../src/contexts/management/domain/state.js";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import type { HarnessView, UninstallCheckView } from "../../src/contracts/web.js";

const macOnly = { skip: process.platform !== "darwin" && "uninstall is macOS only (ADR-044)" };
const code = (expected: string) => (error: unknown): boolean => error instanceof ManagementError && error.code === expected;
/** A private directory removed after the test, once everything `closers` holds (a Gateway using it) has closed. */
async function temporary(t: test.TestContext, name: string, closers: (() => Promise<void>)[] = []): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), name)));
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); }); return root;
}
async function file(path: string, text = "x", mode = 0o644): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); }
async function link(target: string, path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await symlink(target, path); }

test("G011-UN1 a script installation is removed exactly as its installer wrote it; a link elsewhere or the user's own launcher is kept, and a linked directory or parent is refused", async t => {
  const home = await temporary(t, "uninstall-script-");
  const removal = (id: string) => productChannels(id)!.scripts[0]!.removal!;
  // Claude Code as its installer lays it out, with the data the user keeps.
  await file(join(home, ".local/share/claude/versions/9.9.9"), "#!/bin/sh\n", 0o755); await link(join(home, ".local/share/claude/versions/9.9.9"), join(home, ".local/bin/claude"));
  await file(join(home, ".claude/settings.json"), "{\"keep\":1}"); await file(join(home, ".claude.json"), "{\"keep\":2}");
  const plan = await planScriptRemoval(removal("claude"), home);
  assert.deepEqual(plan.steps.map(step => [step.kind, step.path]), [["link", join(home, ".local/bin/claude")], ["directory", join(home, ".local/share/claude")]]);
  // A link replaced after the plan was read: nothing is removed.
  await rm(join(home, ".local/bin/claude")); await link(join(home, ".local/share/claude/versions/9.9.9"), join(home, ".local/bin/claude"));
  await assert.rejects(executeScriptRemoval(removal("claude"), home, plan, () => {}, () => {}), code("INSTALLATION_CHANGED"));
  assert.ok(existsSync(join(home, ".local/share/claude/versions/9.9.9")));
  let began = 0; const logs: string[] = [];
  await executeScriptRemoval(removal("claude"), home, await planScriptRemoval(removal("claude"), home), text => logs.push(text), () => { began++; });
  assert.equal(began, 1, "the mutation is announced once, before the first deletion");
  for (const path of [".local/bin/claude", ".local/share/claude"]) assert.equal(existsSync(join(home, path)), false, path);
  assert.equal(await readFile(join(home, ".claude/settings.json"), "utf8"), "{\"keep\":1}"); assert.equal(await readFile(join(home, ".claude.json"), "utf8"), "{\"keep\":2}");
  assert.deepEqual(logs, ["已删除 " + join(home, ".local/bin/claude"), "已删除 " + join(home, ".local/share/claude")]);

  // Kept: a launcher the user wrote, and a link into another installation; only the installer's directory goes.
  await file(join(home, ".local/share/cursor-agent/versions/2026.10.01/cursor-agent"), "#!/bin/sh\n", 0o755);
  await file(join(home, ".local/bin/agent"), "#!/bin/sh\nexec my-agent \"$@\"\n", 0o755);
  await file(join(home, "elsewhere/cursor-agent"), "#!/bin/sh\n", 0o755); await link(join(home, "elsewhere/cursor-agent"), join(home, ".local/bin/cursor-agent"));
  const cursor = await planScriptRemoval(removal("cursor"), home);
  assert.deepEqual(cursor.steps.map(step => step.path), [join(home, ".local/share/cursor-agent")]);
  assert.deepEqual(cursor.skipped.map(item => item.path), [join(home, ".local/bin/agent"), join(home, ".local/bin/cursor-agent")]);

  // Codex: both links its installer writes, and its release directory.
  await file(join(home, ".codex/packages/standalone/releases/1.0.0/bin/codex"), "#!/bin/sh\n", 0o755); await file(join(home, ".codex/config.toml"), "keep");
  for (const name of ["codex", "codex-code-mode-host"]) await link(join(home, ".codex/packages/standalone/releases/1.0.0/bin/codex"), join(home, ".local/bin", name));
  assert.deepEqual((await planScriptRemoval(removal("codex"), home)).steps.map(step => step.path), [join(home, ".local/bin/codex"), join(home, ".local/bin/codex-code-mode-host"), join(home, ".codex/packages/standalone")]);

  // Hermes: its launcher only while it starts the checkout's program.
  await file(join(home, ".hermes/hermes-agent/venv/bin/hermes"), "#!/bin/sh\n", 0o755); await file(join(home, ".hermes/config.yaml"), "keep");
  await file(join(home, ".local/bin/hermes"), "#!/bin/bash\nexec \"" + join(home, ".hermes/hermes-agent/venv/bin/hermes") + "\" \"$@\"\n", 0o755);
  assert.deepEqual((await planScriptRemoval(removal("hermes"), home)).steps.map(step => [step.kind, step.path]), [["launcher", join(home, ".local/bin/hermes")], ["directory", join(home, ".hermes/hermes-agent")]]);
  await file(join(home, ".local/bin/hermes"), "#!/bin/bash\nexec \"/usr/local/bin/hermes\" \"$@\"\n", 0o755);
  assert.deepEqual((await planScriptRemoval(removal("hermes"), home)).skipped.map(item => item.path), [join(home, ".local/bin/hermes")]);

  // OpenCode: its one file, and its bin directory only once empty.
  await file(join(home, ".opencode/bin/opencode"), "#!/bin/sh\n", 0o755); await file(join(home, ".opencode/bin/user-tool"), "mine");
  const opencode = await planScriptRemoval(removal("opencode"), home), kept: string[] = [];
  await executeScriptRemoval(removal("opencode"), home, opencode, text => kept.push(text), () => {});
  assert.equal(existsSync(join(home, ".opencode/bin/opencode")), false); assert.ok(existsSync(join(home, ".opencode/bin/user-tool")));
  assert.ok(kept.some(text => text.startsWith("目录里还有别的文件，保留：")));

  // Refused before anything changes: a directory that is a link, and a parent that resolves elsewhere through a link.
  await file(join(home, "other/claude/versions/1.0.0"), "#!/bin/sh\n", 0o755); await link(join(home, "other/claude"), join(home, ".local/share/claude"));
  await assert.rejects(planScriptRemoval(removal("claude"), home), code("REMOVAL_REFUSED"));
  assert.ok(existsSync(join(home, "other/claude/versions/1.0.0")));
  await rm(join(home, ".local/share/claude"));
  const elsewhere = join(home, "elsewhere-bin"); await mkdir(elsewhere); await rm(join(home, ".local/bin"), { recursive: true }); await symlink(elsewhere, join(home, ".local/bin"));
  await link(join(home, ".codex/packages/standalone/releases/1.0.0/bin/codex"), join(elsewhere, "codex"));
  await assert.rejects(planScriptRemoval(removal("codex"), home), code("REMOVAL_REFUSED"));
  assert.ok(existsSync(join(elsewhere, "codex")));

  // The whitelists themselves: plain home-relative paths, and never the product's data directory or an ancestor of it.
  for (const id of ["claude", "codex", "cursor", "opencode", "hermes"]) {
    const spec = removal(id), data = productMaintenance(id).data;
    for (const path of [...spec.links, ...spec.launchers, ...spec.files, ...spec.directories, ...spec.emptyDirectories]) {
      assert.match(path, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u, id + ": " + path); assert.ok(!path.split("/").includes(".."), path);
      assert.ok(!data.some(kept => kept === path || kept.startsWith(path + "/")), id + " removes " + path + ", which holds its data");
    }
  }
});

test("G011-UN2 management v4 keeps uninstall jobs with their frozen target; the documented downgrade to v3 removes exactly those and v3's rows stay", async t => {
  const root = await temporary(t, "uninstall-storage-");
  const storage = managementStorage(root, 1);
  assert.equal(storage.db.prepare("PRAGMA user_version").get()?.user_version, 6);
  // This build is v6; its installation upgrades and official install requests go first (v6 to v5 to v4), which keeps every uninstall.
  storage.db.exec(await readFile(new URL("../../../tools/management-v6-to-v5.sql", import.meta.url), "utf8"));
  storage.db.exec(await readFile(new URL("../../../tools/management-v5-to-v4.sql", import.meta.url), "utf8"));
  assert.equal(storage.db.prepare("PRAGMA user_version").get()?.user_version, 4);
  const target = { harnessId: "claude", controlId: "claude-acp-npm", ref: "a".repeat(64), role: "product", channel: "npm", name: "@anthropic-ai/claude-code", root: "/opt/prefix/lib/node_modules/@anthropic-ai/claude-code",
    prefix: "/opt/prefix", entry: "/opt/prefix/bin/claude", resolvedPath: "/opt/prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js", version: "1.0.31", active: false, label: "npm 全局（nvm v23.10.0）", fingerprint: "b".repeat(64) };
  const uninstall = { id: "management-55555555-5555-4555-8555-555555555555", harnessId: "claude", controlId: "claude-acp-npm", action: "uninstall", status: "completed", phase: "completed", cancelRequested: false,
    createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:01:00.000Z", resolvedVersion: "1.0.31", installationId: null, error: null, logCursor: 1,
    native: { channel: "npm", location: "/opt/prefix/bin/claude", beforeVersion: "1.0.31", actualVersion: null, dispatched: true, configurationPreserved: true,
      uninstall: { label: "npm 全局（nvm v23.10.0）", role: "product", stopServices: [], stoppedServices: [], removed: true } } };
  const upgrade = { id: "management-66666666-6666-4666-8666-666666666666", harnessId: "openclaw", controlId: "openclaw-native", action: "upgrade", status: "failed", phase: "failed", cancelRequested: false,
    createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:01:00.000Z", resolvedVersion: null, installationId: null, error: { code: "HARNESS_BUSY", message: "x" }, logCursor: 0 };
  assert.deepEqual(parseManagementJob(uninstall), uninstall, "the v4 reader takes an uninstall and its facts");
  // A completed uninstall must have been verified, carries no installed version, and only an uninstall carries uninstall facts.
  assert.throws(() => parseManagementJob({ ...uninstall, native: { ...uninstall.native, uninstall: { ...uninstall.native.uninstall, removed: false } } }), code("INVALID_DATA"));
  assert.throws(() => parseManagementJob({ ...uninstall, native: { ...uninstall.native, actualVersion: "1.0.31" } }), code("INVALID_DATA"));
  assert.throws(() => parseManagementJob({ ...upgrade, native: uninstall.native }), code("INVALID_DATA"));
  for (const [view, command] of [[uninstall, "u"], [upgrade, "g"]] as const) storage.db.prepare("INSERT INTO management_jobs VALUES(?,?,?,?,?,?,?)").run(view.id, view.harnessId, view.status, command, "f".repeat(64), 0, JSON.stringify(view));
  storage.db.prepare("INSERT INTO management_installation_targets VALUES(?,?)").run(uninstall.id, JSON.stringify(target));
  storage.db.prepare("INSERT INTO management_logs VALUES(?,?,?)").run(uninstall.id, 1, JSON.stringify({ seq: 1, time: "2026-10-17T00:00:30.000Z", stream: "system", text: "已删除 ~/x" }));
  storage.db.close();
  const db = new DatabaseSync(join(root, "management", "management.sqlite"));
  try {
    db.exec(await readFile(new URL("../../../tools/management-v4-to-v3.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
    assert.deepEqual(db.prepare("SELECT id FROM management_jobs").all().map(row => row.id), [upgrade.id]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM management_logs").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='management_installation_targets'").get()?.n, 0);
  } finally { db.close(); }
  const reopened = managementStorage(root, 2);
  try { assert.equal(reopened.db.prepare("PRAGMA user_version").get()?.user_version, 6); assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n, 1); } finally { reopened.db.close(); }
});

/** A removal that changes nothing on the host: it records calls, and its usage is what the test sets. */
function fakeRemoval(home: string) {
  const state = {
    calls: [] as string[], removed: false, failRemove: false, identity: "one", drift: 0,
    usage: { servicesKnown: true, services: [] as { label: string; pid: number }[], resident: [] as { pid: number; name: string; stop?: string }[], processes: [] as { pid: number; name: string }[], own: [] as { pid: number; name: string }[] },
  };
  const port: InstallationRemovalPort = {
    identity: async () => state.identity,
    preview: async target => ({ commands: [join(target.prefix ?? home, "bin", "npm") + " uninstall --global --prefix " + target.prefix + " " + target.name], removes: [target.root, target.entry], skipped: [], documented: true }),
    usage: async () => state.usage,
    remains: async () => !state.removed,
    localChanges: async () => null,
    stopService: async (_target, service) => { state.calls.push("stop:" + service.label + ":" + service.stop.map(args => args.join(" ")).join(",")); state.usage = { ...state.usage, services: state.usage.services.filter(item => item.label !== service.label) }; },
    remove: async (_target, context) => { context.beginMutation(); state.calls.push("remove"); if (state.failRemove) throw new ManagementError("PROCESS_FAILED", "npm exited unsuccessfully"); state.removed = true; },
    // `drift` makes another program (a running Claude Code session, say) write the configuration during the uninstall.
    configuration: async () => state.drift ? "changed-" + state.drift++ : "unchanged",
  };
  return { state, port };
}
async function settled(manager: LocalHarnessManagement, id: string): Promise<InstallationJobView> {
  const end = Date.now() + 5000;
  while (Date.now() < end) { const job = manager.readJob(id); if (["completed", "cancelled", "failed", "unknown"].includes(job.status)) return job; await new Promise<void>(done => setTimeout(done, 10)); }
  throw new Error("uninstall did not settle in its test budget");
}

test("G011-UN3 an uninstall says what it stops, removes and keeps, refuses what it cannot stop the product's way, needs consent for each service, and an unknown result is inspected, never rerun", async t => {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "uninstall-service-", closers), home = join(root, "home"); await mkdir(join(home, ".openclaw"), { recursive: true }); await mkdir(join(root, "data-dir"));
  const { state, port } = fakeRemoval(home); let busy = false, closed = 0;
  const users: NativeProgramUsers = { list: () => [{ sessionId: "session-a", busy }], closeIdle: async () => { closed++; return 1; } };
  const manager = new LocalHarnessManagement(join(root, "data-dir"), { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [], removal: port,
    nativeEnvironment: { home, values: { HOME: home } }, nativeLocks: new NativeInstallationLocks(join(root, "locks")) });
  closers.push(() => manager.shutdown());
  manager.attachProgramUsers(users);
  const prefix = join(home, ".nvm/versions/node/v26.0.0");
  const openclaw: InstallationObservation = { harnessId: "openclaw", controlId: "openclaw-native", ref: "c".repeat(64), role: "product", channel: "npm", name: "openclaw", root: join(prefix, "lib/node_modules/openclaw"), prefix,
    entry: join(prefix, "bin/openclaw"), resolvedPath: join(prefix, "lib/node_modules/openclaw/openclaw.mjs"), version: "2026.3.23-2", active: true, label: "npm 全局（nvm v26.0.0）" };
  const pnpm: InstallationObservation = { ...openclaw, ref: "d".repeat(64), channel: "pnpm", active: false, label: "pnpm 全局" };
  manager.setInstallations([openclaw, pnpm]);
  await assert.rejects(manager.uninstallCheck("openclaw", pnpm.ref), code("UNSUPPORTED_UNINSTALL"));

  // The gateway runs from it: stopped and unregistered with OpenClaw's own commands, once the user agrees.
  state.usage = { ...state.usage, services: [{ label: "ai.openclaw.gateway", pid: 4039 }], processes: [{ pid: 8100, name: "openclaw" }] };
  const check = await manager.uninstallCheck("openclaw", openclaw.ref);
  assert.deepEqual(check.services, [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", pid: 4039, commands: ["~/.nvm/versions/node/v26.0.0/bin/openclaw gateway stop", "~/.nvm/versions/node/v26.0.0/bin/openclaw gateway uninstall"],
    interrupts: productMaintenance("openclaw").services[0]!.interrupts }]);
  assert.deepEqual(check.commands, ["~/.nvm/versions/node/v26.0.0/bin/npm uninstall --global --prefix ~/.nvm/versions/node/v26.0.0 openclaw"]);
  // The pnpm installation, listed but not maintained, is the one used afterwards.
  assert.deepEqual(check.kept, ["~/.openclaw"]); assert.deepEqual(check.after, { kind: "next", label: "pnpm 全局", version: "2026.3.23-2" }); assert.deepEqual(check.processes, [{ pid: 8100, name: "openclaw" }]);
  assert.deepEqual(homePathsIn(check, [home]), [], "the confirmation names home paths only with ~");
  // Without consent for the gateway nothing changes; a confirmation for another state of the installation is refused.
  const refused = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-1", installation: openclaw.ref, expectedInstallationFingerprint: check.fingerprint })).id);
  assert.equal(refused.status, "failed"); assert.equal(refused.error?.code, "SERVICE_CONSENT_REQUIRED"); assert.equal(refused.native?.dispatched, false); assert.deepEqual(state.calls, []);
  state.identity = "two";
  await assert.rejects(manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-2", installation: openclaw.ref, expectedInstallationFingerprint: check.fingerprint, stopServices: ["ai.openclaw.gateway"] }), code("INSTALLATION_CHANGED"));
  state.identity = "one";
  // A conversation replying with it blocks; then idle kept processes close, the gateway stops first, and the program goes.
  busy = true;
  const blocked = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-3", installation: openclaw.ref, expectedInstallationFingerprint: check.fingerprint, stopServices: ["ai.openclaw.gateway"] })).id);
  assert.equal(blocked.error?.code, "HARNESS_BUSY"); assert.deepEqual(state.calls, []);
  busy = false;
  const done = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-4", installation: openclaw.ref, expectedInstallationFingerprint: check.fingerprint, stopServices: ["ai.openclaw.gateway"] })).id);
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(state.calls, ["stop:ai.openclaw.gateway:gateway stop,gateway uninstall", "remove"]); assert.equal(closed, 1);
  assert.deepEqual(done.native?.uninstall, { label: "npm 全局（nvm v26.0.0）", role: "product", stopServices: ["ai.openclaw.gateway"], stoppedServices: ["ai.openclaw.gateway"], removed: true });
  assert.equal(done.resolvedVersion, "2026.3.23-2"); assert.equal(done.native?.location, "~/.nvm/versions/node/v26.0.0/bin/openclaw");
  const logs = manager.logs(done.id, 0).map(entry => entry.text);
  assert.ok(logs.some(text => text.includes("仍在运行这份安装") && text.includes("openclaw（进程 8100）")));
  assert.deepEqual(logs.filter(text => text.includes(home)), [], "logs name home paths only with ~");

  // A configuration file another program writes meanwhile does not fail the uninstall: the removal cannot write it.
  state.removed = false; state.calls = []; state.usage = { ...state.usage, services: [], processes: [] }; state.drift = 1;
  const drifting = await manager.uninstallCheck("openclaw", openclaw.ref);
  const drifted = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-drift", installation: openclaw.ref, expectedInstallationFingerprint: drifting.fingerprint })).id);
  assert.equal(drifted.status, "completed", JSON.stringify(drifted.error)); state.drift = 0;
  assert.ok(manager.logs(drifted.id, 0).some(entry => entry.text.startsWith("卸载期间受保护的配置文件有了变化")));
  // A resident program or a service no product declares refuses before anything changes.
  state.removed = false; state.calls = [];
  state.usage = { ...state.usage, services: [], resident: [{ pid: 5056, name: "openclaw-gateway", stop: "openclaw gateway stop" }] };
  const resident = await manager.uninstallCheck("openclaw", openclaw.ref); assert.deepEqual(resident.resident, [{ pid: 5056, name: "openclaw-gateway", stop: "openclaw gateway stop" }]);
  const stopped = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-5", installation: openclaw.ref, expectedInstallationFingerprint: resident.fingerprint })).id);
  assert.equal(stopped.error?.code, "PROGRAM_RUNNING"); assert.match(stopped.error?.message ?? "", /openclaw gateway stop/u); assert.deepEqual(state.calls, []);
  state.usage = { ...state.usage, resident: [], services: [{ label: "com.example.unknown", pid: 77 }] };
  const unknownService = await manager.uninstallCheck("openclaw", openclaw.ref); assert.deepEqual(unknownService.undeclaredServices, [{ label: "com.example.unknown", pid: 77 }]);
  const undeclared = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-6", installation: openclaw.ref, expectedInstallationFingerprint: unknownService.fingerprint })).id);
  assert.equal(undeclared.error?.code, "SERVICE_UNDECLARED"); assert.deepEqual(state.calls, []);

  // A removal that fails after it began is unknown; inspection says what is there and settles it without rerunning.
  state.usage = { ...state.usage, services: [] }; state.failRemove = true;
  const before = await manager.uninstallCheck("openclaw", openclaw.ref);
  const failed = await settled(manager, (await manager.submitUninstall({ harnessId: "openclaw", action: "uninstall", commandId: "u-7", installation: openclaw.ref, expectedInstallationFingerprint: before.fingerprint })).id);
  assert.equal(failed.status, "unknown"); assert.equal(failed.native?.dispatched, true);
  const inspected = await manager.inspectNativeResult(failed.id);
  assert.equal(inspected.status, "failed"); assert.equal(inspected.error?.code, "NATIVE_RESULT_INSPECTED"); assert.match(inspected.error?.message ?? "", /文件仍在/u);
  assert.deepEqual(state.calls, ["remove"], "inspection reruns nothing");
});

test("G011-UN4 through the formal Gateway entry, an npm installation and a script installation are each removed by their own channel, and the user's data stays", { ...macOnly, timeout: 120000 }, async t => {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "uninstall-gateway-", closers), home = join(root, "home"), prefix = join(root, "prefix"), workspace = join(root, "workspace"), cache = join(root, "npm-cache");
  for (const directory of [home, prefix, workspace, cache]) await mkdir(directory, { recursive: true });
  // Claude Code installed by npm itself into a prefix of its own, from a local package (no network).
  const source = join(root, "package"); await file(join(source, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "9.9.8", bin: { claude: "cli.js" } }));
  await file(join(source, "cli.js"), "#!/usr/bin/env node\nconsole.log('9.9.8 (Claude Code)')\n", 0o755);
  const npmEnv = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: source, env: npmEnv, encoding: "utf8" }); assert.equal(packed.status, 0, packed.stderr);
  const tarball = join(root, packed.stdout.trim().split("\n").at(-1)!);
  const installed = spawnSync("npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", tarball], { env: npmEnv, encoding: "utf8" }); assert.equal(installed.status, 0, installed.stderr);
  // Claude Code's script installation, as its installer lays it out, and the user's data.
  await file(join(home, ".local/share/claude/versions/9.9.9"), "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", 0o755); await link(join(home, ".local/share/claude/versions/9.9.9"), join(home, ".local/bin/claude"));
  await file(join(home, ".claude/settings.json"), "{\"model\":\"keep\"}"); await file(join(home, ".claude.json"), "{\"keep\":true}");
  const secret = "sk-uninstall-test-" + "0".repeat(16);
  // Node.js for npm's own launcher, without the directory it came from (that may hold this computer's real Claude Code).
  const runtime = join(root, "runtime"); await link(process.execPath, join(runtime, "node"));
  const environment = { home, values: { HOME: home, PATH: [join(home, ".local/bin"), join(prefix, "bin"), runtime, "/usr/bin", "/bin"].join(":"), ANTHROPIC_API_KEY: secret } };
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { installations: "official", nativeEnvironment: environment, workspaceLockRoot: join(root, "locks"), management: { nativeLocks: new NativeInstallationLocks(join(root, "native-locks")) } }) });
  closers.push(() => gateway.close());
  const url = new URL(gateway.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as T };
  };
  const claude = async () => (await call<HarnessView[]>("/harnesses")).value.find(item => item.id === "claude")!;
  const until = async (id: string) => { const end = Date.now() + 60000; for (;;) { const { value } = await call<InstallationJobView>("/installation-jobs/" + id); if (["completed", "failed", "unknown", "cancelled"].includes(value.status)) return value; if (Date.now() > end) throw new Error("uninstall did not settle"); await new Promise(done => setTimeout(done, 100)); } };
  const listed = (await claude()).installations;
  assert.deepEqual(listed.map(item => [item.channel, item.version, item.active, item.canUninstall]), [["script", "9.9.9", true, true], ["npm", "9.9.8", false, true]]);

  // The npm installation, which this Gateway does not run: its own channel removes it.
  const npm = await call<UninstallCheckView>("/harnesses/claude/installations/" + listed[1]!.ref + "/uninstall"); assert.equal(npm.status, 200, JSON.stringify(npm.value));
  assert.match(npm.value.commands[0]!, new RegExp("uninstall --global --prefix " + prefix + " @anthropic-ai/claude-code$", "u"));
  assert.deepEqual(npm.value.kept, ["~/.claude", "~/.claude.json"]); assert.deepEqual(npm.value.after, { kind: "unchanged" }); assert.equal(npm.value.active, false);
  for (const value of [npm.value]) { assert.deepEqual(homePathsIn(value, [home]), []); assert.equal(JSON.stringify(value).includes(secret), false); }
  const first = await call<InstallationJobView>("/installation-jobs", { harnessId: "claude", action: "uninstall", commandId: "uninstall-npm", installation: listed[1]!.ref, expectedInstallationFingerprint: npm.value.fingerprint, stopServices: [] });
  assert.equal(first.status, 202, JSON.stringify(first.value));
  const removedNpm = await until(first.value.id); assert.equal(removedNpm.status, "completed", JSON.stringify(removedNpm.error));
  assert.equal(existsSync(join(prefix, "lib/node_modules/@anthropic-ai/claude-code")), false); await assert.rejects(lstat(join(prefix, "bin/claude")));

  // The script installation this Gateway runs: whitelisted files only; afterwards Claude Code has no installation left.
  const remaining = (await claude()).installations; assert.deepEqual(remaining.map(item => item.channel), ["script"]);
  const script = await call<UninstallCheckView>("/harnesses/claude/installations/" + remaining[0]!.ref + "/uninstall");
  assert.deepEqual(script.value.removes, ["~/.local/bin/claude", "~/.local/share/claude"]); assert.equal(script.value.documented, true); assert.deepEqual(script.value.after, { kind: "none" });
  const second = await call<InstallationJobView>("/installation-jobs", { harnessId: "claude", action: "uninstall", commandId: "uninstall-script", installation: remaining[0]!.ref, expectedInstallationFingerprint: script.value.fingerprint });
  const removedScript = await until(second.value.id); assert.equal(removedScript.status, "completed", JSON.stringify(removedScript.error));
  for (const path of [".local/bin/claude", ".local/share/claude"]) assert.equal(existsSync(join(home, path)), false, path);
  assert.equal(await readFile(join(home, ".claude/settings.json"), "utf8"), "{\"model\":\"keep\"}"); assert.equal(await readFile(join(home, ".claude.json"), "utf8"), "{\"keep\":true}");
  assert.deepEqual((await claude()).installations, []);
  const logs = (await call<{ entries: { text: string }[] }>("/installation-jobs/" + second.value.id + "/logs?limit=100")).value.entries.map(entry => entry.text);
  assert.ok(logs.includes("已删除 ~/.local/bin/claude")); assert.deepEqual(homePathsIn(logs, [home]), []);
  // Submitting the same command again returns the same task; another confirmation for a removed installation is refused.
  assert.equal((await call<InstallationJobView>("/installation-jobs", { harnessId: "claude", action: "uninstall", commandId: "uninstall-script", installation: remaining[0]!.ref, expectedInstallationFingerprint: script.value.fingerprint })).value.id, second.value.id);
  const gone = await call<{ code: string }>("/installation-jobs", { harnessId: "claude", action: "uninstall", commandId: "uninstall-again", installation: remaining[0]!.ref, expectedInstallationFingerprint: script.value.fingerprint });
  assert.equal(gone.status, 404); assert.equal(gone.value.code, "INSTALLATION_NOT_FOUND");
  void readlink; void chmod;
});

test("G011-UN5 the privacy guard finds an absolute home path in any string of a confirmation, and passes paths written with ~", () => {
  const home = "/Users/someone";
  assert.deepEqual(homePathsIn({ removes: ["~/.local/bin/claude"], commands: ["/opt/homebrew/bin/brew uninstall --cask codex"], label: "npm 全局（nvm v26.11.1）" }, [home]), []);
  for (const leak of ["/Users/someone/.local/bin/claude", "npm uninstall --global --prefix /Users/someone/.nvm/versions/node/v1 x", "HOME=/Users/someone", "cd /Users/someone && rm"])
    assert.deepEqual(homePathsIn({ nested: [{ text: leak }] }, [home]), [leak], leak);
  assert.deepEqual(homePathsIn({ [home + "/key"]: 1 }, [home]), [home + "/key"], "object keys are inspected too");
  assert.deepEqual(homePathsIn(["/Users/someone-else/x"], [home]), [], "another user's prefix is not this home");
});
