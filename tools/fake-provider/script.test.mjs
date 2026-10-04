// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { parseSse } from "./decode.mjs";
import { PROTOCOLS, REPLIES, startFakeProvider } from "./index.mjs";
import { markerArguments, parseScript, selectShellTool } from "./script.mjs";
import {
  authHeaders,
  callPath,
  followUp,
  KEY,
  minimalBody,
  send,
  shellTools,
} from "./testing.mjs";

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

/** Data payloads of a Chat stream's content deltas. */
function chatDeltas(text, field) {
  return parseSse(text)
    .events.filter(({ data }) => data !== "[DONE]")
    .map(({ data }) => JSON.parse(data).choices[0].delta[field])
    .filter((value) => typeof value === "string" && value !== "");
}

test("without a script every protocol answers OK", async (t) => {
  const fake = await provider(t);
  for (const protocol of PROTOCOLS)
    assert.equal((await send(fake, protocol)).answer.text, REPLIES.ok);
  assert.deepEqual(
    (await records(fake)).map((record) => record.turn),
    ["plain", "plain", "plain", "plain"],
  );
});

test("script text: a string is split like the built-in replies, an array is sent chunk by chunk", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [
        { text: "Hello there, world" },
        { text: ["a", "b", "c"] },
        { text: "short" },
      ],
    },
  });
  const split = await send(fake, "chat", { stream: true });
  assert.deepEqual(chatDeltas(split.text, "content"), [
    "Hello the",
    "re, world",
  ]);
  const chunked = await send(fake, "chat", { stream: true });
  assert.deepEqual(chatDeltas(chunked.text, "content"), ["a", "b", "c"]);
  const short = await send(fake, "chat", { stream: true });
  assert.deepEqual(chatDeltas(short.text, "content"), ["short"]);
  assert.deepEqual(
    (await records(fake)).map((record) => [record.turn, record.script]),
    [
      ["script", 0],
      ["script", 1],
      ["script", 2],
    ],
  );
});

test("script reasoning: chunks in each protocol's reasoning form, where the request asks for it", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [{ repeat: true, reasoning: ["think ", "more"], text: "done" }],
    },
  });
  const chat = await send(fake, "chat", { stream: true });
  assert.deepEqual(chatDeltas(chat.text, "reasoning_content"), [
    "think ",
    "more",
  ]);
  assert.equal(
    (await send(fake, "responses", { stream: true })).answer.reasoning,
    "think more",
  );
  // Messages shows thinking only when the request enables it; Gemini only with includeThoughts.
  assert.equal(
    (await send(fake, "messages", { stream: true })).answer.reasoning,
    "",
  );
  const thinking = await send(fake, "messages", {
    stream: true,
    body: { thinking: { type: "enabled", budget_tokens: 1024 } },
  });
  assert.equal(thinking.answer.reasoning, "think more");
  assert.match(thinking.answer.signature, /^[0-9a-f]{48}$/);
  assert.equal((await send(fake, "gemini")).answer.reasoning, "");
  const thoughts = await send(fake, "gemini", {
    body: { generationConfig: { thinkingConfig: { includeThoughts: true } } },
  });
  assert.equal(thoughts.answer.reasoning, "think more");
  assert.equal(thoughts.answer.text, "done");
});

test("script tool calls: native call ids, arguments and finish reasons in every protocol", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [
        {
          repeat: true,
          toolCalls: [
            { name: "read_file", arguments: { path: "a.txt" } },
            { name: "write_file", arguments: { path: "b.txt", text: "x" } },
          ],
        },
      ],
    },
  });
  const ids = {
    chat: /^call_/,
    responses: /^call_/,
    messages: /^toolu_/,
    gemini: /^undefined$/,
  };
  const finishes = {
    chat: "tool_calls",
    responses: "completed",
    messages: "tool_use",
    gemini: "STOP",
  };
  for (const protocol of PROTOCOLS)
    for (const stream of [false, true]) {
      const { answer } = await send(fake, protocol, { stream });
      const where = `${protocol} ${stream}`;
      assert.deepEqual(
        answer.toolCalls.map((call) => [call.name, JSON.parse(call.arguments)]),
        [
          ["read_file", { path: "a.txt" }],
          ["write_file", { path: "b.txt", text: "x" }],
        ],
        where,
      );
      for (const call of answer.toolCalls)
        assert.match(String(call.id), ids[protocol], where);
      assert.deepEqual(answer.finishes, [finishes[protocol]], where);
    }
});

