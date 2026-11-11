import assert from "node:assert/strict";
import test from "node:test";
import type { CommandItem, Executor, FileChange, FileChangeItem, FileReadItem, ItemStatus, McpToolItem, SearchItem, SubagentItem, SwitchItem, ToolItem, TurnUsage, WebItem, WorkItem } from "../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../src/contracts/protocol-read.js";
import { ITEM_STATUS_WORDS, RUN_STATUS_WORDS, STOP_REASON_WORDS, TURN_STATUS_WORDS } from "../../src/contracts/protocol-words.js";
import { decodeProtocolTurn } from "../../web/src/lib/protocol/decode.js";
import { endLine, moneyText, quietLine, switchLine, turnFooter } from "../../web/src/lib/protocol/lines.js";
import { arrange, lay, opensByDefault, reasoningLabel, showsProgress, summarizeGroup, thoughtTime, workLabel, type Block, type WorkBlock } from "../../web/src/lib/protocol/work.js";

/*
 * What the page says of a Turn's items: each action in its three voices, a run of actions in one line, the footer, the line where
 * another Harness took over, and the order the items are laid out in. The items here are made by hand, as the Hub's normalization
 * would make them from a Harness's events; none of these functions knows which Harness it was.
 */

let counter = 0;
const at = (status: ItemStatus = "completed") => ({ id: "item-" + (counter += 1), seq: counter, status });
const command = (text: string, status?: ItemStatus, more: Partial<CommandItem> = {}): CommandItem => ({ ...at(status), type: "command", command: text, ...more });
const read = (path: string | null, status?: ItemStatus): FileReadItem => ({ ...at(status), type: "file_read", path });
const change = (changes: readonly FileChange[], status?: ItemStatus): FileChangeItem => ({ ...at(status), type: "file_change", changes });
const edit = (path: string, added?: number, removed?: number, status?: ItemStatus): FileChangeItem => change([{ path, op: "modify", ...(added === undefined ? {} : { added }), ...(removed === undefined ? {} : { removed }) }], status);
const search = (query: string | null, scope: SearchItem["scope"] = "content", status?: ItemStatus): SearchItem => ({ ...at(status), type: "search", scope, query });
const web = (more: Pick<WebItem, "action"> & Partial<WebItem>, status?: ItemStatus): WebItem => ({ ...at(status), type: "web", ...more });
const mcp = (server: string, tool: string, status?: ItemStatus, hub?: true): McpToolItem => ({ ...at(status), type: "mcp_tool", server, tool, ...(hub ? { hub } : {}) });
const tool = (name: string, status?: ItemStatus): ToolItem => ({ ...at(status), type: "tool", name });
const task = (title: string, status?: ItemStatus): SubagentItem => ({ ...at(status), type: "subagent", title });
const workOf = (block: Block | undefined): readonly WorkItem[] => block?.kind === "work" ? block.work : [];
const harness = (harnessId: string, name: string, model?: string): Executor => ({ harnessId, harness: name, ...(model === undefined ? {} : { model: { id: model, label: model } }) });

test("an action reads in the voice of its state: in progress, done, failed, and a neutral one with the state's own word for the rest", () => {
  const cases: readonly (readonly [ItemStatus, string])[] = [
    ["running", "正在运行 npm test"], ["completed", "运行了 npm test"], ["failed", "运行失败 npm test"],
    ["pending", "运行 npm test · 等待开始"], ["waiting", "运行 npm test · 等你处理"], ["declined", "运行 npm test · 已拒绝"], ["cancelled", "运行 npm test · 已停止"], ["unknown", "运行 npm test · 结果未知"],
  ];
  for (const [status, text] of cases) assert.equal(workLabel(command("npm test", status)).text, text, status);
  // A state the verb says is not said twice; one it does not say is said in the table's word.
  assert.equal(workLabel(command("npm test", "completed")).status, null);
  assert.equal(workLabel(command("npm test", "declined")).status, ITEM_STATUS_WORDS.declined);
});

