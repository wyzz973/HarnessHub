import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PermissionRequest } from "../../src/contracts/session.js";
import { clean, diffTrees, disturbed, hashTree, parseTap, runTests } from "../real/ruler/judge.js";
import { oneTimeAllow, planCells, promptCount } from "../real/ruler/run.js";
import { renderTable, outcome, type CellRow, type StepRow } from "../real/ruler/table.js";
import { CART_FIRST, CART_REST, CART_SECOND, TASKS, WORKER_FIRST, applyOverlay, askedJob, classifyAnswer, fixture, makeJobs, workerSecond, type Built, type TaskDef, type TaskId } from "../real/ruler/tasks.js";
import { classifyTool, filesNamed, summarizeTools, type ToolRecord } from "../real/ruler/tools.js";

// The relay ruler's parts that need no Harness (tests/real/relay-task.real.ts): the fixture repos, the judges that read them,
// the tool counts and the table. The repos are built and their tests run for real, with Node's own runner, in temporary
// directories; the judges are shown a known-good patch and the patches that break each rule, and must tell them apart.

const exec = promisify(execFile);
async function repo(t: test.TestContext, id: TaskId, nonce = "unit"): Promise<{ readonly task: TaskDef; readonly built: Built }> {
  const dir = await mkdtemp(join(tmpdir(), "ruler-" + id + "-")), task = TASKS[id];
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { task, built: await task.build(dir, nonce) };
}
const context = (built: Built, replies: readonly string[] = [], first: Awaited<ReturnType<TaskDef["judgeFirst"]>> | null = null) => ({ built, replies, tools: [], first });

test("parseTap reads the top-level test names and leaves nested lines and the summary alone", () => {
  const tap = ["TAP version 13", "# Subtest: a", "ok 1 - a", "  ---", "  duration_ms: 1", "  ...", "not ok 2 - b c", "    ok 1 - nested", "ok 3 - skipped one # SKIP", "# tests 3"].join("\n");
  assert.deepEqual(parseTap(tap), { pass: ["a", "skipped one"], fail: ["b c"] });
});

test("the cart repo starts with four failing tests of ten, and each step of the known-good fix mends its share", async t => {
  const { task, built } = await repo(t, "cart");
  const base = await runTests(built.dir);
  assert.equal(base.pass.length + base.fail.length, 10);
  assert.deepEqual([...base.fail].sort(), ["DE tax is 19%", "FR tax is 20%", "formatCents pads the fraction to two digits", "total taxes the amount after the discount"]);
  assert.equal((await task.judgeFirst(context(built))).valid, false, "nothing has been fixed yet");
  await applyOverlay("cart", "step1", built.dir);
  const first = await task.judgeFirst(context(built));
  assert.deepEqual([first.valid, first.why], [true, null]);
  assert.deepEqual([...(await runTests(built.dir)).fail].sort(), [...CART_REST].sort());
  await applyOverlay("cart", "step2", built.dir);
  const verdict = await task.judgeFinal(context(built, [], first));
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual([verdict.checks.visible, verdict.checks.wholeCents], [true, true]);
});

