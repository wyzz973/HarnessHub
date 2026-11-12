import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { CapabilityStore } from "../../src/infrastructure/capabilities/store.js";
import { managementStorage } from "../../src/infrastructure/management/storage.js";
import { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { describeRestore, restoreBackup, type Restored } from "../../src/infrastructure/session/restore-backup.js";
import { V12_FIXTURES, loadV12Fixture, separate, writeV12Root } from "../fixtures/relay/v12/database.js";
import { code, temporary, treeDigest } from "../fixtures/store-helpers.js";
import { SessionError } from "../../src/contracts/session.js";

// `sessions restore-backup` (src/infrastructure/session/restore-backup.ts): the backup of an upgrade put back as the library, safely. A data root is upgraded by the real store (a v12
// fixture root, several starts, each also opening the management library and the capability store at the generation the start took, as the application does), and then put
// back. What must hold: nothing is deleted, the library in use is kept and is the very file it was, the backup stays, the copy differs from the backup in one number (the
// owner generation, brought up to the largest any library remembers), the build that made the backup can take the result over where it cannot take a copy put back by hand, and
// a run killed at any phase and run again ends as an uninterrupted one. All on data roots in temporary directories.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const restorePeer = join(repository, "tests/fixtures/restore-peer.mjs");
const storePeer = join(repository, "tests/fixtures/conversation-store-peer.mjs");
const sessionsCli = join(repository, "dist/src/cli/sessions.js");
const FIXED = new Date("2026-11-13T00:00:00.000Z");
const NAME = "gateway-v12-before-v14.sqlite", ASIDE = "gateway-v14-set-aside-20261113T000000Z.sqlite";

/** Every table of a library, as sorted rows of JSON text — the whole content — read as it is on disk, with no log made. */
function dump(file: string): Record<string, readonly string[]> {
  const address = pathToFileURL(file); address.searchParams.set("mode", "ro"); address.searchParams.set("immutable", "1");
  const db = new DatabaseSync(address.href, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => [String(row.name), db.prepare('SELECT * FROM "' + String(row.name) + '"').all().map(entry => JSON.stringify(entry)).sort()]));
  } finally { db.close(); }
}
const withoutGeneration = (tables: Record<string, readonly string[]>): Record<string, readonly string[]> => ({ ...tables, owner_metadata: tables.owner_metadata!.map(row => row.replace(/"owner_generation":\d+/u, '"owner_generation":N')) });
function version(file: string): number { return readFileSync(file).readUInt32BE(60); }
function listing(root: string): string[] {
  return [...readdirSync(root).sort(), ...(existsSync(join(root, "backups")) ? readdirSync(join(root, "backups")).sort().map(name => "backups/" + name) : [])];
}

interface Upgraded { readonly data: string; readonly generations: readonly number[]; readonly original: Record<string, readonly string[]>; readonly backup: string }
/** A v12 root upgraded by the store, `starts` times started; each start also opens the other two libraries at the generation it took. */
function upgradedRoot(t: TestContext, starts = 3): Upgraded {
  const data = join(temporary(t), "data");
  writeV12Root(data, [separate(loadV12Fixture("d1"), "one"), separate(loadV12Fixture("clear"), "two"), separate(loadV12Fixture("import"), "three")]);
  const original = dump(join(data, "gateway.sqlite")), generations: number[] = [];
  for (let start = 0; start < starts; start++) {
    const store = new SqliteConversationStore(data);
    generations.push(store.ownerGeneration);
    managementStorage(data, store.ownerGeneration).db.close(); CapabilityStore.open(data, store.ownerGeneration).close();
    store.close();
  }
  return { data, generations, original, backup: join(data, "backups", NAME) };
}
/** The step a library is refused by a build whose generation is below what it remembers, as the build before the upgrade is: the other libraries are opened at the generation it takes. */
function oldBuildTakesOver(data: string): { readonly takes: number } {
  const owner = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: false });
  let takes: number;
  try { takes = Number(owner.prepare("SELECT owner_generation FROM owner_metadata").get()!.owner_generation) + 1; } finally { owner.close(); }
  managementStorage(data, takes).db.close(); CapabilityStore.open(data, takes).close();
  return { takes };
}

