#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Strict upstream emulator for tests and local development
 * (docs/proposals/oss/10-engineering.md §3.4; usage in README.md). It never
 * calls a real model, needs no dependencies and listens on loopback only.
 *
 * Endpoints, each with its native authentication and error envelope:
 * `POST /v1/chat/completions` (OpenAI Chat Completions), `POST /v1/responses`
 * (OpenAI Responses), `POST /v1/messages` and `/v1/messages/count_tokens`
 * (Anthropic Messages), `POST /v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent` (Gemini; `/v1/models/...` works as well) and
 * `GET /v1/models` (OpenAI form, or Anthropic form when the request has an
 * `anthropic-version` header). Each request is checked against the field
 * lists of fields.mjs in blacklist (default) or whitelist mode; a rejected
 * field is a 400 naming its path. Answers come from script.mjs; quirks.mjs
 * lists the misbehaviours that can be switched on.
 *
 * Observation, which never contains prompts, completions or key values:
 * `GET /__fake/requests?after=<seq>` and `records()` list one record per
 * request once its response closed; `GET /__fake/health` answers `{ok: true}`.
 *
 * Usage: node tools/fake-provider/index.mjs [--host 127.0.0.1] [--port 0]
 *   [--ready-file FILE] [--mode blacklist|whitelist] [--model ID]...
 *   [--key-env NAME]... [--script FILE] [--fields FILE] [--quirk NAME[=VALUE]]...
 *   [--log FILE] [--chunk-delay-ms 15] [--slow-ms 120000] [--stream-only]
 *   [--no-reasoning-replay]
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  canonicalArguments,
  clip,
  estimateTokens,
  hex,
  isObject,
  readBody,
} from "./common.mjs";
import { countTokensBody } from "./messages.mjs";
import { isLoopback, resolveOptions } from "./options.mjs";
import { PROTOCOL_MODULES } from "./protocols.mjs";
import { activeQuirks } from "./quirks.mjs";
import { foreignSeal } from "./responses.mjs";
import {
  createState,
  echoStatus,
  findIssuedCall,
  planTurn,
} from "./script.mjs";
import { fieldViolations } from "./validate.mjs";

export { DIRECTIVES, MARKER_FILE, MARKER_TEXT, REPLIES } from "./script.mjs";
export { BASE_FIELDS, PROTOCOLS } from "./fields.mjs";
export { QUIRKS } from "./quirks.mjs";

const MAX_RECORDS = 10_000;
const HTML_PAGE =
  "<!DOCTYPE html>\n<html><head><title>Service Unavailable</title></head>" +
  "<body><h1>Service temporarily unavailable</h1><p>Please try again later.</p></body></html>\n";

/**
 * Fingerprint of a presented credential, as request records show it:
 * `sha256:` and the first 16 hex digits of its SHA-256. Tests compare it with
 * the fingerprint of a canary to prove which secret reached the provider.
 */
