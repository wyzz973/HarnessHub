import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseSession } from "../../src/infrastructure/session/legacy/state.js";
import { dispatched } from "../../src/contexts/session/domain/relay/advance.js";
import { normalizeTool, plainTool } from "../../src/contexts/session/domain/protocol/index.js";
import { fromItems, originFromRows, originToRows, storageConversion, toItems, type ConversionAt } from "../../src/contexts/session/domain/store-conversion.js";
import type { ContentRefRow, ConvertedRun, HeldItem, RunRow } from "../../src/contracts/conversation.js";
import type { ContentRef } from "../../src/contracts/content.js";
import { sessionId, type PublicMessage, type PublicRun, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import { GENERATIONS, loadGeneration } from "../fixtures/storage/generations/database.js";
import { V13_FIXTURES, loadV13Fixture } from "../fixtures/storage/v13/database.js";

// The storage conversion of ADR-057 3.6 (src/contexts/session/domain/store-conversion.ts): `fromItems(toItems(x))` deep-equals `x` for every Run of
// the frozen v13 fixtures (tests/fixtures/storage/v13) and the generation samples, for random Runs that the old validation accepts and for random
// Runs it would not (NUL, half a surrogate pair, empty and repeated ids, thousands of calls); in memory, through JSON and UTF-8, and through a
// real SQLite database; the function is total, deterministic and pure; and every content reference of a Run is registered.

// ---------------------------------------------------------------------------------------------------------------------------------
// The Runs of the fixtures, with what the migration reads of the events for each
// ---------------------------------------------------------------------------------------------------------------------------------
interface Turn { readonly run: PublicRun; readonly user: PublicMessage; readonly assistant?: PublicMessage; readonly at: ConversionAt; readonly where: string; readonly snapshot: SessionSnapshot }
type StoredEvent = Pick<SessionEvent, "seq" | "type" | "data">;
/** The `at` arguments a migration would work out of the event log and the switches (see the top of store-conversion.ts). */
function turnsOf(snapshot: SessionSnapshot, events: readonly StoredEvent[], where: string): Turn[] {
  const ended = new Map<string, number>(), commands = new Map<string, unknown>(), settled = new Map<string, unknown>();
  for (const event of events) {
    const run = typeof event.data.runId === "string" ? event.data.runId : null;
    if (event.type === "run.ended" && run !== null && !ended.has(run)) { ended.set(run, event.seq); settled.set(run, event.data.contextEffect); }
    else if (event.type === "run.native_command" && run !== null) commands.set(run, event.data.contextEffect);
    else if (event.type === "session.recovered") for (const id of [...(event.data.unknownRunIds as string[] ?? []), ...(event.data.cancelledRunIds as string[] ?? [])]) if (!ended.has(id)) ended.set(id, event.seq);
  }
  return snapshot.runs.map((run, ordinal) => {
    const user = snapshot.messages.find(message => message.id === run.userMessageId)!, assistant = snapshot.messages.find(message => message.id === run.assistantMessageId);
    const claimed = run.status === "unknown" ? snapshot.switches.find(sw => sw.status === "effective" && (sw.sourceRunIds.includes(run.id) || sw.acknowledgedUnknown?.includes(run.id) === true)) : undefined;
    const at: ConversionAt = { sessionId: snapshot.id, ordinal, ...(ended.has(run.id) ? { endedSeq: ended.get(run.id)! } : {}), ...(commands.has(run.id) ? { isCommand: true } : {}),
      ...(typeof commands.get(run.id) === "string" ? { commandEffect: commands.get(run.id) as ConversionAt["commandEffect"] & string } : {}),
      ...(typeof settled.get(run.id) === "string" ? { settledEffect: settled.get(run.id) as ConversionAt["settledEffect"] & string } : {}), ...(claimed === undefined ? {} : { acknowledgedBy: claimed.id }) };
    return { run, user, ...(assistant === undefined ? {} : { assistant }), at, where: where + " " + run.id, snapshot };
  });
}
const fixtureTurns: Turn[] = [], fixtureSessions: { readonly name: string; readonly snapshot: SessionSnapshot; readonly events: readonly StoredEvent[] }[] = [];
for (const name of V13_FIXTURES) {
  for (const row of loadV13Fixture(name).sessions) {
    const snapshot = row.snapshot as unknown as SessionSnapshot;
    fixtureSessions.push({ name, snapshot, events: row.events });
    fixtureTurns.push(...turnsOf(snapshot, row.events, name));
  }
}
const generationTurns: Turn[] = [];
for (const version of GENERATIONS) for (const row of loadGeneration(version).sessions) generationTurns.push(...turnsOf(row.snapshot as unknown as SessionSnapshot, row.events, "v" + version));

const asOld = (turn: Turn) => ({ run: turn.run, messages: turn.assistant === undefined ? [turn.user] : [turn.user, turn.assistant] });
function roundTrips(turn: Turn, how: string, back: ConvertedRun): void { assert.deepStrictEqual(fromItems(back), asOld(turn), turn.where + " (" + how + ")"); }
const convert = (turn: Turn): ConvertedRun => toItems(turn.run, { user: turn.user, ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }) }, turn.at);
const survivesUtf8 = (text: string): boolean => Buffer.from(text, "utf8").toString("utf8") === text;
/** The rows as a JSON column keeps them, and the chunks as UTF-8 does. */
function viaJson(converted: ConvertedRun): ConvertedRun {
  return JSON.parse(JSON.stringify({ ...converted, items: converted.items.map(item => ({ ...item, text: item.text.map(chunk => Buffer.from(chunk, "utf8").toString("utf8")) })) })) as ConvertedRun;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A real database: what a conversion's rows go through (JSON columns, a TEXT column for the chunks)
// ---------------------------------------------------------------------------------------------------------------------------------
const database = new DatabaseSync(":memory:");
// As the real tables have it: the item's id and its parent are TEXT columns (a column holds half of a surrogate pair as U+FFFD), and the rest of the item is JSON.
database.exec(`CREATE TABLE runs(run_id TEXT PRIMARY KEY, row_json TEXT NOT NULL CHECK(json_valid(row_json))) STRICT;
CREATE TABLE items(run_id TEXT NOT NULL, seq INTEGER NOT NULL, item_id TEXT NOT NULL, parent_id TEXT, item_json TEXT NOT NULL CHECK(json_valid(item_json)), PRIMARY KEY(run_id, seq)) STRICT;
CREATE TABLE item_text(run_id TEXT NOT NULL, item_seq INTEGER NOT NULL, chunk INTEGER NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes=length(CAST(text AS BLOB))), PRIMARY KEY(run_id, item_seq, chunk)) STRICT, WITHOUT ROWID;`);
const putRun = database.prepare("INSERT INTO runs(run_id,row_json) VALUES(?,?)"), putItem = database.prepare("INSERT INTO items(run_id,seq,item_id,parent_id,item_json) VALUES(?,?,?,?,?)");
const putText = database.prepare("INSERT INTO item_text(run_id,item_seq,chunk,text,bytes) VALUES(?,?,?,?,?)");
const getRun = database.prepare("SELECT row_json FROM runs WHERE run_id=?"), getItems = database.prepare("SELECT seq,item_id,parent_id,item_json FROM items WHERE run_id=? ORDER BY seq");
const getText = database.prepare("SELECT text FROM item_text WHERE run_id=? AND item_seq=? ORDER BY chunk");
function throughDatabase(converted: ConvertedRun): ConvertedRun {
  const id = converted.row.runId;
  putRun.run(id, JSON.stringify(converted.row));
  for (const item of converted.items) {
    const { text, itemId, parentId, ...rest } = item;
    putItem.run(id, item.seq, itemId, parentId, JSON.stringify(rest));
    text.forEach((chunk, at) => putText.run(id, item.seq, at, chunk, Buffer.byteLength(chunk, "utf8")));
  }
  const row = JSON.parse(String(getRun.get(id)!.row_json)) as RunRow;
  const items = getItems.all(id).map((found): HeldItem => ({ ...(JSON.parse(String(found.item_json)) as Omit<HeldItem, "text" | "itemId" | "parentId">), itemId: String(found.item_id), parentId: found.parent_id === null ? null : String(found.parent_id),
    text: getText.all(id, Number(found.seq)).map(chunk => String(chunk.text)) }));
  for (const table of ["item_text WHERE run_id", "items WHERE run_id", "runs WHERE run_id"]) database.prepare("DELETE FROM " + table + "=?").run(id);
  return { row, items, contentRefs: converted.contentRefs };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------------------------------------------------------------
test("every Run of the v13 fixtures and the generation samples comes back from its rows as it was: in memory, through JSON and UTF-8, and through a SQLite database", t => {
  const all = [...fixtureTurns, ...generationTurns];
  assert.ok(fixtureTurns.length >= 150 && generationTurns.length >= 40, "the fixtures hold the Runs this test is about");
  for (const turn of all) {
    const converted = convert(turn);
    roundTrips(turn, "in memory", converted);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(converted)), converted, turn.where + ": the rows are plain JSON (no undefined, nothing a column cannot hold)");
    roundTrips(turn, "JSON and UTF-8", viaJson(converted));
    roundTrips(turn, "SQLite", throughDatabase(converted));
  }
  t.diagnostic(`${fixtureTurns.length} Runs of ${V13_FIXTURES.length} v13 fixtures and ${generationTurns.length} of the ${GENERATIONS.length} generation samples`);
});

