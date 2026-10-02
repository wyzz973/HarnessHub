// SPDX-License-Identifier: MIT
/**
 * Encoders from the normalized Chat request, the gateway's pivot, to the
 * request bodies of the other upstream protocols: Anthropic Messages, OpenAI
 * Responses and Gemini generateContent. Each encoder reports what the target
 * cannot carry (`unmapped`) and what it adjusted (`patches`), so the ledger
 * shows every semantic change. They are shaped as the build edges of the
 * future IR (03 section 3): pure functions of one request.
 */
import type { ProviderModel } from "@harnesshub/core/model-plane";
import {
  parseArguments,
  record,
  type ChatTranslation,
  type ReasoningRequest,
} from "./protocol.js";

export type EncodedProtocol = "anthropic" | "responses" | "gemini";

/** What an encoder needs besides the Chat body. */
export interface EncodeContext {
  /** The inbound translation: reasoning request and tool errors. */
  translation: ChatTranslation;
  /** Metadata of the target model, when the provider lists it. */
  model: ProviderModel | undefined;
  /**
   * The same provider's signature for a thinking text (Anthropic) or for a
   * tool call id (Gemini `thoughtSignature`), when one is known.
   */
  signature?(kind: "thinking" | "call", key: string): string | undefined;
}

/** An upstream request body with the record of what changed on the way. */
export interface Encoded {
  body: Record<string, unknown>;
  /** Request fields or content kinds the upstream protocol cannot carry; they were dropped. */
  unmapped: string[];
  /** Values the gateway supplied or settings it turned off. */
  patches: string[];
}

/** `max_tokens` sent to Anthropic when neither the request nor the model names one; every Claude model accepts it. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * The one resolver of Anthropic's required `max_tokens`: the request's limit,
 * else the model's `maxOutputTokens`, else {@link ANTHROPIC_DEFAULT_MAX_TOKENS}.
 */
export function anthropicMaxTokens(
  requested: number | undefined,
  model: ProviderModel | undefined,
): { value: number; source: "request" | "model" | "default" } {
  if (requested !== undefined) return { value: requested, source: "request" };
  if (model?.maxOutputTokens !== undefined)
    return { value: model.maxOutputTokens, source: "model" };
  return { value: ANTHROPIC_DEFAULT_MAX_TOKENS, source: "default" };
}

const EFFORT_BUDGET: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16_384,
  xhigh: 32_768,
};
function budgetOf(reasoning: ReasoningRequest): number {
  return (
    reasoning.budgetTokens ??
    EFFORT_BUDGET[reasoning.effort ?? "medium"] ??
    EFFORT_BUDGET.medium!
  );
}
function effortOf(reasoning: ReasoningRequest): string {
  if (reasoning.effort) return reasoning.effort;
  const budget = budgetOf(reasoning);
  return budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high";
}

type Piece = { kind: "text"; text: string } | { kind: "image"; url: string };

/** Text and image pieces of normalized Chat content (string, null or parts). */
function pieces(content: unknown): Piece[] {
  if (typeof content === "string")
    return content ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const result: Piece[] = [];
  for (const raw of content) {
    const part = record(raw);
    if (part?.type === "text" && typeof part.text === "string") {
      if (part.text) result.push({ kind: "text", text: part.text });
    } else if (part?.type === "image_url") {
      const url = record(part.image_url)?.url;
      if (typeof url === "string") result.push({ kind: "image", url });
    }
  }
  return result;
}
function plainText(content: unknown): string {
  return pieces(content)
    .flatMap((piece) => (piece.kind === "text" ? [piece.text] : []))
    .join("\n");
}
/** `data:<type>;base64,<data>` split, or undefined for other URLs. */
function dataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined;
}