test("the backup is put back: the library in use is kept, the backup stays, the copy differs from the backup in its owner generation and nothing else, and the build before takes it over", t => {
  const { data, generations, original, backup } = upgradedRoot(t);
  const backupBytes = readFileSync(backup), backupTime = statSync(backup).mtimeMs, upgradedDump = dump(join(data, "gateway.sqlite")), upgradedBytes = readFileSync(join(data, "gateway.sqlite"));
  const largest = generations.at(-1)!;
  assert.ok(Number(original.owner_metadata![0]!.match(/"owner_generation":(\d+)/u)![1]) < largest);
  const before = treeDigest(data);
  const report = restoreBackup(data, { now: () => FIXED }) as Restored;
  assert.equal(report.outcome, "restored");
  assert.deepEqual([report.backup.name, report.backup.version, report.startWith], [NAME, 12, 12]);
  assert.equal(report.setAside?.name, ASIDE); assert.equal(report.setAside?.version, 14);
  assert.deepEqual([report.generation.library, report.generation.management, report.generation.capabilities, report.generation.now], [largest, largest, largest, largest]);
  assert.ok(report.generation.backup !== null && report.generation.backup < largest);
  // The library is the backup's rows but for the one number; it is version 12, private, with no log beside it.
  const restored = join(data, "gateway.sqlite");
  assert.deepEqual(withoutGeneration(dump(restored)), withoutGeneration(original), "every row of every table as the library was before the upgrade");
  assert.match(dump(restored).owner_metadata![0]!, new RegExp('"owner_generation":' + largest + "[,}]"));
  assert.equal(version(restored), 12); assert.equal(statSync(restored).mode & 0o777, 0o600);
  assert.deepEqual(listing(data).filter(name => /restoring|-wal$|-shm$|-journal$/u.test(name)), [], "no copy left over, no log");
  // Nothing was deleted: the backup is the very bytes it was; the library in use is the very file it was, under its new name.
  assert.deepEqual(readFileSync(backup), backupBytes); assert.equal(statSync(backup).mtimeMs, backupTime);
  const kept = join(data, "backups", ASIDE);
  assert.deepEqual(readFileSync(kept), upgradedBytes, "the library in use, the very bytes it was (its log was merged first)"); assert.deepEqual(dump(kept), upgradedDump);
  assert.equal(statSync(kept).mode & 0o777, 0o600); assert.equal(lstatSync(kept).nlink, 1, "a file of its own, not a second name");
  assert.equal(lstatSync(kept).ino !== lstatSync(restored).ino, true);
  assert.deepEqual(listing(data).filter(name => !before.some(line => line.startsWith(name + " ") || line.startsWith(name + "/"))), ["backups/" + ASIDE], "the one thing that is new in the data directory is the kept library");
  assert.equal(statSync(join(data, "management", "management.sqlite")).size > 0, true);
  // The build before takes the restored library over: it takes the next generation, and the other libraries accept it. (A library put back by hand is refused: next test.)
  assert.deepEqual(oldBuildTakesOver(data), { takes: largest + 1 });
});

