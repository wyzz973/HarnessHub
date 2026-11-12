import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_FORMAT, type Conversation, type ConversationRun, type HeldItem, type ItemFields, type Mutation,
} from "../../src/contracts/conversation.js";
import type { ItemStatus, ItemType } from "../../src/contracts/protocol.js";
import { commandId, messageId, runId, sessionId, switchId, type CommandRecord, type EventDraft, type RunStatus, type SessionId } from "../../src/contracts/session.js";
import { applyMutation, type Applied } from "../../src/infrastructure/session/apply.js";
import { diffConversation, settleConversation, type DiffContext } from "../../src/infrastructure/session/diff.js";
import { loadConversation } from "../../src/infrastructure/session/load.js";
import { runRowOf } from "../../src/infrastructure/session/rows.js";
import { schemaV14Statements } from "../../src/infrastructure/session/schema-v14.js";

/*
 * Builders for the tests of the tables (ADR-057): a Conversation as the Runtime would hold it, a real database made as a new v14 one, and the
 * commit loop `diff → apply → settle`. Only the Harness and the model are made up; the rows are written to and read from SQLite.
 */

export const EVENTS_TABLE = "CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT";
export const SESSION = sessionId("session-rows");
export const NOW = Date.UTC(2026, 10, 12);
export const STAMP = new Date(NOW).toISOString();

export interface Env { readonly db: DatabaseSync; readonly root: string }
/** A real database file in a temporary directory, made as a new v14 database, removed after the test. */
export function openDatabase(t: TestContext): Env {
  const root = mkdtempSync(join(tmpdir(), "harness-rows-"));
  const db = new DatabaseSync(join(root, "gateway.sqlite"), { timeout: 0, allowExtension: false, enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  for (const sql of schemaV14Statements("fresh")) db.exec(sql);
  db.exec(EVENTS_TABLE);
  t.after(() => { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root };
}

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
/** One commit as the store does it in stage 1: diff the two conversations, write the Mutation, settle the conversation with the numbers the write gave it. */
export function commit(env: Env, before: Conversation | null, after: Conversation, events: readonly EventDraft[], context: Partial<DiffContext> = {}, generation = 1): Committed {
  const mutation = diffConversation(before, after, { events, title: "Hello", updatedAt: NOW, ...context });
  const applied = applyMutation(env.db, mutation, { ownerGeneration: generation, timestamp: STAMP });
  return { conversation: settleConversation(after, applied), applied, mutation };
}
export function counts(env: Env, table: string, where = "1=1"): number { return Number(env.db.prepare("SELECT COUNT(*) AS n FROM " + table + " WHERE " + where).get()?.n); }
export function sessionOf(id: string): SessionId { return sessionId(id); }

/**
 * The Mutation that converts a conversation held as a v13 row: its finished Turns inserted whole (a Run is terminal at its insert and its items follow:
 * possible only while the conversation is not 14), the head last (as the migration writes it). `past` is what the old snapshot said.
 */
export function conversionMutation(past: Conversation, version: number, lastSeq: number, title = "old question"): Mutation {
  const finishedRuns = past.runs;
  return { head: { row: { id: past.id, version, lastSeq, format: CONVERSATION_FORMAT, status: past.status, epoch: past.epoch, activeRunId: null, pendingSwitchId: null, kept: false, title, runCount: finishedRuns.length, updatedAt: NOW,
      deletedAt: null, lastError: null, head: { configuration: past.configuration, selection: past.selection } } },
    commands: past.commands.map((command, ordinal) => ({ sessionId: past.id, ordinal, command })), runs: finishedRuns.map(entry => ({ op: "insert" as const, row: runRowOf(past.id, entry) })),
    items: finishedRuns.flatMap(entry => entry.items!.map(it => ({ op: "insert" as const, row: { ...it, textBytes: 0, textChunks: 0 } }))),
    text: finishedRuns.flatMap(entry => entry.items!.flatMap(it => { let offset = 0; return it.text.map((text, chunk) => { const append = { runId: it.runId, itemSeq: it.seq, chunk, text, byteOffset: offset }; offset += bytes(text); return append; }); })), events: [] };
}
/** A conversation as an upgrade leaves it (a v13 row) and then converts it: `past`'s Turns are written in one transaction, and the conversation is read back as the Runtime would hold it. */
export function seedConverted(env: Env, past: Conversation, version = 1, lastSeq = 5, title = "old question"): Conversation {
  env.db.prepare("INSERT INTO sessions(id,version,last_seq,head,format) VALUES(?,?,?,?,13)").run(past.id, version, lastSeq, "{}");
  env.db.exec("BEGIN");
  applyMutation(env.db, conversionMutation(past, version, lastSeq, title), { ownerGeneration: 1, timestamp: STAMP });
  env.db.exec("COMMIT");
  return loadConversation(env.db, past.id);
}
