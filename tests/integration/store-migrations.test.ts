// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { HubError } from "@harnesshub/core/errors";
import type { EngineProfile, RunId, SessionId } from "@harnesshub/core/types";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrationChecksum,
} from "@harnesshub/store/storage/migrations";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";
import {
  STORE_V1_RUN_IDS,
  STORE_V1_SESSION_ID,
  STORE_V1_STATEMENTS,
} from "../fixtures/store-v1-database.js";

const engine: EngineProfile = {
  id: "fake",
  driver: "fake",
  revision: "test-v2",
  enabled: true,
  maxConcurrency: 1,
  capabilities: { resume: false, permissions: true, images: false },
};

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-migrations-"));
  const path = join(dir, "harnesshub.sqlite");
  const owned: Array<{ close(): void }> = [];
  t.after(() => {
    for (const resource of owned.reverse()) resource.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const inspector = () => {
    const db = new DatabaseSync(path);
    owned.push(db);
    return db;
  };
  const open = (appVersion?: string) => {
    const store = new SqliteStore(
      path,
      appVersion === undefined ? {} : { appVersion },
    );
    owned.push(store);
    return store;
  };
  return { path, inspector, open, owned };
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof HubError && error.code === expected;
}

function migrations(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT version, name, checksum_sha256, hh_version, note FROM schema_migrations ORDER BY version",
    )
    .all()
    .map((row) => ({ ...row }));
}

function userVersion(db: DatabaseSync): unknown {
  return db.prepare("PRAGMA user_version").get()?.user_version;
}

function tableRows(db: DatabaseSync, table: string) {
  return db
    .prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
    .all()
    .map((row) => ({ ...row }));
}

const legacyTables = [
  "sessions",
  "runs",
  "events",
  "permissions",
  "artifacts",
  "runtime_metadata",
];

void test("migration checksums are pinned: an applied migration is never edited", () => {
  // Changing an entry here means a user database would refuse to open
  // (MIGRATION_TAMPERED); add a new migration instead.
  assert.deepEqual(
    MIGRATIONS.map((migration) => [
      migration.version,
      migration.name,
      migrationChecksum(migration),
    ]),
    [
      [
        1,
        "runtime_core",
        "4819de0c70640a88c2d669cc0ebdf03b92eb8a0df52e9a728e844dbfdc405535",
      ],
      [
        2,
        "model_plane",
        "b52ea0abc6b2664a753079d7b3405278a93cef5ad6771e6c90a7f934a6ecd1d1",
      ],
      [
        3,
        "model_metadata",
        "69f0a38b6306bd1daa53145c8a47d0cdd876c748a9d0cf688cc320d5737014d2",
      ],
      [
        4,
        "wiring_profiles",
        "3e25a337b4937a751d0552eb0216b7aa7aeed79880ef105fb4794a742de0d41d",
      ],
      [
        5,
        "model_call_attribution",
        "95f1867490c4de6b09646954989a64ed5de86f67b5d4cc1ad8e130511c1253d9",
      ],
      [
        6,
        "gateway_key_budgets",
        "890bb90f27e6b3c09f009533041177b55b804821a3e2fdd176ce13e311cae797",
      ],
    ],
  );
  assert.equal(LATEST_SCHEMA_VERSION, 6);
  assert.deepEqual(
    MIGRATIONS.map((migration) => migration.version),
    MIGRATIONS.map((_, index) => index + 1),
  );
});

void test("a new database applies every migration in order and records them", (t) => {
  const { open, inspector } = fixture(t);
  open("9.9.9-test").close();
  const db = inspector();
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  assert.deepEqual(
    migrations(db),
    MIGRATIONS.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum_sha256: migrationChecksum(migration),
      hh_version: "9.9.9-test",
      note: null,
    })),
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of [
    "sessions",
    "providers",
    "route_groups",
    "gateway_keys",
    "model_calls",
    "wirings",
    "model_overrides",
    "model_provenance",
    "wiring_profiles",
  ])
    assert.ok(tables.includes(table), table);
  // Reopening applies nothing.
  open("10.0.0-test").close();
  assert.equal(migrations(db).length, LATEST_SCHEMA_VERSION);
  assert.equal(migrations(db)[0]?.hh_version, "9.9.9-test");
});

