#!/usr/bin/env node
/**
 * Startup self-test of a competition layout. It calls no model.
 *
 * Starts the layout's official launcher (gateway.cmd on Windows) with AGENT_ENGINE set and
 * random `--port`/`--console-port`, then requires: the `competition.ready` log line and
 * GET /health/ready 200; GET /v1/runtime/info reporting competition mode and the engine;
 * the console answering 200; GET / redirecting to the console; POST /session creating a
 * directory that did not exist; GET /session/status listing the idle session; DELETE
 * /session/{id}. The process tree is then stopped and both ports must close.
 *
 * Vendor credential variables are removed from the launcher environment. Exit code:
 * 0 PASS, 1 FAIL, 2 usage error.
 *
 * Usage: node scripts/competition-selftest.mjs --bundle DIR [--engine opencode]
 *   [--entry LAUNCHER] [--timeout-ms 240000] [--out FILE] [--log FILE]
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  httpRequest,
  summarizeBody,
  waitUntil,
} from "./lib/competition-client.mjs";
import {
  freePort,
  startLoggedProcess,
  waitForPortsClosed,
  withoutVendorCredentials,
} from "./lib/competition-process.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Default launcher of a competition layout for the current platform. */
export function defaultLauncher(bundle, platform = process.platform) {
  return platform === "win32"
    ? path.join(bundle, "gateway.cmd")
    : path.join(bundle, "dist", "src", "competition-bundle-main.js");
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Run the self-test.
 *
 * @param {{bundle: string, engine?: string, entry?: string, timeoutMs?: number,
 *   logFile?: string, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<{status: "PASS"|"FAIL", checks: object[], engine: string, port: number,
 *   consolePort: number, durationMs: number}>} The launched process tree is always stopped.
 */
export async function runSelfTest(options) {
  const started = Date.now();
  const bundle = path.resolve(options.bundle);
  const engine = options.engine ?? "opencode";
  const timeoutMs = options.timeoutMs ?? 240_000;
  const deadline = started + timeoutMs;
  const entry = path.resolve(options.entry ?? defaultLauncher(bundle));
  const port = await freePort();
  let consolePort = await freePort();
  while (consolePort === port) consolePort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "hh-selftest-"));
  const directory = path.join(workRoot, "session", "workspace");
  const checks = [];
  const check = async (name, action) => {
    const t0 = Date.now();
    const entryRecord = {
      name,
      status: "PASS",
      durationMs: 0,
      detail: {},
      error: null,
    };
    checks.push(entryRecord);
    try {
      await action(entryRecord.detail);
    } catch (error) {
      entryRecord.status = "FAIL";
      entryRecord.error =
        error instanceof Error ? error.message : String(error);
    }
    entryRecord.durationMs = Date.now() - t0;
    return entryRecord.status === "PASS";
  };
  const remaining = () => Math.max(1000, deadline - Date.now());
  let readyEvent;
  const env = withoutVendorCredentials(options.env ?? process.env);
  env.AGENT_ENGINE = engine;
  const processHandle = startLoggedProcess({
    entry,
    args: ["--port", String(port), "--console-port", String(consolePort)],
    cwd: path.dirname(entry),
    env,
    ...(options.logFile ? { logFile: options.logFile } : {}),
    onLine: (line) => {
      const start = line.indexOf("{");
      if (start < 0) return;
      try {
        const value = JSON.parse(line.slice(start));
        if (isObject(value) && value.event === "competition.ready")
          readyEvent = value;
      } catch {
        /* Ordinary log lines are not JSON. */
      }
    },
  });
  let exited;
  processHandle.exited.then((outcome) => {
    exited = outcome;
  });
  let sessionId;
  let consoleUrl;
  try {
    const ready = await check("ready", async (detail) => {
      const outcome = await waitUntil(
        async () => {
          if (exited) return "exited";
          const response = await httpRequest(`${base}/health/ready`, {
            timeoutMs: 3000,
          }).catch(() => undefined);
          return response?.status === 200 &&
            response.json?.ready === true &&
            readyEvent
            ? "ready"
            : undefined;
        },
        { timeoutMs: remaining(), intervalMs: 500 },
      );
      detail.readyEvent = readyEvent ?? null;
      detail.readyAfterMs = Date.now() - started;
      if (outcome === "exited")
        throw new Error(
          `launcher exited early (${JSON.stringify(exited)}): ${processHandle.tail().slice(-1500)}`,
        );
      if (outcome !== "ready")
        throw new Error(
          `no competition.ready line plus /health/ready 200 within ${timeoutMs} ms: ${processHandle.tail().slice(-1500)}`,
        );
      if (readyEvent.engine !== undefined && readyEvent.engine !== engine)
        throw new Error(
          `competition.ready reports engine ${readyEvent.engine}; expected ${engine}`,
        );
    });
    if (ready) {
      await check("runtime-info", async (detail) => {
        const response = await httpRequest(`${base}/v1/runtime/info`);
        if (response.status !== 200 || !isObject(response.json))
          throw new Error(
            `/v1/runtime/info returned ${response.status} ${summarizeBody(response)}`,
          );
        const info = response.json;
        Object.assign(detail, {
          competition: info.competition,
          competitionEngine: info.competitionEngine ?? null,
          fullAccess: info.fullAccess,
          consoleUrl: info.consoleUrl ?? null,
        });
        consoleUrl =
          typeof info.consoleUrl === "string" ? info.consoleUrl : undefined;
        const problems = [];
        if (info.competition !== true) problems.push("competition is not true");
        if (info.competitionEngine !== engine)
          problems.push(
            `competitionEngine is ${JSON.stringify(info.competitionEngine)}`,
          );
        if (typeof info.fullAccess !== "boolean")
          problems.push("fullAccess is not boolean");
        if (!consoleUrl)
          problems.push(
            "consoleUrl is missing although the console was requested",
          );
        else if (new URL(consoleUrl).port !== String(consolePort))
          problems.push(
            `consoleUrl ${consoleUrl} does not use --console-port ${consolePort}`,
          );
        if (problems.length) throw new Error(problems.join("; "));
      });
      await check("console", async (detail) => {
        const target = consoleUrl ?? `http://127.0.0.1:${consolePort}/`;
        detail.url = target;
        const response = await waitUntil(
          async () => {
            const value = await httpRequest(target, {
              timeoutMs: 10_000,
            }).catch(() => undefined);
            return value?.status === 200 ? value : undefined;
          },
          { timeoutMs: Math.min(remaining(), 180_000), intervalMs: 1000 },
        );
        if (!response) throw new Error(`console ${target} did not answer 200`);
        if (!response.text.includes("HarnessHub"))
          throw new Error("console page does not look like HarnessHub");
        detail.httpStatus = response.status;
      });
      await check("root-redirect", async (detail) => {
        const response = await httpRequest(`${base}/`);
        detail.httpStatus = response.status;
        detail.location = response.headers.location ?? null;
        if (
          response.status < 300 ||
          response.status > 308 ||
          !response.headers.location
        )
          throw new Error(
            `GET / returned ${response.status} without a console redirect`,
          );
      });
      const created = await check("session-create", async (detail) => {
        detail.directory = directory;
        const response = await httpRequest(`${base}/session`, {
          method: "POST",
          body: { title: "harnesshub-selftest", directory },
        });
        detail.httpStatus = response.status;
        if (response.status !== 200 || typeof response.json?.id !== "string")
          throw new Error(
            `POST /session returned ${response.status} ${summarizeBody(response)}`,
          );
        sessionId = response.json.id;
        detail.sessionId = sessionId;
        if (!(await directoryExists(directory)))
          throw new Error("POST /session did not create the missing directory");
      });
      if (created) {
        await check("session-status", async (detail) => {
          const response = await httpRequest(`${base}/session/status`);
          detail.httpStatus = response.status;
          const status = isObject(response.json)
            ? response.json[sessionId]
            : undefined;
          detail.session = status ?? null;
          if (
            response.status !== 200 ||
            !isObject(status) ||
            status.type !== "idle"
          )
            throw new Error(
              `GET /session/status returned ${response.status} ${summarizeBody(response)}`,
            );
        });
        await check("session-delete", async (detail) => {
          const response = await httpRequest(
            `${base}/session/${encodeURIComponent(sessionId)}`,
            {
              method: "DELETE",
            },
          );
          detail.httpStatus = response.status;
          if (response.status !== 200)
            throw new Error(
              `DELETE /session/{id} returned ${response.status} ${summarizeBody(response)}`,
            );
        });
      }
    }
  } finally {
    await processHandle.stop();
    await check("shutdown", async (detail) => {
      const open = await waitForPortsClosed([port, consolePort], {
        timeoutMs: 20_000,
      });
      detail.openPorts = open;
      if (open.length)
        throw new Error(
          `ports still accepting connections after stop: ${open.join(", ")}`,
        );
    });
    await rm(workRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }
  return {
    status: checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
    engine,
    bundle,
    entry,
    port,
    consolePort,
    durationMs: Date.now() - started,
    modelCalled: false,
    checks,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const usage =
    "Usage: node scripts/competition-selftest.mjs --bundle DIR [--engine opencode] [--entry LAUNCHER] [--timeout-ms 240000] [--out FILE] [--log FILE]";
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        bundle: { type: "string" },
        engine: { type: "string", default: "opencode" },
        entry: { type: "string" },
        "timeout-ms": { type: "string", default: "240000" },
        out: { type: "string" },
        log: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
    if (values.help) {
      console.log(usage);
      process.exit(0);
    }
    if (!values.bundle) throw new Error(usage);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  try {
    const timeoutMs = Number(values["timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000)
      throw new Error("--timeout-ms must be >= 10000");
    const result = await runSelfTest({
      bundle: values.bundle,
      engine: values.engine,
      timeoutMs,
      ...(values.entry ? { entry: values.entry } : {}),
      ...(values.log ? { logFile: path.resolve(values.log) } : {}),
    });
    if (values.out)
      await writeFile(
        path.resolve(values.out),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    console.log(
      JSON.stringify({
        event: "competition.selftest",
        status: result.status,
        engine: result.engine,
        checks: Object.fromEntries(
          result.checks.map((item) => [item.name, item.status]),
        ),
        failures: result.checks
          .filter((item) => item.status !== "PASS")
          .map((item) => `${item.name}: ${item.error}`),
      }),
    );
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
