import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { InstallationJobView, ManagementMetadataPort } from "../../src/contracts/management.js";
import type { HarnessView, InstallCheckView } from "../../src/contracts/web.js";
import { application } from "../../src/cli/session-application.js";
import { NativeInstallationLocks } from "../../src/infrastructure/management/native-lock.js";
import { LocalOfficialInstaller } from "../../src/infrastructure/management/official-install.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";

const macOnly = { skip: process.platform !== "darwin" && "official installs are macOS only (ADR-044)", timeout: 120000 };
async function file(path: string, text: string, mode = 0o644): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); }

/**
 * A Gateway on a private home and PATH, through the formal entry, with the given installer and management options; it
 * closes before its directory is removed.
 */
async function gateway(t: test.TestContext, prepare: (root: string, home: string) => Promise<{ readonly path: readonly string[]; readonly management: Record<string, unknown> }>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "official-install-"))), home = join(root, "home"), workspace = join(root, "workspace"), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(home); await mkdir(workspace);
  // Node.js for the Gateway's programs, without the directory it came from (that may hold this computer's real Harnesses).
  const runtime = join(root, "runtime"); await mkdir(runtime); await symlink(process.execPath, join(runtime, "node"));
  const setup = await prepare(root, home);
  const environment = { home, values: { HOME: home, SHELL: "/bin/zsh", PATH: [...setup.path, runtime, "/usr/bin", "/bin"].join(":") } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { installations: "official", nativeEnvironment: environment, workspaceLockRoot: join(root, "locks"),
      management: { nativeLocks: new NativeInstallationLocks(join(root, "native-locks")), ...setup.management } }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as T };
  };
  const until = async (id: string) => { const end = Date.now() + 60000; for (;;) { const { value } = await call<InstallationJobView>("/installation-jobs/" + id); if (["completed", "failed", "unknown", "cancelled"].includes(value.status)) return value; if (Date.now() > end) throw new Error("install did not settle"); await new Promise(done => setTimeout(done, 100)); } };
  const harness = async (id: string) => (await call<HarnessView[]>("/harnesses")).value.find(item => item.id === id)!;
  return { root, home, call, until, harness };
}
/** The official Claude Code installer, as this test serves it: what the real one writes, and one write it is not allowed. */
const CLAUDE_INSTALLER = `#!/bin/bash
set -e
mkdir -p "$HOME/.local/share/claude/versions" "$HOME/.local/bin" "$HOME/.claude/downloads"
printf '#!/bin/sh\\necho "9.9.9 (Claude Code)"\\n' > "$HOME/.local/share/claude/versions/9.9.9"
chmod +x "$HOME/.local/share/claude/versions/9.9.9"
ln -sf "$HOME/.local/share/claude/versions/9.9.9" "$HOME/.local/bin/claude"
printf '{"numStartups":1,"installMethod":"native"}' > "$HOME/.claude.json"
echo "# claude" >> "$HOME/.zshrc" || true
echo "Installation complete"
`;
function scripted(script: string, redirectTo = "https://downloads.claude.ai/claude-code-releases/bootstrap.sh"): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url === "https://claude.ai/install.sh") return new Response(null, { status: 302, headers: { location: redirectTo } });
    if (url === "https://downloads.claude.ai/claude-code-releases/bootstrap.sh") return new Response(script);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("G011-IN5 a missing product is installed by its official script as the confirmed copy, writing only where it may, and the change to its own configuration is recorded by key", macOnly, async t => {
  let installer: LocalOfficialInstaller | undefined;
  const f = await gateway(t, async (_root, home) => {
    await file(join(home, ".claude.json"), "{\"numStartups\":1}");
    installer = new LocalOfficialInstaller({ home, values: { HOME: home, SHELL: "/bin/zsh", PATH: [join(home, ".local/bin"), "/usr/bin", "/bin"].join(":") } }, { npm: null }, { fetch: scripted(CLAUDE_INSTALLER) });
    return { path: [join(home, ".local/bin")], management: { officialInstaller: installer } };
  });
  const before = await f.harness("claude");
  assert.deepEqual([before.installed, before.install?.method, before.install?.available], [false, "script", true]);
  const check = await f.call<InstallCheckView>("/harnesses/claude/install"); assert.equal(check.status, 200, JSON.stringify(check.value));
  assert.equal(check.value.source, "https://downloads.claude.ai/claude-code-releases/bootstrap.sh"); assert.equal(check.value.sha256, createHash("sha256").update(CLAUDE_INSTALLER).digest("hex"));
  assert.deepEqual(check.value.writes, ["~/.local/bin", "~/.local/share/claude", "~/.claude/downloads"]); assert.deepEqual(check.value.configFiles, ["~/.claude.json"]);
  assert.equal(check.value.shellProfile, null); assert.equal(check.value.blocked, null);
  assert.deepEqual(check.value.terminal, { command: "claude", before: null, after: "this" });
  assert.deepEqual(homePathsIn(check.value, [f.home]), [], "the confirmation names home paths only with ~");
  const submitted = await f.call<InstallationJobView>("/installation-jobs", { harnessId: "claude", action: "install", commandId: "install-claude", expectedInstallFingerprint: check.value.fingerprint });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.value));
  const done = await f.until(submitted.value.id);
  assert.equal(done.status, "completed", JSON.stringify(done.error)); assert.equal(done.resolvedVersion, "9.9.9");
  assert.deepEqual(done.native?.official?.configChanges, [{ file: "~/.claude.json", keys: [{ path: "installMethod", value: "\"native\"" }] }]);
  assert.deepEqual(done.native?.official?.blocked, ["~/.zshrc"], "the write it was not allowed is named, and it was blocked");
  assert.equal(existsSync(join(f.home, ".zshrc")), false);
  const after = await f.harness("claude");
  assert.deepEqual(after.installations.map(item => [item.channel, item.version, item.active]), [["script", "9.9.9", true]]);
  // A product that has an official installation is not installed a second time.
  const again = await f.call<InstallCheckView>("/harnesses/claude/install"); assert.match(again.value.blocked ?? "", /不再安装第二份/u);
  const reused = await f.call<{ code: string }>("/installation-jobs", { harnessId: "claude", action: "install", commandId: "install-claude-2", expectedInstallFingerprint: again.value.fingerprint });
  assert.equal(reused.status, 409); assert.equal(reused.value.code, "INSTALLATION_CHANGED");
  // Submitting the same command again returns the same task.
  assert.equal((await f.call<InstallationJobView>("/installation-jobs", { harnessId: "claude", action: "install", commandId: "install-claude", expectedInstallFingerprint: check.value.fingerprint })).value.id, submitted.value.id);
});

