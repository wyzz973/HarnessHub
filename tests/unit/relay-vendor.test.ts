import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { parseVendorKey, parseVendorObservation, type VendorKey, type VendorObservation } from "../../src/contracts/relay.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import { openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { endpointHost, endpointLayers, hermesModelKey, observedVendor, readEndpoint, slashModelKey, vendorObservation, type EndpointReading, type EndpointSources } from "../../src/adapters/control/relay-vendor.js";

// G069-C04 and G069-C08 (ADR-055 §8.1 vendor column, §10.4, INV-33): the endpoint each Driver resolves from its Harness's
// own configuration layers, the vendor key its declaration gives, and its model key. Every directory here is a synthetic
// home and workspace under os.tmpdir(), removed after the test; no real configuration is read. Fake credentials are
// split so that no complete secret shape appears in the source.

const FAKE_ANTHROPIC_KEY = "sk-ant-" + "api03-" + "g069fixture".repeat(6);
const FAKE_DEEPSEEK_KEY = "sk-" + "g069" + "f".repeat(28);
const FAKE_OPENAI_KEY = "sk-" + "proj-" + "g069fixture".repeat(4);

interface Fixture { readonly root: string; readonly home: string; readonly workspace: string; write(path: string, content: string): Promise<string>; sources(values?: Record<string, string>): EndpointSources }
async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "g069-vendor-")), home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return {
    root, home, workspace,
    async write(path, content) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path; },
    sources: (values = {}) => ({ home, values, workspace }),
  };
}
const observe = (reading: EndpointReading, model: string | null, authKind: string | null, normalize: (model: string | null) => string): VendorObservation => {
  const observed = vendorObservation(reading, model, authKind, normalize);
  assert.ok(observed !== null, "the reading is known");
  // Every observation and key a Driver gives is one the contract's parsers take.
  assert.deepEqual(parseVendorObservation(JSON.parse(JSON.stringify(observed))), observed);
  return observed;
};
const key = (vendor: VendorKey): VendorKey => { assert.equal(parseVendorKey(vendor), vendor); return vendor; };
/** Runs `work` while recording everything written to the console, stdout and stderr (passed through, never swallowed). */
async function recorded<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly written: string }> {
  const written: string[] = [], undo: (() => void)[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = console[method]; console[method] = (...args: unknown[]) => { written.push(args.map(String).join(" ")); };
    undo.push(() => { console[method] = original; });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => { written.push(String(chunk)); return (original as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof stream.write;
    undo.push(() => { stream.write = original; });
  }
  try { return { value: await work(), written: written.join("\n") }; } finally { for (const step of undo.reverse()) step(); }
}

test("G069-C04 Claude Code: ANTHROPIC_BASE_URL in the user's settings.json env is gateway:<host> from user_config; the workspace's settings win, the process environment comes last", async t => {
  const f = await fixture(t), url = "https://api.g069-claude.example/anthropic?route=g069-claude-path";
  await f.write(join(f.home, ".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(g069-other-key:*)"] },
    env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, ANTHROPIC_MODEL: "g069-other-model" } }));
  const user = await readEndpoint("claude", f.sources({ ANTHROPIC_BASE_URL: "https://g069-env.example" }));
  assert.deepEqual(user, { kind: "read", endpoint: { host: "api.g069-claude.example", loopback: false, layer: "user_config", source: "user_config:claude/settings.json" }, backend: null });
  const observed = observe(user, "claude-opus-5-5", "api_key", claudeRelayCapabilities.normalizeModel);
  assert.deepEqual(observed.endpoint, { host: "api.g069-claude.example", layer: "user_config" });
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observed)), "gateway:api.g069-claude.example");
  // The process environment alone; CLAUDE_CONFIG_DIR moves the user's settings, as Claude Code resolves it.
  const moved = await readEndpoint("claude", f.sources({ ANTHROPIC_BASE_URL: "https://g069-env.example/v1", CLAUDE_CONFIG_DIR: join(f.root, "elsewhere") }));
  assert.deepEqual(moved, { kind: "read", endpoint: { host: "g069-env.example", loopback: false, layer: "environment", source: "environment:ANTHROPIC_BASE_URL" }, backend: null });
  // The workspace's settings.local.json comes before its settings.json and the user's.
  await f.write(join(f.workspace, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://g069-project.example" } }));
  await f.write(join(f.workspace, ".claude", "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://g069-local.example" } }));
  const local = await readEndpoint("claude", f.sources());
  assert.deepEqual(local.kind === "read" ? local.endpoint : null, { host: "g069-local.example", loopback: false, layer: "workspace_file", source: "workspace_file:<workspace>/.claude/settings.local.json" });
  // Invalid samples: a sign-in without an endpoint is Anthropic, a loopback endpoint a local proxy of unknown destination.
  const plain = await readEndpoint("claude", { ...f.sources(), workspace: join(f.root, "empty"), home: join(f.root, "empty") });
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(plain, null, "account", claudeRelayCapabilities.normalizeModel))), "anthropic");
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(plain, null, "gateway", claudeRelayCapabilities.normalizeModel))), "unknown:claude");
  const proxy = await readEndpoint("claude", { ...f.sources({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" }), workspace: join(f.root, "empty"), home: join(f.root, "empty") });
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(proxy, null, "api_key", claudeRelayCapabilities.normalizeModel))), "unknown:claude");
  // The cloud backends its settings switch on (1, true, yes, on), with no endpoint: the authentication kind names it.
  const bedrock = await readEndpoint("claude", { ...f.sources({ CLAUDE_CODE_USE_BEDROCK: "1" }), workspace: join(f.root, "empty"), home: join(f.root, "empty") });
  assert.deepEqual(bedrock, { kind: "read", endpoint: null, backend: "bedrock" });
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(bedrock, "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "external", claudeRelayCapabilities.normalizeModel))), "aws-bedrock");
  const vertex = await readEndpoint("claude", { ...f.sources({ CLAUDE_CODE_USE_VERTEX: "TRUE", CLAUDE_CODE_USE_BEDROCK: "0" }), workspace: join(f.root, "empty"), home: join(f.root, "empty") });
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(vertex, null, "external", claudeRelayCapabilities.normalizeModel))), "google-vertex");
  // A switch written as a JSON number or boolean in the settings is the text it becomes in the environment.
  for (const [written, backend] of [[1, "bedrock"], [true, "bedrock"], [0, null], [false, null]] as const) {
    const home = join(f.root, "switch-" + String(written));
    await f.write(join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: written } }));
    assert.deepEqual(await readEndpoint("claude", { home, values: {}, workspace: join(f.root, "empty") }), { kind: "read", endpoint: null, backend }, String(written));
  }
  // A backend switch together with an endpoint is ambiguous (in Bedrock or Vertex mode the endpoint is likely unused), so
  // unknown; the invalid sample is the same endpoint without a switch, which is the gateway.
  for (const [switch_, value] of [["CLAUDE_CODE_USE_BEDROCK", "1"], ["CLAUDE_CODE_USE_VERTEX", "true"]] as const) {
    const both = await readEndpoint("claude", { ...f.sources({ [switch_]: value, ANTHROPIC_BASE_URL: "https://g069-gateway.example" }), workspace: join(f.root, "empty"), home: join(f.root, "empty") });
    assert.equal(both.kind === "read" ? both.backend : null, switch_ === "CLAUDE_CODE_USE_BEDROCK" ? "bedrock" : "vertex");
    assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(both, null, "api_key", claudeRelayCapabilities.normalizeModel))), "unknown:claude", switch_);
  }
  const alone = await readEndpoint("claude", { ...f.sources({ ANTHROPIC_BASE_URL: "https://g069-gateway.example" }), workspace: join(f.root, "empty"), home: join(f.root, "empty") });
  assert.equal(key(claudeRelayCapabilities.resolveVendor(observe(alone, null, "api_key", claudeRelayCapabilities.normalizeModel))), "gateway:g069-gateway.example");
});

