import assert from "node:assert/strict";
import test from "node:test";
import type { PublicRun, PublicTool } from "../../src/contracts/session.js";
import { workspacePath } from "../../web/src/lib/format.js";
import { readPreferences } from "../../web/src/lib/prefs.js";
import { activityLabel, askingStep, cancelledWords, changeCount, diffTotals, groupSteps, liveStatus, noteMount, parseUnifiedDiff, readsLabel, rememberShown, reveal, shownSteps, spentText, stepLabel, stoppedByUser, toolSummary, toolTree, wantedVerb, wrapChunks, type HastNode, type QueueNotice, type Reveal } from "../../web/src/lib/turn.js";

/** A running Run with the facts the status line reads; the rest of a Run does not matter to it. */
function runningRun(tools: readonly PublicTool[] = [], extra: Partial<PublicRun> = {}): PublicRun {
  return { id: "run-live", status: "running", cancelRequested: false, error: null, tools, timing: { acceptedAt: 0, dispatchedAt: 10, firstOutputAt: 20 }, ...extra } as PublicRun;
}
/** Reads the preferences while this browser's storage holds `stored` (nothing when undefined) under their key. */
function readStored(stored: unknown): ReturnType<typeof readPreferences> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => key === "harnesshub:preferences" && stored !== undefined ? JSON.stringify(stored) : null } });
  try { return readPreferences(); }
  finally { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); }
}

test("G054-FR2 the details panel starts closed: a panel stored before the closed default is not read, one chosen since is kept", () => {
  // Nothing stored: closed.
  assert.equal(readStored(undefined).panel, false);
  // Stored before version 2, when every write carried the old default (open) with the rest: the rest is read, the panel is not.
  assert.deepEqual(readStored({ theme: "dark", density: "detailed", panel: true, sidebar: false, showFrozen: true }),
    { theme: "dark", density: "detailed", panel: false, sidebar: false, showFrozen: true });
  // Opened or closed since: the user's own choice, kept either way.
  assert.equal(readStored({ theme: "system", density: "compact", panel: true, sidebar: true, showFrozen: false, version: 2 }).panel, true);
  assert.equal(readStored({ theme: "system", density: "compact", panel: false, sidebar: true, showFrozen: false, version: 2 }).panel, false);
});

test("G054-FR1 preferences stored with the sidebar's old grouping still read, without it, keeping every other choice", () => {
  // The sidebar groups by project only (ADR-054 §5); a browser may still hold the shape every write stored before.
  for (const groupBy of ["status", "harness", "workspace", "something else"]) {
    const read = readStored({ theme: "light", density: "detailed", panel: false, sidebar: false, groupBy, showFrozen: true, version: 2 });
    assert.deepEqual(read, { theme: "light", density: "detailed", panel: false, sidebar: false, showFrozen: true });
    assert.equal(Object.hasOwn(read, "groupBy"), false);
    // The shape exactly as the previous code wrote it, with no version: the same choices are kept, and the panel starts closed.
    assert.deepEqual(readStored({ theme: "dark", density: "detailed", panel: true, sidebar: false, groupBy, showFrozen: true }),
      { theme: "dark", density: "detailed", panel: false, sidebar: false, showFrozen: true });
  }
});

test("G054-FR3 the details button, its tab and its scopes count the edits with stored detail, known without reading any", () => {
  // Only whether a tool carries stored detail matters here, not what the reference holds.
  const tool = (id: string, kind: string, detail: boolean): PublicTool => ({ id, title: id, kind, status: "completed", ...(detail ? { detail: { id: "content-" + id } } : {}) }) as unknown as PublicTool;
  // Two edits of one file and a deletion count three places; an edit without detail and the other kinds count none.
  const first = { tools: [tool("e1", "edit", true), tool("e2", "edit", true), tool("r", "read", true), tool("x", "execute", true)] };
  const second = { tools: [tool("d", "delete", true), tool("e3", "edit", false), tool("m", "move", false)] };
  assert.deepEqual([changeCount([first, second]), changeCount([first]), changeCount([second]), changeCount([]), changeCount([{}])], [3, 2, 1, 0, 0]);
});

