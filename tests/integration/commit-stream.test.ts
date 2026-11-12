import assert from "node:assert/strict";
import test from "node:test";
import { builtinHarnessName } from "../../src/cli/session-application.js";
import type { Conversation, ConversationRun, HeldItem, Mutation } from "../../src/contracts/conversation.js";
import type { RunRelay } from "../../src/contracts/relay.js";
import { ConversationFacts } from "../../src/infrastructure/session/facts.js";
import { ConversationTables } from "../../src/infrastructure/session/read.js";
import { ConversationRoutes, type ConversationRoutesOptions } from "../../src/web/conversation-routes.js";
import { commitFrame } from "../../src/web/commit-frame.js";
import { applyCommit, fillText, incomplete, openWindow, replaceWithSnapshot, viewOf, type WindowState } from "../../web/src/lib/protocol/window.js";
import { assemble } from "../../web/src/lib/protocol/assemble.js";
import { decodeSessionStreamFrameV14, decodeSessionViewV14, decodeTurnPageView } from "../../web/src/lib/protocol/wire.js";
import {
  NOW, SESSION, commit, conversation, event, item, openDatabase, reduce, replaceRun, run, sendCommand, toolItem, userItem, type Committed, type Env,
} from "../fixtures/conversation-builder.js";
import { migrated } from "../fixtures/migrated.js";
import { V13_FIXTURES } from "../fixtures/storage/v13/database.js";

// The page's state, fed the frames the Gateway makes of a conversation's commits (src/web/commit-frame.ts, with the Runs and lines of src/web/turn-view.ts), is the window the Gateway
// reads of the conversation at that moment (src/web/conversation-routes.ts) — after every commit of a Turn that begins, speaks, thinks, works on another Harness, fails, is
// stopped, and says something too long for a frame. All of it through JSON, on a real database written by the store's own writes.

const harnessName = builtinHarnessName();
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const completed = { backend: { status: "completed" as const, reason: "end_turn" }, cleanup: { closed: true as const, exitCode: 0, signal: null, protocolFailure: null } };
const timing = { acceptedAt: NOW, preparingAt: NOW + 1, readyAt: NOW + 2, dispatchedAt: NOW + 3 };

