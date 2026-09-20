#!/usr/bin/env node
/**
 * Office task suite for one running HarnessHub competition Gateway
 * (docs/competition-tasks.md). It plays the judge: for every task it creates an empty
 * directory, writes the task's input files, creates a Session for that directory, sends
 * the task's `query` VERBATIM through `POST /session/{id}/prompt_async`, then scores the
 * FINAL STATE of the directory / machine with the task's `verify` checks
 * (scripts/lib/tasks-verify.mjs). Replies are evidence, never the pass criterion, except
 * where a check asks for them.
 *
 * Outcomes per task:
 *   PASS  the final state satisfies `verify` and prompt_async returned 204
 *   FAIL  anything else that is the agent's or the Gateway's fault
 *   ENV   `verify` failed, the machine provably lacks what the task `requires` (for
 *         example Outlook is not installed on a CI runner) AND the agent said so
 *         (`env_reply`); claiming success on such a machine is FAIL
 *   SKIP  the task's `platform` does not include this machine
 *
 * Desktop tasks (checks `process_running`, `window_title`, `shell_window`) are verified
 * twice: right after prompt_async returns (this decides PASS/FAIL) and again about 3 s
 * after DELETE /session, recorded as `survivesSessionClose` (true/false, null when the
 * task has no such check or did not pass). On Windows a Session's engine and everything
 * it starts live in one kill-on-close Job, so an app launched directly by the agent dies
 * with the Session while a judge may still look at the desktop afterwards.
 * `--require-survival` turns a false into FAIL; it is off by default because a CI service
 * session has no desktop shell through which a launch could leave the Job. The task's
 * own cleanup (closing the app) runs only after the second check.
 *
 * The runner must run on the Gateway's machine (it reads the task directories). It needs
 * only Node and this `scripts/` folder: no npm dependency, so a bundle's
 * `runtime\node.exe scripts\competition-tasks.mjs ...` works offline.
 *
 * Writes <out>/tasks-<label>.json and <out>/tasks-<label>.md (the table is also appended
 * to --summary). Exit code: 0 no task failed, 1 at least one FAIL, 2 usage or
 * environment error (Gateway not ready, invalid task file).
 *
 * Usage: node scripts/competition-tasks.mjs --base http://127.0.0.1:6217 --out DIR
 *   [--tasks examples/competition-tasks/office-tasks.json] [--engine LABEL]
 *   [--work-root DIR] [--only id,id] [--task-timeout-ms 900000] [--summary FILE]
 *   [--require-survival]
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { httpRequest, summarizeBody } from "./lib/competition-client.mjs";
import { buildDocx, buildXlsx } from "./lib/tasks-office.mjs";
import {
  CHECK_KINDS,
  checkRequirement,
  checkVariables,
  createVerifier,
  listProcesses,
  snapshotHashes,
} from "./lib/tasks-verify.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
/** Task file shipped with the repository. */
export const defaultTasksFile = path.join(
  scriptsDirectory,
  "..",
  "examples",
  "competition-tasks",
  "office-tasks.json",
);

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const PLATFORMS = ["win32", "darwin", "linux"];
const SETUP_KINDS = [
  "text",
  "csv",
  "json",
  "docx",
  "xlsx",
  "base64",
  "repeat",
  "directory",
];

function safeName(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_.-]/g, "_")
      .slice(0, 60) || "engine"
  );
}

function insidePath(directory, relative) {
  const normalized = String(relative).replaceAll("\\", "/");
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  )
    throw new Error(
      `Setup path must stay inside the task directory: ${relative}`,
    );
  return path.join(directory, ...normalized.split("/"));
}

function checkProblems(check, where, problems) {
  if (!isObject(check) || typeof check.kind !== "string") {
    problems.push(`${where}: a check must be an object with a kind`);
    return;
  }
  if (!CHECK_KINDS.includes(check.kind))
    problems.push(`${where}: unknown check kind ${check.kind}`);
  if (check.kind === "any_of" || check.kind === "all_of") {
    if (!Array.isArray(check.checks) || !check.checks.length)
      problems.push(`${where}: ${check.kind} needs a non-empty checks array`);
    for (const [index, child] of list(check.checks).entries())
      checkProblems(child, `${where}.checks[${index}]`, problems);
  }
  if (check.kind === "not")
    checkProblems(check.check, `${where}.check`, problems);
}

