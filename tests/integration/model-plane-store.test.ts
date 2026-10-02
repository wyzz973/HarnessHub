// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { HubError } from "@harnesshub/core/errors";
import {
  issueGatewayKey,
  parseGatewayKey,
  type CredentialId,
  type GatewayKeyId,
  type GatewayKeyRecord,
  type GatewayKeyScope,
  type ModelCallEntry,
  type ModelCallId,
  type ModelRef,
  type ProviderConfig,
  type ProviderId,
  type RouteGroup,
  type RouteGroupId,
  type WiringRecord,
} from "@harnesshub/core/model-plane";
import type { SessionId } from "@harnesshub/core/types";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";

const AT = "2026-10-02T08:00:00.000Z";

function code(expected: string) {
  return (error: unknown) =>
    error instanceof HubError && error.code === expected;
}

/** An owned Gateway database with the model-plane store open on it. */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-model-plane-"));
  const path = join(dir, "harnesshub.sqlite");
  const owned: Array<{ close(): void }> = [];
  t.after(() => {
    for (const resource of owned.reverse()) resource.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = () => {
    const store = new SqliteStore(path);
    owned.push(store);
    store.acquireOwner();
    const plane = new SqliteModelPlaneStore(path);
    owned.push(plane);
    return { store, plane };
  };
  const raw = () => {
    const db = new DatabaseSync(path);
    owned.push(db);
    return db;
  };
  return { dir, path, open, raw, owned, ...open() };
}

function provider(id: string, patch: Partial<ProviderConfig> = {}) {
  return {
    schemaVersion: 1,
    id: id as ProviderId,
    name: `Provider ${id}`,
    kind: "vendor",
    endpoints: {
      chat: "https://api.example.test/v1",
      anthropic: "https://api.example.test/anthropic",
    },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [
      {
        id: "primary" as CredentialId,
        name: "Primary",
        ref: { kind: "env", value: "SYNTHETIC_PROVIDER_KEY" },
        enabled: true,
      },
      {
        id: "managed" as CredentialId,
        name: "Managed",
        ref: { kind: "store", value: "00000000-0000-4000-8000-000000000003" },
        protocols: ["anthropic"],
        enabled: false,
      },
    ],
    models: {
      source: "manual",
      list: [
        {
          id: "chat-1",
          contextWindow: 128_000,
          price: { input: 1, output: 2 },
        },
      ],
      expose: "all",
    },
    patches: { chat: { patches: ["developer-to-system"] } },
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  } satisfies ProviderConfig;
}

function group(id: string, patch: Partial<RouteGroup> = {}): RouteGroup {
  return {
    id: id as RouteGroupId,
    strategy: "order",
    stickiness: "auto",
    members: ["alpha/chat-1" as ModelRef, "beta/chat-1" as ModelRef],
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

function key(scope: GatewayKeyScope, name = "test key") {
  const issued = issueGatewayKey(scope);
  const record: GatewayKeyRecord = {
    keyId: issued.keyId,
    name,
    scope,
    modelAllow: ["alpha/*", "group/fast"],
    secretHash: issued.secretHash,
    createdAt: AT,
  };
  return { issued, record };
}

let callCounter = 0;
function call(patch: Partial<ModelCallEntry> = {}): ModelCallEntry {
  callCounter += 1;
  return {
    callId: `call-${callCounter}` as ModelCallId,
    occurredAt: AT,
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: true },
    requestedModel: "alpha/chat-1",
    modelRef: "alpha/chat-1" as ModelRef,
    provider: "alpha" as ProviderId,
    credentialId: "primary" as CredentialId,
    wireModel: "chat-1",
    upstreamProtocol: "chat",
    mode: "passthrough",
    patches: [],
    unmapped: [],
    status: 200,
    usage: {
      input: 100,
      cacheRead: 10,
      cacheWrite: 0,
      output: 50,
      reasoning: 5,
      source: "reported",
    },
    timing: { firstByteMs: 120, durationMs: 900 },
    attempts: [
      {
        provider: "alpha" as ProviderId,
        credentialId: "primary" as CredentialId,
        modelRef: "alpha/chat-1" as ModelRef,
        wireModel: "chat-1",
        upstreamProtocol: "chat",
        startedAt: AT,
        status: 200,
        decision: "success",
      },
    ],
    cost: { amountUsd: 0.25, priceSource: "provider-preset" },
    completion: "explicit",
    ...patch,
  };
}

function count(db: DatabaseSync, table: string): unknown {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count;
}

void test("the model-plane store needs a migrated database owned by this process", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-model-plane-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "harnesshub.sqlite");
  assert.throws(
    () => new SqliteModelPlaneStore(path),
    code("SCHEMA_NOT_MIGRATED"),
  );
  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.throws(
    () => new SqliteModelPlaneStore(path),
    code("MODEL_PLANE_OWNER_REQUIRED"),
  );
  const release = store.acquireOwner();
  new SqliteModelPlaneStore(path).close();
  release();
  assert.throws(
    () => new SqliteModelPlaneStore(path),
    code("MODEL_PLANE_OWNER_REQUIRED"),
  );
});

