// SPDX-License-Identifier: MIT
/**
 * Native passthrough of the shared gateway (03 section 3): the request body
 * changes only in its top-level `model` (rewritten in place, byte for byte
 * elsewhere) and in declared patches; the response is forwarded per complete
 * SSE event or Gemini array element while a side observer extracts content,
 * usage, the served model, the terminal event and in-stream errors.
 */
import type { IncomingHttpHeaders } from "node:http";
import type {
  ProviderConfig,
  ProviderPatchSet,
  WireProtocol,
} from "@harnesshub/core/model-plane";
import { usageParts, type UsageParts } from "./ledger.js";
import { GatewayError, record } from "./protocol.js";
import { streamError } from "./upstream.js";

// ---------------------------------------------------------------- request

/** Index just past the JSON value starting at `start` (the text is valid JSON). */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let index = start;
  for (; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      index = stringEnd(text, index) - 1;
      if (depth === 0) return index + 1;
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return index + 1;
    } else if (depth === 0 && /[\s,}\]]/.test(char)) return index;
  }
  return index;
}
/** Index just past the string literal starting at `start`. */
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === '"') return index + 1;
  }
  return text.length;
}
function skipSpace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index]!)) index++;
  return index;
}

/**
 * Replace every top-level `"model"` string value of a JSON object text with
 * `model`, leaving all other bytes as they were. Returns `undefined` when the
 * object has no top-level string `model`. The text must be valid JSON.
 */
export function rewriteModel(text: string, model: string): string | undefined {
  let index = skipSpace(text, 0);
  if (text[index] !== "{") return undefined;
  index++;
  const spans: [number, number][] = [];
  for (;;) {
    index = skipSpace(text, index);
    if (index >= text.length || text[index] === "}") break;
    if (text[index] === ",") {
      index++;
      continue;
    }
    const keyEnd = stringEnd(text, index);
    const key: unknown = JSON.parse(text.slice(index, keyEnd));
    index = skipSpace(text, keyEnd) + 1; // past ':'
    const start = skipSpace(text, index);
    const end = valueEnd(text, start);
    if (key === "model" && text[start] === '"') spans.push([start, end]);
    index = end;
  }
  if (!spans.length) return undefined;
  let result = text;
  for (const [start, end] of spans.reverse())
    result = result.slice(0, start) + JSON.stringify(model) + result.slice(end);
  return result;
}

const BODY_PATCHES: Readonly<Record<WireProtocol, readonly string[]>> = {
  chat: [
    "developer-to-system",
    "max-tokens-field",
    "drop-fields",
    "include-usage",
    "json-schema-to-json-object",
    "merge-system-messages",
  ],
  responses: ["drop-fields", "merge-system-messages"],
  anthropic: [
    "drop-fields",
    "anthropic-beta-allow",
    "anthropic-strip-beta-fields",
    "merge-system-messages",
  ],
  gemini: ["drop-fields"],
};

/**
 * The Anthropic Messages request fields of the generally available API;
 * `anthropic-strip-beta-fields` removes every other top-level field.
 */
export const ANTHROPIC_STANDARD_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "max_tokens",
  "system",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "top_k",
  "top_p",
  "tools",
  "tool_choice",
  "thinking",
]);

/** The text of a message's content: a string, or its text parts and blocks joined. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const value = record(part);
      return typeof value?.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Chat: every system and developer message as one system message first.
 * True when the messages changed.
 */
function mergeChatSystem(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false;
  const system: string[] = [];
  const rest: unknown[] = [];
  let count = 0;
  for (const message of body.messages) {
    const value = record(message);
    if (value?.role === "system" || value?.role === "developer") {
      count++;
      const text = contentText(value.content);
      if (text) system.push(text);
    } else rest.push(message);
  }
  const first = record(body.messages[0]);
  if (count === 0 || (count === 1 && first?.role === "system")) return false;
  body.messages = [{ role: "system", content: system.join("\n\n") }, ...rest];
  return true;
}

