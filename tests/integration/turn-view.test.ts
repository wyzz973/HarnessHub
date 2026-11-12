import assert from "node:assert/strict";
import test from "node:test";
import { builtinHarnessName } from "../../src/cli/session-application.js";
import { detailHead, projectTurns, runEnded, runItemStatus, type ProjectionEnv, type ToolDetailInput } from "../../src/contexts/session/domain/protocol/index.js";
import type { ContentRef } from "../../src/contracts/content.js";
import type { ProtocolItem, ProtocolTurn } from "../../src/contracts/protocol.js";
import { relayDecisionOf, type RelayDecision } from "../../src/contracts/relay.js";
import type { PublicMessage, PublicRun, SessionEvent, SessionId, SessionSnapshot } from "../../src/contracts/session.js";
import type { WireTurn } from "../../src/contracts/web.js";
import { ConversationFacts } from "../../src/infrastructure/session/facts.js";
import { ConversationTables } from "../../src/infrastructure/session/read.js";
import { readDeliveriesV14 } from "../../src/infrastructure/session/relay-rows-v14.js";
import { LINE_SEQ, TurnView, turnFactsOf, type TurnEnv, type TurnFacts } from "../../src/web/turn-view.js";
import { runViews, type RunViewReads } from "../fixtures/old-shape.js";
import { V13_FIXTURES, type V13Fixture } from "../fixtures/storage/v13/database.js";
import { migrated } from "../fixtures/migrated.js";
import { SESSION, item, replyItem, run, toolItem, userItem } from "../fixtures/conversation-builder.js";
import { runRowOf } from "../../src/infrastructure/session/rows.js";
import type { HeldItem, RunRow } from "../../src/contracts/conversation.js";
import type { NativeSessionBinding } from "../../src/contracts/session.js";

// A conversation read from its rows (src/web/turn-view.ts) against the same conversation read by the step-1 projection from the snapshot it was converted from
// (contexts/session/domain/protocol/project.ts): every Turn of every frozen v13 fixture, migrated to v14 in a temporary database. The header is equal. The items are
// equal as a multiset once the places and ids are left out (the projection counted from 0 and named them `hh:…`; the rows count from 1 and are named by the item ids
// of ADR-057 3.2) — except for the classes of difference below, each of which is named, shown to hold only where its cause is, and shown to have happened at least once.

const harnessName = builtinHarnessName();

/** The relay's reading of the Runs of one conversation, the same inputs for both paths: the delivery rows and the decisions the events recorded, through the oracle of what the old view showed (`runViews`). */
function relayReads(db: import("node:sqlite").DatabaseSync): RunViewReads {
  const events = (id: SessionId, afterSeq: number, limit = 100): readonly SessionEvent[] =>
    db.prepare("SELECT event_json FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?").all(id, afterSeq, limit).map(row => JSON.parse(String(row.event_json)) as SessionEvent);
  return { relayDeliveries: (id: SessionId) => readDeliveriesV14(db, id), events };
}
const contentHeads = (fixture: V13Fixture): ((ref: ContentRef) => ToolDetailInput | null) => ref => {
  const text = fixture.contents[ref.id]?.text;
  if (text === undefined) return null;
  try { return detailHead(JSON.parse(text) as unknown); } catch { return null; }
};

interface Both { readonly id: SessionId; readonly snapshot: SessionSnapshot; readonly old: readonly ProtocolTurn[]; readonly now: readonly WireTurn[] }
function read(fixture: V13Fixture, db: import("node:sqlite").DatabaseSync, row: V13Fixture["sessions"][number], detail: boolean): Both {
  const snapshot = JSON.parse(JSON.stringify(row.snapshot)) as SessionSnapshot, id = snapshot.id;
  const runs = runViews(snapshot, relayReads(db));
  const env: ProjectionEnv = { harnessName, detail: detail ? contentHeads(fixture) : () => null };
  const old = projectTurns({ runs, messages: snapshot.messages, nativeBindings: snapshot.nativeBindings }, env);
  const reader = new ConversationTables(db), facts = new ConversationFacts(db);
  const turnEnv: TurnEnv = { harnessName, ...(detail ? { detail: contentHeads(fixture) } : {}) };
  const relay = (r: { readonly ordinal: number }) => { const shown = runs[r.ordinal]?.relay; return { ...(shown?.delivery === undefined ? {} : { delivery: shown.delivery }), ...(shown?.decision === undefined ? {} : { decision: shown.decision as RelayDecision }) }; };
  const view = new TurnView(turnFactsOf(id, facts, relay), turnEnv);
  const now: WireTurn[] = [];
  for (let ordinal = 0; ordinal < snapshot.runs.length; ordinal++) now.push(view.turn(reader.turnAt(id, ordinal, { inlineBytes: Infinity })!));
  return { id, snapshot, old, now };
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item === null || typeof item !== "object" || Array.isArray(item) ? item
  : Object.fromEntries(Object.keys(item as object).sort().map(key => [key, (item as Record<string, unknown>)[key]])));

