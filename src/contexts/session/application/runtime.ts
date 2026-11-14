import { createHash } from "node:crypto";
import { parseProviderTarget } from "../../../contracts/provider.js";
import { HUB_DELEGATION_INSTRUCTIONS, HUB_PROGRESS_INSTRUCTIONS, hubCommandCall, hubCommandInstructions, hubRecordInstructions } from "../../../contracts/table.js";
import { cutTitle } from "../../../contracts/web.js";
import { listedCommand, type TurnText, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlRun, type HarnessControl, type NativeConversationId, type NativeModelCatalog, type NativeUsage } from "../../../contracts/control.js";
import { type ContentKind, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import { CONVERSATION_FORMAT, type Conversation, type ConversationCommit, type ConversationMutation, type ConversationRun, type ConversationStore, type HeldItem, type SessionListCursor } from "../../../contracts/conversation.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId, STOP_GRACE_MS, STREAM_WINDOW_BYTES, STREAM_WINDOW_MS,
  type AttentionItem, type ForkedMessage, type HarnessSelection, type KeptProcessIdentity, type OutsideEvidence, type OutsideProcess, type NativeConfiguration, type NativeSessionBinding, type PermissionRequest, type CancelReceipt, type CommandId, type EventDraft, type PreparedSessionBinding, type PublicNotice, type PublicRun, type RunTiming,
  type SelectionRequest, type SendReceipt, type SessionBindingFactory, type SessionConfiguration,
  type SessionId, type SessionEvent, type SessionRuntimeOptions, type SwitchReceipt, type RunId, type DelegationsTold, type DelegationState, type BoardEntry, type BoardKind, type TaskBoard,
  type MessageId, type SteerReceipt, type ConversationWorktree,
} from "../../../contracts/session.js";
import { buildPublicContext, type PublicContext, type PublicContextOptions } from "../domain/context.js";
import { assertConversationTransition, inputOf, runIn, settledItems, updatedRun, userItemOf, withItems } from "../domain/conversation-state.js";
import { detailJson } from "../domain/detail-json.js";
import { workspacePlacement } from "./workspace-record.js";
import { itemsOf, openTurn, place, takeDetails, type ActiveTurn, type PlaceInput, type Placed, type StoreRequest, type TerminalStatus } from "../domain/items-place.js";
import { runRowOf } from "../domain/run-row.js";
import { originFromRows, originToRows } from "../domain/store-conversion.js";
import { RELAY_DETAIL_POLICY, relayDetailOf, type RelayToolDetail } from "../domain/relay/narration.js";
import { readDetail } from "../domain/detail-read.js";
import { outlineOf, rowsHistory, type RelayHistory } from "../domain/relay/history.js";
import { turnSource } from "../domain/turn-source.js";
import { toolFamily } from "../domain/protocol/index.js";
import { commandEffect, commandOutcome, dispatched, type InputOutcome } from "../domain/relay/advance.js";
import { initialBindingRelay, owed, plan, step, type RelayFact } from "../domain/relay/delivery.js";
import { BLOCKED_CODES, RelayError, type BindingRelayState, type DeliveryRecord, type RelayAttention, type RelayCapabilities, type RelayDeliveryWrite, type RelayIndexRow, type RelayInstallationNotice, type RelayKeyPort, type RelayLogPort, type RelayPacket, type RelayPrefKey, type RelayStorePort } from "../../../contracts/relay.js";
import { relayRedactor, restoreLabels } from "../domain/relay/redaction.js";
import { hardCap, packetBudget, resolveWindow, type ResolvedWindow } from "../domain/relay/windows.js";
import { estimateTokens, type RelayBudget } from "../domain/relay/budget.js";
import { boardAuthor, boardAuthority, conversationLabel } from "../domain/board-words.js";
/**
 * How long a relay read on a Turn's connection (setting the native title) may take before it counts as unavailable (ADR-055 §6.1,
 * C6: ≤2 s).
 */
const RELAY_READ_MS = 2000;
import {
  RelayLedger, UnkeptRelayKeys, acceptedChoices, aloneFor, attentionOf, continuityOf, decisionRecord, deliveryRow, holdsNothing, inputLimit, nativeExactAt, needRuns, packetManifest, packetRef, parseRelayChoices, policyAloneOf,
  rangeOf, recordedStep, relayDeclaration, relaySettings, renderView, runRelayOf, runRelayRequest, settleTurn, undeclaredReading,
  type RelayChoices, type RelayDeclaration, type RelaySettings, type SettledTurn, type TurnDecision,
} from "./relay-coordinator.js";
import { assertInput, carriedNativeConfiguration, parseConfiguration, parseNativeConfiguration, replayCommand, terminal, utf8Bytes } from "../domain/state.js";
import { nativeOnly, selectedPermission } from "../../../contracts/flavor.js";
import { policyDecision, withHubNote, withPlanNote, type PolicyDecision } from "./permission-policy.js";
import type { PermissionLevel } from "../../../contracts/protocol.js";

interface ActiveExecution {
  readonly sessionId: SessionId;
  readonly runId: string;
  /** How far each other conversation of the task was told of to this Turn's Harness while the Turn worked (signalsFor): none is told of twice in one Turn. */
  signaled?: Map<string, number>;
  /** The Harness compacted its own session while this Turn works, and the state has not been said to it since (output, signalsFor). */
  compacted?: boolean;
  /**
   * What the conversation's STATE.md says changed for this Turn, once the file that says it is in place (recordSignals): a Harness that reads the record as files and is
   * seen reading that file (or board.md, for the board) is then told it, as a tool's answer would have told it. Null once told, or when the file says nothing.
   */
  filed?: PendingSignals | null;
  /** The tool calls of this Turn seen naming the conversation's STATE.md or the task's board.md, by their identity, until each completes (recordRead). */
  reads?: Map<string, "state" | "board">;
  binding: PreparedSessionBinding | null;
  run: ControlRun | null;
  /**
   * The native conversation the Turn's prompt went to, set when the prompt is sent, when that prompt is the user's words and not a native command (a clear, a
   * compaction, an export): words the user gives the Turn while it runs go there (steer). Absent before and for a command.
   */
  steerTo?: NativeConversationId;
  /** The answers of words given to the Turn that are still awaited (steer); the Turn ends only once they are in. */
  steers?: Set<Promise<void>>;
  dispatched: boolean;
  backendSettled: boolean;
  stop: Promise<void> | null;
  earlyClose: Promise<CleanupEvidence> | null;
  /**
   * The Turn in progress (items-place.ts): the items it has written so far, in the order its Harness reported them, with the details of its calls that wait to be stored
   * as content. Opened from the Run's own items the first time it is needed; advanced by `place`, and only once the commit that wrote what it placed stood.
   */
  turn: ActiveTurn | null;
  /** Sequential content writes owned by this Turn; drained before its binding closes. */
  writes: Promise<void>;
  writeFailure: unknown;
  /** Where this Turn's stderr begins in its program's stderr, for its diagnostics; null before a program serves it. */
  diagnosticMark: number | null;
  /**
   * The Turn's time (it has no time wall, 2026-11-12): how long it has worked before `since` (monotonic; the clock stops while it
   * waits for the user), whether it waits for the user now, what is left of the budgets an operator set (null: none), the cancels
   * of the timer that watches those and of the one that says "still working", how many of those hints were said, and when its
   * Harness last sent anything.
   */
  readonly clock: { workedMs: number; since: number; waiting: boolean; executionLeftMs: number | null; waitLeftMs: number | null; budget: (() => void) | null; hint: (() => void) | null; hinted: number; lastEventAt: number };
  /** Why the Runtime stopped this Turn on its own, when it did. */
  stopReason: "RUN_TIMEOUT" | "WAIT_EXPIRED" | null;
  /** Ends the program when it has not settled once the stop grace has passed. */
  grace: ReturnType<typeof setTimeout> | null;
  /**
   * What the program streamed and this Turn has not committed yet (ADR-047): one window of reply text or thinking, the UTF-8
   * bytes of the window as they stand (only the window's size is counted; `last`
   * is the final UTF-16 code unit, so a pair split between chunks is counted once), the time its first chunk arrived, and the window's timer, owned by the Turn.
   */
  readonly stream: { kind: "text" | "thinking" | null; text: string; bytes: number; last: string; at: number; cancel: (() => void) | null };
  /** A window refused outside a driver callback (by its timer, a stop or a close); reported as the Turn's failure. */
  streamFailure: unknown;
  /** The Turn's relay (ADR-055 §6.1, §7; G068 phase two): what it checked, sent and saw recorded, until its end commits it. */
  readonly relay: TurnRelay;
}
/**
 * What changed in the task for the Turn in progress that its Harness has not been told (signalsFor): the board when it changed, what the user said since in the
 * conversation the work came from, and what the other conversations changed among the files this one has to do with. Each part with what it says, the line the Turn
 * shows of it and what the conversation remembers once it is told; `seen`: how far each other conversation is then told of within the Turn.
 */
interface PendingSignals {
  readonly runId: RunId;
  readonly board: { readonly text: string; readonly line: string; readonly version: number } | null;
  readonly words: { readonly text: string; readonly line: string; readonly through: number } | null;
  readonly edits: { readonly text: string; readonly line: string; readonly told: Readonly<Record<string, number>>; readonly seen: Readonly<Record<string, number>> } | null;
}
/** What a Turn holds of the relay between its preparation and its end (relay-coordinator.ts does the deciding). */
interface TurnRelay {
  declaration: RelayDeclaration;
  /** What the Turn was authorized to send (none before its authorization). */
  turn: SettledTurn;
  /** The Driver said the input was recorded (E1); for a packet, once committed. */
  recorded: boolean;
  /** The Store refused this Turn's E1: it is not tried again in this Turn. */
  e1Refused: boolean;
}
/** A conversation's kept native process (ADR-030): the binding of its last Run, idle between Turns and owned by the runtime. */
interface KeptProcess {
  readonly binding: PreparedSessionBinding;
  readonly selection: HarnessSelection;
  readonly conversation: NativeConversationId;
  readonly runId: PublicRun["id"];
  readonly since: number;
  /** Updates the process had sent outside its Turns when it was handed over; later ones are its background activity. */
  readonly baseline: number;
  readonly lastUsed: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** The recorded identity of its process group, read once when it was first kept; absent when it could not be read. */
  readonly identity?: KeptProcessIdentity;
}
/** Why a kept process was closed; each close is recorded for its conversation. */
type KeptRelease = "idle" | "disabled" | "ended_by_user" | "selection_changed" | "conversation_closed" | "conversation_deleted" | "native_reset" | "native_reseated" | "branched" | "exited" | "gateway_shutdown" | "harness_upgrade";
/**
 * Why the Hub opens a new native session in the place of one a Turn would have resumed (2026-11-13, second reading). A Harness manages its own window — it compacts
 * its session itself, seeing all of it, and keeps what is its own (its list, the files it read, its processes) — and the Hub, which cannot see into that, does not
 * do it in its place: it keeps the task's state where a compaction cannot lose it and says it again after one. A new native session is the last resort, on evidence
 * that the old one cannot go on: `lost`, the Harness has no session with that identity any more; `overflow`, the last Turn in it failed because the conversation is
 * over the model's window. `full` is an operator's own choice (HARNESSHUB_RESEAT_AT, a share of the window at the end of a Turn): off unless set, kept to measure the
 * one way against the other. A session opened for it is handed at most half of that level, so that it has to grow by as much again before the next time; the other
 * two are handed the conversation as any handoff is — save that a session opened with the conversation that overflowed in its first Turn is followed by one handed less
 * (`shrink`, 2026-11-14: the packet's cap times that factor; the estimate a packet is sized by may be off by half again), until one that went alone overflows too.
 */
type Reseat = { readonly reason: "full"; readonly used: number; readonly size: number } | { readonly reason: "overflow"; readonly shrink: number } | { readonly reason: "lost" };
/** The codes a Turn fails with when the conversation is over the model's window (Codex's own report of it; the ACP Harnesses' as json-rpc-process.ts reads it). */
const OVERFLOW_CODES: ReadonlySet<string> = new Set(["CONTEXT_WINDOW_EXCEEDED", "NATIVE_CONTEXT_EXCEEDED"]);
/** What the Harness is told when its Turn runs in a native session the Hub opened in the place of another; the packet before it and the state after it say the rest. */
function reseatedNote(reason: Reseat["reason"], carried: boolean): string {
  return "（HarnessHub：" + (reason === "lost" ? "你原来的原生会话找不回来了" : "你原来的原生会话上下文满了") + "，这是 HarnessHub 给你换的新会话。"
    + (carried ? "上面是这段对话到现在的内容，里面多数是你自己做的；接着做，不要从头再来。" : "之前的对话这一轮没能带过来；接着做之前先弄清现在做到哪了，不要从头再来。") + "）";
}
/** What goes before the state when it is said again in the middle of a Turn, after the Harness compacted its own session. */
const COMPACTED_NOTE = "（HarnessHub：你的上下文刚被压缩过。下面是 HarnessHub 记着的这件任务现在的状态，照着它接着做手上这一轮。）";
/** A kept process without a Turn for this long is closed (ADR-030). */
export const KEPT_IDLE_MS = 30 * 60 * 1000;
function sameSelection(left: HarnessSelection, right: HarnessSelection): boolean {
  return left.harnessId === right.harnessId && left.controlId === right.controlId && JSON.stringify(left.provider ?? null) === JSON.stringify(right.provider ?? null)
    && (left.nativeModel ?? null) === (right.nativeModel ?? null) && JSON.stringify(Object.entries(left.nativeOptions ?? {}).sort()) === JSON.stringify(Object.entries(right.nativeOptions ?? {}).sort());
}
/** Run statuses of a Turn not yet settled: it is queued, waits for a slot or workspace, or runs. */
const OPEN_RUN = new Set<PublicRun["status"]>(["queued", "preparing", "running", "settling"]);
/** Event-log form of a native event: summaries only, never stored bytes or large previews. */
function logged(value: ControlEvent): ControlEvent | Readonly<Record<string, unknown>> {
  if (value.type === "tool") { const { detail, ...summary } = value; return detail === undefined ? summary : { ...summary, ...(detail.kind === undefined ? {} : { kind: detail.kind }), ...(detail.name === undefined ? {} : { name: detail.name }), ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(detail.parentId === undefined ? {} : { parentId: detail.parentId }) }; }
  if (value.type === "output" && value.output.kind === "content") { const summary: Readonly<Record<string, unknown>> = { type: "output", output: { kind: "content", name: value.output.name, mediaType: value.output.mediaType, bytes: value.output.data.byteLength } }; return summary; }
  return value;
}
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 96) || "tool"; }
/** The message of words given to a Turn in progress, named by the request's key: a repeat of the request finds the same one. */
function steerMessage(command: CommandId): MessageId { return messageId("message-steer-" + createHash("sha256").update(command).digest("hex").slice(0, 32)); }
/**
 * UTF-8 bytes of `prior + next` from `priorBytes`, re-encoding only the last code unit of `prior`: a surrogate pair split
 * between two chunks is three bytes on each side alone and four together, so a window's count stays exact (ADR-047).
 */
function joinedBytes(priorBytes: number, priorLast: string, next: string): number {
  return priorBytes - utf8Bytes(priorLast) + utf8Bytes(priorLast + next);
}
function requested(value: SelectionRequest): SelectionRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "harnessId" && key !== "controlId" && key !== "provider" && key !== "nativeModel" && key !== "nativeOptions") ||
    typeof value.harnessId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value.harnessId) ||
    (value.controlId !== undefined && (typeof value.controlId !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value.controlId))))
    throw new SessionError("INVALID_INPUT", "selection must name bounded catalog identities");
  if (value.nativeModel !== undefined && (typeof value.nativeModel !== "string" || !value.nativeModel.trim() || value.nativeModel.length > 1024 || /[\0\r\n]/u.test(value.nativeModel)))
    throw new SessionError("INVALID_INPUT", "invalid native model identity");
  if ((value.nativeModel !== undefined || value.nativeOptions !== undefined) && value.provider != null) throw new SessionError("INVALID_INPUT", "native model and managed Provider are mutually exclusive");
  return { harnessId: value.harnessId, ...(value.controlId === undefined ? {} : { controlId: value.controlId }),
    ...(value.provider === undefined ? {} : { provider: value.provider === null ? null : parseProviderTarget(value.provider) }),
    ...(value.nativeModel === undefined ? {} : { nativeModel: value.nativeModel }), ...(value.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(value.nativeOptions) }) };
}
function fault(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SessionError) return { code: error.code.slice(0, 128), message: error.message.slice(0, 512) };
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 128) : "CONTROL_FAILED";
  return { code, message: "Harness operation failed; inspect private control diagnostics" };
}
/** How much of a Turn's stderr is kept for its diagnostics, and for how many Turns. */
const RUN_DIAGNOSTIC_BYTES = 4096, MAX_RUN_DIAGNOSTICS = 64;
/**
 * The failures that say the store cannot be trusted (ADR-057 1.5): the storage itself (a broken or changed file, a closed store, any error of the database that
 * is not a rule of the rows), who owns the store (another process, a lost owner generation), and the version of the conversation (a write that lost its race).
 * Only these fail the Runtime. A check that fails on the rows a commit wrote (INVALID_DATA, INVALID_TRANSITION), a relay error and a bound (`*_LIMIT`) are the
 * request's or the Turn's own: they end that one Turn or that one request, told in the conversation, and the Runtime goes on.
 */
const UNTRUSTED_STORE = new Set(["STORAGE_UNAVAILABLE", "STORAGE_CHANGED", "INVALID_STORAGE", "STORAGE_BACKUP_FAILED", "STORE_CLOSED", "OWNER_LOST", "OWNER_BUSY", "OWNER_UNCONFIRMED", "OWNERSHIP_LOST",
  "WORKSPACE_OWNERSHIP_LOST", "VERSION_CONFLICT", "PUBLICATION_FAILED"]);
function storeUntrusted(error: unknown): boolean {
  if (error instanceof RelayError) return false;
  if (error instanceof SessionError) return UNTRUSTED_STORE.has(error.code);
  // Anything else is not a rule of ours: a raw error of the database, or of this code. It is not known to be harmless.
  return true;
}
/** Why a switch fails when the Turn it waited for ended without confirmed settlement (ADR-055 §9, RT2-04). */
const STRANDED_SWITCH = { code: "SWITCH_SOURCE_UNKNOWN", message: "the Turn this switch waited for ended without confirmed settlement; the switch was not applied" } as const;
/**
 * How the user sends one input with respect to the conversation's history (slim.md): `attach: "none"` sends it alone
 * ("只发这条消息"), exactly as typed, and what its Harness is owed stays owed; `attach: "full"` attaches the whole history once,
 * below a clear too ("附上交接单", "再附一次"). Without a choice the relay decides.
 */
export type RelayChoice = RelayChoices;
/** A duration in the user's words: seconds below a minute, whole minutes below two hours, hours (and the minutes over) beyond. */
function duration(ms: number): string {
  if (ms < 1000) return ms + " 毫秒";
  if (ms < 60_000) return Math.round(ms / 1000) + " 秒";
  if (ms < 120 * 60_000) return Math.round(ms / 60_000) + " 分钟";
  const hours = Math.floor(ms / 3_600_000), minutes = Math.round((ms - hours * 3_600_000) / 60_000);
  return minutes === 0 ? hours + " 小时" : hours + " 小时 " + minutes + " 分钟";
}
/** What the conversation says when the Runtime stopped a Turn on its own: only an operator's budget does it (ADR-036, superseded 2026-11-12). */
function budgetNotice(kind: "execution" | "wait", budgetMs: number): PublicNotice {
  return kind === "wait" ? { severity: "warning", title: "等待期限已到", detail: `等待你的决定超过了设置的 ${duration(budgetMs)}，本回合已取消；原程序没有收到决定。` }
    : { severity: "warning", title: "执行期限已到", detail: `本回合的执行时间（不含等待你的时间）超过了设置的 ${duration(budgetMs)}，HarnessHub 已按设置停止它。` };
}
/**
 * The hint a Turn that goes on gets at the marks of its working time: it is not stopped and nothing is asked; the user may stop it at
 * any time. When its Harness has sent nothing for a while the hint says how long, since a quiet Harness is the one that may be stuck.
 */
function workingNotice(workedMs: number, quietMs: number | null): PublicNotice {
  return { severity: "info", title: `已运行 ${duration(workedMs)}，仍在工作`,
    detail: "HarnessHub 不给回合设时间上限，会一直等它做完；想停下可以随时点停止。" + (quietMs === null ? "" : `最近 ${duration(quietMs)} 没有收到这个 Harness 的任何动静，可能在等一个很慢的步骤，也可能卡住了。`) };
}
/** The hint a Turn gets when another conversation is working in its directory: the Hub did not make it wait. */
function sharedNotice(others: number): PublicNotice {
  return { severity: "info", title: "另一个对话也在这个目录里工作",
    detail: (others === 1 ? "另一个对话" : `另外 ${others} 个对话`) + "正在同一个目录里工作，HarnessHub 没有让这一轮等它；两边改同一批文件时可能互相覆盖。" };
}
/** The hint a Turn gets when it asked to keep its process and the limit an operator set on kept processes was reached. */
function keptSkippedNotice(limit: number): PublicNotice {
  return { severity: "info", title: "这一轮的 Harness 进程没有保留", detail: `已经保留了 ${limit} 个对话的 Harness 进程，达到了设置的上限；下一轮会重新启动它。` };
}
/** The longest a timer can wait; a longer wait is chained. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Runs `fn` once after `ms`, however long, without keeping the process alive; returns what cancels it. */
function after(ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (left: number): void => {
    timer = setTimeout(() => { if (left > MAX_TIMER_MS) arm(left - MAX_TIMER_MS); else fn(); }, Math.min(left, MAX_TIMER_MS));
    timer.unref?.();
  };
  arm(Number.isFinite(ms) ? Math.max(0, ms) : MAX_TIMER_MS);
  return () => { if (timer !== undefined) clearTimeout(timer); };
}
/** The marks of a Turn's working time at which it says it goes on (10 min, 30 min, 1 h, 2 h, 4 h, 8 h, then again every 8 h), and how long its Harness may be quiet before the hint says so. */
const WORKING_HINTS_MS: readonly number[] = [10, 30, 60, 120, 240, 480].map(minutes => minutes * 60_000);
const QUIET_NOTE_MS = 5 * 60_000;
/** The Runs of a conversation with each unknown one that the switch `by` covers acknowledged by it (once: one that has been is left as it is). */
function acknowledged(state: Conversation, by: string): readonly ConversationRun[] {
  const covers = new Set(state.switches.find(entry => entry.id === by)?.sourceRunIds ?? []);
  return state.runs.map(run => run.status === "unknown" && run.acknowledgedBy === undefined && covers.has(run.id) ? { ...run, acknowledgedBy: switchId(by) } : run);
}
/** A notice of the Hub itself as the placement takes it (not a Harness's, so it is not kept out as a repeat). */
function hubNotice(notice: PublicNotice, at: number): PlaceInput {
  return { kind: "notice", severity: notice.severity === "warning" ? "warning" : "info", title: notice.title, ...(notice.detail === undefined ? {} : { detail: notice.detail }), at };
}
/** Whether a placement wrote any row (an item, text, a content reference or a notice fingerprint): when it did not, there is nothing to commit for it. */
function wroteRows(changes: Placed["changes"]): boolean {
  return (changes.items?.length ?? 0) > 0 || (changes.text?.length ?? 0) > 0 || (changes.contentRefs?.length ?? 0) > 0 || (changes.noticePrints?.length ?? 0) > 0;
}
function event(type: string, data: Readonly<Record<string, unknown>>): EventDraft { return { type, data }; }
/** A delegation or branch works in its source's folder, so in its source's worktree too: it carries the record, so the last one erased can still remove it. */
function sharedWorktree(source: Conversation): { readonly worktree?: ConversationWorktree } {
  return source.worktree === undefined ? {} : { worktree: { ...source.worktree, inherited: true } };
}
const BOARD_WORDS: Readonly<Record<BoardKind, string>> = { goal: "目标", constraint: "约束", decision: "决定", note: "备注" };
/**
 * The task's board as a Harness reads it: its goal, then the constraints, the decisions and the notes, each with who wrote it — the user's own, or a Harness's reading
 * of the user's words in the Turn it names (board-words.ts). `files`: the Harness reads the record as files, so a Turn is named by its path.
 */
export function boardText(board: TaskBoard, name: (harnessId: string) => string, files = false): string {
  const of = (kind: BoardKind) => board.entries.filter(entry => entry.kind === kind);
  const line = (entry: BoardEntry) => "- " + entry.text + "（" + boardAuthor(entry, name, files) + "）";
  const parts = [...of("goal").map(entry => "目标：" + entry.text + "（" + boardAuthor(entry, name, files) + "）"),
    ...(["constraint", "decision", "note"] as const).flatMap(kind => of(kind).length === 0 ? [] : [BOARD_WORDS[kind] + "：\n" + of(kind).map(line).join("\n")])];
  if (board.entries.length === 0) return "（HarnessHub 任务板：现在是空的，之前给过你的条目都已撤下，不必再照它们做。）";
  return "（HarnessHub 任务板：这件任务里所有 Harness 共同遵守的内容，由用户和各个 Harness 记下，对你同样有效，先照它做。这是最新的一份：之前给过你、这里没有的条目已撤下。" + boardAuthority(files)
    + "用户又说了在这条消息之外也要算数的要求、定了新的决定或目标变了，就用 harnesshub 的 hub_remember 记上去；只管这一条消息的话不记。\n" + parts.join("\n") + "\n）";
}
/** A note of the Hub's as a Harness that has the Hub's tools as a command of the conversation reads it: each tool by its word of that command. */
function asCommand(note: string, command: string | undefined): string {
  if (command === undefined) return note;
  const word = (tool: string) => tool === "read_turn" ? "turn" : tool === "update_plan" ? "plan" : tool === "wrap_up" ? "wrap-up" : tool;
  return note.replace(/harnesshub 的 hub_([a-z_]+)/gu, (_all, tool: string) => "命令 " + command + " " + word(tool)).replace(/hub_([a-z_]+)/gu, (_all, tool: string) => command + " " + word(tool));
}
/** What a remembered context window is kept by: the Harness, its control and the model chosen (none: its own default). */
function windowKey(selection: { readonly harnessId: string; readonly controlId: string; readonly nativeModel?: string }): string { return selection.harnessId + "\n" + selection.controlId + "\n" + (selection.nativeModel ?? ""); }
/** A note of the Hub's as a Harness that reads the record as files reads it (2026-11-13): where it named the reading tools, it names the directory. */
function asFiles(note: string, place: { readonly dir: string; readonly self: string } | null): string {
  if (place === null) return note;
  const at = "记录目录 " + place.dir + " ";
  return note
    .replace("先用 harnesshub 的 hub_task 看全貌，再用 hub_turns、hub_read_turn、hub_search 带上对话标签去读。", "先看" + at + "里的 task.md，再到那段对话的目录里读 index.md 和 turns/NNN.md（目录名就是对话标签）。只在这个目录里面找，不要去它的上级目录。")
    .replace("用 harnesshub 的 hub_task 看全貌，或用 hub_read_turn、hub_search 带上那段对话的标签去读。", "到" + at + "里那段对话的目录读（目录名就是它的标签；index.md、turns/NNN.md）。")
    .replace("用 harnesshub 的 hub_read_turn 带上对话标签去读。", "到" + at + "里那段对话的目录读（目录名就是对话标签；index.md、turns/NNN.md）。")
    .replace("用 harnesshub 的 hub_turns 带上这个对话标签去读。", "在" + at + "里这段对话的 index.md 里。");
}
/** What the Harness of a delegated conversation reads before its task: that this is a part of a larger task, and how the rest of it is read. */
const DELEGATED_NOTE = "（HarnessHub：下面是从另一段对话委派给你的任务，是一件更大的事的一部分。交到你手上的是任务、这件事现在的状态和用户在那段对话里说过的话；那里做过的事（回复、命令、改动的细节）没有带过来，要用就去读。那段对话正在进行的一轮、以及这件事里其他 Harness 做了什么和改了哪些文件，都能读到："
  + "先用 harnesshub 的 hub_task 看全貌，再用 hub_turns、hub_read_turn、hub_search 带上对话标签去读。任务里提到“之前”“别人做的”“本轮”这类你手上没有的内容时，先去那里查，不要猜；动别人可能在改的文件前也先看一眼。）";
/** One piece of delegated work as its conversation's Harness reads it: who had it, how it ended, the task and the reply, each cut at a length a note can carry. */
export function delegationText(entry: DelegationState, ran: readonly string[] = []): string {
  const clip = (text: string, most: number) => { const units = [...text]; return units.length > most ? units.slice(0, most).join("") + "…（后面省略）" : text; };
  const outcome = entry.status === "running" ? "还在做" : entry.status === "completed" ? "已完成" : entry.status === "failed" ? "失败" : entry.status === "cancelled" ? "被停止" : "结果未知";
  const files = entry.files === undefined || entry.files.length === 0 ? "" : "\n它改动的文件：" + entry.files.slice(0, 30).join("、") + (entry.files.length > 30 ? " 等 " + entry.files.length + " 个" : "");
  // Its conversation by the label the Hub's tools take: what it ran and changed is read there, not guessed.
  const label = "c-" + entry.sessionId.replace(/^session-/u, "").replace(/-/gu, "").slice(0, 6);
  return "【" + entry.harness + " · " + outcome + " · 对话 " + label + "】\n任务：" + clip(entry.task, 1200) + (entry.status === "running" ? "" : "\n" + (entry.reply ? "它的回复：\n" + clip(entry.reply, 6000) : "它没有留下文字回复。")) + files
    + (ran.length === 0 ? "" : "\n它最后一轮运行的命令（每条后面是输出的末尾）：\n" + ran.join("\n"));
}
/** Native events that the user sees in the conversation; the first of them marks the Run's first output. */
const VISIBLE_OUTPUT = new Set<ControlEvent["type"]>(["text", "thinking", "tool", "plan", "permission_requested", "output", "activity"]);
/**
 * The Run patch that records one more phase at `now`, never before a phase already recorded (a clock that steps back keeps
 * the order). A Run without timing (accepted before Session v10) and a phase already recorded stay as they are.
 */
function phase(state: Conversation, id: PublicRun["id"], name: Exclude<keyof RunTiming, "acceptedAt">, now: number): Partial<ConversationRun> {
  const timing = runIn(state, id)?.timing;
  if (timing === undefined || timing[name] !== undefined) return {};
  return { timing: { ...timing, [name]: Math.max(now, ...Object.values(timing).filter((value): value is number => typeof value === "number")) } };
}

/**
 * One worker per conversation (several conversations in parallel, ADR-036), durable admission, and a new explicitly
 * rehydrated native connection per Turn, unless the conversation
 * keeps its native process between Turns (ADR-030): then the next Turn with the same selection reuses it, and every close
 * of a kept process (idle, switch, close, reset, branch, shutdown, or the user) is recorded for its conversation.
 */
