// SPDX-License-Identifier: MIT
/**
 * Refusals a 400 or 422 stands for, through the daemon: a route group of
 * two providers on strict fake upstreams, the first refusing in the words of
 * real vendors (the fake provider's `refuse`, `tokenFloor` and
 * `safetyRefusal` quirks), the ledger showing each attempt's class and
 * decision.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import {
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only: they never reach a real service.
const KEY = "sk-synthetic-refusal-failover-0001";
const FIELDS = { chat: { allowed: { topLevel: ["stream_options"] } } };

/** The first provider's turns, by a word of the user's message. */
const turn = (word: string, quirks: Record<string, unknown>) => ({
  when: { contains: word },
  text: "from first",
  repeat: true,
  quirks,
});

async function hub(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "hh-refusal-");
  const first = await startFakeProvider({
    models: ["m"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
    // Translated calls stream with usage, as OpenAI takes them.
    fields: FIELDS,
    script: {
      turns: [
        turn("SHAPE", { refuse: "shape" }),
        turn("POLICY", { refuse: "policy" }),
        turn("CHANNEL", { refuse: "channel" }),
        turn("BUSY", { refuse: "busy" }),
        turn("UNSERVED", { refuse: "unserved" }),
        turn("CLIENT", { refuse: "client" }),
        turn("FLOOR", { tokenFloor: 16 }),
        turn("REFUSAL", { safetyRefusal: true }),
        {
          when: { contains: "TEMPERATURE" },
          status: 400,
          error: "temperature must be at most 2",
          repeat: true,
        },
        { text: "from first", repeat: true },
      ],
    },
  });
  defer(() => first.close());
  const second = await startFakeProvider({
    models: ["m"],
    keys: { upstream: KEY },
    chunkDelayMs: 0,
    fields: FIELDS,
    script: { turns: [{ text: "from second", repeat: true }] },
  });
  defer(() => second.close());
  const dataDir = path.join(directory, "data");
  await mkdir(path.join(directory, "home"));
  const started = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: {
      home: path.join(directory, "home"),
      env: { PATH: path.join(directory, "bin") },
    },
  });
  defer(() => started.server.close());
  const client = await connectLocal({ dataDir, url: started.url });
  for (const [id, fake] of [
    ["first", first],
    ["second", second],
  ] as const)
    await client.providers.create({
      id,
      name: id,
      kind: "custom",
      endpoints: { chat: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "m" }], expose: "all" },
      credential: { value: KEY },
    });
  await client.routeGroups.create({
    id: "g",
    members: ["first/m", "second/m"],
  });
  const key = (
    await client.gatewayKeys.create({ name: "k", modelAllow: ["group/g"] })
  ).key;
  const info = await client.system.info();
  const v1 = info.gateway!.openaiBaseUrl;
  const anthropic = info.gateway!.anthropicBaseUrl;
  /** One call; its answer, and the ledger's attempts as `provider decision class`. */
  const call = async (
    text: string,
    extra: Record<string, unknown> = {},
    protocol: "chat" | "anthropic" = "chat",
  ) => {
    const response =
      protocol === "chat"
        ? await fetch(`${v1}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "group/g",
              messages: [{ role: "user", content: text }],
              ...extra,
            }),
          })
        : await fetch(`${anthropic}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "group/g",
              max_tokens: 64,
              messages: [{ role: "user", content: text }],
              ...extra,
            }),
          });
    const body = await response.text();
    const [entry] = (await client.modelCalls.list({ limit: 1 })).items;
    return {
      status: response.status,
      body,
      attempts: entry!.attempts.map(
        (item) => `${item.provider} ${item.decision} ${item.errorClass ?? "-"}`,
      ),
      patches: entry!.patches,
    };
  };
  return { call, first, second };
}

const calls = (fake: FakeProvider) => fake.records().length;

void test("through the daemon, a refusal another provider may answer goes to it, with the class in the ledger", async (t) => {
  const { call, first, second } = await hub(t);
  const failsOver = async (word: string, errorClass: string) => {
    const answered = await call(`${word} please`);
    assert.equal(answered.status, 200, `${word}: ${answered.body}`);
    assert.match(answered.body, /from second/, word);
    assert.deepEqual(
      answered.attempts,
      [`first failover ${errorClass}`, "second success -"],
      word,
    );
  };
  // These rest nothing: the first is asked first every time.
  await failsOver("SHAPE", "request_shape_unsupported");
  await failsOver("POLICY", "safety_refused");
  // A safety refusal with nothing said, whole and streamed, and through a
  // translated protocol.
  for (const extra of [{}, { stream: true }]) {
    const answered = await call("REFUSAL please", extra);
    assert.equal(answered.status, 200, answered.body);
    // A stream splits the text: "from s", "econd".
    assert.match(answered.body, /"from s/);
    assert.deepEqual(answered.attempts, [
      "first failover safety_refused",
      "second success -",
    ]);
  }
  const translated = await call("REFUSAL again", {}, "anthropic");
  assert.equal(translated.status, 200, translated.body);
  assert.match(translated.body, /from second/);
  // These count towards the first's breaker (it opens after three), and an
  // unserved model rests its credential and model for 10 minutes: last.
  await failsOver("CHANNEL", "client_refused");
  await failsOver("BUSY", "upstream_unavailable");
  await failsOver("UNSERVED", "model_not_found");
  await first.idle();
  await second.idle();
  assert.deepEqual(first.violations(), []);
  assert.deepEqual(second.violations(), []);
});

void test("through the daemon, the client's own 400 is neither retried nor failed over; a reply too short is asked again of the same provider", async (t) => {
  const { call, first, second } = await hub(t);
  for (const word of ["CLIENT", "TEMPERATURE"]) {
    const before = [calls(first), calls(second)];
    const refused = await call(`${word} please`);
    assert.ok(
      refused.status === 400 || refused.status === 422,
      `${word}: ${refused.status} ${refused.body}`,
    );
    assert.deepEqual(refused.attempts, ["first stop upstream_rejected"], word);
    await first.idle();
    assert.deepEqual(
      [calls(first) - before[0]!, calls(second) - before[1]!],
      [1, 0],
      `${word}: the first asked once, the second not at all`,
    );
  }
  const before = calls(second);
  const floored = await call("FLOOR please", { max_tokens: 1 });
  assert.equal(floored.status, 200, floored.body);
  assert.match(floored.body, /from first/);
  assert.deepEqual(floored.attempts, [
    "first retry upstream_rejected",
    "first success -",
  ]);
  assert.ok(floored.patches.includes("max-tokens:floor:16"));
  assert.equal(calls(second), before);
});
