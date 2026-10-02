import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { EngineProfile } from "../../src/domain/types.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

void test("config snapshots preserve session configuration without credentials or raw commands", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harnesshub-snapshot-"));
  const path = join(dir, "state.sqlite");
  const store = new SqliteStore(path);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const profile: EngineProfile = {
    id: "test-acp",
    driver: "acp",
    revision: "profile-v1",
    enabled: true,
    command: ["acp-launcher", "--test-secret=synthetic-sensitive-value"],
    model: "test-model",
    credentialEnv: ["TEST_API_KEY"],
    maxConcurrency: 2,
    capabilities: { resume: false, permissions: true, images: false },
  };
  const session = store.createSession(profile, {
    id: "test-workspace",
    path: dir,
  });
  const snapshot = session.configSnapshot;
  assert.equal(
    snapshot?.commandHash,
    createHash("sha256").update(JSON.stringify(profile.command)).digest("hex"),
  );
  assert.deepEqual(snapshot?.credentialEnv, ["TEST_API_KEY"]);
  assert.equal(snapshot?.model, "test-model");
  profile.model = "changed-model";
  profile.capabilities.images = true;
  profile.credentialEnv?.push("ANOTHER_API_KEY");
  const run = store.acceptRun(session.id, {
    text: "execute",
    timeoutMs: 12345,
  }).run;
  assert.equal(run.configSnapshot?.model, "test-model");
  assert.deepEqual(run.configSnapshot, { ...snapshot, timeoutMs: 12345 });
  assert.equal(store.events(run.id)[0]?.data.configSnapshotRef, run.id);
  assert.equal(store.events(run.id)[0]?.data.configSnapshot, undefined);
  const db = new DatabaseSync(path);
  try {
    const persisted = db
      .prepare(
        "SELECT record FROM sessions UNION ALL SELECT record FROM runs UNION ALL SELECT record FROM events",
      )
      .all()
      .map((row) => String(row.record))
      .join("\n");
    assert.equal(persisted.includes("synthetic-sensitive-value"), false);
    assert.equal(persisted.includes("acp-launcher"), false);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    // Simulate existing v1 records that predate configuration snapshots.
    db.prepare(
      "UPDATE sessions SET record = json_remove(record, '$.configSnapshot') WHERE id = ?",
    ).run(session.id);
    db.prepare(
      "UPDATE runs SET record = json_remove(record, '$.configSnapshot') WHERE id = ?",
    ).run(run.id);
    assert.deepEqual(store.getSession(session.id).configSnapshot, {
      status: "unknown",
    });
    assert.deepEqual(store.getRun(run.id).configSnapshot, {
      status: "unknown",
    });
    assert.deepEqual(store.listSessions()[0]?.configSnapshot, {
      status: "unknown",
    });
    assert.deepEqual(store.listRuns()[0]?.configSnapshot, {
      status: "unknown",
    });
    const next = store.acceptRun(session.id, {
      text: "legacy session",
      timeoutMs: 10000,
    }).run;
    assert.deepEqual(next.configSnapshot, {
      status: "unknown",
      timeoutMs: 10000,
    });
    db.prepare(
      "UPDATE runs SET record = json_set(record, '$.configSnapshot', 'invalid') WHERE id = ?",
    ).run(run.id);
    assert.throws(() => store.getRun(run.id), /schema version 1/);
  } finally {
    db.close();
  }
});
