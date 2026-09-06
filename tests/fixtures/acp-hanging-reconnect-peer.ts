import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

const directory = process.argv[2];
if (!directory) throw new Error("Owned state directory is required");
if (!existsSync(join(directory, "hang-initialize"))) {
  await import("./acp-recovery-peer.js");
} else {
  new AgentSideConnection(
    () => ({
      initialize: async () => {
        const child = spawn(
          process.execPath,
          ["-e", "setInterval(()=>{},1000)"],
          { stdio: "ignore", windowsHide: true },
        );
        await once(child, "spawn");
        await writeFile(
          join(directory, "hanging-pids.pending"),
          JSON.stringify({ peer: process.pid, descendant: child.pid }),
        );
        await rename(
          join(directory, "hanging-pids.pending"),
          join(directory, "hanging-pids.json"),
        );
        return new Promise<never>(() => {});
      },
      authenticate: async () => ({}),
      newSession: async () => {
        throw new Error("Reconnect must never replace the session");
      },
      prompt: async () => {
        throw new Error("Prompt must not reach a hanging initializer");
      },
      cancel: async () => {},
    }),
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
}