void test("a user_version 1 database from the previous build migrates forward without data loss", async (t) => {
  const { path, open, inspector } = fixture(t);
  const legacy = new DatabaseSync(path);
  for (const statement of STORE_V1_STATEMENTS) legacy.exec(statement);
  const before = Object.fromEntries(
    legacyTables.map((table) => [table, tableRows(legacy, table)]),
  );
  const schemaBefore = legacy
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY rowid")
    .all()
    .map((row) => ({ ...row }));
  assert.equal(userVersion(legacy), 1);
  legacy.close();

  const store = open("9.9.9-test");
  const db = inspector();
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  const applied = migrations(db);
  assert.deepEqual(
    applied.map((row) => [row.version, row.name, row.note]),
    [
      [1, "runtime_core", "adopted from user_version 1"],
      [2, "model_plane", null],
      [3, "model_metadata", null],
      [4, "wiring_profiles", null],
      [5, "model_call_attribution", null],
      [6, "gateway_key_budgets", null],
    ],
  );
  assert.equal(applied[0]?.checksum_sha256, migrationChecksum(MIGRATIONS[0]!));
  // The existing tables, their definitions and every row are kept.
  for (const table of legacyTables)
    assert.deepEqual(tableRows(db, table), before[table], table);
  const schemaAfter = db
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY rowid")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(schemaAfter.slice(0, schemaBefore.length), schemaBefore);

  // The records read back through the Store, and it keeps working.
  const sessionId = STORE_V1_SESSION_ID as SessionId;
  const completedId = STORE_V1_RUN_IDS[0] as RunId;
  const runningId = STORE_V1_RUN_IDS[1] as RunId;
  assert.equal(store.getSession(sessionId).status, "open");
  assert.deepEqual(
    store.listRuns(sessionId).map((run) => [run.id, run.status]),
    [
      [completedId, "completed"],
      [runningId, "running"],
    ],
  );
  assert.equal(store.events(completedId).at(-1)?.type, "RUN_COMPLETED");
  assert.equal(store.listArtifacts(completedId).length, 1);
  assert.equal(store.listPermissions(runningId)[0]?.status, "decided");
  assert.equal(store.findRunByKey(sessionId, "fixture-key-1")?.id, completedId);
  store.acquireOwner();
  assert.deepEqual(store.readEngineCatalog(), { version: 2, fixture: true });
  const session = store.createSession(engine, {
    id: "workspace",
    path: "/fixture/workspace",
  });
  assert.equal(
    store.acceptRun(session.id, { text: "after migration", timeoutMs: 1000 })
      .run.generation,
    1,
  );
  const plane = new SqliteModelPlaneStore(path);
  t.after(async () => {
    plane.close();
    await plane.whenClosed();
  });
  assert.deepEqual(await plane.listProviders(), []);
});

