// A minimal OpenClaw ACP bridge (`openclaw acp`) on stdio, ACP v1, for the driver's protocol tests. Its Gateway is not
// here: the tests answer the driver's Gateway calls themselves. Shapes follow the bridge at v2026.10.5
// (src/acp/translator.presentation.ts and translator.agent-events.ts).
//   FIXTURE_SESSION_CAPS  "latest": sessionCapabilities {list, resume, close} as 2026.10.5 declares them; "fork": those and
//                         fork, as no released bridge declares it; otherwise {} (2026.3.23-2 declares no resume or fork).
//   FIXTURE_TOOLS         "live": during a prompt, tool call `call-x` is streamed and settled (tool_call, then
//                         tool_call_update completed); "open": it is streamed and never settled; otherwise no tool events.
//   FIXTURE_THOUGHT       "1": an agent_thought_chunk during a prompt.
//   FIXTURE_TRACE         a file each received message is appended to, one JSON line each.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const capabilities = process.env.FIXTURE_SESSION_CAPS === "latest" ? { list: {}, resume: {}, close: {} }
  : process.env.FIXTURE_SESSION_CAPS === "fork" ? { list: {}, resume: {}, close: {}, fork: {} } : {};
const levels = ["off", "minimal", "low", "medium", "high", "adaptive"];
const settings = { thought_level: "adaptive", fast_mode: "off", verbose_level: "off", trace_level: "off", reasoning_level: "off", response_usage: "inherit", elevated_level: "off" };
const choices = { thought_level: levels, fast_mode: ["off", "auto", "on"], verbose_level: ["off", "on", "full"], trace_level: ["off", "on"], reasoning_level: ["off", "on", "stream"],
  response_usage: ["inherit", "off", "tokens", "full"], elevated_level: ["off", "on", "ask", "full"] };
/** The bridge's session presentation: seven select options, and its thinking levels again as modes. */
function presentation() {
  return {
    configOptions: Object.entries(choices).map(([id, values]) => ({ type: "select", id, name: id, ...(id === "thought_level" ? { category: "thought_level" } : {}), currentValue: settings[id], options: values.map(value => ({ value, name: value })) })),
    modes: { currentModeId: settings.thought_level, availableModes: levels.map(id => ({ id, name: id })) },
  };
}
function send(message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function update(sessionId, value) { send({ method: "session/update", params: { sessionId, update: value } }); }

createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line), id = message.id, params = message.params ?? {};
  if (process.env.FIXTURE_TRACE) appendFileSync(process.env.FIXTURE_TRACE, line + "\n");
  switch (message.method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: capabilities },
        authMethods: [], agentInfo: { name: "openclaw-acp", version: "fixture" } } });
      return;
    case "session/new":
      send({ id, result: { sessionId: "session-bridge", ...presentation() } });
      update("session-bridge", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "think", description: "Set the thinking level" }, { name: "trace", description: "Toggle plugin trace lines" }] });
      return;
    case "session/resume": case "session/load":
      send({ id, result: presentation() });
      update(params.sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "think", description: "Set the thinking level" }] });
      return;
    case "session/set_config_option":
      settings[params.configId] = params.value;
      send({ id, result: { configOptions: presentation().configOptions } });
      return;
    case "session/set_mode":
      settings.thought_level = params.modeId;
      send({ id, result: {} });
      return;
    case "session/prompt": {
      const session = params.sessionId;
      if (process.env.FIXTURE_THOUGHT === "1") update(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking live" } });
      if (process.env.FIXTURE_TOOLS === "live" || process.env.FIXTURE_TOOLS === "open")
        update(session, { sessionUpdate: "tool_call", toolCallId: "call-x", title: "Run echo HH", status: "in_progress", kind: "execute", rawInput: { command: "echo HH" }, locations: [] });
      if (process.env.FIXTURE_TOOLS === "live")
        update(session, { sessionUpdate: "tool_call_update", toolCallId: "call-x", status: "completed", rawOutput: "HH", content: [{ type: "content", content: { type: "text", text: "HH" } }], locations: [] });
      update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      send({ id, result: { stopReason: "end_turn" } });
      return;
    }
    case "session/fork":
      if (capabilities.fork === undefined) { send({ id, error: { code: -32601, message: "Method not found: session/fork" } }); return; }
      send({ id, result: { sessionId: "session-bridge-fork", ...presentation() } });
      return;
    case "session/close":
      send({ id, result: {} });
      return;
    case "session/cancel":
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
});
