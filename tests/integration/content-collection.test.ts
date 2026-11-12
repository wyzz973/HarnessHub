import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { collectContent } from "../../src/cli/session-application.js";
import { SessionError } from "../../src/contracts/session.js";
import { CONTENT_RETENTION_MS, LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { appStore } from "../fixtures/runtime-store.js";
import { loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { rawDatabase, temporary } from "../fixtures/store-helpers.js";

// The content collector is the one deletion a backup of the database cannot bring back (the content store is not in it), so the application runs it behind the gate of the
// upgrade (ADR-057 3.6, review M2): a root that was never upgraded collects as it always did, the first start after an upgrade only reports what it would collect, and while
// the content the converted conversations refer to differs from what the old code referred to, nothing is collected. The store is the real one on a real data root and so is
// the content store; only the clock of the content store is the test's, so that stored content is old enough to be collected.

const missing = (error: unknown): boolean => error instanceof SessionError && error.code === "CONTENT_NOT_FOUND";
async function aged(data: string, owner: () => void): Promise<{ readonly content: LocalContentStore; readonly orphan: string }> {
  let now = Date.parse("2026-10-11T00:00:00Z");
  const stored = new LocalContentStore(data, owner, () => now);
  const orphan = await stored.storeOutput({ workspace: "/w", name: "orphan.txt", mediaType: "text/plain", data: Buffer.from("nothing refers to this") });
  now += CONTENT_RETENTION_MS + 1;
  const content = new LocalContentStore(data, owner, () => now);
  return { content, orphan: orphan.id };
}

test("a root that was never upgraded collects what is old and unreferenced, as it always did", async t => {
  const data = join(temporary(t), "data"), store = appStore(data);
  try {
    const { content, orphan } = await aged(data, () => store.assertOwner()), lines: string[] = [];
    assert.deepEqual(store.collectionGate(), { allowed: true, reportOnly: false, reason: null });
    collectContent(store, content, line => lines.push(line));
    assert.deepEqual(lines, [], "nothing to report: it simply collects");
    assert.throws(() => content.read(orphan), missing, "the old, unreferenced content is gone");
  } finally { store.close(); }
});

test("the first start after an upgrade only reports what it would collect and deletes nothing; the next start collects", async t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("tools")]);
  let store = appStore(data);
  try {
    const { content, orphan } = await aged(data, () => store.assertOwner()), lines: string[] = [];
    const gate = store.collectionGate();
    assert.equal(gate.allowed, false); assert.equal(gate.reportOnly, true);
    // What it would collect is counted, and is what the collection then collects.
    assert.deepEqual(content.wouldCollect(store.contentReferences()), { records: 1, blobs: 1, files: 0, partial: 0 });
    collectContent(store, content, line => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /CONTENT_COLLECTION \(the first start after the upgrade only reports: 1 stored items, 1 blobs, 0 files and 0 partial uploads would be collected; nothing was deleted\)/u);
    assert.equal(content.read(orphan).ref.id, orphan, "nothing was deleted");
    assert.deepEqual(store.collectionGate(), { allowed: true, reportOnly: false, reason: null }, "the report is acknowledged: the bookkeeping of the upgrade is gone");
    // It survives the restart: the next start collects.
    store.close();
    store = appStore(data);
    const next = new LocalContentStore(data, () => store.assertOwner(), () => Date.parse("2026-10-11T00:00:00Z") + CONTENT_RETENTION_MS + 1);
    lines.length = 0;
    collectContent(store, next, line => lines.push(line));
    assert.deepEqual(lines, []);
    assert.throws(() => next.read(orphan), missing, "now it is collected");
  } finally { try { store.close(); } catch { /* closed above and not opened again */ } }
});

test("while the references of the upgrade differ from what the old code kept, nothing is collected, nothing is acknowledged, and the reason is told", async t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("tools")]);
  const store = appStore(data);
  try {
    const { content, orphan } = await aged(data, () => store.assertOwner()), lines: string[] = [];
    // The comparison found a difference (as a mistake of a later step would leave it).
    const raw = rawDatabase(data);
    try { raw.prepare("UPDATE migration_v14 SET value=? WHERE key='references'").run("differ: 2 ids the old code kept are not kept, 0 ids are kept that it did not"); } finally { raw.close(); }
    const gate = store.collectionGate();
    assert.equal(gate.allowed, false); assert.equal(gate.reportOnly, false);
    collectContent(store, content, line => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /CONTENT_COLLECTION \(nothing is collected: the content the converted conversations refer to differs from what the old code referred to \(2 ids the old code kept are not kept, 0 ids are kept that it did not\)/u);
    assert.equal(content.read(orphan).ref.id, orphan, "nothing was deleted");
    assert.equal(store.collectionGate().reportOnly, false, "and the first start is not counted as done");
    collectContent(store, content, line => lines.push(line));
    assert.equal(content.read(orphan).ref.id, orphan, "nor on the next try");
  } finally { store.close(); }
});