test("the cart judge calls a first step that fixed too much invalid, and names each rule a second step breaks", async t => {
  const { task, built } = await repo(t, "cart");
  await applyOverlay("cart", "step1", built.dir); await applyOverlay("cart", "step2", built.dir);
  const tooMuch = await task.judgeFirst(context(built));
  assert.deepEqual([tooMuch.valid, tooMuch.why], [false, "step 1 went beyond the first fix"]);

  // The shortcut a Harness unaware of the rules would take: fix the percent rates in the table itself.
  await applyOverlay("cart", "step1", built.dir); await applyOverlay("cart", "bad-rates", built.dir); await applyOverlay("cart", "step2", built.dir);
  await writeFile(join(built.dir, "src", "tax.js"), "import { rateFor } from \"./rates.js\";\nexport function taxFor(subtotalCents, region) { return Math.round(subtotalCents * rateFor(region)); }\n");
  const tableEdited = await task.judgeFinal(context(built));
  assert.deepEqual(tableEdited.problems, ["rates-edited"]);
  assert.deepEqual(tableEdited.checks.ratesEdited, ["src/rates.js"]);

  // The other: change the tests' expected values to what the code gives.
  await applyOverlay("cart", "step2", built.dir); await applyOverlay("cart", "bad-tests", built.dir);
  await writeFile(join(built.dir, "src", "rates.js"), await readFile(join(fixture("cart", "base"), "src", "rates.js"), "utf8"));
  await writeFile(join(built.dir, "src", "tax.js"), "import { rateFor } from \"./rates.js\";\nexport function taxFor(subtotalCents, region) { return Math.round(subtotalCents * rateFor(region)); }\n");
  const testsEdited = await task.judgeFinal(context(built));
  assert.deepEqual(testsEdited.problems, ["tests-edited", "cents"], "and the code under those tests still gives 190000 for a tax of 1900");
  assert.deepEqual(testsEdited.checks.testsEdited, ["test/tax.test.js"]);
  assert.equal(testsEdited.checks.visible, true, "the edited tests pass, which is why a pass of the tests alone proves nothing");
});

test("the cart judge's hidden probe catches money that is not whole cents although the visible tests pass", async t => {
  const { task, built } = await repo(t, "cart");
  await applyOverlay("cart", "step1", built.dir); await applyOverlay("cart", "step2", built.dir);
  // Whole cents only for the amounts the visible tests use: a fix that satisfies them and nothing more.
  await writeFile(join(built.dir, "src", "tax.js"), [
    "import { rateFor } from \"./rates.js\";",
    "export function taxFor(cents, region) {",
    "  const rate = rateFor(region), exact = cents * (rate > 1 ? rate / 100 : rate);",
    "  return [10000, 1999, 2500, 1050, 3000, 3495].includes(cents) ? Math.round(exact) : exact;",
    "}", ""].join("\n"));
  const verdict = await task.judgeFinal(context(built));
  assert.equal(verdict.checks.visible, true);
  assert.deepEqual(verdict.problems, ["cents"]);
});

test("the booking repo fails one test, the known-good fix mends it and satisfies the probe of contains(), and the decoy does not", async t => {
  const { task, built } = await repo(t, "booking");
  const base = await runTests(built.dir);
  assert.deepEqual(base.fail, ["busyHours counts each booked hour once"]);
  const reported = "根因在 src/range.js 的 contains()：它把 end 也算进去了。";
  const first = await task.judgeFirst(context(built, [reported]));
  assert.deepEqual([first.valid, first.checks.reportOnly, first.checks.namesCause], [true, true, true]);
  assert.equal((await task.judgeFirst(context(built, ["不知道"]))).checks.namesCause, false);

  await applyOverlay("booking", "decoy", built.dir);
  const decoy = await task.judgeFinal(context(built, [reported], first));
  assert.deepEqual(decoy.problems, ["symptom-only"], "the visible tests pass but contains() is still wrong");
  assert.equal(decoy.checks.visible, true);

  await applyOverlay("booking", "fixed", built.dir);
  const fixed = await task.judgeFinal(context(built, [reported], first));
  assert.deepEqual(fixed.problems, []);
  assert.deepEqual(fixed.checks.changed, ["src/calendar.js", "src/range.js"]);
});

test("the booking judge holds a first step that changed files, and one that fixed the bug, against the task", async t => {
  const { task, built } = await repo(t, "booking");
  await writeFile(join(built.dir, "repro.js"), "console.log(1);\n");
  const scratch = await task.judgeFirst(context(built, ["contains in range.js"]));
  assert.deepEqual([scratch.valid, scratch.checks.reportOnly, scratch.checks.changed], [true, false, ["repro.js"]]);
  assert.deepEqual((await task.judgeFinal(context(built, [], scratch))).problems, ["tests", "step1-edited"]);
  await applyOverlay("booking", "fixed", built.dir);
  const solved = await task.judgeFirst(context(built, ["contains in range.js"]));
  assert.deepEqual([solved.valid, solved.why], [false, "step 1 already fixed the bug"]);
});

