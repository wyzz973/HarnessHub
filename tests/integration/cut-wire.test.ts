import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { v13Path } from "../fixtures/storage/v13/database.js";
import { readsOfFixture } from "../fixtures/storage/v13/reads.js";
import { WIRE_FIXTURES, wireOfFixture, type WireGolden } from "../fixtures/storage/v13/wire.js";

// The cut (ADR-057 step 2): the runtime keeps conversations as rows, and the readers that have not moved to items are given the old shape by the store's adapter. This holds the
// whole application to what the build before the cut said: each frozen v13 fixture is written as a data root, the application is started on it (the upgrade to the tables, the
// recovery of what an owner left unfinished, the first collection that only reports) behind its real web server, and what is read over HTTP of its conversations — the lists, each
// conversation's view, its export as Markdown and as JSON, its event log, its handoff view and every handoff packet's text, the context table's directory, Turns and search —
// is held, as a digest, to the digest the build before the cut gave (tests/fixtures/storage/v13/wire.ts says what is left out and why; wire-golden.json was made by 26d4907).
// The two shapes the page flip replaced, the list of conversations and a conversation's view, are no longer said as the build before the cut said them: the second block of tests below reads
// their replacements whole (the page of conversations; each conversation's head and every Turn by the paged routes) and holds them to the golden's export of the same conversation.
// Only the Harness is absent: the fixtures' data roots are in temporary directories and nothing here reaches a real data root, a real Harness or a process.

const golden = JSON.parse(readFileSync(v13Path("wire-golden.json"), "utf8")) as WireGolden;

test("the golden holds every fixture the application is run on, and nothing else", () => {
  assert.deepEqual(Object.keys(golden).sort(), [...WIRE_FIXTURES].sort());
});

for (const name of WIRE_FIXTURES) {
  test(`${name}: the application started on it says over HTTP what the build before the cut said (views, exports, events, handoffs, context table, lists)`, { timeout: 60_000 }, async () => {
    const expected = golden[name]!, wire = await wireOfFixture(name);
    // The golden still holds the old list and the old view; this build says neither (see the second block).
    const kept = Object.keys(expected).filter(key => key !== "list" && !key.endsWith(" view"));
    assert.deepEqual(Object.keys(wire).sort(), kept.sort(), "the same things were read");
    const differing = kept.filter(key => wire[key]?.sha256 !== expected[key]!.sha256 || wire[key]?.bytes !== expected[key]!.bytes);
    assert.deepEqual(differing, [], name + ": what differs from the build before the cut (WIRE_DUMP=<directory> keeps the texts of a run to diff)");
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The shapes that replaced the old list and the old view, held to the golden's export
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const plain = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
/** What a Run says in the old view that is the display layer's and not the Run's own (the wire keeps it in the Turn's items and header). */
const DISPLAY = new Set(["input", "usage", "plan", "thinking", "tools", "notices", "activities", "outputs", "relayRequest", "protocol", "protocolProblem"]);
/** What a Run says on the wire that the old view did not: its place and its Turn's header. */
const PLACE = new Set(["ordinal", "userSeq", "turn", "input", "protocol"]);

for (const name of WIRE_FIXTURES) {
  test(`${name}: the page of conversations and every conversation read by the paged routes say what the golden's export of it says`, { timeout: 60_000 }, async () => {
    const reads = await readsOfFixture(name);
    // The list is a page of what the state lists, newest first, and reaches every conversation.
    assert.deepEqual(plain(reads.list.sessions), plain(reads.state.sessions), "the list and the state name the same conversations in the same order"); assert.equal(reads.list.next, null);
    for (const { id, read, exported } of reads.conversations) {
      const where = name + "/" + id + ": ";
      // The head says what the old view said of the conversation itself.
      for (const key of ["id", "epoch", "status", "workspace", "selection", "activeRunId", "pendingSwitchId", "nativeStates", "origin", "retention", "queue", "permissions"]) {
        assert.deepEqual(plain((read as unknown as Json)[key]), plain(exported[key]), where + "the head's " + key);
      }
      const runs = exported.runs as Json[], messages = exported.messages as Json[], switches = exported.switches as Json[];
      assert.equal(read.runCount, runs.length, where + "the Turns the head counts"); assert.equal(read.runs.length, runs.length, where + "every Turn is reached by the pages");
      assert.deepEqual(plain(read.lastSwitch), plain(switches.at(-1)), where + "the latest switch");
      // Each Run says what the old view said of it, apart from what moved into its Turn.
      read.runs.forEach((wire, index) => {
        const old = runs[index]!, shown = wire as unknown as Json;
        assert.equal(wire.id, old.id, where + "Run " + index + " is the same Run"); assert.equal(wire.ordinal, index, where + "its place");
        for (const key of Object.keys(old)) if (!DISPLAY.has(key)) assert.deepEqual(plain(shown[key]), plain(old[key]), where + "Run " + index + " " + key);
        for (const key of Object.keys(shown)) if (!PLACE.has(key)) assert.ok(key in old, where + "Run " + index + " says " + key + " that the old view did not");
        assert.equal(wire.input, old.input, where + "Run " + index + " your words"); assert.equal(wire.turn?.n, index + 1, where + "the Turn's number");
      });
      // The words of the conversation are the same words, by Run and by who said them.
      const said = new Map(read.messages.map(message => [message.runId + "|" + message.role, message.text]));
      for (const message of messages) assert.equal(said.get(message.runId + "|" + message.role), message.text, where + message.role + " message of " + message.runId);
      assert.equal(read.messages.length, messages.length, where + "no more words than the old view had");
      // What the head says of the whole that the page used to count from every Turn.
      assert.equal(read.facts.unknown.count, runs.filter(run => run.status === "unknown").length, where + "Turns whose result is unknown");
      assert.equal(read.facts.settled, runs.every(run => ["completed", "failed", "cancelled", "unknown"].includes(String(run.status))), where + "every Turn is over");
      const branch = runs.map((run, at) => ["completed", "failed", "cancelled"].includes(String(run.status)) ? at : -1).filter(at => at >= 0).at(-1);
      assert.equal(read.facts.branchable?.ordinal, branch, where + "where a branch can start");
    }
  });
}
