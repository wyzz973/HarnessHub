import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import type { Conversation } from "../../contracts/conversation.js";
import type { ConversationWorktree, HarnessSelection, NativeSessionBinding, RunId, SessionId, SessionSnapshot } from "../../contracts/session.js";
import { conversationOf, isMainFile, loadSession, runFinished, sessionsDir, type Loaded } from "./session-file.js";
import { listMarksOf } from "./rows.js";

/*
 * The list of conversations, kept as a cache beside the files (`sessions/index.json`): one row per file with what the list, the recovery and the lookups by native
 * session or create key need, and the file's size and time to tell whether the row is still the file's. It is derived: a row that is missing or stale is made again by
 * reading its file, and a cache that cannot be read is made again whole. Nothing reads a conversation's Turns to list it.
 */

export interface StartupRow { readonly harnessId: string; readonly controlId: string; readonly preparingAt: number; readonly readyAt: number }
export interface IndexRow {
  readonly id: SessionId;
  /** The main file, relative to `sessions/`. */
  readonly file: string;
  readonly title: string;
  readonly status: SessionSnapshot["status"];
  readonly workspace: string;
  readonly selection: HarnessSelection;
  readonly updatedAt: number;
  readonly lastSeq: number;
  readonly runCount: number;
  readonly activeRunId: RunId | null;
  /** When the active Run was accepted; absent when none is active (or the cache was written before this was kept, until its file moves again). */
  readonly activeSince?: number;
  /** The conversation that delegated this one its work, when one did. */
  readonly parent?: Conversation["delegation"];
  /** The user archived it; a cache written before this was kept has no archived conversation, as no file then had one. */
  readonly archived?: true;
  /** The user pinned it, or put it aside until a moment (2026-11-14); a cache written before has neither, as no file then had one. */
  readonly pinned?: true;
  readonly pinnedOrder?: number;
  readonly snoozedUntil?: number;
  /** The Git worktree it works in (2026-11-14); a cache written before has none, as no file then had one. */
  readonly worktree?: ConversationWorktree;
  /** When the user deleted it (2026-11-14): the list leaves it out, and it is still found by its id, to be restored. A cache written before has no deleted conversation. */
  readonly deletedAt?: number;
  readonly kept: boolean;
  /** A Turn not finished or a switch pending: what recovery visits. */
  readonly unfinished: boolean;
  readonly bindings: readonly Pick<NativeSessionBinding, "harnessId" | "controlId" | "checkpoint" | "status" | "opensNew">[];
  readonly createKey: string | null;
  /** The handoff log rows the conversation's deliveries name. */
  readonly handoffs: readonly number[];
  /** The latest startups of each Harness entry the conversation ran on. */
  readonly samples: readonly StartupRow[];
  readonly size: number;
  readonly mtimeMs: number;
}

const SAMPLES_PER_ENTRY = 8;

