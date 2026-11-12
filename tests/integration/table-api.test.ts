import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { application } from "../../src/cli/session-application.js";
import { sessionId } from "../../src/contracts/session.js";
import { TABLE_PROGRESS_TOOLS, TABLE_ENV, TABLE_NOT_IN_SESSION, TABLE_TOOLS } from "../../src/contracts/table.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { readWhole, type ReadConversation } from "../fixtures/http-conversation.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

// The context table over a real Gateway: a real store, a real HTTP server, a Harness fixture that is a real child process
// (a Codex app-server peer that runs a command, fails, and changes a file), and the Hub's tool process spawned for real and
// spoken to in MCP over its stdin and stdout, and from its command line. Nothing here reaches a real Harness.

const hubTools = fileURLToPath(new URL("../../src/cli/hub-tools.js", import.meta.url));
function row(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "an object was expected"); return value as Record<string, unknown>;
}
/** A Codex app-server peer. A message that starts with WORK makes it run a failing command with a long output (a token among it, built at run time), change a file and plan. */
const PEER = `import{createInterface}from'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n'),notify=(method,params)=>send({method,params});
let thread='thread-'+process.pid,counter=0;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')return send({id:m.id,result:{userAgent:'table-peer/1.0'}});
if(m.method==='initialized')return;
if(m.method==='thread/start'){notify('thread/started',{thread:{id:thread}});return send({id:m.id,result:{thread:{id:thread}}});}
if(m.method==='thread/resume'){thread=m.params.threadId;notify('thread/started',{thread:{id:thread}});return send({id:m.id,result:{thread:{id:thread}}});}
if(m.method==='turn/start'){const text=m.params.input[0].text,turn='turn-'+process.pid+'-'+(++counter),base={threadId:thread,turnId:turn};
notify('turn/started',{threadId:thread,turn:{id:turn,status:'inProgress'}});send({id:m.id,result:{turn:{id:turn,status:'inProgress'}}});
if(text.startsWith('WORK')){
notify('turn/plan/updated',{...base,explanation:'two steps',plan:[{step:'run the tests',status:'completed'},{step:'fix the code',status:'inProgress'}]});
const out=Array.from({length:400},(_,i)=>'test line '+(i+1)+' needle-'+(i+1)).join('\\n')+'\\nGITHUB_TOKEN='+'gh'+'p_'+'Q1w2E3r4T5'.repeat(4)+'\\nFAILED 1\\n';
notify('item/started',{...base,item:{type:'commandExecution',id:'cmd-1',command:'pnpm test',cwd:process.cwd(),status:'inProgress'}});
notify('item/completed',{...base,item:{type:'commandExecution',id:'cmd-1',command:'pnpm test',cwd:process.cwd(),status:'failed',aggregatedOutput:out,exitCode:1}});
notify('item/completed',{...base,item:{type:'fileChange',id:'patch-1',status:'completed',changes:[{path:process.cwd()+'/src/a.ts',kind:{type:'update'},diff:'@@ -1 +1 @@\\n-old\\n+new\\n'}]}});}
notify('item/agentMessage/delta',{...base,itemId:'message-'+counter,delta:'reply to '+text.slice(0,40)});
notify('turn/completed',{threadId:thread,turn:{id:turn,status:'completed'}});return;}
if(m.id!==undefined&&typeof m.method==='string')send({id:m.id,error:{code:-32601,message:'method not found'}});});
`;

