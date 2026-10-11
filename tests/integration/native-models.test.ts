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
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { startWebServer } from "../../src/web/server.js";
import { application } from "../../src/cli/session-application.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url));
test("native Claude keeps an unset auth-directory override unset and honors an explicit user's override", () => {
  const host = captureNativeEnvironment({ HOME: "/tmp/native-host" });
  assert.equal(nativeDescriptorValues(host, null, { CLAUDE_CONFIG_DIR: "/tmp/foreign" }).CLAUDE_CONFIG_DIR, undefined);
  const custom = captureNativeEnvironment({ HOME: host.home, CLAUDE_CONFIG_DIR: "/tmp/user-claude" });
  assert.equal(nativeDescriptorValues(custom, null, {}).CLAUDE_CONFIG_DIR, "/tmp/user-claude");
  assert.equal(nativeDescriptorValues(host, "/tmp/private-profile", {}).CLAUDE_CONFIG_DIR, "/tmp/private-profile/claude");
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
  const f = await setup(t), factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {}, undefined, undefined, f.environment);
  const codex = await factory.discoverModels({ harnessId: "native-codex" }, f.config, new AbortController().signal);
  assert.equal(codex.defaultModel, "native-model-a"); assert.equal(codex.authentication, "ready"); assert.deepEqual(codex.models.map(m => m.id), ["native-model-a", "native-model-b"]);
  assert.equal(JSON.stringify(codex).includes("private-account"), false); assert.equal(JSON.stringify(codex).includes("synthetic-never-public"), false);
  const acp = await factory.discoverModels({ harnessId: "native-acp" }, f.config, new AbortController().signal); assert.equal(acp.canSelect, true);
  const store = new SqliteSessionStore(join(f.root, "data")); let id = 0;
  const runtime = new SessionRuntime(store, factory, { id: () => String(++id), now: () => new Date(), publish: () => {}, fingerprint: text => createHash("sha256").update(text).digest("hex") });
  f.close.push(async () => { await runtime.close(); store.close(); });
  const session = await runtime.create(f.config, { harnessId: "native-codex", nativeModel: "native-model-b" }, "create");
  runtime.send(session.id, "native first", "first"); await runtime.wait(session.id);
  runtime.switch(session.id, { harnessId: "native-acp", provider: null, nativeModel: "native-model-b" }, "switch"); await runtime.wait(session.id);
  runtime.send(session.id, "native second", "second"); await runtime.wait(session.id);
  const current = runtime.read(session.id); assert.equal(current.id, session.id); assert.equal(current.runs[1]!.status, "completed");
  assert.equal(current.runs[1]!.selection.nativeModel, "native-model-b");
  const messages = (await readFile(f.trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(messages.some(row => row.method === "thread/start" && row.params.model === "native-model-b"));
  assert.ok(messages.some(row => row.method === "session/set_config_option" && row.params.value === "native-model-b"));
  assert.equal(messages.filter(row => row.method === "turn/start" || row.method === "session/prompt").length, 2);
  runtime.switch(session.id, { harnessId: "native-codex", nativeModel: "model-from-another-harness" }, "invalid-model"); await runtime.wait(session.id);
  assert.equal(runtime.read(session.id).switches.at(-1)!.status, "effective");
  runtime.send(session.id,"invalid model must not reach a prompt","invalid-model-input"); await runtime.wait(session.id);
  assert.equal(runtime.read(session.id).runs.at(-1)!.status,"failed"); assert.equal(runtime.read(session.id).runs.at(-1)!.error?.code,"MODEL_UNAVAILABLE"); assert.equal(runtime.read(session.id).status,"open");
});

test("authenticated native models endpoint accepts workspace queries, projects no credentials and owns probe shutdown", async t => {
  const f = await setup(t);
  const gateway = await startWebServer({ root: join(f.root, "web-data"), configuration: f.config, port: 0,
    application: (root, publish) => application(root, publish, { nativeEnvironment: f.environment }) });
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

test("cancelled native discovery starts no protocol operation and removes only its owned temporary manifest", async t => {
  const f = await setup(t), factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(f.root, "locks")), () => {}, undefined, undefined, f.environment);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => factory.discoverModels({ harnessId: "native-codex" }, f.config, controller.signal), error => error !== null && typeof error === "object" && "code" in error && error.code === "CANCELLED");
  await assert.rejects(() => readFile(f.trace), error => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT");
  assert.ok(await readFile(join(f.home, ".codex", "config.toml")));
});
