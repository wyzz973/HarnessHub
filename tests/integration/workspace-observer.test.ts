import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { MAX_PARALLEL_CONVERSATIONS } from "../../src/contracts/session.js";
import { MAX_LISTED_FILES, MAX_OBSERVE_TIMEOUT_MS, MAX_PARALLEL_OBSERVATIONS, MAX_TREE_ENTRIES, OBSERVE_TIMEOUT_MS, REUSE_WINDOW_MS, createWorkspaceObserver, type ObservationOutcome, type WorkspaceObserver, type WorkspaceObserverOptions } from "../../src/infrastructure/session/workspace-observer.js";

// G071-C01–C03 (ADR-055 §10.6, §11.1): bounded tree observations, the 250 ms cap with SIGKILL to the whole process group,
// at most four observations at once, and the reuse rule, with real git (/usr/bin/git) and real directories. Where a test
// needs to see what git was asked, a wrapper outside the workspace logs it and runs /usr/bin/git; the observer resolves it
// from PATH like any git. Milliseconds are reported, never asserted (relay-architecture §11.1); a 5 s guard only tells a
// hang from a result.

const darwinOnly = { skip: process.platform === "darwin" ? false : "the observer is verified on macOS only (ADR-044)" };
const SETUP = ["-c", "user.email=g071@example.invalid", "-c", "user.name=g071", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.fsmonitor=false"];
/**
 * The cap most cases give their observers: they check what an observation finds or how it is bounded, not when, and with
 * about 120 test files running at once a busy machine can push a small observation past 250 ms. The 250 ms default is
 * tested on its own below; the timeout cases that must reach `git status` first use HANG_CAP.
 */
const CAP = 10_000, HANG_CAP = 2_000;
interface Fixture { readonly root: string; readonly home: string; readonly user: string; readonly data: string }
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "g071-int-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const made = { root, home: join(root, "home"), user: join(root, "user"), data: join(root, "data") };
  for (const directory of [made.home, made.user, made.data]) await mkdir(directory);
  return made;
}
function git(f: Fixture, cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", [...SETUP, ...args], { cwd, env: { HOME: f.user, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8" }).trim();
}
async function repository(f: Fixture, name: string, files: Readonly<Record<string, string>>): Promise<string> {
  const workspace = join(f.root, name);
  await mkdir(workspace, { recursive: true });
  git(f, workspace, "init", "-q");
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(workspace, path)), { recursive: true }); await writeFile(join(workspace, path), content); }
  git(f, workspace, "add", "-A");
  git(f, workspace, "commit", "-qm", "base");
  return workspace;
}
async function observer(t: test.TestContext, f: Fixture, options: Partial<WorkspaceObserverOptions> = {}): Promise<WorkspaceObserver> {
  const made = await createWorkspaceObserver({ path: "/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: f.data, timeoutMs: CAP, ...options });
  t.after(() => made.close());
  return made;
}
async function guarded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(label + " did not settle within 5 s")), 5_000); })]); }
  finally { clearTimeout(timer); }
}
/** Writes `count` files of a few bytes under `directory`, `perDirectory` to a subdirectory. */
async function files(directory: string, count: number, perDirectory: number): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (let index = 0; index < count; index++) {
    const sub = join(directory, "d" + String(Math.floor(index / perDirectory)).padStart(3, "0"));
    if (index % perDirectory === 0) await mkdir(sub, { recursive: true });
    jobs.push(writeFile(join(sub, "f" + String(index).padStart(5, "0") + ".txt"), String(index)));
    if (jobs.length >= 256) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
/**
 * Runs a freshly written executable once: macOS assesses a new executable on its first run (about 0.5 s here, measured),
 * which would otherwise land inside an observation's 250 ms.
 */
function warm(path: string): void { const run = spawnSync(path, ["--version"], { env: { LC_ALL: "C" }, encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); }
async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> { for (const end = performance.now() + ms; performance.now() < end;) { if (await check()) return true; await new Promise(done => setTimeout(done, 5)); } return check(); }

test("G071-C01 a non-git directory of 20,000 files keeps 1,000, the most recently changed first, reads at most 20,000 entries and is partial; one that fits is complete; observed twice, the fingerprint is the same", darwinOnly, async t => {
  const f = await fixture(t);
  const made = await observer(t, f);
  const small = join(f.root, "small");
  await files(small, 30, 10);
  const fits = (await made.observe(small)).observation;
  assert.ok(fits.kind === "tree", JSON.stringify(fits));
  assert.deepEqual({ status: fits.status, listed: fits.files.length, scanned: fits.scanned, counted: fits.counted }, { status: "complete", listed: 30, scanned: 33, counted: 30 });

  const big = join(f.root, "big");
  await files(big, 20_000, 100);
  const newest = join(big, "d007", "f00700.txt"), later = new Date(Date.now() + 60_000);
  await utimes(newest, later, later);
  await mkdir(join(big, ".tmp"));
  await writeFile(join(big, ".tmp", "service.log"), "log");
  const first = (await made.observe(big)).observation, second = (await made.observe(big)).observation;
  assert.equal(first.kind, "tree", JSON.stringify(first).slice(0, 200));
  assert.ok(first.kind === "tree" && second.kind === "tree", JSON.stringify(second).slice(0, 200));
  t.diagnostic("20,000 files: " + first.durationMs + " ms, then " + second.durationMs + " ms; scanned " + first.scanned + ", counted " + first.counted);
  assert.equal(first.status, "partial");
  assert.equal(first.files.length, MAX_LISTED_FILES);
  assert.equal(first.scanned, MAX_TREE_ENTRIES, "the 200 directories make 20,200 entries, so the read stops at the bound");
  assert.ok(first.counted >= MAX_LISTED_FILES && first.counted <= MAX_TREE_ENTRIES);
  assert.equal(first.files[0]!.path, "d007/f00700.txt", "the most recently changed file comes first");
  for (let index = 1; index < first.files.length; index++) assert.ok(first.files[index - 1]!.mtimeMs >= first.files[index]!.mtimeMs);
  assert.ok(first.files.every(file => !file.path.startsWith(".tmp") && !file.path.includes("..") && !file.path.startsWith("/")));
  for (const file of first.files.slice(0, 20)) { const info = await lstat(join(big, file.path)); assert.equal(info.size, file.size); assert.equal(info.mtimeMs, file.mtimeMs); }
  assert.equal(second.fingerprint, first.fingerprint);
  assert.deepEqual(second.files, first.files);
});

test("G071-C01 in a git repository of 1,500 changes the tracked changes come first and 1,000 are kept with the full count; the fingerprint covers the ones left out", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n", "b.txt": "b\n", "z.txt": "z\n" });
  for (const path of ["a.txt", "b.txt", "z.txt"]) await writeFile(join(workspace, path), "changed\n");
  await Promise.all(Array.from({ length: 1497 }, (_, index) => writeFile(join(workspace, "u" + String(index).padStart(4, "0") + ".txt"), "u")));
  const made = await observer(t, f);
  const observation = (await made.observe(workspace)).observation;
  assert.ok(observation.kind === "git", JSON.stringify(observation).slice(0, 200));
  t.diagnostic("1,500 changes: " + observation.durationMs + " ms");
  assert.equal(observation.status, "partial");
  assert.deepEqual(observation.counted, { total: 1500, listed: MAX_LISTED_FILES });
  assert.deepEqual(observation.files.slice(0, 4).map(file => [file.path, file.change]), [["a.txt", "modified"], ["b.txt", "modified"], ["z.txt", "modified"], ["u0000.txt", "untracked"]]);
  assert.equal(observation.files.at(-1)?.path, "u0996.txt");
  // A file beyond the kept list still counts: removing it changes the count and the fingerprint, not the list. The index is
  // touched so that the observation is not simply reused.
  await rm(join(workspace, "u1496.txt"));
  await utimes(join(workspace, ".git", "index"), new Date(), new Date(Date.now() + 2_000));
  const fewer = (await made.observe(workspace)).observation;
  assert.ok(fewer.kind === "git", JSON.stringify(fewer).slice(0, 200));
  assert.deepEqual(fewer.counted, { total: 1499, listed: MAX_LISTED_FILES });
  assert.notEqual(fewer.fingerprint, observation.fingerprint);
  assert.deepEqual(fewer.files, observation.files);
});

/** A git that logs its pid and arguments, starts a `sleep` in its own process group for `status`, then becomes /usr/bin/git. */
async function groupedGit(directory: string): Promise<{ readonly bin: string; readonly calls: string; readonly sleepers: string }> {
  const bin = join(directory, "bin"), calls = join(directory, "calls"), sleepers = join(directory, "sleepers");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s %s\\n' "$$" "$*" >> '${calls}'\ncase " $* " in *" status "*) /bin/sleep 30 </dev/null >/dev/null 2>&1 & printf '%s %s\\n' "$$" "$!" >> '${sleepers}';; esac\nexec /usr/bin/git "$@"\n`);
  await chmod(join(bin, "git"), 0o755);
  warm(join(bin, "git"));
  await rm(calls, { force: true });
  return { bin, calls, sleepers };
}
/** A repository whose `git status` blocks for good: its exclude file is a FIFO nobody writes. */
async function hanging(f: Fixture, name: string): Promise<string> {
  const workspace = await repository(f, name, { "a.txt": "a\n" });
  await rm(join(workspace, ".git", "info", "exclude"), { force: true });
  execFileSync("/usr/bin/mkfifo", [join(workspace, ".git", "info", "exclude")]);
  return workspace;
}
async function pairs(path: string): Promise<readonly (readonly [number, number])[]> {
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => { const [a, b] = line.split(" "); return [Number(a), Number(b)] as const; }); } catch { return []; }
}

