import type { Conversation, ConversationReader } from "../contracts/conversation.js";
import type { PlanStep } from "../contracts/protocol.js";
import type { BoardEntry, RunId, SessionId, TaskBoard } from "../contracts/session.js";
import { boardAuthor, boardAuthority } from "../contexts/session/domain/board-words.js";
import { estimateTokens } from "../contexts/session/domain/relay/budget.js";
import { turnSource } from "../contexts/session/domain/turn-source.js";
import { taskFamily, taskLabel, type FamilyStore } from "./task-family.js";

/**
 * The state of a task as one of its conversations stands in it (docs/decisions/LOG.md, 2026-11-13): what a Harness must hold to go on with the work, as a process control
 * block holds what a process needs to run again — why it is being done (the goal, and for delegated work the chain of tasks down to this one), what holds throughout (the
 * board), where it stands (the task list, the latest Turn's wrap-up), the files in play, what is not settled, and the user's words. Put together by the Hub from the
 * record alone: nothing here is asked of a model, so it does not depend on one having remembered. It is said whole wherever a Harness may not hold it any more (a Harness
 * that takes the conversation over, one that comes back to it, one whose own session was compacted): a state said again is the same state, where a change said again
 * would be a change twice. Nothing in it is cut inside (2026-11-14): what it carries it carries as written, and what it does not carry it names by its address.
 */
export interface StateStore extends FamilyStore, Pick<ConversationReader, "head" | "turnAt" | "runOrdinal"> {
  latestPlan?(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: { readonly fields: unknown } } | null;
  latestRecap?(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: { readonly fields: unknown } } | null;
  changedFiles?(id: SessionId): readonly string[];
}
const MARK = { completed: "[x]", in_progress: "[~]", pending: "[ ]" } as const;
const BOARD_WORDS = { constraint: "约束", decision: "决定", note: "备注" } as const;
const ENDED = { failed: "失败", cancelled: "被停止", unknown: "结果未知" } as const;
const SETTLED = new Set(["completed", "failed", "cancelled", "unknown"]);
/** A text as it was written, its lines after the first set under the line it stands in by `pad`. */
const indented = (text: string, pad: string): string => text.trim().replace(/\r\n?/gu, "\n").split("\n").join("\n" + pad);

/**
 * How much of the user's words of the conversation the state carries (2026-11-14). A number: what they may take, in estimated tokens — the share a handoff to this
 * Harness would give them, where no packet goes with the state: the messages newest first, each whole, as many as fit, and the latest whatever it takes. `latest`: the
 * latest message alone (STATE.md). `none`: a packet goes with the state and carries them.
 */
export type StateWords = number | "latest" | "none";

/** What the state is made of, gathered from the record: each part absent when the record holds nothing for it. */
export interface TaskState {
  readonly label: string;
  /** The task's goal: the board's, else the first words of the conversation the task began in (`own`: that is this conversation). */
  readonly goal: { readonly text: string; readonly from: "board"; readonly entry: BoardEntry } | { readonly text: string; readonly from: "first"; readonly own: boolean } | null;
  /** For delegated work: the conversations it came down through, the one the task began in first, each with what it was asked. */
  readonly chain: readonly { readonly label: string; readonly harness: string; readonly task: string }[];
  readonly board: TaskBoard;
  readonly plan: { readonly steps: readonly PlanStep[]; readonly harness: string; readonly turn: number } | null;
  /** For delegated work with no Turn of its own yet: what the conversation it came from had come to when it handed the work over (its latest finished Turn then). */
  readonly origin: { readonly label: string; readonly turn: number; readonly harness: string; readonly said: string; readonly recap: boolean } | null;
  /** The latest finished Turn: its wrap-up when its Harness gave one, else its reply. */
  readonly last: { readonly turn: number; readonly harness: string; readonly status: string; readonly said: string; readonly recap: boolean } | null;
  /** The files this conversation changed, and those the other conversations of the task changed. */
  readonly files: { readonly own: readonly string[]; readonly others: readonly { readonly label: string; readonly harness: string; readonly files: readonly string[] }[] };
  /** Work it handed over that still runs. */
  readonly running: readonly { readonly label: string; readonly harness: string; readonly task: string }[];
  /**
   * The user's words of this conversation the state carries, newest first, each whole: before the Turn that starts now, or up to the Turn in progress (`now`) and those
   * queued after it. `earlier`: how many Turns before the oldest of them are not carried.
   */
  readonly words: { readonly said: readonly { readonly turn: number; readonly text: string; readonly now: "running" | "queued" | null }[]; readonly earlier: number };
}

