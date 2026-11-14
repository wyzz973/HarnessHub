import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import type { RelayCapabilities } from "../../src/contracts/relay.js";
import type { SessionBindingFactory } from "../../src/contracts/session.js";
import type { RelayView, SessionCommitFrame, WireRun } from "../../src/contracts/web.js";
import { readWhole, type ReadConversation } from "../fixtures/http-conversation.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

// G073-S01 (security, AP-01–AP-03 of relay-architecture §12.4, RT4): the relay's HTTP API as a hostile page or a hostile
// Harness would use it. A real Gateway, real HTTP and real SQLite; the Harnesses are the fixture peers of the other web tests,
// so no real Harness is reached.

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
function row(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "an object was expected"); return value as Record<string, unknown>;
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/**
 * A Codex app-server peer that keeps what it was told in its thread's file, as a real one keeps its turns, and in the mode `e1`
 * says at once that it recorded the user's entry (E1). `session-peer.mjs` does none of this. (The same peer as
 * tests/integration/relay-api.test.ts.)
 */
const RECORDING_PEER = `import{existsSync,readFileSync,writeFileSync}from'node:fs';import{createInterface}from'node:readline';
const mode=process.argv[2]??'quiet';let thread='thread-'+process.pid,counter=0;
const file=()=>'peer-'+thread+'.json',load=()=>existsSync(file())?JSON.parse(readFileSync(file(),'utf8')):[];
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n'),notify=(method,params)=>emit({method,params});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')return emit({id:m.id,result:{userAgent:'recording-peer/1.0'}});
if(m.method==='initialized')return;
if(m.method==='thread/start'){writeFileSync(file(),'[]');notify('thread/started',{thread:{id:thread}});return emit({id:m.id,result:{thread:{id:thread}}});}
if(m.method==='thread/resume'){thread=m.params.threadId;if(!existsSync(file()))return emit({id:m.id,error:{code:-32001,message:'native state is missing'}});notify('thread/started',{thread:{id:thread}});return emit({id:m.id,result:{thread:{id:thread}}});}
if(m.method==='turn/start'){const id='turn-'+process.pid+'-'+(++counter),content=m.params.input,item={type:'userMessage',id:'user-'+id,clientUserMessageId:m.params.clientUserMessageId,content};
writeFileSync(file(),JSON.stringify([...load(),{id,item}]));
notify('turn/started',{threadId:thread,turn:{id,status:'inProgress'}});emit({id:m.id,result:{turn:{id,status:'inProgress'}}});
if(mode==='e1')notify('item/started',{threadId:thread,turnId:id,item});
notify('item/agentMessage/delta',{threadId:thread,turnId:id,itemId:'message-'+counter,delta:'recorded'});
notify('turn/completed',{threadId:thread,turn:{id,status:'completed'}});return;}
if(m.method==='thread/turns/list'){if(mode==='late'&&!existsSync('ready'))return emit({id:m.id,error:{code:-32000,message:'the thread cannot be read yet'}});return emit({id:m.id,result:{data:load().reverse().map(turn=>({id:turn.id,status:'completed',items:[turn.item,{type:'agentMessage',id:'agent-'+turn.id,text:'recorded'}]})),nextCursor:null}});}
if(m.id!==undefined&&typeof m.method==='string')emit({id:m.id,error:{code:-32601,message:'method not found'}});});
`;

