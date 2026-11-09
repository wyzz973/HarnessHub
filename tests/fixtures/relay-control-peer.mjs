// A minimal ACP v1 agent for the G069 relay tests (no Harness, no model). On session/new or session/load it answers with
// one session and announces RELAY_COMMANDS (a JSON list of ACP available commands, without contextEffect, as agents send
// them); every prompt is answered with RELAY_REPLY (default "ok") and end_turn. RELAY_TRACE, when set, receives every line
// it read. It writes nothing else and exits when its input closes.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const trace = process.env.RELAY_TRACE;
const commands = JSON.parse(process.env.RELAY_COMMANDS ?? "[]");
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line), params = message.params ?? {};
  if (trace) appendFileSync(trace, line + "\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "provider", name: "Provider" }], agentInfo: { name: "relay-control-peer", version: "1.0.0" } } });
    return;
  }
  if (message.method === "session/new" || message.method === "session/load") {
    const sessionId = message.method === "session/load" ? params.sessionId : "relay-session";
    send({ id: message.id, result: message.method === "session/load" ? {} : { sessionId } });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: commands });
    return;
  }
  if (message.method === "session/prompt") {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.RELAY_REPLY ?? "ok" } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (message.method === "session/cancel") return;
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