test("G054-DL5 while an approval waits the Turn names the step it asks for in the 想… form, grey and still; a question keeps naming the step in progress; without a step each says 等你批准 or 等你回答, never the marker's words", () => {
  const step: PublicTool = { id: "diff", title: "git diff --stat", kind: "execute", status: "in_progress" };
  const quiet = { tone: "wait", timer: true, wrap: false, thinking: false };
  // Ruling J (replacing decision F for approvals): nothing runs while the approval waits, so Codex's command in progress is
  // the step it asks for, named in the Interaction board's form: the still grey dot ("wait"), no sweep, the timer.
  assert.deepEqual(liveStatus(runningRun([step]), "running", "Codex", 42_000, undefined, undefined, "approval"), { ...quiet, text: "想运行 git diff --stat" });
  // A question never names a step of its own: the step in progress keeps its arc (decision F).
  assert.deepEqual(liveStatus(runningRun([step]), "running", "Codex", 42_000, undefined, undefined, "question"), { text: "正在运行 git diff --stat", tone: "run", timer: true, wrap: false, thinking: false });
  // With no step open the line itself says what it waits for, also when reply text came before the request.
  assert.deepEqual(liveStatus(runningRun([{ ...step, status: "completed" }]), "running", "Codex", 42_000, undefined, undefined, "approval", "先看一下改动。"), { ...quiet, text: "等你批准" });
  assert.deepEqual(liveStatus(runningRun(), "running", "Codex", 90_000, undefined, undefined, "question"), { ...quiet, text: "等你回答" });
  // An ACP agent reports the call it asks about as "pending" until it is allowed: the line says what it wants, never that it
  // runs. Beside a step in progress, the most recent open step is the one asked about.
  const asked: PublicTool = { id: "ask", title: "rm -rf build", kind: "execute", status: "pending" };
  assert.deepEqual(liveStatus(runningRun([asked]), "running", "Claude Code", 42_000, undefined, undefined, "approval"), { ...quiet, text: "想运行 rm -rf build" });
  assert.equal(liveStatus(runningRun([step, asked]), "running", "Claude Code", 42_000, undefined, undefined, "approval").text, "想运行 rm -rf build");
  // The amber line pointing at the approval is the Turn's marker alone: the status line never says it.
  for (const waiting of ["approval", "question"] as const) for (const tools of [[], [step]]) assert.doesNotMatch(liveStatus(runningRun(tools), "running", "Codex", 0, undefined, undefined, waiting).text, /请求停在下方输入框/u);
  // A stop asked for is said first, whatever waits.
  assert.equal(liveStatus(runningRun([step], { cancelRequested: true }), "running", "Codex", 0, undefined, undefined, "approval").text, "正在停止并清理资源");
  // A Turn queued behind another conversation says what that one waits for in the same words (decision G).
  const queue = (holderWaits: "approval" | "question" | null): QueueNotice => ({ kind: "workspace", holderTitle: "approve this", holderWaits, endsAt: 0, cancelling: false });
  assert.deepEqual([queue("approval"), queue("question"), queue(null)].map(item => liveStatus(runningRun([], { status: "queued" }), "queued", "Codex", 0, undefined, item).text), [
    "排队中：等待对话「approve this」释放工作区（它在等你批准）", "排队中：等待对话「approve this」释放工作区（它在等你回答）", "排队中：等待对话「approve this」释放工作区（它正在运行）"]);
});