/** Makes the factory unable to read the known secrets, as when a Harness's configuration file cannot be read. */
const failing = { secrets: false };
interface Fixture { readonly root: string; readonly grants: MemoryTableGrants; gateway: WebServer; origin: string; port: number; cookie: string; csrf: string; id: string; token: string }
let f: Fixture;
async function boot(root: string, grants: MemoryTableGrants, harness: string, peerFile: string): Promise<{ gateway: WebServer; origin: string; port: number; cookie: string; csrf: string }> {
  const workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json"), home = join(root, "home"), locks = join(root, "locks");
  await mkdir(workspace); await mkdir(assets); await mkdir(home); await writeFile(join(assets, "index.html"), "<!doctype html><title>HarnessGateway fixture</title>");
  const source = { repository: "fixture", revision: "table-api", upstreamId: "peer", url: "https://example.invalid/table-api-peer" };
  const definitions = [{ id: harness, name: "Table fixture", aliases: [], binaryNames: [], configHints: [], controls: [{ id: harness + "-control", protocol: "codex-app-server", executableNames: ["fixture-peer"], args: [peerFile], env: {}, requiredExecutables: [], package: null, distribution: null, source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { [harness + "-control"]: { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  // A private home and system root, so that nothing of the machine's own Harness configuration is read.
  const nativeEnvironment = { home, values: { HOME: home, PATH: dirname(process.execPath) + ":/usr/bin:/bin" }, system: join(root, "system") };
  const gateway = await startWebServer({ installations: "any", root: join(root, "data"), configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: locks,
    application: (data, publish) => {
      const app = application(data, publish, { workspaceLockRoot: locks, installations: "any", nativeEnvironment, tableGrants: grants });
      const factory = app.factory as unknown as { relaySecrets: (...args: unknown[]) => Promise<readonly string[]> }, real = factory.relaySecrets.bind(app.factory);
      factory.relaySecrets = (...args) => failing.secrets ? Promise.reject(new Error("the configuration cannot be read")) : real(...args);
      return app;
    } });
  const parsed = new URL(gateway.url), origin = parsed.origin, token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  const response = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 200, await response.clone().text());
  return { gateway, origin, port: Number(parsed.port), cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, csrf: String(row(await response.json()).csrfToken) };
}
interface Reply { readonly status: number; readonly data: unknown; readonly text: string; readonly headers: Headers }
async function call(path: string, method = "GET", input?: unknown): Promise<Reply> {
  const response = await fetch(f.origin + path, { method, headers: { Cookie: f.cookie, Origin: f.origin, ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": f.csrf }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); let data: unknown = null; try { data = JSON.parse(text); } catch { /* a text answer */ }
  return { status: response.status, data, text, headers: response.headers };
}
/** A table read the way the tool process makes it: no cookie, no Origin, a bearer token. */
async function table(path: string, token: string | null = f.token, extra: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(f.origin + path, { headers: { ...(token === null ? {} : { Authorization: "Bearer " + token }), ...extra } });
  const text = await response.text(); let data: unknown = null; try { data = JSON.parse(text); } catch { /* a text answer */ }
  return { status: response.status, data, text, headers: response.headers };
}
/** The conversation as a page reads it: its head and every Turn, through the paged routes. */
async function view(id: string): Promise<ReadConversation> { return readWhole(async path => { const reply = await call(path); assert.equal(reply.status, 200, reply.text); return reply.data; }, id); }
async function say(id: string, text: string, key: string, index: number): Promise<void> {
  assert.equal((await call(`/api/v1/sessions/${id}/messages`, "POST", { text, commandId: key })).status, 202);
  for (const deadline = Date.now() + 15000; ;) {
    const current = await view(id), run = current.runs[index];
    if (run !== undefined && ["completed", "failed", "cancelled", "unknown"].includes(run.status)) { assert.equal(run.status, "completed", JSON.stringify(run.error)); return; }
    if (Date.now() > deadline) throw new Error("the Turn did not end: " + JSON.stringify(current.runs.map(item => item.status)));
    await delay(20);
  }
}

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-table-api-")), peerFile = join(root, "table-peer.mjs"), grants = new MemoryTableGrants();
  await writeFile(peerFile, PEER);
  const booted = await boot(root, grants, "tbl-a", peerFile);
  f = { root, grants, ...booted, id: "", token: "" };
  const created = await call("/api/v1/sessions", "POST", { selection: { harnessId: "tbl-a" }, commandId: "create-table" });
  assert.equal(created.status, 201, created.text);
  f.id = String(row(row(created.data).head).id);
  await say(f.id, "WORK: run the tests and fix src/a.ts", "send-1", 0);
  await say(f.id, "thanks, now explain needle-17 to me", "send-2", 1);
  f.token = grants.mint({ sessionId: sessionId(f.id), harnessId: "tbl-a", controlId: "tbl-a-control" });
});
after(async () => { try { await f?.gateway.close(); } finally { if (f !== undefined) await rm(f.root, { recursive: true, force: true }); } });

// ---------------------------------------------------------------------------------------------------------------------
// The HTTP routes
// ---------------------------------------------------------------------------------------------------------------------

test("the table is read with the conversation's bearer token and nothing else: no token, a wrong one, the web login, a page, a revoked one", async () => {
  for (const path of ["/api/table/turns", "/api/table/turns/1", "/api/table/search?q=x"]) {
    for (const [label, token] of [["no token", null], ["a wrong token", "hht_" + "x".repeat(43)], ["a token of no shape", "short"]] as const) {
      const reply = await table(path, token); assert.equal(reply.status, 401, path + " " + label + ": " + reply.text);
      assert.equal(row(reply.data).code, "TABLE_TOKEN_INVALID"); assert.match(reply.headers.get("www-authenticate") ?? "", /^Bearer/u);
    }
  }
  // The web login is no way in: its cookie and its CSRF token play no part, and a bearer token is no way into the rest of the API.
  const cookie = await table("/api/table/turns", null, { Cookie: f.cookie }); assert.equal(cookie.status, 401);
  const rest = await table("/api/v1/state"); assert.equal(rest.status, 401); assert.equal(row(rest.data).code, "AUTH_REQUIRED");
  // A page is not the caller (an Origin means a browser), and nothing but a read is allowed.
  const page = await table("/api/table/turns", f.token, { Origin: f.origin }); assert.equal(page.status, 403); assert.equal(row(page.data).code, "TABLE_LOCAL_ONLY");
  const foreign = await table("/api/table/turns", f.token, { Origin: "http://evil.example" }); assert.equal(foreign.status, 403);
  const post = await fetch(f.origin + "/api/table/turns", { method: "POST", headers: { Authorization: "Bearer " + f.token } }); assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET");
  assert.equal((await fetch(f.origin + "/api/table/turns", { method: "POST" })).status, 401, "a token that is not valid is a 401 whatever else is wrong");
  assert.equal((await table("/api/table/nothing")).status, 404);
  // Another Host is refused as it is for the whole API; `localhost` is accepted for the table alone.
  const asHost = (host: string, path: string) => new Promise<number>((done, fail) => {
    const probe = httpRequest({ host: "127.0.0.1", port: f.port, path, headers: { Host: host, Authorization: "Bearer " + f.token } }, response => { response.resume(); response.on("end", () => done(response.statusCode ?? 0)); });
    probe.on("error", fail); probe.end();
  });
  assert.equal(await asHost("localhost:" + f.port, "/api/table/turns"), 200);
  assert.equal(await asHost("evil.example:" + f.port, "/api/table/turns"), 403);
  assert.equal(await asHost("localhost:" + f.port, "/api/v1/state"), 403);
  // A token for another conversation reads that one and no other; a revoked token reads nothing.
  const other = f.grants.mint({ sessionId: sessionId("session-" + "0".repeat(8)), harnessId: "tbl-a", controlId: "tbl-a-control" });
  const missing = await table("/api/table/turns", other); assert.equal(missing.status, 404); assert.equal(row(missing.data).code, "SESSION_NOT_FOUND");
  const lent = f.grants.mint({ sessionId: sessionId(f.id), harnessId: "tbl-a", controlId: "tbl-a-control" });
  assert.equal((await table("/api/table/turns", lent)).status, 200);
  f.grants.revoke(sessionId("session-" + "0".repeat(8)));
  assert.equal((await table("/api/table/turns", other)).status, 401);
  f.grants.revoke(sessionId(f.id)); assert.equal((await table("/api/table/turns", lent)).status, 401); assert.equal((await table("/api/table/turns")).status, 401);
  f.token = f.grants.mint({ sessionId: sessionId(f.id), harnessId: "tbl-a", controlId: "tbl-a-control" });
});

test("the directory, one Turn and a search over HTTP, from a real conversation with its stored details", async () => {
  // The Turn's calls are its items; the ones that ran something (a command, a file change) keep the detail the table reads from.
  const first = (await view(f.id)).turns[0]!, calls = first.items.filter(item => item.type === "command" || item.type === "file_change");
  assert.ok(calls.length === 2 && calls.every(item => item.detail !== undefined), "the Runtime stored the Turn's tool details: " + JSON.stringify(first.items.map(item => [item.type, item.detail?.id])));
  const directory = await table("/api/table/turns"); assert.equal(directory.status, 200, directory.text);
  const lines = row(directory.data).lines as Record<string, unknown>[];
  assert.deepEqual([row(directory.data).total, row(directory.data).from, row(directory.data).to, lines.length], [2, 1, 2, 2]);
  assert.deepEqual([lines[0]!.n, lines[0]!.harnessId, lines[0]!.status, lines[0]!.tools, lines[0]!.files, lines[0]!.filesApprox], [1, "tbl-a", "completed", 2, 1, undefined]);
  assert.equal(lines[0]!.user, "WORK: run the tests and fix src/a.ts"); assert.equal(lines[0]!.reply, "reply to WORK: run the tests and fix src/a.ts");
  assert.deepEqual([lines[1]!.tools, lines[1]!.files], [0, 0]);
  const window = await table("/api/table/turns?from=2&limit=1"); assert.deepEqual((row(window.data).lines as unknown[]).length, 1);
  assert.equal((await table("/api/table/turns?limit=0")).status, 400); assert.equal((await table("/api/table/turns?from=x")).status, 400); assert.equal((await table("/api/table/turns?other=1")).status, 400);

  const overview = await table("/api/table/turns/1"); assert.equal(overview.status, 200, overview.text);
  const text = String(row(overview.data).text);
  for (const wanted of ["Turn 1 of 2 · tbl-a · completed", "WORK: run the tests and fix src/a.ts", "pnpm test", "failed, exit 1", "## Files changed (1)", "src/a.ts — edited", "## The plan", "two steps", "[x] run the tests", "[~] fix the code"])
    assert.ok(text.includes(wanted), "the overview holds: " + wanted + "\n" + text);

  // The command's whole output, in pages: nothing lost between them, the token hidden in every one.
  let joined = "", offset = 0, pages = 0;
  for (;;) {
    const page = await table("/api/table/turns/1?part=output&tool=1&limit=4000&offset=" + offset); assert.equal(page.status, 200, page.text);
    const body = row(page.data); joined += String(body.text); pages++;
    assert.equal(body.offset, offset); assert.equal(body.part, "output"); assert.equal(body.tool, 1);
    if (Number(body.end) >= Number(body.size)) break;
    offset = Number(body.end);
  }
  assert.ok(pages > 2);
  assert.ok(joined.startsWith("test line 1 needle-1\n") && joined.includes("test line 400 needle-400\n") && joined.includes("FAILED 1"), "the output is whole");
  assert.ok(!joined.includes("Q1w2E3r4T5") && joined.includes("〔redacted · GitHub token〕"), "the token is hidden");
  const input = await table("/api/table/turns/1?part=input&tool=1"); assert.equal(row(input.data).text, "pnpm test");
  const diff = await table("/api/table/turns/1?part=diff&tool=2"); assert.match(String(row(diff.data).text), /^--- a\/.*src\/a\.ts\n\+\+\+ b\/.*src\/a\.ts\n@@ -1 \+1 @@\n-old\n\+new\n$/u);

  for (const [path, status, code] of [["/api/table/turns/9", 404, "TABLE_TURN_NOT_FOUND"], ["/api/table/turns/1?part=output", 400, "INVALID_INPUT"], ["/api/table/turns/1?part=output&tool=9", 404, "TABLE_TOOL_NOT_FOUND"],
    ["/api/table/turns/1?part=bogus", 400, "INVALID_INPUT"], ["/api/table/turns/1?offset=-1", 400, "INVALID_INPUT"], ["/api/table/turns/2?part=output&tool=1", 404, "TABLE_TOOL_NOT_FOUND"], ["/api/table/search", 400, "INVALID_INPUT"], ["/api/table/search?q=%20", 400, "INVALID_INPUT"]] as const) {
    const reply = await table(path); assert.equal(reply.status, status, path + ": " + reply.text); assert.equal(row(reply.data).code, code, path);
  }

  const search = await table("/api/table/search?q=NEEDLE-17"); assert.equal(search.status, 200, search.text);
  const found = row(search.data), hits = found.hits as Record<string, unknown>[];
  assert.deepEqual([found.turns, found.total, found.unsearched], [2, 3, 0]);
  assert.deepEqual(hits.map(hit => [hit.n, hit.where, hit.tool]), [[2, "user", undefined], [2, "reply", undefined], [1, "output", 1]], "newest Turn first (the fixture's reply repeats the words)");
  const output = await table("/api/table/turns/1?part=output&tool=1&limit=40000");
  assert.equal(String(row(output.data).text).slice(Number(hits[2]!.at), Number(hits[2]!.at) + 9).toLowerCase(), "needle-17", "`at` is where to read from");
  assert.equal(row((await table("/api/table/search?q=Q1w2E3r4T5")).data).total, 0, "a hidden secret is not confirmed by a search");
});

test("when the known secrets cannot be read the answer says so and still hides what its patterns find", async () => {
  failing.secrets = true;
  try {
    const created = await call("/api/v1/sessions", "POST", { selection: { harnessId: "tbl-a" }, commandId: "create-unhidden" }); assert.equal(created.status, 201, created.text);
    const token = f.grants.mint({ sessionId: sessionId(String(row(row(created.data).head).id)), harnessId: "tbl-a", controlId: "tbl-a-control" });
    const reply = await table("/api/table/turns", token); assert.equal(reply.status, 200, reply.text);
    assert.match(String(((row(reply.data).notes) as string[])[0]), /^Hiding the known secrets of the Harnesses was not possible for this answer; only the pattern-based hiding was applied\.$/u);
  } finally { failing.secrets = false; }
});

test("a server given its own tokens uses them, and a conversation without Turns has an empty directory", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-table-empty-")), grants = new MemoryTableGrants(), peerFile = join(root, "table-peer.mjs");
  await writeFile(peerFile, PEER);
  const workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>fixture</title>");
  const source = { repository: "fixture", revision: "table-api", upstreamId: "peer", url: "https://example.invalid/table-api-peer" };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [{ id: "tbl-b", name: "Table fixture", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "tbl-b-control", protocol: "codex-app-server", executableNames: ["fixture-peer"], args: [peerFile], env: {}, requiredExecutables: [], package: null, distribution: null, source }] }], overrides: { "tbl-b-control": { executable: process.execPath } } }));
  const gateway = await startWebServer({ installations: "any", root: join(root, "data"), configuration: await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), port: 0, assetsDirectory: assets, workspaceLockRoot: join(root, "locks"), tableGrants: grants });
  t.after(async () => { try { await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const parsed = new URL(gateway.url), origin = parsed.origin, bootstrap = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  const login = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: bootstrap }) });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String(row(await login.json()).csrfToken);
  const created = await fetch(origin + "/api/v1/sessions", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ selection: { harnessId: "tbl-b" }, commandId: "create-empty" }) });
  const id = String(row(row(await created.json()).head).id), token = grants.mint({ sessionId: sessionId(id), harnessId: "tbl-b", controlId: "tbl-b-control" });
  const reply = await fetch(origin + "/api/table/turns", { headers: { Authorization: "Bearer " + token } });
  assert.equal(reply.status, 200); const body = row(await reply.json());
  assert.deepEqual([body.total, body.from, body.to, body.lines], [0, 1, 0, []]);
  const none = await fetch(origin + "/api/table/turns/1", { headers: { Authorization: "Bearer " + token } });
  assert.equal(none.status, 404); assert.equal(row(await none.json()).message, "This conversation has no turns yet.");
});

