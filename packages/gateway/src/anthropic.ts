// SPDX-License-Identifier: MIT
import {
  GatewayError,
  array,
  boundedNumber,
  estimateTokens,
  foundText,
  imagePart,
  nativeTool,
  omittedMedia,
  object,
  record,
  searchedText,
  string,
  toolAlias,
  userContent,
  type ChatResult,
  type ChatTranslation,
  type ReasoningRequest,
  type ToolBinding,
  type TranslateOptions,
} from "./protocol.js";
import {
  sse,
  type Failure,
  type HttpWriter,
  type OutputSink,
  type SinkContext,
} from "./output.js";
import { thinkingSignature } from "./reasoning.js";
import { contextNumbers, truncateText } from "./upstream.js";

function blocks(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value).map(object);
}
function systemText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return blocks(value)
    .map((block) => {
      if (block.type !== "text")
        throw new GatewayError("Anthropic system accepts text blocks only");
      return string(block.text);
    })
    .filter(Boolean)
    .join("\n\n");
}
function resultText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return blocks(value)
    .map((block) => {
      if (block.type === "text") return string(block.text);
      if (block.type === "image" || block.type === "document")
        return omittedMedia(`Tool result ${block.type}`);
      throw new GatewayError("Unsupported Anthropic tool_result content");
    })
    .join("\n");
}

/** An Anthropic image block as a data or https URL; undefined for other sources. */
function imageUrl(block: Record<string, unknown>): string | undefined {
  const source = record(block.source);
  if (source?.type === "url" && typeof source.url === "string")
    return source.url;
  if (
    source?.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  )
    return `data:${source.media_type};base64,${source.data}`;
  return undefined;
}
function thinkingRequest(value: unknown): ReasoningRequest | undefined {
  const thinking = record(value);
  if (!thinking) return undefined;
  if (thinking.type === "disabled") return { off: true };
  return typeof thinking.budget_tokens === "number"
    ? { budgetTokens: thinking.budget_tokens }
    : {};
}

/**
 * Translate an Anthropic Messages request (Claude Code) to Chat: system text,
 * text/tool_use/tool_result/thinking blocks, client tools, tool_choice,
 * max_tokens, stop_sequences and sampling. Thinking text becomes
 * `reasoning_content`, the `thinking` setting the reasoning request, and
 * `is_error` results the translation's tool errors. Images become Chat image
 * parts with `options.images`, otherwise text placeholders like documents;
 * server tools, `container` and `mcp_servers` fail explicitly; unknown
 * top-level hint fields are ignored.
 */
