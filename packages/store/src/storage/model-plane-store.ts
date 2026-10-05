// SPDX-License-Identifier: MIT
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { HubError } from "@harnesshub/core/errors";
import type { LogSink } from "@harnesshub/core/logging";
import { WalCheckpoints } from "./wal-checkpoints.js";
import { AUTO_GROUP_PREFIX } from "@harnesshub/core/auto-groups";
import {
  parseModelRef,
  type AgentWiringStore,
  type ConversationSummary,
  type GatewayKeyId,
  type GatewayKeyQuota,
  type GatewayKeyRecord,
  type ModelCallEntry,
  type ModelPlaneStore,
  type ProviderConfig,
  type ProviderId,
  type RouteGroup,
  type RouteGroupId,
  type UsageBucket,
  type UsageFilter,
  type UsageGroupBy,
  type WiringProfile,
  type WiringRecord,
} from "@harnesshub/core/model-plane";
import {
  isModelOverride,
  isModelProvenance,
  type ModelMetadataStore,
  type ModelOverride,
  type ModelProvenance,
  type OverrideChange,
} from "@harnesshub/core/model-metadata";
import { inspectSchema, LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  isGatewayKeyRecord,
  isModelCallEntry,
  isProviderConfig,
  isRouteGroup,
  isModelPatternList,
  isTimestamp,
  isWiringProfile,
  isWiringRecord,
} from "@harnesshub/core/model-plane-records";
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

/** The distinct values of a `json_group_array(DISTINCT …)` column, without nulls, sorted. */
function distinctColumn(row: Record<string, unknown>, name: string): string[] {
  let values: unknown;
  try {
    values = JSON.parse(textColumn(row, name));
  } catch {
    values = undefined;
  }
  if (
    !Array.isArray(values) ||
    !values.every((value) => value === null || typeof value === "string")
  )
    throw new HubError(
      "STORAGE_CORRUPT",
      "Persisted ledger column is not a list of text",
      500,
    );
  return (values as (string | null)[])
    .filter((value): value is string => value !== null)
    .sort();
}

/** The provider ID of a validated `provider/model` ref. */
function providerOf(ref: string): string {
  return ref.slice(0, ref.indexOf("/"));
}

/** Opaque page position: the (occurred_ms, seq) of the last item returned. */
function encodeCursor(occurredMs: number, seq: number): string {
  return Buffer.from(`v1:${occurredMs}:${seq}`, "utf8").toString("base64url");
}

/** Opaque conversation page position: the last call time and key of the last summary. */
function encodeConversationCursor(lastMs: number, key: string): string {
  return Buffer.from(`c1:${lastMs}:${key}`, "utf8").toString("base64url");
}

function decodeConversationCursor(cursor: string): {
  lastMs: number;
  key: string;
} {
  const match = /^c1:(-?\d{1,16}):([0-9a-f]{64})$/.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  const lastMs = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(lastMs))
    throw invalid("INVALID_CURSOR", "The page cursor is not valid");
  return { lastMs, key: match[2]! };
}

function pageLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MODEL_CALL_PAGE_LIMIT
  )
    throw invalid(
      "INVALID_PAGE_LIMIT",
      `Page limit must be an integer from 1 to ${MODEL_CALL_PAGE_LIMIT}`,
    );
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
    [filter.agent, "agent"],
    [filter.conversationKey, "conversation_key"],
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
    case "credential":
      return "CASE WHEN provider IS NULL OR credential_id IS NULL THEN '' ELSE provider || '/' || credential_id END";
  }
}

