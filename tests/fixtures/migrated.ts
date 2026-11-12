import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import { migrateToV14 } from "../../src/infrastructure/session/migrate-v14.js";
import { loadV13Fixture, writeV13Root, type V13Fixture, type V13FixtureName } from "./storage/v13/database.js";

/** A frozen v13 database migrated to v14 in a temporary directory, which is removed (the connection closed first) after the test. */
export interface Migrated { readonly db: DatabaseSync; readonly root: string; readonly fixture: V13Fixture }

/**
 * Writes `source` (a fixture by name, or one made in memory) as a v13 data root, migrates it with the whole-conversation checker (`verify`) holding every
 * conversation to its rules, and returns the open v14 database. Nothing real is opened: the root is a copy of frozen data in a temporary directory.
 */
export function migrated(t: TestContext, source: V13FixtureName | V13Fixture): Migrated {
  const fixture = typeof source === "string" ? loadV13Fixture(source) : source;
  const directory = mkdtempSync(join(tmpdir(), "v14-read-")), root = join(directory, "data");
  const state: { db?: DatabaseSync } = {};
  t.after(() => { try { if (state.db?.isOpen) state.db.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  writeV13Root(root, [fixture]);
  const db = new DatabaseSync(join(root, "gateway.sqlite"));
  state.db = db;
  const report = migrateToV14(db, { root, verify });
  if (report.stopped !== null) throw new Error("fixture " + fixture.fixture + " did not migrate: " + report.stopped.reason);
  return { db, root, fixture };
}
