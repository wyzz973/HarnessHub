import { SessionError, type PublicRun, type RunId } from "../../../contracts/session.js";
import { outlineOf, type RelayHistory, type RelayRun } from "./relay/history.js";
import { dispatched } from "./relay/advance.js";
import type { RelayToolDetail } from "./relay/narration.js";
import { renderRelay, type RelayRecord } from "./relay/packet.js";
import type { RelayBudget } from "./relay/budget.js";
import { terminal } from "./state.js";

export interface PublicContext {
  /** What the Turn hands to its Harness: the relay packet, LF, and the user's current words exactly as typed. */
  readonly text: string;
  readonly throughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly continuity: "public_context_rehydrate";
  /** What `run.context_prepared` records of the packet (no text). */
  readonly relay: RelayRecord;
}

/** The seq of the current input's public message, after checking that the input is the Session's own. */
function currentSeqOf(state: RelayHistory, current: PublicRun): number {
  const at = state.runs.findIndex(run => run.id === current.id), owned = state.runs[at], turn = at < 0 ? null : state.turn(at);
  if (!owned || current.userMessageId !== owned.userMessageId || current.assistantMessageId !== owned.assistantMessageId || turn === null || current.input !== turn.run.input ||
    owned.userSeq === undefined || turn.user.runId !== current.id || turn.user.role !== "user" || turn.user.text !== turn.run.input)
    throw new SessionError("INVALID_DATA", "current input is not owned by this public Session");
  return owned.userSeq;
}
/**
 * The public facts a Turn can owe another native session, without rendering anything (ADR-055 R0a): every finished Run
 * whose input came before the current one and was dispatched. A Run that never reached a Harness (cancelled while queued,
 * failed before dispatch) is no fact of the conversation's history.
 */
export function publicSources(state: RelayHistory, current?: PublicRun): readonly RunId[] {
  const currentSeq = current === undefined ? null : currentSeqOf(state, current);
  return state.runs.filter(run => terminal(run.status) && dispatched(run) && run.id !== current?.id &&
    (currentSeq === null || (run.userSeq !== undefined && run.userSeq < currentSeq))).map(run => run.id);
}

/** What the relay packet takes beyond the snapshot (relay/packet.ts): what is owed, secrets, names, the first line, details. */
export interface PublicContextOptions {
  /** Whether the history this Session started from (a branch's or an import's) is owed too; false unless given. */
  readonly origin?: boolean;
  readonly secrets?: readonly string[];
  readonly names?: (harnessId: string) => string | null;
  readonly firstLine?: boolean;
  readonly details?: ReadonlyMap<string, RelayToolDetail>;
  /**
   * The budget the packet is folded to, when the relay coordinator resolved it (G072: the window of windows.ts and the hard cap
   * of the target's channel); the renderer's own (the target's last reported window, or the assumed one) otherwise.
   */
  readonly budget?: RelayBudget;
  /**
   * Part of the packet may be in the target's native history already (an automatic resend, a packet sent again for newer facts,
   * everything again after a rewind, the user's own attach to a session that holds a part): the renderer says so at the head of
   * the packet, so the target does not take it for new work.
   */
  readonly repeat?: boolean;
  /** The target has the Hub's tools this Turn (PreparedSessionBinding.hubTools): the packet then says how to read the rest back and notes the outputs it does not carry. False unless given. */
  readonly hubTools?: boolean;
  /** The conversation's Hub command, when the target has the tools as a command (PreparedSessionBinding.hubCommand). */
  readonly hubCommand?: string;
}

/**
 * The public context a Turn sends (ADR-055 §5, MVP on v12): the relay packet for the given sources (publicSources by
 * default) and, when owed, the history the Session started from, followed by the current input exactly as typed. The
 * history is fitted to the packet's budget by leaving out whole items, and never makes it fail; a budget the least packet
 * does not fit is told by `relay.tokens` against `relay.budget.cap`. Sources must be finished public facts before the
 * current input, each once; the current input must be the Session's own. Queued inputs and native tool identities never
 * enter it.
 */
export function buildPublicContext(state: RelayHistory, current: PublicRun, sourceRunIds?: readonly RunId[], options: PublicContextOptions = {}): PublicContext {
  const currentSeq = currentSeqOf(state, current), position = new Map(state.runs.map((run, index) => [run.id, index]));
  // A source is its light row: the Turn itself (its calls, its words) is read only when the packet's choice reaches it, and an older one it does not reach is counted by what its end
  // recorded (relay/narration.ts, packet.ts). A source the history holds no Turn for is no fact.
  const sourceOf = (id: RunId): RelayRun => {
    const at = position.get(id), light = at === undefined ? undefined : state.runs[at];
    if (!light || !terminal(light.status) || light.id === current.id || light.userSeq === undefined || light.userSeq >= currentSeq || (state.counts?.(at!) === null && outlineOf(state, at!) === null))
      throw new SessionError("INVALID_DATA", "public context source is not a completed public fact");
    return light;
  };
  const sources = (sourceRunIds === undefined ? publicSources(state, current) : sourceRunIds).map(sourceOf);
  if (new Set(sources.map(run => run.id)).size !== sources.length) throw new SessionError("INVALID_DATA", "duplicate public context sources");
  const ordered = [...sources].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const rendered = renderRelay({ state, current, sources: ordered, origin: options.origin ?? false, ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.names === undefined ? {} : { names: options.names }), ...(options.firstLine === undefined ? {} : { firstLine: options.firstLine }), ...(options.details === undefined ? {} : { details: options.details }), ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }), ...(options.hubTools === undefined ? {} : { hubTools: options.hubTools }), ...(options.hubCommand === undefined ? {} : { hubCommand: options.hubCommand }) });
  return { text: rendered.text, throughSeq: state.lastSeq, sourceRunIds: ordered.map(run => run.id), continuity: "public_context_rehydrate", relay: rendered.record };
}