interface ChatCall {
  id: string;
  name: string;
  arguments: string;
}
function toolCalls(message: Record<string, unknown>): ChatCall[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.flatMap((raw) => {
    const call = record(raw);
    const fn = record(call?.function);
    if (!call || typeof fn?.name !== "string") return [];
    return [
      {
        id: typeof call.id === "string" ? call.id : "",
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      },
    ];
  });
}
interface ChatTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}
function chatTools(chat: Record<string, unknown>): ChatTool[] {
  if (!Array.isArray(chat.tools)) return [];
  return chat.tools.flatMap((raw) => {
    const fn = record(record(raw)?.function);
    if (typeof fn?.name !== "string") return [];
    return [
      {
        name: fn.name,
        ...(typeof fn.description === "string" && fn.description
          ? { description: fn.description }
          : {}),
        parameters: record(fn.parameters) ?? {
          type: "object",
          properties: {},
        },
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      },
    ];
  });
}
/** `auto`, `none`, `required` or a named function. */
function toolChoice(
  value: unknown,
): "auto" | "none" | "required" | { name: string } | undefined {
  if (value === "auto" || value === "none" || value === "required")
    return value;
  const name = record(record(value)?.function)?.name;
  return typeof name === "string" ? { name } : undefined;
}
function stops(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return Array.isArray(value)
    ? value.filter((stop): stop is string => typeof stop === "string")
    : [];
}
function outputLimit(chat: Record<string, unknown>): number | undefined {
  const value = chat.max_completion_tokens ?? chat.max_tokens;
  return typeof value === "number" ? value : undefined;
}
function system(chat: Record<string, unknown>): string {
  const first = record(
    Array.isArray(chat.messages) ? chat.messages[0] : undefined,
  );
  return first?.role === "system" ? plainText(first.content) : "";
}
function messages(chat: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(chat.messages) ? chat.messages : []).flatMap((raw) => {
    const message = record(raw);
    return message && message.role !== "system" ? [message] : [];
  });
}
/** Chat fields the encoder did not use, recorded as unmapped. */
function leftovers(
  chat: Record<string, unknown>,
  used: readonly string[],
  unmapped: Set<string>,
): void {
  const handled = new Set([
    "model",
    "messages",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "tools",
    "tool_choice",
    "reasoning_effort",
    ...used,
  ]);
  for (const key of Object.keys(chat))
    if (!handled.has(key) && chat[key] !== undefined && chat[key] !== null)
      unmapped.add(key);
}

// ---------------------------------------------------------------- Anthropic

function anthropicImage(url: string): Record<string, unknown> {
  const inline = dataUrl(url);
  return inline
    ? {
        type: "image",
        source: {
          type: "base64",
          media_type: inline.mediaType,
          data: inline.data,
        },
      }
    : { type: "image", source: { type: "url", url } };
}

/**
 * Chat to Anthropic Messages. The leading system message becomes `system`;
 * tool results become `tool_result` blocks of a user turn (`is_error` from
 * the translation's tool errors); `max_tokens` comes from
 * {@link anthropicMaxTokens}. History reasoning is sent as a `thinking`
 * block only with the same provider's signature, otherwise it is dropped. A
 * reasoning request enables thinking unless the open tool turn's assistant
 * message lacks a signed thinking block, which Anthropic would reject.
 */
