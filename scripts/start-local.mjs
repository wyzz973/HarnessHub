import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { checkRuntime } from "./check-runtime.mjs";

// A terminal-owned pair of compiled services. Ctrl+C closes this pair only.
const root = fileURLToPath(new URL("../", import.meta.url));
checkRuntime(
  process.versions.node,
  readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
);
if (process.argv.slice(2).some((arg) => arg !== "--demo"))
  throw new Error("Usage: pnpm start:local [--demo]");
const demo = process.argv.includes("--demo");
for (const port of [3180, 3330]) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const children = new Set();
const jobHelper = fileURLToPath(
  new URL("../dist/native/harnesshub-job.exe", import.meta.url),
);
let stopping;
function stop(code = 0) {
  if (stopping) return stopping;
  process.exitCode = code;
  stopping = Promise.all(
    [...children].map(async ({ child, closed, token }) => {
      if (token) {
        try {
          await promisify(execFile)(jobHelper, ["close", token, "5000"], {
            timeout: 6000,
            windowsHide: true,
          });
        } catch {
          process.exitCode = 1;
        }
      }
      if (child.pid && child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }),
  ).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  return stopping;
}
function launch(args, cwd, extraEnv = {}) {
  const token = process.platform === "win32" ? randomUUID() : undefined;
  const child = spawn(
    token ? jobHelper : process.execPath,
    token
      ? ["run", String(process.pid), token, process.execPath, ...args]
      : args,
    {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const owned = { child, closed, token };
  children.add(owned);
  child.once("error", (error) => {
    console.error(error.message);
    void stop(1);
  });
  child.once("close", (code) => {
    children.delete(owned);
    void stop(code ?? 1);
  });
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
launch(
  [
    "dist/src/main.js",
    ...(demo ? ["--demo"] : []),
    "--port",
    "3180",
    "--data-dir",
    demo ? "./data/demo" : "./data/local",
  ],
  root,
);
launch(
  [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3330",
  ],
  fileURLToPath(new URL("../web/", import.meta.url)),
  { HARNESSHUB_GATEWAY_URL: "http://127.0.0.1:3180" },
);
console.log(
  `HarnessHub ${demo ? "demo" : "local"}: http://127.0.0.1:3330 (Ctrl+C stops both services)`,
);
