import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { ManagementError, type InstallationJobView } from "../../src/contracts/management.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { conversationMarkdown } from "../../src/web/conversation-export.js";
import type { SessionView } from "../../src/contracts/web.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { commandId, switchId, sessionId } from "../../src/contracts/session.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
function row(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
interface Fixture { root: string; data: string; workspace: string; manifest: string; trace: string; assets: string; gateway: WebServer; origin: string; token: string; cookie: string; csrf: string; expectedShutdownError: boolean }
async function fixture(t: test.TestContext, scenario = "basic"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-web-")), workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json"), trace = join(root, "trace.ndjson");
  await mkdir(workspace); await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>HarnessGateway fixture</title>");
  await writeFile(join(assets, "fixture.js"), "export const application = 'fixture';");
  const source = { repository: "fixture", revision: "web", upstreamId: "peer", url: "https://example.invalid/web-peer" };
  const definitions = ["a", "b", "bad"].map(name => ({ id: "web-" + name, name: "Web " + name, aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "web-" + name + "-control", protocol: name === "b" ? "codex-app-server" : "acp-v1", executableNames: ["fixture-peer"],
      args: [peer, name === "b" ? "codex-app-server" : "acp-v1", name, name === "bad" ? "initialize-failure" : scenario],
      env: { FIXTURE_TRACE: trace, FIXTURE_EXPECT_HISTORY: JSON.stringify({ first: [], second: ["first"], third: ["first", "second"] }) },
      requiredExecutables: [], package: null, distribution: null, source }] }));
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(item => [item.controls[0]!.id, { executable: process.execPath }])) }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const data = join(root, "data"), gateway = await startWebServer({ installations: "any", root: data, configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: join(root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) });
  const parsed = new URL(gateway.url), f = { root, workspace: configuration.workspace, assets, manifest, trace, data, gateway, origin: parsed.origin, token: new URLSearchParams(parsed.hash.slice(1)).get("token")!, cookie: "", csrf: "", expectedShutdownError: false };
  t.after(async () => {
    if (f.expectedShutdownError) await assert.rejects(f.gateway.close(), (error: unknown) => row(error).code === "SESSION_BLOCKED");
    else await f.gateway.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function auth(f: Fixture): Promise<void> {
  const response = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get("set-cookie"); assert.ok(cookie); assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/api\//u);
  f.cookie = cookie.split(";", 1)[0]!; f.csrf = String(row(await response.json()).csrfToken);
}
async function call(f: Fixture, path: string, method = "GET", input?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: unknown; text: string }> {
  const response = await fetch(f.origin + path, { method, headers: { Cookie: f.cookie, Origin: f.origin,
    ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": f.csrf }), ...extra },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); return { status: response.status, data: JSON.parse(text) as unknown, text };
}
async function raw(f: Fixture, path: string, input: unknown, extra: Record<string, string>): Promise<{ status: number; text: string }> {
  return new Promise((done, reject) => {
    const req = request(f.origin + path, { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, "Content-Type": "application/json", "X-CSRF-Token": f.csrf, ...extra } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += String(chunk); });
      response.on("end", () => done({ status: response.statusCode ?? 0, text })); response.on("error", reject);
    });
    req.on("error", reject); req.end(JSON.stringify(input));
  });
}
async function create(f: Fixture, commandId = "create-web"): Promise<string> {
  const response = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "web-a" }, commandId }); assert.equal(response.status, 201, response.text);
  return String(row(response.data).id);
}
async function state(f: Fixture, id: string): Promise<SessionView> {
  const response = await call(f, "/api/v1/sessions/" + id); assert.equal(response.status, 200, response.text);
  assertView(response.data); assert.equal(response.data.id, id); return response.data;
}
function assertView(value: unknown): asserts value is SessionView {
  const item = row(value);
  for (const key of ["id", "status", "workspace"]) assert.equal(typeof item[key], "string");
  for (const key of ["version", "lastSeq", "epoch"]) assert.equal(typeof item[key], "number");
  for (const key of ["runs", "messages", "switches"]) assert.ok(Array.isArray(item[key]));
  assert.ok(item.selection !== null && typeof item.selection === "object");
}
async function waitFor(f: Fixture, id: string, predicate: (value: SessionView) => boolean): Promise<SessionView> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const snapshot = await state(f, id); if (predicate(snapshot)) return snapshot; await delay(20); }
  throw new Error("HTTP Session did not reach expected state: " + JSON.stringify(await state(f, id)));
}
async function trace(f: Fixture): Promise<readonly Record<string, unknown>[]> { return (await readFile(f.trace, "utf8")).trim().split("\n").map(value => row(JSON.parse(value))); }

