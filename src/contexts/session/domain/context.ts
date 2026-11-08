import { SessionError, type PublicRun, type RunId, type SessionSnapshot } from "../../../contracts/session.js";
import { dispatched } from "./relay/advance.js";
import type { RelayToolDetail } from "./relay/narration.js";
import { renderRelay, type RelayRecord } from "./relay/packet.js";
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
}

/**
 * The public context a Turn sends (ADR-055 §5, MVP on v12): the relay packet for the given sources (publicSources by
 * default) and, when owed, the history the Session started from, followed by the current input exactly as typed. The
 * history is folded to the packet's budget and never makes it fail; CONTEXT_TOO_LARGE only when the frame and the
 * current input alone exceed what one message can carry. Sources must be finished public facts before the current input,
 * each once; the current input must be the Session's own. Queued inputs and native tool identities never enter it.
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
    ...(options.names === undefined ? {} : { names: options.names }), ...(options.firstLine === undefined ? {} : { firstLine: options.firstLine }), ...(options.details === undefined ? {} : { details: options.details }) });
  return { text: rendered.text, throughSeq: state.lastSeq, sourceRunIds: ordered.map(run => run.id), continuity: "public_context_rehydrate", relay: rendered.record };
}
