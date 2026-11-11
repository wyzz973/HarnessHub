import assert from "node:assert/strict";
import test from "node:test";
import { contentId, type ContentRef } from "../../src/contracts/content.js";
import { SessionError, sessionId, type PublicTool } from "../../src/contracts/session.js";
import { TABLE_LIMITS } from "../../src/contracts/table.js";
import {
  directoryNeeds, directoryRange, pageOf, readTurn, searchNeeds, searchTurns, tableRedaction, turnNeeds, turnsView, type TableToolDetail,
} from "../../src/contexts/session/domain/table.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { conversation, tool } from "../fixtures/relay-scenarios.js";

// The context table's read model (src/contexts/session/domain/table.ts): a directory of the Turns, one Turn in full and in
// pieces, a search; pure, from public snapshots and the tool details a caller read. The Gateway's use of it over HTTP, with a
// real store and a real tool process, is in tests/integration/table-api.test.ts.

/** A secret-shaped value built at run time, so that no source line holds one whole. */
const TOKEN = "gh" + "p_" + "A1b2C3d4E5".repeat(4);
const KNOWN = "correct-horse-" + "battery-staple";
const diff = (path: string, created: boolean, added: number, removed: number) => (created ? "--- /dev/null\n" : "--- a/" + path + "\n") + "+++ b/" + path + "\n@@ -1 +1 @@\n" + "+line\n".repeat(added) + "-line\n".repeat(removed);
const ref = (id: string, bytes = 100): ContentRef => ({ id: contentId("content-" + id), name: "tool-" + id + ".json", mediaType: "application/json", kind: "file", bytes, sha256: "a".repeat(64) });
/** A tool call whose detail is stored (as a content reference). */
const stored = (id: string, title: string, kind: string, extra: Partial<PublicTool> = {}): PublicTool => tool(id, title, kind, { detail: ref(id), ...extra });

const OUTPUT = Array.from({ length: 60 }, (_, index) => "line " + (index + 1) + " of the test run").join("\n") + "\nexport GITHUB_TOKEN=" + TOKEN + "\nknown value " + KNOWN + "\nFAIL tests/a.test.ts\n";
const USER1 = "Add per-currency totals to the invoice export: print each currency's total at the end of the CSV, and add tests for it.";
const REPLY1 = "Per-currency totals are in. " + "The export now sums by currency. ".repeat(8) + "npm test fails on one rounding case.";

/** Three Turns: Claude Code's (reads, a failing run, three edits of two files, a credential read, reasoning), Codex's (a plan, a sub-agent), and the one running now. */
function scenario() {
  const { state } = conversation([
    { input: USER1, harnessId: "claude", model: "claude-opus-5-5", thinking: true, reply: REPLY1, tools: [
      stored("r1", "Read src/a.ts", "read"), stored("x1", "`pnpm test`", "execute", { exitCode: 1, status: "failed", name: "Bash" }),
      stored("e1", "Edit src/a.ts", "edit"), stored("e2", "Edit src/a.ts", "edit"), stored("e3", "Write src/b.ts", "edit"),
      stored("th", "Thinking", "think"), stored("c1", "`cat .env`", "execute", { exitCode: 0 })] },
    { input: "Now the second pass, with a plan.", harnessId: "codex", reply: "Second pass done.", plan: { explanation: "Two steps", entries: [{ content: "Read the export", status: "completed" }, { content: "Fix rounding", status: "in_progress" }, { content: "Run all tests", status: "pending" }] },
      tools: [stored("s1", "Sub-agent: explore", "subagent"), stored("s2", "Read src/c.ts", "read", { parentId: "s1" }), tool("n1", "Edit src/d.ts", "edit")] },
    { input: "And the third, which is running.", harnessId: "claude" },
  ]);
  const details = new Map<string, TableToolDetail>(Object.entries({
    "run-1/r1": { locations: ["src/a.ts"] }, "run-1/x1": { input: "pnpm test", output: OUTPUT, locations: ["/work"] },
    "run-1/e1": { locations: ["src/a.ts"], diff: diff("src/a.ts", false, 3, 1) }, "run-1/e2": { locations: ["src/a.ts"], diff: diff("src/a.ts", false, 2, 0) },
    "run-1/e3": { locations: ["/tmp/relay-fixture/src/b.ts"], diff: diff("src/b.ts", true, 5, 0) },
    "run-1/c1": { input: "cat .env", output: "SECRET_VALUE_" + "1234567890" }, "run-2/s1": { input: "look around", output: "found things", truncated: true },
  }));
  return { state, details, redaction: tableRedaction([KNOWN]) };
}

