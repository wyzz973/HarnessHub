import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
interface Fixture { root: string; data: string; workspace: string; gateway: WebServer; origin: string; token: string; cookie: string; csrf: string; start(): Promise<WebServer> }
interface Opened { readonly id: string; readonly title: string; readonly createdAt: number }
interface Listed extends Opened { readonly exited?: { readonly code: number | null; readonly signal: string | null } }

/** A Gateway with one fixture Harness, whose terminals run zsh with a home of their own (the user's profile stays out); `start` starts another on the same data. */
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-terminal-")), workspace = join(root, "workspace"), home = join(root, "home"), manifest = join(root, "catalog.json"), data = join(root, "data");
  // Registered first: a Gateway that fails to start leaves nothing behind either.
  let gateway: WebServer | undefined;
  t.after(async () => { await gateway?.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(workspace); await mkdir(home);
  // An empty profile: zsh neither offers its new-user setup nor reads the user's own.
  await writeFile(join(home, ".zshrc"), "");
  const source = { repository: "fixture", revision: "terminal", upstreamId: "peer", url: "https://example.invalid/terminal-peer" };
  const definitions = [{ id: "web-a", name: "Web a", aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "web-a-control", protocol: "acp-v1", executableNames: ["fixture-peer"], args: [peer, "acp-v1", "a", "basic"], env: {}, requiredExecutables: [], package: null, distribution: null, source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "web-a-control": { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const start = () => startWebServer({ installations: "any", root: data, configuration, port: 0, workspaceLockRoot: join(root, "locks"),
    terminal: { shell: "/bin/zsh", env: { HOME: home, ZDOTDIR: home } },
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) });
  gateway = await start();
  const parsed = new URL(gateway.url), f: Fixture = { root, data, workspace: configuration.workspace, gateway, origin: parsed.origin, token: new URLSearchParams(parsed.hash.slice(1)).get("token")!, cookie: "", csrf: "", start };
  const boot = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
  assert.equal(boot.status, 200);
  f.cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!; f.csrf = String((await boot.json() as Record<string, unknown>).csrfToken);
  return f;
}
/** A request of the page: its login, its Origin and, for a write, its CSRF token; `headers` replaces any of them. */
async function call(f: Fixture, method: string, path: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<{ status: number; body: any }> {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries({ Cookie: f.cookie, Origin: f.origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : { "X-CSRF-Token": f.csrf }), ...headers }))
    if (value !== undefined) sent[name] = value;
  const response = await fetch(f.origin + path, { method, headers: sent, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}
async function create(f: Fixture, key = "create-terminal"): Promise<string> {
  const response = await call(f, "POST", "/api/v1/sessions", { selection: { harnessId: "web-a" }, commandId: key });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return String(response.body.head.id);
}
async function open(f: Fixture, id: string, body: unknown = { cols: 100, rows: 30 }): Promise<Opened> {
  const response = await call(f, "POST", `/api/v1/sessions/${id}/terminals`, body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as Opened;
}
async function list(f: Fixture, id: string): Promise<readonly Listed[]> {
  const response = await call(f, "GET", `/api/v1/sessions/${id}/terminals`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.terminals as Listed[];
}
function socketUrl(f: Fixture, id: string, tid: string, query = "?cols=100&rows=30"): string { return f.origin.replace(/^http/u, "ws") + `/api/v1/sessions/${id}/terminals/${tid}/socket` + query; }

interface Exit { readonly code: number | null; readonly signal: string | null }
interface Attached {
  readonly socket: WebSocket;
  output(): string;
  /** How much output had come when `replayed` came; null before it has. */
  replayedAt(): number | null;
  readonly exited: Promise<Exit>;
  readonly closed: Promise<number>;
  send(frame: unknown): void;
  until(pattern: RegExp, ms?: number): Promise<RegExpMatchArray>;
}
/** A page's socket attached to a terminal: every frame is `output`, one `replayed` or one last `exit`, in that order. */
async function connect(f: Fixture, id: string, tid: string, query?: string): Promise<Attached> {
  const socket = new WebSocket(socketUrl(f, id, tid, query), { headers: { Cookie: f.cookie, Origin: f.origin } });
  let text = "", replayed: number | null = null, exit: ((value: Exit) => void) | undefined, exitedOnce = false;
  const waiting = new Set<() => void>();
  const exited = new Promise<Exit>(done => { exit = done; });
  const closed = new Promise<number>(done => socket.once("close", code => done(code)));
  socket.on("message", (data, binary) => {
    assert.equal(binary, false, "frames are text");
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    assert.equal(exitedOnce, false, "nothing follows the exit");
    if (frame.type === "output") { assert.equal(typeof frame.data, "string"); text += frame.data as string; }
    else if (frame.type === "replayed") { assert.equal(replayed, null, "replayed comes once"); replayed = text.length; }
    else if (frame.type === "exit") {
      assert.notEqual(replayed, null, "the exit comes after the history");
      exitedOnce = true; assert.ok(frame.code === null || typeof frame.code === "number"); assert.ok(frame.signal === null || typeof frame.signal === "string");
      exit!({ code: frame.code as number | null, signal: frame.signal as string | null });
    } else assert.fail("unexpected frame " + String(frame.type));
    for (const check of [...waiting]) check();
  });
  await new Promise<void>((done, reject) => { socket.once("open", () => done()); socket.once("error", reject); });
  return { socket, exited, closed, output: () => text, replayedAt: () => replayed, send: frame => socket.send(JSON.stringify(frame)),
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
    socket.once("open", () => { socket.terminate(); reject(new Error("the terminal was attached")); });
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
async function eventually(check: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await delay(50)) if (await check()) return true;
  return check();
}
/** The shell's pid, as it prints it. */
async function pidOf(terminal: Attached, tag: string): Promise<number> {
  terminal.send({ type: "input", data: `echo "${tag}=$$"\n` });
  return Number((await terminal.until(new RegExp(`${tag}=(\\d+)`, "u")))[1]);
}

test("a conversation's terminals are opened, listed oldest first, renamed and closed; each title is 终端 N unless one is given", async t => {
  const f = await fixture(t), id = await create(f);
  assert.deepEqual(await list(f, id), []);
  const first = await open(f, id), second = await open(f, id), named = await open(f, id, { cols: 80, rows: 24, title: "  构建  " });
  assert.match(first.id, /^terminal-[0-9a-f]{24}$/u);
  assert.deepEqual(Object.keys(first).sort(), ["createdAt", "id", "title"]);
  assert.deepEqual([first.title, second.title, named.title], ["终端 1", "终端 2", "构建"]);
  assert.ok(Number.isSafeInteger(first.createdAt) && first.createdAt <= second.createdAt && second.createdAt <= named.createdAt);
  assert.deepEqual(await list(f, id), [first, second, named]);
  // Each one's history is a file of the Gateway's data directory.
  const history = join(f.data, "terminals", id, second.id + ".log");
  assert.ok(existsSync(history));

  const renamed = await call(f, "PATCH", `/api/v1/sessions/${id}/terminals/${first.id}`, { title: "服务器" });
  assert.equal(renamed.status, 200); assert.deepEqual(renamed.body, { ...first, title: "服务器" });
  assert.deepEqual((await list(f, id)).map(item => item.title), ["服务器", "终端 2", "构建"]);

  const closed = await call(f, "DELETE", `/api/v1/sessions/${id}/terminals/${second.id}`);
  assert.equal(closed.status, 204); assert.equal(closed.body, undefined);
  assert.deepEqual((await list(f, id)).map(item => item.id), [first.id, named.id]);
  assert.equal(existsSync(history), false, "its history is deleted");
  // The smallest number no terminal of the conversation is called; another conversation counts its own.
  assert.equal((await open(f, id)).title, "终端 1");
  assert.equal((await open(f, id)).title, "终端 2");
  const other = await create(f, "create-terminal-other");
  assert.deepEqual(await list(f, other), []);
  assert.equal((await open(f, other)).title, "终端 1");
  assert.equal((await list(f, id)).length, 4);

  // What is not a terminal of this conversation is not found; what is not a size or a title is refused.
  const base = `/api/v1/sessions/${id}/terminals`;
  assert.equal((await call(f, "DELETE", `${base}/${second.id}`)).status, 404, "closed already");
  assert.equal((await call(f, "PATCH", `/api/v1/sessions/${other}/terminals/${first.id}`, { title: "x" })).status, 404, "another conversation's terminal");
  assert.equal((await call(f, "DELETE", `${base}/terminal-${"0".repeat(24)}`)).status, 404);
  assert.equal((await call(f, "GET", `/api/v1/sessions/session-${"f".repeat(24)}/terminals`)).status, 404, "no such conversation");
  for (const body of [{ cols: 100 }, { cols: 0, rows: 30 }, { cols: 100, rows: 65536 }, { cols: 1.5, rows: 30 }, { cols: "100", rows: 30 }, { cols: 100, rows: 30, shell: "sh" }, { cols: 100, rows: 30, title: " " }, { cols: 100, rows: 30, title: "a\nb" }, [1]])
    assert.equal((await call(f, "POST", base, body)).status, 400, JSON.stringify(body));
  for (const body of [{}, { title: "" }, { title: 7 }, { title: "x", extra: 1 }]) assert.equal((await call(f, "PATCH", `${base}/${first.id}`, body)).status, 400, JSON.stringify(body));
  assert.equal((await list(f, id))[0]!.title, "服务器", "a refused rename changes nothing");
});

test("a terminal is the user's login shell in the workspace: input, output, resize, UTF-8, ignored frames and its exit", async t => {
  const f = await fixture(t), id = await create(f), opened = await open(f, id);
  const terminal = await connect(f, id, opened.id);
  terminal.send({ type: "input", data: "echo hello-$((1+2))\n" });
  await terminal.until(/hello-3/u);
  terminal.send({ type: "input", data: "echo \"cwd=$PWD term=$TERM\"; [[ -o login ]] && echo login-shell\n" });
  // The command line itself is echoed too: only the expanded words match.
  const where = await terminal.until(/cwd=(\/\S+) term=([a-z0-9-]+)/u);
  assert.equal(where[1], f.workspace); assert.equal(where[2], "xterm-256color");
  await terminal.until(/login-shell/u);
  // The first size is the one the terminal was opened with; a resize is what `stty size` reads next.
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
  terminal.socket.send("not json"); terminal.send({ type: "unknown" }); terminal.send({ type: "resize", cols: 0, rows: 5 }); terminal.socket.send(Buffer.from("binary"), { binary: true });
  terminal.send({ type: "input", data: "echo still-$((2*3))\n" });
  await terminal.until(/still-6/u);
  terminal.send({ type: "input", data: "exit 7\n" });
  assert.deepEqual(await terminal.exited, { code: 7, signal: null });
  assert.equal(await terminal.closed, 1000);
});

test("a socket that closes only detaches: the shell goes on, and the next socket is sent everything it printed, then the live output", async t => {
  const f = await fixture(t), id = await create(f), opened = await open(f, id);
  const first = await connect(f, id, opened.id);
  const pid = await pidOf(first, "pid");
  // Printed a second after the socket has gone.
  first.send({ type: "input", data: "sleep 1; echo while-away-$((3+4))\n" });
  await first.until(/sleep 1/u);
  first.socket.close();
  await first.closed;
  const history = join(f.data, "terminals", id, opened.id + ".log");
  assert.ok(await eventually(async () => readFile(history, "utf8").then(text => text.includes("while-away-7"))), "written while nobody was attached");
  assert.ok(alive(pid), "the shell is still there");

  const second = await connect(f, id, opened.id);
  await second.until(/while-away-7/u);
  assert.ok(await eventually(() => second.replayedAt() !== null));
  const replayed = second.replayedAt()!, before = second.output().slice(0, replayed);
  assert.match(before, /pid=\d+/u, "the history from the shell's start");
  assert.match(before, /while-away-7/u, "and what it printed while nobody was attached");
  assert.equal(await pidOf(second, "again"), pid, "the same shell");
  second.send({ type: "input", data: "echo live-$((5+5))\n" });
  await second.until(/live-10/u);
  assert.ok(second.output().indexOf("live-10") > replayed, "live output comes after `replayed`");
  // A third socket gets the same history, byte for byte up to its `replayed`.
  const third = await connect(f, id, opened.id);
  assert.ok(await eventually(() => third.replayedAt() !== null));
  assert.equal(third.output(), second.output().slice(0, third.output().length));
  assert.match(third.output(), /live-10/u);
});

test("two sockets attached at once: both get the output, either one's input goes to the shell, and the latest resize wins", async t => {
  const f = await fixture(t), id = await create(f), opened = await open(f, id);
  const a = await connect(f, id, opened.id), b = await connect(f, id, opened.id);
  a.send({ type: "input", data: "echo from-a-$((1+1))\n" });
  await a.until(/from-a-2/u); await b.until(/from-a-2/u);
  b.send({ type: "input", data: "echo from-b-$((2+2))\n" });
  await a.until(/from-b-4/u); await b.until(/from-b-4/u);
  a.send({ type: "resize", cols: 90, rows: 20 });
  a.send({ type: "input", data: "stty size\n" });
  await b.until(/20 90/u);
  b.send({ type: "resize", cols: 120, rows: 40 });
  b.send({ type: "input", data: "stty size\n" });
  await a.until(/40 120/u);
  // A socket that attaches with a size resizes the shell to it.
  const c = await connect(f, id, opened.id, "?cols=77&rows=22");
  c.send({ type: "input", data: "stty size\n" });
  await a.until(/22 77/u);
  // One leaving changes nothing for the others.
  a.socket.close(); await a.closed;
  b.send({ type: "input", data: "echo after-a-$((3*3))\n" });
  await b.until(/after-a-9/u); await c.until(/after-a-9/u);
});

test("a shell that ended stays listed with its exit; attaching to it sends its history, then the exit", async t => {
  const f = await fixture(t), id = await create(f), opened = await open(f, id);
  const terminal = await connect(f, id, opened.id);
  terminal.send({ type: "input", data: "echo bye-$((6*7)); exit 7\n" });
  assert.deepEqual(await terminal.exited, { code: 7, signal: null });
  assert.equal(await terminal.closed, 1000);
  assert.deepEqual(await list(f, id), [{ ...opened, exited: { code: 7, signal: null } }]);
  const again = await connect(f, id, opened.id);
  assert.deepEqual(await again.exited, { code: 7, signal: null });
  assert.equal(await again.closed, 1000);
  assert.match(again.output(), /bye-42/u);
  assert.equal(again.replayedAt(), again.output().length, "the history, `replayed`, then the exit");
  assert.equal((await call(f, "DELETE", `/api/v1/sessions/${id}/terminals/${opened.id}`)).status, 204);
  assert.deepEqual(await list(f, id), []);
});

test("closing a terminal ends its shell with SIGTERM and a hang-up, kills one that ignores both a second later, and ends its jobs", async t => {
  const f = await fixture(t), id = await create(f);
  // A shell that ignores the hang-up and exits 3 on SIGTERM: it was sent SIGTERM. Its job started before the traps, so it does not ignore the hang-up.
  const polite = await open(f, id), politeSocket = await connect(f, id, polite.id);
  politeSocket.send({ type: "input", data: "sleep 300 & echo pids=$$,$!; trap '' HUP; trap 'exit 3' TERM; echo armed-$((1+1))\n" });
  const [, shell, job] = (await politeSocket.until(/pids=(\d+),(\d+)/u)).map(Number) as [number, number, number];
  await politeSocket.until(/armed-2/u);
  assert.ok(alive(shell) && alive(job));
  assert.equal((await call(f, "DELETE", `/api/v1/sessions/${id}/terminals/${polite.id}`)).status, 204);
  assert.deepEqual(await politeSocket.exited, { code: 3, signal: null });
  assert.equal(await politeSocket.closed, 1000);
  assert.equal(alive(shell), false, "the shell had ended when the answer came");
  assert.ok(await gone(job), "its job has ended");

  // A shell that ignores both is killed after a second.
  const stubborn = await open(f, id), stubbornSocket = await connect(f, id, stubborn.id);
  stubbornSocket.send({ type: "input", data: "trap '' TERM HUP; echo stubborn=$$\n" });
  const pid = Number((await stubbornSocket.until(/stubborn=(\d+)/u))[1]);
  const started = Date.now();
  assert.equal((await call(f, "DELETE", `/api/v1/sessions/${id}/terminals/${stubborn.id}`)).status, 204);
  assert.ok(Date.now() - started >= 900, "it was given a second");
  assert.deepEqual(await stubbornSocket.exited, { code: null, signal: "SIGKILL" });
  assert.equal(alive(pid), false);
  assert.deepEqual(await list(f, id), []);
  assert.deepEqual(await readdir(join(f.data, "terminals", id)), [], "both histories are deleted");
  assert.equal(await refusal(socketUrl(f, id, stubborn.id), { Cookie: f.cookie, Origin: f.origin }), 404, "a closed terminal is not attached to");
});

test("deleting a conversation closes its terminals; archiving it does not", async t => {
  const f = await fixture(t), id = await create(f), kept = await create(f, "create-terminal-kept");
  const opened = await open(f, id), terminal = await connect(f, id, opened.id), pid = await pidOf(terminal, "pid");
  const other = await open(f, kept), otherSocket = await connect(f, kept, other.id), otherPid = await pidOf(otherSocket, "other");
  assert.equal((await call(f, "PATCH", `/api/v1/sessions/${id}`, { archived: true })).status, 200);
  await delay(300);
  assert.ok(alive(pid), "an archived conversation keeps its terminal");
  assert.deepEqual((await list(f, id)).map(item => item.id), [opened.id]);
  assert.equal((await call(f, "DELETE", `/api/v1/sessions/${id}`)).status, 204);
  assert.ok((await terminal.exited) !== undefined);
  assert.equal(await terminal.closed, 1000);
  assert.ok(await gone(pid), "its shell has ended");
  assert.ok(await eventually(() => !existsSync(join(f.data, "terminals", id))), "its histories are deleted");
  assert.equal((await call(f, "GET", `/api/v1/sessions/${id}/terminals`)).status, 404, "a deleted conversation is not found");
  assert.equal((await call(f, "POST", `/api/v1/sessions/${id}/terminals`, { cols: 80, rows: 24 })).status, 404);
  // Restored, it has none: they were closed, not put aside.
  assert.equal((await call(f, "POST", `/api/v1/sessions/${id}/restore`, {})).status, 200);
  assert.deepEqual(await list(f, id), []);
  // The other conversation's terminal is untouched.
  assert.ok(alive(otherPid));
  assert.equal(await pidOf(otherSocket, "still"), otherPid);
});

test("the Gateway's close ends every shell, tells every socket and deletes every history; a new Gateway removes what an old one left", async t => {
  const f = await fixture(t);
  const first = await create(f), second = await create(f, "create-terminal-second");
  const sockets = await Promise.all([open(f, first).then(item => connect(f, first, item.id)), open(f, first).then(item => connect(f, first, item.id))]);
  const unattached = await open(f, second);
  const pids: number[] = [];
  for (const [index, socket] of sockets.entries()) pids.push(await pidOf(socket, "pid" + index));
  // One with no socket attached: its shell is found by its terminal's history.
  const probe = await connect(f, second, unattached.id); pids.push(await pidOf(probe, "unattached")); probe.socket.close(); await probe.closed;
  await f.gateway.close();
  for (const socket of [...sockets]) { await socket.exited; assert.equal(await socket.closed, 1000); }
  for (const pid of pids) assert.equal(alive(pid), false, "the shell " + pid + " has ended");
  const histories = existsSync(join(f.data, "terminals")) ? (await readdir(join(f.data, "terminals"), { recursive: true })).filter(name => String(name).endsWith(".log")) : [];
  assert.deepEqual(histories, [], "no history is left");
  // A history a Gateway that did not close left (a crash): the next Gateway on the same data removes it before it listens.
  const left = join(f.data, "terminals", first, "terminal-" + "b".repeat(24) + ".log");
  await mkdir(join(f.data, "terminals", first), { recursive: true, mode: 0o700 });
  await writeFile(left, "old output\n");
  const next = await f.start();
  try { assert.equal(existsSync(join(f.data, "terminals")), false, "the leftover history is removed at start"); }
  finally { await next.close(); }
});

test("a terminal's routes and socket take only the page's login, its Origin and, for a write, its CSRF token", async t => {
  const f = await fixture(t), id = await create(f), opened = await open(f, id), url = socketUrl(f, id, opened.id);
  assert.equal(await refusal(url, { Origin: f.origin }), 401, "no login");
  assert.equal(await refusal(url, { Origin: f.origin, Cookie: "harnessgateway_session=" + "0".repeat(64) }), 401, "an unknown login");
  assert.equal(await refusal(url, { Cookie: f.cookie }), 403, "no Origin");
  assert.equal(await refusal(url, { Cookie: f.cookie, Origin: "http://evil.example" }), 403, "another site");
  assert.equal(await refusal(url, { Cookie: f.cookie, Origin: f.origin.replace("127.0.0.1", "localhost") }), 403, "another name for this computer");
  const page = { Cookie: f.cookie, Origin: f.origin };
  assert.equal(await refusal(socketUrl(f, "session-" + "f".repeat(24), opened.id), page), 404, "no such conversation");
  assert.equal(await refusal(socketUrl(f, id, "terminal-" + "0".repeat(24)), page), 404, "no such terminal");
  assert.equal(await refusal(socketUrl(f, id, opened.id, "?cols=0&rows=30"), page), 400, "a size a terminal cannot have");
  assert.equal(await refusal(socketUrl(f, id, opened.id, "?cols=80"), page), 400, "half a size");
  assert.equal(await refusal(socketUrl(f, id, opened.id, "?cols=80&rows=24&shell=sh"), page), 400, "an unknown parameter");
  assert.equal(await refusal(f.origin.replace(/^http/u, "ws") + `/api/v1/sessions/${id}/terminal?cols=80&rows=24`, page), 404, "the old route is gone");
  assert.equal(await refusal(f.origin.replace(/^http/u, "ws") + "/api/v1/state", page), 404, "no other route upgrades");

  const base = `/api/v1/sessions/${id}/terminals`;
  assert.equal((await call(f, "GET", base, undefined, { Cookie: undefined })).status, 401, "a list without the login");
  assert.equal((await call(f, "GET", base, undefined, { Origin: "http://evil.example" })).status, 403, "a list for another site");
  assert.equal((await call(f, "POST", base, { cols: 80, rows: 24 }, { "X-CSRF-Token": undefined })).status, 403, "an open without the CSRF token");
  assert.equal((await call(f, "POST", base, { cols: 80, rows: 24 }, { "X-CSRF-Token": "0".repeat(64) })).status, 403, "an open with another CSRF token");
  assert.equal((await call(f, "POST", base, { cols: 80, rows: 24 }, { Origin: undefined })).status, 403, "an open without the Origin");
  assert.equal((await call(f, "PATCH", `${base}/${opened.id}`, { title: "x" }, { "X-CSRF-Token": undefined })).status, 403, "a rename without the CSRF token");
  assert.equal((await call(f, "DELETE", `${base}/${opened.id}`, undefined, { "X-CSRF-Token": undefined })).status, 403, "a close without the CSRF token");
  assert.equal((await call(f, "DELETE", `${base}/${opened.id}`, undefined, { Cookie: undefined })).status, 401, "a close without the login");
  assert.deepEqual(await list(f, id), [opened], "nothing refused changed anything");
  // With all of it, it attaches.
  const terminal = await connect(f, id, opened.id);
  terminal.send({ type: "input", data: "exit\n" });
  assert.deepEqual(await terminal.exited, { code: 0, signal: null });
});

test("a shell that floods a slow socket does not wait for it: the socket is read the rest from the history, and every socket gets every byte", async t => {
  const f = await fixture(t), id = await create(f), opened = await open(f, id), bytes = 32 * 1024 * 1024, marker = join(f.workspace, "flood-done");
  const slow = await connect(f, id, opened.id), fast = await connect(f, id, opened.id);
  fast.send({ type: "input", data: "echo ready-$((1+1))\n" });
  await slow.until(/ready-2/u); await fast.until(/ready-2/u);
  slow.socket.pause();
  // \121 is Q: the command line itself holds none.
  fast.send({ type: "input", data: `head -c ${bytes} /dev/zero | LC_ALL=C tr '\\0' '\\121'; touch flood-done\n` });
  assert.ok(await eventually(() => existsSync(marker), 60_000), "the shell finishes while the slow socket reads nothing");
  fast.send({ type: "input", data: "echo flood-$((4+4))\n" });
  await fast.until(/flood-8/u, 60_000);
  const count = (text: string): number => { let found = 0; for (let at = text.indexOf("Q"); at !== -1; at = text.indexOf("Q", at + 1)) found++; return found; };
  assert.equal(count(fast.output()), bytes, "the socket that keeps up got every byte");
  slow.socket.resume();
  await slow.until(/flood-8/u, 60_000);
  assert.equal(count(slow.output()), bytes, "the slow socket got every byte too");
  assert.equal(slow.output(), fast.output().slice(0, slow.output().length));
  fast.send({ type: "input", data: "exit\n" });
  await fast.exited; await slow.exited;
});
