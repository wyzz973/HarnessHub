// SPDX-License-Identifier: MIT
import { redactKeyText } from "@harnesshub/core/key-text";
import {
  GatewayError,
  array,
  joinText,
  object,
  omittedMedia,
  parseArguments,
  record,
  type ChatResult,
  type ReasoningField,
  type ToolCall,
  type Usage,
} from "./protocol.js";

/** Resolved upstream settings of one gateway; defaults were applied by the gateway. */
export interface UpstreamSettings {
  model: string;
  maxOutputTokens?: number;
  includeUsage: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  dropParameters: readonly string[];
  /** `placeholder` replaces Chat image parts with text; `passthrough` keeps `image_url`. */
  images: "placeholder" | "passthrough";
}

/** Parameters that many Chat-compatible gateways reject; always removed. */
export const DEFAULT_DROPPED_PARAMETERS = [
  "store",
  "metadata",
  "service_tier",
  "prediction",
  "modalities",
  "audio",
  "web_search_options",
  "user",
  // Engines handle several calls in one answer; strict gateways reject it.
  "parallel_tool_calls",
  // OpenAI reasoning control (Kimi sends it); some upstream reasoning models reject it and
  // reason by their own configuration.
  "reasoning_effort",
] as const;
const PROTECTED = new Set(["model", "messages", "stream"]);