test("each kind of action has its wording, with an object and without one", () => {
  const rows: readonly (readonly [WorkItem, string])[] = [
    [read("/work/shop/src/cart.js", "running"), "正在读取 cart.js"], [read("/work/shop/src/cart.js"), "读取了 cart.js"], [read("/work/shop/src/cart.js", "failed"), "读取失败 cart.js"],
    [read(null), "读取了一个文件"], [read(null, "running"), "正在读取一个文件"], [read(null, "failed"), "读取失败"],
    [command(""), "运行了一条命令"], [command("   ", "running"), "正在运行一条命令"], [command("", "failed"), "运行失败"],
    [command("npm test\nnpm run lint"), "运行了 npm test …"],
    [search("taxFor"), "搜索了“taxFor”"], [search("taxFor", "content", "running"), "正在搜索“taxFor”"], [search("taxFor", "content", "failed"), "搜索失败“taxFor”"],
    [search(null, "files"), "搜索了文件"], [search(null, "content"), "搜索了代码"], [search(null, "unknown"), "搜索了一次"],
    [web({ action: "search", query: "node test runner" }), "搜索了网页“node test runner”"], [web({ action: "search" }, "running"), "正在搜索网页"], [web({ action: "search" }, "failed"), "联网失败"],
    [web({ action: "fetch", url: "https://www.example.com/a/b", title: "Example page" }), "读取了 Example page"], [web({ action: "fetch", url: "https://www.example.com/a/b" }), "读取了 example.com"],
    [web({ action: "fetch" }), "读取了一个网页"], [web({ action: "fetch", url: "https://example.com" }, "failed"), "联网失败 example.com"],
    [mcp("github", "create_issue"), "使用了 github：create_issue"], [mcp("github", "create_issue", "running"), "正在使用 github：create_issue"], [mcp("github", "create_issue", "failed"), "工具出错 github：create_issue"],
    [mcp("harnesshub", "hub_read_turn", "completed", true), "查阅了对话记录"], [mcp("harnesshub", "hub_search", "running", true), "正在查阅对话记录"], [mcp("harnesshub", "hub_turns", "failed", true), "查阅失败"],
    [tool("ToolSearch"), "使用了 ToolSearch"], [tool("ToolSearch", "failed"), "工具出错 ToolSearch"], [tool(" "), "使用了一个工具"],
    [task("找出所有用到税率的地方"), "运行了子任务“找出所有用到税率的地方”"], [task("x", "running"), "正在运行子任务“x”"], [task("x", "failed"), "子任务失败“x”"], [task(""), "运行了子任务"],
  ];
  for (const [item, text] of rows) assert.equal(workLabel(item).text, text, item.type + " " + item.status);
});

test("an edit says what was done to the file and how many lines, and a new, deleted or renamed file has its own verb", () => {
  assert.equal(workLabel(edit("src/cart.js", 2, 2)).text, "修改了 cart.js +2 −2");
  assert.deepEqual([workLabel(edit("src/cart.js", 2, 2)).added, workLabel(edit("src/cart.js", 2, 2)).removed], [2, 2]);
  assert.equal(workLabel(edit("src/cart.js", 5, 0)).text, "修改了 cart.js +5", "a count of zero is not drawn");
  assert.equal(workLabel(edit("src/cart.js")).text, "修改了 cart.js", "no counts, none drawn");
  assert.equal(workLabel(edit("src/cart.js", 2, 2, "running")).text, "正在修改 cart.js +2 −2");
  assert.equal(workLabel(edit("src/cart.js", undefined, undefined, "failed")).text, "修改失败 cart.js");
  assert.equal(workLabel(change([{ path: "src/new.js", op: "create", added: 12 }])).text, "新建了 new.js +12");
  assert.equal(workLabel(change([{ path: "src/old.js", op: "delete", removed: 7 }])).text, "删除了 old.js −7");
  assert.equal(workLabel(change([{ path: "src/b.js", op: "rename", oldPath: "src/a.js" }])).text, "重命名了 a.js → b.js");
  assert.equal(workLabel(change([{ path: "src/new.js", op: "create" }], "running")).text, "正在新建 new.js");
  assert.equal(workLabel(change([{ path: "a.js", op: "modify", added: 1, removed: 1 }, { path: "b.js", op: "modify", added: 2 }])).text, "修改了 2 个文件 +3 −1");
  assert.equal(workLabel(change([{ path: "a.js", op: "create" }, { path: "b.js", op: "create" }])).text, "新建了 2 个文件");
  assert.equal(workLabel(change([])).text, "修改了文件");
});

test("a command that ended with an exit code other than 0 says it, and the whole command stays in the title", () => {
  const failed = workLabel(command("npm test", "completed", { exitCode: 1 }));
  assert.equal(failed.text, "运行了 npm test 退出码 1");
  assert.equal(failed.exit, 1);
  assert.equal(workLabel(command("npm test", "completed", { exitCode: 0 })).exit, undefined, "exit 0 is not worth a mark");
  assert.equal(workLabel(command("npm test", "failed", { exitCode: 2 })).text, "运行失败 npm test 退出码 2");
  const long = "node --test " + "x".repeat(400), label = workLabel(command(long));
  assert.ok(label.object!.length <= 161, "a long command is cut for the line");
  assert.equal(label.title, long, "and kept whole for the title");
  assert.equal(label.mono, true);
  assert.equal(workLabel(read("src/cart.js")).mono, true);
  assert.equal(workLabel(search("taxFor")).mono, false);
  assert.equal(workLabel(command("")).mono, false, "no object, no code type");
});

