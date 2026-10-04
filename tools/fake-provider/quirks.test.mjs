// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { parseSse } from "./decode.mjs";
import { PROTOCOLS, startFakeProvider } from "./index.mjs";
import { resolveQuirks } from "./quirks.mjs";
import { authHeaders, callPath, KEY, minimalBody, send } from "./testing.mjs";

async function provider(t, options = {}) {
  const fake = await startFakeProvider({
    keys: { main: KEY },
    chunkDelayMs: 0,
    ...options,
  });
  t.after(() => fake.close());
  return fake;
}

const TOOL_SCRIPT = {
  turns: [
    {
      repeat: true,
      reasoning: "Run it.",
      toolCalls: [{ name: "bash", arguments: { command: "echo hello world" } }],
    },
  ],
};

test("noUsage: answers in every protocol and form carry no usage", async (t) => {
  const fake = await provider(t, { quirks: { noUsage: true } });
  for (const protocol of PROTOCOLS)
    for (const stream of [false, true]) {
      const result = await send(fake, protocol, { stream });
      assert.equal(result.status, 200);
      assert.equal(result.answer.text, "OK");
      assert.equal(result.answer.usage, undefined, `${protocol} ${stream}`);
    }
  await fake.idle();
  for (const record of fake.records())
    assert.deepEqual(record.quirks, ["noUsage"]);
});

test("duplicateFinish: every stream repeats its finishing event", async (t) => {
  const fake = await provider(t, { quirks: { duplicateFinish: true } });
  const expected = {
    chat: ["stop", "stop"],
    responses: ["completed", "completed"],
    messages: ["end_turn", "end_turn"],
    gemini: ["STOP", "STOP"],
  };
  for (const protocol of PROTOCOLS) {
    const result = await send(fake, protocol, { stream: true });
    assert.deepEqual(result.answer.finishes, expected[protocol], protocol);
    assert.equal(result.answer.text, "OK", protocol);
  }
});

test("missingToolIndex: streamed argument deltas lack their index and still carry the arguments", async (t) => {
  const fake = await provider(t, {
    script: TOOL_SCRIPT,
    quirks: { missingToolIndex: true },
  });
  const expected = JSON.stringify({ command: "echo hello world" });
  for (const protocol of PROTOCOLS) {
    const result = await send(fake, protocol, { stream: true });
    assert.equal(result.answer.toolCalls.length, 1, protocol);
    assert.equal(
      JSON.stringify(JSON.parse(result.answer.toolCalls[0].arguments)),
      expected,
      protocol,
    );
    const values = parseSse(result.text).events.map(({ data }) =>
      data === "[DONE]" ? {} : JSON.parse(data),
    );
    if (protocol === "chat") {
      const deltas = values.flatMap(
        (chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [],
      );
      assert.equal(deltas[0].index, 0);
      assert.ok(deltas.length > 1);
      for (const delta of deltas.slice(1))
        assert.equal(Object.hasOwn(delta, "index"), false);
    }
    if (protocol === "responses") {
      const deltas = values.filter(
        (event) => event.type === "response.function_call_arguments.delta",
      );
      assert.ok(deltas.length > 0);
      for (const delta of deltas)
        assert.equal(Object.hasOwn(delta, "output_index"), false);
    }
    if (protocol === "messages") {
      const deltas = values.filter(
        (event) => event.delta?.type === "input_json_delta",
      );
      assert.ok(deltas.length > 0);
      for (const delta of deltas)
        assert.equal(Object.hasOwn(delta, "index"), false);
    }
  }
});

test("interleavedToolArgs: Chat and Responses alternate the argument deltas of parallel calls", async (t) => {
  const calls = [
    { name: "read", arguments: { path: "alpha.txt" } },
    { name: "read", arguments: { path: "beta.txt" } },
  ];
  const fake = await provider(t, {
    script: { turns: [{ repeat: true, toolCalls: calls }] },
    quirks: { interleavedToolArgs: true },
  });
  for (const protocol of PROTOCOLS) {
    const result = await send(fake, protocol, { stream: true });
    assert.deepEqual(
      result.answer.toolCalls.map((call) => JSON.parse(call.arguments)),
      calls.map((call) => call.arguments),
      protocol,
    );
    const values = parseSse(result.text).events.map(({ data }) =>
      data === "[DONE]" ? {} : JSON.parse(data),
    );
    // The call each argument delta belongs to, in arrival order.
    const owners =
      protocol === "chat"
        ? values
            .flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [])
            .filter((delta) => !delta.id)
            .map((delta) => delta.index)
        : protocol === "responses"
          ? values
              .filter(
                (event) =>
                  event.type === "response.function_call_arguments.delta",
              )
              .map((event) => event.output_index)
          : undefined;
    if (owners) assert.deepEqual(owners, [0, 1, 0, 1], protocol);
  }
  // Messages blocks stay sequential.
  const messages = await send(fake, "messages", { stream: true });
  const indexes = parseSse(messages.text)
    .events.map(({ data }) => JSON.parse(data))
    .filter((event) => event.delta?.type === "input_json_delta")
    .map((event) => event.index);
  assert.deepEqual(indexes, [...indexes].sort());
});

