// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { apiCatalog } from "@harnesshub/daemon/http/api-catalog";
import {
  isCodexPassthroughPath,
  isModelGatewayPath,
} from "@harnesshub/daemon/http/model-gateway-mount";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { temporaryDirectory } from "../support/temporary.js";

const CHAT_KEY = "sk-synthetic-mount-chat-0001";
const CLAUDE_KEY = "sk-synthetic-mount-claude-0002";

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A loopback upstream with an OpenAI Chat endpoint and an Anthropic Messages endpoint. */
async function upstream(t: TestContext) {
  const seen: Seen[] = [];
  const anthropicAnswer = JSON.stringify({
    id: "msg_up",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: "Bonjour" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ path: request.url ?? "", headers: request.headers, body });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(typeof value === "string" ? value : JSON.stringify(value));
      };
      if (request.url === "/openai/v1/chat/completions") {
        if (request.headers.authorization !== `Bearer ${CHAT_KEY}`)
          return json(401, { error: { message: "bad key" } });
        const parsed = JSON.parse(body) as { stream?: boolean };
        const usage = {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
        };
        if (parsed.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: unknown, finish: string | null) =>
            `data: ${JSON.stringify({
              id: "chatcmpl-up",
              object: "chat.completion.chunk",
              model: "chat-1",
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`;
          response.end(
            chunk({ role: "assistant", content: "Hello" }, null) +
              chunk({ content: " world" }, "stop") +
              `data: ${JSON.stringify({ id: "chatcmpl-up", object: "chat.completion.chunk", model: "chat-1", choices: [], usage })}\n\n` +
              "data: [DONE]\n\n",
          );
          return;
        }
        return json(200, {
          id: "chatcmpl-up",
          object: "chat.completion",
          model: "chat-1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello world" },
              finish_reason: "stop",
            },
          ],
          usage,
        });
      }
      if (request.url === "/anthropic/v1/messages") {
        if (request.headers["x-api-key"] !== CLAUDE_KEY)
          return json(401, {
            type: "error",
            error: { type: "authentication_error", message: "bad" },
          });
        return json(200, anthropicAnswer);
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    anthropicAnswer,
  };
}

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

void test("the gateway paths are the model protocol paths and never a management route", () => {
  for (const pathname of [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/messages/count_tokens",
    "/v1/models",
    "/v1/models/openrouter/deepseek/deepseek-chat",
    "/v1/models/gemini-2.5-pro:generateContent",
    "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
    "/v1alpha/models",
    "/chat/completions",
    "/responses",
    "/messages",
    "/messages/count_tokens",
    "/models",
    "//v1//chat/completions/",
  ])
    assert.equal(isModelGatewayPath(pathname), true, pathname);
  for (const pathname of [
    "/",
    "/openapi.json",
    "/health/live",
    "/api/v1/providers",
    "/v1",
    "/v1/chat",
    "/v1/responsesx",
    "/v1/engines",
    "/v1bet/models",
    // The Codex passthrough is mounted on the loopback listener only.
    "/backend-api/codex/responses",
  ])
    assert.equal(isModelGatewayPath(pathname), false, pathname);
  for (const pathname of [
    "/backend-api/codex",
    "/backend-api/codex/responses",
    "//backend-api/codex/models/",
  ])
    assert.equal(isCodexPassthroughPath(pathname), true, pathname);
  for (const pathname of ["/backend-api/codexx", "/backend-api", "/codex"])
    assert.equal(isCodexPassthroughPath(pathname), false, pathname);
  // Every documented management operation stays with Fastify.
  const management = apiCatalog.filter((entry) => entry.path.startsWith("/v1"));
  assert.ok(management.length > 30);
  for (const entry of management)
    assert.equal(
      isModelGatewayPath(entry.path.replace(/\{[^}]+\}/g, "probe")),
      false,
      `${entry.method} ${entry.path}`,
    );
});

