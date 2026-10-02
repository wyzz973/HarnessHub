// SPDX-License-Identifier: MIT
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HubError } from "@harnesshub/core/errors";
import type {
  GatewayKeyId,
  GatewayKeyRecord,
  ModelCallEntry,
  ModelPlaneStore,
  ProviderConfig,
  ProviderId,
  RouteGroup,
  RouteGroupId,
  UsageBucket,
  UsageFilter,
  UsageGroupBy,
  WiringRecord,
} from "@harnesshub/core/model-plane";
import { inspectSchema, LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  isGatewayKeyRecord,
  isModelCallEntry,
  isProviderConfig,
  isRouteGroup,
  isTimestamp,
  isWiringRecord,
} from "./model-plane-records.js";
import { decodeRecord } from "./records.js";

/** Largest `listModelCalls` page, the same bound as event reads. */
export const MODEL_CALL_PAGE_LIMIT = 1000;

function invalid(code: string, message: string): HubError {
  return new HubError(code, message, 400);
}

function checked<T>(
  value: T,
  validate: (value: unknown) => value is T,
  name: string,
): string {
  if (!validate(value))
    throw invalid("MODEL_PLANE_RECORD_INVALID", `The ${name} is invalid`);
  return JSON.stringify(value);
}

function time(value: string, name: string, code: string): number {
  if (!isTimestamp(value))
    throw invalid(code, `${name} must be an ISO 8601 date-time with an offset`);
  return Date.parse(value);
}

function integerColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted ledger column is not an integer",
      500,
    );
  return value;
}

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted ledger column is not a number",
      500,
    );
  return value;
}

function textColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string")
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted ledger column is not text",
      500,
    );
  return value;
}

