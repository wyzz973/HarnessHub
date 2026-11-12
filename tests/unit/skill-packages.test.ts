import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { c as createTar, Header, Pax } from "tar";
import { CapabilityError } from "../../src/contracts/capabilities.js";
import { listArchive, parseGithubSource, settledCommit } from "../../src/infrastructure/capabilities/github.js";
import { editLock, findSkills, linksInto, lockSkills, SkillSnapshots, skillFolderName, writeSkill } from "../../src/infrastructure/capabilities/skill-packages.js";
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, blobId, folderTree, npxExcluded, npxExcludedPath, remoteFolderTree, treeId } from "../../src/infrastructure/capabilities/skill-tree.js";
import type { HarnessReadTable } from "../../src/adapters/capability-reads.js";

test("a skill folder is held to bounds only a directory that is not a skill reaches: 4,500 files and a 70 MiB file, both refused before, are read", async t => {
  const root = await temporary(t, "skill-bounds-"), skill = join(root, "big");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: big\ndescription: A large skill\n---\n");
  await Promise.all(Array.from({ length: 4500 }, (_, index) => writeFile(join(skill, "file-" + index + ".txt"), String(index))));
  await writeFile(join(skill, "model.bin"), Buffer.alloc(70 * 1024 * 1024));
  const tree = await folderTree(skill);
  assert.equal(tree.files, 4502); assert.ok(tree.bytes > 70 * 1024 * 1024);
  assert.ok(MAX_SKILL_FILES >= 50_000 && MAX_SKILL_BYTES >= 1024 * 1024 * 1024, "the bounds are far above the former 4,000 files and 64 MB");
});