export class SessionRuntime {
  /** Native processes that conversations keep between Turns, owned here until closed. */
  private readonly kept = new Map<SessionId, KeptProcess>();
  /** Kept processes being closed; every Turn or switch waits for them first, so none meets a lease about to be released. */
  private readonly releasing = new Map<SessionId, Promise<void>>();
  /** Background processes that left a closed or taken-over program's group and still ran; said once in their conversations. */
  private readonly outside = new Map<SessionId, { readonly count: number; readonly at: number }>();
  /** Processes a previous owner kept and this owner found at start, with what became of them; shown in their conversations. */
  private readonly lost = new Map<SessionId, { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number }>();
  /** Conversations whose kept process an upgrade of its Harness closed (ADR-043), until their next Turn. */
  private readonly upgraded = new Map<SessionId, { readonly harnessId: string; readonly at: number }>();
  /** The latest Turns' stderr tails, oldest first; private until redacted for the user's diagnostics. */
  private readonly diagnostics = new Map<string, { readonly sessionId: SessionId; readonly stderr: string; readonly truncated: boolean }>();
  private accepting = true;
  private readonly closingSessions = new Set<SessionId>();
  private readonly managedSessions = new Set<SessionId>();
  private readonly creating = new Set<Promise<Conversation>>();
  /** Whether a conversation started from quoted history (a branch's, an import's), read once per process for an import: what a binding is owed besides the Turns. */
  private readonly quoted = new Map<SessionId, boolean>();
  /** Conversations with work their worker has not taken yet (ADR-036). */
  private readonly work = new Set<SessionId>();
  /** Callers of `wait` whose conversation's work is not taken yet; woken after every scheduling pass. */
  private readonly wakers = new Set<() => void>();
  /** The worker serving each conversation that has one: it runs that conversation's work in order; all run at once unless the operator set `maxParallel`. */
  private readonly workers = new Map<SessionId, Promise<void>>();
  /** The Turn each conversation is executing, at most one per conversation. */
  private readonly actives = new Map<SessionId, ActiveExecution>();
  /**
   * The conversations whose worker is serving them in each workspace, in the order they came. They all run (2026-11-12: the Hub does
   * not queue conversations that share a workspace); a Turn that starts with others already there is told so.
   */
  private readonly holders = new Map<string, SessionId[]>();
  /** Conversations whose next Turn waits for a slot while the operator's limit on conversations running at once is reached, with since when. */
  private readonly waitingForSlot = new Map<SessionId, { readonly runId: string; readonly since: number }>();
  private readonly permissions = new Map<string, { request: PermissionRequest; nativeId: string; execution: ActiveExecution; option: string | null; command: string | null; readonly harnessId: string }>();
  /** Words given to a Turn in progress whose Harness has not answered yet, by conversation and key: a repeat of the request waits for the same answer. */
  private readonly steering = new Map<string, Promise<SteerReceipt>>();
  permissionRequests(id: SessionId): readonly PermissionRequest[] { this.load(id); return [...this.permissions.values()].filter(value => value.execution.sessionId === id).map(value => value.request); }
  /**
   * Every approval or question still waiting for the user, across conversations, oldest first (ADR-035). Requests live only
   * in this owner's memory, so a restarted owner lists none; decided requests are no longer waiting.
   */
  attention(): readonly AttentionItem[] {
    return [...this.permissions.entries()].filter(([, value]) => !value.request.decided).map(([permissionId, value]) => ({ sessionId: value.execution.sessionId, permissionId,
      runId: value.execution.runId, harnessId: value.harnessId, kind: value.request.kind ?? "approval" as const, requestedAt: value.request.requestedAt,
      ...(value.request.expiresAt === undefined ? {} : { expiresAt: value.request.expiresAt, expiresBy: value.request.expiresBy ?? "turn" }) }))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }
  async decidePermission(id: SessionId, permission: string, option: string, key: string, input?: string): Promise<{ readonly replayed: boolean }> {
    const command=commandId(key);
    if (!/^permission-[A-Za-z0-9-]{1,96}$/u.test(permission) || typeof option!=="string" || !option || option.length>1024 || /[\0\r\n]/u.test(option)) throw new SessionError("INVALID_INPUT","invalid native permission decision");
    if (input !== undefined && (typeof input !== "string" || input.includes("\0"))) throw new SessionError("INVALID_INPUT", "invalid native input response");
    const state = this.load(id), pending = this.permissions.get(permission);
    // A secret the user typed is kept nowhere: not in the item, not in the event, and not in the command's fingerprint, which is a bare digest of the request that a
    // guess could be checked against. The fingerprint of a secret answer is the decision's alone; a replay of the same key finds it so.
    const secret = pending?.request.input?.kind === "secret", bare = this.fingerprint({kind:"permission",permission,option}), full = input === undefined ? bare : this.fingerprint({kind:"permission",permission,option,input});
    const recorded = state.commands.find(entry => entry.id === command);
    const fingerprint = recorded !== undefined && recorded.fingerprint === bare ? bare : secret ? bare : full, prior=replayCommand(state,command,"permission",fingerprint);
    if (prior) return {replayed:true};
    if (!pending || pending.execution.sessionId !== id || !pending.request.options.some(value => value.id === option)) throw new SessionError("PERMISSION_UNAVAILABLE", "native permission or option is no longer pending");
    if(input!==undefined&&(!pending.request.input||input.includes("\0")))throw new SessionError("INVALID_INPUT","invalid native input response");
    if (pending.option !== null) { if (pending.option === option && pending.command === key) return { replayed: true }; throw new SessionError("PERMISSION_CONFLICT", "native permission has already been decided"); }
    this.continue(pending.execution);
    const control = pending.execution.binding?.control;
    if (!control?.decidePermission) throw new SessionError("UNSUPPORTED_PERMISSION", "native approval is unavailable");
    pending.option = option; pending.command = key; pending.request = { ...pending.request, decided: true };
    // The decision is written in the item that waited (who decided, and what), with the command and the event, in one commit.
    try { this.placed(pending.execution, { kind: "decided", id: pending.nativeId, option, ...(input === undefined || secret ? {} : { input }), by: "user", at: this.options.now().getTime() },
      [event("permission.decided", { permissionId: permission, runId: pending.execution.runId, optionId: option, commandId: key })],
      { patch: current => ({ ...current, commands: [...current.commands, { id: command, kind: "permission", fingerprint, resultId: pending.execution.runId }] }), always: true }); }
    catch(error) { pending.option=null;pending.command=null;pending.request={...pending.request,decided:false};throw error; }
    this.leaveWait(pending.execution);
    await control.decidePermission(pending.nativeId, option, input); this.owned(pending.execution);
    this.permissions.delete(permission);
    this.commit(id, current => ({ next: current, events: [event("permission.submitted", { permissionId: permission, runId: pending.execution.runId, optionId: option, backendAcknowledged: false })] }));
    return { replayed: false };
  }
  /**
   * Answers a permission request by the Hub's policy for the conversation's permission level when the policy decides it: the decision is the
   * item's, by "policy" and the level (the user sees what the Hub allowed or refused for them), and goes to the Harness as the user's would.
   */
  private async answerByPolicy(execution: ActiveExecution, permission: string, run: ConversationRun, value: Extract<ControlEvent, { type: "permission_requested" }>): Promise<void> {
    const pending = this.permissions.get(permission), level = selectedPermission(run.selection.nativeOptions), control = execution.binding?.control;
    if (pending === undefined || level === undefined || !control?.decidePermission) return;
    const decision = this.policyFor(execution, run, value, level);
    if (decision.option === null || pending.option !== null) return;
    pending.option = decision.option; pending.command = "policy"; pending.request = { ...pending.request, decided: true };
    this.placed(execution, { kind: "decided", id: pending.nativeId, option: decision.option, by: "policy", level, at: this.options.now().getTime() },
      [event("permission.decided", { permissionId: permission, runId: execution.runId, optionId: decision.option, by: "policy", level, kind: decision.kind, answer: decision.answer })], { always: true });
    this.leaveWait(execution);
    await control.decidePermission(pending.nativeId, decision.option); this.owned(execution);
    this.permissions.delete(permission);
    this.commit(execution.sessionId, current => ({ next: current, events: [event("permission.submitted", { permissionId: permission, runId: execution.runId, optionId: decision.option!, backendAcknowledged: false })] }));
  }
  /** The Hub's policy decision for a request under `level` (permission-policy.ts), by the request and the call it is about as this Turn placed it; undefined level: what it is about, the user deciding. */
  private policyFor(execution: ActiveExecution, run: ConversationRun, value: Extract<ControlEvent, { type: "permission_requested" }>, level: PermissionLevel | undefined): PolicyDecision {
    const call = value.forCall === undefined || execution.turn === null ? undefined : itemsOf(execution.turn).find(item => item.itemId === "tool:" + value.forCall)?.fields;
    const named = call as { readonly title?: unknown; readonly name?: unknown; readonly hub?: unknown; readonly command?: unknown; readonly path?: unknown } | undefined;
    return policyDecision(this.options.flavor?.(run.selection.harnessId), level, { title: value.title, options: value.options, question: value.kind === "question" || value.input !== undefined },
      [value.toolKind, call?.native?.kind], call === undefined ? undefined : { type: call.type, ...(typeof named?.title === "string" ? { title: named.title } : {}), ...(typeof named?.name === "string" ? { name: named.name } : {}), ...(named?.hub === true ? { hub: true } : {}), ...(typeof named?.command === "string" ? { command: named.command } : {}), ...(typeof named?.path === "string" ? { path: named.path } : {}) },
      // Reading the record's directory is the Hub's own business, like its tools.
      this.recordPlace(execution.sessionId, execution.binding)?.dir);
  }
  /** The switch target each conversation is validating, at most one per conversation. */
  private readonly switchBindings = new Map<SessionId, { readonly binding: PreparedSessionBinding; close: Promise<CleanupEvidence> | null }>();
  private fatal: SessionError | null = null;
  private publicationFailed = false;
  private recordingBlock = false;
  private shutdown: Promise<void> | null = null;

  /** The public facts a conversation's Runs place (ADR-055 §2; ADR-057 3.3): read from the Runs' rows. */
  private readonly ledger = new RelayLedger();
  /**
   * The keyed digests of delivery rows and of a request's relay options (ADR-055 §10.2): the installation's relay key the
   * composition gives (relay-keys.ts), else one this owner keeps in memory only (UnkeptRelayKeys, rows named EPHEMERAL_KEY_ID).
   */
  private readonly relayKeys: RelayKeyPort;
  private readonly unkeptKeys = new UnkeptRelayKeys();
  /**
   * The relay choices of the inputs this owner accepted, as their `message.accepted` events committed them, until their Turn
   * reads them (G068 fix batch, R8): an ordinary Turn reads no event for them. A Turn accepted by an earlier owner reads its event.
   */
  private readonly acceptedRelay = new Map<string, RelayChoices>();
  constructor(private readonly store: ConversationStore, private readonly factory: SessionBindingFactory, private readonly options: SessionRuntimeOptions) {
    this.relayKeys = options.relayKeys ?? new UnkeptRelayKeys();
  }

