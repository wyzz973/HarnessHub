// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import type { ProviderConfig } from "@harnesshub/sdk/client";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-preset-key-0001";

async function daemon(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(
    t,
    "harnesshub-presets-",
  );
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
  });
  let running = true;
  defer(() => (running ? hub.server.close() : undefined));
  const stop = async () => {
    running = false;
    await hub.server.close();
  };
  const bodies: string[] = [];
  const client = await connectLocal({
    dataDir,
    url: hub.url,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      bodies.push(await response.clone().text());
      return response;
    },
  });
  return { hub, client, bodies, stop };
}

function problem(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    assert.equal(error.status, status);
    return true;
  };
}

/**
 * A fake upstream with the three list formats. It answers only requests that
 * carry the expected key in the scheme of the endpoint, and it can be told to fail.
 */
async function upstream(t: TestContext) {
  const seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
  const state = { failWith: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://upstream");
    seen.push({ url: request.url ?? "", headers: request.headers });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (state.failWith)
      return json(state.failWith, { error: { message: `echo ${KEY}` } });
    if (url.pathname === "/openai/v1/models") {
      if (request.headers.authorization !== `Bearer ${KEY}`)
        return json(401, {});
      return json(200, {
        object: "list",
        data: [
          { id: "chat-1" },
          // Metadata as a HarnessHub gateway or OpenRouter publishes it.
          {
            id: "chat-2",
            context_length: 32768,
            max_output_tokens: 4096,
            reasoning: true,
            input_modalities: ["text", "image", "hologram"],
          },
          { id: "has space" },
          { id: "chat-1" },
        ],
      });
    }
    if (url.pathname === "/local/v1/models") {
      if (request.headers.authorization !== undefined) return json(400, {});
      return json(200, { data: [{ id: "llama3:8b" }] });
    }
    if (url.pathname === "/query/v1/models") {
      if (url.searchParams.get("key") !== KEY) return json(403, {});
      return json(200, { data: [{ id: "q-1" }] });
    }
    if (url.pathname === "/anthropic/v1/models") {
      if (
        request.headers["x-api-key"] !== KEY ||
        request.headers["anthropic-version"] !== "2023-06-01"
      )
        return json(401, {});
      return url.searchParams.get("after_id") === "claude-b"
        ? json(200, {
            data: [{ id: "claude-c" }],
            has_more: false,
            last_id: "claude-c",
          })
        : json(200, {
            data: [{ id: "claude-a" }, { id: "claude-b" }],
            has_more: true,
            last_id: "claude-b",
          });
    }
    if (url.pathname === "/gemini/v1beta/models") {
      if (request.headers["x-goog-api-key"] !== KEY) return json(400, {});
      return url.searchParams.get("pageToken") === "next"
        ? json(200, {
            models: [
              {
                name: "models/gemini-b",
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
            ],
          })
        : json(200, {
            models: [
              {
                name: "models/gemini-a",
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/embedding-1",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
            nextPageToken: "next",
          });
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, state };
}

void test("presets are listed and expand into providers with their first credential", async (t) => {
  const { client, bodies } = await daemon(t);
  const presets = (await client.presets.list()).items;
  const ids = presets.map((preset) => preset.id);
  for (const id of [
    "anthropic",
    "dashscope",
    "deepseek",
    "gemini",
    "groq",
    "lmstudio",
    "mistral",
    "moonshot",
    "ollama",
    "openai",
    "openrouter",
    "siliconflow",
    "vllm",
    "xai",
    "zhipu",
  ])
    assert.ok(ids.includes(id), id);
  assert.deepEqual(ids, [...ids].sort());
  for (const preset of presets)
    assert.match(preset.verified, /^(\d{4}-\d{2}-\d{2}|unverified)$/);

  const deepseek = presets.find((preset) => preset.id === "deepseek")!;
  const created = await client.providers.create({
    preset: "deepseek",
    credential: { value: KEY },
  });
  assert.equal(created.id, "deepseek");
  assert.equal(created.preset, "deepseek");
  assert.equal(created.name, deepseek.name);
  assert.deepEqual(created.endpoints, deepseek.endpoints);
  assert.equal(created.auth.apiKeyHeader, deepseek.auth.apiKeyHeader);
  assert.equal(created.models.expose, "all");
  assert.equal(created.credentials.length, 1);
  assert.equal(created.credentials[0]?.name, "default");
  assert.equal(created.credentials[0]?.ref.kind, "store");
  // Another provider from the same preset needs its own ID.
  await assert.rejects(
    client.providers.create({ preset: "deepseek" }),
    problem("PROVIDER_EXISTS", 409),
  );
  const second = await client.providers.create({
    preset: "deepseek",
    id: "deepseek-team",
    name: "DeepSeek (team)",
  });
  assert.equal(second.id, "deepseek-team");
  assert.deepEqual(second.credentials, []);

  await assert.rejects(
    client.providers.create({ preset: "nope" }),
    (error: unknown) => {
      problem("PRESET_NOT_FOUND", 400)(error);
      assert.equal(
        (error as HarnessHubError).problem.errors?.[0]?.pointer,
        "/preset",
      );
      return true;
    },
  );
  await assert.rejects(
    client.providers.create({ name: "no id" } as never),
    (error: unknown) => {
      problem("PROVIDER_INVALID", 400)(error);
      assert.deepEqual(
        (error as HarnessHubError).problem.errors?.map((item) => item.pointer),
        ["/id", "/endpoints"],
      );
      return true;
    },
  );
  // Overrides are checked like any provider: a public plain-HTTP base is refused.
  await assert.rejects(
    client.providers.create({
      preset: "openai",
      endpoints: { chat: "http://api.example.test/v1" },
    }),
    problem("PROVIDER_INVALID", 400),
  );
  // A bad credential stores nothing.
  await assert.rejects(
    client.providers.create({
      preset: "openai",
      credential: { value: "two\nlines" },
    }),
    problem("INVALID_SECRET", 400),
  );
  await assert.rejects(
    client.providers.get("openai"),
    problem("PROVIDER_NOT_FOUND", 404),
  );
  assert.equal(bodies.join("\n").includes(KEY), false);
});

void test("live model lists are fetched with the provider's key and kept when a refresh fails", async (t) => {
  const { client, bodies, stop } = await daemon(t);
  const fake = await upstream(t);

  // OpenAI format through a preset with an edited base.
  await client.providers.create({
    preset: "vllm",
    id: "relay",
    endpoints: { chat: `${fake.base}/openai/v1` },
    credential: { value: KEY },
    models: {
      source: "manual",
      list: [{ id: "chat-1", price: { input: 1, output: 2 } }, { id: "old" }],
      expose: "all",
    },
  });
  const refreshed = await client.providers.refreshModels("relay");
  assert.equal(refreshed.models.source, "live");
  assert.ok(refreshed.models.refreshedAt);
  assert.equal(refreshed.models.stale, undefined);
  // Invalid IDs and duplicates are dropped; known metadata is kept, listed
  // metadata is read, and unknown modalities are ignored.
  assert.deepEqual(refreshed.models.list, [
    { id: "chat-1", price: { input: 1, output: 2 } },
    {
      id: "chat-2",
      contextWindow: 32768,
      maxOutputTokens: 4096,
      reasoning: true,
      inputModalities: ["text", "image"],
    },
  ]);
  assert.equal(fake.seen.at(-1)?.headers.authorization, `Bearer ${KEY}`);

  // A failed refresh keeps the list, marks it stale and redacts the cause.
  fake.state.failWith = 401;
  await assert.rejects(
    client.providers.refreshModels("relay"),
    (error: unknown) => {
      problem("MODELS_REFRESH_FAILED", 502)(error);
      const detail = (error as HarnessHubError).problem.detail ?? "";
      assert.match(detail, /answered HTTP 401/);
      assert.equal(detail.includes(KEY), false);
      return true;
    },
  );
  const stale = await client.providers.get("relay");
  assert.equal(stale.models.stale, true);
  assert.deepEqual(stale.models.list, refreshed.models.list);
  fake.state.failWith = 0;
  assert.equal(
    (await client.providers.refreshModels("relay")).models.stale,
    undefined,
  );

  // Anthropic format, two pages, with the anthropic headers.
  await client.providers.create({
    preset: "anthropic",
    id: "claude",
    endpoints: { anthropic: `${fake.base}/anthropic` },
    credential: { value: KEY },
  });
  assert.deepEqual(
    (await client.providers.refreshModels("claude")).models.list.map(
      (model) => model.id,
    ),
    ["claude-a", "claude-b", "claude-c"],
  );

  // Gemini format, two pages; only generateContent models; limits become metadata.
  await client.providers.create({
    preset: "gemini",
    id: "google",
    endpoints: { gemini: `${fake.base}/gemini` },
    credential: { value: KEY },
  });
  assert.deepEqual(
    (await client.providers.refreshModels("google")).models.list,
    [
      { id: "gemini-a", contextWindow: 1048576, maxOutputTokens: 65536 },
      { id: "gemini-b" },
    ],
  );

  // A local server without credentials is asked without a key.
  await client.providers.create({
    preset: "ollama",
    id: "local",
    endpoints: { chat: `${fake.base}/local/v1` },
  });
  assert.deepEqual(
    (await client.providers.refreshModels("local")).models.list,
    [{ id: "llama3:8b" }],
  );

  // A key sent as a query parameter never reaches the error detail.
  await client.providers.create({
    id: "query",
    endpoints: { chat: `${fake.base}/query/v1` },
    auth: { apiKeyHeader: "query-key" },
    credential: { value: KEY },
  });
  assert.deepEqual(
    (await client.providers.refreshModels("query")).models.list,
    [{ id: "q-1" }],
  );
  fake.state.failWith = 500;
  await assert.rejects(
    client.providers.refreshModels("query"),
    (error: unknown) => {
      problem("MODELS_REFRESH_FAILED", 502)(error);
      assert.equal(
        JSON.stringify((error as HarnessHubError).problem).includes(KEY),
        false,
      );
      return true;
    },
  );
  fake.state.failWith = 0;

  // An unreadable credential and an unreachable upstream are reported, and mark the list stale.
  await client.providers.create({
    id: "envless",
    endpoints: { chat: `${fake.base}/openai/v1` },
    credential: { ref: { kind: "env", value: "HARNESSHUB_TEST_ABSENT_KEY" } },
  });
  await assert.rejects(
    client.providers.refreshModels("envless"),
    problem("CREDENTIAL_UNAVAILABLE", 409),
  );
  assert.equal((await client.providers.get("envless")).models.stale, true);
  await client.providers.create({
    id: "gone",
    endpoints: { chat: "http://127.0.0.1:9/v1" },
  });
  await assert.rejects(
    client.providers.refreshModels("gone"),
    (error: unknown) => {
      problem("MODELS_REFRESH_FAILED", 502)(error);
      assert.match(
        (error as HarnessHubError).problem.detail ?? "",
        /could not connect/,
      );
      return true;
    },
  );
  await assert.rejects(
    client.providers.refreshModels("missing"),
    problem("PROVIDER_NOT_FOUND", 404),
  );

  await stop();
  assert.equal(bodies.join("\n").includes(KEY), false);
});

void test("a region and a plan pick a preset's endpoints, key page and catalog", async (t) => {
  const { client, bodies } = await daemon(t);
  const presets = (await client.presets.list()).items;
  assert.ok(presets.length >= 46, `${presets.length} presets`);
  const moonshot = presets.find((preset) => preset.id === "moonshot")!;
  assert.deepEqual(
    moonshot.regions?.map((region) => region.id),
    ["cn", "global"],
  );
  assert.equal(moonshot.icon, "kimi");
  assert.equal(moonshot.source, "magpie@2e340f7");
  assert.deepEqual(
    presets.find((preset) => preset.id === "anthropic")?.headerHints?.[0]?.name,
    "anthropic-workspace-id",
  );
  assert.equal(
    presets.find((preset) => preset.id === "azure")?.userEndpoint,
    true,
  );

  // The default region is the first; another one changes every endpoint.
  const china = await client.providers.create({ preset: "moonshot" });
  assert.equal(china.region, "cn");
  assert.deepEqual(china.endpoints, moonshot.endpoints);
  const global = await client.providers.create({
    preset: "moonshot",
    id: "kimi-global",
    region: "global",
    credential: { value: KEY },
  });
  assert.equal(global.region, "global");
  assert.equal(global.endpoints.chat, "https://api.moonshot.ai/v1");
  assert.equal(global.credentials.length, 1);

  // A plan with its own endpoints and models; the plan's catalog fills metadata.
  const plan = await client.providers.create({
    preset: "volcengine",
    plan: "agent",
  });
  assert.equal(plan.plan, "agent");
  assert.equal(
    plan.endpoints.chat,
    "https://ark.cn-beijing.volces.com/api/plan/v3",
  );
  assert.ok(plan.models.list.some((model) => model.id === "ark-code-latest"));
  // The plan's catalog prices its models: a coding plan's tokens cost nothing.
  const glm = (): ProviderConfig["models"] => ({
    source: "manual",
    list: [{ id: "glm-5.3" }],
    expose: "all",
  });
  const coding = await client.providers.create({
    preset: "zhipu",
    id: "glm-coding",
    plan: "coding",
    models: glm(),
  });
  assert.equal(
    coding.endpoints.chat,
    "https://open.bigmodel.cn/api/coding/paas/v4",
  );
  assert.equal(coding.models.list[0]?.price?.input, 0);
  const metered = await client.providers.create({
    preset: "zhipu",
    id: "glm-api",
    plan: "api",
    models: glm(),
  });
  assert.ok((metered.models.list[0]?.price?.input ?? 0) > 0);
  // Pay-as-you-go Qianfan has a list endpoint; the plans do not.
  const qianfan = await client.providers.create({
    preset: "baidu-qianfan",
    plan: "api",
  });
  assert.equal(qianfan.models.source, "live");
  assert.equal(
    (
      await client.providers.create({
        preset: "baidu-qianfan",
        id: "qianfan-personal",
      })
    ).models.source,
    "static",
  );

  for (const [input, code, pointer] of [
    [
      { preset: "moonshot", id: "x1", region: "mars" },
      "PRESET_REGION_NOT_FOUND",
      "/region",
    ],
    [
      { preset: "zhipu", id: "x2", plan: "gold" },
      "PRESET_PLAN_NOT_FOUND",
      "/plan",
    ],
    [
      { preset: "openai", id: "x3", region: "cn" },
      "PRESET_REGION_NOT_FOUND",
      "/region",
    ],
    // The user's own resource is required.
    [{ preset: "azure" }, "PROVIDER_INVALID", "/endpoints"],
    [
      {
        id: "x4",
        region: "cn",
        endpoints: { chat: "https://a.example.test/v1" },
      },
      "PROVIDER_INVALID",
      "/region",
    ],
  ] as const)
    await assert.rejects(
      client.providers.create(input as never),
      (error: unknown) => {
        problem(code, 400)(error);
        assert.equal(
          (error as HarnessHubError).problem.errors?.[0]?.pointer,
          pointer,
        );
        return true;
      },
    );
  const azure = await client.providers.create({
    preset: "azure",
    endpoints: {
      chat: "https://team.openai.azure.com/openai/v1",
      responses: "https://team.openai.azure.com/openai/v1",
    },
  });
  assert.equal(azure.auth.apiKeyHeader, "api-key");

  // Detached from its preset, a provider loses its region too; a catalog may be set.
  const detached = await client.providers.update("kimi-global", {
    preset: null,
    catalog: "moonshotai",
  });
  assert.equal(detached.preset, undefined);
  assert.equal(detached.region, undefined);
  assert.equal(detached.catalog, "moonshotai");
  assert.equal(
    (await client.providers.update("kimi-global", { catalog: null })).catalog,
    undefined,
  );
  assert.equal(bodies.join("\n").includes(KEY), false);
});
