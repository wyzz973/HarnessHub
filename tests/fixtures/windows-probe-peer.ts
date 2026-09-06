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
  JSON.stringify({ parent: process.pid, child: child.pid }),
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