/** The page and the Gateway for one conversation: the page's state, the commit that moves both, and the check that they agree. */
function harness(t: import("node:test").TestContext, over: { relay?: ConversationRoutesOptions["relay"]; detail?: ConversationRoutesOptions["env"]["detail"] } = {}) {
  const env: Env = openDatabase(t), tables = new ConversationTables(env.db);
  const routes = new ConversationRoutes({ reader: tables, facts: new ConversationFacts(env.db), relay: over.relay ?? (() => () => ({})), env: { harnessName, ...(over.detail === undefined ? {} : { detail: over.detail }) } });
  const state: { page: WindowState | null; conversation: Conversation | null; resyncs: string[]; frames: number; snapshots: number } = { page: null, conversation: null, resyncs: [], frames: 0, snapshots: 0 };
  /** What the Gateway reads of the conversation now, as the page reads it. */
  const read = () => decodeSessionViewV14(plain(routes.session(SESSION)));
  /** The page opens the conversation (a snapshot). */
  const open = (): void => { state.page = openWindow(read()); };
  /** One commit: written, framed from what was written, sent through JSON, applied by the page. */
  const step = (change: (current: Conversation) => Partial<Conversation>, events: readonly ReturnType<typeof event>[] = [event("run.output")]): Committed => {
    const before = state.conversation, after = before === null ? conversation([], change(conversation())) : reduce(before, change);
    const committed = commit(env, before, after, events);
    state.conversation = committed.conversation;
    const frame = commitFrame(committed.applied.changes, routes.headView(committed.applied.changes.head!.row), routes.frameViews(SESSION));
    // A commit the Gateway tells as the conversation (what it means is not a function of the rows it wrote) is a read, as the stream's hub does it.
    const asRead = routes.needsSnapshot({ conversation: committed.conversation, events: [], changes: committed.applied.changes });
    if (state.page !== null) {
      if (asRead) { state.page = replaceWithSnapshot(state.page, read()); state.snapshots++; }
      else {
        const result = applyCommit(state.page, decodeSessionStreamFrameV14(plain(frame)) as never);
        state.frames++;
        if (result.kind === "resync") state.resyncs.push(result.reason); else state.page = result.state;
      }
    }
    return committed;
  };
  /**
   * The page and the Gateway agree: the page holds what a read of the window gives now (its last Turns, when it holds more), and drawn for the renderer it is the same drawing.
   * `waiting`: the one thing a frame cannot say, because the Run's row does not change when an approval is asked: the page's header of a running Turn with a request that waits
   * is `running` until the page draws it, and the Gateway's read says `waiting` (both are drawn as `waiting`).
   */
  const agree = (where: string, options: { readonly waiting?: boolean } = {}): void => {
    const direct = read(), page = viewOf(state.page!), held = page.window.turns.slice(-direct.window.turns.length);
    const header = (turns: readonly (typeof held)[number][]) => options.waiting === true ? turns.map(turn => ({ ...turn, run: { ...turn.run, turn: { ...turn.run.turn!, status: "x" } } })) : turns;
    assert.deepEqual(plain(header(held)), plain(header(direct.window.turns)), where + ": the Turns");
    assert.deepEqual(plain(page.head), plain(direct.head), where + ": the head");
    const drawn = assemble(state.page!).runs.slice(-direct.window.turns.length), wanted = assemble(openWindow(direct)).runs;
    assert.deepEqual(plain(drawn), plain(wanted), where + ": drawn for the renderer");
    assert.deepEqual(state.resyncs, [], where + ": the page never had to read again");
  };
  return { env, tables, routes, state, read, open, step, agree };
}
const withItems = (state: Conversation, ordinal: number, change: (items: readonly HeldItem[]) => readonly HeldItem[]): Partial<Conversation> => ({ runs: replaceRun(state, ordinal, entry => ({ ...entry, items: change(entry.items!) })) });
const segment = (id: string, seq: number, n: number, status: HeldItem["status"], chunks: readonly string[]): HeldItem => item(id, seq, "text:" + n, "assistant_message", status, { messageId: "message-reply-" + id }, chunks);
const finish = (state: Conversation, ordinal: number, status: "completed" | "failed" | "cancelled", extra: Partial<ConversationRun> = {}): Partial<Conversation> => ({ activeRunId: null,
  runs: replaceRun(state, ordinal, entry => ({ ...entry, status, ...(status === "completed" ? completed : { backend: { status: status === "failed" ? "failed" as const : "cancelled" as const, reason: status === "failed" ? "error" : "interrupted" }, cleanup: completed.cleanup }),
    timing: { ...entry.timing!, endedAt: NOW + 900 }, items: entry.items!.map(it => ["running", "pending", "waiting"].includes(it.status) ? { ...it, status: status === "completed" ? "completed" as const : it.type === "assistant_message" || it.type === "reasoning" ? status : status === "cancelled" ? "cancelled" as const : "unknown" as const } : it), ...extra })) });
const queue = (state: Conversation, ordinal: number, text: string, extra: Partial<ConversationRun> = {}): Partial<Conversation> => ({ runs: [...state.runs, run(ordinal, "queued", [userItem("run-" + ordinal, text)], extra)], commands: [...state.commands, sendCommand(ordinal)] });
const start = (state: Conversation, ordinal: number): Partial<Conversation> => ({ activeRunId: state.runs[ordinal]!.id, runs: replaceRun(state, ordinal, entry => ({ ...entry, status: "running", timing })) });

