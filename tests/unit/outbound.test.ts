// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import test, { type TestContext } from "node:test";
import {
  parseProxyUrl,
  PROXY_FAILED,
  proxyChoiceProblem,
  proxyFailure,
  displayProxy,
} from "@harnesshub/core/outbound";
import {
  isLoopbackHost,
  isPrivateHost,
  noProxyMatches,
  noProxyProblem,
  Outbound,
  resolveNetworkSettings,
  splitNoProxy,
} from "@harnesshub/daemon/outbound";
import {
  closedPort,
  startConnectProxy,
  startSocksProxy,
  testCertificate,
  type ProxyRoute,
  type TestProxy,
} from "../support/proxy.js";

const tls = testCertificate([
  "api.upstream.test",
  "*.upstream.test",
  "localhost",
  "127.0.0.1",
]);

async function listen(t: TestContext, server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** A loopback HTTP and an HTTPS server answering `<scheme> <Host> <path>`. */
async function upstreams(
  t: TestContext,
): Promise<{ http: number; https: number }> {
  const answer =
    (scheme: string) => (request: IncomingMessage, response: ServerResponse) =>
      response.end(`${scheme} ${request.headers.host} ${request.url}`);
  return {
    http: await listen(t, createServer(answer("http"))),
    https: await listen(t, createHttpsServer(tls, answer("https"))),
  };
}

/** Tunnels to the upstreams: `*.upstream.test:80` to HTTP, `:443` to HTTPS. */
function routeTo(ports: { http: number; https: number }): ProxyRoute {
  return (host, port) =>
    host.endsWith("upstream.test")
      ? port === 443
        ? ports.https
        : port === 80
          ? ports.http
          : undefined
      : undefined;
}

function outbound(
  t: TestContext,
  proxy: string | undefined,
  options: {
    password?: string;
    noProxy?: string[];
    connectTimeoutMs?: number;
  } = {},
): Outbound {
  const network = resolveNetworkSettings({
    ...(proxy ? { proxy } : {}),
    ...(options.noProxy ? { noProxy: options.noProxy } : {}),
  });
  const result = new Outbound(network, options.password, {
    ca: tls.cert,
    ...(options.connectTimeoutMs
      ? { connectTimeoutMs: options.connectTimeoutMs }
      : {}),
  });
  t.after(() => result.close());
  return result;
}

async function proxyOf(
  t: TestContext,
  start: Promise<TestProxy>,
): Promise<TestProxy> {
  const proxy = await start;
  t.after(() => proxy.close());
  return proxy;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => assert.fail("expected the request to fail"),
    (caught: unknown) => caught,
  );
  assert.ok(
    error instanceof TypeError,
    `a fetch failure, not ${String(error)}`,
  );
  const proxied = proxyFailure(error);
  assert.ok(
    proxied,
    `the proxy is named as the cause: ${String((error as Error).cause)}`,
  );
  assert.equal(
    ((error as Error).cause as { code?: string }).code,
    PROXY_FAILED,
  );
  return proxied.message;
}

void test("proxy addresses: schemes, a bare host:port, credentials and display", () => {
  const bareAddress = parseProxyUrl("127.0.0.1:7890", "refuse");
  assert.ok("url" in bareAddress);
  assert.equal(bareAddress.url.href, "http://127.0.0.1:7890/");
  for (const good of [
    "http://proxy.corp:8080",
    "https://proxy.corp",
    "socks5://127.0.0.1:1080",
    "socks5h://h:1",
    "http://alice@proxy:3128",
  ])
    assert.ok("url" in parseProxyUrl(good, "refuse"), good);
  for (const [bad, why] of [
    ["ftp://proxy:21", /http, https, socks5/],
    ["http://proxy:8080/path", /without a path/],
    ["http://proxy:8080/?a=1", /without a path/],
    ["http://", /proxy address/],
    ["http://alice:s3cret@proxy:3128", /must not hold a password/],
  ] as const)
    assert.match(
      (parseProxyUrl(bad, "refuse") as { problem: string }).problem,
      why,
      bad,
    );
  assert.ok("url" in parseProxyUrl("http://alice:s3cret@proxy:3128", "allow"));
  assert.equal(
    displayProxy("http://alice:s3cret@proxy:3128"),
    "http://alice:***@proxy:3128",
  );
  assert.equal(displayProxy("socks5://proxy:1080"), "socks5://proxy:1080");
  assert.equal(proxyChoiceProblem("direct"), undefined);
  assert.equal(proxyChoiceProblem("socks5://127.0.0.1:1080"), undefined);
  assert.match(proxyChoiceProblem("http://alice@proxy:1")!, /credentials/);
  assert.match(proxyChoiceProblem("http://a:b@proxy:1")!, /credentials/);
  assert.match(
    proxyChoiceProblem("gopher://proxy")!,
    /direct or a proxy address/,
  );
  assert.match(proxyChoiceProblem(3)!, /string/);
});

