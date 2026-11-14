import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DirectorySessionBindingFactory, prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { captureNativeEnvironment, referencedNativeValues, nativeDescriptorValues } from "../../src/infrastructure/session/native-environment.js";
import { appStore } from "../fixtures/runtime-store.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { startWebServer } from "../../src/web/server.js";
import { application } from "../../src/cli/session-application.js";
import { oldShape } from "../fixtures/old-shape.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
test("native Claude keeps an unset auth-directory override unset and honors an explicit user's override", () => {
  const host = captureNativeEnvironment({ HOME: "/tmp/native-host" });
  assert.equal(nativeDescriptorValues(host, null, { CLAUDE_CONFIG_DIR: "/tmp/foreign" }).CLAUDE_CONFIG_DIR, undefined);
  const custom = captureNativeEnvironment({ HOME: host.home, CLAUDE_CONFIG_DIR: "/tmp/user-claude" });
  assert.equal(nativeDescriptorValues(custom, null, {}).CLAUDE_CONFIG_DIR, "/tmp/user-claude");
  assert.equal(nativeDescriptorValues(host, "/tmp/private-profile", {}).CLAUDE_CONFIG_DIR, "/tmp/private-profile/claude");
});
test("native launch never synthesizes profile locations the user did not set", () => {
  const host = captureNativeEnvironment({ HOME: "/tmp/native-host" });
  const launched = nativeDescriptorValues(host, null, { XDG_CONFIG_HOME: "/tmp/foreign-config", CODEX_HOME: "/tmp/foreign-codex" });
  assert.equal(launched.HOME, "/tmp/native-host");
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "OPENCLAW_CONFIG_PATH"]) assert.equal(launched[name], undefined, name);
  const configured = captureNativeEnvironment({ HOME: "/tmp/native-host", XDG_CONFIG_HOME: "/tmp/user-config", CODEX_HOME: "/tmp/user-codex" });
  assert.equal(nativeDescriptorValues(configured, null, {}).XDG_CONFIG_HOME, "/tmp/user-config");
  assert.equal(nativeDescriptorValues(configured, null, {}).CODEX_HOME, "/tmp/user-codex");
  assert.equal(nativeDescriptorValues(host, "/tmp/private-profile", {}).XDG_CONFIG_HOME, "/tmp/private-profile/config");
});
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "native-harness-models-")), home = join(root, "native-home"), workspace = join(root, "workspace"), manifest = join(root, "catalog.json"), trace = join(root, "trace.ndjson");
  await mkdir(home); await mkdir(workspace); await mkdir(join(home, ".codex")); await writeFile(join(home, ".codex", "config.toml"), 'model = "native-model-a"\n[model_providers.fixture]\nenv_key = "CUSTOM_NATIVE_AUTH"\n');
  const source = { repository: "fixture", revision: "native", upstreamId: "native", url: "https://example.invalid/native" };
  const definitions = ["codex", "acp"].map(id => ({ id: "native-" + id, name: id, aliases: [], binaryNames: [], configHints: [], controls: [{ id: "native-" + id, protocol: id === "codex" ? "codex-app-server" : "acp-v1", executableNames: ["fixture"], args: [peer, id === "codex" ? "codex-app-server" : "acp-v1", "native-models"], env: { FIXTURE_TRACE: trace }, package: null, distribution: null, requiredExecutables: [], source }] }));
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(d => [d.controls[0]!.id, { executable: process.execPath }])) }));
  const environment = captureNativeEnvironment({ HOME: home, PATH: process.env.PATH, CUSTOM_NATIVE_AUTH: "synthetic-native-auth", TEST_HOST_SECRET: "unrelated-synthetic-secret" });
  const config = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const close: (() => Promise<void>)[] = [];
  t.after(async () => { for (const action of close.reverse()) await action(); await rm(root, { recursive: true, force: true }); });
  return { root, home, workspace, manifest, trace, environment, config, close };
}