test("a Turn that begins, speaks, thinks, works, speaks again and ends, framed commit by commit: the page holds what a read of the window gives after every one", t => {
  const h = harness(t);
  // A conversation with one Turn done, which the page opens.
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "first question"));
  h.step(current => start(current, 0));
  h.step(current => withItems(current, 0, items => [...items, segment("run-0", 2, 1, "running", ["first ", "answer"])]));
  h.step(current => finish(current, 0, "completed"));
  h.open(); h.agree("opened");
  const c = () => h.state.conversation!;
  // Turn 2: the input is accepted (the Run, your words), it starts.
  h.step(current => queue(current, 1, "你好 hi"), [event("message.accepted", { runId: "run-1" })]); h.agree("queued");
  h.step(current => start(current, 1), [event("run.started")]); h.agree("running");
  assert.equal(h.state.page!.turns.at(-1)!.run.status, "running");
  // It thinks, then speaks in two windows.
  h.step(current => withItems(current, 1, items => [...items, item("run-1", 2, "think:1", "reasoning", "running", {}, ["let me ", "see"])])); h.agree("thinking");
  h.step(current => withItems(current, 1, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, " the 文件"] } : it))); h.agree("thinking more");
  h.step(current => withItems(current, 1, items => [...items.map(it => it.seq === 2 ? { ...it, status: "completed" as const, endedAt: NOW + 10 } : it), segment("run-1", 3, 1, "running", ["Looking at "])])); h.agree("thought, speaking");
  h.step(current => withItems(current, 1, items => items.map(it => it.seq === 3 ? { ...it, text: [...it.text, "the 文件 now. "] } : it))); h.agree("speaking");
  // A call begins, goes on, ends (the reply segment closes when the call takes its place).
  h.step(current => withItems(current, 1, items => [...items.map(it => it.seq === 3 ? { ...it, status: "completed" as const, endedAt: NOW + 20 } : it), toolItem("run-1", 4, "t1", "running")])); h.agree("a call begins");
  h.step(current => withItems(current, 1, items => items.map(it => it.seq === 4 ? { ...it, status: "completed" as const, endedAt: NOW + 30, fields: { ...it.fields, exitCode: 0 } as typeof it.fields } : it))); h.agree("a call ends");
  h.step(current => withItems(current, 1, items => [...items, segment("run-1", 5, 2, "running", ["All "])])); h.agree("speaking again");
  h.step(current => withItems(current, 1, items => items.map(it => it.seq === 5 ? { ...it, text: [...it.text, "done. 😀"] } : it))); h.agree("speaking again, more");
  // The Turn ends: the Run, the last segment closed, and the answer marked in the same frame.
  h.step(current => finish(current, 1, "completed"), [event("run.ended")]); h.agree("ended");
  const last = h.state.page!.turns.at(-1)!;
  assert.deepEqual(last.items.map(entry => [entry.item.seq, entry.item.type, (entry.item as { phase?: string }).phase ?? null, entry.item.status]),
    [[1, "user_message", null, "completed"], [2, "reasoning", null, "completed"], [3, "assistant_message", "commentary", "completed"], [4, "command", null, "completed"], [5, "assistant_message", "final", "completed"]]);
  assert.deepEqual(last.items.map(entry => (entry.item as { text?: string }).text), ["你好 hi", "let me see the 文件", "Looking at the 文件 now. ", undefined, "All done. 😀"]);
  assert.equal(h.state.page!.head.runCount, 2); assert.equal(h.state.page!.head.lastSeq, c().lastSeq);
  // What the renderer is given of it.
  const drawn = assemble(h.state.page!);
  assert.equal(drawn.runs[1]!.input, "你好 hi"); assert.deepEqual(drawn.runs[1]!.protocol!.items.map(entry => entry.id), ["user", "think:1", "text:1", "tool:t1", "text:2"]);
  assert.deepEqual(drawn.messages.filter(message => message.runId === "run-1").map(message => [message.id, message.text]), [["message-user-run-1", "你好 hi"], ["message-reply-run-1", "Looking at the 文件 now. "], ["message-reply-run-1~5", "All done. 😀"]]);
  assert.equal(h.state.frames + h.state.snapshots, 11); assert.equal(h.state.snapshots, 1, "the second Turn is dispatched on a control that ran one before, which changes the first Turn's header: that commit is a read; the rest of two Turns of text and a command are frames");
});

