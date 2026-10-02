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
  /^\/v1\/(?:chat\/completions|responses|messages(?:\/count_tokens)?|models(?:\/.*)?)$/;
const PREFIXLESS_PATH =
  /^\/(?:chat\/completions|responses|messages(?:\/count_tokens)?|models(?:\/.*)?)$/;

/**
 * Whether a request path goes to the model gateway (03-model-plane section
 * 1): `/v1beta/*` and `/v1alpha/*`; under `/v1` only the model protocol
 * paths (`chat/completions`, `responses`, `messages`,
 * `messages/count_tokens`, `models` and `models/...`), because the
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

/** The path of a raw request target, without query; "" when it is not origin-form. */
export function requestPath(target: string | undefined): string {
  if (!target?.startsWith("/")) return "";
  const end = target.search(/[?#]/);
  return end < 0 ? target : target.slice(0, end);
}
