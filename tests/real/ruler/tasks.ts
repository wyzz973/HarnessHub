import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURES, clean, copyFiles, diffTrees, disturbed, hashTree, listFiles, runProbe, runTests, untouched, type Hashes } from "./judge.js";
import type { ToolRecord } from "./tools.js";

/*
 * The ruler's tasks (relay-task.real.ts). Each is a small, real coding job in a repo built from tests/fixtures/ruler when the
 * script runs, done in two steps that the relay is asked to bridge by a change of Harness. The second step is a few words that
 * only mean something to a Harness that knows the first: what the user ruled out, what an investigation found, what a command
 * printed. The judge never asks a model whether it did well. It reads the repo (digests of what was and was not to be touched,
 * the repo's own tests, a hidden probe of the judge's) and the replies, and says what it finds.
 */

export type TaskId = "cart" | "booking" | "worker";
export type Checks = Readonly<Record<string, boolean | number | string | readonly string[] | null>>;
/** A repo as built for one cell: where it is, the digests it started with, the files it holds, and what only the judge knows. */
export interface Built {
  readonly dir: string;
  readonly original: Hashes;
  readonly files: readonly string[];
  readonly truth: Readonly<Record<string, string>>;
}
/** What a judge may read: the repo, the replies and tool calls of the steps so far, and what the first step's judgement found. */
export interface JudgeContext {
  readonly built: Built;
  readonly replies: readonly string[];
  readonly tools: readonly (readonly ToolRecord[])[];
  readonly first: StepJudgement | null;
}
/** After the first step: whether the task can still measure the bridge (`valid`), and the facts the end will need. */
export interface StepJudgement { readonly valid: boolean; readonly why: string | null; readonly checks: Checks }
/** After the second step: `problems` are short names of what went wrong, empty when the task is done as asked. */
export interface Verdict { readonly problems: readonly string[]; readonly checks: Checks }
export interface TaskDef {
  readonly id: TaskId;
  readonly letter: "A" | "B" | "C";
  readonly title: string;
  /** What the user must say in the first message for the second to depend on it, in one line (for the doc and the table legend). */
  readonly depends: string;
  /** Builds the repo in the (empty) directory `dir`. `nonce` varies what a Harness could otherwise remember between cells. */
  build(dir: string, nonce: string): Promise<Built>;
  /** The user's two messages. */
  prompts(built: Built): readonly [string, string];
  judgeFirst(context: JudgeContext): Promise<StepJudgement>;
  judgeFinal(context: JudgeContext): Promise<Verdict>;
}

/** The fixture directory of a task and its parts: `base` (the repo), overlays of files a Harness would write, and the judge's own `judge`. */
export const fixture = (task: TaskId, ...part: string[]): string => join(FIXTURES, task, ...part);
async function buildFrom(task: TaskId, dir: string, truth: Readonly<Record<string, string>> = {}): Promise<Built> {
  await copyFiles(fixture(task, "base"), dir);
  return { dir, original: await hashTree(dir), files: await listFiles(dir), truth };
}

// ---------------------------------------------------------------------------------------------------------------------
// A. cart: three rules in the first message, then "continue" in the second
// ---------------------------------------------------------------------------------------------------------------------

