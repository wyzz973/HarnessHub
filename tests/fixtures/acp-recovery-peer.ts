import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const directory = process.argv[2];
if (!directory) throw new Error("Peer requires its owned state directory");
const stateDirectory: string = directory;
const unsupported = process.argv.includes("--unsupported");
const log = (type: string, sessionId: string) =>
  appendFile(
    join(stateDirectory, "operations.jsonl"),
    `${JSON.stringify({ type, sessionId })}\n`,
  );
const backendFile = (id: string) => join(stateDirectory, `${id}.txt`);

new AgentSideConnection(
  (connection) => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentCapabilities: unsupported
        ? {}
        : { sessionCapabilities: { resume: {}, close: {} } },
    }),
    authenticate: async () => ({}),
    newSession: async () => {
      const sessionId = randomUUID();
      await log("new", sessionId);
      await writeFile(backendFile(sessionId), "");
      return { sessionId };
    },
    resumeSession: async ({ sessionId }) => {
      await log("resume", sessionId);
      await readFile(backendFile(sessionId), "utf8");
      return {};
    },
    closeSession: async ({ sessionId }) => {
      await log("close", sessionId);
      return {};
    },
    cancel: async () => {},
    prompt: async ({ sessionId, prompt }) => {
      await log("prompt", sessionId);
      const text = prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const output = text.startsWith("remember:")
        ? "stored"
        : await readFile(backendFile(sessionId), "utf8");
      if (text.startsWith("remember:"))
        await writeFile(backendFile(sessionId), text.slice("remember:".length));
      await connection.sessionUpdate({
        sessionId,
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