  /**
   * A new conversation, idempotently by key. `extra.worktree` (2026-11-14): the Git worktree it was started in, made by the caller before (its workspace is in it), kept
   * with the conversation; a repeat of the key answers the conversation it made and keeps the worktree it was made with.
   */
  create(configuration: SessionConfiguration, selection: SelectionRequest, key: string, extra: { readonly worktree?: ConversationWorktree } = {}): Promise<Conversation> {
    try {
      this.admit();
    } catch (error) { return Promise.reject(error); }
    const pending = this.createOwned(configuration, selection, key, extra.worktree);
    this.creating.add(pending);
    void pending.then(() => { this.creating.delete(pending); }, () => { this.creating.delete(pending); });
    return pending;
  }
  private async createOwned(configuration: SessionConfiguration, selection: SelectionRequest, key: string, worktree: ConversationWorktree | undefined): Promise<Conversation> {
    this.admit();
    const config = parseConfiguration(configuration), request = requested(selection), command = commandId(key);
    if (worktree !== undefined && [worktree.root, worktree.path, worktree.branch, worktree.baseSha].some(part => typeof part !== "string" || part === "" || /[\0\r\n]/u.test(part)))
      throw new SessionError("INVALID_INPUT", "a worktree is its repository, its folder, its branch and the commit it started from");
    const fingerprint = this.fingerprint({ kind: "create", configuration: config, selection: request });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return this.load(prior.id); }
    const validated = await this.factory.validate(request, config);
    this.admit();
    // Validation has an await boundary; another create may have committed the same command in the meantime.
    const concurrent = this.store.findByCreateKey(command);
    if (concurrent) { replayCommand(concurrent, command, "create", fingerprint); return this.load(concurrent.id); }
    const id = sessionId("session-" + this.options.id());
    const state: Conversation = { id, version: 0, lastSeq: 0, format: CONVERSATION_FORMAT, epoch: 1, status: "open",
      configuration: config, selection: validated, activeRunId: null, pendingSwitchId: null,
      runs: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      ...(worktree === undefined ? {} : { worktree: { root: worktree.root, path: worktree.path, branch: worktree.branch, baseSha: worktree.baseSha } }) };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "public_context_rehydrate", ...(worktree === undefined ? {} : { worktree: { path: worktree.path, branch: worktree.branch } }) })]);
      this.managedSessions.add(committed.conversation.id);
      this.publish(committed);
      return this.load(id);
    }
    catch (error) { if (storeUntrusted(error)) this.fail(error, id); throw error; }
  }

  /**
   * Continues a native session of the installed Harness as a new conversation. The session must belong to this workspace
   * and no other conversation may hold it; its recent messages are quoted (never re-executed) and its reference becomes
   * this conversation's native session, so the next input goes to it directly. Nothing is sent to a model.
   */
  importNative(configuration: SessionConfiguration, selection: SelectionRequest, nativeId: string, key: string): Promise<Conversation> {
    try {
      this.admit();
    } catch (error) { return Promise.reject(error); }
    const pending = this.importOwned(configuration, selection, nativeId, key);
    this.creating.add(pending);
    void pending.then(() => { this.creating.delete(pending); }, () => { this.creating.delete(pending); });
    return pending;
  }
  private async importOwned(configuration: SessionConfiguration, selection: SelectionRequest, nativeId: string, key: string): Promise<Conversation> {
    this.admit();
    if (typeof nativeId !== "string" || !nativeId.trim() || Buffer.byteLength(nativeId) > 1024 || /[\0-\x1f\x7f]/u.test(nativeId)) throw new SessionError("INVALID_INPUT", "invalid native session identity");
    const config = parseConfiguration(configuration), request = requested(selection), command = commandId(key);
    if (request.provider != null) throw new SessionError("INVALID_INPUT", "a native session continues with its own Harness, not a managed Provider");
    const fingerprint = this.fingerprint({ kind: "import", configuration: config, selection: request, nativeId });
    const replay = () => { const prior = this.store.findByCreateKey(command); if (prior) replayCommand(prior, command, "create", fingerprint); return prior; };
    const prior = replay(); if (prior) return this.load(prior.id);
    const validated = await this.factory.validate(request, config);
    this.admit();
    if (validated.provider !== undefined) throw new SessionError("INVALID_INPUT", "a native session continues with its own Harness, not a managed Provider");
    if (!this.factory.readNativeSession) throw new SessionError("NATIVE_SESSION_LIST_UNAVAILABLE", "this Gateway cannot read native sessions");
    const held = (checkpoint: string) => {
      const owner = this.store.nativeOwners(validated.harnessId, validated.controlId).get(checkpoint);
      if (owner !== undefined) throw new SessionError("NATIVE_SESSION_CONFLICT", "这个本机会话已经在另一个对话中继续：" + owner);
    };
    held(nativeId);
    const read = await this.factory.readNativeSession(validated, config, nativeId);
    this.admit();
    const concurrent = replay(); if (concurrent) return this.load(concurrent.id);
    const checkpoint = read.checkpoint;
    if (typeof checkpoint !== "string" || !checkpoint || Buffer.byteLength(checkpoint) > 8192 || /[\0\r\n]/u.test(checkpoint)) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "invalid original Harness recovery reference");
    held(checkpoint);
    // Every message the native session returned is quoted: the Hub holds no count or size of it (what the Driver could not read is `omitted`, told as it is).
    const omitted = Number.isSafeInteger(read.omitted) && read.omitted > 0 ? read.omitted : 0;
    const quoted: ForkedMessage[] = (read.historyRead ? read.history : []).map(entry => ({ role: entry.role, text: entry.text, status: "completed" as const, ...(entry.role === "assistant" ? { harnessId: validated.harnessId } : {}) }));
    const title = typeof read.title === "string" && read.title.trim() ? read.title.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, 200) : null;
    const id = sessionId("session-" + this.options.id());
    const parts = originToRows(id, { kind: "import", harnessId: validated.harnessId, title, omitted, complete: read.historyRead === true && read.complete === true, historyRead: read.historyRead === true, history: quoted }, 0);
    const state: Conversation = { id, version: 0, lastSeq: 0, format: CONVERSATION_FORMAT, epoch: 1, status: "open", configuration: config, selection: validated,
      activeRunId: null, pendingSwitchId: null, runs: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }], origin: parts.stored,
      nativeBindings: [{ harnessId: validated.harnessId, controlId: validated.controlId, checkpoint, throughRunId: null, status: "ready", relay: initialBindingRelay([], validated.harnessId, validated.controlId, "import") }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "native_import",
        origin: { harnessId: validated.harnessId, messages: quoted.length, omitted, historyRead: read.historyRead === true } })], parts.rows);
      this.managedSessions.add(id);
      this.publish(committed);
      return this.load(id);
    } catch (error) { if (storeUntrusted(error)) this.fail(error, id); throw error; }
  }

  /**
   * Accepts one input for the conversation's next Turn, idempotently by key. `relay` carries the user's relay choice (RelayChoice):
   * with `{ attach: "none" }` the input is sent alone, exactly as typed, and the public facts its Harness is owed stay owed; with
   * `{ attach: "full" }` the whole history goes with it once, below a clear boundary too. A key keeps its choice, and the same key
   * with another choice conflicts. The relay never refuses an input: what concerns the history it would carry is settled at the
   * Turn's open, where the input goes as typed and the Run says why (`relay.decision`). The choice is kept with the Run
   * (`relayRequest`, the choice and its HMAC).
   */
  send(id: SessionId, text: string, key: string, attachmentIds: readonly string[] = [], relay?: RelayChoice, branchFrom?: string): SendReceipt {
    this.admit(); assertInput(text);
    if (branchFrom !== undefined && (typeof branchFrom !== "string" || !/^run-[A-Za-z0-9-]{1,128}$/u.test(branchFrom))) throw new SessionError("INVALID_INPUT", "invalid branch point");
    if (!Array.isArray(attachmentIds) || attachmentIds.some(value => typeof value !== "string")) throw new SessionError("INVALID_INPUT", "attachments must be content identities");
    const choices = parseRelayChoices(relay);
    // Without attachments or relay choices the fingerprint keeps its earlier shape, so replayed commands from before still match.
    const command = commandId(key), fingerprint = this.fingerprint({ ...(attachmentIds.length ? { kind: "send", text, attachments: attachmentIds } : { kind: "send", text }), ...(choices === undefined ? {} : { relay: choices }),
      ...(branchFrom === undefined ? {} : { branchFrom }) }), state = this.load(id);
    const prior = replayCommand(state, command, "send", fingerprint);
    if (prior) return { sessionId: id, runId: runId(prior.resultId), replayed: true };
    this.open(state);
    // Sent again from an earlier place (the message of the Turn `branchFrom` edited, or its reply tried again): the new Turn takes that Turn's place on a branch of its own.
    const branchAt = branchFrom === undefined ? undefined : state.runs.findIndex(run => run.id === branchFrom);
    if (branchAt !== undefined) {
      if (branchAt < 0) throw new SessionError("BRANCH_NOT_FOUND", "这个对话里没有这一轮");
      this.idleForBranch(state);
    }
    let attachments: readonly ContentRef[] = [];
    if (attachmentIds.length) {
      if (this.options.content === undefined) throw new SessionError("ATTACHMENT_UNAVAILABLE", "this Gateway has no content storage for attachments");
      attachments = this.options.content.resolve(attachmentIds, state.configuration.workspace);
    }
    // A key that cannot be used never stops an input (one sent alone included): its choice is then fingerprinted under a key
    // kept in memory only (EPHEMERAL_KEY_ID, not checkable), and any packet it would carry fails at its own preparation.
    let relayRequest: ReturnType<typeof runRelayRequest>;
    try { relayRequest = runRelayRequest(id, choices, this.relayKeys); }
    catch (error) { if (!(error instanceof RelayError)) throw error; relayRequest = runRelayRequest(id, choices, this.unkeptKeys); }
    const nextId = runId("run-" + this.options.id()), userId = messageId("message-" + this.options.id()), assistantId = messageId("message-" + this.options.id());
    const acceptedAt = this.options.now().getTime();
    // What this owner found of a process kept under the previous one is shown until the conversation's next Turn.
    this.lost.delete(id); this.outside.delete(id); this.upgraded.delete(id);
    this.commit(id, withArchived => {
      // A Turn accepted in an archived conversation takes the mark off, in the same commit: the conversation is at work again (2026-11-14). So does it a reminder
      // the conversation was put aside with; a pin stays.
      const { archived: _archived, snoozedUntil: _snoozed, ...current } = withArchived;
      const at = branchAt === undefined ? current.runs.length : branchAt;
      if (branchAt !== undefined && current.runs[branchAt]?.id !== branchFrom) throw new SessionError("VERSION_CONFLICT", "the conversation moved before the branch");
      // The input is the Run's first item (its `user` message); the Run's ordinal is its place among the Runs, and its input is the first event of the commit.
      const run: ConversationRun = { id: nextId, commandId: command, userMessageId: userId, assistantMessageId: assistantId,
        selection: current.selection, epoch: current.epoch, status: "queued", cancelRequested: false, contextThroughSeq: 0,
        sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: current.pendingSwitchId, ...(attachments.length ? { attachments } : {}),
        timing: { acceptedAt }, ...(relayRequest === undefined ? {} : { relayRequest }), ordinal: at, userSeq: current.lastSeq + 1, isCommand: false, items: [userItemOf({ id: nextId, userMessageId: userId }, text, acceptedAt)] };
      const accepted = event("message.accepted", { runId: nextId, messageId: userId, role: "user", text, ...(attachments.length ? { attachments } : {}), ...(choices === undefined ? {} : { relay: choices }), ...(relayRequest === undefined ? {} : { relayRequest }) });
      if (branchAt === undefined) return { next: { ...current, runs: [...current.runs, run], commands: [...current.commands, { id: command, kind: "send", fingerprint, resultId: nextId }] }, events: [accepted] };
      const branched = this.branchedFrom(current);
      return { next: { ...branched, runs: [...current.runs.slice(0, at), run], commands: [...current.commands, { id: command, kind: "send", fingerprint, resultId: nextId }] },
        events: [accepted, event("conversation.branched", { fromRunId: branchFrom, ordinal: at, runId: nextId })], branch: { at } };
    });
    if (branchAt !== undefined && this.kept.has(id)) void this.requestRelease(id, "native_reset");
    this.acceptedRelay.set(nextId, choices ?? {});
    // Inputs cancelled before they run never read theirs: the oldest go first, so this stays bounded.
    if (this.acceptedRelay.size > 4096) this.acceptedRelay.delete(this.acceptedRelay.keys().next().value!);
    this.schedule(id); return { sessionId: id, runId: nextId, replayed: false };
  }
  /**
   * Makes the branch through the Turn `target` (an alternative of a Turn on the path: its message edited and sent again, or its reply tried again) the conversation's path. Only
   * the current place changes: nothing runs. The native sessions are given up, as after a branch from an earlier place, so the next Turn opens new ones and is handed the path's history.
   */
  selectBranch(id: SessionId, target: string, key: string): Conversation {
    this.admit();
    if (typeof target !== "string" || !/^run-[A-Za-z0-9-]{1,128}$/u.test(target)) throw new SessionError("INVALID_INPUT", "invalid branch");
    const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "branch", target });
    if (replayCommand(state, command, "branch", fingerprint)) return this.load(id);
    if (state.status === "closed") throw new SessionError("SESSION_CLOSED", "a closed conversation does not change branch");
    this.idleForBranch(state);
    const store = this.store as Partial<Pick<ConversationStore, "selectBranch">>;
    if (typeof store.selectBranch !== "function") throw new SessionError("BRANCH_UNAVAILABLE", "this Gateway's store keeps no branches");
    try {
      this.store.assertOwner();
      const committed = store.selectBranch(id, state.version, runId(target), current => {
        const made: ConversationMutation = { next: { ...this.branchedFrom(current), commands: [...current.commands, { id: command, kind: "branch", fingerprint, resultId: target }] },
          events: [event("conversation.branched", { toRunId: target })] };
        assertConversationTransition(current, made.next, made.events);
        return made;
      });
      this.versions.set(id, committed.conversation.version);
      this.publish(committed);
    } catch (error) { if (storeUntrusted(error)) this.fail(error, id); throw error; }
    if (this.kept.has(id)) void this.requestRelease(id, "native_reset");
    return this.load(id);
  }
  /**
   * What the Harness of the Turn in progress says of it through the Hub's tools (hub-tools.ts): its task list, replacing the one the Turn had (the Turn's `plan` item, the same
   * item a Harness's own task list is), or its wrap-up (the Turn's `recap`: a short recap, maybe a question and the answers to offer). Only the Harness the Turn runs on, and only
   * while the Turn runs; written and published as any report of the Turn is.
   */
  hubProgress(id: SessionId, from: { readonly harnessId: string; readonly controlId: string }, made:
    | { readonly kind: "plan"; readonly items: readonly { readonly content: string; readonly status: "pending" | "in_progress" | "completed" }[]; readonly explanation?: string }
    | { readonly kind: "recap"; readonly summary: string; readonly ask?: string; readonly actions?: readonly string[]; readonly title?: string }): void {
    this.admit();
    const execution = this.actives.get(id);
    if (execution === undefined) throw new SessionError("NO_TURN_IN_PROGRESS", "这个对话现在没有进行中的回合");
    const state = this.owned(execution), run = runIn(state, execution.runId);
    if (run === undefined || run.status !== "running") throw new SessionError("NO_TURN_IN_PROGRESS", "这个对话现在没有进行中的回合");
    if (run.selection.harnessId !== from.harnessId || run.selection.controlId !== from.controlId) throw new SessionError("NOT_THIS_TURN", "进行中的回合不是这个 Harness 在跑");
    execution.clock.lastEventAt = performance.now();
    this.flushStream(execution);
    const at = this.options.now().getTime();
    if (made.kind === "plan") {
      const value: ControlEvent = { type: "plan", entries: made.items.map(item => ({ content: item.content, status: item.status })), ...(made.explanation === undefined ? {} : { explanation: made.explanation }) };
      this.firstOutput(state, run);
      this.placed(execution, { kind: "event", event: value, at }, [event("run.output", { runId: run.id, event: logged(value), by: "hub_tool" })], { always: true });
    } else this.placed(execution, { kind: "recap", summary: made.summary, ...(made.ask === undefined ? {} : { ask: made.ask }), ...(made.actions === undefined ? {} : { actions: made.actions }), at },
      [event("run.recap", { runId: run.id, summary: made.summary, ...(made.ask === undefined ? {} : { ask: made.ask }), ...(made.actions === undefined ? {} : { actions: made.actions }) })], { always: true });
    // The wrap-up of a first Turn may name the conversation (2026-11-14); a name the user gave, or one the Harness gave before, stays.
    if (made.kind === "recap" && made.title !== undefined) this.nameByHarness(id, made.title);
    // Where the conversation stands changed: its STATE.md says so now, not at the Turn's end.
    this.refreshRecord(id);
  }
  /**
   * Words the user gives the Turn of `id` while it runs (2026-11-14; T3 Code's steer): handed to its Harness, which takes them into the turn in progress and goes
   * on with them, instead of the page keeping them until the Turn ends. Only while a Turn of the user's words (not a native command) runs in its Harness — its
   * prompt was sent, it has not settled and is not being stopped — and only where its connection takes words mid-turn (HarnessControl.steering): otherwise
   * STEER_NO_ACTIVE_TURN or STEER_UNSUPPORTED, nothing is written, and the page keeps the words for after the Turn (its queue).
   *
   * The words are the Turn's: a `user_message` of their own (`steer:<n>`, `steered`), committed `pending` with the command before the Harness is given them, then
   * `completed` (it took them), `declined` (it took nothing: the Turn had just ended; the request fails with STEER_REFUSED and the page sends them as a message of
   * their own, so they are not lost and not said twice), or `unknown` (it could not be told: they may have reached it, and they are never sent again). The Turn
   * ends only once each answer is in. Nothing is ever done by stopping the Turn and sending again; the stop, the settlement and the cleanup are untouched. The
   * same key answers as the first request did.
   */
  steer(id: SessionId, text: string, key: string): Promise<SteerReceipt> {
    try {
      this.admit(); assertInput(text);
      if (text.trim() === "") throw new SessionError("INVALID_INPUT", "steering words must say something");
      const command = commandId(key), fingerprint = this.fingerprint({ kind: "steer", text }), state = this.load(id), message = steerMessage(command);
      const prior = replayCommand(state, command, "steer", fingerprint);
      if (prior) return this.steerReplay(id, prior.id, runId(prior.resultId), message);
      const execution = this.actives.get(id), run = execution === undefined ? undefined : runIn(state, execution.runId);
      if (execution === undefined || run === undefined || run.status !== "running" || execution.run === null || execution.steerTo === undefined || execution.backendSettled
        || execution.stop !== null || run.cancelRequested || run.stopRequested || (execution.turn !== null && execution.turn.settled !== null))
        throw new SessionError("STEER_NO_ACTIVE_TURN", "这个对话现在没有正在 Harness 里进行的回合，这句话没有插进去，等这一轮结束后按普通消息发出。");
      const control = execution.binding?.control;
      if (control?.steer === undefined || control.steering !== true)
        throw new SessionError("STEER_UNSUPPORTED", "这个 Harness 不能在一轮进行中接收新的话，这句话没有插进去，等这一轮结束后按普通消息发出。");
      const to = execution.steerTo, target = run.id, at = this.options.now().getTime();
      // The words are the Turn's before the Harness is given them: their item, the command and the event in one commit.
      this.flushStream(execution);
      this.placed(execution, { kind: "steer", messageId: message, text, at }, [event("message.steered", { runId: target, messageId: message, text, commandId: command })],
        { patch: current => ({ ...current, commands: [...current.commands, { id: command, kind: "steer", fingerprint, resultId: target }] }), always: true });
      const answered = this.answerSteer(execution, control, to, text, target, message);
      const inflight = id + "\n" + command;
      this.steering.set(inflight, answered);
      const tracked = answered.then(() => undefined, () => undefined).finally(() => { this.steering.delete(inflight); execution.steers?.delete(tracked); });
      (execution.steers ??= new Set()).add(tracked);
      return answered;
    } catch (error) { return Promise.reject(error); }
  }
  /** What the Harness says of words given to the Turn, written into their item while the Turn is open (it waits for it), and the receipt. */
  private async answerSteer(execution: ActiveExecution, control: HarnessControl, to: NativeConversationId, text: string, target: RunId, message: MessageId): Promise<SteerReceipt> {
    let outcome: "taken" | "not_taken" | "unknown";
    try { outcome = await control.steer!(to, text); } catch { outcome = "unknown"; }
    const id = execution.sessionId;
    // A Turn whose program was ended early, or that ended meanwhile, closed the item as what it was left as; the answer is then only logged.
    if (this.actives.get(id) === execution && (execution.turn === null || execution.turn.settled === null) && execution.earlyClose === null)
      this.placed(execution, { kind: "steered", messageId: message, outcome, at: this.options.now().getTime() }, [event("message.steer_answered", { runId: target, messageId: message, outcome })], { always: true });
    else this.commit(id, current => ({ next: current, events: [event("message.steer_answered", { runId: target, messageId: message, outcome, late: true })] }));
    if (outcome === "not_taken") throw new SessionError("STEER_REFUSED", "Harness 没有收下这句话（这一轮刚好结束了），它没有插进去，按普通消息发出。");
    return { sessionId: id, runId: target, messageId: message, outcome, replayed: false };
  }
  /** The answer to a steer request repeated with its key: the first request's, as it stands (still being answered, or as its item says). */
  private steerReplay(id: SessionId, command: CommandId, target: RunId, message: MessageId): Promise<SteerReceipt> {
    const inflight = this.steering.get(id + "\n" + command);
    if (inflight !== undefined) return inflight.then(receipt => ({ ...receipt, replayed: true }));
    const state = this.load(id), at = state.runs.findIndex(row => row.id === target), held = state.runs[at]?.items;
    // A finished Turn is read from its rows (whole: a body left out would leave its fields empty).
    const items = held ?? (at < 0 ? [] : this.store.turnAt(id, at, { inlineBytes: Infinity })?.items ?? []);
    const status = items.find(item => item.itemId.startsWith("steer:") && (item.fields as { readonly messageId?: unknown }).messageId === message)?.status;
    if (status === "declined") return Promise.reject(new SessionError("STEER_REFUSED", "Harness 没有收下这句话（这一轮刚好结束了），它没有插进去，按普通消息发出。"));
    return Promise.resolve({ sessionId: id, runId: target, messageId: message, outcome: status === "completed" ? "taken" : "unknown", replayed: true });
  }
  /**
   * What changed in the task while the Turn in progress of `id` works (2026-11-13), for its Harness: said with the answer of a tool of the Hub's it calls, as a signal
   * reaches a process when it comes back from a system call — it does not wait for the Harness's next Turn. The board when it changed, what the user said since in the
   * conversation this one's work came from, and what the other conversations of the task changed among the files this one has read or changed. Each is then told (the
   * Turn says so, and it is not said again with the next Turn); null when nothing changed, or the Turn in progress is not this Harness's.
   */
  signalsFor(id: SessionId, from: { readonly harnessId: string; readonly controlId: string }): string | null {
    this.admit();
    const execution = this.actives.get(id);
    if (execution === undefined) return null;
    const state = this.owned(execution), run = runIn(state, execution.runId);
    if (run === undefined || run.status !== "running" || run.selection.harnessId !== from.harnessId || run.selection.controlId !== from.controlId) return null;
    const notes: string[] = [], at = this.options.now().getTime(), place = this.recordPlace(id, execution.binding);
    this.flushStream(execution);
    // The Harness compacted its own session in this Turn: what it holds of the task after that the Hub cannot see, so the state is said to it whole, now, and not
    // with its next Turn (2026-11-13). It holds the board, which is then not said a second time below. No packet goes with it: it carries the user's words by the
    // rule a handoff to this Harness would carry them.
    if (execution.compacted === true) {
      execution.compacted = false;
      const standing = this.options.context?.state?.(id, null, place !== null, "whole", this.wordsBudget(state, run, null)) ?? null;
      if (standing !== null) {
        const version = this.taskBoard(id).version;
        this.placed(execution, { kind: "notice", severity: "info", title: "它压缩了上下文，带上了任务现在的状态", code: "TASK_STATE_TOLD", at },
          [event("run.task_state_told", { runId: run.id, cause: "compaction", during: true })], { always: true, patch: current => ({ ...current, taskBoardTold: Math.max(current.taskBoardTold ?? 0, version) }) });
        notes.push(COMPACTED_NOTE + "\n" + standing);
        this.pinned.set(id, run.id);
      }
    }
    const pending = this.pendingSignals(execution, run.id, this.load(id), place !== null);
    if (pending !== null) notes.push(...this.markSignals(execution, pending, "tool"));
    if (notes.length === 0) return null;
    // What was told is pending no more: the conversation's STATE.md stops saying it.
    this.refreshRecord(id);
    return notes.map(note => asCommand(asFiles(note, place), execution.binding?.hubCommand)).join("\n\n");
  }
  /** What changed in the task for the Turn `runId` that its Harness has not been told (PendingSignals); null when nothing. Reads only. */
  private pendingSignals(execution: ActiveExecution, runId: RunId, state: Conversation, files: boolean): PendingSignals | null {
    const board = this.boardNews(state, files), parent = this.parentWords(state), edits = this.editSignals(execution, state);
    const words = parent !== null && parent.line !== null && parent.text !== null ? { text: parent.text, line: parent.line, through: parent.through } : null;
    return board === null && words === null && edits === null ? null : { runId, board, words, edits };
  }
  /**
   * Tells the Harness of the Turn in progress what was pending: each part the Turn shows as its notice, and the conversation remembers as told (never back: a part
   * told already the other way stays told). `via`: with a tool's answer, or through the record's files (the Harness was seen reading them). Returns what each says.
   */
  private markSignals(execution: ActiveExecution, pending: PendingSignals, via: "tool" | "file"): string[] {
    const at = this.options.now().getTime(), during = via === "file" ? { during: true, via } : { during: true }, notes: string[] = [];
    // Whatever the file says of the Turn is told by now, or will be said again with it.
    if (via === "tool") execution.filed = null;
    const { board, words, edits } = pending;
    if (board !== null) {
      this.placed(execution, { kind: "notice", severity: "info", title: board.line, code: "TASK_BOARD_TOLD", at },
        [event("run.task_board_told", { runId: pending.runId, version: board.version, ...during })], { always: true, patch: current => ({ ...current, taskBoardTold: Math.max(current.taskBoardTold ?? 0, board.version) }) });
      notes.push(board.text);
    }
    if (words !== null) {
      this.placed(execution, { kind: "notice", severity: "info", title: words.line, code: "PARENT_WORDS_TOLD", at },
        [event("run.parent_words_told", { runId: pending.runId, through: words.through, ...during })], { always: true, patch: current => ({ ...current, parentWordsTold: Math.max(current.parentWordsTold ?? 0, words.through) }) });
      notes.push(words.text);
    }
    if (edits !== null) {
      const signaled = execution.signaled ??= new Map<string, number>();
      for (const [other, through] of Object.entries(edits.seen)) signaled.set(other, Math.max(signaled.get(other) ?? 0, through));
      this.placed(execution, { kind: "notice", severity: "info", title: edits.line, code: "TASK_EDITS_TOLD", at },
        [event("run.task_edits_told", { runId: pending.runId, told: edits.told, ...during })], { always: true, patch: current => {
          const told: Record<string, number> = { ...(current.taskEditsTold ?? {}) };
          for (const [other, through] of Object.entries(edits.told)) told[other] = Math.max(told[other] ?? 0, through);
          return { ...current, taskEditsTold: told };
        } });
      notes.push(edits.text);
    }
    return notes;
  }
  /**
   * What the STATE.md of `id` begins with (2026-11-14): what changed for its Turn in progress that its Harness, which reads the record as files, has not been told. For
   * a Harness that calls no tool of the Hub's the file is the channel: once the file that says it is in place (`written`) and the Harness is seen reading it, it is told
   * (recordRead). Null when nothing is pending, no Turn is in progress, or its Harness does not read the record as files. Reads only; never throws.
   */
  recordSignals(id: SessionId): { readonly text: string; written(): void } | null {
    try {
      const execution = this.actives.get(id);
      if (execution === undefined) return null;
      const place = this.recordPlace(id, execution.binding), state = this.load(id), run = runIn(state, execution.runId);
      if (place === null || run === undefined || run.status !== "running") return null;
      const pending = this.pendingSignals(execution, run.id, state, true);
      // A file that says nothing of the Turn tells nothing when it is read.
      if (pending === null) { execution.filed = null; return null; }
      const text = [pending.board?.text, pending.words?.text, pending.edits?.text].filter((note): note is string => note !== undefined)
        .map(note => asCommand(asFiles(note, place), execution.binding?.hubCommand)).join("\n\n");
      return { text, written: () => { if (this.actives.get(id) === execution) execution.filed = pending; } };
    } catch { return null; }
  }
  /**
   * A tool call of the Turn that reads the conversation's STATE.md or the task's board.md inside the record's directory (it names the file by its path or in its
   * command), once it completed, after the file said what changed for the Turn (recordSignals): what the file said is told now, as a tool's answer would have told it,
   * and is not said again. board.md holds the board alone, so reading it tells the board alone.
   */
  private recordRead(execution: ActiveExecution, value: Extract<ControlEvent, { type: "tool" }>): void {
    const place = this.recordPlace(execution.sessionId, execution.binding);
    if (place === null) return;
    // A call's later reports may not repeat what it reads: what its first one named is kept by its identity until it completes.
    const reads = execution.reads ??= new Map<string, "state" | "board">();
    const named = [value.title, value.detail?.input ?? "", ...(value.detail?.locations ?? [])].join("\n");
    if (named.includes(place.dir)) {
      // Its own STATE.md: named under its own directory, or by itself in a command run there (the task's directory is named by a label too, the first conversation's).
      const own = [...named.matchAll(/(?:(c-[0-9a-f]{6})\/)?STATE\.md/gu)].some(found => found[1] === place.self || (found[1] === undefined && named.includes(place.dir + "/" + place.self)));
      const read = own ? "state" : /board\.md/u.test(named) ? "board" : null;
      if (read !== null && reads.get(value.id) !== "state") reads.set(value.id, read);
    }
    const read = reads.get(value.id), filed = execution.filed;
    if (read === undefined || (value.status !== "completed" && value.status !== "failed")) return;
    reads.delete(value.id);
    if (value.status !== "completed" || filed === null || filed === undefined) return;
    const told: PendingSignals = read === "state" ? filed : { ...filed, words: null, edits: null };
    if (told.board === null && told.words === null && told.edits === null) return;
    execution.filed = read === "state" || (filed.words === null && filed.edits === null) ? null : { ...filed, board: null };
    this.markSignals(execution, told, "file");
    this.refreshRecord(execution.sessionId);
  }
  /**
   * What the other conversations of the task changed, since this Turn's Harness was last told, among the files this conversation has read or changed (its interest):
   * a file it never touched is not worth a word in the middle of its work, and is told with its next Turn. `told`: the conversations all of whose changes are said
   * here, which the next Turn then does not say again; `seen`: how far each one said is then told of within the Turn. Reads only.
   */
  private editSignals(execution: ActiveExecution, state: Conversation): PendingSignals["edits"] {
    const since = this.store.changedSince?.bind(this.store);
    if (since === undefined) return null;
    const prefix = state.configuration.workspace.endsWith("/") ? state.configuration.workspace : state.configuration.workspace + "/";
    const short = (path: string) => path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : path;
    // What this conversation has to do with: the files its Turns changed, and those this Turn has read or changed so far.
    const interest = new Set<string>();
    try { for (const path of this.store.changedFiles?.(state.id) ?? []) interest.add(short(path)); } catch { /* the Turn's own below */ }
    if (execution.turn !== null) for (const item of itemsOf(execution.turn)) {
      const fields = item.fields as { readonly type?: string; readonly path?: unknown; readonly changes?: readonly { readonly path?: unknown }[] };
      if (fields.type === "file_read" && typeof fields.path === "string") interest.add(short(fields.path));
      if (fields.type === "file_change") for (const change of fields.changes ?? []) if (typeof change.path === "string") interest.add(short(change.path));
    }
    if (interest.size === 0) return null;
    const signaled = execution.signaled ?? new Map<string, number>(), told: Record<string, number> = {}, seen: Record<string, number> = {}, lines: string[] = [];
    let count = 0;
    for (const other of this.taskOthers(state.id)) {
      try {
        const known = Math.max(state.taskEditsTold?.[other] ?? 0, signaled.get(other) ?? 0), found = since(other, known);
        if (found.through <= known || found.files.length === 0) continue;
        const files = [...new Set(found.files.map(short))], mine = files.filter(path => interest.has(path));
        if (mine.length === 0) continue;
        seen[other] = found.through;
        if (mine.length === files.length) told[other] = found.through;
        const harnessId = (this.load(other).runs.at(-1) ?? this.load(other)).selection.harnessId;
        lines.push("- " + (this.options.harnessName?.(harnessId) ?? harnessId) + "（对话 " + conversationLabel(other) + "）：" + mine.slice(0, 20).join("、") + (mine.length > 20 ? " 等 " + mine.length + " 个" : ""));
        count += mine.length;
      } catch { /* told with the next Turn */ }
    }
    if (lines.length === 0) return null;
    return { told, seen, line: "进行中带上了其他对话的改动（" + count + " 个文件）",
      text: "（HarnessHub：你这一轮进行中，这件任务里别的对话改了你读过或改过的文件。你手上的内容可能已经过时：再读或再改它们之前先看磁盘上的最新内容，需要知道它们为什么改，用 harnesshub 的 hub_read_turn 带上对话标签去读。\n" + lines.join("\n") + "\n）" };
  }
  /** A branch is taken only while nothing goes on: no Turn open or queued, no switch waiting. */
  private idleForBranch(state: Conversation): void {
    if (state.activeRunId !== null || state.pendingSwitchId !== null || state.runs.some(run => !terminal(run.status)) || this.workers.has(state.id))
      throw new SessionError("BRANCH_BUSY", "回合进行中不能切换分支或在旧位置重发：等这一轮结束或先停止它");
  }
  /** The conversation as a branch leaves it: every native session it held given up (they hold Turns the path no longer has), and a relay recovery failure cleared with them. */
  private branchedFrom(current: Conversation): Conversation {
    const { relayRecoveryFailed: _cleared, ...rest } = current;
    return { ...rest, nativeBindings: current.nativeBindings?.map(binding => binding.status === "archived" ? binding : { ...binding, status: "archived" as const }) ?? [] };
  }
  /** The installation's handoff log and preference of a Store that keeps them (FileConversationStore); none otherwise. */
  private relayLog(): Partial<RelayLogPort> | null {
    const store = this.store as Partial<RelayLogPort>;
    return typeof store.relayPrefs === "function" ? store : null;
  }
  private relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>> {
    try { return this.relayLog()?.relayPrefs?.() ?? {}; } catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") return {}; throw error; }
  }
  /** The relay's setting now: the stored preference with its default. */
  private settings(): RelaySettings { return relaySettings(this.relayPrefs()); }
  /**
   * What the binding's Driver adds to the system prompt of the native session it opens (HarnessControl.setSessionInstructions): how to
   * use the task list and the wrap-up, when its process has the Hub's tools and the user leaves `hub.progress` on; nothing otherwise.
   */
  private sessionInstructions(binding: PreparedSessionBinding | null, id: SessionId): string | null {
    if (binding?.hubTools !== true) return null;
    // A Harness whose tools are a command is told the command either way: nothing else would say it is there.
    if (binding.hubCommand !== undefined) return hubCommandInstructions(binding.hubCommand, this.settings().progress === "on");
    // A Harness that reads the record as files is told where the directory is in place of the reading tools.
    const place = this.recordPlace(id, binding), rest = place === null ? HUB_DELEGATION_INSTRUCTIONS : hubRecordInstructions(place.dir, place.self);
    return this.settings().progress === "on" ? HUB_PROGRESS_INSTRUCTIONS + "\n" + rest : rest;
  }
  /**
   * Whether the Harness of the Turn `target` compacted its own session in the Turn before (2026-11-13): that Turn was its own too, and it told of a compaction (a
   * compaction among its activities, or the command that asks for one), or — for a Harness that tells of none — its context was less than half as full at the end of
   * that Turn as at the end of the one before. What it holds of the task after that the Hub cannot see, so the state is said again.
   */
  private compactedBefore(state: Conversation, target: RunId): boolean {
    const at = state.runs.findIndex(run => run.id === target), run = state.runs[at], prev = at > 0 ? state.runs[at - 1] : undefined;
    const same = (other: ConversationRun | undefined): other is ConversationRun => other !== undefined && run !== undefined && other.selection.harnessId === run.selection.harnessId && other.selection.controlId === run.selection.controlId;
    if (!same(prev)) return false;
    if ((prev as { readonly commandEffect?: unknown }).commandEffect === "compact") return true;
    try { if (turnSource(this.store, state.id).turn(at - 1)?.run.activities?.some(activity => activity.kind === "compaction") === true) return true; } catch { /* told by the usage below, if at all */ }
    const earlier = at > 1 ? state.runs[at - 2] : undefined, used = (row: ConversationRun) => row.usage?.context?.used;
    // Two Turns of one native session only: a new one (after a clear, or one the Hub opened in the place of a full one) starts small without having compacted anything.
    if (!same(earlier) || prev.relay?.executedOn?.nativeEpoch !== earlier.relay?.executedOn?.nativeEpoch) return false;
    const now = used(prev), before = used(earlier);
    return typeof now === "number" && typeof before === "number" && before > 0 && now < 0.5 * before;
  }
  /**
   * Whether a new native session may take the place of `binding`'s for the Turn `run`: it holds something, and the new one would be handed the conversation. Never for
   * an input that may be a command (it is meant for the session as it is: `/compact`, `/clear`), nor where the new session would be handed nothing (the user sends
   * this input alone, the installation hands nothing over by itself, the relay's record could not be recovered).
   */
  private mayReseat(state: Conversation, run: ConversationRun, binding: NativeSessionBinding, typed: string): boolean {
    return binding.relay !== undefined && binding.opensNew !== true && binding.throughRunId !== null && binding.status === "ready"
      && !typed.trimStart().startsWith("/") && state.relayRecoveryFailed === undefined && this.settings().attach !== "off" && this.choicesOf(state, run).attach !== "none";
  }
  /**
   * Why the Hub opens a new native session for the Turn `run` before it resumes `binding`'s (Reseat), if it does: the last Turn dispatched into it failed because the
   * conversation is over the model's window, or — where an operator set a level — it ended with that share of its window used. A session that was opened with the
   * conversation and overflowed in its first Turn is followed by one handed less (overflowShrink, 2026-11-14); one whose first Turn carried nothing and still
   * overflowed has nothing a new one could be handed less of, and is left to its Harness and to the user, so that it cannot loop. Nor for a session opened with the
   * conversation that was as full as the level after its first Turn: another one would be handed the same and be no better off.
   */
  private reseatCause(state: Conversation, run: ConversationRun, binding: NativeSessionBinding, typed: string): Reseat | null {
    if (!this.mayReseat(state, run, binding, typed)) return null;
    const relay = binding.relay!, last = state.runs.find(row => row.id === binding.throughRunId);
    const first = state.runs.find(row => row.relay?.executedOn?.harnessId === binding.harnessId && row.relay.executedOn.controlId === binding.controlId && row.relay.executedOn.nativeEpoch === relay.epoch);
    const carried = first?.relay?.continuity.kind === "rehydrate";
    if (last?.status === "failed" && OVERFLOW_CODES.has(last.error?.code ?? "")) return first === last && !carried ? null : { reason: "overflow", shrink: this.overflowShrink(state, binding) };
    const at = this.reseatAt();
    if (at === null) return null;
    const full = (row: ConversationRun | undefined): { readonly used: number; readonly size: number } | null => {
      const context = row?.usage?.context;
      return context === undefined || typeof context.size !== "number" || context.size <= 0 || context.used < at * context.size ? null : { used: context.used, size: context.size };
    };
    const now = full(last);
    return now === null || carried && full(first) !== null ? null : { reason: "full", ...now };
  }
  /**
   * How much less than a handoff's cap the session that follows an overflow is handed (2026-11-14): for each of the latest Turns on this Harness control, one after the
   * other, that were handed the conversation and failed over the model's window, the cap is scaled by `size / used` where that Turn reported more used than the window
   * holds, and halved where it reported nothing to go by. 1 when the Turn that overflowed was not handed the conversation (it overflowed in a session that grew).
   * Read from the record alone: nothing new is kept for it.
   */
  private overflowShrink(state: Conversation, binding: NativeSessionBinding): number {
    let shrink = 1;
    for (let at = state.runs.length - 1; at >= 0; at--) {
      const row = state.runs[at]!;
      if (row.selection.harnessId !== binding.harnessId || row.selection.controlId !== binding.controlId || !terminal(row.status)) continue;
      if (row.status !== "failed" || !OVERFLOW_CODES.has(row.error?.code ?? "") || row.relay?.continuity.kind !== "rehydrate") break;
      const context = row.usage?.context;
      shrink *= context !== undefined && typeof context.size === "number" && context.size > 0 && context.used > context.size ? context.size / context.used : 0.5;
    }
    return shrink;
  }
  /** Where the Harness of a binding reads the record as files: when it does (recordFiles) and the Hub keeps the directory; null otherwise. */
  private recordPlace(id: SessionId, binding: PreparedSessionBinding | null | undefined): { readonly dir: string; readonly self: string } | null {
    if (binding?.recordFiles !== true || this.options.context === undefined) return null;
    try { return this.options.context.place(id); } catch { return null; }
  }

  switch(id: SessionId, selection: SelectionRequest, key: string): SwitchReceipt {
    return this.requestSwitch(id, selection, key, false, false);
  }
  /** Explicit recovery checks durable closure, then validates a fresh target without replaying any Run. */
  resume(id: SessionId, selection: SelectionRequest, key: string, acknowledgeUnknown = false): SwitchReceipt {
    return this.requestSwitch(id, selection, key, true, acknowledgeUnknown);
  }
  private requestSwitch(id: SessionId, selection: SelectionRequest, key: string, recovery: boolean, acknowledgeUnknown: boolean): SwitchReceipt {
    this.admit(); const request = requested(selection), command = commandId(key), fingerprint = this.fingerprint({ kind: "switch", selection: request,
      ...(recovery ? { recovery: true, acknowledgeUnknown } : {}) });
    const state = this.load(id), prior = replayCommand(state, command, "switch", fingerprint);
    if (prior) return { sessionId: id, switchId: switchId(prior.resultId), replayed: true };
    if (recovery) this.recoverable(state, acknowledgeUnknown); else this.open(state);
    if (state.pendingSwitchId !== null) throw new SessionError("SWITCH_PENDING", "one switch request is already pending");
    const nextId = switchId("switch-" + this.options.id());
    this.commit(id, current => ({ next: { ...(recovery ? this.cancelPending(current) : current), pendingSwitchId: nextId,
      switches: [...current.switches, { id: nextId, commandId: command, requested: request, requestedSeq: current.lastSeq + 1, target: null,
        status: "requested", throughSeq: 0, sourceRunIds: current.runs.filter(run => terminal(run.status) || run.id === current.activeRunId).map(run => run.id), error: null }],
      commands: [...current.commands, { id: command, kind: "switch", fingerprint, resultId: nextId }] },
      events: [event("switch.requested", { switchId: nextId, requested: request, mode: "wait_current", ...(recovery ? { recovery: true, acknowledgeUnknown,
        cancelledRunIds: current.runs.filter(run => run.status === "queued").map(run => run.id) } : {}) })] }));
    this.schedule(id); return { sessionId: id, switchId: nextId, replayed: false };
  }

  /**
   * The user's stop of a Turn (the active one unless `target` names another), recorded as a command with run.cancel_requested.
   * A queued Turn is cancelled before it starts and a running one is stopped through the stop chain; one whose program has
   * already settled is not changed: its close goes on and it ends as the program reported. Idempotent per `key`.
   */
  cancel(id: SessionId, key: string, target?: string): CancelReceipt {
    this.admit(); return this.cancelInternal(id, commandId(key), target === undefined ? undefined : runId(target));
  }
  /** The conversation in the shape the readers that have not moved to items read it in (the store's adapter over the rows, ADR-057 3.3). */
  /**
   * What each of the conversation's native bindings asks the user to look at now (the read behind the `attention` of `GET …/relay`):
   * worked out from the state the conversation is in at this moment — whether a packet was sent and nothing confirmed it, and whether
   * the conversation was cleared and its earlier part can still be attached to the next message — and not from what its latest Turn
   * happened to decide, so a banner stays while its cause does and goes when it ends. Read-only; a binding that needs nothing has
   * `attention` null. Never a block: the next input goes whatever this says.
   */
  relayAttention(id: SessionId): readonly { readonly harnessId: string; readonly controlId: string; readonly attention: RelayAttention | null }[] {
    const state = this.load(id), originHistory = this.quotedHistory(state);
    const originTurns = Math.max(1, !originHistory ? 0 : (this.store.originHistory?.(id) ?? []).filter(row => row.message.role === "user").length);
    return (state.nativeBindings ?? []).filter(binding => binding.status !== "archived" && binding.relay !== undefined).map(binding => {
      const relay = binding.relay!, h = binding.harnessId, c = binding.controlId;
      const facts = this.relayFacts(state, { harnessId: h, controlId: c, nativeEpoch: relay.epoch });
      const count = (need: ReturnType<typeof owed>) => need.facts.length + (need.origin ? originTurns : 0);
      const owedRuns = count(owed(relay, h, c, facts, { originHistory }));
      // A cleared conversation whose new native session has run nothing yet: its earlier part can be attached to the next message.
      const ran = state.runs.some(run => dispatched(run) && run.relay?.executedOn?.harnessId === h && run.relay.executedOn.controlId === c && run.relay.executedOn.nativeEpoch === relay.epoch);
      const attachableRuns = relay.floor >= 1 && relay.pending === null && !ran ? count(owed(relay, h, c, facts, { originHistory, lower: -1 })) : 0;
      return { harnessId: h, controlId: c, attention: attentionOf({ relay, owedRuns, attachableRuns }) };
    });
  }
  /**
   * What the installation as a whole cannot do for the relay while it stays so: the relay key file unusable, so that no packet can
   * be keyed and every handoff goes as the words alone, which no single conversation's attention says. Empty when nothing is wrong.
   * Read-only.
   */
  relayInstallation(): readonly RelayInstallationNotice[] {
    const problem = this.relayKeys.unusable;
    return problem === undefined || problem === null ? [] : [{ cause: "key_unavailable", detail: problem.slice(0, 200) }];
  }
  resetNative(id: SessionId, key: string, epoch: number): Conversation {
    this.admit(); const state = this.load(id), command = commandId(key);
    const fingerprint = this.fingerprint({ kind: "native-reset", epoch });
    if (replayCommand(state, command, "native-reset", fingerprint)) return this.load(id);
    if (state.status === "closed" || state.activeRunId !== null || state.pendingSwitchId !== null || state.runs.some(run => !terminal(run.status))) throw new SessionError("NATIVE_SESSION_BUSY", "native state can be branched only while idle");
    if (epoch !== state.epoch || state.selection.provider !== undefined) throw new SessionError("NATIVE_SELECTION_CONFLICT", "the selected native Harness changed");
    if (state.runs.some(run => run.status === "unknown" && run.cleanup?.closed !== true)) throw new SessionError("RECOVERY_CLEANUP_REQUIRED", "native resources must be confirmed before branching");
    // A native reset also clears a relay recovery failure: the next native session starts its relay afresh (ADR-055 §9 S15).
    const committed = this.commit(id, ({ relayRecoveryFailed, ...current }) => ({ next: { ...current,
      nativeBindings: current.nativeBindings?.map(binding => binding.harnessId === current.selection.harnessId && binding.controlId === current.selection.controlId && binding.status !== "archived" ? { ...binding, status: "archived" as const } : binding) ?? [],
      commands: [...current.commands, { id: command, kind: "native-reset", fingerprint, resultId: id }],
    }, events: [event("native.branch_requested", { harnessId: current.selection.harnessId, controlId: current.selection.controlId, historyPreserved: true, previousBindingPreserved: true })] }));
    // The kept process runs the archived native session; it is closed before the next Turn opens a new one (ADR-030).
    if (this.kept.has(id)) void this.requestRelease(id, "native_reset");
    return this.load(committed.conversation.id);
  }
  /**
   * Branches a Session after a finished Run. The branch quotes the public history through that Run and starts with the
   * same selection. When the source's native session is exactly at that Run, the branch gets a native fork of it (made
   * before the branch's first input); otherwise the branch continues from public history. Nothing is sent to a model.
   */
  fork(sourceId: SessionId, key: string, throughRunId?: string): Conversation {
    this.admit();
    const loaded = this.load(sourceId), command = commandId(key);
    if (throughRunId !== undefined && (typeof throughRunId !== "string" || !/^run-[A-Za-z0-9-]{1,128}$/u.test(throughRunId))) throw new SessionError("INVALID_INPUT", "invalid branch point");
    const through = throughRunId === undefined ? [...loaded.runs].reverse().find(run => terminal(run.status)) : loaded.runs.find(run => run.id === throughRunId);
    const fingerprint = this.fingerprint({ kind: "fork", source: sourceId, through: through?.id ?? null });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return this.load(prior.id); }
    if (!through || !terminal(through.status)) throw new SessionError("FORK_UNAVAILABLE", "a branch starts after a finished reply");
    if (loaded.activeRunId !== null || loaded.pendingSwitchId !== null) throw new SessionError("NATIVE_SESSION_BUSY", "wait for the current reply or switch to finish before branching");
    // The branch quotes the public history through that Run: its words are read from the rows, a Turn at a time.
    const last = loaded.runs.findIndex(run => run.id === through.id), history = this.quotedThrough(sourceId, loaded, last);
    const native = loaded.selection.provider === undefined ? loaded.nativeBindings?.find(binding => binding.harnessId === loaded.selection.harnessId && binding.controlId === loaded.selection.controlId && binding.status === "ready") : undefined;
    // The native session is exactly at `through` only when no later Turn was dispatched to it, `through` ran in its current
    // native epoch, and the binding is synced with nothing owed up to `through` (ADR-055 §7.5): its native position follows
    // dispatch, so these say that the native session holds the conversation through `through` and nothing else.
    const nativeFork = native !== undefined && native.throughRunId === through.id && !loaded.runs.slice(last + 1).some(run =>
      run.selection.provider === undefined && run.selection.harnessId === native.harnessId && run.selection.controlId === native.controlId && dispatched(run)) && this.exactAt(loaded, native, through);
    const id = sessionId("session-" + this.options.id());
    const parts = originToRows(id, { kind: "fork", sessionId: sourceId, throughRunId: through.id, history }, last);
    const state: Conversation = { id, version: 0, lastSeq: 0, format: CONVERSATION_FORMAT, epoch: 1, status: "open", configuration: loaded.configuration, selection: loaded.selection,
      activeRunId: null, pendingSwitchId: null, runs: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      origin: parts.stored, ...sharedWorktree(loaded),
      ...(nativeFork ? { nativeBindings: [{ harnessId: native.harnessId, controlId: native.controlId, checkpoint: native.checkpoint, throughRunId: null, status: "fork-pending" as const,
        relay: initialBindingRelay([], native.harnessId, native.controlId, "fork") }] } : {}) };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: state.selection, continuity: nativeFork ? "native_fork" : "public_context_rehydrate", origin: { sessionId: sourceId, throughRunId: through.id, messages: history.length, nativeFork } })], parts.rows);
      this.managedSessions.add(id); this.publish(committed);
      // The source's kept process holds the native session the branch forks; it is closed first (ADR-030).
      if (this.kept.has(sourceId)) void this.requestRelease(sourceId, "branched");
      if (nativeFork) this.schedule(id);
      return this.load(id);
    } catch (error) { if (storeUntrusted(error)) this.fail(error, id); throw error; }
  }
  /**
   * Hands a part of a conversation's work to a Harness of its own (2026-11-13): a new conversation in the same workspace with that Harness, marked as delegated by
   * the source, which quotes the source's public history through its latest finished Turn (nothing when it has none). Nothing is sent to a model here: the task is the
   * new conversation's first message. The source may be in the middle of a Turn; it is only read.
   */
  async delegate(sourceId: SessionId, selection: SelectionRequest, key: string, from?: { readonly harnessId: string; readonly controlId: string }): Promise<Conversation> {
    this.admit();
    const loaded = this.load(sourceId), request = requested(selection), command = commandId(key);
    // Asked for by the Harness of the Turn in progress (the Hub's tool): only that Harness, only while its Turn runs; the work is handed over in that Turn.
    const asking = from === undefined ? undefined : this.runningFor(sourceId, from);
    // A chain of delegations ends somewhere: work handed on three times is not handed on again.
    let depth = 0;
    for (let at: Conversation | undefined = loaded; at?.delegation !== undefined && depth < 8; depth++) { try { at = this.load(at.delegation.parentId); } catch { at = undefined; } }
    if (depth >= 3) throw new SessionError("DELEGATION_TOO_DEEP", "这项工作已经被转交了三层，不再往下委派");
    const through = [...loaded.runs].reverse().find(run => terminal(run.status));
    const fingerprint = this.fingerprint({ kind: "delegate", source: sourceId, through: through?.id ?? null, selection: request });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return this.load(prior.id); }
    const validated = await this.factory.validate(request, loaded.configuration);
    this.admit();
    // Validation has an await boundary; the same command may have been committed in the meantime.
    const concurrent = this.store.findByCreateKey(command);
    if (concurrent) { replayCommand(concurrent, command, "create", fingerprint); return this.load(concurrent.id); }
    const id = sessionId("session-" + this.options.id());
    const last = through === undefined ? -1 : loaded.runs.findIndex(run => run.id === through.id);
    const history = through === undefined ? [] : this.quotedThrough(sourceId, loaded, last);
    const parts = through === undefined ? null : originToRows(id, { kind: "fork", sessionId: sourceId, throughRunId: through.id, history }, last);
    const state: Conversation = { id, version: 0, lastSeq: 0, format: CONVERSATION_FORMAT, epoch: 1, status: "open", configuration: loaded.configuration, selection: validated,
      activeRunId: null, pendingSwitchId: null, runs: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      ...(parts === null ? {} : { origin: parts.stored }), ...sharedWorktree(loaded), delegation: asking === undefined ? { parentId: sourceId, afterRunId: through?.id ?? null } : { parentId: sourceId, afterRunId: asking, by: "harness" } };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "public_context_rehydrate",
        ...(through === undefined ? {} : { origin: { sessionId: sourceId, throughRunId: through.id, messages: history.length, nativeFork: false } }) })], parts?.rows);
      this.managedSessions.add(id); this.publish(committed);
      return this.load(id);
    } catch (error) { if (storeUntrusted(error)) this.fail(error, id); throw error; }
  }
  /** The conversation a task began in: up the chain of delegations from `id` (a chain is short; the bound is against a ring). */
  private taskRoot(id: SessionId): SessionId {
    let root = id;
    for (let hops = 0; hops < 16; hops++) { let parent: SessionId | undefined; try { parent = this.load(root).delegation?.parentId; } catch { parent = undefined; } if (parent === undefined) break; root = parent; }
    return root;
  }
  /**
   * The conversation a task's board is kept on: the highest of the chain that is still there. Where the task began may have been erased (2026-11-14), and its board with it:
   * what it delegated then keeps a board of its own.
   */
  private boardRoot(id: SessionId): SessionId {
    let root = id;
    for (let hops = 0; hops < 16; hops++) {
      let parent: SessionId | undefined; try { parent = this.load(root).delegation?.parentId; } catch { parent = undefined; }
      if (parent === undefined) break;
      try { this.load(parent); } catch { break; }
      root = parent;
    }
    return root;
  }
  /** The board of the task a conversation belongs to (session.ts TaskBoard): empty until something is written on it. */
  taskBoard(id: SessionId): TaskBoard {
    this.admit();
    return this.load(this.boardRoot(id)).taskBoard ?? { version: 0, entries: [] };
  }
  /**
   * Writes on the task's board, or takes an entry off it (`forget`). `by`: a Harness's id when its tool wrote it — only the Harness of the conversation's Turn in
   * progress may — or `user` from the page. A goal replaces the goal; every entry is kept, whole, until someone takes it off. Returns the board as it is then.
   */
  writeBoard(id: SessionId, by: { readonly harnessId: string; readonly controlId: string } | "user", change: { readonly kind: BoardKind; readonly text: string } | { readonly forget: string }): TaskBoard {
    this.admit();
    // A Harness writes in its Turn in progress: the entry names that Turn, whose user's words it is the Harness's reading of (2026-11-14).
    const running = by === "user" ? null : this.runningFor(id, by);
    const from: BoardEntry["from"] = running === null ? undefined : { sessionId: id, runId: running, ordinal: this.load(id).runs.findIndex(run => run.id === running) };
    const root = this.boardRoot(id), author = by === "user" ? "user" : by.harnessId, at = this.options.now().getTime();
    let made: TaskBoard = { version: 0, entries: [] };
    this.commit(root, current => {
      const board = current.taskBoard ?? { version: 0, entries: [] };
      let entries: readonly BoardEntry[];
      if ("forget" in change) { if (!board.entries.some(entry => entry.id === change.forget)) throw new SessionError("INVALID_INPUT", "任务板上没有这一条"); entries = board.entries.filter(entry => entry.id !== change.forget); }
      else {
        const text = change.text.replace(/\s+/gu, " ").trim();
        if (text === "") throw new SessionError("INVALID_INPUT", "要记下的内容不能为空");
        const entry: BoardEntry = { id: "b" + (board.version + 1), kind: change.kind, text, by: author, at, ...(from === undefined ? {} : { from }) };
        // Said again in the same words, it stays one entry; a new goal takes the old one's place.
        entries = [...board.entries.filter(item => !(item.kind === entry.kind && (item.text === entry.text || entry.kind === "goal"))), entry];
      }
      made = { version: board.version + 1, entries };
      // The Harness that wrote it knows it: where it had read the board as it was, its conversation stands as told.
      const knows = by !== "user" && root === id && (current.taskBoardTold ?? 0) >= board.version;
      return { next: { ...current, taskBoard: made, ...(knows ? { taskBoardTold: made.version } : {}) }, events: [event("task.board_changed", { version: made.version, by: author, from: id, ...("forget" in change ? { forgot: change.forget } : { kind: change.kind }) })] };
    });
    if (by !== "user" && root !== id && (this.load(id).taskBoardTold ?? 0) >= made.version - 1)
      this.commit(id, current => ({ next: { ...current, taskBoardTold: made.version }, events: [event("run.task_board_told", { version: made.version, wrote: true })] }));
    // The task's board.md and every STATE.md say the board as it is now; the Turns in progress whose Harness reads them are told the change there.
    this.refreshRecord(id);
    return made;
  }
  /**
   * The task's board as the Harness of `state` reads it before the user's words, when it has changed since that Harness was last told (2026-11-13); null when there is
   * nothing new. `version` is what the conversation then remembers as told. `files`: its Harness reads the record as files (an entry's source is named by its path).
   */
  private boardNews(state: Conversation, files: boolean): { readonly text: string; readonly line: string; readonly version: number } | null {
    let board: TaskBoard | undefined;
    try { board = this.load(this.boardRoot(state.id)).taskBoard; } catch { board = undefined; }
    const told = state.taskBoardTold ?? 0;
    // An empty board is told only to a Harness that was given entries before: that they are withdrawn.
    if (board === undefined || board.version <= told || (board.entries.length === 0 && told === 0)) return null;
    return { version: board.version, line: board.entries.length === 0 ? "任务板已清空，告知了这一点" : "带上了任务板（" + board.entries.length + " 条）", text: boardText(board, harnessId => this.options.harnessName?.(harnessId) ?? harnessId, files) };
  }
  /**
   * What a handoff to the Harness of `run` would give the user's earlier words (the `user` share of packetBudget, in estimated tokens): the state said where no packet
   * goes carries the user's words of the conversation by the same rule (2026-11-14). `channel`: the bound of the channel the state goes in, with the Turn's input
   * (null: with a tool's answer, which the input's channel does not bound).
   */
  private wordsBudget(state: Conversation, run: ConversationRun, channel: { readonly limit: number; readonly size: number } | null): number {
    try {
      const resolved = resolveWindow(state, run, this.windows.get(windowKey(run.selection)) ?? null);
      let typed = "";
      try { typed = turnSource(this.store, state.id).turn(state.runs.findIndex(row => row.id === run.id))?.user.text ?? ""; } catch { typed = ""; }
      return packetBudget(resolved, hardCap(resolved, estimateTokens(typed), channel === null ? null : { limit: channel.limit }, channel?.size ?? [...typed].length)).user;
    } catch { return 0; }
  }
  /**
   * Writes again what changes of the record's directory in the middle of a Turn (ContextFiles.refresh): fire and forget, and the Runtime's close waits for it
   * (recordWork); once it closes nothing more is written.
   */
  private refreshRecord(id: SessionId): void {
    const context = this.options.context;
    if (context?.refresh === undefined || !this.accepting) return;
    let work: Promise<void>;
    try { work = context.refresh(id).catch(() => undefined); } catch { return; }
    this.recordWork.add(work);
    void work.finally(() => this.recordWork.delete(work));
  }
  /** The conversations of the task `id` belongs to, other than itself and those it delegated work to itself (what those come to reaches it with their outcome). */
  private taskOthers(id: SessionId): readonly SessionId[] {
    const own = new Set<SessionId>(this.store.delegatedBy?.(id) ?? []), found: SessionId[] = [], seen = new Set<SessionId>();
    const visit = (at: SessionId): void => {
      if (seen.has(at) || found.length >= 64) return;
      seen.add(at);
      if (at !== id && !own.has(at)) found.push(at);
      for (const child of this.store.delegatedBy?.(at) ?? []) visit(child);
    };
    visit(this.taskRoot(id));
    return found;
  }
  /**
   * What the other conversations of the task changed since this conversation's Harness was last told (2026-11-13): files it may be about to read or change itself.
   * `told` is how far each of them stands now, which the conversation remembers; `text` and `line` are null when there is only that to remember (the first Turn of a
   * conversation starts from the task as it is, and is told nothing of what was changed before it).
   */
  private editNews(state: Conversation): { readonly told: Readonly<Record<string, number>>; readonly text: string | null; readonly line: string | null } | null {
    const since = this.store.changedSince?.bind(this.store);
    if (since === undefined) return null;
    const first = state.runs.length <= 1, told: Record<string, number> = {}, lines: string[] = [];
    let count = 0;
    for (const other of this.taskOthers(state.id)) {
      try {
        const known = state.taskEditsTold?.[other], found = since(other, known ?? 0);
        if (found.through === known) continue;
        told[other] = found.through;
        if ((first && known === undefined) || found.files.length === 0) continue;
        const harnessId = (this.load(other).runs.at(-1) ?? this.load(other)).selection.harnessId, shown = found.files.slice(0, 20);
        lines.push("- " + (this.options.harnessName?.(harnessId) ?? harnessId) + "（对话 c-" + other.replace(/^session-/u, "").replace(/-/gu, "").slice(0, 6) + "）：" + shown.join("、") + (found.files.length > shown.length ? " 等 " + found.files.length + " 个" : ""));
        count += found.files.length;
      } catch { /* a conversation that cannot be read now is told of another time */ }
    }
    if (Object.keys(told).length === 0) return null;
    if (lines.length === 0) return { told, text: null, line: null };
    return { told, line: "带上了其他对话的改动（" + count + " 个文件）",
      text: "（HarnessHub：这件任务里别的对话在你上一轮之后改了下面这些文件。你手上的内容可能已经过时：读或改它们之前先看磁盘上的最新内容，需要知道它们为什么改，用 harnesshub 的 hub_read_turn 带上对话标签去读。\n" + lines.join("\n") + "\n）" };
  }
  /**
   * What the user said in the conversation that delegated this one its work, since this one's Harness last had it (2026-11-13): the Hub carries it, so that a
   * requirement the user adds there reaches work already handed over whether or not a Harness wrote it on the board. The first Turn's history covers the Turns through
   * the one the delegation followed (a Turn still going on then is not in it: its words are told here). `through` is how many of those Turns are then told.
   */
  private parentWords(state: Conversation): { readonly through: number; readonly text: string | null; readonly line: string | null } | null {
    const origin = state.delegation;
    if (origin === undefined) return null;
    try {
      const parent = this.load(origin.parentId), at = parent.runs.findIndex(run => run.id === origin.afterRunId);
      // A Harness delegates within its Turn in progress, which the history does not hold; the user's delegation follows a finished one.
      const known = state.parentWordsTold ?? (at < 0 ? parent.runs.length : origin.by === "harness" ? at : at + 1);
      if (parent.runs.length <= known) return null;
      const turns = turnSource(this.store, origin.parentId), said: string[] = [];
      for (let ordinal = known; ordinal < parent.runs.length; ordinal++) {
        const words = (turns.turn(ordinal)?.user.text ?? "").trim(), units = [...words];
        if (words !== "") said.push("- 第 " + (ordinal + 1) + " 轮：" + (units.length > 600 ? units.slice(0, 600).join("") + "…（后面省略）" : words).replace(/\n+/gu, "\n  "));
      }
      if (said.length === 0) return { through: parent.runs.length, text: null, line: null };
      const shown = said.slice(-6), label = "c-" + origin.parentId.replace(/^session-/u, "").replace(/-/gu, "").slice(0, 6);
      return { through: parent.runs.length, line: "带上了原对话里用户后来说的话（" + said.length + " 条）",
        text: "（HarnessHub：把这件事交给你的那段对话（" + label + "）里，用户在你上次看到之后又说了下面的话。它们是对那段对话说的，不是给你的新任务；其中对整件任务都有效的要求（约定、限制、改了主意）你同样要照做。"
          + (said.length > shown.length ? "更早的 " + (said.length - shown.length) + " 条用 harnesshub 的 hub_turns 带上这个对话标签去读。" : "") + "\n" + shown.join("\n") + "\n）" };
    } catch { return null; }
  }
  /** The Turn in progress of a conversation, when it is `from`'s: what the Hub's tools act within. */
  private runningFor(id: SessionId, from: { readonly harnessId: string; readonly controlId: string }): RunId {
    const execution = this.actives.get(id);
    if (execution === undefined) throw new SessionError("NO_TURN_IN_PROGRESS", "这个对话现在没有进行中的回合");
    const run = runIn(this.owned(execution), execution.runId);
    if (run === undefined || run.status !== "running") throw new SessionError("NO_TURN_IN_PROGRESS", "这个对话现在没有进行中的回合");
    if (run.selection.harnessId !== from.harnessId || run.selection.controlId !== from.controlId) throw new SessionError("NOT_THIS_TURN", "进行中的回合不是这个 Harness 在跑");
    return run.id;
  }
  /** How each piece of work this conversation delegated stands, oldest first: who has it, the task, its latest Turn's state and what it said. */
  private delegationStates(id: SessionId): DelegationState[] {
    const states: DelegationState[] = [];
    for (const childId of this.store.delegatedBy?.(id) ?? []) {
      try {
        const child = this.load(childId), last = child.runs.at(-1), turns = turnSource(this.store, childId);
        const harnessId = (last ?? child).selection.harnessId, harness = this.options.harnessName?.(harnessId) ?? harnessId;
        const task = (turns.turn(0)?.user.text ?? "").trim();
        let files: readonly string[] = [];
        try { files = this.store.changedFiles?.(childId) ?? []; } catch { files = []; }
        if (last === undefined || !terminal(last.status)) { states.push({ sessionId: childId, harnessId, harness, task, runId: last?.id ?? null, status: "running", reply: "", files }); continue; }
        const turn = turns.turn(child.runs.length - 1);
        states.push({ sessionId: childId, harnessId, harness, task, runId: last.id, status: last.status === "completed" || last.status === "failed" || last.status === "cancelled" ? last.status : "unknown", reply: turn?.assistant?.text.trim() ?? "", files });
      } catch { /* a conversation that cannot be read now is left out of this reading */ }
    }
    return states;
  }
  /** Whether an outcome was told: with a Turn of this conversation that went through, or still runs. */
  private wasTold(state: Conversation, entry: DelegationState): boolean {
    const prior = state.delegationsTold?.[entry.sessionId], by = prior === undefined ? undefined : state.runs.find(run => run.id === prior.by);
    return prior !== undefined && prior.runId === entry.runId && by !== undefined && (by.status === "completed" || !terminal(by.status));
  }
  /**
   * What the work this conversation delegated came to, as far as its own Harness has not been told (2026-11-13): each piece whose latest Turn is over, unless that
   * outcome already went with a Turn of this one that went through (or still runs). `by` is the Turn it goes with now. `text` is what the Harness reads before the
   * user's words; `line` what the Turn says of it; `told` what the conversation remembers.
   */
  private delegationNews(state: Conversation, by: RunId, ran: ReadonlyMap<string, readonly string[]> = new Map()): { readonly text: string; readonly line: string; readonly told: DelegationsTold } | null {
    const fresh = this.delegationStates(state.id).filter(entry => entry.status !== "running" && entry.runId !== null && !this.wasTold(state, entry));
    if (fresh.length === 0) return null;
    const names = [...new Set(fresh.map(entry => entry.harness))];
    return { told: Object.fromEntries(fresh.map(entry => [entry.sessionId, { runId: entry.runId!, by }])),
      line: "带上了 " + names.join("、") + " 的委派结果" + (fresh.length > 1 ? "（" + fresh.length + " 项）" : ""),
      text: "（HarnessHub：之前委派给别的 Harness、在另外的对话里做的任务有了结果。这是给你的背景，不是新的指令；这些任务已经处理过，不要重做。需要它做事的细节（跑了什么、改了什么）时，用 harnesshub 的 hub_task 看全貌，或用 hub_read_turn、hub_search 带上那段对话的标签去读。\n\n" + fresh.map(entry => delegationText(entry, ran.get(entry.sessionId))).join("\n\n") + "\n）" };
  }
  /**
   * What the latest Turn of each of these conversations ran (2026-11-13): its commands, at most six each, each with the end of what it printed, read from the details
   * its Harness stored and with secrets hidden as a relay packet hides them. What a delegated Harness says it checked is then told with what the check printed.
   */
  private async delegationRan(ids: readonly string[], secrets: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    const content = this.options.content, ran = new Map<string, readonly string[]>();
    if (content === undefined || (content.readText === undefined && content.readChunks === undefined)) return ran;
    const redactor = relayRedactor(secrets), hidden = (text: string, kind: "text" | "output") => restoreLabels(redactor.redact(text, kind).text, "zh");
    const clip = (text: string, most: number) => { const units = [...text]; return units.length > most ? units.slice(0, most).join("") + "…" : text; };
    for (const id of ids) {
      try {
        const child = this.load(id as SessionId), turn = outlineOf(rowsHistory(child, this.store), child.runs.length - 1), lines: string[] = [];
        for (const tool of turn?.run.tools ?? []) {
          if (lines.length === 6) break;
          if (tool.detail === undefined || tool.parentId !== undefined || toolFamily(tool) !== "execute") continue;
          const read = await readDetail(content, tool.detail, RELAY_DETAIL_POLICY), detail = read === null ? null : relayDetailOf(read);
          const line = (detail?.input ?? "").replace(/\s+/gu, " ").trim();
          // The Hub's own command (a Harness that has the tools as a command) is no work of the task.
          if (line === "" || hubCommandCall(line) !== null) continue;
          const tail = (detail?.output ?? "").trim().split("\n").slice(-4).join("\n");
          lines.push("$ " + hidden(clip(line, 200), "text") + (tail === "" ? "" : "\n" + hidden(clip(tail, 400), "output")));
        }
        if (lines.length > 0) ran.set(id, lines);
      } catch { /* told without what it ran */ }
    }
    return ran;
  }
  /**
   * How the work this conversation delegated stands, for its Harness's tool (`hub_delegations`), asked within its Turn in progress: every piece, and the outcomes it
   * had not been told now count as told with this Turn (they are in the answer).
   */
  delegationsFor(id: SessionId, from: { readonly harnessId: string; readonly controlId: string }): readonly DelegationState[] {
    this.admit();
    const by = this.runningFor(id, from), states = this.delegationStates(id), state = this.load(id);
    const fresh = states.filter(entry => entry.status !== "running" && entry.runId !== null && !this.wasTold(state, entry));
    if (fresh.length > 0) this.commit(id, current => ({ next: { ...current, delegationsTold: { ...(current.delegationsTold ?? {}), ...Object.fromEntries(fresh.map(entry => [entry.sessionId, { runId: entry.runId!, by }])) } },
      events: [event("run.delegations_told", { runId: by, told: fresh.map(entry => ({ sessionId: entry.sessionId, runId: entry.runId })), by: "hub_tool" })] }));
    return states;
  }
  /**
   * The history a branch after the Run at `last` quotes: what the source itself quoted, then the words of its finished Turns through that Run in the order they were said (the seq of each message
   * places it: a queued input is accepted before the reply of the Turn in front of it is made).
   */
  private quotedThrough(sourceId: SessionId, loaded: Conversation, last: number): ForkedMessage[] {
    const turns = turnSource(this.store, sourceId), said: { readonly seq: number; readonly message: ForkedMessage }[] = [];
    for (let ordinal = 0; ordinal <= last; ordinal++) {
      const turn = turns.turn(ordinal);
      if (turn === null || !terminal(turn.run.status)) continue;
      const run = turn.run;
      said.push({ seq: turn.user.seq, message: { role: "user", text: turn.user.text, status: run.status, ...(run.attachments?.length ? { attachments: run.attachments } : {}) } });
      if (turn.assistant !== undefined) said.push({ seq: turn.assistant.seq, message: { role: "assistant", text: turn.assistant.text, status: run.status, harnessId: run.selection.harnessId } });
    }
    said.sort((left, right) => left.seq - right.seq);
    const quoted = loaded.origin === undefined ? null : originFromRows(loaded.origin, this.store.originHistory?.(sourceId) ?? []);
    return [...(quoted?.history ?? []), ...said.map(item => item.message)];
  }
  /** Whether a binding's native session holds exactly the conversation through `through` (relay-coordinator nativeExactAt). */
  private exactAt(state: Conversation, binding: NativeSessionBinding, through: ConversationRun): boolean {
    return nativeExactAt({ originHistory: this.quotedHistory(state) }, binding, through, () => through.endedSeq, on => this.relayFacts(state, on));
  }
  async wait(id: SessionId): Promise<void> {
    this.load(id);
    for (;;) {
      const worker = this.workers.get(id), release = this.releasing.get(id);
      if (worker) { await worker.catch(() => {}); continue; }
      if (release) { await release; continue; }
      // Work not yet taken waits for a free worker slot or its workspace; every scheduling change wakes it to look again.
      if (this.work.has(id) && !this.fatal) { await new Promise<void>(resolve => { this.wakers.add(resolve); }); continue; }
      if (this.fatal) throw this.fatal;
      if (this.load(id).status === "blocked" && !this.closingSessions.has(id)) throw new SessionError("SESSION_BLOCKED", "this Session needs recovery; new dispatch is disabled for this Session");
      return;
    }
  }

  /**
   * Opts this conversation in or out of keeping its native process between Turns (ADR-030). Off by default; turning it off
   * closes a kept process before the next Turn. Idempotent by command key.
   */
  setRetention(id: SessionId, enabled: boolean, key: string): Conversation {
    this.admit(); const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "retention", enabled });
    if (replayCommand(state, command, "retention", fingerprint)) return this.load(id);
    if (state.status === "closed") throw new SessionError("SESSION_CLOSED", "a closed Session keeps no native process");
    const committed = this.commit(id, current => {
      const { retainNative, ...rest } = current;
      return { next: { ...rest, ...(enabled ? { retainNative: true as const } : {}), commands: [...current.commands, { id: command, kind: "retention", fingerprint, resultId: id }] },
        events: [event("session.retention_changed", { enabled })] };
    });
    if (!enabled && this.kept.has(id)) void this.requestRelease(id, "disabled");
    return this.load(committed.conversation.id);
  }
  /**
   * The user renames the conversation or archives it, or takes the mark off (2026-11-14). A title is trimmed and its line breaks made spaces; an empty one is refused.
   * Once the user named it, the title worked out from its first message no longer replaces the name. The archive mark is the list's: it is not `status`, and an archived
   * conversation opens and takes messages as any other (the next Turn accepted takes it off, `send`). One commit, published as every other, so that each page that has the
   * conversation open is told by its head and the list's row moves on. A change that changes nothing commits nothing. Allowed in any state: a closed conversation is
   * renamed and archived too.
   * The same holds of the pin and the reminder (2026-11-14): `pinned` puts the conversation at the top of the list until taken off (a new Turn leaves it), `snoozedUntil`
   * puts it aside until that moment (null takes it off; a new Turn takes it off too). Whether the moment came is the page's to tell. None of these moves the
   * conversation's time (`marksOnly`): the list's order and its "how long ago" say how the conversation itself went on.
   * A pinned conversation has its place among the pinned, `pinnedOrder` (lowest first; any finite number, which the user's drag sets): pinning without one puts it first,
   * lower than every other pinned one, and one already pinned stays where it is; taking the pin off drops it. A place is a mark like the pin, and only a pinned conversation
   * (or one this change pins) has one: PIN_REQUIRED otherwise.
   */
  updateSession(id: SessionId, change: { readonly title?: string; readonly archived?: boolean; readonly pinned?: boolean; readonly pinnedOrder?: number; readonly snoozedUntil?: number | null }): Conversation {
    this.admit();
    if (change.title === undefined && change.archived === undefined && change.pinned === undefined && change.pinnedOrder === undefined && change.snoozedUntil === undefined)
      throw new SessionError("INVALID_INPUT", "a change names a title, whether the conversation is archived or pinned, or when it is put aside until");
    if (change.title !== undefined && typeof change.title !== "string") throw new SessionError("INVALID_INPUT", "a title is text");
    if (change.archived !== undefined && typeof change.archived !== "boolean") throw new SessionError("INVALID_INPUT", "archived is true or false");
    if (change.pinned !== undefined && typeof change.pinned !== "boolean") throw new SessionError("INVALID_INPUT", "pinned is true or false");
    if (change.pinnedOrder !== undefined && (typeof change.pinnedOrder !== "number" || !Number.isFinite(change.pinnedOrder))) throw new SessionError("INVALID_INPUT", "pinnedOrder is a finite number");
    if (change.pinnedOrder !== undefined && change.pinned === false) throw new SessionError("INVALID_INPUT", "a conversation taken off the pins has no place among them");
    if (change.snoozedUntil !== undefined && change.snoozedUntil !== null && (typeof change.snoozedUntil !== "number" || !Number.isSafeInteger(change.snoozedUntil) || change.snoozedUntil < 0))
      throw new SessionError("INVALID_INPUT", "snoozedUntil is a moment in milliseconds since the epoch, or null");
    const title = change.title === undefined ? undefined : change.title.replace(/\s*[\r\n\u2028\u2029]+\s*/gu, " ").trim();
    if (title === "") throw new SessionError("INVALID_INPUT", "a title cannot be empty");
    const state = this.load(id);
    if (change.pinnedOrder !== undefined && change.pinned !== true && state.pinned !== true) throw new SessionError("PIN_REQUIRED", "only a pinned conversation has a place among the pinned");
    const renamed = title !== undefined && title !== state.userTitle, marked = change.archived !== undefined && change.archived !== (state.archived === true);
    const pin = change.pinned ?? state.pinned === true;
    // The place: the one given; for one pinned now without one, first among the pinned; one already pinned keeps its own (none, if it was pinned before places were kept).
    const order = !pin ? undefined : change.pinnedOrder !== undefined ? (Object.is(change.pinnedOrder, -0) ? 0 : change.pinnedOrder)
      : state.pinned === true ? state.pinnedOrder : (lowest => lowest === null ? 0 : lowest - 1)(this.lowestPinnedOrder(id));
    const pinned = pin !== (state.pinned === true) || order !== state.pinnedOrder, snoozed = change.snoozedUntil !== undefined && (change.snoozedUntil ?? undefined) !== state.snoozedUntil;
    if (!renamed && !marked && !pinned && !snoozed) return state;
    this.commit(id, current => {
      const { userTitle: _title, archived: _archived, pinned: _pinned, pinnedOrder: _order, snoozedUntil: _snoozed, ...rest } = current;
      const userTitle = title ?? current.userTitle, archived = change.archived ?? current.archived === true;
      const until = change.snoozedUntil === undefined ? current.snoozedUntil : change.snoozedUntil ?? undefined;
      return { next: { ...rest, ...(userTitle === undefined ? {} : { userTitle }), ...(archived ? { archived: true as const } : {}), ...(pin ? { pinned: true as const } : {}), ...(pin && order !== undefined ? { pinnedOrder: order } : {}),
          ...(until === undefined ? {} : { snoozedUntil: until }) },
        events: [...(renamed ? [event("session.renamed", { title })] : []), ...(marked ? [event("session.archived", { archived })] : []), ...(pinned ? [event("session.pinned", { pinned: pin, ...(pin && order !== undefined ? { order } : {}) })] : []),
          ...(snoozed ? [event("session.snoozed", { until: until ?? null })] : [])], marksOnly: true };
    });
    return this.load(id);
  }
  /** The lowest place among the pinned conversations other than `except` (deleted ones are not in the list); null when none has one. */
  private lowestPinnedOrder(except: SessionId): number | null {
    let lowest: number | null = null, after: SessionListCursor | undefined;
    do {
      const page = this.store.list({ limit: 1000, ...(after === undefined ? {} : { after }) });
      for (const row of page.rows) if (row.id !== except && row.pinned === true && typeof row.pinnedOrder === "number" && Number.isFinite(row.pinnedOrder)) lowest = lowest === null ? row.pinnedOrder : Math.min(lowest, row.pinnedOrder);
      after = page.next ?? undefined;
    } while (after !== undefined);
    return lowest;
  }
  /**
   * The user deletes the conversation (2026-11-14): it leaves the list, and every read of it is not found, until the user restores it (`restoreSession`). Its file stays where
   * it is and nothing of it is erased. Refused while a Turn of it is queued or runs, or a switch of it is pending: the user stops it first. A native process it keeps is
   * released on the way a closed conversation's is; resolves once that is recorded. The conversations it delegated work to are not touched. Deleting a deleted
   * conversation changes nothing.
   */
  async deleteSession(id: SessionId): Promise<Conversation> {
    this.admit();
    const state = this.load(id);
    if (state.deletedAt !== undefined) return state;
    if (state.activeRunId !== null || state.pendingSwitchId !== null || state.runs.some(run => !terminal(run.status)) || this.closingSessions.has(id))
      throw new SessionError("SESSION_ACTIVE", "这个对话有一轮正在进行：先停下它，再删除");
    const at = this.options.now().getTime();
    this.commit(id, current => ({ next: { ...current, deletedAt: at }, events: [event("session.deleted", {})], marksOnly: true }));
    if (this.kept.has(id) || this.releasing.has(id)) await this.requestRelease(id, "conversation_deleted");
    return this.load(id);
  }
  /** Undoes the user's deletion (2026-11-14): the conversation is in the list again, where its own time puts it, and is read as before. One that is not deleted is left as it is. */
  restoreSession(id: SessionId): Conversation {
    this.admit();
    const state = this.load(id);
    if (state.deletedAt === undefined) return state;
    this.commit(id, current => { const { deletedAt: _deleted, ...rest } = current; return { next: rest, events: [event("session.restored", {})], marksOnly: true }; });
    return this.load(id);
  }
  /**
   * Erases a conversation the user deleted (2026-11-14, "recently deleted"): its file and its row, the content only it mentioned, and its part of the record's directory.
   * One that is not deleted is refused (DELETION_REQUIRED: delete it first). A native process it still keeps is released first, as its deletion does. The conversations
   * it delegated work to are not touched. Nothing of it can be restored after.
   */
  async purgeSession(id: SessionId): Promise<void> { await this.purge([id], true); }
  /** Erases every conversation the user deleted; how many were erased. One that cannot be erased now (it was restored meanwhile, its process would not be released) stays. */
  async purgeDeleted(): Promise<number> {
    this.admit();
    const list = this.store.listDeleted?.bind(this.store);
    if (list === undefined) return 0;
    const ids: SessionId[] = [];
    for (let before: string | undefined; ;) {
      const page = list(before === undefined ? {} : { before });
      ids.push(...page.rows.map(row => row.id));
      if (page.next === null || page.rows.length === 0) break;
      before = page.next;
    }
    return (await this.purge(ids, false)).length;
  }
  /**
   * Erases conversations: each is checked (`strict`: one that cannot be erased refuses the call; otherwise it is passed over), then the record's directories are told what
   * they lose (read now, while the conversations are there), the store erases them (one step, all checked first), the content only they mentioned goes, and what this
   * Runtime held of them is let go; the directories are written last.
   */
  private async purge(ids: readonly SessionId[], strict: boolean): Promise<readonly SessionId[]> {
    this.admit();
    const erase = this.store.purgeSessions?.bind(this.store);
    if (erase === undefined) throw new SessionError("PURGE_UNSUPPORTED", "这里不能彻底删除对话");
    const ready: SessionId[] = [];
    for (const id of new Set(ids)) {
      const refuse = (code: string, message: string): void => { if (strict) throw new SessionError(code, message); };
      let state: Conversation;
      try { state = this.load(id); } catch (error) { if (strict || !(error instanceof SessionError && error.code === "SESSION_NOT_FOUND")) throw error; continue; }
      if (state.deletedAt === undefined) { refuse("DELETION_REQUIRED", "先删除这个对话，再彻底删除"); continue; }
      if (this.kept.has(id) || this.releasing.has(id)) {
        await this.requestRelease(id, "conversation_deleted");
        this.admit(); state = this.load(id);
        if (state.deletedAt === undefined) { refuse("DELETION_REQUIRED", "这个对话刚被恢复了，没有彻底删除"); continue; }
      }
      if (state.activeRunId !== null || state.pendingSwitchId !== null || state.runs.some(run => !terminal(run.status)) || state.retained !== undefined || this.kept.has(id) || this.releasing.has(id)
        || this.closingSessions.has(id) || this.actives.has(id)) { refuse("SESSION_ACTIVE", "这个对话还有一轮没结束或还留着原生进程：等它结束再彻底删除"); continue; }
      ready.push(id);
    }
    if (ready.length === 0) return [];
    // Where each one worked, read while it is there: its checkpoints go with it (2026-11-14).
    const workspaces = new Map(ready.map(id => [id, this.load(id).configuration.workspace] as const));
    // From here to the store's erasure nothing waits: the directories' work is queued behind their writers and runs once the rows are gone.
    const purging = new Set(ready), records: Promise<void>[] = [];
    for (const id of ready) { try { const work = this.options.context?.forget?.(id, purging); if (work !== undefined) records.push(work.catch(() => undefined)); } catch { /* the directory keeps what it had */ } }
    let result: { readonly purged: readonly SessionId[]; readonly content: ReadonlySet<string> | null };
    try { result = erase(ready); } catch (error) { if (storeUntrusted(error)) this.fail(error); throw error; }
    for (const id of result.purged) this.forgetConversation(id);
    // Content is user data: it goes only when the store could say no other conversation mentions it.
    if (result.content !== null && result.content.size > 0) { try { this.options.content?.purge?.(result.content); } catch { /* what is left is kept, as unmentioned content always was */ } }
    const checkpoints = this.options.checkpoints;
    if (checkpoints !== undefined) for (const id of result.purged) { const workspace = workspaces.get(id); if (workspace !== undefined) { try { records.push(checkpoints.forget(workspace, id).catch(() => undefined)); } catch { /* its refs stay */ } } }
    await Promise.all(records);
    return result.purged;
  }
  /** Lets go of what this Runtime held of a conversation that was erased. */
  private forgetConversation(id: SessionId): void {
    this.versions.delete(id); this.quoted.delete(id); this.managedSessions.delete(id); this.outside.delete(id); this.lost.delete(id); this.upgraded.delete(id); this.pinned.delete(id);
    this.waitingForSlot.delete(id);
    for (const [key, entry] of this.diagnostics) if (entry.sessionId === id) this.diagnostics.delete(key);
  }
  /**
   * The name the conversation's Harness gives it with its wrap-up (2026-11-14, `hub_wrap_up`'s `title`): taken only while the user has not named the conversation and its
   * Harness has not named it before, so that it is given once, at the first Turn's end, and a name the user gives later still goes before it. Its spaces are folded and it
   * is cut as a title is; one with no words is passed over. It does not move the conversation's time (`marksOnly`).
   */
  private nameByHarness(id: SessionId, title: string): void {
    const name = cutTitle(title.replace(/\s+/gu, " ").trim());
    if (name === "") return;
    const state = this.load(id);
    if (state.userTitle !== undefined || state.harnessTitle !== undefined) return;
    this.commit(id, current => ({ next: { ...current, harnessTitle: name }, events: [event("session.titled", { title: name })], marksOnly: true }));
  }
  /**
   * The branch of the conversation's worktree is now `to` (2026-11-14): the Gateway renamed it after the conversation's title (src/web/worktree-routes.ts), or found the
   * worktree on another branch. Recorded only while the record still names `from`; one commit that does not move the conversation's time (`marksOnly`), in any state.
   */
  recordWorktreeBranch(id: SessionId, from: string, to: string): void {
    this.admit();
    if (typeof from !== "string" || typeof to !== "string" || to === "" || /[\0-\x1f\x7f]/u.test(to)) throw new SessionError("INVALID_INPUT", "a branch is a name");
    const state = this.load(id), worktree = state.worktree;
    if (worktree === undefined || worktree.branch !== from || from === to) return;
    this.commit(id, current => ({ next: { ...current, worktree: { ...worktree, branch: to } }, events: [event("session.worktree_branch", { from, to })], marksOnly: true }));
  }
  /** Closes this conversation's kept process at the user's request, with the normal stop chain; resolves once it is recorded. */
  async endKept(id: SessionId, key: string): Promise<Conversation> {
    this.admit(); const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "native-close" });
    if (!replayCommand(state, command, "native-close", fingerprint)) {
      this.commit(id, current => ({ next: { ...current, commands: [...current.commands, { id: command, kind: "native-close", fingerprint, resultId: id }] }, events: [event("native.process_close_requested", {})] }));
    }
    if (this.kept.has(id) || this.releasing.has(id)) await this.requestRelease(id, "ended_by_user");
    return this.load(id);
  }
  /** This conversation's kept process as the chat shows it; null when it keeps none. */
  keptProcess(id: SessionId): { readonly harnessId: string; readonly controlId: string; readonly since: number; readonly lastUsedAt: number; readonly idleEndsAt: number; readonly backgroundUpdates: number } | null {
    const kept = this.kept.get(id);
    return kept === undefined ? null : { harnessId: kept.selection.harnessId, controlId: kept.selection.controlId, since: kept.since, lastUsedAt: kept.lastUsed,
      idleEndsAt: kept.lastUsed + (this.options.keptIdleMs ?? KEPT_IDLE_MS), backgroundUpdates: this.background(kept) };
  }
  /**
   * HarnessHub's own conversations using a Harness, for its upgrade (ADR-043): busy while a Turn with it is queued, waits
   * or runs; idle while the conversation only keeps its process.
   */
  programUsers(harnessId: string): readonly { readonly sessionId: SessionId; readonly busy: boolean }[] {
    const users = new Map<SessionId, boolean>();
    for (const id of new Set([...this.actives.keys(), ...this.work, ...this.workers.keys()])) {
      let state: Conversation;
      try { state = this.load(id); } catch { continue; }
      if (state.runs.some(run => OPEN_RUN.has(run.status) && run.selection.harnessId === harnessId)) users.set(id, true);
    }
    for (const [id, kept] of this.kept) if (kept.selection.harnessId === harnessId && !users.has(id)) users.set(id, false);
    return [...users].map(([sessionId, busy]) => ({ sessionId, busy }));
  }
  /**
   * Closes every idle kept process of a Harness before it is upgraded (ADR-043), with the normal stop chain, and resolves
   * with how many once each close is recorded. Each conversation says so until its next Turn, which starts the new version.
   */
  async releaseForUpgrade(harnessId: string): Promise<number> {
    const ids = [...this.kept].filter(([, kept]) => kept.selection.harnessId === harnessId).map(([id]) => id), at = this.options.now().getTime();
    // Recorded first, so the view published with each close already says why.
    for (const id of ids) this.upgraded.set(id, { harnessId, at });
    await Promise.all(ids.map(id => this.requestRelease(id, "harness_upgrade")));
    return ids.length;
  }
  /** The upgrade that closed this conversation's kept process, until its next Turn; null when none did. */
  keptUpgrade(id: SessionId): { readonly harnessId: string; readonly at: number } | null { return this.upgraded.get(id) ?? null; }
  /** Every kept process with the workspace it holds, for telling a conversation which one occupies its workspace. */
  keptProcesses(): readonly { readonly sessionId: SessionId; readonly workspace: string; readonly harnessId: string }[] {
    return [...this.kept].map(([sessionId, kept]) => ({ sessionId, workspace: kept.binding.workspace, harnessId: kept.selection.harnessId }));
  }
  /**
   * The last stderr this Turn's program logged while serving it, as the program wrote it (private: it is redacted before it
   * leaves the Gateway). Kept in memory for the latest Turns of this owner only; null when unknown.
   */
  runDiagnostics(id: SessionId, run: string): { readonly stderr: string; readonly truncated: boolean } | null {
    const kept = this.diagnostics.get(run);
    return kept === undefined || kept.sessionId !== id ? null : { stderr: kept.stderr, truncated: kept.truncated };
  }
  private keepDiagnostics(id: SessionId, run: string, stderr: string): void {
    const truncated = Buffer.byteLength(stderr) > RUN_DIAGNOSTIC_BYTES, tail = truncated ? Buffer.from(stderr).subarray(-RUN_DIAGNOSTIC_BYTES).toString("utf8").replace(/^\uFFFD+/u, "") : stderr;
    this.diagnostics.delete(run); this.diagnostics.set(run, { sessionId: id, stderr: tail, truncated });
    while (this.diagnostics.size > MAX_RUN_DIAGNOSTICS) this.diagnostics.delete(this.diagnostics.keys().next().value!);
  }
  /** What became of the process this conversation kept under the previous owner, when this owner found one at start. */
  keptLoss(id: SessionId): { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number } | null { return this.lost.get(id) ?? null; }
  /** How many background processes of this conversation's closed program may still run, until its next Turn. */
  keptOutside(id: SessionId): { readonly count: number; readonly at: number } | null { return this.outside.get(id) ?? null; }
  /**
   * Before a kept program's group is ended: the processes that left it, read once and never signalled. After: which still
   * run. The evidence keeps 0 found apart from not knowing, and a conversation hears of those still running once.
   */
  private async outsideBefore(identity: KeptProcessIdentity | undefined): Promise<readonly OutsideProcess[] | null> {
    if (identity === undefined || this.options.processes?.outsiders === undefined) return null;
    try { return await this.options.processes.outsiders(identity); } catch { return null; }
  }
  private async outsideAfter(id: SessionId, found: readonly OutsideProcess[] | null): Promise<OutsideEvidence> {
    if (found === null) return { state: "unknown" };
    let remaining: readonly OutsideProcess[] | null = [];
    if (found.length) { try { remaining = this.options.processes?.running === undefined ? null : await this.options.processes.running(found); } catch { remaining = null; } }
    const still = remaining === null ? found.length : remaining.length;
    if (still > 0) this.outside.set(id, { count: still, at: this.options.now().getTime() });
    return { state: "enumerated", found: found.length, remaining: remaining === null ? null : remaining.length, commands: [...new Set(found.map(item => item.command))].slice(0, 16) };
  }
  /**
   * Ends the native process groups that conversations kept under an owner that ended without closing them (ADR-030), and
   * releases each one's workspace lease once the end is confirmed. A group that cannot be recognized (no recorded identity,
   * or members that outlive SIGKILL) leaves its workspace quarantined. Each outcome is recorded for its conversation. The
   * owner runs it once at start, before admitting work; groups are handled one at a time, each within about 6 seconds.
   * Resolves with every outcome, in the order handled.
   */
  async reapKept(): Promise<readonly { readonly sessionId: SessionId; readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean }[]> {
    const outcomes: { readonly sessionId: SessionId; readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean }[] = [];
    for (const kept of this.store.listKept()) {
      const state = this.load(kept), retained = state.retained;
      if (retained === undefined || this.kept.has(state.id)) continue;
      let outcome: "terminated" | "gone" | "unconfirmed" = "unconfirmed";
      const found = await this.outsideBefore(retained.process);
      if (retained.process !== undefined && this.options.processes !== undefined) {
        try { outcome = await this.options.processes.end(retained.process); } catch { outcome = "unconfirmed"; }
      }
      const outside = await this.outsideAfter(state.id, found);
      let leaseReleased = false;
      if (outcome !== "unconfirmed") { try { leaseReleased = this.factory.releaseAbandonedLease?.(state.configuration, state.id) ?? false; } catch { leaseReleased = false; } }
      const at = this.options.now().getTime();
      this.commit(state.id, current => {
        const { retained: _held, ...rest } = current;
        return { next: rest, events: [event("native.process_lost", { runId: retained.runId, harnessId: retained.harnessId, controlId: retained.controlId, reason: "owner_ended", outcome, leaseReleased, outside })] };
      });
      this.lost.set(state.id, { outcome, leaseReleased, at });
      outcomes.push({ sessionId: state.id, outcome, leaseReleased });
    }
    return outcomes;
  }
  private background(kept: KeptProcess): number { return Math.max(0, (kept.binding.control.unattributedUpdates ?? kept.baseline) - kept.baseline); }
  /** Asks the single writer to close a kept process before its next Turn or switch; resolves once the close is recorded. */
  private requestRelease(id: SessionId, reason: KeptRelease): Promise<void> {
    const pending = this.releasing.get(id);
    if (pending) return pending;
    if (!this.kept.has(id)) return Promise.resolve();
    // A kept process is idle, so its close never meets its own conversation's Turn; Turns and switches wait for it (settleReleases).
    const done: Promise<void> = this.release(id, reason).catch(error => { this.stalls(error, id); })
      .finally(() => { if (this.releasing.get(id) === done) this.releasing.delete(id); this.drive(); });
    this.releasing.set(id, done);
    return done;
  }
  /** Resolves once no kept process is being closed; work never starts while a lease may be about to be released. */
  private async settleReleases(): Promise<void> { while (this.releasing.size) await Promise.allSettled([...this.releasing.values()]); }
  /**
   * Closes a kept process with the normal stop chain (request stop, wait, SIGTERM/SIGKILL) and records the close and its
   * evidence for the conversation. A close that cannot be confirmed leaves the workspace lease quarantined.
   */
  private async release(id: SessionId, reason: KeptRelease): Promise<void> {
    const kept = this.kept.get(id);
    if (kept === undefined) return;
    this.kept.delete(id); clearTimeout(kept.timer);
    const backgroundUpdates = this.background(kept);
    let cleanup: CleanupEvidence | null = null, problem: ReturnType<typeof fault> | null = null;
    const found = await this.outsideBefore(kept.identity);
    try { cleanup = await kept.binding.close(); } catch (error) { problem = fault(error); }
    const outside = await this.outsideAfter(id, found);
    try {
      this.commit(id, current => {
        const { retained, ...rest } = current;
        // The close of a deleted conversation's process is not the conversation going on: restored, it stands where its own time put it.
        return { next: rest, events: [event("native.process_closed", { runId: kept.runId, reason, backgroundUpdates, cleanup, outside, ...(problem === null ? {} : { error: problem }) })],
          ...(current.deletedAt === undefined ? {} : { marksOnly: true as const }) };
      });
    } catch (error) {
      // A rule of the rows refused the record of the close: the process is closed all the same, and the conversation goes on saying it keeps one until the next start finds none (reapKept).
      if (storeUntrusted(error)) throw error;
    }
  }
  /**
   * The process this conversation kept, when it can take a Turn with `selection`; a kept process that cannot is closed first.
   */
  private async takeKept(id: SessionId, selection: HarnessSelection): Promise<KeptProcess | null> {
    const kept = this.kept.get(id);
    if (kept === undefined) return null;
    if (!sameSelection(kept.selection, selection)) { await this.release(id, "selection_changed"); return null; }
    if (kept.binding.control.healthy?.() !== true) { await this.release(id, "exited"); return null; }
    this.kept.delete(id); clearTimeout(kept.timer); return kept;
  }
  /** Whether a finished Turn hands its process to the conversation: opted in, completed cleanly, confirmed, and under the limit when an operator set one (none by default). */
  private keepable(id: SessionId, execution: ActiveExecution, backend: BackendResult | null, problem: unknown, confirmed: boolean): { readonly keep: boolean; readonly skipped?: "limit" } {
    try {
      const state = this.load(id), run = state.runs.find(row => row.id === execution.runId);
      if (state.retainNative !== true || run === undefined || run.cancelRequested || run.selection.provider !== undefined || !confirmed || problem !== null || backend?.status !== "completed"
        || execution.stop !== null || execution.earlyClose !== null || !this.accepting || this.fatal !== null || this.closingSessions.has(id) || this.releasing.has(id)
        || execution.binding?.control.healthy?.() !== true) return { keep: false };
      return this.options.keptLimit !== undefined && this.kept.size >= this.options.keptLimit ? { keep: false, skipped: "limit" } : { keep: true };
    } catch { return { keep: false }; }
  }

  async closeSession(id: SessionId, key: string): Promise<Conversation> {
    this.admit(); const command = commandId(key), fingerprint = this.fingerprint({ kind: "close" });
    const state = this.load(id), prior = replayCommand(state, command, "close", fingerprint);
    if (prior) { await this.wait(id); return this.load(id); }
    this.closingSessions.add(id);
    try {
      // Text the active Turn streamed before the close is committed first, so the close never precedes it in the log (ADR-047).
      const active = this.actives.get(id); if (active) this.flushStreamQuietly(active);
      this.commit(id, current => {
        const next = this.cancelPending(current);
        return { next: { ...next, commands: [...next.commands, { id: command, kind: "close", fingerprint, resultId: id }] },
          events: [event("session.close_requested", { cancelledRunIds: current.runs.filter(run => run.status === "queued").map(run => run.id) })] };
      });
      if (active) this.stop(active);
      this.stopSwitch(id); this.drive();
      if (this.kept.has(id)) void this.requestRelease(id, "conversation_closed");
      await this.wait(id);
      this.commit(id, current => ({ next: { ...current, status: "closed" }, events: [event("session.closed", {})] }));
      return this.load(id);
    } finally { this.closingSessions.delete(id); }
  }

  /**
   * Stops owned work and admission, then ends what the binding factory still does in the background (its own bound, ADR-056
   * §4.12). Public Sessions and Store remain available to the next owner.
   */
  /** The context window each Harness last reported, by Harness, control and model: what a packet for it is sized by before it has run in a conversation. Kept while the Runtime lives. */
  private readonly windows = new Map<string, number>();
  /** The writes of the record's directory that a Turn's end began and did not wait for: the close waits for them. */
  private readonly recordWork = new Set<Promise<void>>();
  /** The operator's level (Reseat `full`): how full a native session may be at the end of a Turn before the Hub opens a new one; null, and by default: never. */
  private reseatShare: number | null | undefined = undefined;
  /** Sets the operator's level while the Runtime runs: a share of the window, null for never, undefined for what the Runtime was started with. */
  setReseatAt(share: number | null | undefined): void { this.reseatShare = share === undefined || share === null || Number.isFinite(share) && share > 0 && share <= 1 ? share : undefined; }
  private reseatAt(): number | null { return (this.reseatShare === undefined ? this.options.reseatAt : this.reseatShare) ?? null; }
  /** The Turn of each conversation in which its Harness compacted its session and was told the state again before the Turn ended: the next Turn does not say it a second time. */
  private readonly pinned = new Map<SessionId, string>();
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.accepting = false;
    // Install ownership before synchronous committed-event callbacks can reenter close().
    this.shutdown = Promise.resolve().then(() => this.closeOwned());
    void this.shutdown.catch(() => {});
    return this.shutdown;
  }
  private async closeOwned(): Promise<void> {
    let problem: unknown;
    try {
      for (const id of this.managedSessions) {
        const state = this.load(id);
        if (state.runs.some(run => !terminal(run.status)) || state.pendingSwitchId !== null) {
          // Text the active Turn streamed before the stop is committed first, so the stop never precedes it in the log (ADR-047).
          const active = this.actives.get(id); if (active) this.flushStreamQuietly(active);
          this.commit(state.id, current => ({ next: this.cancelPending(current), events: [event("runtime.stopping", {})] }));
        }
      }
    } catch (error) { problem = error; this.fail(error); }
    for (const execution of [...this.actives.values()]) this.stop(execution);
    this.stopSwitch();
    while (this.workers.size) await Promise.allSettled([...this.workers.values()]);
    // Kept processes end with their owner; each close is recorded for its conversation (ADR-030).
    try { await this.settleReleases(); for (const id of [...this.kept.keys()]) await this.release(id, "gateway_shutdown"); }
    catch (error) { problem ??= error; this.fail(error); }
    const creating = await Promise.allSettled([...this.creating]);
    for (const result of creating) if (result.status === "rejected" && !(result.reason instanceof SessionError && result.reason.code === "RUNTIME_CLOSED")) {
      problem ??= result.reason; this.fail(result.reason);
    }
    this.work.clear();
    // What was still being written of the record's directory is written before the owner goes.
    await Promise.allSettled([...this.recordWork]);
    // Last, once no binding runs: the factory's background work, such as removing host TMPDIRs moved aside (bounded).
    try { await this.factory.close?.(); } catch (error) { problem ??= error; this.fail(error); }
    if (problem) throw problem;
    if (this.fatal) throw this.fatal;
  }

  private cancelPending(state: Conversation): Conversation {
    const closedAt = this.options.now().getTime();
    const runs = state.runs.map(run => run.status === "queued" ? { ...run, status: "cancelled" as const, cancelRequested: true, ...phase(state, run.id, "endedAt", closedAt) }
      : terminal(run.status) ? run : { ...run, cancelRequested: true });
    const sourceStillActive = state.activeRunId !== null && state.switches.some(sw => sw.id === state.pendingSwitchId && sw.sourceRunIds.includes(state.activeRunId!));
    return { ...state, runs,
      pendingSwitchId: sourceStillActive ? state.pendingSwitchId : null, switches: state.switches.map(sw => sw.id === state.pendingSwitchId
        ? { ...sw, ...(sourceStillActive ? {} : { status: "failed" as const }), error: { code: "CANCELLED", message: "switch cancelled by close" } } : sw) };
  }
  private cancelInternal(id: SessionId, command: CommandId, target?: PublicRun["id"]): CancelReceipt {
    const state = this.load(id), fingerprint = this.fingerprint({ kind: "cancel", target: target ?? null });
    const prior = replayCommand(state, command, "cancel", fingerprint);
    if (prior) return { sessionId: id, target: prior.resultId === "none" ? null : runId(prior.resultId), replayed: true };
    this.open(state);
    const selected = target === undefined ? state.activeRunId : target;
    const run = selected === null ? undefined : runIn(state, selected);
    if (selected !== null && !run) throw new SessionError("NOT_FOUND", "Run does not belong to this Session");
    // Text the Turn streamed before the user's stop is committed first, so the stop never precedes it in the log (ADR-047).
    const active = this.actives.get(id), stopping = active !== undefined && active.runId === selected ? active : null;
    if (stopping) this.flushStreamQuietly(stopping);
    // A Turn whose program already settled (its reply is in, it only closes) keeps its result: the stop is recorded, the
    // close goes on as it would have, and the Turn ends as the program reported (ADR-056, implementation record item 12).
    const settled = run?.status === "settling" || stopping?.backendSettled === true;
    this.commit(id, current => {
      let next = current;
      if (run && !terminal(run.status) && !settled) next = updatedRun(current, run.id, { cancelRequested: true, ...(run.status === "queued" ? { status: "cancelled" as const, ...phase(current, run.id, "endedAt", this.options.now().getTime()) } : {}) });
      return { next: { ...next, commands: [...next.commands, { id: command, kind: "cancel", fingerprint, resultId: selected ?? "none" }] },
        events: [event("run.cancel_requested", { runId: selected, beforeStart: run?.status === "queued", alreadyTerminal: run === undefined || terminal(run.status) })] };
    });
    if (stopping && !settled) this.stop(stopping);
    this.schedule(id); return { sessionId: id, target: selected, replayed: false };
  }

  private admit(): void {
    try { this.store.assertOwner(); } catch (error) { this.fail(error); throw error; }
    if (!this.accepting) throw new SessionError("RUNTIME_CLOSED", "runtime is not accepting commands");
    if (this.fatal) throw this.fatal;
  }
  private open(state: Conversation): void {
    // A conversation the user deleted is not there for new work (2026-11-14), as it is not for any read; it is restored first.
    if (state.deletedAt !== undefined) throw new SessionError("SESSION_NOT_FOUND", "public Session was not found");
    if (state.status !== "open" || this.closingSessions.has(state.id)) throw new SessionError("SESSION_UNAVAILABLE", "Session is closed or blocked; new dispatch is disabled for this Session");
  }
  private recoverySwitch(state: Conversation): boolean {
    const pending = state.switches.find(sw => sw.id === state.pendingSwitchId);
    if (!pending) return false;
    const request = this.store.events(state.id, pending.requestedSeq - 1, 1)[0];
    return request?.type === "switch.requested" && request.data.switchId === pending.id && request.data.recovery === true;
  }
  private recoverable(state: Conversation, acknowledgeUnknown: boolean): void {
    if (state.status !== "blocked" || state.activeRunId !== null || state.pendingSwitchId !== null || this.closingSessions.has(state.id))
      throw new SessionError("RECOVERY_UNAVAILABLE", "当前对话无法执行恢复检查，请等待当前操作结束。");
    const unknown = state.runs.filter(run => run.status === "unknown");
    if (unknown.some(run => run.cleanup?.closed !== true || this.unknownOwnership(run.error)))
      throw new SessionError("RECOVERY_UNSAFE", "上次执行的资源还未确认停止，请先核实工作区中的进程。历史和草稿仍可查看与编辑。");
    if (unknown.length && !acknowledgeUnknown)
      throw new SessionError("RECOVERY_ACK_REQUIRED", "上次执行结果未知。确认保留该结果并只开始新的任务后，才能继续。");
    let after = 0;
    let block: SessionEvent | undefined;
    const failedSwitches = new Map<string, SessionEvent>();
    while (after < state.lastSeq) {
      const page = this.store.events(state.id, after, 100);
      if (!page.length) throw new SessionError("INVALID_DATA", "recovery facts have a missing event page");
      for (const item of page) {
        if (item.type === "switch.failed" && typeof item.data.switchId === "string") failedSwitches.set(item.data.switchId, item);
        if (item.type === "session.blocked") block = item;
      }
      after = page.at(-1)!.seq;
    }
    if (block === undefined || block.data.error !== undefined ||
        (typeof block.data.runId !== "string" && typeof block.data.switchId !== "string"))
      throw new SessionError("RECOVERY_UNSAFE", "对话因所有权或存储故障暂停，无法直接恢复执行。请先恢复本机服务；历史和草稿已保留。");
    if (typeof block.data.runId === "string") {
      const run = state.runs.find(run => run.id === block.data.runId);
      if (run?.cleanup?.closed !== true || this.unknownOwnership(run.error))
        throw new SessionError("RECOVERY_UNSAFE", "上次执行的资源还未确认停止，无法恢复同一工作区的执行。");
    } else {
      const failedSwitch = typeof block.data.switchId === "string" ? failedSwitches.get(block.data.switchId) : undefined;
      const cleanup = failedSwitch?.data.cleanup;
      if (failedSwitch?.data.switchId !== block.data.switchId || cleanup === null || typeof cleanup !== "object" || !("closed" in cleanup) || cleanup.closed !== true)
        throw new SessionError("RECOVERY_UNSAFE", "失败切换缺少资源关闭证据，无法恢复同一工作区的执行。");
    }
  }
  private fingerprint(value: unknown): string { return this.options.fingerprint(JSON.stringify(value)); }
  /**
   * The version of each Session as this runtime last read or committed it: commit() names it for the Store's
   * compare-and-swap instead of reading the Session again first (ADR-055 §11.2). A transaction committed past this runtime
   * makes it stale; the Store then refuses before the mutation runs, and commit() reads the Session first, as it used to.
   */
  private readonly versions = new Map<SessionId, number>();
  private load(id: SessionId): Conversation {
    try { const state = this.store.get(id); this.versions.set(id, state.version); return state; }
    catch (error) {
      if (!(error instanceof SessionError && error.code === "SESSION_NOT_FOUND")) this.stalls(error, id);
      throw error;
    }
  }
  /** Whether the conversation started from quoted history (a branch's, an import's): what a binding is owed beside the Turns. */
  private quotedHistory(state: Conversation): boolean {
    const origin = state.origin;
    if (origin === undefined) return false;
    // A branch quotes at least the finished Turn it was made after; an import quotes what its native session returned, which may be nothing.
    if (origin.kind === "fork") return true;
    if (!origin.historyRead) return false;
    let found = this.quoted.get(state.id);
    if (found === undefined) { found = (this.store.originHistory?.(state.id).length ?? 0) > 0; this.quoted.set(state.id, found); }
    return found;
  }
  /**
   * One Store transaction of `id`, published. A failure fails the Runtime (fatal) only when it says the store cannot be trusted (storage, who owns it, the
   * version: `storeUntrusted`); any other ends the request or the Turn it belonged to, which the caller tells in the conversation. `quiet` says the caller decides:
   * a commit whose relay part the Store may refuse retries without it (R6, relayRefusal).
   */
  private commit(id: SessionId, mutate: (state: Conversation) => ConversationMutation, quiet = false): ConversationCommit {
    try {
      this.store.assertOwner();
      const known = this.versions.get(id);
      let ran = false, committed: ConversationCommit;
      // What a commit may do to the rows it changes is checked as the mutation is made, before the store writes anything.
      const once = (state: Conversation): ConversationMutation => { ran = true; const made = mutate(state); assertConversationTransition(state, made.next, made.events); return made; };
      try { committed = this.store.transact(id, known ?? this.load(id).version, once); }
      catch (error) {
        if (known === undefined || ran || !(error instanceof SessionError && error.code === "VERSION_CONFLICT")) throw error;
        committed = this.store.transact(id, this.load(id).version, once);
      }
      this.versions.set(id, committed.conversation.version);
      return this.publish(committed);
    }
    catch (error) { if (!quiet && storeUntrusted(error)) this.fail(error, id); throw error; }
  }
  /**
   * Places one input in the Turn in progress and commits what it changed, with the events the caller logs and the caller's own change to the conversation
   * (`patch`: the Run's timing, a command…), in one transaction. The Turn is advanced only once that commit stood, so a commit the store refused leaves the Turn as
   * it was. A placement that wrote no row and has no event, no patch and no `always` commits nothing (the same call was reported again, or a detail that waits was
   * merged); with `always` the commit is made for its events, as every report of a Harness is logged. Returns what `place` returned, for the details to store.
   * `input` null commits the patch and the events alone.
   */
  private placed(execution: ActiveExecution, input: PlaceInput | null, events: readonly EventDraft[], options: { readonly patch?: (current: Conversation) => Conversation; readonly always?: boolean; readonly relay?: ConversationMutation["relay"] } = {}): Placed {
    const turn = this.turnOf(execution), id = execution.sessionId;
    const placed: Placed = input === null ? { turn, changes: {}, store: [] }
      : place(turn, input, { noticeShown: print => this.store.noticeShown?.(id, print) === true, eventIndex: 0 });
    const rows = wroteRows(placed.changes);
    if (!rows && options.patch === undefined && options.always !== true && options.relay === undefined) { execution.turn = placed.turn; return placed; }
    this.commit(id, current => {
      const patched = options.patch === undefined ? current : options.patch(current);
      return { next: rows ? withItems(patched, execution.runId, itemsOf(placed.turn)) : patched, events, ...(options.relay === undefined ? {} : { relay: options.relay }),
        ...(placed.changes.noticePrints === undefined ? {} : { noticePrints: placed.changes.noticePrints }), createdBy: () => 0 };
    });
    execution.turn = placed.turn;
    return placed;
  }
  /** The Turn of an execution, opened from the items its Run holds the first time it is needed. */
  private turnOf(execution: ActiveExecution): ActiveTurn {
    if (execution.turn !== null) return execution.turn;
    const run = runIn(this.load(execution.sessionId), execution.runId);
    if (run === undefined) throw new SessionError("IDENTITY_MISMATCH", "Run is not owned by this Session");
    return execution.turn = openTurn(runRowOf(execution.sessionId, run), run.items ?? []);
  }
  /**
   * Whether a failed commit was the Store refusing what it was asked to write — a relay error, a row or transition it found
   * invalid — while it still works and this owner still owns it, so that its relay part can be dropped (G068 fix batch, R6).
   * A storage or ownership failure is never one: the Store is disabled then, or the owner gone.
   */
  private relayRefusal(error: unknown): boolean {
    if (!(error instanceof RelayError) && !(error instanceof SessionError && (error.code === "INVALID_DATA" || error.code === "INVALID_TRANSITION"))) return false;
    try { this.store.assertOwner(); return this.fatal === null; } catch { return false; }
  }
  private publish(commit: ConversationCommit): ConversationCommit {
    if (this.publicationFailed) return commit;
    // A commit that wrote nothing (a create key seen before returns the conversation it made) has nothing to tell.
    if (commit.changes.head === undefined && commit.events.length === 0) return commit;
    try { this.options.publish(commit); }
    catch { this.publicationFailed = true; const error = new SessionError("PUBLICATION_FAILED", "committed event publication failed; execution stopped"); this.fail(error, commit.conversation.id); throw error; }
    return commit;
  }
  /**
   * The one judgment of what a failure means for the Runtime: it stalls the Runtime only when it says the store cannot be trusted — a storage, ownership or version failure (`storeUntrusted`).
   * Any other failure (a rule of the rows refusing one write) ends only the Turn or request it belonged to, which its caller then tells in the conversation. Says whether it stalled the Runtime.
   */
  private stalls(error: unknown, id?: SessionId): boolean {
    if (!storeUntrusted(error)) return false;
    this.fail(error, id);
    return true;
  }
  private fail(error: unknown, id?: SessionId): void {
    this.fatal ??= new SessionError(fault(error).code, fault(error).message);
    const affected = id ?? [...this.actives.keys()][0] ?? [...this.switchBindings.keys()][0];
    for (const execution of [...this.actives.values()]) this.stop(execution);
    this.stopSwitch();
    if (affected !== undefined && !this.recordingBlock) {
      this.recordingBlock = true;
      try {
        this.store.assertOwner(); const state = this.store.get(affected);
        if (state.status === "open") {
          const committed = this.store.transact(affected, state.version, current => ({ next: { ...current, status: "blocked" },
            events: [event("session.blocked", { error: fault(error), reason: "runtime stopped after a failure" })] }));
          this.versions.set(affected, committed.conversation.version);
          this.publish(committed);
        }
      } catch (recordingError) {
        // Preserve the independent failure: a missing durable blocked record is never reported as committed.
        this.fatal.cause ??= recordingError;
      } finally { this.recordingBlock = false; }
    }
  }
  /** Closes the switch target being validated for `id`, or for every conversation. */
  private stopSwitch(id?: SessionId): void {
    for (const [owner, pending] of this.switchBindings) {
      if (id !== undefined && owner !== id) continue;
      pending.close ??= pending.binding.close();
      void pending.close.catch(() => {});
    }
  }
  private schedule(id: SessionId): void {
    this.managedSessions.add(id);
    this.work.add(id);
    this.drive();
  }
  /**
   * Starts a worker for each conversation with waiting work and none of its own, oldest accepted work first, up to the
   * parallel limit (ADR-036). Work in a workspace another conversation's worker holds waits, visibly, until it is free.
   */
  private drive(): void {
    try { this.take(); }
    finally { const wakers = [...this.wakers]; this.wakers.clear(); for (const wake of wakers) wake(); }
  }
  private take(): void {
    if (this.fatal) { this.work.clear(); return; }
    const ordered = [...this.work].sort((a, b) => this.headAccepted(a) - this.headAccepted(b));
    for (const id of ordered) {
      if (this.workers.has(id)) continue;
      if (!this.runnable(id)) { this.work.delete(id); this.leaveSlot(id); continue; }
      // A fixed number of conversations at once is the operator's setting, never the Runtime's: without one every conversation starts.
      // With one, later work is still looked at, so work behind a full house shows that it waits.
      if (this.full()) { this.joinSlot(id); continue; }
      // Conversations in one workspace all run; the Turn that comes after another is told so when it starts (execute).
      const workspace = this.load(id).configuration.workspace;
      this.work.delete(id); this.leaveSlot(id);
      this.holders.set(workspace, [...(this.holders.get(workspace) ?? []), id]);
      const worker: Promise<void> = Promise.resolve().then(() => this.serve(id));
      this.workers.set(id, worker);
      void worker.then(() => {}, error => { this.fail(error, id); }).finally(() => {
        if (this.workers.get(id) === worker) this.workers.delete(id);
        const rest = (this.holders.get(workspace) ?? []).filter(holder => holder !== id);
        if (rest.length === 0) this.holders.delete(workspace); else this.holders.set(workspace, rest);
        this.drive();
      });
    }
  }
  /** The conversations that came to a workspace before `id` and still work in it, oldest first. */
  private coworkers(id: SessionId, workspace: string): readonly SessionId[] {
    const here = this.holders.get(workspace) ?? [], at = here.indexOf(id);
    return at < 0 ? [] : here.slice(0, at);
  }
  /** Whether the operator's limit on conversations running at once, when there is one, is reached. */
  private full(): boolean { return this.options.maxParallel !== undefined && this.workers.size >= this.options.maxParallel; }
  /** Whether a conversation has work its worker would do now: a native fork, a switch or a queued Turn while it is open. */
  private runnable(id: SessionId): boolean {
    try {
      const state = this.load(id);
      if ((state.status !== "open" && !(state.status === "blocked" && this.recoverySwitch(state))) || this.closingSessions.has(id) || !this.accepting) return false;
      return state.pendingSwitchId !== null || state.runs.some(run => run.status === "queued") || (state.nativeBindings?.some(binding => binding.status === "fork-pending") ?? false);
    } catch { return true; }
  }
  /** When a conversation's oldest queued Turn was accepted; other work counts as last. */
  private headAccepted(id: SessionId): number {
    try { return this.load(id).runs.find(run => run.status === "queued")?.timing?.acceptedAt ?? Number.MAX_SAFE_INTEGER; } catch { return Number.MAX_SAFE_INTEGER; }
  }
  /**
   * Records once that a conversation's next Turn waits for a slot because the operator's limit on conversations running at once is
   * reached. It waits without a deadline of its own, and slots go to work in the order it was accepted.
   */
  private joinSlot(id: SessionId): void {
    const run = this.load(id).runs.find(item => item.status === "queued");
    if (this.waitingForSlot.get(id)?.runId !== run?.id) this.leaveSlot(id);
    if (run === undefined || this.waitingForSlot.has(id)) return;
    this.waitingForSlot.set(id, { runId: run.id, since: this.options.now().getTime() });
    this.commit(id, current => ({ next: current, events: [event("run.waiting", { runId: run.id, kind: "slot", running: this.workers.size })] }));
  }
  /** Ends a conversation's wait for a slot, recording how long it waited. */
  private leaveSlot(id: SessionId): void {
    const waiting = this.waitingForSlot.get(id);
    if (waiting === undefined) return;
    this.waitingForSlot.delete(id);
    const waitedMs = Math.max(0, this.options.now().getTime() - waiting.since);
    try { this.commit(id, current => ({ next: current, events: [event("run.waiting_ended", { runId: waiting.runId, kind: "slot", waitedMs })] })); } catch (error) { this.stalls(error, id); }
  }
  /**
   * Whether another conversation should go before this worker's next work, by acceptance (FIFO): one waiting for a slot while the
   * operator's limit on conversations running at once is reached.
   */
  private earlierWaiter(id: SessionId): boolean {
    if (!this.full()) return false;
    const mine = this.headAccepted(id);
    return [...this.work].some(other => other !== id && !this.workers.has(other) && this.headAccepted(other) < mine);
  }
  /** What a conversation's next Turn waits for, when the operator's limit on conversations running at once is reached: how many run and the limit. */
  slotWait(id: SessionId): { readonly runId: string; readonly running: number; readonly limit: number; readonly since: number } | null {
    const waiting = this.waitingForSlot.get(id);
    return waiting === undefined ? null : { runId: waiting.runId, running: this.workers.size, limit: this.options.maxParallel ?? this.workers.size, since: waiting.since };
  }
  /** One conversation's work in order: its native fork, then a switch or its next Turn, until none is left (ADR-036). */
  private async serve(id: SessionId): Promise<void> {
    for (;;) {
      this.work.delete(id);
      // Kept processes being closed go first, so a Turn or switch never meets a lease that is about to be released.
      await this.settleReleases();
      if (this.fatal) { this.work.clear(); return; }
      let state = this.load(id);
      if ((state.status !== "open" && !(state.status === "blocked" && this.recoverySwitch(state))) || this.closingSessions.has(id) || !this.accepting) return;
      try {
        // A branch's native fork runs before any of its inputs, in the same order as its Turns.
        if (state.nativeBindings?.some(binding => binding.status === "fork-pending")) { await this.forkNative(id); state = this.load(id); }
        if (state.pendingSwitchId !== null) {
          const pending = state.switches.find(sw => sw.id === state.pendingSwitchId)!;
          const beforeSwitch = state.runs.find(run => run.status === "queued" && run.userSeq < pending.requestedSeq);
          if (beforeSwitch) await this.execute(id, beforeSwitch.id);
          else await this.applySwitch(id, state.pendingSwitchId);
        }
        else {
          const queued = state.runs.find(run => run.status === "queued");
          if (queued) await this.execute(id, queued.id);
        }
      } catch (error) { if (!this.stalls(error, id) && !this.endRequest(id, error)) return; }
      const after = this.load(id);
      const more = after.status === "open" && (after.pendingSwitchId !== null || after.runs.some(run => run.status === "queued")) && !this.closingSessions.has(id) && this.accepting && !this.fatal;
      if (!more && !this.work.has(id)) return;
      // Another conversation that waited for this workspace, or for a slot, with earlier work goes first (FIFO by acceptance).
      if (this.earlierWaiter(id)) { this.work.add(id); return; }
    }
  }

  private owned(execution: ActiveExecution): Conversation {
    this.store.assertOwner(); execution.binding?.assertOwned();
    const state = this.load(execution.sessionId);
    if (this.actives.get(execution.sessionId) !== execution || state.activeRunId !== execution.runId) throw new SessionError("OWNERSHIP_LOST", "active Run ownership changed");
    const run = runIn(state, execution.runId);
    if (!run || run.epoch !== state.epoch || JSON.stringify(run.selection) !== JSON.stringify(state.selection))
      throw new SessionError("OWNERSHIP_LOST", "active Run epoch or selection no longer belongs to its Session");
    return state;
  }
  private continue(execution: ActiveExecution): ConversationRun {
    const state = this.owned(execution), run = runIn(state, execution.runId)!;
    if (this.fatal) throw this.fatal;
    if (run.cancelRequested || !this.accepting || this.closingSessions.has(state.id)) throw new SessionError("CANCELLED", "Run cancelled before dispatch");
    if (run.epoch !== state.epoch || JSON.stringify(run.selection) !== JSON.stringify(state.selection))
      throw new SessionError("OWNERSHIP_LOST", "Run selection changed after authorization");
    return run;
  }
  private stop(execution: ActiveExecution): void {
    // What the program streamed before the stop is committed first, so the stop request never precedes it in the log (ADR-047).
    this.flushStreamQuietly(execution);
    // A program that has not settled once the stop grace has passed is ended; its Turn is then unknown (ADR-036).
    if (execution.grace === null && !execution.backendSettled) {
      execution.grace = setTimeout(() => {
        if (execution.backendSettled || execution.binding === null) return;
        execution.earlyClose ??= execution.binding.close(); void execution.earlyClose.catch(() => {});
      }, this.options.stopGraceMs ?? STOP_GRACE_MS);
      execution.grace.unref?.();
    }
    if (execution.stop !== null) return;
    if (execution.backendSettled) {
      if (execution.binding) {
        execution.earlyClose ??= execution.binding.close();
        void execution.earlyClose.catch(() => {});
      }
      return;
    }
    if (execution.run) {
      execution.stop = (async () => {
        try {
          await execution.run!.requestStop();
          this.owned(execution);
          this.commit(execution.sessionId, state => ({ next: updatedRun(state, execution.runId, { stopRequested: true }),
            events: [event("run.stop_requested", { runId: execution.runId, backendSettled: execution.backendSettled })] }));
        } catch (error) {
          if (!execution.backendSettled) {
            execution.earlyClose ??= execution.binding?.close() ?? null;
            if (execution.earlyClose) await execution.earlyClose;
          }
          // The backend may settle before requestStop acquires its native identity. Settlement remains authoritative.
          if (!execution.backendSettled) throw error;
        }
      })();
      void execution.stop.catch(() => {});
    } else if (execution.binding) {
      execution.earlyClose ??= execution.binding.close();
      void execution.earlyClose.catch(() => {});
    }
  }

  /**
   * Starts the timer of the budget that applies now: the execution budget while the Turn works, the wait budget while it waits for the
   * user. Only an operator's budgets have one (none by default); a Turn without them is never stopped for its time.
   */
  private armBudget(execution: ActiveExecution): void {
    const clock = execution.clock;
    clock.budget?.(); clock.budget = null;
    const waiting = clock.waiting, left = waiting ? clock.waitLeftMs : clock.executionLeftMs;
    if (left === null) return;
    clock.budget = after(left, () => this.expire(execution, waiting ? "wait" : "execution"));
  }
  /** The mark of a Turn's working time at which its `n`-th "still working" hint is due: the configured marks, then again every last mark. */
  private hintMark(n: number): number {
    const marks = this.options.pacing?.hintsMs ?? WORKING_HINTS_MS;
    return n < marks.length ? marks[n]! : marks[marks.length - 1]! * (n - marks.length + 2);
  }
  /** Starts the timer of the Turn's next hint, if it works now: the clock does not run while it waits for the user. */
  private armHint(execution: ActiveExecution): void {
    const clock = execution.clock;
    clock.hint?.(); clock.hint = null;
    if (clock.waiting || execution.stopReason !== null || execution.backendSettled || (this.options.pacing?.hintsMs ?? WORKING_HINTS_MS).length === 0) return;
    const worked = clock.workedMs + (performance.now() - clock.since);
    clock.hint = after(this.hintMark(clock.hinted) - worked, () => this.workingHint(execution));
  }
  /**
   * A Turn has worked as long as a mark says: it gets a notice that it goes on (and for how long its Harness has been quiet, when it
   * has been for a while) and an event; nothing is stopped or asked. A Turn that is being stopped, waits for the user or ended gets none.
   */
  private workingHint(execution: ActiveExecution): void {
    const clock = execution.clock;
    clock.hint = null;
    if (clock.waiting || execution.stopReason !== null || execution.backendSettled || execution.stop !== null || execution.grace !== null || execution.earlyClose !== null || this.actives.get(execution.sessionId) !== execution) return;
    const mark = this.hintMark(clock.hinted), quiet = performance.now() - clock.lastEventAt, quietNote = quiet >= (this.options.pacing?.quietMs ?? QUIET_NOTE_MS);
    clock.hinted += 1;
    // Text streamed before the hint is committed first, so the hint never precedes it in the log (ADR-047).
    this.flushStreamQuietly(execution);
    // A hint that cannot be recorded (the store refused the rows) is not worth a failure; commit fails the Runtime itself when it must.
    try {
      this.placed(execution, hubNotice(workingNotice(mark, quietNote ? quiet : null), this.options.now().getTime()),
        [event("run.still_working", { runId: execution.runId, workedMs: mark, ...(quietNote ? { quietMs: Math.round(quiet) } : {}) })], { always: true });
    } catch { /* see above */ }
    this.armHint(execution);
  }
  /** The Turn waits for the user from now (if it did not already); returns how long it may still wait, or null when no wait budget was set. */
  private enterWait(execution: ActiveExecution, run: string): number | null {
    const clock = execution.clock, now = performance.now();
    if (clock.waiting) return clock.waitLeftMs === null ? null : Math.max(0, clock.waitLeftMs - (now - clock.since));
    const worked = now - clock.since;
    clock.workedMs += worked; if (clock.executionLeftMs !== null) clock.executionLeftMs -= worked;
    clock.waiting = true; clock.since = now;
    clock.hint?.(); clock.hint = null;
    if (execution.stopReason === null) this.armBudget(execution);
    this.commit(execution.sessionId, current => ({ next: current, events: [event("run.waiting", { runId: run, kind: "user" })] }));
    return clock.waitLeftMs === null ? null : Math.max(0, clock.waitLeftMs);
  }
  /** Back to work once no request of this Turn waits for the user any longer. */
  private leaveWait(execution: ActiveExecution): void {
    const clock = execution.clock;
    if (!clock.waiting || [...this.permissions.values()].some(value => value.execution === execution && !value.request.decided)) return;
    const now = performance.now(), waitedMs = now - clock.since;
    if (clock.waitLeftMs !== null) clock.waitLeftMs -= waitedMs;
    clock.waiting = false; clock.since = now;
    if (execution.stopReason === null && !execution.backendSettled) { this.armBudget(execution); this.armHint(execution); }
    try { this.commit(execution.sessionId, current => ({ next: current, events: [event("run.waiting_ended", { runId: execution.runId, kind: "user", waitedMs: Math.round(waitedMs) })] })); }
    catch (error) { this.stalls(error, execution.sessionId); }
  }
  /**
   * An operator's budget ran out (ADR-036): requests still waiting expire first (the program gets the stop's cancellation, never an
   * approval), the conversation says why, and the Turn is stopped with the normal stop chain.
   */
  private expire(execution: ActiveExecution, kind: "execution" | "wait"): void {
    if (execution.stopReason !== null || execution.backendSettled || this.actives.get(execution.sessionId) !== execution) return;
    execution.stopReason = kind === "wait" ? "WAIT_EXPIRED" : "RUN_TIMEOUT";
    execution.clock.hint?.(); execution.clock.hint = null;
    // Text streamed before the budget ran out is committed first, so the expiry never precedes it in the log (ADR-047).
    this.flushStreamQuietly(execution);
    try {
      const waiting = [...this.permissions.entries()].filter(([, value]) => value.execution === execution && value.option === null).map(([permissionId]) => permissionId);
      for (const permissionId of waiting) this.permissions.delete(permissionId);
      const budgetMs = (kind === "wait" ? this.options.waitBudgetMs : this.options.executionBudgetMs) ?? 0;
      // What waited for the user is closed in its items as timed out, and the conversation says why the Turn is stopped.
      const at = this.options.now().getTime();
      const closed = place(this.turnOf(execution), { kind: "expired", at });
      const said = place(closed.turn, hubNotice(budgetNotice(kind, budgetMs), at));
      this.commit(execution.sessionId, current => ({ next: withItems(current, execution.runId, itemsOf(said.turn)),
        events: [...waiting.map(permissionId => event("permission.closed", { permissionId, runId: execution.runId, reason: "expired" })), event("run.budget_expired", { runId: execution.runId, kind, budgetMs })], createdBy: () => 0 }));
      execution.turn = said.turn;
      // The wait ends with its requests, so it is recorded like any other end of a wait.
      this.leaveWait(execution);
    } catch (error) { this.stalls(error, execution.sessionId); }
    this.stop(execution);
  }

  /**
   * One native event of the Turn. Reply text and thinking are committed per window (ADR-047); everything else is committed
   * on arrival, after the window open before it, so the log keeps the order in which the program sent its events. A refused
   * commit is thrown to the driver, which ends the Turn with it.
   */
  private output(execution: ActiveExecution, value: ControlEvent): void {
    execution.clock.lastEventAt = performance.now();
    // A Driver that declares `live: "agent_output"` (dsh) proves a packet recorded by the Turn's first agent text, thinking or
    // tool call, never by a plan or usage (ADR-055 §7.1 weak E1, C8): E1 is committed before that output (R3).
    if (execution.relay.declaration.capabilities?.delivery.live === "agent_output" && execution.relay.turn.kind === "carry" && !execution.relay.recorded
        && ((value.type === "text" || value.type === "thinking") && value.text !== "" || value.type === "tool")) this.inputRecorded(execution, undefined, "agent_output");
    if (value.type === "text" || value.type === "thinking") { this.streamChunk(execution, value); return; }
    if (value.type === "input_recorded") { this.inputRecorded(execution, value.packetId, "recorded_event"); return; }
    this.flushStream(execution);
    const state = this.owned(execution), run = runIn(state, execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    if (VISIBLE_OUTPUT.has(value.type)) this.firstOutput(state, run);
    const at = this.options.now().getTime();
    if (value.type === "permission_requested") {
      // The Turn now waits for the user: its working time stops. A request expires only at the deadline its own Harness announced
      // (it withdraws the request itself then) or, when an operator set a wait budget, at the end of that budget: the earlier of the two (ADR-035).
      // With neither it waits for the user as long as it takes.
      const requestedAt = at, hubLeft = this.enterWait(execution, run.id), wait = value.expiresInMs;
      const native = value.expiresBy === "native" && wait !== undefined && Number.isSafeInteger(wait) && wait >= 0 ? wait : null;
      const expires = native !== null && (hubLeft === null || native <= Math.round(hubLeft)) ? { expiresAt: requestedAt + native, expiresBy: "native" as const }
        : hubLeft !== null ? { expiresAt: requestedAt + Math.round(hubLeft), expiresBy: "turn" as const } : {};
      const id = "permission-" + this.options.id(), request: PermissionRequest = { id, runId: run.id, title: value.title, options: value.options, ...(value.detail===undefined?{}:{detail:value.detail}),...(value.input===undefined?{}:{input:value.input}), decided: false, requestedAt, ...expires, ...(value.kind === "question" ? { kind: "question" as const } : {}) };
      this.permissions.set(id, { request, nativeId: value.id, execution, option: null, command: null, harnessId: run.selection.harnessId });
      // The request is an item that waits, written with the event that tells it.
      // What the request is about, as the Hub's policy tells it (read, edit, execute, …), kept with it as evidence of what was asked.
      const kind = this.policyFor(execution, run, value, undefined).kind;
      try { this.placed(execution, { kind: "event", event: value, at }, [event("permission.requested", { permissionId: id, runId: run.id, title: value.title, options: value.options, kind, ...expires })], { always: true }); } catch (error) { this.permissions.delete(id); throw error; }
      // The Hub's policy for the conversation's permission level answers what it can (permission-policy.ts); the rest waits for the user.
      void this.answerByPolicy(execution, id, run, value).catch(() => {}); return;
    }
    if (value.type === "permission") {
      // The Harness withdrew a question it had asked (for example its own dialog deadline): the public request closes too.
      const pending = [...this.permissions.entries()].find(([, item]) => item.execution === execution && item.nativeId === value.id && item.option === null);
      if (pending) {
        this.permissions.delete(pending[0]);
        this.placed(execution, { kind: "event", event: value, at }, [event("permission.closed", { permissionId: pending[0], runId: run.id, reason: value.decision })], { always: true });
        this.leaveWait(execution);
        return;
      }
    }
    if (value.type === "output") { this.nativeOutput(execution, run, value.output); return; }
    if (value.type === "tool") {
      // Every call is written, whatever their number; a report that only refines the private detail changes no row, so nothing is committed for it until the detail is stored.
      const placed = this.placed(execution, { kind: "event", event: value, at }, [event("run.output", { runId: run.id, event: logged(value) })]);
      for (const request of placed.store) this.storeDetail(execution, request);
      // A Harness that reads the record as files may read there what changed for its Turn (recordRead).
      this.recordRead(execution, value);
      return;
    }
    const events = [event("run.output", { runId: run.id, event: logged(value) })];
    if (value.type === "usage") {
      // The window a Harness reports is its own and its model's: remembered for the conversations in which it has not run yet (windows.ts resolveWindow).
      const size = value.usage.context?.size;
      if (typeof size === "number" && Number.isSafeInteger(size) && size > 0) this.windows.set(windowKey(run.selection), size);
      this.placed(execution, null, events, { always: true, patch: current => {
        const held = runIn(current, run.id)!;
        return updatedRun(current, run.id, { usage: { ...held.usage, ...(value.usage.turn === undefined ? {} : { turn: { ...held.usage?.turn, ...value.usage.turn } }), ...(value.usage.context === undefined ? {} : { context: value.usage.context }), ...(value.usage.cost === undefined ? {} : { cost: value.usage.cost }) } satisfies NativeUsage });
      } });
      return;
    }
    // The Harness compacted its own session while the Turn works: the state is owed to it again, with the answer of the next tool of the Hub's it calls (signalsFor),
    // or with its next Turn when it calls none. Its STATE.md is written again, for a Harness told to read it after it compacted.
    const compacted = value.type === "activity" && value.kind === "compaction" && value.status !== "failed";
    if (compacted) { execution.compacted = true; this.pinned.delete(execution.sessionId); }
    // A plan, a notice (one this conversation already showed is not shown again), an activity, a diagnostic: written as reported and logged.
    this.placed(execution, { kind: "event", event: value, at }, events, { always: true });
    if (compacted || value.type === "plan") this.refreshRecord(execution.sessionId);
  }
  /**
   * E1 (ADR-055 §7.1, §14.2): the native side recorded this Turn's input. For a Turn carrying a packet the text window open
   * before it is committed first, then one transaction records `relay.input_recorded`, the delivery decided recorded(E1) and
   * the binding's mark moved up to the packet's end, with the Run's recordedAt (never its first output). A Turn without a packet
   * records nothing. An entry the Driver saw with another packet, a second report, or one after the Turn stopped running decides
   * nothing. `live` is the evidence the event names: the Driver's own report of the entry (`recorded_event`), or the Turn's first
   * agent output (`agent_output`). An E1 the Store refuses (its relay rows, a binding that changed) is not recorded, nor tried
   * again in the Turn, and the settlement decides as without it; a Store that failed fails the Runtime as any commit does.
   */
  private inputRecorded(execution: ActiveExecution, packetId: RelayPacket["id"] | undefined, live: "recorded_event" | "agent_output"): void {
    const relay = execution.relay, turn = relay.turn;
    // Once per Turn: one the Store refused is not tried again at every later output.
    if (relay.recorded || relay.e1Refused || turn.kind !== "carry") return;
    if (packetId !== undefined && packetId !== turn.packet.id) return;
    this.flushStream(execution);
    const state = this.owned(execution), run = runIn(state, execution.runId)!;
    if (run.status !== "running") return;
    const recordedAt = this.options.now().getTime();
    const ownOf = (current: Conversation) => current.nativeBindings?.find(row => row.harnessId === run.selection.harnessId && row.controlId === run.selection.controlId && row.status !== "archived");
    if (ownOf(state)?.relay === undefined) return;
    let committed = false;
    try {
      this.commit(state.id, current => {
        const own = ownOf(current);
        if (own?.relay === undefined) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "the binding changed while E1 was recorded");
        const moved = recordedStep(own.relay, turn);
        let next = updatedRun(current, run.id, phase(current, run.id, "recordedAt", recordedAt));
        next = { ...next, nativeBindings: next.nativeBindings?.map(row => row === own ? { ...row, relay: moved } : row) ?? [] };
        return { next, events: [event("relay.input_recorded", { runId: run.id, packetId: turn.packet.id, recordedAt, mark: moved.mark, live })],
          relay: { deliveries: [{ kind: "outcome" as const, runId: run.id, outcome: { kind: "recorded" as const, evidence: "E1" as const, decidedSeq: current.lastSeq + 1, decidedAt: recordedAt } }] } };
      }, true);
      committed = true;
    } catch (error) {
      if (!this.relayRefusal(error)) { if (storeUntrusted(error)) this.fail(error, state.id); throw error; }
      relay.e1Refused = true;
    }
    if (committed) relay.recorded = true;
  }
  /** Records the Run's first visible output at the clock's reading now, once, as its own committed fact (never held in a window). */
  private firstOutput(state: Conversation, run: ConversationRun): void {
    if (run.timing === undefined || run.timing.firstOutputAt !== undefined) return;
    this.commit(state.id, current => ({ next: updatedRun(current, run.id, phase(current, run.id, "firstOutputAt", this.options.now().getTime())), events: [event("run.first_output", { runId: run.id })] }));
  }
  /**
   * A chunk of reply text or thinking joins the window open for its kind, or opens one (ADR-047); a window of the other
   * kind is committed first, so the log keeps their order. A window is committed when its timer runs out, when it holds
   * STREAM_WINDOW_BYTES, and before anything else of the Turn is committed. Ownership, the Run's status and its first output
   * are checked when a window opens, so at least once per window. A reply or a thought has no length it may not pass (ADR-057 3.7): what the Harness says is
   * kept, a window at a time, each committed by its size or its timer; the bytes counted here are the open window's.
   */
  private streamChunk(execution: ActiveExecution, value: Extract<ControlEvent, { type: "text" | "thinking" }>): void {
    const stream = execution.stream;
    if (stream.kind !== null && stream.kind !== value.type) this.flushStream(execution);
    let { bytes, last } = stream;
    if (stream.kind === null) {
      // A window opens on the Run's facts as committed: ownership, status, first output, and the bytes of its kind so far.
      const state = this.owned(execution), run = runIn(state, execution.runId)!;
      if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
      this.firstOutput(state, run);
      bytes = 0; last = "";
    }
    const joined = joinedBytes(bytes, last, value.text);
    if (stream.kind === null) { stream.kind = value.type; stream.text = ""; stream.at = this.options.now().getTime(); }
    stream.text += value.text; stream.bytes = joined; stream.last = value.text ? value.text.slice(-1) : last;
    if (stream.bytes >= STREAM_WINDOW_BYTES) { this.flushStream(execution); return; }
    stream.cancel ??= this.timer(() => this.windowExpired(execution), STREAM_WINDOW_MS);
  }
  /**
   * Commits the open window as one run.output event of its kind, with the window's text (ADR-047); no open window is nothing
   * to do. The window is taken before the commit, so a refused commit loses that window only and never commits it twice;
   * ownership and the Run's running status are checked as for any output. The window is one chunk of the segment it belongs to (or the first of a new
   * one), written among the Turn's items in the order it arrived.
   */
  private flushStream(execution: ActiveExecution): void {
    const stream = execution.stream;
    if (stream.kind === null) return;
    const kind = stream.kind, text = stream.text, since = stream.at;
    this.discardStream(execution);
    const state = this.owned(execution), run = runIn(state, execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    const taken = place(this.turnOf(execution), { kind: "event", event: { type: kind, text }, at: since }), flushed = place(taken.turn, { kind: "flush", at: this.options.now().getTime() });
    const rows = wroteRows(taken.changes) || wroteRows(flushed.changes);
    this.commit(state.id, current => ({ next: rows ? withItems(current, run.id, itemsOf(flushed.turn)) : current, events: [event("run.output", { runId: run.id, event: { type: kind, text } })], createdBy: () => 0 }));
    execution.turn = flushed.turn;
  }
  /**
   * Commits the open window from outside a driver callback (its timer, a stop, a close): a refused commit is kept as the
   * Turn's failure instead of being thrown where nothing reports it. Whether the window was committed, or there was none.
   */
  private flushStreamQuietly(execution: ActiveExecution): boolean {
    try { this.flushStream(execution); return true; }
    catch (error) { execution.streamFailure ??= error; return false; }
  }
  /** Drops the open window and its timer; what it held is the caller's to commit or to lose with the Turn. */
  private discardStream(execution: ActiveExecution): void {
    const stream = execution.stream;
    stream.cancel?.(); stream.cancel = null; stream.kind = null; stream.text = "";
  }
  /** The window's timer ran out: a Turn that has ended holds nothing; a window refused here stops the Turn with its failure. */
  private windowExpired(execution: ActiveExecution): void {
    execution.stream.cancel = null;
    if (this.actives.get(execution.sessionId) !== execution) return;
    if (!this.flushStreamQuietly(execution)) this.stop(execution);
  }
  /** Runs `fn` once after `ms` through the injected scheduler, or a setTimeout kept from holding the process open; returns its cancel. */
  private timer(fn: () => void, ms: number): () => void {
    if (this.options.schedule !== undefined) return this.options.schedule(fn, ms);
    const handle = setTimeout(fn, ms); handle.unref?.();
    return () => clearTimeout(handle);
  }
  /**
   * Stores one call's detail whole, of any size (what the Harness reported of its input, output and changes), written in pieces as they are made, and writes its reference in the
   * call's item. When it cannot be kept (the disk is full, a write failed) the call's item says so (`DETAIL_NOT_SAVED` in its `native.clipped`, which the readers show) and the
   * log says why: the loss is told in the conversation, never only in the log.
   */
  private storeDetail(execution: ActiveExecution, request: StoreRequest): void {
    const content = this.options.content; if (content === undefined) return;
    this.enqueue(execution, async () => {
      const state = this.owned(execution);
      let ref;
      try { ref = await content.storeOutput({ workspace: state.configuration.workspace, name: "tool-" + safeName(request.toolId) + ".json", mediaType: "application/json", data: detailJson(request.toolId, request.detail) }); }
      catch (error) {
        this.owned(execution);
        this.placed(execution, { kind: "detail_lost", toolId: request.toolId, at: this.options.now().getTime() },
          [event("run.output", { runId: execution.runId, event: { type: "diagnostic", message: "tool detail was not stored (" + fault(error).code + ")" } })], { always: true });
        return;
      }
      this.owned(execution);
      this.placed(execution, { kind: "detail", toolId: request.toolId, ref, at: this.options.now().getTime() }, [event("run.tool_detail", { runId: execution.runId, toolId: request.toolId, content: ref })]);
    });
  }
  /** Non-text native output: links are recorded as given; bytes go to the content owner first. */
  private nativeOutput(execution: ActiveExecution, run: ConversationRun, output: Extract<ControlEvent, { type: "output" }>["output"]): void {
    const at = this.options.now().getTime();
    if (output.kind === "link") {
      this.placed(execution, { kind: "event", event: { type: "output", output }, at }, [event("run.output", { runId: run.id, event: logged({ type: "output", output }) })], { always: true });
      return;
    }
    const content = this.options.content;
    if (content === undefined) { this.commit(execution.sessionId, current => ({ next: current, events: [event("run.output", { runId: run.id, event: { type: "diagnostic", message: "native " + output.mediaType + " output was not kept (no content storage)" } })] })); return; }
    this.enqueue(execution, async () => {
      const state = this.owned(execution);
      let ref;
      try { ref = await content.storeOutput({ workspace: state.configuration.workspace, name: output.name, mediaType: output.mediaType, data: output.data }); }
      catch (error) { this.commit(state.id, current => ({ next: current, events: [event("run.output", { runId: run.id, event: { type: "diagnostic", message: "native output was not stored (" + fault(error).code + ")" } })] })); return; }
      this.owned(execution);
      this.placed(execution, { kind: "event", event: { type: "output", output }, at: this.options.now().getTime(), stored: ref }, [event("run.output", { runId: run.id, event: logged({ type: "output", output }) })], { always: true });
    });
  }
  /** Keeps the write chain alive; an ownership or Store failure is retained for the Turn owner to report. */
  private enqueue(execution: ActiveExecution, job: () => Promise<void>): void {
    execution.writes = execution.writes.then(job).catch((error: unknown) => { execution.writeFailure ??= error; });
  }
  /** Drains this Turn's content writes while its binding is still owned; called before cleanup. */
  private async flushNative(execution: ActiveExecution): Promise<void> {
    // The details of calls that never ended wait for the Turn's settlement, which comes after the program is closed: they are taken now, while it is still owned.
    if (execution.turn !== null) { const taken = takeDetails(execution.turn); execution.turn = taken.turn; for (const request of taken.store) this.storeDetail(execution, request); }
    await execution.writes;
    if (execution.writeFailure !== null) throw execution.writeFailure;
  }

  /** A checkpoint of a Turn's workspace (contracts/workspace.ts): it never fails the Turn, whatever the port does; nothing without the port. */
  private checkpoint(workspace: string, id: SessionId, ordinal: number, side: "before" | "after"): Promise<void> {
    const port = this.options.checkpoints;
    if (port === undefined) return Promise.resolve();
    try { return port.capture(workspace, id, ordinal, side).catch(() => undefined); } catch { return Promise.resolve(); }
  }

  private async execute(id: SessionId, target: PublicRun["id"]): Promise<void> {
    const state = this.load(id), queued = state.runs.find(run => run.id === target);
    if (!queued || queued.status !== "queued") return;
    const waitedSwitch = queued.awaitingSwitchId === null ? null : state.switches.find(sw => sw.id === queued.awaitingSwitchId);
    if (queued.awaitingSwitchId !== null && !waitedSwitch) throw new SessionError("INVALID_DATA", "queued Run refers to an unknown switch");
    if (waitedSwitch?.status === "failed") {
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE", message: "requested Harness switch failed; this input was not dispatched" }, ...phase(current, target, "endedAt", this.options.now().getTime()) }),
        events: [event("run.ended", { runId: target, status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE" }, neverDispatched: true })] }));
      return;
    }
    if (waitedSwitch && waitedSwitch.status !== "effective") return;
    const pinned = waitedSwitch?.target ?? queued.selection;
    const execution: ActiveExecution = { sessionId: id, runId: target, binding: null, run: null, dispatched: false,
      backendSettled: false, stop: null, earlyClose: null, turn: null, writes: Promise.resolve(), writeFailure: null, diagnosticMark: null,
      clock: { workedMs: 0, since: performance.now(), waiting: false, executionLeftMs: this.options.executionBudgetMs ?? null, waitLeftMs: this.options.waitBudgetMs ?? null, budget: null, hint: null, hinted: 0, lastEventAt: performance.now() },
      stopReason: null, grace: null,
      stream: { kind: null, text: "", bytes: 0, last: "", at: 0, cancel: null }, streamFailure: null,
      relay: { declaration: relayDeclaration(null), turn: { kind: "none" }, recorded: false, e1Refused: false } };
    if (this.actives.has(id)) throw new SessionError("OWNERSHIP_LOST", "another Turn of this conversation is active");
    this.actives.set(id, execution);
    // The Hub's own record of the workspace's changes, begun with the Turn and made at its end (workspace-record.ts).
    const watch = this.options.workspace?.begin(state.configuration.workspace) ?? null;
    // The workspace as it is before the Turn (2026-11-14), taken while the Turn is prepared; its prompt waits for it, five seconds at most from here.
    const before = this.checkpoint(state.configuration.workspace, id, queued.ordinal, "before");
    // The Turn's clock runs from here: starting the program, its model, tools and result. An operator's execution budget, when there is
    // one, and the hints that a Turn goes on are both counted from it (ADR-036, superseded 2026-11-12: no budget unless set).
    this.armBudget(execution); this.armHint(execution);
    let backend: BackendResult | null = null, cleanup: CleanupEvidence | null = null, problem: ReturnType<typeof fault> | null = null;
    let checkpoint: string | null = null, checkpointStored = false, nativeConfirmed = false;
    let previousNative: NativeSessionBinding | undefined;
    // What the native session reported after this Turn; `reported` means the binding's earlier report is replaced (ADR-028).
    let observed: NativeConfiguration | undefined, reported = false;
    // The process the conversation kept and this Turn reuses (ADR-030); null when the Turn starts the program itself.
    let reusing: KeptProcess | null = null, opened: NativeConversationId | null = null;
    // The native reading of the input when it is a command, and what the driver knew of the input reaching the native history
    // and of the native history being cleared (kept here only; the snapshot never stores them, ADR-055 §7.1).
    let command: Extract<CommandClass, { kind: "command" }> | null = null;
    let evidence: "recorded" | "not_recorded" | null = null, noop = false, nativeCleared: BackendResult["native"] | undefined;
    // The reason of a relay failure before dispatch (RELAY_PREPARE_FAILED, for what the user asked to attach), for the Turn's end.
    let relayReason: string | null = null;
    // Whether this Turn opened a native session anew (no checkpoint: a new binding, opensNew, or C5's replacement); such a session
    // was never prompted, so a Turn that ends before dispatching into it keeps the binding opening a new one (G068 fix batch 2,
    // I-1a). C5 (I-1b): the checkpoint the Driver refused as a session it does not have, and how its connection was closed.
    let openedNew = false, replacedEmpty: string | null = null, refusedCleanup: CleanupEvidence | null = null;
    // Why the Hub opened this Turn's native session in the place of the one it would have resumed (Reseat), when it did.
    let reseated: Reseat["reason"] | null = null;
    // What the packet's cap is scaled by in a session opened after a handed conversation overflowed (Reseat `overflow`); 1 otherwise.
    let shrink = 1;
    try {
      // Conversations that came to this workspace before this one and still work in it: this Turn does not wait for them, it says they are there.
      const company = this.coworkers(id, state.configuration.workspace);
      // The Turn is opened from the Run's own items (its input), and a conversation working in the same directory is told as a notice among them.
      this.placed(execution, company.length === 0 ? null : hubNotice(sharedNotice(company.length), this.options.now().getTime()),
        [event("run.preparing", { runId: target, selection: state.selection, epoch: state.epoch }), ...(company.length === 0 ? [] : [event("run.workspace_shared", { runId: target, otherSessionIds: company })])],
        { always: true, patch: current => ({ ...updatedRun(current, target, { status: "preparing", selection: pinned, epoch: waitedSwitch ? current.epoch : queued.epoch, ...phase(current, target, "preparingAt", this.options.now().getTime()) }), activeRunId: target }) });
      let current = this.owned(execution);
      const run = this.continue(execution), typed = inputOf(run);
      previousNative = run.selection.provider === undefined ? current.nativeBindings?.find(binding => binding.harnessId === run.selection.harnessId && binding.controlId === run.selection.controlId && binding.status !== "archived") : undefined;
      if (previousNative !== undefined && previousNative.status !== "ready") throw new SessionError("NATIVE_STATE_UNCONFIRMED", "原生会话状态尚未确认；可以切换其他 Harness，或明确建立新的原生分支。公共历史会保留。");
      // A new native session in the place of the one this Turn would have resumed (Reseat): the Hub archives the binding as it is — nothing of the conversation is given
      // up, so the clear floor stays — and the binding that takes its place opens a new native session, which holds nothing: the Turn then carries the conversation to it
      // as to any Harness that was not in it, with the task's state, and the rest is in the record.
      const reseat = (old: NativeSessionBinding, why: Reseat): void => {
        const h = old.harnessId, c = old.controlId, relay = step(old.relay!, { kind: "reseated" });
        const successor: NativeSessionBinding = { harnessId: h, controlId: c, checkpoint: old.checkpoint, throughRunId: null, status: "ready", ...(old.observed === undefined ? {} : { observed: old.observed }), relay, opensNew: true };
        const title = why.reason === "full" ? "上下文用到 " + Math.min(100, Math.round(100 * why.used / why.size)) + "%，换到新的原生会话接着做"
          : why.reason === "overflow" ? (why.shrink < 1 ? "上一轮带着之前的对话还是超出了上下文窗口，换到新的原生会话、少带一些接着做" : "上一轮超出了上下文窗口，换到新的原生会话接着做")
          : "原来的原生会话找不回来了，换到新的原生会话接着做";
        this.placed(execution, { kind: "notice", severity: "info", title, code: "NATIVE_RESEATED", at: this.options.now().getTime() },
          [event("native.binding_reseated", { runId: target, harnessId: h, controlId: c, reason: why.reason, ...(why.reason === "full" ? { used: why.used, size: why.size } : {}),
            ...(why.reason === "overflow" ? { shrink: why.shrink } : {}), nativeEpoch: relay.epoch, floor: relay.floor })],
          { always: true, patch: latest => ({ ...latest, nativeBindings: [...(latest.nativeBindings ?? []).map(binding => binding.harnessId === h && binding.controlId === c && binding.status !== "archived" ? { ...binding, status: "archived" as const } : binding), successor] }) });
        current = this.owned(execution);
        previousNative = current.nativeBindings?.find(binding => binding.harnessId === h && binding.controlId === c && binding.status !== "archived");
        reseated = why.reason;
        shrink = why.reason === "overflow" ? why.shrink : 1;
      };
      // Known before the program starts: the last Turn in it failed over the model's window, or it is as full as an operator's level. A process the conversation kept
      // holds the old session and is closed first.
      const known = previousNative === undefined ? null : this.reseatCause(current, run, previousNative, typed);
      if (known !== null && previousNative !== undefined) {
        if (this.kept.has(id)) { await this.release(id, "native_reseated"); this.continue(execution); }
        reseat(previousNative, known);
      }
      // A process the conversation kept takes the Turn when it still runs this selection; any other kept process is closed first
      // and the Turn starts the program as usual (ADR-030).
      reusing = run.selection.provider === undefined ? await this.takeKept(id, run.selection) : null;
      let native: NativeConversationId | null = null;
      if (reusing !== null) {
        const kept = reusing, now = this.options.now().getTime();
        execution.binding = kept.binding; native = kept.conversation; execution.diagnosticMark = kept.binding.control.diagnosticMark?.() ?? null;
        this.commit(id, current => {
          const { retained, ...rest } = current;
          return { next: updatedRun(rest, target, { reused: true }), events: [event("native.process_reused", { runId: target, previousRunId: kept.runId, idleMs: Math.max(0, now - kept.lastUsed), backgroundUpdates: this.background(kept) })] };
        });
        this.continue(execution);
      } else await this.startProgram(execution, run, current, id, target);
      let control = execution.binding!.control;
      const declaration = execution.relay.declaration = relayDeclaration(control.relayCapabilities);
      const kinds = run.attachments?.map(file => file.kind) ?? [], reading = this.classify(control, typed, null, kinds);
      // The relay packet (ADR-055 §5): what this binding's program and this Gateway hold as secrets never leaves in it, and an
      // input read as a possible command never opens it, so the packet cannot become a command's argument.
      // The secrets are the whole Session's (M1): the target binding's own, and those of every Harness whose history it carries.
      // They and the tool details are read only for a Turn that builds a packet (N3): a command reads nothing for one, and a
      // configuration that cannot be read fails only a Turn that would carry history.
      const relayFor = async (history: RelayHistory, configuration: SessionConfiguration, sources: readonly PublicRun["id"][], origin: boolean): Promise<PublicContextOptions> => {
        const details = await this.relayDetails(history, sources), secrets = [...(execution.binding?.secrets ?? []), ...await this.relaySecretsOf(history, configuration, run, sources, origin)];
        this.continue(execution);
        // The binding says whether its process has the Hub's tools (it was started with the table's environment and its Harness holds the tool entry): a fact of this Turn's process, which the packet may then repeat.
        return { origin, secrets, firstLine: reading.kind === "content", details, hubTools: toolsUsable(), ...(execution.binding?.hubCommand === undefined ? {} : { hubCommand: execution.binding.hubCommand }), ...(recordAt() === null ? {} : { contextFiles: recordAt()!.dir + "/" + recordAt()!.self }), ...(this.options.harnessName === undefined ? {} : { names: this.options.harnessName }) };
      };
      // Where this Turn's Harness reads the record as files, when it does.
      const recordAt = () => this.recordPlace(id, execution.binding);
      // Whether this Turn's Harness can call the Hub's tools: its process has them, and where they are a command of the conversation the level lets it run one
      // (a Harness in its read-only mode refuses every command, the Hub's with them: nothing is then promised to be read back, and nothing is held back for it).
      const toolsUsable = (): boolean => execution.binding?.hubTools === true && !(execution.binding.hubCommand !== undefined && selectedPermission(run.selection.nativeOptions) === "plan");
      if (native === null) {
        const observation = await control.initialize(); this.continue(execution);
        this.commit(id, current => ({ next: current, events: [event("run.protocol", { runId: target, observation })] }));
        // A requested value the native session changed itself is applied as it is now instead of being reverted (ADR-028).
        const carriedConfiguration = carriedNativeConfiguration(current, run.selection, run.epoch);
        if (carriedConfiguration !== null) this.commit(id, current => ({ next: current, events: [event("native.config_carried", { runId: target, ...carriedConfiguration })] }));
        // The Hub's own keys (the permission level, contracts/flavor.ts) are the Hub's: the Driver is given its native values only.
        const nativeOptions = nativeOnly(carriedConfiguration?.options === undefined ? run.selection.nativeOptions : { ...run.selection.nativeOptions, ...carriedConfiguration.options });
        // A binding whose native session the Driver gave up on a clear (opensNew, R4) opens a new one: its checkpoint names the
        // abandoned session, never resumed.
        const resumeFrom = previousNative?.opensNew === true ? undefined : previousNative?.checkpoint;
        const open = (on: HarnessControl, from: string | undefined) => {
          on.setSessionInstructions?.(this.sessionInstructions(execution.binding, id));
          return on.open(execution.binding!.workspace, carriedConfiguration?.model ?? run.selection.nativeModel, nativeOptions, from);
        };
        try { native = await open(control, resumeFrom); }
        catch (error) {
          // C5 (ADR-055 §7.5; G068 fix batch 2, I-1b): a native session that holds nothing the relay counts on (one opened
          // and never prompted) that the Driver refuses as one it does not have — that refusal
          // only, never a timeout or a failed connection — is replaced by a new one, its relay state and floor as they are, on a
          // new connection: the refused one may be failed by the refusal. A binding with a watermark is never replaced.
          if (resumeFrom === undefined || previousNative === undefined || fault(error).code !== "NATIVE_SESSION_NOT_FOUND") throw error;
          if (holdsNothing(current, previousNative)) {
            ({ control, closed: refusedCleanup } = await this.restartProgram(execution, run, current, id, target, error));
            native = await open(control, undefined);
            replacedEmpty = resumeFrom;
          } else {
            // A native session that held part of the conversation and that its Harness does not have any more (Reseat `lost`, 2026-11-13): the Turn failed here before.
            // A new one takes its place and is handed the conversation; the refusal stands where it would be handed nothing.
            if (!this.mayReseat(current, run, previousNative, typed)) throw error;
            ({ control } = await this.restartProgram(execution, run, current, id, target, error));
            reseat(previousNative, { reason: "lost" });
            native = await open(control, undefined);
          }
        }
        openedNew = resumeFrom === undefined || replacedEmpty !== null || reseated === "lost";
        this.continue(execution);
      }
      opened = native;
      // The Session as the binding's preparation committed it: what the relay reads below (the binding's relay state, the facts).
      let prepared: Conversation = current;
      if (run.selection.provider === undefined && control.checkpoint) {
        checkpoint = await control.checkpoint(); this.continue(execution);
        if (checkpoint !== null && (typeof checkpoint !== "string" || !checkpoint || Buffer.byteLength(checkpoint) > 8192 || /[\0\r\n]/u.test(checkpoint))) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "invalid original Harness recovery reference");
        if (previousNative !== undefined && checkpoint === null) throw new SessionError("NATIVE_RESUME_UNAVAILABLE", "original Harness cannot confirm its recovered state; no replacement session was dispatched");
        if (checkpoint !== null) {
          // C5's new native session holds nothing yet: no native position (I-1b).
          const reference: NativeSessionBinding = { harnessId: run.selection.harnessId, controlId: run.selection.controlId, checkpoint, throughRunId: replacedEmpty !== null ? null : previousNative?.throughRunId ?? null, status: "unconfirmed",
            ...(previousNative?.observed === undefined ? {} : { observed: previousNative.observed }) };
          prepared = this.commit(id, current => {
            // Every v13 binding carries its relay state, merged on what is committed now (ADR-055 §6.1): a resumed one keeps its
            // own, C5's replacement included; a new one starts as its lineage says (ADR-055 §7.5). A relay recovery failure stays
            // (§9 S15): it names no binding a new one replaces (G068 fix batch 2, M-5).
            const kept = current.nativeBindings?.find(binding => binding.harnessId === reference.harnessId && binding.controlId === reference.controlId && binding.status !== "archived");
            const bound: NativeSessionBinding = { ...reference, relay: previousNative === undefined ? initialBindingRelay(current.nativeBindings ?? [], reference.harnessId, reference.controlId, "new") : kept?.relay ?? previousNative.relay! };
            return { next: { ...current, nativeBindings: previousNative === undefined ? [...(current.nativeBindings ?? []), bound] : current.nativeBindings?.map(binding => binding.harnessId === bound.harnessId && binding.controlId === bound.controlId && binding.status !== "archived" ? bound : binding) ?? [bound] },
              // `resumed` says whether the binding existed (storage-events.md: each `resumed:false` makes a binding, as the v12
              // migration reads it); a binding that opened a new native session (opensNew, C5) says so apart (G068 fix batch 2).
              events: [event("native.binding_prepared", { runId: target, harnessId: reference.harnessId, controlId: reference.controlId, resumed: previousNative !== undefined,
                ...(previousNative !== undefined && openedNew ? { nativeSession: "new" } : {}) }),
                ...(replacedEmpty === null ? [] : [event("native.binding_replaced", { runId: target, harnessId: reference.harnessId, controlId: reference.controlId, reason: "empty_session_unresumable",
                  nativeEpoch: bound.relay!.epoch, floor: bound.relay!.floor, ...(refusedCleanup === null ? {} : { cleanup: refusedCleanup }) })])] };
          }).conversation;
          checkpointStored = true;
        }
      }
      // Before authorization the native reading decides whether the input is a command (ADR-055 R0b): a command goes as
      // typed and carries nothing, whatever it owes. A reading that is or may be a command is settled against the catalog
      // (its effect, and the commands the driver itself offers there).
      let classified = reading;
      if (classified.kind !== "content" && control.models) { const catalog = await control.models(); this.continue(execution); classified = this.classify(control, typed, catalog, kinds); }
      // A Driver that declares nothing and reads nothing of its own cannot say what its native side takes for a command: a slash
      // first is one of unknown effect, whatever its catalog lists or whether it has one (G072 review I3).
      if (classified.kind !== "command" && control.relayCapabilities === undefined && control.classify === undefined && run.selection.provider === undefined) classified = undeclaredReading(typed) ?? classified;
      // A command whose arguments the native side submits as a prompt (acceptsRelay: Codex `/skill:…`, Hermes `/queue`, `/steer`)
      // is a content Turn to the relay: it may carry a packet, which its Driver places.
      if (classified.kind === "command" && classified.acceptsRelay !== true) {
        const named = classified; command = named;
        // The Run is a native command (not the same as having an effect), and the effect it was read with is on its row: the relay's facts read them there.
        prepared = this.commit(id, current => ({ next: updatedRun(current, target, { isCommand: true, commandEffect: named.effect }), events: [event("run.native_command", { runId: target, name: named.name, publicContextInjected: false, contextEffect: named.effect })] })).conversation;
      }
      // What the Turn sends (ADR-055 §7.2, slim.md): a command goes as typed and carries nothing, whatever it owes; a content input
      // goes as typed when nothing is owed, alone when the user chose so, or with a packet of what is owed (a pending packet sent
      // again once, everything again after a rewind, the whole history when the user attached it).
      const h = run.selection.harnessId, c = run.selection.controlId;
      const bound = checkpointStored ? prepared.nativeBindings?.find(row => row.harnessId === h && row.controlId === c && row.status !== "archived" && row.relay !== undefined) : undefined;
      const now = () => this.options.now().getTime();
      // The relay choice the input was accepted with.
      const requested: RelayChoices = command === null ? this.choicesOf(prepared, run) : {};
      let decision: TurnDecision | null = null, working: BindingRelayState | null = bound?.relay ?? null;
      // What the preparation of the packet found: the window it was budgeted against, the secrets it was redacted with, the handoff log row.
      let window: ResolvedWindow | null = null, clamped: readonly ("window" | "input_limit")[] = [], packetSecrets: readonly string[] = [], handoff: { readonly logSeq: number; readonly first: boolean } | null = null;
      // Sends the Turn as typed instead of with its packet, for a reason that concerns the packet only (set where the decision is made).
      let aloneInstead: ((found: NonNullable<ReturnType<typeof policyAloneOf>>) => void) | null = null;
      let turnText: TurnText = typed, packet: { readonly manifest: RelayPacket; readonly body: string; readonly record: PublicContext["relay"]; readonly runs: readonly PublicRun["id"][] } | null = null;
      if (command === null) {
        const originHistory = this.quotedHistory(prepared);
        // A Driver that keeps no native session (no binding) is owed everything every Turn.
        working ??= initialBindingRelay(prepared.nativeBindings ?? [], h, c, "new");
        const facts = this.relayFacts(prepared, { harnessId: h, controlId: c, nativeEpoch: working.epoch });
        const planned = plan(working, { harnessId: h, controlId: c, facts, originHistory, canConfirm: declaration.canConfirm, ...(requested.attach === undefined ? {} : { attach: requested.attach }) });
        // The installation's setting: with "off" a switch hands nothing over by itself (only the user's own attach does). Read only where it matters.
        decision = planned.kind === "carry" && planned.by !== "user" && this.settings().attach === "off" ? { kind: "alone", by: "user" } : planned;
        // The relay's record could not be recovered after a restart: nothing it keeps can be carried; the policy sends the input alone.
        if (decision.kind === "carry" && prepared.relayRecoveryFailed !== undefined) {
          if (requested.attach === "full") throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "recovery_failed" }, "服务重启时没能恢复这个对话的交接记录，暂时不能附带交接内容；这条消息没有发出，草稿已保留。可以只发这条消息，或新开原生会话。", { harnessId: h, controlId: c });
          decision = aloneFor("recovery_failed");
        }
        // What the preparation of the packet found that concerns the packet only: the input goes as typed.
        const asAlone = (found: NonNullable<ReturnType<typeof policyAloneOf>>): void => {
          decision = aloneFor(found.cause, found.reason);
          window = null; clamped = []; packet = null; turnText = typed; packetSecrets = []; handoff = null;
        };
        aloneInstead = asAlone;
        if (decision.kind === "carry") {
          const carrying = decision;
          try {
            // What a packet is made of is the earlier Turns' words, which the rows hold: the renderer reads the Runs' light rows and, of the Turns the binding is owed, the words, a Turn at a time.
            const fresh = this.load(id), history = rowsHistory(fresh, this.store), asked = history.turn(fresh.runs.findIndex(row => row.id === target))!.run;
            const runs = needRuns(history, asked, carrying.need);
            // The window the packet is budgeted against, and what the channel leaves it. The history is left out whole to fit; the renderer
            // never fails, and when even its least packet is over the cap (below) the input goes as typed.
            const resolved = resolveWindow(history, asked, this.windows.get(windowKey(run.selection)) ?? null), limit = declaration.capabilities?.placement.maxInput ?? null, size = declaration.capabilities?.placement.measure(typed, kinds) ?? [...typed].length;
            // A session opened at an operator's level is handed half of that level (Reseat's account), not half of the window.
            const level = reseated === "full" ? this.reseatAt() : null;
            // One opened after a handed conversation overflowed is handed less again (Reseat `overflow`): the estimate a packet is sized by may be off by half again.
            const cap = Math.floor(shrink * Math.min(hardCap(resolved, estimateTokens(typed), limit, size), level === null ? Number.POSITIVE_INFINITY : Math.floor(level * resolved.size / 2)));
            // Delegated work is handed the history as any handoff is (2026-11-13: a tighter budget for it was taken out the day it was put in; what it saved was little,
            // and a Harness that has to fetch what it was not given is slower and less sure than one that was given it).
            const budget: RelayBudget = packetBudget(resolved, cap), standard = packetBudget(resolved, Number.POSITIVE_INFINITY);
            window = resolved;
            if (budget.cap < standard.cap) clamped = [limit !== null && hardCap(resolved, estimateTokens(typed), null, size) >= standard.cap ? "input_limit" : "window"];
            // The renderer sees the binding as a native session that holds nothing when the packet must be a whole one: it carries
            // everything again, or the native session holds no part of the conversation (no mark).
            const options = await relayFor(history, fresh.configuration, runs, carrying.need.origin);
            packetSecrets = options.secrets ?? [];
            // Work handed over starts as a fork (2026-11-13): it is told what the user said in the conversation it came from, and reads what was done there from the record —
            // when its Harness can read the record. One that cannot is handed the history as any other is.
            const forked = fresh.delegation !== undefined && fresh.runs[0]?.id === target && toolsUsable();
            const context = buildPublicContext(renderView(history, h, c, carrying.whole || working.mark < 0), asked, runs, { ...options, budget, ...(carrying.repeat ? { repeat: true } : {}), ...(forked ? { wordsOnly: true } : {}) });
            this.continue(execution);
            // The least packet there is (the title line, the sentences, the ledger, the end line) is over the cap: the history cannot be carried at all.
            if (context.relay.tokens > context.relay.budget.cap) throw inputLimit(run.selection);
            if (!context.text.endsWith("\n" + typed)) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render" }, "没能准备交接单：交接单与这条消息拼接不一致，这条消息没有发出。");
            const body = context.text.slice(0, context.text.length - typed.length - 1), range = rangeOf(history, carrying.need, runs);
            const manifest = packetManifest({ state: history, run: asked, relay: working, record: context.relay, body, range, runs, attachOverride: carrying.by === "user",
              supersedes: carrying.resend !== null && working.pending !== null ? working.pending.packetId : null,
              firstLineOmitted: context.relay.firstLine ? null : reading.kind === "content" ? "secret_hit" : "slash", clamped });
            packet = { manifest, body, record: context.relay, runs };
            turnText = { user: typed, relay: { packetId: manifest.id, body, firstLine: context.relay.firstLine } };
            // The placed Turn measured as its Driver will place it; over the Driver's bound it goes as typed, the Driver's own refusal staying the backstop.
            if (limit !== null && declaration.capabilities!.placement.measure(turnText, kinds) > limit.limit) throw inputLimit(run.selection);
          } catch (error) {
            const found = policyAloneOf(error, requested);
            if (found === null) throw error;
            asAlone(found);
          }
        }
      }
      // One transaction (ADR-055 §6.1): the packet and its delivery row, the Run's relay, run.context_prepared and run.authorized. A
      // relay row the Store refuses fails this Turn before dispatch, or sends it as typed when only the packet is concerned. The
      // binding's relay state is not touched here: it changes when the packet is recorded, or when the Turn ends.
      const factsSeq = prepared.lastSeq;
      const commitPrepared = (): void => { this.commit(id, latest => {
        const events: EventDraft[] = [], deliveries: RelayDeliveryWrite[] = [];
        let relay: BindingRelayState | null = latest.nativeBindings?.find(row => row.harnessId === h && row.controlId === c && row.status !== "archived")?.relay ?? null;
        if (bound === undefined) relay = null;
        if (relay !== null && working !== null && JSON.stringify(relay) !== JSON.stringify(working))
          throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能准备交接单：准备期间绑定的接力状态变了，这条消息没有发出。");
        const packets: { readonly runId: PublicRun["id"]; readonly packet: RelayPacket; readonly body: string }[] = [];
        if (packet !== null && decision?.kind === "carry") {
          packets.push({ runId: target, packet: packet.manifest, body: packet.body });
          if (relay !== null) deliveries.push({ kind: "insert", record: deliveryRow({ runId: target, packetId: packet.manifest.id, declaration, autoResend: decision.resend === "auto", inputHmac: this.relayKeys.inputHmac(id, typed),
            setTag: this.relayKeys.setTag(id, packetSecrets), rulesVersion: packet.record.policyVersion, keyId: this.relayKeys.keyId, handoffLogSeq: handoff?.logSeq ?? null }) });
        }
        const executedOn = bound !== undefined && relay !== null ? { harnessId: h, controlId: c, nativeEpoch: relay.epoch } : null;
        const sources = packet?.runs ?? [];
        let next = updatedRun(latest, target, { contextThroughSeq: factsSeq, sourceRunIds: sources, relay: runRelayOf(packet?.manifest ?? null, continuityOf(decision, packet?.record ?? null, sources.length), executedOn) });
        next = updatedRun(next, target, phase(next, target, "contextReadyAt", now()));
        next = updatedRun(next, target, { status: "running", ...phase(next, target, "readyAt", now()) });
        // What the relay decided for the Turn and why: with the packet's record when one goes, alone otherwise; an ordinary Turn that owes nothing records none.
        const recorded = decisionRecord(decision), handoffData = handoff === null ? {} : { handoff: { logSeq: handoff.logSeq, ...(handoff.first ? { first: true } : {}) } };
        const relayData = packet !== null ? { ...packet.record, ...(recorded === null ? {} : { decision: recorded }), ...handoffData } : recorded === null ? undefined : { decision: recorded };
        // `continuity` is the legacy word for how the Turn continued its context: a Turn the policy sent alone carried nothing of the history, so it continued its native session.
        events.push(event("run.context_prepared", { runId: target, throughSeq: factsSeq, sourceRunIds: sources, continuity: decision?.kind === "alone" ? "native_resume" : "public_context_rehydrate",
          // What identifies the packet (policy, ID, sha256 of the text, the facts it carries, how it was folded); never its text.
          ...(relayData === undefined ? {} : { relay: relayData }),
          ...(packet !== null ? { range: packet.manifest.range, ...(decision?.kind === "carry" && decision.by === "user" ? { attachOverride: true } : {}),
            ...(window === null ? {} : { window: { size: window.size, source: window.source } }) } : {}),
          // The user asked for the history and there was none to attach: it went as typed, which the conversation shows.
          ...(decision?.kind === "alone" ? { alone: true } : {}), ...(decision?.kind === "plain" && decision.nothingToAttach ? { nothingToAttach: true } : {}) }),
          event("run.authorized", { runId: target, epoch: run.epoch }));
        return { next, events, ...(packets.length || deliveries.length ? { relay: { ...(packets.length ? { packets } : {}), ...(deliveries.length ? { deliveries } : {}) } } : {}) };
      }); };
      // The first handoff to a Harness is traced in the installation's log before the Turn that sends it is committed (the delivery row
      // names the row), and everything that concerns the packet alone — the log that cannot be written, a row the Store refuses (its
      // text, its quota) — sends the input as typed instead, once: the first attempt wrote nothing.
      const attempt = (): void => {
        if (decision?.kind === "carry" && packet !== null && bound !== undefined) handoff = this.logHandoff(h);
        commitPrepared();
      };
      try { attempt(); }
      catch (error) {
        const found = decision?.kind === "carry" ? policyAloneOf(error, requested) : null;
        if (found === null || aloneInstead === null) throw error;
        aloneInstead(found); attempt();
      }
      if (bound !== undefined) {
        if (command !== null) execution.relay.turn = { kind: "command", declared: command.effect };
        else if (packet !== null && decision?.kind === "carry") execution.relay.turn = { kind: "carry", runId: target, packet: packetRef(packet.manifest.id, packet.manifest.range), autoResend: decision.resend === "auto", recorded: false };
        else if (decision?.kind === "alone") execution.relay.turn = { kind: "alone" };
        else execution.relay.turn = { kind: "plain", contextThroughSeq: factsSeq, agentOutput: false };
      }
      this.continue(execution);
      // A native session this handoff opened is named before its first prompt (ADR-055 §8.1; its Driver's declaration says so):
      // once the Turn that carries the packet is committed — a Turn that goes alone after all names nothing — and before it is
      // dispatched, with a name that hides what the packet hid, the known secrets of every Harness of the conversation.
      if (decision?.kind === "carry" && packet !== null && openedNew && declaration.capabilities?.title === "set" && control.setTitle !== undefined) {
        const result = await this.titleFor(control, native, turnSource(this.store, id).turn(0)?.user.text ?? "", packetSecrets); this.continue(execution);
        this.commit(id, current => ({ next: current, events: [event("relay.title_set", { runId: target, harnessId: h, controlId: c, result })] }));
      }
      control.enablePermissions?.();
      // Attachments are checked against the opened agent/model and copied before dispatch, so a refusal fails this input cleanly.
      let files: readonly ControlAttachment[] = [];
      if (run.attachments?.length) {
        const content = this.options.content;
        if (!control.checkAttachments) throw new SessionError("ATTACHMENT_UNSUPPORTED", "this Harness interface does not accept attachments");
        if (content === undefined) throw new SessionError("ATTACHMENT_UNAVAILABLE", "this Gateway has no content storage for attachments");
        try { await control.checkAttachments(run.attachments); }
        catch (error) {
          // These two refusals are written by the Driver itself (no native text) and name only the attachment.
          const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
          if ((code === "ATTACHMENT_UNSUPPORTED" || code === "ATTACHMENT_LIMIT") && error instanceof Error) throw new SessionError(code, error.message.slice(0, 512));
          throw error;
        }
        this.continue(execution);
        files = await content.materialize(run.attachments); this.continue(execution);
      }
      // Nothing of the Turn reaches its Harness before the checkpoint of the workspace as it was is taken (or given up).
      await before; this.continue(execution);
      this.commit(id, current => ({ next: updatedRun(current, target, phase(current, target, "dispatchedAt", this.options.now().getTime())), events: [event("run.dispatched", { runId: target })] }));
      execution.dispatched = true;
      // "Plan" as the Hub's policy (no plan mode of the Harness's own): the model is told it is read only before it tries.
      const planned = selectedPermission(run.selection.nativeOptions) === "plan" && this.options.flavor?.(run.selection.harnessId).nativePlan === false ? withPlanNote(turnText) : turnText;
      // What the work this conversation delegated came to goes with the Turn, before the user's words, and the Turn says so (2026-11-13). Never with a command.
      let news = command === null ? this.delegationNews(this.load(id), target) : null;
      if (news !== null) {
        // With what each of them ran in its latest Turn, where its details can be read.
        const ran = await this.delegationRan(Object.keys(news.told), execution.binding?.secrets ?? []); this.continue(execution);
        if (ran.size > 0) news = this.delegationNews(this.load(id), target, ran) ?? news;
      }
      const told = news;
      if (told !== null) this.placed(execution, { kind: "notice", severity: "info", title: told.line, code: "DELEGATION_TOLD", at: this.options.now().getTime() },
        [event("run.delegations_told", { runId: target, told: Object.entries(told.told).map(([sessionId, entry]) => ({ sessionId, runId: entry.runId })) })],
        { always: true, patch: current => ({ ...current, delegationsTold: { ...(current.delegationsTold ?? {}), ...told.told } }) });
      // The first Turn of a conversation that was delegated its work says so, and where the rest of the task is read (2026-11-13).
      const delegated = command === null && this.load(id).delegation !== undefined && this.load(id).runs[0]?.id === target && toolsUsable() ? DELEGATED_NOTE : null;
      // The task's state, said whole where this Harness may not hold it any more (2026-11-13): it takes the conversation over or comes back to it (the Turn carries a
      // packet), or its own session was compacted in the Turn before. It holds the board, which is then not said a second time.
      // A compaction the Turn before answered itself (the state rode a tool's answer in it, signalsFor) is not answered a second time.
      const toldBefore = ((runs: readonly ConversationRun[]) => { const at = runs.findIndex(row => row.id === target); return at > 0 && this.pinned.get(id) === runs[at - 1]!.id; })(this.load(id).runs);
      const cause = command !== null ? null : reseated !== null ? "reseat" : packet !== null ? "handoff" : !toldBefore && this.compactedBefore(this.load(id), target) ? "compaction" : null;
      // A handoff that carries the whole conversation says the conversation's own part of the state already: only the task's part is added to it. A native session the
      // Hub opened in the place of a full one is told the whole state: it is the same Harness in the middle of its own work, and where it stands comes first.
      // A packet that goes with the Turn carries the user's words; where none goes, the state carries them by the rule a handoff to this Harness would (2026-11-14).
      const wordsShare = (): number | null => {
        if (packet !== null) return null;
        const limit = declaration.capabilities?.placement.maxInput ?? null, latest = this.load(id), asked = latest.runs.find(row => row.id === target)!;
        return this.wordsBudget(latest, asked, limit === null ? null : { limit: limit.limit, size: declaration.capabilities!.placement.measure(typed, kinds) });
      };
      const standing = cause === null ? null : this.options.context?.state?.(id, target, recordAt() !== null, cause === "handoff" && packet?.record.complete === true ? "task" : "whole", wordsShare()) ?? null;
      if (standing !== null) {
        const version = this.taskBoard(id).version, patch = (current: Conversation): Conversation => ({ ...current, taskBoardTold: Math.max(current.taskBoardTold ?? 0, version) });
        // The Turn said already that it runs in a new native session; that it carries the state is part of that, and is not said in a line of its own.
        if (cause === "reseat") this.commit(id, current => ({ next: patch(current), events: [event("run.task_state_told", { runId: target, cause })] }));
        else this.placed(execution, { kind: "notice", severity: "info", title: cause === "compaction" ? "它压缩过上下文，重新带上了任务现在的状态" : "带上了任务现在的状态", code: "TASK_STATE_TOLD", at: this.options.now().getTime() },
          [event("run.task_state_told", { runId: target, cause })], { always: true, patch });
      }
      // The task's board, when it changed since this Harness was last told: what everyone on the task goes by, before anything else of the Hub's.
      const board = command === null ? this.boardNews(this.load(id), recordAt() !== null) : null;
      if (board !== null) this.placed(execution, { kind: "notice", severity: "info", title: board.line, code: "TASK_BOARD_TOLD", at: this.options.now().getTime() },
        [event("run.task_board_told", { runId: target, version: board.version })], { always: true, patch: current => ({ ...current, taskBoardTold: board.version }) });
      // What the other conversations of the task changed since this Harness was last told; where there is only how far they stand to remember, it is remembered without a word.
      const edits = command === null ? this.editNews(this.load(id)) : null;
      if (edits !== null && edits.line !== null) this.placed(execution, { kind: "notice", severity: "info", title: edits.line, code: "TASK_EDITS_TOLD", at: this.options.now().getTime() },
        [event("run.task_edits_told", { runId: target, told: edits.told })], { always: true, patch: current => ({ ...current, taskEditsTold: { ...(current.taskEditsTold ?? {}), ...edits.told } }) });
      else if (edits !== null) this.commit(id, current => ({ next: { ...current, taskEditsTold: { ...(current.taskEditsTold ?? {}), ...edits.told } }, events: [event("run.task_edits_marked", { runId: target, told: edits.told })] }));
      // What the user said since in the conversation this one's work came from.
      const words = command === null ? this.parentWords(this.load(id)) : null;
      if (words !== null && words.line !== null) this.placed(execution, { kind: "notice", severity: "info", title: words.line, code: "PARENT_WORDS_TOLD", at: this.options.now().getTime() },
        [event("run.parent_words_told", { runId: target, through: words.through })], { always: true, patch: current => ({ ...current, parentWordsTold: words.through }) });
      else if (words !== null) this.commit(id, current => ({ next: { ...current, parentWordsTold: words.through }, events: [event("run.parent_words_marked", { runId: target, through: words.through })] }));
      const notes = [command === null && reseated !== null ? reseatedNote(reseated, packet !== null) : null, standing, board?.text ?? null, delegated, words?.text ?? null, edits?.text ?? null, told?.text ?? null].filter((note): note is string => note !== null).map(note => asCommand(asFiles(note, recordAt()), execution.binding?.hubCommand));
      // The directory is brought up to the record before a Harness that reads it starts: what it is told is there is there.
      if (recordAt() !== null) { await this.options.context!.ensure(id).catch(() => undefined); this.continue(execution); }
      // Otherwise the task's STATE.md files are written again without waiting: what the user says here is news to work this conversation handed over (parentWords).
      else this.refreshRecord(id);
      execution.run = await control.startText(native, notes.length === 0 ? planned : withHubNote(planned, notes.join("\n\n")), value => this.output(execution, value), ...(files.length ? [files] : []));
      if (command === null) execution.steerTo = native;
      this.owned(execution);
      void execution.run.result.then(() => { execution.backendSettled = true; }, () => { execution.backendSettled = true; });
      if (this.load(id).runs.find(run => run.id === target)!.cancelRequested || !this.accepting || this.fatal || this.closingSessions.has(id)) this.stop(execution);
      // What the driver knew of the input reaching the native history, and of a clear, stays with this Turn; the stored result never holds it.
      const { input: delivered, command: said, native: cleared, ...settled } = await execution.run.result; execution.backendSettled = true;
      backend = settled; evidence = delivered === "recorded" || delivered === "not_recorded" ? delivered : null; noop = said === "noop";
      nativeCleared = cleared !== undefined && cleared !== null && cleared.cleared === true ? cleared : undefined;
      this.owned(execution);
      // Text still in its window is committed before the settlement, so the reply precedes run.backend_settled (ADR-047).
      this.flushStream(execution);
      this.commit(id, current => ({ next: updatedRun(current, target, { status: "settling", backend }), events: [event("run.backend_settled", { runId: target, backend })] }));
      if (checkpointStored) {
        // The native session the Driver gave up on a clear is archived as it is: its reference after the Turn is not needed, so
        // one the Driver no longer gives (it opened no session ahead) fails nothing.
        const replacing = nativeCleared !== undefined;
        const after = replacing ? await control.checkpoint!().catch(() => null) : await control.checkpoint!(); this.owned(execution);
        const valid = typeof after === "string" && after !== "" && Buffer.byteLength(after) <= 8192 && !/[\0\r\n]/u.test(after);
        if (!valid && !replacing) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "original Harness lost its owned session reference");
        if (valid) checkpoint = after; nativeConfirmed = true;
        reported = true;
        if (control.nativeConfig) {
          // Unreadable or invalid reports leave the configuration unknown; the next Turn then applies the selection as requested.
          // A Turn that told nothing about the native values leaves the earlier report standing.
          try { const report = await control.nativeConfig(); if (report === null) reported = false; else observed = parseNativeConfiguration(report); }
          catch (error) { observed = undefined; const code = fault(error).code; this.commit(id, current => ({ next: current, events: [event("native.config_unreadable", { runId: target, code })] })); }
          this.owned(execution);
        }
      }
    } catch (error) { problem = fault(error); if (error instanceof RelayError) relayReason = error.reason; }
    finally {
      // A window still open is committed before the Turn's end (ADR-047). Once the program was ended early its lease is gone,
      // so the window goes with the Turn, which is unknown then; a window refused outside a driver callback is the Turn's failure.
      if (execution.earlyClose === null) { try { this.flushStream(execution); } catch (error) { problem ??= fault(error); } }
      else this.discardStream(execution);
      if (execution.streamFailure !== null) problem ??= fault(execution.streamFailure);
      const abandoned = [...this.permissions.entries()].filter(([, permission]) => permission.execution === execution);
      for (const [permissionId] of abandoned) this.permissions.delete(permissionId);
      // Only a log of what was abandoned: a refusal of it by the rows does not stop the Turn's end from being recorded below.
      if (abandoned.length) { try { this.commit(id, current => ({ next: current, events: abandoned.map(([permissionId]) => event("permission.closed", { permissionId, runId: target })) })); } catch (error) { this.stalls(error, id); } }
      if (execution.stop) {
        try { await execution.stop; } catch (error) { problem ??= fault(error); }
      }
      // Words given to the Turn while it ran are answered before it ends, while its program is still owned: what the Harness said of them is the Turn's (steer).
      while (execution.steers !== undefined && execution.steers.size > 0) await Promise.allSettled([...execution.steers]);
      if (execution.binding && execution.earlyClose === null) {
        try { await this.flushNative(execution); } catch (error) { problem ??= fault(error); }
      }
      // A finished Turn of a conversation that keeps its process hands the process over instead of closing it (ADR-030); not
      // one whose Driver gave up the native session on a clear (its conversation changed, ADR-055 §7.5).
      const keep = execution.binding === null || opened === null || nativeCleared !== undefined ? { keep: false }
        : this.keepable(id, execution, backend, problem, checkpointStored && nativeConfirmed);
      if (execution.binding && !keep.keep) {
        // A close that throws leaves the cleanup unconfirmed (the Turn is unknown); the Turn keeps the failure it ended with (M-8).
        try { execution.earlyClose ??= execution.binding.close(); cleanup = await execution.earlyClose; }
        catch (error) { problem ??= fault(error); }
      }
      // What the program logged during this Turn, kept privately in memory for the user's diagnostics (redacted on the way out).
      if (execution.binding && execution.diagnosticMark !== null) this.keepDiagnostics(id, target, execution.binding.control.diagnosticsSince?.(execution.diagnosticMark) ?? "");
      let handed = false;
      // The workspace as the Turn left it (2026-11-14), whatever its end; after the one from before it, which it would otherwise race.
      await before;
      const after = this.checkpoint(state.configuration.workspace, id, queued.ordinal, "after");
      const recorded = watch === null ? null : await workspacePlacement(watch, execution.dispatched, this.options.content, state.configuration.workspace, () => this.options.now().getTime());
      await after;
      const endedAt = this.options.now().getTime(), idleMs = this.options.keptIdleMs ?? KEPT_IDLE_MS;
      // The group's identity lets a later owner recognize and end it if this owner ends without closing it.
      let identity = reusing?.identity;
      if (keep.keep && identity === undefined && execution.binding !== null && this.options.processes !== undefined) {
        const group = execution.binding.control.processGroup?.() ?? null;
        const startedAt = group === null ? null : await this.options.processes.identify(group).catch(() => null);
        if (group !== null && startedAt !== null) identity = { group, startedAt };
      }
      // Registered before the hand-over is committed, so the view published with that commit already shows the kept process.
      if (keep.keep && execution.binding !== null && opened !== null) {
        const binding = execution.binding, timer = setTimeout(() => { void this.requestRelease(id, "idle"); }, idleMs); timer.unref?.();
        this.kept.set(id, { binding, selection: pinned, conversation: opened, runId: target, since: reusing?.since ?? endedAt, baseline: binding.control.unattributedUpdates ?? 0, lastUsed: endedAt, timer,
          ...(identity === undefined ? {} : { identity }) });
      }
      try {
        this.store.assertOwner();
        // Read only for a clear, the one end that may clear a relay recovery failure (M-5).
        const current = this.load(id), run = current.runs.find(run => run.id === target)!, failedOn = nativeCleared !== undefined ? this.recoveryFailureOn(current) : null;
        const unsafe = (execution.dispatched && backend === null) || (execution.binding !== null && cleanup === null && !keep.keep) || this.fatal !== null || this.unknownOwnership(problem);
        const closed = cleanup;
        // A Turn the Runtime stopped on its own (a budget ran out before it settled) is cancelled when it then settled, whatever
        // it reported, and unknown when it had to be ended.
        const stopped = execution.stopReason !== null;
        const failure = stopped ? { code: execution.stopReason!, message: execution.stopReason === "WAIT_EXPIRED" ? "the wait for the user's decision ran out" : "the Turn's execution budget ran out" }
          : problem ?? closed?.protocolFailure ?? backend?.error ?? null;
        const status = unsafe ? "unknown" : run.cancelRequested || problem?.code === "CANCELLED" || stopped ? "cancelled" : failure ? "failed" : backend?.status ?? "failed";
        // The binding is ready again when the Turn's native state is confirmed (ADR-028/030). After an unknown Turn of a process
        // Driver whose program the Hub saw end (its close confirmed), the user may continue the original session (D6, slim.md):
        // the binding is ready and its relay says everything is to be sent again, since the Turn's input may not have arrived.
        const confirmed = checkpointStored && checkpoint !== null && (keep.keep || closed?.closed === true && closed.protocolFailure === null) && (!execution.dispatched || nativeConfirmed && backend !== null);
        const continued = unsafe && checkpointStored && execution.dispatched && backend === null && cleanup?.closed === true && cleanup.protocolFailure === null && this.fatal === null && !this.unknownOwnership(problem)
          && execution.relay.declaration.execution === "process";
        // What the Driver reported of a clear, as the relay takes it: a certain clear, whatever else the Turn's end could confirm. The Driver
        // gave the native session up and opened none: a program that ended with a protocol failure, or a reference nobody confirmed, is nothing
        // to the new native session the Hub opens next, and must not leave the clear's boundary unwritten (ADR-055 B7, R9e).
        const clearReport = nativeCleared !== undefined;
        // A command's effect counts only when it ran; it goes into the Turn's end event with what the driver knew of the input. A
        // clear its Driver confirmed is a clear, as the binding records it, whatever the Turn's status (R9e).
        const input: InputOutcome = !execution.dispatched ? "not_recorded" : evidence ?? "unknown";
        const effect = command === null ? null : clearReport ? "clear" as const : commandEffect(command.effect, commandOutcome(execution.dispatched, backend?.status ?? null, input, noop));
        // What the end did with the relay, for a retry without it (R6).
        const tried = { relayed: false, replaced: false };
        // The Turn's items are closed with its end, before the Run is: what was open is told as what it was left as (items-place.ts), and a Turn that asked to keep
        // its process and could not says so among its items. All of it is one commit with the Run's end, so the two never disagree.
        const recording = recorded === null ? this.turnOf(execution) : place(this.turnOf(execution), recorded).turn;
        const settling = recording, noted = keep.skipped === undefined ? settling : place(settling, hubNotice(keptSkippedNotice(this.options.keptLimit ?? this.kept.size), endedAt)).turn;
        const closing = place(noted, { kind: "settled", status, at: endedAt, ...(status === "cancelled" && run.cancelRequested && !stopped ? { stoppedBy: "user" as const } : {}) });
        const ended = (withRelay: boolean) => (current: Conversation): ConversationMutation => {
          let next: Conversation = { ...updatedRun(current, target, { status, backend, cleanup: closed,
            error: failure, ...phase(current, target, "endedAt", endedAt), ...(keep.keep ? { retained: true as const } : {}), ...(effect === null ? {} : { settledEffect: effect }), items: itemsOf(closing.turn) }), activeRunId: null, status: unsafe ? "blocked" : current.status,
            ...(keep.keep ? { retained: { harnessId: pinned.harnessId, controlId: pinned.controlId, runId: target, since: reusing?.since ?? endedAt, ...(identity === undefined ? {} : { process: identity }) } } : {}) };
          // A Turn that failed on the relay before it ran says so in its relay (§12.2: blocked, with the code).
          const latestRun = runIn(next, target)!;
          if (latestRun.relay === undefined && failure !== null && (BLOCKED_CODES as readonly string[]).includes(failure.code))
            next = updatedRun(next, target, { relay: runRelayOf(null, { kind: "blocked", code: failure.code as typeof BLOCKED_CODES[number] }, null) });
          // The relay part of the end (ADR-055 §6.1, §7.2): the Turn's own delivery and the binding's relay state as committed now,
          // a command's effect, a clear the Driver reported and an unknown Turn continued; the delivery rows decided with it.
          const own = next.nativeBindings?.find(row => row.harnessId === pinned.harnessId && row.controlId === pinned.controlId && row.status !== "archived");
          const relayed = withRelay && checkpointStored && own?.relay !== undefined ? settleTurn({ relay: own.relay, runId: target, turn: this.settledTurn(execution),
            dispatched: execution.dispatched, status: backend?.status ?? null, input: evidence ?? undefined, noop, cleared: clearReport,
            declaration: execution.relay.declaration, unknownTurn: continued, endedSeq: current.lastSeq + 1, time: endedAt }) : null;
          if (withRelay) { tried.relayed = relayed !== null; tried.replaced = relayed?.replaced === true; }
          if (checkpointStored && checkpoint !== null && (confirmed || continued || relayed?.replaced === true)) {
            next = { ...next, nativeBindings: next.nativeBindings?.map(binding => {
              if (binding.harnessId !== pinned.harnessId || binding.controlId !== pinned.controlId || binding.status === "archived") return binding;
              // The native session a clear gave up (§7.5) is archived as it was, its relay state frozen; the Turn ran in it. The Driver's
              // report is the clear, confirmed or not: its successor below carries the boundary.
              if (relayed?.replaced) return { ...binding, status: "archived" as const, throughRunId: execution.dispatched ? run.id : binding.throughRunId };
              // An unknown Turn continued keeps the reference it resumed from; its native position stays where it was.
              if (!confirmed) return { ...binding, status: "ready" as const, ...(relayed === null ? {} : { relay: relayed.relay }) };
              const { observed: earlier, opensNew: _opened, ...rest } = binding, latest = reported ? observed : earlier;
              // A native session this Turn opened anew and never dispatched into was never prompted, and another process cannot
              // resume it: the binding goes on opening a new one (opensNew), naming the session it named before — the abandoned one,
              // C5's refused one, or for a new binding this one (G068 fix batch 2, I-1a). It has no native position yet.
              if (!execution.dispatched && openedNew) return { ...rest, checkpoint: previousNative?.checkpoint ?? checkpoint!, status: "ready" as const, throughRunId: null, opensNew: true as const,
                ...(latest === undefined ? {} : { observed: latest }), ...(relayed === null ? {} : { relay: relayed.relay }) };
              // The native position follows dispatch (ADR-055 §7.4): a dispatched Turn's input reached this native session, whatever the relay.
              return { ...rest, checkpoint: checkpoint!, status: "ready" as const, throughRunId: execution.dispatched ? run.id : binding.throughRunId, ...(latest === undefined ? {} : { observed: latest }),
                ...(relayed === null ? {} : { relay: relayed.relay }) };
            }) ?? [] };
            // A clear (§7.5): the new binding of the same Harness control starts the next epoch at the clear's floor and inherits what
            // the native session was last seen running. A relay recovery failure is cleared only when it names this Harness control (a
            // Turn's end committed without its relay part, R6): the binding it named is replaced; one a recovery left names no binding,
            // and only the user's native reset clears it (§9 S15; G068 fix batch 2, M-5). The Driver gave the native session up and
            // opened none ahead: the next Turn opens a new one (opensNew), and the binding names the abandoned session it replaces,
            // which is never resumed.
            if (relayed?.replaced) {
              const latest = reported ? observed : own?.observed, { relayRecoveryFailed, ...rest } = next;
              const named = failedOn !== null && failedOn.harnessId === pinned.harnessId && failedOn.controlId === pinned.controlId;
              next = { ...(named ? rest : next), nativeBindings: [...next.nativeBindings!, { harnessId: pinned.harnessId, controlId: pinned.controlId, checkpoint: own!.checkpoint, throughRunId: null, status: "ready" as const,
                ...(latest === undefined ? {} : { observed: latest }), relay: relayed.relay, opensNew: true as const }] };
            }
          } else if (relayed !== null && !relayed.replaced) {
            next = { ...next, nativeBindings: next.nativeBindings?.map(binding => binding.harnessId === pinned.harnessId && binding.controlId === pinned.controlId && binding.status !== "archived" ? { ...binding, relay: relayed.relay } : binding) ?? [] };
          }
          const cancelSwitch = (!this.accepting || this.closingSessions.has(id)) && next.pendingSwitchId !== null;
          if (cancelSwitch) next = this.cancelPending(next);
          // A switch waiting for a Turn whose end cannot be confirmed fails with it, and so does every input waiting for that
          // switch: left pending, it would keep the blocked conversation from being recovered (RT2-04).
          const stranded = unsafe && !cancelSwitch ? next.pendingSwitchId : null;
          const waiting = stranded === null ? [] : next.runs.filter(row => row.status === "queued" && row.awaitingSwitchId === stranded).map(row => row.id);
          if (stranded !== null) next = this.strandSwitch(next, stranded, waiting, endedAt);
          // Without its relay part (R6) the end marks the conversation: a Turn that would carry relay content goes as typed
          // (relay.decision recovery_failed) until a new native session, as after a relay recovery that could not be written.
          if (!withRelay && next.relayRecoveryFailed === undefined) next = { ...next, relayRecoveryFailed: current.lastSeq + 1 };
          const relayNote = { ...(relayReason === null ? {} : { reason: relayReason }), ...(withRelay ? {} : { failed: true }) };
          return { next, events: [event("run.ended", { runId: target, status, backend, cleanup: closed, error: failure, input, ...(effect === null ? {} : { contextEffect: effect }),
              ...(nativeCleared === undefined ? {} : { native: nativeCleared }), ...(relayed?.delivery == null ? {} : { delivery: relayed.delivery }), ...(relayed === null ? {} : { binding: relayed.binding }),
              ...(Object.keys(relayNote).length === 0 ? {} : { relay: relayNote }), ...(continued ? { continued: true } : {}) }),
            ...(keep.keep ? [event("native.process_retained", { runId: target, idleEndsAt: endedAt + idleMs })] : keep.skipped ? [event("native.retention_skipped", { runId: target, reason: keep.skipped })] : []),
            ...(cancelSwitch ? [event("switch.failed", { switchId: current.pendingSwitchId, reason: "cancelled by close" })] : []),
            ...(stranded === null ? [] : [event("switch.failed", { switchId: stranded, error: STRANDED_SWITCH, reason: "the Turn it waited for ended without confirmed settlement" }),
              ...waiting.map(queuedId => event("run.ended", { runId: queuedId, status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE" }, neverDispatched: true }))]),
            ...(unsafe ? [event("session.blocked", { runId: target, reason: "execution or cleanup could not be safely confirmed" })] : [])],
            ...(relayed !== null && relayed.deliveries.length ? { relay: { deliveries: relayed.deliveries } } : {}), createdBy: () => 0 };
        };
        // The last resort: what the commit above was refused for is not the store's trust but its rows (a check of the rows, a relay row). The Turn is then
        // ended as what it is, a Turn whose end could not be recorded in full: unknown, the reason told, the conversation blocked until the user resumes it, and
        // no relay part in the commit. What the end does apart from the relay it still does, so that no Turn is left half ended: the items that were open in it are closed
        // as an unknown Turn's are, and the switch it held up fails with it (and the inputs waiting for that switch with it). A process it was to keep is not kept (the rows keep
        // a process only for a Turn that completed): it is closed below, like the process of any Turn whose hand-over was not recorded.
        // The Runtime goes on; a failure of the store itself fails it, as it always did.
        let fellBack = false;
        const unrecorded = (reason: unknown) => (current: Conversation): ConversationMutation => {
          fellBack = true;
          const why = fault(reason), settled = place(noted, { kind: "settled", status: "unknown", at: endedAt });
          let next: Conversation = { ...updatedRun(current, target, { status: "unknown" as const, backend, cleanup: closed, error: why, ...phase(current, target, "endedAt", endedAt), items: itemsOf(settled.turn) }),
            activeRunId: null, status: "blocked" as const };
          const cancelSwitch = (!this.accepting || this.closingSessions.has(id)) && next.pendingSwitchId !== null;
          if (cancelSwitch) next = this.cancelPending(next);
          const stranded = cancelSwitch ? null : next.pendingSwitchId, waiting = stranded === null ? [] : next.runs.filter(row => row.status === "queued" && row.awaitingSwitchId === stranded).map(row => row.id);
          if (stranded !== null) next = this.strandSwitch(next, stranded, waiting, endedAt);
          return { next, events: [event("run.ended", { runId: target, status: "unknown", backend, cleanup: closed, error: why, input, unrecorded: true }), event("session.blocked", { runId: target, reason: "the end of the Turn could not be recorded" }),
            ...(cancelSwitch ? [event("switch.failed", { switchId: current.pendingSwitchId, reason: "cancelled by close" })] : []),
            ...(stranded === null ? [] : [event("switch.failed", { switchId: stranded, error: STRANDED_SWITCH, reason: "the Turn it waited for ended without confirmed settlement" }),
              ...waiting.map(queuedId => event("run.ended", { runId: queuedId, status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE" }, neverDispatched: true }))])], createdBy: () => 0 };
        };
        try { this.commit(id, ended(true), true); }
        catch (error) {
          // The Store refused the relay part of the end (its rows, the binding's relay state): the public facts are committed
          // without it, once, and the conversation is marked (R6). A replaced native session is not split from its relay state;
          // a Store that failed, or anything else, fails the Runtime as before.
          if (!tried.relayed || tried.replaced || !this.relayRefusal(error)) {
            if (storeUntrusted(error) || !this.relayRefusal(error)) throw error;
            this.commit(id, unrecorded(error));
          } else {
            try { this.commit(id, ended(false), true); }
            catch (second) { if (storeUntrusted(second) || !this.relayRefusal(second)) throw second; this.commit(id, unrecorded(second)); }
          }
        }
        handed = keep.keep && !fellBack;
      } catch (error) { if (!this.stalls(error, id)) this.endUnrecorded(id, target, error); }
      if (keep.keep && !handed) {
        // The hand-over was not recorded, so the process is not kept: it is closed like any other Turn's.
        const unrecorded = this.kept.get(id);
        if (unrecorded !== undefined) { this.kept.delete(id); clearTimeout(unrecorded.timer); }
        if (execution.binding !== null) try { await execution.binding.close(); } catch (error) { this.fail(error, id); }
      }
      if (this.actives.get(id) === execution) this.actives.delete(id);
      this.acceptedRelay.delete(target);
      // The record's directory takes the Turn as it ended, for whoever of the task reads it next. A Turn's end does not wait for files; the Runtime's close does
      // (recordWork), and once it closes nothing more is written.
      if (this.options.context !== undefined && this.accepting) {
        const work: Promise<void> = this.options.context.ensure(id).catch(() => undefined);
        this.recordWork.add(work);
        void work.finally(() => this.recordWork.delete(work));
      }
      execution.clock.budget?.(); execution.clock.hint?.();
      if (execution.grace !== null) clearTimeout(execution.grace);
      this.discardStream(execution);
    }
  }
  /** What a Turn was authorized to send, as its settlement reads it now (a carrying Turn: whether E1 recorded it already). */
  private settledTurn(execution: ActiveExecution): SettledTurn {
    const turn = execution.relay.turn;
    if (turn.kind === "carry") return { ...turn, recorded: execution.relay.recorded };
    if (turn.kind !== "plain") return turn;
    // The agent answered when anything of its own is written: a reply or reasoning with words in it, or a call.
    const items = execution.turn === null ? [] : itemsOf(execution.turn);
    return { ...turn, agentOutput: items.some(item => item.textBytes > 0 && (item.type === "assistant_message" || item.type === "reasoning") || item.itemId.startsWith("tool:")) };
  }
  /**
   * Starts the Turn's program (its binding), with the installation it resolved.
   */
  private async startProgram(execution: ActiveExecution, run: ConversationRun, current: Conversation, id: SessionId, target: PublicRun["id"]): Promise<void> {
    // The conversations of this Gateway share a workspace's lease (a kept process of another conversation included), so a refusal here is
    // another Gateway holding it: WORKSPACE_BUSY, as the lease says.
    execution.binding = await this.factory.prepare(run.selection, current.configuration, id, target); execution.diagnosticMark = execution.binding.control.diagnosticMark?.() ?? null;
    this.continue(execution);
    const installation = execution.binding.installation;
    if (installation !== undefined) this.commit(id, latest => ({ next: latest, events: [event("run.installation_resolved", { runId: target, installation })] }));
  }
  /**
   * C5 (G068 fix batch 2, I-1b): the program whose open its Driver refused as a session it does not have is closed — a Driver may
   * fail the connection with that refusal, as the ACP Driver does — and the Turn starts it again, initialized, for a new native
   * session. A close that does not confirm the program ended keeps that binding for the Turn's end to account for, and the Turn
   * fails with the refusal, as it would without the replacement. Returns the new control and how the refused one was closed.
   */
  private async restartProgram(execution: ActiveExecution, run: ConversationRun, current: Conversation, id: SessionId, target: PublicRun["id"], refusal: unknown): Promise<{ readonly control: HarnessControl; readonly closed: CleanupEvidence }> {
    const refused = execution.binding!;
    execution.earlyClose ??= refused.close();
    const closed = await execution.earlyClose.catch(() => null);
    if (closed === null || closed.closed !== true) throw refusal;
    execution.binding = null; execution.earlyClose = null; execution.diagnosticMark = null;
    this.continue(execution);
    await this.startProgram(execution, run, current, id, target);
    const control = execution.binding!.control, observation = await control.initialize(); this.continue(execution);
    this.commit(id, latest => ({ next: latest, events: [event("run.protocol", { runId: target, observation })] }));
    return { control, closed };
  }
  /**
   * The Harness control a relay recovery failure names (§9 S15; G068 fix batch 2, M-5): a Turn's end committed without its relay
   * part (R6) names its Run's; a recovery's names none (its relay part covered every binding). Read from the event it records.
   */
  private recoveryFailureOn(state: Conversation): { readonly harnessId: string; readonly controlId: string } | null {
    const seq = state.relayRecoveryFailed;
    if (seq === undefined) return null;
    const recorded = this.store.events(state.id, seq - 1, 1)[0];
    if (recorded === undefined || recorded.seq !== seq || recorded.type !== "run.ended" || (recorded.data.relay as { readonly failed?: unknown } | undefined)?.failed !== true) return null;
    const run = state.runs.find(row => row.id === recorded.data.runId);
    return run === undefined || run.selection.provider !== undefined ? null : { harnessId: run.selection.harnessId, controlId: run.selection.controlId };
  }
  /**
   * Performs a branch's pending native fork with its own connection. The binding is marked `forking` before the request;
   * a clean refusal archives it (the branch continues from public history), a result that cannot be confirmed leaves it
   * `forking`, which blocks native use until the user explicitly rebuilds the native session.
   */
  private async forkNative(id: SessionId): Promise<void> {
    const state = this.load(id), pending = state.nativeBindings?.find(binding => binding.status === "fork-pending");
    if (!pending) return;
    const owns = (binding: NativeSessionBinding) => binding.harnessId === pending.harnessId && binding.controlId === pending.controlId && binding.status !== "archived";
    let binding: PreparedSessionBinding | null = null, problem: ReturnType<typeof fault> | null = null, forked: string | null = null, dispatched = false, cleanup: CleanupEvidence | null = null;
    try {
      binding = await this.factory.prepare(state.selection, state.configuration, id, "fork-" + this.options.id());
      await binding.control.initialize();
      if (!binding.control.fork) throw new SessionError("NATIVE_FORK_UNAVAILABLE", "this Harness interface cannot branch its native session");
      this.commit(id, current => ({ next: { ...current, nativeBindings: current.nativeBindings!.map(item => owns(item) ? { ...item, status: "forking" as const } : item) },
        events: [event("native.fork_dispatched", { harnessId: pending.harnessId, controlId: pending.controlId })] }));
      dispatched = true;
      const reference = await binding.control.fork(pending.checkpoint, binding.workspace);
      if (typeof reference !== "string" || !reference || Buffer.byteLength(reference) > 8192 || /[\0\r\n]/u.test(reference) || reference === pending.checkpoint) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "the Harness returned an invalid branch reference");
      forked = reference;
    } catch (error) { problem = fault(error); }
    finally { if (binding) { try { cleanup = await binding.close(); } catch (error) { problem ??= fault(error); } } }
    const refused = problem !== null && ["NATIVE_FORK_UNAVAILABLE", "UNSUPPORTED_CONTROL", "HARNESS_UNAVAILABLE", "CONTROL_UNAVAILABLE", "NATIVE_AUTH_REQUIRED"].includes(problem.code);
    const confirmed = forked !== null && cleanup?.closed === true && cleanup.protocolFailure === null;
    this.commit(id, current => {
      if (confirmed) return { next: { ...current, nativeBindings: current.nativeBindings!.map(item => owns(item) ? { ...item, checkpoint: forked!, status: "ready" as const } : item) },
        events: [event("native.forked", { harnessId: pending.harnessId, controlId: pending.controlId, cleanup })] };
      if (!dispatched || refused) return { next: { ...current, nativeBindings: current.nativeBindings!.map(item => owns(item) ? { ...item, status: "archived" as const } : item) },
        events: [event("native.fork_failed", { harnessId: pending.harnessId, controlId: pending.controlId, error: problem, continuity: "public_context_rehydrate" })] };
      return { next: current, events: [event("native.fork_unknown", { harnessId: pending.harnessId, controlId: pending.controlId, error: problem, cleanup })] };
    });
  }

  private async applySwitch(id: SessionId, targetId: string): Promise<void> {
    let binding: PreparedSessionBinding | null = null, cleanup: CleanupEvidence | null = null;
    let problem: ReturnType<typeof fault> | null = null;
    const initial = this.load(id), pending = initial.switches.find(sw => sw.id === targetId);
    const recovery = this.recoverySwitch(initial);
    if (!pending || initial.pendingSwitchId !== targetId || initial.activeRunId !== null) return;
    try {
      const request = pending.requested.provider === undefined && initial.selection.provider !== undefined
        ? { ...pending.requested, provider: initial.selection.provider } : pending.requested;
      const target = await this.factory.validate(request, initial.configuration);
      // A kept process runs the previous selection; it is closed before the switch takes effect (ADR-030).
      const kept = this.kept.get(id);
      if (kept !== undefined && !sameSelection(kept.selection, target)) await this.release(id, "selection_changed");
      this.store.assertOwner(); let current = this.load(id);
      if (current.pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting) return;
      // Validation fixes the switch's sources and watermark and renders nothing (ADR-055 R0a): no history is budgeted here,
      // so a long conversation can still switch and recover; the first input on the target carries what it is owed.
      const sources = current.runs.filter(run => terminal(run.status) && run.userSeq < pending.requestedSeq).map(run => run.id);
      const throughSeq = current.lastSeq;
      this.commit(id, current => ({ next: { ...current, switches: current.switches.map(sw => sw.id === targetId
        ? { ...sw, target, status: "validated", throughSeq, sourceRunIds: sources } : sw) },
        events: [event("switch.validated", { switchId: targetId, target, throughSeq, sourceRunIds: sources, continuity: "public_context_rehydrate" })] }));
      if (recovery) {
      binding = await this.factory.prepare(target, initial.configuration, id, targetId);
      this.switchBindings.set(id, { binding, close: null });
      this.store.assertOwner(); binding.assertOwned();
      current = this.load(id);
      if (current.pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting || this.fatal) throw new SessionError("CANCELLED", "switch cancelled before target initialization");
      await binding.control.initialize(); this.store.assertOwner(); binding.assertOwned();
      if (this.load(id).pendingSwitchId !== targetId || this.closingSessions.has(id) || !this.accepting || this.fatal) throw new SessionError("CANCELLED", "switch cancelled before target conversation");
      await binding.control.open(binding.workspace, target.nativeModel, nativeOnly(target.nativeOptions)); this.store.assertOwner(); binding.assertOwned();
      }
    } catch (error) { problem = fault(error); }
    finally {
      if (binding) {
        try { cleanup = await (this.switchBindings.get(id)?.close ?? binding.close()); } catch (error) { problem = fault(error); }
      }
      this.switchBindings.delete(id);
    }
    const current = this.load(id);
    if (current.pendingSwitchId !== targetId) return;
    const unsafe = (binding !== null && cleanup === null) || this.fatal !== null || this.unknownOwnership(problem);
    if (problem || cleanup?.protocolFailure || unsafe || this.closingSessions.has(id) || !this.accepting) {
      const error = problem ?? cleanup?.protocolFailure ?? { code: "CANCELLED", message: "switch cancelled before activation" };
      this.commit(id, state => ({ next: { ...state, pendingSwitchId: null, status: unsafe ? "blocked" : state.status,
        switches: state.switches.map(sw => sw.id === targetId ? { ...sw, status: "failed", error } : sw) },
        events: [event("switch.failed", { switchId: targetId, error, cleanup }), ...(unsafe ? [event("session.blocked", { switchId: targetId })] : [])] }));
      return;
    }
    const target = current.switches.find(sw => sw.id === targetId)!.target;
    if (target === null) throw new SessionError("INVALID_DATA", "validated switch has no target");
    // A recovery switch that becomes effective is what acknowledges the unknown Runs it covers: the conversation is open again with none left unacknowledged, which each of
    // them says on its own row (`acknowledgedBy`, written once), so that no reader has to work it out from the switches.
    this.commit(id, state => ({ next: { ...state, pendingSwitchId: null, selection: target, epoch: state.epoch + 1, ...(recovery ? { status: "open" as const } : {}),
      switches: state.switches.map(sw => sw.id === targetId ? { ...sw, status: "effective", throughSeq: state.lastSeq } : sw),
      ...(recovery ? { runs: acknowledged(state, targetId) } : {}) },
      events: [event("switch.effective", { switchId: targetId, target, epoch: state.epoch + 1, throughSeq: state.lastSeq,
        sourceRunIds: state.switches.find(sw => sw.id === targetId)!.sourceRunIds, cleanup, continuity: "public_context_rehydrate", ...(recovery ? { recovered: true } : {}) })] }));
  }
  /**
   * The log row of the first handoff to a Harness (relay_log), written before the Turn that sends the packet is committed, which
   * the packet's delivery row names; `first` says this Turn is the first whose delivery names it (the row may have been left by
   * an attempt that went as typed after all). A log this Gateway cannot write leaves nothing to trace the handoff by, so the
   * packet is not sent (a RelayError the policy settles by sending the input alone).
   */
  private logHandoff(harnessId: string): { readonly logSeq: number; readonly first: boolean } {
    const log = this.relayLog();
    if (log?.logHandoff === undefined) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "storage" }, "这个 Gateway 没有可写的交接记录，记不下这次交接，所以没有附上交接单。");
    const written = log.logHandoff(harnessId);
    return { logSeq: written.record.logSeq, first: written.created || log.handoffUsed?.(written.record.logSeq) === false };
  }
  /**
   * The native title of a session a handoff opened (ADR-055 §8.1, VF3-12), set before its first prompt within RELAY_READ_MS:
   * the conversation's public title (its first words), "新对话" when it holds anything the relay would redact (§10.2's egress
   * scan); `set`, `refused` (the Driver said no) or `unavailable` (late, or failed). Its failure never fails the Turn.
   */
  private async titleFor(control: HarnessControl, native: NativeConversationId, firstWords: string, secrets: readonly string[]): Promise<"set" | "refused" | "unavailable"> {
    const first = firstWords.replace(/\s+/gu, " ").trim().slice(0, 80);
    const title = first === "" || relayRedactor(secrets).redact(first).hits > 0 ? "新对话" : first;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = control.setTitle!(native, title).then(() => "set" as const, (error: unknown) => fault(error).code === "NATIVE_TITLE_UNAVAILABLE" ? "refused" as const : "unavailable" as const);
      return await Promise.race([done, new Promise<"unavailable">(resolve => { timer = setTimeout(() => resolve("unavailable"), RELAY_READ_MS); timer.unref?.(); })]);
    } catch { return "unavailable"; } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  /** How the native side reads an input: its driver's reading, or the shared one (listedCommand) for a driver without one. */
  private classify(control: HarnessControl, text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[]): CommandClass {
    // C7 (G072): the Driver's relay declaration reads it when it has one (the same reading as its own, with acceptsRelay); its
    // catalog's commands as the declaration's entries, a command declaring no effect an unknown one (relay-classify relayEntries).
    const declared = control.relayCapabilities;
    if (declared !== undefined) return declared.commands.classify(text, catalog === null ? null : (catalog.commands ?? []).map(command => ({ name: command.name, effect: command.contextEffect ?? "unknown" })), attachments);
    return control.classify ? control.classify(text, catalog, attachments) : listedCommand(text, catalog);
  }
  /**
   * The known secrets of the Harnesses a packet carries, from the factory (M1). Its refusals pass on as they are (it names
   * a configuration it could not read with RELAY_PREPARE_FAILED; ownership and cancellation keep their codes); any other
   * failure is the relay's too (N3), never the target Harness's: the Turn fails undispatched and what it owes stays owed.
   */
  private async relaySecretsOf(history: RelayHistory, configuration: SessionConfiguration, run: Pick<PublicRun, "selection">, sources: readonly PublicRun["id"][], origin: boolean): Promise<readonly string[]> {
    if (this.factory.relaySecrets === undefined) return [];
    try { return await this.factory.relaySecrets(configuration, this.relayHarnesses(history, run, sources, origin)); }
    catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError("RELAY_PREPARE_FAILED", "没能准备交接单：读取交接单必须隐去的凭据时出错，这条消息没有发出。修好后再发；也可以只发这条消息，不带交接单。");
    }
  }
  /**
   * The Harnesses whose history a packet carries (ADR-055 §10.2, review M1): the owed Runs' and, when the Session's own
   * starting history is owed, its messages' (an import's Harness included), with the target's own.
   */
  private relayHarnesses(history: RelayHistory, run: Pick<PublicRun, "selection">, sources: readonly PublicRun["id"][], origin: boolean): readonly string[] {
    const ids = new Set<string>([run.selection.harnessId]), owed = new Set<string>(sources);
    for (const source of history.runs) if (owed.has(source.id)) ids.add(source.selection.harnessId);
    const quoted = origin ? history.origin : undefined;
    if (quoted !== undefined) {
      if (quoted.kind === "import") ids.add(quoted.harnessId);
      for (const message of quoted.history) if (message.harnessId !== undefined) ids.add(message.harnessId);
    }
    return [...ids].sort();
  }
  /**
   * What the relay packet may quote of the owed Runs' stored tool details (ADR-055 §6.4), read back within bounds: the
   * commands, changes, reads and searches of the first owed Run and the 12 latest, ≤32 a Run, ≤128 in all, whatever the size of each (what is kept of a large one: `RELAY_DETAIL_POLICY`).
   * A detail that cannot be read (no store that reads back, gone, changed, not JSON) is left out: the packet then lists
   * that tool by its title and its ledger says how many were not read.
   */
  private async relayDetails(history: RelayHistory, sources: readonly PublicRun["id"][]): Promise<ReadonlyMap<string, RelayToolDetail>> {
    const content = this.options.content, details = new Map<string, RelayToolDetail>();
    if (content === undefined || (content.readText === undefined && content.readChunks === undefined)) return details;
    // Only the Turns whose details are read are read: the first owed Run's and the 12 latest.
    const position = new Map(history.runs.map((run, index) => [run.id as string, index]));
    const runs = [...new Set([...sources.slice(0, 1), ...sources.slice(-12)])].flatMap(id => { const turn = outlineOf(history, position.get(id) ?? -1); return turn === null ? [] : [turn.run]; });
    let left = 128;
    for (const run of runs) {
      let taken = 0;
      for (const tool of run.tools ?? []) {
        if (left === 0 || taken === 32) break;
        if (tool.detail === undefined || tool.parentId !== undefined || !["execute", "change", "read", "search"].includes(toolFamily(tool))) continue;
        taken++; left--;
        // Whatever its size: the command and the paths whole, an output too long to keep as its last lines (finding 1 of the cut review).
        const read = await readDetail(content, tool.detail, RELAY_DETAIL_POLICY);
        if (read !== null) details.set(run.id + "/" + tool.id, relayDetailOf(read));
      }
    }
    return details;
  }
  /** The conversation's public facts foreign to a binding (ADR-055 §2), with their fact seqs and where they ran: read from its Runs' rows. */
  private relayFacts(state: Conversation, binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }): readonly RelayFact[] {
    return this.ledger.facts(state, binding);
  }
  /**
   * The relay choices this input was accepted with, as its acceptance event records them; none without a record. Those this
   * owner accepted it kept (acceptedRelay), so it reads the event only for an input an earlier owner accepted.
   */
  private choicesOf(state: Conversation, run: ConversationRun): RelayChoices {
    const kept = this.acceptedRelay.get(run.id);
    if (kept !== undefined) return kept;
    const accepted = this.store.events(state.id, run.userSeq - 1, 1)[0];
    return accepted?.type === "message.accepted" && accepted.data.runId === run.id ? acceptedChoices(accepted.data) : {};
  }
  /**
   * A request the conversation's worker was serving (its switch, its native fork, its next Turn) failed for a rule of the rows and not of the store: that request ends with the reason, told
   * in the conversation, and the conversation and the Runtime go on. A switch fails (and the inputs waiting for it); a fork is given up as a branch whose native session could not be
   * made; a queued Turn fails undispatched. If even that cannot be written for a rule of the rows, the conversation is left as it is and the worker stops serving it for now
   * (false); a store that cannot be trusted stalls the Runtime instead, as it always did.
   */
  private endRequest(id: SessionId, error: unknown): boolean {
    const why = fault(error), at = this.options.now().getTime();
    try {
      this.commit(id, current => {
        const switchId = current.pendingSwitchId;
        if (switchId !== null) {
          const waiting = current.runs.filter(row => row.status === "queued" && row.awaitingSwitchId === switchId).map(row => row.id);
          return { next: this.strandSwitch(current, switchId, waiting, at, why), events: [event("switch.failed", { switchId, error: why, reason: "the switch could not be applied" }),
            ...waiting.map(queuedId => event("run.ended", { runId: queuedId, status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE" }, neverDispatched: true }))] };
        }
        const fork = current.nativeBindings?.find(binding => binding.status === "fork-pending" || binding.status === "forking");
        if (fork !== undefined) {
          return { next: { ...current, nativeBindings: current.nativeBindings!.map(binding => binding === fork ? { ...binding, status: "archived" as const } : binding) },
            events: [event("native.fork_failed", { harnessId: fork.harnessId, controlId: fork.controlId, error: why, continuity: "public_context_rehydrate" })] };
        }
        const queued = current.runs.find(row => row.status === "queued");
        if (queued !== undefined) return { next: updatedRun(current, queued.id, { status: "failed", error: why, ...phase(current, queued.id, "endedAt", at) }), events: [event("run.ended", { runId: queued.id, status: "failed", error: why, neverDispatched: true })] };
        return { next: current, events: [event("session.request_failed", { error: why })] };
      });
      return true;
    } catch (second) {
      this.stalls(second, id);
      return false;
    }
  }
  /**
   * A Turn's end could not be written in any form for a rule of the rows (not for the store): the Runtime goes on, and the log says so. The Turn stays as the rows have it until the next start's recovery
   * ends it as unknown; nothing the rows hold is changed here, so that the event is written whatever rule refused the rest.
   */
  private endUnrecorded(id: SessionId, runId: PublicRun["id"], error: unknown): void {
    try { this.commit(id, current => ({ next: current, events: [event("run.end_unrecorded", { runId, error: fault(error) })] })); }
    catch (second) { this.stalls(second, id); }
  }
  /** The pending switch fails as stranded, and each input waiting for it ends as not dispatched (SWITCH_NOT_EFFECTIVE). */
  private strandSwitch(state: Conversation, switchId: string, waiting: readonly PublicRun["id"][], endedAt: number, error: { readonly code: string; readonly message: string } = STRANDED_SWITCH): Conversation {
    let next: Conversation = { ...state, pendingSwitchId: null, switches: state.switches.map(sw => sw.id === switchId ? { ...sw, status: "failed" as const, error } : sw) };
    for (const queued of waiting) next = updatedRun(next, queued, { status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE", message: "requested Harness switch failed; this input was not dispatched" }, ...phase(next, queued, "endedAt", endedAt) });
    return next;
  }
  private unknownOwnership(problem: ReturnType<typeof fault> | null): boolean {
    return problem !== null && ["OWNER_LOST", "OWNERSHIP_LOST", "WORKSPACE_OWNERSHIP_LOST", "BINDING_CLEANUP_FAILED", "CLEANUP_FAILED", "WORKSPACE_QUARANTINED"].includes(problem.code);
  }
}
