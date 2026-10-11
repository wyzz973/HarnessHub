import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

const MODEL = "fixture-real-live-model";
const KEY = "synthetic-real-live-stream-key";
const FIRST = "FIRST 中文\n";
const SECOND = "SECOND 🌱";
class Gate { readonly promise: Promise<void>; resolve!: () => void; constructor() { this.promise = new Promise(done => { this.resolve = done; }); } }
function record(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
async function codex(): Promise<string> {
  for (const directory of new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"])) {
    if (!isAbsolute(directory)) continue;
    try { const path = join(directory, "codex"); await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); }
    catch (error) { if (error !== null && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) continue; throw error; }
  }
  throw new Error("real web streaming acceptance requires installed Codex; missing is a failed prerequisite, never a skipped pass");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { assert.ok(Buffer.isBuffer(chunk)); length += chunk.length; assert.ok(length <= 2 * 1024 * 1024); chunks.push(chunk); }
  return record(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks, length))));
}
async function modelResponse(response: ServerResponse, gate: Gate): Promise<void> {
  const content = { type: "output_text", text: FIRST + SECOND, annotations: [], logprobs: [] }, item = { id: "msg_real_live", type: "message", role: "assistant", status: "completed", content: [content] };
  const base = { id: "resp_real_live", object: "response", created_at: 1791523200, status: "in_progress", error: null, incomplete_details: null, model: MODEL, output: [], store: false };
  let sequence = 0;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const event = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  event("response.created", { response: base });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: FIRST, logprobs: [] });
  await gate.promise;
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: SECOND, logprobs: [] });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: content.text, logprobs: [] });
  event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: content });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 24, output_tokens: 8, total_tokens: 32, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); response.end();
}
interface Received { readonly id: number; readonly frame: Record<string, unknown> }
class FactStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder("utf8", { fatal: true });
  private buffer = "";
  constructor(response: Response, private readonly abort: AbortController) { assert.ok(response.body); this.reader = response.body.getReader(); }
  async next(): Promise<Received> {
    for (;;) {
      const at = this.buffer.indexOf("\n\n");
      if (at >= 0) {
        const block = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 2);
        if (block.startsWith(":")) continue;
        const lines = block.split("\n"); assert.ok(lines.includes("event: session"));
        const id = Number(lines.find(line => line.startsWith("id: "))?.slice(4)), data = lines.find(line => line.startsWith("data: "))?.slice(6); assert.ok(data); const frame = record(JSON.parse(data));
        assert.equal(id, frame.type === "snapshot" ? record(frame.session).lastSeq : frame.lastSeq); return { id, frame };
      }
      const timer = setTimeout(() => this.abort.abort(), 10000);
      try { const value = await this.reader.read(); if (value.done) throw new Error("real web stream ended before expected committed facts"); this.buffer += this.decoder.decode(value.value, { stream: true }); }
      finally { clearTimeout(timer); }
    }
  }
  async until(predicate: (frame: Record<string, unknown>) => boolean): Promise<Received> { for (let at = 0; at < 64; at++) { const next = await this.next(); if (predicate(next.frame)) return next; } throw new Error("real stream exceeded its expected frame count"); }
  async close(): Promise<void> { this.abort.abort(); try { await this.reader.cancel(); } catch { /* Explicit test client disconnect. */ } }
}

