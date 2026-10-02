// SPDX-License-Identifier: MIT
/**
 * OpenAI Chat Completions, `POST /v1/chat/completions`
 * (https://platform.openai.com/docs/api-reference/chat). Reasoning travels in
 * DeepSeek's `reasoning_content` (https://api-docs.deepseek.com/guides/reasoning_model),
 * and, like DeepSeek and the strict gateway this fake replaces, the usage of a
 * stream rides on its finish chunk: `stream_options` is outside the portable
 * Chat subset (see fields.mjs).
 */
import {
  contentText,
  halves,
  hex,
  isObject,
  sse,
  SSE_COMMENT,
} from "./common.mjs";
import {
  bearer,
  openAiAuthFailure,
  openAiError,
  openAiInvalid,
  streamRequested,
} from "./openai.mjs";

const required = (path, message) => ({ path, rule: "required", message });
const shape = (path, message) => ({ path, rule: "structure", message });

function usage(value) {
  return {
    prompt_tokens: value.input,
    completion_tokens: value.output,
    total_tokens: value.input + value.output,
    completion_tokens_details: { reasoning_tokens: value.reasoning },
  };
}

/** @type {import("./protocols.mjs").Protocol} */
export const chat = {
  name: "chat",
  credential: bearer,
  authFailure: openAiAuthFailure,
  error: openAiError,
  invalid: openAiInvalid,

  // The structure rules of the retired strict Chat upstream (ADR 0017, OSS-009 addendum).
  structure(body) {
    const violations = [];
    if (typeof body.model !== "string" || body.model.length === 0)
      violations.push(required("model", "must be a non-empty string"));
    if (body.stream !== undefined && typeof body.stream !== "boolean")
      violations.push(shape("stream", "must be a boolean"));
    if (!Array.isArray(body.messages) || body.messages.length === 0)
      violations.push(required("messages", "must be a non-empty array"));
    else {
      let systemMessages = 0;
      body.messages.forEach((message, index) => {
        const path = `messages[${index}]`;
        if (!isObject(message))
          return violations.push(shape(path, "must be an object"));
        if (typeof message.role !== "string")
          violations.push(
            required(`${path}.role`, "every message needs a role"),
          );
        if (message.role === "system") {
          systemMessages++;
          if (index !== 0)
            violations.push(
              shape(path, "a system message must be the first message"),
            );
        }
        return undefined;
      });
      if (systemMessages > 1)
        violations.push(
          shape("messages", "only one system message is accepted"),
        );
    }
    if (body.tools !== undefined && !Array.isArray(body.tools))
      violations.push(shape("tools", "must be an array"));
    const tools = Array.isArray(body.tools) ? body.tools : [];
    tools.forEach((tool, index) => {
      if (
        !isObject(tool) ||
        tool.type !== "function" ||
        !isObject(tool.function) ||
        typeof tool.function.name !== "string"
      )
        violations.push(
          shape(`tools[${index}]`, "must be a named function tool"),
        );
    });
    if (tools.length === 0 && Object.hasOwn(body, "tool_choice"))
      violations.push(
        shape("tool_choice", "is only accepted together with tools"),
      );
    return violations;
  },

  model: (body) => body.model,
  isStream: streamRequested,

  read(body) {
    const messages = [];
    body.messages.forEach((message, index) => {
      if (!isObject(message)) return;
      const path = `messages[${index}]`;
      const text = contentText(message.content);
      switch (message.role) {
        case "system":
        case "developer":
        case "user":
          messages.push({
            role: message.role === "user" ? "user" : "system",
            text,
            path,
          });
          break;
        case "assistant":
          messages.push({
            role: "assistant",
            text,
            path,
            toolCalls: (Array.isArray(message.tool_calls)
              ? message.tool_calls
              : []
            )
              .filter(isObject)
              .map((call) => ({
                id: call.id,
                name: call.function?.name,
                arguments: call.function?.arguments,
              })),
            ...(typeof message.reasoning_content === "string"
              ? { echo: { text: message.reasoning_content } }
              : {}),
          });
          break;
        case "tool":
          messages.push({ role: "tool", callId: message.tool_call_id, path });
          break;
      }
    });
    const tools = (Array.isArray(body.tools) ? body.tools : [])
      .filter((tool) => isObject(tool) && isObject(tool.function))
      .map((tool) => ({
        name: tool.function.name,
        parameters: tool.function.parameters,
      }));
    return { messages, tools };
  },

  callId: () => `call_${hex(12)}`,
  replayRequired: () => true,
  // DeepSeek thinking mode, measured 2026-09-19 (packages/gateway/test/model-gateway-runs.test.ts).
  replayError: () => ({
    status: 400,
    body: openAiError(
      400,
      "The reasoning_content in the thinking mode must be passed back to the API.",
    ),
  }),
  reasoningShown: () => true,

  render(answer, context) {
    const text = answer.text.join("");
    const reasoning = answer.reasoning.join("");
    const message = {
      role: "assistant",
      content: text || (answer.toolCalls.length ? null : ""),
      refusal: null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(answer.toolCalls.length
        ? {
            tool_calls: answer.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
    return {
      id: context.id,
      object: "chat.completion",
      created: context.created,
      model: context.model,
      choices: [
        { index: 0, message, logprobs: null, finish_reason: answer.finish },
      ],
      ...(answer.usage ? { usage: usage(answer.usage) } : {}),
    };
  },

  frames(answer, context) {
    const chunk = (delta, finish = null, extra = {}) => ({
      id: context.id,
      object: "chat.completion.chunk",
      created: context.created,
      model: context.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      ...extra,
    });
    const [first, ...rest] = answer.reasoning;
    const chunks = [
      chunk(
        first === undefined
          ? { role: "assistant", content: "" }
          : { role: "assistant", content: null, reasoning_content: first },
      ),
      ...rest.map((part) => chunk({ reasoning_content: part })),
      ...answer.text.map((part) => chunk({ content: part })),
    ];
    answer.toolCalls.forEach((call, index) => {
      chunks.push(
        chunk({
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
      for (const part of halves(call.arguments))
        chunks.push(
          chunk({
            tool_calls: [
              {
                ...(context.quirks.missingToolIndex ? {} : { index }),
                function: { arguments: part },
              },
            ],
          }),
        );
    });
    if (context.quirks.duplicateFinish) chunks.push(chunk({}, answer.finish));
    chunks.push(
      chunk(
        {},
        answer.finish,
        answer.usage ? { usage: usage(answer.usage) } : {},
      ),
    );
    return {
      contentType: "text/event-stream; charset=utf-8",
      frames: [...chunks.map((value) => sse(value)), sse("[DONE]")],
    };
  },

  // OpenAI reports a failure after the stream started as a data frame carrying `error`.
  streamError: (context, message) =>
    sse(openAiError(500, message, { type: "server_error" })),
  keepalive: (context, streaming) => (streaming ? SSE_COMMENT : "\n"),
};