test("the next Turn is on another Harness and fails; a third is stopped: the hand-over line is there when the Turn begins, the error when it fails, and each is what a read gives", t => {
  const h = harness(t);
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "on alpha")); h.step(current => start(current, 0)); h.step(current => finish(current, 0, "completed"));
  h.open(); h.agree("opened");
  const bravo = { selection: { harnessId: "bravo", controlId: "bravo-acp", nativeModel: "model-b" } };
  h.step(current => queue(current, 1, "now on bravo", bravo)); h.agree("queued on another Harness");
  let line = h.state.page!.turns.at(-1)!.items[0]!.item;
  assert.deepEqual([line.type, line.id, line.seq], ["switch", "hh:switch", 0]);
  assert.equal(line.type === "switch" ? line.from.harnessId + ">" + line.to.harnessId : "", "alpha>bravo");
  h.step(current => ({ activeRunId: current.runs[1]!.id, runs: replaceRun(current, 1, entry => ({ ...entry, status: "running", timing })) })); h.agree("running");
  h.step(current => withItems(current, 1, items => [...items, segment("run-1", 2, 1, "running", ["thinking about it"])])); h.agree("speaking");
  h.step(current => finish(current, 1, "failed", { error: { code: "NATIVE_QUOTA_EXCEEDED", message: "quota used up" } }), [event("run.ended")]); h.agree("failed");
  const failed = h.state.page!.turns.at(-1)!;
  assert.deepEqual(failed.items.map(entry => [entry.item.type, entry.item.id]), [["switch", "hh:switch"], ["user_message", "user"], ["assistant_message", "text:1"], ["error", "hh:error"]]);
  assert.equal(failed.items.at(-1)!.item.type === "error" ? (failed.items.at(-1)!.item as { class: string }).class : "", "quota");
  assert.equal((failed.items[2]!.item as { phase: string }).phase, "commentary", "a reply cut short by a failure is not an answer");
  // A third Turn, back on alpha, is stopped by the user after it began.
  h.step(current => queue(current, 2, "again on alpha")); h.step(current => start(current, 2)); h.agree("third running");
  h.step(current => withItems(current, 2, items => [...items, segment("run-2", 2, 1, "running", ["half a"])])); h.agree("third speaking");
  h.step(current => ({ runs: replaceRun(current, 2, entry => ({ ...entry, cancelRequested: true })) }), [event("run.cancel_requested")]); h.agree("stop asked");
  h.step(current => finish(current, 2, "cancelled", { cancelRequested: true }), [event("run.ended")]); h.agree("stopped");
  const stopped = assemble(h.state.page!).runs[2]!.protocol!;
  assert.deepEqual([stopped.status, stopped.stopReason], ["cancelled", "user_stopped"]);
  assert.equal(stopped.items[0]!.type, "switch", "the hand-over back to alpha");
});

test("a request that waits for the user and is decided: the page draws the Turn as waiting from the moment the request is in the frame, as a read of the window does", t => {
  const h = harness(t);
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "run it")); h.step(current => start(current, 0));
  h.open();
  const asked = item("run-0", 2, "permission:p1", "approval", "waiting", { subject: "command", title: "Run rm -rf build", options: [{ id: "y", role: "allow_once", label: "Allow" }, { id: "n", role: "deny", label: "Deny" }] });
  h.step(current => withItems(current, 0, items => [...items, asked])); h.agree("asked", { waiting: true });
  assert.equal(h.state.page!.turns[0]!.run.turn!.status, "running", "the Run's row did not change when the request was asked");
  assert.equal(assemble(h.state.page!).runs[0]!.protocol!.status, "waiting"); assert.equal(h.read().window.turns[0]!.run.turn!.status, "waiting");
  h.step(current => withItems(current, 0, items => items.map(it => it.seq === 2 ? { ...it, status: "completed" as const, endedAt: NOW + 5, fields: { ...it.fields, decision: { role: "allow_once", by: "user", at: NOW + 5 } } as typeof it.fields } : it))); h.agree("decided");
  assert.equal(assemble(h.state.page!).runs[0]!.protocol!.status, "running");
  // Nobody answers and the Turn is stopped: the request is cancelled with it.
  h.step(current => withItems(current, 0, items => [...items, item("run-0", 3, "permission:p2", "approval", "waiting", { subject: "command", title: "Run it again", options: [] })])); h.agree("asked again", { waiting: true });
  h.step(current => finish(current, 0, "cancelled", { cancelRequested: true }), [event("run.ended")]); h.agree("stopped while it waited");
  assert.deepEqual([assemble(h.state.page!).runs[0]!.protocol!.status, h.state.page!.turns[0]!.items[2]!.item.status], ["cancelled", "cancelled"]);
});

test("a word too long for a frame is not sent: the page knows how long the reply is, holds what it was sent, and reads the rest by range; a reply the page followed whole is whole", t => {
  const h = harness(t);
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "write a lot")); h.step(current => start(current, 0));
  h.open();
  const big = "B".repeat(70_000);
  // The item's first chunk is too long: the item arrives marked, with no words.
  h.step(current => withItems(current, 0, items => [...items, segment("run-0", 2, 1, "running", [big])])); h.agree("a long first chunk");
  const marked = h.state.page!.turns[0]!.items[1]!;
  assert.deepEqual([marked.item.bodyOmitted, marked.item.textBytes, "text" in marked.item, marked.held], [true, 70_000, false, 0]);
  // It goes on with small chunks: the page knows it grows and does not hold the words.
  h.step(current => withItems(current, 0, items => items.map(it => it.seq === 2 ? { ...it, text: [...it.text, "tail ", "end"] } : it))); h.agree("it goes on");
  assert.equal(h.state.page!.turns[0]!.items[1]!.item.textBytes, 70_008);
  assert.deepEqual(incomplete(h.state.page!), [{ kind: "text", runId: "run-0", ordinal: 0, seq: 2, from: 0, total: 70_008 }]);
  // The rest is read by range, from where the page holds, and the page then holds the reply.
  let page = h.state.page!;
  const reply = h.routes.itemText(SESSION, 0, 2, { from: 0, to: 40_000 });
  const second = h.routes.itemText(SESSION, 0, 2, { from: reply.to });
  assert.equal(reply.text.length + second.text.length, 70_008);
  page = fillText(page, { runId: "run-0", seq: 2 }, reply); page = fillText(page, { runId: "run-0", seq: 2 }, second);
  assert.deepEqual(incomplete(page), []);
  assert.equal((page.turns[0]!.items[1]!.item as { text: string }).text, big + "tail end");
  assert.equal(page.turns[0]!.items[1]!.item.bodyOmitted, undefined);
});

