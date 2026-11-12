import { createHash } from "node:crypto";
import { parseSession } from "../../src/infrastructure/session/legacy/state.js";
import { loadV13Fixture, type V13Event, type V13Fixture, type V13Session } from "./storage/v13/database.js";

/**
 * Large v13 conversations, made to measure the migration (ADR-057 3.6, T4): each is a conversation the v13 runtime could have written at its limits (256 Runs, under
 * 8 MiB of snapshot), shaped from the frozen `switches` fixture's Run (its timing, backend, relay and binding facts) with a long reply, a thinking text and a list
 * of tool calls (each with a content reference of its own) on every Run. The snapshot passes the frozen parse; its event log is whole; the ids are the same for the
 * same arguments, so two builds of the same database are the same database.
 */

interface Template { readonly run: Record<string, unknown>; readonly snapshot: Record<string, unknown>; readonly user: Record<string, unknown>; readonly assistant: Record<string, unknown> }
let template: Template | undefined;
function templateOf(): Template {
  if (template !== undefined) return template;
  const snapshot = loadV13Fixture("switches").sessions[0]!.snapshot as Record<string, unknown> & { runs: Record<string, unknown>[]; messages: Record<string, unknown>[] };
  const run = snapshot.runs[0]!, user = snapshot.messages.find(message => message.id === run.userMessageId)!, assistant = snapshot.messages.find(message => message.id === run.assistantMessageId)!;
  template = { run, snapshot, user, assistant };
  return template;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const SENTENCES = ["The quick brown fox jumps over the lazy dog; every Turn keeps what was said. ", "再长的对话也要原样搬进新的表里，一个字都不能少。 ", "Tool output, reasoning and replies are separate rows now. ", "リストとコードブロックも、そのまま。 "];
/** A text of about `bytes` bytes (a whole number of sentences, so it never ends in half a character), different for each `key`. */
export function prose(key: string, bytes: number): string {
  let text = "[" + key + "] ", at = Number.parseInt(digest(key).slice(0, 4), 16);
  while (Buffer.byteLength(text, "utf8") < bytes) text += SENTENCES[at++ % SENTENCES.length]!;
  return text;
}
export interface SyntheticOptions {
  /** How many Runs the conversation has (the v13 runtime allowed 256). */
  readonly runs: number;
  /** The size of each reply in bytes, and of each Run's thinking. */
  readonly replyBytes: number;
  readonly thinkingBytes?: number;
  /** How many tool calls each Run has (each with a content reference). */
  readonly tools?: number;
}
/** One conversation: its row for a v13 database. */
export function syntheticSession(index: number, options: SyntheticOptions): V13Session {
  const { run: base, snapshot: sample, user: userBase, assistant: assistantBase } = templateOf(), id = "session-syn-" + index;
  const runs: Record<string, unknown>[] = [], messages: Record<string, unknown>[] = [], events: V13Event[] = [], commands: Record<string, unknown>[] = [];
  const stamp = (seq: number): string => new Date(Date.UTC(2026, 10, 1) + seq * 1000).toISOString();
  const event = (type: string, data: Record<string, unknown>): void => { const seq = events.length + 1; events.push({ type, data, sessionId: id, seq, ownerGeneration: 1, timestamp: stamp(seq) }); };
  event("session.created", { selection: base.selection, continuity: "public_context_rehydrate" });
  commands.push({ id: "syn-" + index + "-create", kind: "create", fingerprint: digest("create-" + index), resultId: id });
  for (let at = 0; at < options.runs; at++) {
    const runId = "run-syn-" + index + "-" + at, userId = "message-syn-" + index + "-" + at + "-u", assistantId = "message-syn-" + index + "-" + at + "-a", commandId = "syn-" + index + "-send-" + at;
    const input = prose("question " + index + "/" + at, 160);
    event("message.accepted", { runId, messageId: userId, role: "user", text: input });
    const accepted = events.length;
    const tools = Array.from({ length: options.tools ?? 0 }, (_, tool) => {
      const hash = digest("tool-" + index + "-" + at + "-" + tool);
      return { id: "Bash:" + tool, title: "command " + tool + " of Turn " + at, status: "completed", kind: "execute", name: "Bash", exitCode: 0,
        detail: { id: "content-" + hash.slice(0, 32), name: "tool-Bash_" + tool + ".json", mediaType: "application/json", kind: "file", bytes: 120 + tool, sha256: hash } };
    });
    event("run.ended", { runId, status: "completed", backend: base.backend, cleanup: base.cleanup, error: null, input: "recorded" });
    const ended = events.length;
    runs.push({ ...base, id: runId, commandId, input, userMessageId: userId, assistantMessageId: assistantId, contextThroughSeq: accepted, sourceRunIds: [],
      ...(options.thinkingBytes === undefined ? {} : { thinking: prose("thinking " + index + "/" + at, options.thinkingBytes) }), ...(tools.length === 0 ? {} : { tools }) });
    messages.push({ ...userBase, id: userId, runId, text: input, seq: accepted }, { ...assistantBase, id: assistantId, runId, text: prose("reply " + index + "/" + at, options.replyBytes), seq: ended });
    commands.push({ id: commandId, kind: "send", fingerprint: digest("send-" + index + "-" + at), resultId: runId });
  }
  const last = runs.at(-1);
  const snapshot = { ...sample, id, version: events.length, lastSeq: events.length, epoch: 1, status: "open", activeRunId: null, pendingSwitchId: null, runs, messages, switches: [], commands,
    nativeBindings: last === undefined ? [] : [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-syn-" + index, throughRunId: last.id, status: "ready", observed: { model: "model-a", options: {} },
      relay: { epoch: 1, mark: events.length, floor: -1, pending: null, resendAll: false } }] };
  // Held to the frozen parse and to the old size limit here, so a fixture that stops being one the v13 runtime could write is found at once.
  parseSession(JSON.parse(JSON.stringify(snapshot)));
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 8 * 1024 * 1024) throw new Error("the synthetic conversation is over the old 8 MiB limit");
  return { id, version: events.length, lastSeq: events.length, snapshot, events };
}
/** A fixture of `count` such conversations, for `writeV13Root`. */
export function syntheticFixture(count: number, options: SyntheticOptions): V13Fixture {
  return { fixture: "synthetic", describe: "large synthetic v13 conversations", userVersion: 13, ownerGeneration: 1, unfinished: false, sessions: Array.from({ length: count }, (_, index) => syntheticSession(index, options)),
    createKeys: [], relay: { bodies: [], packets: [], deliveries: [], index: [], log: [], prefs: [] }, contents: {}, contentReferences: [] };
}
