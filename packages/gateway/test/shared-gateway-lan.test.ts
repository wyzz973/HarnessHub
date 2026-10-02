// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { resolveHandlerLimits } from "../src/limits.js";
import { createGatewayHandler } from "../src/server.js";
import {
  canonicalHost,
  LOOPBACK_ONLY,
  resolveGatewaySharing,
  SharingConfigError,
  sharingAccess,
  type GatewayAccess,
} from "../src/sharing.js";
import {
  addKey,
  CHAT_REPLY,
  json,
  MemoryStore,
  provider,
  resolveSecret,
  send,
  upstream,
} from "./shared-support.js";

const CHAT = {
  model: "prov/model-a",
  messages: [{ role: "user", content: "hi" }],
};

/**
 * A peer address as the gateway sees it, for requests that really come from
 * 127.0.0.1; undefined restores the socket's own (kept-alive sockets are reused).
 */
function pretend(request: IncomingMessage, address: string | undefined) {
  if (address === undefined)
    Reflect.deleteProperty(request.socket, "remoteAddress");
  else
    Object.defineProperty(request.socket, "remoteAddress", {
      value: address,
      configurable: true,
    });
}

/**
 * The handler on two loopback listeners: `loopbackPort` calls the handler,
 * `lanPort` its LAN entry. `peer` makes requests appear to come from that
 * address on either listener.
 */
