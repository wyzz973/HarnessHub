import assert from "node:assert/strict";
import test from "node:test";
import { workspacePath } from "../../web/src/lib/format.js";
import { readPreferences } from "../../web/src/lib/prefs.js";
import { noteMount, parseUnifiedDiff, rememberShown, reveal, shownSteps, wrapChunks, type HastNode, type Reveal } from "../../web/src/lib/turn.js";
import { spentText } from "../../web/src/lib/format.js";

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
    { theme: "dark", density: "detailed", panel: false, sidebar: false, grouping: "project", whileRunning: "queue", readingSize: "14", chatWidth: "standard", sendKey: "enter", showFrozen: true });
  // Opened or closed since: the user's own choice, kept either way.
  assert.equal(readStored({ theme: "system", density: "compact", panel: true, sidebar: true, showFrozen: false, version: 2 }).panel, true);
  assert.equal(readStored({ theme: "system", density: "compact", panel: false, sidebar: true, showFrozen: false, version: 2 }).panel, false);
});

test("G054-FR1 preferences stored with the sidebar's old grouping still read, without it, keeping every other choice", () => {
  // The sidebar groups by project only (ADR-054 §5); a browser may still hold the shape every write stored before.
  for (const groupBy of ["status", "harness", "workspace", "something else"]) {
    const read = readStored({ theme: "light", density: "detailed", panel: false, sidebar: false, groupBy, showFrozen: true, version: 2 });
    assert.deepEqual(read, { theme: "light", density: "detailed", panel: false, sidebar: false, grouping: "project", whileRunning: "queue", readingSize: "14", chatWidth: "standard", sendKey: "enter", showFrozen: true });
    assert.equal(Object.hasOwn(read, "groupBy"), false);
    // The shape exactly as the previous code wrote it, with no version: the same choices are kept, and the panel starts closed.
    assert.deepEqual(readStored({ theme: "dark", density: "detailed", panel: true, sidebar: false, groupBy, showFrozen: true }),
      { theme: "dark", density: "detailed", panel: false, sidebar: false, grouping: "project", whileRunning: "queue", readingSize: "14", chatWidth: "standard", sendKey: "enter", showFrozen: true });
  }
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

test("G054-FR3 a changed file is named relative to the conversation's workspace, also when the diff dropped its leading slash", () => {
  const workspace = "/private/tmp/hub/dev-ws";
  assert.equal(workspacePath("private/tmp/hub/dev-ws/src/a.ts", workspace), "src/a.ts");
  assert.equal(workspacePath("/tmp/hub/dev-ws/b.md", workspace), "b.md", "macOS reports /tmp and /private/tmp for the same directory");
  assert.equal(workspacePath("/Users/someone/elsewhere/c.ts", workspace), "~/elsewhere/c.ts");
  assert.equal(workspacePath("src/relative.ts", workspace), "src/relative.ts");
});

test("G054-DL4 a diff says which files it creates", () => {
  const created = parseUnifiedDiff("--- /dev/null\n+++ b/web/src/Steps.tsx\n@@ -0,0 +1,2 @@\n+a\n+b", "?");
  assert.equal(created[0]!.created, true);
  assert.equal(parseUnifiedDiff("diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x", "?")[0]!.created, true);
  const changed = parseUnifiedDiff("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+n", "?");
  assert.deepEqual(changed.map(file => file.created), [false, true]);
  assert.deepEqual(changed.map(file => [file.add, file.del]), [[1, 1], [1, 0]]);
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
