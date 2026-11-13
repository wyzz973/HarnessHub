import assert from "node:assert/strict";
import test from "node:test";
import type { ContentRef } from "../../src/contracts/content.js";
import { costWords, statusText, turnFooter } from "../../src/contracts/protocol-lines.js";
import type { CommandItem, FileChangeItem, ItemStatus, PlanItem, SubagentItem, TurnUsage, WorkItem } from "../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../src/contracts/protocol-read.js";
import type { PublicMessage, PublicRun } from "../../src/contracts/session.js";
import { liveStatus, type QueueNotice } from "../../web/src/lib/protocol/live.js";
import { changeCount, editsOf, endedAt, latestPlan, ownWork, planRows, shownPlan, stateOf, statusParts, stepCount, usageFacts, userStopped } from "../../web/src/lib/protocol/runs.js";
import { arrange, askingFor, withReply } from "../../web/src/lib/protocol/work.js";

/*
 * What the page reads of a Run from its protocol Turn alone: the task list, the actions counted, the changes, the line under the message
 * box, the details' numbers, what a Turn that goes on says of itself, and the Turn's reply. Plain functions of the Turn; the Turns here
 * are made by hand, as the Hub's normalization would make them from any Harness's events.
 */

let counter = 0;
const at = (status: ItemStatus = "completed") => ({ id: "item-" + (counter += 1), seq: counter, status });
const command = (text: string, status?: ItemStatus, more: Partial<CommandItem> = {}): CommandItem => ({ ...at(status), type: "command", command: text, ...more });
const edit = (path: string, status?: ItemStatus, more: Partial<FileChangeItem> = {}): FileChangeItem => ({ ...at(status), type: "file_change", changes: [{ path, op: "modify" }], ...more });
const task = (title: string, status?: ItemStatus, id?: string): SubagentItem => ({ ...at(status), ...(id === undefined ? {} : { id }), type: "subagent", title });
const inside = <T extends WorkItem>(item: T, parentId: string): T => ({ ...item, parentId });
const plan = (steps: PlanItem["steps"]): PlanItem => ({ ...at(), type: "plan", steps });
const ref = (id: string): ContentRef => ({ id, name: id + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "a".repeat(64) }) as unknown as ContentRef;
const turn = (items: readonly ReadItem[], more: Partial<ReadTurn> = {}): ReadTurn => ({ version: "hh/1", runId: "run-1" as never, n: 3, status: "completed", executor: { harnessId: "codex", harness: "Codex" }, usage: { completeness: "unavailable" }, items, ...more });
const run = (protocol: ReadTurn | undefined, more: Partial<PublicRun> = {}): PublicRun => ({ id: "run-1", status: "completed", cancelRequested: false, awaitingSwitchId: null, ...(protocol === undefined ? {} : { protocol }), ...more }) as unknown as PublicRun;
const message = (id: string, text: string, status: PublicMessage["status"] = "running", role: PublicMessage["role"] = "assistant"): PublicMessage => ({ id, runId: "run-1", role, text, seq: 2, status }) as unknown as PublicMessage;

