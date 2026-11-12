import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";
import { catalogTarget } from "../../src/infrastructure/catalog/platform.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { evidenceHeader, guardTest, snapshot, type SuiteEvidence } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";

const MODEL = "gemini-2.5-flash";
const KEY = "synthetic-gemini-key-private-acceptance";
const MARKER = "GEMINI-MANAGED-PUBLIC-INPUT-MARKER";
const ANSWER = "Managed Gemini local Provider answer.";
/** The user's own environment: the guard (./guard.ts) proves its configuration untouched; HH_REAL_EVIDENCE, when set, receives the record (0600). */
const environment = captureNativeEnvironment(), evidencePath = process.env.HH_REAL_EVIDENCE, evidence: SuiteEvidence = { header: null, results: [] };
interface Call { readonly path: string; readonly key: string; readonly input: Record<string, unknown> }
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function executable(): Promise<string> {
  for (const directory of new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"])) {
    if (!isAbsolute(directory)) continue;
    try { const path = join(directory, "gemini"); await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); }
    catch (error) { if (error !== null && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))) continue; throw error; }
  }
  throw new Error("real managed Provider acceptance requires an installed Gemini executable; missing is not a skipped pass");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { assert.ok(Buffer.isBuffer(chunk)); bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024, "Gemini fixture input exceeded its budget"); chunks.push(chunk); }
  return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))));
}
function content(response: ServerResponse, stream: boolean): void {
  const result = { candidates: [{ content: { role: "model", parts: [{ text: ANSWER + " " + KEY }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 8, totalTokenCount: 32 }, modelVersion: MODEL, responseId: "gemini-local-fixture" };
  response.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json", "Cache-Control": "no-cache" });
  if (!stream) { response.end(JSON.stringify(result)); return; }
  const split = Math.floor(KEY.length / 2);
  response.write("data: " + JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: ANSWER + " " + KEY.slice(0, split) }] }, index: 0 }], modelVersion: MODEL }) + "\n\n");
  response.end("data: " + JSON.stringify({ ...result, candidates: [{ content: { role: "model", parts: [{ text: KEY.slice(split) }] }, finishReason: "STOP", index: 0 }] }) + "\n\n");
}

