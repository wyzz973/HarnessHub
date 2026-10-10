import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import type { SessionView } from "../../src/contracts/web.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { sessionId } from "../../src/contracts/session.js";

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
  const data = join(root, "data"), gateway = await startWebServer({ root: data, configuration, port: 0, assetsDirectory: assets });
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
  const ended = await waitFor(f, id, value => value.runs[1]?.status === "failed"); assert.equal(ended.switches[0]?.status, "failed");
  assert.equal(ended.status, "open");
  assert.equal(ended.runs[1]?.backend, null); assert.equal(ended.runs[1]?.cleanup, null); assert.equal(ended.selection.harnessId, "web-a");
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
  const reopened = await startWebServer({ root: f.data, configuration, port: 0, assetsDirectory: f.assets }); f.gateway = reopened;
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
  const reopened = await startWebServer({ root: f.data, configuration: await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true }), port: 0, assetsDirectory: f.assets });
  f.gateway = reopened;
});

test("authenticated recovery restores a legacy blocked conversation without rewriting history or sending a prompt", async t => {
  const f = await fixture(t); await auth(f); const id = await create(f);
  await call(f, `/api/v1/sessions/${id}/messages`, "POST", { text: "first", commandId: "first" });
  await waitFor(f, id, value => value.runs[0]?.status === "completed");
  await call(f, `/api/v1/sessions/${id}/switches`, "POST", { selection: { harnessId: "web-bad" }, commandId: "broken" });
  const failed = await waitFor(f, id, value => value.switches[0]?.status === "failed");
  await f.gateway.close();
  const store = new SqliteSessionStore(f.data), snapshot = store.get(sessionId(id));
  store.transact(snapshot.id, snapshot.version, current => ({ next: { ...current, status: "blocked" }, events: [{ type: "session.blocked", data: { switchId: current.switches[0]!.id } }] }));
  store.close();
  f.gateway = await startWebServer({ root: f.data, configuration: await prepareConfiguration({ workspace: f.workspace, manifestPath: f.manifest, pathOnly: true }), port: 0, assetsDirectory: f.assets });
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
