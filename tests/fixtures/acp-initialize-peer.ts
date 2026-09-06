import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { access } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
new AgentSideConnection(
  () => ({
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
      authMethods: [],
    }),
    authenticate: async () => ({}),
    newSession: async () => ({ sessionId: "bounded-session" }),
    cancel: async () => {},
    prompt: async () => {
      for (;;) {
        try {
          await access(join(process.cwd(), "release-prompt"));
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
        await delay(25);
      }
      return { stopReason: "end_turn" };
    },
  }),
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
