import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContentPort } from "../contracts/content.js";
import type { Conversation, ConversationReader } from "../contracts/conversation.js";
import type { RunId, SessionConfiguration, SessionId, TaskBoard } from "../contracts/session.js";
import { readDetail } from "../contexts/session/domain/detail-read.js";
import {
  CONTEXT_DETAIL_POLICY, contextIndex, contextNeeds, contextTurn, contextTurnPath, detailKey, rowsTable, tableDetailOf, tableRedaction,
  type ContextFile, type TableRedaction, type TableToolDetail,
} from "../contexts/session/domain/table.js";
import { conversationLabel } from "../contexts/session/domain/board-words.js";
import { taskFamily, taskLabel, type TaskMember } from "./task-family.js";
import { hasState, stateText, taskState, type StateScope, type StateStore, type StateWords } from "./task-state.js";

/**
 * The record as a directory (docs/decisions/LOG.md, 2026-11-13): what the Hub knows of a task, laid out as read-only files a Harness reads with its own file tools —
 * no tool of the Hub's to learn, nothing to pay for a tool's definition, and every piece has an address (its path). One directory a task (the conversation it began in
 * and everything delegated under it), one directory inside it for each conversation:
 *
 *   <root>/<task>/README.md            how the directory is laid out
 *   <root>/<task>/task.md              the conversations working on the task: who has what, how each stands, the files each changed
 *   <root>/<task>/board.md             the task's board
 *   <root>/<task>/<conversation>/index.md        one entry a Turn
 *   <root>/<task>/<conversation>/turns/007.md    the whole of Turn 7; a text too long for it is whole in turns/007/tool-02.output.txt
 *
 * `ensure` brings the directory of a conversation's task up to the record: only what changed is written (a finished Turn's files are written once), and what a
 * conversation no longer holds (Turns after a place it went back to) is removed. `refresh` writes again only what changes in the middle of a Turn (task.md, board.md,
 * each STATE.md). Files are written beside and moved into place, so one being read is never half written.
 * What the table hides of a Harness's secrets is hidden here the same way.
 */
/** The directory under the data root the record's directories are kept in. */
export const CONTEXT_DIR = "context";
export interface ContextPlace {
  /** The task's directory. */
  readonly dir: string;
  /** The conversation's own directory inside it, by its label. */
  readonly self: string;
}
export interface ContextFilesOptions {
  /** Where the directories are kept (`<data>/context`). */
  readonly root: string;
  readonly reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory" | "harnessIds"> & StateStore;
  readonly content?: Pick<ContentPort, "readText" | "readChunks">;
  readonly secrets?: (configuration: SessionConfiguration, harnessIds: readonly string[]) => Promise<readonly string[]>;
  /** A Harness's display name by its id. */
  readonly name: (harnessId: string) => string | null;
  /** The board of the task a conversation belongs to. */
  readonly board: (id: SessionId) => TaskBoard;
  /**
   * What changed in the task for the Turn in progress of a conversation that its Harness has not been told (2026-11-14): its STATE.md then begins with it, for a Harness
   * that reads the record as files and may call no tool of the Hub's. `written` is called once the file that says it is in place. Null: nothing is pending.
   */
  readonly changes?: (id: SessionId) => { readonly text: string; written(): void } | null;
}
/** What a conversation's directory was written from: its version then, and each Turn's Run and state in order. */
interface Written { readonly version: number; readonly runs: readonly string[] }
const STATE = ".written.json", FINISHED = new Set(["completed", "failed", "cancelled"]);
const BOARD_WORDS = { goal: "Goal", constraint: "Constraints", decision: "Decisions", note: "Notes" } as const;

export const CONTEXT_README = [
  "# The record of this task, kept by HarnessHub",
  "",
  "Read-only. Everything the user and every Harness said and did on this task is here; read it with your own file tools and search it with grep.",
  "",
  "- task.md: the conversations working on the task, how each stands, the files each changed",
  "- board.md: what everyone on the task goes by (the goal, the user's constraints, decisions), each entry with its id and who wrote it",
  "- <conversation>/STATE.md: where that conversation stands in the task, as HarnessHub puts it together (goal, what must hold, the task list, the files in play, the user's latest message); "
    + "what changed for its turn in progress that its Harness was not told yet comes first. It is kept current while a turn runs",
  "- <conversation>/index.md: one entry a turn of that conversation (who ran it, how it ended, what was asked and answered in short)",
  "- <conversation>/turns/NNN.md: the whole of turn NNN: the user's words, the reply, every tool call with its input and output, the files changed",
  "- <conversation>/turns/NNN/tool-KK.output.txt: a text too long to stand in the turn's file, whole",
  "",
  "A conversation's directory is named by its label (c- and six characters). Yours is the one HarnessHub named to you.",
  "Everything of this task is inside this directory. What is above it belongs to other tasks: do not look there.",
  "",
].join("\n");