/** An item as the comparison sees it: no id, no place, the parent as the Harness named it, and the words of a message where the old shape kept them apart. */
function shape(item: ProtocolItem, messages: ReadonlyMap<string, PublicMessage>): Record<string, unknown> {
  const { id: _id, seq: _seq, ...rest } = item as ProtocolItem & Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (typeof out.parentId === "string" && out.parentId.startsWith("tool:")) out.parentId = out.parentId.slice(5);
  if ((item.type === "user_message" || item.type === "assistant_message") && out.text === undefined) out.text = messages.get(item.messageId)?.text ?? null;
  return out;
}


// ---------------------------------------------------------------------------------------------------------------------
// The differences, by class. Each is a way in which the rows say more, or say it more truthfully, than the old fields did.
// ---------------------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const without = (value: Rec, ...keys: string[]): Rec => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const same = (left: Rec, right: Rec, ...ignore: string[]): boolean => canonical(without(left, ...ignore)) === canonical(without(right, ...ignore));

interface Cause { readonly run: PublicRun; readonly turn: Omit<ProtocolTurn, "items"> }
/** Why an item of the projection and an item of the rows, alike but for one thing, differ; null when nothing explains it. */
function explained(old: Rec, now: Rec, cause: Cause): string | null {
  if (old.type !== now.type) return null;
  const { run, turn } = cause, over = runEnded(run.status);
  switch (old.type) {
    case "assistant_message":
      // The projection called the reply of every Turn its answer. Only a Turn that completed has one (ADR-057 3.2, review I4): a reply cut short by a failure, a stop or a lost connection is not an answer.
      if (same(old, now, "phase") && old.phase === "final" && now.phase === "commentary" && turn.status !== "completed") return "an unfinished Turn's reply is not marked final";
      return null;
    case "reasoning":
      // The projection said "completed" for the thinking of any Turn that was over: the rows say how the Turn ended (the closing table of ADR-057 3.2).
      if (same(old, now, "status") && now.status === runItemStatus(run.status) && old.status !== now.status) return "thinking of an unfinished Turn is closed as the Turn ended";
      // (The projection used to keep only the first 64 KiB of a longer thinking and say so; a thought has no length it may not pass any more, so both keep it whole and that class of difference is gone.)
      return null;
    case "subagent": case "notice": case "context_event": {
      // An activity that was running when its Turn ended did not finish: the rows say `unknown` (`cancelled` for a Turn that was stopped), the projection kept the Harness's last word.
      const closed = !over ? now.status : run.status === "cancelled" ? "cancelled" : "unknown";
      if (same(old, now, "status") && old.status === "running" && over && now.status === closed) return "an activity left open is closed with its Turn";
      return null;
    }
    case "plan": {
      // A step's priority is what the Harness said of it; the projection left it out, the rows keep it (the page does not show it).
      const steps = (item: Rec) => (item.steps as Rec[]).map(step => without(step, "priority"));
      if (same(old, now, "steps") && canonical(steps(old)) === canonical(steps(now)) && (now.steps as Rec[]).some(step => step.priority !== undefined)) return "a plan step keeps its priority";
      return null;
    }
    default: return null;
  }
}

