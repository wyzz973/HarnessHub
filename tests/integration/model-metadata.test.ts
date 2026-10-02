// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { modelCatalog } from "@harnesshub/gateway/catalog";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-catalog-key-0001";
const MODEL = "deepseek-v4-flash";

function problem(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    assert.equal(error.status, status);
    return true;
  };
}

/** A loopback DeepSeek stand-in: a model list and a chat endpoint with fixed usage. */
async function upstream(t: TestContext) {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${KEY}`)
        return json(401, { error: { message: "bad key" } });
      if (request.url === "/v1/models")
        return json(200, {
          data: [{ id: MODEL }, { id: "deepseek-in-house" }],
        });
      if (request.url === "/v1/chat/completions")
        return json(200, {
          id: "chatcmpl-up",
          object: "chat.completion",
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hi" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          },
        });
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

void test(
  "catalog metadata fills preset models, overrides win, values set by hand stay, and the gateway prices calls with them",
  { timeout: 60_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "harnesshub-model-metadata-",
    );
    const dataDir = path.join(directory, "data");
    const start = () =>
      startHub({
        dataDir,
        configDir: path.join(directory, "config"),
        secretsBackend: "file",
        demo: true,
        cwd: directory,
        port: 0,
        host: "127.0.0.1",
      });
    let hub = await start();
    let running = true;
    defer(() => (running ? hub.server.close() : undefined));
    const base = await upstream(t);
    const bodies: string[] = [];
    const connect = () =>
      connectLocal({
        dataDir,
        url: hub.url,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          bodies.push(await response.clone().text());
          return response;
        },
      });
    let client = await connect();
    const snapshot = modelCatalog();
    const known = snapshot.lookup("deepseek", MODEL)!;
    assert.ok(known.context && known.output && known.price?.input, MODEL);
    const catalogAt = snapshot.meta.retrievedAt;

    // The catalog status comes from the bundled snapshot; nothing refreshes it.
    assert.deepEqual(await client.catalog.status(), {
      snapshot: snapshot.meta,
      autoRefresh: false,
    });

    await client.providers.create({
      preset: "deepseek",
      endpoints: {
        chat: `${base}/v1`,
        responses: `${base}/v1`,
        anthropic: `${base}/anthropic`,
      },
      credential: { value: KEY },
    });
    const refreshed = await client.providers.refreshModels("deepseek");
    assert.deepEqual(refreshed.models.list, [
      {
        id: MODEL,
        contextWindow: known.context,
        maxOutputTokens: known.output,
        ...(known.reasoning !== undefined
          ? { reasoning: known.reasoning }
          : {}),
        ...(known.input ? { inputModalities: known.input } : {}),
        price: known.price,
      },
      // Not in the catalog: nothing is assumed, no window above all.
      { id: "deepseek-in-house" },
    ]);
    const shown = await client.models.get(`deepseek/${MODEL}`);
    assert.equal(shown.listed, true);
    assert.deepEqual(shown.fields.contextWindow, {
      value: known.context,
      source: "catalog",
      at: catalogAt,
    });
    assert.equal(shown.fields.toolCall?.source, "catalog");
    assert.deepEqual(shown.overrides, []);
    const unknown = await client.models.get("deepseek/deepseek-in-house");
    assert.deepEqual(unknown.fields, {});
    assert.equal(unknown.unknown.length, 9);
    assert.deepEqual(
      (await client.providers.models("deepseek")).items.map((item) => item.ref),
      [`deepseek/${MODEL}`, "deepseek/deepseek-in-house"],
    );

    // The gateway prices the call with the catalog price stored on the model.
    const info = await client.system.info();
    const { key } = await client.gatewayKeys.create({
      name: "catalog",
      modelAllow: ["deepseek/*"],
    });
    const call = async () => {
      const response = await fetch(
        `${info.gateway!.openaiBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: `deepseek/${MODEL}`,
            messages: [{ role: "user", content: "Hello" }],
          }),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      await response.text();
      const [entry] = (await client.modelCalls.list({ limit: 1 })).items;
      assert.equal(entry?.cost?.priceSource, "provider");
      return Number(entry.cost.amount);
    };
    const expected = (input: number, output: number) =>
      (1000 * input + 500 * output) / 1_000_000;
    assert.ok(
      Math.abs(
        (await call()) - expected(known.price.input!, known.price.output!),
      ) < 1e-9,
    );

    // An exact override wins and reaches the gateway at once.
    const saved = await client.models.setOverride(`deepseek/${MODEL}`, {
      contextWindow: 64_000,
      price: { input: 1, output: 2 },
    });
    assert.equal(saved.ref, `deepseek/${MODEL}`);
    assert.ok(Math.abs((await call()) - expected(1, 2)) < 1e-9);
    const overridden = await client.models.get(`deepseek/${MODEL}`);
    assert.deepEqual(overridden.fields.contextWindow, {
      value: 64_000,
      source: "override",
      at: saved.updatedAt,
    });
    assert.equal(overridden.fields["price.input"]?.source, "override");
    assert.deepEqual(overridden.overrides, [saved]);

    // A provider/* override reaches every model, after the exact one.
    const wildcard = await client.models.setOverride("deepseek/*", {
      maxOutputTokens: 4096,
      contextWindow: 32_000,
    });
    const models = (await client.providers.get("deepseek")).models.list;
    assert.deepEqual(
      models.map((model) => [
        model.id,
        model.contextWindow,
        model.maxOutputTokens,
      ]),
      [
        [MODEL, 64_000, 4096],
        ["deepseek-in-house", 32_000, 4096],
      ],
    );
    assert.equal(
      (await client.models.get("deepseek/deepseek-in-house")).fields
        .maxOutputTokens?.source,
      "override-provider",
    );

    // A value set by hand on the provider's model is kept by later writes.
    await client.providers.update("deepseek", {
      models: {
        ...refreshed.models,
        list: models.map((model) =>
          model.id === "deepseek-in-house"
            ? { ...model, price: { input: 0.5, output: 0.5 } }
            : model,
        ),
      },
    });
    await client.providers.refreshModels("deepseek");
    const inHouse = await client.models.get("deepseek/deepseek-in-house");
    assert.equal(inHouse.fields["price.input"]?.source, "provider");
    assert.equal(inHouse.fields["price.input"]?.value, 0.5);
    // Values the edit sent back unchanged keep their source.
    assert.equal(
      (await client.models.get(`deepseek/${MODEL}`)).fields["price.cacheRead"]
        ?.source,
      "catalog",
    );

    // Overrides are durable.
    running = false;
    await hub.server.close();
    hub = await start();
    running = true;
    client = await connect();
    assert.deepEqual((await client.models.get(`deepseek/${MODEL}`)).overrides, [
      wildcard,
      saved,
    ]);

    // Removing an override falls back to the next source.
    await client.models.removeOverride(`deepseek/${MODEL}`);
    const restored = await client.models.get(`deepseek/${MODEL}`);
    assert.equal(restored.fields["price.input"]?.source, "catalog");
    assert.deepEqual(restored.fields.contextWindow, {
      value: 32_000,
      source: "override-provider",
      at: wildcard.updatedAt,
    });
    await client.models.removeOverride("deepseek/*");
    assert.equal(
      (await client.providers.get("deepseek")).models.list[0]?.contextWindow,
      known.context,
    );
    await assert.rejects(
      client.models.removeOverride("deepseek/*"),
      problem("MODEL_OVERRIDE_NOT_FOUND", 404),
    );

    // Refs and values are checked.
    await assert.rejects(
      client.models.get("deepseek/*"),
      problem("MODEL_REF_INVALID", 400),
    );
    await assert.rejects(
      client.models.setOverride("group/fast", { contextWindow: 1 }),
      problem("MODEL_REF_INVALID", 400),
    );
    await assert.rejects(
      client.models.get("absent/model"),
      problem("PROVIDER_NOT_FOUND", 404),
    );
    for (const values of [
      {},
      { contextWindow: 0 },
      { price: {} },
      { price: { input: -1 } },
      { window: 1000 },
      { inputModalities: ["text", "text"] },
    ])
      await assert.rejects(
        client.models.setOverride(`deepseek/${MODEL}`, values as never),
        problem("INVALID_REQUEST", 400),
        JSON.stringify(values),
      );

    // A provider without a preset is filled by the model's author.
    const relay = await client.providers.create({
      id: "relay",
      endpoints: { chat: `${base}/v1` },
      models: {
        source: "manual",
        list: [{ id: `deepseek/${MODEL}`, contextWindow: 100_000 }],
        expose: "all",
      },
    });
    assert.deepEqual(relay.models.list, [
      {
        id: `deepseek/${MODEL}`,
        contextWindow: 100_000,
        maxOutputTokens: known.output,
        ...(known.reasoning !== undefined
          ? { reasoning: known.reasoning }
          : {}),
        ...(known.input ? { inputModalities: known.input } : {}),
        price: known.price,
      },
    ]);
    assert.equal(
      (await client.models.get(`relay/deepseek/${MODEL}`)).fields.contextWindow
        ?.source,
      "provider",
    );

    // Deleting a provider deletes its overrides.
    await client.models.setOverride("relay/*", { reasoning: false });
    await client.providers.remove("relay");
    await client.providers.create({
      id: "relay",
      endpoints: { chat: `${base}/v1` },
    });
    assert.deepEqual(
      (await client.models.get(`relay/deepseek/${MODEL}`)).overrides,
      [],
    );

    running = false;
    await hub.server.close();
    assert.equal(bodies.join("\n").includes(KEY), false);
  },
);
