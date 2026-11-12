import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verify, verifyTransition } from "../../src/contexts/session/domain/conversation-verify.js";
import {
  DETAIL_NOT_SAVED, approvalRole, finalItemSeq, itemsOf, mergeToolDetail, noticePrint, openTurn, place, settleItems, type ActiveTurn, type PlaceEnv, type PlaceInput, type Placed, type TerminalStatus,
} from "../../src/contexts/session/domain/items-place.js";
import { projectTurn } from "../../src/contexts/session/domain/protocol/index.js";
import { runItemStatus } from "../../src/contexts/session/domain/protocol/index.js";
import { fromItems, toItems } from "../../src/contexts/session/domain/store-conversion.js";
import { contentId, type ContentRef } from "../../src/contracts/content.js";
import type { Conversation, ConvertedRun, HeldItem } from "../../src/contracts/conversation.js";
import type { ControlEvent, NativeToolDetail, NativeUsage } from "../../src/contracts/control.js";
import type { ItemStatus } from "../../src/contracts/protocol.js";
import {
  commandId, messageId, runId, sessionId, type PublicActivity, type PublicMessage, type PublicNotice, type PublicOutput, type PublicPlan, type PublicRun, type PublicTool, type RunStatus,
} from "../../src/contracts/session.js";
import { schemaV14Statements } from "../../src/infrastructure/session/schema-v14.js";
import { TRIAL, trialConversation, type TrialRun } from "../fixtures/protocol-trial.js";
import { fixtureConversations, readerOf, stored } from "../fixtures/storage/v13/conversations.js";

// The placement of items (ADR-057 3.2, src/contexts/session/domain/items-place.ts): what a Turn in progress does with each thing its Harness
// reports. Replayed here: the real events of five Harnesses (the trial of 2026-11-11), the twenty-two foreign events no v13 build could keep,
// random streams against the old shape of the same Turn (through the storage conversion, which keeps all of it), the closing table cell by cell,
// the approvals and questions, a Turn of five thousand calls, and the writes applied to the real v14 tables.

// ---------------------------------------------------------------------------------------------------------------------------------
// A Turn, and a way to drive it
// ---------------------------------------------------------------------------------------------------------------------------------
const SESSION = sessionId("session-place"), RUN = runId("run-place");
const BASE: PublicRun = { id: RUN, commandId: commandId("send-place"), input: "hello", userMessageId: messageId("message-user-place"), assistantMessageId: messageId("message-reply-place"),
  selection: { harnessId: "codex", controlId: "codex-app-server" }, epoch: 1, status: "running", cancelRequested: false, contextThroughSeq: 1, sourceRunIds: [], backend: null, cleanup: null,
  error: null, stopRequested: false, awaitingSwitchId: null };
const USER: PublicMessage = { id: BASE.userMessageId, runId: RUN, role: "user", text: "hello", seq: 2, status: "running" };
const ACCEPTED = toItems(BASE, { user: USER }, { sessionId: SESSION, ordinal: 0 });
const freshTurn = (): ActiveTurn => openTurn(ACCEPTED.row, ACCEPTED.items.map(stored));

/** The Turn and everything it was told, in order; `commits` are the results of each input as the Runtime would commit them. */
class Driver {
  turn: ActiveTurn;
  time = 10_000;
  readonly commits: Placed[] = [];
  /** The items the Turn had when the driver took it up: what a store held before the first input. */
  readonly from: readonly HeldItem[];
  constructor(readonly env: PlaceEnv = {}, turn: ActiveTurn = freshTurn()) { this.turn = turn; this.from = itemsOf(turn); }
  input(input: PlaceInput): Placed { const placed = place(this.turn, input, this.env); this.commits.push(placed); this.turn = placed.turn; return placed; }
  event(event: ControlEvent, stored?: ContentRef): Placed { return this.input({ kind: "event", event, at: this.time += 10, ...(stored === undefined ? {} : { stored }) }); }
  text(text: string): Placed { return this.event({ type: "text", text }); }
  think(text: string): Placed { return this.event({ type: "thinking", text }); }
  flush(): Placed { return this.input({ kind: "flush", at: this.time += 10 }); }
  settle(status: TerminalStatus = "completed"): Placed { return this.input({ kind: "settled", status, at: this.time += 10 }); }
  get items(): readonly HeldItem[] { return itemsOf(this.turn); }
  /** One line per item but the user's: id, state, and the text with its chunk count when it has chunks. */
  show(): string[] { return this.items.slice(1).map(item => item.itemId + " " + item.status + (item.text.length === 0 ? "" : " " + JSON.stringify(item.text.join("")) + (item.text.length > 1 ? " ×" + item.text.length : "")));
  }
  /** The item of an id. */
  item(itemId: string): HeldItem { const found = this.items.find(item => item.itemId === itemId); assert.ok(found, itemId + " is there"); return found; }
  get changes() { return this.commits.flatMap(placed => placed.changes.items ?? []); }
}

/** What a store holding exactly what the commits wrote would hold: rows by `seq`, chunks in the order they were appended, the counters it keeps. */
function replicate(commits: readonly Placed[], from: readonly HeldItem[] = ACCEPTED.items.map(stored)): HeldItem[] {
  const rows = new Map<number, HeldItem>(from.map(item => [item.seq, item]));
  for (const { changes } of commits) {
    for (const write of changes.items ?? []) {
      const prior = rows.get(write.row.seq);
      if (write.op === "insert") { assert.equal(prior, undefined, "an insert of seq " + write.row.seq + " that exists"); assert.ok(write.createdByEvent !== undefined, "an insert names the event that created it"); rows.set(write.row.seq, { ...write.row, text: [] }); }
      else { assert.ok(prior, "an update of seq " + write.row.seq + " that is not there"); rows.set(write.row.seq, { ...prior, ...write.row, textBytes: prior.textBytes, textChunks: prior.textChunks }); }
    }
    for (const append of changes.text ?? []) {
      const item = rows.get(append.itemSeq);
      assert.ok(item, "text for an item that is not there"); assert.equal(append.chunk, item.text.length, "chunks follow one another");
      rows.set(append.itemSeq, { ...item, text: [...item.text, append.text], textChunks: item.textChunks + 1, textBytes: item.textBytes + Buffer.byteLength(append.text, "utf8") });
    }
  }
  return [...rows.values()].sort((left, right) => left.seq - right.seq);
}
const wellFormed = (text: string): boolean => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text);
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, into);
  else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) { into.push(key); strings(entry, into); }
  return into;
}
/** What must hold of a Turn whatever it was told: the store would hold what the turn holds, ids and seqs are unique and increasing, no chunk holds half a pair, and no string holds a NUL. */
function check(driver: Driver, where = ""): void {
  const items = driver.items, held = replicate(driver.commits, driver.from);
  assert.deepStrictEqual(held, items, where + ": the writes make the Turn's items");
  assert.equal(new Set(items.map(item => item.itemId)).size, items.length, where + ": ids are unique");
  items.forEach((item, at) => {
    if (at > 0) assert.ok(item.seq > items[at - 1]!.seq, where + ": seqs increase");
    for (const chunk of item.text) { assert.ok(wellFormed(chunk), where + ": chunk of " + item.itemId + " holds half a pair"); assert.ok(!chunk.includes("\0"), where + ": NUL in a chunk"); }
    assert.equal(item.textChunks, item.text.length); assert.equal(item.textBytes, item.text.reduce((total, chunk) => total + Buffer.byteLength(chunk, "utf8"), 0));
  });
  for (const placed of driver.commits) {
    for (const write of placed.changes.items ?? []) assert.deepStrictEqual(JSON.parse(JSON.stringify(write.row)), write.row, where + ": the row of " + write.row.itemId + " is plain JSON (no undefined, no NaN: nothing a column cannot hold)");
    const {  items: rows, ...rest } = placed.changes; void rows;
    for (const text of [...strings(placed.changes.items?.map(write => ({ ...write.row, fields: write.row.fields })) ?? []), ...strings(rest)]) {
      assert.ok(wellFormed(text), where + ": a string of the writes holds half a pair"); assert.ok(!text.includes("\0"), where + ": a NUL in the writes");
    }
  }
}
const ref = (name: string): ContentRef => ({ id: contentId("content-" + name), name: name + ".json", mediaType: "application/json", kind: "file", bytes: 1, sha256: "0".repeat(64) });
const tool = (id: string, status: string, over: Partial<Extract<ControlEvent, { type: "tool" }>> = {}): ControlEvent => ({ type: "tool", id, title: over.title ?? "title of " + id, status, ...(over.detail === undefined ? {} : { detail: over.detail }) });

// ---------------------------------------------------------------------------------------------------------------------------------
// The old shape of a Turn, as the Runtime built it event by event (the rules of runtime.ts:1278-1346), for the comparison with the storage conversion
// ---------------------------------------------------------------------------------------------------------------------------------
interface Old { thinking?: string; reply?: string; tools: PublicTool[]; notices: PublicNotice[]; activities: PublicActivity[]; outputs: PublicOutput[]; plan?: PublicPlan }
function oldShape(events: readonly ControlEvent[]): Old {
  const old: Old = { tools: [], notices: [], activities: [], outputs: [] };
  const seen = new Map<string, NativeToolDetail>();
  for (const event of events) {
    switch (event.type) {
      case "thinking": old.thinking = (old.thinking ?? "") + event.text; break;
      case "text": old.reply = (old.reply ?? "") + event.text; break;
      case "tool": {
        const prior = seen.get(event.id), detail: NativeToolDetail = { kind: event.detail?.kind ?? prior?.kind, name: event.detail?.name ?? prior?.name, parentId: event.detail?.parentId ?? prior?.parentId, exitCode: event.detail?.exitCode ?? prior?.exitCode } as NativeToolDetail;
        seen.set(event.id, detail);
        const call: PublicTool = { id: event.id, title: event.title, status: event.status, ...(detail.kind === undefined ? {} : { kind: detail.kind }), ...(detail.name === undefined ? {} : { name: detail.name }),
          ...(detail.parentId === undefined ? {} : { parentId: detail.parentId }), ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }) };
        const at = old.tools.findIndex(candidate => candidate.id === event.id);
        if (at < 0) old.tools.push(call); else old.tools[at] = call;
        break;
      }
      case "plan": old.plan = { entries: event.entries.map(entry => ({ ...entry, content: entry.content || "…" })), ...(event.explanation ? { explanation: event.explanation } : {}) }; break;
      case "notice": {
        const notice: PublicNotice = { severity: event.severity, title: event.title || "提示", ...(event.detail ? { detail: event.detail } : {}) };
        if (!old.notices.some(prior => JSON.stringify(prior) === JSON.stringify(notice))) old.notices.push(notice);
        break;
      }
      case "activity": {
        const activity: PublicActivity = { id: event.id, kind: event.kind, title: event.title || event.kind, status: event.status, ...(event.detail ? { detail: event.detail } : {}) };
        const at = old.activities.findIndex(candidate => candidate.id === event.id);
        if (at < 0) old.activities.push(activity); else old.activities[at] = activity;
        break;
      }
      case "output": if (event.output.kind === "link") old.outputs.push({ kind: "link", uri: event.output.uri, name: event.output.name || "链接", ...(event.output.title ? { title: event.output.title } : {}), ...(event.output.mediaType ? { mediaType: event.output.mediaType } : {}) }); break;
      default: break;
    }
  }
  return old;
}
/** The Run and its messages as the old Runtime would have left them. */
function oldRun(old: Old, status: RunStatus): { readonly run: PublicRun; readonly user: PublicMessage; readonly assistant?: PublicMessage } {
  const run: PublicRun = { ...BASE, status, ...(old.thinking === undefined ? {} : { thinking: old.thinking }), ...(old.tools.length ? { tools: old.tools } : {}), ...(old.plan === undefined ? {} : { plan: old.plan }),
    ...(old.notices.length ? { notices: old.notices } : {}), ...(old.activities.length ? { activities: old.activities } : {}), ...(old.outputs.length ? { outputs: old.outputs } : {}) };
  return { run, user: { ...USER, status }, ...(old.reply === undefined ? {} : { assistant: { id: BASE.assistantMessageId, runId: RUN, role: "assistant" as const, text: old.reply, seq: 3, status } }) };
}
/** What the Turn the driver holds comes back as through `fromItems`, against what the old Runtime would have held for the same events. */
function sameAsOld(driver: Driver, events: readonly ControlEvent[], status: RunStatus, where: string): ConvertedRun {
  const expected = oldRun(oldShape(events), status), converted = toItems(expected.run, { user: expected.user, ...(expected.assistant === undefined ? {} : { assistant: expected.assistant }) }, { sessionId: SESSION, ordinal: 0 });
  const back = fromItems({ row: converted.row, items: driver.items, contentRefs: [] });
  assert.deepStrictEqual(back.run, expected.run, where + ": the Run the items give back");
  const words = (messages: readonly PublicMessage[]) => messages.map(message => [message.role, message.id, message.text]);
  assert.deepStrictEqual(words(back.messages), words([expected.user, ...(expected.assistant === undefined ? [] : [expected.assistant])]), where + ": the messages the items give back");
  return converted;
}
/**
 * The items of the Turn against the items `toItems` makes of the same Turn (with no stored detail to read, as the storage conversion has none): the same ids with the
 * same type, state, parent and fields — the segments of a reply and of reasoning being one item there, their words are compared as one text.
 */
