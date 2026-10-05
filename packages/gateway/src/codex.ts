// SPDX-License-Identifier: MIT
/**
 * The Codex passthrough (the relay part of Magpie's `gw/codex_backend.go`).
 * Codex, signed in with ChatGPT and wired with `openai_base_url =
 * <gateway>/backend-api/codex`, sends its own requests here and they go on to
 * ChatGPT's Codex backend as they are: the client's `Authorization` and
 * `ChatGPT-Account-Id` pass through unchanged, no Gateway Key is involved and
 * no client identity is altered. The Authorization value is never logged,
 * stored or echoed. Each Responses call is recorded in the ledger under the
 * virtual provider `chatgpt-subscription`, committed before the client gets
 * its terminal event. Only what the gateway itself sealed is changed on the
 * way (./compacting.js): its compactions go as their summary, its encoded
 * reasoning not at all, and a HarnessHub model's `/responses/compact` is
 * refused with 400 `compact_unsupported` instead of being relayed.
 */
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import {
  parseModelRef,
  type ModelCallEntry,
  type ModelRef,
  type ProviderId,
} from "@harnesshub/core/model-plane";
import { proxyFailure } from "@harnesshub/core/outbound";
import { redactKeyText } from "@harnesshub/core/key-text";
import type { CallServices } from "./call.js";
import { maskBody } from "./redaction.js";
import { ToolArgumentRestorer } from "./restore.js";
import {
  failure,
  networkFailure,
  parseJsonBody,
  readBody,
  readLimited,
} from "./http.js";
import { callUsage, type UsageParts } from "./ledger.js";
import { openAiErrorResponse } from "./chat.js";
import { BODY_LIMIT } from "./bodies.js";
import { ClientClosed, HttpWriter, sse, type Failure } from "./output.js";
import {
  observeEvent,
  observeJson,
  SseSegmenter,
  type Observation,
} from "./passthrough.js";
import { GatewayError, record } from "./protocol.js";
import { failureClass, failureKind } from "./routing.js";
import { conversationOf } from "./sticky.js";
import {
  codexInput,
  COMPACT_UNSUPPORTED,
  withoutOwnReasoning,
} from "./compacting.js";
import { isContextOverflow, sanitize, upstreamError } from "./upstream.js";
import { pathKey } from "./key-path.js";

/** The gateway path Codex's `openai_base_url` points at. */
export const CODEX_PATH = "/backend-api/codex";
/** Where the passthrough forwards to, unless a test points it elsewhere. */
export const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
/** The virtual provider of the ledger entries; no such provider is configured. */
export const CODEX_PROVIDER = "chatgpt-subscription" as ProviderId;

/** Whether a normalized path belongs to the Codex passthrough. */
export function isCodexPath(path: string): boolean {
  return path === CODEX_PATH || path.startsWith(`${CODEX_PATH}/`);
}

/**
 * A Codex passthrough path without the Gateway Key that ChatGPT-mode wiring
 * puts in `openai_base_url` (`/backend-api/codex/<key>/responses`): Codex's
 * own provider takes no other header, and its ChatGPT sign-in stays as it
 * is. The key is only for HarnessHub's models and goes nowhere else: not to
 * ChatGPT, the ledger or the log. A first segment that is no Gateway Key is
 * part of the path.
 */
export function codexRoute(path: string): { path: string; key?: string } {
  const { rest, key } = pathKey(path, CODEX_PATH);
  return key === undefined ? { path } : { path: CODEX_PATH + rest, key };
}

/** One of the gateway's models as Codex's model list describes it. */
export interface CodexListedModel {
  slug: string;
  contextWindow?: number;
  /** Reasoning levels, lowest first; empty when the model has none or they are unknown. */
  efforts: readonly string[];
  images: boolean;
}

/** What a ChatGPT-mode Codex lists besides ChatGPT's own models. */
export interface CodexListing {
  /** The gateway's models for the key, in Codex's model-list format, priorities from `first`. */
  entries(first: number): unknown[];
  /** Changes with the listed models: Codex asks for the list again when it does. */
  tag: string;
}

/**
 * An ETag of ChatGPT's (or none) with the gateway's list tag in it, as Magpie
 * marks it: `W/"abc"` becomes `W/"abc+hh-<tag>"`.
 */
export function taggedEtag(etag: string, tag: string): string {
  return etag.length > 1 && etag.endsWith('"')
    ? `${etag.slice(0, -1)}+hh-${tag}"`
    : `${etag}+hh-${tag}`;
}

/**
 * Request headers that are not forwarded: hop by hop, recomputed for the
 * forwarded body (it is sent decompressed), or HarnessHub's own `x-hh-*`
 * headers, such as `X-HH-Credential`.
 */
