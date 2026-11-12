import {
  CONVERSATION_FORMAT, type Conversation, type ConversationRun, type HeldItem, type ItemFields, type Mutation,
} from "../../src/contracts/conversation.js";
import type { ItemStatus, ItemType } from "../../src/contracts/protocol.js";
import { commandId, messageId, runId, sessionId, switchId, type CommandRecord, type EventDraft, type RunStatus, type SessionId } from "../../src/contracts/session.js";
import { diffConversation, settleConversation, type Applied, type DiffContext } from "../../src/infrastructure/session/diff.js";

/*
 * Builders of conversations as the Runtime would hold them, for the tests of the comparison and of the store of files.
 */

export const SESSION = sessionId("session-rows");
export const NOW = Date.UTC(2026, 10, 12);
export const STAMP = new Date(NOW).toISOString();

/** The bytes of a text. */
export const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export function item(run: ConversationRun | string, seq: number, itemId: string, type: ItemType, status: ItemStatus, fields: Record<string, unknown> = {}, text: readonly string[] = [], extra: Partial<HeldItem> = {}): HeldItem {
  const id = typeof run === "string" ? run : run.id;
  return { runId: runId(id), seq, itemId, type, status, startedAt: null, endedAt: null, parentId: null, createdSeq: null, textBytes: text.reduce((total, chunk) => total + bytes(chunk), 0), textChunks: text.length,
    fields: { type, ...fields } as unknown as ItemFields, text, ...extra };
}
export const userItem = (id: string, text: string, seq = 1): HeldItem => item(id, seq, "user", "user_message", "completed", { messageId: messageId("message-user-" + id) }, [text]);
export const replyItem = (id: string, seq: number, n: number, status: ItemStatus, text: readonly string[]): HeldItem =>
  item(id, seq, "text:" + n, "assistant_message", status, { messageId: messageId("message-reply-" + id), phase: "commentary" }, text);
export const toolItem = (id: string, seq: number, tool: string, status: ItemStatus, fields: Record<string, unknown> = {}): HeldItem =>
  item(id, seq, "tool:" + tool, "command", status, { command: "echo " + tool, ...fields });

export function run(ordinal: number, status: RunStatus, items: readonly HeldItem[] | undefined, extra: Partial<ConversationRun> = {}, prefix = "run"): ConversationRun {
  const id = prefix + "-" + ordinal;
  const done = status === "completed";
  return { id: runId(id), commandId: commandId("command-" + id), userMessageId: messageId("message-user-" + id), assistantMessageId: messageId("message-reply-" + id),
    selection: { harnessId: "alpha", controlId: "alpha-acp" }, epoch: 1, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [],
    backend: done ? { status: "completed", reason: "done" } : null, cleanup: done ? { closed: true, exitCode: 0, signal: null, protocolFailure: null } : null, error: null, stopRequested: false, awaitingSwitchId: null,
    timing: { acceptedAt: NOW + ordinal * 10 }, ordinal, userSeq: 2 + ordinal, isCommand: false, ...(items === undefined ? {} : { items }), ...extra };
}
export const sendCommand = (ordinal: number, prefix = "run"): CommandRecord => ({ id: commandId("command-" + prefix + "-" + ordinal), kind: "send", fingerprint: "f".repeat(64), resultId: prefix + "-" + ordinal });
export const createCommand: CommandRecord = { id: commandId("create-1"), kind: "create", fingerprint: "c".repeat(64), resultId: SESSION };
export const switchCommand = (n: number): CommandRecord => ({ id: commandId("command-switch-" + n), kind: "switch", fingerprint: "s".repeat(64), resultId: "switch-" + n });
export { switchId };

/** A conversation with the runs given (and one send command for each). */
export function conversation(runs: readonly ConversationRun[] = [], extra: Partial<Conversation> = {}): Conversation {
  return { id: SESSION, version: 0, lastSeq: 0, format: CONVERSATION_FORMAT, epoch: 1, status: "open",
    configuration: { workspace: "/work/space", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: false },
    selection: { harnessId: "alpha", controlId: "alpha-acp" }, activeRunId: null, pendingSwitchId: null, runs, switches: [],
    commands: [createCommand, ...runs.map((entry): CommandRecord => ({ id: entry.commandId, kind: "send", fingerprint: "f".repeat(64), resultId: entry.id }))], ...extra };
}
/** `before` with the changes `change` makes, as a reducer would return it: only what it changes is a new object. */
export function reduce(before: Conversation, change: (current: Conversation) => Partial<Conversation>): Conversation { return { ...before, ...change(before) }; }
export function replaceRun(current: Conversation, ordinal: number, change: (run: ConversationRun) => ConversationRun): readonly ConversationRun[] {
  return current.runs.map(entry => entry.ordinal === ordinal ? change(entry) : entry);
}

export const event = (type: string, data: Record<string, unknown> = {}): EventDraft => ({ type, data });
export interface Committed { readonly conversation: Conversation; readonly applied: Applied; readonly mutation: Mutation }
/** One commit's comparison and settlement in memory (the numbers a store would give it put in by hand: the version and the cursor). */
export function commit(before: Conversation | null, after: Conversation, events: readonly EventDraft[], context: Partial<DiffContext> = {}): Committed {
  const mutation = diffConversation(before, after, { events, title: "Hello", updatedAt: NOW, ...context });
  const applied: Applied = { events: [], changes: { ...mutation, head: { row: { ...mutation.head!.row, version: mutation.head!.row.version + 1 } } } };
  return { conversation: settleConversation(after, applied), applied, mutation };
}
export function sessionOf(id: string): SessionId { return sessionId(id); }
