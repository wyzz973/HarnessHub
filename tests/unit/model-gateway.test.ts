import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  startModelGateway,
  type ModelCallRecord,
  type ModelGatewayOptions,
} from "../../src/drivers/chat-completions/gateway.js";
import { decodeReasoning } from "../../src/drivers/chat-completions/reasoning.js";

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
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
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
function stream(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks)
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}
function delta(value: Body, finish: string | null = null): Body {
  return {
    id: "upstream",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  };
}
/** DeepSeek-shaped turn: reasoning, text, one fragmented tool call, then usage. */
const TOOL_TURN = [
  delta({ role: "assistant", content: null, reasoning_content: "" }),
  delta({ reasoning_content: "思考" }),
  delta({ reasoning_content: "过程" }),
  delta({ content: "我来读取" }),
  delta({
    tool_calls: [
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "" },
      },
    ],
  }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '"文档"}' } }] }),
  delta({}, "tool_calls"),
  {
    id: "upstream",
    choices: [],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  },
];
const SCHEMA = { type: "object", properties: { path: { type: "string" } } };

type Auth = "bearer" | "x-api-key" | "x-goog-api-key" | "query";
async function gateway(
  t: test.TestContext,
  baseUrl: string,
  options: Partial<ModelGatewayOptions> = {},
) {
  const calls: ModelCallRecord[] = [];
  const gw = await startModelGateway({
    upstream: {
      protocol: "openai-completions",
      baseUrl,
      apiKey: "sk-test-upstream-key",
    },
    model: "upstream-model",
    alias: "harnesshub-model",
    contextWindow: 131072,
    onCall: (call) => calls.push(call),
    ...options,
  });
  t.after(() => gw.close());
  gw.beginRun(new AbortController().signal);
  const send = (
    path: string,
    body: unknown,
    auth: Auth = "bearer",
    method = "POST",
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (auth === "bearer") headers.authorization = `Bearer ${gw.token}`;
    if (auth === "x-api-key") headers["x-api-key"] = gw.token;
    if (auth === "x-goog-api-key") headers["x-goog-api-key"] = gw.token;
    const separator = path.includes("?") ? "&" : "?";
    return fetch(
      gw.baseUrl +
        path +
        (auth === "query" ? `${separator}key=${gw.token}` : ""),
      {
        method,
        headers,
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      },
    );
  };
  return { gw, calls, send };
}
interface Event {
  event?: string;
  data: unknown;
}
function events(text: string): Event[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split("\n"))
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      const joined = data.join("\n");
      return {
        ...(event ? { event } : {}),
        data: joined === "[DONE]" ? joined : (JSON.parse(joined) as unknown),
      };
    });
}
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
function joined(values: unknown[]): string {
  return values.filter((value) => typeof value === "string").join("");
}

