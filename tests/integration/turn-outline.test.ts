import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { sessionId } from "../../src/contracts/session.js";
import { withoutThinking } from "../../src/contexts/session/domain/relay/narration.js";
import { OUTLINE_INLINE_BYTES, outlineOfRecord, turnSource, type TurnOutline } from "../../src/contexts/session/domain/turn-source.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { appStore } from "../fixtures/runtime-store.js";
import { Scenario, created, newConversation, temporary } from "../fixtures/store-helpers.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";

// The outline of a Turn (src/contexts/session/domain/turn-source.ts): its Run with the tools, the attachments and the error whole, and of what it said only how big the words are and whether the reply has
// anything to read — the words themselves come back from the rows when a piece of a packet needs them. It is what a packet counts every Turn it owes by. Held here to the Turn read whole, for every
// Turn of the frozen v13 fixtures (converted to the tables) and for replies made to be hard: whitespace, thinking blocks, the quirk of a mixed-case tag, text in several segments, text of every length.

/** Everything an outline says, checked against the same Turn read whole. */
function same(outline: TurnOutline | null, whole: TurnOutline, where: string): void {
  assert.ok(outline !== null, where + ": there is an outline");
  const wholeUser = whole.user.text(), wholeReply = whole.reply.text(), shown = withoutThinking(wholeReply);
  assert.equal(outline.user.text(), wholeUser, where + ": the user's words");
  assert.equal(outline.reply.text(), wholeReply, where + ": the reply");
  assert.equal(outline.reply.visible, shown.trim() !== "", where + ": whether the reply has anything to read");
  assert.ok(outline.user.size.least <= wholeUser.length && wholeUser.length <= outline.user.size.most, where + ": the user's words are between their bounds");
  assert.equal(outline.user.size.exact(), wholeUser.length, where + ": and exactly as long");
  assert.ok(outline.reply.size.least <= shown.length && shown.length <= outline.reply.size.most, where + ": the reply is between its bounds");
  assert.equal(outline.reply.size.exact(), shown.length, where + ": and exactly as long once its thinking is out");
  assert.equal(outline.user.bytes, Buffer.byteLength(wholeUser, "utf8")); assert.equal(outline.reply.bytes, Buffer.byteLength(wholeReply, "utf8"));
  const { input: _input, thinking: _thinking, ...rest } = outline.run, { input: _wholeInput, thinking: _wholeThinking, ...wholeRest } = whole.run;
  assert.deepEqual(rest, wholeRest, where + ": the Run but the words it said");
  assert.equal(outline.legacyOrder, whole.legacyOrder);
}

for (const name of V13_FIXTURES) {
  test(`${name}: the outline of every Turn says what the Turn read whole says`, { timeout: 60_000 }, t => {
    const fixture = loadV13Fixture(name), data = join(temporary(t), "data");
    writeV13Root(data, [fixture]);
    const store = appStore(data);
    try {
      for (const row of fixture.sessions) {
        const id = sessionId(row.id), outlines = turnSource(store, id), wholes = turnSource(store, id);
        for (let ordinal = 0; ordinal < outlines.count; ordinal++) same(outlines.outline(ordinal), outlineOfRecord(wholes.turn(ordinal)!), name + " " + row.id + " turn " + ordinal);
        assert.equal(outlines.outline(outlines.count), null);
      }
    } finally { store.close(); }
  });
}

/** One conversation whose Turns have the replies given, as their segments. */
function replied(t: TestContext, turns: readonly (readonly string[])[], user = "a question"): { readonly store: SqliteConversationStore; readonly id: ReturnType<typeof sessionId> } {
  let opened: SqliteConversationStore | undefined;
  t.after(() => opened?.close());
  const store = opened = appStore(join(temporary(t), "data")), id = created(store, newConversation("/work", "hard")).conversation.id, scenario = new Scenario(store, id, "run-hard", false);
  turns.forEach((segments, ordinal) => {
    scenario.accept(user + " " + ordinal); scenario.start(ordinal);
    for (const segment of segments) scenario.say(ordinal, segment);
    scenario.finish(ordinal);
  });
  return { store, id };
}

test("a reply that is hard to tell has an outline that says what it says: whitespace, thinking blocks, a tag in mixed case, several segments, every length", { timeout: 60_000 }, t => {
  const long = (text: string, bytes = 5000): string => text + "x".repeat(Math.max(0, bytes - text.length));
  const big = 3 * OUTLINE_INLINE_BYTES + 7;
  const replies: readonly (readonly string[])[] = [
    [],                                                                   // said nothing
    [""],                                                                 // an empty segment
    ["   \n\t "],                                                         // whitespace
    [" ".repeat(big)],                                                    // whitespace, long
    ["answer"],                                                           // short
    [long("answer ", big)],                                               // long, visible at once
    [" ".repeat(big) + "answer"],                                         // long, visible only after a long white stretch
    ["<think>weighing it</think>" + long("answer ", big)],                // thinking, then an answer
    ["  <THINK>weighing it</THINK>" + " ".repeat(big)],                    // thinking, then white
    ["<think>" + "t".repeat(big)],                                        // thinking that never closes
    ["<Think>" + "t".repeat(big) + "</Think>"],                           // the quirk: a tag in mixed case is not looked for, so what it holds is read
    ["<thinking>aloud</thinking> and then " + "w".repeat(big)],           // a tag that is not the thinking tag
    ["answer " + "<think>" + "t".repeat(big) + "</think>"],               // an answer, then thinking
    ["   <th", "ink>" + "h".repeat(big) + "</think>"],                    // a tag split across two segments
    [long("first segment ", big), long("second segment ", big)],         // several long segments
    ["<th", long("ink>no tag, a thin", big)],                             // a tag that is not one once the segments are joined
    ["答".repeat(big)],                                                    // three bytes to a unit
    ["😀".repeat(big)],                                                    // two units to four bytes
  ];
  const { store, id } = replied(t, replies, "答".repeat(big) + " ");
  const outlines = turnSource(store, id), wholes = turnSource(store, id);
  assert.equal(outlines.count, replies.length);
  for (let ordinal = 0; ordinal < replies.length; ordinal++) same(outlines.outline(ordinal), outlineOfRecord(wholes.turn(ordinal)!), "reply " + ordinal);
  // The outline of a Turn that was read whole is made of it and reads nothing, and an outline is read once.
  const calls: number[] = [];
  const counting = { head: store.head.bind(store), runOrdinal: store.runOrdinal.bind(store), turnAt: (...args: Parameters<typeof store.turnAt>) => { calls.push(args[2]?.inlineBytes ?? -1); return store.turnAt(...args); },
    text: store.text.bind(store), items: store.items.bind(store) };
  const source = turnSource(counting, id);
  source.turn(4); source.outline(4); source.outline(5); source.outline(5);
  assert.deepEqual(calls, [Infinity, OUTLINE_INLINE_BYTES], "the Turn read whole once, the other's outline once");
});