test("the conversion is deterministic, and an input that is converted again from what it gave back converts to the same rows", () => {
  for (const turn of [...fixtureTurns, ...generationTurns]) {
    const first = convert(turn), second = convert(turn);
    assert.deepStrictEqual(first, second, turn.where + ": the same arguments, the same rows");
    const back = fromItems(first);
    assert.deepStrictEqual(toItems(back.run, { user: back.messages[0]!, ...(back.messages[1] === undefined ? {} : { assistant: back.messages[1] }) }, turn.at), first, turn.where + ": rows → Run → rows");
  }
});

test("the conversion reads no clock and no random, and changes nothing it is given (deeply frozen arguments, a deeply frozen result back)", () => {
  const freeze = <T>(value: T): T => { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
  const now = Date.now, random = Math.random, performanceNow = performance.now;
  const turns = structuredClone(fixtureTurns.filter((_, at) => at % 5 === 0).map(turn => ({ run: turn.run, user: turn.user, assistant: turn.assistant, at: turn.at })));
  const refused = () => { throw new Error("read the clock or the random generator"); };
  try {
    Date.now = refused; Math.random = refused; performance.now = refused;
    for (const turn of turns) {
      freeze(turn);
      const converted = freeze(toItems(turn.run, { user: turn.user, ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }) }, turn.at));
      assert.deepStrictEqual(fromItems(converted).run, turn.run);
    }
  } finally { Date.now = now; Math.random = random; performance.now = performanceNow; }
  assert.ok(turns.length > 20);
});

