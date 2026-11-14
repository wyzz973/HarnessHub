import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { readWhole, type ReadConversation } from "../fixtures/http-conversation.js";

/*
 * A Turn's checkpoints, putting files back and a pull request over real HTTP (2026-11-14): a real Gateway and its store, a real Git in temporary repositories with a
 * configuration of the test's own, a Harness over ACP that changes files (tests/fixtures/checkpoint-peer.mjs), a local bare repository as the remote and a fake gh first
 * on PATH. GitHub is never contacted and no real pull request is made.
 */

const peer = fileURLToPath(new URL("../../../tests/fixtures/checkpoint-peer.mjs", import.meta.url));
function row(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }

interface Gateway { root: string; workspace: string; gateway: WebServer; origin: string; cookie: string; csrf: string }
/** Git reads the test's configuration, never the user's: set for the Gateway's Git and the test's alike, and put back after. */
async function gitConfig(t: test.TestContext, root: string): Promise<void> {
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM, path: process.env.PATH };
  const config = join(root, "gitconfig");
  await writeFile(config, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => { for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system], ["PATH", saved.path]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function start(t: test.TestContext, owned: { value: boolean }): Promise<Gateway> {
  const root = await mkdtemp(join(tmpdir(), "harness-checkpoints-")), workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>fixture</title>");
  await gitConfig(t, root);
  const source = { repository: "fixture", revision: "checkpoints", upstreamId: "peer", url: "https://example.invalid/checkpoint-peer" };
  const definitions = [{ id: "cp-a", name: "Checkpoint A", aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "cp-a-control", protocol: "acp-v1", executableNames: ["fixture-peer"], args: [peer], env: {}, requiredExecutables: [], package: null, distribution: null, source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "cp-a-control": { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const gateway = await startWebServer({ installations: "any", root: join(root, "data"), configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: join(root, "locks"),
    workspaceOwnership: { ownWorktree: () => Promise.resolve(owned.value) },
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) });
  const parsed = new URL(gateway.url), g: Gateway = { root, workspace: configuration.workspace, gateway, origin: parsed.origin, cookie: "", csrf: "" };
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const login = await fetch(g.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: g.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(parsed.hash.slice(1)).get("token") }) });
  assert.equal(login.status, 200);
  g.cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!; g.csrf = String(row(await login.json()).csrfToken);
  return g;
}
async function call(g: Gateway, path: string, method = "GET", input?: unknown): Promise<{ status: number; data: Record<string, unknown>; text: string }> {
  const response = await fetch(g.origin + path, { method, headers: { Cookie: g.cookie, Origin: g.origin, ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": g.csrf }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); return { status: response.status, data: text === "" ? {} : row(JSON.parse(text)), text };
}
async function ok(g: Gateway, path: string, method = "GET", input?: unknown): Promise<Record<string, unknown>> {
  const answer = await call(g, path, method, input); assert.ok([200, 201, 202].includes(answer.status), path + ": " + answer.status + " " + answer.text); return answer.data;
}
async function refused(g: Gateway, path: string, status: number, code: string, method = "GET", input?: unknown): Promise<Record<string, unknown>> {
  const answer = await call(g, path, method, input); assert.equal(answer.status, status, path + ": " + answer.text); assert.equal(answer.data.code, code, path + ": " + answer.text); return answer.data;
}
async function conversation(g: Gateway, id: string): Promise<ReadConversation> { return readWhole(async path => (await call(g, path)).data, id); }
async function waitFor(g: Gateway, id: string, predicate: (value: ReadConversation) => boolean): Promise<ReadConversation> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const value = await conversation(g, id); if (predicate(value)) return value; await delay(25); }
  throw new Error("the conversation did not get there: " + JSON.stringify((await conversation(g, id)).runs.map(run => run.status)));
}
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

test("a real Turn is checkpointed before and after without touching the index or HEAD (ignored files left out); its scope lists and diffs what it changed, a running Turn's against the working tree; files go back only in a worktree of the conversation's own, not while a Turn runs, not without a checkpoint; the refs go with the conversation", async t => {
  const owned = { value: false }, g = await start(t, owned);
  const sh = (args: readonly string[], cwd = g.workspace): string => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
  const put = (name: string, content: string) => writeFile(join(g.workspace, name), content);
  const created = await ok(g, "/api/v1/sessions", "POST", { selection: { harnessId: "cp-a" }, commandId: "create-checkpoints" });
  const id = String(row(created.head).id), base = `/api/v1/sessions/${id}`;
  const say = async (text: string, key: string) => ok(g, base + "/messages", "POST", { text, commandId: key });

  // Not a repository: no checkpoints and none listed; the Turn scope is not found as a repository.
  await say("write:plain.txt=p", "plain");
  await waitFor(g, id, value => value.runs[0]?.status === "completed");
  assert.deepEqual(await ok(g, base + "/checkpoints"), { checkpoints: [], next: null, restorable: false });
  await refused(g, base + "/git/changes?scope=turn&ordinal=0", 404, "NOT_A_REPOSITORY");
  await rm(join(g.workspace, "plain.txt"));

  // A repository with a commit; then, before the next Turn, a change not staged, a new file staged, an untracked file and an ignored one.
  sh(["init", "-q"]);
  await put(".gitignore", "ignored.log\n"); await put("keep.txt", "k1\n"); await put("staged.txt", "s1\n");
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "first"]);
  await put("keep.txt", "k-before\n"); await put("new-staged.txt", "n1\n"); sh(["add", "new-staged.txt"]); await put("untracked.txt", "u1\n"); await put("ignored.log", "log1\n");
  // The test's own status takes no lock and refreshes no index (an ordinary `git status` may write it): the index file's bytes are what is compared.
  const status = sh(["--no-optional-locks", "status", "--porcelain"]), head = sh(["rev-parse", "HEAD"]), index = sha(join(g.workspace, ".git", "index"));
  await say("write:keep.txt=K2 write:made.txt=made write:dir/deep.txt=deep delete:untracked.txt", "turn-1");
  await waitFor(g, id, value => value.runs[1]?.status === "completed");
  // The user's HEAD, branch and index are as they were: the staged file is still staged, nothing else is.
  assert.equal(sh(["rev-parse", "HEAD"]), head); assert.equal(sh(["symbolic-ref", "--short", "HEAD"]), "main");
  assert.equal(sha(join(g.workspace, ".git", "index")), index, "the index file is not written");
  assert.equal(sh(["diff", "--cached", "--name-only"]), "new-staged.txt");
  assert.notEqual(sh(["--no-optional-locks", "status", "--porcelain"]), status, "the Harness changed the working tree");
  const refs = sh(["for-each-ref", "--format=%(refname) %(objectname)", "refs/harnesshub/"]).split("\n").map(line => line.split(" ") as [string, string]);
  assert.deepEqual(refs.map(([name]) => name).sort(), [`refs/harnesshub/checkpoints/${id}/1/after`, `refs/harnesshub/checkpoints/${id}/1/before`]);
  const before = refs.find(([name]) => name.endsWith("/before"))![1], after = refs.find(([name]) => name.endsWith("/after"))![1];
  // Each checkpoint is a commit on HEAD by HarnessHub with the whole working tree in it but what .gitignore leaves out.
  assert.equal(sh(["rev-parse", before + "^"]), head); assert.equal(sh(["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", before]), "HarnessHub <hub@localhost>|HarnessHub <hub@localhost>|HarnessHub checkpoint");
  assert.deepEqual(sh(["ls-tree", "-r", "--name-only", before]).split("\n"), [".gitignore", "keep.txt", "new-staged.txt", "staged.txt", "untracked.txt"]);
  assert.equal(sh(["show", before + ":keep.txt"]), "k-before");
  assert.deepEqual(sh(["ls-tree", "-r", "--name-only", after]).split("\n"), [".gitignore", "dir/deep.txt", "keep.txt", "made.txt", "new-staged.txt", "staged.txt"]);
  assert.equal(sh(["show", after + ":keep.txt"]), "K2");
  assert.equal(sh(["branch", "--list"]), "* main", "no branch was made");

  // The list, the latest first; the Turn's scope: what it changed, file by file, and one file's diff.
  assert.deepEqual(await ok(g, base + "/checkpoints"), { checkpoints: [{ ordinal: 1, before, after }], next: null, restorable: false });
  const changed = await ok(g, base + "/git/changes?scope=turn&ordinal=1");
  assert.deepEqual(changed, { scope: "turn", turn: { ordinal: 1, before, after }, files: [
    { path: "dir/deep.txt", status: "added", added: 1, removed: 0 }, { path: "keep.txt", status: "modified", added: 1, removed: 1 },
    { path: "made.txt", status: "added", added: 1, removed: 0 }, { path: "untracked.txt", status: "deleted", added: 0, removed: 1 }] });
  const keep = await ok(g, base + "/git/diff?scope=turn&ordinal=1&path=keep.txt");
  assert.equal(keep.path, "keep.txt"); assert.match(String(keep.diff), /^diff --git a\/keep\.txt b\/keep\.txt\n[^]*\n-k-before\n\+K2\n$/u);
  assert.equal((await ok(g, base + "/git/diff?scope=turn&ordinal=1&path=staged.txt")).diff, "", "a file the Turn did not change has no diff");
  await refused(g, base + "/git/changes?scope=turn&ordinal=7", 404, "CHECKPOINT_MISSING");
  await refused(g, base + "/git/changes?scope=turn&ordinal=0", 404, "CHECKPOINT_MISSING", "GET");
  for (const query of ["scope=turn", "scope=turn&ordinal=-1", "scope=turn&ordinal=01", "scope=turn&ordinal=1&sha=abc", "scope=turn&ordinal=1&whitespace=yes"]) await refused(g, base + "/git/changes?" + query, 400, "INVALID_INPUT");
  await refused(g, base + "/git/diff?scope=turn&ordinal=1", 400, "INVALID_INPUT");

  // A Turn that runs: its scope is its checkpoint against the working tree as it is now, untracked files as what they are, and it follows the tree.
  await say("write:live.txt=now hold", "turn-2");
  await waitFor(g, id, value => value.runs[2]?.status === "running" && existsSync(join(g.workspace, "live.txt")));
  const running = await ok(g, base + "/git/changes?scope=turn&ordinal=2");
  assert.deepEqual(row(running.turn).after, null); assert.equal(row(running.turn).before, sh(["rev-parse", `refs/harnesshub/checkpoints/${id}/2/before`]));
  assert.deepEqual(running.files, [{ path: "live.txt", status: "added", added: 1, removed: 0 }]);
  await put("made.txt", "made\nmore\n");
  assert.deepEqual((await ok(g, base + "/git/changes?scope=turn&ordinal=2")).files, [{ path: "live.txt", status: "added", added: 1, removed: 0 }, { path: "made.txt", status: "modified", added: 1, removed: 0 }]);
  assert.match(String((await ok(g, base + "/git/diff?scope=turn&ordinal=2&path=made.txt")).diff), /\n made\n\+more\n$/u);
  assert.equal(sha(join(g.workspace, ".git", "index")), index, "reading a running Turn writes no index either");

  // Putting files back: only in a worktree of the conversation's own, not while a Turn runs, not to a Turn without a checkpoint.
  await refused(g, base + "/checkpoints/1/restore", 409, "WORKTREE_REQUIRED", "POST", {});
  owned.value = true;
  assert.equal((await ok(g, base + "/checkpoints")).restorable, true);
  await refused(g, base + "/checkpoints/1/restore", 409, "SESSION_ACTIVE", "POST", {});
  assert.equal((await call(g, base + "/cancel", "POST", { commandId: "stop-2" })).status, 202);
  await waitFor(g, id, value => value.runs[2]?.status === "cancelled");
  // A Turn that was stopped is checkpointed after too.
  assert.match(sh(["rev-parse", `refs/harnesshub/checkpoints/${id}/2/after`]), /^[0-9a-f]{40}$/u);
  await refused(g, base + "/checkpoints/9/restore", 404, "CHECKPOINT_MISSING", "POST", {});
  await refused(g, base + "/checkpoints/x/restore", 400, "INVALID_INPUT", "POST", {});
  await refused(g, base + "/checkpoints/1/restore", 400, "INVALID_INPUT", "POST", { force: true });
  await put("ignored.log", "log2\n"); await put("fresh.txt", "fresh\n");
  const restored = await ok(g, base + "/checkpoints/1/restore", "POST", {});
  assert.equal(restored.restoredTo, before); assert.match(String(restored.savedAs), new RegExp(`^refs/harnesshub/checkpoints/${id}/restore-[0-9]+$`, "u"));
  // The files are as they were before Turn 2 (ordinal 1): what it changed is back, what came after is gone, what .gitignore leaves out stays as it is now.
  assert.equal(await readFile(join(g.workspace, "keep.txt"), "utf8"), "k-before\n"); assert.equal(await readFile(join(g.workspace, "untracked.txt"), "utf8"), "u1\n");
  for (const gone of ["made.txt", "dir/deep.txt", "live.txt", "fresh.txt"]) assert.equal(existsSync(join(g.workspace, gone)), false, gone);
  assert.equal(await readFile(join(g.workspace, "ignored.log"), "utf8"), "log2\n");
  assert.equal(sh(["rev-parse", "HEAD"]), head);
  // What was there just before is kept under the restore's ref: nothing of the user's is lost.
  const saved = String(restored.savedAs);
  assert.deepEqual(sh(["ls-tree", "-r", "--name-only", saved]).split("\n"), [".gitignore", "dir/deep.txt", "fresh.txt", "keep.txt", "live.txt", "made.txt", "new-staged.txt", "staged.txt"]);
  assert.equal(sh(["show", saved + ":made.txt"]), "made\nmore");
  assert.deepEqual((await ok(g, base + "/checkpoints")).checkpoints, [{ ordinal: 2, before: sh(["rev-parse", `refs/harnesshub/checkpoints/${id}/2/before`]), after: sh(["rev-parse", `refs/harnesshub/checkpoints/${id}/2/after`]) }, { ordinal: 1, before, after }]);
  // Pages: the latest first, from below `before`.
  assert.deepEqual(await ok(g, base + "/checkpoints?limit=1"), { checkpoints: [{ ordinal: 2, before: sh(["rev-parse", `refs/harnesshub/checkpoints/${id}/2/before`]), after: sh(["rev-parse", `refs/harnesshub/checkpoints/${id}/2/after`]) }], next: 2, restorable: true });
  assert.deepEqual(await ok(g, base + "/checkpoints?limit=1&before=2"), { checkpoints: [{ ordinal: 1, before, after }], next: null, restorable: true });
  await refused(g, base + "/checkpoints?limit=0", 400, "INVALID_INPUT");

  // Erasing the conversation takes its refs away, the restore's too; the user's own refs stay.
  assert.equal((await call(g, base, "DELETE")).status, 204);
  await refused(g, base + "/checkpoints", 404, "SESSION_NOT_FOUND");
  assert.equal((await call(g, base + "/purge", "POST", {})).status, 204);
  assert.equal(sh(["for-each-ref", "refs/harnesshub/"]), "");
  assert.equal(sh(["rev-parse", "HEAD"]), head);
});

