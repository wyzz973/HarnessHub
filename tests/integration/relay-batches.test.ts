import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { buildPublicContext } from "../../src/contexts/session/domain/context.js";
import { rowsHistory } from "../../src/contexts/session/domain/relay/history.js";
import { ITEM_KINDS } from "../../src/contracts/relay.js";
import type { ConversationReader } from "../../src/contracts/conversation.js";
import { OUTLINE_INLINE_BYTES } from "../../src/contexts/session/domain/turn-source.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { snapshotHistory } from "../fixtures/old-shape.js";
import { appStore } from "../fixtures/runtime-store.js";
import { Scenario, created, newConversation, temporary } from "../fixtures/store-helpers.js";

// A handoff packet for a long history reads what the budget can carry and counts the rest (ADR-057 3.3, the relay's renderer; the design of docs of 2026-11-12, finding 6.5). A conversation of 2,000 Turns,
// some of them with replies of 300 KiB and five with 3 MiB, owed whole to a Harness whose packet takes 6,000 tokens: every Turn is looked at once without its words (its outline: the tools, the
// size of what it said, whether the reply has anything to read), the words are read only of the few the packet carries or weighs, and what the packet leaves out is on its ledger with the counts of the
// whole. The packet is the one the renderer makes of the same conversation read whole, byte for byte. Real SQLite; nothing is made up but the history.

const names = (harnessId: string): string | null => ({ alpha: "Alpha Harness", bravo: "Bravo Harness" })[harnessId] ?? null;
const TURNS = 2000, GIANT = new Set([10, 500, 1000, 1500, 1990]), BIG = (turn: number): boolean => turn % 97 === 0;

/** The history: `TURNS` finished Turns of alpha, each with a tool call, and the input that asks for the packet, queued. */
function longConversation(store: SqliteConversationStore): { readonly id: ReturnType<typeof created>["conversation"]["id"]; readonly bytes: number } {
  const id = created(store, newConversation("/work", "owed")).conversation.id, scenario = new Scenario(store, id, "run-owed", false);
  let bytes = 0;
  for (let turn = 0; turn < TURNS; turn++) {
    const question = "question " + turn + " about " + "the thing ".repeat(turn % 7 === 0 ? 40 : 3), reply = BIG(turn) ? "r".repeat(300 * 1024) : "reply " + turn + " " + "words ".repeat(1300);
    scenario.accept(question); scenario.start(turn);
    if (GIANT.has(turn)) {
      const first = scenario.say(turn, "g".repeat(16 * 1024));
      for (let window = 1; window < 192; window++) scenario.append(turn, first.seq, "g".repeat(16 * 1024));
      bytes += 192 * 16 * 1024;
    } else { scenario.say(turn, reply); bytes += reply.length; }
    scenario.tool(turn, "read-" + turn); scenario.finish(turn); bytes += question.length;
  }
  scenario.accept("and now what?");
  return { id, bytes };
}

