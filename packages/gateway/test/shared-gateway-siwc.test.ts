// SPDX-License-Identifier: MIT
/**
 * Sign in with ChatGPT: the OAuth client, the token keeper, and calls through
 * a ChatGPT plan provider, against loopback fakes with synthetic tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type {
  CredentialId,
  ProviderConfig,
  ProviderCredential,
} from "@harnesshub/core/model-plane";
import { SUBSCRIPTION_NOTICES } from "@harnesshub/core/subscriptions";
import {
  decodeBundle,
  encodeBundle,
  SIWC,
  SiwcClient,
  SiwcError,
  SiwcTokens,
  type SubscriptionTokens,
} from "../src/siwc.js";
import {
  addKey,
  at,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  until,
  upstream,
  type Reply,
  type Seen,
} from "./shared-support.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const ACCESS = "synthetic-siwc-access-canary-71c2";

/** An RS256 signing key published as a JWKS, and a JWT signer. */
function signer(kid = "test-key") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" };
  const token = (claims: Record<string, unknown>) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid, typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return { jwk, token };
}

function form(seen: Seen): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(seen.body.toString("utf8")));
}

void test("authorization URLs register a new account, and sign a returning one in again", () => {
  const client = new SiwcClient({ issuer: "https://auth.example" });
  const fresh = client.authorizeUrl({
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    redirectUri: "http://127.0.0.1:5555/auth/callback",
    state: "state-1",
    nonce: "nonce-1",
    challenge: "challenge-1",
  });
  assert.equal(
    fresh.origin + fresh.pathname,
    "https://auth.example/api/accounts/authorize",
  );
  assert.deepEqual(Object.fromEntries(fresh.searchParams), {
    client_id: "dynamic_agent_client",
    agent_name_hint: "HarnessHub",
    ext_agent_host_id: "urn:uuid:00000000-0000-4000-8000-000000000001",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:5555/auth/callback",
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge_method: "S256",
    code_challenge: "challenge-1",
  });
  const returning = client.authorizeUrl({
    clientId: "oaiapp_issued",
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    redirectUri: "http://127.0.0.1:6666/auth/callback",
    state: "state-2",
    nonce: "nonce-2",
    challenge: "challenge-2",
    idTokenHint: "previous.id.token",
    loginHint: "user@example.com",
  });
  assert.equal(returning.searchParams.get("client_id"), "oaiapp_issued");
  assert.equal(returning.searchParams.get("agent_name_hint"), null);
  assert.equal(
    returning.searchParams.get("id_token_hint"),
    "previous.id.token",
  );
  assert.equal(returning.searchParams.get("login_hint"), "user@example.com");
});

void test("code exchange, refresh and revocation post OpenAI's forms without a client secret", async (t) => {
  const issuer = await upstream(
    t,
    json(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      id_token: "id-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid chatgpt.tokens.use.direct",
    }),
    json(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 3600,
    }),
    json(400, { error: "refresh_token_reused" }),
    (response) => {
      response.writeHead(200);
      response.end();
    },
  );
  const client = new SiwcClient({ issuer: issuer.base, clock: () => NOW });
  const exchanged = await client.exchange({
    clientId: "oaiapp_issued",
    code: "code-1",
    verifier: "verifier-1",
    redirectUri: "http://127.0.0.1:5555/auth/callback",
  });
  assert.deepEqual(exchanged, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    idToken: "id-1",
    expiresAt: NOW + 3_600_000,
    scopes: ["openid", "chatgpt.tokens.use.direct"],
  });
  assert.equal(issuer.seen[0]!.url, "/api/accounts/oauth/token");
  assert.equal(
    issuer.seen[0]!.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.deepEqual(form(issuer.seen[0]!), {
    grant_type: "authorization_code",
    code: "code-1",
    client_id: "oaiapp_issued",
    redirect_uri: "http://127.0.0.1:5555/auth/callback",
    code_verifier: "verifier-1",
    resource: "https://api.openai.com/v1",
  });
  await client.refresh({
    clientId: "oaiapp_issued",
    refreshToken: "refresh-1",
  });
  assert.deepEqual(form(issuer.seen[1]!), {
    grant_type: "refresh_token",
    client_id: "oaiapp_issued",
    refresh_token: "refresh-1",
    resource: "https://api.openai.com/v1",
  });
  await assert.rejects(
    client.refresh({ clientId: "oaiapp_issued", refreshToken: "refresh-1" }),
    (error: unknown) =>
      error instanceof SiwcError &&
      error.code === "refresh_token_reused" &&
      error.terminal,
  );
  assert.equal(
    await client.revoke({
      clientId: "oaiapp_issued",
      refreshToken: "refresh-2",
    }),
    true,
  );
  assert.equal(issuer.seen[3]!.url, "/api/accounts/oauth/revoke");
  assert.deepEqual(form(issuer.seen[3]!), {
    token: "refresh-2",
    token_type_hint: "refresh_token",
    client_id: "oaiapp_issued",
  });
});