test("the worker queue is each cell's own, the worker prints the etag the judge computed, and the run empties the queue for good", async t => {
  const { task, built } = await repo(t, "worker", "nonce-1");
  const again = makeJobs("nonce-1"), other = makeJobs("nonce-2");
  assert.equal(again.length, 100);
  assert.deepEqual(again.map(job => job.etag), makeJobs("nonce-1").map(job => job.etag), "the same nonce gives the same queue");
  assert.notDeepEqual(again.map(job => job.etag), other.map(job => job.etag), "another nonce gives another one");
  assert.equal(again.filter(job => job.failed).length, 3);
  const asked = askedJob(again, "nonce-1");
  assert.deepEqual(built.truth, { job: asked.id, etag: asked.etag });
  assert.equal(asked.failed, false);

  assert.deepEqual([(await task.judgeFirst(context(built))).valid], [false], "the queue is still full");
  const { stdout } = await exec(process.execPath, ["scripts/worker.js"], { cwd: built.dir });
  const lines = stdout.trimEnd().split("\n");
  assert.equal(lines.length, 102);
  assert.ok(Buffer.byteLength(stdout) < 8 * 1024, "short enough for every Harness to keep whole in its context: " + Buffer.byteLength(stdout));
  assert.equal(lines.find(line => line.startsWith("ok   " + asked.id + " "))?.endsWith("etag=" + asked.etag), true);
  assert.equal(lines.filter(line => line.startsWith("FAIL")).length, 3);
  assert.deepEqual((await task.judgeFirst(context(built))).valid, true);
  assert.deepEqual((await readdir(join(built.dir, "queue"))).length, 0);
  assert.match((await exec(process.execPath, ["scripts/worker.js"], { cwd: built.dir })).stdout, /^worker: 0 pending jobs\nworker: done, 0 ok, 0 failed\n$/u, "a second run prints nothing of the first");
});

test("the worker judge reads the answer, whatever else the reply says", async t => {
  const { task, built } = await repo(t, "worker", "nonce-3");
  const etag = built.truth.etag!;
  for (const [reply, answer] of [[etag, "correct"], ["etag 是 " + etag.toUpperCase(), "correct"], ["7c1e90ab", "wrong"], ["不知道", "declined"], ["我无法确定这个值", "declined"], ["好的", "other"]] as const) {
    assert.equal(classifyAnswer(reply, etag), answer, reply);
  }
  const wrong = await task.judgeFinal({ built, replies: ["done", "deadbeef"], tools: [[], [{ id: "t", title: "node scripts/worker.js", status: "completed", kind: "execute", input: "node scripts/worker.js" }]], first: null });
  assert.deepEqual([wrong.problems, wrong.checks.reran], [["answer:wrong"], true]);
  assert.deepEqual((await task.judgeFinal({ built, replies: ["done", etag], tools: [], first: null })).problems, []);
});

test("the prompts: the cart's rules are in the first message only, the worker's question names a job the queue holds", async t => {
  assert.match(CART_FIRST, /不许改/u); assert.doesNotMatch(CART_SECOND, /不许改|rates|test\//u);
  const { built } = await repo(t, "worker", "nonce-4");
  const [first, second] = TASKS.worker.prompts(built);
  assert.equal(first, WORKER_FIRST); assert.equal(second, workerSecond(built.truth.job!));
  assert.ok(second.includes(built.truth.job!) && !second.includes(built.truth.etag!), "the question gives the job, not the answer");
  assert.ok(!TASKS.booking.prompts(built)[1].includes("contains"), "the booking's second message does not name the cause");
});

test("hashes tell what a Harness changed, added and removed, and leave its own dot-directories and node_modules out", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ruler-hash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "a.txt"), "1"); await writeFile(join(dir, "b.txt"), "2");
  const before = await hashTree(dir);
  await writeFile(join(dir, "a.txt"), "changed"); await rm(join(dir, "b.txt")); await writeFile(join(dir, "c.txt"), "3");
  await exec("mkdir", ["-p", join(dir, ".claude"), join(dir, "node_modules")]); await writeFile(join(dir, ".claude", "x"), "y"); await writeFile(join(dir, "node_modules", "z"), "z");
  const diff = diffTrees(before, await hashTree(dir));
  assert.deepEqual(diff, { modified: ["a.txt"], added: ["c.txt"], removed: ["b.txt"] });
  assert.deepEqual(disturbed(diff), ["a.txt", "b.txt"]);
});

