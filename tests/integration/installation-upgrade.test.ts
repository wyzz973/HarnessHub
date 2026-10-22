import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ManagementError, type InstallationJobView, type InstallationObservation, type InstallationRemovalPort, type InstallationUpgradePort, type ManagementMetadataPort, type ManagementRecipe,
  type NativeInstallPlan, type NativeManagementPort, type NativeProgramUsers } from "../../src/contracts/management.js";
import type { HarnessView, InstallationUpgradeCheckView } from "../../src/contracts/web.js";
import { application } from "../../src/cli/session-application.js";
import { NativeInstallationLocks } from "../../src/infrastructure/management/native-lock.js";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { LocalInstallationUpgrader } from "../../src/infrastructure/management/installation-upgrade.js";
import { LocalInstallationRemoval } from "../../src/infrastructure/management/uninstall.js";
import { runManagementProcess } from "../../src/infrastructure/management/process.js";
import type { runHomebrewProtected } from "../../src/infrastructure/management/homebrew.js";
import type { ProgramHost } from "../../src/infrastructure/management/program-usage.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";

const macOnly = { skip: process.platform !== "darwin" && "installation upgrades are macOS only (ADR-044)", timeout: 120000 };
const code = (expected: string) => (error: unknown): boolean => error instanceof ManagementError && error.code === expected;
async function file(path: string, text: string, mode = 0o644): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); }
async function link(target: string, path: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await symlink(target, path); }
/** A private directory removed after the test, once everything `closers` holds (a Gateway or a management service using it) has closed. */
async function temporary(t: test.TestContext, name: string, closers: (() => Promise<void>)[]): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), name)));
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); }); return root;
}
/** A host with no other programs: nothing runs any installation, and no service manager job exists. */
const quietHost: ProgramHost = { platform: "darwin", uid: 501, self: process.pid, processes: async () => "", jobs: async () => "", job: async () => null, print: async () => null,
  kickstart: async () => {}, listening: async () => "", openers: async () => "", sleep: async () => {}, now: () => Date.now() };

/**
 * A Gateway on a private home and PATH, through the formal entry; `prepare` lays out the installations and returns the
 * PATH directories and management options. It closes before its directory is removed.
 */
async function gateway(t: test.TestContext, prepare: (root: string, home: string, environment: (path: readonly string[]) => { home: string; values: Record<string, string> }) => Promise<{ readonly path: readonly string[]; readonly management: Record<string, unknown> }>) {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "installation-upgrade-", closers), home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  // Node.js for the Gateway's programs, without the directory it came from (that may hold this computer's real Harnesses).
  const runtime = join(root, "runtime"); await mkdir(runtime); await symlink(process.execPath, join(runtime, "node"));
  const environment = (path: readonly string[]) => ({ home, values: { HOME: home, SHELL: "/bin/zsh", PATH: [...path, runtime, "/usr/bin", "/bin"].join(":") } });
  const setup = await prepare(root, home, environment);
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { installations: "official", nativeEnvironment: environment(setup.path), workspaceLockRoot: join(root, "locks"),
      management: { nativeLocks: new NativeInstallationLocks(join(root, "native-locks")), ...setup.management } }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as T };
  };
  const until = async (id: string) => { const end = Date.now() + 60000; for (;;) { const { value } = await call<InstallationJobView>("/installation-jobs/" + id); if (["completed", "failed", "unknown", "cancelled"].includes(value.status)) return value; if (Date.now() > end) throw new Error("upgrade did not settle"); await new Promise(done => setTimeout(done, 100)); } };
  const harness = async (id: string) => (await call<HarnessView[]>("/harnesses")).value.find(item => item.id === id)!;
  /** Checks, confirms and settles the upgrade of the installation `ref`, as the page does. */
  const upgrade = async (id: string, ref: string, command: string) => {
    const check = await call<InstallationUpgradeCheckView>("/harnesses/" + id + "/installations/" + ref + "/upgrade"); assert.equal(check.status, 200, JSON.stringify(check.value));
    const submitted = await call<InstallationJobView>("/installation-jobs", { harnessId: id, action: "upgrade", commandId: command, installation: ref, expectedInstallationFingerprint: check.value.fingerprint });
    assert.equal(submitted.status, 202, JSON.stringify(submitted.value));
    return { check: check.value, job: await until(submitted.value.id) };
  };
  return { root, home, call, until, harness, upgrade };
}

