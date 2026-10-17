import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { commandId, messageId, runId, sessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import type { SessionView } from "../../src/contracts/web.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { SessionStreamHub, type SessionStreamLimits, type SessionStreamReadFailure, type SessionStreamSink } from "../../src/web/session-stream.js";
import { AttentionStreamHub } from "../../src/web/attention-stream.js";
import type { AttentionItem } from "../../src/contracts/session.js";

function record(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
interface Files { readonly root: string; readonly data: string; readonly workspace: string; readonly manifest: string; readonly trace: string; readonly step: string; readonly release: string }
async function files(): Promise<Files> {
  const root = await mkdtemp(join(tmpdir(), "harness-live-test-")), workspace = join(root, "workspace"), manifest = join(root, "catalog.json"), trace = join(root, "trace.ndjson"), step = join(root, "step"), release = join(root, "release"), peer = join(root, "peer.mjs"); await mkdir(workspace);
  await writeFile(peer, `import{createInterface}from'node:readline';import{existsSync,appendFileSync}from'node:fs';
const native='native-'+process.pid;let active=null,loop=null,second=false;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const answer=text=>send({method:'session/update',params:{sessionId:native,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[],agentInfo:{name:'live-peer',version:'1.0'}}});
else if(m.method==='session/new')send({id:m.id,result:{sessionId:native}});
else if(m.method==='session/prompt'){appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({type:'prompt',pid:process.pid})+'\\n');active=m.id;answer('FIRST 中文\\n');loop=setInterval(()=>{if(!second&&existsSync(process.env.FIXTURE_STEP)){second=true;answer('SECOND 🌱\\n');}if(second&&existsSync(process.env.FIXTURE_RELEASE)){clearInterval(loop);answer('FINAL');send({id:active,result:{stopReason:'end_turn'}});active=null;}},10);}
else if(m.method==='session/cancel'&&active!==null){clearInterval(loop);send({id:active,result:{stopReason:'cancelled'}});active=null;}});
`);
  const definition = { id: "stream-peer", name: "Live stream peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "stream-control", protocol: "acp-v1", executableNames: ["stream-peer"], args: [peer], env: { FIXTURE_TRACE: trace, FIXTURE_STEP: step, FIXTURE_RELEASE: release }, requiredExecutables: [], package: null, distribution: null, source: { repository: "fixture", revision: "stream", upstreamId: "live-peer", url: "https://example.invalid/live-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "stream-control": { executable: process.execPath } } }));
  return { root, data: join(root, "data"), workspace, manifest, trace, step, release };
}
function view(snapshot: SessionSnapshot): SessionView { return { id: snapshot.id, version: snapshot.version, lastSeq: snapshot.lastSeq, epoch: snapshot.epoch, status: snapshot.status, workspace: snapshot.configuration.workspace, selection: snapshot.selection, activeRunId: snapshot.activeRunId, pendingSwitchId: snapshot.pendingSwitchId, messages: snapshot.messages, runs: snapshot.runs, switches: snapshot.switches }; }
interface HttpFixture extends Files { gateway: WebServer; readonly origin: string; readonly cookie: string; readonly csrf: string; readonly streams: Set<StreamReader> }
async function httpFixture(t: test.TestContext): Promise<HttpFixture> {
  const f = await files(), configuration = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true });
  const gateway = await startWebServer({ installations: "any", root: f.data, configuration, port: 0, workspaceLockRoot: join(f.root, "locks") }); const url = new URL(gateway.url), response = await fetch(url.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: url.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) }); assert.equal(response.status, 200);
  const result = { ...f, gateway, origin: url.origin, cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, csrf: String(record(await response.json()).csrfToken), streams: new Set<StreamReader>() };
  t.after(async () => { for (const stream of result.streams) await stream.close(); try { await gateway.close(); } finally { await rm(f.root, { recursive: true, force: true }); } }); return result;
}
async function call(f: HttpFixture, path: string, input?: unknown): Promise<{ readonly status: number; readonly value: unknown }> {
  const response = await fetch(f.origin + "/api/v1" + path, { method: input === undefined ? "GET" : "POST", headers: { Cookie: f.cookie, Origin: f.origin, ...(input === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": f.csrf }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, value: await response.json() as unknown };
}
async function create(f: HttpFixture): Promise<string> { const response = await call(f, "/sessions", { selection: { harnessId: "stream-peer" }, commandId: "create-stream" }); assert.equal(response.status, 201); return String(record(response.value).id); }
interface Received { readonly id: number; readonly frame: Record<string, unknown> }
class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  /** Waiting-request lists that rode along without an event id (ADR-035), kept apart from the session's facts. */
  readonly attention: Record<string, unknown>[] = [];
  constructor(readonly response: Response, private readonly abort: AbortController) { assert.ok(response.body); this.reader = response.body.getReader(); }
  /** The next waiting-request list, whether already read past or still to come. */
  async nextAttention(): Promise<Record<string, unknown>> { return this.attention.shift() ?? (await this.read(true)).frame; }
  next(): Promise<Received> { return this.read(false); }
  private async read(attention: boolean): Promise<Received> {
    for (;;) {
      const delimiter = this.buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const block = this.buffer.slice(0, delimiter); this.buffer = this.buffer.slice(delimiter + 2);
        if (!block.includes("data:")) continue;
        const lines = block.split("\n"), id = Number(lines.find(line => line.startsWith("id: "))?.slice(4)), data = lines.find(line => line.startsWith("data: "))?.slice(6); assert.ok(data);
        if (block.startsWith("event: attention")) { if (attention) return { id, frame: record(JSON.parse(data)) }; this.attention.push(record(JSON.parse(data))); continue; }
        if (attention) continue;
        return { id, frame: record(JSON.parse(data)) };
      }
      const timer = setTimeout(() => this.abort.abort(), 5000);
      try { const next = await this.reader.read(); if (next.done) throw new Error("SSE ended before expected frame"); this.buffer += this.decoder.decode(next.value, { stream: true }); }
      finally { clearTimeout(timer); }
    }
  }
  async until(predicate: (frame: Record<string, unknown>) => boolean): Promise<Received> { for (let at = 0; at < 64; at++) { const next = await this.next(); if (predicate(next.frame)) return next; } throw new Error("SSE exceeded expected frame count"); }
  async close(): Promise<void> { this.abort.abort(); try { await this.reader.cancel(); } catch { /* Intentional client disconnect. */ } }
}
async function stream(f: HttpFixture, id: string, cursor = 0, extra: Record<string, string> = {}): Promise<StreamReader> {
  const abort = new AbortController(), response = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream?afterSeq=${cursor}`, { headers: { Cookie: f.cookie, Origin: f.origin, ...extra }, signal: abort.signal }); assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  const reader = new StreamReader(response, abort); f.streams.add(reader); return reader;
}
function textFrame(frame: Record<string, unknown>, expected: string): boolean { return frame.type === "message" && record(frame.message).text === expected; }
function runStatus(frame: Record<string, unknown>, status: string): boolean {
  if (frame.type !== "snapshot") return false;
  const session = record(frame.session); return Array.isArray(session.runs) && session.runs.length > 0 && record(session.runs[0]).status === status;
}

test("real HTTP SSE delivers a committed first message before the external Harness may emit more or complete", async t => {
  const f = await httpFixture(t), id = await create(f), live = await stream(f, id), initial = await live.next(); assert.equal(initial.frame.type, "snapshot"); assert.equal(record(initial.frame.session).id, id);
  const receipt = await call(f, `/sessions/${id}/messages`, { text: "greeting", commandId: "live-message" }); assert.equal(receipt.status, 202);
  const first = await live.until(frame => textFrame(frame, "FIRST 中文\n")); assert.equal(first.id, first.frame.lastSeq); assert.equal(first.frame.sessionId, id);
  const current = record((await call(f, `/sessions/${id}`)).value); assert.ok(Array.isArray(current.runs)); assert.equal(record(current.runs[0]).status, "running");
  await writeFile(f.step, "next"); const second = await live.until(frame => textFrame(frame, "FIRST 中文\nSECOND 🌱\n")); assert.ok(second.id > first.id);
  await writeFile(f.release, "finish"); const ended = await live.until(frame => runStatus(frame, "completed"));
  const final = record(ended.frame.session); assert.ok(Array.isArray(final.messages)); assert.equal(record(final.messages.at(-1)).text, "FIRST 中文\nSECOND 🌱\nFINAL");
  assert.equal(ended.id, final.lastSeq); assert.equal(ended.frame.type, "snapshot"); assert.equal("commands" in final, false); assert.equal("configuration" in final, false);
});

test("disconnect and reconnect restore canonical facts without cancelling or re-dispatching the public Run", async t => {
  const f = await httpFixture(t), id = await create(f), first = await stream(f, id); await first.next();
  await call(f, `/sessions/${id}/messages`, { text: "once", commandId: "once" }); const partial = await first.until(frame => textFrame(frame, "FIRST 中文\n")); await first.close();
  const current = record((await call(f, `/sessions/${id}`)).value); assert.ok(Array.isArray(current.runs)); assert.equal(record(current.runs[0]).status, "running");
  const resumed = await stream(f, id, partial.id), canonical = await resumed.next(); assert.equal(canonical.frame.type, "snapshot"); assert.ok(canonical.id >= partial.id);
  const replay = await call(f, `/sessions/${id}/messages`, { text: "once", commandId: "once" }); assert.equal(record(replay.value).replayed, true);
  await writeFile(f.step, "next"); await resumed.until(frame => textFrame(frame, "FIRST 中文\nSECOND 🌱\n")); await writeFile(f.release, "finish");
  await resumed.until(frame => runStatus(frame, "completed"));
  assert.equal((await readFile(f.trace, "utf8")).trim().split("\n").length, 1);
});

test("cancelled Run retains partial text and stream closure does not claim completion", async t => {
  const f = await httpFixture(t), id = await create(f), live = await stream(f, id); await live.next();
  await call(f, `/sessions/${id}/messages`, { text: "cancel", commandId: "cancel-input" }); await live.until(frame => textFrame(frame, "FIRST 中文\n"));
  const cancelled = await call(f, `/sessions/${id}/cancel`, { commandId: "stop" }); assert.equal(cancelled.status, 202);
  const ended = await live.until(frame => runStatus(frame, "cancelled"));
  const value = record(ended.frame.session); assert.ok(Array.isArray(value.messages)); assert.equal(record(value.messages.at(-1)).text, "FIRST 中文\n");
});

test("stream API rejects future/conflicting cursors, cross-origin callers and invalid input before headers are committed", async t => {
  const f = await httpFixture(t), id = await create(f);
  for (const [query, header, expected] of [["afterSeq=999", {}, 409], ["afterSeq=-1", {}, 400], ["afterSeq=0&afterSeq=1", {}, 400], ["afterSeq=0", { "Last-Event-ID": "1" }, 400], ["", { "Last-Event-ID": "nan" }, 400]] as const) {
    const response = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream?${query}`, { headers: { Cookie: f.cookie, Origin: f.origin, ...header } }); assert.equal(response.status, expected); assert.ok(record(await response.json()).code);
  }
  const denied = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream`, { headers: { Cookie: f.cookie, Origin: "https://attacker.invalid" } }); assert.equal(denied.status, 403);
  const anonymous = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream`); assert.equal(anonymous.status, 401);
});