test("G054-DL5 a queued Turn reads 排队中 and a failed one 失败, the words every place uses for those states (ruling N)", () => {
  // Queued: the word alone, or the word first with the reason after it; the dashed symbol, no timer.
  const queuedRun = runningRun([], { status: "queued" });
  assert.deepEqual(liveStatus(queuedRun, "queued", "Codex", 0), { text: "排队中", tone: "queue", timer: false, wrap: true, thinking: false });
  assert.equal(liveStatus(queuedRun, "queued", "Codex", 0, undefined, { kind: "slot", running: 4, cancelling: false }).text, "排队中：4 个对话正在执行，其中一个结束后自动开始");
  assert.equal(liveStatus(runningRun([], { status: "queued", awaitingSwitchId: "switch-1" } as Partial<PublicRun>), "queued", "Codex", 0).text, "排队中：等待选择切换生效");
  // Failed: the state's word; the Agent's own words belong to the error card. The other finished states keep theirs.
  assert.deepEqual(["failed", "completed", "unknown"].map(status => activityLabel({ ...runningRun(), status } as PublicRun, status as PublicRun["status"], "Codex", 0)),
    ["失败", "已完成", "结果未知：可能已经执行，不会自动重发"]);
});

test("G054-DL5 the step an approval asks for is the latest open step of the Turn's own, said with the verb of its kind, and a step without one is never guessed at (ruling J)", () => {
  const tool = (id: string, kind: string | undefined, title: string, status: string, parentId?: string): PublicTool => ({ id, title, status, ...(kind ? { kind } : {}), ...(parentId ? { parentId } : {}) });
  const wanted = (tools: readonly PublicTool[]) => liveStatus(runningRun(tools), "running", "Claude Code", 42_000, undefined, undefined, "approval");
  // Each kind in its own words, as the steps show them: a path is named by its file, a verb the program wrote is not repeated.
  for (const [kind, title, words] of [["edit", "Edit src/app.ts", "想修改 src/app.ts"], ["edit", "新建 web/src/Steps.tsx", "想新建 web/src/Steps.tsx"], ["read", "Read /Users/someone/project/secret.txt", "想读取 secret.txt"],
    ["delete", "Delete /w/build/out.js", "想删除 out.js"], ["move", "Move a.ts", "想移动 a.ts"], ["search", "搜索：token", "想搜索 token"], ["fetch", "Fetch https://example.invalid/a", "想访问 https://example.invalid/a"],
    ["mcp", "docs.lookup", "想调用 docs.lookup"], ["execute", "terminal: rm -rf build", "想运行 rm -rf build"]] as const) {
    assert.deepEqual(wanted([tool("done", "read", "Read a.ts", "completed"), tool("ask", kind, title, "pending")]), { text: words, tone: "wait", timer: true, wrap: false, thinking: false }, kind + ": " + title);
  }
  // Every open status counts, and only the Turn's own steps: a sub-agent call has no verb of its own, so while one of its
  // tools waits the line says 等你批准 instead of guessing which. So does a step of no known kind.
  for (const status of ["pending", "in_progress", "inProgress", "running"]) assert.equal(wanted([tool("ask", "execute", "make", status)]).text, "想运行 make", status);
  const agent = [tool("agent", "think", "Run echo SUB-OK", "in_progress"), tool("bash", "execute", "rm -rf build", "pending", "agent")];
  assert.equal(askingStep(agent)?.id, "agent");
  assert.deepEqual([wanted(agent).text, wanted([tool("plan", "switch_mode", "Ready to code?", "pending")]).text, wanted([tool("odd", undefined, "something", "pending")]).text], ["等你批准", "等你批准", "等你批准"]);
  // The latest open step, not the latest step: one that ended after it does not take its place.
  assert.equal(askingStep([tool("ask", "execute", "make", "pending"), tool("late", "read", "Read b.ts", "completed")])?.id, "ask");
  assert.equal(askingStep([tool("x", "execute", "make", "completed")]), null);
  // A long target is cut at 80 characters, as a running step's is; the verb alone is what a step's row puts before its target.
  assert.equal([...wanted([tool("long", "execute", "x".repeat(200), "pending")]).text].length, "想运行 ".length + 80);
  assert.deepEqual([wantedVerb({ verb: "运行" }), wantedVerb({ verb: null })], ["想运行", null]);
  // While it asks, a read stays a step of its own, so its row can say what it wants; once decided it joins its group again.
  const reads = [tool("r1", "read", "Read a.ts", "completed"), tool("r2", "read", "Read b.ts", "pending"), tool("r3", "read", "Read c.ts", "completed")];
  const steps = (apart?: string) => groupSteps(toolTree(reads).roots, new Map(), apart).map(step => step.kind === "reads" ? [step.key, step.tools.map(item => item.id)] : [step.key]);
  assert.deepEqual(steps("r2"), [["r1"], ["r2"], ["r3"]]);
  assert.deepEqual(steps(), [["r1", ["r1", "r2", "r3"]]]);
});

