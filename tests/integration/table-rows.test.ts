import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { callTool } from "../../src/cli/hub-tools.js";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl } from "../../src/contracts/control.js";
import { SessionError, sessionId, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId } from "../../src/contracts/session.js";
import { TABLE_ENV, TABLE_PARTS, type TableSearchView } from "../../src/contracts/table.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { readDetail } from "../../src/contexts/session/domain/detail-read.js";
import {
  LEGACY_ORDER_NOTE, detailKey, readTurn, rowsTable, searchPage, searchTurns, searchWordsPage, snapshotTable, tableDetailOf, tableDetailPolicy, tableRedaction, turnsView, type SearchLoad, type TableConversation, type TableDetails,
} from "../../src/contexts/session/domain/table.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import type { SqliteConversationStore } from "../../src/infrastructure/session/conversation-store.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { appStore } from "../fixtures/runtime-store.js";
import { mountTable } from "../fixtures/table-http.js";
import { temporary } from "../fixtures/store-helpers.js";
import { V13_FIXTURES, loadV13Fixture, writeV13Root } from "../fixtures/storage/v13/database.js";
import { conversation, tool } from "../fixtures/relay-scenarios.js";
import { scriptedWorld } from "../fixtures/scripted-world.js";

// The context table over rows: the directory, a Turn, a search read one Turn at a time from the tables of a real store (rows, not the conversation's old whole shape), held to what
// the old shape gives for every migrated fixture (apart from the one thing a Turn from before the order was kept is now told with); a stored detail of any size read for what it can
// give; and a search that goes on from where the page before it stopped. The Harness is the only thing made up.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const stamp = new Date("2026-11-13T00:00:00.000Z");
const none: TableDetails = new Map(), plain = tableRedaction([]);

/** Without the note a migrated Turn is told with, and without `notes` when nothing else was in it. */
function withoutLegacyNote<T extends { readonly notes?: readonly string[] }>(view: T): T {
  if (view.notes === undefined) return view;
  const notes = view.notes.filter(note => note !== LEGACY_ORDER_NOTE), { notes: _all, ...rest } = view;
  return (notes.length ? { ...rest, notes } : rest) as T;
}

for (const name of V13_FIXTURES) {
  test(`${name}: the table reads the same of every conversation from rows as from the old whole shape, and tells a migrated Turn that its order is a fixed arrangement`, { timeout: 60_000 }, t => {
    const fixture = loadV13Fixture(name), data = join(temporary(t), "data");
    writeV13Root(data, [fixture]);
    const store = appStore(data, { now: () => stamp });
    try {
      for (const row of fixture.sessions) {
        const id = sessionId(row.id), rows = rowsTable(store, id), old = snapshotTable(store.snapshot(id)), where = name + " " + row.id;
        assert.equal(rows.turns.count, old.turns.count, where + ": the Turns");
        assert.deepEqual(turnsView(rows, undefined, 100, none, plain), turnsView(old, undefined, 100, none, plain), where + ": the directory");
        for (let n = 1; n <= rows.turns.count; n++) {
          const legacy = rows.turns.turn(n - 1)!.legacyOrder;
          assert.equal(legacy, true, where + ": a Turn converted from v13 is of the fixed arrangement");
          for (const part of TABLE_PARTS.filter(part => !["input", "output", "diff"].includes(part))) {
            const fromRows = readTurn(rows, n, { part }, none, plain), fromOld = readTurn(old, n, { part }, none, plain);
            assert.deepEqual(withoutLegacyNote(fromRows), fromOld, where + " turn " + n + " " + part);
            assert.equal(fromRows.notes?.includes(LEGACY_ORDER_NOTE) ?? false, part === "overview" || part === "tools" || part === "files", where + " turn " + n + " " + part + ": where the arrangement is told");
            assert.equal(fromOld.notes?.includes(LEGACY_ORDER_NOTE) ?? false, false, "the old shape does not say");
          }
        }
        for (const words of ["run", "的", "a"]) assert.deepEqual(searchTurns(rows, words, 50, none, plain, 0), searchTurns(old, words, 50, none, plain, 0), where + ": search " + words);
      }
    } finally { store.close(); }
  });
}

