import { ITEM_STATUS_WORDS, STOP_REASON_WORDS, TURN_STATUS_WORDS } from "../../../../src/contracts/protocol-words.js";
import type { ApprovalItem, Executor, ItemStatus, SwitchItem } from "../../../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../../../src/contracts/protocol-read.js";
import { turnOver } from "./work.js";

/*
 * The lines a Turn is wrapped in, each written one way (docs/proposals/protocol/hub-protocol.html §13): the footer under a Turn, the
 * line where another Harness or model took over, and the line that says why a Turn ended as it did. Plain functions of the
 * protocol's facts: they take nothing from which Harness ran the Turn.
 */

export { costWords, moneyText, turnFacts, turnFooter } from "../../../../src/contracts/protocol-lines.js";

export interface SwitchLine {
  /** The whole line as plain text: "Codex → Claude Code · 带上了之前 2 轮 · 未确认收到". */
  readonly text: string;
  /** The two sides: Harnesses, or, within one Harness, the two models. */
  readonly from: string; readonly to: string;
  /** Whether the two sides differ; when they do not, only the Harness's settings changed and the line draws no arrow. */
  readonly changed: boolean;
  /** "<从> → <到>", or "<Harness> 的设置已更换", or null when the same executor simply went on and the line says only what this message carried. */
  readonly head: string | null;
  /** What the new one was given, when that is worth saying. */
  readonly context: string | null;
  /** What is not as it should be about the delivery: 送达中, 未确认收到, 没有发出. */
  readonly flag: string | null;
  /** The rest, for a tooltip: a new session or the one before it, and how the delivery stands. */
  readonly details: string;
  /** The handoff packet to open from the line, when there is one. */
  readonly packetId: string | null;
  /** The delivery is in doubt or failed. */
  readonly attention: boolean;
}
const modelOf = (executor: Executor): string => executor.model?.label ?? "本机默认模型";
function carried(item: SwitchItem): string | null {
  const turns = item.turns;
  switch (item.context) {
    case "full": return turns === undefined ? "带上了之前的全部对话" : `带上了之前的全部 ${turns} 轮`;
    case "delta": return turns === undefined ? "带上了之前新增的部分" : `带上了之前 ${turns} 轮`;
    case "resend": return "又带了一次之前的内容";
    case "none": return "只发了原话";
    // The same native session went on with another model: nothing was carried, and nothing needs saying.
    case "native": return null;
    // A Run from before the relay recorded what it carried: nothing is known, so nothing is said.
    case "unknown": return null;
  }
}
const DELIVERY: Readonly<Record<NonNullable<SwitchItem["delivery"]>, { readonly flag: string | null; readonly detail: string }>> = {
  sending: { flag: "送达中", detail: "交接单送达中" }, confirmed: { flag: null, detail: "交接单已确认送达" },
  unconfirmed: { flag: "未确认收到", detail: "交接单未确认送达" }, not_sent: { flag: "没有发出", detail: "交接单没有送达" },
};

/**
 * The line where another Harness, or another model of the same one, took the conversation over, one way: "<从> → <到> · <带了什么>".
 * Within one Harness the two sides are its models. What was carried is said by how it was carried (all of it, what was missing, the
 * same again, only your words), nothing when the native session simply went on. A delivery not confirmed says so after it
 * ("未确认收到"); one that did not go says only that ("没有发出"), since saying also what it carried would claim it went. Whether
 * the session is new or the earlier one, and the delivery in full, are for the tooltip.
 */
export function switchLine(item: SwitchItem): SwitchLine {
  const same = item.from.harnessId === item.to.harnessId;
  const from = same ? modelOf(item.from) : item.from.harness, to = same ? modelOf(item.to) : item.to.harness, changed = from !== to;
  const delivery = item.delivery === undefined ? null : DELIVERY[item.delivery], gone = item.delivery === "not_sent";
  const context = gone ? null : carried(item), flag = delivery?.flag ?? null;
  // The Hub puts the same executor on both sides when nobody took over and the message still carried the conversation again, or
  // went alone: the line then says only that. With nothing carried to say, the same two sides mean the Harness's settings changed.
  const unchanged = same && (item.from.model?.id ?? null) === (item.to.model?.id ?? null);
  const head = changed ? `${from} → ${to}` : unchanged && (context !== null || flag !== null) ? null : `${item.to.harness} 的设置已更换`;
  const details = [item.session === "new" ? "新会话" : item.session === "resumed" ? "继续原会话" : null, item.context === "native" ? null : delivery?.detail ?? null].filter(Boolean).join(" · ");
  return { text: [head, context, flag].filter(Boolean).join(" · "), from, to, changed, head, context, flag, details, packetId: item.packetId ?? null, attention: item.delivery === "unconfirmed" || gone };
}