/**
 * Validate a task document. Returns the list of problems (empty when valid); never
 * throws for content errors so every problem is reported at once.
 */
export function validateTasks(document) {
  const problems = [];
  if (
    !isObject(document) ||
    !Array.isArray(document.tasks) ||
    !document.tasks.length
  )
    return ["Task file must be an object with a non-empty tasks array"];
  const seen = new Set();
  for (const [index, task] of document.tasks.entries()) {
    const where = `tasks[${index}]${isObject(task) && task.task_id ? ` (${task.task_id})` : ""}`;
    if (!isObject(task)) {
      problems.push(`${where}: must be an object`);
      continue;
    }
    for (const field of ["task_id", "title", "query"])
      if (typeof task[field] !== "string" || !task[field].trim())
        problems.push(`${where}: ${field} must be a non-empty string`);
    if (seen.has(task.task_id)) problems.push(`${where}: duplicate task_id`);
    seen.add(task.task_id);
    for (const platform of list(task.platform))
      if (!PLATFORMS.includes(platform))
        problems.push(`${where}: unknown platform ${platform}`);
    for (const [position, entry] of list(task.setup).entries()) {
      const kinds = isObject(entry)
        ? SETUP_KINDS.filter((kind) => entry[kind] !== undefined)
        : [];
      if (
        !isObject(entry) ||
        typeof entry.path !== "string" ||
        kinds.length !== 1
      )
        problems.push(
          `${where}.setup[${position}]: needs a path and exactly one of ${SETUP_KINDS.join(", ")}`,
        );
    }
    checkProblems(task.verify, `${where}.verify`, problems);
    for (const [position, requirement] of list(task.requires).entries())
      if (
        !isObject(requirement) ||
        !["app_installed", "desktop_session"].includes(requirement.kind)
      )
        problems.push(
          `${where}.requires[${position}]: kind must be app_installed or desktop_session`,
        );
    if (task.requires !== undefined && !isObject(task.env_reply))
      problems.push(
        `${where}: requires needs env_reply (how an honest agent says it)`,
      );
    for (const [position, action] of list(task.cleanup).entries())
      if (
        !isObject(action) ||
        action.kind !== "close_process" ||
        !list(action.names).length
      )
        problems.push(
          `${where}.cleanup[${position}]: only {kind:"close_process", names:[...]} is supported`,
        );
  }
  return problems;
}

/** Read and validate a task file; throws one error listing every problem. */
export async function loadTasks(file) {
  let document;
  try {
    document = JSON.parse(
      (await readFile(file, "utf8")).replace(/^\uFEFF/, ""),
    );
  } catch (error) {
    throw new Error(`Cannot read task file ${file}: ${error.message}`);
  }
  const problems = validateTasks(document);
  if (problems.length)
    throw new Error(`Invalid task file ${file}:\n- ${problems.join("\n- ")}`);
  return document;
}

