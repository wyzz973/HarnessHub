// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialFingerprint,
  PROTOCOLS,
  startFakeProvider,
} from "./index.mjs";
import { resolveFields } from "./fields.mjs";
import { isLoopback } from "./options.mjs";
import { KEY, MODEL, send } from "./testing.mjs";

const WRONG_KEY = "fake-provider-wrong-canary-1b2c";

async function provider(t, options = {}) {
  const fake = await startFakeProvider({
    keys: { main: KEY },
    chunkDelayMs: 0,
    ...options,
  });
  t.after(() => fake.close());
  return fake;
}

async function records(fake) {
  await fake.idle();
  return fake.records();
}

const STOP = {
  chat: "stop",
  responses: "completed",
  messages: "end_turn",
  gemini: "STOP",
};

/** A forbidden field per protocol: where it goes and the path the provider must report. */
const FORBIDDEN = {
  chat: { body: { store: true }, path: "store" },
  responses: {
    body: { previous_response_id: "resp_1" },
    path: "previous_response_id",
  },
  messages: {
    body: (body) => ({
      ...body,
      messages: [{ role: "user", content: "hi", reasoning_content: "leaked" }],
    }),
    path: "messages[0].reasoning_content",
  },
  gemini: {
    body: (body) => ({
      ...body,
      contents: [{ role: "user", parts: [{ text: "hi", cache_control: {} }] }],
    }),
    path: "contents[0].parts[0].cache_control",
  },
};

/** An undeclared (unknown) nested field per protocol for whitelist mode. */
const UNKNOWN = {
  chat: {
    body: (body) => ({
      ...body,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi", x_extra: 1 },
      ],
    }),
    path: "messages[1].x_extra",
  },
  responses: {
    body: (body) => ({
      ...body,
      input: [{ type: "message", role: "user", content: "hi", x_extra: 1 }],
    }),
    path: "input[0].x_extra",
  },
  messages: {
    body: (body) => ({
      ...body,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", x_extra: 1 }] },
      ],
    }),
    path: "messages[0].content[0].x_extra",
  },
  gemini: {
    body: (body) => ({
      ...body,
      contents: [{ role: "user", parts: [{ text: "hi", x_extra: 1 }] }],
    }),
    path: "contents[0].parts[0].x_extra",
  },
};

/** The native error envelope: exact keys and the status-specific values. */
function assertEnvelope(protocol, status, json) {
  switch (protocol) {
    case "chat":
    case "responses":
      assert.deepEqual(Object.keys(json), ["error"]);
      assert.deepEqual(Object.keys(json.error), [
        "message",
        "type",
        "param",
        "code",
      ]);
      assert.equal(typeof json.error.message, "string");
      assert.equal(typeof json.error.type, "string");
      break;
    case "messages":
      assert.deepEqual(Object.keys(json), ["type", "error", "request_id"]);
      assert.equal(json.type, "error");
      assert.deepEqual(Object.keys(json.error), ["type", "message"]);
      assert.match(json.request_id, /^req_/);
      break;
    case "gemini":
      assert.deepEqual(Object.keys(json), ["error"]);
      assert.equal(json.error.code, status);
      assert.equal(typeof json.error.message, "string");
      assert.match(json.error.status, /^[A-Z_]+$/);
      break;
  }
}

/** The violation path as the native error reports it. */
function reportedPath(protocol, json) {
  switch (protocol) {
    case "chat":
    case "responses":
      return json.error.param;
    case "messages":
      return json.error.message.split(":")[0];
    case "gemini":
      return json.error.details[0].fieldViolations[0].field;
  }
  return undefined;
}