// ---------------------------------------------------------------------------------------------------------------------
// The tool process: MCP on stdio
// ---------------------------------------------------------------------------------------------------------------------

/** The tool process spoken to in MCP: one JSON-RPC message per line. */
class Mcp {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: string[] = [];
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private next = 0;
  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [hubTools, "mcp"], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString("utf8")));
    createInterface({ input: this.child.stdout }).on("line", line => { const message = row(JSON.parse(line)); const resolve = this.waiting.get(Number(message.id)); if (resolve !== undefined) { this.waiting.delete(Number(message.id)); resolve(message); } });
  }
  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("no answer to " + method)), 15000);
      this.waiting.set(id, message => { clearTimeout(timer); done(message); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    });
  }
  notify(method: string): void { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); }
  /** Calls a tool; its text and whether it said it failed. */
  async tool(name: string, args: Record<string, unknown>): Promise<{ readonly text: string; readonly isError: boolean }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    const result = row(reply.result), content = result.content as Record<string, unknown>[];
    assert.equal(content.length, 1); assert.equal(content[0]!.type, "text");
    return { text: String(content[0]!.text), isError: result.isError === true };
  }
  async open(): Promise<void> {
    const reply = row((await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "table-test", version: "1" } })).result);
    assert.equal(reply.protocolVersion, "2025-06-18"); this.notify("notifications/initialized");
  }
  async end(): Promise<number | null> {
    const exited = new Promise<number | null>(done => this.child.once("exit", code => done(code)));
    this.child.stdin.end();
    return Promise.race([exited, delay(10000).then(() => { this.child.kill("SIGKILL"); return -1; })]);
  }
}
const session = (): Record<string, string> => ({ [TABLE_ENV.url]: f.origin, [TABLE_ENV.session]: f.token });