function csvText(rows) {
  return `${rows
    .map((row) =>
      row
        .map((cell) => {
          const value = String(cell ?? "");
          return /[",\r\n]/.test(value)
            ? `"${value.replaceAll('"', '""')}"`
            : value;
        })
        .join(","),
    )
    .join("\r\n")}\r\n`;
}

function encodeText(text, encoding = "utf8") {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  if (encoding === "utf8-bom")
    return Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(text, "utf8"),
    ]);
  if (encoding === "utf16le")
    return Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, "utf16le"),
    ]);
  throw new Error(`Unsupported setup encoding: ${encoding}`);
}

/**
 * Write a task's input files into its (new, empty) directory. Entry kinds: `text`
 * (`encoding`: utf8 | utf8-bom | utf16le, `eol`: lf | crlf), `csv` (rows; `bom: true`
 * adds a UTF-8 BOM as Excel does), `json`, `docx`, `xlsx` (scripts/lib/tasks-office.mjs
 * builders), `base64`, `repeat` ({text,count}) and `directory`.
 */
export async function applySetup(directory, setup) {
  for (const entry of list(setup)) {
    const target = insidePath(directory, entry.path);
    if (entry.directory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    let bytes;
    if (entry.text !== undefined) {
      const text =
        entry.eol === "crlf"
          ? String(entry.text).replace(/\r?\n/g, "\r\n")
          : String(entry.text);
      bytes = encodeText(text, entry.encoding);
    } else if (entry.csv !== undefined)
      bytes = encodeText(csvText(entry.csv), entry.bom ? "utf8-bom" : "utf8");
    else if (entry.json !== undefined)
      bytes = Buffer.from(`${JSON.stringify(entry.json, null, 2)}\n`, "utf8");
    else if (entry.docx !== undefined) bytes = buildDocx(entry.docx);
    else if (entry.xlsx !== undefined) bytes = buildXlsx(entry.xlsx);
    else if (entry.base64 !== undefined)
      bytes = Buffer.from(entry.base64, "base64");
    else if (entry.repeat !== undefined)
      bytes = Buffer.from(
        String(entry.repeat.text).repeat(Number(entry.repeat.count)),
      );
    else throw new Error(`Setup entry ${entry.path} has no content`);
    await writeFile(target, bytes);
  }
}

const DESKTOP_KINDS = ["process_running", "window_title", "shell_window"];

/** Whether a check tree looks at the desktop (processes or windows), not only at files. */
export function usesDesktopState(check) {
  if (!isObject(check)) return false;
  if (DESKTOP_KINDS.includes(check.kind)) return true;
  return [...list(check.checks), check.check].some(usesDesktopState);
}

/** Text the agent produced in this turn: every assistant message after the last user one. */
export function turnReply(messages) {
  const role = (message) => message?.role ?? message?.info?.role;
  const lastUser = messages.findLastIndex(
    (message) => role(message) === "user",
  );
  return messages
    .slice(lastUser + 1)
    .filter((message) => isObject(message) && role(message) === "assistant")
    .map((message) =>
      typeof message.content === "string" && message.content
        ? message.content
        : list(message.parts)
            .filter((part) => isObject(part) && part.type === "text")
            .map((part) => String(part.content ?? part.text ?? ""))
            .join(""),
    )
    .filter(Boolean)
    .join("\n");
}

function replyMatches(reply, rule) {
  if (!isObject(rule)) return false;
  const text = reply.toLowerCase();
  const any = list(rule.any).map((value) => String(value).toLowerCase());
  if (any.length && any.some((value) => text.includes(value))) return true;
  return typeof rule.pattern === "string"
    ? new RegExp(rule.pattern, rule.flags ?? "i").test(reply)
    : false;
}

/**
 * Decide a task's outcome from its evidence. Pure, so the policy is unit-tested:
 * ENV needs all of a failed verify, an unmet requirement and an honest reply.
 *
 * @param {{httpStatus: number|null, verifyOk: boolean, requirements: {satisfied: boolean}[],
 *   honest: boolean, error?: string}} evidence
 * @returns {{outcome: "PASS"|"FAIL"|"ENV", reason: string}}
 */
export function decideOutcome(evidence) {
  if (evidence.error) return { outcome: "FAIL", reason: evidence.error };
  const unmet = evidence.requirements.some((item) => !item.satisfied);
  if (evidence.verifyOk && evidence.httpStatus === 204)
    return { outcome: "PASS", reason: "final state verified" };
  if (!evidence.verifyOk && unmet)
    return evidence.honest
      ? {
          outcome: "ENV",
          reason:
            "this machine lacks what the task needs and the agent said so",
        }
      : {
          outcome: "FAIL",
          reason:
            "this machine lacks what the task needs, but the agent did not report it",
        };
  if (evidence.verifyOk)
    return {
      outcome: "FAIL",
      reason: `final state is correct but prompt_async returned ${evidence.httpStatus}`,
    };
  return { outcome: "FAIL", reason: "final state does not satisfy the task" };
}

function killProcess(pid, platform) {
  return new Promise((resolve) => {
    if (platform === "win32")
      execFile(
        path.win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true },
        () => resolve(),
      );
    else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      resolve();
    }
  });
}

function markdownTable(result) {
  const cell = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .replaceAll("|", "\\|")
      .slice(0, 160);
  const lines = [
    `## HarnessHub office tasks — ${result.label} (${result.platform})`,
    "",
    `Gateway ${result.base} · task file \`${result.tasksFile ?? "(inline)"}\` · PASS ${result.totals.PASS} · FAIL ${result.totals.FAIL} · ENV ${result.totals.ENV} · SKIP ${result.totals.SKIP}`,
    "",
    "| Task | 类别 | 难度 | Outcome | Time | Tools | model.call | Survives close | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const task of result.tasks)
    lines.push(
      `| ${cell(`${task.task_id} ${task.title}`)} | ${cell(task.secondary_category ?? task.category ?? "")} | ${cell(task.difficulty ?? "")} | **${task.outcome}** | ${task.durationMs === null ? "-" : `${Math.round(task.durationMs / 1000)} s`} | ${task.toolCount ?? "-"} | ${task.modelCalls ?? "-"} | ${task.survivesSessionClose === null ? "-" : task.survivesSessionClose ? "yes" : "**no**"} | ${cell(task.outcome === "PASS" && task.survivesSessionClose !== false ? "" : [task.reason, ...task.notes].join("; "))} |`,
    );
  lines.push("");
  return lines.join("\n");
}

