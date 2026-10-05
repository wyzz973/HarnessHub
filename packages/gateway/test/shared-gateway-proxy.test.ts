// SPDX-License-Identifier: MIT
/**
 * The daemon's outbound proxy as the shared gateway sees it: every upstream
 * request goes through the injected fetch with the provider's own proxy, and
 * a failed proxy is a `proxy_failed` attempt that fails over without resting
 * the credential.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PROXY_FAILED, type OutboundFetch } from "@harnesshub/core/outbound";
import { classify, type AttemptError } from "../src/routing.js";
import { webSearch } from "../src/search.js";
import {
  addKey,
  CHAT_REPLY,
  group,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

const MESSAGES = [{ role: "user", content: "hi" }];

/**
 * What undici's fetch rejects with when the daemon's proxy fails: the
 * message for the daemon's log, and the brief one for callers.
 */
function proxyDown(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(
      new Error(
        "The proxy http://127.0.0.1:7890 could not be reached: connect ECONNREFUSED 127.0.0.1:7890",
      ),
      {
        code: PROXY_FAILED,
        brief: "The outbound proxy could not be reached",
      },
    ),
  });
}

void test("a failed proxy fails over at once and rests nothing; other connection failures are retried and counted", () => {
  const attempt = (kind?: "proxy"): AttemptError => ({
    failure: { status: 502, code: "x", message: "x", contextOverflow: false },
    errorClass: kind ? "proxy_failed" : "upstream_unreachable",
    source: kind ? "gateway" : "upstream",
    phase: "connect",
    ...(kind ? { kind } : {}),
  });
  assert.deepEqual(classify(attempt("proxy")), {
    retry: "no",
    failover: true,
    breaker: { kind: "none" },
  });
  assert.deepEqual(classify(attempt()), {
    retry: "yes",
    failover: true,
    breaker: { kind: "count" },
  });
});

void test("upstream requests go through the outbound fetch with the provider's own proxy; a proxy failure is proxy_failed and fails over", async (t) => {
  const near = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  // "far" is reachable only through a proxy that is down.
  await store.putProvider(provider("far", { chat: "https://far.example/v1" }));
  await store.putProvider(
    provider("near", { chat: `${near.base}/v1` }, { proxy: "direct" }),
  );
  await store.putRouteGroup(group("both", ["far/model-a", "near/model-a"]));
  const key = await addKey(store, ["far/*", "group/both"]);
  const sent: { url: string; proxy?: string }[] = [];
  const outbound: OutboundFetch = async (input, init, options) => {
    const url = String(input);
    sent.push({ url, ...(options?.proxy ? { proxy: options.proxy } : {}) });
    if (url.startsWith("https://far.example")) throw proxyDown();
    return fetch(input, init);
  };
  const gw = await mount(t, store, {}, { fetch: outbound });
  const ask = (model: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: MESSAGES },
    });
  const answer = await ask("group/both");
  assert.equal(answer.status, 200);
  assert.deepEqual(sent, [
    { url: "https://far.example/v1/chat/completions" },
    { url: `${near.base}/v1/chat/completions`, proxy: "direct" },
  ]);
  const [entry] = (await store.listModelCalls()).items;
  assert.deepEqual(
    entry!.attempts.map((item) => [
      item.provider,
      item.errorClass,
      item.decision,
    ]),
    [
      ["far", "proxy_failed", "failover"],
      ["near", undefined, "success"],
    ],
  );
  // Alone, the proxy's failure is the answer: 502, said briefly (the
  // proxy's address is for the daemon's log), and never a rest.
  for (let round = 0; round < 4; round++) {
    const alone = await ask("far/model-a");
    assert.equal(alone.status, 502);
    const error = alone.json().error as { code?: string; message: string };
    assert.equal(error.code, "proxy_failed");
    assert.equal(error.message, "The outbound proxy could not be reached");
    assert.ok(!alone.text.includes("7890"), alone.text);
  }
  const calls = (await store.listModelCalls()).items;
  assert.equal(calls.at(-1)!.errorClass, "proxy_failed");
  assert.equal(calls.at(-1)!.attempts.length, 1, "not retried");
  const state = gw.handler
    .routingState()
    .find((item) => item.provider === "far");
  assert.ok(!state || state.state === "closed", JSON.stringify(state));
});

void test("the Codex passthrough and its model list go out through the outbound fetch; a failed proxy is named", async (t) => {
  const chatgpt = await upstream(t, (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [] }));
  });
  const store = new MemoryStore();
  let down = false;
  const sent: string[] = [];
  const outbound: OutboundFetch = async (input, init) => {
    const url = String(input);
    sent.push(url);
    if (down) throw proxyDown();
    // chatgpt.upstream.test exists only behind the (here simulated) proxy.
    return fetch(
      url.replace("https://chatgpt.upstream.test", chatgpt.base),
      init,
    );
  };
  const gw = await mount(
    t,
    store,
    {},
    {
      fetch: outbound,
      codexBackend: "https://chatgpt.upstream.test/backend-api/codex",
    },
  );
  const headers = {
    authorization: "Bearer synthetic-chatgpt-token",
    "user-agent": "codex_cli_rs/0.150.0",
  };
  const listed = await send(
    gw.port,
    "/backend-api/codex/models?client_version=0.150.0",
    { headers },
  );
  assert.equal(listed.status, 200, listed.text);
  const relayed = await send(gw.port, "/backend-api/codex/responses", {
    headers,
    body: { model: "gpt-5.1-codex", stream: false, input: "hi" },
  });
  assert.equal(relayed.status, 200, relayed.text);
  assert.deepEqual(sent, [
    "https://chatgpt.upstream.test/backend-api/codex/models?client_version=0.150.0",
    "https://chatgpt.upstream.test/backend-api/codex/responses",
  ]);
  down = true;
  for (const path of [
    "/backend-api/codex/models",
    "/backend-api/codex/responses",
  ]) {
    const failed = await send(gw.port, path, {
      headers,
      ...(path.endsWith("responses")
        ? { body: { model: "gpt-5.1-codex", stream: false, input: "hi" } }
        : {}),
    });
    assert.equal(failed.status, 502, path);
    assert.equal(
      (failed.json().error as { code: string }).code,
      "proxy_failed",
      path,
    );
    assert.match(failed.text, /The outbound proxy could not be reached/);
    assert.ok(!failed.text.includes("7890"), failed.text);
  }
  assert.equal(store.entries.at(-1)!.errorClass, "proxy_failed");
});

void test("web search backends are asked through the outbound fetch, and a failed proxy is the reason given, briefly", async () => {
  const sent: string[] = [];
  const answer = await webSearch(
    "weather in Paris",
    [
      {
        id: "search-1",
        kind: "searxng",
        baseUrl: "https://search.upstream.test",
      },
    ],
    async () => "",
    new AbortController().signal,
    async (input) => {
      sent.push(String(input));
      throw proxyDown();
    },
  );
  assert.match(sent[0]!, /^https:\/\/search\.upstream\.test\/search\?/);
  // The model reads this: no address, nothing the proxy wrote.
  assert.deepEqual(answer, {
    error: "searxng: The outbound proxy could not be reached",
  });
});
