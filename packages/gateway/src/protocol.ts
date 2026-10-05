// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { redactKeyText } from "@harnesshub/core/key-text";

/**
 * A request or upstream failure whose message is already safe to show to an
 * engine: it never contains request bodies, credentials or raw upstream bytes
 * unless they were sanitized first. `status` is the HTTP status the gateway
 * reports; `contextOverflow` selects the inbound protocol's context-limit error.
 */
export class GatewayError extends Error {
  /**
   * @param detail The vendor's error object as it came (JSON), for an
   *   in-stream error: read to route the failure, never stored or sent.
   */
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
    readonly contextOverflow = false,
    readonly detail?: string,
  ) {
    // Gateway Key text a client put in what the message quotes is not echoed.
    super(redactKeyText(message));
  }
}
/** Reject non-object protocol values before accessing their fields. */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GatewayError("Expected a JSON object");
  return value as Record<string, unknown>;
}
/** Reject non-array protocol values; elements remain unknown until checked. */
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new GatewayError("Expected a JSON array");
  return value;
}
/** Accept text without coercing structured values or exposing them in errors. */
export function string(value: unknown): string {
  if (typeof value !== "string") throw new GatewayError("Expected text");
  return value;
}
/** Lenient object access for upstream data: anything but a plain object is absent. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Validate a finite generation setting without clamping it silently. */
export function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new GatewayError("Invalid numeric generation setting");
  return value;
}
/**
 * Text that replaces media the gateway does not forward, so one image in a
 * Session history does not make every later request fail (ADR 0013).
 */
export function omittedMedia(what: string): string {
  return `[${what} omitted: the HarnessHub model gateway forwards text only]`;
}
/** Multimodal input cannot be translated to the text-only Chat upstream. */
export function multimodal(what: string): GatewayError {
  return new GatewayError(
    `${what} is not supported by the HarnessHub model gateway; only text and function tools are translated`,
  );
}
/** Join text-only content parts; returns undefined when any part is not text. */
export function joinText(
  parts: unknown[],
  types: readonly string[] = ["text"],
): string | undefined {
  const texts: string[] = [];
  for (const raw of parts) {
    const part = record(raw);
    if (
      !part ||
      typeof part.type !== "string" ||
      !types.includes(part.type) ||
      typeof part.text !== "string"
    )
      return undefined;
    texts.push(part.text);
  }
  return texts.join("\n");
}

/** Immutable native identity behind one Chat tool name; restored before the engine dispatches. */
export interface ToolBinding {
  name: string;
  namespace?: string;
  custom: boolean;
  /** Codex's client-run tool search, offered as a function (./toolsearch.js). */
  search?: true;
}
/**
 * Chat function names must match `^[a-zA-Z0-9_-]{1,64}$`. Other native names
 * and namespaced names use a stable hash alias that `nativeTool` reverses.
 */
export function toolAlias(name: string, namespace?: string): string {
  return namespace || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)
    ? `hh_${createHash("sha256")
        .update(JSON.stringify([namespace ?? "", name]))
        .digest("hex")
        .slice(0, 32)}`
    : name;
}
/** Native identity of an upstream tool name; unknown names pass through unchanged. */
export function nativeTool(
  tools: ReadonlyMap<string, ToolBinding>,
  name: string,
): ToolBinding {
  return tools.get(name) ?? { name, custom: false };
}

/**
 * Reasoning the client asked for, in its own protocol's terms. The Chat body
 * has no common field for it; non-Chat upstream encoders read it here.
 */
