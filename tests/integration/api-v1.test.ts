// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type {
  CredentialId,
  ModelCallEntry,
  ModelCallId,
  ModelRef,
  ProviderId,
} from "@harnesshub/core/model-plane";
import { hashGatewayKeySecret } from "@harnesshub/core/model-plane";
import { startHub } from "@harnesshub/daemon/main";
import {
  HarnessHubClient,
  HarnessHubError,
  HarnessHubUnavailableError,
} from "@harnesshub/sdk/client";
import { connectLocal, readAdminToken } from "@harnesshub/sdk/local";
import { SecretStore } from "@harnesshub/secrets/secret-store";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { temporaryDirectory } from "../support/temporary.js";

const posix =
  process.platform === "win32" ? "POSIX modes do not apply on Windows" : false;

/** A daemon on a fresh data root with the file secret backend, and an SDK client that records every response body. */
async function daemon(t: TestContext) {
  const { directory, defer } = await temporaryDirectory(t, "harnesshub-api-");
  const dataDir = path.join(directory, "data");
  const configDir = path.join(directory, "config");
  const start = () =>
    startHub({
      dataDir,
      configDir,
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
    });
  const hub = await start();
  let open = true;
  defer(() => (open ? hub.server.close() : undefined));
  const bodies: string[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    bodies.push(await response.clone().text());
    return response;
  };
  const client = await connectLocal({
    dataDir,
    url: hub.url,
    fetch: recording,
  });
  return {
    hub,
    client,
    bodies,
    dataDir,
    configDir,
    directory,
    start,
    stop: async () => {
      open = false;
      await hub.server.close();
    },
  };
}

function problem(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

/** Every file under `root`, for scanning persisted bytes. */
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

void test("/api/v1 requires the local admin token and answers with problem details", async (t) => {
  const { hub, client, dataDir } = await daemon(t);
  const token = await readAdminToken(dataDir);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  if (!posix)
    assert.equal(
      (await stat(path.join(dataDir, "admin.token"))).mode & 0o777,
      0o600,
    );

  const missing = await fetch(`${hub.url}/api/v1/providers`);
  assert.equal(missing.status, 401);
  assert.match(
    missing.headers.get("content-type") ?? "",
    /^application\/problem\+json/,
  );
  assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer/);
  const body = (await missing.json()) as Record<string, unknown>;
  assert.equal(body.code, "ADMIN_TOKEN_REQUIRED");
  assert.equal(body.status, 401);
  assert.equal(body.instance, "/api/v1/providers");
  assert.equal(typeof body.requestId, "string");

  const wrong = new HarnessHubClient({ url: hub.url, token: "x".repeat(43) });
  await assert.rejects(
    wrong.providers.list(),
    problem("ADMIN_TOKEN_INVALID", 401),
  );

  const headers = { authorization: `Bearer ${token}` };
  // A browser page of another origin is refused even with the token.
  const foreign = await fetch(`${hub.url}/api/v1/providers`, {
    headers: { ...headers, origin: "http://evil.example" },
  });
  assert.equal(foreign.status, 403);
  assert.equal(
    ((await foreign.json()) as { code: string }).code,
    "LOCAL_ACCESS_REQUIRED",
  );
  // State changes must be JSON.
  const form = await fetch(`${hub.url}/api/v1/providers`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "id=alpha",
  });
  assert.equal(form.status, 415);
  assert.equal(
    ((await form.json()) as { code: string }).code,
    "UNSUPPORTED_MEDIA_TYPE",
  );
  const unknown = await fetch(`${hub.url}/api/v1/no-such-resource`, {
    headers,
  });
  assert.equal(unknown.status, 404);
  assert.equal(
    ((await unknown.json()) as { code: string }).code,
    "ROUTE_NOT_FOUND",
  );
  // The legacy routes keep their own format and need no token.
  assert.equal((await fetch(`${hub.url}/health/live`)).status, 200);

  const info = await client.system.info();
  assert.equal(info.apiVersion, "v1");
  assert.equal(info.secretBackend, "file");
  assert.equal(info.pid, process.pid);

  // The OpenAPI document lists the new operations.
  const spec = (await (await fetch(`${hub.url}/openapi.json`)).json()) as {
    paths: Record<string, unknown>;
  };
  assert.ok(spec.paths["/api/v1/providers/{id}/credentials"]);
});

