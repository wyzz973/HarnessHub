import type { PublicMessage, PublicRun } from "../../../src/contracts/session.js";
import type { SessionView } from "../../../src/contracts/web.js";
import { runRelayInfo, type RelayAttentionCause, type RelayBinding, type RelayChoice, type RelayDecisionInfo, type RelayDeliveryState, type RelayEvidence, type RelayOption, type RelayPacket, type RelayRequest, type RelayTier, type RelayView, type RunRelayInfo } from "../relay.js";
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
 * news and comes in; one drawn with the history of a conversation just opened is not, whenever its facts are read. `runId` is the
 * Turn the line is about. `alone` is a Turn whose history did not go with it (the relay or the user sent the words alone):
 * it says that, and never "taken over".
 */
export type ShownHandover =
  | { readonly kind: "pending"; readonly runId: string; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "started"; readonly runId: string; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "taken"; readonly runId: string; readonly how: string; readonly number: number | null; readonly packetId: string | null; readonly evidence: RelayEvidence | null; readonly fresh: boolean }
  | { readonly kind: "unknown"; readonly runId: string; readonly replied: boolean; readonly cannotConfirm: boolean; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "not_recorded"; readonly runId: string; readonly number: number | null; readonly packetId: string | null; readonly fresh: boolean }
  | { readonly kind: "alone"; readonly runId: string; readonly note: string; readonly number: null; readonly packetId: null; readonly fresh: boolean };
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
/**
 * What a Turn's decision means for the user, in words, when it is more than "the history went along as it was owed" (permissive-defaults
 * §1): an automatic resend, a complete packet again, a packet cut down to a small window, words sent alone and why. null for a Turn
 * that needs no note. The words never say "taken over": a Turn that went alone has not handed the conversation over.
 */
