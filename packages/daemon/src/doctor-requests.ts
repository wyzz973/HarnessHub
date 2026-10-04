// SPDX-License-Identifier: MIT
/**
 * The requests the provider doctor sends (03 section 9), in each endpoint's
 * native form, and what it reads back from a non-streamed answer. Every
 * request is small: a one-word prompt and at most 16 output tokens, except
 * the tool round trip (a short sentence) and the `--deep` context probe.
 */
import type {
  DroppableField,
  WireProtocol,
} from "@harnesshub/core/model-plane";

export const PROMPT = "Reply with the single word OK.";
export const TOOL_PROMPT =
  "Use the get_weather tool to look up the weather in Paris, then answer in one short sentence.";
export const TOOL_NAME = "get_weather";
export const TOOL_RESULT = "Sunny, 21 °C";
/** Starts the `--deep` context probe, so that test upstreams can recognize it. */
export const OVERFLOW_MARKER = "HH-DOCTOR-CONTEXT-PROBE";
const MAX_OUTPUT = 16;
const TOOL_MAX_OUTPUT = 64;
/** A 1×1 white PNG (RGBA), 70 bytes. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";

const SCHEMA = {
  type: "object",
  properties: { city: { type: "string", description: "City name" } },
  required: ["city"],
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

export interface TextOptions {
  stream: boolean;
  /** Chat only: which output limit field to send (default `max_tokens`). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Add a 1×1 PNG to the prompt. */
  image?: boolean;
  /** Replaces the prompt (the context probe). */
  prompt?: string;
  /** Top-level fields added as they are (the optional-field probes). */
  extra?: Json;
}

