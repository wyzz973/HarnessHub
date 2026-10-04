// SPDX-License-Identifier: MIT
/**
 * OpenAI Responses, `POST /v1/responses`
 * (https://platform.openai.com/docs/api-reference/responses). Streams use the
 * named events of https://platform.openai.com/docs/api-reference/responses-streaming
 * and end with `response.completed` or `response.incomplete`, without a
 * `[DONE]` sentinel. Reasoning is a `reasoning` output item with a summary;
 * its `encrypted_content` is present when the request includes
 * `reasoning.encrypted_content`.
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
    input_tokens: value.input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: value.output,
    output_tokens_details: { reasoning_tokens: value.reasoning },
    total_tokens: value.input + value.output,
  };
}

/** Terminal status of an answer: `completed`, or `incomplete` with a reason. */
function outcome(finish) {
  switch (finish) {
    case "stop":
    case "tool_calls":
      return { status: "completed", incomplete: null };
    case "length":
      return {
        status: "incomplete",
        incomplete: { reason: "max_output_tokens" },
      };
    default:
      return { status: "incomplete", incomplete: { reason: finish } };
  }
}

function includesEncrypted(body) {
  return (
    Array.isArray(body.include) &&
    body.include.includes("reasoning.encrypted_content")
  );
}

/** Output items with their final content and stable ids. */
function outputItems(answer, context) {
  const items = [];
  if (answer.reasoning.length)
    items.push({
      id: `rs_${answer.signature}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: answer.reasoning.join("") }],
      ...(includesEncrypted(context.request)
        ? { encrypted_content: answer.signature }
        : {}),
    });
  if (answer.text.length)
    items.push({
      id: `msg_${hex(12)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: answer.text.join(""),
          annotations: [],
          logprobs: [],
        },
      ],
    });
  for (const call of answer.toolCalls)
    items.push({
      id: `fc_${hex(12)}`,
      type: "function_call",
      status: "completed",
      arguments: call.arguments,
      call_id: call.id,
      name: call.name,
    });
  return items;
}

