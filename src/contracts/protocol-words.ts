import type { ItemStatus, StopReason, TurnStatus } from "./protocol.js";
import type { RunStatus } from "./session.js";

/*
 * The words for a state, said once for the whole interface (docs/proposals/protocol/hub-protocol.html §4, §5, decided 2026-11-12):
 * the page, its sidebar and header, the exports and the notifications take their state words from these tables and write no
 * others. How a state is explained (the cause of a stop, the step a wait is about) is said beside the word, never instead of it.
 */

/** An item's state: an action, a thought, an approval. */
export const ITEM_STATUS_WORDS: Readonly<Record<ItemStatus, string>> = {
  pending: "等待开始", running: "进行中", waiting: "等你处理", completed: "已完成", failed: "失败", declined: "已拒绝", cancelled: "已停止", unknown: "结果未知",
};

/** A Turn's state. */
export const TURN_STATUS_WORDS: Readonly<Record<TurnStatus, string>> = {
  queued: "排队中", preparing: "准备中", running: "进行中", waiting: "等你处理", completed: "已完成", failed: "失败", cancelled: "已停止", unknown: "结果未知",
};

/** A stored Run's state in the Turn's words: while its program is being closed (`settling`) the Turn is still running. */
export const RUN_STATUS_WORDS: Readonly<Record<RunStatus, string>> = {
  queued: TURN_STATUS_WORDS.queued, preparing: TURN_STATUS_WORDS.preparing, running: TURN_STATUS_WORDS.running, settling: TURN_STATUS_WORDS.running,
  completed: TURN_STATUS_WORDS.completed, cancelled: TURN_STATUS_WORDS.cancelled, failed: TURN_STATUS_WORDS.failed, unknown: TURN_STATUS_WORDS.unknown,
};

/** Why a Turn ended, in one sentence; null where nothing needs saying (a Turn that simply ended). */
export const STOP_REASON_WORDS: Readonly<Record<StopReason, string | null>> = {
  end_turn: null, user_stopped: "你停止了这一轮", max_tokens: "输出达到上限，没有说完", max_steps: "步数达到上限", refusal: "模型拒绝了这个请求",
  budget: "超过了这一轮的时间上限", cleared: "已清空，下一条消息开新会话", error: "见这一轮的错误条目", unknown: "没有拿到结束原因",
};
