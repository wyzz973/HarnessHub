import { createHash } from "node:crypto";

/** Protocol rejection, with a safe message that never includes request or upstream data. */
export class BridgeProtocolError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
/** Reject non-object protocol values before accessing their fields. */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BridgeProtocolError("Expected a JSON object");
  return value as Record<string, unknown>;
}
/** Reject non-array protocol values; elements remain unknown until checked. */
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new BridgeProtocolError("Expected a JSON array");
  return value;
}
/** Accept text without coercing structured values or exposing them in errors. */
export function string(value: unknown): string {
  if (typeof value !== "string") throw new BridgeProtocolError("Expected text");
  return value;
}
function boundedNumber(
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
    throw new BridgeProtocolError("Invalid numeric generation setting");
  return value;
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  return array(value)
    .map((raw) => {
      const part = object(raw);
      if (!["input_text", "output_text", "text"].includes(string(part.type)))
        throw new BridgeProtocolError("Chat bridge supports text content only");
      return string(part.text);
    })
    .join("");
}
/** Immutable native identity behind one Chat tool name; restoration precedes dispatch. */
export interface ToolBinding {
  name: string;
  namespace?: string;
  custom: boolean;
}
/** One validated request plus its request-local tool map, never persisted by the bridge. */
export interface ChatTranslation {
  body: Record<string, unknown>;
  tools: Map<string, ToolBinding>;
  stream: boolean;
  wire?: "google";
}
function alias(name: string, namespace?: string): string {
  return namespace || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)
    ? `hh_${createHash("sha256")
        .update(JSON.stringify([namespace ?? "", name]))
        .digest("hex")
        .slice(0, 32)}`
    : name;
}
/** Translate Codex's complete, text-only Responses history and tools; unsupported server features fail explicitly. */
export function responsesToChat(raw: unknown, model: string): ChatTranslation {
  const request = object(raw);
  if (request.stream !== undefined && typeof request.stream !== "boolean")
    throw new BridgeProtocolError("Invalid stream setting");
  if (
    request.parallel_tool_calls !== undefined &&
    typeof request.parallel_tool_calls !== "boolean"
  )
    throw new BridgeProtocolError("Invalid parallel tool setting");
  if (request.model !== model)
    throw new BridgeProtocolError(
      "Bridge model does not match the configured model",
    );
  if (
    request.previous_response_id ||
    request.background === true ||
    request.store === true
  )
    throw new BridgeProtocolError(
      "Chat bridge requires complete input history and store=false",
    );
  const known = new Set([
    "model",
    "instructions",
    "input",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "store",
    "stream",
    "include",
    "prompt_cache_key",
    "text",
    "client_metadata",
    "metadata",
    "temperature",
    "top_p",
    "max_output_tokens",
    "previous_response_id",
    "background",
    "truncation",
  ]);
  if (Object.keys(request).some((key) => !known.has(key)))
    throw new BridgeProtocolError("Unsupported Responses request field");
  if (
    request.reasoning &&
    object(request.reasoning).effort &&
    object(request.reasoning).effort !== "none"
  )
    throw new BridgeProtocolError(
      "Chat bridge requires Codex reasoning effort none",
    );
  if (request.truncation && request.truncation !== "disabled")
    throw new BridgeProtocolError("Server-side truncation is unsupported");
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
        throw new BridgeProtocolError(
          "Chat bridge supports function/custom tools only; disable hosted search and other hosted tools",
        );
      const name = string(tool.name),
        mapped = alias(name, namespace),
        custom = tool.type === "custom";
      if (bindings.has(mapped))
        throw new BridgeProtocolError("Duplicate tool names");
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
            : object(tool.parameters),
          ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
        },
      });
    }
  };
  addTools(request.tools === undefined ? [] : array(request.tools));
  const messages: Record<string, unknown>[] = [];
  if (request.instructions !== undefined)
    messages.push({ role: "system", content: string(request.instructions) });
  const input =
    typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : array(request.input);
  for (const rawItem of input) {
    const item = object(rawItem),
      type = item.type ?? "message";
    if (type === "message") {
      if (
        !["system", "developer", "user", "assistant"].includes(
          string(item.role),
        )
      )
        throw new BridgeProtocolError("Unsupported message role");
      messages.push({
        role: item.role === "developer" ? "system" : item.role,
        content: textContent(item.content),
      });
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = string(item.name),
        namespace =
          item.namespace === undefined ? undefined : string(item.namespace);
      const call = {
        id: string(item.call_id),
        type: "function",
        function: {
          name: alias(name, namespace),
          arguments:
            type === "custom_tool_call"
              ? JSON.stringify({ input: string(item.input) })
              : string(item.arguments),
        },
      };
      const last = messages.at(-1);
      if (last?.role === "assistant" && Array.isArray(last.tool_calls))
        last.tool_calls.push(call);
      else
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    )
      messages.push({
        role: "tool",
        tool_call_id: string(item.call_id),
        content: textContent(item.output),
      });
    else
      throw new BridgeProtocolError(
        "Unsupported Responses history item; encrypted reasoning and multimodal histories cannot be translated",
      );
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) body.tools = tools;
  if (request.tool_choice !== undefined) {
    if (
      typeof request.tool_choice === "string" &&
      ["auto", "none", "required"].includes(request.tool_choice)
    )
      body.tool_choice = request.tool_choice;
    else {
      const choice = object(request.tool_choice);
      if (!["function", "custom"].includes(string(choice.type)))
        throw new BridgeProtocolError("Unsupported tool choice");
      body.tool_choice = {
        type: "function",
        function: {
          name: alias(
            string(choice.name),
            choice.namespace === undefined
              ? undefined
              : string(choice.namespace),
          ),
        },
      };
    }
  }
  if (request.temperature !== undefined)
    body.temperature = boundedNumber(request.temperature, 0, 2);
  if (request.top_p !== undefined)
    body.top_p = boundedNumber(request.top_p, 0, 1);
  if (request.parallel_tool_calls !== undefined)
    body.parallel_tool_calls = request.parallel_tool_calls;
  if (request.max_output_tokens !== undefined)
    body.max_tokens = boundedNumber(
      request.max_output_tokens,
      1,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  if (request.text) {
    const format = object(request.text).format;
    if (format) {
      const value = object(format);
      if (value.type === "json_schema")
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: value.name,
            schema: value.schema,
            strict: value.strict,
          },
        };
      else if (value.type === "json_object")
        body.response_format = { type: "json_object" };
      else if (value.type !== "text")
        throw new BridgeProtocolError("Unsupported output format");
    }
  }
  return { body, tools: bindings, stream: request.stream === true };
}