test("disconnect: the connection is reset after some frames without an error or a terminal frame", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [{ repeat: true, text: ["one", "two", "three", "four"] }],
    },
    quirks: { disconnect: 2 },
  });
  for (const protocol of PROTOCOLS) {
    const response = await fetch(
      fake.url + callPath(protocol, { stream: true }),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeaders(protocol, KEY),
        },
        body: JSON.stringify(minimalBody(protocol, { stream: true })),
      },
    );
    assert.equal(response.status, 200, protocol);
    let text = "";
    const decoder = new TextDecoder();
    await assert.rejects(async () => {
      for await (const chunk of response.body) text += decoder.decode(chunk);
    }, protocol);
    const events = parseSse(text).events;
    assert.equal(events.length, 2, protocol);
    assert.doesNotMatch(
      text,
      /\[DONE\]|response\.(?:completed|failed)|message_stop|event: error|"error":\{|finishReason/,
      protocol,
    );
  }
  await assert.rejects(send(fake, "chat", { stream: false }));
  await fake.idle();
  const records = fake.records();
  assert.equal(records.length, PROTOCOLS.length + 1);
  for (const record of records) {
    assert.equal(record.disconnected, true);
    assert.equal(record.midStreamError, undefined);
    assert.equal(record.aborted, undefined);
  }
});

test("commentKeepalive: only keepalives are sent before the first data, in the form of each body", async (t) => {
  const fake = await provider(t, {
    quirks: { commentKeepalive: { durationMs: 300, intervalMs: 50 } },
  });
  for (const [protocol, stream, sse] of [
    ["chat", true, true],
    ["messages", true, true],
    ["gemini", true, true],
    ["gemini", true, false],
    ["responses", false, true],
  ]) {
    const started = performance.now();
    const response = await fetch(
      fake.url + callPath(protocol, { stream, sse }),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeaders(protocol, KEY),
        },
        body: JSON.stringify(minimalBody(protocol, { stream })),
      },
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let prefix = "";
    let firstData;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      prefix += decoder.decode(value, { stream: true });
      if (firstData === undefined && /data:|[[{]/.test(prefix))
        firstData = performance.now() - started;
    }
    const where = `${protocol} stream=${stream} sse=${sse}`;
    assert.ok(firstData >= 290, `${where}: first data after ${firstData} ms`);
    if (stream && sse) {
      assert.match(prefix, /^(: keepalive\n\n){5,}/, where);
      assert.ok(parseSse(prefix).comments >= 5, where);
    } else {
      assert.match(prefix, /^\n{5,}[[{]/, where);
      JSON.parse(prefix);
    }
  }
});

test("htmlBody: HTTP 200 with an HTML page instead of the answer", async (t) => {
  const fake = await provider(t, { quirks: { htmlBody: true } });
  for (const protocol of PROTOCOLS) {
    const result = await send(fake, protocol, { stream: true });
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type"), /^text\/html/);
    assert.match(result.text, /^<!DOCTYPE html>/);
  }
});

test("abnormalFinish: the answer ends with a non-standard finish reason, verbatim", async (t) => {
  const fake = await provider(t, { quirks: { abnormalFinish: true } });
  const expected = {
    chat: "network_error",
    responses: "incomplete:network_error",
    messages: "network_error",
    gemini: "network_error",
  };
  for (const protocol of PROTOCOLS)
    for (const stream of [false, true]) {
      const result = await send(fake, protocol, { stream });
      assert.deepEqual(
        result.answer.finishes,
        [expected[protocol]],
        `${protocol} ${stream}`,
      );
    }
  const custom = await provider(t, { quirks: { abnormalFinish: "OTHER" } });
  assert.deepEqual((await send(custom, "gemini")).answer.finishes, ["OTHER"]);
});

test("slowHeaders: the response headers arrive only after the delay", async (t) => {
  const fake = await provider(t, { quirks: { slowHeaders: 400 } });
  for (const protocol of ["chat", "gemini"]) {
    const started = performance.now();
    const response = await fetch(
      fake.url + callPath(protocol, { stream: true }),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(protocol, KEY),
        },
        body: JSON.stringify(minimalBody(protocol, { stream: true })),
      },
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 390, `${protocol}: headers after ${elapsed} ms`);
    await response.text();
  }
});

