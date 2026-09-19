#!/usr/bin/env node
/**
 * Scripted stand-in for the company model gateway (ADR 0013 Windows x64 CI acceptance).
 * It never calls a real model and needs no dependencies.
 *
 * Contract emulated:
 * - Only `POST /v1/chat/completions` with `stream: true`; non-streaming requests,
 *   vendor-only fields, `developer` roles and a model other than `--model` get HTTP 400
 *   (rules in scripts/lib/strict-chat.mjs).
 * - Every answer streams `reasoning_content` before the text; the final chunk carries
 *   `finish_reason` plus usage, followed by `data: [DONE]`.
 * - When the current user turn contains `HH_MOCK_TOOL` and the request offers a shell-like
 *   tool (bash/shell/exec/run_shell_command/execute/terminal ... with a `command`/`cmd`
 *   argument), the first round returns one tool call that writes `mock-ok.txt` in the
 *   engine's working directory. The follow-up request must send the tool result and must
 *   pass back the assistant `reasoning_content` of that tool call, otherwise HTTP 400 is
 *   returned exactly like a reasoning model would. After a valid follow-up it answers `DONE`.
 *   Without a shell-like tool it answers `NO_SHELL_TOOL`.
 * - `HH_MOCK_SLOW` streams slowly until `--slow-ms` elapses or the client disconnects.
 * - Anything else is answered with `OK`.
 *
 * Observability (not part of the emulated contract): `GET /__mock/requests?after=<seq>`
 * returns request records without prompts or credentials; `--log` appends the same records
 * as JSON lines.
 *
 * Usage: node scripts/mock-company-model.mjs [--host 127.0.0.1] [--port 0] [--model company-sim]
 *   [--api-key-env NAME] [--log FILE] [--ready-file FILE] [--quirks] [--slow-ms 120000]
 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  chatError,
  contentText,
  isObject,
  readBody,
  sendJson,
  sseData,
  strictChatViolations,
} from "./lib/strict-chat.mjs";

export const mockDirectives = Object.freeze({
  tool: "HH_MOCK_TOOL",
  slow: "HH_MOCK_SLOW",
});
export const mockReplies = Object.freeze({
  ok: "OK",
  done: "DONE",
  noShellTool: "NO_SHELL_TOOL",
});
export const MOCK_MARKER_FILE = "mock-ok.txt";
export const MOCK_MARKER_TEXT = "mock-ok";

const preferredShellTools = [
  "bash",
  "shell",
  "run_shell_command",
  "shell_command",
  "exec_command",
  "exec",
  "execute",
  "terminal",
  "powershell",
  "run_command",
  "execute_command",
  "run_terminal_cmd",
];
const shellName =
  /(bash|shell|exec|execute|terminal|command|powershell|pwsh|cmd)/i;
const notShellName =
  /(code|python|file|read|write|edit|search|grep|glob|web|fetch|browser|todo|task|agent|mcp|notebook|kill|output|status|stdin|process|background|list|view|patch|image)/i;
const commandKeys = ["command", "cmd", "script", "commandLine", "command_line"];

function schemaType(schema) {
  if (!isObject(schema)) return undefined;
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type))
    return schema.type.find((type) => type !== "null");
  for (const key of ["anyOf", "oneOf"])
    if (Array.isArray(schema[key]))
      for (const option of schema[key]) {
        const type = schemaType(option);
        if (type && type !== "null") return type;
      }
  return undefined;
}

/**
 * Choose the shell-like function tool the mock drives, or undefined when none exists.
 * @param {unknown} tools Chat Completions `tools` array.
 */
export function selectShellTool(tools) {
  if (!Array.isArray(tools)) return undefined;
  const candidates = [];
  for (const tool of tools) {
    if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function))
      continue;
    const name = tool.function.name;
    if (
      typeof name !== "string" ||
      !shellName.test(name) ||
      notShellName.test(name)
    )
      continue;
    const parameters = isObject(tool.function.parameters)
      ? tool.function.parameters
      : {};
    const properties = isObject(parameters.properties)
      ? parameters.properties
      : {};
    const key = commandKeys.find((candidate) =>
      Object.hasOwn(properties, candidate),
    );
    if (!key) continue;
    const kind = schemaType(properties[key]) ?? "string";
    if (kind !== "string" && kind !== "array") continue;
    const rank = preferredShellTools.indexOf(name.toLowerCase());
    candidates.push({
      name,
      key,
      kind,
      parameters,
      rank: rank < 0 ? preferredShellTools.length : rank,
    });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return candidates[0];
}

