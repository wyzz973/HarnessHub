import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { application } from "../../src/cli/session-application.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import {
  RELAY_PREF_DEFAULTS, RELAY_PREF_KEYS, RELAY_PREF_VALUES, RelayError, parseDeliveryRecord, parseRelayPacket, relayPacketId,
  type BindingRelayState, type DeliveryOutcome, type DeliveryRecord, type Fingerprint, type RelayCapabilities, type RelayPacket, type RelayPacketId,
} from "../../src/contracts/relay.js";
import {
  SessionError, commandId, messageId, runId, sessionId,
  type NativeSessionBinding, type PublicRun, type SessionBindingFactory, type SessionEvent, type SessionId, type SessionSnapshot,
} from "../../src/contracts/session.js";
import type { RelayBindingView, RelayPacketView, RelayStreamFrame, RelayView, SessionView, WebError } from "../../src/contracts/web.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { RelayApi, parseSendRelay, relayOptions, type RelayReads } from "../../src/web/relay-routes.js";
import { SessionStreamHub, relayStreamEvent, type SessionStreamSink } from "../../src/web/session-stream.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

// G073 (backend): the relay's HTTP API over a real Gateway, real HTTP and real SQLite, with fixture Harnesses that are real
// child processes (the ACP and Codex app-server peers of the other web tests). Nothing here reaches a real Harness.
//
// The fixture admits as the Gateway will once its factory declares the Drivers' relay mechanisms (G072): `rapi-a` runs on the
// generic ACP Driver, which declares none, and `rapi-b` on the Codex app-server Driver, whose declaration is the real one.

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
function row(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "an object was expected"); return value as Record<string, unknown>;
}
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Injection { error: Error | null }
interface Fixture {
  readonly root: string; readonly data: string; readonly workspace: string; readonly assets: string; readonly locks: string; readonly trace: string;
  readonly configuration: Awaited<ReturnType<typeof prepareConfiguration>>; readonly inject: Injection; readonly streams: Set<Stream>;
  gateway: WebServer; origin: string; token: string; cookie: string; csrf: string;
}
async function boot(f: Fixture): Promise<void> {
  f.gateway = await startWebServer({ installations: "any", root: f.data, configuration: f.configuration, port: 0, assetsDirectory: f.assets, workspaceLockRoot: f.locks,
    application: (root, publish) => {
      const app = application(root, publish, { workspaceLockRoot: f.locks, installations: "any" });
      // Admission reads the Driver's static declaration from the factory (G072 wires the real one): the Codex Driver's for rapi-b, none for rapi-a.
      const factory = app.factory as unknown as { relayCapabilities?: SessionBindingFactory["relayCapabilities"] };
      factory.relayCapabilities = (selection): RelayCapabilities | null => selection.harnessId === "rapi-b" ? codexRelayCapabilities : null;
      // A relay error the Runtime has no way to raise yet is raised for the next send (the error body is the API's, not the Runtime's).
      const runtime = app.runtime as unknown as { send: (...args: unknown[]) => unknown }, real = runtime.send.bind(app.runtime);
      runtime.send = (...args: unknown[]) => { const error = f.inject.error; if (error !== null) { f.inject.error = null; throw error; } return real(...args); };
      return app;
    } });
  const parsed = new URL(f.gateway.url); f.origin = parsed.origin; f.token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  const response = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
  assert.equal(response.status, 200, await response.clone().text());
  f.cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!; f.csrf = String(row(await response.json()).csrfToken);
}
/**
 * A Codex app-server peer that keeps what it was told in its thread's file, as a real one keeps its turns: it answers the
 * Driver's reading of the thread (`thread/turns/list`), so a packet it was sent can be found again afterwards (E2), and in the
 * mode `e1` it also says at once that it recorded the user's entry (E1). In the mode `late` it cannot be read until a file
 * `ready` appears in its workspace. `session-peer.mjs` does none of this.
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
interface FixtureOptions { /** rapi-b runs this Codex app-server peer instead of the fixture's, in this mode. */ readonly recording?: "e1" | "quiet" | "late" }
async function fixture(t: test.TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-api-")), workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json"), trace = join(root, "trace.ndjson");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>HarnessGateway fixture</title>");
  const recording = join(root, "recording-peer.mjs"); await writeFile(recording, RECORDING_PEER);
  const source = { repository: "fixture", revision: "relay-api", upstreamId: "peer", url: "https://example.invalid/relay-api-peer" };
  const definitions = ["a", "b"].map(name => ({ id: "rapi-" + name, name: "Rapi " + name, aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "rapi-" + name + "-control", protocol: name === "b" ? "codex-app-server" : "acp-v1", executableNames: ["fixture-peer"],
      args: name === "b" && options.recording !== undefined ? [recording, options.recording] : [peer, name === "b" ? "codex-app-server" : "acp-v1", name, "basic"],
      env: { FIXTURE_TRACE: trace }, requiredExecutables: [], package: null, distribution: null, source }] }));
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(item => [item.controls[0]!.id, { executable: process.execPath }])) }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const f = { root, data: join(root, "data"), workspace: configuration.workspace, assets, locks: join(root, "locks"), trace, configuration, inject: { error: null } as Injection, streams: new Set<Stream>(),
    gateway: undefined as unknown as WebServer, origin: "", token: "", cookie: "", csrf: "" } satisfies Fixture;
  await boot(f);
  t.after(async () => { for (const stream of f.streams) await stream.close(); try { await f.gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return f;
}
interface Reply { readonly status: number; readonly data: unknown; readonly text: string; readonly headers: Headers }
async function call(f: Fixture, path: string, method = "GET", input?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(f.origin + path, { method, headers: { Cookie: f.cookie, Origin: f.origin,
    ...(method === "GET" || method === "HEAD" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": f.csrf }), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); let data: unknown = null; try { data = JSON.parse(text); } catch { /* a text answer */ }
  return { status: response.status, data, text, headers: response.headers };
}
let sequence = 0;
async function create(f: Fixture, harnessId = "rapi-a"): Promise<string> {
  const response = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId }, commandId: "create-" + ++sequence }); assert.equal(response.status, 201, response.text);
  return String(row(response.data).id);
}
async function view(f: Fixture, id: string): Promise<SessionView> {
  const response = await call(f, "/api/v1/sessions/" + id); assert.equal(response.status, 200, response.text); return response.data as SessionView;
}
async function waitFor(f: Fixture, id: string, predicate: (value: SessionView) => boolean): Promise<SessionView> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const current = await view(f, id); if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error("the conversation did not reach the expected state: " + JSON.stringify(current.runs.map(run => run.status)));
    await delay(20);
  }
}
const done = (value: SessionView, index: number) => ["completed", "failed", "cancelled", "unknown"].includes(value.runs[index]?.status ?? "");
/** Sends one message and waits for its Run (index `index`) to end; the reply of a refusal is returned without waiting. */
async function say(f: Fixture, id: string, text: string, key: string, index: number | null, relay?: unknown): Promise<Reply> {
  const reply = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text, commandId: key, ...(relay === undefined ? {} : { relay }) });
  if (reply.status === 202 && index !== null) await waitFor(f, id, value => done(value, index));
  return reply;
}
async function switchTo(f: Fixture, id: string, harnessId: string, key: string): Promise<void> {
  const epoch = (await view(f, id)).epoch;
  assert.equal((await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId }, commandId: key })).status, 202);
  await waitFor(f, id, value => value.epoch === epoch + 1 && value.pendingSwitchId === null);
}
async function relayOf(f: Fixture, id: string): Promise<RelayView> {
  const response = await call(f, `/api/v1/sessions/${id}/relay`); assert.equal(response.status, 200, response.text); return response.data as RelayView;
}
async function prompts(f: Fixture): Promise<string[]> {
  return (await readFile(f.trace, "utf8")).trim().split("\n").map(line => row(JSON.parse(line))).filter(item => item.kind === "prompt").map(item => String(item.prompt));
}
/**
 * These tests are about the answers that remain when the user asks to be asked. Where the Runtime has a preference for how it
 * settles an uncertain delivery itself (`relay.whenUnsure`, the permissive defaults of 2026-11-10), they choose `ask`, which is
 * how the Runtime answered before it existed; where it has none, this is nothing.
 */
async function askWhenUnsure(f: Fixture): Promise<void> {
  if (!(RELAY_PREF_KEYS as readonly string[]).includes("relay.whenUnsure")) return;
  const reply = await call(f, "/api/v1/relay/prefs", "PUT", { key: "relay.whenUnsure", value: "ask" }); assert.equal(reply.status, 200, reply.text);
}
/** A → B → B: the Run on rapi-b carries a packet nothing confirms (the peer shows no entry of it), and the next one carries another. */
async function stranded(f: Fixture): Promise<string> {
  await askWhenUnsure(f);
  const id = await create(f);
  assert.equal((await say(f, id, "first", "m1", 0)).status, 202);
  await switchTo(f, id, "rapi-b", "to-b");
  assert.equal((await say(f, id, "second", "m2", 1)).status, 202);
  assert.equal((await say(f, id, "third", "m3", 2)).status, 202);
  return id;
}

/**
 * One session stream, read as it arrives: a reader that ran behind would back the server's socket up, and a backed-up
 * subscription is given the facts whole and no notice (which is right, and not what these tests are about). `received` is
 * everything read so far; `next` and `until` hand it out in order.
 */