test("the task list is the latest one with steps, and the actions a Turn took are its own, not what its delegated tasks did inside", () => {
  const first = turn([plan([{ text: "读代码", status: "completed" }])], { runId: "run-1" as never }), empty = turn([plan([])]), last = turn([plan([{ text: "改它", status: "in_progress" }])], { runId: "run-3" as never });
  const found = latestPlan([run(first, { id: "run-1" as never }), run(empty, { id: "run-2" as never }), run(last, { id: "run-3" as never }), run(undefined, { id: "run-4" as never })]);
  assert.equal(found?.plan.steps[0]?.text, "改它");
  assert.equal(found?.run.id, "run-3");
  assert.equal(latestPlan([run(empty), run(undefined)]), undefined, "a list without steps is none");
  // The bar's list is the newer of the head's and the loaded Turns': a running Turn's own plan (TodoWrite, update_plan or hub_update_plan) before the store has it.
  const head = { runId: "run-1", harnessId: "claude", steps: [{ text: "旧的", status: "in_progress" as const }] };
  const loaded = [run(first, { id: "run-1" as never }), run(last, { id: "run-3" as never })];
  assert.equal(shownPlan(loaded, head)?.steps[0]?.text, "改它", "the running Turn's list is newer than the head's");
  assert.equal(shownPlan(loaded, { ...head, runId: "run-3" })?.steps[0]?.text, "改它", "the same Turn: the loaded one, which goes on");
  assert.equal(shownPlan([run(first, { id: "run-1" as never }), run(turn([]), { id: "run-2" as never })], { ...head, runId: "run-2" })?.steps[0]?.text, "旧的", "a head newer than the loaded plan stands");
  assert.equal(shownPlan([run(undefined)], head)?.harnessId, "claude", "a head Turn outside the loaded ones still shows");
  assert.equal(shownPlan([], undefined), undefined);
  const delegated = task("查一查", "completed", "task-1"), items = [command("a"), delegated, inside(command("b"), "task-1"), inside(command("c"), "task-1"), edit("x.ts")];
  assert.equal(stepCount(turn(items)), 3, "the command, the task and the edit; not the two commands inside the task");
  assert.deepEqual(ownWork(turn(items)).map(item => item.type), ["command", "subagent", "file_change"]);
});

test("changes are counted as places, from the edits that carry a stored detail, so nothing is read to count them", () => {
  const withDetail = edit("a.ts", "completed", { detail: ref("content-a") }), without = edit("b.ts");
  assert.deepEqual(editsOf(turn([withDetail, without, command("x")])).map(item => item.id), [withDetail.id]);
  assert.equal(changeCount([run(turn([withDetail, edit("c.ts", "completed", { detail: ref("content-c") })])), run(turn([without])), run(undefined)]), 2);
});

test("the line under the message box says only how full the context is, and the footer is written from the Turn's numbers", () => {
  const usage: TurnUsage = { completeness: "complete", input: 41_000, cachedInput: 40_000, output: 1_100, context: { used: 90, size: 1000 }, cost: { amount: 0.8727869, currency: "USD", scope: "conversation" } };
  const done = turn([command("a"), command("b")], { usage, startedAt: 1000, durationMs: 31_000 });
  // Only how full the context is stands under the message box; the time, tokens and cost are in the footer and the details.
  assert.deepEqual(statusParts(done).map(part => part.text), ["上下文 9%"]);
  assert.equal(statusParts(done)[0]?.share, 9, "the share is there for the ring");
  assert.equal(turnFooter(done), "Codex · 用时 31 秒 · 输入 41.0k · 输出 1.1k · 对话累计 US$0.87", "the footer under the Turn is written from the same numbers");
  const going = turn([command("a", "running")], { status: "running", startedAt: 1000 });
  assert.deepEqual(statusParts(going, 43_900).map(part => part.text), [], "a Turn without a context reported says nothing there");
  // Without a size there is no share.
  const partial = turn([], { usage: { completeness: "partial", input: 7, context: { used: 2048 }, cost: { amount: 0, currency: "USD", scope: "session" } }, durationMs: 4_000 });
  assert.deepEqual(statusParts(partial).map(part => part.text), ["上下文 2.0k"]);
});

test("a cost of nothing is not written, and a cost is written under its scope", () => {
  assert.equal(costWords({ amount: 0, currency: "USD", scope: "session" }), null, "a free model reports an amount of 0");
  assert.equal(costWords({ amount: 0, currency: "USD", scope: "conversation" }), null);
  assert.equal(costWords({ amount: 0.87, currency: "USD", scope: "session" }), "会话累计 US$0.87");
  assert.equal(costWords({ amount: 3.06, currency: "EUR", scope: "conversation" }), "对话累计 EUR 3.06");
  assert.equal(costWords({ amount: 0.2, currency: "USD", scope: "turn" }), null, "a Turn's own cost is not in the footer");
  assert.equal(costWords(undefined), null);
  assert.deepEqual(usageFacts(turn([], { usage: { completeness: "unavailable", cost: { amount: 0, currency: "USD", scope: "session" } } })), []);
  assert.deepEqual(usageFacts(turn([], { usage: { completeness: "unavailable", cost: { amount: 0.5, currency: "USD", scope: "session" } } })), [["费用", "US$0.50 · 原生会话累计"]]);
});

