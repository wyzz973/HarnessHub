// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { ProviderConfig } from "@harnesshub/core/model-plane";
import {
  addKey,
  at,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Reply,
} from "./shared-support.js";

const PNG = "iVBORw0KGgo=";
const FAST = { perCandidate: 1, baseBackoffMs: 1, maxBackoffMs: 2 };
const TOOLS = [
  {
    name: "read",
    description: "Read a file",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function stream(events: Record<string, unknown>[], named = true): Reply {
  return (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events
        .map(
          (event) =>
            `${named ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  };
}
function claude(stop = "tool_use", text = "Hi"): Record<string, unknown>[] {
  return [
    {
      type: "message_start",
      message: {
        model: "claude-served",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 5,
          output_tokens: 1,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hmm" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "SIG-1" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 1 },
    ...(stop === "tool_use"
      ? [
          {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "tu_1",
              name: "read",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '{"path":' },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '"a.txt"}' },
          },
          { type: "content_block_stop", index: 2 },
        ]
      : []),
    {
      type: "message_delta",
      delta: { stop_reason: stop },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ];
}
const RESPONSES_TOOL_TURN = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { model: "gpt-served" },
  },
  {
    type: "response.reasoning_summary_text.delta",
    sequence_number: 1,
    delta: "think",
  },
  { type: "response.output_text.delta", sequence_number: 2, delta: "Reading" },
  {
    type: "response.output_item.added",
    sequence_number: 3,
    output_index: 2,
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_r1",
      name: "read",
      arguments: "",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 4,
    output_index: 2,
    item_id: "fc_1",
    delta: '{"path":"b"}',
  },
  {
    type: "response.completed",
    sequence_number: 5,
    response: {
      status: "completed",
      model: "gpt-served",
      usage: {
        input_tokens: 50,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 9,
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  },
];
const GEMINI_TOOL_TURN = {
  modelVersion: "gemini-served",
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { text: "ponder", thought: true },
          { text: "Calling" },
          {
            functionCall: { name: "read", args: { path: "c" } },
            thoughtSignature: "GSIG",
          },
        ],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 12,
    cachedContentTokenCount: 4,
    candidatesTokenCount: 3,
    thoughtsTokenCount: 2,
  },
};

async function setup(
  t: test.TestContext,
  providers: ((base: string) => ProviderConfig)[],
  replies: Reply[],
  limits: Record<string, number> = {},
) {
  const up = await upstream(t, ...replies);
  const store = new MemoryStore();
  for (const make of providers) await store.putProvider(make(up.base));
  const allow = [...store.providers.keys()].map((id) => `${id}/*`);
  const key = await addKey(store, [...allow, "group/g"]);
  const gw = await mount(t, store, limits);
  return { up, store, gw, key };
}
const anthropicOnly = (base: string) =>
  provider(
    "claude",
    { anthropic: base },
    { auth: { apiKeyHeader: "x-api-key" } },
  );
const responsesOnly = (base: string) =>
  provider(
    "oai",
    { responses: `${base}/v1` },
    {
      models: {
        source: "manual",
        list: [{ id: "model-a", inputModalities: ["text", "image"] }],
        expose: "all",
      },
    },
  );
const geminiOnly = (base: string) =>
  provider(
    "gem",
    { gemini: base },
    { auth: { apiKeyHeader: "x-goog-api-key" } },
  );

void test("Chat on an Anthropic-only provider: system, tools, thinking, usage and same-provider signature replay", async (t) => {
  const { up, store, gw, key } = await setup(
    t,
    [anthropicOnly],
    [stream(claude())],
  );
  const first = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "claude/model-a",
      stream: true,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "read a" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", parameters: TOOLS[0]!.input_schema },
        },
      ],
    },
  });
  assert.equal(first.status, 200);
  const seen = up.seen[0]!;
  assert.equal(seen.url, "/v1/messages");
  assert.equal(seen.headers["x-api-key"], "sk-upstream-a-0001");
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.headers.authorization, undefined);
  const body = seen.json();
  assert.equal(body.model, "model-a");
  assert.equal(body.system, "Be brief.");
  assert.equal(body.max_tokens, 8192, "from the model's maxOutputTokens");
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 8191 });
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "read a" }] },
  ]);
  assert.equal(at(body, "tools", 0, "name"), "read");
  assert.match(first.text, /"reasoning_content":"hmm"/);
  assert.match(first.text, /"content":"Hi"/);
  assert.match(first.text, /"name":"read"/);
  assert.match(first.text, /"finish_reason":"tool_calls"/);
  assert.match(first.text, /data: \[DONE\]\n\n$/);
  assert.doesNotMatch(
    first.text,
    /SIG-1/,
    "signatures never reach another protocol's client",
  );
  const entry = store.entries[0]!;
  assert.equal(entry.mode, "translated");
  assert.equal(entry.upstreamProtocol, "anthropic");
  assert.equal(entry.servedModel, "claude-served");
  assert.equal(entry.finishReason, "tool_calls");
  assert.deepEqual(entry.usage, {
    input: 10,
    cacheRead: 30,
    cacheWrite: 5,
    output: 20,
    reasoning: 0,
    source: "reported",
  });
  assert.deepEqual(entry.patches, ["max_tokens:model"]);
  assert.equal(entry.cost, null, "the model has no cache-write price");

  // The client sends the turn back (reasoning text included, as DeepSeek-style clients do).
  const call = at(
    JSON.parse(
      first.text
        .split("\n\n")
        .find((line) => line.includes('"tool_calls"'))!
        .slice(6),
    ),
    "choices",
    0,
    "delta",
    "tool_calls",
    0,
  ) as Record<string, unknown>;
  await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "claude/model-a",
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "read a" },
        {
          role: "assistant",
          content: "Hi",
          reasoning_content: "hmm",
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: "read", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: call.id, content: "file a" },
      ],
    },
  });
  const replay = up.seen[1]!.json();
  assert.deepEqual(at(replay, "messages", 1, "content", 0), {
    type: "thinking",
    thinking: "hmm",
    signature: "SIG-1",
  });
  assert.deepEqual(at(replay, "messages", 2, "content", 0), {
    type: "tool_result",
    tool_use_id: call.id,
    content: "file a",
  });
  assert.ok(replay.thinking, "thinking stays on with signed history");
  assert.deepEqual(store.entries[1]!.unmapped, []);
});

void test("Claude Code on a Responses-only provider: images, reasoning both ways, tool use and cached usage", async (t) => {
  const { up, store, gw, key } = await setup(
    t,
    [responsesOnly],
    [stream(RESPONSES_TOOL_TURN)],
  );
  const answer = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: {
      model: "oai/model-a",
      max_tokens: 1000,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 2000 },
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: PNG },
            },
            {
              type: "image",
              source: { type: "url", url: "https://example.test/b.png" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "earlier", signature: "x" },
            { type: "text", text: "Looking" },
          ],
        },
        { role: "user", content: "go on" },
      ],
    },
  });
  assert.equal(answer.status, 200);
  const body = up.seen[0]!.json();
  assert.equal(up.seen[0]!.url, "/v1/responses");
  assert.equal(up.seen[0]!.headers.authorization, "Bearer sk-upstream-a-0001");
  assert.equal(body.instructions, "You are Claude Code.");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 1000);
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(at(body, "input", 0, "content"), [
    { type: "input_text", text: "what is this" },
    { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    { type: "input_image", image_url: "https://example.test/b.png" },
  ]);
  assert.equal(at(body, "tools", 0, "strict"), false);
  assert.equal(at(body, "tools", 0, "type"), "function");
  assert.match(answer.text, /"type":"thinking_delta","thinking":"think"/);
  assert.match(answer.text, /"type":"text_delta","text":"Reading"/);
  assert.match(answer.text, /"type":"tool_use","id":"call_r1","name":"read"/);
  assert.match(answer.text, /"partial_json":"\{\\"path\\":\\"b\\"\}"/);
  assert.match(answer.text, /"stop_reason":"tool_use"/);
  assert.match(answer.text, /event: message_stop/);
  const entry = store.entries[0]!;
  assert.equal(entry.upstreamProtocol, "responses");
  assert.deepEqual(entry.usage, {
    input: 30,
    cacheRead: 20,
    cacheWrite: 0,
    output: 5,
    reasoning: 4,
    source: "reported",
  });
  assert.deepEqual(
    entry.unmapped,
    ["reasoning"],
    "the earlier thinking block cannot be replayed to another provider",
  );
});

void test("Claude Code on a Gemini-native provider: systemInstruction, restricted declarations, error results and thoughts", async (t) => {
  const { up, store, gw, key } = await setup(
    t,
    [geminiOnly],
    [stream([GEMINI_TOOL_TURN], false)],
  );
  const answer = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text },
    body: {
      model: "gem/model-a",
      max_tokens: 500,
      system: "Be terse.",
      tools: TOOLS,
      messages: [
        { role: "user", content: "read c" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t0", name: "read", input: { path: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t0",
              is_error: true,
              content: "no such file",
            },
          ],
        },
      ],
    },
  });
  assert.equal(answer.status, 200);
  assert.equal(
    up.seen[0]!.url,
    "/v1beta/models/model-a:streamGenerateContent?alt=sse",
  );
  assert.equal(up.seen[0]!.headers["x-goog-api-key"], "sk-upstream-a-0001");
  const body = up.seen[0]!.json();
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Be terse." }] });
  assert.deepEqual(at(body, "tools", 0, "functionDeclarations", 0), {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "OBJECT",
      properties: { path: { type: "STRING" } },
      required: ["path"],
    },
  });
  assert.deepEqual(at(body, "contents", 2), {
    role: "user",
    parts: [
      {
        functionResponse: { name: "read", response: { error: "no such file" } },
      },
    ],
  });
  assert.equal(at(body, "generationConfig", "maxOutputTokens"), 500);
  const message = answer.json();
  assert.deepEqual(
    (message.content as Record<string, unknown>[]).map((block) => block.type),
    ["thinking", "text", "tool_use"],
  );
  assert.deepEqual(at(message, "content", 2, "input"), { path: "c" });
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(at(message, "usage"), {
    input_tokens: 8,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
  });
  const entry = store.entries[0]!;
  assert.deepEqual(entry.unmapped, ["schema.additionalProperties"]);
  assert.deepEqual(entry.usage, {
    input: 8,
    cacheRead: 4,
    cacheWrite: 0,
    output: 3,
    reasoning: 2,
    source: "reported",
  });
});

void test("Codex on Claude: Responses history goes to Anthropic and max_tokens ends as response.incomplete", async (t) => {
  const { up, gw, key } = await setup(
    t,
    [anthropicOnly],
    [stream(claude("max_tokens", "partial"))],
  );
  const answer = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "claude/model-a",
      stream: true,
      instructions: "You are Codex.",
      reasoning: { effort: "medium" },
      max_output_tokens: 30_000,
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
          },
        },
      ],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "list files" }],
        },
        {
          type: "function_call",
          call_id: "c9",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
        { type: "function_call_output", call_id: "c9", output: "a.txt" },
      ],
    },
  });
  const body = up.seen[0]!.json();
  assert.equal(body.system, "You are Codex.");
  assert.equal(body.max_tokens, 8192, "clamped to the model's output limit");
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "list files" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "c9", name: "shell", input: { cmd: "ls" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c9", content: "a.txt" }],
    },
  ]);
  assert.equal(
    body.thinking,
    undefined,
    "the open tool turn has no signed thinking",
  );
  assert.match(answer.text, /event: response\.incomplete/);
  assert.match(answer.text, /"reason":"max_output_tokens"/);
  assert.match(answer.text, /"delta":"partial"/);
});

void test("Chat on a Responses-only provider keeps interleaved parallel tool arguments apart", async (t) => {
  const interleaved = [
    { type: "response.created", response: { model: "gpt-served" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fa",
        call_id: "call_a",
        name: "read",
        arguments: "",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fb",
        call_id: "call_b",
        name: "list",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fa",
      delta: '{"path":',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fb",
      delta: '{"dir":',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fa",
      delta: '"a"}',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fb",
      delta: '"/"}',
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    },
  ];
  const { gw, key } = await setup(t, [responsesOnly], [stream(interleaved)]);
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "oai/model-a",
      messages: [{ role: "user", content: "both" }],
    },
  });
  assert.deepEqual(at(answer.json(), "choices", 0, "message", "tool_calls"), [
    {
      id: "call_a",
      type: "function",
      function: { name: "read", arguments: '{"path":"a"}' },
    },
    {
      id: "call_b",
      type: "function",
      function: { name: "list", arguments: '{"dir":"/"}' },
    },
  ]);
  assert.equal(at(answer.json(), "choices", 0, "finish_reason"), "tool_calls");
});

void test("upstream errors of other protocols reach the client in its own format", async (t) => {
  const overflow = json(400, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 300000 tokens > 200000 maximum",
    },
  });
  const limited = json(
    429,
    {
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    },
    { "retry-after": "30" },
  );
  const failed = json(500, {
    error: { code: 500, message: "Internal error", status: "INTERNAL" },
  });
  const denied = json(401, {
    error: {
      code: 401,
      message: "API key not valid",
      status: "UNAUTHENTICATED",
    },
  });
  const { gw, key, store } = await setup(
    t,
    [anthropicOnly, geminiOnly],
    [overflow, overflow, limited, denied, failed],
  );
  const codex = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "claude/model-a", stream: true, input: "hi" },
  });
  assert.equal(
    codex.status,
    200,
    "Codex recognizes overflow only as a streamed response.failed",
  );
  assert.match(codex.text, /"code":"context_length_exceeded"/);
  const chat = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "claude/model-a",
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(chat.status, 400);
  assert.equal(at(chat.json(), "error", "code"), "context_length_exceeded");
  const gemini = await send(
    gw.port,
    `/v1beta/models/claude/model-a:generateContent?key=${key.text}`,
    {
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    },
  );
  assert.equal(gemini.status, 429);
  assert.equal(gemini.headers["retry-after"], "30");
  assert.equal(gemini.headers["x-hh-error-source"], "upstream");
  assert.equal(at(gemini.json(), "error", "status"), "RESOURCE_EXHAUSTED");
  assert.equal(at(gemini.json(), "error", "details", 0, "retryDelay"), "30s");
  const anthropic = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text },
    body: {
      model: "gem/model-a",
      max_tokens: 5,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(anthropic.status, 401);
  assert.deepEqual(anthropic.json(), {
    type: "error",
    error: { type: "authentication_error", message: "API key not valid" },
  });
  // The Gemini credential's auth breaker is open now; a new credential ref
  // closes it, and a 500 is retried before the client gets it as a Chat error.
  const gem = store.providers.get("gem")!;
  gem.credentials[0]!.ref = { kind: "env", value: "key-b" };
  const broken = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: { model: "gem/model-a", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(broken.status, 500);
  assert.deepEqual(at(broken.json(), "error"), {
    message: "Internal error",
    type: "server_error",
    param: null,
    code: "upstream_unavailable",
  });
  assert.deepEqual(
    store.entries.map((entry) => [
      entry.status,
      entry.errorClass,
      entry.attempts.length,
    ]),
    [
      [400, "context_length_exceeded", 1],
      [400, "context_length_exceeded", 1],
      [429, "rate_limited", 1],
      [401, "auth_failed", 1],
      [500, "upstream_unavailable", 3],
    ],
  );
});

void test("retry, failover, hold and breakers behave the same on translated routes", async (t) => {
  const busy = json(529, {
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  });
  const earlyError = stream([
    {
      type: "message_start",
      message: { model: "claude-served", usage: { input_tokens: 1 } },
    },
    {
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    },
  ]);
  const a = await upstream(t, busy, busy, earlyError);
  const g = await upstream(t, stream([GEMINI_TOOL_TURN], false));
  const store = new MemoryStore();
  await store.putProvider(anthropicOnly(a.base));
  await store.putProvider(geminiOnly(g.base));
  await store.putRouteGroup(
    group("g", ["claude/model-a", "gem/model-a"], { retry: FAST }),
  );
  const key = await addKey(store, ["group/g"]);
  const gw = await mount(t, store);
  const call = () =>
    send(gw.port, "/v1/responses", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/g", stream: true, input: "hi" },
    });
  const decisions = (index: number) =>
    store.entries[index]!.attempts.map((attempt) => [
      attempt.upstreamProtocol,
      attempt.status,
      attempt.decision,
    ]);
  // With another candidate left, a failure fails over at once.
  const first = await call();
  assert.equal(first.status, 200);
  assert.match(first.text, /"delta":"Calling"/);
  assert.doesNotMatch(first.text, /Overloaded/);
  assert.deepEqual(decisions(0), [
    ["anthropic", 529, "failover"],
    ["gemini", 200, "success"],
  ]);
  await call();
  // A 200 whose stream fails before any content is held and fails over. It
  // is the third counted failure in a row: the breaker opens.
  const third = await call();
  assert.doesNotMatch(third.text, /Overloaded/);
  assert.match(third.text, /"delta":"Calling"/);
  assert.deepEqual(decisions(2), [
    ["anthropic", 529, "failover"],
    ["gemini", 200, "success"],
  ]);
  assert.equal(a.seen.length, 3);
  await call();
  assert.equal(
    a.seen.length,
    3,
    "the open breaker skips the Anthropic upstream",
  );
  assert.equal(g.seen.length, 4);
  assert.equal(store.entries[3]!.attempts[0]!.upstreamProtocol, "gemini");
  for (const entry of store.entries) assert.equal(entry.status, 200);
});
