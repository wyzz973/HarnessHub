import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, before, test, type TestContext } from "node:test";
import { canonicalJson } from "../../src/infrastructure/session/rows.js";
import { V12_FIXTURES, loadV12Fixture, separate, writeV12Root } from "../fixtures/relay/v12/database.js";
import { temporary, treeDigest } from "../fixtures/store-helpers.js";

// The way back from the upgrade, rehearsed with the build that is going back: the build of `5c5f12f` (the last one that wrote a version 12 library, and the one the real data was
// last opened by) is taken out of the repository (`git archive`), built once in a temporary directory, and used as a program. A v12 data root is upgraded by the current build (started
// several times, one of them the web server, as the real one is, with a Turn made in between), put back with `sessions restore-backup`, and then taken over by the old build:
// the conversations it lists are the ones that were there before the upgrade, to the word; it starts (every library of the data directory accepts it), makes a Turn, and its web
// server starts; the current build upgrades the restored root again, and nothing of what was kept is lost on the way. And the old steps by hand are refused by the old build.

const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const OLD_COMMIT = "5c5f12f";
const peer = join(repository, "tests/fixtures/session-peer.mjs");
const restorePeer = join(repository, "tests/fixtures/restore-peer.mjs");
const source = { repository: "fixture", revision: "test", upstreamId: "session-peer", url: "https://example.invalid/session-peer" };
const FIXED = new Date("2026-11-13T00:00:00.000Z");

let oldBuild = "";
before(() => {
  // (The real path: a command line entry runs only when the path it was started by is the one the module is found at, and the temporary directory is behind a link.)
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-old-build-")));
  oldBuild = directory;
  const archive = join(directory, "tree.tar");
  execFileSync("git", ["-C", repository, "archive", "--format=tar", "-o", archive, OLD_COMMIT], { stdio: "pipe" });
  execFileSync("tar", ["-x", "-f", archive, "-C", directory], { stdio: "pipe" });
  rmSync(archive);
  symlinkSync(join(repository, "node_modules"), join(directory, "node_modules"));
  // (A compiler that finds fault with a tree of three days ago still emits it; what is needed is the program.)
  try { execFileSync(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: directory, stdio: "pipe", timeout: 300_000 }); } catch { /* the output is looked for below */ }
  for (const script of ["sessions", "chat", "web"]) assert.ok(existsSync(join(directory, "dist/src/cli/" + script + ".js")), "the old build was made: " + script);
});
after(() => { if (oldBuild !== "") rmSync(oldBuild, { recursive: true, force: true }); });

