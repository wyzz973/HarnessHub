// SPDX-License-Identifier: MIT
/**
 * Magpie's failure kinds and rests, the last-candidate retries and the
 * `least-used` strategy of the shared gateway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RETRY_POLICY,
  type CredentialId,
  type ModelCallEntry,
  type ModelCallId,
  type ProviderId,
} from "@harnesshub/core/model-plane";
import {
  backoff,
  classify,
  FAILURE_WORDS,
  failureKind,
  resetIn,
  retryAfter,
  REST_MS,
  retryPolicy,
  type AttemptError,
  type FailureKind,
} from "../src/routing.js";
import {
  addKey,
  CHAT_REPLY,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Reply,
} from "./shared-support.js";

const MESSAGES = [{ role: "user", content: "hi" }];
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

void test("failure kinds follow Magpie's order of status codes and words", () => {
  const cases: [number, string, FailureKind][] = [
    [
      502,
      "proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused",
      "proxy",
    ],
    [502, "socks connect tcp 127.0.0.1:1080: refused", "proxy"],
    [502, "Bad gateway", "other"],
    [
      403,
      '{"error":{"code":403,"details":[{"reason":"VALIDATION_REQUIRED"}]}}',
      "verify",
    ],
    [401, "Please verify your account to continue", "verify"],
    [402, "Payment Required", "credit"],
    [
      400,
      "Your credit balance is too low to access the Anthropic API",
      "credit",
    ],
    [403, "账户余额不足", "credit"],
    [
      429,
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}',
      "credit",
    ],
    [429, "Rate limit reached for requests per minute (RPM)", "rate"],
    [429, "负载已饱和，请稍后再试", "rate"],
    [429, "Too many requests: daily limit", "quota"],
    [429, "You have hit your usage limit. It resets at 5pm.", "quota"],
    [429, "Quota exceeded for metric: requests per day", "quota"],
    [400, "monthly usage limit exceeded", "quota"],
    [503, "本月额度已用完", "quota"],
    [401, "Incorrect API key provided", "auth"],
    [403, "Forbidden", "auth"],
    [404, "Not Found", "model"],
    [400, "The model `gpt-9` does not exist", "model"],
    [422, "模型不存在", "model"],
    [400, '{"error":{"message":"The model gpt-x is invalid"}}', "model"],
    // Magpie's retryable 400s and 422s.
    [
      400,
      '{"error":{"type":"invalid_request_error","code":"bio_policy","message":"This content was flagged for possible biological risk."}}',
      "policy",
    ],
    [
      400,
      '{"error":{"code":"content_policy_violation","message":"Your request was rejected as a result of our safety system."}}',
      "policy",
    ],
    // A refusal in a stream, mapped to a 5xx: its code says what it is.
    [500, '{"code":"cyber_policy","message":"x"}', "policy"],
    [
      400,
      '{"code":11101,"msg":"Illegal API invocation from an unapproved channel"}',
      "refused",
    ],
    [
      400,
      "The engine is currently overloaded, please try again later",
      "other",
    ],
    [400, "请求限流，请稍后再试", "other"],
    [
      422,
      '{"error":"Failed to deserialize the JSON body into the target type: input[0]: unknown item type \\"additional_tools\\"; expected one of: message, reasoning, function_call"}',
      "shape",
    ],
    [
      400,
      '{"error":{"message":"Unknown parameter: \'reasoning.summary\'.","code":"unknown_parameter"}}',
      "shape",
    ],
    // The client's own fault for every provider: never failed over.
    [400, '{"error":{"message":"messages: field required"}}', "request"],
    [
      422,
      "Failed to deserialize the JSON body into the target type: missing field `messages` at line 1 column 2",
      "request",
    ],
    [400, "Expecting value: line 1 column 1 (char 0)", "request"],
    [400, "max_tokens must be greater than 2", "request"],
    [408, "Request Timeout", "other"],
    [500, "Internal error", "other"],
    [529, "Overloaded", "other"],
    [500, "unknown parameter", "other"],
    [400, "temperature must be at most 2", "request"],
    [413, "Request entity too large", "request"],
  ];
  for (const [status, text, kind] of cases)
    assert.equal(failureKind(status, text), kind, `${status} ${text}`);
});

void test("each word list matches its own phrases and not ordinary errors", () => {
  const words: Record<keyof typeof FAILURE_WORDS, [string[], string[]]> = {
    credit: [
      [
        "Insufficient Balance",
        "billing hard limit",
        "账户已欠费",
        "充值后重试",
      ],
      ["temperature out of range"],
    ],
    noCredit: [["insufficient_quota"], ["insufficient quota"]],
    usedUp: [
      ["quota exceeded", "usage limit", "limit reached", "套餐上限"],
      ["rate limit exceeded"],
    ],
    rate: [
      ["rate_limit_error", "Too Many Requests", "50 RPM", "请求太频繁"],
      ["daily quota"],
    ],
    planned: [
      ["per day", "weekly limit", "monthly", "今日额度"],
      ["per minute"],
    ],
    proxy: [["proxyconnect tcp", "socks connect tcp"], ["proxy error"]],
    verify: [["VALIDATION_REQUIRED", "verify your account"], ["unverified"]],
    modelMissing: [
      [
        "model_not_found",
        "The model `x` does not exist",
        "Unknown model: x",
        "模型未开通",
        "model gpt-x is invalid",
      ],
      ["bad temperature", "The model is fine. The request is invalid"],
    ],
    busy: [
      [
        "overloaded",
        "Too many requests",
        "rate_limit",
        "请求限流",
        "insufficient",
      ],
      ["temperature out of range"],
    ],
    refused: [
      ["Illegal API invocation", "from an unapproved channel"],
      ["approved", "illegal argument"],
    ],
    shape: [
      [
        "Failed to deserialize the JSON body",
        "unknown variant `developer`",
        "Unknown parameter: 'x'",
        "unrecognized request argument supplied: foo",
        "Extra inputs are not permitted",
        "Additional properties are not allowed",
      ],
      ["unknown error", "field required"],
    ],
    clientFault: [
      [
        "messages: field required",
        "missing field `messages`",
        "messages is required",
        "at least 1 message is required",
        "messages must not be empty",
        "Expecting value: line 1 column 1",
        "invalid JSON body",
        "Unexpected token } in JSON at position 3",
        "EOF while parsing a value",
      ],
      ["unknown parameter", "Unknown model", "the request is too large"],
    ],
  };
  for (const [name, [yes, no]] of Object.entries(words)) {
    const pattern = FAILURE_WORDS[name as keyof typeof FAILURE_WORDS];
    for (const text of yes) assert.ok(pattern.test(text), `${name}: ${text}`);
    for (const text of no) assert.ok(!pattern.test(text), `${name}: ${text}`);
  }
});

void test("each kind rests its credential as Magpie does, and only a request failure stays put", () => {
  const error = (
    kind: FailureKind,
    extra: Partial<AttemptError> = {},
  ): AttemptError => ({
    failure: { status: 500, code: "x", message: "x", contextOverflow: false },
    errorClass: "x",
    source: "upstream",
    phase: "response",
    status: 500,
    kind,
    ...extra,
  });
  const cases: [AttemptError, ReturnType<typeof classify>][] = [
    [
      error("credit"),
      {
        retry: "no",
        failover: true,
        breaker: { kind: "cooldown", ms: 1_800_000 },
      },
    ],
    [
      error("verify"),
      {
        retry: "no",
        failover: true,
        breaker: { kind: "cooldown", ms: 1_800_000 },
      },
    ],
    [
      error("quota"),
      {
        retry: "no",
        failover: true,
        breaker: { kind: "cooldown", ms: 900_000 },
      },
    ],
    [
      error("quota", { resetMs: 7_200_000, retryAfterMs: 5_000 }),
      {
        retry: "no",
        failover: true,
        breaker: { kind: "cooldown", ms: 7_200_000 },
      },
    ],
    [
      error("quota", { retryAfterMs: 5_000 }),
      { retry: "no", failover: true, breaker: { kind: "cooldown", ms: 5_000 } },
    ],
    [
      error("quota", { resetMs: 30 * 86_400_000 }),
      {
        retry: "no",
        failover: true,
        breaker: { kind: "cooldown", ms: 8 * 86_400_000 },
      },
    ],
    [
      error("rate"),
      {
        retry: "yes",
        failover: true,
        breaker: { kind: "cooldown", ms: 60_000 },
      },
    ],
    [
      error("rate", { retryAfterMs: 30_000 }),
      {
        retry: "yes",
        failover: true,
        breaker: { kind: "cooldown", ms: 30_000 },
      },
    ],
    [error("auth"), { retry: "no", failover: true, breaker: { kind: "auth" } }],
    [
      error("model"),
      { retry: "no", failover: true, breaker: { kind: "model", ms: 600_000 } },
    ],
    [
      error("proxy"),
      { retry: "no", failover: true, breaker: { kind: "none" } },
    ],
    [
      error("policy", { status: 400 }),
      { retry: "no", failover: true, breaker: { kind: "none" } },
    ],
    [
      error("shape", { status: 422 }),
      { retry: "no", failover: true, breaker: { kind: "none" } },
    ],
    [
      error("refused", { status: 400 }),
      { retry: "no", failover: true, breaker: { kind: "count" } },
    ],
    [
      error("other", { status: 400 }),
      { retry: "no", failover: true, breaker: { kind: "count" } },
    ],
    [
      error("other"),
      { retry: "yes", failover: true, breaker: { kind: "count" } },
    ],
    [
      error("other", { status: 501 }),
      { retry: "no", failover: true, breaker: { kind: "count" } },
    ],
    [
      error("request"),
      { retry: "no", failover: false, breaker: { kind: "none" } },
    ],
    [
      error("other", { phase: "headers" }),
      { retry: "once", failover: true, breaker: { kind: "count" } },
    ],
    [
      error("other", { phase: "connect" }),
      { retry: "yes", failover: true, breaker: { kind: "count" } },
    ],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(classify(input), expected, JSON.stringify(input));
  assert.equal(REST_MS.quotaMax, 8 * 86_400_000);
});

void test("the default retries wait 1, 2 and 4 s and nothing past 8 s", () => {
  assert.deepEqual(DEFAULT_RETRY_POLICY, {
    perCandidate: 3,
    totalAttempts: 4,
    baseBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    retryAfterWaitCapMs: 8_000,
  });
  const policy = retryPolicy(undefined);
  assert.deepEqual(
    [0, 1, 2, 3].map((retry) => backoff(policy, retry)),
    [1_000, 2_000, 4_000, 8_000],
  );
  assert.equal(retryPolicy({ totalAttempts: 20 }).totalAttempts, 8);
});

void test("the vendor's wait and reset are read from headers and bodies", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  assert.equal(retryAfter(headers({ "retry-after": "30" }), NOW), 30_000);
  assert.equal(retryAfter(headers({ "retry-after": "1.5" }), NOW), 1_500);
  assert.equal(retryAfter(headers({ "retry-after-ms": "40" }), NOW), 40);
  assert.equal(
    retryAfter(
      headers({ "retry-after": new Date(NOW + 20_000).toUTCString() }),
      NOW,
    ),
    20_000,
  );
  assert.equal(
    retryAfter(
      headers({
        "x-ratelimit-reset-requests": "1s",
        "x-ratelimit-reset-tokens": "6m0s",
      }),
      NOW,
    ),
    360_000,
    "the latest reset among the rate-limit headers",
  );
  assert.equal(
    retryAfter(
      headers({
        "anthropic-ratelimit-tokens-reset": new Date(
          NOW + 20_000,
        ).toISOString(),
      }),
      NOW,
    ),
    20_000,
  );
  assert.equal(
    retryAfter(headers({ "x-ratelimit-reset": String(NOW / 1000 + 90) }), NOW),
    90_000,
    "Unix seconds",
  );
  assert.equal(
    retryAfter(headers({ "retry-after": "7200" }), NOW),
    3_600_000,
    "an hour at most",
  );
  assert.equal(retryAfter(headers({}), NOW), undefined);
  assert.equal(retryAfter(headers({ "retry-after": "soon" }), NOW), undefined);

  assert.equal(
    resetIn(`usage limit reached|${NOW / 1000 + 3600}`, NOW),
    3_600_000,
    "Claude Code",
  );
  assert.equal(
    resetIn(
      JSON.stringify({
        error: { type: "usage_limit_reached", resets_at: NOW / 1000 + 7200 },
      }),
      NOW,
    ),
    7_200_000,
    "ChatGPT resets_at",
  );
  assert.equal(
    resetIn(JSON.stringify({ error: { resets_in_seconds: 300 } }), NOW),
    300_000,
  );
  assert.equal(
    resetIn(
      JSON.stringify({
        error: {
          code: 429,
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "20s",
            },
          ],
        },
      }),
      NOW,
    ),
    20_000,
    "Google RetryInfo",
  );
  assert.equal(resetIn("not json", NOW), undefined);
  assert.equal(resetIn('{"error":{"message":"x"}}', NOW), undefined);
});

/**
 * A provider with two credentials on one upstream: `failing` answers for the
 * first credential (key-a), the second always succeeds.
 */
