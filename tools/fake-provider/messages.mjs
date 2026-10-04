// SPDX-License-Identifier: MIT
/**
 * Anthropic Messages, `POST /v1/messages` and `POST /v1/messages/count_tokens`
 * (https://docs.anthropic.com/en/api/messages). Requests authenticate with
 * `x-api-key` and must name an `anthropic-version`; errors use
 * https://docs.anthropic.com/en/api/errors; streams use the events of
 * https://docs.anthropic.com/en/docs/build-with-claude/streaming. Thinking
 * blocks are returned only when the request enables `thinking`, as the API does.
 */
import {
  contentText,
  halves,
  hex,
  isObject,
  sse,
  SSE_COMMENT,
} from "./common.mjs";
import { more } from "./openai.mjs";

const required = (path, message) => ({ path, rule: "required", message });
const shape = (path, message) => ({ path, rule: "structure", message });

const TYPES = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
};

/** Anthropic error body: `{"type": "error", "error": {"type", "message"}, "request_id"}`. */
function error(status, message, extra = {}) {
  return {
    type: "error",
    error: {
      type:
        extra.type ??
        TYPES[status] ??
        (status >= 500 ? "api_error" : "invalid_request_error"),
      message,
    },
    request_id: `req_${hex(12)}`,
  };
}

const STOP_REASONS = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
};

function thinkingEnabled(body) {
  return (
    isObject(body.thinking) &&
    (body.thinking.type === "enabled" || body.thinking.type === "adaptive")
  );
}

function toolInput(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Input usage fields: Anthropic counts cache reads apart from `input_tokens`
 * (https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).
 */
function inputUsage(usage) {
  return {
    input_tokens: usage.input - usage.cached,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: usage.cached,
  };
}

/** Content blocks of an answer, without the streaming split. */
function blocks(answer, context) {
  const content = [];
  if (answer.reasoning.length && thinkingEnabled(context.request))
    content.push({
      type: "thinking",
      thinking: answer.reasoning.join(""),
      signature: answer.signature,
    });
  if (answer.text.length)
    content.push({ type: "text", text: answer.text.join("") });
  for (const call of answer.toolCalls)
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: toolInput(call.arguments),
    });
  return content;
}

