import type { FileChangeItem, PlanItem, SubagentItem, WorkItem } from "../../../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../../../src/contracts/protocol-read.js";
import { costWords, statusText } from "../../../../src/contracts/protocol-lines.js";
import { TURN_STATUS_WORDS } from "../../../../src/contracts/protocol-words.js";
import type { TurnStatus } from "../../../../src/contracts/protocol.js";
import type { PublicRun } from "../../../../src/contracts/session.js";
import { compact, elapsed, spentText } from "../format.js";
import { moneyText } from "../../../../src/contracts/protocol-lines.js";
import { isWork, turnOver } from "./work.js";

/*
 * What the page reads of a conversation's Runs, from their protocol Turns alone (docs/proposals/protocol/hub-protocol.html §13): the task
 * list, the actions counted, the files changed, the work handed to others, and the numbers a Turn's line, the line under the message box
 * and the details panel each say. One reading of each, so the same Turn gives the same words and the same numbers wherever it is shown;
 * what a Turn does not report is left out, and never filled in. Plain functions of the items.
 */

/** A Run whose protocol Turn the page could read. */
export type TurnRun = PublicRun & { readonly protocol: ReadTurn };
export function hasTurn(run: PublicRun | undefined): run is TurnRun { return run?.protocol !== undefined; }

/** The task list of the latest Turn that has one with steps, and that Turn's Run. */
export function latestPlan(runs: readonly PublicRun[]): { readonly run: TurnRun; readonly plan: PlanItem } | undefined {
  for (const run of [...runs].reverse()) {
    if (!hasTurn(run)) continue;
    const plan = run.protocol.items.findLast((item): item is PlanItem => item.type === "plan" && item.steps.length > 0);
    if (plan !== undefined) return { run, plan };
  }
  return undefined;
}
/** The task list of one Turn, when it has one. */
export function planOf(turn: ReadTurn): PlanItem | undefined { return turn.items.findLast((item): item is PlanItem => item.type === "plan" && item.steps.length > 0); }

/** Whether an item happened inside a delegated task (its parent is one of the Turn's tasks). */
function inside(item: ReadItem, tasks: ReadonlySet<string>): boolean { return item.parentId !== undefined && tasks.has(item.parentId); }
function tasksOf(turn: ReadTurn): ReadonlySet<string> { return new Set(turn.items.filter(item => item.type === "subagent").map(item => item.id)); }

/** The actions the Turn itself took: the ones it listed, not what its delegated tasks did inside. */
export function ownWork(turn: ReadTurn): readonly WorkItem[] {
  const tasks = tasksOf(turn);
  return turn.items.filter((item): item is WorkItem => isWork(item) && !inside(item, tasks));
}
/** How many actions the Turn itself took. */
export function stepCount(turn: ReadTurn): number { return ownWork(turn).length; }
/** When a Turn that is over ended, from when it began and how long it took; unknown when either is. */
export function endedAt(turn: Pick<ReadTurn, "startedAt" | "durationMs">): number | undefined { return turn.startedAt === undefined || turn.durationMs === undefined ? undefined : turn.startedAt + turn.durationMs; }
/** The edits of a Turn that carry a stored detail, which is where their diff is: the places the conversation's changes are counted by. */
export function editsOf(turn: ReadTurn): readonly FileChangeItem[] { return turn.items.filter((item): item is FileChangeItem => item.type === "file_change" && item.detail !== undefined); }
/** How many changes some Turns made, counted as places, known without reading any detail. */
export function changeCount(runs: readonly PublicRun[]): number { return runs.reduce((count, run) => count + (run.protocol === undefined ? 0 : editsOf(run.protocol).length), 0); }
/** Work the Turn handed to others: its delegated tasks. */
export function tasksHanded(turn: ReadTurn): readonly SubagentItem[] { return turn.items.filter((item): item is SubagentItem => item.type === "subagent"); }

