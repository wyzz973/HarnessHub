import {
  GatewayError,
  array,
  object,
  record,
  type ChatResult,
  type ChatTranslation,
  type ReasoningField,
} from "./protocol.js";
import {
  sse,
  type Failure,
  type HttpWriter,
  type OutputSink,
  type SinkContext,
} from "./output.js";

/**
 * Accept an OpenAI Chat Completions request. Fields pass through to the
 * upstream normalizer; only `n > 1` is rejected because one choice is streamed.
 */
export function chatToChat(raw: unknown): ChatTranslation {
  const request = object(raw);
  if (request.n !== undefined && request.n !== null && request.n !== 1)
    throw new GatewayError("Only one completion choice (n = 1) is supported");
  const body: ChatTranslation["body"] = {
    ...request,
    messages: array(request.messages).map((message) => ({
      ...object(message),
    })),
  };
  return {
    body,
    tools: new Map(),
    stream: request.stream === true,
    ...(typeof request.model === "string"
      ? { requestedModel: request.model }
      : {}),
    includeUsage: record(request.stream_options)?.include_usage === true,
  };
}

const errorTypes: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  413: "invalid_request_error",
  429: "rate_limit_error",
};
/** OpenAI-style error object shared by Chat and Responses. */
export function openAiError(failure: Failure): Record<string, unknown> {
  return {
    message: failure.message,
    type: failure.contextOverflow
      ? "invalid_request_error"
      : (errorTypes[failure.status] ??
        (failure.status >= 500 ? "server_error" : "invalid_request_error")),
    param: null,
    code: failure.contextOverflow ? "context_length_exceeded" : failure.code,
  };
}
/** Status and body of an OpenAI-style error response. */
export function openAiErrorResponse(failure: Failure): {
  status: number;
  body: unknown;
} {
  return {
    status: failure.contextOverflow ? 400 : failure.status,
    body: { error: openAiError(failure) },
  };
}

function chatUsage(result: ChatResult): Record<string, unknown> | undefined {
  if (!result.rawUsage && !result.usage) return undefined;
  const usage: Record<string, unknown> = { ...result.rawUsage };
  usage.prompt_tokens ??= result.usage?.input ?? 0;
  usage.completion_tokens ??= result.usage?.output ?? 0;
  usage.total_tokens ??=
    result.usage?.total ??
    Number(usage.prompt_tokens) + Number(usage.completion_tokens);
  return usage;
}

/** Chat Completions output: `chat.completion.chunk` SSE ending in `[DONE]`, or one `chat.completion`. */
export class ChatSink implements OutputSink {
  #indexes = new Map<number, number>();
  constructor(
    private readonly writer: HttpWriter,
    private readonly translation: ChatTranslation,
    private readonly context: SinkContext,
  ) {}
  #chunk(
    delta: Record<string, unknown> | undefined,
    finish: string | null = null,
    usage?: Record<string, unknown>,
  ) {
    return sse({
      id: `chatcmpl-${this.context.id}`,
      object: "chat.completion.chunk",
      created: this.context.created,
      model: this.context.model,
      choices: delta ? [{ index: 0, delta, finish_reason: finish }] : [],
      ...(usage ? { usage } : {}),
    });
  }
  async start(): Promise<void> {
    if (!this.translation.stream) return;
    this.writer.begin(200, "text/event-stream; charset=utf-8");
    await this.writer.write(this.#chunk({ role: "assistant", content: "" }));
  }
  async reasoning(text: string, field: ReasoningField): Promise<void> {
    if (this.translation.stream && this.context.reasoning)
      await this.writer.write(this.#chunk({ [field]: text }));
  }
  async text(text: string): Promise<void> {
    if (this.translation.stream)
      await this.writer.write(this.#chunk({ content: text }));
  }
  async toolStart(call: {
    index: number;
    id: string;
    name: string;
  }): Promise<void> {
    const index = this.#indexes.size;
    this.#indexes.set(call.index, index);
    if (this.translation.stream)
      await this.writer.write(
        this.#chunk({
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: "" },
            },
          ],
        }),
      );
  }
  async toolArgs(index: number, text: string): Promise<void> {
    if (this.translation.stream)
      await this.writer.write(
        this.#chunk({
          tool_calls: [
            {
              index: this.#indexes.get(index) ?? 0,
              function: { arguments: text },
            },
          ],
        }),
      );
  }
  async finish(result: ChatResult): Promise<void> {
    const usage = chatUsage(result);
    if (this.translation.stream) {
      // Usage rides on the finish chunk as DeepSeek sends it, so engines that
      // did not request include_usage still see it; the OpenAI-style
      // `choices: []` chunk follows only when it was requested.
      await this.writer.write(this.#chunk({}, result.finish, usage));
      if (usage && this.translation.includeUsage)
        await this.writer.write(this.#chunk(undefined, null, usage));
      await this.writer.end("data: [DONE]\n\n");
      return;
    }
    const message: Record<string, unknown> = {
      role: "assistant",
      content: result.text || (result.calls.length ? null : ""),
    };
    if (this.context.reasoning && result.reasoning)
      message[result.reasoningField ?? "reasoning_content"] = result.reasoning;
    if (result.calls.length)
      message.tool_calls = result.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    await this.writer.json(200, {
      id: `chatcmpl-${this.context.id}`,
      object: "chat.completion",
      created: this.context.created,
      model: this.context.model,
      choices: [
        { index: 0, message, finish_reason: result.finish, logprobs: null },
      ],
      ...(usage ? { usage } : {}),
    });
  }
  async fail(failure: Failure): Promise<void> {
    await this.writer.write(sse({ error: openAiError(failure) }));
    await this.writer.end();
  }
}
