import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { application } from "../../src/cli/session-application.js";
import { resolveHostBudgets } from "../../src/contracts/native-host.js";
import type { SessionConfiguration, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { HostTmpdirs, measureTree } from "../../src/infrastructure/session/host-tmpdir.js";
import { oldShape } from "../fixtures/old-shape.js";

// Each host class's private TMPDIR (ADR-056 §4.12; G085-C03, G085-C04), through the formal composition: application(), a
// real store and workspace leases, and an ACP peer that records the TMPDIR it was given and what it held at its start.
// Other Gateways sharing the namespace are played by child processes running the same compiled module.

const budgets = resolveHostBudgets({ physicalMemoryBytes: totalmem() });
const MIB = 1024 * 1024, DAY = 24 * 60 * 60_000;
const MODULE = fileURLToPath(new URL("../../src/infrastructure/session/host-tmpdir.js", import.meta.url));
/** A credential in the launch environment, as a passed-through provider key would be. */
const SECRET = "fixture-key-host-tmpdir-0f9e8d7c6b5a49382716";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const limits = (report: (problem: string) => void = () => {}) => ({ maxBytes: budgets.hostTmpdirMaxBytes, maxEntries: budgets.hostTmpdirMaxEntries, unusedMs: budgets.hostTmpdirUnusedMs, report });
const PEER = `import { appendFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
const native = "native-" + process.pid, send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
appendFileSync(process.env.PEER_TRACE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), tmpdir: process.env.TMPDIR, entries: readdirSync(process.env.TMPDIR).sort() }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: "host-peer", version: "1.0" } } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: native } });
  else if (m.method === "session/resume") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`;
interface Spawn { readonly pid: number; readonly cwd: string; readonly tmpdir: string; readonly entries: readonly string[] }
interface Fixture {
  readonly root: string; readonly data: string; readonly locks: string; readonly peer: string; readonly trace: string; readonly manifest: string;
  /** Composes the application (a Hub start) on the fixture's data and lock roots unless others are given. */
  start(locks?: string, data?: string): ReturnType<typeof application>;
  /** Closes an application before the test ends. */
  stop(app: ReturnType<typeof application>): Promise<void>;
  configuration(name: string): Promise<SessionConfiguration>;
  spawns(): Promise<readonly Spawn[]>;
}
async function closeApplication(app: ReturnType<typeof application>): Promise<void> { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); app.store.close(); }
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-"))), peer = join(root, "peer.mjs"), trace = join(root, "trace.ndjson"), manifest = join(root, "catalog.json");
  const apps: ReturnType<typeof application>[] = [];
  t.after(async () => {
    for (const app of apps.splice(0)) await closeApplication(app);
    // Directories a test locked are opened again so they can go.
    for (const entry of await readdir(root, { recursive: true }).catch(() => [])) { try { if ((await lstat(join(root, entry))).isDirectory()) await chmod(join(root, entry), 0o700); } catch { /* gone */ } }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(peer, PEER);
  const definition = { id: "host-peer", name: "Host peer", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "host-peer-acp", protocol: "acp-v1", executableNames: ["host-peer"],
    args: [peer], env: { PEER_TRACE: trace, FIXTURE_API_KEY: SECRET }, requiredExecutables: [], package: null, distribution: null,
    source: { repository: "fixture", revision: "tmpdir", upstreamId: "host-peer", url: "https://example.invalid/host-peer" } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { "host-peer-acp": { executable: process.execPath } } }));
  const data = join(root, "data"), locks = join(root, "locks");
  return { root, data, locks, peer, trace, manifest,
    start: (lockRoot = locks, dataRoot = data) => { const app = application(dataRoot, () => {}, { installations: "any", workspaceLockRoot: lockRoot }); apps.push(app); return app; },
    stop: async app => { const index = apps.indexOf(app); if (index >= 0) { apps.splice(index, 1); await closeApplication(app); } },
    configuration: async name => { const workspace = join(root, name); await mkdir(workspace, { recursive: true }); return prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }); },
    spawns: async () => { try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Spawn); } catch { return []; } } };
}
async function turn(app: ReturnType<typeof application>, session: SessionId, text: string) {
  app.runtime.send(session, text, "send-" + text.replace(/[^a-z0-9]+/giu, "-")); await app.runtime.wait(session);
  return oldShape(app.runtime, session).runs.at(-1)!;
}
/** Writes `bytes` of real data, so the file takes that much on disk. */
async function fill(path: string, bytes: number): Promise<void> {
  const handle = await open(path, "w"), chunk = Buffer.alloc(8 * MIB, 1);
  try { for (let written = 0; written < bytes; written += chunk.length) await handle.write(chunk, 0, Math.min(chunk.length, bytes - written)); } finally { await handle.close(); }
}
function apart(path: string, other: string): boolean { return path !== other && !path.startsWith(other + "/") && !other.startsWith(path + "/"); }
/** Waits until nothing moved aside is left in the namespace (it is removed in the background). */
async function swept(namespace: string): Promise<void> {
  for (let i = 0; i < 250 && (await readdir(namespace)).some(name => name.endsWith(".trash")); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual((await readdir(namespace)).filter(name => name.endsWith(".trash")), [], "what was moved aside is gone");
}
/** Another Gateway: a child process running `code` with HostTmpdirs (the compiled module) in scope; resolves with its output. */
function gateway(code: string, onLine?: (line: string) => void): Promise<string> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import { HostTmpdirs } from " + JSON.stringify(MODULE) + ";\n" + code], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; for (const line of chunk.split("\n").filter(Boolean)) onLine?.(line); });
  return once(child, "close").then(([code]) => { assert.equal(code, 0, "the other Gateway failed"); return output.trim(); });
}