test("a run of actions is one line that counts what was done, as Claude's desktop does", () => {
  // The first turn of the trial: six commands and seven reads whose paths the Harness did not give.
  const trial = [...Array.from({ length: 6 }, () => command("bash")), ...Array.from({ length: 7 }, () => read(null))];
  const summary = summarizeGroup(trial);
  assert.equal(summary.text, "运行了 6 条命令，读取了 7 个文件");
  assert.deepEqual([summary.folded, summary.problems], [0, 0]);
  // The kinds come in a fixed order, not the order they happened in.
  assert.equal(summarizeGroup([read("a.js"), read("b.js"), command("x"), search("q")]).text, "运行了 1 条命令，读取了 2 个文件，搜索了 1 处");
  // What is counted is distinct targets: a file read three times is one file; a command run twice is two commands.
  assert.equal(summarizeGroup([read("a.js"), read("a.js"), read("a.js"), read("b.js"), command("npm test"), command("npm test")]).text, "运行了 2 条命令，读取了 2 个文件");
  assert.equal(summarizeGroup([edit("a.js"), edit("a.js"), edit("b.js")]).text, "修改了 2 个文件");
  assert.equal(summarizeGroup([change([{ path: "a.js", op: "create" }]), change([{ path: "b.js", op: "create" }])]).text, "新建了 2 个文件");
  assert.equal(summarizeGroup([web({ action: "search", query: "a" }), web({ action: "search", query: "b" }), web({ action: "fetch", url: "https://x.dev/a" }), web({ action: "fetch", url: "https://x.dev/a" }), web({ action: "fetch", url: "https://x.dev/b" })]).text,
    "搜索了 2 次网页，读取了 2 个网页");
  assert.equal(summarizeGroup([mcp("harnesshub", "hub_turns", "completed", true), mcp("harnesshub", "hub_read_turn", "completed", true), mcp("github", "x"), tool("ToolSearch"), task("t")]).text,
    "运行了 1 个子任务，查阅了 2 次对话记录，使用了 2 个工具");
});

test("when every file touched is the same one, the line names it and says what was done to it", () => {
  assert.equal(summarizeGroup([read("src/cart.js"), edit("src/cart.js", 2, 2)]).text, "读取并修改了 cart.js");
  assert.equal(summarizeGroup([command("npm test"), read("src/cart.js"), edit("src/cart.js"), command("npm test")]).text, "运行了 2 条命令，读取并修改了 cart.js");
  assert.equal(summarizeGroup([read("src/cart.js"), read("src/cart.js")]).text, "读取了 cart.js");
  assert.equal(summarizeGroup([change([{ path: "src/cart.js", op: "create" }]), edit("src/cart.js")]).text, "新建并修改了 cart.js");
  assert.equal(summarizeGroup([read("src/cart.js"), change([{ path: "src/cart.js", op: "delete" }])]).text, "读取并删除了 cart.js");
  assert.equal(summarizeGroup([read("a.js"), edit("a.js"), change([{ path: "a.js", op: "delete" }])]).text, "读取、修改并删除了 a.js");
  // Two files are two files: counted, and not named.
  assert.equal(summarizeGroup([read("a.js"), edit("b.js")]).text, "修改了 1 个文件，读取了 1 个文件");
  // A read that names no path is a file of its own, so a group of them is not one file.
  assert.equal(summarizeGroup([read(null), read(null), edit("a.js")]).text, "修改了 1 个文件，读取了 2 个文件");
});

test("what did not go well is said after the words it belongs to, and nothing is hidden by folding", () => {
  assert.equal(summarizeGroup([command("a"), command("b", "failed"), command("c"), read("x.js")]).text, "运行了 3 条命令（1 个失败），读取了 x.js");
  assert.equal(summarizeGroup([command("a", "declined"), command("b", "cancelled"), command("c", "unknown"), command("d", "failed")]).text, "运行了 4 条命令（1 个失败，1 个已拒绝，1 个已停止，1 个结果未知）");
  const all = summarizeGroup([command("a", "failed"), command("b", "failed"), read("x.js")]);
  assert.deepEqual(all.parts.map(part => [part.text, part.failed]), [["运行了 2 条命令（2 个失败）", true], ["读取了 x.js", false]], "a kind that failed entirely is set in the failure's color");
  assert.equal(all.problems, 2);
  // A file read, then failing to read again, is one file that did not go well.
  assert.equal(summarizeGroup([read("a.js"), read("a.js", "failed"), read("b.js")]).text, "读取了 2 个文件（1 个失败）");
  // Actions still open are not problems.
  assert.equal(summarizeGroup([command("a"), command("b", "running"), command("c", "pending")]).text, "运行了 3 条命令");
});

test("up to four kinds are all named; more are three and \"还有 N 个动作\", which keeps the problems of what it folds", () => {
  const four = summarizeGroup([command("a"), edit("a.js"), read("b.js"), search("q")]);
  assert.equal(four.text, "运行了 1 条命令，修改了 1 个文件，读取了 1 个文件，搜索了 1 处");
  assert.equal(four.folded, 0);
  const five = summarizeGroup([command("a"), command("b"), edit("a.js"), read("b.js"), read("c.js"), search("q"), search("r"), web({ action: "search", query: "w" }), tool("x")]);
  assert.equal(five.text, "运行了 2 条命令，修改了 1 个文件，读取了 2 个文件，还有 4 个动作");
  assert.equal(five.folded, 4);
  const hidden = summarizeGroup([command("a"), edit("a.js"), read("b.js"), read("c.js"), search("q", "content", "failed"), tool("x", "failed"), tool("y")]);
  assert.equal(hidden.text, "运行了 1 条命令，修改了 1 个文件，读取了 2 个文件，还有 3 个动作（2 个失败）");
});