test("G011-UG6 through the formal Gateway, an npm installation is upgraded to the exact confirmed release with its prefix's npm, and a confirmation is good for that installation once", macOnly, async t => {
  let tarball = Buffer.alloc(0);
  const registry = createServer((request, response) => {
    if (request.url?.endsWith(".tgz")) { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(tarball); return; }
    if (decodeURIComponent(request.url ?? "").includes("@deepseek-ai/dsh")) {
      const port = (registry.address() as { port: number }).port, shasum = createHash("sha1").update(tarball).digest("hex"), integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ name: "@deepseek-ai/dsh", "dist-tags": { latest: "1.1.0" }, versions: { "1.1.0": { name: "@deepseek-ai/dsh", version: "1.1.0", bin: { dsh: "cli.js" }, dist: { tarball: "http://127.0.0.1:" + port + "/dsh-1.1.0.tgz", shasum, integrity } } } })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => registry.listen(0, "127.0.0.1", done)); t.after(() => new Promise<void>(done => registry.close(() => done())));
  let latest = "1.1.0";
  const metadata: ManagementMetadataPort = { resolve: async recipe => ({ recipe, version: latest, artifactUrl: null, integrity: null, engines: {}, binNames: [recipe.binName], dependencies: [] }) };
  const f = await gateway(t, async root => {
    // Two releases as the publisher packs them; 1.0.0 installed by npm itself into a prefix of its own, without the network.
    const npmEnv = { ...process.env, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
    const pack = async (version: string) => {
      const source = join(root, "package-" + version); await file(join(source, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version, bin: { dsh: "cli.js" } }));
      await file(join(source, "cli.js"), "#!/usr/bin/env node\nconsole.log('" + version + "')\n", 0o755);
      const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: source, env: npmEnv, encoding: "utf8" }); assert.equal(packed.status, 0, packed.stderr);
      return join(root, packed.stdout.trim().split("\n").at(-1)!);
    };
    const old = await pack("1.0.0"); tarball = await readFile(await pack("1.1.0"));
    const prefix = join(root, "prefix");
    const installed = spawnSync("npm", ["install", "--global", "--prefix", prefix, "--offline", "--ignore-scripts", old], { env: npmEnv, encoding: "utf8" }); assert.equal(installed.status, 0, installed.stderr);
    return { path: [join(prefix, "bin")], management: { metadata, npmRegistry: "http://127.0.0.1:" + (registry.address() as { port: number }).port } };
  });
  const prefix = join(f.root, "prefix"), packageRoot = join(prefix, "lib/node_modules/@deepseek-ai/dsh");
  const [installation] = (await f.harness("dsh")).installations;
  assert.deepEqual([installation?.channel, installation?.version, installation?.active, installation?.upgrade], ["npm", "1.0.0", true, "version"]);
  const { check, job } = await f.upgrade("dsh", installation!.ref, "upgrade-dsh");
  assert.deepEqual([check.kind, check.current, check.target, check.prerelease, check.blocked], ["version", "1.0.0", "1.1.0", false, null]);
  assert.match(check.runs, new RegExp("install --global --prefix " + prefix + " @deepseek-ai/dsh@1\\.1\\.0$", "u")); assert.deepEqual(check.writes, [prefix]);
  assert.ok(check.notes.some(note => note.includes("当前使用的那份")), "the confirmation says the conversations use the new version from their next message");
  assert.deepEqual(homePathsIn(check, [f.home]), []);
  assert.equal(job.status, "completed", JSON.stringify(job.error)); assert.equal(job.resolvedVersion, "1.1.0"); assert.equal(job.action, "upgrade");
  assert.deepEqual([job.native?.beforeVersion, job.native?.actualVersion, job.native?.installation?.kind], ["1.0.0", "1.1.0", "version"]);
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "1.1.0");
  assert.equal((await f.harness("dsh")).installations[0]?.version, "1.1.0");
  // The same confirmation is not good twice, and an installation already at the latest release is said to be so.
  const reused = await f.call<{ code: string }>("/installation-jobs", { harnessId: "dsh", action: "upgrade", commandId: "upgrade-dsh-again", installation: installation!.ref, expectedInstallationFingerprint: check.fingerprint });
  assert.equal(reused.status, 409); assert.equal(reused.value.code, "INSTALL_CHECK_EXPIRED");
  const current = await f.call<InstallationUpgradeCheckView>("/harnesses/dsh/installations/" + installation!.ref + "/upgrade"); assert.match(current.value.blocked ?? "", /已是 npm 上的最新版本 1\.1\.0/u);
  // An installation that changed after its confirmation is not upgraded.
  latest = "1.2.0";
  const stale = await f.call<InstallationUpgradeCheckView>("/harnesses/dsh/installations/" + installation!.ref + "/upgrade"); assert.equal(stale.value.target, "1.2.0");
  await writeFile(join(packageRoot, "CHANGED"), "x");
  const changed = await f.call<{ code: string }>("/installation-jobs", { harnessId: "dsh", action: "upgrade", commandId: "upgrade-dsh-changed", installation: installation!.ref, expectedInstallationFingerprint: stale.value.fingerprint });
  assert.equal(changed.status, 409); assert.equal(changed.value.code, "INSTALLATION_CHANGED");
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "1.1.0");
});

test("G011-UG7 through the formal Gateway, a script installation that updates itself runs its own updater confined like its installer, and the versions before and after are recorded", macOnly, async t => {
  // Claude Code's script installation: `claude update` installs the next version beside it, relinks the command and records a setting.
  const version = (number: string, update: string) => "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"" + number + " (Claude Code)\"; exit 0; fi\nif [ \"$1\" = \"update\" ]; then\n" + update + "\nexit 0\nfi\nexit 2\n";
  const UPDATE = `V="$HOME/.local/share/claude/versions"
printf '%s' "$NEXT" > "$V/1.1.0"
chmod +x "$V/1.1.0"
ln -sfn "$V/1.1.0" "$HOME/.local/bin/claude"
printf '{"numStartups":1,"autoUpdates":false}' > "$HOME/.claude.json"
echo "# claude" >> "$HOME/.zshrc" || true
echo "Successfully updated from 1.0.0 to version 1.1.0"`;
  const f = await gateway(t, async (_root, home) => {
    const next = version("1.1.0", "echo \"Claude Code is up to date (1.1.0)\"");
    await file(join(home, ".local/share/claude/versions/1.0.0"), version("1.0.0", "NEXT=$(cat <<'NEXT_VERSION'\n" + next + "NEXT_VERSION\n)\n" + UPDATE), 0o755);
    await link(join(home, ".local/share/claude/versions/1.0.0"), join(home, ".local/bin/claude"));
    await file(join(home, ".claude.json"), "{\"numStartups\":1}");
    return { path: [join(home, ".local/bin")], management: {} };
  });
  const [installation] = (await f.harness("claude")).installations;
  assert.deepEqual([installation?.channel, installation?.version, installation?.upgrade], ["script", "1.0.0", "self-update"]);
  const { check, job } = await f.upgrade("claude", installation!.ref, "update-claude");
  assert.deepEqual([check.kind, check.current, check.target, check.runs, check.blocked], ["self-update", "1.0.0", null, "claude update", null]);
  assert.deepEqual(check.writes, ["~/.local/bin", "~/.local/share/claude", "~/.claude/downloads"]); assert.deepEqual(check.configFiles, ["~/.claude.json"]);
  assert.ok(check.notes.some(note => note.includes("由 claude update 自己决定")));
  assert.equal(job.status, "completed", JSON.stringify(job.error)); assert.equal(job.resolvedVersion, "1.1.0"); assert.equal(job.native?.beforeVersion, "1.0.0");
  assert.deepEqual(job.native?.installation?.configChanges, [{ file: "~/.claude.json", keys: [{ path: "autoUpdates", value: "false" }] }]);
  assert.deepEqual(job.native?.installation?.blocked, ["~/.zshrc"], "the write it was not allowed is named, and it was blocked");
  assert.equal(existsSync(join(f.home, ".zshrc")), false); assert.equal(await readlink(join(f.home, ".local/bin/claude")), join(f.home, ".local/share/claude/versions/1.1.0"));
  // Run again on the latest version, the updater changes nothing and the task says so.
  const [updated] = (await f.harness("claude")).installations;
  const again = await f.upgrade("claude", updated!.ref, "update-claude-again");
  assert.equal(again.job.status, "completed", JSON.stringify(again.job.error)); assert.deepEqual([again.job.native?.beforeVersion, again.job.resolvedVersion], ["1.1.0", "1.1.0"]);
  const logs = (await f.call<{ entries: { text: string }[] }>("/installation-jobs/" + again.job.id + "/logs?afterSeq=0&limit=100")).value.entries.map(entry => entry.text);
  assert.ok(logs.some(text => text.startsWith("已是最新")), logs.join("\n"));
});

