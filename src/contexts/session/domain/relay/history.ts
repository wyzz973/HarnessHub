import type { Conversation, ConversationReader } from "../../../../contracts/conversation.js";
import type { NativeSessionBinding, PublicRun, SessionId, SessionOrigin, SessionSnapshot } from "../../../../contracts/session.js";
import { originFromRows } from "../store-conversion.js";
import { snapshotTurns, turnSource, type TurnRecord } from "../turn-source.js";

/*
 * What the relay's renderer reads of a conversation (ADR-057 3.3, readers): the Runs without their words, which are light and all there; the native bindings; the history the conversation started
 * from; and the words of one Turn when one is asked for — its user's words, its reply, its tool calls — read from the rows then and not before. A packet is made of the Turns a binding is owed, so
 * a packet reads those and no others; nothing reads the conversation whole.
 */

/** A Run as the renderer's first look sees it: everything a Run is but its words and lists; `userSeq` places the user's message among the events (the place the old shape gave it as its message's seq). */
export type RelayRun = Omit<PublicRun, "thinking" | "tools" | "plan" | "notices" | "activities" | "outputs" | "protocol" | "input"> & { readonly userSeq?: number };
export interface RelayHistory {
  readonly id: SessionId;
  readonly lastSeq: number;
  /** In conversation order: the index of a Run is its ordinal. */
  readonly runs: readonly RelayRun[];
  readonly nativeBindings?: readonly NativeSessionBinding[];
  /** The history the conversation started from (a branch's quote, an import's messages); absent for none. */
  readonly origin?: SessionOrigin | undefined;
  /** The Turn at an ordinal, with its words; null when there is none. A Turn is read once. */
  turn(ordinal: number): TurnRecord | null;
}

/** A conversation in the old whole shape as the renderer reads it: for a caller that has the snapshot already (the tests of the renderer, until the last of them reads rows). */
export function snapshotHistory(state: SessionSnapshot): RelayHistory {
  const places = new Map(state.messages.map(message => [message.id as string, message.seq])), turns = snapshotTurns(state);
  return { id: state.id, lastSeq: state.lastSeq, runs: state.runs.map(run => places.has(run.userMessageId) ? { ...run, userSeq: places.get(run.userMessageId)! } : run),
    ...(state.nativeBindings === undefined ? {} : { nativeBindings: state.nativeBindings }), ...(state.origin === undefined ? {} : { origin: state.origin }), turn: ordinal => turns.turn(ordinal) };
}
/** What the renderer takes of a conversation: the history as it reads it, or the old whole shape of one. */
export type RelayState = RelayHistory | SessionSnapshot;
export function historyOf(state: RelayState): RelayHistory { return "turn" in state ? state : snapshotHistory(state); }

/** A conversation kept as rows, as the renderer reads it: the light rows of its Runs now, its Turns when asked for, the history it quoted when a packet owes it. */
export function rowsHistory(conversation: Conversation, reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory">): RelayHistory {
  const turns = turnSource(reader, conversation.id);
  let origin: SessionOrigin | null | undefined;
  return {
    id: conversation.id, lastSeq: conversation.lastSeq, runs: conversation.runs, ...(conversation.nativeBindings === undefined ? {} : { nativeBindings: conversation.nativeBindings }),
    get origin(): SessionOrigin | undefined {
      if (conversation.origin === undefined) return undefined;
      origin ??= originFromRows(conversation.origin, reader.originHistory?.(conversation.id) ?? []);
      return origin ?? undefined;
    },
    turn: ordinal => turns.turn(ordinal),
  };
}