/** The row of a conversation from what the store holds of it. */
export function indexRowOf(conversation: Conversation, file: string, facts: { readonly title: string; readonly updatedAt: number; readonly createKey: string | null; readonly handoffs: readonly number[]; readonly size: number; readonly mtimeMs: number }): IndexRow {
  const samples = new Map<string, StartupRow[]>();
  for (let index = conversation.runs.length - 1; index >= 0; index--) {
    const run = conversation.runs[index]!, timing = run.timing;
    if (timing?.readyAt === undefined || timing.preparingAt === undefined || run.reused === true) continue;
    const key = run.selection.harnessId + "\u0000" + run.selection.controlId, list = samples.get(key) ?? [];
    if (list.length >= SAMPLES_PER_ENTRY) continue;
    list.push({ harnessId: run.selection.harnessId, controlId: run.selection.controlId, preparingAt: timing.preparingAt, readyAt: timing.readyAt }); samples.set(key, list);
  }
  // The active Run is the latest or near it: looked for from the end.
  let activeSince: number | undefined;
  if (conversation.activeRunId !== null) for (let index = conversation.runs.length - 1; index >= 0; index--) if (conversation.runs[index]!.id === conversation.activeRunId) { activeSince = conversation.runs[index]!.timing?.acceptedAt; break; }
  return { id: conversation.id, file, title: facts.title, status: conversation.status, workspace: conversation.configuration.workspace, selection: conversation.selection, updatedAt: facts.updatedAt,
    lastSeq: conversation.lastSeq, runCount: conversation.runs.length, activeRunId: conversation.activeRunId, ...(activeSince === undefined ? {} : { activeSince }),
    ...(conversation.delegation === undefined ? {} : { parent: conversation.delegation }), ...listMarksOf(conversation),
    ...(conversation.deletedAt === undefined ? {} : { deletedAt: conversation.deletedAt }), kept: conversation.retained !== undefined,
    unfinished: conversation.pendingSwitchId !== null || conversation.runs.some(run => !runFinished(run.status)),
    bindings: (conversation.nativeBindings ?? []).map(binding => ({ harnessId: binding.harnessId, controlId: binding.controlId, checkpoint: binding.checkpoint, status: binding.status, ...(binding.opensNew === true ? { opensNew: true as const } : {}) })),
    createKey: facts.createKey, handoffs: facts.handoffs, samples: [...samples.values()].flat(), size: facts.size, mtimeMs: facts.mtimeMs };
}
export function handoffsOf(loaded: Pick<Loaded, "deliveries">): number[] {
  return [...new Set([...loaded.deliveries.values()].flatMap(record => record.handoffLogSeq === null ? [] : [record.handoffLogSeq]))].sort((left, right) => left - right);
}
/** The row of a file read whole (a row that was missing or stale). */
export function indexRowOfFile(root: string, main: string): IndexRow {
  const loaded = loadSession(main), stat = statSync(main);
  const conversation = conversationOf(loaded);
  return indexRowOf(conversation, relative(sessionsDir(root), main), { title: loaded.title, updatedAt: loaded.updatedAt, createKey: typeof loaded.header.createKey === "string" ? loaded.header.createKey : null,
    handoffs: handoffsOf(loaded), size: stat.size, mtimeMs: stat.mtimeMs });
}

export class SessionIndex {
  readonly rows = new Map<string, IndexRow>();
  private readonly path: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly root: string, private readonly report: (line: string) => void) { this.path = join(sessionsDir(root), "index.json"); }

  /** Reads the cache and holds it to the files: a row whose file is gone is dropped, one whose file changed (or a file without a row) is read again. */
  open(): void {
    const dir = sessionsDir(this.root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cached = new Map<string, IndexRow>();
    if (existsSync(this.path)) {
      try {
        const value = JSON.parse(readFileSync(this.path, "utf8")) as { readonly version?: unknown; readonly rows?: unknown };
        if (value.version === 1 && Array.isArray(value.rows)) for (const row of value.rows as IndexRow[]) if (typeof row?.file === "string") cached.set(row.file, row);
      } catch { this.report("the list of conversations is made again from the files"); }
    }
    let changed = false;
    for (const folder of readdirSync(dir, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      for (const name of readdirSync(join(dir, folder.name))) {
        if (!isMainFile(name)) continue;
        const main = join(dir, folder.name, name), file = join(folder.name, name);
        let stat; try { stat = statSync(main); } catch { continue; }
        const wip = existsSync(main.slice(0, -".jsonl".length) + ".wip.jsonl");
        const row = cached.get(file);
        if (row !== undefined && row.size === stat.size && row.mtimeMs === stat.mtimeMs && !wip) { this.rows.set(row.id, row); continue; }
        try {
          const made = indexRowOfFile(this.root, main);
          this.rows.set(made.id, wip ? { ...made, unfinished: true } : made); changed = true;
        } catch (error) { this.report("a conversation file could not be read and is left as it is (" + file + ": " + (error instanceof Error ? error.message : "unreadable") + ")"); }
      }
    }
    if (changed || cached.size !== this.rows.size) this.touch();
  }
  /** A row as the store holds it now; `persist: false` keeps it in memory until the next write (a commit that changed only the WIP log moves no file the cache describes). */
  put(row: IndexRow, persist = true): void { this.rows.set(row.id, row); if (persist) this.touch(); }
  drop(id: string): void { if (this.rows.delete(id)) this.touch(); }
  /** Writes the cache soon (it is derived: a cache lost to a crash is made again from the files). */
  private touch(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
    this.timer.unref();
  }
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const temporary = this.path + ".tmp", fd = openSync(temporary, "w", 0o600);
      try { writeSync(fd, JSON.stringify({ version: 1, rows: [...this.rows.values()] }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
    } catch (error) { this.report("the list of conversations could not be written (" + (error instanceof Error ? error.message : "unwritable") + "); it is made again at the next start"); }
  }
  close(): void { this.flush(); }
}
