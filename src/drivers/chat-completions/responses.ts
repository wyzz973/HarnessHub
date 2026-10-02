import {
  GatewayError,
  array,
  boundedNumber,
  omittedMedia,
  nativeTool,
  object,
  record,
  string,
  toolAlias,
  type ChatResult,
  type ChatTranslation,
  type ToolBinding,
  type ToolCall,
  type Usage,
} from "./protocol.js";
import {
  sse,
  type Failure,
  type HttpWriter,
  type OutputSink,
  type SinkContext,
} from "./output.js";
import { decodeReasoning, encodeReasoning } from "./reasoning.js";

/**
 * Every top-level field the pinned Codex 0.153.4 request type can send, plus
 * documented sampling/metadata fields. Unknown fields are rejected so a new
 * client feature cannot be dropped silently.
 */
const FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "stream_options",
  "include",
  "service_tier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "text",
  "client_metadata",
  "access_programs",
  "metadata",
  "temperature",
  "top_p",
  "top_logprobs",
  "max_output_tokens",
  "max_tool_calls",
  "previous_response_id",
  "conversation",
  "prompt",
  "background",
  "truncation",
  "user",
  "safety_identifier",
]);

function text(value: unknown, what: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return array(value)
    .map((raw) => {
      const part = object(raw);
      switch (part.type) {
        case "input_text":
        case "output_text":
        case "text":
          return string(part.text);
        case "refusal":
          return string(part.refusal);
        case "input_image":
        case "input_file":
        case "input_audio":
          return omittedMedia(`${what} ${part.type}`);
        default:
          throw new GatewayError(`Unsupported ${what} content part`);
      }
    })
    .join("\n");
}
function reasoningText(item: Record<string, unknown>): string {
  const encoded = decodeReasoning(item.encrypted_content);
  if (encoded) return encoded;
  const parts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return parts
    .map((part) => {
      const value = record(part);
      return typeof value?.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Translate a complete, stateless Responses request (Codex) to Chat.
 * Function, custom (freeform) and namespace tools map to Chat functions;
 * reasoning items become `reasoning_content` of the next assistant message.
 * Server state (`previous_response_id`, `conversation`, stored prompts,
 * background) and hosted tools fail explicitly; media input becomes text placeholders.
 */
export function responsesToChat(raw: unknown): ChatTranslation {
  const request = object(raw);
  for (const key of Object.keys(request))
    if (!FIELDS.has(key))
      throw new GatewayError(
        `Unsupported Responses request field: ${key.slice(0, 64)}`,
      );
  if (request.stream !== undefined && typeof request.stream !== "boolean")
    throw new GatewayError("Invalid stream setting");
  if (
    request.parallel_tool_calls !== undefined &&
    typeof request.parallel_tool_calls !== "boolean"
  )
    throw new GatewayError("Invalid parallel tool setting");
  if (
    (typeof request.previous_response_id === "string" &&
      request.previous_response_id) ||
    (request.conversation !== undefined && request.conversation !== null) ||
    (request.prompt !== undefined && request.prompt !== null) ||
    request.background === true
  )
    throw new GatewayError(
      "The model gateway requires the complete input history; server-side response state is unsupported",
    );
  const bindings = new Map<string, ToolBinding>();
  const tools: Record<string, unknown>[] = [];
  const addTools = (values: unknown[], namespace?: string) => {
    for (const rawTool of values) {
      const tool = object(rawTool);
      if (tool.type === "namespace" && !namespace) {
        addTools(array(tool.tools), string(tool.name));
        continue;
      }
      if (tool.type !== "function" && tool.type !== "custom")
        throw new GatewayError(
          `Hosted Responses tool ${typeof tool.type === "string" ? tool.type.slice(0, 64) : "unknown"} is unsupported; use function tools`,
        );
      const name = string(tool.name),
        mapped = toolAlias(name, namespace),
        custom = tool.type === "custom";
      if (bindings.has(mapped)) throw new GatewayError("Duplicate tool names");
      bindings.set(mapped, {
        name,
        custom,
        ...(namespace ? { namespace } : {}),
      });
      tools.push({
        type: "function",
        function: {
          name: mapped,
          description:
            (typeof tool.description === "string" ? tool.description : "") +
            (custom
              ? `\nPass the exact raw tool input as the JSON string property input. Native format: ${JSON.stringify(tool.format ?? { type: "text" })}`
              : ""),
          parameters: custom
            ? {
                type: "object",
                properties: { input: { type: "string" } },
                required: ["input"],
                additionalProperties: false,
              }
            : tool.parameters === undefined || tool.parameters === null
              ? { type: "object", properties: {} }
              : object(tool.parameters),
          ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
        },
      });
    }
  };
  if (request.tools !== undefined && request.tools !== null)
    addTools(array(request.tools));
  const messages: Record<string, unknown>[] = [];
  if (request.instructions !== undefined && request.instructions !== null) {
    const instructions = string(request.instructions);
    if (instructions) messages.push({ role: "system", content: instructions });
  }
  let reasoning = "";
  const withReasoning = (message: Record<string, unknown>) => {
    if (reasoning && typeof message.reasoning_content !== "string")
      message.reasoning_content = reasoning;
    reasoning = "";
    return message;
  };
  const input =
    typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : request.input === undefined || request.input === null
        ? []
        : array(request.input);
  for (const rawItem of input) {
    const item = object(rawItem),
      type = item.type ?? "message";
    if (type === "message") {
      const role = string(item.role);
      if (!["system", "developer", "user", "assistant"].includes(role))
        throw new GatewayError("Unsupported message role");
      const content = text(item.content, "message");
      if (role !== "assistant") {
        messages.push({ role, content });
        continue;
      }
      const last = messages.at(-1);
      if (
        last?.role === "assistant" &&
        last.content === null &&
        !last.tool_calls
      )
        withReasoning(last).content = content;
      else messages.push(withReasoning({ role: "assistant", content }));
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = string(item.name),
        namespace =
          item.namespace === undefined || item.namespace === null
            ? undefined
            : string(item.namespace);
      const call = {
        id: string(item.call_id),
        type: "function",
        function: {
          name: toolAlias(name, namespace),
          arguments:
            type === "custom_tool_call"
              ? JSON.stringify({ input: string(item.input) })
              : string(item.arguments),
        },
      };
      const last = messages.at(-1);
      if (last?.role === "assistant") {
        withReasoning(last);
        if (Array.isArray(last.tool_calls)) last.tool_calls.push(call);
        else last.tool_calls = [call];
      } else
        messages.push(
          withReasoning({
            role: "assistant",
            content: null,
            tool_calls: [call],
          }),
        );
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    )
      messages.push({
        role: "tool",
        tool_call_id: string(item.call_id),
        content: text(item.output, "tool output"),
      });
    else if (type === "reasoning") {
      const value = reasoningText(item);
      if (value) reasoning = reasoning ? `${reasoning}\n${value}` : value;
    } else if (type === "additional_tools") addTools(array(item.tools));
    else
      throw new GatewayError(
        `Unsupported Responses input item: ${typeof type === "string" ? type.slice(0, 64) : "unknown"}`,
      );
  }
  const body: ChatTranslation["body"] = { messages };
  if (tools.length) body.tools = tools;
  if (request.tool_choice !== undefined && request.tool_choice !== null) {
    if (
      typeof request.tool_choice === "string" &&
      ["auto", "none", "required"].includes(request.tool_choice)
    )
      body.tool_choice = request.tool_choice;
    else {
      const choice = object(request.tool_choice);
      if (!["function", "custom"].includes(string(choice.type)))
        throw new GatewayError("Unsupported tool choice");
      body.tool_choice = {
        type: "function",
        function: {
          name: toolAlias(
            string(choice.name),
            choice.namespace === undefined || choice.namespace === null
              ? undefined
              : string(choice.namespace),
          ),
        },
      };
    }
  }
  if (request.temperature !== undefined && request.temperature !== null)
    body.temperature = boundedNumber(request.temperature, 0, 2);
  if (request.top_p !== undefined && request.top_p !== null)
    body.top_p = boundedNumber(request.top_p, 0, 1);
  if (request.parallel_tool_calls !== undefined)
    body.parallel_tool_calls = request.parallel_tool_calls;
  if (
    request.max_output_tokens !== undefined &&
    request.max_output_tokens !== null
  )
    body.max_tokens = boundedNumber(
      request.max_output_tokens,
      1,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  const format = record(record(request.text)?.format);
  if (format) {
    if (format.type === "json_schema")
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: format.name,
          schema: format.schema,
          strict: format.strict,
        },
      };
    else if (format.type === "json_object")
      body.response_format = { type: "json_object" };
    else if (format.type !== "text")
      throw new GatewayError("Unsupported output format");
  }
  return {
    body,
    tools: bindings,
    stream: request.stream === true,
    ...(typeof request.model === "string"
      ? { requestedModel: request.model }
      : {}),
  };
}

function usage(value: Usage | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const input = value.input ?? 0,
    output = value.output ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: value.cached ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: value.reasoning ?? 0 },
    total_tokens: value.total ?? input + output,
  };
}
function reasoningItem(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
    encrypted_content: encodeReasoning(text),
  };
}
function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
/** Restore the native tool identity; custom tools unwrap their `input` string. */
function callItem(
  call: ToolCall,
  binding: ToolBinding,
): Record<string, unknown> {
  const base = {
    call_id: call.id,
    name: binding.name,
    ...(binding.namespace ? { namespace: binding.namespace } : {}),
    status: "completed",
  };
  if (!binding.custom)
    return {
      id: `fc_${call.id}`,
      type: "function_call",
      ...base,
      arguments: call.arguments,
    };
  const input = call.input?.input;
  return {
    id: `ctc_${call.id}`,
    type: "custom_tool_call",
    ...base,
    input: typeof input === "string" ? input : call.arguments,
  };
}
function incomplete(finish: string): string | undefined {
  return finish === "length"
    ? "max_output_tokens"
    : finish === "content_filter"
      ? "content_filter"
      : undefined;
}
/** Responses error code understood by Codex for a failure reported in the stream. */
function streamCode(failure: Failure): string {
  if (failure.contextOverflow) return "context_length_exceeded";
  if (failure.status === 429) return "rate_limit_exceeded";
  if (failure.status >= 500) return "server_error";
  return "invalid_prompt";
}

