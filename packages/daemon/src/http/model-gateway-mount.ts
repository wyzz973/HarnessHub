// SPDX-License-Identifier: MIT
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The shared model gateway as the HTTP server mounts it: a raw Node handler
 * (`createGatewayHandler` of `@harnesshub/gateway/server`, injected by the
 * composition root) that answers its paths before Fastify sees them.
 */
export interface ModelGatewayMount {
  handle(request: IncomingMessage, response: ServerResponse): void;
  /** Applied to the listener as `server.headersTimeout`. */
  headersTimeoutMs: number;
}

const V1_MODEL_PATH =
  /^\/v1\/(?:chat\/completions|responses(?:\/compact)?|messages(?:\/count_tokens)?|models(?:\/.*)?|images\/(?:generations|edits)|harnesshub\/limit)$/;
const PREFIXLESS_PATH =
  /^\/(?:chat\/completions|responses(?:\/compact)?|messages(?:\/count_tokens)?|models(?:\/.*)?)$/;

/**
 * Whether a request path goes to the model gateway (03-model-plane section
 * 1): `/v1beta/*` and `/v1alpha/*`; under `/v1` only the model protocol
 * paths (`chat/completions`, `responses`, `responses/compact` (refused
 * there with a clear 400), `messages`, `messages/count_tokens`, `models`,
 * `models/...`, `images/generations`, `images/edits` and a key's own
 * `harnesshub/limit`), because the
 * management routes still live under `/v1` until they move to `/api/v1`;
 * and the same paths without `/v1`. Repeated and trailing slashes are
 * ignored as the gateway ignores them.
 */
export function isModelGatewayPath(pathname: string): boolean {
  const path = pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  return (
    /^\/v1(?:beta|alpha)(?:\/|$)/.test(path) ||
    V1_MODEL_PATH.test(path) ||
    PREFIXLESS_PATH.test(path)
  );
}

/**
 * Whether a request path goes to the gateway's Codex passthrough
 * (`/backend-api/codex` and below), which Codex signed in with ChatGPT uses
 * as its `openai_base_url`. Only the loopback listener mounts it; the LAN
 * listener of gateway sharing answers 404 for it.
 */
export function isCodexPassthroughPath(pathname: string): boolean {
  const path = pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  return (
    path === "/backend-api/codex" || path.startsWith("/backend-api/codex/")
  );
}

/**
 * Whether a request path is one the gateway serves to agents on this
 * computer only (ADR 0033): anything under `/k/` (a model protocol path
 * behind a Gateway Key segment, `/k/<key>/v1/...`; the gateway answers 404
 * for the rest without repeating the path, which may hold a key) and Muse
 * Code's model list, `/muse-code/models`. Only the loopback listener mounts
 * them; the LAN listener of gateway sharing answers 404 for them.
 */
export function isLocalAgentPath(pathname: string): boolean {
  const path = pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  return path === "/muse-code/models" || path.startsWith("/k/");
}

/** The path of a raw request target, without query; "" when it is not origin-form. */
export function requestPath(target: string | undefined): string {
  if (!target?.startsWith("/")) return "";
  const end = target.search(/[?#]/);
  return end < 0 ? target : target.slice(0, end);
}

/**
 * Whether a raw request path is outside the form the listeners dispatch on,
 * so that it could reach a handler other than the one its resolved form
 * names (and carry a key there): a leading `//`, a `.` or `..` segment, a
 * backslash, an encoded dot (`%2E`), or an encoded slash or backslash
 * (`%2F`, `%5C`) outside `/api/`, whose operations take a Model Ref with
 * its slash encoded (`GET /api/v1/models/{ref}`). Both the daemon's
 * listener and the LAN listener refuse such a path with
 * {@link refuseNonCanonical} before dispatch.
 */
export function nonCanonicalPath(pathname: string): boolean {
  return (
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(pathname) ||
    /%2e/i.test(pathname) ||
    (!pathname.startsWith("/api/") && /%(?:2f|5c)/i.test(pathname))
  );
}

/** Answers 400 `path_not_canonical` without repeating the path, and drains the request. */
export function refuseNonCanonical(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  request.resume();
  response.on("error", () => undefined);
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: {
        code: "path_not_canonical",
        message:
          "The request path holds a dot segment, an encoded dot or slash, a backslash, or begins with //",
      },
    }),
  );
}
