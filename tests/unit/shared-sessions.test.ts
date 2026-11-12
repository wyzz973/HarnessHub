import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { decideMoves, heldTwice, liveHoldings, withMoves, type Holding, type Usage } from "../../src/infrastructure/session/shared-sessions.js";

// The rule for a native session two conversations hold (src/infrastructure/session/shared-sessions.ts), on its own: who keeps it, in every kind of tie, and what is looked at.

const holding = (sessionId: string, position: number, extra: Partial<Holding> = {}): Holding =>
  ({ sessionId, position, ordinal: 0, harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-1", converted: false, ...extra });
const using = (table: Readonly<Record<string, Usage>>) => (found: Holding): Usage => table[found.sessionId] ?? { usedAt: null, updatedAt: 0 };
const moves = (list: readonly Holding[], table: Readonly<Record<string, Usage>>) => decideMoves(list, using(table)).map(move => move.sessionId + ">" + move.keptBy);

test("the holder that used the native session last keeps it, whatever the order of the conversations or how lately each was changed", () => {
  assert.deepEqual(moves([holding("a", 1), holding("b", 2)], { a: { usedAt: 100, updatedAt: 900 }, b: { usedAt: 200, updatedAt: 300 } }), ["a>b"]);
  assert.deepEqual(moves([holding("a", 1), holding("b", 2)], { a: { usedAt: 300, updatedAt: 1 }, b: { usedAt: 200, updatedAt: 900 } }), ["b>a"]);
});
test("a holder that no Run was dispatched into is taken at its conversation's latest update", () => {
  assert.deepEqual(moves([holding("a", 1), holding("b", 2)], { a: { usedAt: 100, updatedAt: 150 }, b: { usedAt: null, updatedAt: 500 } }), ["a>b"], "a conversation changed after the other's last use keeps it");
  assert.deepEqual(moves([holding("a", 1), holding("b", 2)], { a: { usedAt: 100, updatedAt: 150 }, b: { usedAt: null, updatedAt: 50 } }), ["b>a"]);
});
test("a tie goes to the conversation changed last, then to the one made first", () => {
  assert.deepEqual(moves([holding("a", 1), holding("b", 2)], { a: { usedAt: 100, updatedAt: 200 }, b: { usedAt: 100, updatedAt: 300 } }), ["a>b"]);
  assert.deepEqual(moves([holding("a", 1), holding("b", 2)], { a: { usedAt: 100, updatedAt: 200 }, b: { usedAt: 100, updatedAt: 200 } }), ["b>a"], "the same in everything: the one made first keeps");
  assert.deepEqual(moves([holding("b", 2), holding("a", 1)], { a: { usedAt: 100, updatedAt: 200 }, b: { usedAt: 100, updatedAt: 200 } }), ["b>a"], "whatever order the holdings come in");
});
test("three holders leave one, and each of the others gives its binding up to it", () => {
  const list = [holding("a", 1), holding("b", 2), holding("c", 3, { ordinal: 2 })];
  const found = decideMoves(list, using({ a: { usedAt: 10, updatedAt: 10 }, b: { usedAt: 30, updatedAt: 30 }, c: { usedAt: 20, updatedAt: 20 } }));
  assert.deepEqual(found.map(move => ({ ...move })), [{ sessionId: "a", ordinal: 0, harnessId: "alpha", controlId: "alpha-acp", keptBy: "b" }, { sessionId: "c", ordinal: 2, harnessId: "alpha", controlId: "alpha-acp", keptBy: "b" }]);
});
test("a conversation that is converted already keeps what it holds, and nothing is asked of it", () => {
  const asked: string[] = [];
  const found = decideMoves([holding("a", 1, { converted: true }), holding("b", 2)], found_ => { asked.push(found_.sessionId); return { usedAt: 10 ** 12, updatedAt: 10 ** 12 }; });
  assert.deepEqual(found.map(move => move.sessionId + ">" + move.keptBy), ["b>a"]); assert.deepEqual(asked, ["b"]);
  assert.deepEqual(decideMoves([holding("a", 1, { converted: true }), holding("b", 2, { converted: true })], using({})), [], "two converted holders are the table's business, not a decision");
});
test("only a native session held twice is a group: a different Harness control, a different native session, or one holder alone is not", () => {
  const list = [holding("a", 1), holding("b", 2, { checkpoint: "native-2" }), holding("c", 3, { controlId: "other-acp" }), holding("d", 4, { harnessId: "bravo", controlId: "bravo-acp" })];
  assert.deepEqual(decideMoves(list, using({})), []); assert.equal(heldTwice(list), 0);
  assert.equal(heldTwice([...list, holding("e", 5)]), 1);
  assert.equal(heldTwice([holding("a", 1), holding("a", 1, { ordinal: 1 })]), 0, "one conversation twice is one holder");
});

test("the holdings are the live ones a conversation can resume: ready or unconfirmed, and not a binding that opens a new native session; converted conversations are read from their rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, head TEXT, format INTEGER); CREATE TABLE bindings(session_id TEXT, ordinal INTEGER, harness_id TEXT, control_id TEXT, checkpoint TEXT, status TEXT, opens_new INTEGER)");
    const binding = (checkpoint: string, status: string, extra: object = {}) => ({ harnessId: "alpha", controlId: "alpha-acp", checkpoint, status, ...extra });
    const put = (id: string, format: number, bindings?: object[]) => db.prepare("INSERT INTO sessions(id,head,format) VALUES(?,?,?)").run(id, JSON.stringify(bindings === undefined ? {} : { nativeBindings: bindings }), format);
    put("a", 13, [binding("n1", "ready"), binding("n2", "archived"), binding("n3", "unconfirmed"), binding("n4", "ready", { opensNew: true }), binding("n5", "forking")]);
    put("b", 13); put("c", 14);
    db.prepare("INSERT INTO bindings VALUES('c',0,'alpha','alpha-acp','n1','ready',0),('c',1,'alpha','alpha-acp','n9','ready',1),('c',2,'alpha','alpha-acp','n8','archived',0)").run();
    assert.deepEqual(liveHoldings(db, "head").map(found => [found.sessionId, found.ordinal, found.checkpoint, found.converted]), [["a", 0, "n1", false], ["a", 2, "n3", false], ["c", 0, "n1", true]]);
    assert.deepEqual(decideMoves(liveHoldings(db, "head"), using({})).map(move => move.sessionId + ">" + move.keptBy), ["a>c"], "the converted conversation keeps n1");
  } finally { db.close(); }
});