function toAnthropic(
  chat: Record<string, unknown>,
  context: EncodeContext,
): Encoded {
  const unmapped = new Set<string>();
  const patches: string[] = [];
  const errors = context.translation.toolErrors;
  const turns: {
    role: "user" | "assistant";
    content: Record<string, unknown>[];
  }[] = [];
  const push = (
    role: "user" | "assistant",
    blocks: Record<string, unknown>[],
  ) => {
    if (!blocks.length) return;
    const last = turns.at(-1);
    const results = blocks.some((block) => block.type === "tool_result");
    // tool_result blocks must lead their user turn.
    const mergeable =
      last?.role === role &&
      (!results || last.content.every((block) => block.type === "tool_result"));
    if (last && mergeable) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const message of messages(chat)) {
    if (message.role === "user")
      push(
        "user",
        pieces(message.content).map((piece) =>
          piece.kind === "text"
            ? { type: "text", text: piece.text }
            : anthropicImage(piece.url),
        ),
      );
    else if (message.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        const signature = context.signature?.("thinking", reasoning);
        if (signature)
          blocks.push({ type: "thinking", thinking: reasoning, signature });
        else unmapped.add("reasoning");
      }
      const text = plainText(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of toolCalls(message)) {
        const input = parseArguments(call.arguments);
        if (!input) unmapped.add("tool_call.arguments");
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: input ?? {},
        });
      }
      push("assistant", blocks);
    } else if (message.role === "tool") {
      const id =
        typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      if (pieces(message.content).some((piece) => piece.kind === "image"))
        unmapped.add("tool_result.image");
      push("user", [
        {
          type: "tool_result",
          tool_use_id: id,
          content: plainText(message.content),
          ...(errors?.has(id) ? { is_error: true } : {}),
        },
      ]);
    } else unmapped.add(`message.${String(message.role)}`);
  }
  const limit = anthropicMaxTokens(outputLimit(chat), context.model);
  if (limit.source !== "request") patches.push(`max_tokens:${limit.source}`);
  const body: Record<string, unknown> = {
    model: chat.model,
    max_tokens: limit.value,
    messages: turns,
    stream: true,
  };
  const instructions = system(chat);
  if (instructions) body.system = instructions;
  if (typeof chat.temperature === "number") {
    body.temperature = Math.min(chat.temperature, 1);
    if (chat.temperature > 1) patches.push("temperature:clamped");
  }
  if (typeof chat.top_p === "number") body.top_p = chat.top_p;
  const stop = stops(chat.stop);
  if (stop.length) body.stop_sequences = stop;
  if (typeof chat.user === "string") body.metadata = { user_id: chat.user };
  const tools = chatTools(chat);
  if (tools.length)
    body.tools = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }));
  if (tools.some((tool) => tool.strict !== undefined))
    unmapped.add("tools.strict");
  const choice = toolChoice(chat.tool_choice);
  let anthropicChoice: Record<string, unknown> | undefined =
    choice === undefined
      ? undefined
      : choice === "auto"
        ? { type: "auto" }
        : choice === "none"
          ? { type: "none" }
          : choice === "required"
            ? { type: "any" }
            : { type: "tool", name: choice.name };
  if (chat.parallel_tool_calls === false && tools.length)
    anthropicChoice = {
      type: "auto",
      ...anthropicChoice,
      disable_parallel_tool_use: true,
    };
  const reasoning = context.translation.reasoning;
  if (reasoning && !reasoning.off) {
    const lastTurn = turns.at(-1);
    const lastAssistant = turns.findLast((turn) => turn.role === "assistant");
    const openToolTurn =
      lastTurn?.role === "user" &&
      lastTurn.content.some((block) => block.type === "tool_result");
    if (limit.value <= 1024) patches.push("thinking:off:max_tokens");
    else if (
      openToolTurn &&
      lastAssistant &&
      lastAssistant.content[0]?.type !== "thinking"
    )
      patches.push("thinking:off:unsigned_history");
    else {
      body.thinking = {
        type: "enabled",
        budget_tokens: Math.min(
          Math.max(budgetOf(reasoning), 1024),
          limit.value - 1,
        ),
      };
      // Anthropic rejects sampling changes and forced tools with thinking.
      for (const key of ["temperature", "top_p"])
        if (key in body) {
          delete body[key];
          patches.push(`${key}:dropped:thinking`);
        }
      if (anthropicChoice?.type === "any" || anthropicChoice?.type === "tool") {
        anthropicChoice = { ...anthropicChoice, type: "auto" };
        delete anthropicChoice.name;
        patches.push("tool_choice:auto:thinking");
      }
    }
  }
  if (anthropicChoice) body.tool_choice = anthropicChoice;
  leftovers(
    chat,
    ["temperature", "top_p", "stop", "user", "parallel_tool_calls"],
    unmapped,
  );
  return { body, unmapped: [...unmapped], patches };
}

// ---------------------------------------------------------------- Responses

/**
 * Chat to a stateless Responses request (`store: false`, streamed). The
 * system message becomes `instructions`; assistant tool calls and tool
 * results become `function_call` and `function_call_output` items. Function
 * tools are sent with `strict: false` unless the Chat tool asked for strict
 * schemas. History reasoning cannot be replayed without the provider's
 * encrypted content and is dropped.
 */