test("every Turn of every frozen fixture reads from its rows as the projection reads it from its snapshot, but for the named classes of difference", t => {
  const seen = new Map<string, number>(), met = new Map<string, number>();
  const count = (kind: string): void => { seen.set(kind, (seen.get(kind) ?? 0) + 1); };
  const covered = (kind: string): void => { met.set(kind, (met.get(kind) ?? 0) + 1); };
  let turns = 0, reordered = 0;
  for (const name of V13_FIXTURES) {
    const m = migrated(t, name);
    for (const row of m.fixture.sessions) {
      const both = read(m.fixture, m.db, row, true);
      const messages = new Map(both.snapshot.messages.map(message => [message.id as string, message]));
      assert.equal(both.now.length, both.old.length, name);
      both.old.forEach((oldTurn, index) => {
        const where = name + "/" + both.id + " Turn " + (index + 1), newTurn = both.now[index]!, run = both.snapshot.runs[index]!;
        const { items: oldItems, ...oldHeader } = oldTurn;
        // The header: the same Turn. (`legacyOrder` is the one thing the rows add: a converted Turn's items stand in the fixed order of ADR-057 3.2.)
        const { legacyOrder, ...header } = newTurn.run.turn;
        assert.equal(legacyOrder, true, where);
        assert.deepEqual(JSON.parse(canonical(header)), JSON.parse(canonical(oldHeader)), where + ": the header");
        assert.equal(newTurn.run.ordinal, index, where); assert.equal(newTurn.run.id, run.id, where); assert.equal(newTurn.run.userSeq, messages.get(run.userMessageId)!.seq, where);
        turns++;
        // What the rows hide or fold as the projection did (and agree with it on, below) was met in the fixtures: the task list read from a call's input, a sub-agent told twice, a thinking of no words.
        if (run.plan !== undefined && (run.tools ?? []).some(tool => /todo|update_plan/iu.test(tool.name ?? tool.title))) covered("a task-list call hidden by the Run's own plan");
        if ((run.activities ?? []).some(activity => (activity.kind === "subagent" || activity.kind === "task") && (run.tools ?? []).some(tool => tool.id === activity.id || tool.id === "agent:" + activity.id))) covered("a sub-agent told as a call and as an activity");
        if (run.thinking === "") covered("a thinking of no words");

        // The items, as a multiset without ids and places.
        const cause: Cause = { run, turn: header };
        const left = oldItems.map(item => shape(item, messages)), right = newTurn.items.map(item => shape(item, messages));
        const leftOver: Rec[] = [];
        for (const entry of left) { const at = right.findIndex(other => canonical(other) === canonical(entry)); if (at < 0) leftOver.push(entry); else right.splice(at, 1); }
        for (const entry of leftOver) {
          const at = right.findIndex(other => explained(entry, other, cause) !== null);
          assert.ok(at >= 0, where + ": an item of the projection that the rows do not have, or have differently, with no class to explain it:\n" + canonical(entry).slice(0, 600) + "\nthe rows' items left: " + right.map(item => canonical(item).slice(0, 300)).join("\n  "));
          count(explained(entry, right[at]!, cause)!); right.splice(at, 1);
        }
        // What the rows have and the projection did not: an error the Harness told as a notice while the Run also reported its own (the projection told it once), and nothing else.
        for (const entry of right) {
          const notice = (run.notices ?? []).find(item => item.severity === "error" && (item.detail === undefined ? item.title : item.title + "\n" + item.detail) === entry.message);
          assert.ok(entry.type === "error" && entry.class === "unknown" && notice !== undefined && run.error !== null, where + ": an item of the rows that the projection does not have:\n" + canonical(entry).slice(0, 600));
          count("an error told as a notice is kept beside the Run's own error");
        }

        // The order: but for where the items made from activities stand (the rows keep the activities together, in their own order, before the plan; the projection spread them: a
        // sub-agent after the calls, a retry or a review after the notices, a compaction after the artifacts) and where the lines that end the Turn stand (the projection told the
        // error between the reply and the artifacts), it is the projection's order.
        const fromActivity = (id: string): boolean => /^(hh:(subagent|retry|review|context):|activity:)/u.test(id);
        const ending = (item: ProtocolItem): boolean => item.id === "hh:error" || item.id === "hh:clear";
        const oldOrder = oldItems.filter(item => !fromActivity(item.id) && !ending(item) && !(item.type === "error")).map(item => item.type), newOrder = newTurn.items.filter(item => !fromActivity(item.id) && !ending(item) && !(item.type === "error")).map(item => item.type);
        assert.deepEqual(newOrder, oldOrder, where + ": the order of the other items");
        if (oldItems.map(item => item.type).join() !== newTurn.items.map(item => item.type).join()) reordered++;
        // Between the lines: the hand-over line first, the lines that end it last, the rows between in the order of their places.
        const places = newTurn.items.map(item => item.seq);
        assert.deepEqual(places, [...places].sort((a, b) => a - b), where + ": the items stand in the order of their places");
        assert.ok(newTurn.items.every(item => item.type === "switch" ? item.seq === 0 : true), where);
      });
    }
  }
  assert.ok(turns > 100, "the fixtures hold " + turns + " Turns");
  // Every class of difference was met; a class that is never met is an explanation that explains nothing.
  assert.deepEqual([...seen.keys()].sort(), [
    "a plan step keeps its priority", "an activity left open is closed with its Turn", "an error told as a notice is kept beside the Run's own error",
    "an unfinished Turn's reply is not marked final", "thinking of an unfinished Turn is closed as the Turn ended"]);
  assert.deepEqual([...met.keys()].sort(), ["a sub-agent told as a call and as an activity", "a task-list call hidden by the Run's own plan", "a thinking of no words"]);
  console.log("Turns compared: " + turns + " (" + reordered + " with the items made from activities or the Run's error standing elsewhere than the projection put them); differences by class: " + JSON.stringify(Object.fromEntries(seen)));
});

