// SPDX-License-Identifier: MIT
/** The Codex passthrough: `/backend-api/codex/*` to ChatGPT's Codex backend, here a loopback fake. */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import { issueGatewayKey } from "@harnesshub/core/model-plane";
import { isModelCallEntry } from "@harnesshub/core/model-plane-records";
import { CODEX_SUMMARY_PREFIX } from "../src/compacting.js";
import { encodeReasoning } from "../src/reasoning.js";
import { isGatewayPath } from "../src/server.js";
import {
  addKey,
  at,
  json,
  MemoryStore,
  mount,
  provider,
  SECRETS,
  send,
  until,
  upstream,
  type Reply,
} from "./shared-support.js";

/** A synthetic ChatGPT sign-in; it must never reach the ledger or the log. */
const TOKEN = "synthetic-chatgpt-access-token.Zx81_canary-4f2e";
const ACCOUNT = "acct-synthetic-77";
const BODY = {
  model: "gpt-5.1-codex",
  stream: true,
  instructions: "You are Codex.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ],
  prompt_cache_key: "codex-conversation-1",
};
const COMPLETED = {
  type: "response.completed",
  sequence_number: 3,
  response: {
    id: "resp_1",
    object: "response",
    model: "gpt-5.1-codex",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 57,
    },
  },
};
const EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: { id: "resp_1", model: "gpt-5.1-codex", status: "in_progress" },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 1,
    item_id: "msg_1",
    delta: "Hi",
  },
  {
    type: "response.output_text.done",
    sequence_number: 2,
    item_id: "msg_1",
    text: "Hi",
  },
  COMPLETED,
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

const streamed: Reply = (response) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "x-codex-primary-used-percent": "12",
  });
  response.end(EVENTS);
};

function capture(): LogSink & { text(): string } {
  const records: [string, LogFields | undefined][] = [];
  return {
    level: "debug",
    info: (event, fields) => void records.push([event, fields]),
    debug: (event, fields) => void records.push([event, fields]),
    text: () => JSON.stringify(records),
  };
}

async function setup(t: test.TestContext, ...replies: Reply[]) {
  const chatgpt = await upstream(t, ...replies);
  const store = new MemoryStore();
  const log = capture();
  const gw = await mount(
    t,
    store,
    {},
    { log, codexBackend: `${chatgpt.base}/chatgpt/backend-api/codex` },
  );
  return { chatgpt, store, log, gw };
}

const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  "chatgpt-account-id": ACCOUNT,
  originator: "codex_cli_rs",
  session_id: "sess-synthetic-1",
  "user-agent": "codex_cli_rs/0.150.0 (Mac OS 15.6.1; arm64) Apple_Terminal",
  "x-hh-credential": "cred-0",
  "x-hh-conversation": "local-name",
};

