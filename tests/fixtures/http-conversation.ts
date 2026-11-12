import type { ProtocolTurn } from "../../src/contracts/protocol.js";
import type { SessionHeadView, SessionViewV14, TurnPageView, WireRun, WireTurn } from "../../src/contracts/web.js";

/**
 * A conversation read whole through the routes a page reads it by (ADR-057 3.4): the head and the newest Turns of `GET /api/v1/sessions/:id`, then the Turns before them, a page at a
 * time, until the first. For the tests that look at a small conversation's every Turn (the Runs with their relay facts, their states); the page itself holds a window.
 */
export interface ReadRun extends WireRun {
  /** The words of the Turn's `user_message` item. */
  readonly input: string;
  /** The Turn as the protocol tells it: its header and its items. */
  readonly protocol: ProtocolTurn;
}
export interface ReadConversation extends SessionHeadView {
  /** Every Turn of the conversation, oldest first. */
  readonly turns: readonly WireTurn[];
  /** Their Runs, oldest first, each with the words it was given (`input`) and its Turn as the protocol tells it (`protocol`). */
  readonly runs: readonly ReadRun[];
  /** What was said, in the order of the Turns: each Turn's input, then its reply (its reply segments joined). */
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly runId: string; readonly text: string }[];
}
export async function readWhole(get: (path: string) => Promise<unknown>, id: string): Promise<ReadConversation> {
  const first = await get("/api/v1/sessions/" + id) as SessionViewV14;
  let turns = [...first.window.turns], older = first.window.older;
  while (older !== null) {
    const page = await get("/api/v1/sessions/" + id + "/turns?before=" + encodeURIComponent(older) + "&limit=1000") as TurnPageView;
    turns = [...page.turns, ...turns]; older = page.older;
  }
  const said = (turn: WireTurn, type: string): string[] => turn.items.filter(item => item.type === type).map(item => String((item as { text?: string }).text ?? ""));
  const messages = turns.flatMap(turn => {
    const reply = said(turn, "assistant_message");
    return [...said(turn, "user_message").map(text => ({ role: "user" as const, runId: turn.run.id, text })), ...(reply.length ? [{ role: "assistant" as const, runId: turn.run.id, text: reply.join("") }] : [])];
  });
  const runs = turns.map((turn): ReadRun => ({ ...turn.run, input: said(turn, "user_message").join(""), protocol: { ...turn.run.turn, items: turn.items } as ProtocolTurn }));
  return { ...first.head, turns, runs, messages };
}

/**
 * The same read through a Playwright request context (the browser tests read the Gateway the page talks to). Loosely typed, as those tests read the Gateway's JSON: what they
 * look at is `ReadConversation`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readThrough(context: { request: { get(url: string): Promise<{ status(): number; json(): Promise<unknown>; text(): Promise<string> }> } }, origin: string, id: string): Promise<any> {
  return readWhole(async path => { const response = await context.request.get(origin + path); if (response.status() !== 200) throw new Error("GET " + path + " answered " + response.status() + ": " + await response.text()); return response.json(); }, id);
}
