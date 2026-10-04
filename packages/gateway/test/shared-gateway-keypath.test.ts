// SPDX-License-Identifier: MIT
/**
 * Gateway Keys in the path, `/k/<agent key>/v1/...` (ADR 0033), and Muse
 * Code's model list: taken on loopback only, from agent keys only, and the
 * key is out of the path before the ledger and the log see it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import { codexRoute } from "../src/codex.js";
import { keyPathRoute, pathKey } from "../src/key-path.js";
import { resolveHandlerLimits } from "../src/limits.js";
import { createGatewayHandler } from "../src/server.js";
import { sharingAccess, resolveGatewaySharing } from "../src/sharing.js";
import {
  addKey,
  CHAT_REPLY,
  MemoryStore,
  mount,
  provider,
  resolveSecret,
  send,
  upstream,
} from "./shared-support.js";

const CHAT = {
  model: "prov/model-a",
  messages: [{ role: "user", content: "hi" }],
};
const AGENT = { kind: "agent", adapterId: "fx" } as const;

function capture(): LogSink & { text(): string } {
  const records: [string, LogFields | undefined][] = [];
  return {
    level: "debug",
    info: (event, fields) => void records.push([event, fields]),
    debug: (event, fields) => void records.push([event, fields]),
    text: () => JSON.stringify(records),
  };
}

void test("a key segment is split off the path only when it has a key's form", () => {
  const key = `hhk_a_abcdefghijkl_${"S".repeat(43)}`;
  assert.deepEqual(keyPathRoute(`/k/${key}/v1/chat/completions`), {
    path: "/v1/chat/completions",
    key,
  });
  assert.deepEqual(keyPathRoute(`/k/${key}`), { path: "/", key });
  assert.deepEqual(keyPathRoute("/k/not-a-key/v1/models"), {
    path: "/v1/models",
  });
  assert.equal(keyPathRoute("/v1/models"), undefined);
  assert.equal(keyPathRoute("/kk/x/v1/models"), undefined);
  assert.deepEqual(pathKey("/k", "/k"), { segment: "", rest: "" });
  // The Codex passthrough keeps its own form on the same split.
  assert.deepEqual(codexRoute(`/backend-api/codex/${key}/responses`), {
    path: "/backend-api/codex/responses",
    key,
  });
  assert.deepEqual(codexRoute("/backend-api/codex/responses"), {
    path: "/backend-api/codex/responses",
  });
});

void test("an agent key in the path calls the gateway, which records and logs the path without it", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const agent = await addKey(store, ["prov/*"], { scope: AGENT });
  const client = await addKey(store, ["prov/*"]);
  const log = capture();
  const gw = await mount(t, store, {}, { log });

  const ok = await send(gw.port, `/k/${agent.text}/v1/chat/completions`, {
    body: CHAT,
  });
  assert.equal(ok.status, 200, ok.text);
  const listed = await send(gw.port, `/k/${agent.text}/v1/models`);
  assert.equal(listed.status, 200, listed.text);
  // The same key in a header too is one credential.
  assert.equal(
    (
      await send(gw.port, `/k/${agent.text}/v1/models`, {
        headers: { authorization: `Bearer ${agent.text}` },
      })
    ).status,
    200,
  );

  const wrong =
    agent.text.slice(0, -1) + (agent.text.endsWith("A") ? "B" : "A");
  for (const [path, headers, status, code] of [
    [`/k/${wrong}/v1/chat/completions`, {}, 401, "invalid_key"],
    ["/k/not-a-key/v1/chat/completions", {}, 401, "invalid_key"],
    [`/k/${client.text}/v1/chat/completions`, {}, 401, "invalid_key"],
    [
      `/k/${agent.text}/v1/chat/completions`,
      { authorization: `Bearer ${client.text}` },
      401,
      "invalid_key",
    ],
    [
      `/k/${agent.text}/backend-api/codex/responses`,
      {},
      404,
      "route_not_found",
    ],
    [`/k/${agent.text}`, {}, 404, "route_not_found"],
  ] as const) {
    const refused = await send(gw.port, path, { headers, body: CHAT });
    assert.equal(refused.status, status, `${path}: ${refused.text}`);
    assert.equal((refused.json().error as { code: string }).code, code, path);
    for (const secret of [agent.text, wrong, client.text])
      assert.ok(!refused.text.includes(secret), path);
  }
  // The client key still works where client keys go: a header.
  assert.equal(
    (
      await send(gw.port, "/v1/chat/completions", {
        headers: { authorization: `Bearer ${client.text}` },
        body: CHAT,
      })
    ).status,
    200,
  );

  // The upstream never saw the key; the ledger and the log hold
  // the path without the key, and no key text.
  assert.ok(up.seen.length >= 2);
  for (const seen of up.seen)
    assert.ok(
      !`${seen.url} ${JSON.stringify(seen.headers)}`.includes("hhk_"),
      seen.url,
    );
  assert.ok(store.entries.length >= 6);
  for (const entry of store.entries) {
    assert.ok(!entry.inbound.path.startsWith("/k/"), entry.inbound.path);
    assert.ok(!JSON.stringify(entry).includes("hhk_"));
  }
  assert.equal(
    store.entries.find((entry) => entry.status === 200)?.inbound.path,
    "/v1/chat/completions",
  );
  assert.ok(!log.text().includes("hhk_"));
});

void test("a key in the path is refused on the LAN listener and from other addresses, sharing on or not", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const agent = await addKey(store, ["prov/*"], { scope: AGENT });
  const handler = createGatewayHandler({
    store,
    resolveSecret,
    clock: Date.now,
    limits: resolveHandlerLimits(),
    access: () =>
      sharingAccess(
        resolveGatewaySharing({
          lan: { enabled: true, host: "127.0.0.1", port: 0 },
        }),
        0,
      ),
  });
  const server = createServer((request, response) => {
    if (request.headers["x-test-peer"] === "remote")
      Object.defineProperty(request.socket, "remoteAddress", {
        value: "192.168.1.20",
        configurable: true,
      });
    if (request.headers["x-test-listener"] === "lan")
      handler.lan(request, response);
    else handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  for (const headers of [
    { "x-test-listener": "lan" },
    { "x-test-peer": "remote" },
  ]) {
    const refused = await send(port, `/k/${agent.text}/v1/chat/completions`, {
      headers,
      body: CHAT,
    });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(
      (refused.json().error as { code: string }).code,
      "source_not_allowed",
    );
    assert.ok(!refused.text.includes(agent.text));
    const listed = await send(port, "/muse-code/models", { headers });
    assert.equal(listed.status, 403, listed.text);
  }
  assert.equal(up.seen.length, 0);
});

void test("Muse's model list is the newest active Muse key's, on loopback, for GET only", async (t) => {
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "prov",
      { chat: "http://127.0.0.1:9/v1" },
      {
        models: {
          source: "manual",
          expose: "all",
          list: [
            { id: "model-a", contextWindow: 200_000, maxOutputTokens: 64_000 },
            { id: "model-b", inputModalities: ["text", "image"] },
          ],
        },
      },
    ),
  );
  const gw = await mount(t, store);
  const none = await send(gw.port, "/muse-code/models");
  assert.equal(none.status, 404, none.text);

  const muse = { kind: "agent", adapterId: "muse" } as const;
  await addKey(store, ["prov/model-a"], {
    scope: muse,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  await addKey(store, ["prov/*"], {
    scope: muse,
    createdAt: "2026-10-02T00:00:00.000Z",
  });
  await addKey(store, ["prov/*"], {
    scope: muse,
    createdAt: "2026-10-03T00:00:00.000Z",
    revokedAt: "2026-10-03T01:00:00.000Z",
  });
  const answer = await send(gw.port, "/muse-code/models");
  assert.equal(answer.status, 200, answer.text);
  const data = answer.json().data as Array<{
    id: string;
    metadata: { "muse-code": Record<string, unknown> };
  }>;
  assert.deepEqual(
    data.map((entry) => entry.id),
    ["prov/model-a", "prov/model-b"],
  );
  assert.deepEqual(data[0]!.metadata["muse-code"].limit, {
    context: 200_000,
    output: 64_000,
  });
  // A model without limits gets Muse's own; image input makes an attachment.
  assert.deepEqual(data[1]!.metadata["muse-code"].limit, {
    context: 128_000,
    output: 32_000,
  });
  assert.equal(data[1]!.metadata["muse-code"].attachment, true);
  assert.deepEqual(data[1]!.metadata["muse-code"].modalities, {
    input: ["text", "image"],
    output: ["text"],
  });

  for (const [options, status] of [
    [{ method: "POST", body: {} }, 404],
    [{ headers: { origin: "https://evil.example" } }, 403],
    [{ headers: { host: "evil.example" } }, 403],
  ] as const) {
    const refused = await send(gw.port, "/muse-code/models", options);
    assert.equal(refused.status, status, refused.text);
  }
  assert.equal(store.entries.length, 0);
});