test("script tool calls keep a given id and raw argument text", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [
        {
          toolCalls: [
            { id: "call_fixed", name: "bash", arguments: '{"command": "ls"' },
          ],
        },
      ],
    },
  });
  const { answer } = await send(fake, "chat", { stream: true });
  assert.deepEqual(answer.toolCalls, [
    { id: "call_fixed", name: "bash", arguments: '{"command": "ls"' },
  ]);
});

test("script error status: one native error response, then the next turn", async (t) => {
  const fake = await provider(t, {
    script: { turns: [{ status: 503, error: "upstream maintenance" }] },
  });
  const failed = await send(fake, "messages", { stream: true });
  assert.equal(failed.status, 503);
  assert.equal(failed.json.error.message, "upstream maintenance");
  assert.equal(failed.json.error.type, "api_error");
  const gemini = await startFakeProvider({
    script: { turns: [{ status: 429 }] },
  });
  t.after(() => gemini.close());
  const limited = await send(gemini, "gemini", { key: null });
  assert.deepEqual(
    [limited.status, limited.json.error.status, limited.json.error.message],
    [429, "RESOURCE_EXHAUSTED", "Scripted upstream error"],
  );
  assert.equal((await send(fake, "messages")).answer.text, "OK");
});

test("script firstByteDelayMs: stream headers come first, the body after the delay", async (t) => {
  const fake = await provider(t, {
    script: { turns: [{ repeat: true, firstByteDelayMs: 400 }] },
  });
  for (const [protocol, stream] of [
    ["chat", true],
    ["chat", false],
  ]) {
    const started = performance.now();
    const response = await fetch(fake.url + callPath(protocol, { stream }), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(protocol, KEY),
      },
      body: JSON.stringify(minimalBody(protocol, { stream })),
    });
    const headers = performance.now() - started;
    await response.text();
    const body = performance.now() - started;
    if (stream) assert.ok(headers < 300, `stream headers after ${headers} ms`);
    else assert.ok(headers >= 390, `non-streaming headers after ${headers} ms`);
    assert.ok(body >= 390, `body after ${body} ms`);
  }
});

test("script chunkDelayMs: stream frames are spaced by the delay", async (t) => {
  const fake = await provider(t, {
    script: { turns: [{ text: ["a", "b", "c", "d"], chunkDelayMs: 100 }] },
  });
  const started = performance.now();
  const result = await send(fake, "chat", { stream: true });
  const elapsed = performance.now() - started;
  const frames = parseSse(result.text).events.length;
  assert.equal(frames, 7);
  assert.ok(
    elapsed >= (frames - 1) * 100 - 10,
    `${frames} frames in ${elapsed} ms`,
  );
});

test("script selection: when.contains, when.toolResult, repeat and fallback to the directives", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [
        { when: { contains: "deploy" }, text: "deploying" },
        { when: { toolResult: true }, repeat: true, text: "tool seen" },
        { when: { contains: "status" }, repeat: true, text: "all green" },
      ],
    },
  });
  assert.equal(
    (await send(fake, "chat", { text: "status?" })).answer.text,
    "all green",
  );
  assert.equal(
    (await send(fake, "chat", { text: "status!" })).answer.text,
    "all green",
  );
  assert.equal(
    (await send(fake, "chat", { text: "please deploy" })).answer.text,
    "deploying",
  );
  assert.equal(
    (await send(fake, "chat", { text: "please deploy" })).answer.text,
    "OK",
  );
  const afterTool = await send(fake, "chat", {
    body: (body) => ({
      ...body,
      messages: [
        ...body.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "f", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "r" },
      ],
    }),
  });
  assert.equal(afterTool.answer.text, "tool seen");
  assert.deepEqual(
    (await records(fake)).map((record) => record.script ?? record.turn),
    [2, 2, 0, "plain", 1],
  );
});