const DROPPED_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "content-encoding",
  "accept-encoding",
]);
/** Response headers that are not passed back: hop by hop, or describing the encoded body. */
const DROPPED_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "trailer",
  "upgrade",
  "content-length",
  "content-encoding",
  "set-cookie",
]);

function forwardedHeaders(inbound: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(inbound)) {
    if (
      value === undefined ||
      DROPPED_REQUEST.has(name) ||
      name.startsWith("x-hh-")
    )
      continue;
    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }
  return headers;
}

/** The client's own credentials, only to redact them from upstream error text. */
function clientSecrets(inbound: IncomingHttpHeaders): string[] {
  const authorization = inbound.authorization;
  if (typeof authorization !== "string") return [];
  return [authorization, authorization.replace(/^\S+\s+/, "")];
}

/** What one forwarded request needs from the handler. */
export interface CodexRequest {
  request: IncomingMessage;
  response: ServerResponse;
  /** The normalized path, starting with {@link CODEX_PATH}. */
  path: string;
  /** The query string with its `?`, or empty. */
  search: string;
  /** {@link CODEX_BACKEND}, or a test's loopback fake. */
  backend: string;
  services: CallServices;
  /** Aborted when the handler closes. */
  shutdown: AbortSignal;
  /** A fresh ledger entry of an inbound Responses call at `path`, without a key. */
  entry(stream: boolean): ModelCallEntry;
  /** The request body, read already with its memory reserved; it is given back here. */
  body?: Buffer;
  /** The gateway's list tag ({@link CodexListing}), added to the answer's `X-Models-Etag`. */
  modelsTag?: string;
}

/**
 * The ledger fields a forwarded Responses call gets from its body; a model
 * name with Gateway Key text in it is recorded without it.
 */
function attribute(
  entry: ModelCallEntry,
  forwarded: string,
  raw: Record<string, unknown>,
  headers: IncomingHttpHeaders,
): void {
  const model = redactKeyText(forwarded);
  entry.requestedModel = model.slice(0, 256);
  const ref = `${CODEX_PROVIDER}/${model}`;
  if (parseModelRef(ref)?.kind === "model") entry.modelRef = ref as ModelRef;
  entry.provider = CODEX_PROVIDER;
  entry.wireModel = model.slice(0, 512);
  entry.upstreamProtocol = "responses";
  entry.mode = "passthrough";
  entry.agent = { id: "codex", source: "route" };
  entry.conversationKey = conversationOf(
    "responses",
    raw,
    headers,
    CODEX_PROVIDER,
  ).key;
}

/**
 * Forward one request under {@link CODEX_PATH} to the same path under
 * `backend`, with the client's headers and the (decompressed) body, and
 * answer with the upstream's status, headers and body. A POST whose JSON body
 * names a `model` is a model call: its ledger entry (usage from the Responses
 * stream or JSON, scope unknown, agent `codex`) is committed before the
 * terminal event or the body is written; when the commit fails, the client
 * gets 503 `evidence_unavailable` instead (in the stream, if it started).
 * Never throws; a failed or cancelled request ends the response.
 */
