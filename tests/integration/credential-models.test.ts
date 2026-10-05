// SPDX-License-Identifier: MIT
/**
 * Credentials that each see models of their own (Magpie `Model.Keys` and
 * `keyFit`), through the daemon: the model-list refresh asks with each
 * credential and records which ones list each model; routing leaves out a
 * credential whose list lacks the requested model (one not read is not
 * known, so it is asked), says so in the ledger and the routing state, and
 * puts first the credential whose protocol takes the request as it is. The
 * upstream is the strict fake provider with a list per key; every key is
 * synthetic.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const WIDE = "sk-synthetic-credential-models-wide-0001";
const NARROW = "sk-synthetic-credential-models-narrow-0002";
const LATE = "sk-synthetic-credential-models-late-0003";
const FIELDS = { chat: { allowed: { topLevel: ["stream_options"] } } };

async function daemon(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "hh-cred-models-");
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
  const origin = (await client.system.info()).gateway!.anthropicBaseUrl;
  return { client, origin };
}

void test(
  "a refresh records which credentials list each model, and a call skips a credential whose list lacks it",
  { timeout: 120_000 },
  async (t) => {
    const fake = await startFakeProvider({
      models: ["shared", "wide-only"],
      keys: { wide: WIDE, narrow: NARROW, late: LATE },
      keyModels: { narrow: ["shared"] },
      fields: FIELDS,
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { client, origin } = await daemon(t);
    // The narrow key comes first: before this, every call asked it first.
    await client.providers.create({
      id: "relay",
      endpoints: { chat: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "shared" }], expose: "all" },
      credential: { value: NARROW },
    });
    await client.credentials.add("relay", { name: "wide", value: WIDE });
    const refreshed = await client.providers.refreshModels("relay");
    const [narrow, wide] = refreshed.credentials.map((item) => item.id);
    assert.deepEqual(refreshed.models.listedFor, [narrow, wide]);
    assert.deepEqual(
      refreshed.models.list.map((model) => [model.id, model.credentials]),
      [
        ["shared", undefined],
        ["wide-only", [wide]],
      ],
    );

    const { key } = await client.gatewayKeys.create({
      name: "k",
      modelAllow: ["relay/*"],
    });
    const call = async (model: string) => {
      const before = fake.records().length;
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      assert.equal(response.status, 200, await response.text());
      await fake.idle();
      const [entry] = (await client.modelCalls.list({ limit: 1 })).items;
      return {
        keys: fake
          .records(fake.records()[before - 1]?.seq ?? 0)
          .map((record) => record.keyId),
        entry: entry!,
      };
    };
    const wideOnly = await call("relay/wide-only");
    assert.deepEqual(wideOnly.keys, ["wide"], "the narrow key is not asked");
    assert.deepEqual(
      wideOnly.entry.attempts.map((attempt) => attempt.credentialId),
      [wide],
    );
    assert.ok(wideOnly.entry.patches.includes("credential:unlisted:1"));
    const shared = await call("relay/shared");
    assert.deepEqual(shared.keys, ["narrow"], "both list it: in order");
    assert.ok(
      !shared.entry.patches.some((patch) =>
        patch.startsWith("credential:unlisted"),
      ),
    );

    const state = (await client.routing.state()).items;
    assert.deepEqual(
      state.map((item) => [item.credentialName, item.unlistedModels]),
      [
        ["default", ["wide-only"]],
        ["wide", []],
      ],
    );

    // A credential added since is not known either way: with the wide one
    // gone, it is asked; the narrow one still is not.
    await client.credentials.remove("relay", wide!);
    await client.credentials.add("relay", { name: "late", value: LATE });
    const late = await call("relay/wide-only");
    assert.deepEqual(late.keys, ["late"]);
  },
);

void test(
  "a credential whose list could not be read keeps what it listed last time, and one list clears what each listed",
  { timeout: 120_000 },
  async (t) => {
    const fake = await startFakeProvider({
      models: ["shared", "wide-only"],
      keys: { wide: WIDE, narrow: NARROW },
      keyModels: { narrow: ["shared"] },
      fields: FIELDS,
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { client } = await daemon(t);
    await client.providers.create({
      id: "relay",
      endpoints: { chat: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "shared" }], expose: "all" },
      credential: { value: WIDE },
    });
    const added = await client.credentials.add("relay", {
      name: "narrow",
      value: NARROW,
    });
    await client.providers.refreshModels("relay");
    // The narrow key's value goes bad: its list cannot be read now.
    await client.credentials.rotate(
      "relay",
      added.id,
      "sk-synthetic-credential-models-revoked-0009",
    );
    const kept = await client.providers.refreshModels("relay");
    assert.deepEqual(kept.models.listedFor?.length, 2);
    assert.deepEqual(
      kept.models.list.map((model) => [model.id, model.credentials?.length]),
      [
        ["shared", undefined],
        ["wide-only", 1],
      ],
    );
    // With one credential left, the list is one list again.
    await client.credentials.remove("relay", added.id);
    const single = await client.providers.refreshModels("relay");
    assert.equal(single.models.listedFor, undefined);
    assert.ok(single.models.list.every((model) => !model.credentials));
  },
);

void test(
  "the credential whose protocol takes the request as it is goes first",
  { timeout: 120_000 },
  async (t) => {
    const fake = await startFakeProvider({
      models: ["plain-x"],
      keys: { responsesKey: WIDE, chatKey: NARROW },
      fields: FIELDS,
      chunkDelayMs: 0,
    });
    t.after(() => fake.close());
    const { client, origin } = await daemon(t);
    await client.providers.create({
      id: "both",
      endpoints: { chat: `${fake.url}/v1`, responses: `${fake.url}/v1` },
      models: { source: "manual", list: [{ id: "plain-x" }], expose: "all" },
      credential: { value: WIDE, protocols: ["responses"] },
    });
    await client.credentials.add("both", {
      name: "chat",
      value: NARROW,
      protocols: ["chat"],
    });
    const { key } = await client.gatewayKeys.create({
      name: "k",
      modelAllow: ["both/*"],
    });
    for (const [pathname, body, expected] of [
      [
        "/v1/chat/completions",
        { messages: [{ role: "user", content: "hello" }] },
        ["chatKey", "chat"],
      ],
      ["/v1/responses", { input: "hello" }, ["responsesKey", "responses"]],
    ] as const) {
      const before = fake.records().at(-1)?.seq ?? 0;
      const response = await fetch(`${origin}${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "both/plain-x", ...body }),
      });
      assert.equal(response.status, 200, await response.text());
      await fake.idle();
      const records = fake.records(before);
      assert.equal(records.length, 1, pathname);
      assert.deepEqual(
        [records[0]!.keyId, records[0]!.protocol],
        expected,
        pathname,
      );
    }
  },
);