export { statusText };
/** How the Turn stands, in the one table's word. */
export function statusWord(turn: Pick<ReadTurn, "status">): string { return TURN_STATUS_WORDS[turn.status]; }
/** Whether the Turn is over. */
export function over(turn: Pick<ReadTurn, "status">): boolean { return turnOver(turn); }
/** A Run's state as a Turn's: the Turn's own when the page could read it, else the stored Run's (whose closing phase is the Turn still running). */
export function stateOf(run: Pick<PublicRun, "protocol" | "status">): TurnStatus { return run.protocol?.status ?? (run.status === "settling" ? "running" : run.status); }
/** Whether the user stopped this Run's Turn: its reason says so. A stop the Hub made itself (a time limit, a restart) is not the user's. */
export function userStopped(run: PublicRun | undefined): boolean { return run?.protocol?.stopReason === "user_stopped"; }

/** One part of the line under the message box: its words, and the share of the context it stands for when it draws that as a ring. */
export interface StatusPart { readonly text: string; readonly share?: number }
/**
 * The line under the message box: the Turn's place in the conversation, its actions, its time and the numbers it reported, in the words of
 * the Turn's footer. `now` counts the time of a Turn that goes on, in whole seconds as the Turn's own timer does; without it a Turn that has not
 * ended says no time. Only what the Turn reports
 * is written: input only when the Hub counted the whole Turn, the context share only when the Harness gave its size, the cost under its scope
 * and only when something was spent.
 */
export function statusParts(turn: ReadTurn, now?: number): readonly StatusPart[] {
  const parts: StatusPart[] = [{ text: `第 ${turn.n} 轮` }], steps = stepCount(turn);
  if (steps > 0) parts.push({ text: `${steps} 步` });
  if (turn.durationMs !== undefined) parts.push({ text: "用时 " + spentText(turn.durationMs) });
  else if (now !== undefined && !over(turn) && turn.startedAt !== undefined) parts.push({ text: "已用 " + elapsed(now - turn.startedAt) });
  if (turn.usage.completeness === "complete" && turn.usage.input !== undefined) parts.push({ text: `输入 ${compact(turn.usage.input)}` });
  const context = turn.usage.context;
  if (context !== undefined) {
    const share = context.size ? Math.min(100, Math.round(context.used / context.size * 100)) : undefined;
    parts.push(share === undefined ? { text: `上下文 ${compact(context.used)}` } : { text: `上下文 ${share}%`, share });
  }
  const cost = costWords(turn.usage.cost);
  if (cost !== null) parts.push({ text: cost });
  return parts;
}

/**
 * The numbers of a Turn as the details' execution page lists them, label and value: the tokens read in and written out (only when the Hub
 * counted the whole Turn), how much of the context is used, and the cost under its scope. A Turn that reports none gives no row.
 */
export function usageFacts(turn: Pick<ReadTurn, "usage">): readonly (readonly [string, string])[] {
  const { usage } = turn, facts: (readonly [string, string])[] = [];
  if (usage.completeness === "complete" || usage.completeness === "partial") {
    const numbers = [["输入", usage.input], ["其中缓存", usage.cachedInput], ["输出", usage.output]].filter((row): row is [string, number] => row[1] !== undefined)
      .map(([label, value]) => label + " " + value.toLocaleString());
    // A count that may cover less than the Turn is not given as its total.
    if (numbers.length) facts.push([usage.completeness === "complete" ? "本轮用量" : "本轮用量（可能不全）", numbers.join(" · ")]);
  }
  if (usage.context) facts.push(["上下文", usage.context.used.toLocaleString() + (usage.context.size ? " / " + usage.context.size.toLocaleString() + " tokens（" + Math.round(usage.context.used / usage.context.size * 100) + "%）" : " tokens")]);
  // A free model reports an amount of 0: that is not a cost to write.
  if (usage.cost !== undefined && usage.cost.amount > 0) facts.push(["费用", moneyText(usage.cost) + " · " + (usage.cost.scope === "turn" ? "本轮" : usage.cost.scope === "session" ? "原生会话累计" : "整个对话累计")]);
  return facts;
}
