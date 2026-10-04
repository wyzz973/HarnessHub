// SPDX-License-Identifier: MIT
/**
 * Gateway Keys in the request path, for clients that cannot send a header
 * of their own (ADR 0030 for Codex signed in with ChatGPT, ADR 0033 for the
 * model protocol paths): the segment is taken out before anything else sees
 * the path, so the key reaches no ledger entry, log line, export or
 * upstream.
 */
import { parseGatewayKey } from "@harnesshub/core/model-plane";

/** The prefix of a model protocol path with a key in it: `/k/<agent key>/v1/...`. */
export const KEY_PATH_PREFIX = "/k";

/**
 * The first segment after `prefix` in `path` (which starts with
 * `${prefix}/` or is `prefix`), the rest of the path after it, and the
 * segment again as `key` when it has the form of a Gateway Key; whether the
 * key is known and active is for the caller to check.
 */
export function pathKey(
  path: string,
  prefix: string,
): { segment: string; rest: string; key?: string } {
  const after = path.slice(prefix.length + 1);
  const end = after.indexOf("/");
  const segment = end < 0 ? after : after.slice(0, end);
  const rest = end < 0 ? "" : after.slice(end);
  return parseGatewayKey(segment)
    ? { segment, rest, key: segment }
    : { segment, rest };
}

/**
 * A path under {@link KEY_PATH_PREFIX}: the model protocol path after the
 * key segment (`/` when nothing follows it), and the key when the segment
 * has a Gateway Key's form. Undefined for any other path.
 */
export function keyPathRoute(
  path: string,
): { path: string; key?: string } | undefined {
  if (!path.startsWith(`${KEY_PATH_PREFIX}/`)) return undefined;
  const { rest, key } = pathKey(path, KEY_PATH_PREFIX);
  return { path: rest || "/", ...(key !== undefined ? { key } : {}) };
}
