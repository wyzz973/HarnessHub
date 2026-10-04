// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubClient, HarnessHubError } from "@harnesshub/sdk/client";
import { readAdminToken } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

const INDEX =
  '<!doctype html><title>HarnessHub</title><div id="root"></div><script type="module" src="/assets/index-0a1b2c.js"></script>';
const SCRIPT = "console.log('console fixture');\n";

/**
 * A daemon with a fixture console build (or none, with `built: false`), the
 * file secret backend and a fresh data root.
 */
async function daemon(t: TestContext, options: { built?: boolean } = {}) {
  const { directory, defer } = await temporaryDirectory(
    t,
    "harnesshub-console-",
  );
  const consoleDir = path.join(directory, "console");
  await mkdir(path.join(consoleDir, "assets"), { recursive: true });
  if (options.built !== false) {
    await writeFile(path.join(consoleDir, "index.html"), INDEX);
    await writeFile(path.join(consoleDir, "assets", "index-0a1b2c.js"), SCRIPT);
    await writeFile(path.join(consoleDir, "theme-boot.js"), "void 0;\n");
  }
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    consoleDir,
  });
  defer(() => hub.server.close());
  return {
    hub,
    url: hub.url,
    dataDir,
    directory,
    token: await readAdminToken(dataDir),
  };
}

/** Run the real `hh` launcher; stdin is a pipe, so it is never interactive. */
function hh(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(HH_ENTRY), ...args],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stdout += chunk));
      child.stderr
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.end();
    },
  );
}

/** The headers a same-origin page of this daemon sends. */
function page(url: string, extra: Record<string, string> = {}) {
  return { origin: url, "sec-fetch-site": "same-origin", ...extra };
}

async function code(response: Response) {
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/problem\+json/,
  );
  return ((await response.json()) as { code: string }).code;
}

/** `hh_console=<value>` and the attributes of the response's session cookie. */
function sessionCookie(response: Response) {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("hh_console="));
  assert.ok(header, "Set-Cookie hh_console");
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  return { pair: pair!, attributes };
}