export function credentialFingerprint(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

const GEMINI_ROUTE =
  /^\/v1(?:beta)?\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;
const POST_ROUTES = {
  "/v1/chat/completions": { protocol: "chat" },
  "/v1/responses": { protocol: "responses" },
  "/v1/messages": { protocol: "messages" },
  "/v1/messages/count_tokens": { protocol: "messages", countTokens: true },
};

/** Route a request; `kind` is `call`, `models`, `method` (wrong method) or absent. */
function route(method, url) {
  const gemini = GEMINI_ROUTE.exec(url.pathname);
  if (gemini) {
    if (method !== "POST") return { kind: "method", protocol: "gemini" };
    let model;
    try {
      model = decodeURIComponent(gemini[1]);
    } catch {
      return undefined;
    }
    const stream = gemini[2] === "streamGenerateContent";
    return {
      kind: "call",
      protocol: "gemini",
      model,
      stream,
      sse: stream && url.searchParams.get("alt") === "sse",
    };
  }
  if (url.pathname === "/v1/models")
    return method === "GET"
      ? { kind: "models" }
      : { kind: "method", protocol: "chat" };
  const known = POST_ROUTES[url.pathname];
  if (!known) return undefined;
  return method === "POST"
    ? { kind: "call", ...known }
    : { kind: "method", ...known };
}

function guessProtocol(pathname) {
  if (/\/messages(?:\/|$)/.test(pathname)) return "messages";
  if (/\/models\/[^/]+:/.test(pathname)) return "gemini";
  if (/\/responses\/?$/.test(pathname)) return "responses";
  return "chat";
}

function responseId(protocol) {
  switch (protocol) {
    case "chat":
      return `chatcmpl-${hex(12)}`;
    case "responses":
      return `resp_${hex(24)}`;
    case "messages":
      return `msg_${hex(12)}`;
    default:
      return hex(12);
  }
}

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

/**
 * Start a fake provider.
 *
 * @param {object} [options]
 * @param {string} [options.host] Loopback address to listen on (default
 *   127.0.0.1); anything else is rejected before listening.
 * @param {number} [options.port] Default 0 (any free port).
 * @param {"blacklist" | "whitelist"} [options.mode] Field check (default blacklist).
 * @param {string[]} [options.models] Served model ids (default `["upstream-sim"]`);
 *   another model is a 404 recorded as a `model` violation.
 * @param {Record<string, string>} [options.keys] Accepted keys by id. When
 *   set, a request without one of them in its protocol's native place gets the
 *   native authentication error; records name the key id, never the value.
 *   Without keys every request is accepted (`auth: "not-required"`).
 * @param {unknown} [options.fields] Field manifest added to the lists (fields.mjs).
 * @param {unknown} [options.script] Scripted turns (script.mjs).
 * @param {unknown} [options.quirks] Quirks for every request (quirks.mjs).
 * @param {number} [options.chunkDelayMs] Wait between stream frames (default 15).
 * @param {number} [options.slowMs] Length of an `HH_MOCK_SLOW` answer (default 120000).
 * @param {boolean} [options.streamOnly] Reject non-streaming requests (default false).
 * @param {boolean} [options.reasoningReplay] Reject a tool result whose
 *   assistant message does not carry back the reasoning of the call this
 *   provider made, in the protocol's native place (default true).
 * @param {number} [options.maxBodyBytes] Largest request body (default 8 MiB).
 * @param {string} [options.logFile] Also append each record to this file as a JSON line.
 * @param {string} [options.platform] Platform the `HH_MOCK_TOOL` command is
 *   written for (default the current one).
 * @returns {Promise<{url: string, port: number, models: readonly string[],
 *   mode: string, records: (after?: number) => object[],
 *   violations: () => object[], activity: () => {responses: number, timers: number, sockets: number},
 *   idle: () => Promise<void>, close: () => Promise<void>}>}
 *   `url` is the origin without a path (OpenAI SDKs take `${url}/v1`).
 *   `records` returns copies of the request records after a sequence number;
 *   `violations` every recorded violation with its record's `seq` and
 *   `protocol`; `activity` the responses in progress, pending delay timers and
 *   open sockets; `idle` resolves once every request received so far has
 *   closed and been recorded. `close` stops listening, aborts open responses
 *   (cancelling their timers), destroys connections and resolves after every
 *   handler ended; it is idempotent and rejects with a log write failure.
 * @throws {Error} For invalid options, a non-loopback host or a listen failure.
 */
export async function startFakeProvider(options = {}) {
  const settings = resolveOptions(options);
  const state = createState(settings.script);
  const keyIds = new Map([...settings.keys].map(([id, value]) => [value, id]));
  const records = [];
  const sockets = new Set();
  const controllers = new Set();
  const jobs = new Set();
  let sequence = 0;
  let timers = 0;
  let logQueue = Promise.resolve();
  let logError;
  let closing;

  function record(entry) {
    const value = { seq: ++sequence, at: new Date().toISOString(), ...entry };
    records.push(value);
    if (records.length > MAX_RECORDS) records.shift();
    if (settings.logFile) {
      const line = `${JSON.stringify(value)}\n`;
      logQueue = logQueue
        .then(() => appendFile(settings.logFile, line))
        .catch((error) => {
          logError ??= error;
        });
    }
  }

  async function sleep(ms, signal) {
    signal.throwIfAborted();
    if (ms <= 0) return;
    timers++;
    try {
      await delay(ms, undefined, { signal });
    } finally {
      timers--;
    }
  }

  async function write(response, text, signal) {
    signal.throwIfAborted();
    if (!response.write(text)) await once(response, "drain", { signal });
  }

  async function handle(request, response, signal) {
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://fake-provider.invalid");
    if (request.method === "GET" && url.pathname === "/__fake/health")
      return sendJson(response, 200, {
        ok: true,
        models: settings.models,
        mode: settings.mode,
      });
    if (request.method === "GET" && url.pathname === "/__fake/requests") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return sendJson(response, 200, {
        last: sequence,
        requests: records.filter(
          (entry) => entry.seq > (Number.isFinite(after) ? after : 0),
        ),
      });
    }
    const routed = route(request.method, url);
    const protocolName =
      routed?.kind === "models"
        ? typeof request.headers["anthropic-version"] === "string"
          ? "messages"
          : "chat"
        : (routed?.protocol ?? guessProtocol(url.pathname));
    const protocol = PROTOCOL_MODULES[protocolName];
    const entry = {
      method: request.method,
      path: clip(url.pathname, 200),
      protocol: protocolName,
      status: 0,
      auth: "not-required",
      keyId: null,
      keyFingerprint: null,
      violations: [],
    };
    let cutOff = false;
    const closed = once(response, "close").then(() => {
      entry.durationMs = Date.now() - started;
      // The connection closed before the response ended: the client disconnected.
      if (!response.writableEnded && !cutOff) entry.aborted = true;
      record(entry);
    });
    const reply = (status, body, headers) => {
      entry.status = status;
      sendJson(response, status, body, headers);
    };
    try {
      if (!routed)
        return reply(404, protocol.error(404, `Unknown path ${entry.path}`));
      if (routed.kind === "method")
        return reply(405, protocol.error(405, "Method not allowed"));

      const presented = protocol.credential(request, url);
      if (presented)
        entry.keyFingerprint = credentialFingerprint(presented.value);
      if (settings.keys.size) {
        const id = presented ? keyIds.get(presented.value) : undefined;
        entry.auth = !presented
          ? "missing"
          : id === undefined
            ? "invalid"
            : "ok";
        if (entry.auth !== "ok") {
          const failure = protocol.authFailure(entry.auth);
          return reply(failure.status, failure.body);
        }
        entry.keyId = id;
      }

      if (routed.kind === "models") {
        entry.turn = "models";
        const created = Math.floor(Date.now() / 1000);
        return reply(
          200,
          protocolName === "messages"
            ? {
                data: settings.models.map((id) => ({
                  type: "model",
                  id,
                  display_name: id,
                  created_at: new Date(created * 1000).toISOString(),
                })),
                has_more: false,
                first_id: settings.models[0],
                last_id: settings.models.at(-1),
              }
            : {
                object: "list",
                data: settings.models.map((id) => ({
                  id,
                  object: "model",
                  created,
                  owned_by: "harnesshub-fake",
                })),
              },
        );
      }

      let raw;
      try {
        raw = await readBody(request, settings.maxBodyBytes);
      } catch (error) {
        if (error.statusCode !== 413) throw error;
        return reply(413, protocol.error(413, "Request body is too large"));
      }
      let body;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      } catch {
        entry.violations = [
          {
            path: "",
            rule: "structure",
            message: "request body is not valid UTF-8 JSON",
          },
        ];
        const failure = protocol.invalid(entry.violations);
        return reply(failure.status, failure.body);
      }
      if (!isObject(body)) {
        entry.violations = [
          {
            path: "",
            rule: "structure",
            message: "request body must be a JSON object",
          },
        ];
        const failure = protocol.invalid(entry.violations);
        return reply(failure.status, failure.body);
      }
      const model = protocol.model(body, routed);
      entry.model = typeof model === "string" ? clip(model, 200) : null;
      entry.stream = protocol.isStream(body, routed);
      entry.maxTokensField =
        ["max_tokens", "max_completion_tokens", "max_output_tokens"].find(
          (name) => Object.hasOwn(body, name),
        ) ?? null;

      const violations = [
        ...protocol.structure(body, routed, request),
        ...fieldViolations(
          protocolName,
          body,
          settings.fields[protocolName],
          settings.mode,
          routed,
        ),
      ];
      if (settings.streamOnly && !routed.countTokens && !entry.stream)
        violations.push({
          path: "stream",
          rule: "stream",
          message: "this upstream only streams",
        });
      if (violations.length) {
        entry.violations = violations;
        const failure = protocol.invalid(violations);
        return reply(failure.status, failure.body);
      }
      if (!settings.models.includes(model)) {
        entry.violations = [
          {
            path: "model",
            rule: "model",
            message: `model ${entry.model} is not served here (${settings.models.join(", ")})`,
          },
        ];
        return reply(
          404,
          protocol.error(
            404,
            `The model \`${entry.model}\` does not exist or you do not have access to it.`,
            {
              code: "model_not_found",
            },
          ),
        );
      }
      const inputTokens = estimateTokens(raw.length);
      if (routed.countTokens) {
        entry.turn = "count-tokens";
        return reply(200, countTokensBody(inputTokens));
      }

      const view = protocol.read(body);
      entry.messages = view.messages.length;
      entry.tools = view.tools.length;
      entry.images = view.images;
      const previous = findIssuedCall(view.messages, state.issued);
      if (previous?.answered && previous.issued.reasoningSent) {
        entry.reasoningEcho = echoStatus(
          previous.message.echo,
          previous.issued,
        );
        if (
          entry.reasoningEcho === false &&
          settings.reasoningReplay &&
          protocol.replayRequired(body)
        ) {
          entry.turn = "tool-result";
          entry.tool = previous.issued.name;
          entry.violations = [
            {
              path: previous.message.path,
              rule: "reasoning",
              message:
                "did not pass back the reasoning of the tool call it answers",
            },
          ];
          const failure = protocol.replayError(previous);
          return reply(failure.status, failure.body);
        }
      }

      if (protocolName === "responses" && settings.quirks.foreignSeals) {
        const foreign = foreignSeal(body, state.seals);
        if (foreign) {
          entry.turn = "foreign-seal";
          entry.quirks = activeQuirks(settings.quirks);
          // OpenAI's answer to reasoning another organization sealed.
          return reply(
            400,
            protocol.error(
              400,
              `The encrypted content for item ${clip(foreign.id, 64)} could not be verified.`,
              { code: "invalid_encrypted_content", param: foreign.path },
            ),
          );
        }
      }

      const plan = planTurn(view, state, {
        protocol,
        streaming: entry.stream,
        inputTokens,
        slowMs: settings.slowMs,
        platform: settings.platform,
      });
      entry.turn = plan.turn;
      if (plan.script !== undefined) entry.script = plan.script;
      if (plan.tool) entry.tool = plan.tool;
      if (plan.toolNames) entry.toolNames = plan.toolNames;
      const quirks = { ...settings.quirks, ...plan.quirks };
      entry.quirks = activeQuirks(quirks);

      await sleep(quirks.slowHeaders, signal);
      if (quirks.retryAfter) {
        const { status, seconds } = quirks.retryAfter;
        const message =
          status === 429
            ? `Rate limit reached; retry after ${seconds} seconds.`
            : `The upstream is temporarily unavailable; retry after ${seconds} seconds.`;
        return reply(
          status,
          protocol.error(
            status,
            message,
            protocolName === "gemini"
              ? {
                  details: [
                    {
                      "@type": "type.googleapis.com/google.rpc.RetryInfo",
                      retryDelay: `${seconds}s`,
                    },
                  ],
                }
              : {},
          ),
          { "Retry-After": String(seconds) },
        );
      }
      if (plan.error)
        return reply(
          plan.error.status,
          protocol.error(plan.error.status, plan.error.message),
        );
      if (quirks.htmlBody) {
        entry.status = 200;
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(HTML_PAGE),
        });
        response.end(HTML_PAGE);
        return undefined;
      }

      const answer = plan.answer;
      if (quirks.noUsage) answer.usage = null;
      if (quirks.abnormalFinish) answer.finish = quirks.abnormalFinish;
      const reasoningSent =
        answer.reasoning.length > 0 && protocol.reasoningShown(body);
      if (answer.reasoning.length) state.seals.add(answer.signature);
      for (const call of answer.toolCalls)
        state.issued.set(call.id ?? `unnamed-${hex(8)}`, {
          name: call.name,
          arguments: canonicalArguments(call.arguments),
          reasoning: answer.reasoning.join(""),
          signature: answer.signature,
          reasoningSent,
        });
      if (answer.toolCalls.length === 1 && answer.toolCalls[0].id)
        entry.toolCallId = answer.toolCalls[0].id;
      const context = {
        id: responseId(protocolName),
        created: Math.floor(Date.now() / 1000),
        model: quirks.servedModel ?? model,
        request: body,
        sse: routed.sse === true,
        quirks: {
          duplicateFinish: quirks.duplicateFinish,
          missingToolIndex: quirks.missingToolIndex,
          interleavedToolArgs: quirks.interleavedToolArgs,
        },
      };
      const firstByteDelayMs = plan.firstByteDelayMs ?? 0;
      const keepalives = async (streaming) => {
        if (!quirks.commentKeepalive) return;
        const { durationMs, intervalMs } = quirks.commentKeepalive;
        const frame = protocol.keepalive(context, streaming);
        const until = Date.now() + durationMs;
        for (let left = durationMs; left > 0; left = until - Date.now()) {
          await write(response, frame, signal);
          await sleep(Math.min(intervalMs, left), signal);
        }
      };
      const failure = quirks.midStreamError;
      const disconnect = quirks.disconnect;
      entry.status = 200;
      if (entry.stream) {
        const { contentType, frames } = protocol.frames(answer, context);
        response.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.flushHeaders();
        await sleep(firstByteDelayMs, signal);
        await keepalives(true);
        const chunkDelayMs = plan.chunkDelayMs ?? settings.chunkDelayMs;
        const count = failure
          ? Math.min(failure.after, frames.length - 1)
          : disconnect
            ? Math.min(disconnect.after, frames.length - 1)
            : frames.length;
        for (let index = 0; index < count; index++) {
          if (index > 0) await sleep(chunkDelayMs, signal);
          await write(response, frames[index], signal);
        }
        if (disconnect && !failure) {
          entry.disconnected = true;
          // Let the frames reach the client, then drop the connection.
          await new Promise((resolve) => response.write("", resolve));
          cutOff = true;
          response.socket?.end();
          response.destroy();
          return undefined;
        }
        if (failure) {
          entry.midStreamError = true;
          await write(
            response,
            protocol.streamError(context, failure.message, count),
            signal,
          );
        }
        response.end();
        return undefined;
      }
      const text = JSON.stringify(protocol.render(answer, context));
      await sleep(firstByteDelayMs, signal);
      if (!quirks.commentKeepalive && !failure && !disconnect) {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(text),
        });
        response.end(text);
        return undefined;
      }
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.flushHeaders();
      await keepalives(false);
      if (failure || disconnect) {
        if (failure) entry.midStreamError = true;
        else entry.disconnected = true;
        await write(
          response,
          text.slice(0, Math.floor(text.length / 2)),
          signal,
        );
        cutOff = true;
        response.destroy();
        return undefined;
      }
      response.end(text);
      return undefined;
    } catch (error) {
      // The client disconnected or the provider is closing; the close
      // listener records the request as aborted.
      if (signal.aborted || error?.clientClosed) return undefined;
      entry.error = `fake provider failure: ${error instanceof Error ? error.message : String(error)}`;
      if (!response.headersSent)
        reply(500, protocol.error(500, "Fake provider failure"));
      else {
        cutOff = true;
        response.destroy();
      }
      return undefined;
    } finally {
      await closed;
    }
  }

  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => {
      controller.abort();
      controllers.delete(controller);
    });
    const job = handle(request, response, controller.signal).finally(() =>
      jobs.delete(job),
    );
    jobs.add(job);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  function close() {
    closing ??= (async () => {
      const stopped = new Promise((resolve) => server.close(() => resolve()));
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      await stopped;
      await Promise.allSettled([...jobs]);
      await logQueue;
      if (logError) throw logError;
    })();
    return closing;
  }

  server.listen(settings.port, settings.host);
  await once(server, "listening");
  const address = server.address();
  if (!isLoopback(address.address)) {
    await close();
    throw new Error(
      `The fake provider bound to ${address.address}, which is not a loopback address`,
    );
  }
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    models: settings.models,
    mode: settings.mode,
    records: (after = 0) =>
      structuredClone(records.filter((entry) => entry.seq > after)),
    violations: () =>
      records.flatMap((entry) =>
        entry.violations.map((violation) => ({
          seq: entry.seq,
          protocol: entry.protocol,
          ...violation,
        })),
      ),
    activity: () => ({
      responses: controllers.size,
      timers,
      sockets: sockets.size,
    }),
    idle: async () => {
      while (jobs.size) await Promise.allSettled([...jobs]);
    },
    close,
  };
}

