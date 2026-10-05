// SPDX-License-Identifier: MIT
/**
 * The on/off switches, through the daemon: a credential switched off or on
 * (Magpie `SetKeyOn`, the last one on stays on, one switched back on is
 * tried at once), a provider switched off (Magpie `provider off`: no
 * candidates, gone from `/v1/models`, the wiring catalog and automatic
 * groups, passed over by route groups, its agents marked rather than
 * rewritten) and Gateway Keys renamed, suspended and resumed. The upstream
 * is the strict fake provider; every key is synthetic.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const FIRST = "sk-synthetic-switches-first-0001";
const SECOND = "sk-synthetic-switches-second-0002";
const FIELDS = { chat: { allowed: { topLevel: ["stream_options"] } } };

/** A daemon with a temporary wiring home. */
async function daemon(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "hh-switches-");
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
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  const v1 = (await client.system.info()).gateway!.openaiBaseUrl;
  return { client, home, v1 };
}

function problem(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    assert.equal(error.status, status);
    return true;
  };
}

/** A chat call with `key`: its status and body. */
async function chat(v1: string, key: string, model: string, text = "hello") {
  const response = await fetch(`${v1}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: text }],
    }),
  });
  return { status: response.status, text: await response.text() };
}

async function models(v1: string, key: string) {
  const response = await fetch(`${v1}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return {
    status: response.status,
    ids: response.ok
      ? ((await response.json()) as { data: { id: string }[] }).data
          .map((model) => model.id)
          .sort()
      : [],
    text: response.ok ? "" : await response.text(),
  };
}

/** Polls `check` until it holds or ten seconds pass. */
async function eventually(
  check: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(50);
  }
}

void test(
  "a credential switched off is not asked, the last one on stays on, and one switched back on, or whose provider is, is asked at once",
  { timeout: 120_000 },
  async (t) => {
    // The first request saying REST-n is refused with a 429, which rests
    // that credential for a minute; the next one asked answers.
    const fake = await startFakeProvider({
      models: ["m"],
      keys: { first: FIRST, second: SECOND },
      fields: FIELDS,
      chunkDelayMs: 0,
      script: {
        turns: [
          { when: { contains: "REST-1" }, status: 429, error: "slow down" },
          { when: { contains: "REST-2" }, status: 429, error: "slow down" },
          { repeat: true, text: "fine" },
        ],
      },
    });
    t.after(() => fake.close());
    const { client, v1 } = await daemon(t);
    await client.providers.create({
      id: "relay",
      endpoints: { chat: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "m" }], expose: "all" },
      credential: { value: FIRST },
    });
    const second = await client.credentials.add("relay", {
      name: "second",
      value: SECOND,
    });
    const first = (await client.credentials.list("relay")).items[0]!;
    const { key } = await client.gatewayKeys.create({
      name: "k",
      modelAllow: ["relay/*"],
    });
    const asked = async (text?: string) => {
      const before = fake.records().length;
      const answer = await chat(v1, key, "relay/m", text);
      assert.equal(answer.status, 200, answer.text);
      await fake.idle();
      return fake
        .records(fake.records()[before - 1]?.seq ?? 0)
        .map((record) => record.keyId);
    };
    const restOf = async (id: string) =>
      (await client.routing.state()).items.find(
        (item) => item.credential === id,
      );

    assert.deepEqual(await asked("REST-1"), ["first", "second"]);
    assert.equal((await restOf(first.id))?.state, "open");
    // The provider switched off and on again: its credentials' rests go.
    await client.providers.update("relay", { enabled: false });
    assert.equal((await restOf(first.id))?.state, "open");
    await client.providers.update("relay", { enabled: true });
    assert.equal((await restOf(first.id))?.state, "closed");
    assert.deepEqual(await asked(), ["first"]);

    assert.deepEqual(await asked("REST-2"), ["first", "second"]);
    assert.equal((await restOf(first.id))?.state, "open");
    const off = await client.credentials.setEnabled("relay", first.id, false);
    assert.equal(off.enabled, false);
    await assert.rejects(
      client.credentials.setEnabled("relay", second.id, false),
      problem("CREDENTIAL_LAST_ENABLED", 409),
    );
    await assert.rejects(
      client.credentials.setEnabled("relay", "nope", false),
      problem("CREDENTIAL_NOT_FOUND", 404),
    );
    assert.deepEqual(
      (await client.credentials.list("relay")).items.map((item) => [
        item.id,
        item.enabled,
      ]),
      [
        [first.id, false],
        [second.id, true],
      ],
    );
    const state = await restOf(first.id);
    assert.equal(state?.enabled, false);
    assert.deepEqual(
      await asked(),
      ["second"],
      "an off credential is not asked",
    );

    // Switched back on, it starts without the minute's rest it had.
    const on = await client.credentials.setEnabled("relay", first.id, true);
    assert.equal(on.enabled, true);
    const lifted = await restOf(first.id);
    assert.equal(lifted?.state, "closed");
    assert.equal(lifted?.restingUntil, undefined);
    assert.equal(lifted?.lastFailure, undefined);
    assert.deepEqual(await asked(), ["first"]);
    // Switching on what is on changes nothing.
    assert.deepEqual(
      await client.credentials.setEnabled("relay", first.id, true),
      on,
    );
  },
);