/** Opaque page position: the (occurred_ms, seq) of the last item returned. */
function encodeCursor(occurredMs: number, seq: number): string {
  return Buffer.from(`v1:${occurredMs}:${seq}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { occurredMs: number; seq: number } {
  const match = /^v1:(-?\d{1,16}):(\d{1,16})$/.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  const occurredMs = Number(match?.[1]);
  const seq = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(occurredMs) || !Number.isSafeInteger(seq))
    throw invalid("INVALID_CURSOR", "The page cursor is not valid");
  return { occurredMs, seq };
}

function filterClause(filter: UsageFilter): {
  sql: string;
  params: SQLInputValue[];
} {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.from !== undefined) {
    clauses.push("occurred_ms >= ?");
    params.push(time(filter.from, "from", "INVALID_USAGE_FILTER"));
  }
  if (filter.to !== undefined) {
    clauses.push("occurred_ms < ?");
    params.push(time(filter.to, "to", "INVALID_USAGE_FILTER"));
  }
  const columns: Array<[string | undefined, string]> = [
    [filter.keyId, "key_id"],
    [filter.provider, "provider"],
    [filter.modelRef, "model_ref"],
    [filter.sessionId, "session_id"],
  ];
  for (const [value, column] of columns)
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  return { sql: clauses.join(" AND "), params };
}

/** SQL of the bucket key; calls without the attribute share the empty key. */
function bucketExpression(groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case "day":
      return "strftime('%Y-%m-%d', occurred_ms / 1000, 'unixepoch')";
    case "provider":
      return "COALESCE(provider, '')";
    case "model":
      return "COALESCE(model_ref, '')";
    case "key":
      return "COALESCE(key_id, '')";
    case "adapter":
      return "COALESCE(adapter_id, '')";
  }
}

/**
 * SQLite persistence of the model plane in the Gateway's database file: the
 * same path the daemon gives `SqliteStore` (`<dataDir>/harnesshub.sqlite`),
 * opened on a separate connection like the workflow and benchmark stores.
 *
 * Open it after `SqliteStore` has opened the file (which applies the
 * migrations) and acquired ownership in this process; otherwise construction
 * fails with `SCHEMA_NOT_MIGRATED` (500) or `MODEL_PLANE_OWNER_REQUIRED`
 * (409). The caller owns `close()` and closes this store before releasing the
 * owner. Methods run synchronously on the connection and settle their
 * promise afterwards, so a resolved write is committed (WAL with
 * `synchronous = FULL`). Records are validated before writing
 * (`MODEL_PLANE_RECORD_INVALID`, 400) and when read (`STORAGE_CORRUPT`, 500).
 * After `close()` every method rejects with `STORE_CLOSED` (503).
 *
 * Ledger rules: `listModelCalls` returns newest first by `occurredAt`, then
 * by insertion; `UsageFilter.from` is inclusive and `to` exclusive. In
 * `aggregateUsage` a call counts as failed when its `status` is 400 or above;
 * usage whose source is `missing` (or no usage) adds zero tokens; `costUsd`
 * sums the known costs and `unpricedCalls` counts `cost: null`. Day buckets are
 * UTC dates (`YYYY-MM-DD`); calls without the grouped attribute (no key, no
 * provider, a non-agent scope for `adapter`) form the bucket with key `""`.
 * Buckets are ordered by key.
 */
export class SqliteModelPlaneStore implements ModelPlaneStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;",
      );
      const schema = inspectSchema(this.db);
      if (schema.legacy || schema.version !== LATEST_SCHEMA_VERSION)
        throw new HubError(
          "SCHEMA_NOT_MIGRATED",
          "Open the database with SqliteStore before the model-plane store",
          500,
        );
      // SqliteStore creates runtime_metadata when it first acquires ownership.
      const owner = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_metadata'",
        )
        .get()
        ? this.db
            .prepare(
              "SELECT json_extract(value, '$.pid') AS pid FROM runtime_metadata WHERE key = 'owner'",
            )
            .get()
        : undefined;
      if (owner?.pid !== process.pid)
        throw new HubError(
          "MODEL_PLANE_OWNER_REQUIRED",
          "Model-plane writes require this process to own the Gateway",
          409,
        );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private open(): DatabaseSync {
    if (this.closed)
      throw new HubError(
        "STORE_CLOSED",
        "The model-plane store is closed",
        503,
      );
    return this.db;
  }

  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Model-plane transaction and rollback failed",
        );
      }
      throw error;
    }
  }

  private readOne<T>(
    sql: string,
    id: string,
    validate: (value: unknown) => value is T,
  ): T | undefined {
    const row = this.open().prepare(sql).get(id);
    return row ? decodeRecord(row.record, validate) : undefined;
  }

  private readAll<T>(
    sql: string,
    validate: (value: unknown) => value is T,
  ): T[] {
    return this.open()
      .prepare(sql)
      .all()
      .map((row) => decodeRecord(row.record, validate));
  }

  private remove(sql: string, id: string): boolean {
    return Number(this.open().prepare(sql).run(id).changes) > 0;
  }

  async listProviders(): Promise<ProviderConfig[]> {
    return this.readAll(
      "SELECT record FROM providers ORDER BY id",
      isProviderConfig,
    );
  }

  async getProvider(id: ProviderId): Promise<ProviderConfig | undefined> {
    return this.readOne(
      "SELECT record FROM providers WHERE id = ?",
      id,
      isProviderConfig,
    );
  }

  async putProvider(provider: ProviderConfig): Promise<void> {
    const record = checked(provider, isProviderConfig, "provider");
    this.open()
      .prepare(
        "INSERT INTO providers (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      )
      .run(provider.id, record);
  }

  async deleteProvider(id: ProviderId): Promise<boolean> {
    return this.remove("DELETE FROM providers WHERE id = ?", id);
  }

  async listRouteGroups(): Promise<RouteGroup[]> {
    return this.readAll(
      "SELECT record FROM route_groups ORDER BY id",
      isRouteGroup,
    );
  }

  async getRouteGroup(id: RouteGroupId): Promise<RouteGroup | undefined> {
    return this.readOne(
      "SELECT record FROM route_groups WHERE id = ?",
      id,
      isRouteGroup,
    );
  }

  async putRouteGroup(group: RouteGroup): Promise<void> {
    const record = checked(group, isRouteGroup, "route group");
    this.open()
      .prepare(
        "INSERT INTO route_groups (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      )
      .run(group.id, record);
  }

  async deleteRouteGroup(id: RouteGroupId): Promise<boolean> {
    return this.remove("DELETE FROM route_groups WHERE id = ?", id);
  }

  /** @throws HubError `GATEWAY_KEY_CONFLICT` (409) when the key ID exists. */
  async createGatewayKey(record: GatewayKeyRecord): Promise<void> {
    const json = checked(record, isGatewayKeyRecord, "Gateway Key");
    const inserted = this.open()
      .prepare(
        "INSERT INTO gateway_keys (key_id, record) VALUES (?, ?) ON CONFLICT(key_id) DO NOTHING",
      )
      .run(record.keyId, json);
    if (Number(inserted.changes) === 0)
      throw new HubError(
        "GATEWAY_KEY_CONFLICT",
        "A Gateway Key with this ID exists",
        409,
      );
  }

  async getGatewayKey(
    keyId: GatewayKeyId,
  ): Promise<GatewayKeyRecord | undefined> {
    return this.readOne(
      "SELECT record FROM gateway_keys WHERE key_id = ?",
      keyId,
      isGatewayKeyRecord,
    );
  }

  /** In creation order. */
  async listGatewayKeys(): Promise<GatewayKeyRecord[]> {
    return this.readAll(
      "SELECT record FROM gateway_keys ORDER BY rowid",
      isGatewayKeyRecord,
    );
  }

  private updateKey(
    keyId: GatewayKeyId,
    change: (record: GatewayKeyRecord) => GatewayKeyRecord | undefined,
  ): boolean {
    return this.transaction((db) => {
      const row = db
        .prepare("SELECT record FROM gateway_keys WHERE key_id = ?")
        .get(keyId);
      if (!row) return false;
      const next = change(decodeRecord(row.record, isGatewayKeyRecord));
      if (next)
        db.prepare("UPDATE gateway_keys SET record = ? WHERE key_id = ?").run(
          checked(next, isGatewayKeyRecord, "Gateway Key"),
          keyId,
        );
      return true;
    });
  }

  /**
   * Idempotent: an already revoked key keeps its first `revokedAt`. Returns
   * false only when the key does not exist.
   */
  async revokeGatewayKey(keyId: GatewayKeyId, at: string): Promise<boolean> {
    time(at, "at", "INVALID_TIMESTAMP");
    return this.updateKey(keyId, (record) =>
      record.revokedAt === undefined ? { ...record, revokedAt: at } : undefined,
    );
  }

  /**
   * Moves `lastUsedAt` forward to `at`, never back; a key that does not exist
   * is ignored.
   */
  async touchGatewayKey(keyId: GatewayKeyId, at: string): Promise<void> {
    const atMs = time(at, "at", "INVALID_TIMESTAMP");
    this.updateKey(keyId, (record) =>
      record.lastUsedAt !== undefined && Date.parse(record.lastUsedAt) >= atMs
        ? undefined
        : { ...record, lastUsedAt: at },
    );
  }

  /**
   * Commits one entry. Appending the same `callId` again with an identical
   * entry is a no-op; a different entry under that ID is `MODEL_CALL_CONFLICT`
   * (409). A failed write rejects with `MODEL_CALL_WRITE_FAILED` (503), the
   * SQLite error as its cause, and nothing committed.
   */
  async appendModelCall(entry: ModelCallEntry): Promise<void> {
    const record = checked(entry, isModelCallEntry, "model call");
    const db = this.open();
    const usage =
      entry.usage && entry.usage.source !== "missing" ? entry.usage : undefined;
    let inserted: boolean;
    try {
      inserted =
        Number(
          db
            .prepare(
              "INSERT INTO model_calls (call_id, occurred_ms, key_id, provider, model_ref, session_id, run_id, adapter_id, status, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_usd, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(call_id) DO NOTHING",
            )
            .run(
              entry.callId,
              Date.parse(entry.occurredAt),
              entry.keyId ?? null,
              entry.provider ?? null,
              entry.modelRef ?? null,
              entry.sessionId ?? null,
              entry.runId ?? null,
              entry.scope?.kind === "agent" ? entry.scope.adapterId : null,
              entry.status,
              usage?.input ?? 0,
              usage?.cacheRead ?? 0,
              usage?.cacheWrite ?? 0,
              usage?.output ?? 0,
              usage?.reasoning ?? 0,
              entry.cost?.amountUsd ?? null,
              record,
            ).changes,
        ) > 0;
    } catch (cause) {
      const error = new HubError(
        "MODEL_CALL_WRITE_FAILED",
        "The model call could not be recorded",
        503,
      );
      error.cause = cause;
      throw error;
    }
    if (inserted) return;
    const existing = db
      .prepare("SELECT record FROM model_calls WHERE call_id = ?")
      .get(entry.callId);
    if (existing?.record !== record)
      throw new HubError(
        "MODEL_CALL_CONFLICT",
        "A different model call with this ID is recorded",
        409,
      );
  }

  /**
   * @param page.limit 1 to `MODEL_CALL_PAGE_LIMIT`; otherwise
   *   `INVALID_PAGE_LIMIT` (400).
   * @param page.cursor A `nextCursor` from an earlier page with the same
   *   filter; anything else is `INVALID_CURSOR` (400).
   */
  async listModelCalls(
    filter: UsageFilter,
    page: { limit: number; cursor?: string },
  ): Promise<{ items: ModelCallEntry[]; nextCursor?: string }> {
    if (
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > MODEL_CALL_PAGE_LIMIT
    )
      throw invalid(
        "INVALID_PAGE_LIMIT",
        `Page limit must be an integer from 1 to ${MODEL_CALL_PAGE_LIMIT}`,
      );
    const where = filterClause(filter);
    const clauses = where.sql ? [where.sql] : [];
    const params = [...where.params];
    if (page.cursor !== undefined) {
      const after = decodeCursor(page.cursor);
      clauses.push("(occurred_ms < ? OR (occurred_ms = ? AND seq < ?))");
      params.push(after.occurredMs, after.occurredMs, after.seq);
    }
    const rows = this.open()
      .prepare(
        `SELECT seq, occurred_ms, record FROM model_calls ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY occurred_ms DESC, seq DESC LIMIT ?`,
      )
      .all(...params, page.limit + 1);
    const items = rows
      .slice(0, page.limit)
      .map((row) => decodeRecord(row.record, isModelCallEntry));
    const last = rows[page.limit - 1];
    return rows.length > page.limit && last
      ? {
          items,
          nextCursor: encodeCursor(
            integerColumn(last, "occurred_ms"),
            integerColumn(last, "seq"),
          ),
        }
      : { items };
  }

  async aggregateUsage(
    filter: UsageFilter,
    groupBy: UsageGroupBy,
  ): Promise<UsageBucket[]> {
    const where = filterClause(filter);
    return this.open()
      .prepare(
        `SELECT ${bucketExpression(groupBy)} AS bucket, COUNT(*) AS calls, SUM(status >= 400) AS failed, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning, TOTAL(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced FROM model_calls ${where.sql ? `WHERE ${where.sql}` : ""} GROUP BY bucket ORDER BY bucket`,
      )
      .all(...where.params)
      .map((row) => ({
        key: textColumn(row, "bucket"),
        calls: integerColumn(row, "calls"),
        failedCalls: integerColumn(row, "failed"),
        usage: {
          input: integerColumn(row, "input"),
          cacheRead: integerColumn(row, "cache_read"),
          cacheWrite: integerColumn(row, "cache_write"),
          output: integerColumn(row, "output"),
          reasoning: integerColumn(row, "reasoning"),
        },
        costUsd: numberColumn(row, "cost"),
        unpricedCalls: integerColumn(row, "unpriced"),
      }));
  }

  async listWirings(): Promise<WiringRecord[]> {
    return this.readAll(
      "SELECT record FROM wirings ORDER BY adapter_id",
      isWiringRecord,
    );
  }

  /**
   * Inserts or replaces the wiring of `record.adapterId`.
   *
   * @throws HubError `WIRING_KEY_UNKNOWN` (409) when `record.keyId` is not a
   *   stored Gateway Key.
   */
  async putWiring(record: WiringRecord): Promise<void> {
    const json = checked(record, isWiringRecord, "wiring");
    this.transaction((db) => {
      if (
        !db
          .prepare("SELECT 1 FROM gateway_keys WHERE key_id = ?")
          .get(record.keyId)
      )
        throw new HubError(
          "WIRING_KEY_UNKNOWN",
          "The wiring refers to a Gateway Key that does not exist",
          409,
        );
      db.prepare(
        "INSERT INTO wirings (adapter_id, key_id, record) VALUES (?, ?, ?) ON CONFLICT(adapter_id) DO UPDATE SET key_id = excluded.key_id, record = excluded.record",
      ).run(record.adapterId, record.keyId, json);
    });
  }

  async deleteWiring(adapterId: string): Promise<boolean> {
    return this.remove("DELETE FROM wirings WHERE adapter_id = ?", adapterId);
  }

  /** Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
