// SPDX-License-Identifier: MIT
/**
 * Web search emulation: a client's server-side web search, answered by the
 * gateway with a registered search API for an upstream that cannot run it.
 * Loopback fakes only: no real search API is called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { GatewayFeatures } from "@harnesshub/core/gateway-features";
import type { CredentialId } from "@harnesshub/core/model-plane";
import { readHits, searchesNatively } from "../src/search.js";
import type { Candidate } from "../src/routing.js";
import {
  addKey,
  at,
  chatChunks,
  delta,
  MemoryStore,
  mount,
  provider,
  send,
  SECRETS,
  upstream,
  until,
  type Reply,
} from "./shared-support.js";

const SEARCH_KEY = SECRETS["key-c"]!;

/** A Tavily-shaped search API on loopback. */
async function fakeTavily(t: test.TestContext) {
  const seen: { query: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        query: string;
      };
      seen.push({
        query: body.query,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "HarnessHub <strong>1.0</strong>",
              url: "https://example.com/release",
              content: "HarnessHub 1.0 shipped on October 1.",
            },
            { title: "Docs", url: "https://example.com/docs", content: "" },
          ],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, seen };
}

/** A Chat answer that calls the search tool. */
const searchCall: Reply = (response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    chatChunks([
      delta({ role: "assistant", content: "Let me check. " }),
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_s1",
            type: "function",
            function: {
              name: "web_search",
              arguments: '{"query":"harnesshub release"}',
            },
          },
        ],
      }),
      delta({}, "tool_calls"),
      {
        id: "u",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      },
    ]),
  );
};
const answer: Reply = (response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    chatChunks([
      delta({ content: "HarnessHub 1.0 shipped on October 1." }, "stop"),
      {
        id: "u",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 200, completion_tokens: 12, total_tokens: 212 },
      },
    ]),
  );
};

function setup(t: test.TestContext, ...replies: Reply[]) {
  return setupWith(t, {}, ...replies);
}

async function setupWith(
  t: test.TestContext,
  options: {
    key?: Parameters<typeof addKey>[2];
    limits?: Record<string, number>;
  },
  ...replies: Reply[]
) {
  const search = await fakeTavily(t);
  const up = await upstream(t, ...replies);
  const store = new MemoryStore();
  await store.putProvider(provider("chat", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["chat/*"], options.key);
  const features: GatewayFeatures = {
    schemaVersion: 1,
    redaction: { enabled: true, rules: [] },
    search: {
      backends: [
        {
          id: "search-1",
          kind: "tavily",
          credential: { kind: "env", value: "key-c" },
          baseUrl: search.base,
        },
      ],
    },
  };
  let on = true;
  const gw = await mount(t, store, options.limits ?? {}, {
    features: () =>
      on ? features : { schemaVersion: 1, redaction: features.redaction },
  });
  return { search, up, store, key, gw, off: () => (on = false) };
}

void test("an Anthropic web search becomes the gateway's search, shown as server tool blocks", async (t) => {
  const { search, up, store, key, gw } = await setup(t, searchCall, answer);
  const body = {
    model: "chat/model-a",
    max_tokens: 100,
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: "When was HarnessHub 1.0 released?" }],
  };
  const reply = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body,
  });
  assert.equal(reply.status, 200);
  // The search API got the model's query, with its key.
  assert.deepEqual(search.seen, [
    { query: "harnesshub release", authorization: `Bearer ${SEARCH_KEY}` },
  ]);
  // The upstream got a function tool, then the results as a tool message.
  assert.equal(
    at(up.seen[0]!.json(), "tools", 0, "function", "name"),
    "web_search",
  );
  const second = up.seen[1]!.json();
  const messages = second.messages as Record<string, unknown>[];
  assert.equal(messages.at(-1)!.role, "tool");
  assert.match(
    String(messages.at(-1)!.content),
    /1\. HarnessHub 1\.0 — https:\/\/example\.com\/release/,
  );
  // The client sees its vendor's own search blocks, never the function tool.
  assert.match(reply.text, /"type":"server_tool_use","id":"srvtoolu_hh_/);
  assert.match(
    reply.text,
    /"partial_json":"\{\\"query\\":\\"harnesshub release\\"\}"/,
  );
  assert.match(reply.text, /"type":"web_search_tool_result"/);
  assert.match(reply.text, /"url":"https:\/\/example\.com\/release"/);
  assert.ok(!reply.text.includes('"type":"tool_use"'));
  assert.match(reply.text, /Let me check\. /);
  assert.match(reply.text, /\\n\\nHarnessHub 1\.0 shipped/);
  assert.match(reply.text, /"stop_reason":"end_turn"/);
  await until(() => store.entries.length === 1);
  const entry = store.entries[0]!;
  assert.ok(entry.patches.includes("search:emulated"));
  assert.ok(entry.patches.includes("search:rounds:1"));
  assert.equal(entry.usage?.output, 22, "both rounds are counted");

  // The history with the gateway's blocks goes back as text.
  const history = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: {
      ...body,
      stream: false,
      messages: [
        ...body.messages,
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_hh_x_0",
              name: "web_search",
              input: { query: "harnesshub release" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_hh_x_0",
              content: [
                {
                  type: "web_search_result",
                  title: "Rel",
                  url: "https://example.com/release",
                  encrypted_content: "",
                },
              ],
            },
            { type: "text", text: "It shipped on October 1." },
          ],
        },
        { role: "user", content: "Thanks" },
      ],
    },
  });
  assert.equal(history.status, 200);
  const sent = JSON.stringify(up.seen[2]!.json());
  assert.match(sent, /\[Searched the web for: harnesshub release\]/);
  assert.match(sent, /- Rel — https:\/\/example\.com\/release/);
});