void test(
  "a provider switched off serves no calls and offers no models; its agents are marked, not rewritten, and switched on it serves again",
  { timeout: 120_000 },
  async (t) => {
    const fake = await startFakeProvider({
      models: ["big", "small"],
      keys: { upstream: FIRST },
      fields: FIELDS,
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { client, home, v1 } = await daemon(t);
    for (const [id, list] of [
      ["fake", [{ id: "big" }, { id: "small" }]],
      ["spare", [{ id: "small" }]],
    ] as const)
      await client.providers.create({
        id,
        endpoints: { chat: `${fake.url}/v1` },
        models: { source: "manual", list: [...list], expose: "all" },
        credential: { value: FIRST },
      });
    await client.routeGroups.create({
      id: "g",
      members: ["fake/small", "spare/small"],
      strategy: "order",
    });
    const { key } = await client.gatewayKeys.create({
      name: "k",
      modelAllow: ["fake/*", "spare/*", "group/g", "group/auto-small"],
    });
    const config = path.join(home, ".config", "opencode", "opencode.json");
    await client.agents.wire("opencode", {
      model: "fake/big",
      expect: await client.agents.plan("opencode", { model: "fake/big" }),
    });
    const wired = await readFile(config, "utf8");
    const served = async (model: string) => {
      const answer = await chat(v1, key, model);
      assert.equal(answer.status, 200, answer.text);
      const [entry] = (await client.modelCalls.list({ limit: 1 })).items;
      return entry!.attempts.map((attempt) => attempt.provider);
    };
    assert.deepEqual((await models(v1, key)).ids, [
      "fake/big",
      "fake/small",
      "group/auto-small",
      "group/g",
      "spare/small",
    ]);
    assert.deepEqual(await served("group/g"), ["fake"]);

    const off = await client.providers.update("fake", { enabled: false });
    assert.equal(off.enabled, false);
    assert.equal((await client.providers.get("fake")).enabled, false);
    // Only spare serves small now: the automatic group of two is gone.
    assert.deepEqual((await models(v1, key)).ids, ["group/g", "spare/small"]);
    const refused = await chat(v1, key, "fake/small");
    assert.equal(refused.status, 400);
    assert.match(refused.text, /fake\/small: the provider is switched off/);
    assert.deepEqual(
      await served("group/g"),
      ["spare"],
      "the group passes over it",
    );
    assert.ok(
      !(await client.autoGroups.list()).items.some(
        (group) => group.id === "auto-small",
      ),
    );
    // The wiring catalog does not offer its models either.
    await assert.rejects(
      client.agents.plan("crush", { model: "fake/small" }),
      problem("AGENT_MODEL_UNAVAILABLE", 400),
    );
    await eventually(
      async () =>
        (await client.agents.get("opencode")).wiring?.attention?.code ===
        "AGENT_MODEL_UNAVAILABLE",
      "the agent wired to its model marked",
    );
    assert.equal(await readFile(config, "utf8"), wired, "not rewritten");

    const on = await client.providers.update("fake", { enabled: true });
    assert.equal(on.enabled, undefined, "on is stored as no flag");
    assert.deepEqual(await served("fake/small"), ["fake"]);
    assert.ok((await models(v1, key)).ids.includes("group/auto-small"));
    await eventually(
      async () =>
        (await client.agents.get("opencode")).wiring?.attention === undefined,
      "the mark cleared",
    );
  },
);

void test(
  "a Gateway Key is renamed, suspended with 401 key_suspended and kept, and resumed; an agent's key too, and unwiring still revokes it",
  { timeout: 120_000 },
  async (t) => {
    const fake = await startFakeProvider({
      models: ["m"],
      keys: { upstream: FIRST },
      fields: FIELDS,
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { client, v1 } = await daemon(t);
    await client.providers.create({
      id: "relay",
      endpoints: { chat: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "m" }], expose: "all" },
      credential: { value: FIRST },
    });
    const created = await client.gatewayKeys.create({
      name: "laptop",
      modelAllow: ["relay/*"],
    });
    const id = created.gatewayKey.keyId;
    assert.equal((await chat(v1, created.key, "relay/m")).status, 200);

    const renamed = await client.gatewayKeys.rename(id, "work laptop");
    assert.equal(renamed.name, "work laptop");
    assert.deepEqual(renamed.scope, { kind: "client", name: "work laptop" });

    const suspended = await client.gatewayKeys.suspend(id);
    assert.ok(suspended.suspendedAt);
    assert.equal(suspended.revokedAt, undefined);
    const refused = await chat(v1, created.key, "relay/m");
    assert.equal(refused.status, 401);
    assert.equal(
      (JSON.parse(refused.text) as { error: { code: string } }).error.code,
      "key_suspended",
    );
    assert.equal((await models(v1, created.key)).status, 401);
    const [entry] = (await client.modelCalls.list({ limit: 1 })).items;
    assert.equal(entry?.rejectReason, "key_suspended");
    assert.equal(entry?.keyId, id);
    // Kept, and suspending again keeps the first time.
    assert.ok(
      (await client.gatewayKeys.list()).items.some((key) => key.keyId === id),
    );
    assert.equal(
      (await client.gatewayKeys.suspend(id)).suspendedAt,
      suspended.suspendedAt,
    );

    const resumed = await client.gatewayKeys.resume(id);
    assert.equal(resumed.suspendedAt, undefined);
    assert.equal((await chat(v1, created.key, "relay/m")).status, 200);
    assert.deepEqual(await client.gatewayKeys.resume(id), resumed);

    // An agent's key: the wiring shows it suspended; unwiring revokes it.
    await client.agents.wire("opencode", {
      model: "relay/m",
      expect: await client.agents.plan("opencode", { model: "relay/m" }),
    });
    const agentKey = (await client.agents.get("opencode")).wiring!.keyId!;
    await client.gatewayKeys.suspend(agentKey);
    assert.equal(
      (await client.agents.get("opencode")).wiring?.keyState,
      "suspended",
    );
    await client.agents.unwire("opencode");
    const revoked = await client.gatewayKeys.get(agentKey);
    assert.ok(revoked.revokedAt);
    await assert.rejects(
      client.gatewayKeys.resume(agentKey),
      problem("GATEWAY_KEY_REVOKED", 409),
    );
    await assert.rejects(
      client.gatewayKeys.suspend("aaaaaaaaaaaa"),
      problem("GATEWAY_KEY_NOT_FOUND", 404),
    );
  },
);
