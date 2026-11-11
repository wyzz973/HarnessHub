import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * What the relay ruler judges with (relay-task.real.ts): the repo as a Harness left it, read by the judge's own hands.
 * Nothing here asks a model anything. A repo is compared by file digests (what changed, what was added or removed), its tests
 * are run with Node's own runner (the TAP reporter, parsed for the names that passed and failed), and a hidden probe of
 * the judge's own, which a Harness never sees, is run against the repo's modules.
 */

/** The ruler's fixture repos: tests/fixtures/ruler of this repository, from the compiled module in dist/tests/real/ruler. */
export const FIXTURES = fileURLToPath(new URL("../../../../tests/fixtures/ruler/", import.meta.url));

/** File digests by repo-relative path with "/". */
export type Hashes = ReadonlyMap<string, string>;
/** Dot-directories are the Harnesses' own (.claude, .codex, .git...) and node_modules is nobody's work: none of them is the repo. */
const skipped = (name: string): boolean => name === "node_modules" || name.startsWith(".");
/** Every regular file under `dir` (but dot-entries and node_modules), by the sha256 of its content. */
export async function hashTree(dir: string, prefix = ""): Promise<Hashes> {
  const hashes = new Map<string, string>();
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (skipped(entry.name)) continue;
    const path = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) for (const [name, hash] of await hashTree(dir, path)) hashes.set(name, hash);
    else if (entry.isFile()) hashes.set(path, createHash("sha256").update(await readFile(join(dir, path))).digest("hex"));
  }
  return hashes;
}
export interface TreeDiff { readonly modified: readonly string[]; readonly added: readonly string[]; readonly removed: readonly string[] }
export function diffTrees(before: Hashes, after: Hashes): TreeDiff {
  const modified = [...before].filter(([path, hash]) => after.has(path) && after.get(path) !== hash).map(([path]) => path);
  return { modified: modified.sort(), added: [...after.keys()].filter(path => !before.has(path)).sort(), removed: [...before.keys()].filter(path => !after.has(path)).sort() };
}
/** The paths of a diff that changed what was there (modified or removed), under `prefix` when one is given. */
export function disturbed(diff: TreeDiff, prefix = ""): readonly string[] {
  return [...diff.modified, ...diff.removed].filter(path => path.startsWith(prefix)).sort();
}
export const untouched = (diff: TreeDiff): boolean => diff.modified.length + diff.added.length + diff.removed.length === 0;

/** Writes `files` (relative path to content) under `dir`, making the directories. */
export async function writeTree(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), text); }
}
/** The files under `from` (relative paths with "/"), without dot-entries. */
export async function listFiles(from: string): Promise<readonly string[]> {
  return [...await hashTree(from)].map(([path]) => path).sort();
}
/** Copies every file of `from` into `to` over what is there, and says which paths it wrote. */
export async function copyFiles(from: string, to: string): Promise<readonly string[]> {
  const written: string[] = [];
  for (const path of await listFiles(from)) {
    await mkdir(dirname(join(to, path)), { recursive: true });
    await writeFile(join(to, path), await readFile(join(from, path)));
    written.push(path);
  }
  return written;
}

/** The names that passed and failed in a Node test run. A file that could not load shows as one failed name (its path). */
export interface TestRun { readonly pass: readonly string[]; readonly fail: readonly string[]; readonly exitCode: number | null; readonly timedOut: boolean; readonly output: string }
/** The names of the top-level tests in TAP output (`ok 3 - name`, `not ok 4 - name`); nested lines are indented and not read. */
export function parseTap(output: string): { readonly pass: string[]; readonly fail: string[] } {
  const pass: string[] = [], fail: string[] = [];
  for (const line of output.split("\n")) {
    const found = /^(not ok|ok) \d+ - (.+?)(?: # (?:SKIP|TODO).*)?$/u.exec(line);
    if (found !== null) (found[1] === "ok" ? pass : fail).push(found[2]!);
  }
  return { pass, fail };
}
/**
 * The environment a judged child runs in: ours, but without what makes a nested `node --test` think it is a worker of the
 * runner this process runs under (NODE_TEST_CONTEXT), which would turn its TAP into serialized events.
 */
function childEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _coverage, ...rest } = process.env;
  return { ...rest, ...extra };
}
/**
 * Runs `node --test` in `cwd` (the repo's own tests, or the named files) and reads its TAP. Never throws for a failing
 * suite; a run that outlasts `timeoutMs` is killed with its whole process group and reported as timed out.
 */
export function runTests(cwd: string, files: readonly string[] = [], env: Readonly<Record<string, string>> = {}, timeoutMs = 60_000): Promise<TestRun> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd, env: childEnvironment(env), stdio: ["ignore", "pipe", "ignore"], detached: true });
    const chunks: Buffer[] = [];
    let size = 0, timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { if (size < 4 << 20) { chunks.push(chunk); size += chunk.length; } });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* it ended */ } }, timeoutMs);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8"), tap = parseTap(output);
      resolve({ pass: tap.pass, fail: tap.fail, exitCode, timedOut, output });
    };
    child.on("error", () => done(null));
    child.on("close", code => done(code));
  });
}
/** The judge's hidden probe (a test file of the fixtures) run against the repo at `repo`; it reads the repo's path from RULER_REPO. */
export function runProbe(probe: string, repo: string, timeoutMs = 60_000): Promise<TestRun> {
  return runTests(repo, [probe], { RULER_REPO: repo }, timeoutMs);
}
/** A run that executed something, failed nothing and was not cut short. */
export const clean = (run: TestRun): boolean => run.fail.length === 0 && run.pass.length > 0 && !run.timedOut && run.exitCode === 0;