test("G011-UG8 through the formal Gateway, a script installation without an updater runs its official script again as the confirmed copy, and a changed copy does not run", macOnly, async t => {
  const SCRIPT = `#!/bin/bash
set -e
[ "$1" = "--no-modify-path" ] || { echo "expected --no-modify-path" >&2; exit 4; }
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\\necho "1.1.0"\\n' > "$HOME/.opencode/bin/opencode"; chmod +x "$HOME/.opencode/bin/opencode"
`;
  const routes: Record<string, () => Response> = {
    "https://opencode.ai/install": () => new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/v1/install" } }),
    "https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/v1/install": () => new Response(SCRIPT),
  };
  const fetcher = (async (input: URL | RequestInfo) => routes[String(input)]?.() ?? new Response("not found", { status: 404 })) as typeof fetch;
  const f = await gateway(t, async (_root, home, environment) => {
    await file(join(home, ".opencode/bin/opencode"), "#!/bin/sh\necho \"1.0.0\"\n", 0o755);
    const path = [join(home, ".opencode/bin")];
    return { path, management: { installationUpgrader: new LocalInstallationUpgrader(environment(path), { npm: null }, { fetch: fetcher }) } };
  });
  const [installation] = (await f.harness("opencode")).installations;
  assert.deepEqual([installation?.channel, installation?.version, installation?.upgrade], ["script", null, "rerun"]);
  // A copy changed on disk after the user saw its SHA-256 does not run, and nothing changes.
  const first = await f.call<InstallationUpgradeCheckView>("/harnesses/opencode/installations/" + installation!.ref + "/upgrade"); assert.equal(first.status, 200, JSON.stringify(first.value));
  const checks = join(f.root, "data", "management", "install-checks"), [prepared] = await readdir(checks);
  await writeFile(join(checks, prepared!, "install.bash"), "#!/bin/bash\ntouch \"$HOME/tampered\"\n");
  const tampered = await f.until((await f.call<InstallationJobView>("/installation-jobs", { harnessId: "opencode", action: "upgrade", commandId: "rerun-tampered", installation: installation!.ref, expectedInstallationFingerprint: first.value.fingerprint })).value.id);
  assert.equal(tampered.status, "failed"); assert.equal(tampered.error?.code, "INSTALL_SOURCE_CHANGED"); assert.equal(tampered.native?.dispatched, false); assert.equal(existsSync(join(f.home, "tampered")), false);
  const { check, job } = await f.upgrade("opencode", installation!.ref, "rerun-opencode");
  assert.deepEqual([check.kind, check.current, check.target, check.runs, check.shellProfile], ["rerun", "1.0.0", null, "bash install.bash --no-modify-path", null]);
  assert.deepEqual(check.script, { source: "https://raw.githubusercontent.com/anomalyco/opencode/refs/heads/v1/install", sha256: createHash("sha256").update(SCRIPT).digest("hex") });
  assert.ok(check.notes.some(note => note.includes("官网命令 curl -fsSL https://opencode.ai/install | bash")));
  assert.equal(job.status, "completed", JSON.stringify(job.error)); assert.deepEqual([job.native?.beforeVersion, job.resolvedVersion], ["1.0.0", "1.1.0"]); assert.deepEqual(job.native?.installation?.shellChanges, []);
});

