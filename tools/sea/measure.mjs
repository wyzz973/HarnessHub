#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Measure and check a HarnessHub single executable (SEA feasibility spike, OSS-008).
 *
 * Usage: node tools/sea/measure.mjs [--binary dist/sea/harnesshub] [--runs 10]
 *   [--out dist/sea/result.json] [--phases-out FILE] [--baseline]
 *
 * Cold start: time from spawn to the `ready` line of `serve --demo --port 0`, each run with a
 * fresh data directory and workspace. "first-run" also uses a fresh extraction root (what the
 * first start after installation pays); "installed" reuses one prepared root. `--baseline`
 * measures `node packages/daemon/dist/src/main.js` the same way. One unmeasured warm-up start precedes each
 * series. p50/p95 are nearest-rank.
 *
 * Phases (OSS-008 first-run investigation): the SEA starts of both series run with
 * `HARNESSHUB_SEA_TRACE=1`, which makes the executable's entry report, on stderr, when its
 * process started and reached the entry, each extracted file, the end of extraction, the
 * Gateway role's evaluation and each native helper start. The result gives p50/p95 per phase
 * for each series: spawn to process start, process start to entry, extraction (and per file),
 * role evaluation, role to `ready`, entry to `ready`, and per native helper the time from its
 * spawn to process creation, first output and exit. `--phases-out FILE` also writes them,
 * with every start's own phases in order (so a single slow start shows where it lost time),
 * to a file of their own. The trace is off by default and names no root, argument or
 * environment value.
 *
 * End-to-end checks, all against the SEA: `version --json` carries the build identity of
 * packages/daemon/dist/build-info.json; the extracted secret helper of this platform (macOS keychain, Windows
 * DPAPI; none on Linux) has the SHA-256 that build.json recorded, read as a file only;
 * `serve` reaches ready; the engine launcher and the command MCP server run
 * as roles of the SEA; a demo Session Run on the fake engine completes in a Worker that the SEA
 * re-executed itself for; an ACP engine (the repository's model-gateway-peer fixture, on this
 * Node) calls the Session model gateway, which makes one authenticated streaming call to the
 * strict fake provider (tools/fake-provider) without field violations; the same fixture
 * launched through the SEA itself (node-compat mode) does the same; after SIGKILL of the
 * Gateway during a Run, a restarted SEA marks the Run interrupted with confirmed cleanup (on
 * POSIX the Worker lease identity is also compared with `ps`); SIGTERM stops the Gateway with
 * exit code 0 (not on Windows, where kill() terminates).
 *
 * Writes one JSON result; exits 1 when any check or measured start fails. Never contacts
 * anything but loopback. Needs `pnpm build` (for the fixture) and tools/sea/build.mjs.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startFakeProvider } from "../fake-provider/index.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const READY_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 90_000;
const UPSTREAM_KEY_ENV = "HH_SEA_UPSTREAM_KEY";
const PEER = path.join(
  ROOT,
  "dist",
  "tests",
  "fixtures",
  "model-gateway-peer.js",
);
/** ADR-P01 re-evaluation conditions. */
const LIMITS = { coldStartMs: 1500, sizeBytes: 150 * 1000 * 1000 };

const round = (value) => Math.round(value * 10) / 10;
function percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted.length
    ? {
        n: sorted.length,
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        min: round(sorted[0]),
        max: round(sorted.at(-1)),
        samples: sorted.map(round),
      }
    : { n: 0 };
}
/** One start's phases (ms) from its trace events, or null without a trace. */
function phasesOf({ events, spawnedAt, readyAt }) {
  const first = (phase) => events.find((event) => event.phase === phase);
  const entry = first("entry");
  if (!entry) return null;
  const at = (phase) => first(phase)?.at;
  const span = (from, to) =>
    from === undefined || to === undefined ? undefined : to - from;
  const helpers = {};
  for (const event of events) {
    if (!event.phase.startsWith("helper.")) continue;
    const helper = (helpers[event.helper] ??= { starts: 0 });
    if (event.phase === "helper.start") {
      helper.starts += 1;
      helper.startedAfterEntry ??= event.at - entry.entered;
    } else {
      const key = event.phase.slice("helper.".length);
      helper[key] ??= event.ms;
    }
  }
  const files = {};
  for (const event of events)
    if (event.phase === "extract.file")
      files[event.file] = { action: event.action, ms: event.ms };
  return {
    spawnToProcess: entry.processStart - spawnedAt,
    processToEntry: entry.entered - entry.processStart,
    extract: span(at("extract.start"), at("extract.end")),
    roleEvaluation: span(at("role.start"), at("role.evaluated")),
    roleToReady: span(at("role.evaluated"), readyAt),
    entryToReady: readyAt - entry.entered,
    spawnToReady: readyAt - spawnedAt,
    files,
    helpers,
  };
}

