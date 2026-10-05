// SPDX-License-Identifier: MIT
/**
 * Bare model names through the daemon: a client that cannot send
 * `provider/model` (an IDE plugin, a script that says the model's name) is
 * served by the automatic group or the one model of that name, in each
 * inbound protocol, Gemini's model path included. Several models of a name
 * are refused with their names, and a key's allowlist applies to what the
 * name resolved to. The upstream is the strict fake provider.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-bare-names-0001";

async function daemon(t: TestContext) {
  const fake = await startFakeProvider({
    models: ["upstream-sim", "beta-only"],
    keys: { main: KEY },
    chunkDelayMs: 0,
    // The gateway asks for usage on translated streams.
    fields: { chat: { allowed: { topLevel: ["stream_options"] } } },
  });
  t.after(() => fake.close());
  const { directory, defer } = await temporaryDirectory(t, "hh-bare-names-");
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  // Both list upstream-sim (its automatic group); only beta lists beta-only.
  for (const [id, models] of [
    ["alpha", ["upstream-sim"]],
    ["beta", ["upstream-sim", "beta-only"]],
  ] as const)
    await client.providers.create({
      id,
      kind: "custom",
      endpoints: { chat: `${fake.url}/v1` },
      models: {
        source: "manual",
        list: models.map((model) => ({ id: model })),
        expose: "all",
      },
      credential: { value: KEY },
    });
  const every = await client.gatewayKeys.create({
    name: "every",
    modelAllow: ["alpha/*", "beta/*", "group/auto-upstream-sim"],
  });
  const send = (pathname: string, body: unknown, key = every.key) =>
    fetch(`${hub.url}${pathname}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "x-goog-api-key": key,
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    }));
  return { fake, client, send };
}

const MESSAGES = [{ role: "user", content: "hi" }];

void test("a bare name is served in every inbound protocol, Gemini's model path included, and the ledger keeps the name", async (t) => {
  const { fake, client, send } = await daemon(t);
  const answers = [
    await send("/v1/chat/completions", {
      model: "upstream-sim",
      messages: MESSAGES,
    }),
    await send("/v1/responses", { model: "beta-only", input: "hi" }),
    await send("/v1/messages", {
      model: "beta-only",
      max_tokens: 64,
      messages: MESSAGES,
    }),
    await send("/v1beta/models/beta-only:generateContent", {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    }),
  ];
  for (const answer of answers)
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(fake.violations(), []);
  assert.deepEqual(
    fake.records().map((record) => record.model),
    ["upstream-sim", "beta-only", "beta-only", "beta-only"],
  );
  const calls = (await client.modelCalls.list({ limit: 4 })).items.reverse();
  assert.deepEqual(
    calls.map((call) => [
      call.inbound.protocol,
      call.requestedModel,
      call.group ?? null,
      call.modelRef,
    ]),
    [
      ["chat", "upstream-sim", "auto-upstream-sim", "alpha/upstream-sim"],
      ["responses", "beta-only", null, "beta/beta-only"],
      ["anthropic", "beta-only", null, "beta/beta-only"],
      ["gemini", "beta-only", null, "beta/beta-only"],
    ],
  );
  // /v1/models lists Model Refs and groups as before, no bare names.
  const listed = await fetch(
    `${(await client.system.info()).gateway!.openaiBaseUrl}/models`,
    {
      headers: {
        authorization: `Bearer ${(await client.gatewayKeys.create({ name: "list", modelAllow: ["beta/*"] })).key}`,
      },
    },
  ).then((response) => response.json() as Promise<{ data: { id: string }[] }>);
  assert.deepEqual(listed.data.map((item) => item.id).sort(), [
    "beta/beta-only",
    "beta/upstream-sim",
  ]);
});

void test("several models of a name are refused with their names, and the allowlist applies to what a name resolved to", async (t) => {
  const { client, send } = await daemon(t);
  // With the automatic group hidden, two providers' models have the name.
  await client.autoGroups.hide("auto-upstream-sim");
  for (const [pathname, body] of [
    ["/v1/chat/completions", { model: "upstream-sim", messages: MESSAGES }],
    [
      "/v1beta/models/upstream-sim:generateContent",
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    ],
  ] as const) {
    const answer = await send(pathname, body);
    assert.equal(answer.status, 400, pathname);
    assert.match(
      JSON.stringify(answer.body),
      /upstream-sim names more than one model: alpha\/upstream-sim, beta\/upstream-sim; name one as provider\/model/,
    );
  }

  // A key for alpha alone: beta-only resolves to beta's model, which it may not use.
  const alpha = await client.gatewayKeys.create({
    name: "alpha",
    modelAllow: ["alpha/*"],
  });
  const denied = await send(
    "/v1/chat/completions",
    { model: "beta-only", messages: MESSAGES },
    alpha.key,
  );
  assert.equal(denied.status, 403);
  assert.match(
    JSON.stringify(denied.body),
    /may not use beta\/beta-only \(what beta-only names here\)/,
  );
  const [refused] = (await client.modelCalls.list({ limit: 1 })).items;
  assert.equal(refused!.requestedModel, "beta-only");
  assert.equal(refused!.modelRef, "beta/beta-only");
  assert.equal(refused!.rejected, true);
  assert.equal(refused!.errorClass, "model_not_allowed");
  // Its ambiguity message names only what it may use.
  const narrow = await send(
    "/v1/chat/completions",
    { model: "upstream-sim", messages: MESSAGES },
    alpha.key,
  );
  assert.equal(narrow.status, 400);
  assert.match(
    JSON.stringify(narrow.body),
    /: alpha\/upstream-sim, and 1 this Gateway Key may not use;/,
  );

  const unknown = await send("/v1/chat/completions", {
    model: "no-such-model",
    messages: MESSAGES,
  });
  assert.equal(unknown.status, 404);
  assert.match(
    JSON.stringify(unknown.body),
    /No route group or model is named no-such-model/,
  );
});