/**
 * Gathers the state of the task as the conversation `id` stands in it. `upTo`: the Turn that starts now (its words are the message itself, not the state); absent: as
 * it stands now, the Turn in progress with it. `words`: how much of the user's words it carries.
 */
export function taskState(store: StateStore, id: SessionId, name: (harnessId: string) => string | null, board: TaskBoard, upTo?: RunId, words: StateWords = "none"): TaskState {
  const named = (harnessId: string) => name(harnessId) ?? harnessId;
  const conversation: Conversation = store.get(id), turns = turnSource(store, id);
  const before = upTo === undefined ? conversation.runs.length : Math.max(0, conversation.runs.findIndex(run => run.id === upTo));
  // The chain of delegations up to where the task began.
  const up: { id: SessionId; conversation: Conversation }[] = [];
  for (let at: SessionId | undefined = conversation.delegation?.parentId, hops = 0; at !== undefined && hops < 16; hops++) {
    let parent: Conversation; try { parent = store.get(at); } catch { break; }
    up.unshift({ id: at, conversation: parent }); at = parent.delegation?.parentId;
  }
  const first = (session: SessionId): string => { try { return (turnSource(store, session).turn(0)?.user.text ?? "").trim(); } catch { return ""; } };
  const root = up[0]?.id ?? id, goalEntry = board.entries.filter(entry => entry.kind === "goal").at(-1), opening = first(root);
  const goal: TaskState["goal"] = goalEntry !== undefined ? { text: goalEntry.text, from: "board", entry: goalEntry }
    : opening !== "" && (up.length > 0 || before > 0) ? { text: opening, from: "first", own: root === id } : null;
  const chain = up.length === 0 ? [] : [...up.slice(1).map(entry => ({ label: taskLabel(entry.id), harness: named((entry.conversation.runs.at(-1) ?? entry.conversation).selection.harnessId), task: first(entry.id) })),
    { label: taskLabel(id), harness: named((conversation.runs.at(-1) ?? conversation).selection.harnessId), task: first(id) }];
  // Where it stands: the task list, and what the latest finished Turn before this one came to.
  let plan: TaskState["plan"] = null, last: TaskState["last"] = null;
  try {
    const found = store.latestPlan?.(id) ?? null, fields = found?.row.fields as { readonly type?: string; readonly steps?: readonly PlanStep[] } | undefined;
    if (found !== null && fields?.type === "plan" && Array.isArray(fields.steps) && fields.steps.length > 0) plan = { steps: fields.steps, harness: named(found.harnessId), turn: found.ordinal + 1 };
  } catch { /* told without a list */ }
  for (let ordinal = before - 1; ordinal >= 0 && last === null; ordinal--) {
    const run = conversation.runs[ordinal]!;
    if (!SETTLED.has(run.status)) continue;
    let said = "", recap = false;
    try {
      const found = store.latestRecap?.(id) ?? null, fields = found?.row.fields as { readonly type?: string; readonly summary?: string } | undefined;
      if (found !== null && found.ordinal === ordinal && fields?.type === "recap" && typeof fields.summary === "string") { said = fields.summary.trim(); recap = true; }
      else said = (turns.turn(ordinal)?.assistant?.text ?? "").trim();
    } catch { /* told without its words */ }
    last = { turn: ordinal + 1, harness: named(run.selection.harnessId), status: run.status, said, recap };
  }
  // The files in play, and the work handed over that still runs: from the task's conversations as the family tells them.
  // Work just handed over has no Turn of its own: where the conversation it came from stood then (the Turn the delegation followed; one before, when its Harness delegated within its own Turn).
  let origin: TaskState["origin"] = null;
  const parent = up.at(-1);
  if (parent !== undefined && last === null && conversation.delegation !== undefined) {
    const runs = parent.conversation.runs, at = runs.findIndex(run => run.id === conversation.delegation!.afterRunId), through = at < 0 ? runs.length - 1 : conversation.delegation.by === "harness" ? at - 1 : at;
    for (let ordinal = through; ordinal >= 0 && origin === null; ordinal--) {
      const run = runs[ordinal]!;
      if (!SETTLED.has(run.status)) continue;
      let said = "", recap = false;
      try {
        const found = store.latestRecap?.(parent.id) ?? null, fields = found?.row.fields as { readonly type?: string; readonly summary?: string } | undefined;
        if (found !== null && found.ordinal === ordinal && fields?.type === "recap" && typeof fields.summary === "string") { said = fields.summary.trim(); recap = true; }
        else said = (turnSource(store, parent.id).turn(ordinal)?.assistant?.text ?? "").trim();
      } catch { /* told without its words */ }
      origin = { label: taskLabel(parent.id), turn: ordinal + 1, harness: named(run.selection.harnessId), said, recap };
    }
  }
  // A file is told once, by its path inside the workspace (a Harness names it whole, the Hub's own record of the workspace from the workspace on).
  const tidy = (files: readonly string[], workspace: string): string[] => {
    const prefix = workspace.endsWith("/") ? workspace : workspace + "/";
    return [...new Set(files.map(path => path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path))];
  };
  const workspaceOf = (session: SessionId): string => { try { return store.get(session).configuration.workspace; } catch { return ""; } };
  let own: readonly string[] = []; try { own = tidy(store.changedFiles?.(id) ?? [], conversation.configuration.workspace); } catch { own = []; }
  const members = taskFamily(store, id, name), self = taskLabel(id);
  const others = members.filter(member => member.sessionId !== id && member.files.length > 0).map(member => ({ label: member.label, harness: member.harness, files: tidy(member.files, workspaceOf(member.sessionId)) }));
  // The family tells a task in short; the state tells it whole, from the conversation's first words.
  const running = members.filter(member => member.parent === self && member.status === "running").map(member => ({ label: member.label, harness: member.harness, task: first(member.sessionId) }));
  // The user's words, newest first, each as it was said: as many as the budget holds, and the latest whatever it takes; those before are named by where they are.
  const said: { turn: number; text: string; now: "running" | "queued" | null }[] = [];
  let earlier = 0;
  if (words !== "none") {
    let spent = 0;
    for (let ordinal = before - 1; ordinal >= 0; ordinal--) {
      let text = "";
      try { text = (turns.turn(ordinal)?.user.text ?? "").trim(); } catch { text = ""; }
      if (text === "") continue;
      const cost = estimateTokens(text);
      if (said.length > 0 && (words === "latest" || spent + cost > words)) { earlier = ordinal + 1; break; }
      const status = conversation.runs[ordinal]!.status;
      said.push({ turn: ordinal + 1, text, now: SETTLED.has(status) ? null : status === "queued" ? "queued" : "running" });
      spent += cost;
    }
  }
  return { label: taskLabel(id), goal, chain, board, plan, origin, last, files: { own, others }, running, words: { said, earlier } };
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

/**
 * Who reads the state, which decides how it names what it does not carry. A directory (`dir`, the conversation's own `self` inside it): a Harness that reads the record
 * as files, the conversation's own. `inside`: the conversation's STATE.md, read by whoever opens it; its paths stand on the task's directory. None: a Harness that reads
 * the record with the Hub's tools.
 */
export type StateReader = { readonly dir: string; readonly self: string } | "inside";
/** The state as a Harness reads it. `record`: where the record's directory is, when this Harness reads it as files (the addresses then stand on it). */
export function stateText(state: TaskState, name: (harnessId: string) => string | null, record?: StateReader, scope: StateScope = "whole"): string {
  const lines: string[] = [], whole = scope === "whole", files = record !== undefined;
  const author = (entry: BoardEntry) => boardAuthor(entry, harnessId => name(harnessId) ?? harnessId, files);
  // The goal from the first words is not said twice: where those words are among the user's words carried below, they say it.
  const goalSaid = state.goal?.from === "first" && state.goal.own && state.words.said.some(entry => entry.turn === 1);
  if (state.goal !== null && !goalSaid && (whole || state.goal.from === "board"))
    lines.push("目标（" + (state.goal.from === "first" ? "这件事起头时用户的原话" : author(state.goal.entry)) + "）：" + indented(state.goal.text, "  "));
  if (state.chain.length > 0) {
    lines.push("这段活是一层层交下来的：");
    state.chain.forEach((link, index) => lines.push("  ".repeat(index + 1) + "→ " + link.harness + "（" + link.label + (index === state.chain.length - 1 ? "，就是你这段对话" : "") + "）被交代："
      + indented(link.task, "  ".repeat(index + 2))));
  }
  const kept = (["constraint", "decision", "note"] as const).flatMap(kind => state.board.entries.filter(entry => entry.kind === kind).map(entry => "- " + BOARD_WORDS[kind] + "：" + indented(entry.text, "  ") + "（" + author(entry) + "）"));
  // The board as it is now is the whole of it: what stood on it before and is not here was taken off.
  if (kept.length > 0) lines.push("一直要遵守的（任务板现在的全部内容；之前出现过、这里没有的已经撤下）。" + boardAuthority(files), ...kept);
  if (whole && state.origin !== null && state.origin.said !== "") lines.push("交出这段活之前，原对话（" + state.origin.label + "）的上一轮（第 " + state.origin.turn + " 轮，" + state.origin.harness + "）"
    + (state.origin.recap ? "的小结：" : "的回复：") + indented(state.origin.said, "  "));
  if (whole && state.plan !== null) lines.push("做到哪（" + state.plan.harness + " 在第 " + state.plan.turn + " 轮列的清单）：", ...state.plan.steps.map(step => "  " + MARK[step.status] + " " + indented(step.text, "      ")));
  if (whole && state.last !== null) lines.push("上一轮（第 " + state.last.turn + " 轮，" + state.last.harness + (state.last.status === "completed" ? "" : "，" + ENDED[state.last.status as keyof typeof ENDED] + "：动手前先核对它做到了哪一步，不要照着重做")
    + "）" + (state.last.said === "" ? "没有留下文字。" : (state.last.recap ? "的小结：" : "的回复：") + indented(state.last.said, "  ")));
  const listed = (files: readonly string[]) => files.slice(0, 30).join("、") + (files.length > 30 ? " 等 " + files.length + " 个" : "");
  if (whole && state.files.own.length > 0) lines.push("这段对话改过的文件：" + listed(state.files.own));
  for (const other of state.files.others) lines.push(other.harness + "（" + other.label + "）改过的文件：" + listed(other.files));
  for (const work of state.running) lines.push("交出去还在做的：" + work.harness + "（" + work.label + "）" + indented(work.task, "  "));
  if (whole && state.words.said.length > 0) {
    lines.push("用户在这段对话里说的话（原话，新的在前）：", ...state.words.said.map(entry => "- 第 " + entry.turn + " 轮" + (entry.now === "running" ? "（就是手上这一轮）" : entry.now === "queued" ? "（排着队，还没开始）" : "") + "：" + indented(entry.text, "  ")));
    const n = state.words.earlier;
    if (n > 0) lines.push("更早的 " + n + " 轮里用户说的话没有放在这里" + (record === "inside" ? "：每轮一条在同一目录的 index.md，全文在 turns/NNN.md。"
      : record !== undefined ? "：每轮一条在 " + record.dir + "/" + record.self + "/index.md，全文在 " + record.self + "/turns/NNN.md。" : "，用 harnesshub 的 hub_turns 列出、用 hub_read_turn 读全文。"));
  }
  const where = record === undefined ? "" : record === "inside" ? "文中的路径都相对于这件任务的记录目录（这个文件的上一级目录）。"
    : "完整记录在 " + record.dir + " ，你这段对话是其中的 " + record.self + "/（index.md 每轮一条，turns/NNN.md 是每一轮的全文）。";
  return "（HarnessHub：这件任务现在的状态，由 HarnessHub 从记录里整理，不是用户新说的话。你对之前的印象和它不一致时，以它和工作区的实际状态为准。" + where + "\n" + lines.join("\n") + "\n）";
}