void test(
  "the admin token survives a restart and an exposed token file stops the daemon",
  { skip: posix },
  async (t) => {
    const { dataDir, stop, start } = await daemon(t);
    const token = await readAdminToken(dataDir);
    await stop();
    const again = await start();
    try {
      const client = await connectLocal({ dataDir, url: again.url });
      assert.equal((await client.system.info()).apiVersion, "v1");
      assert.equal(await readAdminToken(dataDir), token);
    } finally {
      await again.server.close();
    }
    await chmod(path.join(dataDir, "admin.token"), 0o644);
    await assert.rejects(start(), { code: "ADMIN_TOKEN_INSECURE" });
    await assert.rejects(readAdminToken(dataDir), /mode 0600/);
    await writeFile(path.join(dataDir, "admin.token"), "short\n", {
      mode: 0o600,
    });
    await chmod(path.join(dataDir, "admin.token"), 0o600);
    await assert.rejects(start(), { code: "ADMIN_TOKEN_INSECURE" });
  },
);

void test("providers are created, patched and deleted; invalid ones are refused with pointers", async (t) => {
  const { client } = await daemon(t);
  const created = await client.providers.create({
    id: "alpha",
    endpoints: { chat: "https://api.example.test/v1" },
    models: { source: "manual", list: [{ id: "chat-1" }], expose: "all" },
  });
  assert.equal(created.name, "alpha");
  assert.equal(created.kind, "custom");
  assert.deepEqual(created.auth, { apiKeyHeader: "authorization-bearer" });
  assert.deepEqual(created.credentials, []);
  await assert.rejects(
    client.providers.create({
      id: "alpha",
      endpoints: { chat: "https://api.example.test/v1" },
    }),
    problem("PROVIDER_EXISTS", 409),
  );

  const refused: Array<[Record<string, string>, string]> = [
    [
      { chat: "https://api.example.test/v1/chat/completions" },
      "/endpoints/chat",
    ],
    [
      { responses: "https://api.example.test/v1/responses" },
      "/endpoints/responses",
    ],
    [{ anthropic: "https://api.example.test/v1" }, "/endpoints/anthropic"],
    [
      { gemini: "https://g.example.test/v1beta/models/m:generateContent" },
      "/endpoints/gemini",
    ],
    [{ chat: "http://api.example.test/v1" }, "/endpoints/chat"],
    [{ chat: "https://user:pass@api.example.test/v1" }, "/endpoints/chat"],
    [{ chat: "https://api.example.test/v1?key=1" }, "/endpoints/chat"],
  ];
  for (const [endpoints, pointer] of refused)
    await assert.rejects(
      client.providers.create({ id: "beta", endpoints }),
      (error: unknown) => {
        problem("PROVIDER_INVALID", 400)(error);
        assert.equal(
          (error as HarnessHubError).problem.errors?.[0]?.pointer,
          pointer,
        );
        return true;
      },
    );
  // Plain HTTP is accepted for a local server.
  await client.providers.create({
    id: "local",
    kind: "local",
    endpoints: { chat: "http://127.0.0.1:11434/v1" },
  });
  // Unknown fields and malformed input are refused by the schema.
  await assert.rejects(
    client.providers.create({
      id: "gamma",
      endpoints: { chat: "https://api.example.test/v1" },
      unknown: true,
    } as never),
    (error: unknown) => {
      problem("INVALID_REQUEST", 400)(error);
      assert.equal(
        (error as HarnessHubError).problem.errors?.[0]?.pointer,
        "/unknown",
      );
      return true;
    },
  );
  await assert.rejects(
    client.providers.create({ id: "Bad Id", endpoints: {} } as never),
    problem("INVALID_REQUEST", 400),
  );

  // Merge patch: add an endpoint, rename, detach from a preset (none here).
  const patched = await client.providers.update("alpha", {
    name: "Alpha",
    preset: null,
    endpoints: { anthropic: "https://api.example.test/anthropic" },
  });
  assert.equal(patched.name, "Alpha");
  assert.equal(patched.preset, undefined);
  assert.deepEqual(patched.endpoints, {
    chat: "https://api.example.test/v1",
    anthropic: "https://api.example.test/anthropic",
  });
  assert.equal(patched.createdAt, created.createdAt);
  await assert.rejects(
    client.providers.update("alpha", {
      endpoints: { chat: null, anthropic: null } as never,
    }),
    problem("PROVIDER_INVALID", 400),
  );
  await assert.rejects(
    client.providers.update("alpha", {
      endpoints: { anthropic: "https://api.example.test/v1/messages" },
    }),
    problem("PROVIDER_INVALID", 400),
  );
  assert.deepEqual(
    (await client.providers.get("alpha")).endpoints,
    patched.endpoints,
  );
  await assert.rejects(
    client.providers.update("missing", { name: "x" }),
    problem("PROVIDER_NOT_FOUND", 404),
  );

  assert.deepEqual(
    (await client.providers.list()).items.map((item) => item.id),
    ["alpha", "local"],
  );
  await client.providers.remove("local");
  await assert.rejects(
    client.providers.get("local"),
    problem("PROVIDER_NOT_FOUND", 404),
  );
  await assert.rejects(
    client.providers.remove("local"),
    problem("PROVIDER_NOT_FOUND", 404),
  );
});

