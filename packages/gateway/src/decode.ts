// SPDX-License-Identifier: MIT
/**
 * Decoders from the streams and bodies of Anthropic Messages, OpenAI
 * Responses and Gemini generateContent to Chat chunks, the gateway's pivot.
 * `readCompletion` feeds the chunks through the same tool accumulator and
 * finish normalization as a Chat upstream, so every inbound sink works
 * unchanged. Upstream error events throw. Signatures that only the issuing
 * provider accepts back are collected for same-provider replay; they are
 * never forwarded to clients. Shaped as the decode edges of the future IR.
 */
import type { EncodedProtocol } from "./encode.js";
import {
  anthropicFinish,
  geminiFinishReason,
  observeJson,
  responsesFinish,
} from "./passthrough.js";

export { anthropicFinish, responsesFinish };
import { GatewayError, record } from "./protocol.js";
import type { ChunkDecoder } from "./upstream.js";

/** A ChunkDecoder that also reports what it dropped and the signatures it saw. */
export interface UpstreamDecoder extends ChunkDecoder {
  /** Response content the inbound protocols cannot carry (redacted thinking, server tool blocks). */
  readonly unmapped: ReadonlySet<string>;
  /** Thinking blocks in order with their signatures (Anthropic). */
  readonly thinking: readonly { text: string; signature?: string }[];
  /** Signatures by tool call index (Gemini `thoughtSignature` on function calls). */
  readonly callSignatures: ReadonlyMap<number, string>;
  /**
   * The reasoning item that preceded each tool call, by tool call index, as
   * it can go back to the same Responses provider: `type`, `id`, `summary`
   * and `encrypted_content` when the provider gave them.
   */
  readonly callReasoning: ReadonlyMap<number, Record<string, unknown>>;
}

type Chunk = Record<string, unknown>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
function delta(value: Chunk, finish: string | null = null): Chunk {
  return { choices: [{ index: 0, delta: value, finish_reason: finish }] };
}
function upstreamError(value: Chunk, protocol: EncodedProtocol): void {
  const observed = observeJson(protocol, value);
  if (observed.error) throw observed.error;
}

/** Gemini `finishReason` as a Chat finish reason; malformed function calls are an upstream error. */
export function geminiFinish(reason: string): string {
  if (reason === "MALFORMED_FUNCTION_CALL" || reason === "UNEXPECTED_TOOL_CALL")
    throw new GatewayError(
      `Upstream model produced an invalid function call (${reason})`,
      502,
      "upstream_protocol_error",
    );
  return geminiFinishReason(reason);
}

class AnthropicDecoder implements UpstreamDecoder {
  unmapped = new Set<string>();
  thinking: { text: string; signature?: string }[] = [];
  callSignatures = new Map<number, string>();
  callReasoning = new Map<number, Record<string, unknown>>();
  #usage: Record<string, number> = {};
  #tools = new Map<number, number>();
  #blocks = new Map<number, { text: string; signature?: string }>();