void test("the daemon serves the console page, its assets and the page fallback with security headers", async (t) => {
  const { url } = await daemon(t);
  const html = { accept: "text/html,application/xhtml+xml" };
  const security = (response: Response) => {
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, "no inline script");
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
  };

  for (const route of ["/", "/agents", "/providers?x=1", "/a/b/c"]) {
    const response = await fetch(`${url}${route}`, { headers: html });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-cache", route);
    security(response);
    assert.equal(await response.text(), INDEX, route);
  }
  // `/` is the page whatever the client accepts; other paths fall back for HTML only.
  assert.equal((await fetch(`${url}/`)).status, 200);
  const json = await fetch(`${url}/agents`, {
    headers: { accept: "application/json" },
  });
  assert.equal(json.status, 404);
  // Fastify's 404 shape, without the URL (a path may hold a key).
  assert.deepEqual(await json.json(), {
    message: "No GET route has this path",
    error: "Not Found",
    statusCode: 404,
  });
  const post = await fetch(`${url}/agents`, { method: "POST", headers: html });
  assert.equal(post.status, 404);

  const asset = await fetch(`${url}/assets/index-0a1b2c.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(
    asset.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  security(asset);
  assert.equal(await asset.text(), SCRIPT);
  const boot = await fetch(`${url}/theme-boot.js`);
  assert.equal(boot.status, 200);
  assert.equal(boot.headers.get("cache-control"), "no-cache");
  const head = await fetch(`${url}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  // Unknown assets are 404 and names outside the build 400 (encoded dots
  // and slashes are refused before dispatch), never the page.
  for (const [target, expected] of [
    ["/assets/missing.js", 404],
    ["/assets/..%2Findex.html", 400],
    ["/assets/%2e%2e/%2e%2e/data/admin.token", 400],
  ] as const) {
    const status = await new Promise<number>((resolve, reject) => {
      // `path` is sent as written; a URL string would be normalized first.
      const { hostname, port } = new URL(url);
      const outgoing = httpRequest(
        { hostname, port, path: target, headers: html },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(status, expected, target);
  }
  // The console is the daemon's own page: a page of another origin cannot load it.
  const foreign = await fetch(`${url}/`, {
    headers: { ...html, "sec-fetch-site": "cross-site" },
  });
  assert.equal(foreign.status, 403);
});

void test("the console fallback never shadows the API, the legacy routes, health or the model gateway", async (t) => {
  const { url, token } = await daemon(t);
  const html = { accept: "text/html" };
  const cases: Array<[string, number, RegExp]> = [
    ["/api/v1/providers", 401, /^application\/problem\+json/],
    ["/api/v1/no-such-route", 401, /^application\/problem\+json/],
    ["/v1/engines", 200, /^application\/json/],
    ["/v1/no-such-route", 404, /^application\/json/],
    ["/v1/models", 401, /^application\/json/],
    ["/v1beta/models", 401, /^application\/json/],
    ["/v1alpha/models", 401, /^application\/json/],
    ["/models", 401, /^application\/json/],
    ["/responses", 401, /^application\/json/],
    ["/messages", 401, /^application\/json/],
    ["/chat/completions", 401, /^application\/json/],
    ["/health/live", 200, /^application\/json/],
    ["/health/ready", 200, /^application\/json/],
    ["/health/no-such-check", 404, /^application\/json/],
    ["/openapi.json", 200, /^application\/json/],
  ];
  for (const [route, status, type] of cases) {
    const response = await fetch(`${url}${route}`, { headers: html });
    const body = await response.text();
    assert.equal(response.status, status, `${route}: ${body.slice(0, 200)}`);
    assert.match(response.headers.get("content-type") ?? "", type, route);
    assert.equal(body.includes('id="root"'), false, route);
  }
  // The API's own 404 stays a problem once authenticated.
  const unknown = await fetch(`${url}/api/v1/no-such-route`, {
    headers: { ...html, authorization: `Bearer ${token}` },
  });
  assert.equal(unknown.status, 404);
  assert.equal(await code(unknown), "ROUTE_NOT_FOUND");
});

void test("without a console build the page answers 503 and the API works", async (t) => {
  const { url, token } = await daemon(t, { built: false });
  for (const route of ["/", "/agents"]) {
    const response = await fetch(`${url}${route}`, {
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 503, route);
    assert.match(await response.text(), /pnpm build:console/);
  }
  assert.equal((await fetch(`${url}/assets/index-0a1b2c.js`)).status, 404);
  const info = await fetch(`${url}/api/v1/system/info`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(info.status, 200);
});

void test("a one-time console link becomes a session of a browser cookie and a tab token, both needed on every request", async (t) => {
  const { url, token, hub } = await daemon(t);
  const admin = new HarnessHubClient({ url, token });
  const exchange = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/v1/auth/console-sessions`, {
      method: "POST",
      headers: page(url, { "content-type": "application/json", ...headers }),
      body: JSON.stringify(body),
    });

  // Only the admin token creates links.
  const anonymousLink = await fetch(`${url}/api/v1/auth/console-links`, {
    method: "POST",
    headers: page(url, { "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(anonymousLink.status, 401);
  assert.equal(await code(anonymousLink), "ADMIN_TOKEN_REQUIRED");
  const link = await admin.auth.createConsoleLink();
  assert.match(link.code, /^[A-Za-z0-9_-]{22}$/);
  const started = Date.now();
  assert.ok(Date.parse(link.expiresAt) - started <= 60_000);

  // The exchange must be JSON from this origin.
  const form = await fetch(`${url}/api/v1/auth/console-sessions`, {
    method: "POST",
    headers: page(url, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: `code=${link.code}`,
  });
  assert.equal(form.status, 415);
  const sameSite = await exchange(
    { code: link.code },
    { "sec-fetch-site": "same-site" },
  );
  assert.equal(sameSite.status, 403);
  assert.equal(await code(sameSite), "LOCAL_ACCESS_REQUIRED");
  const foreign = await exchange(
    { code: link.code },
    { origin: "http://evil.example" },
  );
  assert.equal(foreign.status, 403);

  const signedIn = await exchange({ code: link.code });
  assert.equal(signedIn.status, 201);
  assert.equal(signedIn.headers.get("cache-control"), "no-store");
  const session = (await signedIn.json()) as {
    csrfToken: string;
    expiresAt: string;
    idleExpiresAt: string;
  };
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const cookie = sessionCookie(signedIn);
  assert.match(cookie.pair, /^hh_console=[A-Za-z0-9_-]{43}$/);
  for (const attribute of [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=604800",
  ])
    assert.ok(cookie.attributes.includes(attribute), attribute);
  assert.equal(cookie.pair.includes(session.csrfToken), false);
  assert.equal(JSON.stringify(session).includes(token), false);
  // The code works once.
  const replay = await exchange({ code: link.code });
  assert.equal(replay.status, 401);
  assert.equal(await code(replay), "CONSOLE_LINK_INVALID");
  const garbled = await exchange({ code: "not a code" });
  assert.equal(garbled.status, 400);

  const tab = (extra: Record<string, string> = {}) =>
    page(url, {
      cookie: cookie.pair,
      "x-hh-csrf": session.csrfToken,
      ...extra,
    });
  // Every request needs both parts, reads included.
  for (const headers of [
    page(url, { cookie: cookie.pair }),
    page(url, { "x-hh-csrf": session.csrfToken }),
    page(url, { cookie: cookie.pair, "x-hh-csrf": "x".repeat(43) }),
    page(url, { cookie: cookie.pair, "x-hh-csrf": `${session.csrfToken}x` }),
  ]) {
    const refused = await fetch(`${url}/api/v1/providers`, { headers });
    assert.equal(refused.status, 401);
    assert.equal(await code(refused), "CONSOLE_SESSION_INVALID");
    assert.equal(
      refused.headers.getSetCookie().length,
      0,
      "the cookie is kept: other tabs may use it",
    );
  }
  assert.equal(
    (await fetch(`${url}/api/v1/providers`, { headers: tab() })).status,
    200,
  );
  // A reloaded tab checks its stored token; the token is never sent back.
  const current = await fetch(`${url}/api/v1/auth/console-sessions/current`, {
    headers: tab(),
  });
  assert.equal(current.status, 200);
  assert.deepEqual(Object.keys((await current.json()) as object).sort(), [
    "expiresAt",
    "idleExpiresAt",
  ]);
  const create = (headers: Record<string, string>) =>
    fetch(`${url}/api/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        id: "alpha",
        endpoints: { chat: "https://api.example.test/v1" },
      }),
    });
  for (const headers of [
    page(url, { cookie: cookie.pair }),
    page(url, { cookie: cookie.pair, "x-hh-csrf": "x".repeat(43) }),
  ]) {
    const refused = await create(headers);
    assert.equal(refused.status, 401);
    assert.equal(await code(refused), "CONSOLE_SESSION_INVALID");
  }
  assert.deepEqual((await admin.providers.list()).items, []);
  // Another origin, another site of this host, or a cross-site page: refused.
  for (const headers of [
    tab({ origin: "http://evil.example" }),
    tab({ "sec-fetch-site": "same-site" }),
    tab({ "sec-fetch-site": "cross-site" }),
    tab({ "sec-fetch-site": "none" }),
  ]) {
    const refused = await create(headers);
    assert.equal(refused.status, 403);
    assert.equal(await code(refused), "LOCAL_ACCESS_REQUIRED");
  }
  // The SDK as the console page uses it: the cookie plus the tab's token.
  const browser: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      headers: page(url, {
        cookie: cookie.pair,
        ...Object.fromEntries(new Headers(init?.headers)),
      }),
    });
  const pageClient = new HarnessHubClient({
    url,
    csrfToken: session.csrfToken,
    fetch: browser,
  });
  assert.equal(
    (
      await pageClient.providers.create({
        id: "alpha",
        endpoints: { chat: "https://api.example.test/v1" },
      })
    ).id,
    "alpha",
  );
  assert.equal(
    (await pageClient.auth.currentConsoleSession()).expiresAt,
    session.expiresAt,
  );
  // A console session cannot mint links, and the admin token has no session.
  await assert.rejects(
    pageClient.auth.createConsoleLink(),
    (error: unknown) => {
      assert.ok(error instanceof HarnessHubError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "ADMIN_TOKEN_REQUIRED");
      return true;
    },
  );
  await assert.rejects(
    admin.auth.currentConsoleSession(),
    (error: unknown) =>
      error instanceof HarnessHubError &&
      error.code === "CONSOLE_SESSION_NOT_FOUND",
  );
  // The legacy /v1 routes keep their loopback rule: no session needed, foreign origins refused.
  assert.equal((await fetch(`${url}/v1/engines`)).status, 200);
  assert.equal(
    (
      await fetch(`${url}/v1/engines`, {
        headers: { origin: "http://evil.example" },
      })
    ).status,
    403,
  );

  // A second tab of the same browser signs in with its own link: the
  // browser keeps its cookie, and neither tab ends the other's session.
  const second = await exchange(
    { code: (await admin.auth.createConsoleLink()).code },
    { cookie: cookie.pair },
  );
  assert.equal(second.status, 201);
  assert.equal(sessionCookie(second).pair, cookie.pair, "the same cookie");
  const secondToken = ((await second.json()) as { csrfToken: string })
    .csrfToken;
  assert.notEqual(secondToken, session.csrfToken);
  const secondTab = (extra: Record<string, string> = {}) =>
    page(url, { cookie: cookie.pair, "x-hh-csrf": secondToken, ...extra });
  for (const headers of [tab(), secondTab()])
    assert.equal(
      (await fetch(`${url}/api/v1/providers`, { headers })).status,
      200,
    );
  // Another browser's sign-in gets its own cookie; tokens do not cross browsers.
  const elsewhere = await exchange({
    code: (await admin.auth.createConsoleLink()).code,
  });
  const otherCookie = sessionCookie(elsewhere).pair;
  assert.notEqual(otherCookie, cookie.pair);
  const crossed = await fetch(`${url}/api/v1/providers`, {
    headers: page(url, { cookie: otherCookie, "x-hh-csrf": secondToken }),
  });
  assert.equal(crossed.status, 401);

  // Signing a tab out ends its session only; the cookie stays while another tab uses it.
  const signOut = await fetch(`${url}/api/v1/auth/console-sessions/current`, {
    method: "DELETE",
    headers: tab(),
  });
  assert.equal(signOut.status, 204);
  assert.equal(signOut.headers.getSetCookie().length, 0);
  const ended = await fetch(`${url}/api/v1/providers`, { headers: tab() });
  assert.equal(ended.status, 401);
  assert.equal(await code(ended), "CONSOLE_SESSION_INVALID");
  assert.equal(
    (await fetch(`${url}/api/v1/providers`, { headers: secondTab() })).status,
    200,
  );
  // The last tab's sign-out clears the cookie.
  const lastOut = await fetch(`${url}/api/v1/auth/console-sessions/current`, {
    method: "DELETE",
    headers: secondTab(),
  });
  assert.equal(lastOut.status, 204);
  assert.ok(sessionCookie(lastOut).attributes.includes("Max-Age=0"));

  // The link printed for the terminal signs in the same way.
  const printed = new URL(hub.consoleLink());
  assert.equal(printed.origin, url);
  const fromTerminal = await exchange({
    code: printed.hash.replace(/^#login=/, ""),
  });
  assert.equal(fromTerminal.status, 201);
});