test("G085-C03 hosts of one Harness in two workspaces get one private directory each; a second host of a class reuses its own, with what the first left there", async t => {
  const f = await fixture(t), app = f.start();
  const a = await app.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create-a"), b = await app.runtime.create(await f.configuration("ws-b"), { harnessId: "host-peer" }, "create-b");
  assert.equal((await turn(app, a.id, "first in a")).status, "completed"); assert.equal((await turn(app, b.id, "first in b")).status, "completed");
  const [inA, inB] = await f.spawns();
  assert.ok(inA && inB); assert.notEqual(inA.tmpdir, inB.tmpdir, "workspaces never share");
  const namespace = await realpath(join(f.locks, "hosts")), data = await realpath(f.data);
  for (const spawned of [inA, inB]) {
    assert.equal(dirname(spawned.tmpdir), namespace); assert.match(basename(spawned.tmpdir), /^[0-9a-f]{16}$/u);
    const info = await lstat(spawned.tmpdir);
    assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, process.getuid!());
    assert.ok(apart(spawned.tmpdir, data), "the TMPDIR and the data directory contain neither one another");
    assert.deepEqual(spawned.entries, [], "a new class starts empty");
  }
  assert.ok(apart(namespace, data));
  // What a host of the class left stays for the next one: the same conversation's next Turn, and another conversation's.
  await writeFile(join(inA.tmpdir, "compile-cache"), "kept");
  const again = await app.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create-a-again");
  assert.equal((await turn(app, a.id, "second in a")).status, "completed"); assert.equal((await turn(app, again.id, "other conversation in a")).status, "completed");
  const later = (await f.spawns()).slice(2);
  assert.deepEqual(later.map(spawned => [spawned.tmpdir, spawned.entries]), [[inA.tmpdir, ["compile-cache"]], [inA.tmpdir, ["compile-cache"]]]);
  assert.deepEqual(await readdir(inB.tmpdir), [], "the other workspace's directory is its own");
});

