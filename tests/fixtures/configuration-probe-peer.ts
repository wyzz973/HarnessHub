import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(
  process.execPath,
  [
    "-e",
    "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)",
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
await new Promise((resolve) => child.once("message", resolve));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number };
  process.stdout.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { protocolVersion: 1 },
    }) + "\n",
  );
}