test("G011-IN6 a script that redirects elsewhere is not downloaded, a copy changed after the confirmation does not run, and an unknown confirmation is refused", macOnly, async t => {
  let redirect = "https://evil.example/install.sh";
  const f = await gateway(t, async (_root, home) => ({ path: [join(home, ".local/bin")], management: { officialInstaller: new LocalOfficialInstaller({ home, values: { HOME: home, PATH: join(home, ".local/bin") + ":/usr/bin:/bin" } }, { npm: null },
    { fetch: (async (input: URL | RequestInfo) => scripted(CLAUDE_INSTALLER, redirect)(input)) as typeof fetch }) } }));
  const refused = await f.call<{ code: string; message: string }>("/harnesses/claude/install");
  assert.equal(refused.status, 409); assert.equal(refused.value.code, "INSTALL_SOURCE_REFUSED"); assert.match(refused.value.message, /evil\.example/u);
  redirect = "https://downloads.claude.ai/claude-code-releases/bootstrap.sh";
  const check = await f.call<InstallCheckView>("/harnesses/claude/install"); assert.equal(check.status, 200);
  // The prepared copy is changed on disk after the user saw its SHA-256: nothing runs.
  const checks = join(f.root, "data", "management", "install-checks"), [prepared] = await readdir(checks);
  await writeFile(join(checks, prepared!, "install.bash"), "#!/bin/bash\ntouch \"$HOME/tampered\"\n");
  const submitted = await f.call<InstallationJobView>("/installation-jobs", { harnessId: "claude", action: "install", commandId: "install-tampered", expectedInstallFingerprint: check.value.fingerprint });
  const done = await f.until(submitted.value.id);
  assert.equal(done.status, "failed"); assert.equal(done.error?.code, "INSTALL_SOURCE_CHANGED"); assert.equal(done.native?.dispatched, false);
  assert.equal(existsSync(join(f.home, "tampered")), false); assert.equal(existsSync(join(f.home, ".local/bin/claude")), false);
  const unknown = await f.call<{ code: string }>("/installation-jobs", { harnessId: "claude", action: "install", commandId: "install-unknown", expectedInstallFingerprint: "e".repeat(64) });
  assert.equal(unknown.status, 409); assert.equal(unknown.value.code, "INSTALL_CHECK_EXPIRED");
});

