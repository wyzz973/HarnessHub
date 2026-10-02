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
    ],
  );
  assert.equal(LATEST_SCHEMA_VERSION, 2);
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
  ])
    assert.ok(tables.includes(table), table);
  // Reopening applies nothing.
  open("10.0.0-test").close();
  assert.equal(migrations(db).length, LATEST_SCHEMA_VERSION);
  assert.equal(migrations(db)[0]?.hh_version, "9.9.9-test");
});

void test("a user_version 1 database from the previous build migrates forward without data loss", (t) => {
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
    ],
  );
  assert.equal(userVersion(db), LATEST_SCHEMA_VERSION);
});