// ---------------------------------------------------------------------------------------------------------------------
// Turns the new Runtime writes (no snapshot to compare with): read from handmade rows
// ---------------------------------------------------------------------------------------------------------------------

const stubFacts = (rows: readonly RunRow[], over: Partial<TurnFacts> = {}): TurnFacts => ({
  previous: row => rows[row.ordinal - 1] ?? null,
  lastDispatched: (harnessId, controlId) => rows.findLast(row => row.dispatched && row.harnessId === harnessId && row.controlId === controlId)?.ordinal ?? null,
  bindings: () => [], relay: () => ({}), ...over,
});
const rowOf = (...args: Parameters<typeof run>): RunRow => runRowOf(SESSION, run(...args));
const started = { acceptedAt: 1000, preparingAt: 1001, readyAt: 1002, dispatchedAt: 1003, endedAt: 1900 };
const kinds = (wire: WireTurn): string[] => wire.items.map(entry => entry.type + ":" + entry.seq);
/** A reply segment as the Runtime places it: no `phase` (the reader works out which segment is the answer; the Harness said nothing of it). */
const segment = (id: string, seq: number, n: number, status: HeldItem["status"], text: readonly string[]): HeldItem => item(id, seq, "text:" + n, "assistant_message", status, { messageId: "message-reply-" + id }, text);

