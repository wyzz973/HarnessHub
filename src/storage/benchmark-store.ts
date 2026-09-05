import { DatabaseSync } from "node:sqlite";
import { HubError } from "../domain/errors.js";
import {
  isBenchmarkAttempt,
  isBenchmarkEvaluation,
  type AttemptId,
  type BenchmarkAttempt,
  type BenchmarkEvaluation,
  type BenchmarkStore,
} from "../domain/benchmark.js";
import { decodeRecord } from "./records.js";
import type { RunId } from "../domain/types.js";

/** Opens extra versioned tables in the active Gateway's database; close before releasing its owner. */
export class SqliteBenchmarkStore implements BenchmarkStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;",
      );
      const owner = this.db
        .prepare(
          "SELECT json_extract(value, '$.pid') AS pid FROM runtime_metadata WHERE key = 'owner'",
        )
        .get();
      if (owner?.pid !== process.pid)
        throw new HubError(
          "BENCHMARK_OWNER_REQUIRED",
          "Benchmark writes require this process to own the Gateway",
          409,
        );
      this.transaction(() => {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS benchmark_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
        );
        const version = this.db
          .prepare(
            "SELECT value FROM benchmark_metadata WHERE key = 'schema_version'",
          )
          .get()?.value;
        if (version !== undefined && version !== 1)
          throw new HubError(
            "BENCHMARK_VERSION_UNSUPPORTED",
            "Benchmark schema version is not supported",
            500,
          );
        if (version === undefined)
          this.db.exec(`
          CREATE TABLE benchmark_attempts (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), run_id TEXT UNIQUE REFERENCES runs(id), record TEXT NOT NULL CHECK(json_valid(record)));
          CREATE TABLE evaluations (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES benchmark_attempts(id), record TEXT NOT NULL CHECK(json_valid(record)));
          CREATE INDEX evaluations_attempt ON evaluations(attempt_id);
          INSERT INTO benchmark_metadata (key, value) VALUES ('schema_version', 1);
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Benchmark transaction and rollback failed",
        );
      }
      throw error;
    }
  }
  create(attempt: BenchmarkAttempt): void {
    this.db
      .prepare("INSERT INTO benchmark_attempts (id, record) VALUES (?, ?)")
      .run(attempt.id, JSON.stringify(attempt));
  }
  update(attempt: BenchmarkAttempt): void {
    this.transaction(() => {
      const previous = this.get(attempt.id);
      if (
        (previous.runId !== undefined && previous.runId !== attempt.runId) ||
        (previous.sessionId !== undefined &&
          previous.sessionId !== attempt.sessionId) ||
        previous.engineId !== attempt.engineId ||
        previous.workspace.id !== attempt.workspace.id ||
        JSON.stringify(previous.task) !== JSON.stringify(attempt.task)
      )
        throw new HubError(
          "BENCHMARK_OWNERSHIP_CONFLICT",
          "Attempt execution identity cannot change",
          409,
        );
      if (attempt.runId) {
        const run = this.db
          .prepare("SELECT session_id FROM runs WHERE id = ?")
          .get(attempt.runId);
        if (run?.session_id !== attempt.sessionId)
          throw new HubError(
            "BENCHMARK_OWNERSHIP_CONFLICT",
            "Run does not belong to this attempt session",
            409,
          );
      }
      this.db
        .prepare(
          "UPDATE benchmark_attempts SET session_id = ?, run_id = ?, record = ? WHERE id = ?",
        )
        .run(
          attempt.sessionId ?? null,
          attempt.runId ?? null,
          JSON.stringify(attempt),
          attempt.id,
        );
    });
  }
  get(id: AttemptId): BenchmarkAttempt {
    const row = this.db
      .prepare("SELECT record FROM benchmark_attempts WHERE id = ?")
      .get(id);
    if (!row)
      throw new HubError(
        "BENCHMARK_ATTEMPT_NOT_FOUND",
        "Benchmark attempt does not exist",
        404,
      );
    return decodeRecord(row.record, isBenchmarkAttempt);
  }
  submittedRun(id: AttemptId): RunId | undefined {
    const attempt = this.get(id);
    if (!attempt.sessionId) return undefined;
    const row = this.db
      .prepare(
        "SELECT id FROM runs WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(attempt.sessionId, id);
    if (row === undefined) return undefined;
    if (typeof row.id !== "string")
      throw new HubError(
        "STORAGE_CORRUPT",
        "Attempt Run identity is malformed",
        500,
      );
    return row.id as RunId;
  }
  list(): BenchmarkAttempt[] {
    return this.db
      .prepare("SELECT record FROM benchmark_attempts ORDER BY rowid")
      .all()
      .map((row) => decodeRecord(row.record, isBenchmarkAttempt));
  }
  saveEvaluation(evaluation: BenchmarkEvaluation): void {
    this.transaction(() => {
      const attempt = this.get(evaluation.attemptId);
      if (evaluation.runId !== attempt.runId)
        throw new HubError(
          "BENCHMARK_OWNERSHIP_CONFLICT",
          "Evaluation Run must match its attempt",
          409,
        );
      this.db
        .prepare(
          "INSERT INTO evaluations (id, attempt_id, record) VALUES (?, ?, ?)",
        )
        .run(evaluation.id, evaluation.attemptId, JSON.stringify(evaluation));
    });
  }
  evaluations(id: AttemptId): BenchmarkEvaluation[] {
    this.get(id);
    return this.db
      .prepare(
        "SELECT record FROM evaluations WHERE attempt_id = ? ORDER BY rowid",
      )
      .all(id)
      .map((row) => decodeRecord(row.record, isBenchmarkEvaluation));
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