test("a Turn's items are laid out in order: consecutive actions are one run, text ends it, and thoughts between actions go with them", () => {
  const think = (status?: ItemStatus): ReadItem => ({ ...at(status), type: "reasoning", text: "hmm" });
  const say = (phase: "commentary" | "final" = "commentary"): ReadItem => ({ ...at(), type: "assistant_message", messageId: "message-m-" + counter as never, phase });
  const a = command("a"), b = read("x.js"), c = command("c"), d = command("d"), e = command("e");
  const blocks = lay([think(), a, b, say(), c, think(), d, think(), say("final"), e]);
  assert.deepEqual(blocks.map(block => block.kind === "work" ? "work:" + block.work.length + "/" + block.rows.length : block.item.type), ["reasoning", "work:2/2", "assistant_message", "work:2/3", "reasoning", "assistant_message", "work:1/1"]);
  // A run is keyed by its first action, so it stays the same row as it grows.
  assert.equal((blocks[1] as WorkBlock).key, a.id);
  assert.equal((lay([a, b])[0] as WorkBlock).key, a.id);
  assert.equal((lay([a, b, command("more")])[0] as WorkBlock).key, a.id);
  // A thought alone, or after the last action, stands on its own; a thought only ends a run when nothing follows it.
  assert.deepEqual(lay([think(), think()]).map(block => block.kind), ["item", "item"]);
  assert.deepEqual(lay([a, think()]).map(block => block.kind), ["work", "item"]);
  // Only what follows nothing but thoughts is the tail, which more actions may still join.
  assert.deepEqual(lay([a, say(), c, think()]).map(block => block.kind === "work" && block.tail), [false, false, true, false]);
  // The task list is drawn above the message box, not in the transcript.
  assert.deepEqual(lay([{ ...at(), type: "plan", steps: [{ text: "x", status: "pending" }] }, a]).map(block => block.kind), ["work"]);
});

test("what happens inside a delegated task hangs under the task, and an action never ended in a Turn that is over is unknown", () => {
  const parent = task("find it"), inside = { ...read("a.js"), parentId: parent.id }, outside = read("b.js");
  const arranged = arrange({ status: "running", items: [parent, inside, outside] });
  assert.deepEqual(arranged.blocks.map(workOf).map(items => items.map(item => item.id)), [[parent.id, outside.id]]);
  assert.deepEqual(arranged.children.get(parent.id)?.map(item => item.id), [inside.id]);
  // A parent that is not in the Turn leaves the item where it is.
  assert.equal(arrange({ status: "running", items: [{ ...read("a.js"), parentId: "gone" }] }).blocks.length, 1);
  // Open when the Turn is over: no longer in progress, and never completed.
  const open = [command("a", "running"), command("b", "pending"), command("c", "waiting"), command("d")];
  const live = arrange({ status: "running", items: open }), over = arrange({ status: "completed", items: open });
  assert.deepEqual(workOf(live.blocks[0]).map(item => item.status), ["running", "pending", "waiting", "completed"]);
  assert.deepEqual(workOf(over.blocks[0]).map(item => item.status), ["unknown", "unknown", "unknown", "completed"]);
  assert.equal(over.over, true);
});

test("a run of actions is open while it goes on, when something in it failed or waits, and in the detailed density; otherwise it is folded", () => {
  const block = (...items: WorkItem[]) => lay(items)[0] as WorkBlock;
  // Text came after it, so no more actions can join: it is a run of its own and stays folded while the Turn goes on.
  const closed = lay([command("a"), command("b"), { ...at(), type: "assistant_message", messageId: "message-x" as never, phase: "commentary" }])[0] as WorkBlock, done = block(command("a"), command("b"));
  assert.equal(closed.tail, false);
  assert.equal(opensByDefault(closed, true, false), false, "a run that no more can join, while the Turn goes on");
  assert.equal(opensByDefault(done, false, false), false, "folded once the Turn is done");
  assert.equal(opensByDefault(done, true, false), true, "the last run of a Turn that goes on may still grow");
  assert.equal(opensByDefault(closed, false, true), true, "the detailed density opens every run");
  for (const status of ["running", "pending", "waiting", "failed", "unknown"] as const) assert.equal(opensByDefault(block(command("a"), command("b", status)), false, false), true, status);
  for (const status of ["declined", "cancelled", "completed"] as const) assert.equal(opensByDefault(block(command("a"), command("b", status)), false, false), false, status);
});

test("a thought reads as its time when it is known, and as the thought itself when it is not", () => {
  assert.equal(reasoningLabel({ status: "completed", durationMs: 3_000 }, true), "思考了 3 秒");
  assert.equal(reasoningLabel({ status: "completed", durationMs: 400 }, true), "思考了 1 秒", "never under a second");
  assert.equal(reasoningLabel({ status: "completed" }, true), "思考过程");
  assert.equal(reasoningLabel({ status: "running" }, false), "思考中");
  assert.equal(reasoningLabel({ status: "running", durationMs: 5_000 }, true), "思考过程", "a thought never ended in a Turn that is over");
  assert.deepEqual([thoughtTime(12_000), thoughtTime(65_000), thoughtTime(120_000), thoughtTime(3_725_000), thoughtTime(3_600_000)], ["12 秒", "1 分 5 秒", "2 分", "1 小时 2 分", "1 小时"]);
});

