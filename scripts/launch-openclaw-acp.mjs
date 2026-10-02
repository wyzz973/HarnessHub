/**
 * Launches one OpenClaw bridge on an isolated native Gateway session. In OpenClaw
 * 2026.3.23-2 the bridge's default acp:<uuid> key collides with the Gateway's
 * separate ACP-runtime session classifier. This wrapper uses a distinct native
 * namespace and never resets or attaches to a user's main conversation.
 * Credentials/configuration remain inherited references. Session resume is not
 * enabled for profiles using this process-local session mapping.
 */
import { spawnEngine as spawn } from "./spawn-engine.mjs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

const executable = process.argv[2];
if (!executable || !isAbsolute(executable) || process.argv.length !== 3) {
  process.stderr.write(
    "Usage: node launch-openclaw-acp.mjs <absolute OpenClaw executable>\n",
  );
  process.exit(2);
}
const key = `agent:main:harnesshub:${randomUUID()}`;
const child = spawn(executable, ["acp", "--session", key], {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