test("G011-IN7 an npm product is installed as the exact confirmed release into the prefix of the first Node.js on PATH, and a Node.js below its range blocks it", macOnly, async t => {
  let tarball = Buffer.alloc(0), engines: Record<string, string> = { node: ">=18" };
  const registry = createServer((request, response) => {
    if (request.url?.endsWith(".tgz")) { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(tarball); return; }
    if (decodeURIComponent(request.url ?? "").includes("@deepseek-ai/dsh")) {
      const port = (registry.address() as { port: number }).port, shasum = createHash("sha1").update(tarball).digest("hex"), integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ name: "@deepseek-ai/dsh", "dist-tags": { latest: "9.9.7" }, versions: { "9.9.7": { name: "@deepseek-ai/dsh", version: "9.9.7", bin: { dsh: "cli.js" }, dist: { tarball: "http://127.0.0.1:" + port + "/dsh-9.9.7.tgz", shasum, integrity } } } })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => registry.listen(0, "127.0.0.1", done)); t.after(() => new Promise<void>(done => registry.close(() => done())));
  const metadata: ManagementMetadataPort = { resolve: async recipe => ({ recipe, version: "9.9.7", artifactUrl: null, integrity: null, engines, binNames: [recipe.binName], dependencies: [] }) };
  const f = await gateway(t, async root => {
    // The package as its publisher packs it, and a prefix whose bin holds the first Node.js on PATH.
    const source = join(root, "package"); await file(join(source, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.7", bin: { dsh: "cli.js" } }));
    await file(join(source, "cli.js"), "#!/usr/bin/env node\nconsole.log('9.9.7')\n", 0o755);
    const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", root], { cwd: source, env: { ...process.env, npm_config_cache: join(root, "npm-cache") }, encoding: "utf8" }); assert.equal(packed.status, 0, packed.stderr);
    tarball = await readFile(join(root, packed.stdout.trim().split("\n").at(-1)!));
    const prefix = join(root, "prefix"); await mkdir(join(prefix, "bin"), { recursive: true }); await symlink(process.execPath, join(prefix, "bin", "node"));
    return { path: [join(prefix, "bin")], management: { metadata, npmRegistry: "http://127.0.0.1:" + (registry.address() as { port: number }).port } };
  });
  const prefix = join(f.root, "prefix");
  assert.deepEqual([(await f.harness("dsh")).install?.method, (await f.harness("dsh")).install?.available], ["npm", true]);
  const check = await f.call<InstallCheckView>("/harnesses/dsh/install"); assert.equal(check.status, 200, JSON.stringify(check.value));
  assert.equal(check.value.version, "9.9.7"); assert.deepEqual(check.value.prefix, { label: "其他 npm 前缀", path: prefix }); assert.equal(check.value.runtime?.satisfied, true);
  assert.match(check.value.runs, new RegExp("install --global --prefix " + prefix + " @deepseek-ai/dsh@9\\.9\\.7$", "u"));
  assert.deepEqual(check.value.terminal, { command: "dsh", before: null, after: "this" }); assert.ok(check.value.notes.some(note => note.includes("~/.dsh")));
  const done = await f.until((await f.call<InstallationJobView>("/installation-jobs", { harnessId: "dsh", action: "install", commandId: "install-dsh", expectedInstallFingerprint: check.value.fingerprint })).value.id);
  assert.equal(done.status, "completed", JSON.stringify(done.error)); assert.equal(done.resolvedVersion, "9.9.7"); assert.equal(done.native?.official?.source, "@deepseek-ai/dsh@9.9.7");
  assert.equal(JSON.parse(await readFile(join(prefix, "lib/node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version, "9.9.7");
  const installed = await f.harness("dsh"); assert.equal(installed.installed, true);
  assert.deepEqual(installed.installations.map(item => [item.channel, item.version, item.active]), [["npm", "9.9.7", true]]);
  // A release whose Node.js range the prefix's Node.js does not meet: said in the confirmation, and refused before anything runs.
  engines = { node: ">=999" };
  const pi = await f.call<InstallCheckView>("/harnesses/pi/install"); assert.match(pi.value.blocked ?? "", /要求 Node\.js >=999/u); assert.equal(pi.value.runtime?.satisfied, false);
  const refused = await f.call<{ code: string }>("/installation-jobs", { harnessId: "pi", action: "install", commandId: "install-pi", expectedInstallFingerprint: pi.value.fingerprint });
  assert.equal(refused.status, 409); assert.equal(refused.value.code, "RUNTIME_INCOMPATIBLE"); assert.equal(existsSync(join(prefix, "lib/node_modules/@earendil-works")), false);
});

test("G011-IN8 an installer that adds itself to the user's shell may change only the startup file it picks, and the lines it added are listed; one that is told not to gets its arguments", macOnly, async t => {
  const CODEX = `#!/bin/sh
set -eu
[ "\${CODEX_NON_INTERACTIVE:-}" = "1" ] || { echo "would ask" >&2; exit 3; }
mkdir -p "$HOME/.codex/packages/standalone/releases/1.0.0/bin" "$HOME/.local/bin"
printf '#!/bin/sh\\necho "codex-cli 1.0.0"\\n' > "$HOME/.codex/packages/standalone/releases/1.0.0/bin/codex"
chmod +x "$HOME/.codex/packages/standalone/releases/1.0.0/bin/codex"
ln -sf "$HOME/.codex/packages/standalone/releases/1.0.0/bin/codex" "$HOME/.local/bin/codex"
printf '\\n# >>> Codex installer >>>\\nexport PATH="%s/.local/bin:$PATH"\\n# <<< Codex installer <<<\\n' "$HOME" >> "$HOME/.zprofile"
echo "model = 'changed'" > "$HOME/.codex/config.toml" || true
`;
  // As OpenCode 2's installer behaves (https://opencode.ai/v2/install, read 2026-11-01): the program and the opencode2 shim beside it.
  const OPENCODE = `#!/bin/bash
set -e
[ "$1" = "--no-modify-path" ] || { echo "expected --no-modify-path" >&2; exit 4; }
mkdir -p "$HOME/.opencode/bin"
printf '#!/bin/sh\\necho "2.2.5"\\n' > "$HOME/.opencode/bin/opencode"; chmod +x "$HOME/.opencode/bin/opencode"
printf '#!/bin/sh\\nexec "$(dirname "$0")/opencode" "$@"\\n' > "$HOME/.opencode/bin/opencode2"; chmod +x "$HOME/.opencode/bin/opencode2"
`;
  const routes: Record<string, () => Response> = {
    "https://chatgpt.com/codex/install.sh": () => new Response(null, { status: 302, headers: { location: "https://releases.openai.com/codex/install.sh" } }),
    "https://releases.openai.com/codex/install.sh": () => new Response(CODEX),
    // OpenCode 2's installer is served by opencode.ai itself (the V1 address redirected to raw.githubusercontent.com).
    "https://opencode.ai/v2/install": () => new Response(OPENCODE),
  };
  const fetcher = (async (input: URL | RequestInfo) => routes[String(input)]?.() ?? new Response("not found", { status: 404 })) as typeof fetch;
  const f = await gateway(t, async (_root, home) => {
    await file(join(home, ".zprofile"), "export LANG=en_US.UTF-8\n"); await file(join(home, ".codex/config.toml"), "model = 'mine'\n");
    return { path: [join(home, ".local/bin")], management: { officialInstaller: new LocalOfficialInstaller({ home, values: { HOME: home, SHELL: "/bin/zsh", PATH: join(home, ".local/bin") + ":/usr/bin:/bin" } }, { npm: null }, { fetch: fetcher }) } };
  });
  const codex = await f.call<InstallCheckView>("/harnesses/codex/install"); assert.equal(codex.status, 200, JSON.stringify(codex.value));
  assert.equal(codex.value.shellProfile, "~/.zprofile"); assert.match(codex.value.runs, /^CODEX_NON_INTERACTIVE=1 sh install\.sh$/u);
  const installed = await f.until((await f.call<InstallationJobView>("/installation-jobs", { harnessId: "codex", action: "install", commandId: "install-codex", expectedInstallFingerprint: codex.value.fingerprint })).value.id);
  assert.equal(installed.status, "completed", JSON.stringify(installed.error)); assert.equal(installed.resolvedVersion, "1.0.0");
  assert.deepEqual(installed.native?.official?.shellChanges, [{ file: "~/.zprofile", added: ["# >>> Codex installer >>>", "export PATH=\"~/.local/bin:$PATH\"", "# <<< Codex installer <<<"], removed: [] }]);
  assert.deepEqual(installed.native?.official?.blocked, ["~/.codex/config.toml"]);
  assert.equal(await readFile(join(f.home, ".codex/config.toml"), "utf8"), "model = 'mine'\n", "the user's configuration is not written");
  // OpenCode is told not to change the shell; its directory is not on PATH, which the confirmation says.
  const opencode = await f.call<InstallCheckView>("/harnesses/opencode/install");
  assert.equal(opencode.value.shellProfile, null); assert.deepEqual(opencode.value.terminal, { command: "opencode", before: null, after: "not-on-path" });
  assert.ok(opencode.value.notes.some(note => note.includes("~/.opencode/bin")));
  const done = await f.until((await f.call<InstallationJobView>("/installation-jobs", { harnessId: "opencode", action: "install", commandId: "install-opencode", expectedInstallFingerprint: opencode.value.fingerprint })).value.id);
  assert.equal(done.status, "completed", JSON.stringify(done.error)); assert.equal(done.resolvedVersion, "2.2.5"); assert.deepEqual(done.native?.official?.shellChanges, []);
  assert.equal(await readFile(join(f.home, ".zprofile"), "utf8").then(text => text.includes(".opencode")), false);
});
