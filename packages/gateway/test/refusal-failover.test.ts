// SPDX-License-Identifier: MIT
/**
 * Refusals a 400 or 422 stands for (Magpie `retryable`, `shapeRefused`,
 * `policyRefusal`, `refusedReply` and `withTokenFloor`): which fail over,
 * which skip the API that gave them, which rest nothing, and which reach the
 * client because they are its own fault for every provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  CredentialId,
  ModelRef,
  ProviderId,
} from "@harnesshub/core/model-plane";
import {
  Breakers,
  matesFirst,
  policyRefusal,
  tokenFloor,
  withTokenFloor,
  type Candidate,
} from "../src/routing.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  chatChunks,
  delta,
  events,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  until,
  upstream,
  type Reply,
} from "./shared-support.js";

const MESSAGES = [{ role: "user", content: "hi" }];
const KEY_A = "Bearer sk-upstream-a-0001";

void test("a safety filter's refusal is read from its code, as Magpie reads it", () => {
  const cases: [string, boolean][] = [
    [
      '{"error":{"type":"invalid_request_error","code":"bio_policy","message":"This content was flagged for possible biological risk. If this seems wrong, try rephrasing your request.","param":null}}',
      true,
    ],
    [
      '{"type":"invalid_request_error","code":"bio_policy","message":"flagged"}',
      true,
    ],
    ['{"error":{"code":"cyber_policy","message":"x"}}', true],
    [
      '{"error":{"code":"content_filter","message":"The response was filtered","innererror":{"code":"ResponsibleAIPolicyViolation"}}}',
      true,
    ],
    [
      '{"error":{"code":"invalid_prompt","message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy."}}',
      true,
    ],
    [
      '{"error":{"code":"invalid_prompt","message":"Invalid prompt: missing field"}}',
      false,
    ],
    [
      '{"error":{"type":"invalid_request_error","message":"max_tokens: too large"}}',
      false,
    ],
    ["content_filter The upstream's safety filter refused the request", true],
    ["upstream_error Something failed", false],
    ["not json", false],
  ];
  for (const [text, refused] of cases)
    assert.equal(policyRefusal(text), refused, text);
});

void test("the least reply length a vendor takes is read from its 400, as Magpie reads it", () => {
  const cases: [string, number][] = [
    ['{"error":{"message":"max_tokens must be greater than 2"}}', 3],
    ["max_completion_tokens must be at least 16", 16],
    [
      "Invalid 'max_output_tokens': integer below minimum value. Expected >= 16",
      16,
    ],
    ["Expected a value \\u003e= 16, but got 1 instead (max_output_tokens)", 0],
    [
      `"max_output_tokens': integer below minimum value. Expected a value \\u003e= 16"`,
      16,
    ],
    ["max_tokens must be \\u003E 2", 3],
    ["max_tokens must be > 2", 3],
    ["max_tokens is too large: 999999", 0],
    ["messages: at least 1 message is required", 0],
    ["max_tokens must be greater than 5000", 0],
  ];
  for (const [text, floor] of cases)
    assert.equal(tokenFloor(text), floor, text);
  assert.equal(
    withTokenFloor('{"model":"m","max_tokens":1}', 3),
    '{"model":"m","max_tokens":3}',
  );
  assert.equal(
    withTokenFloor(
      '{"contents":[],"generationConfig":{"maxOutputTokens":1}}',
      16,
    ),
    '{"contents":[],"generationConfig":{"maxOutputTokens":16}}',
  );
  // Asked for that much already, or for no length: the error was about something else.
  assert.equal(withTokenFloor('{"max_tokens":8}', 3), undefined);
  assert.equal(withTokenFloor('{"model":"m"}', 3), undefined);
  assert.equal(withTokenFloor("not json", 3), undefined);
});

void test("after a safety refusal the failed model's other credentials go first, resting ones not", () => {
  const candidate = (
    provider: string,
    credential: string,
    ref = "p/m",
    effort?: string,
  ): Candidate =>
    ({
      provider: { id: provider as ProviderId },
      credential: { id: credential as CredentialId },
      ref: ref as ModelRef,
      ...(effort ? { effort } : {}),
    }) as unknown as Candidate;
  const failed = candidate("p", "one");
  const queue = [
    failed,
    candidate("q", "other"),
    candidate("p", "two"),
    candidate("p", "three", "p/n"),
    candidate("p", "four", "p/m", "high"),
    candidate("p", "five"),
  ];
  const breakers = new Breakers(
    () => 0,
    () => undefined,
  );
  breakers.failure(
    queue[5]!,
    { kind: "cooldown", ms: 60_000 },
    { status: 429, code: "rate", message: "x", contextOverflow: false },
    "rate_limited",
  );
  matesFirst(queue, 0, breakers);
  assert.deepEqual(
    queue.map((item) => item.credential.id),
    ["one", "two", "other", "three", "four", "five"],
  );
});

/**
 * Group `g` of `a/model-a` (credentials key-a and key-b) and `b/model-a`,
 * in that order, on Chat upstreams of their own.
 */