test("a Turn's delivery that changes after it began is told in a frame of its own: the Run and its hand-over line, with the state of the packet that arrived", t => {
  const delivery: { state: "in_flight" | "recorded"; evidence: "E1" | null } = { state: "in_flight", evidence: null };
  const relay: RunRelay = { packetId: "relay-aaaaaaaaaaaaaaaaaaaa" as never, kind: "packet", continuity: { kind: "rehydrate" } as never, executedOn: null };
  const h = harness(t, { relay: () => () => ({ delivery: { state: delivery.state, evidence: delivery.evidence } }) });
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "on alpha")); h.step(current => start(current, 0)); h.step(current => finish(current, 0, "completed"));
  h.open();
  h.step(current => queue(current, 1, "on bravo with a packet", { selection: { harnessId: "bravo", controlId: "bravo-acp" }, relay })); h.agree("queued with a packet");
  h.step(current => start(current, 1)); h.agree("running");
  const line = () => h.state.page!.turns.at(-1)!.items[0]!.item as { type: string; delivery?: string; status: string };
  assert.deepEqual([line().type, line().delivery, line().status], ["switch", "sending", "running"]);
  // The native side records the packet: a commit that writes the delivery and not the Run.
  delivery.state = "recorded"; delivery.evidence = "E1";
  const view = h.routes.frameViews(SESSION), row = view.runById!(h.state.conversation!.runs[1]!.id)!;
  const written: Mutation = { head: { row: { ...(h.tables.head(SESSION)), version: h.state.page!.head.version + 1, lastSeq: h.state.page!.head.lastSeq + 1 } }, events: [],
    relay: { deliveries: [{ kind: "outcome", runId: row.runId, outcome: { kind: "recorded", evidence: "E1", decidedSeq: 9, decidedAt: 9 } }] } };
  const frame = commitFrame(written, { ...h.routes.head(SESSION), version: written.head!.row.version, lastSeq: written.head!.row.lastSeq }, view);
  assert.equal(frame.runs!.length, 1); assert.equal(frame.runs![0]!.id, row.runId);
  const result = applyCommit(h.state.page!, decodeSessionStreamFrameV14(plain(frame)) as never);
  assert.equal(result.kind, "applied");
  h.state.page = (result as { state: WindowState }).state;
  assert.deepEqual([line().delivery, line().status], ["confirmed", "completed"]);
  assert.equal((h.state.page.turns.at(-1)!.run.relay as { delivery?: { state: string } }).delivery?.state, "recorded");
});

// ---------------------------------------------------------------------------------------------------------------------
// What a frame cannot say by itself: the Harness's task list, a notice's label, the model of a Turn that is no longer the latest of its control
// ---------------------------------------------------------------------------------------------------------------------

const planRef = (id: string) => ({ id: "content-" + id, name: id + ".json", mediaType: "application/json", kind: "file", bytes: 90, sha256: "a".repeat(64) });
const todo = (text: string, status = "pending") => ({ content: text, status });
/** A call to the Harness's task list: a plain tool that the protocol reads as the Turn's plan, with its stored input when it has one. */
const todoCall = (seq: number, id: string, status: "running" | "completed", detail = false): HeldItem => item("run-0", seq, "tool:" + id, "tool", status,
  { name: "todo_write", ...(detail ? { detail: planRef(id) } : {}), native: { title: "todo_write", name: "todo_write", status } });
const planOf = (page: WindowState) => page.turns.at(-1)!.items.map(entry => entry.item).filter(row => row.type === "plan");