void test("credential values reach only the secret store", async (t) => {
  const { hub, client, bodies, dataDir, configDir, stop } = await daemon(t);
  const canary = `sk-synthetic-canary-${Date.now()}`;
  const rotated = `${canary}-rotated`;
  await client.providers.create({
    id: "alpha",
    endpoints: { chat: "https://api.example.test/v1" },
  });
  const added = await client.credentials.add("alpha", {
    name: "main",
    value: canary,
    protocols: ["chat"],
  });
  assert.equal(added.id, "key-1");
  assert.equal(added.ref.kind, "store");
  assert.match(added.ref.value, /^[0-9a-f-]{36}$/);
  const envRef = await client.credentials.add("alpha", {
    id: "ci",
    name: "From CI",
    ref: { kind: "env", value: "SYNTHETIC_PROVIDER_KEY" },
  });
  assert.deepEqual(envRef.ref, {
    kind: "env",
    value: "SYNTHETIC_PROVIDER_KEY",
  });
  assert.deepEqual(
    (await client.credentials.list("alpha")).items.map((item) => item.id),
    ["key-1", "ci"],
  );
  assert.deepEqual((await client.providers.get("alpha")).credentials[0], added);

  // The value is in the store, readable with the same data and config roots.
  const secrets = await SecretStore.open({
    dataDir,
    configDir,
    backend: "file",
  });
  assert.equal(await secrets.resolve(added.ref, {}), canary);
  const same = await client.credentials.rotate("alpha", "key-1", rotated);
  assert.deepEqual(same.ref, added.ref);
  assert.equal(await secrets.resolve(added.ref, {}), rotated);

  await assert.rejects(
    client.credentials.rotate("alpha", "ci", "x-value"),
    problem("CREDENTIAL_NOT_MANAGED", 409),
  );
  await assert.rejects(
    client.credentials.add("alpha", {
      id: "ci",
      name: "dup",
      value: "x-value",
    }),
    problem("CREDENTIAL_EXISTS", 409),
  );
  await assert.rejects(
    client.credentials.add("alpha", { name: "none" } as never),
    problem("CREDENTIAL_INVALID", 400),
  );
  await assert.rejects(
    client.credentials.add("alpha", {
      name: "both",
      value: "x-value",
      ref: { kind: "env", value: "X" },
    } as never),
    problem("CREDENTIAL_INVALID", 400),
  );
  await assert.rejects(
    client.credentials.add("alpha", { name: "bad", value: "two\nlines" }),
    problem("INVALID_SECRET", 400),
  );
  for (const ref of [
    { kind: "env", value: "lower-case" },
    { kind: "file", value: "relative/key.txt" },
  ] as const)
    await assert.rejects(
      client.credentials.add("alpha", { name: "bad", ref }),
      (error: unknown) => {
        problem("CREDENTIAL_INVALID", 400)(error);
        assert.equal(
          (error as HarnessHubError).problem.errors?.[0]?.pointer,
          "/ref/value",
        );
        return true;
      },
    );
  await assert.rejects(
    client.credentials.add("missing", { name: "x", value: "x-value" }),
    problem("PROVIDER_NOT_FOUND", 404),
  );
  await assert.rejects(
    client.credentials.remove("alpha", "nope"),
    problem("CREDENTIAL_NOT_FOUND", 404),
  );

  await client.credentials.remove("alpha", "key-1");
  await assert.rejects(secrets.resolve(added.ref, {}), {
    code: "SECRET_UNAVAILABLE",
  });
  assert.deepEqual(
    (await client.credentials.list("alpha")).items.map((item) => item.id),
    ["ci"],
  );

  // Deleting a provider deletes its stored secrets too.
  const second = await client.credentials.add("alpha", {
    name: "second",
    value: `${canary}-second`,
  });
  await client.providers.remove("alpha");
  await assert.rejects(secrets.resolve(second.ref, {}), {
    code: "SECRET_UNAVAILABLE",
  });

  // No response, log line or plain file holds a value.
  await stop();
  const log = await readFile(hub.logFile, "utf8");
  assert.ok(log.includes("/api/v1/providers/:id/credentials"));
  for (const text of [bodies.join("\n"), log])
    assert.equal(text.includes(canary), false);
  for (const file of await files(dataDir))
    assert.equal(
      (await readFile(file)).includes(canary),
      false,
      path.relative(dataDir, file),
    );
});