/** A minimal prompt in the protocol's form. */
export function textBody(
  protocol: WireProtocol,
  wireModel: string,
  options: TextOptions,
): Json {
  const prompt = options.prompt ?? PROMPT;
  const extra = options.extra ?? {};
  switch (protocol) {
    case "chat":
      return {
        model: wireModel,
        messages: [
          {
            role: "user",
            content: options.image
              ? [
                  { type: "text", text: "Describe this image in one word." },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${PNG}` },
                  },
                ]
              : prompt,
          },
        ],
        [options.maxTokensField ?? "max_tokens"]: MAX_OUTPUT,
        stream: options.stream,
        ...extra,
      };
    case "responses":
      return {
        model: wireModel,
        input: [
          {
            role: "user",
            content: options.image
              ? [
                  {
                    type: "input_text",
                    text: "Describe this image in one word.",
                  },
                  {
                    type: "input_image",
                    image_url: `data:image/png;base64,${PNG}`,
                  },
                ]
              : [{ type: "input_text", text: prompt }],
          },
        ],
        max_output_tokens: MAX_OUTPUT,
        stream: options.stream,
        ...extra,
      };
    case "anthropic":
      return {
        model: wireModel,
        max_tokens: MAX_OUTPUT,
        messages: [
          {
            role: "user",
            content: options.image
              ? [
                  { type: "text", text: "Describe this image in one word." },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: "image/png",
                      data: PNG,
                    },
                  },
                ]
              : prompt,
          },
        ],
        stream: options.stream,
        ...extra,
      };
    case "gemini":
      return {
        contents: [
          {
            role: "user",
            parts: options.image
              ? [
                  { text: "Describe this image in one word." },
                  { inlineData: { mimeType: "image/png", data: PNG } },
                ]
              : [{ text: prompt }],
          },
        ],
        generationConfig: { maxOutputTokens: MAX_OUTPUT },
        ...extra,
      };
  }
}

/** The first turn of the tool round trip: one function the prompt asks for. */
export function toolBody(
  protocol: WireProtocol,
  wireModel: string,
  options: {
    maxTokensField?: TextOptions["maxTokensField"];
    extra?: Json;
  } = {},
): Json {
  const description = "Current weather in a city";
  const extra = options.extra ?? {};
  switch (protocol) {
    case "chat":
      return {
        model: wireModel,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [
          {
            type: "function",
            function: { name: TOOL_NAME, description, parameters: SCHEMA },
          },
        ],
        tool_choice: "auto",
        [options.maxTokensField ?? "max_tokens"]: TOOL_MAX_OUTPUT,
        stream: false,
        ...extra,
      };
    case "responses":
      return {
        model: wireModel,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: TOOL_PROMPT }],
          },
        ],
        tools: [
          {
            type: "function",
            name: TOOL_NAME,
            description,
            parameters: SCHEMA,
          },
        ],
        max_output_tokens: TOOL_MAX_OUTPUT,
        stream: false,
        ...extra,
      };
    case "anthropic":
      return {
        model: wireModel,
        max_tokens: TOOL_MAX_OUTPUT,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [{ name: TOOL_NAME, description, input_schema: SCHEMA }],
        stream: false,
        ...extra,
      };
    case "gemini":
      return {
        contents: [{ role: "user", parts: [{ text: TOOL_PROMPT }] }],
        tools: [
          {
            functionDeclarations: [
              { name: TOOL_NAME, description, parameters: SCHEMA },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: TOOL_MAX_OUTPUT },
        ...extra,
      };
  }
}

/** What a non-streamed answer carries, in protocol-neutral form. */
export interface Answer {
  text: string;
  /** Chat's `reasoning_content` (DeepSeek); empty when none. */
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  /** The assistant turn as the protocol returned it, for the next turn. */
  turn: unknown;
}

/** Read a non-streamed answer of `protocol`; unreadable parts are left empty. */
export function answerOf(protocol: WireProtocol, json: unknown): Answer {
  const answer: Answer = {
    text: "",
    reasoning: "",
    toolCalls: [],
    turn: undefined,
  };
  const body = record(json);
  if (!body) return answer;
  switch (protocol) {
    case "chat": {
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const message = record(record(choices[0])?.message);
      if (!message) return answer;
      answer.turn = message;
      if (typeof message.content === "string") answer.text = message.content;
      if (typeof message.reasoning_content === "string")
        answer.reasoning = message.reasoning_content;
      for (const raw of Array.isArray(message.tool_calls)
        ? message.tool_calls
        : []) {
        const call = record(raw);
        const fn = record(call?.function);
        if (typeof call?.id === "string" && typeof fn?.name === "string")
          answer.toolCalls.push({
            id: call.id,
            name: fn.name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
          });
      }
      return answer;
    }
    case "responses": {
      const output = Array.isArray(body.output) ? body.output : [];
      answer.turn = output;
      for (const raw of output) {
        const item = record(raw);
        if (item?.type === "message")
          for (const part of Array.isArray(item.content) ? item.content : [])
            if (typeof record(part)?.text === "string")
              answer.text += record(part)!.text as string;
        if (
          item?.type === "function_call" &&
          typeof item.call_id === "string" &&
          typeof item.name === "string"
        )
          answer.toolCalls.push({
            id: item.call_id,
            name: item.name,
            arguments:
              typeof item.arguments === "string" ? item.arguments : "{}",
          });
      }
      return answer;
    }
    case "anthropic": {
      const content = Array.isArray(body.content) ? body.content : [];
      answer.turn = content;
      for (const raw of content) {
        const block = record(raw);
        if (block?.type === "text" && typeof block.text === "string")
          answer.text += block.text;
        if (
          block?.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        )
          answer.toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
      }
      return answer;
    }
    case "gemini": {
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      const content = record(record(candidates[0])?.content);
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      answer.turn = parts;
      for (const raw of parts) {
        const part = record(raw);
        if (typeof part?.text === "string" && part.thought !== true)
          answer.text += part.text;
        const call = record(part?.functionCall);
        if (typeof call?.name === "string")
          answer.toolCalls.push({
            id: typeof call.id === "string" ? call.id : call.name,
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          });
      }
      return answer;
    }
  }
}

/**
 * The second turn of the tool round trip: the first request, the assistant
 * turn as it was answered, and the tool's result. `reasoning: false` leaves
 * Chat's `reasoning_content` out of the assistant turn (the replay probe).
 */
export function toolResultBody(
  protocol: WireProtocol,
  first: Json,
  answer: Answer,
  options: { reasoning: boolean },
): Json {
  const [call] = answer.toolCalls;
  if (!call) throw new Error("The answer has no tool call");
  switch (protocol) {
    case "chat": {
      const turn = { ...(record(answer.turn) ?? {}) };
      if (!options.reasoning) delete turn.reasoning_content;
      const messages = Array.isArray(first.messages) ? first.messages : [];
      return {
        ...first,
        messages: [
          ...messages,
          { ...turn, role: "assistant" },
          { role: "tool", tool_call_id: call.id, content: TOOL_RESULT },
        ],
      };
    }
    case "responses": {
      const input = Array.isArray(first.input) ? first.input : [];
      const output = Array.isArray(answer.turn) ? answer.turn : [];
      return {
        ...first,
        input: [
          ...input,
          ...output,
          {
            type: "function_call_output",
            call_id: call.id,
            output: TOOL_RESULT,
          },
        ],
      };
    }
    case "anthropic": {
      const messages = Array.isArray(first.messages) ? first.messages : [];
      return {
        ...first,
        messages: [
          ...messages,
          { role: "assistant", content: answer.turn },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: TOOL_RESULT,
              },
            ],
          },
        ],
      };
    }
    case "gemini": {
      const contents = Array.isArray(first.contents) ? first.contents : [];
      return {
        ...first,
        contents: [
          ...contents,
          { role: "model", parts: answer.turn },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: call.name,
                  response: { content: TOOL_RESULT },
                },
              },
            ],
          },
        ],
      };
    }
  }
}

/**
 * Valid values of the optional request fields the `drop-fields` patch can
 * remove, per endpoint that accepts them; each is probed on its own.
 * `stream_options` needs a stream and `parallel_tool_calls` needs tools, so
 * those are added to the streaming and tool requests instead.
 */
export const OPTIONAL_FIELDS: Readonly<
  Partial<Record<WireProtocol, Partial<Record<DroppableField, unknown>>>>
> = {
  chat: {
    store: false,
    metadata: { source: "hh-doctor" },
    service_tier: "auto",
    user: "hh-doctor",
    prompt_cache_key: "hh-doctor",
    prompt_cache_retention: "24h",
    safety_identifier: "hh-doctor",
    stream_options: { include_usage: true },
    parallel_tool_calls: false,
    verbosity: "low",
  },
  responses: {
    store: false,
    metadata: { source: "hh-doctor" },
    service_tier: "auto",
    user: "hh-doctor",
    prompt_cache_key: "hh-doctor",
    prompt_cache_retention: "24h",
    safety_identifier: "hh-doctor",
    parallel_tool_calls: false,
  },
};

/** A prompt longer than `window` tokens: one short word per token, plus a margin. */
export function overflowPrompt(window: number): string {
  return `${OVERFLOW_MARKER} ${"hh ".repeat(window + 2048)}`;
}

/** Tokens a probe body is estimated to cost, for the plan. */
export const ESTIMATE = {
  text: { input: 20, output: MAX_OUTPUT },
  image: { input: 120, output: MAX_OUTPUT },
  tool: { input: 120, output: TOOL_MAX_OUTPUT },
  toolResult: { input: 200, output: TOOL_MAX_OUTPUT },
} as const;