test("G069-C04 Codex: OPENAI_BASE_URL is gateway:<host> from the environment; openai_base_url in config.toml (user, then workspace) comes before it; the provider decides the rest", async t => {
  const f = await fixture(t), codex = codexRelayCapabilities, environment = { OPENAI_BASE_URL: "https://g069-codex-relay.example/v1?key=g069-codex-query", OPENAI_API_KEY: FAKE_OPENAI_KEY };
  const fromEnvironment = await readEndpoint("codex", f.sources(environment));
  assert.deepEqual(fromEnvironment, { kind: "read", endpoint: { host: "g069-codex-relay.example", loopback: false, layer: "environment", source: "environment:OPENAI_BASE_URL" }, backend: null });
  // The observation names the thread's model provider as the model's prefix.
  assert.equal(key(codex.resolveVendor(observe(fromEnvironment, "openai/gpt-5.5", "chatgpt", codex.normalizeModel))), "gateway:g069-codex-relay.example");
  await f.write(join(f.home, ".codex", "config.toml"), 'model = "gpt-5.5"\nopenai_base_url = "https://g069-codex-user.example/v1"\n[model_providers.other]\nbase_url = "https://g069-not-read.example"\nenv_key = "G069_OTHER"\n');
  const user = await readEndpoint("codex", f.sources(environment));
  assert.deepEqual(user.kind === "read" ? user.endpoint : null, { host: "g069-codex-user.example", loopback: false, layer: "user_config", source: "user_config:codex/config.toml" });
  await f.write(join(f.workspace, ".codex", "config.toml"), 'openai_base_url = "https://g069-codex-project.example/v1"\n');
  const project = await readEndpoint("codex", f.sources(environment));
  assert.deepEqual(project.kind === "read" ? project.endpoint : null, { host: "g069-codex-project.example", loopback: false, layer: "workspace_file", source: "workspace_file:<workspace>/.codex/config.toml" });
  // CODEX_HOME moves the user's file.
  const moved = await readEndpoint("codex", { ...f.sources({ CODEX_HOME: join(f.root, "codex-home") }), workspace: join(f.root, "empty") });
  assert.deepEqual(moved, { kind: "read", endpoint: null, backend: null });
  // Invalid samples, one per rule: no endpoint is the provider's own key; a loopback endpoint of openai is unknown.
  const none = observe(moved, "openai/gpt-5.5", "chatgpt", codex.normalizeModel), local = observe(await readEndpoint("codex", { ...f.sources({ OPENAI_BASE_URL: "http://localhost:11434/v1", CODEX_HOME: join(f.root, "codex-home") }), workspace: join(f.root, "empty") }), "ollama/gpt-oss:20b", null, codex.normalizeModel);
  assert.equal(key(codex.resolveVendor(none)), "openai");
  assert.equal(key(codex.resolveVendor({ ...local, model: "openai/gpt-5.5" })), "unknown:codex");
  assert.equal(key(codex.resolveVendor({ ...none, model: "azure/gpt-5.5" })), "gateway:azure");
  assert.equal(key(codex.resolveVendor({ ...none, model: "corp-proxy/gpt-5.5" })), "provider:corp-proxy");
  assert.equal(key(codex.resolveVendor({ ...none, model: "gpt-5.5" })), "unknown:codex");
  assert.equal(key(codex.resolveVendor({ ...local, model: "gpt-5.5" })), "unknown:codex", "no provider: the OpenAI endpoint applies, a loopback one is a local proxy");
  // The OpenAI endpoint variables apply to the openai provider (or none) only: any other provider never reads them, so its
  // key is the same with or without one, gateway or loopback (ollama included: its own endpoint is not read, so never local).
  const remote = observe(fromEnvironment, "openai/gpt-5.5", null, codex.normalizeModel);
  for (const [model, vendor] of [["azure/gpt-5.5", "gateway:azure"], ["corp-proxy/gpt-5.5", "provider:corp-proxy"], ["ollama/gpt-oss:20b", "provider:ollama"], ["ollama/gpt-oss:120b-cloud", "provider:ollama"]] as const)
    for (const observed of [none, local, remote]) assert.equal(key(codex.resolveVendor({ ...observed, model })), vendor, model + " " + JSON.stringify(observed.endpoint));
  // Invalid sample: for openai the remote endpoint is the gateway.
  assert.equal(key(codex.resolveVendor(remote)), "gateway:g069-codex-relay.example");
});

