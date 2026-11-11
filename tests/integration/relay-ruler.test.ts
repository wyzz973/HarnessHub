import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DRY_HARNESSES, ScriptedHarnesses, dryHub, dryProblems } from "../real/ruler/dry.js";
import { planCells, runRuler, type RulerOptions } from "../real/ruler/run.js";
import { MODES, outcome } from "../real/ruler/table.js";
import { CART_FIRST, CART_SECOND, TASK_IDS } from "../real/ruler/tasks.js";

// The relay ruler end to end without a Harness (the dry run of tests/real/relay-task.real.ts): its driver through the Hub's
// formal Runtime and a real SQLite store, over scripted Harnesses that do what the user's words, in their own session or in
// the relay's packet, let them know to do. If this passes, the ruler can tell a Harness that was told from one that was not,
// and the relay tells the next Harness what the user said.

test("the ruler's dry run: every task, three ways of running, one direction; the relay carries the user's words and the floor does not", async t => {
  const root = await mkdtemp(join(tmpdir(), "ruler-dry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripted = new ScriptedHarnesses(), cells = planCells({ tasks: TASK_IDS, modes: MODES, harnesses: DRY_HARNESSES, both: false, repeat: 1 });
  assert.equal(cells.length, 12);
  const rows = await runRuler({ root, cells, open: async (_spec, where) => dryHub(where, scripted), select: harnessId => ({ harnessId }), stepLimitMs: 60_000, tokenLimit: 1_000_000, errorLimit: 1,
    announce: (spec, built, step) => { scripted.scene = { task: spec.task, built, step }; } });
  assert.deepEqual(dryProblems(rows, scripted, cells), []);
  assert.deepEqual(rows.map(outcome).filter(result => result === "ERROR" || result === "INVALID"), []);

  // What reached the second Harness in the second step of the cart: alone twice (the baseline, the floor) and once with the packet.
  const toBravo = scripted.prompts.filter(prompt => prompt.task === "cart" && prompt.harnessId === "bravo" && prompt.step === 2);
  assert.equal(toBravo.length, 3);
  assert.deepEqual(toBravo.filter(prompt => prompt.text === CART_SECOND).length, 2, "typed, nothing else");
  const carried = toBravo.find(prompt => prompt.text !== CART_SECOND)!;
  assert.match(carried.text, /交接单/u); assert.ok(carried.text.includes("不许改它"), "the user's rules went with the packet"); assert.ok(carried.text.endsWith(CART_SECOND), "the user's words come last, exactly as typed");
  assert.ok(CART_FIRST.includes("不许改它"));

  // Every cell kept a row of the same shape, and the evidence-facing numbers are there.
  for (const row of rows) {
    assert.equal(row.steps.length, 2, row.task + " " + row.mode);
    assert.ok(row.steps.every(step => step.status === "completed" && step.wallMs >= 0 && step.tokens !== null));
  }
  assert.ok(rows.filter(row => row.mode === "relay").every(row => typeof row.steps[1]!.handoff!.tokens === "number" && (row.steps[1]!.handoff!.tokens as number) > 0));
});

async function run(t: test.TestContext, scripted: ScriptedHarnesses, harnesses: readonly [string, string], limits: Partial<RulerOptions>, tasks = TASK_IDS) {
  const root = await mkdtemp(join(tmpdir(), "ruler-dry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cells = planCells({ tasks, modes: MODES, harnesses, both: true, repeat: 1 });
  return runRuler({ root, cells, open: async (_spec, where) => dryHub(where, scripted), select: harnessId => ({ harnessId }), stepLimitMs: 60_000, tokenLimit: 1_000_000, errorLimit: 3,
    announce: (spec, built, step) => { scripted.scene = { task: spec.task, built, step }; }, ...limits });
}

test("the ruler stops when its safety valves say so: cells it cannot run, invalid cells in a row, a step past the token line", async t => {
  // Harnesses that are not installed: every cell fails before its first message, and the third failure ends the run.
  const unknown = await run(t, new ScriptedHarnesses({ unavailable: ["ghost", "spirit"] }), ["ghost", "spirit"], {});
  assert.deepEqual([unknown.length, unknown.map(outcome)], [3, ["ERROR", "ERROR", "ERROR"]]);
  assert.match(unknown[0]!.error!, /HARNESS_UNAVAILABLE/u);

  // Harnesses that touch nothing: the cart's first step never fixes the money test, so no cell can measure the bridge; the fourth in a row ends the run.
  const idle = await run(t, new ScriptedHarnesses({ lazy: true }), [...DRY_HARNESSES], {}, ["cart"]);
  assert.deepEqual([idle.length, idle.map(outcome)], [4, ["INVALID", "INVALID", "INVALID", "INVALID"]]);
  assert.equal(idle[0]!.invalid, "step 1 did not fix the money test");
  assert.equal(idle[0]!.steps.length, 1, "the second message was never sent");

  // A step that reports more tokens than the line allows ends the run at once, and its row says why.
  const spent = await run(t, new ScriptedHarnesses(), [...DRY_HARNESSES], { tokenLimit: 1000 });
  assert.deepEqual([spent.length, outcome(spent[0]!)], [1, "ERROR"]);
  assert.match(spent[0]!.error!, /stop line/u);
});

test("a step that never ends is cancelled at the script's own limit and the run goes on to the judge, not hanging", async t => {
  const hung = await run(t, new ScriptedHarnesses({ hang: true }), [...DRY_HARNESSES], { stepLimitMs: 1500, invalidLimit: 1 }, ["worker"]);
  assert.deepEqual([hung.length, outcome(hung[0]!)], [1, "INVALID"]);
  assert.deepEqual([hung[0]!.steps[0]!.timedOut, hung[0]!.steps[0]!.status], [true, "cancelled"]);
  assert.match(hung[0]!.invalid!, /step 1 ended cancelled/u);
});
