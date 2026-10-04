// SPDX-License-Identifier: MIT
/**
 * The official SDK of each inbound protocol, driven as an application would:
 * `openai` for Chat Completions and Responses, `@anthropic-ai/sdk` for
 * Messages and `@google/genai` for Gemini, at the versions the root
 * package.json pins. Each conversation keeps its native transcript and
 * sends it back on the next turn, the way agents do, and reads every answer
 * through the SDK's own parsing; the results are reduced to one shape so
 * that the suite compares them across directions.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import OpenAI from "openai";
import type { Protocol } from "./target.js";

/** A function tool offered to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AskOptions {
  stream: boolean;
  /** The user's text; absent when the turn only answers tool calls. */
  text?: string;
  /** A base64 PNG sent with the text. */
  image?: string;
  tools?: ToolSpec[];
  /** Freeform tools (Responses only). */
  customTools?: { name: string; description: string }[];
  /** Ask for visible reasoning where the protocol has a switch for it. */
  reasoning?: boolean;
  maxTokens?: number;
}

export interface ToolCall {
  id: string | undefined;
  name: string;
  /** JSON text of the arguments, or the raw input of a custom tool call. */
  arguments: string;
  custom?: boolean;
}

/** One answer, reduced to what every protocol can say. */
export interface Turn {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  /** `stop`, `length`, `tool_calls`, `content_filter`, or the native value. */
  finish: string;
  /** Total input (cache reads included), cache reads and output tokens. */
  usage?: { input: number; output: number; cached: number };
  /** Milliseconds from sending the request to the first body byte. */
  firstByteMs?: number;
}

export interface Conversation {
  /** Send the user's turn (or, with no text, nothing new) and keep the answer. */
  ask(options: AskOptions): Promise<Turn>;
  /** Send results for the calls of the last answer and keep the next answer. */
  answer(
    results: { call: ToolCall; output: string }[],
    options: AskOptions,
  ): Promise<Turn>;
}

export interface ClientOptions {
  /** The gateway's origin. */
  url: string;
  key: string;
  /** The SDK's own retries (default 0). */
  maxRetries?: number;
}

