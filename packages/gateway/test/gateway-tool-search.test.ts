// SPDX-License-Identifier: MIT
/**
 * Tool search for upstreams that cannot run it: Codex's `tool_search` as a
 * plain function and back, and Claude Code's `tool_reference` results.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToChat } from "../src/anthropic.js";
import { toolAlias } from "../src/protocol.js";
import { responsesToChat } from "../src/responses.js";
import {
  flatName,
  searchAsFunction,
  SearchCallRestorer,
} from "../src/toolsearch.js";

const SEARCH = {
  type: "tool_search",
  execution: "client",
  description: "Search the MCP tools.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};
const SHELL = {
  type: "function",
  name: "shell",
  parameters: { type: "object", properties: {} },
};
const ISSUE = {
  type: "function",
  name: "create_issue",
  description: "Create an issue.",
  defer_loading: true,
  parameters: { type: "object", properties: { title: { type: "string" } } },
};
const NAMESPACE = {
  type: "namespace",
  name: "mcp__linear",
  description: "Linear",
  tools: [
    { type: "function", name: "list_teams", defer_loading: true },
    { type: "function", name: "get_team", defer_loading: true },
  ],
};
const CALL = {
  type: "tool_search_call",
  id: "tsc_1",
  call_id: "call_s1",
  status: "completed",
  execution: "client",
  arguments: { query: "issues" },
};
const OUTPUT = {
  type: "tool_search_output",
  id: "tso_1",
  call_id: "call_s1",
  status: "completed",
  execution: "client",
  tools: [ISSUE, NAMESPACE],
};
const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

void test("Codex's tool search goes to a Responses upstream as a function, its found tools without defer_loading", () => {
  const again = {
    ...OUTPUT,
    call_id: "call_s2",
    tools: [
      ISSUE,
      { ...NAMESPACE, tools: [{ type: "function", name: "list_issues" }] },
    ],
  };
  const body = Buffer.from(
    JSON.stringify({
      model: "m",
      tools: [SHELL, SEARCH],
      input: [
        user("find"),
        CALL,
        OUTPUT,
        { ...CALL, call_id: "call_s2" },
        again,
      ],
    }),
  );
  const rewritten = searchAsFunction(body);
  assert.ok(rewritten);
  const request = JSON.parse(rewritten.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(request.tools, [
    SHELL,
    {
      type: "function",
      name: "tool_search",
      description: SEARCH.description,
      parameters: SEARCH.parameters,
    },
    {
      type: "function",
      name: "create_issue",
      description: "Create an issue.",
      parameters: ISSUE.parameters,
    },
    {
      type: "namespace",
      name: "mcp__linear",
      description: "Linear",
      tools: [
        { type: "function", name: "list_teams" },
        { type: "function", name: "get_team" },
        { type: "function", name: "list_issues" },
      ],
    },
  ]);
  assert.deepEqual(request.input, [
    user("find"),
    {
      type: "function_call",
      call_id: "call_s1",
      name: "tool_search",
      arguments: '{"query":"issues"}',
    },
    {
      type: "function_call_output",
      call_id: "call_s1",
      output:
        "These tools are now available to call: create_issue, mcp__linear__list_teams, mcp__linear__get_team",
    },
    {
      type: "function_call",
      call_id: "call_s2",
      name: "tool_search",
      arguments: '{"query":"issues"}',
    },
    {
      type: "function_call_output",
      call_id: "call_s2",
      output:
        "These tools are now available to call: create_issue, mcp__linear__list_issues",
    },
  ]);
  // Nothing to rewrite without Codex's search tool.
  for (const value of [
    { model: "m", tools: [SHELL], input: [user("tool_search")] },
    { model: "m", tools: [{ ...SHELL, name: "tool_search" }], input: [] },
    { model: "m", tools: [{ ...SEARCH, execution: "server" }], input: [] },
  ])
    assert.equal(
      searchAsFunction(Buffer.from(JSON.stringify(value))),
      undefined,
    );
  assert.equal(searchAsFunction(Buffer.from('{"tool_search"')), undefined);
});

void test("a search that found nothing says so, and long namespaced names are cut with a hash", () => {
  const empty = searchAsFunction(
    Buffer.from(
      JSON.stringify({
        tools: [SEARCH],
        input: [CALL, { ...OUTPUT, tools: [] }],
      }),
    ),
  );
  assert.ok(empty);
  assert.deepEqual(
    (JSON.parse(empty.toString("utf8")) as { input: unknown[] }).input[1],
    {
      type: "function_call_output",
      call_id: "call_s1",
      output: "No tools matched the search.",
    },
  );
  const long = flatName("t".repeat(40), `mcp__${"s".repeat(40)}`);
  assert.equal(long.length, 64);
  assert.match(long, /^mcp__s+__t+_[0-9a-f]{8}$/);
  assert.equal(flatName("run"), "run");
});

/** The function names of translated Chat tools. */
function toolNames(tools: unknown): string[] {
  return ((tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );
}

/** Server-sent events of a text, as their data. */
function events(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((block) => block.includes("data:"))
    .map(
      (block) =>
        JSON.parse(
          block
            .split("\n")
            .find((line) => line.startsWith("data:"))!
            .slice(5),
        ) as Record<string, unknown>,
    );
}

void test("the model's call of the tool_search function goes back to Codex as its tool_search_call", () => {
  const call = {
    id: "fc_9",
    type: "function_call",
    status: "completed",
    call_id: "call_9",
    name: "tool_search",
    arguments: '{"query":"linear"}',
  };
  const search = {
    id: "fc_9",
    type: "tool_search_call",
    status: "completed",
    call_id: "call_9",
    execution: "client",
    arguments: { query: "linear" },
  };
  const other = {
    type: "response.output_text.delta",
    item_id: "msg_1",
    delta: 'say "tool_search"',
  };
  const namespaced = {
    type: "response.output_item.done",
    item: { ...call, namespace: "mcp__x" },
  };
  const frames = [
    { type: "response.output_item.added", item: { ...call, arguments: "" } },
    other,
    { type: "response.output_item.done", output_index: 0, item: call },
    namespaced,
    { type: "response.completed", response: { id: "r", output: [call] } },
  ]
    .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  const restorer = new SearchCallRestorer("sse");
  const bytes = Buffer.from(frames);
  let out = "";
  for (let index = 0; index < bytes.length; index += 23)
    out += restorer.push(bytes.subarray(index, index + 23));
  out += restorer.end();
  const seen = events(out);
  assert.deepEqual(seen[0]!.item, { ...search, arguments: {} });
  assert.deepEqual(seen[1], other);
  assert.deepEqual(seen[2]!.item, search);
  assert.deepEqual(
    seen[3],
    namespaced,
    "a namespaced tool is the client's own",
  );
  assert.deepEqual((seen[4]!.response as Record<string, unknown>).output, [
    search,
  ]);
  assert.match(out, /^event: response\.output_item\.added\ndata: /);
  assert.ok(
    out.includes(
      `event: response.output_text.delta\ndata: ${JSON.stringify(other)}\n\n`,
    ),
    "events without a search call pass byte for byte",
  );
  const json = new SearchCallRestorer("json");
  const body = JSON.stringify({ id: "r", output: [call] });
  assert.deepEqual(JSON.parse(json.push(body) + json.end()), {
    id: "r",
    output: [search],
  });
  const plain = new SearchCallRestorer("json");
  assert.equal(plain.push('{"error":"x"}') + plain.end(), '{"error":"x"}');
});

void test("translated, the search is the function tool_search and the tools it found are offered from then on", () => {
  const translation = responsesToChat({
    model: "m",
    tools: [SHELL, SEARCH],
    input: [
      user("find"),
      CALL,
      OUTPUT,
      // Found again: offered once.
      { ...CALL, call_id: "call_s2" },
      { ...OUTPUT, call_id: "call_s2", tools: [ISSUE] },
    ],
  });
  const names = toolNames(translation.body.tools);
  const linear = toolAlias("list_teams", "mcp__linear");
  assert.deepEqual(names, [
    "shell",
    "tool_search",
    "create_issue",
    linear,
    toolAlias("get_team", "mcp__linear"),
  ]);
  assert.deepEqual(translation.tools.get("tool_search"), {
    name: "tool_search",
    custom: false,
    search: true,
  });
  assert.deepEqual(translation.tools.get(linear), {
    name: "list_teams",
    custom: false,
    namespace: "mcp__linear",
  });
  assert.deepEqual(translation.body.messages.slice(1, 3), [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_s1",
          type: "function",
          function: { name: "tool_search", arguments: '{"query":"issues"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_s1",
      content: `These tools are now available to call: create_issue, ${linear}, ${toolAlias("get_team", "mcp__linear")}`,
    },
  ]);
  // A search Codex does not run is still a hosted tool.
  assert.throws(
    () => responsesToChat({ tools: [{ ...SEARCH, execution: "server" }] }),
    /Hosted Responses tool tool_search is unsupported/,
  );
});

void test("Claude Code's tool_reference results say the tool is loaded; its placeholder tool is not offered", () => {
  const translation = anthropicToChat({
    model: "m",
    max_tokens: 100,
    tools: [
      { name: "ToolSearch", input_schema: { type: "object" } },
      {
        name: "mcp__github__create_issue",
        input_schema: { type: "object" },
        defer_loading: true,
      },
      { name: "DeferredToolPlaceholder", input_schema: { type: "object" } },
    ],
    messages: [
      { role: "user", content: "file an issue" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "ToolSearch",
            input: { query: "select:mcp__github__create_issue" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "Found 2 tools." },
              {
                type: "tool_reference",
                tool_name: "mcp__github__create_issue",
              },
              { type: "tool_reference", tool_name: "mcp__github__get_issue" },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(toolNames(translation.body.tools), [
    "ToolSearch",
    "mcp__github__create_issue",
  ]);
  assert.deepEqual(translation.body.messages.at(-1), {
    role: "tool",
    tool_call_id: "toolu_1",
    content:
      "Found 2 tools.\nTool mcp__github__create_issue is loaded and can be called now.\nTool mcp__github__get_issue is loaded and can be called now.",
  });
});