void test("a version 2 database gains the model metadata tables and keeps its providers", async (t) => {
  const { path, open, inspector } = fixture(t);
  const v2 = new DatabaseSync(path);
  v2.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, hh_version TEXT, note TEXT)",
  );
  for (const migration of MIGRATIONS.slice(0, 2)) {
    v2.exec(migration.sql);
    v2.prepare(
      "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')",
    ).run(migration.version, migration.name, migrationChecksum(migration));
  }
  v2.exec("PRAGMA user_version = 2");
  const record = {
    schemaVersion: 1,
    id: "alpha",
    name: "Alpha",
    kind: "vendor",
    endpoints: { chat: "https://api.example.test/v1" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [],
    models: {
      source: "manual",
      list: [{ id: "chat-1", contextWindow: 128000 }],
      expose: "all",
    },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  v2.prepare("INSERT INTO providers (id, record) VALUES (?, ?)").run(
    "alpha",
    JSON.stringify(record),
  );
  v2.close();

  const store = open("9.9.9-test");
  const db = inspector();
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  assert.deepEqual(
    migrations(db).map((row) => [row.version, row.name, row.hh_version]),
    [
      [1, "runtime_core", null],
      [2, "model_plane", null],
      [3, "model_metadata", "9.9.9-test"],
      [4, "wiring_profiles", "9.9.9-test"],
      [5, "model_call_attribution", "9.9.9-test"],
      [6, "gateway_key_budgets", "9.9.9-test"],
    ],
  );
  store.acquireOwner();
  const plane = new SqliteModelPlaneStore(path);
  t.after(async () => {
    plane.close();
    await plane.whenClosed();
  });
  assert.deepEqual(await plane.listProviders(), [record]);
  assert.deepEqual(await plane.listModelOverrides("alpha"), []);
  assert.deepEqual(await plane.listModelProvenance("alpha"), []);
});

void test("a version 3 database keeps its wirings, which may then have no key, and gains profiles", async (t) => {
  const { path, open, inspector } = fixture(t);
  const v3 = new DatabaseSync(path);
  v3.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, hh_version TEXT, note TEXT)",
  );
  for (const migration of MIGRATIONS.slice(0, 3)) {
    v3.exec(migration.sql);
    v3.prepare(
      "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')",
    ).run(migration.version, migration.name, migrationChecksum(migration));
  }
  v3.exec("PRAGMA user_version = 3");
  const key = {
    keyId: "abcdefghijkl",
    name: "agent:codex",
    scope: { kind: "agent", adapterId: "codex" },
    modelAllow: ["alpha/chat-1"],
    secretHash: "0".repeat(64),
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const wiring = {
    adapterId: "codex",
    keyId: "abcdefghijkl",
    model: "alpha/chat-1",
    files: [
      {
        path: "/home/me/.codex/config.toml",
        afterHash: "1".repeat(64),
        backupId: "2".repeat(64),
      },
    ],
    wiredAt: "2026-10-01T00:00:00.000Z",
  };
  v3.prepare("INSERT INTO gateway_keys (key_id, record) VALUES (?, ?)").run(
    key.keyId,
    JSON.stringify(key),
  );
  v3.prepare(
    "INSERT INTO wirings (adapter_id, key_id, record) VALUES (?, ?, ?)",
  ).run("codex", key.keyId, JSON.stringify(wiring));
  // Before the migration a wiring without a key cannot be stored.
  assert.throws(() =>
    v3
      .prepare(
        "INSERT INTO wirings (adapter_id, key_id, record) VALUES ('claude', NULL, '{}')",
      )
      .run(),
  );
  v3.close();

  const store = open("9.9.9-test");
  assert.equal(userVersion(inspector()), LATEST_SCHEMA_VERSION);
  store.acquireOwner();
  const plane = new SqliteModelPlaneStore(path);
  t.after(async () => {
    plane.close();
    await plane.whenClosed();
  });
  assert.deepEqual(await plane.listWirings(), [wiring]);
  const signedIn = {
    adapterId: "claude",
    options: { auth: "own" },
    files: wiring.files,
    wiredAt: wiring.wiredAt,
  };
  await plane.putWiring(signedIn);
  assert.deepEqual(await plane.listWirings(), [signedIn, wiring]);
  assert.deepEqual(await plane.listWiringProfiles(), []);
});