export class ContextFiles {
  private readonly working = new Map<string, Promise<void>>();
  private readonly texts = new Map<string, string>();
  private readonly secretsFor = new Map<string, { readonly values: readonly string[]; readonly until: number }>();
  constructor(private readonly options: ContextFilesOptions) {}

  /** The conversation the task of `id` began in. */
  private rootOf(id: SessionId): SessionId {
    let root = id;
    for (let hops = 0; hops < 16; hops++) { let parent: SessionId | undefined; try { parent = this.options.reader.get(root).delegation?.parentId; } catch { parent = undefined; } if (parent === undefined) break; root = parent; }
    return root;
  }
  /** Where the directory of a conversation's task is, whether or not it is written yet. */
  place(id: SessionId): ContextPlace { return { dir: join(this.options.root, taskLabel(this.rootOf(id))), self: taskLabel(id) }; }

  /**
   * The state of the task as the conversation `id` stands in it, as its Harness reads it before the Turn `upTo` (task-state.ts); null when there is nothing to say yet.
   * `words`: how much of the user's words it carries (StateWords).
   */
  state(id: SessionId, upTo?: RunId, record = false, scope: StateScope = "whole", words: StateWords = "latest"): string | null {
    try {
      const state = taskState(this.options.reader, id, this.options.name, this.options.board(id), upTo, words);
      return hasState(state, scope) ? stateText(state, this.options.name, record ? this.place(id) : undefined, scope) : null;
    } catch { return null; }
  }
  /** Brings the directory of the task `id` belongs to up to the record. One writer a task at a time; a failure leaves what was there and is the caller's to ignore. */
  ensure(id: SessionId): Promise<void> { return this.serialized(id, dir => this.write(id, dir)); }
  /**
   * Writes again only what changes in the middle of a Turn (2026-11-14): the task's `task.md`, `board.md` and each conversation's `STATE.md`, so that a Harness that
   * reads them after it compacted reads where the task stands now and not where it stood when the Turn began. Serialized with `ensure`; a failure leaves what was there.
   */
  refresh(id: SessionId): Promise<void> {
    return this.serialized(id, async dir => {
      const members = taskFamily(this.options.reader, id, this.options.name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await this.common(id, dir, members);
      for (const member of members) await this.stateFile(member, dir);
    }).catch(() => undefined);
  }
  /**
   * Takes a conversation the user erases (2026-11-14) out of its task's directory. Called while it is still there, right before its rows go (`purging`: all erased with it):
   * where its task's directory is and who else is in the task are read now; the files go after, behind the task's other writers, so the rows are gone by then and nothing
   * writes its directory again.
   * - The task began in it: the conversations it delegated stay in the task's directory (their chain still names it). Its own directory goes, and the whole task's when no
   *   other conversation of the task is left (deleted ones count: they can still be restored).
   * - It was delegated work inside a task: its directory goes, and so do those of the conversations under it, whose chain went through it and which from now on are a task
   *   of their own (named after it, `place`); theirs is written there when they next need it. The task's own files then say who is left.
   */
  forget(id: SessionId, purging: ReadonlySet<SessionId>): Promise<void> {
    const place = this.place(id), members = taskFamily(this.options.reader, id, this.options.name), began = place.dir === join(this.options.root, place.self);
    const under = new Set<string>([place.self]);
    if (!began) for (const member of members) if (member.parent !== null && under.has(member.parent)) under.add(member.label);
    const left = members.filter(member => !purging.has(member.sessionId) && (began || !under.has(member.label)));
    return this.serialized(id, async dir => {
      if (left.length === 0) { await rm(dir, { recursive: true, force: true }); this.unwritten(dir); return; }
      for (const label of under) { await rm(join(dir, label), { recursive: true, force: true }); this.unwritten(join(dir, label)); }
      if (!await stat(dir).then(info => info.isDirectory(), () => false)) return;
      const members = taskFamily(this.options.reader, left[0]!.sessionId, this.options.name);
      await this.common(left[0]!.sessionId, dir, members);
      for (const member of members) await this.stateFile(member, dir);
    });
  }
  /** What this process remembers having written under a path that is gone, so that a file written there again is written. */
  private unwritten(path: string): void { for (const key of [...this.texts.keys()]) if (key === path || key.startsWith(path + "/")) this.texts.delete(key); }
  /** One writer a task at a time: `work` runs after what was asked of the task's directory before it. */
  private serialized(id: SessionId, work: (dir: string) => Promise<void>): Promise<void> {
    const place = this.place(id), before = this.working.get(place.dir) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => work(place.dir));
    this.working.set(place.dir, next);
    void next.catch(() => undefined).finally(() => { if (this.working.get(place.dir) === next) this.working.delete(place.dir); });
    return next;
  }

