// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import type { RunId, SessionId } from "@harnesshub/core/types";
import { resolveHandlerLimits } from "../src/limits.js";
import { createGatewayHandler, type ActiveSessionRun } from "../src/server.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  CHAT_TEXT,
  group,
  MemoryStore,
  provider,
  resolveSecret,
  send,
  until,
  upstream,
  type Reply,
} from "./shared-support.js";

const SESSION = "sess-1" as SessionId;

/** A handler with a sessions port whose active Run the test controls. */
async function mountSessions(t: test.TestContext, store: MemoryStore) {
  const state: {
    run: ActiveSessionRun | undefined;
    committed: ModelCallEntry[];
  } = {
    run: undefined,
    committed: [],
  };
  const handler = createGatewayHandler({
    store,
    resolveSecret,
    clock: Date.now,
    limits: resolveHandlerLimits(),
    sessions: {
      activeRun: (id) => (id === SESSION ? state.run : undefined),
      committed: (entry) => state.committed.push(entry),
    },
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const key = await addKey(store, [], {
    scope: { kind: "session", sessionId: SESSION },
  });
  return { handler, port: address.port, state, key };
}

void test("a session key needs its Session's active Run and is attributed to it", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  await store.putRouteGroup(group("default", ["prov/model-a"]));
  const { port, state, key } = await mountSessions(t, store);
  const chat = (model?: string) =>
    send(port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: {
        ...(model === undefined ? {} : { model }),
        messages: [{ role: "user", content: "hi" }],
      },
    });
  const idle = await chat("harnesshub-model");
  assert.equal(idle.status, 409);
  assert.equal(at(idle.json(), "error", "code"), "no_active_run");
  assert.equal(store.entries[0]!.rejectReason, "no_active_run");
  assert.equal(up.seen.length, 0);

  state.run = {
    runId: "run-1" as RunId,
    generation: 3,
    target: "group/default",
  };
  const alias = await chat("harnesshub-model");
  assert.equal(alias.status, 200);
  assert.equal(up.seen[0]!.json().model, "model-a");
  for (const model of [undefined, "claude-3-5-haiku-latest"])
    assert.equal((await chat(model)).status, 200);
  const outside = await chat("prov/model-b");
  assert.equal(
    outside.status,
    403,
    "Model Refs outside the Run's target stay forbidden",
  );
  const calls = store.entries.filter((entry) => !entry.rejected);
  assert.equal(calls.length, 3);
  for (const entry of calls) {
    assert.equal(entry.sessionId, SESSION);
    assert.equal(entry.runId, "run-1");
    assert.equal(entry.generation, 3);
    assert.equal(entry.group, "default");
    assert.equal(entry.modelRef, "prov/model-a");
  }
  assert.deepEqual(
    calls.map((entry) => entry.requestedModel),
    ["harnesshub-model", undefined, "claude-3-5-haiku-latest"],
  );
  assert.equal(
    store.entries.at(-1)!.runId,
    "run-1",
    "a refused call of the Run is attributed to it",
  );
  assert.equal(
    state.committed.length,
    5,
    "every committed session entry reaches the observer",
  );

  state.run = undefined;
  assert.equal(
    (await chat("harnesshub-model")).status,
    409,
    "after the Run ended",
  );
});

void test("Gemini and Anthropic engines reach the target through the alias; /v1/models describes it", async (t) => {
  const up = await upstream(t, (response, seen) =>
    (seen.url.includes("chat") ? CHAT_REPLY : CHAT_REPLY)(
      response,
      seen,
      undefined as never,
    ),
  );
  const store = new MemoryStore();
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const { port, state, key } = await mountSessions(t, store);
  state.run = {
    runId: "run-2" as RunId,
    generation: 1,
    target: "prov/model-a",
  };
  const gemini = await send(
    port,
    `/v1beta/models/harnesshub-model:generateContent?key=${key.text}`,
    {
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    },
  );
  assert.equal(gemini.status, 200);
  assert.equal(gemini.json().modelVersion, "harnesshub-model");
  const anthropic = await send(port, "/v1/messages", {
    headers: { "x-api-key": key.text },
    body: {
      model: "harnesshub-model",
      max_tokens: 9,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(anthropic.json().model, "harnesshub-model");
  const models = await send(port, "/v1/models", {
    headers: { authorization: `Bearer ${key.text}` },
  });
  const data = models.json().data as Record<string, unknown>[];
  assert.deepEqual(
    data.map((model) => model.id),
    ["harnesshub-model", "prov/model-a"],
  );
  assert.equal(data[0]!.context_window, 128_000);
  assert.equal(data[0]!.context_length, 128_000);
  assert.equal(data[0]!.max_output_tokens, 8_192);
  state.run = undefined;
  const between = await send(port, "/v1/models", {
    headers: { authorization: `Bearer ${key.text}` },
  });
  assert.deepEqual(between.json().data, []);
});

void test("awaitSessionIdle waits for in-flight calls and their commits, or cancels them first", async (t) => {
  const gates: (() => void)[] = [];
  const release = () => gates.shift()?.();
  const slow: Reply = (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(CHAT_TEXT.split("\n\n")[1]! + "\n\n");
    gates.push(() => response.end(CHAT_TEXT));
  };
  const up = await upstream(t, slow);
  const store = new MemoryStore();
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const { handler, port, state, key } = await mountSessions(t, store);
  state.run = {
    runId: "run-3" as RunId,
    generation: 1,
    target: "prov/model-a",
  };
  const call = () =>
    send(port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: {
        model: "harnesshub-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    }).catch(() => undefined);
  const first = call();
  await until(() => up.seen.length === 1);
  let idle = false;
  const waiting = handler.awaitSessionIdle(SESSION).then(() => (idle = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(idle, false, "a call is still in flight");
  release();
  await waiting;
  assert.equal(
    store.entries.length,
    1,
    "the call was committed before the barrier resolved",
  );
  assert.equal(store.entries[0]!.status, 200);
  await first;

  const second = call();
  await until(() => up.seen.length === 2);
  await handler.awaitSessionIdle(SESSION, { abort: true });
  assert.equal(store.entries.length, 2);
  assert.equal(store.entries[1]!.status, 499);
  assert.equal(store.entries[1]!.errorClass, "client_cancelled");
  await second;
  await handler.awaitSessionIdle("other" as SessionId);
});

void test("a provider without credentials is reached without authentication", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(
    provider("local", { chat: `${up.base}/v1` }, { secrets: [] }),
  );
  const key = await addKey(store, ["local/*"]);
  const { port } = await mountSessions(t, store);
  const answer = await send(port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "local/model-a",
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(answer.status, 200);
  assert.equal(up.seen[0]!.headers.authorization, undefined);
  assert.equal(store.entries[0]!.credentialId, "keyless");
});
