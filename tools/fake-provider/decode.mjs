// SPDX-License-Identifier: MIT
/**
 * Decode an answer in any of the four protocols into one aggregate, for tests
 * of the fake provider and of anything that speaks the same protocols (the
 * model gateway's inbound side). Written from the vendor documentation cited
 * in the protocol modules, independently of their encoders; it is not an
 * official SDK client.
 */

/**
 * Split an SSE body into events. Accepts LF, CRLF and CR line ends and counts
 * comment lines.
 *
 * @param {string} text
 * @returns {{events: {event: string | undefined, data: string}[], comments: number}}
 */
export function parseSse(text) {
  const events = [];
  let comments = 0;
  let event;
  let data = [];
  for (const line of `${text}\n\n`.split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (data.length) events.push({ event, data: data.join("\n") });
      event = undefined;
      data = [];
    } else if (line.startsWith(":")) comments++;
    else {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
  return { events, comments };
}

function empty() {
  return {
    reasoning: "",
    text: "",
    toolCalls: [],
    finishes: [],
    usage: undefined,
    error: undefined,
    events: [],
    comments: 0,
    done: false,
  };
}

function chatChoice(result, choice, streamed) {
  const delta = (streamed ? choice.delta : choice.message) ?? {};
  if (typeof delta.reasoning_content === "string")
    result.reasoning += delta.reasoning_content;
  if (typeof delta.content === "string") result.text += delta.content;
  for (const [position, call] of (delta.tool_calls ?? []).entries()) {
    // A streamed delta without an index continues the latest call; a message lists calls in order.
    const index =
      typeof call.index === "number"
        ? call.index
        : streamed
          ? Math.max(0, result.toolCalls.length - 1)
          : position;
    const target = (result.toolCalls[index] ??= {
      id: undefined,
      name: "",
      arguments: "",
    });
    if (call.id) target.id = call.id;
    if (call.function?.name) target.name += call.function.name;
    if (call.function?.arguments) target.arguments += call.function.arguments;
  }
  if (choice.finish_reason) result.finishes.push(choice.finish_reason);
}

function decodeChat(text, streamed) {
  const result = empty();
  if (!streamed) {
    const body = JSON.parse(text);
    for (const choice of body.choices ?? []) chatChoice(result, choice, false);
    result.usage = body.usage;
    return result;
  }
  const { events, comments } = parseSse(text);
  result.comments = comments;
  for (const { data } of events) {
    if (data === "[DONE]") {
      result.done = true;
      continue;
    }
    const chunk = JSON.parse(data);
    result.events.push("chunk");
    if (chunk.error) result.error = chunk.error;
    if (chunk.usage) result.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) chatChoice(result, choice, true);
  }
  return result;
}

function responsesOutput(result, output) {
  for (const item of output ?? []) {
    if (item.type === "reasoning")
      result.reasoning += (item.summary ?? [])
        .map((part) => part.text ?? "")
        .join("");
    else if (item.type === "message")
      result.text += (item.content ?? [])
        .map((part) => part.text ?? "")
        .join("");
    else if (item.type === "function_call")
      result.toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
  }
}

function responsesFinish(result, response) {
  result.finishes.push(
    response.status === "incomplete"
      ? `incomplete:${response.incomplete_details?.reason}`
      : response.status,
  );
  result.usage = response.usage ?? undefined;
}

function decodeResponses(text, streamed) {
  const result = empty();
  if (!streamed) {
    const body = JSON.parse(text);
    responsesOutput(result, body.output);
    responsesFinish(result, body);
    return result;
  }
  const { events, comments } = parseSse(text);
  result.comments = comments;
  const calls = new Map();
  for (const { event, data } of events) {
    const value = JSON.parse(data);
    result.events.push(value.type);
    if (event !== undefined && event !== value.type)
      result.error ??= { message: `event ${event} carries ${value.type}` };
    switch (value.type) {
      case "response.reasoning_summary_text.delta":
        result.reasoning += value.delta;
        break;
      case "response.output_text.delta":
        result.text += value.delta;
        break;
      case "response.output_item.added":
        if (value.item.type === "function_call") {
          const call = {
            id: value.item.call_id,
            name: value.item.name,
            arguments: "",
          };
          calls.set(value.item.id, call);
          result.toolCalls.push(call);
        }
        break;
      case "response.function_call_arguments.delta":
        calls.get(value.item_id).arguments += value.delta;
        break;
      case "response.completed":
      case "response.incomplete":
        result.done = true;
        responsesFinish(result, value.response);
        break;
      case "response.failed":
        result.error = value.response?.error ?? value;
        break;
      case "error":
        result.error = value;
        break;
    }
  }
  return result;
}