void test("a console cookie that reaches another loopback port opens nothing when replayed outside the browser", async (t) => {
  const { url, token } = await daemon(t);
  const admin = new HarnessHubClient({ url, token });
  const daemonUrl = new URL(url);

  // A browser's cookie jar as RFC 6265 has it: cookies are scoped to the
  // host, not the port, so every port of 127.0.0.1 gets them.
  const jar = new Map<string, string>();
  const browserFetch = async (target: string, init: RequestInit = {}) => {
    const host = new URL(target).hostname;
    const headers = new Headers(init.headers);
    const cookies = [...jar].map(([name, value]) => `${name}=${value}`);
    if (cookies.length && host === daemonUrl.hostname)
      headers.set("cookie", cookies.join("; "));
    const response = await fetch(target, { ...init, headers });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const at = pair!.indexOf("=");
      jar.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  };

  // The console page signs in; its tab keeps the token, the jar the cookie.
  const signedIn = await browserFetch(`${url}/api/v1/auth/console-sessions`, {
    method: "POST",
    headers: page(url, { "content-type": "application/json" }),
    body: JSON.stringify({ code: (await admin.auth.createConsoleLink()).code }),
  });
  assert.equal(signedIn.status, 201);
  const tabToken = ((await signedIn.json()) as { csrfToken: string }).csrfToken;

  // The person then opens another local web app on another port.
  const received: string[] = [];
  const other = createServer((request, response) => {
    received.push(request.headers.cookie ?? "");
    response.end("another local service");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
  const { port } = other.address() as AddressInfo;
  await browserFetch(`http://127.0.0.1:${port}/`);
  const stolen = /hh_console=[^;]+/.exec(received.join(";"))?.[0];
  assert.ok(stolen, "the other port received the console cookie");

  // That service replays the cookie outside a browser: no Origin, no
  // Sec-Fetch-Site, and any token it can guess. Every operation of the
  // API refuses it, before its route runs.
  const document = (await (await fetch(`${url}/openapi.json`)).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const operations = Object.entries(document.paths)
    .filter(([path]) => path.startsWith("/api/v1/"))
    .flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((method) =>
          ["get", "post", "put", "patch", "delete"].includes(method),
        )
        .map((method) => ({
          method: method.toUpperCase(),
          path: path.replace(/\{[^}]+\}/g, "x"),
        })),
    );
  assert.ok(operations.length >= 60, `${operations.length} operations`);
  const replays: Array<Record<string, string>> = [
    { cookie: stolen },
    { cookie: stolen, "x-hh-csrf": "x".repeat(43) },
  ];
  for (const { method, path } of operations)
    for (const headers of replays) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...headers,
          ...(method === "GET" || method === "DELETE"
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      const label = `${method} ${path} with ${Object.keys(headers).join("+")}`;
      if (path === "/api/v1/auth/console-sessions")
        // Signing in needs a login code, never a cookie.
        assert.equal(response.status, 400, label);
      else {
        assert.equal(response.status, 401, label);
        assert.equal(await code(response), "CONSOLE_SESSION_INVALID", label);
      }
      if (!response.bodyUsed) await response.body?.cancel();
    }
  // The repro of the review: the cookie alone no longer reads the session.
  const current = await fetch(`${url}/api/v1/auth/console-sessions/current`, {
    headers: { cookie: stolen },
  });
  assert.equal(current.status, 401);
  assert.equal((await current.text()).includes(tabToken), false);
  // The tab that holds the token still works.
  const own = await fetch(`${url}/api/v1/providers`, {
    headers: page(url, { cookie: stolen, "x-hh-csrf": tabToken }),
  });
  assert.equal(own.status, 200);
});

void test("hh console prints a one-time sign-in link made with the admin token", async (t) => {
  const { url, dataDir, directory } = await daemon(t);
  const printed = await hh(directory, [
    "console",
    "--url",
    url,
    "--data-dir",
    dataDir,
  ]);
  assert.equal(printed.code, 0, printed.stderr);
  const link = new URL(printed.stdout.split("\n")[0]!);
  assert.equal(link.origin, url);
  assert.equal(link.pathname, "/");
  assert.match(link.hash, /^#login=[A-Za-z0-9_-]{22}$/);
  const json = await hh(directory, [
    "console",
    "--url",
    url,
    "--data-dir",
    dataDir,
    "--json",
  ]);
  assert.equal(json.code, 0, json.stderr);
  const output = JSON.parse(json.stdout) as { url: string; expiresAt: string };
  assert.ok(Date.parse(output.expiresAt) > Date.now());
  for (const target of [link, new URL(output.url)]) {
    const signedIn = await fetch(`${url}/api/v1/auth/console-sessions`, {
      method: "POST",
      headers: page(url, { "content-type": "application/json" }),
      body: JSON.stringify({ code: target.hash.replace(/^#login=/, "") }),
    });
    assert.equal(signedIn.status, 201);
  }
  // Without the daemon's token the command fails with the documented codes.
  const missing = await hh(directory, [
    "console",
    "--url",
    url,
    "--data-dir",
    directory,
  ]);
  assert.equal(missing.code, 3, missing.stderr);
  assert.match(missing.stderr, /admin\.token/);
  const usage = await hh(directory, ["console", "extra"]);
  assert.equal(usage.code, 2);
  const help = await hh(directory, ["console", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: hh console/);
});
