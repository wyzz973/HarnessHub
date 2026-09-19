#!/usr/bin/env node
/**
 * Competition API v1.1 acceptance for one running HarnessHub competition Gateway
 * (docs/competition-api.md).
 *
 * Scenarios (`--scenario`):
 * - `full` (real model, default): session A with a directory that does not exist yet (must be
 *   created) -> "reply OK" -> file task (hello.txt with a nonce) -> shell task (a command
 *   writes shell.txt and prints it).
 * - `mock` (scripts/mock-company-model.mjs upstream): session A -> "reply OK" ->
 *   HH_MOCK_TOOL round (tool call, reasoning pass-back and the mock-ok.txt marker; SKIP
 *   when the engine exposes no shell-like tool). Mock results prove the protocol chain only;
 *   they are not a real-model pass.
 * Both then abort a long task in a separate session B (a cancelled ACP run closes its
 * session, so it must not share session A), collect model.call statistics for every run,
 * and DELETE both sessions (DELETE must be idempotent and a closed session must refuse
 * prompts with 400).
 *
 * Every prompt must return 204, the last assistant message must have info.finish=stop and
 * a step-finish part, and GET /event must report busy then idle for the session. Every
 * completed run must have model.call events (GET /v1/runs/{id}/event-log) naming only the
 * unified upstream model (`--expect-model`, else GET /v1/harness/model), and the unified
 * model must be configured and applied to the engine under test.
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Prompts and expected evidence for one acceptance run. */
export function acceptancePrompts(nonce, platform = process.platform) {
  const windows = platform === "win32";
  // Windows: no parenthesized or $() expression. Gemini CLI parses PowerShell commands and
  // blocks those as command substitution even in YOLO mode, and `$` would be expanded by
  // engines whose shell is Git Bash. The host name proves the command really ran: the model
  // cannot know it, and the nonce ties the file to this run.
  const shellExpected = windows
    ? [`HH-${nonce}`, os.hostname()]
    : [`HH-42-${nonce}`];
  const shellCommand = windows
    ? `powershell -NoProfile -Command "Set-Content -Path shell.txt -Value HH-${nonce}; hostname | Add-Content -Path shell.txt; Get-Content shell.txt"`
    : `sh -c 'echo HH-$((6*7))-${nonce} > shell.txt && cat shell.txt'`;
  const longCommand = windows
    ? `powershell -NoProfile -Command "Start-Sleep -Seconds 600"`
    : "sleep 600";
  return {
    ok: "只回复 OK 两个大写字母，不要输出任何其他内容。Reply with exactly: OK",
    // Real models sometimes answer a bare "reply OK" with a synonym such as "好的"; a
    // random code can only come back if the engine returned the model's actual reply.
    echo: {
      expected: `HH-ECHO-${nonce}`,
      text: `请原样回复下面这一行编号，不要输出任何其他内容：\nHH-ECHO-${nonce}`,
    },
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
    // The nonce keeps each acceptance conversation distinct for the shared mock.
    tool: `${mockDirectives.tool} ${nonce} 请调用你的 shell 工具执行一次命令，在当前目录创建 ${MOCK_MARKER_FILE}，然后只回复 DONE。`,
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

function count(target, key) {
  target[key] = (target[key] ?? 0) + 1;
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
 *   providerId?: string, platform?: NodeJS.Platform, abortSettleMs?: number,
 *   abortOutputTimeoutMs?: number}} input
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
  const sessions = [];
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
    sessions,
    runtimeInfo: null,
    harnessModel: null,
    modelCalls: null,
    sse: null,
  };
  let expectedModel = input.expectModel;
  let sessionId;
  let directory;
  let stream;
  const caseRoot = path.join(
    path.resolve(
      input.workRoot ?? path.join(os.tmpdir(), "harnesshub-acceptance"),
    ),
    `${safeName(engine)}-${Date.now()}-${nonce}`,
  );

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
          `${method} ${pathname} -> ${response.status} (${Date.now() - t0} ms)${response.status >= 400 ? ` ${summarizeBody(response)}` : ""}`,
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
        !["PASS", "SKIP"].includes(
          steps.find((step) => step.id === dependency)?.status,
        ),
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

  const eventsFor = (id, from) =>
    sseEvents.slice(from).filter((event) => event.sessionID === id);
  const statusEvents = (id, from) =>
    eventsFor(id, from).filter(
      (event) =>
        event.type === "session.status" || event.type === "session.idle",
    );
  const sawBusyThenIdle = (id, from) => {
    const events = statusEvents(id, from);
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
  const sessionErrors = (id, from) =>
    eventsFor(id, from)
      .filter((event) => event.type === "session.error")
      .map((event) => event.error ?? "session.error");
  const sessionStatus = async (id) => {
    const response = await call("GET", "/session/status", { quiet: true });
    if (response.status !== 200 || !isObject(response.json)) return "unknown";
    const entry = response.json[id];
    return isObject(entry) && typeof entry.type === "string"
      ? entry.type
      : "absent";
  };
  const listRuns = async (id) => {
    const response = await call(
      "GET",
      `/v1/sessions/${encodeURIComponent(id)}/runs`,
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
      modelID: expectedModel ?? "harnesshub-model",
    },
  });
  const createSession = async (title, target) => {
    const response = await call("POST", "/session", {
      body: { title, directory: target },
    });
    if (response.status !== 200 || typeof response.json?.id !== "string")
      throw new Error(
        `POST /session returned ${response.status} ${summarizeBody(response)}`,
      );
    sessions.push({
      id: response.json.id,
      title: response.json.title ?? title,
      directory: target,
    });
    return response.json;
  };
  const inspectLastAssistant = async (id, detail, problems) => {
    const response = await call(
      "GET",
      `/session/${encodeURIComponent(id)}/message`,
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
    if (isObject(assistant.info?.error)) detail.runError = assistant.info.error;
    detail.stepFinish = parts.some(
      (part) => isObject(part) && part.type === "step-finish",
    );
    detail.toolParts = response.json
      .flatMap((message) =>
        isObject(message) && Array.isArray(message.parts) ? message.parts : [],
      )
      .filter((part) => isObject(part) && part.type === "tool")
      .map((part) => `${part.tool}:${part.state?.status ?? "?"}`)
      .slice(-10);
    detail.reply = replyText(assistant).slice(0, 400);
    return assistant;
  };
  const prompt = async (detail, text) => {
    const problems = [];
    const mark = sseEvents.length;
    const response = await call(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      { body: promptBody(text), timeoutMs: promptTimeoutMs },
    );
    detail.httpStatus = response.status;
    if (response.status !== 204)
      problems.push(
        `prompt_async returned ${response.status} ${summarizeBody(response)}`,
      );
    const assistant = await inspectLastAssistant(sessionId, detail, problems);
    if (response.status === 204 && assistant) {
      if (detail.finish !== "stop")
        problems.push(
          `last assistant info.finish is ${JSON.stringify(detail.finish)}`,
        );
      if (!detail.stepFinish)
        problems.push("last assistant message has no step-finish part");
    }
    const observed = await waitUntil(() => sawBusyThenIdle(sessionId, mark), {
      timeoutMs: 10_000,
      intervalMs: 50,
    });
    detail.sse = observed
      ? "busy->idle"
      : statusEvents(sessionId, mark).map(
          (event) => event.status ?? event.type,
        );
    const errors = sessionErrors(sessionId, mark);
    if (errors.length) detail.sessionErrors = errors.slice(0, 3);
    if (!observed)
      problems.push("GET /event did not report busy then idle for this turn");
    return {
      problems,
      assistant: response.status === 204 ? assistant : undefined,
    };
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
      "unified-model",
      async (detail) => {
        const response = await call("GET", "/v1/harness/model");
        if (response.status !== 200 || !isObject(response.json))
          throw new Error(
            `/v1/harness/model returned ${response.status} ${summarizeBody(response)}`,
          );
        const view = response.json;
        const engines = Array.isArray(view.engines) ? view.engines : [];
        const own = engines.find(
          (entry) => isObject(entry) && entry.engineId === engine,
        );
        result.harnessModel = {
          configured: view.configured ?? null,
          source: view.source ?? null,
          model: view.model ?? null,
          alias: view.alias ?? null,
          engine: own ?? null,
        };
        if (expectedModel === undefined && typeof view.model === "string")
          expectedModel = view.model;
        detail.expectedModel = expectedModel ?? null;
        const problems = [];
        if (view.configured !== true)
          problems.push(
            "the unified model is not configured (set HARNESSHUB_MODEL and HARNESSHUB_MODEL_BASE_URL)",
          );
        if (input.expectModel !== undefined && view.model !== input.expectModel)
          problems.push(
            `unified model is ${JSON.stringify(view.model)}; expected ${input.expectModel}`,
          );
        if (own && own.status !== "applied")
          problems.push(
            `engine ${engine} is ${own.status} for the unified model${own.reason ? `: ${own.reason}` : ""}`,
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
            ...(event.type === "session.error"
              ? {
                  error: String(properties.error?.message ?? "").slice(0, 300),
                }
              : {}),
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
        await mkdir(path.dirname(caseRoot), { recursive: true });
        directory = path.join(caseRoot, "workspace");
        detail.directory = directory;
        result.session.directory = directory;
        if (await isDirectory(caseRoot))
          throw new Error("session directory parent unexpectedly exists");
        const created = await createSession(
          `hh-acceptance-${engine}-${nonce}`,
          directory,
        );
        sessionId = created.id;
        result.session.id = sessionId;
        detail.sessionId = sessionId;
        detail.initialStatus = created.status;
        if (created.status !== "idle")
          throw new Error(`new session status is ${created.status}`);
        if (!(await isDirectory(directory)))
          throw new Error("POST /session did not create the missing directory");
      },
      ["health"],
    );

    await runStep(
      "prompt-ok",
      async (detail) => {
        // The scripted mock always answers OK; a real model has to echo a random code.
        const expected = scenario === "mock" ? "OK" : prompts.echo.expected;
        const { problems, assistant } = await prompt(
          detail,
          scenario === "mock" ? prompts.ok : prompts.echo.text,
        );
        if (
          assistant &&
          !(scenario === "mock"
            ? /\bOK\b/.test(replyText(assistant))
            : replyText(assistant).includes(expected))
        )
          problems.push(
            `reply does not contain ${expected}: ${JSON.stringify(detail.reply)}`,
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
          // Host names are compared without case; everything else must match exactly.
          const lines = (text) =>
            text
              .split(/\r?\n/)
              .map((line) => line.trim().toLowerCase())
              .filter(Boolean);
          const expected = prompts.shell.expected.map((line) =>
            line.toLowerCase(),
          );
          if (content === undefined)
            problems.push(`${prompts.shell.name} was not created`);
          else if (lines(content).join("\n") !== expected.join("\n"))
            problems.push(
              `${prompts.shell.name} content mismatch: ${JSON.stringify(content.slice(0, 120))}`,
            );
          if (assistant) {
            const reply = replyText(assistant).toLowerCase();
            if (!expected.every((line) => reply.includes(line)))
              problems.push("reply does not contain the command output");
          }
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
        const created = await createSession(
          `hh-acceptance-${engine}-${nonce}-abort`,
          path.join(caseRoot, "abort-workspace"),
        );
        const abortId = created.id;
        detail.sessionId = abortId;
        const mark = sseEvents.length;
        let settled = false;
        const pending = call(
          "POST",
          `/session/${encodeURIComponent(abortId)}/prompt_async`,
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
            settled ||
            statusEvents(abortId, mark).some(
              (event) => event.status === "busy",
            ) ||
            (await sessionStatus(abortId)) === "busy",
          { timeoutMs: 60_000, intervalMs: 200 },
        );
        if (!busy)
          throw new Error("the session never became busy for the long task");
        await waitUntil(
          () =>
            settled ||
            eventsFor(abortId, mark).some(
              (event) => event.type === "message.part.updated",
            ),
          { timeoutMs: input.abortOutputTimeoutMs ?? 90_000, intervalMs: 100 },
        );
        detail.abortPhase = eventsFor(abortId, mark).some(
          (event) => event.type === "message.part.updated",
        )
          ? "after-output"
          : "before-output";
        await delay(input.abortSettleMs ?? (scenario === "mock" ? 1000 : 5000));
        if (settled) {
          const outcome = await pending;
          throw new Error(
            `the long task finished before abort was sent (prompt_async ${outcome.response?.status ?? outcome.error?.message}${outcome.response ? ` ${summarizeBody(outcome.response)}` : ""})`,
          );
        }
        const abortMark = sseEvents.length;
        const aborted = await call(
          "POST",
          `/session/${encodeURIComponent(abortId)}/abort`,
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
        else if (outcome.response?.status !== 204)
          problems.push(
            `prompt_async returned ${detail.promptHttpStatus} after abort; expected 204`,
          );
        const idle = await waitUntil(
          async () => (await sessionStatus(abortId)) === "idle",
          { timeoutMs: 60_000, intervalMs: 250 },
        );
        detail.statusAfterAbort = idle ? "idle" : await sessionStatus(abortId);
        if (!idle)
          problems.push(
            `session status after abort is ${detail.statusAfterAbort}`,
          );
        detail.sseIdleAfterAbort = Boolean(
          await waitUntil(
            () =>
              statusEvents(abortId, abortMark).some(
                (event) =>
                  event.status === "idle" || event.type === "session.idle",
              ),
            { timeoutMs: 10_000, intervalMs: 50 },
          ),
        );
        detail.sseAfterAbort = statusEvents(abortId, abortMark).map(
          (event) => event.status ?? event.type,
        );
        if (!detail.sseIdleAfterAbort)
          problems.push("GET /event did not report idle after abort");
        const last = (await listRuns(abortId)).at(-1);
        detail.runStatus = last?.status ?? null;
        if (last?.status !== "cancelled")
          problems.push(
            `aborted run status is ${detail.runStatus}; expected cancelled`,
          );
        fail(problems);
      },
      ["health", "event-stream"],
    );

    await runStep(
      "model-calls",
      async (detail) => {
        detail.expectedModel = expectedModel ?? null;
        const stats = {
          expectedModel: expectedModel ?? null,
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
        for (const session of sessions)
          for (const run of await listRuns(session.id)) {
            const calls = (await eventLog(run.id))
              .filter((event) => isObject(event) && event.type === "model.call")
              .map((event) => (isObject(event.data) ? event.data : {}));
            stats.runs.push({
              sessionId: session.id,
              runId: run.id,
              status: run.status,
              modelCalls: calls.length,
            });
            for (const record of calls) {
              stats.total++;
              if (record.ok === true) stats.ok++;
              else stats.failed++;
              count(
                stats.upstreamModels,
                String(record.upstreamModel ?? "(missing)"),
              );
              count(
                stats.requestedModels,
                String(record.requestedModel ?? "(none)"),
              );
              count(stats.inbound, String(record.inbound ?? "(unknown)"));
              count(stats.statuses, String(record.status ?? "(unknown)"));
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
        if (expectedModel === undefined)
          problems.push(
            "unified model is unknown: pass --expect-model or configure HARNESSHUB_MODEL",
          );
        if (stats.total === 0)
          problems.push("no model.call events were committed");
        const foreign = Object.keys(stats.upstreamModels).filter(
          (model) => model !== expectedModel,
        );
        if (expectedModel !== undefined && foreign.length)
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
        const problems = [];
        for (const session of sessions) {
          const response = await call(
            "DELETE",
            `/session/${encodeURIComponent(session.id)}`,
          );
          if (response.status !== 200 || response.json?.ok !== true)
            problems.push(
              `DELETE ${session.id} returned ${response.status} ${summarizeBody(response)}`,
            );
        }
        const again = await call(
          "DELETE",
          `/session/${encodeURIComponent(sessionId)}`,
        );
        detail.repeatDeleteStatus = again.status;
        if (again.status !== 200)
          problems.push(
            `repeated DELETE returned ${again.status}; expected 200`,
          );
        const refused = await call(
          "POST",
          `/session/${encodeURIComponent(sessionId)}/prompt_async`,
          { body: promptBody(prompts.ok) },
        );
        detail.promptAfterDelete = refused.status;
        if (refused.status !== 400 || refused.json?.code !== "VALIDATION_ERROR")
          problems.push(
            `prompt after DELETE returned ${refused.status} ${summarizeBody(refused)}; expected 400 VALIDATION_ERROR`,
          );
        const status = await sessionStatus(sessionId);
        detail.statusAfterDelete = status;
        if (status === "busy") problems.push("closed session is still busy");
        fail(problems);
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
