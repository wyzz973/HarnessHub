// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError, type HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import {
  credentialFingerprint,
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const FAKE_KEY = "synthetic-lan-share-upstream-canary-71c2";
const MODEL = "upstream-sim";

/** One daemon on a fresh data root with the file secret backend; `restart` reuses the root. */
async function daemon(t: TestContext, name: string) {
  const { directory, defer } = await temporaryDirectory(t, `hh-lan-${name}-`);
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
  const state = { hub: await start(), open: true };
  defer(() => (state.open ? state.hub.server.close() : undefined));
  const connect = async () => connectLocal({ dataDir, url: state.hub.url });
  const self = {
    dataDir,
    client: await connect(),
    get url() {
      return state.hub.url;
    },
    async stop() {
      state.open = false;
      await state.hub.server.close();
    },
    async restart() {
      if (state.open) await self.stop();
      state.hub = await start();
      state.open = true;
      self.client = await connect();
    },
  };
  return self;
}

async function fake(t: TestContext): Promise<FakeProvider> {
  // Whitelist mode: only the portable fields of each protocol pass. A
  // translated call streams from its Chat upstream and asks for the usage
  // with `stream_options`, which this gateway always sends today; strict
  // Chat upstreams reject it, so it is declared here rather than hidden.
  const provider = await startFakeProvider({
    mode: "whitelist",
    models: [MODEL],
    keys: { upstream: FAKE_KEY },
    fields: { chat: { declared: { topLevel: ["stream_options"] } } },
    chunkDelayMs: 0,
  });
  t.after(() => provider.close());
  return provider;
}

/** The three providers of the daemon in front of the fake: one per key scheme. */
async function fakeProviders(client: HarnessHubClient, url: string) {
  const models = {
    source: "manual" as const,
    list: [{ id: MODEL, contextWindow: 64000, maxOutputTokens: 8192 }],
    expose: "all" as const,
  };
  await client.providers.create({
    id: "fake",
    endpoints: { chat: `${url}/v1`, responses: `${url}/v1` },
    models,
    credential: { value: FAKE_KEY },
  });
  await client.providers.create({
    id: "fakeant",
    endpoints: { anthropic: url },
    auth: { apiKeyHeader: "x-api-key" },
    models,
    credential: { value: FAKE_KEY },
  });
  await client.providers.create({
    id: "fakegem",
    endpoints: { gemini: url },
    auth: { apiKeyHeader: "x-goog-api-key" },
    models,
    credential: { value: FAKE_KEY },
  });
}

function problem(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}