test("G085-C03 a class directory made a symbolic link, opened to others or unwritable fails the Turn with HOST_TMPDIR_FAILED before any program starts; the link is not followed and nothing is repaired", async t => {
  const f = await fixture(t), app = f.start();
  const session = await app.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create");
  assert.equal((await turn(app, session.id, "first")).status, "completed");
  const directory = (await f.spawns())[0]!.tmpdir, canary = join(f.root, "elsewhere");
  // Private and the user's own, so only its being a link can refuse it.
  await mkdir(canary, { mode: 0o700 }); await writeFile(join(canary, "keep"), "not the Hub's");
  const refused = async (label: string) => {
    const before = (await f.spawns()).length, run = await turn(app, session.id, label);
    assert.equal(run.status, "failed", label); assert.equal(run.error?.code, "HOST_TMPDIR_FAILED", label);
    assert.equal((await f.spawns()).length, before, label + ": no program was started");
    assert.equal(oldShape(app.runtime, session.id).status, "open", label + ": the conversation goes on");
  };
  await rm(directory, { recursive: true }); await symlink(canary, directory);
  await refused("through a link");
  assert.ok((await lstat(directory)).isSymbolicLink(), "the link is left as it was"); assert.deepEqual(await readdir(canary), ["keep"], "nothing was written through it");
  // Once the user removes it, the workspace lease was released: the next Turn runs with a new private directory.
  await rm(directory);
  assert.equal((await turn(app, session.id, "after the link")).status, "completed");
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const [mode, label] of [[0o755, "opened to others"], [0o500, "unwritable"]] as const) {
    await chmod(directory, mode);
    await refused(label);
    assert.equal((await lstat(directory)).mode & 0o777, mode, label + ": the mode is left as it was");
    await chmod(directory, 0o700);
    assert.equal((await turn(app, session.id, "after " + label)).status, "completed", label);
  }
});