/** Homebrew as this test plays it: its queries read the prefix, its dry run prints `plan.txt` (and changes the prefix when told to), and its upgrade installs 0.46.0. */
const BREW = `#!/bin/bash
set -e
PREFIX="$(cd "$(dirname "$0")/.." && pwd -P)"
case "$1" in
  info) echo '{"formulae":[{"name":"gemini-cli","versions":{"stable":"0.46.0"},"revision":0}],"casks":[]}' ;;
  list) cd "$PREFIX/Cellar"; for name in *; do echo "$name $(ls "$name" | tr '\\n' ' ')"; done ;;
  upgrade)
    if [ "$2" = "--dry-run" ]; then
      if [ -f "$PREFIX/tamper" ]; then mkdir -p "$PREFIX/Cellar/tampered/1.0"; fi
      cat "$PREFIX/plan.txt"; exit 0
    fi
    mkdir -p "$PREFIX/Cellar/gemini-cli/0.46.0/bin" "$PREFIX/Cellar/node/25.0.0/bin"
    printf '#!/bin/sh\\necho 0.46.0\\n' > "$PREFIX/Cellar/gemini-cli/0.46.0/bin/gemini"; chmod +x "$PREFIX/Cellar/gemini-cli/0.46.0/bin/gemini"
    ln -sfn "$PREFIX/Cellar/gemini-cli/0.46.0/bin/gemini" "$PREFIX/bin/gemini"
    echo "==> Upgrading gemini-cli 0.38.2 -> 0.46.0" ;;
  *) exit 2 ;;
esac
`;
const PLAN = `==> Would upgrade 1 dependency:
node 24.1.0 -> 25.0.0
==> Would upgrade 1 requested outdated package
gemini-cli 0.38.2 -> 0.46.0 (21.8MB)
==> 1 Deprecated or disabled package
gemini-cli (deprecated)
`;

test("G011-UG9 a Homebrew installation is upgraded from the local records after a dry run that lists what else changes; a dry run that changed a package, or a plan that changed since, stops it", macOnly, async t => {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "upgrade-homebrew-", closers), home = join(root, "home"), brew = join(root, "brew"), cache = join(root, "brew-cache");
  await file(join(brew, "bin/brew"), BREW, 0o755); await file(join(brew, "plan.txt"), PLAN);
  await file(join(brew, "Cellar/gemini-cli/0.38.2/bin/gemini"), "#!/bin/sh\necho 0.38.2\n", 0o755); await link(join(brew, "Cellar/gemini-cli/0.38.2/bin/gemini"), join(brew, "bin/gemini"));
  await mkdir(join(brew, "Cellar/node/24.1.0/bin"), { recursive: true });
  // Homebrew's local records, last updated on 2026-10-12.
  await file(join(cache, "api/internal/packages.arm64_golden_gate.jws.json"), "{}"); await utimes(join(cache, "api/internal/packages.arm64_golden_gate.jws.json"), new Date("2026-10-12T14:40:00Z"), new Date("2026-10-12T14:40:00Z"));
  await mkdir(home); await mkdir(join(root, "data"));
  const source = { home, values: { HOME: home, PATH: [join(brew, "bin"), "/usr/bin", "/bin"].join(":"), HOMEBREW_CACHE: cache } };
  // Homebrew's own sandbox needs the real Homebrew; this one runs the stand-in directly.
  const homebrew: typeof runHomebrewProtected = async (manager, args, _directories, _files, env, context) => runManagementProcess(manager, args, context.stage, env, context);
  const manager = new LocalHarnessManagement(join(root, "data"), { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [], nativeEnvironment: source,
    removal: new LocalInstallationRemoval(source, { npm: null, uv: null }, quietHost), installationUpgrader: new LocalInstallationUpgrader(source, { npm: null }, { homebrew }),
    nativeLocks: new NativeInstallationLocks(join(root, "locks")) });
  closers.push(() => manager.shutdown());
  const gemini: InstallationObservation = { harnessId: "gemini", controlId: "gemini-acp", ref: "b".repeat(64), role: "product", channel: "brew-formula", name: "gemini-cli", root: join(brew, "Cellar/gemini-cli"), prefix: brew,
    entry: join(brew, "bin/gemini"), resolvedPath: join(brew, "Cellar/gemini-cli/0.38.2/bin/gemini"), version: "0.38.2", active: true, label: "Homebrew" };
  manager.setInstallations([gemini]);
  // An update check reads Homebrew's local records.
  await manager.checkUpdates(["gemini"]);
  assert.deepEqual(manager.installationUpgrade("gemini", gemini.ref), { kind: "version", update: { ref: gemini.ref, latest: "0.46.0", source: "homebrew-local", checkedAt: manager.installationUpgrade("gemini", gemini.ref)!.update!.checkedAt, error: null } });
  const check = await manager.upgradeCheck("gemini", gemini.ref);
  assert.deepEqual([check.kind, check.current, check.target, check.runs, check.blocked], ["version", "0.38.2", "0.46.0", "brew upgrade --formula gemini-cli", null]);
  assert.deepEqual(check.dependencies, ["升级 node 24.1.0 → 25.0.0"]); assert.deepEqual(check.sharedRuntimes, ["升级 node 24.1.0 → 25.0.0"]);
  for (const text of ["更新于 2026-10-12", "没有运行 brew update", "预演由 Homebrew 在它的沙箱里运行", "Homebrew 把 gemini-cli 标为已弃用或停用。", "Antigravity"])
    assert.ok(check.notes.some(note => note.includes(text)), text + " in " + check.notes.join(" | "));
  // A dry run that changed an installed package is not trusted further: the check stops, and says how to look.
  await writeFile(join(brew, "tamper"), "");
  await assert.rejects(manager.upgradeCheck("gemini", gemini.ref), code("HOMEBREW_DRY_RUN_CHANGED"));
  await rm(join(brew, "tamper")); await rm(join(brew, "Cellar/tampered"), { recursive: true });
  // A plan that changed after the confirmation (another package to upgrade along) stops the upgrade before it changes anything.
  const confirmed = await manager.upgradeCheck("gemini", gemini.ref);
  await writeFile(join(brew, "plan.txt"), PLAN.replace("node 24.1.0 -> 25.0.0", "node 24.1.0 -> 25.0.0\nicu4c@78 78.1 -> 78.2"));
  const settle = async (id: string) => { const end = Date.now() + 30000; for (;;) { const job = manager.readJob(id); if (["completed", "failed", "unknown", "cancelled"].includes(job.status)) return job; if (Date.now() > end) throw new Error("did not settle"); await new Promise(done => setTimeout(done, 20)); } };
  const changed = await settle((await manager.submitInstallationUpgrade({ harnessId: "gemini", action: "upgrade", commandId: "brew-changed", installation: gemini.ref, expectedInstallationFingerprint: confirmed.fingerprint })).id);
  assert.equal(changed.status, "failed"); assert.equal(changed.error?.code, "HOMEBREW_PLAN_CHANGED"); assert.equal(changed.native?.dispatched, false);
  assert.equal(existsSync(join(brew, "Cellar/gemini-cli/0.46.0")), false);
  await writeFile(join(brew, "plan.txt"), PLAN);
  const ready = await manager.upgradeCheck("gemini", gemini.ref);
  const done = await settle((await manager.submitInstallationUpgrade({ harnessId: "gemini", action: "upgrade", commandId: "brew-upgrade", installation: gemini.ref, expectedInstallationFingerprint: ready.fingerprint })).id);
  assert.equal(done.status, "completed", JSON.stringify(done.error)); assert.deepEqual([done.native?.beforeVersion, done.resolvedVersion], ["0.38.2", "0.46.0"]);
  assert.deepEqual(done.native?.installation?.dependencies, ["升级 node 24.1.0 → 25.0.0"]); assert.equal(done.native?.installation?.command, "brew upgrade --formula gemini-cli");
  assert.equal(await realpath(join(brew, "bin/gemini")), join(brew, "Cellar/gemini-cli/0.46.0/bin/gemini"));
});