test("a checkpoint that takes longer than five seconds is given up: the Turn is not held up longer, its Git is stopped, and no ref names a half-taken checkpoint", async t => {
  const g = await start(t, { value: false }), real = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const sh = (args: readonly string[]): string => execFileSync(real, [...args], { cwd: g.workspace, encoding: "utf8" }).trim();
  sh(["init", "-q"]); await writeFile(join(g.workspace, "a.txt"), "a\n"); sh(["add", "-A"]); sh(["commit", "-q", "-m", "first"]);
  // A Git in front of the real one whose `add` hangs while the flag is there (the Gateway's Git is the one on PATH).
  const bin = join(g.root, "slow-git"), flag = join(g.root, "slow"), pids = join(g.root, "pids");
  await mkdir(bin);
  await writeFile(join(bin, "git"), ["#!/bin/sh", `for a in "$@"; do if [ "$a" = add ] && [ -f '${flag}' ]; then echo $$ >> '${pids}'; /bin/sleep 30; exit 1; fi; done`, `exec '${real}' "$@"`, ""].join("\n"));
  await chmod(join(bin, "git"), 0o755);
  process.env.PATH = bin + delimiter + (process.env.PATH ?? "");
  await writeFile(flag, "");
  const created = await ok(g, "/api/v1/sessions", "POST", { selection: { harnessId: "cp-a" }, commandId: "create-slow" }), id = String(row(created.head).id);
  const began = Date.now();
  await ok(g, `/api/v1/sessions/${id}/messages`, "POST", { text: "write:b.txt=b", commandId: "slow-1" });
  await waitFor(g, id, value => value.runs[0]?.status === "completed");
  const took = Date.now() - began;
  // Two captures given up (before and after), each at five seconds; the Turn itself is quick.
  assert.ok(took >= 9000 && took < 14_000, "the Turn took " + took + " ms");
  assert.equal(await readFile(join(g.workspace, "b.txt"), "utf8"), "b\n");
  assert.equal(sh(["for-each-ref", "refs/harnesshub/"]), "");
  // The hung Git was stopped with its process group.
  for (const pid of (await readFile(pids, "utf8")).trim().split("\n").map(Number)) assert.throws(() => process.kill(pid, 0), (error: unknown) => row(error).code === "ESRCH", "process " + pid + " still runs");
  // Without the flag the next Turn is checkpointed as usual.
  await rm(flag);
  await ok(g, `/api/v1/sessions/${id}/messages`, "POST", { text: "write:c.txt=c", commandId: "slow-2" });
  await waitFor(g, id, value => value.runs[1]?.status === "completed");
  assert.deepEqual(sh(["for-each-ref", "--format=%(refname)", "refs/harnesshub/"]).split("\n").sort(), [`refs/harnesshub/checkpoints/${id}/1/after`, `refs/harnesshub/checkpoints/${id}/1/before`]);
});