test("the Harness's task list: a call to it is told with the conversation, not as a frame, and the page then holds the plan where a read puts it and the call where a read hides it", t => {
  // A stored detail never changes: each call has its own.
  const inputs: Record<string, string> = { "content-td1": JSON.stringify({ todos: [todo("write the test"), todo("run it")] }), "content-td2": JSON.stringify({ todos: [todo("write the test", "completed"), todo("run it", "in_progress")] }) };
  const h = harness(t, { detail: ref => inputs[ref.id] === undefined ? null : { input: inputs[ref.id]! } });
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "plan it")); h.step(current => start(current, 0));
  h.open(); h.agree("opened");
  // A call whose stored input is not there yet is told as the call it is, in the conversation a read gives (it cannot be read as a plan).
  h.step(current => withItems(current, 0, items => [...items, todoCall(2, "td1", "running")])); h.agree("the call begins");
  assert.equal(h.state.snapshots, 1, "the commit that wrote the call was a read"); assert.equal(planOf(h.state.page!).length, 0); assert.equal(h.state.page!.turns.at(-1)!.items.some(entry => entry.item.id === "tool:td1"), true, "a call that cannot be read as a plan stays a row");
  // Its input arrives (the item changes: it has a stored detail): from now on the plan stands for it.
  h.step(current => withItems(current, 0, items => items.map(row => row.seq === 2 ? todoCall(2, "td1", "completed", true) : row))); h.agree("the input is stored");
  assert.deepEqual(planOf(h.state.page!).map(row => [row.id, row.seq, row.status]), [["hh:plan", 2, "running"]]); assert.equal(h.state.page!.turns.at(-1)!.items.some(entry => entry.item.id === "tool:td1"), false);
  // The list is written again, later in the Turn: the plan moves to the last call, and the earlier one is gone from where it stood.
  h.step(current => withItems(current, 0, items => [...items, segment("run-0", 3, 1, "running", ["working. "])])); h.agree("speaking");
  h.step(current => withItems(current, 0, items => [...items, todoCall(4, "td2", "completed", true)])); h.agree("the list is written again");
  assert.deepEqual(planOf(h.state.page!).map(row => [row.seq, (row as unknown as { steps: { status: string }[] }).steps.map(step => step.status)]), [[4, ["completed", "in_progress"]]]);
  // The Turn ends: the plan is over with it, as a read of it says.
  h.step(current => finish(current, 0, "completed"), [event("run.ended")]); h.agree("ended");
  assert.deepEqual(planOf(h.state.page!).map(row => row.status), ["completed"]);
  assert.deepEqual(h.state.resyncs, []);
});

test("a Turn that has a plan of its own hides its calls to the task list: the commit that gives it the plan is told with the conversation, and the calls that come after are told the same", t => {
  const h = harness(t);
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "plan it")); h.step(current => start(current, 0));
  h.open();
  h.step(current => withItems(current, 0, items => [...items, todoCall(2, "td1", "running")])); h.agree("the call comes before the plan");
  const planRow = item("run-0", 3, "plan", "plan", "running", { steps: [{ text: "one", status: "pending" }] });
  h.step(current => withItems(current, 0, items => [...items, planRow])); h.agree("the plan is its own");
  assert.equal(h.state.page!.turns.at(-1)!.items.some(entry => entry.item.id === "tool:td1"), false, "the Harness's own plan stands for the call");
  h.step(current => withItems(current, 0, items => [...items, todoCall(4, "td2", "running")])); h.agree("a later call");
  h.step(current => withItems(current, 0, items => items.map(row => row.seq === 3 ? { ...row, fields: { ...row.fields, steps: [{ text: "one", status: "completed" }] } as typeof row.fields } : row))); h.agree("the plan is updated");
  assert.equal(h.state.snapshots >= 3, true); assert.deepEqual(h.state.resyncs, []);
});

test("a notice's label may change while the Turn goes on: the page holds the label a read gives, not the first one", t => {
  const h = harness(t);
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "go")); h.step(current => start(current, 0));
  h.open();
  const notice = (title: string, chunks: readonly string[]): HeldItem => item("run-0", 2, "notice:1", "notice", "running", { severity: "warning", native: { title } }, chunks);
  h.step(current => withItems(current, 0, items => [...items, notice("重试 1/3", ["重试 1/3"])])); h.agree("the notice begins");
  assert.equal((h.state.page!.turns.at(-1)!.items.find(entry => entry.item.seq === 2)!.item as { text: string }).text, "重试 1/3");
  h.step(current => withItems(current, 0, items => items.map(row => row.seq === 2 ? notice("重试 2/3", ["重试 1/3"]) : row))); h.agree("the label changes");
  assert.equal((h.state.page!.turns.at(-1)!.items.find(entry => entry.item.seq === 2)!.item as { text: string }).text, "重试 2/3");
  assert.deepEqual(h.state.resyncs, []);
});