void test("Chat Completions streams reasoning, text, tool call deltas, finish and usage chunks", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send, calls } = await gateway(t, up.baseUrl);
  const response = await send("/v1/chat/completions", {
    model: "engine-model",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "读" }],
    tools: [
      { type: "function", function: { name: "read", parameters: SCHEMA } },
    ],
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  const list = events(await response.text());
  assert.equal(list.at(-1)?.data, "[DONE]");
  const chunks = list.slice(0, -1).map((event) => event.data);
  assert.ok(
    chunks.every(
      (chunk) =>
        at(chunk, "object") === "chat.completion.chunk" &&
        at(chunk, "model") === "engine-model",
    ),
  );
  const deltas = chunks.map((chunk) => at(chunk, "choices", 0, "delta"));
  assert.equal(at(deltas[0], "role"), "assistant");
  assert.equal(
    joined(deltas.map((d) => at(d, "reasoning_content"))),
    "思考过程",
  );
  assert.equal(joined(deltas.map((d) => at(d, "content"))), "我来读取");
  const tools = deltas.flatMap((d) => {
    const value = at(d, "tool_calls");
    return Array.isArray(value) ? value : [];
  });
  assert.deepEqual(tools[0], {
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "read", arguments: "" },
  });
  assert.equal(
    joined(tools.slice(1).map((call) => at(call, "function", "arguments"))),
    '{"path":"文档"}',
  );
  const finish = chunks.find(
    (chunk) => at(chunk, "choices", 0, "finish_reason") === "tool_calls",
  );
  assert.equal(at(finish, "usage", "total_tokens"), 30);
  const empty = (list: unknown[]) =>
    list.filter((chunk) => {
      const choices = at(chunk, "choices");
      return Array.isArray(choices) && choices.length === 0;
    });
  assert.equal(empty(chunks).length, 1);
  assert.equal(at(empty(chunks)[0], "usage", "total_tokens"), 30);
  const unrequested = events(
    await (
      await send("/v1/chat/completions", {
        model: "engine-model",
        stream: true,
        messages: [{ role: "user", content: "读" }],
      })
    ).text(),
  )
    .slice(0, -1)
    .map((event) => event.data);
  assert.deepEqual(empty(unrequested), []);
  assert.equal(at(unrequested.at(-1), "usage", "prompt_tokens"), 10);
  const sent = up.requests[0]!;
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.body.model, "upstream-model");
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.stream_options, undefined);
  assert.equal(sent.headers.authorization, "Bearer sk-test-upstream-key");
  assert.deepEqual(calls[0], {
    id: calls[0]!.id,
    inbound: "openai-completions",
    stream: true,
    requestedModel: "engine-model",
    upstreamModel: "upstream-model",
    status: 200,
    ok: true,
    durationMs: calls[0]!.durationMs,
    finishReason: "tool_calls",
    usage: { input: 10, output: 20, total: 30, reasoning: 5 },
    toolCalls: 1,
  });
  assert.doesNotMatch(JSON.stringify(calls), /读|sk-test|思考/);
});

void test("Chat Completions non-streaming requests stream upstream and return one completion", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send, calls } = await gateway(t, up.baseUrl);
  const response = await send("/v1/chat/completions", {
    model: "engine-model",
    messages: [{ role: "user", content: "读" }],
    tools: [
      { type: "function", function: { name: "read", parameters: SCHEMA } },
    ],
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as unknown;
  assert.equal(at(body, "object"), "chat.completion");
  assert.deepEqual(at(body, "choices", 0, "message"), {
    role: "assistant",
    content: "我来读取",
    reasoning_content: "思考过程",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: '{"path":"文档"}' },
      },
    ],
  });
  assert.equal(at(body, "choices", 0, "finish_reason"), "tool_calls");
  assert.equal(at(body, "usage", "total_tokens"), 30);
  assert.equal(up.requests[0]!.body.stream, true);
  assert.equal(calls[0]!.stream, false);
});

void test("Responses streams created, reasoning summary, text, function call arguments and completed usage", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send } = await gateway(t, up.baseUrl);
  const response = await send("/v1/responses", {
    model: "harnesshub-model",
    instructions: "sys",
    input: "读",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high", summary: "auto" },
    prompt_cache_key: "k",
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: [
      { type: "function", name: "read", strict: false, parameters: SCHEMA },
    ],
  });
  assert.equal(response.status, 200);
  const list = events(await response.text());
  assert.ok(list.every((event) => event.event === at(event.data, "type")));
  assert.deepEqual(
    list.map((event) => at(event.data, "sequence_number")),
    list.map((_, index) => index),
  );
  const types = list.map((event) => event.event);
  assert.equal(types[0], "response.created");
  assert.equal(types.at(-1), "response.completed");
  const of = (type: string) =>
    list.filter((event) => event.event === type).map((event) => event.data);
  assert.equal(
    joined(
      of("response.reasoning_summary_text.delta").map((e) => at(e, "delta")),
    ),
    "思考过程",
  );
  assert.equal(
    joined(of("response.output_text.delta").map((e) => at(e, "delta"))),
    "我来读取",
  );
  const added = of("response.output_item.added").map((e) => at(e, "item"));
  assert.deepEqual(
    added.map((item) => at(item, "type")),
    ["reasoning", "message", "function_call"],
  );
  assert.equal(at(added[2], "name"), "read");
  assert.equal(at(added[2], "call_id"), "call_1");
  assert.equal(
    joined(
      of("response.function_call_arguments.delta").map((e) => at(e, "delta")),
    ),
    '{"path":"文档"}',
  );
  const done = of("response.output_item.done").map((e) => at(e, "item"));
  const reasoning = done.find((item) => at(item, "type") === "reasoning");
  assert.equal(at(reasoning, "summary", 0, "text"), "思考过程");
  assert.equal(decodeReasoning(at(reasoning, "encrypted_content")), "思考过程");
  const completed = of("response.completed")[0];
  assert.deepEqual(
    (at(completed, "response", "output") as unknown[]).map((item) =>
      at(item, "type"),
    ),
    ["reasoning", "message", "function_call"],
  );
  assert.equal(
    at(completed, "response", "output", 2, "arguments"),
    '{"path":"文档"}',
  );
  assert.deepEqual(at(completed, "response", "usage"), {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 5 },
    total_tokens: 30,
  });
  const sent = up.requests[0]!.body;
  assert.deepEqual(sent.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "读" },
  ]);
  assert.equal(sent.tool_choice, "auto");
  assert.equal(sent.parallel_tool_calls, true);
  for (const key of ["include", "reasoning", "prompt_cache_key", "store"])
    assert.equal(key in sent, false, key);
});

