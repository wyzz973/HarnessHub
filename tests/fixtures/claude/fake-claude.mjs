#!/usr/bin/env node
// A stand-in for the `claude` executable for the tests that walk the page against the real Gateway (tests/browser/relay-fixture.ts): it speaks the Agent SDK's
// stream-json as Claude Code 2.1.325 does (tests/fixtures/claude/approval-turn.ndjson is a real session of it) and answers every prompt with FAKE_REPLY. It keeps
// the session's transcript where Claude Code does ($HOME/.claude/projects/<cwd>/<id>.jsonl), so a later process resumes it. FAKE_TRACE, when set, receives each
// prompt as `session/prompt {sessionId, prompt}` (what the tests' helpers read). FAKE_COMMANDS is the commands it lists; an interrupt ends the turn running.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) { process.stdout.write("2.1.325 (Claude Code)\n"); process.exit(0); }
// The SDK writes its flags as `--name=value` (2.1.325); `--name value` is read too.
const arg = name => { const joined = process.argv.find(value => value.startsWith(name + "=")); if (joined !== undefined) return joined.slice(name.length + 1); const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const session = arg("--resume") ?? arg("--session-id") ?? randomUUID();
const cwd = process.cwd(), config = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
const folder = join(config, "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-")), transcript = join(folder, session + ".jsonl");
mkdirSync(folder, { recursive: true });
let parent = arg("--resume-session-at") ?? null;
if (parent === null && existsSync(transcript)) parent = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).at(-1)?.uuid ?? null;
const commands = JSON.parse(process.env.FAKE_COMMANDS ?? "[]"), reply = process.env.FAKE_REPLY ?? "ok";
const CAPABILITIES = ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "interrupt_send_now_v1", "interrupt_requeue_taken_v1", "msg_lifecycle_v1", "request_marker_lists_v1"];
const MODELS = [{ value: "default", resolvedModel: "claude-test", displayName: "Default (recommended)", description: "The test model", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"],
  supportsAdaptiveThinking: true, supportsFastMode: false, supportsAutoMode: true, supportsThinkingOff: false }];
const out = message => process.stdout.write(JSON.stringify(message) + "\n");
const keep = row => appendFileSync(transcript, JSON.stringify({ ...row, parentUuid: parent, sessionId: session, cwd, timestamp: new Date().toISOString() }) + "\n");
const stamp = () => ({ session_id: session, uuid: randomUUID() });
const queue = [];
let begun = false, running = null;

function start(message) {
  const uuid = typeof message.uuid === "string" ? message.uuid : randomUUID(), content = message.message?.content;
  const text = typeof content === "string" ? content : (Array.isArray(content) ? content : []).filter(block => block?.type === "text").map(block => block.text).join("\n");
  if (process.env.FAKE_TRACE) appendFileSync(process.env.FAKE_TRACE, JSON.stringify({ method: "session/prompt", params: { sessionId: session, prompt: [{ type: "text", text }] } }) + "\n");
  keep({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } }); parent = uuid;
  out({ type: "system", subtype: "session_state_changed", state: "running", ...stamp() });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "queued", ...stamp() });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "started", ...stamp() });
  if (!begun) {
    begun = true;
    out({ type: "system", subtype: "init", cwd, tools: ["Read", "Write", "Bash"], mcp_servers: [], model: "claude-test", permissionMode: "default", slash_commands: commands.map(command => command.name),
      apiKeySource: "none", claude_code_version: "2.1.325", output_style: "default", agents: [], skills: [], plugins: [], capabilities: CAPABILITIES, ...stamp() });
  }
  running = { uuid };
  if (process.env.FAKE_HOLD && new RegExp(process.env.FAKE_HOLD, "u").test(text)) return;
  finish(true);
}
function finish(answered) {
  const { uuid } = running;
  if (answered) {
    const answer = randomUUID(), body = { role: "assistant", content: [{ type: "text", text: reply }] };
    out({ type: "assistant", message: { model: "claude-test", id: "msg_" + randomUUID().replaceAll("-", "").slice(0, 24), type: "message", ...body, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
      parent_tool_use_id: null, session_id: session, uuid: answer });
    keep({ type: "assistant", uuid: answer, message: body }); parent = answer;
    out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: reply, stop_reason: "end_turn", total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { "claude-test": { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 } }, ...stamp() });
  } else out({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 1, duration_api_ms: 0, num_turns: 1, stop_reason: null, terminal_reason: "aborted_streaming",
    errors: [], total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, ...stamp() });
  out({ type: "command_lifecycle", command_uuid: uuid, state: answered ? "completed" : "cancelled", ...stamp() });
  out({ type: "system", subtype: "session_state_changed", state: "idle", ...stamp() });
  running = null;
  const next = queue.shift();
  if (next) start(next);
}
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  if (!line.trim()) return;
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type === "control_request") {
    const subtype = message.request?.subtype, answer = response => out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    if (subtype === "initialize") return answer({ commands: commands.map(command => ({ argumentHint: "", ...command })), agents: [], output_style: "default", available_output_styles: ["default"], models: MODELS,
      account: {}, capabilities: CAPABILITIES, claude_code_version: "2.1.325", current_permission_mode: "default", session_state: "idle" });
    answer({});
    if (subtype === "interrupt" && running !== null) finish(false);
    return;
  }
  if (message.type === "user") { if (running === null) start(message); else queue.push(message); }
});
input.on("close", () => process.exit(0));