test("G085-C03 a namespace that cannot be created, or that lies in the data directory, fails the Turn with HOST_TMPDIR_FAILED and creates nothing", async t => {
  const f = await fixture(t);
  // A plain file where the namespace would be.
  await mkdir(join(f.root, "file-locks"), { mode: 0o700 }); await writeFile(join(f.root, "file-locks", "hosts"), "not a directory");
  const blocked = f.start(join(f.root, "file-locks")), one = await blocked.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create-blocked");
  const run = await turn(blocked, one.id, "cannot create");
  assert.equal(run.status, "failed"); assert.equal(run.error?.code, "HOST_TMPDIR_FAILED"); assert.equal(await readFile(join(f.root, "file-locks", "hosts"), "utf8"), "not a directory");
  // A lock root inside the data directory would put every TMPDIR there: refused, before anything is created.
  const data = join(f.root, "other-data"), inside = f.start(join(data, "locks"), data), two = await inside.runtime.create(await f.configuration("ws-b"), { harnessId: "host-peer" }, "create-inside");
  const refused = await turn(inside, two.id, "inside the data");
  assert.equal(refused.status, "failed"); assert.equal(refused.error?.code, "HOST_TMPDIR_FAILED");
  await assert.rejects(stat(join(data, "locks", "hosts")), "nothing was created in the data directory");
  assert.deepEqual(await f.spawns(), []);
  // A namespace whose parent is gone fails the Turns that need it, never the Hub's start: nothing is read before first use.
  const unreachable = new HostTmpdirs(join(f.root, "gone", "hosts"), limits());
  assert.equal(unreachable.sweep(), 0);
  await assert.rejects(unreachable.acquire({ launch: "a".repeat(64), installation: "b".repeat(64) }), (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "HOST_TMPDIR_FAILED");
  await assert.rejects(stat(join(f.root, "gone")));
  // And a namespace holding the data directory, with the data directory deep inside it.
  const holding = new HostTmpdirs(join(f.root, "around"), { ...limits(), dataRoot: join(f.root, "around", "x", "data") });
  await mkdir(join(f.root, "around", "x", "data"), { recursive: true, mode: 0o700 });
  await assert.rejects(holding.acquire({ launch: "a".repeat(64), installation: "b".repeat(64) }), (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "HOST_TMPDIR_FAILED");
});

test("G085-C04 after an upgrade (the entry's files change) the class directory is emptied before its next host starts in it", async t => {
  const f = await fixture(t), app = f.start();
  const session = await app.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create");
  assert.equal((await turn(app, session.id, "old version")).status, "completed");
  const directory = (await f.spawns())[0]!.tmpdir;
  await writeFile(join(directory, "cache-of-the-old-version"), "stale"); await mkdir(join(directory, "extracted")); await writeFile(join(directory, "extracted", "lib.dylib"), "stale");
  assert.equal((await turn(app, session.id, "same version")).status, "completed");
  assert.deepEqual((await f.spawns())[1]!.entries, ["cache-of-the-old-version", "extracted"], "without an upgrade the cache stays");
  // The same entry, upgraded in place: its file has another identity.
  await writeFile(f.peer, PEER + "// upgraded\n");
  assert.equal((await turn(app, session.id, "new version")).status, "completed");
  const upgraded = (await f.spawns())[2]!;
  assert.equal(upgraded.tmpdir, directory, "the same directory"); assert.deepEqual(upgraded.entries, [], "emptied before the new version ran in it");
});

test("G085-C04 at the Hub's start, class directories unused for seven days are deleted with their records; recent ones and what is not a class directory stay", async t => {
  const f = await fixture(t), first = f.start();
  const a = await first.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create-a"), b = await first.runtime.create(await f.configuration("ws-b"), { harnessId: "host-peer" }, "create-b");
  await turn(first, a.id, "in a"); await turn(first, b.id, "in b");
  await f.stop(first);
  const [inA, inB] = await f.spawns(), namespace = dirname(inA!.tmpdir), stale = new Date(Date.now() - budgets.hostTmpdirUnusedMs - DAY), recent = new Date(Date.now() - budgets.hostTmpdirUnusedMs + DAY);
  for (const [path, time] of [[inA!.tmpdir, stale], [inA!.tmpdir + ".json", stale], [inB!.tmpdir, recent], [inB!.tmpdir + ".json", recent]] as const) await utimes(path, time, time);
  await writeFile(join(namespace, "notes.txt"), "not a class directory"); await utimes(join(namespace, "notes.txt"), stale, stale);
  await writeFile(join(namespace, "0123456789abcdef.json"), "{}"); await utimes(join(namespace, "0123456789abcdef.json"), stale, stale);
  f.start();
  await swept(namespace);
  const left = (await readdir(namespace)).sort();
  assert.deepEqual(left, [".key", ".lock.sqlite", basename(inB!.tmpdir), basename(inB!.tmpdir) + ".json", "notes.txt"].sort(), "the stale class and a record without a directory went");
});

test("G085-C04 over 256 MiB, a class directory is emptied only once no host of its class holds it, by moving it aside; what cannot be removed is reported and does not fail the release", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-size-")));
  t.after(async () => { for (const entry of await readdir(root, { recursive: true }).catch(() => [])) await chmod(join(root, entry), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  assert.equal(budgets.hostTmpdirMaxBytes, 256 * MIB);
  const reports: string[] = [], tmpdirs = new HostTmpdirs(join(root, "hosts"), limits(problem => { reports.push(problem); }));
  const identity = { launch: "class c", installation: "installation d" };
  const first = await tmpdirs.acquire(identity), second = await tmpdirs.acquire(identity), name = basename(first.path);
  assert.equal(first.path, second.path);
  await fill(join(first.path, "big.bin"), 257 * MIB);
  await first.release();
  assert.equal((await stat(join(first.path, "big.bin"))).size, 257 * MIB, "another host of the class still holds it");
  await second.release(); await second.release();
  await assert.rejects(stat(first.path), "moved aside once no host holds it");
  await tmpdirs.settle(); await swept(join(root, "hosts")); assert.equal(reports.length, 0, "nothing to report");
  // The next host gets an empty directory in its place; below the limit nothing is emptied.
  const small = await tmpdirs.acquire(identity);
  assert.equal(small.path, first.path); assert.deepEqual(await readdir(small.path), []);
  await fill(join(small.path, "small.bin"), 8 * MIB); await small.release();
  assert.deepEqual(await readdir(small.path), ["small.bin"]);
  // An entry that cannot be removed is reported (the directory's name and the system's code, no path) and left aside.
  const third = await tmpdirs.acquire(identity);
  await fill(join(third.path, "big.bin"), 257 * MIB); await mkdir(join(third.path, "locked")); await writeFile(join(third.path, "locked", "inner"), "x"); await chmod(join(third.path, "locked"), 0o500);
  await third.release();
  await assert.rejects(stat(third.path), "the release itself only moved it aside");
  await tmpdirs.settle();
  assert.deepEqual(reports, [name + ": what it held could not all be removed (EACCES)"]); assert.equal(reports[0]!.includes(root), false);
  const left = (await readdir(join(root, "hosts"))).filter(entry => entry.endsWith(".trash"));
  assert.equal(left.length, 1); assert.deepEqual(await readdir(join(root, "hosts", left[0]!)), ["locked"]);
});

test("G085-C04 a directory of many entries: the count stops at the entry limit, so the release stays short, and such a directory is moved aside too", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-entries-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(budgets.hostTmpdirMaxEntries, 4_096);
  const tmpdirs = new HostTmpdirs(join(root, "hosts"), limits()), identity = { launch: "class e", installation: "installation f" };
  // Empty directories, as a program that leaves some at every start accumulates: no bytes, but entries.
  const timed = async (count: number) => {
    const held = await tmpdirs.acquire(identity);
    for (let made = 0; made < count; made++) await mkdir(join(held.path, ".tmp" + made.toString(36).padStart(6, "0")));
    const started = performance.now(); await held.release();
    return { path: held.path, ms: performance.now() - started };
  };
  const under = await timed(3_000);
  assert.equal((await readdir(under.path)).length, 3_000, "under the limit it stays"); assert.ok(under.ms < 1_000, "3,000 entries took " + Math.round(under.ms) + " ms");
  await rm(under.path, { recursive: true }); await tmpdirs.settle();
  const over = await timed(12_000);
  await assert.rejects(stat(over.path), "over the limit it is moved aside");
  assert.ok(over.ms < 250, "12,000 entries took " + Math.round(over.ms) + " ms: only the first 4,097 are read");
  await tmpdirs.settle(); await swept(join(root, "hosts"));
  const next = await tmpdirs.acquire(identity);
  assert.deepEqual(await readdir(next.path), []); await next.release();
});

test("G085-C04 a kept host holds its class directory: over 256 MiB it is not emptied while it lives, only once it closes, and the next Turn is not affected by what could not be removed", async t => {
  const f = await fixture(t), app = f.start();
  const session = await app.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create");
  app.runtime.setRetention(session.id, true, "keep");
  assert.equal((await turn(app, session.id, "kept")).status, "completed");
  assert.notEqual(oldShape(app.runtime, session.id).retained, undefined, "the host is kept");
  const directory = (await f.spawns())[0]!.tmpdir;
  await fill(join(directory, "big.bin"), 257 * MIB); await mkdir(join(directory, "locked")); await writeFile(join(directory, "locked", "inner"), "x"); await chmod(join(directory, "locked"), 0o500);
  const reused = await turn(app, session.id, "reused");
  assert.equal(reused.status, "completed"); assert.equal(reused.reused, true);
  assert.equal((await stat(join(directory, "big.bin"))).size, 257 * MIB, "not emptied while its host lives");
  await app.runtime.endKept(session.id, "end");
  const closed = app.store.events(session.id, 0).filter(event => event.type === "native.process_closed").map(event => event.data as { reason: string; cleanup: { closed: boolean } | null; error?: unknown });
  assert.deepEqual(closed.map(row => [row.reason, row.cleanup?.closed, row.error]), [["ended_by_user", true, undefined]], "the close succeeded although an entry could not be removed");
  await assert.rejects(stat(directory), "moved aside once its host closed");
  const next = await turn(app, session.id, "after the close");
  assert.equal(next.status, "completed");
  assert.deepEqual((await f.spawns()).at(-1), { ...(await f.spawns()).at(-1)!, tmpdir: directory, entries: [] }, "the next Turn starts in an empty directory at the same place");
});

test("G085-C04 a sweep never meets a live host: one held in another process keeps its directory however old, and a host being prepared waits for a sweep that holds the namespace", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-lock-"))), namespace = join(root, "hosts");
  t.after(() => rm(root, { recursive: true, force: true }));
  const tmpdirs = new HostTmpdirs(namespace, limits()), identity = { launch: "class g", installation: "installation h" };
  const options = "{ maxBytes: " + budgets.hostTmpdirMaxBytes + ", maxEntries: " + budgets.hostTmpdirMaxEntries + ", unusedMs: " + budgets.hostTmpdirUnusedMs + ", report: () => {} }";
  const sweepElsewhere = () => gateway("const tmpdirs = new HostTmpdirs(" + JSON.stringify(namespace) + ", " + options + "); const count = tmpdirs.sweep(); await tmpdirs.settle(); console.log(count);");
  const age = async (path: string) => { const stale = new Date(Date.now() - budgets.hostTmpdirUnusedMs - DAY); await utimes(path, stale, stale); await utimes(path + ".json", stale, stale); };
  // A host that lives for over a week (a kept process): another Gateway's start sweeps nothing while it lives.
  const held = await tmpdirs.acquire(identity);
  await age(held.path);
  assert.equal(await sweepElsewhere(), "0");
  assert.ok((await stat(held.path)).isDirectory(), "its directory stays");
  await held.release();
  await age(held.path);
  assert.equal(await sweepElsewhere(), "1", "once it is gone, the old directory goes");
  await assert.rejects(stat(held.path));
  // Another Gateway holds the namespace for its sweep: a host's preparation here waits until it is done.
  const lock = join(namespace, ".lock.sqlite");
  let ready: () => void = () => {};
  const holding = new Promise<void>(resolve => { ready = resolve; });
  const other = gateway("const { DatabaseSync } = await import('node:sqlite'); const lock = new DatabaseSync(" + JSON.stringify(lock) + ", { timeout: 0 }); lock.exec('BEGIN EXCLUSIVE'); console.log('held');" +
    " await new Promise(resolve => setTimeout(resolve, 600)); lock.exec('COMMIT'); lock.close(); console.log('let go');", line => { if (line === "held") ready(); });
  await holding;
  const started = performance.now(), waited = await tmpdirs.acquire(identity), took = performance.now() - started;
  assert.ok(took >= 400, "the preparation waited " + Math.round(took) + " ms for the sweep");
  assert.deepEqual(await readdir(waited.path), []); await waited.release();
  assert.equal(await other, "held\nlet go");
});

test("G085-C04 class directories and their records carry HMACs under the namespace's own key: a credential of the launch environment, and its sha256, appear in neither", async t => {
  const f = await fixture(t), app = f.start();
  const session = await app.runtime.create(await f.configuration("ws-a"), { harnessId: "host-peer" }, "create");
  assert.equal((await turn(app, session.id, "first")).status, "completed");
  const directory = (await f.spawns())[0]!.tmpdir, namespace = dirname(directory), record = await readFile(directory + ".json", "utf8");
  const visible = [...await readdir(namespace), record].join("\n");
  for (const forbidden of [SECRET, sha256(SECRET), sha256(SECRET).slice(0, 16)]) assert.equal(visible.includes(forbidden), false, "found " + forbidden.slice(0, 8));
  assert.match(record, /^\{"version":1,"launch":"[0-9a-f]{64}","installation":"[0-9a-f]{64}"\}\n$/u);
  assert.equal(JSON.parse(record).launch.slice(0, 16), basename(directory), "the directory is named by the launch HMAC");
  const key = await lstat(join(namespace, ".key"));
  assert.ok(key.isFile()); assert.equal(key.mode & 0o777, 0o600); assert.equal(key.size, 32);
  // The same identity under two keys names two directories, neither of them its plain sha256.
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-keys-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { launch: JSON.stringify({ environment: [["OPENAI_API_KEY", SECRET]] }), installation: "installation" };
  const one = await new HostTmpdirs(join(root, "one"), limits()).acquire(identity), two = await new HostTmpdirs(join(root, "two"), limits()).acquire(identity);
  assert.notEqual(basename(one.path), basename(two.path));
  for (const held of [one, two]) {
    assert.notEqual(basename(held.path), sha256(identity.launch).slice(0, 16));
    const written = await readFile(held.path + ".json", "utf8");
    for (const forbidden of [sha256(identity.launch), sha256(identity.installation), SECRET]) assert.equal(written.includes(forbidden), false);
    await held.release();
  }
});

test("G085-C04 a Turn whose namespace a sweep holds past the 2 s wait fails with HOST_TMPDIR_BUSY, its own reason, before any program starts; the service goes on meanwhile and the next Turn runs", async t => {
  const f = await fixture(t), app = f.start(), namespace = join(f.locks, "hosts");
  const session = await app.runtime.create(await f.configuration("ws-busy"), { harnessId: "host-peer" }, "create");
  assert.equal((await turn(app, session.id, "first")).status, "completed");
  // Another Gateway's start sweeps the namespace and holds it for 2.6 s.
  let ready: () => void = () => {};
  const holding = new Promise<void>(resolve => { ready = resolve; });
  const other = gateway("const { DatabaseSync } = await import('node:sqlite'); const lock = new DatabaseSync(" + JSON.stringify(join(namespace, ".lock.sqlite")) + ", { timeout: 0 }); lock.exec('BEGIN EXCLUSIVE'); console.log('held');" +
    " await new Promise(resolve => setTimeout(resolve, 2600)); lock.exec('COMMIT'); lock.close(); console.log('let go');", line => { if (line === "held") ready(); });
  await holding;
  let pause = 0, last = performance.now();
  const ticking = setInterval(() => { const now = performance.now(); pause = Math.max(pause, now - last); last = now; }, 10);
  const started = performance.now(), refused = await turn(app, session.id, "second"), took = performance.now() - started;
  clearInterval(ticking);
  assert.equal(refused.status, "failed"); assert.equal(refused.error?.code, "HOST_TMPDIR_BUSY");
  assert.ok(refused.error!.message.includes("清扫") && !refused.error!.message.includes("符号链接"), "it says a sweep held it, not that the directory is wrong: " + refused.error!.message);
  assert.ok(took >= 1_900, "it waited " + Math.round(took) + " ms for the sweep");
  assert.ok(pause < 500, "the event loop went on while it waited: its longest pause was " + Math.round(pause) + " ms");
  assert.equal((await f.spawns()).length, 1, "no program started for the refused Turn");
  assert.equal(await other, "held\nlet go");
  assert.equal((await turn(app, session.id, "third")).status, "completed", "once the sweep let go, the next Turn runs");
});

test("G085-C04 a sweep changes at most 256 entries and leaves the rest for the next start, so it holds the namespace only briefly", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-cap-"))), namespace = join(root, "hosts");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(namespace, { mode: 0o700 });
  const stale = new Date(Date.now() - budgets.hostTmpdirUnusedMs - DAY);
  for (let index = 0; index < 300; index++) {
    const directory = join(namespace, index.toString(16).padStart(16, "0"));
    await mkdir(directory, { mode: 0o700 }); await writeFile(directory + ".json", "{}", { mode: 0o600 });
    await utimes(directory, stale, stale); await utimes(directory + ".json", stale, stale);
  }
  const classes = async () => (await readdir(namespace)).filter(name => /^[0-9a-f]{16}$/u.test(name)).length;
  const reports: string[] = [], first = new HostTmpdirs(namespace, limits(problem => { reports.push(problem); }));
  assert.equal(first.sweep(), 256);
  assert.equal(await classes(), 44, "the rest waits");
  assert.deepEqual(reports, ["namespace: the sweep stopped after 256 changes; the rest waits for the next start"]);
  await first.settle(); await swept(namespace);
  const next = new HostTmpdirs(namespace, limits(problem => { reports.push(problem); }));
  assert.equal(next.sweep(), 44, "the next start sweeps the rest");
  await next.settle(); await swept(namespace);
  assert.equal(await classes(), 0); assert.equal(reports.length, 1, "records swept with their directories are no problem");
});

test("G085-C04 at a service's end the removal of what was moved aside gets closeWaitMs; then it stops, says what is left, and the next start's sweep finishes it", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-close-"))), namespace = join(root, "hosts");
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(budgets.hostTmpdirCloseWaitMs, 5_000);
  const reports: string[] = [], identity = { launch: "class i", installation: "installation j" };
  // Over a small entry limit, the release moves the directory aside; removing its 6,000 files takes far longer than 1 ms.
  const tmpdirs = new HostTmpdirs(namespace, { ...limits(problem => { reports.push(problem); }), maxEntries: 256, closeWaitMs: 1 });
  const held = await tmpdirs.acquire(identity);
  for (let index = 0; index < 20; index++) { const directory = join(held.path, "d" + index); await mkdir(directory); for (let file = 0; file < 300; file++) await writeFile(join(directory, "f" + file), ""); }
  await held.release();
  const started = performance.now(); await tmpdirs.close(); const took = performance.now() - started;
  assert.ok(took < 250, "the close took " + Math.round(took) + " ms");
  assert.deepEqual(reports, ["namespace: 1 moved aside left for the next start's sweep"]);
  assert.equal((await readdir(namespace)).filter(name => name.endsWith(".trash")).length, 1, "what is left stays aside");
  await tmpdirs.close(); assert.equal(reports.length, 1, "a second close is the first");
  const next = new HostTmpdirs(namespace, limits());
  next.sweep(); await next.settle(); await swept(namespace);
});

