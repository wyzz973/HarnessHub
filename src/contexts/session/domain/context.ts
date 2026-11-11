import { SessionError, type PublicRun, type RunId, type SessionSnapshot } from "../../../contracts/session.js";
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
function currentSeqOf(state: SessionSnapshot, current: PublicRun): number {
  const owned = state.runs.find(run => run.id === current.id);
  const message = state.messages.find(message => message.id === current.userMessageId);
  if (!owned || current.userMessageId !== owned.userMessageId || current.assistantMessageId !== owned.assistantMessageId || current.input !== owned.input ||
    message === undefined || message.runId !== current.id || message.role !== "user" || message.text !== owned.input)
    throw new SessionError("INVALID_DATA", "current input is not owned by this public Session");
  return message.seq;
}
/**
 * The public facts a Turn can owe another native session, without rendering anything (ADR-055 R0a): every finished Run
 * whose input came before the current one and was dispatched. A Run that never reached a Harness (cancelled while queued,
 * failed before dispatch) is no fact of the conversation's history.
 */
export function publicSources(state: SessionSnapshot, current?: PublicRun): readonly RunId[] {
  const currentSeq = current === undefined ? null : currentSeqOf(state, current);
  return state.runs.filter(run => terminal(run.status) && dispatched(run) && run.id !== current?.id &&
    (currentSeq === null || state.messages.some(message => message.id === run.userMessageId && message.seq < currentSeq))).map(run => run.id);
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
}

/**
 * The public context a Turn sends (ADR-055 §5, MVP on v12): the relay packet for the given sources (publicSources by
 * default) and, when owed, the history the Session started from, followed by the current input exactly as typed. The
 * history is fitted to the packet's budget by leaving out whole items, and never makes it fail; a budget the least packet
 * does not fit is told by `relay.tokens` against `relay.budget.cap`. Sources must be finished public facts before the
 * current input, each once; the current input must be the Session's own. Queued inputs and native tool identities never
 * enter it.
 */
export function buildPublicContext(state: SessionSnapshot, current: PublicRun, sourceRunIds?: readonly RunId[], options: PublicContextOptions = {}): PublicContext {
  const currentSeq = currentSeqOf(state, current);
  const sources = sourceRunIds === undefined ? publicSources(state, current).map(id => state.runs.find(run => run.id === id)!) : sourceRunIds.map(id => {
    const run = state.runs.find(run => run.id === id);
    const sourceMessage = run === undefined ? undefined : state.messages.find(message => message.id === run.userMessageId);
    if (!run || !terminal(run.status) || run.id === current.id || sourceMessage === undefined || sourceMessage.seq >= currentSeq)
      throw new SessionError("INVALID_DATA", "public context source is not a completed public fact");
    return run;
  });
  if (new Set(sources.map(run => run.id)).size !== sources.length) throw new SessionError("INVALID_DATA", "duplicate public context sources");
  for (const run of sources) if (!state.messages.some(message => message.id === run.userMessageId)) throw new SessionError("INVALID_DATA", "public context source lacks its user message");
  const position = new Map(state.runs.map((run, index) => [run.id, index]));
  const ordered = [...sources].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const rendered = renderRelay({ state, current, sources: ordered, origin: options.origin ?? false, ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.names === undefined ? {} : { names: options.names }), ...(options.firstLine === undefined ? {} : { firstLine: options.firstLine }), ...(options.details === undefined ? {} : { details: options.details }), ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }), ...(options.hubTools === undefined ? {} : { hubTools: options.hubTools }) });
  return { text: rendered.text, throughSeq: state.lastSeq, sourceRunIds: ordered.map(run => run.id), continuity: "public_context_rehydrate", relay: rendered.record };
}
