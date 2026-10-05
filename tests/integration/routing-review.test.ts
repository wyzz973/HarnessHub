// SPDX-License-Identifier: MIT
/**
 * Routing findings of the second security review (2026-10-05, group F),
 * through the daemon: an upstream that echoes a request's fields cannot be
 * made to rest a shared credential (H2); a safety filter's refusal reaches
 * one other vendor at most (M2) and the dropped reply's tokens count (M3);
 * an agent's hidden models are not reached through a group or a bare name
 * (M4), and a bare name of what a key may not use answers as an unknown
 * one (L6); a call waits for a credential slot only so long (L7). The
 * upstreams are loopback servers and the strict fake provider; every key
 * is synthetic.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-routing-review-0001";
const FIELDS = { chat: { allowed: { topLevel: ["stream_options"] } } };
const HELLO = [{ role: "user", content: "hello" }];

async function daemon(t: TestContext, gatewayLimits?: unknown) {
  const { directory, defer } = await temporaryDirectory(t, "hh-routing-");
  const home = path.join(directory, "home");
  await mkdir(home, { recursive: true });
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
    ...(gatewayLimits === undefined ? {} : { gatewayLimits }),
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  const origin = (await client.system.info()).gateway!.anthropicBaseUrl;
  /** A Chat Completions call with `key`. */
  const chat = async (key: string, body: Record<string, unknown>) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  };
  return { client, origin, home, chat };
}

/** A loopback upstream answering `reply(body)` (status and JSON), and the bodies it got. */
async function upstream(
  t: TestContext,
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
  delayMs = 0,
) {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      bodies.push(body);
      const { status, json } = reply(body);
      setTimeout(() => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
  };
}

const ANSWER = (model: unknown) => ({
  status: 200,
  json: {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  },
});

