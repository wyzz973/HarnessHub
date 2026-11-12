import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { oldShape } from "../fixtures/old-shape.js";
import { appStore } from "../fixtures/runtime-store.js";
import { scriptedWorld } from "../fixtures/scripted-world.js";

// Derived data must not take storage down. The full-text indexes are made from the rows and can be made again at any time; a failure of theirs — in the backfill that fills them after an
// upgrade, in the commit that keeps them current, or in a read that asks which are complete — is told once in the service log, makes the index unusable for this process (a search then scans, and says
// so in each hit's `via`), and changes nothing else: the store is not failed, a Turn runs and commits, its words are in the rows. The data roots here are the ones that did happen
// (a `derived` table of an earlier build that has no `progress`) and the ones that can (an index table gone), made by changing the file of a real store before it is opened.

/** A data root of a real store, changed as a build or a disk may have left it. */
function broken(change: (db: DatabaseSync) => void): (data: string) => void {
  return data => {
    appStore(data).close();
    const db = new DatabaseSync(join(data, "gateway.sqlite"));
    try { change(db); } finally { db.close(); }
  };
}
/** `derived` as the build that first made it left it: no `progress`, the indexes empty (an upgrade writes none). */
const OLD_DERIVED = (db: DatabaseSync): void => {
  db.exec("DROP TABLE derived");
  db.exec("CREATE TABLE derived(name TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN('empty','building','ready')), updated_at INTEGER NOT NULL) STRICT, WITHOUT ROWID");
  db.exec("INSERT INTO derived(name,state,updated_at) VALUES('search_fts','empty',1),('search_chars','empty',1)");
};
const quiet = () => [{ type: "text", text: "a reply with the word needle in it" }] as const;

test("a backfill that fails stops, says why once, and leaves the store whole: Turns run and commit, and a search scans", { timeout: 30_000 }, async t => {
  const lines: string[] = [];
  const w = await scriptedWorld(t, quiet, { before: broken(OLD_DERIVED), store: { report: line => { lines.push(line); } } });
  await w.send("first needle question");
  // The backfill meets a table that has no `progress`: it stops, and nothing else does.
  await w.store.startSearchBackfill({ pauseMs: 0 });
  assert.equal(lines.length, 1, "the reason is told once: " + JSON.stringify(lines));
  assert.match(lines[0]!, /progress/u, "and it is the reason SQLite gave");
  assert.doesNotThrow(() => w.store.assertOwner(), "the store is not failed");
  await w.send("second needle question");
  assert.deepEqual(oldShape(w.app, w.id).runs.map(run => run.status), ["completed", "completed"], "the Turns ran and committed");
  const hits = w.store.search("needle", { sessionId: w.id, limit: 10 });
  assert.equal(hits.length > 0 && hits.every(hit => hit.via === "scan"), true, "a search scans, and says so: " + JSON.stringify(hits.map(hit => hit.via)));
  await w.store.startSearchBackfill({ pauseMs: 0 });
  assert.equal(lines.length, 1, "a second attempt, or a second Turn, tells nothing more");
  assert.equal(w.store.searchIndex().states.search_fts === "ready", false, "the index does not claim to be complete");
});

test("an index that cannot be written does not fail the commit that finishes a segment: the Turn ends, the index is told unusable once, and a search scans", { timeout: 30_000 }, async t => {
  const lines: string[] = [];
  const w = await scriptedWorld(t, quiet, { before: broken(db => { db.exec("DROP TABLE search_fts"); }), store: { report: line => { lines.push(line); } } });
  await w.send("first needle question");
  assert.equal(oldShape(w.app, w.id).runs[0]?.status, "completed", "the Turn that finished its segments completed");
  assert.equal(lines.length, 1, "the reason is told once: " + JSON.stringify(lines));
  assert.match(lines[0]!, /search_fts/u);
  assert.doesNotThrow(() => w.store.assertOwner(), "the store is not failed");
  await w.send("second needle question");
  assert.equal(lines.length, 1, "the next commit does not try the broken index again, and says nothing");
  assert.deepEqual(oldShape(w.app, w.id).runs.map(run => run.status), ["completed", "completed"]);
  const hits = w.store.search("needle", { sessionId: w.id, limit: 10 });
  assert.equal(hits.length >= 4 && hits.every(hit => hit.via === "scan"), true, "the words are in the rows, and a search finds them by scan: " + JSON.stringify(hits.map(hit => hit.via)));
});