void test("ID tokens are checked against the issuer's JWKS, audience, expiry and nonce", async (t) => {
  const good = signer("key-1");
  const other = signer("key-1");
  const issuer = await upstream(t, json(200, { keys: [good.jwk] }));
  const client = new SiwcClient({ issuer: issuer.base, clock: () => NOW });
  const claims = {
    iss: issuer.base,
    aud: "oaiapp_issued",
    sub: "user-subject-1",
    email: "user@example.com",
    exp: NOW / 1000 + 3600,
    nonce: "nonce-1",
  };
  const expected = { clientId: "oaiapp_issued", nonce: "nonce-1" };
  assert.deepEqual(await client.validateIdToken(good.token(claims), expected), {
    subject: "user-subject-1",
    email: "user@example.com",
  });
  const refused: [string, string][] = [
    [other.token(claims), "bad signature"],
    [good.token({ ...claims, aud: "oaiapp_other" }), "wrong audience"],
    [good.token({ ...claims, nonce: "nonce-2" }), "wrong nonce"],
    [good.token({ ...claims, exp: NOW / 1000 - 3600 }), "expired"],
    [good.token({ ...claims, iss: "https://evil.example" }), "wrong issuer"],
    ["not-a-token", "malformed"],
  ];
  for (const [token, why] of refused)
    await assert.rejects(
      client.validateIdToken(token, expected),
      (error: unknown) =>
        error instanceof SiwcError && error.message.includes(why),
      why,
    );
});

function account(
  overrides: Partial<ProviderCredential> = {},
): ProviderCredential {
  return {
    id: "account-1" as CredentialId,
    name: "user@example.com",
    ref: { kind: "store", value: "00000000-0000-4000-8000-0000000000aa" },
    enabled: true,
    account: {
      backend: "siwc",
      subject: "user-subject-1",
      email: "user@example.com",
      clientId: "oaiapp_issued",
      consent: {
        notice: SUBSCRIPTION_NOTICES.siwc.version,
        acceptedAt: "2026-10-02T11:00:00.000Z",
      },
    },
    ...overrides,
  };
}