void test("Responses non-streaming returns reasoning, message and function call items; length is incomplete", async (t) => {
  const up = await upstream(t, (body, response) =>
    stream(
      response,
      JSON.stringify(body).includes("truncate")
        ? [delta({ content: "partial" }, "length")]
        : TOOL_TURN,
    ),
  );
  const { send } = await gateway(t, up.baseUrl);
  const body = (await (
    await send("/v1/responses", {
      model: "harnesshub-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "读" }] }],
      tools: [{ type: "function", name: "read", parameters: SCHEMA }],
    })
  ).json()) as unknown;
  assert.equal(at(body, "status"), "completed");
  assert.deepEqual(
    (at(body, "output") as unknown[]).map((item) => at(item, "type")),
    ["reasoning", "message", "function_call"],
  );
  assert.equal(at(body, "output", 1, "content", 0, "text"), "我来读取");
  assert.equal(at(body, "output", 2, "arguments"), '{"path":"文档"}');
  const cut = (await (
    await send("/v1/responses", { model: "m", input: "truncate" })
  ).json()) as unknown;
  assert.equal(at(cut, "status"), "incomplete");
  assert.deepEqual(at(cut, "incomplete_details"), {
    reason: "max_output_tokens",
  });
  const streamed = await (
    await send("/v1/responses", { model: "m", input: "truncate", stream: true })
  ).text();
  assert.match(streamed, /event: response\.incomplete/);
});

void test("Anthropic Messages streams thinking, text and tool_use blocks with stop_reason and usage", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send, calls } = await gateway(t, up.baseUrl);
  const response = await send(
    "/v1/messages?beta=true",
    {
      model: "claude-sonnet",
      max_tokens: 1024,
      stream: true,
      system: [
        {
          type: "text",
          text: "你是助手",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "读" }] }],
      tools: [{ name: "read", description: "Read", input_schema: SCHEMA }],
      metadata: { user_id: "u" },
      thinking: { type: "enabled", budget_tokens: 1024 },
      context_management: { edits: [] },
    },
    "x-api-key",
  );
  assert.equal(response.status, 200);
  const list = events(await response.text());
  assert.ok(list.every((event) => event.event === at(event.data, "type")));
  assert.deepEqual(
    list.map((event) => event.event),
    [
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  const data = list.map((event) => event.data);
  assert.ok(Number(at(data[0], "message", "usage", "input_tokens")) > 0);
  assert.equal(at(data[0], "message", "model"), "claude-sonnet");
  assert.deepEqual(at(data[2], "content_block"), {
    type: "thinking",
    thinking: "",
    signature: "",
  });
  assert.equal(
    joined([
      at(data[3], "delta", "thinking"),
      at(data[4], "delta", "thinking"),
    ]),
    "思考过程",
  );
  assert.equal(at(data[5], "delta", "type"), "signature_delta");
  assert.equal(at(data[8], "delta", "text"), "我来读取");
  assert.deepEqual(at(data[10], "content_block"), {
    type: "tool_use",
    id: "call_1",
    name: "read",
    input: {},
  });
  assert.equal(
    joined([
      at(data[11], "delta", "partial_json"),
      at(data[12], "delta", "partial_json"),
    ]),
    '{"path":"文档"}',
  );
  assert.equal(at(data[14], "delta", "stop_reason"), "tool_use");
  assert.equal(at(data[14], "usage", "output_tokens"), 20);
  assert.equal(at(data[14], "usage", "input_tokens"), 10);
  const sent = up.requests[0]!.body;
  assert.deepEqual(sent.messages, [
    { role: "system", content: "你是助手" },
    { role: "user", content: "读" },
  ]);
  assert.equal(sent.max_tokens, 1024);
  assert.deepEqual(at(sent, "tools", 0, "function"), {
    name: "read",
    description: "Read",
    parameters: SCHEMA,
  });
  for (const key of ["metadata", "thinking", "context_management", "system"])
    assert.equal(key in sent, false, key);
  assert.equal(calls[0]!.inbound, "anthropic");
});