for (const protocol of PROTOCOLS)
  for (const stream of [false, true]) {
    const form = stream ? "streaming" : "non-streaming";

    test(`${protocol} ${form}: a valid request is answered OK in the native wire format`, async (t) => {
      const fake = await provider(t);
      const result = await send(fake, protocol, { stream });
      assert.equal(result.status, 200, result.text);
      assert.match(
        result.headers.get("content-type"),
        stream ? /text\/event-stream/ : /application\/json/,
      );
      assert.equal(result.answer.text, "OK");
      assert.ok(
        result.answer.reasoning.length > 0 ||
          protocol === "messages" ||
          protocol === "gemini",
      );
      assert.deepEqual(result.answer.finishes, [STOP[protocol]]);
      assert.ok(result.answer.usage, "usage is reported");
      if (stream && protocol === "chat") assert.equal(result.answer.done, true);
      if (stream && protocol === "responses") {
        assert.equal(result.answer.events[0], "response.created");
        assert.equal(result.answer.events.at(-1), "response.completed");
      }
      if (stream && protocol === "messages") {
        assert.equal(result.answer.events[0], "message_start");
        assert.equal(result.answer.events.at(-1), "message_stop");
      }
      if (stream && protocol === "gemini")
        assert.ok(result.answer.events.length >= 1);
      const [record] = await records(fake);
      assert.equal(record.protocol, protocol);
      assert.equal(record.status, 200);
      assert.equal(record.stream, stream);
      assert.equal(record.auth, "ok");
      assert.equal(record.keyId, "main");
      assert.equal(record.keyFingerprint, credentialFingerprint(KEY));
      assert.equal(record.model, MODEL);
      assert.deepEqual(record.violations, []);
      assert.deepEqual(fake.violations(), []);
    });

    test(`${protocol} ${form}: blacklist mode rejects a vendor-private field with its path and accepts other unknown fields`, async (t) => {
      const fake = await provider(t);
      const { body, path } = FORBIDDEN[protocol];
      const rejected = await send(fake, protocol, { stream, body });
      assert.equal(rejected.status, 400, rejected.text);
      assertEnvelope(protocol, 400, rejected.json);
      assert.equal(reportedPath(protocol, rejected.json), path);
      const tolerated = await send(fake, protocol, {
        stream,
        body: { x_vendor_hint: true },
      });
      assert.equal(tolerated.status, 200, tolerated.text);
      const [first, second] = await records(fake);
      assert.deepEqual(
        first.violations.map((violation) => [violation.path, violation.rule]),
        [[path, "forbidden"]],
      );
      assert.deepEqual(second.violations, []);
      assert.deepEqual(
        fake
          .violations()
          .map((violation) => [
            violation.seq,
            violation.protocol,
            violation.path,
          ]),
        [[first.seq, protocol, path]],
      );
    });

    test(`${protocol} ${form}: whitelist mode rejects an undeclared field with its path`, async (t) => {
      const fake = await provider(t, { mode: "whitelist" });
      const accepted = await send(fake, protocol, { stream });
      assert.equal(accepted.status, 200, accepted.text);
      const { body, path } = UNKNOWN[protocol];
      const rejected = await send(fake, protocol, { stream, body });
      assert.equal(rejected.status, 400, rejected.text);
      assertEnvelope(protocol, 400, rejected.json);
      assert.equal(reportedPath(protocol, rejected.json), path);
      if (protocol === "gemini")
        assert.match(
          rejected.json.error.message,
          /Unknown name "x_extra" at 'contents\[0\]\.parts\[0\]'/,
        );
      // Blacklist mode does not know the field and lets it through.
      const lenient = await provider(t);
      assert.equal(
        (await send(lenient, protocol, { stream, body })).status,
        200,
      );
      const [, record] = await records(fake);
      assert.deepEqual(
        record.violations.map((violation) => [violation.path, violation.rule]),
        [[path, "unknown"]],
      );
    });

    test(`${protocol} ${form}: a wrong or missing key gets the native authentication error and only a fingerprint is recorded`, async (t) => {
      const fake = await provider(t);
      const wrong = await send(fake, protocol, { stream, key: WRONG_KEY });
      const missing = await send(fake, protocol, { stream, key: null });
      const expected = {
        chat: [401, 401],
        responses: [401, 401],
        messages: [401, 401],
        gemini: [400, 403],
      }[protocol];
      assert.deepEqual([wrong.status, missing.status], expected);
      assertEnvelope(protocol, wrong.status, wrong.json);
      assertEnvelope(protocol, missing.status, missing.json);
      if (protocol === "chat" || protocol === "responses")
        assert.equal(wrong.json.error.code, "invalid_api_key");
      if (protocol === "messages")
        assert.equal(wrong.json.error.type, "authentication_error");
      if (protocol === "gemini") {
        assert.equal(wrong.json.error.details[0].reason, "API_KEY_INVALID");
        assert.equal(missing.json.error.status, "PERMISSION_DENIED");
      }
      for (const result of [wrong, missing])
        assert.equal(result.text.includes(WRONG_KEY), false);
      const [first, second] = await records(fake);
      assert.deepEqual(
        [first.auth, first.keyId, first.keyFingerprint],
        ["invalid", null, credentialFingerprint(WRONG_KEY)],
      );
      assert.deepEqual(
        [second.auth, second.keyId, second.keyFingerprint],
        ["missing", null, null],
      );
      const serialized = JSON.stringify(fake.records());
      assert.equal(serialized.includes(WRONG_KEY), false);
      assert.equal(serialized.includes(KEY), false);
    });

    test(`${protocol} ${form}: malformed requests get the native error envelope`, async (t) => {
      const fake = await provider(t);
      const invalidJson = await send(fake, protocol, {
        stream,
        raw: "{not json",
      });
      assert.equal(invalidJson.status, 400);
      assertEnvelope(protocol, 400, invalidJson.json);
      const unknownModel = await send(fake, protocol, {
        stream,
        model: "other-model",
      });
      assert.equal(unknownModel.status, 404);
      assertEnvelope(protocol, 404, unknownModel.json);
      const expectedType = {
        chat: ["type", "invalid_request_error"],
        responses: ["type", "invalid_request_error"],
        messages: ["type", "not_found_error"],
        gemini: ["status", "NOT_FOUND"],
      }[protocol];
      assert.equal(unknownModel.json.error[expectedType[0]], expectedType[1]);
      const [, record] = await records(fake);
      assert.deepEqual(
        record.violations.map((violation) => [violation.path, violation.rule]),
        [["model", "model"]],
      );
    });
  }