test("eight long-lived streams have an independent cap and shutdown closes them without waiting for TTL", async t => {
  const f = await httpFixture(t), id = await create(f);
  for (let at = 0; at < 8; at++) { const live = await stream(f, id); await live.next(); }
  const excess = await fetch(f.origin + `/api/v1/sessions/${id}/events/stream`, { headers: { Cookie: f.cookie } }); assert.equal(excess.status, 429); assert.equal(record(await excess.json()).code, "STREAM_LIMIT");
  assert.equal((await call(f, `/sessions/${id}`)).status, 200);
  const started = Date.now(); await f.gateway.close(); assert.ok(Date.now() - started < 3000);
});

class FakeSocket extends EventEmitter implements SessionStreamSink {
  destroyed = false; writableEnded = false; blocked = false; fail = false; readonly written: string[] = [];
  write(text: string): boolean { if (this.fail) throw new Error("external socket disconnected"); this.written.push(text); return !this.blocked; }
  end(): void { this.writableEnded = true; this.emit("close"); }
}
function frames(socket: FakeSocket): Record<string, unknown>[] { return socket.written.filter(value => value.startsWith("id:")).map(value => record(JSON.parse(value.split("\ndata: ")[1]!.trim()))); }
async function hubFixture(t: test.TestContext, limits: SessionStreamLimits = {}) {
  const f = await files(); let hub: SessionStreamHub;
  const reports: SessionStreamReadFailure[] = [];
  const app = application(f.data, event => hub.publish(event), { installations: "any", workspaceLockRoot: join(f.root, "locks") }); hub = new SessionStreamHub(id => view(app.runtime.read(id)), limits, failure => { reports.push(failure); });
  const config = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true }), session = await app.runtime.create(config, { harnessId: "stream-peer" }, "hub-session");
  const result = { ...f, hub, app, reports, id: session.id, ownerLost: false };
  t.after(async () => {
    hub.close(); let failure: unknown;
    for (const close of [() => app.runtime.close(), () => app.management.shutdown(), () => app.providers.shutdown(), () => app.store.close()]) {
      try { await close(); } catch (error) { if (!result.ownerLost || record(error).code !== "OWNER_LOST") failure ??= error; }
    }
    await rm(f.root, { recursive: true, force: true }); if (failure) throw failure;
  }); return result;
}

