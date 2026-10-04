// SPDX-License-Identifier: MIT
/**
 * Shared parts of the protocol suite's files: the 16 directions, unique
 * prompt markers that route each case to its scripted upstream turns, and
 * the final check that the strict upstream saw no unknown field.
 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { conversation, type Conversation } from "./clients.js";
import {
  PROTOCOLS,
  type Protocol,
  type ScriptTurn,
  type Target,
  type UpstreamProvider,
  type UpstreamRecord,
} from "./target.js";

/** An inbound protocol and the upstream protocol it is served by. */
export interface Direction {
  inbound: Protocol;
  upstream: Protocol;
  /** `chat → anthropic`, or `chat → chat (passthrough)`. */
  name: string;
}

export const DIRECTIONS: readonly Direction[] = PROTOCOLS.flatMap((inbound) =>
  PROTOCOLS.map((upstream) => ({
    inbound,
    upstream,
    name: `${inbound} → ${upstream}${inbound === upstream ? " (passthrough)" : ""}`,
  })),
);

/** A 1×1 PNG. */
export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Fields the strict upstream accepts beyond its portable whitelist: the chat
 * upstream stands for OpenAI's own Chat Completions API, which takes
 * `stream_options` and `reasoning_effort`
 * (https://platform.openai.com/docs/api-reference/chat/create). The gateway
 * asks for streamed usage with the first, and Chat clients ask for reasoning
 * with the second. A provider whose upstream rejects them opts into the
 * `drop-fields` patch instead.
 */
export const VENDOR_FIELDS = {
  chat: { declared: { topLevel: ["stream_options", "reasoning_effort"] } },
};

/** One provider per upstream protocol: `up-chat`, `up-responses`, ... */
export const UPSTREAMS: readonly UpstreamProvider[] = PROTOCOLS.map(
  (protocol) => ({ id: `up-${protocol}`, protocol }),
);

/**
 * The scripted upstream of one test file, built while its cases are
 * declared: every case adds its turns behind markers no other case uses.
 */
export class Script {
  readonly turns: ScriptTurn[] = [];
  #count = 0;
  /** A marker for one case's prompt, unique within the file. */
  marker(label: string): string {
    return `[case-${++this.#count}-${label}]`;
  }
  /** Add a turn; returns its index, which the upstream's records name as `script`. */
  add(turn: ScriptTurn): number {
    return this.turns.push(turn) - 1;
  }
}

/**
 * The upstream's records of requests answered by script turn `index`, once
 * there are `count` of them: a record is written when the upstream's
 * response closed, which may be just after the client read it.
 */
export async function answeredBy(
  target: Target,
  index: number,
  count = 1,
): Promise<UpstreamRecord[]> {
  for (let tries = 0; ; tries++) {
    const records = (await target.upstream()).filter(
      (record) => record.script === index,
    );
    if (records.length >= count || tries >= 50) return records;
    await delay(100);
  }
}

/** A conversation through the target's gateway with an upstream provider. */
export function talk(
  target: Target,
  direction: Direction,
  provider = `up-${direction.upstream}`,
  maxRetries = 0,
): Conversation {
  return conversation(direction.inbound, target.model(provider), {
    url: target.gatewayUrl,
    key: target.gatewayKey,
    maxRetries,
  });
}

/** Fail with every field the strict upstream rejected, by request. */
export async function assertNoViolations(target: Target): Promise<void> {
  const rejected = (await target.upstream())
    .filter((record) => record.violations.length > 0)
    .map(
      (record) =>
        `${record.protocol} ${record.path}: ${record.violations
          .map(
            (violation) =>
              `${violation.path} (${violation.rule}: ${violation.message})`,
          )
          .join("; ")}`,
    );
  assert.deepEqual(
    rejected,
    [],
    "the strict upstream saw no unknown or misplaced field",
  );
}