test("the details list the Turn's numbers: tokens only as complete as they are, the context with its share, the cost under its scope", () => {
  const complete = usageFacts(turn([], { usage: { completeness: "complete", input: 4, cachedInput: 2, output: 9, context: { used: 100, size: 1000 }, cost: { amount: 1.5, currency: "CNY", scope: "conversation" } } }));
  assert.deepEqual(complete, [["本轮用量", "输入 4 · 其中缓存 2 · 输出 9"], ["上下文", "100 / 1,000 tokens（10%）"], ["费用", "¥1.50 · 整个对话累计"]]);
  assert.equal(usageFacts(turn([], { usage: { completeness: "partial", input: 4 } }))[0]?.[0], "本轮用量（可能不全）", "a count that may cover less than the Turn is not given as its total");
  assert.deepEqual(usageFacts(turn([], { usage: { completeness: "unavailable" } })), []);
});

test("how a Turn stands is the table's word and, when it ended otherwise than by finishing, the table's sentence for why", () => {
  assert.equal(statusText({ status: "completed", stopReason: "end_turn" }), "已完成");
  assert.equal(statusText({ status: "cancelled", stopReason: "user_stopped" }), "已停止 · 你停止了这一轮");
  assert.equal(statusText({ status: "cancelled", stopReason: "budget" }), "已停止 · 超过了这一轮的时间上限");
  assert.equal(statusText({ status: "failed", stopReason: "error" }), "失败", "the error item says what went wrong");
  assert.equal(statusText({ status: "failed", stopReason: "refusal" }), "失败 · 模型拒绝了这个请求");
  assert.equal(statusText({ status: "unknown" }), "结果未知 · 可能已经执行，不会自动重发");
  assert.equal(userStopped(run(turn([], { status: "cancelled", stopReason: "user_stopped" }))), true);
  assert.equal(userStopped(run(turn([], { status: "cancelled", stopReason: "budget" }))), false, "a stop the Hub made is not the user's");
  assert.equal(userStopped(run(undefined)), false);
  assert.equal(stateOf(run(undefined, { status: "settling" })), "running", "a Run being closed is the Turn still running");
  assert.equal(stateOf(run(turn([], { status: "waiting" }), { status: "running" })), "waiting", "the Turn's own state wins");
  assert.equal(endedAt(turn([], { startedAt: 1000, durationMs: 500 })), 1500);
  assert.equal(endedAt(turn([], { startedAt: 1000 })), undefined);
});

test("while an approval waits, the action it asks for is the latest of the Turn's own that has not ended, and says it waits for you", () => {
  const read = command("cat a"), asked = command("rm -rf build", "pending");
  const waiting = arrange(turn([read, asked], { status: "waiting" }), { asking: true });
  assert.equal(waiting.blocks[0]?.kind === "work" && waiting.blocks[0].work.map(item => item.status).join(), "completed,waiting");
  assert.equal(askingFor([read, asked])?.id, asked.id);
  // Not marked unless an approval waits, and an action inside a delegated task is not guessed at: the task is what asks.
  const plain = arrange(turn([read, asked], { status: "running" }), { asking: false }).blocks[0];
  assert.equal(plain?.kind === "work" && plain.work[1]?.status, "pending");
  const delegated = task("查一查", "running", "task-9"), deep = inside(command("npm test", "running"), "task-9");
  assert.equal(askingFor([delegated, deep])?.id, delegated.id);
  assert.equal(askingFor([read]), undefined, "nothing is open");
  // A Turn that is over asks for nothing: its open actions are unknown.
  const over = arrange(turn([read, asked], { status: "failed" }), { asking: true });
  assert.equal(over.blocks[0]?.kind === "work" && over.blocks[0].work[1]?.status, "unknown");
});