test("the footer is written one way: who, which model, how long, what was read in and written out", () => {
  const usage = (more: Partial<TurnUsage> = {}): TurnUsage => ({ completeness: "complete", input: 20_774, output: 684, ...more });
  const turn = (executor: Executor, u: TurnUsage, durationMs?: number) => ({ executor, usage: u, ...(durationMs === undefined ? {} : { durationMs }) });
  assert.equal(turnFooter(turn(harness("opencode", "OpenCode", "GLM 5.3 Flash"), usage(), 31_000)), "OpenCode · GLM 5.3 Flash · 用时 31 秒 · 输入 20.8k · 输出 684");
  assert.equal(turnFooter(turn(harness("dsh", "DeepSeek Harness", "DeepSeek Flash"), { completeness: "unavailable" }, 16_000)), "DeepSeek Harness · DeepSeek Flash · 用时 16 秒", "no tokens the Hub did not count");
  assert.equal(turnFooter(turn(harness("claude", "Claude Code"), usage({ input: 4, output: 1248 }), 65_400)), "Claude Code · 用时 1 分 05 秒 · 输入 4 · 输出 1.2k", "no model, none written");
  assert.equal(turnFooter(turn(harness("codex", "Codex"), { completeness: "partial", input: 41_000, output: 1_100 }, 3_640)), "Codex · 用时 3.6 秒", "a partial count is no count");
  assert.equal(turnFooter(turn(harness("codex", "Codex"), usage({ input: 356_323, output: 1_935 }))), "Codex · 输入 356.3k · 输出 1.9k", "no time yet while it runs");
  // The cost is only the conversation's so far, and last; a Turn's own is not written.
  assert.equal(turnFooter(turn(harness("claude", "Claude Code"), usage({ cost: { amount: 0.8727869, currency: "USD", scope: "conversation" } }), 9_000)), "Claude Code · 用时 9.0 秒 · 输入 20.8k · 输出 684 · 对话累计 US$0.87");
  assert.equal(turnFooter(turn(harness("claude", "Claude Code"), usage({ cost: { amount: 0.12, currency: "USD", scope: "turn" } }), 9_000)), "Claude Code · 用时 9.0 秒 · 输入 20.8k · 输出 684");
  assert.equal(turnFooter(turn(harness("claude", "Claude Code"), { completeness: "unavailable", cost: { amount: 3.056, currency: "EUR", scope: "conversation" } })), "Claude Code · 对话累计 EUR 3.06");
  assert.deepEqual([moneyText({ amount: 0.0012, currency: "USD" }), moneyText({ amount: 0, currency: "CNY" }), moneyText({ amount: 12, currency: "CNY" }), moneyText({ amount: 0.005, currency: "USD" })], ["US$0.0012", "¥0.00", "¥12.00", "US$0.005"]);
});

test("where another Harness took over is one line, from → to and what it was given, with the delivery's trouble after it", () => {
  const item = (more: Partial<SwitchItem> = {}): SwitchItem => ({ ...at(), type: "switch", from: harness("codex", "Codex"), to: harness("claude", "Claude Code"), context: "full", turns: 2, session: "new", ...more });
  assert.equal(switchLine(item()).text, "Codex → Claude Code · 带上了之前的全部 2 轮");
  assert.equal(switchLine(item({ context: "delta", turns: 1 })).text, "Codex → Claude Code · 带上了之前 1 轮");
  const { turns: _turns, ...unnumbered } = item();
  assert.equal(switchLine(unnumbered as SwitchItem).text, "Codex → Claude Code · 带上了之前的全部对话");
  assert.equal(switchLine(item({ context: "resend" })).text, "Codex → Claude Code · 又带了一次之前的内容");
  assert.equal(switchLine(item({ context: "none" })).text, "Codex → Claude Code · 只发了原话");
  assert.equal(switchLine(item({ context: "native" })).text, "Codex → Claude Code");
  // Not said: whether the session is new or the earlier one went on (the tooltip has it), and a delivery that is confirmed.
  assert.equal(switchLine(item({ session: "resumed", delivery: "confirmed" })).text, "Codex → Claude Code · 带上了之前的全部 2 轮");
  assert.equal(switchLine(item({ delivery: "unconfirmed" })).text, "Codex → Claude Code · 带上了之前的全部 2 轮 · 未确认收到");
  assert.equal(switchLine(item({ delivery: "sending" })).text, "Codex → Claude Code · 带上了之前的全部 2 轮 · 送达中");
  // A packet that did not go is not said to have been carried.
  assert.equal(switchLine(item({ delivery: "not_sent" })).text, "Codex → Claude Code · 没有发出");
  assert.deepEqual([switchLine(item({ delivery: "unconfirmed" })).attention, switchLine(item({ delivery: "not_sent" })).attention, switchLine(item({ delivery: "confirmed" })).attention, switchLine(item()).attention], [true, true, false, false]);
  assert.equal(switchLine(item({ session: "new", delivery: "unconfirmed" })).details, "新会话 · 交接单未确认送达");
  assert.equal(switchLine(item({ session: "resumed", context: "native" })).details, "继续原会话");
  assert.equal(switchLine(item({ packetId: "relay-0123" })).packetId, "relay-0123");
  assert.equal(switchLine(item()).packetId, null);
  // Within one Harness the two sides are its models; a model it chose itself is its default.
  const models = (from: string | undefined, to: string | undefined) => item({ from: harness("claude", "Claude Code", from), to: harness("claude", "Claude Code", to), context: "native" });
  assert.equal(switchLine(models("Opus", "Sonnet")).text, "Opus → Sonnet");
  assert.equal(switchLine(models(undefined, "Sonnet")).text, "本机默认模型 → Sonnet");
  assert.deepEqual([switchLine(models("Opus", "Sonnet")).from, switchLine(models("Opus", "Sonnet")).to, switchLine(models("Opus", "Sonnet")).changed], ["Opus", "Sonnet", true]);
  assert.equal(switchLine(models("Opus", "Opus")).text, "Claude Code 的设置已更换");
  assert.equal(switchLine(models("Opus", "Opus")).changed, false);
});