test("a Turn the new Runtime wrote reads in the order its items were placed, between the hand-over line and the lines that end it, with the answer marked once it completed", () => {
  const before = rowOf(0, "completed", [userItem("run-0", "hi")], { selection: { harnessId: "alpha", controlId: "alpha-acp" }, timing: started }), [first] = [before];
  const items = [userItem("run-1", "do it"), segment("run-1", 2, 1, "completed", ["Looking at ", "the tests."]), toolItem("run-1", 3, "t", "completed", { exitCode: 0 }),
    item("run-1", 4, "think:1", "reasoning", "completed", {}, ["hmm"]), segment("run-1", 5, 2, "completed", ["All ", "done."]),
    item("run-1", 6, "notice:1", "notice", "completed", { severity: "info", native: { title: "Model fell back" } }, ["Model fell back"]), item("run-1", 7, "output:1", "artifact", "completed", { kind: "link", name: "report", uri: "https://example.invalid/r" })];
  const row = rowOf(1, "completed", undefined, { selection: { harnessId: "bravo", controlId: "bravo-acp" }, timing: started, backend: { status: "completed", reason: "end_turn" } });
  const view = new TurnView(stubFacts([first, row]), { harnessName });
  const wire = view.turn({ run: row, items });
  assert.deepEqual(kinds(wire), ["switch:0", "user_message:1", "assistant_message:2", "command:3", "reasoning:4", "assistant_message:5", "notice:6", "artifact:7"]);
  assert.deepEqual(wire.items.filter(entry => entry.type === "assistant_message").map(entry => [entry.seq, entry.type === "assistant_message" ? entry.phase : null, entry.type === "assistant_message" ? entry.text : null]),
    [[2, "commentary", "Looking at the tests."], [5, "final", "All done."]]);
  assert.equal(wire.run.turn.legacyOrder, undefined);
  assert.deepEqual([wire.run.turn.n, wire.run.turn.status, wire.run.turn.stopReason, wire.run.turn.durationMs, wire.run.ordinal], [2, "completed", "end_turn", 900, 1]);
  const hand = wire.items[0]!; assert.ok(hand.type === "switch"); assert.deepEqual([hand.id, hand.from.harnessId, hand.to.harnessId, hand.context], ["hh:switch", "alpha", "bravo", "unknown"]);
  // The answer of a Turn that did not complete is not marked; the Turn that failed tells its error last, with a class.
  const failed = rowOf(1, "failed", undefined, { selection: { harnessId: "alpha", controlId: "alpha-acp" }, timing: started, error: { code: "NATIVE_QUOTA_EXCEEDED", message: "quota" }, backend: { status: "failed", reason: "error" } });
  const bad = new TurnView(stubFacts([first, failed]), { harnessName }).turn({ run: failed, items });
  assert.deepEqual(bad.items.filter(entry => entry.type === "assistant_message").map(entry => entry.type === "assistant_message" ? entry.phase : null), ["commentary", "commentary"]);
  assert.deepEqual(bad.items.map(entry => entry.type).slice(-2), ["artifact", "error"]);
  const last = bad.items.at(-1)!; assert.ok(last.type === "error"); assert.deepEqual([last.id, last.seq, last.class, last.code, last.message], ["hh:error", LINE_SEQ.error, "quota", "NATIVE_QUOTA_EXCEEDED", "quota"]);
  assert.equal(bad.run.turn.stopReason, "error");
  // The answer is the last reply segment found past the notices, the plan, the artifacts and the context events; a Turn that ended on an action has none.
  const onAction = new TurnView(stubFacts([first, row]), { harnessName }).turn({ run: row, items: [...items.slice(0, 5), toolItem("run-1", 6, "late", "completed")] });
  assert.deepEqual(onAction.items.filter(entry => entry.type === "assistant_message").map(entry => entry.type === "assistant_message" ? entry.phase : null), ["commentary", "commentary"]);
});

test("a Turn with an approval that waits is waiting while it runs, and says so no more when it is over", () => {
  const approval = item("run-0", 2, "permission:p1", "approval", "waiting", { subject: "command", title: "Run rm -rf build", options: [{ id: "yes", role: "allow_once", label: "Allow" }] });
  const running = rowOf(0, "running", undefined, { timing: { acceptedAt: 1000, dispatchedAt: 1003 } });
  assert.equal(new TurnView(stubFacts([running]), { harnessName }).turn({ run: running, items: [userItem("run-0", "x"), approval] }).run.turn.status, "waiting");
  assert.equal(new TurnView(stubFacts([running]), { harnessName }).turn({ run: running, items: [userItem("run-0", "x")] }).run.turn.status, "running");
  const over = rowOf(0, "cancelled", undefined, { timing: started, cancelRequested: true });
  const wire = new TurnView(stubFacts([over]), { harnessName }).turn({ run: over, items: [userItem("run-0", "x"), { ...approval, status: "cancelled" }] });
  assert.deepEqual([wire.run.turn.status, wire.run.turn.stopReason], ["cancelled", "user_stopped"]);
});

