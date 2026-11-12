import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HeldItem } from "../../contracts/conversation.js";
import { SessionError, sessionId, type HarnessSelection, type PublicMessage, type PublicRun, type SessionEvent, type SessionId, type SessionSnapshot } from "../../contracts/session.js";
import { runRowOf } from "../../contexts/session/domain/run-row.js";
import { fromItems, originFromRows } from "../../contexts/session/domain/store-conversion.js";
import { conversationOf, isMainFile, lines, loadSession, readOrigin, readRunItems, sessionsDir, type Loaded } from "./session-file.js";
import { pageLimit } from "./store-events.js";
import { inspectRoot } from "./store-root.js";

/*
 * Read-only access to a data root for the command-line tools (`sessions list/show/events`): it never claims an owner, never recovers and never writes. It reads the
 * conversation files as they are (a WIP log laid over its file, as the store would before recovering it).
 */

/** One line of `list`: what the tools print of a conversation. */
export interface SessionLine {
  readonly id: SessionId;
  readonly status: SessionSnapshot["status"];
  readonly epoch: number;
  readonly selection: HarnessSelection;
  readonly runs: number;
  readonly lastSeq: number;
}

export class FileSessionReader {
  private readonly root: string;
  constructor(root: string) { this.root = inspectRoot(root).root; }

  /** Every conversation file, newest first by its time. */
  private files(): { readonly path: string; readonly mtimeMs: number }[] {
    const dir = sessionsDir(this.root), found: { path: string; mtimeMs: number }[] = [];
    if (!existsSync(dir)) return found;
    for (const folder of readdirSync(dir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const name of readdirSync(join(dir, folder.name))) if (isMainFile(name)) { const path = join(dir, folder.name, name); found.push({ path, mtimeMs: statSync(path).mtimeMs }); }
    }
    return found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }
  private find(id: SessionId): Loaded {
    for (const file of this.files()) if (file.path.endsWith("_" + id + ".jsonl")) return loadSession(file.path);
    throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
  }
  list(limit: number): readonly SessionLine[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new SessionError("INVALID_INPUT", "read limit must be a positive integer");
    return this.files().slice(0, limit).map(file => {
      const conversation = conversationOf(loadSession(file.path));
      return { id: conversation.id, status: conversation.status, epoch: conversation.epoch, selection: conversation.selection, runs: conversation.runs.length, lastSeq: conversation.lastSeq };
    });
  }
  /** The conversation in the shape of a snapshot (`fromItems` over its Turns). */
  get(id: SessionId): SessionSnapshot {
    sessionId(id);
    const loaded = this.find(id), conversation = conversationOf(loaded), runs: PublicRun[] = [], messages: PublicMessage[] = [];
    loaded.runs.forEach((run, ordinal) => {
      const held = conversation.runs[ordinal]!;
      const items: HeldItem[] = held.items !== undefined ? [...held.items] : run.span === null ? [] : readRunItems(loaded.paths.main, held.id, run.span);
      const made = fromItems({ row: runRowOf(conversation.id, held), items, contentRefs: [] });
      runs.push(made.run); messages.push(...made.messages);
    });
    messages.sort((left, right) => left.seq - right.seq);
    const origin = conversation.origin === undefined ? null : originFromRows(conversation.origin, readOrigin(loaded.paths.main, conversation.id, loaded.origin));
    return { schemaVersion: 13, id: conversation.id, version: conversation.version, lastSeq: conversation.lastSeq, epoch: conversation.epoch, status: conversation.status, configuration: conversation.configuration,
      selection: conversation.selection, activeRunId: conversation.activeRunId, pendingSwitchId: conversation.pendingSwitchId, runs, messages, switches: conversation.switches, commands: conversation.commands,
      ...(conversation.nativeBindings === undefined ? {} : { nativeBindings: conversation.nativeBindings }), ...(origin === null ? {} : { origin }) } as SessionSnapshot;
  }
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[] {
    sessionId(id); const count = pageLimit(limit);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new SessionError("INVALID_INPUT", "event cursor must be a nonnegative integer");
    const loaded = this.find(id), result: SessionEvent[] = [];
    if (!existsSync(loaded.paths.events)) return result;
    for (const line of lines(readFileSync(loaded.paths.events))) {
      if (line.torn) continue;
      let value: { seq: number; type: string; sessionId: string; ownerGeneration: number; timestamp: string; data: Record<string, unknown> };
      try { value = JSON.parse(line.text) as typeof value; } catch { continue; }
      if (value.seq <= afterSeq) continue;
      result.push({ type: value.type, data: value.data, sessionId: value.sessionId as SessionId, seq: value.seq, ownerGeneration: value.ownerGeneration, timestamp: value.timestamp });
      if (result.length >= count) break;
    }
    return result;
  }
  close(): void { /* nothing is held */ }
}
