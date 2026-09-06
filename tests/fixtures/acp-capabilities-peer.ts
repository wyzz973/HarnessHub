import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const directory = process.argv[2];
if (!directory) throw new Error("Peer requires its owned state directory");
new AgentSideConnection(
  (connection) => ({
    initialize: async (request) => {
      await appendFile(
        join(directory, "initialize.jsonl"),
        `${JSON.stringify({ pid: process.pid, capabilities: request.clientCapabilities })}\n`,
      );
      return {
        protocolVersion: PROTOCOL_VERSION,
        authMethods: [],
        agentCapabilities: {},
      };
    },
    authenticate: async () => ({}),
    newSession: async () => ({ sessionId: "capability-session" }),
    cancel: async () => {},
    prompt: async (request) => {
      const duplicate = request.prompt.some(
        (part) => part.type === "text" && part.text === "duplicate-options",
      );
      const permission = await connection.requestPermission({
        sessionId: request.sessionId,
        toolCall: {
          toolCallId: "exact-option-tool",
          title: "Select an exact once option",
        },
        options: [
          { optionId: "first", name: "First once option", kind: "allow_once" },
          {
            optionId: duplicate ? "first" : "second",
            name: "Second once option",
            kind: "allow_once",
          },
          { optionId: "reject", name: "Reject once", kind: "reject_once" },
        ],
      });
      await connection.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(permission.outcome) },
        },
      });
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