void test("providers are stored, replaced, listed and deleted; invalid ones are refused", async (t) => {
  const { plane, raw } = fixture(t);
  await plane.putProvider(provider("beta"));
  await plane.putProvider(provider("alpha"));
  assert.deepEqual(
    (await plane.listProviders()).map((item) => item.id),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    await plane.getProvider("alpha" as ProviderId),
    provider("alpha"),
  );
  await plane.putProvider(provider("alpha", { name: "Renamed" }));
  assert.equal(
    (await plane.getProvider("alpha" as ProviderId))?.name,
    "Renamed",
  );
  assert.equal(await plane.getProvider("gamma" as ProviderId), undefined);
  assert.equal(await plane.deleteProvider("beta" as ProviderId), true);
  assert.equal(await plane.deleteProvider("beta" as ProviderId), false);

  const base = provider("delta");
  const invalid: unknown[] = [
    { ...base, id: "Delta" },
    { ...base, id: "group" },
    { ...base, schemaVersion: 2 },
    { ...base, endpoints: {} },
    { ...base, endpoints: { chat: "not a url" } },
    {
      ...base,
      endpoints: { chat: "https://api.example.test/v1/chat/completions" },
    },
    { ...base, endpoints: { chat: "http://api.example.test/v1" } },
    { ...base, endpoints: { anthropic: "https://api.example.test/v1" } },
    { ...base, endpoints: { sse: "https://api.example.test" } },
    { ...base, auth: { apiKeyHeader: "custom:bad header" } },
    { ...base, credentials: [...base.credentials, ...base.credentials] },
    {
      ...base,
      credentials: [
        { ...base.credentials[0], ref: { kind: "vault", value: "x" } },
      ],
    },
    { ...base, patches: { chat: { patches: ["rewrite-everything"] } } },
    { ...base, models: { ...base.models, source: "guess" } },
    { ...base, updatedAt: "yesterday" },
  ];
  for (const sample of invalid)
    await assert.rejects(
      plane.putProvider(sample as ProviderConfig),
      code("MODEL_PLANE_RECORD_INVALID"),
      JSON.stringify(sample).slice(0, 120),
    );
  assert.equal(count(raw(), "providers"), 1);

  // Rows read back are validated, not trusted.
  raw()
    .prepare("UPDATE providers SET record = json_set(record, '$.kind', 'x')")
    .run();
  await assert.rejects(plane.listProviders(), code("STORAGE_CORRUPT"));
  await assert.rejects(
    plane.getProvider("alpha" as ProviderId),
    code("STORAGE_CORRUPT"),
  );
});