interface Fixture {
  readonly root: string; readonly data: string; readonly workspace: string; readonly streams: Set<Stream>; readonly trace: string;
  gateway: WebServer; origin: string; port: number; token: string; cookie: string; csrf: string;
}
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-security-")), workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json"), trace = join(root, "trace.ndjson"), locks = join(root, "locks");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>HarnessGateway fixture</title>");
  const source = { repository: "fixture", revision: "relay-security", upstreamId: "peer", url: "https://example.invalid/relay-security-peer" };
  const recording = join(root, "recording-peer.mjs"); await writeFile(recording, RECORDING_PEER);
  // sec-a: ACP, no relay mechanism; sec-b: Codex app-server whose entries nothing confirms; sec-c: Codex app-server that says at once that it recorded each entry.
  const definitions = ["a", "b", "c"].map(name => ({ id: "sec-" + name, name: "Sec " + name, aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "sec-" + name + "-control", protocol: name === "a" ? "acp-v1" : "codex-app-server", executableNames: ["fixture-peer"],
      args: name === "c" ? [recording, "e1"] : [peer, name === "b" ? "codex-app-server" : "acp-v1", name, "basic"],
      env: { FIXTURE_TRACE: trace }, requiredExecutables: [], package: null, distribution: null, source }] }));
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(item => [item.controls[0]!.id, { executable: process.execPath }])) }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const gateway = await startWebServer({ installations: "any", root: join(root, "data"), configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: locks,
    application: (dataRoot, publish) => {
      const app = application(dataRoot, publish, { workspaceLockRoot: locks, installations: "any" });
      const factory = app.factory as unknown as { relayCapabilities?: SessionBindingFactory["relayCapabilities"] };
      factory.relayCapabilities = (selection): RelayCapabilities | null => selection.harnessId === "sec-b" || selection.harnessId === "sec-c" ? codexRelayCapabilities : null;
      return app;
    } });
  const parsed = new URL(gateway.url), f: Fixture = { root, data: join(root, "data"), workspace: configuration.workspace, streams: new Set(), trace, gateway, origin: parsed.origin, port: Number(parsed.port),
    token: new URLSearchParams(parsed.hash.slice(1)).get("token")!, cookie: "", csrf: "" };
  const response = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
  assert.equal(response.status, 200); f.cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!; f.csrf = String(row(await response.json()).csrfToken);
  t.after(async () => { for (const stream of f.streams) await stream.close(); try { await f.gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return f;
}
interface Reply { readonly status: number; readonly data: unknown; readonly text: string; readonly headers: IncomingHttpHeaders }
interface Raw { readonly method?: string; readonly path: string; readonly headers?: Record<string, string | undefined>; readonly body?: string | Buffer; readonly login?: boolean; readonly write?: boolean }
/** A request exactly as written: the path is not normalized and the headers are the caller's (a browser or an attacker would send these). */
function send(f: Fixture, input: Raw): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (input.login !== false) headers.Cookie = f.cookie;
  if (input.write === true) { headers.Origin = f.origin; headers["X-CSRF-Token"] = f.csrf; headers["Content-Type"] = "application/json"; }
  for (const [name, value] of Object.entries(input.headers ?? {})) { if (value === undefined) delete headers[name]; else headers[name] = value; }
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: f.port, method: input.method ?? "GET", path: input.path, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let data: unknown = null; try { data = JSON.parse(text); } catch { /* text */ } resolve({ status: response.statusCode ?? 0, data, text, headers: response.headers }); });
      response.on("error", reject);
    });
    req.on("error", reject); req.end(input.body);
  });
}
const get = (f: Fixture, path: string, headers: Raw["headers"] = {}) => send(f, { path, headers: { Origin: f.origin, ...headers } });
const write = (f: Fixture, method: string, path: string, value: unknown, headers: Raw["headers"] = {}) => send(f, { method, path, write: true, headers, body: JSON.stringify(value) });
let sequence = 0;
async function create(f: Fixture): Promise<string> {
  const reply = await write(f, "POST", "/api/v1/sessions", { selection: { harnessId: "sec-a" }, commandId: "create-" + ++sequence }); assert.equal(reply.status, 201, reply.text); return String(row(row(reply.data).head).id);
}
/** The conversation as a page reads it: the head and every Turn through the paged routes (the Runs with their relay facts are the Turns' Runs). */
async function view(f: Fixture, id: string): Promise<ReadConversation> { return readWhole(async path => { const reply = await get(f, path); assert.equal(reply.status, 200, reply.text); return reply.data; }, id); }
async function waitRun(f: Fixture, id: string, index: number): Promise<ReadConversation> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const current = await view(f, id); if (["completed", "failed", "cancelled", "unknown"].includes(current.runs[index]?.status ?? "")) return current;
    if (Date.now() > deadline) throw new Error("the Run did not end"); await delay(20);
  }
}
async function say(f: Fixture, id: string, text: string, key: string, index: number | null, relay?: unknown): Promise<Reply> {
  const reply = await write(f, "POST", `/api/v1/sessions/${id}/messages`, { text, commandId: key, ...(relay === undefined ? {} : { relay }) });
  if (reply.status === 202 && index !== null) await waitRun(f, id, index);
  return reply;
}
async function switchTo(f: Fixture, id: string, harnessId: string, key: string): Promise<void> {
  const epoch = (await view(f, id)).epoch;
  assert.equal((await write(f, "POST", `/api/v1/sessions/${id}/switches`, { selection: { harnessId }, commandId: key })).status, 202);
  for (let at = 0; at < 500; at++) { const current = await view(f, id); if (current.epoch === epoch + 1 && current.pendingSwitchId === null) return; await delay(20); }
  throw new Error("the switch did not take effect");
}
/** A → B → B: two packets reach sec-b (the second is the first sent again) and nothing confirms either; the first user message holds `first`. */
async function stranded(f: Fixture, first = "first"): Promise<string> {
  const id = await create(f);
  assert.equal((await say(f, id, first, "m1", 0)).status, 202);
  await switchTo(f, id, "sec-b", "to-b");
  assert.equal((await say(f, id, "second", "m2", 1)).status, 202);
  assert.equal((await say(f, id, "third", "m3", 2)).status, 202);
  return id;
}
const relayOf = async (f: Fixture, id: string): Promise<RelayView> => { const reply = await get(f, `/api/v1/sessions/${id}/relay`); assert.equal(reply.status, 200, reply.text); return reply.data as RelayView; };