test("a library put back by hand, as the manual steps said, is refused by the libraries beside it once the upgraded build has been started more than once: the reason the command exists", t => {
  const { data, generations, backup } = upgradedRoot(t, 3);
  const lock = join(data, "gateway.sqlite");
  cpSync(backup, lock); for (const side of ["-wal", "-shm"]) if (existsSync(lock + side)) renameSync(lock + side, join(data, "removed" + side));
  const own = Number(new DatabaseSync(lock).prepare("SELECT owner_generation FROM owner_metadata").get()!.owner_generation);
  assert.ok(own + 1 < generations.at(-1)!, "the old build would take " + (own + 1) + " and the libraries beside it remember " + generations.at(-1));
  assert.throws(() => managementStorage(data, own + 1), (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "OWNERSHIP_LOST" && /management owner generation is stale/u.test(error.message));
  assert.throws(() => CapabilityStore.open(data, own + 1), (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "OWNERSHIP_LOST");
  // After one start only, the generations happen to be equal and it passes — which is why it was found late.
  const once = upgradedRoot(t, 1);
  cpSync(once.backup, join(once.data, "gateway.sqlite"));
  const next = Number(new DatabaseSync(join(once.data, "gateway.sqlite")).prepare("SELECT owner_generation FROM owner_metadata").get()!.owner_generation) + 1;
  managementStorage(once.data, next).db.close();
});

test("the generation is the largest any library remembers: the management library, the capability store, the library in use, or the backup's own", t => {
  const cases: readonly { readonly management: number | null; readonly capabilities: number | null; readonly expected: "management" | "capabilities" | "library" }[] = [
    { management: 40, capabilities: 7, expected: "management" }, { management: 5, capabilities: 90, expected: "capabilities" }, { management: null, capabilities: null, expected: "library" }];
  for (const [index, found] of cases.entries()) {
    const { data, generations } = upgradedRoot(t, 2);
    const set = (file: string, table: string, value: number): void => { const db = new DatabaseSync(file); try { db.prepare("UPDATE " + table + " SET generation=?").run(value); } finally { db.close(); } };
    if (found.management !== null) set(join(data, "management", "management.sqlite"), "management_owner", found.management);
    if (found.capabilities !== null) set(join(data, "capabilities", "capabilities.sqlite"), "capability_owner", found.capabilities);
    if (found.management === null) { cpSync(join(data, "management"), join(data, "..", "management-away"), { recursive: true }); }
    const expected = found.expected === "management" ? 40 : found.expected === "capabilities" ? 90 : generations.at(-1)!;
    const report = restoreBackup(data, { now: () => FIXED }) as Restored;
    assert.equal(report.generation.now, expected, "case " + index);
    assert.match(dump(join(data, "gateway.sqlite")).owner_metadata![0]!, new RegExp('"owner_generation":' + expected + "[,}]"));
  }
  // A library that remembers less than the backup does is not brought down.
  const { data, backup } = upgradedRoot(t, 1);
  const raise = new DatabaseSync(backup); raise.prepare("UPDATE owner_metadata SET owner_generation=500").run(); raise.close();
  const report = restoreBackup(data, { now: () => FIXED }) as Restored;
  assert.equal(report.generation.now, 500); assert.equal(report.generation.backup, 500);
});

test("several backups: none is guessed; --backup names one of them; a name that is not a backup of this data directory is refused; nothing is changed by any of it", t => {
  const { data, backup } = upgradedRoot(t);
  const second = join(data, "backups", "gateway-v13-before-v14.sqlite");
  cpSync(backup, second); const edit = new DatabaseSync(second); edit.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=13"); edit.close(); chmodSync(second, 0o600);
  const before = treeDigest(data);
  assert.throws(() => restoreBackup(data), (error: unknown) => error instanceof SessionError && error.code === "BACKUP_CHOICE" && error.message.includes(NAME) && error.message.includes("gateway-v13-before-v14.sqlite") && error.message.includes("--backup"));
  for (const name of ["../backups/" + NAME, "/etc/passwd", "gateway.sqlite", "gateway-v12-before-v14.sqlite.partial", "gateway-v9-before-v14.sqlite"]) {
    assert.throws(() => restoreBackup(data, { backup: name }), (error: unknown) => error instanceof SessionError && (error.code === "INVALID_INPUT" || error.code === "BACKUP_NOT_FOUND"), name);
  }
  assert.deepEqual(treeDigest(data), before, "the data directory is the very bytes it was");
  const report = restoreBackup(data, { backup: "gateway-v13-before-v14.sqlite", now: () => FIXED }) as Restored;
  assert.deepEqual([report.backup.name, report.startWith], ["gateway-v13-before-v14.sqlite", 13]); assert.equal(version(join(data, "gateway.sqlite")), 13);
  assert.ok(existsSync(second) && existsSync(backup), "both backups are where they were");
});

test("no backup, a link where a file is, a backup that is damaged, one whose version is not its name's: each is refused, no copy is left, and when the backup is back the data directory is the very bytes it was", t => {
  const { data, backup } = upgradedRoot(t);
  const fileLines = (lines: readonly string[]): string[] => lines.filter(line => / [0-9a-f]{64}$/u.test(line));
  const before = fileLines(treeDigest(data)), away = join(data, "backups", "away.sqlite"), folder = join(data, "backups");
  const refused = (expected: string, message?: RegExp): void => {
    assert.throws(() => restoreBackup(data), (error: unknown) => error instanceof SessionError && error.code === expected && (message === undefined || message.test(error.message)), expected);
    assert.deepEqual(listing(data).filter(name => /restoring|-journal$/u.test(name)), [], "the unfinished copy of a refused run is taken away");
  };
  // No backup: the file is not in backups/.
  renameSync(backup, away);
  refused("BACKUP_NOT_FOUND");
  // A link in place of the file is no backup at all.
  symlinkSync(away, backup);
  refused("BACKUP_NOT_FOUND");
  unlinkSync(backup);
  // A file with nothing in it is no library of version 12.
  writeFileSync(backup, "", { mode: 0o600 });
  refused("BACKUP_INVALID", /library of version 0 and its name says 12/u);
  // A library cut in half is damaged.
  const bytes = readFileSync(away);
  writeFileSync(backup, bytes.subarray(0, Math.floor(bytes.length / 2)));
  refused("BACKUP_INVALID");
  // The name says another version than the file has.
  unlinkSync(backup);
  copyFileSync(away, join(folder, "gateway-v11-before-v14.sqlite"));
  refused("BACKUP_INVALID", /version 12 and its name says 11/u);
  unlinkSync(join(folder, "gateway-v11-before-v14.sqlite"));
  renameSync(away, backup);
  assert.deepEqual(fileLines(treeDigest(data)), before, "after all that the library, the backup and the rest are as they were");
});

test("a run that fails after it set the library in use aside takes what it made away again: the library has one link, as the store wants, and the data directory is as it was", t => {
  const { data } = upgradedRoot(t);
  // (Every file with its size, time and digest; the times of the directories change with the name made and taken away, which is nothing of the data.)
  const files = (): string[] => treeDigest(data).filter(line => / [0-9a-f]{64}$/u.test(line)), before = files();
  for (const phase of ["aside", "verified", "edited", "copied"] as const) {
    assert.throws(() => restoreBackup(data, { now: () => FIXED, step: reached => { if (reached === phase) throw new Error("injected after " + phase); } }), /injected/u);
    assert.deepEqual(files(), before, "failed after " + phase);
    assert.equal(lstatSync(join(data, "gateway.sqlite")).nlink, 1, "one link only, after " + phase);
  }
  assert.equal(restoreBackup(data, { now: () => FIXED }).outcome, "restored");
  assert.equal(lstatSync(join(data, "gateway.sqlite")).nlink, 1);
});

test("the service running makes the command refuse, and not a byte is changed", async t => {
  const { data } = upgradedRoot(t);
  const holder = spawn(process.execPath, [storePeer, data, "hold"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (holder.exitCode === null) holder.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => { holder.once("message", () => resolve()); holder.once("exit", () => reject(new Error("the holder ended before it was ready"))); });
  const before = treeDigest(data, ["gateway.sqlite-wal", "gateway.sqlite-shm"]);
  assert.throws(() => restoreBackup(data), (error: unknown) => error instanceof SessionError && error.code === "OWNER_BUSY" && /stop it/u.test(error.message));
  assert.deepEqual(treeDigest(data, ["gateway.sqlite-wal", "gateway.sqlite-shm"]), before);
  holder.kill("SIGTERM"); await once(holder, "exit");
  // Let go of, the same command goes through.
  assert.equal(restoreBackup(data, { now: () => FIXED }).outcome, "restored");
});

test("a log that was not merged (the service was killed with commits in it) is merged first: what it held is in the kept library", t => {
  const { data } = upgradedRoot(t);
  const written = spawnSync(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(x); INSERT INTO marker VALUES(42)"); process.kill(process.pid, "SIGKILL");`, join(data, "gateway.sqlite")], { encoding: "utf8" });
  assert.equal(written.signal, "SIGKILL");
  assert.ok(existsSync(join(data, "gateway.sqlite-wal")) && statSync(join(data, "gateway.sqlite-wal")).size > 0, "the killed service left a log with a commit in it");
  const report = restoreBackup(data, { now: () => FIXED }) as Restored;
  assert.deepEqual(dump(join(data, "backups", report.setAside!.name)).marker, ['{"x":42}'], "the kept library holds what the log held");
  assert.ok(!existsSync(join(data, "gateway.sqlite-wal")) && !existsSync(join(data, "gateway.sqlite-shm")), "no log beside the restored library");
  assert.equal("marker" in dump(join(data, "gateway.sqlite")), false);
});

test("a log that cannot be merged (something still reads the library) is refused with the data directory as it was; when what reads lets go, the same command goes through", t => {
  const { data } = upgradedRoot(t);
  const written = spawnSync(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE marker(x); INSERT INTO marker VALUES(7)"); process.kill(process.pid, "SIGKILL");`, join(data, "gateway.sqlite")], { encoding: "utf8" });
  assert.equal(written.signal, "SIGKILL");
  // A reader in the middle of a read: the log it reads through cannot be truncated while it is there.
  const reader = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) AS n FROM sessions").get();
  // (The merge is attempted before the refusal and may move some of the log into the library: the library holds the same rows, read through its log or not.)
  const rows = (): string => { const db = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true }); try { return JSON.stringify([db.prepare("SELECT * FROM marker").all(), db.prepare("SELECT COUNT(*) AS n FROM sessions").get(), db.prepare("SELECT COUNT(*) AS n FROM events").get()]); } finally { db.close(); } };
  const before = rows(), others = treeDigest(data).filter(line => / [0-9a-f]{64}$/u.test(line) && !/^gateway\.sqlite/u.test(line));
  try {
    assert.throws(() => restoreBackup(data, { now: () => FIXED }), (error: unknown) => error instanceof SessionError && error.code === "LIBRARY_NOT_MERGED" && /nothing was changed/u.test(error.message));
    assert.equal(rows(), before, "the library holds what it held");
    assert.deepEqual(treeDigest(data).filter(line => / [0-9a-f]{64}$/u.test(line) && !/^gateway\.sqlite/u.test(line)), others, "no other file changed, none made");
    assert.deepEqual(listing(data).filter(name => /restoring|set-aside/u.test(name)), []);
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  const report = restoreBackup(data, { now: () => FIXED }) as Restored;
  assert.deepEqual(dump(join(data, "backups", report.setAside!.name)).marker, ['{"x":7}'], "and what the log held is in the kept library");
});

test("run again after it was done, it says so and changes nothing; a library that is not version 14 is not something to restore", t => {
  const { data } = upgradedRoot(t);
  assert.equal(restoreBackup(data, { now: () => FIXED }).outcome, "restored");
  const before = treeDigest(data);
  const again = restoreBackup(data, { now: () => new Date("2027-01-01T00:00:00.000Z") });
  assert.deepEqual(again.outcome === "already" ? [again.version, again.setAsides, again.startWith] : null, [12, [ASIDE], 12]);
  assert.deepEqual(treeDigest(data), before, "not a byte, not a file");
  assert.match(describeRestore(again).join("\n"), /Nothing to restore: the library is version 12, not 14/u);
  // A root that was never upgraded has no backup of an upgrade.
  const fresh = join(temporary(t), "data"); writeV12Root(fresh, [loadV12Fixture("d1")]);
  assert.throws(() => restoreBackup(fresh), code("BACKUP_NOT_FOUND"));
});

test("without a library in use (it was moved away by hand) the backup is put in its place, and there is nothing to set aside; a library newer than version 14 is not touched", t => {
  const { data } = upgradedRoot(t);
  for (const side of ["", "-wal", "-shm"]) if (existsSync(join(data, "gateway.sqlite" + side))) renameSync(join(data, "gateway.sqlite" + side), join(data, "moved" + side));
  const report = restoreBackup(data, { now: () => FIXED }) as Restored;
  assert.equal(report.setAside, null); assert.equal(version(join(data, "gateway.sqlite")), 12);
  assert.match(describeRestore(report).join("\n"), /There was no library in use to set aside/u);
  const future = upgradedRoot(t, 1);
  const raise = new DatabaseSync(join(future.data, "gateway.sqlite")); raise.exec("PRAGMA user_version=15"); raise.close();
  const before = treeDigest(future.data);
  assert.throws(() => restoreBackup(future.data), code("LIBRARY_TOO_NEW")); assert.deepEqual(treeDigest(future.data), before);
});

test("a backup whose owner row says an owner is active: said in the report when a process with that id is running, and the row is left as it is", t => {
  for (const [pid, alive] of [[process.pid, true], [2 ** 22 - 3, false]] as const) {
    const { data, backup } = upgradedRoot(t, 2);
    const mark = new DatabaseSync(backup); mark.prepare("UPDATE owner_metadata SET owner_active=1, owner_pid=?, owner_token='held'").run(pid); mark.close();
    const report = restoreBackup(data, { now: () => FIXED }) as Restored;
    assert.deepEqual(report.ownerMarked, alive ? { pid } : null);
    assert.match(dump(join(data, "gateway.sqlite")).owner_metadata![0]!, /"owner_active":1/u, "the row is the backup's, but for its generation");
    assert.equal(describeRestore(report).some(line => /^Warning: the restored library marks the process/u.test(line)), alive);
  }
});

test("no room for the copy: refused before anything is written", t => {
  const { data } = upgradedRoot(t);
  const before = treeDigest(data);
  assert.throws(() => restoreBackup(data, { freeBytes: () => 10 }), code("INSUFFICIENT_SPACE"));
  assert.deepEqual(treeDigest(data), before);
});

test("killed at each phase it reports, and run again, it ends exactly as an uninterrupted run does; at no moment is there no library, or a library with a log that is not its own", async t => {
  const { data: base } = upgradedRoot(t);
  const upgradedDump = dump(join(base, "gateway.sqlite")), backupBytes = readFileSync(join(base, "backups", NAME));
  const whole = join(temporary(t), "whole"); cpSync(base, whole, { recursive: true });
  let phases = 0;
  restoreBackup(whole, { now: () => FIXED, step: () => { phases++; } });
  assert.equal(phases, 9);
  const finished = { library: dump(join(whole, "gateway.sqlite")), files: listing(whole), kept: dump(join(whole, "backups", ASIDE)) };
  assert.deepEqual(finished.kept, upgradedDump);
  const names = ["locked", "chosen", "merged", "copied", "edited", "verified", "aside", "swapped", "cleaned"];
  for (let phase = 1; phase <= 9; phase++) {
    const root = join(temporary(t), "kill-" + phase); cpSync(base, root, { recursive: true });
    const child = spawn(process.execPath, [restorePeer, root, "--kill-at", String(phase), "--now", FIXED.toISOString()], { stdio: ["ignore", "ignore", "inherit"] });
    const [, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(signal, "SIGKILL", "killed after " + names[phase - 1]);
    // Whatever moment it was killed at: a library is there, and it is either the one in use or the restored one.
    const now = dump(join(root, "gateway.sqlite"));
    assert.ok(JSON.stringify(now) === JSON.stringify(upgradedDump) || JSON.stringify(now) === JSON.stringify(finished.library), "after " + names[phase - 1] + " gateway.sqlite is one of the two libraries");
    assert.deepEqual(readFileSync(join(root, "backups", NAME)), backupBytes, "the backup is untouched");
    if (phase === 7) {
      // Killed after the library in use was set aside and before the swap: the library is still the one library with one name, so a start would go on with it, and the copy of
      // it that was set aside is complete (the command run again finds it and makes no second).
      assert.equal(lstatSync(join(root, "gateway.sqlite")).nlink, 1);
      assert.deepEqual(readFileSync(join(root, "backups", ASIDE)), readFileSync(join(root, "gateway.sqlite")));
      assert.deepEqual(dump(join(root, "gateway.sqlite")), upgradedDump, "and the library is whole");
    }
    const report = restoreBackup(root, { now: () => FIXED });
    assert.equal(report.outcome, phase >= 8 ? "already" : "restored", "run again after " + names[phase - 1]);
    assert.deepEqual({ library: dump(join(root, "gateway.sqlite")), files: listing(root), kept: dump(join(root, "backups", ASIDE)) }, finished, "after " + names[phase - 1] + " and a second run: the same as an uninterrupted run");
    assert.deepEqual(readFileSync(join(root, "backups", NAME)), backupBytes);
  }
});

test("what it says: file names, versions and generations; what it does not bring back; no path of the machine and no word of a conversation", t => {
  const { data } = upgradedRoot(t);
  const lines = describeRestore(restoreBackup(data, { now: () => FIXED })).join("\n");
  assert.match(lines, /Restored the library of version 12 from backups\/gateway-v12-before-v14\.sqlite \(3 conversations, \d+ events\); the backup stays where it is\./u);
  assert.match(lines, /The library in use \(version 14, owner generation \d+\) is kept as backups\/gateway-v14-set-aside-20261113T000000Z\.sqlite\./u);
  assert.match(lines, /Owner generation of the restored library: \d+ -> \d+, the largest any library of the data directory remembers \(conversation library \d+, management library \d+, capability store \d+\); the build that takes it over takes \d+\./u);
  assert.match(lines, /Start it with a build that reads library version 12/u);
  assert.match(lines, /not in the restored library; they are in the kept version 14 library \(backups\/gateway-v14-set-aside-20261113T000000Z\.sqlite\)\. The build before collects, when it starts, the stored content/u);
  assert.ok(!lines.includes(data) && !lines.includes(dirname(data)) && !lines.includes("/"+"tmp") && !/private|var\/folders/u.test(lines));
  const fixture = JSON.stringify(loadV12Fixture("d1")), words = /"text":"([^"]{12,})"/u.exec(fixture)?.[1];
  assert.ok(words !== undefined && !lines.includes(words));
});

test("the command: exit 0 and the lines, 1 with the reason when refused; --json is the report; a wrong flag is refused", t => {
  const { data } = upgradedRoot(t), directory = dirname(data), home = join(directory, "home");
  const run = (...args: string[]) => spawnSync(process.execPath, [sessionsCli, "restore-backup", "--workspace-lock-root", join(directory, "locks"), ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home } });
  const refused = run("--data-dir", data, "--backup", "gateway-v9-before-v14.sqlite");
  assert.equal(refused.status, 1); assert.match(refused.stderr, /HarnessGateway: BACKUP_NOT_FOUND — there is no backup of that name in backups\//u);
  assert.equal(run("--data-dir", data, "--session", "x").status, 1);
  const json = run("--data-dir", data, "--json");
  assert.equal(json.status, 0, json.stderr); assert.equal((JSON.parse(json.stdout) as { outcome: string }).outcome, "restored");
  const text = run("--data-dir", data);
  assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /Nothing to restore: the library is version 12, not 14/u);
  assert.ok(!text.stdout.includes(directory) && !json.stdout.includes(directory) && !refused.stderr.includes(directory));
  const other = spawnSync(process.execPath, [sessionsCli, "list", "--data-dir", data, "--backup", "x", "--workspace-lock-root", join(directory, "locks")], { encoding: "utf8" });
  assert.equal(other.status, 1); assert.match(other.stderr, /--backup is only used with restore-backup/u);
  void V12_FIXTURES;
});