function toResponses(
  chat: Record<string, unknown>,
  context: EncodeContext,
): Encoded {
  const unmapped = new Set<string>();
  const patches: string[] = [];
  const input: Record<string, unknown>[] = [];
  for (const message of messages(chat)) {
    if (message.role === "user") {
      const content = pieces(message.content).map((piece) =>
        piece.kind === "text"
          ? { type: "input_text", text: piece.text }
          : { type: "input_image", image_url: piece.url },
      );
      if (content.length)
        input.push({ type: "message", role: "user", content });
    } else if (message.role === "assistant") {
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === "string" && reasoning) unmapped.add("reasoning");
      const text = plainText(message.content);
      if (text)
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      for (const call of toolCalls(message))
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments || "{}",
        });
    } else if (message.role === "tool") {
      const id =
        typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      if (context.translation.toolErrors?.has(id))
        unmapped.add("tool_result.is_error");
      input.push({
        type: "function_call_output",
        call_id: id,
        output: plainText(message.content),
      });
    } else unmapped.add(`message.${String(message.role)}`);
  }
  const body: Record<string, unknown> = {
    model: chat.model,
    input,
    stream: true,
    store: false,
  };
  const instructions = system(chat);
  if (instructions) body.instructions = instructions;
  const limit = outputLimit(chat);
  if (limit !== undefined) body.max_output_tokens = limit;
  for (const key of ["temperature", "top_p", "parallel_tool_calls", "user"])
    if (chat[key] !== undefined && chat[key] !== null) body[key] = chat[key];
  const tools = chatTools(chat);
  if (tools.length)
    body.tools = tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
      strict: tool.strict === true,
    }));
  const choice = toolChoice(chat.tool_choice);
  if (choice !== undefined)
    body.tool_choice =
      typeof choice === "string"
        ? choice
        : { type: "function", name: choice.name };
  const format = record(chat.response_format);
  if (format?.type === "json_object")
    body.text = { format: { type: "json_object" } };
  else if (format?.type === "json_schema") {
    const schema = record(format.json_schema) ?? {};
    body.text = {
      format: {
        type: "json_schema",
        name: typeof schema.name === "string" ? schema.name : "response",
        schema: schema.schema ?? {},
        ...(typeof schema.strict === "boolean"
          ? { strict: schema.strict }
          : {}),
      },
    };
  }
  const reasoning = context.translation.reasoning;
  if (reasoning && !reasoning.off)
    body.reasoning = { effort: effortOf(reasoning), summary: "auto" };
  if (stops(chat.stop).length) unmapped.add("stop");
  leftovers(
    chat,
    [
      "temperature",
      "top_p",
      "parallel_tool_calls",
      "user",
      "response_format",
      "stop",
    ],
    unmapped,
  );
  return { body, unmapped: [...unmapped], patches };
}

// ---------------------------------------------------------------- Gemini

/** Schema keywords Gemini's function declarations and response schemas accept. */
const GEMINI_SCHEMA = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

/**
 * A JSON Schema restricted to the subset Gemini accepts: type unions with
 * `null` become `nullable`, `const` a one-value enum, `oneOf` `anyOf`, types
 * are upper case; every other keyword is dropped and named in `dropped`.
 */
export function geminiSchema(value: unknown, dropped: Set<string>): unknown {
  if (Array.isArray(value))
    return value.map((item) => geminiSchema(item, dropped));
  const schema = record(value);
  if (!schema) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(schema)) {
    switch (key) {
      case "type": {
        const types = (Array.isArray(entry) ? entry : [entry]).filter(
          (type): type is string => typeof type === "string",
        );
        const concrete = types.filter((type) => type !== "null");
        if (concrete.length < types.length) result.nullable = true;
        if (concrete.length > 1) dropped.add("type[]");
        if (concrete[0]) result.type = concrete[0].toUpperCase();
        break;
      }
      case "const":
        result.enum = [String(entry)];
        break;
      case "oneOf":
      case "anyOf":
        result.anyOf = geminiSchema(entry, dropped);
        break;
      case "properties": {
        const properties = record(entry) ?? {};
        result.properties = Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [
            name,
            geminiSchema(property, dropped),
          ]),
        );
        break;
      }
      case "items":
        result.items = geminiSchema(entry, dropped);
        break;
      case "enum":
        result.enum = Array.isArray(entry) ? entry.map(String) : entry;
        break;
      default:
        if (GEMINI_SCHEMA.has(key)) result[key] = entry;
        else dropped.add(key);
    }
  }
  return result;
}

/**
 * Chat to Gemini generateContent (the model goes in the URL). The system
 * message becomes `systemInstruction`, tools `functionDeclarations` with
 * restricted schemas, tool results `functionResponse` parts named after the
 * call they answer (`{error}` for tool errors). Base64 images become
 * `inlineData`; image URLs and history reasoning cannot be sent and are
 * dropped.
 */