async function post(
  url: string,
  key: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

function chat(model: string, stream = false) {
  return {
    model,
    stream,
    max_tokens: 64,
    messages: [{ role: "user", content: "Say hello." }],
  };
}

async function ledger(client: HarnessHubClient): Promise<ModelCallEntry[]> {
  const page = await client.modelCalls.list({ limit: 200 });
  return [...page.items].reverse() as unknown as ModelCallEntry[];
}

void test(
  "LAN sharing serves only model routes with LAN keys, refuses the management API and survives a restart",
  { timeout: 90_000 },
  async (t) => {
    const upstream = await fake(t);
    const b = await daemon(t, "share");
    await fakeProviders(b.client, upstream.url);
    const lanKey = await b.client.gatewayKeys.create({
      name: "laptop",
      modelAllow: ["fake/*"],
      allowLan: true,
    });
    assert.equal(lanKey.gatewayKey.allowLan, true);
    const plainKey = await b.client.gatewayKeys.create({
      name: "local",
      modelAllow: ["fake/*"],
    });
    // A key usable from the local network always expires.
    await assert.rejects(
      b.client.gatewayKeys.create({
        name: "forever",
        modelAllow: ["fake/*"],
        allowLan: true,
        expiresAt: null,
      }),
      problem("GATEWAY_KEY_INVALID", 400),
    );

    const initial = await b.client.gatewayShare.status();
    assert.deepEqual(initial, {
      lan: { enabled: false, names: [] },
      listening: false,
      urls: [],
    });
    await assert.rejects(
      b.client.gatewayShare.update({ lan: { enabled: true } }),
      (error: unknown) => {
        problem("GATEWAY_SHARE_INVALID", 400)(error);
        assert.equal(
          (error as HarnessHubError).problem.errors?.[0]?.pointer,
          "/lan/host",
        );
        return true;
      },
    );
    const shared = await b.client.gatewayShare.update({
      lan: { enabled: true, host: "127.0.0.1", port: 0 },
    });
    assert.equal(shared.listening, true);
    const lanPort = shared.boundPort!;
    assert.ok(lanPort > 0);
    const lanUrl = `http://127.0.0.1:${lanPort}`;
    assert.deepEqual(shared.urls, [lanUrl]);
    const file = JSON.parse(
      await readFile(path.join(b.dataDir, "gateway-sharing.json"), "utf8"),
    ) as unknown;
    assert.deepEqual(file, {
      schemaVersion: 1,
      lan: { enabled: true, host: "127.0.0.1", port: 0, names: [] },
    });

    // Model calls on the LAN listener: only the LAN key.
    const accepted = await post(
      `${lanUrl}/v1/chat/completions`,
      lanKey.key,
      chat(`fake/${MODEL}`),
    );
    assert.equal(accepted.status, 200, accepted.text);
    const refused = await post(
      `${lanUrl}/v1/chat/completions`,
      plainKey.key,
      chat(`fake/${MODEL}`),
    );
    assert.equal(refused.status, 403);
    assert.equal(
      (JSON.parse(refused.text) as { error: { code: string } }).error.code,
      "source_not_allowed",
    );
    // The same LAN key works on loopback like any key.
    assert.equal(
      (
        await post(
          `${b.url}/v1/chat/completions`,
          lanKey.key,
          chat(`fake/${MODEL}`),
        )
      ).status,
      200,
    );

    // Nothing but the model protocol paths exists on the LAN listener,
    // whatever credential is presented.
    const token = (
      await readFile(path.join(b.dataDir, "admin.token"), "utf8")
    ).trim();
    for (const [method, route] of [
      ["GET", "/api/v1/system/info"],
      ["GET", "/api/v1/gateway/share"],
      ["PUT", "/api/v1/gateway/share"],
      ["GET", "/api/v1/gateway-keys"],
      ["GET", "/v1/engines"],
      ["GET", "/v1/sessions"],
      ["GET", "/health/live"],
      ["GET", "/openapi.json"],
      ["GET", "/"],
    ] as const) {
      const response = await fetch(`${lanUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === "PUT" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "PUT"
          ? { body: JSON.stringify({ lan: { enabled: false } }) }
          : {}),
      });
      assert.equal(response.status, 404, route);
      assert.equal(response.headers.get("x-hh-error-source"), "gateway");
      assert.deepEqual(await response.json(), {
        error: {
          code: "route_not_found",
          message: "The LAN listener serves the model gateway paths only",
        },
      });
    }
    // The same token works on loopback, so the 404s are the listener's.
    assert.equal(
      (
        await fetch(`${b.url}/api/v1/system/info`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    assert.equal((await b.client.gatewayShare.status()).listening, true);

    // A port in use is refused and nothing changes.
    await assert.rejects(
      b.client.gatewayShare.update({
        lan: {
          enabled: true,
          host: "127.0.0.1",
          port: Number(new URL(b.url).port),
        },
      }),
      problem("GATEWAY_SHARE_LISTEN_FAILED", 409),
    );
    const unchanged = await b.client.gatewayShare.status();
    assert.equal(unchanged.boundPort, lanPort);
    assert.equal(unchanged.lan.port, 0);

    // The setting survives a restart (port 0 binds anew).
    await b.restart();
    const restarted = await b.client.gatewayShare.status();
    assert.equal(restarted.listening, true);
    const nextUrl = `http://127.0.0.1:${restarted.boundPort!}`;
    assert.equal(
      (
        await post(
          `${nextUrl}/v1/chat/completions`,
          lanKey.key,
          chat(`fake/${MODEL}`, true),
        )
      ).status,
      200,
    );

    // Off: the listener closes; the setting keeps its address.
    const off = await b.client.gatewayShare.update({
      lan: { enabled: false, host: "127.0.0.1", port: 0 },
    });
    assert.deepEqual(off, {
      lan: { enabled: false, host: "127.0.0.1", port: 0, names: [] },
      listening: false,
      urls: [],
    });
    await assert.rejects(
      fetch(`${nextUrl}/v1/models`, {
        headers: { authorization: `Bearer ${lanKey.key}` },
      }),
    );
    await b.restart();
    assert.equal((await b.client.gatewayShare.status()).listening, false);

    // An address that cannot be bound at startup does not stop the daemon;
    // the status says why, and sharing can still be changed.
    const busy = createServer();
    busy.listen(0, "127.0.0.1");
    await once(busy, "listening");
    t.after(() => new Promise<void>((resolve) => busy.close(() => resolve())));
    const busyPort = (busy.address() as { port: number }).port;
    await b.stop();
    await writeFile(
      path.join(b.dataDir, "gateway-sharing.json"),
      JSON.stringify({
        schemaVersion: 1,
        lan: { enabled: true, host: "127.0.0.1", port: busyPort, names: [] },
      }),
    );
    await b.restart();
    const failed = await b.client.gatewayShare.status();
    assert.equal(failed.lan.enabled, true);
    assert.equal(failed.listening, false);
    assert.match(failed.error ?? "", /the port is in use/);
    assert.equal(
      (
        await b.client.gatewayShare.update({
          lan: { enabled: true, host: "127.0.0.1", port: 0 },
        })
      ).listening,
      true,
    );

    // A settings file that is not valid stops the start with the reason.
    await b.stop();
    await writeFile(
      path.join(b.dataDir, "gateway-sharing.json"),
      JSON.stringify({ schemaVersion: 1, lan: { enabled: true } }),
    );
    await assert.rejects(b.restart(), /gateway-sharing\.json is not valid/);

    assert.deepEqual(upstream.violations(), []);
  },
);

void test(
  "a HarnessHub uses another one as a relay provider: passthrough in every protocol, translated once, live model list",
  { timeout: 90_000 },
  async (t) => {
    const upstream = await fake(t);
    // B: the machine with the upstream providers, sharing on the LAN.
    const b = await daemon(t, "b");
    await fakeProviders(b.client, upstream.url);
    const lanKey = await b.client.gatewayKeys.create({
      name: "workstation-a",
      modelAllow: ["fake/*", "fakeant/*", "fakegem/*"],
      allowLan: true,
    });
    const share = await b.client.gatewayShare.update({
      lan: { enabled: true, host: "127.0.0.1", port: 0 },
    });
    const remote = share.urls[0]!;

    // A: the preset on B's LAN address with B's LAN key.
    const a = await daemon(t, "a");
    const preset = (await a.client.presets.list()).items.find(
      (item) => item.id === "harnesshub-remote",
    );
    assert.ok(preset);
    assert.equal(preset.kind, "relay");
    assert.deepEqual(Object.keys(preset.endpoints).sort(), [
      "anthropic",
      "chat",
      "gemini",
      "responses",
    ]);
    const office = await a.client.providers.create({
      preset: "harnesshub-remote",
      id: "office",
      endpoints: {
        chat: `${remote}/v1`,
        responses: `${remote}/v1`,
        anthropic: remote,
        gemini: remote,
      },
      credential: { value: lanKey.key },
    });
    assert.equal(office.kind, "relay");
    const refreshed = await a.client.providers.refreshModels("office");
    assert.deepEqual(
      refreshed.models.list.map((model) => model.id),
      [`fake/${MODEL}`, `fakeant/${MODEL}`, `fakegem/${MODEL}`],
    );
    assert.deepEqual(refreshed.models.list[0], {
      id: `fake/${MODEL}`,
      contextWindow: 64000,
      maxOutputTokens: 8192,
    });
    const aKey = await a.client.gatewayKeys.create({
      name: "client",
      modelAllow: ["office/*"],
    });
    const models = (await (
      await fetch(`${a.url}/v1/models`, {
        headers: { authorization: `Bearer ${aKey.key}` },
      })
    ).json()) as { data: { id: string; context_window?: number }[] };
    assert.deepEqual(
      models.data.map((model) => [model.id, model.context_window]),
      [
        [`office/fake/${MODEL}`, 64000],
        [`office/fakeant/${MODEL}`, 64000],
        [`office/fakegem/${MODEL}`, 64000],
      ],
    );

    // One call per inbound protocol, each passed through by A and by B.
    const calls: Array<{
      route: string;
      body: unknown;
      headers?: Record<string, string>;
      protocol: string;
      ref: string;
    }> = [
      {
        route: "/v1/chat/completions",
        body: chat(`office/fake/${MODEL}`),
        protocol: "chat",
        ref: `fake/${MODEL}`,
      },
      {
        route: "/v1/chat/completions",
        body: chat(`office/fake/${MODEL}`, true),
        protocol: "chat",
        ref: `fake/${MODEL}`,
      },
      {
        route: "/v1/responses",
        body: {
          model: `office/fake/${MODEL}`,
          input: "Say hello.",
          max_output_tokens: 64,
        },
        protocol: "responses",
        ref: `fake/${MODEL}`,
      },
      {
        route: "/v1/messages",
        body: {
          model: `office/fakeant/${MODEL}`,
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "Say hello." }],
        },
        headers: { "anthropic-version": "2023-06-01" },
        protocol: "anthropic",
        ref: `fakeant/${MODEL}`,
      },
      {
        route: `/v1beta/models/office/fakegem/${MODEL}:generateContent`,
        body: { contents: [{ role: "user", parts: [{ text: "Say hello." }] }] },
        protocol: "gemini",
        ref: `fakegem/${MODEL}`,
      },
    ];
    for (const call of calls) {
      const answer = await post(
        `${a.url}${call.route}`,
        aKey.key,
        call.body,
        call.headers,
      );
      assert.equal(answer.status, 200, `${call.route}: ${answer.text}`);
      assert.match(answer.text, /OK/, call.route);
    }
    // An Anthropic request for B's Chat-only provider: A passes it through,
    // B translates it, once.
    const translated = await post(
      `${a.url}/v1/messages`,
      aKey.key,
      {
        model: `office/fake/${MODEL}`,
        max_tokens: 64,
        messages: [{ role: "user", content: "Say hello." }],
      },
      { "anthropic-version": "2023-06-01" },
    );
    assert.equal(translated.status, 200, translated.text);
    assert.equal(
      (JSON.parse(translated.text) as { type: string }).type,
      "message",
    );

    const onA = await ledger(a.client);
    const onB = await ledger(b.client);
    assert.equal(onA.length, calls.length + 1);
    assert.equal(onB.length, calls.length + 1);
    for (const entry of onA) {
      assert.equal(entry.provider, "office");
      assert.equal(entry.mode, "passthrough");
      assert.equal(entry.upstreamProtocol, entry.inbound.protocol);
      assert.equal(entry.keyId, aKey.gatewayKey.keyId);
      assert.equal(entry.status, 200);
    }
    assert.deepEqual(
      onA.map((entry) => entry.modelRef),
      [...calls.map((call) => `office/${call.ref}`), `office/fake/${MODEL}`],
    );
    for (const [index, entry] of onB.entries()) {
      assert.equal(entry.keyId, lanKey.gatewayKey.keyId);
      assert.equal(entry.status, 200);
      assert.equal(
        entry.modelRef,
        onA[index]!.modelRef!.slice("office/".length),
      );
      assert.equal(entry.inbound.protocol, onA[index]!.inbound.protocol);
    }
    assert.deepEqual(
      onB.map((entry) => entry.mode),
      [...calls.map(() => "passthrough"), "translated"],
    );
    assert.equal(onB.at(-1)!.upstreamProtocol, "chat");
    // A's usage is what B reported, which is the upstream's; through B's
    // translation to Anthropic the reasoning tokens are part of the output,
    // since Anthropic usage has no separate count.
    for (const [index, entry] of onA.slice(0, calls.length).entries())
      assert.deepEqual(entry.usage, onB[index]!.usage, String(index));
    const viaAnthropic = onA.at(-1)!.usage!;
    const upstreamUsage = onB.at(-1)!.usage!;
    assert.equal(viaAnthropic.input, upstreamUsage.input);
    assert.equal(
      viaAnthropic.output,
      upstreamUsage.output + upstreamUsage.reasoning,
    );

    // count_tokens: forwarded through A and B to the native Anthropic
    // upstream; for B's Chat-only provider B estimates and A says so.
    const counted = await post(
      `${a.url}/v1/messages/count_tokens`,
      aKey.key,
      {
        model: `office/fakeant/${MODEL}`,
        messages: [{ role: "user", content: "Count these words, please." }],
      },
      { "anthropic-version": "2023-06-01" },
    );
    assert.equal(counted.status, 200, counted.text);
    assert.equal(counted.headers.get("x-hh-token-count"), "upstream");
    const estimated = await post(
      `${a.url}/v1/messages/count_tokens`,
      aKey.key,
      {
        model: `office/fake/${MODEL}`,
        messages: [{ role: "user", content: "Count these words, please." }],
      },
      { "anthropic-version": "2023-06-01" },
    );
    assert.equal(estimated.status, 200, estimated.text);
    assert.equal(estimated.headers.get("x-hh-token-count"), "estimated");

    // The upstream saw only B's credential, the wire model and portable fields.
    await upstream.idle();
    const records = upstream.records();
    assert.equal(records.length, calls.length + 2);
    const fingerprint = await credentialFingerprint(FAKE_KEY);
    for (const record of records) {
      assert.equal(record.auth, "ok");
      assert.equal(record.keyFingerprint, fingerprint);
      assert.equal(record.status, 200);
    }
    assert.ok(records.some((record) => record.path.endsWith("/count_tokens")));
    assert.deepEqual(upstream.violations(), []);
  },
);