test("G071-C02 the cap is 250 ms by default: with setTimeout mocked, an observer made without a cap still waits at 249 ms and answers unavailable{timeout} at 250 ms, and every process it started is gone", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await hanging(f, "ws"), wrapper = await groupedGit(f.root);
  assert.equal(OBSERVE_TIMEOUT_MS, 250);
  const made = await createWorkspaceObserver({ path: wrapper.bin + ":/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: f.data });
  t.after(() => made.close());
  // The cap's clock is setTimeout; mocked, it moves only when stepped, so the moment the cap falls is exact whatever the
  // load. This repository's `git status` never ends on its own, so nothing but the cap can end the observation.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const pending = made.observe(workspace).finally(() => { settled = true; });
  const turn = () => new Promise<void>(done => setImmediate(done));
  for (const end = performance.now() + CAP; (await pairs(wrapper.sleepers)).length === 0 && performance.now() < end;) await turn();
  assert.equal((await pairs(wrapper.sleepers)).length, 1, "status is running");
  t.mock.timers.tick(OBSERVE_TIMEOUT_MS - 1);
  for (let index = 0; index < 20; index++) await turn();
  assert.equal(settled, false, "the observation is still waiting at 249 ms");
  t.mock.timers.tick(1);
  // Waited for in turns of the event loop, never on a timer, so a cap that does not fall at 250 ms fails here, not hangs.
  for (let index = 0; index < 200 && !settled; index++) await turn();
  assert.equal(settled, true, "the observation ended at 250 ms");
  const outcome = await pending;
  t.mock.timers.reset();
  assert.deepEqual(outcome.observation, { kind: "unavailable", reason: "timeout" });
  assert.equal(await guarded(outcome.released, "released"), "released");
  for (const line of (await readFile(wrapper.calls, "utf8").catch(() => "")).split("\n").filter(Boolean)) {
    const pid = Number(line.split(" ")[0]);
    assert.equal(alive(pid), false, line);
    assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" }, line);
  }
  for (const [, sleeper] of await pairs(wrapper.sleepers)) assert.equal(alive(sleeper), false);
  assert.deepEqual(made.stats(), { active: 0, queued: 0, peakActive: 1, unconfirmed: 0 });
});

test("G071-C02 an observation past its cap is unavailable{timeout}: its whole process group (git and the sleep it started) gets SIGKILL and is waited for, and the caller is not held; killing only the leader leaves the sleep running", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await hanging(f, "ws"), wrapper = await groupedGit(f.root);
  const made = await observer(t, f, { path: wrapper.bin + ":/usr/bin:/bin", timeoutMs: HANG_CAP });
  const started = performance.now();
  const outcome = await guarded(made.observe(workspace), "observe()");
  const resultMs = performance.now() - started;
  assert.deepEqual(outcome.observation, { kind: "unavailable", reason: "timeout" });
  assert.equal(outcome.reused, false);
  assert.equal(await guarded(outcome.released, "released"), "released");
  const releasedMs = performance.now() - started;
  t.diagnostic(`cap ${HANG_CAP} ms: result after ${resultMs.toFixed(1)} ms, every process gone after ${releasedMs.toFixed(1)} ms`);
  const started1 = await pairs(wrapper.sleepers);
  assert.equal(started1.length, 1, "status started its sleep");
  const [group, sleeper] = started1[0]!;
  assert.equal(alive(sleeper), false, "the sleep in git's process group was killed with it");
  assert.throws(() => process.kill(-group, 0), { code: "ESRCH" }, "the process group is empty");
  assert.deepEqual(made.stats(), { active: 0, queued: 0, peakActive: 1, unconfirmed: 0 });

  // Invalid sample: SIGKILL to the leader alone leaves the group's sleep running.
  await rm(wrapper.sleepers);
  const leader = spawn(join(wrapper.bin, "git"), ["-C", workspace, "status", "--porcelain"], { env: { HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, stdio: "ignore", detached: true });
  assert.ok(await until(async () => (await pairs(wrapper.sleepers)).length === 1, 5_000));
  const orphan = (await pairs(wrapper.sleepers))[0]![1];
  t.after(() => { try { process.kill(orphan, "SIGKILL"); } catch { /* Gone. */ } });
  leader.kill("SIGKILL");
  await once(leader, "exit");
  assert.equal(alive(orphan), true, "the sleep outlives a leader-only kill");
});

test("G071-C02 eight observations at once: at most four hold a slot, the others wait within their own cap; no more than four workspaces ever reach git; all eight end unavailable{timeout} with their processes gone", darwinOnly, async t => {
  const f = await fixture(t);
  const wrapper = await groupedGit(f.root), workspaces: string[] = [];
  for (let index = 0; index < 8; index++) workspaces.push(await hanging(f, "ws" + index));
  // The bound is the contract's (§10.6: global concurrency ≤ MAX_PARALLEL_CONVERSATIONS, 4), not the module's own constant.
  assert.equal(MAX_PARALLEL_CONVERSATIONS, 4);
  assert.equal(MAX_PARALLEL_OBSERVATIONS, MAX_PARALLEL_CONVERSATIONS);
  const made = await observer(t, f, { path: wrapper.bin + ":/usr/bin:/bin", timeoutMs: HANG_CAP });
  const running = workspaces.map(workspace => made.observe(workspace));
  const statusCalls = async () => (await readFile(wrapper.calls, "utf8").catch(() => "")).split("\n").filter(line => / status /u.test(line)).length;
  const handshake = await until(async () => await statusCalls() >= MAX_PARALLEL_CONVERSATIONS, HANG_CAP);
  const table = spawnSync("/bin/ps", ["-axo", "pgid=,command="], { encoding: "utf8", env: { LC_ALL: "C" } }).stdout;
  const blocked = new Set(table.split("\n").filter(line => line.includes(f.root) && / status /u.test(line)).map(line => line.trim().split(/\s+/u)[0]));
  t.diagnostic(`handshake ${handshake ? "reached" : "not reached before the cap"}; ${blocked.size} status process groups at that moment; stats ${JSON.stringify(made.stats())}`);
  assert.ok(blocked.size <= MAX_PARALLEL_CONVERSATIONS);
  const outcomes: ObservationOutcome[] = await guarded(Promise.all(running), "eight observations");
  assert.deepEqual(outcomes.map(outcome => outcome.observation), Array.from({ length: 8 }, () => ({ kind: "unavailable", reason: "timeout" })));
  assert.deepEqual(await guarded(Promise.all(outcomes.map(outcome => outcome.released)), "released"), Array.from({ length: 8 }, () => "released"));
  const reached = new Set((await readFile(wrapper.calls, "utf8")).split("\n").filter(Boolean).map(line => { const tokens = line.split(" "); return tokens[tokens.indexOf("-C") + 1]; }));
  assert.ok(reached.size <= MAX_PARALLEL_CONVERSATIONS, "workspaces that reached git: " + [...reached].join(", "));
  assert.deepEqual(made.stats(), { active: 0, queued: 0, peakActive: MAX_PARALLEL_CONVERSATIONS, unconfirmed: 0 });
  for (const [, sleeper] of await pairs(wrapper.sleepers)) assert.equal(alive(sleeper), false);
});

test("G071-C02 close() stops observations in flight as unavailable{error}, waits until their processes are gone, and refuses new ones", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await hanging(f, "ws"), wrapper = await groupedGit(f.root);
  const made = await createWorkspaceObserver({ path: wrapper.bin + ":/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: f.data, timeoutMs: CAP });
  const pending = made.observe(workspace);
  assert.ok(await until(async () => (await pairs(wrapper.sleepers)).length === 1, CAP / 2), "status is running");
  await guarded(made.close(), "close()");
  const outcome = await pending;
  assert.deepEqual(outcome.observation, { kind: "unavailable", reason: "error" });
  assert.equal(await outcome.released, "released");
  for (const [group, sleeper] of await pairs(wrapper.sleepers)) { assert.equal(alive(sleeper), false); assert.throws(() => process.kill(-group, 0), { code: "ESRCH" }); }
  await assert.rejects(made.observe(workspace), { code: "OBSERVER_CLOSED" });
  await made.close();
});

test("G071-C03 HEAD and .git/index unchanged within 60 s: the previous observation is given back; a moved index, another HEAD (by branch or by commit) or 60 s passed: observed again", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  await writeFile(join(workspace, "a.txt"), "changed\n");
  let clock = 1_000;
  const made = await observer(t, f, { now: () => clock });
  const first = await made.observe(workspace);
  assert.equal(first.reused, false);
  const same = await made.observe(workspace);
  assert.equal(same.reused, true);
  assert.equal(same.observation, first.observation, "the very observation is given back");
  clock += REUSE_WINDOW_MS;
  assert.equal((await made.observe(workspace)).reused, true, "60 s after it is still within the window");
  clock += 1;
  const stale = await made.observe(workspace);
  assert.equal(stale.reused, false, "past 60 s it is observed again");
  assert.notEqual(stale.observation, first.observation);

  await utimes(join(workspace, ".git", "index"), new Date(), new Date(Date.now() + 3_000));
  assert.equal((await made.observe(workspace)).reused, false, "the index moved");
  assert.equal((await made.observe(workspace)).reused, true);

  git(f, workspace, "branch", "other");
  git(f, workspace, "symbolic-ref", "HEAD", "refs/heads/other");
  const branched = await made.observe(workspace);
  assert.equal(branched.reused, false, "HEAD names another branch at the same commit");
  assert.ok(branched.observation.kind === "git" && branched.observation.branch === "other");

  const commit = git(f, workspace, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "moved");
  const index = await lstat(join(workspace, ".git", "index"), { bigint: true });
  git(f, workspace, "update-ref", "refs/heads/other", commit);
  assert.equal((await lstat(join(workspace, ".git", "index"), { bigint: true })).mtimeNs, index.mtimeNs, "the index did not move");
  const moved = await made.observe(workspace);
  assert.equal(moved.reused, false, "HEAD's commit moved");
  assert.ok(moved.observation.kind === "git" && moved.observation.head === commit);

  // The rule as designed (RT3 P07): an edit nothing told the index about is not noticed within the window.
  await writeFile(join(workspace, "a.txt"), "changed again, same index\n");
  assert.equal((await made.observe(workspace)).reused, true);
});

test("G071-C03 rev-parse runs with config --list, and status with diff; the driver names are kept by the config file's stat: an unchanged config is not listed again, a changed one is", darwinOnly, async t => {
  const f = await fixture(t);
  const workspace = await repository(f, "ws", { "a.txt": "a\n" });
  await writeFile(join(workspace, "a.txt"), "changed\n");
  git(f, workspace, "config", "filter.x.clean", "cat");
  const bin = join(f.root, "barrierbin"), log = join(f.root, "barrier.log"), gate = join(f.root, "gate");
  await mkdir(bin);
  await mkdir(gate);
  // While `gate/on` exists, rev-parse and config, and status and diff, each wait (up to 5 s) until the other of the pair
  // has started, and log whether it did. Run one after the other, the first of a pair could never see the second start.
  await writeFile(join(bin, "git"), `#!/usr/bin/perl
use strict; use warnings; use Time::HiRes qw(time sleep);
my ($command) = grep { /^(rev-parse|config|status|diff|check-attr)$/ } @ARGV;
$command //= '?';
my %pair = ('rev-parse' => 'config', 'config' => 'rev-parse', 'status' => 'diff', 'diff' => 'status');
my $met = '-';
if (-e '${gate}/on' && exists $pair{$command}) {
  open(my $mark, '>', "${gate}/started.$command") or die; close($mark);
  $met = 'timeout';
  for (my $end = time + 5; time < $end; sleep 0.005) { if (-e "${gate}/started.$pair{$command}") { $met = 'met'; last; } }
}
open(my $log, '>>', '${log}') or die; print $log "$command $met\\n"; close($log);
exec { '/usr/bin/git' } 'git', @ARGV; die "exec: $!";
`);
  await chmod(join(bin, "git"), 0o755);
  warm(join(bin, "git"));
  await rm(log, { force: true });
  const entries = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => { const [command, met] = line.split(" "); return { command: command!, met: met! }; });
  let clock = 0;
  const made = await observer(t, f, { path: bin + ":/usr/bin:/bin", now: () => clock });

  await writeFile(join(gate, "on"), "");
  const first = (await made.observe(workspace)).observation;
  assert.ok(first.kind === "git", JSON.stringify(first));
  assert.deepEqual(first.neutralized, ["x"]);
  const once1 = await entries();
  assert.deepEqual(once1.map(item => item.command).sort(), ["check-attr", "config", "diff", "rev-parse", "status"]);
  for (const command of ["rev-parse", "config", "status", "diff"]) assert.equal(once1.find(item => item.command === command)?.met, "met", command + " started while its pair was running: " + JSON.stringify(once1));
  await rm(gate, { recursive: true });

  clock += REUSE_WINDOW_MS + 1;
  await rm(log);
  const second = (await made.observe(workspace)).observation;
  assert.ok(second.kind === "git", JSON.stringify(second));
  assert.deepEqual((await entries()).map(item => item.command).sort(), ["check-attr", "diff", "rev-parse", "status"], "the unchanged config was not listed again");
  assert.deepEqual(second.neutralized, ["x"]);

  git(f, workspace, "config", "filter.y.clean", "cat");
  clock += REUSE_WINDOW_MS + 1;
  await rm(log);
  const third = (await made.observe(workspace)).observation;
  assert.ok(third.kind === "git", JSON.stringify(third));
  assert.ok((await entries()).some(item => item.command === "config"), "the changed config was listed again");
  assert.deepEqual(third.neutralized, ["x", "y"]);
  assert.equal((await made.observe(workspace)).reused, true, "the new driver list is part of what is reused");
});

