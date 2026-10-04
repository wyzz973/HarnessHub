// SPDX-License-Identifier: MIT
/**
 * Keepalive in all 16 directions (03 sections 6 and 11): the upstream sends
 * only SSE comments (whitespace for JSON bodies) for longer than the
 * gateway's keepalive gap of 10 s before its first data. A stream must
 * bring the client its protocol's keepalive before that data, in a form its
 * official SDK reads without error, and then the whole answer; a JSON answer
 * must arrive whole. The providers are reached through route groups that
 * never retry: with an alternative left, the gateway holds output for its
 * first-byte window (15 s) instead, as designed.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  assertNoViolations,
  DIRECTIONS,
  Script,
  talk,
  VENDOR_FIELDS,
} from "./suite.js";
import {
  PROTOCOLS,
  startTarget,
  type Target,
  type UpstreamProvider,
} from "./target.js";

/** How long the upstream sends nothing but keepalives. */
const SILENCE_MS = 11_500;

const PROVIDERS: UpstreamProvider[] = PROTOCOLS.map((protocol) => ({
  id: `once-${protocol}`,
  protocol,
  retry: { perCandidate: 0, totalAttempts: 1 },
}));

const script = new Script();
const cases: { name: string; run: (target: Target) => Promise<void> }[] = [];

for (const direction of DIRECTIONS)
  for (const stream of [false, true]) {
    const marker = script.marker("keepalive");
    script.add({
      when: { contains: marker },
      repeat: true,
      text: "Still here.",
      quirks: { commentKeepalive: { durationMs: SILENCE_MS, intervalMs: 500 } },
    });
    cases.push({
      name: `${direction.name}, ${stream ? "streamed" : "not streamed"}: the upstream sends only keepalives for ${SILENCE_MS / 1000} s`,
      async run(target) {
        const turn = await talk(
          target,
          direction,
          `once-${direction.upstream}`,
        ).ask({
          stream,
          text: `${marker} Take your time.`,
        });
        assert.equal(turn.text, "Still here.");
        if (stream)
          assert.ok(
            turn.firstByteMs !== undefined && turn.firstByteMs < SILENCE_MS,
            `the first byte came after ${Math.round(turn.firstByteMs ?? -1)} ms`,
          );
      },
    });
  }

let target: Target;
before(async () => {
  target = await startTarget({
    script: { turns: script.turns },
    providers: PROVIDERS,
    fields: VENDOR_FIELDS,
  });
});
after(async () => {
  await target?.close();
});

void describe("keepalive in 16 directions", { concurrency: 32 }, () => {
  for (const each of cases) void test(each.name, () => each.run(target));
});

void test("the strict upstream recorded no field violations", async () => {
  await assertNoViolations(target);
});