/** Responses: system and developer input messages appended to `instructions`. */
function mergeResponsesSystem(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.input)) return false;
  const system: string[] = [];
  const rest = body.input.filter((item) => {
    const value = record(item);
    if (
      (value?.type === undefined || value.type === "message") &&
      (value?.role === "system" || value?.role === "developer")
    ) {
      const text = contentText(value.content);
      if (text) system.push(text);
      return false;
    }
    return true;
  });
  if (rest.length === body.input.length) return false;
  const instructions =
    typeof body.instructions === "string" && body.instructions
      ? [body.instructions]
      : [];
  body.input = rest;
  body.instructions = [...instructions, ...system].join("\n\n");
  return true;
}

/** Anthropic: `system` messages inside `messages` appended to the top-level `system`. */
function mergeAnthropicSystem(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false;
  const system: string[] = [];
  const rest = body.messages.filter((message) => {
    const value = record(message);
    if (value?.role !== "system") return true;
    const text = contentText(value.content);
    if (text) system.push(text);
    return false;
  });
  if (rest.length === body.messages.length) return false;
  body.messages = rest;
  if (!system.length) return true;
  if (Array.isArray(body.system))
    body.system = [
      ...body.system,
      ...system.map((text) => ({ type: "text", text })),
    ];
  else
    body.system = [
      ...(typeof body.system === "string" && body.system ? [body.system] : []),
      ...system,
    ].join("\n\n");
  return true;
}

/** A provider declares a patch this build does not implement for the endpoint. */
export function unsupportedPatches(
  protocol: WireProtocol,
  set: ProviderPatchSet | undefined,
): string[] {
  return (set?.patches ?? []).filter(
    (patch) => !BODY_PATCHES[protocol].includes(patch),
  );
}

/**
 * The upstream body of a passthrough request and the patches that changed
 * it. Without an applicable body patch only `model` is rewritten in place
 * (Gemini names the model in the path and keeps its body unchanged); with
 * one, the parsed body is patched and serialized again.
 */
export function passthroughBody(
  protocol: WireProtocol,
  bytes: Buffer,
  parsed: Record<string, unknown>,
  wireModel: string,
  set: ProviderPatchSet | undefined,
): { body: Buffer; patches: string[] } {
  const patched: Record<string, unknown> = { ...parsed };
  const applied: string[] = [];
  const patches = new Set(set?.patches ?? []);
  if (patches.has("drop-fields"))
    for (const field of set?.dropFields ?? [])
      if (field in patched) {
        delete patched[field];
        applied.push(`drop-fields:${field}`);
      }
  if (protocol === "chat") {
    if (patches.has("developer-to-system") && Array.isArray(patched.messages)) {
      let changed = false;
      patched.messages = patched.messages.map((message: unknown) => {
        const value = record(message);
        if (value?.role !== "developer") return message;
        changed = true;
        return { ...value, role: "system" };
      });
      if (changed) applied.push("developer-to-system");
    }
    if (patches.has("max-tokens-field")) {
      // Either way: the provider takes one of the two fields.
      const target = set?.maxTokensField ?? "max_completion_tokens";
      const other =
        target === "max_tokens" ? "max_completion_tokens" : "max_tokens";
      if (patched[other] !== undefined && patched[target] === undefined) {
        patched[target] = patched[other];
        delete patched[other];
        applied.push("max-tokens-field");
      }
    }
    if (patches.has("merge-system-messages") && mergeChatSystem(patched))
      applied.push("merge-system-messages");
    if (
      patches.has("include-usage") &&
      patched.stream === true &&
      record(patched.stream_options)?.include_usage !== true
    ) {
      patched.stream_options = {
        ...record(patched.stream_options),
        include_usage: true,
      };
      applied.push("include-usage");
    }
    if (
      patches.has("json-schema-to-json-object") &&
      record(patched.response_format)?.type === "json_schema"
    ) {
      patched.response_format = { type: "json_object" };
      applied.push("json-schema-to-json-object");
    }
  }
  if (
    protocol === "responses" &&
    patches.has("merge-system-messages") &&
    mergeResponsesSystem(patched)
  )
    applied.push("merge-system-messages");
  if (protocol === "anthropic") {
    if (patches.has("anthropic-strip-beta-fields")) {
      // Strict Anthropic-compatible upstreams take the GA request only.
      for (const field of Object.keys(patched))
        if (!ANTHROPIC_STANDARD_FIELDS.has(field)) {
          delete patched[field];
          applied.push(`anthropic-strip-beta-fields:${field}`);
        }
    }
    if (
      (patches.has("anthropic-strip-beta-fields") ||
        patches.has("merge-system-messages")) &&
      mergeAnthropicSystem(patched)
    )
      applied.push("merge-system-messages");
  }
  if (applied.length) {
    if (protocol !== "gemini") patched.model = wireModel;
    return { body: Buffer.from(JSON.stringify(patched)), patches: applied };
  }
  if (protocol === "gemini") return { body: bytes, patches: applied };
  const text = rewriteModel(bytes.toString("utf8"), wireModel);
  // A Session's request may leave the model to its Run's target.
  if (text === undefined)
    return {
      body: Buffer.from(JSON.stringify({ ...parsed, model: wireModel })),
      patches: applied,
    };
  return { body: Buffer.from(text), patches: applied };
}

