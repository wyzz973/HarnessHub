// SPDX-License-Identifier: MIT
/**
 * Gemini, `POST /v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent` (https://ai.google.dev/api/generate-content).
 * Requests authenticate with `x-goog-api-key` or `?key=`; errors use the
 * Google API envelope (https://ai.google.dev/gemini-api/docs/troubleshooting,
 * https://cloud.google.com/apis/design/errors). `alt=sse` streams
 * GenerateContentResponse chunks as `data:` events with CRLF line ends (the
 * form @google/genai parses); without it the chunks arrive as one streamed
 * JSON array. Thought parts appear only when the request sets
 * `thinkingConfig.includeThoughts`; the first function call always carries a
 * `thoughtSignature` when the answer has reasoning
 * (https://ai.google.dev/gemini-api/docs/thought-signatures).
 */
import { hex, isObject, sse, SSE_COMMENT } from "./common.mjs";
import { joinPath } from "./validate.mjs";

const required = (path, message) => ({ path, rule: "required", message });
const shape = (path, message) => ({ path, rule: "structure", message });

const STATUSES = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

/** Google error body: `{"error": {"code", "message", "status", "details"?}}`. */
function error(status, message, extra = {}) {
  return {
    error: {
      code: status,
      message,
      status:
        extra.status ??
        STATUSES[status] ??
        (status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT"),
      ...(extra.details ? { details: extra.details } : {}),
    },
  };
}

const FINISH_REASONS = {
  stop: "STOP",
  tool_calls: "STOP",
  length: "MAX_TOKENS",
  content_filter: "SAFETY",
};

const get = (object, ...keys) => {
  const key = keys.find((name) => Object.hasOwn(object, name));
  return key === undefined ? undefined : object[key];
};

function includeThoughts(body) {
  const config = get(body, "generationConfig", "generation_config");
  const thinking = isObject(config)
    ? get(config, "thinkingConfig", "thinking_config")
    : undefined;
  return (
    isObject(thinking) &&
    get(thinking, "includeThoughts", "include_thoughts") === true
  );
}

function args(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function usageMetadata(value) {
  return {
    promptTokenCount: value.input,
    candidatesTokenCount: Math.max(0, value.output - value.reasoning),
    totalTokenCount: value.input + value.output,
    ...(value.reasoning ? { thoughtsTokenCount: value.reasoning } : {}),
  };
}

function textOfParts(parts, thought) {
  return (Array.isArray(parts) ? parts : [])
    .filter(
      (part) =>
        isObject(part) &&
        typeof part.text === "string" &&
        (part.thought === true) === thought,
    )
    .map((part) => part.text)
    .join("");
}

/** @type {import("./protocols.mjs").Protocol} */
export const gemini = {
  name: "gemini",
  credential(request, url) {
    const header = request.headers["x-goog-api-key"];
    if (typeof header === "string" && header)
      return { value: header, via: "x-goog-api-key" };
    const key = url.searchParams.get("key");
    return key ? { value: key, via: "key" } : undefined;
  },
  authFailure: (kind) =>
    kind === "missing"
      ? {
          status: 403,
          body: error(
            403,
            "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
          ),
        }
      : {
          status: 400,
          body: error(400, "API key not valid. Please pass a valid API key.", {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID",
                domain: "googleapis.com",
                metadata: { service: "generativelanguage.googleapis.com" },
              },
            ],
          }),
        },
  error,
  // Protocol-buffer JSON parsing rejects any field the message type lacks,
  // so a blacklisted field reads the same as an unknown one.
  invalid(violations) {
    const [first] = violations;
    let message = first.path
      ? `Invalid value at '${first.path}': ${first.message}`
      : first.message;
    if (first.rule === "unknown" || first.rule === "forbidden") {
      const dot = first.path.lastIndexOf(".");
      const name = first.path.slice(dot + 1);
      message =
        dot < 0
          ? `Invalid JSON payload received. Unknown name "${name}": Cannot find field.`
          : `Invalid JSON payload received. Unknown name "${name}" at '${first.path.slice(0, dot)}': Cannot find field.`;
    }
    return {
      status: 400,
      body: error(400, message, {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: violations.map((violation) => ({
              field: violation.path,
              description: violation.message,
            })),
          },
        ],
      }),
    };
  },

  structure(body) {
    const violations = [];
    if (!Array.isArray(body.contents) || body.contents.length === 0)
      violations.push(required("contents", "must be a non-empty list"));
    else
      body.contents.forEach((content, index) => {
        const path = `contents[${index}]`;
        if (!isObject(content))
          return violations.push(shape(path, "must be an object"));
        if (!Array.isArray(content.parts) || content.parts.length === 0)
          violations.push(
            required(joinPath(path, "parts"), "must be a non-empty list"),
          );
        return undefined;
      });
    if (body.tools !== undefined && !Array.isArray(body.tools))
      violations.push(shape("tools", "must be a list"));
    return violations;
  },

  model: (body, route) => route.model,
  isStream: (body, route) => route.stream,

  read(body) {
    const messages = [];
    const system = get(body, "systemInstruction", "system_instruction");
    if (isObject(system))
      messages.push({
        role: "system",
        text: textOfParts(system.parts, false),
        path: "systemInstruction",
      });
    body.contents.forEach((content, index) => {
      if (!isObject(content)) return;
      const path = `contents[${index}]`;
      const parts = (Array.isArray(content.parts) ? content.parts : []).filter(
        isObject,
      );
      if (content.role === "model") {
        const signed = parts.find(
          (part) =>
            typeof get(part, "thoughtSignature", "thought_signature") ===
            "string",
        );
        const thoughts = textOfParts(parts, true);
        messages.push({
          role: "assistant",
          text: textOfParts(parts, false),
          path,
          toolCalls: parts
            .map((part) => get(part, "functionCall", "function_call"))
            .filter(isObject)
            .map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.args ?? {},
            })),
          ...(signed || thoughts
            ? {
                echo: {
                  text: thoughts,
                  ...(signed
                    ? {
                        signature: get(
                          signed,
                          "thoughtSignature",
                          "thought_signature",
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        });
        return;
      }
      for (const part of parts) {
        const result = get(part, "functionResponse", "function_response");
        if (isObject(result))
          messages.push({ role: "tool", callId: result.id, path });
      }
      const text = textOfParts(parts, false);
      if (text) messages.push({ role: "user", text, path });
    });
    const tools = [];
    for (const tool of Array.isArray(body.tools) ? body.tools : []) {
      if (!isObject(tool)) continue;
      const declarations = get(
        tool,
        "functionDeclarations",
        "function_declarations",
      );
      for (const declaration of Array.isArray(declarations) ? declarations : [])
        if (isObject(declaration))
          tools.push({
            name: declaration.name,
            parameters: get(
              declaration,
              "parameters",
              "parametersJsonSchema",
              "parameters_json_schema",
            ),
          });
    }
    return { messages, tools };
  },

  // The Gemini API does not return call ids; calls are matched by name and arguments.
  callId: () => undefined,
  replayRequired: () => true,
  replayError: (previous) => ({
    status: 400,
    body: error(
      400,
      `Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly. Additional data, function call \`${previous.issued.name}\`, position ${previous.message.path}.`,
    ),
  }),
  reasoningShown: () => true,

  render(answer, context) {
    const parts = [];
    if (answer.reasoning.length && includeThoughts(context.request))
      parts.push({ text: answer.reasoning.join(""), thought: true });
    if (answer.text.length) parts.push({ text: answer.text.join("") });
    parts.push(...callParts(answer));
    return response(
      context,
      parts.length ? parts : [{ text: "" }],
      answer,
      true,
    );
  },

  frames(answer, context) {
    const chunks = [];
    if (includeThoughts(context.request))
      for (const text of answer.reasoning)
        chunks.push([{ text, thought: true }]);
    for (const text of answer.text) chunks.push([{ text }]);
    if (answer.toolCalls.length) chunks.push(callParts(answer));
    if (!chunks.length) chunks.push([{ text: "" }]);
    const values = chunks.map((parts, index) =>
      response(context, parts, answer, index === chunks.length - 1),
    );
    if (context.quirks.duplicateFinish)
      values.push(response(context, [{ text: "" }], answer, true));
    if (context.sse)
      return {
        contentType: "text/event-stream",
        frames: values.map((value) => sse(value, { newline: "\r\n" })),
      };
    return {
      contentType: "application/json; charset=UTF-8",
      frames: [
        ...values.map(
          (value, index) => `${index ? ",\r\n" : "["}${JSON.stringify(value)}`,
        ),
        "]",
      ],
    };
  },

  // A failure after the stream started is one more element carrying `error`.
  streamError(context, message, written) {
    const value = error(500, message);
    if (context.sse) return sse(value, { newline: "\r\n" });
    return `${written ? ",\r\n" : "["}${JSON.stringify(value)}]`;
  },
  keepalive: (context, streaming) =>
    streaming && context.sse ? SSE_COMMENT : "\n",
};

function callParts(answer) {
  return answer.toolCalls.map((call, index) => ({
    functionCall: { name: call.name, args: args(call.arguments) },
    ...(index === 0 && answer.reasoning.length
      ? { thoughtSignature: answer.signature }
      : {}),
  }));
}

function response(context, parts, answer, final) {
  return {
    candidates: [
      {
        content: { parts, role: "model" },
        ...(final
          ? { finishReason: FINISH_REASONS[answer.finish] ?? answer.finish }
          : {}),
        index: 0,
      },
    ],
    ...(final && answer.usage
      ? { usageMetadata: usageMetadata(answer.usage) }
      : {}),
    modelVersion: context.model,
    responseId: context.id,
  };
}

/** Gemini response ids are opaque strings. */
export function geminiResponseId() {
  return hex(12);
}