export function anthropicToChat(
  raw: unknown,
  options: TranslateOptions = {},
): ChatTranslation {
  const request = object(raw);
  for (const key of ["container", "mcp_servers"]) {
    const value = request[key];
    if (
      value !== undefined &&
      value !== null &&
      !(Array.isArray(value) && value.length === 0)
    )
      throw new GatewayError(
        `Anthropic ${key} is unsupported by the model gateway`,
      );
  }
  if (request.stream !== undefined && typeof request.stream !== "boolean")
    throw new GatewayError("Invalid stream setting");
  const bindings = new Map<string, ToolBinding>();
  const tools: Record<string, unknown>[] = [];
  let search = false;
  for (const rawTool of request.tools === undefined || request.tools === null
    ? []
    : array(request.tools)) {
    const tool = object(rawTool);
    if (
      options.search &&
      typeof tool.type === "string" &&
      tool.type.startsWith("web_search_")
    ) {
      search = true;
      continue;
    }
    if (tool.type !== undefined && tool.type !== null && tool.type !== "custom")
      throw new GatewayError(
        `Anthropic server tool ${typeof tool.type === "string" ? tool.type.slice(0, 64) : "unknown"} is unsupported; use client tools`,
      );
    const name = string(tool.name),
      mapped = toolAlias(name);
    if (bindings.has(mapped)) throw new GatewayError("Duplicate tool names");
    bindings.set(mapped, { name, custom: false });
    tools.push({
      type: "function",
      function: {
        name: mapped,
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        parameters:
          tool.input_schema === undefined || tool.input_schema === null
            ? { type: "object", properties: {} }
            : object(tool.input_schema),
      },
    });
  }
  const messages: Record<string, unknown>[] = [];
  const toolErrors = new Set<string>();
  const system = systemText(request.system);
  if (system) messages.push({ role: "system", content: system });
  for (const rawMessage of array(request.messages)) {
    const message = object(rawMessage);
    const role = message.role;
    // Claude Code 2.1.2xx sends its environment section as a system message
    // inside `messages`; upstream normalization merges it into the leading one.
    if (role === "system") {
      const text = systemText(message.content);
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    if (role !== "user" && role !== "assistant")
      throw new GatewayError("Unsupported Anthropic message role");
    const texts: string[] = [],
      parts: Record<string, unknown>[] = [],
      thoughts: string[] = [],
      calls: Record<string, unknown>[] = [],
      results: Record<string, unknown>[] = [];
    for (const block of blocks(message.content)) {
      switch (block.type) {
        case "text":
          texts.push(string(block.text));
          parts.push({ type: "text", text: string(block.text) });
          break;
        case "thinking":
          if (role === "assistant" && typeof block.thinking === "string")
            thoughts.push(block.thinking);
          break;
        case "redacted_thinking":
          break;
        case "tool_use":
          if (role !== "assistant")
            throw new GatewayError("tool_use requires the assistant role");
          calls.push({
            id: string(block.id),
            type: "function",
            function: {
              name: toolAlias(string(block.name)),
              arguments: JSON.stringify(
                block.input === undefined || block.input === null
                  ? {}
                  : object(block.input),
              ),
            },
          });
          break;
        case "tool_result":
          if (role !== "user")
            throw new GatewayError("tool_result requires the user role");
          if (block.is_error === true)
            toolErrors.add(string(block.tool_use_id));
          results.push({
            role: "tool",
            tool_call_id: string(block.tool_use_id),
            content: resultText(block.content),
          });
          break;
        case "server_tool_use":
        case "web_search_tool_result":
          // A search the gateway answered earlier, as text for the model.
          if (options.search && role === "assistant") {
            const text =
              block.type === "server_tool_use"
                ? searchedText(String(object(block.input).query ?? ""))
                : foundText(
                    (Array.isArray(block.content) ? block.content : [])
                      .map((hit: unknown) => object(hit))
                      .filter((hit) => typeof hit.url === "string")
                      .map((hit) => ({
                        url: String(hit.url),
                        ...(typeof hit.title === "string"
                          ? { title: hit.title }
                          : {}),
                      })),
                  );
            texts.push(text);
            parts.push({ type: "text", text });
            break;
          }
          throw new GatewayError(
            `Unsupported Anthropic content block: ${block.type}`,
          );
        case "image":
        case "document": {
          const url = block.type === "image" ? imageUrl(block) : undefined;
          if (options.images && url) parts.push(imagePart(url));
          else {
            const text = omittedMedia(`Anthropic ${block.type}`);
            texts.push(text);
            parts.push({ type: "text", text });
          }
          break;
        }
        default:
          throw new GatewayError(
            `Unsupported Anthropic content block: ${typeof block.type === "string" ? block.type.slice(0, 64) : "unknown"}`,
          );
      }
    }
    if (role === "user") {
      messages.push(...results);
      if (parts.length)
        messages.push({ role: "user", content: userContent(parts, "\n") });
      continue;
    }
    const assistant: Record<string, unknown> = {
      role: "assistant",
      content: texts.length ? texts.join("\n") : calls.length ? null : "",
    };
    if (calls.length) assistant.tool_calls = calls;
    if (thoughts.length) assistant.reasoning_content = thoughts.join("\n");
    messages.push(assistant);
  }
  const body: ChatTranslation["body"] = { messages };
  if (tools.length) body.tools = tools;
  const choice = record(request.tool_choice);
  if (choice) {
    switch (choice.type) {
      case "auto":
        body.tool_choice = "auto";
        break;
      case "any":
        body.tool_choice = "required";
        break;
      case "none":
        body.tool_choice = "none";
        break;
      case "tool":
        body.tool_choice = {
          type: "function",
          function: { name: toolAlias(string(choice.name)) },
        };
        break;
      default:
        throw new GatewayError("Unsupported Anthropic tool_choice");
    }
    if (choice.disable_parallel_tool_use === true)
      body.parallel_tool_calls = false;
  }
  if (request.max_tokens !== undefined && request.max_tokens !== null)
    body.max_tokens = boundedNumber(
      request.max_tokens,
      1,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  if (request.stop_sequences !== undefined && request.stop_sequences !== null) {
    const stop = array(request.stop_sequences).map(string);
    if (stop.length) body.stop = stop;
  }
  if (request.temperature !== undefined && request.temperature !== null)
    body.temperature = boundedNumber(request.temperature, 0, 2);
  if (request.top_p !== undefined && request.top_p !== null)
    body.top_p = boundedNumber(request.top_p, 0, 1);
  const format = record(request.output_format);
  if (format?.type === "json_schema")
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: format.schema },
    };
  const reasoning = thinkingRequest(request.thinking);
  return {
    body,
    tools: bindings,
    stream: request.stream === true,
    ...(typeof request.model === "string"
      ? { requestedModel: request.model }
      : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(toolErrors.size ? { toolErrors } : {}),
    ...(search ? { search } : {}),
  };
}

/** `count_tokens` answer: a local estimate over the translated request; no upstream call. */
export function anthropicCountTokens(raw: unknown): { input_tokens: number } {
  const translated = anthropicToChat(raw);
  return {
    input_tokens: estimateTokens({
      messages: translated.body.messages,
      tools: translated.body.tools,
    }),
  };
}

const errorTypes: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  503: "overloaded_error",
  529: "overloaded_error",
};
function anthropicError(failure: Failure): Record<string, unknown> {
  if (failure.contextOverflow) {
    const numbers = contextNumbers(failure.message);
    return {
      type: "invalid_request_error",
      message: truncateText(
        numbers
          ? `prompt is too long: ${numbers.actual} tokens > ${numbers.limit} maximum`
          : `prompt is too long: ${failure.message}`,
      ),
    };
  }
  return {
    type:
      errorTypes[failure.status] ??
      (failure.status >= 500 ? "api_error" : "invalid_request_error"),
    message: failure.message,
  };
}
/** Status and body of an Anthropic error response. */
export function anthropicErrorResponse(failure: Failure): {
  status: number;
  body: unknown;
} {
  return {
    status: failure.contextOverflow ? 400 : failure.status,
    body: { type: "error", error: anthropicError(failure) },
  };
}