void test("route groups need existing providers and block deletions they depend on", async (t) => {
  const { client } = await daemon(t);
  await client.providers.create({
    id: "alpha",
    endpoints: { chat: "https://api.example.test/v1" },
  });
  await assert.rejects(
    client.routeGroups.create({
      id: "fast",
      members: ["alpha/chat-1", "beta/chat-1"],
    }),
    (error: unknown) => {
      problem("ROUTE_GROUP_INVALID", 400)(error);
      assert.equal(
        (error as HarnessHubError).problem.errors?.[0]?.pointer,
        "/members/1",
      );
      return true;
    },
  );
  const group = await client.routeGroups.create({
    id: "fast",
    members: ["alpha/chat-1"],
    retry: { totalAttempts: 3 },
  });
  assert.equal(group.strategy, "order");
  assert.equal(group.stickiness, "auto");
  await assert.rejects(
    client.routeGroups.create({ id: "fast", members: ["alpha/chat-1"] }),
    problem("ROUTE_GROUP_EXISTS", 409),
  );
  const patched = await client.routeGroups.update("fast", {
    strategy: "latency",
    retry: null,
  });
  assert.equal(patched.strategy, "latency");
  assert.equal(patched.retry, undefined);
  assert.deepEqual(
    (await client.routeGroups.list()).items.map((item) => item.id),
    ["fast"],
  );

  // The provider is used by the group; the group by a key.
  await assert.rejects(client.providers.remove("alpha"), (error: unknown) => {
    problem("PROVIDER_IN_USE", 409)(error);
    assert.deepEqual((error as HarnessHubError).problem.references, [
      { type: "route-group", id: "fast" },
    ]);
    return true;
  });
  const key = await client.gatewayKeys.create({
    name: "router",
    modelAllow: ["group/fast"],
  });
  await assert.rejects(client.routeGroups.remove("fast"), (error: unknown) => {
    problem("ROUTE_GROUP_IN_USE", 409)(error);
    assert.deepEqual((error as HarnessHubError).problem.references, [
      { type: "gateway-key", id: key.gatewayKey.keyId },
    ]);
    return true;
  });
  // A revoked key no longer blocks.
  await client.gatewayKeys.revoke(key.gatewayKey.keyId);
  await client.routeGroups.remove("fast");
  await client.providers.remove("alpha");
  await assert.rejects(
    client.routeGroups.get("fast"),
    problem("ROUTE_GROUP_NOT_FOUND", 404),
  );
});

