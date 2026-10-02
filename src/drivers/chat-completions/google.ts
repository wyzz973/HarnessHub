import {
  GatewayError,
  array,
  boundedNumber,
  multimodal,
  omittedMedia,
  nativeTool,
  object,
  record,
  string,
  toolAlias,
  type ChatResult,
  type ChatTranslation,
  type ToolBinding,
} from "./protocol.js";
import type { Failure, HttpWriter, OutputSink, SinkContext } from "./output.js";
import { decodeReasoning, encodeReasoning } from "./reasoning.js";
import { contextNumbers, truncateText } from "./upstream.js";

/** Every top-level field the @google/genai request builder sends to the Gemini API. */
const FIELDS = new Set([
  "model",
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "generationConfig",
  "safetySettings",
  "cachedContent",
  "labels",
]);

function googleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(googleSchema);
  const source = record(value);
  if (!source) return value;
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(source)) {
    if (name === "propertyOrdering") continue;
    if (name === "type" && typeof entry === "string")
      result.type = entry.toLowerCase();
    else result[name] = googleSchema(entry);
  }
  return result;
}
function partsText(value: unknown): string {
  if (typeof value === "string") return value;
  const content = object(value);
  return array(content.parts)
    .map((raw) => {
      const part = object(raw);
      if (typeof part.text !== "string")
        throw new GatewayError("systemInstruction accepts text parts only");
      return part.text;
    })
    .join("\n");
}
/** Gemini CLI prefixes call ids with `<tool name>__`; the upstream id is restored. */
function upstreamId(id: unknown, name: string): string | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return id.startsWith(`${name}__`) ? id.slice(name.length + 2) : id;
}
function toolContent(response: Record<string, unknown>): string {
  const keys = Object.keys(response);
  return keys.length === 1 && typeof response.output === "string"
    ? response.output
    : JSON.stringify(response);
}

/**
 * Translate a Gemini GenerateContent request to Chat: text, thought parts
 * and our thought signatures (as reasoning), functionCall/functionResponse,
 * function declarations, tool config and generation settings. Hosted Google
 * tools and cached content fail explicitly; media parts become text
 * placeholders; Google-only
 * hints (safety settings, topK, labels) are ignored.
 */
