import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionError, type SessionId } from "../../src/contracts/session.js";
import { reasonOf, scrubbed, storageCause } from "../../src/cli/startup-failure.js";
import { appStore } from "../fixtures/runtime-store.js";
import { Scenario, created, newConversation, temporary } from "../fixtures/store-helpers.js";

// What a person is told when the service or a command cannot start (src/cli/startup-failure.ts). A code alone — "STORAGE_UNAVAILABLE — local web application could not run" — gave nothing to act on;
// the reason does: SQLite names the table, the column or the rule it met. Real commands on real data roots in temporary directories, the root broken as a build or a disk may leave it; what is told
// must hold the reason and nothing of the conversation, and no path.

const web = fileURLToPath(new URL("../../src/cli/web.js", import.meta.url)), sessions = fileURLToPath(new URL("../../src/cli/sessions.js", import.meta.url)), chat = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));
const WORDS = "the-words-of-this-conversation-are-private";

interface Root { readonly scratch: string; readonly data: string; readonly locks: string; readonly workspace: string; readonly id: SessionId }
/** A data root of a real store with a finished Turn whose words are WORDS, closed. */
function made(t: TestContext): Root {
  const scratch = temporary(t), data = join(scratch, "data"), locks = join(scratch, "locks"), workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const store = appStore(data);
  let id: SessionId;
  try {
    id = created(store, newConversation(workspace, "private")).conversation.id;
    new Scenario(store, id, "run-private", false).turn(WORDS, "and so are these: " + WORDS);
  } finally { store.close(); }
  return { scratch, data, locks, workspace, id };
}
const env = (root: Root) => ({ PATH: join(root.scratch, "empty-path"), HOME: join(root.scratch, "home"), TMPDIR: root.scratch, LANG: "C" });
interface Ran { readonly status: number | null; readonly stdout: string; readonly stderr: string }
function run(entry: string, root: Root, args: readonly string[]): Ran {
  const called = spawnSync(process.execPath, [entry, ...args], { cwd: root.scratch, env: env(root), encoding: "utf8", timeout: 30_000 });
  return { status: called.status, stdout: called.stdout, stderr: called.stderr };
}
/** What every failure told must satisfy: the reason is in it, and nothing of the conversation and no path of this machine. */
function told(ran: Ran, root: Root, reason: RegExp): void {
  const output = ran.stdout + ran.stderr;
  assert.notEqual(ran.status, 0, output);
  assert.match(output, reason, "the reason is told: " + output);
  assert.equal(output.includes(WORDS), false, "nothing of the conversation");
  assert.equal(output.includes(root.scratch), false, "no path of the root, the workspace or the locks");
  assert.equal(/(?:^|[\s("'=:])\/(?:Users|home|private|var|tmp|opt|Volumes)\//u.test(output), false, "no absolute path at all: " + output);
}

test("a failure that is not of the storage is told with its own words, not with its code alone", { timeout: 60_000 }, t => {
  const root = made(t);
  const ran = run(web, root, ["--data-dir", root.data, "--workspace-lock-root", root.locks, "--cwd", root.workspace, "--port", "123456"]);
  assert.match(ran.stderr, /^HarnessGateway: INVALID_INPUT — local web application could not run: port must be 0\.\.65535$/mu, ran.stderr);
});

test("what is told has the credentials, the environment values, the account name and every path taken out, and keeps the reason", () => {
  // Built at run time so that no source line holds a credential whole.
  const token = "gh" + "p_" + "A1b2C3d4E5".repeat(4);
  const out = scrubbed("no such column: progress in /Users/someone/Library/Application Support/Gateway/data/gateway.sqlite near " + token + " with API_KEY=hunter2 at ~/work and /opt/other/place.db");
  assert.match(out, /no such column: progress/u);
  assert.equal(/\/Users|Application Support|gateway\.sqlite|\/opt|hunter2|~\/work/u.test(out) || out.includes(token), false, out);
  const nested = Object.assign(new SessionError("STORAGE_UNAVAILABLE", "SQLite operation failed; new dispatch is disabled"), { cause: new Error("no such table: derived", { cause: new Error("at /srv/x/y/z.db") }) });
  assert.equal(storageCause(nested), "no such table: derived; at [路径]");
  assert.equal(reasonOf(nested), "SQLite operation failed; new dispatch is disabled (no such table: derived; at [路径])");
  assert.equal(storageCause(new SessionError("INVALID_INPUT", "x")), null, "a failure that is not of the storage has no cause told");
  assert.equal(reasonOf(Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:4317"), { code: "EADDRINUSE" })), "EADDRINUSE: listen EADDRINUSE: address already in use 127.0.0.1:4317");
  assert.equal(reasonOf("not an error"), null);
});