test("G054-DL7 a Turn the user stopped says 已停止; one the Runtime cancelled keeps the contract's words, and the header's short word is 已取消", () => {
  const cancelled = (code: string | null, cancelRequested: boolean) => ({ error: code === null ? null : { code, message: "" }, cancelRequested });
  // The user's stop: cancelRequested with none of the Runtime's causes, also when the program reported its own code for it.
  for (const run of [cancelled(null, true), cancelled("CANCELLED", true)]) {
    assert.equal(stoppedByUser(run), true); assert.deepEqual([cancelledWords(run), cancelledWords(run, true)], ["已停止", "已停止"]);
  }
  // The Runtime's cancellations keep the contract's words, and are never the user's, even when a stop was asked for as well.
  for (const [code, words] of [["RUN_TIMEOUT", "已取消（执行预算用尽）"], ["WAIT_EXPIRED", "已取消（等待你的决定超时）"], ["OWNER_ENDED", "已取消（服务重启，这条消息没有发出）"]] as const) {
    for (const asked of [false, true]) {
      const run = cancelled(code, asked);
      assert.equal(stoppedByUser(run), false, code); assert.deepEqual([cancelledWords(run), cancelledWords(run, true)], [words, "已取消"], code);
    }
  }
  // Cancelled without anyone asking (the program ended its own turn so): not the user's either.
  assert.deepEqual([stoppedByUser(cancelled(null, false)), cancelledWords(cancelled(null, false)), cancelledWords(cancelled(null, false), true)], [false, "已取消", "已取消"]);
  // The Turn's finished words follow the same rule.
  assert.equal(activityLabel({ ...runningRun(), status: "cancelled", ...cancelled(null, true) }, "cancelled", "Codex", 0), "已停止");
  assert.equal(activityLabel({ ...runningRun(), status: "cancelled", ...cancelled("WAIT_EXPIRED", false) }, "cancelled", "Codex", 0), "已取消（等待你的决定超时）");
});

test("G054-FR7 a unified diff splits into files with numbered lines and counts, and text without headers keeps the given name", () => {
  const files = parseUnifiedDiff([
    "diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ export function a() {", " const x = 1;", "-const y = 2;", "+const y = 3;", "+const z = 4;", " return x;",
    "--- a/docs/b.md", "+++ b/docs/b.md", "@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file",
  ].join("\n"), "fallback");
  assert.deepEqual(files.map(file => [file.path, file.add, file.del]), [["src/a.ts", 2, 1], ["docs/b.md", 1, 1]]);
  const lines = files[0]!.lines.filter(line => line.kind !== "file" && line.kind !== "meta");
  assert.deepEqual(lines.map(line => [line.kind, line.oldNo ?? null, line.newNo ?? null, line.text]), [
    ["hunk", null, null, "@@ -10,3 +10,4 @@ export function a() {"], ["context", 10, 10, "const x = 1;"], ["remove", 11, null, "const y = 2;"],
    ["add", null, 11, "const y = 3;"], ["add", null, 12, "const z = 4;"], ["context", 12, 13, "return x;"],
  ]);
  assert.equal(files[1]!.lines.at(-1)?.kind, "meta", "the no-newline marker is shown, never counted");
  // A program that reports only hunks still gets a file named after where it said it edited.
  const bare = parseUnifiedDiff("@@ -1,2 +1,2 @@\n-a\n+b\n c\n", "README.md");
  assert.deepEqual(bare.map(file => [file.path, file.add, file.del]), [["README.md", 1, 1]]);
  // A new file names its target, a deleted one its source.
  assert.equal(parseUnifiedDiff("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+x", "?")[0]!.path, "new.txt");
  assert.equal(parseUnifiedDiff("--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x", "?")[0]!.path, "gone.txt");
});

