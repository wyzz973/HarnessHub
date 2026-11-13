import assert from "node:assert/strict";
import test from "node:test";
import { RELAY_POLICY_VERSION } from "../../src/contexts/session/domain/relay/budget.js";
import { kindOf } from "../../src/contexts/session/domain/relay/narration.js";
import { renderRelay } from "../../src/contexts/session/domain/relay/packet.js";
import { readTurn, tableRedaction, turnNeeds, turnsView, type TableToolDetail } from "../../src/contexts/session/domain/table.js";
import { contentId } from "../../src/contracts/content.js";
import { snapshotHistory, snapshotTable } from "../fixtures/old-shape.js";
import { conversation, names, tool } from "../fixtures/relay-scenarios.js";

// The relay's packet and the context table read a tool call with the same rule as the protocol (domain/protocol/tools.ts): where a
// Harness reported a kind, nothing changes (the golden packets of tests/unit/relay-packet.test.ts are byte for byte what they were);
// a call that only the name table can tell, such as DeepSeek Harness's `bash` whose title is just its name, is worded by what its stored
// detail says, and as the operation of no known kind it was before when that detail is not read.

const DETAILS = {
  "run-1/d1": { input: "pwd && ls -la" }, "run-1/d2": { input: "{\n  \"file_path\": \"/w/src/cart.js\"\n}" }, "run-1/d3": { input: "{\"file_path\":\"/w/src/cart.js\",\"old_string\":\"a\"}" },
  "run-1/d5": { input: "{\n  \"pattern\": \"taxFor\"\n}" }, "run-1/d7": { input: "{\"url\":\"https://example.com/\"}" }, "run-1/d8": { input: "npm test", output: "FAIL a\nexpected 1" },
};
const TOOLS = [tool("d1", "bash", "other"), tool("d2", "read", "other"), tool("d3", "edit", "other"), tool("d4", "bash", "other"), tool("d5", "grep", "other"), tool("d6", "Brainstorm", "other"),
  tool("d7", "web_fetch", "other"), tool("d8", "bash", "other", { exitCode: 1, status: "failed" })];
function lines(language: "zh" | "en", tools = TOOLS): string[] {
  const scenario = conversation([{ input: language === "zh" ? "看看项目结构" : "Look at the project", harnessId: "dsh", reply: "ok", tools }, { input: language === "zh" ? "继续" : "Go on", harnessId: "codex" }], [], DETAILS);
  const text = renderRelay({ state: snapshotHistory(scenario.state), current: scenario.current, sources: scenario.sources, origin: false, names, details: scenario.details }).text;
  return text.split("\n").filter(line => line.startsWith("- ") && !/省略|Nothing left|没有读取|not read|按格式|Never included/u.test(line));
}

test("a DeepSeek Harness tool is worded by what its stored detail says, and as an operation of no known kind where the detail is not read", () => {
  assert.deepEqual(lines("zh"), ["- 执行 `pwd && ls -la`（没有报告退出码）", "- 读取 `/w/src/cart.js`", "- 修改 `/w/src/cart.js`", "- 其他操作 `bash`", "- 搜索 `taxFor`", "- 其他操作 `Brainstorm`",
    "- 获取 `https://example.com/`", "- 执行 `npm test` → 退出码 1"]);
  assert.deepEqual(lines("en"), ["- Ran `pwd && ls -la` (no exit code reported)", "- Read `/w/src/cart.js`", "- Edited `/w/src/cart.js`", "- Other `bash`", "- Searched `taxFor`", "- Other `Brainstorm`",
    "- Fetched `https://example.com/`", "- Ran `npm test` → exit code 1"]);
  // Without any detail read, every one of them is what it was before the name table: an operation of no known kind, quoted by its title.
  const scenario = conversation([{ input: "x", harnessId: "dsh", reply: "ok", tools: TOOLS }, { input: "y", harnessId: "codex" }]);
  const text = renderRelay({ state: snapshotHistory(scenario.state), current: scenario.current, sources: scenario.sources, origin: false, names, details: new Map() }).text;
  assert.deepEqual(text.split("\n").filter(line => /^- Other /u.test(line)), ["- Other `bash`", "- Other `read`", "- Other `edit`", "- Other `bash`", "- Other `grep`", "- Other `Brainstorm`", "- Other `web_fetch`", "- Other `bash` (failed)"]);
  // The packet's policy changed with its words.
  assert.equal(RELAY_POLICY_VERSION, "relay/1-mvp.9");
});

test("a failing command of such a Harness now has its output tail carried, as any Harness's failing command does", () => {
  const scenario = conversation([{ input: "x", harnessId: "dsh", reply: "ok", tools: TOOLS }, { input: "y", harnessId: "codex" }], [], DETAILS);
  const text = renderRelay({ state: snapshotHistory(scenario.state), current: scenario.current, sources: scenario.sources, origin: false, names, details: scenario.details }).text;
  assert.match(text, /DeepSeek Harness recorded output|DeepSeek Harness 记录的输出|Output recorded by DeepSeek Harness/u); assert.match(text, /expected 1/u);
});

test("the relay and the table take a tool's kind from the one shared rule", () => {
  const family = (title: string, kind: string, name?: string) => kindOf(tool("t", title, kind, name === undefined ? {} : { name }));
  assert.deepEqual([family("bash", "other"), family("read", "other"), family("edit", "other"), family("grep", "other"), family("web_search", "other"), family("mcp__a__b", "other"), family("Brainstorm", "other")],
    ["execute", "read", "change", "search", "search", "mcp", "other"]);
  // What the Harness reported is what it is, as before.
  assert.deepEqual([family("x", "execute"), family("x", "edit"), family("x", "delete"), family("x", "task"), family("x", "think", "Task"), family("x", "fetch")], ["execute", "change", "change", "subagent", "think", "fetch"]);
});

test("the table keeps back the output of a DeepSeek Harness command that touches a credential file, which it could not tell before", () => {
  const ref = (id: string) => ({ id: contentId("content-" + id), name: id + ".json", mediaType: "application/json", kind: "file" as const, bytes: 10, sha256: "5".repeat(64) });
  const state = snapshotTable(conversation([{ input: "x", harnessId: "dsh", reply: "ok", tools: [tool("c1", "bash", "other", { detail: ref("c1") }), tool("c2", "bash", "other", { detail: ref("c2") })] }, { input: "y", harnessId: "codex" }]).state);
  const details = new Map<string, TableToolDetail>([["run-1/c1", { input: "cat .env", output: "SECRET_VALUE_1234567890" }], ["run-1/c2", { input: "ls", output: "a.txt" }]]);
  const redaction = tableRedaction([]);
  assert.match(readTurn(state, 1, { part: "output", tool: 1 }, details, redaction).text, /^Withheld: this tool call touches a credential file/u);
  assert.equal(readTurn(state, 1, { part: "output", tool: 2 }, details, redaction).text, "a.txt");
  // A command is a tool call of the Turn, and a change tool's detail is what the directory reads; the other kinds are not read for it.
  assert.equal(turnsView(state, 1, 1, details, redaction).lines[0]!.tools, 2); assert.deepEqual(turnNeeds(state, 1, "output", 1).map(item => item.toolId), ["c1"]);
});
