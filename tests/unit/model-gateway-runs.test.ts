import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  DEFAULT_GATEWAY_LIMITS,
  createModelGateway,
  startModelGateway,
  type GatewayLimits,
  type ModelCallRecord,
  type ModelGateway,
  type ModelGatewayOptions,
} from "../../src/drivers/chat-completions/gateway.js";
import {
  ReasoningCache,
  callKeys,
  encodeReasoning,
  restoreReasoning,
} from "../../src/drivers/chat-completions/reasoning.js";

type Body = Record<string, unknown>;
interface Upstream {
  baseUrl: string;
  requests: { headers: IncomingHttpHeaders; body: Body }[];
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
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
      state.requests.push({ headers: request.headers, body });
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
function stream(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks)
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}
function delta(value: Body, finish: string | null = null): Body {
  return { choices: [{ index: 0, delta: value, finish_reason: finish }] };
}
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
async function gateway(
  t: test.TestContext,
  baseUrl: string,
  options: Partial<ModelGatewayOptions> = {},
  limits: Partial<GatewayLimits> = {},
  run = true,
) {
  const calls: ModelCallRecord[] = [];
  const gw = await createModelGateway(
    {
      upstream: {
        protocol: "openai-completions",
        baseUrl,
        apiKey: "sk-test-upstream-key",
      },
      model: "upstream-model",
      alias: "harnesshub-model",
      onCall: (call) => calls.push(call),
      ...options,
    },
    { ...DEFAULT_GATEWAY_LIMITS, ...limits },
  );
  t.after(() => gw.close());
  if (run) gw.beginRun(new AbortController().signal);
  return { gw, calls, send: sender(gw) };
}
function sender(gw: ModelGateway) {
  return (path: string, body: unknown, signal?: AbortSignal) =>
    fetch(gw.baseUrl + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gw.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
}

const MISSING =
  "The reasoning_content in the thinking mode must be passed back to the API.";
/**
 * DeepSeek thinking-mode behavior measured on 2026-09-19: an assistant tool
 * call message without `reasoning_content` in a follow-up request is a 400.
 */
function deepseek(body: Body, response: ServerResponse): void {
  const messages = body.messages as Body[];
  if (
    messages.some(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.tool_calls) &&
        typeof message.reasoning_content !== "string",
    )
  ) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: MISSING, type: "invalid_request_error" },
      }),
    );
    return;
  }
  if (messages.some((message) => message.role === "tool"))
    return stream(response, [
      delta({ reasoning_content: "总结" }),
      delta({ content: "完成" }, "stop"),
    ]);
  stream(response, [
    delta({ reasoning_content: "先读文件" }),
    delta({
      tool_calls: [
        {
          index: 0,
          id: "call_ds",
          type: "function",
          function: { name: "read", arguments: '{"path":"a"}' },
        },
      ],
    }),
    delta({}, "tool_calls"),
  ]);
}
const SCHEMA = { type: "object", properties: { path: { type: "string" } } };
function assistantReasoning(up: Upstream, index: number): unknown {
  const messages = up.requests[index]!.body.messages as Body[];
  return messages.find((message) => message.role === "assistant")
    ?.reasoning_content;
}