/**
 * SQLite persistence of the model plane (with model overrides and metadata
 * provenance) in the Gateway's database file: the
 * same path the daemon gives `SqliteStore` (`<dataDir>/harnesshub.sqlite`),
 * opened on a separate connection like the workflow and benchmark stores.
 *
 * Open it after `SqliteStore` has opened the file (which applies the
 * migrations) and acquired ownership in this process; otherwise construction
 * fails with `SCHEMA_NOT_MIGRATED` (500) or `MODEL_PLANE_OWNER_REQUIRED`
 * (409). The caller owns `close()` and closes this store before releasing the
 * owner. Methods run synchronously on the connection and settle their
 * promise afterwards; ledger appends wait for their group commit
 * (`appendModelCall`). Either way a resolved write is committed (WAL with
 * `synchronous = FULL`). Commits do not checkpoint the WAL: a worker thread
 * does, shortly after writes (`WalCheckpoints`); the owner awaits
 * `whenClosed()` after `close()`. Records are validated before writing
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
 * Buckets are ordered by key. Credential buckets are `<provider>/<credentialId>`,
 * since credential IDs are unique only within their provider.
 *
 * `listConversations` sums the entries that have a `conversationKey` and
 * match the filter, one summary per key, by the same rules as
 * `aggregateUsage`; summaries come newest `lastAt` first (then by key), with
 * the same page limits and an opaque cursor as `listModelCalls`. `firstAt`
 * and `lastAt` are UTC; models, credentials and agents list the distinct
 * values the calls recorded, sorted, without calls that recorded none. The
 * filter's `agent` matches `agent.id`, established or inferred.
 *
 * Hidden automatic groups (`listHiddenAutoGroups`, `setAutoGroupHidden`)
 * are IDs starting with `auto-` that are valid route group IDs; any other ID
 * is `AUTO_GROUP_ID_INVALID` (400).
 */