  #mergeUsage(value: unknown): Chunk | undefined {
    const usage = record(value);
    if (!usage) return undefined;
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]) {
      const tokens = count(usage[key]);
      if (tokens !== undefined) this.#usage[key] = tokens;
    }
    const input = this.#usage.input_tokens ?? 0;
    const read = this.#usage.cache_read_input_tokens ?? 0;
    const written = this.#usage.cache_creation_input_tokens ?? 0;
    const output = this.#usage.output_tokens ?? 0;
    return {
      prompt_tokens: input + read + written,
      completion_tokens: output,
      total_tokens: input + read + written + output,
      prompt_tokens_details: { cached_tokens: read },
      cache_creation_input_tokens: written,
    };
  }
  #start(index: number, block: Chunk): Chunk[] {
    switch (block.type) {
      case "text":
        return typeof block.text === "string" && block.text
          ? [delta({ content: block.text })]
          : [];
      case "thinking": {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        const entry = { text };
        this.#blocks.set(index, entry);
        this.thinking.push(entry);
        return text ? [delta({ reasoning_content: text })] : [];
      }
      case "tool_use": {
        const tool = this.#tools.size;
        this.#tools.set(index, tool);
        const input = record(block.input);
        return [
          delta({
            tool_calls: [
              {
                index: tool,
                id: block.id,
                type: "function",
                function: {
                  name: block.name,
                  arguments:
                    input && Object.keys(input).length
                      ? JSON.stringify(input)
                      : "",
                },
              },
            ],
          }),
        ];
      }
      default:
        this.unmapped.add(`response.${String(block.type)}`);
        return [];
    }
  }
  event(payload: unknown): Chunk[] {
    const value = record(payload);
    if (!value) return [];
    upstreamError(value, "anthropic");
    switch (value.type) {
      case "message_start": {
        const message = record(value.message);
        const usage = this.#mergeUsage(message?.usage);
        return [
          {
            ...(typeof message?.model === "string"
              ? { model: message.model }
              : {}),
            choices: [],
            ...(usage ? { usage } : {}),
          },
        ];
      }
      case "content_block_start":
        return this.#start(
          count(value.index) ?? 0,
          record(value.content_block) ?? {},
        );
      case "content_block_delta": {
        const index = count(value.index) ?? 0;
        const change = record(value.delta) ?? {};
        switch (change.type) {
          case "text_delta":
            return typeof change.text === "string" && change.text
              ? [delta({ content: change.text })]
              : [];
          case "thinking_delta": {
            const text =
              typeof change.thinking === "string" ? change.thinking : "";
            const block = this.#blocks.get(index);
            if (block) block.text += text;
            return text ? [delta({ reasoning_content: text })] : [];
          }
          case "signature_delta": {
            const block = this.#blocks.get(index);
            if (block && typeof change.signature === "string")
              block.signature = (block.signature ?? "") + change.signature;
            return [];
          }
          case "input_json_delta": {
            const tool = this.#tools.get(index);
            return tool !== undefined && typeof change.partial_json === "string"
              ? [
                  delta({
                    tool_calls: [
                      {
                        index: tool,
                        function: { arguments: change.partial_json },
                      },
                    ],
                  }),
                ]
              : [];
          }
          default:
            return [];
        }
      }
      case "message_delta": {
        const usage = this.#mergeUsage(value.usage);
        const reason = record(value.delta)?.stop_reason;
        return [
          {
            ...delta(
              {},
              typeof reason === "string" ? anthropicFinish(reason) : null,
            ),
            ...(usage ? { usage } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }
  body(payload: unknown): Chunk[] {
    const message = record(payload);
    if (!message) return [];
    upstreamError(message, "anthropic");
    const chunks = this.event({ type: "message_start", message });
    const blocks = Array.isArray(message.content) ? message.content : [];
    blocks.forEach((raw, index) => {
      const block = record(raw) ?? {};
      if (block.type === "tool_use") {
        chunks.push(...this.#start(index, { ...block, input: undefined }));
        chunks.push(
          delta({
            tool_calls: [
              {
                index: this.#tools.get(index),
                function: { arguments: JSON.stringify(block.input ?? {}) },
              },
            ],
          }),
        );
        return;
      }
      chunks.push(...this.#start(index, block));
      const entry = this.#blocks.get(index);
      if (entry && typeof block.signature === "string")
        entry.signature = block.signature;
    });
    chunks.push(
      ...this.event({
        type: "message_delta",
        delta: { stop_reason: message.stop_reason },
        usage: message.usage,
      }),
    );
    return chunks;
  }
}

class ResponsesDecoder implements UpstreamDecoder {
  unmapped = new Set<string>();
  thinking: { text: string; signature?: string }[] = [];
  callSignatures = new Map<number, string>();
  /** Output index or item id → tool index, and whether arguments arrived as deltas. */
  #tools = new Map<string, { index: number; streamed: boolean }>();
  #count = 0;
  #text = false;
  #reasoning = false;
  /** Reasoning items by item id (or output index), as complete as they arrived. */
  #items = new Map<string, Record<string, unknown>>();
  /** The reasoning item seen last, and the one each tool call index followed. */
  #lastItem: string | undefined;
  #callItems = new Map<number, string>();

  get callReasoning(): ReadonlyMap<number, Record<string, unknown>> {
    const result = new Map<number, Record<string, unknown>>();
    for (const [index, name] of this.#callItems) {
      const item = this.#items.get(name);
      if (item) result.set(index, item);
    }
    return result;
  }
  /**
   * Keep a reasoning item for replay: added items have an empty summary and
   * done items (and the final output) the whole one, so later non-empty
   * values win.
   */
  #reasoningItem(item: Chunk, outputIndex: unknown): void {
    const name =
      typeof item.id === "string" ? `i${item.id}` : `o${String(outputIndex)}`;
    const known = this.#items.get(name) ?? { type: "reasoning" };
    if (typeof item.id === "string") known.id = item.id;
    const summary = (Array.isArray(item.summary) ? item.summary : [])
      .map(record)
      .filter((part) => typeof part?.text === "string")
      .map((part) => ({ type: "summary_text", text: part!.text as string }));
    if (summary.length || !Array.isArray(known.summary))
      known.summary = summary;
    if (typeof item.encrypted_content === "string")
      known.encrypted_content = item.encrypted_content;
    this.#items.set(name, known);
    this.#lastItem = name;
  }

  #usage(value: unknown): Chunk | undefined {
    const usage = record(value);
    if (!usage) return undefined;
    const input = count(usage.input_tokens) ?? 0;
    const output = count(usage.output_tokens) ?? 0;
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: count(usage.total_tokens) ?? input + output,
      prompt_tokens_details: {
        cached_tokens:
          count(record(usage.input_tokens_details)?.cached_tokens) ?? 0,
      },
      completion_tokens_details: {
        reasoning_tokens:
          count(record(usage.output_tokens_details)?.reasoning_tokens) ?? 0,
      },
    };
  }
  #tool(item: Chunk, outputIndex: unknown): Chunk[] {
    const index = this.#count++;
    if (this.#lastItem) this.#callItems.set(index, this.#lastItem);
    const entry = { index, streamed: false };
    this.#tools.set(`o${String(outputIndex)}`, entry);
    if (typeof item.id === "string") this.#tools.set(`i${item.id}`, entry);
    const custom = item.type === "custom_tool_call";
    const args = custom
      ? typeof item.input === "string" && item.status === "completed"
        ? JSON.stringify({ input: item.input })
        : ""
      : typeof item.arguments === "string"
        ? item.arguments
        : "";
    if (args) entry.streamed = true;
    return [
      delta({
        tool_calls: [
          {
            index,
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: args },
          },
        ],
      }),
    ];
  }
  /** Output items of a final response that no delta delivered. */
  #fill(response: Chunk): Chunk[] {
    const chunks: Chunk[] = [];
    const output = Array.isArray(response.output) ? response.output : [];
    output.forEach((raw, outputIndex) => {
      const item = record(raw) ?? {};
      if (item.type === "message" && !this.#text) {
        const text = (Array.isArray(item.content) ? item.content : [])
          .map((part) => {
            const value = record(part);
            return typeof value?.text === "string"
              ? value.text
              : typeof value?.refusal === "string"
                ? value.refusal
                : "";
          })
          .join("");
        if (text) chunks.push(delta({ content: text }));
      } else if (item.type === "reasoning") {
        this.#reasoningItem(item, outputIndex);
        if (this.#reasoning) return;
        const text = (Array.isArray(item.summary) ? item.summary : [])
          .map((part) => {
            const value = record(part);
            return typeof value?.text === "string" ? value.text : "";
          })
          .join("\n");
        if (text) chunks.push(delta({ reasoning_content: text }));
        if (typeof item.encrypted_content === "string")
          this.unmapped.add("response.encrypted_reasoning");
      } else if (
        item.type === "function_call" ||
        item.type === "custom_tool_call"
      ) {
        const known =
          this.#tools.get(`o${outputIndex}`) ??
          (typeof item.id === "string"
            ? this.#tools.get(`i${item.id}`)
            : undefined);
        if (!known)
          chunks.push(
            ...this.#tool({ ...item, status: "completed" }, outputIndex),
          );
        else if (!known.streamed) {
          known.streamed = true;
          chunks.push(
            delta({
              tool_calls: [
                {
                  index: known.index,
                  function: {
                    arguments:
                      item.type === "custom_tool_call"
                        ? JSON.stringify({ input: item.input ?? "" })
                        : (item.arguments ?? ""),
                  },
                },
              ],
            }),
          );
        }
      }
    });
    return chunks;
  }
  #final(response: Chunk): Chunk[] {
    const status =
      typeof response.status === "string" ? response.status : "completed";
    const reason = record(response.incomplete_details)?.reason;
    const usage = this.#usage(response.usage);
    return [
      ...this.#fill(response),
      {
        ...delta(
          {},
          responsesFinish(
            status,
            typeof reason === "string" ? reason : undefined,
          ),
        ),
        ...(usage ? { usage } : {}),
      },
    ];
  }
  event(payload: unknown): Chunk[] {
    const value = record(payload);
    if (!value) return [];
    upstreamError(value, "responses");
    const response = record(value.response);
    switch (value.type) {
      case "response.created":
      case "response.in_progress":
        return [
          {
            ...(typeof response?.model === "string"
              ? { model: response.model }
              : {}),
            choices: [],
          },
        ];
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = record(value.item) ?? {};
        if (item.type === "reasoning")
          this.#reasoningItem(item, value.output_index);
        return value.type === "response.output_item.added" &&
          (item.type === "function_call" || item.type === "custom_tool_call")
          ? this.#tool(item, value.output_index)
          : [];
      }
      case "response.output_text.delta":
        this.#text = true;
        return typeof value.delta === "string" && value.delta
          ? [delta({ content: value.delta })]
          : [];
      case "response.refusal.delta":
        this.#text = true;
        return typeof value.delta === "string" && value.delta
          ? [delta({ refusal: value.delta })]
          : [];
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.#reasoning = true;
        return typeof value.delta === "string" && value.delta
          ? [delta({ reasoning_content: value.delta })]
          : [];
      case "response.function_call_arguments.delta": {
        const tool =
          this.#tools.get(`o${String(value.output_index)}`) ??
          this.#tools.get(`i${String(value.item_id)}`);
        if (!tool || typeof value.delta !== "string") return [];
        tool.streamed = true;
        return [
          delta({
            tool_calls: [
              { index: tool.index, function: { arguments: value.delta } },
            ],
          }),
        ];
      }
      case "response.completed":
      case "response.incomplete":
        return response ? this.#final(response) : [];
      default:
        return [];
    }
  }
  body(payload: unknown): Chunk[] {
    const response = record(payload);
    if (!response) return [];
    upstreamError(response, "responses");
    return [
      {
        ...(typeof response.model === "string"
          ? { model: response.model }
          : {}),
        choices: [],
      },
      ...this.#final(response),
    ];
  }
}

