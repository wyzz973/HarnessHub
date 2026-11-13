import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContentPort } from "../contracts/content.js";
import type { Conversation, ConversationReader } from "../contracts/conversation.js";
import type { SessionConfiguration, SessionId, TaskBoard } from "../contracts/session.js";
import { readDetail } from "../contexts/session/domain/detail-read.js";
import {
  CONTEXT_DETAIL_POLICY, contextIndex, contextNeeds, contextTurn, contextTurnPath, detailKey, rowsTable, tableDetailOf, tableRedaction,
  type ContextFile, type TableRedaction, type TableToolDetail,
} from "../contexts/session/domain/table.js";
import { taskFamily, taskLabel, type FamilyStore, type TaskMember } from "./task-family.js";

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
 * conversation no longer holds (Turns after a place it went back to) is removed. Files are written beside and moved into place, so one being read is never half written.
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
  readonly reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory" | "harnessIds"> & FamilyStore;
  readonly content?: Pick<ContentPort, "readText" | "readChunks">;
  readonly secrets?: (configuration: SessionConfiguration, harnessIds: readonly string[]) => Promise<readonly string[]>;
  /** A Harness's display name by its id. */
  readonly name: (harnessId: string) => string | null;
  /** The board of the task a conversation belongs to. */
  readonly board: (id: SessionId) => TaskBoard;
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
  "- board.md: what everyone on the task goes by (the goal, the user's constraints, decisions)",
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

  /** Brings the directory of the task `id` belongs to up to the record. One writer a task at a time; a failure leaves what was there and is the caller's to ignore. */
  ensure(id: SessionId): Promise<void> {
    const place = this.place(id), before = this.working.get(place.dir) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.write(id, place.dir));
    this.working.set(place.dir, next);
    void next.catch(() => undefined).finally(() => { if (this.working.get(place.dir) === next) this.working.delete(place.dir); });
    return next;
  }

  private async write(id: SessionId, dir: string): Promise<void> {
    const members = taskFamily(this.options.reader, id, this.options.name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.put(join(dir, "README.md"), CONTEXT_README);
    await this.put(join(dir, "task.md"), taskText(members));
    await this.put(join(dir, "board.md"), boardText(this.options.board(id), this.options.name));
    for (const member of members) {
      try { await this.conversation(member.sessionId, join(dir, member.label), member.label); } catch { /* a conversation that cannot be read now keeps what it had */ }
    }
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
/** The task's board as a file. */
export function boardText(board: TaskBoard, name: (harnessId: string) => string | null): string {
  if (board.entries.length === 0) return "# The task's board\n\n(empty)\n";
  const lines = ["# The task's board", "", "What everyone working on this task goes by. Written by the user and by the Harnesses.", ""];
  for (const kind of ["goal", "constraint", "decision", "note"] as const) {
    const entries = board.entries.filter(entry => entry.kind === kind);
    if (entries.length === 0) continue;
    lines.push("## " + BOARD_WORDS[kind]);
    for (const entry of entries) lines.push("- " + entry.text + " (" + (entry.by === "user" ? "the user" : name(entry.by) ?? entry.by) + ")");
    lines.push("");
  }
  return lines.join("\n");
}
export type { ContextFile };