test("the directory lists a window of Turns, one line each, without reasoning and with honest counts", () => {
  const { state, details, redaction } = scenario();
  const view = turnsView(state, undefined, undefined, details, redaction);
  assert.deepEqual([view.total, view.from, view.to, view.active], [3, 1, 3, 3], "the Turn running now is named");
  const [first, second, third] = view.lines;
  assert.deepEqual([first!.n, first!.harnessId, first!.model, first!.status, first!.tools, first!.files, first!.filesApprox], [1, "claude", "claude-opus-5-5", "completed", 6, 2, undefined],
    "six tool calls (the reasoning is not one) and two distinct files, three changes");
  assert.ok(first!.user.endsWith("…") && [...first!.user].length <= 81 && USER1.startsWith(first!.user.slice(0, -1)), "the user's words are shortened to their start: " + first!.user);
  assert.ok(first!.reply.endsWith("…") && REPLY1.startsWith(first!.reply.slice(0, -1)));
  assert.deepEqual([second!.harnessId, second!.model, second!.tools, second!.files, second!.filesApprox], ["codex", undefined, 3, 1, true], "a change whose detail was not read counts as one file, and says so");
  assert.deepEqual([third!.status, third!.tools, third!.files, third!.reply], ["preparing", 0, 0, ""]);
  assert.doesNotMatch(JSON.stringify(view), /private reasoning/u);
  // Without any detail every change counts as one file, approximately.
  assert.deepEqual([turnsView(state, undefined, undefined, new Map(), redaction).lines[0]!.files, turnsView(state, undefined, undefined, new Map(), redaction).lines[0]!.filesApprox], [3, true]);
});

test("the directory's window: the latest Turns by default, from and limit move it, and what it needs is only the change tools' details", () => {
  const { state } = scenario();
  assert.deepEqual(directoryRange(state, undefined, 2), { from: 2, to: 3 });
  assert.deepEqual(directoryRange(state, 1, 2), { from: 1, to: 2 });
  assert.deepEqual(directoryRange(state, 9, undefined), { from: 9, to: 8 }, "past the end: nothing");
  assert.deepEqual(directoryRange(state, undefined, 1000), { from: 1, to: 3 }, "a limit above the maximum is the maximum");
  assert.equal(turnsView(state, 9, undefined, new Map(), tableRedaction([])).lines.length, 0);
  assert.deepEqual(directoryNeeds(state, 1, 3).map(item => item.runId + "/" + item.toolId), ["run-1/e1", "run-1/e2", "run-1/e3"], "n1 has no stored detail to read");
  const empty = conversation([{ input: "only", harnessId: "claude" }]).state;
  assert.deepEqual([turnsView({ ...empty, runs: [], messages: [] }, undefined, undefined, new Map(), tableRedaction([])).total, TABLE_LIMITS.turnsDefault], [0, 40]);
});