test("G069-C04 DeepSeek Harness: DEEPSEEK_BASE_URL in the workspace's .env is gateway:<host> from workspace_file; dsh 0.2.1-rc.5's launch order (inherited environment, workspace .env, $DSH_HOME/.env); its credentials document is no endpoint layer", async t => {
  const f = await fixture(t), dsh = dshRelayCapabilities;
  await f.write(join(f.workspace, ".env"), ["# written by another Harness", "DEEPSEEK_API_KEY=" + FAKE_DEEPSEEK_KEY, "export DEEPSEEK_BASE_URL=\"https://g069-dsh-relay.example/v1\" # g069-dsh-comment", "OTHER=g069-other-value", ""].join("\n"));
  const workspace = await readEndpoint("dsh", f.sources());
  assert.deepEqual(workspace, { kind: "read", endpoint: { host: "g069-dsh-relay.example", loopback: false, layer: "workspace_file", source: "workspace_file:<workspace>/.env" }, backend: null });
  assert.equal(key(dsh.resolveVendor(observe(workspace, "deepseek-v4-flash", null, dsh.normalizeModel))), "gateway:g069-dsh-relay.example");
  // $DSH_HOME/.env is the last layer, the inherited environment the first (dsh-launch-environment: process > project-env > user-env).
  await f.write(join(f.home, ".dsh", ".env"), "DEEPSEEK_BASE_URL=https://g069-dsh-home-env.example\n");
  const stillWorkspace = await readEndpoint("dsh", f.sources());
  assert.equal(stillWorkspace.kind === "read" ? stillWorkspace.endpoint?.host : null, "g069-dsh-relay.example");
  const inherited = await readEndpoint("dsh", f.sources({ DEEPSEEK_BASE_URL: "https://g069-dsh-inherited.example" }));
  assert.deepEqual(inherited.kind === "read" ? inherited.endpoint : null, { host: "g069-dsh-inherited.example", loopback: false, layer: "environment", source: "environment:DEEPSEEK_BASE_URL" });
  // The credentials document in its own shape (dsh-credentials-local: `version: 1`, `refs` of credential references,
  // `records`), with a base-URL reference among the refs and a foreign top-level key: neither is a base URL dsh uses (it
  // reads that from the launch environment only), so the reading does not change, nor does the document's content show.
  const document = ["version: 1", "refs:", "  DEEPSEEK_API_KEY: " + FAKE_DEEPSEEK_KEY, "  DEEPSEEK_BASE_URL: https://g069-dsh-credentials.example", "records:",
    "  deepseek/default:", "    kind: api-key", "    key: " + "g069" + "-record-" + "value", "DEEPSEEK_BASE_URL: https://g069-dsh-foreign.example", ""].join("\n");
  await f.write(join(f.home, ".dsh", ".credentials.yaml"), document);
  assert.deepEqual(await readEndpoint("dsh", f.sources()), stillWorkspace, "the credentials document changes nothing");
  await rm(join(f.workspace, ".env"));
  const last = await readEndpoint("dsh", f.sources());
  assert.deepEqual(last.kind === "read" ? last.endpoint : null, { host: "g069-dsh-home-env.example", loopback: false, layer: "user_config", source: "user_config:dsh/.env" });
  assert.ok(!JSON.stringify(last).includes("g069-dsh-credentials") && !JSON.stringify(last).includes(FAKE_DEEPSEEK_KEY));
  // Invalid samples: no layer names an endpoint, so DeepSeek itself; a loopback endpoint is not DeepSeek.
  await rm(join(f.home, ".dsh", ".env"));
  assert.equal(key(dsh.resolveVendor(observe(await readEndpoint("dsh", f.sources()), "deepseek-v4-flash", null, dsh.normalizeModel))), "deepseek");
  assert.equal(key(dsh.resolveVendor(observe(await readEndpoint("dsh", f.sources({ DEEPSEEK_BASE_URL: "http://127.0.0.1:8080" })), null, null, dsh.normalizeModel))), "unknown:dsh");
});