void test("Codex's own request reaches ChatGPT unchanged, credentials byte for byte, and is recorded", async (t) => {
  const { chatgpt, store, log, gw } = await setup(t, streamed);
  assert.ok(isGatewayPath("/backend-api/codex/responses"));
  const answer = await send(gw.port, "/backend-api/codex/responses?beta=1", {
    headers: HEADERS,
    body: BODY,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.text, EVENTS, "the stream is passed on byte for byte");
  assert.equal(answer.headers["x-codex-primary-used-percent"], "12");
  const seen = chatgpt.seen[0]!;
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/chatgpt/backend-api/codex/responses?beta=1");
  assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.headers["chatgpt-account-id"], ACCOUNT);
  assert.equal(seen.headers.originator, "codex_cli_rs");
  assert.equal(seen.headers.session_id, "sess-synthetic-1");
  assert.equal(seen.headers["user-agent"], HEADERS["user-agent"]);
  assert.equal(seen.headers["x-hh-credential"], undefined);
  assert.equal(seen.headers["x-hh-conversation"], undefined);
  assert.deepEqual(seen.json(), BODY);
  const entry = store.entries[0]!;
  assert.equal(store.entries.length, 1);
  assert.ok(isModelCallEntry(entry));
  assert.equal(entry.keyId, undefined);
  assert.equal(entry.scope, undefined);
  assert.deepEqual(
    {
      provider: entry.provider,
      modelRef: entry.modelRef,
      requestedModel: entry.requestedModel,
      servedModel: entry.servedModel,
      agent: entry.agent,
      inbound: entry.inbound,
      mode: entry.mode,
      status: entry.status,
      completion: entry.completion,
      finishReason: entry.finishReason,
      usage: entry.usage,
      cost: entry.cost,
    },
    {
      provider: "chatgpt-subscription",
      modelRef: "chatgpt-subscription/gpt-5.1-codex",
      requestedModel: "gpt-5.1-codex",
      servedModel: "gpt-5.1-codex",
      agent: { id: "codex", source: "route" },
      inbound: {
        protocol: "responses",
        path: "/backend-api/codex/responses",
        stream: true,
      },
      mode: "passthrough",
      status: 200,
      completion: "explicit",
      finishReason: "stop",
      usage: {
        input: 40,
        cacheRead: 10,
        cacheWrite: 0,
        output: 5,
        reasoning: 2,
        source: "reported",
      },
      cost: null,
    },
  );
  assert.match(entry.conversationKey!, /^[0-9a-f]{64}$/);
  assert.ok(entry.timing.firstContentMs !== undefined);
  for (const text of [JSON.stringify(store.entries), log.text()]) {
    assert.ok(!text.includes(TOKEN), "the sign-in token is never kept");
    assert.ok(!text.includes("codex-conversation-1"));
  }
});

void test("a tool turn whose response.completed lists no output is recorded as tool_calls", async (t) => {
  // ChatGPT's backend streams the call as items and ends with an empty output.
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "shell",
    arguments: '{"command":["ls"]}',
  };
  const events = [
    { type: "response.output_item.added", sequence_number: 1, item: call },
    { type: "response.output_item.done", sequence_number: 2, item: call },
    COMPLETED,
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  const { store, gw } = await setup(t, (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events);
  });
  const answer = await send(gw.port, "/backend-api/codex/responses", {
    headers: HEADERS,
    body: BODY,
  });
  assert.equal(answer.text, events);
  const entry = store.entries[0]!;
  assert.ok(isModelCallEntry(entry));
  assert.equal(entry.finishReason, "tool_calls");
});