test("a Turn of the order things happened in is not told it is a fixed arrangement, and one that is, is, in the overview, the tool calls and the files only", () => {
  const { state } = conversation([{ input: "first", harnessId: "claude", reply: "r1", tools: [tool("t1", "ran t1", "execute")] }, { input: "second", harnessId: "claude", reply: "r2", tools: [tool("t2", "ran t2", "execute")] }, { input: "third", harnessId: "claude" }]);
  const base = snapshotTable(state);
  const mixed: TableConversation = { ...base, turns: { ...base.turns, turn: ordinal => { const found = base.turns.turn(ordinal); return found === null ? null : { ...found, legacyOrder: ordinal === 0 }; } } };
  for (const part of ["overview", "tools", "files"] as const) {
    assert.deepEqual(readTurn(mixed, 1, { part }, none, plain).notes, [LEGACY_ORDER_NOTE], "turn 1 (fixed) " + part);
    assert.equal(readTurn(mixed, 2, { part }, none, plain).notes, undefined, "turn 2 (in order) " + part);
  }
  for (const part of ["user", "reply", "plan"] as const) assert.equal(readTurn(mixed, 1, { part }, none, plain).notes, undefined, "turn 1 " + part + ": the order is no part of it");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Native Turns through the Runtime: a detail of any size, and a search a page at a time
// ---------------------------------------------------------------------------------------------------------------------------------

/** A Harness that answers every input with the tools its test gives and a reply that quotes the input. */
class Harness implements SessionBindingFactory {
  constructor(private readonly tools: (turn: number, text: string) => readonly ControlEvent[]) {}
  private turns = 0;
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: "alpha", controlId: "alpha-acp" };
  }
  async prepare(_selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-alpha"); },
      checkpoint: async () => opened ? "private-native-alpha" : null,
      startText: async (_id, turn, output) => {
        const text = singleText(turn);
        for (const event of this.tools(++this.turns, text)) output(event);
        output({ type: "text", text: "reply to: " + text });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
interface World { readonly store: SqliteConversationStore; readonly content: LocalContentStore; readonly app: SessionRuntime; readonly id: SessionId; send(text: string): Promise<void> }
async function world(t: test.TestContext, tools: (turn: number, text: string) => readonly ControlEvent[]): Promise<World> {
  // The Runtime and the store are closed before the directory they stand in is removed (the hooks run in the order they were registered).
  const open: { app?: SessionRuntime; store?: SqliteConversationStore } = {};
  t.after(async () => { await open.app?.close(); open.store?.close(); });
  const root = temporary(t), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  const store = appStore(data, { now: () => stamp }), content = new LocalContentStore(data, () => store.assertOwner());
  open.store = store;
  let next = 0;
  const app = new SessionRuntime(store, new Harness(tools), { id: () => String(++next), now: () => stamp, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content });
  open.app = app;
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const session = await app.create(configuration, { harnessId: "alpha" }, "create");
  return { store, content, app, id: session.id, async send(text) { app.send(session.id, text, "send-" + ++next); await app.wait(session.id); } };
}
/** The table's HTTP API mounted on a loopback port, and the environment a Harness's tool process of this conversation would have. */
async function mounted(t: test.TestContext, w: World): Promise<Readonly<Record<string, string>>> {
  const grants = new MemoryTableGrants(), table = await mountTable({ grants, reader: w.store, content: w.content });
  t.after(() => table.close());
  return { [TABLE_ENV.url]: table.origin, [TABLE_ENV.session]: grants.mint({ sessionId: w.id, harnessId: "alpha", controlId: "alpha-acp" }) };
}

test("the same command with 300 KiB and with 2 MiB of output is read through the table: the directory, the tool calls, the command, and the output a page at a time", { timeout: 120_000 }, async t => {
  const failure = " FAIL  tests/export.test.ts > rounds JPY totals\nAssertionError: expected '1234' to be '1235'\n Tests  1 failed | 17 passed (18)\n";
  const sizes = [300 * 1024, 2 * 1024 * 1024];
  const outputs = sizes.map(size => "noise line of the build\n".repeat(Math.ceil(size / 24) - 4) + failure);
  const w = await world(t, turn => [{ type: "tool", id: "build", title: "Terminal", status: "failed", detail: { kind: "execute", name: "Bash", input: "make build-all --verbose", output: outputs[turn - 1]!, exitCode: 1 } }]);
  for (const index of sizes.keys()) await w.send("run the build " + index);
  const env = await mounted(t, w), get = async (path: string) => { const reply = await fetch(env[TABLE_ENV.url]! + path, { headers: { Authorization: "Bearer " + env[TABLE_ENV.session]! } }); return { status: reply.status, body: await reply.json() as Record<string, unknown> }; };
  const directory = await callTool("hub_turns", {}, "mcp", env);
  assert.equal(directory.isError, false); assert.match(directory.text, /#1 · alpha · completed · 1 tool call/u); assert.match(directory.text, /#2 · alpha · completed · 1 tool call/u);
  for (const [index, output] of outputs.entries()) {
    const n = index + 1, where = "turn " + n + " (" + sizes[index]! / 1024 + " KiB)";
    const tools = await callTool("hub_read_turn", { n, part: "tools" }, "mcp", env);
    assert.match(tools.text, /#1 · execute · Bash · Terminal · failed, exit 1 · detail \d/u, where + ": the call is listed with its stored detail");
    assert.doesNotMatch(tools.text, /no stored detail/u, where);
    const command = await callTool("hub_read_turn", { n, part: "input", tool: 1 }, "mcp", env);
    assert.equal(command.isError, false, where + ": " + command.text);
    assert.match(command.text, /make build-all --verbose/u, where + ": the command is read");
    // The output, a page at a time to its end: all of it, whatever its size.
    let offset = 0, last = "", size = 0;
    for (let page = 0; page < 400; page++) {
      const read = await get("/api/table/turns/" + n + "?part=output&tool=1&limit=40000&offset=" + offset);
      assert.equal(read.status, 200, where + ": " + JSON.stringify(read.body).slice(0, 200));
      const { text, end, size: total, notes } = read.body as { text: string; end: number; size: number; notes?: string[] };
      assert.equal(notes, undefined, where + ": nothing of the output was left unread");
      size = total; last = text; offset = end;
      if (end >= total) break;
    }
    assert.ok(size >= output.length - 2 && size <= output.length, where + ": the whole output is paged through: " + size + " of " + output.length);
    assert.ok(last.includes("AssertionError: expected '1234' to be '1235'"), where + ": its last page holds the failure");
    const found = await callTool("hub_search", { query: "AssertionError" }, "mcp", env);
    assert.match(found.text, new RegExp("#" + n + " · the output of tool call #1"), where + ": a search finds the failure in the output");
  }
});

test("a search goes on from where the page before it stopped: pages of any size reach the same places, in the same order, as one search through everything", { timeout: 60_000 }, async t => {
  const w = await world(t, turn => [{ type: "tool", id: "t" + turn, title: "needle tool " + turn, status: "completed", detail: { kind: "execute", input: "echo needle " + turn, output: "needle output " + turn, exitCode: 0 } }]);
  for (let turn = 1; turn <= 9; turn++) await w.send(turn % 3 === 0 ? "plain words " + turn : "a needle in turn " + turn);
  const table = rowsTable(w.store, w.id), load: SearchLoad = async refs => {
    const details = new Map<string, ReturnType<typeof tableDetailOf>>();
    for (const item of refs) { const read = await readDetail(w.content, item.ref, tableDetailPolicy("search")); if (read !== null) details.set(detailKey(item.runId, item.toolId), tableDetailOf(read)); }
    return { details, unread: refs.length - details.size };
  };
  const everything = await searchPage(table, "needle", { limit: 50 }, load, plain);
  assert.equal(everything.next, undefined, "one page reached the first Turn");
  assert.ok(everything.hits.length > 20, "the conversation has many places: " + everything.hits.length);
  for (const limit of [1, 2, 3, 7]) {
    const places: TableSearchView["hits"][number][] = [];
    let after: string | undefined, pages = 0;
    do {
      const page: TableSearchView = await searchPage(table, "needle", { limit, ...(after === undefined ? {} : { after }) }, load, plain);
      assert.ok(page.hits.length <= limit && page.hits.length > 0, "a page holds up to " + limit);
      places.push(...page.hits); after = page.next; pages++;
      assert.ok(pages < 200, "the pages end");
    } while (after !== undefined);
    assert.deepEqual(places, everything.hits, "limit " + limit + ": the pages are the whole search");
  }
  // An old cursor is checked; nothing before the first Turn.
  await assert.rejects(searchPage(table, "needle", { after: "abc" }, load, plain), /cursor/u);
  assert.deepEqual((await searchPage(table, "needle", { after: "0.0" }, load, plain)).hits, []);
});

test("the words alone are found by the full-text indexes: the same places as a search of everything restricted to the words, a page at a time, reading only the Turns they are in", { timeout: 60_000 }, async t => {
  const w = await scriptedWorld(t, turn => ({ reply: false as const, events: turn % 7 === 3
    ? [{ type: "text", text: "the first part mentions the needle" }, { type: "tool", id: "t" + turn, title: "no match here", status: "completed", detail: { kind: "execute", input: "echo hello", output: "hello", exitCode: 0 } }, { type: "text", text: "and the second part has the needle again" }]
    : [{ type: "text", text: "an answer for turn " + turn }] }));
  for (let turn = 1; turn <= 21; turn++) await w.send(turn % 5 === 0 ? "the needle in the user's words of turn " + turn : "plain words of turn " + turn);
  const table = rowsTable(w.store, w.id), asked = { searches: 0, turns: new Set<number>() };
  const spy = { ...w.store, head: (id: SessionId) => w.store.head(id), runOrdinal: (id: SessionId, runId: string) => w.store.runOrdinal(id, runId as never), originHistory: (id: SessionId) => w.store.originHistory(id), harnessIds: (id: SessionId) => w.store.harnessIds(id),
    turnAt: (id: SessionId, ordinal: number, options?: { inlineBytes?: number }) => { asked.turns.add(ordinal); return w.store.turnAt(id, ordinal, options); } };
  const counted = rowsTable(spy as never, w.id);
  const find = (words: string, range: { readonly limit: number; readonly after?: number }) => { asked.searches++; return w.store.search(words, { sessionId: w.id, limit: range.limit, ...(range.after === undefined ? {} : { after: range.after }) }).map(hit => ({ id: hit.id, ordinal: hit.ordinal, type: hit.type })); };
  const load: SearchLoad = async refs => ({ details: new Map(), unread: refs.length });
  const everything = (await searchPage(table, "needle", { limit: 50 }, load, plain)).hits.filter(hit => hit.where === "user" || hit.where === "reply");
  const order = (hits: readonly { readonly n: number; readonly where: string }[]) => [...hits].sort((left, right) => right.n - left.n || (left.where < right.where ? -1 : 1));
  assert.equal(everything.length, 7, "the needle is in the words of 4 Turns of the user and 3 replies");
  const whole = searchWordsPage(counted, "needle", { limit: 50 }, find, plain);
  assert.equal(whole.scope, "words"); assert.equal(whole.next, undefined);
  assert.deepEqual(order(whole.hits), order(everything), "the same places, with the same excerpts");
  assert.ok(asked.turns.size <= 7, "only the Turns the matches are in were read: " + [...asked.turns].sort((a, b) => a - b).join(","));
  assert.ok(asked.searches >= 1);
  for (const limit of [1, 2, 3]) {
    const places: typeof everything = [];
    let after: string | undefined, pages = 0;
    do {
      const page = searchWordsPage(table, "needle", { limit, ...(after === undefined ? {} : { after }) }, find, plain);
      assert.ok(page.hits.length > 0 && page.hits.length <= limit, "a page holds up to " + limit + ": " + page.hits.length);
      places.push(...page.hits); after = page.next; pages++;
      assert.ok(pages < 50, "the pages end");
    } while (after !== undefined);
    assert.deepEqual(places, whole.hits, "limit " + limit + ": the pages are the whole search, a reply told once though its segments are matched twice");
  }
  assert.throws(() => searchWordsPage(table, "needle", { after: "abc" }, find, plain), /cursor/u);
  // Through the HTTP API and the tool a Harness uses.
  const env = await mounted(t, w), found = await callTool("hub_search", { query: "needle", in: "words", limit: 3 }, "mcp", env);
  assert.equal(found.isError, false, found.text);
  assert.match(found.text, /only the user's words and the replies were searched/u); assert.match(found.text, /More places match: hub_search \{"query":"needle","after":"w\d+\.\d+(user|reply)","limit":3,"in":"words"\}/u);
  const refused = await callTool("hub_search", { query: "needle", in: "everything" }, "mcp", env);
  assert.equal(refused.isError, true);
});
