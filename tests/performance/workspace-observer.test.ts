import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { OBSERVE_TIMEOUT_MS, createWorkspaceObserver, type WorkspaceObservation, type WorkspaceObserver } from "../../src/infrastructure/session/workspace-observer.js";

// G071-C04 (ADR-055 §11.1): observeMs (the observation's durationMs) on synthetic git repositories: 3,000 files, 20,000
// files, big files (two 16 MiB files rewritten at the same size, so git must hash them), and a cold cache (the 3,000-file
// repository on a disk image detached and attached again before every sample). Each has three filter drivers mapped to
// every file, 40 changed tracked files and 10 untracked ones. CI asserts counts and determinism only: every sample that is
// not a timeout is the same complete git observation with the same fingerprint, no filter ran, .git/index never moved.
// Milliseconds are reported, never asserted (§11.1). G071_SAMPLES=<n> (300 for a p95, 1,000 for a p99) runs the reference
// measurement with the real 250 ms cap, counts the timeouts and prints the distribution for the verification record.
// Without it each group takes 5 samples (cold: 4) under a 10 s cap, so that a machine busy with the rest of the suite
// cannot turn a sample into a timeout and leave the counts unchecked.

const darwinOnly = { skip: process.platform === "darwin" ? false : "the observer and the cold-cache disk image are macOS only (ADR-044)" };
const SETUP = ["-c", "user.email=g071@example.invalid", "-c", "user.name=g071", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const CHANGED = 40, UNTRACKED = 10, DRIVERS = ["first", "second.dotted", "third"] as const;

/** The cap in the CI run; the reference measurement uses the observer's default. */
const CI_CAP = { timeoutMs: 10_000 } as const;
function cap(): { readonly timeoutMs?: number } { return process.env.G071_SAMPLES === undefined ? CI_CAP : {}; }
function samples(): number {
  const raw = process.env.G071_SAMPLES;
  if (raw === undefined) return 5;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 2 || value > 5000) throw new Error("G071_SAMPLES must be a whole number of samples from 2 to 5,000");
  return value;
}
interface Fixture { readonly root: string; readonly home: string; readonly user: string; readonly data: string; readonly mark: string; readonly marks: string }
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "g071-perf-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const made = { root, home: join(root, "home"), user: join(root, "user"), data: join(root, "data"), mark: join(root, "mark.sh"), marks: join(root, "marks") };
  for (const directory of [made.home, made.user, made.data]) await mkdir(directory);
  await writeFile(made.mark, "#!/bin/sh\nprintf '%s\\n' \"$1\" >> '" + made.marks + "'\nexec cat\n");
  await chmod(made.mark, 0o755);
  return made;
}
function git(f: Fixture, cwd: string, ...args: string[]): void {
  execFileSync("/usr/bin/git", [...SETUP, ...args], { cwd, env: { HOME: f.user, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: "ignore", maxBuffer: 64 * 1024 * 1024 });
}
/**
 * A repository of `count` small files (`perDirectory` to a directory) and `big` files of 16 MiB, committed with a
 * .gitattributes that maps the three drivers, which are configured afterwards; then 40 tracked files are rewritten (and,
 * when there are big files, two of them at the same size) and 10 untracked ones are added.
 */
async function repository(f: Fixture, workspace: string, count: number, perDirectory: number, big: number): Promise<{ readonly total: number }> {
  await mkdir(workspace, { recursive: true });
  git(f, workspace, "init", "-q");
  const jobs: Promise<void>[] = [];
  for (let index = 0; index < count; index++) {
    const directory = join(workspace, "d" + String(Math.floor(index / perDirectory)).padStart(4, "0"));
    if (index % perDirectory === 0) await mkdir(directory, { recursive: true });
    jobs.push(writeFile(join(directory, "f" + String(index).padStart(5, "0") + ".txt"), "line " + index + "\n"));
    if (jobs.length >= 256) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
  for (let index = 0; index < big; index++) await writeFile(join(workspace, "big" + index + ".bin"), randomBytes(16 * 1024 * 1024));
  await writeFile(join(workspace, ".gitattributes"), "*.txt filter=first\n*.bin filter=second.dotted\n*.md filter=third\n");
  git(f, workspace, "add", "-A");
  git(f, workspace, "commit", "-qm", "base");
  for (const driver of DRIVERS) git(f, workspace, "config", `filter.${driver}.clean`, `"${f.mark}" ${driver}`);
  const later = new Date(Date.now() + 5_000);
  for (let index = 0; index < CHANGED; index++) {
    const path = join(workspace, "d" + String(Math.floor((index * Math.floor(count / CHANGED)) / perDirectory)).padStart(4, "0"), "f" + String(index * Math.floor(count / CHANGED)).padStart(5, "0") + ".txt");
    await writeFile(path, "changed line " + index + "\nand another\n");
    await utimes(path, later, later);
  }
  for (let index = 0; index < Math.min(big, 2); index++) { await writeFile(join(workspace, "big" + index + ".bin"), randomBytes(16 * 1024 * 1024)); await utimes(join(workspace, "big" + index + ".bin"), later, later); }
  for (let index = 0; index < UNTRACKED; index++) await writeFile(join(workspace, "new" + index + ".md"), "new " + index + "\n");
  return { total: CHANGED + Math.min(big, 2) + UNTRACKED };
}
interface Distribution { readonly n: number; readonly timeouts: number; readonly p50: number; readonly p95: number; readonly p95ci: readonly [number, number] | null; readonly p99: number | null; readonly max: number; readonly mean: number }
function quantile(sorted: readonly number[], q: number): number { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!; }
/** p50, p95 with a bootstrap 95% interval (1,000 resamples, fixed seed), p99 only from 1,000 samples up (§11.1). */
function distribution(values: readonly number[], timeouts: number): Distribution {
  const sorted = [...values].sort((a, b) => a - b), round = (x: number) => Math.round(x * 100) / 100;
  let seed = 0x6071;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const boot: number[] = [];
  if (sorted.length >= 300) for (let draw = 0; draw < 1000; draw++) boot.push(quantile(Array.from({ length: sorted.length }, () => sorted[Math.floor(random() * sorted.length)]!).sort((a, b) => a - b), 0.95));
  boot.sort((a, b) => a - b);
  return { n: sorted.length, timeouts, p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), p95ci: boot.length ? [round(quantile(boot, 0.025)), round(quantile(boot, 0.975))] : null,
    p99: sorted.length >= 1000 ? round(quantile(sorted, 0.99)) : null, max: round(sorted.at(-1) ?? 0), mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)) };
}
async function indexStamp(workspace: string): Promise<string> { const info = await lstat(join(workspace, ".git", "index"), { bigint: true }); return info.ino + ":" + info.mtimeNs; }
async function marks(f: Fixture): Promise<number> { try { return (await readFile(f.marks, "utf8")).split("\n").filter(Boolean).length; } catch { return 0; } }

