import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loginShellSetting } from "../../src/cli/web.js";
import { SessionError } from "../../src/contracts/session.js";
import { LoginShellStore, readLoginShellPath } from "../../src/infrastructure/discovery/login-shell.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";

const posixOnly = { skip: process.platform === "win32" ? "login shells are POSIX; Windows is not offered" : false };
/**
 * A login shell for tests: it accepts only `-l -c <script>` and runs the script with the PATH the test chose, after doing
 * what FIXTURE_LOGIN_MODE asks of a login configuration (print, wait, flood, leave a background task, fail).
 */
const SHELL = `#!/bin/sh
[ "$1" = "-l" ] && [ "$2" = "-c" ] || exit 9
case "$FIXTURE_LOGIN_MODE" in
  noisy) echo "welcome from the profile"; echo "__HARNESSHUB_PATH_BEGIN__ is only a word here" ;;
  slow) sleep 10 ;;
  flood) head -c 70000 /dev/zero | tr '\\0' x; echo ;;
  silent) exit 0 ;;
  fail) exit 3 ;;
  linger) (sleep 30 & echo $! > "$FIXTURE_LINGER_PID") ;;
esac
PATH="$FIXTURE_LOGIN_PATH" exec /bin/sh -c "$3"
`;
async function shellFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-login-shell-")), shell = join(root, "login-sh"), shells = join(root, "shells"), bin = join(root, "bin"), other = join(root, "other");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(shell, SHELL); await chmod(shell, 0o700); await mkdir(bin); await mkdir(other);
  await writeFile(shells, "# shells\n/bin/sh\n" + shell + "\n");
  const env = (mode: string, extra: Record<string, string> = {}) => ({ HOME: root, FIXTURE_LOGIN_MODE: mode, FIXTURE_LOGIN_PATH: [bin, "relative/bin", join(root, "missing"), bin, other, "/usr/bin"].join(":"), ...extra });
  return { root, shell, shells, bin, other, env };
}

test("the login shell's PATH is read between its markers: existing absolute directories only, once each, whatever the profile prints", posixOnly, async t => {
  const f = await shellFixture(t);
  assert.deepEqual(await readLoginShellPath(f.shell, { shells: f.shells, env: f.env("plain") }), [f.bin, f.other, "/usr/bin"]);
  assert.deepEqual(await readLoginShellPath(f.shell, { shells: f.shells, env: f.env("noisy") }), [f.bin, f.other, "/usr/bin"], "the profile's own output is ignored");
});

