import type { PublicMessage, PublicRun } from "../../../src/contracts/session.js";
import type { SessionHeadView } from "../../../src/contracts/web.js";
import { assemble } from "./protocol/assemble.js";
import type { WindowState } from "./protocol/window.js";

/*
 * The conversation as the page's components read it (ADR-057 3.4). The page holds a WINDOW of the conversation (web/src/lib/protocol/window.ts): its head and the Turns from the newest back as
 * far as the reader has gone. The components were written for a conversation that is whole (`session.runs`, `session.messages`), and what they read of the window is the same shape:
 * `runs` are the Turns held, each drawn as the renderer draws a Run (`assemble`), `messages` the words they hold. What a component used to learn by looking at every Turn it no longer can, and
 * it is told by the head instead (`facts`: the Turns whose result is unknown, whether every Turn is over, where a branch can start, the changes of the whole conversation).
 * Made once for each state, so that a component that compares what it is given sees the same object until the conversation changes.
 */

/** A Run as the renderer draws it, with its place in the conversation. */
export type TurnRun = PublicRun & { readonly ordinal: number; readonly userSeq: number };
export interface ConversationView extends SessionHeadView {
  /** The Turns held, oldest first. Not the conversation's: `runCount` is how many it has. */
  readonly runs: readonly TurnRun[];
  /** What was said in them, in order. */
  readonly messages: readonly PublicMessage[];
  /** The state this was made from: the older Turns, the items still to be read. */
  readonly window: WindowState;
}

const made = new WeakMap<WindowState, ConversationView>();
export function conversationOf(state: WindowState): ConversationView {
  const kept = made.get(state);
  if (kept !== undefined) return kept;
  const drawn = assemble(state), view: ConversationView = { ...state.head, runs: drawn.runs, messages: drawn.messages, window: state };
  made.set(state, view);
  return view;
}
/** Whether the Turns held are the whole conversation: nothing older is left to read. */
export const holdsFirst = (view: ConversationView): boolean => view.window.older === null;
