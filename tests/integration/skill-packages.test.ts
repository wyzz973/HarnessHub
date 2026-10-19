import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import type { CapabilitiesView, CapabilityChangeCheck, CapabilityChangeView, CapabilityHistory, SkillSourceListing, SkillUpdateView } from "../../src/contracts/capabilities.js";
import { application } from "../../src/cli/session-application.js";
import type { GithubFetch } from "../../src/infrastructure/capabilities/github.js";
import { blobId, folderTree, npxExcludedPath, treeId, type TreeItem } from "../../src/infrastructure/capabilities/skill-tree.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer } from "../../src/web/server.js";
import { homePathsIn } from "../../src/web/shown-paths.js";
import { capabilityHome, CREDENTIALS, officialInstalls } from "../fixtures/capability-home.js";

const macOnly = { skip: process.platform !== "darwin" && "capability changes run their Harness commands under macOS's sandbox (ADR-045)", timeout: 120000 };
type Files = Readonly<Record<string, { readonly body: string; readonly exec?: boolean }>>;
/** A repository on the fake GitHub: its commits by id (each the whole tree) and which one HEAD names. */
interface Repository { head: string; readonly commits: Map<string, Files> }
const SKILL = (name: string, body = "Use it.") => ({ body: "---\nname: " + name + "\ndescription: " + name + " does things\n---\n" + body + "\n" });
const commit = (n: number) => n.toString(16).padStart(40, "c");