test("one Turn: the overview holds its words, reply, numbered tool calls, files and plan; the pieces are read whole", () => {
  const { state, details, redaction } = scenario();
  const overview = readTurn(state, 1, {}, details, redaction);
  assert.equal(overview.part, "overview");
  assert.equal(overview.end, overview.size);
  assert.match(overview.text, /^Turn 1 of 3 · claude \(claude-opus-5-5\) · completed\n/u);
  for (const wanted of [USER1, REPLY1, "#1 · read · Read src/a.ts", "#2 · execute · Bash · `pnpm test` · failed, exit 1 · detail 100 B", "#6 · execute · `cat .env`", "## Files changed (2)", "- src/a.ts — edited (2 changes) (+5 -1)", "- src/b.ts — created (+5 -0)"])
    assert.ok(overview.text.includes(wanted), "the overview holds: " + wanted + "\n" + overview.text);
  assert.doesNotMatch(overview.text, /private reasoning|Thinking/u, "no reasoning, and the reasoning's tool call is not numbered");
  assert.ok(!overview.text.includes("/tmp/relay-fixture"), "a path inside the workspace is told from the workspace");
  const second = readTurn(state, 2, {}, details, redaction);
  assert.ok(second.text.includes("#2 (inside #1) · read · Read src/c.ts") && second.text.includes("## The plan\nTwo steps\n[x] Read the export\n[~] Fix rounding\n[ ] Run all tests"), second.text);
  assert.ok(second.text.includes("## Changes whose files could not be read (1), by title\n- Edit src/d.ts"), "a change that cannot be told by its files is told by its title");
  assert.equal(readTurn(state, 1, { part: "user" }, details, redaction).text, USER1);
  assert.equal(readTurn(state, 1, { part: "reply" }, details, redaction).text, REPLY1);
  assert.match(readTurn(state, 1, { part: "files" }, details, redaction).text, /^Files changed \(2\):\n- src\/a\.ts/u);
  assert.equal(readTurn(state, 3, { part: "files" }, details, redaction).text, "(this turn changed no files)");
  assert.equal(readTurn(state, 1, { part: "input", tool: 2 }, details, redaction).text, "pnpm test");
  assert.match(readTurn(state, 1, { part: "diff", tool: 3 }, details, redaction).text, /^--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n/u);
  assert.deepEqual(turnNeeds(state, 1, undefined, undefined).map(item => item.toolId), ["e1", "e2", "e3"]);
  assert.deepEqual(turnNeeds(state, 1, "output", 2).map(item => item.toolId), ["x1"]);
  assert.deepEqual(turnNeeds(state, 1, "reply", undefined), []);
});

test("a long overview piece says where it goes on, and the pages of a part join into the whole of it", () => {
  const { state, details, redaction } = scenario();
  const long = { ...state, runs: state.runs.map((run, index) => index === 0 ? { ...run, input: "word ".repeat(3000) } : run), messages: state.messages.map(message => message.runId === state.runs[0]!.id && message.role === "user" ? { ...message, text: "word ".repeat(3000) } : message) };
  const overview = readTurn(long, 1, {}, details, redaction).text;
  const pointer = /\[continues: part=user offset=(\d+); (\d+) more characters\]/u.exec(overview);
  assert.ok(pointer, overview.slice(0, 3000));
  assert.equal(Number(pointer![1]) + Number(pointer![2]), "word ".repeat(3000).length, "the pointer says exactly where the rest begins");
  let offset = 0, joined = "", pages = 0;
  for (;;) {
    const page = readTurn(state, 1, { part: "output", tool: 2, offset, limit: 300 }, details, redaction);
    joined += page.text; pages++;
    assert.equal(page.offset, offset); assert.ok(page.text.length <= 300);
    if (page.end >= page.size) break;
    assert.ok(page.end > offset, "every page moves on");
    offset = page.end;
  }
  const whole = readTurn(state, 1, { part: "output", tool: 2, limit: TABLE_LIMITS.pageMax }, details, redaction);
  assert.ok(pages > 3 && whole.end === whole.size);
  assert.equal(joined, whole.text);
  assert.equal(readTurn(state, 1, { part: "output", tool: 2, offset: 10_000_000 }, details, redaction).text, "", "past the end is an empty page, not a failure");
});