/** `${baseUrl}/chat/completions` without duplicate slashes in the path. */
export function chatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname}/chat/completions`.replace(/\/{2,}/g, "/");
  return url;
}

function outputLimit(body: Record<string, unknown>): number | undefined {
  for (const key of ["max_completion_tokens", "max_tokens"]) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 1 ||
      value > Number.MAX_SAFE_INTEGER
    )
      throw new GatewayError(`Invalid ${key}`);
    return Math.floor(value);
  }
  return undefined;
}
function systemText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  const text = Array.isArray(content) ? joinText(content) : undefined;
  if (text === undefined)
    throw new GatewayError("System messages accept text content only");
  return text;
}
/** Keep text, keep or replace images by policy, and replace any other media with text. */
function mediaParts(
  parts: unknown[],
  images: UpstreamSettings["images"],
): unknown[] {
  return parts.map((raw) => {
    const part = record(raw);
    const type = typeof part?.type === "string" ? part.type : "";
    if (type === "text" || (type === "image_url" && images === "passthrough"))
      return raw;
    return {
      type: "text",
      text: omittedMedia(type === "image_url" ? "Image" : "Media content"),
    };
  });
}
function normalizeMessages(
  raw: unknown,
  images: UpstreamSettings["images"],
): Record<string, unknown>[] {
  const system: string[] = [];
  const messages: Record<string, unknown>[] = [];
  for (const value of array(raw)) {
    const message = { ...object(value) };
    if (typeof message.role !== "string")
      throw new GatewayError("Every message requires a role");
    if (message.role === "system" || message.role === "developer") {
      const text = systemText(message.content);
      if (text) system.push(text);
      continue;
    }
    if (Array.isArray(message.content)) {
      const parts = mediaParts(message.content, images);
      const text = joinText(parts);
      message.content = text ?? parts;
    }
    messages.push(message);
  }
  return system.length
    ? [{ role: "system", content: system.join("\n\n") }, ...messages]
    : messages;
}
/**
 * How much {@link normalizeChatRequest} changes beyond the upstream settings.
 * The Session gateway removes {@link DEFAULT_DROPPED_PARAMETERS} and turns
 * JSON Schema output into JSON mode; the shared gateway does neither unless a
 * provider patch asks for it (03 section 3).
 */
export interface NormalizationPolicy {
  dropDefaults: boolean;
  jsonSchema: "json-object" | "keep";
}
/**
 * Build the upstream Chat body: fixed model, `stream: true`, default and
 * configured parameter removal, tool-choice cleanup without tools, one leading
 * system message, text-only content as strings and a single output-limit field
 * clamped to `maxOutputTokens`. No limit is added when the engine set none.
 */
export function normalizeRequest(
  input: Record<string, unknown>,
  settings: UpstreamSettings,
): Record<string, unknown> {
  return normalizeChatRequest(input, settings, {
    dropDefaults: true,
    jsonSchema: "json-object",
  });
}
/** {@link normalizeRequest} with an explicit {@link NormalizationPolicy}. */
export function normalizeChatRequest(
  input: Record<string, unknown>,
  settings: UpstreamSettings,
  policy: NormalizationPolicy,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...input };
  if (policy.dropDefaults)
    for (const key of DEFAULT_DROPPED_PARAMETERS) delete body[key];
  delete body.stream_options;
  if (body.n === 1) delete body.n;
  const limit = outputLimit(body);
  delete body.max_tokens;
  delete body.max_completion_tokens;
  if (limit !== undefined)
    body[settings.maxTokensField] =
      settings.maxOutputTokens === undefined
        ? limit
        : Math.min(limit, settings.maxOutputTokens);
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    delete body.tools;
    delete body.tool_choice;
  }
  // JSON Schema output is widely unsupported; JSON mode keeps the answer
  // machine-readable while the engine still validates the structure.
  if (
    policy.jsonSchema === "json-object" &&
    record(body.response_format)?.type === "json_schema"
  )
    body.response_format = { type: "json_object" };
  body.messages = normalizeMessages(body.messages, settings.images);
  body.model = settings.model;
  body.stream = true;
  if (settings.includeUsage) body.stream_options = { include_usage: true };
  for (const key of settings.dropParameters)
    if (!PROTECTED.has(key)) delete body[key];
  return body;
}

/** Incremental completion events, awaited in upstream order. */
export interface CompletionHandlers {
  /** First valid upstream chunk; a stream answer may now send its headers. */
  start(): Promise<void>;
  reasoning(text: string, field: ReasoningField): Promise<void>;
  text(text: string): Promise<void>;
  toolStart(call: { index: number; id: string; name: string }): Promise<void>;
  toolArgs(index: number, text: string): Promise<void>;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
/** Lenient usage parsing: missing or malformed fields are simply absent. */
export function parseUsage(raw: unknown): Usage | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const completion =
    record(value.completion_tokens_details) ??
    record(value.output_tokens_details);
  const prompt =
    record(value.prompt_tokens_details) ?? record(value.input_tokens_details);
  const input = count(value.prompt_tokens) ?? count(value.input_tokens);
  const output = count(value.completion_tokens) ?? count(value.output_tokens);
  const total =
    count(value.total_tokens) ??
    (input !== undefined && output !== undefined ? input + output : undefined);
  const reasoning =
    count(completion?.reasoning_tokens) ?? count(value.reasoning_tokens);
  const cached =
    count(prompt?.cached_tokens) ?? count(value.prompt_cache_hit_tokens);
  const cacheWrite = count(value.cache_creation_input_tokens);
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === undefined ? {} : { total }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cached === undefined ? {} : { cached }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

interface PendingCall {
  index: number;
  id: string;
  name: string;
  args: string;
  started: boolean;
}
function completeJson(value: string): boolean {
  if (!value.trim()) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
/**
 * Accumulates streamed tool calls. Missing `index` values continue the
 * current call unless a new id or a new tool name starts another; repeated
 * complete names or ids are not concatenated; missing ids are generated.
 * A call is announced once it has a name and non-empty arguments.
 */
class ToolAccumulator {
  #calls = new Map<number, PendingCall>();
  #last: number | undefined;
  constructor(private readonly makeId: () => string) {}
  get size(): number {
    return this.#calls.size;
  }
  #next(): number {
    return this.#calls.size ? Math.max(...this.#calls.keys()) + 1 : 0;
  }
  #index(call: Record<string, unknown>, name: string): number {
    const index = call.index;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
      if (index > 1023)
        throw new GatewayError("Upstream tool index is too large", 502);
      return index;
    }
    if (typeof call.id === "string" && call.id) {
      for (const pending of this.#calls.values())
        if (pending.id === call.id) return pending.index;
      const last =
        this.#last === undefined ? undefined : this.#calls.get(this.#last);
      return last && !last.id && !last.started ? last.index : this.#next();
    }
    const last =
      this.#last === undefined ? undefined : this.#calls.get(this.#last);
    if (!last) return 0;
    if (
      name &&
      last.name &&
      ((!name.startsWith(last.name) && !last.name.startsWith(name)) ||
        completeJson(last.args))
    )
      return this.#next();
    return last.index;
  }
  async apply(values: unknown[], handlers: CompletionHandlers): Promise<void> {
    for (const value of values) {
      const call = record(value);
      if (!call) continue;
      const fn = record(call.function);
      const name = typeof fn?.name === "string" ? fn.name : "";
      const index = this.#index(call, name);
      let pending = this.#calls.get(index);
      if (!pending) {
        pending = { index, id: "", name: "", args: "", started: false };
        this.#calls.set(index, pending);
      }
      this.#last = index;
      if (typeof call.id === "string" && call.id) {
        if (!pending.id) pending.id = call.id;
        else if (
          !pending.started &&
          call.id !== pending.id &&
          call.id.startsWith(pending.id)
        )
          pending.id = call.id;
      }
      if (name && name !== pending.name && !pending.started) {
        if (!pending.name || name.startsWith(pending.name)) pending.name = name;
        else if (!pending.name.startsWith(name)) pending.name += name;
      }
      let added = "";
      if (typeof fn?.arguments === "string") added = fn.arguments;
      else if (record(fn?.arguments)) {
        pending.args = "";
        added = JSON.stringify(fn?.arguments);
      }
      pending.args += added;
      if (!pending.started && pending.name && pending.args.trim())
        await this.#start(pending, handlers);
      else if (pending.started && added)
        await handlers.toolArgs(pending.index, added);
    }
  }
  async #start(call: PendingCall, handlers: CompletionHandlers): Promise<void> {
    call.started = true;
    call.id ||= this.makeId();
    await handlers.toolStart({
      index: call.index,
      id: call.id,
      name: call.name,
    });
    if (call.args) await handlers.toolArgs(call.index, call.args);
  }
  async finish(handlers: CompletionHandlers): Promise<ToolCall[]> {
    const result: ToolCall[] = [];
    for (const call of [...this.#calls.values()].sort(
      (a, b) => a.index - b.index,
    )) {
      if (!call.name && !call.args.trim()) continue;
      if (!call.name)
        throw new GatewayError("Upstream tool call has no function name", 502);
      if (!call.args.trim()) call.args = "{}";
      if (!call.started) await this.#start(call, handlers);
      const input = parseArguments(call.args);
      result.push({
        id: call.id,
        name: call.name,
        arguments: call.args,
        ...(input ? { input } : {}),
      });
    }
    return result;
  }
}

/**
 * Normalize the finish reason: tool calls report `tool_calls` unless the
 * output was cut by the token limit before their arguments completed; a normal
 * end without a reason is `stop`; `length` and other reasons are kept.
 */
export function normalizeFinish(raw: string, calls: ToolCall[]): string {
  if (calls.length)
    return raw === "length" && calls.some((call) => !call.input)
      ? "length"
      : "tool_calls";
  return !raw || raw === "tool_calls" || raw === "function_call" ? "stop" : raw;
}

/** An upstream error object reported inside an otherwise successful response. */
export function streamError(value: unknown): GatewayError {
  const error = record(value);
  const status =
    typeof error?.code === "number" && error.code >= 400 && error.code < 600
      ? error.code
      : typeof error?.status === "number" &&
          error.status >= 400 &&
          error.status < 600
        ? error.status
        : 502;
  const message = errorMessage(value) || "Upstream model reported an error";
  const code =
    typeof error?.code === "string"
      ? error.code
      : typeof error?.type === "string"
        ? error.type
        : undefined;
  return new GatewayError(
    message,
    status,
    "upstream_error",
    isContextOverflow(code, message),
    JSON.stringify(value),
  );
}

class Completion {
  text = "";
  reasoning = "";
  finish = "";
  model: string | undefined;
  usage: Usage | undefined;
  rawUsage: Record<string, unknown> | undefined;
  field: ReasoningField | undefined;
  started = false;
  readonly tools: ToolAccumulator;
  constructor(
    makeId: () => string,
    private readonly handlers: CompletionHandlers,
  ) {
    this.tools = new ToolAccumulator(makeId);
  }
  async chunk(raw: unknown, streamed: boolean): Promise<void> {
    const chunk = record(raw);
    if (!chunk) throw new GatewayError("Upstream sent a non-object chunk", 502);
    if (chunk.error !== undefined && chunk.error !== null)
      throw streamError(chunk.error);
    if (!this.started) {
      this.started = true;
      await this.handlers.start();
    }
    if (typeof chunk.model === "string" && chunk.model)
      this.model ??= chunk.model;
    const usage = record(chunk.usage);
    if (usage) {
      this.rawUsage = usage;
      this.usage = parseUsage(usage);
    }
    if (!Array.isArray(chunk.choices)) return;
    for (const value of chunk.choices) {
      const choice = record(value);
      if (!choice) continue;
      if (typeof choice.index === "number" && choice.index !== 0) continue;
      const delta =
        record(streamed ? (choice.delta ?? choice.message) : choice.message) ??
        {};
      for (const field of ["reasoning_content", "reasoning"] as const) {
        const text = delta[field];
        if (typeof text !== "string" || !text) continue;
        this.field ??= field;
        this.reasoning += text;
        await this.handlers.reasoning(text, field);
        break;
      }
      for (const text of [delta.content, delta.refusal]) {
        const value =
          typeof text === "string"
            ? text
            : Array.isArray(text)
              ? (joinText(text) ?? "")
              : "";
        if (!value) continue;
        this.text += value;
        await this.handlers.text(value);
      }
      if (Array.isArray(delta.tool_calls))
        await this.tools.apply(delta.tool_calls, this.handlers);
      if (typeof choice.finish_reason === "string" && choice.finish_reason)
        this.finish = choice.finish_reason;
    }
  }
  async result(terminated: boolean): Promise<ChatResult> {
    if (!this.started) {
      this.started = true;
      await this.handlers.start();
    }
    const calls = await this.tools.finish(this.handlers);
    return {
      text: this.text,
      reasoning: this.reasoning,
      calls,
      finish: normalizeFinish(this.finish, calls),
      terminated: terminated || this.finish !== "",
      ...(this.model ? { model: this.model } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.rawUsage ? { rawUsage: this.rawUsage } : {}),
      ...(this.field ? { reasoningField: this.field } : {}),
    };
  }
}

/**
 * Parse one SSE payload stream; `feed` accepts decoded text in arbitrary
 * splits. `received` runs for every `data` line, comments and other fields
 * excluded, before the event it belongs to is dispatched. A bare JSON object
 * between events (the Gemini API's failed-stream form) is dispatched as one
 * payload once its lines parse, or at the end of the body as it is.
 */
class SseParser {
  #pending = "";
  #data: string[] = [];
  #done = false;
  /** Lines of a bare JSON object outside any event, until they parse. */
  #bare: string[] | undefined;
  /** True once `[DONE]` arrived. */
  get done(): boolean {
    return this.#done;
  }
  constructor(
    private readonly dispatch: (data: string) => Promise<void>,
    private readonly received: () => void,
  ) {}
  async feed(text: string, final = false): Promise<void> {
    this.#pending += text;
    let hold = "";
    if (!final && this.#pending.endsWith("\r")) {
      hold = "\r";
      this.#pending = this.#pending.slice(0, -1);
    }
    const lines = this.#pending.split(/\r\n|\r|\n/);
    this.#pending = (final ? "" : (lines.pop() ?? "")) + hold;
    for (const line of lines) await this.#line(line);
    if (final && this.#bare) {
      const text = this.#bare.join("\n");
      this.#bare = undefined;
      await this.dispatch(text);
    }
    if (final) await this.#line("");
  }
  async #line(line: string): Promise<void> {
    // The Gemini API ends a failed stream with a bare JSON error object,
    // possibly over several lines; it is read as one more payload.
    if (this.#bare || (line.startsWith("{") && !this.#data.length)) {
      (this.#bare ??= []).push(line);
      const text = this.#bare.join("\n");
      try {
        JSON.parse(text);
      } catch {
        return;
      }
      this.#bare = undefined;
      this.received();
      await this.dispatch(text);
      return;
    }
    if (!line) {
      const data = this.#data.join("\n").trim();
      this.#data = [];
      if (!data || this.#done) return;
      if (data === "[DONE]") {
        this.#done = true;
        return;
      }
      await this.dispatch(data);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    this.received();
    const value = colon < 0 ? "" : line.slice(colon + 1);
    this.#data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
}

/**
 * Turns the payloads of a non-Chat upstream protocol into Chat chunks, so
 * that {@link readCompletion} reads every protocol through one tool
 * accumulator and finish normalization. Stateful per response; throws a
 * {@link GatewayError} for an upstream error event.
 */
export interface ChunkDecoder {
  /** Chat chunks for one SSE data payload; empty for events without content. */
  event(payload: unknown): Record<string, unknown>[];
  /** Chat chunks for a complete JSON body. */
  body(payload: unknown): Record<string, unknown>[];
}

/** Read-side limits and progress observers owned by the gateway. */
export interface ReadLimits {
  maxBytes: number;
  /** Called for each received body chunk, including chunks of only SSE comments or blank lines. */
  activity(): void;
  /**
   * Called for each upstream data event: an SSE `data` line, or a JSON body
   * chunk with non-whitespace text. Comments and blank lines are not data, so
   * an upstream that only sends them cannot reset an idle timer driven by this.
   */
  data(): void;
}
/**
 * Read a successful (2xx) upstream response. SSE is parsed leniently (missing
 * `[DONE]`, missing trailing blank line, null fields); a JSON body is read as a
 * complete Chat completion. With a `decoder`, payloads of another protocol
 * are turned into Chat chunks first. Throws {@link GatewayError} for upstream
 * errors, malformed data or bodies above `maxBytes`. Abort errors propagate
 * unchanged.
 */
export async function readCompletion(
  response: Response,
  handlers: CompletionHandlers,
  makeId: () => string,
  limits: ReadLimits,
  decoder?: ChunkDecoder,
): Promise<ChatResult> {
  const completion = new Completion(makeId, handlers);
  const json = /application\/json/i.test(
    response.headers.get("content-type") ?? "",
  );
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const parse = (data: string): unknown => {
    try {
      return JSON.parse(data);
    } catch {
      throw new GatewayError("Upstream sent malformed stream data", 502);
    }
  };
  const sse = new SseParser(
    async (data) => {
      const payload = parse(data);
      if (!decoder) return completion.chunk(payload, true);
      for (const chunk of decoder.event(payload))
        await completion.chunk(chunk, true);
    },
    () => limits.data(),
  );
  let body = "",
    bytes = 0;
  if (response.body)
    for await (const chunk of response.body) {
      limits.activity();
      bytes += chunk.byteLength;
      if (bytes > limits.maxBytes)
        throw new GatewayError(
          "Upstream model response exceeds the gateway size limit",
          502,
          "response_too_large",
        );
      let text: string;
      try {
        text = utf8.decode(chunk, { stream: true });
      } catch {
        throw new GatewayError("Upstream sent invalid UTF-8", 502);
      }
      if (json) {
        body += text;
        if (/\S/.test(text)) limits.data();
      } else await sse.feed(text);
    }
  let tail: string;
  try {
    tail = utf8.decode();
  } catch {
    throw new GatewayError("Upstream sent invalid UTF-8", 502);
  }
  if (json) {
    const payload = parse(body + tail);
    if (!decoder) await completion.chunk(payload, false);
    else
      for (const chunk of decoder.body(payload))
        await completion.chunk(chunk, true);
  } else await sse.feed(tail, true);
  return completion.result(json || sse.done);
}

const CONTEXT_PATTERNS = [
  /context[ _-]?length/i,
  /context[ _-]?window/i,
  /maximum context/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input (?:is )?too long/i,
  /input token count/i,
  /reduce the length of the (?:messages|input|prompt)/i,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum )?(?:context|token limit|input limit)/i,
];
/**
 * Whether an upstream error means the prompt exceeds the model context. A
 * vLLM-style report whose prompt alone fits (the requested output limit is too
 * large) is not a context overflow, so engines do not compact in a loop.
 */
export function isContextOverflow(
  code: string | undefined,
  message: string,
): boolean {
  const split = message.match(
    /maximum context length is (\d+)[\s\S]*?\((\d+) in the messages, (\d+) in the completion\)/i,
  );
  if (split) return Number(split[2]) >= Number(split[1]);
  return (
    code === "context_length_exceeded" ||
    CONTEXT_PATTERNS.some((pattern) => pattern.test(message))
  );
}
/**
 * Numbers from a context-overflow message, when the upstream reported them:
 * OpenAI's and vLLM's wording, Anthropic's `prompt is too long: N tokens > M
 * maximum` and Gemini's `input token count (N) exceeds the maximum number of
 * tokens allowed (M)`.
 */
export function contextNumbers(
  message: string,
): { actual: number; limit: number } | undefined {
  const limit =
    message.match(/maximum context length is (\d+)/i) ??
    message.match(/(?:limit|maximum)(?: of| is)? (\d+) tokens/i) ??
    message.match(/> (\d+) maximum/i) ??
    message.match(/tokens allowed \((\d+)\)/i);
  const actual =
    message.match(/(\d+) in the messages/i) ??
    message.match(/requested (\d+) tokens/i) ??
    message.match(/resulted in (\d+) tokens/i) ??
    message.match(/token count \((\d+)\)/i) ??
    message.match(/(?:prompt|input)[^\d]{0,40}(\d+) tokens/i);
  return limit?.[1] && actual?.[1]
    ? { actual: Number(actual[1]), limit: Number(limit[1]) }
    : undefined;
}

function errorMessage(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return errorMessage(value[0], depth + 1);
  const object = record(value);
  if (!object) return "";
  for (const key of [
    "message",
    "error",
    "detail",
    "msg",
    "error_msg",
    "errorMessage",
  ]) {
    const found = errorMessage(object[key], depth + 1);
    if (found) return found;
  }
  return "";
}
/** Extract a readable message and code from an upstream error body. */
export function upstreamError(
  body: string,
  status: number,
): { message: string; code?: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = record(record(parsed)?.error) ?? record(parsed);
    const message = errorMessage(parsed).trim();
    const code =
      typeof error?.code === "string"
        ? error.code
        : typeof error?.type === "string"
          ? error.type
          : undefined;
    if (message) return { message, ...(code ? { code } : {}) };
  } catch {
    // Not JSON: fall back to the text body below.
  }
  const text = body.trim();
  return {
    message: text || `Upstream model returned HTTP ${status}`,
  };
}

const MAX_PUBLIC_MESSAGE = 500;
/** Truncate to at most 500 characters (code points), marking the cut. */
export function truncateText(value: string): string {
  const characters = Array.from(value);
  return characters.length > MAX_PUBLIC_MESSAGE
    ? characters.slice(0, MAX_PUBLIC_MESSAGE - 1).join("") + "…"
    : value;
}
/**
 * Remove known secret values and credential-shaped text (Gateway Key text
 * included), collapse whitespace and truncate to 500 characters. Used for
 * every upstream-derived message.
 */
export function sanitize(text: string, secrets: readonly string[]): string {
  let value = text;
  for (const secret of secrets)
    if (secret.length >= 4) value = value.split(secret).join("[redacted]");
  value = redactKeyText(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-[redacted]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|authorization|x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return truncateText(value);
}