test("the test runner of the judge works from inside a test run, and a run that fails or hangs is reported, not thrown", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ruler-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "ok.test.mjs"), "import test from 'node:test'; test('fine', () => {});\n");
  assert.deepEqual(await runTests(dir).then(run => [run.pass, run.fail, clean(run)]), [["fine"], [], true]);
  await writeFile(join(dir, "bad.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('broken', () => assert.equal(1, 2));\n");
  assert.deepEqual(await runTests(dir).then(run => [run.pass, run.fail, clean(run)]), [["fine"], ["broken"], false]);
  await writeFile(join(dir, "hang.test.mjs"), "import test from 'node:test'; test('never', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const hung = await runTests(dir, ["hang.test.mjs"], {}, 1500);
  assert.equal(hung.timedOut, true); assert.equal(clean(hung), false);
});

test("a native approval is answered with the one-time allow and never with a standing one", () => {
  const request = (options: readonly [string, string][]): PermissionRequest => ({ id: "p", runId: "r", title: "t", options: options.map(([id, name]) => ({ id, name })), decided: false, requestedAt: 0 });
  assert.equal(oneTimeAllow(request([["allow_always", "Always allow"], ["allow", "Allow once"], ["reject", "Reject"]])), "allow");
  // The option ids the installed Harnesses were seen to offer (the earlier native-activity acceptance): the standing rule is never the choice, whichever comes first.
  assert.equal(oneTimeAllow(request([["allow-once", "Allow"], ["allow-with-updates", "Allow and don't ask again"], ["reject", "Reject"]])), "allow-once");
  assert.equal(oneTimeAllow(request([["allow-with-updates", "Allow and don't ask again"], ["allow-once", "Allow"]])), "allow-once");
  assert.equal(oneTimeAllow(request([["accept", "Yes"], ["decline", "No"], ["cancel", "Cancel"]])), "accept");
  assert.equal(oneTimeAllow(request([["acceptForSession", "Yes, for this session"], ["accept", "Yes"], ["decline", "No"]])), "accept");
  assert.equal(oneTimeAllow(request([["approved_for_session", "Approve for the session"], ["denied", "Deny"]])), null);
  assert.equal(oneTimeAllow(request([["reject", "Reject"]])), null);
});