function stopReason(finish: string): string {
  switch (finish) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

type OpenBlock =
  | { kind: "thinking"; index: number; text: string }
  | { kind: "text"; index: number }
  | { kind: "tool"; index: number; call: number };

/**
 * Anthropic Messages output. Streams message_start, thinking/text/tool_use
 * content blocks (one open block at a time; tool input as input_json_delta),
 * message_delta with stop_reason and usage, then message_stop. The keepalive
 * is the protocol's own `ping` event, as the Anthropic API sends it.
 * `@anthropic-ai/sdk`'s stream iterator skips `ping`, so it resets byte-level
 * timeouts only, not a watchdog that counts SDK events; its effect on Claude
 * Code's watchdog has not been measured.
 */
export class AnthropicSink implements OutputSink {
  #blocks = 0;
  #open: OpenBlock | undefined;
  #closedCalls = new Set<number>();
  /** Blocks of the gateway's searches, for an answer that does not stream. */
  #searches: Record<string, unknown>[] = [];
  constructor(
    private readonly writer: HttpWriter,
    private readonly translation: ChatTranslation,
    private readonly context: SinkContext,
  ) {}
  async #event(type: string, fields: Record<string, unknown>): Promise<void> {
    await this.writer.write(sse({ type, ...fields }, type));
  }
  #usage(result: ChatResult): Record<string, unknown> {
    const cached = result.usage?.cached ?? 0;
    const written = result.usage?.cacheWrite ?? 0;
    const input = result.usage?.input ?? this.context.promptEstimate;
    return {
      input_tokens: Math.max(0, input - cached - written),
      output_tokens:
        result.usage?.output ??
        estimateTokens(
          result.reasoning +
            result.text +
            result.calls.map((call) => call.arguments).join(""),
        ),
      cache_creation_input_tokens: written,
      cache_read_input_tokens: cached,
    };
  }
  async start(): Promise<void> {
    if (!this.translation.stream) return;
    this.writer.begin(200, "text/event-stream; charset=utf-8");
    await this.#event("message_start", {
      message: {
        id: `msg_${this.context.id}`,
        type: "message",
        role: "assistant",
        model: this.context.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.context.promptEstimate,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    await this.#event("ping", {});
  }
  async #close(): Promise<void> {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    if (open.kind === "thinking")
      await this.#event("content_block_delta", {
        index: open.index,
        delta: {
          type: "signature_delta",
          signature: thinkingSignature(open.text),
        },
      });
    if (open.kind === "tool") this.#closedCalls.add(open.call);
    await this.#event("content_block_stop", { index: open.index });
  }
  async #begin(block: Record<string, unknown>): Promise<number> {
    await this.#close();
    const index = this.#blocks++;
    await this.#event("content_block_start", { index, content_block: block });
    return index;
  }
  async reasoning(text: string): Promise<void> {
    if (!this.translation.stream || !this.context.reasoning) return;
    if (this.#open?.kind !== "thinking") {
      const index = await this.#begin({
        type: "thinking",
        thinking: "",
        signature: "",
      });
      this.#open = { kind: "thinking", index, text: "" };
    }
    this.#open.text += text;
    await this.#event("content_block_delta", {
      index: this.#open.index,
      delta: { type: "thinking_delta", thinking: text },
    });
  }
  async text(text: string): Promise<void> {
    if (!this.translation.stream) return;
    if (this.#open?.kind !== "text") {
      const index = await this.#begin({ type: "text", text: "" });
      this.#open = { kind: "text", index };
    }
    await this.#event("content_block_delta", {
      index: this.#open.index,
      delta: { type: "text_delta", text },
    });
  }
  async toolStart(call: {
    index: number;
    id: string;
    name: string;
  }): Promise<void> {
    if (!this.translation.stream) return;
    const index = await this.#begin({
      type: "tool_use",
      id: call.id,
      name: nativeTool(this.translation.tools, call.name).name,
      input: {},
    });
    this.#open = { kind: "tool", index, call: call.index };
  }
  async toolArgs(index: number, text: string): Promise<void> {
    if (!this.translation.stream) return;
    if (this.#open?.kind !== "tool" || this.#open.call !== index)
      throw new GatewayError(
        this.#closedCalls.has(index)
          ? "Upstream interleaved parallel tool call arguments"
          : "Upstream tool call arguments arrived out of order",
        502,
        "upstream_protocol_error",
      );
    await this.#event("content_block_delta", {
      index: this.#open.index,
      delta: { type: "input_json_delta", partial_json: text },
    });
  }
  /**
   * A web search the gateway ran: a `server_tool_use` block and its
   * `web_search_tool_result`, with ids marked as the gateway's
   * (`srvtoolu_hh_…`) so a later request with them is answered here again.
   */
  async search(
    query: string,
    hits: { title: string; url: string }[],
  ): Promise<void> {
    const id = `srvtoolu_hh_${this.context.id}_${this.#blocks + this.#searches.length}`;
    const use = {
      type: "server_tool_use",
      id,
      name: "web_search",
      input: { query },
    };
    const found = {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: hits.map((hit) => ({
        type: "web_search_result",
        title: hit.title,
        url: hit.url,
        encrypted_content: "",
        page_age: null,
      })),
    };
    if (!this.translation.stream) {
      this.#searches.push(use, found);
      return;
    }
    const at = await this.#begin({ ...use, input: {} });
    await this.#event("content_block_delta", {
      index: at,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ query }),
      },
    });
    await this.#event("content_block_stop", { index: at });
    const result = await this.#begin(found);
    await this.#event("content_block_stop", { index: result });
  }
  async finish(result: ChatResult): Promise<void> {
    if (this.translation.stream) {
      await this.#close();
      await this.#event("message_delta", {
        delta: { stop_reason: stopReason(result.finish), stop_sequence: null },
        usage: this.#usage(result),
      });
      await this.#event("message_stop", {});
      await this.writer.end();
      return;
    }
    const content: Record<string, unknown>[] = [...this.#searches];
    if (this.context.reasoning && result.reasoning)
      content.push({
        type: "thinking",
        thinking: result.reasoning,
        signature: thinkingSignature(result.reasoning),
      });
    if (result.text) content.push({ type: "text", text: result.text });
    for (const call of result.calls) {
      if (!call.input)
        throw new GatewayError(
          "Upstream returned malformed tool arguments",
          502,
          "upstream_protocol_error",
        );
      content.push({
        type: "tool_use",
        id: call.id,
        name: nativeTool(this.translation.tools, call.name).name,
        input: call.input,
      });
    }
    await this.writer.json(200, {
      id: `msg_${this.context.id}`,
      type: "message",
      role: "assistant",
      model: this.context.model,
      content,
      stop_reason: stopReason(result.finish),
      stop_sequence: null,
      usage: this.#usage(result),
    });
  }
  async keepalive(): Promise<void> {
    if (this.translation.stream) await this.#event("ping", {});
  }
  async fail(failure: Failure): Promise<void> {
    await this.#event("error", { error: anthropicError(failure) });
    await this.writer.end();
  }
}
