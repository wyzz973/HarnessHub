#!/usr/bin/env node
/**
 * Engine acceptance matrix for a competition layout. For each engine it starts the
 * layout launcher with only `AGENT_ENGINE=<id>` selecting the engine, waits for
 * GET /health/ready, runs scripts/competition-acceptance.mjs in a child process, stops
 * the whole process tree and moves on; one engine failing never stops the others.
 *
 * Model sources (exactly one):
 * - `--mock`: starts scripts/mock-company-model.mjs with a random throw-away key and sets
 *   HARNESSHUB_MODEL=company-sim, HARNESSHUB_MODEL_BASE_URL and HARNESSHUB_MODEL_API_KEY for
 *   the Gateway. Evidence is protocol-level only, never a real-model pass.
 * - default: HARNESSHUB_MODEL* already present in this process environment (for example a
 *   developer's real model); `--strict-proxy <upstream /v1 URL>` additionally routes the
 *   Gateway through scripts/strict-chat-proxy.mjs.
 * Vendor credential variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, ...) are
 * removed from every Gateway environment so engines can only use the unified model.
 *
 * Writes <out>/matrix.json, <out>/summary.md, per-engine acceptance JSON/logs, redacted
 * Gateway logs and bounded copies of new *.log files under <bundle>/state. Exit code:
 * 0 all engines PASS, 1 otherwise, 2 usage error.
 *
 * Usage: node scripts/competition-matrix.mjs --bundle DIR --engines opencode,codex --out DIR
 *   [--scenario mock|full] [--mock] [--mock-quirks] [--strict-proxy URL] [--entry LAUNCHER]
 *   [--engine-timeout-ms 360000] [--with-console] [--summary FILE]
 */
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  httpRequest,
  raceTimeout,
  waitUntil,
} from "./lib/competition-client.mjs";
import {
  freePort,
  redactor,
  startLoggedProcess,
  vendorCredentialNames,
  waitForPortsClosed,
  withoutVendorCredentials,
} from "./lib/competition-process.mjs";
import { startMockCompanyModel } from "./mock-company-model.mjs";
import { defaultLauncher } from "./competition-selftest.mjs";
import { startStrictChatProxy } from "./strict-chat-proxy.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

function safeName(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 60) || "engine"
  );
}

