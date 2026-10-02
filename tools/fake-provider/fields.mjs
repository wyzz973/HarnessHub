// SPDX-License-Identifier: MIT
/**
 * Request field lists of the four protocols the fake provider emulates. They
 * are data, so that per-Agent field manifests (docs/proposals/oss/10-engineering.md
 * §3.4) can extend them with `resolveFields`.
 *
 * Each protocol has two lists per scope:
 *
 * - `declared` (whitelist mode): the portable subset of the vendor's public
 *   request reference that a stateless upstream implements for one request:
 *   content, sampling and output limits, tools, streaming and reasoning
 *   controls. Hosted state (stored responses, conversations, prompt templates,
 *   cached content), account and routing controls (user, service tier) and
 *   other vendor extensions are left out; a manifest adds the ones an Agent
 *   legitimately sends.
 * - `forbidden` (blacklist mode, the default): known vendor-private fields that
 *   strict compatible upstreams reject, and fields of the other protocols,
 *   which in an upstream request mean that a translation leaked them. The value
 *   is the reason reported with the violation.
 *
 * Scopes name where a field sits (paths use `messages[2].foo` notation):
 * `topLevel` the request body; `countTokens` the Messages count_tokens body;
 * `message` one entry of the message list (Chat and Messages `messages`,
 * Responses `input` items, Gemini `contents` and `systemInstruction`);
 * `contentPart` one entry of a message's content array (Gemini `parts`);
 * `tool` one entry of `tools`; `toolFunction` a Chat tool's `function`;
 * `functionDeclaration` a Gemini function declaration; `generationConfig` the
 * Gemini generation config; `role` the accepted values of a message `role`.
 *
 * Gemini parses requests as protocol-buffer JSON, which accepts the
 * snake_case spelling of every field as well; whitelist checks accept both.
 */

/** Vendor-private Chat fields: the retired strict Chat upstream's list (ADR 0013 drop list). */
const OPENAI_ONLY =
  "an OpenAI-only parameter that strict Chat-compatible upstreams reject";
const ANTHROPIC = "an Anthropic Messages field";
const RESPONSES = "an OpenAI Responses field";
const CHAT = "an OpenAI Chat Completions field";
const GEMINI = "a Gemini generateContent field";
const HOSTED =
  "hosted server-side state that a stateless upstream cannot serve";