/** p50/p95 of every phase over the starts of a series. */
function phaseSummary(runs) {
  const traced = runs.filter(Boolean);
  if (!traced.length) return null;
  const pick = (values) => {
    const defined = values.filter((value) => typeof value === "number");
    if (!defined.length) return undefined;
    const { n, p50, p95, max } = summary(defined);
    return { n, p50, p95, max };
  };
  const phases = {};
  for (const name of [
    "spawnToProcess",
    "processToEntry",
    "extract",
    "roleEvaluation",
    "roleToReady",
    "entryToReady",
    "spawnToReady",
  ])
    phases[name] = pick(traced.map((run) => run[name]));
  const files = {};
  for (const name of new Set(traced.flatMap((run) => Object.keys(run.files))))
    for (const action of ["written", "verified"]) {
      const values = traced
        .map((run) => run.files[name])
        .filter((file) => file?.action === action)
        .map((file) => file.ms);
      if (values.length) (files[name] ??= {})[action] = pick(values);
    }
  const helpers = {};
  for (const name of new Set(
    traced.flatMap((run) => Object.keys(run.helpers)),
  )) {
    const values = traced.map((run) => run.helpers[name]).filter(Boolean);
    helpers[name] = {
      startsPerRun: pick(traced.map((run) => run.helpers[name]?.starts ?? 0)),
      startedAfterEntry: pick(values.map((value) => value.startedAfterEntry)),
      spawned: pick(values.map((value) => value.spawned)),
      output: pick(values.map((value) => value.output)),
      exit: pick(values.map((value) => value.exit)),
    };
  }
  return { traced: traced.length, ...phases, files, helpers };
}

const temporary = (prefix) => mkdtemp(path.join(tmpdir(), prefix));
const remove = (directory) =>
  rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });

async function stop(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code, signal] = await exited;
  clearTimeout(timer);
  return { code, signal };
}

/** Epoch milliseconds, comparable with the child's performance.timeOrigin. */
const epoch = () => performance.timeOrigin + performance.now();

/**
 * Spawn a Gateway and resolve with its ready record, the time to it, and the phase trace
 * events its stderr carried until then (none without HARNESSHUB_SEA_TRACE).
 */
async function startGateway(command, args, { cwd, env }) {
  const spawnedAt = epoch();
  const started = performance.now();
  const events = [];
  let partial = "";
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr = (stderr + data).slice(-20_000);
    const lines = (partial + data).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith('{"event":"sea.trace"')) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* A trace line is written whole; anything else is not a trace. */
      }
    }
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ready line within ${READY_TIMEOUT_MS} ms`)),
        READY_TIMEOUT_MS,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code ?? signal} before ready`));
      });
      child.stdout.setEncoding("utf8").on("data", (data) => {
        stdout += data;
        for (const line of stdout.split("\n")) {
          if (!line.startsWith("{")) continue;
          try {
            const record = JSON.parse(line);
            if (record.event !== "ready") continue;
            clearTimeout(timer);
            resolve({
              record,
              ms: performance.now() - started,
              spawnedAt,
              readyAt: epoch(),
              events,
            });
          } catch {
            /* An incomplete line is completed by the next chunk. */
          }
        }
      });
    });
    return { child, ...ready, stderr: () => stderr };
  } catch (error) {
    await stop(child);
    throw new Error(`${error.message}; stderr: ${stderr.slice(-2000)}`);
  }
}

/**
 * One series of starts, each with a fresh data directory; `root` decides the SEA root, and
 * `trace` turns on the executable's phase trace.
 */