void test("network settings: invalid values are refused with the setting named", () => {
  assert.deepEqual(resolveNetworkSettings(undefined), { noProxy: [] });
  assert.deepEqual(resolveNetworkSettings({ proxy: "direct" }), {
    noProxy: [],
  });
  assert.equal(
    resolveNetworkSettings({ proxy: "http://alice:pw@p:1" }).proxy?.password,
    "pw",
  );
  for (const [input, message] of [
    [[], /network must be an object/],
    [{ proxi: "http://p:1" }, /network.proxi is not a setting/],
    [{ proxy: 8080 }, /network.proxy must be/],
    [{ proxy: "ftp://p" }, /network.proxy must use/],
    [{ proxyPassword: "plain" }, /secret reference/],
    [{ proxyPassword: { kind: "env" } }, /secret reference/],
    [{ proxyPassword: { kind: "shell", value: "x" } }, /secret reference/],
    [{ noProxy: "example.com" }, /list of hosts/],
    [{ noProxy: ["exa mple"] }, /not a host/],
    [{ noProxy: ["10.0.0.0/33"] }, /not an address range/],
    [{ noProxy: ["example.com/8"] }, /not an address range/],
  ] as const)
    assert.throws(
      () => resolveNetworkSettings(input),
      (error: Error & { code?: string }) =>
        error.code === "CONFIG_INVALID" && message.test(error.message),
      JSON.stringify(input),
    );
  for (const entry of [
    "*",
    "example.com",
    ".example.com",
    "*.example.com",
    "example.com:8443",
    "10.1.2.3",
    "10.0.0.0/8",
    "fd00::/8",
    "::1",
    "[::1]:8080",
  ])
    assert.equal(noProxyProblem(entry), undefined, entry);
  assert.deepEqual(splitNoProxy("a.com, .b.com  c.com,,"), [
    "a.com",
    ".b.com",
    "c.com",
  ]);
});

void test("loopback, private networks and noProxy entries stay direct", () => {
  for (const host of [
    "localhost",
    "a.localhost",
    "127.0.0.1",
    "127.9.9.9",
    "[::1]",
    "::ffff:127.0.0.1",
  ])
    assert.ok(isLoopbackHost(host), host);
  for (const host of ["10.0.0.1", "example.com", "128.0.0.1", "[::2]"])
    assert.ok(!isLoopbackHost(host), host);
  for (const host of [
    "10.2.3.4",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.1.1",
    "100.64.0.1",
    "[fd12::1]",
    "[fe80::1]",
    "nas",
    "printer.local",
    "router.home.arpa",
    "svc.internal",
    "::ffff:192.168.1.1",
  ])
    assert.ok(isPrivateHost(host), host);
  for (const host of [
    "8.8.8.8",
    "172.32.0.1",
    "api.openai.com",
    "[2001:db8::1]",
    "100.128.0.1",
    "local.example.com",
  ])
    assert.ok(!isPrivateHost(host), host);
  assert.ok(noProxyMatches("example.com", "example.com", 443));
  assert.ok(noProxyMatches("example.com", "api.example.com", 443));
  assert.ok(noProxyMatches(".example.com", "api.example.com", 443));
  assert.ok(noProxyMatches("*.example.com", "example.com", 443));
  assert.ok(!noProxyMatches("example.com", "notexample.com", 443));
  assert.ok(noProxyMatches("example.com:8443", "example.com", 8443));
  assert.ok(!noProxyMatches("example.com:8443", "example.com", 443));
  assert.ok(noProxyMatches("203.0.113.0/24", "203.0.113.9", 443));
  assert.ok(!noProxyMatches("203.0.113.0/24", "203.0.114.9", 443));
  assert.ok(!noProxyMatches("203.0.113.0/24", "example.com", 443));
  assert.ok(noProxyMatches("2001:db8::/32", "[2001:db8::5]", 443));
  assert.ok(noProxyMatches("[2001:db8::5]:443", "[2001:db8::5]", 443));
  assert.ok(noProxyMatches("*", "anything", 1));
});