export const BASE_FIELDS = deepFreeze({
  // https://platform.openai.com/docs/api-reference/chat/create
  chat: {
    declared: {
      topLevel: [
        "model",
        "messages",
        "stream",
        "max_tokens",
        "temperature",
        "top_p",
        "n",
        "stop",
        "presence_penalty",
        "frequency_penalty",
        "logit_bias",
        "logprobs",
        "top_logprobs",
        "seed",
        "response_format",
        "tools",
        "tool_choice",
      ],
      // `reasoning_content` is DeepSeek's reasoning field, which this fake
      // streams and requires back on tool-call turns (see `reasoningReplay`).
      message: [
        "role",
        "content",
        "name",
        "tool_calls",
        "tool_call_id",
        "reasoning_content",
      ],
      contentPart: ["type", "text", "image_url"],
      tool: ["type", "function"],
      toolFunction: ["name", "description", "parameters", "strict"],
      role: ["system", "user", "assistant", "tool"],
    },
    forbidden: {
      topLevel: {
        stream_options: OPENAI_ONLY,
        store: OPENAI_ONLY,
        metadata: OPENAI_ONLY,
        service_tier: OPENAI_ONLY,
        prediction: OPENAI_ONLY,
        modalities: OPENAI_ONLY,
        audio: OPENAI_ONLY,
        web_search_options: OPENAI_ONLY,
        user: OPENAI_ONLY,
        parallel_tool_calls: OPENAI_ONLY,
        reasoning_effort: OPENAI_ONLY,
        max_completion_tokens: `${OPENAI_ONLY}; send max_tokens`,
        system: ANTHROPIC,
        thinking: ANTHROPIC,
        stop_sequences: ANTHROPIC,
        top_k: ANTHROPIC,
        input: RESPONSES,
        instructions: RESPONSES,
        max_output_tokens: RESPONSES,
        previous_response_id: RESPONSES,
        contents: GEMINI,
        generationConfig: GEMINI,
        systemInstruction: GEMINI,
      },
      message: { cache_control: ANTHROPIC },
      contentPart: { cache_control: ANTHROPIC },
      tool: {
        cache_control: ANTHROPIC,
        input_schema: ANTHROPIC,
        name: `${RESPONSES} (Chat nests it in function)`,
        parameters: `${RESPONSES} (Chat nests it in function)`,
        functionDeclarations: GEMINI,
      },
      toolFunction: { input_schema: ANTHROPIC },
      role: {
        developer:
          "the OpenAI developer role, which strict Chat-compatible upstreams reject",
      },
    },
  },
  // https://platform.openai.com/docs/api-reference/responses/create
  responses: {
    declared: {
      topLevel: [
        "model",
        "input",
        "instructions",
        "stream",
        "max_output_tokens",
        "temperature",
        "top_p",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "text",
        "store",
        "include",
        "truncation",
      ],
      // Input items of the types message, function_call, function_call_output and reasoning.
      message: [
        "type",
        "role",
        "content",
        "id",
        "status",
        "call_id",
        "name",
        "arguments",
        "output",
        "summary",
        "encrypted_content",
      ],
      contentPart: [
        "type",
        "text",
        "image_url",
        "detail",
        "file_id",
        "annotations",
      ],
      tool: ["type", "name", "description", "parameters", "strict"],
      role: ["user", "assistant", "system", "developer"],
    },
    forbidden: {
      topLevel: {
        previous_response_id: HOSTED,
        conversation: HOSTED,
        background: HOSTED,
        prompt: HOSTED,
        messages: CHAT,
        max_tokens: CHAT,
        max_completion_tokens: CHAT,
        n: CHAT,
        stop: CHAT,
        response_format: `${CHAT}; Responses uses text.format`,
        reasoning_effort: `${CHAT}; Responses uses reasoning.effort`,
        functions: CHAT,
        function_call: CHAT,
        system: ANTHROPIC,
        thinking: ANTHROPIC,
        stop_sequences: ANTHROPIC,
        top_k: ANTHROPIC,
        contents: GEMINI,
        generationConfig: GEMINI,
        systemInstruction: GEMINI,
      },
      message: {
        cache_control: ANTHROPIC,
        reasoning_content: "DeepSeek's Chat reasoning field",
        tool_calls: CHAT,
        tool_call_id: CHAT,
      },
      contentPart: { cache_control: ANTHROPIC },
      tool: {
        function: `${CHAT} (Responses tools are flat)`,
        input_schema: ANTHROPIC,
        cache_control: ANTHROPIC,
        functionDeclarations: GEMINI,
      },
      role: {
        tool: `${CHAT} role; Responses sends function_call_output items`,
      },
    },
  },
  // https://docs.anthropic.com/en/api/messages and /en/api/messages-count-tokens
  messages: {
    declared: {
      topLevel: [
        "model",
        "messages",
        "max_tokens",
        "system",
        "stream",
        "stop_sequences",
        "temperature",
        "top_p",
        "top_k",
        "tools",
        "tool_choice",
        "thinking",
        "metadata",
      ],
      countTokens: [
        "model",
        "messages",
        "system",
        "tools",
        "tool_choice",
        "thinking",
      ],
      message: ["role", "content"],
      // Blocks of the types text, image, document, tool_use, tool_result, thinking and redacted_thinking.
      contentPart: [
        "type",
        "text",
        "cache_control",
        "citations",
        "source",
        "id",
        "name",
        "input",
        "tool_use_id",
        "content",
        "is_error",
        "thinking",
        "signature",
        "data",
      ],
      tool: ["name", "description", "input_schema", "cache_control", "type"],
      role: ["user", "assistant"],
    },
    forbidden: {
      topLevel: {
        container: HOSTED,
        mcp_servers: "server-side MCP connectors (beta)",
        context_management: "server-side context management (beta)",
        stream_options: CHAT,
        max_completion_tokens: CHAT,
        n: CHAT,
        stop: `${CHAT}; Messages uses stop_sequences`,
        response_format: CHAT,
        frequency_penalty: CHAT,
        presence_penalty: CHAT,
        logprobs: CHAT,
        top_logprobs: CHAT,
        seed: CHAT,
        user: CHAT,
        parallel_tool_calls: CHAT,
        reasoning_effort: CHAT,
        input: RESPONSES,
        instructions: RESPONSES,
        max_output_tokens: RESPONSES,
        contents: GEMINI,
        generationConfig: GEMINI,
        systemInstruction: GEMINI,
      },
      message: {
        reasoning_content: "DeepSeek's Chat reasoning field",
        tool_calls: CHAT,
        tool_call_id: CHAT,
        name: CHAT,
        refusal: CHAT,
      },
      contentPart: { image_url: CHAT, input_audio: CHAT },
      tool: {
        function: CHAT,
        parameters: `${CHAT}; Messages uses input_schema`,
        functionDeclarations: GEMINI,
      },
      role: {
        system:
          "a Chat role; Messages takes the system prompt in the top-level system field",
        developer: CHAT,
        tool: `${CHAT} role; Messages sends tool_result blocks in a user message`,
      },
    },
  },
  // https://ai.google.dev/api/generate-content#request-body
  gemini: {
    declared: {
      topLevel: [
        "contents",
        "systemInstruction",
        "tools",
        "toolConfig",
        "generationConfig",
        "safetySettings",
      ],
      message: ["role", "parts"],
      // Part is a union: https://ai.google.dev/api/caching#Part
      contentPart: [
        "text",
        "thought",
        "thoughtSignature",
        "inlineData",
        "fileData",
        "functionCall",
        "functionResponse",
        "executableCode",
        "codeExecutionResult",
        "videoMetadata",
      ],
      tool: ["functionDeclarations"],
      functionDeclaration: [
        "name",
        "description",
        "parameters",
        "parametersJsonSchema",
        "response",
        "responseJsonSchema",
      ],
      generationConfig: [
        "temperature",
        "topP",
        "topK",
        "candidateCount",
        "maxOutputTokens",
        "stopSequences",
        "presencePenalty",
        "frequencyPenalty",
        "seed",
        "responseMimeType",
        "responseSchema",
        "responseJsonSchema",
        "thinkingConfig",
        "responseLogprobs",
        "logprobs",
      ],
      role: ["user", "model"],
    },
    forbidden: {
      topLevel: {
        cachedContent: HOSTED,
        messages: CHAT,
        stream: `${CHAT}; Gemini streams through streamGenerateContent`,
        stream_options: CHAT,
        max_tokens: CHAT,
        temperature: `${CHAT}; Gemini takes it in generationConfig`,
        top_p: CHAT,
        top_k: ANTHROPIC,
        stop: CHAT,
        n: CHAT,
        tool_choice: CHAT,
        response_format: CHAT,
        user: CHAT,
        store: CHAT,
        metadata: CHAT,
        input: RESPONSES,
        instructions: RESPONSES,
        system: ANTHROPIC,
        thinking: ANTHROPIC,
      },
      message: {
        content: `${CHAT}; Gemini uses parts`,
        tool_calls: CHAT,
        reasoning_content: "DeepSeek's Chat reasoning field",
        name: CHAT,
        cache_control: ANTHROPIC,
      },
      contentPart: {
        type: `${CHAT} content part; Gemini parts are a union of fields`,
        image_url: CHAT,
        cache_control: ANTHROPIC,
      },
      tool: {
        type: CHAT,
        function: CHAT,
        input_schema: ANTHROPIC,
        name: RESPONSES,
        parameters: RESPONSES,
      },
      functionDeclaration: { input_schema: ANTHROPIC, strict: CHAT },
      generationConfig: {
        max_tokens: CHAT,
        max_completion_tokens: CHAT,
        reasoning_effort: CHAT,
        stop: CHAT,
        response_format: CHAT,
      },
      role: {
        assistant: `${CHAT} role; Gemini uses model`,
        system: `${CHAT} role; Gemini takes systemInstruction`,
        tool: `${CHAT} role; Gemini sends functionResponse parts`,
      },
    },
  },
});

