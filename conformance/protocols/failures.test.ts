// SPDX-License-Identifier: MIT
/**
 * Upstream failures in all 16 directions, with each inbound protocol's
 * official SDK (03 section 11): 400, 401, 429 with and without Retry-After,
 * 500 and context overflow before the answer, and a dropped connection or
 * an in-stream error after it started. The SDK must raise its own error type
 * with the matching status, and Retry-After must be honoured by the gateway
 * and passed on to SDKs that honour it. Every case has its own provider, so
 * one case's breaker never answers for another; all of them run with the
 * gateway's default retry policy unless a case says otherwise.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { failureOf, type AskOptions, type ClientFailure } from "./clients.js";
import {
  answeredBy,
  assertNoViolations,
  DIRECTIONS,
  Script,
  talk,
  VENDOR_FIELDS,
  type Direction,
} from "./suite.js";
import { startTarget, type Target, type UpstreamProvider } from "./target.js";

const script = new Script();
const providers: UpstreamProvider[] = [];
const cases: { name: string; run: (target: Target) => Promise<void> }[] = [];

/** The SDK error class of an HTTP status, per inbound protocol. */
function errorClass(direction: Direction, status: number): string {
  if (direction.inbound === "gemini") return "ApiError";
  const named: Record<number, string> = {
    400: "BadRequestError",
    401: "AuthenticationError",
    429: "RateLimitError",
  };
  return named[status] ?? (status >= 500 ? "InternalServerError" : "APIError");
}

/** The failure a call ends in; fails the test when it succeeds. */
async function failure(call: Promise<unknown>): Promise<ClientFailure> {
  try {
    await call;
  } catch (error) {
    return failureOf(error);
  }
  assert.fail("the call succeeded");
}

/** A provider of its own for one case, serving the direction's upstream protocol. */
function provider(
  direction: Direction,
  retry?: Record<string, number>,
): string {
  const id = `p${providers.length + 1}`;
  providers.push({
    id,
    protocol: direction.upstream,
    ...(retry ? { retry } : {}),
  });
  return id;
}