test("midStreamError: streams report an in-stream error in the native form, a non-streaming body is cut off", async (t) => {
  const fake = await provider(t, {
    quirks: { midStreamError: { after: 2, message: "boom" } },
  });
  const chat = await send(fake, "chat", { stream: true });
  assert.equal(chat.answer.error.message, "boom");
  assert.equal(chat.answer.done, false);
  const responses = await send(fake, "responses", { stream: true });
  assert.deepEqual(responses.answer.events, [
    "response.created",
    "response.in_progress",
    "response.failed",
  ]);
  assert.equal(responses.answer.error.message, "boom");
  const messages = await send(fake, "messages", { stream: true });
  assert.deepEqual(messages.answer.events, ["message_start", "ping", "error"]);
  assert.deepEqual(messages.answer.error, {
    type: "api_error",
    message: "boom",
  });
  const sse = await send(fake, "gemini", { stream: true });
  assert.equal(sse.answer.error.status, "INTERNAL");
  const array = await send(fake, "gemini", { stream: true, sse: false });
  assert.equal(JSON.parse(array.text).at(-1).error.message, "boom");
  await assert.rejects(send(fake, "chat", { stream: false }));
  await fake.idle();
  const records = fake.records();
  assert.equal(records.length, 6);
  for (const record of records) {
    assert.equal(record.midStreamError, true);
    assert.equal(record.aborted, undefined);
  }
});

test("retryAfter: 429 or 503 with a Retry-After header and the native error body", async (t) => {
  const limited = await provider(t, { quirks: { retryAfter: true } });
  for (const protocol of PROTOCOLS) {
    const result = await send(limited, protocol, { stream: true });
    assert.equal(result.status, 429, protocol);
    assert.equal(result.headers.get("retry-after"), "1", protocol);
    if (protocol === "chat")
      assert.equal(result.json.error.code, "rate_limit_exceeded");
    if (protocol === "messages")
      assert.equal(result.json.error.type, "rate_limit_error");
    if (protocol === "gemini") {
      assert.equal(result.json.error.status, "RESOURCE_EXHAUSTED");
      assert.equal(result.json.error.details[0].retryDelay, "1s");
    }
  }
  const unavailable = await provider(t, {
    quirks: { retryAfter: { status: 503, seconds: 7 } },
  });
  const result = await send(unavailable, "gemini");
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("retry-after"), "7");
  assert.equal(result.json.error.status, "UNAVAILABLE");
});

test("servedModel: answers in every protocol and form name another model", async (t) => {
  const fake = await provider(t, { quirks: { servedModel: "swapped-model" } });
  for (const protocol of PROTOCOLS)
    for (const stream of [false, true]) {
      const result = await send(fake, protocol, { stream });
      assert.equal(result.status, 200);
      // Chat, Responses and Messages name it `model`, Gemini `modelVersion`.
      assert.match(result.text, /"(model|modelVersion)":"swapped-model"/, `${protocol} ${stream}`);
      assert.doesNotMatch(result.text, /upstream-sim/, `${protocol} ${stream}`);
    }
  await fake.idle();
  for (const record of fake.records())
    assert.deepEqual(record.quirks, ["servedModel"]);
});

test("a script turn's quirks replace the global ones for that turn", async (t) => {
  const fake = await provider(t, {
    quirks: { noUsage: true },
    script: {
      turns: [
        { quirks: { noUsage: false, retryAfter: 2 } },
        { quirks: { noUsage: false } },
      ],
    },
  });
  const limited = await send(fake, "chat");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "2");
  assert.ok((await send(fake, "chat")).answer.usage);
  assert.equal((await send(fake, "chat")).answer.usage, undefined);
});

test("quirk switches are validated", () => {
  assert.throws(
    () => resolveQuirks({ slowBody: true }),
    /quirks.slowBody is not a known quirk/,
  );
  assert.throws(
    () => resolveQuirks({ noUsage: "yes" }),
    /quirks.noUsage must be true or false/,
  );
  assert.throws(
    () => resolveQuirks({ servedModel: "" }),
    /quirks.servedModel must be false or a model name/,
  );
  assert.throws(
    () => resolveQuirks({ slowHeaders: -1 }),
    /quirks.slowHeaders must be an integer/,
  );
  assert.throws(
    () => resolveQuirks({ retryAfter: { status: 500 } }),
    /status must be 429 or 503/,
  );
  assert.throws(
    () => resolveQuirks({ midStreamError: { at: 2 } }),
    /midStreamError.at is not a known setting/,
  );
  assert.throws(
    () => resolveQuirks({ commentKeepalive: "1s" }),
    /commentKeepalive must be/,
  );
  assert.throws(
    () => resolveQuirks({ abnormalFinish: "" }),
    /abnormalFinish must be/,
  );
  assert.throws(
    () => resolveQuirks({ disconnect: "soon" }),
    /disconnect must be true, false or a frame count/,
  );
  assert.throws(
    () => resolveQuirks({ interleavedToolArgs: 1 }),
    /interleavedToolArgs must be true or false/,
  );
  assert.deepEqual(
    resolveQuirks({ retryAfter: 3, midStreamError: false, disconnect: true }),
    {
      retryAfter: { status: 429, seconds: 3 },
      midStreamError: null,
      disconnect: { after: 1 },
    },
  );
});
