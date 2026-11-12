import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { ladderFaults } from "../../src/infrastructure/session/upgrade-check.js";
import { V12_FIXTURES, loadV12Fixture, separate, writeV12Root, type V12Event, type V12Fixture } from "../fixtures/relay/v12/database.js";
import { code, count, rawDatabase, temporary } from "../fixtures/store-helpers.js";

// A v12 root is the root a real installation has, and its upgrade crosses both stages in one start: the first transaction (the old ladder to v13, the tables, the bookkeeping, the
// decision about a native session two conversations hold, the generation claimed) and then each conversation in a transaction of its own. A process killed at any point of it —
// before the first transaction, inside it, between the stages, in the middle of the second — leaves a root that the next start brings to exactly the rows an uninterrupted start
// leaves; and until the first transaction has committed the library is the very bytes it was, so that the build before this one still opens it.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const storePeer = join(repository, "tests/fixtures/conversation-store-peer.mjs");
const userVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA user_version").get()?.user_version);

/** A value swapped for another wherever it stands as a whole string in a fixture's conversations (snapshots and events). */
function swapped(fixture: V12Fixture, from: string, to: string): V12Fixture {
  const swap = (value: unknown): unknown => typeof value === "string" ? (value === from ? to : value) : Array.isArray(value) ? value.map(swap)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)])) : value;
  return { ...fixture, sessions: fixture.sessions.map(row => ({ ...row, snapshot: swap(row.snapshot) as Record<string, unknown>, events: row.events.map(event => swap(event) as V12Event) })) };
}
/** A v12 root of all seven fixtures (eight conversations), two of which hold one native session. */
function crossingRoot(t: TestContext): string {
  const suffix = (name: string): string => name + "-" + V12_FIXTURES.indexOf(name as never);
  const fixtures = V12_FIXTURES.map(name => separate(loadV12Fixture(name), suffix(name)));
  // The clear fixture's native session is the d1 fixture's.
  const clear = V12_FIXTURES.indexOf("clear");
  fixtures[clear] = swapped(fixtures[clear]!, "native-alpha-1-" + suffix("clear"), "native-alpha-1-" + suffix("d1"));
  const data = join(temporary(t), "data");
  writeV12Root(data, fixtures);
  return data;
}
const CONVERSATION_TABLES = ["sessions", "runs", "items", "item_text", "bindings", "commands", "switches", "origin_history", "content_refs", "notice_prints", "create_keys", "relay_bodies", "relay_packets", "relay_deliveries", "relay_index", "migration_v14_moves"];
function conversationRows(db: DatabaseSync): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(CONVERSATION_TABLES.map(table => [table, db.prepare('SELECT * FROM "' + table + '"').all().map(row => JSON.stringify(row)).sort()]));
}
async function killed(root: string, args: readonly string[], killAfterMs?: number): Promise<NodeJS.Signals | null> {
  const child = spawn(process.execPath, [storePeer, root, "open", ...args], { stdio: ["ignore", "ignore", "inherit"] });
  const timer = killAfterMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  const [, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (timer !== undefined) clearTimeout(timer);
  return signal;
}

test("a v12 root crossing both stages in one start: killed before the first transaction, inside it at each of its four points, between the stages and in the middle of the second, it ends as an uninterrupted start does, and until the first transaction commits it is the very bytes it was", async t => {
  const base = crossingRoot(t), original = readFileSync(join(base, "gateway.sqlite"));
  const probe = rawDatabase(base, true), conversations = count(probe, "sessions"); probe.close();
  assert.equal(conversations, 8);
  // The uninterrupted start, counting what it does.
  const whole = join(temporary(t), "whole"); cpSync(base, whole, { recursive: true });
  let steps = 0, points = 0;
  new SqliteConversationStore(whole, { migrationStep: () => { steps++; }, migrationInside: () => { points++; } }).close();
  assert.equal(steps, 3 + 2 * conversations + 1); assert.equal(points, 4);
  const expectedDb = rawDatabase(whole, true), expected = conversationRows(expectedDb);
  assert.equal(count(expectedDb, "migration_v14_moves"), 1, "the root holds one native session twice, and the upgrade decided it"); assert.ok(count(expectedDb, "bindings", "status='archived'") >= 1);
  expectedDb.close();
  const finish = (root: string, label: string): void => {
    const store = new SqliteConversationStore(root);
    try { assert.ok(store.migration === null || store.migration.stopped === null, label); } finally { store.close(); }
    const db = rawDatabase(root, true);
    try {
      assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(row => ({ ...row })), [{ integrity_check: "ok" }], label);
      assert.deepEqual(conversationRows(db), expected, label + ": the same rows as an uninterrupted start"); assert.equal(count(db, "sessions", "format<14"), 0, label);
    } finally { db.close(); }
  };
  /** Until the first transaction has committed: the library is the very bytes it was, version 12, readable by the old ladder, and the copy of this try is there. */
  const untouched = (root: string, label: string, backedUp = true): void => {
    assert.deepEqual(readFileSync(join(root, "gateway.sqlite")), original, label + ": the library file is the very bytes it was");
    const db = new DatabaseSync(join(root, "gateway.sqlite"), { readOnly: true });
    try {
      assert.equal(userVersion(db), 12, label); assert.deepEqual(ladderFaults(db, 12), [], label + ": and the old reading takes every conversation");
      assert.equal(Number(db.prepare("SELECT owner_active FROM owner_metadata").get()?.owner_active), 0, label + ": nobody owns it");
    } finally { db.close(); }
    assert.equal(existsSync(join(root, "backups", "gateway-v12-before-v14.sqlite")), backedUp, label + (backedUp ? ": the copy of this try is kept" : ": the copy was not taken yet"));
  };

  // Inside the first transaction, at each of its four points.
  for (const point of [1, 2, 3, 4]) {
    const root = join(temporary(t), "inside-" + point); cpSync(base, root, { recursive: true });
    assert.equal(await killed(root, ["--kill-inside", String(point)]), "SIGKILL", "point " + point);
    untouched(root, "killed inside the first transaction at point " + point);
    finish(root, "killed inside the first transaction at point " + point);
  }
  // At each step the upgrade reports: the first two are before the transaction, the third is after it commits (between the stages), the rest are the second stage.
  for (let step = 1; step <= steps; step++) {
    const root = join(temporary(t), "step-" + step); cpSync(base, root, { recursive: true });
    assert.equal(await killed(root, ["--kill-at", String(step)]), "SIGKILL", "step " + step);
    if (step <= 2) untouched(root, "killed at step " + step, step === 2);
    else { const db = new DatabaseSync(join(root, "gateway.sqlite"), { readOnly: true }); try { assert.equal(userVersion(db), 14, "step " + step + ": the first transaction committed"); } finally { db.close(); } }
    finish(root, "killed at step " + step);
  }
});