  private async write(id: SessionId, dir: string): Promise<void> {
    const members = taskFamily(this.options.reader, id, this.options.name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.put(join(dir, "README.md"), CONTEXT_README);
    await this.common(id, dir, members);
    for (const member of members) {
      try { await this.conversation(member.sessionId, join(dir, member.label), member.label); } catch { /* a conversation that cannot be read now keeps what it had */ }
      await this.stateFile(member, dir);
    }
  }
  /** The task's own files: its conversations and its board. */
  private async common(id: SessionId, dir: string, members: readonly TaskMember[]): Promise<void> {
    await this.put(join(dir, "task.md"), taskText(members));
    await this.put(join(dir, "board.md"), boardText(this.options.board(id), this.options.name));
  }
  /**
   * Where a conversation stands in the task, as the Hub puts it together: the same state it says to a Harness, always as it is now, with the user's latest message
   * whole (the earlier ones are in index.md). When something changed for its Turn in progress that its Harness was not told, that comes first.
   */
  private async stateFile(member: TaskMember, dir: string): Promise<void> {
    let changes: { readonly text: string; written(): void } | null = null;
    try { changes = this.options.changes?.(member.sessionId) ?? null; } catch { changes = null; }
    let state: string | null = null;
    try {
      const gathered = taskState(this.options.reader, member.sessionId, this.options.name, this.options.board(member.sessionId), undefined, "latest");
      state = hasState(gathered, "whole") || gathered.words.said.length > 0 ? stateText(gathered, this.options.name, "inside", "whole") : null;
    } catch { state = null; }
    const text = (changes === null ? "" : "# 这一轮开始以来的变化\n\n" + changes.text + "\n\n# 这件任务现在的状态\n\n") + (state ?? "（还没有可说的状态）") + "\n";
    try { await this.put(join(dir, member.label, "STATE.md"), text); changes?.written(); } catch { /* the file keeps what it had */ }
  }

  /** One conversation's directory: the Turns that changed since it was last written, then its index. */
  private async conversation(id: SessionId, dir: string, label: string): Promise<void> {
    const light: Conversation = this.options.reader.get(id), runs = light.runs.map(run => run.id + ":" + run.status);
    let written: Written = { version: -1, runs: [] };
    try { const value = JSON.parse(await readFile(join(dir, STATE), "utf8")) as Written; if (typeof value.version === "number" && Array.isArray(value.runs)) written = value; } catch { /* nothing written yet */ }
    if (written.version === light.version && written.runs.length === runs.length) return;
    const table = rowsTable(this.options.reader, id), redaction = await this.redaction(id, light.configuration, table.harnessIds());
    await mkdir(join(dir, "turns"), { recursive: true, mode: 0o700 });
    // A finished Turn written before stands as it is; from the first that is new, changed or was still going on, each is written again.
    let from = 0;
    while (from < runs.length && from < written.runs.length && runs[from] === written.runs[from] && FINISHED.has(light.runs[from]!.status)) from++;
    for (let n = from + 1; n <= runs.length; n++) {
      const details = new Map<string, TableToolDetail>();
      for (const item of contextNeeds(table, n)) {
        try { const read = this.options.content === undefined ? null : await readDetail(this.options.content, item.ref, CONTEXT_DETAIL_POLICY); if (read !== null) details.set(detailKey(item.runId, item.toolId), tableDetailOf(read)); } catch { /* told without its detail */ }
      }
      const files = contextTurn(table, n, details, redaction), blobs = join(dir, contextTurnPath(n).replace(/\.md$/u, ""));
      // The texts a Turn had files for before and has none for now (a Turn still going on is written many times) go with the directory.
      await rm(blobs, { recursive: true, force: true });
      for (const file of files) await this.put(join(dir, file.path), file.text, false);
    }
    // Turns the conversation no longer holds (it went back to an earlier place and went on from there).
    for (const name of await readdir(join(dir, "turns")).catch(() => [] as string[])) {
      const n = Number(/^(\d+)(?:\.md)?$/u.exec(name)?.[1] ?? Number.NaN);
      if (Number.isInteger(n) && n > runs.length) await rm(join(dir, "turns", name), { recursive: true, force: true });
    }
    await this.put(join(dir, "index.md"), contextIndex(table, label, redaction), false);
    await writeFile(join(dir, STATE), JSON.stringify({ version: light.version, runs } satisfies Written), { mode: 0o600 });
  }

  /** Writes a file when its text is not what this process last wrote there; read-only, moved into place whole. */
  private async put(path: string, text: string, remember = true): Promise<void> {
    if (remember) { const digest = createHash("sha256").update(text).digest("hex"); if (this.texts.get(path) === digest) return; this.texts.set(path, digest); }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const next = path + ".next";
    await writeFile(next, text, { mode: 0o600 });
    await chmod(next, 0o444);
    await rename(next, path);
  }

  private async redaction(id: SessionId, configuration: SessionConfiguration, harnessIds: readonly string[]): Promise<TableRedaction> {
    const provider = this.options.secrets;
    if (provider === undefined) return tableRedaction([]);
    const ids = [...new Set(harnessIds)].sort(), key = id + "\n" + ids.join(","), now = Date.now();
    let entry = this.secretsFor.get(key);
    if (entry === undefined || entry.until <= now) {
      let values: readonly string[];
      try { values = await provider(configuration, ids); } catch { values = []; }
      entry = { values, until: now + 60_000 };
      this.secretsFor.set(key, entry);
      if (this.secretsFor.size > 64) this.secretsFor.delete(this.secretsFor.keys().next().value!);
    }
    return tableRedaction(entry.values);
  }
}

const STATUS = { running: "in progress", completed: "completed", failed: "failed", cancelled: "stopped", unknown: "outcome unknown", empty: "not started" } as const;
/** The conversations of the task: each by its label, who has it, how it stands, what it was asked and last said, the files it changed. */
export function taskText(members: readonly TaskMember[]): string {
  const lines = ["# The task: " + members.length + (members.length === 1 ? " conversation" : " conversations"), ""];
  for (const member of members) {
    lines.push("## " + member.label + " · " + member.harness + " · " + STATUS[member.status] + " · " + member.turns + (member.turns === 1 ? " turn" : " turns")
      + (member.parent === null ? " · where the task began" : " · delegated by " + member.parent + (member.by === "harness" ? " (its Harness)" : " (the user)")));
    lines.push("asked: " + (member.task || "(nothing yet)"));
    if (member.reply !== "") lines.push("last reply: " + member.reply);
    if (member.files.length) lines.push("files changed: " + member.files.join(", "));
    lines.push("record: " + member.label + "/index.md", "");
  }
  return lines.join("\n");
}
/**
 * The task's board as a file: each entry with its id (what `hub_remember` takes as `forget`) and who wrote it. An entry a Harness wrote is that Harness's reading of
 * what the user said, and names the turn it was written in by its path, relative to this directory.
 */
export function boardText(board: TaskBoard, name: (harnessId: string) => string | null): string {
  if (board.entries.length === 0) return "# The task's board\n\n(empty)\n";
  const lines = ["# The task's board", "", "What everyone working on this task goes by. Written by the user and by the Harnesses.",
    "An entry the user wrote is the user's own. An entry a Harness wrote is that Harness's reading of what the user said: it names the turn it came from (a path relative to this directory); "
      + "when you are unsure it is what the user meant, or it does not agree with what the user says now, read the user's words there and go by them.",
    "Each entry begins with its id in brackets: to take an entry off when the user withdrew it, give that id to hub_remember as `forget`.", ""];
  const source = (entry: TaskBoard["entries"][number]): string => {
    if (entry.by === "user") return "the user";
    const who = name(entry.by) ?? entry.by;
    if (entry.from === undefined) return who;
    const label = conversationLabel(entry.from.sessionId), turn = entry.from.ordinal + 1;
    return who + "'s reading of the user's words in turn " + turn + " of " + label + ": " + label + "/" + contextTurnPath(turn);
  };
  for (const kind of ["goal", "constraint", "decision", "note"] as const) {
    const entries = board.entries.filter(entry => entry.kind === kind);
    if (entries.length === 0) continue;
    lines.push("## " + BOARD_WORDS[kind]);
    for (const entry of entries) lines.push("- [" + entry.id + "] " + entry.text + " (" + source(entry) + ")");
    lines.push("");
  }
  return lines.join("\n");
}
export type { ContextFile };
