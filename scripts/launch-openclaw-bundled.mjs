/** Own one private OpenClaw Gateway and ACP bridge. Only ACP bytes reach stdout; no model is called during startup. */
import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL("../dist/native/harnesshub-job.exe", import.meta.url),
);
const within = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function available(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** Requires explicit private state/config paths. Child Job handles remain owned until both process trees have closed. */
export async function runBundledOpenClaw(executable) {
  if (process.platform !== "win32" || !path.isAbsolute(executable ?? ""))
    throw new Error(
      "Bundled OpenClaw requires Windows and an absolute openclaw.mjs path",
    );
  const entry = await realpath(executable);
  for (const marker of [
    ".openclaw-lifecycle-pending",
    "dist/openclaw-install-guard",
  ])
    if (await available(path.join(path.dirname(entry), marker)))
      throw new Error(
        "OpenClaw package lifecycle is incomplete; prepare the release package before running it",
      );
  const stateInput = process.env.OPENCLAW_STATE_DIR,
    configInput = process.env.OPENCLAW_CONFIG_PATH;
  if (!path.isAbsolute(stateInput ?? "") || !path.isAbsolute(configInput ?? ""))
    throw new Error(
      "Bundled OpenClaw requires explicit private OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH",
    );
  await mkdir(stateInput, { recursive: true });
  const state = await realpath(stateInput);
  // Windows may supply a short-name or junction alias for the private state.
  // Compare canonical parents, then independently reject a linked config file.
  const configPath = path.join(
    await realpath(path.dirname(configInput)),
    path.basename(configInput),
  );
  if (!within(state, configPath))
    throw new Error(
      "OpenClaw configuration must be inside its private state directory",
    );
  let base = {};
  if (await available(configPath)) {
    if (!within(state, await realpath(configPath)))
      throw new Error(
        "OpenClaw configuration escapes its private state directory",
      );
    const source = await readFile(configPath, "utf8");
    try {
      base = JSON.parse(source);
    } catch {
      base = createRequire(entry)("json5").parse(source);
    }
    if (!object(base))
      throw new Error("OpenClaw configuration must be an object");
  }
  const work = await mkdtemp(path.join(state, ".harnesshub-gateway-"));
  const jobs = [],
    aborted = new AbortController(),
    input = new PassThrough({ highWaterMark: 65536 });
  const stop = () => aborted.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  process.stdout.once("error", stop);
  process.stdin.pipe(input);
  const token = randomBytes(32).toString("hex");
  function logs(stream) {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) =>
      process.stderr.write(line.replaceAll(token, "[internal-token]") + "\n"),
    );
  }
  function launch(args, env) {
    const id = randomUUID(),
      closed = Promise.withResolvers();
    const child = spawn(
      helper,
      ["run", String(process.pid), id, process.execPath, entry, ...args],
      { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const job = { id, child, closed: closed.promise };
    jobs.push(job);
    child.once("error", () => {
      closed.resolve(1);
      stop();
    });
    child.once("close", (code) => {
      closed.resolve(code ?? 1);
      stop();
    });
    logs(child.stderr);
    return job;
  }
  try {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const config = {
      ...base,
      models: {
        ...base.models,
        catalogRefresh: { ...base.models?.catalogRefresh, enabled: false },
      },
      update: {
        ...base.update,
        checkOnStart: false,
        auto: { ...base.update?.auto, enabled: false },
      },
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token" },
        controlUi: { enabled: false },
        tailscale: { mode: "off" },
      },
      cron: { ...base.cron, enabled: false },
    };
    const runtimeConfig = path.join(work, "openclaw.json");
    await writeFile(runtimeConfig, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: runtimeConfig,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${port}`,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      OPENCLAW_NO_RESPAWN: "1",
    };
    delete env.OPENCLAW_GATEWAY_PASSWORD;
    const gateway = launch(
      [
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--auth",
        "token",
      ],
      env,
    );
    gateway.child.stdin.end();
    logs(gateway.child.stdout);
    const deadline = AbortSignal.timeout(45_000),
      signal = AbortSignal.any([aborted.signal, deadline]);
    let ready = false;
    while (!signal.aborted) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        await response.arrayBuffer();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (!(error instanceof TypeError) && error.name !== "TimeoutError")
          throw error;
      }
      await delay(100, undefined, { signal }).catch((error) => {
        if (error.name !== "AbortError") throw error;
      });
    }
    if (!ready) {
      if (deadline.aborted)
        throw new Error("Private OpenClaw Gateway readiness timed out");
      if (process.stdin.readableEnded) return 0;
      throw new Error("Private OpenClaw Gateway exited before ready");
    }
    const acp = launch(
      ["acp", "--session", `agent:main:harnesshub:${randomUUID()}`],
      env,
    );
    input.pipe(acp.child.stdin);
    acp.child.stdin.on("error", stop);
    acp.child.stdout.pipe(process.stdout, { end: false });
    await new Promise((resolve) => {
      if (aborted.signal.aborted) resolve();
      else aborted.signal.addEventListener("abort", resolve, { once: true });
    });
    return acp.child.exitCode ?? (gateway.child.exitCode === null ? 0 : 1);
  } finally {
    stop();
    process.stdin.unpipe(input);
    input.destroy();
    process.stdin.pause();
    const cleanup = await Promise.allSettled(
      jobs.map(async (job) => {
        try {
          await execute(helper, ["close", job.id, "5000"], {
            timeout: 6500,
            windowsHide: true,
            maxBuffer: 16384,
          });
        } finally {
          job.child.kill("SIGKILL");
          await job.closed;
        }
      }),
    );
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("error", stop);
    process.stdout.removeListener("error", stop);
    await rm(work, { recursive: true, force: true });
    if (cleanup.some((result) => result.status === "rejected"))
      throw new Error("Private OpenClaw process cleanup failed");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error(
        "Usage: node launch-openclaw-bundled.mjs <absolute openclaw.mjs>",
      );
    process.exitCode = await runBundledOpenClaw(process.argv[2]);
  } catch (error) {
    process.stderr.write(`Bundled OpenClaw: ${error.message}\n`);
    process.exitCode = 1;
  }
}