test("what the rows hold of a Run: the fixed order and ids, the messages' seqs, the columns, the native facts of every kind, and no derived value that a stored detail would change", () => {
  const find = (name: string, id: string) => fixtureTurns.find(turn => turn.where === name + " " + id)!;
  // The first Turn of `tools`: every shape of work.
  const first = fixtureTurns.find(turn => turn.where.startsWith("tools ") && (turn.run.tools?.length ?? 0) > 10)!, converted = convert(first), rows = converted.items;
  const kinds = rows.map(item => item.itemId.replace(/:.*/u, ""));
  const order = ["user", "think", "tool", "activity", "plan", "notice", "text", "output"];
  assert.deepStrictEqual([...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b)), kinds, "user, thinking, calls, activities, plan, notices, reply, outputs");
  assert.deepStrictEqual(rows.map(item => item.seq), rows.map((_, at) => at + 1), "seq runs from 1 over the items there are");
  assert.equal(converted.row.legacyOrder, true);
  assert.equal(rows[0]!.itemId, "user"); assert.equal(rows[0]!.createdSeq, first.user.seq); assert.equal(converted.row.userSeq, first.user.seq);
  assert.equal(rows.find(item => item.itemId === "text:1")!.createdSeq, first.assistant!.seq);
  assert.ok(rows.filter(item => item.itemId !== "user" && item.itemId !== "text:1").every(item => item.createdSeq === null), "nothing else says when it happened");
  assert.ok(rows.every(item => item.startedAt === null && item.endedAt === null && item.textBytes === 0 && item.textChunks === 0), "the store counts the chunks it appends");
  // The native facts are what the Harness said, verbatim; a task-list call is a row; a call with an exit code that is no command keeps it.
  const bash = rows.find(item => item.itemId === "tool:Bash:2")!;
  assert.deepEqual(bash.fields.native, { title: "npm test", status: "failed", kind: "execute", name: "Bash", exitCode: 1 });
  assert.equal(bash.type, "command"); assert.equal(bash.status, "failed");
  for (const id of ["tool:Todo:1", "tool:Todo:2", "tool:Todo:3"]) assert.ok(rows.some(item => item.itemId === id), id + " is a row");
  assert.deepStrictEqual(rows.filter(item => item.itemId.startsWith("tool:Todo:")).map(item => item.type), ["tool", "tool", "tool"], "a task-list call is told as the plain tool it is, its words kept");
  assert.equal(rows.find(item => item.itemId === "tool:Bash:3")!.parentId, "tool:Task:1", "the item of the sub-agent a call happened inside");
  assert.equal(rows.find(item => item.itemId === "plan")!.fields.type, "plan");
  assert.deepEqual((rows.find(item => item.itemId === "plan")!.fields as { readonly steps: readonly { readonly priority?: string }[] }).steps.map(step => step.priority), ["high", "medium", "low", undefined], "a plan step keeps its priority");
  const sub = rows.find(item => item.itemId === "activity:sub-1")!;
  assert.deepEqual(sub.fields.native, { title: "Audit subagent", kind: "subagent", status: "completed", more: "done after 3 calls" }, "an activity keeps every field");
  assert.deepEqual(rows.find(item => item.itemId === "output:1")!.fields.native, { name: "report", title: "The report", mediaType: "text/html" }, "a link keeps its name, title and type apart");
  assert.deepEqual(rows.find(item => item.itemId === "notice:2")!.fields.native, { title: "Slow network", more: "latency 2.3 s" });
  // The label of a notice is its chunk (the item fields leave `text` out) and also native.title: the reader puts `text` back in the wire item from the chunk, and the round trip reads the title.
  assert.equal(rows.find(item => item.itemId === "notice:2")!.text.join(""), "Slow network", "a notice's label is the text of its item");
  assert.equal(rows.find(item => item.itemId === "activity:retry-1")!.text.join(""), "Retrying the request", "so is the label of a retry or review told as a notice");
  assert.ok(rows.filter(item => item.itemId.startsWith("notice:") && item.type === "notice").every(item => item.text.join("") === item.fields.native!.title), "for every notice");
  // An error notice beside the Run's own error is an item whatever the display does with it (the Run of the failed Turn of `tools`).
  const failed = fixtureTurns.find(turn => turn.where.startsWith("tools ") && turn.run.status === "failed" && turn.run.error !== null && turn.run.notices?.some(notice => notice.severity === "error"))!, failedRows = convert(failed).items;
  assert.ok(failedRows.some(item => item.type === "error" && item.itemId.startsWith("notice:") && item.fields.native?.title === "The build failed" && item.fields.native.more === "error TS2304: cannot find name 'x'"));
  assert.notEqual(failed.run.error, null);
  // The columns.
  const row = converted.row;
  assert.deepEqual([row.sessionId, row.ordinal, row.runId, row.status, row.epoch, row.harnessId, row.controlId, row.managed], [first.snapshot.id, first.at.ordinal, first.run.id, first.run.status, first.run.epoch, first.run.selection.harnessId, first.run.selection.controlId, false]);
  assert.equal(row.dispatched, dispatched(first.run)); assert.equal(row.acceptedAt, first.run.timing!.acceptedAt); assert.equal(row.preparingAt, first.run.timing!.preparingAt ?? null);
  const provider = fixtureTurns.find(turn => turn.run.selection.provider !== undefined)!;
  assert.equal(convert(provider).row.managed, true); assert.equal(convert(provider).row.executedOn, null);
  const carried = fixtureTurns.find(turn => turn.run.relay?.executedOn != null)!;
  assert.deepEqual(convert(carried).row.executedOn, carried.run.relay!.executedOn);
  // What the caller supplies is put in the row, and what it leaves out is null.
  const command = fixtureTurns.find(turn => turn.at.isCommand === true && turn.at.settledEffect === "compact")!, commandRow = convert(command).row;
  assert.deepEqual([commandRow.isCommand, commandRow.commandEffect, commandRow.settledEffect, commandRow.endedSeq !== null], [true, "compact", "compact", true]);
  const plain = convert(first).row;
  assert.deepEqual([plain.isCommand, plain.commandEffect, plain.settledEffect, plain.acknowledgedBy], [false, null, null, null]);
  const lost = fixtureTurns.find(turn => turn.where.startsWith("unknown-recovered ") && turn.run.status === "unknown" && turn.at.acknowledgedBy !== undefined)!;
  assert.equal(convert(lost).row.acknowledgedBy, lost.at.acknowledgedBy); assert.equal(find("unknown-recovered", lost.run.id).run.status, "unknown");
  // The derived values are worked out without a stored detail: a call is the same item whether or not the detail could be read.
  const call = first.run.tools!.find(tool => tool.id === "Bash:1")!;
  const derived = normalizeTool(call, { seq: 0, detail: null, turn: "ended" });
  assert.ok(derived.row);
  const stored = rows.find(item => item.itemId === "tool:Bash:1")!;
  assert.equal(stored.type, derived.item.type); assert.equal((stored.fields as { readonly command?: string }).command, (derived.item as { readonly command?: string }).command);
  assert.equal(plainTool(call, { seq: 0, detail: null, turn: "ended" }).type, "tool");
});

