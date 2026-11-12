import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CONVERSATION_FORMAT, type Conversation, type ConversationCommit, type ConversationRun, type HeldItem, type OriginHistoryRow, type RecoverConversation,
} from "../../src/contracts/conversation.js";
import { SessionError, commandId, sessionId, switchId, type CommandRecord, type EventDraft, type SessionId } from "../../src/contracts/session.js";
import { verify, verifyTransition } from "../../src/contexts/session/domain/conversation-verify.js";
import { FileConversationStore, type FileConversationStoreOptions } from "../../src/infrastructure/session/file-store.js";
import { NOW, event, item, replyItem, run, toolItem, userItem } from "./conversation-builder.js";

/*
 * What the tests of the store of conversations share: temporary data roots that are removed after the test, a store opened on one, a way to build a conversation with a
 * name of its own and to drive Turns through the real store (accept, start, say, finish: the commits a Runtime makes, with a Harness and a model made up), and a small
 * recovery of the kind the domain injects. The files are real; nothing here fakes the store.
 */

export interface Opened { readonly root: string; readonly data: string; readonly store: FileConversationStore }
/** A temporary directory, removed after the test. */
export function temporary(t: TestContext, prefix = "harness-conversation-store-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
/**
 * Every file and directory under `directory`: its path, its size, its modification time and the digest of its bytes, as lines — so that two states of a data root are equal or not
 * byte for byte, file list and times included. `except` leaves out names (the files of a write-ahead log, which a process that holds a database may change).
 */
export function treeDigest(directory: string, except: readonly string[] = [], prefix = ""): string[] {
  const lines: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : 1)) {
    if (except.includes(entry.name)) continue;
    const path = join(directory, entry.name), info = lstatSync(path);
    if (entry.isDirectory()) { lines.push(prefix + entry.name + "/ " + info.mtimeMs); lines.push(...treeDigest(path, except, prefix + entry.name + "/")); }
    else lines.push(prefix + entry.name + " " + info.size + " " + info.mtimeMs + " " + createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return lines;
}
/** A store on a new data root in a temporary directory; closed after the test (a test that disabled it has asserted why). */
export function openStore(t: TestContext, options: FileConversationStoreOptions = {}): Opened {
  const root = temporary(t), data = join(root, "data"), store = new FileConversationStore(data, options);
  t.after(() => { try { store.close(); } catch { /* the test asserted why the store was disabled */ } });
  return { root, data, store };
}
export function code(expected: string): (error: unknown) => boolean { return error => error instanceof SessionError && error.code === expected; }

/** A conversation with an identity and a create command of its own, workspace given; Runs are named by `prefix` in `Scenario`. */
export function newConversation(workspace: string, name: string, extra: Partial<Conversation> = {}): Conversation {
  const id = sessionId("session-" + name);
  return { id, version: 0, lastSeq: 0, format: CONVERSATION_FORMAT, epoch: 1, status: "open",
    configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: false },
    selection: { harnessId: "alpha", controlId: "alpha-acp" }, activeRunId: null, pendingSwitchId: null, runs: [], switches: [],
    commands: [{ id: commandId("create-" + name), kind: "create", fingerprint: "c".repeat(64), resultId: id }], ...extra };
}
export const created = (store: FileConversationStore, conversation: Conversation, events: readonly EventDraft[] = [event("session.created")], originHistory?: readonly OriginHistoryRow[]): ConversationCommit =>
  store.create(conversation, events, originHistory);

const completedBackend = { backend: { status: "completed" as const, reason: "done" }, cleanup: { closed: true as const, exitCode: 0, signal: null, protocolFailure: null } };
/** The timing of a Run that was started. */
const started = (ordinal: number) => ({ acceptedAt: NOW + ordinal * 10, preparingAt: NOW + ordinal * 10 + 1, readyAt: NOW + ordinal * 10 + 2, dispatchedAt: NOW + ordinal * 10 + 3 });

