import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { builtinHarnessName } from "../../src/cli/session-application.js";
import { sessionId, type SessionBindingFactory } from "../../src/contracts/session.js";
import { ConversationFacts } from "../../src/infrastructure/session/facts.js";
import { ConversationTables } from "../../src/infrastructure/session/read.js";
import { exportMarkdown, rowsExport } from "../../src/web/conversation-export.js";
import { TurnView, turnFactsOf } from "../../src/web/turn-view.js";
import { v13Path } from "../fixtures/storage/v13/database.js";
import { REVIEWED, asBefore, editTable } from "../fixtures/storage/v13/rows-wire.js";
import { WIRE_FIXTURES, wireOfFixture, type WireGolden } from "../fixtures/storage/v13/wire.js";
import { mountTable } from "../fixtures/table-http.js";

// The readers that moved from the conversation's old whole shape to its rows (ADR-057 step 2, line D), held to what the build before the cut said (tests/integration/cut-wire.test.ts holds the
// whole application to the same golden; here each reader that moved is read from rows directly instead). One reader per section; the answers are digested as cut-wire does (tests/fixtures/storage/v13/wire.ts)
// and held to the digests of wire-golden.json, apart from what is different by design (tests/fixtures/storage/v13/rows-wire.ts says each difference and why):
//  - The context table (src/web/table-routes.ts, src/contexts/session/domain/table.ts), mounted on a port of its own over the application's store.
//  - The Markdown export (src/web/conversation-export.ts `exportMarkdown`), written a Turn at a time from the rows through a `TurnView`, on a second read-only connection.

const golden = JSON.parse(readFileSync(v13Path("wire-golden.json"), "utf8")) as WireGolden;
const harnessName = builtinHarnessName();

/** The export as the rows' reader writes it, for the conversation `id` of the application on `root`, through a second read-only connection to the same database. */
function exported(root: string, id: string, at: Date): string {
  const db = new DatabaseSync(join(root, "gateway.sqlite"), { readOnly: true });
  try {
    const reader = new ConversationTables(db), view = new TurnView(turnFactsOf(sessionId(id), new ConversationFacts(db), () => ({})), { harnessName });
    return [...exportMarkdown(rowsExport(reader, sessionId(id), view), at)].join("");
  } finally { db.close(); }
}
for (const name of WIRE_FIXTURES) {
  test(`${name}: what is read from rows says what the build before the cut said (the context table; the Markdown export) apart from the fixed-arrangement note of a migrated Turn and the page of a search`, { timeout: 60_000 }, async () => {
    const expected = golden[name]!;
    const wire = await wireOfFixture(name, {
      table: (app, grants) => mountTable({ grants, reader: app.store, content: app.content,
        secrets: (configuration, harnessIds) => { const factory: SessionBindingFactory = app.factory; return factory.relaySecrets === undefined ? Promise.resolve([]) : factory.relaySecrets(configuration, harnessIds); } }),
      searchLimit: 50, editTable,
      markdown: async (_app, root, id, at) => asBefore(exported(root, id, at)),
    });
    const keys = Object.keys(expected).filter(key => / table | export\.md$/u.test(key));
    assert.ok(keys.some(key => / table /u.test(key)) && keys.some(key => /export\.md$/u.test(key)), "the golden holds the table's answers and the exports for " + name);
    const differing = keys.filter(key => REVIEWED[key] !== undefined ? wire[key]?.sha256 !== REVIEWED[key] : wire[key]?.sha256 !== expected[key]!.sha256 || wire[key]?.bytes !== expected[key]!.bytes);
    if (process.env.WIRE_REVIEWED) for (const key of keys) if (wire[key]?.sha256 !== expected[key]!.sha256) process.stderr.write("REVIEW " + JSON.stringify(key) + ": \"" + wire[key]?.sha256 + "\",\n");
    assert.deepEqual(differing, [], name + ": what is read from rows says differently from the build before the cut (WIRE_DUMP=<directory> keeps the texts of a run to diff)");
  });
}