export async function codexPassthrough(context: CodexRequest): Promise<void> {
  const { request, response, services } = context;
  const { limits } = services;
  const started = performance.now();
  const abort = new AbortController();
  const onClose = () => {
    if (!response.writableFinished) abort.abort();
  };
  response.once("close", onClose);
  const signal = AbortSignal.any([context.shutdown, abort.signal]);
  const writer = new HttpWriter(response);
  const bodies = services.bodies();
  if (bodies) writer.tap(BODY_LIMIT);
  const closed = new Promise<void>((resolve) =>
    response.once("close", () => resolve()),
  );
  const secrets = clientSecrets(request.headers);
  const method = request.method ?? "GET";
  let reserved = 0;
  let read: Buffer = Buffer.alloc(0);
  let entry: ModelCallEntry | undefined;
  const timers = new Set<NodeJS.Timeout>();
  let timedOut: "headers" | "idle" | undefined;
  const commit = async (): Promise<boolean> => {
    if (!entry) return true;
    entry.timing.durationMs = Math.round(performance.now() - started);
    if (writer.firstWrite !== undefined)
      entry.timing.firstByteMs = Math.round(writer.firstWrite - started);
    const committed = await services.commit(
      entry,
      bodies ? { bytes: read, writer, closed } : undefined,
    );
    entry = undefined;
    return committed;
  };
  const fail = async (
    value: Failure,
    errorClass: string,
    source: "gateway" | "upstream",
  ) => {
    if (entry) {
      entry.status = value.status;
      entry.errorClass = errorClass;
      entry.errorSource = source;
      entry.error = value.message;
    }
    await commit();
    if (writer.sent) {
      response.destroy();
      return;
    }
    response.setHeader("x-hh-error-source", source);
    const { status, body } = openAiErrorResponse(value);
    await writer.json(status, body);
  };
  reserved = context.body?.length ?? 0;
  try {
    let body: Buffer | undefined = context.body;
    if (!body && method !== "GET" && method !== "HEAD") {
      body = await readBody(request, {
        maxBytes: limits.maxRequestBytes,
        timeoutMs: limits.requestBodyTimeoutMs,
        signal,
        memory: services.memory,
      });
      reserved = body.length;
    }
    if (body) read = body;
    if (method === "POST" && body?.length) {
      let raw: Record<string, unknown> | undefined;
      try {
        raw = record(parseJsonBody(body));
      } catch {
        raw = undefined;
      }
      const model = raw?.model;
      if (raw && typeof model === "string" && model) {
        entry = context.entry(raw.stream === true);
        attribute(entry, model, raw, request.headers);
        // A HarnessHub model compacts with a compaction_trigger on
        // /v1/responses; ChatGPT has no such model (Magpie: a 400).
        if (
          context.path === `${CODEX_PATH}/responses/compact` &&
          model.includes("/")
        ) {
          await fail(
            failure(400, "compact_unsupported", COMPACT_UNSUPPORTED),
            "compact_unsupported",
            "gateway",
          );
          return;
        }
      }
      // What the gateway summarized or encoded is no seal ChatGPT reads:
      // its compactions go as their summary, its reasoning not at all.
      if (raw && context.path === `${CODEX_PATH}/responses`) {
        const codex = codexInput(raw, false);
        if (codex) {
          body = Buffer.from(JSON.stringify(codex.raw));
          entry?.patches.push(`compaction:restored:${codex.restored}`);
        }
        const own = withoutOwnReasoning(body);
        if (own) {
          body = own.body;
          entry?.patches.push(`reasoning:dropped:${own.dropped}`);
        }
      }
      // Known secrets stay here; tool arguments get them back.
      const masked = maskBody(
        services.redactor,
        services.features().redaction,
        body,
      );
      if (masked.count) {
        body = masked.body;
        entry?.patches.push(`redact:${masked.count}`);
        writer.addTransform(
          new ToolArgumentRestorer(
            services.redactor,
            "responses",
            raw?.stream === true ? "sse" : "json",
          ),
        );
      }
    }
    const url = new URL(
      `${context.backend.replace(/\/+$/, "")}${context.path.slice(CODEX_PATH.length)}${context.search}`,
    );
    const upstream = new AbortController();
    const linked = AbortSignal.any([signal, upstream.signal]);
    const arm = (kind: "headers" | "idle", ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        timedOut = kind;
        upstream.abort();
      }, ms);
      timers.add(timer);
      return timer;
    };
    const disarm = (timer: NodeJS.Timeout | undefined) => {
      if (!timer) return;
      clearTimeout(timer);
      timers.delete(timer);
    };
    const headerTimer = arm("headers", limits.upstreamHeaderTimeoutMs);
    let answer: Response;
    try {
      answer = await services.fetch(url, {
        method,
        redirect: "manual",
        signal: linked,
        headers: forwardedHeaders(request.headers),
        ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}),
      });
    } finally {
      disarm(headerTimer);
    }
    const contentType = answer.headers.get("content-type") ?? "";
    const pass = () => {
      for (const [name, value] of answer.headers)
        if (!DROPPED_RESPONSE.has(name))
          response.setHeader(
            name,
            name === "x-models-etag" && context.modelsTag
              ? taggedEtag(value, context.modelsTag)
              : value,
          );
      writer.begin(answer.status, contentType || "application/octet-stream");
    };
    if (entry && !answer.ok) {
      const text = await readLimited(answer, 64 * 1024);
      const reported = upstreamError(text, answer.status);
      const overflow =
        answer.status !== 429 &&
        isContextOverflow(reported.code, reported.message);
      entry.status = answer.status;
      entry.errorClass = failureClass(
        overflow ? "request" : failureKind(answer.status, text),
        answer.status,
        overflow,
      );
      entry.errorSource = "upstream";
      entry.error = sanitize(reported.message, secrets);
      if (!(await commit())) {
        await evidenceUnavailable(writer, response, undefined);
        return;
      }
      pass();
      await writer.end(text);
      return;
    }
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      disarm(idleTimer);
      idleTimer = arm("idle", limits.idleTimeoutMs);
    };
    const observed: UsageParts = {};
    let served: string | undefined;
    let finish: string | undefined;
    let terminal = false;
    let streamError: GatewayError | undefined;
    const observe = (observation: Observation) => {
      Object.assign(observed, observation.usage);
      if (observation.model) served ??= observation.model;
      if (observation.finish) finish = observation.finish;
      if (observation.content && entry)
        entry.timing.firstContentMs ??= Math.round(performance.now() - started);
      if (observation.error) streamError ??= observation.error;
      if (observation.terminal) terminal = true;
    };
    const streamed = entry !== undefined && /event-stream/i.test(contentType);
    const segmenter = streamed
      ? new SseSegmenter(limits.maxEventBytes)
      : undefined;
    /** Segments from the terminal event on, or the whole body of a non-streamed call. */
    const withheld: Buffer[] = [];
    let bytes = 0;
    try {
      touch();
      if (!entry || streamed) pass();
      if (answer.body)
        for await (const chunk of answer.body) {
          touch();
          bytes += chunk.byteLength;
          if (bytes > limits.maxResponseBytes)
            throw new GatewayError(
              "Upstream response exceeds the gateway size limit",
              502,
              "response_too_large",
            );
          if (!entry) {
            await writer.write(chunk);
            continue;
          }
          if (!segmenter) {
            withheld.push(Buffer.from(chunk));
            continue;
          }
          for (const segment of segmenter.push(chunk)) {
            const observation = observeEvent("responses", segment.text);
            const hold = terminal || observation.terminal || observation.error;
            observe(observation);
            if (hold) withheld.push(segment.bytes);
            else await writer.write(segment.bytes);
          }
        }
      for (const segment of segmenter?.end() ?? []) {
        observe(observeEvent("responses", segment.text));
        withheld.push(segment.bytes);
      }
    } finally {
      disarm(idleTimer);
    }
    if (!entry) {
      await writer.end();
      return;
    }
    const whole = segmenter ? undefined : Buffer.concat(withheld);
    if (whole) {
      try {
        observe(
          observeJson(
            "responses",
            JSON.parse(whole.toString("utf8")) as unknown,
          ),
        );
      } catch {
        // Not JSON: recorded without usage, passed on as it came.
      }
      terminal = answer.ok;
    }
    entry.status = streamError ? streamError.status : answer.status;
    if (streamError) {
      entry.errorClass = failureClass(
        streamError.contextOverflow
          ? "request"
          : failureKind(streamError.status, streamError.message),
        streamError.status,
        streamError.contextOverflow,
      );
      entry.errorSource = "upstream";
      entry.error = sanitize(streamError.message, secrets);
    }
    entry.usage = callUsage(observed);
    entry.cost = null;
    if (served) entry.servedModel = served.slice(0, 256);
    if (finish) entry.finishReason = finish.slice(0, 64);
    entry.completion = terminal ? "explicit" : "inferred";
    if (!(await commit())) {
      await evidenceUnavailable(writer, response, segmenter !== undefined);
      return;
    }
    if (whole) {
      pass();
      await writer.end(whole);
    } else await writer.end(Buffer.concat(withheld));
  } catch (error) {
    if (
      error instanceof ClientClosed ||
      abort.signal.aborted ||
      context.shutdown.aborted
    ) {
      if (entry) {
        entry.status = 499;
        entry.errorClass = context.shutdown.aborted
          ? "client_cancelled"
          : "engine_disconnected";
        entry.error = "Model call was cancelled";
        await commit();
      }
      if (!response.writableEnded) response.destroy();
      return;
    }
    let value: Failure;
    let source: "gateway" | "upstream" = "upstream";
    const network = networkFailure(error);
    const proxied = proxyFailure(error);
    if (proxied) {
      value = failure(502, "proxy_failed", proxied.brief);
      source = "gateway";
    } else if (timedOut)
      value = failure(
        504,
        "upstream_timeout",
        timedOut === "headers"
          ? `ChatGPT's Codex backend sent no response headers for ${Math.round(limits.upstreamHeaderTimeoutMs / 1000)} seconds`
          : `ChatGPT's Codex backend sent no data for ${Math.round(limits.idleTimeoutMs / 1000)} seconds`,
      );
    else if (error instanceof GatewayError) {
      value = failure(
        error.status,
        error.code,
        sanitize(error.message, secrets),
      );
      if (
        !error.code.startsWith("upstream_") &&
        error.code !== "response_too_large"
      )
        source = "gateway";
    } else if (network)
      value = { ...network, message: sanitize(network.message, secrets) };
    else {
      services.log.info("gateway.codex.internal_error", {
        error:
          error instanceof Error
            ? sanitize(error.message, secrets).slice(0, 200)
            : "unknown",
      });
      value = failure(500, "gateway_error", "Model gateway internal error");
      source = "gateway";
    }
    await fail(value, value.code, source).catch(() => response.destroy());
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    services.memory.give(reserved);
    response.removeListener("close", onClose);
  }
}