function defaultArgument(name, schema) {
  if (isObject(schema) && Array.isArray(schema.enum) && schema.enum.length)
    return schema.enum[0];
  switch (schemaType(schema)) {
    case "integer":
    case "number":
      return /timeout/i.test(name) ? (/ms|milli/i.test(name) ? 60000 : 60) : 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      if (/dir|cwd|path|folder/i.test(name)) return ".";
      return "Create the HarnessHub mock marker file";
  }
}

/**
 * Tool arguments that create the marker file in the tool's working directory.
 * `echo mock-ok > mock-ok.txt` has the same effect in bash, cmd.exe and PowerShell.
 */
export function markerArguments(selection, platform = process.platform) {
  const command = `echo ${MOCK_MARKER_TEXT} > ${MOCK_MARKER_FILE}`;
  const value =
    selection.kind === "array"
      ? platform === "win32"
        ? [
            "cmd.exe",
            "/d",
            "/c",
            `echo ${MOCK_MARKER_TEXT}> ${MOCK_MARKER_FILE}`,
          ]
        : ["sh", "-c", command]
      : command;
  const result = { [selection.key]: value };
  const properties = isObject(selection.parameters.properties)
    ? selection.parameters.properties
    : {};
  const required = Array.isArray(selection.parameters.required)
    ? selection.parameters.required
    : [];
  for (const name of required)
    if (typeof name === "string" && !Object.hasOwn(result, name))
      result[name] = defaultArgument(name, properties[name]);
  return result;
}

/** Text of the user messages that belong to the turn being answered. */
export function currentTurnText(messages) {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      isObject(message) &&
      message.role === "assistant" &&
      !(Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    ) {
      start = index + 1;
      break;
    }
  }
  return messages
    .slice(start)
    .filter((message) => isObject(message) && message.role === "user")
    .map((message) => contentText(message.content))
    .join("\n");
}

function canonicalArguments(value) {
  if (typeof value !== "string") return JSON.stringify(value ?? null);
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function findIssuedCall(messages, issued) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !isObject(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.tool_calls) ||
      message.tool_calls.length === 0
    )
      continue;
    for (const call of message.tool_calls) {
      if (!isObject(call)) continue;
      const byId =
        typeof call.id === "string" ? issued.get(call.id) : undefined;
      const known =
        byId ??
        [...issued.values()].find(
          (candidate) =>
            candidate.name === call.function?.name &&
            candidate.arguments ===
              canonicalArguments(call.function?.arguments),
        );
      if (known)
        return {
          message,
          issued: known,
          answered: messages
            .slice(index + 1)
            .some((next) => isObject(next) && next.role === "tool"),
        };
    }
    return undefined;
  }
  return undefined;
}

function bearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Start the scripted upstream.
 *
 * @param {{host?: string, port?: number, model?: string, apiKey?: string, logFile?: string,
 *   quirks?: boolean, slowMs?: number, chunkDelayMs?: number, platform?: NodeJS.Platform}} [options]
 * @returns {Promise<{url: string, port: number, model: string, records: () => object[],
 *   close: () => Promise<void>}>} `url` ends with `/v1` and is suitable for
 *   HARNESSHUB_MODEL_BASE_URL. `close` stops accepting requests and ends open streams.
 */