void test("client keys are shown once, listed without secrets and revoked", async (t) => {
  const { hub, client, bodies, dataDir, stop } = await daemon(t);
  const before = Date.now();
  const created = await client.gatewayKeys.create({
    name: "ci",
    modelAllow: ["alpha/*", "group/fast"],
    quota: { requestsPerMinute: 60 },
  });
  const match = /^hhk_c_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$/.exec(created.key);
  assert.ok(match, created.key);
  const view = created.gatewayKey;
  assert.equal(view.keyId, match[1]);
  assert.deepEqual(view.scope, { kind: "client", name: "ci" });
  assert.equal("secretHash" in view, false);
  const expires = Date.parse(view.expiresAt ?? "");
  assert.ok(Math.abs(expires - before - 90 * 86_400_000) < 60_000);
  const forever = await client.gatewayKeys.create({
    name: "forever",
    modelAllow: ["alpha/chat-1"],
    expiresAt: null,
  });
  assert.equal(forever.gatewayKey.expiresAt, undefined);

  // The store keeps the hash of the secret part only.
  const plane = new SqliteModelPlaneStore(
    path.join(dataDir, "harnesshub.sqlite"),
  );
  try {
    const record = await plane.getGatewayKey(view.keyId);
    assert.equal(record?.secretHash, hashGatewayKeySecret(match[2]!));
  } finally {
    plane.close();
  }

  const listed = await client.gatewayKeys.list();
  assert.deepEqual(
    listed.items.map((item) => item.keyId),
    [view.keyId, forever.gatewayKey.keyId],
  );
  assert.deepEqual(await client.gatewayKeys.get(view.keyId), view);
  const revoked = await client.gatewayKeys.revoke(view.keyId);
  assert.ok(revoked.revokedAt);
  assert.equal(
    (await client.gatewayKeys.revoke(view.keyId)).revokedAt,
    revoked.revokedAt,
  );
  await assert.rejects(
    client.gatewayKeys.revoke("aaaaaaaaaaaa"),
    problem("GATEWAY_KEY_NOT_FOUND", 404),
  );
  for (const input of [
    { name: "none", modelAllow: [] },
    { name: "bad", modelAllow: ["no-slash"] },
    {
      name: "past",
      modelAllow: ["alpha/*"],
      expiresAt: "2020-01-01T00:00:00Z",
    },
  ])
    await assert.rejects(
      client.gatewayKeys.create(input),
      (error: unknown) =>
        error instanceof HarnessHubError && error.status === 400,
    );
  // Only the create responses ever carried key text.
  const withKeys = bodies.filter((body) => body.includes("hhk_c_"));
  assert.equal(withKeys.length, 2);
  await stop();
  assert.equal(
    (await readFile(hub.logFile, "utf8")).includes(match[2]!),
    false,
  );
});