export interface NoteContext {
  /** The display name of the Harness the Turn ran on. */
  readonly target: string;
  /** "交接单 #n" of the Turn's own packet. */
  readonly number: number | null;
  /** The latest packet sent to this Harness before the Turn: the one an alone Turn left unconfirmed. */
  readonly pending: number | null;
  /** The named service the Harness runs on, when it is known. */
  readonly service: string | null;
  /** Nothing this Harness does can confirm that a handoff arrived. */
  readonly cannotConfirm: boolean;
}
/** The parenthesis of a failed preparation: what could not be done, in words. */
function prepareWords(reason: string | null): string {
  switch (reason) {
    case "render": case "render_mismatch": return "（生成时出错）";
    case "redaction_failed": return "（没能隐去疑似密钥，所以不发）";
    case "storage": case "storage_quota": return "（存储空间不足）";
    case "consent_log_full": return "（同意记录已满）";
    default: return "";
  }
}
function packetWords(number: number | null, runs: number | undefined): string {
  if (number === null && runs === undefined) return "";
  return `（${[number === null ? "" : `交接单 #${number}`, runs === undefined ? "" : `补交 ${runs} 轮`].filter(Boolean).join(" · ")}）`;
}
function aloneWords(decision: RelayDecisionInfo, ctx: NoteContext): string {
  if (decision.by === "user") return "这条消息按你的选择只发了原话";
  const target = ctx.target, which = ctx.pending === null ? "上一份交接单" : `交接单 #${ctx.pending} `;
  switch (decision.cause) {
    case "delivery_unconfirmed": return ctx.cannotConfirm ? `${which}已发出，${target} 无法确认是否收到 · 这条只发了原话` : `${which}发了两次仍未确认送达 · 这条只发了原话`;
    case "verify_required": return `未能核对 ${target} 原生会话里的交接内容 · 这条按原样发出`;
    case "marker_absent": return `${target} 的原生会话里找不到之前的交接单 · 这条按原样发出`;
    case "input_limit": return decision.reason === "input_limit" ? `这条消息已接近 ${target} 的输入上限，放不下交接单 · 这条只发了原话` : `${target} 的上下文窗口放不下交接单 · 这条只发了原话`;
    case "recovery_failed": return "服务重启后没能恢复这个对话的交接记录 · 这条只发了原话";
    case "consent_revoked": return `你已撤回对${ctx.service === null ? "该服务" : ` ${vendorWords(ctx.service)} `}的允许 · 这条只发了原话`;
    case "consent_goal_only": return "跨厂商交接设为“只交目标” · 这条只发了原话";
    case "prepare_failed": return `这次没能准备交接单${prepareWords(decision.reason)} · 这条只发了原话，下一条会再试`;
    case "classification_changed": return `这是 ${target} 的命令，不会附上交接单；交接单会随下一条普通消息发出`;
    case null: return "这条消息只发了原话";
  }
}
/** A packet cut down for a small window: said when the Turn carried one that is not the standard size. */
function downgradeNote(info: RunRelayInfo, ctx: NoteContext): string | null {
  const tier = info.continuity.tier;
  return info.packetId !== null && (tier === "brief" || tier === "goal") ? `${ctx.target} 的窗口较小，交接单已缩为${tierWords(tier)}` : null;
}
export function decisionNote(info: RunRelayInfo, ctx: NoteContext): string | null {
  const decision = info.decision;
  if (decision === null) return downgradeNote(info, ctx);
  switch (decision.kind) {
    case "carry":
      if (decision.by === "policy") switch (decision.cause) {
        case "delivery_unconfirmed": return `上一份交接单没有确认送达，这条消息已再附一次${packetWords(ctx.number, info.continuity.runs)}`;
        case "verify_required": return `未能核对 ${ctx.target} 的原生会话，已补发完整交接单（可能与已有内容重复）`;
        case "marker_absent": return `${ctx.target} 的原生会话里找不到之前的交接单，已在同一会话补发`;
        default: break;
      }
      return downgradeNote(info, ctx);
    case "alone": return aloneWords(decision, ctx);
    case "plain": return decision.by === "user" ? "没有可附的交接内容，这条消息按原样发出" : null;
  }
}
/** What `decisionNote` needs of a Turn: its names, its packet's number, the packet it left unconfirmed, and what its binding says. */
function noteContext(run: PublicRun, index: number, info: RunRelayInfo, view: RelayView | null, name: (id: string) => string): NoteContext {
  const harnessId = info.executedOn?.harnessId ?? run.selection.harnessId, binding = view?.bindings.find(item => item.harnessId === harnessId);
  const own = view?.packets.find(item => item.packetId === info.packetId)?.number ?? null;
  const before = view?.packets.filter(item => item.target.harnessId === harnessId && item.runIndex < index).at(-1)?.number ?? null;
  return { target: name(harnessId), number: own, pending: before, service: binding?.vendor ?? null, cannotConfirm: binding?.canConfirm === false };
}
/**
 * The note under each Turn's message that the relay's decision calls for, by Turn: an automatic resend, a complete packet again, a
 * packet cut down, words sent alone and why. A Turn that needs none has none.
 */