async function twoCredentials(t: test.TestContext, failing: Reply) {
  const up = await upstream(t, (response, seen, request) =>
    seen.headers.authorization === "Bearer sk-upstream-a-0001"
      ? failing(response, seen, request)
      : CHAT_REPLY(response, seen, request),
  );
  const store = new MemoryStore();
  await store.putProvider(
    provider("a", { chat: `${up.base}/v1` }, { secrets: ["key-a", "key-b"] }),
  );
  const key = await addKey(store, ["a/*"]);
  const gw = await mount(t, store);
  const tried = () =>
    up.seen.filter(
      (seen) => seen.headers.authorization === "Bearer sk-upstream-a-0001",
    ).length;
  const chat = async () => {
    const answer = await send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "a/model-a", messages: MESSAGES },
    });
    assert.equal(answer.status, 200, answer.text);
  };
  return { up, store, gw, tried, chat };
}

void test("a failing credential rests for as long as its kind says, then gets one probe", async (t) => {
  const cases: { name: string; reply: Reply; restMs: number }[] = [
    {
      name: "credit",
      reply: json(402, { error: { message: "Insufficient Balance" } }),
      restMs: 30 * 60_000,
    },
    {
      name: "quota with the vendor's reset in the body",
      reply: json(429, {
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          resets_in_seconds: 7_200,
        },
      }),
      restMs: 7_200_000,
    },
    {
      name: "quota with a reset header",
      reply: json(
        429,
        { error: { message: "daily quota exhausted" } },
        { "retry-after": "600" },
      ),
      restMs: 600_000,
    },
    {
      name: "quota without a reset",
      reply: json(429, { error: { message: "daily quota exhausted" } }),
      restMs: 15 * 60_000,
    },
    {
      name: "quota capped at 8 days",
      reply: json(429, {
        error: {
          message: "usage limit reached",
          resets_at: Math.floor(NOW / 1000) + 30 * 86_400,
        },
      }),
      restMs: 8 * 86_400_000,
    },
    {
      name: "rate with Retry-After (over the wait cap, so not retried)",
      reply: json(
        429,
        { error: { message: "rate limit" } },
        { "retry-after": "30" },
      ),
      restMs: 30_000,
    },
    {
      name: "rate without Retry-After",
      reply: json(429, { error: { message: "Too many requests" } }),
      restMs: 60_000,
    },
    {
      name: "verify",
      reply: json(403, {
        error: { code: 403, details: [{ reason: "VALIDATION_REQUIRED" }] },
      }),
      restMs: 30 * 60_000,
    },
  ];
  for (const { name, reply, restMs } of cases) {
    const { gw, tried, chat, store } = await twoCredentials(t, reply);
    await chat();
    assert.equal(tried(), 1, name);
    assert.equal(store.entries[0]!.attempts[0]!.decision, "failover", name);
    gw.clock.now += restMs - 1_000;
    await chat();
    assert.equal(tried(), 1, `${name}: still resting`);
    gw.clock.now += 2_000;
    await chat();
    assert.equal(tried(), 2, `${name}: probed after the rest`);
  }
});