function toGemini(
  chat: Record<string, unknown>,
  context: EncodeContext,
): Encoded {
  const unmapped = new Set<string>();
  const patches: string[] = [];
  const dropped = new Set<string>();
  const contents: {
    role: "user" | "model";
    parts: Record<string, unknown>[];
  }[] = [];
  const push = (role: "user" | "model", parts: Record<string, unknown>[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const names = new Map<string, string>();
  for (const message of messages(chat)) {
    if (message.role === "user")
      push(
        "user",
        pieces(message.content).flatMap((piece): Record<string, unknown>[] => {
          if (piece.kind === "text") return [{ text: piece.text }];
          const inline = dataUrl(piece.url);
          if (inline)
            return [
              { inlineData: { mimeType: inline.mediaType, data: inline.data } },
            ];
          unmapped.add("image_url");
          return [];
        }),
      );
    else if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === "string" && reasoning) unmapped.add("reasoning");
      const text = plainText(message.content);
      if (text) parts.push({ text });
      for (const call of toolCalls(message)) {
        names.set(call.id, call.name);
        const args = parseArguments(call.arguments);
        if (!args) unmapped.add("tool_call.arguments");
        // Gemini requires its own thought signature back on function call turns.
        const signature = context.signature?.("call", call.id);
        parts.push({
          functionCall: { name: call.name, args: args ?? {} },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
      push("model", parts);
    } else if (message.role === "tool") {
      const id =
        typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const name = names.get(id);
      if (!name) {
        unmapped.add("tool_result.unmatched");
        continue;
      }
      const text = plainText(message.content);
      const parsed = parseArguments(text);
      const response = context.translation.toolErrors?.has(id)
        ? { error: text }
        : parsed && text.trim()
          ? parsed
          : { output: text };
      push("user", [{ functionResponse: { name, response } }]);
    } else unmapped.add(`message.${String(message.role)}`);
  }
  const body: Record<string, unknown> = { contents };
  const instructions = system(chat);
  if (instructions)
    body.systemInstruction = { parts: [{ text: instructions }] };
  const tools = chatTools(chat);
  if (tools.length)
    body.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: geminiSchema(tool.parameters, dropped),
        })),
      },
    ];
  const choice = toolChoice(chat.tool_choice);
  if (choice !== undefined)
    body.toolConfig = {
      functionCallingConfig:
        typeof choice === "string"
          ? { mode: { auto: "AUTO", none: "NONE", required: "ANY" }[choice] }
          : { mode: "ANY", allowedFunctionNames: [choice.name] },
    };
  const generation: Record<string, unknown> = {};
  const limit = outputLimit(chat);
  if (limit !== undefined) generation.maxOutputTokens = limit;
  for (const [from, to] of [
    ["temperature", "temperature"],
    ["top_p", "topP"],
    ["presence_penalty", "presencePenalty"],
    ["frequency_penalty", "frequencyPenalty"],
    ["seed", "seed"],
  ] as const)
    if (typeof chat[from] === "number") generation[to] = chat[from];
  const stop = stops(chat.stop);
  if (stop.length) generation.stopSequences = stop;
  const format = record(chat.response_format);
  if (format?.type === "json_object" || format?.type === "json_schema") {
    generation.responseMimeType = "application/json";
    const schema = record(format.json_schema)?.schema;
    if (format.type === "json_schema" && schema !== undefined)
      generation.responseSchema = geminiSchema(schema, dropped);
  }
  const reasoning = context.translation.reasoning;
  if (reasoning)
    generation.thinkingConfig = reasoning.off
      ? { thinkingBudget: 0 }
      : { includeThoughts: true, thinkingBudget: budgetOf(reasoning) };
  if (Object.keys(generation).length) body.generationConfig = generation;
  for (const keyword of dropped) unmapped.add(`schema.${keyword}`);
  if (chat.parallel_tool_calls !== undefined)
    unmapped.add("parallel_tool_calls");
  leftovers(
    chat,
    [
      "temperature",
      "top_p",
      "presence_penalty",
      "frequency_penalty",
      "seed",
      "stop",
      "response_format",
      "parallel_tool_calls",
    ],
    unmapped,
  );
  return { body, unmapped: [...unmapped], patches };
}

/** Encode a normalized Chat request for a non-Chat upstream protocol. */
export function encodeRequest(
  protocol: EncodedProtocol,
  chat: Record<string, unknown>,
  context: EncodeContext,
): Encoded {
  switch (protocol) {
    case "anthropic":
      return toAnthropic(chat, context);
    case "responses":
      return toResponses(chat, context);
    case "gemini":
      return toGemini(chat, context);
  }
}
