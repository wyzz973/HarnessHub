import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { LocalHarnessManagement } from "../../src/infrastructure/management/service.js";
import { LocalProviderService } from "../../src/infrastructure/provider/service.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { DirectorySessionBindingFactory, prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import type { ManagementMetadataPort } from "../../src/contracts/management.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { evidenceHeader, guardTest, snapshot, type SuiteEvidence } from "./guard.js";
const KEY = "managed-install-synthetic-key", MODEL = "managed-install-fixture-model";
/** The user's own environment: the guard (./guard.ts) proves its configuration untouched; HH_REAL_EVIDENCE, when set, receives the record (0600). */
const environment = captureNativeEnvironment(), evidencePath = process.env.HH_REAL_EVIDENCE, evidence: SuiteEvidence = { header: null, results: [] };
function record(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const raw of request) { assert.ok(Buffer.isBuffer(raw)); bytes += raw.length; assert.ok(bytes < 2 * 1024 * 1024); chunks.push(raw); }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function answer(response: ServerResponse, count: number): void {
  const text = `Real managed Codex turn ${count} passed.`, content = { type: "output_text", text, annotations: [], logprobs: [] };
  const item = { id: "message_fixture", type: "message", role: "assistant", status: "completed", content: [content] };
  const base = { id: "response_fixture", object: "response", created_at: 1791619200, status: "in_progress", error: null, incomplete_details: null, model: MODEL, output: [], store: false };
  let seq = 0; response.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (type: string, fields: Record<string, unknown>): void => { response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...fields })}\n\n`); };
  event("response.created", { response: base }); event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text, logprobs: [] });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] });
  event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: content }); event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); response.end();
}
test("real npm installs and upgrades private Codex versions, then the gateway executes each immutable default", { timeout: 300000 }, async t => {
  // Everything here is private to the test; the user's Codex configuration is snapshotted first and compared after the cleanup.
  const before = await snapshot(["codex"], environment);
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-real-managed-"))), workspace = join(root, "workspace"), data = join(root, "data"); await mkdir(workspace);
  const store = new SqliteSessionStore(data), providers = new LocalProviderService(data, () => store.assertOwner());
  let desired = "0.160.0";
  const metadata: ManagementMetadataPort = { resolve: async (recipe, signal) => {
    assert.equal(recipe.packageName, "@openai/codex");
    const response = await fetch("https://registry.npmjs.org/@openai%2Fcodex/" + desired, { signal, redirect: "error" }); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 1024 * 1024);
    const item = record(JSON.parse(text)), distribution = record(item.dist); assert.equal(item.name, recipe.packageName); assert.equal(item.version, desired); assert.equal(typeof distribution.integrity, "string");
    const engines = record(item.engines), engine: Record<string, string> = {}; for (const [key, value] of Object.entries(engines)) { assert.equal(typeof value, "string"); if (typeof value === "string") engine[key] = value; }
    return { recipe, version: desired, artifactUrl: null, integrity: String(distribution.integrity), engines: engine, dependencies: [] };
  } };
  const management = new LocalHarnessManagement(data, { installationMode: "private-fixture", assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration, metadata, redactor: text => providers.redact(text) });
  // This legacy private-installer fixture must not discover the user's actual system Codex.
  // Production correctly gives that original local install priority over a private version slot.
  const nativeEnvironment = { home: root, values: { HOME: root, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } };
  const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(root, "leases")), () => store.assertOwner(), "official", providers, management, nativeEnvironment);
  const runtime = new SessionRuntime(store, factory, { id: randomUUID, now: () => new Date(), publish: () => {}, fingerprint: text => createHash("sha256").update(text).digest("hex") });
  const calls: Record<string, unknown>[] = [], errors: Error[] = [];
  const endpoint = createServer((request, response) => { void (async () => { assert.equal(request.url, "/v1/responses"); assert.equal(request.headers.authorization, "Bearer " + KEY); const input = await body(request); assert.equal(input.model, MODEL); calls.push(input); answer(response, calls.length); })().catch((error: unknown) => { errors.push(error instanceof Error ? error : new Error("model fixture failed")); response.writeHead(500); response.end(); }); });
  t.after(async () => { let failure: unknown; try { await runtime.close(); } catch (e) { failure = e; } try { await management.shutdown(); } catch (e) { failure ??= e; } try { await providers.shutdown(); store.close(); } catch (e) { failure ??= e; } endpoint.closeAllConnections(); if (endpoint.listening) await new Promise<void>(done => endpoint.close(() => done())); await rm(root, { recursive: true, force: true }); if (failure) throw failure; });
  const outcome = guardTest(t, before, environment, evidencePath, evidence);
  await new Promise<void>(done => endpoint.listen(0, "127.0.0.1", done)); const address = endpoint.address(); assert.ok(address && typeof address === "object");
  async function install(action: "install" | "upgrade", revision: number) {
    const job = management.submit({ harnessId: "codex", action, commandId: "real-" + action, expectedDefaultRevision: revision }); const deadline = Date.now() + 120000;
    while (!["completed", "failed", "cancelled", "unknown"].includes(management.readJob(job.id).status)) { assert.ok(Date.now() < deadline, "real package manager exceeded acceptance deadline"); await pause(50); }
    const final = management.readJob(job.id); assert.equal(final.status, "completed", JSON.stringify({ job: final, logs: management.logs(job.id, 0, 100) }));
    const selected = management.resolveControl("codex", "codex-native"); assert.ok(selected); assert.equal(selected.version, desired); return selected;
  }
  const first = await install("install", 0), firstEntry = first.command.args[0]; assert.ok(firstEntry); const original = await readFile(firstEntry);
  const provider = providers.create({ name: "Managed install fixture", protocol: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [MODEL], defaultModel: MODEL, enabled: true, apiKey: KEY }, "managed-model");
  const configuration = await prepareConfiguration({ workspace, pathOnly: true });
  const session = await runtime.create(configuration, { harnessId: "codex", controlId: "codex-native", provider: { providerId: provider.id, revision: provider.revision, model: MODEL } }, "managed-session");
  runtime.send(session.id, "PRIVATE-INSTALL-FIRST: respond briefly without tools", "managed-first"); await runtime.wait(session.id); assert.equal(runtime.read(session.id).runs[0]?.status, "completed");
  desired = "0.162.1"; const second = await install("upgrade", 1); assert.notEqual(second.installationId, first.installationId); assert.notEqual(second.command.args[0], first.command.args[0]); assert.equal(second.revision, 2); assert.deepEqual(await readFile(firstEntry), original);
  runtime.send(session.id, "PRIVATE-INSTALL-SECOND: continue briefly", "managed-second"); await runtime.wait(session.id);
  const final = runtime.read(session.id); assert.ok(final.runs.every(run => run.status === "completed" && run.cleanup?.closed)); assert.equal(calls.length, 2); assert.deepEqual(errors, []); assert.ok(JSON.stringify(calls[1]).includes("PRIVATE-INSTALL-FIRST"));
  const installations = store.events(session.id, 0).filter(event => event.type === "run.installation_resolved").map(event => record(event.data.installation)); assert.deepEqual(installations.map(item => item.version), ["0.160.0", "0.162.1"]);
  assert.ok(!JSON.stringify({ final, jobs: management.listJobs(), logs: management.listJobs().flatMap(job => management.logs(job.id, 0, 100)) }).includes(KEY));
  // The header of what ran: this test's private environment and management, which hold the managed default now in use.
  evidence.header ??= await evidenceHeader({ factory, management }, ["codex"], { configuration });
  outcome.details.installedVersions = installations.map(item => item.version);
  outcome.completed = true;
});
