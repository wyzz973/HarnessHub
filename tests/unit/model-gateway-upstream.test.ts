import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  DEFAULT_GATEWAY_LIMITS,
  createModelGateway,
  type GatewayLimits,
  type ModelCallRecord,
  type ModelGatewayOptions,
} from "../../src/drivers/chat-completions/gateway.js";

type Body = Record<string, unknown>;
interface Upstream {
  baseUrl: string;
  requests: { url: string; headers: IncomingHttpHeaders; body: Body }[];
  handler: (body: Body, response: ServerResponse) => void;
}
async function upstream(
  t: test.TestContext,
  handler: Upstream["handler"],
): Promise<Upstream> {
  const state: Upstream = { baseUrl: "", requests: [], handler };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = (text ? JSON.parse(text) : {}) as Body;
      state.requests.push({
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      state.handler(body, response);
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  state.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return state;
}
function raw(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(text);
}
function stream(response: ServerResponse, chunks: unknown[]): void {
  raw(
    response,
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
  );
}
function delta(value: Body, finish: string | null = null): Body {
  return { choices: [{ index: 0, delta: value, finish_reason: finish }] };
}
function fail(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
async function gateway(
  t: test.TestContext,
  baseUrl: string,
  options: Partial<ModelGatewayOptions> = {},
  limits: Partial<GatewayLimits> = {},
) {
  const calls: ModelCallRecord[] = [];
  const gw = await createModelGateway(
    {
      upstream: {
        protocol: "openai-completions",
        baseUrl,
        apiKey: "sk-test-upstream-key",
        headers: { "x-tenant": "tenant-secret-value" },
      },
      model: "upstream-model",
      alias: "harnesshub-model",
      onCall: (call) => calls.push(call),
      ...options,
    },
    { ...DEFAULT_GATEWAY_LIMITS, ...limits },
  );
  t.after(() => gw.close());
  gw.beginRun(new AbortController().signal);
  const send = (path: string, body: unknown) =>
    fetch(gw.baseUrl + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gw.token}`,
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const chat = async (body: Body = {}) =>
    (await (
      await send("/v1/chat/completions", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        ...body,
      })
    ).json()) as unknown;
  return { gw, calls, send, chat };
}
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
const READ = {
  type: "function",
  function: { name: "read", parameters: { type: "object" } },
};

void test("SSE parsing tolerates null or missing choices, index, delta and id, CRLF, comments, no [DONE] and no final blank line", async (t) => {
  const up = await upstream(t, (_, response) =>
    raw(
      response,
      ": keep-alive\r\n\r\n" +
        'data: {"choices":null}\r\n\r\n' +
        'data: {"choices":[{"delta":null}]}\r\n\r\n' +
        'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n' +
        'data: {"id":null,"choices":[{"index":null,"delta":{"content":"b"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"index":0,"delta":{"content":"c"}}]}',
    ),
  );
  const { chat, calls } = await gateway(t, up.baseUrl);
  const body = await chat();
  assert.equal(at(body, "choices", 0, "message", "content"), "abc");
  assert.equal(at(body, "choices", 0, "finish_reason"), "stop");
  assert.equal(calls[0]!.ok, true);
  assert.equal(calls[0]!.finishReason, "stop");
});

void test("finish reasons: the last repeated value wins, tool calls report tool_calls and length is kept", async (t) => {
  const scripts: Record<string, unknown[]> = {
    repeated: [delta({ content: "x" }, "stop"), delta({}, "length")],
    tools: [
      delta({
        tool_calls: [
          {
            index: 0,
            id: "c1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      }),
      delta({}, "stop"),
    ],
    truncated: [
      delta({
        tool_calls: [
          { index: 0, id: "c2", function: { name: "read", arguments: '{"pa' } },
        ],
      }),
      delta({}, "length"),
    ],
  };
  const up = await upstream(t, (body, response) =>
    stream(response, scripts[String(at(body, "messages", 0, "content"))]!),
  );
  const { chat, send } = await gateway(t, up.baseUrl);
  const reason = async (content: string) =>
    at(
      await chat({ messages: [{ role: "user", content }], tools: [READ] }),
      "choices",
      0,
      "finish_reason",
    );
  assert.equal(await reason("repeated"), "length");
  assert.equal(await reason("tools"), "tool_calls");
  assert.equal(await reason("truncated"), "length");
  const anthropic = (await (
    await send("/v1/messages", {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "tools" }],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    })
  ).json()) as unknown;
  assert.equal(at(anthropic, "stop_reason"), "tool_use");
});

void test("usage is parsed leniently and empty tool arguments become {}", async (t) => {
  const scripts: Record<string, unknown[]> = {
    partial: [
      delta({ content: "x" }, "stop"),
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    ],
    output: [
      delta({ content: "x" }, "stop"),
      { usage: { completion_tokens: 4 } },
    ],
    invalid: [
      delta({ content: "x" }, "stop"),
      { usage: { prompt_tokens: "3" } },
    ],
    empty: [
      delta({
        tool_calls: [
          {
            index: 0,
            id: "c1",
            type: "function",
            function: { name: "list", arguments: "" },
          },
        ],
      }),
      delta({}, "tool_calls"),
    ],
  };
  const up = await upstream(t, (body, response) => {
    const text = JSON.stringify(body);
    const key = Object.keys(scripts).find((name) =>
      text.includes(`"${name}"`),
    )!;
    stream(response, scripts[key]!);
  });
  const { chat, send, calls } = await gateway(t, up.baseUrl);
  const partial = await chat({
    messages: [{ role: "user", content: "partial" }],
  });
  assert.deepEqual(at(partial, "usage"), {
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
  });
  assert.deepEqual(calls[0]!.usage, { input: 3, output: 4, total: 7 });
  await chat({ messages: [{ role: "user", content: "output" }] });
  assert.deepEqual(calls[1]!.usage, { output: 4 });
  await chat({ messages: [{ role: "user", content: "invalid" }] });
  assert.equal(calls[2]!.usage, undefined);
  assert.equal(calls[2]!.ok, true);
  const empty = await chat({
    messages: [{ role: "user", content: "empty" }],
    tools: [READ],
  });
  assert.equal(
    at(
      empty,
      "choices",
      0,
      "message",
      "tool_calls",
      0,
      "function",
      "arguments",
    ),
    "{}",
  );
  const anthropic = (await (
    await send("/v1/messages", {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "empty" }],
      tools: [{ name: "list", input_schema: { type: "object" } }],
    })
  ).json()) as unknown;
  assert.deepEqual(at(anthropic, "content", 0), {
    type: "tool_use",
    id: "c1",
    name: "list",
    input: {},
  });
  const google = (await (
    await send("/v1beta/models/g:generateContent", {
      contents: [{ role: "user", parts: [{ text: "empty" }] }],
      tools: [{ functionDeclarations: [{ name: "list" }] }],
    })
  ).json()) as unknown;
  assert.deepEqual(
    at(google, "candidates", 0, "content", "parts", 0, "functionCall", "args"),
    {},
  );
});

void test("tool call fragments: repeated full names and ids are not doubled; missing ids and indexes are handled", async (t) => {
  const scripts: Record<string, unknown[]> = {
    repeated: [
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_9",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      }),
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_9",
            type: "function",
            function: { name: "read", arguments: '{"a":' },
          },
        ],
      }),
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_9",
            function: { name: "read", arguments: "1}" },
          },
        ],
      }),
      delta({}, "tool_calls"),
    ],
    split: [
      delta({
        tool_calls: [{ index: 0, function: { name: "read_", arguments: "" } }],
      }),
      delta({
        tool_calls: [{ index: 0, function: { name: "file", arguments: "{}" } }],
      }),
      delta({}, "tool_calls"),
    ],
    unindexed: [
      delta({
        tool_calls: [
          { type: "function", function: { name: "a", arguments: "" } },
        ],
      }),
      delta({ tool_calls: [{ function: { arguments: '{"x":1}' } }] }),
      delta({ tool_calls: [{ function: { name: "b", arguments: "{}" } }] }),
      delta({ tool_calls: null }),
    ],
  };
  const up = await upstream(t, (body, response) =>
    stream(response, scripts[String(at(body, "messages", 0, "content"))]!),
  );
  const { chat } = await gateway(t, up.baseUrl);
  const calls = async (content: string) =>
    at(
      await chat({ messages: [{ role: "user", content }], tools: [READ] }),
      "choices",
      0,
      "message",
      "tool_calls",
    ) as unknown[];
  assert.deepEqual(await calls("repeated"), [
    {
      id: "call_9",
      type: "function",
      function: { name: "read", arguments: '{"a":1}' },
    },
  ]);
  assert.equal(at((await calls("split"))[0], "function", "name"), "read_file");
  const unindexed = await calls("unindexed");
  assert.deepEqual(
    unindexed.map((call) => [
      at(call, "function", "name"),
      at(call, "function", "arguments"),
    ]),
    [
      ["a", '{"x":1}'],
      ["b", "{}"],
    ],
  );
  const ids = unindexed.map((call) => String(at(call, "id")));
  assert.ok(
    ids.every((id) => /^call_\w+$/.test(id)),
    ids.join(),
  );
  assert.equal(new Set(ids).size, 2);
  const again = (await calls("unindexed")).map((call) =>
    String(at(call, "id")),
  );
  assert.equal(new Set([...ids, ...again]).size, 4);
});

void test("the reasoning field name, JSON bodies and in-stream errors from the upstream are honored", async (t) => {
  const up = await upstream(t, (body, response) => {
    const text = String(at(body, "messages", 0, "content"));
    if (text === "json")
      return fail(response, 200, {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "whole",
              reasoning_content: "why",
              tool_calls: [
                {
                  id: "j1",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    if (text === "error-first")
      return raw(
        response,
        'data: {"error":{"message":"quota exceeded","code":429}}\n\n',
      );
    if (text === "error-later")
      return raw(
        response,
        `data: ${JSON.stringify(delta({ content: "par" }))}\n\n` +
          'data: {"error":{"message":"upstream exploded","type":"server_error"}}\n\n',
      );
    stream(response, [
      delta({ reasoning: "think" }),
      delta({ content: "done" }, "stop"),
    ]);
  });
  const { chat, send, calls, gw } = await gateway(t, up.baseUrl);
  assert.equal(at(await chat(), "choices", 0, "message", "reasoning"), "think");
  const json = await chat({
    messages: [{ role: "user", content: "json" }],
    tools: [READ],
  });
  assert.equal(at(json, "choices", 0, "message", "content"), "whole");
  assert.equal(at(json, "choices", 0, "message", "reasoning_content"), "why");
  assert.equal(at(json, "choices", 0, "message", "tool_calls", 0, "id"), "j1");
  const first = await send("/v1/chat/completions", {
    model: "m",
    stream: true,
    messages: [{ role: "user", content: "error-first" }],
  });
  assert.equal(first.status, 429);
  assert.equal(at(await first.json(), "error", "message"), "quota exceeded");
  const later = await send("/v1/chat/completions", {
    model: "m",
    stream: true,
    messages: [{ role: "user", content: "error-later" }],
  });
  assert.equal(later.status, 200);
  const text = await later.text();
  assert.match(text, /"content":"par"/);
  assert.match(text, /data: \{"error":\{"message":"upstream exploded"/);
  assert.doesNotMatch(text, /\[DONE\]/);
  assert.deepEqual(
    calls.map((call) => [call.ok, call.status, call.error?.code]),
    [
      [true, 200, undefined],
      [true, 200, undefined],
      [false, 429, "upstream_error"],
      [false, 502, "upstream_error"],
    ],
  );
  assert.equal(gw.runErrors().length, 2);
});

void test("upstream requests are normalized: model, stream, dropped parameters, one system message, text parts and the output limit field", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const { chat } = await gateway(t, up.baseUrl + "/", {
    maxOutputTokens: 8192,
    compatibility: {
      dropParameters: ["foo", "model"],
      maxTokensField: "max_completion_tokens",
    },
  });
  await chat({
    model: "gpt-anything",
    store: true,
    metadata: { a: 1 },
    service_tier: "auto",
    prediction: { type: "content", content: "x" },
    modalities: ["text"],
    audio: { voice: "x" },
    web_search_options: {},
    user: "u",
    stream: false,
    stream_options: { include_usage: true },
    parallel_tool_calls: true,
    reasoning_effort: "high",
    tool_choice: "auto",
    tools: [],
    max_tokens: 100000,
    max_completion_tokens: 50000,
    foo: 1,
    temperature: 0.3,
    messages: [
      { role: "system", content: "a" },
      { role: "developer", content: [{ type: "text", text: "b" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "text", text: "y" },
        ],
      },
      { role: "system", content: "c" },
      { role: "assistant", content: [{ type: "text", text: "z" }] },
    ],
  });
  const sent = up.requests[0]!;
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer sk-test-upstream-key");
  assert.equal(sent.headers["x-tenant"], "tenant-secret-value");
  assert.deepEqual(sent.body, {
    temperature: 0.3,
    max_completion_tokens: 8192,
    messages: [
      { role: "system", content: "a\n\nb\n\nc" },
      { role: "user", content: "x\ny" },
      { role: "assistant", content: "z" },
    ],
    model: "upstream-model",
    stream: true,
  });
});

void test("include_usage is sent only when configured, no output limit is invented and engine limits are clamped", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const { chat, send } = await gateway(t, up.baseUrl, {
    maxOutputTokens: 4096,
    compatibility: { includeUsage: true },
  });
  await chat();
  assert.deepEqual(up.requests[0]!.body.stream_options, {
    include_usage: true,
  });
  assert.equal("max_tokens" in up.requests[0]!.body, false);
  await send("/v1/messages", {
    model: "m",
    max_tokens: 32000,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(up.requests[1]!.body.max_tokens, 4096);
  await send("/v1/responses", {
    model: "m",
    input: "hi",
    max_output_tokens: 100,
  });
  assert.equal(up.requests[2]!.body.max_tokens, 100);
  await send("/v1beta/models/g:generateContent", {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 65536 },
  });
  assert.equal(up.requests[3]!.body.max_tokens, 4096);
});

void test("upstream HTTP errors keep their status with sanitized, truncated messages in each protocol format", async (t) => {
  const secretMessage =
    "Invalid key sk-test-upstream-key; header tenant-secret-value; Authorization: Bearer abcdefghijklmnop; api_key=supersecretvalue; " +
    "detail ".repeat(200);
  const up = await upstream(t, (body, response) => {
    const status = Number(
      JSON.stringify(body).match(/status-(\d+)/)?.[1] ?? 500,
    );
    fail(response, status, {
      error: { message: secretMessage, type: "error" },
    });
  });
  const { send, calls, gw } = await gateway(t, up.baseUrl);
  const check = (message: unknown) => {
    const text = String(message);
    assert.ok(Array.from(text).length <= 500, String(text.length));
    for (const secret of [
      "sk-test-upstream-key",
      "tenant-secret-value",
      "abcdefghijklmnop",
      "supersecretvalue",
      gw.token,
    ])
      assert.equal(text.includes(secret), false, secret);
    assert.match(text, /^Invalid key/);
  };
  const chat = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "status-400" }],
  });
  assert.equal(chat.status, 400);
  check(at(await chat.json(), "error", "message"));
  const anthropic = await send("/v1/messages", {
    model: "m",
    max_tokens: 5,
    messages: [{ role: "user", content: "status-429" }],
  });
  assert.equal(anthropic.status, 429);
  const anthropicBody = (await anthropic.json()) as unknown;
  assert.equal(at(anthropicBody, "type"), "error");
  assert.equal(at(anthropicBody, "error", "type"), "rate_limit_error");
  check(at(anthropicBody, "error", "message"));
  const google = await send("/v1beta/models/g:streamGenerateContent?alt=sse", {
    contents: [{ role: "user", parts: [{ text: "status-500" }] }],
  });
  assert.equal(google.status, 500);
  const googleBody = (await google.json()) as unknown;
  assert.equal(at(googleBody, "error", "code"), 500);
  assert.equal(at(googleBody, "error", "status"), "INTERNAL");
  check(at(googleBody, "error", "message"));
  const responses = await send("/v1/responses", {
    model: "m",
    input: "status-503",
    stream: true,
  });
  assert.equal(responses.status, 503);
  check(at(await responses.json(), "error", "message"));
  assert.deepEqual(
    calls.map((call) => [call.status, call.error?.code]),
    [
      [400, "upstream_http_error"],
      [429, "upstream_http_error"],
      [500, "upstream_http_error"],
      [503, "upstream_http_error"],
    ],
  );
  for (const call of calls) check(call.error?.message);
  assert.equal(gw.runErrors().length, 4);
});

void test("context overflow maps to each protocol's context error; an oversized output limit does not", async (t) => {
  const overflow =
    "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens (139000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.";
  const output =
    "This model's maximum context length is 131072 tokens. However, you requested 141000 tokens (1000 in the messages, 140000 in the completion).";
  const up = await upstream(t, (body, response) =>
    fail(response, 400, {
      error: {
        message: JSON.stringify(body).includes("output-limit")
          ? output
          : overflow,
        type: "invalid_request_error",
      },
    }),
  );
  const { send, calls } = await gateway(t, up.baseUrl);
  const chat = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "long" }],
  });
  assert.equal(chat.status, 400);
  assert.equal(
    at(await chat.json(), "error", "code"),
    "context_length_exceeded",
  );
  const responses = await send("/v1/responses", { model: "m", input: "long" });
  assert.equal(responses.status, 400);
  assert.equal(
    at(await responses.json(), "error", "code"),
    "context_length_exceeded",
  );
  const streamed = await send("/v1/responses", {
    model: "m",
    input: "long",
    stream: true,
  });
  assert.equal(streamed.status, 200);
  const text = await streamed.text();
  assert.match(text, /event: response\.failed/);
  assert.match(text, /"code":"context_length_exceeded"/);
  const anthropic = await send("/v1/messages", {
    model: "m",
    max_tokens: 5,
    stream: true,
    messages: [{ role: "user", content: "long" }],
  });
  assert.equal(anthropic.status, 400);
  assert.deepEqual(at(await anthropic.json(), "error"), {
    type: "invalid_request_error",
    message: "prompt is too long: 139000 tokens > 131072 maximum",
  });
  const google = await send("/v1beta/models/g:generateContent", {
    contents: [{ role: "user", parts: [{ text: "long" }] }],
  });
  assert.equal(google.status, 400);
  const googleError = at(await google.json(), "error");
  assert.equal(at(googleError, "status"), "INVALID_ARGUMENT");
  assert.match(
    String(at(googleError, "message")),
    /input token count \(139000\)/,
  );
  const limit = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "output-limit" }],
  });
  assert.equal(limit.status, 400);
  assert.equal(at(await limit.json(), "error", "code"), "upstream_http_error");
  assert.deepEqual(
    calls.map((call) => call.error?.code),
    [
      "context_length_exceeded",
      "context_length_exceeded",
      "context_length_exceeded",
      "context_length_exceeded",
      "context_length_exceeded",
      "upstream_http_error",
    ],
  );
});

void test("unreachable upstreams return 502, silent upstreams 504, and redirects are refused", async (t) => {
  const closed = createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const address = closed.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const unreachable = await gateway(t, `http://127.0.0.1:${address.port}/v1`);
  const refused = await unreachable.send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(refused.status, 502);
  assert.equal(
    at(await refused.json(), "error", "code"),
    "upstream_unreachable",
  );
  let redirected = false;
  const up = await upstream(t, (body, response) => {
    const text = JSON.stringify(body);
    if (text.includes("redirect")) {
      response.writeHead(302, { location: "/v1/elsewhere" });
      response.end();
    } else if (text.includes("elsewhere")) redirected = true;
    else if (text.includes("silent-stream")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(delta({ content: "a" }))}\n\n`);
    } else response.writeHead(200, { "content-type": "text/event-stream" });
  });
  const { send, calls } = await gateway(
    t,
    up.baseUrl,
    {},
    { idleTimeoutMs: 150 },
  );
  const redirect = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "redirect" }],
  });
  assert.equal(redirect.status, 502);
  assert.equal(redirected, false);
  assert.equal(up.requests.length, 1);
  const silent = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "silent" }],
  });
  assert.equal(silent.status, 504);
  assert.equal(at(await silent.json(), "error", "code"), "upstream_timeout");
  const partial = await send("/v1/chat/completions", {
    model: "m",
    stream: true,
    messages: [{ role: "user", content: "silent-stream" }],
  });
  assert.equal(partial.status, 200);
  assert.match(await partial.text(), /"code":"upstream_timeout"/);
  assert.deepEqual(
    calls.map((call) => [call.status, call.error?.code]),
    [
      [502, "upstream_unreachable"],
      [504, "upstream_timeout"],
      [504, "upstream_timeout"],
    ],
  );
});

void test("request and response bodies are bounded, and untranslatable input fails before any upstream call", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "x".repeat(4096) }, "stop")]),
  );
  const { send } = await gateway(
    t,
    up.baseUrl,
    {},
    { maxRequestBytes: 2048, maxResponseBytes: 1024 },
  );
  const large = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "y".repeat(4096) }],
  });
  assert.equal(large.status, 413);
  const invalid = await send("/v1/chat/completions", "{not json");
  assert.equal(invalid.status, 400);
  const rejected = [
    [
      "/v1/messages",
      {
        model: "m",
        max_tokens: 5,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
    ],
    [
      "/v1/responses",
      { model: "m", input: "hi", tools: [{ type: "web_search" }] },
    ],
  ] as const;
  for (const [path, body] of rejected) {
    const response = await send(path, body);
    assert.equal(response.status, 400, path);
    assert.match(
      JSON.stringify(await response.json()),
      /unsupported|not supported/i,
      path,
    );
  }
  assert.equal(up.requests.length, 0);
  const tooLarge = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(tooLarge.status, 502);
  assert.equal(
    at(await tooLarge.json(), "error", "code"),
    "response_too_large",
  );
});

void test("media in every inbound protocol becomes a text placeholder instead of failing the Session", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const { send } = await gateway(t, up.baseUrl);
  const media = [
    [
      "/v1/messages",
      {
        model: "m",
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AA==",
                },
              },
            ],
          },
        ],
      },
    ],
    [
      "/v1/responses",
      {
        model: "m",
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "data:x" }],
          },
        ],
      },
    ],
    [
      "/v1beta/models/g:generateContent",
      {
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }],
          },
        ],
      },
    ],
  ] as const;
  for (const [path, body] of media) {
    const before = up.requests.length;
    const response = await send(path, body);
    assert.equal(response.status, 200, path);
    await response.text();
    assert.equal(up.requests.length, before + 1, path);
    assert.match(
      JSON.stringify(up.requests.at(-1)!.body),
      /omitted: the HarnessHub model gateway forwards text only/,
      path,
    );
  }
  const chatImage = {
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==" },
          },
        ],
      },
    ],
  };
  const placeholder = await send("/v1/chat/completions", chatImage);
  assert.equal(placeholder.status, 200);
  await placeholder.text();
  assert.equal(
    up.requests.at(-1)!.body.messages instanceof Array &&
      typeof (up.requests.at(-1)!.body.messages as { content: unknown }[])[0]!
        .content,
    "string",
  );
  assert.match(JSON.stringify(up.requests.at(-1)!.body), /Image omitted/);
});

void test("vision passthrough keeps Chat image parts for a multimodal model", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const { send } = await gateway(t, up.baseUrl, {
    compatibility: { images: "passthrough" },
  });
  const response = await send("/v1/chat/completions", {
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==" },
          },
        ],
      },
    ],
  });
  assert.equal(response.status, 200);
  await response.text();
  const content = (
    up.requests.at(-1)!.body.messages as { content: unknown }[]
  )[0]!.content as { type: string }[];
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "image_url"],
  );
});

void test("a model request without the Session token is recorded as a Run error instead of disappearing", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const { gw, calls } = await gateway(t, up.baseUrl);
  const response = await fetch(`${gw.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer {env:HARNESSHUB_PROVIDER_KEY}",
    },
    body: JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 401);
  await response.text();
  assert.equal(up.requests.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, 401);
  assert.equal(calls[0]!.ok, false);
  assert.equal(calls[0]!.error?.code, "gateway_unauthorized");
  assert.deepEqual(
    gw.runErrors().map((call) => call.status),
    [401],
  );
});

void test("strict-gateway defaults drop parallel_tool_calls and reasoning_effort and downgrade json_schema output to JSON mode", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "{}" }, "stop")]),
  );
  const { send } = await gateway(t, up.baseUrl);
  const response = await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [READ],
    parallel_tool_calls: false,
    reasoning_effort: "medium",
    response_format: {
      type: "json_schema",
      json_schema: { name: "x", schema: { type: "object" } },
    },
  });
  assert.equal(response.status, 200);
  await response.text();
  const sent = up.requests.at(-1)!.body;
  assert.equal("parallel_tool_calls" in sent, false);
  assert.equal("reasoning_effort" in sent, false);
  assert.deepEqual(sent.response_format, { type: "json_object" });
  assert.ok(Array.isArray(sent.tools));
});