void test("model overrides and provenance are written with their provider and go with it", async (t) => {
  const { plane, store, raw, open } = fixture(t);
  const alpha = provider("alpha");
  await plane.putProvider(provider("beta"));
  const exact = {
    ref: "alpha/chat-1",
    values: { contextWindow: 64_000, price: { input: 0.5 } },
    updatedAt: AT,
  };
  const wildcard = {
    ref: "alpha/*",
    values: { maxOutputTokens: 4096 },
    updatedAt: AT,
  };
  const provenance = {
    ref: "alpha/chat-1",
    fields: {
      maxOutputTokens: { source: "catalog" as const, at: AT, value: 8192 },
      "price.cacheRead": {
        source: "preset" as const,
        at: "2026-10-02",
        value: 0.1,
      },
    },
  };
  // A new provider is written with its provenance and an override at once.
  await plane.putProviderMetadata(alpha, [provenance], { put: exact });
  await plane.putProviderMetadata(alpha, [provenance], { put: wildcard });
  await plane.putProviderMetadata(provider("beta"), [], {
    put: { ...exact, ref: "beta/chat-1" },
  });
  assert.deepEqual(await plane.getProvider("alpha" as ProviderId), alpha);
  assert.deepEqual(await plane.getModelOverride("alpha/chat-1"), exact);
  assert.deepEqual(
    (await plane.listModelOverrides("alpha")).map((item) => item.ref),
    ["alpha/*", "alpha/chat-1"],
  );
  assert.deepEqual(await plane.listModelProvenance("alpha"), [provenance]);
  // An override is replaced as a whole; provenance is replaced per provider.
  await plane.putProviderMetadata(alpha, [], {
    put: { ...exact, values: { reasoning: true } },
  });
  assert.deepEqual((await plane.getModelOverride("alpha/chat-1"))?.values, {
    reasoning: true,
  });
  assert.deepEqual(await plane.listModelProvenance("alpha"), []);
  await plane.putProviderMetadata(alpha, [provenance], {
    delete: "alpha/chat-1",
  });
  assert.equal(await plane.getModelOverride("alpha/chat-1"), undefined);
  assert.deepEqual(await plane.listModelProvenance("alpha"), [provenance]);

  // A refused write changes nothing: not the provider, its provenance or overrides.
  const invalidOverrides: unknown[] = [
    { ...exact, ref: "alpha" },
    { ...exact, ref: "group/fast" },
    { ...exact, ref: "beta/chat-1" },
    { ...exact, ref: "alpha/chat 1" },
    { ...exact, values: {} },
    { ...exact, values: { contextWindow: 0 } },
    { ...exact, values: { contextWindow: 1.5 } },
    { ...exact, values: { window: 1000 } },
    { ...exact, values: { price: {} } },
    { ...exact, values: { price: { input: -1 } } },
    { ...exact, values: { price: { tier: 1 } } },
    { ...exact, values: { inputModalities: ["text", "text"] } },
    { ...exact, values: { inputModalities: ["smell"] } },
    { ...exact, updatedAt: "today" },
  ];
  const renamed = provider("alpha", { name: "Renamed" });
  for (const sample of invalidOverrides)
    await assert.rejects(
      plane.putProviderMetadata(renamed, [], {
        put: sample as typeof exact,
      }),
      code("MODEL_PLANE_RECORD_INVALID"),
      JSON.stringify(sample),
    );
  await assert.rejects(
    plane.putProviderMetadata(renamed, [], { delete: "beta/chat-1" }),
    code("MODEL_PLANE_RECORD_INVALID"),
  );
  const invalidProvenance: unknown[][] = [
    [{ ...provenance, ref: "beta/chat-1" }],
    [provenance, provenance],
    [{ ...provenance, fields: { window: { source: "catalog", value: 1 } } }],
    [
      {
        ...provenance,
        fields: { contextWindow: { source: "provider", value: 1 } },
      },
    ],
    [
      {
        ...provenance,
        fields: { contextWindow: { source: "catalog", value: "big" } },
      },
    ],
  ];
  for (const sample of invalidProvenance)
    await assert.rejects(
      plane.putProviderMetadata(renamed, sample as (typeof provenance)[]),
      code("MODEL_PLANE_RECORD_INVALID"),
      JSON.stringify(sample),
    );
  assert.deepEqual(await plane.getProvider("alpha" as ProviderId), alpha);
  assert.deepEqual(await plane.listModelProvenance("alpha"), [provenance]);
  assert.equal(count(raw(), "model_overrides"), 2);

  // Both survive a reopen and go with their provider.
  plane.close();
  store.close();
  const reopened = open().plane;
  assert.deepEqual(await reopened.listModelProvenance("alpha"), [provenance]);
  assert.deepEqual(
    (await reopened.listModelOverrides("alpha")).map((item) => item.ref),
    ["alpha/*"],
  );
  assert.equal(await reopened.deleteProvider("alpha" as ProviderId), true);
  assert.deepEqual(await reopened.listModelOverrides("alpha"), []);
  assert.deepEqual(await reopened.listModelProvenance("alpha"), []);
  assert.equal(count(raw(), "model_provenance"), 0);
  assert.equal(count(raw(), "model_overrides"), 1);

  // Rows read back are validated, not trusted.
  raw()
    .prepare(
      "UPDATE model_overrides SET record = json_set(record, '$.values.contextWindow', -1)",
    )
    .run();
  await assert.rejects(
    reopened.getModelOverride("beta/chat-1"),
    code("STORAGE_CORRUPT"),
  );
});