test("local web startup authenticates once, restores CSRF, and serves same-origin assets with security headers", async t => {
  const f = await fixture(t);
  const page = await fetch(f.origin); assert.equal(page.status, 200); assert.match(await page.text(), /HarnessGateway fixture/u);
  assert.equal(page.headers.get("x-frame-options"), "DENY"); assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  // The page and its assets come only from this Gateway (ADR-054 §2): no Google Fonts or any other origin is allowed.
  for (const response of [page, await fetch(f.origin + "/fixture.js")]) {
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.equal(policy, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    assert.doesNotMatch(policy, /https?:|fonts\.(?:googleapis|gstatic)\.com/u);
  }
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const unauthenticated = await call(f, "/api/v1/state"); assert.equal(unauthenticated.status, 401);
  await auth(f);
  assert.equal(row((await call(f, "/api/v1/auth/session")).data).csrfToken, f.csrf);
  const replay = await call(f, "/api/v1/auth/bootstrap", "POST", { token: f.token }); assert.equal(replay.status, 401);
  const script = await fetch(f.origin + "/fixture.js"); assert.equal(script.status, 200); assert.match(script.headers.get("content-type") ?? "", /javascript/u);
});

test("HTTP state exposes catalog candidates without private commands or configuration references", async t => {
  const f = await fixture(t); await auth(f);
  const result = await call(f, "/api/v1/state"); assert.equal(result.status, 200);
  const output = row(result.data); assert.equal(output.workspace, f.workspace); assert.ok(Array.isArray(output.harnesses));
  const custom = output.harnesses.map(row).find(item => item.id === "web-a"); assert.ok(custom); assert.ok(Array.isArray(custom.controls));
  assert.equal(row(custom.controls[0]).available, true); assert.deepEqual(custom.providerProtocols, []);
  assert.equal(result.text.includes(f.manifest), false); assert.equal(result.text.includes(process.execPath), false); assert.equal(result.text.includes("FIXTURE_TRACE"), false);
  assert.equal((await call(f, "/api/v1/harnesses/rescan", "POST", {})).status, 200);
});

test("real HTTP and SQLite preserve A→B→A public history and idempotent accepted messages", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  assert.equal(await create(f), id);
  const first = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); assert.equal(first.status, 202);
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  const replay = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); assert.equal(row(replay.data).replayed, true);
  const conflict = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "changed", commandId: "first" }); assert.equal(conflict.status, 409);
  const toB = await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId: "web-b" }, commandId: "switch-b" }); assert.equal(toB.status, 202);
  await waitFor(f, id, value => value.epoch === 2);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "second", commandId: "second" }); await waitFor(f, id, value => value.runs[1]?.status === "completed");
  await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId: "web-a", provider: null }, commandId: "switch-a" }); await waitFor(f, id, value => value.epoch === 3);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "third", commandId: "third" }); const final = await waitFor(f, id, value => value.runs[2]?.status === "completed");
  assert.deepEqual(final.messages.map(message => message.text), ["first", "a:first", "second", "b:second", "third", "a:third"]);
  assert.ok(final.runs.every(run => run.cleanup?.closed === true)); assert.equal("configuration" in final, false); assert.equal("commands" in final, false);
  assert.equal((await trace(f)).filter(item => item.kind === "prompt").length, 3);
});

test("event cursor replay is durable and HTTP connection loss does not cancel a running Harness", async t => {
  const f = await fixture(t, "hold"); await auth(f); const id = await create(f);
  const receipt = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); const runId = row(receipt.data).runId;
  await waitFor(f, id, value => value.messages.some(message => message.role === "assistant"));
  const aborted = new AbortController(); const pending = fetch(f.origin + `/api/v1/sessions/${id}/events?afterSeq=0&limit=1`, { headers: { Cookie: f.cookie }, signal: aborted.signal }); aborted.abort(); await assert.rejects(pending);
  assert.equal((await state(f, id)).runs[0]?.status, "running");
  let afterSeq = 0, count = 0;
  for (;;) {
    const result = row((await call(f, `/api/v1/sessions/${id}/events?afterSeq=${afterSeq}&limit=2`)).data);
    assert.ok(Array.isArray(result.events)); const events = result.events.map(row); assert.ok(events.every(item => Number(item.seq) > afterSeq));
    count += events.length; afterSeq = Number(result.nextSeq); if (!result.hasMore) break;
  }
  assert.ok(count > 2);
  const cancel = await call(f, `/api/v1/sessions/${id}/cancel`, "POST", { runId, commandId: "cancel" }); assert.equal(cancel.status, 202);
  const ended = await waitFor(f, id, value => value.runs[0]?.status === "cancelled"); assert.equal(ended.runs[0]?.cleanup?.closed, true);
});

test("failed switch does not dispatch later messages on the old Harness", async t => {
  const f = await fixture(t, "hold"); await auth(f); const id = await create(f);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); await waitFor(f, id, value => value.messages.some(message => message.role === "assistant"));
  await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId: "web-unavailable" }, commandId: "bad-switch" });
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "second", commandId: "second" });
  await call(f, `/api/v1/sessions/${id}/cancel`, "POST", { commandId: "cancel-first" });
  const ended = await waitFor(f, id, value => value.runs[1]?.status === "failed"); assert.equal(ended.switches[0]?.status, "failed");
  assert.equal(ended.selection.harnessId, "web-a"); assert.equal(ended.runs[1]?.error?.code, "SWITCH_NOT_EFFECTIVE");
  assert.equal((await trace(f)).filter(item => item.kind === "prompt").length, 1);
});

test("target startup failure preserves the conversation and never dispatches waiting messages on the old Harness", async t => {
  const f = await fixture(t, "hold"); await auth(f); const id = await create(f);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); await waitFor(f, id, value => value.messages.some(message => message.role === "assistant"));
  await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId: "web-bad" }, commandId: "bad-switch" });
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "second", commandId: "second" });
  await call(f, `/api/v1/sessions/${id}/cancel`, "POST", { commandId: "cancel-first" });
  const ended = await waitFor(f, id, value => value.runs[1]?.status === "failed"); assert.equal(ended.switches[0]?.status, "effective");
  assert.equal(ended.status, "open");
  assert.equal(ended.runs[1]?.backend, null); assert.equal(ended.runs[1]?.cleanup?.closed, true); assert.equal(ended.selection.harnessId, "web-bad");
  assert.equal((await trace(f)).filter(item => item.kind === "prompt").length, 1);
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "third", commandId: "third" })).status, 202);
  await call(f, `/api/v1/sessions/${id}/cancel`, "POST", { commandId: "stop-third" });
});

test("Provider HTTP create and revision update redact keys and preserve optimistic/idempotent identities", async t => {
  const f = await fixture(t); await auth(f);
  const input = { name: "Local model", protocol: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", models: ["model-a"], defaultModel: "model-a", enabled: true, apiKey: "synthetic-key-never-in-browser-response" };
  const created = await call(f, "/api/v1/providers", "POST", { input, commandId: "provider-create" }); assert.equal(created.status, 201, created.text);
  assert.equal(created.text.includes(input.apiKey), false); const provider = row(created.data); assert.equal(provider.hasCredential, true);
  const replay = await call(f, "/api/v1/providers", "POST", { input, commandId: "provider-create" }); assert.equal(row(replay.data).id, provider.id);
  const updated = await call(f, `/api/v1/providers/${provider.id}`, "PATCH", { input: { ...input, name: "Changed" }, expectedRevision: 1, commandId: "provider-update" }); assert.equal(updated.status, 200); assert.equal(row(updated.data).revision, 2);
  const stale = await call(f, `/api/v1/providers/${provider.id}`, "PATCH", { input, expectedRevision: 1, commandId: "provider-stale" }); assert.equal(stale.status, 409);
  const listed = await call(f, "/api/v1/providers"); assert.equal(listed.text.includes(input.apiKey), false); assert.equal((await call(f, "/api/v1/state")).text.includes(input.apiKey), false);
  const id = await create(f);
  const unsupported = await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId: "web-a", provider: { providerId: provider.id, revision: 2, model: "model-a" } }, commandId: "unsupported" }); assert.equal(unsupported.status, 202);
  const failed = await waitFor(f, id, value => value.switches[0]?.status === "failed"); assert.equal(failed.switches[0]?.error?.code, "UNSUPPORTED_PROVIDER");
});