void test(
  "model calls through the daemon port reach the upstream with the provider credential and are recorded",
  { timeout: 60_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "harnesshub-mount-",
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
    const fake = await upstream(t);
    const apiBodies: string[] = [];
    const client = await connectLocal({
      dataDir,
      url: hub.url,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        apiBodies.push(await response.clone().text());
        return response;
      },
    });
    const info = await client.system.info();
    const port = new URL(hub.url).port;
    assert.deepEqual(info.gateway, {
      openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
      anthropicBaseUrl: `http://127.0.0.1:${port}`,
      geminiBaseUrl: `http://127.0.0.1:${port}`,
    });
    const gateway = info.gateway!;

    await client.providers.create({
      id: "fake",
      endpoints: { chat: `${fake.base}/openai/v1` },
      models: {
        source: "manual",
        list: [{ id: "chat-1", price: { input: 1, output: 2 } }],
        expose: "all",
      },
      credential: { value: CHAT_KEY },
    });
    await client.providers.create({
      id: "claude",
      endpoints: { anthropic: `${fake.base}/anthropic` },
      auth: { apiKeyHeader: "x-api-key" },
      models: { source: "manual", list: [{ id: "claude-x" }], expose: "all" },
      credential: { value: CLAUDE_KEY },
    });
    const { key } = await client.gatewayKeys.create({
      name: "e2e",
      modelAllow: ["fake/*", "claude/claude-x"],
    });
    const gatewayResponses: string[] = [];
    const call = async (
      url: string,
      init: {
        headers: Record<string, string>;
        body?: unknown;
        method?: string;
      },
    ) => {
      const response = await fetch(url, {
        method: init.method ?? "POST",
        headers: { "content-type": "application/json", ...init.headers },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await response.text();
      gatewayResponses.push(text);
      return { status: response.status, headers: response.headers, text };
    };
    const chat = {
      model: "fake/chat-1",
      messages: [{ role: "user", content: "Say hello" }],
    };

    // OpenAI Chat with the Gateway Key; the upstream sees the provider credential and the wire name.
    const answered = await call(`${gateway.openaiBaseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${key}` },
      body: chat,
    });
    assert.equal(answered.status, 200, answered.text);
    const completion = JSON.parse(answered.text) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(completion.choices[0]?.message.content, "Hello world");
    const upstreamChat = fake.seen.at(-1)!;
    assert.equal(upstreamChat.headers.authorization, `Bearer ${CHAT_KEY}`);

    assert.equal(
      (JSON.parse(upstreamChat.body) as { model: string }).model,
      "chat-1",
    );

    // Streaming and the path without /v1 go through the same listener.
    const streamed = await call(`${gateway.openaiBaseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${key}` },
      body: { ...chat, stream: true },
    });
    assert.equal(streamed.status, 200);
    assert.match(
      streamed.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    assert.match(streamed.text, /Hello/);
    assert.match(streamed.text, /data: \[DONE\]/);
    const prefixless = await call(
      `${gateway.anthropicBaseUrl}/chat/completions`,
      {
        headers: { authorization: `Bearer ${key}` },
        body: chat,
      },
    );
    assert.equal(prefixless.status, 200);

    // Anthropic inbound to an Anthropic endpoint passes through byte for byte.
    const message = await call(`${gateway.anthropicBaseUrl}/v1/messages`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        model: "claude/claude-x",
        max_tokens: 16,
        messages: [{ role: "user", content: "Salut" }],
      },
    });
    assert.equal(message.status, 200, message.text);
    assert.equal(message.text, fake.anthropicAnswer);
    const upstreamMessage = fake.seen.at(-1)!;
    assert.equal(upstreamMessage.path, "/anthropic/v1/messages");
    assert.equal(upstreamMessage.headers["x-api-key"], CLAUDE_KEY);
    assert.equal(upstreamMessage.headers.authorization, undefined);
    assert.equal(
      (JSON.parse(upstreamMessage.body) as { model: string }).model,
      "claude-x",
    );

    // The model list shows what the key allows.
    const models = await call(`${gateway.openaiBaseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(models.status, 200);
    assert.deepEqual(
      (JSON.parse(models.text) as { data: Array<{ id: string }> }).data
        .map((item) => item.id)
        .sort(),
      ["claude/claude-x", "fake/chat-1"],
    );

    // A wrong key is 401 and a model outside the allowlist 403; both are recorded.
    const before = fake.seen.length;
    const badKey = `hhk_c_aaaaaaaaaaaa_${"A".repeat(43)}`;
    const unauthorized = await call(
      `${gateway.openaiBaseUrl}/chat/completions`,
      {
        headers: { authorization: `Bearer ${badKey}` },
        body: chat,
      },
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("x-hh-error-source"), "gateway");
    const forbidden = await call(`${gateway.anthropicBaseUrl}/v1/messages`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        model: "claude/claude-other",
        max_tokens: 16,
        messages: [{ role: "user", content: "Salut" }],
      },
    });
    assert.equal(forbidden.status, 403, forbidden.text);
    assert.equal(
      fake.seen.length,
      before,
      "rejected calls never reach the upstream",
    );

    const calls = await client.modelCalls.list({ limit: 50 });
    const rejected = calls.items.filter((item) => item.rejected);
    assert.deepEqual(
      rejected.map((item) => [item.status, item.rejectReason]).sort(),
      [
        [401, "invalid_key"],
        [403, "model_not_allowed"],
      ],
    );
    const served = calls.items.filter((item) => !item.rejected);
    assert.equal(served.length, 4);
    assert.ok(served.every((item) => item.status === 200));

    // Usage reflects the calls; the priced provider has a cost.
    const byProvider = await client.usage.aggregate({ groupBy: "provider" });
    const bucket = (name: string) =>
      byProvider.items.find((item) => item.key === name);
    assert.equal(bucket("fake")?.calls, 3);
    assert.equal(bucket("fake")?.usage.output, 9);
    assert.notEqual(bucket("fake")?.cost.amount, "0");
    assert.equal(bucket("claude")?.calls, 1);
    assert.equal(bucket("claude")?.usage.input, 10);
    assert.equal(bucket("")?.calls, 2);

    // The Codex passthrough is mounted on the daemon's port; a browser
    // origin is refused by the gateway before anything is forwarded.
    const codex = await call(
      `http://127.0.0.1:${port}/backend-api/codex/responses`,
      { headers: { origin: "https://example.com" }, body: { model: "gpt-5" } },
    );
    assert.equal(codex.status, 403, codex.text);
    assert.equal(codex.headers.get("x-hh-error-source"), "gateway");
    assert.match(codex.text, /origin_forbidden/);

    // Management routes on the same port still answer from Fastify.
    const engines = await fetch(`${hub.url}/v1/engines`);
    assert.equal(engines.status, 200);
    assert.equal(engines.headers.get("x-hh-error-source"), null);
    for (const entry of apiCatalog.filter(
      (item) => item.method === "GET" && item.path.startsWith("/v1/"),
    )) {
      const probe = await fetch(
        `${hub.url}${entry.path.replace(/\{[^}]+\}/g, "probe")}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      await probe.body?.cancel();
      assert.equal(probe.headers.get("x-hh-error-source"), null, entry.path);
      assert.notEqual(probe.status, 401, entry.path);
    }

    // No credential value appears in any response, log line, ledger row or plain file.
    running = false;
    await hub.server.close();
    const log = await readFile(hub.logFile, "utf8");
    const ledger = JSON.stringify(calls);
    for (const secret of [
      CHAT_KEY,
      CLAUDE_KEY,
      key.split("_").slice(3).join("_"),
    ]) {
      for (const text of [
        ...gatewayResponses,
        ...apiBodies.filter((body) => !body.includes('"key":"hhk_')),
        log,
        ledger,
      ])
        assert.equal(text.includes(secret), false);
    }
    for (const file of await files(dataDir)) {
      const bytes = await readFile(file);
      for (const secret of [CHAT_KEY, CLAUDE_KEY])
        assert.equal(
          bytes.includes(secret),
          false,
          path.relative(dataDir, file),
        );
    }
  },
);

void test(
  "large bodies skip Fastify's limit and shutdown drains a call in flight before the stores close",
  { timeout: 60_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "harnesshub-mount-drain-",
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
    const hub = await start();
    let running = true;
    defer(() => (running ? hub.server.close() : undefined));
    // An upstream that answers small requests and never answers a "hang" request.
    const received: number[] = [];
    let hanging: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => (hanging = resolve));
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push(body.length);
        if (body.includes('"hang"')) {
          hanging?.();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            model: "m",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const client = await connectLocal({ dataDir, url: hub.url });
    await client.providers.create({
      id: "slow",
      endpoints: {
        chat: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
      credential: { value: CHAT_KEY },
    });
    const { key } = await client.gatewayKeys.create({
      name: "drain",
      modelAllow: ["slow/*"],
    });
    const post = (content: string) =>
      fetch(`${hub.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "slow/m",
          messages: [{ role: "user", content }],
        }),
      });

    // 3 MiB is over Fastify's 2 MiB body limit; the gateway (64 MiB) takes it.
    const large = await post("x".repeat(3 * 1024 * 1024));
    assert.equal(large.status, 200, await large.clone().text());
    await large.body?.cancel();
    assert.ok(received[0]! > 3 * 1024 * 1024);

    // Closing the daemon aborts the call in flight and commits its entry before the store closes.
    const inFlight = post("hang").then(
      async (response) => ({
        status: response.status,
        text: await response.text(),
      }),
      (error: unknown) => ({ status: 0, text: String(error) }),
    );
    await hung;
    running = false;
    await hub.server.close();
    const outcome = await inFlight;
    assert.notEqual(outcome.status, 200);

    const reopened = await start();
    try {
      const calls = await (
        await connectLocal({ dataDir, url: reopened.url })
      ).modelCalls.list({});
      const cancelled = calls.items.find((item) => item.status === 499);
      assert.ok(
        cancelled,
        JSON.stringify(calls.items.map((item) => item.status)),
      );
      assert.equal(cancelled.errorClass, "client_cancelled");
    } finally {
      await reopened.server.close();
    }
  },
);
