// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const planes: SqliteModelPlaneStore[] = [];
  t.after(async () => {
    for (const resource of owned.reverse()) resource.close();
    // The checkpoint workers' connections close before the files go.
    await Promise.all(planes.map((plane) => plane.whenClosed()));
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (options?: { checkpointIntervalMs?: number }) => {
    const store = new SqliteStore(path);
    owned.push(store);
    store.acquireOwner();
    const plane = new SqliteModelPlaneStore(path, options);
    owned.push(plane);
    planes.push(plane);
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
    // A group member names a group; it takes no suffix of its own.
    group("fast", { members: ["group/other:high" as ModelRef] }),
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
    // Only client keys may be used from the local network.
    { ...fresh.record, allowLan: true },
    { ...fresh.record, allowLan: "yes" },
  ];
  for (const sample of invalid)
    await assert.rejects(
      plane.createGatewayKey(sample as GatewayKeyRecord),
      code("MODEL_PLANE_RECORD_INVALID"),
    );
  assert.equal(count(raw(), "gateway_keys"), 2);
  const lan = key({ kind: "client", name: "laptop" }, "lan key");
  await plane.createGatewayKey({ ...lan.record, allowLan: true });
  assert.equal((await plane.getGatewayKey(lan.record.keyId))?.allowLan, true);
  await plane.createGatewayKey({
    ...fresh.record,
    allowLan: false,
  });
  assert.equal(count(raw(), "gateway_keys"), 4);
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

void test("a wiring may have no key, a key's model lists change in place, and profiles are stored by name", async (t) => {
  const { plane, raw } = fixture(t);
  const signedIn: WiringRecord = {
    adapterId: "codex",
    options: { codexAuth: "chatgpt" },
    files: [
      {
        path: "/home/user/.codex/config.toml",
        afterHash: "b".repeat(64),
        backupId: "backup-1",
      },
    ],
    wiredAt: AT,
  };
  await plane.putWiring(signedIn);
  assert.deepEqual(await plane.listWirings(), [signedIn]);
  assert.equal(raw().prepare("SELECT key_id FROM wirings").get()?.key_id, null);
  await assert.rejects(
    plane.putWiring({ ...signedIn, effort: "extreme" as "high" }),
    code("MODEL_PLANE_RECORD_INVALID"),
  );
  await assert.rejects(
    plane.putWiring({ ...signedIn, tiers: { large: "a/b" } as never }),
    code("MODEL_PLANE_RECORD_INVALID"),
  );

  const agent = key({ kind: "agent", adapterId: "claude" });
  await plane.createGatewayKey({ ...agent.record, modelAllow: ["*"] });
  assert.equal(
    await plane.setGatewayKeyModels(agent.record.keyId, ["*"], ["alpha/*"]),
    true,
  );
  const stored = await plane.getGatewayKey(agent.record.keyId);
  assert.deepEqual(stored?.modelAllow, ["*"]);
  assert.deepEqual(stored?.modelDeny, ["alpha/*"]);
  await plane.setGatewayKeyModels(agent.record.keyId, ["*"], []);
  assert.equal(
    "modelDeny" in (await plane.getGatewayKey(agent.record.keyId))!,
    false,
  );
  await assert.rejects(
    plane.setGatewayKeyModels(agent.record.keyId, ["*"], ["not a ref"]),
    code("MODEL_PLANE_RECORD_INVALID"),
  );
  assert.equal(
    await plane.setGatewayKeyModels("zzzzzzzzzzzz" as GatewayKeyId, [], []),
    false,
  );

  const profile = {
    name: "work",
    agents: {
      claude: {
        model: "alpha/chat-1",
        tiers: { haiku: "group/fast" },
        effort: "high" as const,
      },
      codex: { options: { codexAuth: "chatgpt" } },
    },
    createdAt: AT,
    updatedAt: AT,
  };
  await plane.putWiringProfile(profile);
  await plane.putWiringProfile({ ...profile, name: "home", agents: {} });
  assert.deepEqual(
    (await plane.listWiringProfiles()).map((item) => item.name),
    ["home", "work"],
  );
  assert.deepEqual(await plane.getWiringProfile("work"), profile);
  await assert.rejects(
    plane.putWiringProfile({ ...profile, name: "bad name" }),
    code("MODEL_PLANE_RECORD_INVALID"),
  );
  assert.equal(await plane.deleteWiringProfile("home"), true);
  assert.equal(await plane.deleteWiringProfile("home"), false);
  assert.equal(await plane.getWiringProfile("home"), undefined);
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

void test("concurrent ledger appends commit as a group: every one durable, readable and in order", async (t) => {
  const { plane, raw } = fixture(t);
  const conversationKey = "c1".repeat(32);
  const entries = Array.from({ length: 300 }, () => call({ conversationKey }));
  // Appended in one burst: they share a transaction.
  await Promise.all(entries.map((entry) => plane.appendModelCall(entry)));
  assert.equal(count(raw(), "model_calls"), 300);
  // Same time: newest first is the reverse of the order they were appended in.
  const listed: ModelCallEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await plane.listModelCalls(
      { conversationKey },
      { limit: 100, ...(cursor ? { cursor } : {}) },
    );
    listed.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    listed.map((entry) => entry.callId),
    entries.map((entry) => entry.callId).reverse(),
  );
});

void test("an entry that fails in a group fails alone; the others commit", async (t) => {
  const { plane, raw } = fixture(t);
  const earlier = call();
  await plane.appendModelCall(earlier);
  const db = raw();
  db.exec(
    "CREATE TRIGGER refuse_one BEFORE INSERT ON model_calls WHEN NEW.call_id = 'call-refused' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
  );
  const before = call();
  const refused = call({ callId: "call-refused" as ModelCallId });
  const conflicting = { ...earlier, status: 500 };
  const after = call();
  const results = await Promise.allSettled([
    plane.appendModelCall(before),
    plane.appendModelCall(refused),
    plane.appendModelCall(conflicting),
    plane.appendModelCall(earlier),
    plane.appendModelCall(after),
  ]);
  assert.deepEqual(
    results.map((result) =>
      result.status === "fulfilled"
        ? "committed"
        : (result.reason as HubError).code,
    ),
    [
      "committed",
      "MODEL_CALL_WRITE_FAILED",
      "MODEL_CALL_CONFLICT",
      "committed",
      "committed",
    ],
  );
  assert.match(
    String(((results[1] as PromiseRejectedResult).reason as HubError).cause),
    /synthetic write failure/,
  );
  assert.deepEqual(
    db
      .prepare("SELECT call_id FROM model_calls ORDER BY seq")
      .all()
      .map((row) => row.call_id),
    [earlier.callId, before.callId, after.callId],
  );
});

void test("close() commits the group still waiting, and the appends resolve", async (t) => {
  const { plane, store, open } = fixture(t);
  const entries = [call(), call(), call()];
  const appended = entries.map((entry) => plane.appendModelCall(entry));
  plane.close();
  await Promise.all(appended);
  store.close();
  const reopened = open();
  assert.equal(
    (await reopened.plane.listModelCalls({}, { limit: 10 })).items.length,
    3,
  );
});

void test("appends that resolved before the process was killed are in the ledger after a restart", async (t) => {
  const { dir, path, plane, store, open } = fixture(t);
  plane.close();
  store.close();
  const entries = Array.from({ length: 200 }, () => call());
  const file = join(dir, "entries.json");
  writeFileSync(file, JSON.stringify(entries));
  // A process that owns the database, appends in one burst, reports the
  // resolved appends and is killed without closing anything.
  const program = `
    const { readFileSync } = await import("node:fs");
    const { SqliteStore } = await import(${JSON.stringify(import.meta.resolve("@harnesshub/store/storage/sqlite-store"))});
    const { SqliteModelPlaneStore } = await import(${JSON.stringify(import.meta.resolve("@harnesshub/store/storage/model-plane-store"))});
    const store = new SqliteStore(${JSON.stringify(path)});
    store.acquireOwner();
    const plane = new SqliteModelPlaneStore(${JSON.stringify(path)});
    const entries = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8"));
    await Promise.all(entries.map((entry) => plane.appendModelCall(entry)));
    process.stdout.write("resolved " + entries.length + "\\n", () => process.kill(process.pid, "SIGKILL"));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(child.stdout, "resolved 200\n");
  const restarted = open();
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await restarted.plane.listModelCalls(
      {},
      { limit: 100, ...(cursor ? { cursor } : {}) },
    );
    for (const entry of page.items) ids.add(entry.callId);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    [...ids].sort(),
    entries.map((entry) => entry.callId).sort(),
  );
});

void test("commits leave WAL checkpoints to a worker, which keeps the WAL small", async (t) => {
  const { path, plane: first, store: firstStore, open } = fixture(t);
  first.close();
  firstStore.close();
  const { plane } = open({ checkpointIntervalMs: 20 });
  const size = (file: string) =>
    statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  const before = size(path);
  for (let burst = 0; burst < 15; burst++) {
    await Promise.all(
      Array.from({ length: 200 }, () => plane.appendModelCall(call())),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  // The writer does not checkpoint (wal_autocheckpoint = 0): the worker's
  // checkpoints are what moved the pages into the database file.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const database = size(path);
  assert.ok(
    database - before > 1024 * 1024,
    `the database grew by ${database - before} bytes`,
  );
  assert.ok(
    size(`${path}-wal`) < database,
    `the WAL (${size(`${path}-wal`)} bytes) stays smaller than the database`,
  );
});

void test("appends that resolved are in the ledger after a kill while checkpoints run", async (t) => {
  const { dir, path, plane, store, open } = fixture(t);
  plane.close();
  store.close();
  const entries = Array.from({ length: 3000 }, () => call());
  const file = join(dir, "entries.json");
  writeFileSync(file, JSON.stringify(entries));
  // Bursts back to back with the worker checkpointing every millisecond;
  // the process reports each resolved burst and is killed after the last.
  const program = `
    const { readFileSync } = await import("node:fs");
    const { SqliteStore } = await import(${JSON.stringify(import.meta.resolve("@harnesshub/store/storage/sqlite-store"))});
    const { SqliteModelPlaneStore } = await import(${JSON.stringify(import.meta.resolve("@harnesshub/store/storage/model-plane-store"))});
    const store = new SqliteStore(${JSON.stringify(path)});
    store.acquireOwner();
    const plane = new SqliteModelPlaneStore(${JSON.stringify(path)}, { checkpointIntervalMs: 1 });
    const entries = JSON.parse(readFileSync(${JSON.stringify(file)}, "utf8"));
    for (let at = 0; at < entries.length; at += 100)
      await Promise.all(entries.slice(at, at + 100).map((entry) => plane.appendModelCall(entry)));
    process.stdout.write("resolved " + entries.length + "\\n", () => process.kill(process.pid, "SIGKILL"));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(child.stdout, "resolved 3000\n");
  const restarted = open();
  const check = new DatabaseSync(path);
  const integrity = check.prepare("PRAGMA integrity_check").get();
  check.close();
  assert.equal(integrity?.integrity_check, "ok");
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await restarted.plane.listModelCalls(
      {},
      { limit: 500, ...(cursor ? { cursor } : {}) },
    );
    count += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(count, 3000);
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
  // Credential IDs are unique within their provider only.
  assert.deepEqual(
    (await plane.aggregateUsage({}, "credential")).map((bucket) => [
      bucket.key,
      bucket.calls,
    ]),
    [
      ["", 1],
      ["alpha/primary", 2],
      ["beta/primary", 1],
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

void test("conversations sum their calls, newest first, with a stable cursor and filters", async (t) => {
  const { plane, store, open } = fixture(t);
  const conversation = (index: number) => index.toString(16).repeat(64);
  const [first, second, third] = [1, 2, 3].map(conversation) as [
    string,
    string,
    string,
  ];
  const at = (minute: number) => `2026-10-02T08:0${minute}:00.000Z`;
  await plane.appendModelCall(
    call({
      occurredAt: at(1),
      conversationKey: first,
      agent: { id: "claude", source: "key" },
      cost: { amountUsd: 0.5, priceSource: "provider" },
    }),
  );
  await plane.appendModelCall(
    call({
      occurredAt: at(4),
      conversationKey: first,
      agent: { id: "claude", source: "key" },
      provider: "beta" as ProviderId,
      modelRef: "beta/chat-2" as ModelRef,
      credentialId: "backup" as CredentialId,
      status: 429,
      cost: null,
    }),
  );
  await plane.appendModelCall(
    call({
      occurredAt: at(3),
      conversationKey: second,
      agent: { id: "codex", source: "user-agent" },
    }),
  );
  // A rejected call keeps its conversation but names no model or credential.
  const rejected = call({
    occurredAt: at(2),
    conversationKey: third,
    status: 403,
    rejected: true,
    rejectReason: "model_not_allowed",
    attempts: [],
    cost: null,
  });
  for (const field of [
    "provider",
    "modelRef",
    "credentialId",
    "usage",
  ] as const)
    delete rejected[field];
  await plane.appendModelCall(rejected);
  // Calls without a conversation are no conversation's.
  await plane.appendModelCall(call({ occurredAt: at(5) }));

  const all = await plane.listConversations({}, { limit: 10 });
  assert.equal(all.nextCursor, undefined);
  assert.deepEqual(all.items[0], {
    key: first,
    calls: 2,
    failedCalls: 1,
    usage: {
      input: 200,
      cacheRead: 20,
      cacheWrite: 0,
      output: 100,
      reasoning: 10,
    },
    costUsd: 0.5,
    unpricedCalls: 1,
    firstAt: at(1),
    lastAt: at(4),
    models: ["alpha/chat-1", "beta/chat-2"],
    credentials: ["alpha/primary", "beta/backup"],
    agents: ["claude"],
  });
  assert.deepEqual(
    all.items.map((item) => item.key),
    [first, second, third],
  );
  assert.deepEqual(all.items[2], {
    key: third,
    calls: 1,
    failedCalls: 1,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    costUsd: 0,
    unpricedCalls: 1,
    firstAt: at(2),
    lastAt: at(2),
    models: [],
    credentials: [],
    agents: [],
  });

  // Paging by one walks the same order and ends without a cursor.
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await plane.listConversations(
      {},
      cursor === undefined ? { limit: 1 } : { limit: 1, cursor },
    );
    seen.push(...page.items.map((item) => item.key));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.deepEqual(seen, [first, second, third]);

  // Filters apply to the calls before they are summed.
  assert.deepEqual(
    (
      await plane.listConversations({ agent: "codex" }, { limit: 10 })
    ).items.map((item) => item.key),
    [second],
  );
  const window = await plane.listConversations(
    { from: at(2), to: at(4) },
    { limit: 10 },
  );
  assert.deepEqual(
    window.items.map((item) => [item.key, item.calls]),
    [
      [second, 1],
      [third, 1],
    ],
  );
  // One conversation's calls, newest first.
  assert.deepEqual(
    (
      await plane.listModelCalls({ conversationKey: first }, { limit: 10 })
    ).items.map((item) => item.occurredAt),
    [at(4), at(1)],
  );
  assert.deepEqual(
    (await plane.aggregateUsage({ agent: "claude" }, "model")).map((bucket) => [
      bucket.key,
      bucket.calls,
    ]),
    [
      ["alpha/chat-1", 1],
      ["beta/chat-2", 1],
    ],
  );

  for (const limit of [0, 1001])
    await assert.rejects(
      plane.listConversations({}, { limit }),
      code("INVALID_PAGE_LIMIT"),
    );
  for (const bad of [
    "garbage",
    Buffer.from("v1:1:1").toString("base64url"),
    Buffer.from("c1:1:not-a-key").toString("base64url"),
  ])
    await assert.rejects(
      plane.listConversations({}, { limit: 1, cursor: bad }),
      code("INVALID_CURSOR"),
    );
  await assert.rejects(
    plane.listConversations({ from: "yesterday" }, { limit: 1 }),
    code("INVALID_USAGE_FILTER"),
  );

  // The columns come back after a reopen.
  plane.close();
  store.close();
  const reopened = open().plane;
  assert.equal(
    (await reopened.listConversations({}, { limit: 10 })).items.length,
    3,
  );
});

void test("hidden automatic groups are kept until restored and survive a reopen", async (t) => {
  const { plane, store, open } = fixture(t);
  assert.deepEqual(await plane.listHiddenAutoGroups(), []);
  assert.equal(
    await plane.setAutoGroupHidden("auto-glm-4-6" as RouteGroupId, true),
    true,
  );
  assert.equal(
    await plane.setAutoGroupHidden("auto-glm-4-6" as RouteGroupId, true),
    false,
  );
  await plane.setAutoGroupHidden("auto-deepseek-v4" as RouteGroupId, true);
  assert.deepEqual(await plane.listHiddenAutoGroups(), [
    "auto-deepseek-v4",
    "auto-glm-4-6",
  ]);
  plane.close();
  store.close();
  const reopened = open().plane;
  assert.deepEqual(await reopened.listHiddenAutoGroups(), [
    "auto-deepseek-v4",
    "auto-glm-4-6",
  ]);
  assert.equal(
    await reopened.setAutoGroupHidden("auto-glm-4-6" as RouteGroupId, false),
    true,
  );
  assert.equal(
    await reopened.setAutoGroupHidden("auto-glm-4-6" as RouteGroupId, false),
    false,
  );
  assert.deepEqual(await reopened.listHiddenAutoGroups(), ["auto-deepseek-v4"]);
  for (const bad of ["fast", "auto-", "auto-UPPER", "auto-a b", "group/auto-x"])
    await assert.rejects(
      reopened.setAutoGroupHidden(bad as RouteGroupId, true),
      code("AUTO_GROUP_ID_INVALID"),
    );
});
