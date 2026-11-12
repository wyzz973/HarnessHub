import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseSession, terminal } from "../../src/contexts/session/domain/state.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { sessionId, type PublicRun, type SessionEvent, type SessionSnapshot } from "../../src/contracts/session.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { V12_FIXTURES, loadV12Fixture, writeV12Root } from "../fixtures/relay/v12/database.js";
import { GENERATIONS, loadGeneration, writeGenerationRoot } from "../fixtures/storage/generations/database.js";
import { V13_FIXTURES, loadV13Fixture, v13Path, writeV13Root, type V13Fixture, type V13FixtureName } from "../fixtures/storage/v13/database.js";

// The frozen Session v13 fixtures of the new storage (ADR-057 step 1, T1; tests/fixtures/storage/v13/README.md): each is opened by this build's
// SqliteSessionStore (which validates every Session and recovers what an owner left unfinished), and together they are checked against the list of
// shapes the storage conversion and the migration must carry. THIS FILE IS THE v13 STORE'S: at the cut the store converts to v14 and the assertions
// that read snapshots through `store.get` move to the conversion; the coverage test reads the fixtures as plain data and stays.

/** A temporary directory removed after the test, once what was opened in it is closed (last opened, first closed). */
const closers = new WeakMap<TestContext, (() => unknown)[]>();
function temporary(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "storage-v13-fixtures-")), owned: (() => unknown)[] = [];
  closers.set(t, owned);
  t.after(() => { for (const close of owned.reverse()) { try { close(); } catch { /* already closed */ } } rmSync(root, { recursive: true, force: true }); });
  return root;
}
function later(t: TestContext, close: () => unknown): void { closers.get(t)!.push(close); }
function open(t: TestContext, data: string): SqliteSessionStore {
  const store = new SqliteSessionStore(data, { recoverRelay, now: () => new Date("2026-11-13T00:00:00.000Z") });
  later(t, () => store.close());
  return store;
}
function opened(t: TestContext, fixtures: readonly V13Fixture[]): SqliteSessionStore {
  const data = join(temporary(t), "data");
  writeV13Root(data, fixtures);
  return open(t, data);
}
function allEvents(store: SqliteSessionStore, id: string): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(sessionId(id), after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
const snapshotOf = (row: { readonly snapshot: unknown }): SessionSnapshot => row.snapshot as SessionSnapshot;
/** The pairs of a crash fixture and what the next owner made of it. */
const RECOVERED: Partial<Record<V13FixtureName, V13FixtureName>> = { "running-crash": "recovered-after-crash", "waiting-crash": "recovered-after-waiting-crash" };
const NAMES: readonly V13FixtureName[] = V13_FIXTURES;

for (const name of NAMES) {
  test(`${name}: this build opens it, every Session passes its validation, and the store reads back what the fixture holds`, t => {
    const fixture = loadV13Fixture(name);
    assert.equal(fixture.fixture, name);
    const unfinished = fixture.unfinished;
    for (const row of fixture.sessions) {
      // The fixture itself: a Session the validator accepts, whose event log is whole.
      assert.doesNotThrow(() => parseSession(row.snapshot), row.id);
      assert.equal(row.events.length, row.lastSeq, row.id + ": one event per seq");
      assert.deepEqual(row.events.map(event => event.seq), row.events.map((_, at) => at + 1));
    }
    const store = opened(t, [fixture]);
    if (!unfinished) {
      for (const row of fixture.sessions) {
        assert.deepEqual(store.get(sessionId(row.id)), row.snapshot, row.id + ": the snapshot as stored");
        assert.deepEqual(allEvents(store, row.id), row.events, row.id + ": the event log as stored");
        assert.equal(store.relayPackets(sessionId(row.id)).length, fixture.relay.packets.filter(packet => packet.session_id === row.id).length, row.id + ": its relay packets");
        assert.equal(store.relayDeliveries(sessionId(row.id)).length, fixture.relay.deliveries.filter(delivery => delivery.session_id === row.id).length, row.id + ": its deliveries");
      }
    } else {
      // An owner that died left Runs unfinished: this build's start ends them (unknown, or cancelled when queued) and blocks what cannot be sure.
      const after = loadV13Fixture(RECOVERED[name]!);
      for (const row of fixture.sessions) {
        const now = store.get(sessionId(row.id));
        assert.ok(now.runs.every(run => terminal(run.status)), row.id + ": nothing is left unfinished");
        assert.equal(now.pendingSwitchId, null);
        assert.deepEqual(now, after.sessions.find(other => other.id === row.id)!.snapshot, row.id + ": what recovery made of it is the paired fixture");
      }
    }
    assert.deepEqual([...store.contentReferences()].sort(), fixture.contentReferences, "the content the conversations still refer to");
  });
}

test("the Sessions of different fixtures can share one database, and a copy of a fixture under other identities is another set of conversations", t => {
  const names: readonly V13FixtureName[] = ["switches", "commands", "tools", "trial-2026-11-11"];
  const store = opened(t, names.map(loadV13Fixture));
  const total = names.reduce((count, name) => count + loadV13Fixture(name).sessions.length, 0);
  assert.equal(store.list(100).length, total);
});

for (const name of V12_FIXTURES) {
  test(`from-v12-${name}: the fixture is what this build makes of the frozen v12 database ${name}`, t => {
    const data = join(temporary(t), "data");
    writeV12Root(data, [loadV12Fixture(name)]);
    const store = open(t, data);
    const fixture = loadV13Fixture(`from-v12-${name}` as V13FixtureName);
    for (const row of fixture.sessions) assert.deepEqual(store.get(sessionId(row.id)), row.snapshot, row.id);
    // The Runs of a v12 database carry no relay facts of their own: the migration keeps where each ran in the index rows.
    const index = fixture.relay.index.length;
    assert.ok(fixture.sessions.every(row => snapshotOf(row).schemaVersion === 13));
    assert.equal(fixture.sessions.reduce((count, row) => count + store.relayIndex(sessionId(row.id)).length, 0), index);
  });
}

for (const version of GENERATIONS) {
  test(`v${version}: a database of that generation climbs the migration ladder to v13 with its conversations as they were`, t => {
    const sample = loadGeneration(version);
    assert.equal(sample.userVersion, version);
    for (const row of sample.sessions) assert.doesNotThrow(() => parseSession(row.snapshot), row.id);
    const data = join(temporary(t), "data");
    writeGenerationRoot(data, sample);
    const store = open(t, data);
    for (const row of sample.sessions) {
      const before = row.snapshot as unknown as SessionSnapshot, after = store.get(sessionId(row.id));
      assert.equal(after.schemaVersion, 13);
      // Version 13 gives every native binding its relay state (worked out from the events); nothing else is added or changed.
      const { nativeBindings: migrated, schemaVersion: _after, ...kept } = after, { nativeBindings: sampled, schemaVersion: _before, ...asSampled } = before;
      assert.deepEqual(kept, asSampled, row.id);
      assert.deepEqual(migrated?.map(({ relay: _relay, ...binding }) => binding), sampled, row.id + ": the bindings but for their relay state");
      assert.ok((after.nativeBindings ?? []).every(binding => binding.relay !== undefined), row.id + ": every binding has its relay state");
      assert.deepEqual(allEvents(store, row.id), row.events, row.id + ": the events stay");
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What the fixtures hold: the list of shapes the storage conversion and the migration must carry, checked against the data
// ---------------------------------------------------------------------------------------------------------------------------------
interface Seen { readonly fixture: string; readonly snapshot: SessionSnapshot; readonly events: readonly SessionEvent[]; readonly run?: PublicRun }
const everySession: Seen[] = [], everyRun: Seen[] = [];
for (const name of NAMES) {
  for (const row of loadV13Fixture(name).sessions) {
    everySession.push({ fixture: name, snapshot: snapshotOf(row), events: row.events as unknown as SessionEvent[] });
    for (const run of snapshotOf(row).runs) everyRun.push({ fixture: name, snapshot: snapshotOf(row), events: row.events as unknown as SessionEvent[], run });
  }
}
const runs = (where: (run: PublicRun, seen: Seen) => boolean): readonly Seen[] => everyRun.filter(seen => where(seen.run!, seen));
const sessions = (where: (snapshot: SessionSnapshot, seen: Seen) => boolean): readonly Seen[] => everySession.filter(seen => where(seen.snapshot, seen));
const tools = (where: (tool: NonNullable<PublicRun["tools"]>[number], run: PublicRun) => boolean): readonly Seen[] => runs((run, _seen) => (run.tools ?? []).some(tool => where(tool, run)));
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const messageOf = (seen: Seen, id: string): string | undefined => seen.snapshot.messages.find(message => message.id === id)?.text;
const eventsOf = (seen: Seen, type: string, where: (data: Readonly<Record<string, unknown>>) => boolean = () => true): boolean => seen.events.some(event => event.type === type && where(event.data));
const CHECKS: readonly (readonly [string, () => readonly Seen[]])[] = [
  // Harnesses, switches and the relay
  ["Turns of several Harnesses in one conversation", () => sessions(snapshot => new Set(snapshot.runs.map(run => run.selection.harnessId)).size >= 3)],
  ["the same Harness on another model only (two Turns in a row, one Harness, two models)", () => sessions(snapshot => snapshot.runs.some((run, at) => at > 0 && snapshot.runs[at - 1]!.selection.harnessId === run.selection.harnessId && snapshot.runs[at - 1]!.selection.nativeModel !== run.selection.nativeModel))],
  ["a managed Provider's Turn", () => runs(run => run.selection.provider !== undefined)],
  ["native options in a selection", () => runs(run => run.selection.nativeOptions !== undefined)],
  ["a Turn that carried a packet, its delivery confirmed", () => runs((run, seen) => run.relay?.packetId != null && eventsOf(seen, "relay.input_recorded", data => data.runId === run.id) || run.relay?.packetId != null && eventsOf(seen, "run.ended", data => data.runId === run.id && (data.delivery as { readonly outcome?: string } | undefined)?.outcome === "recorded"))],
  ["a Turn that carried a packet nobody confirmed (a delivery left unknown)", () => runs((run, seen) => run.relay?.packetId != null && eventsOf(seen, "run.ended", data => data.runId === run.id && JSON.stringify(data.delivery ?? null).includes("unknown")))],
  ["a Turn sent with only the user's words (attach none)", () => runs(run => run.relayRequest?.attach === "none")],
  ["a Turn sent with the whole history again (attach full)", () => runs(run => run.relayRequest?.attach === "full")],
  ["a Turn the native side refused (input not recorded)", () => runs((run, seen) => eventsOf(seen, "run.ended", data => data.runId === run.id && data.input === "not_recorded" && run.status === "failed"))],
  // Commands and the clear
  ...(["compact", "clear", "none", "unknown", "keep", "rewind"] as const).map(effect => [`a native command Turn of effect ${effect}`, () => runs((run, seen) => eventsOf(seen, "run.native_command", data => data.runId === run.id && (data.contextEffect === effect)))] as const),
  ["the Hub's clear (the Driver gave the native session up)", () => runs((run, seen) => eventsOf(seen, "run.ended", data => data.runId === run.id && JSON.stringify(data.native ?? null) === '{"cleared":true}'))],
  ["a native command as the first input back on a Harness (D1)", () => runs((run, seen) => run.input === "/compact" && seen.snapshot.runs.some(other => other.selection.harnessId !== run.selection.harnessId && seen.snapshot.runs.indexOf(other) < seen.snapshot.runs.indexOf(run)))],
  // Branches, imports, attachments
  ["a branch whose quoted history carries attachments", () => sessions(snapshot => snapshot.origin?.kind === "fork" && snapshot.origin.history.some(message => message.attachments !== undefined))],
  ["a branch of a branch (quoted history accumulates)", () => sessions(snapshot => snapshot.origin?.kind === "fork" && snapshot.origin.history.length > 4)],
  ["a branch with a native fork not yet made", () => sessions(snapshot => snapshot.nativeBindings?.some(binding => binding.status === "fork-pending") === true)],
  ["an import whose history was read (older messages left out)", () => sessions(snapshot => snapshot.origin?.kind === "import" && snapshot.origin.historyRead && snapshot.origin.omitted > 0)],
  ["an import whose history was not read", () => sessions(snapshot => snapshot.origin?.kind === "import" && !snapshot.origin.historyRead)],
  ["a Turn with attachments", () => runs(run => (run.attachments?.length ?? 0) > 0)],
  ["a Turn with eight attachments", () => runs(run => run.attachments?.length === 8)],
  // Unknown, recovery, kept processes, queue
  ["a Turn that ended unknown (its connection was lost)", () => runs(run => run.status === "unknown")],
  ["an unknown Turn acknowledged by an effective recovery switch", () => sessions(snapshot => snapshot.status === "open" && snapshot.runs.some(run => run.status === "unknown" && snapshot.switches.some(sw => sw.status === "effective" && sw.sourceRunIds.includes(run.id))))],
  ["an unknown Turn acknowledged by the switch's own list (acknowledgedUnknown, with the switch's mode and timing)", () => sessions(snapshot => snapshot.switches.some(sw => sw.status === "effective" && sw.mode === "wait_current" && sw.timing !== undefined && (sw.acknowledgedUnknown?.length ?? 0) > 0 && !sw.sourceRunIds.includes(sw.acknowledgedUnknown![0]!)))],
  ["a switch that failed with the Turn it waited for, whose sources skip an input that was queued when it was asked for", () => sessions(snapshot => snapshot.switches.some(sw => sw.status === "failed" && sw.error?.code === "SWITCH_SOURCE_UNKNOWN" && snapshot.runs.some((run, at) => !sw.sourceRunIds.includes(run.id) && snapshot.runs.slice(at + 1).some(later => sw.sourceRunIds.includes(later.id)) && run.status === "unknown")))],
  ["a conversation left blocked", () => sessions(snapshot => snapshot.status === "blocked")],
  ["a closed conversation", () => sessions(snapshot => snapshot.status === "closed")],
  ["a Turn running when its owner died (a running Run in the database)", () => runs(run => run.status === "running")],
  ["an input queued when its owner died", () => runs(run => run.status === "queued")],
  ["a switch pending when its owner died, whose sources skip a queued Turn (not a prefix of the Runs)", () => sessions(snapshot => snapshot.switches.some(sw => sw.status === "requested" && sw.sourceRunIds.some(source => snapshot.runs.findIndex(run => run.id === source) > snapshot.runs.findIndex(run => run.status === "queued")) && snapshot.runs.some(run => run.status === "queued")))],
  ["a queued input cancelled on its own", () => runs((run, seen) => run.status === "cancelled" && run.cancelRequested && eventsOf(seen, "run.cancel_requested", data => data.runId === run.id && data.beforeStart === true))],
  ["an input queued before a switch that ran before the switch took effect", () => sessions(snapshot => snapshot.switches.some(sw => sw.status === "effective" && snapshot.runs.some(run => snapshot.messages.some(message => message.id === run.userMessageId && message.seq < sw.requestedSeq) && snapshot.runs.indexOf(run) > 0 && run.awaitingSwitchId === null && run.cancelRequested === false && run.status === "completed" && snapshot.messages.some(message => message.runId !== run.id && message.seq > (snapshot.messages.find(own => own.id === run.userMessageId)?.seq ?? 0) && message.seq < sw.requestedSeq))))],
  ["a Turn cancelled by the user while it ran", () => runs(run => run.status === "cancelled" && run.cancelRequested && run.stopRequested)],
  ["a failed Turn with the backend's error", () => runs(run => run.status === "failed" && run.error !== null && run.backend?.error !== undefined)],
  ["a Turn that failed at a limit (max tokens)", () => runs(run => run.status === "failed" && run.backend?.reason === "max_tokens")],
  ["a conversation that keeps its native process, with the identity of its process group", () => sessions(snapshot => snapshot.retained?.process !== undefined)],
  ["a Turn that handed its process over, and a Turn that reused it", () => runs(run => run.retained === true && run.status === "completed")],
  ["a Turn that reused a kept process", () => runs(run => run.reused === true)],
  ["a retention switched off again", () => sessions(snapshot => snapshot.retainNative === undefined && snapshot.runs.some(run => run.retained === true))],
  ["permission commands (an approval and a question decided)", () => sessions(snapshot => snapshot.commands.filter(command => command.kind === "permission").length >= 3)],
  ["a native reset or a retention command", () => sessions(snapshot => snapshot.commands.some(command => command.kind === "retention" || command.kind === "native-reset"))],
  // Tools
  ["a call with a stored detail", () => tools(tool => tool.detail !== undefined)],
  ["a call without a stored detail", () => tools(tool => tool.detail === undefined)],
  ["a call that changed files (a diff)", () => tools(tool => tool.kind === "edit")],
  ["a command with an exit code of 0 and one with a non-zero code", () => tools(tool => tool.exitCode === 0).filter(seen => tools(tool => (tool.exitCode ?? 0) > 0).length > 0)],
  ["a call that is no command and still has an exit code", () => tools(tool => tool.exitCode !== undefined && tool.kind !== "execute")],
  ["a call inside a sub-agent (parentId)", () => tools(tool => tool.parentId !== undefined)],
  ["a task-list call with a stored detail (todo_write)", () => tools(tool => /todo_?write|update_plan|update_todos|todo/iu.test(tool.name ?? tool.title) && tool.detail !== undefined)],
  ["a task-list call without a stored detail", () => tools(tool => /todo_?write|update_plan|update_todos|todo/iu.test(tool.name ?? tool.title) && tool.detail === undefined)],
  ["a Codex sub-agent told both as a call and as an activity", () => runs(run => (run.activities ?? []).some(activity => activity.kind === "subagent" && (run.tools ?? []).some(tool => tool.id === "agent:" + activity.id)))],
  ["a Hub tool (MCP) call", () => tools(tool => /harnesshub/iu.test(tool.name ?? tool.title))],
  ["a call whose status is a word the protocol does not know", () => tools(tool => tool.status === "mystery-state")],
  ["a call still open in a finished Turn", () => runs(run => terminal(run.status) && (run.tools ?? []).some(tool => ["pending", "in_progress", "running"].includes(tool.status)))],
  ["a Turn with the most calls the old runtime allowed (128)", () => runs(run => run.tools?.length === 128)],
  // Notices, activities, outputs, plan, usage
  ...(["info", "warning", "error"] as const).map(severity => [`a notice of severity ${severity}`, () => runs(run => run.notices?.some(notice => notice.severity === severity) === true)] as const),
  ["an error notice beside the Turn's own error", () => runs(run => run.error !== null && run.notices?.some(notice => notice.severity === "error") === true)],
  ["an error notice and no error of the Turn's own", () => runs(run => run.error === null && run.notices?.some(notice => notice.severity === "error") === true)],
  ["a notice with a detail", () => runs(run => run.notices?.some(notice => notice.detail !== undefined) === true)],
  ...(["subagent", "task", "compaction", "retry", "review"] as const).map(kind => [`an activity of kind ${kind} with a detail`, () => runs(run => run.activities?.some(activity => activity.kind === kind && activity.detail !== undefined) === true)] as const),
  ["activities of every status", () => runs(run => ["running", "completed", "failed", "cancelled"].every(status => run.activities?.some(activity => activity.status === status)))],
  ["an output that is a stored content (an image)", () => runs(run => run.outputs?.some(output => output.kind === "content" && output.content.kind === "image") === true)],
  ["an output that is a stored file", () => runs(run => run.outputs?.some(output => output.kind === "content" && output.content.kind === "file") === true)],
  ["a link output with a title and a media type", () => runs(run => run.outputs?.some(output => output.kind === "link" && output.title !== undefined && output.mediaType !== undefined) === true)],
  ["a link output with neither", () => runs(run => run.outputs?.some(output => output.kind === "link" && output.title === undefined && output.mediaType === undefined) === true)],
  ["a plan with priorities and one step without", () => runs(run => run.plan !== undefined && run.plan.entries.some(entry => entry.priority !== undefined) && run.plan.entries.some(entry => entry.priority === undefined))],
  ["a plan with an explanation", () => runs(run => run.plan?.explanation !== undefined)],
  ["a plan without steps", () => runs(run => run.plan !== undefined && run.plan.entries.length === 0)],
  ["a plan of 64 steps", () => runs(run => run.plan?.entries.length === 64)],
  ["usage with cache writes, reasoning and a total", () => runs(run => run.usage?.turn?.cacheWrite !== undefined && run.usage.turn.reasoning !== undefined && run.usage.turn.total !== undefined)],
  ["usage with a cost of each scope", () => runs(run => run.usage?.cost?.scope === "turn").length ? runs(run => run.usage?.cost?.scope === "session") : []],
  ["usage with a context size and one without", () => runs(run => run.usage?.context !== undefined && run.usage.context.size === undefined)],
  // Strings
  ["a thinking longer than 64 KiB (UTF-16 units) with a surrogate pair across the 65,536th unit", () => runs(run => run.thinking !== undefined && run.thinking.length > 65536 && run.thinking.charCodeAt(65535) >= 0xd800 && run.thinking.charCodeAt(65535) <= 0xdbff)],
  ["an empty thinking", () => runs(run => run.thinking === "")],
  ["an empty reply", () => runs((run, seen) => messageOf(seen, run.assistantMessageId) === "")],
  ["a Turn with no calls, no thinking and no reply at all", () => runs((run, seen) => run.status === "completed" && run.tools === undefined && run.thinking === undefined && messageOf(seen, run.assistantMessageId) === undefined && run.notices === undefined)],
  ["a call titled with more than 1,000 characters", () => tools(tool => tool.title.length > 1000)],
  ["a call titled with exactly 4,096 bytes of multi-byte text that includes a surrogate pair", () => tools(tool => bytes(tool.title) === 4096 && /[\u{10000}-\u{10ffff}]/u.test(tool.title))],
  ["a reply ending in half a surrogate pair", () => runs((run, seen) => /[\ud800-\udbff]$/u.test(messageOf(seen, run.assistantMessageId) ?? ""))],
  ["a thinking ending in half a surrogate pair", () => runs(run => /[\ud800-\udbff]$/u.test(run.thinking ?? ""))],
  ["a call whose id looks like another's disambiguation, __proto__ or constructor", () => tools(tool => ["tool:weird#1", "tool:weird#1#2", "__proto__", "constructor"].includes(tool.id))],
  ["two call ids that differ only in case", () => tools(tool => tool.id === "Id").filter(seen => tools(tool => tool.id === "id").length > 0)],
  ["control characters, a right-to-left override and a combining mark in a title", () => tools(tool => /\u001b\[31m/u.test(tool.title) && /\u202e/u.test(tool.title) && /e\u0301/u.test(tool.title))],
  ["a notice, an activity and a plan step at the byte limits the runtime enforced itself", () => runs(run => run.notices?.some(notice => bytes(notice.title) === 1024 && bytes(notice.detail ?? "") === 4096) === true && run.activities?.some(activity => bytes(activity.title) === 1024) === true)],
  ["an input with spaces around it, an emoji and CRLF", () => runs(run => run.input.startsWith("  ") && run.input.includes("\r\n") && run.input.includes("😀"))],
  ["a Turn with 32 notices, 64 activities and 32 outputs", () => runs(run => run.notices?.length === 32 && run.activities?.length === 64 && run.outputs?.length === 32)],
  ["the content the Turns refer to through tool details, outputs and attachments", () => everyRun.filter(seen => (seen.run!.tools ?? []).some(tool => tool.detail !== undefined) && (seen.run!.outputs ?? []).length > 0)],
];
for (const [feature, found] of CHECKS) {
  test(`the fixtures hold: ${feature}`, () => { assert.ok(found().length > 0, "no fixture holds " + feature); });
}

test("foreign-events: the ControlEvents the old build refused are kept for the new placement, each with what this build did with them", () => {
  const file = JSON.parse(readFileSync(v13Path("foreign-events.json"), "utf8")) as { readonly cases: readonly { readonly name: string; readonly v13: string; readonly events: readonly { readonly type: string }[] }[] };
  assert.ok(file.cases.length >= 20);
  assert.ok(file.cases.filter(item => item.v13.startsWith("refused: INVALID_DATA")).length >= 15, "most of them are what stopped the Runtime of this build (limits audit D21)");
  assert.ok(file.cases.every(item => item.events.length > 0 && item.events.every(event => typeof event.type === "string")));
});

test("the v13 database a fixture writes has the shape a v13 build made: its tables, and user_version 13", t => {
  const data = join(temporary(t), "data");
  writeV13Root(data, [loadV13Fixture("tools")]);
  const database = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 13);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
    assert.deepEqual(tables, ["create_keys", "events", "owner_metadata", "relay_bodies", "relay_deliveries", "relay_index", "relay_log", "relay_packets", "relay_prefs", "sessions", "sqlite_sequence"]);
  } finally { database.close(); }
});