test("the words of an item are its chunks joined with the lone surrogates it carried put back; a notice's label is the one it has now; a text left out is told by its size", () => {
  const view = new TurnView(stubFacts([]), { harnessName }), row = rowOf(0, "completed", undefined, { timing: started });
  // A reply cut in the middle of a pair: the column holds U+FFFD, and the item says which unit stood there (ADR-057 3.2, review I3).
  const cut = segment("run-0", 2, 1, "completed", ["half \ufffd"]);
  const mended = view.item(row, { ...cut, fields: { ...cut.fields, native: { surrogates: [[5, 0xd83d]] } } as typeof cut.fields });
  assert.equal(mended.type === "assistant_message" ? mended.text : null, "half \ud83d");
  // A retry told as an activity: its first words are the chunk and never change, the current ones are native.title.
  const retry = item("run-0", 3, "activity:retry", "notice", "running", { severity: "warning", code: "retry", native: { title: "retry 3 of 5", kind: "retry", status: "running" } }, ["retry 1 of 5"]);
  const told = view.item(row, retry); assert.equal(told.type === "notice" ? told.text : null, "retry 3 of 5");
  // A reply left out of a page for its size: no text, its size, and the mark; the same for an item whose JSON was left out.
  const long = view.item(row, { ...segment("run-0", 4, 2, "completed", []), textBytes: 70_000, textOmitted: true });
  assert.deepEqual([long.bodyOmitted, long.textBytes, "text" in long], [true, 70_000, false]);
  const stub = view.item(row, { ...item("run-0", 5, "tool:edit", "file_change", "completed", { changes: [] }), bodyOmitted: true });
  assert.deepEqual([stub.bodyOmitted, stub.type], [true, "file_change"]);
  // A thinking that said nothing is no line; a reasoning with words is.
  const quiet = new TurnView(stubFacts([row]), { harnessName }).turn({ run: row, items: [userItem("run-0", "x"), item("run-0", 2, "think:1", "reasoning", "completed", {}, []), item("run-0", 3, "think:2", "reasoning", "completed", {}, ["words"])] });
  assert.deepEqual(kinds(quiet), ["user_message:1", "reasoning:3"]);
});

test("the model of a Turn is the one its selection named; a Turn that named none shows the one its control reported only while it is the latest Turn of that control", () => {
  const rows = [rowOf(0, "completed", undefined, { timing: started }), rowOf(1, "completed", undefined, { timing: started }), rowOf(2, "completed", undefined, { timing: started, selection: { harnessId: "alpha", controlId: "alpha-acp", nativeModel: "claude-opus-5-5" } })]
    .map(row => ({ ...row, dispatched: true }));
  const binding: NativeSessionBinding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-1", throughRunId: null, status: "ready", observed: { model: "claude-sonnet-5-5", options: {} }, relay: { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false } };
  const models = (facts: TurnFacts) => rows.map(row => new TurnView(facts, { harnessName }).executor(row).model?.label);
  // The third Turn is the latest of the control and named its model; the first two named none and are not the latest: no model is claimed for them.
  assert.deepEqual(models(stubFacts(rows, { bindings: () => [binding] })), [undefined, undefined, "Claude Opus 5.5"]);
  // Without the third Turn the second is the latest, and the control's own report is its model.
  const two = rows.slice(0, 2);
  assert.deepEqual(two.map(row => new TurnView(stubFacts(two, { bindings: () => [binding] }), { harnessName }).executor(row).model?.label), [undefined, "Claude Sonnet 5.5"]);
  // An archived binding says nothing of the model.
  assert.equal(new TurnView(stubFacts(two, { bindings: () => [{ ...binding, status: "archived" }] }), { harnessName }).executor(two[1]!).model, undefined);
});