function tally(values) {
  const result = {};
  for (const value of values) {
    const key = String(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function collectStateLogs(stateDirectory, since, target, redact) {
  const copied = [];
  const walk = async (directory, relative, depth) => {
    if (depth > 8 || copied.length >= 40) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (copied.length >= 40) return;
      const file = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file, name, depth + 1);
      else if (entry.isFile() && /\.log$/i.test(entry.name)) {
        const info = await stat(file);
        if (info.mtimeMs < since) continue;
        const bytes = await readFile(file);
        const text = bytes
          .subarray(Math.max(0, bytes.length - 512 * 1024))
          .toString("utf8");
        await mkdir(target, { recursive: true });
        await writeFile(
          path.join(target, name.replaceAll("/", "__")),
          redact(text),
        );
        copied.push(name);
      }
    }
  };
  await walk(stateDirectory, "", 0);
  return copied;
}

function cell(step) {
  if (!step) return "–";
  if (step.status === "SKIP") return "SKIP";
  return step.status;
}

/** Markdown summary of a matrix result. */
export function matrixSummary(result) {
  const lines = [
    `## HarnessHub competition acceptance (${result.platform}, scenario: ${result.scenario})`,
    "",
    `> ${result.evidence}`,
    "",
    `Layout: \`${result.bundle}\` · launcher: \`${path.basename(result.entry)}\` · engine selection: \`AGENT_ENGINE\` only · expected upstream model: \`${result.expectModel ?? "unknown"}\``,
    "",
    "| Engine | Result | Reply OK | Tool / file tasks | Abort → idle | model.call (unified) | Upstream requests | Duration | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const engine of result.engines) {
    const steps = Object.fromEntries(
      (engine.acceptance?.steps ?? []).map((step) => [step.id, step]),
    );
    const tool =
      result.scenario === "mock"
        ? `${cell(steps["tool-marker"])}${engine.upstream?.toolCalls?.length ? ` (${engine.upstream.toolCalls.join(", ")}; reasoning echo: ${engine.upstream.reasoningEcho.join(", ") || "none"})` : ""}`
        : `file ${cell(steps["file-task"])} / shell ${cell(steps["shell-task"])}`;
    const calls = engine.acceptance?.modelCalls;
    const modelCell = calls
      ? `${cell(steps["model-calls"])} ${calls.total} (${Object.keys(calls.upstreamModels).join(", ") || "none"})`
      : cell(steps["model-calls"]);
    const upstream = engine.upstream
      ? `${engine.upstream.requests}${engine.upstream.violations.length ? ` ⚠ ${engine.upstream.violations.length} rejected` : ""}`
      : "–";
    const notes = engine.notes.join("; ").replaceAll("|", "\\|").slice(0, 300);
    // Mock scenario only: the fixed Chinese/emoji line must survive the engine's output path.
    const reply = `${cell(steps["prompt-ok"])}${steps["unicode-reply"] ? ` · non-ASCII ${cell(steps["unicode-reply"])}` : ""}`;
    lines.push(
      `| ${engine.engine} | **${engine.status}** | ${reply} | ${tool} | ${cell(steps.abort)} | ${modelCell} | ${upstream} | ${Math.round(engine.durationMs / 1000)} s | ${notes} |`,
    );
  }
  const passed = result.engines.filter(
    (engine) => engine.status === "PASS",
  ).length;
  lines.push(
    "",
    `**${passed}/${result.engines.length} engines passed.** Artifacts: matrix.json, acceptance-<engine>.json/.log, gateway-<engine>.log.`,
    "",
  );
  return lines.join("\n");
}

/**
 * Run the matrix.
 *
 * @param {{bundle: string, engines: string[], out: string, scenario?: "mock"|"full",
 *   mock?: boolean, mockQuirks?: boolean, strictProxy?: string, entry?: string,
 *   engineTimeoutMs?: number, withConsole?: boolean, env?: NodeJS.ProcessEnv,
 *   summaryFile?: string, onEngine?: (record: object) => void}} options `summaryFile`
 *   receives the Markdown summary appended (for $GITHUB_STEP_SUMMARY).
 * @returns {Promise<object>} The matrix document also written to <out>/matrix.json. The
 *   mock upstream / strict proxy and every Gateway started here are stopped before return.
 */
export async function runMatrix(options) {
  const started = Date.now();
  const bundle = path.resolve(options.bundle);
  const entry = path.resolve(options.entry ?? defaultLauncher(bundle));
  const out = path.resolve(options.out);
  const scenario = options.scenario ?? (options.mock ? "mock" : "full");
  const engineTimeoutMs = options.engineTimeoutMs ?? 360_000;
  if (options.mock && options.strictProxy)
    throw new Error("Choose either --mock or --strict-proxy");
  await mkdir(out, { recursive: true });
  const sourceEnv = options.env ?? process.env;
  const env = withoutVendorCredentials(sourceEnv);
  const secrets = [];
  let mock;
  let proxy;
  let expectModel;
  try {
    if (options.mock) {
      const apiKey = `hh-mock-${randomBytes(18).toString("hex")}`;
      secrets.push(apiKey);
      mock = await startMockCompanyModel({
        apiKey,
        quirks: options.mockQuirks === true,
        logFile: path.join(out, "mock-requests.jsonl"),
      });
      Object.assign(env, {
        HARNESSHUB_MODEL: mock.model,
        HARNESSHUB_MODEL_BASE_URL: mock.url,
        HARNESSHUB_MODEL_API_KEY: apiKey,
        HARNESSHUB_MODEL_PROTOCOL: "openai-completions",
      });
    } else {
      if (!env.HARNESSHUB_MODEL || !env.HARNESSHUB_MODEL_BASE_URL)
        throw new Error(
          "Set HARNESSHUB_MODEL and HARNESSHUB_MODEL_BASE_URL, or use --mock",
        );
      if (options.strictProxy) {
        proxy = await startStrictChatProxy({
          upstream: options.strictProxy,
          expectModel: env.HARNESSHUB_MODEL,
          logFile: path.join(out, "strict-proxy-requests.jsonl"),
        });
        env.HARNESSHUB_MODEL_BASE_URL = proxy.url;
      }
    }
    expectModel = env.HARNESSHUB_MODEL;
    if (env.HARNESSHUB_MODEL_API_KEY)
      secrets.push(env.HARNESSHUB_MODEL_API_KEY);
    const redact = redactor(secrets);
    const result = {
      schemaVersion: 1,
      platform: `${process.platform}/${process.arch}`,
      node: process.versions.node,
      scenario,
      evidence:
        scenario === "mock"
          ? "Evidence type: scripted mock company upstream (streaming-only, strict fields, reasoning pass-back enforced). It proves engine startup, protocol conversion, streaming, tool round-trips and completion detection through the unified model gateway. It is NOT a real-model pass."
          : `Evidence type: model ${expectModel} configured through HARNESSHUB_MODEL*${proxy ? " behind the strict streaming-only proxy" : ""}.`,
      bundle,
      entry,
      expectModel,
      removedVendorVariables: vendorCredentialNames(sourceEnv),
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      engines: [],
    };
    for (const engine of options.engines) {
      const record = await runEngine(engine);
      result.engines.push(record);
      options.onEngine?.(record);
    }
    result.finishedAt = new Date().toISOString();
    result.status = result.engines.every((engine) => engine.status === "PASS")
      ? "PASS"
      : "FAIL";
    await writeFile(
      path.join(out, "matrix.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    const summary = matrixSummary(result);
    await writeFile(path.join(out, "summary.md"), summary);
    if (options.summaryFile)
      await appendFile(options.summaryFile, `${summary}\n`);
    return result;

    async function runEngine(engine) {
      const t0 = Date.now();
      const name = safeName(engine);
      const record = {
        engine,
        status: "FAIL",
        durationMs: 0,
        notes: [],
        gateway: {
          ready: false,
          readyMs: null,
          exit: null,
          log: `gateway-${name}.log`,
        },
        acceptance: null,
        upstream: null,
        stateLogs: [],
      };
      const deadline = t0 + engineTimeoutMs;
      const port = await freePort();
      const mark = mock ? (mock.records().at(-1)?.seq ?? 0) : 0;
      let exited;
      const gateway = startLoggedProcess({
        entry,
        args: [
          "--port",
          String(port),
          ...(options.withConsole ? [] : ["--no-console"]),
        ],
        cwd: path.dirname(entry),
        env: { ...env, AGENT_ENGINE: engine },
        logFile: path.join(out, `gateway-${name}.log`),
        redact,
      });
      gateway.exited.then((outcome) => {
        exited = outcome;
      });
      try {
        const ready = await waitUntil(
          async () => {
            if (exited) return "exited";
            const response = await httpRequest(
              `http://127.0.0.1:${port}/health/ready`,
              { timeoutMs: 3000 },
            ).catch(() => undefined);
            return response?.status === 200 ? "ready" : undefined;
          },
          {
            timeoutMs: Math.min(180_000, Math.max(1000, deadline - Date.now())),
            intervalMs: 500,
          },
        );
        if (ready !== "ready") {
          record.notes.push(
            ready === "exited"
              ? `gateway exited before ready (${JSON.stringify(exited)})`
              : "gateway was not ready within the engine budget",
          );
          record.notes.push(
            redact(gateway.tail())
              .split(/\r?\n/)
              .filter(Boolean)
              .slice(-3)
              .join(" / ")
              .slice(0, 400),
          );
          return record;
        }
        record.gateway.ready = true;
        record.gateway.readyMs = Date.now() - t0;
        const budget = Math.max(10_000, deadline - Date.now());
        const acceptance = startLoggedProcess({
          entry: path.join(scriptsDirectory, "competition-acceptance.mjs"),
          args: [
            "--base",
            `http://127.0.0.1:${port}`,
            "--engine",
            engine,
            "--out",
            out,
            "--scenario",
            scenario,
            ...(expectModel ? ["--expect-model", expectModel] : []),
            "--work-root",
            path.join(out, "workspaces"),
            "--prompt-timeout-ms",
            String(Math.min(300_000, budget)),
            "--timeout-ms",
            String(budget),
          ],
          env: withoutVendorCredentials(sourceEnv),
          logFile: path.join(out, `acceptance-${name}.stdout.log`),
          redact,
        });
        const finished = await raceTimeout(acceptance.exited, budget + 15_000);
        if (finished.timedOut) {
          record.status = "TIMEOUT";
          record.notes.push(
            `acceptance exceeded the ${Math.round(engineTimeoutMs / 1000)} s engine budget`,
          );
        }
        await acceptance.stop();
        record.acceptance =
          (await readJson(path.join(out, `acceptance-${name}.json`))) ?? null;
        if (record.acceptance) {
          for (const step of record.acceptance.steps)
            if (step.status === "FAIL" || step.status === "BLOCKED")
              record.notes.push(`${step.id}: ${step.error}`.slice(0, 240));
          if (record.status !== "TIMEOUT")
            record.status = record.acceptance.status;
        } else if (record.status !== "TIMEOUT")
          record.notes.push("acceptance produced no result file");
      } finally {
        await gateway.stop();
        const open = await waitForPortsClosed([port], { timeoutMs: 20_000 });
        if (open.length)
          record.notes.push(`port ${port} still open after stop`);
        record.gateway.exit = exited ?? null;
        if (mock) {
          const requests = mock
            .records()
            .filter(
              (entry) =>
                entry.seq > mark && entry.path === "/v1/chat/completions",
            );
          record.upstream = {
            requests: requests.length,
            models: tally(requests.map((entry) => entry.model)),
            auth: tally(requests.map((entry) => entry.auth)),
            turns: tally(
              requests.map((entry) => entry.turn ?? `http-${entry.status}`),
            ),
            maxTokensFields: tally(
              requests.map((entry) => entry.maxTokensField ?? "none"),
            ),
            violations: [
              ...new Set(requests.flatMap((entry) => entry.violations ?? [])),
            ].slice(0, 10),
            toolCalls: requests
              .filter((entry) => entry.turn === "tool-call")
              .map((entry) => entry.tool),
            reasoningEcho: requests
              .filter((entry) => entry.turn === "tool-result")
              .map((entry) => String(entry.reasoningEcho)),
          };
          if (record.upstream.violations.length) {
            record.notes.push(
              `strict upstream rejected: ${record.upstream.violations.join(" | ")}`.slice(
                0,
                300,
              ),
            );
            if (record.status === "PASS") record.status = "FAIL";
          }
          if (
            Object.keys(record.upstream.auth).some((state) => state !== "ok")
          ) {
            record.notes.push(
              `upstream authentication: ${JSON.stringify(record.upstream.auth)}`,
            );
            if (record.status === "PASS") record.status = "FAIL";
          }
          if (record.status === "PASS" && record.upstream.requests === 0) {
            record.notes.push("no request reached the mock upstream");
            record.status = "FAIL";
          }
        }
        record.stateLogs = await collectStateLogs(
          path.join(bundle, "state"),
          t0,
          path.join(out, "logs", name),
          redact,
        );
        record.durationMs = Date.now() - t0;
      }
      return record;
    }
  } finally {
    await mock?.close();
    await proxy?.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const usage =
    "Usage: node scripts/competition-matrix.mjs --bundle DIR --engines opencode,codex --out DIR [--scenario mock|full] [--mock] [--mock-quirks] [--strict-proxy URL] [--entry LAUNCHER] [--engine-timeout-ms 360000] [--with-console] [--summary FILE]";
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        bundle: { type: "string" },
        engines: { type: "string" },
        out: { type: "string" },
        scenario: { type: "string" },
        mock: { type: "boolean", default: false },
        "mock-quirks": { type: "boolean", default: false },
        "strict-proxy": { type: "string" },
        entry: { type: "string" },
        "engine-timeout-ms": { type: "string", default: "360000" },
        "with-console": { type: "boolean", default: false },
        summary: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
    if (values.help) {
      console.log(usage);
      process.exit(0);
    }
    if (!values.bundle || !values.engines || !values.out)
      throw new Error(usage);
    if (values.scenario && !["mock", "full"].includes(values.scenario))
      throw new Error("--scenario must be mock or full");
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  try {
    const engines = values.engines
      .split(",")
      .map((engine) => engine.trim())
      .filter(Boolean);
    if (!engines.length || new Set(engines).size !== engines.length)
      throw new Error("--engines must list unique ids");
    const engineTimeoutMs = Number(values["engine-timeout-ms"]);
    if (!Number.isInteger(engineTimeoutMs) || engineTimeoutMs < 30_000)
      throw new Error("--engine-timeout-ms must be >= 30000");
    const result = await runMatrix({
      bundle: values.bundle,
      engines,
      out: values.out,
      mock: values.mock,
      mockQuirks: values["mock-quirks"],
      engineTimeoutMs,
      withConsole: values["with-console"],
      onEngine: (record) =>
        console.log(
          JSON.stringify({
            event: "competition.matrix.engine",
            engine: record.engine,
            status: record.status,
            durationMs: record.durationMs,
            notes: record.notes,
          }),
        ),
      ...(values.scenario ? { scenario: values.scenario } : {}),
      ...(values["strict-proxy"]
        ? { strictProxy: values["strict-proxy"] }
        : {}),
      ...(values.entry ? { entry: values.entry } : {}),
      ...(values.summary ? { summaryFile: path.resolve(values.summary) } : {}),
    });
    console.log(
      JSON.stringify({
        event: "competition.matrix",
        status: result.status,
        engines: Object.fromEntries(
          result.engines.map((engine) => [engine.engine, engine.status]),
        ),
        out: path.resolve(values.out),
      }),
    );
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
