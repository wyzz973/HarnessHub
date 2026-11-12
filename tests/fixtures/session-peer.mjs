import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

// This peer is copied into fixture installations (web-management.test.ts), so it imports nothing of its own. The Gateway's
// relay packet (ADR-055 §5.5) read from its layout, the way tests/fixtures/relay-packet.ts reads it: whether the prompt
// carries one, the user's current words after its end line, the earlier words it quotes by turn, and the history a branch
// or an import started from. A prompt without a packet is its own current input.
function readRelayPrompt(prompt) {
  const title = /^〔HarnessHub (交接单|交接更新|handoff|handoff update) (relay-[0-9a-z]{20})〕$/mu.exec(prompt);
  if (!title) return { packet: false, currentInput: { text: prompt }, history: [], branchedHistory: [] };
  const id = title[2], start = title.index + title[0].length;
  const ends = [`〔记录结束 · ${id}。以下是用户现在的指令（原话）〕`, `〔更新结束 · ${id}。以下是用户现在的指令（原话）〕`, `〔End of record ${id}. The user's current instruction follows, verbatim.〕`, `〔End of update ${id}. The user's current instruction follows, verbatim.〕`];
  const [end, endLine] = ends.map(line => [prompt.indexOf("\n" + line + "\n", start), line]).filter(([at]) => at >= 0).sort((a, b) => a[0] - b[0])[0] ?? [-1, ""];
  if (end < 0) return { packet: false, currentInput: { text: prompt }, history: [], branchedHistory: [] };
  const lines = prompt.slice(start + 1, end).split("\n"), words = new Map(), replies = new Map();
  const fenced = at => { const open = /^(`{3,})text$/u.exec(lines[at] ?? ""); if (!open) return null; const body = []; for (let index = at + 1; index < lines.length; index++) { if (lines[index] === open[1]) return { text: body.join("\n"), next: index + 1 }; body.push(lines[index]); } return null; };
  let unit = null;
  for (let index = 0; index < lines.length; index++) {
    const heading = /^### (来源)?第 (\d+) 轮 · |^### (Source t|T)urn (\d+) · /u.exec(lines[index]);
    if (heading) { unit = { origin: heading[1] === "来源" || heading[3] === "Source t", turn: Number(heading[2] ?? heading[4]) }; continue; }
    const block = unit === null ? null : fenced(index + 1);
    if (block && /^(?:用户原话：|The user's words:)$/u.test(lines[index])) { words.set((unit.origin ? "origin:" : "run:") + unit.turn, block.text); index = block.next - 1; }
    else if (block && unit.origin && /(?: 的回复：|'s reply:)$/u.test(lines[index])) { replies.set(unit.turn, block.text); index = block.next - 1; }
  }
  const turns = [...new Set([...[...words.keys()].filter(key => key.startsWith("origin:")).map(key => Number(key.slice(7))), ...replies.keys()])].sort((a, b) => a - b);
  // The words follow the end line after one LF (the renderer's text) or a blank line (a Driver's singleText, G068 phase two).
  const after = end + endLine.length + 2;
  return { packet: true, currentInput: { text: prompt.slice(prompt.startsWith("\n", after) ? after + 1 : after) },
    history: [...words.entries()].filter(([key]) => key.startsWith("run:")).map(([key, text]) => ({ turn: Number(key.slice(4)), user: { text } })).sort((a, b) => a.turn - b.turn),
    branchedHistory: turns.flatMap(turn => [...(words.has("origin:" + turn) ? [{ role: "user", text: words.get("origin:" + turn) }] : []), ...(replies.has(turn) ? [{ role: "assistant", text: replies.get(turn) }] : [])]) };
}

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
  if (message.method === "skills/list") { response(message.id, { data: [{ cwd: process.cwd(), skills: [{ name: "web-skill", description: "Web fixture skill", path: "/skills/web-skill/SKILL.md", scope: "user", enabled: true }], errors: [] }] }); return; }
  if (message.method === "mcpServerStatus/list") { response(message.id, { data: [{ name: "web-mcp", runtimeStatus: null, authStatus: "unsupported", tools: { one: {} }, toolsError: null }], nextCursor: null }); return; }
  if (message.method === "plugin/installed") { response(message.id, { marketplaces: [], marketplaceLoadErrors: [] }); return; }
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
    // The Gateway's relay packet (ADR-055 §5), read from its layout; a prompt without one is the input as typed.
    const context = readRelayPrompt(prompt);
    if (!Array.isArray(context.history) || typeof context.currentInput?.text !== "string")
      throw new Error("gateway did not provide a readable relay packet");
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
    // A program that logs a private path and credentials on stderr while it works (diagnostics must never carry them).
    if (current.includes("noisy")) process.stderr.write("open /Users/someone/private/notes.txt failed\nOPENAI_API_KEY=sk-fixtureSECRET1234567890abcd\nAuthorization: Bearer fixture.token.value123\nINFO Prompt on session native: " + current + "\n");
    if (scenario === "interleaved" && protocol === "acp-v1") {
      // A Turn that says something, runs a command, reads a file and then sums up: each in the order it happened, as separate items of the Turn.
      const update = value => notify("session/update", { sessionId: nativeId, update: value });
      text("先看一下目录。");
      update({ sessionUpdate: "tool_call", toolCallId: "interleaved-run", title: "ls -la", kind: "execute", status: "in_progress", rawInput: { command: "ls -la" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "interleaved-run", status: "completed", rawOutput: { output: "README.md\n" } });
      update({ sessionUpdate: "tool_call", toolCallId: "interleaved-read", title: "Read README.md", kind: "read", status: "in_progress", locations: [{ path: "README.md" }], rawInput: { path: "README.md" } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "interleaved-read", status: "completed" });
      text(`总结：${current}`);
    } else text(`${name}:${current}`);
    if (scenario !== "hold") finish();
    return;
  }
  if (message.method === "session/cancel" || message.method === "turn/interrupt") {
    if (message.method === "turn/interrupt") response(message.id, {});
    if (active) finish(true);
    return;
  }
  // A method this peer does not know is refused, as a real server refuses it; a request left unanswered would time out.
  if (message.id !== undefined && typeof message.method === "string") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }) + "\n");
});