test("the line that says why a Turn ended is the table's sentence, and is not drawn when the Turn says it elsewhere", () => {
  const turn = (status: ReadTurn["status"], stopReason?: ReadTurn["stopReason"], items: readonly ReadItem[] = []) => ({ status, ...(stopReason === undefined ? {} : { stopReason }), items });
  assert.equal(endLine(turn("completed", "end_turn")), null, "a Turn that simply ended");
  assert.equal(endLine(turn("completed")), null);
  assert.equal(endLine(turn("running", "end_turn")), null, "nothing is said of a Turn that is not over");
  assert.equal(endLine(turn("failed", "refusal"))!.text, "失败 · 模型拒绝了这个请求");
  assert.equal(endLine(turn("failed", "max_tokens"))!.text, "失败 · 输出达到上限，没有说完");
  assert.equal(endLine(turn("failed", "max_steps"))!.text, "失败 · 步数达到上限");
  assert.equal(endLine(turn("failed", "budget"))!.text, "失败 · 超过了这一轮的时间上限");
  assert.equal(endLine(turn("cancelled", "user_stopped"))!.text, "已停止 · 你停止了这一轮");
  assert.equal(endLine(turn("cancelled", "budget"))!.text, "已停止 · 超过了这一轮的时间上限");
  assert.equal(endLine(turn("cancelled"))!.text, "已停止");
  assert.equal(endLine(turn("completed", "cleared"))!.text, "已清空，下一条消息开新会话");
  assert.equal(endLine(turn("unknown", "unknown"))!.text, "结果未知 · 可能已经执行，不会自动重发");
  assert.equal(endLine(turn("failed", "unknown"))!.text, "失败", "a reason nobody reported is not written");
  assert.equal(endLine(turn("failed", "refusal"))!.tone, "failed");
  assert.equal(endLine(turn("cancelled", "user_stopped"))!.tone, "quiet");
  // An error item says what went wrong, and an interrupt item the stop: the line does not say it again.
  const error: ReadItem = { ...at("failed"), type: "error", class: "unknown", message: "boom" }, interrupt: ReadItem = { ...at(), type: "interrupt", by: "user" };
  assert.equal(endLine(turn("failed", "error", [error])), null);
  assert.equal(endLine(turn("failed", "refusal", [error]))!.text, "失败 · 模型拒绝了这个请求");
  assert.equal(endLine(turn("cancelled", "user_stopped", [interrupt])), null);
  assert.equal(endLine(turn("cancelled", "budget", [interrupt]))!.text, "已停止 · 超过了这一轮的时间上限");
});

