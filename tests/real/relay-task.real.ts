import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { type SelectionRequest } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, guardTargets, recheck, snapshot, standaloneHeader, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { closeApp, list, selection } from "./relay-support.js";
import { DRY_HARNESSES, ScriptedHarnesses, dryHub, dryProblems, dryTableHub } from "./ruler/dry.js";
import { WatchedMount } from "./ruler/mount.js";
import { planCells, promptCount, runRuler, type CellHub, type CellSpec } from "./ruler/run.js";
import { MODES, outcome, renderTable, type CellRow, type Mode } from "./ruler/table.js";
import { TASK_IDS, type TaskId } from "./ruler/tasks.js";
import { openWebHub } from "./ruler/web.js";

/**
 * The relay ruler (docs/verification/relay-ruler.md): how well a real coding task survives a change of Harness half-way, measured
 * on the user's installed Harnesses through the Hub's formal Runtime and a real SQLite store. Each task (tests/fixtures/ruler) is
 * a small repo with failing tests, built in a private temporary directory, done in two messages; the second only means something
 * to a Harness that knows the first. Every task runs three ways: alone on one Harness (the baseline), handed over to the other
 * Harness with the relay's packet (the relay), and handed over with the packet switched off, `relay: { attach: "none" }` (the
 * floor). The judge reads the repo, never the model's own account: the repo's tests, which files were and were not to be
 * touched, a hidden probe of the judge's, and what a reply says that only the history could tell. The second step's cost is
 * counted from its tool calls (what it read again, what it ran) and the packet's estimated size is read from the Store.
 * What the script measures is not asserted: a failed task is a finding. It fails for what the measurement cannot survive: the
 * user's configuration changing, or a cell that could not be run.
 *
 * Variables: HH_REAL_HARNESSES (two Harness identities, for example claude,codex), HH_REAL_EVIDENCE (the evidence file, written
 * after every cell), HH_REAL_MODEL_<ID> and HH_REAL_OPTIONS_<ID> (a native model, and a JSON object of native options, per
 * Harness), HH_REAL_TASKS (cart, booking, worker; or a, b, c; all by default), HH_REAL_MODES (solo, relay, floor; all by
 * default), HH_REAL_DIRECTIONS (both, or forward for first to second only; both by default), HH_REAL_REPEAT (runs of every cell,
 * 1 by default), HH_REAL_STEP_MINUTES (a step's execution budget, 5), HH_REAL_TOKEN_LIMIT (a step past this many tokens ends
 * the run, 2000000: a coding step re-reads its context at every tool call and the count adds those reads up, so the toy walks'
 * 150000 is far too low; the step's time limit is the tighter bound), HH_REAL_KEEP=1
 * (keep the temporary directory), HH_REAL_DRY=1 (no Harness is started: scripted ones play both, to show the ruler can tell a
 * Harness that was told from one that was not), HH_REAL_TABLE=1 (mount the Hub's context table: each cell's Hub is the Hub's web
 * server on a random loopback port, so the native processes get the table's address and a token and a Harness whose configuration
 * holds the Hub's tool entry can read the conversation back; with HH_REAL_DRY=1 the scripted Harnesses stand in for such Harnesses
 * and the Hub's real tool program reads back for them. The ruler installs nothing: the entry is the manager's to write first, from
 * the build that runs the ruler, and every step's evidence says whether its Harness held it, whether the packet told of it and
 * what the step called; without the variable the run is what it was). Evidence holds verdicts, counts, times and the start of each
 * reply; the repos are synthetic and removed afterwards. Native sessions the Harnesses keep in their own stores are theirs to keep.
 */
const dry = process.env.HH_REAL_DRY === "1", mounted = process.env.HH_REAL_TABLE === "1";
const evidencePath = process.env.HH_REAL_EVIDENCE;
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
const environment = captureNativeEnvironment();
const LETTERS: Readonly<Record<string, TaskId>> = { a: "cart", b: "booking", c: "worker" };

function tasksFrom(value: string | undefined): readonly TaskId[] {
  const names = list(value);
  if (names.length === 0) return TASK_IDS;
  return names.map(name => {
    const task = LETTERS[name.toLowerCase()] ?? TASK_IDS.find(id => id === name.toLowerCase());
    assert.ok(task, "HH_REAL_TASKS names cart, booking or worker (or a, b, c); got " + name);
    return task;
  });
}
function modesFrom(value: string | undefined): readonly Mode[] {
  const names = list(value);
  if (names.length === 0) return MODES;
  return names.map(name => {
    const mode = MODES.find(item => item === name.toLowerCase());
    assert.ok(mode, "HH_REAL_MODES names solo, relay or floor; got " + name);
    return mode;
  });
}
function whole(name: string, fallback: number, least: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isInteger(value) && value >= least, name + " must be a whole number of at least " + least);
  return value;
}
/** The selection a cell asks for: HH_REAL_MODEL_<ID> and HH_REAL_OPTIONS_<ID> (as in the other suites) when the Harness is a real one. */
function selected(harnessId: string): SelectionRequest {
  if (dry) return { harnessId };
  const options = process.env["HH_REAL_OPTIONS_" + harnessId.toUpperCase()];
  return { ...selection(harnessId), ...(options === undefined ? {} : { nativeOptions: JSON.parse(options) as Record<string, string> }) };
}

