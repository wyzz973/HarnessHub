import { createInterface } from "node:readline";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const protocol = process.argv[2], scenario = process.argv[3] ?? "basic";
if (process.env.FIXTURE_PID) writeFileSync(process.env.FIXTURE_PID, String(process.pid));
if (scenario === "resist") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
if (scenario === "descendant") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  if (process.env.FIXTURE_CHILD_PID) writeFileSync(process.env.FIXTURE_CHILD_PID, String(child.pid));
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { child.once("exit", () => process.exit(0)); child.kill("SIGTERM"); });
}
const lines = createInterface({ input: process.stdin });
let promptId = null, turn = 0, initialized = false, pendingPermission = false;
let resumedThread = false;
let selectedModel = "native-model-a", thinking = "low", fast = "off";
function nativeConfiguration() { return [
 { id:"native-model",category:"model",type:"select",currentValue:selectedModel,options:[{value:"native-model-a",name:"Native A"},{value:"native-model-b",name:"Native B"}] },
 { id:"native-thinking",name:"Native effort",category:"thought_level",type:"select",currentValue:thinking,options:[{value:"low",name:"Low"},{value:"max",name:"Max"}] },
 { id:"native-fast",name:"Native fast",type:"select",currentValue:fast,options:[{value:"off",name:"Off"},{value:"on",name:"On"}] }
]; }