test("G054-FR7 the folded process line counts each kind of tool and always says what failed or never finished", () => {
  const tool = (id: string, kind: string, status: string, parentId?: string): PublicTool => ({ id, title: id, kind, status, ...(parentId ? { parentId } : {}) });
  const tools = [tool("r1", "read", "completed"), tool("r2", "read", "completed"), tool("s", "search", "completed"), tool("x1", "execute", "failed"),
    tool("e", "edit", "completed"), tool("agent", "other", "completed"), tool("child", "execute", "completed", "agent"), tool("x2", "execute", "pending")];
  // The Conversation board's words: past tense once the Turn ended, edits counted as the places changed (calls, not files).
  const ended = toolSummary(tools, false);
  assert.equal(ended.text, "读了 2 个文件，搜索 1 次，改了 1 处，运行 2 条命令，子 Agent 1 个，1 项失败，1 项未完成");
  assert.equal(ended.compact, "读取 2 · 搜索 1 · 修改 1 · 运行 2 · 子 Agent 1 · 失败 1 · 未完成 1");
  assert.deepEqual([ended.failed, ended.unfinished, ended.running], [1, 1, null]);
  // While the Turn runs, a pending tool is the one running now, not an unfinished one.
  const running = toolSummary(tools, true);
  assert.equal(running.unfinished, 0); assert.equal(running.running?.id, "x2");
  assert.equal(running.text, "读了 2 个文件，搜索 1 次，改了 1 处，运行 2 条命令，子 Agent 1 个，1 项失败");
  assert.equal(toolSummary([tool("d", "declined-kind", "declined")], false).text, "其他工具 1 个，1 项失败");
});

test("G054-FR3 a changed file is named relative to the conversation's workspace, also when the diff dropped its leading slash", () => {
  const workspace = "/private/tmp/hub/dev-ws";
  assert.equal(workspacePath("private/tmp/hub/dev-ws/src/a.ts", workspace), "src/a.ts");
  assert.equal(workspacePath("/tmp/hub/dev-ws/b.md", workspace), "b.md", "macOS reports /tmp and /private/tmp for the same directory");
  assert.equal(workspacePath("/Users/someone/elsewhere/c.ts", workspace), "~/elsewhere/c.ts");
  assert.equal(workspacePath("src/relative.ts", workspace), "src/relative.ts");
});

test("G054-DL4 consecutive reads become one step that keeps its first read's key, and a sub-agent call keeps its own tools", () => {
  const tool = (id: string, kind: string | undefined, title = id, parentId?: string): PublicTool => ({ id, title, status: "completed", ...(kind ? { kind } : {}), ...(parentId ? { parentId } : {}) });
  const tools = [tool("r1", "read", "Read /w/src/a.ts"), tool("r2", "read", "Read /w/src/b.ts"), tool("x", "execute"), tool("r3", "read"), tool("agent", "think"),
    tool("r4", "read"), tool("r5", "read"), tool("inner", "read", "inner", "agent"), tool("r6", "read")];
  const { roots, children } = toolTree(tools);
  const steps = groupSteps(roots, children);
  assert.deepEqual(steps.map(step => step.kind === "reads" ? [step.key, step.tools.map(item => item.id)] : [step.key]),
    [["r1", ["r1", "r2"]], ["x"], ["r3"], ["agent"], ["r4", ["r4", "r5", "r6"]]], "a read alone stays one step; the sub-agent's read stays under it");
  // A read that grows into a group keeps its key, so its row is not drawn again.
  assert.equal(groupSteps(toolTree([tools[0]!]).roots, new Map())[0]!.key, "r1");
  assert.deepEqual(readsLabel([tools[0]!, tools[1]!]), { verb: "读取 2 个文件", running: "正在读取 2 个文件", target: "a.ts · b.ts" });
});