for (const direction of DIRECTIONS) {
  const name = direction.name;
  const ask = (marker: string, stream: boolean): AskOptions => ({
    stream,
    text: `${marker} Go.`,
  });

  for (const [status, message] of [
    [400, "Invalid value for 'temperature': must be at most 2."],
    [401, "Incorrect API key provided."],
    [500, "The server had an error while processing your request."],
  ] as const) {
    const marker = script.marker(`status-${status}`);
    const id = provider(direction);
    script.add({
      when: { contains: marker },
      repeat: true,
      status,
      error: message,
    });
    cases.push({
      name: `${name}: upstream ${status}`,
      async run(target) {
        const seen = await failure(
          talk(target, direction, id).ask(ask(marker, true)),
        );
        assert.equal(seen.status, status);
        assert.equal(seen.type, errorClass(direction, status));
        assert.match(
          seen.message,
          new RegExp(
            message.slice(0, 20).replace(/[.*+?^${}()|[\]\\']/g, "\\$&"),
          ),
        );
      },
    });
  }

  for (const stream of [false, true]) {
    const marker = script.marker("overflow");
    const id = provider(direction);
    script.add({
      when: { contains: marker },
      repeat: true,
      status: 400,
      error:
        "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.",
    });
    cases.push({
      name: `${name}, ${stream ? "streamed" : "not streamed"}: context overflow in the inbound protocol's own words`,
      async run(target) {
        const seen = await failure(
          talk(target, direction, id).ask(ask(marker, stream)),
        );
        switch (direction.inbound) {
          case "chat":
            assert.equal(seen.status, 400);
            assert.equal(seen.code, "context_length_exceeded");
            break;
          case "responses":
            // Codex recognizes an overflow only as a streamed response.failed.
            if (stream) assert.equal(seen.type, "StreamFailure");
            else assert.equal(seen.status, 400);
            assert.equal(seen.code, "context_length_exceeded");
            break;
          case "anthropic":
            assert.equal(seen.status, 400);
            assert.match(
              seen.message,
              /prompt is too long: 9000 tokens > 8192 maximum/,
            );
            break;
          case "gemini":
            assert.equal(seen.status, 400);
            assert.match(
              seen.message,
              /input token count \(9000\) exceeds the maximum number of tokens allowed \(8192\)/,
            );
            break;
        }
      },
    });
  }

  {
    const marker = script.marker("429-retry-after");
    const id = provider(direction);
    const limited = script.add({
      when: { contains: marker },
      repeat: true,
      quirks: { retryAfter: { status: 429, seconds: 1 } },
    });
    cases.push({
      name: `${name}: upstream 429 with Retry-After, retried by the gateway, then passed on`,
      async run(target) {
        const seen = await failure(
          talk(target, direction, id).ask(ask(marker, true)),
        );
        assert.equal(seen.status, 429);
        assert.equal(seen.type, errorClass(direction, 429));
        if (direction.inbound === "gemini")
          assert.match(seen.message, /"retryDelay":"1s"/);
        else assert.equal(seen.retryAfter, "1");
        const attempts = await answeredBy(target, limited, 2);
        assert.ok(
          attempts.length >= 2,
          "the gateway retried within the Retry-After cap",
        );
      },
    });
  }

  {
    const marker = script.marker("429");
    const id = provider(direction);
    script.add({
      when: { contains: marker },
      repeat: true,
      status: 429,
      error: "Rate limit reached for requests.",
    });
    cases.push({
      name: `${name}: upstream 429 without Retry-After`,
      async run(target) {
        const seen = await failure(
          talk(target, direction, id).ask(ask(marker, true)),
        );
        assert.equal(seen.status, 429);
        assert.equal(seen.type, errorClass(direction, 429));
      },
    });
  }

  {
    // Once 429 with Retry-After: 1, then an answer: the gateway waits and retries.
    const marker = script.marker("gateway-waits");
    const id = provider(direction);
    const limited = script.add({
      when: { contains: marker },
      quirks: { retryAfter: { status: 429, seconds: 1 } },
    });
    const answered = script.add({
      when: { contains: marker },
      repeat: true,
      text: "After the wait.",
    });
    cases.push({
      name: `${name}: the gateway honours Retry-After before its retry`,
      async run(target) {
        const turn = await talk(target, direction, id).ask(ask(marker, true));
        assert.equal(turn.text, "After the wait.");
        const [first] = await answeredBy(target, limited);
        const [second] = await answeredBy(target, answered);
        assert.ok(first && second);
        const waited = Date.parse(second.at) - Date.parse(first.at);
        assert.ok(waited >= 990, `the retry came ${waited} ms after the 429`);
      },
    });
  }

  {
    // The same through a group that never retries: the SDK sees the 429 and honours it.
    const marker = script.marker("client-waits");
    const id = provider(direction, { perCandidate: 0, totalAttempts: 1 });
    const limited = script.add({
      when: { contains: marker },
      quirks: { retryAfter: { status: 429, seconds: 1 } },
    });
    script.add({
      when: { contains: marker },
      repeat: true,
      text: "After the wait.",
    });
    cases.push({
      name: `${name}: Retry-After reaches the SDK${direction.inbound === "gemini" ? " as RetryInfo" : ", which honours it"}`,
      async run(target) {
        if (direction.inbound === "gemini") {
          // @google/genai retries with its own backoff only; Gemini clients read RetryInfo.
          const seen = await failure(
            talk(target, direction, id).ask(ask(marker, true)),
          );
          assert.equal(seen.status, 429);
          assert.match(seen.message, /"retryDelay":"1s"/);
          return;
        }
        const started = performance.now();
        const turn = await talk(target, direction, id, 1).ask(
          ask(marker, true),
        );
        const elapsed = performance.now() - started;
        assert.equal(turn.text, "After the wait.");
        assert.ok(
          elapsed >= 1000,
          `the SDK retried after ${Math.round(elapsed)} ms`,
        );
        assert.equal((await answeredBy(target, limited)).length, 1);
      },
    });
  }

  for (const [quirk, label] of [
    [{ disconnect: 3 }, "the upstream drops the connection mid-stream"],
    [
      {
        midStreamError: { after: 3, message: "Upstream overloaded mid-stream" },
      },
      "the upstream reports an error mid-stream",
    ],
  ] as const) {
    const marker = script.marker("mid-stream");
    const id = provider(direction);
    script.add({
      when: { contains: marker },
      repeat: true,
      text: ["one ", "two ", "three ", "four ", "five"],
      quirks: quirk,
    });
    cases.push({
      name: `${name}: ${label}`,
      async run(target) {
        const seen = await failure(
          talk(target, direction, id).ask(ask(marker, true)),
        );
        // @google/genai raises ApiError for the bare error object only when
        // it arrives as a network chunk of its own; read together with the
        // event before it, the SDK fails on an incomplete segment instead.
        assert.ok(
          seen.api ||
            (direction.inbound === "gemini" &&
              /Incomplete JSON segment at the end/.test(seen.message)),
          `the SDK raised an API error, not ${seen.type}: ${seen.message}`,
        );
      },
    });
  }
}

let target: Target;
before(async () => {
  target = await startTarget({
    script: { turns: script.turns },
    providers,
    fields: VENDOR_FIELDS,
  });
});
after(async () => {
  await target?.close();
});

void describe("upstream failures in 16 directions", { concurrency: 32 }, () => {
  for (const each of cases) void test(each.name, () => each.run(target));
});

void test("the strict upstream recorded no field violations", async () => {
  await assertNoViolations(target);
});