/** @type {import("./protocols.mjs").Protocol} */
export const messages = {
  name: "messages",
  credential(request) {
    const value = request.headers["x-api-key"];
    return typeof value === "string" && value
      ? { value, via: "x-api-key" }
      : undefined;
  },
  authFailure: (kind) => ({
    status: 401,
    body: error(
      401,
      kind === "missing" ? "x-api-key header is required" : "invalid x-api-key",
    ),
  }),
  error,
  // The API rejects fields it does not know as "Extra inputs are not permitted".
  invalid(violations) {
    const [first] = violations;
    const detail =
      first.rule === "unknown"
        ? "Extra inputs are not permitted"
        : first.rule === "forbidden"
          ? `Extra inputs are not permitted (${first.message})`
          : first.message;
    return {
      status: 400,
      body: error(
        400,
        `${first.path ? `${first.path}: ` : ""}${detail}${more(violations)}`,
      ),
    };
  },

  structure(body, route, request) {
    const violations = [];
    if (typeof request.headers["anthropic-version"] !== "string")
      violations.push(required("anthropic-version", "header is required"));
    if (typeof body.model !== "string" || body.model.length === 0)
      violations.push(required("model", "Field required"));
    if (!Array.isArray(body.messages) || body.messages.length === 0)
      violations.push(required("messages", "must be a non-empty list"));
    else
      body.messages.forEach((message, index) => {
        const path = `messages[${index}]`;
        if (!isObject(message))
          return violations.push(shape(path, "must be an object"));
        if (typeof message.role !== "string")
          violations.push(required(`${path}.role`, "Field required"));
        if (
          typeof message.content !== "string" &&
          !Array.isArray(message.content)
        )
          violations.push(required(`${path}.content`, "Field required"));
        return undefined;
      });
    if (!route.countTokens) {
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)
        violations.push(
          required("max_tokens", "Field required (a positive integer)"),
        );
      if (body.stream !== undefined && typeof body.stream !== "boolean")
        violations.push(shape("stream", "must be a boolean"));
    }
    if (
      body.system !== undefined &&
      typeof body.system !== "string" &&
      !Array.isArray(body.system)
    )
      violations.push(
        shape("system", "must be a string or a list of text blocks"),
      );
    if (body.tools !== undefined && !Array.isArray(body.tools))
      violations.push(shape("tools", "must be a list"));
    else
      (body.tools ?? []).forEach((tool, index) => {
        if (!isObject(tool) || typeof tool.name !== "string")
          violations.push(required(`tools[${index}].name`, "Field required"));
      });
    return violations;
  },

  model: (body) => body.model,
  isStream: (body, route) => !route.countTokens && body.stream === true,

  read(body) {
    const messages = [];
    let images = 0;
    const system = contentText(body.system);
    if (system) messages.push({ role: "system", text: system, path: "system" });
    body.messages.forEach((message, index) => {
      if (!isObject(message)) return;
      const path = `messages[${index}]`;
      const content = Array.isArray(message.content)
        ? message.content.filter(isObject)
        : [];
      if (message.role === "assistant") {
        const thinking = content.find((block) => block.type === "thinking");
        messages.push({
          role: "assistant",
          text:
            typeof message.content === "string"
              ? message.content
              : contentText(content.filter((block) => block.type === "text")),
          path,
          toolCalls: content
            .filter((block) => block.type === "tool_use")
            .map((block) => ({
              id: block.id,
              name: block.name,
              arguments: block.input ?? {},
            })),
          ...(thinking
            ? {
                echo: {
                  text:
                    typeof thinking.thinking === "string"
                      ? thinking.thinking
                      : "",
                  ...(typeof thinking.signature === "string"
                    ? { signature: thinking.signature }
                    : {}),
                },
              }
            : {}),
        });
        return;
      }
      if (message.role === "user")
        images += content.filter((block) => block.type === "image").length;
      for (const block of content)
        if (block.type === "tool_result")
          messages.push({
            role: "tool",
            callId: block.tool_use_id,
            text:
              typeof block.content === "string"
                ? block.content
                : contentText(block.content),
            path,
          });
      const text =
        typeof message.content === "string"
          ? message.content
          : contentText(content.filter((block) => block.type === "text"));
      if (text || typeof message.content === "string")
        messages.push({
          role: message.role === "user" ? "user" : "system",
          text,
          path,
        });
    });
    const tools = (Array.isArray(body.tools) ? body.tools : [])
      .filter((tool) => isObject(tool) && typeof tool.name === "string")
      .map((tool) => ({ name: tool.name, parameters: tool.input_schema }));
    return { messages, tools, images };
  },

  callId: () => `toolu_${hex(12)}`,
  // The API requires thinking blocks back only while thinking is enabled.
  replayRequired: thinkingEnabled,
  replayError: (previous) => ({
    status: 400,
    body: error(
      400,
      `${previous.message.path}.content[0].type: Expected \`thinking\` or \`redacted_thinking\`, but found \`tool_use\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`,
    ),
  }),
  reasoningShown: thinkingEnabled,

  render(answer, context) {
    return {
      id: context.id,
      type: "message",
      role: "assistant",
      model: context.model,
      content: blocks(answer, context),
      stop_reason: STOP_REASONS[answer.finish] ?? answer.finish,
      stop_sequence: null,
      ...(answer.usage
        ? {
            usage: {
              ...inputUsage(answer.usage),
              output_tokens: answer.usage.output,
            },
          }
        : {}),
    };
  },

  frames(answer, context) {
    const frames = [];
    const emit = (type, payload = {}) =>
      frames.push(sse({ type, ...payload }, { event: type }));
    emit("message_start", {
      message: {
        id: context.id,
        type: "message",
        role: "assistant",
        model: context.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        ...(answer.usage
          ? {
              usage: { ...inputUsage(answer.usage), output_tokens: 1 },
            }
          : {}),
      },
    });
    emit("ping");
    blocks(answer, context).forEach((block, index) => {
      if (block.type === "thinking") {
        emit("content_block_start", {
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        });
        for (const thinking of answer.reasoning)
          emit("content_block_delta", {
            index,
            delta: { type: "thinking_delta", thinking },
          });
        emit("content_block_delta", {
          index,
          delta: { type: "signature_delta", signature: block.signature },
        });
      } else if (block.type === "text") {
        emit("content_block_start", {
          index,
          content_block: { type: "text", text: "" },
        });
        for (const text of answer.text)
          emit("content_block_delta", {
            index,
            delta: { type: "text_delta", text },
          });
      } else {
        const call = answer.toolCalls.find(
          (candidate) => candidate.id === block.id,
        );
        emit("content_block_start", {
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        });
        for (const partial_json of ["", ...halves(call.arguments)])
          emit("content_block_delta", {
            ...(context.quirks.missingToolIndex ? {} : { index }),
            delta: { type: "input_json_delta", partial_json },
          });
      }
      emit("content_block_stop", { index });
    });
    const delta = {
      delta: {
        stop_reason: STOP_REASONS[answer.finish] ?? answer.finish,
        stop_sequence: null,
      },
      ...(answer.usage
        ? { usage: { output_tokens: answer.usage.output } }
        : {}),
    };
    emit("message_delta", delta);
    if (context.quirks.duplicateFinish) emit("message_delta", delta);
    emit("message_stop");
    return { contentType: "text/event-stream; charset=utf-8", frames };
  },

  streamError: (context, message) =>
    sse(
      { type: "error", error: { type: "api_error", message } },
      { event: "error" },
    ),
  keepalive: (context, streaming) => (streaming ? SSE_COMMENT : "\n"),
};

/** `POST /v1/messages/count_tokens` answer for an estimated count. */
export function countTokensBody(inputTokens) {
  return { input_tokens: inputTokens };
}
