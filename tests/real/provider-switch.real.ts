import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import type { ProviderView } from "../../src/contracts/provider.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { evidenceHeader, guardTest, snapshot, type SuiteEvidence } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";

async function codex(): Promise<string> {
  for (const directory of new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"])) {
    if (!isAbsolute(directory)) continue;
    try { const path = join(directory, "codex"); await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); }
    catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
  }
  throw new Error("real Provider acceptance requires an installed Codex executable; missing is not a skipped pass");
}
/** The user's own environment: the guard (./guard.ts) proves its configuration untouched; HH_REAL_EVIDENCE, when set, receives the record (0600). */
const environment = captureNativeEnvironment(), evidencePath = process.env.HH_REAL_EVIDENCE, evidence: SuiteEvidence = { header: null, results: [] };
class Gate { readonly promise: Promise<void>; resolve!: () => void; constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); } }
function sse(response: ServerResponse, model: string, answer: string): void {
  const content = { type: "output_text", text: answer, annotations: [], logprobs: [] };
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [content] };
  const base = { id: "resp_fixture", object: "response", created_at: 1791523200, status: "in_progress", error: null, incomplete_details: null, model, output: [], store: false };
  let seq = 0;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  function event(type: string, fields: Record<string, unknown>): void { response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...fields })}\n\n`); }
  event("response.created", { response: base });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: answer, logprobs: [] });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: answer, logprobs: [] });
  event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: content });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); response.end();
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const raw of request) { assert.ok(Buffer.isBuffer(raw)); bytes += raw.length; assert.ok(bytes <= 2 * 1024 * 1024); chunks.push(raw); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
function target(provider: ProviderView) { return { providerId: provider.id, revision: provider.revision, model: provider.defaultModel }; }

test("real Codex switches managed Provider A to B to edited A with pinned key/model and persistent public history", { timeout: 90000 }, async t => {
  // The Providers are HarnessHub's own; the user's Codex configuration is snapshotted first and compared after the cleanup.
  const before = await snapshot(["codex"], environment);
  const executable = await codex(), root = await mkdtemp(join(tmpdir(), "harness-managed-real-"));
  const workspace = join(root, "workspace"), data = join(root, "data"), manifest = join(root, "catalog.json"); await mkdir(workspace);
  const received = new Gate(), release = new Gate();
  const calls: { endpoint: string; key: string; input: Record<string, unknown> }[] = [], errors: Error[] = [];
  async function provider(endpoint: string) {
    const server = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses");
        const input = await body(request); calls.push({ endpoint, key: String(request.headers.authorization), input });
        if (calls.length === 1) { received.resolve(); await release.promise; }
        sse(response, String(input.model), "Answer from " + endpoint + " for " + String(input.model));
      })().catch((error: unknown) => { errors.push(error instanceof Error ? error : new Error("fixture failed")); response.writeHead(500); response.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    return { server, url: `http://127.0.0.1:${address.port}/v1` };
  }
  const a = await provider("A"), b = await provider("B");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "codex-native": { executable } } }));
  const app = application(data, () => {}, { installations: "any", workspaceLockRoot: join(root, "locks") });
  t.after(async () => { release.resolve(); try { await app.runtime.close(); } finally { await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); a.server.closeAllConnections(); b.server.closeAllConnections(); await Promise.all([new Promise<void>(r => a.server.close(() => r())), new Promise<void>(r => b.server.close(() => r()))]); await rm(root, { recursive: true, force: true }); } });
  const outcome = guardTest(t, before, environment, evidencePath, evidence);
  const config = await prepareConfiguration({ workspace, manifestPath: manifest, searchDirs: [join(executable, "..")], pathOnly: true });
  evidence.header ??= await evidenceHeader(app, ["codex"], { configuration: config });
  const make = (name: string, baseUrl: string, model: string, apiKey: string) => ({ name, protocol: "openai-responses", baseUrl, models: [model], defaultModel: model, enabled: true, apiKey });
  const firstA = app.providers.create(make("Provider A", a.url, "fixture-model-a1", "synthetic-key-A-v1"), "real-create-a");
  const firstB = app.providers.create(make("Provider B", b.url, "fixture-model-b1", "synthetic-key-B-v1"), "real-create-b");
  const session = await app.runtime.create(config, { harnessId: "codex", provider: target(firstA) }, "real-create-session");
  app.runtime.send(session.id, "FIRST-TURN-MARKER: reply briefly, do not use tools", "real-send-one");
  await Promise.race([received.promise, app.runtime.wait(session.id).then(() => {
    throw new Error("first real dispatch ended before the local Provider request: " + JSON.stringify(oldShape(app.runtime, session.id).runs[0]?.error));
  })]);
  const editedA = app.providers.update(firstA.id, make("Provider A edited", a.url, "fixture-model-a2", "synthetic-key-A-v2"), firstA.revision, "real-update-a");
  assert.deepEqual(oldShape(app.runtime, session.id).runs[0]?.selection.provider, target(firstA));
  app.runtime.switch(session.id, { harnessId: "codex", provider: target(firstB) }, "real-switch-b");
  app.runtime.send(session.id, "SECOND-TURN-MARKER: continue briefly", "real-send-two"); release.resolve(); await app.runtime.wait(session.id);
  app.runtime.switch(session.id, { harnessId: "codex", provider: target(editedA) }, "real-switch-a2");
  app.runtime.send(session.id, "THIRD-TURN-MARKER: continue briefly", "real-send-three"); await app.runtime.wait(session.id);
  assert.deepEqual(errors, []); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(item => [item.endpoint, item.key, item.input.model]), [["A", "Bearer synthetic-key-A-v1", "fixture-model-a1"], ["B", "Bearer synthetic-key-B-v1", "fixture-model-b1"], ["A", "Bearer synthetic-key-A-v2", "fixture-model-a2"]]);
  assert.ok(JSON.stringify(calls[1]?.input).includes("FIRST-TURN-MARKER")); assert.ok(JSON.stringify(calls[2]?.input).includes("SECOND-TURN-MARKER"));
  const final = oldShape(app.runtime, session.id); assert.equal(final.runs.length, 3); assert.ok(final.runs.every(run => run.status === "completed" && run.cleanup?.closed)); assert.equal(final.epoch, 3);
  const publicData = JSON.stringify({ snapshot: final, events: app.store.events(session.id, 0) });
  assert.ok(!publicData.includes("synthetic-key")); assert.ok(!(await readFile(join(data, "providers", "providers.sqlite"))).includes(Buffer.from("synthetic-key")));
  outcome.completed = true;
});
