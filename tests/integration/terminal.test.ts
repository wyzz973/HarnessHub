import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
interface Fixture { root: string; workspace: string; gateway: WebServer; origin: string; token: string; cookie: string; csrf: string }

/** A Gateway with one fixture Harness, whose terminals run zsh with a home of their own (the user's profile stays out). */
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-terminal-")), workspace = join(root, "workspace"), home = join(root, "home"), manifest = join(root, "catalog.json");
  await mkdir(workspace); await mkdir(home);
  // An empty profile: zsh neither offers its new-user setup nor reads the user's own.
  await writeFile(join(home, ".zshrc"), "");
  const source = { repository: "fixture", revision: "terminal", upstreamId: "peer", url: "https://example.invalid/terminal-peer" };
  const definitions = [{ id: "web-a", name: "Web a", aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "web-a-control", protocol: "acp-v1", executableNames: ["fixture-peer"], args: [peer, "acp-v1", "a", "basic"], env: {}, requiredExecutables: [], package: null, distribution: null, source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "web-a-control": { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const gateway = await startWebServer({ installations: "any", root: join(root, "data"), configuration, port: 0, workspaceLockRoot: join(root, "locks"),
    terminal: { shell: "/bin/zsh", env: { HOME: home, ZDOTDIR: home } },
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) });
  const parsed = new URL(gateway.url), f: Fixture = { root, workspace: configuration.workspace, gateway, origin: parsed.origin, token: new URLSearchParams(parsed.hash.slice(1)).get("token")!, cookie: "", csrf: "" };
  t.after(async () => { await f.gateway.close(); await rm(root, { recursive: true, force: true }); });
  const boot = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
  assert.equal(boot.status, 200);
  f.cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!; f.csrf = String((await boot.json() as Record<string, unknown>).csrfToken);
  return f;
}
async function create(f: Fixture): Promise<string> {
  const response = await fetch(f.origin + "/api/v1/sessions", { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, "Content-Type": "application/json", "X-CSRF-Token": f.csrf },
    body: JSON.stringify({ selection: { harnessId: "web-a" }, commandId: "create-terminal" }) });
  const text = await response.text(); assert.equal(response.status, 201, text);
  return String(((JSON.parse(text) as Record<string, unknown>).head as Record<string, unknown>).id);
}
function terminalUrl(f: Fixture, id: string, query = "?cols=100&rows=30"): string { return f.origin.replace(/^http/u, "ws") + "/api/v1/sessions/" + id + "/terminal" + query; }

interface Terminal { readonly socket: WebSocket; output(): string; readonly exited: Promise<number | null>; readonly closed: Promise<void>; send(frame: unknown): void; until(pattern: RegExp, ms?: number): Promise<RegExpMatchArray> }
/** A page's end of a terminal: every frame must be `output` or `exit`, and `exit` comes once, last. */
async function connect(f: Fixture, id: string, query?: string): Promise<Terminal> {
  const socket = new WebSocket(terminalUrl(f, id, query), { headers: { Cookie: f.cookie, Origin: f.origin } });
  let text = "", exit: ((code: number | null) => void) | undefined, exitedOnce = false;
  const waiting = new Set<() => void>();
  const exited = new Promise<number | null>(done => { exit = done; });
  const closed = new Promise<void>(done => socket.once("close", () => done()));
  socket.on("message", (data, binary) => {
    assert.equal(binary, false, "frames are text");
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    assert.equal(exitedOnce, false, "nothing follows the exit");
    if (frame.type === "output") { assert.equal(typeof frame.data, "string"); text += frame.data as string; }
    else if (frame.type === "exit") { exitedOnce = true; assert.ok(frame.code === null || typeof frame.code === "number"); exit!(frame.code as number | null); }
    else assert.fail("unexpected frame " + String(frame.type));
    for (const check of [...waiting]) check();
  });
  await new Promise<void>((done, reject) => { socket.once("open", () => done()); socket.once("error", reject); });
  return { socket, exited, closed, output: () => text, send: frame => socket.send(JSON.stringify(frame)),
    until: (pattern, ms = 10_000) => new Promise((done, reject) => {
      const check = () => { const match = pattern.exec(text); if (match !== null) { waiting.delete(check); clearTimeout(timer); done(match); } };
      const timer = setTimeout(() => { waiting.delete(check); reject(new Error("terminal never printed " + String(pattern) + "; it printed: " + JSON.stringify(text.slice(-2000)))); }, ms);
      waiting.add(check); check();
    }) };
}
/** The status a refused upgrade is answered with. */
function refusal(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((done, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => { done(response.statusCode ?? 0); response.resume(); socket.terminate(); });
    socket.once("open", () => { socket.terminate(); reject(new Error("the terminal was opened")); });
    socket.once("error", () => { /* the refused handshake */ });
  });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function gone(pid: number, ms = 8000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await delay(50)) if (!alive(pid)) return true;
  return !alive(pid);
}