test("a call still open in a Turn that is over did not finish: cancelled when the Turn was stopped, unknown otherwise; the word the Harness gave stays in the native facts", () => {
  const stopped = fixtureTurns.find(turn => turn.where.startsWith("tools ") && turn.run.status === "cancelled" && turn.run.tools?.some(tool => tool.status === "in_progress"))!;
  const rows = convert(stopped).items;
  assert.equal(rows.find(item => item.itemId === "tool:C:1")!.status, "cancelled"); assert.equal(rows.find(item => item.itemId === "tool:C:1")!.fields.native!.status, "in_progress");
  assert.equal(rows.find(item => item.itemId === "tool:C:2")!.status, "cancelled");
  assert.equal(rows.find(item => item.itemId === "text:1")!.status, "cancelled", "a reply the Turn was stopped in the middle of takes the Turn's state");
  const crashed = fixtureTurns.find(turn => turn.where.startsWith("recovered-after-crash ") && turn.run.status === "unknown")!;
  assert.equal(convert(crashed).items.find(item => item.itemId === "tool:R:1")!.status, "unknown");
  const going = fixtureTurns.find(turn => turn.where.startsWith("running-crash ") && turn.run.status === "running")!;
  assert.equal(convert(going).items.find(item => item.itemId === "tool:R:1")!.status, "running", "a Turn still going keeps its calls going: recovery ends them");
  const queued = fixtureTurns.find(turn => turn.run.status === "queued")!, queuedItems = convert(queued).items;
  assert.deepEqual(queuedItems.map(item => item.itemId), ["user"], "an input that waits is its user message");
});

test("a Run's items hold every content reference of the Run, once each, and the references of all the Runs and origins of a fixture are the set its store would keep", () => {
  const roles = (refs: readonly ContentRefRow[]) => refs.map(ref => ref.role + ":" + ref.contentId + "@" + ref.itemSeq).sort();
  for (const turn of fixtureTurns) {
    const converted = convert(turn), wanted: string[] = [];
    for (const item of converted.items) if (item.fields.detail !== undefined) wanted.push("tool_detail:" + item.fields.detail.id + "@" + item.seq);
    for (const [index, output] of (turn.run.outputs ?? []).entries()) if (output.kind === "content") wanted.push("output:" + output.content.id + "@" + converted.items.find(item => item.itemId === "output:" + (index + 1))!.seq);
    for (const attachment of turn.run.attachments ?? []) wanted.push("attachment:" + attachment.id + "@1");
    assert.deepEqual(roles(converted.contentRefs), wanted.sort(), turn.where);
    assert.ok(converted.contentRefs.every(ref => ref.runId === turn.run.id && ref.sessionId === turn.snapshot.id), "a reference names its Run and conversation");
    assert.equal(new Set(converted.contentRefs.map(ref => ref.role + ref.contentId + ref.itemSeq)).size, converted.contentRefs.length, "once each");
  }
  // The union over a whole fixture, with the origins' attachments: what the store's collector keeps.
  for (const name of V13_FIXTURES) {
    const fixture = loadV13Fixture(name), found = new Set<string>();
    for (const row of fixture.sessions) {
      const snapshot = row.snapshot as unknown as SessionSnapshot;
      for (const turn of turnsOf(snapshot, row.events, name)) for (const ref of convert(turn).contentRefs) found.add(ref.contentId);
      if (snapshot.origin !== undefined) for (const ref of originToRows(snapshot.id, snapshot.origin, -1).contentRefs) found.add(ref.contentId);
    }
    assert.deepEqual([...found].sort(), fixture.contentReferences, name + ": the references of the converted conversations are the ones the v13 store reports");
  }
});

test("the origins (a branch's quoted history, an import's recent messages) go to rows as they are and come back as they were, with their attachments registered", () => {
  let origins = 0, attachments = 0;
  for (const { name, snapshot } of fixtureSessions) {
    const origin = snapshot.origin;
    if (origin === undefined) continue;
    const parts = originToRows(snapshot.id, origin, 1), viaJson = JSON.parse(JSON.stringify({ stored: parts.stored, rows: parts.rows }));
    assert.deepStrictEqual(originFromRows(parts.stored, parts.rows), origin, name + " " + snapshot.id);
    assert.deepStrictEqual(originFromRows(viaJson.stored, viaJson.rows), origin, name + " " + snapshot.id + " through JSON");
    assert.deepEqual(parts.rows.map(row => row.idx), origin.history.map((_, at) => at));
    assert.ok(parts.rows.every(row => row.kind === origin.kind && row.sessionId === snapshot.id));
    for (const ref of parts.contentRefs) { assert.deepEqual([ref.runId, ref.itemSeq, ref.role], [null, null, "origin_attachment"]); attachments++; }
    if (origin.kind === "fork") assert.equal(parts.stored.kind === "fork" && parts.stored.quoted, true, "a branch made before v14 holds the history it quoted");
    origins++;
  }
  assert.ok(origins >= 6 && attachments >= 3, "the fixtures hold branches and imports, with attachments in a quoted history");
  assert.equal(originFromRows({ kind: "fork", sessionId: sessionId("session-a"), throughRunId: "run-a" as never, throughOrdinal: 0, quoted: false }, []), null, "a branch that refers to its source has no history of its own to give");
});

