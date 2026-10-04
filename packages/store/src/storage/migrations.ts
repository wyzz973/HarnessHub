// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HubError } from "@harnesshub/core/errors";

/**
 * One forward-only schema step (07-data-security section 2.2). A migration
 * that has reached a user database is never edited: its SHA-256 is recorded in
 * `schema_migrations` and compared at every open. There are no down
 * migrations; rolling back means restoring a backup with the older binary.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * The SQLite schema in order. Version 1 is the schema that `SqliteStore`
 * created with `user_version = 1` before this framework existed, byte for byte
 * in meaning; such databases are adopted as version 1 without running it.
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "runtime_core",
    sql: `
CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), generation INTEGER NOT NULL, idempotency_key TEXT, input_hash TEXT NOT NULL, created_at INTEGER NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(session_id, idempotency_key), UNIQUE(session_id, generation));
CREATE TABLE events (run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL CHECK(seq > 0), event_id TEXT NOT NULL UNIQUE, source_seq INTEGER, type TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)), record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(run_id, seq), UNIQUE(run_id, source_seq));
CREATE UNIQUE INDEX events_one_terminal ON events(run_id) WHERE terminal = 1;
CREATE INDEX runs_session ON runs(session_id, generation);
CREATE TABLE permissions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL CHECK(json_valid(record)));
CREATE INDEX permissions_run ON permissions(run_id);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL CHECK(json_valid(record)));
CREATE INDEX artifacts_run ON artifacts(run_id);
`,
  },
  {
    version: 2,
    name: "model_plane",
    // Records stay JSON validated on read; the ledger also keeps the columns
    // that filters, cursors and usage sums need, so aggregation never parses JSON.
    sql: `
CREATE TABLE providers (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE route_groups (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE gateway_keys (key_id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE model_calls (seq INTEGER PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, occurred_ms INTEGER NOT NULL, key_id TEXT, provider TEXT, model_ref TEXT, session_id TEXT, run_id TEXT, adapter_id TEXT, status INTEGER NOT NULL, input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cost_usd REAL, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE INDEX model_calls_time ON model_calls(occurred_ms, seq);
CREATE INDEX model_calls_key ON model_calls(key_id, occurred_ms);
CREATE INDEX model_calls_provider ON model_calls(provider, occurred_ms);
CREATE INDEX model_calls_model ON model_calls(model_ref, occurred_ms);
CREATE INDEX model_calls_session ON model_calls(session_id, occurred_ms);
CREATE TABLE wirings (adapter_id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES gateway_keys(key_id), record TEXT NOT NULL CHECK(json_valid(record)));
`,
  },
  {
    version: 3,
    name: "model_metadata",
    // User overrides and the provenance of derived model metadata (03 section
    // 7); both go with their provider.
    sql: `
CREATE TABLE model_overrides (ref TEXT PRIMARY KEY, provider TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE INDEX model_overrides_provider ON model_overrides(provider, ref);
CREATE TABLE model_provenance (ref TEXT PRIMARY KEY, provider TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE INDEX model_provenance_provider ON model_provenance(provider, ref);
`,
  },
  {
    version: 4,
    name: "wiring_profiles",
    // An agent that signs in by itself (Codex with a ChatGPT login) is wired
    // without a key, so key_id becomes nullable; SQLite changes a column
    // constraint only by rebuilding the table. Nothing refers to wirings.
    sql: `
CREATE TABLE wirings_v4 (adapter_id TEXT PRIMARY KEY, key_id TEXT REFERENCES gateway_keys(key_id), record TEXT NOT NULL CHECK(json_valid(record)));
INSERT INTO wirings_v4 (adapter_id, key_id, record) SELECT adapter_id, key_id, record FROM wirings;
DROP TABLE wirings;
ALTER TABLE wirings_v4 RENAME TO wirings;
CREATE TABLE wiring_profiles (name TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
`,
  },
  {
    version: 5,
    name: "model_call_attribution",
    // Ledger columns for usage by credential, the conversation views and the
    // agent filter; earlier rows get the credential and an agent key's
    // adapter from what they recorded. Hidden automatic groups (03 section 5).
    sql: `
ALTER TABLE model_calls ADD COLUMN credential_id TEXT;
ALTER TABLE model_calls ADD COLUMN conversation_key TEXT;
ALTER TABLE model_calls ADD COLUMN agent TEXT;
UPDATE model_calls SET credential_id = json_extract(record, '$.credentialId'), agent = adapter_id;
CREATE INDEX model_calls_conversation ON model_calls(conversation_key, occurred_ms);
CREATE INDEX model_calls_agent ON model_calls(agent, occurred_ms);
CREATE TABLE hidden_auto_groups (id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL);
`,
  },
  {
    version: 6,
    name: "gateway_key_budgets",
    // Key quotas move to calendar budgets (Magpie access.Limit): a UTC day's
    // tokensPerDay becomes a day budget that also counts cache reads, as it
    // did, and costPerMonthUsd a month budget; both now run in local time.
    // Every cap is carried over as it is, 0 included: a cap of 0 refused
    // every call and still does, so no key may do more than before.
    sql: `
UPDATE gateway_keys SET record = json_set(
  json_remove(record, '$.quota.tokensPerDay', '$.quota.costPerMonthUsd'),
  '$.quota.budgets',
  json((
    SELECT json_group_array(json(budget)) FROM (
      SELECT json_object('period', 'day', 'tokens', json_extract(record, '$.quota.tokensPerDay'), 'cacheReads', json('true')) AS budget
        WHERE json_extract(record, '$.quota.tokensPerDay') IS NOT NULL
      UNION ALL
      SELECT json_object('period', 'month', 'costUsd', json_extract(record, '$.quota.costPerMonthUsd'))
        WHERE json_extract(record, '$.quota.costPerMonthUsd') IS NOT NULL
    )
  ))
)
WHERE json_extract(record, '$.quota.tokensPerDay') IS NOT NULL
   OR json_extract(record, '$.quota.costPerMonthUsd') IS NOT NULL;
`,
  },
]);

/** The schema version this build creates and requires. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

const LEGACY_V1_TABLES = [
  "sessions",
  "runs",
  "events",
  "permissions",
  "artifacts",
] as const;

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

/** Where an opened database stands relative to `MIGRATIONS`. */
export interface SchemaState {
  /** Highest applied version; 0 for an empty database. */
  readonly version: number;
  /** A `user_version = 1` database from before `schema_migrations` existed. */
  readonly legacy: boolean;
}

