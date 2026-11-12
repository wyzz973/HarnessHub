import assert from "node:assert/strict";
import { LEGACY_ORDER_NOTE } from "../../../../src/contexts/session/domain/table.js";
import { LEGACY_ORDER_LINE } from "../../../../src/web/conversation-export.js";
import type { WireOptions } from "./wire.js";

/*
 * What a build that reads rows says differently from the build before the cut (wire-golden.json), each difference said once, here, for the two tests that hold the readers to the golden
 * (tests/integration/cut-wire.test.ts over HTTP, tests/integration/cut-wire-rows.test.ts reading the rows directly):
 *
 *  - the context table: a Turn converted from before the order was kept is told, in its overview, its tool calls and its files, that its order is a fixed arrangement (the note is edited out
 *    before the digest; tests/integration/table-rows.test.ts holds that it is there), and a search is a page of places with a cursor (asked for 50, which holds every place of these
 *    conversations; made into the old answer: the first 10 places, and the count of all);
 *  - the Markdown export, written a Turn at a time from the rows through a `TurnView`. Two differences are edited out before the digest, and one is held to a digest of its own:
 *      * the line that tells a migrated Turn its parts stand in a fixed arrangement, with the blank line after it (new);
 *      * a sub-task still open when its Turn ended was "进行中" and is "结果未知" (an ended Turn does not say its work is going on: class 3 of the Turn-view comparison, tests/integration/turn-view.test.ts);
 *      * the ORDER of the blocks of three conversations (session-ur-15, -32, -71 of unknown-recovered): the build before the cut wrote the messages of a conversation by the place of the event that
 *        accepted each, so that the user's words queued behind a Turn came before that Turn's reply and a reply stood under another Turn's words; a Turn is now its words and then its own answer
 *        (the page draws it so). Read in full on 2026-11-12: each holds exactly the lines the old export held, in the order of the Turns. Their digests are pinned here as REVIEWED.
 *
 * The JSON export has no difference: it is held to the golden as it is.
 */

/** The export without the line a migrated Turn is told its arrangement with (and the blank line after it), and with a sub-task still open at the end of its Turn as the build before the cut called it. */
export function asBefore(text: string): string { return text.split(LEGACY_ORDER_LINE + "\n\n").join("").replace(/^(- 子任务 .*)（结果未知）$/gmu, "$1（进行中）"); }
/** The exports whose blocks the rows' reader writes in the order of the Turns where the build before the cut wrote them in the order of the messages' events: the digests of what was read in full. */
export const REVIEWED: Readonly<Record<string, string>> = {
  "session-ur-15 export.md": "a51285f1561c274f72bffc507db8a64ea3a92d1fae49cb1c57a416cf63708e95",
  "session-ur-32 export.md": "1b5095c2f940daa015f0d78bc02e09c592479b23daa1b5f80d301e7880947aa9",
  "session-ur-71 export.md": "894f6a7fd8784b5c24dfa4032df6e71c9b031486b25a17788d03f917b2e99b2e",
};
/** A table answer made into the answer the build before the cut gave. */
export function editTable(kind: "turns" | "turn" | "search", value: Record<string, unknown>): void {
  if (kind === "turn") {
    const notes = Array.isArray(value.notes) ? value.notes.filter(note => note !== LEGACY_ORDER_NOTE) : value.notes;
    if (Array.isArray(notes) && notes.length === 0) delete value.notes; else if (notes !== undefined) value.notes = notes;
  }
  if (kind === "search") {
    assert.equal(value.next, undefined, "a page of 50 places reaches the first Turn of these conversations");
    const hits = value.hits as unknown[];
    value.total = hits.length; value.hits = hits.slice(0, 10); delete value.next;
  }
}
/** What a run of the wire on a build that reads rows is told. */
export const ROWS_WIRE: Pick<WireOptions, "searchLimit" | "editTable"> = { searchLimit: 50, editTable };