test("fromItems is also the adapter for a Turn that kept its order: segments of one reply or thinking are joined, and an item with no place in the old shape is left out", () => {
  const turn = fixtureTurns.find(candidate => candidate.where.startsWith("tools ") && candidate.run.thinking !== undefined && candidate.assistant !== undefined && (candidate.run.tools?.length ?? 0) > 10)!;
  const converted = convert(turn), reply = converted.items.find(item => item.itemId === "text:1")!, thought = converted.items.find(item => item.itemId === "think:1")!;
  const cut = (item: HeldItem, id: string, at: number): HeldItem => ({ ...item, itemId: id, text: [item.text.join("").slice(at)] });
  const firstHalf = (item: HeldItem, at: number): HeldItem => ({ ...item, text: [item.text.join("").slice(0, at)] });
  const approval: HeldItem = { runId: turn.run.id, seq: 900, itemId: "permission:p1", type: "approval", status: "completed", startedAt: null, endedAt: null, parentId: null, createdSeq: 50, textBytes: 0, textChunks: 0,
    fields: { type: "approval", subject: "command", title: "Run it?", options: [] }, text: [] };
  const kept: ConvertedRun = { ...converted, row: { ...converted.row, legacyOrder: false }, items: [
    firstHalf(thought, 5), ...converted.items.filter(item => item !== reply && item !== thought && item.itemId !== "user").map(item => ({ ...item, seq: item.seq + 1 })), approval,
    { ...cut(reply, "text:2", 9), seq: 901 }, { ...firstHalf(reply, 9), seq: 5 }, { ...cut(thought, "think:2", 5), seq: 902 }, converted.items[0]!] };
  const back = fromItems(kept);
  assert.equal(back.run.thinking, turn.run.thinking, "the thinking segments are joined in the order of seq");
  assert.equal(back.messages[1]!.text, turn.assistant!.text, "so is the reply, and the message keeps the seq of its first segment");
  assert.equal(back.messages[1]!.seq, turn.assistant!.seq);
  assert.deepStrictEqual(back.run.tools, turn.run.tools); assert.deepStrictEqual(back.run.notices, turn.run.notices);
});

test("a Run that is over has no item that is still open, and every item is a protocol item once its text is put back", () => {
  const unfinished = new Set(["pending", "running", "waiting"]);
  const required: Readonly<Record<string, readonly string[]>> = { user_message: ["messageId"], assistant_message: ["messageId"], reasoning: [], command: ["command"], file_read: ["path"], file_change: ["changes"], search: ["scope", "query"],
    web: ["action"], mcp_tool: ["server", "tool"], tool: ["name"], subagent: ["title"], plan: ["steps"], notice: ["severity", "text"], error: ["class", "message"], context_event: ["kind"], artifact: ["kind", "name"] };
  const seen = new Set<string>();
  for (const turn of [...fixtureTurns, ...generationTurns]) {
    for (const item of convert(turn).items) {
      if (["completed", "cancelled", "failed", "unknown"].includes(turn.run.status)) assert.ok(!unfinished.has(item.status), turn.where + " " + item.itemId + " is " + item.status + " in a Turn that is over");
      assert.equal(item.type, item.fields.type);
      const wire: Record<string, unknown> = { id: item.itemId, seq: item.seq, status: item.status, ...item.fields };
      if (item.type === "notice" || item.type === "reasoning") wire.text = item.text.join("");
      for (const key of required[item.type] ?? assert.fail("a type the conversion made but the wire does not know: " + item.type)) assert.ok(key in wire, turn.where + " " + item.itemId + " (" + item.type + ") has no " + key);
      seen.add(item.type);
    }
  }
  for (const type of ["user_message", "assistant_message", "reasoning", "command", "file_read", "file_change", "search", "web", "mcp_tool", "tool", "subagent", "plan", "notice", "error", "context_event", "artifact"]) assert.ok(seen.has(type), "the fixtures hold a " + type);
});