void test("route groups are stored, replaced and deleted; invalid ones are refused", async (t) => {
  const { plane, raw } = fixture(t);
  await plane.putRouteGroup(group("fast"));
  await plane.putRouteGroup(
    group("fast", {
      strategy: "latency",
      retry: { totalAttempts: 3 },
    }),
  );
  assert.deepEqual(
    await plane.getRouteGroup("fast" as RouteGroupId),
    group("fast", { strategy: "latency", retry: { totalAttempts: 3 } }),
  );
  await plane.putRouteGroup(group("cheap"));
  assert.deepEqual(
    (await plane.listRouteGroups()).map((item) => item.id),
    ["cheap", "fast"],
  );
  assert.equal(await plane.deleteRouteGroup("cheap" as RouteGroupId), true);
  assert.equal(await plane.deleteRouteGroup("cheap" as RouteGroupId), false);
  assert.equal(await plane.getRouteGroup("cheap" as RouteGroupId), undefined);

  const invalid: unknown[] = [
    group("Fast"),
    group("fast", { members: [] }),
    group("fast", { members: ["group/other" as ModelRef] }),
    group("fast", { members: ["no-slash" as ModelRef] }),
    group("fast", {
      members: ["alpha/chat-1" as ModelRef, "alpha/chat-1" as ModelRef],
    }),
    { ...group("fast"), strategy: "random" },
    { ...group("fast"), retry: { attempts: 3 } },
  ];
  for (const sample of invalid)
    await assert.rejects(
      plane.putRouteGroup(sample as RouteGroup),
      code("MODEL_PLANE_RECORD_INVALID"),
    );
  assert.equal(count(raw(), "route_groups"), 1);
});