test("G085-C04 the runtime's close waits, within the bound, for what its Turns moved aside to be removed", async t => {
  const f = await fixture(t), app = f.start(), namespace = join(f.locks, "hosts");
  const session = await app.runtime.create(await f.configuration("ws-close"), { harnessId: "host-peer" }, "create");
  assert.equal((await turn(app, session.id, "first")).status, "completed");
  // Over the entry limit (5,010 entries): the next Turn's close moves the directory aside, to be removed in the background.
  const directory = (await f.spawns())[0]!.tmpdir;
  for (let index = 0; index < 10; index++) { await mkdir(join(directory, "d" + index)); for (let file = 0; file < 500; file++) await writeFile(join(directory, "d" + index, "f" + file), ""); }
  assert.equal((await turn(app, session.id, "second")).status, "completed");
  assert.equal((await readdir(namespace)).filter(name => name.endsWith(".trash")).length, 1, "still being removed when the Turn ended");
  await f.stop(app);
  assert.deepEqual((await readdir(namespace)).filter(name => name.endsWith(".trash")), [], "the close waited for its removal");
});

test("G085-C04 the walk shares one count across the listings it runs at once: it never counts more than one entry past the limit", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-host-tmpdir-walk-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 64 directories listed at once, 30 entries each: 1,984 entries in all.
  for (let index = 0; index < 64; index++) { await mkdir(join(root, "d" + index)); for (let file = 0; file < 30; file++) await writeFile(join(root, "d" + index, "f" + file), ""); }
  const capped = await measureTree(root, { maxBytes: 256 * MIB, maxEntries: 100 });
  assert.equal(capped.over, true); assert.ok(capped.entries <= 101, "it counted " + capped.entries + " entries");
  const whole = await measureTree(root, { maxBytes: 256 * MIB, maxEntries: 4_096 });
  assert.deepEqual([whole.over, whole.entries], [false, 64 + 64 * 30]);
});

test("G085-C03 removing what was moved aside never follows a link: a leftover that is itself a link, and a link inside one, go as links while what they name stays", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hh-host-tmpdir-links-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const namespace = join(root, "hosts"), outside = join(root, "outside");
  await mkdir(namespace, { mode: 0o700 }); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "not the Hub's");
  const linked = join(namespace, ".0123456789abcdef." + randomUUID() + ".trash"), holding = join(namespace, ".fedcba9876543210." + randomUUID() + ".trash");
  await symlink(outside, linked); await mkdir(holding, { mode: 0o700 }); await symlink(outside, join(holding, "inner"));
  const tmpdirs = new HostTmpdirs(namespace, limits());
  tmpdirs.sweep(); await tmpdirs.settle(); await swept(namespace);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "not the Hub's", "what a link names is never removed");
  assert.deepEqual(await readdir(outside), ["keep.txt"]);
});