test("GET /v1/models answers in the OpenAI form, or the Anthropic form with anthropic-version", async (t) => {
  const fake = await provider(t, { models: ["model-a", "model-b"] });
  const openai = await fetch(`${fake.url}/v1/models`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(openai.status, 200);
  const list = await openai.json();
  assert.equal(list.object, "list");
  assert.deepEqual(
    list.data.map((model) => [model.id, model.object]),
    [
      ["model-a", "model"],
      ["model-b", "model"],
    ],
  );
  const anthropic = await fetch(`${fake.url}/v1/models`, {
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
  });
  const page = await anthropic.json();
  assert.deepEqual(
    page.data.map((model) => [model.type, model.id]),
    [
      ["model", "model-a"],
      ["model", "model-b"],
    ],
  );
  assert.equal(page.has_more, false);
  const unauthenticated = await fetch(`${fake.url}/v1/models`);
  assert.equal(unauthenticated.status, 401);
  const posted = await fetch(`${fake.url}/v1/models`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}` },
  });
  assert.equal(posted.status, 405);
});

test("Messages count_tokens counts input tokens and checks its own field list", async (t) => {
  const fake = await provider(t, { mode: "whitelist" });
  const headers = {
    "content-type": "application/json",
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
  };
  const counted = await fetch(`${fake.url}/v1/messages/count_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "count these words" }],
    }),
  });
  assert.equal(counted.status, 200);
  const { input_tokens } = await counted.json();
  assert.ok(Number.isInteger(input_tokens) && input_tokens > 0);
  // max_tokens belongs to a Messages request, not to count_tokens.
  const rejected = await fetch(`${fake.url}/v1/messages/count_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 5,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  assert.equal(rejected.status, 400);
  assert.match(
    (await rejected.json()).error.message,
    /^max_tokens: Extra inputs are not permitted/,
  );
  const [first] = await records(fake);
  assert.equal(first.turn, "count-tokens");
});

test("ported strict Chat rules reject developer roles, misplaced or repeated system messages and tool_choice without tools", async (t) => {
  const fake = await provider(t);
  const cases = [
    [
      {
        messages: [
          { role: "developer", content: "d" },
          { role: "user", content: "hi" },
        ],
      },
      "messages[0].role",
    ],
    [
      {
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "s" },
        ],
      },
      "messages[1]",
    ],
    [
      {
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "hi" },
        ],
      },
      "messages[1]",
    ],
    [{ tool_choice: "auto" }, "tool_choice"],
    [{ tools: [{ type: "web_search" }] }, "tools[0]"],
    [{ max_completion_tokens: 10 }, "max_completion_tokens"],
    [{ model: "" }, "model"],
  ];
  for (const [body, path] of cases) {
    const result = await send(fake, "chat", { body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.json.error.param, path, JSON.stringify(body));
  }
});

test("Messages requires anthropic-version and max_tokens; Gemini requires contents", async (t) => {
  const fake = await provider(t);
  const versionless = await fetch(`${fake.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 5,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  assert.equal(versionless.status, 400);
  assert.match(
    (await versionless.json()).error.message,
    /anthropic-version: header is required/,
  );
  const noLimit = await send(fake, "messages", {
    body: (body) => ({ ...body, max_tokens: undefined }),
  });
  assert.equal(noLimit.status, 400);
  assert.match(noLimit.json.error.message, /^max_tokens: Field required/);
  const noContents = await send(fake, "gemini", {
    body: () => ({ contents: [] }),
  });
  assert.equal(noContents.status, 400);
  assert.equal(
    noContents.json.error.details[0].fieldViolations[0].field,
    "contents",
  );
});