async function series({ command, prefixArgs, runs, root, trace = false }) {
  const samples = [];
  const phases = [];
  const failures = [];
  let warmUpMs = null;
  for (let index = 0; index <= runs; index += 1) {
    const directory = await temporary("hh-sea-start-");
    try {
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace);
      // Measurements never refresh the model catalog from the network.
      const env = { ...process.env, HH_OFFLINE: "1" };
      const seaRoot =
        root === "fresh" ? path.join(directory, "sea-root") : root;
      if (seaRoot) env.HARNESSHUB_SEA_ROOT = seaRoot;
      if (trace) env.HARNESSHUB_SEA_TRACE = "1";
      else delete env.HARNESSHUB_SEA_TRACE;
      const started = await startGateway(
        command,
        [
          ...prefixArgs,
          "--demo",
          "--port",
          "0",
          "--data-dir",
          path.join(directory, "data"),
        ],
        { cwd: workspace, env },
      );
      await stop(started.child);
      // The first start warms the page cache for the executable; it is reported, not measured.
      if (index > 0) {
        samples.push(started.ms);
        if (trace) phases.push(phasesOf(started));
      } else warmUpMs = round(started.ms);
    } catch (error) {
      failures.push(error.message);
    } finally {
      await remove(directory);
    }
  }
  return {
    ...summary(samples),
    warmUpMs,
    failures,
    ...(trace ? { phases: phaseSummary(phases) } : {}),
    // Per start, in order, for the phases file only: a slow start shows where it lost time.
    ...(trace ? { phaseRuns: phases } : {}),
  };
}

/** Run to exit; `input` is written to stdin, which is then closed. */
function capture(command, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data) => (stdout += data));
    child.stderr.setEncoding("utf8").on("data", (data) => (stderr += data));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The system secret helper each platform embeds, relative to the extraction root. */
const SECRET_HELPERS = {
  darwin: "packages/secrets/dist/native/harnesshub-keychain",
  win32: "packages/secrets/dist/native/harnesshub-secrets.exe",
};

