import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Socket } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MODEL = "harnessgateway-fixture-model";
const KEY_NAME = "HARNESS_GATEWAY_LOCAL_FIXTURE_KEY";
const DUMMY_KEY = "dummy-local-test-key-not-a-credential";
const PROMPT = "HarnessGateway local provider acceptance: reply briefly in plain text; do not invoke any tools.";
const ANSWER = "HarnessGateway real Codex with local deterministic provider passed.";
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_CLI_BYTES = 4 * 1024 * 1024;
const cli = fileURLToPath(new URL("../../src/cli/control.js", import.meta.url));

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}
function code(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
async function localCodex(): Promise<string> {
  const paths = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const directory of [...new Set(paths.filter(path => isAbsolute(path)))]) {
    const entry = join(directory, "codex");
    try { await lstat(entry); }
    catch (error: unknown) { if (code(error) === "ENOENT") continue; throw error; }
    assert.ok((await stat(entry)).isFile(), "selected local Codex entry is not a file");
    await access(entry, constants.X_OK);
    return realpath(entry);
  }
  throw new Error("real Codex acceptance requires an installed codex executable; absence is a failure, not a skipped pass");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const raw of request) {
    const chunk: unknown = raw;
    assert.ok(Buffer.isBuffer(chunk), "HTTP request body is not bytes");
    length += chunk.length; assert.ok(length <= MAX_HTTP_BYTES, "HTTP request exceeds its acceptance byte budget");
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  return record(parsed, "Responses input");
}
/** Complete Responses SSE lifecycle using a fixed assistant message; this endpoint does not run a model. */
function responseSse(response: ServerResponse): void {
  const content = { type: "output_text", text: ANSWER, annotations: [], logprobs: [] };
  const item = { id: "msg_local_fixture", type: "message", role: "assistant", status: "completed", content: [content] };
  const base = { id: "resp_local_fixture", object: "response", created_at: 1_791_523_200,
    status: "in_progress", error: null, incomplete_details: null, model: MODEL, output: [], store: false };
  let sequence = 0;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Request-Id": "local-fixture" });
  function event(type: string, fields: Record<string, unknown>): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  }
  event("response.created", { response: base });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: ANSWER, logprobs: [] });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: ANSWER, logprobs: [] });
  event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: content });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...base, status: "completed", output: [item],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
}
function invoke(args: readonly string[], cwd: string, home: string, temporary: string): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: temporary, LANG: "C.UTF-8",
    }, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [], errors: Buffer[] = []; let length = 0;
    let exceeded = false, expired = false;
    // The formal CLI owns its Harness process group; signals first allow its bounded cleanup path to run.
    const timer = setTimeout(() => { expired = true; child.kill("SIGINT"); }, 20000);
    const emergency = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 35000);
    function capture(target: Buffer[], chunk: Buffer): void {
      length += chunk.length;
      if (length > MAX_CLI_BYTES) { exceeded = true; child.kill("SIGINT"); return; }
      target.push(chunk);
    }
    child.stdout.on("data", (chunk: Buffer) => capture(output, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(errors, chunk));
    child.on("error", error => { clearTimeout(timer); clearTimeout(emergency); reject(error); });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(emergency);
      if (exceeded || expired) { reject(new Error(exceeded ? "formal CLI output exceeded the acceptance byte budget" : "formal CLI exceeded the acceptance deadline")); return; }
      resolve({ code: exitCode, signal, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") });
    });
  });
}

