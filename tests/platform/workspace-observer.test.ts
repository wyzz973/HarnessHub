import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDirectory, createWorkspaceObserver } from "../../src/infrastructure/session/workspace-observer.js";

// G071-C05 (ADR-055 §10.1, §10.6; VF3-11): on macOS APFS one workspace has many spellings: through the /var link, in
// another case, with decomposed accents, through its firmlink under /System/Volumes/Data, with `..`. They all have one
// realpath for the observer, so git's toplevel check holds for each and they are one workspace to the reuse rule. The
// invalid samples are Node's own two realpaths, each of which keeps some of those spellings apart (VF3 measured the same).

const darwinOnly = { skip: process.platform === "darwin" ? false : "APFS spellings and firmlinks are macOS only (ADR-044)" };
const SETUP = ["-c", "user.email=g071@example.invalid", "-c", "user.name=g071", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];
/**
 * The cap these cases give their observers: they check what an observation finds, not when, and with about 120 test files
 * running at once a busy machine can push a small observation past 250 ms. The cap itself is tested at its default (C02).
 */
const CAP = 10_000;

/** The spellings of `given` (a path made through the /var link) that name the same directory on this volume. */
async function spellings(given: string): Promise<Readonly<Record<string, string>>> {
  const real = await realpath(given), name = given.slice(given.lastIndexOf("/") + 1);
  return {
    "through /var": given, "realpath": real, "upper case": given.toUpperCase(), "decomposed accents": given.normalize("NFD"),
    "firmlink": "/System/Volumes/Data" + real, "firmlink, upper case, decomposed": ("/System/Volumes/Data" + real).toUpperCase().normalize("NFD"),
    "with ..": given + "/../" + name, "doubled slashes": given.replace(/\//gu, "//"),
  };
}

test("G071-C05 every spelling of one workspace (/var link, case, NFD, firmlink, .., //) has one realpath; git's toplevel check holds for each and the observer reuses one observation across them; Node's realpaths keep some apart", darwinOnly, async t => {
  const raw = await mkdtemp(join(tmpdir(), "g071-plat-"));
  t.after(() => rm(raw, { recursive: true, force: true }));
  const root = await realpath(raw), home = join(root, "home"), user = join(root, "user"), data = join(root, "data");
  for (const directory of [home, user, data]) await mkdir(directory);
  const given = join(raw, "Café 工作区");
  await mkdir(given);
  const env = { HOME: user, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", PATH: "/usr/bin:/bin", LC_ALL: "C" };
  execFileSync("/usr/bin/git", [...SETUP, "init", "-q"], { cwd: given, env });
  await writeFile(join(given, "a.txt"), "a\n");
  execFileSync("/usr/bin/git", [...SETUP, "add", "-A"], { cwd: given, env });
  execFileSync("/usr/bin/git", [...SETUP, "commit", "-qm", "base"], { cwd: given, env });
  await writeFile(join(given, "a.txt"), "changed\n");
  const all = await spellings(given), canonical = await canonicalDirectory(given), identity = await stat(given, { bigint: true });
  assert.equal(canonical, canonical.normalize("NFC"));
  assert.ok(canonical.startsWith("/private/var/"), canonical);
  for (const [name, spelling] of Object.entries(all)) {
    const info = await stat(spelling, { bigint: true });
    assert.deepEqual([info.dev, info.ino], [identity.dev, identity.ino], name + " names the same directory (APFS is case- and normalization-insensitive here)");
    assert.equal(await canonicalDirectory(spelling), canonical, name);
  }

  const made = await createWorkspaceObserver({ path: "/usr/bin:/bin", home, userHome: user, dataRoot: data, now: () => 0, timeoutMs: CAP });
  t.after(() => made.close());
  const first = await made.observe(all["through /var"]!);
  assert.ok(first.observation.kind === "git", JSON.stringify(first.observation));
  assert.deepEqual(first.observation.files.map(file => file.path), ["a.txt"]);
  for (const [name, spelling] of Object.entries(all)) {
    const again = await made.observe(spelling);
    assert.equal(again.reused, true, name + " is the same workspace");
    assert.equal(again.observation, first.observation, name);
  }

  // A tree observation has no reuse: each spelling is observed afresh and gives the same fingerprint.
  const plain = join(raw, "Plain Ünïcode 目录");
  await mkdir(plain);
  await writeFile(join(plain, "x.txt"), "x");
  const prints = new Set<string>();
  for (const spelling of Object.values(await spellings(plain))) {
    const observation = (await made.observe(spelling)).observation;
    assert.ok(observation.kind === "tree", JSON.stringify(observation));
    prints.add(observation.fingerprint);
  }
  assert.equal(prints.size, 1);

  // Invalid samples: Node's JavaScript realpath keeps case and NFD spellings apart, its native one keeps the firmlink apart.
  assert.notEqual(realpathSync(all["upper case"]!), canonical);
  assert.notEqual(realpathSync(all["decomposed accents"]!), canonical);
  assert.notEqual(await realpath(all["firmlink"]!), canonical);
});