void test("Chat history without reasoning_content is backfilled by tool call id and by assistant text", async (t) => {
  const up = await upstream(t, (body, response) => {
    const text = JSON.stringify(body.messages);
    if (text.includes("question")) {
      if (text.includes("answer") && !text.includes("答案的理由"))
        return stream(response, [delta({ content: "missing" }, "stop")]);
      return stream(response, [
        delta({ reasoning_content: "答案的理由" }),
        delta({ content: "answer" }, "stop"),
      ]);
    }
    deepseek(body, response);
  });
  const { send } = await gateway(t, up.baseUrl);
  const user = { role: "user", content: "读 a" };
  const first = (await (
    await send("/v1/chat/completions", {
      model: "m",
      messages: [user],
      tools: [
        { type: "function", function: { name: "read", parameters: SCHEMA } },
      ],
    })
  ).json()) as unknown;
  const call = at(first, "choices", 0, "message", "tool_calls", 0);
  assert.equal(at(call, "id"), "call_ds");
  const second = await send("/v1/chat/completions", {
    model: "m",
    messages: [
      user,
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: "call_ds", content: "内容" },
    ],
    tools: [
      { type: "function", function: { name: "read", parameters: SCHEMA } },
    ],
  });
  assert.equal(second.status, 200);
  assert.equal(
    at(await second.json(), "choices", 0, "message", "content"),
    "完成",
  );
  assert.equal(assistantReasoning(up, 1), "先读文件");
  await send("/v1/chat/completions", {
    model: "m",
    messages: [{ role: "user", content: "question" }],
  });
  const text = await send("/v1/chat/completions", {
    model: "m",
    messages: [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "next" },
    ],
  });
  assert.equal(
    at(await text.json(), "choices", 0, "message", "content"),
    "answer",
  );
  assert.equal(assistantReasoning(up, 3), "答案的理由");
});

void test("Responses reasoning items carry reasoning back; missing items are backfilled by call id", async (t) => {
  const up = await upstream(t, deepseek);
  const { send } = await gateway(t, up.baseUrl);
  const tools = [{ type: "function", name: "read", parameters: SCHEMA }];
  const first = (await (
    await send("/v1/responses", { model: "m", input: "读 a", tools })
  ).json()) as unknown;
  const output = at(first, "output") as Body[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "function_call"],
  );
  const history = (items: Body[]) => [
    { role: "user", content: [{ type: "input_text", text: "读 a" }] },
    ...items,
    { type: "function_call_output", call_id: "call_ds", output: "内容" },
  ];
  const withoutReasoning = await send("/v1/responses", {
    model: "m",
    input: history([output[1]!]),
    tools,
  });
  assert.equal(withoutReasoning.status, 200);
  assert.equal(assistantReasoning(up, 1), "先读文件");
  // A new Session has an empty cache: the replayed reasoning item alone suffices.
  const fresh = await gateway(t, up.baseUrl);
  const replayed = await fresh.send("/v1/responses", {
    model: "m",
    input: history(output),
    tools,
  });
  assert.equal(replayed.status, 200);
  assert.equal(assistantReasoning(up, 2), "先读文件");
});

void test("Anthropic thinking blocks carry reasoning back; missing blocks are backfilled by tool_use id", async (t) => {
  const up = await upstream(t, deepseek);
  const { send } = await gateway(t, up.baseUrl);
  const tools = [{ name: "read", input_schema: SCHEMA }];
  const first = (await (
    await send("/v1/messages", {
      model: "m",
      max_tokens: 100,
      messages: [{ role: "user", content: "读 a" }],
      tools,
    })
  ).json()) as unknown;
  const content = at(first, "content") as Body[];
  assert.deepEqual(
    content.map((block) => block.type),
    ["thinking", "tool_use"],
  );
  const history = (blocks: Body[]) => [
    { role: "user", content: "读 a" },
    { role: "assistant", content: blocks },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_ds", content: "内容" },
      ],
    },
  ];
  const withoutThinking = await send("/v1/messages", {
    model: "m",
    max_tokens: 100,
    messages: history([content[1]!]),
    tools,
  });
  assert.equal(withoutThinking.status, 200);
  assert.equal(assistantReasoning(up, 1), "先读文件");
  const fresh = await gateway(t, up.baseUrl);
  const replayed = await fresh.send("/v1/messages", {
    model: "m",
    max_tokens: 100,
    messages: history(content),
    tools,
  });
  assert.equal(replayed.status, 200);
  assert.equal(assistantReasoning(up, 2), "先读文件");
});