void test("requests go through an HTTP CONNECT proxy to HTTP and HTTPS upstreams; loopback stays direct", async (t) => {
  const ports = await upstreams(t);
  const proxy = await proxyOf(t, startConnectProxy({ route: routeTo(ports) }));
  const network = outbound(t, proxy.url);
  assert.equal(network.proxy, proxy.url);
  const http = await network.fetch("http://api.upstream.test/v1/models");
  assert.equal(await http.text(), "http api.upstream.test /v1/models");
  // TLS to the upstream runs inside the tunnel, with the upstream's name.
  const https = await network.fetch("https://api.upstream.test/v1/models", {
    method: "POST",
    body: "{}",
  });
  assert.equal(await https.text(), "https api.upstream.test /v1/models");
  assert.deepEqual(proxy.tunnels, [
    "api.upstream.test:80",
    "api.upstream.test:443",
  ]);
  // Loopback never goes through the proxy.
  const local = await network.fetch(`http://127.0.0.1:${ports.http}/local`);
  assert.equal(await local.text(), `http 127.0.0.1:${ports.http} /local`);
  const named = await network.fetch(`https://localhost:${ports.https}/named`);
  assert.equal(await named.text(), `https localhost:${ports.https} /named`);
  assert.equal(proxy.tunnels.length, 2);
  assert.ok(network.proxies(new URL("https://api.openai.com/v1")));
  assert.ok(!network.proxies("http://192.168.1.20:11434/v1"));
});

void test("noProxy hosts and private addresses are sent directly, others through the proxy", async (t) => {
  const ports = await upstreams(t);
  const proxy = await proxyOf(t, startConnectProxy({ route: routeTo(ports) }));
  const network = outbound(t, proxy.url, {
    noProxy: ["192.0.2.0/24", ".corp.example"],
  });
  assert.ok(!network.proxies("https://git.corp.example/x"));
  assert.ok(!network.proxies("http://10.1.2.3/x"));
  assert.ok(network.proxies("https://198.51.100.7/x"));
  // TEST-NET-1 is never routed: a direct attempt only times out, and the proxy sees nothing.
  await assert.rejects(
    network.fetch("http://192.0.2.1:8080/", {
      signal: AbortSignal.timeout(300),
    }),
  );
  assert.deepEqual(proxy.tunnels, []);
  // The same address without the noProxy entry goes to the proxy, which refuses it.
  const proxied = outbound(t, proxy.url);
  assert.match(
    await failure(proxied.fetch("http://192.0.2.1:8080/")),
    /refused the tunnel to 192\.0\.2\.1:8080: 502 Bad Gateway/,
  );
  assert.deepEqual(proxy.tunnels, ["192.0.2.1:8080"]);
});