void test("Gateway Keys keep only the secret hash and support revoke and touch", async (t) => {
  const { plane, raw } = fixture(t);
  const agent = key({ kind: "agent", adapterId: "claude-code" }, "agent key");
  const client = key({ kind: "client", name: "ci" }, "client key");
  await plane.createGatewayKey(agent.record);
  await plane.createGatewayKey(client.record);
  await assert.rejects(
    plane.createGatewayKey(agent.record),
    code("GATEWAY_KEY_CONFLICT"),
  );
  assert.deepEqual(
    (await plane.listGatewayKeys()).map((item) => item.keyId),
    [agent.record.keyId, client.record.keyId],
  );
  assert.deepEqual(await plane.getGatewayKey(agent.record.keyId), agent.record);
  const persisted = raw()
    .prepare("SELECT record FROM gateway_keys")
    .all()
    .map((row) => String(row.record))
    .join("\n");
  // The secret part is base64url and may itself contain "_".
  const secret = parseGatewayKey(agent.issued.text)?.secret ?? "";
  assert.equal(secret.length, 43);
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes(agent.issued.text), false);
  assert.ok(persisted.includes(agent.record.secretHash));

  // Revocation is idempotent and keeps the first time.
  assert.equal(await plane.revokeGatewayKey(agent.record.keyId, AT), true);
  assert.equal(
    await plane.revokeGatewayKey(
      agent.record.keyId,
      "2026-10-03T08:00:00.000Z",
    ),
    true,
  );
  assert.equal((await plane.getGatewayKey(agent.record.keyId))?.revokedAt, AT);
  assert.equal(
    await plane.revokeGatewayKey("aaaaaaaaaaaa" as GatewayKeyId, AT),
    false,
  );

  // lastUsedAt only moves forward; an unknown key is ignored.
  await plane.touchGatewayKey(client.record.keyId, "2026-10-02T09:00:00.000Z");
  await plane.touchGatewayKey(client.record.keyId, "2026-10-02T08:30:00.000Z");
  assert.equal(
    (await plane.getGatewayKey(client.record.keyId))?.lastUsedAt,
    "2026-10-02T09:00:00.000Z",
  );
  await plane.touchGatewayKey(client.record.keyId, "2026-10-02T10:00:00+01:00");
  assert.equal(
    (await plane.getGatewayKey(client.record.keyId))?.lastUsedAt,
    "2026-10-02T09:00:00.000Z",
  );
  await plane.touchGatewayKey(client.record.keyId, "2026-10-02T10:00:00.000Z");
  assert.equal(
    (await plane.getGatewayKey(client.record.keyId))?.lastUsedAt,
    "2026-10-02T10:00:00.000Z",
  );
  await plane.touchGatewayKey("aaaaaaaaaaaa" as GatewayKeyId, AT);
  await assert.rejects(
    plane.touchGatewayKey(client.record.keyId, "2026-10-02 10:00"),
    code("INVALID_TIMESTAMP"),
  );
  await assert.rejects(
    plane.revokeGatewayKey(client.record.keyId, "now"),
    code("INVALID_TIMESTAMP"),
  );

  const fresh = key({ kind: "session", sessionId: "s-1" as SessionId });
  const invalid: unknown[] = [
    { ...fresh.record, secretHash: fresh.record.secretHash.toUpperCase() },
    { ...fresh.record, secretHash: "abc" },
    { ...fresh.record, keyId: "short" },
    { ...fresh.record, scope: { kind: "user", id: "x" } },
    { ...fresh.record, modelAllow: ["no-slash"] },
    { ...fresh.record, quota: { requestsPerMinute: 0 } },
  ];
  for (const sample of invalid)
    await assert.rejects(
      plane.createGatewayKey(sample as GatewayKeyRecord),
      code("MODEL_PLANE_RECORD_INVALID"),
    );
  assert.equal(count(raw(), "gateway_keys"), 2);
});

void test("wirings refer to stored keys and are replaced per adapter", async (t) => {
  const { plane, raw } = fixture(t);
  const first = key({ kind: "agent", adapterId: "codex" });
  const second = key({ kind: "agent", adapterId: "codex" });
  await plane.createGatewayKey(first.record);
  await plane.createGatewayKey(second.record);
  const wiring: WiringRecord = {
    adapterId: "codex",
    keyId: first.record.keyId,
    model: "alpha/chat-1",
    files: [
      {
        path: "/home/user/.codex/config.toml",
        beforeHash: "a".repeat(64),
        afterHash: "b".repeat(64),
        backupId: "backup-1",
      },
    ],
    wiredAt: AT,
  };
  await plane.putWiring(wiring);
  await plane.putWiring({ ...wiring, keyId: second.record.keyId });
  assert.deepEqual(await plane.listWirings(), [
    { ...wiring, keyId: second.record.keyId },
  ]);
  await assert.rejects(
    plane.putWiring({
      ...wiring,
      adapterId: "claude-code",
      keyId: "bbbbbbbbbbbb" as GatewayKeyId,
    }),
    code("WIRING_KEY_UNKNOWN"),
  );
  await assert.rejects(
    plane.putWiring({
      ...wiring,
      files: [{ path: "/x", afterHash: "not-a-hash" }],
    }),
    code("MODEL_PLANE_RECORD_INVALID"),
  );
  assert.equal(count(raw(), "wirings"), 1);
  assert.equal(await plane.deleteWiring("codex"), true);
  assert.equal(await plane.deleteWiring("codex"), false);
  assert.deepEqual(await plane.listWirings(), []);
});