export class SqliteModelPlaneStore
  implements ModelPlaneStore, ModelMetadataStore, AgentWiringStore
{
  private readonly db: DatabaseSync;
  private closed = false;
  /** Checkpoints of this connection's writes, off its commits. */
  private readonly checkpoints: WalCheckpoints;

  /**
   * @param options.log Where a failed WAL checkpoint is logged
   *   (`store.checkpoint_failed`).
   * @param options.checkpointIntervalMs For tests: how often writes are
   *   looked at for a checkpoint (`CHECKPOINT_INTERVAL_MS` by default).
   */
  constructor(
    dbPath: string,
    options: { log?: LogSink; checkpointIntervalMs?: number } = {},
  ) {
    this.db = new DatabaseSync(dbPath);
    try {
      // Commits never checkpoint: WalCheckpoints does, on another thread.
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0;",
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
    const changes = this.db.prepare("SELECT total_changes() AS changes");
    this.checkpoints = new WalCheckpoints(
      dbPath,
      () => Number(changes.get()!.changes),
      options.log,
      options.checkpointIntervalMs,
    );
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

  /** Also deletes the provider's model overrides and provenance. */
  async deleteProvider(id: ProviderId): Promise<boolean> {
    return this.remove("DELETE FROM providers WHERE id = ?", id);
  }

  async getModelOverride(ref: string): Promise<ModelOverride | undefined> {
    return this.readOne(
      "SELECT record FROM model_overrides WHERE ref = ?",
      ref,
      isModelOverride,
    );
  }

  async listModelOverrides(providerId: string): Promise<ModelOverride[]> {
    return this.open()
      .prepare(
        "SELECT record FROM model_overrides WHERE provider = ? ORDER BY ref",
      )
      .all(providerId)
      .map((row) => decodeRecord(row.record, isModelOverride));
  }

  async listModelProvenance(providerId: string): Promise<ModelProvenance[]> {
    return this.open()
      .prepare(
        "SELECT record FROM model_provenance WHERE provider = ? ORDER BY ref",
      )
      .all(providerId)
      .map((row) => decodeRecord(row.record, isModelProvenance));
  }

  async putProviderMetadata(
    provider: ProviderConfig,
    provenance: ModelProvenance[],
    override?: OverrideChange,
  ): Promise<void> {
    const record = checked(provider, isProviderConfig, "provider");
    const own = (ref: string, name: string) => {
      if (providerOf(ref) !== provider.id)
        throw invalid(
          "MODEL_PLANE_RECORD_INVALID",
          `The ${name} names another provider`,
        );
    };
    const rows = provenance.map((item) => {
      const json = checked(item, isModelProvenance, "model provenance");
      own(item.ref, "model provenance");
      return [item.ref, json] as const;
    });
    if (new Set(rows.map(([ref]) => ref)).size !== rows.length)
      throw invalid(
        "MODEL_PLANE_RECORD_INVALID",
        "The model provenance names a model twice",
      );
    let change: (db: DatabaseSync) => void = () => undefined;
    if (override && "put" in override) {
      const json = checked(override.put, isModelOverride, "model override");
      own(override.put.ref, "model override");
      change = (db) =>
        db
          .prepare(
            "INSERT INTO model_overrides (ref, provider, record) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET record = excluded.record",
          )
          .run(override.put.ref, provider.id, json);
    } else if (override) {
      own(override.delete, "model override");
      change = (db) =>
        db
          .prepare("DELETE FROM model_overrides WHERE ref = ?")
          .run(override.delete);
    }
    this.transaction((db) => {
      db.prepare(
        "INSERT INTO providers (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
      ).run(provider.id, record);
      db.prepare("DELETE FROM model_provenance WHERE provider = ?").run(
        provider.id,
      );
      const insert = db.prepare(
        "INSERT INTO model_provenance (ref, provider, record) VALUES (?, ?, ?)",
      );
      for (const [ref, json] of rows) insert.run(ref, provider.id, json);
      change(db);
    });
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

  /** @throws HubError `MODEL_PLANE_RECORD_INVALID` (400) when an entry is not a Model Ref, `provider/*`, `group/<id>` or `*`. */
  async setGatewayKeyModels(
    keyId: GatewayKeyId,
    modelAllow: string[],
    modelDeny: string[],
  ): Promise<boolean> {
    if (!isModelPatternList(modelAllow) || !isModelPatternList(modelDeny))
      throw invalid(
        "MODEL_PLANE_RECORD_INVALID",
        "The model lists of the Gateway Key are invalid",
      );
    return this.updateKey(keyId, (record) => {
      const next: GatewayKeyRecord = { ...record, modelAllow: [...modelAllow] };
      if (modelDeny.length) next.modelDeny = [...modelDeny];
      else delete next.modelDeny;
      return next;
    });
  }

  /**
   * Replaces the key's quota (`undefined` removes it); validated with the
   * whole record (`MODEL_PLANE_RECORD_INVALID`, 400).
   */
  async setGatewayKeyQuota(
    keyId: GatewayKeyId,
    quota: GatewayKeyQuota | undefined,
  ): Promise<boolean> {
    return this.updateKey(keyId, (record) => {
      const next: GatewayKeyRecord = { ...record };
      if (quota) next.quota = quota;
      else delete next.quota;
      return next;
    });
  }

  /**
   * Idempotent: an already revoked key keeps its first `revokedAt`. Returns
   * false only when the key does not exist. `at` must be an ISO 8601
   * date-time with an offset (`INVALID_TIMESTAMP`, 400).
   */
  async revokeGatewayKey(keyId: GatewayKeyId, at: string): Promise<boolean> {
    time(at, "at", "INVALID_TIMESTAMP");
    return this.updateKey(keyId, (record) =>
      record.revokedAt === undefined ? { ...record, revokedAt: at } : undefined,
    );
  }

  /**
   * Moves `lastUsedAt` forward to `at`, never back; a key that does not exist
   * is ignored. `at` is checked as for `revokeGatewayKey`.
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
   *
   * Group commit: entries appended before the store next gets the event
   * loop's check phase (a burst, or calls that end in the same I/O poll)
   * are written in one transaction, in the order they were appended, and
   * each promise settles after that transaction is durable (WAL with
   * `synchronous = FULL`). When the group's transaction fails, it is rolled
   * back and each entry is written on its own, so only the entries that fail
   * alone reject. An invalid entry rejects before it joins a group.
   */
  async appendModelCall(entry: ModelCallEntry): Promise<void> {
    const record = checked(entry, isModelCallEntry, "model call");
    this.open();
    return new Promise<void>((resolve, reject) => {
      this.pendingCalls.push({ entry, record, resolve, reject });
      this.groupCommit ??= setImmediate(() => this.commitGroup());
    });
  }

  /** Entries waiting for the next group commit, in the order they were appended. */
  private pendingCalls: PendingCall[] = [];
  private groupCommit: NodeJS.Immediate | undefined;
  private insertCall: StatementSync | undefined;

  /** Writes the pending entries in one transaction and settles their promises. */
  private commitGroup(): void {
    clearImmediate(this.groupCommit);
    this.groupCommit = undefined;
    const group = this.pendingCalls.splice(0);
    if (!group.length) return;
    if (group.length === 1) {
      settle(group[0]!, this.writeCall(group[0]!));
      return;
    }
    const db = this.db;
    let outcomes: (HubError | undefined)[];
    try {
      db.exec("BEGIN IMMEDIATE");
      outcomes = group.map((call) => this.insertOrConflict(call));
      db.exec("COMMIT");
    } catch {
      if (db.isTransaction) db.exec("ROLLBACK");
      // Each entry alone, so that one bad entry fails only itself.
      for (const call of group) settle(call, this.writeCall(call));
      return;
    }
    group.forEach((call, index) => settle(call, outcomes[index]));
  }

  /** One entry in its own transaction: its conflict or write failure, if any. */
  private writeCall(call: PendingCall): HubError | undefined {
    try {
      return this.insertOrConflict(call);
    } catch (cause) {
      const error = new HubError(
        "MODEL_CALL_WRITE_FAILED",
        "The model call could not be recorded",
        503,
      );
      error.cause = cause;
      return error;
    }
  }

  /**
   * Inserts an entry; an existing row with its ID is a no-op when it is the
   * same entry, otherwise the conflict is returned. Throws the SQLite error.
   */
  private insertOrConflict({
    entry,
    record,
  }: PendingCall): HubError | undefined {
    const usage =
      entry.usage && entry.usage.source !== "missing" ? entry.usage : undefined;
    this.insertCall ??= this.db.prepare(
      "INSERT INTO model_calls (call_id, occurred_ms, key_id, provider, model_ref, session_id, run_id, adapter_id, credential_id, conversation_key, agent, status, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_usd, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(call_id) DO NOTHING",
    );
    const inserted =
      Number(
        this.insertCall.run(
          entry.callId,
          Date.parse(entry.occurredAt),
          entry.keyId ?? null,
          entry.provider ?? null,
          entry.modelRef ?? null,
          entry.sessionId ?? null,
          entry.runId ?? null,
          entry.scope?.kind === "agent" ? entry.scope.adapterId : null,
          entry.credentialId ?? null,
          entry.conversationKey ?? null,
          entry.agent?.id ?? null,
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
    if (inserted) return undefined;
    const existing = this.db
      .prepare("SELECT record FROM model_calls WHERE call_id = ?")
      .get(entry.callId);
    return existing?.record === record
      ? undefined
      : new HubError(
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
    pageLimit(page.limit);
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

  /**
   * @param page.limit 1 to `MODEL_CALL_PAGE_LIMIT`; otherwise
   *   `INVALID_PAGE_LIMIT` (400).
   * @param page.cursor A `nextCursor` from an earlier page with the same
   *   filter; anything else is `INVALID_CURSOR` (400).
   */
  async listConversations(
    filter: UsageFilter,
    page: { limit: number; cursor?: string },
  ): Promise<{ items: ConversationSummary[]; nextCursor?: string }> {
    pageLimit(page.limit);
    const where = filterClause(filter);
    const params = [...where.params];
    let having = "";
    if (page.cursor !== undefined) {
      const after = decodeConversationCursor(page.cursor);
      having =
        "HAVING MAX(occurred_ms) < ? OR (MAX(occurred_ms) = ? AND conversation_key < ?)";
      params.push(after.lastMs, after.lastMs, after.key);
    }
    const rows = this.open()
      .prepare(
        `SELECT conversation_key AS key, COUNT(*) AS calls, SUM(status >= 400) AS failed, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write, SUM(output_tokens) AS output, SUM(reasoning_tokens) AS reasoning, TOTAL(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced, MIN(occurred_ms) AS first_ms, MAX(occurred_ms) AS last_ms, json_group_array(DISTINCT model_ref) AS models, json_group_array(DISTINCT CASE WHEN provider IS NULL OR credential_id IS NULL THEN NULL ELSE provider || '/' || credential_id END) AS credentials, json_group_array(DISTINCT agent) AS agents FROM model_calls WHERE conversation_key IS NOT NULL${where.sql ? ` AND ${where.sql}` : ""} GROUP BY conversation_key ${having} ORDER BY last_ms DESC, key DESC LIMIT ?`,
      )
      .all(...params, page.limit + 1);
    const items = rows.slice(0, page.limit).map((row) => ({
      key: textColumn(row, "key"),
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
      firstAt: new Date(integerColumn(row, "first_ms")).toISOString(),
      lastAt: new Date(integerColumn(row, "last_ms")).toISOString(),
      models: distinctColumn(row, "models"),
      credentials: distinctColumn(row, "credentials"),
      agents: distinctColumn(row, "agents"),
    }));
    const last = rows[page.limit - 1];
    return rows.length > page.limit && last
      ? {
          items,
          nextCursor: encodeConversationCursor(
            integerColumn(last, "last_ms"),
            textColumn(last, "key"),
          ),
        }
      : { items };
  }

  async listHiddenAutoGroups(): Promise<RouteGroupId[]> {
    return this.open()
      .prepare("SELECT id FROM hidden_auto_groups ORDER BY id")
      .all()
      .map((row) => textColumn(row, "id") as RouteGroupId);
  }

  async setAutoGroupHidden(
    id: RouteGroupId,
    hidden: boolean,
  ): Promise<boolean> {
    if (
      !id.startsWith(AUTO_GROUP_PREFIX) ||
      id.length === AUTO_GROUP_PREFIX.length ||
      parseModelRef(`group/${id}`)?.kind !== "group"
    )
      throw invalid(
        "AUTO_GROUP_ID_INVALID",
        "Not the ID of an automatic route group",
      );
    const db = this.open();
    const result = hidden
      ? db
          .prepare(
            "INSERT INTO hidden_auto_groups (id, hidden_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
          )
          .run(id, new Date().toISOString())
      : db.prepare("DELETE FROM hidden_auto_groups WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async listWirings(): Promise<WiringRecord[]> {
    return this.readAll(
      "SELECT record FROM wirings ORDER BY adapter_id",
      isWiringRecord,
    );
  }

  /**
   * Inserts or replaces the wiring of `record.adapterId`. A record without
   * `keyId` (an agent that signs in by itself) refers to no key.
   *
   * @throws HubError `WIRING_KEY_UNKNOWN` (409) when `record.keyId` is not a
   *   stored Gateway Key.
   */
  async putWiring(record: WiringRecord): Promise<void> {
    const json = checked(record, isWiringRecord, "wiring");
    this.transaction((db) => {
      if (
        record.keyId !== undefined &&
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
      ).run(record.adapterId, record.keyId ?? null, json);
    });
  }

  async deleteWiring(adapterId: string): Promise<boolean> {
    return this.remove("DELETE FROM wirings WHERE adapter_id = ?", adapterId);
  }

  async listWiringProfiles(): Promise<WiringProfile[]> {
    return this.readAll(
      "SELECT record FROM wiring_profiles ORDER BY name",
      isWiringProfile,
    );
  }

  async getWiringProfile(name: string): Promise<WiringProfile | undefined> {
    return this.readOne(
      "SELECT record FROM wiring_profiles WHERE name = ?",
      name,
      isWiringProfile,
    );
  }

  async putWiringProfile(profile: WiringProfile): Promise<void> {
    const json = checked(profile, isWiringProfile, "wiring profile");
    this.open()
      .prepare(
        "INSERT INTO wiring_profiles (name, record) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET record = excluded.record",
      )
      .run(profile.name, json);
  }

  async deleteWiringProfile(name: string): Promise<boolean> {
    return this.remove("DELETE FROM wiring_profiles WHERE name = ?", name);
  }

  /**
   * Commits the pending ledger entries, then closes the connection and the
   * checkpoint worker's ({@link whenClosed}). Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.commitGroup();
    this.closed = true;
    void this.checkpoints.close();
    this.db.close();
  }

  /**
   * Resolves once, after {@link close}, the checkpoint worker exited (after
   * a checkpoint in flight); the owner awaits it before the process ends
   * or the file is removed.
   */
  whenClosed(): Promise<void> {
    return this.checkpoints.close();
  }
}

/** A ledger entry waiting for its group commit. */
interface PendingCall {
  entry: ModelCallEntry;
  record: string;
  resolve(): void;
  reject(error: HubError): void;
}

function settle(call: PendingCall, error: HubError | undefined): void {
  if (error) call.reject(error);
  else call.resolve();
}