/** Gemini route parts that the upstream URL repeats. */
export interface GeminiTarget {
  version: string;
  method: "generateContent" | "streamGenerateContent";
  sse: boolean;
}

function joinPath(base: string, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname}/${path}`.replace(/\/{2,}/g, "/");
  return url;
}
/**
 * Upstream URL of an endpoint base: the base URL its vendor SDK takes.
 * Chat and Responses bases include their version (`…/v1`), the Anthropic
 * base does not (`/v1/messages` is appended) and the Gemini base has no
 * version either (the client's `v1beta`, `v1` or `v1alpha` is appended).
 */
export function upstreamUrl(
  protocol: WireProtocol,
  base: string,
  wireModel: string,
  gemini: GeminiTarget | undefined,
): URL {
  switch (protocol) {
    case "chat":
      return joinPath(base, "chat/completions");
    case "responses":
      return joinPath(base, "responses");
    case "anthropic":
      return joinPath(base, "v1/messages");
    case "gemini": {
      if (!gemini) throw new Error("A Gemini upstream needs the Gemini route");
      const url = joinPath(
        base,
        `${gemini.version}/models/${wireModel}:${gemini.method}`,
      );
      if (gemini.sse) url.searchParams.set("alt", "sse");
      return url;
    }
  }
}

/** Anthropic's token counting operation under an anthropic endpoint base. */
export function countTokensUrl(base: string): URL {
  return joinPath(base, "v1/messages/count_tokens");
}

/** Client headers forwarded on passthrough; authentication is never among them. */
const FORWARDED = ["anthropic-version", "openai-beta", "user-agent"] as const;

/**
 * Upstream request headers: JSON content, the forwarded client headers
 * (`anthropic-beta` only as allowed by `anthropic-beta-allow`), the
 * provider's own headers, then its credential. `query-key` credentials go to
 * the URL instead. Returns the applied header patches.
 */
export function upstreamHeaders(
  protocol: WireProtocol,
  inbound: IncomingHttpHeaders | undefined,
  provider: ProviderConfig,
  secret: string,
  url: URL,
  set: ProviderPatchSet | undefined,
): { headers: Headers; patches: string[] } {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  const patches: string[] = [];
  if (inbound) {
    for (const name of FORWARDED) {
      const value = inbound[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const beta = inbound["anthropic-beta"];
    if (protocol === "anthropic" && typeof beta === "string") {
      const allow = set?.patches.includes("anthropic-beta-allow")
        ? new Set(set.anthropicBetaAllow ?? [])
        : undefined;
      const values = beta
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const kept = allow ? values.filter((value) => allow.has(value)) : values;
      if (allow && kept.length !== values.length)
        patches.push("anthropic-beta-allow");
      if (kept.length) headers.set("anthropic-beta", kept.join(","));
    }
  }
  if (protocol === "anthropic" && !headers.has("anthropic-version"))
    headers.set("anthropic-version", "2023-06-01");
  for (const [name, value] of Object.entries(provider.headers ?? {}))
    headers.set(name, value);
  const scheme = provider.auth.apiKeyHeader;
  // A keyless provider (no credential) gets no authentication.
  if (!secret) return { headers, patches };
  switch (scheme) {
    case "authorization-bearer":
      headers.set("authorization", `Bearer ${secret}`);
      break;
    case "x-api-key":
    case "api-key":
    case "x-goog-api-key":
      headers.set(scheme, secret);
      break;
    case "query-key":
      url.searchParams.set("key", secret);
      break;
    default:
      headers.set(scheme.slice("custom:".length), secret);
  }
  return { headers, patches };
}

// --------------------------------------------------------------- response

/** What one upstream event or body says, for routing and the ledger. */
export interface Observation {
  /** A valid protocol data event (JSON or `[DONE]`). */
  valid: boolean;
  /** Text, reasoning or a tool call. */
  content: boolean;
  /** The protocol's terminal event, or a Gemini chunk with a finish reason. */
  terminal: boolean;
  error?: GatewayError;
  model?: string;
  usage?: UsageParts;
  /**
   * The finish reason as the translated path records it: `stop`, `length`,
   * `tool_calls`, `content_filter`, or the upstream's own value. An answer
   * whose events showed a tool call ends in `tool_calls` (`settleFinish`).
   */
  finish?: string;
  /**
   * A tool call for the client to run: Chat `tool_calls`, a Responses call
   * item, an Anthropic `tool_use` block or a Gemini `functionCall` part.
   */
  toolCall?: boolean;
  /** Responses `sequence_number`. */
  sequence?: number;
}

/** Anthropic `stop_reason` as a Chat finish reason; unknown values pass through. */
export function anthropicFinish(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return reason;
  }
}

/** Gemini `finishReason` as a Chat finish reason; other values in lower case. */
export function geminiFinishReason(reason: string): string {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    default:
      return reason.toLowerCase();
  }
}

/** Responses status and incomplete reason as a Chat finish reason. */
export function responsesFinish(status: string, reason?: string): string {
  if (status !== "incomplete") return "stop";
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return reason ?? "incomplete";
}

/**
 * The finish of a whole answer from its last finish reason and whether any
 * of its events held a tool call: `stop` becomes `tool_calls`, as the
 * translated path records an answer with calls (Responses ends one in
 * `completed`, Gemini in `STOP`, some Chat relays in `stop`).
 */
export function settleFinish(finish: string, toolCall: boolean): string;
export function settleFinish(
  finish: string | undefined,
  toolCall: boolean,
): string | undefined;
export function settleFinish(
  finish: string | undefined,
  toolCall: boolean,
): string | undefined {
  return toolCall && (finish === "stop" || finish === undefined)
    ? "tool_calls"
    : finish;
}

/** Responses output items the client runs: tool calls. */
const RESPONSES_CALLS = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "local_shell_call",
  "shell_call",
  "apply_patch_call",
  "computer_call",
]);

const ANTHROPIC_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};
const RESPONSES_STATUS: Readonly<Record<string, number>> = {
  rate_limit_exceeded: 429,
  insufficient_quota: 429,
  server_error: 500,
  context_length_exceeded: 400,
  invalid_prompt: 400,
  // ChatGPT plan usage through Sign in with ChatGPT ("Errors and recovery").
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503,
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  subscription_sharing_unsupported_capability: 400,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
};

function failureMessage(error: Record<string, unknown> | undefined): string {
  return typeof error?.message === "string" && error.message
    ? error.message
    : "Upstream model reported an error";
}
function nonEmpty(value: unknown): boolean {
  return (
    (typeof value === "string" && value !== "") ||
    (Array.isArray(value) && value.length > 0)
  );
}

function chatObservation(value: Record<string, unknown>): Observation {
  if (value.error !== undefined && value.error !== null)
    return {
      valid: true,
      content: false,
      terminal: true,
      error: streamError(value.error),
    };
  const observation: Observation = {
    valid: true,
    content: false,
    terminal: false,
  };
  if (typeof value.model === "string" && value.model)
    observation.model = value.model;
  if (record(value.usage)) observation.usage = usageParts("chat", value.usage);
  for (const raw of Array.isArray(value.choices) ? value.choices : []) {
    const choice = record(raw);
    if (!choice || (typeof choice.index === "number" && choice.index !== 0))
      continue;
    const delta = record(choice.delta) ?? record(choice.message) ?? {};
    if (
      [
        delta.content,
        delta.refusal,
        delta.reasoning_content,
        delta.reasoning,
        delta.tool_calls,
      ].some(nonEmpty)
    )
      observation.content = true;
    if (nonEmpty(delta.tool_calls)) observation.toolCall = true;
    if (typeof choice.finish_reason === "string" && choice.finish_reason)
      observation.finish = choice.finish_reason;
  }
  return observation;
}

function responsesObservation(
  value: Record<string, unknown>,
  event: string | undefined,
): Observation {
  const type = typeof value.type === "string" ? value.type : (event ?? "");
  const observation: Observation = {
    valid: true,
    content: false,
    terminal: false,
  };
  if (typeof value.sequence_number === "number")
    observation.sequence = value.sequence_number;
  const response = record(value.response) ?? (type ? undefined : value);
  if (typeof response?.model === "string" && response.model)
    observation.model = response.model;
  if (type.endsWith(".delta")) observation.content = true;
  if (
    type === "response.output_item.added" ||
    type === "response.output_item.done"
  ) {
    const item = record(value.item);
    if (
      type === "response.output_item.added" &&
      item?.type !== "message" &&
      item?.type !== "reasoning"
    )
      observation.content = true;
    if (RESPONSES_CALLS.has(String(item?.type))) observation.toolCall = true;
  }
  const failed =
    type === "error"
      ? value
      : type === "response.failed" || response?.status === "failed"
        ? (record(response?.error) ?? {})
        : undefined;
  if (failed) {
    const code = typeof failed.code === "string" ? failed.code : "";
    observation.terminal = true;
    observation.error = new GatewayError(
      failureMessage(failed),
      RESPONSES_STATUS[code] ?? 500,
      code || "upstream_error",
      code === "context_length_exceeded",
    );
    return observation;
  }
  if (
    type === "response.completed" ||
    type === "response.incomplete" ||
    (!type && typeof response?.status === "string")
  ) {
    observation.terminal = true;
    if (record(response?.usage))
      observation.usage = usageParts("responses", response?.usage);
    const reason = record(response?.incomplete_details)?.reason;
    const output = Array.isArray(response?.output) ? response.output : [];
    if (output.some((item) => RESPONSES_CALLS.has(String(record(item)?.type))))
      observation.toolCall = true;
    observation.finish = settleFinish(
      responsesFinish(
        String(response?.status ?? ""),
        typeof reason === "string" ? reason : undefined,
      ),
      observation.toolCall === true,
    );
    if (!type && output.length) observation.content = true;
  }
  return observation;
}

function anthropicObservation(value: Record<string, unknown>): Observation {
  const observation: Observation = {
    valid: true,
    content: false,
    terminal: false,
  };
  switch (value.type) {
    case "error": {
      const error = record(value.error);
      const type = typeof error?.type === "string" ? error.type : "";
      observation.terminal = true;
      observation.error = new GatewayError(
        failureMessage(error),
        ANTHROPIC_STATUS[type] ?? 502,
        type || "upstream_error",
        /prompt is too long/i.test(failureMessage(error)),
      );
      return observation;
    }
    case "message_start": {
      const message = record(value.message);
      if (typeof message?.model === "string") observation.model = message.model;
      if (record(message?.usage))
        observation.usage = usageParts("anthropic", message?.usage);
      return observation;
    }
    case "content_block_start": {
      const block = record(value.content_block);
      observation.content =
        block?.type === "tool_use" ||
        block?.type === "server_tool_use" ||
        nonEmpty(block?.text);
      if (block?.type === "tool_use") observation.toolCall = true;
      return observation;
    }
    case "content_block_delta": {
      const delta = record(value.delta);
      observation.content =
        delta?.type === "text_delta" ||
        delta?.type === "thinking_delta" ||
        delta?.type === "input_json_delta";
      return observation;
    }
    case "message_delta": {
      if (record(value.usage))
        observation.usage = usageParts("anthropic", value.usage);
      const reason = record(value.delta)?.stop_reason;
      if (typeof reason === "string")
        observation.finish = anthropicFinish(reason);
      return observation;
    }
    case "message_stop":
      observation.terminal = true;
      return observation;
    case "message": {
      // A complete non-streamed message.
      if (typeof value.model === "string") observation.model = value.model;
      if (record(value.usage))
        observation.usage = usageParts("anthropic", value.usage);
      if (
        Array.isArray(value.content) &&
        value.content.some((block) => record(block)?.type === "tool_use")
      )
        observation.toolCall = true;
      if (typeof value.stop_reason === "string")
        observation.finish = settleFinish(
          anthropicFinish(value.stop_reason),
          observation.toolCall === true,
        );
      observation.content = nonEmpty(value.content);
      observation.terminal = true;
      return observation;
    }
    default:
      return observation;
  }
}

function geminiObservation(value: Record<string, unknown>): Observation {
  if (value.error !== undefined && value.error !== null)
    return {
      valid: true,
      content: false,
      terminal: true,
      error: streamError(value.error),
    };
  const observation: Observation = {
    valid: true,
    content: false,
    terminal: false,
  };
  if (typeof value.modelVersion === "string")
    observation.model = value.modelVersion;
  if (record(value.usageMetadata))
    observation.usage = usageParts("gemini", value.usageMetadata);
  const candidate = record(
    Array.isArray(value.candidates) ? value.candidates[0] : undefined,
  );
  const parts = record(candidate?.content)?.parts;
  if (
    Array.isArray(parts) &&
    parts.some((raw) => {
      const part = record(raw);
      return (
        nonEmpty(part?.text) ||
        part?.functionCall !== undefined ||
        part?.inlineData !== undefined
      );
    })
  )
    observation.content = true;
  if (
    Array.isArray(parts) &&
    parts.some((raw) => record(raw)?.functionCall !== undefined)
  )
    observation.toolCall = true;
  const finish =
    candidate?.finishReason ?? record(value.promptFeedback)?.blockReason;
  if (typeof finish === "string" && finish) {
    observation.finish = settleFinish(
      geminiFinishReason(finish),
      observation.toolCall === true,
    );
    observation.terminal = true;
  }
  return observation;
}

/** Observe one parsed JSON value (an SSE data payload, an array element or a whole body). */
export function observeJson(
  protocol: WireProtocol,
  value: unknown,
  event?: string,
): Observation {
  const object = record(value);
  if (!object) return { valid: false, content: false, terminal: false };
  switch (protocol) {
    case "chat":
      return chatObservation(object);
    case "responses":
      return responsesObservation(object, event);
    case "anthropic":
      return anthropicObservation(object);
    case "gemini":
      return geminiObservation(object);
  }
}

/** Observe one complete SSE event text. Comments and malformed data are not valid events. */
export function observeEvent(
  protocol: WireProtocol,
  text: string,
): Observation {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  const payload = data.join("\n").trim();
  if (!payload) return { valid: false, content: false, terminal: false };
  if (payload === "[DONE]")
    return { valid: true, content: false, terminal: protocol === "chat" };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { valid: false, content: false, terminal: false };
  }
  return observeJson(protocol, value, event);
}

/** A complete SSE event, or a Gemini array element with its preceding separator, as raw bytes. */
export interface Segment {
  bytes: Buffer;
  /** Text to observe; empty for the array's closing bracket. */
  text: string;
  /** The closing `]` of a Gemini array (with any whitespace before it). */
  closing: boolean;
}

const LF = 10;
const CR = 13;

/**
 * Splits an SSE byte stream at blank lines (LF, CRLF or CR line ends) without
 * changing any byte. Rejects with 502 `upstream_invalid_response` when one
 * event exceeds `maxEventBytes`.
 */
export class SseSegmenter {
  #buffer = Buffer.alloc(0);
  #scan = 0;
  #lineStart = 0;
  constructor(private readonly maxEventBytes: number) {}

  push(chunk: Uint8Array): Segment[] {
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, chunk])
      : Buffer.from(chunk);
    const segments: Segment[] = [];
    let eventStart = 0;
    let index = this.#scan;
    while (index < this.#buffer.length) {
      const byte = this.#buffer[index]!;
      if (byte !== LF && byte !== CR) {
        index++;
        continue;
      }
      let end = index + 1;
      if (byte === CR) {
        if (index + 1 >= this.#buffer.length) break; // CR or CRLF: wait for the next byte
        if (this.#buffer[index + 1] === LF) end++;
      }
      const empty = index === this.#lineStart;
      this.#lineStart = end;
      index = end;
      if (empty) {
        const bytes = this.#buffer.subarray(eventStart, end);
        segments.push({ bytes, text: bytes.toString("utf8"), closing: false });
        eventStart = end;
      }
    }
    this.#buffer = this.#buffer.subarray(eventStart);
    this.#scan = index - eventStart;
    this.#lineStart -= eventStart;
    if (this.#buffer.length > this.maxEventBytes)
      throw new GatewayError(
        "Upstream sent an event larger than the gateway limit",
        502,
        "upstream_invalid_response",
      );
    return segments;
  }

  /** The unterminated rest at the end of the body, if any. */
  end(): Segment[] {
    const bytes = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return bytes.length
      ? [{ bytes, text: bytes.toString("utf8"), closing: false }]
      : [];
  }
}

/**
 * Splits a streamed Gemini JSON array (`[{…},\r\n{…}]`) into elements, each
 * with the bytes before it, and the closing bracket. Bytes are unchanged.
 */
export class ArraySegmenter {
  #buffer = Buffer.alloc(0);
  #scan = 0;
  #depth = 0;
  #string = false;
  #escape = false;
  #opened = false;
  #closed = false;
  constructor(private readonly maxEventBytes: number) {}

  push(chunk: Uint8Array): Segment[] {
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, chunk])
      : Buffer.from(chunk);
    const segments: Segment[] = [];
    let start = 0;
    for (let index = this.#scan; index < this.#buffer.length; index++) {
      if (this.#closed) break;
      const byte = this.#buffer[index]!;
      if (this.#string) {
        if (this.#escape) this.#escape = false;
        else if (byte === 0x5c) this.#escape = true;
        else if (byte === 0x22) this.#string = false;
        continue;
      }
      if (byte === 0x22) {
        this.#string = true;
        continue;
      }
      if (!this.#opened) {
        if (byte === 0x5b) this.#opened = true;
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        this.#depth++;
      } else if (byte === 0x7d || byte === 0x5d) {
        if (this.#depth === 0 && byte === 0x5d) {
          this.#closed = true;
          const bytes = this.#buffer.subarray(start);
          segments.push({ bytes, text: "", closing: true });
          start = this.#buffer.length;
          break;
        }
        this.#depth--;
        if (this.#depth === 0) {
          const bytes = this.#buffer.subarray(start, index + 1);
          // The segment starts with the separator (and the opening bracket).
          const text = bytes.toString("utf8").replace(/^[\s,[]+/, "");
          segments.push({ bytes, text, closing: false });
          start = index + 1;
        }
      }
    }
    this.#buffer = this.#buffer.subarray(start);
    this.#scan = this.#buffer.length;
    if (this.#buffer.length > this.maxEventBytes)
      throw new GatewayError(
        "Upstream sent an element larger than the gateway limit",
        502,
        "upstream_invalid_response",
      );
    return segments;
  }

  /** Bytes after the closing bracket, or an unterminated rest. */
  end(): Segment[] {
    const bytes = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return bytes.length ? [{ bytes, text: "", closing: true }] : [];
  }
}
