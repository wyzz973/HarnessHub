// SPDX-License-Identifier: MIT
/**
 * ChatGPT-mode Codex through the real daemon (ADR 0030): the Gateway Key
 * that wiring puts in the path of `openai_base_url` serves HarnessHub's
 * models, the client's ChatGPT sign-in never reaches the upstream, a wrong
 * or revoked key is refused, and no key text is kept in the data
 * directory, the logs or an OTLP export. The upstream is the strict fake
 * provider; nothing goes to ChatGPT.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import {
  credentialFingerprint,
  startFakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-codex-key-path-upstream-5e1b";
const CHATGPT_TOKEN = "synthetic-chatgpt-access-token.Qk3_canary-91d0";
const ACCOUNT = "acct-synthetic-codex-key-path-4c2a";
const ORIGINAL = `model = "gpt-5.5-codex"\n`;
const MODEL = "fake/small";

/** A loopback OTLP/HTTP collector that keeps every request. */
async function collector(t: TestContext) {
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push(
        `${request.url ?? ""}\n${Buffer.concat(chunks).toString("utf8")}`,
      );
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

/** A Responses call as ChatGPT-mode Codex sends it, its own sign-in included. */
async function codex(
  origin: string,
  key: string | undefined,
  stream: boolean,
): Promise<{ status: number; text: string }> {
  const response = await fetch(
    `${origin}/backend-api/codex${key ? `/${key}` : ""}/responses`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CHATGPT_TOKEN}`,
        "chatgpt-account-id": ACCOUNT,
        originator: "codex_cli_rs",
        "user-agent": "codex_cli_rs/0.150.0 (Mac OS 15.6.1; arm64)",
      },
      body: JSON.stringify({
        model: MODEL,
        stream,
        instructions: "You are Codex.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      }),
    },
  );
  return { status: response.status, text: await response.text() };
}

void test(
  "ChatGPT-mode Codex calls HarnessHub's models with the key in its path, its sign-in stays with it, and the key is kept nowhere",
  { timeout: 120_000 },
  async (t) => {
    const stub = await collector(t);
    const saved = process.env.HARNESSHUB_LOG_LEVEL;
    process.env.HARNESSHUB_LOG_LEVEL = "debug";
    t.after(() => {
      if (saved === undefined) delete process.env.HARNESSHUB_LOG_LEVEL;
      else process.env.HARNESSHUB_LOG_LEVEL = saved;
    });
    // The upstream refuses Codex's own sign-in headers outright.
    const fake = await startFakeProvider({
      models: ["small"],
      keys: { upstream: UPSTREAM_KEY },
      forbiddenHeaders: ["chatgpt-account-id", "originator"],
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { directory, defer } = await temporaryDirectory(t, "hh-codexkey-");
    const home = path.join(directory, "home");
    const config = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, ORIGINAL);
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
      wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
      otlp: { endpoint: stub.endpoint },
    });
    let running = true;
    defer(() => (running ? hub.server.close() : undefined));
    const client = await connectLocal({ dataDir, url: hub.url });
    await client.providers.create({
      id: "fake",
      endpoints: { responses: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "small" }], expose: "all" },
      credential: { value: UPSTREAM_KEY },
    });
    const origin = (await client.system.info()).gateway!.anthropicBaseUrl;
    const keyOf = async () => {
      const match =
        /openai_base_url = ".+\/backend-api\/codex\/(hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]{43})"/.exec(
          await readFile(config, "utf8"),
        );
      assert.ok(match, "the key is in openai_base_url");
      return match[1]!;
    };

    await client.agents.wire("codex", {
      options: { codexAuth: "chatgpt" },
      expect: await client.agents.plan("codex", {
        options: { codexAuth: "chatgpt" },
      }),
    });
    const first = await keyOf();
    for (const stream of [true, false]) {
      const answer = await codex(origin, first, stream);
      assert.equal(answer.status, 200, answer.text);
    }
    // A wrong key, or none, is refused here; neither is echoed.
    const wrong = first.replace(/_[A-Za-z0-9_-]{43}$/, `_${"B".repeat(43)}`);
    for (const key of [wrong, undefined]) {
      const refused = await codex(origin, key, false);
      assert.equal(refused.status, 401);
      assert.ok(!refused.text.includes(first));
      assert.ok(!refused.text.includes(wrong));
      assert.ok(!refused.text.includes("backend-api"));
    }
    // A new key: the old one stops working at once.
    await client.agents.rotate("codex");
    const second = await keyOf();
    assert.notEqual(second, first);
    assert.equal((await codex(origin, first, false)).status, 401);
    assert.equal((await codex(origin, second, true)).status, 200);
    // Unwiring revokes the key and puts the file back.
    await client.agents.unwire("codex");
    assert.equal(await readFile(config, "utf8"), ORIGINAL);
    assert.equal((await codex(origin, second, false)).status, 401);
    const keys = (await client.gatewayKeys.list()).items.filter(
      (key) => key.scope.kind === "agent",
    );
    assert.equal(keys.length, 2);
    assert.ok(keys.every((key) => key.revokedAt !== undefined));

    // The ledger names the key by id only, and the path without it.
    const calls = (await client.modelCalls.list({ limit: 50 })).items;
    const served = calls.filter((call) => call.status === 200);
    assert.equal(served.length, 3);
    for (const call of calls) {
      assert.equal(call.inbound.path, "/backend-api/codex/responses");
      assert.ok(!JSON.stringify(call).includes("hhk_"));
    }

    // The upstream saw the provider's credential and none of Codex's.
    await fake.idle();
    assert.deepEqual(fake.violations(), []);
    const fingerprint = await credentialFingerprint(UPSTREAM_KEY);
    const records = fake.records();
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.status, 200);
      assert.equal(record.auth, "ok");
      assert.equal(record.keyFingerprint, fingerprint);
    }

    // Closing flushes the OTLP export; then nothing anywhere holds a key.
    running = false;
    await hub.server.close();
    assert.ok(stub.received.length >= 1, "the calls were exported");
    const log = path.join(dataDir, "logs", "gateway.log");
    assert.ok((await stat(log)).size > 0, "the gateway log was written");
    const secrets = [first, second, wrong, CHATGPT_TOKEN, ACCOUNT];
    const scanned = [
      ...(await files(dataDir)),
      ...(await files(configDir)),
      ...(await files(home)),
    ];
    assert.ok(
      scanned.some((file) => file.endsWith(".sqlite")),
      "the database is among the files",
    );
    for (const file of scanned) {
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
