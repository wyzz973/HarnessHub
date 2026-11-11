import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTool, errorClass, itemStatus, modelLabel, normalizeTool, planFromInput, shellWords, stopReason, toolFamily, toolOutcome, turnUsage, unwrapShell,
  type ToolDetailInput,
} from "../../src/contexts/session/domain/protocol/index.js";
import type { ItemStatus, WorkItem } from "../../src/contracts/protocol.js";
import { ITEM_STATUSES } from "../../src/contracts/protocol.js";
import type { NativeUsage } from "../../src/contracts/control.js";
import type { PublicTool } from "../../src/contracts/session.js";
import { TRIAL, WORKSPACE, trialTools } from "../fixtures/protocol-trial.js";

// The one rule that turns a Harness's tool call into a protocol item (docs/proposals/protocol/hub-protocol.html §7), checked against the
// real events of five Harnesses (tests/fixtures/protocol/trial-2026-11-11.json) and against the other names the table knows.

/** One line per item: its type, state and what it names; the workspace's own path is left off so the table reads. */
function show(item: WorkItem): string {
  const here = (text: string) => text.replaceAll(WORKSPACE, "");
  switch (item.type) {
    case "command": return `command ${item.status} ${item.command}`;
    case "file_read": return `file_read ${item.status} ${item.path === null ? "∅" : here(item.path)}`;
    case "file_change": return `file_change ${item.status} ` + item.changes.map(file => `${file.op} ${here(file.path)}${file.added === undefined ? "" : ` +${file.added} -${file.removed}`}`).join(", ");
    case "search": return `search ${item.status} ${item.scope} ${item.query ?? "∅"}`;
    case "web": return `web ${item.status} ${item.action} ${item.query ?? item.url ?? "∅"}`;
    case "mcp_tool": return `mcp_tool ${item.status} ${item.hub ? "hub " : ""}${item.server}/${item.tool}`;
    case "tool": return `tool ${item.status} ${item.name}`;
    case "subagent": return `subagent ${item.status} ${item.title}`;
  }
}
function item(tool: Partial<PublicTool> & { readonly title: string }, detail: ToolDetailInput | null = null, turn: "going" | "ended" | "cancelled" = "ended"): WorkItem {
  const result = normalizeTool({ id: "t", status: "completed", ...tool }, { seq: 0, detail, turn });
  assert.ok(result.row, "expected a row of work for " + tool.title);
  return result.item;
}
const shown = (tool: Partial<PublicTool> & { readonly title: string }, detail: ToolDetailInput | null = null) => show(item(tool, detail));

// ---------------------------------------------------------------------------------------------------------------------
// The trial: every tool call of the five Harnesses
// ---------------------------------------------------------------------------------------------------------------------