void test("the token keeper renews once for concurrent calls, stores the rotation, and remembers a dead session", async (t) => {
  let refreshes = 0;
  const issuer = await upstream(t, (response, seen) => {
    refreshes++;
    const { refresh_token: token } = form(seen);
    return token === "refresh-1"
      ? json(200, {
          access_token: `access-${refreshes}`,
          refresh_token: "refresh-2",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        })(response, seen, undefined as never)
      : json(400, { error: "refresh_token_reused" })(
          response,
          seen,
          undefined as never,
        );
  });
  const clock = { now: NOW };
  const secrets = new Map<string, string>([
    [
      "00000000-0000-4000-8000-0000000000aa",
      encodeBundle({
        v: 1,
        refreshToken: "refresh-1",
        accessToken: "access-old",
        expiresAt: NOW + 60_000,
      }),
    ],
  ]);
  const writes: string[] = [];
  const tokens = new SiwcTokens({
    client: new SiwcClient({ issuer: issuer.base, clock: () => clock.now }),
    read: async (ref: SecretReference) => secrets.get(ref.value)!,
    write: async (ref: SecretReference, value: string) => {
      writes.push(value);
      secrets.set(ref.value, value);
    },
    clock: () => clock.now,
  });
  const chatgpt = { id: "chatgpt" } as ProviderConfig;
  const signal = new AbortController().signal;
  const credential = account();
  // The stored token expires within five minutes: renewed once for all.
  const got = await Promise.all(
    [1, 2, 3].map(() => tokens.accessToken(chatgpt, credential, signal)),
  );
  assert.deepEqual(got, ["access-1", "access-1", "access-1"]);
  assert.equal(refreshes, 1);
  const stored = decodeBundle(secrets.get(credential.ref.value)!);
  assert.equal(stored.refreshToken, "refresh-2", "the rotated token is kept");
  assert.equal(stored.accessToken, "access-1");
  assert.equal(writes.length, 1);
  assert.equal(
    await tokens.accessToken(chatgpt, credential, signal),
    "access-1",
    "a fresh token is used without another renewal",
  );
  // An hour later the rotated token is refused as reused: terminal.
  clock.now += 3_600_000;
  secrets.set(
    credential.ref.value,
    encodeBundle({ v: 1, refreshToken: "refresh-stale" }),
  );
  await assert.rejects(
    tokens.accessToken(chatgpt, credential, signal),
    (error: unknown) => error instanceof SiwcError && error.terminal,
  );
  const before = refreshes;
  await assert.rejects(tokens.accessToken(chatgpt, credential, signal));
  assert.equal(refreshes, before, "a dead session is not asked again");
  // A new sign-in stores new tokens: renewals work again.
  secrets.set(
    credential.ref.value,
    encodeBundle({ v: 1, refreshToken: "refresh-1" }),
  );
  assert.match(
    await tokens.accessToken(chatgpt, credential, signal),
    /^access-/,
  );
  await assert.rejects(
    tokens.accessToken(
      chatgpt,
      account({
        account: {
          ...account().account!,
          signedOutAt: "2026-10-02T12:00:00.000Z",
        },
      }),
      signal,
    ),
    (error: unknown) =>
      error instanceof SiwcError && error.code === "signed_out",
  );
});

/** A fake ChatGPT plan Responses endpoint: one streamed text answer. */
const ANSWER = [
  {
    type: "response.created",
    response: { id: "resp_1", model: "gpt-x", status: "in_progress" },
  },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      model: "gpt-x",
      status: "completed",
      output: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");
const streamed: Reply = (response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(ANSWER);
};

async function chatgpt(
  t: test.TestContext,
  replies: Reply[],
  options: {
    credentials?: ProviderCredential[];
    tokens?: SubscriptionTokens;
    keyOptions?: Parameters<typeof addKey>[2];
  } = {},
) {
  const up = await upstream(t, ...replies);
  const store = new MemoryStore();
  await store.putProvider({
    ...provider("chatgpt", { responses: `${up.base}/v1` }),
    credentials: options.credentials ?? [account()],
    subscription: { backend: "siwc" },
  });
  await store.putProvider(
    provider("keyed", { chat: `${up.base}/keyed/v1` }, { secrets: ["key-b"] }),
  );
  const key = await addKey(store, ["chatgpt/*", "keyed/*"], options.keyOptions);
  const gw = await mount(
    t,
    store,
    {},
    {
      subscriptions: options.tokens ?? {
        accessToken: async () => ACCESS,
        forget: () => undefined,
      },
    },
  );
  const chat = (body: Record<string, unknown>) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "chatgpt/model-a", ...body },
    });
  return { up, store, gw, chat, key };
}