async function temporary(t: test.TestContext, prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
/** The fixture whose ids real git computed (git 2.x, `git rev-parse HEAD:skill`): files at several depths, an executable, a link, and what npx skills leaves out. */
async function gitFixture(root: string): Promise<string> {
  const skill = join(root, "skill");
  for (const folder of ["scripts", "references/sub", "a", "empty", "__pycache__"]) await mkdir(join(skill, folder), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\nBody\n");
  await writeFile(join(skill, "scripts", "run.sh"), "#!/bin/sh\necho hi\n"); await chmod(join(skill, "scripts", "run.sh"), 0o755);
  await writeFile(join(skill, "references", "a.md"), "a\n"); await writeFile(join(skill, "references", "sub", "b.md"), "b\n");
  await writeFile(join(skill, "a", "x"), "x"); await writeFile(join(skill, "a.md"), "dot"); await writeFile(join(skill, "a-b"), "dash");
  await symlink("SKILL.md", join(skill, "link")); await writeFile(join(skill, "metadata.json"), "{}"); await writeFile(join(skill, "__pycache__", "c.pyc"), "c");
  return skill;
}

test("G064-W8 a folder's tree id is git's: sorting, executables, links and empty folders, with and without what npx skills leaves out", async t => {
  const skill = await gitFixture(await temporary(t, "skill-tree-"));
  assert.equal(blobId(Buffer.from("---\nname: demo\ndescription: A demo skill\n---\nBody\n")), "f030aa0cf1af314177e79f88ec988b24eb3988a6");
  const full = await folderTree(skill), copy = await folderTree(skill, npxExcluded);
  assert.equal(full.id, "1a63f47c0a413b4e00675b4adfb3c3d5c8797d5f", "the id git gives the folder");
  assert.equal(copy.id, "0754738a7ebc5c2eb03652239b5f40db303775e6", "the id git gives it without metadata.json and __pycache__");
  assert.deepEqual([full.files, full.executables, full.links], [10, 1, 1]);
  // The same files listed by GitHub's trees interface give the same ids, folders included.
  const remote = full.items.map(item => ({ path: "skills/demo/" + item.path, mode: item.mode, type: "blob", sha: item.id }));
  assert.equal(remoteFolderTree(remote, "skills/demo", () => false), full.id);
  assert.equal(remoteFolderTree(remote, "skills/demo", npxExcludedPath), copy.id);
  assert.equal(treeId([]), null);
  assert.throws(() => treeId([{ path: "../x", mode: "100644", id: "0".repeat(40) }]), CapabilityError, "a path leaving the folder is refused");
  assert.deepEqual([npxExcludedPath("metadata.json"), npxExcludedPath("docs/metadata.json"), npxExcludedPath(".git/config"), npxExcludedPath("a/__pycache__/x.pyc"), npxExcludedPath("metadata.json.bak")],
    [true, true, true, true, false]);
});

test("G064-W8 folder names follow npx skills, and only GitHub repositories are accepted as sources", () => {
  assert.deepEqual(["react-best-practices", "Upper Case Name", "a__b.c", "  ..hidden..  ", "café", "..", "///"].map(skillFolderName), ["react-best-practices", "upper-case-name", "a__b.c", "hidden", "caf", null, null]);
  assert.deepEqual(parseGithubSource("vercel-labs/agent-skills"), { owner: "vercel-labs", repo: "agent-skills", ref: null, path: null });
  assert.deepEqual(parseGithubSource("acme/skills#release/v2"), { owner: "acme", repo: "skills", ref: "release/v2", path: null });
  assert.deepEqual(parseGithubSource("https://github.com/acme/skills.git"), { owner: "acme", repo: "skills", ref: null, path: null });
  assert.deepEqual(parseGithubSource("https://github.com/acme/skills/tree/main/skills/alpha"), { owner: "acme", repo: "skills", ref: "main", path: "skills/alpha" });
  // Invalid samples: another host, plain HTTP, credentials, a query, a ref or folder leaving the repository, extra parts.
  for (const input of ["https://gitlab.com/acme/skills", "http://github.com/acme/skills", "https://user:pass@github.com/acme/skills", "https://github.com/acme/skills?ref=main", "acme/skills#../main",
    "https://github.com/acme/skills/tree/main/../x", "acme/skills/extra", "acme", "", "-x/skills", "acme/skills#a#b", "https://github.com/acme/skills/blob/main/SKILL.md"])
    assert.throws(() => parseGithubSource(input), (error: unknown) => error instanceof CapabilityError && error.code === "INVALID_INPUT", input);
});

/** A gzip tar of `entries`, with headers written as given, so unsafe archives can be made. */
function rawTar(entries: readonly { readonly path: string; readonly type?: "File" | "Directory" | "SymbolicLink"; readonly body?: string; readonly linkpath?: string; readonly mode?: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? ""), header = Buffer.alloc(512);
    new Header({ path: entry.path, type: entry.type ?? "File", size: entry.type === "File" || entry.type === undefined ? body.length : 0, mode: entry.mode ?? 0o644, mtime: new Date(0), uid: 0, gid: 0, ...(entry.linkpath ? { linkpath: entry.linkpath } : {}) }).encode(header);
    blocks.push(header);
    if (body.length && (entry.type ?? "File") === "File") blocks.push(body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const SKILL = (name: string, extra = "") => "---\nname: " + name + "\ndescription: " + name + " does things\n" + extra + "---\nUse it.\n";

test("G064-W8 a repository archive lists its skills with what a copy holds, and refuses links, special entries and unsafe paths", async t => {
  const root = await temporary(t, "skill-archive-"), repo = join(root, "skills-abc123");
  for (const folder of ["skills/alpha/scripts", "skills/alpha/nested", "skills/linked", "skills/nameless", "Upper"]) await mkdir(join(repo, folder), { recursive: true });
  await writeFile(join(repo, "skills/alpha/SKILL.md"), SKILL("alpha")); await writeFile(join(repo, "skills/alpha/metadata.json"), "{\"version\":1}");
  await writeFile(join(repo, "skills/alpha/scripts/run.sh"), "#!/bin/sh\n"); await chmod(join(repo, "skills/alpha/scripts/run.sh"), 0o755);
  await writeFile(join(repo, "skills/alpha/nested/SKILL.md"), SKILL("inner"));
  await writeFile(join(repo, "skills/linked/SKILL.md"), SKILL("linked")); await symlink("SKILL.md", join(repo, "skills/linked/alias.md"));
  await writeFile(join(repo, "skills/nameless/SKILL.md"), "---\ndescription: no name\n---\n");
  await writeFile(join(repo, "Upper/SKILL.md"), SKILL("Upper Case Tool")); await mkdir(join(repo, ".git")); await writeFile(join(repo, ".git/SKILL.md"), SKILL("ignored"));
  await writeFile(join(repo, "README.md"), "readme");
  const archive = Buffer.from(await new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; createTar({ gzip: true, cwd: root, portable: true }, ["skills-abc123"]).on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject); }));
  const listing = await listArchive(archive), skills = findSkills(listing, null);
  assert.deepEqual(skills.map(skill => [skill.folder, skill.installName, skill.refused === null]), [["Upper", "upper-case-tool", true], ["skills/alpha", "alpha", true], ["skills/linked", "linked", false], ["skills/nameless", null, false]]);
  const alpha = skills.find(skill => skill.folder === "skills/alpha")!;
  // The copy leaves metadata.json out and keeps the nested skill inside its folder; the upstream id includes everything.
  assert.deepEqual([alpha.files, alpha.executables, alpha.plugin], [3, 1, false]);
  assert.equal(alpha.upstreamTree, (await folderTree(join(repo, "skills/alpha"))).id);
  assert.equal(alpha.copyTree, (await folderTree(join(repo, "skills/alpha"), npxExcluded)).id);
  assert.match(skills.find(skill => skill.folder === "skills/linked")!.refused ?? "", /链接/u);
  assert.match(skills.find(skill => skill.folder === "skills/nameless")!.refused ?? "", /name/u);
  assert.deepEqual(findSkills(listing, "skills").map(skill => skill.folder), ["skills/alpha", "skills/linked", "skills/nameless"], "a folder of the repository narrows the list");
  // Written under the Gateway's umask 077: the modes are still 0755/0644, and the tree is the one listed.
  const destination = join(root, "out", "alpha"); await mkdir(join(root, "out"));
  const previous = process.umask(0o077);
  try { assert.equal((await writeSkill(archive, alpha, destination)).id, alpha.copyTree); } finally { process.umask(previous); }
  assert.deepEqual([(await stat(destination)).mode & 0o777, (await stat(join(destination, "SKILL.md"))).mode & 0o777, (await stat(join(destination, "scripts/run.sh"))).mode & 0o777], [0o755, 0o644, 0o755]);
  await assert.rejects(lstat(join(destination, "metadata.json")), "metadata.json is not copied");
  // Invalid archives: a path leaving the folder, an absolute path, two top folders, a device entry, garbage.
  for (const [entries, label] of [[[{ path: "r/", type: "Directory" as const }, { path: "r/../evil", body: "x" }], "parent path"], [[{ path: "/etc/evil", body: "x" }], "absolute path"],
    [[{ path: "r/a", body: "x" }, { path: "s/b", body: "y" }], "two roots"]] as const)
    await assert.rejects(listArchive(rawTar(entries)), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_TARGET_REFUSED", label);
  await assert.rejects(listArchive(Buffer.from("not an archive")), (error: unknown) => error instanceof CapabilityError);
  const linkArchive = rawTar([{ path: "r/", type: "Directory" }, { path: "r/s/", type: "Directory" }, { path: "r/s/SKILL.md", body: SKILL("s") }, { path: "r/s/up", type: "SymbolicLink", linkpath: "../../../etc/passwd" }]);
  assert.match(findSkills(await listArchive(linkArchive), null)[0]!.refused ?? "", /链接/u, "a link anywhere in a skill refuses that skill");
});

const LOCK = "{\n  \"version\": 3,\n  \"skills\": {\n    \"alpha\": {\n      \"source\": \"acme/skills\",\n      \"sourceType\": \"github\",\n      \"sourceUrl\": \"https://github.com/acme/skills.git\",\n"
  + "      \"skillPath\": \"skills/alpha/SKILL.md\",\n      \"skillFolderHash\": \"" + "a".repeat(40) + "\",\n      \"installedAt\": \"2026-01-01T00:00:00.000Z\",\n      \"updatedAt\": \"2026-01-01T00:00:00.000Z\",\n"
  + "      \"futureField\": [1, 2]\n    },\n    \"beta\": {\n      \"source\": \"acme/other\",\n      \"sourceType\": \"github\",\n      \"skillFolderHash\": \"" + "b".repeat(40) + "\"\n    }\n  },\n  \"dismissed\": {},\n  \"lastSelectedAgents\": [\"claude-code\"]\n}";
test("G064-W8 a lock entry is changed in place, everything else byte for byte, and locks HarnessHub must not write are refused", () => {
  const updated = editLock(LOCK, "alpha", { kind: "update", skillFolderHash: "c".repeat(40), updatedAt: "2026-10-18T00:00:00.000Z" });
  assert.equal(updated, LOCK.replace("a".repeat(40), "c".repeat(40)).replace("\"updatedAt\": \"2026-01-01T00:00:00.000Z\"", "\"updatedAt\": \"2026-10-18T00:00:00.000Z\""));
  const removed = editLock(LOCK, "beta", { kind: "remove" });
  assert.deepEqual(Object.keys(JSON.parse(removed).skills), ["alpha"]); assert.ok(removed.includes("\"futureField\": [1, 2]"), "unknown fields stay");
  const original = JSON.parse(LOCK).skills.beta as Record<string, unknown>;
  assert.deepEqual(JSON.parse(editLock(removed, "beta", { kind: "put", value: original })), JSON.parse(LOCK), "an entry put back is the entry removed");
  assert.equal(editLock(updated, "alpha", { kind: "replace", value: JSON.parse(LOCK).skills.alpha as Record<string, unknown> }), LOCK, "an entry replaced in place restores the bytes");
  // Invalid samples: a missing entry, an old or unknown version, another format.
  assert.throws(() => editLock(LOCK, "gamma", { kind: "remove" }), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_TARGET_CHANGED");
  assert.throws(() => editLock(LOCK, "alpha", { kind: "put", value: {} }), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_TARGET_CHANGED");
  for (const source of [LOCK.replace("\"version\": 3", "\"version\": 2"), LOCK.replace("\"version\": 3", "\"version\": 4"), "{\"skills\":{}}", "not json"])
    assert.throws(() => editLock(source, "alpha", { kind: "remove" }), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_TARGET_REFUSED", source.slice(0, 30));
  assert.match(lockSkills(LOCK.replace("\"version\": 3", "\"version\": 2")).writable ?? "", /旧版本/u);
});

test("G064-W8 a snapshot puts a folder back exactly, links included, and only kept snapshots remain", async t => {
  const root = await temporary(t, "skill-snapshots-"), skill = await gitFixture(root), snapshots = new SkillSnapshots(join(root, "data", "skills"));
  const kept = await snapshots.save(skill);
  assert.equal(kept.id, "1a63f47c0a413b4e00675b4adfb3c3d5c8797d5f");
  assert.equal((await snapshots.save(skill)).id, kept.id, "the same tree is kept once");
  assert.equal((await stat(join(root, "data", "skills", kept.id, "files", "SKILL.md"))).mode & 0o777, 0o600, "snapshot files are private");
  await snapshots.restore(kept.id, join(root, "back"));
  assert.equal((await folderTree(join(root, "back"))).id, kept.id);
  assert.equal((await stat(join(root, "back", "scripts", "run.sh"))).mode & 0o777, 0o755);
  await assert.rejects(snapshots.restore(kept.id, join(root, "back")), "a snapshot is not restored over an existing folder");
  // A snapshot whose files no longer hash to its id is refused.
  await writeFile(join(root, "data", "skills", kept.id, "manifest.json"), JSON.stringify({ version: 1, id: kept.id, items: [] }));
  await assert.rejects(snapshots.restore(kept.id, join(root, "again")), (error: unknown) => error instanceof CapabilityError && error.code === "INVALID_STORAGE");
  await snapshots.prune(new Set());
  assert.deepEqual(await snapshots.stats(), { count: 0, bytes: 0 });
});

test("G064-W8 the links into a skill folder are found in the Harnesses' own skill folders, never in Claude Code's synced or trash folders", async t => {
  const root = await temporary(t, "skill-links-"), shared = join(root, "shared"), claude = join(root, "claude-skills"), hermes = join(root, "hermes-skills");
  await mkdir(join(shared, "alpha"), { recursive: true }); await writeFile(join(shared, "alpha", "SKILL.md"), SKILL("alpha"));
  for (const folder of [join(claude, "synced"), join(claude, ".trash"), join(hermes, "category")]) await mkdir(folder, { recursive: true });
  await symlink("../shared/alpha", join(claude, "alpha")); await symlink(join(shared, "alpha"), join(hermes, "category", "alpha"));
  await symlink(join(shared, "alpha"), join(claude, "synced", "alpha")); await symlink(join(shared, "alpha"), join(claude, ".trash", "alpha"));
  await symlink(join(shared, "alpha", "SKILL.md"), join(claude, "into-file")); await symlink(join(root, "elsewhere"), join(claude, "broken"));
  const table = (harnessId: string, path: string, depth: number) => ({ harnessId, skills: { roots: [{ role: "own", path, precedence: 1, containment: false, depth }, { role: "shared", path: shared, precedence: 1, containment: false, depth: 1 }] } }) as unknown as HarnessReadTable;
  const found = linksInto(await realpath(join(shared, "alpha")), [table("claude", claude, 1), table("hermes", hermes, 3)], shared);
  assert.deepEqual(found.map(link => [link.path.slice(root.length), link.target.replace(root, "")]),
    [["/claude-skills/alpha", "../shared/alpha"], ["/claude-skills/into-file", "/shared/alpha/SKILL.md"], ["/hermes-skills/category/alpha", "/shared/alpha"]]);
  assert.equal((await readFile(join(shared, "alpha", "SKILL.md"), "utf8")).length > 0, true);
});

test("G064-W8 a version's commit comes from GitHub's redirect or the archive's own record, and the two must agree", async () => {
  const sha = "f".repeat(40), entries = [new Pax({ comment: sha } as ConstructorParameters<typeof Pax>[0], true).encode()];
  const header = Buffer.alloc(512); new Header({ path: "repo-x/", type: "Directory", size: 0, mode: 0o755, mtime: new Date(0) }).encode(header);
  const archive = gzipSync(Buffer.concat([...entries, header, Buffer.alloc(1024)]));
  assert.equal((await listArchive(archive)).commit, sha, "GitHub's global header records the commit as its comment");
  assert.equal((await listArchive(rawTar([{ path: "r/", type: "Directory" }]))).commit, null);
  assert.deepEqual([settledCommit(sha, null), settledCommit(null, sha), settledCommit(sha, sha)], [sha, sha, sha]);
  assert.throws(() => settledCommit(sha, "e".repeat(40)), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_TARGET_REFUSED", "the two disagree");
  assert.throws(() => settledCommit(null, null), (error: unknown) => error instanceof CapabilityError && error.code === "CAPABILITY_COMMAND_FAILED", "neither is known");
});