test("what a Run carries beside its Turn: the relay's reading in its relay member, no display field, no HMAC, and the lines a commit sends with it", () => {
  const relay = { packetId: null, kind: null, continuity: { kind: "native_resume" as const }, executedOn: null };
  const row = rowOf(0, "completed", undefined, { timing: started, relay, relayRequest: { fingerprint: "f".repeat(64), attach: "full" } as never, usage: { turn: { input: 1, output: 2 } } as never });
  const view = new TurnView(stubFacts([row], { relay: () => ({ delivery: { state: "unknown", evidence: null }, decision: { kind: "alone", by: "user" } }) }), { harnessName });
  const wire = view.run(row);
  assert.deepEqual(wire.relay, { ...relay, delivery: { state: "unknown", evidence: null }, decision: { kind: "alone", by: "user" } });
  for (const hidden of ["relayRequest", "input", "thinking", "tools", "protocol", "usage"]) assert.equal(hidden in wire, false, hidden);
  // A message that went alone though something was owed says so, between the same executor and itself; `derived` is what the stream sends beside the Run.
  const lines = view.derived(row);
  assert.deepEqual(lines.map(entry => [entry.id, entry.seq, entry.type]), [["hh:switch", 0, "switch"]]);
});

test("the Harness's task list is the plan of the Turn and not a row: its own plan stands for every call, else the last call whose input reads exactly gives it; a call that cannot be read stays a row", () => {
  const ref = { id: "content-todo-1" as never, name: "t.json", mediaType: "application/json", kind: "file" as const, bytes: 1, sha256: "2".repeat(64) };
  const todos = JSON.stringify({ todos: [{ content: "read", status: "completed" }, { content: "write", status: "pending" }] });
  const call = (seq: number, id: string, withDetail = true): HeldItem => item("run-0", seq, "tool:" + id, "tool", "completed", { name: "todowrite", ...(withDetail ? { detail: ref } : {}), native: { title: "2 todos", name: "todowrite", status: "completed" } });
  const row = rowOf(0, "completed", undefined, { timing: started });
  const env = (input: string | undefined): TurnEnv => ({ harnessName, detail: () => input === undefined ? null : { input } });
  const turn = (items: readonly HeldItem[], over: TurnEnv) => new TurnView(stubFacts([row]), over).turn({ run: row, items });
  const user = userItem("run-0", "plan it"), reply = segment("run-0", 5, 1, "completed", ["ok"]);
  // Read: the call is gone, the plan stands where the last call stood, as the projection tells it.
  const read = turn([user, call(2, "a"), toolItem("run-0", 3, "b", "completed"), call(4, "c"), reply], env(todos));
  assert.deepEqual(kinds(read), ["user_message:1", "command:3", "plan:4", "assistant_message:5"]);
  const plan = read.items[2]!; assert.ok(plan.type === "plan"); assert.deepEqual([plan.id, plan.status, plan.steps], ["hh:plan", "completed", [{ text: "read", status: "completed" }, { text: "write", status: "pending" }]]);
  // Not readable (the input is not a task list, or the detail cannot be read now): the calls are rows, as they were.
  assert.deepEqual(kinds(turn([user, call(2, "a"), reply], env("not json"))), ["user_message:1", "tool:2", "assistant_message:5"]);
  assert.deepEqual(kinds(turn([user, call(2, "a"), reply], env(undefined))), ["user_message:1", "tool:2", "assistant_message:5"]);
  assert.deepEqual(kinds(turn([user, call(2, "a", false), reply], env(todos))), ["user_message:1", "tool:2", "assistant_message:5"]);
  // The Run's own plan stands for every call, readable or not, and is the plan.
  const own = item("run-0", 3, "plan", "plan", "completed", { steps: [{ text: "mine", status: "pending" }] });
  assert.deepEqual(kinds(turn([user, call(2, "a"), own, reply], env("not json"))), ["user_message:1", "plan:3", "assistant_message:5"]);
  // A sub-agent the Harness told as a call and as an activity is the call; one only the activity knows stays.
  const agent = item("run-0", 2, "tool:agent:thread-1", "subagent", "completed", { title: "Dewey", native: { title: "子 Agent · Dewey", kind: "subagent", name: "codex-subagent", status: "completed" } });
  const told = item("run-0", 3, "activity:thread-1", "subagent", "completed", { title: "Dewey", native: { title: "Dewey", kind: "subagent", status: "completed" } });
  const only = item("run-0", 4, "activity:w", "subagent", "running", { title: "Wren", native: { title: "Wren", kind: "subagent", status: "running" } });
  assert.deepEqual(kinds(turn([user, agent, told, only, reply], { harnessName })), ["user_message:1", "subagent:2", "subagent:4", "assistant_message:5"]);
});