test("a pull request of the branch: gh missing, signed out, ready, one already made; making it pushes the branch first and hands gh its title, body, base and head; refused on the default branch, a detached head, without gh or signed out", async t => {
  const g = await start(t, { value: false });
  const sh = (args: readonly string[], cwd = g.workspace): string => execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
  const created = await ok(g, "/api/v1/sessions", "POST", { selection: { harnessId: "cp-a" }, commandId: "create-pr" });
  const base = `/api/v1/sessions/${String(row(created.head).id)}`;
  await refused(g, base + "/git/pr", 404, "NOT_A_REPOSITORY");

  // A repository whose origin is a bare repository on this disk, its HEAD main; a branch of two commits on top of main, not pushed.
  const bare = join(g.root, "remote.git"); sh(["init", "-q", "--bare", bare], g.root);
  sh(["init", "-q"]); await writeFile(join(g.workspace, "a.txt"), "a\n"); sh(["add", "-A"]); sh(["commit", "-q", "-m", "first"]);
  sh(["remote", "add", "origin", bare]); sh(["push", "-q", "-u", "origin", "main"]); sh(["remote", "set-head", "origin", "main"]);
  sh(["checkout", "-q", "-b", "feature"]);
  for (const name of ["b", "c"]) { await writeFile(join(g.workspace, name + ".txt"), name + "\n"); sh(["add", "-A"]); sh(["commit", "-q", "-m", "add " + name]); }

  // PATH: a folder with git alone (so the gh of this Mac is never found), then the fake gh's in front of it.
  const gitOnly = join(g.root, "git-only"), fake = join(g.root, "fake-gh"), state = join(g.root, "gh-state");
  await mkdir(gitOnly); await mkdir(fake); await mkdir(state);
  await symlink(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(gitOnly, "git"));
  await writeFile(join(fake, "gh"), [
    "#!/bin/sh", `d='${state}'`, "printf '%s\\n' \"$*\" >> \"$d/calls\"",
    "if [ \"$1\" = auth ] && [ \"$2\" = status ]; then",
    "  if [ -f \"$d/signed-in\" ]; then echo 'Logged in to github.com account fixture' >&2; exit 0; fi",
    "  echo 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2; exit 1", "fi",
    "if [ \"$1\" = pr ] && [ \"$2\" = view ]; then",
    "  if [ -f \"$d/pr.json\" ]; then /bin/cat \"$d/pr.json\"; exit 0; fi", "  echo \"no pull requests found for branch \\\"$3\\\"\" >&2; exit 1", "fi",
    "if [ \"$1\" = pr ] && [ \"$2\" = create ]; then",
    "  if [ -f \"$d/create-fails\" ]; then echo 'a pull request for branch \"feature\" into branch \"main\" already exists:' >&2; echo 'https://github.com/o/r/pull/3' >&2; exit 1; fi",
    "  : > \"$d/create-args\"; for a in \"$@\"; do printf '%s\\0' \"$a\" >> \"$d/create-args\"; done",
    "  printf 'GH_PROMPT_DISABLED=%s GIT_TERMINAL_PROMPT=%s' \"$GH_PROMPT_DISABLED\" \"$GIT_TERMINAL_PROMPT\" > \"$d/create-env\"",
    "  echo 'Creating pull request for feature into main in o/r' >&2; echo 'https://github.com/o/r/pull/7'; exit 0", "fi",
    "echo unknown >&2; exit 2", ""].join("\n"));
  await chmod(join(fake, "gh"), 0o755);
  process.env.PATH = gitOnly;
  const expected = { branch: "feature", defaultBranch: "main", remote: { name: "origin", url: bare, github: false }, ahead: 2, unpushed: 2 };
  assert.deepEqual(await ok(g, base + "/git/pr"), { gh: "missing", ...expected });
  await refused(g, base + "/git/pr", 409, "GH_UNAVAILABLE", "POST", { title: "Add feature", body: "" });
  process.env.PATH = fake + delimiter + gitOnly;
  assert.deepEqual(await ok(g, base + "/git/pr"), { gh: "signed-out", ...expected });
  await refused(g, base + "/git/pr", 409, "GH_AUTH_REQUIRED", "POST", { title: "Add feature", body: "" });
  assert.equal(sh(["for-each-ref", "refs/heads/feature"], bare), "", "nothing is pushed for a pull request gh cannot make");
  await writeFile(join(state, "signed-in"), "");
  assert.deepEqual(await ok(g, base + "/git/pr"), { gh: "ready", ...expected });
  await writeFile(join(state, "pr.json"), JSON.stringify({ url: "https://github.com/o/r/pull/5", number: 5, title: "Old", state: "OPEN" }));
  assert.deepEqual(await ok(g, base + "/git/pr"), { gh: "ready", ...expected, existing: { url: "https://github.com/o/r/pull/5", number: 5, title: "Old", state: "OPEN" } });
  await rm(join(state, "pr.json"));

  // Refusals before anything is pushed or asked of gh.
  for (const bad of [{ body: "" }, { title: " ", body: "" }, { title: "x" }, { title: "x", body: "", base: 3 }, { title: "x", body: "", draft: true }, { title: "x", body: "", base: "-x" }]) await refused(g, base + "/git/pr", 400, "INVALID_INPUT", "POST", bad);
  await refused(g, base + "/git/pr", 409, "GIT_PR_ON_DEFAULT_BRANCH", "POST", { title: "x", body: "", base: "feature" });

  // Made: the branch pushed first (it had no upstream), then gh pr create with what the user wrote.
  const made = await ok(g, base + "/git/pr", "POST", { title: "Add feature", body: "Line one\nLine two" });
  assert.deepEqual(made, { url: "https://github.com/o/r/pull/7", number: 7 });
  assert.equal(sh(["rev-parse", "refs/heads/feature"], bare), sh(["rev-parse", "HEAD"]));
  assert.deepEqual((await readFile(join(state, "create-args"), "utf8")).split("\0").slice(0, -1), ["pr", "create", "--title", "Add feature", "--body", "Line one\nLine two", "--base", "main", "--head", "feature"]);
  assert.equal(await readFile(join(state, "create-env"), "utf8"), "GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0");
  assert.deepEqual(await ok(g, base + "/git/pr"), { gh: "ready", ...expected, upstream: "origin/feature", unpushed: 0 });
  // One more commit: pushed to the upstream first; gh's refusal is told in its words.
  await writeFile(join(g.workspace, "d.txt"), "d\n"); sh(["add", "-A"]); sh(["commit", "-q", "-m", "add d"]);
  await writeFile(join(state, "create-fails"), "");
  const failed = await refused(g, base + "/git/pr", 409, "GIT_PR_FAILED", "POST", { title: "Again", body: "" });
  assert.match(String(failed.message), /already exists/u);
  assert.equal(sh(["rev-parse", "refs/heads/feature"], bare), sh(["rev-parse", "HEAD"]), "pushed before gh was asked");

  // The default branch and a detached head are refused.
  sh(["checkout", "-q", "main"]);
  await refused(g, base + "/git/pr", 409, "GIT_PR_ON_DEFAULT_BRANCH", "POST", { title: "x", body: "" });
  sh(["checkout", "-q", "--detach", "feature"]);
  assert.equal((await ok(g, base + "/git/pr")).branch, null);
  await refused(g, base + "/git/pr", 409, "GIT_DETACHED_HEAD", "POST", { title: "x", body: "" });
  // A remote's URL is shown without a user or password in it, and GitHub is told as GitHub.
  sh(["checkout", "-q", "feature"]); sh(["remote", "set-url", "origin", "https://fixture-user:" + "fixture-" + "pass@github.com/o/r.git"]);
  const shown = await call(g, base + "/git/pr");
  assert.deepEqual(row(shown.data).remote, { name: "origin", url: "https://github.com/o/r.git", github: true }); assert.doesNotMatch(shown.text, /fixture-pass/u);
  assert.ok(!(await readFile(join(state, "calls"), "utf8")).includes("fixture-pass"));
});
