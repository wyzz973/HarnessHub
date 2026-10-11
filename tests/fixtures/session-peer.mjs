import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const protocol = process.argv[2];
const name = process.argv[3] ?? "peer";
const scenario = process.argv[4] ?? "basic";
let nativeId = `native-${protocol}-${process.pid}`, nativeHistory = [];
const statePath = () => join(process.cwd(), "fixture-native-" + createHash("sha256").update(nativeId).digest("hex") + ".json");
let initialized = false, counter = 0, active = null;
function trace(value) {
  if (process.env.FIXTURE_TRACE) appendFileSync(process.env.FIXTURE_TRACE, `${JSON.stringify({ peer: name, pid: process.pid, nativeId, ...value })}\n`);
}
trace({ kind: "spawn", cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME,
  temporary: process.env.TMPDIR, hostSecret: process.env.TEST_HOST_SECRET ?? null });
process.on("exit", () => trace({ kind: "exit" }));
function emit(value) { process.stdout.write(JSON.stringify({ ...(protocol === "acp-v1" ? { jsonrpc: "2.0" } : {}), ...value }) + "\n"); }
function response(id, result) { emit({ id, result }); }
function notify(method, params) { emit({ method, params }); }
function text(value) {
  if (protocol === "acp-v1") notify("session/update", { sessionId: nativeId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } });
  else notify("item/agentMessage/delta", { threadId: nativeId, turnId: active.turnId, itemId: `message-${counter}`, delta: value });
}
function finish(cancelled = false) {
  if (protocol === "acp-v1") response(active.id, { stopReason: cancelled ? "cancelled" : "end_turn" });
  else notify("turn/completed", { threadId: nativeId, turn: { id: active.turnId, status: cancelled ? "interrupted" : "completed" } });
  trace({ kind: "settled", cancelled }); active = null;
}
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  trace({ kind: "wire", message });
  if (message.method === "initialize") {
    if (scenario === "initialize-failure") { emit({ id: message.id, error: { code: -32000, message: "fixture preparation rejected" } }); return; }
    response(message.id, protocol === "acp-v1"
      ? { protocolVersion: 1, agentCapabilities: scenario === "attachments" ? { promptCapabilities: { image: true, embeddedContext: true } } : {}, authMethods: [], agentInfo: { name, version: "1.0" } }
      : { userAgent: `${name}/1.0` }); return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "session/new") { response(message.id, { sessionId: nativeId }); return; }
  if (message.method === "thread/start") {
    if (!initialized) throw new Error("Codex thread was opened before initialized");
    notify("thread/started", { thread: { id: nativeId } }); response(message.id, { thread: { id: nativeId } }); return;
  }
  if (message.method === "thread/resume") {
    nativeId = message.params.threadId;
    if (!existsSync(statePath())) { emit({ id: message.id, error: { code: -32001, message: "native state is missing" } }); return; }
    nativeHistory = JSON.parse(readFileSync(statePath(), "utf8"));
    notify("thread/started", { thread: { id: nativeId } }); response(message.id, { thread: { id: nativeId } }); return;
  }
  if (message.method === "session/prompt" || message.method === "turn/start") {
    const prompt = protocol === "acp-v1" ? message.params.prompt[0].text : message.params.input[0].text;
    const newline = prompt.indexOf("\n");
    const context = prompt.startsWith("HarnessGateway public conversation context.") ? JSON.parse(prompt.slice(newline + 1)) : { schemaVersion: 1, continuity: "public_context_rehydrate", history: [], currentInput: { text: prompt } };
    if (context.schemaVersion !== 1 || context.continuity !== "public_context_rehydrate" || !Array.isArray(context.history))
      throw new Error("gateway did not provide its complete structured public context");
    const expected = process.env.FIXTURE_EXPECT_HISTORY ? JSON.parse(process.env.FIXTURE_EXPECT_HISTORY) : {};
    const current = context.currentInput.text;
    const prior = [...nativeHistory, ...context.history.map(item => item.user.text)];
    if (Object.hasOwn(expected, current) && JSON.stringify(prior) !== JSON.stringify(expected[current]))
      throw new Error(`public history mismatch for ${current}: ${JSON.stringify(prior)}`);
    trace({ kind: "prompt", prompt, context, attachments: protocol === "acp-v1" ? message.params.prompt.slice(1) : message.params.input.slice(1) });
    if (protocol !== "acp-v1") { nativeHistory = [...prior, current]; writeFileSync(statePath(), JSON.stringify(nativeHistory)); }
    active = { id: message.id, turnId: `turn-${process.pid}-${++counter}` };
    if (protocol !== "acp-v1") {
      notify("turn/started", { threadId: nativeId, turn: { id: active.turnId, status: "inProgress" } });
      response(message.id, { turn: { id: active.turnId, status: "inProgress" } });
    }
    text(`${name}:${current}`);
    if (scenario !== "hold") finish();
    return;
  }
  if (message.method === "session/cancel" || message.method === "turn/interrupt") {
    if (message.method === "turn/interrupt") response(message.id, {});
    if (active) finish(true);
  }
});