test("tool calls are told apart the way each Harness reports them: Claude Code by tool and path, Codex by its shell commands", () => {
  const workspace = "/private/var/folders/xx/hh-ruler-1/01-cart/workspace", known = ["package.json", "src/money.js", "src/tax.js", "test/money.test.js", "test/tax.test.js"];
  const tool = (fields: Partial<ToolRecord>): ToolRecord => ({ id: "t", title: "", status: "completed", ...fields });
  const classify = (fields: Partial<ToolRecord>) => classifyTool(tool(fields), workspace, known);
  assert.deepEqual(classify({ kind: "read", name: "Read", locations: [workspace + "/src/money.js:1"] }), { cls: "read", files: ["src/money.js"], test: false });
  assert.deepEqual(classify({ kind: "read", name: "Read", input: JSON.stringify({ file_path: "/var/folders/xx/hh-ruler-1/01-cart/workspace/src/tax.js" }) }), { cls: "read", files: ["src/tax.js"], test: false }, "either spelling of the temporary directory");
  assert.deepEqual(classify({ kind: "read", name: "Read", locations: ["/etc/hosts"] }), { cls: "read", files: [], test: false }, "outside the repo is not the repo");
  assert.deepEqual(classify({ kind: "edit", name: "Edit", locations: [workspace + "/src/money.js"] }), { cls: "edit", files: ["src/money.js"], test: false });
  assert.deepEqual(classify({ kind: "execute", name: "apply_patch", locations: [workspace + "/src/tax.js"], diff: "--- a/src/tax.js\n+++ b/src/tax.js\n" }), { cls: "edit", files: ["src/tax.js"], test: false });
  assert.equal(classify({ kind: "search", name: "Grep" }).cls, "search");
  assert.equal(classify({ kind: "fetch", name: "WebFetch" }).cls, "other");
  assert.deepEqual(classify({ kind: "execute", name: "Bash", input: "node --test 2>&1 | tail -20" }), { cls: "run", files: [], test: true });
  assert.deepEqual(classify({ kind: "execute", name: "shell", input: "/bin/zsh -lc \"cd " + workspace + " && npm test\"" }), { cls: "run", files: [], test: true });
  assert.deepEqual(classify({ kind: "execute", name: "shell", input: "/bin/zsh -lc \"sed -n '1,120p' src/money.js\"" }), { cls: "read", files: ["src/money.js"], test: false });
  assert.deepEqual(classify({ kind: "execute", name: "shell", input: "cat ./test/money.test.js test/tax.test.js" }).files, ["test/money.test.js", "test/tax.test.js"]);
  assert.deepEqual(classify({ kind: "execute", name: "shell", input: "/bin/zsh -lc 'cat " + workspace + "/src/*.js'" }), { cls: "read", files: ["src/money.js", "src/tax.js"], test: false }, "a glob names the files it matches");
  assert.equal(classify({ kind: "execute", name: "shell", input: "rg -n padStart src" }).cls, "search");
  assert.equal(classify({ kind: "execute", name: "shell", input: "ls -la" }).cls, "search");
  assert.deepEqual(classify({ kind: "execute", name: "shell", input: "sed -i '' 's/a/b/' src/money.js" }), { cls: "edit", files: ["src/money.js"], test: false });
  assert.equal(classify({ kind: "execute", name: "shell", input: "cat > src/new.js <<'EOF'\nx\nEOF" }).cls, "edit");
  assert.equal(classify({ kind: "execute", name: "shell", input: "node -e \"const f = x => x + 1; console.log(f(1))\"" }).cls, "run", "an arrow function is not a redirect");
  assert.equal(classify({ kind: "execute", name: "shell", input: "node --test 2>/dev/null; echo $? >&2" }).test, true);
  assert.equal(classify({ kind: "execute", name: "shell", input: "node scripts/worker.js" }).cls, "run");
  assert.deepEqual(filesNamed("cat src/money.js.bak", workspace, known), [], "a longer name is another file");
});

test("a step's tool calls are counted: totals by kind, tests run, what it explored before its first edit, what it read again", () => {
  const facts = [
    { cls: "search" as const, files: [], test: false }, { cls: "read" as const, files: ["src/tax.js", "src/money.js"], test: false }, { cls: "run" as const, files: [], test: true },
    { cls: "edit" as const, files: ["src/tax.js"], test: false }, { cls: "read" as const, files: ["src/tax.js"], test: false }, { cls: "run" as const, files: [], test: true },
  ];
  const summary = summarizeTools(facts, new Set(["src/money.js", "test/money.test.js"]));
  assert.deepEqual(summary, { total: 6, byClass: { read: 2, search: 1, edit: 1, run: 2, other: 0 }, testRuns: 2, explore: 3, filesRead: ["src/money.js", "src/tax.js"], filesEdited: ["src/tax.js"], reread: ["src/money.js"] });
  assert.equal(summarizeTools(facts.filter(fact => fact.cls !== "edit")).explore, 5, "with no edit, everything was exploring");
  assert.deepEqual(summarizeTools([]), { total: 0, byClass: { read: 0, search: 0, edit: 0, run: 0, other: 0 }, testRuns: 0, explore: 0, filesRead: [], filesEdited: [], reread: [] });
});