test("a packet for 2,000 owed Turns looks at each Turn once without its words, reads the words of the few it weighs, counts all of them on its ledger, and is the packet of the whole read", { timeout: 600_000 }, t => {
  let opened: SqliteConversationStore | undefined;
  t.after(() => opened?.close());
  const store = opened = appStore(join(temporary(t), "data")), { id, bytes: held } = longConversation(store);
  const conversation = store.get(id);
  assert.equal(conversation.runs.length, TURNS + 1);

  // What is read, counted at the reader.
  const read = { outlines: 0, whole: 0, wholeTexts: 0, texts: 0, bytes: 0, largest: 0 }, outlined = new Set<number>();
  const spy: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory" | "text" | "items"> = {
    head: at => store.head(at), runOrdinal: (at, run) => store.runOrdinal(at, run), originHistory: at => store.originHistory(at), items: (run, after, limit, options) => store.items(run, after, limit, options),
    turnAt: (at, ordinal, options) => {
      const turn = store.turnAt(at, ordinal, options);
      if (options?.inlineBytes === Infinity) read.whole++; else if (options?.inlineBytes === OUTLINE_INLINE_BYTES) { read.outlines++; assert.equal(outlined.has(ordinal), false, "an outline is read once"); outlined.add(ordinal); }
      let size = 0;
      for (const item of turn?.items ?? []) if (item.textOmitted !== true) size += Buffer.byteLength(item.text.join(""), "utf8");
      read.bytes += size; read.largest = Math.max(read.largest, size);
      return turn;
    },
    text: (run, seq, range) => {
      const part = store.text(run, seq, range), size = Buffer.byteLength(part.text, "utf8");
      read.texts++; if (range?.to === undefined) read.wholeTexts++; read.bytes += size; read.largest = Math.max(read.largest, size);
      return part;
    },
  };
  const budget = { cap: 6000, user: 2500, window: 128_000, windowSource: "assumed" as const };
  const history = rowsHistory(conversation, spy), asked = history.turn(TURNS)!.run, owed = conversation.runs.slice(0, TURNS).map(run => run.id);
  const context = buildPublicContext(history, asked, owed, { names, budget });

  t.diagnostic("read: " + JSON.stringify(read) + " of " + held + " bytes held; packet " + context.relay.tokens + " tokens, " + context.relay.turns.shown + " of " + TURNS + " Turns shown");
  assert.equal(read.whole, 1, "only the Turn that asks is read whole");
  assert.equal(read.outlines, TURNS, "every Turn it owes is looked at once, without its words");
  assert.ok(read.wholeTexts <= 200, "the words read whole are those of the few it weighs: " + read.wholeTexts + " of " + TURNS * 2);
  assert.ok(read.bytes < held / 4, "the words read are a small part of the " + held + " bytes the history holds: " + read.bytes);
  // What is in memory at once is one read at most (a text is taken, weighed and let go): the five replies of 3 MiB are never read whole, a packet of 6,000 tokens cannot carry them.
  assert.ok(read.largest <= 256 * 1024, "no read is larger than the look at the start of a text that the whole room asks for (about 160 KiB): " + read.largest);
  // The ledger counts the whole of it.
  const record = context.relay;
  assert.equal(record.turns.total, TURNS); assert.equal(record.turns.shown + record.turns.absent, TURNS); assert.ok(record.turns.absent > 0, "a packet of 6,000 tokens does not carry 2,000 Turns");
  assert.equal(record.items.userMessages.total, TURNS); assert.equal(record.items.replies.total, TURNS); assert.equal(record.items.calls.total, TURNS);
  for (const kind of ITEM_KINDS) assert.equal(record.items[kind].included + record.items[kind].omitted, record.items[kind].total, kind + ": carried + left out = what the record holds");
  assert.equal(record.tier, "brief"); assert.ok(record.tokens <= budget.cap, "the packet is within its budget: " + record.tokens);
  // The packet the whole read makes.
  const whole = snapshotHistory(store.snapshot(id)), wholeAsked = whole.turn(TURNS)!.run;
  const reference = buildPublicContext(whole, wholeAsked, owed, { names, budget });
  assert.equal(context.text, reference.text); assert.deepEqual(context.relay, reference.relay); assert.deepEqual(context.sourceRunIds, reference.sourceRunIds);
});

test("a packet that fits whole carries every Turn, and reads their words to write them: the same packet as the whole read", { timeout: 120_000 }, t => {
  let opened: SqliteConversationStore | undefined;
  t.after(() => opened?.close());
  const store = opened = appStore(join(temporary(t), "data")), id = created(store, newConversation("/work", "small")).conversation.id, scenario = new Scenario(store, id, "run-small", false);
  // Every fourth reply is longer than an outline carries (OUTLINE_INLINE_BYTES): its words are read when the packet writes them.
  for (let turn = 0; turn < 12; turn++) { scenario.accept("question " + turn); scenario.start(turn); scenario.say(turn, "the answer " + turn + " " + "ok ".repeat(turn % 4 === 0 ? 700 : 20)); scenario.tool(turn, "read-" + turn); scenario.finish(turn); }
  scenario.accept("go on");
  const conversation = store.get(id), history = rowsHistory(conversation, store), owed = conversation.runs.slice(0, 12).map(run => run.id);
  const context = buildPublicContext(history, history.turn(12)!.run, owed, { names });
  const whole = snapshotHistory(store.snapshot(id)), reference = buildPublicContext(whole, whole.turn(12)!.run, owed, { names });
  assert.equal(context.relay.tier, "full");
  assert.equal(context.text, reference.text); assert.deepEqual(context.relay, reference.relay);
});