test("a conversation's terminal is the user's login shell in its workspace: input, output, resize, UTF-8 and exit", async t => {
  const f = await fixture(t), id = await create(f);
  const terminal = await connect(f, id);
  terminal.send({ type: "input", data: "echo hello-$((1+2))\n" });
  await terminal.until(/hello-3/u);
  terminal.send({ type: "input", data: "echo \"cwd=$PWD term=$TERM\"; [[ -o login ]] && echo login-shell\n" });
  // The command line itself is echoed too: only the expanded words match.
  const where = await terminal.until(/cwd=(\/\S+) term=([a-z0-9-]+)/u);
  assert.equal(where[1], f.workspace); assert.equal(where[2], "xterm-256color");
  await terminal.until(/login-shell/u);
  // The first size is the one the URL asked for; a resize is what `stty size` reads next.
  terminal.send({ type: "input", data: "stty size\n" });
  await terminal.until(/30 100/u);
  terminal.send({ type: "resize", cols: 132, rows: 43 });
  terminal.send({ type: "input", data: "stty size\n" });
  await terminal.until(/43 132/u);
  // A character whose bytes come in two reads arrives whole.
  terminal.send({ type: "input", data: "printf '\\344\\270'; sleep 0.3; printf '\\255-split\\n'\n" });
  await terminal.until(/中-split/u);
  assert.equal(terminal.output().includes("�"), false, "no character is broken");
  // Frames the shell does not understand are ignored, and the shell goes on.
  terminal.socket.send("not json"); terminal.send({ type: "unknown" }); terminal.send({ type: "resize", cols: 0, rows: 5 });
  terminal.send({ type: "input", data: "echo still-$((2*3))\n" });
  await terminal.until(/still-6/u);
  terminal.send({ type: "input", data: "exit 7\n" });
  assert.equal(await terminal.exited, 7);
  await terminal.closed;
});

test("a terminal opens only with the login and from the Gateway's own page, and only for a conversation that is there", async t => {
  const f = await fixture(t), id = await create(f), url = terminalUrl(f, id);
  assert.equal(await refusal(url, { Origin: f.origin }), 401, "no login");
  assert.equal(await refusal(url, { Origin: f.origin, Cookie: "harnessgateway_session=" + "0".repeat(64) }), 401, "an unknown login");
  assert.equal(await refusal(url, { Cookie: f.cookie }), 403, "no Origin");
  assert.equal(await refusal(url, { Cookie: f.cookie, Origin: "http://evil.example" }), 403, "another site");
  assert.equal(await refusal(url, { Cookie: f.cookie, Origin: f.origin.replace("127.0.0.1", "localhost") }), 403, "another name for this computer");
  assert.equal(await refusal(terminalUrl(f, "session-" + "f".repeat(24)), { Cookie: f.cookie, Origin: f.origin }), 404, "no such conversation");
  assert.equal(await refusal(terminalUrl(f, id, "?cols=0&rows=30"), { Cookie: f.cookie, Origin: f.origin }), 400, "a size a terminal cannot have");
  assert.equal(await refusal(terminalUrl(f, id, "?cols=80&rows=24&shell=sh"), { Cookie: f.cookie, Origin: f.origin }), 400, "an unknown parameter");
  assert.equal(await refusal(f.origin.replace(/^http/u, "ws") + "/api/v1/state", { Cookie: f.cookie, Origin: f.origin }), 404, "no other route upgrades");
  // With all of it, it opens.
  const terminal = await connect(f, id);
  terminal.send({ type: "input", data: "exit\n" });
  assert.equal(await terminal.exited, 0);
});

test("a terminal whose page leaves is hung up on, its jobs with it", async t => {
  const f = await fixture(t), id = await create(f);
  const terminal = await connect(f, id);
  terminal.send({ type: "input", data: "sleep 300 & echo pids=$$,$!\n" });
  const [, shell, job] = (await terminal.until(/pids=(\d+),(\d+)/u)).map(Number) as [number, number, number];
  assert.ok(alive(shell) && alive(job));
  terminal.socket.terminate();
  assert.ok(await gone(shell), "the shell has ended");
  assert.ok(await gone(job), "its job has ended");
});

test("a shell that floods a slow page waits for it, and the page gets every byte", async t => {
  const f = await fixture(t), id = await create(f), bytes = 32 * 1024 * 1024, marker = join(f.workspace, "flood-done");
  const terminal = await connect(f, id);
  terminal.send({ type: "input", data: "echo ready-$((1+1))\n" });
  await terminal.until(/ready-2/u);
  terminal.socket.pause();
  // \121 is Q: the command line itself holds none.
  terminal.send({ type: "input", data: `head -c ${bytes} /dev/zero | LC_ALL=C tr '\\0' '\\121'; touch flood-done\n` });
  await delay(2500);
  assert.equal(existsSync(marker), false, "while the page reads nothing, the shell's writes wait");
  terminal.socket.resume();
  for (const deadline = Date.now() + 60_000; !existsSync(marker) && Date.now() < deadline;) await delay(50);
  assert.ok(existsSync(marker), "once the page reads, the shell finishes");
  terminal.send({ type: "input", data: "echo flood-$((4+4))\n" });
  await terminal.until(/flood-8/u, 30_000);
  let count = 0; for (const character of terminal.output()) if (character === "Q") count++;
  assert.equal(count, bytes, "nothing was dropped");
  terminal.send({ type: "input", data: "exit\n" });
  await terminal.exited;
});

test("the Gateway's close ends every terminal and tells each page", async t => {
  const f = await fixture(t), id = await create(f);
  const terminals = await Promise.all([connect(f, id), connect(f, id)]);
  const pids: number[] = [];
  for (const [index, terminal] of terminals.entries()) {
    terminal.send({ type: "input", data: `echo "pid${index}=$$"\n` });
    pids.push(Number((await terminal.until(new RegExp(`pid${index}=(\\d+)`, "u")))[1]));
  }
  await f.gateway.close();
  for (const terminal of terminals) { await terminal.exited; await terminal.closed; }
  for (const pid of pids) assert.equal(alive(pid), false, "the shell " + pid + " has ended");
});