test("the model a Turn shows follows its control: the Turn that is no longer the latest of its control loses the model its binding reported, in the page as in a read", t => {
  const h = harness(t);
  const binding = { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-1", throughRunId: null, status: "ready" as const, observed: { model: "opus", options: {} },
    relay: { epoch: 1, mark: -1, floor: -1, pending: null, resendAll: false } };
  h.step(() => ({}), [event("session.created")]);
  h.step(current => queue(current, 0, "first")); h.step(current => start(current, 0)); h.step(current => finish(current, 0, "completed"));
  h.step(() => ({ nativeBindings: [binding] }));
  h.open(); h.agree("opened");
  const model = (ordinal: number): unknown => (h.state.page!.turns.find(turn => turn.run.ordinal === ordinal)!.run.turn!.executor as { model?: { label: string } }).model?.label;
  assert.equal(model(0) !== undefined, true, "the latest Turn of its control shows the model the binding reported");
  h.step(current => queue(current, 1, "second")); h.agree("queued");
  h.step(current => start(current, 1)); h.agree("dispatched on the same control");
  assert.equal(model(0), undefined, "the first Turn is no longer the latest of its control"); assert.equal(model(1) !== undefined, true);
  assert.equal(h.state.snapshots >= 1, true); assert.deepEqual(h.state.resyncs, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Random Turns
// ---------------------------------------------------------------------------------------------------------------------

/** A small deterministic generator (mulberry32), so that a failing seed is a failing script. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = ["alpha ", "你好 ", "😀🚀 ", "é à ", "\n", "line of text. ", "𝒳 ", "the quick brown fox "];

test("random Turns, framed commit by commit: whatever a Turn does and in whatever order, the page holds what a read of the window gives and draws it the same", t => {
  let commits = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const next = generator(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!, between = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
    const h = harness(t);
    const where = (what: string): string => "seed " + seed + ": " + what;
    h.step(() => ({}), [event("session.created")]);
    h.open();
    const turns = between(1, 6);
    for (let ordinal = 0; ordinal < turns; ordinal++) {
      const id = "run-" + ordinal, harness = pick(["alpha", "alpha", "bravo"]);
      h.step(current => queue(current, ordinal, pick(WORDS) + pick(WORDS), { selection: { harnessId: harness, controlId: harness + "-acp", ...(next() < 0.3 ? { nativeModel: pick(["model-a", "model-b"]) } : {}) } }), [event("message.accepted", { runId: id })]);
      h.agree(where("Turn " + ordinal + " queued"));
      h.step(current => start(current, ordinal), [event("run.started")]);
      let kind: "text" | "think" | null = null, calls = 0, running: number[] = [];
      const items = (): readonly HeldItem[] => h.state.conversation!.runs[ordinal]!.items!;
      const close = (list: readonly HeldItem[]): readonly HeldItem[] => list.map(it => (it.status === "running" && (it.type === "assistant_message" || it.type === "reasoning")) ? { ...it, status: "completed" as const, endedAt: NOW + 7 } : it);
      for (let step = between(2, 14); step > 0; step--) {
        const op = pick(["say", "say", "say", "think", "tool", "toolEnd", "notice", "ask", "decide"] as const), chunk = () => pick(WORDS) + (next() < 0.1 ? "z".repeat(between(1, 3000)) : "");
        if (op === "say" || op === "think") {
          const want = op === "say" ? "text" : "think", open = items().find(it => it.status === "running" && (it.type === "assistant_message" || it.type === "reasoning"));
          if (open !== undefined && kind === want) h.step(current => withItems(current, ordinal, list => list.map(it => it.seq === open.seq ? { ...it, text: [...it.text, chunk()] } : it)));
          else h.step(current => withItems(current, ordinal, list => [...close(list), want === "text" ? segment(id, list.length + 1, list.filter(it => it.type === "assistant_message").length + 1, "running", [chunk()])
            : item(id, list.length + 1, "think:" + (list.filter(it => it.type === "reasoning").length + 1), "reasoning", "running", {}, [chunk()])]));
          kind = want;
        } else if (op === "tool") {
          h.step(current => withItems(current, ordinal, list => [...close(list), toolItem(id, list.length + 1, "t" + (calls++), "running")]));
          running = [...running, items().length]; kind = null;
        } else if (op === "toolEnd" && running.length > 0) {
          const at = running[0]!; running = running.slice(1);
          h.step(current => withItems(current, ordinal, list => list.map(it => it.seq === at ? { ...it, status: pick(["completed", "failed"] as const), endedAt: NOW + 9, fields: { ...it.fields, exitCode: next() < 0.5 ? 0 : 1 } as typeof it.fields } : it)));
        } else if (op === "notice") {
          h.step(current => withItems(current, ordinal, list => [...close(list), item(id, list.length + 1, "notice:" + (list.filter(it => it.type === "notice").length + 1), "notice", "completed", { severity: pick(["info", "warning"] as const) }, [pick(WORDS)])])); kind = null;
        } else if (op === "ask") {
          h.step(current => withItems(current, ordinal, list => [...close(list), item(id, list.length + 1, "permission:p" + list.length, "approval", "waiting", { subject: "command", title: "ask " + list.length, options: [{ id: "y", role: "allow_once", label: "Yes" }] })])); kind = null;
        } else if (op === "decide") {
          const waiting = items().find(it => it.status === "waiting");
          if (waiting !== undefined) h.step(current => withItems(current, ordinal, list => list.map(it => it.seq === waiting.seq ? { ...it, status: "completed" as const, endedAt: NOW + 11, fields: { ...it.fields, decision: { role: "allow_once", by: "user", at: NOW + 11 } } as typeof it.fields } : it)));
        } else continue;
        const asking = items().some(it => it.status === "waiting");
        h.agree(where("Turn " + ordinal + ", after " + op), asking ? { waiting: true } : {});
      }
      const ending = pick(["completed", "completed", "failed", "cancelled"] as const);
      h.step(current => finish(current, ordinal, ending, ending === "failed" ? { error: { code: pick(["NATIVE_QUOTA_EXCEEDED", "PROCESS_EXITED", "SOMETHING_ELSE"]), message: "it failed " + ordinal } } : ending === "cancelled" ? { cancelRequested: true } : {}), [event("run.ended")]);
      h.agree(where("Turn " + ordinal + " ended " + ending));
    }
    assert.equal(h.state.page!.turns.length, turns, where("the page holds every Turn"));
    commits += h.state.frames;
  }
  assert.ok(commits > 400, commits + " commits were framed");

});

// ---------------------------------------------------------------------------------------------------------------------
// The answers of every route are read back whole
// ---------------------------------------------------------------------------------------------------------------------

test("every window and page the Gateway reads of every frozen fixture, sent as JSON, is read by the page as it was: no item is lost or made unrecognized, no field is changed", t => {
  let turns = 0, items = 0;
  for (const name of V13_FIXTURES) {
    const m = migrated(t, name), tables = new ConversationTables(m.db), routes = new ConversationRoutes({ reader: tables, facts: new ConversationFacts(m.db), relay: () => () => ({}), env: { harnessName } });
    for (const row of m.fixture.sessions) {
      const sent = routes.session(row.id), received = decodeSessionViewV14(plain(sent));
      assert.deepEqual(plain(received), plain(sent), name + "/" + row.id);
      // The older pages too, to the first Turn.
      for (let cursor = sent.window.older; cursor !== null;) {
        const page = routes.turns(row.id, { before: cursor, limit: 5 }), got = decodeTurnPageView(plain(page));
        assert.deepEqual(plain(got), plain(page), name + "/" + row.id + ": a page");
        for (const turn of got.turns) { turns++; items += turn.items.length; assert.ok(turn.items.every(entry => entry.type !== "unrecognized"), name); }
        cursor = page.older;
      }
      for (const turn of received.window.turns) { turns++; items += turn.items.length; assert.ok(turn.items.every(entry => entry.type !== "unrecognized"), name); assert.equal(turn.run.protocolProblem, undefined, name); }
      // And the page's state of it, drawn.
      const drawn = assemble(openWindow(received));
      assert.equal(drawn.runs.length, received.window.turns.length);
      for (const run of drawn.runs) assert.ok(run.protocol !== undefined && typeof run.input === "string", name);
    }
  }
  assert.ok(turns > 100 && items > 400, turns + " Turns and " + items + " items were read");
});