test("G071-C03 a repository without commits, and SHA-256 repositories with and without commits, are observed with git (their own empty tree for --attr-source)", darwinOnly, async t => {
  const f = await fixture(t);
  const made = await observer(t, f);
  for (const format of ["sha1", "sha256"] as const) {
    const unborn = join(f.root, "unborn-" + format);
    await mkdir(unborn);
    git(f, unborn, "init", "-q", "--object-format=" + format);
    await writeFile(join(unborn, "a.txt"), "a\n");
    const first = (await made.observe(unborn)).observation;
    assert.ok(first.kind === "git", JSON.stringify(first));
    assert.deepEqual({ head: first.head, branch: first.branch, files: first.files.map(file => [file.path, file.change]) }, { head: null, branch: "main", files: [["a.txt", "untracked"]] });
    git(f, unborn, "add", "-A");
    git(f, unborn, "commit", "-qm", "base");
    await writeFile(join(unborn, "a.txt"), "changed\n");
    const born = (await made.observe(unborn)).observation;
    assert.ok(born.kind === "git", JSON.stringify(born));
    assert.equal(born.head?.length, format === "sha1" ? 40 : 64);
    assert.deepEqual(born.files.map(file => [file.path, file.change, file.added, file.removed]), [["a.txt", "modified", 1, 1]]);
  }
});