/**
 * Homebrew with two formulae named opencode, as on 2026-10-22: its own (OpenCode 2, 2.1.2) and anomalyco/tap's (OpenCode 1,
 * 1.19.3). Each command answers for the name it is given; the dry run and the upgrade (run outside its sandbox here) log
 * their arguments, and the upgrade installs whichever formula it was asked for.
 */
const TAPPED_BREW = `#!/bin/bash
set -e
PREFIX="$(cd "$(dirname "$0")/.." && pwd -P)"
target() { if [ "$1" = "anomalyco/tap/opencode" ]; then echo 1.19.3; else echo 2.1.2; fi; }
case "$1" in
  info) echo '{"formulae":[{"name":"opencode","full_name":"'"$4"'","versions":{"stable":"'"$(target "$4")"'"},"revision":0}],"casks":[]}' ;;
  list) cd "$PREFIX/Cellar"; for name in *; do echo "$name $(ls "$name" | tr '\\n' ' ')"; done ;;
  upgrade)
    echo "$*" >> "$PREFIX/brew-args.log"
    if [ "$2" = "--dry-run" ]; then printf '==> Would upgrade 1 requested outdated package\\n%s 1.18.35 -> %s (31.2MB)\\n==> 1 Deprecated or disabled package\\n%s (deprecated)\\n' "$4" "$(target "$4")" "$4"; exit 0; fi
    V="$(target "$3")"; mkdir -p "$PREFIX/Cellar/opencode/$V/bin"
    printf '#!/bin/sh\\necho %s\\n' "$V" > "$PREFIX/Cellar/opencode/$V/bin/opencode"; chmod +x "$PREFIX/Cellar/opencode/$V/bin/opencode"
    ln -sfn "$PREFIX/Cellar/opencode/$V/bin/opencode" "$PREFIX/bin/opencode"
    echo "==> Upgrading $3" ;;
  *) exit 2 ;;
esac
`;