test("Provider probe runs an actual local models endpoint and never returns endpoint diagnostics or keys", async t => {
  const endpoint = createServer((request, response) => { assert.equal(request.url, "/v1/models"); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ data: [{ id: "model-a" }] })); });
  await new Promise<void>(done => endpoint.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done, reject) => endpoint.close(error => error ? reject(error) : done())));
  const address = endpoint.address(); assert.ok(address && typeof address !== "string");
  const f = await fixture(t); await auth(f);
  const result = await call(f, "/api/v1/providers", "POST", { input: { name: "Local model", protocol: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: ["model-a"], defaultModel: "model-a", enabled: true }, commandId: "provider" });
  const provider = row(result.data), probe = await call(f, `/api/v1/providers/${provider.id}/probe`, "POST", {}); assert.equal(probe.status, 200, probe.text);
  assert.deepEqual(probe.data, { status: "models_reachable", models: ["model-a"] });
});

test("closed Session retains history and denies new messages; server reopen preserves the same identity", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); await waitFor(f, id, value => value.runs[0]?.status === "completed");
  const closed = await call(f, `/api/v1/sessions/${id}/close`, "POST", { commandId: "close" }); assert.equal(closed.status, 200); assert.equal(row(closed.data).status, "closed");
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "second", commandId: "second" })).status, 409);
  await f.gateway.close();
  const configuration = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true });
  const reopened = await startWebServer({ installations: "any", root: f.data, configuration, port: 0, assetsDirectory: f.assets, workspaceLockRoot: join(f.root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(f.root, "locks") }) }); f.gateway = reopened;
  const parsed = new URL(reopened.url); const next = { ...f, gateway: reopened, origin: parsed.origin, token: new URLSearchParams(parsed.hash.slice(1)).get("token")!, cookie: "", csrf: "" }; await auth(next);
  const history = await state(next, id); assert.equal(history.status, "closed"); assert.equal(history.runs.length, 1); assert.equal(history.messages.at(-1)?.text, "a:first");
});

test("cross-site writes, invalid Host, missing Origin, CSRF and wrong content type are rejected before mutation", async t => {
  const f = await fixture(t); await auth(f);
  const input = { selection: { harnessId: "web-a" }, commandId: "hostile" };
  for (const [extra, expected] of [[{ Origin: "https://attacker.invalid" }, 403], [{ Host: "attacker.invalid" }, 403], [{ "X-CSRF-Token": "wrong" }, 403], [{ "Content-Type": "text/plain" }, 415], [{ "Sec-Fetch-Site": "cross-site" }, 403]] as const) {
    const rejected = await raw(f, "/api/v1/sessions", input, extra); assert.equal(rejected.status, expected, JSON.stringify(extra) + ": " + rejected.text);
  }
  const noOrigin = await fetch(f.origin + "/api/v1/sessions", { method: "POST", headers: { Cookie: f.cookie, "X-CSRF-Token": f.csrf, "Content-Type": "application/json" }, body: JSON.stringify(input) }); assert.equal(noOrigin.status, 403);
  assert.deepEqual((await call(f, "/api/v1/sessions")).data, []);
});

test("web input rejects malformed JSON, UTF-8, unknown fields, over-limit bodies and unsafe cursors", async t => {
  const f = await fixture(t); await auth(f);
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff, 0xfe])]) {
    const response = await fetch(f.origin + "/api/v1/sessions", { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, "X-CSRF-Token": f.csrf, "Content-Type": "application/json" }, body: bytes }); assert.equal(response.status, 400);
  }
  const large = await fetch(f.origin + "/api/v1/sessions", { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, "X-CSRF-Token": f.csrf, "Content-Type": "application/json" }, body: " ".repeat(128 * 1024 + 1) }); assert.equal(large.status, 413);
  assert.equal((await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "web-a" }, commandId: "unknown", configHome: f.root })).status, 400);
  assert.equal((await call(f, "/api/v1/sessions?limit=101")).status, 400);
  assert.equal((await call(f, "/api/v1/sessions?limit=1&limit=2")).status, 400);
  const id = await create(f);
  for (const query of ["afterSeq=-1", "afterSeq=1.5", "limit=0", "unexpected=1"]) assert.equal((await call(f, `/api/v1/sessions/${id}/events?${query}`)).status, 400);
  assert.equal((await call(f, "/api/v1/sessions/session-absent")).status, 404);
});

test("static requests cannot escape the asset root or read a symlinked private file", async t => {
  const f = await fixture(t), secret = join(f.root, "private.js"); await writeFile(secret, "private secret marker"); await symlink(secret, join(f.assets, "outside.js"));
  const link = await fetch(f.origin + "/outside.js"); assert.equal(link.status, 404); assert.equal((await link.text()).includes("private secret marker"), false);
  const encoded = await fetch(f.origin + "/%2fprivate.js"); assert.equal(encoded.status, 400);
  const options = await fetch(f.origin + "/api/v1/sessions", { method: "OPTIONS", headers: { Origin: "https://attacker.invalid" } }); assert.equal(options.status, 403);
  await writeFile(join(f.assets, "large.js"), Buffer.alloc(4 * 1024 * 1024 + 1)); assert.equal((await fetch(f.origin + "/large.js")).status, 404);
});