void test("a version 4 database gains the ledger attribution columns, filled from what earlier calls recorded", async (t) => {
  const { path, open, inspector } = fixture(t);
  const v4 = new DatabaseSync(path);
  v4.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, hh_version TEXT, note TEXT)",
  );
  for (const migration of MIGRATIONS.slice(0, 4)) {
    v4.exec(migration.sql);
    v4.prepare(
      "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')",
    ).run(migration.version, migration.name, migrationChecksum(migration));
  }
  v4.exec("PRAGMA user_version = 4");
  const entry = (callId: string, extra: Record<string, unknown>) => ({
    callId,
    occurredAt: "2026-10-01T08:00:00.000Z",
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: false },
    patches: [],
    unmapped: [],
    status: 200,
    timing: { durationMs: 10 },
    attempts: [],
    cost: null,
    ...extra,
  });
  const insert = v4.prepare(
    "INSERT INTO model_calls (call_id, occurred_ms, key_id, provider, model_ref, session_id, run_id, adapter_id, status, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_usd, record) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, 200, 0, 0, 0, 0, 0, NULL, ?)",
  );
  const routed = entry("call-agent", {
    scope: { kind: "agent", adapterId: "claude" },
    provider: "alpha",
    modelRef: "alpha/chat-1",
    credentialId: "key-1",
  });
  const rejected = entry("call-rejected", { status: 401, rejected: true });
  insert.run(
    "call-agent",
    Date.parse(routed.occurredAt),
    "alpha",
    "alpha/chat-1",
    "claude",
    JSON.stringify(routed),
  );
  insert.run(
    "call-rejected",
    Date.parse(rejected.occurredAt),
    null,
    null,
    null,
    JSON.stringify(rejected),
  );
  v4.close();

  const store = open("9.9.9-test");
  const db = inspector();
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
  assert.deepEqual(
    migrations(db).map((row) => [row.version, row.name, row.hh_version]),
    [
      [1, "runtime_core", null],
      [2, "model_plane", null],
      [3, "model_metadata", null],
      [4, "wiring_profiles", null],
      [5, "model_call_attribution", "9.9.9-test"],
      [6, "gateway_key_budgets", "9.9.9-test"],
    ],
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT call_id, credential_id, conversation_key, agent FROM model_calls ORDER BY seq",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        call_id: "call-agent",
        credential_id: "key-1",
        conversation_key: null,
        agent: "claude",
      },
      {
        call_id: "call-rejected",
        credential_id: null,
        conversation_key: null,
        agent: null,
      },
    ],
  );
  store.acquireOwner();
  const plane = new SqliteModelPlaneStore(path);
  t.after(async () => {
    plane.close();
    await plane.whenClosed();
  });
  // The records are unchanged; the columns serve the new filters and buckets.
  assert.deepEqual(
    (await plane.listModelCalls({}, { limit: 10 })).items.map(
      (item) => item.callId,
    ),
    ["call-rejected", "call-agent"],
  );
  assert.deepEqual(
    (await plane.aggregateUsage({ agent: "claude" }, "credential")).map(
      (bucket) => [bucket.key, bucket.calls],
    ),
    [["alpha/key-1", 1]],
  );
  assert.deepEqual(await plane.listHiddenAutoGroups(), []);
});

