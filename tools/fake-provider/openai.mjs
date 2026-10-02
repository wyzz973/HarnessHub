// SPDX-License-Identifier: MIT
/**
 * Authentication and error envelopes shared by the OpenAI protocols (Chat
 * Completions, Responses and `GET /v1/models`).
 * https://platform.openai.com/docs/guides/error-codes
 */
import { isObject } from "./common.mjs";

/** `Authorization: Bearer <key>`; https://platform.openai.com/docs/api-reference/authentication */
export function bearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  // `\s+` then `\S` cannot overlap, so matching stays linear in the header length.
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match ? { value: match[1], via: "authorization" } : undefined;
}

const TYPES = {
  401: "invalid_request_error",
  403: "permission_denied",
  404: "invalid_request_error",
  429: "requests",
};

/**
 * OpenAI error body: `{"error": {"message", "type", "param", "code"}}`.
 *
 * @param {number} status HTTP status; picks the default `type`.
 * @param {string} message
 * @param {{type?: string, param?: string | null, code?: string | null}} [extra]
 */
export function openAiError(status, message, extra = {}) {
  return {
    error: {
      message,
      type:
        extra.type ??
        TYPES[status] ??
        (status >= 500 ? "server_error" : "invalid_request_error"),
      param: extra.param ?? null,
      code:
        extra.code !== undefined
          ? extra.code
          : status === 429
            ? "rate_limit_exceeded"
            : null,
    },
  };
}

/** Native 401 bodies; the presented key is never echoed. */
export function openAiAuthFailure(kind) {
  return {
    status: 401,
    body:
      kind === "missing"
        ? openAiError(
            401,
            "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth.",
          )
        : openAiError(401, "Incorrect API key provided.", {
            code: "invalid_api_key",
          }),
  };
}

const CODES = {
  unknown: "unknown_parameter",
  forbidden: "unsupported_parameter",
  required: "missing_required_parameter",
};

function describe({ path, rule, message }) {
  switch (rule) {
    case "unknown":
      return `Unknown parameter: '${path}'.`;
    case "forbidden":
      return `Unsupported parameter: '${path}' is ${message}.`;
    case "required":
      return `Missing required parameter: '${path}' (${message}).`;
    default:
      return path ? `Invalid '${path}': ${message}.` : `${message}.`;
  }
}

/** A 400 for violations; `param` carries the first violation's path. */
export function openAiInvalid(violations) {
  const [first] = violations;
  return {
    status: 400,
    body: openAiError(400, `${describe(first)}${more(violations)}`, {
      param: first.path || null,
      code: CODES[first.rule] ?? "invalid_value",
    }),
  };
}

/** ` (2 more: a, b)` for the violations after the first one. */
export function more(violations) {
  if (violations.length < 2) return "";
  const rest = violations.slice(1);
  const listed = rest.slice(0, 5).map((violation) => violation.path);
  return ` (${rest.length} more: ${listed.join(", ")}${rest.length > 5 ? ", ..." : ""})`;
}

/** Chat and Responses requests stream only with `stream: true`. */
export function streamRequested(body) {
  return isObject(body) && body.stream === true;
}