test("a real coding task survives a change of Harness: the repo, judged by its tests and rules, with the packet, without it, and on one Harness", { timeout: whole("HH_REAL_TIMEOUT_MINUTES", 240, 1) * 60_000 }, async () => {
  const harnesses = dry && list(process.env.HH_REAL_HARNESSES).length === 0 ? [...DRY_HARNESSES] : list(process.env.HH_REAL_HARNESSES);
  assert.equal(harnesses.length, 2, "set HH_REAL_HARNESSES to two installed Harness identities, for example claude,codex");
  const [first, second] = harnesses as [string, string];
  assert.notEqual(first, second, "a relay needs two different Harnesses");
  if (!dry) {
    assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path"); guardTargets(harnesses);
    for (const id of harnesses) assert.doesNotThrow(() => selected(id), "HH_REAL_OPTIONS_" + id.toUpperCase() + " must be a JSON object of native options");
  }
  const stepMinutes = whole("HH_REAL_STEP_MINUTES", 5, 1), stepLimitMs = stepMinutes * 60_000;
  const cells = planCells({ tasks: tasksFrom(process.env.HH_REAL_TASKS), modes: modesFrom(process.env.HH_REAL_MODES), harnesses: [first, second],
    both: (process.env.HH_REAL_DIRECTIONS ?? "both") !== "forward", repeat: whole("HH_REAL_REPEAT", 1, 1) });
  assert.ok(cells.length > 0, "nothing to run: HH_REAL_TASKS and HH_REAL_MODES leave no cell");
  const before = dry ? undefined : await snapshot(harnesses, environment);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-ruler-"))), locks = join(root, "locks");
  // The watched mount of the context table, when mounted: the Hub's own mount, which also remembers which processes it gave the table to.
  const mount = mounted ? new WatchedMount() : undefined, scripted = new ScriptedHarnesses(mount === undefined ? {} : { table: mount });
  let header: EvidenceHeader | null = null, guard: GuardCheck | undefined, failure: unknown, rows: readonly CellRow[] = [];
  const plan = { tasks: [...new Set(cells.map(cell => cell.task))], modes: [...new Set(cells.map(cell => cell.mode))], cells: cells.length, prompts: promptCount(cells), repeat: Math.max(...cells.map(cell => cell.repeat)), stepMinutes };
  const write = async (done: readonly CellRow[]): Promise<void> => {
    if (evidencePath === undefined) return;
    await writeFile(evidencePath, JSON.stringify({ header, harnesses, models: Object.fromEntries(harnesses.map(id => [id, selection(id).nativeModel ?? null])),
      options: Object.fromEntries(harnesses.map(id => [id, process.env["HH_REAL_OPTIONS_" + id.toUpperCase()] ?? null])), dry, tableMounted: mounted, plan, rows: done, table: renderTable(done),
      guard: guard === undefined ? null : { unchanged: guard.unchanged, description: describeGuard(guard) }, failure: failure instanceof Error ? failure.message : failure === undefined ? null : String(failure) }, null, 2) + "\n", { mode: 0o600 });
  };
  process.stdout.write("\nrelay ruler" + (dry ? " (dry run: scripted Harnesses)" : "") + (mounted ? " (context table mounted)" : "") + ": " + plan.cells + " cells, " + plan.prompts + " prompts, " + first + " and " + second + "\n");
  try {
    if (!dry) {
      const workspace = join(root, "header-workspace"); await mkdir(workspace);
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      header = await standaloneHeader(harnesses, { root, workspaceLockRoot: locks, policy: realInstallations, configuration });
    }
    const open = async (_spec: CellSpec, where: { readonly workspace: string; readonly data: string }): Promise<CellHub> => {
      if (dry) return mounted ? dryTableHub(where, scripted) : dryHub(where, scripted);
      if (mount !== undefined) return openWebHub(where, { mount, installations: realInstallations, locks, budgets: { executionBudgetMs: stepLimitMs }, ...(process.env.HH_REAL_MANIFEST ? { manifest: process.env.HH_REAL_MANIFEST } : {}) });
      const app = application(where.data, () => {}, { installations: realInstallations, workspaceLockRoot: locks, budgets: { executionBudgetMs: stepLimitMs } });
      try {
        const configuration = await prepareConfiguration({ workspace: where.workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
        return { runtime: app.runtime, store: app.store, content: app.content, configuration, close: () => closeApp(app) };
      } catch (error) { await closeApp(app).catch(() => undefined); throw error; }
    };
    rows = await runRuler({ root, cells, open, select: selected, stepLimitMs: stepLimitMs + 60_000, tokenLimit: whole("HH_REAL_TOKEN_LIMIT", 2_000_000, 1000), errorLimit: 3,
      announce: (spec, built, step) => { scripted.scene = { task: spec.task, built, step }; },
      log: line => { process.stdout.write(line + "\n"); }, onRow: async (_row, done) => { await write(done); } });
    if (dry) {
      const problems = dryProblems(rows, scripted, cells);
      assert.deepEqual(problems, [], "the dry run found the ruler or the relay wanting");
    }
  } catch (error) { failure = error; }
  finally {
    if (before !== undefined) { try { guard = await recheck(before, environment); } catch (error) { failure ??= error; } }
    try { await write(rows); } catch (error) { failure ??= error; }
    if (process.env.HH_REAL_KEEP === "1") process.stdout.write("kept: " + root + "\n"); else await rm(root, { recursive: true, force: true });
  }
  process.stdout.write("\n" + renderTable(rows) + (evidencePath === undefined ? "" : "\nevidence: " + evidencePath + "\n"));
  if (guard !== undefined) assert.ok(guard.unchanged, "the user's own configuration must remain unchanged: " + describeGuard(guard));
  if (failure !== undefined) throw failure;
  const unrun = rows.filter(row => outcome(row) === "ERROR");
  assert.deepEqual(unrun.map(row => row.task + " " + row.mode + " " + row.route + ": " + row.error), [], "cells that could not be run");
  assert.equal(rows.length, cells.length, "the run ended before every cell ran");
});