class Stream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>; private readonly decoder = new TextDecoder("utf-8", { fatal: true }); private buffer = "";
  readonly received: { readonly id: number; readonly frame: Record<string, unknown> }[] = [];
  private cursor = 0; private wake: (() => void) | null = null; private ended = false;
  constructor(response: Response, private readonly abort: AbortController) { assert.ok(response.body); this.reader = response.body.getReader(); void this.pump(); }
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.reader.read(); if (chunk.done) break;
        this.buffer += this.decoder.decode(chunk.value, { stream: true });
        for (let at = this.buffer.indexOf("\n\n"); at >= 0; at = this.buffer.indexOf("\n\n")) {
          const block = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 2);
          const lines = block.split("\n"), data = lines.find(line => line.startsWith("data: "));
          // Heartbeats and the waiting-request lists (no event id) are not session facts.
          if (data !== undefined && block.includes("event: session")) this.received.push({ id: Number(lines.find(line => line.startsWith("id: "))!.slice(4)), frame: row(JSON.parse(data.slice(6))) });
        }
        this.wake?.();
      }
    } catch { /* the stream was closed */ }
    this.ended = true; this.wake?.();
  }
  async next(): Promise<{ readonly id: number; readonly frame: Record<string, unknown> }> {
    const deadline = Date.now() + 8000;
    while (this.cursor >= this.received.length) {
      if (this.ended) throw new Error("the stream ended before the expected frame");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.wake = null; reject(new Error("no frame arrived in time")); }, Math.max(1, deadline - Date.now()));
        this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
      });
    }
    return this.received[this.cursor++]!;
  }
  async until(predicate: (frame: Record<string, unknown>) => boolean): Promise<{ readonly id: number; readonly frame: Record<string, unknown> }> {
    for (let count = 0; count < 400; count++) { const next = await this.next(); if (predicate(next.frame)) return next; }
    throw new Error("the stream did not carry the expected frame");
  }
  async close(): Promise<void> { this.abort.abort(); try { await this.reader.cancel(); } catch { /* an intentional disconnect */ } }
}
async function openStream(f: Fixture, id: string): Promise<Stream> {
  const abort = new AbortController(), response = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream?afterSeq=0`, { headers: { Cookie: f.cookie, Origin: f.origin }, signal: abort.signal });
  assert.equal(response.status, 200); const stream = new Stream(response, abort); f.streams.add(stream); return stream;
}

// ---------------------------------------------------------------------------------------------------------------------
// The relay member of a send
// ---------------------------------------------------------------------------------------------------------------------

test("a send's relay member is checked field by field, and a refusal accepts nothing", async t => {
  const f = await fixture(t), id = await create(f);
  const bad: readonly [string, unknown][] = [
    ["null", null], ["a string", "full"], ["an array", ["full"]], ["an unknown field", { nonsense: true }], ["a field of a later slice", { excludeRuns: [1] }],
    ["attach out of range", { attach: "everything" }], ["attach of another type", { attach: 1 }], ["attach as a list", { attach: ["full"] }],
    ["resend false", { resend: false }], ["resend as text", { resend: "true" }], ["clearConfirmed as a number", { clearConfirmed: 1 }],
    ["native out of range", { native: "fork" }], ["tier out of range", { tier: "max" }], ["tier of another type", { tier: 3 }],
    ["an empty note", { note: "" }], ["a blank note", { note: "   " }], ["a note of another type", { note: 5 }], ["a note over its bytes", { note: "x".repeat(4097) }], ["a note with NUL", { note: "bad\u0000note" }],
    ["a consent that is no object", { consent: "yes" }], ["an empty consent", { consent: {} }], ["a consent without a scope", { consent: { vendor: "openai", decision: "acknowledged" } }],
    ["a consent decision out of range", { consent: { vendor: "openai", decision: "maybe", scope: "global" } }], ["a consent scope out of range", { consent: { vendor: "openai", decision: "acknowledged", scope: "universe" } }],
    ["a consent vendor that is none", { consent: { vendor: "not a vendor", decision: "acknowledged", scope: "global" } }], ["a consent with an extra field", { consent: { vendor: "openai", decision: "acknowledged", scope: "global", extra: 1 } }],
    ["an input sent alone that also resends", { attach: "none", resend: true }], ["an input sent alone that also confirms a clear", { attach: "none", clearConfirmed: true }],
    ["an input sent alone that also opens a new native session", { attach: "none", native: "new" }],
    ["an input sent alone that also consents", { attach: "none", consent: { vendor: "openai", decision: "acknowledged", scope: "session" } }],
  ];
  for (const [label, relay] of bad) {
    const reply = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "never accepted", commandId: "bad-" + ++sequence, relay });
    assert.equal(reply.status, 400, label + ": " + reply.text); assert.equal(row(reply.data).code, "INVALID_INPUT", label);
    // The refusal speaks in fixed words: nothing of the request is quoted back.
    assert.equal(reply.text.includes("everything") || reply.text.includes("not a vendor") || reply.text.includes("nonsense"), false, label + ": the request was quoted back");
  }
  assert.equal((await view(f, id)).runs.length, 0, "a refused send made no Run");
  const good: readonly unknown[] = [{}, { attach: "auto" }, { attach: "full" }, { attach: "none" }, { resend: true }, { native: "continue" }, { native: "new" },
    { tier: "goal" }, { note: "a note\nof two lines\tand a tab" }, { note: "x".repeat(4096) }, { note: "字".repeat(1365) }, { consent: { vendor: "openai", decision: "goal_only", scope: "global" } },
    { consent: { vendor: "gateway:llm.example.com", decision: "acknowledged", scope: "session" } }];
  for (const relay of good) {
    const key = "good-" + ++sequence, index = (await view(f, id)).runs.length, reply = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "accepted " + key, commandId: key, relay });
    // Accepted: the checks of the shape passed, whatever the Runtime later makes of the choice.
    assert.equal(reply.status, 202, JSON.stringify(relay) + ": " + reply.text);
    await waitFor(f, id, value => done(value, index));
  }
  const reply = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "only fields", commandId: "extra-" + ++sequence, relay: {}, unknown: 1 });
  assert.equal(reply.status, 400, "the request's own fields stay closed");
});

test("a relay choice enters the command's fingerprint, and auto is no choice", async t => {
  const f = await fixture(t), id = await create(f);
  const first = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "once", commandId: "same", relay: { attach: "none" } });
  assert.equal(first.status, 202); assert.equal(row(first.data).replayed, false);
  await waitFor(f, id, value => done(value, 0));
  const replay = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "once", commandId: "same", relay: { attach: "none" } });
  assert.equal(replay.status, 202); assert.equal(row(replay.data).replayed, true); assert.equal(row(replay.data).runId, row(first.data).runId);
  // Another choice, and none at all, are not the choice of sending alone.
  for (const other of [undefined, { attach: "full" }, {}] as const) {
    const conflict = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "once", commandId: "same", ...(other === undefined ? {} : { relay: other }) });
    assert.equal(conflict.status, 409, JSON.stringify(other)); assert.equal(row(conflict.data).code, "IDEMPOTENCY_CONFLICT");
  }
  const plain = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "plain", commandId: "plain" }); assert.equal(plain.status, 202);
  await waitFor(f, id, value => done(value, 1));
  for (const same of [{ relay: { attach: "auto" } }, { relay: {} }, {}]) {
    const replayed = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "plain", commandId: "plain", ...same });
    assert.equal(replayed.status, 202, JSON.stringify(same)); assert.equal(row(replayed.data).replayed, true, JSON.stringify(same));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// A → B → A over HTTP: the read model, the Run's delivery, the packet's text
// ---------------------------------------------------------------------------------------------------------------------

test("A → B → A: the relay model lists the bindings and the packets, and the Run carries its delivery", async t => {
  const f = await fixture(t), id = await create(f);
  const empty = await relayOf(f, id); assert.deepEqual(empty, { bindings: [], packets: [] }, "a conversation that handed nothing over");
  await say(f, id, "first", "m1", 0); await switchTo(f, id, "rapi-b", "to-b"); await say(f, id, "second", "m2", 1);
  await switchTo(f, id, "rapi-a", "to-a"); await say(f, id, "third", "m3", 2);
  const conversation = await view(f, id), model = await relayOf(f, id);
  assert.deepEqual(conversation.messages.map(message => message.text), ["first", "a:first", "second", "b:second", "third", "a:third"]);
  // Run 0 carried nothing; Run 1 carried a packet to rapi-b, whose binding tracks it; Run 2 carried one to rapi-a, which keeps no binding.
  const [r0, r1, r2] = conversation.runs.map(run => run.relay);
  assert.equal(r0?.packetId, null); assert.equal(r0?.delivery, undefined, "a Run that carried nothing has no delivery");
  assert.ok(r1?.packetId); assert.deepEqual(r1.delivery, { state: "unknown", evidence: null });
  assert.ok(r2?.packetId); assert.deepEqual(r2.delivery, { state: "unknown", evidence: null }, "a packet no row tracks is unknown, never claimed delivered");
  assert.deepEqual(model.bindings.map(item => [item.harnessId, item.controlId, item.nativeEpoch, item.sync, item.throughRun, item.evidence, item.cleared, item.probed]),
    [["rapi-b", "rapi-b-control", 1, "pending", null, null, 0, false]], "only rapi-b keeps a native session; nothing proves its packet, nothing is claimed");
  // What the binding is owed (the first Run it was handed in a packet nothing confirmed, and the third, which ran on rapi-a), whether its Driver can
  // confirm a delivery at all, and what the Runtime says it asks of the user: the packet is not confirmed, and "交接单 #1" is the one it is about.
  const [b] = model.bindings as [RelayBindingView];
  assert.equal(b.canConfirm, true, "the Codex Driver confirms by what it records and what it can be asked afterwards");
  assert.deepEqual(b.owed?.runs, 2); assert.ok(b.owed !== undefined && b.owed.estTokens > 0 && b.owed.estTokens <= 6400, "an estimate, held to what a standard packet may take");
  assert.deepEqual([b.attention?.cause, b.attention?.options, b.attention?.counts, b.attention?.packet], ["delivery_unconfirmed", ["attach_full", "new_native"], { runs: 2, packets: 1 }, 1]);
  assert.match(b.attention?.key ?? "", /^delivery_unconfirmed:relay-/u); assert.equal(b.attention?.vendor, undefined, "a vendor is named only where an acknowledge needs one");
  assert.equal("dataRootExposed" in empty, false, "nothing to warn of: the data directory is not in the workspace");
  assert.equal(model.packets.length, 2);
  const [p1, p2] = model.packets as [RelayPacketView, RelayPacketView];
  assert.deepEqual([p1.number, p2.number], [1, 2]); assert.deepEqual([p1.runIndex, p2.runIndex], [1, 2]);
  assert.deepEqual([p1.runId, p2.runId], [conversation.runs[1]!.id, conversation.runs[2]!.id]);
  assert.deepEqual([p1.packetId, p2.packetId], [r1.packetId, r2.packetId]);
  assert.deepEqual([p1.kind, p1.tier, p1.target], ["packet", "standard", { harnessId: "rapi-b", model: null }]);
  assert.deepEqual([p2.kind, p2.target.harnessId], ["packet", "rapi-a"]);
  for (const packet of model.packets) {
    assert.deepEqual(Object.keys(packet).sort(), ["delivery", "estTokens", "evidence", "kind", "number", "omissions", "packetId", "redactions", "runId", "runIndex", "target", "tier"], "exactly the fields of the contract");
    assert.ok(Number.isSafeInteger(packet.estTokens) && packet.estTokens > 0); assert.equal(packet.omissions, 0); assert.equal(packet.redactions, 0);
    assert.deepEqual([packet.delivery, packet.evidence], ["unknown", null]);
  }
  for (const binding of model.bindings) assert.deepEqual(Object.keys(binding).sort(), ["attention", "canConfirm", "cleared", "controlId", "evidence", "harnessId", "nativeEpoch", "owed", "probed", "sync", "throughRun"]);
  // Reading changes nothing of the conversation.
  assert.equal((await view(f, id)).lastSeq, conversation.lastSeq); assert.equal((await view(f, id)).version, conversation.version);
});

test("under the defaults nothing is asked: an unconfirmed handoff is sent again once, then the messages go alone, and each Run says what the relay did", async t => {
  const f = await fixture(t), id = await create(f);
  assert.equal((await say(f, id, "first", "m1", 0)).status, 202);
  await switchTo(f, id, "rapi-b", "to-b");
  // Four messages on the new Harness, none of them refused: the handoff, the same handoff again (the first one nothing confirmed), then two alone.
  for (const [index, text] of ["second", "third", "fourth", "fifth"].entries()) { const reply = await say(f, id, text, "m" + (index + 2), index + 1); assert.equal(reply.status, 202, text + ": " + reply.text); }
  const shown = await view(f, id), model = await relayOf(f, id);
  assert.deepEqual(shown.runs.map(run => run.status), ["completed", "completed", "completed", "completed", "completed"], "no Run failed");
  assert.deepEqual(shown.runs.map(run => run.relay?.decision ?? null), [null,
    { kind: "carry", by: "need" }, { kind: "carry", by: "policy", cause: "delivery_unconfirmed" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, { kind: "alone", by: "policy", cause: "delivery_unconfirmed" }],
    "a Run that went alone because of what it could not confirm says so; one sent again says it was the relay that did it");
  assert.deepEqual(shown.runs.map(run => run.relay?.kind ?? null), [null, "packet", "packet", null, null], "the packet sent again is a packet like the first: what tells it apart is the decision, not its kind");
  assert.deepEqual(shown.runs.map(run => run.relay?.packetId != null), [false, true, true, false, false]);
  for (const run of shown.runs) assert.equal("relayRequest" in run, false, "the Run keeps its choices' HMAC to itself");
  // What the binding asks of the user: two packets went and nothing confirmed either; the page offers the ways out and does not wait for them.
  const [b] = model.bindings as [RelayBindingView];
  assert.deepEqual([b.sync, b.attention?.cause, b.attention?.options, b.attention?.counts?.packets, b.attention?.packet], ["pending", "delivery_unconfirmed", ["attach_full", "new_native"], 2, 2]);
  assert.deepEqual(model.packets.map(item => item.number), [1, 2]);
  // The way out the banner offers is a field of the next send: [再附一次] is a resend, and it is a Run like the others.
  const again = await say(f, id, "sixth", "m6", 5, { resend: true }); assert.equal(again.status, 202, again.text);
  const last = await view(f, id); assert.equal(last.runs[5]!.status, "completed"); assert.ok(last.runs[5]!.relay?.packetId, "the packet went again");
  assert.deepEqual(last.runs[5]!.relay?.decision?.by, "user", "and the Run says it was the user's choice");
});

test("a packet's text is served byte for byte as it was sent, with its sha256 as the ETag", async t => {
  const f = await fixture(t), id = await stranded(f), model = await relayOf(f, id), sent = await prompts(f);
  assert.equal(model.packets.length, 2);
  for (const packet of model.packets) {
    const path = `/api/v1/sessions/${id}/relay/${packet.packetId}`;
    const response = await fetch(f.origin + path, { headers: { Cookie: f.cookie, Origin: f.origin } }), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    const tag = response.headers.get("etag"); assert.equal(tag, `"${sha256(bytes)}"`, "the ETag is the sha256 of the bytes served");
    assert.equal(response.headers.get("content-length"), String(bytes.length)); assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    const text = bytes.toString("utf8");
    assert.ok(text.includes(packet.packetId), "the packet names itself"); assert.ok(sent.some(prompt => prompt.startsWith(text)), "the Harness was sent exactly these bytes, followed by the user's words");
    // Conditional reads: the same text is a 304 with its tag, another tag is the text again.
    for (const match of [tag!, "*", `W/${tag}`, `"other", ${tag}`]) {
      const cached = await fetch(f.origin + path, { headers: { Cookie: f.cookie, Origin: f.origin, "If-None-Match": match } });
      assert.equal(cached.status, 304, match); assert.equal(cached.headers.get("etag"), tag); assert.equal((await cached.text()), "");
    }
    const stale = await fetch(f.origin + path, { headers: { Cookie: f.cookie, Origin: f.origin, "If-None-Match": `"${"0".repeat(64)}"` } });
    assert.equal(stale.status, 200); assert.equal(await stale.text(), text);
    const head = await fetch(f.origin + path, { method: "HEAD", headers: { Cookie: f.cookie, Origin: f.origin } });
    assert.equal(head.status, 200); assert.equal(head.headers.get("etag"), tag); assert.equal(head.headers.get("content-length"), String(bytes.length)); assert.equal(await head.text(), "");
    const again = await fetch(f.origin + path, { headers: { Cookie: f.cookie, Origin: f.origin } }); assert.equal(again.headers.get("etag"), tag, "the text is immutable, so is its tag");
  }
  assert.notEqual(model.packets[0]!.packetId, model.packets[1]!.packetId);
});

test("another conversation's packet is not found, and the answer does not say whether it exists", async t => {
  const f = await fixture(t), first = await stranded(f), second = await create(f), packet = (await relayOf(f, first)).packets[0]!.packetId;
  assert.deepEqual(await relayOf(f, second), { bindings: [], packets: [] });
  const foreign = await call(f, `/api/v1/sessions/${second}/relay/${packet}`);
  const unknown = await call(f, `/api/v1/sessions/${second}/relay/relay-${"0".repeat(20)}`);
  const own = await call(f, `/api/v1/sessions/${first}/relay/relay-${"0".repeat(20)}`);
  for (const reply of [foreign, unknown, own]) { assert.equal(reply.status, 404, reply.text); assert.equal(row(reply.data).code, "RELAY_PACKET_NOT_FOUND"); }
  assert.equal(foreign.text, unknown.text, "an existing packet of another conversation looks like none"); assert.equal(unknown.text, own.text);
  assert.equal(foreign.text.includes(packet), false, "the identity asked about is not echoed");
  const nothing = await call(f, `/api/v1/sessions/session-0000/relay/${packet}`); assert.equal(nothing.status, 404); assert.equal(row(nothing.data).code, "SESSION_NOT_FOUND");
  assert.equal((await call(f, `/api/v1/sessions/session-0000/relay`)).status, 404);
  assert.equal((await call(f, `/api/v1/sessions/not-a-session/relay`)).status, 400);
  // A route that does not exist stays one: the packet pattern is closed.
  for (const path of [`/api/v1/sessions/${first}/relay/preview`, `/api/v1/sessions/${first}/relay/${packet}/x`, `/api/v1/sessions/${first}/relay/RELAY-${"0".repeat(20)}`, `/api/v1/sessions/${first}/relays`]) {
    const reply = await call(f, path); assert.equal(reply.status, 404, path); assert.equal(row(reply.data).code, "NOT_FOUND", path);
  }
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await call(f, `/api/v1/sessions/${first}/relay`, method, {})).status, 404, method);
  assert.equal((await call(f, `/api/v1/sessions/${first}/relay?x=1`)).status, 400, "no query is read");
});

test("after a restart the conversation's relay model and its packets read the same", async t => {
  const f = await fixture(t), id = await stranded(f);
  const before = await relayOf(f, id), texts = new Map<string, { readonly etag: string | null; readonly text: string }>();
  for (const packet of before.packets) { const reply = await fetch(f.origin + `/api/v1/sessions/${id}/relay/${packet.packetId}`, { headers: { Cookie: f.cookie, Origin: f.origin } }); texts.set(packet.packetId, { etag: reply.headers.get("etag"), text: await reply.text() }); }
  const conversation = await view(f, id);
  await f.gateway.close(); await boot(f);
  assert.deepEqual(await relayOf(f, id), before, "the same bindings and packets");
  for (const packet of before.packets) {
    const reply = await fetch(f.origin + `/api/v1/sessions/${id}/relay/${packet.packetId}`, { headers: { Cookie: f.cookie, Origin: f.origin } }), kept = texts.get(packet.packetId)!;
    assert.equal(reply.status, 200); assert.equal(reply.headers.get("etag"), kept.etag); assert.equal(await reply.text(), kept.text);
  }
  const again = await view(f, id); assert.deepEqual(again.runs.map(run => run.relay?.delivery), conversation.runs.map(run => run.relay?.delivery), "the Runs say what they said");
});

test("a stored text that is gone or no longer what was sent is not served, and what is wrong is not described", async t => {
  const f = await fixture(t), id = await stranded(f), [first, second] = (await relayOf(f, id)).packets as [RelayPacketView, RelayPacketView];
  const path = (packet: RelayPacketView) => `/api/v1/sessions/${id}/relay/${packet.packetId}`;
  assert.equal((await call(f, path(first))).status, 200); assert.equal((await call(f, path(second))).status, 200);
  // The business database is damaged from outside (the way a restored backup or a foreign tool might leave it).
  const damage = new DatabaseSync(join(f.data, "gateway.sqlite"), { enableForeignKeyConstraints: false, timeout: 5000 });
  try {
    const digests = damage.prepare("SELECT body_sha256 AS digest FROM relay_packets WHERE session_id=? AND packet_id=?");
    const gone = String(digests.get(id, first.packetId)!.digest), changed = String(digests.get(id, second.packetId)!.digest);
    damage.exec("DROP TRIGGER relay_bodies_immutable");
    damage.prepare("DELETE FROM relay_bodies WHERE session_id=? AND sha256=?").run(id, gone);
    damage.prepare("UPDATE relay_bodies SET body='tampered text that was never sent' WHERE session_id=? AND sha256=?").run(id, changed);
  } finally { damage.close(); }
  for (const packet of [first, second]) {
    const reply = await call(f, path(packet));
    assert.equal(reply.status, 502, packet.number + ": " + reply.text); assert.equal(row(reply.data).code, "INVALID_DATA");
    assert.equal(reply.text.includes("tampered"), false, "the bytes that do not match are not served, quoted or described"); assert.equal(reply.headers.get("etag"), null);
  }
  // The rest of the model still reads: one packet's text being wrong does not take the conversation or its model with it.
  assert.equal((await relayOf(f, id)).packets.length, 2); assert.equal((await view(f, id)).runs.length, 3);
});

// ---------------------------------------------------------------------------------------------------------------------
// The answer a send gets when only the user can settle it
// ---------------------------------------------------------------------------------------------------------------------

test("a send that needs the user's choice is a 409 that names the binding, the cause and the options, and the choice sent again goes through", async t => {
  const f = await fixture(t), id = await stranded(f);
  const asked = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "fourth", commandId: "m4" });
  assert.equal(asked.status, 409, asked.text);
  const body = asked.data as WebError;
  assert.equal(body.code, "RELAY_CHOICE_REQUIRED"); assert.ok(body.message.length > 0);
  assert.deepEqual(body.relay, { binding: { harnessId: "rapi-b", controlId: "rapi-b-control" }, cause: "delivery_unconfirmed", options: ["attach_full", "send_alone", "new_native"], counts: { runs: 1, packets: 0 } });
  assert.deepEqual(Object.keys(row(asked.data)).sort(), ["code", "message", "relay"]);
  assert.equal((await view(f, id)).runs.length, 3, "the refused send made no Run");
  // The draft is kept: the same command, now with a choice, is accepted (a refusal left no command behind).
  const again = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "fourth", commandId: "m4", relay: { attach: "full" } });
  assert.equal(again.status, 202, again.text); assert.equal(row(again.data).replayed, false);
  const sent = await waitFor(f, id, value => done(value, 3));
  assert.equal(sent.runs[3]!.status, "completed"); assert.ok(sent.runs[3]!.relay?.packetId, "the complete handoff went with it");
  assert.equal(sent.runs[3]!.relay?.delivery?.state, "unknown");
  // Sending it alone is the other way out: the words go as typed and the handoff stays owed.
  const asked5 = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "fifth", commandId: "m5" });
  assert.equal(asked5.status, 409, asked5.text); assert.deepEqual((asked5.data as WebError).relay?.options, ["attach_full", "send_alone", "new_native"]);
  const alone = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "fifth", commandId: "m5", relay: { attach: "none" } });
  assert.equal(alone.status, 202, alone.text);
  const last = await waitFor(f, id, value => done(value, 4));
  assert.equal(last.runs[4]!.relay?.packetId, null); assert.ok((await prompts(f)).includes("fifth"), "sent exactly as typed");
  // A confirmation of a clear that nothing waits for is not offered: a refusal of the request, not an answer to choose from.
  const stray = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "sixth", commandId: "m6", relay: { clearConfirmed: true } });
  assert.equal(stray.status, 400, stray.text); assert.equal(row(stray.data).code, "INVALID_INPUT"); assert.equal(row(stray.data).relay, undefined);
  // The same packets are all still there, in order, each with its own number.
  const model = await relayOf(f, id); assert.deepEqual(model.packets.map(item => item.number), [1, 2, 3]);
  assert.deepEqual(model.packets.map(item => item.runIndex), [1, 2, 3]);
});

test("[新开原生会话] is the field native: new: the held-back message goes through on a new native session, with the complete handoff", async t => {
  const f = await fixture(t), id = await stranded(f);
  const asked = await say(f, id, "fourth", "m4", null); assert.equal(asked.status, 409); assert.ok((asked.data as WebError).relay?.options.includes("new_native"));
  // The same command, now with the choice the 409 offered: the Runtime archives the Harness control's native session as a native reset does
  // and the input opens a new one, which is given the complete handoff.
  const sent = await say(f, id, "fourth", "m4", 3, { native: "new" }); assert.equal(sent.status, 202, sent.text);
  const after = await view(f, id), model = await relayOf(f, id);
  assert.equal(after.runs[3]!.status, "completed"); assert.ok(after.runs[3]!.relay?.packetId, "the new native session was given the complete handoff");
  assert.deepEqual(model.bindings.map(item => [item.harnessId, item.nativeEpoch]), [["rapi-b", 2]], "one binding of rapi-b is listed: the new native session, in the next epoch");
  assert.equal(model.packets.length, 3);
});

test("the relay errors a user can answer carry their relay member, whichever the Runtime raises", async t => {
  const f = await fixture(t), id = await create(f);
  const send = async (error: Error) => { f.inject.error = error; return call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "x", commandId: "inject-" + ++sequence }); };
  const mark = (code: string, message: string, extra: Record<string, unknown>) => Object.assign(new SessionError(code, message), extra);
  const cases: readonly [string, Error, number, unknown][] = [
    ["a delivery nothing confirms", new RelayError({ code: "RELAY_CHOICE_REQUIRED", reason: "delivery_unconfirmed" }, "unconfirmed"), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "delivery_unconfirmed", options: ["attach_full", "send_alone", "new_native"] }],
    ["a native history that needs checking", new RelayError({ code: "RELAY_CHOICE_REQUIRED", reason: "verify_required" }, "verify"), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "verify_required", options: ["attach_full", "send_alone", "new_native"] }],
    ["a packet the native history lost", new RelayError({ code: "RELAY_CHOICE_REQUIRED", reason: "marker_absent" }, "absent"), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "marker_absent", options: ["attach_full", "send_alone", "new_native"] }],
    ["a recovery that failed", new RelayError({ code: "RELAY_UNAVAILABLE", reason: "recovery_failed" }, "recovery"), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "recovery_failed", options: ["send_alone", "new_native"] }],
    ["a data directory in the workspace", new RelayError({ code: "RELAY_UNAVAILABLE", reason: "data_root_in_workspace" }, "data root"), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "data_root_in_workspace", options: ["send_alone"] }],
    ["a consent log that is full", new RelayError({ code: "RELAY_UNAVAILABLE", reason: "consent_log_full" }, "log"), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "consent_log_full", options: ["send_alone"] }],
    ["a consent the Runtime names the vendor and the binding of", mark("RELAY_CONSENT_REQUIRED", "consent", { reason: "missing", detail: { vendor: "openai", harnessId: "rapi-b", controlId: "rapi-b-control" } }), 409,
      { binding: { harnessId: "rapi-b", controlId: "rapi-b-control" }, cause: "missing", options: ["acknowledge", "send_alone"], vendor: "openai" }],
    ["a consent whose detail is not trusted", mark("RELAY_CONSENT_REQUIRED", "consent", { reason: "vendor_changed", detail: { vendor: "not a vendor!", harnessId: "Not An Id", controlId: "x" } }), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "vendor_changed", options: ["acknowledge", "send_alone"] }],
    ["a gateway vendor", mark("RELAY_CONSENT_REQUIRED", "consent", { reason: "missing", detail: { vendor: "gateway:llm.example.com" } }), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "missing", options: ["acknowledge", "send_alone"], vendor: "gateway:llm.example.com" }],
    ["a target nothing proved", mark("RELAY_TARGET_UNVERIFIED", "target", { reason: "unprobed" }), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "unprobed", options: ["send_alone"] }],
    ["a packet that does not fit", mark("RELAY_INPUT_LIMIT", "limit", { reason: "min_packet" }), 429,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, cause: "min_packet", options: ["send_alone"] }],
    ["a reason that is not a closed word", mark("RELAY_UNAVAILABLE", "odd", { reason: "<img src=x onerror=alert(1)>" }), 409,
      { binding: { harnessId: "rapi-a", controlId: "rapi-a-control" }, options: ["send_alone"] }],
  ];
  for (const [label, error, status, relay] of cases) {
    const reply = await send(error);
    assert.equal(reply.status, status, label + ": " + reply.text); assert.deepEqual(row(reply.data).relay, relay, label);
    assert.equal(row(reply.data).code, (error as SessionError).code, label); assert.equal(reply.text.includes("<img"), false, label + ": nothing of the error's reason is passed on unchecked");
  }
  // Errors that are not the user's to answer keep their code and message alone.
  for (const [label, error] of [["a failed preparation", new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render" }, "prepare")], ["a busy conversation", new SessionError("SESSION_BUSY", "busy")],
    ["an error that is not a session error", new Error("boom")]] as const) {
    const reply = await send(error); assert.notEqual(reply.status, 202, label); assert.equal(row(reply.data).relay, undefined, label);
    assert.deepEqual(Object.keys(row(reply.data)).sort(), ["code", "message"], label);
  }
  assert.equal((await view(f, id)).runs.length, 0);
});

test("what the user may choose follows the cause and the binding's state", () => {
  const relay = (sync: BindingRelayState["sync"], epochFloor = -1): BindingRelayState => ({ nativeEpoch: 2, sync, originIncluded: false, reanchor: false, packetsInEpoch: 0, epochFloor,
    compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null, cache: { lastRequestStartedAt: null, contextUsed: null, contextSize: null } });
  const binding = (state: BindingRelayState): NativeSessionBinding => ({ harnessId: "rapi-a", controlId: "rapi-a-control", checkpoint: "native", throughRunId: null, status: "ready", relay: state });
  const unconfirmed = (floorCandidate: number | null) => binding(relay({ kind: "suspect", mark: null, cause: "clear_unconfirmed", floorCandidate, carried: null, rewound: false }));
  // The user's confirmation of a clear is offered only where a clear is unconfirmed, above the floor, and the check cannot settle it.
  assert.deepEqual(relayOptions("RELAY_CHOICE_REQUIRED", "verify_required", unconfirmed(7)), ["attach_full", "send_alone", "new_native", "clear_confirmed"]);
  assert.deepEqual(relayOptions("RELAY_CHOICE_REQUIRED", "verify_required", unconfirmed(null)), ["attach_full", "send_alone", "new_native"], "no clear to confirm");
  assert.deepEqual(relayOptions("RELAY_CHOICE_REQUIRED", "verify_required", binding(relay({ kind: "suspect", mark: null, cause: "clear_unconfirmed", floorCandidate: 4, carried: null, rewound: false }, 4))),
    ["attach_full", "send_alone", "new_native"], "a clear at or below the floor is settled already");
  assert.deepEqual(relayOptions("RELAY_CHOICE_REQUIRED", "verify_required", binding(relay({ kind: "suspect", mark: null, cause: "rewind", floorCandidate: null, carried: null, rewound: false }))),
    ["attach_full", "send_alone", "new_native"], "another suspicion");
  assert.deepEqual(relayOptions("RELAY_CHOICE_REQUIRED", "marker_absent", unconfirmed(7)), ["attach_full", "send_alone", "new_native"], "only a check that cannot decide offers it");
  assert.deepEqual(relayOptions("RELAY_CHOICE_REQUIRED", "delivery_unconfirmed", undefined), ["attach_full", "send_alone", "new_native"]);
  assert.deepEqual(relayOptions("RELAY_CONSENT_REQUIRED", "missing", undefined), ["acknowledge", "send_alone"]);
  assert.deepEqual(relayOptions("RELAY_UNAVAILABLE", "recovery_failed", undefined), ["send_alone", "new_native"]);
  assert.deepEqual(relayOptions("RELAY_UNAVAILABLE", undefined, undefined), ["send_alone"]);
  assert.deepEqual(relayOptions("RELAY_TARGET_UNVERIFIED", "unprobed", undefined), ["send_alone"]);
  assert.deepEqual(relayOptions("RELAY_INPUT_LIMIT", "min_packet", undefined), ["send_alone"]);
  assert.deepEqual(relayOptions("SESSION_BUSY", undefined, undefined), []);
});

test("the relay member is read as a whole before the Runtime sees any of it", () => {
  assert.deepEqual(parseSendRelay(undefined), { choices: undefined });
  assert.deepEqual(parseSendRelay({}), { choices: undefined });
  assert.deepEqual(parseSendRelay({ attach: "auto" }), { choices: undefined }, "auto is no choice");
  assert.deepEqual(parseSendRelay({ attach: "full", resend: true, clearConfirmed: true }), { choices: { attach: "full", resend: true, clearConfirmed: true } });
  assert.deepEqual(parseSendRelay({ attach: "none" }).choices, { attach: "none" });
  // The target's tier, a new native session and a consent go to the Runtime with the rest; a note is checked and goes no further.
  const all = parseSendRelay({ attach: "full", tier: "brief", native: "new", note: "n", consent: { vendor: "openai", decision: "acknowledged", scope: "global" } });
  assert.deepEqual(all.choices, { attach: "full", tier: "brief", native: "new", consent: { vendor: "openai", decision: "acknowledged", scope: "global" } });
  assert.deepEqual(parseSendRelay({ native: "continue" }).choices, { native: "continue" }, "a choice to continue is recorded with the Run, and is no request for history");
  assert.deepEqual(parseSendRelay({ note: "只是一句附言" }), { choices: undefined }, "a note alone changes nothing");
  assert.throws(() => parseSendRelay({ attach: "none", native: "new" }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  assert.throws(() => parseSendRelay({ note: "  " }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
});

// ---------------------------------------------------------------------------------------------------------------------
// The installation's preferences
// ---------------------------------------------------------------------------------------------------------------------

test("the relay preferences are read, written one key at a time, refused when they make no sense, and kept across a restart", async t => {
  const f = await fixture(t);
  assert.deepEqual((await call(f, "/api/v1/relay/prefs")).data, { prefs: RELAY_PREF_DEFAULTS }, "nothing set: all six keys, each at its default (permissive: another vendor takes the history, an unprobed Driver takes it, what is unsure is settled)");
  assert.deepEqual(Object.keys(row(row((await call(f, "/api/v1/relay/prefs")).data).prefs)).sort(), [...RELAY_PREF_KEYS].sort());
  for (const key of RELAY_PREF_KEYS) for (const value of RELAY_PREF_VALUES[key]) {
    const written = await call(f, "/api/v1/relay/prefs", "PUT", { key, value }); assert.equal(written.status, 200, written.text);
    assert.equal(row(row(written.data).prefs)[key], value); assert.deepEqual((await call(f, "/api/v1/relay/prefs")).data, written.data);
  }
  const before = (await call(f, "/api/v1/relay/prefs")).data;
  const refused: readonly [string, unknown][] = [["an unknown key", { key: "relay.nothing", value: "allow" }], ["a value out of range", { key: "relay.crossVendor", value: "always" }],
    ["a value of another key", { key: "relay.crossVendor", value: "true" }], ["a missing value", { key: "relay.crossVendor" }], ["a missing key", { value: "ask" }], ["an extra field", { key: "relay.crossVendor", value: "ask", extra: 1 }],
    ["a value that is no text", { key: "relay.crossVendor", value: true }], ["a key that is no text", { key: ["relay.crossVendor"], value: "ask" }], ["a prototype key", { key: "__proto__", value: "ask" }],
    ["a value with NUL", { key: "relay.crossVendor", value: "ask\u0000" }], ["an array", [{ key: "relay.crossVendor", value: "ask" }]], ["a null", null], ["a text", "allow"]];
  for (const [label, input] of refused) { const reply = await call(f, "/api/v1/relay/prefs", "PUT", input); assert.equal(reply.status, 400, label + ": " + reply.text); assert.equal(row(reply.data).code, "INVALID_INPUT", label); }
  assert.deepEqual((await call(f, "/api/v1/relay/prefs")).data, before, "a refused write changed nothing");
  assert.equal((await call(f, "/api/v1/relay/prefs", "PUT", { key: "relay.crossVendor", value: "ask" })).status, 200);
  assert.equal((await call(f, "/api/v1/relay/prefs?x=1")).status, 400);
  for (const method of ["POST", "DELETE", "PATCH"]) assert.equal((await call(f, "/api/v1/relay/prefs", method, {})).status, 404, method);
  // Writes that arrive together: each is answered whole, and what is kept is one of them, as the last writer's.
  const racing = ["ask", "allow", "goal_only"], answers = await Promise.all(Array.from({ length: 30 }, (_, index) => call(f, "/api/v1/relay/prefs", "PUT", { key: "relay.crossVendor", value: racing[index % 3]! })));
  assert.ok(answers.every(answer => answer.status === 200), answers.map(answer => answer.status).join());
  const settled = row(row((await call(f, "/api/v1/relay/prefs")).data).prefs)["relay.crossVendor"]; assert.ok(racing.includes(String(settled)), String(settled));
  // Kept: a new Gateway on the same data reads what the old one wrote.
  await f.gateway.close(); await boot(f);
  assert.equal(row(row((await call(f, "/api/v1/relay/prefs")).data).prefs)["relay.crossVendor"], settled);
});

// ---------------------------------------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------------------------------------

test("the stream announces a relay event after the facts it follows, and carries the Run's delivery in them", async t => {
  const f = await fixture(t), id = await create(f), live = await openStream(f, id);
  assert.equal((await live.next()).frame.type, "snapshot");
  await say(f, id, "first", "m1", 0); await switchTo(f, id, "rapi-b", "to-b"); await say(f, id, "second", "m2", 1);
  const notice = await live.until(frame => frame.type === "relay");
  const frame = notice.frame as unknown as RelayStreamFrame, index = live.received.findIndex(item => item.frame === notice.frame), before = live.received[index - 1]!;
  assert.equal(before.frame.type, "snapshot", "the facts come first"); assert.equal(before.id, notice.id, "under the same watermark");
  assert.deepEqual(Object.keys(frame).sort(), ["event", "lastSeq", "sessionId", "type", "version"]);
  assert.equal(frame.sessionId, id); assert.equal(frame.lastSeq, notice.id); assert.equal(frame.lastSeq, (before.frame.session as SessionView).lastSeq); assert.equal(frame.version, (before.frame.session as SessionView).version);
  assert.deepEqual(Object.keys(frame.event).filter(key => key !== "packetId").sort(), ["at", "runId", "sessionId", "type"]);
  assert.equal(frame.event.type, "relay.verified"); assert.equal(frame.event.sessionId, id);
  assert.ok(Number.isSafeInteger(frame.event.at) && frame.event.at > 1_700_000_000_000);
  const conversation = await view(f, id);
  assert.equal(frame.event.runId, conversation.runs[1]!.id, "the Turn the check happened in"); assert.equal(frame.event.packetId, conversation.runs[1]!.relay?.packetId, "the one packet it looked at");
  // The facts the notice follows already carry the Run's delivery.
  const carried = (before.frame.session as SessionView).runs[1]!; assert.deepEqual(carried.relay?.delivery, { state: "unknown", evidence: null });
  // No fact of the notice is anywhere but in the facts: nothing of the packet's text, no digest, no native value.
  const wire = JSON.stringify(frame); assert.equal(wire.includes("HarnessHub"), false); assert.equal(/[0-9a-f]{64}/u.test(wire), false);
});

test("a Harness that says it recorded the entry (E1): the delivery is recorded as it happens, and the stream announces it", async t => {
  const f = await fixture(t, { recording: "e1" }), id = await create(f), live = await openStream(f, id);
  await live.next();
  await say(f, id, "first", "m1", 0); await switchTo(f, id, "rapi-b", "to-b"); await say(f, id, "second", "m2", 1);
  const notice = await live.until(frame => frame.type === "relay"), frame = notice.frame as unknown as RelayStreamFrame, at = live.received.findIndex(item => item.frame === notice.frame);
  const conversation = await view(f, id), carried = conversation.runs[1]!;
  assert.equal(frame.event.type, "relay.input_recorded"); assert.equal(frame.event.runId, carried.id); assert.equal(frame.event.packetId, carried.relay?.packetId);
  const facts = live.received[at - 1]!; assert.equal(facts.id, notice.id, "the facts come first, under the same watermark");
  const during = (facts.frame.session as SessionView).runs[1]!;
  assert.equal(during.status, "running", "announced while the Run is still running"); assert.deepEqual(during.relay?.delivery, { state: "recorded", evidence: "E1" });
  assert.ok(during.timing?.recordedAt !== undefined && during.timing.recordedAt <= frame.event.at + 1000, "the Run records when the native side recorded the entry");
  assert.equal(JSON.stringify(frame).includes("chain"), false);
  const model = await relayOf(f, id);
  assert.deepEqual(model.bindings.map(item => [item.sync, item.evidence, item.throughRun]), [["synced", "E1", 0]], "the binding stands on the packet, through the first Run");
  assert.deepEqual(model.packets.map(item => [item.number, item.delivery, item.evidence]), [[1, "recorded", "E1"]]);
  // Nothing more is owed to it, so the next message needs no choice and carries no packet.
  assert.equal((await say(f, id, "third", "m3", 2)).status, 202);
  const last = await view(f, id); assert.equal(last.runs[2]!.relay?.packetId, null);
});

test("a Harness whose entry is found afterwards (E2): the delivery settles with the Turn", async t => {
  const f = await fixture(t, { recording: "quiet" }), id = await create(f);
  await say(f, id, "first", "m1", 0); await switchTo(f, id, "rapi-b", "to-b"); await say(f, id, "second", "m2", 1);
  const model = await relayOf(f, id);
  assert.deepEqual(model.bindings.map(item => [item.sync, item.evidence, item.throughRun]), [["synced", "E2", 0]]);
  assert.deepEqual(model.packets.map(item => [item.delivery, item.evidence]), [["recorded", "E2"]]);
  assert.deepEqual((await view(f, id)).runs[1]!.relay?.delivery, { state: "recorded", evidence: "E2" });
});

test("a delivery that was unknown when its Run ended becomes recorded later, and the stream pushes the change once", async t => {
  const f = await fixture(t, { recording: "late" }), id = await create(f), live = await openStream(f, id);
  await live.next();
  await say(f, id, "first", "m1", 0); await switchTo(f, id, "rapi-b", "to-b"); await say(f, id, "second", "m2", 1);
  let conversation = await view(f, id), model = await relayOf(f, id);
  assert.deepEqual(conversation.runs[1]!.relay?.delivery, { state: "unknown", evidence: null }, "the Run ended with nothing to show for its packet");
  assert.deepEqual(model.bindings.map(item => [item.sync, item.evidence]), [["pending", null]]);
  const packet = conversation.runs[1]!.relay!.packetId!;
  // The stream said so too: the facts of the ended Run carry its delivery as unknown.
  const ended = await live.until(frame => frame.type === "snapshot" && (frame.session as SessionView).runs[1]?.status === "completed");
  assert.deepEqual((ended.frame.session as SessionView).runs[1]!.relay?.delivery, { state: "unknown", evidence: null });
  // The native side can be read now: the next Turn's open finds the packet of the Run that ended, and records it (E2).
  await writeFile(join(f.workspace, "ready"), "yes");
  const third = await say(f, id, "third", "m3", 2); assert.equal(third.status, 202);
  const thirdRun = String(row(third.data).runId);
  conversation = await view(f, id); model = await relayOf(f, id);
  assert.deepEqual(conversation.runs[1]!.relay?.delivery, { state: "recorded", evidence: "E2" }, "the Run that ended is now recorded");
  const entry = model.packets.find(item => item.packetId === packet);
  assert.deepEqual([entry?.delivery, entry?.evidence], ["recorded", "E2"]); assert.deepEqual(model.bindings.map(item => [item.sync, item.evidence]), [["synced", "E2"]]);
  // The change is pushed: the facts hold it, and the notice that follows them names the Turn whose settlement checked it (that
  // Turn carried a packet of its own, so the check looked at two and names neither).
  const found = (frame: Record<string, unknown>) => frame.type === "relay" && (frame as unknown as RelayStreamFrame).event.runId === thirdRun;
  const notice = await live.until(found), frame = notice.frame as unknown as RelayStreamFrame, at = live.received.findIndex(item => item.frame === notice.frame), facts = live.received[at - 1]!;
  assert.equal(frame.event.type, "relay.verified"); assert.equal(frame.event.packetId, undefined); assert.equal(facts.frame.type, "snapshot"); assert.equal(facts.id, notice.id);
  assert.equal((facts.frame.session as SessionView).runs[2]!.status, "completed");
  assert.deepEqual((facts.frame.session as SessionView).runs[1]!.relay?.delivery, { state: "recorded", evidence: "E2" }, "the facts the notice follows already hold the change");
  // Another Turn later: the change is not announced again, and the Run that ended stays recorded.
  const fourth = await say(f, id, "fourth", "m4", 3); assert.equal(fourth.status, 202);
  const last = await live.until(item => item.type === "snapshot" && (item.session as SessionView).runs[3]?.status === "completed");
  assert.deepEqual((last.frame.session as SessionView).runs[1]!.relay?.delivery, { state: "recorded", evidence: "E2" });
  assert.equal(live.received.filter(item => found(item.frame)).length, 1, "pushed once");
});

class FakeSocket extends EventEmitter implements SessionStreamSink {
  destroyed = false; writableEnded = false; blocked = false; readonly written: string[] = [];
  write(text: string): boolean { this.written.push(text); return !this.blocked; }
  end(): void { this.writableEnded = true; this.emit("close"); }
}
function frames(socket: FakeSocket): { readonly id: number; readonly frame: Record<string, unknown> }[] {
  return socket.written.filter(value => value.startsWith("id:")).map(value => ({ id: Number(/^id: (\d+)/u.exec(value)![1]), frame: row(JSON.parse(value.split("\ndata: ")[1]!.trim())) }));
}
const alpha = { harnessId: "alpha", controlId: "alpha-acp" };
function sessionEvent(session: string, seq: number, type: string, data: Record<string, unknown>): SessionEvent { return { sessionId: sessionId(session), seq, type, data, ownerGeneration: 1, timestamp: "2026-11-10T10:00:00.250Z" }; }
function viewAt(session: string, lastSeq: number): SessionView {
  return { id: session, version: lastSeq, lastSeq, epoch: 1, status: "open", workspace: "/workspace", selection: alpha, activeRunId: null, pendingSwitchId: null, messages: [], runs: [], switches: [] };
}
const SECRET = { throughSeq: 6, chain: "c".repeat(64), lastPacketId: "relay-0123456789abcdefghjk", evidence: "E1", basis: "evidence" };

test("the hub announces each of the four relay events, once each, under the watermark of a commit that holds several", () => {
  const session = "session-hub-relay", packet = "relay-0123456789abcdefghjk", run = "run-hub-one";
  let head = 10;
  const hub = new SessionStreamHub(() => viewAt(session, head)), socket = new FakeSocket();
  hub.open(sessionId(session), 0, Date.now() + 60_000, socket, () => {});
  assert.equal(frames(socket).length, 1);
  // One commit holds three events; the Runtime publishes them one by one, and the first event's snapshot already holds the head.
  head = 13;
  hub.publish(sessionEvent(session, 11, "relay.input_recorded", { runId: run, packetId: packet, recordedAt: 1_700_000_000_123, mark: SECRET, live: "recorded_event" }));
  hub.publish(sessionEvent(session, 12, "relay.verified", { verifiedRunIds: [run], moment: "open", plan: "pending", markers: [{ packetId: packet, result: "present" }, { packetId: packet, result: "present" }], recorded: [{ runId: run, mark: SECRET }], inRunId: "run-hub-two", sync: "synced" }));
  hub.publish(sessionEvent(session, 13, "relay.clear_confirmed", { by: "user", runId: "run-hub-two", harnessId: "alpha", controlId: "alpha-acp", floor: 9, nativeEpoch: 2 }));
  const got = frames(socket).slice(1);
  assert.deepEqual(got.map(item => [item.id, item.frame.type]), [[13, "snapshot"], [13, "relay"], [13, "relay"], [13, "relay"]], "one snapshot, then a notice per event, all at the head");
  const events = got.slice(1).map(item => item.frame as unknown as RelayStreamFrame);
  assert.deepEqual(events.map(item => item.event.type), ["relay.input_recorded", "relay.verified", "relay.clear_confirmed"]);
  assert.deepEqual(events.map(item => [item.sessionId, item.version, item.lastSeq]), [[session, 13, 13], [session, 13, 13], [session, 13, 13]]);
  assert.deepEqual(events.map(item => [item.event.runId, item.event.packetId]), [[run, packet], ["run-hub-two", packet], ["run-hub-two", undefined]]);
  assert.ok(events.every(item => item.event.at === Date.parse("2026-11-10T10:00:00.250Z")));
  // The marks the events hold (the chain of what a binding holds) are not in what is announced.
  const wire = got.slice(1).map(item => JSON.stringify(item.frame)).join("\n");
  for (const secret of ["c".repeat(64), "mark", "chain", "throughSeq", "\"recorded\"", "\"floor\"", "alpha-acp", "\"live\""]) assert.equal(wire.includes(secret), false, secret + " was announced");
  // An event of another kind is only the facts, as before; an event already announced is not announced twice by a later one.
  head = 14; hub.publish(sessionEvent(session, 14, "run.ended", { runId: "run-hub-two" }));
  assert.deepEqual(frames(socket).slice(1 + got.length).map(item => [item.id, item.frame.type]), [[14, "snapshot"]]);
  hub.close();
});

test("a Run's frame carries its delivery like the snapshot does", () => {
  const session = "session-hub-run", active = "run-hub-active";
  const run = { ...runAt(0, "alpha", "running", { packetId: packetIdOf("hub"), kind: "packet", continuity: { kind: "rehydrate", tier: "standard", complete: true }, executedOn: null }) };
  const at = (lastSeq: number): SessionView => ({ ...viewAt(session, lastSeq), activeRunId: runId(active), runs: [{ ...run, id: runId(active), relay: { ...run.relay!, delivery: { state: "recorded", evidence: "E1" } } }] });
  let head = 4;
  const hub = new SessionStreamHub(() => at(head)), socket = new FakeSocket();
  hub.open(sessionId(session), 0, Date.now() + 60_000, socket, () => {});
  head = 5; hub.publish(sessionEvent(session, 5, "run.output", { runId: active, event: { type: "tool" } }));
  const [, activity] = frames(socket);
  assert.equal(activity!.frame.type, "run"); assert.deepEqual(row(row(activity!.frame.run).relay).delivery, { state: "recorded", evidence: "E1" });
  hub.close();
});

test("a subscription that is backed up gets the facts later and no notice", () => {
  const session = "session-hub-slow";
  let head = 5;
  const hub = new SessionStreamHub(() => viewAt(session, head)), slow = new FakeSocket(); slow.blocked = true;
  hub.open(sessionId(session), 0, Date.now() + 60_000, slow, () => {});
  head = 6; hub.publish(sessionEvent(session, 6, "relay.verified", { inRunId: "run-slow" }));
  assert.deepEqual(frames(slow).map(item => item.frame.type), ["snapshot"], "nothing queued behind the first write");
  slow.blocked = false; slow.emit("drain");
  assert.deepEqual(frames(slow).map(item => [item.id, item.frame.type]), [[5, "snapshot"], [6, "snapshot"]], "the facts arrive whole");
  hub.close();
});

test("a relay event is announced as the fields it names and nothing else", () => {
  const at = Date.parse("2026-11-10T10:00:00.250Z"), session = "session-unit";
  const packet = "relay-0123456789abcdefghjk", run = "run-unit-1";
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.input_recorded", { runId: run, packetId: packet, mark: SECRET })), { type: "relay.input_recorded", sessionId: session, runId: run, packetId: packet, at });
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.verified", { inRunId: run, markers: [{ packetId: packet, result: "absent" }] })), { type: "relay.verified", sessionId: session, runId: run, packetId: packet, at });
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.verified", { inRunId: null, markers: [] })), { type: "relay.verified", sessionId: session, at }, "a check of nothing names nothing");
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.verified", { inRunId: run, markers: [{ packetId: packet }, { packetId: "relay-aaaaaaaaaaaaaaaaaaaa" }] })), { type: "relay.verified", sessionId: session, runId: run, at }, "several packets name none");
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.vendor_changed", { harnessId: "alpha", controlId: "alpha-acp", from: "openai", to: "gateway:llm.example.com", observedInRun: run })), { type: "relay.vendor_changed", sessionId: session, runId: run, at });
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.clear_confirmed", { by: "user", runId: run, floor: 4 })), { type: "relay.clear_confirmed", sessionId: session, runId: run, at });
  // A name that is no identity is not passed on.
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.input_recorded", { runId: "run-../../x", packetId: "relay-<script>" })), { type: "relay.input_recorded", sessionId: session, at });
  assert.deepEqual(relayStreamEvent(sessionEvent(session, 3, "relay.input_recorded", { runId: 5, packetId: { id: packet } })), { type: "relay.input_recorded", sessionId: session, at });
  for (const other of ["run.ended", "run.context_prepared", "relay.pin_added", "relay.consent_recorded", "relay.title_set", "message.accepted"]) assert.equal(relayStreamEvent(sessionEvent(session, 3, other, { runId: run })), undefined, other);
  assert.equal(relayStreamEvent({ ...sessionEvent(session, 3, "relay.verified", {}), timestamp: "not a time" })?.at, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The read model over rows made by hand
// ---------------------------------------------------------------------------------------------------------------------

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const hex = (char: string) => char.repeat(64) as Fingerprint;
const digestOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex") as Fingerprint;
function packetIdOf(seed: string): RelayPacketId { return relayPacketId("relay-" + Array.from(createHash("sha256").update(seed).digest().subarray(0, 20), byte => CROCKFORD[byte % 32]).join("")); }
function manifest(seed: string, harnessId: string, extra: { readonly kind?: "packet" | "delta" | "anchor" | "resend"; readonly tier?: string; readonly redactions?: number; readonly omissions?: number; readonly model?: string | null } = {}): RelayPacket {
  const body = "packet " + seed;
  return parseRelayPacket({ id: packetIdOf(seed), kind: extra.kind ?? "packet", tier: extra.tier ?? "standard", complete: true, reanchor: false,
    target: { harnessId, controlId: harnessId + "-acp", model: extra.model ?? null, vendor: "unknown:" + harnessId, nativeEpoch: 1 },
    source: { kind: "other", names: [{ harnessId: "bravo", model: null, runs: [0, 0] }] }, range: { fromSeq: 3, throughSeq: 3, fromRun: 0, throughRun: 0 }, basePacketId: null, supersedes: null,
    policyVersion: "relay/1", language: "en", factsFingerprint: hex("f"), workspaceObservationSeq: null,
    inputs: { attachOverride: false, digestBehind: [], detailsMissing: [], noteIncluded: false, firstLineOmitted: null },
    redaction: { profile: "egress", count: extra.redactions ?? 0, byClass: {}, overridden: 0, unscanned: 0 },
    body: { sha256: digestOf(body), bytes: Buffer.byteLength(body, "utf8"), estTokens: 120 + seed.length, estimator: "est/2", family: "o200k", untrustedTokens: 0, userTokens: 4 },
    budget: { capTokens: 8000, userCap: 2500, untrustedCap: 3000, window: 200_000, fixedPrefix: 0, windowSource: "assumed_cloud", clampedBy: [] },
    sections: [{ id: "words", author: "user", items: 1, estTokens: 4, dataClasses: ["user_text"] }], fold: [{ kind: "unit", runIndex: 0, grade: "verbatim", why: "tail" }],
    omissions: extra.omissions === undefined ? [] : [{ category: "reply", count: extra.omissions, chars: null, runs: null, retrieval: "none" }, { category: "tool_output", count: 2, chars: 40, runs: [0, 0], retrieval: "hub_detail_view" }], userEdits: [] });
}
function delivery(run: string, packet: RelayPacket, outcome: DeliveryOutcome): DeliveryRecord {
  return parseDeliveryRecord({ runId: run, packetId: packet.id, channel: "text_block", position: { kind: "file_offset", path: "/Users/someone/.claude/projects/x/transcript.jsonl", bytes: 1234 }, outcome, consentLogSeq: null, inputHmac: hex("c"),
    redaction: { rulesVersion: "egress/1", keyId: "key-1", setHmac: "0a1b2c3d" }, compactionAtDelivery: null, resendOf: null, attachOverride: false, verifyMs: null, realized: null });
}
function runAt(index: number, harnessId: string, status: PublicRun["status"], relay: PublicRun["relay"]): PublicRun {
  return { id: runId("run-syn-" + index), commandId: commandId("send-syn-" + index), input: "input " + index, userMessageId: messageId("message-syn-" + index + "-u"), assistantMessageId: messageId("message-syn-" + index + "-a"),
    selection: { harnessId, controlId: harnessId + "-acp" }, epoch: 1, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null,
    ...(relay === undefined ? {} : { relay }) };
}
function relayState(nativeEpoch: number, sync: BindingRelayState["sync"], extra: Partial<BindingRelayState> = {}): BindingRelayState {
  return { nativeEpoch, sync, originIncluded: false, reanchor: false, packetsInEpoch: 0, epochFloor: -1, compactionSeen: { count: 0, digest: null }, consentKey: null, vendorObserved: null,
    cache: { lastRequestStartedAt: null, contextUsed: null, contextSize: null }, ...extra };
}

test("the read model over rows made by hand: every sync state, each delivery outcome, the numbering and the Run a mark reaches", () => {
  const id = sessionId("session-synthetic");
  const packets = { recorded: manifest("recorded", "alpha", { redactions: 3 }), unknown: manifest("unknown", "bravo", { kind: "delta", omissions: 5, model: "gpt-x" }), refused: manifest("refused", "alpha", { kind: "resend", tier: "goal" }) };
  const noRelay = { packetId: null, kind: null, continuity: { kind: "native_resume" as const }, executedOn: null };
  const carrying = (packet: RelayPacket, harnessId: string) => ({ packetId: packet.id, kind: packet.kind, continuity: { kind: "rehydrate" as const, tier: "standard" as const, complete: true }, executedOn: { harnessId, controlId: harnessId + "-acp", nativeEpoch: 1 } });
  const runs = [
    runAt(0, "bravo", "completed", noRelay),
    runAt(1, "alpha", "completed", carrying(packets.recorded, "alpha")),
    runAt(2, "bravo", "completed", carrying(packets.unknown, "bravo")),
    runAt(3, "alpha", "completed", { ...carrying(packets.refused, "alpha"), executedOn: null }),
    runAt(4, "alpha", "completed", { ...noRelay, packetId: packetIdOf("never stored"), kind: "packet" }),
    runAt(5, "bravo", "running", noRelay),
  ];
  const rowsOf = [
    delivery(runs[1]!.id, packets.recorded, { kind: "recorded", evidence: "E2", decidedSeq: 31, decidedAt: 1000, verifiedInRun: runId("run-syn-2") }),
    delivery(runs[2]!.id, packets.unknown, { kind: "unknown", reason: "no_evidence", decidedSeq: 21, decidedAt: 900 }),
  ];
  const mark = (throughSeq: number, evidence: "E1" | "E2" | "E3" | "native" | "legacy", lastPacketId: RelayPacketId | null) => ({ throughSeq, chain: hex("d"), lastPacketId, evidence, basis: "evidence" as const });
  const binding = (harnessId: string, state: BindingRelayState, status: NativeSessionBinding["status"] = "ready"): NativeSessionBinding => ({ harnessId, controlId: harnessId + "-acp", checkpoint: "native-" + harnessId, throughRunId: null, status, relay: state });
  const snapshot: SessionSnapshot = { schemaVersion: 13, id, version: 20, lastSeq: 60, epoch: 3, status: "open",
    configuration: { workspace: "/workspace", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true }, selection: alpha, activeRunId: null, pendingSwitchId: null,
    runs, messages: [], switches: [], commands: [],
    nativeBindings: [
      // An archived binding of alpha's first native session: alpha's current one starts after it, so its clears are the epochs since.
      binding("alpha", relayState(1, { kind: "synced", mark: mark(10, "E1", null) }), "archived"),
      binding("alpha", relayState(3, { kind: "synced", mark: mark(31, "E2", packets.recorded.id) }), "ready"),
      binding("bravo", relayState(1, { kind: "pending", prior: { kind: "fresh", basis: "new" }, packetId: packets.unknown.id, range: packets.unknown.range, autoResends: 0, manualResends: 0, attachOverride: false })),
      binding("charlie", relayState(1, { kind: "fresh", basis: "new" })),
      binding("delta", relayState(2, { kind: "suspect", mark: mark(21, "native", null), cause: "rewind", floorCandidate: null, carried: null, rewound: false }), "unconfirmed"),
      binding("echo", relayState(1, { kind: "synced", mark: { throughSeq: 0, chain: hex("e"), lastPacketId: null, evidence: "origin", basis: "origin" } })),
      // A native session the Harness gave up when it cleared it (Claude Code's synthesized clear): the new one is in the next epoch and fresh.
      binding("foxtrot", relayState(1, { kind: "synced", mark: mark(10, "native", null) }), "archived"),
      binding("foxtrot", relayState(2, { kind: "fresh", basis: "user_cleared" }), "ready"),
    ] };
  const ends = [10, 20, 30, 40, 50].map((seq, index) => sessionEvent(id, seq, "run.ended", { runId: runs[index]!.id }));
  const events = [...ends, sessionEvent(id, 51, "run.native_command", { runId: runs[4]!.id })];
  const reads: RelayReads = { relayDeliveries: () => rowsOf, relayPackets: () => Object.values(packets), relayPacket: () => { throw new Error("no packet here"); }, relayPacketBody: () => { throw new Error("no body here"); },
    relayIndex: () => [], relayPrefs: () => ({}), setPref: () => { throw new Error("not written here"); },
    events: (_id, after, limit) => events.filter(item => item.seq > after).slice(0, limit ?? 100) };
  const api = new RelayApi({ reads, read: () => snapshot,
    declaration: selection => selection.harnessId === "alpha" ? { ...codexRelayCapabilities, probed: true } : selection.harnessId === "bravo" ? codexRelayCapabilities : null,
    http: { json: () => { throw new Error("no HTTP here"); }, headers: () => {}, queries: () => {}, body: async () => { throw new Error("no HTTP here"); } } });
  const model = api.view(snapshot);
  const bindings = new Map<string, RelayBindingView[]>(); for (const item of model.bindings) bindings.set(item.harnessId, [...bindings.get(item.harnessId) ?? [], item]);
  assert.deepEqual(model.bindings.map(item => item.harnessId), ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"], "an archived binding is not listed");
  // `canConfirm` follows the Driver's declaration (the Codex Driver records and can be asked; none declared cannot confirm); nothing is owed here
  // that the marks do not leave out, so only the bindings whose marks fall behind the Runs of other Harnesses are owed anything.
  const plainView = (item: RelayBindingView) => { const { owed: _owed, attention: _attention, ...rest } = item; return rest; };
  assert.deepEqual(bindings.get("alpha")!.map(plainView), [{ harnessId: "alpha", controlId: "alpha-acp", nativeEpoch: 3, sync: "synced", throughRun: 2, evidence: "E2", cleared: 1, probed: true, canConfirm: true }],
    "the mark at seq 31 covers the Runs that ended at 10, 20 and 30; the epochs since the archived native session are the clears; a probed Driver says so");
  assert.deepEqual(bindings.get("bravo")!.map(plainView), [{ harnessId: "bravo", controlId: "bravo-acp", nativeEpoch: 1, sync: "pending", throughRun: null, evidence: null, cleared: 0, probed: false, canConfirm: true }], "a declared Driver nothing proved is not probed");
  assert.deepEqual(bindings.get("charlie")!.map(plainView), [{ harnessId: "charlie", controlId: "charlie-acp", nativeEpoch: 1, sync: "fresh", throughRun: null, evidence: null, cleared: 0, probed: false, canConfirm: false }], "a Driver that declares none is not probed, and nothing it does can confirm a delivery");
  assert.deepEqual(bindings.get("delta")!.map(plainView), [{ harnessId: "delta", controlId: "delta-acp", nativeEpoch: 2, sync: "suspect", throughRun: 1, evidence: "native", cleared: 1, probed: false, canConfirm: false }], "a suspect binding still says where it last stood");
  assert.deepEqual(bindings.get("echo")!.map(plainView), [{ harnessId: "echo", controlId: "echo-acp", nativeEpoch: 1, sync: "synced", throughRun: null, evidence: "origin", cleared: 0, probed: false, canConfirm: false }], "the history a Session started from covers no Run");
  assert.deepEqual(bindings.get("foxtrot")!.map(plainView), [{ harnessId: "foxtrot", controlId: "foxtrot-acp", nativeEpoch: 2, sync: "fresh", throughRun: null, evidence: null, cleared: 1, probed: false, canConfirm: false }],
    "a native session a clear left is fresh and counts the clear that made it, though no epoch was raised within it");
  for (const item of model.bindings) assert.equal(item.attention, undefined, "the Runtime was not asked, and says nothing of what a binding asks");
  assert.equal(bindings.get("alpha")![0]!.owed, undefined, "alpha holds everything of the Runs that ended before its mark");
  // One entry per Run that carried a packet whose text is kept, numbered by the Runs that carried one; an untracked packet is unknown.
  assert.deepEqual(model.packets, [
    { packetId: packets.recorded.id, runId: runs[1]!.id, runIndex: 1, number: 1, kind: "packet", tier: "standard", target: { harnessId: "alpha", model: null }, estTokens: packets.recorded.body.estTokens, omissions: 0, redactions: 3, delivery: "recorded", evidence: "E2" },
    { packetId: packets.unknown.id, runId: runs[2]!.id, runIndex: 2, number: 2, kind: "delta", tier: "standard", target: { harnessId: "bravo", model: "gpt-x" }, estTokens: packets.unknown.body.estTokens, omissions: 7, redactions: 0, delivery: "unknown", evidence: null },
    { packetId: packets.refused.id, runId: runs[3]!.id, runIndex: 3, number: 3, kind: "resend", tier: "goal", target: { harnessId: "alpha", model: null }, estTokens: packets.refused.body.estTokens, omissions: 0, redactions: 0, delivery: "unknown", evidence: null },
  ], "the packet nothing stored is left out and takes its number with it");
  // The Run DTO: the delivery of each Run that carried a packet, from its row, else unknown; the rest untouched.
  const shown = api.runViews(snapshot);
  assert.deepEqual(shown.map(item => item.relay?.delivery), [undefined, { state: "recorded", evidence: "E2" }, { state: "unknown", evidence: null }, { state: "unknown", evidence: null }, { state: "unknown", evidence: null }, undefined]);
  assert.equal(shown[0], runs[0], "a Run that carried nothing is the Run itself"); assert.deepEqual({ ...shown[1]!, relay: undefined }, { ...runs[1]!, relay: undefined });
  assert.equal(runs[1]!.relay && "delivery" in runs[1]!.relay, false, "the Session's own Run is not changed");
  // No filesystem path of the native side, no digest, no vendor is part of what is shown.
  const wire = JSON.stringify([model, shown.map(item => item.relay)]);
  for (const hidden of ["/Users/someone", "transcript.jsonl", "unknown:", "chain", "0a1b2c3d", hex("c"), "file_offset"]) assert.equal(wire.includes(hidden), false, hidden + " leaked");
  // A Session whose Runs carried no packet reads no delivery row at all.
  const none: SessionSnapshot = { ...snapshot, runs: [runs[0]!, runs[5]!] };
  const quiet = new RelayApi({ reads: { ...reads, relayDeliveries: () => { throw new Error("read although nothing was carried"); } }, read: () => none, declaration: () => null,
    http: { json: () => {}, headers: () => {}, queries: () => {}, body: async () => null } });
  assert.equal(quiet.runViews(none), none.runs);
  // Delivery rows that cannot be read do not fail the conversation: its Runs are shown as they are.
  const broken = new RelayApi({ reads: { ...reads, relayDeliveries: () => { throw new SessionError("INVALID_DATA", "a delivery row is unreadable"); } }, read: () => snapshot, declaration: () => null,
    http: { json: () => {}, headers: () => {}, queries: () => {}, body: async () => null } });
  assert.equal(broken.runViews(snapshot), snapshot.runs);
  assert.throws(() => broken.view(snapshot), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA", "asked for the model itself, the failure is said");

  // What the Runtime says each binding asks of the user is passed on as it is said, with the packet a wait is about; the vendor an
  // acknowledge is for is named only there; and the data directory's reach is the view's, never a binding's.
  const asking = new RelayApi({ reads, read: () => snapshot, declaration: selection => selection.harnessId === "alpha" ? { ...codexRelayCapabilities, probed: true } : selection.harnessId === "bravo" ? codexRelayCapabilities : null,
    attention: () => [
      { harnessId: "alpha", controlId: "alpha-acp", probed: true, attention: null },
      { harnessId: "bravo", controlId: "bravo-acp", probed: false, attention: { cause: "delivery_unconfirmed", options: ["attach_full", "new_native"], counts: { runs: 1, packets: 1 }, key: "delivery_unconfirmed:" + packets.unknown.id } },
      { harnessId: "charlie", controlId: "charlie-acp", probed: null, attention: { cause: "consent_revoked", options: ["acknowledge"], counts: { runs: 2, packets: 0 }, key: "consent_revoked:1" } },
      { harnessId: "delta", controlId: "delta-acp", probed: false, attention: { cause: "clear_unconfirmed", options: ["attach_full", "new_native", "clear_confirmed"], counts: { runs: 0, packets: 0 }, key: "clear_unconfirmed:2:7" } },
    ],
    dataRootExposed: () => true, http: { json: () => {}, headers: () => {}, queries: () => {}, body: async () => null } });
  const asked = new Map(asking.view(snapshot).bindings.map(item => [item.harnessId, item]));
  assert.equal(asked.get("alpha")!.attention, undefined, "a binding that asks nothing has no attention");
  assert.deepEqual(asked.get("bravo")!.attention, { cause: "delivery_unconfirmed", options: ["attach_full", "new_native"], counts: { runs: 1, packets: 1 }, key: "delivery_unconfirmed:" + packets.unknown.id, packet: 2 },
    "the wait is about 交接单 #2: the packet its Run carried, which is the second Run to carry one");
  assert.deepEqual(asked.get("charlie")!.attention, { cause: "consent_revoked", options: ["acknowledge"], counts: { runs: 2, packets: 0 }, key: "consent_revoked:1", vendor: "unknown:charlie" },
    "the vendor an acknowledge is for: its Driver declares none, so the key says it could not be told");
  assert.deepEqual(asked.get("delta")!.attention?.options, ["attach_full", "new_native", "clear_confirmed"]); assert.equal(asked.get("delta")!.attention?.vendor, undefined);
  assert.equal(asked.get("charlie")!.probed, false, "a factory that cannot tell is not a proof");
  assert.equal(asking.view(snapshot).dataRootExposed, true, "the data directory is within reach of the workspace: a warning of the whole view");
  assert.equal("dataRootExposed" in api.view(snapshot), false);
  // A Runtime that cannot be asked (or fails) leaves the view as it is: attention is a help, never a reason for the conversation to fail to load.
  const failing = new RelayApi({ reads, read: () => snapshot, declaration: () => null, attention: () => { throw new Error("no attention here"); }, dataRootExposed: () => { throw new Error("no data root here"); },
    http: { json: () => {}, headers: () => {}, queries: () => {}, body: async () => null } });
  assert.equal(failing.view(snapshot).bindings.every(item => item.attention === undefined), true); assert.equal("dataRootExposed" in failing.view(snapshot), false);
});

test("the state says the Gateway has the relay, and the events of the conversation keep no fingerprint of the user's choices", async t => {
  const f = await fixture(t), state = (await call(f, "/api/v1/state")).data; assert.equal(row(state).relay, true, "the page asks for the relay of a Gateway that says so");
  const id = await create(f);
  assert.equal((await say(f, id, "alone, on purpose", "m1", 0, { attach: "none" })).status, 202);
  // The choice is in the event the Gateway keeps, with an HMAC of it; what the API shows has the choice and not the HMAC.
  const kept = new DatabaseSync(join(f.data, "gateway.sqlite"), { readOnly: true });
  let stored: string; try { stored = kept.prepare("SELECT event_json FROM events WHERE session_id=? AND event_json LIKE '%message.accepted%'").all(id).map(item => String(item.event_json)).join("\n"); } finally { kept.close(); }
  assert.match(stored, /"fingerprint":"/u, "the Gateway's own event holds the fingerprint of the request's choices");
  const page = row((await call(f, `/api/v1/sessions/${id}/events?limit=100`)).data), accepted = (page.events as { type: string; data: Record<string, unknown> }[]).filter(item => item.type === "message.accepted");
  assert.equal(accepted.length, 1); assert.deepEqual(row(accepted[0]!.data.relayRequest), { attach: "none" }, "what the user chose, and nothing that identifies it");
  assert.equal(JSON.stringify(page).includes("fingerprint"), false);
  assert.equal("relayRequest" in (await view(f, id)).runs[0]!, false);
});