test("backpressure keeps one dirty marker then drains a latest canonical snapshot, rather than queuing token frames", async t => {
  const f = await hubFixture(t), socket = new FakeSocket(); socket.blocked = true; f.hub.open(f.id, 0, Date.now() + 5000, socket, () => {});
  f.app.runtime.send(f.id, "held", "held");
  const received = () => f.app.runtime.read(f.id).messages.some(message => message.role === "assistant" && message.text === "FIRST 中文\n");
  const deadline = Date.now() + 3000; while (!received() && Date.now() < deadline) await delay(10); assert.ok(received(), "external output did not reach the committed public message");
  assert.equal(frames(socket).length, 1); socket.blocked = false; socket.emit("drain");
  const canonical = frames(socket).at(-1); assert.ok(canonical); assert.equal(canonical.type, "snapshot"); assert.equal(record(canonical.session).lastSeq, f.app.runtime.read(f.id).lastSeq);
  const latest = record(canonical.session); assert.ok(Array.isArray(latest.messages)); assert.equal(record(latest.messages.at(-1)).text, "FIRST 中文\n");
});

test("socket write failure and slow subscriber timeout release only that subscriber and preserve a running Run", async t => {
  const f = await hubFixture(t, { drainTimeoutMs: 30 }), socket = new FakeSocket(); f.hub.open(f.id, 0, Date.now() + 5000, socket, () => {}); socket.fail = true;
  assert.doesNotThrow(() => f.app.runtime.send(f.id, "running", "running")); assert.equal(f.hub.size, 0);
  const slow = new FakeSocket(); slow.blocked = true; f.hub.open(f.id, 0, Date.now() + 5000, slow, () => {}); await delay(60); assert.equal(f.hub.size, 0); assert.equal(slow.writableEnded, true);
  const snapshot = f.app.runtime.read(f.id); assert.equal(snapshot.status, "open"); assert.ok(snapshot.runs.some(run => run.status === "running" || run.status === "preparing"));
  assert.equal(f.hub.readFailure, null); assert.deepEqual(f.reports, [], "external socket errors were misreported as authoritative storage failures");
});