test("streamOnly rejects non-streaming requests in every protocol", async (t) => {
  const fake = await provider(t, { streamOnly: true });
  for (const protocol of PROTOCOLS) {
    assert.equal(
      (await send(fake, protocol, { stream: true })).status,
      200,
      protocol,
    );
    const rejected = await send(fake, protocol, { stream: false });
    assert.equal(rejected.status, 400, protocol);
  }
  const rules = fake.violations().map((violation) => violation.rule);
  assert.deepEqual(rules, ["stream", "stream", "stream", "stream"]);
});

test("whitelist mode accepts declared fields, Gemini snake_case spellings and fields a manifest adds", async (t) => {
  const strict = await provider(t, { mode: "whitelist" });
  const declared = {
    chat: {
      temperature: 0.2,
      max_tokens: 64,
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      tool_choice: "auto",
    },
    responses: {
      instructions: "be brief",
      max_output_tokens: 64,
      reasoning: { effort: "low" },
      include: [],
    },
    messages: {
      system: "be brief",
      temperature: 0.2,
      thinking: { type: "enabled", budget_tokens: 1024 },
      metadata: { user_id: "u" },
    },
    gemini: {
      system_instruction: { parts: [{ text: "be brief" }] },
      generation_config: { max_output_tokens: 64 },
    },
  };
  for (const protocol of PROTOCOLS) {
    const result = await send(strict, protocol, { body: declared[protocol] });
    assert.equal(result.status, 200, `${protocol}: ${result.text}`);
  }
  assert.equal(
    (await send(strict, "chat", { body: { user: "u" } })).status,
    400,
  );
  const extended = await provider(t, {
    mode: "whitelist",
    fields: { chat: { declared: { topLevel: ["user"] } } },
  });
  assert.equal(
    (await send(extended, "chat", { body: { user: "u" } })).status,
    200,
  );
  const stricter = await provider(t, {
    fields: {
      chat: { forbidden: { topLevel: { temperature: "not tunable here" } } },
    },
  });
  const rejected = await send(stricter, "chat", { body: { temperature: 1 } });
  assert.equal(rejected.status, 400);
  assert.equal(
    rejected.json.error.message,
    "Unsupported parameter: 'temperature' is not tunable here.",
  );
  // `allowed` takes a field off the blacklist and declares it.
  const lenient = await provider(t, {
    fields: {
      chat: {
        allowed: { topLevel: ["max_completion_tokens"] },
        forbidden: { topLevel: { max_tokens: "send max_completion_tokens" } },
      },
    },
  });
  assert.equal(
    (await send(lenient, "chat", { body: { max_completion_tokens: 16 } }))
      .status,
    200,
  );
  assert.equal(
    (await send(lenient, "chat", { body: { max_tokens: 16 } })).status,
    400,
  );
  assert.equal(
    (await send(stricter, "chat", { body: { max_completion_tokens: 16 } }))
      .status,
    400,
  );
});

