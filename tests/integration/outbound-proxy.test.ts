// SPDX-License-Identifier: MIT
/**
 * The daemon's outbound proxy through its real entries: `startHub` with
 * `network` settings, providers created through the API, calls through the
 * shared gateway, and `hh config show`. HTTPS upstreams are a TLS front of
 * the strict fake provider that only the test proxies can reach by name.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { connectLocal } from "@harnesshub/sdk/local";
import type { ProviderInput } from "@harnesshub/sdk/client";
import { HH_ENTRY } from "../support/entries.js";
import {
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import {
  closedPort,
  startConnectProxy,
  startSocksProxy,
  startTlsFront,
  testCertificate,
  type ProxyRoute,
  type TestProxy,
} from "../support/proxy.js";
import { temporaryDirectory } from "../support/temporary.js";

const KEY = "sk-synthetic-proxy-upstream-0001";
const PROXY_PASSWORD = "synthetic-proxy-password-0002";
const MODEL = "upstream-sim";
const tls = testCertificate(["*.upstream.test", "localhost", "127.0.0.1"]);

async function upstream(
  t: TestContext,
): Promise<{ fake: FakeProvider; route: ProxyRoute }> {
  const fake = await startFakeProvider({
    models: [MODEL],
    keys: { main: KEY },
    chunkDelayMs: 0,
  });
  t.after(() => fake.close());
  const front = await startTlsFront(Number(new URL(fake.url).port), tls);
  t.after(() => front.close());
  return {
    fake,
    route: (host, port) =>
      host.endsWith(".upstream.test") && port === 443 ? front.port : undefined,
  };
}

async function proxyOf(
  t: TestContext,
  start: Promise<TestProxy>,
): Promise<TestProxy> {
  const proxy = await start;
  t.after(() => proxy.close());
  return proxy;
}

async function daemon(
  t: TestContext,
  network: unknown,
  extra: Record<string, unknown> = {},
) {
  const { directory, defer } = await temporaryDirectory(t, "hh-proxy-");
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: {
      autoRefresh: false,
      url: "https://catalog.upstream.test/api.json",
    },
    network,
    outboundCa: tls.cert,
    ...extra,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await hub.server.close();
  };
  defer(close);
  const client = await connectLocal({ dataDir, url: hub.url });
  const key = await client.gatewayKeys.create({
    name: "proxy",
    modelAllow: ["far/*", "near/*", "own/*", "broken/*"],
  });
  const ask = async (model: string) => {
    const response = await fetch(`${hub.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { hub, client, ask, close, dataDir, directory };
}

function provider(
  id: string,
  base: string,
  fields: Partial<ProviderInput> = {},
): ProviderInput {
  return {
    id,
    endpoints: { chat: `${base}/v1` },
    models: { source: "manual", list: [{ id: MODEL }], expose: "all" },
    credential: { value: KEY },
    ...fields,
  } as ProviderInput;
}

void test("the daemon's requests to providers, the catalog and OTLP go through network.proxy; loopback stays direct; a provider's own proxy wins", async (t) => {
  const { fake, route } = await upstream(t);
  const proxy = await proxyOf(t, startConnectProxy({ route }));
  const socks = await proxyOf(t, startSocksProxy({ route }));
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const { client, ask, close, dataDir } = await daemon(
    t,
    { proxy: proxy.url },
    { otlp: { endpoint: "https://otel.upstream.test/v1/traces" } },
  );
  await client.providers.create(provider("far", "https://api.upstream.test"));
  await client.providers.create(provider("near", fake.url));
  await client.providers.create(
    provider("own", "https://api.upstream.test", { proxy: socks.url }),
  );
  await client.providers.create(
    provider("broken", "https://api.upstream.test", { proxy: dead }),
  );

  // A model call to an HTTPS provider: CONNECT, then TLS to it inside the
  // tunnel. *.upstream.test does not resolve, so only the proxy reaches it.
  assert.equal((await ask(`far/${MODEL}`)).status, 200);
  assert.deepEqual(proxy.tunnels, ["api.upstream.test:443"]);
  // Its live model list and its test go the same way, on the same connection.
  const seen = fake.records().length;
  assert.ok(
    (await client.providers.refreshModels("far")).models.list.some(
      (model) => model.id === MODEL,
    ),
  );
  const tested = await client.providers.test("far");
  assert.ok(
    tested.endpoints.every((endpoint) => endpoint.ok),
    JSON.stringify(tested),
  );
  assert.deepEqual(
    fake
      .records()
      .slice(seen)
      .map((record) => [record.method, record.path]),
    [
      ["GET", "/v1/models"],
      ["POST", "/v1/chat/completions"],
    ],
  );
  assert.deepEqual(proxy.tunnels, ["api.upstream.test:443"]);
  // So does the catalog refresh, whatever its outcome.
  await client.catalog.refresh().catch(() => undefined);
  assert.equal(proxy.tunnels.at(-1), "catalog.upstream.test:443");
  const before = proxy.tunnels.length;

  // A loopback provider is called directly.
  assert.equal((await ask(`near/${MODEL}`)).status, 200);
  // A provider's own proxy is used instead of the daemon's.
  assert.equal((await ask(`own/${MODEL}`)).status, 200);
  assert.deepEqual(socks.tunnels, ["api.upstream.test:443"]);
  assert.equal(proxy.tunnels.length, before);

  // A dead proxy is a clear proxy failure, at once. The caller is told
  // briefly; the daemon's log names the proxy and the target.
  const started = Date.now();
  const failed = await ask(`broken/${MODEL}`);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(failed.status, 502);
  const error = failed.body.error as { code: string; message: string };
  assert.equal(error.code, "proxy_failed");
  assert.equal(error.message, "The outbound proxy could not be reached");
  assert.ok(!JSON.stringify(failed.body).includes(dead));
  const calls = await client.modelCalls.list({ limit: 1 });
  assert.equal(calls.items[0]!.errorClass, "proxy_failed");
  assert.ok(fake.violations().length === 0, JSON.stringify(fake.violations()));

  // The ledger's spans leave through the proxy too (exported as the daemon stops).
  await close();
  assert.ok(
    proxy.tunnels.includes("otel.upstream.test:443"),
    JSON.stringify(proxy.tunnels),
  );
  const logged = (
    await readFile(path.join(dataDir, "logs", "gateway.log"), "utf8")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === "network.proxy_failed");
  assert.ok(logged.length >= 1, "the proxy failure is logged");
  assert.equal(logged[0]!.proxy, dead);
  assert.equal(logged[0]!.target, "api.upstream.test:443");
  assert.match(
    String(logged[0]!.message),
    new RegExp(`The proxy ${dead.replace(/\./g, "\\.")} could not be reached`),
  );
});

void test("proxy credentials: the user in the address, the password from a secret reference, never written anywhere", async (t) => {
  const { route } = await upstream(t);
  const proxy = await proxyOf(
    t,
    startConnectProxy({ route, credentials: `alice:${PROXY_PASSWORD}` }),
  );
  const { directory } = await temporaryDirectory(t, "hh-proxy-secret-");
  const secret = path.join(directory, "proxy-password");
  await writeFile(secret, PROXY_PASSWORD, { mode: 0o600 });
  const address = new URL(proxy.url);
  address.username = "alice";
  const on = await daemon(t, {
    proxy: address.href,
    proxyPassword: { kind: "file", value: secret },
  });
  await on.client.providers.create(
    provider("far", "https://api.upstream.test"),
  );
  assert.equal((await on.ask(`far/${MODEL}`)).status, 200);
  assert.deepEqual(proxy.credentials, [`alice:${PROXY_PASSWORD}`]);
  // /system/info shows the proxy with the password masked, wherever it came from.
  const info = await on.client.system.info();
  assert.deepEqual(info.network, {
    proxy: `http://alice:***@${address.host}`,
    noProxy: [],
    source: null,
  });
  assert.ok(!JSON.stringify(info).includes(PROXY_PASSWORD));
  const fromEnvironment = await daemon(
    t,
    {
      proxy: `http://alice:${PROXY_PASSWORD}@${address.host}`,
      noProxy: [".corp.example"],
    },
    { networkSource: "env" },
  );
  const raw = await (
    await fetch(`${fromEnvironment.hub.url}/api/v1/system/info`, {
      headers: {
        authorization: `Bearer ${(await readFile(path.join(fromEnvironment.dataDir, "admin.token"), "utf8")).trim()}`,
      },
    })
  ).text();
  assert.ok(!raw.includes(PROXY_PASSWORD), raw);
  assert.deepEqual((JSON.parse(raw) as { network: unknown }).network, {
    proxy: `http://alice:***@${address.host}`,
    noProxy: [".corp.example"],
    source: "env",
  });
  await fromEnvironment.close();
  await on.close();
  // Neither the log nor the store holds the password.
  const files = await readdir(on.dataDir, { recursive: true });
  for (const file of files) {
    const full = path.join(on.dataDir, file);
    const text = await readFile(full).catch(() => undefined);
    if (text)
      assert.ok(
        !text.includes(PROXY_PASSWORD),
        `${file} holds the proxy password`,
      );
  }
  // A password that cannot be read fails the start, naming the setting.
  await assert.rejects(
    daemon(t, {
      proxy: address.href,
      proxyPassword: { kind: "file", value: path.join(directory, "missing") },
    }),
    (error: Error & { code?: string }) =>
      error.code === "CONFIG_INVALID" &&
      /network\.proxyPassword could not be read/.test(error.message),
  );
});

void test("hh config show takes the proxy from HTTPS_PROXY and masks its password; NO_PROXY entries it cannot read are ignored with a warning", async (t) => {
  const { directory } = await temporaryDirectory(t, "hh-proxy-config-");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(HH_ENTRY),
        "config",
        "show",
        "--json",
        "--config-dir",
        path.join(directory, "config"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HTTPS_PROXY: `http://alice:${PROXY_PASSWORD}@proxy.corp:3128`,
          // 192.168.* is how other tools write a range: ignored, not fatal.
          NO_PROXY: ".corp.example,10.0.0.0/8,192.168.*",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`)),
    );
  });
  assert.ok(!output.includes(PROXY_PASSWORD));
  const shown = JSON.parse(output) as {
    settings: { path: string; value: unknown; source: unknown }[];
    warnings: string[];
  };
  const setting = (key: string) =>
    shown.settings.find((item) => item.path === key)!;
  assert.equal(
    setting("network.proxy").value,
    "http://alice:***@proxy.corp:3128",
  );
  assert.deepEqual(setting("network.proxy").source, {
    kind: "env",
    name: "HTTPS_PROXY",
  });
  assert.deepEqual(setting("network.noProxy").value, [
    ".corp.example",
    "10.0.0.0/8",
  ]);
  assert.deepEqual(shown.warnings, [
    "NO_PROXY: 192.168.* is not a host, domain (.example.com), address or range; HarnessHub ignores that entry",
  ]);
});

void test("a provider's proxy is checked by the API and set with hh provider proxy", async (t) => {
  const { client, hub, dataDir } = await daemon(t, undefined);
  for (const [proxy, detail] of [
    ["http://alice:pw@proxy.corp:3128", /must not hold credentials/],
    ["http://alice@proxy.corp:3128", /must not hold credentials/],
    ["ftp://proxy.corp", /must be direct or a proxy address/],
  ] as const)
    await assert.rejects(
      client.providers.create(
        provider(`p${proxy.length}`, "https://api.upstream.test", { proxy }),
      ),
      (
        error: Error & {
          code?: string;
          problem?: { errors?: { pointer: string; detail: string }[] };
        },
      ) =>
        error.code === "PROVIDER_INVALID" &&
        error.problem?.errors?.some(
          (item) => item.pointer === "/proxy" && detail.test(item.detail),
        ) === true,
      proxy,
    );
  await client.providers.create(provider("far", "https://api.upstream.test"));
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
        { stdio: ["ignore", "pipe", "pipe"] },
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
    await hh("provider", "proxy", "far"),
    /far follows the daemon's proxy/,
  );
  assert.match(
    await hh("provider", "proxy", "far", "socks5://127.0.0.1:1080"),
    /far uses the proxy socks5:\/\/127\.0\.0\.1:1080/,
  );
  assert.equal(
    (await client.providers.get("far")).proxy,
    "socks5://127.0.0.1:1080",
  );
  assert.match(
    await hh("provider", "proxy", "far", "direct"),
    /no proxy \(direct\)/,
  );
  assert.match(
    await hh("provider", "proxy", "far", "default"),
    /follows the daemon's proxy/,
  );
  assert.equal((await client.providers.get("far")).proxy, undefined);
  await assert.rejects(
    hh("provider", "proxy", "far", "http://u:p@x:1"),
    /must not hold credentials/,
  );
});
