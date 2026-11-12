import type { ItemType } from "../../../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../../../src/contracts/protocol-read.js";
import type { PublicMessage, PublicRun } from "../../../../src/contracts/session.js";
import { textOf, type WindowState, type WindowTurn } from "./window.js";
import { GAP_ID, GAP_TYPE } from "./work.js";

/*
 * The Turns of a window as the page's renderer draws them (web/src/components/ProtocolTurn.tsx): a Run that has its words as `input` and its Turn as `protocol`
 * (`{ ...run, input, protocol: { ...header, items } }`), and the lookup `message(id)` the renderer asks for the words of a message by the id an item names. There are no
 * messages on the wire: a message is an item, and its words are the item's `text`. So that the renderer needs no change, each reply segment of a Turn has an id of its own
 * (the first keeps the Run's `assistantMessageId`, so that the renderer's own search for the reply finds it), and the words of the user's message are under `userMessageId`.
 *
 * Nothing is added here that the Gateway did not say, and nothing is taken away: what the page does not draw is not drawn. The few rules of display that cannot be the
 * Gateway's, because the Gateway's frames are one item at a time and the rule needs the whole Turn, are these, each of which the Gateway's own read of a Turn agrees with:
 *   - a failure the Run also reports as its error (`hh:error`) is told once: the error notices the Harness told as items stand behind it (they are kept in the window);
 *   - a sub-agent the Harness told as a call and as an activity is the call;
 *   - a thinking that said nothing is no line;
 *   - the answer of a completed Turn is the last reply segment found past the notices, the plan, the artifacts and the context events (`phase: "final"`);
 *   - a Turn that goes on and has an approval or a question that waits is `waiting` (its header comes with the Run's row, which does not change when an approval is asked).
 */

const BESIDE_THE_ANSWER: ReadonlySet<ItemType> = new Set<ItemType>(["notice", "error", "plan", "artifact", "context_event"]);

/** The window's Runs, in order, as the renderer draws them, and the lookup of the words of a message. */
export interface Assembled {
  readonly runs: readonly (PublicRun & { readonly ordinal: number; readonly userSeq: number })[];
  /** Every message of the Turns held, in the order of the Turns: your words, then the reply segments. */
  readonly messages: readonly PublicMessage[];
  readonly message: (id: string) => PublicMessage | undefined;
}

function shown(items: readonly ReadItem[]): readonly ReadItem[] {
  const told = items.some(item => item.id === "hh:error");
  const calls = new Set(items.filter(item => item.id.startsWith("tool:")).map(item => item.id.slice(5)));
  return items.filter(item => {
    if (told && item.type === "error" && item.id !== "hh:error") return false;
    if (item.type === "subagent" && item.id.startsWith("activity:")) { const id = item.id.slice(9); if (calls.has(id) || calls.has("agent:" + id.slice(0, 200))) return false; }
    if (item.type === "reasoning" && item.text === "" && item.bodyOmitted !== true && (item.textBytes ?? 0) === 0) return false;
    return true;
  });
}
/** The place of the answer of a Turn that completed: the last item that is not beside the answer, when it is a reply segment. */
function answerOf(items: readonly ReadItem[]): number | null {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!;
    if (BESIDE_THE_ANSWER.has(item.type as ItemType)) continue;
    return item.type === "assistant_message" ? item.seq : null;
  }
  return null;
}

type DrawnRun = PublicRun & { readonly ordinal: number; readonly userSeq: number };
interface Drawn { readonly run: DrawnRun; readonly messages: readonly PublicMessage[] }
/** A Turn drawn once: a Turn the state did not change (the same object) is the same drawing, so that what the renderer keeps for an unchanged Turn (it compares what it is given) is kept. */
const drawings = new WeakMap<WindowTurn, Drawn>();

/** The place in a Turn's items where a window left out the middle of a long stretch of work: not an item of the conversation but a line that reads the rest (`GAP` in work.ts). */
function gapIn(items: readonly ReadItem[], gap: NonNullable<WindowTurn["deferred"]>, ordinal: number): readonly ReadItem[] {
  const at = items.findIndex(item => item.seq > gap.toSeq), line = { id: GAP_ID, seq: gap.fromSeq, status: "completed", type: GAP_TYPE, count: gap.count, fromSeq: gap.fromSeq, toSeq: gap.toSeq, ordinal } as unknown as ReadItem;
  return at < 0 ? [...items, line] : [...items.slice(0, at), line, ...items.slice(at)];
}

function draw(turn: WindowTurn): Drawn {
  const kept = drawings.get(turn);
  if (kept !== undefined) return kept;
  const messages: PublicMessage[] = [];
  const { turn: header, protocolProblem, ...run } = turn.run, items = shown(turn.items.map(entry => entry.item));
  const answer = run.status === "completed" && !items.some(item => item.type === "assistant_message" && item.phase === "final") ? answerOf(items) : null;
  const taken = new Set<string>();
  let input = "";
  const placed = turn.deferred === undefined ? items : gapIn(items, turn.deferred, run.ordinal);
  const drawn = placed.map((item): ReadItem => {
    if (item.type === "user_message") {
      input += textOf(item) ?? "";
      if (!taken.has(item.messageId)) { taken.add(item.messageId); messages.push({ id: item.messageId, runId: run.id, role: "user", text: textOf(item) ?? "", seq: run.userSeq, status: run.status }); }
      return item;
    }
    if (item.type !== "assistant_message") return item;
    // The first segment is the Run's reply message; the others have an id of their own, from the place they stand in.
    const id = taken.has(item.messageId) ? item.messageId + "~" + item.seq : item.messageId;
    taken.add(id);
    messages.push({ id: id as PublicMessage["id"], runId: run.id, role: "assistant", text: textOf(item) ?? "", seq: run.userSeq, status: run.status });
    return { ...item, messageId: id as typeof item.messageId, ...(item.seq === answer ? { phase: "final" as const } : {}) };
  });
  const base = { ...run, input };
  let result: DrawnRun;
  if (header === undefined) result = { ...base, protocolProblem: protocolProblem ?? "服务没有给出这一轮的协议数据" };
  else {
    const waiting = header.status === "running" && drawn.some(item => item.status === "waiting");
    const protocol: ReadTurn = { ...header, ...(waiting ? { status: "waiting" as const } : {}), items: drawn };
    result = { ...base, protocol };
  }
  const made = { run: result, messages };
  drawings.set(turn, made);
  return made;
}

/** The Turns held, as the renderer draws them. */
export function assemble(state: WindowState): Assembled {
  const made = state.turns.map(draw), messages = made.flatMap(entry => entry.messages);
  const byId = new Map(messages.map(message => [message.id as string, message]));
  return { runs: made.map(entry => entry.run), messages, message: id => byId.get(id) };
}