void test("a proxy failure rests nothing, and other failures open the breaker after three", async (t) => {
  const proxy = await twoCredentials(
    t,
    json(502, {
      error: { message: "proxyconnect tcp: dial tcp 127.0.0.1:7890: refused" },
    }),
  );
  await proxy.chat();
  await proxy.chat();
  assert.equal(proxy.tried(), 2, "tried again at once");
  assert.equal(proxy.store.entries[0]!.attempts[0]!.errorClass, "proxy_failed");
  const other = await twoCredentials(
    t,
    json(503, { error: { message: "busy" } }),
  );
  for (let index = 0; index < 4; index++) await other.chat();
  assert.equal(other.tried(), 3, "open after the third failure");
  other.gw.clock.now += 61_000;
  await other.chat();
  assert.equal(other.tried(), 4, "a probe after 60 s, which fails");
  other.gw.clock.now += 61_000;
  await other.chat();
  assert.equal(other.tried(), 4, "reopened for twice as long");
  other.gw.clock.now += 60_000;
  await other.chat();
  assert.equal(other.tried(), 5);
});

void test("the attempt records the failure's class, and the client gets the vendor's error", async (t) => {
  const { store, tried, chat } = await twoCredentials(
    t,
    json(400, {
      error: {
        message: "Your credit balance is too low to access the Anthropic API",
      },
    }),
  );
  await chat();
  assert.equal(tried(), 1);
  assert.deepEqual(
    store.entries[0]!.attempts.map((attempt) => [
      attempt.status,
      attempt.errorClass,
      attempt.decision,
    ]),
    [
      [400, "insufficient_balance", "failover"],
      [200, undefined, "success"],
    ],
  );
});