// Hermes lists `<provider>:<model>` choices from its curated catalogue (unstable session model state).
function hermesModels() { return { currentModelId: "deepseek:deepseek-v4-pro", availableModels: [{ modelId: "deepseek:deepseek-v4-pro", name: "deepseek-v4-pro" }, { modelId: "deepseek:deepseek-v4-flash", name: "deepseek-v4-flash" }] }; }
// The OpenClaw bridge's session presentation: six select options and the same thinking levels again as modes.
const openclawLevels = ["off", "minimal", "low", "medium", "high", "adaptive"].map(value => ({ value, name: value }));
function openclawPresentation() { return { configOptions: [
  { id: "thought_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "adaptive", options: openclawLevels },
  ...[["fast_mode", ["off", "on"]], ["verbose_level", ["off", "on", "full"]], ["reasoning_level", ["off", "on", "stream"]], ["response_usage", ["off", "tokens", "full"]], ["elevated_level", ["off", "on", "ask", "full"]]]
    .map(([id, values]) => ({ id, name: id, type: "select", currentValue: "off", options: values.map(value => ({ value, name: value })) })),
], modes: { currentModeId: "adaptive", availableModes: openclawLevels.map(row => ({ id: row.value, name: row.name })) } }; }
function emit(message) {
  const envelope = protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message;
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  if (scenario === "split") {
    for (let i = 0; i < bytes.length; i += 3) process.stdout.write(bytes.subarray(i, i + 3));
  } else process.stdout.write(bytes);
}
function answer(id, result) { emit({ id, result }); }
function emitAtomicBatch(messages) {
  // Submit both negative frames in one small write, rather than allowing a
  // legitimate owner to begin closing between two separate writes.
  process.stdout.write(messages.map(message => JSON.stringify(protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message) + "\n").join(""));
}
function notification(method, params) { emit({ method, params }); }
function acpOutput(sessionId = "session-fixture") {
  if(scenario==="native-experience") {
    notification("session/update",{sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"Observed fixture thinking"}}});
    notification("session/update",{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"native-tool",title:"Read fixture",status:"in_progress"}});
    notification("session/update",{sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:"native-tool",status:"completed"}});
  }
  if (scenario === "chunks") {
    for (const value of ["first ", "second"]) notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } });
    return;
  }
  notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好 fixture" } } });
}
function codexOutput(turnId = `turn-${turn}`, threadId = "thread-fixture") {
  if (scenario === "chunks") {
    for (const value of ["first ", "second"]) notification("item/agentMessage/delta", { threadId, turnId, itemId: `message-${turn}`, delta: value });
    return;
  }
  notification("item/agentMessage/delta", { threadId, turnId, itemId: `message-${turn}`, delta: "你好 fixture" });
}
function finish(cancelled = false) {
  if (protocol === "acp-v1") answer(promptId, { stopReason: cancelled ? "cancelled" : (scenario === "refusal" ? "refusal" : "end_turn") });
  else notification("turn/completed", { threadId: "thread-fixture", turn: { id: `turn-${turn}`, status: cancelled ? "interrupted" : (scenario === "failed" ? "failed" : "completed") } });
}
lines.on("line", line => {
  const message = JSON.parse(line);
  if (process.env.FIXTURE_TRACE) appendFileSync(process.env.FIXTURE_TRACE, `${JSON.stringify(message)}\n`);
  if (message.method === "initialize") {
    if (scenario === "gateway-auth-failure") { process.stderr.write("unauthorized: gateway token missing\nprivate synthetic credential: never-public\n"); process.exit(1); }
    if (scenario === "invalid-native-config") { process.stderr.write("Harness config is invalid\nprivate synthetic credential: never-public\nUnrecognized key\n"); process.exit(1); }
    if (scenario === "timeout" || scenario === "resist") return;
    if (scenario === "bad-json") { process.stdout.write("not-json\n"); return; }
    if (scenario === "bad-utf8") { process.stdout.write(Buffer.from([0xff, 0x0a])); return; }
    if (scenario === "huge") { process.stdout.write(`${" ".repeat(100000)}\n`); return; }
    if (scenario === "half") { process.stdout.write('{"id":'); process.exit(0); }
    if (scenario === "orphan") {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["ignore", "inherit", "inherit"] });
      if (process.env.FIXTURE_CHILD_PID) writeFileSync(process.env.FIXTURE_CHILD_PID, String(child.pid));
      process.exit(0);
    }
    if (scenario === "unknown-response") { answer(999999, {}); return; }
    if (scenario === "invalid-response") { emit({ id: message.id, result: {}, error: { code: -1, message: "wrong" } }); return; }
    if (scenario === "remote-error") { emit({ id: message.id, error: { code: -32001, message: "test remote error" } }); return; }
    if (scenario === "stderr") process.stderr.write("diagnostic".repeat(100000));
    const result = protocol === "acp-v1"
      ? { protocolVersion: scenario === "version" ? 2 : 1, agentCapabilities: { loadSession: ["native-resume", "resume-fails", "resume-wrong-identity", "load-trailing-replay", "native-config", "openclaw-settings", "session-list", "hermes"].includes(scenario), ...(scenario === "hermes" ? { sessionCapabilities: { resume: {}, list: {}, fork: {} }, promptCapabilities: { image: true } } : {}), ...(scenario === "session-list" ? { sessionCapabilities: { list: {} } } : {}), ...(scenario === "attachments" || scenario === "openclaw-settings" ? { promptCapabilities: { image: true, audio: true, embeddedContext: true } } : {}), ...(scenario === "forkable" ? { sessionCapabilities: { fork: {} } } : {}) }, authMethods: [{ id: "fixture-login", name: "Fixture Login" }], agentInfo: { name: "fixture", version: "1.0" } }
      : { userAgent: "fixture-codex/1.0", codexHome: process.cwd(), platformFamily: "unix", platformOs: process.platform };
    answer(message.id, result);
    if (scenario === "flood") {
      let remaining = 10000;
      const frame = `${JSON.stringify({ jsonrpc: "2.0", method: "fixture/flood", params: { text: "x".repeat(2048) } })}\n`;
      function drain() {
        while (remaining-- > 0) if (!process.stdout.write(frame)) { process.stdout.once("drain", drain); return; }
      }
      drain();
    }
    if (scenario === "duplicate-response") answer(message.id, result);
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "config/read") { answer(message.id, { config: { model: "native-model-a", privateCredential: "synthetic-never-public", ...(["permissions-settings", "ignore-permissions"].includes(scenario) ? { approval_policy: "never", sandbox_mode: "danger-full-access" } : {}) } }); return; }
  if (message.method === "account/read") { answer(message.id, { account: { type: "chatgpt", email: "private-account@example.invalid" }, requiresOpenaiAuth: true }); return; }
  if (message.method === "skills/list" && scenario === "no-skills") { emit({ id: message.id, error: { code: -32601, message: "Method not found" } }); return; }
  if (message.method === "skills/list") {
    const skills = scenario === "skills" ? [{ name: "review-helper", description: "Reviews code\nin depth", path: "/skills/review-helper/SKILL.md", scope: "user", enabled: true }, { name: "dormant", description: "Disabled skill", path: "/skills/dormant/SKILL.md", scope: "repo", enabled: false }, { name: "bad name", description: "", path: "relative", enabled: true }] : [];
    answer(message.id, { data: [{ cwd: message.params.cwds?.[0] ?? "/", skills, errors: [] }] }); return;
  }
  if (message.method === "mcpServerStatus/list") {
    answer(message.id, { data: scenario === "skills" ? [{ name: "docs", runtimeStatus: null, authStatus: "unsupported", tools: { search: {}, read: {} }, toolsError: null }, { name: "remote", runtimeStatus: "failed", authStatus: "notLoggedIn", tools: {}, toolsError: "login required" }] : [], nextCursor: null }); return;
  }
  if (message.method === "plugin/installed") {
    answer(message.id, { marketplaces: scenario === "skills" ? [{ name: "openai-curated", plugins: [{ name: "github", installed: true, enabled: true, localVersion: "1.2.0" }, { name: "not-here", installed: false, enabled: false }] }] : [], marketplaceLoadErrors: [] }); return;
  }
  if (message.method === "model/list") { answer(message.id, { data: ["native-model-a", "native-model-b"].map(model => ({ model, displayName: model, ...(scenario === "attachments" ? { inputModalities: model === "native-model-a" ? ["text", "image", "audio"] : ["text"] } : {}) })), nextCursor: null }); return; }
  if (scenario === "hermes" && message.method === "session/new") { answer(message.id, { sessionId: "session-fixture", models: hermesModels() }); return; }
  if (message.method === "session/new" && scenario === "attachments") {
    answer(message.id, { sessionId: "session-fixture", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "native/model-a", options: [{ value: "native/model-a", name: "Model A" }, { value: "native/model-b", name: "Model B" }] }] }); return;
  }
  if (message.method === "session/set_config_option" && scenario === "attachments") {
    answer(message.id, { configOptions: [{ id: "model", category: "model", type: "select", currentValue: message.params.value, options: [{ value: "native/model-a", name: "Model A" }, { value: "native/model-b", name: "Model B" }] }] }); return;
  }
  if (message.method === "session/new" && (scenario === "native-experience" || scenario === "native-config")) {
    notification("session/update",{sessionId:"session-fixture",update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"native-help",description:"Native fixture help"},...(scenario==="native-config"?[{name:"native-fast",description:"Turns fast mode on or off"}]:[])]}});
    answer(message.id,{sessionId:"session-fixture",configOptions:nativeConfiguration()});return;
  }
  // An agent's own session catalogue (two pages) and a load that replays the history before answering.
  if (scenario === "session-list" && message.method === "session/list") {
    const here = message.params.cwd;
    if (message.params.cursor === "p2") { answer(message.id, { sessions: [{ sessionId: "native-b", cwd: here, title: null, updatedAt: "2026-10-01T09:00:00Z" }], nextCursor: null }); return; }
    answer(message.id, { sessions: [{ sessionId: "native-a", cwd: here, title: "Earlier  work", updatedAt: "2026-10-01T10:00:00Z" }, { sessionId: "native-x", cwd: "/elsewhere", title: "Elsewhere" }], nextCursor: "p2" }); return;
  }
  if (scenario === "session-list" && message.method === "session/load") {
    const sessionId = message.params.sessionId, chunk = (kind, text) => notification("session/update", { sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } });
    chunk("user_message_chunk", "first "); chunk("user_message_chunk", "question"); chunk("agent_thought_chunk", "thinking is not history"); chunk("agent_message_chunk", "first answer");
    notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "old tool", status: "completed" } });
    chunk("user_message_chunk", "second question"); chunk("agent_message_chunk", "second answer");
    answer(message.id, {}); return;
  }
  // Like many agents, the mode change is acknowledged without echoing a current_mode_update.
  if (message.method === "session/set_mode" && scenario === "openclaw-settings") { answer(message.id, {}); return; }
  if ((message.method === "session/new" || message.method === "session/load") && scenario === "openclaw-settings") {
    answer(message.id, { ...(message.method === "session/new" ? { sessionId: "session-fixture" } : {}), ...openclawPresentation() }); return;
  }
  // A restored native-config session reports its options; a new process starts from the defaults until the client applies them.
  if (message.method === "session/load" && scenario === "native-config") {
    notification("session/update",{sessionId:message.params.sessionId,update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"native-help",description:"Native fixture help"},{name:"native-fast",description:"Turns fast mode on or off"}]}});
    answer(message.id,{configOptions:nativeConfiguration()});return;
  }
  if (message.method === "session/set_config_option" && (scenario === "native-experience" || scenario === "native-config")) { const p=message.params;if(p.configId==="native-model")selectedModel=p.value;else if(p.configId==="native-thinking")thinking=p.value;else if(p.configId==="native-fast")fast=p.value;answer(message.id,{configOptions:nativeConfiguration()});return; }
  if (message.method === "session/new") {
    if (scenario === "unsupported-client") { emit({ id: message.id, error: { code: -32000, message: "This client is no longer supported for Gemini Code Assist. private-synthetic-key" } }); return; }
    if (["opening-metadata", "opening-wrong-identity", "opening-flood", "opening-text"].includes(scenario)) {
      const sessionId = scenario === "opening-wrong-identity" ? "wrong-session" : "session-fixture";
      for (let i = 0; i < (scenario === "opening-flood" ? 129 : 1); i++) notification("session/update", { sessionId, update: { sessionUpdate: "session_info_update", title: "new session" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
      if (scenario === "opening-text") acpOutput();
    }
    // Real agents announce their commands just after the session/new response.
    if (scenario === "late-commands") setTimeout(() => notification("session/update", { sessionId: "session-fixture", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "late", description: "arrives after session creation" }] } }), 200);
    if (scenario === "unlisted-model") { answer(message.id, { sessionId: "session-fixture", configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: "resumed-unlisted", options: [{ value: "native-model-a", name: "Native A" }] }] }); return; }
    answer(message.id, { sessionId: "session-fixture", ...(scenario === "native-models" ? { configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "native-model-a", name: "Native A" }, { value: "native-model-b", name: "Native B" }] }] } : {}),
    ...(["legacy-configured-model", "duplicate-models"].includes(scenario) ? { models: { currentModelId: "configured-model", availableModels: [{ modelId: "suggested-model", name: "Suggested" }, ...(scenario === "duplicate-models" ? [{ modelId: "suggested-model", name: "Duplicate" }] : [])] } } : {}) }); return; }
  if (scenario === "hermes" && message.method === "session/load") {
    // Hermes: an identity it does not have answers null; a known one restores slowly and replays history after the response.
    if (message.params.sessionId === "missing-session") { answer(message.id, null); return; }
    setTimeout(() => {
      answer(message.id, { models: hermesModels() });
      const replay = (kind, text) => notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } });
      setTimeout(() => replay("user_message_chunk", "earlier question"), 20); setTimeout(() => replay("agent_message_chunk", "old replayed answer"), 60);
    }, 300);
    return;
  }
  if (scenario === "hermes" && message.method === "session/list") { answer(message.id, { sessions: [{ sessionId: "session-fixture", cwd: message.params.cwd, title: "Hermes work", updatedAt: "2026-10-11T10:00:00Z" }] }); return; }
  // Hermes starts a new session for an unknown identity without saying so; a client must not rely on it.
  if (scenario === "hermes" && message.method === "session/resume") { answer(message.id, {}); return; }
  if (message.method === "session/load" && scenario === "load-trailing-replay") {
    // Gemini-style: the load response returns first and history keeps streaming afterwards.
    answer(message.id, {});
    for (const delay of [30, 90]) setTimeout(() => notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old replayed answer " } } }), delay);
    return;
  }
  if (message.method === "session/load") {
    if (scenario === "resume-fails") { emit({ id: message.id, error: { code: -32001, message: "Original native state unavailable" } }); return; }
    const sessionId = scenario === "resume-wrong-identity" ? "another-session" : message.params.sessionId;
    notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "previous native reply" } } });
    notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Native history tool", status: "completed" } });
    answer(message.id, {}); return;
  }
  if (message.method === "session/set_model") { selectedModel = message.params.modelId; answer(message.id, {}); return; }
  if (message.method === "session/set_config_option") { selectedModel = message.params.value; answer(message.id, { configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "native-model-a", name: "Native A" }, { value: "native-model-b", name: "Native B" }] }] }); return; }
  // Codex thread catalogue: two pages of this workspace's threads plus ones the client must not continue.
  if (scenario === "threads" && message.method === "thread/list") {
    const here = process.cwd(), base = { name: null, ephemeral: false, modelProvider: "openai", cliVersion: "fixture", status: { type: "notLoaded" }, turns: [] };
    if (message.params.cursor === "page-2") { answer(message.id, { data: [{ ...base, id: "thread-older", preview: "older\nquestion", cwd: here, createdAt: 1700000000, updatedAt: 1700000100, source: { subAgent: "review" } }], nextCursor: null }); return; }
    answer(message.id, { data: [{ ...base, id: "thread-recent", name: "Recent work", preview: "ignored preview", cwd: here, createdAt: 1700000200, updatedAt: 1700000300, source: "cli" },
      { ...base, id: "thread-elsewhere", preview: "elsewhere", cwd: "/elsewhere", createdAt: 1, updatedAt: 2, source: "cli" }, { ...base, id: "thread-ephemeral", preview: "temporary", cwd: here, createdAt: 1, updatedAt: 2, source: "exec", ephemeral: true }], nextCursor: "page-2" }); return;
  }
  if (scenario === "threads" && message.method === "thread/read") {
    const id = message.params.threadId;
    answer(message.id, { thread: { id, name: id === "thread-recent" ? "Recent work" : null, preview: "older question", cwd: id === "thread-elsewhere" ? "/elsewhere" : process.cwd(), ephemeral: id === "thread-ephemeral", createdAt: 1, updatedAt: 2, source: "cli", turns: [] } }); return;
  }
  if (scenario === "threads" && message.method === "thread/turns/list") {
    const turnOf = (n, input) => ({ id: "turn-" + n, status: "completed", items: [{ type: "userMessage", id: "u" + n, content: input }, { type: "commandExecution", id: "c" + n, command: "ls", status: "completed" },
      { type: "agentMessage", id: "a" + n, text: "answer " + n, phase: "final_answer" }] });
    if (message.params.cursor === "older") { answer(message.id, { data: [turnOf(1, [{ type: "text", text: "question 1" }])], nextCursor: null }); return; }
    answer(message.id, { data: [turnOf(3, [{ type: "text", text: "question 3" }]), turnOf(2, [{ type: "text", text: "question 2" }, { type: "localImage", path: "/tmp/shot.png" }])], nextCursor: "older" }); return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    resumedThread = message.method === "thread/resume";
    if (!initialized) { emit({ id: message.id, error: { code: -32600, message: "Not initialized" } }); return; }
    const id = scenario === "resume-wrong-identity" && message.method === "thread/resume" ? "thread-replacement" : "thread-fixture";
    notification("thread/started", { thread: { id } });
    // The thread reports the policy it runs with: requested overrides apply unless the scenario refuses them.
    const sandboxType = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" }[message.params.sandbox ?? "danger-full-access"];
    // A thread reports its own rollout file; the fixture writes one so export has native bytes to copy.
    const rollout = scenario === "rollout" ? join(tmpdir(), `codex-rollout-${process.pid}.jsonl`) : null;
    if (rollout) { writeFileSync(rollout, '{"type":"session_meta"}\n'); process.on("exit", () => rmSync(rollout, { force: true })); }
    answer(message.id, { thread: { id, ...(rollout ? { path: rollout } : {}) }, approvalPolicy: scenario === "ignore-permissions" ? "never" : message.params.approvalPolicy ?? "never", sandbox: { type: scenario === "ignore-permissions" ? "dangerFullAccess" : sandboxType } }); return;
  }
  if (message.method === "ping") { answer(message.id, { echoed: message.params }); return; }
  if (message.method === "thread/fork") {
    if (scenario === "fork-refused") { emit({ id: message.id, error: { code: -32600, message: "thread cannot be forked" } }); return; }
    notification("thread/started", { thread: { id: "thread-forked" } });
    // Like the installed app-server, the copy reports its own status on every attached connection.
    notification("thread/status/changed", { threadId: "thread-forked", status: { type: "idle" } });
    notification("thread/tokenUsage/updated", { threadId: "thread-forked", turnId: "copied-turn", tokenUsage: { total: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } });
    answer(message.id, { thread: { id: scenario === "fork-same" ? message.params.threadId : "thread-forked" } }); return;
  }
  if (message.method === "session/fork") {
    // ACP agents replay the copied history for the new session before answering.
    notification("session/update", { sessionId: "session-forked", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "copied question" } } });
    notification("session/update", { sessionId: "session-forked", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "copied answer" } } });
    answer(message.id, { sessionId: "session-forked" }); return;
  }
  if (message.method === "thread/compact/start") {
    // Codex runs compaction as its own turn: the receipt is empty and the turn identity arrives by notification.
    answer(message.id, {}); turn += 1;
    const base = { threadId: "thread-fixture", turnId: `turn-${turn}` };
    notification("turn/started", { threadId: "thread-fixture", turn: { id: base.turnId, status: "inProgress" } });
    notification("item/started", { ...base, item: { type: "contextCompaction", id: "compact-item" } });
    notification("item/completed", { ...base, item: { type: "contextCompaction", id: "compact-item" } });
    notification("turn/completed", { threadId: "thread-fixture", turn: { id: base.turnId, status: "completed" } }); return;
  }
  if (message.method === "session/prompt" || message.method === "turn/start") {
    // An ACP agent reports a missing login with the protocol's auth_required code, whatever its own words are.
    if (scenario === "auth-code") { emit({ id: message.id, error: { code: -32000, message: "agent setup needed" } }); return; }
    if (scenario === "quota-rejected" || scenario === "auth-rejected") { emit({ id: message.id, error: { code: -32001, message: (scenario === "quota-rejected" ? "You've hit your weekly limit" : "Authentication required") + " private-synthetic-key" } }); return; }
    if (scenario === "prompt-rejected") { emit({ id: message.id, error: { code: -32001, message: "private rejected request synthetic-key" } }); return; }
    promptId = message.id; turn += 1;
    if (scenario === "exit-zero") { process.exit(0); }
    // A native command changes a session setting and the agent announces it, as ACP agents do for their own changes.
    if (scenario === "native-config" && JSON.stringify(message.params.prompt).includes("/native-fast on")) {
      fast = "on"; notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: nativeConfiguration() } });
    }
    if (scenario === "unknown-method") {
      emit({ id: "unsupported", method: "fixture/unsupported", params: {} });
      pendingPermission = true;
    }
    if (protocol === "codex-app-server") {
      if (resumedThread) notification("thread/tokenUsage/updated", { threadId: "thread-fixture", turnId: "previous-native-turn", tokenUsage: {} });
      notification("turn/started", { threadId: "thread-fixture", turn: { id: `turn-${turn}`, status: "inProgress" } });
      if (scenario !== "early-complete" && scenario !== "slow-start") answer(message.id, { turn: { id: `turn-${turn}`, status: "inProgress" } });
    }
    if (scenario === "wrong-identity") {
      if (protocol === "acp-v1") acpOutput("another-session"); else codexOutput(`turn-${turn}`, "another-thread");
      return;
    }
    if (scenario === "wrong-turn") { codexOutput("another-turn"); return; }
    // A sub-agent thread spawned for this turn runs a command and reports back; an unrelated thread works at the same time.
    if (protocol === "codex-app-server" && scenario === "child-tools") {
      const child = { threadId: "thread-child", turnId: "child-turn" };
      notification("thread/started", { thread: { id: "thread-child", parentThreadId: "thread-fixture", agentNickname: "Researcher" } });
      notification("thread/started", { thread: { id: "thread-grandchild", parentThreadId: "thread-child" } });
      // Installed Codex announces a spawned agent only through the parent's subAgentActivity item.
      notification("item/started", { threadId: "thread-fixture", turnId: `turn-${turn}`, item: { type: "subAgentActivity", id: "spawn-1", agentPath: "/root/helper", agentThreadId: "thread-helper", kind: "started" } });
      notification("item/completed", { threadId: "thread-helper", turnId: "helper-turn", item: { type: "commandExecution", id: "cmd-4", command: "pwd", cwd: "/w", status: "completed", aggregatedOutput: "/w", exitCode: 0 } });
      notification("thread/started", { thread: { id: "thread-unrelated" } });
      notification("turn/started", { threadId: "thread-child", turn: { id: "child-turn", status: "inProgress" } });
      notification("item/started", { ...child, item: { type: "commandExecution", id: "cmd-1", command: "echo SUB-OK", cwd: "/w", status: "inProgress" } });
      notification("item/completed", { ...child, item: { type: "commandExecution", id: "cmd-1", command: "echo SUB-OK", cwd: "/w", status: "completed", aggregatedOutput: "SUB-OK", exitCode: 0 } });
      notification("item/completed", { threadId: "thread-grandchild", turnId: "g-turn", item: { type: "commandExecution", id: "cmd-2", command: "ls", cwd: "/w", status: "completed", aggregatedOutput: "a", exitCode: 0 } });
      notification("item/completed", { threadId: "thread-unrelated", turnId: "u-turn", item: { type: "commandExecution", id: "cmd-3", command: "rm -rf /tmp/x", cwd: "/w", status: "completed", aggregatedOutput: "", exitCode: 0 } });
      notification("item/completed", { ...child, item: { type: "agentMessage", id: "child-msg", text: "child report: SUB-OK" } });
      notification("turn/completed", { threadId: "thread-child", turn: { id: "child-turn", status: "completed" } });
      codexOutput(); setTimeout(() => finish(), 30); return;
    }
    if (protocol === "codex-app-server" && scenario === "foreign-thread") {
      notification("thread/started", { thread: { id: "thread-child", parentThreadId: "thread-fixture" } });
      notification("thread/started", { thread: { id: "thread-unrelated" } });
      notification("item/agentMessage/delta", { threadId: "thread-child", turnId: "child-turn", itemId: "child-message", delta: "child output" });
      notification("turn/completed", { threadId: "thread-unrelated", turn: { id: "unrelated-turn", status: "completed" } });
      emit({ id: "child-approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread-child", turnId: "child-turn", itemId: "child-tool", command: "ls" } });
      emit({ id: "unrelated-approval", method: "item/commandExecution/requestApproval", params: { threadId: "thread-unrelated", turnId: "unrelated-turn", itemId: "unrelated-tool", command: "rm -rf /tmp/x" } });
      codexOutput(); setTimeout(() => finish(), 30); return;
    }
    if (protocol === "codex-app-server" && scenario === "native-activity") {
      const base = { threadId: "thread-fixture", turnId: `turn-${turn}` };
      notification("thread/tokenUsage/updated", { threadId: "thread-fixture", turnId: "older-turn", tokenUsage: { total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 0 }, last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 0 }, modelContextWindow: 100000 } });
      notification("item/started", { ...base, item: { type: "commandExecution", id: "cmd-1", command: "printf 'a'\nprintf 'b'", cwd: "/w", status: "inProgress" } });
      notification("item/commandExecution/outputDelta", { ...base, itemId: "cmd-1", delta: "a" });
      notification("item/commandExecution/outputDelta", { ...base, itemId: "cmd-1", delta: "b" });
      notification("item/completed", { ...base, item: { type: "commandExecution", id: "cmd-1", command: "printf 'a'\nprintf 'b'", cwd: "/w", status: "completed", aggregatedOutput: "ab", exitCode: 0 } });
      notification("item/completed", { ...base, item: { type: "fileChange", id: "patch-1", status: "completed", changes: [{ path: "/w/a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" }] } });
      notification("item/completed", { ...base, item: { type: "mcpToolCall", id: "mcp-1", server: "docs", tool: "search", arguments: { q: "acp" }, status: "completed", result: { content: [{ type: "text", text: "found" }] } } });
      notification("item/started", { ...base, item: { type: "contextCompaction", id: "compact-1" } });
      notification("item/completed", { ...base, item: { type: "subAgentActivity", id: "agent-item", agentPath: "researcher", agentThreadId: "thread-child", kind: "completed" } });
      notification("turn/plan/updated", { ...base, explanation: "two steps", plan: [{ step: "Inspect", status: "completed" }, { step: "Patch", status: "inProgress" }] });
      notification("error", { ...base, error: { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: {} } }, willRetry: true });
      notification("model/rerouted", { ...base, fromModel: "gpt-a", toModel: "gpt-b", reason: "highRiskCyberActivity" });
      notification("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { totalTokens: 1600, inputTokens: 1200, cachedInputTokens: 300, outputTokens: 400, reasoningOutputTokens: 50 }, last: { totalTokens: 600, inputTokens: 400, cachedInputTokens: 200, outputTokens: 200, reasoningOutputTokens: 50 }, modelContextWindow: 100000 } });
      // The saved image is read after item/completed; turn/completed follows immediately and must not drop it.
      const image = join(tmpdir(), `codex-fixture-${process.pid}.png`); writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])); process.on("exit", () => rmSync(image, { force: true }));
      notification("item/completed", { ...base, item: { type: "imageGeneration", id: "img-1", status: "completed", revisedPrompt: "a chart", savedPath: image } });
      notification("item/started", { ...base, item: { type: "commandExecution", id: "cmd-2", command: "tail log", cwd: "/w", status: "inProgress" } });
      notification("item/commandExecution/outputDelta", { ...base, itemId: "cmd-2", delta: "line1" });
      codexOutput(); finish(); return;
    }
    if (protocol === "codex-app-server" && scenario === "typed-failure") {
      notification("turn/completed", { threadId: "thread-fixture", turn: { id: `turn-${turn}`, status: "failed", error: { message: "provider said something unhelpful", codexErrorInfo: "usageLimitExceeded" } } }); return;
    }
    if (protocol === "acp-v1" && scenario === "native-activity") {
      const sessionId = "session-fixture", update = value => notification("session/update", { sessionId, update: value });
      update({ sessionUpdate: "plan", entries: [{ content: "Read", status: "completed", priority: "high" }, { content: "Edit", status: "in_progress", priority: "medium" }] });
      update({ sessionUpdate: "tool_call", toolCallId: "shell-1", title: "ls -la", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
      update({ sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit a.txt", kind: "edit", status: "pending", name: "Edit", rawInput: { file_path: "/w/a.txt" }, _meta: { claudeCode: { toolName: "Edit", parentToolUseId: "parent-task" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "edited" } }, { type: "diff", path: "a.txt", oldText: "one\ntwo", newText: "one\nTWO" }], locations: [{ path: "/w/a.txt", line: 2 }] });
      update({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.25, currency: "USD" } });
      update({ sessionUpdate: "notice", severity: "warning", title: "Model fallback", description: "switched model" });
      update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" });
      update({ sessionUpdate: "compaction_summary_chunk", compactionId: "compact-1", content: { type: "text", text: "summary text" } });
      update({ sessionUpdate: "compaction_update", compactionId: "compact-1", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: Buffer.from("png!").toString("base64"), mimeType: "image/png" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "https://example.invalid/report", name: "report", title: "Report" } });
      acpOutput(); answer(promptId, { stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 300, cachedReadTokens: 50, totalTokens: 1250 } }); return;
    }
    if (protocol === "acp-v1" && scenario === "tool-merge") {
      const sessionId = "session-fixture";
      notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "merged", title: "printf 'a'\nprintf 'b'", status: "pending" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "merged", title: "printf 'a'\nprintf 'b'", status: "pending" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "late-announced", status: "completed" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aGk=", mimeType: "image/png" } } });
      acpOutput(); finish(); return;
    }
    if (protocol === "acp-v1" && scenario === "late-output") {
      acpOutput(); finish();
      setTimeout(() => {
        notification("session/update", { sessionId: "session-fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "autonomous follow-up" } } });
        emit({ id: "late-permission", method: "session/request_permission", params: { sessionId: "session-fixture", toolCall: { toolCallId: "late-tool" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } });
      }, 10);
      return;
    }
    if (scenario === "hermes") {
      // A dangerous command asks Hermes's approval bridge; otherwise the reply arrives after a pause, as a model turn does.
      // A model call that failed for good: Hermes logs why on stderr and still ends the turn, with nothing answered.
      if (JSON.stringify(message.params.prompt).includes("fail quietly")) { process.stderr.write("2026-10-11 12:00:00 [ERROR] run_agent: API call failed after 3 retries. Error code: 402 - Insufficient Balance | provider=deepseek model=deepseek-v4-pro\n"); setTimeout(() => finish(), 20); return; }
      // A failure that a retry overcame is logged too, but the turn answers.
      if (JSON.stringify(message.params.prompt).includes("recovered failure")) { process.stderr.write("2026-10-11 12:00:00 [WARNING] run_agent: RateLimitError on attempt 1, retrying\n"); acpOutput(message.params.sessionId); finish(); return; }
      // Hermes can send its last reply chunk after the prompt response.
      if (JSON.stringify(message.params.prompt).includes("late tail")) { acpOutput(message.params.sessionId); finish(); setTimeout(() => notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " tail" } } }), 100); return; }
      // Hermes handles its own /model command locally and only answers in text.
      if (JSON.stringify(message.params.prompt).includes("/model deepseek-v4-flash")) { notification("session/update", { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Model switched to: deepseek-v4-flash\nProvider: deepseek" } } }); finish(); return; }
      if (JSON.stringify(message.params.prompt).includes("approve")) {
        emit({ id: "hermes-permission", method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "perm-check", title: "rm -rf build", kind: "execute" },
          options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow once" }, { optionId: "allow_always", kind: "allow_always", name: "Allow always" }, { optionId: "deny", kind: "reject_once", name: "Deny" }] } });
        return;
      }
      setTimeout(() => { acpOutput(message.params.sessionId); finish(); }, 150); return;
    }
    if (scenario === "passive") notification("fixture/passive", { privateSecret: "must-not-leak" });
    if (scenario === "native-question") {
      pendingPermission = true;
      notification("item/reasoning/summaryTextDelta", { threadId: "thread-fixture", turnId: `turn-${turn}`, itemId: "native-reasoning", summaryIndex: 0, delta: "native reasoning summary" });
      emit({ id: "native-question", method: "item/tool/requestUserInput", params: { threadId: "thread-fixture", turnId: `turn-${turn}`, itemId: "native-question-tool", isBlocking: true, questions: [
        { id: "native-choice", header: "Native choice", question: "选择原生计划", options: [{ label: "First", description: "native first" }, { label: "Second", description: "native second" }] },
        { id: "native-text", header: "Native input", question: "输入原生问题答案", isSecret: true, options: null },
      ] } }); return;
    }
    if (scenario === "permission" || scenario === "duplicate-permission") {
      pendingPermission = true;
      const permission = protocol === "acp-v1"
        ? { id: "permission-1", method: "session/request_permission", params: { sessionId: "session-fixture", toolCall: { toolCallId: "tool-1",
          // The proposed change travels with the request, as Claude and OpenCode send it for an edit.
          ...(scenario === "duplicate-permission" ? {} : { title: "Edit notes.txt", kind: "edit", content: [{ type: "diff", path: "/w/notes.txt", oldText: "alpha\nbravo\n", newText: "alpha\ndelta\n" }], locations: [{ path: "/w/notes.txt" }] }) },
          options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } }
        : { id: "permission-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-fixture", turnId: `turn-${turn}`, itemId: "tool-1" } };
      emit(permission); if (scenario === "duplicate-permission") emit(permission); return;
    }
    // Claude's AskUserQuestion form: a single select with its "Other" companion and a multi-select; or a form with a number field.
    if (scenario === "elicitation" || scenario === "elicitation-number") {
      const option = (label, description) => ({ const: label, title: label, ...(description ? { description } : {}) });
      const properties = scenario === "elicitation-number" ? { count: { type: "number", title: "How many?" } } : {
        question_0: { type: "string", title: "Color", description: "Which color?", oneOf: [option("Red", "warm"), option("Blue", "cool")] },
        question_0_custom: { type: "string", title: "Other", description: "Type your own answer" },
        question_1: { type: "array", title: "Sizes", description: "Which sizes?", items: { anyOf: [option("S"), option("M")] } },
        question_1_custom: { type: "string", title: "Other", description: "Type your own answer" } };
      emit({ id: "elicit-1", method: "elicitation/create", params: { mode: "form", sessionId: message.params.sessionId, toolCallId: "ask-1", message: "Please answer the following questions.", requestedSchema: { type: "object", properties } } });
      return;
    }
    // A sub-agent call whose own tool runs flattened in the root session, stamped with the parent call (Claude's default).
    if (scenario === "subagent") {
      const sessionId = message.params.sessionId, update = value => notification("session/update", { sessionId, update: value });
      update({ sessionUpdate: "tool_call", toolCallId: "agent-1", title: "Run echo SUB-OK", kind: "think", status: "in_progress", rawInput: { description: "Run echo SUB-OK", prompt: "run echo SUB-OK" }, _meta: { claudeCode: { toolName: "Agent" } } });
      update({ sessionUpdate: "tool_call", toolCallId: "bash-1", title: "echo SUB-OK", kind: "execute", status: "completed", rawInput: { command: "echo SUB-OK" }, content: [{ type: "content", content: { type: "text", text: "SUB-OK" } }], _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "agent-1" } } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "agent-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "子代理报告：SUB-OK" } }] });
    }
    // A continued session answers under its own identity.
    if (protocol === "acp-v1") acpOutput(scenario === "session-list" ? message.params.sessionId : undefined); else codexOutput();
    if (["stop", "stop-permission", "slow-start", "no-settlement"].includes(scenario)) {
      if (scenario === "slow-start") setTimeout(() => answer(message.id, { turn: { id: `turn-${turn}`, status: "inProgress" } }), 50);
      return;
    }
    if (scenario === "duplicate-complete") {
      const terminal = protocol === "acp-v1" ? { id: promptId, result: { stopReason: "end_turn" } }
        : { method: "turn/completed", params: { threadId: "thread-fixture", turn: { id: `turn-${turn}`, status: "completed" } } };
      emitAtomicBatch([terminal, terminal]); return;
    }
    if (!pendingPermission) finish();
    if (scenario === "early-complete") answer(message.id, { turn: { id: `turn-${turn}`, status: "inProgress" } });
    return;
  }
  if (message.method === "session/cancel" || message.method === "turn/interrupt") {
    if (message.method === "turn/interrupt") answer(message.id, {});
    if (scenario === "stop-permission") {
      emit(protocol === "acp-v1"
        ? { id: "permission-after-stop", method: "session/request_permission", params: { sessionId: "session-fixture", toolCall: { toolCallId: "tool-1" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] } }
        : { id: "permission-after-stop", method: "item/fileChange/requestApproval", params: { threadId: "thread-fixture", turnId: `turn-${turn}`, itemId: "tool-1" } });
    }
    setTimeout(() => finish(true), 50); return;
  }
  if (message.id === "hermes-permission") { notification("session/update", { sessionId: "session-fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission " + JSON.stringify(message.result) } } }); finish(); return; }
  if (message.id === "elicit-1") { notification("session/update", { sessionId: "session-fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "form " + JSON.stringify(message.result) } } }); finish(); return; }
  if (message.id === "late-permission" || message.id === "child-approval" || message.id === "unrelated-approval") return;
  if (message.id === "permission-1" || message.id === "unsupported" || message.id === "native-question") {
    if (protocol === "acp-v1") acpOutput(); else codexOutput();
    pendingPermission = false; finish();
  }
});
