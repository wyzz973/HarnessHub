import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
let model = "alpha";
let servers: unknown[] = [];
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model" as const,
    type: "select" as const,
    currentValue: model,
    options: [
      { value: "alpha", name: "Alpha" },
      { value: "beta", name: "Beta" },
    ],
  },
];
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
new AgentSideConnection(
  (connection) => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
    }),
    authenticate: async () => ({}),
    newSession: async (request) => {
      servers = request.mcpServers;
      return {
        sessionId: "configured-session",
        configOptions: configOptions(),
        models: {
          currentModelId: model,
          availableModels: [
            { modelId: "alpha", name: "Alpha" },
            { modelId: "beta", name: "Beta" },
          ],
        },
      };
    },
    setSessionConfigOption: async (request) => {
      model = String(request.value);
      return { configOptions: configOptions() };
    },
    cancel: async () => {},
    prompt: async (request) => {
      const text = request.prompt
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      const output = JSON.stringify({
        model,
        keyHash: digest(process.env.OPENAI_API_KEY ?? ""),
        url: process.env.HH_TARGET_URL,
        skill: text.includes("fixture skill instruction"),
        mcpHash: digest(JSON.stringify(servers)),
        mcpCount: servers.length,
      });
      await connection.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: output },
        },
      });
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