void test("ledger entries are committed when append resolves and survive a reopen", async (t) => {
  const { plane, store, raw, open } = fixture(t);
  const entry = call();
  await plane.appendModelCall(entry);
  // Another connection sees the committed row without any close or flush.
  assert.equal(count(raw(), "model_calls"), 1);
  // Appending the identical entry again is a no-op; a different one conflicts.
  await plane.appendModelCall(entry);
  assert.equal(count(raw(), "model_calls"), 1);
  await assert.rejects(
    plane.appendModelCall({ ...entry, status: 500 }),
    code("MODEL_CALL_CONFLICT"),
  );
  plane.close();
  store.close();
  const reopened = open();
  assert.deepEqual(
    (await reopened.plane.listModelCalls({}, { limit: 10 })).items,
    [entry],
  );
});

void test("a ledger write that fails rejects and commits nothing", async (t) => {
  const { plane, raw } = fixture(t);
  const db = raw();
  db.exec(
    "CREATE TRIGGER refuse_calls BEFORE INSERT ON model_calls BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
  );
  await assert.rejects(plane.appendModelCall(call()), (error: unknown) => {
    assert.ok(error instanceof HubError);
    assert.equal(error.code, "MODEL_CALL_WRITE_FAILED");
    assert.equal(error.statusCode, 503);
    assert.match(String(error.cause), /synthetic write failure/);
    return true;
  });
  assert.equal(count(db, "model_calls"), 0);
  db.exec("DROP TRIGGER refuse_calls");
  await plane.appendModelCall(call());
  assert.equal(count(db, "model_calls"), 1);

  const invalid: unknown[] = [
    call({ status: 99 }),
    call({ error: "x".repeat(501) }),
    call({ occurredAt: "2026-10-02" }),
    call({
      usage: {
        input: -1,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        source: "reported",
      },
    }),
    { ...call(), cost: { amountUsd: 1 } },
    { ...call(), inbound: { protocol: "soap", path: "/", stream: false } },
  ];
  for (const sample of invalid)
    await assert.rejects(
      plane.appendModelCall(sample as ModelCallEntry),
      code("MODEL_PLANE_RECORD_INVALID"),
    );
  assert.equal(count(db, "model_calls"), 1);

  plane.close();
  plane.close();
  await assert.rejects(plane.appendModelCall(call()), code("STORE_CLOSED"));
  await assert.rejects(plane.listProviders(), code("STORE_CLOSED"));
  assert.equal(count(db, "model_calls"), 1);
});