function sameItemsAsConverted(driver: Driver, converted: ConvertedRun, where: string): void {
  const kept = (item: HeldItem) => !(item.itemId === "user" || item.itemId.startsWith("text:") || item.itemId.startsWith("think:"));
  // The words of a notice told as an activity (a retry, a review) are its first chunk, and its title may change while it runs: its label is `native.title`, which `fields` hold.
  const shape = (item: HeldItem) => { const { fields, text, ...rest } = item, label = item.itemId.startsWith("activity:") && item.type === "notice"; return [item.itemId, { type: rest.type, status: rest.status, parentId: rest.parentId, fields, text: label ? "" : text.join("") }] as const; };
  const placed = new Map(driver.items.filter(kept).map(shape)), made = new Map(converted.items.filter(kept).map(shape));
  assert.deepStrictEqual([...placed.keys()].sort(), [...made.keys()].sort(), where + ": the same items");
  for (const [id, item] of made) assert.deepStrictEqual(placed.get(id), item, where + ": " + id);
  for (const prefix of ["text:", "think:"]) {
    const kind = (items: readonly HeldItem[]) => items.filter(item => item.itemId.startsWith(prefix));
    assert.equal(kind(driver.items).length > 0, kind(converted.items).length > 0, where + ": " + prefix + " segments exist when the converted Turn has them");
    for (const item of kind(driver.items)) assert.ok(item.status === "completed" || item.status === runItemStatus(driver.turn.settled!), where + ": a segment is done, or was left open as the Turn ended (" + item.status + ")");
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The real events of five Harnesses
// ---------------------------------------------------------------------------------------------------------------------------------
type Ordered = TrialRun & { readonly order: readonly ("thinking" | "tool" | "text")[] };
/** The events a Turn of the trial is made of, in the order its kinds first arrived: a call is reported once per state it went through, its detail with the last. */
function trialEvents(run: Ordered): ControlEvent[] {
  const events: ControlEvent[] = [];
  let next = 0, thought = 0, spoken = 0;
  for (const kind of run.order) {
    if (kind === "thinking") { thought++; events.push({ type: "thinking", text: `thought ${thought}, ` }, { type: "thinking", text: `and then some of ${thought}.` }); }
    else if (kind === "text") { spoken++; events.push({ type: "text", text: `Answer ${spoken}: ` }, { type: "text", text: `what ${spoken} says.` }); }
    else {
      const entry = run.tools[next]!, id = "tool-" + run.n + "-" + next++;
      entry.statuses.forEach((status, at) => {
        const detail = at < entry.statuses.length - 1 ? (entry.detail === undefined ? undefined : { ...(entry.kind === undefined ? {} : { kind: entry.kind }), ...(entry.name === undefined ? {} : { name: entry.name }) }) : entry.detail;
        events.push({ type: "tool", id, title: entry.title, status, ...(detail === undefined ? {} : { detail: detail as NativeToolDetail }) });
      });
    }
  }
  assert.equal(next, run.tools.length, "every call of the Turn is in its order");
  events.push({ type: "usage", usage: run.usage as NativeUsage });
  return events;
}

test("the five Harnesses' real events of the trial: the items follow the order things arrived in, each call is what the shared normalization makes of it with its detail, and the Turn is what the old Runtime kept of it", () => {
  const conversation = trialConversation();
  let calls = 0;
  TRIAL.runs.forEach((entry, index) => {
    const run = entry as Ordered, events = trialEvents(run), where = "Turn " + run.n + " (" + run.harnessId + ")";
    const driver = new Driver();
    const stores = events.flatMap(event => driver.event(event).store);
    driver.settle("completed"); stores.push(...driver.commits.at(-1)!.store);
    check(driver, where);
    // The order: segments where text and reasoning came, a call each, the way the order was recorded.
    const kinds: string[] = [];
    for (const kind of run.order) if (kind === "tool" || kinds.at(-1) !== kind) kinds.push(kind);
    const placed = driver.items.slice(1);
    assert.deepStrictEqual(placed.map(item => item.type === "reasoning" ? "thinking" : item.type === "assistant_message" ? "text" : "tool"), kinds, where + ": items in the order of arrival");
    // The calls: the same type and fields the display projection makes of them from the same details (placement has them in hand).
    const projected = projectTurn({ runs: conversation.runs, messages: conversation.messages }, index, { harnessName: id => id, detail: ref => conversation.heads.get(ref.id) ?? null }).items
      .filter(item => item.type !== "user_message" && item.type !== "switch" && item.type !== "assistant_message" && item.type !== "reasoning");
    const made = placed.filter(item => item.itemId.startsWith("tool:"));
    assert.equal(made.length, run.tools.length); assert.equal(projected.length, made.length, where + ": a row for each call");
    made.forEach((item, at) => {
      const { id: _id, seq: _seq, status, detail: _detail, parentId: _parent, ...expected } = projected[at] as unknown as Record<string, unknown>;
      const { native, ...fields } = item.fields as unknown as Record<string, unknown>;
      assert.deepStrictEqual(fields, expected, where + ": call " + at + " is the item the projection makes of it");
      assert.equal(item.status, status, where + ": call " + at + " ends as the projection says");
      assert.deepStrictEqual(native, { title: run.tools[at]!.title, status: run.tools[at]!.statuses.at(-1), ...(run.tools[at]!.kind === undefined ? {} : { kind: run.tools[at]!.kind }), ...(run.tools[at]!.name === undefined ? {} : { name: run.tools[at]!.name }),
        ...(run.tools[at]!.exitCode === undefined ? {} : { exitCode: run.tools[at]!.exitCode }) }, where + ": call " + at + " keeps what its Harness reported");
    });
    calls += made.length;
    // A detail the Harness reported goes to the content store once, when the call has ended.
    assert.equal(stores.length, run.tools.filter(call => call.detail !== undefined).length, where + ": one detail to store per call that has one");
    for (const request of stores) assert.ok(request.detail.kind !== undefined || request.detail.input !== undefined || request.detail.output !== undefined);
    sameAsOld(driver, events, "completed", where);
    const last = driver.items.at(-1)!;
    assert.equal(finalItemSeq(driver.items, "completed"), last.type === "assistant_message" ? last.seq : null, where + ": the answer is the last segment of a Turn that ends on text");
  });
  assert.ok(calls >= 40, "the trial has its calls");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Foreign events
// ---------------------------------------------------------------------------------------------------------------------------------
interface ForeignCase { readonly name: string; readonly v13: string; readonly events: readonly ControlEvent[] }
const FOREIGN = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../tests/fixtures/storage/v13/foreign-events.json", import.meta.url)), "utf8")) as { cases: ForeignCase[] }).cases;
const native = (item: HeldItem) => item.fields.native!;
const fieldsOf = (item: HeldItem): Record<string, unknown> => item.fields as unknown as Record<string, unknown>;
function playForeign(index: number, status: TerminalStatus = "completed"): Driver {
  const driver = new Driver();
  for (const event of FOREIGN[index]!.events) driver.event(event);
  driver.settle(status);
  return driver;
}

test("the twenty-two events no v13 build could keep are all placed: nothing is thrown, refused or lost, and what was normalized is told", () => {
  assert.equal(FOREIGN.length, 22);
  FOREIGN.forEach((entry, index) => {
    const driver = playForeign(index);
    check(driver, entry.name);
    assert.ok(driver.items.every(item => item.status !== "pending" && item.status !== "running" && item.status !== "waiting"), entry.name + ": nothing is left open");
    const again = playForeign(index);
    assert.deepStrictEqual(again.commits.map(placed => placed.changes), driver.commits.map(placed => placed.changes), entry.name + ": the same events place the same way");
  });

  const title = playForeign(0).item("tool:T:1");
  assert.equal(native(title).title, FOREIGN[0]!.events[0]!.type === "tool" ? (FOREIGN[0]!.events[0] as { title: string }).title : "", "a title of more than 4,096 bytes is kept whole");
  assert.equal(native(title).clipped, undefined); assert.equal(title.type, "command");
  assert.ok(String(fieldsOf(title).command).length <= 1000, "the command read from it is bounded as the label of a command is");

  assert.deepStrictEqual([native(playForeign(1).item("tool:T:2")).title, native(playForeign(1).item("tool:T:2")).clipped], ["echo ab", ["title:nul"]], "a NUL is removed and told");
  const mixed = native(playForeign(2).item("tool:T:3"));
  assert.equal(mixed.title, "a� b� c😀", "half a pair is replaced, a whole pair kept, the NUL gone");
  assert.deepStrictEqual(mixed.clipped, ["title:nul", "title:surrogate"]);
  for (const [at, id] of [[3, "T:4"], [4, "T:5"]] as const) assert.deepStrictEqual([native(playForeign(at).item("tool:" + id)).title, native(playForeign(at).item("tool:" + id)).clipped], ["工具调用", ["title:empty"]], "an empty title is given its placeholder");
  assert.ok(playForeign(5).items.some(item => item.itemId === "tool:T:6x") && native(playForeign(5).item("tool:T:6x")).clipped?.[0] === "id:nul", "an id with a NUL");
  assert.ok(playForeign(6).items.some(item => item.itemId.length > 512), "an id of more than 512 bytes is kept");
  const word = playForeign(7).item("tool:T:7");
  assert.equal(word.status, "unknown"); assert.equal(native(word).status!.length, 200); assert.deepStrictEqual(native(word).clipped, ["status:unknown_word"], "a word the protocol does not know is read as unknown, and told");
  const long = native(playForeign(8).item("tool:T:8"));
  assert.ok(long.kind!.length > 64 && long.name!.length > 256, "a kind and a name longer than the old limits are kept");
  assert.equal(playForeign(9).item("tool:T:9").parentId!.length, 5 + 600, "a parent id of more than 512 bytes is kept");
  const codes = playForeign(10);
  assert.equal(native(codes.item("tool:T:10")).exitCode, 1099511627776); assert.equal(native(codes.item("tool:T:11")).exitCode, -8589934592);
  assert.equal(codes.item("tool:T:10").status, "failed", "a command that exits with anything but 0 failed, whatever the word");
  const notices = playForeign(11);
  assert.deepStrictEqual(notices.items.slice(1).map(item => item.itemId), ["notice:1", "notice:2", "notice:3", "notice:4"]);
  assert.deepStrictEqual([native(notices.item("notice:1")).title, native(notices.item("notice:1")).clipped, notices.item("notice:1").text], ["ab", ["title:nul"], ["ab"]]);
  assert.deepStrictEqual([native(notices.item("notice:2")).title, native(notices.item("notice:2")).clipped], ["提示", ["title:empty"]]);
  assert.ok(Buffer.byteLength(notices.item("notice:3").text.join("")) > 1024 && Buffer.byteLength(String(native(notices.item("notice:4")).more)) > 4096, "a long title and a long detail are kept");
  const activities = playForeign(12);
  assert.deepStrictEqual(activities.items.slice(1).map(item => item.itemId), ["activity:a", "activity:" + "b".repeat(600), "activity:c"]);
  assert.equal(native(activities.item("activity:a")).clipped?.[0], "id:nul"); assert.ok(Buffer.byteLength(native(activities.item("activity:c")).title!) > 1024);
  const steps = (index: number) => (fieldsOf(playForeign(index).item("plan")).steps as { text: string }[]);
  assert.deepStrictEqual(steps(13).slice(0, 2).map(step => step.text), ["a", "…"], "a step is cleaned, and an empty one given its placeholder"); assert.ok(Buffer.byteLength(steps(13)[2]!.text) > 4096);
  assert.deepStrictEqual(native(playForeign(13).item("plan")).clipped, ["steps.text:nul", "steps.text:empty"]);
  assert.equal(steps(14).length, 80, "a plan of eighty steps is kept whole");
  const reply = playForeign(15).item("text:1");
  assert.deepStrictEqual([reply.text, native(reply).clipped], [["beforeafter"], ["text:nul"]], "the NUL of a reply is removed and told");
  const thought = playForeign(16).item("think:1");
  assert.equal(thought.text.join(""), "txhalf 😀 other half", "a pair split between two events is one pair"); assert.equal(thought.textChunks, 1, "the window is one chunk");
  const lone = playForeign(17);
  assert.deepStrictEqual([lone.item("think:1").text, native(lone.item("think:1")).surrogates], [["�"], [[0, 0xde00]]], "a lone low surrogate is kept as what it was");
  assert.deepStrictEqual([lone.item("text:1").text, native(lone.item("text:1")).surrogates], [["�"], [[0, 0xd83d]]], "a reply that is half a pair is too");
  const back = fromItems({ row: toItems({ ...BASE, status: "completed" }, { user: USER }, { sessionId: SESSION, ordinal: 0 }).row, items: lone.items, contentRefs: [] }).run;
  assert.deepStrictEqual([back.thinking, fromItems({ row: ACCEPTED.row, items: lone.items, contentRefs: [] }).messages[1]!.text], ["\ude00", "\ud83d"], "and both come back to the unit");
  for (const at of [18, 19]) { const driver = playForeign(at); assert.deepStrictEqual(driver.items.map(item => item.itemId), ["user"], "a usage is the Runtime's: it is no item"); }
  const links = playForeign(20);
  assert.deepStrictEqual(links.items.slice(1).map(item => [item.itemId, fieldsOf(item).name, fieldsOf(item).uri]).map(([id, name]) => [id, name]), [["output:1", "n"], ["output:2", "script"], ["output:3", "long"], ["output:4", "链接"]]);
  assert.equal(fieldsOf(links.item("output:1")).uri, "https://example.com/a\nb"); assert.equal(fieldsOf(links.item("output:2")).uri, "javascript:alert(1)");
  assert.equal(fieldsOf(links.item("output:3")).uri, (FOREIGN[20]!.events[2] as Extract<ControlEvent, { type: "output" }>).output.kind === "link" ? (FOREIGN[20]!.events[2] as { output: { uri: string } }).output.uri : "", "a long address is kept whole");
  assert.deepStrictEqual(native(links.item("output:4")).clipped, ["name:empty"]);
  const place21 = playForeign(21).item("tool:T:12");
  assert.equal(place21.type, "file_read"); assert.ok(String(fieldsOf(place21).path).startsWith("/p/0/"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Random streams against the old shape of the same Turn
// ---------------------------------------------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  return () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const PIECES = ["a", "bc ", " ", "\n", "  ", "你好", "😀", "é", "{x}", "\t", "word "];
const TOOLS = ["t0", "t1", "t2", "t3", "t4", "t5"], WORDS = ["pending", "in_progress", "completed", "failed", "running"];
const KINDS = ["execute", "read", "edit", "search", "other", undefined], NAMES = ["Bash", "Read", "Edit", "shell", undefined];
/** An activity is the same kind in every report of it. */
const ACTIVITY_KINDS = { a0: "subagent", a1: "retry", a2: "compaction", a3: "task", a4: "review" } as const;
function randomEvents(seed: number): { readonly steps: readonly PlaceInput[]; readonly events: readonly ControlEvent[]; readonly status: TerminalStatus } {
  const random = mulberry32(seed), pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const steps: PlaceInput[] = [], events: ControlEvent[] = [];
  let at = 100, carry = false;
  const push = (event: ControlEvent) => { events.push(event); steps.push({ kind: "event", event, at: at += 7 }); };
  const piece = (): string => {
    let text = carry ? "\ude00" : ""; carry = false;
    if (random() < 0.15) return text + pick([" ", "\n\n", "   "]);
    for (let n = 1 + Math.floor(random() * 6); n > 0; n--) text += pick(PIECES);
    if (random() < 0.06) { text += "\ud83d"; carry = true; } else if (random() < 0.01) text += "\ud83d";
    if (random() < 0.01) text += "x".repeat(20_000) + "你".repeat(3000);
    return text;
  };
  for (let n = 4 + Math.floor(random() * 50); n > 0; n--) {
    const roll = random();
    if (roll < 0.28) push({ type: "text", text: piece() });
    else if (roll < 0.46) push({ type: "thinking", text: piece() });
    else if (roll < 0.66) {
      const id = pick(TOOLS), kind = pick(KINDS), name = pick(NAMES), parent = random() < 0.15 ? pick(TOOLS.filter(other => other !== id)) : undefined, code = random() < 0.2 ? Math.floor(random() * 3) : undefined;
      const detail: NativeToolDetail | undefined = random() < 0.5 ? { ...(kind === undefined ? {} : { kind }), ...(name === undefined ? {} : { name }), ...(parent === undefined ? {} : { parentId: parent }), ...(code === undefined ? {} : { exitCode: code }) } : undefined;
      push({ type: "tool", id, title: random() < 0.5 ? "title of " + id : "other title of " + id, status: pick(WORDS), ...(detail === undefined || Object.keys(detail).length === 0 ? {} : { detail }) });
    }
    else if (roll < 0.72) push({ type: "plan", entries: Array.from({ length: Math.floor(random() * 4) }, (_, i) => ({ content: "step " + i, status: pick(["pending", "in_progress", "completed"] as const) })), ...(random() < 0.3 ? { explanation: "why" } : {}) });
    else if (roll < 0.8) push({ type: "notice", severity: pick(["info", "warning", "error"] as const), title: pick(["one", "two", "three"]), ...(random() < 0.4 ? { detail: "more" } : {}) });
    else if (roll < 0.87) { const id = pick(Object.keys(ACTIVITY_KINDS) as (keyof typeof ACTIVITY_KINDS)[]); push({ type: "activity", id, kind: ACTIVITY_KINDS[id], title: pick(["work", "retrying", "looking"]), status: pick(["running", "completed", "failed", "cancelled"] as const), ...(random() < 0.3 ? { detail: "d" } : {}) }); }
    else if (roll < 0.91) push({ type: "output", output: { kind: "link", uri: "https://example.com/" + Math.floor(random() * 5), name: pick(["page", "doc"]), ...(random() < 0.3 ? { title: "A title" } : {}) } });
    else if (roll < 0.94) push({ type: pick(["usage", "diagnostic"] as const) === "usage" ? "usage" : "diagnostic", ...({ usage: {}, message: "m" } as object) } as ControlEvent);
    else steps.push({ kind: "flush", at: at += 7 });
  }
  return { steps, events, status: pick(["completed", "failed", "cancelled", "unknown"] as const) };
}

test("random streams: the Turn is what the old Runtime kept of the same events — reply, reasoning, calls, plan, notices, activities and links, to the unit — written in the order they arrived, nothing of a stream changes a result, and the same stream gives the same writes", () => {
  let streams = 0, segments = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { steps, events, status } = randomEvents(seed), where = "stream " + seed;
    const frozen = JSON.stringify(steps);
    const driver = new Driver();
    for (const step of steps) driver.input(step);
    const middle = driver.items.length;
    driver.settle(status);
    assert.equal(JSON.stringify(steps), frozen, where + ": the events were not changed");
    check(driver, where);
    sameItemsAsConverted(driver, sameAsOld(driver, events, status, where), where);
    assert.ok(driver.items.length >= middle);
    const last = new Driver(); for (const step of steps) last.input(step); last.settle(status);
    assert.deepStrictEqual(last.commits.map(placed => [placed.changes, placed.store]), driver.commits.map(placed => [placed.changes, placed.store]), where + ": deterministic");
    segments += driver.items.filter(item => item.itemId.startsWith("text:") || item.itemId.startsWith("think:")).length; streams++;
  }
  assert.equal(streams, 300); assert.ok(segments > 300, "the streams have segments");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Whatever arrives
// ---------------------------------------------------------------------------------------------------------------------------------
test("whatever a Driver sends — a field of the wrong kind, a null, a NaN, nested rubbish — is placed or let be, never thrown, and what is written is still storable", () => {
  const POOL: readonly unknown[] = [undefined, null, 0, -1, 1.5, NaN, Infinity, 2 ** 60, "", " ", "a\0b", "\ud83d", "\ude00x", "plain", "你好".repeat(3000), true, false, [], {}, [1, "two", null], { kind: 3, name: {}, input: 5 }, { kind: "text", value: "v" }, [{ id: 7, name: null }, { id: "ok", name: "Okay" }]];
  const TYPES = ["text", "thinking", "tool", "plan", "usage", "notice", "activity", "output", "permission_requested", "permission", "diagnostic", "input_recorded", "nonsense"];
  const FIELDS = ["text", "id", "title", "status", "detail", "entries", "explanation", "usage", "severity", "kind", "output", "options", "input", "decision", "message", "packetId", "uri", "name", "mediaType", "data"];
  let thrown = 0, placed = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const random = mulberry32(seed * 7919), pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!, driver = new Driver();
    for (let n = 2 + Math.floor(random() * 25); n > 0; n--) {
      const event: Record<string, unknown> = { type: pick(TYPES) };
      for (const field of FIELDS) if (random() < 0.4) event[field] = pick(POOL);
      if (random() < 0.2) event.output = { kind: pick(["link", "content", "x"]), uri: pick(POOL), name: pick(POOL), title: pick(POOL), data: new Uint8Array(2) };
      if (random() < 0.3) event.entries = [{ content: pick(POOL), status: pick(POOL), priority: pick(POOL) }, pick(POOL)].filter(entry => typeof entry === "object" && entry !== null);
      try { driver.input(random() < 0.1 ? pick([{ kind: "flush", at: 1 }, { kind: "decided", id: pick(POOL) as string, option: pick(POOL) as string, at: 2 }, { kind: "expired", at: 3 }, { kind: "detail", toolId: pick(POOL) as string, ref: ref("garbage"), at: 4 }] as PlaceInput[])
        : { kind: "event", event: event as unknown as ControlEvent, at: 100 + n, ...(random() < 0.5 ? { stored: ref("garbage") } : {}) }); placed++; } catch (error) { thrown++; assert.fail("seed " + seed + " threw " + String(error) + " for " + JSON.stringify(event)); }
    }
    driver.settle(pick(OUTCOMES));
    check(driver, "garbage " + seed);
  }
  assert.equal(thrown, 0); assert.ok(placed > 3000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Segments and windows
// ---------------------------------------------------------------------------------------------------------------------------------
test("segments: a call, a kind of text, an approval, a notice or a link cuts the open one; a plan, a usage, a diagnostic and the update of a call do not", () => {
  const cases: readonly { readonly name: string; readonly run: (d: Driver) => void; readonly shows: readonly string[] }[] = [
    { name: "text only", run: d => d.text("Hello"), shows: ['text:1 completed "Hello"'] },
    { name: "a call between two texts", run: d => { d.text("A"); d.event(tool("c", "completed")); d.text("B"); }, shows: ['text:1 completed "A"', "tool:c completed", 'text:2 completed "B"'] },
    { name: "the kind changes", run: d => { d.text("A"); d.think("T"); d.text("B"); }, shows: ['text:1 completed "A"', 'think:1 completed "T"', 'text:2 completed "B"'] },
    { name: "windows of one kind are one segment", run: d => { d.think("a"); d.flush(); d.think("b"); d.flush(); d.think("c"); }, shows: ['think:1 completed "abc" ×3'] },
    { name: "a plan does not cut", run: d => { d.text("A"); d.flush(); d.event({ type: "plan", entries: [{ content: "s", status: "pending" }] }); d.text("B"); }, shows: ['text:1 completed "AB" ×2', "plan completed"] },
    { name: "usage, diagnostic, input_recorded do not cut", run: d => { d.text("A"); d.event({ type: "usage", usage: {} }); d.event({ type: "diagnostic", message: "m" }); d.event({ type: "input_recorded" }); d.text("B"); }, shows: ['text:1 completed "AB" ×2'] },
    { name: "the update of a call does not cut", run: d => { d.event(tool("c", "running")); d.text("A"); d.event(tool("c", "completed")); d.text("B"); }, shows: ["tool:c completed", 'text:1 completed "AB" ×2'] },
    { name: "a notice cuts", run: d => { d.text("A"); d.event({ type: "notice", severity: "info", title: "n" }); d.text("B"); }, shows: ['text:1 completed "A"', 'notice:1 completed "n"', 'text:2 completed "B"'] },
    { name: "an approval cuts", run: d => { d.text("A"); d.event({ type: "permission_requested", id: "p", title: "Run it", options: [{ id: "allow", name: "Allow" }] }); }, shows: ['text:1 completed "A"', "permission:p cancelled"] },
    { name: "a link cuts", run: d => { d.think("A"); d.event({ type: "output", output: { kind: "link", uri: "https://e.com", name: "e" } }); d.think("B"); }, shows: ['think:1 completed "A"', "output:1 completed", 'think:2 completed "B"'] },
    { name: "an activity cuts", run: d => { d.text("A"); d.event({ type: "activity", id: "s", kind: "subagent", title: "work", status: "running" }); d.text("B"); }, shows: ['text:1 completed "A"', "activity:s unknown", 'text:2 completed "B"'] },
    { name: "whitespace alone begins the next segment of its kind", run: d => { d.text("\n\n"); d.text("Hello"); }, shows: ['text:1 completed "\\n\\nHello"'] },
    { name: "whitespace waits across a call", run: d => { d.text("\n\n"); d.event(tool("c", "completed")); d.text("Hello"); }, shows: ["tool:c completed", 'text:1 completed "\\n\\nHello"'] },
    { name: "whitespace is written as it is when the kind changes", run: d => { d.text("\n\n"); d.think("T"); }, shows: ['text:1 completed "\\n\\n"', 'think:1 completed "T"'] },
    { name: "whitespace is written as it is when the Turn ends", run: d => { d.think("  "); }, shows: ['think:1 completed "  "'] },
    { name: "empty text is nothing", run: d => { d.text(""); d.think(""); d.text("\0"); }, shows: [] },
  ];
  for (const entry of cases) {
    const driver = new Driver();
    entry.run(driver);
    driver.settle("completed");
    assert.deepStrictEqual(driver.show(), entry.shows, entry.name);
    check(driver, entry.name);
  }
});

test("windows: a window is a chunk that ends on a code point, the first with something but whitespace opens its segment, and 16 KiB commits without waiting", () => {
  // Nothing is an item until its window is committed.
  const d = new Driver();
  d.text("Hello"); assert.deepStrictEqual(d.show(), []); assert.equal(d.turn.window?.text, "Hello");
  const flushed = d.flush();
  assert.deepStrictEqual(d.show(), ['text:1 running "Hello"']); assert.deepStrictEqual(flushed.changes.text, [{ runId: RUN, itemSeq: 2, chunk: 0, text: "Hello" }]);
  assert.deepStrictEqual(flushed.changes.items?.map(write => [write.op, write.createdByEvent, write.row.startedAt]), [["insert", 0, 10_010]], "the segment began when its text arrived, not when it was committed");

  // A pair split between two windows is moved to the second: the first chunk ends before it.
  const split = new Driver();
  split.text("ab\ud83d"); split.flush(); split.text("\ude00cd"); split.flush(); split.settle();
  assert.deepStrictEqual(split.item("text:1").text, ["ab", "😀cd"]); check(split, "pair");
  assert.deepStrictEqual(split.commits[1]!.changes.text, [{ runId: RUN, itemSeq: 2, chunk: 0, text: "ab" }], "the high surrogate is not in the first chunk");

  // A high surrogate no other half comes to is lone: written as U+FFFD, and told.
  const lone = new Driver();
  lone.text("end\ud83d"); lone.flush(); lone.settle();
  assert.deepStrictEqual(lone.item("text:1").text, ["end", "�"]); assert.deepStrictEqual(native(lone.item("text:1")).surrogates, [[3, 0xd83d]]); check(lone, "lone");
  const alone = new Driver();
  alone.text("\ud83d"); alone.settle();
  assert.deepStrictEqual(alone.show(), ['text:1 completed "�"']); assert.deepStrictEqual(native(alone.item("text:1")).surrogates, [[0, 0xd83d]]);

  // The marks are told by their place in the whole text of the segment.
  const marks = new Driver();
  marks.text("a\ude00"); marks.flush(); marks.text("b\ud83dc"); marks.flush(); marks.settle();
  assert.deepStrictEqual(native(marks.item("text:1")).surrogates, [[1, 0xde00], [3, 0xd83d]]);
  assert.equal(fromItems({ row: ACCEPTED.row, items: marks.items, contentRefs: [] }).messages[1]!.text, "a\ude00b\ud83dc");

  // 16 KiB commits at once; less waits for the timer.
  const big = new Driver();
  big.text("x".repeat(8 * 1024)); assert.deepStrictEqual(big.show(), []);
  const crossed = big.text("y".repeat(8 * 1024));
  assert.equal(crossed.changes.text?.length, 1); assert.equal(big.turn.window, null); assert.equal(big.item("text:1").textBytes, 16 * 1024);
  const one = new Driver(); one.text("z".repeat(2 * 1024 * 1024)); one.settle();
  assert.deepStrictEqual([one.item("text:1").textChunks, one.item("text:1").textBytes], [1, 2 * 1024 * 1024], "an event larger than a window is one window");
});

test("the event a new item was created by is the one the caller says it was logged as", () => {
  const d = new Driver({ eventIndex: 2 });
  d.event(tool("a", "completed")); d.text("x");
  const settled = d.settle();
  assert.deepStrictEqual(d.changes.map(write => [write.op, write.row.itemId, write.createdByEvent]), [["insert", "tool:a", 2], ["insert", "text:1", 2]]);
  assert.deepStrictEqual(settled.changes.items?.map(write => [write.op, write.row.itemId, write.createdByEvent]), [["insert", "text:1", 2]], "an item opened and closed in one call is one write");
});

test("what an approval is about is read from its title, and is `other` when the title says nothing", () => {
  const subject = (title: string) => { const d = new Driver(); d.event({ type: "permission_requested", id: "p", title, options: [{ id: "allow", name: "Allow" }] }); return fieldsOf(d.item("permission:p")).subject; };
  const table: readonly [string, string][] = [["Codex 请求修改文件：a.ts", "file_change"], ["Codex 请求执行命令", "command"], ["子 Agent · Codex 请求执行命令", "command"], ["Edit src/a.ts", "file_change"], ["Write file.txt", "file_change"],
    ["Run npm test", "command"], ["Bash: ls", "command"], ["Read src/a.ts", "file_read"], ["Fetch https://example.com", "network"], ["https://example.com/x", "network"], ["mcp__harnesshub__hub_turns", "tool"], ["Harness 请求执行工具", "other"], ["", "other"]];
  for (const [title, expected] of table) assert.equal(subject(title), expected, JSON.stringify(title));
});

test("identity: the same id again is the same item, and nothing changed means nothing written", () => {
  const d = new Driver();
  const first = d.event(tool("c", "pending", { detail: { kind: "execute", name: "Bash" } }));
  assert.deepStrictEqual(first.changes.items?.map(write => [write.op, write.row.seq, write.row.itemId, write.row.status]), [["insert", 2, "tool:c", "pending"]]);
  const again = d.event(tool("c", "pending"));
  assert.deepStrictEqual(again.changes, {}, "the same report writes nothing");
  const running = d.event(tool("c", "in_progress"));
  assert.deepStrictEqual(running.changes.items?.map(write => [write.op, write.row.seq, write.row.status, write.row.endedAt]), [["update", 2, "running", null]]);
  const done = d.event(tool("c", "completed", { detail: { exitCode: 0, input: "ls -la", output: "x" } }));
  assert.deepStrictEqual(done.changes.items?.map(write => [write.op, write.row.seq, write.row.status, write.row.startedAt, write.row.endedAt]), [["update", 2, "completed", 10_010, 10_040]], "it keeps its place and its beginning");
  assert.equal(done.store.length, 1); assert.equal(done.store[0]!.toolId, "c"); assert.equal(done.store[0]!.detail.input, "ls -la"); assert.equal(done.store[0]!.detail.kind, "execute", "the detail is what the reports made together");
  assert.equal(d.event(tool("c", "completed")).store.length, 0, "a detail is handed over once");
  assert.equal(fieldsOf(d.item("tool:c")).command, "ls -la", "the command is read from the detail that came later");
  const second = d.event(tool("d", "completed"));
  assert.equal(second.changes.items?.[0]?.row.seq, 3, "the next call takes the next place");

  // Refinements that change nothing a reader sees are not written; those that do are.
  const before = d.turn;
  assert.equal(d.event({ type: "usage", usage: { turn: { input: 1 } } }).turn, before, "a usage changes the Turn not at all");
  assert.equal(d.event({ type: "diagnostic", message: "m" }).turn, before);
  assert.equal(d.flush().turn, before, "a flush with nothing in the window");

  // The plan, an activity.
  const plan: ControlEvent = { type: "plan", entries: [{ content: "a", status: "pending" }] };
  assert.equal(d.event(plan).changes.items?.[0]?.op, "insert"); assert.deepStrictEqual(d.event(plan).changes, {});
  assert.equal(d.event({ type: "plan", entries: [{ content: "a", status: "completed" }] }).changes.items?.[0]?.op, "update");
  const act: ControlEvent = { type: "activity", id: "x", kind: "task", title: "work", status: "running" };
  assert.equal(d.event(act).changes.items?.[0]?.op, "insert"); assert.deepStrictEqual(d.event(act).changes, {});
  assert.equal(d.event({ ...act, status: "completed" } as ControlEvent).changes.items?.[0]?.row.status, "completed");
  // The words of a notice are its first chunk and a chunk is never changed: the label that is current is `native.title`.
  d.event({ type: "activity", id: "w", kind: "retry", title: "retry 1/5", status: "running" }); d.event({ type: "activity", id: "w", kind: "retry", title: "retry 2/5", status: "running" });
  assert.deepStrictEqual([d.item("activity:w").text, native(d.item("activity:w")).title], [["retry 1/5"], "retry 2/5"]);
  // An activity that is told as another kind is that kind from then on (the type may be refined while the Turn runs); the chunk it had stays where it is.
  d.event({ type: "activity", id: "w", kind: "task", title: "now a task", status: "running" });
  assert.deepStrictEqual([d.item("activity:w").type, native(d.item("activity:w")).title, d.item("activity:w").text], ["subagent", "now a task", ["retry 1/5"]]);
  check(d, "identity");
});

test("notices a Harness repeats are shown once; the Hub's own are not kept out; fingerprints are told so the conversation remembers them", () => {
  const known = new Set<string>();
  const d = new Driver({ noticeShown: print => known.has(print) });
  const warning: ControlEvent = { type: "notice", severity: "warning", title: "startup", detail: "more" };
  const first = d.event(warning);
  assert.equal(first.changes.noticePrints?.length, 1); assert.match(first.changes.noticePrints![0]!, /^[0-9a-f]{64}$/u);
  // The fingerprint is a function of the notice alone, which the storage conversion also works out for the notices an old Run showed (a NUL or half a pair is mended as it is when placed).
  assert.equal(first.changes.noticePrints![0], noticePrint({ severity: "warning", title: "startup", detail: "more" }));
  assert.equal(noticePrint({ severity: "warning", title: "sta\0rtup", detail: "more" }), noticePrint({ severity: "warning", title: "startup", detail: "more" }));
  assert.notEqual(noticePrint({ severity: "info", title: "startup", detail: "more" }), noticePrint({ severity: "warning", title: "startup", detail: "more" }));
  assert.equal(noticePrint({ severity: "warning", title: "startup", detail: "" }), noticePrint({ severity: "warning", title: "startup" }), "an empty detail is none");
  assert.deepStrictEqual(d.event(warning).changes, {}, "in the Turn");
  known.add(first.changes.noticePrints![0]!);
  const other = new Driver({ noticeShown: print => known.has(print) });
  assert.deepStrictEqual(other.event(warning).changes, {}, "in the conversation");
  assert.deepStrictEqual(other.items.length, 1);
  const hub = other.input({ kind: "notice", severity: "warning", title: "startup", detail: "more", code: "budget", at: 5 });
  assert.deepStrictEqual(hub.changes.items?.map(write => write.row.itemId), ["notice:1"]); assert.equal(hub.changes.noticePrints, undefined);
  assert.equal((fieldsOf(other.item("notice:1")).code), "budget");
  // 200 notices and their repeats.
  const many = new Driver();
  for (let n = 0; n < 200; n++) many.event({ type: "notice", severity: n % 2 ? "info" : "warning", title: "notice " + n });
  for (let n = 0; n < 200; n++) many.event({ type: "notice", severity: n % 2 ? "info" : "warning", title: "notice " + n });
  many.settle(); check(many, "notices");
  assert.equal(many.items.filter(item => item.itemId.startsWith("notice:")).length, 200);
  assert.equal(many.commits.flatMap(placed => placed.changes.noticePrints ?? []).length, 200);
});

test("the versions of a Turn do not know of each other: a Turn put on two ways gives two Turns, and the Turn they started from is as it was", () => {
  const start = new Driver();
  start.event(tool("a", "completed")); start.text("T"); start.flush();
  const before = JSON.stringify(start.items), window = start.turn;
  const left = new Driver({}, start.turn), right = new Driver({}, start.turn);
  left.event(tool("x", "completed")); right.event(tool("y", "completed"));
  right.event(tool("x", "completed")); left.event(tool("y", "running"));
  assert.deepStrictEqual(left.show(), ["tool:a completed", 'text:1 completed "T"', "tool:x completed", "tool:y running"], "left");
  assert.deepStrictEqual(right.show(), ["tool:a completed", 'text:1 completed "T"', "tool:y completed", "tool:x completed"], "right");
  left.event(tool("y", "completed")); right.event(tool("y", "completed"));
  assert.deepStrictEqual([left.item("tool:y").status, right.item("tool:y").status, left.item("tool:y").seq, right.item("tool:y").seq], ["completed", "completed", 5, 4], "each finds its own");
  check(left, "left"); check(right, "right");
  assert.equal(JSON.stringify(start.items), before); assert.equal(start.turn, window);
  // Putting something on a Turn does not change it.
  const unchanged = JSON.stringify([itemsOf(window), window.nextSeq, window.window, window.segment, window.hold, window.counts]);
  place(window, { kind: "event", event: tool("z", "completed"), at: 1 }); place(window, { kind: "settled", status: "failed", at: 2 });
  assert.equal(JSON.stringify([itemsOf(window), window.nextSeq, window.window, window.segment, window.hold, window.counts]), unchanged);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------------------------------------------
const OUTCOMES: readonly TerminalStatus[] = ["completed", "failed", "cancelled", "unknown"];
const closedOf = (item: HeldItem, outcome: TerminalStatus): ItemStatus => settleItems([item], outcome, 0)[0]?.row.status ?? item.status;
interface Open { readonly name: string; readonly open: (d: Driver) => string; readonly expected: Readonly<Record<TerminalStatus, ItemStatus>> }
const same = (word: ItemStatus): Readonly<Record<TerminalStatus, ItemStatus>> => ({ completed: word, failed: word, cancelled: word, unknown: word });
const OPEN_ITEMS: readonly Open[] = [
  { name: "a reply segment still open", open: d => { d.text("answer"); d.flush(); return "text:1"; }, expected: { completed: "completed", failed: "failed", cancelled: "cancelled", unknown: "unknown" } },
  { name: "reasoning still open", open: d => { d.think("hm"); d.flush(); return "think:1"; }, expected: { completed: "completed", failed: "failed", cancelled: "cancelled", unknown: "unknown" } },
  { name: "a call pending", open: d => { d.event(tool("c", "pending", { detail: { kind: "execute", name: "Bash" } })); return "tool:c"; }, expected: { completed: "unknown", failed: "unknown", cancelled: "cancelled", unknown: "unknown" } },
  { name: "a call running", open: d => { d.event(tool("c", "in_progress", { detail: { kind: "read", name: "Read" } })); return "tool:c"; }, expected: { completed: "unknown", failed: "unknown", cancelled: "cancelled", unknown: "unknown" } },
  { name: "a call in a word nobody knows", open: d => { d.event(tool("c", "who-knows")); return "tool:c"; }, expected: same("unknown") },
  { name: "a sub-agent running", open: d => { d.event({ type: "activity", id: "s", kind: "subagent", title: "work", status: "running" }); return "activity:s"; }, expected: { completed: "unknown", failed: "unknown", cancelled: "cancelled", unknown: "unknown" } },
  { name: "a compaction running", open: d => { d.event({ type: "activity", id: "k", kind: "compaction", title: "compacting", status: "running" }); return "activity:k"; }, expected: { completed: "unknown", failed: "unknown", cancelled: "cancelled", unknown: "unknown" } },
  { name: "a retry running", open: d => { d.event({ type: "activity", id: "r", kind: "retry", title: "retrying", status: "running" }); return "activity:r"; }, expected: { completed: "unknown", failed: "unknown", cancelled: "cancelled", unknown: "unknown" } },
  { name: "an approval waiting", open: d => { d.event({ type: "permission_requested", id: "p", title: "Run it", options: [{ id: "allow", name: "Allow" }] }); return "permission:p"; }, expected: same("cancelled") },
  { name: "a question waiting", open: d => { d.event({ type: "permission_requested", id: "q", title: "Which?", options: [{ id: "answer-0", name: "A" }], kind: "question" }); return "permission:q"; }, expected: same("cancelled") },
  { name: "the plan", open: d => { d.event({ type: "plan", entries: [{ content: "s", status: "pending" }] }); return "plan"; }, expected: same("completed") },
  { name: "a call that completed", open: d => { d.event(tool("c", "completed")); return "tool:c"; }, expected: same("completed") },
  { name: "a call that failed", open: d => { d.event(tool("c", "failed")); return "tool:c"; }, expected: same("failed") },
  { name: "a call that was declined", open: d => { d.event(tool("c", "declined")); return "tool:c"; }, expected: same("declined") },
  { name: "a call that was cancelled", open: d => { d.event(tool("c", "cancelled")); return "tool:c"; }, expected: same("cancelled") },
  { name: "an approval that was answered", open: d => { d.event({ type: "permission_requested", id: "p", title: "Run it", options: [{ id: "allow", name: "Allow" }] }); d.input({ kind: "decided", id: "p", option: "allow", at: 1 }); return "permission:p"; }, expected: same("completed") },
  { name: "an approval that was refused", open: d => { d.event({ type: "permission_requested", id: "p", title: "Run it", options: [{ id: "deny", name: "Deny" }] }); d.input({ kind: "decided", id: "p", option: "deny", at: 1 }); return "permission:p"; }, expected: same("declined") },
  { name: "a notice", open: d => { d.event({ type: "notice", severity: "info", title: "n" }); return "notice:1"; }, expected: same("completed") },
  { name: "a link", open: d => { d.event({ type: "output", output: { kind: "link", uri: "https://e.com", name: "e" } }); return "output:1"; }, expected: same("completed") },
];

test("closing: what was still open is told as what it was left as — one case for every cell of the table, by the Turn that ended and by a restart that found it", () => {
  let cells = 0;
  for (const entry of OPEN_ITEMS) for (const outcome of OUTCOMES) {
    const where = entry.name + " / Turn " + outcome, driver = new Driver();
    const id = entry.open(driver);
    const closed = driver.settle(outcome);
    assert.equal(driver.item(id).status, entry.expected[outcome], where);
    // The restart finds the same items in the store and closes them with the same function.
    const recovered = settleItems(replicate(driver.commits.slice(0, -1)), outcome, 77);
    const at = (items: readonly { readonly op: string; readonly row: { readonly itemId: string; readonly status: ItemStatus } }[]) => items.map(write => [write.row.itemId, write.row.status]).sort();
    const wrote = at((closed.changes.items ?? []).filter(write => write.op === "update"));
    const restart = at(recovered);
    // Whatever the closing wrote beyond the segment and the text a window held, a restart writes too.
    for (const line of restart) assert.ok(wrote.some(other => other[0] === line[0] && other[1] === line[1]), where + ": the restart writes " + line + " and the Turn did too");
    assert.ok(driver.items.every(item => item.status !== "pending" && item.status !== "running" && item.status !== "waiting"), where + ": nothing is open");
    assert.equal(driver.turn.settled, outcome);
    // A restart that opens the Turn from its rows and ends it gets the same writes as `settleItems`, and the Turn it opens is the one the items make.
    const found = replicate(driver.commits.slice(0, -1), driver.from), reopened = place(openTurn(ACCEPTED.row, found), { kind: "settled", status: outcome, at: 77 });
    assert.deepStrictEqual((reopened.changes.items ?? []).map(write => [write.op, write.row]), settleItems(found, outcome, 77).map(write => [write.op, write.row]), where + ": a reopened Turn ends the way settleItems says");
    assert.deepStrictEqual(itemsOf(reopened.turn).map(item => item.status), found.map(item => closedOf(item, outcome)), where + ": and holds the items so");
    check(driver, where); cells++;
  }
  assert.equal(cells, OPEN_ITEMS.length * 4);
  // After the end nothing is placed.
  const done = new Driver(); done.text("a"); done.settle("cancelled");
  for (const input of [{ kind: "flush", at: 1 }, { kind: "event", event: { type: "text", text: "late" }, at: 2 }, { kind: "event", event: tool("late", "completed"), at: 3 }, { kind: "settled", status: "completed", at: 4 }] as const) {
    const late = done.input(input);
    assert.equal(late.turn, done.turn); assert.deepStrictEqual(late.changes, {}); assert.deepStrictEqual(late.store, []);
  }
  assert.equal(done.item("text:1").status, "cancelled");
});

test("closing: the items that are not open are not touched, and a restart's writes carry the time of the restart", () => {
  const items: HeldItem[] = [
    ACCEPTED.items[0]!, { runId: RUN, seq: 2, itemId: "tool:a", type: "command", status: "running", startedAt: 5, endedAt: null, parentId: null, createdSeq: null, textBytes: 0, textChunks: 0, fields: { type: "command", command: "ls" }, text: [] },
    { runId: RUN, seq: 3, itemId: "tool:b", type: "command", status: "completed", startedAt: 6, endedAt: 8, parentId: null, createdSeq: null, textBytes: 0, textChunks: 0, fields: { type: "command", command: "pwd" }, text: [] },
  ];
  const writes = settleItems(items, "unknown", 99);
  assert.deepStrictEqual(writes.map(write => [write.op, write.row.itemId, write.row.status, write.row.endedAt, write.row.textBytes, write.row.textChunks]), [["update", "tool:a", "unknown", 99, 0, 0]]);
  assert.deepStrictEqual(settleItems(items.slice(2), "cancelled", 99), []);
});

test("the answer of a Turn: only a completed Turn has one, the last reply segment past the notices, the plan, the artifacts and the context events", () => {
  const item = (seq: number, type: HeldItem["type"]) => ({ seq, type });
  const cases: readonly [string, readonly ReturnType<typeof item>[], RunStatus, number | null][] = [
    ["a reply at the end", [item(1, "user_message"), item(2, "tool"), item(3, "assistant_message")], "completed", 3],
    ["notices, a plan, an artifact and a compaction after it", [item(1, "user_message"), item(2, "assistant_message"), item(3, "notice"), item(4, "plan"), item(5, "artifact"), item(6, "context_event"), item(7, "error")], "completed", 2],
    ["the last of two replies", [item(1, "user_message"), item(2, "assistant_message"), item(3, "tool"), item(4, "assistant_message")], "completed", 4],
    ["a call after the reply", [item(1, "user_message"), item(2, "assistant_message"), item(3, "command")], "completed", null],
    ["reasoning after the reply", [item(1, "user_message"), item(2, "assistant_message"), item(3, "reasoning")], "completed", null],
    ["a reply of a cancelled Turn", [item(1, "user_message"), item(2, "assistant_message")], "cancelled", null],
    ["a reply of a failed Turn", [item(1, "user_message"), item(2, "assistant_message")], "failed", null],
    ["a reply of an unknown Turn", [item(1, "user_message"), item(2, "assistant_message")], "unknown", null],
    ["a Turn still running", [item(1, "user_message"), item(2, "assistant_message")], "running", null],
    ["no reply", [item(1, "user_message")], "completed", null],
  ];
  for (const [name, items, status, expected] of cases) assert.equal(finalItemSeq(items, status), expected, name);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Approvals and questions
// ---------------------------------------------------------------------------------------------------------------------------------
test("the options of an approval are put into roles by what each Harness calls them", () => {
  const table: readonly [string, string, string][] = [
    // ACP (Claude Code, OpenCode, Hermes, Cursor): the optionId and name the Harness gave.
    ["allow", "Yes", "allow_once"], ["allow_once", "Allow once", "allow_once"], ["once", "Allow once", "allow_once"], ["allow_always", "Always allow", "allow_always"], ["always", "Allow always", "allow_always"],
    ["allow_session", "Allow for this session", "allow_session"], ["reject", "No, and tell Claude what to do differently", "deny"], ["reject_once", "Reject", "deny"], ["reject_always", "Always reject", "deny"],
    ["allow", "Yes, and don't ask again", "allow_always"], ["deny", "Deny", "deny"],
    // Codex.
    ["accept", "允许一次", "allow_once"], ["acceptForSession", "本次会话允许", "allow_session"], ["decline", "拒绝", "deny"], ["cancel", "取消", "deny"],
    ["something", "Something else", "other"], ["", "", "other"],
  ];
  for (const [id, name, role] of table) assert.equal(approvalRole({ id, name }), role, id + " / " + name);
});

test("an approval waits as an item, is decided in the same item, and says who decided and when; a question keeps its answer, and a secret is kept nowhere", () => {
  const d = new Driver();
  const open = d.event({ type: "permission_requested", id: "p1", title: "Run `npm test`", detail: "in /work", options: [{ id: "allow_once", name: "Allow once" }, { id: "allow_always", name: "Always allow" }, { id: "reject_once", name: "Reject" }], expiresInMs: 1000, expiresBy: "turn" });
  assert.deepStrictEqual(open.changes.items?.map(write => [write.op, write.row.itemId, write.row.status]), [["insert", "permission:p1", "waiting"]]);
  const approval = fieldsOf(d.item("permission:p1"));
  assert.deepStrictEqual(approval.options, [{ id: "allow_once", role: "allow_once", label: "Allow once" }, { id: "allow_always", role: "allow_always", label: "Always allow" }, { id: "reject_once", role: "deny", label: "Reject" }]);
  assert.equal(approval.subject, "command"); assert.deepStrictEqual(native(d.item("permission:p1")).more, "in /work");
  const decided = d.input({ kind: "decided", id: "p1", option: "allow_always", at: 5000 });
  assert.deepStrictEqual(decided.changes.items?.map(write => [write.op, write.row.status, write.row.endedAt]), [["update", "completed", 5000]]);
  assert.deepStrictEqual(fieldsOf(d.item("permission:p1")).decision, { role: "allow_always", by: "user", at: 5000 });
  assert.deepStrictEqual(d.input({ kind: "decided", id: "p1", option: "reject_once", at: 6000 }).changes, {}, "a decision is made once");

  const denied = new Driver();
  denied.event({ type: "permission_requested", id: "p", title: "Edit a file", options: [{ id: "allow", name: "Allow" }, { id: "reject", name: "Reject" }] });
  denied.input({ kind: "decided", id: "p", option: "reject", by: "policy", at: 9 });
  assert.deepStrictEqual([denied.item("permission:p").status, fieldsOf(denied.item("permission:p")).decision], ["declined", { role: "deny", by: "policy", at: 9 }]);
  const strange = new Driver();
  strange.event({ type: "permission_requested", id: "p", title: "t", options: [{ id: "a", name: "Do the thing" }] }); strange.input({ kind: "decided", id: "p", option: "a", at: 9 });
  assert.deepStrictEqual([strange.item("permission:p").status, fieldsOf(strange.item("permission:p")).decision], ["completed", { role: "other", by: "user", at: 9 }]);

  // Withdrawn by the Harness, timed out, closed with the Turn.
  const gone = new Driver();
  gone.event({ type: "permission_requested", id: "a", title: "A", options: [{ id: "allow", name: "Allow" }] }); gone.event({ type: "permission_requested", id: "b", title: "B", options: [{ id: "allow", name: "Allow" }] });
  gone.event({ type: "permission_requested", id: "c", title: "C?", options: [{ id: "cancel", name: "Cancel" }], kind: "question" });
  gone.event({ type: "permission", id: "a", decision: "denied" });
  assert.deepStrictEqual([gone.item("permission:a").status, fieldsOf(gone.item("permission:a")).decision], ["declined", { role: "deny", by: "harness", at: gone.time }]);
  gone.input({ kind: "expired", at: 777 });
  assert.deepStrictEqual([gone.item("permission:b").status, fieldsOf(gone.item("permission:b")).decision], ["cancelled", { role: "deny", by: "timeout", at: 777 }]);
  assert.deepStrictEqual([gone.item("permission:c").status, fieldsOf(gone.item("permission:c")).decision], ["cancelled", undefined]);
  const stopped = new Driver();
  stopped.event({ type: "permission_requested", id: "z", title: "Z", options: [{ id: "allow", name: "Allow" }] }); stopped.settle("cancelled");
  assert.deepStrictEqual([stopped.item("permission:z").status, fieldsOf(stopped.item("permission:z")).decision], ["cancelled", undefined], "a restart writes no decision");

  // Questions.
  const q = new Driver();
  q.event({ type: "permission_requested", id: "q1", title: "Which one?", options: [{ id: "answer-0", name: "Red" }, { id: "answer-1", name: "Blue" }, { id: "skip", name: "Skip" }, { id: "cancel", name: "Cancel" }], kind: "question" });
  q.event({ type: "permission_requested", id: "q2", title: "Your name?", options: [{ id: "submit", name: "Submit" }], input: { kind: "text", value: "" } });
  q.event({ type: "permission_requested", id: "q3", title: "Skip me", options: [{ id: "skip", name: "Skip" }], kind: "question" });
  q.event({ type: "permission_requested", id: "q4", title: "Cancel me", options: [{ id: "cancel", name: "Cancel" }], kind: "question" });
  q.input({ kind: "decided", id: "q1", option: "answer-1", at: 1 }); q.input({ kind: "decided", id: "q2", option: "submit", input: "Ada", at: 2 });
  q.input({ kind: "decided", id: "q3", option: "skip", at: 3 }); q.input({ kind: "decided", id: "q4", option: "cancel", at: 4 });
  assert.deepStrictEqual(["q1", "q2", "q3", "q4"].map(id => [q.item("permission:" + id).status, fieldsOf(q.item("permission:" + id)).answer]), [["completed", "Blue"], ["completed", "Ada"], ["declined", undefined], ["cancelled", undefined]]);

  // A secret is not an answer anyone can read back: it is in no item, no write and no state of the Turn.
  const SECRET = "hunter2-" + "s3cr3t";
  const secret = new Driver();
  secret.event({ type: "permission_requested", id: "k", title: "API key?", options: [{ id: "submit", name: "Submit" }, { id: "cancel", name: "Cancel" }], input: { kind: "secret", value: "" }, kind: "question" });
  assert.equal(fieldsOf(secret.item("permission:k")).secret, true);
  secret.input({ kind: "decided", id: "k", option: "submit", input: SECRET, at: 5 });
  secret.settle();
  assert.equal(secret.item("permission:k").status, "completed"); assert.equal(fieldsOf(secret.item("permission:k")).answer, undefined);
  for (const where of [JSON.stringify(secret.commits), JSON.stringify(secret.turn), JSON.stringify(secret.items)]) assert.ok(!where.includes(SECRET), "the secret is not there");
});

// A refused approval is the call's outcome, whoever reports what and whenever: the approval says which call it is about (`forItem`), and the call says `declined` — not what its program
// then calls the failure of a call that was refused (Codex says declined, Claude Code says failed). Observed on real machines: the approval item itself was right, the call it refused was not.
test("an approval says which call it is about, and when it ends declined that call is declined, whichever of the refusal and the program's report of the failure comes first", () => {
  const options = [{ id: "allow", name: "Allow" }, { id: "reject", name: "Reject" }];
  const call = (id: string, status: string) => ({ type: "tool" as const, id, title: "Edit a.txt", status, detail: { kind: "edit", name: "Edit" } });
  const status = (d: Driver, id: string) => d.item("tool:" + id).status;
  const turnEnds = (d: Driver, id: string) => { d.settle("completed"); assert.equal(status(d, id), "declined", "the end of the Turn leaves what was decided"); d.settle("failed"); };

  // The refusal first, then the program's report that the call failed.
  const refusedFirst = new Driver();
  refusedFirst.event(call("c1", "pending"));
  refusedFirst.event({ type: "permission_requested", id: "p1", forCall: "c1", title: "Edit a.txt", options });
  assert.equal(fieldsOf(refusedFirst.item("permission:p1")).forItem, "tool:c1", "the approval names the item of the call");
  assert.equal(status(refusedFirst, "c1"), "pending");
  refusedFirst.input({ kind: "decided", id: "p1", option: "reject", at: 500 });
  assert.deepStrictEqual([refusedFirst.item("permission:p1").status, status(refusedFirst, "c1"), refusedFirst.item("tool:c1").endedAt], ["declined", "declined", 500]);
  refusedFirst.event(call("c1", "failed"));
  assert.equal(status(refusedFirst, "c1"), "declined", "a later report of a failure does not change it back");
  refusedFirst.event({ ...call("c1", "failed"), detail: { output: "The user doesn't want to proceed", exitCode: 1 } });
  assert.equal(status(refusedFirst, "c1"), "declined", "nor does the next");
  assert.equal(native(refusedFirst.item("tool:c1")).status, "failed", "what the program reported stays as it reported it");
  assert.deepStrictEqual(refusedFirst.commits.slice(-2).flatMap(placed => placed.changes.items ?? []).filter(write => write.row.itemId === "tool:c1").map(write => write.row.status), ["declined", "declined"],
    "what the program adds about the call (its output, its exit code) is written, and every write of it says declined");
  turnEnds(refusedFirst, "c1");

  // The program's report first (the call already failed when the refusal is recorded), then the refusal.
  const failedFirst = new Driver();
  failedFirst.event(call("c2", "pending"));
  failedFirst.event({ type: "permission_requested", id: "p2", forCall: "c2", title: "Edit a.txt", options });
  failedFirst.event(call("c2", "failed"));
  assert.equal(status(failedFirst, "c2"), "failed");
  failedFirst.input({ kind: "decided", id: "p2", option: "reject", at: 600 });
  assert.deepStrictEqual([failedFirst.item("permission:p2").status, status(failedFirst, "c2")], ["declined", "declined"]);
  turnEnds(failedFirst, "c2");

  // A refusal for a call that has not been reported yet: the call, when it is, is declined however it is reported — in the Turn as it goes, and in the Turn as a restart finds it.
  const unseen = new Driver();
  unseen.event({ type: "permission_requested", id: "p3", forCall: "c3", title: "Edit a.txt", options });
  unseen.input({ kind: "decided", id: "p3", option: "reject", at: 700 });
  assert.equal(unseen.items.some(item => item.itemId === "tool:c3"), false, "nothing is invented for a call nobody reported");
  const found = new Driver({}, openTurn(unseen.turn.run, unseen.items));
  found.event(call("c3", "failed"));
  assert.equal(status(found, "c3"), "declined", "the refusal is in the items a restart finds");
  unseen.event(call("c3", "failed"));
  assert.equal(status(unseen, "c3"), "declined");

  // The Harness took the request back as denied (its own deadline): refused all the same. Timed out by the Hub, closed with the Turn, or allowed: the call is its program's to report.
  const withdrawn = new Driver();
  withdrawn.event(call("c5", "pending")); withdrawn.event({ type: "permission_requested", id: "p5", forCall: "c5", title: "Edit a.txt", options });
  withdrawn.event({ type: "permission", id: "p5", decision: "denied" }); withdrawn.event(call("c5", "failed"));
  assert.deepStrictEqual([withdrawn.item("permission:p5").status, status(withdrawn, "c5")], ["declined", "declined"]);
  const others = new Driver();
  others.event(call("c6", "pending")); others.event({ type: "permission_requested", id: "p6", forCall: "c6", title: "Edit a.txt", options }); others.input({ kind: "expired", at: 900 });
  others.event(call("c6", "failed"));
  assert.deepStrictEqual([others.item("permission:p6").status, status(others, "c6")], ["cancelled", "failed"], "a request that timed out refused nothing");
  const allowed = new Driver();
  allowed.event(call("c7", "pending")); allowed.event({ type: "permission_requested", id: "p7", forCall: "c7", title: "Edit a.txt", options }); allowed.input({ kind: "decided", id: "p7", option: "allow", at: 1000 });
  allowed.event(call("c7", "failed"));
  assert.deepStrictEqual([allowed.item("permission:p7").status, status(allowed, "c7")], ["completed", "failed"], "an allowed call that fails fails");

  // A question names no call; an approval that names none declines nothing but itself.
  const plain = new Driver();
  plain.event(call("c8", "pending")); plain.event({ type: "permission_requested", id: "p8", title: "May I?", options });
  assert.equal(fieldsOf(plain.item("permission:p8")).forItem, undefined);
  plain.input({ kind: "decided", id: "p8", option: "reject", at: 1100 }); plain.event(call("c8", "failed"));
  assert.deepStrictEqual([plain.item("permission:p8").status, status(plain, "c8")], ["declined", "failed"]);
  const asked = new Driver();
  asked.event({ type: "permission_requested", id: "q", forCall: "c9", title: "Which one?", options: [{ id: "skip", name: "Skip" }], kind: "question" });
  assert.equal(fieldsOf(asked.item("permission:q")).forItem, undefined, "a question is about no call");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Details and links
// ---------------------------------------------------------------------------------------------------------------------------------
test("a call's detail is merged as the reports come and cut by nothing; the content store's reference is set once and registered", () => {
  assert.deepStrictEqual(mergeToolDetail({ kind: "execute", input: "a", output: "o1", locations: ["/x"] }, { name: "Bash", output: "o2", exitCode: 0, truncated: true }),
    { kind: "execute", name: "Bash", input: "a", output: "o2", locations: ["/x"], exitCode: 0, truncated: true });
  const huge = "é".repeat(5_000_000);
  assert.equal(mergeToolDetail(undefined, { output: huge }).output, huge, "nothing is cut");

  const d = new Driver();
  d.event(tool("c", "completed", { detail: { kind: "execute", name: "Bash", input: "ls" } }));
  const stored = d.input({ kind: "detail", toolId: "c", ref: ref("one"), at: 9 });
  assert.deepStrictEqual(stored.changes.contentRefs, [{ contentId: "content-one", sessionId: SESSION, runId: RUN, itemSeq: 2, role: "tool_detail" }]);
  assert.deepStrictEqual((fieldsOf(d.item("tool:c")).detail as ContentRef).id, "content-one");
  assert.deepStrictEqual(d.input({ kind: "detail", toolId: "c", ref: ref("one"), at: 10 }).changes, {}, "the same reference is nothing new");
  assert.equal(d.input({ kind: "detail", toolId: "nobody", ref: ref("two"), at: 11 }).turn, d.turn, "a reference for a call that is not there");
  d.event(tool("c", "completed"));
  assert.deepStrictEqual((fieldsOf(d.item("tool:c")).detail as ContentRef).id, "content-one", "the reference stays through the next report");
  assert.equal(fieldsOf(d.item("tool:c")).command, "ls");
  const later = d.input({ kind: "detail", toolId: "c", ref: ref("two"), at: 12 });
  assert.equal(later.changes.contentRefs?.[0]?.contentId, "content-two"); assert.equal(d.items.filter(item => item.itemId === "tool:c").length, 1);

  const out = new Driver();
  const link = out.event({ type: "output", output: { kind: "link", uri: "https://example.com/a", name: "doc", title: "The doc", mediaType: "text/html" } });
  assert.deepStrictEqual(fieldsOf(out.item("output:1")), { type: "artifact", kind: "link", name: "The doc", uri: "https://example.com/a", native: { name: "doc", title: "The doc", mediaType: "text/html" } });
  assert.equal(link.changes.contentRefs, undefined);
  const bytes: ControlEvent = { type: "output", output: { kind: "content", name: "a.png", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) } };
  assert.equal(out.event(bytes).turn, out.turn, "bytes without the reference the content store gave them are nothing to place");
  const image: ContentRef = { ...ref("img"), name: "a.png", mediaType: "image/png", kind: "image", bytes: 3 };
  const made = out.event(bytes, image);
  assert.deepStrictEqual(made.changes.contentRefs, [{ contentId: "content-img", sessionId: SESSION, runId: RUN, itemSeq: 3, role: "output" }]);
  assert.deepStrictEqual([fieldsOf(out.item("output:2")).kind, fieldsOf(out.item("output:2")).name], ["image", "a.png"]);
});

test("a call whose detail could not be kept says so on its item, goes on saying it through its next reports, and stops when a detail is kept", () => {
  const d = new Driver();
  d.event(tool("c", "completed", { detail: { kind: "execute", name: "Bash", input: "ls", output: "files" } }));
  const lost = d.input({ kind: "detail_lost", toolId: "c", at: 9 });
  assert.deepStrictEqual((fieldsOf(d.item("tool:c")).native as { clipped?: string[] }).clipped, [DETAIL_NOT_SAVED]);
  assert.equal(fieldsOf(d.item("tool:c")).detail, undefined, "no reference was made up");
  assert.equal(lost.changes.contentRefs, undefined);
  assert.equal(d.input({ kind: "detail_lost", toolId: "c", at: 10 }).turn, d.turn, "said once");
  assert.equal(d.input({ kind: "detail_lost", toolId: "nobody", at: 10 }).turn, d.turn, "a call that is not there");
  d.event(tool("c", "completed"));
  assert.deepStrictEqual((fieldsOf(d.item("tool:c")).native as { clipped?: string[] }).clipped, [DETAIL_NOT_SAVED], "the next report does not take it away");
  assert.equal(fieldsOf(d.item("tool:c")).command, "ls", "and the command the item knows is still there");
  const kept = d.input({ kind: "detail", toolId: "c", ref: ref("one"), at: 12 });
  assert.equal((fieldsOf(d.item("tool:c")).detail as ContentRef).id, "content-one");
  assert.equal((fieldsOf(d.item("tool:c")).native as { clipped?: string[] }).clipped, undefined, "a detail that is kept takes the mark away");
  assert.equal(kept.changes.contentRefs?.[0]?.contentId, "content-one");
  d.event(tool("c", "completed"));
  assert.equal((fieldsOf(d.item("tool:c")).native as { clipped?: string[] }).clipped, undefined);
  // The marks that are about other things stay when it goes.
  const other = new Driver();
  other.event(tool("n\0", "completed", { detail: { input: "x" } }));
  other.input({ kind: "detail_lost", toolId: "n", at: 9 });
  assert.deepStrictEqual((fieldsOf(other.item("tool:n")).native as { clipped?: string[] }).clipped, ["id:nul", "title:nul", DETAIL_NOT_SAVED]);
  other.input({ kind: "detail", toolId: "n", ref: ref("two"), at: 11 });
  assert.deepStrictEqual((fieldsOf(other.item("tool:n")).native as { clipped?: string[] }).clipped, ["id:nul", "title:nul"]);
  check(d, "unsaved"); check(other, "unsaved too");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------------------------------------------------
function best(count: number, runs = 3): { readonly seconds: number; readonly driver: Driver } {
  let found = manyTools(count);
  for (let n = 1; n < runs; n++) { const next = manyTools(count); if (next.seconds < found.seconds) found = next; }
  return found;
}
function manyTools(count: number): { readonly seconds: number; readonly driver: Driver } {
  const driver = new Driver(), started = performance.now();
  for (let n = 0; n < count; n++) {
    const id = "call-" + n;
    driver.event({ type: "tool", id, title: "run " + n, status: "pending", detail: { kind: "execute", name: "Bash" } });
    driver.event({ type: "tool", id, title: "run " + n, status: "in_progress" });
    driver.event({ type: "tool", id, title: "run " + n, status: "completed", detail: { input: "echo " + n, output: "out " + n, exitCode: 0 } });
    if (n % 50 === 0) driver.text("working on " + n + ". ");
  }
  driver.settle();
  return { seconds: (performance.now() - started) / 1000, driver };
}

test("a Turn of five thousand calls, a reply of 2 MiB, two hundred notices, titles with a NUL and thousands of bytes: nothing is lost, refused or thrown, and the work grows with the Turn", t => {
  const small = best(1000), big = best(5000), huge = manyTools(20_000);
  t.diagnostic(`best of three: 1,000 calls (3,000 events) ${small.seconds.toFixed(3)} s; 5,000 calls (15,000 events) ${big.seconds.toFixed(3)} s; ratio ${(big.seconds / small.seconds).toFixed(1)}×; once: 20,000 calls (60,000 events) ${huge.seconds.toFixed(3)} s`);
  assert.equal(huge.driver.items.length, 20_001 + 400, "twenty thousand calls and the lines of text between them");
  const calls = big.driver.items.filter(item => item.itemId.startsWith("tool:"));
  assert.equal(calls.length, 5000); assert.ok(calls.every((item, at) => item.status === "completed" && item.type === "command" && fieldsOf(item).command === "echo " + at && native(item).exitCode === 0));
  assert.deepStrictEqual(big.driver.items.map(item => item.seq), big.driver.items.map((_, at) => at + 1), "places run on, one after the other");
  assert.equal(big.driver.commits.reduce((count, placed) => count + placed.store.length, 0), 5000, "each call's detail goes to the store once");
  assert.ok(big.seconds < 20, "five thousand calls are reduced in seconds, not minutes");
  assert.ok(big.seconds / small.seconds < 20, "not quadratically: 5× the calls took " + (big.seconds / small.seconds).toFixed(1) + "×");
  check(small.driver, "1,000 calls");

  // A reply of 2 MiB, in the pieces Drivers send.
  const random = mulberry32(7), reply = new Driver();
  let sent = "";
  while (Buffer.byteLength(sent, "utf8") < 2 * 1024 * 1024) { const piece = ("你好 world 😀 ").repeat(1 + Math.floor(random() * 300)); sent += piece; reply.text(piece); if (random() < 0.05) reply.flush(); }
  reply.settle();
  assert.equal(reply.item("text:1").text.join(""), sent, "every byte of the reply is there"); assert.ok(reply.item("text:1").textBytes >= 2 * 1024 * 1024);
  check(reply, "2 MiB");
  assert.equal(fromItems({ row: ACCEPTED.row, items: reply.items, contentRefs: [] }).messages[1]!.text, sent);

  // A title of thousands of bytes with a NUL in it, and a Turn that goes on after it.
  const bad = "你好\0".repeat(2000) + "\ud83d" + "x".repeat(5000), titles = new Driver();
  titles.event(tool("T", "completed", { title: bad, detail: { kind: "execute", name: "Bash" } })); titles.event(tool("U", "completed", { title: "\0" }));
  titles.event({ type: "notice", severity: "warning", title: bad, detail: bad }); titles.text("still going"); titles.settle();
  assert.equal(native(titles.item("tool:T")).title!.length, bad.length - 2000 - 1 + 1, "the title is whole but for its NULs and the half pair");
  assert.deepStrictEqual(native(titles.item("tool:T")).clipped, ["title:nul", "title:surrogate"]);
  assert.deepStrictEqual([native(titles.item("tool:U")).title, native(titles.item("tool:U")).clipped], ["工具调用", ["title:nul", "title:empty"]]);
  assert.equal(titles.item("text:1").text.join(""), "still going"); check(titles, "titles");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The real tables, and the whole-conversation check
// ---------------------------------------------------------------------------------------------------------------------------------
test("the writes of a Turn are accepted by the real tables and their triggers, and what the tables hold is what the Turn holds", () => {
  const driver = new Driver();
  const events: ControlEvent[] = [
    { type: "thinking", text: "let me look" }, tool("a", "pending", { detail: { kind: "execute", name: "Bash" } }), tool("a", "completed", { detail: { input: "ls -la", output: "x", exitCode: 0 } }),
    { type: "text", text: "found it\ud83d" }, { type: "text", text: "\ude00 and \ude00 alone" }, { type: "plan", entries: [{ content: "one", status: "pending" }] }, { type: "notice", severity: "warning", title: "a\0b", detail: "d" },
    { type: "activity", id: "s", kind: "subagent", title: "helper", status: "running" }, { type: "permission_requested", id: "p", title: "Edit", options: [{ id: "allow", name: "Allow" }] },
    { type: "output", output: { kind: "link", uri: "https://example.com", name: "" } }, { type: "text", text: "\n\n" }, { type: "text", text: "the end \ud83d" },
  ];
  for (const event of events) { driver.event(event); if (event.type === "thinking") driver.flush(); }
  driver.input({ kind: "decided", id: "p", option: "allow", at: 1 }); driver.settle("completed");
  check(driver, "script");

  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const sql of schemaV14Statements("fresh")) db.exec(sql);
  db.prepare("INSERT INTO sessions(id,version,last_seq,head,format) VALUES(?,?,?,?,14)").run(SESSION, 1, 3, "{}");
  db.prepare("INSERT INTO commands(session_id,ordinal,command_id,kind,fingerprint,result_id) VALUES(?,0,?,'send',?,?)").run(SESSION, BASE.commandId, "f".repeat(64), RUN);
  db.prepare("INSERT INTO runs(session_id,ordinal,run_id,command_id,status,epoch,harness_id,control_id,user_seq,run_json) VALUES(?,0,?,?,'running',1,'codex','codex-app-server',2,'{}')").run(SESSION, RUN, BASE.commandId);
  const insertItem = db.prepare("INSERT INTO items(run_id,seq,item_id,type,status,started_at,ended_at,parent_id,created_seq,item_json) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const updateItem = db.prepare("UPDATE items SET status=?,started_at=?,ended_at=?,parent_id=?,item_json=? WHERE run_id=? AND seq=?");
  const insertText = db.prepare("INSERT INTO item_text(run_id,item_seq,chunk,byte_offset,text,bytes) VALUES(?,?,?,?,?,?)");
  const offsets = new Map<number, number>();
  const user = ACCEPTED.items[0]!;
  insertItem.run(RUN, 1, user.itemId, user.type, user.status, user.startedAt, user.endedAt, user.parentId, user.createdSeq, JSON.stringify(user.fields));
  insertText.run(RUN, 1, 0, 0, "hello", 5); offsets.set(1, 5);
  for (const { changes } of driver.commits) {
    for (const write of changes.items ?? []) {
      const row = write.row, json = JSON.stringify(row.fields);
      if (write.op === "insert") insertItem.run(RUN, row.seq, row.itemId, row.type, row.status, row.startedAt, row.endedAt, row.parentId, row.createdSeq, json);
      else updateItem.run(row.status, row.startedAt, row.endedAt, row.parentId, json, RUN, row.seq);
    }
    for (const append of changes.text ?? []) {
      const bytes = Buffer.byteLength(append.text, "utf8"), at = offsets.get(append.itemSeq) ?? 0;
      insertText.run(RUN, append.itemSeq, append.chunk, at, append.text, bytes); offsets.set(append.itemSeq, at + bytes);
    }
  }
  // Only now does the Run end: its items were all written before, which the tables insist on.
  db.prepare("UPDATE runs SET status='completed', ended_seq=3 WHERE run_id=?").run(RUN);
  const read = db.prepare("SELECT * FROM items WHERE run_id=? ORDER BY seq").all(RUN).map((found): HeldItem => {
    const chunks = db.prepare("SELECT text FROM item_text WHERE run_id=? AND item_seq=? ORDER BY chunk").all(RUN, found.seq as number).map(chunk => String(chunk.text));
    return { runId: RUN, seq: Number(found.seq), itemId: String(found.item_id), type: found.type as HeldItem["type"], status: found.status as ItemStatus, startedAt: found.started_at as number | null, endedAt: found.ended_at as number | null,
      parentId: found.parent_id as string | null, createdSeq: found.created_seq as number | null, textBytes: Number(found.text_bytes), textChunks: Number(found.text_chunks), fields: JSON.parse(String(found.item_json)), text: chunks };
  });
  assert.deepStrictEqual(read, driver.items.map(item => item.itemId === "user" ? { ...item, textBytes: 5, textChunks: 1 } : item), "the tables hold the Turn");
  // A finished Run's items are frozen: the tables would refuse one more.
  assert.throws(() => updateItem.run("cancelled", 0, 0, null, "{}", RUN, 2), /finished Run|never change/u);
  // And the reader of the Turn gets back what the Harness said, lone surrogates and all.
  assert.equal(fromItems({ row: ACCEPTED.row, items: read, contentRefs: [] }).messages[1]!.text, "found it😀 and \ude00 alone\n\nthe end \ud83d");
  db.close();
});

test("a Turn placed item by item passes the whole-conversation check inside a real conversation, mid-Turn and at every end, and a restart's closing does too", () => {
  const all = fixtureConversations();
  const wanted: RunStatus[] = ["completed", "cancelled", "failed", "unknown"];
  for (const status of wanted) {
    const found = all.find(built => built.conversation.runs.some(run => run.status === status && run.items === undefined && run.ordinal >= 0 && built.turns[run.ordinal]?.items[0]?.itemId === "user"));
    assert.ok(found, "a fixture conversation with a " + status + " Run");
    const run = found.conversation.runs.find(candidate => candidate.status === status && candidate.items === undefined && found.turns[candidate.ordinal]?.items[0]?.itemId === "user")!, built = found.turns[run.ordinal]!;
    const driver = new Driver({}, openTurn({ ...built.run, status: "running" }, [stored({ ...built.items[0]!, text: built.items[0]!.text })]));
    for (const event of [{ type: "thinking", text: "hm" }, tool("a", "pending", { detail: { kind: "execute", name: "Bash" } }), tool("a", "completed", { detail: { input: "ls" } }), tool("b", "in_progress"),
      { type: "text", text: "Answer" }, { type: "notice", severity: "info", title: "n" }, { type: "plan", entries: [{ content: "s", status: "pending" }] }] satisfies ControlEvent[]) driver.event(event);
    // Mid-Turn the Run is held in memory with its items.
    const running = openTurn({ ...built.run, status: "running" }, driver.items);
    assert.ok(running.nextSeq > 2);
    driver.settle(status as TerminalStatus);
    check(driver, status);
    const placed = driver.items.map(stored);
    const conversation = { ...found.conversation, runs: found.conversation.runs.map(candidate => candidate === run ? { ...candidate, status } : candidate) };
    const violations = verify(conversation, readerOf(conversation, found, { items: { [run.ordinal]: () => placed } }));
    assert.deepStrictEqual(violations, [], "a " + status + " Run with the items placed for it");
    // The same Turn found unfinished by a restart: what the store held before the Turn's last input is closed by the same function, and passes too.
    const midway = replicate(driver.commits.slice(0, -1), driver.from), writes = settleItems(midway, status as TerminalStatus, 9);
    const closed = midway.map(item => { const write = writes.find(candidate => candidate.row.seq === item.seq); return write === undefined ? item : { ...item, status: write.row.status, endedAt: write.row.endedAt }; });
    assert.deepStrictEqual(verify(conversation, readerOf(conversation, found, { items: { [run.ordinal]: () => closed.map(stored) } })), [], "a " + status + " Run closed by a restart");
  }
  // A Run that is still going holds its items in memory: after every input they pass the check, and no step takes anything away from them or changes what was written.
  const live = all.find(built => built.conversation.runs.some(run => run.items !== undefined && run.status === "running"));
  assert.ok(live, "a fixture conversation with a Run that is running");
  const run = live.conversation.runs.find(candidate => candidate.items !== undefined && candidate.status === "running")!, driver = new Driver({}, openTurn(live.turns[run.ordinal]!.run, run.items!.slice(0, 1)));
  const stateOf = (): Conversation => ({ ...live.conversation, runs: live.conversation.runs.map(candidate => candidate === run ? { ...candidate, items: driver.items.map(stored) } : candidate) });
  let before = stateOf();
  const script: readonly PlaceInput[] = [
    { kind: "event", event: { type: "text", text: "so far" }, at: 1 }, { kind: "flush", at: 2 }, { kind: "event", event: tool("a", "in_progress"), at: 3 }, { kind: "event", event: { type: "text", text: "more\ud83d" }, at: 4 },
    { kind: "event", event: { type: "text", text: "\ude00 and more" }, at: 5 }, { kind: "flush", at: 6 }, { kind: "event", event: tool("a", "completed", { detail: { input: "ls" } }), at: 7 }, { kind: "event", event: { type: "thinking", text: "hm" }, at: 8 },
    { kind: "event", event: { type: "permission_requested", id: "p", title: "Edit", options: [{ id: "allow", name: "Allow" }] }, at: 9 }, { kind: "decided", id: "p", option: "allow", at: 10 },
    { kind: "event", event: { type: "notice", severity: "info", title: "n" }, at: 11 }, { kind: "event", event: { type: "text", text: "the end" }, at: 12 },
  ];
  assert.deepStrictEqual(verify(before, readerOf(before, live)), [], "the Run as the fixture holds it");
  for (const input of script) {
    driver.input(input);
    const after = stateOf();
    assert.deepStrictEqual(verify(after, readerOf(after, live)), [], "a running Run with the items placed so far");
    assert.deepStrictEqual(verifyTransition(before, after), [], "and what one input did to it is only to add and to lengthen");
    before = after;
  }
});
