// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
  assert.deepEqual(await json.json(), {
    message: "Route GET:/agents not found",
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

  // Unknown assets and names outside the build are 404, never the page.
  for (const target of [
    "/assets/missing.js",
    "/assets/..%2Findex.html",
    "/assets/%2e%2e/%2e%2e/data/admin.token",
  ]) {
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
    assert.equal(status, 404, target);
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

void test("a one-time console link becomes an HttpOnly SameSite=Strict session that needs the CSRF header to change state", async (t) => {
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

  const withCookie = (extra: Record<string, string> = {}) =>
    page(url, { cookie: cookie.pair, ...extra });
  // Reads need the cookie only; the page recovers its CSRF value after a reload.
  const providers = await fetch(`${url}/api/v1/providers`, {
    headers: withCookie(),
  });
  assert.equal(providers.status, 200);
  const current = await fetch(`${url}/api/v1/auth/console-sessions/current`, {
    headers: withCookie(),
  });
  assert.equal(current.status, 200);
  assert.equal(
    ((await current.json()) as { csrfToken: string }).csrfToken,
    session.csrfToken,
  );
  const create = (headers: Record<string, string>) =>
    fetch(`${url}/api/v1/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        id: "alpha",
        endpoints: { chat: "https://api.example.test/v1" },
      }),
    });
  // Changes without, or with another, CSRF value are refused before the route runs.
  for (const headers of [
    withCookie(),
    withCookie({ "x-hh-csrf": "x".repeat(43) }),
    withCookie({ "x-hh-csrf": `${session.csrfToken}x` }),
  ]) {
    const refused = await create(headers);
    assert.equal(refused.status, 403);
    assert.equal(await code(refused), "CSRF_TOKEN_INVALID");
  }
  assert.deepEqual((await admin.providers.list()).items, []);
  // Another origin, another site of this host, or a cross-site page: refused.
  for (const headers of [
    withCookie({
      "x-hh-csrf": session.csrfToken,
      origin: "http://evil.example",
    }),
    withCookie({
      "x-hh-csrf": session.csrfToken,
      "sec-fetch-site": "same-site",
    }),
    withCookie({
      "x-hh-csrf": session.csrfToken,
      "sec-fetch-site": "cross-site",
    }),
    withCookie({ "x-hh-csrf": session.csrfToken, "sec-fetch-site": "none" }),
  ]) {
    const refused = await create(headers);
    assert.equal(refused.status, 403);
    assert.equal(await code(refused), "LOCAL_ACCESS_REQUIRED");
  }
  // The SDK as the console page uses it: cookie credentials plus the CSRF header.
  const browser: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      headers: withCookie(Object.fromEntries(new Headers(init?.headers))),
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
    (await pageClient.auth.currentConsoleSession()).csrfToken,
    session.csrfToken,
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

  // Signing out ends the session at once and clears the cookie.
  const signOut = await fetch(`${url}/api/v1/auth/console-sessions/current`, {
    method: "DELETE",
    headers: withCookie({ "x-hh-csrf": session.csrfToken }),
  });
  assert.equal(signOut.status, 204);
  assert.ok(sessionCookie(signOut).attributes.includes("Max-Age=0"));
  const ended = await fetch(`${url}/api/v1/providers`, {
    headers: withCookie(),
  });
  assert.equal(ended.status, 401);
  assert.equal(await code(ended), "CONSOLE_SESSION_INVALID");
  assert.ok(sessionCookie(ended).attributes.includes("Max-Age=0"));

  // A new sign-in from a browser that still holds a session ends that one.
  const first = await exchange({
    code: (await admin.auth.createConsoleLink()).code,
  });
  const firstCookie = sessionCookie(first).pair;
  const second = await exchange(
    { code: (await admin.auth.createConsoleLink()).code },
    { cookie: firstCookie },
  );
  assert.equal(second.status, 201);
  const old = await fetch(`${url}/api/v1/providers`, {
    headers: page(url, { cookie: firstCookie }),
  });
  assert.equal(old.status, 401);
  const renewed = await fetch(`${url}/api/v1/providers`, {
    headers: page(url, { cookie: sessionCookie(second).pair }),
  });
  assert.equal(renewed.status, 200);

  // The link printed for the terminal signs in the same way.
  const printed = new URL(hub.consoleLink());
  assert.equal(printed.origin, url);
  const fromTerminal = await exchange({
    code: printed.hash.replace(/^#login=/, ""),
  });
  assert.equal(fromTerminal.status, 201);
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
