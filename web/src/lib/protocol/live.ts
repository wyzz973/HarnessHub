import type { WorkItem } from "../../../../src/contracts/protocol.js";
import type { ReadTurn } from "../../../../src/contracts/protocol-read.js";
import { TURN_STATUS_WORDS } from "../../../../src/contracts/protocol-words.js";
import type { PublicRun } from "../../../../src/contracts/session.js";
import { askingFor, isWork, workLabel } from "./work.js";

/*
 * What a Turn says about itself while it goes on and nothing else on the page says it: that it is queued or starting, that it thinks, that it
 * waits for you. From the protocol Turn's items and state alone, apart from the three facts of a Run that are not part of the Turn: that a
 * stop was asked for, that it waits for a change of selection to take effect, and when the program was handed the input (which is what the
 * words of a long silence are counted from).
 */

/**
 * What a queued Turn shows about what it waits for; no paths. It waits for a slot only when an operator limited how many
 * conversations run at once: how many run; there is no deadline of its own. (Conversations that share a workspace do not wait for each
 * other, 2026-11-12: the later Turn carries a notice.)
 */
export type QueueNotice = {
  readonly kind: "slot"; readonly running: number;
  readonly cancelling: boolean; readonly onCancel?: (() => void) | undefined;
};

/**
 * What a running Turn says it is doing (ADR-054 §3, Interaction board's states). `tone` picks the symbol: "run" a turning arc with the sweep
 * over the words, "wait" a still grey dot while it waits for you, "queue" the dashed circle of work not started. Queue explanations wrap
 * instead of sliding.
 */
export interface LiveStatus {
  readonly text: string;
  readonly tone: "run" | "wait" | "queue";
  /** The time since the input was accepted follows the words. */
  readonly timer: boolean;
  readonly wrap: boolean;
  /** Thinking: the words breathe after 3 s and change at 15, 30, 45 and 60 s (Motion board #04). */
  readonly thinking: boolean;
  /** Nothing needs saying: the reply is being written before the reader's eyes, or the Turn is only closing. The line is not drawn. */
  readonly quiet?: true;
}
const THINKING: readonly (readonly [number, string])[] = [[60_000, "快想好了"], [45_000, "想得更深"], [30_000, "再想想"], [15_000, "还在想"]];
function clip(text: string, limit = 80): string { const characters = [...text]; return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : text; }
const glue = (object: string): string => object.startsWith("“") ? "" : " ";

/** An action in the words of the voice its state gives it ("正在运行 git diff --stat"), its object cut to one line; `prefix` goes before the words ("想"). */
function said(item: WorkItem, status: "running" | "waiting", prefix = ""): string {
  const label = workLabel({ ...item, status });
  return prefix + (label.object === null ? label.verb : label.verb + glue(label.object) + clip(label.object));
}

export interface LiveInput {
  readonly turn: Pick<ReadTurn, "status" | "items" | "executor">;
  /** The facts of the Run that are not part of its Turn. */
  readonly run: Pick<PublicRun, "status" | "cancelRequested" | "awaitingSwitchId" | "timing">;
  readonly now: number;
  readonly startupHint?: { readonly seconds: number; readonly usual: boolean } | undefined;
  readonly queue?: QueueNotice | undefined;
  /** What the user is asked for: an approval waits in the message box's place, or a question in the Turn. */
  readonly waiting?: "approval" | "question" | undefined;
  /** The Turn has begun to answer: there is text of a reply. */
  readonly replying: boolean;
}

/**
 * What a Turn that goes on says now, and with which symbol. While an approval waits in the message box's place the line names the action
 * it asks for in the "想…" form ("想运行 rm -rf build"), grey and still with the timer, since nothing runs then; without such an action it says
 * "等你批准". While a question waits the line keeps naming the action in progress, else says "等你回答". A Turn that is queued says why it
 * waits; one that starts says which Harness it starts and how long that usually takes; one that runs names its action in progress, its
 * reply, or, when it has shown nothing yet, that it thinks, with words that change as the silence goes on.
 */
export function liveStatus(input: LiveInput): LiveStatus {
  const { turn, run, now, startupHint, queue, waiting } = input, harness = turn.executor.harness;
  const plain = { tone: "run" as const, timer: true, wrap: false, thinking: false };
  const running = turn.items.findLast((item): item is WorkItem => isWork(item) && item.status === "running");
  if (run.cancelRequested) return { ...plain, text: "正在停止并清理资源" };
  if (waiting === "approval") {
    const asking = askingFor(turn.items);
    return { ...plain, tone: "wait", text: asking === undefined ? "等你批准" : said(asking, "waiting", "想") };
  }
  if (waiting === "question") return running === undefined ? { ...plain, tone: "wait", text: "等你回答" } : { ...plain, text: said(running, "running") };
  // A Turn not started yet reads "排队中" wherever it is named; a longer explanation keeps its reason after it.
  const queued = { tone: "queue" as const, timer: false, wrap: true, thinking: false };
  if (turn.status === "queued") {
    if (run.awaitingSwitchId) return { ...queued, text: TURN_STATUS_WORDS.queued + "：等待选择切换生效" };
    if (queue?.kind === "slot") return { ...queued, text: `${TURN_STATUS_WORDS.queued}：${queue.running} 个对话正在执行，其中一个结束后自动开始` };
    return { ...queued, text: TURN_STATUS_WORDS.queued };
  }
  if (turn.status === "preparing") return { ...plain, text: "正在启动 " + harness + (startupHint !== undefined && startupHint.seconds >= 2 ? (startupHint.usual ? "（通常约 " : "（上次约 ") + Math.round(startupHint.seconds) + " 秒）" : "") };
  // The Turn is running while its program is closed; the phase has no word of its own in the protocol.
  if (run.status === "settling") return { ...plain, quiet: true, text: "正在结束执行" };
  if (turn.status === "waiting") return { ...plain, tone: "wait", text: TURN_STATUS_WORDS.waiting };
  if (turn.status === "running") {
    if (running !== undefined) return { ...plain, text: said(running, "running") };
    // Text being written says so itself (its end dot breathes). Text already written, with nothing running after it, is thought again.
    const last = turn.items.at(-1);
    if (last !== undefined && last.type === "assistant_message" && (last.status === "running" || last.status === "pending")) return { ...plain, quiet: true, text: "正在回复" };
    const timing = run.timing;
    if (timing !== undefined && timing.dispatchedAt === undefined) return { ...plain, text: "已连接 " + harness + "，正在发送" };
    const waited = timing?.dispatchedAt !== undefined && timing.firstOutputAt === undefined ? now - timing.dispatchedAt : 0;
    return { ...plain, thinking: true, text: THINKING.find(([after]) => waited >= after)?.[1] ?? "正在思考" };
  }
  return { ...plain, timer: false, text: TURN_STATUS_WORDS[turn.status] };
}
