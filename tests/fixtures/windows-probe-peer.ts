// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const child = spawn(
  process.execPath,
  ["-e", "process.send('ready');setInterval(()=>{},1000)"],
  {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  },
);
await new Promise((resolve) => child.once("message", resolve));
await writeFile(
  process.argv[2]!,
  JSON.stringify({
    parent: process.pid,
    child: child.pid,
    programFiles: process.env.ProgramFiles ?? null,
    programData: process.env.ProgramData ?? null,
    allUsersProfile: process.env.ALLUSERSPROFILE ?? null,
    userProfile: process.env.USERPROFILE ?? null,
    homeDrive: process.env.HOMEDRIVE ?? null,
    homePath: process.env.HOMEPATH ?? null,
    temp: process.env.TEMP ?? null,
  }),
);
for await (const line of createInterface({ input: process.stdin })) {
  if (process.argv[3] === "silent") continue;
  const request = JSON.parse(line) as { id: number };
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: 1 },
    }) + "\n",
  );
}