void test("a Responses web search is a web_search_call item with its sources; without a backend nothing changes", async (t) => {
  const { up, key, gw, off } = await setup(t, searchCall, answer);
  const reply = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "chat/model-a",
      input: "When was HarnessHub 1.0 released?",
      tools: [{ type: "web_search" }],
    },
  });
  assert.equal(reply.status, 200);
  const output = reply.json().output as Record<string, unknown>[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["web_search_call", "message"],
  );
  assert.match(String(output[0]!.id), /^ws_hh_/);
  assert.deepEqual(output[0]!.action, {
    type: "search",
    query: "harnesshub release",
    sources: [
      { type: "url", url: "https://example.com/release" },
      { type: "url", url: "https://example.com/docs" },
    ],
  });
  assert.equal(up.seen.length, 2);
  off();
  const refused = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "chat/model-a",
      input: "hi",
      tools: [{ type: "web_search" }],
    },
  });
  assert.equal(refused.status, 400);
  assert.match(
    String(at(refused.json(), "error", "message")),
    /Hosted Responses tool web_search is unsupported/,
  );
  assert.equal(up.seen.length, 2);
});

void test("searches stop after six rounds: the model is told so and answers", async (t) => {
  const { search, up, store, key, gw } = await setup(t, searchCall);
  const reply = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: {
      model: "chat/model-a",
      max_tokens: 100,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "Search forever" }],
    },
  });
  assert.equal(reply.status, 200);
  assert.equal(search.seen.length, 6);
  assert.equal(up.seen.length, 8);
  const last = up.seen[7]!.json().messages as Record<string, unknown>[];
  assert.match(String(last.at(-1)!.content), /No more searches/);
  await until(() => store.entries.length === 1);
  assert.ok(store.entries[0]!.patches.includes("search:rounds:7"));
});

/** A Chat answer that calls the search tool `n` times at once. */
const searchCalls =
  (n: number): Reply =>
  (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chatChunks([
        delta({
          role: "assistant",
          tool_calls: Array.from({ length: n }, (_, index) => ({
            index,
            id: `call_s${index}`,
            type: "function",
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: `query ${index}` }),
            },
          })),
        }),
        delta({}, "tool_calls"),
      ]),
    );
  };

const searchForever = (gw: { port: number }, key: { text: string }) =>
  send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: {
      model: "chat/model-a",
      max_tokens: 100,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "Search everything" }],
    },
  });

void test("at most maxSearchesPerRound searches a round and maxSearchesPerRequest a request run; the model is told, the ledger counts them", async (t) => {
  const { search, up, store, key, gw } = await setup(t, searchCalls(8));
  const reply = await searchForever(gw, key);
  assert.equal(reply.status, 200, reply.text);
  // 5 of the 8 in each of the first four rounds, then none: 20 in all.
  assert.equal(search.seen.length, 20);
  const second = up.seen[2]!.json().messages as Record<string, unknown>[];
  assert.match(String(second.at(-1)!.content), /at most 5 searches at once/);
  const fifth = up.seen[5]!.json().messages as Record<string, unknown>[];
  assert.match(String(fifth.at(-8)!.content), /No more searches/);
  await until(() => store.entries.length === 1);
  const patches = store.entries[0]!.patches;
  assert.ok(patches.includes("search:queries:20"), patches.join());
  assert.ok(patches.includes("search:refused:28"), patches.join());
});

void test("each search takes a request of the key's per-minute bucket; without one it is not run", async (t) => {
  const { search, up, store, key, gw } = await setupWith(
    t,
    { key: { quota: { requestsPerMinute: 3 } } },
    searchCalls(4),
  );
  const reply = await searchForever(gw, key);
  assert.equal(reply.status, 200, reply.text);
  // The call took one request; two searches took the others.
  assert.equal(search.seen.length, 2);
  const second = up.seen[1]!.json().messages as Record<string, unknown>[];
  assert.match(
    String(second.at(-1)!.content),
    /Not run: This Gateway Key is limited to 3 requests per minute/,
  );
  await until(() => store.entries.length === 1);
  assert.ok(store.entries[0]!.patches.includes("search:queries:2"));
});

void test("search APIs' answers are read per vendor, and only some hosts search themselves", () => {
  assert.deepEqual(
    readHits("brave", {
      web: {
        results: [
          { title: "<b>A</b> &amp; B", url: "https://a", description: "x" },
        ],
      },
    }),
    [{ title: "A & B", url: "https://a", text: "x" }],
  );
  assert.deepEqual(
    readHits("firecrawl", {
      data: { web: [{ url: "https://f", markdown: "m" }] },
    }),
    [{ title: "https://f", url: "https://f", text: "m" }],
  );
  assert.deepEqual(readHits("exa", { results: [{ url: "", text: "t" }] }), []);
  const candidate = (endpoint: string, mode: Candidate["mode"]) =>
    ({
      provider: provider("p", {}),
      credential: {
        id: "c" as CredentialId,
        name: "c",
        ref: { kind: "env", value: "k" },
        enabled: true,
      },
      model: undefined,
      ref: "p/m",
      wireModel: "m",
      mode,
      upstream: "anthropic",
      endpoint,
    }) as Candidate;
  assert.ok(
    searchesNatively(
      candidate("https://api.anthropic.com", "passthrough"),
      "anthropic",
    ),
  );
  assert.ok(
    !searchesNatively(
      candidate("https://api.deepseek.com/anthropic", "passthrough"),
      "anthropic",
    ),
  );
  assert.ok(
    !searchesNatively(
      candidate("https://api.anthropic.com", "translated"),
      "anthropic",
    ),
  );
});
