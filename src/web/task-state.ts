import type { Conversation, ConversationReader } from "../contracts/conversation.js";
import type { PlanStep } from "../contracts/protocol.js";
import type { RunId, SessionId, TaskBoard } from "../contracts/session.js";
import { turnSource } from "../contexts/session/domain/turn-source.js";
import { taskFamily, taskLabel, type FamilyStore } from "./task-family.js";

/**
 * The state of a task as one of its conversations stands in it (docs/decisions/LOG.md, 2026-11-13): what a Harness must hold to go on with the work, as a process control
 * block holds what a process needs to run again — why it is being done (the goal, and for delegated work the chain of tasks down to this one), what holds throughout (the
 * board), where it stands (the task list, the latest Turn's wrap-up), the files in play, what is not settled, and the user's latest words. Put together by the Hub from the
 * record alone: nothing here is asked of a model, so it does not depend on one having remembered. It is small, and said whole wherever a Harness may not hold it any more
 * (a Harness that takes the conversation over, one that comes back to it, one whose own session was compacted): a state said again is the same state, where a change said
 * again would be a change twice.
 */
export interface StateStore extends FamilyStore, Pick<ConversationReader, "head" | "turnAt" | "runOrdinal"> {
  latestPlan?(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: { readonly fields: unknown } } | null;
  latestRecap?(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: { readonly fields: unknown } } | null;
  changedFiles?(id: SessionId): readonly string[];
}
const clip = (text: string, most: number): string => { const flat = text.replace(/\s+/gu, " ").trim(), units = [...flat]; return units.length > most ? units.slice(0, most).join("") + "…" : flat; };
const MARK = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
const BOARD_WORDS = { constraint: "约束", decision: "决定", note: "备注" } as const;
const ENDED = { failed: "失败", cancelled: "被停止", unknown: "结果未知" } as const;

/** What the state is made of, gathered from the record: each part absent when the record holds nothing for it. */
export interface TaskState {
  readonly label: string;
  /** The task's goal: the board's, else the first words of the conversation the task began in. */
  readonly goal: { readonly text: string; readonly from: "board" | "first" } | null;
  /** For delegated work: the conversations it came down through, the one the task began in first, each with what it was asked. */
  readonly chain: readonly { readonly label: string; readonly harness: string; readonly task: string }[];
  readonly board: TaskBoard;
  readonly plan: { readonly steps: readonly PlanStep[]; readonly harness: string; readonly turn: number } | null;
  /** The latest finished Turn: its wrap-up when its Harness gave one, else the beginning of its reply. */
  readonly last: { readonly turn: number; readonly harness: string; readonly status: string; readonly said: string; readonly recap: boolean } | null;
  /** The files this conversation changed, and those the other conversations of the task changed. */
  readonly files: { readonly own: readonly string[]; readonly others: readonly { readonly label: string; readonly harness: string; readonly files: readonly string[] }[] };
  /** Work it handed over that still runs. */
  readonly running: readonly { readonly label: string; readonly harness: string; readonly task: string }[];
  /** The user's words of the latest Turns before the one that starts now, oldest first. */
  readonly words: readonly { readonly turn: number; readonly text: string }[];
}