test("G054-DL4 a step reads as the verb of its kind and what it acted on, without repeating a verb the program wrote", () => {
  const label = (kind: string | undefined, title: string, nested = false) => { const value = stepLabel({ title, ...(kind ? { kind } : {}) }, nested); return [value.verb, value.running, value.target]; };
  // Codex: a command is its own title; an edit and a web search carry the program's Chinese verb.
  assert.deepEqual(label("execute", "ls -la"), ["运行", "正在运行", "ls -la"]);
  assert.deepEqual(label("edit", "修改 README.md"), ["修改", "正在修改", "README.md"]);
  assert.deepEqual(label("search", "搜索：react 19"), ["搜索", "正在搜索", "react 19"]);
  // Claude Code and Hermes (ACP): English verbs, backticks around a command, a tool name with a colon.
  assert.deepEqual(label("read", "Read /Users/someone/project/src/a.ts"), ["读取", "正在读取", "a.ts"]);
  assert.deepEqual(label("edit", "Edit `src/b.ts`"), ["修改", "正在修改", "src/b.ts"]);
  assert.deepEqual(label("execute", "`npm test`"), ["运行", "正在运行", "npm test"]);
  assert.deepEqual(label("execute", "terminal: rm -r build"), ["运行", "正在运行", "rm -r build"]);
  assert.deepEqual(label("edit", "新建 web/src/Steps.tsx"), ["新建", "正在新建", "web/src/Steps.tsx"]);
  // A word that only starts like a verb is kept; a command's absolute path is never shortened.
  assert.deepEqual(label("search", "findings.md"), ["搜索", "正在搜索", "findings.md"]);
  assert.deepEqual(label("execute", "/usr/bin/env node"), ["运行", "正在运行", "/usr/bin/env node"]);
  // Without a known kind, or for a sub-agent call, the title is kept as the program wrote it.
  assert.deepEqual(label(undefined, "Read fixture"), [null, null, "Read fixture"]);
  assert.deepEqual(label("execute", "Run echo SUB-OK", true), [null, null, "Run echo SUB-OK"]);
  assert.deepEqual(label("mcp", "docs.lookup"), ["调用", "正在调用", "docs.lookup"]);
});

test("G054-DL4 a diff says which files it creates, and an edit's step counts the lines it adds and removes", () => {
  const created = parseUnifiedDiff("--- /dev/null\n+++ b/web/src/Steps.tsx\n@@ -0,0 +1,2 @@\n+a\n+b", "?");
  assert.equal(created[0]!.created, true);
  assert.equal(parseUnifiedDiff("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x", "?")[0]!.created, true);
  const changed = parseUnifiedDiff("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+n", "?");
  assert.deepEqual(changed.map(file => file.created), [false, true]);
  assert.deepEqual(diffTotals(changed), { add: 2, del: 1, created: false }, "a step is new only when every file in it is");
  assert.deepEqual(diffTotals(created), { add: 2, del: 0, created: true });
  assert.deepEqual(diffTotals([]), { add: 0, del: 0, created: false });
});