void test("proxy credentials: the user from the address, the password from the secret", async (t) => {
  const ports = await upstreams(t);
  const proxy = await proxyOf(
    t,
    startConnectProxy({
      route: routeTo(ports),
      credentials: "alice:s3cret pass",
    }),
  );
  const address = new URL(proxy.url);
  address.username = "alice";
  const network = outbound(t, address.href, { password: "s3cret pass" });
  assert.equal(
    network.proxy,
    proxy.url,
    "the shown address has no credentials",
  );
  assert.equal(
    await (await network.fetch("https://api.upstream.test/ok")).text(),
    "https api.upstream.test /ok",
  );
  assert.deepEqual(proxy.credentials, ["alice:s3cret pass"]);
  // A password in the address (the environment's form) is used as it is.
  address.password = encodeURIComponent("s3cret pass");
  const inline = outbound(t, address.href);
  assert.equal(
    (await inline.fetch("http://api.upstream.test/inline")).status,
    200,
  );
  // Without the password the proxy answers 407, and the error says what to do.
  address.password = "";
  const missing = outbound(t, address.href);
  assert.match(
    await failure(missing.fetch("https://api.upstream.test/x")),
    /407 Proxy Authentication Required \(it did not accept the credentials\)/,
  );
  const anonymous = outbound(t, proxy.url);
  assert.match(
    await failure(anonymous.fetch("https://api.upstream.test/x")),
    /407 .*it wants credentials/,
  );
  const wrong = outbound(t, `http://alice:nope@127.0.0.1:${proxy.port}`);
  assert.match(
    await failure(wrong.fetch("https://api.upstream.test/x")),
    /did not accept the credentials/,
  );
});

void test("a dead or misbehaving proxy fails fast as a proxy failure, without retrying", async (t) => {
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const started = Date.now();
  assert.match(
    await failure(outbound(t, dead).fetch("https://api.upstream.test/x")),
    new RegExp(
      `The proxy ${dead.replace(/\./g, "\\.")} could not be reached: .*ECONNREFUSED`,
    ),
  );
  assert.ok(Date.now() - started < 2_000, "refused at once");
  // undici's own ProxyAgent reconnects in a loop when the proxy closes after CONNECT.
  const closing = await proxyOf(
    t,
    startConnectProxy({ route: () => undefined, behaviour: "close" }),
  );
  assert.match(
    await failure(
      outbound(t, closing.url).fetch("https://api.upstream.test/x"),
    ),
    /closed the connection without answering/,
  );
  assert.equal(closing.connections, 1);
  const silent = await proxyOf(
    t,
    startConnectProxy({ route: () => undefined, behaviour: "silent" }),
  );
  assert.match(
    await failure(
      outbound(t, silent.url, { connectTimeoutMs: 300 }).fetch(
        "https://api.upstream.test/x",
      ),
    ),
    /did not open a tunnel to api\.upstream\.test:443 within 300 ms/,
  );
  assert.equal(silent.connections, 1);
  // A failure behind the proxy is the proxy's answer, not a hang.
  const gone = await closedPort();
  const refusing = await proxyOf(t, startConnectProxy({ route: () => gone }));
  assert.match(
    await failure(
      outbound(t, refusing.url).fetch("https://api.upstream.test/x"),
    ),
    /refused the tunnel to api\.upstream\.test:443: 502/,
  );
});
void test("SOCKS5: tunnels with and without credentials, remote names, refusals", async (t) => {
  const ports = await upstreams(t);
  const socks = await proxyOf(t, startSocksProxy({ route: routeTo(ports) }));
  const network = outbound(t, socks.url);
  assert.equal(
    await (await network.fetch("https://api.upstream.test/s")).text(),
    "https api.upstream.test /s",
  );
  assert.equal(
    await (await network.fetch("http://api.upstream.test/s")).text(),
    "http api.upstream.test /s",
  );
  assert.deepEqual(
    socks.tunnels,
    ["api.upstream.test:443", "api.upstream.test:80"],
    "the proxy resolves the name",
  );
  assert.match(
    await failure(network.fetch("https://elsewhere.example/x")),
    /refused the tunnel to elsewhere\.example:443: host unreachable/,
  );
  const guarded = await proxyOf(
    t,
    startSocksProxy({ route: routeTo(ports), credentials: "bob:pw" }),
  );
  const signed = outbound(t, `socks5h://bob@127.0.0.1:${guarded.port}`, {
    password: "pw",
  });
  assert.equal((await signed.fetch("https://api.upstream.test/a")).status, 200);
  assert.deepEqual(guarded.credentials, ["bob:pw"]);
  assert.match(
    await failure(
      outbound(t, guarded.url).fetch("https://api.upstream.test/a"),
    ),
    /wants credentials/,
  );
  assert.match(
    await failure(
      outbound(t, `socks5://bob:no@127.0.0.1:${guarded.port}`).fetch(
        "https://api.upstream.test/a",
      ),
    ),
    /did not accept the credentials/,
  );
});