/**
 * Observes `workspace` `count` times, never reusing (the clock moves past the 60 s window each time), and checks every
 * sample that is not a timeout against the first complete one. `before` runs ahead of each sample (the cold group
 * re-attaches its disk image there) and is not timed.
 */
async function measure(t: test.TestContext, f: Fixture, label: string, workspace: string, total: number, count: number, before?: () => Promise<void>): Promise<Distribution> {
  let clock = 0;
  const made: WorkspaceObserver = await createWorkspaceObserver({ path: "/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: f.data, now: () => (clock += 61_000), ...cap() });
  try {
    const stamp = await indexStamp(workspace), durations: number[] = [];
    let reference: Extract<WorkspaceObservation, { kind: "git" }> | null = null, timeouts = 0;
    for (let index = 0; index < count; index++) {
      if (before) await before();
      const outcome = await made.observe(workspace);
      assert.equal(await outcome.released, "released");
      const observation = outcome.observation;
      if (observation.kind === "unavailable") { assert.equal(observation.reason, "timeout", label); timeouts += 1; continue; }
      assert.equal(observation.kind, "git", label);
      assert.ok(observation.kind === "git");
      assert.equal(outcome.reused, false);
      assert.equal(observation.status, "complete", label);
      assert.deepEqual(observation.counted, { total, listed: total }, label);
      assert.deepEqual(observation.neutralized, [...DRIVERS].sort(), label);
      if (reference === null) reference = observation;
      else { assert.equal(observation.fingerprint, reference.fingerprint, label + " is deterministic"); assert.deepEqual(observation.files, reference.files, label); }
      durations.push(observation.durationMs);
    }
    assert.ok(reference !== null, label + ": at least one sample finished within the cap (" + (cap().timeoutMs ?? OBSERVE_TIMEOUT_MS) + " ms)");
    assert.equal(await marks(f), 0, label + ": no filter ran");
    assert.equal(await indexStamp(workspace), stamp, label + ": .git/index never moved");
    assert.equal(made.stats().unconfirmed, 0);
    const result = distribution(durations, timeouts);
    t.diagnostic(label + " " + JSON.stringify(result));
    return result;
  } finally { await made.close(); }
}
/** The reuse path, for G072's dispatch budget (§11.1: reuse ≤ observation p95 + 15 ms): the first call observes, then every
 * call within the window gives that observation back. */
async function reusePath(t: test.TestContext, f: Fixture, label: string, workspace: string, count: number): Promise<void> {
  const made = await createWorkspaceObserver({ path: "/usr/bin:/bin", home: f.home, userHome: f.user, dataRoot: f.data, now: () => 0, ...cap() });
  try {
    await (await made.observe(workspace)).released;
    const durations: number[] = [];
    for (let index = 0; index < count; index++) {
      const started = performance.now(), outcome = await made.observe(workspace);
      durations.push(performance.now() - started);
      assert.equal(outcome.reused, true, label);
      await outcome.released;
    }
    t.diagnostic(label + " reuse " + JSON.stringify(distribution(durations, 0)));
  } finally { await made.close(); }
}

test("G071-C04 3,000 and 20,000 files and big files: every observation is the same complete one, no filter runs and .git/index stays; observeMs reported", darwinOnly, async t => {
  const f = await fixture(t), count = samples();
  t.diagnostic("machine " + JSON.stringify({ cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), git: execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim(), node: process.version, samples: count }));
  for (const [label, files, perDirectory, big] of [["3k", 3_000, 30, 0], ["20k", 20_000, 50, 0], ["big", 1_000, 50, 4]] as const) {
    const workspace = join(f.root, label), { total } = await repository(f, workspace, files, perDirectory, big);
    // Two observations first, so that what is timed is the steady state of this process (code compiled, git started once).
    await measure(t, f, label + " warm-up", workspace, total, 2);
    await measure(t, f, label, workspace, total, count);
    await reusePath(t, f, label, workspace, Math.min(count, 300));
  }
});

test("G071-C04 a cold cache: the 3,000-file repository on a disk image detached and attached before each sample gives the same complete observation; observeMs reported", darwinOnly, async t => {
  // Four by default: each sample is a first look at a fresh mount, which a busy machine can push past 250 ms.
  const f = await fixture(t), count = process.env.G071_SAMPLES === undefined ? 4 : samples();
  const image = join(f.root, "cold.sparseimage"), mount = join(f.root, "mnt");
  await mkdir(mount);
  const hdiutil = (...args: string[]) => execFileSync("/usr/bin/hdiutil", args, { stdio: "ignore", timeout: 60_000 });
  hdiutil("create", "-size", "512m", "-fs", "APFS", "-volname", "g071cold", "-type", "SPARSE", "-quiet", join(f.root, "cold"));
  const attach = () => hdiutil("attach", "-nobrowse", "-noverify", "-noautoopen", "-quiet", "-mountpoint", mount, image);
  let attached = false;
  attach(); attached = true;
  try {
    const workspace = join(mount, "repo"), { total } = await repository(f, workspace, 3_000, 30, 0);
    // Forced: a fresh volume is often still held by the system's indexing when detached; the observer's own processes are
    // confirmed gone (`released`) before every detach.
    const result = await measure(t, f, "cold", workspace, total, count, async () => { hdiutil("detach", "-force", "-quiet", mount); attached = false; attach(); attached = true; });
    assert.ok(result.n >= 1);
  } finally {
    // Detached here, inside the test: the fixture's removal of the whole directory runs as an after hook.
    if (attached) hdiutil("detach", "-force", "-quiet", mount);
  }
});
