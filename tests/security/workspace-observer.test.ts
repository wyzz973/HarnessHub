import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createWorkspaceObserver, type WorkspaceObservation, type WorkspaceObserver, type WorkspaceObserverOptions } from "../../src/infrastructure/session/workspace-observer.js";

// G071-S01 (ADR-055 §10.6, WS-01–WS-06 of RT4 §3): the workspace observer against real git (/usr/bin/git) and a real file
// system. Every case has its invalid sample next to it: the same fixture read the way the observer must not read it (the
// v2 `-c` neutralization, no ceiling, the Hub's own environment, a naive PATH lookup, a lexical containment check), which
// trips the marker, lists `../`, leaks the variable or misses the spelling, so a 0 or a refusal here is never vacuous.

const darwinOnly = { skip: process.platform === "darwin" ? false : "the observer is verified on macOS only (ADR-044)" };
const SETUP = ["-c", "user.email=g071@example.invalid", "-c", "user.name=g071", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.fsmonitor=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/**
 * The cap these cases give their observers: they check what an observation finds, not when, and with about 120 test files
 * running at once a busy machine can push a small observation past 250 ms. The cap itself is tested at its default (C02).
 */
const CAP = 10_000;

interface Fixture {
  readonly root: string;
  /** The observer's private, empty HOME. */
  readonly home: string;
  /** Stands for the user's home; never the real one. */
  readonly user: string;
  readonly data: string;
  /** Appends its first argument to `marks`, then passes its input through (a working clean filter). */
  readonly mark: string;
  readonly marks: string;
}
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "g071-sec-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = { root, home: join(root, "home"), user: join(root, "user"), data: join(root, "data"), mark: join(root, "mark.sh"), marks: join(root, "marks") };
  for (const directory of [fixture.home, fixture.user, fixture.data]) await mkdir(directory);
  await writeFile(fixture.mark, "#!/bin/sh\nprintf '%s\\n' \"$1\" >> '" + fixture.marks + "'\nexec cat\n");
  await chmod(fixture.mark, 0o755);
  return fixture;
}
/** The environment fixtures are built with: never the user's own git configuration. */
function setupEnv(f: Fixture): Record<string, string> { return { HOME: f.user, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/usr/bin:/bin", LC_ALL: "C" }; }
function git(f: Fixture, cwd: string, ...args: string[]): string { return execFileSync("/usr/bin/git", [...SETUP, ...args], { cwd, env: setupEnv(f), encoding: "utf8" }); }
/** git run some other way than the observer's, for an invalid sample; never throws. */
function rawGit(cwd: string, args: readonly string[], env: Record<string, string | undefined>): { readonly status: number | null; readonly stdout: string } {
  const run = spawnSync("/usr/bin/git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
  return { status: run.status, stdout: run.stdout ?? "" };
}
async function marks(f: Fixture): Promise<readonly string[]> {
  try { return (await readFile(f.marks, "utf8")).split("\n").filter(Boolean); } catch { return []; }
}
async function clearMarks(f: Fixture): Promise<void> { await rm(f.marks, { force: true }); }
/** A repository with `files` committed and nothing changed yet (`change` does that). */
async function repository(f: Fixture, name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const workspace = join(f.root, name);
  await mkdir(workspace, { recursive: true });
  git(f, workspace, "init", "-q");
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(workspace, path)), { recursive: true }); await writeFile(join(workspace, path), content); }
  git(f, workspace, "add", "-A");
  git(f, workspace, "commit", "-qm", "base");
  return workspace;
}
/** Rewrites each file and moves its mtime ahead, so git has to look at it. */
async function change(workspace: string, files: readonly string[]): Promise<void> {
  const later = new Date(Date.now() + 5_000);
  for (const path of files) { await writeFile(join(workspace, path), "changed " + path + "\n"); await utimes(join(workspace, path), later, later); }
}
async function observer(t: test.TestContext, f: Fixture, options: Partial<WorkspaceObserverOptions> = {}): Promise<WorkspaceObserver> {
  const made = await createWorkspaceObserver({ path: "/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: f.data, timeoutMs: CAP, ...options });
  t.after(() => made.close());
  return made;
}
async function observe(made: WorkspaceObserver, workspace: string): Promise<WorkspaceObservation> {
  const outcome = await made.observe(workspace);
  assert.equal(await outcome.released, "released");
  return outcome.observation;
}
function paths(observation: WorkspaceObservation): readonly string[] { return observation.kind === "unavailable" ? [] : observation.files.map(file => file.path); }
async function indexStamp(workspace: string): Promise<string> { const info = await lstat(join(workspace, ".git", "index"), { bigint: true }); return info.ino + ":" + info.mtimeNs; }

test("G071-S01 WS-01 clean, smudge and process filters by a plain and a dotted name, also from .git/info/attributes, with fsmonitor and an index hook: 0 runs; the same repository read without the env neutralization runs them", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n", "b.md": "b\n", "c.dat": "c\n", "d.cfg": "d\n", "e.txt": "e\n" });
  git(f, workspace, "config", "filter.plain.clean", `"${f.mark}" plain-clean`);
  git(f, workspace, "config", "filter.plain.smudge", `"${f.mark}" plain-smudge`);
  git(f, workspace, "config", "filter.my.dotted.clean", `"${f.mark}" dotted-clean`);
  git(f, workspace, "config", "filter.proc.process", `"${f.mark}" proc-process`);
  // Not required, so that the plain read below goes on past the failed process filter to the other files.
  git(f, workspace, "config", "filter.proc.required", "false");
  git(f, workspace, "config", "core.fsmonitor", f.mark);
  await writeFile(join(workspace, ".gitattributes"), "*.txt filter=plain\n*.md filter=my.dotted\n*.dat filter=proc\n");
  await mkdir(join(workspace, ".git", "info"), { recursive: true });
  await writeFile(join(workspace, ".git", "info", "attributes"), "*.cfg filter=plain\n");
  await writeFile(join(workspace, ".git", "hooks", "post-index-change"), `#!/bin/sh\n"${f.mark}" post-index-change </dev/null\n`);
  await chmod(join(workspace, ".git", "hooks", "post-index-change"), 0o755);
  await change(workspace, ["a.txt", "b.md", "c.dat", "d.cfg"]);
  // e.txt only moves its mtime: git must read it to see it is unchanged, and a plain read then rewrites the index.
  const later = new Date(Date.now() + 5_000);
  await utimes(join(workspace, "e.txt"), later, later);
  const before = await indexStamp(workspace);

  const observation = await observe(await observer(t, f), workspace);
  assert.equal(observation.kind, "git");
  assert.ok(observation.kind === "git");
  assert.equal(observation.status, "complete");
  assert.deepEqual(observation.neutralized, ["my.dotted", "plain", "proc"]);
  assert.equal(observation.attributesIncluded, true, ".git/info/attributes was in effect");
  assert.deepEqual(observation.files.filter(file => file.change === "modified").map(file => file.path), ["a.txt", "b.md", "c.dat", "d.cfg"]);
  assert.deepEqual(await marks(f), [], "no filter, fsmonitor or hook ran");
  assert.equal(await indexStamp(workspace), before, ".git/index was not written");

  // Invalid samples: --attr-source alone leaves .git/info/attributes in effect (prototype F3), and a plain read runs them all.
  const hardenedOnly = rawGit(workspace, ["--attr-source=" + EMPTY_TREE, "-c", "core.attributesFile=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "diff", "--numstat"],
    { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
  assert.equal(hardenedOnly.status, 0);
  assert.ok((await marks(f)).includes("plain-clean"), "the .git/info/attributes filter runs without the per-name neutralization");
  await clearMarks(f);
  rawGit(workspace, ["status", "--porcelain"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  rawGit(workspace, ["diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  const plain = await marks(f);
  for (const expected of ["plain-clean", "dotted-clean", "proc-process"]) assert.ok(plain.includes(expected), expected + " runs in a plain read");
  assert.ok(plain.some(mark => /^\d+$/u.test(mark)) || plain.includes("post-index-change"), "fsmonitor or the index hook runs in a plain read");
  assert.notEqual(await indexStamp(workspace), before, "a plain read rewrites .git/index");
});

test("G071-S01 WS-01 a driver named a=b falls back to a tree observation marked partial and runs 0 times; the v2 `-c filter.a=b.clean=` runs it", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  await writeFile(join(workspace, ".git", "config"), (await readFile(join(workspace, ".git", "config"), "utf8")) + `[filter "a=b"]\n\tclean = "${f.mark}" eq-clean\n`);
  await writeFile(join(workspace, ".gitattributes"), "* filter=a=b\n");
  await change(workspace, ["a.txt"]);

  const observation = await observe(await observer(t, f), workspace);
  assert.equal(observation.kind, "tree");
  assert.ok(observation.kind === "tree");
  assert.equal(observation.status, "partial");
  assert.ok(paths(observation).includes("a.txt"));
  assert.ok(!paths(observation).some(path => path === ".git" || path.startsWith(".git/")), "a tree observation never lists .git");
  assert.deepEqual(await marks(f), []);

  // Invalid sample: `-c` cuts the key at its first `=`, so the driver named a=b is not neutralized (VF3-10).
  rawGit(workspace, ["-c", "filter.a=b.clean=", "-c", "core.fsmonitor=false", "diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  assert.ok((await marks(f)).includes("eq-clean"), "the -c spelling leaves the a=b driver running");
});

test("G071-S01 WS-01 a filter from an included config falls back to a tree observation marked partial and runs 0 times; read plainly it runs", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  await writeFile(join(workspace, ".git", "extra.cfg"), `[filter "inc"]\n\tclean = "${f.mark}" included-clean\n`);
  git(f, workspace, "config", "include.path", "extra.cfg");
  await writeFile(join(workspace, ".gitattributes"), "* filter=inc\n");
  await change(workspace, ["a.txt"]);

  const observation = await observe(await observer(t, f), workspace);
  assert.equal(observation.kind, "tree");
  assert.ok(observation.kind === "tree");
  assert.equal(observation.status, "partial");
  assert.deepEqual(await marks(f), []);

  // Invalid sample: the same repository read plainly runs the included driver.
  rawGit(workspace, ["diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  assert.ok((await marks(f)).includes("included-clean"));
});

test("G071-S01 WS-01 a filter defined after 64 KiB of other config, and more than 256 drivers, fall back to a tree observation marked partial and run 0 times; a reader that kept the first 64 KiB misses the driver, which then runs", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  const filler = Array.from({ length: 1200 }, (_, index) => `\tpad${String(index).padStart(4, "0")} = ${"x".repeat(48)}\n`).join("");
  await writeFile(join(workspace, ".git", "config"), (await readFile(join(workspace, ".git", "config"), "utf8")) + "[alias]\n" + filler + `[filter "late"]\n\tclean = "${f.mark}" late-clean\n`);
  await writeFile(join(workspace, ".gitattributes"), "* filter=late\n");
  await change(workspace, ["a.txt"]);
  const made = await observer(t, f);
  const observation = await observe(made, workspace);
  assert.ok(observation.kind === "tree", JSON.stringify(observation).slice(0, 200));
  assert.equal(observation.status, "partial");
  assert.deepEqual(await marks(f), []);

  // Invalid sample: the first 64 KiB of the list hold no filter key, so neutralizing what they name leaves `late` running.
  const listing = execFileSync("/usr/bin/git", ["config", "--list", "-z", "--show-origin"], { cwd: workspace, env: { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" } });
  assert.ok(listing.length > 64 * 1024);
  assert.ok(!listing.subarray(0, 64 * 1024).toString("utf8").includes("filter."), "nothing in the first 64 KiB names a filter");
  rawGit(workspace, ["--attr-source=" + EMPTY_TREE, "-c", "core.fsmonitor=false", "diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  rawGit(workspace, ["diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  assert.ok((await marks(f)).includes("late-clean"));
  await clearMarks(f);

  // More drivers than the observer neutralizes by name (MAX_FILTER_DRIVERS): a tree, partial, nothing run.
  const many = await repository(f, "many", { "b.txt": "b\n" });
  await writeFile(join(many, ".git", "config"), (await readFile(join(many, ".git", "config"), "utf8")) + Array.from({ length: 300 }, (_, index) => `[filter "d${index}"]\n\tclean = "${f.mark}" d${index}\n`).join(""));
  await writeFile(join(many, ".gitattributes"), "* filter=d299\n");
  await change(many, ["b.txt"]);
  const crowded = await observe(made, many);
  assert.ok(crowded.kind === "tree" && crowded.status === "partial", JSON.stringify(crowded).slice(0, 200));
  assert.deepEqual(await marks(f), []);
});

test("G071-S01 WS-02 lfs configured in the user's HOME and a fake git-lfs on PATH: neither runs, .git/lfs stays absent and the file is marked LFS (unverified); with the user's HOME git runs the fake", darwinOnly, async t => {
  const f = await fixture(t);
  const lfsBin = join(f.root, "lfsbin");
  await mkdir(lfsBin);
  await writeFile(join(lfsBin, "git-lfs"), `#!/bin/sh\nprintf 'git-lfs %s\\n' "$1" >> '${f.marks}'\nmkdir -p .git/lfs/objects\nexec cat\n`);
  await chmod(join(lfsBin, "git-lfs"), 0o755);
  await writeFile(join(f.user, ".gitconfig"), "[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\trequired = true\n");
  const workspace = await repository(f, "ws", { "asset.bin": "binary\u0000one\n", "readme.md": "r\n" });
  await writeFile(join(workspace, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  await change(workspace, ["asset.bin", "readme.md"]);
  const path = lfsBin + ":/usr/bin:/bin";

  const observation = await observe(await observer(t, f, { path }), workspace);
  assert.equal(observation.kind, "git");
  assert.ok(observation.kind === "git");
  assert.deepEqual(observation.neutralized, [], "the repository itself configures no filter");
  const asset = observation.files.find(file => file.path === "asset.bin");
  assert.deepEqual(asset, { path: "asset.bin", change: "modified", added: null, removed: null, credentialPath: false, lfs: true });
  assert.equal(observation.files.find(file => file.path === "readme.md")?.lfs, false);
  assert.deepEqual(await marks(f), []);
  await assert.rejects(lstat(join(workspace, ".git", "lfs")), { code: "ENOENT" });

  // Invalid sample: git given the user's HOME reads its lfs filter and runs the fake git-lfs, which writes .git/lfs (status
  // alone may not: a file whose size changed is modified without cleaning it; diff has to clean it).
  for (const command of [["status", "--porcelain"], ["diff", "--numstat"]]) rawGit(workspace, command, { HOME: f.user, GIT_CONFIG_NOSYSTEM: "1", PATH: path, LC_ALL: "C" });
  assert.ok((await marks(f)).some(mark => mark.startsWith("git-lfs")));
  assert.ok((await lstat(join(workspace, ".git", "lfs"))).isDirectory());
});

test("G071-S01 WS-03 a HOME that is a git repository: a workspace below it is its own tree without ../, the HOME and its parent are never scanned, / neither; without the ceiling git lists ../ and without the HOME check .ssh is listed", darwinOnly, async t => {
  const f = await fixture(t);
  git(f, f.user, "init", "-q");
  await writeFile(join(f.user, ".zshrc"), "export A=1\n");
  git(f, f.user, "add", ".zshrc");
  git(f, f.user, "commit", "-qm", "dotfiles");
  await writeFile(join(f.user, ".zshrc"), "export A=2\n");
  await mkdir(join(f.user, ".ssh"));
  await writeFile(join(f.user, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  const project = join(f.user, "project");
  await mkdir(project);
  await writeFile(join(project, "main.c"), "int main(void) { return 0; }\n");
  const made = await observer(t, f);

  const below = await observe(made, project);
  assert.equal(below.kind, "tree");
  assert.deepEqual(paths(below), ["main.c"]);
  assert.deepEqual(await observe(made, f.user), { kind: "unavailable", reason: "root_is_home" });
  assert.deepEqual(await observe(made, f.root), { kind: "unavailable", reason: "root_is_home" });
  assert.deepEqual(await observe(made, "/"), { kind: "unavailable", reason: "root_is_fs" });

  // Invalid samples: without GIT_CEILING_DIRECTORIES git finds the HOME repository from below and lists ../ entries; an
  // observer that took some other directory for the HOME scans the HOME and names .ssh.
  const unceiled = rawGit(project, ["status", "--short"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  assert.match(unceiled.stdout, /\.\.\/\.zshrc/u);
  const blind = await observe(await observer(t, f, { userHome: join(f.root, "elsewhere") }), f.user);
  assert.ok(paths(blind).includes(".ssh/"), "without the HOME check the HOME's .ssh is listed: " + JSON.stringify(paths(blind)));
});

test("G071-S01 WS-04 a gitdir outside the workspace is refused, through a .git file, a .git link and core.worktree; read plainly the outside repository's index shows through", darwinOnly, async t => {
  const f = await fixture(t);
  const outside = await repository(f, "outside", { "secret.txt": "s\n" });
  const byFile = join(f.root, "by-file"), byLink = join(f.root, "by-link");
  await mkdir(byFile); await mkdir(byLink);
  await writeFile(join(byFile, ".git"), "gitdir: " + join(outside, ".git") + "\n");
  await symlink(join(outside, ".git"), join(byLink, ".git"));
  const byWorktree = await repository(f, "by-worktree", { "x.txt": "x\n" });
  git(f, byWorktree, "config", "core.worktree", outside);
  const made = await observer(t, f);
  for (const workspace of [byFile, byLink, byWorktree]) assert.deepEqual(await observe(made, workspace), { kind: "unavailable", reason: "gitdir_outside" }, workspace);
  // Control: a .git file whose gitdir lies inside the workspace is observed; what is refused is the outside, not the file.
  const inner = await repository(f, "inner", { "a.txt": "a\n" });
  execFileSync("/bin/mv", [join(inner, ".git"), join(inner, ".repo-git")]);
  await writeFile(join(inner, ".git"), "gitdir: .repo-git\n");
  await writeFile(join(inner, "a.txt"), "changed\n");
  const kept = await observe(made, inner);
  assert.equal(kept.kind, "git", JSON.stringify(kept));
  // git skips only directories named .git when it lists untracked files, so the renamed gitdir shows as one.
  assert.deepEqual(paths(kept), ["a.txt", ".repo-git/"]);

  // Invalid sample: git run in the workspace with that .git file reads the outside repository's index.
  const leaked = rawGit(byFile, ["status", "--porcelain"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" });
  assert.match(leaked.stdout, /secret\.txt/u);
});

/** The variables of §10.6 and nothing else; a list of what is wrong, empty when it is exactly the whitelist. */
function whitelistViolations(env: Readonly<Record<string, string>>, home: string, workspace: string): readonly string[] {
  const fixed: Record<string, string> = { HOME: home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: dirname(workspace) };
  const wrong: string[] = [], count = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count < 0) wrong.push("GIT_CONFIG_COUNT");
  const allowed = new Set([...Object.keys(fixed), "GIT_CONFIG_COUNT", ...Array.from({ length: Math.max(0, count) }, (_, index) => ["GIT_CONFIG_KEY_" + index, "GIT_CONFIG_VALUE_" + index]).flat()]);
  for (const [key, value] of Object.entries(fixed)) if (env[key] !== value) wrong.push(key + "=" + String(env[key]));
  for (const key of Object.keys(env)) if (!allowed.has(key)) wrong.push("extra " + key);
  for (const key of allowed) if (!(key in env)) wrong.push("missing " + key);
  return wrong;
}

test("G071-S01 WS-04 the Hub's GIT_DIR, GIT_CONFIG_PARAMETERS and API keys never reach git: every git the observer runs gets exactly the whitelist; the Hub's own environment would carry all three, and two of them change what git does", darwinOnly, async t => {
  const f = await fixture(t);
  const outside = await repository(f, "outside", { "secret.txt": "s\n" });
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  git(f, workspace, "config", "filter.x.clean", `"${f.mark}" repo-clean`);
  await writeFile(join(workspace, ".gitattributes"), "* filter=x\n");
  await change(workspace, ["a.txt"]);
  const recorderBin = join(f.root, "envbin"), log = join(f.root, "env.log");
  await mkdir(recorderBin);
  // Perl adds no variable of its own (checked below), so the record is exactly what the observer passed.
  await writeFile(join(recorderBin, "git"), `#!/usr/bin/perl\nuse strict; use warnings; use JSON::PP;\nopen(my $log, '>>', '${log}') or die "log: $!";\nprint $log JSON::PP->new->canonical->encode({ args => \\@ARGV, env => { %ENV } }), "\\n";\nclose($log);\nexec { '/usr/bin/git' } 'git', @ARGV;\ndie "exec: $!";\n`);
  await chmod(join(recorderBin, "git"), 0o755);
  const records = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  const calibration = spawnSync(join(recorderBin, "git"), ["--version"], { env: { ONLY: "1" }, encoding: "utf8" });
  assert.equal(calibration.status, 0);
  assert.deepEqual((await records()).map(record => record.env), [{ ONLY: "1" }], "the recorder adds nothing to what it is given");
  await rm(log);

  const hub = { GIT_DIR: join(outside, ".git"), GIT_CONFIG_PARAMETERS: `'filter.x.clean'='"${f.mark}" injected-clean'`, ANTHROPIC_API_KEY: "sk-ant-g071-not-a-real-key-0000000000", OPENAI_API_KEY: "sk-g071-not-a-real-key-0000000000" };
  const saved = Object.fromEntries(Object.keys(hub).map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, hub);

  const observation = await observe(await observer(t, f, { path: recorderBin + ":/usr/bin:/bin" }), workspace);
  assert.equal(observation.kind, "git");
  assert.deepEqual(paths(observation), ["a.txt", ".gitattributes"]);
  assert.deepEqual(await marks(f), []);
  const seen = await records(), home = await realpath(f.home);
  // rev-parse with config, and status with diff, run at once, so only the set of commands is fixed.
  assert.deepEqual(seen.map(record => record.args.find(arg => !arg.startsWith("-") && arg !== workspace)).sort(), ["check-attr", "config", "diff", "rev-parse", "status"]);
  for (const record of seen) {
    assert.deepEqual(whitelistViolations(record.env, home, workspace), [], record.args.join(" "));
    assert.ok(!record.args.includes("-c"), "nothing is neutralized with -c: " + record.args.join(" "));
    if (record.args.includes("status") || record.args.includes("diff")) assert.ok(record.args.includes("--attr-source=" + EMPTY_TREE), record.args.join(" "));
    const entries = Array.from({ length: Number(record.env.GIT_CONFIG_COUNT) }, (_, index) => record.env["GIT_CONFIG_KEY_" + index] + "=" + record.env["GIT_CONFIG_VALUE_" + index]);
    for (const hardening of ["core.fsmonitor=false", "core.hooksPath=/dev/null", "core.attributesFile=/dev/null", "diff.autoRefreshIndex=false"]) assert.ok(entries.includes(hardening), hardening);
    if (record.args.includes("status") || record.args.includes("diff")) assert.deepEqual(entries.filter(entry => entry.startsWith("filter.")), ["filter.x.clean=", "filter.x.smudge=", "filter.x.process=", "filter.x.required=false"]);
  }

  // Invalid samples: what a spawn that passes the Hub's environment along would give git; the injected parameters run a
  // filter, and GIT_DIR points git at another repository.
  const along = { ...process.env } as Record<string, string>;
  assert.ok(whitelistViolations(along, home, workspace).some(item => item === "extra GIT_DIR"));
  assert.ok(whitelistViolations(along, home, workspace).some(item => item === "extra GIT_CONFIG_PARAMETERS"));
  assert.ok(whitelistViolations(along, home, workspace).some(item => item === "extra ANTHROPIC_API_KEY"));
  rawGit(workspace, ["diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_PARAMETERS: hub.GIT_CONFIG_PARAMETERS, LC_ALL: "C" });
  assert.ok((await marks(f)).includes("injected-clean"), "GIT_CONFIG_PARAMETERS overrides the repository's own filter");
  const redirected = rawGit(workspace, ["status", "--porcelain"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_DIR: hub.GIT_DIR, LC_ALL: "C" });
  assert.match(redirected.stdout, /secret\.txt/u);
});

test("G071-S01 WS-05 a data directory and the workspace containing one another, however spelled (a link either way, case, firmlink, the other way round, the same directory), is data_root_in_workspace and nothing is observed; a lexical check misses those spellings", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  const inside = join(workspace, "data");
  await mkdir(inside);
  await writeFile(join(inside, "gateway.sqlite"), "SQLite format 3\u0000");
  await writeFile(join(inside, ".harness-gateway.json"), "{}\n");
  await symlink(workspace, join(f.root, "alias"));
  const elsewhere = join(f.root, "elsewhere-data");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(workspace, "link"));
  const nested = join(f.root, "datahome"), below = join(nested, "ws2");
  await mkdir(below, { recursive: true });
  const spellings: readonly { readonly name: string; readonly dataRoot: string; readonly workspace: string }[] = [
    { name: "plain", dataRoot: inside, workspace },
    { name: "link outside leading into the workspace", dataRoot: join(f.root, "alias", "data"), workspace },
    { name: "link in the workspace leading out", dataRoot: join(workspace, "link"), workspace },
    { name: "case", dataRoot: workspace.toUpperCase() + "/DATA", workspace },
    { name: "firmlink", dataRoot: "/System/Volumes/Data" + inside, workspace },
    { name: "workspace by firmlink and case", dataRoot: inside, workspace: ("/System/Volumes/Data" + workspace).toUpperCase() },
    { name: "the other way round", dataRoot: nested, workspace: below },
    { name: "the same directory", dataRoot: workspace, workspace },
  ];
  for (const spelling of spellings) {
    const made = await createWorkspaceObserver({ path: "/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: spelling.dataRoot, timeoutMs: CAP });
    try { assert.deepEqual(await observe(made, spelling.workspace), { kind: "unavailable", reason: "data_root_in_workspace" }, spelling.name); }
    finally { await made.close(); }
  }

  // Invalid samples: a lexical check sees none of the spelled cases, and an observer told of a data directory elsewhere
  // lists the one in the workspace.
  const lexical = (data: string, place: string) => resolve(data) === resolve(place) || resolve(data).startsWith(resolve(place) + "/") || resolve(place).startsWith(resolve(data) + "/");
  for (const name of ["link outside leading into the workspace", "case", "firmlink", "workspace by firmlink and case"]) {
    const spelling = spellings.find(item => item.name === name)!;
    assert.equal(lexical(spelling.dataRoot, spelling.workspace), false, name + " is missed by a lexical check");
  }
  const unaware = await observe(await observer(t, f, { dataRoot: join(f.root, "data") }), workspace);
  assert.ok(paths(unaware).includes("link"), "the link is listed when the data directory is not known to be behind it");
});

test("G071-S01 WS-05 with the data directory elsewhere, a data directory copy left in the workspace (its ownership marker) and .tmp are never listed, by git or as a tree; without the marker the copy is listed", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  const plain = join(f.root, "plain");
  await mkdir(plain);
  await writeFile(join(plain, "a.txt"), "a\n");
  for (const place of [workspace, plain]) {
    await mkdir(join(place, "old-data", "content"), { recursive: true });
    await writeFile(join(place, "old-data", ".harness-gateway.json"), "{}\n");
    await writeFile(join(place, "old-data", "gateway.sqlite"), "SQLite format 3\u0000");
    await mkdir(join(place, ".tmp"));
    await writeFile(join(place, ".tmp", "service.log"), "log\n");
    await mkdir(join(place, "notes"));
    await writeFile(join(place, "notes", "todo.md"), "todo\n");
  }
  await change(workspace, ["a.txt"]);
  const made = await observer(t, f);
  const tracked = await observe(made, workspace), tree = await observe(made, plain);
  assert.equal(tracked.kind, "git");
  assert.deepEqual(paths(tracked), ["a.txt", "notes/"]);
  assert.equal(tree.kind, "tree");
  assert.deepEqual([...paths(tree)].sort(), ["a.txt", "notes/todo.md"]);

  // Invalid sample: the same copy without its marker is an ordinary directory and is listed.
  for (const place of [workspace, plain]) await rm(join(place, "old-data", ".harness-gateway.json"));
  const unmarked = await observer(t, f);
  assert.ok(paths(await observe(unmarked, workspace)).includes("old-data/"));
  assert.ok(paths(await observe(unmarked, plain)).includes("old-data/gateway.sqlite"));
});

test("G071-S01 WS-06 a git in a PATH entry inside the workspace, or reached through a link into it, never runs; with no git outside the workspace the observation is unavailable{error}; a naive PATH lookup runs it", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  await change(workspace, ["a.txt"]);
  await mkdir(join(workspace, "bin"));
  await writeFile(join(workspace, "bin", "git"), `#!/bin/sh\nprintf 'fake-git %s\\n' "$*" >> '${f.marks}'\nexit 0\n`);
  await chmod(join(workspace, "bin", "git"), 0o755);
  await symlink(join(workspace, "bin"), join(f.root, "linkbin"));
  const inPath = [join(workspace, "bin"), join(f.root, "linkbin"), "/System/Volumes/Data" + join(workspace, "bin")].join(":");

  const observation = await observe(await observer(t, f, { path: inPath + ":/usr/bin:/bin" }), workspace);
  assert.equal(observation.kind, "git");
  assert.deepEqual(paths(observation), ["a.txt", "bin/"]);
  assert.deepEqual(await observe(await observer(t, f, { path: inPath }), workspace), { kind: "unavailable", reason: "error" });
  assert.deepEqual(await marks(f), []);

  // Relative entries: an observer made in the workspace with PATH=bin:… skips `bin` though ./bin/git is right there.
  const module = new URL("../../src/infrastructure/session/workspace-observer.js", import.meta.url).href;
  const script = `import { createWorkspaceObserver } from ${JSON.stringify(module)};
const made = await createWorkspaceObserver({ path: "bin:/usr/bin:/bin", home: ${JSON.stringify(f.home)}, userHome: ${JSON.stringify(f.user)}, dataRoot: ${JSON.stringify(f.data)}, timeoutMs: ${CAP} });
const outcome = await made.observe(process.cwd()); await outcome.released; await made.close();
process.stdout.write(JSON.stringify(outcome.observation));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: workspace, env: { PATH: "bin:/usr/bin:/bin", HOME: f.user }, encoding: "utf8", timeout: 20_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal((JSON.parse(child.stdout) as WorkspaceObservation).kind, "git");
  assert.deepEqual(await marks(f), []);

  // Invalid sample: looking git up in that PATH the usual way runs the workspace's fake.
  spawnSync("git", ["--version"], { cwd: workspace, env: { PATH: "bin:/usr/bin:/bin" }, encoding: "utf8" });
  assert.ok((await marks(f)).some(mark => mark.startsWith("fake-git")));
});

test("G071-S01 the observation never writes .git/index though files are stat-dirty; git diff with GIT_OPTIONAL_LOCKS=0 but without diff.autoRefreshIndex=false rewrites it", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
  const later = new Date(Date.now() + 5_000);
  for (const path of ["a.txt", "b.txt"]) await utimes(join(workspace, path), later, later);
  await writeFile(join(workspace, "c.txt"), "c changed\n");
  const before = await indexStamp(workspace), made = await observer(t, f);
  const observation = await observe(made, workspace);
  assert.equal(observation.kind, "git");
  assert.deepEqual(paths(observation), ["c.txt"], "stat-dirty files with the same content are not changes");
  assert.equal(await indexStamp(workspace), before);

  // Invalid sample: GIT_OPTIONAL_LOCKS=0 keeps `status` from writing, not `diff`.
  rawGit(workspace, ["-c", "core.fsmonitor=false", "diff", "--numstat"], { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
  assert.notEqual(await indexStamp(workspace), before);
});

test("G071-S01 credential paths are marked, renamed ones by either name; an ordinary path is not", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { ".env": "A=1\n", "config/app.pem": "pem\n", "src/main.ts": "m\n", "old/id_rsa": "k\n" });
  await change(workspace, [".env", "config/app.pem", "src/main.ts"]);
  git(f, workspace, "mv", "old/id_rsa", "keys-moved");
  await mkdir(join(workspace, ".ssh"));
  await writeFile(join(workspace, ".ssh", "known_hosts"), "h\n");
  const observation = await observe(await observer(t, f), workspace);
  assert.ok(observation.kind === "git");
  const marked = Object.fromEntries(observation.files.map(file => [file.path, file.credentialPath]));
  assert.deepEqual(marked, { ".env": true, "config/app.pem": true, "keys-moved": true, "src/main.ts": false, ".ssh/": true });
  assert.equal(observation.files.find(file => file.path === "keys-moved")?.change, "renamed");
});
