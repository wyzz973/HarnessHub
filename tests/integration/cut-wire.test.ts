import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { v13Path } from "../fixtures/storage/v13/database.js";
import { WIRE_FIXTURES, wireOfFixture, type WireGolden } from "../fixtures/storage/v13/wire.js";

// The cut (ADR-057 step 2): the runtime keeps conversations as rows, and the readers that have not moved to items are given the old shape by the store's adapter. This holds the
// whole application to what the build before the cut said: each frozen v13 fixture is written as a data root, the application is started on it (the upgrade to the tables, the
// recovery of what an owner left unfinished, the first collection that only reports) behind its real web server, and what is read over HTTP of its conversations — the lists, each
// conversation's view, its export as Markdown and as JSON, its event log, its handoff view and every handoff packet's text, the context table's directory, Turns and search —
// is held, as a digest, to the digest the build before the cut gave (tests/fixtures/storage/v13/wire.ts says what is left out and why; wire-golden.json was made by 26d4907).
// Only the Harness is absent: the fixtures' data roots are in temporary directories and nothing here reaches a real data root, a real Harness or a process.

const golden = JSON.parse(readFileSync(v13Path("wire-golden.json"), "utf8")) as WireGolden;

test("the golden holds every fixture the application is run on, and nothing else", () => {
  assert.deepEqual(Object.keys(golden).sort(), [...WIRE_FIXTURES].sort());
});

for (const name of WIRE_FIXTURES) {
  test(`${name}: the application started on it says over HTTP what the build before the cut said (views, exports, events, handoffs, context table, lists)`, { timeout: 60_000 }, async () => {
    const expected = golden[name]!, wire = await wireOfFixture(name);
    assert.deepEqual(Object.keys(wire).sort(), Object.keys(expected).sort(), "the same things were read");
    const differing = Object.keys(expected).filter(key => wire[key]?.sha256 !== expected[key]!.sha256 || wire[key]?.bytes !== expected[key]!.bytes);
    assert.deepEqual(differing, [], name + ": what differs from the build before the cut (WIRE_DUMP=<directory> keeps the texts of a run to diff)");
  });
}