export async function startMockCompanyModel(options = {}) {
  const model = options.model ?? "company-sim";
  const quirks = options.quirks === true;
  const slowMs = options.slowMs ?? 120_000;
  const chunkDelayMs = options.chunkDelayMs ?? 15;
  const platform = options.platform ?? process.platform;
  const issued = new Map();
  const issuesPerTurn = new Map();
  const records = [];
  const sockets = new Set();
  let sequence = 0;
  let logQueue = Promise.resolve();
  let closing = false;

  function record(entry) {
    const value = { seq: ++sequence, at: new Date().toISOString(), ...entry };
    records.push(value);
    if (records.length > 10_000) records.shift();
    if (options.logFile) {
      const line = `${JSON.stringify(value)}\n`;
      logQueue = logQueue.then(() => appendFile(options.logFile, line));
      logQueue.catch(() => undefined);
    }
    return value;
  }

  async function writeStream(response, frames, stepDelayMs) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const frame of frames) {
      if (response.destroyed || closing) return false;
      if (!response.write(sseData(frame))) await once(response, "drain");
      if (stepDelayMs > 0) await delay(stepDelayMs);
    }
    if (response.destroyed) return false;
    response.end();
    return true;
  }

  function chunkFactory() {
    const id = `chatcmpl-hhmock-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    return (delta, finishReason = null, extra = {}, omitIndex = false) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          ...(omitIndex ? {} : { index: 0 }),
          delta,
          finish_reason: finishReason,
        },
      ],
      ...extra,
    });
  }

  function usage(promptChars, completion) {
    const prompt = Math.max(1, Math.ceil(promptChars / 4));
    const output = Math.max(1, Math.ceil(completion.length / 4));
    return {
      prompt_tokens: prompt,
      completion_tokens: output,
      ...(quirks ? {} : { total_tokens: prompt + output }),
      completion_tokens_details: { reasoning_tokens: Math.ceil(output / 2) },
    };
  }

  function textFrames(text, reasoning, promptChars) {
    const chunk = chunkFactory();
    const half = Math.ceil(reasoning.length / 2);
    const frames = [
      chunk({
        role: "assistant",
        content: null,
        reasoning_content: reasoning.slice(0, half),
      }),
      chunk({ reasoning_content: reasoning.slice(half) }),
      chunk({ content: text }),
    ];
    const finalUsage = usage(promptChars, reasoning + text);
    if (quirks) frames.push(chunk({}, "stop"));
    frames.push(chunk({}, "stop", { usage: finalUsage }));
    frames.push("[DONE]");
    return frames;
  }

  function toolFrames(
    selection,
    callId,
    argumentsText,
    reasoning,
    promptChars,
  ) {
    const chunk = chunkFactory();
    const split = Math.ceil(argumentsText.length / 2);
    const frames = [
      chunk({ role: "assistant", content: null, reasoning_content: reasoning }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: callId,
            type: "function",
            function: { name: selection.name, arguments: "" },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            ...(quirks ? {} : { index: 0 }),
            function: { arguments: argumentsText.slice(0, split) },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            ...(quirks ? {} : { index: 0 }),
            function: { arguments: argumentsText.slice(split) },
          },
        ],
      }),
    ];
    const finalUsage = usage(promptChars, reasoning + argumentsText);
    if (quirks) frames.push(chunk({}, "tool_calls"));
    frames.push(chunk({}, "tool_calls", { usage: finalUsage }));
    frames.push("[DONE]");
    return frames;
  }

  async function slowStream(response, promptChars, entry) {
    const chunk = chunkFactory();
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(
      sseData(
        chunk({
          role: "assistant",
          content: null,
          reasoning_content: "Long task requested; streaming slowly.",
        }),
      ),
    );
    const until = Date.now() + slowMs;
    let produced = "";
    while (Date.now() < until) {
      if (response.destroyed || closing) {
        entry.aborted = true;
        return;
      }
      produced += ".";
      response.write(sseData(chunk({ content: "." })));
      await delay(500);
    }
    if (response.destroyed) {
      entry.aborted = true;
      return;
    }
    response.write(sseData(chunk({ content: ` ${mockReplies.done}` })));
    response.write(
      sseData(chunk({}, "stop", { usage: usage(promptChars, produced) })),
    );
    response.end(sseData("[DONE]"));
  }

  async function chat(request, response, entry) {
    let raw;
    try {
      raw = await readBody(request);
    } catch (error) {
      entry.status = error.statusCode ?? 400;
      return sendJson(response, entry.status, chatError(error.message));
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      entry.status = 400;
      entry.violations = ["request body is not valid JSON"];
      return sendJson(
        response,
        400,
        chatError("Request body is not valid JSON"),
      );
    }
    entry.model =
      isObject(body) && typeof body.model === "string" ? body.model : null;
    entry.stream = isObject(body) ? body.stream === true : false;
    entry.messages =
      isObject(body) && Array.isArray(body.messages) ? body.messages.length : 0;
    entry.tools =
      isObject(body) && Array.isArray(body.tools) ? body.tools.length : 0;
    entry.maxTokensField = isObject(body)
      ? (["max_tokens", "max_completion_tokens"].find((name) =>
          Object.hasOwn(body, name),
        ) ?? null)
      : null;
    const violations = strictChatViolations(body, { expectModel: model });
    if (violations.length) {
      entry.status = 400;
      entry.violations = violations;
      return sendJson(
        response,
        400,
        chatError(
          `Rejected by strict company gateway emulation: ${violations.join("; ")}`,
        ),
      );
    }
    const messages = body.messages;
    const promptChars = raw.length;
    const turn = currentTurnText(messages);
    if (turn.includes(mockDirectives.slow)) {
      entry.turn = "slow";
      entry.status = 200;
      return slowStream(response, promptChars, entry);
    }
    if (turn.includes(mockDirectives.tool)) {
      const previous = findIssuedCall(messages, issued);
      if (previous?.answered) {
        entry.turn = "tool-result";
        entry.tool = previous.issued.name;
        const echoed = previous.message.reasoning_content;
        if (typeof echoed !== "string" || echoed.trim().length === 0) {
          entry.status = 400;
          entry.reasoningEcho = false;
          entry.violations = [
            "assistant tool-call message did not pass back reasoning_content",
          ];
          return sendJson(
            response,
            400,
            chatError(
              "The reasoning_content in the thinking mode must be passed back to the API.",
              "invalid_request_error",
              "reasoning_content_missing",
            ),
          );
        }
        entry.reasoningEcho =
          echoed.trim() === previous.issued.reasoning.trim()
            ? true
            : "mismatch";
        entry.status = 200;
        return writeStream(
          response,
          textFrames(
            mockReplies.done,
            "The marker command finished; reporting completion.",
            promptChars,
          ),
          chunkDelayMs,
        );
      }
      const selection = selectShellTool(body.tools);
      if (!selection) {
        entry.turn = entry.tools > 0 ? "no-shell-tool" : "no-tools";
        entry.toolNames = Array.isArray(body.tools)
          ? body.tools
              .map((tool) =>
                isObject(tool) && isObject(tool.function)
                  ? tool.function.name
                  : null,
              )
              .filter((name) => typeof name === "string")
              .slice(0, 40)
          : [];
        entry.status = 200;
        return writeStream(
          response,
          textFrames(
            entry.tools > 0 ? mockReplies.noShellTool : mockReplies.ok,
            "No shell-like tool is available for the marker command.",
            promptChars,
          ),
          chunkDelayMs,
        );
      }
      const turnKey = createHash("sha256").update(turn).digest("hex");
      const attempts = (issuesPerTurn.get(turnKey) ?? 0) + 1;
      issuesPerTurn.set(turnKey, attempts);
      if (attempts > 3) {
        entry.turn = "tool-loop-stopped";
        entry.status = 200;
        return writeStream(
          response,
          textFrames(
            mockReplies.done,
            "Tool call was not answered; stopping.",
            promptChars,
          ),
          chunkDelayMs,
        );
      }
      const callId = `call_hhmock_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const argumentsText = JSON.stringify(
        markerArguments(selection, platform),
      );
      const reasoning = `Need to run ${selection.name} once to create ${MOCK_MARKER_FILE}; call ${callId}.`;
      issued.set(callId, {
        id: callId,
        name: selection.name,
        arguments: canonicalArguments(argumentsText),
        reasoning,
      });
      entry.turn = "tool-call";
      entry.tool = selection.name;
      entry.toolCallId = callId;
      entry.status = 200;
      return writeStream(
        response,
        toolFrames(selection, callId, argumentsText, reasoning, promptChars),
        chunkDelayMs,
      );
    }
    entry.turn = "plain";
    entry.status = 200;
    return writeStream(
      response,
      textFrames(
        mockReplies.ok,
        "The instruction asks for a short acknowledgement.",
        promptChars,
      ),
      chunkDelayMs,
    );
  }

  const server = createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__mock/health")
      return sendJson(response, 200, { ok: true, model });
    if (url.pathname === "/__mock/requests") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return sendJson(response, 200, {
        last: sequence,
        requests: records.filter(
          (entry) => entry.seq > (Number.isFinite(after) ? after : 0),
        ),
      });
    }
    const entry = {
      method: request.method,
      path: url.pathname,
      status: 0,
      auth: "not-required",
    };
    const finish = () => {
      entry.durationMs = Date.now() - started;
      // The connection closed before the response ended: the client (engine) disconnected.
      if (!response.writableEnded) entry.aborted = true;
      record(entry);
    };
    response.once("close", finish);
    if (options.apiKey !== undefined) {
      const presented = bearer(request);
      entry.auth =
        presented === undefined
          ? "missing"
          : presented === options.apiKey
            ? "ok"
            : "invalid";
      if (entry.auth !== "ok") {
        entry.status = 401;
        return sendJson(
          response,
          401,
          chatError(
            "Invalid API key",
            "authentication_error",
            "invalid_api_key",
          ),
        );
      }
    }
    if (url.pathname === "/v1/models" && request.method === "GET") {
      entry.status = 200;
      return sendJson(response, 200, {
        object: "list",
        data: [{ id: model, object: "model", owned_by: "harnesshub-mock" }],
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      if (request.method !== "POST") {
        entry.status = 405;
        return sendJson(response, 405, chatError("Method not allowed"));
      }
      chat(request, response, entry).catch((error) => {
        entry.status = 500;
        entry.violations = [
          `mock failure: ${error instanceof Error ? error.message : String(error)}`,
        ];
        if (!response.headersSent)
          sendJson(
            response,
            500,
            chatError("Mock upstream failure", "server_error"),
          );
        else response.destroy();
      });
      return undefined;
    }
    entry.status = 404;
    return sendJson(
      response,
      404,
      chatError(`Unknown path ${url.pathname}`, "not_found_error"),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const host = options.host ?? "127.0.0.1";
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    url: `${origin}/v1`,
    port: address.port,
    model,
    records: () => records.slice(),
    async close() {
      closing = true;
      const closed = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      await logQueue.catch(() => undefined);
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "0" },
        model: { type: "string", default: "company-sim" },
        "api-key-env": { type: "string" },
        log: { type: "string" },
        "ready-file": { type: "string" },
        quirks: { type: "boolean", default: false },
        "slow-ms": { type: "string", default: "120000" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (values.help) {
      console.log(
        "node scripts/mock-company-model.mjs [--host 127.0.0.1] [--port 0] [--model company-sim] [--api-key-env NAME] [--log FILE] [--ready-file FILE] [--quirks] [--slow-ms 120000]",
      );
    } else {
      const port = Number(values.port);
      const slowMs = Number(values["slow-ms"]);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("--port must be 0-65535");
      if (!Number.isInteger(slowMs) || slowMs < 1000)
        throw new Error("--slow-ms must be an integer >= 1000");
      let apiKey;
      if (values["api-key-env"]) {
        apiKey = process.env[values["api-key-env"]];
        if (!apiKey)
          throw new Error(
            `Environment variable ${values["api-key-env"]} is empty`,
          );
      }
      const mock = await startMockCompanyModel({
        host: values.host,
        port,
        model: values.model,
        quirks: values.quirks,
        slowMs,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(values.log ? { logFile: path.resolve(values.log) } : {}),
      });
      const ready = {
        event: "mock-company-model.ready",
        url: mock.url,
        port: mock.port,
        model: mock.model,
        quirks: values.quirks,
      };
      if (values["ready-file"])
        await writeFile(
          path.resolve(values["ready-file"]),
          `${JSON.stringify(ready)}\n`,
        );
      console.log(JSON.stringify(ready));
      const stop = () => {
        mock.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