test("a chain of delegated tasks that leads back to itself is shown flat, so that every item is shown once", () => {
  const a = { ...task("A", "completed", "task-a"), parentId: "task-b" }, b = { ...task("B", "completed", "task-b"), parentId: "task-a" }, c = inside(command("x"), "task-a");
  const flat = arrange(turn([a, b, c]));
  assert.equal(flat.children.size, 0);
  assert.equal(flat.blocks.reduce((sum, block) => sum + (block.kind === "work" ? block.work.length : 1), 0), 3);
  // An ordinary chain: the command under its task, the task under the one that handed it out.
  const outer = task("外层", "completed", "task-o"), middle = { ...task("内层", "completed", "task-m"), parentId: "task-o" }, leaf = inside(command("ls"), "task-m");
  const nested = arrange(turn([outer, middle, leaf]));
  assert.deepEqual([...nested.children].map(([key, rows]) => [key, rows.map(row => row.id)]), [["task-o", ["task-m"]], ["task-m", [leaf.id]]]);
});

test("the reply is a message of the conversation: its words are among the Turn's items as soon as the message has any, where the reply stands", () => {
  const items: ReadItem[] = [command("a"), { ...at(), type: "error", class: "unknown", message: "boom" }];
  const given = turn(items, { status: "running" });
  const shown = withReply(given, message("message-a", "第一段已经到达。"));
  assert.deepEqual(shown.items.map(item => item.type), ["command", "assistant_message", "error"], "before an error, after the actions");
  const reply = shown.items[1];
  assert.deepEqual(reply?.type === "assistant_message" && [reply.messageId, reply.status, reply.phase], ["message-a", "running", "final"]);
  assert.equal(withReply(given, message("message-a", "")), given, "a message without words is no reply yet");
  assert.equal(withReply(given, undefined), given);
  assert.equal(withReply(given, message("message-u", "你好", "completed", "user")), given, "your own message is not the reply");
  // A Turn that lists its reply is returned as it is, and a reply over is completed.
  const listed = turn([command("a"), { ...at(), type: "assistant_message", messageId: "message-a" as never, phase: "final" }]);
  assert.equal(withReply(listed, message("message-a", "全文")), listed);
  assert.equal(withReply(turn([]), message("message-a", "全文", "completed")).items[0]?.status, "completed");
});

