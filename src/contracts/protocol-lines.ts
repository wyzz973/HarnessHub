import type { ReadTurn } from "./protocol-read.js";
import { STOP_REASON_WORDS, TURN_STATUS_WORDS } from "./protocol-words.js";

/*
 * The words a Turn's facts are written in, said once for every place that writes them (docs/proposals/protocol/hub-protocol.html §13): the
 * page's footer under a Turn, the line under its message box, its details, a notification and the Markdown export. Plain functions of the
 * protocol Turn; they take nothing from which Harness ran it. What a Turn does not report is left out, and never written as zero.
 */

/** A count in the short form a line reads it: 999, 20.8k, 1.2M. */
export function compact(value: number): string { return value >= 1_000_000 ? (value / 1_000_000).toFixed(1) + "M" : value >= 1000 ? (value / 1000).toFixed(1) + "k" : String(value); }
/**
 * Time spent on running work, updated every second (Motion board #03): "42 秒", then "1 分 05 秒", then "1 小时 02 分".
 * Whole seconds only, so the text changes once a second; show it with tabular figures (the page default) so it never jitters.
 */
export function elapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (hours > 0) return hours + " 小时 " + String(minutes).padStart(2, "0") + " 分";
  return minutes > 0 ? minutes + " 分 " + String(seconds).padStart(2, "0") + " 秒" : seconds + " 秒";
}
/**
 * The time a finished Turn took, in the words of the timer that counted it while it ran (Motion board #03): one decimal
 * under ten seconds ("3.6 秒"), then whole seconds as the timer last showed them ("42 秒", "1 分 05 秒"). Both are cut,
 * never rounded up, so the total never reads more than the timer could have shown.
 */
export function spentText(milliseconds: number): string {
  return milliseconds < 10_000 ? (Math.floor(Math.max(0, milliseconds) / 100) / 10).toFixed(1) + " 秒" : elapsed(milliseconds);
}

/** An amount in its own currency as it is read in a line: "US$0.87", "¥0.21", "EUR 3.06". Two decimals, more only for a small amount. */
export function moneyText(cost: { readonly amount: number; readonly currency: string }): string {
  const symbol = cost.currency === "USD" ? "US$" : cost.currency === "CNY" ? "¥" : cost.currency + " ";
  if (cost.amount >= 0.01 || cost.amount === 0) return symbol + cost.amount.toFixed(2);
  const fine = cost.amount.toFixed(4).replace(/0+$/u, "");
  return symbol + ((fine.split(".")[1] ?? "").length < 2 ? cost.amount.toFixed(2) : fine);
}

/**
 * The cost as a line says it, or null when a line should not say it: none reported, none spent (a free model reports an amount of 0, which is
 * not a cost to write), or a Turn's own cost, which the footer does not write. `session` is what the native session the Turn ran in has cost
 * so far, which most Harnesses report; `conversation` is a total the Hub itself keeps.
 */
export function costWords(cost: { readonly amount: number; readonly currency: string; readonly scope: "turn" | "session" | "conversation" } | undefined): string | null {
  if (cost === undefined || !(cost.amount > 0)) return null;
  if (cost.scope === "conversation") return "对话累计 " + moneyText(cost);
  return cost.scope === "session" ? "会话累计 " + moneyText(cost) : null;
}

/**
 * What a Turn's footer says after who ran it and with which model: how long it took, what it read in and wrote out, and the cost so far. Nothing
 * is written that the Turn did not report: no tokens unless the Hub counted the whole Turn, no cost unless something was spent.
 */
export function turnFacts(turn: Pick<ReadTurn, "usage" | "durationMs">): readonly string[] {
  const { usage } = turn, parts: string[] = [];
  if (turn.durationMs !== undefined) parts.push("用时 " + spentText(turn.durationMs));
  if (usage.completeness === "complete") {
    if (usage.input !== undefined) parts.push("输入 " + compact(usage.input));
    if (usage.output !== undefined) parts.push("输出 " + compact(usage.output));
  }
  const cost = costWords(usage.cost);
  if (cost !== null) parts.push(cost);
  return parts;
}
/**
 * The footer under a Turn, one way for every Harness: who ran it, with which model, how long it took, what it read in and wrote
 * out: "DeepSeek Harness · DeepSeek Flash · 用时 16 秒 · 输入 20.8k · 输出 684". The cost only when it is the conversation's or the
 * native session's so far ("对话累计 US$0.87"), last.
 */
export function turnFooter(turn: Pick<ReadTurn, "executor" | "usage" | "durationMs">): string {
  return [turn.executor.harness, turn.executor.model?.label, ...turnFacts(turn)].filter(Boolean).join(" · ");
}

/**
 * How a Turn stands and, when it ended otherwise than by finishing, why, in the table's sentence: "已停止 · 你停止了这一轮". A reason that
 * only points at the error item ("见这一轮的错误条目") or says nothing was reported is not written, and an unknown outcome says what that
 * means for the user instead.
 */
export function statusText(turn: Pick<ReadTurn, "status" | "stopReason">): string {
  const reason = turn.status === "unknown" ? "可能已经执行，不会自动重发" : turn.stopReason === undefined || turn.stopReason === "end_turn" || turn.stopReason === "error" || turn.stopReason === "unknown" ? null : STOP_REASON_WORDS[turn.stopReason];
  return [TURN_STATUS_WORDS[turn.status], reason].filter(Boolean).join(" · ");
}