test("heartbeat, connection TTL and login expiry are owned and removed when a subscriber closes", async t => {
  const f = await hubFixture(t, { heartbeatMs: 10, connectionTtlMs: 40 }), socket = new FakeSocket(); f.hub.open(f.id, 0, Date.now() + 5000, socket, () => {});
  await delay(60); assert.ok(socket.written.some(value => value.startsWith(": heartbeat"))); assert.equal(f.hub.size, 0); assert.equal(socket.listenerCount("drain"), 0);
  const expiry = new FakeSocket(); f.hub.open(f.id, 0, Date.now() + 15, expiry, () => {}); await delay(30); assert.equal(expiry.writableEnded, true);
  assert.throws(() => f.hub.open(f.id, 0, Date.now() - 1, new FakeSocket(), () => {}), (error: unknown) => record(error).code === "AUTH_REQUIRED");
  let time = 1000, ready = false;
  const expiredDuringRead = new SessionStreamHub(id => { const current = view(f.app.runtime.read(id)); time += 20; return current; }, { now: () => time });
  assert.throws(() => expiredDuringRead.open(f.id, 0, 1010, new FakeSocket(), () => { ready = true; }), (error: unknown) => record(error).code === "AUTH_REQUIRED");
  assert.equal(ready, false); assert.equal(expiredDuringRead.size, 0); expiredDuringRead.close();
});

