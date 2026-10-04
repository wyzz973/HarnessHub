// SPDX-License-Identifier: MIT
/**
 * ChatGPT plan accounts through the daemon: Sign in with ChatGPT against a
 * loopback fake of OpenAI's issuer and API, with synthetic tokens only.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

const CLIENT_ID = "oaiapp_synthetic_client";
const SUBJECT = "synthetic-subject-1";
const EMAIL = "plan-user@example.com";

interface Code {
  clientId: string;
  nonce: string;
  challenge: string;
  redirectUri: string;
}

/** A fake of auth.openai.com and api.openai.com/v1 for the SIWC flow. */
async function fakeOpenAi(t: TestContext) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "k1",
    alg: "RS256",
  };
  const state = {
    codes: new Map<string, Code>(),
    refresh: "",
    access: new Set<string>(),
    issued: 0,
    refreshes: 0,
    forms: [] as Record<string, string>[],
    revoked: [] as Record<string, string>[],
    inference: [] as {
      authorization: string | undefined;
      body: Record<string, unknown>;
    }[],
    /** While set, the code exchange waits for it. */
    hold: undefined as Promise<void> | undefined,
  };
  let base = "";
  const idToken = (claims: Record<string, unknown>) => {
    const part = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const signed = `${part({ alg: "RS256", kid: "k1", typ: "JWT" })}.${part(claims)}`;
    return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
  };
  const tokens = (clientId: string, nonce?: string) => {
    state.issued++;
    state.refresh = `synthetic-refresh-${state.issued}`;
    const access = `synthetic-access-${state.issued}`;
    state.access.add(access);
    return {
      access_token: access,
      refresh_token: state.refresh,
      token_type: "Bearer",
      // Within the five minutes before expiry: every use renews first.
      expires_in: 60,
      scope:
        "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      ...(nonce
        ? {
            id_token: idToken({
              iss: base,
              aud: clientId,
              sub: SUBJECT,
              email: EMAIL,
              exp: Math.floor(Date.now() / 1000) + 3600,
              nonce,
            }),
          }
        : {}),
    };
  };
  const read = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };
  const server = createServer((request, response) => {
    void (async () => {
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const body = await read(request);
      const url = new URL(request.url ?? "/", base);
      if (url.pathname === "/.well-known/jwks.json")
        return json(200, { keys: [jwk] });
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = Object.fromEntries(new URLSearchParams(body));
        state.forms.push(form);
        if (form.grant_type === "authorization_code" && state.hold)
          await state.hold;
        if (form.resource !== "https://api.openai.com/v1" || form.client_secret)
          return json(400, { error: "invalid_request" });
        if (form.grant_type === "authorization_code") {
          const code = state.codes.get(form.code ?? "");
          const challenge = createHash("sha256")
            .update(form.code_verifier ?? "")
            .digest("base64url");
          if (
            !code ||
            code.clientId !== form.client_id ||
            code.redirectUri !== form.redirect_uri ||
            code.challenge !== challenge
          )
            return json(400, { error: "invalid_grant" });
          state.codes.delete(form.code!);
          return json(200, tokens(code.clientId, code.nonce));
        }
        if (form.grant_type === "refresh_token") {
          state.refreshes++;
          if (
            form.client_id !== CLIENT_ID ||
            form.refresh_token !== state.refresh ||
            form.scope !== undefined
          )
            return json(400, { error: "refresh_token_reused" });
          return json(200, tokens(CLIENT_ID));
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/api/accounts/oauth/revoke") {
        state.revoked.push(Object.fromEntries(new URLSearchParams(body)));
        response.writeHead(200);
        return response.end();
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (!bearer || !state.access.has(bearer))
        return json(401, {
          error: { code: "subscription_sharing_invalid_user", message: "no" },
        });
      if (url.pathname === "/v1/models")
        return json(200, {
          models: [
            { slug: "gpt-plan", display_name: "GPT Plan", visibility: "list" },
            { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
          ],
        });
      if (url.pathname === "/v1/responses") {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        state.inference.push({
          authorization: request.headers.authorization,
          body: parsed,
        });
        if (parsed.store !== false || parsed.stream !== true)
          return json(400, {
            error: { code: "subscription_sharing_unsupported_capability" },
          });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "response.created", response: { model: "gpt-plan" } },
          { type: "response.output_text.delta", delta: "From the plan" },
          {
            type: "response.completed",
            response: {
              model: "gpt-plan",
              status: "completed",
              output: [],
              usage: { input_tokens: 9, output_tokens: 3 },
            },
          },
        ];
        return response.end(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
        );
      }
      json(404, {});
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base, state };
}

void test(
  "a ChatGPT plan account signs in with SIWC, serves gateway calls, renews once at a time, signs out and is deleted",
  { timeout: 120_000 },
  async (t) => {
    const openai = await fakeOpenAi(t);
    const { directory, defer } = await temporaryDirectory(t, "hh-siwc-");
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
      siwc: { issuer: openai.base, responsesBase: `${openai.base}/v1` },
    });
    defer(() => hub.server.close());
    const client = await connectLocal({ dataDir, url: hub.url });
    const notice = (await client.subscriptions.notices()).items.find(
      (item) => item.backend === "siwc",
    )!;
    assert.match(notice.text, /this computer/);
    await assert.rejects(
      client.subscriptions.startSignIn({
        backend: "siwc",
        acceptNotice: "an-old-version",
      }),
      (error: unknown) =>
        error instanceof HarnessHubError &&
        error.code === "SUBSCRIPTION_NOTICE_NOT_ACCEPTED",
    );

    /** The browser's part: OpenAI sends it back to the loopback callback. */
    const complete = async (
      view: { authorizeUrl?: string },
      issued: string | undefined,
    ) => {
      const authorize = new URL(view.authorizeUrl!);
      const params = authorize.searchParams;
      const code = `code-${openai.state.codes.size + openai.state.issued}`;
      openai.state.codes.set(code, {
        clientId: CLIENT_ID,
        nonce: params.get("nonce")!,
        challenge: params.get("code_challenge")!,
        redirectUri: params.get("redirect_uri")!,
      });
      const callback = new URL(params.get("redirect_uri")!);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", params.get("state")!);
      if (issued) callback.searchParams.set("client_id", issued);
      const page = await fetch(callback);
      return { params, page: await page.text(), status: page.status };
    };
    const until = async (id: string) => {
      for (;;) {
        const view = await client.subscriptions.signIn(id);
        if (view.status !== "pending") return view;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    const first = await client.subscriptions.startSignIn({
      backend: "siwc",
      acceptNotice: notice.version,
    });
    const registered = await complete(first, CLIENT_ID);
    assert.equal(registered.status, 200);
    assert.match(registered.page, /using your ChatGPT plan/);
    assert.equal(registered.params.get("client_id"), "dynamic_agent_client");
    assert.equal(registered.params.get("agent_name_hint"), "HarnessHub");
    const hostId = registered.params.get("ext_agent_host_id")!;
    assert.match(hostId, /^urn:uuid:/);
    assert.match(
      registered.params.get("redirect_uri")!,
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    const done = await until(first.id);
    assert.deepEqual(
      [done.status, done.credential, done.email, done.firstSignIn],
      ["succeeded", "account-1", EMAIL, true],
    );
    const provider = await client.providers.get("chatgpt");
    assert.deepEqual(provider.subscription, { backend: "siwc" });
    const account = provider.credentials[0]!;
    assert.equal(
      account.account?.backend === "siwc" && account.account.clientId,
      CLIENT_ID,
    );
    assert.equal(account.account?.consent.notice, notice.version);
    assert.ok(
      !/synthetic-(access|refresh)/.test(JSON.stringify(provider)),
      "tokens stay in the secret store",
    );
    // The account's reference holds sign-in tokens, never sent as an API key.
    for (const check of [
      () => client.providers.doctor("chatgpt", { model: "gpt-5" }),
      () => client.providers.test("chatgpt", { model: "gpt-5" }),
    ])
      await assert.rejects(check(), { code: "SUBSCRIPTION_PROVIDER" });
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(dataDir, "subscriptions", "siwc-host.json"),
          "utf8",
        ),
      ).extAgentHostId,
      hostId,
    );

    // The model list comes from the account, visible models only.
    const listed = await client.providers.refreshModels("chatgpt");
    assert.deepEqual(
      listed.models.list.map((model) => model.id),
      ["gpt-plan"],
    );
    const { key } = await client.gatewayKeys.create({
      name: "plan",
      modelAllow: ["chatgpt/*"],
    });
    const call = () =>
      fetch(`${hub.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "chatgpt/gpt-plan",
          messages: [{ role: "user", content: "hi" }],
        }),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as {
          choices?: { message: { content: string } }[];
        },
      }));
    const before = openai.state.refreshes;
    const answers = await Promise.all([call(), call(), call()]);
    for (const answer of answers) {
      assert.equal(answer.status, 200);
      assert.equal(answer.body.choices?.[0]?.message.content, "From the plan");
    }
    assert.equal(
      openai.state.refreshes - before,
      1,
      "three concurrent calls, one renewal",
    );
    const seen = openai.state.inference.at(-1)!;
    assert.equal(
      seen.authorization,
      `Bearer synthetic-access-${openai.state.issued}`,
    );
    assert.equal(seen.body.store, false);
    const accounts = await client.subscriptions.accounts();
    assert.deepEqual(
      accounts.items.map((item) => [item.credential, item.usable, item.email]),
      [["account-1", true, EMAIL]],
    );

    // Sign out: OpenAI ends the session, the account stops serving.
    const latest = openai.state.refresh;
    assert.deepEqual(
      await client.subscriptions.signOut("chatgpt", "account-1"),
      {
        revoked: true,
      },
    );
    assert.deepEqual(openai.state.revoked, [
      {
        token: latest,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      },
    ]);
    assert.equal((await call()).status, 400);
    assert.deepEqual(
      (await client.subscriptions.accounts()).items.map((item) => [
        item.signedIn,
        item.usable,
      ]),
      [[false, false]],
    );

    // Signing the same account in again reuses its client, without a name hint.
    const again = await client.subscriptions.startSignIn({
      backend: "siwc",
      acceptNotice: notice.version,
      credential: "account-1",
    });
    const returning = await complete(again, undefined);
    assert.equal(returning.params.get("client_id"), CLIENT_ID);
    assert.equal(returning.params.get("agent_name_hint"), null);
    assert.equal(returning.params.get("login_hint"), EMAIL);
    assert.equal(returning.params.get("ext_agent_host_id"), hostId);
    const back = await until(again.id);
    assert.deepEqual(
      [back.status, back.credential, back.firstSignIn],
      ["succeeded", "account-1", false],
    );
    assert.equal((await call()).status, 200);
    assert.ok(
      openai.state.forms.every((form) => form.client_secret === undefined),
    );

    // Deleting the account ends its session with OpenAI before its tokens go.
    const current = openai.state.refresh;
    await client.credentials.remove("chatgpt", "account-1");
    assert.deepEqual(openai.state.revoked.at(-1), {
      token: current,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    });
    assert.equal(openai.state.revoked.length, 2);
  },
);

/**
 * The real `hh` launcher with piped stdin (never interactive). `onStderr`
 * sees its standard error as it arrives.
 */
function hh(
  cwd: string,
  args: string[],
  onStderr: (text: string) => void = () => undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      onStderr(stderr);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

void test(
  "hh subscription login shows the notice, asks before it starts, and completes in the browser",
  { timeout: 120_000 },
  async (t) => {
    const openai = await fakeOpenAi(t);
    const { directory, defer } = await temporaryDirectory(t, "hh-siwc-cli-");
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
      siwc: { issuer: openai.base, responsesBase: `${openai.base}/v1` },
    });
    defer(() => hub.server.close());
    const daemon = ["--url", hub.url, "--data-dir", dataDir];
    const notice = await hh(directory, ["subscription", "notice", ...daemon]);
    assert.equal(notice.code, 0, notice.stderr);
    assert.match(notice.stdout, /Use your ChatGPT plan in HarnessHub/);
    assert.match(notice.stdout, /https:\/\/chatgpt\.com\/settings\/usage/);
    // Without a terminal or --accept-notice nothing starts.
    const refused = await hh(directory, [
      "subscription",
      "login",
      "chatgpt",
      ...daemon,
    ]);
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /Continue with ChatGPT/);
    let opened = false;
    const login = await hh(
      directory,
      ["subscription", "login", "chatgpt", "--accept-notice", ...daemon],
      (stderr) => {
        const found = /Continue with ChatGPT in your browser:\n {2}(\S+)/.exec(
          stderr,
        );
        if (!found || opened) return;
        opened = true;
        const params = new URL(found[1]!).searchParams;
        openai.state.codes.set("cli-code", {
          clientId: CLIENT_ID,
          nonce: params.get("nonce")!,
          challenge: params.get("code_challenge")!,
          redirectUri: params.get("redirect_uri")!,
        });
        const callback = new URL(params.get("redirect_uri")!);
        callback.searchParams.set("code", "cli-code");
        callback.searchParams.set("state", params.get("state")!);
        callback.searchParams.set("client_id", CLIENT_ID);
        void fetch(callback).then((response) => response.text());
      },
    );
    assert.equal(login.code, 0, login.stderr);
    assert.match(
      login.stderr,
      /Use your ChatGPT plan\nComplete eligible AI requests/,
    );
    assert.match(
      login.stdout,
      /You're using your ChatGPT plan\. Eligible usage in HarnessHub uses your ChatGPT plan\./,
    );
    assert.match(login.stdout, /1 models listed for chatgpt/);
    const listed = await hh(directory, ["subscription", "list", ...daemon]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(
      listed.stdout,
      /chatgpt\s+account-1\s+plan-user@example\.com\s+usable/,
    );
    const out = await hh(directory, [
      "subscription",
      "logout",
      "chatgpt",
      "account-1",
      "--yes",
      ...daemon,
    ]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /OpenAI ended the session/);
    assert.ok(
      !/synthetic-(access|refresh)/.test(
        login.stdout + login.stderr + listed.stdout,
      ),
    );
  },
);

void test("a pending ChatGPT sign-in is cancelled: its listener closes and nothing is saved", async (t) => {
  const openai = await fakeOpenAi(t);
  const { directory, defer } = await temporaryDirectory(t, "hh-siwc-cancel-");
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    siwc: { issuer: openai.base, responsesBase: `${openai.base}/v1` },
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  const notice = (await client.subscriptions.notices()).items.find(
    (item) => item.backend === "siwc",
  )!;
  const code = (problem: string) => (error: unknown) =>
    error instanceof HarnessHubError && error.code === problem;
  /** OpenAI sending the browser back to the attempt's loopback callback. */
  const callback = (view: { authorizeUrl?: string }) => {
    const params = new URL(view.authorizeUrl!).searchParams;
    const value = `code-cancel-${openai.state.codes.size}`;
    openai.state.codes.set(value, {
      clientId: CLIENT_ID,
      nonce: params.get("nonce")!,
      challenge: params.get("code_challenge")!,
      redirectUri: params.get("redirect_uri")!,
    });
    const url = new URL(params.get("redirect_uri")!);
    url.searchParams.set("code", value);
    url.searchParams.set("state", params.get("state")!);
    url.searchParams.set("client_id", CLIENT_ID);
    return url;
  };

  const pending = await client.subscriptions.startSignIn({
    backend: "siwc",
    acceptNotice: notice.version,
  });
  assert.equal(pending.status, "pending");
  const url = callback(pending);
  const cancelled = await client.subscriptions.cancelSignIn(pending.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(
    (await client.subscriptions.signIn(pending.id)).status,
    "cancelled",
  );
  // The loopback listener is closed: the browser finds nobody there.
  await assert.rejects(fetch(url));
  assert.equal(openai.state.forms.length, 0);
  await assert.rejects(
    client.subscriptions.cancelSignIn(pending.id),
    code("SIGN_IN_NOT_PENDING"),
  );
  await assert.rejects(
    client.subscriptions.cancelSignIn("no-such-attempt"),
    code("SIGN_IN_NOT_FOUND"),
  );
  assert.deepEqual((await client.subscriptions.accounts()).items, []);

  // Once the browser came back, the attempt completes and cannot be cancelled.
  const second = await client.subscriptions.startSignIn({
    backend: "siwc",
    acceptNotice: notice.version,
  });
  let release!: () => void;
  openai.state.hold = new Promise((resolve) => (release = resolve));
  const page = fetch(callback(second));
  const deadline = Date.now() + 10_000;
  while (
    !openai.state.forms.some((form) => form.grant_type === "authorization_code")
  ) {
    assert.ok(Date.now() < deadline, "the code exchange never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await assert.rejects(
    client.subscriptions.cancelSignIn(second.id),
    code("SIGN_IN_COMPLETING"),
  );
  release();
  assert.equal((await page).status, 200);
  let done = await client.subscriptions.signIn(second.id);
  while (done.status === "pending") {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = await client.subscriptions.signIn(second.id);
  }
  assert.equal(done.status, "succeeded");
  assert.equal((await client.subscriptions.accounts()).items.length, 1);
});