test("an event is one quiet line of its own facts, and a state that is not done is said in the table's word", () => {
  const line = (item: Record<string, unknown>) => quietLine({ ...at(), ...item } as ReadItem);
  assert.equal(line({ type: "interrupt", by: "user" }), "你停止了这一轮");
  assert.equal(line({ type: "interrupt", by: "hub" }), "HarnessHub 停止了这一轮");
  assert.equal(line({ type: "interrupt", by: "user", status: "unknown" }), "你停止了这一轮 · 结果未知", "whether it stopped is not known: not said as done");
  assert.equal(line({ type: "context_event", kind: "compaction", status: "running" }), "正在压缩上下文");
  assert.equal(line({ type: "context_event", kind: "compaction" }), "上下文已压缩");
  assert.equal(line({ type: "context_event", kind: "compaction", status: "failed" }), "上下文压缩失败");
  assert.equal(line({ type: "context_event", kind: "clear" }), "上下文已清空，下一条消息开新会话");
  assert.equal(line({ type: "context_event", kind: "rewind" }), "已回退到这里");
  assert.equal(line({ type: "delegation", to: harness("codex", "Codex"), task: "补测试" }), "已交给 Codex：补测试");
  assert.equal(line({ type: "delegation", to: harness("codex", "Codex"), task: "补测试", status: "running" }), "交给 Codex：补测试 · 进行中");
  const options = [{ id: "a", role: "allow_once", label: "Allow" }];
  assert.equal(line({ type: "approval", subject: "command", title: "运行 npm test", options }), null, "an approval still waiting is above the message box, not here");
  assert.equal(line({ type: "approval", subject: "command", title: "运行 npm test", options, decision: { role: "allow_once", by: "user", at: 1 } }), "已允许：运行 npm test");
  assert.equal(line({ type: "approval", subject: "command", title: "运行 npm test", options, decision: { role: "allow_always", by: "user", at: 1 } }), "已允许（以后都允许）：运行 npm test");
  assert.equal(line({ type: "approval", subject: "file_change", title: "修改 a.js", options, decision: { role: "deny", by: "timeout", at: 1 } }), "已拒绝（等待超时）：修改 a.js");
  assert.equal(line({ type: "approval", subject: "tool", title: "x", options, decision: { role: "allow_session", by: "policy", at: 1 } }), "已允许（这个对话里都允许）（按规则）：x");
  assert.equal(line({ type: "question", title: "用哪个库？" }), null);
  assert.equal(line({ type: "question", title: "用哪个库？", answer: "dayjs" }), "已回答：用哪个库？（dayjs）");
  assert.equal(line({ type: "unrecognized", nativeType: "hologram" }), "未识别的条目（hologram）");
  assert.equal(line({ type: "unrecognized", nativeType: "" }), "未识别的条目");
  assert.equal(line({ type: "command", command: "ls" }), null, "an action has its own line elsewhere");
});

test("the Turn shows work when an action or a thought is in progress, or a reply has text; otherwise the page says what it waits for", () => {
  const reply = (status: ItemStatus): ReadItem => ({ ...at(status), type: "assistant_message", messageId: "message-x" as never, phase: "final" });
  const yes = () => true, no = () => false;
  assert.equal(showsProgress([], yes), false);
  assert.equal(showsProgress([command("a")], yes), false, "everything done");
  for (const status of ["running", "pending", "waiting"] as const) assert.equal(showsProgress([command("a"), command("b", status)], no), true, status);
  assert.equal(showsProgress([{ ...at("running"), type: "reasoning", text: "" }], no), true);
  assert.equal(showsProgress([reply("running")], yes), true, "a reply that has text");
  assert.equal(showsProgress([reply("running")], no), false, "a reply that has none yet shows nothing");
  assert.equal(showsProgress([reply("completed")], yes), false);
});