export function runNotes(input: { readonly runs: readonly PublicRun[]; readonly view: RelayView | null; readonly name: (id: string) => string }): ReadonlyMap<string, string> {
  const notes = new Map<string, string>();
  input.runs.forEach((run, index) => {
    const info = runRelayInfo(run);
    if (info === null) return;
    const note = decisionNote(info, noteContext(run, index, info, input.view, input.name));
    if (note !== null) notes.set(run.id, note);
  });
  return notes;
}
export function handoverOf(input: {
  readonly runs: readonly PublicRun[]; readonly userSeq: ReadonlyMap<string, number>; readonly throughSeq: number;
  readonly from: string; readonly to: string; readonly view: RelayView | null; readonly name?: (id: string) => string; readonly now?: number;
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
  const binding = input.view?.bindings.find(item => item.harnessId === (info.executedOn?.harnessId ?? run.selection.harnessId));
  if (info.packetId === null) {
    // Words sent alone (by the relay's policy or the user's choice): the history did not go with them, so the Harness did not take the
    // conversation over. Said so, with why.
    if (info.decision?.kind === "alone") {
      return !handedOver ? { kind: "none" } : { kind: "alone", runId: run.id, note: decisionNote(info, noteContext(run, input.runs.indexOf(run), info, input.view, input.name ?? (id => id))) ?? "这条只发了原话", number: null, packetId: null, fresh };
    }
    // No packet owed: the original session goes on. It took over once the Turn was handed to it.
    return info.continuity.kind === "blocked" || !handedOver ? { kind: "none" } : { kind: "taken", runId: run.id, how: takenHow(info, null), number: null, packetId: null, evidence: null, fresh };
  }
  const packet = input.view?.packets.find(item => item.packetId === info.packetId);
  const number = packet?.number ?? null, state = packet?.delivery ?? info.delivery?.state ?? null, evidence = packet?.evidence ?? info.delivery?.evidence ?? null, ended = finished(run.status);
  const waiting = replied ? { kind: "started" as const, runId: run.id, number, packetId: info.packetId, fresh } : { kind: "pending" as const, runId: run.id, number, packetId: info.packetId, fresh };
  switch (state) {
    case "recorded": return { kind: "taken", runId: run.id, how: takenHow(info, number), number, packetId: info.packetId, evidence, fresh };
    case "not_recorded": return { kind: "not_recorded", runId: run.id, number, packetId: info.packetId, fresh };
    case "in_flight": return waiting;
    // Nothing is known (no delivery, or a word this page does not know), or it is unknown: once the Turn is over, say so.
    case "unknown": case null: return ended ? { kind: "unknown", runId: run.id, replied, cannotConfirm: binding?.canConfirm === false, number, packetId: info.packetId, fresh } : waiting;
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
    /** The named service the Harness was last seen on, when known: the first hand-over to it says where the history goes. */ readonly service: string | null }
  | { readonly kind: "cleared" };

/**
 * What the message box's line says about the next message. Nothing while a Turn runs or a change waits (what is owed is
 * being settled), nothing when there is nothing to hand over. After a confirmed clear it offers the history back once, and
 * stays until the next message is sent. What is owed is the Gateway's count when it keeps a native session for the Harness here (absent
 * means nothing: its floors and its clears are the Gateway's to know), and the page's own count of the Turns the Harness is not known to
 * hold when it keeps none (the first hand-over to a Harness that never ran in this conversation).
 */
export function relayLine(session: SessionView, view: RelayView | null): RelayLine | null {
  if (view === null || session.status !== "open" || session.activeRunId !== null || session.pendingSwitchId !== null || session.runs.length === 0) return null;
  if (session.runs.some(run => !finished(run.status))) return null;
  const target = { harnessId: session.selection.harnessId, controlId: session.selection.controlId };
  const binding = view.bindings.find(item => item.harnessId === target.harnessId && item.controlId === target.controlId);
  if (binding !== undefined && binding.sync === "fresh" && binding.cleared > 0 && session.runs.some(dispatched)) return { kind: "cleared" };
  // The Gateway keeps a native session for the Harness: what it says is owed is the word (its floors and clears are not the page's to know).
  const runs = binding !== undefined ? binding.owed?.runs ?? 0 : owedRuns(session.runs, target, binding).length;
  if (runs === 0) return null;
  return { kind: "owed", runs, tokens: binding?.owed?.estTokens ?? null, unverified: binding !== undefined && !binding.probed, service: binding?.vendor ?? null };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a binding asks the user to look at (permissive-defaults §2.6): a banner, never a block
// ---------------------------------------------------------------------------------------------------------------------

/** One way to settle what a banner says: the button, the sentence the banner shows while it is chosen for the next message, and what that message sends. */
export interface BannerAction { readonly option: RelayOption; readonly label: string; readonly chosen: string; readonly request: RelayRequest }
export interface BannerView {
  readonly key: string;
  readonly cause: RelayAttentionCause;
  readonly text: string;
  readonly actions: readonly BannerAction[];
}
/**
 * The refusal-shaped description of a binding's attention, so that its ways forward send what a refusal's would (relayRequestFor): the
 * cause it names, the options it offers and the vendor an allowance is for.
 */
function choiceOf(binding: RelayBinding): RelayChoice {
  const attention = binding.attention!;
  return { code: "RELAY_CHOICE_REQUIRED", body: { binding: { harnessId: binding.harnessId, controlId: binding.controlId }, cause: attention.cause, options: attention.options, counts: attention.counts, vendor: attention.vendor } };
}
/** The label of a way forward on a banner. */
function bannerLabel(option: RelayOption, cause: RelayAttentionCause): string {
  switch (option) {
    case "attach_full": return cause === "delivery_unconfirmed" ? "再附一次" : "补发完整交接单";
    case "send_alone": return "只发这条消息";
    case "new_native": return "新开原生会话";
    case "clear_confirmed": return "确认已清空";
    case "acknowledge": return "重新允许";
  }
}
/** The sentence a banner shows while a way forward is chosen for the next message. */
function bannerChosen(option: RelayOption, cause: RelayAttentionCause, target: string, vendor: string | null): string {
  switch (option) {
    case "attach_full": return cause === "delivery_unconfirmed" ? "下一条消息会再附一次交接单" : "下一条消息会补发完整交接单";
    case "send_alone": return "下一条消息只发原话";
    case "new_native": return `下一条消息会新开 ${target} 的原生会话，并附上交接单`;
    case "clear_confirmed": return "下一条消息会按“已清空”处理";
    case "acknowledge": return `下一条消息会重新允许交接给${vendor === null ? "它" : ` ${vendorWords(vendor)}`}`;
  }
}
/**
 * The banner above the message box for the binding the conversation is on: what is wrong, said once, and the ways to settle it, each
 * one a field of the next message. Nothing waits for them: the next message goes whatever the banner says. None when the binding asks
 * nothing, when the user closed this episode (`closed` is asked with its key), and for a delivery nothing can confirm: a Harness whose
 * Driver has no way to learn that a handoff arrived stays unconfirmed whatever is done, which the hand-over line and the details
 * say once and a banner would repeat on every message.
 */
export function bannerOf(binding: RelayBinding | undefined, target: string, closed: (key: string) => boolean): BannerView | null {
  const attention = binding?.attention;
  if (binding === undefined || attention === null || attention === undefined || closed(attention.key)) return null;
  if (attention.cause === "delivery_unconfirmed" && binding.canConfirm === false) return null;
  const cause = attention.cause, stake = attention.counts.runs > 0 ? ` · 还有 ${attention.counts.runs} 轮待交接` : "";
  const service = attention.vendor ?? binding.vendor, named = service === null ? "该服务" : vendorWords(service);
  const text = ((): string => {
    switch (cause) {
      case "delivery_unconfirmed": {
        const which = attention.packet === null ? "上一份交接单" : `交接单 #${attention.packet} `, sent = attention.counts.packets;
        return sent >= 2 ? `${which}发了${sent === 2 ? "两" : sent}次仍未确认送达 ${target} · 之后的消息只发原话，有新内容再附` : `${which}还没有确认送达 ${target}`;
      }
      case "verify_required": return `未能核对 ${target} 原生会话里的交接内容`;
      case "marker_absent": return `${target} 的原生会话里找不到之前的交接单`;
      case "clear_unconfirmed": return "清空待确认 · 不确认的话，下次补交会带上清空前的记录";
      case "recovery_failed": return "服务重启后没能恢复这个对话的交接记录 · 下一条消息只发原话";
      case "input_limit": return `${target} 的上下文窗口放不下交接单 · 消息只发原话`;
      case "consent_revoked": return `你已撤回对 ${named} 的允许 · 消息只发原话`;
      case "consent_goal_only": return `跨厂商交接设为“只交目标”，目前只能发原话 · 想让 ${target} 接着做，可以重新允许`;
    }
  })() + (cause === "input_limit" || cause === "clear_unconfirmed" ? "" : stake);
  const choice = choiceOf(binding), actions: BannerAction[] = [];
  // "只发这条消息" is never a button here: sending alone is what the next message does by itself, and the line above the box has the toggle.
  for (const option of attention.options) {
    const request = option === "send_alone" ? null : relayRequestFor(option, choice);
    if (request !== null) actions.push({ option, label: bannerLabel(option, cause), chosen: bannerChosen(option, cause, target, service), request });
  }
  return { key: attention.key, cause, text, actions };
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
    case "pending": return (binding.canConfirm === false ? "交接单已发出，这个 Harness 无法确认是否收到" : "交接单已发出，送达待确认") + cleared;
    case "suspect": return (binding.attention?.cause === "clear_unconfirmed" ? "清空待确认" : "状态待核对") + " · 下一条消息发出前会核对" + cleared;
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