/**
 * Turns driven through a store the way a Runtime commits them: the input is accepted (queued, with its user item), the Run starts (it is the active one), the Harness says
 * something (a segment of reply, a call), and the Run ends. Each step is one commit and returns it. Runs are `<prefix>-<n>`; a conversation of the test has a prefix of its own.
 */
export class Scenario {
  /**
   * `verified` (the default): after every commit the whole-conversation check runs over what the store holds, and the check of the step runs over the conversation before and
   * after it, and both must find nothing. (They read every Turn, so a test of a very long conversation turns them off.)
   */
  constructor(readonly store: FileConversationStore, readonly id: SessionId, readonly prefix = "run", readonly verified = true) {}
  get state(): Conversation { return this.store.get(this.id); }
  runId(ordinal: number): string { return this.prefix + "-" + ordinal; }
  private runAt(ordinal: number): ConversationRun { return this.state.runs[ordinal]!; }
  private commit(change: (current: Conversation) => Conversation, events: readonly EventDraft[]): ConversationCommit {
    const before = this.state, done = this.store.transact(this.id, before.version, current => ({ next: change(current), events }));
    if (this.verified) {
      assert.deepEqual(verifyTransition(before, done.conversation, events), [], "the step breaks no rule of a transition");
      assert.deepEqual(verify(done.conversation, this.store), [], "the conversation after the step breaks no rule");
    }
    return done;
  }
  private withRun(ordinal: number, change: (entry: ConversationRun) => ConversationRun) {
    return (current: Conversation): Conversation => ({ ...current, runs: current.runs.map(entry => entry.ordinal === ordinal ? change(entry) : entry) });
  }
  /** The input arrives: a queued Run with its user item, and the send command. */
  accept(text: string, extra: Partial<ConversationRun> = {}): ConversationRun {
    const ordinal = this.state.runs.length, id = this.runId(ordinal);
    const queued = run(ordinal, "queued", [userItem(id, text)], extra, this.prefix);
    const command: CommandRecord = { id: commandId("command-" + id), kind: "send", fingerprint: "f".repeat(64), resultId: id };
    this.commit(current => ({ ...current, runs: [...current.runs, queued], commands: [...current.commands, command] }), [event("message.accepted", { runId: id })]);
    return this.runAt(ordinal);
  }
  /** The Run starts: running, and the conversation's active Run. */
  start(ordinal: number, extra: Partial<ConversationRun> = {}): ConversationCommit {
    return this.commit(current => ({ ...this.withRun(ordinal, entry => ({ ...entry, status: "running" as const, timing: started(ordinal), ...extra }))(current), activeRunId: this.runAt(ordinal).id }), [event("run.started", { runId: this.runId(ordinal) })]);
  }
  /** A segment of reply, begun with its first window of text. */
  say(ordinal: number, text: string, status: HeldItem["status"] = "running"): HeldItem {
    const entry = this.runAt(ordinal), seq = Math.max(0, ...(entry.items ?? []).map(held => held.seq)) + 1;
    const n = (entry.items ?? []).filter(held => held.itemId.startsWith("text:")).length + 1;
    const made = replyItem(this.runId(ordinal), seq, n, status, [text]);
    this.commit(this.withRun(ordinal, held => ({ ...held, items: [...(held.items ?? []), made] })), [event("run.output", { runId: this.runId(ordinal) })]);
    return made;
  }
  /** Another window of text appended to an item. */
  append(ordinal: number, seq: number, text: string): ConversationCommit {
    return this.commit(this.withRun(ordinal, held => ({ ...held, items: held.items!.map(it => it.seq === seq ? { ...it, text: [...it.text, text] } : it) })), [event("run.output", { runId: this.runId(ordinal) })]);
  }
  /** A call of a tool, as one more item. */
  tool(ordinal: number, name: string, status: HeldItem["status"] = "completed"): HeldItem {
    const entry = this.runAt(ordinal), seq = Math.max(0, ...(entry.items ?? []).map(held => held.seq)) + 1;
    const made = toolItem(this.runId(ordinal), seq, name, status);
    this.commit(this.withRun(ordinal, held => ({ ...held, items: [...(held.items ?? []), made] })), [event("run.output", { runId: this.runId(ordinal) })]);
    return made;
  }
  /** The Run ends: its open items are closed, it becomes terminal, and the conversation has no active Run. */
  finish(ordinal: number, status: "completed" | "failed" | "cancelled" = "completed"): ConversationCommit {
    return this.commit(current => ({ ...this.withRun(ordinal, entry => ({ ...entry, status, ...completedBackend, timing: { ...(entry.timing ?? started(ordinal)), endedAt: NOW + ordinal * 10 + 9 },
      items: entry.items!.map(held => ["pending", "running", "waiting"].includes(held.status) ? { ...held, status: status === "completed" ? "completed" as const : "cancelled" as const } : held) }))(current), activeRunId: null }), [event("run.ended", { runId: this.runId(ordinal), status })]);
  }
  /** A whole Turn: accepted, started, answered, ended. */
  turn(text: string, reply: string, extra: Partial<ConversationRun> = {}): ConversationRun {
    const accepted = this.accept(text, extra), ordinal = accepted.ordinal;
    this.start(ordinal); this.say(ordinal, reply); this.finish(ordinal);
    return this.runAt(ordinal);
  }
  /** A Turn left in progress: accepted, started, and part of an answer said. */
  open(text: string, partial: string, extra: Partial<ConversationRun> = {}): ConversationRun {
    const accepted = this.accept(text, extra);
    this.start(accepted.ordinal); this.say(accepted.ordinal, partial);
    return this.runAt(accepted.ordinal);
  }
}