/** What each Turn of the trial's tool calls is, by its number in the conversation. */
const TRIAL_ITEMS: Readonly<Record<number, readonly string[]>> = {
  // DeepSeek Harness: the title is only the tool's name (`bash`, `read`, kind `other`); the objects are in the stored input.
  1: ["command completed pwd && ls -la", "command completed cat package.json; echo '---'; git log --oneline -10; echo '---'; git status",
    "command completed find src test -type f | sort; echo '---'; find src test -type d | sort", "command completed wc -l src/*.js test/*.js",
    "file_read completed src/cart.js", "file_read completed src/money.js", "file_read completed src/rates.js", "file_read completed src/tax.js",
    "file_read completed test/cart.test.js", "file_read completed test/money.test.js", "file_read completed test/tax.test.js",
    "command completed npm test 2>&1 | tail -40", "command completed npm test 2>&1 | grep -E \"^(# (pass|fail|tests)|✔|✖)\" | head -30"],
  // OpenCode: the title is the command, kind `execute`, name `shell`.
  3: ["command completed cat package.json && wc -l src/* test/* && node --test 2>&1 | tail -5", "command completed cat src/money.js src/rates.js src/tax.js src/cart.js"],
  // Claude Code: a tool search is a tool of its own; the Hub's own tool is told by its name, `mcp__harnesshub__hub_turns`.
  4: ["tool completed ToolSearch", "tool completed ToolSearch"],
  7: ["tool completed ToolSearch", "mcp_tool completed hub harnesshub/hub_turns"],
  8: ["command completed git status --short && npm test 2>&1 | tail -60", "command completed node --test 2>&1 | grep -E '^(✔|✖|ℹ)'"],
  11: ["command completed git status --short && echo \"---DIFF---\" && git diff && echo \"---FILE---\" && cat -n src/cart.js && echo \"---TEST---\" && node --test 2>&1 | grep -E '^(✔|✖|ℹ (tests|pass|fail))'"],
  // Codex: `/bin/zsh -lc '…'` is the shell around the command; the Hub's tools are `harnesshub/hub_read_turn` (kind `mcp`).
  9: ["command completed rg -n 'currentInput|hub_read_turn|hub_search|完整|交接' /Users/me/.codex/memories/MEMORY.md", "mcp_tool completed hub harnesshub/hub_read_turn",
    "command completed sed -n '60,78p' /Users/me/.codex/memories/MEMORY.md", "mcp_tool completed hub harnesshub/hub_read_turn", "mcp_tool completed hub harnesshub/hub_read_turn",
    "mcp_tool completed hub harnesshub/hub_search", "mcp_tool completed hub harnesshub/hub_read_turn", "mcp_tool completed hub harnesshub/hub_search",
    "mcp_tool completed hub harnesshub/hub_read_turn", "command completed sed -n '110,117p' /Users/me/.codex/memories/MEMORY.md"],
  10: ["command completed pwd", "command completed git status --short",
    "command failed rg --files --hidden -g AGENTS.md -g '!node_modules' -g '!.git' . /Users/me/.cache/harnesshub-acceptance 2>/dev/null",
    "command completed cat package.json src/cart.js src/tax.js src/rates.js test/cart.test.js",
    "command completed for task_dir in / /Users /Users/me /Users/me/.cache /Users/me/.cache/harnesshub-acceptance /Users/me/.cache/harnesshub-acceptance/trial; do if [ -f \"$task_dir/AGENTS.md\" ]; then printf '\\n%s\\n' \"$task_dir/AGENTS.md\"; cat \"$task_dir/AGENTS.md\"; fi; done",
    "command failed node --test --test-name-pattern='total taxes the amount after the discount' test/cart.test.js",
    "file_change completed modify src/cart.js +2 -2", "command completed git diff -- src/cart.js", "command completed git status --short", "command completed git diff --check", "command failed npm test"],
};

test("every tool call of the trial's five Harnesses becomes the item it is, whichever way its Harness spells it", () => {
  for (const run of TRIAL.runs) {
    const { tools, heads } = trialTools(run);
    const items = tools.map((tool, seq) => {
      const result = normalizeTool(tool, { seq, detail: tool.detail === undefined ? null : heads.get(tool.detail.id) ?? null, turn: "ended" });
      assert.ok(result.row); assert.equal(result.item.seq, seq); assert.equal(result.item.id, tool.id);
      return result.item;
    });
    assert.deepEqual(items.map(show), TRIAL_ITEMS[run.n] ?? [], "Turn " + run.n + " (" + run.harnessId + ")");
  }
});