void test("ledger pages run newest first with a stable cursor", async (t) => {
  const { plane, raw } = fixture(t);
  const entries: ModelCallEntry[] = [];
  // Three calls share each timestamp, and insertion order differs from time order.
  for (const minute of [5, 1, 3, 2, 4, 0, 6])
    for (let index = 0; index < 3; index++) {
      const occurredAt = `2026-10-02T08:0${minute}:00.000Z`;
      const entry = call(
        index === 0
          ? { occurredAt, keyId: "cccccccccccc" as GatewayKeyId }
          : { occurredAt },
      );
      entries.push(entry);
      await plane.appendModelCall(entry);
    }
  const expected = entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        Date.parse(b.entry.occurredAt) - Date.parse(a.entry.occurredAt) ||
        b.index - a.index,
    )
    .map(({ entry }) => entry.callId);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await plane.listModelCalls(
      {},
      cursor === undefined ? { limit: 5 } : { limit: 5, cursor },
    );
    seen.push(...page.items.map((item) => item.callId));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== undefined);
  assert.deepEqual(seen, expected);
  assert.equal(pages, 5);

  // An exact page leaves no cursor behind.
  const all = await plane.listModelCalls({}, { limit: 21 });
  assert.equal(all.items.length, 21);
  assert.equal(all.nextCursor, undefined);

  // Filters combine with the cursor.
  const filtered = await plane.listModelCalls(
    {
      keyId: "cccccccccccc" as GatewayKeyId,
      from: "2026-10-02T08:02:00.000Z",
      to: "2026-10-02T08:05:00.000Z",
    },
    { limit: 2 },
  );
  assert.deepEqual(
    filtered.items.map((item) => item.occurredAt),
    ["2026-10-02T08:04:00.000Z", "2026-10-02T08:03:00.000Z"],
  );
  assert.ok(filtered.nextCursor);
  const rest = await plane.listModelCalls(
    {
      keyId: "cccccccccccc" as GatewayKeyId,
      from: "2026-10-02T08:02:00.000Z",
      to: "2026-10-02T08:05:00.000Z",
    },
    { limit: 2, cursor: filtered.nextCursor },
  );
  assert.deepEqual(
    rest.items.map((item) => item.occurredAt),
    ["2026-10-02T08:02:00.000Z"],
  );
  assert.equal(rest.nextCursor, undefined);

  for (const limit of [0, 1001, 1.5])
    await assert.rejects(
      plane.listModelCalls({}, { limit }),
      code("INVALID_PAGE_LIMIT"),
    );
  for (const bad of [
    "",
    "garbage",
    Buffer.from("v1:x:1").toString("base64url"),
  ])
    await assert.rejects(
      plane.listModelCalls({}, { limit: 1, cursor: bad }),
      code("INVALID_CURSOR"),
    );
  await assert.rejects(
    plane.listModelCalls({ from: "last week" }, { limit: 1 }),
    code("INVALID_USAGE_FILTER"),
  );

  raw()
    .prepare(
      "UPDATE model_calls SET record = json_set(record, '$.status', 'ok') WHERE call_id = ?",
    )
    .run(expected[0]!);
  await assert.rejects(
    plane.listModelCalls({}, { limit: 1 }),
    code("STORAGE_CORRUPT"),
  );
});