test("G071-C03 a workspace that does not exist, or is a file, is unavailable{no_workspace}; a relative or unbounded one, and a cap outside 1 to 60,000 ms, are refused as invalid input", darwinOnly, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "file"), "x");
  const made = await observer(t, f);
  assert.deepEqual((await made.observe(join(f.root, "missing"))).observation, { kind: "unavailable", reason: "no_workspace" });
  assert.deepEqual((await made.observe(join(f.root, "file"))).observation, { kind: "unavailable", reason: "no_workspace" });
  for (const bad of ["relative/path", "/a\nb", "/" + "x".repeat(5000)]) await assert.rejects(made.observe(bad), { code: "INVALID_INPUT" });
  await assert.rejects(createWorkspaceObserver({ path: "/usr/bin", home: join(f.root, "missing"), userHome: f.user, dataRoot: f.data }), { code: "INVALID_INPUT" });
  for (const timeoutMs of [0, MAX_OBSERVE_TIMEOUT_MS + 1, 2.5, Number.NaN]) await assert.rejects(createWorkspaceObserver({ path: "/usr/bin", home: f.home, userHome: f.user, dataRoot: f.data, timeoutMs }), { code: "INVALID_INPUT" }, "cap " + timeoutMs);
  await writeFile(join(f.home, "x"), "x");
  await assert.rejects(createWorkspaceObserver({ path: "/usr/bin", home: f.home, userHome: f.user, dataRoot: f.data }), { code: "INVALID_INPUT" }, "a home that is not empty");
});