void test("the terminal event waits for the ledger commit", async (t) => {
  const { store, gw } = await setup(t, streamed);
  let release!: () => void;
  store.appendGate = new Promise<void>((resolve) => (release = resolve));
  const response = await fetch(`${gw.base}/backend-api/codex/responses`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
  const reader = response.body!.getReader();
  let text = "";
  while (!text.includes("response.output_text.done")) {
    const { value, done } = await reader.read();
    assert.ok(!done);
    text += new TextDecoder().decode(value);
  }
  await until(() => store.appendStarted === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotMatch(text, /response\.completed/);
  release();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.equal(text, EVENTS);
  store.failAppend = true;
  const withheld = await send(gw.port, "/backend-api/codex/responses", {
    headers: HEADERS,
    body: BODY,
  });
  assert.equal(withheld.status, 200);
  assert.doesNotMatch(withheld.text, /"type":"response\.completed"/);
  assert.match(withheld.text, /evidence_unavailable/);
});

void test("upstream refusals pass through as they are, and the ledger keeps a redacted message", async (t) => {
  const refusal = {
    error: {
      type: "usage_limit_reached",
      message: `The usage limit has been reached for Bearer ${TOKEN}`,
      resets_in_seconds: 3600,
    },
  };
  const { store, log, gw } = await setup(t, json(429, refusal));
  const answer = await send(gw.port, "/backend-api/codex/responses", {
    headers: HEADERS,
    body: BODY,
  });
  assert.equal(answer.status, 429);
  assert.deepEqual(answer.json(), refusal);
  const entry = store.entries[0]!;
  assert.deepEqual(
    [entry.status, entry.errorClass, entry.errorSource],
    [429, "quota_exhausted", "upstream"],
  );
  for (const text of [JSON.stringify(store.entries), log.text()])
    assert.ok(!text.includes(TOKEN));
});

void test("non-streamed calls are recorded too, and requests that are no model call are only relayed", async (t) => {
  const models = { models: [{ slug: "gpt-5.1-codex" }] };
  const { chatgpt, store, gw } = await setup(
    t,
    json(200, COMPLETED.response),
    json(200, models),
  );
  const compact = await send(gw.port, "/backend-api/codex/responses/compact", {
    headers: HEADERS,
    body: { ...BODY, stream: false },
  });
  assert.equal(compact.status, 200);
  assert.deepEqual(compact.json(), COMPLETED.response);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0]!.usage?.output, 5);
  assert.equal(store.entries[0]!.inbound.stream, false);
  const listed = await send(
    gw.port,
    "/backend-api/codex/models?client_version=0.150.0",
    { headers: HEADERS },
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json(), models);
  assert.equal(chatgpt.seen[1]!.method, "GET");
  assert.equal(
    chatgpt.seen[1]!.url,
    "/chatgpt/backend-api/codex/models?client_version=0.150.0",
  );
  assert.equal(chatgpt.seen[1]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(store.entries.length, 1, "no ledger entry for a model list");
});

void test("a HarnessHub model's /responses/compact is refused here, and what the gateway summarized or encoded reaches ChatGPT as text or not at all", async (t) => {
  const { chatgpt, store, gw } = await setup(t, streamed);
  const compact = await send(gw.port, "/backend-api/codex/responses/compact", {
    headers: HEADERS,
    body: { ...BODY, model: "deepseek/deepseek-chat", stream: false },
  });
  assert.equal(compact.status, 400);
  assert.equal(at(compact.json(), "error", "code"), "compact_unsupported");
  assert.equal(
    at(compact.json(), "error", "message"),
    "/responses/compact is not supported for HarnessHub models; use a compaction_trigger on /responses",
  );
  assert.equal(chatgpt.seen.length, 0, "nothing went to ChatGPT");
  assert.deepEqual(
    [store.entries[0]!.status, store.entries[0]!.errorClass],
    [400, "compact_unsupported"],
  );
  const summary = "SUMMARY: the work so far.";
  const sealed = {
    type: "reasoning",
    id: "rs_up",
    summary: [],
    encrypted_content: "gAAAA-chatgpt",
  };
  const answer = await send(gw.port, "/backend-api/codex/responses", {
    headers: HEADERS,
    body: {
      ...BODY,
      input: [
        {
          type: "compaction",
          id: "cmp_hh",
          encrypted_content: `hh1:${Buffer.from(summary).toString("base64")}`,
        },
        {
          type: "reasoning",
          id: "rs_hh",
          summary: [],
          encrypted_content: encodeReasoning("translated"),
        },
        sealed,
        ...BODY.input,
      ],
    },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(chatgpt.seen[0]!.json().input, [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `${CODEX_SUMMARY_PREFIX}\n${summary}`,
        },
      ],
    },
    sealed,
    ...BODY.input,
  ]);
  assert.deepEqual(store.entries[1]!.patches, [
    "compaction:restored:1",
    "reasoning:dropped:1",
  ]);
});