test("what a Turn says while it goes on and shows nothing else: why it waits, what it starts, what it does, what it asks of you", () => {
  const time = { acceptedAt: 0, dispatchedAt: 10, firstOutputAt: undefined } as unknown as PublicRun["timing"];
  const live = (more: Partial<Parameters<typeof liveStatus>[0]> & { items?: readonly ReadItem[]; status?: ReadTurn["status"] } = {}) =>
    liveStatus({ turn: { status: more.status ?? "running", items: more.items ?? [], executor: { harnessId: "codex", harness: "Codex" } }, run: { status: "running", cancelRequested: false, awaitingSwitchId: null, timing: time } as PublicRun, now: 5_000, replying: false, ...more });
  // An approval: the action it asks for in the 想… form, grey and still; without one, 等你批准. A question keeps naming the action in progress.
  assert.deepEqual(live({ waiting: "approval", items: [command("ls"), command("rm -rf build", "pending")] }), { text: "想运行 rm -rf build", tone: "wait", timer: true, wrap: false, thinking: false, quiet: true });
  assert.equal(live({ waiting: "approval", items: [command("ls")] }).text, "等你批准");
  assert.equal(live({ waiting: "question", items: [command("npm test", "running")] }).text, "正在运行 npm test");
  assert.deepEqual(live({ waiting: "question" }), { text: "等你回答", tone: "wait", timer: true, wrap: false, thinking: false });
  // A Turn not started reads 排队中 wherever it is named, with its reason after it.
  assert.equal(live({ status: "queued" }).text, "排队中");
  const slot: QueueNotice = { kind: "slot", running: 4, cancelling: false };
  assert.equal(live({ status: "queued", queue: slot }).text, "排队中：4 个对话正在执行，其中一个结束后自动开始");
  assert.equal(live({ status: "queued", queue: slot }).wrap, true, "a longer explanation wraps instead of sliding");
  assert.equal(live({ status: "queued" }).tone, "queue");
  assert.equal(live({ status: "preparing", startupHint: { seconds: 6.4, usual: true } }).text, "正在启动 Codex（通常约 6 秒）");
  assert.equal(live({ status: "preparing", startupHint: { seconds: 1, usual: false } }).text, "正在启动 Codex");
  // Running: the action in progress, the reply, or, with nothing shown yet, that it thinks, in words that change as the silence goes on.
  assert.equal(live({ items: [command("git diff --stat", "running")] }).text, "正在运行 git diff --stat");
  // A reply being written says so itself, and the line is not drawn; a reply already written with nothing after it is thought again.
  const writing = { ...at("running"), type: "assistant_message", messageId: "message-w" as never, phase: "final" } as ReadItem;
  assert.deepEqual(live({ items: [writing], replying: true }), { text: "正在回复", tone: "run", timer: true, wrap: false, thinking: false, quiet: true });
  assert.equal(live({ items: [{ ...writing, status: "completed" } as ReadItem], replying: true }).text, "正在思考");
  assert.deepEqual(live({}), { text: "正在思考", tone: "run", timer: true, wrap: false, thinking: true });
  assert.equal(live({ now: 10 + 31_000 }).text, "再想想");
  assert.equal(live({ now: 10 + 61_000 }).text, "快想好了");
  assert.equal(liveStatus({ turn: { status: "running", items: [], executor: { harnessId: "codex", harness: "Codex" } }, run: { status: "running", cancelRequested: false, awaitingSwitchId: null, timing: { acceptedAt: 0 } } as PublicRun, now: 5, replying: false }).text, "已连接 Codex，正在发送");
  assert.equal(live({ run: { status: "settling", cancelRequested: false, awaitingSwitchId: null } as PublicRun }).text, "正在结束执行");
  assert.equal(live({ run: { status: "running", cancelRequested: true, awaitingSwitchId: null } as PublicRun, items: [command("x", "running")] }).text, "正在停止并清理资源");
  assert.equal(live({ status: "queued", run: { status: "queued", cancelRequested: false, awaitingSwitchId: "switch-1" } as PublicRun }).text, "排队中：等待选择切换生效");
});

test("a task list of more than twelve steps folds its middle, and keeps the first two, the last two and the steps around the current one", () => {
  const steps = (n: number, current: number) => Array.from({ length: n }, (_, index) => ({ text: "步骤 " + (index + 1), status: index < current ? "completed" as const : index === current ? "in_progress" as const : "pending" as const }));
  assert.deepEqual(planRows(steps(12, 5)).map(row => row.kind), Array(12).fill("step"), "twelve are all shown");
  const rows = planRows(steps(20, 10));
  assert.deepEqual(rows.map(row => row.kind === "step" ? row.index : "+" + row.count), [0, 1, "+6", 8, 9, 10, 11, 12, "+5", 18, 19]);
  assert.deepEqual(planRows(steps(20, 0)).map(row => row.kind === "step" ? row.index : "+" + row.count), [0, 1, 2, "+15", 18, 19], "at the start");
  const done = steps(15, 15);
  assert.deepEqual(planRows(done).map(row => row.kind === "step" ? row.index : "+" + row.count), [0, 1, "+11", 13, 14], "all done: the ends only");
  assert.equal(planRows(done).reduce((sum, row) => sum + (row.kind === "step" ? 1 : row.count), 0), 15, "every step is counted once");
});