void test("Google history with Gemini-prefixed call ids is backfilled; our thought signature carries reasoning back", async (t) => {
  const up = await upstream(t, deepseek);
  const { send } = await gateway(t, up.baseUrl);
  const tools = [
    { functionDeclarations: [{ name: "read", parametersJsonSchema: SCHEMA }] },
  ];
  const first = (await (
    await send("/v1beta/models/g:generateContent", {
      contents: [{ role: "user", parts: [{ text: "读 a" }] }],
      tools,
    })
  ).json()) as unknown;
  const call = at(first, "candidates", 0, "content", "parts", 1) as Body;
  assert.equal(at(call, "functionCall", "id"), "call_ds");
  const history = (part: Body) => [
    { role: "user", parts: [{ text: "读 a" }] },
    { role: "model", parts: [part] },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "read__call_ds",
            name: "read",
            response: { output: "内容" },
          },
        },
      ],
    },
  ];
  const unsigned = await send("/v1beta/models/g:generateContent", {
    contents: history({
      functionCall: { id: "read__call_ds", name: "read", args: { path: "a" } },
      thoughtSignature: "skip_thought_signature_validator",
    }),
    tools,
  });
  assert.equal(unsigned.status, 200);
  const messages = up.requests[1]!.body.messages as Body[];
  assert.equal(at(messages[1], "tool_calls", 0, "id"), "call_ds");
  assert.equal(at(messages[2], "tool_call_id"), "call_ds");
  assert.equal(at(messages[2], "content"), "内容");
  assert.equal(assistantReasoning(up, 1), "先读文件");
  const fresh = await gateway(t, up.baseUrl);
  const signed = await fresh.send("/v1beta/models/g:generateContent", {
    contents: history({
      functionCall: { id: "read__call_ds", name: "read", args: { path: "a" } },
      thoughtSignature: call.thoughtSignature,
    }),
    tools,
  });
  assert.equal(signed.status, 200);
  assert.equal(assistantReasoning(up, 2), "先读文件");
});

void test("strip mode neither forwards nor backfills reasoning, so a DeepSeek-style upstream rejects the follow-up", async (t) => {
  const up = await upstream(t, deepseek);
  const { send, gw } = await gateway(t, up.baseUrl, {
    compatibility: { reasoning: "strip" },
  });
  const tools = [
    { type: "function", function: { name: "read", parameters: SCHEMA } },
  ];
  const streamed = await (
    await send("/v1/chat/completions", {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "读 a" }],
      tools,
    })
  ).text();
  assert.doesNotMatch(streamed, /reasoning/);
  assert.match(streamed, /call_ds/);
  const responses = (await (
    await send("/v1/responses", {
      model: "m",
      input: "读 a",
      tools: [{ type: "function", name: "read", parameters: SCHEMA }],
    })
  ).json()) as unknown;
  assert.deepEqual(
    (at(responses, "output") as Body[]).map((item) => item.type),
    ["function_call"],
  );
  const rejected = await send("/v1/chat/completions", {
    model: "m",
    messages: [
      { role: "user", content: "读 a" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "engine kept this",
        tool_calls: [
          {
            id: "call_ds",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_ds", content: "内容" },
    ],
    tools,
  });
  assert.equal(rejected.status, 400);
  assert.equal(at(await rejected.json(), "error", "message"), MISSING);
  assert.equal(assistantReasoning(up, 2), undefined);
  assert.deepEqual(
    gw.runErrors().map((call) => [call.status, call.error?.message]),
    [[400, MISSING]],
  );
});

void test("the reasoning cache is an LRU bounded by entries and bytes, and restoration keeps engine reasoning", () => {
  const cache = new ReasoningCache(2, 64);
  cache.remember("a", ["id:a"]);
  cache.remember("b", ["id:b"]);
  assert.equal(cache.lookup(["id:a"]), "a");
  cache.remember("c", ["id:c"]);
  assert.equal(cache.lookup(["id:b"]), undefined);
  assert.deepEqual(
    [cache.lookup(["id:a"]), cache.lookup(["id:c"])],
    ["a", "c"],
  );
  cache.remember("x".repeat(40), ["id:x"]);
  cache.remember("y".repeat(40), ["id:y"]);
  assert.equal(cache.size, 1);
  assert.ok(cache.bytes <= 64);
  cache.remember("z".repeat(65), ["id:z"]);
  assert.equal(cache.lookup(["id:z"]), undefined);
  const call = { id: "k1", name: "read", arguments: '{"b":1,"a":2}' };
  cache.remember("sig", callKeys(call));
  assert.equal(
    cache.lookup(callKeys({ name: "read", arguments: '{ "a": 2, "b": 1 }' })),
    "sig",
  );
  const messages: Body[] = [
    { role: "assistant", content: "x", reasoning: "own" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "k1", function: { name: "read", arguments: "{}" } }],
    },
  ];
  assert.equal(restoreReasoning(messages, cache, "reasoning_content"), 1);
  assert.deepEqual(messages[0], {
    role: "assistant",
    content: "x",
    reasoning_content: "own",
  });
  assert.equal(messages[1]!.reasoning_content, "sig");
  assert.match(encodeReasoning("推理"), /^hh-r1\./);
});

