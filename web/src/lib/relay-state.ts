import type { PublicMessage, PublicRun } from "../../../src/contracts/session.js";
import type { SessionView } from "../../../src/contracts/web.js";
import { runRelayInfo, type RelayBinding, type RelayChoice, type RelayDeliveryState, type RelayEvidence, type RelayOption, type RelayPacket, type RelayRequest, type RelayTier, type RelayView, type RunRelayInfo } from "../relay.js";
import { compact } from "./format.js";
import { finished } from "./turn.js";

/*
 * What the page makes of the relay facts (ADR-055, relay-architecture §12.1–§12.3): which words each state gets, when the
 * hand-over line may say a Harness took over, what is still owed to the Harness the conversation is on, and what a refused
 * send offers. Pure functions of the conversation view and the relay view, so every state can be checked without a page.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The names of a packet's size (12.2). "完整记录" is only for a packet that is complete, which a tier alone does not say: a
 * full-tier packet that left things out is "保真".
 */
export function tierWords(tier: RelayTier | null, complete?: boolean): string {
  switch (tier) {
    case "goal": return "只交目标";
    case "brief": return "精简";
    case "standard": return "标准";
    case "fidelity": return "保真";
    case "full": return complete === true ? "完整记录" : "保真";
    case null: return "交接单";
  }
}
/** How a Turn continued its context, as a main label and a sub label (12.2). */
export function continuityWords(level: RunRelayInfo["continuity"]): { readonly main: string; readonly sub: string | null } {
  switch (level.kind) {
    case "native_resume": return { main: "继续原会话", sub: null };
    case "native_resume_delta": return { main: "继续原会话", sub: level.runs ? `补交 ${level.runs} 轮` : "补交新增的部分" };
    case "rehydrate": return { main: "新会话", sub: `交接单（${tierWords(level.tier ?? null, level.complete)}）` };
    case "native_fork": return { main: "原生分支", sub: null };
    case "native_import": return { main: "接续本机会话", sub: null };
    case "native_cleared": return { main: "上下文已清空", sub: null };
    case "blocked": return { main: "无法接续", sub: null };
  }
}
/** What the proof behind a delivery or a binding's position is called. */
export function evidenceWords(evidence: string | null): string | null {
  switch (evidence) {
    case "E1": return "实时确认";
    case "E2": return "事后核对";
    case "E3": return "按结果推断";
    case "native": return "它自己跑过";
    case "origin": return "来自原会话";
    case "legacy": return "升级前的记录";
    case "choice": return "按你的选择";
    default: return null;
  }
}
/** The delivery state of a packet in the details list (12.2: 交接中 / 已接手 / 未确认 / 没有送达). */
export function deliveryWords(state: RelayDeliveryState | null): string {
  switch (state) {
    case "in_flight": return "交接中";
    case "recorded": return "已接手";
    case "not_recorded": return "没有送达";
    case "unknown": case null: return "未确认";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the conversation changed hands (T5)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the line where another Harness took over may say. It says "took over" only with evidence: before the packet is
 * known to be in the original program's history the line only says it was handed over (12.1 T5).
 *  - `legacy`: the Gateway has no relay information, or the change is within one Harness: the line the page always drew.
 *  - `none`: nothing is drawn yet (nothing was sent to the new Harness, or the Turn is still being prepared).
 */
export type Handover =
  | { readonly kind: "legacy" }
  | { readonly kind: "none" }
  | ShownHandover;
/**
 * The states with something to say. `fresh` says the Turn that carried the hand-over was accepted moments ago, so the line is
 * news and comes in; one drawn with the history of a conversation just opened is not, whenever its facts are read.
 */
export type ShownHandover =
  | { readonly kind: "pending"; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "started"; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "taken"; readonly how: string; readonly number: number | null; readonly packetId: string | null; readonly evidence: RelayEvidence | null; readonly fresh: boolean }
  | { readonly kind: "unknown"; readonly replied: boolean; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "not_recorded"; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean };
/** How recently a Turn was accepted for what it carries to be news (the page's own measure, as for a Turn just started). */
const NEWS_MS = 5000;

/** Whether the Gateway tells anything of the relay: its view was read, or a Turn carries a delivery. */
export function relayAvailable(runs: readonly PublicRun[], view: RelayView | null): boolean {
  return view !== null || runs.some(run => runRelayInfo(run)?.delivery != null);
}
/** The sequence of each Turn's user message, which places a Turn after a change of Harness. */
export function userSequences(messages: readonly PublicMessage[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const message of messages) if (message.role === "user") result.set(message.runId, message.seq);
  return result;
}
/** The words a taken hand-over names its way with: "新会话 · 交接单（标准）· #1", or "继续原会话 · 补交 2 轮". */
function takenHow(info: RunRelayInfo, number: number | null): string {
  const { main, sub } = continuityWords(info.continuity), parts = [main, ...(sub === null ? [] : [sub])];
  if (info.packetId !== null && number !== null) parts.push(sub !== null && sub.startsWith("交接单") ? `#${number}` : `交接单 #${number}`);
  return parts.join(" · ");
}
export function handoverOf(input: {
  readonly runs: readonly PublicRun[]; readonly userSeq: ReadonlyMap<string, number>; readonly throughSeq: number;
  readonly from: string; readonly to: string; readonly view: RelayView | null; readonly now?: number;
}): Handover {
  if (input.from === input.to || !relayAvailable(input.runs, input.view)) return { kind: "legacy" };
  // The Turn that went to the new Harness is the first one asked after the change.
  const run = input.runs.find(item => (input.userSeq.get(item.id) ?? -1) > input.throughSeq);
  if (run === undefined) return { kind: "none" };
  const info = runRelayInfo(run);
  // A Turn from before the relay kept any facts of it: the Harness answered, so it did take over, as the page always said.
  if (info === null) return run.status === "completed" ? { kind: "legacy" } : { kind: "none" };
  const handedOver = run.timing?.dispatchedAt !== undefined, replied = run.timing?.firstOutputAt !== undefined;
  const fresh = run.timing !== undefined && (input.now ?? Date.now()) - run.timing.acceptedAt < NEWS_MS;
  if (info.packetId === null) {
    // No packet owed: the original session goes on. It took over once the Turn was handed to it.
    return info.continuity.kind === "blocked" || !handedOver ? { kind: "none" } : { kind: "taken", how: takenHow(info, null), number: null, packetId: null, evidence: null, fresh };
  }
  const packet = input.view?.packets.find(item => item.packetId === info.packetId);
  const number = packet?.number ?? null, state = packet?.delivery ?? info.delivery?.state ?? null, evidence = packet?.evidence ?? info.delivery?.evidence ?? null, ended = finished(run.status);
  const waiting = replied ? { kind: "started" as const, number, packetId: info.packetId, fresh } : { kind: "pending" as const, number, packetId: info.packetId, fresh };
  switch (state) {
    case "recorded": return { kind: "taken", how: takenHow(info, number), number, packetId: info.packetId, evidence, fresh };
    case "not_recorded": return { kind: "not_recorded", number, packetId: info.packetId, fresh };
    case "in_flight": return waiting;
    // Nothing is known (no delivery, or a word this page does not know), or it is unknown: once the Turn is over, say so.
    case "unknown": case null: return ended ? { kind: "unknown", replied, number, packetId: info.packetId, fresh } : waiting;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What is owed to the Harness the conversation is on (T2, T7)
// ---------------------------------------------------------------------------------------------------------------------

/** Whether a Turn reached its Harness: it was handed to the program, or (for a Turn from before the timing was kept) it completed. */
function dispatched(run: PublicRun): boolean { return run.timing === undefined ? run.status === "completed" : run.timing.dispatchedAt !== undefined; }
/** Where a Turn ran: the Harness entry its relay facts name, otherwise the one it was selected on. */
function ranOn(run: PublicRun): { readonly harnessId: string; readonly controlId: string } {
  return runRelayInfo(run)?.executedOn ?? { harnessId: run.selection.harnessId, controlId: run.selection.controlId };
}
/** The Turns (by index) that other Harness entries ran and the target's own session is not known to hold. */
export function owedRuns(runs: readonly PublicRun[], target: { readonly harnessId: string; readonly controlId: string }, binding: RelayBinding | undefined): readonly number[] {
  const known = binding?.throughRun ?? -1, owed: number[] = [];
  runs.forEach((run, index) => {
    if (index <= known || !finished(run.status) || !dispatched(run)) return;
    const on = ranOn(run);
    if (on.harnessId !== target.harnessId || on.controlId !== target.controlId) owed.push(index);
  });
  return owed;
}

/** The one line above the message box, when there is one (T2, T7). */
export type RelayLine =
  | { readonly kind: "owed"; readonly runs: number; readonly tokens: number | null; readonly unverified: boolean;
    /** No packet has gone out in this conversation yet: the first hand-over, which the one-time note is for. */ readonly first: boolean }
  | { readonly kind: "cleared" }
  | { readonly kind: "clear_pending" };

/**
 * What the message box's line says about the next message. Nothing while a Turn runs or a change waits (what is owed is
 * being settled), nothing when there is nothing to hand over. After a confirmed clear it offers the history back once, and
 * stays until the next message is sent; an unconfirmed clear says it will be checked.
 */
export function relayLine(session: SessionView, view: RelayView | null): RelayLine | null {
  if (view === null || session.status !== "open" || session.activeRunId !== null || session.pendingSwitchId !== null || session.runs.length === 0) return null;
  if (session.runs.some(run => !finished(run.status))) return null;
  const target = { harnessId: session.selection.harnessId, controlId: session.selection.controlId };
  const binding = view.bindings.find(item => item.harnessId === target.harnessId && item.controlId === target.controlId);
  if (binding?.sync === "suspect" && binding.cause === "clear_unconfirmed") return { kind: "clear_pending" };
  if (binding !== undefined && binding.sync === "fresh" && binding.cleared > 0 && session.runs.some(dispatched)) return { kind: "cleared" };
  const owed = owedRuns(session.runs, target, binding);
  if (owed.length === 0) return null;
  return { kind: "owed", runs: binding?.owed?.runs ?? owed.length, tokens: binding?.owed?.estTokens ?? null, unverified: binding !== undefined && !binding.probed, first: view.packets.length === 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// A refused send (12.1 T2, 7.4, 10.4): what it says and what each way forward sends
// ---------------------------------------------------------------------------------------------------------------------

export interface ChoiceAction { readonly option: RelayOption; readonly label: string; readonly primary: boolean; readonly title?: string }
export interface ChoiceView { readonly title: string; readonly text: string; readonly actions: readonly ChoiceAction[] }
const VENDORS: Readonly<Record<string, string>> = { anthropic: "Anthropic", openai: "OpenAI", deepseek: "DeepSeek", google: "Google", "aws-bedrock": "AWS Bedrock", "google-vertex": "Google Vertex AI", local: "本机模型" };
/** A vendor key (relay-architecture §10.4) in words: a named vendor, a gateway or router of the user's own, or one that could not be told. */
export function vendorWords(vendor: string): string {
  const named = VENDORS[vendor];
  if (named !== undefined) return named;
  const [kind, ...rest] = vendor.split(":"), detail = rest.join(":");
  switch (kind) {
    case "gateway": return `自配网关 ${detail}`;
    case "router": return `路由 ${detail}`;
    case "provider": return `Provider ${detail}`;
    case "unknown": return "无法确认的服务";
    default: return vendor;
  }
}
const UNAVAILABLE: Readonly<Record<string, string>> = {
  data_root_in_workspace: "HarnessHub 的数据目录在这个工作区里，目标 Harness 能直接读到它。把数据目录移到工作区外（--data-dir）后再交接。",
  consent_log_full: "交接的同意记录已满，暂时不能交接这段对话。",
  recovery_failed: "这段对话在上次服务重启后没能恢复交接状态，暂时不能交接。",
};
/**
 * The line a refused send turns into. `target` is the Harness the message was going to; the binding the Gateway names, when
 * it names one, is the Harness whose original session the choice is about.
 */
export function choiceView(choice: RelayChoice, harnessName: (id: string) => string, target: string): ChoiceView {
  const { code, body } = choice, about = harnessName(body.binding?.harnessId ?? target), to = harnessName(target);
  const text = ((): { readonly title: string; readonly text: string } => {
    if (code === "RELAY_CHOICE_REQUIRED") switch (body.cause) {
      case "delivery_unconfirmed": return { title: `上一份交接单没有确认送达 ${about}`, text: "再附一次可能让它收到两份；只发这条消息不会补交之前的内容。" };
      case "marker_absent": return { title: `${about} 的原生会话里找不到之前的交接单`, text: "可能被清空或回退过。补发完整交接单会在同一会话里重复一部分内容。" };
      case "verify_required": return { title: `没能确认 ${about} 的原生会话里有哪些之前的对话`, text: "补发完整交接单最稳妥；只发这条消息则不补交。" };
      default: return { title: "发送前需要你选一个办法", text: "这条消息还没有发出，草稿已保留。" };
    }
    if (code === "RELAY_CONSENT_REQUIRED") {
      const what = body.counts === null ? "之前的对话记录" : `之前 ${body.counts.runs} 轮的对话记录`, vendor = body.vendor === null ? "" : `（${vendorWords(body.vendor)}）`;
      return { title: body.cause === "vendor_changed" ? `${to} 现在用的模型服务和上次不同${vendor}` : `这条消息会附上${what}，交给 ${to}${vendor}`,
        text: `发出后不能收回。${to} 会在本机保存这段记录，也可能交给它自己配置的辅助模型。` };
    }
    if (code === "RELAY_TARGET_UNVERIFIED") return { title: `${to} 的接力还没有经过真机验证`, text: "HarnessHub 不能保证它接得上之前的对话。这条消息还没有发出，草稿已保留。" };
    if (code === "RELAY_UNAVAILABLE") return { title: "现在不能交接这段对话", text: UNAVAILABLE[body.cause ?? ""] ?? "这条消息还没有发出，草稿已保留。" };
    if (code === "RELAY_INPUT_LIMIT") return { title: `这段对话放不进 ${to} 的上下文窗口`, text: "交接单装不下。这条消息还没有发出，草稿已保留。" };
    return { title: "发送前需要你选一个办法", text: "这条消息还没有发出，草稿已保留。" };
  })();
  const resend = body.cause === "delivery_unconfirmed";
  const labels: Readonly<Record<RelayOption, string>> = { attach_full: resend ? "再附一次" : "补发完整交接单", send_alone: "只发这条消息", new_native: "新开原生会话",
    clear_confirmed: "确认已清空", acknowledge: `发送并交给 ${to}` };
  // The consent is the one choice that needs a name the Gateway must give; without it the choice is shown but cannot be made.
  const actions = body.options.map((option, index): ChoiceAction => ({ option, label: labels[option], primary: index === 0,
    ...(option === "acknowledge" && body.vendor === null ? { title: "网关没有说明要同意哪家服务；可以在设置里把“跨厂商交接”改为“允许”。" } : {}) }));
  return { ...text, actions };
}
/** What a way forward sends with the message; null when it cannot be sent (a consent that does not know its vendor). */
export function relayRequestFor(option: RelayOption, choice: RelayChoice): RelayRequest | null {
  switch (option) {
    case "attach_full": return choice.body.cause === "delivery_unconfirmed" ? { resend: true } : { attach: "full" };
    case "send_alone": return { attach: "none" };
    case "new_native": return { native: "new" };
    case "clear_confirmed": return { clearConfirmed: true };
    case "acknowledge": return choice.body.vendor === null ? null : { consent: { vendor: choice.body.vendor, decision: "acknowledged", scope: "session" } };
  }
}
/** Whether a refused send still belongs to the conversation's Harness: choosing another one leaves the old refusal behind. */
export function choiceApplies(choice: RelayChoice, selection: { readonly harnessId: string; readonly controlId: string }): boolean {
  return choice.body.binding === null || (choice.body.binding.harnessId === selection.harnessId && choice.body.binding.controlId === selection.controlId);
}

// ---------------------------------------------------------------------------------------------------------------------
// The details list (12.1 "接续")
// ---------------------------------------------------------------------------------------------------------------------

/** One Harness entry's position, in one sentence: "已同步到第 4 轮（实时确认）· 清空过 1 次". */
export function syncWords(binding: RelayBinding): string {
  const proof = evidenceWords(binding.evidence), cleared = binding.cleared > 0 ? ` · 清空过 ${binding.cleared} 次` : "";
  switch (binding.sync) {
    case "synced": return (binding.throughRun === null ? "已同步" : `已同步到第 ${binding.throughRun + 1} 轮`) + (proof === null ? "" : `（${proof}）`) + cleared;
    case "fresh": return binding.cleared > 0 ? `上下文已清空，下一条不附历史 · 清空过 ${binding.cleared} 次` : "新会话，还没有收到过交接单";
    case "pending": return "交接单已发出，送达待确认" + cleared;
    case "suspect": return (binding.cause === "clear_unconfirmed" ? "清空待确认" : "状态待核对") + " · 下一条消息发出前会核对" + cleared;
    case "unknown": return "状态未知" + cleared;
  }
}
/** One packet in the details list: "#1 · 第 2 轮 · 标准 · 约 1.7k tokens · 省略 3 项 · 隐去 1 处". */
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
export function relaySignature(session: SessionView | null): string {
  if (session === null) return "";
  const turns = session.runs.map(run => { const info = runRelayInfo(run); return `${run.id}:${finished(run.status) ? "x" : "o"}:${info?.packetId ?? ""}:${info?.delivery?.state ?? ""}`; }).join(",");
  return `${session.id}|${turns}|${session.selection.harnessId}:${session.selection.controlId}|${session.status}:${session.pendingSwitchId ?? ""}`;
}