void test("a version 5 database's key quotas become calendar budgets that count as they did, caps of 0 included", async (t) => {
  const { path, open, inspector } = fixture(t);
  const v5 = new DatabaseSync(path);
  v5.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, hh_version TEXT, note TEXT)",
  );
  for (const migration of MIGRATIONS.slice(0, 5)) {
    v5.exec(migration.sql);
    v5.prepare(
      "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')",
    ).run(migration.version, migration.name, migrationChecksum(migration));
  }
  v5.exec("PRAGMA user_version = 5");
  const key = (keyId: string, quota?: Record<string, number>) => ({
    keyId,
    name: keyId,
    scope: { kind: "client", name: keyId },
    modelAllow: ["*"],
    ...(quota ? { quota } : {}),
    secretHash: "0".repeat(64),
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const insert = v5.prepare(
    "INSERT INTO gateway_keys (key_id, record) VALUES (?, ?)",
  );
  for (const record of [
    key("aaaaaaaaaaaa", {
      requestsPerMinute: 30,
      tokensPerDay: 1_000_000,
      costPerMonthUsd: 25,
    }),
    key("bbbbbbbbbbbb", { tokensPerDay: 500, costPerMonthUsd: 0 }),
    key("cccccccccccc", { costPerMonthUsd: 0 }),
    key("dddddddddddd", { requestsPerMinute: 5 }),
    key("eeeeeeeeeeee"),
    key("ffffffffffff", { tokensPerDay: 0 }),
    key("gggggggggggg", { tokensPerDay: 0, costPerMonthUsd: 0 }),
  ])
    insert.run(record.keyId, JSON.stringify(record));
  v5.close();

  const store = open("9.9.9-test");
  assert.equal(userVersion(inspector()), 6);
  store.acquireOwner();
  const plane = new SqliteModelPlaneStore(path);
  t.after(async () => {
    plane.close();
    await plane.whenClosed();
  });
  assert.deepEqual(
    (await plane.listGatewayKeys()).map((record) => [
      record.keyId,
      record.quota,
    ]),
    [
      [
        "aaaaaaaaaaaa",
        {
          requestsPerMinute: 30,
          budgets: [
            { period: "day", tokens: 1_000_000, cacheReads: true },
            { period: "month", costUsd: 25 },
          ],
        },
      ],
      [
        "bbbbbbbbbbbb",
        {
          budgets: [
            { period: "day", tokens: 500, cacheReads: true },
            { period: "month", costUsd: 0 },
          ],
        },
      ],
      // A cap of 0 refused every call and still does: none is dropped.
      ["cccccccccccc", { budgets: [{ period: "month", costUsd: 0 }] }],
      ["dddddddddddd", { requestsPerMinute: 5 }],
      ["eeeeeeeeeeee", undefined],
      [
        "ffffffffffff",
        { budgets: [{ period: "day", tokens: 0, cacheReads: true }] },
      ],
      [
        "gggggggggggg",
        {
          budgets: [
            { period: "day", tokens: 0, cacheReads: true },
            { period: "month", costUsd: 0 },
          ],
        },
      ],
    ],
  );
  // Each of them reads back as a valid key.
  for (const keyId of [
    "bbbbbbbbbbbb",
    "cccccccccccc",
    "ffffffffffff",
    "gggggggggggg",
  ])
    assert.ok(await plane.getGatewayKey(keyId as never), keyId);
  assert.equal(
    await plane.setGatewayKeyQuota("eeeeeeeeeeee" as never, {
      budgets: [{ period: "week", costUsd: 3 }],
    }),
    true,
  );
  assert.deepEqual(
    (await plane.getGatewayKey("eeeeeeeeeeee" as never))?.quota,
    { budgets: [{ period: "week", costUsd: 3 }] },
  );
  await assert.rejects(
    plane.setGatewayKeyQuota("eeeeeeeeeeee" as never, {
      budgets: [
        { period: "week", costUsd: 3 },
        { period: "week", tokens: 3 },
      ],
    }),
    code("MODEL_PLANE_RECORD_INVALID"),
  );
  assert.equal(
    await plane.setGatewayKeyQuota("zzzzzzzzzzzz" as never, undefined),
    false,
  );
});

void test("a database newer than this build is refused without modification", (t) => {
  const { open, inspector } = fixture(t);
  open().close();
  const db = inspector();
  db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
  db.exec("PRAGMA journal_mode = DELETE");
  assert.throws(() => open(), code("SCHEMA_TOO_NEW"));
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION + 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
  assert.equal(migrations(db).length, LATEST_SCHEMA_VERSION);

  // A newer migration row is refused the same way.
  db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
  db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at) VALUES (?, 'future', 'x', '2030-01-01T00:00:00.000Z')",
  ).run(LATEST_SCHEMA_VERSION + 1);
  assert.throws(() => open(), code("SCHEMA_TOO_NEW"));
  db.exec(
    `DELETE FROM schema_migrations WHERE version > ${LATEST_SCHEMA_VERSION}`,
  );
  open().close();
});

