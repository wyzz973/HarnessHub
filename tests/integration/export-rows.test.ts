import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TurnItems } from "../../src/contracts/conversation.js";
import { ConversationFacts } from "../../src/infrastructure/session/facts.js";
import { ConversationTables } from "../../src/infrastructure/session/read.js";
import { LEGACY_ORDER_LINE, exportMarkdown, rowsExport, type ExportSource } from "../../src/web/conversation-export.js";
import { TurnView, turnFactsOf } from "../../src/web/turn-view.js";
import { sessionId } from "../../src/contracts/session.js";
import { appStore } from "../fixtures/runtime-store.js";
import { temporary } from "../fixtures/store-helpers.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { scriptedWorld } from "../fixtures/scripted-world.js";

// The Markdown export written from rows (src/web/conversation-export.ts `exportMarkdown`): a Turn that has the order it happened in is written in that order; a Turn converted from before the
// order was kept says its parts stand in a fixed arrangement; and the writing is a Turn at a time. (The export is held to the build before the cut in tests/integration/cut-wire-rows.test.ts.)

/** The export source of the conversation `id` in the store at `root`, read through a second read-only connection (the store keeps its own private). */
function sourceOf(root: string, id: string): { readonly source: ExportSource; close(): void } {
  const db = new DatabaseSync(join(root, "gateway.sqlite"), { readOnly: true }), reader = new ConversationTables(db);
  const view = new TurnView(turnFactsOf(sessionId(id), new ConversationFacts(db), () => ({})), { harnessName: () => null });
  return { source: rowsExport(reader, sessionId(id), view), close: () => db.close() };
}
const text = (source: ExportSource): string => [...exportMarkdown(source, new Date("2026-11-13T00:00:00.000Z"))].join("");

test("a Turn that has the order it happened in is written in that order: the words, the steps after them, the words after those, and no line about a fixed arrangement", { timeout: 30_000 }, async t => {
  const w = await scriptedWorld(t, () => ({ reply: false as const, events: [
    { type: "text", text: "First I look at the tests." },
    { type: "tool", id: "run-1", title: "pnpm test", status: "completed", detail: { kind: "execute", input: "pnpm test", exitCode: 1 } },
    { type: "text", text: "Two fail, so I fix the rounding." },
    { type: "tool", id: "edit-1", title: "Edit src/a.ts", status: "completed", detail: { kind: "edit", locations: ["src/a.ts"], diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" } },
    { type: "tool", id: "run-2", title: "pnpm test", status: "completed", detail: { kind: "execute", input: "pnpm test", exitCode: 0 } },
    { type: "text", text: "All of them pass now." },
  ] }));
  await w.send("fix the failing tests");
  const { source, close } = sourceOf(w.data, w.id);
  try {
    const out = text(source);
    const at = (needle: string): number => { const found = out.indexOf(needle); assert.ok(found >= 0, "the export holds " + JSON.stringify(needle) + ":\n" + out); return found; };
    assert.ok(at("First I look at the tests.") < at("运行 pnpm test，退出码 1") && at("运行 pnpm test，退出码 1") < at("Two fail, so I fix the rounding.") && at("Two fail, so I fix the rounding.") < at("修改 src/a.ts") && at("修改 src/a.ts") < at("All of them pass now."),
      "words and steps are in the order they happened:\n" + out);
    assert.equal(out.split("步骤：").length - 1, 2, "a list of steps for each stretch of work: the one between the first words and the second, and the one between the second and the last");
    assert.equal(out.includes(LEGACY_ORDER_LINE), false, "a Turn in the order it happened is not told it is a fixed arrangement");
    assert.match(out, /^## alpha · 已完成$/mu);
    assert.ok(out.endsWith("\n"), "the export ends with a line end, as it always did");
  } finally { close(); }
});

test("a Turn converted from before the order was kept says that its parts stand in a fixed arrangement, once, and is otherwise written as it always was", { timeout: 60_000 }, t => {
  const fixture = loadV13Fixture("tools"), data = join(temporary(t), "data");
  writeV13Root(data, [fixture]);
  const store = appStore(data);
  try {
    for (const row of fixture.sessions) {
      const { source, close } = sourceOf(data, row.id);
      try {
        const out = text(source), turns = out.split("\n---\n").length - 1;
        assert.equal(out.split(LEGACY_ORDER_LINE).length - 1, source.count, row.id + ": a line for each of its " + source.count + " Turns");
        assert.equal(turns, source.count, row.id + ": a block for each Turn");
      } finally { close(); }
    }
  } finally { store.close(); }
});

test("the export is written a Turn at a time: nothing is read until its chunk is asked for, and each Turn is read once", { timeout: 30_000 }, async t => {
  const w = await scriptedWorld(t, turn => [{ type: "text", text: "answer " + turn }]);
  for (let turn = 1; turn <= 5; turn++) await w.send("question " + turn);
  const { source, close } = sourceOf(w.data, w.id);
  try {
    const read: number[] = [];
    const spy: ExportSource = { ...source, read: ordinal => { read.push(ordinal); return source.read(ordinal); }, wire: (items: TurnItems) => source.wire(items) };
    const chunks = exportMarkdown(spy, new Date("2026-11-13T00:00:00.000Z"));
    const head = chunks.next();
    assert.equal(head.done, false); assert.ok(String(head.value).startsWith("# question 1"), "the title is the first words");
    assert.deepEqual(read, [0], "the head needed the first Turn only");
    chunks.next();
    assert.deepEqual(read, [0], "and the first Turn's chunk needed no other");
    chunks.next();
    assert.deepEqual(read, [0, 1], "the second Turn is read when its chunk is asked for");
    const rest = [...chunks];
    assert.equal(rest.length, 3);
    assert.deepEqual(read, [0, 1, 2, 3, 4], "every Turn is read once");
    assert.equal(text(source).split("\n---\n").length - 1, 5);
  } finally { close(); }
});
