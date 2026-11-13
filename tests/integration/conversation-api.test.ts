import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { application } from "../../src/cli/session-application.js";
import type { ContentRef } from "../../src/contracts/content.js";
import { PAGE, type Conversation } from "../../src/contracts/conversation.js";
import { sessionId, type SessionId } from "../../src/contracts/session.js";
import type { ConversationChangesView, ItemTextView, RunItemsPageView, SessionListView, SessionViewV14, TurnPageView, WireItem } from "../../src/contracts/web.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { applyCommit, openWindow, viewOf, type WindowState } from "../../web/src/lib/protocol/window.js";
import { decodeSessionStreamFrameV14, decodeSessionViewV14 } from "../../web/src/lib/protocol/wire.js";
import { event, item } from "../fixtures/conversation-builder.js";
import { addItem, makeConversation, seedReply, seedTurns, type Home } from "../fixtures/big-conversations.js";
import { appStore } from "../fixtures/runtime-store.js";
import { Scenario } from "../fixtures/store-helpers.js";

/*
 * The conversation API as a page reads it (ADR-057 3.4), over real HTTP, a real Gateway process in this test and real SQLite: conversations kept as rows by the store's own writes,
 * the Gateway opened on that data root. A conversation of 2,000 Turns is opened by its window and walked back by cursor; a reply of 20 MiB is left out of the window and read
 * back by byte range; the edits of the whole conversation and the list of conversations are paged; what is not a request for a page is refused as such; a stream starts with the
 * window, and the page that follows its frames holds what a read gives. Only the Harness is made up.
 */

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
const selection = { harnessId: "api-a", controlId: "api-a-control" };
const textOf = (entry: WireItem): string | undefined => (entry as { text?: string }).text;
const detailRef = (id: string): ContentRef => ({ id: id as ContentRef["id"], name: id + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "a".repeat(64) });
const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

interface Seeded { readonly turns: SessionId; readonly reply: SessionId; readonly edits: SessionId; readonly queued: SessionId; readonly gone: SessionId; readonly many: readonly SessionId[]; readonly reply20: Buffer }
/** The conversations of the tests, written through the store before the Gateway opens the data root. */
function seed(store: FileConversationStore, configuration: Conversation["configuration"]): Seeded {
  // The conversations carry the configuration the Gateway was opened with, so that a Turn sent to one is run by the Harness that configuration names.
  const home: Home = { selection, configuration }, make = (name: string): SessionId => makeConversation(store, home, name);
  const turns = seedTurns(store, home, "turns", 2000), { id: reply, reply: reply20 } = seedReply(store, home, "reply");
  // Edits and a plan: Turn 0 edited twice (and reported one edit that has no stored detail), Turn 1 made a plan and edited once, Turn 2 only spoke.
  const edits = make("edits"), work = new Scenario(store, edits, "run-edits", false);
  const edit = (ordinal: number, name: string, withDetail: boolean) => addItem(store, edits, ordinal, (seq, runId) => item(runId, seq, "tool:" + name, "file_change", "completed",
    { changes: [{ path: "src/" + name + ".ts", op: "modify", added: 2, removed: 1 }], ...(withDetail ? { detail: detailRef("detail-" + name) } : {}) }));
  const plan = (ordinal: number) => addItem(store, edits, ordinal, (seq, runId) => item(runId, seq, "plan", "plan", "completed", { steps: [{ text: "read", status: "completed" }, { text: "write", status: "in_progress" }, { text: "test", status: "pending" }] }));
  work.accept("first", { selection }); work.start(0); edit(0, "one", true); edit(0, "two", true); edit(0, "three", false); work.finish(0);
  work.accept("second", { selection }); work.start(1); plan(1); edit(1, "four", true); work.finish(1);
  work.turn("third", "done", { selection });
  // A conversation whose second input was accepted while the first Turn ran: by the seqs the user's two inputs come before the first reply.
  const queued = make("queued"), line = new Scenario(store, queued, "run-queued", false);
  line.accept("first", { selection }); line.start(0); line.accept("second", { selection }); line.say(0, "reply to first"); line.finish(0); line.start(1); line.say(1, "reply to second"); line.finish(1);
  // A conversation that was deleted is hidden; the rest are many, for the list.
  const gone = make("gone"); new Scenario(store, gone, "run-gone", false).turn("a question", "an answer", { selection });
  store.transact(gone, store.get(gone).version, current => ({ next: { ...current, status: "closed" }, events: [event("session.closed")] }));
  store.deleteSession(gone);
  const many = Array.from({ length: 250 }, (_, index) => make("n" + String(index).padStart(3, "0")));
  return { turns, reply, edits, queued, gone, many, reply20 };
}