test("G011-UG9 a formula from another tap is checked, planned and upgraded by its full name, so Homebrew's own formula of that name is never taken for it; Homebrew's own tap keeps the bare name", macOnly, async t => {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "upgrade-homebrew-tap-", closers), home = join(root, "home"), brew = join(root, "brew"), keg = join(brew, "Cellar/opencode/1.18.35");
  await file(join(brew, "bin/brew"), TAPPED_BREW, 0o755);
  await file(join(keg, "bin/opencode"), "#!/bin/sh\necho 1.18.35\n", 0o755); await link(join(keg, "bin/opencode"), join(brew, "bin/opencode"));
  await mkdir(home); await mkdir(join(root, "data"));
  const receipt = (tap: string) => file(join(keg, "INSTALL_RECEIPT.json"), JSON.stringify({ homebrew_version: "5.1.0", installed_on_request: true, source: { tap, spec: "stable", versions: { stable: "1.18.35" } } }));
  const source = { home, values: { HOME: home, PATH: [join(brew, "bin"), "/usr/bin", "/bin"].join(":"), HOMEBREW_CACHE: join(root, "brew-cache") } };
  const homebrew: typeof runHomebrewProtected = async (manager, args, _directories, _files, env, context) => runManagementProcess(manager, args, context.stage, env, context);
  const manager = new LocalHarnessManagement(join(root, "data"), { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [], nativeEnvironment: source,
    removal: new LocalInstallationRemoval(source, { npm: null, uv: null }, quietHost), installationUpgrader: new LocalInstallationUpgrader(source, { npm: null }, { homebrew }),
    nativeLocks: new NativeInstallationLocks(join(root, "locks")) });
  closers.push(() => manager.shutdown());
  const opencode: InstallationObservation = { harnessId: "opencode", controlId: "opencode", ref: "a".repeat(64), role: "product", channel: "brew-formula", name: "opencode", root: join(brew, "Cellar/opencode"), prefix: brew,
    entry: join(brew, "bin/opencode"), resolvedPath: join(keg, "bin/opencode"), version: "1.18.35", active: true, label: "Homebrew" };
  manager.setInstallations([opencode]);
  const latest = async () => { await manager.checkUpdates(["opencode"]); return manager.installationUpgrade("opencode", opencode.ref)?.update?.latest; };
  const logged = async () => (await readFile(join(brew, "brew-args.log"), "utf8")).trim().split("\n");
  // A keg without a receipt, or one Homebrew's own tap installed, is named by its bare name, as before.
  assert.equal(await latest(), "2.1.2");
  await receipt("homebrew/core");
  assert.equal(await latest(), "2.1.2");
  const core = await manager.upgradeCheck("opencode", opencode.ref);
  assert.deepEqual([core.runs, core.target, core.dependencies], ["brew upgrade --formula opencode", "2.1.2", []]);
  // The keg anomalyco/tap installed: every Homebrew command names it in full, and its plan entry is the one upgraded.
  await receipt("anomalyco/tap");
  assert.equal(await latest(), "1.19.3", "the update check reads the tap's formula, not Homebrew's own OpenCode 2");
  const check = await manager.upgradeCheck("opencode", opencode.ref);
  assert.deepEqual([check.kind, check.current, check.target, check.runs, check.dependencies, check.blocked], ["version", "1.18.35", "1.19.3", "brew upgrade --formula anomalyco/tap/opencode", [], null]);
  // Homebrew marks the formula deprecated under the full name it was given; the confirmation still says it is this installation.
  assert.ok(check.notes.some(note => note.startsWith("Homebrew 把 opencode 标为已弃用或停用。")), check.notes.join(" | "));
  const settle = async (id: string) => { const end = Date.now() + 30000; for (;;) { const job = manager.readJob(id); if (["completed", "failed", "unknown", "cancelled"].includes(job.status)) return job; if (Date.now() > end) throw new Error("did not settle"); await new Promise(done => setTimeout(done, 20)); } };
  const done = await settle((await manager.submitInstallationUpgrade({ harnessId: "opencode", action: "upgrade", commandId: "brew-tap", installation: opencode.ref, expectedInstallationFingerprint: check.fingerprint })).id);
  assert.equal(done.status, "completed", JSON.stringify(done.error)); assert.deepEqual([done.native?.beforeVersion, done.resolvedVersion], ["1.18.35", "1.19.3"]);
  assert.equal(done.native?.installation?.command, "brew upgrade --formula anomalyco/tap/opencode");
  assert.deepEqual(await logged(), ["upgrade --dry-run --formula opencode", "upgrade --dry-run --formula anomalyco/tap/opencode", "upgrade --dry-run --formula anomalyco/tap/opencode", "upgrade --formula anomalyco/tap/opencode"],
    "the confirmation's dry run, the dry run read again before the upgrade, and the upgrade itself name the tap's formula");
  assert.equal(await realpath(join(brew, "bin/opencode")), join(brew, "Cellar/opencode/1.19.3/bin/opencode"));
  assert.equal(existsSync(join(brew, "Cellar/opencode/2.1.2")), false, "Homebrew's own OpenCode 2 was never installed in its place");
});

/** A removal port whose usage is what the test sets; nothing is removed by it. */
function usageOnly() {
  const state = { identity: "one", localChanges: null as number | null,
    usage: { servicesKnown: true, services: [] as { label: string; pid: number }[], resident: [] as { pid: number; name: string; stop?: string }[], processes: [] as { pid: number; name: string }[], own: [] as { pid: number; name: string }[] } };
  const port: InstallationRemovalPort = { identity: async () => state.identity, preview: async () => assert.fail("no removal"), usage: async () => state.usage, remains: async () => true,
    localChanges: async () => state.localChanges, stopService: async () => assert.fail("no service is stopped"), remove: async () => assert.fail("no removal"), configuration: async () => "unchanged" };
  return { state, port };
}
/** An upgrader that changes nothing on the host: it records runs, and its versions are what the test sets. */
function scriptedUpgrader() {
  const state = { version: "1.0.0" as string | null, latest: "1.1.0", runs: 0, lose: false };
  const port: InstallationUpgradePort = {
    kind: target => target.harnessId === "hermes" ? "terminal" : target.channel === "npm" ? "version" : null,
    latest: async () => ({ version: state.latest, source: "npm" }),
    prepare: async target => ({ prepared: { target, kind: "version", command: join(target.prefix!, "bin/npm") + " install --global --prefix " + target.prefix + " " + target.name + "@" + state.latest, executable: join(target.prefix!, "bin/npm"),
      args: ["install", target.name + "@" + state.latest], env: {}, writes: [target.prefix!], shellProfile: null, configFiles: [], version: state.latest, dependencies: [], script: null, runtime: null }, deprecated: [], records: null }),
    run: async (_prepared, context) => { context.beginMutation(); state.runs++; if (state.lose) throw new ManagementError("PROCESS_START_FAILED", "the updater was lost"); state.version = state.latest; return { exitCode: 0, facts: { shellChanges: [], configChanges: [], blocked: [] } }; },
    version: async () => state.version,
  };
  return { state, port };
}