test("native profile values preserve the actual home and configured credential reference, not unrelated host secrets", async t => {
  const f = await setup(t), config = join(f.home, ".codex", "config.toml"), before = await readFile(config);
  const values = await referencedNativeValues(f.environment, null, "codex", f.workspace);
  assert.equal(values.HOME, f.home); assert.equal(values.CUSTOM_NATIVE_AUTH, "synthetic-native-auth"); assert.equal(values.TEST_HOST_SECRET, undefined);
  const privateValues = await referencedNativeValues(f.environment, join(f.root, "private"), "codex", f.workspace);
  assert.equal(privateValues.CUSTOM_NATIVE_AUTH, undefined); assert.deepEqual(await readFile(config), before);
});
test("native Pi preserves supported credential variables and explicit model references without unrelated host secrets", async t => {
  const f = await setup(t); await mkdir(join(f.home, ".pi", "agent"), { recursive: true });
  await writeFile(join(f.home, ".pi", "agent", "models.json"), '{"providers":{"fixture":{"apiKey":"$CUSTOM_NATIVE_AUTH","literal":"$$TEST_HOST_SECRET $${TEST_HOST_SECRET}"}}}');
  const source = captureNativeEnvironment({ ...f.environment.values, DEEPSEEK_API_KEY: "synthetic-provider-key" });
  const values = await referencedNativeValues(source, null, "pi", f.workspace);
  assert.equal(values.CUSTOM_NATIVE_AUTH, "synthetic-native-auth"); assert.equal(values.DEEPSEEK_API_KEY, "synthetic-provider-key"); assert.equal(values.TEST_HOST_SECRET, undefined);
  assert.equal((await referencedNativeValues(source, join(f.root, "private"), "pi", f.workspace)).DEEPSEEK_API_KEY, undefined);
});

test("real Codex/ACP protocol probes enumerate native models without prompts and model selection reaches the original native RPC", async t => {
  const f = await setup(t), factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {}, "any", undefined, undefined, f.environment);
  const codex = await factory.discoverModels({ harnessId: "native-codex" }, f.config, new AbortController().signal);
  assert.equal(codex.defaultModel, "native-model-a"); assert.equal(codex.authentication, "ready"); assert.deepEqual(codex.models.map(m => m.id), ["native-model-a", "native-model-b"]);
  assert.equal(JSON.stringify(codex).includes("private-account"), false); assert.equal(JSON.stringify(codex).includes("synthetic-never-public"), false);
  const acp = await factory.discoverModels({ harnessId: "native-acp" }, f.config, new AbortController().signal); assert.equal(acp.canSelect, true);
  const store = appStore(join(f.root, "data")); let id = 0;
  const runtime = new SessionRuntime(store, factory, { id: () => String(++id), now: () => new Date(), publish: () => {}, fingerprint: text => createHash("sha256").update(text).digest("hex") });
  f.close.push(async () => { await runtime.close(); store.close(); });
  const session = await runtime.create(f.config, { harnessId: "native-codex", nativeModel: "native-model-b" }, "create");
  runtime.send(session.id, "native first", "first"); await runtime.wait(session.id);
  runtime.switch(session.id, { harnessId: "native-acp", provider: null, nativeModel: "native-model-b" }, "switch"); await runtime.wait(session.id);
  // G072 (D11): the Gateway's factory now tells admission the Drivers' relay declarations, and the generic ACP Driver declares
  // none, so a packet to it is refused at admission (RELAY_TARGET_UNVERIFIED{undeclared}); this case is about model selection,
  // so the input goes alone.
  runtime.send(session.id, "native second", "second", [], { attach: "none" }); await runtime.wait(session.id);
  const current = oldShape(runtime, session.id); assert.equal(current.id, session.id); assert.equal(current.runs[1]!.status, "completed");
  assert.equal(current.runs[1]!.selection.nativeModel, "native-model-b");
  const messages = (await readFile(f.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(messages.some(row => row.method === "thread/start" && row.params.model === "native-model-b"));
  assert.ok(messages.some(row => row.method === "session/set_config_option" && row.params.value === "native-model-b"));
  assert.equal(messages.filter(row => row.method === "turn/start" || row.method === "session/prompt").length, 2);
  runtime.switch(session.id, { harnessId: "native-codex", nativeModel: "model-from-another-harness" }, "invalid-model"); await runtime.wait(session.id);
  assert.equal(oldShape(runtime, session.id).switches.at(-1)!.status, "effective");
  // Alone too: Codex's declaration is unprobed (RELAY_TARGET_UNVERIFIED{unprobed} at admission otherwise, G072).
  runtime.send(session.id,"invalid model must not reach a prompt","invalid-model-input", [], { attach: "none" }); await runtime.wait(session.id);
  assert.equal(oldShape(runtime, session.id).runs.at(-1)!.status,"failed"); assert.equal(oldShape(runtime, session.id).runs.at(-1)!.error?.code,"MODEL_UNAVAILABLE"); assert.equal(oldShape(runtime, session.id).status,"open");
});

test("authenticated native models endpoint accepts workspace queries, projects no credentials and owns probe shutdown", async t => {
  const f = await setup(t);
  const gateway = await startWebServer({ root: join(f.root, "web-data"), configuration: f.config, port: 0,
    application: (root, publish) => application(root, publish, { installations: "any", nativeEnvironment: f.environment, workspaceLockRoot: join(f.root, "locks") }) });
  f.close.push(() => gateway.close());
  const launch = new URL(gateway.url), origin = launch.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get("token") }) });
  assert.equal(boot.status, 200); const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const query = new URLSearchParams({ workspace: f.workspace, controlId: "native-codex" });
  const response = await fetch(origin + "/api/v1/harnesses/native-codex/models?" + query, { headers: { Cookie: cookie, Origin: origin } });
  assert.equal(response.status, 200, await response.clone().text()); const catalog = await response.json(); assert.equal(catalog.defaultModel, "native-model-a");
  assert.equal(JSON.stringify(catalog).includes("synthetic-native-auth"), false);
  const rejected = await fetch(origin + "/api/v1/harnesses/native-codex/models?bad=value", { headers: { Cookie: cookie, Origin: origin } }); assert.equal(rejected.status, 400);
});

