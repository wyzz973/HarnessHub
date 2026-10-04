// SPDX-License-Identifier: MIT
import type { AdapterTarget } from "./types.js";

/**
 * The gateway's `/v1` with the key in its path, `<gateway>/k/<key>/v1`, for
 * an agent that cannot send a key of its own (ADR 0033): the gateway takes
 * the key out of the path on loopback connections only and accepts only
 * agent keys there. The prefix is the gateway's `KEY_PATH_PREFIX`.
 */
export function keyPathV1(target: AdapterTarget): string {
  return `${target.baseUrl}/k/${target.keyText}/v1`;
}