void test("an HTTPS proxy: TLS to the proxy, then TLS to the upstream inside it", async (t) => {
  const ports = await upstreams(t);
  const proxy = await proxyOf(
    t,
    startConnectProxy({ route: routeTo(ports), tls }),
  );
  const network = outbound(t, proxy.url);
  assert.equal(
    await (await network.fetch("https://api.upstream.test/tls")).text(),
    "https api.upstream.test /tls",
  );
  assert.deepEqual(proxy.tunnels, ["api.upstream.test:443"]);
});

void test("a provider's own proxy: direct, or another proxy, whatever the daemon's", async (t) => {
  const ports = await upstreams(t);
  const daemon = await proxyOf(t, startConnectProxy({ route: routeTo(ports) }));
  const own = await proxyOf(t, startSocksProxy({ route: routeTo(ports) }));
  const network = outbound(t, daemon.url);
  assert.equal(
    (
      await network.fetch("https://api.upstream.test/own", undefined, {
        proxy: own.url,
      })
    ).status,
    200,
  );
  assert.deepEqual(own.tunnels, ["api.upstream.test:443"]);
  assert.deepEqual(daemon.tunnels, []);
  await assert.rejects(
    network.fetch(
      "http://192.0.2.1:8080/",
      { signal: AbortSignal.timeout(300) },
      { proxy: "direct" },
    ),
  );
  assert.deepEqual(daemon.tunnels, [], "direct skips the daemon's proxy");
  // Without a daemon proxy, a provider's own still applies.
  const none = outbound(t, undefined);
  assert.equal(
    (
      await none.fetch("https://api.upstream.test/own2", undefined, {
        proxy: own.url,
      })
    ).status,
    200,
  );
  assert.equal(own.tunnels.length, 2);
  await assert.rejects(
    none.fetch("https://x", undefined, { proxy: "ftp://p" }),
    /proxy must use/,
  );
});

void test("past 32 providers' own proxies the oldest agent closes, and close waits for it", async (t) => {
  const ports = await upstreams(t);
  const network = new Outbound(resolveNetworkSettings(undefined));
  for (let n = 1; n <= 40; n++) {
    // Loopback stays direct whatever the provider's proxy; each choice still has its agent.
    const answer = await network.fetch(
      `http://127.0.0.1:${ports.http}/${n}`,
      undefined,
      { proxy: `http://127.0.0.1:${10_000 + n}` },
    );
    assert.equal(await answer.text(), `http 127.0.0.1:${ports.http} /${n}`);
  }
  await network.close();
});

void test("child programs get the daemon's proxy in their *_PROXY variables", async (t) => {
  const network = outbound(t, "http://alice@proxy.corp:3128", {
    password: "p@ss word",
    noProxy: [".corp.example"],
  });
  const environment = network.childEnvironment({
    PATH: "/bin",
    https_proxy: "http://old:1",
    NO_PROXY: "x",
    HOME: undefined,
  });
  assert.equal(environment.PATH, "/bin");
  assert.equal(
    environment.HTTPS_PROXY,
    "http://alice:p%40ss%20word@proxy.corp:3128",
  );
  assert.equal(environment.https_proxy, environment.HTTPS_PROXY);
  assert.equal(environment.http_proxy, environment.HTTPS_PROXY);
  assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1,.corp.example");
  assert.ok(!("HOME" in environment));
  const none = outbound(t, undefined).childEnvironment({
    PATH: "/bin",
    HTTPS_PROXY: "http://old:1",
    all_proxy: "socks5://x",
  });
  assert.deepEqual(none, { PATH: "/bin" });
});

void test("a closed outbound network refuses new requests", async (t) => {
  const ports = await upstreams(t);
  const proxy = await proxyOf(t, startConnectProxy({ route: routeTo(ports) }));
  const network = outbound(t, proxy.url);
  assert.equal((await network.fetch("http://api.upstream.test/")).status, 200);
  await network.close();
  await assert.rejects(network.fetch("http://api.upstream.test/"), /closed/);
});