async function rig(t: test.TestContext, onA: Reply, onB: Reply = CHAT_REPLY) {
  const a = await upstream(t, onA);
  const b = await upstream(t, onB);
  const store = new MemoryStore();
  await store.putProvider(
    provider("a", { chat: `${a.base}/v1` }, { secrets: ["key-a", "key-b"] }),
  );
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-c"] }),
  );
  await store.putRouteGroup(group("g", ["a/model-a", "b/model-a"]));
  const key = await addKey(store, ["*"]);
  const gw = await mount(t, store);
  const chat = (body: Record<string, unknown> = {}) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/g", messages: MESSAGES, ...body },
    });
  /** The ledger entry of the n-th call, once committed. */
  const entry = async (n: number) => {
    await until(() => store.entries.length >= n);
    return store.entries[n - 1]!;
  };
  return { a, b, store, gw, chat, entry };
}

const attempts = (entry: {
  attempts: { provider: string; decision: string; errorClass?: string }[];
}) =>
  entry.attempts.map(
    (item) => `${item.provider} ${item.decision} ${item.errorClass ?? "-"}`,
  );

const SHAPE = json(422, {
  error:
    'Failed to deserialize the JSON body into the target type: input[0]: unknown item type "additional_tools"; expected one of: message, reasoning, function_call',
});

void test("a shape the API cannot read goes to another provider's API, skips the rest of this one, and rests nothing", async (t) => {
  const { a, b, chat, entry } = await rig(t, SHAPE);
  const answer = await chat();
  assert.equal(answer.status, 200, answer.text);
  // key-b of `a` would get the same answer from the same API: not asked.
  assert.equal(a.seen.length, 1);
  assert.equal(b.seen.length, 1);
  assert.deepEqual(attempts(await entry(1)), [
    "a failover request_shape_unsupported",
    "b success -",
  ]);
  // Nothing is wrong with `a`: the next call asks it first again.
  await chat();
  assert.equal(a.seen.length, 2);
});

void test("a safety refusal goes to the model's other credential first and rests nothing", async (t) => {
  const refusal = json(400, {
    error: {
      type: "invalid_request_error",
      code: "bio_policy",
      message: "This content was flagged for possible biological risk.",
      param: null,
    },
  });
  const { a, b, chat, entry } = await rig(t, (response, seen, request) =>
    seen.headers.authorization === KEY_A
      ? refusal(response, seen, request)
      : CHAT_REPLY(response, seen, request),
  );
  const answer = await chat();
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(
    a.seen.map((seen) => seen.headers.authorization),
    [KEY_A, "Bearer sk-upstream-b-0002"],
  );
  assert.equal(b.seen.length, 0);
  assert.deepEqual(attempts(await entry(1)), [
    "a failover safety_refused",
    "a success -",
  ]);
  await chat();
  assert.equal(a.seen[2]?.headers.authorization, KEY_A, "key-a did not rest");
});

void test("a provider refusing this client, or busy, is failed over and counts towards its breaker", async (t) => {
  const refusing = await rig(
    t,
    json(400, {
      code: 11101,
      msg: "Illegal API invocation from an unapproved channel",
    }),
  );
  assert.equal((await refusing.chat()).status, 200);
  assert.deepEqual(attempts(await refusing.entry(1)), [
    "a failover client_refused",
    "a failover client_refused",
    "b success -",
  ]);
  const busy = await rig(
    t,
    json(400, {
      error: {
        message: "The engine is currently overloaded, please try again later",
      },
    }),
  );
  assert.equal((await busy.chat()).status, 200);
  assert.deepEqual(attempts(await busy.entry(1)), [
    "a failover upstream_unavailable",
    "a failover upstream_unavailable",
    "b success -",
  ]);
});

void test("a 400 that is the client's own fault is neither retried nor failed over", async (t) => {
  for (const reply of [
    json(422, {
      error:
        "Failed to deserialize the JSON body into the target type: missing field `messages` at line 1 column 2",
    }),
    json(400, { error: { message: "messages: field required" } }),
    json(400, {
      error: { message: "Expecting value: line 1 column 1 (char 0)" },
    }),
  ]) {
    const { a, b, chat, entry } = await rig(t, reply);
    const answer = await chat();
    assert.ok(answer.status === 400 || answer.status === 422, answer.text);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 0);
    assert.deepEqual(attempts(await entry(1)), ["a stop upstream_rejected"]);
  }
});