function unsupported(message: string): HubError {
  return new HubError("STORAGE_VERSION_UNSUPPORTED", message, 500);
}

function tooNew(): HubError {
  return new HubError(
    "SCHEMA_TOO_NEW",
    "The database was written by a newer HarnessHub; upgrade, or restore a backup made by this version",
    500,
  );
}

function tampered(version: unknown): HubError {
  const error = new HubError(
    "MIGRATION_TAMPERED",
    "An applied migration does not match this build",
    500,
  );
  error.cause = { version };
  return error;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * Read and verify the schema state without writing, from one snapshot: in
 * the caller's transaction, or else in a read transaction of its own, so a
 * migration committed by another connection meanwhile cannot mix versions.
 *
 * @throws HubError `SCHEMA_TOO_NEW` when the recorded version is above
 *   `LATEST_SCHEMA_VERSION`; `MIGRATION_TAMPERED` when an applied migration's
 *   name or checksum differs from this build or versions are not contiguous;
 *   `STORAGE_VERSION_UNSUPPORTED` when `user_version` and the applied
 *   migrations disagree or a legacy database lacks its tables.
 */
export function inspectSchema(db: DatabaseSync): SchemaState {
  if (db.isTransaction) return readSchema(db);
  db.exec("BEGIN");
  try {
    return readSchema(db);
  } finally {
    db.exec("COMMIT");
  }
}

function readSchema(db: DatabaseSync): SchemaState {
  const userVersion = db.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof userVersion !== "number")
    throw unsupported("Database user_version is unreadable");
  if (userVersion > LATEST_SCHEMA_VERSION) throw tooNew();
  if (!tableExists(db, "schema_migrations")) {
    if (userVersion === 0) return { version: 0, legacy: false };
    if (userVersion !== 1)
      throw unsupported("Database version has no migration record");
    for (const table of LEGACY_V1_TABLES)
      if (!tableExists(db, table))
        throw unsupported("Version 1 database is missing its tables");
    return { version: 1, legacy: true };
  }
  const rows = db
    .prepare(
      "SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version",
    )
    .all();
  for (const [index, row] of rows.entries()) {
    if (typeof row.version === "number" && row.version > LATEST_SCHEMA_VERSION)
      throw tooNew();
    const migration = MIGRATIONS[index];
    if (
      !migration ||
      row.version !== migration.version ||
      row.name !== migration.name ||
      row.checksum_sha256 !== migrationChecksum(migration)
    )
      throw tampered(row.version);
  }
  if (rows.length !== userVersion)
    throw unsupported("Database user_version disagrees with its migrations");
  return { version: rows.length, legacy: false };
}

function immediate(db: DatabaseSync, operation: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    operation();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Migration and rollback failed",
      );
    }
    throw error;
  }
}

/**
 * Bring the database to `LATEST_SCHEMA_VERSION`. Each migration runs in its
 * own `BEGIN IMMEDIATE` transaction together with its `schema_migrations`
 * row and `user_version`, so a crash leaves the previous version intact.
 * The state is re-read inside each transaction, so connections opening the
 * same file at once apply every step exactly once. A legacy version 1
 * database is adopted by recording migration 1 without running it; its
 * tables and rows are kept as they are. Idempotent.
 *
 * The caller sets journal mode and pragmas first and calls `inspectSchema`
 * before changing anything, so a newer or tampered database is refused
 * unmodified.
 *
 * @param appVersion Build version recorded with each applied step, if known.
 * @throws The `inspectSchema` errors, or the SQLite error of a failed step
 *   (rolled back).
 */
export function migrateSchema(db: DatabaseSync, appVersion?: string): void {
  for (;;) {
    const before = inspectSchema(db);
    if (before.version === LATEST_SCHEMA_VERSION && !before.legacy) return;
    immediate(db, () => {
      const state = inspectSchema(db);
      if (!state.legacy && state.version === LATEST_SCHEMA_VERSION) return;
      if (!tableExists(db, "schema_migrations"))
        db.exec(
          "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum_sha256 TEXT NOT NULL, applied_at TEXT NOT NULL, hh_version TEXT, note TEXT)",
        );
      const migration = state.legacy
        ? MIGRATIONS[0]
        : MIGRATIONS[state.version];
      if (!migration) throw unsupported("No migration follows this version");
      if (!state.legacy) db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum_sha256, applied_at, hh_version, note) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        migration.version,
        migration.name,
        migrationChecksum(migration),
        new Date().toISOString(),
        appVersion ?? null,
        state.legacy ? "adopted from user_version 1" : null,
      );
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
}