test("G011-UG10 a conversation replying with the installation blocks its upgrade and idle kept processes close first; its services refuse it; an unknown result is inspected, never rerun; Hermes is shown for the terminal; ADR-043 owns a product with services", macOnly, async t => {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "upgrade-service-", closers), home = join(root, "home"); await mkdir(home); await mkdir(join(root, "data")); await mkdir(join(root, "data-native"));
  const removal = usageOnly(), upgrader = scriptedUpgrader(); let busy = true, closed = 0;
  const users: NativeProgramUsers = { list: () => [{ sessionId: "session-a", busy }], closeIdle: async () => { closed++; return 1; } };
  const manager = new LocalHarnessManagement(join(root, "data"), { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [], removal: removal.port, installationUpgrader: upgrader.port,
    nativeEnvironment: { home, values: { HOME: home } }, nativeLocks: new NativeInstallationLocks(join(root, "locks")) });
  closers.push(() => manager.shutdown());
  manager.attachProgramUsers(users);
  const prefix = join(home, ".nvm/versions/node/v26.0.0");
  const pi: InstallationObservation = { harnessId: "pi", controlId: "pi-native", ref: "c".repeat(64), role: "product", channel: "npm", name: "@earendil-works/pi-coding-agent", root: join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent"),
    prefix, entry: join(prefix, "bin/pi"), resolvedPath: join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), version: "1.0.0", active: true, label: "npm 全局（nvm v26.0.0）" };
  const hermes: InstallationObservation = { harnessId: "hermes", controlId: "hermes-acp", ref: "d".repeat(64), role: "product", channel: "script", name: ".hermes/hermes-agent", root: join(home, ".hermes/hermes-agent"), prefix: null,
    entry: join(home, ".local/bin/hermes"), resolvedPath: join(home, ".local/bin/hermes"), version: "0.12.0", active: true, label: "官方安装脚本" };
  manager.setInstallations([pi, hermes]);
  const settle = async (id: string) => { const end = Date.now() + 5000; for (;;) { const job = manager.readJob(id); if (["completed", "failed", "unknown", "cancelled"].includes(job.status)) return job; if (Date.now() > end) throw new Error("did not settle"); await new Promise(done => setTimeout(done, 10)); } };
  const submit = async (command: string) => settle((await manager.submitInstallationUpgrade({ harnessId: "pi", action: "upgrade", commandId: command, installation: pi.ref, expectedInstallationFingerprint: (await manager.upgradeCheck("pi", pi.ref)).fingerprint })).id);

  // HarnessHub's own process runs it: a conversation replying with it blocks, in the confirmation and again in the task.
  removal.state.usage = { ...removal.state.usage, own: [{ pid: 7100, name: "pi" }], processes: [{ pid: 8100, name: "pi" }] };
  const blockedCheck = await manager.upgradeCheck("pi", pi.ref);
  assert.match(blockedCheck.blocked ?? "", /1 个 HarnessHub 对话正在使用这份安装/u); assert.deepEqual(blockedCheck.conversations, [{ sessionId: "session-a", busy: true }]);
  assert.deepEqual(blockedCheck.processes, [{ pid: 8100, name: "pi" }]); assert.deepEqual(homePathsIn(blockedCheck, [home]), []);
  const refused = await submit("pi-busy"); assert.equal(refused.error?.code, "HARNESS_BUSY"); assert.equal(refused.native?.dispatched, false); assert.equal(upgrader.state.runs, 0);
  // Idle, its kept process closes first, then the upgrade runs and the new version is read.
  busy = false;
  const done = await submit("pi-idle");
  assert.equal(done.status, "completed", JSON.stringify(done.error)); assert.deepEqual([done.native?.beforeVersion, done.resolvedVersion, done.native?.closedConversations], ["1.0.0", "1.1.0", 1]); assert.equal(closed, 1);
  assert.ok(manager.logs(done.id, 0).some(entry => entry.text.includes("1.0.0 → 1.1.0")));
  assert.ok(manager.logs(done.id, 0).some(entry => entry.text.includes("不会被关闭") && entry.text.includes("pi（进程 8100）")));
  // No process of HarnessHub's runs it: conversations are not consulted and nothing is closed.
  removal.state.usage = { ...removal.state.usage, own: [], processes: [] }; upgrader.state.latest = "1.2.0";
  assert.deepEqual((await manager.upgradeCheck("pi", pi.ref)).conversations, []);
  assert.equal((await submit("pi-alone")).status, "completed"); assert.equal(closed, 1);
  // The latest version already: said, and nothing can be confirmed.
  assert.match((await manager.upgradeCheck("pi", pi.ref)).blocked ?? "", /已是 npm 上的最新版本 1\.2\.0/u);
  // A service running from it refuses the upgrade before anything changes.
  upgrader.state.latest = "1.3.0"; removal.state.usage = { ...removal.state.usage, services: [{ label: "com.example.pi", pid: 9 }] };
  assert.match((await manager.upgradeCheck("pi", pi.ref)).blocked ?? "", /后台服务 com\.example\.pi/u);
  const service = await submit("pi-service"); assert.equal(service.error?.code, "SERVICE_RUNNING"); assert.equal(service.native?.dispatched, false);
  removal.state.usage = { ...removal.state.usage, services: [] };
  // An updater lost after it began leaves the result unknown; inspection reads the version and settles it without rerunning.
  upgrader.state.lose = true; const runs = upgrader.state.runs;
  const lost = await submit("pi-lost"); assert.equal(lost.status, "unknown"); assert.equal(lost.native?.dispatched, true);
  const inspected = await manager.inspectNativeResult(lost.id);
  assert.equal(inspected.status, "failed"); assert.equal(inspected.error?.code, "NATIVE_RESULT_INSPECTED"); assert.match(inspected.error?.message ?? "", /现在是 1\.2\.0/u); assert.equal(upgrader.state.runs, runs + 1, "inspection reruns nothing");
  upgrader.state.lose = false;

  // Hermes updates only by its own command in a terminal; its uncommitted changes are said, and nothing can be confirmed.
  removal.state.localChanges = 3;
  const terminal = await manager.upgradeCheck("hermes", hermes.ref);
  assert.equal(terminal.kind, "terminal"); assert.equal(terminal.terminal?.command, "hermes update --yes"); assert.equal(terminal.terminal?.localChanges, 3);
  assert.match(terminal.terminal?.explains ?? "", /git stash/u); assert.ok(terminal.notes.some(note => note.includes("3 处没有提交的改动"))); assert.notEqual(terminal.blocked, null);
  // What v0.22's updater does to the gateway and to the data an older release could not read again, and the backup to take first.
  for (const text of ["暂停这份安装的所有网关", "以新代码重启网关", "~/.hermes/state.db 之后就不能退回旧版本", "/discard", "hermes backup"]) assert.ok(terminal.terminal?.explains.includes(text), text);
  await assert.rejects(manager.submitInstallationUpgrade({ harnessId: "hermes", action: "upgrade", commandId: "hermes", installation: hermes.ref, expectedInstallationFingerprint: terminal.fingerprint }), code("INSTALL_CHECK_EXPIRED"));

  // A product with services whose control runs from this installation is upgraded by ADR-043, which restarts them; another installation of it is not.
  const openclawPrefix = join(home, ".nvm/versions/node/v24.0.0"), otherPrefix = join(root, "homebrew");
  const openclaw: InstallationObservation = { harnessId: "openclaw", controlId: "openclaw-native", ref: "e".repeat(64), role: "product", channel: "npm", name: "openclaw", root: join(openclawPrefix, "lib/node_modules/openclaw"), prefix: openclawPrefix,
    entry: join(openclawPrefix, "bin/openclaw"), resolvedPath: join(openclawPrefix, "lib/node_modules/openclaw/openclaw.mjs"), version: "2026.3.23-2", active: true, label: "npm 全局（nvm v24.0.0）" };
  const other: InstallationObservation = { ...openclaw, ref: "f".repeat(64), root: join(otherPrefix, "lib/node_modules/openclaw"), prefix: otherPrefix, entry: join(otherPrefix, "bin/openclaw"),
    resolvedPath: join(otherPrefix, "lib/node_modules/openclaw/openclaw.mjs"), active: false, label: "npm 全局（Homebrew 的 Node.js）" };
  const recipe: ManagementRecipe = { harnessId: "openclaw", controlId: "openclaw-native", kind: "npm", packageName: "openclaw", referenceVersion: "latest", binName: "openclaw", args: ["acp"], archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] };
  const plan: Omit<NativeInstallPlan, "fingerprint"> = { harnessId: "openclaw", controlId: "openclaw-native", channel: "npm", manager: "/usr/bin/false", prefix: openclawPrefix, reference: "openclaw", entry: openclaw.entry, actualEntry: openclaw.resolvedPath, beforeVersion: "2026.3.23-2", reason: null };
  const native = { describe: async () => ({ ...plan, fingerprint: "0".repeat(64) }) } as unknown as NativeManagementPort;
  const owned = new LocalHarnessManagement(join(root, "data-native"), { installationMode: "native", native, assertOwner: () => {}, ownerGeneration: 1, recipes: [recipe], removal: removal.port, installationUpgrader: upgrader.port,
    nativeEnvironment: { home, values: { HOME: home } }, nativeLocks: new NativeInstallationLocks(join(root, "locks-native")) });
  closers.push(() => owned.shutdown());
  owned.setSystemObservations([{ harnessId: "openclaw", controlId: "openclaw-native", command: { executable: openclaw.entry, args: ["acp"], env: {} } }]);
  await owned.refreshNativeCapabilities();
  owned.setInstallations([openclaw, other]);
  assert.equal(owned.installationUpgrade("openclaw", openclaw.ref)?.kind, "maintenance");
  await assert.rejects(owned.upgradeCheck("openclaw", openclaw.ref), code("UNSUPPORTED_UPGRADE"));
  assert.equal(owned.installationUpgrade("openclaw", other.ref)?.kind, "version");
});