test("frame budget rejects an oversize projection without affecting committed facts", async t => {
  const f = await hubFixture(t, { maxFrameBytes: 64 }), socket = new FakeSocket(); f.hub.open(f.id, 0, Date.now() + 5000, socket, () => {});
  assert.equal(socket.written.length, 0); assert.equal(socket.writableEnded, true); assert.equal(f.hub.size, 0); assert.equal(f.app.runtime.read(f.id).status, "open");
});

test("an authoritative owner failure propagates from publication rather than being treated as a socket failure", async t => {
  const f = await hubFixture(t), socket = new FakeSocket(); socket.blocked = true; f.hub.open(f.id, 0, Date.now() + 5000, socket, () => {});
  f.app.runtime.send(f.id, "owner", "owner"); const committed = f.app.store.events(f.id, 1)[0]; assert.ok(committed);
  await rename(join(f.data, "owner.sqlite"), join(f.data, "old-owner.sqlite")); await writeFile(join(f.data, "owner.sqlite"), Buffer.alloc(0), { mode: 0o600 }); f.ownerLost = true;
  assert.throws(() => f.hub.publish(committed), (error: unknown) => record(error).code === "OWNER_LOST");
});

test("async drain retains and reports a real owner failure while closing only its transport callback", async t => {
  const f = await hubFixture(t), socket = new FakeSocket(); socket.blocked = true; f.hub.open(f.id, 0, Date.now() + 5000, socket, () => {});
  f.app.runtime.send(f.id, "drain-owner", "drain-owner");
  await rename(join(f.data, "owner.sqlite"), join(f.data, "old-owner.sqlite")); await writeFile(join(f.data, "owner.sqlite"), Buffer.alloc(0), { mode: 0o600 }); f.ownerLost = true;
  assert.doesNotThrow(() => { socket.blocked = false; socket.emit("drain"); });
  assert.equal(socket.writableEnded, true); assert.equal(f.hub.size, 0); assert.equal(socket.listenerCount("drain"), 0);
  assert.equal(f.hub.readFailure?.sessionId, f.id); assert.equal(record(f.hub.readFailure?.error).code, "OWNER_LOST");
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0], f.hub.readFailure); assert.equal(f.hub.diagnosticFailure, null);
  assert.throws(() => f.app.runtime.send(f.id, "must not dispatch", "after-owner"), (error: unknown) => record(error).code === "OWNER_LOST");
});

test("native activity of the active Run is published as one run frame, other facts as canonical snapshots", () => {
  const id = sessionId("session-run-frame"), run = runId("run-active");
  let current: SessionView = { id, version: 4, lastSeq: 7, epoch: 1, status: "open", workspace: "/w", selection: { harnessId: "a", controlId: "a" }, activeRunId: run, pendingSwitchId: null,
    messages: [{ id: messageId("message-u"), runId: run, role: "user", text: "q", seq: 2, status: "running" }],
    runs: [{ id: run, commandId: commandId("send"), input: "q", userMessageId: messageId("message-u"), assistantMessageId: messageId("message-a"), selection: { harnessId: "a", controlId: "a" }, epoch: 1, status: "running", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: null }], switches: [] };
  const hub = new SessionStreamHub(() => current), socket = new FakeSocket();
  hub.open(id, current.lastSeq, Date.now() + 5000, socket, () => {});
  const advance = (patch: Partial<SessionView["runs"][number]>) => { current = { ...current, version: current.version + 1, lastSeq: current.lastSeq + 1, runs: current.runs.map(item => ({ ...item, ...patch })) }; };
  advance({ tools: [{ id: "t", title: "ls", status: "completed" }] });
  hub.publish({ sessionId: id, seq: current.lastSeq, ownerGeneration: 1, timestamp: "2026-10-11T00:00:00Z", type: "run.output", data: { runId: run, event: { type: "tool", id: "t", title: "ls", status: "completed" } } });
  advance({});
  hub.publish({ sessionId: id, seq: current.lastSeq, ownerGeneration: 1, timestamp: "2026-10-11T00:00:00Z", type: "permission.requested", data: { runId: run } });
  const sent = frames(socket);
  assert.deepEqual(sent.map(frame => frame.type), ["snapshot", "run", "snapshot"]);
  assert.deepEqual(record(sent[1]!.run).tools, [{ id: "t", title: "ls", status: "completed" }]);
  hub.close();
});