interface Setup { readonly root: string; readonly data: string; readonly home: string; readonly workspace: string; readonly locks: string; readonly manifest: string; readonly temporary: string }
function setup(t: TestContext): Setup {
  const root = temporary(t, "harness-rollback-"), f = { root, data: join(root, "data"), home: join(root, "home"), workspace: join(root, "workspace"), locks: join(root, "locks"), manifest: join(root, "manifest.json"), temporary: join(root, "tmp") };
  for (const folder of [f.home, f.workspace, f.temporary]) mkdirSync(folder);
  const definitions = ["a"].map(name => ({ id: `session-${name}`, name: `Session ${name}`, aliases: [`alias-${name}`], binaryNames: [], configHints: [],
    controls: [{ id: `session-${name}-control`, protocol: "acp-v1", executableNames: ["fixture-peer"], args: [peer, "acp-v1", name, "basic"],
      env: { HOME: "/forbidden-host-home", CODEX_HOME: "/forbidden-host-codex-home", TMPDIR: "/forbidden-host-tmp" }, package: null, distribution: null, requiredExecutables: [], source }] }));
  writeFileSync(f.manifest, JSON.stringify({ version: 2, definitions, overrides: Object.fromEntries(definitions.map(definition => [definition.controls[0]!.id, { executable: process.execPath }])) }));
  return f;
}
const env = (f: Setup): NodeJS.ProcessEnv => ({ PATH: join(f.root, "empty-path"), HOME: f.home, TMPDIR: f.temporary, LANG: "C" });
const common = (f: Setup): string[] => ["--data-dir", f.data, "--workspace-lock-root", f.locks];
interface Ran { readonly code: number | null; readonly stdout: string; readonly stderr: string }
async function run(build: "old" | "new", f: Setup, script: string, args: readonly string[]): Promise<Ran> {
  const base = build === "old" ? join(oldBuild, "dist/src/cli") : join(repository, "dist/src/cli");
  const child = spawn(process.execPath, [join(base, script), ...args], { cwd: f.root, env: env(f), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; }); child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const [code] = await once(child, "close") as [number | null];
  clearTimeout(watchdog);
  return { code, stdout, stderr };
}
/** A new conversation with a Turn, made by `chat`; the id of the conversation. */
async function chat(build: "old" | "new", f: Setup, prompt: string): Promise<string> {
  const ran = await run(build, f, "chat.js", ["--allow-unofficial", ...common(f), "--cwd", f.workspace, "--manifest", f.manifest, "--path-only", "--json", "--harness", "session-a", "--prompt", prompt]);
  assert.equal(ran.code, 0, build + " chat: " + ran.stderr + ran.stdout);
  const made = ran.stdout.trim().split("\n").map(line => JSON.parse(line) as { type?: string; sessionId?: string }).find(entry => entry.type === "session");
  assert.ok(made?.sessionId !== undefined, "the conversation was made");
  assert.match(ran.stdout, /"type":"event"[^\n]*run\.ended/u, "and its Turn ended");
  return made.sessionId;
}
/** The web server of a build, started on the data root and stopped at once: the capability store and everything else a start opens. */
async function web(build: "old" | "new", f: Setup): Promise<Ran & { readonly url: string | null }> {
  const base = build === "old" ? join(oldBuild, "dist/src/cli") : join(repository, "dist/src/cli");
  const child = spawn(process.execPath, [join(base, "web.js"), "--allow-unofficial", ...common(f), "--cwd", f.workspace, "--manifest", f.manifest, "--path-only", "--port", "0", "--no-login-shell"], { cwd: f.root, env: env(f), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const started = new Promise<void>(resolve => { child.stdout.on("data", (chunk: string) => { stdout += chunk; if (/^http/mu.test(stdout)) resolve(); }); child.once("close", () => resolve()); });
  await started;
  const url = /^(http\S+)$/mu.exec(stdout)?.[1] ?? null;
  if (child.exitCode === null) child.kill("SIGTERM");
  const [code] = child.exitCode === null ? await once(child, "close") as [number | null] : [child.exitCode];
  clearTimeout(watchdog);
  return { code, stdout, stderr, url };
}
async function list(build: "old" | "new", f: Setup): Promise<readonly { readonly id: string }[]> {
  const ran = await run(build, f, "sessions.js", ["list", ...common(f), "--json"]);
  assert.equal(ran.code, 0, ran.stderr);
  const value = JSON.parse(ran.stdout) as unknown;
  return Array.isArray(value) ? value as { id: string }[] : (value as { sessions: { id: string }[] }).sessions ?? (value as { rows: { id: string }[] }).rows;
}
async function show(build: "old" | "new", f: Setup, id: string): Promise<unknown> {
  const ran = await run(build, f, "sessions.js", ["show", "--session", id, ...common(f), "--json"]);
  assert.equal(ran.code, 0, ran.stderr);
  return JSON.parse(ran.stdout) as unknown;
}
/** Every table of a library as sorted rows of JSON text, read as it is on disk with no log made. */
function dump(file: string): Record<string, readonly string[]> {
  const address = pathToFileURL(file); address.searchParams.set("mode", "ro"); address.searchParams.set("immutable", "1");
  const db = new DatabaseSync(address.href, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => [String(row.name), db.prepare('SELECT * FROM "' + String(row.name) + '"').all().map(entry => JSON.stringify(entry)).sort()]));
  } finally { db.close(); }
}
const withoutGeneration = (tables: Record<string, readonly string[]>): Record<string, readonly string[]> => ({ ...tables, owner_metadata: tables.owner_metadata!.map(row => row.replace(/"owner_generation":\d+/u, '"owner_generation":N')) });
const generationOf = (tables: Record<string, readonly string[]>): number => Number(/"owner_generation":(\d+)/u.exec(tables.owner_metadata![0]!)![1]);
const generationIn = (file: string, table: string): number => { const db = new DatabaseSync(file, { readOnly: true }); try { return Number(db.prepare("SELECT generation FROM " + table).get()!.generation); } finally { db.close(); } };