export interface EndLine {
  /** "失败 · 模型拒绝了这个请求", "已停止 · 你停止了这一轮". */
  readonly text: string;
  readonly status: string | null;
  readonly reason: string | null;
  /** The color of the line: a failure, or something that ended quietly. */
  readonly tone: "failed" | "quiet";
}
/**
 * The line that says why a Turn that is over ended as it did, or null when it simply ended (a stop reason of end_turn on a
 * completed Turn) or the Turn already says it elsewhere: an error item names what went wrong, and an interrupt item the stop. The
 * state is said in its word from the one table; a Turn whose outcome is unknown says it may have run, and that nothing runs it again.
 */
export function endLine(turn: Pick<ReadTurn, "status" | "stopReason" | "items">): EndLine | null {
  if (!turnOver(turn)) return null;
  const said = (type: string) => turn.items.some(item => item.type === type);
  // "没有拿到结束原因" is the table's word for a Turn whose end was not reported; a line that only says nothing was reported is not drawn.
  let reason = turn.stopReason === undefined || turn.stopReason === "unknown" ? null : STOP_REASON_WORDS[turn.stopReason];
  if (turn.stopReason === "error" && said("error") || turn.stopReason === "user_stopped" && said("interrupt")) reason = null;
  if (turn.status === "unknown") reason = "可能已经执行，不会自动重发";
  if (turn.status === "completed") return reason === null ? null : { text: reason, status: null, reason, tone: "quiet" };
  // A failed Turn with an error item says what failed there, and a stopped one with an interrupt item that it was stopped: the line
  // speaks only for a reason of its own.
  if (turn.status === "failed" && said("error") && reason === null || turn.status === "cancelled" && said("interrupt") && reason === null) return null;
  const status = TURN_STATUS_WORDS[turn.status];
  return { text: [status, reason].filter(Boolean).join(" · "), status, reason, tone: turn.status === "failed" ? "failed" : "quiet" };
}

// ---------------------------------------------------------------------------------------------------------------------
// The lines of what is not an action: a stop, a clear, a decision
// ---------------------------------------------------------------------------------------------------------------------

/** What an item says beyond what its words do: its state's word, unless it is done. */
const withState = (words: string, status: ItemStatus): string => status === "completed" ? words : words + " · " + ITEM_STATUS_WORDS[status];
const DECIDED: Readonly<Record<ApprovalItem["options"][number]["role"], string>> = {
  allow_once: "已允许", allow_session: "已允许（这个对话里都允许）", allow_always: "已允许（以后都允许）", deny: "已拒绝", other: "已处理",
};
const BY: Readonly<Record<NonNullable<ApprovalItem["decision"]>["by"], string>> = { user: "", policy: "（按规则）", timeout: "（等待超时）", harness: "（Harness 自己决定）" };

/**
 * The one quiet line of an item that is an event rather than work or text: you stopped the Turn, the context was cleared, work was
 * handed to another Harness, an approval was decided, a question answered, or an item this page does not know. Null for an item
 * that has no line of its own here (an approval still waiting stands above the message box until it is decided). What the line
 * says is the item's own facts, and a state that is not done is said in the state's word.
 */
export function quietLine(item: ReadItem): string | null {
  switch (item.type) {
    case "interrupt": return withState(item.by === "user" ? "你停止了这一轮" : "HarnessHub 停止了这一轮", item.status);
    case "context_event":
      if (item.kind === "compaction") return item.status === "running" || item.status === "pending" ? "正在压缩上下文" : item.status === "failed" ? "上下文压缩失败" : withState("上下文已压缩", item.status);
      return item.kind === "clear" ? withState("上下文已清空，下一条消息开新会话", item.status) : withState("已回退到这里", item.status);
    case "delegation": return item.status === "completed" ? `已交给 ${item.to.harness}：${item.task}` : withState(`交给 ${item.to.harness}：${item.task}`, item.status);
    case "approval": return item.decision === undefined ? null : `${DECIDED[item.decision.role]}${BY[item.decision.by]}：${item.title}`;
    case "question": return item.answer === undefined ? null : `已回答：${item.title}（${item.answer}）`;
    case "unrecognized": return "未识别的条目" + (item.nativeType ? `（${item.nativeType}）` : "");
    default: return null;
  }
}