test("the words for a state are one table: the eight of an item, the eight of a Turn, and a stored Run's in the Turn's", () => {
  assert.deepEqual(Object.values(ITEM_STATUS_WORDS), ["等待开始", "进行中", "等你处理", "已完成", "失败", "已拒绝", "已停止", "结果未知"]);
  assert.deepEqual(Object.values(TURN_STATUS_WORDS), ["排队中", "准备中", "进行中", "等你处理", "已完成", "失败", "已停止", "结果未知"]);
  assert.deepEqual(RUN_STATUS_WORDS, { queued: "排队中", preparing: "准备中", running: "进行中", settling: "进行中", completed: "已完成", cancelled: "已停止", failed: "失败", unknown: "结果未知" });
  assert.equal(STOP_REASON_WORDS.end_turn, null);
  assert.deepEqual([STOP_REASON_WORDS.user_stopped, STOP_REASON_WORDS.max_tokens, STOP_REASON_WORDS.refusal], ["你停止了这一轮", "输出达到上限，没有说完", "模型拒绝了这个请求"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading a Turn
// ---------------------------------------------------------------------------------------------------------------------

const wire = (items: readonly unknown[], more: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "hh/1", runId: "run-1", n: 3, status: "completed", executor: { harnessId: "codex", harness: "Codex", model: { id: "gpt", label: "GPT" } },
  usage: { completeness: "complete", input: 10, output: 5 }, startedAt: 1000, durationMs: 31_000, items, ...more,
});
const entry = (type: string, more: Record<string, unknown> = {}) => ({ id: "i-" + type, seq: 1, type, status: "completed", ...more });

test("a Turn is read field by field, and what it holds keeps its type", () => {
  const turn = decodeProtocolTurn(wire([
    entry("user_message", { messageId: "message-u1" }), entry("reasoning", { text: "hmm", durationMs: 3000 }),
    entry("command", { command: "npm test", exitCode: 1, cwd: "/w", background: true, startedAt: 5, endedAt: 9, detail: { id: "content-abc", name: "d", mediaType: "application/json", kind: "file", bytes: 4, sha256: "a".repeat(64) } }),
    entry("file_change", { changes: [{ path: "a.js", op: "modify", added: 2, removed: 1 }] }),
    entry("switch", { from: { harnessId: "claude", harness: "Claude Code" }, to: { harnessId: "codex", harness: "Codex", effort: "high" }, context: "delta", turns: 2, session: "resumed", delivery: "confirmed", packetId: "relay-1" }),
    entry("assistant_message", { messageId: "message-a1", phase: "final" }),
  ], { stopReason: "end_turn", usage: { completeness: "complete", input: 10, output: 5, cost: { amount: 0.5, currency: "USD", scope: "conversation" }, context: { used: 100, size: 1000 } } }))!;
  assert.deepEqual([turn.runId, turn.n, turn.status, turn.stopReason, turn.executor.model?.label, turn.durationMs, turn.items.length], ["run-1", 3, "completed", "end_turn", "GPT", 31_000, 6]);
  assert.deepEqual(turn.usage.cost, { amount: 0.5, currency: "USD", scope: "conversation" });
  const [, reasoning, run, files, switched] = turn.items;
  assert.deepEqual([reasoning?.type === "reasoning" && reasoning.durationMs, run?.type === "command" && [run.exitCode, run.cwd, run.background, run.startedAt, run.detail?.id], files?.type === "file_change" && files.changes[0]],
    [3000, [1, "/w", true, 5, "content-abc"], { path: "a.js", op: "modify", added: 2, removed: 1 }]);
  assert.deepEqual(switched?.type === "switch" && [switched.to.effort, switched.context, switched.turns, switched.delivery, switched.packetId], ["high", "delta", 2, "confirmed", "relay-1"]);
});

test("an item of a type the page does not know, or one it cannot read whole, is kept as a line that says so, never dropped", () => {
  const turn = decodeProtocolTurn(wire([
    entry("command", { command: "ls" }), entry("hologram", { whatever: 1, nativeName: "Hologram" }), entry("command", { command: 5 }), { not: "an item" }, null, "text",
    entry("file_read", { path: "a.js", status: "someday" }),
  ]))!;
  assert.equal(turn.items.length, 7, "every item is kept");
  assert.deepEqual(turn.items.map(item => item.type), ["command", "unrecognized", "unrecognized", "unrecognized", "unrecognized", "unrecognized", "unrecognized"]);
  const [, unknownType, badFields, , , , badStatus] = turn.items;
  assert.deepEqual(unknownType?.type === "unrecognized" && [unknownType.nativeType, unknownType.nativeName, unknownType.status], ["hologram", "Hologram", "completed"]);
  // An item whose own fields could not be read is not shown as completed when its state is unreadable too.
  assert.equal(badFields?.status, "completed", "its state was readable, and is kept");
  assert.equal(badStatus?.status, "unknown", "a state that is not one of the eight is unknown, not completed");
  // Each keeps a place of its own.
  assert.equal(new Set(turn.items.map(item => item.id)).size, 7);
});

test("a field that is absent is absent, an id that repeats is told apart, and an unreadable count of usage is no count", () => {
  const turn = decodeProtocolTurn(wire([entry("command", { id: "same", command: "a" }), entry("command", { id: "same", command: "b" }), entry("command", { id: "same", command: "c" })], { usage: "nonsense", stopReason: "from-the-future" }))!;
  assert.deepEqual(turn.items.map(item => item.id), ["same", "same~2", "same~3"]);
  assert.deepEqual(turn.usage, { completeness: "unavailable" });
  assert.equal(turn.stopReason, "unknown", "a reason this page does not know is unknown");
  const plain = decodeProtocolTurn({ ...wire([]), durationMs: undefined, startedAt: undefined })!;
  assert.deepEqual([plain.durationMs, plain.startedAt, "stopReason" in plain], [undefined, undefined, false]);
  assert.equal(decodeProtocolTurn(wire([entry("command", { command: "a" }), entry("command", { command: "b", exitCode: 1.5 })]))!.items[1]?.type, "unrecognized", "an exit code is a whole number");
  // A field that may be absent is as absent when it is null.
  const nulled = decodeProtocolTurn(wire([entry("command", { command: "a", exitCode: null, cwd: null, raw: null, detail: null })], { executor: { harnessId: "codex", harness: "Codex", model: null, effort: null }, stopReason: null, durationMs: null }))!;
  assert.deepEqual([nulled.executor.model, nulled.executor.effort, nulled.stopReason, nulled.durationMs, nulled.items[0]?.type], [undefined, undefined, undefined, undefined, "command"]);
});

test("what is not a Turn of this protocol is no Turn, and nothing that can arrive makes the decoder throw", () => {
  assert.equal(decodeProtocolTurn(wire([], { version: "hh/2" })), undefined);
  assert.equal(decodeProtocolTurn(wire([], { items: "no" })), undefined);
  assert.equal(decodeProtocolTurn(wire([], { executor: null })), undefined);
  assert.equal(decodeProtocolTurn(wire([], { status: "nearly" })), undefined);
  assert.equal(decodeProtocolTurn(wire([], { runId: "x" })), undefined);
  for (const junk of [undefined, null, 0, "", "turn", [], [1, 2], {}, { version: "hh/1" }, () => 1, Symbol("x"), 1n]) assert.doesNotThrow(() => decodeProtocolTurn(junk), String(typeof junk));
  const big = decodeProtocolTurn(wire(Array.from({ length: 5000 }, () => entry("command", { command: "x" }))));
  assert.equal(big, undefined, "more items than a Turn can have is not a Turn");
});
