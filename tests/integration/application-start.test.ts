import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SessionError } from "../../src/contracts/session.js";
import { application } from "../../src/cli/session-application.js";
import { later, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { rawDatabase, temporary, treeDigest } from "../fixtures/store-helpers.js";

// The order of the start (src/cli/session-application.ts): what needs no ownership of the data directory is settled before the conversation library is opened, because opening it
// may upgrade it for good and a build that cannot start is then left with a library the build before it refuses; and when a step after it fails, the error says that the library was
// upgraded and where the copy from before is. All on data roots in temporary directories.

const userVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA user_version").get()?.user_version);

test("a workspace lock root that is not private fails the start before the conversation library is opened: the data root is the very bytes it was, a v13 library is still v13", async t => {
  const directory = temporary(t), data = join(directory, "data"), open = join(directory, "open-locks");
  writeV13Root(data, [loadV13Fixture("switches")]);
  mkdirSync(open); chmodSync(open, 0o755);
  const before = treeDigest(data);
  assert.throws(() => application(data, () => {}, { installations: "any", workspaceLockRoot: open }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_STORAGE");
  assert.deepEqual(treeDigest(data), before, "not a byte of the data root changed: no backup, no upgrade, no owner claimed, no file made");
  // A root that is not even absolute is refused the same way, and one that is fine lets the start go on and upgrade.
  assert.throws(() => application(data, () => {}, { installations: "any", workspaceLockRoot: "relative-locks" }), (error: unknown) => error instanceof SessionError && error.code === "INVALID_INPUT");
  assert.deepEqual(treeDigest(data), before);
  // (Looking at the version with a connection of its own makes the files of the write-ahead log beside a database that was closed, so it is done last.)
  const left = rawDatabase(data, true);
  try { assert.equal(userVersion(left), 13); } finally { left.close(); }
  const app = application(data, () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks"), management: { installationMode: "private-fixture" } });
  try { assert.equal(app.store.migration?.from, 13); }
  finally { try { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); } finally { app.store.close(); } }
});

test("a step after the conversation library was upgraded that fails says so: the library is v14 now, and the copy from before the upgrade is where the backup goes", t => {
  const directory = temporary(t), data = join(directory, "data");
  writeV13Root(data, [loadV13Fixture("switches")]);
  // The provider library is a version this build does not know: opening it fails after the conversation library was upgraded.
  const providers = join(data, "providers");
  mkdirSync(providers, { mode: 0o700 });
  writeFileSync(join(providers, ".harness-gateway-provider.json"), '{"application":"harness-gateway-provider","schemaVersion":1}\n', { mode: 0o600 });
  writeFileSync(join(providers, "master.key"), "", { mode: 0o600 });
  const unknown = new DatabaseSync(join(providers, "providers.sqlite"));
  try { unknown.exec("PRAGMA journal_mode=DELETE; CREATE TABLE marker(x); PRAGMA user_version=7"); } finally { unknown.close(); }
  chmodSync(join(providers, "providers.sqlite"), 0o600);
  let failure: unknown;
  try { application(data, () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks"), management: { installationMode: "private-fixture" } }); } catch (error) { failure = error; }
  assert.ok(failure instanceof SessionError && failure.code === "START_FAILED_AFTER_UPGRADE", String(failure));
  assert.match(failure.message, /unsupported Provider storage schema/u, "what failed");
  assert.match(failure.message, /upgraded to v14/u, "that the library was upgraded");
  assert.match(failure.message, /backups\/gateway-v13-before-v14\.sqlite/u, "and where the copy from before is");
  assert.ok(!failure.message.includes(data), "without telling where the data directory is");
  assert.ok(existsSync(join(data, "backups", "gateway-v13-before-v14.sqlite")));
  const left = rawDatabase(data, true);
  try { assert.equal(userVersion(left), 14); assert.equal(Number(left.prepare("SELECT owner_active FROM owner_metadata").get()?.owner_active), 0, "and the owner was let go"); } finally { left.close(); }
  // A start that did not upgrade has nothing to add to what failed.
  let again: unknown;
  try { application(data, () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks"), management: { installationMode: "private-fixture" } }); } catch (error) { again = error; }
  assert.ok(again !== undefined && !(again instanceof SessionError && again.code === "START_FAILED_AFTER_UPGRADE"), "the library is v14 already: the failure is told as it is");
});

test("the web entry tells a person what an upgrade that could not finish the start says, and only that: the code, the rule, the conversation, where the copy is", t => {
  const directory = temporary(t), data = join(directory, "data"), workspace = join(directory, "workspace"), home = join(directory, "home");
  mkdirSync(workspace); mkdirSync(home);
  writeV13Root(data, [loadV13Fixture("switches")]);
  const providers = join(data, "providers");
  mkdirSync(providers, { mode: 0o700 });
  writeFileSync(join(providers, ".harness-gateway-provider.json"), '{"application":"harness-gateway-provider","schemaVersion":1}\n', { mode: 0o600 });
  writeFileSync(join(providers, "master.key"), "", { mode: 0o600 });
  const unknown = new DatabaseSync(join(providers, "providers.sqlite"));
  try { unknown.exec("PRAGMA journal_mode=DELETE; CREATE TABLE marker(x); PRAGMA user_version=7"); } finally { unknown.close(); }
  chmodSync(join(providers, "providers.sqlite"), 0o600);
  const cli = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), "dist/src/cli/web.js");
  const ran = spawnSync(process.execPath, [cli, "--allow-unofficial", "--data-dir", data, "--cwd", workspace, "--port", "0", "--workspace-lock-root", join(directory, "locks"), "--no-login-shell"],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home } });
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /START_FAILED_AFTER_UPGRADE — unsupported Provider storage schema\. The conversation library was upgraded to v14 .*backups\/gateway-v13-before-v14\.sqlite/u, ran.stderr);
  assert.ok(!ran.stderr.includes(directory), "and no path of the machine");
  // Any other failure is told by its code alone, as it was.
  const refused = spawnSync(process.execPath, [cli, "--allow-unofficial", "--data-dir", data, "--cwd", workspace, "--port", "0", "--workspace-lock-root", "relative-locks", "--no-login-shell"],
    { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: home } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /HarnessGateway: INVALID_INPUT — local web application could not run/u, refused.stderr);
});

test("a start that upgrades says so on the error stream, which is the log of the service: that and where the copy is, and each native session two conversations held and one gave up", async t => {
  const directory = temporary(t), data = join(directory, "data");
  writeV13Root(data, [loadV13Fixture("switches"), later(loadV13Fixture("tools"), 1)]);
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as never);
  const app = application(data, () => {}, { installations: "any", workspaceLockRoot: join(directory, "locks"), management: { installationMode: "private-fixture" } });
  try {
    const said = lines.join("");
    assert.match(said, /HarnessGateway: UPGRADE \(the conversation library was upgraded from version 13 to 14, 4 conversations converted; the copy from before is backups\/gateway-v13-before-v14\.sqlite in the data directory\)/u);
    assert.match(said, /HarnessGateway: UPGRADE \(conversation session-sw-1 gave up its native session of alpha\/alpha-acp \(binding 0\) to conversation session-tl-1, which used it more recently/u);
    assert.ok(!said.includes(data) && !/native-(alpha|bravo)-/u.test(said), "no path of the machine and no reference to a native session");
  } finally { try { await app.runtime.close(); await app.management.shutdown(); await app.providers.shutdown(); } finally { app.store.close(); } }
});
