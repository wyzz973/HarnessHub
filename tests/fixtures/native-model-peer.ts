import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const trace = process.argv[2]!;
let prompts = 0;
let sessions = 0;
new AgentSideConnection(
  (connection) => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: {},
    }),
    authenticate: async () => ({}),
    newSession: async () => {
      sessions++;
      await appendFile(trace, "newSession\n");
      // This peer intentionally has no ACP model controls, like native BYOK Copilot.
      return { sessionId: "native-model-session" };
    },
    setSessionConfigOption: async () => {
      await appendFile(trace, "unexpectedModelControl\n");
      throw new Error("This peer does not support ACP model selection");
    },
    cancel: async () => {},
    prompt: async (request) => {
      prompts++;
      await appendFile(trace, "prompt\n");
      await connection.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({
              sessions,
              prompts,
              pid: process.pid,
              model: process.env.COPILOT_MODEL,
              provider: process.env.COPILOT_PROVIDER_TYPE,
              baseUrl: process.env.COPILOT_PROVIDER_BASE_URL,
              offline: process.env.COPILOT_OFFLINE,
              keyHash: createHash("sha256")
                .update(process.env.COPILOT_PROVIDER_API_KEY ?? "")
                .digest("hex"),
            }),
          },
        },
      });
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