/** One credential that two keys share, on an upstream that echoes unknown fields and refuses "BROKE" for want of credit. */
async function sharedCredential(t: TestContext) {
  const KNOWN = new Set(["model", "messages", "stream", "stream_options"]);
  const up = await upstream(t, (body) => {
    const unknown = Object.keys(body).find((name) => !KNOWN.has(name));
    if (unknown)
      // OpenAI's words for a field it does not know.
      return {
        status: 400,
        json: {
          error: {
            message: `Unrecognized request argument supplied: ${unknown}`,
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
      };
    return JSON.stringify(body.messages).includes("BROKE")
      ? {
          status: 402,
          json: { error: { message: "Insufficient Balance (MARKER-c41e)" } },
        }
      : ANSWER(body.model);
  });
  const { client, chat } = await daemon(t);
  await client.providers.create({
    id: "shared",
    endpoints: { chat: up.url },
    models: { source: "manual", list: [{ id: "m" }], expose: "all" },
    credential: { value: KEY },
  });
  const key = async (name: string) =>
    (await client.gatewayKeys.create({ name, modelAllow: ["shared/m"] })).key;
  const attacker = await key("attacker");
  const victim = await key("victim");
  const ask = (key: string, extra: Record<string, unknown> = {}) =>
    chat(key, { model: "shared/m", messages: HELLO, ...extra });
  return { up, client, ask, attacker, victim };
}

void test(
  "an upstream's echo of a request's fields rests no shared credential",
  { timeout: 120_000 },
  async (t) => {
    const { up, client, ask, attacker, victim } = await sharedCredential(t);
    for (const [field, times] of [
      ["the model you asked for does not exist", 1],
      ["quota limit reached|1799999999", 1],
      ["insufficient balance, please recharge", 1],
      ["illegal api invocation", 3],
      ["service overloaded", 3],
    ] as const) {
      for (let index = 0; index < times; index++)
        assert.equal((await ask(attacker, { [field]: 1 })).status, 400, field);
      const before = up.bodies.length;
      const served = await ask(victim);
      assert.equal(served.status, 200, `${field}: ${served.text}`);
      assert.equal(up.bodies.length, before + 1, `${field}: asked upstream`);
    }
    assert.deepEqual(
      (await client.routing.state()).items.filter(
        (item) => item.state !== "closed",
      ),
      [],
    );
  },
);

void test(
  "one key's failure rests a shared credential a minute, and another key is told its class, not its words",
  { timeout: 120_000 },
  async (t) => {
    const { client, ask, attacker, victim } = await sharedCredential(t);
    const broke = await ask(attacker, {
      messages: [{ role: "user", content: "BROKE" }],
    });
    assert.equal(broke.status, 402, broke.text);
    const cooling = await ask(victim);
    assert.ok(cooling.status >= 400, cooling.text);
    assert.match(cooling.text, /All candidates are cooling down/);
    assert.match(cooling.text, /insufficient_balance/);
    assert.doesNotMatch(cooling.text, /MARKER|Insufficient Balance/);
    const [state] = (await client.routing.state()).items;
    assert.equal(state?.state, "open");
    assert.ok(
      Date.parse(state!.restingUntil!) - Date.now() <= 60_000,
      `one key's failure rests a minute, not 30: ${state!.restingUntil}`,
    );
  },
);

const REFUSING = {
  when: { contains: "TRIGGER" },
  repeat: true,
  quirks: { refuse: "policy" },
};

/** A strict fake provider with `script`'s turns, closed after the test, and the daemon's provider for it. */
async function fakeProvider(
  t: TestContext,
  client: Awaited<ReturnType<typeof daemon>>["client"],
  id: string,
  turns: unknown[],
  keys: Record<string, string> = { upstream: KEY },
) {
  const fake = await startFakeProvider({
    models: ["m"],
    keys,
    fields: FIELDS,
    chunkDelayMs: 0,
    script: { turns },
  });
  t.after(() => fake.close());
  await client.providers.create({
    id,
    endpoints: { chat: `${fake.url}/v1` },
    models: { source: "manual", list: [{ id: "m" }], expose: "all" },
    credential: { value: Object.values(keys)[0]! },
  });
  return fake;
}

void test(
  "a safety filter's refusal reaches one other vendor at most",
  { timeout: 120_000 },
  async (t) => {
    const { client, chat } = await daemon(t);
    const fine = { repeat: true, text: "fine" };
    const fakes = [];
    for (let index = 0; index < 5; index++)
      fakes.push(await fakeProvider(t, client, `p${index}`, [REFUSING, fine]));
    await client.routeGroups.create({
      id: "g",
      members: fakes.map((_, index) => `p${index}/m`),
    });
    const { key } = await client.gatewayKeys.create({
      name: "group",
      modelAllow: ["group/g"],
    });
    const refused = await chat(key, {
      model: "group/g",
      messages: [{ role: "user", content: "please TRIGGER the filter" }],
    });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(
      fakes.map((fake) => fake.records().length),
      [1, 1, 0, 0, 0],
      "the first vendor and one other",
    );
  },
);

void test(
  "a safety filter's refusal is not put before the vendor's other accounts",
  { timeout: 120_000 },
  async (t) => {
    const { client, chat } = await daemon(t);
    const accounts = {
      a1: "sk-synthetic-acct-1",
      a2: "sk-synthetic-acct-2",
      a3: "sk-synthetic-acct-3",
      a4: "sk-synthetic-acct-4",
    };
    const vendor = await fakeProvider(
      t,
      client,
      "vendor",
      [REFUSING],
      accounts,
    );
    for (const [index, value] of [
      accounts.a2,
      accounts.a3,
      accounts.a4,
    ].entries())
      await client.credentials.add("vendor", {
        name: `acct${index + 2}`,
        value,
      });
    const { key } = await client.gatewayKeys.create({
      name: "single",
      modelAllow: ["vendor/m"],
    });
    const flagged = await chat(key, {
      model: "vendor/m",
      messages: [{ role: "user", content: "TRIGGER something" }],
    });
    assert.equal(flagged.status, 400, flagged.text);
    assert.deepEqual(
      vendor.records().map((record) => record.keyId),
      ["a1"],
    );
  },
);

void test(
  "the tokens of a reply a safety filter refused count in the entry and the key's budget",
  { timeout: 120_000 },
  async (t) => {
    const { client, chat } = await daemon(t);
    await fakeProvider(t, client, "silent", [
      {
        repeat: true,
        quirks: { safetyRefusal: true },
        usage: { input: 5000, output: 0 },
      },
    ]);
    await fakeProvider(t, client, "fine", [
      { repeat: true, text: "fine", usage: { input: 100, output: 10 } },
    ]);
    await client.routeGroups.create({
      id: "h",
      members: ["silent/m", "fine/m"],
    });
    const budgeted = await client.gatewayKeys.create({
      name: "budgeted",
      modelAllow: ["group/h"],
      quota: { budgets: [{ period: "day", tokens: 1_000_000 }] },
    });
    const answered = await chat(budgeted.key, {
      model: "group/h",
      messages: HELLO,
    });
    assert.equal(answered.status, 200, answered.text);
    const [entry] = (await client.modelCalls.list({ limit: 1 })).items;
    assert.equal(entry!.usage?.input, 5100);
    assert.ok(entry!.patches.includes("refused:usage:1"));
    const limit = await client.gatewayKeys.limit(budgeted.gatewayKey.keyId);
    assert.equal(limit.budgets[0]!.tokens, 5110);
  },
);

void test(
  "an agent's hidden model is not reached through a group or a bare name, and a group of hidden models is not listed",
  { timeout: 120_000 },
  async (t) => {
    const { client, origin, home, chat } = await daemon(t);
    const fake = (models: string[]) =>
      startFakeProvider({
        models,
        keys: { upstream: KEY },
        fields: FIELDS,
        chunkDelayMs: 0,
      });
    const pricey = await fake(["gpt-5"]);
    const cheap = await fake(["gpt-5", "small"]);
    t.after(() => pricey.close());
    t.after(() => cheap.close());
    for (const [id, up, list] of [
      ["pricey", pricey, ["gpt-5"]],
      ["cheap", cheap, ["gpt-5", "small"]],
    ] as const)
      await client.providers.create({
        id,
        endpoints: { chat: `${up.url}/v1` },
        models: {
          source: "manual",
          list: list.map((model) => ({ id: model })),
          expose: "all",
        },
        credential: { value: KEY },
      });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const choice = { model: "cheap/small", models: ["*"] };
    await client.agents.wire("claude", {
      ...choice,
      expect: await client.agents.plan("claude", choice),
    });
    await client.agents.setHidden("claude", ["pricey/gpt-5"]);
    const settings = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as { env: Record<string, string> };
    const token = settings.env.ANTHROPIC_AUTH_TOKEN!;
    for (const model of ["gpt-5", "group/auto-gpt-5", "GPT-5"]) {
      const answer = await chat(token, { model, messages: HELLO });
      assert.equal(answer.status, 200, `${model}: ${answer.text}`);
    }
    assert.equal(pricey.records().length, 0, "the hidden model was not asked");
    assert.equal(cheap.records().length, 3);

    // Both hidden: the group is not listed, and not usable by its name.
    await client.agents.setHidden("claude", ["pricey/gpt-5", "cheap/gpt-5"]);
    const listed = (await (
      await fetch(`${origin}/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { data: { id: string }[] };
    const ids = listed.data.map((item) => item.id);
    assert.ok(ids.includes("cheap/small"));
    assert.ok(!ids.includes("group/auto-gpt-5"), ids.join(", "));
    const explicit = await chat(token, {
      model: "group/auto-gpt-5",
      messages: HELLO,
    });
    assert.equal(explicit.status, 403, explicit.text);
    assert.equal(pricey.records().length + cheap.records().length, 3);
  },
);

void test(
  "a bare name of what a key may not use answers as an unknown name, and an ambiguous one names only what the key may use",
  { timeout: 120_000 },
  async (t) => {
    const { client, chat } = await daemon(t);
    const fakes = [];
    for (const [id, models] of [
      ["pricey", ["gpt-5", "dup-a"]],
      ["cheap", ["gpt-5", "small", "dup-a"]],
      ["internal-lab", ["secret-model"]],
    ] as const) {
      const fake = await startFakeProvider({
        models: [...models],
        keys: { upstream: KEY },
        fields: FIELDS,
        chunkDelayMs: 0,
      });
      t.after(() => fake.close());
      fakes.push(fake);
      await client.providers.create({
        id,
        endpoints: { chat: `${fake.url}/v1` },
        models: {
          source: "manual",
          list: models.map((model) => ({ id: model })),
          expose: "all",
        },
        credential: { value: KEY },
      });
    }
    await client.routeGroups.create({
      id: "finance-only",
      members: ["internal-lab/secret-model"],
    });
    const { key } = await client.gatewayKeys.create({
      name: "narrow",
      modelAllow: ["cheap/small"],
    });
    const message = async (model: string) => {
      const answer = await chat(key, { model, messages: HELLO });
      assert.equal(answer.status, 404, `${model}: ${answer.text}`);
      return (JSON.parse(answer.text) as { error: { message: string } }).error
        .message;
    };
    const unknown = await message("no-such-model");
    for (const name of ["gpt-5", "secret-model", "finance-only", "dup-a"])
      assert.equal(
        (await message(name)).replace(name, "no-such-model"),
        unknown,
        name,
      );
    assert.equal(
      (await chat(key, { model: "small", messages: HELLO })).status,
      200,
    );
    assert.deepEqual(
      fakes.map((fake) => fake.records().length),
      [0, 1, 0],
    );
    // Two models of the name the key may use (not their group): named, and
    // nothing else is counted or named.
    const two = await client.gatewayKeys.create({
      name: "two",
      modelAllow: ["pricey/*", "cheap/*"],
    });
    const ambiguous = await chat(two.key, { model: "dup-a", messages: HELLO });
    assert.equal(ambiguous.status, 400, ambiguous.text);
    assert.equal(
      (JSON.parse(ambiguous.text) as { error: { message: string } }).error
        .message,
      "dup-a names more than one model: cheap/dup-a, pricey/dup-a; name one as provider/model",
    );
  },
);

void test(
  "a call waits for a busy credential's slot only as long as slotWaitMs",
  { timeout: 120_000 },
  async (t) => {
    const up = await upstream(t, (body) => ANSWER(body.model), 3_000);
    const { client, chat } = await daemon(t, { slotWaitMs: 300 });
    await client.providers.create({
      id: "narrow",
      endpoints: { chat: up.url },
      models: { source: "manual", list: [{ id: "m" }], expose: "all" },
      credential: { value: KEY },
      limits: { concurrentPerCredential: 1, queuePerCredential: 4 },
    });
    const holder = (
      await client.gatewayKeys.create({
        name: "holder",
        modelAllow: ["narrow/m"],
      })
    ).key;
    const other = (
      await client.gatewayKeys.create({
        name: "other",
        modelAllow: ["narrow/m"],
      })
    ).key;
    const held = chat(holder, { model: "narrow/m", messages: HELLO });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    const waited = await chat(other, { model: "narrow/m", messages: HELLO });
    const took = Date.now() - started;
    assert.equal(waited.status, 429, waited.text);
    assert.match(waited.text, /no slot came free within 1 s/);
    assert.ok(
      took < 2_500,
      `refused after ${took} ms, not when the slot came free`,
    );
    assert.equal((await held).status, 200);
  },
);