test("HTTP concurrent unfinished bodies are bounded and do not create Sessions", async t => {
  const f = await fixture(t); await auth(f);
  const requests = Array.from({ length: 16 }, () => {
    const req = request(f.origin + "/api/v1/sessions", { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, "Content-Type": "application/json", "X-CSRF-Token": f.csrf, "Content-Length": "100" } });
    req.on("error", () => {}); req.flushHeaders(); req.write("{"); return req;
  });
  try { await delay(100); assert.equal((await call(f, "/api/v1/state")).status, 429); }
  finally { for (const req of requests) req.destroy(); }
  await delay(100); assert.deepEqual((await call(f, "/api/v1/sessions")).data, []);
});

test("closing the web owner waits for the running Harness cleanup and releases the data owner", async t => {
  const f = await fixture(t, "hold"); await auth(f); const id = await create(f);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" }); await waitFor(f, id, value => value.runs[0]?.status === "running");
  await f.gateway.close(); await f.gateway.close();
  for (const child of (await trace(f)).filter(item => item.kind === "spawn")) assert.throws(() => process.kill(Number(child.pid), 0), (error: unknown) => row(error).code === "ESRCH");
  const reopened = await startWebServer({ installations: "any", root: f.data, configuration: await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true }), port: 0, assetsDirectory: f.assets, workspaceLockRoot: join(f.root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(f.root, "locks") }) });
  f.gateway = reopened;
});

test("authenticated recovery restores a legacy blocked conversation without rewriting history or sending a prompt", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" });
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  await f.gateway.close();
  const store = new SqliteSessionStore(f.data), snapshot = store.get(sessionId(id)), legacyId=switchId("switch-legacy"), broken=commandId("broken");
  const error={code:"GATEWAY_AUTH_REQUIRED",message:"synthetic legacy startup failure"};
  store.transact(snapshot.id,snapshot.version,current=>({next:{...current,status:"blocked",switches:[{id:legacyId,commandId:broken,requested:{harnessId:"web-bad"},requestedSeq:current.lastSeq+1,target:{harnessId:"web-bad",controlId:"web-bad-control"},status:"failed",throughSeq:current.lastSeq+3,sourceRunIds:current.runs.map(run=>run.id),error}],commands:[...current.commands,{id:broken,kind:"switch",fingerprint:"0".repeat(64),resultId:legacyId}]},events:[{type:"switch.requested",data:{switchId:legacyId}},{type:"switch.failed",data:{switchId:legacyId,error,cleanup:{closed:true,exitCode:0,signal:null,protocolFailure:null}}},{type:"session.blocked",data:{switchId:legacyId}}]}));
  const legacy=store.get(snapshot.id); const failed={runs:legacy.runs,messages:legacy.messages,switches:legacy.switches}; store.close();
  f.gateway = await startWebServer({ installations: "any", root: f.data, configuration: await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true }), port: 0, assetsDirectory: f.assets, workspaceLockRoot: join(f.root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(f.root, "locks") }) });
  const launch = new URL(f.gateway.url); f.origin = launch.origin; f.token = new URLSearchParams(launch.hash.slice(1)).get("token")!; await auth(f);
  const count = (await trace(f)).filter(item => item.kind === "prompt").length;
  const input = { selection: { harnessId: "web-b" }, commandId: "resume" };
  assert.equal((await call(f, `/api/v1/sessions/${id}/resume`, "POST", { ...input, acknowledgeUnknown: "yes" })).status, 400);
  const accepted = await call(f, `/api/v1/sessions/${id}/resume`, "POST", input); assert.equal(accepted.status, 202, accepted.text);
  const resumed = await waitFor(f, id, value => value.status === "open");
  assert.equal(resumed.id, id); assert.deepEqual(resumed.runs, failed.runs); assert.deepEqual(resumed.messages, failed.messages);
  assert.deepEqual(resumed.switches[0], failed.switches[0]); assert.equal(resumed.selection.harnessId, "web-b");
  assert.equal((await trace(f)).filter(item => item.kind === "prompt").length, count);
  const replay = await call(f, `/api/v1/sessions/${id}/resume`, "POST", input); assert.equal(replay.status, 202); assert.equal(row(replay.data).replayed, true);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "second", commandId: "second" });
  await waitFor(f, id, value => value.runs[1]?.status === "completed");
  const incompatible = await call(f, `/api/v1/sessions/${id}/resume`, "POST", { selection: { harnessId: "web-a" }, commandId: "already-open" }); assert.equal(incompatible.status, 409);
});

test("stored native content is served only to the authenticated page and never renders active documents", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/v1/content/content-unknown")).status, 401);
  await auth(f);
  const content = new LocalContentStore(f.data, () => {});
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  const image = await content.storeOutput({ workspace: f.workspace, name: "图表.png", mediaType: "image/png", data: png });
  const page = await content.storeOutput({ workspace: f.workspace, name: "page.html", mediaType: "text/html", data: Buffer.from("<script>alert(1)</script>") });
  const shown = await fetch(f.origin + "/api/v1/content/" + image.id, { headers: { Cookie: f.cookie } });
  assert.equal(shown.status, 200); assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(shown.headers.get("content-disposition"), "inline; filename*=UTF-8''" + encodeURIComponent("图表.png"));
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff"); assert.match(shown.headers.get("content-security-policy") ?? "", /sandbox/u);
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
  const html = await fetch(f.origin + "/api/v1/content/" + page.id, { headers: { Cookie: f.cookie } });
  assert.equal(html.headers.get("content-type"), "application/octet-stream"); assert.match(html.headers.get("content-disposition") ?? "", /^attachment;/u); await html.arrayBuffer();
  const download = await fetch(f.origin + "/api/v1/content/" + image.id + "?download=1", { headers: { Cookie: f.cookie } });
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/u); await download.arrayBuffer();
  const head = await fetch(f.origin + "/api/v1/content/" + image.id, { method: "HEAD", headers: { Cookie: f.cookie } });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(png.length));
  assert.equal((await call(f, "/api/v1/content/content-missing")).status, 404);
  assert.equal((await call(f, "/api/v1/content/not-content")).status, 404);
  assert.equal((await call(f, "/api/v1/content/" + image.id + "?download=yes")).status, 400);
});