const USAGE = `node tools/fake-provider/index.mjs [--host 127.0.0.1] [--port 0] [--ready-file FILE]
  [--mode blacklist|whitelist] [--model ID]... [--key-env NAME]... [--script FILE]
  [--fields FILE] [--quirk NAME[=VALUE]]... [--log FILE] [--chunk-delay-ms 15]
  [--slow-ms 120000] [--stream-only] [--no-reasoning-replay]`;

function integerArgument(value, name) {
  if (!/^\d+$/.test(value))
    throw new Error(`--${name} must be a non-negative integer`);
  return Number(value);
}

async function readJson(file, name) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `--${name} ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parse the command line into `startFakeProvider` options. `--key-env NAME`
 * accepts the key in environment variable NAME under the id NAME, so key
 * values never appear in arguments. `--quirk NAME=VALUE` parses VALUE as JSON
 * when it can, otherwise takes it as a string; a bare NAME means `true`.
 *
 * @param {string[]} args Arguments after the script path.
 * @param {Record<string, string | undefined>} env Supplies `--key-env` values.
 * @returns {Promise<{help: boolean, readyFile?: string, options: object}>}
 * @throws {Error} For unknown or invalid arguments, an empty key variable or an unreadable file.
 */
export async function parseCommandLine(args, env) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "ready-file": { type: "string" },
      mode: { type: "string" },
      model: { type: "string", multiple: true },
      "key-env": { type: "string", multiple: true },
      script: { type: "string" },
      fields: { type: "string" },
      quirk: { type: "string", multiple: true },
      log: { type: "string" },
      "chunk-delay-ms": { type: "string" },
      "slow-ms": { type: "string" },
      "stream-only": { type: "boolean" },
      "no-reasoning-replay": { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) return { help: true, options: {} };
  const options = {};
  if (values.host !== undefined) options.host = values.host;
  if (values.port !== undefined)
    options.port = integerArgument(values.port, "port");
  if (values.mode !== undefined) options.mode = values.mode;
  if (values.model) options.models = values.model;
  if (values["key-env"]) {
    options.keys = {};
    for (const name of values["key-env"]) {
      if (!env[name])
        throw new Error(`--key-env ${name}: the environment variable is empty`);
      options.keys[name] = env[name];
    }
  }
  if (values.script !== undefined)
    options.script = await readJson(path.resolve(values.script), "script");
  if (values.fields !== undefined)
    options.fields = await readJson(path.resolve(values.fields), "fields");
  if (values.quirk) {
    options.quirks = {};
    for (const quirk of values.quirk) {
      const separator = quirk.indexOf("=");
      if (separator < 0) {
        options.quirks[quirk] = true;
        continue;
      }
      const text = quirk.slice(separator + 1);
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
      options.quirks[quirk.slice(0, separator)] = value;
    }
  }
  if (values.log !== undefined) options.logFile = path.resolve(values.log);
  if (values["chunk-delay-ms"] !== undefined)
    options.chunkDelayMs = integerArgument(
      values["chunk-delay-ms"],
      "chunk-delay-ms",
    );
  if (values["slow-ms"] !== undefined)
    options.slowMs = integerArgument(values["slow-ms"], "slow-ms");
  if (values["stream-only"]) options.streamOnly = true;
  if (values["no-reasoning-replay"]) options.reasoningReplay = false;
  return {
    help: false,
    ...(values["ready-file"] !== undefined
      ? { readyFile: path.resolve(values["ready-file"]) }
      : {}),
    options,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const command = await parseCommandLine(process.argv.slice(2), process.env);
    if (command.help) console.log(USAGE);
    else {
      const provider = await startFakeProvider(command.options);
      const ready = {
        event: "fake-provider.ready",
        url: provider.url,
        port: provider.port,
        models: provider.models,
        mode: provider.mode,
      };
      if (command.readyFile) {
        // Written whole, then renamed, so a reader polling for the file never sees part of it.
        const partial = `${command.readyFile}.${process.pid}.partial`;
        await writeFile(partial, `${JSON.stringify(ready)}\n`);
        await rename(partial, command.readyFile);
      }
      console.log(JSON.stringify(ready));
      const stop = () => {
        provider.close().then(
          () => process.exit(0),
          (error) => {
            console.error(
              error instanceof Error ? error.message : String(error),
            );
            process.exit(1);
          },
        );
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 2;
  }
}