test("a command that Codex ran in a shell is told without the shell, with its native spelling kept; one the Hub cannot read with certainty is left as it was", () => {
  const { tools, heads } = trialTools(TRIAL.runs.find(run => run.n === 10)!);
  const items = tools.map((tool, seq) => normalizeTool(tool, { seq, detail: tool.detail === undefined ? null : heads.get(tool.detail.id)!, turn: "ended" })).map(result => result.row ? result.item : assert.fail());
  const first = items[0]!;
  assert.ok(first.type === "command"); assert.equal(first.command, "pwd"); assert.equal(first.raw, "/bin/zsh -lc pwd"); assert.equal(first.exitCode, 0);
  assert.equal(first.cwd, "/Users/me/.cache/harnesshub-acceptance/trial/workspace");
  // The quoting of this one was checked against Python's POSIX shlex: three words, the third is the script.
  const nested = items[4]!;
  assert.ok(nested.type === "command"); assert.match(nested.raw ?? "", /^\/bin\/zsh -lc 'for task_dir in /u); assert.ok(nested.command.endsWith("; fi; done"));
  // A command that failed: its exit code, and the state the Harness gave.
  const failed = items[2]!;
  assert.ok(failed.type === "command"); assert.equal(failed.status, "failed"); assert.equal(failed.exitCode, 1);
  // A command of a Harness that wraps nothing carries no native spelling.
  const plain = normalizeTool(trialTools(TRIAL.runs.find(run => run.n === 3)!).tools[0]!, { seq: 0, detail: null, turn: "ended" });
  assert.ok(plain.row && plain.item.type === "command"); assert.equal(plain.item.raw, undefined);
});

test("a call is told by its title when its detail is not stored yet: the object is empty, never invented", () => {
  // DeepSeek Harness: the title is only the tool's name, so without the detail there is a command and no command text, a read and no path.
  const bash = item({ title: "bash", kind: "other" }), read = item({ title: "read", kind: "other" });
  assert.ok(bash.type === "command" && bash.command === "" && bash.nativeName === "bash"); assert.ok(read.type === "file_read" && read.path === null);
  // A Harness that writes the command as the title keeps it.
  assert.equal(shown({ title: "npm test", kind: "execute", name: "Bash" }), "command completed npm test");
  assert.equal(shown({ title: "`npm test`", kind: "execute" }), "command completed npm test");
  // Placeholders a Driver writes when the Harness gave none are no command.
  assert.equal(shown({ title: "命令", kind: "execute" }), "command completed ");
  assert.equal(shown({ title: "Terminal", kind: "execute", name: "Bash" }), "command completed ");
});

// ---------------------------------------------------------------------------------------------------------------------
// The name table
// ---------------------------------------------------------------------------------------------------------------------

test("the name table: a call a Harness gave no kind is told by its name, its title's prefix or a title that is only a name", () => {
  const detail = (input: string): ToolDetailInput => ({ input });
  const rows: readonly (readonly [Partial<PublicTool> & { readonly title: string }, ToolDetailInput | null, string])[] = [
    // commands
    [{ title: "shell", name: "shell" }, detail("ls -la"), "command completed ls -la"], [{ title: "terminal: rm -r x" }, null, "command completed rm -r x"],
    [{ title: "exec: git status", kind: "execute" }, null, "command completed git status"], [{ title: "run", name: "run_command" }, detail("{\"command\":\"make\"}"), "command completed make"],
    // reads
    [{ title: "Read src/a.ts (1 - 20)", kind: "read", name: "Read" }, null, "file_read completed src/a.ts"], [{ title: "read_file", name: "read_file" }, detail("{\n  \"path\": \"/w/src/b.ts\"\n}"), "file_read completed /w/src/b.ts"],
    [{ title: "src/c.ts", kind: "read" }, null, "file_read completed src/c.ts"], [{ title: "查看图片 shot.png", name: "view_image", kind: "image" }, { locations: ["/w/shot.png"] }, "file_read completed /w/shot.png"],
    // changes
    [{ title: "Write src/new.ts", name: "Write", kind: "edit" }, null, "file_change completed modify src/new.ts"], [{ title: "Edit `src/a.ts`", kind: "edit" }, null, "file_change completed modify src/a.ts"],
    [{ title: "edit", name: "edit" }, detail("{\"file_path\":\"/w/x.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}"), "file_change completed modify /w/x.ts"],
    [{ title: "write", name: "write" }, detail("{\"file_path\":\"/w/big.ts\",\"content\":\"" + "x".repeat(5000)), "file_change completed modify /w/big.ts"],
    [{ title: "Delete old.ts", kind: "delete" }, null, "file_change completed delete old.ts"], [{ title: "修改 a.ts, b.ts 等 5 个文件", name: "apply_patch", kind: "edit" }, null, "file_change completed "],
    [{ title: "x", name: "apply_patch", kind: "edit" }, { files: [{ path: "a/b.ts", op: "create", added: 3, removed: 0 }, { path: "c.ts", op: "delete", added: 0, removed: 4 }] }, "file_change completed create a/b.ts +3 -0, delete c.ts +0 -4"],
    // searches: inside files or by name
    [{ title: "grep -i \"taxFor\" src", kind: "search", name: "Grep" }, null, "search completed content taxFor"], [{ title: "grep", name: "grep" }, detail("{\"pattern\":\"rateFor\",\"path\":\"src\"}"), "search completed content rateFor"],
    [{ title: "Find `*.ts`", kind: "search", name: "Glob" }, null, "search completed files *.ts"], [{ title: "ls", name: "LS" }, detail("{\"path\":\"/w\"}"), "search completed files ∅"],
    [{ title: "grep writeCsv", kind: "search" }, null, "search completed unknown writeCsv"],
    // the web: a Harness's `search` of the web (Codex) and its `fetch` are told by name
    [{ title: "搜索：hh protocol", kind: "search", name: "web_search" }, detail("hh protocol"), "web completed search hh protocol"], [{ title: "\"hh protocol\"", kind: "fetch", name: "WebSearch" }, null, "web completed search hh protocol"],
    [{ title: "Fetch https://example.com/a", kind: "fetch", name: "WebFetch" }, detail("{\"url\":\"https://example.com/a\",\"prompt\":\"x\"}"), "web completed fetch https://example.com/a"], [{ title: "web_fetch", name: "web_fetch" }, detail("{\"url\":\"https://e.org/\"}"), "web completed fetch https://e.org/"],
    // MCP: three spellings of a server and a tool, and the Hub's own tools in the fourth
    [{ title: "mcp__github__list_issues", name: "mcp__github__list_issues" }, null, "mcp_tool completed github/list_issues"], [{ title: "fs.read", name: "fs/read_file", kind: "mcp" }, null, "mcp_tool completed fs/read_file"],
    [{ title: "harnesshub.hub_search" }, null, "mcp_tool completed hub harnesshub/hub_search"], [{ title: "harnesshub_hub_turns", name: "harnesshub_hub_turns" }, null, "mcp_tool completed hub harnesshub/hub_turns"],
    // sub-tasks: whatever kind the Harness filed them under
    [{ title: "Run echo SUB-OK", kind: "think", name: "Agent" }, null, "subagent completed Run echo SUB-OK"], [{ title: "delegate: audit the tests", kind: "execute" }, null, "subagent completed audit the tests"],
    [{ title: "子 Agent · Dewey", kind: "subagent", name: "codex-subagent" }, null, "subagent completed Dewey"], [{ title: "sessions_spawn: x", kind: "subagent", name: "sessions_spawn" }, null, "subagent completed x"],
    // nothing knows these: shown by their own names
    [{ title: "ToolSearch", kind: "other", name: "ToolSearch" }, null, "tool completed ToolSearch"], [{ title: "Brainstorm" }, null, "tool completed Brainstorm"], [{ title: "等待 3 秒", kind: "other", name: "sleep" }, null, "tool completed sleep"],
    [{ title: "Reading all the things in the repository" }, null, "tool completed Reading all the things in the repository"], [{ title: "think hard", kind: "think" }, null, "tool completed think hard"],
  ];
  for (const [tool, detail, expected] of rows) assert.equal(shown(tool, detail), expected, JSON.stringify(tool));
});

test("a task list is the Turn's plan and not a row of work; one whose steps cannot be read exactly stays visible", () => {
  for (const tool of [{ title: "TodoWrite", name: "TodoWrite" }, { title: "3 todos", name: "todowrite" }, { title: "todo_write" }, { title: "update_plan", name: "update_plan" }]) {
    assert.deepEqual(normalizeTool({ id: "t", status: "completed", ...tool }, { seq: 0, detail: null, turn: "ended" }), { row: false, reason: "plan" }, tool.title);
  }
  const todos = JSON.stringify({ todos: [{ content: "read", status: "completed", priority: "high" }, { content: "write", status: "in_progress" }, { content: "test", status: "pending" }] });
  assert.deepEqual(planFromInput(todos), [{ text: "read", status: "completed" }, { text: "write", status: "in_progress" }, { text: "test", status: "pending" }]);
  assert.equal(planFromInput(JSON.stringify({ todos: [{ content: "x", status: "cancelled" }] })), null, "a step state the plan does not have is not made up");
  assert.equal(planFromInput(todos.slice(0, 40)), null); assert.equal(planFromInput("not json"), null); assert.equal(planFromInput(undefined), null);
  // What the Harness itself filed as something it does is that: a command that is called `todo` is a command.
  assert.equal(shown({ title: "todo", kind: "execute", name: "todo" }, { input: "todo list" }), "command completed todo list");
});

test("a tool's family is what the Harness reported, and the name table only fills in where it reported none", () => {
  const family = (tool: Partial<PublicTool> & { readonly title: string }) => toolFamily({ status: "completed", ...tool });
  // The Harness's own kind wins, as the relay has always trusted it.
  assert.equal(family({ title: "x", kind: "execute", name: "Read" }), "execute"); assert.equal(family({ title: "x", kind: "edit" }), "change"); assert.equal(family({ title: "x", kind: "task" }), "subagent");
  assert.equal(family({ title: "x", kind: "think", name: "Task" }), "think", "the relay never narrates what the Harness filed as thinking");
  // Where it reported none, the name tells.
  assert.equal(family({ title: "bash" }), "execute"); assert.equal(family({ title: "x", kind: "other", name: "Grep" }), "search"); assert.equal(family({ title: "x", kind: "image", name: "view_image" }), "read");
  assert.equal(family({ title: "mcp__a__b" }), "mcp"); assert.equal(family({ title: "x", kind: "other", name: "TodoWrite" }), "other"); assert.equal(family({ title: "Brainstorm" }), "other");
  assert.deepEqual(classifyTool({ title: "bash", status: "completed" }), { family: "execute", via: "name" }); assert.deepEqual(classifyTool({ title: "x", status: "completed", kind: "read" }), { family: "read", via: "kind" });
  assert.deepEqual(classifyTool({ title: "Brainstorm", status: "completed" }), { family: "other", via: "none" });
  // A word that is also a name of Object.prototype is no tool.
  assert.equal(family({ title: "constructor", name: "constructor" }), "other"); assert.equal(family({ title: "x", kind: "constructor" }), "other");
});

// ---------------------------------------------------------------------------------------------------------------------
// States and exit codes
// ---------------------------------------------------------------------------------------------------------------------

test("every Harness's word for a state maps to the eight states; a word nobody knows is unknown, never completed", () => {
  const words: Readonly<Record<ItemStatus, readonly string[]>> = {
    pending: ["pending", "queued"], running: ["running", "in_progress", "inProgress", "in-progress", "started"], waiting: ["waiting", "awaiting_approval"],
    completed: ["completed", "success", "succeeded", "done", "ok", "Completed"], failed: ["failed", "error", "errored"], declined: ["declined", "rejected", "denied", "blocked"],
    cancelled: ["cancelled", "canceled", "interrupted", "aborted", "stopped"], unknown: ["", "weird", "completed-ish", "null"],
  };
  assert.deepEqual(Object.keys(words).sort(), [...ITEM_STATUSES].sort());
  for (const [status, list] of Object.entries(words)) for (const word of list) assert.equal(itemStatus(word), status, JSON.stringify(word));
  // How the relay's narration and the table read the same words: done, failed (including declined and stopped), or not finished.
  assert.deepEqual(["completed", "failed", "error", "declined", "rejected", "cancelled", "pending", "in_progress", "weird"].map(status => toolOutcome({ status })),
    ["done", "failed", "failed", "failed", "failed", "failed", "open", "open", "open"]);
});

test("a command that exited with anything but 0 failed; a call still open when its Turn is over did not finish", () => {
  assert.equal(item({ title: "make", kind: "execute", status: "completed", exitCode: 2 }).status, "failed"); assert.equal(item({ title: "make", kind: "execute", status: "completed", exitCode: 0 }).status, "completed");
  assert.equal(item({ title: "make", kind: "execute", status: "declined", exitCode: 1 }).status, "declined");
  // Only a command has an exit code to say it failed.
  assert.equal(item({ title: "Read a", kind: "read", status: "completed", exitCode: 1 }).status, "completed");
  for (const status of ["pending", "in_progress"]) {
    assert.equal(item({ title: "ls", kind: "execute", status }, null, "going").status, status === "pending" ? "pending" : "running");
    assert.equal(item({ title: "ls", kind: "execute", status }, null, "ended").status, "unknown", "an Harness that never said how it ended is not taken to have completed");
    assert.equal(item({ title: "ls", kind: "execute", status }, null, "cancelled").status, "cancelled");
  }
  assert.equal(item({ title: "ls", kind: "execute", status: "weird" }, null, "going").status, "unknown");
});

test("a native parent is kept as the call's parent and its stored detail as the item's detail", () => {
  const { tools } = trialTools(TRIAL.runs.find(run => run.n === 3)!);
  const result = normalizeTool({ ...tools[0]!, parentId: "agent-1" }, { seq: 4, detail: null, turn: "ended" });
  assert.ok(result.row); assert.equal(result.item.parentId, "agent-1"); assert.deepEqual(result.item.detail, tools[0]!.detail); assert.equal(result.item.seq, 4);
});

// ---------------------------------------------------------------------------------------------------------------------
// The shell around a command
// ---------------------------------------------------------------------------------------------------------------------

test("the shell around a command is taken off only when its quoting is read with certainty", () => {
  const cases: readonly (readonly [string, string, string | undefined])[] = [
    ["/bin/zsh -lc 'npm test'", "npm test", "/bin/zsh -lc 'npm test'"], ["bash -lc \"echo 'a b'\"", "echo 'a b'", undefined], ["sh -c pwd", "pwd", undefined], ["/usr/bin/bash -c 'cd /x && make'", "cd /x && make", undefined],
    ["zsh -l -c 'ls'", "ls", undefined], ["/bin/zsh -lc 'echo \"hi $USER\"'", "echo \"hi $USER\"", undefined], ["/bin/zsh -lc \"echo \\\"hi\\\" \\$HOME\"", "echo \"hi\" $HOME", undefined],
    ["/bin/zsh -lc \"rg -n 'a|b' src\"", "rg -n 'a|b' src", undefined],
    // the shell's quoting of a script with single quotes: the words that touch are one word
    ["/bin/zsh -lc \"rg -g '\"'!node_modules'\"' .\"", "rg -g '!node_modules' .", undefined],
  ];
  for (const [text, command, raw] of cases) assert.deepEqual(unwrapShell(text), { command, raw: raw ?? text }, text);
  // Left as they were: not a shell, no script, more words than a shell and its script, an expansion or operator outside quotes, a quote that never closes.
  for (const text of ["ls -la", "npm test", "bash script.sh", "bash -lc", "bash -lc 'a' 'b'", "bash -c $(pwd)", "bash -c 'oops", "bash -lc \"echo $HOME\"", "cd /x && bash -lc 'ls'", "env bash -lc ls", "/bin/zsh -lc ''", "bash -x 'ls'", "bash -lc 'a'; rm -rf /"])
    assert.deepEqual(unwrapShell(text), { command: text }, text);
  assert.deepEqual(shellWords("a 'b c' \"d e\" f\\ g"), ["a", "b c", "d e", "f g"]); assert.equal(shellWords("a | b"), null); assert.equal(shellWords("a \"b"), null); assert.equal(shellWords("a\\"), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// Models, usage, stop reasons, errors
// ---------------------------------------------------------------------------------------------------------------------

test("a model's name: the catalog's when the Hub has one, else the native spelling made readable", () => {
  const label = (harnessId: string, native: string, catalog?: string | null) => modelLabel(harnessId, native, catalog).label;
  assert.equal(label("dsh", "[\"deepseek-official\",\"deepseek-flash\"]"), "DeepSeek Flash"); assert.equal(label("opencode", "opencode/glm-5.3-flash-free"), "GLM 5.3 Flash Free");
  assert.equal(label("hermes", "deepseek:deepseek-flash"), "DeepSeek Flash"); assert.equal(label("claude", "claude-opus-5-5"), "Claude Opus 5.5"); assert.equal(label("claude", "claude-3-5-sonnet-20241022"), "Claude 3.5 Sonnet");
  assert.equal(label("codex", "gpt-5.3-codex"), "GPT 5.3 Codex"); assert.equal(label("opencode", "openai/o3-mini"), "o3 Mini"); assert.equal(label("opencode", "deepseek/deepseek-v4-flash"), "DeepSeek V4 Flash");
  assert.equal(label("claude", "opus[1m]"), "Opus 1M"); assert.equal(label("opencode", "ollama/llama3:8b"), "Llama3:8b"); assert.equal(label("hermes", "openrouter:anthropic/claude-sonnet-4.5"), "Claude Sonnet 4.5");
  // The catalog's name wins, and the native spelling is the identity.
  assert.deepEqual(modelLabel("claude", "opus", "Opus 5.5"), { id: "opus", label: "Opus 5.5", vendor: "Anthropic" });
  assert.deepEqual(modelLabel("opencode", "opencode/glm-5.3-flash-free"), { id: "opencode/glm-5.3-flash-free", label: "GLM 5.3 Flash Free", vendor: "Zhipu AI" });
  // Nothing readable is left out: whatever was given is shown rather than nothing.
  assert.equal(label("x", "[]"), "[]"); assert.equal(label("x", "constructor"), "Constructor"); assert.equal(modelLabel("x", "m".repeat(400)).id.length, 256);
});

const turn = (over: NonNullable<NativeUsage["turn"]>): NativeUsage => ({ turn: over });
test("usage is read in one meaning for every Harness: the input contains the cache, the output contains the reasoning", () => {
  const usageOf = (n: number) => { const run = TRIAL.runs.find(entry => entry.n === n)!; return turnUsage(run.harnessId, run.usage as NativeUsage, "completed"); };
  // Codex's input already contains its cached part (its total is input + output); Claude Code's leaves out what was read from and written to the cache (its total is all four).
  assert.deepEqual(usageOf(9), { completeness: "complete", input: 356323, cachedInput: 330240, output: 1935, context: { used: 63647, size: 828400 } });
  assert.deepEqual(usageOf(4), { completeness: "complete", input: 4 + 46940 + 46383, cachedInput: 46940, output: 1248, context: { used: 60329, size: 1000000 }, cost: { amount: 0.4058855, currency: "USD", scope: "session" } });
  assert.deepEqual(usageOf(6), { completeness: "complete", input: 2 + 59424 + 2165, cachedInput: 59424, output: 681, context: { used: 62272, size: 1000000 }, cost: { amount: 0.4487183, currency: "USD", scope: "session" } });
  // OpenCode reports its reasoning beside the output, and its cache beside the input.
  assert.deepEqual(usageOf(3), { completeness: "complete", input: 20774 + 34816, cachedInput: 34816, output: 684 + 368, context: { used: 19761, size: 200000 }, cost: { amount: 0, currency: "USD", scope: "session" } });
  // DeepSeek Harness reports only its context window; Hermes reports its session's running total, which is not a Turn's: neither gives numbers a Turn can be told by.
  assert.deepEqual(usageOf(1), { completeness: "unavailable", context: { used: 15909, size: 1048576 } });
  assert.deepEqual(usageOf(5), { completeness: "unavailable", context: { used: 21687, size: 1048576 } });
  // Each Harness's own total agrees with the meaning above (the evidence of the table in usage.ts).
  for (const run of TRIAL.runs) {
    const native = (run.usage as NativeUsage).turn;
    if (native === undefined || run.harnessId === "hermes") continue;
    const inside = run.harnessId === "codex";
    assert.equal(native.total, inside ? native.input! + native.output! : native.input! + native.output! + (native.cachedInput ?? 0) + (native.cacheWrite ?? 0) + (run.harnessId === "opencode" ? native.reasoning! : 0), "Turn " + run.n);
  }
});

test("a usage that may not cover its Turn is partial, one the Harness did not give is unavailable, and no number is made up", () => {
  const codex = turn({ input: 100, output: 10, cachedInput: 40 });
  assert.equal(turnUsage("codex", codex, "completed").completeness, "complete");
  for (const status of ["failed", "cancelled", "running", "unknown", "settling"] as const) assert.equal(turnUsage("codex", codex, status).completeness, "partial", status);
  assert.deepEqual(turnUsage("codex", turn({ input: 100 }), "completed"), { completeness: "partial", input: 100 });
  assert.deepEqual(turnUsage("codex", turn({}), "completed"), { completeness: "unavailable" }); assert.deepEqual(turnUsage("codex", undefined, "completed"), { completeness: "unavailable" });
  assert.deepEqual(turnUsage("codex", { context: { used: 5 }, cost: { amount: 1, currency: "USD", scope: "turn" } }, "completed"), { completeness: "unavailable", context: { used: 5 }, cost: { amount: 1, currency: "USD", scope: "turn" } });
  assert.deepEqual(turnUsage("somebody-new", codex, "completed"), { completeness: "unavailable" }, "a Harness whose numbers are not known is not read");
  assert.deepEqual(turnUsage("constructor", codex, "completed"), { completeness: "unavailable" });
});

test("what a Turn ended on: the Harness's reason, the Runtime's own causes, and nothing for a Turn still going", () => {
  const stop = (over: Partial<Parameters<typeof stopReason>[0]> & { readonly status: Parameters<typeof stopReason>[0]["status"] }) => stopReason({ backend: null, error: null, cancelRequested: false, ...over });
  const reason = (status: "completed" | "failed" | "cancelled", why: string) => ({ backend: { status, reason: why } });
  assert.equal(stop({ status: "running" }), undefined); assert.equal(stop({ status: "settling" }), undefined); assert.equal(stop({ status: "queued" }), undefined); assert.equal(stop({ status: "preparing" }), undefined);
  assert.equal(stop({ status: "completed", ...reason("completed", "end_turn") }), "end_turn"); assert.equal(stop({ status: "completed", ...reason("completed", "completed") }), "end_turn");
  assert.equal(stop({ status: "completed", ...reason("completed", "cleared") }), "cleared");
  assert.equal(stop({ status: "failed", backend: { status: "failed", reason: "max_tokens" } }), "max_tokens"); assert.equal(stop({ status: "failed", backend: { status: "failed", reason: "max_turn_requests" } }), "max_steps");
  assert.equal(stop({ status: "failed", backend: { status: "failed", reason: "refusal" } }), "refusal");
  assert.equal(stop({ status: "failed", error: { code: "NATIVE_QUOTA_EXCEEDED", message: "x" } }), "error"); assert.equal(stop({ status: "failed" }), "unknown");
  assert.equal(stop({ status: "cancelled", cancelRequested: true, backend: { status: "cancelled", reason: "interrupted" } }), "user_stopped");
  assert.equal(stop({ status: "cancelled", cancelRequested: true, error: { code: "RUN_TIMEOUT", message: "x" } }), "budget"); assert.equal(stop({ status: "cancelled", error: { code: "WAIT_EXPIRED", message: "x" } }), "budget");
  assert.equal(stop({ status: "cancelled", error: { code: "OWNER_ENDED", message: "x" } }), "unknown", "the Hub does not say who stopped a Turn nobody asked to stop");
  assert.equal(stop({ status: "cancelled" }), "unknown"); assert.equal(stop({ status: "unknown" }), "unknown");
});

test("a failure's class is told from its code, and a code of no class is unknown", () => {
  const classes = { NATIVE_AUTH_REQUIRED: "auth", HARNESS_AUTH_REQUIRED: "auth", NATIVE_QUOTA_EXCEEDED: "quota", NATIVE_RATE_LIMITED: "rate_limit", MODEL_RATE_LIMIT: "rate_limit", NATIVE_CONTEXT_EXCEEDED: "context_overflow",
    CONTEXT_WINDOW_EXCEEDED: "context_overflow", NATIVE_CONNECTION_FAILED: "network", PROCESS_EXITED: "harness_crash", MODEL_POLICY_REFUSED: "invalid_request", UNSUPPORTED_PERMISSION: "permission", SOMETHING_ELSE: "unknown" } as const;
  for (const [code, expected] of Object.entries(classes)) assert.equal(errorClass(code), expected, code);
});