async function mountShared(t: test.TestContext, store: MemoryStore) {
  const state: { access: GatewayAccess; peer: string | undefined } = {
    access: LOOPBACK_ONLY,
    peer: undefined,
  };
  const handler = createGatewayHandler({
    store,
    resolveSecret,
    clock: Date.now,
    limits: resolveHandlerLimits(),
    access: () => state.access,
  });
  const listen = async (lan: boolean) => {
    const server = createServer((request, response) => {
      pretend(request, state.peer);
      if (lan) handler.lan(request, response);
      else handler(request, response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return { server, port: address.port };
  };
  const loopback = await listen(false);
  const lan = await listen(true);
  t.after(async () => {
    await handler.close();
    for (const { server } of [loopback, lan]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  return { state, handler, loopbackPort: loopback.port, lanPort: lan.port };
}

void test("sharing settings resolve to their defaults and refuse invalid values", () => {
  assert.deepEqual(resolveGatewaySharing(undefined), {
    lan: { enabled: false, names: [] },
  });
  assert.deepEqual(
    resolveGatewaySharing({
      lan: {
        enabled: true,
        host: "0.0.0.0",
        port: 3181,
        names: ["HH.lan", "hh.lan", "192.168.1.5"],
      },
      publicBaseUrl: "https://hh.example.test/gw/",
    }),
    {
      lan: {
        enabled: true,
        host: "0.0.0.0",
        port: 3181,
        names: ["hh.lan", "192.168.1.5"],
      },
      publicBaseUrl: "https://hh.example.test/gw",
    },
  );
  // Sharing off may keep the address it had.
  assert.equal(
    resolveGatewaySharing({ lan: { enabled: false, host: "10.0.0.2" } }).lan
      .host,
    "10.0.0.2",
  );
  const invalid: Array<[unknown, string]> = [
    [[], ""],
    [{ lan: { enabled: true } }, "/lan/host"],
    [{ lan: { enabled: "yes" } }, "/lan/enabled"],
    [{ lan: { enabled: true, host: "my-laptop" } }, "/lan/host"],
    [{ lan: { enabled: true, host: "10.0.0.2", port: 70000 } }, "/lan/port"],
    [{ lan: { enabled: true, host: "10.0.0.2", port: 1.5 } }, "/lan/port"],
    [
      { lan: { enabled: true, host: "10.0.0.2", names: ["bad name"] } },
      "/lan/names/0",
    ],
    [
      {
        lan: {
          enabled: true,
          host: "10.0.0.2",
          names: Array.from({ length: 21 }, (_, i) => `h${i}.lan`),
        },
      },
      "/lan/names",
    ],
    [{ lan: { enabled: true, host: "0.0.0.0" } }, "/lan/names"],
    [{ lan: { enabled: true, host: "::" } }, "/lan/names"],
    [{ lan: { enabled: false, tls: true } }, "/lan/tls"],
    [{ publicBaseUrl: "ftp://hh.example.test" }, "/publicBaseUrl"],
    [{ publicBaseUrl: "https://user:pw@hh.example.test" }, "/publicBaseUrl"],
    [{ publicBaseUrl: "https://hh.example.test/?a=1" }, "/publicBaseUrl"],
    [{ other: 1 }, "/other"],
  ];
  for (const [input, field] of invalid)
    assert.throws(
      () => resolveGatewaySharing(input),
      (error: unknown) =>
        error instanceof SharingConfigError && error.field === field,
      JSON.stringify(input),
    );
});

void test("access rules list the LAN names with the bound port and the public host", () => {
  const access = sharingAccess(
    resolveGatewaySharing({
      lan: { enabled: true, host: "192.168.1.5", names: ["HH.lan", "fe80::1"] },
      publicBaseUrl: "https://hh.example.test",
    }),
    3181,
  );
  assert.equal(access.lan, true);
  assert.deepEqual(
    [...access.lanHosts],
    ["192.168.1.5:3181", "hh.lan:3181", "[fe80::1]:3181"],
  );
  assert.deepEqual([...access.publicHosts], ["hh.example.test"]);
  // Port 80 is how a Host header leaves it out.
  assert.deepEqual(
    [
      ...sharingAccess(
        resolveGatewaySharing({ lan: { enabled: true, host: "10.0.0.2" } }),
        80,
      ).lanHosts,
    ],
    ["10.0.0.2"],
  );
  // Not bound: the LAN rules accept nothing.
  const unbound = sharingAccess(
    resolveGatewaySharing({ lan: { enabled: true, host: "10.0.0.2" } }),
    undefined,
  );
  assert.equal(unbound.lan, false);
  assert.equal(unbound.lanHosts.size, 0);
  assert.equal(canonicalHost("HH.LAN:80"), "hh.lan");
  assert.equal(canonicalHost("[::1]:3180"), "[::1]:3180");
  assert.equal(canonicalHost("evil.test/@hh.lan"), undefined);
  assert.equal(canonicalHost(undefined), undefined);
});

void test("the LAN entry accepts only client keys marked allowLan, from any peer address", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const lanKey = await addKey(store, ["prov/*"], { allowLan: true });
  const plainKey = await addKey(store, ["prov/*"]);
  const agentKey = await addKey(store, ["prov/*"], {
    scope: { kind: "agent", adapterId: "codex" },
  });
  const gw = await mountShared(t, store);
  const lanHost = `127.0.0.1:${gw.lanPort}`;
  gw.state.access = sharingAccess(
    resolveGatewaySharing({
      lan: { enabled: true, host: "127.0.0.1", names: ["hh.lan"] },
    }),
    gw.lanPort,
  );
  const call = (
    port: number,
    headers: Record<string, string>,
    path = "/v1/chat/completions",
  ) => send(port, path, { headers, body: CHAT });
  const refusals: Array<{
    name: string;
    headers: Record<string, string>;
    status: number;
    reason: string;
  }> = [
    {
      name: "no key",
      headers: { host: lanHost },
      status: 401,
      reason: "invalid_key",
    },
    {
      name: "client key without allowLan",
      headers: { host: lanHost, authorization: `Bearer ${plainKey.text}` },
      status: 403,
      reason: "source_not_allowed",
    },
    {
      name: "agent key",
      headers: { host: lanHost, authorization: `Bearer ${agentKey.text}` },
      status: 403,
      reason: "source_not_allowed",
    },
    {
      name: "loopback Host on the LAN listener",
      headers: {
        host: `localhost:${gw.lanPort}`,
        authorization: `Bearer ${lanKey.text}`,
      },
      status: 403,
      reason: "origin_forbidden",
    },
    {
      name: "undeclared Host",
      headers: {
        host: `attacker.example:${gw.lanPort}`,
        authorization: `Bearer ${lanKey.text}`,
      },
      status: 403,
      reason: "origin_forbidden",
    },
    {
      name: "foreign Origin",
      headers: {
        host: lanHost,
        origin: "http://evil.example",
        authorization: `Bearer ${lanKey.text}`,
      },
      status: 403,
      reason: "origin_forbidden",
    },
    // No client of the gateway is a browser: even the listener's own origin.
    {
      name: "same-origin browser request",
      headers: {
        host: lanHost,
        origin: `http://${lanHost}`,
        "sec-fetch-site": "same-origin",
        authorization: `Bearer ${lanKey.text}`,
      },
      status: 403,
      reason: "origin_forbidden",
    },
    {
      name: "cross-site browser request",
      headers: {
        host: lanHost,
        "sec-fetch-site": "cross-site",
        authorization: `Bearer ${lanKey.text}`,
      },
      status: 403,
      reason: "origin_forbidden",
    },
  ];
  // A real LAN peer and the loopback address behave the same on the LAN entry.
  for (const peer of [undefined, "192.168.1.20", "::ffff:10.1.2.3"]) {
    gw.state.peer = peer;
    for (const refusal of refusals) {
      const before = store.entries.length;
      const answer = await call(gw.lanPort, refusal.headers);
      assert.equal(answer.status, refusal.status, `${refusal.name} ${peer}`);
      assert.equal(answer.headers["x-hh-error-source"], "gateway");
      const entry = store.entries.at(-1)!;
      assert.equal(store.entries.length, before + 1, refusal.name);
      assert.equal(entry.rejectReason, refusal.reason, refusal.name);
    }
    for (const host of [lanHost, `hh.lan:${gw.lanPort}`]) {
      const answer = await call(gw.lanPort, {
        host,
        authorization: `Bearer ${lanKey.text}`,
      });
      assert.equal(answer.status, 200, `${host} ${peer}`);
      assert.equal(store.entries.at(-1)!.keyId, lanKey.keyId);
    }
  }
  assert.equal(up.seen.length, 6);
  for (const seen of up.seen)
    assert.equal(seen.headers.authorization, "Bearer sk-upstream-a-0001");

  // A non-loopback peer on the loopback listener is refused whatever its key.
  gw.state.peer = "192.168.1.20";
  const outside = await call(gw.loopbackPort, {
    host: `127.0.0.1:${gw.loopbackPort}`,
    authorization: `Bearer ${lanKey.text}`,
  });
  assert.equal(outside.status, 403);
  assert.equal(store.entries.at(-1)!.rejectReason, "source_not_allowed");
  // From loopback, every valid key works there, with loopback Hosts only.
  gw.state.peer = undefined;
  for (const key of [plainKey, agentKey, lanKey])
    assert.equal(
      (
        await call(gw.loopbackPort, {
          host: `localhost:${gw.loopbackPort}`,
          authorization: `Bearer ${key.text}`,
        })
      ).status,
      200,
    );
  // LAN names belong to the LAN listener only.
  assert.equal(
    (
      await call(gw.loopbackPort, {
        host: `hh.lan:${gw.loopbackPort}`,
        authorization: `Bearer ${plainKey.text}`,
      })
    ).status,
    403,
  );
  // Sharing turned off: the LAN entry refuses before reading the key.
  gw.state.access = LOOPBACK_ONLY;
  const off = await call(gw.lanPort, {
    host: lanHost,
    authorization: `Bearer ${lanKey.text}`,
  });
  assert.equal(off.status, 403);
  assert.equal(store.entries.at(-1)!.rejectReason, "source_not_allowed");
  assert.equal(store.entries.at(-1)!.keyId, undefined);
  // Model listing follows the same rules on the LAN entry.
  gw.state.access = sharingAccess(
    resolveGatewaySharing({ lan: { enabled: true, host: "127.0.0.1" } }),
    gw.lanPort,
  );
  const models = await send(gw.lanPort, "/v1/models", {
    headers: { host: lanHost, authorization: `Bearer ${lanKey.text}` },
  });
  assert.equal(models.status, 200);
  assert.deepEqual(
    (models.json().data as { id: string }[]).map((model) => model.id),
    ["prov/model-a", "prov/model-b"],
  );
  assert.equal(
    (
      await send(gw.lanPort, "/v1/models", {
        headers: { host: lanHost, authorization: `Bearer ${plainKey.text}` },
      })
    ).status,
    403,
  );
});

void test("the public base URL's Host is accepted on the loopback listener, browser Origins never", async (t) => {
  const store = new MemoryStore();
  const up = await upstream(t, CHAT_REPLY);
  await store.putProvider(provider("prov", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["prov/*"]);
  const gw = await mountShared(t, store);
  gw.state.access = sharingAccess(
    resolveGatewaySharing({ publicBaseUrl: "https://hh.example.test" }),
    undefined,
  );
  const call = (headers: Record<string, string>) =>
    send(gw.loopbackPort, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}`, ...headers },
      body: CHAT,
    });
  assert.equal((await call({ host: "hh.example.test" })).status, 200);
  assert.equal(
    (
      await call({
        host: "hh.example.test",
        origin: "https://hh.example.test",
      })
    ).status,
    403,
  );
  assert.equal((await call({ host: "hh.example.test:8443" })).status, 403);
  assert.equal(
    (await call({ host: "localhost", origin: "http://localhost" })).status,
    403,
  );
  // Sharing on the LAN is still off: the LAN entry refuses.
  const lan = await send(gw.lanPort, "/v1/chat/completions", {
    headers: { host: "hh.example.test", authorization: `Bearer ${key.text}` },
    body: CHAT,
  });
  assert.equal(lan.status, 403);
});

void test("count_tokens goes to a native Anthropic upstream and falls back to the estimate otherwise", async (t) => {
  const store = new MemoryStore();
  const answers: Array<() => ReturnType<typeof json>> = [];
  const anthropic = await upstream(t, (response, seen, request) =>
    (answers.shift() ?? (() => json(200, { input_tokens: 4242 })))()(
      response,
      seen,
      request,
    ),
  );
  const chat = await upstream(t, CHAT_REPLY);
  await store.putProvider(
    provider(
      "ant",
      { anthropic: anthropic.base },
      {
        auth: { apiKeyHeader: "x-api-key" },
        wire: { "model-a": "claude-wire" },
      },
    ),
  );
  await store.putProvider(provider("chat", { chat: `${chat.base}/v1` }));
  await store.putProvider(
    provider(
      "only",
      { anthropic: anthropic.base },
      { auth: { apiKeyHeader: "x-api-key" }, translateOnly: true },
    ),
  );
  const key = await addKey(store, ["ant/*", "chat/*", "only/*"]);
  const gw = await mountShared(t, store);
  const count = (model: string, headers: Record<string, string> = {}) =>
    send(gw.loopbackPort, "/v1/messages/count_tokens", {
      headers: {
        "x-api-key": key.text,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "token-counting-2024-11-01",
        ...headers,
      },
      body: {
        model,
        messages: [{ role: "user", content: "hello there, count me" }],
      },
    });

  const forwarded = await count("ant/model-a");
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.headers["x-hh-token-count"], "upstream");
  assert.deepEqual(forwarded.json(), { input_tokens: 4242 });
  const seen = anthropic.seen.at(-1)!;
  assert.equal(seen.url, "/v1/messages/count_tokens");
  assert.equal(seen.json().model, "claude-wire");
  assert.equal(seen.headers["x-api-key"], "sk-upstream-a-0001");
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.headers["anthropic-beta"], "token-counting-2024-11-01");

  // A cascaded HarnessHub that could only estimate says so; the header is kept.
  answers.push(() =>
    json(200, { input_tokens: 7 }, { "x-hh-token-count": "estimated" }),
  );
  const relayed = await count("ant/model-a");
  assert.equal(relayed.headers["x-hh-token-count"], "estimated");
  assert.deepEqual(relayed.json(), { input_tokens: 7 });

  // Upstream failures and answers without a count fall back to the estimate.
  for (const reply of [
    () => json(404, { type: "error", error: { type: "not_found_error" } }),
    () => json(200, { tokens: 3 }),
    () => json(200, "not json"),
  ]) {
    answers.push(reply);
    const before = anthropic.seen.length;
    const fallback = await count("ant/model-a");
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers["x-hh-token-count"], "estimated");
    assert.ok(Number(fallback.json().input_tokens) > 0);
    assert.notEqual(fallback.json().input_tokens, 4242);
    assert.equal(anthropic.seen.length, before + 1);
  }

  // No native Anthropic route, a model the key may not use, or no model:
  // the estimate, without contacting any upstream.
  const before = anthropic.seen.length + chat.seen.length;
  for (const model of ["chat/model-a", "only/model-a", "other/model-a", ""]) {
    const local = await count(model);
    assert.equal(local.status, 200, model);
    assert.equal(local.headers["x-hh-token-count"], "estimated", model);
  }
  assert.equal(anthropic.seen.length + chat.seen.length, before);
  // Counting is not a model call: nothing enters the ledger.
  assert.equal(store.entries.length, 0);
});