test("G069-C04 an Ollama *-cloud model through a loopback endpoint is gateway:<host>, never local (OpenClaw's provider baseUrl, OpenCode's opencode.json); a local model is local", async t => {
  const f = await fixture(t), openclaw = openClawRelayCapabilities, opencode = openCodeRelayCapabilities;
  await f.write(join(f.home, ".openclaw", "openclaw.json"), "// OpenClaw's JSON5\n{ models: { providers: { ollama: { baseUrl: 'http://127.0.0.1:11434', apiKey: 'g069-ollama-key', api: 'ollama' }, }, }, agents: { defaults: { model: 'ollama/gpt-oss:120b-cloud' } } }\n");
  const gateway = await readEndpoint("openclaw", f.sources(), "ollama");
  assert.deepEqual(gateway, { kind: "read", endpoint: { host: "127.0.0.1", loopback: true, layer: "user_config", source: "user_config:openclaw/openclaw.json" }, backend: null });
  assert.equal(key(openclaw.resolveVendor(observe(gateway, "ollama/gpt-oss:120b-cloud", null, openclaw.normalizeModel))), "gateway:127.0.0.1");
  assert.equal(key(openclaw.resolveVendor(observe(gateway, "ollama/glm-4.6:cloud", null, openclaw.normalizeModel))), "gateway:127.0.0.1");
  // Invalid sample: a model the local server runs itself is local.
  assert.equal(key(openclaw.resolveVendor(observe(gateway, "ollama/qwen3:8b", null, openclaw.normalizeModel))), "local");
  // Another provider's endpoint is not read for this one; OPENCLAW_CONFIG_PATH moves the file.
  assert.deepEqual(await readEndpoint("openclaw", f.sources(), "anthropic"), { kind: "read", endpoint: null, backend: null });
  assert.deepEqual(await readEndpoint("openclaw", f.sources({ OPENCLAW_CONFIG_PATH: join(f.root, "none.json") }), "ollama"), { kind: "read", endpoint: null, backend: null });
  // OpenCode: the provider's options.baseURL, the workspace's file first.
  await f.write(join(f.workspace, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://localhost:11434/v1", apiKey: "g069-oc-key" } } } }));
  const project = await readEndpoint("opencode", f.sources(), "ollama");
  assert.deepEqual(project.kind === "read" ? project.endpoint : null, { host: "localhost", loopback: true, layer: "workspace_file", source: "workspace_file:<workspace>/opencode.json" });
  assert.equal(key(opencode.resolveVendor(observe(project, "ollama/deepseek-v3.1:671b-cloud", null, opencode.normalizeModel))), "gateway:localhost");
  assert.equal(key(opencode.resolveVendor(observe(project, "lmstudio/qwen3-coder", null, opencode.normalizeModel))), "local");
  // Prefix rules without an endpoint: the named vendors, OpenCode Zen, OpenRouter, other providers, none.
  const none = observe(await readEndpoint("opencode", f.sources(), "anthropic"), "anthropic/claude-sonnet-4-5", null, opencode.normalizeModel);
  assert.equal(key(opencode.resolveVendor(none)), "anthropic");
  for (const [model, vendor] of [["openai/gpt-5.5", "openai"], ["deepseek/deepseek-chat", "deepseek"], ["google/gemini-3-pro", "google"], ["opencode/grok-code", "provider:opencode-zen"],
    ["openrouter/anthropic/claude-sonnet-4-5", "router:openrouter"], ["zai/glm-4.6", "provider:zai"], ["ollama/qwen3:8b", "provider:ollama"], ["gpt-5.5", "unknown:opencode"]] as const)
    assert.equal(key(opencode.resolveVendor({ ...none, model })), vendor, model);
  // A loopback proxy for another provider is of unknown destination.
  assert.equal(key(opencode.resolveVendor({ ...observe(project, "anthropic/claude-sonnet-4-5", null, opencode.normalizeModel) })), "unknown:opencode");
});

test("G069-C04 Hermes reads no endpoint key yet (unsupported), so its vendor is unknown:hermes; only an endpoint it reports could make it gateway:<host>", async t => {
  const f = await fixture(t), hermes = hermesRelayCapabilities;
  await f.write(join(f.home, ".hermes", "config.yaml"), "model:\n  default: anthropic/claude-sonnet-4-5\n  base_url: https://g069-hermes.example/v1\n");
  const reading = await readEndpoint("hermes", f.sources());
  assert.deepEqual(reading, { kind: "unsupported" });
  assert.equal(vendorObservation(reading, "openrouter:anthropic/claude-sonnet-4-5", null, hermes.normalizeModel), null);
  assert.equal(key(observedVendor(hermes, "hermes", null)), "unknown:hermes");
  const reported: VendorObservation = { model: "openrouter:anthropic/claude-sonnet-4-5", modelKey: "claude-sonnet-4-5", authKind: null, endpoint: { host: "g069-hermes.example", layer: "user_config" }, loopback: false };
  assert.equal(key(hermes.resolveVendor(reported)), "gateway:g069-hermes.example");
  assert.equal(key(hermes.resolveVendor({ ...reported, endpoint: null })), "unknown:hermes");
});

test("G069-C04 endpoint values never appear in any log, error, exception or status; a layer that cannot be read is a readable status and the vendor is unknown:<harness>", async t => {
  const f = await fixture(t), secretPath = "g069-secret-path-" + "7f3a", value = "https://g069-leak-host.example/" + secretPath + "?token=" + FAKE_ANTHROPIC_KEY;
  const settings = join(f.home, ".claude", "settings.json");
  const cases: { readonly name: string; readonly prepare: () => Promise<void>; readonly read: () => Promise<EndpointReading>; readonly expected: Partial<Extract<EndpointReading, { kind: "unreadable" }>> }[] = [
    { name: "unparseable JSON that holds the value", prepare: async () => { await f.write(settings, '{ "env": { "ANTHROPIC_BASE_URL": "' + value + '", }, broken'); }, read: () => readEndpoint("claude", f.sources()),
      expected: { layer: "user_config", source: "user_config:claude/settings.json", problem: "unparseable", code: null } },
    { name: "a directory where the file is", prepare: async () => { await rm(settings, { force: true }); await mkdir(settings, { recursive: true }); }, read: () => readEndpoint("claude", f.sources()),
      expected: { layer: "user_config", problem: "not_a_file" } },
    { name: "an unreadable file", prepare: async () => { await rm(settings, { recursive: true, force: true }); await f.write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: value } })); await chmod(settings, 0o000); },
      read: () => readEndpoint("claude", f.sources()), expected: { layer: "user_config", problem: "unreadable", code: "EACCES" } },
    { name: "a file over 2 MiB", prepare: async () => { await chmod(settings, 0o600); await f.write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: value }, pad: "x".repeat(2 * 1024 * 1024) })); },
      read: () => readEndpoint("claude", f.sources()), expected: { problem: "too_large" } },
    { name: "a value that is no endpoint", prepare: async () => { await f.write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "not an endpoint " + secretPath + " " + FAKE_ANTHROPIC_KEY } })); },
      read: () => readEndpoint("claude", f.sources()), expected: { layer: "user_config", problem: "invalid_endpoint" } },
    { name: "a variable that is no endpoint", prepare: async () => { await rm(settings); }, read: () => readEndpoint("codex", f.sources({ OPENAI_BASE_URL: "ftp://g069-leak-host.example/" + secretPath })),
      expected: { layer: "environment", source: "environment:OPENAI_BASE_URL", problem: "invalid_endpoint" } },
    { name: "unparseable TOML that holds the value", prepare: async () => { await f.write(join(f.workspace, ".codex", "config.toml"), 'openai_base_url = "' + value + '\n[[broken'); },
      read: () => readEndpoint("codex", f.sources()), expected: { layer: "workspace_file", problem: "unparseable" } },
    { name: "a FIFO where the file is (opened without blocking, never read)", prepare: async () => { await mkdir(join(f.home, ".dsh"), { recursive: true }); execFileSync("mkfifo", [join(f.home, ".dsh", ".env")]); },
      read: () => readEndpoint("dsh", f.sources()), expected: { layer: "user_config", source: "user_config:dsh/.env", problem: "not_a_file", code: null } },
    { name: "unparseable JSON5 that holds the value", prepare: async () => { await f.write(join(f.home, ".openclaw", "openclaw.json"), "{ models: { providers: { ollama: { baseUrl: '" + value + "' } } "); },
      read: () => readEndpoint("openclaw", f.sources(), "ollama"), expected: { layer: "user_config", problem: "unparseable" } },
  ];
  const { value: results, written } = await recorded(async () => {
    const seen: { name: string; reading: EndpointReading; error: string }[] = [];
    for (const item of cases) {
      await item.prepare();
      let reading: EndpointReading = { kind: "unsupported" }, error = "";
      try { reading = await item.read(); } catch (thrown) { error = thrown instanceof Error ? thrown.name + ": " + thrown.message + "\n" + thrown.stack : String(thrown); }
      seen.push({ name: item.name, reading, error });
    }
    // A successful reading keeps the host only, never the rest of the value.
    await chmod(settings, 0o600).catch(() => {}); await f.write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: value } }));
    seen.push({ name: "a readable endpoint", reading: await readEndpoint("claude", { ...f.sources(), workspace: join(f.root, "empty") }), error: "" });
    return seen;
  });
  t.after(async () => { await chmod(settings, 0o600).catch(() => {}); });
  for (const [index, item] of cases.entries()) {
    const { reading, error } = results[index]!;
    assert.equal(error, "", item.name + ": nothing is thrown for a layer's content");
    assert.equal(reading.kind, "unreadable", item.name);
    for (const [field, expected] of Object.entries(item.expected)) assert.equal((reading as Record<string, unknown>)[field], expected, item.name + " " + field);
    // No observation, so the vendor is unknown: an endpoint that cannot be known is never read as none.
    assert.equal(vendorObservation(reading, "claude-opus-5-5", "api_key", slashModelKey), null);
  }
  assert.deepEqual(results.at(-1)!.reading, { kind: "read", endpoint: { host: "g069-leak-host.example", loopback: false, layer: "user_config", source: "user_config:claude/settings.json" }, backend: null });
  assert.equal(key(observedVendor(claudeRelayCapabilities, "claude", null)), "unknown:claude");
  const statuses = JSON.stringify(results);
  for (const part of [value, secretPath, FAKE_ANTHROPIC_KEY, "token="]) {
    assert.ok(!written.includes(part), "nothing written to the console, stdout or stderr holds " + part);
    assert.ok(!statuses.includes(part), "no status, error or exception holds " + part);
  }
  // Only the successful reading names the host; no failure does.
  assert.ok(!JSON.stringify(results.slice(0, -1)).includes("g069-leak-host"), "a failure does not name the host");
  assert.equal(endpointHost(value)?.host, "g069-leak-host.example");
  for (const invalid of ["", "g069-leak-host.example/v1", "file:///etc/hosts", "https://", "https://exa_mple.com", "https://" + "a".repeat(254) + ".example", "x".repeat(4097)]) assert.equal(endpointHost(invalid), null, invalid);
  // No status names a file by its path: the root of the synthetic home and workspace never appears in one.
  assert.ok(!statuses.includes(f.root), "no absolute path in a status");
  // The module itself has no way to write anywhere: no console, stdout or stderr in its source.
  const source = await readFile(new URL("../../../src/adapters/control/relay-vendor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bconsole\.|process\.(?:stdout|stderr)|\.write\(/u);
});