/** Real installed CLI, real application/SQLite/ACP; only the external model HTTP service is deterministic. */
test("real Gemini uses a managed private Provider endpoint, explicit model/key and committed public input", { timeout: 45000 }, async t => {
  // The Provider is HarnessHub's own; the user's Gemini configuration is snapshotted first and compared after the cleanup.
  const before = await snapshot(["gemini"], environment);
  const binary = await executable(), root = await mkdtemp(join(tmpdir(), "harness-gemini-managed-real-"));
  const workspace = join(root, "workspace"), data = join(root, "data"), manifest = join(root, "catalog.json"); await mkdir(workspace);
  const original = "fixture workspace configuration must remain unchanged\n";
  await writeFile(join(workspace, "keep.txt"), original);
  const calls: Call[] = [], failures: Error[] = [], events: unknown[] = [];
  let receivedResolve: (() => void) | undefined;
  const received = new Promise<void>(done => { receivedResolve = done; });
  const endpoint = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST"); assert.equal(request.headers["x-goog-api-key"], KEY);
      const input = await body(request), path = request.url ?? ""; calls.push({ path, key: String(request.headers["x-goog-api-key"]), input });
      assert.ok(calls.length <= 32, "Gemini unexpectedly repeated model calls");
      assert.match(path, new RegExp("^/v1beta/models/" + MODEL.replaceAll(".", "\\.") + ":(?:countTokens|generateContent|streamGenerateContent)(?:\\?alt=sse)?$", "u"));
      if (path.includes(":countTokens")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"totalTokens":24}'); return; }
      if (JSON.stringify(input).includes(MARKER)) receivedResolve?.();
      content(response, path.includes(":streamGenerateContent"));
    })().catch((error: unknown) => { failures.push(error instanceof Error ? error : new Error("Gemini fixture failed")); response.writeHead(500); response.end('{"error":{"code":500,"message":"local fixture rejected unexpected request"}}'); });
  });
  let ownedApplication: ReturnType<typeof application> | undefined;
  t.after(async () => {
    let failure: unknown;
    if (ownedApplication) {
      try { await ownedApplication.runtime.close(); } catch (error) { failure = error; }
      try { await ownedApplication.management.shutdown(); } catch (error) { failure ??= error; }
      try { await ownedApplication.providers.shutdown(); } catch (error) { failure ??= error; }
      try { ownedApplication.store.close(); } catch (error) { failure ??= error; }
    }
    endpoint.closeAllConnections();
    if (endpoint.listening) await new Promise<void>((done, reject) => endpoint.close(error => error ? reject(error) : done())).catch((error: unknown) => { failure ??= error; });
    await rm(root, { recursive: true, force: true });
    if (failure) throw failure;
  });
  const outcome = guardTest(t, before, environment, evidencePath, evidence);
  await new Promise<void>(done => endpoint.listen(0, "127.0.0.1", done));
  const address = endpoint.address(); assert.ok(address && typeof address !== "string");
  const control = loadBuiltinCatalog(catalogTarget()).find(item => item.id === "gemini")?.controls.find(item => item.protocol === "acp-v1");
  assert.ok(control, "built-in catalog must expose a Gemini ACP recipe");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { [control.id]: { executable: binary } } }));
  const app = ownedApplication = application(data, event => { events.push(event); }, { installations: "any", workspaceLockRoot: join(root, "locks") });
  const provider = app.providers.create({ name: "Managed Gemini fixture", protocol: "gemini", baseUrl: `http://127.0.0.1:${address.port}`,
    models: [MODEL], defaultModel: MODEL, enabled: true, apiKey: KEY }, "real-gemini-provider");
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, searchDirs: [dirname(binary)], pathOnly: true });
  evidence.header ??= await evidenceHeader(app, ["gemini"], { configuration });
  const target = { providerId: provider.id, revision: provider.revision, model: MODEL };
  const session = await app.runtime.create(configuration, { harnessId: "gemini", provider: target }, "real-gemini-session");
  app.runtime.send(session.id, MARKER + ": reply briefly without calling tools", "real-gemini-message");
  await Promise.race([received, app.runtime.wait(session.id).then(() => {
    throw new Error("real Gemini ended before the local Provider received the public input: " + JSON.stringify(oldShape(app.runtime, session.id).runs[0]));
  })]);
  await app.runtime.wait(session.id);
  assert.deepEqual(failures, []);
  const generation = calls.filter(call => call.path.includes(":streamGenerateContent"));
  assert.ok(generation.some(call => JSON.stringify(call.input).includes(MARKER)), "real Gemini did not dispatch the public context to the selected local endpoint");
  assert.ok(calls.every(call => call.key === KEY && call.path.includes(MODEL)));
  const final = oldShape(app.runtime, session.id), run = final.runs[0]; assert.ok(run);
  assert.equal(run.status, "completed", JSON.stringify(run)); assert.equal(run.cleanup?.closed, true); assert.equal(run.cleanup?.protocolFailure, null);
  assert.deepEqual(run.selection.provider, target); assert.match(final.messages.at(-1)?.text ?? "", /Managed Gemini local Provider answer/u);
  assert.match(final.messages.at(-1)?.text ?? "", /\[redacted\]/u, "real Gemini SSE key echo was not redacted");
  assert.equal(JSON.stringify({ final, events, views: app.providers.list() }).includes(KEY), false, "managed credential leaked into public output");
  assert.equal((await readFile(join(data, "providers", "providers.sqlite"))).includes(Buffer.from(KEY)), false);
  assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), original);
  assert.deepEqual(await readdir(workspace), ["keep.txt"], "Gemini modified the workspace configuration");
  outcome.completed = true;
});