void test("calls outside a Run get 409 without upstream traffic; beginRun is exclusive and close is final", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const { gw, calls, send } = await gateway(t, up.baseUrl, {}, {}, false);
  const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const idle = await send("/v1/chat/completions", chat);
  assert.equal(idle.status, 409);
  assert.equal(at(await idle.json(), "error", "code"), "no_active_run");
  const anthropic = await send("/v1/messages", { ...chat, max_tokens: 5 });
  assert.equal(anthropic.status, 409);
  assert.equal(at(await anthropic.json(), "type"), "error");
  assert.equal(up.requests.length, 0);
  assert.equal(calls.length, 0);
  gw.beginRun(new AbortController().signal);
  assert.throws(() => gw.beginRun(new AbortController().signal));
  assert.equal((await send("/v1/chat/completions", chat)).status, 200);
  await gw.endRun();
  await gw.endRun();
  assert.equal((await send("/v1/chat/completions", chat)).status, 409);
  const aborted = new AbortController();
  aborted.abort();
  gw.beginRun(aborted.signal);
  assert.equal((await send("/v1/chat/completions", chat)).status, 409);
  await gw.endRun();
  await gw.close();
  await gw.close();
  assert.throws(() => gw.beginRun(new AbortController().signal));
  await assert.rejects(send("/v1/chat/completions", chat));
  assert.equal(up.requests.length, 1);
});

