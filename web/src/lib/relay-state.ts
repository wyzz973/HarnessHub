import type { PublicMessage, PublicRun } from "../../../src/contracts/session.js";
import type { SessionView } from "../../../src/contracts/web.js";
import { runRelayInfo, type RelayAttentionCause, type RelayBinding, type RelayDecisionInfo, type RelayDeliveryState, type RelayEvidence, type RelayOption, type RelayPacket, type RelayPrefs, type RelayRequest, type RelayTier, type RelayView, type RunRelayInfo } from "../relay.js";
import { compact } from "./format.js";
import { finished } from "./turn.js";

/*
 * What the page makes of the relay facts (ADR-055, docs/proposals/relay/slim.md): which words each state gets, when the hand-over
 * line may say a Harness took over, what is still owed to the Harness the conversation is on, what a binding asks the user to look
 * at, and what each way to answer sends. Pure functions of the conversation view and the relay view, so every state can be checked
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
/** How a Turn continued its context, as a main label and a sub label. */
export function continuityWords(level: RunRelayInfo["continuity"]): { readonly main: string; readonly sub: string | null } {
  switch (level.kind) {
    case "native_resume": return { main: "继续原会话", sub: null };
    case "native_resume_delta": return { main: "继续原会话", sub: level.runs ? `补交 ${level.runs} 轮` : "补交新增的部分" };
    case "rehydrate": return { main: "新会话", sub: `交接单（${tierWords(level.tier ?? null)}）` };
    case "native_fork": return { main: "原生分支", sub: null };
    case "native_import": return { main: "接续本机会话", sub: null };
    case "native_cleared": return { main: "上下文已清空", sub: null };
    case "blocked": return { main: "无法接续", sub: null };
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
// Where the conversation changed hands
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the line where another Harness took over may say. It says "took over" only with evidence: before the packet is known to be in
 * the original program's history the line only says it was handed over.
 *  - `legacy`: the Gateway has no relay information, or the change is within one Harness: the line the page always drew.
 *  - `none`: nothing is drawn yet (nothing was sent to the new Harness, or the Turn is still being prepared).
 */
export type Handover =
  | { readonly kind: "legacy" }
  | { readonly kind: "none" }
  | ShownHandover;
/**
 * The states with something to say. `fresh` says the Turn that carried the hand-over was accepted moments ago, so the line is news and
 * comes in; one drawn with the history of a conversation just opened is not, whenever its facts are read. `runId` is the Turn the line
 * is about. `alone` is a Turn whose history did not go with it (the relay or the user sent the words alone): it says that and why,
 * and never "taken over".
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
/** The words a taken hand-over names its way with: "新会话 · 交接单（完整）· #1", or "继续原会话 · 补交 2 轮". */
function takenHow(info: RunRelayInfo, number: number | null): string {
  const { main, sub } = continuityWords(info.continuity), parts = [main, ...(sub === null ? [] : [sub])];
  if (info.packetId !== null && number !== null) parts.push(sub !== null && sub.startsWith("交接单") ? `#${number}` : `交接单 #${number}`);
  return parts.join(" · ");
}
/**
 * What a Turn's decision means for the user, in words, when it is more than "the history went along as it was owed": a packet sent
 * again, a packet with everything again, a packet that left things out, words sent alone and why. null for a Turn that needs no
 * note. The words never say "taken over": a Turn that went alone has not handed the conversation over.
 */
export interface NoteContext {
  /** The display name of the Harness the Turn ran on. */
  readonly target: string;
  /** "交接单 #n" of the Turn's own packet. */
  readonly number: number | null;
  /** How many Turns the Turn's packet carries (its source Runs): the "N 轮" of a packet sent again for newer facts. */
  readonly sourceRuns: number;
  /** The latest packet sent to this Harness before the Turn: the one an alone Turn left unconfirmed. */
  readonly pending: number | null;
  /** How many items the Turn's own packet left out (the ledger at its end names them); 0 when it left none or the Turn carried none. */
  readonly omissions: number;
  /** Nothing this Harness does can confirm that a handoff arrived. */
  readonly cannotConfirm: boolean;
}
/** The parenthesis of a failed preparation: what could not be done, in words. */
function prepareWords(reason: string | null): string {
  switch (reason) {
    case "render": case "render_mismatch": return "（生成时出错）";
    case "redaction_failed": return "（没能隐去疑似密钥，所以不发）";
    case "storage": case "storage_quota": return "（存储空间不足）";
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
    case "history_changed": return "这条消息只发了原话";
    case "input_limit": return `${target} 一次放不下这条消息和交接单 · 这条只发了原话`;
    case "recovery_failed": return "服务重启后没能恢复这个对话的交接记录 · 这条只发了原话";
    case "prepare_failed": return `这次没能准备交接单${prepareWords(decision.reason)} · 这条只发了原话，下一条会再试`;
    case null: return "这条消息只发了原话";
  }
}
/** A packet that left whole items out because the record did not fit: said when the Turn carried one that is not the complete record. */
function briefNote(info: RunRelayInfo, ctx: NoteContext): string | null {
  if (info.packetId === null || info.continuity.tier !== "brief") return null;
  return ctx.omissions > 0 ? `交接单放不下全部记录，已精简：${ctx.omissions} 项没有放进去，交接单末尾逐项列明` : "交接单放不下全部记录，已精简，没放进去的在交接单末尾逐项列明";
}
export function decisionNote(info: RunRelayInfo, ctx: NoteContext): string | null {
  const decision = info.decision;
  if (decision === null) return briefNote(info, ctx);
  switch (decision.kind) {
    case "carry":
      if (decision.by === "policy") switch (decision.cause) {
        // A packet for newer facts also holds what the unconfirmed one held: it says so, with how many Turns; the automatic resend is the same facts again.
        case "delivery_unconfirmed": return decision.resend === "grown"
          ? `这条消息补交了 ${info.continuity.runs ?? ctx.sourceRuns} 轮，含上次没有确认送达的内容${ctx.number === null ? "" : `（交接单 #${ctx.number}）`}`
          : `上一份交接单没有确认送达，这条消息已再附一次${packetWords(ctx.number, info.continuity.runs)}`;
        case "history_changed": return `${ctx.target} 的会话可能回退过，已整份重发（可能与已有内容重复）`;
        default: break;
      }
      return briefNote(info, ctx);
    case "alone": return aloneWords(decision, ctx);
    case "plain": return decision.by === "user" ? "没有可附的交接内容，这条消息按原样发出" : null;
  }
}
/** What `decisionNote` needs of a Turn: its names, its packet's number, the packet it left unconfirmed, and what its binding says. */
function noteContext(run: PublicRun, index: number, info: RunRelayInfo, view: RelayView | null, name: (id: string) => string): NoteContext {
  const harnessId = info.executedOn?.harnessId ?? run.selection.harnessId, binding = view?.bindings.find(item => item.harnessId === harnessId);
  const own = view?.packets.find(item => item.packetId === info.packetId);
  const before = view?.packets.filter(item => item.target.harnessId === harnessId && item.runIndex < index).at(-1)?.number ?? null;
  return { target: name(harnessId), number: own?.number ?? null, sourceRuns: run.sourceRunIds.length, pending: before, omissions: own?.omissions ?? 0, cannotConfirm: binding?.canConfirm === false };
}
/**
 * The note under each Turn's message that the relay's decision calls for, by Turn: a packet sent again, everything again, a packet that
 * left things out, words sent alone and why. A Turn that needs none has none.
 */
export function runNotes(input: { readonly runs: readonly PublicRun[]; readonly view: RelayView | null; readonly name: (id: string) => string }): ReadonlyMap<string, string> {
  const notes = new Map<string, string>();
  input.runs.forEach((run, index) => {
    const info = runRelayInfo(run), note = info === null ? null : decisionNote(info, noteContext(run, index, info, input.view, input.name));
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
// What is owed to the Harness the conversation is on
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
export function relayLine(session: SessionView, view: RelayView | null, prefs: RelayPrefs | null = null): RelayLine | null {
  if (view === null || session.status !== "open" || session.activeRunId !== null || session.pendingSwitchId !== null || session.runs.length === 0) return null;
  if (session.runs.some(run => !finished(run.status))) return null;
  const target = { harnessId: session.selection.harnessId, controlId: session.selection.controlId };
  const binding = view.bindings.find(item => item.harnessId === target.harnessId && item.controlId === target.controlId);
  // The Gateway keeps a native session for the Harness: what it says is owed is the word (its floors and clears are not the page's to know).
  const runs = binding !== undefined ? binding.owed?.runs ?? 0 : owedRuns(session.runs, target, binding).length;
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
export function relaySignature(session: SessionView | null): string {
  if (session === null) return "";
  const turns = session.runs.map(run => { const info = runRelayInfo(run); return `${run.id}:${finished(run.status) ? "x" : "o"}:${info?.packetId ?? ""}:${info?.delivery?.state ?? ""}`; }).join(",");
  return `${session.id}|${turns}|${session.selection.harnessId}:${session.selection.controlId}|${session.status}:${session.pendingSwitchId ?? ""}`;
}
