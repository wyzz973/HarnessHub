import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

void test("backend identity and source event commit atomically and cannot change on subsequent Runs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-backend-id-"));
  const file = path.join(directory, "db.sqlite");
  let store = new SqliteStore(file);
  const fault = new DatabaseSync(file);
  t.after(async () => {
    fault.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = store.createSession(
    {
      id: "acp",
      driver: "acp",
      revision: "v1",
      enabled: true,
      maxConcurrency: 1,
      capabilities: { resume: true, permissions: true, images: false },
    },
    { id: "default", path: directory },
  );
  const run = store.acceptRun(session.id, {
    text: "first",
    timeoutMs: 5000,
  }).run;
  const draft = {
    type: "engine.session",
    data: { backendSessionId: "original", resumed: false },
    sourceSeq: 1,
  };
  fault.exec(
    "CREATE TRIGGER fail_bind_event BEFORE INSERT ON events WHEN NEW.type='engine.session' BEGIN SELECT RAISE(FAIL,'fixture'); END",
  );
  assert.throws(() => store.bindBackendSession(run.id, "original", draft));
  assert.equal(store.getSession(session.id).backendSessionId, undefined);
  fault.exec("DROP TRIGGER fail_bind_event");
  assert.ok(store.bindBackendSession(run.id, "original", draft));
  assert.equal(store.bindBackendSession(run.id, "original", draft), undefined);
  assert.throws(
    () =>
      store.bindBackendSession(run.id, "replacement", {
        ...draft,
        data: { backendSessionId: "replacement" },
        sourceSeq: 2,
      }),
    /cannot be replaced/,
  );
  assert.equal(store.getSession(session.id).backendSessionId, "original");
  store.close();
  store = new SqliteStore(file);
  assert.equal(store.getSession(session.id).backendSessionId, "original");
  assert.equal(
    store.events(run.id).filter((e) => e.type === "engine.session").length,
    1,
  );
});