test("attachments upload as raw bytes for this workspace, go to the Harness with their message, and can be withdrawn", async t => {
  const f = await fixture(t, "attachments"); await auth(f); const id = await create(f);
  const upload = (name: string, type: string, body: Buffer, headers: Record<string, string> = {}) => fetch(f.origin + "/api/v1/attachments?" + new URLSearchParams({ name, commandId: "up-" + name.replace(/[^a-z]/giu, "") }),
    { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin, "X-CSRF-Token": f.csrf, "Content-Type": type, ...headers }, body: new Uint8Array(body) });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3]);
  assert.equal((await upload("shot.png", "image/png", png, { "X-CSRF-Token": "wrong" })).status, 403);
  const created = await upload("shot.png", "image/png", png); assert.equal(created.status, 201);
  const image = row(await created.json());
  assert.equal(image.kind, "image"); assert.equal(image.name, "shot.png"); assert.equal(image.bytes, png.length);
  assert.equal(row(await (await upload("shot.png", "image/png", png)).json()).id, image.id, "a retried upload returns the same content");
  assert.equal((await upload("fake.png", "image/png", Buffer.from("<svg/>"))).status, 400);
  assert.equal((await upload("empty.txt", "text/plain", Buffer.alloc(0))).status, 413);
  const pdf = row(await (await upload("doc.pdf", "application/pdf", Buffer.from("%PDF-1.4"))).json());
  const shown = await fetch(f.origin + "/api/v1/content/" + String(image.id), { headers: { Cookie: f.cookie } });
  assert.equal(shown.headers.get("content-type"), "image/png"); assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "look", commandId: "with-files", attachments: [image.id, pdf.id] })).status, 202);
  const done = await waitFor(f, id, value => value.runs[0]?.status === "completed");
  assert.deepEqual(done.runs[0]?.attachments?.map(item => item.id), [image.id, pdf.id]);
  const prompt = (await trace(f)).find(item => item.kind === "prompt")!, blocks = prompt.attachments as Record<string, unknown>[];
  assert.deepEqual(blocks.map(block => block.type), ["image", "resource_link"]);
  assert.equal(blocks[0]!.data, png.toString("base64")); assert.equal(blocks[1]!.name, "doc.pdf");
  assert.match(String(blocks[1]!.uri), /^file:\/\/.*\/content\/files\/content-[^/]+\/doc\.pdf$/u);
  // Withdrawing a staged upload refuses it for later messages; the sent message keeps its attachment.
  const later = row(await (await upload("later.png", "image/png", png)).json());
  const withdrawn = await fetch(f.origin + "/api/v1/attachments/" + String(later.id), { method: "DELETE", headers: { Cookie: f.cookie, Origin: f.origin, "X-CSRF-Token": f.csrf } });
  assert.equal(withdrawn.status, 204);
  const refused = await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "again", commandId: "withdrawn", attachments: [later.id] });
  assert.equal(refused.status, 409); assert.equal(row(refused.data).code, "ATTACHMENT_UNAVAILABLE");
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "bad", commandId: "bad-list", attachments: "nope" })).status, 400);
  assert.equal((await state(f, id)).runs.length, 1);
});

test("a conversation's native session is offered for continuing in its own program on request, and never in its view or export", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/v1/sessions/session-unknown/native-resume")).status, 401, "a login is required");
  await auth(f);
  // A Codex-protocol entry always keeps its native thread.
  const created = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "web-b" }, commandId: "create-native-resume" }); assert.equal(created.status, 201, created.text);
  const id = String(row(created.data).id);
  assert.deepEqual((await call(f, `/api/v1/sessions/${id}/native-resume`)).data, { resume: null }, "nothing before a native session exists");
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "hello", commandId: "native-resume-send" })).status, 202);
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  const scannedAt = async () => String(row((await call(f, "/api/v1/state")).data).harnessesScannedAt);
  const before = await scannedAt();
  const resume = await call(f, `/api/v1/sessions/${id}/native-resume`);
  assert.equal(resume.status, 200);
  // A product with no continue command HarnessHub can give: its own identifier, and why there is no command.
  const nativeId = String(row(row(resume.data).resume).nativeId);
  assert.deepEqual(resume.data, { resume: { harnessId: "web-b", nativeId, note: "no-command" } }); assert.match(nativeId, /^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
  // Reading the commands twice scans nothing: the commands do not depend on the installed version (ADR-053), so the last scan stands.
  // Mutation check (run by hand, not kept): with the route scanning as before ADR-053, the scan time below changes.
  assert.deepEqual((await call(f, `/api/v1/sessions/${id}/native-resume`)).data, resume.data);
  assert.equal(await scannedAt(), before, "reading the continue commands does not start a scan");
  assert.equal(JSON.stringify((await call(f, "/api/v1/sessions/" + id)).data).includes(nativeId), false, "the view does not carry it");
  const exported = await fetch(f.origin + `/api/v1/sessions/${id}/export?format=json`, { headers: { Cookie: f.cookie } });
  assert.equal((await exported.text()).includes(nativeId), false, "the export does not carry it");
  assert.equal((await call(f, `/api/v1/sessions/${id}/native-resume?extra=1`)).status, 400);
});

