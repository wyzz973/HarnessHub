// SPDX-License-Identifier: MIT
/**
 * Agents that send no key of their own, through the real daemon (ADR 0033):
 * Command Code, fx and Muse are wired with the Gateway Key in the base URL's
 * path, call the gateway with it there, Muse lists its models from
 * `/muse-code/models`; a wrong key, a non-agent key and the LAN listener
 * are refused; and no key text is kept in the data directory, the logs or
 * an OTLP export. The upstream is the strict fake provider.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-agents-keypath-upstream-7c2d";
const MODEL = "fake/small";
const KEY = /\/k\/(hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]{43})\/v1/;

/** A loopback OTLP/HTTP collector that keeps every request body. */
async function collector(t: TestContext) {
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
  };
}

/** Every file under `root`, recursively. */
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

async function send(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

const chat = {
  model: MODEL,
  messages: [{ role: "user", content: "hello" }],
};
const responses = {
  model: MODEL,
  stream: true,
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ],
};

void test(
  "Command Code, fx and Muse call the gateway with the key in the path, which is refused elsewhere and kept nowhere",
  { timeout: 120_000 },
  async (t) => {
    const stub = await collector(t);
    const saved = process.env.HARNESSHUB_LOG_LEVEL;
    process.env.HARNESSHUB_LOG_LEVEL = "debug";
    t.after(() => {
      if (saved === undefined) delete process.env.HARNESSHUB_LOG_LEVEL;
      else process.env.HARNESSHUB_LOG_LEVEL = saved;
    });
    const fake = await startFakeProvider({
      models: ["small"],
      keys: { upstream: UPSTREAM_KEY },
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { directory, defer } = await temporaryDirectory(t, "hh-keypath-");
    const home = path.join(directory, "home");
    await mkdir(home, { recursive: true });
    const dataDir = path.join(directory, "data");
    const configDir = path.join(directory, "config");
    const hub = await startHub({
      dataDir,
      configDir,
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
      catalog: { autoRefresh: false },
      wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
      otlp: { endpoint: stub.endpoint },
    });
    let running = true;
    defer(() => (running ? hub.server.close() : undefined));
    const client = await connectLocal({ dataDir, url: hub.url });
    await client.providers.create({
      id: "fake",
      endpoints: { chat: `${fake.url}/v1`, responses: `${fake.url}/v1` },
      models: {
        source: "manual",
        list: [{ id: "small", contextWindow: 64_000 }],
        expose: "all",
      },
      credential: { value: UPSTREAM_KEY },
    });
    const origin = (await client.system.info()).gateway!.anthropicBaseUrl;

    const wired: Record<string, string> = {};
    for (const [id, file] of [
      ["commandcode", ".commandcode/providers.json"],
      ["fx", ".fx/settings.json"],
      ["muse", ".config/muse/settings.json"],
    ] as const) {
      await client.agents.wire(id, {
        model: MODEL,
        expect: await client.agents.plan(id, { model: MODEL }),
      });
      const match = KEY.exec(await readFile(path.join(home, file), "utf8"));
      assert.ok(match, `${id}'s base URL holds its key`);
      wired[id] = match[1]!;
    }
    const base = (id: string) => `${origin}/k/${wired[id]}/v1`;

    // Chat Completions for Command Code and fx, Responses for Muse; no header.
    for (const id of ["commandcode", "fx"]) {
      const answer = await send(`${base(id)}/chat/completions`, chat);
      assert.equal(answer.status, 200, `${id}: ${answer.text}`);
    }
    const streamed = await send(`${base("muse")}/responses`, responses);
    assert.equal(streamed.status, 200, streamed.text);
    const listed = await send(`${base("fx")}/models`);
    assert.equal(listed.status, 200, listed.text);
    assert.ok(listed.text.includes(MODEL));
    // Muse's model list, on the endpoint's host without the key.
    const muse = await send(`${origin}/muse-code/models`);
    assert.equal(muse.status, 200, muse.text);
    const entry = (
      JSON.parse(muse.text) as {
        data: Array<{
          id: string;
          metadata: Record<string, { limit: unknown }>;
        }>;
      }
    ).data.find((item) => item.id === MODEL);
    assert.deepEqual(entry?.metadata["muse-code"]?.limit, {
      context: 64_000,
      output: 32_000,
    });

    // Refusals: another key's text, no key at all, a client key, and two
    // different keys at once; none of them echoes a key.
    const wrong = wired.fx!.replace(
      /_[A-Za-z0-9_-]{43}$/,
      `_${"B".repeat(43)}`,
    );
    const client_ = await client.gatewayKeys.create({
      name: "plain client",
      modelAllow: ["fake/*"],
    });
    for (const [url, headers, code] of [
      [`${origin}/k/${wrong}/v1/models`, {}, 401],
      [`${origin}/k/not-a-key/v1/models`, {}, 401],
      [`${origin}/k/${client_.key}/v1/models`, {}, 401],
      [`${base("fx")}/models`, { authorization: `Bearer ${client_.key}` }, 401],
      [`${base("fx")}/../backend-api/codex/responses`, {}, 404],
    ] as const) {
      const refused = await send(url, undefined, headers);
      assert.equal(refused.status, code, `${url}: ${refused.text}`);
      for (const secret of [wrong, client_.key, ...Object.values(wired)])
        assert.ok(!refused.text.includes(secret));
    }
    // The client key itself works in a header, as it always did.
    assert.equal(
      (
        await send(`${origin}/v1/models`, undefined, {
          authorization: `Bearer ${client_.key}`,
        })
      ).status,
      200,
    );

    // The LAN listener of gateway sharing serves neither form.
    const shared = await client.gatewayShare.update({
      lan: { enabled: true, host: "127.0.0.1", port: 0 },
    });
    const lan = `http://127.0.0.1:${shared.boundPort!}`;
    for (const route of [
      `/k/${wired.fx}/v1/models`,
      `/k/${wired.fx}/v1/chat/completions`,
      "/muse-code/models",
    ]) {
      const refused = await send(
        `${lan}${route}`,
        route.endsWith("completions") ? chat : undefined,
      );
      assert.equal(refused.status, 404, `${route}: ${refused.text}`);
    }
    await client.gatewayShare.update({ lan: { enabled: false } });

    // The ledger has the path without the key, and the key's id only.
    const calls = (await client.modelCalls.list({ limit: 50 })).items;
    assert.ok(calls.some((call) => call.status === 200));
    for (const call of calls) {
      assert.ok(!call.inbound.path.includes("/k/"), call.inbound.path);
      assert.ok(!JSON.stringify(call).includes("hhk_"));
    }

    // Unwiring revokes the keys, puts the files back and stops Muse's list.
    for (const id of Object.keys(wired)) await client.agents.unwire(id);
    assert.equal((await send(`${base("fx")}/models`)).status, 401);
    assert.equal((await send(`${origin}/muse-code/models`)).status, 404);

    running = false;
    await hub.server.close();
    assert.ok(stub.received.length >= 1, "the calls were exported");
    const log = path.join(dataDir, "logs", "gateway.log");
    assert.ok((await stat(log)).size > 0, "the gateway log was written");
    const secrets = [...Object.values(wired), wrong];
    for (const file of [
      ...(await files(dataDir)),
      ...(await files(configDir)),
      ...(await files(home).catch(() => [])),
    ]) {
      const bytes = await readFile(file);
      for (const secret of secrets)
        assert.ok(
          !bytes.includes(secret),
          `${path.relative(directory, file)} holds ${secret.slice(0, 12)}…`,
        );
    }
    for (const body of stub.received)
      for (const secret of secrets) assert.ok(!body.includes(secret));
  },
);
