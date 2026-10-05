// SPDX-License-Identifier: MIT
/**
 * Through the daemon: a provider's own concurrency limit serializes its
 * calls while another provider's run together, set through the API and
 * `hh provider limits`; and wired Claude Code's built-in model IDs stand in
 * for its tier models, while a name that resolves is served as it is.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-limits-0001";

/** A Chat Completions upstream answering after `ms`, counting the requests it holds at once and the models asked for. */
async function upstream(t: TestContext, ms: number) {
  let open = 0;
  let most = 0;
  const models: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model: string;
        stream?: boolean;
      };
      models.push(body.model);
      open++;
      most = Math.max(most, open);
      await delay(ms);
      open--;
      const message = { role: "assistant", content: "ok" };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "c",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}/v1`,
    most: () => most,
    models,
  };
}

async function daemon(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "hh-limits-");
  const home = path.join(directory, "home");
  await mkdir(path.join(home, ".claude"), { recursive: true });
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
    wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
  });
  defer(() => hub.server.close());
  return {
    hub,
    home,
    dataDir,
    directory,
    client: await connectLocal({ dataDir, url: hub.url }),
  };
}

function provider(
  id: string,
  base: string,
  models: string[],
  limits?: Record<string, number>,
) {
  return {
    id,
    kind: "custom" as const,
    endpoints: { chat: base },
    models: {
      source: "manual" as const,
      list: models.map((model) => ({ id: model })),
      expose: "all" as const,
    },
    credential: { value: KEY },
    ...(limits ? { limits } : {}),
  };
}

void test("a provider limited to one request at once serializes its calls through the daemon; another provider's run together", async (t) => {
  const { hub, client, dataDir } = await daemon(t);
  const slow = await upstream(t, 150);
  const free = await upstream(t, 150);
  await client.providers.create(
    provider("one", slow.base, ["m"], { concurrentPerCredential: 1 }),
  );
  await client.providers.create(provider("many", free.base, ["m"]));
  assert.deepEqual((await client.providers.get("one")).limits, {
    concurrentPerCredential: 1,
  });
  const key = await client.gatewayKeys.create({
    name: "limits",
    modelAllow: ["one/*", "many/*"],
  });
  const call = (model: string) =>
    fetch(`${hub.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
      }),
    }).then(async (response) => {
      await response.arrayBuffer();
      return response.status;
    });
  const statuses = await Promise.all([
    ...[1, 2, 3].map(() => call("one/m")),
    ...[1, 2, 3].map(() => call("many/m")),
  ]);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200]);
  assert.equal(slow.most(), 1);
  assert.equal(free.most(), 3);

  // Out of range: refused, naming the field.
  await assert.rejects(
    client.providers.update("many", { limits: { concurrentPerCredential: 0 } }),
    (error: unknown) =>
      error instanceof HarnessHubError && error.status === 400,
  );

  // hh provider limits shows, sets and clears them.
  const hh = (...args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(HH_ENTRY),
          ...args,
          "--url",
          hub.url,
          "--data-dir",
          dataDir,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`)),
      );
    });
  assert.match(
    await hh("provider", "limits", "one"),
    /one: 1 at once, the gateway's queue on each credential/,
  );
  assert.match(
    await hh(
      "provider",
      "limits",
      "many",
      "--concurrency",
      "2",
      "--queue",
      "4",
    ),
    /many: 2 at once, 4 waiting/,
  );
  assert.deepEqual((await client.providers.get("many")).limits, {
    concurrentPerCredential: 2,
    queuePerCredential: 4,
  });
  assert.match(
    await hh("provider", "limits", "many", "--clear"),
    /many follows the gateway's limits/,
  );
  assert.equal((await client.providers.get("many")).limits, undefined);
  await assert.rejects(
    hh("provider", "limits", "many", "--concurrency", "two"),
    /--concurrency takes a whole number/,
  );
});

void test("wired Claude Code's built-in model IDs stand in for its tier models; a name that resolves is served as it is", async (t) => {
  const { hub, client, home } = await daemon(t);
  const main = await upstream(t, 0);
  const side = await upstream(t, 0);
  await client.providers.create(provider("main", main.base, ["big"]));
  await client.providers.create(
    provider("side", side.base, ["small", "claude-opus-4-1"]),
  );
  const choice = {
    model: "main/big",
    tiers: { haiku: "side/small" },
    models: ["*"],
  };
  await client.agents.wire("claude", {
    ...choice,
    expect: await client.agents.plan("claude", choice),
  });
  const settings = JSON.parse(
    await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
  ) as {
    env: Record<string, string>;
  };
  const token = settings.env.ANTHROPIC_AUTH_TOKEN!;
  // As Claude Code sends them: Authorization with its token, Anthropic Messages.
  const ask = (model: string) =>
    fetch(`${hub.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    }).then(async (response) => {
      await response.arrayBuffer();
      return response.status;
    });
  assert.equal(await ask("claude-haiku-4-5-20251001"), 200);
  assert.equal(await ask("claude-sonnet-4-6"), 200);
  assert.equal(await ask("claude-opus-4-1"), 200);
  assert.deepEqual(side.models, ["small", "claude-opus-4-1"]);
  assert.deepEqual(main.models, ["big"]);
  const calls = (await client.modelCalls.list({ limit: 3 })).items.reverse();
  assert.deepEqual(
    calls.map((call) => [
      call.requestedModel,
      call.modelRef,
      call.patches.includes("stand-in"),
    ]),
    [
      ["claude-haiku-4-5-20251001", "side/small", true],
      ["claude-sonnet-4-6", "main/big", true],
      ["claude-opus-4-1", "side/claude-opus-4-1", false],
    ],
  );
  assert.ok(calls.every((call) => call.agent?.id === "claude"));
});