test("a native catalog read is reused across restarts while its fingerprint holds, and the session it opened stays out of the list", async t => {
  const f = await setup(t), manifest = join(f.root, "listing.json"), traces = { "native-list": join(f.root, "list.ndjson"), "native-signin": join(f.root, "signin.ndjson") };
  const source = { repository: "fixture", revision: "native", upstreamId: "native", url: "https://example.invalid/native" };
  const definitions = ([["native-list", "hermes"], ["native-signin", "auth-session"]] as const).map(([id, scenario]) => ({ id, name: id, aliases: [], binaryNames: [], configHints: [],
    controls: [{ id, protocol: "acp-v1", executableNames: ["fixture"], args: [peer, "acp-v1", scenario], env: { FIXTURE_TRACE: traces[id] }, package: null, distribution: null, requiredExecutables: [], source }] }));
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(d => [d.id, { executable: process.execPath }])) }));
  const config = await prepareConfiguration({ workspace: f.workspace, manifestPath: manifest, pathOnly: true }), data = join(f.root, "web-data");
  const opened = async (id: keyof typeof traces) => { try { return (await readFile(traces[id], "utf8")).trim().split("\n").filter(line => (JSON.parse(line) as { method?: string }).method === "session/new").length; } catch { return 0; } };
  const start = async () => {
    const gateway = await startWebServer({ root: data, configuration: config, port: 0, application: (root, publish) => application(root, publish, { installations: "any", nativeEnvironment: f.environment, workspaceLockRoot: join(f.root, "locks") }) });
    const launch = new URL(gateway.url), origin = launch.origin;
    const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get("token") }) });
    assert.equal(boot.status, 200); const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
    return { gateway, get: async (path: string) => { const response = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin } }); assert.equal(response.status, 200, path + " " + await response.clone().text()); return response.json() as Promise<Record<string, unknown>>; } };
  };
  const query = (id: string) => "?" + new URLSearchParams({ workspace: f.workspace, controlId: id });
  let web = await start(); f.close.push(() => web.gateway.close());
  await web.get("/api/v1/harnesses/native-list/models" + query("native-list"));
  await web.get("/api/v1/harnesses/native-list/models" + query("native-list"));
  assert.equal(await opened("native-list"), 1, "a second read in the same day is answered from the first");
  // The session the read opened is not offered for continuing unless asked for.
  const listed = await web.get("/api/v1/harnesses/native-list/native-sessions" + query("native-list"));
  assert.deepEqual(listed.sessions, []); assert.equal(listed.hiddenProbes, 1);
  const all = await web.get("/api/v1/harnesses/native-list/native-sessions" + query("native-list") + "&probes=include");
  assert.deepEqual((all.sessions as { id: string }[]).map(row => row.id), ["session-fixture"]); assert.equal(all.hiddenProbes, undefined);
  // An agent that needs its own sign-in reports it as such, and the readiness view remembers both entries.
  assert.equal((await web.get("/api/v1/harnesses/native-signin/models" + query("native-signin"))).authentication, "missing");
  const readiness = (await web.get("/api/v1/harnesses/readiness")).readiness as { harnessId: string; state: string; signedIn?: boolean | null; checkedAt: number }[];
  assert.deepEqual(readiness.map(row => [row.harnessId, row.state, row.signedIn]).sort(), [["native-list", "ready", null], ["native-signin", "signed_out", undefined]]);
  assert.deepEqual((await web.get("/api/v1/state")).readiness, readiness);
  await web.gateway.close();

  web = await start();
  await web.get("/api/v1/harnesses/native-list/models" + query("native-list"));
  assert.equal(await opened("native-list"), 1, "a restart reuses the read");
  assert.equal((await web.get("/api/v1/harnesses/native-list/native-sessions" + query("native-list"))).hiddenProbes, 1);
  assert.deepEqual(((await web.get("/api/v1/harnesses/readiness")).readiness as unknown[]).length, 2);
  await web.get("/api/v1/harnesses/native-list/models" + query("native-list") + "&refresh=1");
  assert.equal(await opened("native-list"), 2, "refresh always reads again");
  await mkdir(join(f.workspace, ".gemini")); await writeFile(join(f.workspace, ".gemini", "settings.json"), "{}");
  await web.get("/api/v1/harnesses/native-list/models" + query("native-list"));
  assert.equal(await opened("native-list"), 3, "a changed configuration is read again");
});