/** Bounded upstream output whose finish and tool identities have been validated. */
export interface ChatResult {
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  finish: string;
  usage?: Record<string, unknown>;
}

function googleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(googleSchema);
  if (!value || typeof value !== "object") return value;
  const source = object(value),
    result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(source)) {
    if (name === "propertyOrdering") continue;
    if (name === "type" && typeof entry === "string")
      result.type = entry.toLowerCase();
    else result[name] = googleSchema(entry);
  }
  return result;
}
/** Translate Gemini text and standard function calls. Hosted Google tools, cached content and multimodal parts are unsupported. */
export function googleToChat(
  raw: unknown,
  model: string,
  stream: boolean,
): ChatTranslation {
  const request = object(raw),
    messages: Record<string, unknown>[] = [],
    bindings = new Map<string, ToolBinding>();
  if (request.cachedContent)
    throw new BridgeProtocolError(
      "Chat bridge does not support Google cached content",
    );
  const known = new Set([
    "contents",
    "systemInstruction",
    "tools",
    "toolConfig",
    "generationConfig",
    "safetySettings",
    "cachedContent",
  ]);
  if (Object.keys(request).some((key) => !known.has(key)))
    throw new BridgeProtocolError(
      "Unsupported Google generation request field",
    );
  if (
    request.safetySettings !== undefined &&
    array(request.safetySettings).length
  )
    throw new BridgeProtocolError(
      "Google-specific safety settings are unsupported by the Chat gateway",
    );
  const partsText = (rawParts: unknown) =>
    array(rawParts)
      .map((rawPart) => string(object(rawPart).text))
      .join("");
  if (request.systemInstruction)
    messages.push({
      role: "system",
      content: partsText(object(request.systemInstruction).parts),
    });
  let callCounter = 0;
  const pending: { id: string; name: string }[] = [];
  for (const rawContent of array(request.contents)) {
    const content = object(rawContent),
      role = content.role;
    if (role !== "user" && role !== "model")
      throw new BridgeProtocolError("Unsupported Google content role");
    let text = "";
    const calls: Record<string, unknown>[] = [];
    const flush = () => {
      if (text || calls.length) {
        messages.push({
          role: role === "model" ? "assistant" : "user",
          content: text || null,
          ...(calls.length ? { tool_calls: [...calls] } : {}),
        });
        text = "";
        calls.length = 0;
      }
    };
    for (const rawPart of array(content.parts)) {
      const part = object(rawPart);
      // Gemini CLI 0.58 inserts this literal sentinel into tool history even
      // when thinking is disabled; it contains no signature or reasoning.
      const syntheticToolSignature =
        part.functionCall &&
        part.thoughtSignature === "skip_thought_signature_validator";
      if (part.thought || (part.thoughtSignature && !syntheticToolSignature))
        throw new BridgeProtocolError(
          "Google reasoning signatures cannot be translated to Chat history",
        );
      if (typeof part.text === "string") text += part.text;
      else if (part.functionCall) {
        if (role !== "model")
          throw new BridgeProtocolError("Function call requires model role");
        const call = object(part.functionCall),
          name = string(call.name),
          id =
            call.id === undefined ? `gcall_${callCounter++}` : string(call.id);
        pending.push({ id, name });
        calls.push({
          id,
          type: "function",
          function: {
            name: alias(name),
            arguments: JSON.stringify(object(call.args ?? {})),
          },
        });
      } else if (part.functionResponse) {
        flush();
        const answer = object(part.functionResponse),
          name = string(answer.name);
        const index = pending.findIndex(
          (call) =>
            call.name === name &&
            (answer.id === undefined || answer.id === call.id),
        );
        if (index < 0)
          throw new BridgeProtocolError(
            "Google function response has no matching call",
          );
        const [call] = pending.splice(index, 1);
        messages.push({
          role: "tool",
          tool_call_id: call!.id,
          content: JSON.stringify(object(answer.response)),
        });
      } else
        throw new BridgeProtocolError(
          "Chat bridge supports Google text and function parts only",
        );
    }
    flush();
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools: Record<string, unknown>[] = [];
  for (const rawTool of request.tools === undefined
    ? []
    : array(request.tools)) {
    const tool = object(rawTool);
    if (Object.keys(tool).some((key) => key !== "functionDeclarations"))
      throw new BridgeProtocolError(
        "Google hosted tools are unsupported; use native/MCP tools",
      );
    for (const rawFunction of array(tool.functionDeclarations)) {
      const fn = object(rawFunction),
        name = string(fn.name),
        mapped = alias(name);
      if (bindings.has(mapped))
        throw new BridgeProtocolError("Duplicate Google tool name");
      bindings.set(mapped, { name, custom: false });
      tools.push({
        type: "function",
        function: {
          name: mapped,
          ...(fn.description === undefined
            ? {}
            : { description: string(fn.description) }),
          parameters: googleSchema(
            fn.parametersJsonSchema ??
              fn.parameters ?? { type: "object", properties: {} },
          ),
        },
      });
    }
  }
  if (tools.length) body.tools = tools;
  if (request.toolConfig) {
    const config = object(request.toolConfig);
    if (Object.keys(config).some((key) => key !== "functionCallingConfig"))
      throw new BridgeProtocolError("Unsupported Google tool configuration");
    if (config.functionCallingConfig) {
      const fn = object(config.functionCallingConfig);
      if (fn.allowedFunctionNames)
        throw new BridgeProtocolError(
          "Restricted Google tool lists are unsupported",
        );
      const modes: Record<string, string> = {
        AUTO: "auto",
        NONE: "none",
        ANY: "required",
      };
      const mode = modes[string(fn.mode)];
      if (!mode)
        throw new BridgeProtocolError("Unsupported Google tool choice");
      body.tool_choice = mode;
    }
  }
  if (request.generationConfig) {
    const config = object(request.generationConfig);
    const fields: Record<string, string> = {
      temperature: "temperature",
      topP: "top_p",
      maxOutputTokens: "max_tokens",
      stopSequences: "stop",
    };
    const supported = new Set([
      ...Object.keys(fields),
      "candidateCount",
      "responseMimeType",
      "responseSchema",
      "responseJsonSchema",
      "thinkingConfig",
    ]);
    if (Object.keys(config).some((key) => !supported.has(key)))
      throw new BridgeProtocolError("Unsupported Google generation setting");
    if (config.candidateCount !== undefined && config.candidateCount !== 1)
      throw new BridgeProtocolError(
        "Chat bridge requires one Google candidate",
      );
    for (const [from, to] of Object.entries(fields))
      if (config[from] !== undefined) body[to] = config[from];
    if (config.temperature !== undefined)
      body.temperature = boundedNumber(config.temperature, 0, 2);
    if (config.topP !== undefined)
      body.top_p = boundedNumber(config.topP, 0, 1);
    if (config.maxOutputTokens !== undefined)
      body.max_tokens = boundedNumber(
        config.maxOutputTokens,
        1,
        Number.MAX_SAFE_INTEGER,
        true,
      );
    if (config.stopSequences !== undefined)
      body.stop = array(config.stopSequences).map(string);
    if (config.thinkingConfig) {
      const thinking = object(config.thinkingConfig);
      if (
        thinking.thinkingBudget !== 0 ||
        thinking.includeThoughts === true ||
        thinking.thinkingLevel
      )
        throw new BridgeProtocolError(
          "Chat bridge requires Gemini thinking disabled",
        );
    }
    if (config.responseMimeType && config.responseMimeType !== "text/plain") {
      if (config.responseMimeType !== "application/json")
        throw new BridgeProtocolError("Unsupported Google response MIME type");
      const schema = config.responseJsonSchema ?? config.responseSchema;
      body.response_format = schema
        ? {
            type: "json_schema",
            json_schema: { name: "response", schema: googleSchema(schema) },
          }
        : { type: "json_object" };
    }
  }
  return { body, tools: bindings, stream, wire: "google" };
}

/** Build a Google response only after a valid Chat finish; function identities remain native. */
export function googleOutput(
  result: ChatResult,
  tools: Map<string, ToolBinding>,
): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  if (result.text) parts.push({ text: result.text });
  for (const call of result.calls) {
    const binding = tools.get(call.name);
    if (!binding)
      throw new BridgeProtocolError(
        "Upstream selected an unknown Google tool",
        502,
      );
    parts.push({
      functionCall: {
        id: call.id,
        name: binding.name,
        args: object(JSON.parse(call.arguments)),
      },
    });
  }
  return {
    candidates: [
      { index: 0, content: { role: "model", parts }, finishReason: "STOP" },
    ],
    ...(result.usage
      ? {
          usageMetadata: {
            promptTokenCount: result.usage.input_tokens,
            candidatesTokenCount: result.usage.output_tokens,
            totalTokenCount: result.usage.total_tokens,
          },
        }
      : {}),
  };
}
/** Restore original tool identities before the engine, including MCP names, dispatches any tool. */
export function responseOutput(
  result: ChatResult,
  tools: Map<string, ToolBinding>,
  id: string,
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  if (result.text)
    output.push({
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    });
  for (const call of result.calls) {
    const binding = tools.get(call.name);
    if (!binding)
      throw new BridgeProtocolError("Upstream selected an unknown tool", 502);
    const item = {
      id: `fc_${call.id}`,
      call_id: call.id,
      name: binding.name,
      ...(binding.namespace ? { namespace: binding.namespace } : {}),
      status: "completed",
    };
    output.push(
      binding.custom
        ? {
            ...item,
            type: "custom_tool_call",
            input: string(object(JSON.parse(call.arguments)).input),
          }
        : { ...item, type: "function_call", arguments: call.arguments },
    );
  }
  return output;
}