test("field manifests and options are validated before listening", async () => {
  assert.throws(() => resolveFields({ cohere: {} }), /unknown protocol cohere/);
  assert.throws(
    () => resolveFields({ chat: { declared: { headers: ["x"] } } }),
    /unknown scope chat.declared.headers/,
  );
  assert.throws(
    () => resolveFields({ chat: { declared: { topLevel: "user" } } }),
    /must be an array of names/,
  );
  assert.throws(
    () => resolveFields({ chat: { forbidden: { topLevel: { user: "" } } } }),
    /must map names to reasons/,
  );
  assert.throws(
    () => resolveFields({ chat: { permitted: {} } }),
    /is not declared, forbidden or allowed/,
  );
  assert.throws(
    () => resolveFields({ chat: { allowed: { topLevel: "store" } } }),
    /chat.allowed.topLevel must be an array of names/,
  );
  assert.throws(
    () => resolveFields({ chat: { allowed: { headers: ["x"] } } }),
    /unknown scope chat.allowed.headers/,
  );
  await assert.rejects(
    startFakeProvider({ mode: "strict" }),
    /mode must be blacklist or whitelist/,
  );
  await assert.rejects(
    startFakeProvider({ models: [] }),
    /models must be a non-empty array/,
  );
  await assert.rejects(
    startFakeProvider({ keys: { main: "" } }),
    /non-empty key values/,
  );
  await assert.rejects(
    startFakeProvider({ apiKey: KEY }),
    /Unknown fake provider option apiKey/,
  );
  for (const forbiddenHeaders of ["authorization", ["Authorization"], [""]])
    await assert.rejects(
      startFakeProvider({ forbiddenHeaders }),
      /forbiddenHeaders must be at most 32 lowercase header names/,
    );
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("127.8.9.10"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("localhost"), true);
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "10.0.0.1",
    "example.com",
    "128.0.0.1",
  ])
    assert.equal(isLoopback(host), false, host);
});

test("a forbidden request header is a violation in every protocol, with its path", async (t) => {
  const fake = await provider(t, {
    forbiddenHeaders: ["chatgpt-account-id"],
  });
  for (const protocol of PROTOCOLS) {
    const clean = await send(fake, protocol);
    assert.equal(clean.status, 200, protocol);
    const sent = await send(fake, protocol, {
      headers: { "ChatGPT-Account-Id": "acct-synthetic" },
    });
    assert.equal(sent.status, 400, protocol);
    assertEnvelope(protocol, 400, sent.json);
  }
  await fake.idle();
  const violations = fake.violations();
  assert.equal(violations.length, PROTOCOLS.length);
  for (const violation of violations)
    assert.deepEqual([violation.path, violation.rule], [
      "header:chatgpt-account-id",
      "forbidden",
    ]);
  assert.ok(!JSON.stringify(fake.records()).includes("acct-synthetic"));
});

test("unknown paths, wrong methods and oversized bodies get native errors", async (t) => {
  const fake = await provider(t, { maxBodyBytes: 1024 });
  const unknown = await fetch(`${fake.url}/v2/complete`, { method: "POST" });
  assert.equal(unknown.status, 404);
  assertEnvelope("chat", 404, await unknown.json());
  const method = await fetch(`${fake.url}/v1/messages`, {
    headers: { "x-api-key": KEY },
  });
  assert.equal(method.status, 405);
  assertEnvelope("messages", 405, await method.json());
  const large = await send(fake, "gemini", { text: "x".repeat(2048) });
  assert.equal(large.status, 413);
  assertEnvelope("gemini", 413, large.json);
});
