// SPDX-License-Identifier: MIT
/**
 * Start the compiled daemon on 127.0.0.1:3180 for this terminal; it serves
 * the built console (`pnpm build:console`) and prints a one-time sign-in link.
 * Usage: pnpm start:local [--demo] [--dev]
 *
 * `--demo` uses data/demo with the demo engines, otherwise data/local.
 * `--dev` also starts the console's Vite development server on
 * 127.0.0.1:3330, which forwards API and gateway requests to the daemon, and
 * prints a sign-in link for it once the daemon is ready. Ctrl+C stops the
 * services this script started, and only those.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { checkRuntime } from "./check-runtime.mjs";

const DAEMON = "http://127.0.0.1:3180";
const DEV_SERVER = "http://127.0.0.1:3330";
const root = fileURLToPath(new URL("../", import.meta.url));
checkRuntime(
  process.versions.node,
  readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
);
if (process.argv.slice(2).some((arg) => arg !== "--demo" && arg !== "--dev"))
  throw new Error("Usage: pnpm start:local [--demo] [--dev]");
const demo = process.argv.includes("--demo");
const dev = process.argv.includes("--dev");
for (const port of dev ? [3180, 3330] : [3180]) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const children = new Set();
const jobHelper = fileURLToPath(
  new URL("../packages/runtime/dist/native/harnesshub-job.exe", import.meta.url),
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
const dataDir = fileURLToPath(
  new URL(demo ? "../data/demo" : "../data/local", import.meta.url),
);
launch(
  [
    "packages/daemon/dist/src/main.js",
    ...(demo ? ["--demo"] : []),
    "--port",
    "3180",
    "--data-dir",
    dataDir,
  ],
  root,
);
if (dev) {
  // tools/console.mjs passes only HARNESSHUB_DAEMON_URL and system variables to Vite.
  launch(["tools/console.mjs", "dev"], root, { HARNESSHUB_DAEMON_URL: DAEMON });
  // The daemon prints a link to itself; the development server needs its own.
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!ready && !stopping && Date.now() < deadline) {
    ready = await fetch(`${DAEMON}/health/ready`).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) await delay(250);
  }
  if (ready && !stopping) {
    const { connectLocal } = await import("../packages/sdk/dist/src/local.js");
    const client = await connectLocal({ dataDir, url: DAEMON });
    const { code } = await client.auth.createConsoleLink();
    console.log(
      `HarnessHub console (Vite dev server): ${DEV_SERVER}/#login=${code}\n  (valid once for 60 s; pnpm exec hh console --url ${DEV_SERVER} --data-dir ${dataDir} prints a new one)`,
    );
  } else if (!stopping) {
    console.error(`The daemon at ${DAEMON} did not become ready within 60 s`);
    void stop(1);
  }
} else
  console.log(
    `HarnessHub ${demo ? "demo" : "local"}: ${DAEMON} (Ctrl+C stops the daemon)`,
  );