test("a call titled with a long run of spaces does not make the derived reading take quadratic time, and its native title stays whole", () => {
  const template = templates.find(turn => turn.run.status === "completed" && turn.assistant !== undefined)!;
  const title = "read: " + " ".repeat(400_000) + "b";
  const turn: Turn = { ...template, run: { ...template.run, tools: [{ id: "t", title, status: "completed", kind: "read" }] }, where: "spaces" };
  const started = performance.now();
  const converted = convert(turn);
  assert.ok(performance.now() - started < 2000, "the conversion took " + Math.round(performance.now() - started) + " ms");
  assert.equal(converted.items.find(item => item.itemId === "tool:t")!.fields.native!.title, title);
  roundTrips(turn, "in memory", converted);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What the engine does with the text (the reason lone surrogates are carried apart)
// ---------------------------------------------------------------------------------------------------------------------------------
test("SQLite keeps a NUL and a pair in a TEXT column, and stores a lone surrogate as U+FFFD: so the chunks hold U+FFFD in its place and the item remembers which unit it was", () => {
  const engine = new DatabaseSync(":memory:");
  engine.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT");
  const stored = (text: string): string => { engine.prepare("DELETE FROM t").run(); engine.prepare("INSERT INTO t(id,text) VALUES(1,?)").run(text); return String(engine.prepare("SELECT text FROM t WHERE id=1").get()!.text); };
  assert.equal(stored("a\u0000b"), "a\u0000b"); assert.equal(stored("p😀q"), "p😀q"); assert.equal(stored("x\ud83dy"), "x\ufffdy"); assert.equal(stored("x\ude00y"), "x\ufffdy"); assert.equal(stored("end\ud83d"), "end\ufffd");
  const turn = fixtureTurns.find(candidate => candidate.run.thinking?.endsWith("\ud83d"))!;
  const rows = convert(turn).items, thought = rows.find(item => item.itemId === "think:1")!;
  assert.equal(thought.text.join(""), turn.run.thinking!.slice(0, -1) + "\ufffd");
  assert.deepEqual(thought.fields.native!.surrogates, [[turn.run.thinking!.length - 1, 0xd83d]]);
  assert.ok(rows.every(item => item.text.every(survivesUtf8)), "every chunk is well-formed UTF-16: the column holds it as it is");
  const reply = fixtureTurns.find(candidate => candidate.assistant !== undefined && /\ud83d$/u.test(candidate.assistant.text))!;
  assert.ok(convert(reply).items.find(item => item.itemId === "text:1")!.fields.native!.surrogates !== undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Random Runs
// ---------------------------------------------------------------------------------------------------------------------------------
/** mulberry32: a small seeded generator, so every case is reproducible from its seed. */
function source(seed: number) {
  let state = seed >>> 0;
  const next = (): number => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ (state >>> 15), 1 | state); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (below: number): number => Math.floor(next() * below), chance: (p: number): boolean => next() < p, pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]! };
}
type Source = ReturnType<typeof source>;
const WORDS = ["alpha", "bravo", "日本語", "😀", "e\u0301", "tab\there", "line\nbreak", "quote\"s", "back\\slash", "</script>", "__proto__", "constructor", "hasOwnProperty", "tool:weird#1", "#2", "ñandú", "\u200d", "\r\n", "\u2028", "x", "\u007f", "\ufffd"];
const NASTY = ["", " ", "\u0000", "a\u0000b", "\ud83d", "\ude00", "x\ud83d", "\ude00y", "\ud83d\ud83d", "\ude00\ud83d", "😀\ud83d", "é".repeat(5000)];
const STATUS_WORDS = ["pending", "in_progress", "completed", "failed", "declined", "cancelled", "interrupted", "error", "waiting", "mystery", "COMPLETED", "In Progress"];
const KINDS = ["execute", "read", "edit", "search", "fetch", "other", "mcp", "subagent", "delete", "move", "think"];
const NAMES = ["Bash", "Read", "Edit", "Grep", "WebFetch", "mcp__harnesshub__hub_turns", "TodoWrite", "todo_write", "update_plan", "Task", "codex-subagent", "shell", "harnesshub_hub_search"];
/** A text of a few words; `hostile` may also give the empty text, NUL and half of a pair. */
function words(s: Source, hostile: boolean): string {
  if (hostile && s.chance(0.25)) return s.pick(NASTY);
  const text = Array.from({ length: 1 + s.int(4) }, () => s.pick(WORDS)).join(" ");
  return text.trim() === "" ? "x" : text;
}
const hex = (s: Source): string => Array.from({ length: 64 }, () => "0123456789abcdef"[s.int(16)]).join("");
function reference(s: Source, tag: string, kind: ContentRef["kind"] = "file"): ContentRef {
  return { id: "content-" + tag, name: kind === "image" ? "pic.png" : "notes.txt", mediaType: kind === "image" ? "image/png" : "text/plain", kind, bytes: s.int(1000), sha256: hex(s) } as ContentRef;
}
/** The parts of a Run that are items, made at random on a Run of the fixtures (its selection, relay, timing and status stay: they are consistent with each other). */
function mutate(s: Source, template: Turn, hostile: boolean, size: number, tag: string): { readonly run: PublicRun; readonly user: PublicMessage; readonly assistant?: PublicMessage } {
  const count = (limit: number): number => hostile ? s.int(size + 1) : s.int(Math.min(limit, size) + 1);
  const base = template.run;
  const ids = hostile ? ["a", "b", "__proto__", "tool:x", "tool:x#2", "", "a#2", "c\ud83d", "\ude00d", "c\ufffd", "\ud83d", "\ude00", "c\ud83d#2"] : [];
  const id = (prefix: string, at: number): string => hostile && s.chance(0.3) ? s.pick(ids) : prefix + at + (s.chance(0.2) ? " " + words(s, false) : "");
  const unique = (list: { readonly id: string }[]): { readonly id: string }[] => hostile ? list : list.filter((item, at) => list.findIndex(other => other.id === item.id) === at);
  const tools = unique(Array.from({ length: count(128) }, (_, at) => {
    const tool: { id: string; title: string; status: string; kind?: string; name?: string; parentId?: string; exitCode?: number; detail?: ContentRef } = { id: id("t", at), title: words(s, hostile), status: s.chance(0.7) ? s.pick(STATUS_WORDS) : words(s, hostile) };
    if (s.chance(0.7)) tool.kind = s.chance(0.8) ? s.pick(KINDS) : words(s, hostile);
    if (s.chance(0.7)) tool.name = s.chance(0.8) ? s.pick(NAMES) : words(s, hostile);
    if (at > 0 && s.chance(0.2)) tool.parentId = hostile && s.chance(0.3) ? s.pick(ids) : "t" + s.int(at);
    if (s.chance(0.3)) tool.exitCode = s.pick([0, 1, 2, 127, -1, 255]);
    if (s.chance(0.5)) tool.detail = reference(s, tag + "-d" + at);
    return tool;
  })) as NonNullable<PublicRun["tools"]>[number][];
  const activities = unique(Array.from({ length: count(64) }, (_, at) => ({ id: id("a", at), kind: s.pick(["subagent", "task", "compaction", "retry", "review"] as const), title: words(s, hostile), status: s.pick(["running", "completed", "failed", "cancelled"] as const), ...(s.chance(0.6) ? { detail: words(s, hostile) } : {}) }))) as NonNullable<PublicRun["activities"]>[number][];
  const notices = Array.from({ length: count(32) }, () => ({ severity: s.pick(["info", "warning", "error"] as const), title: words(s, hostile), ...(s.chance(0.5) ? { detail: words(s, hostile) } : {}) }));
  const outputs: NonNullable<PublicRun["outputs"]> = Array.from({ length: count(32) }, (_, at) => s.chance(0.5)
    ? { kind: "content" as const, content: reference(s, tag + "-o" + at, s.pick(["image", "file", "audio"] as const)) }
    : { kind: "link" as const, uri: "https://example.com/" + at + (hostile && s.chance(0.2) ? "\n" : ""), name: words(s, hostile), ...(s.chance(0.5) ? { title: words(s, hostile) } : {}), ...(s.chance(0.5) ? { mediaType: "text/html" } : {}) });
  const attachments = Array.from({ length: s.chance(0.4) ? 1 + s.int(3) : 0 }, (_, at) => reference(s, tag + "-u" + at, s.chance(0.5) ? "image" : "file"));
  const usage = s.pick([undefined, {}, { turn: { input: 1, output: 2, cachedInput: 3, cacheWrite: 4, reasoning: 5, total: 6 } }, { context: { used: 10 } }, { context: { used: 10, size: 100 }, cost: { amount: 0.5, currency: "USD", scope: "turn" as const } }]);
  const withList = <K extends string, T>(name: K, list: readonly T[]) => list.length > 0 || s.chance(0.3) ? { [name]: list } : {};
  const plan = s.chance(0.5) ? { entries: Array.from({ length: count(64) }, () => ({ content: words(s, hostile), status: s.pick(["pending", "in_progress", "completed"] as const), ...(s.chance(0.5) ? { priority: s.pick(["high", "medium", "low"] as const) } : {}) })), ...(s.chance(0.5) ? { explanation: words(s, hostile) } : {}) } : undefined;
  const { thinking: _thinking, tools: _tools, plan: _plan, usage: _usage, notices: _notices, activities: _activities, outputs: _outputs, attachments: _attachments, ...kept } = base;
  const input = words(s, false).trim() === "" ? "go" : words(s, false) + (hostile && s.chance(0.2) ? " \ud83d" : "");
  const run: PublicRun = { ...kept, input, ...(s.chance(0.6) ? { thinking: s.chance(0.2) ? "" : words(s, hostile).repeat(s.chance(0.1) ? 1 + s.int(50) : 1) } : {}), ...withList("tools", tools), ...(plan === undefined ? {} : { plan }), ...(usage === undefined ? {} : { usage }),
    ...withList("notices", notices), ...withList("activities", activities), ...withList("outputs", outputs), ...(attachments.length ? { attachments } : {}) };
  const user: PublicMessage = { ...template.user, text: input };
  const assistant: PublicMessage | undefined = template.assistant === undefined ? undefined : { ...template.assistant, text: s.chance(0.1) ? "" : words(s, hostile) + (s.chance(0.1) ? "\n" + words(s, hostile) : "") };
  return { run, user, ...(assistant === undefined ? {} : { assistant }) };
}
const templates = fixtureTurns.filter(turn => turn.snapshot.schemaVersion === 13);

test("random Runs that the old validation accepts: the conversion is total, and the Run comes back from its rows — in memory and through SQLite", t => {
  let checked = 0, calls = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const s = source(seed), template = templates[s.int(templates.length)]!, made = mutate(s, template, false, 1 + s.int(20), "r" + seed);
    // The Run is legal if its whole conversation passes the validation the old store applied on every commit.
    const snapshot: SessionSnapshot = { ...template.snapshot, runs: template.snapshot.runs.map(run => run.id === made.run.id ? made.run : run), messages: template.snapshot.messages.map(message => message.id === made.user.id ? made.user : message.id === made.assistant?.id ? made.assistant : message) };
    assert.doesNotThrow(() => parseSession(snapshot), "seed " + seed + ": the generated Run is one the old validation accepts");
    const turn: Turn = { ...made, at: template.at, where: "seed " + seed, snapshot: template.snapshot }, converted = convert(turn);
    roundTrips(turn, "in memory", converted); roundTrips(turn, "SQLite", throughDatabase(converted));
    assert.ok(converted.items.every(item => item.text.every(survivesUtf8)));
    checked++; calls += made.run.tools?.length ?? 0;
  }
  t.diagnostic(`${checked} random legal Runs, ${calls} calls`);
});

test("random Runs that the old validation would refuse (NUL, half a pair, empty and repeated ids, long texts, hundreds of items): the conversion does not throw and loses nothing", t => {
  let checked = 0, calls = 0;
  for (let seed = 1001; seed <= 1400; seed++) {
    const s = source(seed), template = templates[s.int(templates.length)]!, made = mutate(s, template, true, 1 + s.int(60), "h" + seed);
    const turn: Turn = { ...made, at: template.at, where: "seed " + seed, snapshot: template.snapshot };
    let converted: ConvertedRun | undefined;
    assert.doesNotThrow(() => { converted = convert(turn); }, "seed " + seed);
    roundTrips(turn, "in memory", converted!); roundTrips(turn, "SQLite", throughDatabase(converted!));
    assert.equal(new Set(converted!.items.map(item => item.itemId)).size, converted!.items.length, "an item id is unique in its Run, whatever the Harness gave");
    assert.ok(converted!.items.every(item => item.text.every(survivesUtf8)), "seed " + seed + ": every chunk is storable as it is");
    checked++; calls += made.run.tools?.length ?? 0;
  }
  t.diagnostic(`${checked} random hostile Runs, ${calls} calls`);
});

test("the shapes at the edges: no calls at all, an empty thinking and an empty reply, calls with one id, a thousand calls and a million-character thinking", () => {
  const template = templates.find(turn => turn.run.status === "completed" && turn.assistant !== undefined)!;
  const { tools: _tools, notices: _notices, activities: _activities, outputs: _outputs, plan: _plan, thinking: _thinking, usage: _usage, attachments: _attachments, ...bare } = template.run;
  const make = (over: Partial<PublicRun>, reply = "r"): Turn => ({ ...template, run: { ...bare, ...over }, assistant: { ...template.assistant!, text: reply }, where: "edge" });
  const cases: Turn[] = [make({}), make({ thinking: "" }, ""), make({ tools: [] }), make({ notices: [], activities: [], outputs: [] }), make({ plan: { entries: [] } }),
    make({ tools: Array.from({ length: 3 }, () => ({ id: "same", title: "t", status: "completed" })) }), make({ tools: [{ id: "tool:same", title: "a", status: "x" }, { id: "same", title: "b", status: "y" }, { id: "same#2", title: "c", status: "z" }, { id: "same", title: "d", status: "w" }] }),
    make({ tools: Array.from({ length: 1500 }, (_, at) => ({ id: "t" + at, title: "call " + at, status: at % 2 ? "completed" : "failed", ...(at % 3 ? { parentId: "t" + (at - 1) } : {}) })) }),
    make({ thinking: "思".repeat(1_000_000) }, "é".repeat(400_000)), make({ activities: Array.from({ length: 200 }, (_, at) => ({ id: "a" + (at % 7), kind: "task" as const, title: "t" + at, status: "completed" as const })) })];
  for (const turn of cases) { const converted = convert(turn); roundTrips(turn, "in memory", converted); roundTrips(turn, "SQLite", throughDatabase(converted)); }
  const repeated = convert(cases[6]!).items.filter(item => item.itemId.startsWith("tool:"));
  assert.deepEqual(repeated.map(item => item.itemId), ["tool:tool:same", "tool:same", "tool:same#2", "tool:same#3"], "an id the Run already has takes the next free one: #2 was taken by a call that really was `same#2`");
  assert.deepEqual(repeated.map(item => item.fields.native!.id), [undefined, undefined, undefined, "same"], "the id the Harness gave is kept where the item's differs");
  assert.equal(convert(cases[0]!).items.length, 2, "a Run with no work is its user message and its reply");
});

test("the id of a call or an activity, and the id of the call a call happened inside, may hold half a surrogate pair: the item's id and parent are what a TEXT column holds of them, and the ids come back as the Harness gave them", () => {
  const template = templates.find(turn => turn.run.status === "completed" && turn.assistant !== undefined)!;
  const { tools: _tools, notices: _notices, activities: _activities, outputs: _outputs, plan: _plan, thinking: _thinking, usage: _usage, attachments: _attachments, ...bare } = template.run;
  const halves = ["x\ud83d", "\ude00y", "x\ud83dy", "\ud83d", "p\ud83d\ud83dq", "ok😀", "x\ufffd"];
  const turn: Turn = { ...template, where: "halves", run: { ...bare,
    tools: [...halves.map((id, at) => ({ id, title: "call " + at, status: "completed", ...(at > 0 ? { parentId: halves[at - 1]! } : {}) })), { id: "x\ud83d", title: "again", status: "completed", parentId: "x\ude00" }],
    activities: halves.map((id, at) => ({ id, kind: "task" as const, title: "activity " + at, status: "completed" as const })) } };
  const converted = convert(turn);
  for (const item of converted.items) {
    assert.ok(survivesUtf8(item.itemId), "the item id is storable as it is: " + JSON.stringify(item.itemId));
    if (item.parentId !== null) assert.ok(survivesUtf8(item.parentId), "so is its parent: " + JSON.stringify(item.parentId));
  }
  assert.equal(new Set(converted.items.map(item => item.itemId)).size, converted.items.length, "an item id is unique in its Run, though several given ids look alike once the halves are replaced");
  roundTrips(turn, "in memory", converted); roundTrips(turn, "JSON and UTF-8", viaJson(converted)); roundTrips(turn, "SQLite", throughDatabase(converted));
  const plain = convert({ ...turn, run: { ...bare, tools: [{ id: "plain", title: "t", status: "completed" }, { id: "child", title: "t", status: "completed", parentId: "plain" }] } });
  assert.deepEqual(plain.items.filter(item => item.itemId.startsWith("tool:")).map(item => item.fields.native), [{ title: "t", status: "completed" }, { title: "t", status: "completed" }], "an id a column holds as it is adds nothing to the item");
});

test("the storage conversion object is the pair the seam names", () => {
  assert.equal(storageConversion.toItems, toItems); assert.equal(storageConversion.fromItems, fromItems);
  const turn = fixtureTurns[0]!;
  assert.deepStrictEqual(storageConversion.fromItems(storageConversion.toItems(turn.run, { user: turn.user, ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }) }, turn.at)), asOld(turn));
});