void test("usage aggregation sums known costs, counts unpriced calls and zeroes missing usage", async (t) => {
  const { plane } = fixture(t);
  const agentKey = "aaaaaaaaaaaa" as GatewayKeyId;
  const clientKey = "bbbbbbbbbbbb" as GatewayKeyId;
  const usage = (input: number, source: "reported" | "estimated" | "missing") =>
    ({
      input,
      cacheRead: 1,
      cacheWrite: 2,
      output: 3,
      reasoning: 4,
      source,
    }) as const;
  await plane.appendModelCall(
    call({
      occurredAt: "2026-10-01T23:59:59.000Z",
      keyId: agentKey,
      scope: { kind: "agent", adapterId: "claude-code" },
      sessionId: "session-1" as SessionId,
      usage: usage(100, "reported"),
      cost: { amountUsd: 0.5, priceSource: "user" },
    }),
  );
  await plane.appendModelCall(
    call({
      occurredAt: "2026-10-02T00:00:00.000Z",
      keyId: agentKey,
      scope: { kind: "agent", adapterId: "claude-code" },
      usage: usage(200, "estimated"),
      cost: null,
    }),
  );
  await plane.appendModelCall(
    call({
      occurredAt: "2026-10-02T01:00:00.000Z",
      keyId: clientKey,
      scope: { kind: "client", name: "ci" },
      provider: "beta" as ProviderId,
      modelRef: "beta/chat-2" as ModelRef,
      status: 502,
      errorClass: "upstream_error",
      errorSource: "upstream",
      // Reported numbers under a missing source count as zero.
      usage: usage(999, "missing"),
      cost: { amountUsd: 0.25, priceSource: "catalog" },
    }),
  );
  const rejected = call({
    occurredAt: "2026-10-02T02:00:00.000Z",
    status: 401,
    rejected: true,
    rejectReason: "invalid_key",
    attempts: [],
    patches: [],
    cost: null,
  });
  for (const field of [
    "provider",
    "modelRef",
    "credentialId",
    "wireModel",
    "upstreamProtocol",
    "mode",
    "usage",
  ] as const)
    delete rejected[field];
  await plane.appendModelCall(rejected);

  const zero = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  };
  const byProvider = await plane.aggregateUsage({}, "provider");
  assert.deepEqual(byProvider, [
    {
      key: "",
      calls: 1,
      failedCalls: 1,
      usage: zero,
      costUsd: 0,
      unpricedCalls: 1,
    },
    {
      key: "alpha",
      calls: 2,
      failedCalls: 0,
      usage: {
        input: 300,
        cacheRead: 2,
        cacheWrite: 4,
        output: 6,
        reasoning: 8,
      },
      costUsd: 0.5,
      unpricedCalls: 1,
    },
    {
      key: "beta",
      calls: 1,
      failedCalls: 1,
      usage: zero,
      costUsd: 0.25,
      unpricedCalls: 0,
    },
  ]);
  assert.deepEqual(
    (await plane.aggregateUsage({}, "day")).map((bucket) => [
      bucket.key,
      bucket.calls,
    ]),
    [
      ["2026-10-01", 1],
      ["2026-10-02", 3],
    ],
  );
  assert.deepEqual(
    (await plane.aggregateUsage({}, "model")).map((bucket) => bucket.key),
    ["", "alpha/chat-1", "beta/chat-2"],
  );
  assert.deepEqual(
    (await plane.aggregateUsage({}, "key")).map((bucket) => [
      bucket.key,
      bucket.calls,
    ]),
    [
      ["", 1],
      [agentKey, 2],
      [clientKey, 1],
    ],
  );
  assert.deepEqual(
    (await plane.aggregateUsage({}, "adapter")).map((bucket) => [
      bucket.key,
      bucket.calls,
      bucket.costUsd,
      bucket.unpricedCalls,
    ]),
    [
      ["", 2, 0.25, 1],
      ["claude-code", 2, 0.5, 1],
    ],
  );
  // Filters: time range (from inclusive, to exclusive), key, provider, model, session.
  assert.deepEqual(
    (
      await plane.aggregateUsage(
        { from: "2026-10-02T00:00:00.000Z", to: "2026-10-02T02:00:00.000Z" },
        "day",
      )
    ).map((bucket) => [bucket.key, bucket.calls]),
    [["2026-10-02", 2]],
  );
  assert.equal(
    (await plane.aggregateUsage({ keyId: clientKey }, "key"))[0]?.calls,
    1,
  );
  assert.equal(
    (
      await plane.aggregateUsage(
        { provider: "alpha" as ProviderId },
        "provider",
      )
    )[0]?.calls,
    2,
  );
  assert.equal(
    (
      await plane.aggregateUsage(
        { modelRef: "beta/chat-2" as ModelRef },
        "model",
      )
    )[0]?.failedCalls,
    1,
  );
  assert.deepEqual(
    (
      await plane.aggregateUsage(
        { sessionId: "session-1" as SessionId },
        "provider",
      )
    ).map((bucket) => [bucket.key, bucket.costUsd]),
    [["alpha", 0.5]],
  );
  assert.deepEqual(
    await plane.aggregateUsage({ from: "2030-01-01T00:00:00Z" }, "day"),
    [],
  );
  await assert.rejects(
    plane.aggregateUsage({ to: "2026-13-45T00:00:00Z" }, "day"),
    code("INVALID_USAGE_FILTER"),
  );
});