test("G054-DL7 streamed text is released as a growing prefix at the backlog's pace, bursts and replacements show at once, and order never changes", () => {
  const start: Reveal = { text: "开头", shown: 2, rate: 0, chunks: [], at: 0 };
  // 80 characters, 1 s after the last ones: released bit by bit, never past what was committed.
  const committed = "开头" + "回".repeat(80);
  let state = reveal(start, { type: "arrive", text: committed, at: 1000, animate: true });
  assert.equal(state.shown, 2, "nothing is released before the next tick");
  const seen: number[] = [];
  for (let tick = 0; tick < 60 && state.shown < committed.length; tick++) { state = reveal(state, { type: "tick" }); seen.push(state.shown); }
  assert.equal(state.shown, committed.length, "the backlog is caught up");
  assert.ok(seen.length >= 16 && seen.length <= 30, "about a second at 50 ms a tick: " + seen.length);
  assert.ok(seen.every((value, index) => index === 0 || value > seen[index - 1]!), "every tick releases something");
  // Each release is one chunk; together they cover the released text exactly once, in order.
  assert.deepEqual(state.chunks.map(chunk => chunk.from), [2, ...state.chunks.slice(0, -1).map(chunk => chunk.to)]);
  assert.equal(state.chunks.at(-1)!.to, committed.length);
  // More than 120 characters at once, or faster than 1.6 per millisecond, shows at once; so does a replaced text.
  assert.equal(reveal(start, { type: "arrive", text: "开头" + "x".repeat(121), at: 1000, animate: true }).shown, 123);
  assert.equal(reveal(start, { type: "arrive", text: "开头" + "x".repeat(40), at: 20, animate: true }).shown, 42);
  assert.equal(reveal(state, { type: "arrive", text: "另一段", at: 3000, animate: true }).shown, 3);
  assert.deepEqual(reveal(state, { type: "arrive", text: "另一段", at: 3000, animate: true }).chunks, []);
  // Without animation (reduced motion, or text that is not streaming) everything shows as it arrives.
  assert.equal(reveal(start, { type: "arrive", text: committed, at: 1000, animate: false }).shown, committed.length);
  const pending = reveal(start, { type: "arrive", text: committed, at: 1000, animate: true });
  assert.deepEqual([reveal(pending, { type: "flush" }).shown, reveal(pending, { type: "flush" }).chunks.length], [committed.length, 0]);
  // A character outside the basic plane is never cut in half.
  let emoji: Reveal = { text: "a", shown: 1, rate: 0, chunks: [], at: 0 };
  emoji = reveal(emoji, { type: "arrive", text: "a😀😀😀", at: 1000, animate: true });
  for (let tick = 0; tick < 20 && emoji.shown < emoji.text.length; tick++) { emoji = reveal(emoji, { type: "tick" }); assert.doesNotMatch(emoji.text.slice(0, emoji.shown), /[\uD800-\uDBFF]$/u); }
});

test("G054-DL7 a release never stops inside a fence marker that opens a line, so a closing fence never shows as one more line of code (ruling L)", () => {
  // Each release of a text that arrives at rest after `shown`, at the pace a short arrival gets: one character a tick.
  const releases = (shown: string, more: string) => {
    let state: Reveal = { text: shown, shown: shown.length, rate: 0, chunks: [], at: 0 };
    state = reveal(state, { type: "arrive", text: shown + more, at: 1000, animate: true });
    const seen: string[] = [];
    for (let tick = 0; tick < 40 && state.shown < state.text.length; tick++) { state = reveal(state, { type: "tick" }); seen.push(state.text.slice(shown.length, state.shown)); }
    return seen;
  };
  // A code block closed as the reply ends: its fence goes whole, never "`" or "``" shown as a line of the code.
  assert.deepEqual(releases("最后运行：\n\n```sh\npnpm test", "\n```"), ["\n", "\n```"]);
  assert.deepEqual(releases("```\nx", "\n   ~~~~\n完"), ["\n", "\n ", "\n  ", "\n   ", "\n   ~~~~", "\n   ~~~~\n", "\n   ~~~~\n完"]);
  // An opening fence goes whole as well, its language after it at the pace.
  assert.deepEqual(releases("看：", "\n```ts"), ["\n", "\n```", "\n```t", "\n```ts"]);
  // Backticks inside a line, or after four spaces (an indented code line), are text like any other.
  assert.deepEqual(releases("用", " ``a``"), [" ", " `", " ``", " ``a", " ``a`", " ``a``"]);
  assert.deepEqual(releases("x\n", "    ``"), [" ", "  ", "   ", "    ", "    `", "    ``"]);
});

