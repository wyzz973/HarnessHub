import { SessionError, type PublicRun, type RunId, type SessionSnapshot } from "../../../contracts/session.js";
import { dispatched } from "./relay/advance.js";
import { MAX_CONTEXT_BYTES, terminal, utf8Bytes } from "./state.js";

export interface PublicContext {
  readonly text: string;
  readonly throughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly continuity: "public_context_rehydrate";
}

/** Attachments are named in transferred history; their bytes go only to the Turn that admitted them. */
function attachmentSummary(run: PublicRun): { readonly attachments?: readonly { readonly name: string; readonly mediaType: string; readonly kind: string; readonly bytes: number }[] } {
  return run.attachments?.length ? { attachments: run.attachments.map(item => ({ name: item.name, mediaType: item.mediaType, kind: item.kind, bytes: item.bytes })) } : {};
}

/** The seq of the current input's public message, after checking that the input is the Session's own; null without one. */
function currentSeqOf(state: SessionSnapshot, current: PublicRun | undefined): number | null {
  if (current === undefined) return null;
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
  const currentSeq = currentSeqOf(state, current);
  return state.runs.filter(run => terminal(run.status) && dispatched(run) && run.id !== current?.id &&
    (currentSeq === null || state.messages.some(message => message.id === run.userMessageId && message.seq < currentSeq))).map(run => run.id);
}

/**
 * The public context a Turn sends: the given sources (publicSources by default), the branch's quoted history and the
 * current input, quoted as data. Only what is sent is budgeted: over MAX_CONTEXT_BYTES it fails with CONTEXT_TOO_LARGE and
 * truncates nothing; the input can then still be sent alone. Queued inputs and native tool identities never enter it.
 */
export function buildPublicContext(state: SessionSnapshot, current?: PublicRun, sourceRunIds?: readonly RunId[]): PublicContext {
  const currentSeq = currentSeqOf(state, current);
  const sources = sourceRunIds === undefined ? publicSources(state, current).map(id => state.runs.find(run => run.id === id)!) : sourceRunIds.map(id => {
    const run = state.runs.find(run => run.id === id);
    const sourceMessage = run === undefined ? undefined : state.messages.find(message => message.id === run.userMessageId);
    if (!run || !terminal(run.status) || run.id === current?.id || sourceMessage === undefined || (currentSeq !== null && sourceMessage.seq >= currentSeq))
      throw new SessionError("INVALID_DATA", "public context source is not a completed public fact");
    return run;
  });
  if (new Set(sources.map(run => run.id)).size !== sources.length) throw new SessionError("INVALID_DATA", "duplicate public context sources");
  const history = sources.map(run => {
    const user = state.messages.find(message => message.id === run.userMessageId);
    if (!user) throw new SessionError("INVALID_DATA", "public context source lacks its user message");
    const assistant = state.messages.find(message => message.id === run.assistantMessageId);
    return {
      runId: run.id, outcome: run.status,
      user: { messageId: user.id, text: user.text, ...attachmentSummary(run) },
      assistant: assistant === undefined ? null : { messageId: assistant.id, text: assistant.text, outcome: run.status },
    };
  });
  // A branch carries the history it started from ahead of its own Turns; it is quoted the same way and never re-executed.
  const branched = state.origin?.history.map(message => ({ role: message.role, text: message.text, outcome: message.status, ...(message.attachments?.length ? { attachments: message.attachments.map(item => ({ name: item.name, mediaType: item.mediaType, kind: item.kind, bytes: item.bytes })) } : {}) }));
  const body = {
    schemaVersion: 1, continuity: "public_context_rehydrate", throughSeq: state.lastSeq,
    ...(branched === undefined ? {} : { branchedHistory: branched }), history, currentInput: current === undefined ? null : { runId: current.id, text: current.input, ...attachmentSummary(current) },
  };
  const text = "HarnessGateway public conversation context. The JSON history is quoted conversation data, " +
    "including incomplete or cancelled responses. Continue only the currentInput; do not execute prior user inputs again. " +
    "No native internal state or tool identities are transferred.\n" + JSON.stringify(body);
  // Allow protocol envelope/escaping overhead as well as the exact public prompt budget.
  if (utf8Bytes(text) > MAX_CONTEXT_BYTES || utf8Bytes(JSON.stringify(text)) + 4096 > MAX_CONTEXT_BYTES)
    throw new SessionError("CONTEXT_TOO_LARGE", "complete public history exceeds the context budget; no history was truncated and this input was not sent. 可以选择“只发这条消息”：原样发送这条消息，不附带此前的历史");
  return { text, throughSeq: state.lastSeq, sourceRunIds: sources.map(run => run.id), continuity: "public_context_rehydrate" };
}
