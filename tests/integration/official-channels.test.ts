import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../../src/web/server.js";
import { application } from "../../src/cli/session-application.js";
import { DirectorySessionBindingFactory, prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import type { InstallationPolicy } from "../../src/contexts/catalog/domain/catalog.js";
import type { HarnessView } from "../../src/contracts/web.js";

/**
 * Pi installed from npm under an nvm Node.js version (an official channel), with source checkouts of Pi and of DeepSeek
 * Harness linked onto PATH ahead of it, the way a developer's machine looks. Nothing here is run.
 */
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "official-channels-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), bin = join(root, "bin"), source = join(root, "checkouts"), workspace = join(root, "workspace");
  const prefix = join(home, ".nvm", "versions", "node", "v26.0.0"), pkg = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  for (const directory of [join(pkg, "dist"), join(prefix, "bin"), bin, source, workspace]) await mkdir(directory, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0", bin: { pi: "dist/cli.js" } }));
  await writeFile(join(pkg, "dist", "cli.js"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  await symlink("../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", join(prefix, "bin", "pi"));
  for (const name of ["pi", "dsh"]) {
    await writeFile(join(source, name + ".js"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    await symlink(join(source, name + ".js"), join(bin, name));
  }
  const environment = { home, values: { HOME: home, PATH: bin + ":" + join(prefix, "bin") } };
  const configuration = await prepareConfiguration({ workspace, pathOnly: true });
  return { root, environment, configuration, closers };
}

/** The Harness list of a Gateway started on its own data directory `data-<name>` (by default the policy's name). */
async function harnesses(f: Awaited<ReturnType<typeof fixture>>, installations: InstallationPolicy, name: string = installations): Promise<readonly HarnessView[]> {
  const gateway = await startWebServer({ root: join(f.root, "data-" + name), configuration: f.configuration, port: 0,
    application: (data, publish) => application(data, publish, { nativeEnvironment: f.environment, installations, management: { installationMode: "private-fixture" }, workspaceLockRoot: join(f.root, "locks") }) });
  f.closers.push(() => gateway.close());
  const url = new URL(gateway.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const response = await fetch(origin + "/api/v1/harnesses", { headers: { Cookie: boot.headers.get("set-cookie")!.split(";", 1)[0]!, Origin: origin } });
  assert.equal(response.status, 200);
  return await response.json() as HarnessView[];
}

test("G012-OC3 the Harness list counts only official installations, lists each one without its path, and notes a non-official one on PATH (ADR-044)", { timeout: 30000 }, async t => {
  const f = await fixture(t), list = await harnesses(f, "official");
  const pi = list.find(item => item.id === "pi")!, dsh = list.find(item => item.id === "dsh")!;
  // Pi: the npm installation is used although the source checkout comes first on PATH. This fixture maintains nothing, so it offers no upgrade.
  assert.equal(pi.installed, true);
  assert.deepEqual(pi.installations.map(({ ref, ...rest }) => { assert.match(ref, /^[a-f0-9]{64}$/u); return rest; }),
    [{ channel: "npm", label: "npm 全局（nvm v26.0.0）", command: "pi", version: "1.3.0", role: "product", active: true, maintained: true, canUninstall: true, upgrade: null, latest: null }]);
  assert.deepEqual(pi.unofficial, { command: "pi", onPath: true, pathDefault: true });
  assert.equal(pi.controls.find(control => control.id === "pi-native")?.available, true);
  // DeepSeek Harness: only a source checkout, so it is not installed; its official way to install is offered.
  assert.equal(dsh.installed, false); assert.deepEqual(dsh.installations, []);
  assert.deepEqual(dsh.unofficial, { command: "dsh", onPath: true, pathDefault: true });
  assert.equal(dsh.install?.command, "npm install -g @deepseek-ai/dsh"); assert.equal(dsh.management.source, "missing");
  assert.ok(dsh.controls.every(control => !control.available));
  // Every product HarnessHub runs offers its official way to install.
  for (const id of ["claude", "codex", "opencode", "openclaw", "gemini", "cursor", "pi", "hermes", "dsh"]) assert.ok(list.find(item => item.id === id)?.install, id);
  for (const item of list) assert.equal(JSON.stringify([item.installations, item.unofficial]).includes(f.root), false, item.id);
});

test("G012-OC3 a new conversation binds only an official installation; development allows any entry", { timeout: 30000 }, async t => {
  const f = await fixture(t), leases = new SqliteWorkspaceLeaseProvider(join(f.root, "leases"));
  const official = new DirectorySessionBindingFactory(leases, () => {}, "official", undefined, undefined, f.environment);
  assert.equal((await official.validate({ harnessId: "pi" }, f.configuration)).controlId, "pi-native");
  await assert.rejects(official.validate({ harnessId: "dsh" }, f.configuration), /no available control/u);
  const any = new DirectorySessionBindingFactory(leases, () => {}, "any", undefined, undefined, f.environment);
  assert.equal((await any.validate({ harnessId: "dsh" }, f.configuration)).controlId, "dsh-native");
  // Under development the PATH-first entry is used again, and it is listed as an entry outside every channel.
  const list = await harnesses(f, "any"), pi = list.find(item => item.id === "pi")!;
  assert.deepEqual(pi.installations.map(item => [item.channel, item.active, item.label]), [[null, true, "开发入口（非官网安装）"], ["npm", false, "npm 全局（nvm v26.0.0）"]]);
  assert.equal(pi.unofficial, null);
});

test("G012-OC3 Hermes installed by its v0.22 installer is an official installation with the version its checkout's stamp names; a launcher without the checkout's program is not", { timeout: 30000 }, async t => {
  const f = await fixture(t), home = f.environment.home, checkout = join(home, ".hermes", "hermes-agent"), launchers = join(home, ".local", "bin");
  // As v0.22.4's installer leaves it (hermes_cli/_launchers.py): the checkout's launcher, its stamp, and ~/.local/bin/hermes exec'ing it.
  await mkdir(join(checkout, ".hermes", "bin"), { recursive: true }); await mkdir(launchers, { recursive: true });
  await writeFile(join(checkout, ".hermes", "bin", "hermes"), "#!/bin/sh\nexec /usr/bin/false -I -c 'import sys' \"$@\"\n", { mode: 0o755 });
  await writeFile(join(checkout, "install-stamp.json"), JSON.stringify({ schemaVersion: 2, commit: "4d04303818b61bf3aa09278af48356315515965b", baseVersion: "0.22.4", displayVersion: "0.22.4", source: "git" }));
  await writeFile(join(launchers, "hermes"), "#!/bin/sh\nexec " + join(checkout, ".hermes", "bin", "hermes") + " \"$@\"\n", { mode: 0o755 });
  f.environment.values.PATH = launchers + ":" + f.environment.values.PATH;
  const hermes = (await harnesses(f, "official", "hermes-v22")).find(item => item.id === "hermes")!;
  assert.equal(hermes.installed, true);
  assert.deepEqual(hermes.installations.map(item => [item.channel, item.label, item.command, item.version, item.active, item.canUninstall]), [["script", "官方安装脚本", "hermes", "0.22.4", true, true]]);
  assert.equal(hermes.unofficial, null);
  // Without the checkout's program the same launcher starts nothing of an official installation.
  await rm(join(checkout, ".hermes"), { recursive: true });
  const missing = (await harnesses(f, "official", "hermes-missing")).find(item => item.id === "hermes")!;
  assert.equal(missing.installed, false); assert.deepEqual(missing.installations, []);
  assert.deepEqual(missing.unofficial, { command: "hermes", onPath: true, pathDefault: true });
});
