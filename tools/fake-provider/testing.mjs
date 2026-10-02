// SPDX-License-Identifier: MIT
/**
 * Request builders for tests of the fake provider: a minimal valid request
 * of each protocol, a shell tool definition and the native follow-up that
 * answers a tool call. All keys are synthetic canaries.
 */
import { decodeAnswer } from "./decode.mjs";

/** The synthetic key the tests configure; never a real credential. */
export const KEY = "fake-provider-canary-key-0f3a9c";
export const MODEL = "upstream-sim";

const SCHEMA = {
  type: "object",
  properties: { command: { type: "string", description: "Shell command" } },
  required: ["command"],
};

/** Native auth headers of a protocol for `key`. */
export function authHeaders(protocol, key) {
  if (key === null) return {};
  switch (protocol) {
    case "messages":
      return { "x-api-key": key };
    case "gemini":
      return { "x-goog-api-key": key };
    default:
      return { authorization: `Bearer ${key}` };
  }
}

/** Path of a protocol's call endpoint. */
export function callPath(
  protocol,
  { stream = false, sse = true, model = MODEL } = {},
) {
  switch (protocol) {
    case "chat":
      return "/v1/chat/completions";
    case "responses":
      return "/v1/responses";
    case "messages":
      return "/v1/messages";
    case "gemini":
      return `/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent" : "generateContent"}${stream && sse ? "?alt=sse" : ""}`;
    default:
      throw new Error(`Unknown protocol ${protocol}`);
  }
}

/** A minimal valid request body with one user message. */
export function minimalBody(
  protocol,
  { stream = false, text = "hi", model = MODEL } = {},
) {
  switch (protocol) {
    case "chat":
      return { model, stream, messages: [{ role: "user", content: text }] };
    case "responses":
      return {
        model,
        stream,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        ],
      };
    case "messages":
      return {
        model,
        stream,
        max_tokens: 256,
        messages: [{ role: "user", content: text }],
      };
    case "gemini":
      return { contents: [{ role: "user", parts: [{ text }] }] };
    default:
      throw new Error(`Unknown protocol ${protocol}`);
  }
}

/** The `tools` of a request offering one shell tool named `bash`. */
export function shellTools(protocol, name = "bash") {
  switch (protocol) {
    case "chat":
      return [
        {
          type: "function",
          function: { name, description: "Run a command", parameters: SCHEMA },
        },
      ];
    case "responses":
      return [
        {
          type: "function",
          name,
          description: "Run a command",
          parameters: SCHEMA,
        },
      ];
    case "messages":
      return [{ name, description: "Run a command", input_schema: SCHEMA }];
    case "gemini":
      return [
        {
          functionDeclarations: [
            { name, description: "Run a command", parameters: SCHEMA },
          ],
        },
      ];
    default:
      throw new Error(`Unknown protocol ${protocol}`);
  }
}

/**
 * The request that answers the tool call of `answer` (decoded by
 * decodeAnswer), sent after `body`; `echo` sends the reasoning back in the
 * protocol's native place.
 */
export function followUp(
  protocol,
  body,
  answer,
  { echo = true, result = "done" } = {},
) {
  const [call] = answer.toolCalls;
  const next = structuredClone(body);
  switch (protocol) {
    case "chat":
      next.messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
          ...(echo ? { reasoning_content: answer.reasoning } : {}),
        },
        { role: "tool", tool_call_id: call.id, content: result },
      );
      break;
    case "responses":
      next.input.push(
        ...(echo
          ? [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: answer.reasoning }],
              },
            ]
          : []),
        {
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        },
        { type: "function_call_output", call_id: call.id, output: result },
      );
      break;
    case "messages":
      next.messages.push(
        {
          role: "assistant",
          content: [
            ...(echo
              ? [
                  {
                    type: "thinking",
                    thinking: answer.reasoning,
                    signature: answer.signature,
                  },
                ]
              : []),
            {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: JSON.parse(call.arguments),
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call.id, content: result },
          ],
        },
      );
      break;
    case "gemini":
      next.contents.push(
        {
          role: "model",
          parts: [
            {
              functionCall: {
                name: call.name,
                args: JSON.parse(call.arguments),
              },
              ...(echo ? { thoughtSignature: answer.signature } : {}),
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: call.name,
                response: { output: result },
              },
            },
          ],
        },
      );
      break;
  }
  return next;
}

/**
 * Send one request and read the whole response.
 *
 * @param {{url: string}} fake
 * @param {string} protocol
 * @param {{stream?: boolean, sse?: boolean, text?: string, model?: string,
 *   body?: object | ((body: object) => object), key?: string | null,
 *   headers?: Record<string, string>, raw?: string, signal?: AbortSignal}} [options]
 *   `body` is merged over the minimal body (or maps it); `raw` replaces the body text.
 * @returns {Promise<{status: number, headers: Headers, text: string, json: any,
 *   answer: ReturnType<typeof decodeAnswer> | undefined, body: object}>}
 *   `json` is the parsed body when it is JSON; `answer` the decoded 200 answer.
 */
export async function send(fake, protocol, options = {}) {
  const stream = options.stream ?? false;
  const base = minimalBody(protocol, {
    stream,
    text: options.text,
    model: options.model,
  });
  const body =
    typeof options.body === "function"
      ? options.body(base)
      : { ...base, ...(options.body ?? {}) };
  const response = await fetch(
    fake.url +
      callPath(protocol, { stream, sse: options.sse, model: options.model }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(protocol === "messages"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
        ...authHeaders(protocol, options.key === undefined ? KEY : options.key),
        ...(options.headers ?? {}),
      },
      body: options.raw ?? JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const text = await response.text();
  let json;
  if (/json/.test(response.headers.get("content-type") ?? ""))
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  const answer =
    response.status === 200 &&
    !/html/.test(response.headers.get("content-type") ?? "")
      ? decodeAnswer(protocol, text, { stream, sse: options.sse ?? true })
      : undefined;
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    answer,
    body,
  };
}