test("a `derived` table that cannot be read fails neither the commit, nor a search, nor the question of which indexes are complete", { timeout: 30_000 }, async t => {
  const lines: string[] = [];
  const w = await scriptedWorld(t, quiet, { before: broken(db => { db.exec("DROP TABLE derived"); }), store: { report: line => { lines.push(line); } } });
  await w.send("needle question");
  assert.equal(oldShape(w.app, w.id).runs[0]?.status, "completed");
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(w.store.search("needle", { sessionId: w.id, limit: 10 }).every(hit => hit.via === "scan"), true);
  assert.deepEqual(w.store.searchIndex().states, { search_fts: "unusable", search_chars: "unusable" }, "the question has an honest answer");
  assert.doesNotThrow(() => w.store.assertOwner());
  await w.store.startSearchBackfill({ pauseMs: 0 });
  assert.equal(lines.length, 1);
});

test("an index that is whole is used, and a store whose derived data is fine says nothing", { timeout: 30_000 }, async t => {
  const lines: string[] = [];
  const w = await scriptedWorld(t, quiet, { store: { report: line => { lines.push(line); } } });
  await w.send("needle question");
  const hits = w.store.search("needle", { sessionId: w.id, limit: 10 });
  assert.equal(hits.length > 0 && hits.every(hit => hit.via === "trigram"), true, JSON.stringify(hits.map(hit => hit.via)));
  assert.deepEqual(lines, []);
});

test("a web service on a data root whose `derived` has no `progress` starts and serves, and its log says once that searches scan", { timeout: 60_000 }, async t => {
  const scratch = await mkdtemp(join(tmpdir(), "derived-data-web-")), data = join(scratch, "data"), assets = join(scratch, "assets"), workspace = join(scratch, "workspace"), locks = join(scratch, "locks");
  const written: string[] = [], original = process.stderr.write.bind(process.stderr);
  let gateway: Awaited<ReturnType<typeof startWebServer>> | undefined;
  t.after(async () => {
    process.stderr.write = original;
    try { await gateway?.close(); } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  for (const directory of [assets, workspace]) await mkdir(directory);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>derived data</title>");
  broken(OLD_DERIVED)(data);
  // The log of the service is its error stream: what it says is what a person starting it sees.
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { written.push(String(chunk)); return (original as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  const configuration = await prepareConfiguration({ workspace, pathOnly: true });
  gateway = await startWebServer({ installations: "any", root: data, configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: locks,
    application: (root, publish) => application(root, publish, { workspaceLockRoot: locks, installations: "any" }) });
  const origin = new URL(gateway.url).origin, token = new URLSearchParams(new URL(gateway.url).hash.slice(1)).get("token")!;
  const login = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  // The backfill starts a moment after the application is composed; wait for its attempt to be told.
  const told = (): string[] => written.filter(line => line.includes("SEARCH_INDEX_UNAVAILABLE"));
  for (let waited = 0; told().length === 0 && waited < 5000; waited += 20) await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(told().length, 1, "the log says it once: " + JSON.stringify(written.slice(-5)));
  assert.match(told()[0]!, /progress/u);
  for (const path of ["/api/v1/state", "/api/v1/sessions"]) {
    const answered = await fetch(origin + path, { headers: { Cookie: cookie, Origin: origin } });
    assert.equal(answered.status, 200, path + " answers: the store is not failed");
  }
  assert.equal(told().length, 1, "and nothing more is said");
});