void test("ChatGPT-mode Codex with its key in the path: HarnessHub's models are served here, Codex's own go to ChatGPT without the key, and the lists are merged", async (t) => {
  const answer = {
    id: "resp_hh",
    object: "response",
    status: "completed",
    model: "model-a",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "HH", annotations: [] }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const hh = await upstream(t, json(200, answer));
  const own = [{ slug: "gpt-5.1-codex", priority: 1 }];
  const chatgpt = await upstream(
    t,
    json(200, { models: own }, { etag: 'W/"chatgpt-1"' }),
    (response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-models-etag": 'W/"chatgpt-1"',
      });
      response.end(EVENTS);
    },
  );
  const store = new MemoryStore();
  store.providers.set("hh", provider("hh", { responses: `${hh.base}/v1` }));
  const key = await addKey(store, ["hh/*"], {
    scope: { kind: "agent", adapterId: "codex" },
  });
  const log = capture();
  const gw = await mount(
    t,
    store,
    {},
    {
      log,
      codexBackend: `${chatgpt.base}/chatgpt/backend-api/codex`,
      codexCatalog: (models, first) =>
        models.map((model, index) => ({ ...model, priority: first + index })),
    },
  );
  const base = `/backend-api/codex/${key.text}`;

  const listed = await send(gw.port, `${base}/models?client_version=0.150.0`, {
    headers: HEADERS,
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json().models, [
    ...own,
    {
      slug: "hh/model-a",
      contextWindow: 128_000,
      efforts: ["low", "medium", "high"],
      images: false,
      priority: 2,
    },
    { slug: "hh/model-b", efforts: [], images: false, priority: 3 },
  ]);
  const etag = String(listed.headers.etag);
  assert.match(etag, /^W\/"chatgpt-1\+hh-[0-9a-f]{12}"$/);
  assert.equal(
    chatgpt.seen[0]!.url,
    "/chatgpt/backend-api/codex/models?client_version=0.150.0",
  );
  assert.equal(chatgpt.seen[0]!.headers.authorization, `Bearer ${TOKEN}`);

  // Codex's own model: relayed without the key, its models tag the same.
  const relayed = await send(gw.port, `${base}/responses`, {
    headers: HEADERS,
    body: BODY,
  });
  assert.equal(relayed.status, 200);
  assert.equal(relayed.text, EVENTS);
  assert.equal(relayed.headers["x-models-etag"], etag);
  assert.equal(chatgpt.seen[1]!.url, "/chatgpt/backend-api/codex/responses");
  assert.deepEqual(chatgpt.seen[1]!.json(), BODY);

  // HarnessHub's model: served here; the ChatGPT sign-in goes nowhere.
  const served = await send(gw.port, `${base}/responses`, {
    headers: HEADERS,
    body: { ...BODY, model: "hh/model-a", stream: false },
  });
  assert.equal(served.status, 200, served.text);
  assert.equal(at(served.json(), "output", 0, "content", 0, "text"), "HH");
  assert.equal(chatgpt.seen.length, 2);
  const upstreamSeen = hh.seen[0]!;
  assert.equal(upstreamSeen.json().model, "model-a");
  assert.equal(
    upstreamSeen.headers.authorization,
    `Bearer ${SECRETS["key-a"]}`,
  );
  assert.equal(upstreamSeen.headers["chatgpt-account-id"], undefined);
  assert.ok(!JSON.stringify(upstreamSeen.headers).includes(TOKEN));
  const entry = store.entries.at(-1)!;
  assert.ok(isModelCallEntry(entry));
  assert.deepEqual(
    [
      entry.keyId,
      entry.inbound.path,
      entry.provider,
      entry.modelRef,
      entry.status,
      entry.agent,
    ],
    [
      key.keyId,
      "/backend-api/codex/responses",
      "hh",
      "hh/model-a",
      200,
      { id: "codex", source: "key" },
    ],
  );

  // Without its key, a HarnessHub model fails here and never goes to ChatGPT.
  const keyless = await send(gw.port, "/backend-api/codex/responses", {
    headers: HEADERS,
    body: { ...BODY, model: "hh/model-a" },
  });
  assert.equal(keyless.status, 401);
  assert.equal(at(keyless.json(), "error", "code"), "invalid_key");
  assert.match(
    String(at(keyless.json(), "error", "message")),
    /wire Codex again/,
  );
  assert.equal(chatgpt.seen.length, 2);
  assert.equal(hh.seen.length, 1);
  for (const text of [JSON.stringify(store.entries), log.text()]) {
    assert.ok(!text.includes(key.text), "the key is never kept");
    assert.ok(!text.includes(TOKEN), "the sign-in token is never kept");
  }
});