test("a session stream carries the newest waiting list without an event id, and a slow subscriber gets only the latest once it drains", async t => {
  const f = await hubFixture(t), frame = (revision: number) => ({ revision, items: [] });
  let current = frame(0);
  const hub = new SessionStreamHub(id => view(f.app.runtime.read(id)), {}, undefined, () => current); t.after(() => hub.close());
  const socket = new FakeSocket(); hub.open(f.id, 0, Date.now() + 5000, socket, () => {});
  const attention = () => socket.written.filter(value => value.startsWith("event: attention")).map(value => {
    assert.ok(!value.includes("\nid:") && !value.startsWith("id:"), "it never moves the session cursor");
    return Number(record(JSON.parse(value.split("data: ")[1]!.trim())).revision);
  });
  assert.equal(frames(socket).length, 1, "the session snapshot comes first"); assert.deepEqual(attention(), [0]);
  hub.attentionChanged(frame(2)); hub.attentionChanged(frame(1)); assert.deepEqual(attention(), [0, 2], "an older list never replaces a newer one");
  socket.blocked = true; hub.attentionChanged(frame(3)); hub.attentionChanged(frame(4)); hub.attentionChanged(frame(5));
  assert.deepEqual(attention(), [0, 2, 3]); socket.blocked = false; socket.emit("drain");
  assert.deepEqual(attention(), [0, 2, 3, 5], "the latest list only, once the subscriber drains");
  current = frame(6); const later = new FakeSocket(); hub.open(f.id, 0, Date.now() + 5000, later, () => {});
  assert.equal(later.written.filter(value => value.startsWith("event: attention")).length, 1, "a new subscription starts with the current list");
});

test("a list given out on request does not hide a change from the subscribers of the waiting list", () => {
  const waiting: AttentionItem = { sessionId: "session-a" as AttentionItem["sessionId"], permissionId: "permission-1", runId: "run-1", harnessId: "hermes", kind: "approval", requestedAt: 1 };
  let items: readonly AttentionItem[] = [];
  const heard: number[] = [], hub = new AttentionStreamHub(() => items, {}, frame => heard.push(frame.revision));
  const socket = new FakeSocket(); hub.open(Date.now() + 5000, socket, () => {});
  items = [waiting];
  assert.equal(hub.frame().revision, 1, "read by request first");
  hub.changed(); hub.changed();
  const sent = socket.written.filter(value => value.startsWith("id:")).map(value => record(JSON.parse(value.split("data: ")[1]!.trim())));
  assert.deepEqual(sent.map(value => value.revision), [0, 1]); assert.deepEqual(heard, [1], "each change is told once");
  items = []; hub.changed(); assert.deepEqual(heard, [1, 2]);
  hub.close(); assert.equal(socket.writableEnded, true);
});

test("the waiting list is served on request, on its own stream, and on a conversation's stream", async t => {
  const f = await httpFixture(t), id = await create(f);
  const listed = await call(f, "/attention"); assert.equal(listed.status, 200); assert.deepEqual(record(listed.value).items, []);
  const reader = await stream(f, id); assert.equal((await reader.next()).frame.type, "snapshot");
  assert.deepEqual((await reader.nextAttention()).items, [], "the conversation's stream starts with the current list");
  const abort = new AbortController(), alone = await fetch(f.origin + "/api/v1/attention/stream", { headers: { Cookie: f.cookie, Origin: f.origin }, signal: abort.signal });
  try {
    assert.equal(alone.status, 200); assert.match(alone.headers.get("content-type") ?? "", /^text\/event-stream/u);
    const first = await alone.body!.getReader().read(); const block = new TextDecoder().decode(first.value);
    assert.match(block, /^id: \d+\nevent: attention\ndata: \{"revision":\d+,"items":\[\]\}\n\n/u);
  } finally { abort.abort(); }
});
