import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { branchSlug } from "../../src/infrastructure/workspace/worktree.js";
import { startWebServer, type WebServer, type WebServerOptions } from "../../src/web/server.js";

/*
 * A conversation in a Git worktree of its own (2026-11-14), over real HTTP, the real file store and real Git in temporary folders (deleted after); only the Harness is a
 * fixture. Git reads a configuration of the test's own, never the user's (an identity, no signing, `main` as the first branch).
 */

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
function row(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), JSON.stringify(value)); return value as Record<string, unknown>;
}
interface Fixture { root: string; real: string; data: string; workspace: string; trees: string | null; gateway: WebServer; origin: string; token: string; cookie: string; csrf: string; options: WebServerOptions }
async function fixture(t: test.TestContext, trees = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-worktree-")), workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json");
  await mkdir(workspace); await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><title>HarnessGateway fixture</title>");
  const source = { repository: "fixture", revision: "web", upstreamId: "peer", url: "https://example.invalid/web-peer" };
  const definitions = [{ id: "web-a", name: "Web a", aliases: [], binaryNames: [], configHints: [],
    controls: [{ id: "web-a-control", protocol: "acp-v1", executableNames: ["fixture-peer"], args: [peer, "acp-v1", "a", "basic"], env: { FIXTURE_TRACE: join(root, "trace.ndjson") },
      requiredExecutables: [], package: null, distribution: null, source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "web-a-control": { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  // Git's configuration for the Gateway's Git and the test's alike.
  const config = join(root, "gitconfig"), saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  await writeFile(config, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = "1";
  const data = join(root, "data"), options: WebServerOptions = { installations: "any", root: data, configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: join(root, "locks"),
    ...(trees ? { worktreeRoot: join(root, "trees") } : {}), application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) };
  const gateway = await startWebServer(options), parsed = new URL(gateway.url);
  const f: Fixture = { root, real: await realpath(root), data, workspace: configuration.workspace, trees: trees ? join(await realpath(root), "trees") : null, gateway, origin: parsed.origin,
    token: new URLSearchParams(parsed.hash.slice(1)).get("token")!, cookie: "", csrf: "", options };
  t.after(async () => {
    await f.gateway.close();
    for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function auth(f: Fixture): Promise<void> {
  const response = await fetch(f.origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: f.token }) });
  assert.equal(response.status, 200, await response.clone().text());
  f.cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!; f.csrf = String(row(await response.json()).csrfToken);
}
/** The Gateway stopped and started again on the same data: what it answers after comes from what it kept. */
async function reopen(f: Fixture): Promise<void> {
  await f.gateway.close();
  f.gateway = await startWebServer({ ...f.options, workspaceLockRoot: join(f.root, "locks") });
  const parsed = new URL(f.gateway.url); f.origin = parsed.origin; f.token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  await auth(f);
}
async function call(f: Fixture, path: string, method = "GET", input?: unknown): Promise<{ status: number; data: unknown; text: string }> {
  const response = await fetch(f.origin + path, { method, headers: { Cookie: f.cookie, Origin: f.origin, ...(method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": f.csrf }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const text = await response.text(); return { status: response.status, data: text === "" ? null : JSON.parse(text) as unknown, text };
}
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const keyOf = (commandId: string): string => createHash("sha256").update(commandId).digest("hex").slice(0, 8);
/** A repository of the test's: `app` with a file at the top and one below `packages/web`, one commit on `main`. */
async function repository(f: Fixture): Promise<{ readonly repo: string; readonly base: string }> {
  const repo = join(f.real, "app");
  await mkdir(join(repo, "packages", "web"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# app\n"); await writeFile(join(repo, "packages", "web", "index.ts"), "export const one = 1;\n");
  sh(repo, "init", "-q"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "first");
  return { repo, base: sh(repo, "rev-parse", "HEAD") };
}
async function inWorktree(f: Fixture, workspace: string, commandId: string): Promise<Record<string, unknown>> {
  const made = await call(f, "/api/v1/sessions", "POST", { workspace, worktree: true, selection: { harnessId: "web-a" }, commandId });
  assert.equal(made.status, 201, made.text);
  return row(row(made.data).head);
}
const worktreesOf = (repo: string): string[] => sh(repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) { const value = await read(); if (done(value)) return value; if (Date.now() > deadline) throw new Error(what + ": " + JSON.stringify(value)); await delay(25); }
}
const worktreeOf = async (f: Fixture, id: string) => { const answer = await call(f, `/api/v1/sessions/${id}/worktree`); assert.equal(answer.status, 200, answer.text); return row(answer.data); };
const headOf = async (f: Fixture, id: string) => { const answer = await call(f, `/api/v1/sessions/${id}`); assert.equal(answer.status, 200, answer.text); return row(row(answer.data).head); };
/** Waits until the conversation has no Turn in progress. */
const settled = (f: Fixture, id: string) => until(() => headOf(f, id), head => head.activeRunId === null && row(head.facts).settled === true, "the conversation did not settle");

test("a conversation started with worktree: true works in a worktree of its own: on hh/<8 hex> from HEAD at <root>/<repository>/hh-<8 hex>, kept with it (head and row, after a restart), made once per request (a repeat, two at once); a folder below the top is the same folder there; a folder in no repository is refused", async t => {
  const f = await fixture(t); await auth(f);
  const { repo, base } = await repository(f);
  // Refused before anything is made: no repository, no workspace, a worktree that is not true.
  const plain = join(f.real, "plain"); await mkdir(plain);
  const refused = await call(f, "/api/v1/sessions", "POST", { workspace: plain, worktree: true, selection: { harnessId: "web-a" }, commandId: "tree-plain" });
  assert.equal(refused.status, 400, refused.text); assert.equal(row(refused.data).code, "INVALID_INPUT"); assert.match(String(row(refused.data).message), /Git 仓库/u);
  for (const bad of [{ worktree: true }, { scratch: true, worktree: true }, { workspace: repo, worktree: false }, { workspace: repo, worktree: "yes" }])
    assert.equal((await call(f, "/api/v1/sessions", "POST", { ...bad, selection: { harnessId: "web-a" }, commandId: "tree-bad" })).status, 400, JSON.stringify(bad));
  assert.equal(existsSync(join(f.trees!, "plain")), false); assert.deepEqual(worktreesOf(repo), [repo]);

  const head = await inWorktree(f, repo, "tree-one"), key = keyOf("tree-one"), path = join(f.trees!, "app", "hh-" + key);
  assert.deepEqual(head.worktree, { root: repo, path, branch: "hh/" + key, baseSha: base });
  assert.equal(head.workspace, path);
  assert.equal(sh(path, "rev-parse", "--abbrev-ref", "HEAD"), "hh/" + key); assert.equal(sh(path, "rev-parse", "HEAD"), base);
  assert.deepEqual(worktreesOf(repo), [repo, path]);
  // The main checkout is left as it was: its branch, its files.
  assert.equal(sh(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main"); assert.equal(sh(repo, "status", "--porcelain"), "");
  const listed = (row((await call(f, "/api/v1/sessions")).data).sessions as unknown[]).map(row).find(item => item.id === head.id);
  assert.deepEqual(listed?.worktree, head.worktree);

  // A repeat answers the same conversation and makes no second worktree; so do two at once.
  const again = await inWorktree(f, repo, "tree-one");
  assert.equal(again.id, head.id); assert.deepEqual(worktreesOf(repo), [repo, path]);
  const [left, right] = await Promise.all([inWorktree(f, repo, "tree-two"), inWorktree(f, repo, "tree-two")]);
  assert.equal(left.id, right.id); assert.equal(worktreesOf(repo).length, 3);
  // A folder that is not a worktree of this repository at the place is not taken over.
  await mkdir(join(f.trees!, "app", "hh-" + keyOf("tree-taken")), { recursive: true });
  const taken = await call(f, "/api/v1/sessions", "POST", { workspace: repo, worktree: true, selection: { harnessId: "web-a" }, commandId: "tree-taken" });
  assert.equal(taken.status, 409, taken.text); assert.equal(row(taken.data).code, "GIT_WORKTREE_PATH_TAKEN");

  // Below the top: the same folder in the worktree; one only the main checkout has (not committed) is made there.
  const below = await inWorktree(f, join(repo, "packages", "web"), "tree-below"), belowPath = join(f.trees!, "app", "hh-" + keyOf("tree-below"));
  assert.equal(row(below.worktree).path, belowPath); assert.equal(below.workspace, join(belowPath, "packages", "web"));
  await mkdir(join(repo, "notes", "drafts"), { recursive: true });
  const fresh = await inWorktree(f, join(repo, "notes", "drafts"), "tree-fresh");
  assert.equal(fresh.workspace, join(f.trees!, "app", "hh-" + keyOf("tree-fresh"), "notes", "drafts")); assert.ok(existsSync(String(fresh.workspace)));

  // Kept with the conversation: after a restart its head and its row still carry it.
  await reopen(f);
  assert.deepEqual((await headOf(f, String(head.id))).worktree, head.worktree);
  const relisted = (row((await call(f, "/api/v1/sessions")).data).sessions as unknown[]).map(row).find(item => item.id === head.id);
  assert.deepEqual(relisted?.worktree, head.worktree);
  // Started in the folder as it is: no worktree.
  const plainRow = await call(f, "/api/v1/sessions", "POST", { workspace: repo, selection: { harnessId: "web-a" }, commandId: "tree-none" });
  assert.equal(row(row(plainRow.data).head).worktree, undefined); assert.equal(row(row(plainRow.data).head).workspace, repo);
});

test("without --worktree-dir the worktrees are beside the scratch root", async t => {
  const f = await fixture(t, false); await auth(f);
  const { repo } = await repository(f);
  const head = await inWorktree(f, repo, "beside");
  assert.equal(row(head.worktree).path, join(await realpath(f.data), "worktrees", "app", "hh-" + keyOf("beside")));
});

test("the branch is renamed once after the conversation's first title: the user's (Chinese kept, the rest made dashes), with -2 when taken, or its first message; a later title leaves it", async t => {
  const f = await fixture(t); await auth(f);
  const { repo } = await repository(f);
  const a = await inWorktree(f, repo, "name-a"), b = await inWorktree(f, repo, "name-b"), c = await inWorktree(f, repo, "name-c");
  const renamed = async (id: string, branch: string) => {
    await until(() => worktreeOf(f, id), view => view.branch === branch, "the branch was not renamed to " + branch);
    await until(() => headOf(f, id), head => row(head.worktree).branch === branch, "the new branch was not recorded");
  };
  assert.equal((await call(f, `/api/v1/sessions/${a.id}`, "PATCH", { title: "修复 登录页: Bug #12" })).status, 200);
  await renamed(String(a.id), "hh/修复-登录页-bug-12");
  assert.equal((await call(f, `/api/v1/sessions/${b.id}`, "PATCH", { title: "修复 登录页: Bug #12" })).status, 200);
  await renamed(String(b.id), "hh/修复-登录页-bug-12-2");
  // The first message names it when nothing did before.
  const sent = await call(f, `/api/v1/sessions/${c.id}/messages`, "POST", { text: "Add the README section\n\nwith what it needs", commandId: "name-c-first" });
  assert.equal(sent.status, 202, sent.text);
  await renamed(String(c.id), "hh/add-the-readme-section");
  await settled(f, String(c.id));
  // Once named, a new title does not rename it again.
  assert.equal((await call(f, `/api/v1/sessions/${a.id}`, "PATCH", { title: "Another name" })).status, 200);
  await delay(400);
  assert.equal((await worktreeOf(f, String(a.id))).branch, "hh/修复-登录页-bug-12");
  const branches = sh(repo, "branch", "--format=%(refname:short)").split("\n").sort();
  assert.deepEqual(branches, ["hh/add-the-readme-section", "hh/修复-登录页-bug-12", "hh/修复-登录页-bug-12-2", "main"].sort());
  // The names a title gives.
  assert.equal(branchSlug("  Fix: the LOGIN page!! "), "fix-the-login-page");
  assert.equal(branchSlug("Ärger mit café"), "Ärger-mit-café");
  assert.equal(branchSlug("🎉🎉"), "");
  assert.equal(branchSlug("x".repeat(60)), "x".repeat(48));
  assert.equal(branchSlug("a".repeat(47) + "-b"), "a".repeat(47));
  assert.equal(branchSlug("a" + "𠀀".repeat(30)), "a" + "𠀀".repeat(23));
});

test("GET …/worktree says the branch, what is not committed (untracked one by one) and whether another conversation works in it; also of a deleted conversation; 404 for one without", async t => {
  const f = await fixture(t); await auth(f);
  const { repo } = await repository(f);
  const head = await inWorktree(f, repo, "info-a"), id = String(head.id), path = String(row(head.worktree).path), key = keyOf("info-a");
  assert.deepEqual(await worktreeOf(f, id), { path, branch: "hh/" + key, dirty: 0, shared: false });
  // A change, a staged rename, two untracked files (one in a new folder): four.
  await writeFile(join(path, "README.md"), "# app\nmore\n"); sh(path, "mv", "packages/web/index.ts", "packages/web/main.ts");
  await writeFile(join(path, "new.txt"), "new\n"); await mkdir(join(path, "docs")); await writeFile(join(path, "docs", "a.md"), "a\n");
  assert.deepEqual(await worktreeOf(f, id), { path, branch: "hh/" + key, dirty: 4, shared: false });
  // A conversation it delegated to works in the same folder: shared. That one has no worktree of its own.
  const delegated = await call(f, `/api/v1/sessions/${id}/delegate`, "POST", { selection: { harnessId: "web-a" }, text: "look at the README", commandId: "info-child", messageCommandId: "info-child-message" });
  assert.equal(delegated.status, 201, delegated.text);
  const child = row(row(delegated.data).head);
  assert.equal(child.workspace, path); assert.equal(child.worktree, undefined);
  assert.equal((await worktreeOf(f, id)).shared, true);
  const none = await call(f, `/api/v1/sessions/${String(child.id)}/worktree`); assert.equal(none.status, 404); assert.equal(row(none.data).code, "WORKTREE_NOT_FOUND");
  const plain = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "web-a" }, commandId: "info-plain" });
  assert.equal((await call(f, `/api/v1/sessions/${String(row(row(plain.data).head).id)}/worktree`)).status, 404);
  assert.equal((await call(f, "/api/v1/sessions/session-nowhere/worktree")).status, 404);
  await settled(f, String(child.id));
  // Deleted: still answered (the page asks before erasing it), and the child still shares it.
  assert.equal((await call(f, `/api/v1/sessions/${id}`, "DELETE")).status, 204);
  assert.equal((await call(f, `/api/v1/sessions/${id}`)).status, 404);
  assert.deepEqual(await worktreeOf(f, id), { path, branch: "hh/" + key, dirty: 4, shared: true });
  // A worktree whose folder is gone is said to be missing.
  const gone = await inWorktree(f, repo, "info-gone"), gonePath = String(row(gone.worktree).path);
  await rm(gonePath, { recursive: true, force: true });
  assert.deepEqual(await worktreeOf(f, String(gone.id)), { path: gonePath, branch: "hh/" + keyOf("info-gone"), dirty: 0, shared: false, missing: true });
});

test("erasing with removeWorktree removes the worktree (uncommitted work with it, the branch and its commits kept) unless another conversation works in it; without it the worktree stays; purge-deleted counts what it removed", async t => {
  const f = await fixture(t); await auth(f);
  const { repo } = await repository(f);
  const erase = (id: string, input: unknown = {}) => call(f, `/api/v1/sessions/${id}/purge`, "POST", input);
  const remove = async (id: string) => assert.equal((await call(f, `/api/v1/sessions/${id}`, "DELETE")).status, 204);
  // Without the flag: erased, the worktree left alone.
  const kept = await inWorktree(f, repo, "purge-kept"), keptPath = String(row(kept.worktree).path);
  await remove(String(kept.id));
  const plain = await erase(String(kept.id)); assert.equal(plain.status, 204, plain.text);
  assert.ok(existsSync(keptPath)); assert.ok(worktreesOf(repo).includes(keptPath));
  // With it: a commit on its branch and work not committed; the worktree goes, the branch and the commit stay.
  const gone = await inWorktree(f, repo, "purge-gone"), gonePath = String(row(gone.worktree).path), goneBranch = "hh/" + keyOf("purge-gone");
  await writeFile(join(gonePath, "feature.txt"), "feature\n"); sh(gonePath, "add", "feature.txt"); sh(gonePath, "commit", "-q", "-m", "feature");
  const commit = sh(gonePath, "rev-parse", "HEAD");
  await writeFile(join(gonePath, "README.md"), "changed\n"); await writeFile(join(gonePath, "loose.txt"), "loose\n");
  await remove(String(gone.id));
  assert.equal((await erase(String(gone.id), { removeWorktree: "yes" })).status, 400);
  assert.equal((await erase(String(gone.id), { removeWorktree: true, more: 1 })).status, 400);
  const removed = await erase(String(gone.id), { removeWorktree: true });
  assert.equal(removed.status, 200, removed.text); assert.deepEqual(removed.data, { worktreeRemoved: true });
  assert.equal(existsSync(gonePath), false); assert.equal(worktreesOf(repo).includes(gonePath), false);
  assert.equal(sh(repo, "rev-parse", goneBranch), commit);
  assert.equal((await call(f, `/api/v1/sessions/${String(gone.id)}/worktree`)).status, 404);
  // Another conversation works in it (one it delegated to): erased, the worktree kept.
  const shared = await inWorktree(f, repo, "purge-shared"), sharedPath = String(row(shared.worktree).path);
  const delegated = await call(f, `/api/v1/sessions/${String(shared.id)}/delegate`, "POST", { selection: { harnessId: "web-a" }, text: "a part", commandId: "purge-child", messageCommandId: "purge-child-message" });
  assert.equal(delegated.status, 201, delegated.text); await settled(f, String(row(row(delegated.data).head).id));
  await remove(String(shared.id));
  const left = await erase(String(shared.id), { removeWorktree: true });
  assert.equal(left.status, 200, left.text); assert.deepEqual(left.data, { worktreeKept: "shared" }); assert.ok(existsSync(sharedPath));
  // A conversation with no worktree: erased, nothing said of one.
  const none = await call(f, "/api/v1/sessions", "POST", { selection: { harnessId: "web-a" }, commandId: "purge-none" }), noneId = String(row(row(none.data).head).id);
  await remove(noneId); assert.deepEqual((await erase(noneId, { removeWorktree: true })).data, {});
  // Archived and deleted conversations keep theirs; purge-deleted removes the worktrees no conversation left works in, and counts them.
  const one = await inWorktree(f, repo, "purge-one"), two = await inWorktree(f, repo, "purge-two"), three = await inWorktree(f, repo, "purge-three");
  assert.equal((await call(f, `/api/v1/sessions/${String(three.id)}`, "PATCH", { archived: true })).status, 200);
  await remove(String(one.id)); await remove(String(two.id));
  assert.ok(existsSync(String(row(one.worktree).path)) && existsSync(String(row(three.worktree).path)));
  const all = await call(f, "/api/v1/sessions/purge-deleted", "POST", { removeWorktree: true });
  assert.equal(all.status, 200, all.text); assert.deepEqual(all.data, { purged: 2, worktreesRemoved: 2 });
  for (const item of [one, two]) assert.equal(existsSync(String(row(item.worktree).path)), false);
  assert.ok(existsSync(String(row(three.worktree).path))); assert.ok(existsSync(keptPath)); assert.ok(existsSync(sharedPath));
  assert.deepEqual(new Set(worktreesOf(repo)), new Set([repo, keptPath, sharedPath, String(row(three.worktree).path)]));
  // Without the flag purge-deleted says what it always did.
  assert.deepEqual((await call(f, "/api/v1/sessions/purge-deleted", "POST", {})).data, { purged: 0 });
});

test("the Git endpoints work in a worktree workspace (its .git is a file; a folder below its top sees only itself): changes, a diff, the branch against main, the log, the branches, the header and a commit, the main checkout untouched", async t => {
  const f = await fixture(t); await auth(f);
  const { repo, base } = await repository(f);
  const head = await inWorktree(f, repo, "git-a"), id = String(head.id), path = String(row(head.worktree).path), branch = "hh/" + keyOf("git-a");
  const below = await inWorktree(f, join(repo, "packages", "web"), "git-below"), belowId = String(below.id), belowPath = String(row(below.worktree).path);
  const get = async (route: string, session = id) => { const answer = await call(f, `/api/v1/sessions/${session}/${route}`); assert.equal(answer.status, 200, route + ": " + answer.text); return row(answer.data); };
  // A commit on the worktree's branch, then work not committed.
  await writeFile(join(path, "feature.txt"), "f1\nf2\n"); sh(path, "add", "feature.txt"); sh(path, "commit", "-q", "-m", "Add the feature");
  await writeFile(join(path, "README.md"), "# app\nchanged\n"); await writeFile(join(path, "new.txt"), "n\n");
  assert.deepEqual((await get("git/changes")).files, [{ path: "README.md", status: "modified", added: 1, removed: 0 }, { path: "new.txt", status: "untracked", added: 1, removed: 0 }]);
  const scoped = await get("git/changes?scope=branch&base=main");
  assert.deepEqual((scoped.files as unknown[]).map(item => row(item).path), ["README.md", "feature.txt", "new.txt"]); assert.equal(row(scoped.base).sha, base);
  const diff = await get("git/diff?path=README.md"); assert.match(String(diff.diff), /\+changed/u);
  const untracked = await get("git/diff?path=new.txt"); assert.match(String(untracked.diff), /--- \/dev\/null/u);
  assert.deepEqual(((await get("git/log")).commits as unknown[]).map(item => row(item).subject), ["Add the feature", "first"]);
  const branches = await get("git/branches");
  assert.equal(branches.current, branch); assert.ok((branches.local as string[]).includes("main")); assert.equal(branches.defaultBranch, "main");
  const detail = await get("git"); assert.equal(detail.branch, branch); assert.equal((detail.files as unknown[]).length, 2);
  assert.deepEqual(row((await get("workspace")).git), { branch, dirty: 2 });
  const committed = await call(f, `/api/v1/sessions/${id}/git/commit`, "POST", { message: "From the page" });
  assert.equal(committed.status, 200, committed.text); assert.equal(row(committed.data).subject, "From the page");
  assert.equal(sh(path, "log", "-1", "--format=%s"), "From the page"); assert.equal(sh(path, "status", "--porcelain"), "");
  // The main checkout did not move and has none of it.
  assert.equal(sh(repo, "rev-parse", "HEAD"), base); assert.equal(sh(repo, "status", "--porcelain"), ""); assert.equal(existsSync(join(repo, "feature.txt")), false);
  // Below the top of another worktree: only its own folder.
  await writeFile(join(belowPath, "packages", "web", "index.ts"), "export const one = 2;\n"); await writeFile(join(belowPath, "README.md"), "outside\n");
  assert.deepEqual((await get("git/changes", belowId)).files, [{ path: "index.ts", status: "modified", added: 1, removed: 1 }]);
  assert.equal((await get("git/branches", belowId)).current, "hh/" + keyOf("git-below"));
});