/**
 * Codex's model list in ChatGPT mode: ChatGPT's own list for this sign-in,
 * asked for as the passthrough forwards (the client's headers, never logged),
 * then the gateway's models for the request's key in Codex's format, after
 * ChatGPT's in priority. The answer's `ETag` carries the listing's tag, as
 * the `X-Models-Etag` of relayed answers does, so that a change to either
 * list has Codex ask again (Magpie's codexModels). A refusal of ChatGPT's or
 * a body that is no model list passes on as it came, and Codex keeps the
 * list it has; no ledger entry is written. Never throws.
 */
export async function codexModels(
  context: CodexRequest,
  listing: CodexListing,
): Promise<void> {
  const { request, response, services } = context;
  const { limits } = services;
  const abort = new AbortController();
  const onClose = () => {
    if (!response.writableFinished) abort.abort();
  };
  response.once("close", onClose);
  const signal = AbortSignal.any([context.shutdown, abort.signal]);
  const timer = setTimeout(
    () => abort.abort(),
    limits.upstreamHeaderTimeoutMs + limits.idleTimeoutMs,
  );
  const writer = new HttpWriter(response);
  const secrets = clientSecrets(request.headers);
  try {
    const answer = await services.fetch(
      `${context.backend.replace(/\/+$/, "")}/models${context.search}`,
      {
        method: "GET",
        redirect: "manual",
        signal,
        headers: forwardedHeaders(request.headers),
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (answer.body)
      for await (const chunk of answer.body) {
        bytes += chunk.byteLength;
        if (bytes > limits.maxResponseBytes)
          throw new GatewayError(
            "ChatGPT's model list exceeds the gateway size limit",
            502,
            "response_too_large",
          );
        chunks.push(Buffer.from(chunk));
      }
    const body = Buffer.concat(chunks);
    let list: Record<string, unknown> | undefined;
    try {
      list = answer.ok ? record(JSON.parse(body.toString("utf8"))) : undefined;
    } catch {
      list = undefined;
    }
    for (const [name, value] of answer.headers)
      if (!DROPPED_RESPONSE.has(name)) response.setHeader(name, value);
    if (!list || !Array.isArray(list.models)) {
      writer.begin(
        answer.status,
        answer.headers.get("content-type") ?? "application/octet-stream",
      );
      await writer.end(body);
      return;
    }
    response.setHeader(
      "etag",
      taggedEtag(answer.headers.get("etag") ?? "", listing.tag),
    );
    await writer.json(answer.status, {
      ...list,
      models: [...list.models, ...listing.entries(list.models.length + 1)],
    });
  } catch (error) {
    if (abort.signal.aborted || context.shutdown.aborted || writer.sent) {
      response.destroy();
      return;
    }
    const network = networkFailure(error);
    const proxied = proxyFailure(error);
    const value =
      error instanceof GatewayError
        ? failure(error.status, error.code, sanitize(error.message, secrets))
        : proxied
          ? failure(502, "proxy_failed", proxied.brief)
          : network
            ? { ...network, message: sanitize(network.message, secrets) }
            : failure(500, "gateway_error", "Model gateway internal error");
    response.setHeader("x-hh-error-source", proxied ? "gateway" : "upstream");
    const { status, body } = openAiErrorResponse(value);
    await writer.json(status, body).catch(() => response.destroy());
  } finally {
    clearTimeout(timer);
    response.removeListener("close", onClose);
  }
}

/** The entry could not be committed: the answer is withheld (03 section 8). */
async function evidenceUnavailable(
  writer: HttpWriter,
  response: ServerResponse,
  streamed: boolean | undefined,
): Promise<void> {
  const value = failure(
    503,
    "evidence_unavailable",
    "The model call could not be recorded; the answer is withheld",
  );
  try {
    if (!writer.sent) {
      response.setHeader("x-hh-error-source", "gateway");
      const { status, body } = openAiErrorResponse(value);
      await writer.json(status, body);
      return;
    }
    if (streamed)
      await writer.end(
        sse(
          {
            type: "response.failed",
            response: {
              object: "response",
              status: "failed",
              output: [],
              error: { code: value.code, message: value.message },
              incomplete_details: null,
            },
          },
          "response.failed",
        ),
      );
    else response.destroy();
  } catch {
    response.destroy();
  }
}