/**
 * Run a task document against a competition Gateway.
 *
 * @param {{base: string, out: string, tasks?: object, tasksFile?: string, label?: string,
 *   workRoot?: string, only?: string[], taskTimeoutMs?: number, summaryFile?: string,
 *   requireSurvival?: boolean, survivalDelayMs?: number, platform?: NodeJS.Platform,
 *   verifier?: Function, requirement?: Function, processes?: Function,
 *   onTask?: (record: object) => void}} options `tasks` wins over `tasksFile`;
 *   `requireSurvival` fails a desktop task whose app is gone `survivalDelayMs` (default
 *   3000) after DELETE /session; `verifier`, `requirement` and `processes` replace the
 *   local-machine probes in tests.
 * @returns {Promise<object>} The result document also written to <out>/tasks-<label>.json.
 *   Rejects for environment errors (Gateway not ready, invalid task file); a failing
 *   task never rejects.
 */
export async function runTasks(options) {
  const base = String(options.base).replace(/\/+$/, "");
  const platform = options.platform ?? process.platform;
  const taskTimeoutMs = options.taskTimeoutMs ?? 900_000;
  const document =
    options.tasks ?? (await loadTasks(options.tasksFile ?? defaultTasksFile));
  const problems = validateTasks(document);
  if (problems.length)
    throw new Error(`Invalid tasks:\n- ${problems.join("\n- ")}`);
  const verify = options.verifier ?? createVerifier({ platform });
  const requirement =
    options.requirement ?? ((spec) => checkRequirement(spec, { platform }));
  const processes = options.processes ?? (() => listProcesses({ platform }));
  const call = (method, route, extra = {}) =>
    httpRequest(`${base}${route}`, { method, ...extra });

  const ready = await call("GET", "/health/ready").catch((error) => ({
    status: 0,
    text: error.message,
  }));
  if (ready.status !== 200)
    throw new Error(
      `Gateway is not ready at ${base}/health/ready (${ready.status} ${ready.text ?? ""})`,
    );
  const info = await call("GET", "/v1/runtime/info").catch(() => undefined);
  const model = await call("GET", "/v1/harness/model").catch(() => undefined);
  const label = safeName(
    options.label ?? info?.json?.competitionEngine ?? "engine",
  );
  const out = path.resolve(options.out);
  const workRoot = path.resolve(
    options.workRoot ?? path.join(out, "workspaces"),
    label,
  );
  await mkdir(out, { recursive: true });
  const selected = options.only?.length
    ? document.tasks.filter((task) => options.only.includes(task.task_id))
    : document.tasks;
  if (options.only?.length) {
    const missing = options.only.filter(
      (id) => !document.tasks.some((task) => task.task_id === id),
    );
    if (missing.length)
      throw new Error(`--only names unknown tasks: ${missing.join(", ")}`);
  }

  const result = {
    schemaVersion: 1,
    suite: document.suite ?? null,
    label,
    base,
    tasksFile: options.tasks ? null : (options.tasksFile ?? defaultTasksFile),
    platform: `${platform}/${process.arch}`,
    node: process.versions.node,
    engine: info?.json?.competitionEngine ?? null,
    fullAccess: info?.json?.fullAccess ?? null,
    model: model?.json?.model ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totals: { PASS: 0, FAIL: 0, ENV: 0, SKIP: 0 },
    tasks: [],
  };

  for (const task of selected) {
    const record = {
      task_id: task.task_id,
      title: task.title,
      category: task.category ?? null,
      secondary_category: task.secondary_category ?? null,
      difficulty: task.difficulty ?? null,
      query: task.query,
      outcome: "FAIL",
      reason: "",
      notes: [],
      durationMs: null,
      httpStatus: null,
      finish: null,
      toolCount: null,
      tools: [],
      modelCalls: null,
      upstreamModels: [],
      reply: "",
      directory: null,
      sessionId: null,
      requirements: [],
      verify: null,
      survivesSessionClose: null,
      verifyAfterClose: null,
    };
    result.tasks.push(record);
    const platforms = list(task.platform);
    if (platforms.length && !platforms.includes(platform)) {
      record.outcome = "SKIP";
      record.reason = `task runs only on ${platforms.join(", ")}`;
      result.totals.SKIP++;
      options.onTask?.(record);
      continue;
    }

    const directory = path.join(
      workRoot,
      `${safeName(task.task_id)}-${randomBytes(3).toString("hex")}`,
    );
    record.directory = directory;
    const started = Date.now();
    let error;
    let verifyOk = false;
    let sessionId;
    let context;
    const closers = list(task.cleanup).filter(
      (action) => action.kind === "close_process",
    );
    const names = new Set(
      closers.flatMap((action) =>
        list(action.names).map((name) => String(name).toLowerCase()),
      ),
    );
    let before = new Set();
    try {
      await mkdir(directory, { recursive: true });
      await applySetup(directory, task.setup);
      const baseline = await snapshotHashes(directory);
      if (names.size)
        before = new Set(
          (await processes())
            .filter((item) => names.has(item.name))
            .map((item) => item.pid),
        );

      const created = await call("POST", "/session", {
        body: { title: `${task.task_id}-${task.title}`, directory },
        timeoutMs: 120_000,
      });
      if (created.status !== 200 || typeof created.json?.id !== "string")
        throw new Error(
          `POST /session returned ${created.status} ${summarizeBody(created)}`,
        );
      sessionId = created.json.id;
      record.sessionId = sessionId;
      const route = `/session/${encodeURIComponent(sessionId)}`;
      const prompted = await call("POST", `${route}/prompt_async`, {
        body: {
          parts: [{ type: "text", text: task.query }],
          model: {
            providerID: "harnesshub",
            modelID: model?.json?.model ?? "harnesshub-model",
          },
          agent: "assistant",
        },
        timeoutMs: taskTimeoutMs,
      }).catch(async (failure) => {
        if (failure.code !== "TIMEOUT") throw failure;
        record.notes.push(`prompt_async exceeded ${taskTimeoutMs} ms; aborted`);
        await call("POST", `${route}/abort`, { timeoutMs: 60_000 }).catch(
          () => undefined,
        );
        return { status: null, text: "" };
      });
      record.httpStatus = prompted.status;
      if (prompted.status !== 204 && prompted.status !== null)
        record.notes.push(
          `prompt_async returned ${prompted.status} ${summarizeBody(prompted)}`,
        );

      const listed = await call("GET", `${route}/message`, {
        timeoutMs: 60_000,
      });
      const messages = Array.isArray(listed.json) ? listed.json : [];
      record.reply = turnReply(messages).slice(0, 1200);
      const assistant = messages.findLast(
        (message) => (message?.role ?? message?.info?.role) === "assistant",
      );
      record.finish = assistant?.info?.finish ?? null;
      record.tools = messages
        .flatMap((message) => (isObject(message) ? list(message.parts) : []))
        .filter((part) => isObject(part) && part.type === "tool")
        .map((part) => `${part.tool}:${part.state?.status ?? "?"}`);
      record.toolCount = record.tools.length;

      context = {
        directory,
        reply: turnReply(messages),
        baseline,
        variables: checkVariables(directory),
      };
      const deadline = Date.now() + Number(task.verify_wait_ms ?? 0);
      for (;;) {
        record.verify = await verify(task.verify, context);
        if (record.verify.ok || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      verifyOk = record.verify.ok;
      if (!verifyOk) record.notes.push(record.verify.summary);

      try {
        const runs = await call(
          "GET",
          `/v1/sessions/${encodeURIComponent(sessionId)}/runs`,
        );
        if (runs.status === 200 && Array.isArray(runs.json?.runs)) {
          let calls = 0;
          const upstream = new Set();
          for (const run of runs.json.runs) {
            const log = await call(
              "GET",
              `/v1/runs/${encodeURIComponent(run.id)}/event-log?afterSeq=0&limit=1000`,
            );
            for (const event of list(log.json?.events))
              if (isObject(event) && event.type === "model.call") {
                calls++;
                if (event.data?.upstreamModel)
                  upstream.add(String(event.data.upstreamModel));
              }
          }
          record.modelCalls = calls;
          record.upstreamModels = [...upstream];
        }
      } catch {
        // Run statistics are optional evidence; the competition API alone decides.
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }

    for (const spec of list(task.requires))
      try {
        record.requirements.push(await requirement(spec));
      } catch (failure) {
        record.requirements.push({
          satisfied: true,
          evidence: [`requirement probe failed: ${failure.message}`],
        });
      }
    const decided = decideOutcome({
      httpStatus: record.httpStatus,
      verifyOk,
      requirements: record.requirements,
      honest: replyMatches(record.reply, task.env_reply),
      ...(error ? { error } : {}),
    });
    record.outcome = decided.outcome;
    record.reason = decided.reason;

    if (sessionId)
      await call("DELETE", `/session/${encodeURIComponent(sessionId)}`, {
        timeoutMs: 60_000,
      }).catch(() => undefined);
    // Second look at the desktop: closing the Session ends its process Job on Windows.
    if (sessionId && verifyOk && context && usesDesktopState(task.verify)) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.survivalDelayMs ?? 3000),
      );
      const after = await verify(task.verify, context);
      record.survivesSessionClose = after.ok;
      if (!after.ok) {
        record.verifyAfterClose = after;
        record.notes.push(`after DELETE /session: ${after.summary}`);
        if (options.requireSurvival && record.outcome === "PASS") {
          record.outcome = "FAIL";
          record.reason =
            "the application did not survive DELETE /session (--require-survival)";
        }
      }
    }
    result.totals[record.outcome]++;
    if (names.size)
      try {
        for (const item of await processes())
          if (names.has(item.name) && !before.has(item.pid))
            await killProcess(item.pid, platform);
      } catch (failure) {
        record.notes.push(`cleanup failed: ${failure.message}`);
      }
    record.durationMs = Date.now() - started;
    options.onTask?.(record);
  }

  result.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(out, `tasks-${label}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  const table = markdownTable(result);
  await writeFile(path.join(out, `tasks-${label}.md`), table);
  if (options.summaryFile) await appendFile(options.summaryFile, `${table}\n`);
  return result;
}

async function main() {
  const usage =
    "Usage: node scripts/competition-tasks.mjs --base http://127.0.0.1:6217 --out DIR [--tasks FILE] [--engine LABEL] [--work-root DIR] [--only id,id] [--task-timeout-ms 900000] [--summary FILE] [--require-survival]";
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        base: { type: "string" },
        tasks: { type: "string" },
        out: { type: "string" },
        engine: { type: "string" },
        "work-root": { type: "string" },
        only: { type: "string" },
        "task-timeout-ms": { type: "string", default: "900000" },
        summary: { type: "string" },
        "require-survival": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const timeout = Number(values["task-timeout-ms"]);
  if (
    !values.base ||
    !values.out ||
    !Number.isInteger(timeout) ||
    timeout < 1000
  ) {
    console.error(usage);
    return 2;
  }
  try {
    const result = await runTasks({
      base: values.base,
      out: values.out,
      ...(values.tasks ? { tasksFile: path.resolve(values.tasks) } : {}),
      ...(values.engine ? { label: values.engine } : {}),
      ...(values["work-root"] ? { workRoot: values["work-root"] } : {}),
      ...(values.only
        ? {
            only: values.only
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          }
        : {}),
      taskTimeoutMs: timeout,
      ...(values.summary ? { summaryFile: values.summary } : {}),
      requireSurvival: values["require-survival"],
      onTask: (record) =>
        console.log(
          JSON.stringify({
            event: "competition.task",
            task: record.task_id,
            outcome: record.outcome,
            durationMs: record.durationMs,
            reason: record.reason,
            survivesSessionClose: record.survivesSessionClose,
            notes: record.notes,
          }),
        ),
    });
    console.log(
      JSON.stringify({
        event: "competition.tasks",
        label: result.label,
        totals: result.totals,
        out: path.resolve(values.out),
      }),
    );
    return result.totals.FAIL ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