/** Gathers the state of the task as the conversation `id` stands in it. `upTo`: the Turn that starts now (its words are the message itself, not the state). */
export function taskState(store: StateStore, id: SessionId, name: (harnessId: string) => string | null, board: TaskBoard, upTo?: RunId): TaskState {
  const named = (harnessId: string) => name(harnessId) ?? harnessId;
  const conversation: Conversation = store.get(id), turns = turnSource(store, id);
  const before = upTo === undefined ? conversation.runs.length : Math.max(0, conversation.runs.findIndex(run => run.id === upTo));
  // The chain of delegations up to where the task began.
  const up: { id: SessionId; conversation: Conversation }[] = [];
  for (let at: SessionId | undefined = conversation.delegation?.parentId, hops = 0; at !== undefined && hops < 16; hops++) {
    let parent: Conversation; try { parent = store.get(at); } catch { break; }
    up.unshift({ id: at, conversation: parent }); at = parent.delegation?.parentId;
  }
  const first = (session: SessionId): string => { try { return turnSource(store, session).turn(0)?.user.text ?? ""; } catch { return ""; } };
  const root = up[0]?.id ?? id, goalEntry = board.entries.filter(entry => entry.kind === "goal").at(-1), opening = first(root);
  const goal = goalEntry !== undefined ? { text: goalEntry.text, from: "board" as const } : opening.trim() !== "" && (up.length > 0 || before > 0) ? { text: clip(opening, 400), from: "first" as const } : null;
  const chain = up.length === 0 ? [] : [...up.slice(1).map(entry => ({ label: taskLabel(entry.id), harness: named((entry.conversation.runs.at(-1) ?? entry.conversation).selection.harnessId), task: clip(first(entry.id), 300) })),
    { label: taskLabel(id), harness: named((conversation.runs.at(-1) ?? conversation).selection.harnessId), task: clip(first(id), 600) }];
  // Where it stands: the task list, and what the latest finished Turn before this one came to.
  let plan: TaskState["plan"] = null, last: TaskState["last"] = null;
  try {
    const found = store.latestPlan?.(id) ?? null, fields = found?.row.fields as { readonly type?: string; readonly steps?: readonly PlanStep[] } | undefined;
    if (found !== null && fields?.type === "plan" && Array.isArray(fields.steps) && fields.steps.length > 0) plan = { steps: fields.steps, harness: named(found.harnessId), turn: found.ordinal + 1 };
  } catch { /* told without a list */ }
  for (let ordinal = before - 1; ordinal >= 0 && last === null; ordinal--) {
    const run = conversation.runs[ordinal]!;
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "unknown") continue;
    let said = "", recap = false;
    try {
      const found = store.latestRecap?.(id) ?? null, fields = found?.row.fields as { readonly type?: string; readonly summary?: string } | undefined;
      if (found !== null && found.ordinal === ordinal && fields?.type === "recap" && typeof fields.summary === "string") { said = clip(fields.summary, 600); recap = true; }
      else said = clip(turns.turn(ordinal)?.assistant?.text ?? "", 400);
    } catch { /* told without its words */ }
    last = { turn: ordinal + 1, harness: named(run.selection.harnessId), status: run.status, said, recap };
  }
  // The files in play, and the work handed over that still runs: from the task's conversations as the family tells them.
  // A file is told once, by its path inside the workspace (a Harness names it whole, the Hub's own record of the workspace from the workspace on).
  const tidy = (files: readonly string[], workspace: string): string[] => {
    const prefix = workspace.endsWith("/") ? workspace : workspace + "/";
    return [...new Set(files.map(path => path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path))];
  };
  const workspaceOf = (session: SessionId): string => { try { return store.get(session).configuration.workspace; } catch { return ""; } };
  let own: readonly string[] = []; try { own = tidy(store.changedFiles?.(id) ?? [], conversation.configuration.workspace); } catch { own = []; }
  const members = taskFamily(store, id, name), self = taskLabel(id);
  const others = members.filter(member => member.sessionId !== id && member.files.length > 0).map(member => ({ label: member.label, harness: member.harness, files: tidy(member.files, workspaceOf(member.sessionId)) }));
  const running = members.filter(member => member.parent === self && member.status === "running").map(member => ({ label: member.label, harness: member.harness, task: clip(member.task, 200) }));
  // The user's latest words before this Turn (the latest three), as they were said.
  const words: { turn: number; text: string }[] = [];
  for (let ordinal = Math.max(0, before - 3); ordinal < before; ordinal++) {
    try { const text = (turns.turn(ordinal)?.user.text ?? "").trim(); if (text !== "") words.push({ turn: ordinal + 1, text: clip(text, 400) }); } catch { /* left out */ }
  }
  return { label: taskLabel(id), goal, chain, board, plan, last, files: { own, others }, running, words };
}

