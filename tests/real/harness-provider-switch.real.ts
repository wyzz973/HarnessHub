import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";
import { application } from "../../src/cli/session-application.js";
import type { ProviderView } from "../../src/contracts/provider.js";
import { catalogTarget } from "../../src/infrastructure/catalog/platform.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

const CODEX_MODEL = "fixture-cross-harness-codex";
const GEMINI_MODEL = "gemini-2.5-flash";
const CODEX_KEY = "synthetic-cross-harness-codex-key";
const GEMINI_KEY = "synthetic-cross-harness-gemini-key";
const MARKERS = ["CROSS-HARNESS-FIRST-CODEX", "CROSS-HARNESS-SECOND-GEMINI", "CROSS-HARNESS-THIRD-CODEX"] as const;
interface Call { readonly harness: "codex" | "gemini"; readonly path: string; readonly key: string; readonly input: Record<string, unknown> }
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function executable(name: string): Promise<string> {
  for (const directory of new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"])) {
    if (!isAbsolute(directory)) continue;
    try { const candidate = join(directory, name); await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return await realpath(candidate); }
    catch (error) { if (error !== null && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) continue; throw error; }
  }
  throw new Error("real cross-Harness acceptance requires installed " + name + "; missing is not a skipped pass");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { assert.ok(Buffer.isBuffer(chunk)); bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024); chunks.push(chunk); }
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))));
}
function responses(response: ServerResponse, answer: string): void {
  const content = { type: "output_text", text: answer, annotations: [], logprobs: [] };
  const item = { id: "msg_cross_fixture", type: "message", role: "assistant", status: "completed", content: [content] };
  const base = { id: "resp_cross_fixture", object: "response", created_at: 1791523200, status: "in_progress", error: null, incomplete_details: null, model: CODEX_MODEL, output: [], store: false };
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  event("response.created", { response: base });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: answer, logprobs: [] });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: answer, logprobs: [] });
  event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: content });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 24, output_tokens: 8, total_tokens: 32,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); response.end();
}
function gemini(response: ServerResponse): void {
  const value = { candidates: [{ content: { role: "model", parts: [{ text: "GEMINI-PUBLIC-ANSWER " + GEMINI_KEY }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 8, totalTokenCount: 32 }, modelVersion: GEMINI_MODEL, responseId: "cross-gemini-fixture" };
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); response.end("data: " + JSON.stringify(value) + "\n\n");
}
function target(provider: ProviderView) { return { providerId: provider.id, revision: provider.revision, model: provider.defaultModel }; }

/** Public history is rehydrated into fresh real native conversations; no native checkpoint is transferred. */
test("real Codex→Gemini→Codex uses the same public Session with explicit Providers and complete rehydrated history", { timeout: 60000 }, async t => {
  const [codexBinary, geminiBinary] = await Promise.all([executable("codex"), executable("gemini")]);
  const root = await mkdtemp(join(tmpdir(), "harness-cross-real-")), workspace = join(root, "workspace"), data = join(root, "data"), manifest = join(root, "catalog.json");
  await mkdir(workspace); const keep = "cross-Harness workspace marker\n"; await writeFile(join(workspace, "keep.txt"), keep);
  const calls: Call[] = [], errors: Error[] = [], publicEvents: unknown[] = [];
  const endpoints: ReturnType<typeof createServer>[] = [];
  let ownedApplication: ReturnType<typeof application> | undefined;
  t.after(async () => {
    let failure: unknown;
    if (ownedApplication) {
      try { await ownedApplication.runtime.close(); } catch (error) { failure = error; }
      try { await ownedApplication.management.shutdown(); } catch (error) { failure ??= error; }
      try { await ownedApplication.providers.shutdown(); } catch (error) { failure ??= error; }
      try { ownedApplication.store.close(); } catch (error) { failure ??= error; }
    }
    for (const endpoint of endpoints) {
      endpoint.closeAllConnections();
      if (endpoint.listening) await new Promise<void>((done, reject) => endpoint.close(error => error ? reject(error) : done())).catch((error: unknown) => { failure ??= error; });
    }
    await rm(root, { recursive: true, force: true }); if (failure) throw failure;
  });
  async function endpoint(harness: Call["harness"]): Promise<string> {
    const server = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, "POST"); const path = request.url ?? "", input = await body(request);
        const key = String(harness === "codex" ? request.headers.authorization : request.headers["x-goog-api-key"]);
        calls.push({ harness, path, key, input }); assert.ok(calls.length <= 3, "unexpected additional model request");
        if (harness === "codex") {
          assert.equal(path, "/v1/responses"); assert.equal(key, "Bearer " + CODEX_KEY); assert.equal(input.model, CODEX_MODEL);
          responses(response, "CODEX-PUBLIC-ANSWER " + CODEX_KEY);
        } else {
          assert.equal(path, `/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`); assert.equal(key, GEMINI_KEY); gemini(response);
        }
      })().catch((error: unknown) => { errors.push(error instanceof Error ? error : new Error("cross-Harness fixture failed")); response.writeHead(500); response.end(); });
    });
    endpoints.push(server); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); assert.ok(address && typeof address !== "string"); return `http://127.0.0.1:${address.port}` + (harness === "codex" ? "/v1" : "");
  }
  const codexUrl = await endpoint("codex"), geminiUrl = await endpoint("gemini");
  const catalog = loadBuiltinCatalog(catalogTarget());
  const codexControl = catalog.find(item => item.id === "codex")?.controls.find(item => item.protocol === "codex-app-server");
  const geminiControl = catalog.find(item => item.id === "gemini")?.controls.find(item => item.protocol === "acp-v1"); assert.ok(codexControl && geminiControl);
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { [codexControl.id]: { executable: codexBinary }, [geminiControl.id]: { executable: geminiBinary } } }));
  const app = ownedApplication = application(data, event => { publicEvents.push(event); }, { installations: "any", workspaceLockRoot: join(root, "locks") });
  const codexProvider = app.providers.create({ name: "Cross Codex", protocol: "openai-responses", baseUrl: codexUrl, models: [CODEX_MODEL], defaultModel: CODEX_MODEL, enabled: true, apiKey: CODEX_KEY }, "cross-provider-codex");
  const geminiProvider = app.providers.create({ name: "Cross Gemini", protocol: "gemini", baseUrl: geminiUrl, models: [GEMINI_MODEL], defaultModel: GEMINI_MODEL, enabled: true, apiKey: GEMINI_KEY }, "cross-provider-gemini");
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, searchDirs: [...new Set([dirname(codexBinary), dirname(geminiBinary)])], pathOnly: true });
  const session = await app.runtime.create(configuration, { harnessId: "codex", controlId: codexControl.id, provider: target(codexProvider) }, "cross-session");
  async function send(index: number): Promise<void> {
    const before = calls.length; app.runtime.send(session.id, MARKERS[index]! + ": reply briefly and do not use tools", "cross-message-" + index);
    await app.runtime.wait(session.id);
    const run = app.runtime.read(session.id).runs[index]; assert.ok(run);
    assert.equal(calls.length, before + 1, "real Harness ended without one intended local model request: " + JSON.stringify(run.error));
    assert.equal(run.status, "completed", JSON.stringify(run)); assert.equal(run.cleanup?.closed, true); assert.equal(run.cleanup?.protocolFailure, null);
  }
  await send(0);
  app.runtime.switch(session.id, { harnessId: "gemini", controlId: geminiControl.id, provider: target(geminiProvider) }, "cross-switch-gemini"); await app.runtime.wait(session.id);
  assert.equal(app.runtime.read(session.id).selection.harnessId, "gemini", JSON.stringify(app.runtime.read(session.id).switches)); await send(1);
  app.runtime.switch(session.id, { harnessId: "codex", controlId: codexControl.id, provider: target(codexProvider) }, "cross-switch-codex"); await app.runtime.wait(session.id);
  assert.equal(app.runtime.read(session.id).selection.harnessId, "codex"); await send(2);
  assert.deepEqual(errors, []); assert.equal(calls.length, 3); assert.deepEqual(calls.map(call => call.harness), ["codex", "gemini", "codex"]);
  for (let at = 0; at < calls.length; at++) {
    const serialized = JSON.stringify(calls[at]!.input);
    for (let prior = 0; prior <= at; prior++) assert.ok(serialized.includes(MARKERS[prior]!), "current and prior public input did not reach the selected model endpoint");
    assert.ok(serialized.includes("public_context_rehydrate")); assert.ok(!serialized.includes(CODEX_KEY) && !serialized.includes(GEMINI_KEY), "raw credentials entered the rehydrated public history");
  }
  assert.ok(JSON.stringify(calls[1]!.input).includes("CODEX-PUBLIC-ANSWER")); assert.ok(JSON.stringify(calls[2]!.input).includes("GEMINI-PUBLIC-ANSWER"));
  const final = app.runtime.read(session.id); assert.equal(final.id, session.id); assert.equal(final.epoch, 3); assert.equal(final.runs.length, 3);
  assert.deepEqual(final.runs.map(run => run.selection.harnessId), ["codex", "gemini", "codex"]);
  assert.deepEqual(final.runs.map(run => run.selection.provider), [target(codexProvider), target(geminiProvider), target(codexProvider)]);
  assert.ok(final.switches.every(entry => entry.status === "effective")); assert.deepEqual(final.runs[2]?.sourceRunIds, final.runs.slice(0, 2).map(run => run.id));
  const publicData = JSON.stringify({ final, publicEvents, persisted: app.store.events(session.id, 0), providers: app.providers.list() });
  assert.ok(!publicData.includes(CODEX_KEY) && !publicData.includes(GEMINI_KEY)); assert.ok(final.messages.filter(message => message.role === "assistant").every(message => message.text.includes("[redacted]")));
  const database = await readFile(join(data, "providers", "providers.sqlite")); assert.ok(!database.includes(Buffer.from(CODEX_KEY)) && !database.includes(Buffer.from(GEMINI_KEY)));
  assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), keep); assert.deepEqual(await readdir(workspace), ["keep.txt"]);
});
