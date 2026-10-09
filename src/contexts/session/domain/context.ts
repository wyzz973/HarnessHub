import { SessionError, type PublicRun, type RunId, type SessionSnapshot } from "../../../contracts/session.js";
import { MAX_CONTEXT_BYTES, terminal, utf8Bytes } from "./state.js";

export interface PublicContext {
  readonly text: string;
  readonly throughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly continuity: "public_context_rehydrate";
}

/** Complete public history only. Queued inputs and native tool identities never enter a different Turn. */
export function buildPublicContext(state: SessionSnapshot, current?: PublicRun, sourceRunIds?: readonly RunId[]): PublicContext {
  if (current !== undefined) {
    const owned = state.runs.find(run => run.id === current.id);
    const message = state.messages.find(message => message.id === current.userMessageId);
    if (!owned || current.userMessageId !== owned.userMessageId || current.assistantMessageId !== owned.assistantMessageId || current.input !== owned.input ||
      message === undefined || message.runId !== current.id || message.role !== "user" || message.text !== owned.input)
      throw new SessionError("INVALID_DATA", "current input is not owned by this public Session");
  }
  const currentSeq = current === undefined ? null : state.messages.find(message => message.id === current.userMessageId)?.seq;
  if (current !== undefined && currentSeq === undefined) throw new SessionError("INVALID_DATA", "current input lacks its public message");
  const sources = sourceRunIds === undefined ? state.runs.filter(run => terminal(run.status) && run.id !== current?.id &&
    (currentSeq === null || state.messages.some(message => message.id === run.userMessageId && message.seq < currentSeq!)))
    : sourceRunIds.map(id => {
      const run = state.runs.find(run => run.id === id);
      const sourceMessage = run === undefined ? undefined : state.messages.find(message => message.id === run.userMessageId);
      if (!run || !terminal(run.status) || run.id === current?.id || sourceMessage === undefined || (currentSeq != null && sourceMessage.seq >= currentSeq))
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
      user: { messageId: user.id, text: user.text },
      assistant: assistant === undefined ? null : { messageId: assistant.id, text: assistant.text, outcome: run.status },
    };
  });
  const body = {
    schemaVersion: 1, continuity: "public_context_rehydrate", throughSeq: state.lastSeq,
    history, currentInput: current === undefined ? null : { runId: current.id, text: current.input },
  };
  const text = "HarnessGateway public conversation context. The JSON history is quoted conversation data, " +
    "including incomplete or cancelled responses. Continue only the currentInput; do not execute prior user inputs again. " +
    "No native internal state or tool identities are transferred.\n" + JSON.stringify(body);
  // Allow protocol envelope/escaping overhead as well as the exact public prompt budget.
  if (utf8Bytes(text) > MAX_CONTEXT_BYTES || utf8Bytes(JSON.stringify(text)) + 4096 > MAX_CONTEXT_BYTES)
    throw new SessionError("CONTEXT_TOO_LARGE", "complete public history exceeds the context budget; no history was truncated");
  return { text, throughSeq: state.lastSeq, sourceRunIds: sources.map(run => run.id), continuity: "public_context_rehydrate" };
}