export function googleToChat(
  raw: unknown,
  requestedModel: string,
  stream: boolean,
): ChatTranslation {
  const request = object(raw);
  for (const key of Object.keys(request))
    if (!FIELDS.has(key))
      throw new GatewayError(
        `Unsupported Google generation request field: ${key.slice(0, 64)}`,
      );
  if (request.cachedContent)
    throw new GatewayError(
      "Google cached content is unsupported by the model gateway",
    );
  const messages: Record<string, unknown>[] = [];
  const bindings = new Map<string, ToolBinding>();
  if (request.systemInstruction !== undefined && request.systemInstruction) {
    const system = partsText(request.systemInstruction);
    if (system) messages.push({ role: "system", content: system });
  }
  let generated = 0;
  const pending: { id: string; name: string }[] = [];
  for (const rawContent of array(request.contents)) {
    const content = object(rawContent);
    const role = content.role ?? "user";
    if (role !== "user" && role !== "model" && role !== "function")
      throw new GatewayError("Unsupported Google content role");
    const texts: string[] = [],
      thoughts: string[] = [],
      calls: Record<string, unknown>[] = [],
      results: Record<string, unknown>[] = [];
    let signed: string | undefined;
    for (const rawPart of array(content.parts)) {
      const part = object(rawPart);
      signed ??= decodeReasoning(part.thoughtSignature);
      if (typeof part.text === "string") {
        if (part.thought === true) {
          if (role === "model") thoughts.push(part.text);
        } else texts.push(part.text);
      } else if (part.functionCall) {
        if (role !== "model")
          throw new GatewayError("Function call requires model role");
        const call = object(part.functionCall),
          name = string(call.name),
          id = upstreamId(call.id, name) ?? `gcall_${generated++}`;
        pending.push({ id, name });
        calls.push({
          id,
          type: "function",
          function: {
            name: toolAlias(name),
            arguments: JSON.stringify(
              call.args === undefined || call.args === null
                ? {}
                : object(call.args),
            ),
          },
        });
      } else if (part.functionResponse) {
        const answer = object(part.functionResponse),
          name = string(answer.name);
        const omitted =
          Array.isArray(answer.parts) && answer.parts.length
            ? `\n${omittedMedia("Function response media")}`
            : "";
        const wanted = upstreamId(answer.id, name);
        const index = pending.findIndex(
          (call) =>
            call.name === name && (wanted === undefined || wanted === call.id),
        );
        if (index < 0)
          throw new GatewayError(
            "Google function response has no matching call",
          );
        const [call] = pending.splice(index, 1);
        results.push({
          role: "tool",
          tool_call_id: call!.id,
          content:
            toolContent(
              answer.response === undefined || answer.response === null
                ? {}
                : object(answer.response),
            ) + omitted,
        });
      } else if (part.inlineData || part.fileData)
        texts.push(omittedMedia("Google inline or file data"));
      else if (part.thought === true || part.thoughtSignature !== undefined)
        continue;
      else
        throw new GatewayError(
          "The model gateway supports Google text and function parts only",
        );
    }
    if (role !== "model") {
      messages.push(...results);
      if (texts.length)
        messages.push({ role: "user", content: texts.join("") });
      continue;
    }
    if (!texts.length && !calls.length && !thoughts.length) continue;
    const assistant: Record<string, unknown> = {
      role: "assistant",
      content: texts.length ? texts.join("") : calls.length ? null : "",
    };
    if (calls.length) assistant.tool_calls = calls;
    const reasoning = thoughts.length ? thoughts.join("") : signed;
    if (reasoning) assistant.reasoning_content = reasoning;
    messages.push(assistant);
  }
  let tools: Record<string, unknown>[] = [];
  for (const rawTool of request.tools === undefined || request.tools === null
    ? []
    : array(request.tools)) {
    const tool = object(rawTool);
    if (Object.keys(tool).some((key) => key !== "functionDeclarations"))
      throw new GatewayError(
        "Google hosted tools are unsupported; use function declarations",
      );
    for (const rawFunction of array(tool.functionDeclarations)) {
      const fn = object(rawFunction),
        name = string(fn.name),
        mapped = toolAlias(name);
      if (bindings.has(mapped))
        throw new GatewayError("Duplicate Google tool name");
      bindings.set(mapped, { name, custom: false });
      tools.push({
        type: "function",
        function: {
          name: mapped,
          ...(typeof fn.description === "string"
            ? { description: fn.description }
            : {}),
          parameters: googleSchema(
            fn.parametersJsonSchema ??
              fn.parameters ?? { type: "object", properties: {} },
          ),
        },
      });
    }
  }
  const body: ChatTranslation["body"] = { messages };
  const config = record(record(request.toolConfig)?.functionCallingConfig);
  if (config) {
    const modes: Record<string, string> = {
      AUTO: "auto",
      VALIDATED: "auto",
      NONE: "none",
      ANY: "required",
    };
    const mode =
      config.mode === undefined ? "auto" : modes[string(config.mode)];
    if (!mode) throw new GatewayError("Unsupported Google tool choice");
    const allowed =
      config.allowedFunctionNames === undefined ||
      config.allowedFunctionNames === null
        ? undefined
        : new Set(
            array(config.allowedFunctionNames).map((name) =>
              toolAlias(string(name)),
            ),
          );
    if (allowed)
      tools = tools.filter((tool) =>
        allowed.has(string(object(tool.function).name)),
      );
    body.tool_choice =
      mode === "required" && allowed?.size === 1
        ? { type: "function", function: { name: [...allowed][0] } }
        : mode;
  }
  if (tools.length) body.tools = tools;
  let hideThoughts = false;
  const generation = record(request.generationConfig);
  if (generation) {
    if (
      generation.candidateCount !== undefined &&
      generation.candidateCount !== null &&
      generation.candidateCount !== 1
    )
      throw new GatewayError("The model gateway requires one Google candidate");
    if (
      Array.isArray(generation.responseModalities) &&
      generation.responseModalities.some((value) => value !== "TEXT")
    )
      throw multimodal("Google non-text response modality");
    if (generation.temperature !== undefined && generation.temperature !== null)
      body.temperature = boundedNumber(generation.temperature, 0, 2);
    if (generation.topP !== undefined && generation.topP !== null)
      body.top_p = boundedNumber(generation.topP, 0, 1);
    if (
      generation.maxOutputTokens !== undefined &&
      generation.maxOutputTokens !== null
    )
      body.max_tokens = boundedNumber(
        generation.maxOutputTokens,
        1,
        Number.MAX_SAFE_INTEGER,
        true,
      );
    if (
      Array.isArray(generation.stopSequences) &&
      generation.stopSequences.length
    )
      body.stop = generation.stopSequences.map(string);
    for (const [from, to] of [
      ["presencePenalty", "presence_penalty"],
      ["frequencyPenalty", "frequency_penalty"],
      ["seed", "seed"],
    ] as const)
      if (typeof generation[from] === "number") body[to] = generation[from];
    hideThoughts = record(generation.thinkingConfig)?.includeThoughts === false;
    const mime = generation.responseMimeType;
    if (mime !== undefined && mime !== null && mime !== "text/plain") {
      if (mime !== "application/json")
        throw new GatewayError("Unsupported Google response MIME type");
      const schema = generation.responseJsonSchema ?? generation.responseSchema;
      body.response_format = schema
        ? {
            type: "json_schema",
            json_schema: { name: "response", schema: googleSchema(schema) },
          }
        : { type: "json_object" };
    }
  }
  return {
    body,
    tools: bindings,
    stream,
    requestedModel,
    ...(hideThoughts ? { hideThoughts } : {}),
  };
}

