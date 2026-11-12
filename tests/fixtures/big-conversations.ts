import type { Conversation } from "../../src/contracts/conversation.js";
import type { SessionId } from "../../src/contracts/session.js";
import type { FileConversationStore } from "../../src/infrastructure/session/file-store.js";
import { event, item } from "./conversation-builder.js";
import { Scenario, created, newConversation } from "./store-helpers.js";

/*
 * Conversations of the size the page and the routes are held to (ADR-057 3.4), written through the store's own writes before a Gateway opens the data root: one of thousands of
 * Turns, and one whose reply is 20 MiB. The tests of the routes over HTTP and of the page in a browser read the same ones.
 */

/** Who the conversations ran on: a Harness the Gateway the test starts knows, with the configuration that Gateway was opened with (a Turn sent to one is run by that Harness). */
export interface Home { readonly selection: { readonly harnessId: string; readonly controlId: string }; readonly configuration: Conversation["configuration"] }
/** An empty conversation at home. */
export const makeConversation = (store: FileConversationStore, home: Home, name: string): SessionId =>
  created(store, newConversation(home.configuration.workspace, name, { selection: home.selection, configuration: home.configuration })).conversation.id;

/** A long text of mixed scripts, in windows of 16 KiB: the kind that can be cut in the middle of a character by a range that does not know. */
export function longText(windows: number): string[] {
  const pieces = ["The quick brown fox jumps over the lazy dog. ", "迁移保真校验与接力水位，", "😀🚀 ", "naïve café ", "日本語のテキスト。", "𝒳𝒴𝒵 ", "\n"];
  let at = 0;
  return Array.from({ length: windows }, () => { let chunk = ""; while (Buffer.byteLength(chunk, "utf8") < 16 * 1024) chunk += pieces[at++ % pieces.length]!; return chunk; });
}
/** One more item at the end of a running Turn. */
export function addItem(store: FileConversationStore, id: SessionId, ordinal: number, make: (seq: number, runId: string) => ReturnType<typeof item>): void {
  store.transact(id, store.get(id).version, current => ({ next: { ...current, runs: current.runs.map(entry => entry.ordinal === ordinal
    ? { ...entry, items: [...(entry.items ?? []), make(Math.max(0, ...(entry.items ?? []).map(held => held.seq)) + 1, entry.id)] } : entry) }, events: [event("run.output", { runId: "x" })] }));
}
/** `count` Turns that each said something: "question n", answered "answer n". */
export function seedTurns(store: FileConversationStore, home: Home, name: string, count: number): SessionId {
  const id = makeConversation(store, home, name), scenario = new Scenario(store, id, "run-" + name, false);
  for (let n = 0; n < count; n++) scenario.turn("question " + n, "answer " + n, { selection: home.selection });
  return id;
}
/** One Turn, "write a lot", answered with a reply of 20 MiB (1,280 windows of 16 KiB); the reply is returned with the conversation. */
export function seedReply(store: FileConversationStore, home: Home, name: string): { readonly id: SessionId; readonly reply: Buffer } {
  const id = makeConversation(store, home, name), scenario = new Scenario(store, id, "run-" + name, false), windows = longText(1280);
  const accepted = scenario.accept("write a lot", { selection: home.selection }); scenario.start(accepted.ordinal);
  addItem(store, id, 0, (seq, runId) => item(runId, seq, "text:1", "assistant_message", "completed", { messageId: "message-reply-" + runId }, windows));
  scenario.finish(0);
  return { id, reply: Buffer.from(windows.join(""), "utf8") };
}