void test("usage and model calls are served from the ledger", async (t) => {
  const { client, dataDir } = await daemon(t);
  const plane = new SqliteModelPlaneStore(
    path.join(dataDir, "harnesshub.sqlite"),
  );
  t.after(() => plane.close());
  const entry = (
    index: number,
    patch: Partial<ModelCallEntry>,
  ): ModelCallEntry => ({
    callId: `call-${index}` as ModelCallId,
    occurredAt: `2026-10-0${index < 3 ? 1 : 2}T0${index}:00:00.000Z`,
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: false },
    modelRef: "alpha/chat-1" as ModelRef,
    provider: "alpha" as ProviderId,
    credentialId: "key-1" as CredentialId,
    patches: [],
    unmapped: [],
    status: 200,
    usage: {
      input: 10,
      cacheRead: 1,
      cacheWrite: 0,
      output: 5,
      reasoning: 0,
      source: "reported",
    },
    timing: { durationMs: 100 },
    attempts: [],
    cost: { amountUsd: 0.1, priceSource: "user" },
    ...patch,
  });
  await plane.appendModelCall(entry(1, {}));
  await plane.appendModelCall(
    entry(2, { cost: { amountUsd: 0.2, priceSource: "user" } }),
  );
  await plane.appendModelCall(
    entry(3, {
      modelRef: "beta/chat-2" as ModelRef,
      provider: "beta" as ProviderId,
      status: 502,
      cost: null,
      usage: {
        input: 999,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        source: "missing",
      },
    }),
  );
  await plane.appendModelCall(
    entry(4, { cost: { amountUsd: 0.0000001, priceSource: "catalog" } }),
  );

  const byModel = await client.usage.aggregate();
  assert.equal(byModel.groupBy, "model");
  assert.deepEqual(byModel.items, [
    {
      key: "alpha/chat-1",
      calls: 3,
      failedCalls: 0,
      usage: {
        input: 30,
        cacheRead: 3,
        cacheWrite: 0,
        output: 15,
        reasoning: 0,
      },
      cost: { amount: "0.3000001", currency: "USD" },
      unpricedCalls: 0,
    },
    {
      key: "beta/chat-2",
      calls: 1,
      failedCalls: 1,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      cost: { amount: "0", currency: "USD" },
      unpricedCalls: 1,
    },
  ]);
  assert.deepEqual(
    (await client.usage.aggregate({ groupBy: "day" })).items.map((item) => [
      item.key,
      item.calls,
    ]),
    [
      ["2026-10-01", 2],
      ["2026-10-02", 2],
    ],
  );
  assert.deepEqual(
    (
      await client.usage.aggregate({
        groupBy: "provider",
        from: "2026-10-02T00:00:00Z",
      })
    ).items.map((item) => [item.key, item.calls]),
    [
      ["alpha", 1],
      ["beta", 1],
    ],
  );

  const first = await client.modelCalls.list({ limit: 3 });
  assert.deepEqual(
    first.items.map((item) => item.callId),
    ["call-4", "call-3", "call-2"],
  );
  assert.deepEqual(first.items[0]?.cost, {
    amount: "0.0000001",
    currency: "USD",
    priceSource: "catalog",
  });
  assert.equal(first.items[1]?.cost, null);
  assert.ok(first.nextCursor);
  const rest = await client.modelCalls.list({
    limit: 3,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    rest.items.map((item) => item.callId),
    ["call-1"],
  );
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(
    (await client.modelCalls.list({ provider: "beta" })).items.map(
      (item) => item.callId,
    ),
    ["call-3"],
  );
  await assert.rejects(
    client.modelCalls.list({ limit: 201 }),
    problem("INVALID_REQUEST", 400),
  );
  await assert.rejects(
    client.modelCalls.list({ cursor: "garbage" }),
    problem("INVALID_CURSOR", 400),
  );
  await assert.rejects(
    client.usage.aggregate({ from: "yesterday" }),
    problem("INVALID_REQUEST", 400),
  );
  await assert.rejects(
    client.usage.aggregate({ groupBy: "week" as never }),
    problem("INVALID_REQUEST", 400),
  );
});

