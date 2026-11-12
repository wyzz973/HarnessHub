import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { builtinHarnessName } from "../../src/cli/session-application.js";
import { sessionId, type SessionBindingFactory } from "../../src/contracts/session.js";
import { LEGACY_ORDER_NOTE } from "../../src/contexts/session/domain/table.js";
import { ConversationFacts } from "../../src/infrastructure/session/facts.js";
import { ConversationTables } from "../../src/infrastructure/session/read.js";
import { LEGACY_ORDER_LINE, exportMarkdown, rowsExport } from "../../src/web/conversation-export.js";
import { TurnView, turnFactsOf } from "../../src/web/turn-view.js";
import { v13Path } from "../fixtures/storage/v13/database.js";
import { WIRE_FIXTURES, wireOfFixture, type WireGolden } from "../fixtures/storage/v13/wire.js";
import { mountTable } from "../fixtures/table-http.js";

// The readers that moved from the conversation's old whole shape to its rows (ADR-057 step 2, line D), held to what the build before the cut said (tests/integration/cut-wire.test.ts holds the
// whole application to the same golden; here each reader that moved is read from rows instead). One reader per section; the answers are digested as cut-wire does (tests/fixtures/storage/v13/wire.ts)
// and held to the digests of wire-golden.json, apart from what is different by design, each said where it is edited out.
//
//  - The context table (src/web/table-routes.ts, src/contexts/session/domain/table.ts), mounted on a port of its own over the application's store: a Turn converted from before the order was kept
//    is told, in its overview, its tool calls and its files, that its order is a fixed arrangement (the note is edited out before the digest; tests/integration/table-rows.test.ts holds that it is
//    there), and a search is a page of places with a cursor (asked for 50, which holds every place of these conversations; made into the old answer: the first 10 places, and the count of all).
//  - The Markdown export (src/web/conversation-export.ts `exportMarkdown`): written a Turn at a time from the rows through a `TurnView`. Two differences are edited out before the digest, and one is
//    held to a digest of its own:
//      * the line that tells a migrated Turn its parts stand in a fixed arrangement, with the blank line after it (new);
//      * a sub-task still open when its Turn ended was "进行中" and is "结果未知" (an ended Turn does not say its work is going on: class 3 of the Turn-view comparison, tests/integration/turn-view.test.ts);
//      * the ORDER of the blocks of three conversations (session-ur-15, -32, -71 of unknown-recovered): the build before the cut wrote the messages of a conversation by the place of the event that
//        accepted each, so that the user's words queued behind a Turn came before that Turn's reply and a reply stood under another Turn's words; a Turn is now its words and then its own answer
//        (the page draws it so). Read in full on 2026-11-12: each holds exactly the lines the old export held, in the order of the Turns. Their digests are pinned here as REVIEWED.

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
/** The export without the line a migrated Turn is told its arrangement with (and the blank line after it), and with a sub-task still open at the end of its Turn as the build before the cut called it. */
function asBefore(text: string): string { return text.split(LEGACY_ORDER_LINE + "\n\n").join("").replace(/^(- 子任务 .*)（结果未知）$/gmu, "$1（进行中）"); }
/** The exports whose blocks the rows' reader writes in the order of the Turns where the build before the cut wrote them in the order of the messages' events: the digests of what was read in full. */
const REVIEWED: Readonly<Record<string, string>> = {
  "session-ur-15 export.md": "a51285f1561c274f72bffc507db8a64ea3a92d1fae49cb1c57a416cf63708e95",
  "session-ur-32 export.md": "1b5095c2f940daa015f0d78bc02e09c592479b23daa1b5f80d301e7880947aa9",
  "session-ur-71 export.md": "894f6a7fd8784b5c24dfa4032df6e71c9b031486b25a17788d03f917b2e99b2e",
};

for (const name of WIRE_FIXTURES) {
  test(`${name}: what is read from rows says what the build before the cut said (the context table; the Markdown export) apart from the fixed-arrangement note of a migrated Turn and the page of a search`, { timeout: 60_000 }, async () => {
    const expected = golden[name]!;
    const wire = await wireOfFixture(name, {
      searchLimit: 50,
      table: (app, grants) => mountTable({ grants, reader: app.store, content: app.content,
        secrets: (configuration, harnessIds) => { const factory: SessionBindingFactory = app.factory; return factory.relaySecrets === undefined ? Promise.resolve([]) : factory.relaySecrets(configuration, harnessIds); } }),
      editTable: (kind, value) => {
        if (kind === "turn") {
          const notes = Array.isArray(value.notes) ? value.notes.filter(note => note !== LEGACY_ORDER_NOTE) : value.notes;
          if (Array.isArray(notes) && notes.length === 0) delete value.notes; else if (notes !== undefined) value.notes = notes;
        }
        if (kind === "search") {
          assert.equal(value.next, undefined, "a page of 50 places reaches the first Turn of these conversations");
          const hits = value.hits as unknown[];
          value.total = hits.length; value.hits = hits.slice(0, 10); delete value.next;
        }
      },
      markdown: async (_app, root, id, at) => asBefore(exported(root, id, at)),
    });
    const keys = Object.keys(expected).filter(key => / table | export\.md$/u.test(key));
    assert.ok(keys.some(key => / table /u.test(key)) && keys.some(key => /export\.md$/u.test(key)), "the golden holds the table's answers and the exports for " + name);
    const differing = keys.filter(key => REVIEWED[key] !== undefined ? wire[key]?.sha256 !== REVIEWED[key] : wire[key]?.sha256 !== expected[key]!.sha256 || wire[key]?.bytes !== expected[key]!.bytes);
    if (process.env.WIRE_REVIEWED) for (const key of keys) if (wire[key]?.sha256 !== expected[key]!.sha256) process.stderr.write("REVIEW " + JSON.stringify(key) + ": \"" + wire[key]?.sha256 + "\",\n");
    assert.deepEqual(differing, [], name + ": what is read from rows says differently from the build before the cut (WIRE_DUMP=<directory> keeps the texts of a run to diff)");
  });
}