/** One session stream read as it arrives (a reader that ran behind would make the server give it the facts whole and no notice). */
class Stream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>; private readonly decoder = new TextDecoder("utf-8", { fatal: true }); private buffer = "";
  readonly frames: Record<string, unknown>[] = []; readonly raw: string[] = []; private ended = false;
  constructor(response: Response, private readonly abort: AbortController) { assert.ok(response.body); this.reader = response.body.getReader(); void this.pump(); }
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.reader.read(); if (chunk.done) break;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        for (let at = this.buffer.indexOf("\n\n"); at >= 0; at = this.buffer.indexOf("\n\n")) {
          const block = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 2); this.raw.push(block);
          const data = block.split("\n").find(line => line.startsWith("data: "));
          if (data !== undefined && block.includes("event: session")) this.frames.push(row(JSON.parse(data.slice(6))));
        }
      }
    } catch { /* closed */ }
    this.ended = true;
  }
  get closed(): boolean { return this.ended; }
  async close(): Promise<void> { this.abort.abort(); try { await this.reader.cancel(); } catch { /* an intentional disconnect */ } }
}
async function openStream(f: Fixture, id: string): Promise<Stream> {
  const abort = new AbortController(), response = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream?afterSeq=0`, { headers: { Cookie: f.cookie, Origin: f.origin }, signal: abort.signal });
  assert.equal(response.status, 200); const stream = new Stream(response, abort); f.streams.add(stream); return stream;
}

// ---------------------------------------------------------------------------------------------------------------------
// AP: what the relay's answers hold
// ---------------------------------------------------------------------------------------------------------------------

// Shapes that look like what a leak scan hunts for, put together here so that this file holds none of them whole.
const MARKER = "RELAY-MARKER-" + "7f3a91c2e4", KEY_SHAPE = "sk-" + "ant-" + "fixture" + "0123456789abcdef0123456789", HOME_PATH = "/Users/" + "someone/.ssh/id_rsa";

test("AP-01–AP-03: nothing of the history, no native value and no digest leaves through the relay's own answers", async t => {
  const f = await fixture(t);
  const id = await create(f), live = await openStream(f, id);
  const first = `please keep ${MARKER}, the key ${KEY_SHAPE} and the file ${HOME_PATH}`;
  assert.equal((await say(f, id, first, "m1", 0)).status, 202);
  // sec-c says it recorded the entry (E1: an event with a mark in it); sec-b leaves its packets unconfirmed.
  await switchTo(f, id, "sec-c", "to-c");
  assert.equal((await say(f, id, "second", "m2", 1)).status, 202);
  await switchTo(f, id, "sec-b", "to-b");
  assert.equal((await say(f, id, "third", "m3", 2)).status, 202);
  assert.equal((await say(f, id, "fourth", "m4", 3)).status, 202);
  // Nothing is refused for the relay's sake: the fifth goes as typed, and says why in fixed words.
  const fifth = await write(f, "POST", `/api/v1/sessions/${id}/messages`, { text: "fifth", commandId: "m5" });
  assert.equal(fifth.status, 202, fifth.text); await waitRun(f, id, 4);
  const model = await relayOf(f, id), conversation = await view(f, id);
  assert.deepEqual(conversation.runs[4]!.relay?.decision, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" });
  assert.equal(model.packets.length, 3);
  assert.deepEqual(model.packets.map(item => [item.target.harnessId, item.delivery, item.evidence]), [["sec-c", "recorded", "E1"], ["sec-b", "unknown", null], ["sec-b", "unknown", null]]);
  // What the packets hold is the history itself; the check below is that the answers about them hold none of it.
  const bodies: string[] = [];
  for (const packet of model.packets) {
    const reply = await get(f, `/api/v1/sessions/${id}/relay/${packet.packetId}`); assert.equal(reply.status, 200); bodies.push(reply.text);
  }
  assert.ok(bodies.some(text => text.includes(MARKER)), "the packet carries the user's words, as it was sent (the premise of this test)");
  const hidden = [MARKER, KEY_SHAPE, HOME_PATH, ...bodies.map(text => sha256(text)), ...bodies.map(text => createHash("sha1").update(text).digest("hex")), sha256(MARKER), sha256(first), sha256(KEY_SHAPE),
    f.root, f.data, f.workspace, "relay_bodies", "gateway.sqlite", "file_offset", "position", "inputHmac", "setHmac", "handoffLogSeq", "keyId"];
  await delay(150);
  const answers: [string, string][] = [["GET …/relay", JSON.stringify(model)], ["the answer to the fifth message", JSON.stringify(fifth.data)],
    ...live.frames.filter(frame => frame.type === "relay").map((frame, index): [string, string] => ["relay frame " + index, JSON.stringify(frame)]),
    ...conversation.runs.map((run, index): [string, string] => ["Run " + index + " relay member", JSON.stringify(run.relay)]),
    // A snapshot holds the Runs of its window; a commit frame holds the Runs that began or changed in that commit: the relay member of each, wherever the page is told it.
    ...live.frames.flatMap((frame, index): [string, string][] => {
      const runs = frame.type === "snapshot" ? (row(row(frame.session).window).turns as { run: { relay?: unknown } }[]).map(turn => turn.run)
        : frame.type === "commit" ? ((frame as unknown as SessionCommitFrame).runs ?? []) as readonly WireRun[] : [];
      return runs.map((run, at): [string, string] => [String(frame.type) + " " + index + " Run " + at + " relay member", JSON.stringify(run.relay ?? null)]);
    })];
  const kinds = new Set(live.frames.filter(frame => frame.type === "relay").map(frame => row(frame.event).type));
  assert.ok(kinds.has("relay.input_recorded"), "the flow produced the relay frames to look at: " + [...kinds].join());
  assert.ok(answers.some(([label, wire]) => label.startsWith("commit ") && wire.includes("packetId")), "the flow produced commit frames that tell a Run's relay member (a packet among them) to look at");
  // No keyed or plain digest of anything, nor a mark, whatever its field is called: 64 hex digits appear in none of them.
  for (const [label, wire] of answers) assert.equal(/[0-9a-f]{64}/u.test(wire), false, label + " holds a digest");
  for (const [label, wire] of answers) for (const needle of hidden) assert.equal(wire.includes(needle), false, label + " holds " + needle.slice(0, 24));
  // And the shapes are closed: a field nobody listed cannot appear unnoticed.
  assert.deepEqual(Object.keys(row(fifth.data)).sort(), ["replayed", "runId", "sessionId"]);
  for (const frame of live.frames.filter(item => item.type === "relay")) { assert.deepEqual(Object.keys(frame).sort(), ["event", "lastSeq", "sessionId", "type", "version"]); assert.ok(Object.keys(row(frame.event)).every(key => ["type", "sessionId", "runId", "packetId", "at"].includes(key))); }
  for (const run of conversation.runs) if (run.relay !== undefined) assert.ok(Object.keys(run.relay).every(key => ["packetId", "kind", "continuity", "executedOn", "delivery", "decision"].includes(key)), JSON.stringify(Object.keys(run.relay)));
  // What a Run says of the relay's decision is fixed words: a kind, who decided, a cause from the closed list, a reason word, and how a packet was sent again.
  for (const run of conversation.runs) for (const [key, value] of Object.entries(run.relay?.decision ?? {})) assert.ok(["kind", "by", "cause", "reason", "resend"].includes(key) && /^[a-z_]{1,40}$/u.test(String(value)), key + "=" + String(value));
  // A Run's `relayRequest` holds an HMAC of the user's choices: it does not leave, not with the Run and not in the events either.
  for (const run of conversation.runs) assert.equal("relayRequest" in run, false, "the Run holds no relayRequest");
  const events = await get(f, `/api/v1/sessions/${id}/events?limit=100`), accepted = (row(events.data).events as { type: string; data: Record<string, unknown> }[]).filter(item => item.type === "message.accepted");
  assert.ok(accepted.length >= 4, "the message events are in the page"); for (const item of accepted) assert.equal(JSON.stringify(item).includes("fingerprint"), false, "an accepted message keeps no fingerprint in the page of events");
  const allowed = ["attention", "canConfirm", "cleared", "controlId", "evidence", "harnessId", "nativeEpoch", "owed", "sync", "throughRun"];
  for (const binding of model.bindings) {
    assert.ok(Object.keys(binding).every(key => allowed.includes(key)), JSON.stringify(Object.keys(binding)));
    for (const required of ["cleared", "controlId", "evidence", "harnessId", "nativeEpoch", "sync", "throughRun"]) assert.ok(required in binding, required);
    if (binding.attention !== undefined) {
      assert.ok(Object.keys(binding.attention).every(key => ["cause", "options", "counts", "key", "packet"].includes(key)), JSON.stringify(Object.keys(binding.attention)));
      assert.ok(["delivery_unconfirmed", "attach_available"].includes(binding.attention.cause) && binding.attention.options.every(option => option === "attach_full"), JSON.stringify(binding.attention));
    }
  }
  // The text of a packet is a real read of the user's data, so it is not served to a caller that is not logged in.
  for (const packet of model.packets) assert.equal((await send(f, { path: `/api/v1/sessions/${id}/relay/${packet.packetId}`, login: false })).status, 401);
});

test("a packet is plain text: its bytes cannot be read as a page, however hostile the words in it", async t => {
  const f = await fixture(t), hostile = "<script>alert(1)</script><img src=x onerror=alert(2)><svg onload=alert(3)>";
  const id = await stranded(f, hostile), model = await relayOf(f, id);
  for (const packet of model.packets) {
    for (const method of ["GET", "HEAD"]) {
      const reply = await send(f, { method, path: `/api/v1/sessions/${id}/relay/${packet.packetId}`, headers: { Origin: f.origin } });
      assert.equal(reply.status, 200); assert.equal(reply.headers["content-type"], "text/plain; charset=utf-8"); assert.equal(reply.headers["x-content-type-options"], "nosniff");
      assert.equal(reply.headers["content-security-policy"], "default-src 'none'; sandbox"); assert.equal(reply.headers["x-frame-options"], "DENY"); assert.equal(reply.headers["referrer-policy"], "no-referrer");
      assert.equal(reply.headers["content-disposition"], undefined, "it is not offered as a file"); assert.equal(reply.headers["access-control-allow-origin"], undefined, "no other origin may read it");
      assert.equal(reply.headers["cache-control"], "private, no-cache");
      if (method === "GET") assert.ok(reply.text.includes(hostile) || packet.number > 1, "the words are in the text as they were sent, not rewritten for the page");
    }
  }
  // The JSON answers are JSON, never anything a page would run.
  for (const path of [`/api/v1/sessions/${id}/relay`, "/api/v1/relay/prefs"]) { const reply = await get(f, path); assert.match(String(reply.headers["content-type"]), /^application\/json/u); assert.equal(reply.headers["x-content-type-options"], "nosniff"); }
});

// ---------------------------------------------------------------------------------------------------------------------
// AP: whose packet it is
// ---------------------------------------------------------------------------------------------------------------------

test("a packet is read only through its own conversation, and no read tells whether it exists in another", async t => {
  const f = await fixture(t), mine = await stranded(f), other = await create(f), packets = (await relayOf(f, mine)).packets;
  assert.equal(packets.length, 2); assert.deepEqual(await relayOf(f, other), { bindings: [], packets: [], handedOver: ["sec-b"] }, "nothing of another conversation, only the Harnesses this installation handed a conversation to");
  const unknown = await get(f, `/api/v1/sessions/${other}/relay/relay-${"0".repeat(20)}`);
  for (const packet of packets) {
    const path = `/api/v1/sessions/${other}/relay/${packet.packetId}`, etag = `"${sha256((await get(f, `/api/v1/sessions/${mine}/relay/${packet.packetId}`)).text)}"`;
    // Whatever the method or the conditions, the packet of another conversation is exactly as absent as one that never was.
    for (const headers of [{}, { "If-None-Match": etag }, { "If-None-Match": "*" }, { Range: "bytes=0-10" }, { "If-Match": etag }]) {
      const reply = await get(f, path, headers);
      assert.equal(reply.status, 404, JSON.stringify(headers)); assert.equal(reply.text, unknown.text, JSON.stringify(headers)); assert.equal(reply.headers.etag, undefined); assert.equal(reply.headers["content-type"]?.startsWith("application/json"), true);
    }
    const head = await send(f, { method: "HEAD", path, headers: { Origin: f.origin } }); assert.equal(head.status, 404); assert.equal(head.headers.etag, undefined);
    // Its own conversation still reads it.
    assert.equal((await get(f, `/api/v1/sessions/${mine}/relay/${packet.packetId}`)).status, 200);
  }
  assert.equal(unknown.text.includes("session-"), false, "no identity is echoed"); assert.equal(unknown.text.includes(other), false);
  // Another conversation's relay model is its own: nothing of the first one's packets, bindings or Runs.
  assert.equal(JSON.stringify(await relayOf(f, other)).includes(packets[0]!.packetId), false);
});

test("a packet identity that is not an identity is no route, and a session identity that is not one is refused, whatever it holds", async t => {
  const f = await fixture(t), id = await stranded(f), good = (await relayOf(f, id)).packets[0]!.packetId;
  const suffixes = [
    "relay-", "relay-0", "relay-" + "0".repeat(19), "relay-" + "0".repeat(21), "relay-" + "0".repeat(200), "RELAY-" + "0".repeat(20), "relay-" + "I".repeat(20), "relay-" + "i".repeat(20), "relay-" + "u".repeat(20),
    "relay-" + "o".repeat(20), "relay-" + "l".repeat(20), good + "/", good + "/x", good + "%2f", good.replace("relay-", "relay-%2e%2e%2f"), "..%2f..%2frelay", "%2e%2e/" + good, "%00" + good, good + "%00",
    "relay-%27%20OR%20%271%27%3D%271", "relay-%3Cscript%3E", "relay-%0d%0aSet-Cookie:%20x=1", "relay-%e2%80%ae" + "0".repeat(15), "relay-" + "%c0%af".repeat(5), "relay-" + "0".repeat(2000), "preview", "observe", "pins", "exclusions", "consents", "%5c" + good,
  ];
  for (const suffix of suffixes) {
    const reply = await get(f, `/api/v1/sessions/${id}/relay/${suffix}`);
    assert.ok(reply.status === 400 || reply.status === 404, suffix.slice(0, 40) + " → " + reply.status + " " + reply.text.slice(0, 120));
    assert.equal(reply.headers["set-cookie"], undefined, "a header cannot be planted"); assert.notEqual(reply.headers.etag, "x=1");
    // The answer speaks in fixed words: whatever was asked for, decoded or not, is not repeated in it.
    let decoded = suffix; try { decoded = decodeURIComponent(suffix); } catch { /* not a valid escape: the raw spelling is all there is */ }
    for (const spelling of [suffix, decoded]) if (spelling.length >= 8) assert.equal(reply.text.includes(spelling), false, "the input is echoed: " + suffix.slice(0, 30));
    assert.doesNotMatch(reply.text, /Error:|\bat \S+\.(?:ts|js):\d+|node:internal/u, "no stack");
  }
  const sessions = ["session-", "session-%00", "session-%27%20OR%201%3D1", "session-..%2f", "not-a-session", "session-" + "a".repeat(300), "SESSION-x", "session-%E2%80%AE"];
  for (const session of sessions) {
    for (const path of [`/api/v1/sessions/${session}/relay`, `/api/v1/sessions/${session}/relay/${good}`]) {
      const reply = await get(f, path);
      assert.ok([400, 404].includes(reply.status), path.slice(0, 60) + " → " + reply.status); assert.equal(reply.status === 200, false);
      assert.doesNotMatch(reply.text, /Error:|\bat \S+\.(?:ts|js):\d+|node:internal|SQLITE|gateway\.sqlite/u, "no stack or storage detail");
    }
  }
  // An address that is too long for the Gateway at all is refused before any route reads it.
  const long = await get(f, `/api/v1/sessions/${id}/relay/` + "a".repeat(5000)); assert.equal(long.status, 400); assert.equal(row(long.data).code, "INVALID_PATH");
});

// ---------------------------------------------------------------------------------------------------------------------
// CSRF, Origin, login
// ---------------------------------------------------------------------------------------------------------------------

test("every relay route needs the login, and a write needs this Gateway's own origin and its token", async t => {
  const f = await fixture(t), id = await stranded(f), packet = (await relayOf(f, id)).packets[0]!.packetId;
  const prefs = (await get(f, "/api/v1/relay/prefs")).text, runs = (await view(f, id)).runs.length;
  const reads = [`/api/v1/sessions/${id}/relay`, `/api/v1/sessions/${id}/relay/${packet}`, "/api/v1/relay/prefs"];
  // Not logged in: nothing is read and nothing is written.
  for (const path of reads) { const reply = await send(f, { path, login: false }); assert.equal(reply.status, 401, path); assert.equal(row(reply.data).code, "AUTH_REQUIRED"); }
  for (const [method, path, value] of [["PUT", "/api/v1/relay/prefs", { key: "relay.attach", value: "off" }], ["POST", `/api/v1/sessions/${id}/messages`, { text: "x", commandId: "nologin", relay: { attach: "none" } }]] as const) {
    const reply = await send(f, { method, path, login: false, write: true, body: JSON.stringify(value) }); assert.equal(reply.status, 401, path);
  }
  // Another site's page: the cookie is SameSite=Strict, and a request that still arrives is refused by what it says it is.
  for (const path of reads) {
    for (const headers of [{ Origin: "https://attacker.invalid" }, { Origin: f.origin, "Sec-Fetch-Site": "cross-site" }, { Origin: "null" }, { Origin: f.origin + ".attacker.invalid" }]) {
      const reply = await get(f, path, headers); assert.equal(reply.status, 403, path + JSON.stringify(headers)); assert.equal(row(reply.data).code, "ORIGIN_REJECTED");
    }
    const host = await send(f, { path, headers: { Host: "attacker.invalid" } }); assert.equal(host.status, 403, path); assert.equal(row(host.data).code, "HOST_REJECTED");
    const preflight = await send(f, { method: "OPTIONS", path, headers: { Origin: "https://attacker.invalid", "Access-Control-Request-Method": "PUT" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined); assert.notEqual(preflight.status, 200);
  }
  const body = JSON.stringify({ key: "relay.attach", value: "off" });
  const attempts: readonly [string, Raw][] = [
    ["no origin", { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { Origin: undefined }, body }],
    ["another origin", { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { Origin: "https://attacker.invalid" }, body }],
    ["no token", { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "X-CSRF-Token": undefined }, body }],
    ["a wrong token", { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "X-CSRF-Token": "0".repeat(64) }, body }],
    ["a token of another length", { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "X-CSRF-Token": "0" }, body }],
    ["the token as a query", { method: "PUT", path: "/api/v1/relay/prefs?csrf=" + "x", write: true, headers: { "X-CSRF-Token": undefined }, body }],
    ["a cross-site fetch", { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "Sec-Fetch-Site": "cross-site" }, body }],
  ];
  for (const [label, input] of attempts) { const reply = await send(f, input); assert.ok([400, 403].includes(reply.status), label + " → " + reply.status + " " + reply.text); assert.notEqual(reply.status, 200, label); }
  const wrongToken = await send(f, { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "X-CSRF-Token": "0".repeat(64) }, body }); assert.equal(row(wrongToken.data).code, "CSRF_REJECTED");
  const noOrigin = await send(f, { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { Origin: undefined }, body }); assert.equal(row(noOrigin.data).code, "ORIGIN_REQUIRED");
  // The same for a send that carries a relay choice: refused before the Runtime hears of it.
  for (const headers of [{ "X-CSRF-Token": "f".repeat(64) }, { "X-CSRF-Token": undefined }, { Origin: "https://attacker.invalid" }]) {
    const reply = await send(f, { method: "POST", path: `/api/v1/sessions/${id}/messages`, write: true, headers, body: JSON.stringify({ text: "forged", commandId: "forged-" + ++sequence, relay: { attach: "none" } }) });
    assert.equal(reply.status, 403, JSON.stringify(headers));
  }
  assert.equal((await get(f, "/api/v1/relay/prefs")).text, prefs, "no preference was written"); assert.equal((await view(f, id)).runs.length, runs, "no Run was made");
  // A body that is not JSON is not read as a form (the way a cross-site form would send one).
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const reply = await send(f, { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "Content-Type": type }, body }); assert.equal(reply.status, 415, type);
  }
  assert.equal((await send(f, { method: "PUT", path: "/api/v1/relay/prefs", write: true, headers: { "Content-Encoding": "gzip" }, body })).status, 415);
  assert.equal((await get(f, "/api/v1/relay/prefs")).text, prefs);
});

// ---------------------------------------------------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------------------------------------------------

test("a hostile relay member or preference is refused whole, and nothing of it is kept, run or echoed", async t => {
  const f = await fixture(t), id = await create(f), prefs = (await get(f, "/api/v1/relay/prefs")).text;
  const huge = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => ["field" + index, index]));
  let deep: unknown = "end"; for (let level = 0; level < 200; level++) deep = { next: deep };
  const members: readonly [string, unknown][] = [
    ["a prototype key", JSON.parse('{"__proto__":{"attach":"none"}}')], ["a constructor key", JSON.parse('{"constructor":{"prototype":{"attach":"none"}}}')],
    ["a thousand fields", huge], ["a deep value", { attach: deep }], ["an attach as an object", { attach: { valueOf: "none" } }], ["an attach of no word of the relay's", { attach: "everything" }],
    // What the relay used to be asked and no longer is: refused like any field it does not know, never read as an old choice.
    ["a consent", { consent: { vendor: "gateway:llm.example.com\nSet-Cookie: x=1", decision: "acknowledged", scope: "global" } }], ["a consent of another type", { consent: { vendor: { toString: "x" }, decision: "acknowledged", scope: "global" } }],
    ["a deep consent", { consent: deep }], ["a note", { note: "字".repeat(1400) }], ["a note with a control", { note: "line\u001bescape" }], ["a tier as an object", { tier: { toString: "full" } }],
    ["a new native session", { native: "new" }], ["a resend", { resend: true }], ["a confirmed clear", { clearConfirmed: true }],
  ];
  for (const [label, relay] of members) {
    const reply = await write(f, "POST", `/api/v1/sessions/${id}/messages`, { text: "hostile", commandId: "hostile-" + ++sequence, relay });
    assert.ok([400, 413].includes(reply.status), label + " → " + reply.status + " " + reply.text.slice(0, 160));
    assert.doesNotMatch(reply.text, /Error:|node:internal|\bat \S+\.(?:ts|js):\d+/u, label); assert.equal(reply.text.includes("Set-Cookie"), false, label + ": the input was echoed");
  }
  assert.equal(({} as Record<string, unknown>).attach, undefined, "no prototype was touched"); assert.equal(Object.hasOwn(Object.prototype, "attach"), false);
  assert.equal((await view(f, id)).runs.length, 0, "no refused request made a Run");
  const hostile: readonly [string, unknown][] = [["a key that is a path", { key: "../../etc/passwd", value: "off" }], ["a key with SQL", { key: "relay.attach' OR '1'='1", value: "off" }], ["a value with SQL", { key: "relay.attach", value: "off'); DROP TABLE relay_prefs;--" }],
    ["a value over its bytes", { key: "relay.attach", value: "a".repeat(65) }], ["a huge value", { key: "relay.attach", value: "a".repeat(100_000) }], ["a key with NUL", { key: "relay.attach\u0000", value: "off" }],
    ["a key the relay no longer has", { key: "relay.crossVendor", value: "ask" }], ["a value of another key", { key: "relay.attach", value: "ask" }],
    ["inherited fields", JSON.parse('{"key":"relay.attach","value":"off","__proto__":{"x":1}}')]];
  for (const [label, input] of hostile) { const reply = await write(f, "PUT", "/api/v1/relay/prefs", input); assert.ok([400, 413].includes(reply.status), label + " → " + reply.status); assert.doesNotMatch(reply.text, /DROP TABLE|passwd|Error:|node:internal/u, label); }
  assert.equal((await get(f, "/api/v1/relay/prefs")).text, prefs, "no refused write changed a preference");
  // The table the preferences live in is still there, with its constraint: a legal write still works afterwards.
  assert.equal((await write(f, "PUT", "/api/v1/relay/prefs", { key: "relay.attach", value: "off" })).status, 200);
  assert.deepEqual(row(row((await get(f, "/api/v1/relay/prefs")).data).prefs), { "relay.attach": "off", "hub.progress": "auto" });
  // A body past the Gateway's limit, and one that is not UTF-8 JSON, are refused before they are read as a request.
  assert.equal((await send(f, { method: "PUT", path: "/api/v1/relay/prefs", write: true, body: JSON.stringify({ key: "relay.attach", value: "x".repeat(200_000) }) })).status, 413);
  assert.equal((await send(f, { method: "PUT", path: "/api/v1/relay/prefs", write: true, body: Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) })).status, 400);
  assert.equal((await send(f, { method: "POST", path: `/api/v1/sessions/${id}/messages`, write: true, body: '{"text":"x","commandId":"c","relay":' })).status, 400);
  assert.equal((await view(f, id)).runs.length, 0);
});

test("nothing is refused for the relay's sake, and what a Run says of it names only fixed words, never a path of this computer", async t => {
  const f = await fixture(t), id = await stranded(f);
  const before = await view(f, id), model = await relayOf(f, id);
  // Two packets went and nothing confirmed either: the page is offered the one way out, and the next message still goes.
  const binding = model.bindings.find(item => item.attention !== undefined);
  assert.deepEqual([binding?.attention?.cause, binding?.attention?.options], ["delivery_unconfirmed", ["attach_full"]]);
  const fourth = await write(f, "POST", `/api/v1/sessions/${id}/messages`, { text: "fourth", commandId: "m4" }); assert.equal(fourth.status, 202, fourth.text); await waitRun(f, id, 3);
  const after = await view(f, id); assert.equal(after.runs.length, before.runs.length + 1); assert.equal(after.runs[3]!.status, "completed");
  assert.equal(JSON.stringify(after.runs.map(run => run.relay)).includes(f.root), false, "no path of this computer is in what a Run says of the relay"); assert.equal(JSON.stringify(await relayOf(f, id)).includes(f.root), false); assert.equal(fourth.text.includes(f.root), false);
});
