import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
const mode = process.argv[2],
  state = process.env.OPENCLAW_STATE_DIR;
const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
await writeFile(
  path.join(state, `${mode}.json`),
  JSON.stringify({
    pid: process.pid,
    supervisor: process.ppid,
    descendant: descendant.pid,
    args: process.argv.slice(2),
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    url: process.env.OPENCLAW_GATEWAY_URL,
    config: JSON.parse(
      await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"),
    ),
  }),
);
if (mode === "gateway") {
  console.log(`fixture gateway token ${process.env.OPENCLAW_GATEWAY_TOKEN}`);
  const server = createServer((request, response) => {
    response.writeHead(
      request.url === "/readyz" &&
        request.headers.authorization ===
          `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`
        ? 200
        : 401,
    );
    response.end("ready");
  });
  server.listen(
    Number(process.argv[process.argv.indexOf("--port") + 1]),
    "127.0.0.1",
  );
  setInterval(async () => {
    try {
      await readFile(path.join(state, "fail-gateway"));
      process.exit(23);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }, 50);
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize")
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "fixture", version: "1" },
          },
        }) + "\n",
      );
  });
  // Deliberately do not exit on EOF: the wrapper must close both owned Job trees.
  setInterval(() => {}, 1000);
}