test("what leaves is redacted before it is cut, and the output of a call that touches a credential file is withheld", () => {
  const { state, details, redaction } = scenario();
  const output = readTurn(state, 1, { part: "output", tool: 2, limit: TABLE_LIMITS.pageMax }, details, redaction).text;
  assert.ok(output.includes("line 60 of the test run") && output.includes("FAIL tests/a.test.ts"));
  assert.ok(!output.includes(TOKEN) && !output.includes(KNOWN), "neither the shaped token nor the known secret");
  assert.ok(output.includes("〔redacted · GitHub token〕") && output.includes("〔redacted · known credential〕"));
  // A secret across a page boundary is never half shown: the pages are cut from the redacted text.
  let all = "";
  for (let offset = 0, end = 0; end < output.length; offset = end) { const page = readTurn(state, 1, { part: "output", tool: 2, offset, limit: 137 }, details, redaction); all += page.text; end = page.end; }
  assert.ok(!all.includes("A1b2C3d4E5") && !all.includes("correct-horse"));
  const withheld = readTurn(state, 1, { part: "output", tool: 6 }, details, redaction);
  assert.match(withheld.text, /^Withheld: this tool call touches a credential file/u);
  assert.ok(!withheld.text.includes("SECRET_VALUE_"));
  assert.equal(readTurn(state, 1, { part: "input", tool: 6 }, details, redaction).text, "cat .env", "the command itself is a fact and is given");
  const secretInWords = { ...state, runs: state.runs.map((run, index) => index === 0 ? { ...run, input: "use " + TOKEN + " for it" } : run) };
  assert.equal(readTurn(secretInWords, 1, { part: "user" }, details, redaction).text, "use 〔redacted · GitHub token〕 for it");
  assert.ok(turnsView(secretInWords, undefined, undefined, details, redaction).lines[0]!.user.includes("〔redacted · GitHub token〕"));
  const cut = readTurn(state, 2, { part: "output", tool: 1 }, details, redaction);
  assert.deepEqual(cut.notes?.length, 1, "a detail the Hub itself cut to its limits says so");
  assert.match(cut.notes![0]!, /may be incomplete/u);
});

test("a request that cannot be answered says why: no such Turn, no such tool call, no stored detail, no tool named", () => {
  const { state, details, redaction } = scenario();
  const refused = (run: () => unknown, code: string, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof SessionError && error.code === code && message.test(error.message), code);
  refused(() => readTurn(state, 4, {}, details, redaction), "TABLE_TURN_NOT_FOUND", /There is no turn 4; this conversation has 3 turns \(1-3\)\./u);
  refused(() => readTurn(state, 0, {}, details, redaction), "TABLE_TURN_NOT_FOUND", /no turn 0/u);
  refused(() => readTurn(state, 1, { part: "output", tool: 99 }, details, redaction), "TABLE_TOOL_NOT_FOUND", /Turn 1 has 6 tool calls \(1-6\); there is no tool 99\./u);
  refused(() => readTurn(state, 1, { part: "output" }, details, redaction), "INVALID_INPUT", /needs tool/u);
  refused(() => readTurn(state, 2, { part: "output", tool: 3 }, details, redaction), "TABLE_DETAIL_UNAVAILABLE", /no stored detail/u);
  refused(() => readTurn(state, 1, { part: "output", tool: 1 }, new Map(), redaction), "TABLE_DETAIL_UNAVAILABLE", /could not be read/u);
  refused(() => readTurn(state, 1, { part: "nonsense" as never }, details, redaction), "INVALID_INPUT", /part must be one of/u);
  refused(() => searchTurns(state, "  ", undefined, details, redaction, 0), "INVALID_INPUT", /search words/u);
});

