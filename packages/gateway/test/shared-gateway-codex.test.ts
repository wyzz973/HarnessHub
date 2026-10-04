// SPDX-License-Identifier: MIT
/** The Codex passthrough: `/backend-api/codex/*` to ChatGPT's Codex backend, here a loopback fake. */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import { isModelCallEntry } from "@harnesshub/core/model-plane-records";
import { CODEX_SUMMARY_PREFIX } from "../src/compacting.js";
import { encodeReasoning } from "../src/reasoning.js";
import { isGatewayPath } from "../src/server.js";
import {
  at,
  json,
  MemoryStore,
  mount,
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
  assert.equal(chatgpt.seen.length, 0);
  assert.deepEqual(
    store.entries.map((entry) => [entry.rejected, entry.rejectReason]),
    [
      [true, "origin_forbidden"],
      [true, "origin_forbidden"],
      [true, "source_not_allowed"],
    ],
  );
  assert.ok(!JSON.stringify(store.entries).includes(TOKEN));
});