void test("a ChatGPT plan call is a stateless streamed Responses request in the shape the preview accepts", async (t) => {
  const { up, store, chat } = await chatgpt(t, [streamed]);
  const answer = await chat({
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 100,
    user: "someone",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "ls", arguments: '{"dir":"/"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a b" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "ls",
          description: "List a directory",
          parameters: {
            type: "object",
            properties: { dir: { type: "string" } },
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "ls" } },
  });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(at(answer.json(), "choices", 0, "message", "content"), "Hi");
  const seen = up.seen[0]!;
  assert.equal(seen.url, "/v1/responses");
  assert.equal(seen.headers.authorization, `Bearer ${ACCESS}`);
  const body = seen.json();
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "Be brief.");
  for (const field of ["temperature", "top_p", "max_output_tokens", "user"])
    assert.equal(body[field], undefined, field);
  assert.deepEqual(body.tools, [
    {
      type: "namespace",
      name: "functions",
      description: "The tools the client provides.",
      tools: [
        {
          type: "function",
          name: "ls",
          description: "List a directory",
          parameters: {
            type: "object",
            properties: { dir: { type: "string" } },
          },
          strict: false,
        },
      ],
    },
  ]);
  assert.equal(body.tool_choice, "required");
  const input = body.input as Record<string, unknown>[];
  assert.ok(!input.some((item) => item.role === "system"));
  assert.deepEqual(
    input.find((item) => item.type === "function_call"),
    {
      type: "function_call",
      call_id: "call_1",
      name: "ls",
      namespace: "functions",
      arguments: '{"dir":"/"}',
    },
  );
  const entry = store.entries[0]!;
  assert.equal(entry.provider, "chatgpt");
  assert.equal(entry.mode, "translated");
  for (const field of ["temperature", "top_p", "max_tokens", "user"])
    assert.ok(entry.unmapped.includes(field), field);
  assert.ok(entry.patches.includes("tool_choice:required"));
  assert.ok(!JSON.stringify(store.entries).includes(ACCESS));
});

void test("only accounts that accepted the current notice and are signed in are used", async (t) => {
  const old = account({
    account: {
      ...account().account!,
      consent: { notice: "siwc-old", acceptedAt: "2026-01-01T00:00:00.000Z" },
    },
  });
  const signedOut = account({
    id: "account-2" as CredentialId,
    account: { ...account().account!, signedOutAt: "2026-10-02T11:30:00.000Z" },
  });
  const { up, chat } = await chatgpt(t, [streamed], {
    credentials: [old, signedOut],
  });
  const answer = await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(answer.status, 400);
  assert.match(
    String(at(answer.json(), "error", "message")),
    /signed out or has not accepted the current risk notice/,
  );
  assert.equal(up.seen.length, 0);
});

void test("subscription accounts serve this computer only: keys usable from the network neither see nor reach them", async (t) => {
  const { up, gw, key } = await chatgpt(t, [streamed], {
    keyOptions: { allowLan: true, expiresAt: "2027-01-01T00:00:00.000Z" },
  });
  const models = await send(gw.port, "/v1/models", {
    headers: { authorization: `Bearer ${key.text}` },
  });
  const ids = (models.json().data as { id: string }[]).map((model) => model.id);
  assert.ok(ids.length > 0 && ids.every((id) => id.startsWith("keyed/")));
  const answer = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "chatgpt/model-a",
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(answer.status, 400);
  assert.match(
    String(at(answer.json(), "error", "message")),
    /this computer only/,
  );
  assert.equal(up.seen.length, 0);
});