test("G069-C04 a status names a layer by its own label, wherever its directory is: a home inside the workspace stays user_config, a configuration directory outside both shows no path", async t => {
  const f = await fixture(t), value = "https://g069-label.example/v1";
  // The home inside the workspace: the user's settings are still the user_config layer, named as such.
  const nested = join(f.workspace, "home");
  await f.write(join(nested, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: value } }));
  assert.deepEqual(await readEndpoint("claude", { home: nested, values: {}, workspace: f.workspace }),
    { kind: "read", endpoint: { host: "g069-label.example", loopback: false, layer: "user_config", source: "user_config:claude/settings.json" }, backend: null });
  // CLAUDE_CONFIG_DIR outside the home and the workspace, unreadable: the status names the layer, not the directory.
  const outside = join(f.root, "elsewhere-" + "g069-config-dir"), settings = join(outside, "settings.json");
  await f.write(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: value } })); await chmod(settings, 0o000);
  t.after(async () => { await chmod(settings, 0o600).catch(() => {}); });
  const reading = await readEndpoint("claude", f.sources({ CLAUDE_CONFIG_DIR: outside }));
  assert.deepEqual(reading, { kind: "unreadable", layer: "user_config", source: "user_config:claude/settings.json", problem: "unreadable", code: "EACCES" });
  assert.ok(!JSON.stringify(reading).includes("g069-config-dir") && !JSON.stringify(reading).includes(f.root));
  // OpenCode's and Codex's user directories moved the same way keep their labels.
  await f.write(join(outside, "codex", "config.toml"), 'openai_base_url = "' + value + '"\n');
  const codex = await readEndpoint("codex", f.sources({ CODEX_HOME: join(outside, "codex") }));
  assert.equal(codex.kind === "read" ? codex.endpoint?.source : null, "user_config:codex/config.toml");
});