test("a binding that opens a new native session (opensNew) offers no continue command: its checkpoint names the session it gave up (G068 fix batch 2, M-4)", async t => {
  const f = await fixture(t); await auth(f);
  const created = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "web-b" }, commandId: "create-opens-new" }); assert.equal(created.status, 201, created.text);
  const id = String(row(created.data).id);
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "hello", commandId: "opens-new-send" })).status, 202);
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  assert.notEqual(row((await call(f, `/api/v1/sessions/${id}/native-resume`)).data).resume, null, "a session to continue");
  // The binding as a Turn leaves it that gave up its native session before any input reached a new one (I-1a, R4), written
  // while the Gateway is stopped, which then starts again on the same data.
  await f.gateway.close();
  const db = new DatabaseSync(join(f.data, "gateway.sqlite"));
  try {
    const stored = JSON.parse(String(db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id)!.snapshot)) as { nativeBindings: Record<string, unknown>[] };
    stored.nativeBindings = stored.nativeBindings.map(binding => ({ ...binding, throughRunId: null, opensNew: true }));
    db.prepare("UPDATE sessions SET snapshot=? WHERE id=?").run(JSON.stringify(stored), id);
  } finally { db.close(); }
  const configuration = await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true });
  f.gateway = await startWebServer({ installations: "any", root: f.data, configuration, port: 0, assetsDirectory: f.assets, workspaceLockRoot: join(f.root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(f.root, "locks") }) });
  const parsed = new URL(f.gateway.url); f.origin = parsed.origin; f.token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  await auth(f);
  assert.deepEqual((await call(f, `/api/v1/sessions/${id}/native-resume`)).data, { resume: null }, "no session to continue yet");
});

test("the public conversation exports as Markdown or JSON without private native state", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first\n```\nquoted", commandId: "export-first" })).status, 202);
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  const markdown = await fetch(f.origin + `/api/v1/sessions/${id}/export`, { headers: { Cookie: f.cookie } });
  assert.equal(markdown.status, 200); assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(markdown.headers.get("content-disposition"), "attachment; filename*=UTF-8''" + encodeURIComponent("harnesshub-" + id + ".md"));
  const text = await markdown.text();
  assert.match(text, /^# first ``` quoted/u); assert.ok(text.includes("## 你\n\n```text\nfirst\n ```\nquoted\n```"), "a fence inside the user text cannot close the quote");
  assert.ok(text.includes("## Web a · 已完成")); assert.equal(text.includes("checkpoint"), false);
  const json = await fetch(f.origin + `/api/v1/sessions/${id}/export?format=json`, { headers: { Cookie: f.cookie } });
  const exported = row(await json.json()); assert.equal(exported.application, "HarnessHub"); assertView(exported.session);
  assert.equal(JSON.stringify(exported).includes("nativeBindings"), false, "private native bindings are not exported");
  // A cancelled Turn is exported with why it ended, as the chat shows it (ADR-036).
  const view = exported.session as SessionView, ended = (error: string | null, cancelRequested: boolean) => conversationMarkdown({ ...view,
    runs: view.runs.map(run => ({ ...run, status: "cancelled" as const, error: error === null ? null : { code: error, message: "ended" }, cancelRequested })),
    messages: view.messages.map(message => ({ ...message, status: "cancelled" as const })) }, () => "Web a", new Date(0));
  assert.ok(ended("RUN_TIMEOUT", false).includes("## Web a · 已停止（执行预算用尽）")); assert.ok(ended("WAIT_EXPIRED", false).includes("## Web a · 已停止（等待你的决定超时）"));
  assert.ok(ended(null, true).includes("## Web a · 已停止（用户停止）"));
  assert.equal((await call(f, `/api/v1/sessions/${id}/export?format=pdf`)).status, 400);
  assert.equal((await fetch(f.origin + `/api/v1/sessions/${id}/export`)).status, 401);
});

test("branching over HTTP returns the new conversation with its quoted history and keeps the command idempotent", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  assert.equal((await call(f, `/api/v1/sessions/${id}/fork`, "POST", { commandId: "fork-too-early" })).status, 409, "a branch needs a finished reply");
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "fork-first" })).status, 202);
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  const created = await call(f, `/api/v1/sessions/${id}/fork`, "POST", { commandId: "fork-one" }); assert.equal(created.status, 201, created.text);
  assertView(created.data); const branch = created.data;
  assert.notEqual(branch.id, id); assert.deepEqual(branch.origin?.history.map(row => row.text), ["first", "a:first"]); assert.equal(branch.messages.length, 0);
  assert.equal(row((await call(f, `/api/v1/sessions/${id}/fork`, "POST", { commandId: "fork-one" })).data).id, branch.id, "the same command returns the same branch");
  assert.equal((await call(f, `/api/v1/sessions/${id}/fork`, "POST", { commandId: "fork-bad", throughRunId: 7 })).status, 400);
  const listed = row((await call(f, "/api/v1/state")).data).sessions as { id: string; title: string }[];
  assert.equal(listed.find(item => item.id === branch.id)?.title, "分支 · first");
  assert.equal((await call(f, `/api/v1/sessions/${branch.id}/messages`, "POST", { text: "branch input", commandId: "fork-second" })).status, 202);
  await waitFor(f, branch.id, value => value.runs[0]?.status === "completed");
  const prompt = (await trace(f)).filter(item => item.kind === "prompt").at(-1)!;
  assert.deepEqual((prompt.context as { branchedHistory: { text: string }[] }).branchedHistory.map(row => row.text), ["first", "a:first"], "the branch's first input carries the quoted history");
});

test("native extensions are read on demand from the selected Harness and are null where its interface has no list", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + "/api/v1/harnesses/web-b/extensions")).status, 401);
  await auth(f);
  const codex = await call(f, "/api/v1/harnesses/web-b/extensions?" + new URLSearchParams({ controlId: "web-b-control", workspace: f.workspace }));
  assert.equal(codex.status, 200, codex.text);
  const listed = row(row(codex.data).extensions);
  assert.deepEqual((listed.skills as { name: string; command?: string }[]).map(skill => [skill.name, skill.command]), [["web-skill", "skill:web-skill"]]);
  assert.deepEqual((listed.mcpServers as { name: string; tools: number }[]).map(server => [server.name, server.tools]), [["web-mcp", 1]]);
  const acp = await call(f, "/api/v1/harnesses/web-a/extensions?" + new URLSearchParams({ controlId: "web-a-control", workspace: f.workspace }));
  assert.equal(acp.status, 200); assert.equal(row(acp.data).extensions, null);
  assert.equal((await call(f, "/api/v1/harnesses/web-b/extensions?unknown=1")).status, 400);
});