/** The statuses a Run does not leave. */
export const TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled", "failed", "unknown"]);
/**
 * A recovery of the kind the domain injects (`recoverSession` over the new shape), as simple as the rule it stands for: what an owner that ended left unfinished is ended, never
 * replayed. A Run that ran becomes unknown and the conversation blocked, a Run that waited is cancelled, a pending switch fails, the items still open are closed with their Run.
 */
export const recoverUnfinished: RecoverConversation = current => {
  const unfinished = current.runs.filter(entry => !TERMINAL.has(entry.status));
  if (unfinished.length === 0 && current.pendingSwitchId === null) return null;
  const ran = unfinished.some(entry => entry.status !== "queued");
  const runs = current.runs.map((entry): ConversationRun => {
    if (TERMINAL.has(entry.status)) return entry;
    const status = entry.status === "queued" ? "cancelled" as const : "unknown" as const;
    return { ...entry, status, error: { code: "OWNER_ENDED", message: "previous owner ended without confirmed settlement; input was not replayed" },
      ...(entry.items === undefined ? {} : { items: entry.items.map(held => held.status === "waiting" ? { ...held, status: "cancelled" as const } : ["pending", "running"].includes(held.status) ? { ...held, status: status === "cancelled" ? "cancelled" as const : "unknown" as const } : held) }) };
  });
  const switches = current.switches.map(entry => entry.id === current.pendingSwitchId ? { ...entry, status: "failed" as const, error: { code: "OWNER_ENDED", message: "pending switch was not activated after owner exit" } } : entry);
  return { next: { ...current, status: ran ? "blocked" : current.status, activeRunId: null, pendingSwitchId: null, runs, switches },
    events: [{ type: "session.recovered", data: { unknownRunIds: runs.filter(entry => entry.status === "unknown" && !TERMINAL.has(current.runs[entry.ordinal]!.status)).map(entry => entry.id),
      cancelledRunIds: unfinished.filter(entry => entry.status === "queued").map(entry => entry.id), replayed: false } }] };
};

export { event, item, switchId };