test("archiving changes the status of the bindings it is told to and nothing else, and refuses a binding that holds no native session", () => {
  const binding = (checkpoint: string, status: string, extra: object = {}) => ({ harnessId: "alpha", controlId: "alpha-acp", checkpoint, throughRunId: null, status, relay: { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false }, ...extra });
  const state = { id: "session-x", nativeBindings: [binding("n1", "ready"), binding("n2", "unconfirmed"), binding("n3", "archived"), binding("n4", "ready", { opensNew: true })] } as unknown as SessionSnapshot;
  assert.equal(withMoves(state, new Set()), state, "nothing to give up: the very same object");
  const moved = withMoves(state, new Set([0, 1]));
  assert.deepEqual(moved.nativeBindings!.map(item => item.status), ["archived", "archived", "archived", "ready"]);
  assert.deepEqual(moved.nativeBindings!.map(item => ({ ...item, status: "" })), state.nativeBindings!.map(item => ({ ...item, status: "" })), "every other field of every binding is as it was");
  assert.deepEqual({ ...moved, nativeBindings: undefined }, { ...state, nativeBindings: undefined });
  for (const ordinal of [2, 3, 9]) assert.throws(() => withMoves(state, new Set([ordinal])), (error: unknown) => error instanceof SessionError && error.code === "MIGRATION_MISMATCH", "binding " + ordinal);
});