void test("conversations and usage by credential are served from the ledger", async (t) => {
  const { client, dataDir } = await daemon(t);
  const plane = new SqliteModelPlaneStore(
    path.join(dataDir, "harnesshub.sqlite"),
  );
  t.after(() => plane.close());
  const talk = "ab".repeat(32);
  const other = "cd".repeat(32);
  const entry = (
    index: number,
    patch: Partial<ModelCallEntry>,
  ): ModelCallEntry => ({
    callId: `call-${index}` as ModelCallId,
    occurredAt: `2026-10-02T0${index}:00:00.000Z`,
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: true },
    modelRef: "alpha/chat-1" as ModelRef,
    provider: "alpha" as ProviderId,
    credentialId: "key-1" as CredentialId,
    patches: [],
    unmapped: [],
    status: 200,
    usage: {
      input: 10,
      cacheRead: 1,
      cacheWrite: 0,
      output: 5,
      reasoning: 0,
      source: "reported",
    },
    timing: { durationMs: 100 },
    attempts: [],
    cost: { amountUsd: 0.1, priceSource: "user" },
    ...patch,
  });
  await plane.appendModelCall(
    entry(1, { conversationKey: talk, agent: { id: "claude", source: "key" } }),
  );
  await plane.appendModelCall(
    entry(2, {
      conversationKey: other,
      agent: { id: "codex", source: "user-agent" },
      credentialId: "key-2" as CredentialId,
    }),
  );
  await plane.appendModelCall(
    entry(3, {
      conversationKey: talk,
      agent: { id: "claude", source: "key" },
      modelRef: "beta/chat-1" as ModelRef,
      provider: "beta" as ProviderId,
      status: 503,
      cost: null,
    }),
  );

  const page = await client.conversations.list();
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.items, [
    {
      key: talk,
      calls: 2,
      failedCalls: 1,
      usage: {
        input: 20,
        cacheRead: 2,
        cacheWrite: 0,
        output: 10,
        reasoning: 0,
      },
      cost: { amount: "0.1", currency: "USD" },
      unpricedCalls: 1,
      firstAt: "2026-10-02T01:00:00.000Z",
      lastAt: "2026-10-02T03:00:00.000Z",
      models: ["alpha/chat-1", "beta/chat-1"],
      credentials: ["alpha/key-1", "beta/key-1"],
      agents: ["claude"],
    },
    {
      key: other,
      calls: 1,
      failedCalls: 0,
      usage: {
        input: 10,
        cacheRead: 1,
        cacheWrite: 0,
        output: 5,
        reasoning: 0,
      },
      cost: { amount: "0.1", currency: "USD" },
      unpricedCalls: 0,
      firstAt: "2026-10-02T02:00:00.000Z",
      lastAt: "2026-10-02T02:00:00.000Z",
      models: ["alpha/chat-1"],
      credentials: ["alpha/key-2"],
      agents: ["codex"],
    },
  ]);
  const first = await client.conversations.list({ limit: 1 });
  assert.deepEqual(
    first.items.map((item) => item.key),
    [talk],
  );
  assert.ok(first.nextCursor);
  assert.deepEqual(
    (
      await client.conversations.list({ limit: 1, cursor: first.nextCursor })
    ).items.map((item) => item.key),
    [other],
  );
  assert.deepEqual(
    (await client.conversations.list({ agent: "codex" })).items.map(
      (item) => item.key,
    ),
    [other],
  );
  // One conversation's calls carry their attribution.
  const calls = await client.conversations.get(talk);
  assert.deepEqual(
    calls.items.map((item) => [item.callId, item.conversationKey, item.agent]),
    [
      ["call-3", talk, { id: "claude", source: "key" }],
      ["call-1", talk, { id: "claude", source: "key" }],
    ],
  );
  assert.equal(calls.nextCursor, null);
  await assert.rejects(
    client.conversations.get("ef".repeat(32)),
    problem("CONVERSATION_NOT_FOUND", 404),
  );
  await assert.rejects(
    client.conversations.get("not-a-key"),
    problem("INVALID_REQUEST", 400),
  );
  await assert.rejects(
    client.conversations.list({ cursor: "garbage" }),
    problem("INVALID_CURSOR", 400),
  );

  assert.deepEqual(
    (await client.usage.aggregate({ groupBy: "credential" })).items.map(
      (item) => [item.key, item.calls],
    ),
    [
      ["alpha/key-1", 1],
      ["alpha/key-2", 1],
      ["beta/key-1", 1],
    ],
  );
  assert.deepEqual(
    (await client.modelCalls.list({ agent: "codex" })).items.map(
      (item) => item.callId,
    ),
    ["call-2"],
  );
});

