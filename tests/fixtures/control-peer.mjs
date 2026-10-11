import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

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
      ? { protocolVersion: scenario === "version" ? 2 : 1, agentCapabilities: { loadSession: ["native-resume", "resume-fails", "resume-wrong-identity"].includes(scenario) }, authMethods: [{ id: "fixture-login", name: "Fixture Login" }], agentInfo: { name: "fixture", version: "1.0" } }
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
  if (message.method === "config/read") { answer(message.id, { config: { model: "native-model-a", privateCredential: "synthetic-never-public" } }); return; }
  if (message.method === "account/read") { answer(message.id, { account: { type: "chatgpt", email: "private-account@example.invalid" }, requiresOpenaiAuth: true }); return; }
  if (message.method === "model/list") { answer(message.id, { data: ["native-model-a", "native-model-b"].map(model => ({ model, displayName: model })), nextCursor: null }); return; }
  if (message.method === "session/new" && scenario === "native-experience") {
    notification("session/update",{sessionId:"session-fixture",update:{sessionUpdate:"available_commands_update",availableCommands:[{name:"native-help",description:"Native fixture help"}]}});
    answer(message.id,{sessionId:"session-fixture",configOptions:nativeConfiguration()});return;
  }
  if (message.method === "session/set_config_option" && scenario === "native-experience") { const p=message.params;if(p.configId==="native-model")selectedModel=p.value;else if(p.configId==="native-thinking")thinking=p.value;else if(p.configId==="native-fast")fast=p.value;answer(message.id,{configOptions:nativeConfiguration()});return; }
  if (message.method === "session/new") {
    if (scenario === "unsupported-client") { emit({ id: message.id, error: { code: -32000, message: "This client is no longer supported for Gemini Code Assist. private-synthetic-key" } }); return; }
    if (["opening-metadata", "opening-wrong-identity", "opening-flood", "opening-text"].includes(scenario)) {
      const sessionId = scenario === "opening-wrong-identity" ? "wrong-session" : "session-fixture";
      for (let i = 0; i < (scenario === "opening-flood" ? 129 : 1); i++) notification("session/update", { sessionId, update: { sessionUpdate: "session_info_update", title: "new session" } });
      notification("session/update", { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
      if (scenario === "opening-text") acpOutput();
    }
    answer(message.id, { sessionId: "session-fixture", ...(scenario === "native-models" ? { configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "native-model-a", name: "Native A" }, { value: "native-model-b", name: "Native B" }] }] } : {}),
    ...(["legacy-configured-model", "duplicate-models"].includes(scenario) ? { models: { currentModelId: "configured-model", availableModels: [{ modelId: "suggested-model", name: "Suggested" }, ...(scenario === "duplicate-models" ? [{ modelId: "suggested-model", name: "Duplicate" }] : [])] } } : {}) }); return; }
  if (message.method === "session/load") {
    if (scenario === "resume-fails") { emit({ id: message.id, error: { code: -32001, message: "Original native state unavailable" } }); return; }
    const sessionId = scenario === "resume-wrong-identity" ? "another-session" : message.params.sessionId;
    notification("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "previous native reply" } } });
    notification("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Native history tool", status: "completed" } });
    answer(message.id, {}); return;
  }
  if (message.method === "session/set_model") { selectedModel = message.params.modelId; answer(message.id, {}); return; }
  if (message.method === "session/set_config_option") { selectedModel = message.params.value; answer(message.id, { configOptions: [{ id: "native-model", category: "model", type: "select", currentValue: selectedModel, options: [{ value: "native-model-a", name: "Native A" }, { value: "native-model-b", name: "Native B" }] }] }); return; }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    resumedThread = message.method === "thread/resume";
    if (!initialized) { emit({ id: message.id, error: { code: -32600, message: "Not initialized" } }); return; }
    const id = scenario === "resume-wrong-identity" && message.method === "thread/resume" ? "thread-replacement" : "thread-fixture";
    notification("thread/started", { thread: { id } });
    answer(message.id, { thread: { id } }); return;
  }
  if (message.method === "ping") { answer(message.id, { echoed: message.params }); return; }
  if (message.method === "session/prompt" || message.method === "turn/start") {
    if (scenario === "quota-rejected" || scenario === "auth-rejected") { emit({ id: message.id, error: { code: -32001, message: (scenario === "quota-rejected" ? "You've hit your weekly limit" : "Authentication required") + " private-synthetic-key" } }); return; }
    if (scenario === "prompt-rejected") { emit({ id: message.id, error: { code: -32001, message: "private rejected request synthetic-key" } }); return; }
    promptId = message.id; turn += 1;
    if (scenario === "exit-zero") { process.exit(0); }
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
        ? { id: "permission-1", method: "session/request_permission", params: { sessionId: "session-fixture", toolCall: { toolCallId: "tool-1" }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } }
        : { id: "permission-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-fixture", turnId: `turn-${turn}`, itemId: "tool-1" } };
      emit(permission); if (scenario === "duplicate-permission") emit(permission); return;
    }
    if (protocol === "acp-v1") acpOutput(); else codexOutput();
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
  if (message.id === "permission-1" || message.id === "unsupported" || message.id === "native-question") {
    if (protocol === "acp-v1") acpOutput(); else codexOutput();
    pendingPermission = false; finish();
  }
});