export interface ReasoningRequest {
  /** OpenAI-style effort (`minimal`, `low`, `medium`, `high`, …). */
  effort?: string;
  /** Explicit token budget (Anthropic `budget_tokens`, Gemini `thinkingBudget`). */
  budgetTokens?: number;
  /** The client explicitly turned reasoning off. */
  off?: boolean;
}
/** Options of the inbound translators; absent options keep the Session gateway's behaviour. */
export interface TranslateOptions {
  /** Keep images as Chat `image_url` parts instead of text placeholders. */
  images?: boolean;
  /**
   * The gateway answers web search itself (./search.js): a server-side web
   * search tool is accepted and noted in `search`, and searches in the
   * history become text.
   */
  search?: boolean;
}
/** Image content as a Chat `image_url` part. */
export function imagePart(url: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url } };
}
/** User content from text and image parts: a joined string when there are no images. */
export function userContent(
  parts: Record<string, unknown>[],
  separator: string,
): string | Record<string, unknown>[] {
  return parts.every((part) => part.type === "text")
    ? parts.map((part) => part.text as string).join(separator)
    : parts;
}

/** Validated Chat Completions request produced by one inbound adapter, before upstream normalization. */
export interface ChatTranslation {
  /** Chat request body; `messages` holds fresh objects the gateway may mutate. */
  body: { messages: Record<string, unknown>[]; [key: string]: unknown };
  /** Chat tool name → native identity for this request only. */
  tools: Map<string, ToolBinding>;
  stream: boolean;
  requestedModel?: string;
  /** Chat only: the engine asked for a final usage chunk. */
  includeUsage?: boolean;
  /** Google only: `thinkingConfig.includeThoughts` was explicitly false. */
  hideThoughts?: boolean;
  /** Reasoning the client asked for, when it said anything about it. */
  reasoning?: ReasoningRequest;
  /** `tool_call_id`s whose results the client marked as errors. */
  toolErrors?: Set<string>;
  /** The client offered its model a server-side web search tool (with `search` only). */
  search?: boolean;
}

/** A web search in an answer's history, as the model reads it later. */
export function searchedText(query: string): string {
  return `[Searched the web for: ${query}]`;
}
/** The pages a web search in the history found, as the model reads them later. */
export function foundText(hits: { title?: string; url: string }[]): string {
  return [
    "[Web search results:]",
    ...hits.map((hit) => `- ${hit.title ? `${hit.title} — ` : ""}${hit.url}`),
  ].join("\n");
}

/** Upstream token usage parsed leniently; absent fields were not reported. */
export interface Usage {
  input?: number;
  output?: number;
  total?: number;
  reasoning?: number;
  cached?: number;
  /** Prompt tokens written to a cache (Anthropic `cache_creation_input_tokens`), included in `input`. */
  cacheWrite?: number;
}
/** One completed upstream tool call. `input` is set only when `arguments` is a JSON object. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  input?: Record<string, unknown>;
}
/** Chat field that carries upstream reasoning text, mirrored from the upstream stream. */
export type ReasoningField = "reasoning_content" | "reasoning";
/** A finished upstream completion; `finish` is already normalized. */
export interface ChatResult {
  text: string;
  reasoning: string;
  /** Field the upstream used for reasoning, when it sent any. */
  reasoningField?: ReasoningField;
  calls: ToolCall[];
  finish: string;
  usage?: Usage;
  /** Upstream usage object, returned verbatim to Chat engines. */
  rawUsage?: Record<string, unknown>;
  /** First `model` the upstream reported in its chunks (the served model). */
  model?: string;
  /**
   * The upstream ended explicitly: `[DONE]`, a finish reason or a complete
   * JSON body. False means the body simply ended (completion is inferred).
   */
  terminated?: boolean;
}
/** Parse tool arguments; an empty string is an empty object. */
export function parseArguments(
  value: string,
): Record<string, unknown> | undefined {
  if (!value.trim()) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}
/**
 * Rough token estimate for count endpoints and required usage fields when the
 * upstream reports none: about four ASCII characters or one other character per token.
 */
export function estimateTokens(value: unknown): number {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  let ascii = 0,
    other = 0;
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) < 128) ascii++;
    else other++;
  return Math.ceil(ascii / 4 + other);
}