test("script selection: when.offersTool and when.toolResultContains read the tools offered and the tool result's text in every protocol", async (t) => {
  for (const protocol of PROTOCOLS) {
    const fake = await provider(t, {
      script: {
        turns: [
          {
            when: { offersTool: "read" },
            toolCalls: [{ name: "read", arguments: { path: "token.txt" } }],
          },
          { when: { toolResultContains: "TOKEN-42" }, text: "saw TOKEN-42" },
          { when: { toolResult: true }, repeat: true, text: "another result" },
        ],
      },
    });
    // Without the tool offered, the tool turn does not apply.
    assert.equal((await send(fake, protocol)).answer.text, REPLIES.ok, protocol);
    const first = await send(fake, protocol, {
      body: (body) => ({ ...body, tools: shellTools(protocol, "read") }),
    });
    assert.deepEqual(
      first.answer.toolCalls.map((call) => call.name),
      ["read"],
      protocol,
    );
    const answered = (result) =>
      send(fake, protocol, {
        body: followUp(protocol, first.body, first.answer, { result }),
      });
    assert.equal(
      (await answered("other text")).answer.text,
      "another result",
      protocol,
    );
    assert.equal(
      (await answered("the file holds TOKEN-42")).answer.text,
      "saw TOKEN-42",
      protocol,
    );
  }
});