/** One credential behind a one-member group, so that the group's retry policy applies. */
async function lastCandidate(
  t: test.TestContext,
  replies: Reply[],
  retry: Record<string, number>,
) {
  const up = await upstream(t, ...replies);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${up.base}/v1` }));
  await store.putRouteGroup(
    group("solo", ["a/model-a"], { retry: { totalAttempts: 8, ...retry } }),
  );
  const key = await addKey(store, ["group/solo"]);
  const gw = await mount(t, store);
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "group/solo", messages: MESSAGES },
  });
  return {
    answer,
    up,
    attempts: store.entries[0]!.attempts.map((attempt) => [
      attempt.decision,
      attempt.backoffMs,
    ]),
  };
}

void test("the last candidate is retried after base × 2^n, and not past the cap", async (t) => {
  const limited = json(429, { error: { message: "Too many requests" } });
  const rate = await lastCandidate(t, [limited], {
    baseBackoffMs: 5,
    maxBackoffMs: 40,
  });
  assert.equal(rate.answer.status, 429);
  assert.deepEqual(rate.attempts, [
    ["retry", 5],
    ["retry", 10],
    ["retry", 20],
    ["stop", undefined],
  ]);
  const capped = await lastCandidate(t, [limited], {
    baseBackoffMs: 30,
    maxBackoffMs: 70,
  });
  assert.deepEqual(
    capped.attempts,
    [
      ["retry", 30],
      ["retry", 60],
      ["stop", undefined],
    ],
    "120 ms would pass the 70 ms cap",
  );
  // Busy upstreams: the third counted failure opens the breaker, which ends
  // the retries (two, as Magpie's lastRetries).
  const busy = await lastCandidate(
    t,
    [json(503, { error: { message: "busy" } })],
    { baseBackoffMs: 5 },
  );
  assert.deepEqual(busy.attempts, [
    ["retry", 5],
    ["retry", 10],
    ["stop", undefined],
  ]);
  const said = await lastCandidate(
    t,
    [
      json(429, { error: { message: "slow" } }, { "retry-after-ms": "150" }),
      CHAT_REPLY,
    ],
    { retryAfterWaitCapMs: 100 },
  );
  assert.equal(said.answer.status, 429, "a Retry-After past the cap");
  assert.deepEqual(said.attempts, [["stop", undefined]]);
  const credit = await lastCandidate(
    t,
    [json(402, { error: { message: "no money" } }), CHAT_REPLY],
    { baseBackoffMs: 5 },
  );
  assert.equal(credit.answer.status, 402, "credit is never retried");
  assert.equal(credit.up.seen.length, 1);
});

void test("a candidate that rests is no alternative: the one before it is retried", async (t) => {
  const a = await upstream(
    t,
    json(503, { error: { message: "busy" } }),
    CHAT_REPLY,
  );
  const b = await upstream(t, json(402, { error: { message: "no money" } }));
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-b"] }),
  );
  await store.putRouteGroup(
    group("g", ["a/model-a", "b/model-a"], { retry: { baseBackoffMs: 5 } }),
  );
  const key = await addKey(store, ["group/g", "b/*"]);
  const gw = await mount(t, store);
  const chat = (model: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: MESSAGES },
    });
  assert.equal((await chat("b/model-a")).status, 402, "b rests 30 minutes");
  assert.equal((await chat("group/g")).status, 200);
  assert.equal(a.seen.length, 2);
  assert.equal(b.seen.length, 1, "the resting b is not tried");
  assert.deepEqual(
    store.entries[1]!.attempts.map((attempt) => [
      attempt.provider,
      attempt.decision,
    ]),
    [
      ["a", "retry"],
      ["a", "success"],
    ],
  );
});

function usage(tokens: number): Reply {
  return (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-up",
        object: "chat.completion",
        model: "served-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: tokens,
          completion_tokens: 0,
          total_tokens: tokens,
        },
      }),
    );
  };
}

async function leastUsed(
  t: test.TestContext,
  first: Reply,
  second: Reply,
  seed: ModelCallEntry[] = [],
) {
  const a = await upstream(t, first);
  const b = await upstream(t, second);
  const store = new MemoryStore();
  store.entries.push(...seed);
  await store.putProvider(provider("a", { chat: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-b"] }),
  );
  await store.putRouteGroup(
    group("lu", ["a/model-a", "b/model-a"], { strategy: "least-used" }),
  );
  const key = await addKey(store, ["group/lu"]);
  const gw = await mount(t, store);
  const served = async () => {
    const answer = await send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/lu", messages: MESSAGES },
    });
    assert.equal(answer.status, 200, answer.text);
    return store.entries.at(-1)!.provider;
  };
  return { gw, served };
}

void test("least-used takes the fewest recent tokens first, each halving per hour", async (t) => {
  const { gw, served } = await leastUsed(t, usage(1_000), usage(300));
  assert.equal(await served(), "a", "a tie keeps the configured order");
  assert.equal(await served(), "b");
  assert.equal(await served(), "b", "300 tokens before 1000");
  gw.clock.now += 2 * 3_600_000;
  // a: 1000 / 4 = 250; b: 600 / 4 = 150.
  assert.equal(await served(), "b");
  // b: 150 + 300 = 450 > a: 250. Without the decay a would still be ahead.
  assert.equal(await served(), "a");
});

void test("least-used puts a credential with less of its rate-limit window used first", async (t) => {
  const reset = new Date(NOW + 60_000).toISOString();
  const nearlyFull: Reply = (response, seen, request) => {
    response.setHeader("anthropic-ratelimit-requests-limit", "100");
    response.setHeader("anthropic-ratelimit-requests-remaining", "10");
    response.setHeader("anthropic-ratelimit-requests-reset", reset);
    return usage(1)(response, seen, request);
  };
  const { gw, served } = await leastUsed(t, nearlyFull, usage(5_000));
  assert.equal(await served(), "a");
  assert.equal(
    await served(),
    "b",
    "a used 90% of its window: b goes first despite more tokens",
  );
  assert.equal(await served(), "b");
  gw.clock.now += 61_000;
  assert.equal(await served(), "a", "the window reset: tokens decide again");
});

void test("least-used starts from the ledger's recent calls", async (t) => {
  const entry = (
    hoursAgo: number,
    providerId: string,
    tokens: number,
  ): ModelCallEntry => ({
    callId: `mc_seed${hoursAgo}${providerId}` as ModelCallId,
    occurredAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: false },
    provider: providerId as ProviderId,
    credentialId: "cred-0" as CredentialId,
    patches: [],
    unmapped: [],
    status: 200,
    usage: {
      input: tokens,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      source: "reported",
    },
    timing: { durationMs: 1 },
    attempts: [],
    cost: null,
  });
  const recent = await leastUsed(t, usage(1), usage(1), [entry(1, "a", 1_000)]);
  assert.equal(await recent.served(), "b", "a served 1000 tokens an hour ago");
  const old = await leastUsed(t, usage(1), usage(1), [entry(9, "a", 1_000)]);
  assert.equal(await old.served(), "a", "nine hours back is past the seed");
});
