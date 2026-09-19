/**
 * Company model gateway emulation shared by scripts/strict-chat-proxy.mjs and
 * scripts/mock-company-model.mjs (ADR 0013). The company gateway accepts only
 * streaming OpenAI Chat Completions; these rules reject the vendor-specific
 * parameters that the unified model gateway is required to remove or rewrite.
 *
 * Pure functions plus small HTTP helpers; no dependencies and no network access.
 */

/** Top-level request fields the strict upstream refuses (ADR 0013 default drop list plus non-portable limits). */
export const forbiddenChatFields = Object.freeze([
  "stream_options",
  "store",
  "metadata",
  "service_tier",
  "prediction",
  "modalities",
  "audio",
  "web_search_options",
  "user",
  "parallel_tool_calls",
  "reasoning_effort",
  "max_completion_tokens",
]);

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate one Chat Completions request body against the strict company contract.
 *
 * @param {unknown} body Parsed JSON request body.
 * @param {{expectModel?: string}} [options] When set, `model` must equal it exactly.
 * @returns {string[]} Human-readable violations; empty when the request is acceptable.
 */
export function strictChatViolations(body, options = {}) {
  if (!isObject(body)) return ["request body must be a JSON object"];
  const violations = [];
  if (body.stream !== true)
    violations.push("stream must be true; the company gateway only streams");
  for (const field of forbiddenChatFields)
    if (Object.hasOwn(body, field)) violations.push(`${field} is not accepted`);
  if (typeof body.model !== "string" || body.model.length === 0)
    violations.push("model must be a non-empty string");
  else if (
    options.expectModel !== undefined &&
    body.model !== options.expectModel
  )
    violations.push(
      `model must be the unified model ${options.expectModel}; received ${body.model}`,
    );
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    violations.push("messages must be a non-empty array");
  else {
    let systemMessages = 0;
    body.messages.forEach((message, index) => {
      if (!isObject(message)) {
        violations.push(`messages[${index}] must be an object`);
        return;
      }
      if (message.role === "developer")
        violations.push(`messages[${index}] role developer is not accepted`);
      if (message.role === "system") {
        systemMessages++;
        if (index !== 0)
          violations.push(`messages[${index}] system message must be first`);
      }
    });
    if (systemMessages > 1)
      violations.push("only one system message is accepted");
  }
  const tools = body.tools;
  if (tools !== undefined && !Array.isArray(tools))
    violations.push("tools must be an array");
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (Array.isArray(tools))
    tools.forEach((tool, index) => {
      if (
        !isObject(tool) ||
        tool.type !== "function" ||
        !isObject(tool.function)
      )
        violations.push(`tools[${index}] must be a function tool`);
    });
  if (!hasTools && Object.hasOwn(body, "tool_choice"))
    violations.push("tool_choice is only accepted together with tools");
  return violations;
}

/** OpenAI-compatible error body used by both strict endpoints. */
export function chatError(
  message,
  type = "invalid_request_error",
  code = null,
) {
  return { error: { message, type, param: null, code } };
}

/** Plain text of a Chat message content value (string or content-part array). */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** Serialize one server-sent event data frame. */
export function sseData(value) {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}

/**
 * Parse a Chat Completions SSE body into its aggregate result. Used by tests and
 * diagnostics; tolerant of missing indexes like the unified gateway must be.
 */
export function parseChatStream(text) {
  const result = {
    reasoning: "",
    content: "",
    toolCalls: [],
    finishReasons: [],
    usage: undefined,
    done: false,
    chunks: 0,
  };
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") {
      result.done = true;
      continue;
    }
    const chunk = JSON.parse(data);
    result.chunks++;
    if (chunk.usage) result.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string")
        result.reasoning += delta.reasoning_content;
      if (typeof delta.content === "string") result.content += delta.content;
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : 0;
        const target = (result.toolCalls[index] ??= {
          id: undefined,
          name: "",
          arguments: "",
        });
        if (call.id) target.id = call.id;
        if (call.function?.name) target.name += call.function.name;
        if (call.function?.arguments)
          target.arguments += call.function.arguments;
      }
      if (choice.finish_reason) result.finishReasons.push(choice.finish_reason);
    }
  }
  return result;
}

/**
 * Read a request body with a byte bound. Rejects with `{statusCode: 413}` when exceeded.
 * @param {import("node:http").IncomingMessage} request
 * @param {number} [limit]
 * @returns {Promise<Buffer>}
 */
export function readBody(request, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(
          Object.assign(new Error("Request body is too large"), {
            statusCode: 413,
          }),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

/** Send a JSON response unless the socket is already gone. */
export function sendJson(response, status, value) {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