test("a Codex thread keeps the collaboration mode it last confirmed while the conversation follows the native configuration", async t => {
  const f = await setup(t), manifest = join(f.root, "plan.json"), trace = join(f.root, "plan.ndjson");
  const source = { repository: "fixture", revision: "native", upstreamId: "native", url: "https://example.invalid/native" };
  const definitions = [{ id: "native-plan", name: "plan", aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "native-plan", protocol: "codex-app-server", executableNames: ["fixture"], args: [peer, "codex-app-server", "plan-mode"], env: { FIXTURE_TRACE: trace }, package: null, distribution: null, requiredExecutables: [], source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "native-plan": { executable: process.execPath } } }));
  const config = await prepareConfiguration({ workspace: f.workspace, manifestPath: manifest, pathOnly: true });
  const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {}, "any", undefined, undefined, f.environment);
  const store = appStore(join(f.root, "data")); let id = 0;
  const runtime = new SessionRuntime(store, factory, { id: () => String(++id), now: () => new Date(), publish: () => {}, fingerprint: text => createHash("sha256").update(text).digest("hex") });
  f.close.push(async () => { await runtime.close(); store.close(); });
  const observed = (session: Parameters<typeof runtime.switch>[0]) => oldShape(runtime, session).nativeBindings?.find(binding => binding.harnessId === "native-plan")?.observed?.options.collaboration_mode;
  const session = await runtime.create(config, { harnessId: "native-plan", nativeOptions: { collaboration_mode: "plan" } }, "create");
  runtime.send(session.id, "plan it", "first"); await runtime.wait(session.id);
  assert.equal(oldShape(runtime, session.id).runs[0]!.status, "completed"); assert.equal(observed(session.id), "plan");
  // Following the native configuration declares nothing and sends no mode; the thread's last confirmed mode is kept.
  runtime.switch(session.id, { harnessId: "native-plan", provider: null }, "follow"); await runtime.wait(session.id);
  runtime.send(session.id, "next", "second"); await runtime.wait(session.id);
  assert.equal(oldShape(runtime, session.id).runs[1]!.status, "completed"); assert.equal(observed(session.id), "plan");
  // Choosing the default mode sends it, and that becomes the thread's value.
  runtime.switch(session.id, { harnessId: "native-plan", provider: null, nativeOptions: { collaboration_mode: "default" } }, "default"); await runtime.wait(session.id);
  runtime.send(session.id, "do it", "third"); await runtime.wait(session.id);
  assert.equal(oldShape(runtime, session.id).runs[2]!.status, "completed"); assert.equal(observed(session.id), "default");
  const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  // Every connection declares the experimental API (the driver uses it whenever this Codex has what it needs).
  assert.deepEqual(sent.filter(row => row.method === "initialize").map(row => (row.params!.capabilities as Record<string, unknown>).experimentalApi), [true, true, true]);
  assert.deepEqual(sent.filter(row => row.method === "turn/start").map(row => (row.params!.collaborationMode as { mode?: string } | undefined)?.mode ?? null), ["plan", null, "default"]);
});

test("cancelled native discovery starts no protocol operation and removes only its owned temporary manifest", async t => {
  const f = await setup(t), factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {}, "any", undefined, undefined, f.environment);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => factory.discoverModels({ harnessId: "native-codex" }, f.config, controller.signal), error => error !== null && typeof error === "object" && "code" in error && error.code === "CANCELLED");
  await assert.rejects(() => readFile(f.trace), error => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT");
  assert.ok(await readFile(join(f.home, ".codex", "config.toml")));
});