interface Upgraded { readonly f: Setup; readonly original: Record<string, readonly string[]>; readonly fixtureIds: readonly string[]; readonly snapshots: ReadonlyMap<string, unknown>; readonly made: readonly string[] }
/**
 * A v12 root: three fixture conversations and two the build before made itself (two chats, each with a Turn); its snapshots as that build says them. Then upgraded by the current
 * build, started three times (a chat, the web server, a chat), two conversations made. `fixtureIds` are the conversations of before the upgrade, whoever made them.
 */
async function upgraded(t: TestContext): Promise<Upgraded> {
  const f = setup(t);
  writeV12Root(f.data, [separate(loadV12Fixture("d1"), "one"), separate(loadV12Fixture("clear"), "two"), separate(loadV12Fixture("import"), "three")]);
  await chat("old", f, "before the upgrade, first"); await chat("old", f, "before the upgrade, second");
  const original = dump(join(f.data, "gateway.sqlite")), fixtureIds = (await list("old", f)).map(item => item.id), snapshots = new Map<string, unknown>();
  assert.equal(fixtureIds.length, 5);
  for (const id of fixtureIds) snapshots.set(id, await show("old", f, id));
  const made = [await chat("new", f, "after the upgrade, first")];
  const started = await web("new", f);
  assert.ok(started.url !== null, "the web server of the current build started: " + started.stderr);
  made.push(await chat("new", f, "after the upgrade, second"));
  return { f, original, fixtureIds, snapshots, made };
}

