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
import { type SessionId } from "../../src/contracts/session.js";
import { SqliteSessionReader } from "../../src/infrastructure/session/sqlite-store.js";

const MODEL = "harnessgateway-session-fixture-model";
const KEY_NAME = "HARNESS_GATEWAY_SESSION_FIXTURE_KEY";
const DUMMY_KEY = "synthetic-session-key-not-a-credential";
const PROMPTS = ["first public Session turn", "second public Session turn", "third public Session turn after process reopen"] as const;
const ANSWERS = ["Local Session answer one.", "Local Session answer two.", "Local Session answer three."] as const;
const cli = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));
const MAX_HTTP_BYTES = 1024 * 1024, MAX_CLI_BYTES = 4 * 1024 * 1024;
function record(value: unknown, label = "value"): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  return value as Record<string, unknown>;
}
function code(error: unknown): string | undefined { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function assertProvider(errors: readonly Error[]): void { assert.deepEqual(errors, [], errors.map(error => error.message).join("; ")); }
async function localCodex(): Promise<string> {
  const directories = [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const directory of [...new Set(directories.filter(path => isAbsolute(path)))]) {
    const entry = join(directory, "codex");
    try { await lstat(entry); } catch (error: unknown) { if (code(error) === "ENOENT") continue; throw error; }
    assert.ok((await stat(entry)).isFile(), "local Codex entry must be a file"); await access(entry, constants.X_OK); return realpath(entry);
  }
  throw new Error("real Session acceptance requires an installed Codex; absence is a failure, not a skipped pass");
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const buffers: Buffer[] = []; let length = 0;
  for await (const raw of request) {
    const value: unknown = raw; assert.ok(Buffer.isBuffer(value)); length += value.length;
    assert.ok(length <= MAX_HTTP_BYTES, "provider input exceeds the acceptance budget"); buffers.push(value);
  }
  return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers))), "Responses body");
}
function sse(response: ServerResponse, index: number): void {
  const answer = ANSWERS[index]; assert.ok(answer);
  const content = { type: "output_text", text: answer, annotations: [], logprobs: [] };
  const item = { id: `msg_session_${index}`, type: "message", role: "assistant", status: "completed", content: [content] };
  const base = { id: `resp_session_${index}`, object: "response", created_at: 1_791_523_200, status: "in_progress",
    error: null, incomplete_details: null, model: MODEL, output: [], store: false };
  let sequence = 0;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Request-Id": `local-session-${index}` });
  function event(type: string, fields: Record<string, unknown>): void {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  }
  event("response.created", { response: base });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...content, text: "" } });
  event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: answer, logprobs: [] });
  event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: answer, logprobs: [] });
  event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: content });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 8,
    total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
}
/** Run real formal chat inputs in sequence using committed Run events as barriers. */
async function invoke(args: readonly string[], prompts: readonly string[], cwd: string, home: string, temporary: string): Promise<{ code: number | null; signal: string | null; output: readonly Record<string, unknown>[]; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: temporary, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  let partial = "", stderr = "", bytes = 0, ended = 0, sent = 0;
  const output: Record<string, unknown>[] = [];
  let expiration: string | null = null;
  const timer = setTimeout(() => { expiration = "deadline"; child.kill("SIGINT"); }, 50000);
  const emergency = setTimeout(() => child.kill("SIGKILL"), 60000);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const completed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void completed.catch(() => {});
  child.stdout.on("data", (value: string) => {
    bytes += Buffer.byteLength(value); if (bytes > MAX_CLI_BYTES) { expiration = "output budget"; child.kill("SIGINT"); return; }
    partial += value;
    for (;;) {
      const end = partial.indexOf("\n"); if (end < 0) break;
      const line = partial.slice(0, end); partial = partial.slice(end + 1); if (!line.trim()) continue;
      const entry = record(JSON.parse(line), "CLI output"); output.push(entry);
      const event = entry.type === "event" ? record(entry.event, "Session event") : entry;
      if (event.type === "session.created" || entry.type === "session") {
        if (sent === 0) { child.stdin.write(prompts[sent++] + "\n"); }
      }
      if (event.type === "run.ended") {
        ++ended;
        if (sent < prompts.length) child.stdin.write(prompts[sent++] + "\n");
        else child.stdin.write(":quit\n");
      }
    }
  });
  child.stderr.on("data", (value: string) => { stderr += value; });
  try {
    // stdin is buffered before initialization; this also works for --session, which emits no created event.
    child.stdin.write(prompts[sent++] + "\n");
    const result = await completed;
    assert.equal(expiration, null, "chat exceeded its " + expiration);
    assert.equal(ended, prompts.length, "formal chat did not commit every expected Run");
    return { ...result, output, stderr };
  } finally {
    clearTimeout(timer); clearTimeout(emergency);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGINT"); await completed; }
  }
}
test("real Codex preserves public history across two turns and a new formal chat process using only a local deterministic provider", { timeout: 120000 }, async t => {
  assert.notEqual(process.platform, "win32", "current real acceptance requires POSIX control");
  assert.ok((await stat(cli)).isFile(), "build the formal chat before acceptance");
  const executable = await localCodex(), root = await mkdtemp(join(tmpdir(), "harness-real-codex-session-"));
  const home = join(root, "home"), workspace = join(root, "workspace"), temporary = join(root, "temporary"), data = join(root, "data"), manifest = join(root, "manifest.json");
  const sockets = new Set<Socket>(), requests: Record<string, unknown>[] = [], errors: Error[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, `Bearer ${DUMMY_KEY}`);
      const input = await body(request), index = requests.length; requests.push(input);
      assert.ok(index < 3, "unexpected retry or extra model request"); assert.equal(input.model, MODEL); assert.equal(input.stream, true);
      assert.ok(Array.isArray(input.input), "Responses input items are missing");
      assert.ok(!input.input.some(raw => ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(String(record(raw).type))), "text acceptance invoked a tool");
      const texts = input.input.flatMap(raw => {
        const item = record(raw);
        return item.role === "user" && Array.isArray(item.content) ? item.content.map(content => record(content).text).filter((value): value is string => typeof value === "string") : [];
      });
      const publicText = texts.find(value => value.startsWith("HarnessGateway public conversation context."));
      assert.ok(publicText, "real Harness did not send public context to its provider");
      const context = record(JSON.parse(publicText.slice(publicText.indexOf("\n") + 1)), "public context");
      assert.equal(context.continuity, "public_context_rehydrate"); assert.equal(record(context.currentInput).text, PROMPTS[index]);
      assert.ok(Array.isArray(context.history)); assert.equal(context.history.length, index, "public history was truncated or future inputs leaked");
      for (let prior = 0; prior < index; ++prior) {
        const entry = record(context.history[prior]); assert.equal(record(entry.user).text, PROMPTS[prior]); assert.equal(record(entry.assistant).text, ANSWERS[prior]); assert.equal(entry.outcome, "completed");
      }
      sse(response, index);
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error : new Error("local provider failed"));
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { type: "fixture_validation_error", message: "local acceptance rejected request" } }));
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_request, socket) => { errors.push(new Error("unexpected WebSocket upgrade")); socket.destroy(); });
  let listening = false;
  try {
    await mkdir(home); await mkdir(workspace); await mkdir(temporary);
    for (const directory of ["config", "data", "state", "cache", "codex", "claude", "opencode"]) await mkdir(join(home, directory));
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); listening = true; resolve(); }); });
    const address = server.address(); assert.ok(address !== null && typeof address !== "string");
    await writeFile(join(home, "codex", "config.toml"), [
      `model = "${MODEL}"`, 'model_provider = "fixture"', 'web_search = "disabled"', '[features]',
      'shell_tool = false', 'unified_exec = false', 'shell_snapshot = false', 'skill_mcp_dependency_install = false',
      '[model_providers.fixture]', 'name = "HarnessGateway local Session fixture"', `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'wire_api = "responses"', `env_key = "${KEY_NAME}"`, 'requires_openai_auth = false', 'supports_websockets = false',
      'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 5000', "",
    ].join("\n"));
    const source = { repository: "openai/codex", revision: "local-real-session", upstreamId: "codex", url: "https://github.com/openai/codex" };
    await writeFile(manifest, JSON.stringify({ version: 2, definitions: [{ id: "custom-session-codex", name: "Real local Session Codex", aliases: [], binaryNames: [], configHints: [],
      controls: [{ id: "custom-session-codex-control", protocol: "codex-app-server", executableNames: ["codex"], args: ["app-server", "--listen", "stdio://"],
        env: { [KEY_NAME]: DUMMY_KEY }, package: null, distribution: null, requiredExecutables: [], source }] }], overrides: { "custom-session-codex-control": { executable } } }));
    const options = ["--data-dir", data, "--cwd", workspace, "--config-home", home, "--manifest", manifest, "--json"];
    const first = await invoke([...options, "--harness", "custom-session-codex"], PROMPTS.slice(0, 2), workspace, home, temporary);
    assertProvider(errors); assert.equal(first.code, 0, first.stderr); assert.equal(first.signal, null);
    let id: SessionId;
    const reader = new SqliteSessionReader(data);
    try {
      const list = reader.list(); assert.equal(list.length, 1); const state = list[0]!; id = state.id;
      assert.equal(state.status, "open"); assert.equal(state.runs.length, 2); assert.ok(state.runs.every(run => run.status === "completed" && run.cleanup?.closed));
      assert.deepEqual(state.messages.map(message => message.text), [PROMPTS[0], ANSWERS[0], PROMPTS[1], ANSWERS[1]]);
      assert.ok(!JSON.stringify(state).includes(DUMMY_KEY), "synthetic Provider key was persisted in public state");
    } finally { reader.close(); }
    const reopened = await invoke([...options, "--session", id], PROMPTS.slice(2), workspace, home, temporary);
    assertProvider(errors); assert.equal(reopened.code, 0, reopened.stderr); assert.equal(reopened.signal, null);
    const finalReader = new SqliteSessionReader(data);
    try {
      const state = finalReader.get(id);
      assert.equal(state.runs.length, 3); assert.equal(state.messages.at(-1)?.text, ANSWERS[2]);
      assert.deepEqual(state.runs[2]?.sourceRunIds, state.runs.slice(0, 2).map(run => run.id));
      assert.ok(state.runs.every(run => run.status === "completed" && run.cleanup?.closed));
    } finally { finalReader.close(); }
    assert.equal(requests.length, 3, "acceptance expected exactly one model request per public Turn");
    assert.deepEqual(await readdir(temporary), [], "owned temporary invocation directories remain");
    assert.deepEqual(await readdir(workspace), [], "text-only acceptance changed its workspace");
    t.diagnostic(JSON.stringify({ realHarness: "codex", executable, publicSession: id, turns: 3, processReopen: true,
      provider: "local deterministic HTTP Responses SSE", model: MODEL, requests: requests.length, cleanup: "closed", realModelValidated: false,
      credentials: "synthetic private key only", continuity: "public_context_rehydrate" }));
  } finally {
    for (const socket of sockets) socket.destroy();
    if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