/** The Gateway the tests of this file share: opened once on the seeded data root (the tests only read, but for the last, which sends a Turn to the conversation of 2,000). */
interface Served { readonly origin: string; readonly cookie: string; readonly csrf: string; readonly ids: Seeded; readonly gateway: WebServer; close(): Promise<void> }
async function served(): Promise<Served> {
  const root = await mkdtemp(join(tmpdir(), "harness-conversation-api-")), workspace = join(root, "workspace"), assets = join(root, "assets"), manifest = join(root, "catalog.json"), data = join(root, "data");
  await mkdir(workspace); await mkdir(assets); await writeFile(join(assets, "index.html"), "<!doctype html><title>HarnessGateway fixture</title>");
  const source = { repository: "fixture", revision: "api", upstreamId: "peer", url: "https://example.invalid/api-peer" };
  const definition = { id: selection.harnessId, name: "Api a", aliases: [], binaryNames: [], configHints: [], controls: [{ id: selection.controlId, protocol: "acp-v1", executableNames: ["fixture-peer"],
    args: [peer, "acp-v1", "a", "basic"], env: { FIXTURE_TRACE: join(root, "trace.ndjson") }, requiredExecutables: [], package: null, distribution: null, source }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { [selection.controlId]: { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const store = appStore(data);
  let ids: Seeded;
  try { ids = seed(store, configuration); } finally { store.close(); }
  const gateway = await startWebServer({ installations: "any", root: data, configuration, port: 0, assetsDirectory: assets, workspaceLockRoot: join(root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) });
  const parsed = new URL(gateway.url), origin = parsed.origin, token = new URLSearchParams(parsed.hash.slice(1)).get("token")!;
  const login = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String(((await login.json()) as { csrfToken: string }).csrfToken);
  return { origin, cookie, csrf, ids, gateway, close: async () => { try { await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}
let shared: Served | undefined;
before(async () => { shared = await served(); });
after(async () => { await shared?.close(); });

interface Answer<T> { readonly status: number; readonly type: string; readonly bytes: number; readonly text: string; readonly data: T }
async function get<T = unknown>(s: Served, path: string, headers: Record<string, string> = {}): Promise<Answer<T>> {
  const response = await fetch(s.origin + path, { headers: { Cookie: s.cookie, Origin: s.origin, ...headers } }), body = Buffer.from(await response.arrayBuffer()), text = body.toString("utf8");
  return { status: response.status, type: response.headers.get("content-type") ?? "", bytes: body.length, text, data: (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as T };
}
const code = (answer: Answer<unknown>): unknown => (answer.data as { code?: unknown }).code;
const ordinals = (turns: readonly { readonly run: { readonly ordinal: number } }[]): number[] => turns.map(turn => turn.run.ordinal);

test("over HTTP a conversation of 2,000 Turns opens as its head and the newest ten, and the Turns before are read by the cursor each page gives, every one once", { timeout: 120_000 }, async () => {
  const s = shared!, base = "/api/v1/sessions/" + s.ids.turns;
  const opened = await get<SessionViewV14>(s, base);
  assert.equal(opened.status, 200); assert.match(opened.type, /^application\/json/u);
  assert.ok(opened.bytes < 32 * 1024, "the answer for 2,000 Turns is " + opened.bytes + " bytes");
  assert.deepEqual([opened.data.head.id, opened.data.head.runCount, opened.data.head.title, opened.data.head.status], [s.ids.turns, 2000, "question 0", "open"]);
  assert.deepEqual(ordinals(opened.data.window.turns), [1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999]);
  assert.deepEqual(opened.data.window.turns.at(-1)!.items.map(entry => [entry.type, textOf(entry)]), [["user_message", "question 1999"], ["assistant_message", "answer 1999"]]);
  // The head says what the page used to learn by looking at every Turn.
  assert.deepEqual([opened.data.head.facts.settled, opened.data.head.facts.unknown, opened.data.head.facts.changes, opened.data.head.facts.branchable],
    [true, { count: 0, unclosed: false }, 0, { runId: "run-turns-1999", ordinal: 1999 }]);
  assert.deepEqual(opened.data.head.facts.ran, [{ ...selection, turns: 2000 }]);
  for (const key of ["runs", "messages", "switches"]) assert.equal(key in opened.data, false, key + " is no member of the answer");
  // Back through the conversation: every Turn once, in order, whatever the size of the page asked for; the bytes of a page follow the page.
  for (const limit of [undefined, 7, 1000]) {
    const seen: number[] = [...ordinals(opened.data.window.turns)];
    let cursor = opened.data.window.older, pages = 0, widest = 0;
    while (cursor !== null) {
      const page = await get<TurnPageView>(s, base + "/turns?before=" + encodeURIComponent(cursor) + (limit === undefined ? "" : "&limit=" + limit));
      assert.equal(page.status, 200, page.text); assert.ok(page.data.turns.length > 0 && page.data.turns.length <= (limit ?? PAGE.olderTurns));
      seen.unshift(...ordinals(page.data.turns)); cursor = page.data.older; pages++; widest = Math.max(widest, page.bytes);
      assert.ok(pages <= 2000);
    }
    assert.deepEqual(seen, Array.from({ length: 2000 }, (_, ordinal) => ordinal), "limit " + limit);
    if (limit === undefined) assert.equal(pages, 100);
    if (limit === 1000) { assert.ok(pages <= 4, "a page of 1000 Turns reached the first Turn in " + pages + " pages"); assert.ok(widest < 3 * PAGE.windowBytes, "and no page was " + widest + " bytes"); }
  }
  // The items of a Turn by place, one item whole, and a range of its words.
  const items = await get<RunItemsPageView>(s, base + "/runs/1999/items?after=0&limit=5");
  assert.equal(items.status, 200); assert.deepEqual(items.data.items.map(entry => entry.seq), [1, 2]); assert.equal(items.data.next, null);
  const reply = await get<{ item: WireItem }>(s, base + "/runs/1999/items/2");
  assert.deepEqual([reply.status, textOf(reply.data.item)], [200, "answer 1999"]);
  assert.deepEqual((await get<ItemTextView>(s, base + "/runs/1999/items/2/text?from=2&to=5")).data, { text: "swe", from: 2, to: 5, total: "answer 1999".length });
});

test("over HTTP what is not a request for a page is refused as such, what is not there says so, and the routes are the logged-in page's alone", { timeout: 120_000 }, async () => {
  const s = shared!, base = "/api/v1/sessions/" + s.ids.turns, opened = await get<SessionViewV14>(s, base), cursor = encodeURIComponent(opened.data.window.older!);
  for (const query of ["", "?before=", "?before=not-a-cursor", "?before=e30", "?before=" + Buffer.from(JSON.stringify({ ordinal: -1, lastSeq: 5 })).toString("base64url"),
    "?before=" + Buffer.from(JSON.stringify({ ordinal: 99999, lastSeq: 5 })).toString("base64url"), "?before=" + cursor + "&limit=0", "?before=" + cursor + "&limit=-1", "?before=" + cursor + "&limit=1.5",
    "?before=" + cursor + "&limit=abc", "?before=" + cursor + "&limit=1e3", "?before=" + cursor + "&extra=1", "?before=" + cursor + "&before=" + cursor]) {
    const refused = await get(s, base + "/turns" + query);
    assert.equal(refused.status, 400, "turns" + query + " answered " + refused.status + " " + refused.text); assert.equal(code(refused), "INVALID_INPUT", "turns" + query);
  }
  for (const path of ["/runs/x/items", "/runs/-1/items", "/runs/1.5/items", "/runs/1/items?after=x", "/runs/1/items/x", "/runs/1/items/-3", "/runs/1/items/2/text?from=x", "/runs/1/items/2/text?to=-1", "/runs/1/items/2/text?from=5&to=4",
    "/changes?before=x", "/changes?limit=0", "/changes?before=1:0"]) {
    const refused = await get(s, base + path);
    assert.equal(refused.status, 400, path + " answered " + refused.status + " " + refused.text); assert.equal(code(refused), "INVALID_INPUT", path);
  }
  for (const path of ["/api/v1/sessions?after=garbage", "/api/v1/sessions?limit=0", "/api/v1/sessions?limit=x", "/api/v1/sessions/nonsense"]) {
    const refused = await get(s, path); assert.equal(refused.status, 400, path + " answered " + refused.status); assert.equal(code(refused), "INVALID_INPUT", path);
  }
  // Not there: a conversation that never was, one that was deleted, a Turn, an item.
  for (const path of ["/api/v1/sessions/session-nowhere", "/api/v1/sessions/session-nowhere/turns?before=" + cursor, "/api/v1/sessions/session-nowhere/changes", "/api/v1/sessions/" + s.ids.gone,
    "/api/v1/sessions/" + s.ids.gone + "/turns?before=" + cursor, "/api/v1/sessions/" + s.ids.gone + "/runs/0/items", "/api/v1/sessions/" + s.ids.gone + "/changes"]) {
    const missing = await get(s, path); assert.equal(missing.status, 404, path + " answered " + missing.status); assert.equal(code(missing), "SESSION_NOT_FOUND", path);
  }
  const run = await get(s, base + "/runs/5000/items"); assert.deepEqual([run.status, code(run)], [404, "RUN_NOT_FOUND"]);
  const nothing = await get(s, base + "/runs/1/items/9"); assert.deepEqual([nothing.status, code(nothing)], [404, "ITEM_NOT_FOUND"]);
  assert.equal((await get(s, base + "/runs/1/items/2/text?from=9999")).status, 200, "a range past the end is the end");
  // The routes answer the page that logged in, and nobody else; they change nothing, so they answer a plain GET and no POST.
  for (const path of [base, base + "/turns?before=" + cursor, base + "/changes", base + "/runs/1/items", "/api/v1/sessions"]) {
    assert.equal((await fetch(s.origin + path, { headers: { Origin: s.origin } })).status, 401, path + " without the login");
    assert.equal((await fetch(s.origin + path, { headers: { Cookie: s.cookie, Origin: "https://elsewhere.invalid" } })).status, 403, path + " from another origin");
  }
  const posted = await fetch(s.origin + base + "/turns?before=" + cursor, { method: "POST", headers: { Cookie: s.cookie, Origin: s.origin, "X-CSRF-Token": s.csrf, "Content-Type": "application/json" }, body: "{}" });
  assert.ok(posted.status === 404 || posted.status === 405, "a read route has no POST: " + posted.status);
});

test("over HTTP a reply of 20 MiB is left out of the window by its size, read back by byte ranges that join to the reply, and no answer but the one for the reply whole is large", { timeout: 120_000 }, async () => {
  const s = shared!, base = "/api/v1/sessions/" + s.ids.reply, whole = s.ids.reply20;
  assert.ok(whole.length > 20 * 1024 * 1024 - 100 * 1024, "the reply has " + whole.length + " bytes");
  const opened = await get<SessionViewV14>(s, base);
  assert.equal(opened.status, 200); assert.ok(opened.bytes < 8 * 1024, "the answer for a conversation with a reply of 20 MiB is " + opened.bytes + " bytes");
  const answer = opened.data.window.turns[0]!.items[1]!;
  assert.deepEqual([answer.type, answer.bodyOmitted, answer.textBytes, "text" in answer], ["assistant_message", true, whole.length, false]);
  assert.equal(textOf(opened.data.window.turns[0]!.items[0]!), "write a lot");
  // One range after another, each from where the last ended: the pieces are the reply, to the byte, and each answer is about the size of its range.
  const parts: Buffer[] = [];
  let from = 0, widest = 0;
  while (from < whole.length) {
    const range = await get<ItemTextView>(s, base + "/runs/0/items/2/text?from=" + from + "&to=" + (from + 1_000_003));
    assert.equal(range.status, 200); assert.equal(range.data.total, whole.length); assert.ok(range.data.from >= from && range.data.from - from < 4, "a range starts at the next character");
    assert.ok(range.data.to > from, "a range goes on"); widest = Math.max(widest, range.bytes);
    parts.push(Buffer.from(range.data.text, "utf8")); from = range.data.to;
    assert.equal(Buffer.concat(parts).length, range.data.to, "no gap and no repeat");
  }
  assert.ok(widest < 1_000_003 * 4 + 1024, "no range answer was " + widest + " bytes");
  assert.equal(sha(Buffer.concat(parts)), sha(whole));
  // The item whole is the reply whole; a range that names no end is read to the end of what a page carries.
  const full = await get<{ item: WireItem }>(s, base + "/runs/0/items/2");
  assert.equal(full.status, 200); assert.equal(full.data.item.bodyOmitted, undefined); assert.equal(sha(Buffer.from(textOf(full.data.item)!, "utf8")), sha(whole));
  const rest = await get<ItemTextView>(s, base + "/runs/0/items/2/text?from=" + (whole.length - 10));
  assert.deepEqual([rest.data.to, rest.data.total], [whole.length, whole.length]);
});

test("over HTTP the edits of the whole conversation are counted in its head and paged newest first with the latest plan on the first page", { timeout: 120_000 }, async () => {
  const s = shared!, base = "/api/v1/sessions/" + s.ids.edits;
  const opened = await get<SessionViewV14>(s, base);
  assert.equal(opened.data.head.facts.changes, 3, "the edit that has no stored detail is no change to show");
  const first = await get<ConversationChangesView>(s, base + "/changes");
  assert.equal(first.status, 200); assert.equal(first.data.next, null);
  assert.deepEqual(first.data.edits.map(edit => [edit.ordinal, edit.item.seq, edit.item.type === "file_change" ? edit.item.changes.map(change => change.path) : null, edit.harnessId]),
    [[1, 3, ["src/four.ts"], "api-a"], [0, 3, ["src/two.ts"], "api-a"], [0, 2, ["src/one.ts"], "api-a"]]);
  assert.deepEqual([first.data.plan?.ordinal, first.data.plan?.item.type === "plan" ? first.data.plan.item.steps.map(step => step.status) : null], [1, ["completed", "in_progress", "pending"]]);
  // By the cursor, one at a time: the same edits, the plan on the first page only.
  const seen: string[] = [];
  let page = await get<ConversationChangesView>(s, base + "/changes?limit=1"), pages = 1;
  assert.ok("plan" in page.data);
  for (;;) {
    seen.push(...page.data.edits.map(edit => edit.ordinal + ":" + edit.item.seq));
    if (page.data.next === null) break;
    page = await get<ConversationChangesView>(s, base + "/changes?limit=1&before=" + encodeURIComponent(page.data.next)); pages++;
    assert.equal(page.status, 200); assert.equal("plan" in page.data, false);
  }
  assert.deepEqual([seen, pages], [["1:3", "0:3", "0:2"], 3]);
  // A conversation that never edited has none, and no plan.
  const bare = await get<ConversationChangesView>(s, "/api/v1/sessions/" + s.ids.turns + "/changes");
  assert.deepEqual(bare.data, { edits: [], next: null, plan: null });
});

test("over HTTP the conversations are listed newest first a page at a time, every one by the cursor and none past the hundred a page carries, and a deleted one is not among them", { timeout: 120_000 }, async () => {
  const s = shared!, everyone = [s.ids.turns, s.ids.reply, s.ids.edits, s.ids.queued, ...s.ids.many];
  const first = await get<SessionListView>(s, "/api/v1/sessions");
  assert.equal(first.status, 200); assert.equal(first.data.sessions.length, PAGE.sessions); assert.ok(first.data.next !== null);
  for (const limit of [undefined, 1, 37, 100, 100000]) {
    const seen: string[] = [];
    let page = limit === undefined ? first : await get<SessionListView>(s, "/api/v1/sessions?limit=" + limit), pages = 1;
    for (;;) {
      assert.equal(page.status, 200); assert.ok(page.data.sessions.length > 0 && page.data.sessions.length <= Math.min(limit ?? PAGE.sessions, 500));
      seen.push(...page.data.sessions.map(row => row.id));
      if (page.data.next === null) break;
      page = await get<SessionListView>(s, "/api/v1/sessions?after=" + encodeURIComponent(page.data.next) + (limit === undefined ? "" : "&limit=" + limit)); pages++;
      assert.ok(pages <= 400);
    }
    assert.equal(new Set(seen).size, seen.length, "no conversation twice (limit " + limit + ")");
    assert.deepEqual([...seen].sort(), [...everyone].sort(), "every conversation but the deleted one (limit " + limit + ")");
    if (limit === undefined) assert.equal(pages, Math.ceil(everyone.length / PAGE.sessions));
  }
  const titles = new Map(first.data.sessions.map(row => [row.id, row.title]));
  assert.ok([...titles.values()].every(title => typeof title === "string"));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The export, written a Turn at a time
// ---------------------------------------------------------------------------------------------------------------------------------

interface Exported { readonly application: string; readonly exportedAt: string; readonly session: { readonly id: string; readonly runCount?: number; readonly runs: { readonly id: string; readonly input: string }[];
  readonly messages: { readonly role: string; readonly text: string; readonly seq: number; readonly runId: string }[]; readonly switches: unknown[] } }
async function download(s: Served, id: string, format: "json" | "markdown"): Promise<{ readonly status: number; readonly length: string | null; readonly type: string | null; readonly text: string }> {
  const response = await fetch(s.origin + "/api/v1/sessions/" + id + "/export?format=" + format, { headers: { Cookie: s.cookie, Origin: s.origin } });
  return { status: response.status, length: response.headers.get("content-length"), type: response.headers.get("content-type"), text: await response.text() };
}

test("over HTTP the JSON export of 2,000 Turns is sent in pieces as the JSON a person would write by hand: every Turn once, the words in the order they were said", { timeout: 120_000 }, async () => {
  const s = shared!, sent = await download(s, s.ids.turns, "json");
  assert.equal(sent.status, 200); assert.equal(sent.type, "application/json; charset=utf-8"); assert.equal(sent.length, null, "its length is not known before it is written");
  const exported = JSON.parse(sent.text) as Exported;
  assert.equal(JSON.stringify(exported, null, 2) + "\n", sent.text, "the layout is the one JSON.stringify makes of the whole");
  assert.equal(exported.application, "HarnessHub"); assert.equal(exported.session.id, s.ids.turns);
  assert.equal(exported.session.runs.length, 2000); assert.equal(exported.session.messages.length, 4000); assert.deepEqual(exported.session.switches, []);
  assert.deepEqual(exported.session.runs.map(run => run.input).slice(0, 3).concat(exported.session.runs.at(-1)!.input), ["question 0", "question 1", "question 2", "question 1999"]);
  assert.ok(exported.session.messages.every((message, index, all) => index === 0 || all[index - 1]!.seq < message.seq), "the words are in the order of their seqs");
  assert.deepEqual([exported.session.messages[0]!.text, exported.session.messages[1]!.text, exported.session.messages.at(-1)!.text], ["question 0", "answer 0", "answer 1999"]);
});

test("over HTTP the words of an input that was queued behind a Turn are in the export in the order they were said, and the Runs in the order of the Turns", async () => {
  const s = shared!, sent = await download(s, s.ids.queued, "json"), exported = JSON.parse(sent.text) as Exported;
  assert.deepEqual(exported.session.messages.map(message => message.role + ": " + message.text), ["user: first", "user: second", "assistant: reply to first", "assistant: reply to second"]);
  assert.deepEqual(exported.session.runs.map(run => run.input), ["first", "second"]);
  assert.ok(exported.session.messages.every((message, index, all) => index === 0 || all[index - 1]!.seq < message.seq));
  // The Markdown is the Turns in their order, each its own words and its own answer (the page draws it so).
  const markdown = (await download(s, s.ids.queued, "markdown")).text;
  assert.ok(markdown.indexOf("first\n```") < markdown.indexOf("reply to first") && markdown.indexOf("reply to first") < markdown.indexOf("second\n```") && markdown.indexOf("second\n```") < markdown.indexOf("reply to second"), markdown);
});

test("over HTTP the Markdown export of 2,000 Turns has each Turn once in order, and an export of a reply of 20 MiB carries it whole in both formats", { timeout: 180_000 }, async () => {
  const s = shared!, many = await download(s, s.ids.turns, "markdown");
  assert.equal(many.status, 200); assert.equal(many.type, "text/markdown; charset=utf-8"); assert.equal(many.length, null);
  assert.match(many.text, /^# question 0\n/u); assert.equal(many.text.split("\n## 你\n").length - 1, 2000, "the words of each Turn once");
  assert.ok(many.text.indexOf("question 7\n") < many.text.indexOf("question 8\n") && many.text.lastIndexOf("question 1999\n") < many.text.lastIndexOf("answer 1999\n"), "in the order of the Turns, each question before its answer");
  const reply = s.ids.reply20.toString("utf8");
  const json = JSON.parse((await download(s, s.ids.reply, "json")).text) as Exported;
  assert.ok(json.session.messages[1]!.text === reply, "the 20 MiB reply is in the JSON whole, as the store holds it");
  assert.ok((await download(s, s.ids.reply, "markdown")).text.includes(reply), "and in the Markdown");
});

test("over HTTP an export of a conversation that is not there, or was deleted, is not found before anything is sent; a format that is neither is refused", async () => {
  const s = shared!;
  for (const format of ["json", "markdown"] as const) {
    for (const id of ["session-nowhere", s.ids.gone]) {
      const missing = await get(s, "/api/v1/sessions/" + id + "/export?format=" + format);
      assert.equal(missing.status, 404, id + " " + format); assert.equal(code(missing), "SESSION_NOT_FOUND"); assert.match(missing.type, /^application\/json/u, "a JSON error and not the start of a file");
    }
  }
  assert.equal((await get(s, "/api/v1/sessions/" + s.ids.queued + "/export?format=pdf")).status, 400);
});

test("over HTTP a stream of a conversation of 2,000 Turns starts with its window, not the conversation, and the page that follows the frames of a new Turn holds what a read gives", { timeout: 120_000 }, async t => {
  const s = shared!, id = s.ids.turns, abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(s.origin + "/api/v1/sessions/" + id + "/events/stream?afterSeq=0", { headers: { Cookie: s.cookie, Origin: s.origin }, signal: abort.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
  const reader = response.body!.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const next = async (): Promise<{ readonly frame: Record<string, unknown>; readonly bytes: number }> => {
    for (;;) {
      const at = buffer.indexOf("\n\n");
      if (at >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const data = block.split("\n").find(line => line.startsWith("data: "));
        if (data === undefined || block.startsWith("event: attention")) continue;
        return { frame: JSON.parse(data.slice(6)) as Record<string, unknown>, bytes: data.length };
      }
      const timer = setTimeout(() => abort.abort(), 10_000);
      try { const chunk = await reader.read(); if (chunk.done) throw new Error("the stream ended"); buffer += decoder.decode(chunk.value, { stream: true }); } finally { clearTimeout(timer); }
    }
  };
  // It starts with the conversation as a window.
  const opening = await next();
  assert.equal(opening.frame.type, "snapshot"); assert.ok(opening.bytes < 32 * 1024, "the first frame is " + opening.bytes + " bytes");
  const snapshot = decodeSessionStreamFrameV14(opening.frame);
  assert.ok(snapshot.type === "snapshot"); assert.equal(snapshot.session.window.turns.length, 10);
  let page: WindowState = openWindow(snapshot.session);
  // A Turn is sent: the frames that follow are commits, each the next version, and the page that applies them holds what a read gives.
  const sent = await fetch(s.origin + "/api/v1/sessions/" + id + "/messages", { method: "POST", headers: { Cookie: s.cookie, Origin: s.origin, "X-CSRF-Token": s.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "one more question", commandId: "one-more" }) });
  assert.equal(sent.status, 202, await sent.clone().text());
  const types: string[] = [], resyncs: string[] = [];
  for (let frames = 0; frames < 200; frames++) {
    const received = await next(), frame = decodeSessionStreamFrameV14(received.frame);
    types.push(frame.type);
    if (frame.type === "snapshot") { page = openWindow(frame.session); continue; }
    if (frame.type !== "commit") continue;
    const result = applyCommit(page, frame);
    if (result.kind === "resync") resyncs.push(result.reason); else page = result.state;
    const newest = viewOf(page).window.turns.at(-1)!.run;
    if (newest.ordinal === 2000 && newest.status === "completed") break;
  }
  assert.deepEqual(resyncs, []); assert.ok(types.filter(type => type === "commit").length >= 2, "the Turn was told by commit frames: " + types.join(","));
  // The page reads what the Gateway answers through its decoder, as it reads the frames: the two are compared as the page holds them.
  const read = decodeSessionViewV14((await get(s, "/api/v1/sessions/" + id)).data), held = viewOf(page);
  assert.equal(read.head.runCount, 2001); assert.deepEqual([held.head.version, held.head.lastSeq], [read.head.version, read.head.lastSeq]);
  assert.deepEqual(JSON.parse(JSON.stringify(held.window.turns.slice(-read.window.turns.length))), JSON.parse(JSON.stringify(read.window.turns)));
  // The Turn has the hand-over line the relay put first (it began a native session for the conversation), the words sent, and the reply.
  // The history is longer than a hand-over holds, so the Turn also says the task's state before the words, and says that it did (2026-11-13).
  const last = read.window.turns.at(-1)!.items.map(entry => [entry.type, textOf(entry as unknown as WireItem)]);
  assert.deepEqual(last.map(row => row[0]), ["switch", "user_message", "notice", "assistant_message"]);
  assert.equal(last[1]![1], "one more question"); assert.equal(last[2]![1], "带上了任务现在的状态");
  assert.match(String(last[3]![1]), /^a:（HarnessHub：这件任务现在的状态[\s\S]*one more question$/u);
});