void test(
  "Run cancellation and engine disconnects abort upstream requests; endRun waits and cancellations are not run errors",
  { timeout: 10000 },
  async (t) => {
    const started: (() => void)[] = [];
    const closed: Promise<void>[] = [];
    const up = await upstream(t, (_, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify(delta({ content: "wait" }))}\n\n`);
      closed.push(once(response, "close").then(() => undefined));
      started.shift()?.();
    });
    const { gw, calls, send } = await gateway(t, up.baseUrl, {}, {}, false);
    const chat = {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const waitStart = () =>
      new Promise<void>((resolve) => started.push(resolve));
    const run = new AbortController();
    gw.beginRun(run.signal);
    let arrived = waitStart();
    const first = await send("/v1/chat/completions", chat);
    const reading = first.text().catch(() => "reset");
    await arrived;
    run.abort();
    await closed[0];
    await reading;
    await gw.endRun();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      [calls[0]!.status, calls[0]!.error?.code],
      [499, "cancelled"],
    );
    assert.deepEqual(gw.runErrors(), []);
    gw.beginRun(new AbortController().signal);
    const engine = new AbortController();
    arrived = waitStart();
    const second = await send("/v1/chat/completions", chat, engine.signal);
    await arrived;
    engine.abort();
    await second.text().catch(() => "aborted");
    await closed[1];
    arrived = waitStart();
    const third = await send("/v1/chat/completions", chat);
    const thirdText = third.text().catch(() => "reset");
    await arrived;
    await gw.endRun();
    await closed[2];
    await thirdText;
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.error?.code === "cancelled"));
    assert.deepEqual(gw.runErrors(), []);
  },
);

void test(
  "at most four upstream requests run per Session; later calls wait in order and a full queue gets 429",
  { timeout: 10000 },
  async (t) => {
    let active = 0,
      peak = 0;
    const held: ServerResponse[] = [];
    const four = Promise.withResolvers<void>();
    const up = await upstream(t, (_, response) => {
      active++;
      peak = Math.max(peak, active);
      response.once("close", () => active--);
      held.push(response);
      if (held.length === 4) four.resolve();
    });
    const release = () => {
      const response = held.shift();
      if (response) stream(response, [delta({ content: "ok" }, "stop")]);
    };
    const { send, calls } = await gateway(t, up.baseUrl);
    const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const pending = Array.from({ length: 6 }, () =>
      send("/v1/chat/completions", chat).then((response) => response.status),
    );
    await four.promise;
    assert.equal(up.requests.length, 4);
    while (calls.length < 6) {
      release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(
      await Promise.all(pending),
      [200, 200, 200, 200, 200, 200],
    );
    assert.equal(peak, 4);
    const narrow = await gateway(
      t,
      up.baseUrl,
      {},
      { maxConcurrent: 1, maxQueued: 0 },
    );
    const admitted = narrow.send("/v1/chat/completions", chat);
    while (held.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    const busy = await narrow.send("/v1/chat/completions", chat);
    assert.equal(busy.status, 429);
    assert.equal(at(await busy.json(), "error", "code"), "busy");
    release();
    assert.equal((await admitted).status, 200);
    assert.equal(up.requests.length, 7);
  },
);

void test("onCall observers are isolated and runErrors keeps the current Run's failures in order until the next beginRun", async (t) => {
  const up = await upstream(t, (body, response) => {
    const text = String(at(body, "messages", 0, "content"));
    if (text.startsWith("fail")) {
      response.writeHead(text === "fail-1" ? 500 : 429, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: { message: text } }));
    } else stream(response, [delta({ content: "ok" }, "stop")]);
  });
  const records: ModelCallRecord[] = [];
  const gw = await startModelGateway({
    upstream: { protocol: "openai-completions", baseUrl: up.baseUrl },
    model: "upstream-model",
    alias: "harnesshub-model",
    onCall: (call) => {
      records.push(call);
      throw new Error("observer failure");
    },
  });
  t.after(() => gw.close());
  const send = sender(gw);
  const chat = (content: string) =>
    send("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content }],
    });
  gw.beginRun(new AbortController().signal);
  assert.equal((await chat("fail-1")).status, 500);
  assert.equal((await chat("ok")).status, 200);
  assert.equal((await chat("fail-2")).status, 429);
  await gw.endRun();
  assert.deepEqual(
    gw.runErrors().map((call) => [call.status, call.error?.message]),
    [
      [500, "fail-1"],
      [429, "fail-2"],
    ],
  );
  assert.equal(records.length, 3);
  assert.ok(
    records.every(
      (record) =>
        record.durationMs >= 0 && record.upstreamModel === "upstream-model",
    ),
  );
  gw.beginRun(new AbortController().signal);
  assert.deepEqual(gw.runErrors(), []);
  await gw.endRun();
});

void test("an engine resetting its connection during the request upload is a cancellation, not a Run error", async (t) => {
  const up = await upstream(t, (_, response) =>
    stream(response, [delta({ content: "ok" }, "stop")]),
  );
  const recorded = Promise.withResolvers<ModelCallRecord>();
  const gw = await startModelGateway({
    upstream: { protocol: "openai-completions", baseUrl: up.baseUrl },
    model: "upstream-model",
    alias: "harnesshub-model",
    onCall: (call) => recorded.resolve(call),
  });
  t.after(() => gw.close());
  gw.beginRun(new AbortController().signal);
  const client = httpRequest(`${gw.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${gw.token}`,
      "content-type": "application/json",
      "content-length": "100000",
    },
  });
  client.on("error", () => undefined);
  client.write('{"model":"m","messages":[', () => client.destroy());
  const record = await recorded.promise;
  assert.deepEqual([record.status, record.error?.code], [499, "cancelled"]);
  await gw.endRun();
  assert.deepEqual(gw.runErrors(), []);
  assert.equal(up.requests.length, 0);
});
