import type { PublicRun } from "../../../src/contracts/session.js";
import type { ConversationView } from "./conversation.js";
import type { SessionFacts } from "../../../src/contracts/web.js";
import { runRelayInfo, type RelayAttentionCause, type RelayBinding, type RelayDeliveryState, type RelayEvidence, type RelayOption, type RelayPacket, type RelayPrefs, type RelayRequest, type RelayTier, type RelayView } from "../relay.js";
import { compact } from "./format.js";
import { finished } from "./turn.js";

/*
 * What the page makes of the relay facts (ADR-055, docs/proposals/relay/slim.md): which words each state gets, what is still owed to
 * the Harness the conversation is on, what a binding asks the user to look at, and what each way to answer sends. (The line where the
 * conversation changed hands is the protocol's switch item, worded in lib/protocol/lines.ts.) Pure functions of the conversation view and the relay view, so every state can be checked
 * without a page. The page asks nothing and refuses nothing: the relay decides and the page says what it decided.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------

/** The names of a packet's two tiers: everything of the record fits (完整), or whole items were left out and the packet's ledger says which (精简). */
export function tierWords(tier: RelayTier | null): string {
  switch (tier) {
    case "brief": return "精简";
    case "full": return "完整";
    case null: return "交接单";
  }
}
/** What the proof behind a delivery or a binding's position is called: the native side's own report as it happened, or the Turn's normal end. */
export function evidenceWords(evidence: RelayEvidence | null): string | null {
  switch (evidence) {
    case "E1": return "实时确认";
    case "E3": return "按结果推断";
    case null: return null;
  }
}
/** The delivery state of a packet in the details list: 交接中 / 已接手 / 未确认 / 没有送达. */
export function deliveryWords(state: RelayDeliveryState | null): string {
  switch (state) {
    case "in_flight": return "交接中";
    case "recorded": return "已接手";
    case "not_recorded": return "没有送达";
    case "unknown": case null: return "未确认";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What is owed to the Harness the conversation is on
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How many Turns other Harness entries ran that the target's own session is not known to hold, when it keeps no binding of its own: every Turn of the conversation that reached its Harness
 * and ended on another entry. The Gateway counts them from the Runs' columns (`SessionFacts.ran`), for the whole conversation, whichever of its Turns the page holds.
 */
export function owedCount(facts: SessionFacts, target: { readonly harnessId: string; readonly controlId: string }): number {
  let all = 0, here = 0;
  for (const entry of facts.ran) { all += entry.turns; if (entry.harnessId === target.harnessId && entry.controlId === target.controlId) here += entry.turns; }
  return all - here;
}

/**
 * The one line above the message box when something is owed to the Harness the conversation is on. `first`: no conversation was ever
 * handed to this Harness on this installation, so the line says where the history goes (and goes away with the message that sends it).
 * `off`: the installation's setting does not hand the earlier conversation over by itself, so the message goes with the words alone
 * unless the user attaches it.
 */
export interface RelayLine { readonly kind: "owed"; readonly runs: number; readonly tokens: number | null; readonly first: boolean; readonly off: boolean }

/**
 * What the message box's line says about the next message. Nothing while a Turn runs or a change waits (what is owed is being
 * settled), nothing when there is nothing to hand over. What is owed is the Gateway's count when it keeps a native session for the
 * Harness here (absent means nothing: its floors and its clears are the Gateway's to know), and the page's own count of the Turns the
 * Harness is not known to hold when it keeps none (the first hand-over to a Harness that never ran in this conversation).
 */
export function relayLine(session: ConversationView, view: RelayView | null, prefs: RelayPrefs | null = null): RelayLine | null {
  if (view === null || session.status !== "open" || session.activeRunId !== null || session.pendingSwitchId !== null || session.runCount === 0) return null;
  if (!session.facts.settled) return null;
  const target = { harnessId: session.selection.harnessId, controlId: session.selection.controlId };
  const binding = view.bindings.find(item => item.harnessId === target.harnessId && item.controlId === target.controlId);
  // The Gateway keeps a native session for the Harness: what it says is owed is the word (its floors and clears are not the page's to know).
  const runs = binding !== undefined ? binding.owed?.runs ?? 0 : owedCount(session.facts, target);
  if (runs === 0) return null;
  return { kind: "owed", runs, tokens: binding?.owed?.estTokens ?? null, first: !view.handedOver.includes(target.harnessId), off: prefs?.attach === "off" };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a binding asks the user to look at: a banner, never a block
// ---------------------------------------------------------------------------------------------------------------------

/** What the one way to answer a banner sends with the next message: the whole earlier conversation attached. */
export function relayRequestFor(_option: RelayOption): RelayRequest { return { attach: "full" }; }
/** The way to answer a banner: the button, the sentence the banner shows while it is chosen for the next message, and what that message sends. */
export interface BannerAction { readonly option: RelayOption; readonly label: string; readonly chosen: string; readonly request: RelayRequest }
export interface BannerView {
  readonly key: string;
  readonly cause: RelayAttentionCause;
  readonly text: string;
  readonly actions: readonly BannerAction[];
}
/**
 * The banner above the message box for the binding the conversation is on: what is wrong, said once, and the way to settle it, a field of
 * the next message. Nothing waits for it: the next message goes whatever the banner says. None when the binding asks nothing, when the
 * user closed this episode (`closed` is asked with its key), and for a delivery nothing can confirm: a Harness whose Driver has no way
 * to learn that a handoff arrived stays unconfirmed whatever is done, which the hand-over line and the details say once and a banner
 * would repeat on every message.
 */
export function bannerOf(binding: RelayBinding | undefined, target: string, closed: (key: string) => boolean): BannerView | null {
  const attention = binding?.attention;
  if (binding === undefined || attention === null || attention === undefined || closed(attention.key)) return null;
  if (attention.cause === "delivery_unconfirmed" && binding.canConfirm === false) return null;
  const cause = attention.cause;
  const text = ((): string => {
    switch (cause) {
      case "delivery_unconfirmed": {
        const which = attention.packet === null ? "上一份交接单" : `交接单 #${attention.packet} `;
        return attention.counts.packets >= 2 ? `${which}发了两次仍未确认送达 ${target} · 之后的消息只发原话，有新内容再附` : `${which}还没有确认送达 ${target}`;
      }
      case "attach_available": return `${target} 的上下文已清空 · 下一条不附历史`;
    }
  })();
  const actions: BannerAction[] = attention.options.includes("attach_full") ? [{ option: "attach_full", label: cause === "delivery_unconfirmed" ? "再附一次" : "附上交接单",
    chosen: cause === "delivery_unconfirmed" ? "下一条消息会再附一次交接单" : "下一条会附上之前对话的交接单", request: relayRequestFor("attach_full") }] : [];
  return { key: attention.key, cause, text, actions };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the installation cannot do for the relay
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The standing notice for what the installation as a whole cannot do for the relay (the `installation` of the relay view): why, what it
 * means for the next message, and how to mend it. It stays while the cause does; the user's message still goes, without the history.
 */
export interface InstallationView { readonly cause: string; readonly title: string; readonly text: string }
export function installationNotices(notices: readonly { readonly cause: string; readonly detail: string | null }[]): readonly InstallationView[] {
  return notices.flatMap(notice => {
    switch (notice.cause) {
      case "key_unavailable": return [{ cause: notice.cause, title: "暂时不能把对话交给别的 Harness",
        text: `HarnessHub 的接力密钥文件不能用${notice.detail === null ? "" : `（${notice.detail}）`}，所以现在发的消息只带原话，不附交接单。` +
          "修好它：把 HarnessHub 应用支持目录（~/Library/Application Support/HarnessHub）里的 relay-key 文件移走，然后重启 HarnessHub，它会生成新的密钥；旧的交接记录将无法再核验。" }];
      default: return [];
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The details list
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether the relay has anything to tell about this conversation: a packet was sent, more than one Harness holds a session of it, or
 * something is owed or asked. A conversation that stayed on one Harness has nothing to say, and the details panel gets no tab for it.
 */
export function relayHasStory(view: RelayView): boolean {
  return view.packets.length > 0 || view.bindings.length > 1 || view.bindings.some(binding => binding.attention !== null || binding.owed !== null);
}

/** One Harness entry's position, in one sentence: "已同步到第 4 轮（实时确认）· 清空过". */
export function syncWords(binding: RelayBinding): string {
  const proof = evidenceWords(binding.evidence), cleared = binding.cleared > 0 ? " · 清空过" : "";
  switch (binding.sync) {
    case "synced": return (binding.throughRun === null ? "已同步" : `已同步到第 ${binding.throughRun + 1} 轮`) + (proof === null ? "" : `（${proof}）`) + cleared;
    case "fresh": return binding.cleared > 0 ? "上下文已清空，下一条不附历史" : "新会话，还没有收到过交接单";
    case "pending": return (binding.canConfirm === false ? "交接单已发出，这个 Harness 无法确认是否收到" : "交接单已发出，送达待确认") + cleared;
    case "unknown": return "状态未知" + cleared;
  }
}
/** One packet in the details list: "第 2 轮 · 完整 · 约 1.7k tokens · 省略 3 项 · 隐去 1 处". */
export function packetFacts(packet: RelayPacket): string {
  return [`第 ${packet.runIndex + 1} 轮`, tierWords(packet.tier), packet.estTokens > 0 ? `约 ${compact(packet.estTokens)} tokens` : "", packet.omissions > 0 ? `省略 ${packet.omissions} 项` : "", packet.redactions > 0 ? `隐去 ${packet.redactions} 处` : ""].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------------------------------------------------
// When to read the relay state again
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the relay view depends on, as one string: the conversation, which Turns exist and whether each is over, the packet each
 * carries and its delivery, and the selection. The page reads the view again whenever it changes.
 */
export function relaySignature(session: ConversationView | null): string {
  if (session === null) return "";
  const turns = session.runs.map(run => { const info = runRelayInfo(run); return `${run.id}:${finished(run.status) ? "x" : "o"}:${info?.packetId ?? ""}:${info?.delivery?.state ?? ""}`; }).join(",");
  return `${session.id}|${session.runCount}|${turns}|${session.selection.harnessId}:${session.selection.controlId}|${session.status}:${session.pendingSwitchId ?? ""}`;
}