/** @param {object | null} build The build record (build.json) of the binary, if any. */
async function endToEnd(binary, build) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({
      name,
      ok: Boolean(ok),
      ...(detail === undefined ? {} : { detail }),
    });
    return Boolean(ok);
  };
  const attempt = async (name, body) => {
    try {
      await body();
    } catch (error) {
      check(name, false, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const directory = await temporary("hh-sea-e2e-");
  const key = `sea-spike-${randomUUID()}`;
  const env = {
    ...process.env,
    HH_OFFLINE: "1",
    HARNESSHUB_SEA_ROOT: path.join(directory, "sea-root"),
    [UPSTREAM_KEY_ENV]: key,
  };
  const workspace = path.join(directory, "workspace");
  const dataDir = path.join(directory, "data");
  await mkdir(workspace);
  const provider = await startFakeProvider({
    models: ["upstream-sim"],
    keys: { sea: key },
  });
  let gateway;
  try {
    await attempt("version.build-identity", async () => {
      const result = await capture(binary, ["version", "--json"], env);
      const reported = JSON.parse(result.stdout);
      const written = JSON.parse(
        await readFile(
          path.join(ROOT, "packages", "daemon", "dist", "build-info.json"),
          "utf8",
        ),
      );
      const differing = Object.keys({ ...written, ...reported }).filter(
        (field) =>
          field !== "installMethod" &&
          JSON.stringify(written[field]) !== JSON.stringify(reported[field]),
      );
      check(
        "version.build-identity",
        result.code === 0 &&
          !differing.length &&
          reported.installMethod === "sea",
        {
          commit: reported.commit,
          dirty: reported.dirty,
          installMethod: reported.installMethod,
          differing,
        },
      );
    });

    const serveArgs = ["serve", "--demo", "--port", "0", "--data-dir", dataDir];
    // The secret helper the executable extracted must be the one it embedded.
    // Only the file is read: no secret store is touched.
    await attempt("asset.secret-helper", async () => {
      const relative = SECRET_HELPERS[process.platform];
      if (!relative) {
        check("asset.secret-helper", true, {
          skipped: `no system secret helper on ${process.platform}; secrets use environment and file references`,
        });
        return;
      }
      const recorded = build?.assetSha256?.[relative] ?? null;
      const actual = createHash("sha256")
        .update(
          await readFile(
            path.join(env.HARNESSHUB_SEA_ROOT, ...relative.split("/")),
          ),
        )
        .digest("hex");
      check("asset.secret-helper", recorded !== null && actual === recorded, {
        path: relative,
        recorded,
        actual,
      });
    });
    await attempt("serve.ready", async () => {
      gateway = await startGateway(binary, serveArgs, { cwd: workspace, env });
      check("serve.ready", true, {
        ms: round(gateway.ms),
        engine: gateway.record.engine,
      });
    });
    if (!gateway) return checks;
    // The embedded console: the page and the script it loads, from the extracted build.
    await attempt("console.page", async () => {
      const page = await fetch(`${gateway.record.url}/`, {
        headers: { accept: "text/html" },
      });
      const html = await page.text();
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      const asset = script
        ? await fetch(`${gateway.record.url}${script}`)
        : undefined;
      await asset?.arrayBuffer();
      check(
        "console.page",
        page.status === 200 &&
          html.includes('id="root"') &&
          page.headers.get("content-security-policy") !== null &&
          asset?.status === 200,
        { status: page.status, script: script ?? null, asset: asset?.status ?? null },
      );
    });
    // Read per request: the crash-recovery check restarts the Gateway on a new port.
    const api = async (method, route, body) => {
      const response = await fetch(gateway.record.url + route, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `${method} ${route}: HTTP ${response.status} ${text.slice(0, 500)}`,
        );
      return text ? JSON.parse(text) : undefined;
    };
    const runToEnd = async (sessionId, text) => {
      const accepted = await api("POST", `/v1/sessions/${sessionId}/runs`, {
        text,
        timeoutMs: 60_000,
      });
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      for (;;) {
        const view = await api("GET", `/v1/runs/${accepted.id}`);
        if (view.finishedAt) return view;
        if (Date.now() > deadline)
          throw new Error(
            `Run ${accepted.id} did not finish; status ${view.status}`,
          );
        await delay(50);
      }
    };
    const gatewayLog = async () =>
      (await readFile(gateway.record.log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const runSummary = (view) => ({
      status: view.status,
      stopReason: view.stopReason,
      output: view.output,
      cleanupStatus: view.cleanupStatus,
      error: view.error ?? null,
    });

    // Our own scripts that other processes start with process.execPath: the engine launcher
    // and the managed command MCP server now re-execute the SEA with their role entry.
    const root = env.HARNESSHUB_SEA_ROOT;
    await attempt("role.launch-engine", async () => {
      const result = await capture(
        binary,
        [
          path.join(root, "packages", "agents", "assets", "launch-engine.mjs"),
          "HH_SEA_LAUNCH=launched",
          "--",
          process.execPath,
          "-e",
          "process.stdout.write(process.env.HH_SEA_LAUNCH ?? '')",
        ],
        env,
      );
      check(
        "role.launch-engine",
        result.code === 0 && result.stdout === "launched",
        {
          code: result.code,
          stdout: result.stdout.slice(0, 200),
          stderr: result.stderr.slice(0, 500),
        },
      );
    });
    await attempt("role.command-mcp", async () => {
      const tools = [
        {
          name: "sea_echo",
          command: process.execPath,
          prefixArgs: ["-e", "process.stdout.write('echo')"],
        },
      ];
      const requests = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ];
      const result = await capture(
        binary,
        [
          path.join(
            root,
            "packages",
            "daemon",
            "dist",
            "src",
            "command-mcp-main.js",
          ),
          "--workspace",
          workspace,
        ],
        { ...env, HHCAP_CLI_TOOLS_JSON: JSON.stringify(tools) },
        requests.map((request) => `${JSON.stringify(request)}\n`).join(""),
      );
      const responses = result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const listed =
        responses.find((response) => response.id === 2)?.result?.tools ?? [];
      check(
        "role.command-mcp",
        listed.some((tool) => tool.name === "cli_sea_echo"),
        {
          code: result.code,
          responses: responses.length,
          tools: listed.map((tool) => tool.name),
          stderr: result.stderr.slice(0, 500),
        },
      );
    });

    await attempt("demo.run", async () => {
      const text = "hello from the single executable";
      const session = await api("POST", "/v1/sessions", {});
      const view = await runToEnd(session.id, text);
      const log = await gatewayLog();
      const spawned = log.find(
        (record) =>
          record.event === "worker.spawn" && record.sessionId === session.id,
      );
      const ready = log.find(
        (record) =>
          record.event === "worker.ready" && record.sessionId === session.id,
      );
      check(
        "demo.run",
        view.status === "completed" && view.output === text && ready,
        {
          ...runSummary(view),
          workerPid: spawned?.pid ?? null,
          workerReadyMs: ready?.ms ?? null,
        },
      );
      await api("POST", `/v1/sessions/${session.id}/close`);
    });

    const peers = [
      [
        "gateway.call",
        "sea-gateway-peer",
        [process.execPath, PEER, "opencode"],
      ],
      [
        "gateway.call.node-compat",
        "sea-node-compat-peer",
        [binary, PEER, "opencode"],
      ],
    ];
    for (const [name, engineId, command] of peers)
      await attempt(name, async () => {
        await api("POST", "/v1/engines", {
          id: engineId,
          driver: "acp",
          command,
          model: "upstream-sim",
          configuration: {
            adapter: "opencode",
            provider: {
              protocol: "openai-completions",
              baseUrl: `${provider.url}/v1`,
              apiKey: { kind: "env", value: UPSTREAM_KEY_ENV },
            },
          },
        });
        const before = provider.records().length;
        const session = await api("POST", "/v1/sessions", { engineId });
        const view = await runToEnd(
          session.id,
          "hello through the model gateway",
        );
        await provider.idle();
        const upstream = provider
          .records()
          .slice(before)
          .filter((record) => record.path === "/v1/chat/completions");
        const calls = (await gatewayLog()).filter(
          (record) => record.event === "model.call" && record.runId === view.id,
        );
        check(
          name,
          view.status === "completed" &&
            view.output === "OK" &&
            upstream.length === 1 &&
            upstream[0].status === 200 &&
            upstream[0].auth === "ok" &&
            upstream[0].keyId === "sea" &&
            upstream[0].violations.length === 0 &&
            calls.length === 1 &&
            calls[0].ok === true,
          {
            ...runSummary(view),
            upstream: upstream.map(
              ({ status, auth, keyId, violations, durationMs }) => ({
                status,
                auth,
                keyId,
                violations,
                durationMs,
              }),
            ),
            modelCalls: calls.map(
              ({ ok, status, inbound, finishReason, ms }) => ({
                ok,
                status,
                inbound,
                finishReason,
                ms,
              }),
            ),
          },
        );
        await api("POST", `/v1/sessions/${session.id}/close`);
      });

    // Crash recovery identifies a surviving Worker by its command line (POSIX) or its Job
    // (Windows); both now name the executable and the role entry under the extraction root.
    await attempt("recovery.after-crash", async () => {
      const session = await api("POST", "/v1/sessions", {});
      const accepted = await api("POST", `/v1/sessions/${session.id}/runs`, {
        text: "wait for crash",
        fixture: { scenario: "wait" },
        timeoutMs: 60_000,
      });
      const deadline = Date.now() + 10_000;
      while (
        (await api("GET", `/v1/runs/${accepted.id}`)).status !== "running"
      ) {
        if (Date.now() > deadline) throw new Error("Run did not start");
        await delay(20);
      }
      const workerPid = (await gatewayLog()).find(
        (record) =>
          record.event === "worker.spawn" && record.sessionId === session.id,
      )?.pid;
      // The same comparison packages/runtime/src/process/leases.ts makes before it may signal a recovered Worker.
      let leaseIdentity = "not-applicable";
      if (process.platform !== "win32") {
        const lease = JSON.parse(
          await readFile(
            path.join(
              dataDir,
              "workers",
              `${encodeURIComponent(session.id)}.json`,
            ),
            "utf8",
          ),
        );
        const ps = await capture(
          "/bin/ps",
          ["-ww", "-p", String(lease.pid), "-o", "pid=,pgid=,command="],
          {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
          },
        );
        const command = /^\s*\d+\s+\d+\s+([^\r\n]+)\s*$/
          .exec(ps.stdout)?.[1]
          ?.trimEnd();
        leaseIdentity =
          command ===
          `${lease.executable} ${lease.workerPath} --harnesshub-owner=${lease.ownerToken}`
            ? "match"
            : `mismatch: ${command}`;
      }
      const exited = once(gateway.child, "exit");
      gateway.child.kill("SIGKILL");
      await exited;
      gateway = undefined;
      gateway = await startGateway(binary, serveArgs, { cwd: workspace, env });
      const view = await api("GET", `/v1/runs/${accepted.id}`);
      check(
        "recovery.after-crash",
        view.status === "interrupted" &&
          view.stopReason === "gateway_restarted" &&
          view.cleanupStatus === "confirmed" &&
          ["match", "not-applicable"].includes(leaseIdentity),
        {
          ...runSummary(view),
          workerPid: workerPid ?? null,
          leaseIdentity,
          restartMs: round(gateway.ms),
        },
      );
    });
    if (!gateway) return checks;

    const exit = await stop(gateway.child);
    gateway = undefined;
    if (process.platform !== "win32")
      check("serve.stop", exit.code === 0, exit);
    return checks;
  } finally {
    if (gateway) await stop(gateway.child);
    await provider.close();
    await remove(directory);
  }
}

/** The phase tables of the step summary: first run beside installed, p50/p95 ms. */
function phasesMarkdown(coldStart) {
  const first = coldStart.firstRun.phases;
  const installed = coldStart.installed.phases;
  if (!first && !installed) return "";
  const cell = (value) => (value ? `${value.p50} / ${value.p95}` : "-");
  const rows = [
    "\n| Phase (p50 / p95 ms) | first run | installed |\n|---|---|---|\n",
  ];
  for (const name of [
    "spawnToProcess",
    "processToEntry",
    "extract",
    "roleEvaluation",
    "roleToReady",
    "entryToReady",
    "spawnToReady",
  ])
    rows.push(
      `| ${name} | ${cell(first?.[name])} | ${cell(installed?.[name])} |\n`,
    );
  for (const name of new Set([
    ...Object.keys(first?.helpers ?? {}),
    ...Object.keys(installed?.helpers ?? {}),
  ]))
    for (const step of ["startedAfterEntry", "spawned", "output", "exit"])
      rows.push(
        `| helper ${name} ${step} | ${cell(first?.helpers[name]?.[step])} | ${cell(installed?.helpers[name]?.[step])} |\n`,
      );
  for (const name of Object.keys(first?.files ?? {}))
    rows.push(
      `| extract ${name} (written / verified) | ${cell(first.files[name].written)} | ${cell(installed?.files[name]?.verified)} |\n`,
    );
  return rows.join("");
}

function markdownSummary(result, file) {
  const series = (name, value) =>
    value
      ? `| ${name} | ${value.p50 ?? "-"} | ${value.p95 ?? "-"} | ${value.warmUpMs ?? "-"} | ${value.failures.length} |\n`
      : "";
  return [
    `### SEA ${result.platform}-${result.arch} (${result.ok ? "passed" : "FAILED"}): ${file}\n\n`,
    `Binary ${result.binary.mib} MiB (${result.binary.bytes} bytes); commit ${result.commit ?? "unknown"}.\n\n`,
    "| Start series | p50 ms | p95 ms | warm-up ms | failures |\n|---|---|---|---|---|\n",
    series("first run (fresh root)", result.coldStartMs.firstRun),
    series("installed (prepared root)", result.coldStartMs.installed),
    series(
      "node packages/daemon/dist/src/main.js",
      result.coldStartMs.nodeBaseline,
    ),
    phasesMarkdown(result.coldStartMs),
    "\n| Check | Result |\n|---|---|\n",
    ...result.e2e.checks.map(
      (item) => `| ${item.name} | ${item.ok ? "pass" : "FAIL"} |\n`,
    ),
    "\n",
  ].join("");
}

async function main() {
  const { values } = parseArgs({
    options: {
      binary: { type: "string" },
      runs: { type: "string", default: "10" },
      out: { type: "string" },
      "phases-out": { type: "string" },
      baseline: { type: "boolean", default: false },
    },
  });
  const binary = path.resolve(
    values.binary ??
      path.join(
        ROOT,
        "dist",
        "sea",
        process.platform === "win32" ? "harnesshub.exe" : "harnesshub",
      ),
  );
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error("--runs must be a positive integer");
  const out = path.resolve(
    values.out ?? path.join(ROOT, "dist", "sea", "result.json"),
  );
  let build = null;
  try {
    build = JSON.parse(
      await readFile(path.join(path.dirname(binary), "build.json"), "utf8"),
    );
  } catch {
    /* A binary built elsewhere has no build record next to it. */
  }
  const size = (await stat(binary)).size;

  const installedRoot = await temporary("hh-sea-root-");
  let coldStart;
  try {
    const prepared = await capture(binary, ["version"], {
      ...process.env,
      HARNESSHUB_SEA_ROOT: installedRoot,
    });
    if (prepared.code !== 0)
      throw new Error(`version failed: ${prepared.stderr}`);
    coldStart = {
      runs,
      firstRun: await series({
        command: binary,
        prefixArgs: ["serve"],
        runs,
        root: "fresh",
        trace: true,
      }),
      installed: await series({
        command: binary,
        prefixArgs: ["serve"],
        runs,
        root: installedRoot,
        trace: true,
      }),
      ...(values.baseline
        ? {
            nodeBaseline: await series({
              command: process.execPath,
              prefixArgs: [
                path.join(ROOT, "packages", "daemon", "dist", "src", "main.js"),
              ],
              runs,
            }),
          }
        : {}),
    };
  } finally {
    await remove(installedRoot);
  }
  const checks = await endToEnd(binary, build);
  const startsOk = [
    coldStart.firstRun,
    coldStart.installed,
    coldStart.nodeBaseline,
  ]
    .filter(Boolean)
    .every((result) => result.failures.length === 0 && result.n === runs);
  const e2eOk = checks.length > 0 && checks.every((item) => item.ok);
  const result = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    measuredAt: new Date().toISOString(),
    commit: build?.commit ?? null,
    binary: {
      file: path.basename(binary),
      bytes: size,
      mib: round(size / 2 ** 20),
    },
    build: build ? { buildId: build.buildId, sizes: build.sizes } : null,
    coldStartMs: Object.fromEntries(
      Object.entries(coldStart).map(([name, value]) => {
        if (typeof value !== "object" || value === null) return [name, value];
        const { phaseRuns: _phaseRuns, ...rest } = value;
        return [name, rest];
      }),
    ),
    e2e: { ok: e2eOk, checks },
    adrP01: {
      coldStartLimitMs: LIMITS.coldStartMs,
      firstRunP95Ms: coldStart.firstRun.p95 ?? null,
      installedP95Ms: coldStart.installed.p95 ?? null,
      coldStartWithinLimit:
        (coldStart.firstRun.p95 ?? Infinity) <= LIMITS.coldStartMs,
      sizeLimitBytes: LIMITS.sizeBytes,
      sizeWithinLimit: size <= LIMITS.sizeBytes,
    },
    ok: startsOk && e2eOk,
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  if (values["phases-out"]) {
    const phasesOut = path.resolve(values["phases-out"]);
    await mkdir(path.dirname(phasesOut), { recursive: true });
    await writeFile(
      phasesOut,
      `${JSON.stringify(
        {
          platform: result.platform,
          arch: result.arch,
          commit: result.commit,
          measuredAt: result.measuredAt,
          firstRun: coldStart.firstRun.phases ?? null,
          installed: coldStart.installed.phases ?? null,
          firstRunStarts: coldStart.firstRun.phaseRuns ?? [],
          installedStarts: coldStart.installed.phaseRuns ?? [],
        },
        null,
        2,
      )}\n`,
    );
  }
  console.log(
    JSON.stringify({
      event: "sea.measured",
      out,
      ok: result.ok,
      adrP01: result.adrP01,
    }),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      markdownSummary(result, path.basename(out)),
    );
  for (const item of checks) if (!item.ok) console.error(JSON.stringify(item));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