void test("an edited, renamed or missing applied migration is refused", (t) => {
  const { open, inspector } = fixture(t);
  open().close();
  const db = inspector();
  const original = migrationChecksum(MIGRATIONS[0]!);
  db.prepare(
    "UPDATE schema_migrations SET checksum_sha256 = ? WHERE version = 1",
  ).run("0".repeat(64));
  assert.throws(() => open(), code("MIGRATION_TAMPERED"));
  db.prepare(
    "UPDATE schema_migrations SET checksum_sha256 = ?, name = 'renamed' WHERE version = 1",
  ).run(original);
  assert.throws(() => open(), code("MIGRATION_TAMPERED"));
  db.exec(
    "UPDATE schema_migrations SET name = 'runtime_core' WHERE version = 1",
  );
  open().close();
  const row = db
    .prepare("SELECT * FROM schema_migrations WHERE version = 1")
    .get();
  db.exec("DELETE FROM schema_migrations WHERE version = 1");
  assert.throws(() => open(), code("MIGRATION_TAMPERED"));
  db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at, hh_version, note) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(1, "runtime_core", original, String(row?.applied_at), null, null);
  open().close();
});

void test("version records that disagree are refused", (t) => {
  const { path, open, inspector } = fixture(t);
  open().close();
  const db = inspector();
  db.exec("PRAGMA user_version = 1");
  assert.throws(() => open(), code("STORAGE_VERSION_UNSUPPORTED"));
  db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
  open().close();

  // A version 1 marker without the version 1 tables is not adopted.
  const other = join(dirname(path), "marker-only.sqlite");
  const empty = new DatabaseSync(other);
  empty.exec("PRAGMA user_version = 1");
  empty.close();
  assert.throws(
    () => new SqliteStore(other),
    code("STORAGE_VERSION_UNSUPPORTED"),
  );
  const after = new DatabaseSync(other);
  try {
    assert.equal(userVersion(after), 1);
    assert.equal(
      after
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'schema_migrations'",
        )
        .get()?.count,
      0,
    );
  } finally {
    after.close();
  }
});

void test("simultaneous opens of a version 1 database apply each migration exactly once", async (t) => {
  const { path, inspector } = fixture(t);
  // Databases of the previous build are already in WAL mode. (Switching a
  // brand-new file to WAL is not covered: SQLite reports SQLITE_BUSY for that
  // switch without waiting, before any migration runs.)
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA journal_mode = WAL");
  for (const statement of STORE_V1_STATEMENTS) legacy.exec(statement);
  legacy.close();
  const moduleUrl = import.meta
    .resolve("@harnesshub/store/storage/sqlite-store");
  const gate = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
  });
  const results = Array.from({ length: 4 }, () => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { SqliteStore } = await import(workerData.moduleUrl);
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(workerData.gate), 0, 0);
        try { new SqliteStore(workerData.path).close(); parentPort.postMessage('opened'); }
        catch (error) { parentPort.postMessage(String(error.code ?? error.message)); }
      })();
    `,
      { eval: true, workerData: { moduleUrl, path, gate } },
    );
    workers.push(worker);
    const ready = Promise.withResolvers<void>();
    const result = Promise.withResolvers<unknown>();
    worker.on("message", (value: unknown) => {
      if (value === "ready") ready.resolve();
      else result.resolve(value);
    });
    worker.on("error", (error) => {
      ready.reject(error);
      result.reject(error);
    });
    return { ready: ready.promise, result: result.promise };
  });
  await Promise.all(results.map((entry) => entry.ready));
  const signal = new Int32Array(gate);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
  assert.deepEqual(await Promise.all(results.map((entry) => entry.result)), [
    "opened",
    "opened",
    "opened",
    "opened",
  ]);
  const db = inspector();
  assert.deepEqual(
    migrations(db).map((row) => [row.version, row.note]),
    [
      [1, "adopted from user_version 1"],
      [2, null],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
    ],
  );
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
});
