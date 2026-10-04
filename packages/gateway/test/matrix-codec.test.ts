// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToChat } from "../src/anthropic.js";
import { chatToChat } from "../src/chat.js";
import {
  anthropicFinish,
  createDecoder,
  geminiFinish,
  responsesFinish,
} from "../src/decode.js";
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  anthropicMaxTokens,
  encodeRequest,
  geminiSchema,
  type EncodeContext,
} from "../src/encode.js";
import { googleToChat } from "../src/google.js";
import type { ChatTranslation } from "../src/protocol.js";
import { reasoningItemKeys } from "../src/reasoning.js";
import { responsesToChat } from "../src/responses.js";
import { contextNumbers, normalizeChatRequest } from "../src/upstream.js";
import { at } from "./shared-support.js";

const PNG = "iVBORw0KGgo=";
const TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Path" },
        mode: { type: ["string", "null"], enum: ["text", "binary"] },
        kind: { const: "file" },
        either: { oneOf: [{ type: "string" }, { type: "integer" }] },
      },
      required: ["path"],
    },
  },
};

/** A Chat conversation with system, two turns, a tool round trip, an image and reasoning. */
function conversation(): Record<string, unknown> {
  return {
    model: "wire-1",
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG}` },
          },
          {
            type: "image_url",
            image_url: { url: "https://example.test/a.png" },
          },
        ],
      },
      {
        role: "assistant",
        content: "Reading.",
        reasoning_content: "I should read it.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "read", arguments: '{"path":"b"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents of a" },
      { role: "tool", tool_call_id: "call_2", content: "ENOENT" },
      { role: "user", content: "Thanks" },
    ],
    tools: [TOOL],
    tool_choice: "auto",
    parallel_tool_calls: false,
    temperature: 1.5,
    stop: ["END"],
    max_tokens: 3000,
    presence_penalty: 0.5,
  };
}
function context(overrides: Partial<EncodeContext> = {}): EncodeContext {
  const translation: ChatTranslation = {
    body: { messages: [] },
    tools: new Map(),
    stream: true,
    toolErrors: new Set(["call_2"]),
  };
  return { translation, model: undefined, ...overrides };
}

void test("Anthropic encoding: system, turns, images, parallel tool calls and results with error flags", () => {
  const { body, unmapped, patches } = encodeRequest(
    "anthropic",
    conversation(),
    context(),
  );
  assert.equal(body.system, "Be brief.");
  assert.equal(body.model, "wire-1");
  assert.equal(body.max_tokens, 3000);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 1);
  assert.deepEqual(body.stop_sequences, ["END"]);
  assert.deepEqual(body.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(at(body, "tools", 0, "input_schema", "required"), ["path"]);
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "Look" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG },
        },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/a.png" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "call_1", name: "read", input: { path: "a" } },
        { type: "tool_use", id: "call_2", name: "read", input: { path: "b" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "contents of a",
        },
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: "ENOENT",
          is_error: true,
        },
        { type: "text", text: "Thanks" },
      ],
    },
  ]);
  // Unsigned reasoning cannot go to Anthropic; unsupported fields are named.
  assert.deepEqual(unmapped.sort(), ["presence_penalty", "reasoning"]);
  assert.deepEqual(patches, ["temperature:clamped"]);
});

void test("Anthropic max_tokens comes from the request, the model or one recorded default", () => {
  assert.deepEqual(anthropicMaxTokens(100, { id: "m", maxOutputTokens: 9 }), {
    value: 100,
    source: "request",
  });
  assert.deepEqual(
    anthropicMaxTokens(undefined, { id: "m", maxOutputTokens: 9000 }),
    {
      value: 9000,
      source: "model",
    },
  );
  const chat = { model: "w", messages: [{ role: "user", content: "hi" }] };
  const defaulted = encodeRequest("anthropic", chat, context());
  assert.equal(defaulted.body.max_tokens, ANTHROPIC_DEFAULT_MAX_TOKENS);
  assert.deepEqual(defaulted.patches, ["max_tokens:default"]);
  const fromModel = encodeRequest(
    "anthropic",
    chat,
    context({ model: { id: "m", maxOutputTokens: 64_000 } }),
  );
  assert.equal(fromModel.body.max_tokens, 64_000);
  assert.deepEqual(fromModel.patches, ["max_tokens:model"]);
});

void test("Anthropic thinking: enabled from the reasoning request, signed history replayed, unsigned tool turns turn it off", () => {
  const ask = (reasoning: ChatTranslation["reasoning"], signature?: string) =>
    encodeRequest(
      "anthropic",
      {
        model: "w",
        max_tokens: 20_000,
        temperature: 0.2,
        tool_choice: "required",
        tools: [TOOL],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "plan",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "ok" },
        ],
      },
      {
        ...context(),
        translation: {
          body: { messages: [] },
          tools: new Map(),
          stream: true,
          ...(reasoning ? { reasoning } : {}),
        },
        signature: (kind, key) =>
          kind === "thinking" && key === "plan" ? signature : undefined,
      },
    );
  const signed = ask({ effort: "high" }, "sig-1");
  assert.deepEqual(signed.body.thinking, {
    type: "enabled",
    budget_tokens: 16_384,
  });
  assert.deepEqual(at(signed.body, "messages", 1, "content", 0), {
    type: "thinking",
    thinking: "plan",
    signature: "sig-1",
  });
  assert.equal(signed.body.temperature, undefined);
  assert.deepEqual(signed.body.tool_choice, { type: "auto" });
  assert.deepEqual(signed.patches, [
    "temperature:dropped:thinking",
    "tool_choice:auto:thinking",
  ]);
  const unsigned = ask({ budgetTokens: 500 });
  assert.equal(unsigned.body.thinking, undefined);
  assert.deepEqual(unsigned.patches, ["thinking:off:unsigned_history"]);
  assert.ok(unsigned.unmapped.includes("reasoning"));
  const none = ask(undefined, "sig-1");
  assert.equal(none.body.thinking, undefined);
  assert.equal(none.body.temperature, 0.2);
});

void test("Responses encoding: instructions, items, images, non-strict tools, format and reasoning effort", () => {
  const chat = conversation();
  chat.response_format = {
    type: "json_schema",
    json_schema: { name: "out", schema: { type: "object" }, strict: true },
  };
  const { body, unmapped } = encodeRequest(
    "responses",
    chat,
    context({
      translation: {
        body: { messages: [] },
        tools: new Map(),
        stream: true,
        reasoning: { budgetTokens: 1500 },
        toolErrors: new Set(["call_2"]),
      },
    }),
  );
  assert.equal(body.instructions, "Be brief.");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 3000);
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(body.text, {
    format: {
      type: "json_schema",
      name: "out",
      schema: { type: "object" },
      strict: true,
    },
  });
  assert.equal(at(body, "tools", 0, "strict"), false);
  assert.deepEqual(body.input, [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Look" },
        { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
        { type: "input_image", image_url: "https://example.test/a.png" },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Reading." }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read",
      arguments: '{"path":"a"}',
    },
    {
      type: "function_call",
      call_id: "call_2",
      name: "read",
      arguments: '{"path":"b"}',
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "contents of a",
    },
    { type: "function_call_output", call_id: "call_2", output: "ENOENT" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Thanks" }],
    },
  ]);
  assert.deepEqual(unmapped.sort(), [
    "presence_penalty",
    "reasoning",
    "stop",
    "tool_result.is_error",
  ]);
});

void test("Responses encoding returns the same provider's reasoning item ahead of its tool calls and asks for encrypted reasoning", () => {
  const item = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "I should read it." }],
    encrypted_content: "sealed-1",
  };
  const asked: string[] = [];
  // The provider's own item, remembered under the first call's keys only.
  const own = (kind: "thinking" | "call", key: string) => {
    asked.push(`${kind}:${key}`);
    return kind === "call" &&
      reasoningItemKeys({
        id: "call_1",
        name: "read",
        arguments: '{"path":"a"}',
      }).includes(key)
      ? JSON.stringify(item)
      : undefined;
  };
  const replayed = encodeRequest(
    "responses",
    conversation(),
    context({ signature: own }),
  );
  assert.deepEqual(at(replayed.body, "input", 1), item);
  assert.deepEqual(
    (replayed.body.input as Record<string, unknown>[])
      .slice(1, 5)
      .map((entry) => entry.type),
    ["reasoning", "message", "function_call", "function_call"],
  );
  assert.equal(
    (replayed.body.input as Record<string, unknown>[]).filter(
      (entry) => entry.type === "reasoning",
    ).length,
    1,
  );
  assert.ok(!replayed.unmapped.includes("reasoning"));
  assert.deepEqual(replayed.body.include, ["reasoning.encrypted_content"]);
  assert.ok(asked.every((name) => name.startsWith("call:reasoning:")));

  // Another provider's cache has nothing: the history reasoning is dropped.
  const foreign = encodeRequest(
    "responses",
    conversation(),
    context({ signature: () => undefined }),
  );
  assert.ok(
    (foreign.body.input as Record<string, unknown>[]).every(
      (entry) => entry.type !== "reasoning",
    ),
  );
  assert.ok(foreign.unmapped.includes("reasoning"));
  assert.equal(foreign.body.include, undefined);

  // Encrypted reasoning is asked for when the model is known to reason, and
  // never when the request turns reasoning off.
  const reasoner = encodeRequest(
    "responses",
    conversation(),
    context({ model: { id: "wire-1", reasoning: true } }),
  );
  assert.deepEqual(reasoner.body.include, ["reasoning.encrypted_content"]);
  const off = encodeRequest(
    "responses",
    conversation(),
    context({
      model: { id: "wire-1", reasoning: true },
      translation: {
        body: { messages: [] },
        tools: new Map(),
        stream: true,
        reasoning: { off: true },
      },
    }),
  );
  assert.equal(off.body.include, undefined);
});

void test("Gemini encoding: systemInstruction, merged turns, declarations with restricted schemas and named responses", () => {
  const { body, unmapped } = encodeRequest(
    "gemini",
    conversation(),
    context({
      translation: {
        body: { messages: [] },
        tools: new Map(),
        stream: true,
        reasoning: { effort: "low" },
        toolErrors: new Set(["call_2"]),
      },
      signature: (kind, key) =>
        kind === "call" && key === "call_1" ? "gsig" : undefined,
    }),
  );
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Be brief." }] });
  assert.deepEqual(body.contents, [
    {
      role: "user",
      parts: [
        { text: "Look" },
        { inlineData: { mimeType: "image/png", data: PNG } },
      ],
    },
    {
      role: "model",
      parts: [
        { text: "Reading." },
        {
          functionCall: { name: "read", args: { path: "a" } },
          thoughtSignature: "gsig",
        },
        { functionCall: { name: "read", args: { path: "b" } } },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read",
            response: { output: "contents of a" },
          },
        },
        { functionResponse: { name: "read", response: { error: "ENOENT" } } },
        { text: "Thanks" },
      ],
    },
  ]);
  assert.deepEqual(
    at(body, "tools", 0, "functionDeclarations", 0, "parameters"),
    {
      type: "OBJECT",
      properties: {
        path: { type: "STRING", description: "Path" },
        mode: { nullable: true, type: "STRING", enum: ["text", "binary"] },
        kind: { enum: ["file"] },
        either: { anyOf: [{ type: "STRING" }, { type: "INTEGER" }] },
      },
      required: ["path"],
    },
  );
  assert.deepEqual(body.toolConfig, {
    functionCallingConfig: { mode: "AUTO" },
  });
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 3000,
    temperature: 1.5,
    presencePenalty: 0.5,
    stopSequences: ["END"],
    thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
  });
  assert.deepEqual(unmapped.sort(), [
    "image_url",
    "parallel_tool_calls",
    "reasoning",
    "schema.$schema",
    "schema.additionalProperties",
  ]);
  const dropped = new Set<string>();
  assert.deepEqual(
    geminiSchema(
      { type: ["integer", "string"], minimum: 1, exclusiveMinimum: 0 },
      dropped,
    ),
    {
      type: "INTEGER",
      minimum: 1,
    },
  );
  assert.deepEqual([...dropped].sort(), ["exclusiveMinimum", "type[]"]);
});

void test("inbound translators carry images, reasoning requests and tool errors into the pivot", () => {
  const anthropic = anthropicToChat(
    {
      model: "m",
      max_tokens: 9,
      thinking: { type: "enabled", budget_tokens: 3000 },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "AAA" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "boom",
            },
          ],
        },
      ],
    },
    { images: true },
  );
  assert.deepEqual(anthropic.reasoning, { budgetTokens: 3000 });
  assert.deepEqual([...(anthropic.toolErrors ?? [])], ["t1"]);
  assert.deepEqual(at(anthropic.body, "messages", 0, "content", 1), {
    type: "image_url",
    image_url: { url: "data:image/jpeg;base64,AAA" },
  });
  // Without the option the Session gateway's placeholder text is unchanged.
  assert.match(
    String(
      at(
        anthropicToChat({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "A",
                  },
                },
              ],
            },
          ],
        }).body,
        "messages",
        0,
        "content",
      ),
    ),
    /omitted/,
  );
  const responses = responsesToChat(
    {
      model: "m",
      reasoning: { effort: "high" },
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://x.test/i.png" }],
        },
      ],
    },
    { images: true },
  );
  assert.deepEqual(responses.reasoning, { effort: "high" });
  assert.deepEqual(at(responses.body, "messages", 0, "content", 0), {
    type: "image_url",
    image_url: { url: "https://x.test/i.png" },
  });
  const gemini = googleToChat(
    {
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: "QQ" } }],
        },
        { role: "model", parts: [{ functionCall: { name: "x", args: {} } }] },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "x", response: { error: "no" } } },
          ],
        },
      ],
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    },
    "m",
    false,
    { images: true },
  );
  assert.deepEqual(gemini.reasoning, { off: true });
  assert.equal(gemini.toolErrors?.size, 1);
  assert.deepEqual(at(gemini.body, "messages", 0, "content", 0), {
    type: "image_url",
    image_url: { url: "data:image/png;base64,QQ" },
  });
  assert.deepEqual(
    chatToChat({ messages: [], reasoning_effort: "minimal" }).reasoning,
    { effort: "minimal" },
  );
  // The pivot keeps image parts for image models and replaces them otherwise.
  const kept = normalizeChatRequest(
    anthropic.body,
    {
      model: "w",
      includeUsage: true,
      maxTokensField: "max_tokens",
      dropParameters: [],
      images: "passthrough",
    },
    { dropDefaults: false, jsonSchema: "keep" },
  );
  assert.equal(at(kept, "messages", 0, "content", 1, "type"), "image_url");
});

void test("stop reasons map to the pivot's finish reasons and unknown values pass through", () => {
  assert.deepEqual(
    [
      "end_turn",
      "max_tokens",
      "tool_use",
      "stop_sequence",
      "refusal",
      "pause_turn",
    ].map(anthropicFinish),
    ["stop", "length", "tool_calls", "stop", "content_filter", "pause_turn"],
  );
  assert.deepEqual(
    ["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER"].map(geminiFinish),
    ["stop", "length", "content_filter", "content_filter", "other"],
  );
  assert.throws(
    () => geminiFinish("MALFORMED_FUNCTION_CALL"),
    /invalid function call/,
  );
  assert.equal(responsesFinish("completed"), "stop");
  assert.equal(responsesFinish("incomplete", "max_output_tokens"), "length");
  assert.equal(
    responsesFinish("incomplete", "content_filter"),
    "content_filter",
  );
});

void test("the Anthropic decoder turns thinking, text, tool use and usage into Chat chunks and keeps the signature", () => {
  const decoder = createDecoder("anthropic");
  const chunks = [
    {
      type: "message_start",
      message: {
        model: "claude-x",
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
      delta: { type: "signature_delta", signature: "SIG" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Hi" },
    },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"pa' },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: 'th":"a"}' },
    },
    {
      type: "content_block_start",
      index: 3,
      content_block: { type: "redacted_thinking", data: "x" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ].flatMap((event) => decoder.event(event));
  assert.equal(chunks[0]!.model, "claude-x");
  assert.deepEqual(
    chunks.flatMap((chunk) => {
      const change = at(chunk, "choices", 0, "delta") as
        Record<string, unknown> | undefined;
      return change && Object.keys(change).length ? [change] : [];
    }),
    [
      { reasoning_content: "hmm" },
      { content: "Hi" },
      {
        tool_calls: [
          {
            index: 0,
            id: "tu_1",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
      { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] },
    ],
  );
  const last = chunks.at(-1)!;
  assert.equal(at(last, "choices", 0, "finish_reason"), "tool_calls");
  assert.deepEqual(last.usage, {
    prompt_tokens: 45,
    completion_tokens: 20,
    total_tokens: 65,
    prompt_tokens_details: { cached_tokens: 30 },
    cache_creation_input_tokens: 5,
  });
  assert.deepEqual(decoder.thinking, [{ text: "hmm", signature: "SIG" }]);
  assert.deepEqual([...decoder.unmapped], ["response.redacted_thinking"]);
  assert.throws(
    () =>
      decoder.event({
        type: "error",
        error: { type: "overloaded_error", message: "busy" },
      }),
    (error: unknown) => (error as { status?: number }).status === 529,
  );
});

void test("the Responses decoder keeps interleaved parallel function arguments apart", () => {
  const decoder = createDecoder("responses");
  const events = [
    { type: "response.created", response: { model: "gpt-x" } },
    { type: "response.reasoning_summary_text.delta", delta: "think" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_a",
        call_id: "call_a",
        name: "read",
        arguments: "",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: {
        type: "function_call",
        id: "fc_b",
        call_id: "call_b",
        name: "list",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc_a",
      delta: '{"x":',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "fc_b",
      delta: '{"y":',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: "fc_a",
      delta: "1}",
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 2,
      item_id: "fc_b",
      delta: "2}",
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_a",
            call_id: "call_a",
            name: "read",
            arguments: '{"x":1}',
          },
          {
            type: "function_call",
            id: "fc_b",
            call_id: "call_b",
            name: "list",
            arguments: '{"y":2}',
          },
        ],
        usage: {
          input_tokens: 50,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    },
  ];
  const chunks = events.flatMap((event) => decoder.event(event));
  const args = new Map<number, string>();
  for (const chunk of chunks)
    for (const call of (at(chunk, "choices", 0, "delta", "tool_calls") as
      Record<string, unknown>[] | undefined) ?? [])
      args.set(
        call.index as number,
        (args.get(call.index as number) ?? "") +
          String(at(call, "function", "arguments")),
      );
  assert.deepEqual(
    [...args],
    [
      [0, '{"x":1}'],
      [1, '{"y":2}'],
    ],
  );
  assert.deepEqual(chunks.at(-1)!.usage, {
    prompt_tokens: 50,
    completion_tokens: 9,
    total_tokens: 59,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });
  assert.throws(
    () =>
      decoder.event({
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "rate_limit_exceeded", message: "slow" },
        },
      }),
    (error: unknown) => (error as { status?: number }).status === 429,
  );
});

void test("the Responses decoder keeps the reasoning item each tool call followed, completed by later events", () => {
  const streamed = createDecoder("responses");
  for (const event of [
    { type: "response.created", response: { model: "gpt-x" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      delta: "think",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "think" }],
        encrypted_content: "sealed-1",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_a",
        call_id: "call_a",
        name: "read",
        arguments: '{"x":1}',
      },
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: {
        type: "function_call",
        id: "fc_b",
        call_id: "call_b",
        name: "list",
        arguments: '{"y":2}',
      },
    },
    { type: "response.completed", response: { status: "completed" } },
  ])
    streamed.event(event);
  const item = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "think" }],
    encrypted_content: "sealed-1",
  };
  assert.deepEqual(
    [...streamed.callReasoning],
    [
      [0, item],
      [1, item],
    ],
  );
  assert.deepEqual([...streamed.callSignatures], []);

  // A whole response: the item comes from the output, without encrypted
  // content when the provider gave none; a call before any reasoning has none.
  const whole = createDecoder("responses");
  whole.body({
    model: "gpt-x",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: "fc_0",
        call_id: "call_0",
        name: "read",
        arguments: "{}",
      },
      {
        type: "reasoning",
        id: "rs_2",
        summary: [{ type: "summary_text", text: "then" }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read",
        arguments: "{}",
      },
    ],
  });
  assert.deepEqual(
    [...whole.callReasoning],
    [
      [
        1,
        {
          type: "reasoning",
          id: "rs_2",
          summary: [{ type: "summary_text", text: "then" }],
        },
      ],
    ],
  );
});

void test("the Gemini decoder emits thoughts, complete function calls with their signatures, and usage", () => {
  const decoder = createDecoder("gemini");
  const [chunk] = decoder.event({
    modelVersion: "gemini-x",
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "ponder", thought: true },
            { text: "ok" },
            {
              functionCall: { name: "read", args: { p: 1 } },
              thoughtSignature: "TS",
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
  });
  assert.deepEqual(at(chunk, "choices", 0, "delta"), {
    reasoning_content: "ponder",
    content: "ok",
    tool_calls: [
      {
        index: 0,
        type: "function",
        function: { name: "read", arguments: '{"p":1}' },
      },
    ],
  });
  assert.equal(at(chunk, "choices", 0, "finish_reason"), "stop");
  assert.deepEqual(at(chunk, "usage"), {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
  });
  assert.deepEqual([...decoder.callSignatures], [[0, "TS"]]);
});

void test("context overflow numbers are read from each vendor's wording", () => {
  for (const [message, numbers] of [
    [
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages.",
      { actual: 9000, limit: 8192 },
    ],
    [
      "This model's maximum context length is 131072 tokens. However, you requested 139000 tokens (139000 in the messages, 0 in the completion).",
      { actual: 139000, limit: 131072 },
    ],
    [
      "prompt is too long: 300000 tokens > 200000 maximum",
      { actual: 300000, limit: 200000 },
    ],
    [
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).",
      { actual: 1196265, limit: 1048575 },
    ],
    ["Request too large", undefined],
  ] as const)
    assert.deepEqual(contextNumbers(message), numbers, message);
});