/** Protocol names in the order used by reports and tests. */
export const PROTOCOLS = Object.freeze(Object.keys(BASE_FIELDS));

/** Scopes each protocol checks; a manifest may only name these. */
export const SCOPES = Object.freeze({
  chat: ["topLevel", "message", "contentPart", "tool", "toolFunction", "role"],
  responses: ["topLevel", "message", "contentPart", "tool", "role"],
  messages: [
    "topLevel",
    "countTokens",
    "message",
    "contentPart",
    "tool",
    "role",
  ],
  gemini: [
    "topLevel",
    "message",
    "contentPart",
    "tool",
    "functionDeclaration",
    "generationConfig",
    "role",
  ],
});

/**
 * The field lists with a manifest applied. A manifest has, per protocol, a
 * `declared` map of scope to extra accepted names and a `forbidden` map of
 * scope to `{name: reason}`; both only add.
 *
 * @param {unknown} [manifest] For example `{"chat": {"declared": {"topLevel": ["user"]}}}`.
 * @returns {Readonly<Record<string, {declared: Record<string, ReadonlySet<string>>,
 *   forbidden: Record<string, ReadonlyMap<string, string>>}>>}
 * @throws {Error} For an unknown protocol, list or scope, or a name that is not a non-empty string.
 */
export function resolveFields(manifest = {}) {
  if (!plain(manifest))
    throw new Error("A field manifest must be a JSON object");
  for (const protocol of Object.keys(manifest))
    if (!PROTOCOLS.includes(protocol))
      throw new Error(`Field manifest: unknown protocol ${protocol}`);
  const result = {};
  for (const protocol of PROTOCOLS) {
    const extra = manifest[protocol] ?? {};
    if (!plain(extra))
      throw new Error(`Field manifest: ${protocol} must be an object`);
    for (const key of Object.keys(extra))
      if (key !== "declared" && key !== "forbidden")
        throw new Error(
          `Field manifest: ${protocol}.${key} is not declared or forbidden`,
        );
    const base = BASE_FIELDS[protocol];
    const declared = {};
    const forbidden = {};
    for (const scope of SCOPES[protocol]) {
      declared[scope] = new Set(base.declared[scope] ?? []);
      forbidden[scope] = new Map(Object.entries(base.forbidden[scope] ?? {}));
    }
    for (const [scope, names] of Object.entries(extra.declared ?? {})) {
      const where = `${protocol}.declared.${scope}`;
      if (!SCOPES[protocol].includes(scope))
        throw new Error(`Field manifest: unknown scope ${where}`);
      if (!Array.isArray(names) || !names.every(nonEmptyString))
        throw new Error(`Field manifest: ${where} must be an array of names`);
      for (const name of names) declared[scope].add(name);
    }
    for (const [scope, reasons] of Object.entries(extra.forbidden ?? {})) {
      const where = `${protocol}.forbidden.${scope}`;
      if (!SCOPES[protocol].includes(scope))
        throw new Error(`Field manifest: unknown scope ${where}`);
      if (!plain(reasons) || !Object.values(reasons).every(nonEmptyString))
        throw new Error(`Field manifest: ${where} must map names to reasons`);
      for (const [name, reason] of Object.entries(reasons))
        forbidden[scope].set(name, reason);
    }
    result[protocol] = Object.freeze({
      declared: Object.freeze(declared),
      forbidden: Object.freeze(forbidden),
    });
  }
  return Object.freeze(result);
}

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