test("G011-UG10 an OpenClaw npm installation is offered for upgrade but its check says OpenClaw upgrades through its own openclaw update, before any release is looked up", macOnly, async t => {
  const closers: (() => Promise<void>)[] = [];
  const root = await temporary(t, "upgrade-openclaw-", closers), home = join(root, "home"); await mkdir(home); await mkdir(join(root, "data"));
  const prefix = join(home, ".nvm/versions/node/v26.0.0"), packageRoot = join(prefix, "lib/node_modules/openclaw");
  await file(join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.3.23-2", bin: { openclaw: "openclaw.mjs" } }));
  await file(join(packageRoot, "openclaw.mjs"), "#!/bin/sh\necho 2026.3.23-2\n", 0o755); await link(join(packageRoot, "openclaw.mjs"), join(prefix, "bin/openclaw"));
  const source = { home, values: { HOME: home, PATH: [join(prefix, "bin"), "/usr/bin", "/bin"].join(":") } };
  const metadata: ManagementMetadataPort = { resolve: async () => assert.fail("OpenClaw's release is never looked up for an npm upgrade") };
  const manager = new LocalHarnessManagement(join(root, "data"), { installationMode: "private-fixture", assertOwner: () => {}, ownerGeneration: 1, recipes: [], nativeEnvironment: source,
    removal: new LocalInstallationRemoval(source, { npm: null, uv: null }, quietHost), installationUpgrader: new LocalInstallationUpgrader(source, { npm: null }, { metadata }),
    nativeLocks: new NativeInstallationLocks(join(root, "locks")) });
  closers.push(() => manager.shutdown());
  const openclaw: InstallationObservation = { harnessId: "openclaw", controlId: "openclaw-native", ref: "b".repeat(64), role: "product", channel: "npm", name: "openclaw", root: packageRoot, prefix,
    entry: join(prefix, "bin/openclaw"), resolvedPath: join(packageRoot, "openclaw.mjs"), version: "2026.3.23-2", active: true, label: "npm 全局（nvm v26.0.0）" };
  manager.setInstallations([openclaw]);
  // The page offers it, and the check explains instead of running anything (ADR-052, until its updater is wired in).
  assert.equal(manager.installationUpgrade("openclaw", openclaw.ref)?.kind, "version");
  await assert.rejects(manager.upgradeCheck("openclaw", openclaw.ref), (error: unknown) => error instanceof ManagementError && error.code === "UNSUPPORTED_UPGRADE"
    && error.message.includes("openclaw update") && error.message.includes("ADR-052"));
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "2026.3.23-2");
  assert.deepEqual(await readdir(join(root, "data", "management", "install-checks")).catch(() => []), [], "no prepared check is left behind");
});