void test("Anthropic non-streaming returns thinking, text and tool_use content; count_tokens needs no Run", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send } = await gateway(t, up.baseUrl);
  const body = (await (
    await send("/v1/messages", {
      model: "claude-haiku",
      max_tokens: 64,
      messages: [{ role: "user", content: "读" }],
      tools: [{ name: "read", input_schema: SCHEMA }],
    })
  ).json()) as unknown;
  assert.equal(at(body, "type"), "message");
  assert.deepEqual(
    (at(body, "content") as unknown[]).map((block) => at(block, "type")),
    ["thinking", "text", "tool_use"],
  );
  assert.equal(at(body, "content", 0, "thinking"), "思考过程");
  assert.match(String(at(body, "content", 0, "signature")), /^hh-sig\./);
  assert.deepEqual(at(body, "content", 2, "input"), { path: "文档" });
  assert.equal(at(body, "stop_reason"), "tool_use");
  assert.equal(at(body, "usage", "input_tokens"), 10);
  const idle = await startModelGateway({
    upstream: { protocol: "openai-completions", baseUrl: up.baseUrl },
    model: "upstream-model",
    alias: "harnesshub-model",
  });
  t.after(() => idle.close());
  const counted = await fetch(`${idle.baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "x-api-key": idle.token, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude",
      system: "sys",
      messages: [{ role: "user", content: "hello world, 你好世界" }],
    }),
  });
  assert.equal(counted.status, 200);
  const tokens = at(await counted.json(), "input_tokens");
  assert.ok(typeof tokens === "number" && tokens > 5, String(tokens));
  assert.equal(up.requests.length, 1);
});

void test("Google streamGenerateContent (SSE and JSON array) sends thought parts and signed function calls", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send, calls } = await gateway(t, up.baseUrl);
  const request = {
    contents: [{ role: "user", parts: [{ text: "读" }] }],
    systemInstruction: { parts: [{ text: "sys" }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: "read",
            parameters: {
              type: "OBJECT",
              properties: { path: { type: "STRING" } },
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
      topK: 40,
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
    },
  };
  const response = await send(
    "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    request,
    "x-goog-api-key",
  );
  assert.equal(response.status, 200);
  const chunks = events(await response.text()).map((event) => event.data);
  const parts = chunks.flatMap(
    (chunk) => at(chunk, "candidates", 0, "content", "parts") as unknown[],
  );
  assert.equal(
    joined(
      parts
        .filter((part) => at(part, "thought") === true)
        .map((part) => at(part, "text")),
    ),
    "思考过程",
  );
  assert.equal(
    joined(
      parts
        .filter((part) => at(part, "thought") !== true)
        .map((part) => at(part, "text")),
    ),
    "我来读取",
  );
  const final = chunks.at(-1);
  assert.equal(at(final, "candidates", 0, "finishReason"), "STOP");
  const call = at(final, "candidates", 0, "content", "parts", 0);
  assert.deepEqual(at(call, "functionCall"), {
    id: "call_1",
    name: "read",
    args: { path: "文档" },
  });
  assert.equal(decodeReasoning(at(call, "thoughtSignature")), "思考过程");
  assert.deepEqual(at(final, "usageMetadata"), {
    promptTokenCount: 10,
    candidatesTokenCount: 15,
    totalTokenCount: 30,
    thoughtsTokenCount: 5,
  });
  const sent = up.requests[0]!.body;
  assert.deepEqual(at(sent, "tools", 0, "function", "parameters"), SCHEMA);
  assert.equal(sent.temperature, 0.2);
  assert.equal(sent.max_tokens, 512);
  assert.equal("topK" in sent || "top_k" in sent, false);
  assert.deepEqual(at(sent, "messages", 0), { role: "system", content: "sys" });
  assert.equal(calls[0]!.requestedModel, "gemini-2.5-pro");
  assert.equal(calls[0]!.inbound, "google");
  assert.equal(calls[0]!.stream, true);
  const array = await send(
    "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
    {
      ...request,
      generationConfig: { thinkingConfig: { includeThoughts: false } },
    },
    "query",
  );
  assert.match(array.headers.get("content-type") ?? "", /application\/json/);
  const list = JSON.parse(await array.text()) as unknown[];
  assert.ok(Array.isArray(list));
  assert.equal(
    list.some((chunk) =>
      (at(chunk, "candidates", 0, "content", "parts") as unknown[]).some(
        (part) => at(part, "thought") === true,
      ),
    ),
    false,
  );
  assert.equal(at(list.at(-1), "candidates", 0, "finishReason"), "STOP");
});

void test("Google generateContent returns one response with thought, text and function call parts", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { send } = await gateway(t, up.baseUrl);
  const body = (await (
    await send("/v1beta/models/gemini-x:generateContent", {
      contents: [{ role: "user", parts: [{ text: "读" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "read", parametersJsonSchema: SCHEMA },
          ],
        },
      ],
    })
  ).json()) as unknown;
  const parts = at(body, "candidates", 0, "content", "parts") as unknown[];
  assert.deepEqual(parts.slice(0, 2), [
    { text: "思考过程", thought: true },
    { text: "我来读取" },
  ]);
  assert.deepEqual(at(parts[2], "functionCall", "args"), { path: "文档" });
  assert.equal(at(body, "candidates", 0, "finishReason"), "STOP");
  assert.equal(at(body, "usageMetadata", "promptTokenCount"), 10);
});

void test("models endpoints expose the alias and limits; authentication accepts every documented form", async (t) => {
  const up = await upstream(t, (_, response) => stream(response, TOOL_TURN));
  const { gw, send } = await gateway(t, up.baseUrl, { maxOutputTokens: 8192 });
  for (const auth of [
    "bearer",
    "x-api-key",
    "x-goog-api-key",
    "query",
  ] as const) {
    const listed = await send("/v1/models", undefined, auth, "GET");
    assert.equal(listed.status, 200, auth);
    const body = (await listed.json()) as unknown;
    assert.equal(at(body, "data", 0, "id"), "harnesshub-model");
    assert.equal(at(body, "data", 0, "context_window"), 131072);
    assert.equal(at(body, "data", 0, "max_output_tokens"), 8192);
  }
  const one = (await (
    await send("/v1/models/harnesshub-model", undefined, "bearer", "GET")
  ).json()) as unknown;
  assert.equal(at(one, "id"), "harnesshub-model");
  assert.equal(
    (await send("/v1/models/other", undefined, "bearer", "GET")).status,
    404,
  );
  assert.equal((await send("/v1/unknown", {}, "bearer")).status, 404);
  const denied = await fetch(`${gw.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "wrong", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(
    at(await denied.json(), "error", "type"),
    "authentication_error",
  );
  const browser = await fetch(`${gw.baseUrl}/v1/models`, {
    headers: {
      authorization: `Bearer ${gw.token}`,
      origin: "http://evil.test",
    },
  });
  assert.equal(browser.status, 403);
  const google = await fetch(
    `${gw.baseUrl}/v1beta/models/x:generateContent?key=wrong`,
    { method: "POST", body: "{}" },
  );
  assert.equal(google.status, 401);
  assert.equal(at(await google.json(), "error", "status"), "UNAUTHENTICATED");
  assert.equal(up.requests.length, 0);
});
