// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { HarnessHubClient, HarnessHubError } from "../src/client.js";

/** A fetch that records requests and answers from a queue. */
function recorder(...answers: Response[]) {
  const requests: Array<{ url: string; headers: Headers; method: string }> = [];
  const send: typeof fetch = (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
    });
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected request");
    return Promise.resolve(answer);
  };
  return { send, requests };
}

void test("requests go below the base path, with the token only when one is given", async () => {
  const direct = recorder(Response.json({ items: [], nextCursor: null }));
  await new HarnessHubClient({
    url: "http://127.0.0.1:3180",
    token: "t".repeat(43),
    fetch: direct.send,
  }).providers.list();
  assert.equal(
    direct.requests[0]?.url,
    "http://127.0.0.1:3180/api/v1/providers",
  );
  assert.equal(
    direct.requests[0]?.headers.get("authorization"),
    `Bearer ${"t".repeat(43)}`,
  );

  // Behind the console proxy: the path prefix is kept and no token is sent.
  const proxied = recorder(
    Response.json({ items: [], nextCursor: null }),
    new Response(null, { status: 204 }),
  );
  const client = new HarnessHubClient({
    url: "http://127.0.0.1:3330/api/gateway/",
    fetch: proxied.send,
  });
  await client.modelCalls.list({ limit: 5, provider: "a b" });
  assert.equal(
    proxied.requests[0]?.url,
    "http://127.0.0.1:3330/api/gateway/api/v1/model-calls?limit=5&provider=a+b",
  );
  assert.equal(proxied.requests[0]?.headers.get("authorization"), null);
  assert.equal(await client.providers.remove("x/y"), undefined);
  assert.equal(
    proxied.requests[1]?.url,
    "http://127.0.0.1:3330/api/gateway/api/v1/providers/x%2Fy",
  );
  assert.equal(proxied.requests[1]?.method, "DELETE");

  // A base without a trailing slash is treated as a directory too.
  const bare = recorder(Response.json({ apiVersion: "v1" }));
  await new HarnessHubClient({
    url: "http://127.0.0.1:3330/api/gateway",
    fetch: bare.send,
  }).system.info();
  assert.equal(
    bare.requests[0]?.url,
    "http://127.0.0.1:3330/api/gateway/api/v1/system/info",
  );
});

void test("error responses become HarnessHubError, problem or not", async () => {
  const problem = {
    type: "https://harnesshub.dev/problems/provider-in-use",
    title: "Conflict",
    status: 409,
    detail: "in use",
    code: "PROVIDER_IN_USE",
    requestId: "req-9",
    references: [{ type: "route-group", id: "fast" }],
  };
  const { send } = recorder(
    new Response(JSON.stringify(problem), {
      status: 409,
      headers: { "content-type": "application/problem+json" },
    }),
    new Response("<html>bad gateway</html>", {
      status: 502,
      statusText: "Bad Gateway",
    }),
  );
  const client = new HarnessHubClient({
    url: "http://127.0.0.1:1",
    fetch: send,
  });
  await assert.rejects(client.providers.remove("a"), (error: unknown) => {
    assert.ok(error instanceof HarnessHubError);
    assert.equal(error.code, "PROVIDER_IN_USE");
    assert.equal(error.status, 409);
    assert.equal(error.requestId, "req-9");
    assert.deepEqual(error.problem.references, problem.references);
    return true;
  });
  await assert.rejects(client.providers.list(), (error: unknown) => {
    assert.ok(error instanceof HarnessHubError);
    assert.equal(error.code, "UNEXPECTED_RESPONSE");
    assert.equal(error.status, 502);
    return true;
  });
});

void test("agent wiring sends only the confirmed files' identity as expect", async () => {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const send: typeof fetch = (input, init) => {
    urls.push(`${init?.method ?? "GET"} ${String(input)}`);
    bodies.push(
      init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    );
    return Promise.resolve(Response.json({}));
  };
  const client = new HarnessHubClient({
    url: "http://127.0.0.1:3180",
    fetch: send,
  });
  const plan = {
    adapterId: "codex",
    protocol: "responses" as const,
    keyDelivery: "config-file" as const,
    model: "a/b",
    changed: true,
    files: [
      {
        id: "config",
        path: "/home/u/.codex/config.toml",
        format: "toml" as const,
        exists: true,
        hash: "0".repeat(64),
        changes: [],
        diff: "--- big diff",
      },
    ],
  };
  await client.agents.plan("codex", { model: "a/b" });
  await client.agents.wire("codex", {
    model: "a/b",
    models: ["a/c"],
    expect: plan,
  });
  await client.agents.rotate("codex");
  await client.agents.unwire("codex");
  assert.deepEqual(urls, [
    "POST http://127.0.0.1:3180/api/v1/agents/codex/wiring/plan",
    "POST http://127.0.0.1:3180/api/v1/agents/codex/wiring",
    "POST http://127.0.0.1:3180/api/v1/agents/codex/wiring/rotate",
    "DELETE http://127.0.0.1:3180/api/v1/agents/codex/wiring",
  ]);
  assert.deepEqual(bodies[1], {
    model: "a/b",
    models: ["a/c"],
    expect: {
      files: [
        {
          path: "/home/u/.codex/config.toml",
          exists: true,
          hash: "0".repeat(64),
        },
      ],
    },
  });
});
