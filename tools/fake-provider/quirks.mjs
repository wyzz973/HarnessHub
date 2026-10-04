// SPDX-License-Identifier: MIT
/**
 * Quirk switches of the fake provider (docs/proposals/oss/10-engineering.md
 * §3.4): known misbehaviours of real upstreams that a client must survive.
 * They are set for every request (`quirks` option, `--quirk`) and per script
 * turn; a turn's value replaces the global one.
 *
 * | Quirk | Value | Effect |
 * |---|---|---|
 * | `noUsage` | boolean | No usage in the answer. |
 * | `duplicateFinish` | boolean | Streams repeat their finishing event (Chat finish chunk, Responses terminal event, Messages `message_delta`, Gemini final chunk). |
 * | `missingToolIndex` | boolean | Streamed tool-call argument deltas lack their index (Chat `index`, Responses `output_index`, Messages `index`); Gemini sends calls whole. |
 * | `commentKeepalive` | `true`, ms, or `{durationMs, intervalMs}` | Before the first data, only keepalives for `durationMs` (default 1000), one per `intervalMs` (default 100): SSE comments in streams, JSON whitespace otherwise. |
 * | `htmlBody` | boolean | HTTP 200 with an HTML page instead of the answer. |
 * | `abnormalFinish` | `true` or a string | The answer ends with this finish reason, sent verbatim (default `network_error`). |
 * | `slowHeaders` | ms | Wait this long before sending the response headers. |
 * | `midStreamError` | `true`, a frame count, or `{after, message}` | After `after` frames (default 1) the stream reports an error in the protocol's in-stream form and ends; a non-streaming body is cut off and the connection reset. |
 * | `retryAfter` | `true`, seconds, or `{status, seconds}` | Answer 429 (or 503) with `Retry-After: seconds` (default 1) and the protocol's error body. |
 * | `servedModel` | a model name | Answers name this model instead of the requested one (a relay that swaps models). |
 */
import { isObject } from "./common.mjs";

const MAX_MS = 2 ** 31 - 1;
const BOOLEANS = ["noUsage", "duplicateFinish", "missingToolIndex", "htmlBody"];
export const QUIRKS = Object.freeze([
  ...BOOLEANS,
  "commentKeepalive",
  "abnormalFinish",
  "slowHeaders",
  "midStreamError",
  "retryAfter",
  "servedModel",
]);

/** Every quirk switched off. */
export const NO_QUIRKS = Object.freeze({
  noUsage: false,
  duplicateFinish: false,
  missingToolIndex: false,
  htmlBody: false,
  commentKeepalive: null,
  abnormalFinish: null,
  slowHeaders: 0,
  midStreamError: null,
  retryAfter: null,
  servedModel: null,
});

function integer(value, where, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(
      `${where} must be an integer from ${minimum} to ${maximum}`,
    );
  return value;
}

function fields(value, where, allowed) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${where}.${key} is not a known setting`);
}

/**
 * Validate quirk switches and normalize their values; a switch set to
 * `false` is kept as "off", so that a script turn can turn a global quirk off.
 *
 * @param {unknown} raw `{name: value}`; see the table above.
 * @param {string} [where] Prefix of error messages.
 * @returns {Readonly<Partial<typeof NO_QUIRKS>>} Only the named quirks.
 * @throws {Error} For an unknown quirk or an invalid value.
 */
export function resolveQuirks(raw, where = "quirks") {
  if (!isObject(raw)) throw new Error(`${where} must be an object`);
  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    const at = `${where}.${name}`;
    if (BOOLEANS.includes(name)) {
      if (typeof value !== "boolean")
        throw new Error(`${at} must be true or false`);
      result[name] = value;
      continue;
    }
    switch (name) {
      case "commentKeepalive": {
        if (value === false) result[name] = null;
        else if (value === true)
          result[name] = { durationMs: 1000, intervalMs: 100 };
        else if (typeof value === "number") {
          const durationMs = integer(value, at, 1, MAX_MS);
          result[name] = { durationMs, intervalMs: Math.min(100, durationMs) };
        } else if (isObject(value)) {
          fields(value, at, ["durationMs", "intervalMs"]);
          result[name] = {
            durationMs: integer(
              value.durationMs ?? 1000,
              `${at}.durationMs`,
              1,
              MAX_MS,
            ),
            intervalMs: integer(
              value.intervalMs ?? 100,
              `${at}.intervalMs`,
              1,
              MAX_MS,
            ),
          };
        } else
          throw new Error(
            `${at} must be true, false, a duration or {durationMs, intervalMs}`,
          );
        break;
      }
      case "abnormalFinish":
        if (value === false) result[name] = null;
        else if (value === true) result[name] = "network_error";
        else if (typeof value === "string" && value) result[name] = value;
        else throw new Error(`${at} must be true, false or a finish reason`);
        break;
      case "slowHeaders":
        result[name] = integer(value, at, 0, MAX_MS);
        break;
      case "midStreamError": {
        if (value === false) result[name] = null;
        else if (value === true)
          result[name] = { after: 1, message: "Upstream stream failed" };
        else if (typeof value === "number")
          result[name] = {
            after: integer(value, at, 0, 1_000_000),
            message: "Upstream stream failed",
          };
        else if (isObject(value)) {
          fields(value, at, ["after", "message"]);
          if (
            value.message !== undefined &&
            (typeof value.message !== "string" || !value.message)
          )
            throw new Error(`${at}.message must be a non-empty string`);
          result[name] = {
            after: integer(value.after ?? 1, `${at}.after`, 0, 1_000_000),
            message: value.message ?? "Upstream stream failed",
          };
        } else
          throw new Error(
            `${at} must be true, false, a frame count or {after, message}`,
          );
        break;
      }
      case "retryAfter": {
        if (value === false) result[name] = null;
        else if (value === true) result[name] = { status: 429, seconds: 1 };
        else if (typeof value === "number")
          result[name] = {
            status: 429,
            seconds: integer(value, at, 0, 86_400),
          };
        else if (isObject(value)) {
          fields(value, at, ["status", "seconds"]);
          const status = value.status ?? 429;
          if (status !== 429 && status !== 503)
            throw new Error(`${at}.status must be 429 or 503`);
          result[name] = {
            status,
            seconds: integer(value.seconds ?? 1, `${at}.seconds`, 0, 86_400),
          };
        } else
          throw new Error(
            `${at} must be true, false, seconds or {status, seconds}`,
          );
        break;
      }
      case "servedModel":
        if (value === false) result[name] = null;
        else if (typeof value === "string" && value && value.length <= 200)
          result[name] = value;
        else throw new Error(`${at} must be false or a model name`);
        break;
      default:
        throw new Error(`${at} is not a known quirk (${QUIRKS.join(", ")})`);
    }
  }
  return Object.freeze(result);
}

/** Names of the quirks that are on in a full quirk set, for request records. */
export function activeQuirks(quirks) {
  return QUIRKS.filter((name) => {
    const value = quirks[name];
    return value !== false && value !== null && value !== 0;
  });
}