test("MCP: initialize, tools/list and tools/call for the three tools, from a real tool process", async t => {
  const mcp = new Mcp(session()); t.after(() => { mcp.child.kill("SIGKILL"); });
  const versions = row((await mcp.request("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "table-test", version: "1" } })).result);
  assert.equal(versions.protocolVersion, "2025-11-25", "a version it does not know is answered with the newest it speaks");
  await mcp.open();
  const info = row((await mcp.request("initialize", { protocolVersion: "2025-03-26", capabilities: {} })).result);
  assert.deepEqual([info.protocolVersion, row(info.serverInfo).name, row(info.capabilities).tools !== undefined, typeof info.instructions], ["2025-03-26", "harnesshub", true, "string"]);
  assert.deepEqual(row((await mcp.request("ping")).result), {});
  const listed = row((await mcp.request("tools/list")).result).tools as Record<string, unknown>[];
  assert.deepEqual(listed.map(item => item.name), [...TABLE_TOOLS]);
  for (const item of listed) {
    assert.ok(String(item.description).length > 200 && /^[A-Z]/u.test(String(item.description)), item.name + " says in English what it is for and when to use it");
    assert.equal(row(item.inputSchema).type, "object"); assert.equal(row(item.inputSchema).additionalProperties, false); assert.equal(row(item.annotations).readOnlyHint, !(TABLE_PROGRESS_TOOLS as readonly string[]).includes(String(item.name)));
  }
  assert.deepEqual(row(listed[1]!.inputSchema).required, ["n"]); assert.deepEqual(row(listed[2]!.inputSchema).required, ["query"]);

  const turns = await mcp.tool("hub_turns", {});
  assert.equal(turns.isError, false);
  for (const wanted of ["Turns 1-2 of 2.", "#1 · tbl-a · completed · 2 tool calls · 1 file changed", "  user: WORK: run the tests and fix src/a.ts", "  reply: reply to WORK: run the tests and fix src/a.ts", "#2 · tbl-a · completed · 0 tool calls · 0 files changed"])
    assert.ok(turns.text.includes(wanted), "the directory holds: " + wanted + "\n" + turns.text);
  assert.equal((await mcp.tool("hub_turns", { from: "2", limit: 1 })).text.split("\n")[0], "Turns 2-2 of 2.");
  assert.match((await mcp.tool("hub_turns", { from: 2, limit: 1 })).text, /Earlier turns: hub_turns \{"from":1,"limit":1\}/u);

  const turn = await mcp.tool("hub_read_turn", { n: 1 });
  assert.equal(turn.isError, false); assert.match(turn.text, /^Turn 1 of 2 · tbl-a · completed\n/u);
  assert.ok(turn.text.includes("## Files changed (1)") && turn.text.includes("#1 · execute · shell · pnpm test · failed, exit 1"), turn.text);

  // Reading on as the result says to: every page's pointer is a call that works, and the pages are the whole output.
  let page = await mcp.tool("hub_read_turn", { n: 1, part: "output", tool: 1, limit: 3000 }), joined = "", pages = 0;
  for (;;) {
    pages++; assert.equal(page.isError, false, page.text);
    const pointer = /\n\[(\d+) more characters\. Next page: hub_read_turn (\{.*\})\]/u.exec(page.text);
    joined += page.text.slice(page.text.indexOf("\n") + 1).replace(/\n\[\d+ more characters\..*$/su, "");
    if (pointer === null) break;
    page = await mcp.tool("hub_read_turn", { ...row(JSON.parse(pointer[2]!)), limit: 3000 });
  }
  assert.ok(pages > 3); assert.ok(joined.includes("test line 400 needle-400") && joined.includes("FAILED 1") && joined.includes("〔redacted · GitHub token〕") && !joined.includes("Q1w2E3r4T5"));

  const search = await mcp.tool("hub_search", { query: "needle-17" });
  assert.equal(search.isError, false);
  assert.match(search.text, /^3 places in this conversation match "needle-17", newest turn first:\n#2 · the user's words\n/u);
  assert.ok(search.text.includes("#1 · the output of tool call #1") && /read: hub_read_turn \{"n":1,"part":"output","tool":1,"offset":\d+\}/u.test(search.text), search.text);
  assert.match((await mcp.tool("hub_search", { query: "no such words anywhere" })).text, /^Nothing in this conversation matches "no such words anywhere" \(2 turns searched\)\./u);

  // Failures are results the model can read, not protocol errors and not stacks.
  for (const [args, wanted] of [[{ n: 9 }, "There is no turn 9; this conversation has 2 turns (1-2)."], [{ n: 1, part: "output" }, "needs tool"], [{ n: 1, part: "output", tool: 9 }, "there is no tool 9"],
    [{}, "n is required"], [{ n: 0 }, "n must be a whole number from 1"], [{ n: 1, part: "bogus" }, "part must be one of overview, user"]] as const) {
    const failed = await mcp.tool("hub_read_turn", args); assert.equal(failed.isError, true, JSON.stringify(args)); assert.ok(failed.text.includes(wanted), JSON.stringify(args) + ": " + failed.text);
  }
  assert.equal((await mcp.tool("hub_search", { query: "" })).isError, true);
  const unknown = await mcp.request("tools/call", { name: "hub_nothing", arguments: {} }); assert.equal(row(unknown.error).code, -32602);
  assert.equal(row((await mcp.request("resources/list")).error).code, -32601);
  assert.equal(await mcp.end(), 0, "the process ends when its input does"); assert.deepEqual(mcp.stderr, [], "nothing but protocol on stdout and nothing on stderr");
});

test("MCP: outside a Hub conversation it answers initialize and tools/list, and every call says there is nothing to read", async t => {
  for (const [label, env] of [["no variables", {}], ["no token", { [TABLE_ENV.url]: f.origin }], ["no address", { [TABLE_ENV.session]: f.token }], ["empty variables", { [TABLE_ENV.url]: "", [TABLE_ENV.session]: "" }]] as const) {
    const mcp = new Mcp(env); t.after(() => { mcp.child.kill("SIGKILL"); });
    await mcp.open();
    assert.deepEqual(((row((await mcp.request("tools/list")).result).tools) as Record<string, unknown>[]).map(item => item.name), [...TABLE_TOOLS], label);
    for (const [name, args] of [["hub_turns", {}], ["hub_read_turn", { n: 1 }], ["hub_search", { query: "x" }]] as const) {
      const result = await mcp.tool(name, args); assert.deepEqual(result, { text: TABLE_NOT_IN_SESSION, isError: true }, label + " " + name);
    }
    assert.equal(await mcp.end(), 0);
  }
});

test("MCP: a token the Hub does not know, a Hub that is not there, and an address that is not this computer's are told in a sentence", async t => {
  const wrong = new Mcp({ [TABLE_ENV.url]: f.origin, [TABLE_ENV.session]: "hht_" + "y".repeat(43) }); t.after(() => { wrong.child.kill("SIGKILL"); });
  await wrong.open();
  const refused = await wrong.tool("hub_turns", {}); assert.equal(refused.isError, true); assert.match(refused.text, /^HarnessHub does not accept this conversation's token/u);
  assert.ok(!refused.text.includes("yyyy"), "the token is never repeated");
  // Nothing listens on port 1.
  const gone = new Mcp({ [TABLE_ENV.url]: "http://127.0.0.1:1", [TABLE_ENV.session]: f.token }); t.after(() => { gone.child.kill("SIGKILL"); });
  await gone.open();
  const down = await gone.tool("hub_search", { query: "x" }); assert.equal(down.isError, true);
  assert.match(down.text, /^HarnessHub is not running at http:\/\/127\.0\.0\.1:1 \(connection refused\)\./u); assert.doesNotMatch(down.text, /\n\s+at |node:internal|ECONNREFUSED/u, "a sentence, not a stack");
  const far = new Mcp({ [TABLE_ENV.url]: "http://example.invalid:4317", [TABLE_ENV.session]: f.token }); t.after(() => { far.child.kill("SIGKILL"); });
  await far.open();
  const away = await far.tool("hub_turns", {}); assert.equal(away.isError, true); assert.match(away.text, /must be an http address on this computer/u);
  for (const mcp of [wrong, gone, far]) assert.equal(await mcp.end(), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The tool process: the command line
// ---------------------------------------------------------------------------------------------------------------------

function cli(args: readonly string[], env: Record<string, string>, program = hubTools): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise(done => execFile(process.execPath, [program, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20000 }, (error, stdout, stderr) =>
    done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr })));
}

test("the command line: turns, turn and search print what the MCP tools do; outside a conversation they say so and fail", async () => {
  const turns = await cli(["turns"], session());
  assert.equal(turns.code, 0, turns.stderr); assert.ok(turns.stdout.startsWith("Turns 1-2 of 2.\n#1 · tbl-a · completed · 2 tool calls · 1 file changed\n"), turns.stdout); assert.equal(turns.stderr, "");
  // Started through a link (a Harness may be given any path to it) it is still the program, not a silent no-op.
  const link = join(f.root, "hub-tools-link.js"); await symlink(hubTools, link);
  const linked = await cli(["turns"], session(), link); assert.deepEqual([linked.code, linked.stdout, linked.stderr], [0, turns.stdout, ""]);
  const one = await cli(["turn", "1", "--part", "output", "--tool=1", "--limit", "500"], session());
  assert.equal(one.code, 0, one.stderr); assert.match(one.stdout, /^Turn 1 of 2 · tbl-a · completed — output of tool 1 \(characters 0-\d+ of \d+\)\n/u);
  assert.match(one.stdout, /\[\d+ more characters\. Next page: hub-tools turn 1 --part output --tool 1 --offset \d+\]\n$/u);
  const search = await cli(["search", "needle-17"], session());
  assert.equal(search.code, 0, search.stderr); assert.match(search.stdout, /^3 places in this conversation match "needle-17"/u); assert.ok(search.stdout.includes("read: hub-tools turn 1 --part output --tool 1 --offset "));
  assert.equal((await cli(["search", "no", "such", "words"], session())).stdout.startsWith('Nothing in this conversation matches "no such words"'), true, "unquoted words are one phrase");
  const missing = await cli(["turn", "9"], session()); assert.deepEqual([missing.code, missing.stdout], [1, ""]); assert.equal(missing.stderr, "There is no turn 9; this conversation has 2 turns (1-2).\n");
  for (const args of [["turns"], ["turn", "1"], ["search", "x"]]) {
    const outside = await cli(args, {}); assert.deepEqual([outside.code, outside.stdout, outside.stderr], [1, "", TABLE_NOT_IN_SESSION + "\n"], args.join(" "));
  }
  const down = await cli(["turns"], { [TABLE_ENV.url]: "http://127.0.0.1:1", [TABLE_ENV.session]: f.token });
  assert.equal(down.code, 1); assert.match(down.stderr, /^HarnessHub is not running at http:\/\/127\.0\.0\.1:1/u);
  for (const args of [[], ["bogus"], ["turn"], ["turn", "1", "2"], ["search"], ["turns", "--nonsense"], ["turns", "now"]]) {
    const usage = await cli(args, session()); assert.equal(usage.code, 2, args.join(" ")); assert.match(usage.stderr, /hub-tools turns \[--from N\]/u);
  }
  const help = await cli(["--help"], {}); assert.deepEqual([help.code, help.stderr], [0, ""]); assert.match(help.stdout, /hub-tools mcp/u);
});