void test("a key in the path that is wrong or revoked is refused here for every request, without the path in the answer", async (t) => {
  const chatgpt = await upstream(t, json(200, { models: [] }));
  const store = new MemoryStore();
  const revoked = await addKey(store, ["*"], {
    scope: { kind: "agent", adapterId: "codex" },
    revokedAt: "2026-10-01T00:00:00.000Z",
  });
  // Well-formed, but no such key: a secret that does not match its hash.
  const wrong = revoked.text.replace(
    /_[A-Za-z0-9_-]{43}$/,
    `_${"A".repeat(43)}`,
  );
  const unknown = issueGatewayKey({ kind: "agent", adapterId: "codex" }).text;
  const log = capture();
  const gw = await mount(
    t,
    store,
    {},
    {
      log,
      codexBackend: `${chatgpt.base}/chatgpt/backend-api/codex`,
      codexCatalog: () => [{ slug: "never" }],
    },
  );
  for (const [text, code] of [
    [revoked.text, "key_revoked"],
    [wrong, "invalid_key"],
    [unknown, "invalid_key"],
  ] as const)
    for (const [path, body] of [
      ["models?client_version=0.150.0", undefined],
      ["responses", BODY],
      ["responses", { ...BODY, model: "group/default" }],
      ["responses/compact", BODY],
    ] as const) {
      const answer = await send(gw.port, `/backend-api/codex/${text}/${path}`, {
        headers: HEADERS,
        ...(body ? { body } : {}),
      });
      assert.equal(answer.status, 401, `${code} ${path}`);
      assert.equal(at(answer.json(), "error", "code"), code);
      assert.ok(!answer.text.includes(text), "the key is not echoed");
      assert.ok(!answer.text.includes("backend-api"), "nor is the path");
    }
  assert.equal(chatgpt.seen.length, 0, "nothing went to ChatGPT");
  assert.equal(store.entries.length, 12);
  assert.ok(
    store.entries.every(
      (entry) =>
        entry.rejected === true &&
        entry.status === 401 &&
        entry.inbound.path.startsWith("/backend-api/codex/") &&
        !entry.inbound.path.includes("hhk_"),
    ),
  );
  for (const text of [JSON.stringify(store.entries), log.text()])
    for (const secret of [revoked.text, wrong, unknown, TOKEN])
      assert.ok(!text.includes(secret));
});

void test("only loopback peers without a browser origin may use the passthrough", async (t) => {
  const { chatgpt, store, gw } = await setup(t, streamed);
  const browser = await send(gw.port, "/backend-api/codex/responses", {
    headers: { ...HEADERS, origin: "https://example.com" },
    body: BODY,
  });
  assert.equal(browser.status, 403);
  assert.equal(at(browser.json(), "error", "code"), "origin_forbidden");
  const host = await send(gw.port, "/backend-api/codex/responses", {
    headers: { ...HEADERS, host: "chatgpt.example" },
    body: BODY,
  });
  assert.equal(host.status, 403);
  const lan = createServer(gw.handler.lan);
  lan.listen(0, "127.0.0.1");
  await once(lan, "listening");
  t.after(() => {
    lan.closeAllConnections();
    lan.close();
  });
  const address = lan.address();
  assert.ok(address && typeof address !== "string");
  const shared = await send(address.port, "/backend-api/codex/responses", {
    headers: HEADERS,
    body: BODY,
  });
  assert.equal(shared.status, 403);
  assert.equal(at(shared.json(), "error", "code"), "source_not_allowed");
  // Nor with a key in the path, valid or not: it is not even looked at.
  const key = await addKey(store, ["*"], {
    scope: { kind: "agent", adapterId: "codex" },
  });
  const keyed = await send(
    address.port,
    `/backend-api/codex/${key.text}/responses`,
    { headers: HEADERS, body: { ...BODY, model: "group/default" } },
  );
  assert.equal(keyed.status, 403);
  assert.equal(at(keyed.json(), "error", "code"), "source_not_allowed");
  assert.ok(!keyed.text.includes(key.text));
  assert.equal(chatgpt.seen.length, 0);
  assert.deepEqual(
    store.entries.map((entry) => [
      entry.rejected,
      entry.rejectReason,
      entry.keyId,
      entry.inbound.path,
    ]),
    [
      [true, "origin_forbidden", undefined, "/backend-api/codex/responses"],
      [true, "origin_forbidden", undefined, "/backend-api/codex/responses"],
      [true, "source_not_allowed", undefined, "/backend-api/codex/responses"],
      [true, "source_not_allowed", undefined, "/backend-api/codex/responses"],
    ],
  );
  assert.ok(!JSON.stringify(store.entries).includes(TOKEN));
  assert.ok(!JSON.stringify(store.entries).includes(key.text));
});