test("script usage and finish: explicit counts, no usage, and finish reasons mapped per protocol", async (t) => {
  const fake = await provider(t, {
    script: {
      turns: [
        { usage: { input: 11, output: 22, reasoning: 5 } },
        { usage: false },
        {
          repeat: true,
          when: { contains: "cut" },
          text: "cut sho",
          finish: "length",
        },
      ],
    },
  });
  assert.deepEqual((await send(fake, "chat")).answer.usage, {
    prompt_tokens: 11,
    completion_tokens: 22,
    total_tokens: 33,
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  assert.equal((await send(fake, "chat")).answer.usage, undefined);
  const expected = {
    chat: "length",
    responses: "incomplete:max_output_tokens",
    messages: "max_tokens",
    gemini: "MAX_TOKENS",
  };
  for (const protocol of PROTOCOLS)
    for (const stream of [false, true])
      assert.deepEqual(
        (await send(fake, protocol, { stream, text: "cut" })).answer.finishes,
        [expected[protocol]],
        `${protocol} ${stream}`,
      );
});

test("scripts are validated with the path of the first invalid setting", async (t) => {
  const invalid = [
    [{ turn: [] }, /only "turns"/],
    [
      { turns: [{ reply: "x" }] },
      /turns\[0\]\.reply is not a known turn setting/,
    ],
    [
      { turns: [{ text: [] }] },
      /turns\[0\]\.text must be a string or a non-empty array/,
    ],
    [
      { turns: [{ toolCalls: [{ arguments: {} }] }] },
      /turns\[0\]\.toolCalls\[0\]\.name/,
    ],
    [
      { turns: [{ toolCalls: [{ name: "f", arguments: 1 }] }] },
      /arguments must be an object or JSON text/,
    ],
    [{ turns: [{ status: 302 }] }, /status must be an HTTP error status/],
    [
      { turns: [{ status: 500, text: "x" }] },
      /cannot have a status and an answer/,
    ],
    [{ turns: [{ error: "x" }] }, /error needs a status/],
    [
      { turns: [{ usage: { input: -1, output: 1 } }] },
      /usage must be false or/,
    ],
    [
      { turns: [{ firstByteDelayMs: 1.5 }] },
      /firstByteDelayMs must be an integer/,
    ],
    [
      { turns: [{ when: { contains: "" } }] },
      /when.contains must be a non-empty string/,
    ],
    [
      { turns: [{ when: { offersTool: 3 } }] },
      /when.offersTool must be a non-empty string/,
    ],
    [
      { turns: [{ when: { toolResultContains: "" } }] },
      /when.toolResultContains must be a non-empty string/,
    ],
    [
      { turns: [{ when: { tool: "read" } }] },
      /when must be an object with contains, toolResult/,
    ],
    [
      { turns: [{ quirks: { noUsage: 1 } }] },
      /turns\[0\]\.quirks\.noUsage must be true or false/,
    ],
  ];
  for (const [script, pattern] of invalid)
    assert.throws(() => parseScript(script), pattern);
  await assert.rejects(
    startFakeProvider({ script: { turns: [{ status: 99 }] } }),
    /status must be/,
  );
  const fake = await provider(t, { script: { turns: [] } });
  assert.equal((await send(fake, "chat")).answer.text, "OK");
});

/** Requests that enable each protocol's reasoning output, so that it must come back. */
const REASONING = {
  chat: {},
  responses: { include: ["reasoning.encrypted_content"] },
  messages: { thinking: { type: "enabled", budget_tokens: 1024 } },
  gemini: {},
};

for (const protocol of PROTOCOLS)
  test(`HH_MOCK_TOOL in ${protocol}: one marker tool call, the reasoning must come back with its result, then DONE`, async (t) => {
    const fake = await provider(t);
    for (const stream of [false, true]) {
      const first = await send(fake, protocol, {
        stream,
        text: `HH_MOCK_TOOL run it (${stream})`,
        body: { ...REASONING[protocol], tools: shellTools(protocol) },
      });
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(
        first.answer.toolCalls.map((call) => [
          call.name,
          JSON.parse(call.arguments),
        ]),
        [["bash", { command: "echo mock-ok > mock-ok.txt" }]],
      );
      const missing = await send(fake, protocol, {
        stream,
        body: () =>
          followUp(protocol, first.body, first.answer, { echo: false }),
      });
      assert.equal(missing.status, 400, missing.text);
      const replayed = await send(fake, protocol, {
        stream,
        body: () => followUp(protocol, first.body, first.answer),
      });
      assert.equal(replayed.status, 200, replayed.text);
      assert.equal(replayed.answer.text, REPLIES.done);
    }
    const [call, rejected, done] = await records(fake);
    assert.deepEqual([call.turn, call.tool], ["tool-call", "bash"]);
    assert.deepEqual(
      [
        rejected.turn,
        rejected.reasoningEcho,
        rejected.violations.map((violation) => violation.rule),
      ],
      ["tool-result", false, ["reasoning"]],
    );
    assert.deepEqual(
      [done.turn, done.reasoningEcho, done.violations],
      ["tool-result", true, []],
    );
  });

test("calls without ids match the latest issued call whose reasoning comes back", async (t) => {
  const fake = await provider(t);
  const conversation = (system) => ({
    systemInstruction: { parts: [{ text: system }] },
    tools: shellTools("gemini"),
  });
  const first = await send(fake, "gemini", {
    text: "HH_MOCK_TOOL",
    body: conversation("engine A"),
  });
  const second = await send(fake, "gemini", {
    text: "HH_MOCK_TOOL",
    body: conversation("engine B"),
  });
  assert.notEqual(first.answer.signature, second.answer.signature);
  // Both calls have the same name and arguments; only the signature tells them apart.
  for (const call of [second, first]) {
    const result = await send(fake, "gemini", {
      body: () => followUp("gemini", call.body, call.answer),
    });
    assert.equal(result.answer.text, REPLIES.done);
  }
  const [, , secondResult, firstResult] = await records(fake);
  assert.equal(secondResult.reasoningEcho, true);
  assert.equal(firstResult.reasoningEcho, true);
});

test("reasoning replay is an option, and Messages requires it only while thinking is enabled", async (t) => {
  const lenient = await provider(t, { reasoningReplay: false });
  const first = await send(lenient, "chat", {
    text: "HH_MOCK_TOOL",
    body: { tools: shellTools("chat") },
  });
  const followed = await send(lenient, "chat", {
    body: () => followUp("chat", first.body, first.answer, { echo: false }),
  });
  assert.equal(followed.answer.text, REPLIES.done);
  const strict = await provider(t);
  const plain = await send(strict, "messages", {
    text: "HH_MOCK_TOOL",
    body: { tools: shellTools("messages") },
  });
  assert.equal(plain.answer.reasoning, "");
  const without = await send(strict, "messages", {
    body: () => followUp("messages", plain.body, plain.answer, { echo: false }),
  });
  assert.equal(without.answer.text, REPLIES.done);
  const [, record] = await records(lenient);
  assert.equal(record.reasoningEcho, false);
  assert.deepEqual(record.violations, []);
});

test("HH_MOCK_TOOL without a shell-like tool answers NO_SHELL_TOOL, or OK without any tools", async (t) => {
  const fake = await provider(t);
  const other = await send(fake, "chat", {
    text: "HH_MOCK_TOOL",
    body: { tools: shellTools("chat", "read_file") },
  });
  assert.equal(other.answer.text, REPLIES.noShellTool);
  assert.equal(
    (await send(fake, "gemini", { text: "HH_MOCK_TOOL" })).answer.text,
    REPLIES.ok,
  );
  const [first, second] = await records(fake);
  assert.deepEqual(
    [first.turn, first.toolNames],
    ["no-shell-tool", ["read_file"]],
  );
  assert.equal(second.turn, "no-tools");
});

test("HH_MOCK_TOOL stops a conversation that re-sends the same turn more than three times", async (t) => {
  const fake = await provider(t);
  const body = (system) => (base) => ({
    ...base,
    messages: [{ role: "system", content: system }, ...base.messages],
    tools: shellTools("chat"),
  });
  for (let attempt = 1; attempt <= 3; attempt++)
    assert.equal(
      (
        await send(fake, "chat", {
          text: "HH_MOCK_TOOL",
          body: body("engine A"),
        })
      ).answer.toolCalls.length,
      1,
    );
  const stopped = await send(fake, "chat", {
    text: "HH_MOCK_TOOL",
    body: body("engine A"),
  });
  assert.equal(stopped.answer.text, REPLIES.done);
  // Another conversation with the same prompt has its own count.
  assert.equal(
    (await send(fake, "chat", { text: "HH_MOCK_TOOL", body: body("engine B") }))
      .answer.toolCalls.length,
    1,
  );
  assert.deepEqual(
    (await records(fake)).map((record) => record.turn),
    ["tool-call", "tool-call", "tool-call", "tool-loop-stopped", "tool-call"],
  );
});

test("HH_MOCK_UNICODE answers a fixed non-ASCII text in two chunks", async (t) => {
  const fake = await provider(t);
  const result = await send(fake, "chat", {
    stream: true,
    text: "HH_MOCK_UNICODE",
  });
  assert.equal(result.answer.text, REPLIES.unicode);
  assert.deepEqual(
    chatDeltas(result.text, "content").join(""),
    REPLIES.unicode,
  );
  assert.equal(chatDeltas(result.text, "content").length, 2);
  assert.equal(
    (await send(fake, "gemini", { stream: true, text: "HH_MOCK_UNICODE" }))
      .answer.text,
    REPLIES.unicode,
  );
});

test("HH_MOCK_SLOW streams a dot every 500 ms for slowMs, or waits slowMs without streaming", async (t) => {
  const fake = await provider(t, { slowMs: 1000 });
  const started = performance.now();
  const streamed = await send(fake, "chat", {
    stream: true,
    text: "HH_MOCK_SLOW",
  });
  assert.ok(performance.now() - started >= 990);
  assert.equal(streamed.answer.text, ".. DONE");
  assert.deepEqual(chatDeltas(streamed.text, "content"), [".", ".", " DONE"]);
  const waited = performance.now();
  const single = await send(fake, "responses", { text: "HH_MOCK_SLOW" });
  assert.ok(performance.now() - waited >= 990);
  assert.equal(single.answer.text, ".. DONE");
  assert.deepEqual(
    (await records(fake)).map((record) => record.turn),
    ["slow", "slow"],
  );
});

test("the marker command suits the shell tool's argument form and platform", () => {
  const tools = [
    {
      name: "read_file",
      parameters: { properties: { path: { type: "string" } } },
    },
    {
      name: "exec",
      parameters: {
        properties: {
          cmd: { type: "array" },
          timeout_ms: { type: "integer" },
          workdir: { type: "string" },
        },
        required: ["cmd", "timeout_ms", "workdir"],
      },
    },
  ];
  const selection = selectShellTool(tools);
  assert.equal(selection.name, "exec");
  assert.deepEqual(markerArguments(selection, "linux"), {
    cmd: ["sh", "-c", "echo mock-ok > mock-ok.txt"],
    timeout_ms: 60000,
    workdir: ".",
  });
  assert.deepEqual(markerArguments(selection, "win32").cmd, [
    "cmd.exe",
    "/d",
    "/c",
    "echo mock-ok> mock-ok.txt",
  ]);
  assert.equal(selectShellTool(tools.slice(0, 1)), undefined);
  // Gemini declarations spell the types in upper case.
  const gemini = selectShellTool([
    {
      name: "bash",
      parameters: {
        type: "OBJECT",
        properties: {
          command: { type: "STRING" },
          timeout: { type: "INTEGER" },
        },
        required: ["command", "timeout"],
      },
    },
  ]);
  assert.equal(gemini?.name, "bash");
  assert.deepEqual(markerArguments(gemini, "linux"), {
    command: "echo mock-ok > mock-ok.txt",
    timeout: 60,
  });
  assert.equal(
    selectShellTool([
      { name: "bash", parameters: { properties: { command: { type: "OBJECT" } } } },
    ]),
    undefined,
  );
});