function decodeMessages(text, streamed) {
  const result = empty();
  if (!streamed) {
    const body = JSON.parse(text);
    for (const block of body.content ?? []) {
      if (block.type === "thinking") result.reasoning += block.thinking;
      else if (block.type === "text") result.text += block.text;
      else if (block.type === "tool_use")
        result.toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
    }
    if (body.stop_reason) result.finishes.push(body.stop_reason);
    result.usage = body.usage;
    result.signature = body.content?.find(
      (block) => block.type === "thinking",
    )?.signature;
    return result;
  }
  const { events, comments } = parseSse(text);
  result.comments = comments;
  const blocks = new Map();
  let last;
  for (const { event, data } of events) {
    const value = JSON.parse(data);
    result.events.push(value.type);
    if (event !== undefined && event !== value.type)
      result.error ??= { message: `event ${event} carries ${value.type}` };
    switch (value.type) {
      case "message_start":
        result.usage = value.message.usage;
        break;
      case "content_block_start": {
        const block = { ...value.content_block, partial: "" };
        blocks.set(value.index, block);
        last = block;
        if (block.type === "tool_use") result.toolCalls.push(block);
        break;
      }
      case "content_block_delta": {
        const block =
          typeof value.index === "number" ? blocks.get(value.index) : last;
        const delta = value.delta;
        if (delta.type === "thinking_delta") result.reasoning += delta.thinking;
        else if (delta.type === "signature_delta")
          result.signature = delta.signature;
        else if (delta.type === "text_delta") result.text += delta.text;
        else if (delta.type === "input_json_delta")
          block.partial += delta.partial_json;
        break;
      }
      case "message_delta":
        if (value.delta?.stop_reason)
          result.finishes.push(value.delta.stop_reason);
        if (value.usage) result.usage = { ...result.usage, ...value.usage };
        break;
      case "message_stop":
        result.done = true;
        break;
      case "error":
        result.error = value.error;
        break;
    }
  }
  result.toolCalls = result.toolCalls.map((block) => ({
    id: block.id,
    name: block.name,
    arguments: block.partial || JSON.stringify(block.input ?? {}),
  }));
  return result;
}

function geminiChunk(result, value) {
  if (value.error) {
    result.error = value.error;
    return;
  }
  const candidate = value.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    if (typeof part.text === "string") {
      if (part.thought === true) result.reasoning += part.text;
      else result.text += part.text;
    }
    if (part.functionCall)
      result.toolCalls.push({
        id: part.functionCall.id,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    if (part.thoughtSignature) result.signature ??= part.thoughtSignature;
  }
  if (candidate?.finishReason) result.finishes.push(candidate.finishReason);
  if (value.usageMetadata) result.usage = value.usageMetadata;
}

function decodeGemini(text, mode) {
  const result = empty();
  if (mode === "sse") {
    const { events, comments } = parseSse(text);
    result.comments = comments;
    for (const { data } of events) {
      result.events.push("chunk");
      geminiChunk(result, JSON.parse(data));
    }
    return result;
  }
  const body = JSON.parse(text);
  for (const value of Array.isArray(body) ? body : [body]) {
    if (mode === "array") result.events.push("chunk");
    geminiChunk(result, value);
  }
  return result;
}

/**
 * Aggregate one answer.
 *
 * @param {"chat" | "responses" | "messages" | "gemini"} protocol
 * @param {string} text The whole response body.
 * @param {{stream: boolean, sse?: boolean}} form `sse` is Gemini's `alt=sse`;
 *   a Gemini stream without it is a JSON array.
 * @returns {{reasoning: string, text: string, toolCalls: {id?: string, name: string, arguments: string}[],
 *   finishes: string[], usage: unknown, error: unknown, events: string[], comments: number,
 *   done: boolean, signature?: string}} `finishes` lists every finish reason
 *   seen, in the protocol's own values (Responses: the terminal status, or
 *   `incomplete:<reason>`); `events` the event types of a stream; `done` a
 *   Chat `[DONE]`, Responses terminal event or Messages `message_stop`.
 * @throws {SyntaxError} When a JSON payload does not parse.
 */
export function decodeAnswer(protocol, text, form) {
  switch (protocol) {
    case "chat":
      return decodeChat(text, form.stream);
    case "responses":
      return decodeResponses(text, form.stream);
    case "messages":
      return decodeMessages(text, form.stream);
    case "gemini":
      return decodeGemini(
        text,
        !form.stream ? "json" : form.sse ? "sse" : "array",
      );
    default:
      throw new Error(`Unknown protocol ${protocol}`);
  }
}