test("the way back, rehearsed: upgrade (started several times, a Turn in between), restore, and the build before takes the root over and lists what was there before the upgrade, to the word", { timeout: 240_000 }, async t => {
  const { f, original, fixtureIds, snapshots, made } = await upgraded(t);
  const library = join(f.data, "gateway.sqlite"), backup = join(f.data, "backups", "gateway-v12-before-v14.sqlite");
  const upgradedDump = dump(library), backupBytes = readFileSync(backup);
  const largest = generationOf(upgradedDump);
  assert.equal(generationIn(join(f.data, "management", "management.sqlite"), "management_owner"), largest);
  const capabilities = generationIn(join(f.data, "capabilities", "capabilities.sqlite"), "capability_owner");
  assert.ok(capabilities > generationOf(original) && capabilities < largest, "the web server opened the capability store at the generation of its start, and a start since went on");
  assert.ok(largest >= generationOf(original) + 3, "the generation went up with each start");
  assert.deepEqual((await list("new", f)).map(item => item.id).sort(), [...fixtureIds, ...made].sort(), "the upgraded library holds the conversations of the fixtures and the two made since");

  // The old steps by hand — the backup over the library, the log deleted — on a copy of the root: the build before refuses to start.
  const manual = setup(t); cpSync(f.data, manual.data, { recursive: true });
  cpSync(join(manual.data, "backups", "gateway-v12-before-v14.sqlite"), join(manual.data, "gateway.sqlite"));
  for (const side of ["-wal", "-shm"]) rmSync(join(manual.data, "gateway.sqlite" + side), { force: true });
  const refused = await run("old", manual, "chat.js", ["--allow-unofficial", ...common(manual), "--cwd", manual.workspace, "--manifest", manual.manifest, "--path-only", "--json", "--harness", "session-a", "--prompt", "by hand"]);
  assert.notEqual(refused.code, 0, "the build before refuses a library put back by hand: " + refused.stdout + refused.stderr);
  assert.match(refused.stderr + refused.stdout, /management owner generation is stale/u, "because the management library remembers a generation the copy does not");
  const refusedWeb = await web("old", manual);
  assert.equal(refusedWeb.url, null, "and so does its web server");

  // The command.
  const restored = await run("new", f, "sessions.js", ["restore-backup", ...common(f)]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /Restored the library of version 12 from backups\/gateway-v12-before-v14\.sqlite/u);
  assert.match(restored.stdout, /Start it with a build that reads library version 12/u);
  assert.ok(!restored.stdout.includes(f.root) && !restored.stdout.includes("after the upgrade"), "no path, no word of a conversation");
  assert.deepEqual(withoutGeneration(dump(library)), withoutGeneration(original), "the library is the one before the upgrade, row for row, but for its owner generation");
  assert.equal(generationOf(dump(library)), largest);
  assert.deepEqual(readFileSync(backup), backupBytes, "the backup is where it was, the very bytes");
  const kept = readdirSync(join(f.data, "backups")).filter(name => /^gateway-v14-set-aside-/u.test(name));
  assert.equal(kept.length, 1);
  assert.deepEqual(dump(join(f.data, "backups", kept[0]!)), upgradedDump, "the version 14 library is kept whole");

  // The build before takes it over: the conversations are the ones that were there, word for word; its commands work; a Turn goes through; its web server starts.
  const listed = await list("old", f);
  assert.deepEqual(listed.map(item => item.id).sort(), [...fixtureIds].sort(), "exactly the conversations of before the upgrade");
  for (const id of fixtureIds) assert.equal(canonicalJson(await show("old", f, id)), canonicalJson(snapshots.get(id)), id + " reads as it was before the upgrade, as the build before said it then");
  const next = await chat("old", f, "after the rollback");
  // And it goes on in a conversation it had before the upgrade (one of those it made itself): one more Turn.
  const continuing = fixtureIds.find(id => !/^session-1-/u.test(id))!, runsBefore = (snapshots.get(continuing) as { runs: unknown[] }).runs.length;
  const goneOn = await run("old", f, "chat.js", ["--allow-unofficial", ...common(f), "--session", continuing, "--prompt", "after the rollback, in a conversation of before", "--json"]);
  assert.equal(goneOn.code, 0, goneOn.stderr + goneOn.stdout); assert.match(goneOn.stdout, /"type":"event"[^\n]*run\.ended/u);
  assert.equal(((await show("old", f, continuing)) as { runs: unknown[] }).runs.length, runsBefore + 1, "one Turn more");
  const started = await web("old", f);
  assert.ok(started.url !== null, "the web server of the build before started: " + started.stderr);
  assert.deepEqual((await list("old", f)).map(item => item.id).sort(), [...fixtureIds, next].sort(), "and it keeps what it makes");

  // The current build upgrades it again, as it did: a backup, the upgrade; the first backup and the kept library are not lost on the way.
  const before = readdirSync(join(f.data, "backups")).sort();
  const again = await chat("new", f, "upgrade again");
  const names = readdirSync(join(f.data, "backups")).sort();
  assert.ok(before.every(name => names.includes(name) || /^gateway-v12-before-v14\.sqlite$/u.test(name)), "nothing that was kept is gone");
  const earlier = names.filter(name => /^gateway-v12-before-v14-earlier-\d{8}T\d{6}Z\.sqlite$/u.test(name));
  assert.equal(earlier.length, 1, "the first backup was not replaced: " + names.join(", "));
  assert.deepEqual(readFileSync(join(f.data, "backups", earlier[0]!)), backupBytes, "it is the very bytes it was");
  assert.deepEqual(dump(join(f.data, "backups", kept[0]!)), upgradedDump, "and the kept version 14 library is untouched");
  assert.deepEqual((await list("new", f)).map(item => item.id).sort(), [...fixtureIds, next, again].sort(), "the current build has the conversations of the restored root and what the build before made");
  assert.equal(readFileSync(library).readUInt32BE(60), 14);
});