class GeminiDecoder implements UpstreamDecoder {
  unmapped = new Set<string>();
  thinking: { text: string; signature?: string }[] = [];
  callSignatures = new Map<number, string>();
  callReasoning = new Map<number, Record<string, unknown>>();
  #tools = 0;

  event(payload: unknown): Chunk[] {
    const value = record(payload);
    if (!value) return [];
    upstreamError(value, "gemini");
    const change: Chunk = {};
    const candidate = record(
      Array.isArray(value.candidates) ? value.candidates[0] : undefined,
    );
    const calls: Chunk[] = [];
    let text = "",
      reasoning = "";
    for (const raw of Array.isArray(record(candidate?.content)?.parts)
      ? (record(candidate?.content)!.parts as unknown[])
      : []) {
      const part = record(raw) ?? {};
      if (typeof part.text === "string") {
        if (part.thought === true) reasoning += part.text;
        else text += part.text;
      } else if (record(part.functionCall)) {
        const call = record(part.functionCall)!;
        const index = this.#tools++;
        if (typeof part.thoughtSignature === "string")
          this.callSignatures.set(index, part.thoughtSignature);
        calls.push({
          index,
          ...(typeof call.id === "string" && call.id ? { id: call.id } : {}),
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(record(call.args) ?? {}),
          },
        });
      } else if (part.inlineData !== undefined || part.fileData !== undefined)
        this.unmapped.add("response.media");
    }
    if (reasoning) change.reasoning_content = reasoning;
    if (text) change.content = text;
    if (calls.length) change.tool_calls = calls;
    const reason =
      candidate?.finishReason ??
      (record(value.promptFeedback)?.blockReason === undefined
        ? undefined
        : "SAFETY");
    const usage = record(value.usageMetadata);
    const prompt = count(usage?.promptTokenCount) ?? 0;
    const thoughts = count(usage?.thoughtsTokenCount) ?? 0;
    const output = (count(usage?.candidatesTokenCount) ?? 0) + thoughts;
    return [
      {
        ...(typeof value.modelVersion === "string"
          ? { model: value.modelVersion }
          : {}),
        ...delta(
          change,
          typeof reason === "string" ? geminiFinish(reason) : null,
        ),
        ...(usage
          ? {
              usage: {
                prompt_tokens: prompt,
                completion_tokens: output,
                total_tokens: count(usage.totalTokenCount) ?? prompt + output,
                prompt_tokens_details: {
                  cached_tokens: count(usage.cachedContentTokenCount) ?? 0,
                },
                completion_tokens_details: { reasoning_tokens: thoughts },
              },
            }
          : {}),
      },
    ];
  }
  body(payload: unknown): Chunk[] {
    return Array.isArray(payload)
      ? payload.flatMap((value) => this.event(value))
      : this.event(payload);
  }
}

/** A fresh decoder for one upstream response of `protocol`. */
export function createDecoder(protocol: EncodedProtocol): UpstreamDecoder {
  switch (protocol) {
    case "anthropic":
      return new AnthropicDecoder();
    case "responses":
      return new ResponsesDecoder();
    case "gemini":
      return new GeminiDecoder();
  }
}