/**
 * How much of the state is said. `whole`: all of it. `task`: only what a handoff that carries the whole conversation does not already say — the chain the work came
 * down through, the board, what the other conversations of the task changed, the work handed over that still runs (the conversation's own Turns are in that handoff).
 */
export type StateScope = "whole" | "task";
/** Whether there is anything to say: a conversation's first Turn, with no task above it, an empty board and nothing done, has no state yet. */
export function hasState(state: TaskState, scope: StateScope = "whole"): boolean {
  const task = state.chain.length > 0 || state.board.entries.length > 0 || state.files.others.length > 0 || state.running.length > 0;
  return task || (scope === "whole" && (state.goal !== null || state.plan !== null || state.last !== null || state.files.own.length > 0));
}

/** The state as a Harness reads it. `record`: where the record's directory is, when this Harness reads it as files (the addresses then stand on it). */
export function stateText(state: TaskState, name: (harnessId: string) => string | null, record?: { readonly dir: string; readonly self: string }, scope: StateScope = "whole"): string {
  const lines: string[] = [], whole = scope === "whole";
  if (state.goal !== null && (whole || state.goal.from === "board")) lines.push("目标：" + state.goal.text + (state.goal.from === "first" ? "（这件事起头时用户的原话）" : ""));
  if (state.chain.length > 0) {
    lines.push("这段活是一层层交下来的：");
    state.chain.forEach((link, index) => lines.push("  ".repeat(index + 1) + "→ " + link.harness + "（" + link.label + (index === state.chain.length - 1 ? "，就是你这段对话" : "") + "）被交代：" + link.task));
  }
  const kept = (["constraint", "decision", "note"] as const).flatMap(kind => state.board.entries.filter(entry => entry.kind === kind).map(entry => "- " + BOARD_WORDS[kind] + "：" + entry.text + "（" + (entry.by === "user" ? "用户" : name(entry.by) ?? entry.by) + " 记）"));
  // The board as it is now is the whole of it: what stood on it before and is not here was taken off.
  if (kept.length > 0) lines.push("一直要遵守的（任务板现在的全部内容；之前出现过、这里没有的已经撤下）：", ...kept);
  if (whole && state.plan !== null) lines.push("做到哪（" + state.plan.harness + " 在第 " + state.plan.turn + " 轮列的清单）：", ...state.plan.steps.map(step => "  " + MARK[step.status] + " " + clip(step.text, 200)));
  if (whole && state.last !== null) lines.push("上一轮（第 " + state.last.turn + " 轮，" + state.last.harness + (state.last.status === "completed" ? "" : "，" + ENDED[state.last.status as keyof typeof ENDED] + "：动手前先核对它做到了哪一步，不要照着重做")
    + "）" + (state.last.said === "" ? "没有留下文字。" : (state.last.recap ? "的小结：" : "的回复开头：") + state.last.said));
  const listed = (files: readonly string[]) => files.slice(0, 30).join("、") + (files.length > 30 ? " 等 " + files.length + " 个" : "");
  if (whole && state.files.own.length > 0) lines.push("这段对话改过的文件：" + listed(state.files.own));
  for (const other of state.files.others) lines.push(other.harness + "（" + other.label + "）改过的文件：" + listed(other.files));
  for (const work of state.running) lines.push("交出去还在做的：" + work.harness + "（" + work.label + "）" + work.task);
  if (whole && state.words.length > 0) lines.push("用户最近说的：", ...state.words.map(entry => "- 第 " + entry.turn + " 轮：" + entry.text));
  const where = record === undefined ? "" : "完整记录在 " + record.dir + " ，你这段对话是其中的 " + record.self + "/（index.md 每轮一条，turns/NNN.md 是每一轮的全文）。";
  return "（HarnessHub：这件任务现在的状态，由 HarnessHub 从记录里整理，不是用户新说的话。你对之前的印象和它不一致时，以它和工作区的实际状态为准。" + where + "\n" + lines.join("\n") + "\n）";
}