test("the restore run on a root the upgrade was started on only once, and on one where a Turn was made by the build before and the root was upgraded again and put back again", { timeout: 240_000 }, async t => {
  const f = setup(t);
  writeV12Root(f.data, [separate(loadV12Fixture("d1"), "one")]);
  const library = join(f.data, "gateway.sqlite");
  const originalIds = (await list("old", f)).map(item => item.id).sort();
  // Once: the generations happen to be equal and the hand-made restore works — the case that hid the defect — and the command works as well.
  await chat("new", f, "once");
  const first = await run("new", f, "sessions.js", ["restore-backup", ...common(f)]);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual((await list("old", f)).map(item => item.id).sort(), originalIds);
  // The old build makes a conversation, the current one upgrades again and goes on, and the restore is asked again: the backup it finds is the one of the second upgrade (the first is kept beside it).
  const oldMade = await chat("old", f, "made by the build before");
  await chat("new", f, "twice"); await web("new", f); await chat("new", f, "thrice");
  const second = await run("new", f, "sessions.js", ["restore-backup", ...common(f)]);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual((await list("old", f)).map(item => item.id).sort(), [...originalIds, oldMade].sort(), "what the build before made is there: the second backup holds it");
  assert.equal(readFileSync(library).readUInt32BE(60), 12);
  const names = readdirSync(join(f.data, "backups")).sort();
  assert.equal(names.filter(name => /set-aside/u.test(name)).length, 2, "two libraries of version 14 are kept: " + names.join(", "));
  assert.equal(names.filter(name => /earlier/u.test(name)).length, 1);
});

test("killed at each phase of the restore and run again by the command, the build before takes the root over as it does after an uninterrupted restore", { timeout: 400_000 }, async t => {
  const { f, fixtureIds, snapshots, made } = await upgraded(t);
  void made;
  const library = join(f.data, "gateway.sqlite");
  for (let phase = 1; phase <= 9; phase++) {
    const copy = setup(t); cpSync(f.data, copy.data, { recursive: true });
    const child = spawn(process.execPath, [restorePeer, copy.data, "--kill-at", String(phase), "--now", FIXED.toISOString()], { stdio: ["ignore", "ignore", "inherit"] });
    const [, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(signal, "SIGKILL", "phase " + phase);
    const rerun = await run("new", copy, "sessions.js", ["restore-backup", ...common(copy)]);
    assert.equal(rerun.code, 0, "phase " + phase + ": " + rerun.stderr);
    assert.match(rerun.stdout, phase >= 8 ? /Nothing to restore: the library is version 12, not 14/u : /Restored the library of version 12/u, "phase " + phase);
    assert.deepEqual((await list("old", copy)).map(item => item.id).sort(), [...fixtureIds].sort(), "phase " + phase + ": the conversations of before the upgrade");
    for (const id of fixtureIds.slice(0, 1)) assert.equal(canonicalJson(await show("old", copy, id)), canonicalJson(snapshots.get(id)), "phase " + phase + ": " + id);
    await chat("old", copy, "after the rollback, phase " + phase);
    assert.equal(readFileSync(join(copy.data, "gateway.sqlite")).readUInt32BE(60), 12);
    assert.equal(readdirSync(join(copy.data, "backups")).filter(name => /set-aside/u.test(name)).length, 1, "phase " + phase + ": one kept library");
  }
  void library; void renameSync; void treeDigest; void V12_FIXTURES;
});