const statusNames: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};
function googleError(failure: Failure): Record<string, unknown> {
  if (failure.contextOverflow) {
    const numbers = contextNumbers(failure.message);
    return {
      code: 400,
      message: truncateText(
        numbers
          ? `The input token count (${numbers.actual}) exceeds the maximum number of tokens allowed (${numbers.limit}).`
          : `The input token count exceeds the maximum number of tokens allowed. ${failure.message}`,
      ),
      status: "INVALID_ARGUMENT",
    };
  }
  return {
    code: failure.status,
    message: failure.message,
    status:
      statusNames[failure.status] ??
      (failure.status >= 500 ? "INTERNAL" : "FAILED_PRECONDITION"),
  };
}
/** Status and body of a Google API error response. */
export function googleErrorResponse(failure: Failure): {
  status: number;
  body: unknown;
} {
  return {
    status: failure.contextOverflow ? 400 : failure.status,
    body: { error: googleError(failure) },
  };
}

function finishReason(finish: string): string {
  switch (finish) {
    case "stop":
    case "tool_calls":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "OTHER";
  }
}

/**
 * Gemini output: SSE (`alt=sse`) or a streamed JSON array of
 * GenerateContentResponse chunks, or one response. Thought parts carry
 * reasoning; function calls are sent complete in the final chunk, the first
 * one carrying the reasoning as its thought signature.
 */
export class GoogleSink implements OutputSink {
  #first = true;
  constructor(
    private readonly writer: HttpWriter,
    private readonly translation: ChatTranslation,
    private readonly context: SinkContext,
    private readonly eventStream: boolean,
  ) {}
  #response(
    parts: Record<string, unknown>[],
    finish?: string,
  ): Record<string, unknown> {
    return {
      candidates: [
        {
          content: { role: "model", parts },
          index: 0,
          ...(finish ? { finishReason: finish } : {}),
        },
      ],
      modelVersion: this.context.model,
      responseId: this.context.id,
    };
  }
  async #chunk(value: unknown): Promise<void> {
    if (this.eventStream)
      await this.writer.write(`data: ${JSON.stringify(value)}\n\n`);
    else {
      await this.writer.write(
        (this.#first ? "" : ",\r\n") + JSON.stringify(value),
      );
      this.#first = false;
    }
  }
  #calls(result: ChatResult): Record<string, unknown>[] {
    return result.calls.map((call, index) => {
      if (!call.input)
        throw new GatewayError(
          "Upstream returned malformed tool arguments",
          502,
          "upstream_protocol_error",
        );
      return {
        functionCall: {
          id: call.id,
          name: nativeTool(this.translation.tools, call.name).name,
          args: call.input,
        },
        ...(index === 0 && this.context.reasoning && result.reasoning
          ? { thoughtSignature: encodeReasoning(result.reasoning) }
          : {}),
      };
    });
  }
  #usage(result: ChatResult): Record<string, unknown> | undefined {
    const usage = result.usage;
    if (!usage) return undefined;
    const input = usage.input ?? 0,
      thoughts = usage.reasoning ?? 0,
      output = Math.max(0, (usage.output ?? 0) - thoughts);
    return {
      promptTokenCount: input,
      candidatesTokenCount: output,
      totalTokenCount: usage.total ?? input + output + thoughts,
      ...(thoughts ? { thoughtsTokenCount: thoughts } : {}),
      ...(usage.cached ? { cachedContentTokenCount: usage.cached } : {}),
    };
  }
  async start(): Promise<void> {
    if (!this.translation.stream) return;
    this.writer.begin(
      200,
      this.eventStream
        ? "text/event-stream; charset=utf-8"
        : "application/json; charset=utf-8",
    );
    if (!this.eventStream) await this.writer.write("[");
  }
  async reasoning(text: string): Promise<void> {
    if (
      this.translation.stream &&
      this.context.reasoning &&
      !this.translation.hideThoughts
    )
      await this.#chunk(this.#response([{ text, thought: true }]));
  }
  async text(text: string): Promise<void> {
    if (this.translation.stream) await this.#chunk(this.#response([{ text }]));
  }
  async toolStart(): Promise<void> {}
  async toolArgs(): Promise<void> {}
  async finish(result: ChatResult): Promise<void> {
    const calls = this.#calls(result);
    const usage = this.#usage(result);
    const finish = finishReason(result.finish);
    if (this.translation.stream) {
      await this.#chunk({
        ...this.#response(calls, finish),
        ...(usage ? { usageMetadata: usage } : {}),
      });
      await this.writer.end(this.eventStream ? "" : "]");
      return;
    }
    const parts: Record<string, unknown>[] = [];
    if (
      this.context.reasoning &&
      !this.translation.hideThoughts &&
      result.reasoning
    )
      parts.push({ text: result.reasoning, thought: true });
    if (result.text) parts.push({ text: result.text });
    parts.push(...calls);
    await this.writer.json(200, {
      ...this.#response(parts, finish),
      ...(usage ? { usageMetadata: usage } : {}),
    });
  }
  async fail(failure: Failure): Promise<void> {
    const error = { error: googleError(failure) };
    if (this.eventStream) {
      await this.writer.write(`data: ${JSON.stringify(error)}\n\n`);
      await this.writer.end();
    } else {
      await this.writer.write(
        (this.#first ? "" : ",\r\n") + JSON.stringify(error),
      );
      await this.writer.end("]");
    }
  }
}