test("real local Codex through the formal gateway CLI uses only its deterministic local Responses provider", { timeout: 45000 }, async t => {
  assert.notEqual(process.platform, "win32", "current real acceptance requires the implemented POSIX control host");
  assert.ok((await stat(cli)).isFile(), "build the formal CLI before running real acceptance");
  const executable = await localCodex();
  const root = await mkdtemp(join(tmpdir(), "harness-real-codex-local-"));
  const home = join(root, "home"), workspace = join(root, "workspace"), temporary = join(root, "temporary");
  const sockets = new Set<Socket>(), requests: Record<string, unknown>[] = [], providerErrors: Error[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST", "only Responses POST is allowed in this local provider");
      assert.equal(request.url, "/v1/responses", "Codex used an unexpected provider route");
      assert.equal(request.headers.authorization, `Bearer ${DUMMY_KEY}`, "Codex did not use the synthetic key configured for the private provider");
      const input = await body(request); requests.push(input);
      assert.equal(requests.length, 1, "acceptance must not silently retry or issue another model request");
      assert.equal(input.model, MODEL, "Codex did not use the explicitly configured fixture model");
      assert.equal(input.stream, true, "Codex must consume streaming Responses events");
      assert.ok(Array.isArray(input.input), "Responses input must contain the conversation items");
      assert.ok(input.input.some(raw => {
        const item = record(raw, "request input item");
        return item.role === "user" && Array.isArray(item.content) && item.content.some(rawContent => record(rawContent, "request content").text === PROMPT);
      }), "formal gateway prompt is missing from the provider's user input");
      assert.ok(!input.input.some(raw => ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(String(record(raw, "request input item").type))), "text-only acceptance unexpectedly invoked a tool");
      responseSse(response);
    })().catch((error: unknown) => {
      providerErrors.push(error instanceof Error ? error : new Error("local provider acceptance failed"));
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { type: "fixture_validation_error", message: "local acceptance validation rejected the request" } }));
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_request, socket) => { providerErrors.push(new Error("unexpected provider WebSocket upgrade")); socket.destroy(); });
  let listening = false;
  try {
    await mkdir(home); await mkdir(workspace); await mkdir(temporary);
    for (const directory of ["config", "data", "state", "cache", "codex", "claude", "opencode"]) await mkdir(join(home, directory));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); listening = true; resolve(); }); });
    const address = server.address(); assert.ok(address !== null && typeof address !== "string");
    await writeFile(join(home, "codex", "config.toml"), [
      `model = "${MODEL}"`, 'model_provider = "fixture"', 'web_search = "disabled"',
      '[features]', 'shell_tool = false', 'unified_exec = false', 'shell_snapshot = false', 'skill_mcp_dependency_install = false',
      '[model_providers.fixture]', 'name = "HarnessGateway local deterministic fixture"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`, 'wire_api = "responses"',
      `env_key = "${KEY_NAME}"`, 'requires_openai_auth = false', 'supports_websockets = false',
      'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 5000', "",
    ].join("\n"));
    const source = { repository: "openai/codex", revision: "local-real-acceptance", upstreamId: "codex", url: "https://github.com/openai/codex" };
    const manifest = join(root, "manifest.json");
    await writeFile(manifest, JSON.stringify({ version: 2, definitions: [{ id: "customrealcodex", name: "Real local Codex acceptance",
      aliases: [], binaryNames: [], configHints: [], controls: [{ id: "customrealcodex-control", protocol: "codex-app-server",
        executableNames: ["codex"], args: ["app-server", "--listen", "stdio://"], env: { [KEY_NAME]: DUMMY_KEY },
        package: null, distribution: null, requiredExecutables: [], source }] }],
      overrides: { "customrealcodex-control": { executable } } }));
    const invoked = await invoke(["run", "--harness", "customrealcodex", "--prompt", PROMPT, "--manifest", manifest,
      "--config-home", home, "--cwd", workspace, "--timeout-ms", "10000", "--json"], workspace, home, temporary);
    assert.deepEqual(providerErrors, [], providerErrors.map(error => error.message).join("; "));
    assert.equal(invoked.code, 0, `formal CLI failed (signal ${invoked.signal}): ${invoked.stderr}\n${invoked.stdout}`);
    const output = invoked.stdout.trim().split("\n").map(line => { const parsed: unknown = JSON.parse(line); return record(parsed, "CLI record"); });
    const events = output.filter(entry => entry.type === "event").map(entry => record(entry.event, "CLI event"));
    assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), ANSWER);
    assert.ok(!events.some(event => event.type === "tool" || event.type === "permission"), "text-only acceptance emitted a tool or permission event");
    assert.deepEqual(output.find(entry => entry.type === "result")?.result, { status: "completed", reason: "completed" });
    assert.equal(record(output.find(entry => entry.type === "cleanup")?.cleanup, "cleanup evidence").closed, true);
    assert.equal(output[0]?.type, "protocol"); assert.equal(output.at(-1)?.type, "cleanup");
    assert.equal(requests.length, 1, "real Codex did not call the controlled local provider exactly once");
    assert.deepEqual(await readdir(temporary), [], "formal CLI did not remove its owned private invocation directory");
    assert.deepEqual(await readdir(workspace), [], "text-only acceptance wrote to its workspace");
    const protocol = record(output[0]?.observation, "protocol observation");
    t.diagnostic(JSON.stringify({ realHarness: "codex", executable, userAgent: record(protocol.capabilities, "protocol capabilities").userAgent,
      provider: "local deterministic HTTP Responses SSE", model: MODEL, requests: requests.length,
      result: "completed", cleanup: "closed", realModelValidated: false, credentials: "synthetic private test key only" }));
  } finally {
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