void test("a reply too short for the vendor is asked again, once, for the least it takes", async (t) => {
  const floor: Reply = (response, seen, request) =>
    Number(seen.json().max_tokens ?? 0) < 3
      ? json(400, {
          error: { message: "max_tokens must be greater than 2" },
        })(response, seen, request)
      : CHAT_REPLY(response, seen, request);
  const { a, b, chat, entry } = await rig(t, floor);
  const answer = await chat({ max_tokens: 1 });
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(
    a.seen.map((seen) => seen.json().max_tokens),
    [1, 3],
  );
  assert.equal(b.seen.length, 0);
  const done = await entry(1);
  assert.deepEqual(attempts(done), [
    "a retry upstream_rejected",
    "a success -",
  ]);
  assert.ok(done.patches.includes("max-tokens:floor:3"));

  // Asked for enough already: the 400 is about something else, and returned.
  const stubborn = await rig(
    t,
    json(400, { error: { message: "max_tokens must be greater than 2" } }),
  );
  const refused = await stubborn.chat({ max_tokens: 5 });
  assert.equal(refused.status, 400);
  assert.equal(stubborn.a.seen.length, 1);
  assert.equal(stubborn.b.seen.length, 0);
});

const REFUSED_JSON = json(200, {
  id: "chatcmpl-up",
  object: "chat.completion",
  model: "served-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null },
      finish_reason: "content_filter",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
});
const REFUSED_STREAM = events(
  chatChunks([
    delta({ role: "assistant", content: "" }),
    delta({}, "content_filter"),
  ]),
);

void test("a reply that is a safety refusal with nothing said goes to the next candidate; from the last, the client is told it was refused", async (t) => {
  const refusing: Reply = (response, seen, request) =>
    (seen.json().stream === true ? REFUSED_STREAM : REFUSED_JSON)(
      response,
      seen,
      request,
    );
  const { a, b, chat, entry } = await rig(t, refusing);
  const whole = await chat();
  assert.equal(whole.status, 200, whole.text);
  assert.equal(
    at(whole.json(), "choices", 0, "message", "content"),
    "Hello world",
  );
  assert.deepEqual(attempts(await entry(1)), [
    "a failover safety_refused",
    "a failover safety_refused",
    "b success -",
  ]);
  const streamed = await chat({ stream: true });
  assert.equal(streamed.status, 200);
  assert.match(streamed.text, /Hello/);
  assert.equal(b.seen.length, 2);
  assert.equal(a.seen.length, 4);

  // Nobody left: the client is told it was refused (Magpie #248), not
  // handed an empty reply it would send again, streamed or not.
  const alone = await rig(t, CHAT_REPLY, refusing);
  const key = await addKey(alone.store, ["*"]);
  for (const stream of [false, true]) {
    const last = await send(alone.gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "b/model-a", messages: MESSAGES, stream },
    });
    assert.equal(last.status, 400, last.text);
    assert.equal(at(last.json(), "error", "code"), "safety_refused");
  }
});

void test("a translated reply that is a safety refusal fails over too", async (t) => {
  const { b, gw, store } = await rig(t, REFUSED_JSON);
  const key = await addKey(store, ["*"]);
  const answer = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: { model: "group/g", max_tokens: 50, messages: MESSAGES },
  });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(at(answer.json(), "content", 0, "text"), "Hello world");
  assert.equal(b.seen.length, 1);
  await until(() => store.entries.length === 1);
  assert.equal(store.entries[0]!.mode, "translated");
});

void test("a refusal inside a Responses stream, before anything is said, fails over", async (t) => {
  const failed = events(
    [
      {
        type: "response.created",
        response: { id: "r1", status: "in_progress" },
      },
      {
        type: "response.failed",
        response: {
          id: "r1",
          status: "failed",
          error: {
            code: "bio_policy",
            message: "This content was flagged for possible biological risk.",
          },
        },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
  const answered = events(
    [
      {
        type: "response.created",
        response: { id: "r2", status: "in_progress" },
      },
      { type: "response.output_text.delta", item_id: "m", delta: "Hello" },
      {
        type: "response.completed",
        response: {
          id: "r2",
          status: "completed",
          output: [],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
  const a = await upstream(t, failed);
  const b = await upstream(t, answered);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { responses: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { responses: `${b.base}/v1` }, { secrets: ["key-c"] }),
  );
  await store.putRouteGroup(group("g", ["a/model-a", "b/model-a"]));
  const key = await addKey(store, ["*"]);
  const gw = await mount(t, store);
  const answer = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "group/g", input: "hi", stream: true },
  });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /Hello/);
  assert.doesNotMatch(answer.text, /bio_policy/);
  await until(() => store.entries.length === 1);
  assert.deepEqual(attempts(store.entries[0]!), [
    "a failover safety_refused",
    "b success -",
  ]);
});