interface OpenItem {
  kind: "reasoning" | "message";
  index: number;
  id: string;
  text: string;
}
interface CallState {
  index: number;
  binding: ToolBinding;
}
/**
 * Responses output. Streams `response.created`, reasoning summary items
 * (with `encrypted_content` carrying the text back), message text deltas and
 * function-call argument deltas, then `response.completed` with usage, or
 * `response.incomplete` when the token limit cut the output.
 */
export class ResponsesSink implements OutputSink {
  #sequence = 0;
  #output: Record<string, unknown>[] = [];
  #open: OpenItem | undefined;
  #calls = new Map<string, CallState>();
  #byIndex = new Map<number, string>();
  constructor(
    private readonly writer: HttpWriter,
    private readonly translation: ChatTranslation,
    private readonly context: SinkContext,
  ) {}
  #base(): Record<string, unknown> {
    return {
      id: `resp_${this.context.id}`,
      object: "response",
      created_at: this.context.created,
      model: this.context.model,
    };
  }
  async #event(type: string, fields: Record<string, unknown>): Promise<void> {
    await this.writer.write(
      sse({ type, sequence_number: this.#sequence++, ...fields }, type),
    );
  }
  #reserve(): number {
    this.#output.push({});
    return this.#output.length - 1;
  }
  async start(): Promise<void> {
    if (!this.translation.stream || this.writer.sent) return;
    this.writer.begin(200, "text/event-stream; charset=utf-8");
    await this.#event("response.created", {
      response: {
        ...this.#base(),
        status: "in_progress",
        output: [],
        error: null,
        incomplete_details: null,
      },
    });
  }
  async #close(): Promise<void> {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    const item =
      open.kind === "reasoning"
        ? reasoningItem(open.id, open.text)
        : messageItem(open.id, open.text);
    this.#output[open.index] = item;
    if (open.kind === "reasoning") {
      const at = { item_id: open.id, output_index: open.index };
      await this.#event("response.reasoning_summary_text.done", {
        ...at,
        summary_index: 0,
        text: open.text,
      });
      await this.#event("response.reasoning_summary_part.done", {
        ...at,
        summary_index: 0,
        part: { type: "summary_text", text: open.text },
      });
    } else {
      const at = {
        item_id: open.id,
        output_index: open.index,
        content_index: 0,
      };
      await this.#event("response.output_text.done", {
        ...at,
        text: open.text,
      });
      await this.#event("response.content_part.done", {
        ...at,
        part: { type: "output_text", text: open.text, annotations: [] },
      });
    }
    await this.#event("response.output_item.done", {
      output_index: open.index,
      item,
    });
  }
  async #openItem(kind: OpenItem["kind"]): Promise<OpenItem> {
    if (this.#open?.kind === kind) return this.#open;
    await this.#close();
    const index = this.#reserve();
    const id = `${kind === "reasoning" ? "rs" : "msg"}_${this.context.id}_${index}`;
    const open: OpenItem = { kind, index, id, text: "" };
    this.#open = open;
    if (kind === "reasoning") {
      await this.#event("response.output_item.added", {
        output_index: index,
        item: { id, type: "reasoning", summary: [] },
      });
      await this.#event("response.reasoning_summary_part.added", {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    } else {
      await this.#event("response.output_item.added", {
        output_index: index,
        item: {
          id,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      await this.#event("response.content_part.added", {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    return open;
  }
  async reasoning(text: string): Promise<void> {
    if (!this.translation.stream || !this.context.reasoning) return;
    const open = await this.#openItem("reasoning");
    open.text += text;
    await this.#event("response.reasoning_summary_text.delta", {
      item_id: open.id,
      output_index: open.index,
      summary_index: 0,
      delta: text,
    });
  }
  async text(text: string): Promise<void> {
    if (!this.translation.stream) return;
    const open = await this.#openItem("message");
    open.text += text;
    await this.#event("response.output_text.delta", {
      item_id: open.id,
      output_index: open.index,
      content_index: 0,
      delta: text,
    });
  }
  async toolStart(call: {
    index: number;
    id: string;
    name: string;
  }): Promise<void> {
    if (!this.translation.stream) return;
    await this.#close();
    const binding = nativeTool(this.translation.tools, call.name);
    const index = this.#reserve();
    this.#calls.set(call.id, { index, binding });
    this.#byIndex.set(call.index, call.id);
    if (binding.custom) return;
    await this.#event("response.output_item.added", {
      output_index: index,
      item: {
        id: `fc_${call.id}`,
        type: "function_call",
        status: "in_progress",
        call_id: call.id,
        name: binding.name,
        ...(binding.namespace ? { namespace: binding.namespace } : {}),
        arguments: "",
      },
    });
  }
  async toolArgs(index: number, text: string): Promise<void> {
    const id = this.#byIndex.get(index);
    const state = id === undefined ? undefined : this.#calls.get(id);
    if (!this.translation.stream || !state || state.binding.custom) return;
    await this.#event("response.function_call_arguments.delta", {
      item_id: `fc_${id}`,
      output_index: state.index,
      delta: text,
    });
  }
  #final(result: ChatResult): Record<string, unknown> {
    const reason = incomplete(result.finish);
    const usageValue = usage(result.usage);
    return {
      ...this.#base(),
      status: reason ? "incomplete" : "completed",
      output: this.#output,
      error: null,
      incomplete_details: reason ? { reason } : null,
      ...(usageValue ? { usage: usageValue } : {}),
    };
  }
  async finish(result: ChatResult): Promise<void> {
    if (!this.translation.stream) {
      if (this.context.reasoning && result.reasoning)
        this.#output.push(
          reasoningItem(`rs_${this.context.id}_0`, result.reasoning),
        );
      if (result.text)
        this.#output.push(messageItem(`msg_${this.context.id}_0`, result.text));
      for (const call of result.calls)
        this.#output.push(
          callItem(call, nativeTool(this.translation.tools, call.name)),
        );
      await this.writer.json(200, this.#final(result));
      return;
    }
    await this.#close();
    for (const call of result.calls) {
      const state = this.#calls.get(call.id);
      if (!state) continue;
      const item = callItem(call, state.binding);
      this.#output[state.index] = item;
      if (state.binding.custom) {
        await this.#event("response.output_item.added", {
          output_index: state.index,
          item: { ...item, status: "in_progress", input: "" },
        });
        await this.#event("response.custom_tool_call_input.delta", {
          item_id: item.id,
          call_id: call.id,
          output_index: state.index,
          delta: item.input,
        });
      } else
        await this.#event("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: state.index,
          arguments: call.arguments,
        });
      await this.#event("response.output_item.done", {
        output_index: state.index,
        item,
      });
    }
    const response = this.#final(result);
    await this.#event(
      response.status === "incomplete"
        ? "response.incomplete"
        : "response.completed",
      { response },
    );
    await this.writer.end();
  }
  async fail(failure: Failure): Promise<void> {
    await this.start();
    await this.#event("response.failed", {
      response: {
        ...this.#base(),
        status: "failed",
        output: [],
        error: { code: streamCode(failure), message: failure.message },
        incomplete_details: null,
      },
    });
    await this.writer.end();
  }
}
