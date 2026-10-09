import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const protocol = process.argv[2];
const name = process.argv[3] ?? "peer";
const scenario = process.argv[4] ?? "basic";
const nativeId = `native-${protocol}-${process.pid}`;
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
      ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name, version: "1.0" } }
      : { userAgent: `${name}/1.0` }); return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "session/new") { response(message.id, { sessionId: nativeId }); return; }
  if (message.method === "thread/start") {
    if (!initialized) throw new Error("Codex thread was opened before initialized");
    notify("thread/started", { thread: { id: nativeId } }); response(message.id, { thread: { id: nativeId } }); return;
  }
  if (message.method === "session/prompt" || message.method === "turn/start") {
    const prompt = protocol === "acp-v1" ? message.params.prompt[0].text : message.params.input[0].text;
    const newline = prompt.indexOf("\n");
    const context = JSON.parse(prompt.slice(newline + 1));
    if (context.schemaVersion !== 1 || context.continuity !== "public_context_rehydrate" || !Array.isArray(context.history))
      throw new Error("gateway did not provide its complete structured public context");
    const expected = process.env.FIXTURE_EXPECT_HISTORY ? JSON.parse(process.env.FIXTURE_EXPECT_HISTORY) : {};
    const current = context.currentInput.text;
    const prior = context.history.map(item => item.user.text);
    if (Object.hasOwn(expected, current) && JSON.stringify(prior) !== JSON.stringify(expected[current]))
      throw new Error(`public history mismatch for ${current}: ${JSON.stringify(prior)}`);
    trace({ kind: "prompt", prompt, context });
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