/** The items of a folder of a commit, as git stores them. */
function items(files: Files, folder: string): TreeItem[] {
  const prefix = folder === "" ? "" : folder + "/";
  return Object.entries(files).filter(([path]) => path.startsWith(prefix)).map(([path, file]) => ({ path: path.slice(prefix.length), mode: file.exec ? "100755" : "100644", id: blobId(Buffer.from(file.body)) }));
}
function folders(files: Files): string[] { const set = new Set<string>(); for (const path of Object.keys(files)) { const parts = path.split("/"); for (let index = 1; index < parts.length; index++) set.add(parts.slice(0, index).join("/")); } return [...set].sort(); }
/** GitHub's archive of a commit: one top folder named after the repository, as codeload serves it. */
function archive(repo: string, sha: string, files: Files, extra: readonly { path: string; type: "SymbolicLink"; linkpath: string }[] = []): Buffer {
  const blocks: Buffer[] = [], root = repo + "-" + sha.slice(0, 7) + "/";
  const header = (fields: ConstructorParameters<typeof Header>[0]) => { const buffer = Buffer.alloc(512); new Header({ mtime: new Date(0), uid: 0, gid: 0, ...fields }).encode(buffer); blocks.push(buffer); };
  header({ path: root, type: "Directory", mode: 0o755, size: 0 });
  for (const folder of folders(files)) header({ path: root + folder + "/", type: "Directory", mode: 0o755, size: 0 });
  for (const [path, file] of Object.entries(files)) {
    const body = Buffer.from(file.body);
    header({ path: root + path, type: "File", mode: file.exec ? 0o755 : 0o644, size: body.length });
    blocks.push(body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  for (const link of extra) header({ path: root + link.path, type: "SymbolicLink", linkpath: link.linkpath, mode: 0o777, size: 0 });
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
/**
 * GitHub as HarnessHub reads it: the archive link redirecting to codeload with the commit, codeload's archive, and the
 * trees interface by ref or by a folder's tree id. Every request is logged; `limited` answers the trees interface with
 * its rate limit, and `elsewhere` makes the archive link redirect off GitHub.
 */
function fakeGithub(repos: ReadonlyMap<string, Repository>, links: ReadonlyMap<string, readonly { path: string; type: "SymbolicLink"; linkpath: string }[]> = new Map()) {
  const log: string[] = [], state = { limited: false, elsewhere: false };
  const fetcher: GithubFetch = async url => {
    log.push(url);
    const target = new URL(url);
    if (target.hostname === "github.com") {
      const match = /^\/([^/]+)\/([^/]+)\/archive\/(.+)\.tar\.gz$/u.exec(target.pathname), repo = match ? repos.get(match[1] + "/" + match[2]) : undefined;
      if (!match || !repo) return new Response("Not Found", { status: 404 });
      if (state.elsewhere) return new Response(null, { status: 302, headers: { location: "https://evil.example/archive.tar.gz" } });
      return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/" + match[1] + "/" + match[2] + "/tar.gz/" + repo.head } });
    }
    if (target.hostname === "codeload.github.com") {
      const match = /^\/([^/]+)\/([^/]+)\/tar\.gz\/([a-f0-9]{40})$/u.exec(target.pathname), name = match ? match[1] + "/" + match[2] : "", files = match ? repos.get(name)?.commits.get(match[3]!) : undefined;
      if (!match || !files) return new Response("Not Found", { status: 404 });
      return new Response(new Uint8Array(archive(match[2]!, match[3]!, files, links.get(name + "@" + match[3]) ?? [])), { status: 200, headers: { "content-type": "application/x-gzip" } });
    }
    if (target.hostname === "api.github.com") {
      if (state.limited) return new Response("{\"message\":\"API rate limit exceeded\"}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792329035" } });
      const match = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/u.exec(target.pathname), repo = match ? repos.get(match[1] + "/" + match[2]) : undefined;
      if (!match || !repo || target.searchParams.get("recursive") !== "1") return new Response("Not Found", { status: 404 });
      const ref = decodeURIComponent(match[3]!);
      const listed = (files: Files, folder: string) => {
        const prefix = folder === "" ? "" : folder + "/";
        const blobs = Object.entries(files).filter(([path]) => path.startsWith(prefix)).map(([path, file]) => ({ path: path.slice(prefix.length), mode: file.exec ? "100755" : "100644", type: "blob", sha: blobId(Buffer.from(file.body)) }));
        const trees = folders(files).filter(path => path.startsWith(prefix)).map(path => ({ path: path.slice(prefix.length), mode: "040000", type: "tree", sha: treeId(items(files, path))! }));
        return Response.json({ sha: "0".repeat(40), truncated: false, tree: [...trees, ...blobs] });
      };
      if (ref === "HEAD") return listed(repo.commits.get(repo.head)!, "");
      for (const files of repo.commits.values()) for (const folder of folders(files)) if (treeId(items(files, folder)) === ref) return listed(files, folder);
      return new Response("Not Found", { status: 404 });
    }
    return new Response("unexpected host", { status: 599 });
  };
  return { fetcher, log, state };
}

/** A Gateway on a private home with the official installations' fixture files and a fake GitHub, through its formal entry. */
async function gateway(t: test.TestContext, github: GithubFetch, prepare: (home: string) => Promise<void> = async () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-packages-"))), closers: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace); await capabilityHome(home, join(root, "elsewhere")); await prepare(home);
  const environment = { home, values: { HOME: home, PATH: [...await officialInstalls(home), "/usr/bin", "/bin"].join(":") } };
  const server = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, pathOnly: true }), port: 0, github,
    application: (data, publish) => application(data, publish, { nativeEnvironment: environment, installations: "official", management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") }) });
  closers.push(() => server.close());
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = (await boot.json() as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const answers: unknown[] = [];
  const call = async <T>(path: string, body?: unknown): Promise<{ status: number; value: T }> => {
    const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as T; answers.push(value);
    return { status: response.status, value };
  };
  const apply = (fingerprint: string, commandId: string) => call<CapabilityChangeView>("/capabilities/changes", { fingerprint, commandId });
  const clean = async () => {
    const text = JSON.stringify(answers);
    for (const secret of CREDENTIALS) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual(homePathsIn(answers, [home], 1 << 20), []);
    assert.deepEqual((await readdirSafe(home)).filter(name => name.startsWith("ran-")), []);
  };
  return { root, home, shared: join(home, ".agents", "skills"), call, apply, clean };
}
async function readdirSafe(path: string): Promise<string[]> { try { return (await import("node:fs/promises")).readdir(path); } catch { return []; } }
async function tree(path: string): Promise<string | null> { return (await folderTree(path)).id; }
const copyOf = (files: Files, folder: string) => treeId(items(files, folder).filter(item => !npxExcludedPath(item.path)));

const SKILLS_C1: Files = { "skills/alpha-tools/SKILL.md": SKILL("alpha-tools"), "skills/alpha-tools/scripts/run.sh": { body: "#!/bin/sh\necho v1\n", exec: true }, "skills/alpha-tools/metadata.json": { body: "{\"v\":1}" },
  "skills/alpha-tools/old.md": { body: "old\n" }, "skills/beta/SKILL.md": SKILL("beta"), "skills/gamma/SKILL.md": SKILL("gamma"), "README.md": { body: "readme" } };
const SKILLS_C2: Files = { ...SKILLS_C1, "skills/alpha-tools/SKILL.md": SKILL("alpha-tools", "Use it, version two."), "skills/alpha-tools/new.md": { body: "new\n" } };
delete (SKILLS_C2 as Record<string, unknown>)["skills/alpha-tools/old.md"];

test("G064-W9 through the formal Gateway, skills are added from a GitHub repository, updated from it and undone, each shown first, and a folder changed locally is overwritten only when asked", macOnly, async t => {
  const repos = new Map<string, Repository>([["acme/skills", { head: commit(1), commits: new Map([[commit(1), SKILLS_C1], [commit(2), SKILLS_C2]]) }]]);
  const github = fakeGithub(repos, new Map([["acme/skills@" + commit(1), [{ path: "skills/beta/alias.md", type: "SymbolicLink" as const, linkpath: "SKILL.md" }]], ["acme/skills@" + commit(2), [{ path: "skills/beta/alias.md", type: "SymbolicLink" as const, linkpath: "SKILL.md" }]]]));
  const f = await gateway(t, github.fetcher), lock = join(f.home, ".agents", ".skill-lock.json"), lockBefore = await readFile(lock);
  // The repository's skills: one new, one refused for its link, one in conflict with a different folder of the same name.
  const listing = await f.call<SkillSourceListing>("/capabilities/skill-sources?source=acme/skills");
  assert.equal(listing.status, 200, JSON.stringify(listing.value));
  assert.deepEqual([listing.value.repository, listing.value.commit], ["https://github.com/acme/skills", commit(1)]);
  assert.deepEqual(listing.value.skills.map(skill => [skill.installName, skill.state, skill.files, skill.executables]), [["alpha-tools", "new", 3, 1], ["beta", "refused", 1, 0], ["gamma", "conflict", 1, 0]]);
  assert.match(listing.value.skills[1]!.reason ?? "", /链接/u);
  // The check shows the folder and writes nothing.
  const addCheck = await f.call<CapabilityChangeCheck>("/capabilities/skill-add?" + new URLSearchParams({ listing: listing.value.id, names: "alpha-tools" }));
  assert.equal(addCheck.status, 200, JSON.stringify(addCheck.value));
  assert.equal(addCheck.value.blocked, null);
  assert.deepEqual(addCheck.value.skills?.map(plan => [plan.name, plan.folder, plan.action, plan.files, plan.executables]), [["alpha-tools", "~/.agents/skills/alpha-tools", "add", 3, 1]]);
  assert.deepEqual(addCheck.value.source, { repository: "https://github.com/acme/skills", ref: null, commit: commit(1) });
  assert.match(addCheck.value.notes[0]!, /不改任何 Harness 的模型或登录配置/u);
  assert.ok(addCheck.value.notes.some(note => note.includes("metadata.json")) && addCheck.value.notes.some(note => note.includes("1 个可执行文件")) && addCheck.value.notes.some(note => note.includes("Claude Code 不读共享目录")));
  await assert.rejects(lstat(join(f.shared, "alpha-tools")), "a check writes nothing");
  const conflict = await f.call<CapabilityChangeCheck>("/capabilities/skill-add?" + new URLSearchParams({ listing: listing.value.id, names: "gamma" }));
  assert.match(conflict.value.blocked ?? "", /来源不同/u);
  // Applied under the Gateway's umask 077: the folder gets the modes a terminal install gets, without metadata.json; the lock is not touched.
  const strict = process.umask(0o077);
  let added: Awaited<ReturnType<typeof f.apply>>;
  try { added = await f.apply(addCheck.value.fingerprint, "add-alpha-tools"); } finally { process.umask(strict); }
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.deepEqual([added.value.status, added.value.kind, added.value.skills?.[0]?.before, added.value.skills?.[0]?.after], ["applied", "skill-add", null, copyOf(SKILLS_C1, "skills/alpha-tools")]);
  const folder = join(f.shared, "alpha-tools");
  assert.deepEqual([(await stat(folder)).mode & 0o777, (await stat(join(folder, "SKILL.md"))).mode & 0o777, (await stat(join(folder, "scripts", "run.sh"))).mode & 0o777], [0o755, 0o644, 0o755]);
  await assert.rejects(lstat(join(folder, "metadata.json")));
  assert.deepEqual(await readFile(lock), lockBefore, "adding writes no lock entry");
  const view = await f.call<CapabilitiesView>("/capabilities"), entry = view.value.entries.find(item => item.kind === "skill" && item.name === "alpha-tools");
  assert.deepEqual([entry?.owner, entry?.source, entry?.shared?.folder], ["harnesshub", "https://github.com/acme/skills", "~/.agents/skills/alpha-tools"]);
  assert.ok(entry?.edges.some(edge => edge.harnessId === "codex" && edge.status === "active"), "a Harness reading the shared directory sees it");
  // Upstream moves on: the update is found, shown file by file, and applied.
  repos.get("acme/skills")!.head = commit(2);
  const updates = await f.call<SkillUpdateView>("/capabilities/skill-updates?refresh=1");
  assert.equal(updates.status, 200, JSON.stringify(updates.value));
  assert.deepEqual(updates.value.skills.find(item => item.name === "alpha-tools"), { name: "alpha-tools", manager: "harnesshub", repository: "https://github.com/acme/skills", state: "available", modified: false, reason: null });
  assert.equal(updates.value.skills.find(item => item.name === "alpha")?.state, "unsupported", "a lock entry without its folder hash is not one HarnessHub updates");
  const updateCheck = await f.call<CapabilityChangeCheck>("/capabilities/skill-update?name=alpha-tools");
  assert.equal(updateCheck.value.blocked, null, JSON.stringify(updateCheck.value));
  assert.deepEqual(updateCheck.value.skills?.[0]?.changes, [{ path: "SKILL.md", action: "change" }, { path: "new.md", action: "add" }, { path: "old.md", action: "remove" }]);
  assert.equal(updateCheck.value.lock, null, "a skill HarnessHub installed has no lock entry to change");
  const updated = await f.apply(updateCheck.value.fingerprint, "update-alpha-tools");
  assert.equal(updated.value.status, "applied", JSON.stringify(updated.value));
  assert.equal(await tree(folder), copyOf(SKILLS_C2, "skills/alpha-tools"));
  assert.match((await f.call<CapabilityChangeCheck>("/capabilities/skill-update?name=alpha-tools")).value.blocked ?? "", /^无需更新/u);
  // Undo puts the first version back from its snapshot.
  const history = await f.call<CapabilityHistory>("/capabilities/history");
  assert.deepEqual([history.value.changes[0]?.kind, history.value.snapshots.count >= 1, history.value.snapshots.keep], ["skill-update", true, 50]);
  const undoCheck = await f.call<CapabilityChangeCheck>("/capabilities/changes/" + updated.value.id + "/undo");
  assert.equal(undoCheck.value.blocked, null, JSON.stringify(undoCheck.value));
  assert.equal((await f.apply(undoCheck.value.fingerprint, "undo-update")).value.status, "applied");
  assert.equal(await tree(folder), copyOf(SKILLS_C1, "skills/alpha-tools"));
  // A local change is never overwritten silently: the update asks to overwrite and then says how many files it replaces.
  await appendFile(join(folder, "SKILL.md"), "My own note.\n");
  const refused = await f.call<CapabilityChangeCheck>("/capabilities/skill-update?name=alpha-tools");
  assert.match(refused.value.blocked ?? "", /本地改过/u);
  const overwrite = await f.call<CapabilityChangeCheck>("/capabilities/skill-update?name=alpha-tools&overwrite=true");
  assert.deepEqual([overwrite.value.blocked, overwrite.value.skills?.[0]?.overwrites], [null, 1]);
  assert.equal((await f.apply(overwrite.value.fingerprint, "overwrite-alpha-tools")).value.status, "applied");
  assert.equal(await tree(folder), copyOf(SKILLS_C2, "skills/alpha-tools"));
  // Only GitHub's own hosts were asked.
  assert.deepEqual([...new Set(github.log.map(url => new URL(url).hostname))].sort(), ["api.github.com", "codeload.github.com", "github.com"]);
  await f.clean();
});

const TOOLS_T1: Files = { "skills/omega/SKILL.md": SKILL("omega"), "skills/omega/metadata.json": { body: "{\"v\":1}" }, "skills/omega/guide.md": { body: "guide v1\n" } };
const TOOLS_T2: Files = { ...TOOLS_T1, "skills/omega/guide.md": { body: "guide v2\n" } };
const OMEGA_LOCK = { source: "acme/tools", sourceType: "github", sourceUrl: "https://github.com/acme/tools.git", skillPath: "skills/omega/SKILL.md", skillFolderHash: treeId(items(TOOLS_T1, "skills/omega"))!,
  installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", pluginName: "tools" };

test("G064-W10 a skill npx skills installed is updated in its lock entry alone, deleted with every link into it, its orphaned switch setting cleared, and the deletion undone", macOnly, async t => {
  const repos = new Map<string, Repository>([["acme/tools", { head: commit(12), commits: new Map([[commit(11), TOOLS_T1], [commit(12), TOOLS_T2]]) }]]);
  const github = fakeGithub(repos), lockText = { value: "" };
  const f = await gateway(t, github.fetcher, async home => {
    // Installed the way npx skills does: the copy without metadata.json, a relative link for Claude Code, and its lock entry.
    const omega = join(home, ".agents", "skills", "omega");
    await mkdir(omega, { recursive: true }); await writeFile(join(omega, "SKILL.md"), TOOLS_T1["skills/omega/SKILL.md"]!.body); await writeFile(join(omega, "guide.md"), "guide v1\n");
    await symlink("../../.agents/skills/omega", join(home, ".claude", "skills", "omega"));
    const lock = join(home, ".agents", ".skill-lock.json"), value = JSON.parse(await readFile(lock, "utf8")) as { skills: Record<string, unknown> };
    value.skills.omega = OMEGA_LOCK; lockText.value = JSON.stringify(value, null, 2); await writeFile(lock, lockText.value);
  });
  const lock = join(f.home, ".agents", ".skill-lock.json"), omega = join(f.shared, "omega");
  const updates = await f.call<SkillUpdateView>("/capabilities/skill-updates?refresh=1");
  assert.deepEqual(updates.value.skills.find(item => item.name === "omega"), { name: "omega", manager: "skills-cli", repository: "https://github.com/acme/tools", state: "available", modified: null, reason: null });
  // The check compares the copy with the recorded version (by its tree id) and finds it unchanged; the lock diff is its two values.
  const check = await f.call<CapabilityChangeCheck>("/capabilities/skill-update?name=omega");
  assert.equal(check.value.blocked, null, JSON.stringify(check.value));
  assert.equal(check.value.current, "other");
  // The diff shows one hunk from the first changed line to the last; between them only installedAt, unchanged on both sides.
  const changed = (check.value.lock?.diff ?? "").split("\n").filter(line => /^[+-]\s/u.test(line)), removed = changed.filter(line => line.startsWith("-")), added = changed.filter(line => line.startsWith("+"));
  assert.deepEqual(removed.map(line => /"(\w+)"/u.exec(line)?.[1]), ["skillFolderHash", "installedAt", "updatedAt"]);
  assert.deepEqual(added.map(line => /"(\w+)"/u.exec(line)?.[1]), ["skillFolderHash", "installedAt", "updatedAt"]);
  assert.equal(removed[1]!.slice(1), added[1]!.slice(1), "installedAt is the same on both sides");
  const updated = await f.apply(check.value.fingerprint, "update-omega");
  assert.equal(updated.value.status, "applied", JSON.stringify(updated.value));
  assert.equal(await tree(omega), copyOf(TOOLS_T2, "skills/omega"));
  const afterUpdate = JSON.parse(await readFile(lock, "utf8")) as { skills: Record<string, Record<string, unknown>> };
  assert.deepEqual({ ...afterUpdate.skills.omega, updatedAt: "t" }, { ...OMEGA_LOCK, skillFolderHash: treeId(items(TOOLS_T2, "skills/omega")), updatedAt: "t" }, "only the folder hash and update time changed");
  assert.equal((await readFile(lock, "utf8")).replace(/"skillFolderHash": "[0-9a-f]{40}",\n(\s+)"installedAt": "2026-01-01T00:00:00.000Z",\n\s+"updatedAt": "[^"]+"/u, ""),
    lockText.value.replace(/"skillFolderHash": "[0-9a-f]{40}",\n(\s+)"installedAt": "2026-01-01T00:00:00.000Z",\n\s+"updatedAt": "[^"]+"/u, ""), "every other byte of the lock stays");
  let history = await f.call<CapabilityHistory>("/capabilities/history");
  assert.equal(history.value.backups[0]?.file, "~/.agents/.skill-lock.json", "the lock was backed up before it was written");
  // Turned off in Claude Code, then deleted: the folder, the link npx skills made and the lock entry go; the switch setting stays, listed.
  const off = await f.call<CapabilityChangeCheck>("/capabilities/skill-switch?" + new URLSearchParams({ harnessId: "claude", name: "omega", enabled: "false" }));
  assert.equal(off.status, 200, JSON.stringify(off.value));
  assert.equal((await f.apply(off.value.fingerprint, "omega-off")).value.status, "applied");
  const deleteCheck = await f.call<CapabilityChangeCheck>("/capabilities/skill-delete?name=omega");
  assert.equal(deleteCheck.value.blocked, null, JSON.stringify(deleteCheck.value));
  assert.deepEqual(deleteCheck.value.links.map(link => [link.path, link.target, link.action, link.owner]), [["~/.claude/skills/omega", "../../.agents/skills/omega", "remove", "other"]]);
  assert.deepEqual(deleteCheck.value.orphans, [{ harnessId: "claude", file: "~/.claude/settings.json" }]);
  assert.match(deleteCheck.value.lock?.diff ?? "", /^-\s+"omega": \{/mu);
  const deleted = await f.apply(deleteCheck.value.fingerprint, "delete-omega");
  assert.equal(deleted.value.status, "applied", JSON.stringify(deleted.value));
  await assert.rejects(lstat(omega)); await assert.rejects(lstat(join(f.home, ".claude", "skills", "omega")));
  assert.equal(Object.hasOwn((JSON.parse(await readFile(lock, "utf8")) as { skills: object }).skills, "omega"), false);
  // The orphaned setting is listed and cleared through the usual switch check.
  history = await f.call<CapabilityHistory>("/capabilities/history");
  const orphan = history.value.orphans.find(item => item.subject === "omega");
  assert.deepEqual([orphan?.harnessId, orphan?.file], ["claude", "~/.claude/settings.json"]);
  const clear = await f.call<CapabilityChangeCheck>("/capabilities/orphans/" + orphan!.id + "/clear");
  assert.equal(clear.value.blocked, null, JSON.stringify(clear.value));
  assert.match(clear.value.diff ?? "", /^-\s+"omega": "off"/mu);
  assert.equal((await f.apply(clear.value.fingerprint, "clear-omega")).value.status, "applied");
  assert.deepEqual((await f.call<CapabilityHistory>("/capabilities/history")).value.orphans, []);
  // The deletion undone: the folder from its snapshot, the link as it was written, the lock entry as it was.
  const undo = await f.call<CapabilityChangeCheck>("/capabilities/changes/" + deleted.value.id + "/undo");
  assert.equal(undo.value.blocked, null, JSON.stringify(undo.value));
  assert.equal((await f.apply(undo.value.fingerprint, "undo-delete")).value.status, "applied");
  assert.equal(await tree(omega), copyOf(TOOLS_T2, "skills/omega"));
  assert.equal(await readlink(join(f.home, ".claude", "skills", "omega")), "../../.agents/skills/omega");
  assert.deepEqual((JSON.parse(await readFile(lock, "utf8")) as { skills: Record<string, unknown> }).skills.omega, afterUpdate.skills.omega);
  await f.clean();
});

test("G064-W11 a redirect off GitHub, a rate limit and a change after confirming are refused without writing, and the downgrade to v1 keeps every other record", macOnly, async t => {
  const repos = new Map<string, Repository>([["acme/skills", { head: commit(1), commits: new Map([[commit(1), SKILLS_C1], [commit(2), SKILLS_C2]]) }]]);
  const github = fakeGithub(repos), f = await gateway(t, github.fetcher);
  github.state.elsewhere = true;
  const away = await f.call<{ code: string; message: string }>("/capabilities/skill-sources?source=acme/skills");
  assert.deepEqual([away.status, away.value.code], [502, "CAPABILITY_COMMAND_FAILED"]);
  assert.match(away.value.message, /evil\.example，HarnessHub 不跟随/u);
  assert.equal(github.log.some(url => url.includes("evil.example")), false, "the other host was never asked");
  github.state.elsewhere = false;
  const listing = await f.call<SkillSourceListing>("/capabilities/skill-sources?source=https://github.com/acme/skills/tree/main/skills/alpha-tools");
  assert.deepEqual(listing.value.skills.map(skill => skill.installName), ["alpha-tools"], "a folder of the repository narrows the list");
  const check = await f.call<CapabilityChangeCheck>("/capabilities/skill-add?" + new URLSearchParams({ listing: listing.value.id, names: "alpha-tools" }));
  // Someone puts a folder of that name in place after the check: nothing is written.
  await mkdir(join(f.shared, "alpha-tools")); await writeFile(join(f.shared, "alpha-tools", "SKILL.md"), "mine");
  const late = await f.apply(check.value.fingerprint, "late-add");
  assert.deepEqual([late.status, (late.value as unknown as { code: string }).code], [409, "CAPABILITY_TARGET_CHANGED"]);
  assert.equal(await readFile(join(f.shared, "alpha-tools", "SKILL.md"), "utf8"), "mine");
  await rm(join(f.shared, "alpha-tools"), { recursive: true });
  const added = await f.apply((await f.call<CapabilityChangeCheck>("/capabilities/skill-add?" + new URLSearchParams({ listing: listing.value.id, names: "alpha-tools" }))).value.fingerprint, "add");
  assert.equal(added.value.status, "applied");
  // The trees interface out of its anonymous budget: the update check says so, with the reset time.
  github.state.limited = true;
  const limited = await f.call<SkillUpdateView>("/capabilities/skill-updates?refresh=1");
  assert.deepEqual([limited.value.skills.find(item => item.name === "alpha-tools")?.state], ["unknown"]);
  assert.match(limited.value.skills.find(item => item.name === "alpha-tools")?.reason ?? "", /额度（每小时 60 次）已用完/u);
  // The documented downgrade: v1's tables only, the skill changes gone, every other record kept.
  const database = join(f.root, "data", "capabilities", "capabilities.sqlite"), copy = join(f.root, "downgrade.sqlite");
  await writeFile(copy, await readFile(database));
  const db = new DatabaseSync(copy);
  try {
    db.prepare("INSERT INTO capability_changes(id,command_id,payload_hash,at,view_json) VALUES(?,?,?,?,?)").run("11111111-1111-4111-8111-111111111111", "kept", "h", "2026-10-18T00:00:00.000Z", JSON.stringify({ kind: "skill-switch" }));
    // A v4 database goes back to v3 first (the instructions), then to v2 (the MCP list), then to v1.
    db.exec(await readFile(new URL("../../../tools/capabilities-v5-to-v4.sql", import.meta.url), "utf8"));
    db.exec(await readFile(new URL("../../../tools/capabilities-v4-to-v3.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
    db.exec(await readFile(new URL("../../../tools/capabilities-v3-to-v2.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    db.exec(await readFile(new URL("../../../tools/capabilities-v2-to-v1.sql", import.meta.url), "utf8"));
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ["capability_backups", "capability_changes", "capability_ledger", "capability_owner"]);
    assert.deepEqual(db.prepare("SELECT command_id FROM capability_changes").all().map(row => row.command_id), ["kept"]);
  } finally { db.close(); }
  await f.clean();
});
