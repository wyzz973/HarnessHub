import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sessionId, SessionError } from "../../src/contracts/session.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";

const moduleUrl = new URL("../../src/infrastructure/session/workspace-lease.js", import.meta.url).href;
const sid = sessionId("session-test");
function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof SessionError && error.code === expected;
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-lease-"));
  const locks = join(root, "locks"), workspace = join(root, "workspace");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, locks, workspace };
}
function contender(locks: string, workspace: string): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { SqliteWorkspaceLeaseProvider } from ${JSON.stringify(moduleUrl)};
    try { const lease = new SqliteWorkspaceLeaseProvider(${JSON.stringify(locks)}).acquire(${JSON.stringify(workspace)}, "session-child", "run-child"); lease.release(true); console.log("acquired"); }
    catch (error) { console.log(error.code); process.exitCode = 2; }
  `], { encoding: "utf8", timeout: 3000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}
async function childOwner(t: test.TestContext, locks: string, workspace: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { SqliteWorkspaceLeaseProvider } from ${JSON.stringify(moduleUrl)};
    new SqliteWorkspaceLeaseProvider(${JSON.stringify(locks)}).acquire(${JSON.stringify(workspace)}, "session-child", "run-child");
    console.log("held"); setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } });
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child lease acquisition timed out: " + stderr)), 3000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (exit) => { clearTimeout(timer); reject(new Error("child exited before lease acquisition: " + String(exit) + stderr)); });
    child.stdout?.once("data", (data: Buffer) => { clearTimeout(timer); if (data.toString().trim() === "held") resolve(); else reject(new Error("unexpected child output")); });
  });
  return child;
}

test("an independent provider and another process cannot acquire one active workspace; the conversations of one provider share its lease", async (t) => {
  const { locks, workspace } = await fixture(t);
  const first = new SqliteWorkspaceLeaseProvider(locks), second = new SqliteWorkspaceLeaseProvider(locks);
  const lease = first.acquire(workspace, sid, "run-one");
  try {
    // Another conversation of the same Gateway joins the lease it holds (2026-11-12: conversations in one workspace all run).
    const joined = first.acquire(workspace, sessionId("session-other"), "run-two");
    lease.assertOwned(); joined.assertOwned();
    // Another Gateway, in this process or in another, is a contender and is refused.
    assert.throws(() => second.acquire(workspace, sid, "run-three"), code("WORKSPACE_BUSY"));
    assert.equal(contender(locks, workspace).stdout, "WORKSPACE_BUSY");
    // The lease lasts until its last holder lets go.
    lease.release(true); lease.release(true);
    assert.throws(() => lease.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
    joined.assertOwned();
    assert.throws(() => second.acquire(workspace, sid, "run-four"), code("WORKSPACE_BUSY"));
    assert.equal(contender(locks, workspace).stdout, "WORKSPACE_BUSY");
    joined.release(true);
    assert.throws(() => joined.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
    second.acquire(workspace, sid, "run-five").release(true);
    assert.equal(contender(locks, workspace).stdout, "acquired");
  } finally { lease.release(true); }
});

test("a lease shared by conversations is quarantined if any holder let go without its program confirmed ended, and a lost lease cannot be joined", async (t) => {
  const { locks, workspace } = await fixture(t);
  const provider = new SqliteWorkspaceLeaseProvider(locks);
  const first = provider.acquire(workspace, sid, "run-one"), second = provider.acquire(workspace, sessionId("session-other"), "run-two");
  second.release(true); first.release(false);
  assert.throws(() => provider.acquire(workspace, sid, "run-three"), code("WORKSPACE_QUARANTINED"));
  assert.equal(contender(locks, workspace).stdout, "WORKSPACE_QUARANTINED");
  // A lease whose lock file was swapped under it is lost for every holder: nobody joins it.
  const lost = await fixture(t), losing = new SqliteWorkspaceLeaseProvider(lost.locks), held = losing.acquire(lost.workspace, sid, "run-four");
  const lockName = (await readdir(lost.locks)).find((name) => name.endsWith(".lock.sqlite"))!, file = join(lost.locks, lockName);
  await rename(file, file + ".moved"); await writeFile(file, "");
  assert.throws(() => held.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => losing.acquire(lost.workspace, sessionId("session-other"), "run-five"), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => held.release(true), code("WORKSPACE_OWNERSHIP_LOST"));
});

test("different workspaces can be leased independently", async (t) => {
  const { root, locks, workspace } = await fixture(t), other = join(root, "other");
  await mkdir(other);
  const provider = new SqliteWorkspaceLeaseProvider(locks), first = provider.acquire(workspace, sid, "run-one"), second = provider.acquire(other, sid, "run-two");
  try { first.assertOwned(); second.assertOwned(); } finally { second.release(true); first.release(true); }
});

test("workspace aliases resolve to one lock key", async (t) => {
  const { root, locks, workspace } = await fixture(t), alias = join(root, "alias");
  await symlink(workspace, alias);
  const provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(alias, sid, "run-one");
  // The alias and the workspace are one lease, which the conversations of the provider share; an independent provider is refused on either name.
  const joined = provider.acquire(workspace, sessionId("session-other"), "run-two");
  try { assert.throws(() => new SqliteWorkspaceLeaseProvider(locks).acquire(workspace, sid, "run-three"), code("WORKSPACE_BUSY")); } finally { joined.release(true); lease.release(true); }
  assert.equal((await readdir(locks)).filter((name) => name.endsWith(".lock.sqlite")).length, 1);
});

test("SIGKILL releases the OS lock but never erases unresolved writer state", async (t) => {
  const { locks, workspace } = await fixture(t), child = await childOwner(t, locks, workspace);
  assert.equal(contender(locks, workspace).stdout, "WORKSPACE_BUSY");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  assert.equal(contender(locks, workspace).stdout, "WORKSPACE_QUARANTINED");
});

test("a paused owner cannot be replaced based on elapsed time", async (t) => {
  const { locks, workspace } = await fixture(t), child = await childOwner(t, locks, workspace);
  child.kill("SIGSTOP");
  try { assert.equal(contender(locks, workspace).stdout, "WORKSPACE_BUSY"); } finally { child.kill("SIGCONT"); }
});

test("lock file substitution loses ownership and preserves quarantine", async (t) => {
  const { locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(workspace, sid, "run-one");
  const lockName = (await readdir(locks)).find((name) => name.endsWith(".lock.sqlite"));
  assert.ok(lockName);
  const file = join(locks, lockName), moved = file + ".moved";
  await rename(file, moved); await writeFile(file, "");
  assert.throws(() => lease.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => lease.release(true), code("WORKSPACE_OWNERSHIP_LOST"));
  await rm(file); await rename(moved, file);
  assert.throws(() => provider.acquire(workspace, sid, "run-two"), code("WORKSPACE_QUARANTINED"));
});

test("state file substitution is refused while active and by later acquisition", async (t) => {
  const { locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(workspace, sid, "run-one");
  const stateName = (await readdir(locks)).find((name) => name.endsWith(".state.sqlite"));
  assert.ok(stateName);
  const file = join(locks, stateName), moved = file + ".moved";
  await rename(file, moved); await writeFile(file, "");
  assert.throws(() => lease.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => lease.release(true), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => provider.acquire(workspace, sid, "run-two"), code("WORKSPACE_OWNERSHIP_LOST"));
  await rm(file); await rename(moved, file);
  assert.throws(() => provider.acquire(workspace, sid, "run-three"), code("WORKSPACE_QUARANTINED"));
});

test("workspace and lock root replacement invalidate the active lease", async (t) => {
  const { root, locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(workspace, sid, "run-one");
  await rename(workspace, join(root, "original-workspace")); await mkdir(workspace);
  assert.throws(() => lease.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => lease.release(false), code("WORKSPACE_OWNERSHIP_LOST"));
  const other = join(root, "other"); await mkdir(other);
  const next = provider.acquire(other, sid, "run-two");
  await rename(locks, join(root, "original-locks")); await mkdir(locks);
  assert.throws(() => next.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => next.release(false), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => provider.acquire(other, sid, "run-three"), code("WORKSPACE_OWNERSHIP_LOST"));
});

test("persisted owner token tampering is detected without clearing foreign state", async (t) => {
  const { locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(workspace, sid, "run-one");
  const stateName = (await readdir(locks)).find((name) => name.endsWith(".state.sqlite")); assert.ok(stateName);
  const db = new DatabaseSync(join(locks, stateName));
  db.prepare("UPDATE workspace_state SET token = ? WHERE id = 1").run("foreign-owner"); db.close();
  assert.throws(() => lease.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => lease.release(true), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => provider.acquire(workspace, sid, "run-two"), code("WORKSPACE_QUARANTINED"));
});

test("lost exclusive transaction fails ownership and does not clear held state", async (t) => {
  const { locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(workspace, sid, "run-one");
  // Fault injection deliberately reaches the adapter's private SQLite handle, through the holder's handle and the lease it shares.
  const db: unknown = Reflect.get(Reflect.get(Reflect.get(lease, "shared") as object, "lease") as object, "lockDb");
  assert.ok(db instanceof DatabaseSync); db.exec("ROLLBACK");
  assert.throws(() => lease.assertOwned(), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => lease.release(true), code("WORKSPACE_OWNERSHIP_LOST"));
  assert.throws(() => provider.acquire(workspace, sid, "run-two"), code("WORKSPACE_QUARANTINED"));
});

test("a removed state file is never recreated behind an existing lock marker", async (t) => {
  const { locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), lease = provider.acquire(workspace, sid, "run-one");
  lease.release(false);
  const stateName = (await readdir(locks)).find((name) => name.endsWith(".state.sqlite")); assert.ok(stateName);
  await rm(join(locks, stateName));
  assert.throws(() => provider.acquire(workspace, sid, "run-two"), code("WORKSPACE_STORAGE"));
  assert.equal((await readdir(locks)).filter((name) => name.endsWith(".state.sqlite")).length, 0);
});

test("invalid roots, workspaces and identities fail before execution", async (t) => {
  const { root, locks, workspace } = await fixture(t), file = join(root, "file"); await writeFile(file, "not a directory");
  assert.throws(() => new SqliteWorkspaceLeaseProvider("relative"), code("INVALID_INPUT"));
  const provider = new SqliteWorkspaceLeaseProvider(locks);
  for (const path of ["", "relative", join(root, "missing"), file, workspace + "\0bad"]) assert.throws(() => provider.acquire(path, sid, "run-one"), SessionError);
  assert.throws(() => provider.acquire(workspace, sid, ""), code("INVALID_INPUT"));
  assert.throws(() => provider.acquire(workspace, sid, "x".repeat(129)), code("INVALID_INPUT"));
  const alias = join(root, "lock-alias"); await symlink(locks, alias);
  assert.throws(() => new SqliteWorkspaceLeaseProvider(alias), SessionError);
});

test("a quarantine is cleared only for the Session that held it, once its holder is gone, and never under a live holder", async (t) => {
  const { root, locks, workspace } = await fixture(t), provider = new SqliteWorkspaceLeaseProvider(locks), child = await childOwner(t, locks, workspace);
  assert.equal(provider.releaseAbandoned(workspace, sessionId("session-child")), false, "a live holder keeps its lease");
  assert.equal(contender(locks, workspace).stdout, "WORKSPACE_BUSY");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  assert.equal(provider.releaseAbandoned(workspace, sessionId("session-other")), false, "a record for another Session stays a quarantine");
  assert.equal(contender(locks, workspace).stdout, "WORKSPACE_QUARANTINED");
  assert.equal(provider.releaseAbandoned(workspace, sessionId("session-child")), true);
  assert.equal(contender(locks, workspace).stdout, "acquired");
  assert.equal(provider.releaseAbandoned(workspace, sessionId("session-child")), false, "nothing is held any more");
  const untouched = join(root, "untouched"); await mkdir(untouched);
  assert.equal(provider.releaseAbandoned(untouched, sessionId("session-child")), false, "a workspace never leased has nothing to clear");
});