void test("an image described for a key usable from the network never uses a subscription account; for a local key it may", async (t) => {
  const up = await upstream(t, (response, seen, request) =>
    seen.url.startsWith("/keyed/")
      ? json(200, {
          id: "c",
          object: "chat.completion",
          model: "text-only",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        })(response, seen, request)
      : streamed(response, seen, request),
  );
  const store = new MemoryStore();
  await store.putProvider({
    ...provider("chatgpt", { responses: `${up.base}/v1` }),
    credentials: [account()],
    subscription: { backend: "siwc" },
  });
  await store.putProvider(
    provider(
      "keyed",
      { chat: `${up.base}/keyed/v1` },
      {
        secrets: ["key-b"],
        models: {
          source: "manual",
          expose: "all",
          list: [{ id: "text-only", inputModalities: ["text"] }],
        },
      },
    ),
  );
  const local = await addKey(store, ["*"]);
  const lan = await addKey(store, ["*"], {
    allowLan: true,
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  const gw = await mount(
    t,
    store,
    {},
    {
      subscriptions: {
        accessToken: async () => ACCESS,
        forget: () => undefined,
      },
      features: () => ({
        schemaVersion: 1,
        redaction: { enabled: true, rules: [] },
        vision: { model: "chatgpt/model-a" },
      }),
    },
  );
  const look = (key: { text: string }, image: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: {
        model: "keyed/text-only",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      },
    });
  const plan = () => up.seen.filter((seen) => !seen.url.startsWith("/keyed/"));
  const described = (keyId: string) =>
    store.entries.filter(
      (entry) => entry.purpose === "vision" && entry.keyId === keyId,
    );
  // A local key: the account describes the image.
  assert.equal((await look(local, "data:image/png;base64,AAAA")).status, 200);
  assert.equal(plan().length, 1);
  await until(() => described(local.keyId).length === 1);
  assert.equal(described(local.keyId)[0]!.provider, "chatgpt");
  // A key usable from the network: the account is no candidate for its description.
  const refused = await look(lan, "data:image/png;base64,BBBB");
  assert.equal(refused.status, 502);
  assert.equal(at(refused.json(), "error", "code"), "vision_failed");
  assert.equal(plan().length, 1, "the account was not called again");
  await until(() => described(lan.keyId).length === 1);
  const own = described(lan.keyId)[0]!;
  assert.equal(own.provider, undefined);
  assert.equal(own.status, 400);
  assert.match(String(own.error), /this computer only/);
});

void test("a used-up plan rests the account and points at ChatGPT's usage settings", async (t) => {
  const limit = json(429, {
    error: {
      code: "subscription_sharing_usage_limit_exceeded",
      message: "You have reached your usage limit.",
    },
  });
  const inStream: Reply = (response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            code: "subscription_sharing_usage_limit_exceeded",
            message: "Usage limit reached.",
          },
        },
      })}\n\n`,
    );
  };
  for (const reply of [limit, inStream]) {
    const { up, gw, chat, store } = await chatgpt(t, [reply]);
    const answer = await chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(answer.status, 429);
    assert.match(
      String(at(answer.json(), "error", "message")),
      /^Usage limit reached\. Review your plan or this app's limit in ChatGPT settings: https:\/\/chatgpt\.com\/settings\/usage/,
    );
    assert.equal(store.entries[0]!.errorClass, "quota_exhausted");
    gw.clock.now += 14 * 60_000;
    await chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(
      up.seen.length,
      1,
      "it rests 15 minutes, no reset is inferred",
    );
  }
});

void test("an account that must sign in again fails over and says how", async (t) => {
  const { up, chat, store } = await chatgpt(t, [streamed], {
    tokens: {
      accessToken: async () => {
        throw new SiwcError("reused", "refresh_token_reused", true);
      },
      forget: () => undefined,
    },
  });
  const answer = await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(answer.status, 401);
  assert.match(
    String(at(answer.json(), "error", "message")),
    /must sign in again \(hh subscription login chatgpt --provider chatgpt\)/,
  );
  assert.equal(store.entries[0]!.errorClass, "subscription_sign_in_needed");
  assert.equal(up.seen.length, 0);
});

void test("bundles keep within the secret limit by leaving out what can be renewed", () => {
  const long = "x".repeat(5_000);
  const bundle = decodeBundle(
    encodeBundle({
      v: 1,
      refreshToken: "refresh",
      accessToken: long,
      expiresAt: NOW,
      idToken: long,
    }),
  );
  assert.equal(bundle.refreshToken, "refresh");
  assert.equal(bundle.accessToken, undefined);
  assert.equal(bundle.idToken, long);
  assert.deepEqual(decodeBundle("not json"), { v: 1 });
  assert.equal(SIWC.callbackPath, "/auth/callback");
});