test("a Turn's diagnostics are assembled on request, scrubbed by the Gateway and hold conversation content only when asked", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  assert.equal((await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "noisy turn", commandId: "noisy" })).status, 202);
  const run = (await waitFor(f, id, value => value.runs[0]?.status === "completed")).runs[0]!;
  const read = async (query: string) => call(f, `/api/v1/sessions/${id}/runs/${run.id}/diagnostics${query}`);
  const plain = await read(""), text = String(row(plain.data).text);
  assert.equal(plain.status, 200); assert.equal(row(plain.data).includesContent, false);
  assert.equal(text.split("\n")[0], "HarnessHub 诊断 · 不含对话内容");
  assert.ok(Buffer.byteLength(text) <= 64 * 1024);
  assert.match(text, /回合：run-/u); assert.match(text, /阶段（距受理）：准备 \d+ ms/u); assert.match(text, /清理：已关闭 · 退出码 0/u); assert.match(text, /原程序在本回合报告：a 1\.0 · 协议版本 1/u);
  assert.match(text, /stderr（本回合，最后 4 KiB）：\nopen \[路径\] failed\nOPENAI_API_KEY=\[已隐去\]\nAuthorization: Bearer \[已隐去\]\nINFO Prompt on session native: \[对话内容已隐去\]/u);
  for (const secret of ["/Users/someone", "notes.txt", "sk-fixtureSECRET", "fixture.token.value123", f.workspace, f.data])
    assert.equal(text.includes(secret), false, secret + " must not leave the Gateway");
  assert.equal(text.includes("noisy turn"), false, "no prompt by default"); assert.equal(text.includes("a:noisy turn"), false, "no reply by default");
  const full = String(row((await read("?content=1")).data).text);
  assert.equal(full.split("\n")[0], "HarnessHub 诊断 · 含对话内容（只含这一轮的提示词与回复）");
  assert.match(full, /\n提示词：\nnoisy turn\n\n回复：\na:noisy turn\n$/u);
  assert.match(full, /INFO Prompt on session native: noisy turn/u, "with content chosen, the program's own log keeps it");
  assert.equal(full.includes("sk-fixtureSECRET"), false);
  assert.equal((await read("?content=2")).status, 400);
  assert.equal((await call(f, `/api/v1/sessions/${id}/runs/run-missing/diagnostics`)).status, 404);
  assert.equal((await fetch(f.origin + `/api/v1/sessions/${id}/runs/${run.id}/diagnostics`, { headers: { Origin: f.origin } })).status, 401);
});

test("a domain error's public message writes the user's home as ~ in every spelling the privacy guard knows, keeping its code and status; the Gateway's own errors keep their words", async t => {
  // A private home reached through a link whose real path ends with the given one, as /var/folders/… is /private/var/folders/…
  // on macOS: the Gateway knows the home by both spellings.
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-web-home-"))), home = join(root, "home"), resolved = join(root, root.slice(1), "home"), workspace = join(root, "workspace");
  await mkdir(resolved, { recursive: true }); await symlink(resolved, home); await mkdir(workspace);
  const program = join(resolved, ".nvm", "versions", "node", "v26.0.0", "bin", "dsh");
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, workspaceLockRoot: join(root, "locks"),
    application: (data, publish) => {
      const app = application(data, publish, { nativeEnvironment: { home, values: { HOME: home, PATH: "/usr/bin:/bin" } }, installations: "official", workspaceLockRoot: join(root, "locks") });
      // Failures injected at the management service in the words of its own checks (an upgrade check names the program it
      // would replace by its real path); the HTTP answer under test is the formal one.
      app.management.upgradeCheck = async () => { throw new ManagementError("NATIVE_DESTINATION_CONFLICT", "新版本会替换 " + program + "，它现在属于另一个程序。没有升级。"); };
      app.management.maintenance = async () => { throw new ManagementError("MAINTENANCE_UNAVAILABLE", "HOME=" + home + " 下找不到程序（" + home + "）"); };
      return app;
    } });
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const launch = new URL(gateway.url), origin = launch.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get("token") }) });
  assert.equal(boot.status, 200); const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const read = async (path: string) => { const response = await fetch(origin + path, { headers: { Cookie: cookie } }); return { status: response.status, data: await response.json() as unknown }; };
  // Mutation check (run by hand, not kept): with publicFailure's message as it was, both answers name the home by its absolute path.
  const upgrade = await read("/api/v1/harnesses/dsh/installations/" + "a".repeat(64) + "/upgrade"), maintenance = await read("/api/v1/harnesses/dsh/maintenance");
  assert.deepEqual(upgrade, { status: 409, data: { code: "NATIVE_DESTINATION_CONFLICT", message: "新版本会替换 ~/.nvm/versions/node/v26.0.0/bin/dsh，它现在属于另一个程序。没有升级。" } });
  assert.deepEqual(maintenance, { status: 409, data: { code: "MAINTENANCE_UNAVAILABLE", message: "HOME=~ 下找不到程序（~）" } });
  assert.deepEqual(homePathsIn([upgrade, maintenance], [home, resolved]), []);
  assert.deepEqual(await read("/api/v1/harnesses/dsh/unknown"), { status: 404, data: { code: "NOT_FOUND", message: "API route not found" } });
});

