#!/usr/bin/env node
/**
 * Competition API v1.1 acceptance for one running HarnessHub competition Gateway.
 *
 * Scenarios (`--scenario`):
 * - `full` (real model, default): POST /session with a directory that does not exist yet
 *   (must be created) -> "reply OK" -> file task (hello.txt with a nonce) -> shell task
 *   (a command writes shell.txt and prints it) -> abort a long task -> model.call
 *   statistics -> DELETE /session.
 * - `mock` (scripts/mock-company-model.mjs upstream): "reply OK" -> HH_MOCK_TOOL round
 *   (tool call + reasoning pass-back + mock-ok.txt marker; SKIP when the engine exposes no
 *   shell-like tool) -> abort an HH_MOCK_SLOW stream -> model.call statistics -> DELETE.
 *   Mock results prove the protocol chain only; they are not a real-model pass.
 *
 * Every prompt must return 204, the last assistant message must have info.finish=stop and
 * a step-finish part, and GET /event must report busy then idle for the session. Every
 * completed prompt run must have model.call events (GET /v1/runs/{id}/event-log) and all
 * of them must name the unified upstream model (`--expect-model`, else GET /v1/harness/model).
 *
 * The script reads no credential files or variables. It writes
 * <out>/acceptance-<engine>.json and <out>/acceptance-<engine>.log.
 * Exit code: 0 PASS, 1 FAIL, 2 usage error.
 *
 * Usage: node scripts/competition-acceptance.mjs --base http://127.0.0.1:6217 --engine opencode
 *   --out DIR [--scenario full|mock] [--expect-model ID] [--work-root DIR]
 *   [--prompt-timeout-ms 300000] [--timeout-ms 1200000]
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  httpRequest,
  raceTimeout,
  subscribeEvents,
  summarizeBody,
  waitUntil,
} from "./lib/competition-client.mjs";
import { decodeText } from "./lib/competition-process.mjs";
import {
  MOCK_MARKER_FILE,
  MOCK_MARKER_TEXT,
  mockDirectives,
  mockReplies,
} from "./mock-company-model.mjs";

export const ACCEPTANCE_SCHEMA_VERSION = 1;
const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Prompts and expected evidence for one acceptance run. */
export function acceptancePrompts(nonce, platform = process.platform) {
  const windows = platform === "win32";
  const shellExpected = `HH-42-${nonce}`;
  const shellCommand = windows
    ? `powershell -NoProfile -Command "Set-Content -Path shell.txt -Value ('HH-' + (6*7) + '-${nonce}'); Get-Content shell.txt"`
    : `sh -c 'echo HH-$((6*7))-${nonce} > shell.txt && cat shell.txt'`;
  const longCommand = windows
    ? `powershell -NoProfile -Command "Start-Sleep -Seconds 600"`
    : "sleep 600";
  return {
    ok: "只回复 OK 两个大写字母，不要输出任何其他内容。Reply with exactly: OK",
    file: {
      name: "hello.txt",
      expected: `HarnessHub-${nonce}`,
      text: `在当前工作目录中创建文件 hello.txt，文件内容必须恰好是下面这一行（不要引号，不要其他内容）：\nHarnessHub-${nonce}\n完成后只回复 DONE。`,
    },
    shell: {
      name: "shell.txt",
      expected: shellExpected,
      command: shellCommand,
      text: `请使用你的命令行/终端工具，在当前工作目录中原样执行下面这条命令（不要改用其他方式写文件），然后把命令输出原样回复给我：\n${shellCommand}`,
    },
    long: {
      command: longCommand,
      text: `请使用你的命令行/终端工具执行下面这条命令，并等待它自然结束后再回复 DONE：\n${longCommand}`,
    },
    tool: `${mockDirectives.tool} 请调用你的 shell 工具执行一次命令，在当前目录创建 ${MOCK_MARKER_FILE}，然后只回复 DONE。`,
    slow: `${mockDirectives.slow} 这是一个很长的任务，请持续工作直到被中止。`,
  };
}