test("G069-C04 only endpoint keys are read: the environment is never enumerated and only endpoint and path variables are looked up; each layer names only the keys §8.1 names", async t => {
  const f = await fixture(t), touched = new Set<string>();
  let enumerated = false;
  const values: Record<string, string> = { ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, OPENAI_API_KEY: FAKE_OPENAI_KEY, DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY, OPENAI_BASE_URL: "https://g069-proxy.example", PATH: "/usr/bin", G069_OTHER: "g069" };
  const watched = new Proxy(values, {
    get(target, name) { if (typeof name === "string") touched.add(name); return Reflect.get(target, name); },
    has(target, name) { if (typeof name === "string") touched.add(name); return Reflect.has(target, name); },
    getOwnPropertyDescriptor(target, name) { if (typeof name === "string") touched.add(name); return Reflect.getOwnPropertyDescriptor(target, name); },
    ownKeys(target) { enumerated = true; return Reflect.ownKeys(target); },
  });
  const sources: EndpointSources = { home: f.home, values: watched, workspace: f.workspace };
  for (const harness of ["claude", "codex", "dsh", "opencode", "openclaw", "hermes"] as const) await readEndpoint(harness, sources, "ollama");
  assert.equal(enumerated, false, "the environment is never enumerated");
  const endpointKeys = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "OPENAI_BASE_URL", "DEEPSEEK_BASE_URL"];
  const pathKeys = ["CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "PI_CODING_AGENT_DIR", "DSH_HOME", "DSH_AGENTS_HOME"];
  assert.deepEqual([...touched].filter(name => !endpointKeys.includes(name) && !pathKeys.includes(name)), [], "only endpoint and path variables are looked up");
  for (const secret of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "G069_OTHER"]) assert.ok(!touched.has(secret), secret);
  // The key paths each Harness's layers read, by §8.1.
  const paths = (harness: Parameters<typeof endpointLayers>[0]) => [...new Set((endpointLayers(harness, sources, "ollama") ?? []).flatMap(layer => Object.values(layer.keys).map(path => path.join("."))))].sort();
  assert.deepEqual(paths("claude"), ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "env.ANTHROPIC_BASE_URL", "env.CLAUDE_CODE_USE_BEDROCK", "env.CLAUDE_CODE_USE_VERTEX"]);
  assert.deepEqual(paths("codex"), ["OPENAI_BASE_URL", "openai_base_url"]);
  assert.deepEqual(paths("dsh"), ["DEEPSEEK_BASE_URL"]);
  assert.deepEqual(paths("opencode"), ["provider.ollama.options.baseURL"]);
  assert.deepEqual(paths("openclaw"), ["models.providers.ollama.baseUrl"]);
  assert.equal(endpointLayers("hermes", sources), null);
  // A provider that is no provider name reads nothing (the key path is built from it).
  assert.deepEqual(endpointLayers("opencode", sources, "__proto__"), []); assert.deepEqual(endpointLayers("openclaw", sources, "../x"), []);
  // A dotenv layer keeps only its endpoint variable: the other lines are not read.
  await f.write(join(f.workspace, ".env"), "DEEPSEEK_API_KEY=" + FAKE_DEEPSEEK_KEY + "\nDEEPSEEK_BASE_URL='https://g069-dotenv.example'\n");
  const reading = await readEndpoint("dsh", { home: f.home, values: {}, workspace: f.workspace });
  assert.ok(!JSON.stringify(reading).includes(FAKE_DEEPSEEK_KEY));
  assert.equal(reading.kind === "read" ? reading.endpoint?.host : null, "g069-dotenv.example");
});