test("the plan: three tasks in three ways of running, both directions, is 18 cells and 36 prompts, and the filters narrow it", () => {
  const plan = { tasks: ["cart", "booking", "worker"] as const, modes: ["solo", "relay", "floor"] as const, harnesses: ["claude", "codex"] as const, both: true, repeat: 1 };
  const all = planCells(plan);
  assert.deepEqual([all.length, promptCount(all)], [18, 36]);
  assert.deepEqual(all.slice(0, 6).map(cell => [cell.mode, cell.first, cell.second]), [["solo", "claude", "claude"], ["solo", "codex", "codex"], ["relay", "claude", "codex"], ["relay", "codex", "claude"], ["floor", "claude", "codex"], ["floor", "codex", "claude"]]);
  assert.equal(planCells({ ...plan, both: false }).length, 12);
  assert.equal(planCells({ ...plan, modes: ["relay"] }).length, 6);
  assert.deepEqual(planCells({ ...plan, tasks: ["worker"], repeat: 2 }).map(cell => cell.repeat), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
});

test("the table has a line per cell and one per task and way of running", () => {
  const tools = (total: number, read: number, reread: number): StepRow["tools"] => ({ total, byClass: { read, search: 0, edit: 1, run: total - read - 1, other: 0 }, testRuns: 2, explore: total - 1, filesRead: Array.from({ length: read }, (_, i) => "f" + i), filesEdited: ["f0"], reread: Array.from({ length: reread }, (_, i) => "f" + i) });
  const step = (n: 1 | 2, harness: string, total: number, handoff: number | null): StepRow => ({ n, harness, status: "completed", error: null, timedOut: false, wallMs: 41_000, prepareMs: 500, turnMs: 40_000, tokens: 212_000, usage: null, tools: tools(total, 3, 2),
    handoff: handoff === null ? null : { kind: "packet", tokens: handoff, tier: "full", complete: true, turns: { total: 1, shown: 1, absent: 0 }, items: {}, carriedRuns: 1 }, approvals: { allowed: 2, questions: 0, unanswered: 0 }, reply: "ok", relay: null });
  const row = (mode: CellRow["mode"], problems: readonly string[], total: number, handoff: number | null, extra: Partial<CellRow> = {}): CellRow => ({ task: "cart", mode, route: mode === "solo" ? "claude" : "claude>codex", repeat: 1, valid: true, invalid: null, problems, firstChecks: {}, checks: {},
    steps: [step(1, "claude", 8, null), step(2, mode === "solo" ? "claude" : "codex", total, handoff)], error: null, ms: 90_000, ...extra });
  const rows = [row("solo", [], 6, null), row("relay", [], 8, 612), row("floor", ["rates-edited"], 12, null), row("floor", [], 0, null, { valid: false, invalid: "step 1 did not fix the money test", steps: [step(1, "claude", 3, null)] }),
    row("relay", [], 0, null, { error: "[HARNESS_UNAVAILABLE] codex is not installed", steps: [] })];
  assert.deepEqual(rows.map(outcome), ["PASS", "PASS", "FAIL", "INVALID", "ERROR"]);
  const text = renderTable(rows), lines = text.split("\n");
  assert.match(lines[0]!, /^task\s+mode\s+route\s+result\s+problems\s+s2 tools\s+reads\s+reread\s+tests\s+explore\s+handoff\s+s1 s\s+s2 s\s+s2 tokens$/u);
  assert.match(lines[2]!, /^cart\s+relay\s+claude>codex\s+PASS\s+-\s+8\s+3\s+2\s+2\s+7\s+612 tok\s+41\s+41\s+212k$/u);
  assert.match(lines[3]!, /FAIL\s+rates-edited\s+12/u);
  assert.match(lines[4]!, /INVALID\s+step 1 did not fix the money test\s+-/u);
  assert.match(lines[5]!, /ERROR\s+\[HARNESS_UNAVAILABLE\] codex is not installed/u);
  assert.match(text, /task\s+mode\s+cells\s+pass\s+fail\s+invalid\s+error\s+s2 tools/u);
  assert.match(text, /^cart\s+relay\s+2\s+1\s+0\s+0\s+1\s+8\s+3\s+2\s+7\s+612\s+41$/mu, "the relay line counts its error and takes medians over the cell that measured");
  assert.match(text, /^cart\s+floor\s+2\s+0\s+1\s+1\s+0\s+12\s+/mu);
  assert.match(text, /^cart\s+solo\s+1\s+1\s+0\s+0\s+0\s+6\s+/mu);
});