void test("automatic groups are derived from the providers, hidden and restored", async (t) => {
  const { client, dataDir, start, stop } = await daemon(t);
  const models = (...ids: string[]) => ({
    source: "manual" as const,
    list: ids.map((id) => ({ id })),
    expose: "all" as const,
  });
  await client.providers.create({
    id: "alpha",
    endpoints: { chat: "https://api.alpha.example.test/v1" },
    models: models("glm-4.6", "solo-1"),
  });
  await client.providers.create({
    id: "beta",
    endpoints: { chat: "https://api.beta.example.test/v1" },
    models: models("z-ai/GLM-4.6"),
  });
  const derived = (await client.autoGroups.list()).items;
  assert.deepEqual(
    derived.map((item) => [item.id, item.model, item.members, item.hidden]),
    [
      [
        "auto-glm-4-6",
        "glm-4-6",
        ["alpha/glm-4.6", "beta/z-ai/GLM-4.6"],
        false,
      ],
    ],
  );
  // A model one provider serves alone is no group, and cannot be hidden.
  await assert.rejects(
    client.autoGroups.hide("auto-solo-1"),
    problem("AUTO_GROUP_NOT_FOUND", 404),
  );
  await assert.rejects(
    client.autoGroups.restore("auto-glm-4-6"),
    problem("AUTO_GROUP_NOT_FOUND", 404),
  );
  await client.autoGroups.hide("auto-glm-4-6");
  // Hiding is idempotent, and the hidden list survives a restart.
  await client.autoGroups.hide("auto-glm-4-6");
  await stop();
  const restarted = await start();
  t.after(() => restarted.server.close());
  const again = await connectLocal({ dataDir, url: restarted.url });
  assert.deepEqual(
    (await again.autoGroups.list()).items.map((item) => [item.id, item.hidden]),
    [["auto-glm-4-6", true]],
  );
  await again.autoGroups.restore("auto-glm-4-6");
  assert.deepEqual(
    (await again.autoGroups.list()).items.map((item) => [item.id, item.hidden]),
    [["auto-glm-4-6", false]],
  );
  // A user group of the same ID takes the automatic group's place.
  await again.routeGroups.create({
    id: "auto-glm-4-6",
    members: ["alpha/glm-4.6"],
  });
  assert.deepEqual((await again.autoGroups.list()).items, []);
  await again.routeGroups.remove("auto-glm-4-6");
  assert.equal((await again.autoGroups.list()).items.length, 1);
});

void test("the SDK reports an unreachable daemon", async () => {
  const client = new HarnessHubClient({
    url: "http://127.0.0.1:9",
    token: "x".repeat(43),
  });
  await assert.rejects(client.system.info(), HarnessHubUnavailableError);
  assert.throws(
    () => new HarnessHubClient({ url: "http://u:p@127.0.0.1:1", token: "x" }),
    TypeError,
  );
});