test("real Codex delivers partial text over authenticated web SSE before model completion and survives reconnect", { timeout: 45000 }, async t => {
  const executable = await codex(), root = await mkdtemp(join(tmpdir(), "harness-real-web-stream-")), workspace = join(root, "workspace"), data = join(root, "data"), manifest = join(root, "catalog.json");
  await mkdir(workspace); await writeFile(join(workspace, "keep.txt"), "workspace configuration unchanged\n");
  const release = new Gate(), calls: Record<string, unknown>[] = [], failures: unknown[] = [], streams: FactStream[] = []; let finished = false, gateway: WebServer | undefined;
  const provider = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses"); assert.equal(request.headers.authorization, "Bearer " + KEY);
      const input = await body(request); assert.equal(input.model, MODEL); assert.ok(JSON.stringify(input).includes("REAL-WEB-LIVE-INPUT")); calls.push(input); assert.equal(calls.length, 1, "SSE reconnect caused a second model dispatch");
      await modelResponse(response, release); finished = true;
    })().catch(error => { failures.push(error); if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  t.after(async () => {
    release.resolve(); let failure: unknown;
    for (const stream of streams) try { await stream.close(); } catch (error) { failure ??= error; }
    if (gateway) try { await gateway.close(); } catch (error) { failure ??= error; }
    provider.closeAllConnections(); if (provider.listening) await new Promise<void>((done, reject) => provider.close(error => error ? reject(error) : done())).catch(error => { failure ??= error; });
    await rm(root, { recursive: true, force: true }); if (failure) throw failure;
  });
  await new Promise<void>(done => provider.listen(0, "127.0.0.1", done)); const address = provider.address(); assert.ok(address && typeof address !== "string");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "codex-native": { executable } } }));
  gateway = await startWebServer({ root: data, configuration: await prepareConfiguration({ workspace, manifestPath: manifest, searchDirs: [dirname(executable)], pathOnly: true }), port: 0, workspaceLockRoot: join(root, "locks") });
  const startup = new URL(gateway.url), origin = startup.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(startup.hash.slice(1)).get("token") }) }); assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String(record(await boot.json()).csrfToken);
  async function request(path: string, input?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(origin + "/api/v1" + path, { method: input === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(input === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    assert.ok(response.ok, await response.clone().text()); return record(await response.json());
  }
  const managed = await request("/providers", { input: { name: "Real live fixture", protocol: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [MODEL], defaultModel: MODEL, enabled: true, apiKey: KEY }, commandId: "real-live-provider" });
  const session = await request("/sessions", { selection: { harnessId: "codex", controlId: "codex-native", provider: { providerId: managed.id, revision: managed.revision, model: MODEL } }, commandId: "real-live-session" }), id = String(session.id);
  async function connect(after = 0): Promise<FactStream> {
    const abort = new AbortController(), response = await fetch(origin + `/api/v1/sessions/${id}/events/stream?afterSeq=${after}`, { headers: { Cookie: cookie, Origin: origin }, signal: abort.signal }); assert.equal(response.status, 200);
    const stream = new FactStream(response, abort); streams.push(stream); return stream;
  }
  const live = await connect(); assert.equal((await live.next()).frame.type, "snapshot");
  await request(`/sessions/${id}/messages`, { text: "REAL-WEB-LIVE-INPUT: reply briefly without tools", commandId: "real-live-input" });
  const partial = await live.until(frame => frame.type === "message" && record(frame.message).text === FIRST); assert.equal(partial.frame.sessionId, id); assert.equal(finished, false);
  const running = await request(`/sessions/${id}`); assert.ok(Array.isArray(running.runs)); assert.equal(record(running.runs[0]).status, "running"); assert.equal(calls.length, 1);
  await live.close(); const resumed = await connect(partial.id), canonical = await resumed.next(); assert.equal(canonical.frame.type, "snapshot"); const current = record(canonical.frame.session); assert.ok(Array.isArray(current.messages)); assert.equal(record(current.messages.at(-1)).text, FIRST); assert.equal(finished, false);
  const retry = await request(`/sessions/${id}/messages`, { text: "REAL-WEB-LIVE-INPUT: reply briefly without tools", commandId: "real-live-input" }); assert.equal(retry.replayed, true);
  release.resolve();
  const ended = await resumed.until(frame => { if (frame.type !== "snapshot") return false; const state = record(frame.session); return Array.isArray(state.runs) && state.runs.length === 1 && record(state.runs[0]).status === "completed"; });
  const final = record(ended.frame.session); assert.ok(Array.isArray(final.messages)); assert.equal(record(final.messages.at(-1)).text, FIRST + SECOND); assert.ok(Array.isArray(final.runs)); const run = record(final.runs[0]); assert.equal(record(run.cleanup).closed, true); assert.equal(record(run.cleanup).protocolFailure, null);
  assert.equal(finished, true); assert.equal(calls.length, 1); assert.deepEqual(failures, []); assert.equal(JSON.stringify({ partial, canonical, ended, managed }).includes(KEY), false);
  assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "workspace configuration unchanged\n");
  assert.equal((await readFile(join(data, "providers", "providers.sqlite"))).includes(Buffer.from(KEY)), false);
});