test("random moments of a v12 upgrade, with every step slowed so that the kills land inside the work: whatever is left, the next start ends as an uninterrupted one", async t => {
  const base = crossingRoot(t);
  const whole = join(temporary(t), "whole"); cpSync(base, whole, { recursive: true });
  const started = performance.now(); new SqliteConversationStore(whole).close(); const wholeMs = performance.now() - started;
  const expectedDb = rawDatabase(whole, true), expected = conversationRows(expectedDb); expectedDb.close();
  let seed = 20261113, landed = 0;
  const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 10; round++) {
    const root = join(temporary(t), "random-" + round); cpSync(base, root, { recursive: true });
    const pause = round % 2 === 0 ? 8 : 0;
    const signal = await killed(root, pause === 0 ? [] : ["--pause", String(pause)], Math.floor(random() * 1.2 * (wholeMs + 40 * pause) + 60));
    if (signal === "SIGKILL") landed++;
    const store = new SqliteConversationStore(root);
    try { assert.ok(store.migration === null || store.migration.stopped === null, "round " + round); } finally { store.close(); }
    const db = rawDatabase(root, true);
    try { assert.deepEqual(conversationRows(db), expected, "round " + round + ": the same rows as an uninterrupted start"); } finally { db.close(); }
  }
  t.diagnostic(`${landed} of 10 random kills landed before the end`);
  assert.ok(landed >= 3);
});

test("a first transaction that is refused (the owner before it may still be alive) changes nothing: the library is the very bytes it was, and the build before still opens it", t => {
  const base = crossingRoot(t), data = join(temporary(t), "data");
  cpSync(base, data, { recursive: true });
  // A previous owner that is marked active and whose process is alive (this one): the takeover is refused inside the first transaction, after the backup.
  const marked = rawDatabase(data); marked.prepare("UPDATE owner_metadata SET owner_active=1, owner_pid=?, owner_token='held'").run(process.pid); marked.exec("PRAGMA wal_checkpoint(TRUNCATE)"); marked.close();
  const before = readFileSync(join(data, "gateway.sqlite"));
  assert.throws(() => new SqliteConversationStore(data), code("OWNER_UNCONFIRMED"));
  assert.deepEqual(readFileSync(join(data, "gateway.sqlite")), before, "the library file is the very bytes it was");
  const db = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
  try { assert.equal(userVersion(db), 12); assert.deepEqual(ladderFaults(db, 12), []); } finally { db.close(); }
  assert.deepEqual(readdirSync(data).sort().filter(name => !name.startsWith("gateway.sqlite-")), [".harness-gateway.json", "backups", "gateway.sqlite", "owner.sqlite"]);
  assert.ok(existsSync(join(data, "backups", "gateway-v12-before-v14.sqlite")));
});