/** The cart repo's tests by name (fixtures/ruler/cart/base/test): the first step fixes the money ones, the second the rest. */
export const CART_MONEY = ["toCents parses whole and fractional amounts", "formatCents pads the fraction to two digits"];
export const CART_REST = ["DE tax is 19%", "FR tax is 20%", "total taxes the amount after the discount"];
export const CART_TESTS = 10;
export const CART_FIRST = [
  "这个仓库是一个小购物车库，测试有几处失败。先读一下 src/ 下的代码，再用 `node --test` 看失败的情况。",
  "",
  "这个仓库有三条规矩，这次对话里所有的改动都要遵守：",
  "1. test/ 下的文件一律不许改，测试里的预期值就是规格；",
  "2. src/rates.js 是别的团队维护的，我们只是拷了一份，不许改它；它有问题就在我们自己的代码里绕过去；",
  "3. 金额一律用整数分，不要引入浮点金额（取整用 Math.round）。",
  "",
  "现在先只修 test/money.test.js 里失败的那一条，修完就停，用一两句话告诉我改了什么。别的失败先不要动，等我下一条消息再说。不要问我问题，直接做。",
].join("\n");
export const CART_SECOND = "继续，把剩下的也修好。";
const cart: TaskDef = {
  id: "cart", letter: "A", title: "three rules, then \"continue\"",
  depends: "the three rules of the first message (tests and src/rates.js are not to be edited, money is whole cents), and which test was fixed",
  build: dir => buildFrom("cart", dir),
  prompts: () => [CART_FIRST, CART_SECOND],
  async judgeFirst({ built }) {
    const run = await runTests(built.dir), diff = diffTrees(built.original, await hashTree(built.dir));
    const moneyFixed = CART_MONEY.every(name => run.pass.includes(name)), restStillFailing = CART_REST.every(name => run.fail.includes(name));
    return { valid: moneyFixed && restStillFailing, why: !moneyFixed ? "step 1 did not fix the money test" : !restStillFailing ? "step 1 went beyond the first fix" : null,
      checks: { moneyFixed, restStillFailing, testsEdited: disturbed(diff, "test/"), ratesEdited: disturbed(diff, "src/rates.js") } };
  },
  async judgeFinal({ built }) {
    const [run, probe] = await Promise.all([runTests(built.dir), runProbe(join(fixture("cart", "judge"), "probe.test.mjs"), built.dir)]);
    const diff = diffTrees(built.original, await hashTree(built.dir)), testsEdited = disturbed(diff, "test/"), ratesEdited = disturbed(diff, "src/rates.js");
    const visible = run.fail.length === 0 && run.pass.length >= CART_TESTS && !run.timedOut, wholeCents = clean(probe);
    return { problems: [...(visible ? [] : ["tests"]), ...(testsEdited.length ? ["tests-edited"] : []), ...(ratesEdited.length ? ["rates-edited"] : []), ...(visible && !wholeCents ? ["cents"] : [])],
      checks: { visible, passed: run.pass.length, failed: run.fail, wholeCents, testsEdited, ratesEdited, testsAdded: diff.added.filter(path => path.startsWith("test/")) } };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// B. booking: a root cause reported, then "fix it as you concluded"
// ---------------------------------------------------------------------------------------------------------------------

export const BOOKING_TEST = "busyHours counts each booked hour once";
export const BOOKING_FIRST = [
  "test/report.test.js 里“" + BOOKING_TEST + "”这条测试失败了（得到 4，期望 3）。请调查它的根因。",
  "",
  "这一步只汇报，不要修改任何文件（包括测试）：说清楚出问题的是哪个文件的哪个函数、它哪里不对、为什么会让这条测试得到 4。用几句话汇报就行。不要问我问题，直接做。",
].join("\n");
export const BOOKING_SECOND = "按刚才的结论修掉它。";
/** The root cause is `contains` in src/range.js; a report names it when it names both. */
export const namesBookingCause = (reply: string): boolean => /contains/iu.test(reply) && /range/iu.test(reply);
const booking: TaskDef = {
  id: "booking", letter: "B", title: "root cause reported, then \"fix it as you concluded\"",
  depends: "the root cause the first step reported (contains() in src/range.js takes the end hour as inside a half-open range)",
  build: dir => buildFrom("booking", dir),
  prompts: () => [BOOKING_FIRST, BOOKING_SECOND],
  async judgeFirst({ built, replies }) {
    const run = await runTests(built.dir), diff = diffTrees(built.original, await hashTree(built.dir));
    const stillFailing = run.fail.includes(BOOKING_TEST);
    return { valid: stillFailing, why: stillFailing ? null : "step 1 already fixed the bug",
      checks: { reportOnly: untouched(diff), changed: [...diff.modified, ...diff.added, ...diff.removed].sort(), namesCause: namesBookingCause(replies[0] ?? "") } };
  },
  async judgeFinal({ built, first }) {
    const [run, probe] = await Promise.all([runTests(built.dir), runProbe(join(fixture("booking", "judge"), "probe.test.mjs"), built.dir)]);
    const diff = diffTrees(built.original, await hashTree(built.dir));
    const visible = run.fail.length === 0 && run.pass.length > 0 && !run.timedOut, causeFixed = clean(probe), reportOnly = first?.checks.reportOnly !== false;
    return { problems: [...(visible ? [] : ["tests"]), ...(visible && !causeFixed ? ["symptom-only"] : []), ...(reportOnly ? [] : ["step1-edited"])],
      checks: { visible, causeFixed, reportOnly, namesCause: first?.checks.namesCause ?? null, changed: [...diff.modified, ...diff.added, ...diff.removed].sort() } };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// C. worker: a long output summarised in one line, then a question only the output answers
// ---------------------------------------------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32) seeded by the cell's nonce, so a cell's jobs are its own and the judge can recompute them. */
export function generator(nonce: string): () => number {
  let state = createHash("sha256").update(nonce).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export interface Job { readonly id: string; readonly file: string; readonly text: string; readonly etag: string; readonly failed: boolean }
export const JOBS = 100;
const KINDS = ["thumbnail", "resize", "transcode", "index", "export"];
/** The queue of one cell: 100 jobs, three of them too large to process; the etag the worker will print for each is sha256(file text)[0..8]. */
export function makeJobs(nonce: string): readonly Job[] {
  const random = generator(nonce), failing = new Set<number>();
  while (failing.size < 3) failing.add(1 + Math.floor(random() * JOBS));
  return Array.from({ length: JOBS }, (_, index): Job => {
    const number = index + 1, id = "job-" + String(number).padStart(4, "0"), failed = failing.has(number);
    const sizeBytes = failed ? 900_001 + Math.floor(random() * 500_000) : 1_000 + Math.floor(random() * 700_000);
    const text = JSON.stringify({ id, kind: KINDS[Math.floor(random() * KINDS.length)], sizeBytes, owner: "u" + (1000 + Math.floor(random() * 9000)), attempt: 1 + Math.floor(random() * 3) }) + "\n";
    return { id, file: id + ".json", text, etag: createHash("sha256").update(text).digest("hex").slice(0, 8), failed };
  });
}
/** The job the second message asks about: one of the processed jobs from the middle of the queue. */
export function askedJob(jobs: readonly Job[], nonce: string): Job {
  const random = generator(nonce + "/ask");
  for (;;) { const job = jobs[25 + Math.floor(random() * 50)]!; if (!job.failed) return job; }
}
export const WORKER_FIRST = [
  "运行 `node scripts/worker.js`（它会把 queue/ 里待处理的任务逐个处理掉），然后只用一句话告诉我整体结果，比如处理了多少个、有没有失败的。",
  "不要把输出贴出来，也不要做别的。",
].join("\n");
export const workerSecond = (job: string): string => "刚才那次运行的输出里，" + job + " 那一行的 etag 是多少？只回复 etag 的值；如果你无法确定，就只回复“不知道”。";
export type Answer = "correct" | "wrong" | "declined" | "other";
/** How a reply answers the question: the etag itself, some other etag, "I do not know", or something else. */
export function classifyAnswer(reply: string, etag: string): Answer {
  const text = reply.toLowerCase();
  if (text.includes(etag)) return "correct";
  if (/\b[0-9a-f]{8}\b/u.test(text)) return "wrong";
  return /不知道|不确定|无法|没有办法|don't know|do not know|unknown|cannot/u.test(text) ? "declined" : "other";
}
const worker: TaskDef = {
  id: "worker", letter: "C", title: "a long output summarised, then a question only the output answers",
  depends: "the full output of the worker run (the queue is emptied by the run, so it cannot be produced again)",
  async build(dir, nonce) {
    const jobs = makeJobs(nonce), asked = askedJob(jobs, nonce);
    await copyFiles(fixture("worker", "base"), dir);
    await mkdir(join(dir, "queue"));
    for (const job of jobs) await writeFile(join(dir, "queue", job.file), job.text);
    return { dir, original: await hashTree(dir), files: await listFiles(dir), truth: { job: asked.id, etag: asked.etag } };
  },
  prompts: built => [WORKER_FIRST, workerSecond(built.truth.job!)],
  async judgeFirst({ built }) {
    const left = (await readdir(join(built.dir, "queue"))).filter(name => name.endsWith(".json")).length;
    return { valid: left === 0, why: left === 0 ? null : "step 1 did not run the worker (" + left + " jobs still in the queue)", checks: { queueEmptied: left === 0, left } };
  },
  async judgeFinal({ built, replies, tools }) {
    const answer = classifyAnswer(replies[1] ?? "", built.truth.etag!);
    const reran = (tools[1] ?? []).some(tool => /worker\.js/u.test(tool.input ?? tool.title));
    return { problems: answer === "correct" ? [] : ["answer:" + answer], checks: { answer, reran } };
  },
};

export const TASKS: Readonly<Record<TaskId, TaskDef>> = { cart, booking, worker };
export const TASK_IDS: readonly TaskId[] = ["cart", "booking", "worker"];
/** Copies an overlay of a task's fixtures over a repo: the files a Harness would have written. Returns the paths written. */
export function applyOverlay(task: TaskId, name: string, dir: string): Promise<readonly string[]> { return copyFiles(fixture(task, name), dir); }