test("search finds the user's words, replies, tool calls and details, newest Turn first, and confirms no hidden secret", () => {
  const { state, details, redaction } = scenario();
  const found = searchTurns(state, "line 42", undefined, details, redaction, 0);
  assert.deepEqual([found.total, found.turns, found.unsearched], [1, 3, 1], "one place, three Turns, and the one call that touches a credential file was not searched");
  const [hit] = found.hits;
  assert.deepEqual([hit!.n, hit!.where, hit!.tool, hit!.matches], [1, "output", 2, 1]);
  assert.ok(hit!.snippet.includes("line 42 of the test run"), hit!.snippet);
  const part = readTurn(state, 1, { part: "output", tool: 2, limit: TABLE_LIMITS.pageMax }, details, redaction).text;
  assert.equal(part.slice(hit!.at, hit!.at + 7), "line 42", "`at` indexes the part's own text, so it can be read from there");
  // Case is ignored; the user's words and the reply are searched; the newest Turn comes first.
  const words = searchTurns(state, "SECOND PASS", undefined, details, redaction, 0);
  assert.deepEqual(words.hits.map(item => [item.n, item.where]), [[2, "user"], [2, "reply"]]);
  const several = searchTurns(state, "src/a.ts", undefined, details, redaction, 0);
  assert.deepEqual(several.hits.map(item => [item.n, item.where, item.tool]), [[1, "tool", 1], [1, "tool", 3], [1, "diff", 3], [1, "tool", 4], [1, "diff", 4]], "in a Turn's own order, a tool call's title then its inputs, outputs and diffs");
  assert.deepEqual(searchTurns(state, "the", 2, details, redaction, 0).hits.length, 2, "a limit bounds the hits; total still counts every place");
  assert.ok(searchTurns(state, "the", 2, details, redaction, 0).total > 2);
  // A secret is never confirmed: the match must survive the redaction.
  for (const secret of [TOKEN, TOKEN.slice(0, 20), KNOWN, "A1b2C3d4E5"]) assert.equal(searchTurns(state, secret, undefined, details, redaction, 0).total, 0, secret.slice(0, 6));
  // What was not searched is counted: details not read, and the outputs withheld.
  assert.equal(searchTurns(state, "zzz", undefined, details, redaction, 3).unsearched, 4);
  assert.equal(searchTurns(state, "SECRET_VALUE_", undefined, details, redaction, 0).total, 0, "the output of a call that touches a credential file is not searched");
  assert.deepEqual(searchNeeds(state).map(item => item.toolId).slice(0, 4), ["s1", "s2", "r1", "x1"], "newest Turn's details first");
});

test("pages never split a character, and always move on", () => {
  const text = "😀".repeat(40) + "\n" + "字".repeat(60) + "\nend";
  for (const limit of [1, 2, 3, 7, 50]) {
    let offset = 0, joined = "";
    for (let guard = 0; guard < 1000; guard++) {
      const page = pageOf(text, offset, limit);
      assert.doesNotMatch(page.text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u, "no half of a pair in a page of " + limit);
      joined += page.text;
      if (page.end >= page.size) break;
      assert.ok(page.end > page.offset);
      offset = page.end;
    }
    assert.equal(joined, text, "pages of " + limit);
  }
  assert.equal(pageOf("abc\ndef\nghi", 0, 6).text, "abc\n", "a page ends at a line when it can");
  assert.deepEqual(pageOf("abc", 99, 10), { text: "", offset: 3, end: 3, size: 3 });
});

test("the tokens of the table: unguessable, resolved to their conversation, revoked with it, bounded", () => {
  const grants = new MemoryTableGrants(), one = sessionId("session-one"), two = sessionId("session-two");
  const a = grants.mint({ sessionId: one, harnessId: "claude", controlId: "claude-acp" }), b = grants.mint({ sessionId: one, harnessId: "codex", controlId: "codex-app" }), c = grants.mint({ sessionId: two, harnessId: "claude", controlId: "claude-acp" });
  assert.match(a, /^hht_[A-Za-z0-9_-]{43}$/u);
  assert.equal(new Set([a, b, c]).size, 3);
  assert.deepEqual(grants.resolve(a), { sessionId: one, harnessId: "claude", controlId: "claude-acp" });
  for (const bad of ["", "hht_", a + "x", a.slice(0, -1), "x".repeat(600)]) assert.equal(grants.resolve(bad), null);
  grants.revoke(one);
  assert.deepEqual([grants.resolve(a), grants.resolve(b), grants.resolve(c)?.sessionId, grants.size], [null, null, two, 1]);
  for (let index = 0; index < 4100; index++) grants.mint({ sessionId: two, harnessId: "claude", controlId: "claude-acp" });
  assert.equal(grants.size, 4096);
  assert.equal(grants.resolve(c), null, "the oldest go first");
});