test("a long text is told to be longer than a limit from its start: never wrongly, and without reading it whole when the start settles it", { timeout: 60_000 }, t => {
  const big = 3 * OUTLINE_INLINE_BYTES + 7;
  const replies: readonly (readonly string[])[] = [
    ["x".repeat(400_000)],                                                // plain, far over any limit below
    ["a".repeat(150_000), "b".repeat(150_000)],                           // two long segments
    ["答".repeat(150_000)],                                                // three bytes to a unit: the look of plain text is not enough
    ["é".repeat(150_000)],                                                // two bytes to a unit
    ["😀".repeat(100_000)],                                                // two units to four bytes
    ["<think>" + "t".repeat(300_000) + "</think>ok"],                     // a block at once: the start does not tell
    ["short ".repeat(30) + "<think>" + "t".repeat(300_000)],              // a block that never closes, after a short start
    ["x".repeat(200_000) + "<think>" + "t".repeat(200_000) + "</think>"], // plain for a long stretch, then thinking
    ["x".repeat(big)],                                                    // long for an outline, short of the limits below
    ["<Think>" + "t".repeat(big) + "</Think>"],                           // the quirk: a tag in mixed case is not looked for
    ["<thi", "nk>" + "t".repeat(300_000) + "</think>"],                   // a tag split across two segments
  ];
  const { store, id } = replied(t, replies, "u".repeat(400_000) + " ");
  const limits = [0, 1, 99, 1_000, 99_999, 100_000, 100_001, 149_999, 150_000, 200_000, 399_999, 400_000, 500_000];
  let bytes = 0;
  const counting = { head: store.head.bind(store), runOrdinal: store.runOrdinal.bind(store), turnAt: store.turnAt.bind(store), items: store.items.bind(store),
    text: (...args: Parameters<typeof store.text>) => { const part = store.text(...args); bytes += Buffer.byteLength(part.text, "utf8"); return part; } };
  const source = turnSource(counting, id);
  let told = 0, settled = 0;
  replies.forEach((segments, ordinal) => {
    const outline = source.outline(ordinal)!, shown = withoutThinking(segments.join("")).length;
    for (const limit of limits) {
      const said = outline.reply.size.exceeds?.(limit);
      if (said === true) { told++; assert.ok(shown > limit, "reply " + ordinal + ": told longer than " + limit + " while it is " + shown + " long"); }
      if (said === true || said === undefined) settled++;
    }
    const user = outline.user.size.exceeds?.(1_000);
    assert.ok(user === true, "the user's words (400,000) are told longer than 1,000");
  });
  assert.ok(told > 0 && settled > 0);
  // A plain text over the limit is told by a look at its start of the size of the limit, not by reading it whole; the thinking blocks are read through (the start cannot tell).
  const looked = (ordinal: number, words: "user" | "reply", chars: number): { readonly told: boolean | undefined; readonly bytes: number } => {
    const outline = turnSource(counting, id).outline(ordinal)!;
    bytes = 0;
    const told = outline[words].size.exceeds?.(chars);
    return { told, bytes };
  };
  const plain = looked(0, "reply", 100_000);
  assert.equal(plain.told, true); assert.ok(plain.bytes > 0 && plain.bytes <= 100_008, "a look of the limit's size: " + plain.bytes);
  const two = looked(1, "reply", 100_000);
  assert.equal(two.told, true); assert.ok(two.bytes > 0 && two.bytes <= 100_008, "two segments, the first settles it: " + two.bytes);
  const wide = looked(2, "reply", 100_000);
  assert.equal(wide.told, true); assert.ok(wide.bytes <= 100_008 + 300_024, "three bytes to a unit: a second look, three times as long: " + wide.bytes);
  const own = looked(0, "user", 100_000);
  assert.equal(own.told, true); assert.ok(own.bytes > 0 && own.bytes <= 100_008, "the user's words are told the same way: " + own.bytes);
  // And what its start cannot tell, the whole text does.
  const thinking = turnSource(counting, id).outline(5)!;
  assert.notEqual(thinking.reply.size.exceeds?.(1), true, "a reply that is thinking at the start is not told long from its start");
  assert.equal(thinking.reply.size.exact(), "ok".length);
  // A text whose start is plain for a stretch and then thinking is told longer than that stretch and no longer (what follows is not looked at).
  const stretch = turnSource(counting, id).outline(7)!.reply.size;
  assert.equal(stretch.exceeds?.(100_000), true);
  assert.notEqual(stretch.exceeds?.(250_000), true);
  assert.equal(stretch.exact(), 200_000);
});
