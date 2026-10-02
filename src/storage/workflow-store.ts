import { DatabaseSync } from "node:sqlite";
import { HubError } from "../domain/errors.js";
import {
  isWorkflow,
  type Workflow,
  type WorkflowId,
  type WorkflowStore,
} from "../domain/workflows.js";
import type { RunId, SessionId } from "../domain/types.js";
import { decodeRecord } from "./records.js";

/** Versioned workflow tables share the current process's Gateway owner and public Run identities. */
export class SqliteWorkflowStore implements WorkflowStore {
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
          "WORKFLOW_OWNER_REQUIRED",
          "Workflow writes require this process to own the Gateway",
          409,
        );
      this.transaction(() => {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS workflow_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
        );
        const version = this.db
          .prepare(
            "SELECT value FROM workflow_metadata WHERE key = 'schema_version'",
          )
          .get()?.value;
        if (version !== undefined && version !== 1)
          throw new HubError(
            "WORKFLOW_VERSION_UNSUPPORTED",
            "Workflow schema version is not supported",
            500,
          );
        if (version === undefined)
          this.db.exec(`
          CREATE TABLE workflows (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, record TEXT NOT NULL CHECK(json_valid(record)));
          INSERT INTO workflow_metadata (key, value) VALUES ('schema_version', 1);
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
          "Workflow transaction and rollback failed",
        );
      }
      throw error;
    }
  }
  create(workflow: Workflow, key?: string): void {
    this.db
      .prepare(
        "INSERT INTO workflows (id, idempotency_key, record) VALUES (?, ?, ?)",
      )
      .run(workflow.id, key ?? null, JSON.stringify(workflow));
  }
  findByKey(key: string): Workflow | undefined {
    const row = this.db
      .prepare("SELECT record FROM workflows WHERE idempotency_key = ?")
      .get(key);
    return row ? decodeRecord(row.record, isWorkflow) : undefined;
  }
  get(id: WorkflowId): Workflow {
    const row = this.db
      .prepare("SELECT record FROM workflows WHERE id = ?")
      .get(id);
    if (!row)
      throw new HubError("WORKFLOW_NOT_FOUND", "Workflow does not exist", 404);
    return decodeRecord(row.record, isWorkflow);
  }
  list(): Workflow[] {
    return this.db
      .prepare("SELECT record FROM workflows ORDER BY rowid DESC")
      .all()
      .map((row) => decodeRecord(row.record, isWorkflow));
  }
  update(workflow: Workflow): void {
    this.transaction(() => {
      const previous = this.get(workflow.id);
      if (
        previous.goal !== workflow.goal ||
        previous.workspaceId !== workflow.workspaceId ||
        previous.requestedEngineId !== workflow.requestedEngineId ||
        previous.plannerEngineId !== workflow.plannerEngineId ||
        previous.plannerProfileRevision !== workflow.plannerProfileRevision ||
        previous.plannerTimeoutMs !== workflow.plannerTimeoutMs ||
        previous.createdAt !== workflow.createdAt ||
        (previous.approvedAt !== undefined &&
          previous.approvedAt !== workflow.approvedAt) ||
        (previous.steps.length > 0 &&
          previous.steps.length !== workflow.steps.length) ||
        (previous.planningSessionId !== undefined &&
          previous.planningSessionId !== workflow.planningSessionId) ||
        (previous.planningRunId !== undefined &&
          previous.planningRunId !== workflow.planningRunId)
      )
        throw new HubError(
          "WORKFLOW_OWNERSHIP_CONFLICT",
          "Workflow request and execution identities cannot change",
          409,
        );
      for (const step of previous.steps) {
        const updated = workflow.steps.find(
          (candidate) => candidate.id === step.id,
        );
        if (
          !updated ||
          step.selection.engineId !== updated.selection.engineId ||
          step.selection.profileRevision !==
            updated.selection.profileRevision ||
          step.instructions !== updated.instructions ||
          step.title !== updated.title ||
          step.timeoutMs !== updated.timeoutMs ||
          JSON.stringify(step.requiredCapabilities) !==
            JSON.stringify(updated.requiredCapabilities) ||
          JSON.stringify(step.selection) !==
            JSON.stringify(updated.selection) ||
          JSON.stringify(step.dependsOn) !==
            JSON.stringify(updated.dependsOn) ||
          JSON.stringify(step.outputs) !== JSON.stringify(updated.outputs) ||
          (step.sessionId !== undefined &&
            step.sessionId !== updated.sessionId) ||
          (step.runId !== undefined && step.runId !== updated.runId)
        )
          throw new HubError(
            "WORKFLOW_OWNERSHIP_CONFLICT",
            "Approved plan and step execution identities cannot change",
            409,
          );
      }
      const identities = [
        {
          sessionId: workflow.planningSessionId,
          runId: workflow.planningRunId,
          key: `${workflow.id}:planning`,
          engineId: workflow.plannerEngineId,
          profileRevision: workflow.plannerProfileRevision,
        },
        ...workflow.steps.map((step) => ({
          sessionId: step.sessionId,
          runId: step.runId,
          key: `${workflow.id}:${step.id}`,
          engineId: step.selection.engineId,
          profileRevision: step.selection.profileRevision,
        })),
      ];
      for (const identity of identities) {
        if (identity.sessionId) {
          const session = this.db
            .prepare(
              "SELECT json_extract(record, '$.engineId') AS engine_id, json_extract(record, '$.profileRevision') AS revision, json_extract(record, '$.workspaceId') AS workspace_id FROM sessions WHERE id = ?",
            )
            .get(identity.sessionId);
          if (
            !session ||
            session.engine_id !== identity.engineId ||
            session.revision !== identity.profileRevision ||
            session.workspace_id !== workflow.workspaceId
          )
            throw new HubError(
              "WORKFLOW_OWNERSHIP_CONFLICT",
              "Session does not match the selected engine revision and workspace",
              409,
            );
        }
        if (!identity.runId) continue;
        const run = this.db
          .prepare("SELECT session_id, idempotency_key FROM runs WHERE id = ?")
          .get(identity.runId);
        if (
          !run ||
          run.session_id !== identity.sessionId ||
          run.idempotency_key !== identity.key
        )
          throw new HubError(
            "WORKFLOW_OWNERSHIP_CONFLICT",
            "Run does not belong to the workflow step",
            409,
          );
      }
      this.db
        .prepare("UPDATE workflows SET record = ? WHERE id = ?")
        .run(JSON.stringify(workflow), workflow.id);
    });
  }
  submittedRun(sessionId: SessionId, key: string): RunId | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM runs WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, key);
    if (!row) return undefined;
    if (typeof row.id !== "string")
      throw new HubError(
        "STORAGE_CORRUPT",
        "Workflow Run identity is malformed",
        500,
      );
    return row.id as RunId;
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