test("only a listed absolute shell runs; one that is slow, floods, prints no PATH or fails is refused, and its whole group has ended", posixOnly, async t => {
  const f = await shellFixture(t);
  const refused = (code: string, message: string) => (error: unknown) => error instanceof SessionError && error.code === code && error.message === message;
  await assert.rejects(readLoginShellPath("login-sh", { shells: f.shells, env: f.env("plain") }), refused("LOGIN_SHELL_UNAVAILABLE", "the login shell is no absolute path"));
  await writeFile(f.shells, "/bin/sh\n");
  await assert.rejects(readLoginShellPath(f.shell, { shells: f.shells, env: f.env("plain") }), refused("LOGIN_SHELL_UNAVAILABLE", "the login shell is not a listed shell"));
  await writeFile(f.shells, f.shell + "\n");
  const started = Date.now();
  await assert.rejects(readLoginShellPath(f.shell, { shells: f.shells, env: f.env("slow") }), refused("LOGIN_SHELL_FAILED", "the login shell took longer than 3 seconds"));
  assert.ok(Date.now() - started < 6000, "ended by its own deadline");
  await assert.rejects(readLoginShellPath(f.shell, { shells: f.shells, env: f.env("flood") }), refused("LOGIN_SHELL_FAILED", "the login shell printed more than 64 KiB"));
  await assert.rejects(readLoginShellPath(f.shell, { shells: f.shells, env: f.env("silent") }), refused("LOGIN_SHELL_FAILED", "the login shell printed no PATH"));
  await assert.rejects(readLoginShellPath(f.shell, { shells: f.shells, env: f.env("fail") }), refused("LOGIN_SHELL_FAILED", "the login shell exited with an error"));
  // A task the login configuration left in the shell's group ends with the read.
  const linger = join(f.root, "linger.pid");
  assert.deepEqual(await readLoginShellPath(f.shell, { shells: f.shells, env: f.env("linger", { FIXTURE_LINGER_PID: linger }) }), [f.bin, f.other, "/usr/bin"]);
  const pid = Number(await readFile(linger, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH");
});

test("the kept directories survive a restart, and a file this version cannot read counts as none", posixOnly, async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-login-store-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LoginShellStore(root);
  assert.equal(await store.load(), null);
  await store.save({ shell: "/bin/zsh", readAt: 1, dirs: ["/opt/tools/bin"] });
  assert.deepEqual(await new LoginShellStore(root).load(), { shell: "zsh", readAt: 1, dirs: ["/opt/tools/bin"] }, "the shell is kept by name only");
  await writeFile(join(root, "login-shell-path.json"), JSON.stringify({ version: 1, shell: "zsh", readAt: 1, dirs: ["relative"] }));
  assert.equal(await store.load(), null);
});

test("over HTTP, reading the login shell adds only new directories to discovery until the user removes them; where it is not offered it refuses", posixOnly, async t => {
  const f = await shellFixture(t), workspace = join(f.root, "workspace"), manifest = join(f.root, "catalog.json"), assets = join(f.root, "assets");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>fixture</title>");
  // A Harness whose program lives only in a directory that the login shell's PATH has and this Gateway's PATH has not.
  await writeFile(join(f.bin, "hh-login-fixture"), "#!/bin/sh\nexit 0\n"); await chmod(join(f.bin, "hh-login-fixture"), 0o755);
  await writeFile(manifest, JSON.stringify({ version: 2, overrides: {}, definitions: [{ id: "login-a", name: "Login A", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "login-a-control", protocol: "acp-v1",
    executableNames: ["hh-login-fixture"], args: [], env: {}, requiredExecutables: [], package: null, distribution: null, source: { repository: "fixture", revision: "login", upstreamId: "login", url: "https://example.invalid/login" } }] }] }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  // After hooks run in the order they were added: the data roots are removed only after both Gateways have closed.
  const data = await mkdtemp(join(tmpdir(), "harness-login-data-"));
  // The Gateway passes the shell only HOME, USER, LOGNAME, LANG and TMPDIR, so this login shell names its PATH itself.
  const shell = join(f.root, "server-login-sh");
  await writeFile(shell, `#!/bin/sh\n[ "$1" = "-l" ] && [ "$2" = "-c" ] || exit 9\nPATH="${f.bin}:${f.other}:/usr/bin" exec /bin/sh -c "$3"\n`); await chmod(shell, 0o700);
  await writeFile(f.shells, shell + "\n");
  const start = async (loginShell: Parameters<typeof startWebServer>[0]["loginShell"]) => {
    const gateway = await startWebServer({ root: join(data, loginShell === undefined ? "off" : "on"), configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: join(data, "locks"), ...(loginShell === undefined ? {} : { loginShell }) });
    t.after(() => gateway.close());
    const url = new URL(gateway.url), origin = url.origin;
    const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
    const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String(((await boot.json()) as { csrfToken: string }).csrfToken);
    const call = async (path: string, method = "GET", input?: unknown) => {
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };
    const found = async () => ((await call("/api/v1/harnesses")).data as unknown as { id: string; controls: { available: boolean }[] }[]).find(harness => harness.id === "login-a")?.controls.some(control => control.available) ?? false;
    return { call, found };
  };
  const off = await start(undefined);
  assert.deepEqual((await off.call("/api/v1/discovery/login-shell")).data, { available: false, dirs: [], readAt: null });
  const refused = await off.call("/api/v1/discovery/login-shell", "POST", { commandId: "read-off" });
  assert.equal(refused.status, 409); assert.equal(refused.data.code, "LOGIN_SHELL_UNAVAILABLE");

  const on = await start({ shell, shells: f.shells });
  assert.equal(await on.found(), false, "not found before");
  const read = await on.call("/api/v1/discovery/login-shell", "POST", { commandId: "read-on" });
  assert.equal(read.status, 200);
  // /usr/bin is already searched by this Gateway, so only the two new directories are kept.
  assert.deepEqual({ ...read.data, readAt: typeof read.data.readAt }, { available: true, shell: "server-login-sh", dirs: [f.bin, f.other], readAt: "number" });
  assert.equal(await on.found(), true, "found through the added directory");
  const removed = await on.call("/api/v1/discovery/login-shell/remove", "POST", { dir: f.bin, commandId: "remove-bin" });
  assert.deepEqual(removed.data.dirs, [f.other]);
  assert.equal(await on.found(), false, "gone with its directory");
  t.after(() => rm(data, { recursive: true, force: true }));
});

const web = fileURLToPath(new URL("../../src/cli/web.js", import.meta.url));
test("whether the login shell is offered is decided once at the web command: never with --no-login-shell, in CI or on Windows", posixOnly, async t => {
  assert.deepEqual(loginShellSetting({ off: false, env: { SHELL: "/bin/zsh" }, platform: "darwin" }), { shell: "/bin/zsh", shells: "/etc/shells" });
  assert.deepEqual(loginShellSetting({ off: false, env: {}, platform: "linux" }), { shell: null, shells: "/etc/shells" }, "no $SHELL: nothing to read");
  assert.equal(loginShellSetting({ off: true, env: { SHELL: "/bin/zsh" }, platform: "darwin" }), false);
  assert.equal(loginShellSetting({ off: false, env: { SHELL: "/bin/zsh", CI: "" }, platform: "darwin" }), false, "CI counts when set, even empty");
  assert.equal(loginShellSetting({ off: false, env: { SHELL: "/bin/zsh" }, platform: "win32" }), false);
  // The web command itself: the flag is accepted and turns the offer off; a misspelt flag is refused before anything starts.
  const root = await mkdtemp(join(tmpdir(), "harness-login-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>fixture</title>");
  await writeFile(manifest, JSON.stringify({ version: 2, overrides: {}, definitions: [] }));
  const env = { PATH: "/usr/bin:/bin", HOME: root, SHELL: "/bin/sh" };
  const misspelt = spawnSync(process.execPath, [web, "--no-login-shel", "--help"], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(misspelt.status, 1); assert.match(misspelt.stderr, /could not run/u);
  const help = spawnSync(process.execPath, [web, "--help"], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(help.status, 0); assert.match(help.stdout, /\[--no-login-shell\]/u);
  const offered = async (flags: readonly string[], data: string) => {
    const child = spawn(process.execPath, [web, "--cwd", workspace, "--data-dir", join(root, data), "--port", "0", "--manifest", manifest, "--path-only", "--assets-dir", assets, "--workspace-lock-root", join(root, "locks"), ...flags], { env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>(done => child.once("exit", code => done(code)));
    let output = "", errors = "", view: Record<string, unknown> = {}, code: number | null = null;
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    try {
      const link = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the web command printed no link")), 15000);
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); const found = /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/u.exec(output); if (found) { clearTimeout(timer); resolve(found[0]); } });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("the web command exited: " + errors)); });
      });
      const url = new URL(link), origin = url.origin;
      const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
      const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
      view = await (await fetch(origin + "/api/v1/discovery/login-shell", { headers: { Cookie: cookie, Origin: origin } })).json() as Record<string, unknown>;
    } finally { child.kill("SIGTERM"); code = await exited; }
    assert.equal(code, 0, "the web command closed cleanly");
    return view;
  };
  assert.deepEqual(await offered([], "on"), { available: true, shell: "sh", dirs: [], readAt: null });
  assert.deepEqual(await offered(["--no-login-shell"], "off"), { available: false, dirs: [], readAt: null });
  assert.ok((await stat(join(root, "locks"))).isDirectory(), "the web command uses the workspace lock root it was given");
});
