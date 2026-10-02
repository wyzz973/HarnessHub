// SPDX-License-Identifier: MIT
/**
 * Helpers shared by the fake provider's protocol modules: value checks, SSE
 * framing, identifiers, token estimates and bounded body reading. No
 * dependencies and no network access.
 */
import { randomBytes } from "node:crypto";

/** A plain JSON object (not null, not an array). */
export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Random lower-case hex of `bytes` bytes, for response and call identifiers. */
export function hex(bytes = 12) {
  return randomBytes(bytes).toString("hex");
}

/**
 * One server-sent event. `event` adds an `event:` line (Responses and
 * Messages name every event; Chat and Gemini send `data:` only). `newline`
 * is the line terminator.
 *
 * @param {unknown} data A value to JSON-encode, or a string sent verbatim.
 * @param {{event?: string, newline?: string}} [options]
 */
export function sse(data, { event, newline = "\n" } = {}) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `${event ? `event: ${event}${newline}` : ""}data: ${payload}${newline}${newline}`;
}

/** An SSE comment frame: ignored by conforming parsers, carries no data. */
export const SSE_COMMENT = ": keepalive\n\n";

/**
 * Text of a content value: a string, or the `text` of every part that has
 * one (Chat, Responses and Messages content parts all use `text`).
 */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isObject(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

/** Split text into two chunks between code points; short text stays whole. */
export function halves(text, minimum = 2) {
  const points = Array.from(text);
  if (points.length < minimum) return text ? [text] : [];
  const middle = Math.ceil(points.length / 2);
  return [points.slice(0, middle).join(""), points.slice(middle).join("")];
}

/**
 * Rough token count of `chars` characters (four per token, at least one), used
 * for usage numbers; the fake has no tokenizer and nothing depends on accuracy.
 */
export function estimateTokens(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Canonical JSON text of tool arguments, so that the same call compares equal
 * whether a client sends it back as text or as an object.
 */
export function canonicalArguments(value) {
  if (typeof value !== "string") return JSON.stringify(value ?? null);
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

/** Shorten client-controlled text (field names, role values) before it is recorded. */
export function clip(value, limit = 64) {
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Read a request body with a byte bound.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {number} limit Largest accepted body in bytes.
 * @returns {Promise<Buffer>} Rejects with `{statusCode: 413}` above the
 *   bound (the rest of the body is read and dropped, so the caller can still
 *   answer), or with `{clientClosed: true}` when the client goes away.
 */
export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(
          Object.assign(new Error("Request body is too large"), {
            statusCode: 413,
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    // A request stream fails only when the client connection does.
    request.once("error", (error) =>
      reject(Object.assign(error, { clientClosed: true })),
    );
    request.once("close", () => {
      if (!request.complete)
        reject(
          Object.assign(
            new Error("Client closed the request before its body ended"),
            { clientClosed: true },
          ),
        );
    });
  });
}
