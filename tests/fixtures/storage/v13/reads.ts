import { readWhole, type ReadConversation } from "../../http-conversation.js";
import { withApplication } from "./wire.js";
import type { V13FixtureName } from "./database.js";

/*
 * What the application says of a frozen v13 fixture's conversations in the shapes that replaced the old view and the old list (ADR-057 3.4): the page of conversations, and for each
 * conversation its head and every one of its Turns read through the routes a page reads by (the newest Turns, then the pages before them), next to the export of the same conversation
 * as JSON, which is the old view's facts and which the golden pins (`wire-golden.json`, key `<id> export.json`). `cut-wire.test.ts` holds the two to each other.
 */
export interface FixtureReads {
  readonly list: { readonly sessions: readonly Record<string, unknown>[]; readonly next: string | null };
  readonly state: { readonly sessions: readonly Record<string, unknown>[] };
  readonly conversations: readonly { readonly id: string; readonly read: ReadConversation; readonly exported: Record<string, unknown> }[];
}

export async function readsOfFixture(name: V13FixtureName): Promise<FixtureReads> {
  return withApplication(name, async ({ fixture, read }) => {
    const json = async (path: string): Promise<unknown> => { const reply = await read(path); if (reply.status !== 200) throw new Error(path + " answered " + reply.status + ": " + reply.text.slice(0, 200)); return JSON.parse(reply.text); };
    const list = await json("/api/v1/sessions") as FixtureReads["list"], state = await json("/api/v1/state") as FixtureReads["state"];
    const conversations: { id: string; read: ReadConversation; exported: Record<string, unknown> }[] = [];
    for (const row of fixture.sessions) {
      const id = row.id as string, exported = (await json("/api/v1/sessions/" + id + "/export?format=json") as { session: Record<string, unknown> }).session;
      conversations.push({ id, read: await readWhole(json, id), exported });
    }
    return { list, state, conversations };
  });
}