function responseObject(
  context,
  status,
  output,
  answerUsage,
  incomplete,
  error = null,
) {
  const request = context.request;
  return {
    id: context.id,
    object: "response",
    created_at: context.created,
    status,
    error,
    incomplete_details: incomplete,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model: context.model,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: {
      effort: request.reasoning?.effort ?? null,
      summary: request.reasoning?.summary ?? null,
    },
    store: request.store ?? true,
    temperature: request.temperature ?? 1,
    text: request.text ?? { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? 1,
    truncation: request.truncation ?? "disabled",
    usage: answerUsage ? usage(answerUsage) : null,
    metadata: {},
  };
}

/** @type {import("./protocols.mjs").Protocol} */
export const responses = {
  name: "responses",
  credential: bearer,
  authFailure: openAiAuthFailure,
  error: openAiError,
  invalid: openAiInvalid,

  structure(body) {
    const violations = [];
    if (typeof body.model !== "string" || body.model.length === 0)
      violations.push(required("model", "must be a non-empty string"));
    if (body.stream !== undefined && typeof body.stream !== "boolean")
      violations.push(shape("stream", "must be a boolean"));
    const input = body.input;
    if (typeof input === "string") {
      if (!input) violations.push(required("input", "must not be empty"));
    } else if (!Array.isArray(input) || input.length === 0)
      violations.push(
        required("input", "must be a string or a non-empty array"),
      );
    else
      input.forEach((item, index) => {
        if (!isObject(item))
          violations.push(shape(`input[${index}]`, "must be an object"));
      });
    if (body.tools !== undefined && !Array.isArray(body.tools))
      violations.push(shape("tools", "must be an array"));
    else
      (body.tools ?? []).forEach((tool, index) => {
        if (!isObject(tool) || typeof tool.type !== "string")
          violations.push(shape(`tools[${index}]`, "must have a type"));
      });
    return violations;
  },

  model: (body) => body.model,
  isStream: streamRequested,

  read(body) {
    const messages = [];
    if (typeof body.instructions === "string")
      messages.push({
        role: "system",
        text: body.instructions,
        path: "instructions",
      });
    if (typeof body.input === "string")
      messages.push({ role: "user", text: body.input, path: "input" });
    let echo;
    (Array.isArray(body.input) ? body.input : []).forEach((item, index) => {
      if (!isObject(item)) return;
      const path = `input[${index}]`;
      switch (item.type ?? "message") {
        case "message":
          if (item.role === "assistant") {
            messages.push({
              role: "assistant",
              text: contentText(item.content),
              path,
              toolCalls: [],
              ...(echo ? { echo } : {}),
            });
            echo = undefined;
          } else
            messages.push({
              role: item.role === "user" ? "user" : "system",
              text: contentText(item.content),
              path,
            });
          break;
        case "reasoning":
          echo = {
            text: (Array.isArray(item.summary) ? item.summary : [])
              .map((part) =>
                isObject(part) && typeof part.text === "string"
                  ? part.text
                  : "",
              )
              .join(""),
            ...(typeof item.encrypted_content === "string"
              ? { signature: item.encrypted_content }
              : typeof item.id === "string" && item.id.startsWith("rs_")
                ? { signature: item.id.slice(3) }
                : {}),
          };
          break;
        case "function_call": {
          let last = messages.at(-1);
          if (last?.role !== "assistant") {
            last = {
              role: "assistant",
              text: "",
              path,
              toolCalls: [],
              ...(echo ? { echo } : {}),
            };
            messages.push(last);
            echo = undefined;
          }
          last.toolCalls.push({
            id: item.call_id,
            name: item.name,
            arguments: item.arguments,
          });
          break;
        }
        case "function_call_output":
          messages.push({
            role: "tool",
            callId: item.call_id,
            text:
              typeof item.output === "string"
                ? item.output
                : contentText(item.output),
            path,
          });
          break;
      }
    });
    const tools = (Array.isArray(body.tools) ? body.tools : [])
      .filter((tool) => isObject(tool) && tool.type === "function")
      .map((tool) => ({ name: tool.name, parameters: tool.parameters }));
    return { messages, tools };
  },

  callId: () => `call_${hex(12)}`,
  replayRequired: () => true,
  // OpenAI's error for a function_call item sent back without the reasoning item it follows.
  replayError: (previous) => ({
    status: 400,
    body: openAiError(
      400,
      `Item '${previous.message.path}' of type 'function_call' was provided without its required 'reasoning' item: 'rs_${previous.issued.signature}'.`,
      { param: "input" },
    ),
  }),
  reasoningShown: () => true,

  render(answer, context) {
    const { status, incomplete } = outcome(answer.finish);
    return responseObject(
      context,
      status,
      outputItems(answer, context),
      answer.usage,
      incomplete,
    );
  },

  frames(answer, context) {
    const frames = [];
    const emit = (type, payload) =>
      frames.push(
        sse(
          { type, sequence_number: frames.length, ...payload },
          { event: type },
        ),
      );
    const items = outputItems(answer, context);
    const { status, incomplete } = outcome(answer.finish);
    const started = responseObject(context, "in_progress", [], null, null);
    emit("response.created", { response: started });
    emit("response.in_progress", { response: started });
    items.forEach((item, output_index) => {
      const item_id = item.id;
      if (item.type === "reasoning") {
        const text = item.summary[0].text;
        const part = { type: "summary_text", text: "" };
        emit("response.output_item.added", {
          output_index,
          item: { ...item, summary: [] },
        });
        emit("response.reasoning_summary_part.added", {
          item_id,
          output_index,
          summary_index: 0,
          part,
        });
        for (const delta of answer.reasoning)
          emit("response.reasoning_summary_text.delta", {
            item_id,
            output_index,
            summary_index: 0,
            delta,
          });
        emit("response.reasoning_summary_text.done", {
          item_id,
          output_index,
          summary_index: 0,
          text,
        });
        emit("response.reasoning_summary_part.done", {
          item_id,
          output_index,
          summary_index: 0,
          part: { ...part, text },
        });
      } else if (item.type === "message") {
        const part = item.content[0];
        emit("response.output_item.added", {
          output_index,
          item: { ...item, status: "in_progress", content: [] },
        });
        emit("response.content_part.added", {
          item_id,
          output_index,
          content_index: 0,
          part: { ...part, text: "" },
        });
        for (const delta of answer.text)
          emit("response.output_text.delta", {
            item_id,
            output_index,
            content_index: 0,
            delta,
            logprobs: [],
          });
        emit("response.output_text.done", {
          item_id,
          output_index,
          content_index: 0,
          text: part.text,
          logprobs: [],
        });
        emit("response.content_part.done", {
          item_id,
          output_index,
          content_index: 0,
          part,
        });
      } else {
        emit("response.output_item.added", {
          output_index,
          item: { ...item, status: "in_progress", arguments: "" },
        });
        for (const delta of halves(item.arguments))
          emit("response.function_call_arguments.delta", {
            item_id,
            ...(context.quirks.missingToolIndex ? {} : { output_index }),
            delta,
          });
        emit("response.function_call_arguments.done", {
          item_id,
          output_index,
          arguments: item.arguments,
        });
      }
      emit("response.output_item.done", { output_index, item });
    });
    const terminal =
      status === "completed" ? "response.completed" : "response.incomplete";
    const final = responseObject(
      context,
      status,
      items,
      answer.usage,
      incomplete,
    );
    emit(terminal, { response: final });
    if (context.quirks.duplicateFinish) emit(terminal, { response: final });
    return { contentType: "text/event-stream; charset=utf-8", frames };
  },

  streamError: (context, message, written) =>
    sse(
      {
        type: "response.failed",
        sequence_number: written,
        response: responseObject(context, "failed", [], null, null, {
          code: "server_error",
          message,
        }),
      },
      { event: "response.failed" },
    ),
  keepalive: (context, streaming) => (streaming ? SSE_COMMENT : "\n"),
};