test("G054-DL7 the fading pieces wrap the released text where it is, leave code blocks whole and keep every character in order", () => {
  const text = (value: string, from: number): HastNode => ({ type: "text", value, position: { start: { offset: from }, end: { offset: from + value.length } } });
  const tree: HastNode = { type: "root", children: [
    { type: "element", tagName: "p", properties: {}, children: [text("早先的文字，", 0), { type: "element", tagName: "strong", properties: {}, children: [text("新到", 6)] }, text("的部分。", 8)] },
    { type: "element", tagName: "pre", properties: {}, children: [{ type: "element", tagName: "code", properties: {}, children: [text("code();", 13)] }] },
  ] };
  wrapChunks(tree, [{ from: 4, to: 7 }, { from: 7, to: 11 }, { from: 13, to: 20 }]);
  const flat = (node: HastNode): string => node.type === "text" ? (node as { value: string }).value : ("children" in node && node.children ? node.children.map(flat).join("") : "");
  assert.equal(flat(tree), "早先的文字，新到的部分。code();", "wrapping never changes the text or its order");
  const spans: string[] = [];
  const collect = (node: HastNode): void => { if (node.type === "element" && (node as { tagName: string }).tagName === "span") spans.push(flat(node)); if ("children" in node && node.children) node.children.forEach(collect); };
  collect(tree);
  assert.deepEqual(spans, ["字，", "新", "到", "的部分"], "each released piece fades in, split where the Markdown splits it; the code block stays one string");
});

test("G054-DL7 motion is only for news: mounts drawn with a page stay still, a mount on its own decides from its own evidence", () => {
  // A page drawn at once: the first message is old, and everything mounted with it inherits that.
  assert.equal(noteMount(false, 10_000), false);
  assert.equal(noteMount(true, 10_010), false, "a hand-over drawn with the page does not animate");
  assert.equal(noteMount(true, 10_030), false);
  // Later, a message just sent comes in, and the Turn mounted with it does too.
  assert.equal(noteMount(true, 20_000), true);
  assert.equal(noteMount(false, 20_005), true);
  // A hand-over made while the conversation is open comes in on its own.
  assert.equal(noteMount(true, 30_000), true);
});

test("G054-DL7 a finished Turn's time reads like the timer that counted it, so the timer hands over without a jump", () => {
  // Under ten seconds one decimal, cut rather than rounded up; from then on the timer's whole seconds (Motion board #03).
  assert.equal(spentText(3_640), "3.6 秒");
  assert.equal(spentText(9_990), "9.9 秒", "never 10.0 while the timer still said 9");
  assert.equal(spentText(18_900), "18 秒", "the timer showed 18 when the Turn ended at 18.9 s");
  assert.equal(spentText(65_400), "1 分 05 秒", "past a minute, two-digit seconds");
  assert.equal(spentText(3_725_000), "1 小时 02 分");
});

test("G054-DL7 a Turn drawn again keeps the record of the steps its reader saw, so nothing comes in twice", () => {
  // A Turn not shown yet has no record; once shown, the same record comes back for its Run, also after it was drawn again.
  assert.equal(shownSteps("run-shown-1"), undefined);
  const record = new Set(["read-1"]);
  rememberShown("run-shown-1", record);
  record.add("edit-2");
  assert.equal(shownSteps("run-shown-1"), record);
  assert.deepEqual([...shownSteps("run-shown-1")!], ["read-1", "edit-2"]);
  // At most 500 Turns are remembered: the oldest is forgotten first, and is then drawn as history.
  for (let index = 0; index < 500; index++) rememberShown("run-many-" + index, new Set());
  assert.equal(shownSteps("run-shown-1"), undefined);
  assert.notEqual(shownSteps("run-many-499"), undefined);
});