/** Plain text of a competition message (string content or text parts). */
export function replyText(message) {
  if (!isObject(message)) return "";
  if (typeof message.content === "string" && message.content)
    return message.content;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part) => isObject(part) && part.type === "text")
    .map((part) =>
      typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : "",
    )
    .join("");
}

async function readTextFile(file) {
  try {
    return decodeText(await readFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function fail(problems) {
  if (problems.length) throw new Error(problems.join("; "));
}

function tally(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function safeName(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 60) || "engine"
  );
}

/**
 * Run the acceptance sequence.
 *
 * @param {{base: string, engine: string, out: string, scenario?: "full"|"mock",
 *   expectModel?: string, workRoot?: string, promptTimeoutMs?: number, timeoutMs?: number,
 *   providerId?: string, platform?: NodeJS.Platform, abortSettleMs?: number}} input
 * @returns {Promise<object>} The JSON document also written to <out>/acceptance-<engine>.json.
 */
export async function runAcceptance(input) {
  const scenario = input.scenario ?? "full";
  if (!["full", "mock"].includes(scenario))
    throw new Error("--scenario must be full or mock");
  const base = new URL(input.base).href.replace(/\/+$/, "");
  const engine = input.engine;
  const promptTimeoutMs = input.promptTimeoutMs ?? 300_000;
  const started = Date.now();
  const deadline = started + (input.timeoutMs ?? 1_200_000);
  const nonce = randomBytes(4).toString("hex");
  const prompts = acceptancePrompts(nonce, input.platform ?? process.platform);
  const out = path.resolve(input.out);
  await mkdir(out, { recursive: true });
  const logLines = [];
  const note = (message) =>
    logLines.push(`${new Date().toISOString()} ${message}`);
  const steps = [];
  const sseEvents = [];
  const result = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    engine,
    base,
    scenario,
    evidence:
      scenario === "mock"
        ? "scripted mock upstream (protocol chain only, not a real-model pass)"
        : "model configured in the Gateway environment",
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: 0,
    status: "FAIL",
    skipped: [],
    steps,
    session: { id: null, directory: null, files: [] },
    runtimeInfo: null,
    harnessModel: null,
    modelCalls: null,
    sse: null,
  };
  let sessionId;
  let directory;
  let stream;

  const remaining = (limit) =>
    Math.max(1000, Math.min(limit, deadline - Date.now()));
  const call = async (method, pathname, options = {}) => {
    const t0 = Date.now();
    try {
      const response = await httpRequest(`${base}${pathname}`, {
        method,
        ...(options.body !== undefined ? { body: options.body } : {}),
        timeoutMs: remaining(options.timeoutMs ?? 30_000),
      });
      if (!options.quiet || response.status >= 400)
        note(
          `${method} ${pathname} -> ${response.status} (${Date.now() - t0} ms)`,
        );
      return response;
    } catch (error) {
      note(
        `${method} ${pathname} -> ERROR ${error.code ?? ""} ${error.message} (${Date.now() - t0} ms)`,
      );
      throw error;
    }
  };
  const runStep = async (id, action, requires = []) => {
    const entry = {
      id,
      status: "PASS",
      durationMs: 0,
      detail: {},
      error: null,
    };
    steps.push(entry);
    const blocker = requires.find(
      (dependency) =>
        steps.find((step) => step.id === dependency)?.status !== "PASS",
    );
    if (blocker) {
      entry.status = "BLOCKED";
      entry.error = `requires ${blocker}`;
      note(`step ${id}: BLOCKED by ${blocker}`);
      return entry;
    }
    if (Date.now() >= deadline) {
      entry.status = "FAIL";
      entry.error = "overall acceptance deadline exceeded before this step";
      note(`step ${id}: FAIL (deadline)`);
      return entry;
    }
    const t0 = Date.now();
    try {
      const outcome = await action(entry.detail);
      if (outcome?.skip) {
        entry.status = "SKIP";
        entry.error = outcome.skip;
      }
    } catch (error) {
      entry.status = "FAIL";
      entry.error = error instanceof Error ? error.message : String(error);
    }
    entry.durationMs = Date.now() - t0;
    note(
      `step ${id}: ${entry.status}${entry.error ? ` - ${entry.error}` : ""} (${entry.durationMs} ms)`,
    );
    return entry;
  };

  const statusEvents = (from) =>
    sseEvents
      .slice(from)
      .filter(
        (event) =>
          event.sessionID === sessionId &&
          (event.type === "session.status" || event.type === "session.idle"),
      );
  const sawBusyThenIdle = (from) => {
    const events = statusEvents(from);
    const busy = events.findIndex((event) => event.status === "busy");
    return (
      busy >= 0 &&
      events
        .slice(busy + 1)
        .some(
          (event) => event.status === "idle" || event.type === "session.idle",
        )
    );
  };
  const sessionStatus = async () => {
    const response = await call("GET", "/session/status", { quiet: true });
    if (response.status !== 200 || !isObject(response.json)) return "unknown";
    const entry = response.json[sessionId];
    return isObject(entry) && typeof entry.type === "string"
      ? entry.type
      : "absent";
  };
  const listRuns = async () => {
    const response = await call(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
    );
    if (response.status !== 200 || !Array.isArray(response.json?.runs))
      throw new Error(
        `GET /v1/sessions/{id}/runs returned ${response.status} ${summarizeBody(response)}`,
      );
    return response.json.runs;
  };
  const eventLog = async (runId) => {
    const events = [];
    let after = 0;
    for (let page = 0; page < 100; page++) {
      const response = await call(
        "GET",
        `/v1/runs/${encodeURIComponent(runId)}/event-log?afterSeq=${after}&limit=1000`,
        { quiet: true },
      );
      if (response.status !== 200 || !Array.isArray(response.json?.events))
        throw new Error(
          `event-log for run ${runId} returned ${response.status} ${summarizeBody(response)}`,
        );
      const batch = response.json.events;
      events.push(...batch);
      if (batch.length < 1000) break;
      after = batch.at(-1).seq;
    }
    return events;
  };
  const promptBody = (text) => ({
    parts: [{ type: "text", text }],
    model: {
      providerID: input.providerId ?? "harnesshub",
      modelID: input.expectModel ?? "harnesshub-model",
    },
  });
  const inspectLastAssistant = async (detail, problems) => {
    const response = await call(
      "GET",
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
    if (response.status !== 200 || !Array.isArray(response.json)) {
      problems.push(
        `GET /session/{id}/message returned ${response.status} ${summarizeBody(response)}`,
      );
      return undefined;
    }
    detail.messages = response.json.length;
    const assistant = [...response.json]
      .reverse()
      .find(
        (message) =>
          isObject(message) &&
          (message.role === "assistant" || message.info?.role === "assistant"),
      );
    if (!assistant) {
      problems.push("no assistant message in GET /session/{id}/message");
      return undefined;
    }
    const parts = Array.isArray(assistant.parts) ? assistant.parts : [];
    detail.finish = assistant.info?.finish ?? null;
    detail.stepFinish = parts.some(
      (part) => isObject(part) && part.type === "step-finish",
    );
    detail.toolParts = parts.filter(
      (part) => isObject(part) && part.type === "tool",
    ).length;
    detail.reply = replyText(assistant).slice(0, 400);
    if (detail.finish !== "stop")
      problems.push(
        `last assistant info.finish is ${JSON.stringify(detail.finish)}`,
      );
    if (!detail.stepFinish)
      problems.push("last assistant message has no step-finish part");
    return assistant;
  };
  const prompt = async (detail, text) => {
    const problems = [];
    const mark = sseEvents.length;
    const response = await call(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        body: promptBody(text),
        timeoutMs: promptTimeoutMs,
      },
    );
    detail.httpStatus = response.status;
    if (response.status !== 204) {
      problems.push(
        `prompt_async returned ${response.status} ${summarizeBody(response)}`,
      );
      return { problems, assistant: undefined };
    }
    const assistant = await inspectLastAssistant(detail, problems);
    const observed = await waitUntil(() => sawBusyThenIdle(mark), {
      timeoutMs: 10_000,
      intervalMs: 50,
    });
    detail.sse = observed
      ? "busy->idle"
      : statusEvents(mark).map((event) => event.status ?? event.type);
    if (!observed)
      problems.push("GET /event did not report busy then idle for this turn");
    return { problems, assistant };
  };

  try {
    await runStep("health", async (detail) => {
      const response = await call("GET", "/health/ready");
      detail.httpStatus = response.status;
      if (response.status !== 200 || response.json?.ready !== true)
        throw new Error(
          `/health/ready returned ${response.status} ${summarizeBody(response)}`,
        );
    });

    await runStep(
      "runtime-info",
      async () => {
        const response = await call("GET", "/v1/runtime/info");
        if (response.status !== 200 || !isObject(response.json))
          throw new Error(
            `/v1/runtime/info returned ${response.status} ${summarizeBody(response)}`,
          );
        const info = response.json;
        result.runtimeInfo = {
          competition: info.competition,
          competitionEngine: info.competitionEngine ?? null,
          fullAccess: info.fullAccess,
          consoleUrl: info.consoleUrl ?? null,
        };
        const problems = [];
        if (info.competition !== true)
          problems.push("runtime info does not report competition mode");
        if (info.competitionEngine !== engine)
          problems.push(
            `competitionEngine is ${JSON.stringify(info.competitionEngine)}; expected ${engine}`,
          );
        fail(problems);
      },
      ["health"],
    );

    await runStep(
      "event-stream",
      async () => {
        stream = subscribeEvents(`${base}/event`, (event, at) => {
          if (!isObject(event)) return;
          const properties = isObject(event.properties) ? event.properties : {};
          sseEvents.push({
            type: String(event.type),
            at,
            sessionID: properties.sessionID,
            status: isObject(properties.status)
              ? properties.status.type
              : undefined,
          });
        });
        await stream.ready;
        const connected = await waitUntil(
          () => sseEvents.some((event) => event.type === "server.connected"),
          { timeoutMs: 10_000, intervalMs: 50 },
        );
        if (!connected)
          throw new Error("no server.connected event within 10 s");
      },
      ["health"],
    );

    await runStep(
      "session-create",
      async (detail) => {
        const root = path.resolve(
          input.workRoot ?? path.join(os.tmpdir(), "harnesshub-acceptance"),
        );
        await mkdir(root, { recursive: true });
        directory = path.join(
          root,
          `${safeName(engine)}-${Date.now()}-${nonce}`,
          "workspace",
        );
        detail.directory = directory;
        result.session.directory = directory;
        if (await isDirectory(directory))
          throw new Error("session directory unexpectedly exists");
        const response = await call("POST", "/session", {
          body: { title: `hh-acceptance-${engine}-${nonce}`, directory },
        });
        if (response.status !== 200 || typeof response.json?.id !== "string")
          throw new Error(
            `POST /session returned ${response.status} ${summarizeBody(response)}`,
          );
        sessionId = response.json.id;
        result.session.id = sessionId;
        detail.sessionId = sessionId;
        detail.title = response.json.title;
        detail.initialStatus = response.json.status;
        if (!(await isDirectory(directory)))
          throw new Error("POST /session did not create the missing directory");
      },
      ["health"],
    );

    await runStep(
      "prompt-ok",
      async (detail) => {
        const { problems, assistant } = await prompt(detail, prompts.ok);
        if (assistant && !/\bOK\b/.test(replyText(assistant)))
          problems.push(
            `reply does not contain OK: ${JSON.stringify(detail.reply)}`,
          );
        fail(problems);
      },
      ["session-create", "event-stream"],
    );

    if (scenario === "full") {
      await runStep(
        "file-task",
        async (detail) => {
          const { problems } = await prompt(detail, prompts.file.text);
          const content = await readTextFile(
            path.join(directory, prompts.file.name),
          );
          detail.file = prompts.file.name;
          detail.fileContent =
            content === undefined ? null : content.slice(0, 200);
          if (content === undefined)
            problems.push(`${prompts.file.name} was not created`);
          else if (content.trim() !== prompts.file.expected)
            problems.push(
              `${prompts.file.name} content mismatch: ${JSON.stringify(content.slice(0, 120))}`,
            );
          fail(problems);
        },
        ["session-create", "event-stream"],
      );
      await runStep(
        "shell-task",
        async (detail) => {
          const { problems, assistant } = await prompt(
            detail,
            prompts.shell.text,
          );
          const content = await readTextFile(
            path.join(directory, prompts.shell.name),
          );
          detail.command = prompts.shell.command;
          detail.fileContent =
            content === undefined ? null : content.slice(0, 200);
          if (content === undefined)
            problems.push(`${prompts.shell.name} was not created`);
          else if (content.trim() !== prompts.shell.expected)
            problems.push(
              `${prompts.shell.name} content mismatch: ${JSON.stringify(content.slice(0, 120))}`,
            );
          if (
            assistant &&
            !replyText(assistant).includes(prompts.shell.expected)
          )
            problems.push("reply does not contain the command output");
          fail(problems);
        },
        ["session-create", "event-stream"],
      );
    } else {
      await runStep(
        "tool-marker",
        async (detail) => {
          const { problems, assistant } = await prompt(detail, prompts.tool);
          const reply = replyText(assistant);
          if (reply.includes(mockReplies.noShellTool)) {
            fail(problems);
            return {
              skip: "the mock upstream found no shell-like tool in this engine's tool list",
            };
          }
          const content = await readTextFile(
            path.join(directory, MOCK_MARKER_FILE),
          );
          detail.marker =
            content === undefined ? null : content.trim().slice(0, 80);
          if (content === undefined)
            problems.push(
              `${MOCK_MARKER_FILE} was not created by the tool call`,
            );
          else if (content.trim() !== MOCK_MARKER_TEXT)
            problems.push(
              `${MOCK_MARKER_FILE} content mismatch: ${JSON.stringify(content.slice(0, 80))}`,
            );
          if (assistant && !reply.includes(mockReplies.done))
            problems.push(
              `final reply is not DONE: ${JSON.stringify(reply.slice(0, 120))}`,
            );
          fail(problems);
        },
        ["session-create", "event-stream"],
      );
    }

    await runStep(
      "abort",
      async (detail) => {
        const problems = [];
        const mark = sseEvents.length;
        let settled = false;
        const pending = call(
          "POST",
          `/session/${encodeURIComponent(sessionId)}/prompt_async`,
          {
            body: promptBody(
              scenario === "mock" ? prompts.slow : prompts.long.text,
            ),
            timeoutMs: promptTimeoutMs,
          },
        ).then(
          (response) => ({ response }),
          (error) => ({ error }),
        );
        pending.then(() => {
          settled = true;
        });
        const busy = await waitUntil(
          async () =>
            statusEvents(mark).some((event) => event.status === "busy") ||
            (await sessionStatus()) === "busy",
          { timeoutMs: 60_000, intervalMs: 200 },
        );
        if (!busy)
          throw new Error("the session never became busy for the long task");
        await delay(
          input.abortSettleMs ?? (scenario === "mock" ? 3000 : 10_000),
        );
        if (settled) {
          const outcome = await pending;
          throw new Error(
            `the long task finished before abort was sent (prompt_async ${outcome.response?.status ?? outcome.error?.message})`,
          );
        }
        const abortMark = sseEvents.length;
        const aborted = await call(
          "POST",
          `/session/${encodeURIComponent(sessionId)}/abort`,
        );
        detail.abortHttpStatus = aborted.status;
        if (aborted.status !== 200)
          problems.push(
            `abort returned ${aborted.status} ${summarizeBody(aborted)}`,
          );
        const raced = await raceTimeout(pending, 120_000);
        const outcome = raced.timedOut ? { timeout: true } : raced.value;
        detail.promptHttpStatus =
          outcome.response?.status ??
          (outcome.timeout
            ? "still pending after 120 s"
            : `error: ${outcome.error?.message}`);
        if (outcome.timeout)
          problems.push("prompt_async did not return within 120 s after abort");
        const idle = await waitUntil(
          async () => (await sessionStatus()) === "idle",
          {
            timeoutMs: 60_000,
            intervalMs: 250,
          },
        );
        detail.statusAfterAbort = idle ? "idle" : await sessionStatus();
        if (!idle)
          problems.push(
            `session status after abort is ${detail.statusAfterAbort}`,
          );
        detail.sseIdleAfterAbort = Boolean(
          await waitUntil(
            () =>
              statusEvents(abortMark).some(
                (event) =>
                  event.status === "idle" || event.type === "session.idle",
              ),
            { timeoutMs: 10_000, intervalMs: 50 },
          ),
        );
        detail.sseAfterAbort = statusEvents(abortMark).map(
          (event) => event.status ?? event.type,
        );
        if (!detail.sseIdleAfterAbort)
          problems.push("GET /event did not report idle after abort");
        const last = (await listRuns()).at(-1);
        detail.runStatus = last?.status ?? null;
        if (!terminalStatuses.has(last?.status))
          problems.push(`aborted run status is ${detail.runStatus}`);
        fail(problems);
      },
      ["session-create", "event-stream"],
    );

    await runStep(
      "model-calls",
      async (detail) => {
        let expected = input.expectModel;
        const view = await call("GET", "/v1/harness/model");
        if (view.status === 200 && isObject(view.json)) {
          result.harnessModel = {
            configured: view.json.configured ?? null,
            source: view.json.source ?? null,
            model: view.json.model ?? null,
            alias: view.json.alias ?? null,
          };
          if (expected === undefined && typeof view.json.model === "string")
            expected = view.json.model;
        }
        detail.expectedModel = expected ?? null;
        const stats = {
          expectedModel: expected ?? null,
          unified: false,
          total: 0,
          ok: 0,
          failed: 0,
          upstreamModels: {},
          requestedModels: {},
          inbound: {},
          statuses: {},
          toolCalls: 0,
          usage: { input: 0, output: 0, total: 0 },
          errors: [],
          runs: [],
        };
        for (const run of await listRuns()) {
          const calls = (await eventLog(run.id))
            .filter((event) => isObject(event) && event.type === "model.call")
            .map((event) => (isObject(event.data) ? event.data : {}));
          stats.runs.push({
            runId: run.id,
            status: run.status,
            modelCalls: calls.length,
          });
          for (const record of calls) {
            stats.total++;
            if (record.ok === true) stats.ok++;
            else stats.failed++;
            const upstream = String(record.upstreamModel ?? "(missing)");
            stats.upstreamModels[upstream] =
              (stats.upstreamModels[upstream] ?? 0) + 1;
            const requested = String(record.requestedModel ?? "(none)");
            stats.requestedModels[requested] =
              (stats.requestedModels[requested] ?? 0) + 1;
            const inbound = String(record.inbound ?? "(unknown)");
            stats.inbound[inbound] = (stats.inbound[inbound] ?? 0) + 1;
            const status = String(record.status ?? "(unknown)");
            stats.statuses[status] = (stats.statuses[status] ?? 0) + 1;
            if (typeof record.toolCalls === "number")
              stats.toolCalls += record.toolCalls;
            for (const key of ["input", "output", "total"])
              if (typeof record.usage?.[key] === "number")
                stats.usage[key] += record.usage[key];
            if (record.error && stats.errors.length < 5)
              stats.errors.push(
                `${record.error.code ?? "error"}: ${String(record.error.message ?? "").slice(0, 200)}`,
              );
          }
        }
        result.modelCalls = stats;
        const problems = [];
        if (expected === undefined)
          problems.push(
            "unified model is unknown: pass --expect-model or configure HARNESSHUB_MODEL",
          );
        if (stats.total === 0)
          problems.push("no model.call events were committed");
        const foreign = Object.keys(stats.upstreamModels).filter(
          (model) => model !== expected,
        );
        if (expected !== undefined && foreign.length)
          problems.push(
            `model.call named non-unified upstream models: ${foreign.join(", ")}`,
          );
        const silent = stats.runs.filter(
          (run) => run.status === "completed" && run.modelCalls === 0,
        );
        if (silent.length)
          problems.push(
            `completed runs without model.call events: ${silent.map((run) => run.runId).join(", ")}`,
          );
        stats.unified = problems.length === 0;
        fail(problems);
      },
      ["session-create"],
    );

    await runStep(
      "session-delete",
      async (detail) => {
        const response = await call(
          "DELETE",
          `/session/${encodeURIComponent(sessionId)}`,
        );
        detail.httpStatus = response.status;
        if (response.status !== 200)
          throw new Error(
            `DELETE /session/{id} returned ${response.status} ${summarizeBody(response)}`,
          );
        const gone = await waitUntil(
          async () => (await sessionStatus()) === "absent",
          {
            timeoutMs: 15_000,
            intervalMs: 250,
          },
        );
        if (!gone)
          throw new Error(
            "session is still listed by GET /session/status after DELETE",
          );
      },
      ["session-create"],
    );
  } finally {
    stream?.close();
    if (directory && (await isDirectory(directory)))
      result.session.files = (await readdir(directory, { withFileTypes: true }))
        .slice(0, 50)
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    result.sse = {
      events: sseEvents.length,
      byType: tally(sseEvents.map((event) => event.type)),
    };
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - started;
    result.skipped = steps
      .filter((step) => step.status === "SKIP")
      .map((step) => step.id);
    result.status = steps.every(
      (step) => step.status === "PASS" || step.status === "SKIP",
    )
      ? "PASS"
      : "FAIL";
    const name = safeName(engine);
    await writeFile(
      path.join(out, `acceptance-${name}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    await writeFile(
      path.join(out, `acceptance-${name}.log`),
      `${logLines.join("\n")}\n`,
    );
  }
  return result;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const usage =
    "Usage: node scripts/competition-acceptance.mjs --base http://127.0.0.1:6217 --engine opencode --out DIR [--scenario full|mock] [--expect-model ID] [--work-root DIR] [--prompt-timeout-ms 300000] [--timeout-ms 1200000]";
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        base: { type: "string" },
        engine: { type: "string" },
        out: { type: "string" },
        scenario: { type: "string", default: "full" },
        "expect-model": { type: "string" },
        "work-root": { type: "string" },
        "prompt-timeout-ms": { type: "string", default: "300000" },
        "timeout-ms": { type: "string", default: "1200000" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
    if (values.help) {
      console.log(usage);
      process.exit(0);
    }
    if (!values.base || !values.engine || !values.out) throw new Error(usage);
    if (!["full", "mock"].includes(values.scenario))
      throw new Error("--scenario must be full or mock");
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  try {
    const result = await runAcceptance({
      base: values.base,
      engine: values.engine,
      out: values.out,
      scenario: values.scenario,
      promptTimeoutMs: positiveInteger(
        values["prompt-timeout-ms"],
        "--prompt-timeout-ms",
      ),
      timeoutMs: positiveInteger(values["timeout-ms"], "--timeout-ms"),
      ...(values["expect-model"]
        ? { expectModel: values["expect-model"] }
        : {}),
      ...(values["work-root"] ? { workRoot: values["work-root"] } : {}),
    });
    console.log(
      JSON.stringify({
        event: "competition.acceptance",
        engine: result.engine,
        scenario: result.scenario,
        status: result.status,
        steps: Object.fromEntries(
          result.steps.map((step) => [step.id, step.status]),
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