test("G069-C08 normalizeModel: provider/model and <provider>:<model> lose the provider, version decorations go, aliases stay their own key, null and over-long models are empty", () => {
  const cases: readonly [(model: string | null) => string, string | null, string][] = [
    [slashModelKey, null, ""], [slashModelKey, "", ""], [slashModelKey, "   ", ""],
    [slashModelKey, "anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"], [slashModelKey, "openrouter/anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"],
    [slashModelKey, "ollama/gpt-oss:120b-cloud", "gpt-oss:120b-cloud"], [slashModelKey, "openai/GPT-5.5", "gpt-5.5"],
    [slashModelKey, "claude-sonnet-4-5-20250929", "claude-sonnet-4-5"], [slashModelKey, "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    [slashModelKey, "anthropic.claude-opus-4-1-20250805-v1:0", "claude-opus-4-1"], [slashModelKey, "claude-opus-4-1@20250805", "claude-opus-4-1"],
    [slashModelKey, "gpt-4o-2024-08-06", "gpt-4o"], [slashModelKey, "claude-3-5-sonnet-latest", "claude-3-5-sonnet"], [slashModelKey, "claude-sonnet-4-5[1m]", "claude-sonnet-4-5[1m]"],
    // Aliases a CLI resolves at run time stay their own key; a version-like name is not a decoration.
    [slashModelKey, "opus", "opus"], [slashModelKey, "deepseek-v3", "deepseek-v3"], [slashModelKey, "provider/", ""],
    [slashModelKey, "m".repeat(96), "m".repeat(96)], [slashModelKey, "m".repeat(97), ""],
    [hermesModelKey, null, ""], [hermesModelKey, "openrouter:anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"], [hermesModelKey, "custom:qwen3:8b", "qwen3:8b"],
    [hermesModelKey, "Anthropic:claude-opus-4-1-20250805", "claude-opus-4-1"], [hermesModelKey, "nous/hermes-4-405b", "hermes-4-405b"],
  ];
  for (const [normalize, model, expected] of cases) assert.equal(normalize(model), expected, JSON.stringify(model));
  // Each declaration's normalizeModel is one of these, and the model key an observation carries is it.
  assert.equal(hermesRelayCapabilities.normalizeModel, hermesModelKey);
  for (const declaration of [claudeRelayCapabilities, codexRelayCapabilities, openCodeRelayCapabilities, openClawRelayCapabilities, dshRelayCapabilities]) assert.equal(declaration.normalizeModel, slashModelKey);
  assert.equal(vendorObservation({ kind: "read", endpoint: null, backend: null }, "openai/gpt-5.5-2026-01-01", null, slashModelKey)?.modelKey, "gpt-5.5");
  assert.deepEqual(vendorObservation({ kind: "read", endpoint: null, backend: null }, "m".repeat(97), "k".repeat(17), slashModelKey), { model: null, modelKey: "", authKind: null, endpoint: null, loopback: false });
  // Invalid sample: Hermes's provider rule does not apply to slash models, whose colon is a tag.
  assert.equal(slashModelKey("custom:qwen3:8b"), "custom:qwen3:8b");
});