test("G050-NC9 the state and the Harness list answer with the last completed scan and start none; a rescan, a rescan after a time and a task's end each scan once (ADR-050)", async t => {
  const root = await mkdtemp(join(tmpdir(), "harness-web-scans-")), workspace = join(root, "workspace"), assets = join(root, "assets");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>fixture</title>");
  // Each scan reads the system versions once: counted at the management service, and held there while `gate` is set.
  let scans = 0, gate: Promise<void> | null = null;
  // A management task the service reports, standing in for one that runs (the HTTP route under test is the formal one).
  let job: InstallationJobView | null = null;
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, assetsDirectory: assets,
    application: (data, publish) => {
      const app = application(data, publish, { installations: "any", nativeEnvironment: { home: root, values: { HOME: root, PATH: "/usr/bin:/bin" } }, workspaceLockRoot: join(root, "locks") });
      const versions = app.management.refreshSystemVersions.bind(app.management), read = app.management.readJob.bind(app.management);
      app.management.refreshSystemVersions = async () => { scans++; if (gate !== null) await gate; return versions(); };
      app.management.readJob = (id: string) => job !== null && id === job.id ? job : read(id);
      return app;
    } });
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const launch = new URL(gateway.url), origin = launch.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get("token") }) });
  const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String(row(await boot.json()).csrfToken);
  const call = async (path: string, input?: unknown) => {
    const response = await fetch(origin + path, { method: input === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(input === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: await response.json() as unknown };
  };
  const scannedAt = async () => String(row((await call("/api/v1/state")).data).harnessesScannedAt);
  assert.equal(scans, 1, "the startup scan");
  // Mutation check (run by hand, not kept): with /state scanning as before, the first read below makes this test fail.
  const first = row((await call("/api/v1/state")).data), harnesses = first.harnesses as { id: string; tier: string }[];
  const at = String(first.harnessesScannedAt); assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.deepEqual(["codex", "gemini", "autohand"].map(id => harnesses.find(item => item.id === id)?.tier), ["focus", "frozen", "catalog"]);
  for (let index = 0; index < 3; index++) {
    assert.equal(await scannedAt(), at);
    assert.deepEqual((await call("/api/v1/harnesses")).data, harnesses);
  }
  assert.equal(scans, 1, "reading the state and the Harness list starts no scan");
  // The rescan a client asks for scans once and moves the time on.
  assert.equal((await call("/api/v1/harnesses/rescan", {})).status, 200); assert.equal(scans, 2);
  const second = await scannedAt(); assert.ok(Date.parse(second) > Date.parse(at), second + " after " + at);
  // A scan still running is not waited for: the state answers with the last completed one meanwhile.
  let release!: () => void; gate = new Promise<void>(done => { release = done; });
  const running = call("/api/v1/harnesses/rescan", {});
  for (const end = Date.now() + 10000; scans < 3;) { assert.ok(Date.now() < end, "the held scan did not start"); await delay(5); }
  assert.equal(await scannedAt(), second, "answered while the scan runs");
  gate = null; release(); assert.equal((await running).status, 200);
  const third = await scannedAt(); assert.ok(Date.parse(third) > Date.parse(second));
  // With a time: a scan that began then or later is enough; otherwise one more scan. Anything but such a time is refused.
  const now = () => new Date().toISOString();
  assert.equal((await call("/api/v1/harnesses/rescan", { after: second })).status, 200); assert.equal(scans, 3, "the last scan began after it");
  assert.equal((await call("/api/v1/harnesses/rescan", { after: third })).status, 200); assert.equal(scans, 3, "the last scan began at that very time");
  await delay(2); const later = now();
  assert.equal((await call("/api/v1/harnesses/rescan", { after: later })).status, 200); assert.equal(scans, 4, "no scan began then or later");
  assert.ok(Date.parse(await scannedAt()) >= Date.parse(later));
  for (const input of [{ after: "yesterday" }, { after: "2026-10-22T08:00:00Z" }, { after: "2026-13-40T99:00:00.000Z" }, { after: 1 }, { since: third }])
    assert.equal((await call("/api/v1/harnesses/rescan", input)).status, 400, JSON.stringify(input));
  assert.equal(scans, 4);
  // A task's end, read through its record, scans once; a running task, and the same end read again, do not.
  job = { id: "management-00000000-0000-4000-8000-000000000050", harnessId: "codex", controlId: "codex-native", action: "install", status: "installing", phase: "installing", cancelRequested: false,
    createdAt: now(), updatedAt: now(), resolvedVersion: null, installationId: null, error: null, logCursor: 0 };
  assert.equal(row((await call("/api/v1/installation-jobs/" + job.id)).data).status, "installing"); assert.equal(scans, 4);
  await delay(2); job = { ...job, status: "completed", phase: "completed", updatedAt: now() };
  const ended = job.updatedAt;
  assert.equal(row((await call("/api/v1/installation-jobs/" + job.id)).data).status, "completed"); assert.equal(scans, 5);
  assert.ok(Date.parse(await scannedAt()) >= Date.parse(ended), "the Harness list now shows what the task left");
  assert.equal(row((await call("/api/v1/installation-jobs/" + job.id)).data).status, "completed"); assert.equal(scans, 5);
});

test("G050-NC10 a domain error whose message names the home across the 512th character writes it as ~ before the cut, leaving no part of it (ADR-044, ADR-050)", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-web-cut-"))), home = join(root, "home"), resolved = join(root, root.slice(1), "home"), workspace = join(root, "workspace");
  await mkdir(resolved, { recursive: true }); await symlink(resolved, home); await mkdir(workspace);
  // The resolved home starts at the 506th character and runs past the 512th; what follows it is longer than the rest of the cut.
  const before = "x".repeat(505), message = before + resolved + "/" + "y".repeat(100);
  assert.ok(before.length < 512 && before.length + resolved.length > 512);
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, workspaceLockRoot: join(root, "locks"),
    application: (data, publish) => {
      const app = application(data, publish, { nativeEnvironment: { home, values: { HOME: home, PATH: "/usr/bin:/bin" } }, installations: "official", workspaceLockRoot: join(root, "locks") });
      app.management.maintenance = async () => { throw new ManagementError("MAINTENANCE_UNAVAILABLE", message); };
      return app;
    } });
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const launch = new URL(gateway.url), origin = launch.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get("token") }) });
  const response = await fetch(origin + "/api/v1/harnesses/dsh/maintenance", { headers: { Cookie: boot.headers.get("set-cookie")!.split(";", 1)[0]! } });
  // Mutation check (run by hand, not kept): with the cut made before writing ~, the answer ends with the home's first 7 characters.
  const answer = row(await response.json());
  assert.equal(response.status, 409);
  assert.deepEqual(answer, { code: "MAINTENANCE_UNAVAILABLE", message: (before + "~/" + "y".repeat(100)).slice(0, 512) });
  assert.equal(String(answer.message).includes(resolved.slice(0, 7)), false, "no part of the home is left");
  assert.deepEqual(homePathsIn(answer, [home, resolved]), []);
});