/** A `fetch` that notes when the first body byte of each response arrived. */
function timedFetch(note: (ms: number) => void): typeof fetch {
  return async (input, init) => {
    const started = performance.now();
    const response = await fetch(input, init);
    if (!response.body) return response;
    let seen = false;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!seen) {
            seen = true;
            note(performance.now() - started);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function finished(turn: Omit<Turn, "firstByteMs">, firstByteMs?: number) {
  return firstByteMs === undefined ? turn : { ...turn, firstByteMs };
}

// --- OpenAI Chat Completions -------------------------------------------------

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

function chatConversation(model: string, options: ClientOptions): Conversation {
  let firstByteMs: number | undefined;
  const client = new OpenAI({
    apiKey: options.key,
    baseURL: `${options.url}/v1`,
    maxRetries: options.maxRetries ?? 0,
    fetch: timedFetch((ms) => (firstByteMs = ms)),
  });
  const messages: ChatMessage[] = [];
  const send = async (ask: AskOptions): Promise<Turn> => {
    firstByteMs = undefined;
    const params = {
      model,
      messages,
      ...(ask.tools?.length
        ? {
            tools: ask.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(ask.maxTokens ? { max_tokens: ask.maxTokens } : {}),
      ...(ask.reasoning ? { reasoning_effort: "medium" as const } : {}),
    };
    let text = "";
    let reasoning = "";
    let finish = "";
    let usage: OpenAI.CompletionUsage | undefined;
    const calls: ToolCall[] = [];
    if (ask.stream) {
      const stream = await client.chat.completions.create({
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices) {
          const delta = choice.delta as typeof choice.delta & {
            reasoning_content?: string | null;
          };
          text += delta.content ?? "";
          reasoning += delta.reasoning_content ?? "";
          for (const call of delta.tool_calls ?? []) {
            const target = (calls[call.index] ??= {
              id: undefined,
              name: "",
              arguments: "",
            });
            if (call.id) target.id = call.id;
            target.name += call.function?.name ?? "";
            target.arguments += call.function?.arguments ?? "";
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } else {
      const completion = await client.chat.completions.create(params);
      const choice = completion.choices[0];
      if (!choice) throw new Error("The completion has no choice");
      const message = choice.message as typeof choice.message & {
        reasoning_content?: string | null;
      };
      text = message.content ?? "";
      reasoning = message.reasoning_content ?? "";
      for (const call of message.tool_calls ?? [])
        if (call.type === "function")
          calls.push({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
      finish = choice.finish_reason;
      usage = completion.usage;
    }
    messages.push({
      role: "assistant",
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id ?? "",
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
      // DeepSeek-style clients send the reasoning of a tool-call turn back.
      ...(reasoning && calls.length ? { reasoning_content: reasoning } : {}),
    } as ChatMessage);
    return finished(
      {
        text,
        reasoning,
        toolCalls: calls,
        finish,
        ...(usage
          ? {
              usage: {
                input: usage.prompt_tokens,
                output: usage.completion_tokens,
                cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
              },
            }
          : {}),
      },
      firstByteMs,
    );
  };
  return {
    ask(ask) {
      if (ask.text !== undefined)
        messages.push({
          role: "user",
          content: ask.image
            ? [
                { type: "text", text: ask.text },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${ask.image}` },
                },
              ]
            : ask.text,
        });
      return send(ask);
    },
    answer(results, ask) {
      for (const { call, output } of results)
        messages.push({
          role: "tool",
          tool_call_id: call.id ?? "",
          content: output,
        });
      return send(ask);
    },
  };
}

// --- OpenAI Responses ------------------------------------------------------------

type ResponsesItem = OpenAI.Responses.ResponseInputItem;
type ResponsesOutput = OpenAI.Responses.ResponseOutputItem;

/**
 * The output items sent back as input on the next turn, as stateless
 * clients (Codex with `store: false`) send them: only the fields input items
 * have.
 */
function replayItems(output: ResponsesOutput[]): ResponsesItem[] {
  const items: ResponsesItem[] = [];
  for (const item of output)
    switch (item.type) {
      case "message":
        items.push({
          type: "message",
          role: "assistant",
          content: item.content.flatMap((part) =>
            part.type === "output_text"
              ? [{ type: "output_text" as const, text: part.text }]
              : [],
          ),
        } as ResponsesItem);
        break;
      case "reasoning":
        items.push({
          type: "reasoning",
          id: item.id,
          summary: item.summary,
          ...(item.encrypted_content
            ? { encrypted_content: item.encrypted_content }
            : {}),
        } as ResponsesItem);
        break;
      case "function_call":
        items.push({
          type: "function_call",
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
        break;
      case "custom_tool_call":
        items.push({
          type: "custom_tool_call",
          call_id: item.call_id,
          name: item.name,
          input: item.input,
        });
        break;
    }
  return items;
}

function responsesTurn(
  response: OpenAI.Responses.Response,
): Omit<Turn, "firstByteMs"> {
  let text = "";
  let reasoning = "";
  const calls: ToolCall[] = [];
  for (const item of response.output)
    if (item.type === "message")
      for (const part of item.content)
        text += part.type === "output_text" ? part.text : "";
    else if (item.type === "reasoning")
      reasoning += item.summary.map((part) => part.text).join("");
    else if (item.type === "function_call")
      calls.push({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    else if (item.type === "custom_tool_call")
      calls.push({
        id: item.call_id,
        name: item.name,
        arguments: item.input,
        custom: true,
      });
  const reason = response.incomplete_details?.reason;
  const finish =
    response.status === "incomplete"
      ? reason === "max_output_tokens"
        ? "length"
        : (reason ?? "incomplete")
      : response.status === "completed"
        ? calls.length
          ? "tool_calls"
          : "stop"
        : String(response.status);
  const usage = response.usage;
  return {
    text,
    reasoning,
    toolCalls: calls,
    finish,
    ...(usage
      ? {
          usage: {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cached: usage.input_tokens_details?.cached_tokens ?? 0,
          },
        }
      : {}),
  };
}

/** A stream that ended in `response.failed` or without a terminal event. */
export class StreamFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StreamFailure";
  }
}

function responsesConversation(
  model: string,
  options: ClientOptions,
): Conversation {
  let firstByteMs: number | undefined;
  const client = new OpenAI({
    apiKey: options.key,
    baseURL: `${options.url}/v1`,
    maxRetries: options.maxRetries ?? 0,
    fetch: timedFetch((ms) => (firstByteMs = ms)),
  });
  const input: ResponsesItem[] = [];
  const send = async (ask: AskOptions): Promise<Turn> => {
    firstByteMs = undefined;
    const tools: OpenAI.Responses.Tool[] = [
      ...(ask.tools ?? []).map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      })),
      ...(ask.customTools ?? []).map((tool) => ({
        type: "custom" as const,
        name: tool.name,
        description: tool.description,
        format: { type: "text" as const },
      })),
    ];
    const params = {
      model,
      input,
      store: false,
      include: ["reasoning.encrypted_content" as const],
      ...(ask.reasoning ? { reasoning: { summary: "auto" as const } } : {}),
      ...(tools.length ? { tools } : {}),
      ...(ask.maxTokens ? { max_output_tokens: ask.maxTokens } : {}),
    };
    let response: OpenAI.Responses.Response | undefined;
    let streamed = "";
    if (ask.stream) {
      const stream = await client.responses.create({ ...params, stream: true });
      for await (const event of stream)
        switch (event.type) {
          case "response.output_text.delta":
            streamed += event.delta;
            break;
          case "response.completed":
          case "response.incomplete":
            response = event.response;
            break;
          case "response.failed":
            throw new StreamFailure(
              event.response.error?.message ?? "response.failed",
              event.response.error?.code,
            );
        }
      if (!response)
        throw new StreamFailure("The stream ended without a terminal event");
    } else response = await client.responses.create(params);
    const turn = responsesTurn(response);
    if (ask.stream && streamed !== turn.text)
      throw new StreamFailure(
        `Streamed text ${JSON.stringify(streamed)} differs from the final response's ${JSON.stringify(turn.text)}`,
      );
    input.push(...replayItems(response.output));
    return finished(turn, firstByteMs);
  };
  return {
    ask(ask) {
      if (ask.text !== undefined)
        input.push({
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: ask.text },
            ...(ask.image
              ? [
                  {
                    type: "input_image" as const,
                    image_url: `data:image/png;base64,${ask.image}`,
                    detail: "auto" as const,
                  },
                ]
              : []),
          ],
        });
      return send(ask);
    },
    answer(results, ask) {
      for (const { call, output } of results)
        input.push(
          call.custom
            ? {
                type: "custom_tool_call_output",
                call_id: call.id ?? "",
                output,
              }
            : { type: "function_call_output", call_id: call.id ?? "", output },
        );
      return send(ask);
    },
  };
}

// --- Anthropic Messages -------------------------------------------------------------

const ANTHROPIC_FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

function anthropicConversation(
  model: string,
  options: ClientOptions,
): Conversation {
  let firstByteMs: number | undefined;
  const client = new Anthropic({
    apiKey: options.key,
    baseURL: options.url,
    maxRetries: options.maxRetries ?? 0,
    fetch: timedFetch((ms) => (firstByteMs = ms)),
  });
  const messages: Anthropic.MessageParam[] = [];
  const send = async (ask: AskOptions): Promise<Turn> => {
    firstByteMs = undefined;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: ask.maxTokens ?? 4096,
      messages,
      ...(ask.tools?.length
        ? {
            tools: ask.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      ...(ask.reasoning
        ? { thinking: { type: "enabled", budget_tokens: 1024 } }
        : {}),
    };
    const message = ask.stream
      ? await client.messages.stream(params).finalMessage()
      : await client.messages.create(params);
    messages.push({ role: "assistant", content: message.content });
    let text = "";
    let reasoning = "";
    const calls: ToolCall[] = [];
    for (const block of message.content)
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") reasoning += block.thinking;
      else if (block.type === "tool_use")
        calls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
    const usage = message.usage;
    const cached = usage.cache_read_input_tokens ?? 0;
    return finished(
      {
        text,
        reasoning,
        toolCalls: calls,
        finish:
          ANTHROPIC_FINISH[message.stop_reason ?? ""] ??
          String(message.stop_reason),
        usage: {
          input:
            usage.input_tokens +
            cached +
            (usage.cache_creation_input_tokens ?? 0),
          output: usage.output_tokens,
          cached,
        },
      },
      firstByteMs,
    );
  };
  return {
    ask(ask) {
      if (ask.text !== undefined)
        messages.push({
          role: "user",
          content: ask.image
            ? [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: ask.image,
                  },
                },
                { type: "text", text: ask.text },
              ]
            : ask.text,
        });
      return send(ask);
    },
    answer(results, ask) {
      messages.push({
        role: "user",
        content: results.map(({ call, output }) => ({
          type: "tool_result" as const,
          tool_use_id: call.id ?? "",
          content: output,
        })),
      });
      return send(ask);
    },
  };
}

// --- Gemini -----------------------------------------------------------------------

const GEMINI_FINISH: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
};

function geminiConversation(
  model: string,
  options: ClientOptions,
): Conversation {
  let firstByteMs: number | undefined;
  const client = new GoogleGenAI({
    apiKey: options.key,
    httpOptions: {
      baseUrl: options.url,
      fetch: timedFetch((ms) => (firstByteMs = ms)),
    },
  });
  const contents: Content[] = [];
  const send = async (ask: AskOptions): Promise<Turn> => {
    firstByteMs = undefined;
    const request = {
      model,
      contents,
      config: {
        ...(ask.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: ask.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.parameters,
                  })),
                },
              ],
            }
          : {}),
        ...(ask.reasoning ? { thinkingConfig: { includeThoughts: true } } : {}),
        ...(ask.maxTokens ? { maxOutputTokens: ask.maxTokens } : {}),
      },
    };
    const parts: Part[] = [];
    let finishReason: string | undefined;
    let usage:
      | {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
          cachedContentTokenCount?: number;
        }
      | undefined;
    const take = (
      chunk: Awaited<ReturnType<typeof client.models.generateContent>>,
    ) => {
      const candidate = chunk.candidates?.[0];
      parts.push(...(candidate?.content?.parts ?? []));
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    };
    if (ask.stream)
      for await (const chunk of await client.models.generateContentStream(
        request,
      ))
        take(chunk);
    else take(await client.models.generateContent(request));
    contents.push({ role: "model", parts });
    let text = "";
    let reasoning = "";
    const calls: ToolCall[] = [];
    for (const part of parts)
      if (part.functionCall)
        calls.push({
          id: part.functionCall.id,
          name: part.functionCall.name ?? "",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      else if (part.thought) reasoning += part.text ?? "";
      else text += part.text ?? "";
    const native = GEMINI_FINISH[finishReason ?? ""];
    return finished(
      {
        text,
        reasoning,
        toolCalls: calls,
        finish:
          native === "stop" && calls.length
            ? "tool_calls"
            : (native ?? String(finishReason)),
        ...(usage
          ? {
              usage: {
                input: usage.promptTokenCount ?? 0,
                output:
                  (usage.candidatesTokenCount ?? 0) +
                  (usage.thoughtsTokenCount ?? 0),
                cached: usage.cachedContentTokenCount ?? 0,
              },
            }
          : {}),
      },
      firstByteMs,
    );
  };
  return {
    ask(ask) {
      if (ask.text !== undefined)
        contents.push({
          role: "user",
          parts: [
            { text: ask.text },
            ...(ask.image
              ? [{ inlineData: { mimeType: "image/png", data: ask.image } }]
              : []),
          ],
        });
      return send(ask);
    },
    answer(results, ask) {
      contents.push({
        role: "user",
        parts: results.map(({ call, output }) => ({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: { output },
          },
        })),
      });
      return send(ask);
    },
  };
}

/** A new conversation with `model` through the gateway in `protocol`. */
export function conversation(
  protocol: Protocol,
  model: string,
  options: ClientOptions,
): Conversation {
  switch (protocol) {
    case "chat":
      return chatConversation(model, options);
    case "responses":
      return responsesConversation(model, options);
    case "anthropic":
      return anthropicConversation(model, options);
    case "gemini":
      return geminiConversation(model, options);
  }
}

/** What a failed call looked like to the client. */
export interface ClientFailure {
  /** The SDK's error class. */
  type: string;
  /**
   * Whether the SDK reported an API error (its API error classes, or a
   * Responses stream that failed); false for a transport or parse error.
   */
  api: boolean;
  status: number | undefined;
  /** The error's `code` where the protocol has one (OpenAI, Responses streams). */
  code: string | null | undefined;
  message: string;
  /** The response's Retry-After header, when the SDK exposes headers. */
  retryAfter: string | null | undefined;
}

/**
 * Reduce an error a client call threw: an SDK's API error with its status,
 * or any other error (a broken stream, StreamFailure) by its class.
 * Non-errors are rethrown.
 */
export function failureOf(error: unknown): ClientFailure {
  if (error instanceof OpenAI.APIError)
    return {
      type: error.constructor.name,
      api: true,
      status: error.status,
      code: error.code,
      message: error.message,
      retryAfter: error.headers?.get("retry-after"),
    };
  if (error instanceof Anthropic.APIError)
    return {
      type: error.constructor.name,
      api: true,
      status: error.status,
      code: undefined,
      message: error.message,
      retryAfter: error.headers?.get("retry-after"),
    };
  if (error instanceof ApiError)
    return {
      type: "ApiError",
      api: true,
      status: error.status,
      code: undefined,
      message: error.message,
      retryAfter: undefined,
    };
  if (error instanceof Error)
    return {
      type: error.constructor.name,
      api: error instanceof StreamFailure,
      status: undefined,
      code: error instanceof StreamFailure ? error.code : undefined,
      message: error.message,
      retryAfter: undefined,
    };
  throw error;
}
