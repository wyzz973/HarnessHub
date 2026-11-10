import { createHash } from "node:crypto";
import { parseProviderTarget } from "../../../contracts/provider.js";
import { TOOL_DIFF_BYTES, TOOL_INPUT_BYTES, TOOL_OUTPUT_BYTES, listedCommand, type TurnText, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlRun, type HarnessControl, type NativeConversationId, type NativeModelCatalog, type NativeToolDetail, type NativeUsage } from "../../../contracts/control.js";
import { MAX_RUN_ATTACHMENTS, MAX_RUN_OUTPUTS, type ContentKind, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId, DEFAULT_EXECUTION_BUDGET_MS, DEFAULT_WAIT_BUDGET_MS, MAX_PARALLEL_CONVERSATIONS, STOP_GRACE_MS, STREAM_WINDOW_BYTES, STREAM_WINDOW_MS,
  type AttentionItem, type ForkedMessage, type HarnessSelection, type KeptProcessIdentity, type OutsideEvidence, type OutsideProcess, type NativeConfiguration, type NativeSessionBinding, type PermissionRequest, type CancelReceipt, type CommandId, type EventDraft, type PreparedSessionBinding, type PublicNotice, type PublicRun, type RunTiming,
  type SelectionRequest, type SendReceipt, type SessionBindingFactory, type SessionCommit, type SessionConfiguration,
  type SessionId, type SessionEvent, type SessionMutation, type SessionRuntimeOptions, type SessionSnapshot, type SessionStore, type SwitchReceipt,
} from "../../../contracts/session.js";
import { buildPublicContext, type PublicContext, type PublicContextOptions } from "../domain/context.js";
import { parseToolDetail, type RelayToolDetail } from "../domain/relay/narration.js";
import { commandEffect, commandOutcome, dispatched, type InputOutcome } from "../domain/relay/advance.js";
import { initialBindingRelay } from "../domain/relay/migrate.js";
import { BLOCKED_CODES, RelayError, consentSourceOf, markOf, relayDecisionOf, type RelayAttention, type RelayDecision, type BindingRelayState, type ConsentAppend, type ConsentRecord, type DeliveryPosition, type EndpointLayer, type RelayCapabilities, type RelayDeliveryWrite, type RelayIndexRow, type RelayInstallationNotice, type RelayKeyPort, type RelayLogPort, type RelayPacket, type RelayPrefKey, type RelayStorePort, type RelayWindow, type VendorKey, type VendorObservation, type VerifyResult, parseVendorObservation } from "../../../contracts/relay.js";
import { relayRedactor } from "../domain/relay/redaction.js";
import { cacheAfter, hardCap, observedWindow, packetBudget, packetFamily, resolveWindow, windowRow, fitsMinPacket, type ResolvedWindow } from "../domain/relay/windows.js";
import { estimateTokens, type RelayBudget } from "../domain/relay/budget.js";
import { returnChoice, returnPreference, warm as cacheWarm } from "../domain/relay/return-policy.js";
import { mayReuseKept, owed, planReturnVerify, step, type BindingDelivery, type RelayFact } from "../domain/relay/delivery.js";
/**
 * How long a relay read on a Turn's connection (a check at the open or at a settlement, the position before dispatch) may take
 * before it counts as unavailable (ADR-055 §6.1, C6: ≤2 s); a read still outstanding at the open is waited for as long again
 * before dispatch, and the Turn is not dispatched while it is.
 */
const RELAY_READ_MS = 2000;
import {
  CONSENT_CATEGORIES, RelayLedger, UnkeptRelayKeys, attentionOf, crossHarnessFacts, acceptedChoices, admitCarrying, bindingDeliveries, carriesWithReading, checkStep, checkWorthAnEvent, checkedResult, clearNotConfirmed, consentCommandOf, consentGate, consentRequired, consentStanding, continuityOf, crossVendor,
  dataRootInWorkspace, decideTurn, decisionRecord, defaultAllowAppend, deliveryRow, explicitChoice, heldSinceIn, holdsNothing, inputLimit, markIn, nativeExactAt, needRuns, outcomeWrites, packetManifest, parseRelayChoices, policyAloneOf, probeGate, rangeOf, recordedStep, relayAdmission, relayDeclaration,
  relaySettings, renderView, retreatEvent, runRelayOf, runRelayRequest, settleTurn, sourceVendors, undeclaredReading, unavailableResult, vendorKeyOf, verifiedEvent, verifyRequestOf,
  type AdmitGates, type AdmitInput, type AttentionInput, type CarriedTurn, type Carrying, type Check, type ConsentStanding, type ConsentView, type DecisionCause, type RelayChoices, type RelayDeclaration, type RelaySettings, type SettledTurn, type TurnDecision,
} from "./relay-coordinator.js";
import { MAX_COMMANDS, MAX_OUTPUT_BYTES, MAX_PLAN_ENTRIES, MAX_QUEUE, MAX_RUNS, MAX_RUN_ACTIVITIES, MAX_RUN_NOTICES, MAX_RUN_TOOLS, assertInput, carriedNativeConfiguration, parseConfiguration, parseNativeConfiguration, replayCommand, terminal, utf8Bytes } from "../domain/state.js";

interface ActiveExecution {
  readonly sessionId: SessionId;
  readonly runId: string;
  binding: PreparedSessionBinding | null;
  run: ControlRun | null;
  dispatched: boolean;
  backendSettled: boolean;
  stop: Promise<void> | null;
  earlyClose: Promise<CleanupEvidence> | null;
  /** Latest bounded native tool details, kept in memory until stored as content. */
  readonly details: Map<string, NativeToolDetail>;
  readonly dirty: Set<string>;
  /** Sequential content writes owned by this Turn; drained before its binding closes. */
  writes: Promise<void>;
  writeFailure: unknown;
  /** Where this Turn's stderr begins in its program's stderr, for its diagnostics; null before a program serves it. */
  diagnosticMark: number | null;
  /**
   * The Turn's budgets (ADR-036): what is left of each, whether it waits for the user now, since when (monotonic), and the
   * timer of the one that runs.
   */
  readonly budget: { executionLeftMs: number; waitLeftMs: number; waiting: boolean; since: number; timer: ReturnType<typeof setTimeout> | null };
  /** Why the Runtime stopped this Turn on its own, when it did. */
  stopReason: "RUN_TIMEOUT" | "WAIT_EXPIRED" | null;
  /** Ends the program when it has not settled once the stop grace has passed. */
  grace: ReturnType<typeof setTimeout> | null;
  /**
   * What the program streamed and this Turn has not committed yet (ADR-047): one window of reply text or thinking, the UTF-8
   * bytes of that kind as they stand once the window is committed (`committedBytes` of them were committed before it; `last`
   * is the final UTF-16 code unit, so a pair split between chunks is counted once), and the window's timer, owned by the Turn.
   */
  readonly stream: { kind: "text" | "thinking" | null; text: string; committedBytes: number; bytes: number; last: string; cancel: (() => void) | null };
  /** A window refused outside a driver callback (by its timer, a stop or a close); reported as the Turn's failure. */
  streamFailure: unknown;
  /** The Turn's relay (ADR-055 §6.1, §7; G068 phase two): what it checked, sent and saw recorded, until its end commits it. */
  readonly relay: TurnRelay;
}
/** What G072's checks at the open found for a carrying Turn (Runtime.openGates). */
interface OpenGate {
  readonly vendor: VendorKey;
  /** The Driver was asked for its vendor and could not tell: the packet is recorded for the honest unknown key, and the epoch's consent key is left as it was. */
  readonly unseen: boolean;
  readonly window: ResolvedWindow;
  readonly budget: RelayBudget;
  readonly clamped: readonly ("window" | "input_limit")[];
  readonly consentLogSeq: number | null;
  /** How a return to a binding that stood on its own mark continued (§7.3): the request's `native`, the preference's default; null when it was no return. */
  readonly returning: "continue" | "new" | null;
  /**
   * The consent this handoff rests on is the default's (permissive-defaults §2.4): no row of the log stands for the vendor, so its
   * first use writes one before the Turn is committed (`consentLogSeq` is then that row's). Null when a recorded consent stands or none is needed.
   */
  readonly trace: { readonly vendor: VendorKey; readonly authKind: string | null } | null;
  /** The epoch's earlier vendor key this handoff leaves while the preference lets it go (recorded as relay.vendor_changed, not asked). */
  readonly changedFrom: VendorKey | null;
  /** What stood for the vendor ("default" when the preference allowed it by itself), for the Turn's record; null when no consent was needed. */
  readonly consentVia: Extract<ConsentStanding, { kind: "given" }>["via"] | "exempt" | null;
  /** The vendor's endpoint layer (a workspace file's, a user setting's…), shown with the first use of a key the user never named. */
  readonly layer: EndpointLayer | null;
  /**
   * This is the vendor's first use as a default allowance: the Turn that writes its row (`trace`), or a later one while no delivery
   * row of the installation names the row yet — the Turn that wrote it may have gone alone after all, having told no one anything.
   * The Turn's record says `first` and the page gives its one-line notice with it (G072 review m2).
   */
  readonly first: boolean;
  /** A cross-vendor handoff into a workspace the data directory is in reach of, which the setting only warns about (permissive-defaults §2.4). */
  readonly exposed: boolean;
}
/** C7 (G072): the reading of the input changed between admission and the open in a way that matters to the relay. */
function classificationChanged(): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "classification_changed" }, "没能准备这条消息：受理时和打开原生会话后对这条消息是不是命令的判断不一致，这条消息没有发出，草稿已保留。可以再发一次，或只发这条消息。");
}
/** What a Turn holds of the relay between its preparation and its end (relay-coordinator.ts does the deciding). */
interface TurnRelay {
  declaration: RelayDeclaration;
  /** The open's check, until a commit carries it (its authorization, or its end when it fails before). */
  openCheck: Check | null;
  /** What the Turn was authorized to send (none before its authorization). */
  turn: SettledTurn;
  /** after_turn's check at the settlement, planned on the provisional settlement. */
  settledCheck: Check | null;
  /** The Driver said the input was recorded (E1); for a packet, once committed. */
  recorded: boolean;
  /**
   * The relay's own reads on the Turn's connection (a check, the position; ADR-055 C6, G068 fix batch R2): whether one was
   * asked, and the connection's health (`healthy()`) before the first; the reads given up on at their bound and still
   * outstanding (the connection is never kept after one, and no input is dispatched while one is); and `broke`: a read left the
   * connection failed that was not failed before it, or was given up on for good — that failure is the relay's, never the Turn's.
   */
  readonly io: { asked: boolean; healthy: boolean | undefined; readonly abandoned: Promise<void>[]; broke: boolean };
  /** The Store refused this Turn's E1 (R6): it is not tried again in this Turn (G068 fix batch 2, M-9). */
  e1Refused: boolean;
  /** The conversation's Harness control the Turn's reads are made for (`brokenReads`); null before the Turn knows it. */
  key: string | null;
  /**
   * What the Driver observed of the endpoint and model after the open (relayVendor, ADR-055 §10.4): cached on the binding with
   * the Turn's next commit, its end included (a Turn that fails on consent still teaches the next admission the vendor); null
   * when the Driver could not tell, undefined when it was not asked.
   */
  observed: VendorObservation | null | undefined;
  /** Relay events the Turn's end commits after `run.ended` besides its settlement's (relay.vendor_changed of a Turn refused for it). */
  readonly endEvents: EventDraft[];
  /** The consent a carrying Turn's dispatch rests on, read again before dispatch (§10.4: withdrawn → not dispatched). */
  consent: { readonly vendor: VendorKey; readonly layer: EndpointLayer | null; readonly target: HarnessSelection;
    /** The other keys the Harness control is known by when its vendor could not be read (openGates knownKeys): a withdrawal of any of them stops the dispatch too. */
    readonly also: readonly VendorKey[];
    /** The log seq of the consent this request itself gave and the dispatch rests on; null when it rests on another record. */
    readonly requestSeq: number | null } | null;
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
type KeptRelease = "idle" | "disabled" | "ended_by_user" | "selection_changed" | "conversation_closed" | "native_reset" | "branched" | "exited" | "gateway_shutdown" | "harness_upgrade" | "relay_check";
/** At most this many processes are kept at once (ADR-030). */
const KEPT_LIMIT = 4;
/** A kept process without a Turn for this long is closed (ADR-030). */
export const KEPT_IDLE_MS = 30 * 60 * 1000;
function sameSelection(left: HarnessSelection, right: HarnessSelection): boolean {
  return left.harnessId === right.harnessId && left.controlId === right.controlId && JSON.stringify(left.provider ?? null) === JSON.stringify(right.provider ?? null)
    && (left.nativeModel ?? null) === (right.nativeModel ?? null) && JSON.stringify(Object.entries(left.nativeOptions ?? {}).sort()) === JSON.stringify(Object.entries(right.nativeOptions ?? {}).sort());
}
const TERMINAL_TOOL = new Set(["completed", "failed", "declined", "cancelled", "interrupted", "error"]);
/** Run statuses of a Turn not yet settled: it is queued, waits for a slot or workspace, or runs. */
const OPEN_RUN = new Set<PublicRun["status"]>(["queued", "preparing", "running", "settling"]);
/** Byte-bounded UTF-8 text; the tail is kept for streams whose end carries the result. */
function bounded(value: string, maximum: number, tail = false): { readonly text: string; readonly cut: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return { text: value, cut: false };
  const slice = tail ? bytes.subarray(bytes.length - maximum) : bytes.subarray(0, maximum);
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(slice).replace(/^\uFFFD|\uFFFD$/gu, ""), cut: true };
}
function mergeDetail(prior: NativeToolDetail | undefined, next: NativeToolDetail): NativeToolDetail {
  let cut = prior?.truncated === true || next.truncated === true;
  const field = (value: string | undefined, fallback: string | undefined, maximum: number, tail = false): string | undefined => {
    if (value === undefined) return fallback; const result = bounded(value, maximum, tail); cut ||= result.cut; return result.text;
  };
  const input = field(next.input, prior?.input, TOOL_INPUT_BYTES), output = field(next.output, prior?.output, TOOL_OUTPUT_BYTES, true), diff = field(next.diff, prior?.diff, TOOL_DIFF_BYTES);
  const locations = (next.locations ?? prior?.locations)?.slice(0, 16).map(path => bounded(path, 1024).text);
  const kind = next.kind ?? prior?.kind, name = next.name ?? prior?.name, parentId = next.parentId ?? prior?.parentId, exitCode = next.exitCode ?? prior?.exitCode;
  return { ...(kind === undefined ? {} : { kind: kind.slice(0, 64) }), ...(name === undefined ? {} : { name: name.slice(0, 256) }), ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
    ...(diff === undefined ? {} : { diff }), ...(locations === undefined ? {} : { locations }), ...(exitCode === undefined ? {} : { exitCode }), ...(parentId === undefined ? {} : { parentId: parentId.slice(0, 512) }), ...(cut ? { truncated: true } : {}) };
}
/** Event-log form of a native event: summaries only, never stored bytes or large previews. */
function logged(value: ControlEvent): ControlEvent | Readonly<Record<string, unknown>> {
  if (value.type === "tool") { const { detail, ...summary } = value; return detail === undefined ? summary : { ...summary, ...(detail.kind === undefined ? {} : { kind: detail.kind }), ...(detail.name === undefined ? {} : { name: detail.name }), ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(detail.parentId === undefined ? {} : { parentId: detail.parentId }) }; }
  if (value.type === "output" && value.output.kind === "content") { const summary: Readonly<Record<string, unknown>> = { type: "output", output: { kind: "content", name: value.output.name, mediaType: value.output.mediaType, bytes: value.output.data.byteLength } }; return summary; }
  return value;
}
function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 96) || "tool"; }
/**
 * UTF-8 bytes of `prior + next` from `priorBytes`, re-encoding only the last code unit of `prior`: a surrogate pair split
 * between two chunks is three bytes on each side alone and four together, so a window's count stays exact (ADR-047).
 */
function joinedBytes(priorBytes: number, priorLast: string, next: string): number {
  return priorBytes - utf8Bytes(priorLast) + utf8Bytes(priorLast + next);
}
const MAX_PENDING_CREATES = 16;
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
/** Quoted native history of a continued session: well inside the 1 MiB public context, so its branches still fit. */
const MAX_IMPORTED_MESSAGES = 200, MAX_IMPORTED_BYTES = 512 * 1024;
function fault(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SessionError) return { code: error.code.slice(0, 128), message: error.message.slice(0, 512) };
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 128) : "CONTROL_FAILED";
  return { code, message: "Harness operation failed; inspect private control diagnostics" };
}
/** How much of a Turn's stderr is kept for its diagnostics, and for how many Turns. */
const RUN_DIAGNOSTIC_BYTES = 4096, MAX_RUN_DIAGNOSTICS = 64;
/** Longest wait a driver may announce for one request (a day); anything else is ignored rather than shown. */
const MAX_PERMISSION_WAIT_MS = 24 * 60 * 60 * 1000;
/**
 * Why a Turn is not dispatched when the connection the relay read on (its check, the position) failed, or a read is still
 * outstanding, before the input went (ADR-055 C6, G068 fix batch R2): nothing reached the Harness (`target_start`).
 */
function notReached(): RelayError {
  return new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "target_start" }, "原程序的连接在核对交接记录时出了问题，这条消息没有发出，草稿已保留。可以再发一次。");
}
/** A commit's failure that fails only what asked for it (INV-35: a relay error; a bound), never the Runtime. */
function expectedFailure(error: unknown): boolean {
  return error instanceof RelayError || error instanceof SessionError && ["CONTEXT_TOO_LARGE", "OUTPUT_LIMIT", "QUEUE_FULL", "COMMAND_LIMIT", "RUN_LIMIT", "SESSION_LIMIT", "EVENT_LIMIT"].includes(error.code);
}
/**
 * What a Driver's report of a clear (BackendResult.native) is to the relay (ADR-055 §7.4, B7; G072 review I2). A clear that replaced
 * the native session is the Hub's own Driver giving the session up (Claude Code's synthesized clear): certain once the Turn's native
 * state is confirmed, and not looked at otherwise. A clear the Driver concluded from the native side's own signal (`replaced` null:
 * Hermes' fixed receipt, OpenClaw's lifecycleRevision) is certain only for a Driver whose probes proved that signal; an unprobed
 * Driver's report is a clear the relay cannot confirm (e′), which the next open's check or the user's [确认已清空] settles — a floor
 * and an epoch are raised by evidence, not by a report nothing has verified. Null when nothing was reported or it cannot count.
 */
export function clearReportOf(cleared: { readonly replaced: unknown } | undefined, probed: boolean, confirmed: boolean): { readonly replaced: boolean; readonly confirmed: boolean } | null {
  if (cleared === undefined) return null;
  if (cleared.replaced === null) return { replaced: false, confirmed: probed };
  return confirmed ? { replaced: true, confirmed: true } : null;
}
/** Why a switch fails when the Turn it waited for ended without confirmed settlement (ADR-055 §9, RT2-04). */
const STRANDED_SWITCH = { code: "SWITCH_SOURCE_UNKNOWN", message: "the Turn this switch waited for ended without confirmed settlement; the switch was not applied" } as const;
/**
 * How the user sends one input with respect to the conversation's history (ADR-055 §9, §12.4): `attach: "none"` sends it
 * alone ("只发这条消息"), exactly as typed, and what its Harness is owed stays owed; `attach: "full"` attaches the history
 * once even below a clear floor, and on a binding in doubt sends the complete packet again ("补发完整交接单"); `resend` sends a
 * packet whose delivery is unconfirmed again ("再附一次"); `clearConfirmed` is the user's ［确认已清空］.
 */
export type RelayChoice = RelayChoices;
/** A duration in the user's words: seconds below a minute, whole minutes otherwise. */
function duration(ms: number): string { return ms < 1000 ? ms + " 毫秒" : ms < 60_000 ? Math.round(ms / 1000) + " 秒" : Math.round(ms / 60_000) + " 分钟"; }
/** What the conversation says when the Runtime stopped a Turn on its own (ADR-036). */
function budgetNotice(kind: "execution" | "wait", budgetMs: number): PublicNotice {
  return kind === "wait" ? { severity: "warning", title: "等待期限已到", detail: `等待你的决定超过 ${duration(budgetMs)}，本回合已取消；原程序没有收到决定。` }
    : { severity: "warning", title: "执行期限已到", detail: `本回合的执行时间（不含等待你的时间）超过 ${duration(budgetMs)}，HarnessHub 已停止它。` };
}
/** Adds a notice of the Hub itself to a Run, within the Run's notice budget. */
function withNotice(state: SessionSnapshot, id: string, notice: PublicNotice): SessionSnapshot {
  const run = state.runs.find(item => item.id === id);
  if (run === undefined || (run.notices ?? []).length >= MAX_RUN_NOTICES) return state;
  return updatedRun(state, id, { notices: [...(run.notices ?? []), notice] });
}
function updatedRun(state: SessionSnapshot, id: string, patch: Partial<PublicRun>): SessionSnapshot {
  const prior = state.runs.find(run => run.id === id);
  if (!prior) throw new SessionError("IDENTITY_MISMATCH", "Run is not owned by this Session");
  const next = { ...prior, ...patch };
  return { ...state, runs: state.runs.map(run => run.id === id ? next : run),
    messages: state.messages.map(message => message.runId === id ? { ...message, status: next.status } : message) };
}
function event(type: string, data: Readonly<Record<string, unknown>>): EventDraft { return { type, data }; }
/** Native events that the user sees in the conversation; the first of them marks the Run's first output. */
const VISIBLE_OUTPUT = new Set<ControlEvent["type"]>(["text", "thinking", "tool", "plan", "permission_requested", "output", "activity"]);
/**
 * The Run patch that records one more phase at `now`, never before a phase already recorded (a clock that steps back keeps
 * the order). A Run without timing (accepted before Session v10) and a phase already recorded stay as they are.
 */
function phase(state: SessionSnapshot, id: PublicRun["id"], name: Exclude<keyof RunTiming, "acceptedAt">, now: number): Partial<PublicRun> {
  const timing = state.runs.find(run => run.id === id)?.timing;
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
  private readonly creating = new Set<Promise<SessionSnapshot>>();
  /** Conversations with work their worker has not taken yet (ADR-036). */
  private readonly work = new Set<SessionId>();
  /** Callers of `wait` whose conversation's work is not taken yet; woken after every scheduling pass. */
  private readonly wakers = new Set<() => void>();
  /** The worker serving each conversation that has one: it runs that conversation's work in order; at most `maxParallel` run at once. */
  private readonly workers = new Map<SessionId, Promise<void>>();
  /** The Turn each conversation is executing, at most one per conversation. */
  private readonly actives = new Map<SessionId, ActiveExecution>();
  /** The workspace each worker holds while it serves its conversation; another conversation's work there waits (ADR-036). */
  private readonly holders = new Map<string, SessionId>();
  /** Conversations whose next Turn waits for a workspace another conversation's work holds, with since when. */
  private readonly waitingForWorkspace = new Map<SessionId, { readonly runId: string; readonly holder: SessionId; readonly since: number; readonly sinceMono: number; readonly timer: ReturnType<typeof setTimeout> }>();
  /** Conversations whose next Turn waits for a slot while every slot is taken, with since when (ADR-036); no budget runs. */
  private readonly waitingForSlot = new Map<SessionId, { readonly runId: string; readonly since: number }>();
  /** How much of each Turn's wait budget its waits for a workspace used before it started (ADR-036). */
  private readonly waitUsed = new Map<string, number>();
  /** The conversation that held the workspace of each Turn this owner ended with WORKSPACE_BUSY, latest first out. */
  private readonly busyHolders = new Map<string, SessionId>();
  private readonly permissions = new Map<string, { request: PermissionRequest; nativeId: string; execution: ActiveExecution; option: string | null; command: string | null; readonly harnessId: string }>();
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
    if (input !== undefined && (typeof input !== "string" || Buffer.byteLength(input) > 65536 || input.includes("\0"))) throw new SessionError("INVALID_INPUT", "invalid native input response");
    const state = this.load(id), fingerprint=this.fingerprint({kind:"permission",permission,option,...(input===undefined?{}:{input})}), prior=replayCommand(state,command,"permission",fingerprint);
    if (prior) return {replayed:true};
    this.commandBudget(state);
    const pending = this.permissions.get(permission);
    if (!pending || pending.execution.sessionId !== id || !pending.request.options.some(value => value.id === option)) throw new SessionError("PERMISSION_UNAVAILABLE", "native permission or option is no longer pending");
    if(input!==undefined&&(!pending.request.input||Buffer.byteLength(input)>65536||input.includes("\0")))throw new SessionError("INVALID_INPUT","invalid native input response");
    if (pending.option !== null) { if (pending.option === option && pending.command === key) return { replayed: true }; throw new SessionError("PERMISSION_CONFLICT", "native permission has already been decided"); }
    this.continue(pending.execution);
    const control = pending.execution.binding?.control;
    if (!control?.decidePermission) throw new SessionError("UNSUPPORTED_PERMISSION", "native approval is unavailable");
    pending.option = option; pending.command = key; pending.request = { ...pending.request, decided: true };
    try { this.commit(id, current => ({ next: { ...current, commands:[...current.commands,{id:command,kind:"permission",fingerprint,resultId:pending.execution.runId}] }, events: [event("permission.decided", { permissionId: permission, runId: pending.execution.runId, optionId: option, commandId: key })] })); }
    catch(error) { pending.option=null;pending.command=null;pending.request={...pending.request,decided:false};throw error; }
    this.leaveWait(pending.execution);
    await control.decidePermission(pending.nativeId, option, input); this.owned(pending.execution);
    this.permissions.delete(permission);
    this.commit(id, current => ({ next: current, events: [event("permission.submitted", { permissionId: permission, runId: pending.execution.runId, optionId: option, backendAcknowledged: false })] }));
    return { replayed: false };
  }
  /** The switch target each conversation is validating, at most one per conversation. */
  private readonly switchBindings = new Map<SessionId, { readonly binding: PreparedSessionBinding; close: Promise<CleanupEvidence> | null }>();
  private fatal: SessionError | null = null;
  private publicationFailed = false;
  private recordingBlock = false;
  private shutdown: Promise<void> | null = null;

  /** The facts each conversation's events place (ADR-055 §2), read incrementally by this owner. */
  private readonly ledger: RelayLedger;
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
  /**
   * The conversations' Harness controls (`readsKey`) on which a relay read broke the connection or was given up on at its bound
   * (G068 fix batch 2, M-3): their later Turns in this process ask the Driver nothing more — a check answers unavailable, a
   * position none — so that a read that breaks the connection every time cannot keep every input of the binding, one sent alone
   * included, from being dispatched. Kept in memory only: a new owner asks again.
   */
  private readonly brokenReads = new Set<string>();

  constructor(private readonly store: SessionStore, private readonly factory: SessionBindingFactory, private readonly options: SessionRuntimeOptions) {
    this.ledger = new RelayLedger((id, after, limit) => this.store.events(id, after, limit));
    this.relayKeys = options.relayKeys ?? new UnkeptRelayKeys();
  }

  create(configuration: SessionConfiguration, selection: SelectionRequest, key: string): Promise<SessionSnapshot> {
    try {
      this.admit();
      if (this.creating.size >= MAX_PENDING_CREATES) throw new SessionError("CREATE_LIMIT", "at most " + MAX_PENDING_CREATES + " Session creations may be awaiting validation");
    } catch (error) { return Promise.reject(error); }
    const pending = this.createOwned(configuration, selection, key);
    this.creating.add(pending);
    void pending.then(() => { this.creating.delete(pending); }, () => { this.creating.delete(pending); });
    return pending;
  }
  private async createOwned(configuration: SessionConfiguration, selection: SelectionRequest, key: string): Promise<SessionSnapshot> {
    this.admit();
    const config = parseConfiguration(configuration), request = requested(selection), command = commandId(key);
    const fingerprint = this.fingerprint({ kind: "create", configuration: config, selection: request });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return prior; }
    const validated = await this.factory.validate(request, config);
    this.admit();
    // Validation has an await boundary; another create may have committed the same command in the meantime.
    const concurrent = this.store.findByCreateKey(command);
    if (concurrent) { replayCommand(concurrent, command, "create", fingerprint); return concurrent; }
    const id = sessionId("session-" + this.options.id());
    const state: SessionSnapshot = { schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open",
      configuration: config, selection: validated, activeRunId: null, pendingSwitchId: null,
      runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "public_context_rehydrate" })]);
      this.managedSessions.add(committed.session.id);
      return this.publish(committed).session;
    }
    catch (error) { this.fail(error, id); throw error; }
  }

  /**
   * Continues a native session of the installed Harness as a new conversation. The session must belong to this workspace
   * and no other conversation may hold it; its recent messages are quoted (never re-executed) and its reference becomes
   * this conversation's native session, so the next input goes to it directly. Nothing is sent to a model.
   */
  importNative(configuration: SessionConfiguration, selection: SelectionRequest, nativeId: string, key: string): Promise<SessionSnapshot> {
    try {
      this.admit();
      if (this.creating.size >= MAX_PENDING_CREATES) throw new SessionError("CREATE_LIMIT", "at most " + MAX_PENDING_CREATES + " Session creations may be awaiting validation");
    } catch (error) { return Promise.reject(error); }
    const pending = this.importOwned(configuration, selection, nativeId, key);
    this.creating.add(pending);
    void pending.then(() => { this.creating.delete(pending); }, () => { this.creating.delete(pending); });
    return pending;
  }
  private async importOwned(configuration: SessionConfiguration, selection: SelectionRequest, nativeId: string, key: string): Promise<SessionSnapshot> {
    this.admit();
    if (typeof nativeId !== "string" || !nativeId.trim() || Buffer.byteLength(nativeId) > 1024 || /[\0-\x1f\x7f]/u.test(nativeId)) throw new SessionError("INVALID_INPUT", "invalid native session identity");
    const config = parseConfiguration(configuration), request = requested(selection), command = commandId(key);
    if (request.provider != null) throw new SessionError("INVALID_INPUT", "a native session continues with its own Harness, not a managed Provider");
    const fingerprint = this.fingerprint({ kind: "import", configuration: config, selection: request, nativeId });
    const replay = () => { const prior = this.store.findByCreateKey(command); if (prior) replayCommand(prior, command, "create", fingerprint); return prior; };
    const prior = replay(); if (prior) return prior;
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
    const concurrent = replay(); if (concurrent) return concurrent;
    const checkpoint = read.checkpoint;
    if (typeof checkpoint !== "string" || !checkpoint || Buffer.byteLength(checkpoint) > 8192 || /[\0\r\n]/u.test(checkpoint)) throw new SessionError("INVALID_NATIVE_CHECKPOINT", "invalid original Harness recovery reference");
    held(checkpoint);
    // The newest messages are quoted within a budget that leaves room for this conversation's own branches.
    const quoted: ForkedMessage[] = []; let bytes = 2, omitted = Number.isSafeInteger(read.omitted) && read.omitted > 0 ? read.omitted : 0;
    const history = read.historyRead ? read.history : [];
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index]!, message: ForkedMessage = { role: entry.role, text: entry.text, status: "completed", ...(entry.role === "assistant" ? { harnessId: validated.harnessId } : {}) };
      const size = utf8Bytes(JSON.stringify(message)) + 1;
      if (quoted.length >= MAX_IMPORTED_MESSAGES || bytes + size > MAX_IMPORTED_BYTES) { omitted += index + 1; break; }
      quoted.unshift(message); bytes += size;
    }
    const title = typeof read.title === "string" && read.title.trim() ? read.title.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, 200) : null;
    const id = sessionId("session-" + this.options.id());
    const state: SessionSnapshot = { schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open", configuration: config, selection: validated,
      activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      origin: { kind: "import", harnessId: validated.harnessId, title, omitted, complete: read.historyRead === true && read.complete === true, historyRead: read.historyRead === true, history: quoted },
      nativeBindings: [{ harnessId: validated.harnessId, controlId: validated.controlId, checkpoint, throughRunId: null, status: "ready", relay: initialBindingRelay([], validated.harnessId, validated.controlId, "import") }] };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: validated, continuity: "native_import",
        origin: { harnessId: validated.harnessId, messages: quoted.length, omitted, historyRead: read.historyRead === true } })]);
      this.managedSessions.add(id);
      return this.publish(committed).session;
    } catch (error) { this.fail(error, id); throw error; }
  }

  /**
   * Accepts one input for the conversation's next Turn, idempotently by key. `relay` carries the user's relay choices
   * (RelayChoice): with `{ attach: "none" }` the input is sent alone, exactly as typed, and the public facts its Harness is
   * owed stay owed (ADR-055 §7.2 n); a key keeps its choices, and the same key with other choices conflicts. An input that
   * would carry relay content is checked here first (ADR-055 §6.1 admit): what can be decided before any Run exists is
   * refused synchronously — RELAY_TARGET_UNVERIFIED, RELAY_UNAVAILABLE, RELAY_CHOICE_REQUIRED, RELAY_CONSENT_REQUIRED (HTTP
   * 409) or RELAY_INPUT_LIMIT (429) — and no Run is made. The choices are kept with the Run (`relayRequest`, its options and
   * their HMAC); a consent the request gives (`relay.consent`) is recorded in the installation's log and mirrored in the
   * conversation (`relay.consent_recorded`); `relay.native:"new"` (［新开原生会话］) archives the Harness control's native
   * session as a native reset does, in the same transaction, so the input opens a new one (only while the conversation is idle).
   */
  send(id: SessionId, text: string, key: string, attachmentIds: readonly string[] = [], relay?: RelayChoice): SendReceipt {
    this.admit(); assertInput(text);
    if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_RUN_ATTACHMENTS || attachmentIds.some(value => typeof value !== "string")) throw new SessionError("INVALID_INPUT", "attachments must be at most 8 content identities");
    const choices = parseRelayChoices(relay);
    // Without attachments or relay choices the fingerprint keeps its earlier shape, so replayed commands from before still match.
    const command = commandId(key), fingerprint = this.fingerprint({ ...(attachmentIds.length ? { kind: "send", text, attachments: attachmentIds } : { kind: "send", text }), ...(choices === undefined ? {} : { relay: choices }) }), state = this.load(id);
    const prior = replayCommand(state, command, "send", fingerprint);
    if (prior) return { sessionId: id, runId: runId(prior.resultId), replayed: true };
    this.open(state); this.commandBudget(state);
    let attachments: readonly ContentRef[] = [];
    if (attachmentIds.length) {
      if (this.options.content === undefined) throw new SessionError("ATTACHMENT_UNAVAILABLE", "this Gateway has no content storage for attachments");
      attachments = this.options.content.resolve(attachmentIds, state.configuration.workspace);
    }
    if (state.runs.length >= MAX_RUNS) throw new SessionError("RUN_LIMIT", "Session Run budget exhausted");
    if (state.runs.filter(run => run.status === "queued").length >= MAX_QUEUE) throw new SessionError("QUEUE_FULL", "Session queued input limit reached");
    // ［新开原生会话］: the binding it replaces, archived with this input as a native reset archives it (resetNative's conditions).
    const renewed = choices?.native === "new" ? this.renewedBinding(state) : null;
    this.admitRelay(state, text, attachments.map(file => file.kind), choices ?? {});
    // A key that cannot be used never stops an input (one sent alone included): its options are then fingerprinted under a key
    // kept in memory only (EPHEMERAL_KEY_ID, not checkable), and any packet it would carry fails at its own preparation.
    let relayRequest: ReturnType<typeof runRelayRequest>;
    try { relayRequest = runRelayRequest(id, choices, this.relayKeys); }
    catch (error) { if (!(error instanceof RelayError)) throw error; relayRequest = runRelayRequest(id, choices, this.unkeptKeys); }
    // The request's consent goes to the installation's log first (its authority, §10.4), then into this transaction as a mirror.
    const consent = choices?.consent === undefined ? null : this.recordConsent(id, command, choices.consent, state);
    const nextId = runId("run-" + this.options.id()), userId = messageId("message-" + this.options.id()), assistantId = messageId("message-" + this.options.id());
    const run: PublicRun = { id: nextId, commandId: command, input: text, userMessageId: userId, assistantMessageId: assistantId,
      selection: state.selection, epoch: state.epoch, status: "queued", cancelRequested: false, contextThroughSeq: 0,
      sourceRunIds: [], backend: null, cleanup: null, error: null, stopRequested: false, awaitingSwitchId: state.pendingSwitchId, ...(attachments.length ? { attachments } : {}),
      timing: { acceptedAt: this.options.now().getTime() }, ...(relayRequest === undefined ? {} : { relayRequest }) };
    // What this owner found of a process kept under the previous one is shown until the conversation's next Turn.
    this.lost.delete(id); this.outside.delete(id); this.upgraded.delete(id);
    const reset = renewed === null ? null : { id: commandId("native-" + createHash("sha256").update(id + "\0" + command, "utf8").digest("hex").slice(0, 40)), fingerprint: this.fingerprint({ kind: "native-reset", epoch: state.epoch, by: "send", command }) };
    this.commit(id, ({ relayRecoveryFailed, ...rest }) => {
      // A native reset clears a relay recovery failure (§9 S15), as resetNative does.
      const current: SessionSnapshot = renewed === null && relayRecoveryFailed !== undefined ? { ...rest, relayRecoveryFailed } : rest;
      return { next: { ...current, runs: [...current.runs, run],
        ...(renewed === null ? {} : { nativeBindings: current.nativeBindings?.map(binding => binding.harnessId === renewed.harnessId && binding.controlId === renewed.controlId && binding.status !== "archived" ? { ...binding, status: "archived" as const } : binding) ?? [] }),
        messages: [...current.messages, { id: userId, runId: nextId, role: "user", text, seq: current.lastSeq + 1 + (renewed === null ? 0 : 1), status: "queued" }],
        commands: [...current.commands, ...(reset === null ? [] : [{ id: reset.id, kind: "native-reset" as const, fingerprint: reset.fingerprint, resultId: id }]), { id: command, kind: "send", fingerprint, resultId: nextId }] },
        events: [...(renewed === null ? [] : [event("native.branch_requested", { harnessId: renewed.harnessId, controlId: renewed.controlId, historyPreserved: true, previousBindingPreserved: true, by: "relay.native", runId: nextId })]),
          event("message.accepted", { runId: nextId, messageId: userId, role: "user", text, ...(attachments.length ? { attachments } : {}), ...(choices === undefined ? {} : { relay: choices }), ...(relayRequest === undefined ? {} : { relayRequest }) }),
          ...(consent === null ? [] : [event("relay.consent_recorded", { runId: nextId, logSeq: consent.logSeq, vendor: consent.vendor, scope: consent.scope.kind, decision: consent.decision, categories: consent.categories, policyVersion: consent.policyVersion, authKind: consent.authKind })])] };
    });
    this.acceptedRelay.set(nextId, choices ?? {});
    // Inputs cancelled before they run never read theirs: the oldest go first, so this stays bounded.
    if (this.acceptedRelay.size > 4096) this.acceptedRelay.delete(this.acceptedRelay.keys().next().value!);
    // The kept process runs the archived native session; it is closed before the input opens a new one (ADR-030).
    if (renewed !== null && this.kept.has(id)) void this.requestRelease(id, "native_reset");
    this.schedule(id); return { sessionId: id, runId: nextId, replayed: false };
  }
  /**
   * The binding `relay.native:"new"` replaces (ADR-055 §7.3, the ［新开原生会话］ of §9): the selection's own native binding,
   * archived as resetNative archives it, under the same conditions (the conversation idle, its selection a native Harness, no
   * Turn whose resources are unconfirmed); null when it has none yet (the input opens a new one anyway).
   */
  private renewedBinding(state: SessionSnapshot): { readonly harnessId: string; readonly controlId: string } | null {
    if (state.activeRunId !== null || state.pendingSwitchId !== null || state.runs.some(run => !terminal(run.status))) throw new SessionError("NATIVE_SESSION_BUSY", "新开原生会话只能在这个对话空闲时进行：等这一轮结束后再发。这条消息没有发出，草稿已保留。");
    if (state.selection.provider !== undefined) throw new SessionError("INVALID_INPUT", "a managed Provider has no native session to renew");
    if (state.runs.some(run => run.status === "unknown" && run.cleanup?.closed !== true)) throw new SessionError("RECOVERY_CLEANUP_REQUIRED", "native resources must be confirmed before a new native session");
    const bound = state.nativeBindings?.find(binding => binding.harnessId === state.selection.harnessId && binding.controlId === state.selection.controlId && binding.status !== "archived");
    if (bound === undefined) return null;
    if (bound.status !== "ready") throw new SessionError("NATIVE_STATE_UNCONFIRMED", "原生会话状态尚未确认；可以切换其他 Harness，或明确建立新的原生分支。公共历史会保留。");
    return { harnessId: bound.harnessId, controlId: bound.controlId };
  }
  /**
   * A request's consent (`relay.consent`, ADR-055 §10.4) appended to the installation's relay log (its authority); the record
   * it made, for the conversation's mirror. A Store without the log refuses it (RELAY_UNAVAILABLE{consent_log_full} is the
   * log's own refusal); the input is then not accepted.
   */
  private recordConsent(id: SessionId, command: string, consent: NonNullable<RelayChoices["consent"]>, state: SessionSnapshot): ConsentRecord {
    const log = this.relayLog();
    if (log?.appendRelayLog === undefined) throw new RelayError({ code: "RELAY_UNAVAILABLE", reason: "consent_log_full" }, "这个 Gateway 没有可写的同意记录，不能记下这次同意；这条消息没有发出。");
    const binding = state.nativeBindings?.find(row => row.harnessId === state.selection.harnessId && row.controlId === state.selection.controlId && row.status !== "archived");
    const record: ConsentAppend = { commandId: consentCommandOf(id, command), vendor: consent.vendor, scope: consent.scope === "global" ? { kind: "global" } : { kind: "session", sessionId: id },
      decision: consent.decision, categories: [...CONSENT_CATEGORIES], policyVersion: "relay/1", authKind: binding?.relay?.vendorObserved?.authKind ?? null, decidedAt: this.options.now().getTime() };
    return log.appendRelayLog(record);
  }
  /**
   * Admission's relay part (relay-coordinator relayAdmission and admitCarrying): the input runs on the pending switch's target
   * when there is one, else on the selection; only the target Driver's static declaration (the factory's, without starting
   * anything) and the binding's committed state are read, and for an input that would carry relay content the installation's
   * preferences, consents and windows (G072). A factory that cannot tell the declaration leaves every question to the open.
   */
  private admitRelay(state: SessionSnapshot, text: string, attachments: readonly ContentKind[], choices: RelayChoices, pinned?: HarnessSelection, run?: PublicRun): void {
    const pending = state.pendingSwitchId === null ? undefined : state.switches.find(sw => sw.id === state.pendingSwitchId);
    if (pinned === undefined && pending !== undefined && pending.target === null) return;
    const target = pinned ?? pending?.target ?? state.selection;
    if (target.provider !== undefined) return;
    const capabilities = this.declarationOf(target);
    const binding = state.nativeBindings?.find(row => row.harnessId === target.harnessId && row.controlId === target.controlId && row.status !== "archived");
    const input: AdmitInput = { state, binding, target, capabilities, text, attachments, choices, facts: on => this.relayFacts(state, on), settings: () => this.settings() };
    const carrying = relayAdmission(input);
    if (carrying === null) return;
    // Once accepted (prePlan), the request's own consent counts as the log holds it: withdrawn since, it is none.
    const effective = run === undefined ? choices : this.withRecordedConsent(state, run, choices);
    admitCarrying(input, carrying, this.relayGated() ? this.relayGates(state, target, binding, carrying, capabilities ?? null, effective) : undefined);
  }
  /**
   * The request's own consent after its acceptance (§10.4): the one it recorded in the installation's log, as long as no
   * withdrawal of its vendor (in this conversation or for all) was logged after it; the choices without it otherwise.
   */
  private withRecordedConsent(state: SessionSnapshot, run: PublicRun, choices: RelayChoices): RelayChoices {
    if (choices.consent === undefined) return choices;
    const { consent, ...rest } = choices, records = this.relayLog()?.relayConsents?.() ?? [];
    // The log's current view keeps the latest record of each vendor and scope: one no longer there was superseded in its scope,
    // and the records alone then decide (a later consent stands by itself, a later withdrawal is none).
    const own = records.filter(record => record.commandId === consentCommandOf(state.id, run.commandId)).at(-1);
    const withdrawn = own === undefined || records.some(record => record.vendor === consent.vendor && record.decision === "revoked" && record.logSeq > own.logSeq && (record.scope.kind === "global" || record.scope.sessionId === state.id));
    return withdrawn ? rest : choices;
  }
  /**
   * Whether G072's relay gates apply (the probe gate, the data root, consent and vendor keys, the window): whenever the binding
   * factory declares the Drivers' static relay declarations (relayCapabilities), as the Gateway's own factory always does
   * (DirectorySessionBindingFactory). A factory that declares none (a test's fake) is the stage-two seam's: admission asks
   * nothing and the open applies G068's checks only.
   */
  private relayGated(): boolean { return typeof this.factory.relayCapabilities === "function"; }
  /** The factory's static declaration of a selection's Driver; undefined without the method, null when it declares none or fails. */
  private declarationOf(selection: HarnessSelection): RelayCapabilities | null | undefined {
    if (this.factory.relayCapabilities === undefined) return undefined;
    try { return this.factory.relayCapabilities(selection); } catch { return null; }
  }
  /** The installation's relay log, windows and preferences of a Store that keeps them (SqliteSessionStore); none otherwise. */
  private relayLog(): Partial<RelayLogPort> | null {
    const store = this.store as Partial<RelayLogPort>;
    return typeof store.relayPrefs === "function" ? store : null;
  }
  private relayPrefs(): Readonly<Partial<Record<RelayPrefKey, string>>> {
    try { return this.relayLog()?.relayPrefs?.() ?? {}; } catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") return {}; throw error; }
  }
  /** The relay's settings now: the stored preferences with their defaults, which are permissive (permissive-defaults §4). */
  private settings(): RelaySettings { return relaySettings(this.relayPrefs()); }
  /** The consent view of a conversation (§10.4): the log's current records, the preferences and the request's own consent. */
  private consentView(state: SessionSnapshot, prefs: Readonly<Partial<Record<RelayPrefKey, string>>>, choices: RelayChoices): ConsentView {
    const settings = relaySettings(prefs), records = this.relayLog()?.relayConsents?.() ?? [];
    return { session: state.id, records, crossVendor: settings.crossVendor, localModelsOffline: settings.localModelsOffline, request: choices.consent ?? null };
  }
  private relayWindowOf(harnessId: string, controlId: string, modelKey: string): RelayWindow | null {
    try { return this.relayLog()?.relayWindow?.(harnessId, controlId, modelKey) ?? null; } catch (error) { if (error instanceof SessionError && error.code === "INVALID_DATA") return null; throw error; }
  }
  /**
   * The vendor the latest binding of a Harness control last saw, archived ones included: what a new native session of the same
   * control is predicted to run on (its configuration is the same) until its own open tells (§10.4; checked again there).
   */
  private lineageVendor(state: SessionSnapshot, target: HarnessSelection): VendorObservation | null {
    return (state.nativeBindings ?? []).filter(row => row.harnessId === target.harnessId && row.controlId === target.controlId && row.relay?.vendorObserved != null).at(-1)?.relay?.vendorObserved ?? null;
  }
  private isolated(workspace: string, fresh = false): boolean {
    try { return this.options.relayIsolated?.(workspace, fresh) ?? true; } catch { return false; }
  }
  /**
   * What admission's G072 checks read for an input that would carry relay content (relay-coordinator AdmitGates): the target's
   * vendor key from its binding's cached observation (the one a new native session replaces predicts it too), the vendor keys
   * of what would be carried, the data root, the preferences and consents, and the target's observed window.
   */
  private relayGates(state: SessionSnapshot, target: HarnessSelection, binding: NativeSessionBinding | undefined, carrying: Carrying, capabilities: RelayCapabilities | null, choices: RelayChoices): AdmitGates {
    const prefs = this.relayPrefs(), observed = binding?.relay?.vendorObserved ?? this.lineageVendor(state, target);
    const facts = carrying.owes ? carrying.need.facts : carrying.facts;
    // Where the answer decides whether the handoff goes ("block") the marker search is made again, not read from its cache (G072 review m6).
    return { allowUnprobed: relaySettings(prefs).allowUnprobed, isolated: this.isolated(state.configuration.workspace, relaySettings(prefs).dataRootInWorkspace === "block"),
      target: { vendor: vendorKeyOf(capabilities, target.harnessId, observed), layer: observed?.endpoint?.layer ?? null },
      sources: sourceVendors(state, facts, carrying.need.origin || carrying.doubt && carrying.originHistory && !carrying.relay.originIncluded, selection => this.declarationOf(selection)),
      consent: this.consentView(state, prefs, choices), window: this.relayWindowOf(target.harnessId, target.controlId, observed?.modelKey ?? ""), now: this.options.now().getTime() };
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
    this.commandBudget(state);
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
  read(id: SessionId): SessionSnapshot { return this.load(id); }
  /**
   * What each of the conversation's native bindings asks the user to look at now (permissive-defaults §2.6; the read behind the
   * `attention` of `GET …/relay`): worked out from the state the conversation is in at this moment — the binding's relay state, the
   * Turns and starting history it owes, the consent of its vendor in the installation's log, the window it is known to have — and
   * not from what its latest Turn happened to decide, so a banner stays while its cause does and goes when it ends, whatever
   * Turns came between (G072 review I5). Also whether its Driver's relay mechanisms are probed. Read-only; a binding that needs
   * nothing has `attention` null. Never a block — the next input goes whatever this says.
   */
  relayAttention(id: SessionId): readonly { readonly harnessId: string; readonly controlId: string; readonly probed: boolean | null; readonly attention: RelayAttention | null }[] {
    const state = this.load(id), originHistory = (state.origin?.history.length ?? 0) > 0, prefs = this.relayPrefs(), settings = relaySettings(prefs), now = this.options.now().getTime();
    const originTurns = Math.max(1, (state.origin?.history ?? []).filter(row => row.role === "user").length);
    return (state.nativeBindings ?? []).filter(binding => binding.status !== "archived" && binding.relay !== undefined).map(binding => {
      const relay = binding.relay!, h = binding.harnessId, c = binding.controlId, target: HarnessSelection = { harnessId: h, controlId: c };
      const need = owed(relay, h, c, this.relayFacts(state, { harnessId: h, controlId: c, nativeEpoch: relay.nativeEpoch }), { originHistory, heldSince: heldSinceIn(state, h, c, relay) });
      const owedRuns = need.facts.length + (need.origin ? originTurns : 0);
      // Whether its Driver's relay mechanisms were proved by a real Harness (the card says "未经真机验证" otherwise): false for a Driver that declares none, null when the factory cannot tell.
      const declared = this.declarationOf(target), probed = declared === undefined ? null : declared !== null && declared.probed;
      let consent: AttentionInput["consent"] = null, fits = true;
      // Only what is owed from another Harness meets the destination's consent and window (the same reading as the open's gates).
      if (owedRuns > 0 && crossHarnessFacts(state, need.facts, need.origin, target)) {
        const observed = relay.vendorObserved ?? this.lineageVendor(state, target), vendor = vendorKeyOf(declared, h, observed), layer = observed?.endpoint?.layer ?? null;
        const sources = sourceVendors(state, need.facts, need.origin, selection => this.declarationOf(selection));
        if (crossVendor(vendor, sources) && settings.crossVendor !== "ask") {
          const view = this.consentView(state, prefs, {});
          try { consentGate({ relay, vendor, layer, cross: true, consent: view, target, predicted: null }); }
          catch (error) {
            if (!(error instanceof RelayError) || error.code !== "RELAY_CONSENT_REQUIRED") throw error;
            const records = view.records.filter(record => record.vendor === vendor && (record.scope.kind === "global" || record.scope.sessionId === state.id));
            consent = { cause: error.reason === "revoked" ? "revoked" : "goal_only", episode: vendor + "@" + Math.max(0, ...records.map(record => record.logSeq)) };
          }
        }
        const window = resolveWindow({ relay, report: declared?.window ?? "none", stored: this.relayWindowOf(h, c, observed?.modelKey ?? ""), vendor, fixedPrefix: declared?.fixedPrefix ?? null, now });
        fits = fitsMinPacket(hardCap(window, 0, declared?.placement.maxInput ?? null, 0), packetFamily(vendor, observed?.modelKey ?? ""));
      }
      return { harnessId: h, controlId: c, probed, attention: attentionOf({ relay, recoveryFailed: state.relayRecoveryFailed !== undefined, owedRuns, consent, fits }) };
    });
  }
  /**
   * What the installation as a whole cannot do for the relay while it stays so (G072 review, C): the relay key file unusable, so that
   * no packet can be keyed and every handoff goes as the words alone, which no single conversation's attention says. Empty when
   * nothing is wrong. Read-only.
   */
  relayInstallation(): readonly RelayInstallationNotice[] {
    const problem = this.relayKeys.unusable;
    return problem === undefined || problem === null ? [] : [{ cause: "key_unavailable", detail: problem.slice(0, 200) }];
  }
  /**
   * Whether the data directory (or the relay key) is within reach of this conversation's workspace (ADR-055 INV-36): what the
   * workspace-level notice says while `relay.dataRootInWorkspace` only warns (permissive-defaults §2.4). The cheap check of
   * every admission, not the bounded marker search of startup.
   */
  relayDataRootExposed(id: SessionId): boolean { return !this.isolated(this.load(id).configuration.workspace); }
  /** The relay's settings now: the stored preferences with their defaults (permissive-defaults §4). */
  relayPolicy(): RelaySettings { return this.settings(); }
  resetNative(id: SessionId, key: string, epoch: number): SessionSnapshot {
    this.admit(); const state = this.load(id), command = commandId(key);
    const fingerprint = this.fingerprint({ kind: "native-reset", epoch });
    if (replayCommand(state, command, "native-reset", fingerprint)) return state;
    this.commandBudget(state);
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
    return committed.session;
  }
  /**
   * Branches a Session after a finished Run. The branch quotes the public history through that Run and starts with the
   * same selection. When the source's native session is exactly at that Run, the branch gets a native fork of it (made
   * before the branch's first input); otherwise the branch continues from public history. Nothing is sent to a model.
   */
  fork(sourceId: SessionId, key: string, throughRunId?: string): SessionSnapshot {
    this.admit();
    const source = this.load(sourceId), command = commandId(key);
    if (throughRunId !== undefined && (typeof throughRunId !== "string" || !/^run-[A-Za-z0-9-]{1,128}$/u.test(throughRunId))) throw new SessionError("INVALID_INPUT", "invalid branch point");
    const through = throughRunId === undefined ? [...source.runs].reverse().find(run => terminal(run.status)) : source.runs.find(run => run.id === throughRunId);
    const fingerprint = this.fingerprint({ kind: "fork", source: sourceId, through: through?.id ?? null });
    const prior = this.store.findByCreateKey(command);
    if (prior) { replayCommand(prior, command, "create", fingerprint); return prior; }
    if (!through || !terminal(through.status)) throw new SessionError("FORK_UNAVAILABLE", "a branch starts after a finished reply");
    if (source.activeRunId !== null || source.pendingSwitchId !== null) throw new SessionError("NATIVE_SESSION_BUSY", "wait for the current reply or switch to finish before branching");
    const last = source.runs.findIndex(run => run.id === through.id), included = new Set(source.runs.slice(0, last + 1).filter(run => terminal(run.status)).map(run => run.id));
    const history: ForkedMessage[] = [...(source.origin?.history ?? []), ...[...source.messages].filter(message => included.has(message.runId)).sort((a, b) => a.seq - b.seq).map(message => {
      const run = source.runs.find(row => row.id === message.runId)!;
      return { role: message.role, text: message.text, status: run.status, ...(message.role === "assistant" ? { harnessId: run.selection.harnessId } : {}), ...(message.role === "user" && run.attachments?.length ? { attachments: run.attachments } : {}) };
    })];
    const native = source.selection.provider === undefined ? source.nativeBindings?.find(binding => binding.harnessId === source.selection.harnessId && binding.controlId === source.selection.controlId && binding.status === "ready") : undefined;
    // The native session is exactly at `through` only when no later Turn was dispatched to it, `through` ran in its current
    // native epoch, and the binding is synced with nothing owed up to `through` (ADR-055 §7.5): its native position follows
    // dispatch, so these say that the native session holds the conversation through `through` and nothing else.
    const nativeFork = native !== undefined && native.throughRunId === through.id && !source.runs.slice(last + 1).some(run =>
      run.selection.provider === undefined && run.selection.harnessId === native.harnessId && run.selection.controlId === native.controlId && dispatched(run)) && this.exactAt(source, native, through);
    const id = sessionId("session-" + this.options.id());
    const state: SessionSnapshot = { schemaVersion: 13, id, version: 0, lastSeq: 0, epoch: 1, status: "open", configuration: source.configuration, selection: source.selection,
      activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: command, kind: "create", fingerprint, resultId: id }],
      origin: { kind: "fork", sessionId: sourceId, throughRunId: through.id, history },
      ...(nativeFork ? { nativeBindings: [{ harnessId: native.harnessId, controlId: native.controlId, checkpoint: native.checkpoint, throughRunId: null, status: "fork-pending" as const,
        relay: initialBindingRelay([], native.harnessId, native.controlId, "fork") }] } : {}) };
    try {
      const committed = this.store.create(state, [event("session.created", { selection: state.selection, continuity: nativeFork ? "native_fork" : "public_context_rehydrate", origin: { sessionId: sourceId, throughRunId: through.id, messages: history.length, nativeFork } })]);
      this.managedSessions.add(id); this.publish(committed);
      // The source's kept process holds the native session the branch forks; it is closed first (ADR-030).
      if (this.kept.has(sourceId)) void this.requestRelease(sourceId, "branched");
      if (nativeFork) this.schedule(id);
      return committed.session;
    } catch (error) { this.fail(error, id); throw error; }
  }
  /** Whether a binding's native session holds exactly the conversation through `through` (relay-coordinator nativeExactAt). */
  private exactAt(state: SessionSnapshot, binding: NativeSessionBinding, through: PublicRun): boolean {
    return nativeExactAt(state, binding, through, () => this.ledger.endedSeq(state, through.id), on => this.relayFacts(state, on));
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
  setRetention(id: SessionId, enabled: boolean, key: string): SessionSnapshot {
    this.admit(); const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "retention", enabled });
    if (replayCommand(state, command, "retention", fingerprint)) return state;
    this.commandBudget(state);
    if (state.status === "closed") throw new SessionError("SESSION_CLOSED", "a closed Session keeps no native process");
    const committed = this.commit(id, current => {
      const { retainNative, ...rest } = current;
      return { next: { ...rest, ...(enabled ? { retainNative: true as const } : {}), commands: [...current.commands, { id: command, kind: "retention", fingerprint, resultId: id }] },
        events: [event("session.retention_changed", { enabled })] };
    }).session;
    if (!enabled && this.kept.has(id)) void this.requestRelease(id, "disabled");
    return committed;
  }
  /** Closes this conversation's kept process at the user's request, with the normal stop chain; resolves once it is recorded. */
  async endKept(id: SessionId, key: string): Promise<SessionSnapshot> {
    this.admit(); const state = this.load(id), command = commandId(key), fingerprint = this.fingerprint({ kind: "native-close" });
    if (!replayCommand(state, command, "native-close", fingerprint)) {
      this.commandBudget(state);
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
      let state: SessionSnapshot;
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
    for (const state of this.store.listKept()) {
      const retained = state.retained;
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
    const done: Promise<void> = this.release(id, reason).catch(error => { this.fail(error, id); })
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
    this.commit(id, current => {
      const { retained, ...rest } = current;
      return { next: rest, events: [event("native.process_closed", { runId: kept.runId, reason, backgroundUpdates, cleanup, outside, ...(problem === null ? {} : { error: problem }) })] };
    });
  }
  /**
   * The process this conversation kept, when it can take a Turn with `selection`; a kept process that cannot is closed first,
   * and so is one whose binding must be checked at an open (ADR-055 §7.4, VF1-09: mayReuseKept), which reuse would skip.
   */
  private async takeKept(id: SessionId, selection: HarnessSelection, relay: BindingRelayState | undefined): Promise<KeptProcess | null> {
    const kept = this.kept.get(id);
    if (kept === undefined) return null;
    if (!sameSelection(kept.selection, selection)) { await this.release(id, "selection_changed"); return null; }
    if (kept.binding.control.healthy?.() !== true) { await this.release(id, "exited"); return null; }
    if (relay !== undefined && !mayReuseKept(relay, relayDeclaration(kept.binding.control.relayCapabilities).verify)) { await this.release(id, "relay_check"); return null; }
    this.kept.delete(id); clearTimeout(kept.timer); return kept;
  }
  /** Whether a finished Turn hands its process to the conversation: opted in, completed cleanly, confirmed, and under the limit. */
  private keepable(id: SessionId, execution: ActiveExecution, backend: BackendResult | null, problem: unknown, confirmed: boolean): { readonly keep: boolean; readonly skipped?: "limit" } {
    try {
      const state = this.load(id), run = state.runs.find(row => row.id === execution.runId);
      if (state.retainNative !== true || run === undefined || run.cancelRequested || run.selection.provider !== undefined || !confirmed || problem !== null || backend?.status !== "completed"
        || execution.stop !== null || execution.earlyClose !== null || !this.accepting || this.fatal !== null || this.closingSessions.has(id) || this.releasing.has(id)
        || execution.binding?.control.healthy?.() !== true) return { keep: false };
      return this.kept.size >= KEPT_LIMIT ? { keep: false, skipped: "limit" } : { keep: true };
    } catch { return { keep: false }; }
  }

  async closeSession(id: SessionId, key: string): Promise<SessionSnapshot> {
    this.admit(); const command = commandId(key), fingerprint = this.fingerprint({ kind: "close" });
    const state = this.load(id), prior = replayCommand(state, command, "close", fingerprint);
    if (prior) { await this.wait(id); return this.load(id); }
    this.commandBudget(state); this.closingSessions.add(id);
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
      return this.commit(id, current => ({ next: { ...current, status: "closed" }, events: [event("session.closed", {})] })).session;
    } finally { this.closingSessions.delete(id); }
  }

  /**
   * Stops owned work and admission, then ends what the binding factory still does in the background (its own bound, ADR-056
   * §4.12). Public Sessions and Store remain available to the next owner.
   */
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
    // Last, once no binding runs: the factory's background work, such as removing host TMPDIRs moved aside (bounded).
    try { await this.factory.close?.(); } catch (error) { problem ??= error; this.fail(error); }
    if (problem) throw problem;
    if (this.fatal) throw this.fatal;
  }

  private cancelPending(state: SessionSnapshot): SessionSnapshot {
    const closedAt = this.options.now().getTime();
    const runs = state.runs.map(run => run.status === "queued" ? { ...run, status: "cancelled" as const, cancelRequested: true, ...phase(state, run.id, "endedAt", closedAt) }
      : terminal(run.status) ? run : { ...run, cancelRequested: true });
    const sourceStillActive = state.activeRunId !== null && state.switches.some(sw => sw.id === state.pendingSwitchId && sw.sourceRunIds.includes(state.activeRunId!));
    return { ...state, runs, messages: state.messages.map(message => ({ ...message, status: runs.find(run => run.id === message.runId)!.status })),
      pendingSwitchId: sourceStillActive ? state.pendingSwitchId : null, switches: state.switches.map(sw => sw.id === state.pendingSwitchId
        ? { ...sw, ...(sourceStillActive ? {} : { status: "failed" as const }), error: { code: "CANCELLED", message: "switch cancelled by close" } } : sw) };
  }
  private cancelInternal(id: SessionId, command: CommandId, target?: PublicRun["id"]): CancelReceipt {
    const state = this.load(id), fingerprint = this.fingerprint({ kind: "cancel", target: target ?? null });
    const prior = replayCommand(state, command, "cancel", fingerprint);
    if (prior) return { sessionId: id, target: prior.resultId === "none" ? null : runId(prior.resultId), replayed: true };
    this.open(state); this.commandBudget(state);
    const selected = target === undefined ? state.activeRunId : target;
    const run = selected === null ? undefined : state.runs.find(run => run.id === selected);
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
  private open(state: SessionSnapshot): void {
    if (state.status !== "open" || this.closingSessions.has(state.id)) throw new SessionError("SESSION_UNAVAILABLE", "Session is closed or blocked; new dispatch is disabled for this Session");
  }
  private recoverySwitch(state: SessionSnapshot): boolean {
    const pending = state.switches.find(sw => sw.id === state.pendingSwitchId);
    if (!pending) return false;
    const request = this.store.events(state.id, pending.requestedSeq - 1, 1)[0];
    return request?.type === "switch.requested" && request.data.switchId === pending.id && request.data.recovery === true;
  }
  private recoverable(state: SessionSnapshot, acknowledgeUnknown: boolean): void {
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
  private commandBudget(state: SessionSnapshot): void {
    if (state.commands.length >= MAX_COMMANDS) throw new SessionError("COMMAND_LIMIT", "Session command budget exhausted");
  }
  private fingerprint(value: unknown): string { return this.options.fingerprint(JSON.stringify(value)); }
  /**
   * The version of each Session as this runtime last read or committed it: commit() names it for the Store's
   * compare-and-swap instead of reading the Session again first (ADR-055 §11.2). A transaction committed past this runtime
   * makes it stale; the Store then refuses before the mutation runs, and commit() reads the Session first, as it used to.
   */
  private readonly versions = new Map<SessionId, number>();
  private load(id: SessionId): SessionSnapshot {
    try { const state = this.store.get(id); this.versions.set(id, state.version); return state; }
    catch (error) {
      if (!(error instanceof SessionError) || error.code !== "SESSION_NOT_FOUND") this.fail(error, id);
      throw error;
    }
  }
  /**
   * One Store transaction of `id`, published. A failure fails the Runtime (fatal) unless it is an expected one, or `quiet`
   * says the caller decides: a commit whose relay part the Store may refuse retries without it (R6, relayRefusal).
   */
  private commit(id: SessionId, mutate: (state: SessionSnapshot) => SessionMutation, quiet = false): SessionCommit {
    try {
      this.store.assertOwner();
      const known = this.versions.get(id);
      let ran = false, committed: SessionCommit;
      const once = (state: SessionSnapshot): SessionMutation => { ran = true; return mutate(state); };
      try { committed = this.store.transact(id, known ?? this.load(id).version, once); }
      catch (error) {
        if (known === undefined || ran || !(error instanceof SessionError && error.code === "VERSION_CONFLICT")) throw error;
        committed = this.store.transact(id, this.load(id).version, once);
      }
      this.versions.set(id, committed.session.version);
      return this.publish(committed);
    }
    // An expected relay failure (a RelayError from the Store's checks or the relay's own) fails only its Run (INV-35).
    catch (error) { if (!quiet && !expectedFailure(error)) this.fail(error, id); throw error; }
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
  private publish(commit: SessionCommit): SessionCommit {
    if (this.publicationFailed) return commit;
    try { for (const value of commit.events) this.options.publish(value); }
    catch { this.publicationFailed = true; const error = new SessionError("PUBLICATION_FAILED", "committed event publication failed; execution stopped"); this.fail(error, commit.session.id); throw error; }
    return commit;
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
          this.versions.set(affected, committed.session.version);
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
      if (!this.runnable(id)) { this.work.delete(id); this.leaveQueue(id); this.leaveSlot(id); continue; }
      const workspace = this.load(id).configuration.workspace, holder = this.holders.get(workspace);
      if (holder !== undefined && holder !== id) { this.leaveSlot(id); this.joinQueue(id, holder); continue; }
      // With every slot taken, later work is still looked at, so work behind a held workspace shows that it waits.
      if (this.workers.size >= (this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS)) { this.joinSlot(id); continue; }
      this.work.delete(id); this.holders.set(workspace, id); this.leaveQueue(id); this.leaveSlot(id);
      const worker: Promise<void> = Promise.resolve().then(() => this.serve(id));
      this.workers.set(id, worker);
      void worker.then(() => {}, error => { this.fail(error, id); }).finally(() => {
        if (this.workers.get(id) === worker) this.workers.delete(id);
        if (this.holders.get(workspace) === id) this.holders.delete(workspace);
        this.drive();
      });
    }
  }
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
   * Records once that a conversation's next Turn waits for `holder` to free their shared workspace. When that Turn is no
   * longer the next one (it was cancelled), its wait ends and the next Turn's wait begins.
   */
  private joinQueue(id: SessionId, holder: SessionId): void {
    const state = this.load(id), run = state.runs.find(item => item.status === "queued");
    if (this.waitingForWorkspace.get(id)?.runId !== run?.id) this.leaveQueue(id);
    if (run === undefined) return;
    const prior = this.waitingForWorkspace.get(id);
    if (prior !== undefined && prior.holder === holder) return;
    // Waiting for a workspace uses the Turn's wait budget; at its end the Turn fails with WORKSPACE_BUSY (ADR-036).
    const left = (this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS) - (this.waitUsed.get(run.id) ?? 0) - (prior === undefined ? 0 : performance.now() - prior.sinceMono);
    if (prior !== undefined) clearTimeout(prior.timer);
    const timer = setTimeout(() => this.queueExpired(id, run.id), Math.max(0, left)); timer.unref?.();
    this.waitingForWorkspace.set(id, { runId: run.id, holder, since: prior?.since ?? this.options.now().getTime(), sinceMono: prior?.sinceMono ?? performance.now(), timer });
    this.commit(id, current => ({ next: current, events: [event("run.waiting", { runId: run.id, kind: "workspace", holderSessionId: holder })] }));
  }
  /** A Turn waited for its workspace for its whole wait budget: it fails with WORKSPACE_BUSY, naming the holder, and is not retried. */
  private queueExpired(id: SessionId, run: string): void {
    const waiting = this.waitingForWorkspace.get(id);
    if (waiting === undefined || waiting.runId !== run) return;
    this.leaveQueue(id);
    // Known before the commit publishes, so the view that announces the failure already names the holder.
    this.busyHolders.set(run, waiting.holder);
    while (this.busyHolders.size > 256) this.busyHolders.delete(this.busyHolders.keys().next().value!);
    try {
      this.commit(id, current => ({ next: updatedRun(current, run, { status: "failed", error: { code: "WORKSPACE_BUSY", message: "another conversation's Turn held this workspace for the whole wait budget; this input was not dispatched" },
        ...phase(current, runId(run), "endedAt", this.options.now().getTime()) }), events: [event("run.ended", { runId: run, status: "failed", error: { code: "WORKSPACE_BUSY" }, neverDispatched: true, holderSessionId: waiting.holder })] }));
      this.waitUsed.delete(run);
    } catch (error) { this.busyHolders.delete(run); this.fail(error, id); }
    this.schedule(id);
  }
  /** Ends a conversation's wait for a workspace, recording how long it waited. */
  private leaveQueue(id: SessionId): void {
    const waiting = this.waitingForWorkspace.get(id);
    if (waiting === undefined) return;
    this.waitingForWorkspace.delete(id); clearTimeout(waiting.timer);
    this.waitUsed.set(waiting.runId, (this.waitUsed.get(waiting.runId) ?? 0) + (performance.now() - waiting.sinceMono));
    const waitedMs = Math.max(0, this.options.now().getTime() - waiting.since);
    try { this.commit(id, current => ({ next: current, events: [event("run.waiting_ended", { runId: waiting.runId, kind: "workspace", waitedMs })] })); } catch (error) { this.fail(error, id); }
  }
  /**
   * Records once that a conversation's next Turn waits for a slot because every slot is taken (ADR-036). It waits without a
   * budget of its own: each running Turn is bounded by its budgets, and slots go to work in the order it was accepted.
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
    try { this.commit(id, current => ({ next: current, events: [event("run.waiting_ended", { runId: waiting.runId, kind: "slot", waitedMs })] })); } catch (error) { this.fail(error, id); }
  }
  /**
   * Whether another conversation should go before this worker's next work, by acceptance (FIFO, ADR-036): one waiting for
   * this workspace, or one waiting for a slot while every slot is taken.
   */
  private earlierWaiter(id: SessionId): boolean {
    const workspace = this.load(id).configuration.workspace, mine = this.headAccepted(id), full = this.workers.size >= (this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS);
    return [...this.work].some(other => other !== id && !this.workers.has(other) && this.headAccepted(other) < mine
      && (this.waitingForWorkspace.has(other) ? this.load(other).configuration.workspace === workspace : full));
  }
  /**
   * What a conversation's next Turn waits for, when it waits for another conversation's work in their shared workspace:
   * which conversation holds it and whether that one waits for the user (ADR-036).
   */
  queueState(id: SessionId): { readonly runId: string; readonly holderSessionId: SessionId; readonly holderWaitsForUser: boolean; readonly since: number; readonly endsAt: number } | null {
    const waiting = this.waitingForWorkspace.get(id);
    if (waiting === undefined) return null;
    const holderWaits = [...this.permissions.values()].some(value => value.execution.sessionId === waiting.holder && !value.request.decided);
    const left = (this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS) - (this.waitUsed.get(waiting.runId) ?? 0);
    return { runId: waiting.runId, holderSessionId: waiting.holder, holderWaitsForUser: holderWaits, since: waiting.since, endsAt: waiting.since + Math.max(0, left) };
  }
  /** What a conversation's next Turn waits for, when every slot is taken: how many conversations run and the limit (ADR-036). */
  slotWait(id: SessionId): { readonly runId: string; readonly running: number; readonly limit: number; readonly since: number } | null {
    const waiting = this.waitingForSlot.get(id);
    return waiting === undefined ? null : { runId: waiting.runId, running: this.workers.size, limit: this.options.maxParallel ?? MAX_PARALLEL_CONVERSATIONS, since: waiting.since };
  }
  /** The conversation that held the workspace of each of this conversation's Turns this owner ended with WORKSPACE_BUSY. */
  busyHolderOf(run: string): SessionId | null { return this.busyHolders.get(run) ?? null; }
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
          const beforeSwitch = state.runs.find(run => run.status === "queued" && state.messages.some(message => message.id === run.userMessageId && message.seq < pending.requestedSeq));
          if (beforeSwitch) await this.execute(id, beforeSwitch.id);
          else await this.applySwitch(id, state.pendingSwitchId);
        }
        else {
          const queued = state.runs.find(run => run.status === "queued");
          if (queued) await this.execute(id, queued.id);
        }
      } catch (error) { this.fail(error, id); }
      const after = this.load(id);
      const more = after.status === "open" && (after.pendingSwitchId !== null || after.runs.some(run => run.status === "queued")) && !this.closingSessions.has(id) && this.accepting && !this.fatal;
      if (!more && !this.work.has(id)) return;
      // Another conversation that waited for this workspace, or for a slot, with earlier work goes first (FIFO by acceptance).
      if (this.earlierWaiter(id)) { this.work.add(id); return; }
    }
  }

  private owned(execution: ActiveExecution): SessionSnapshot {
    this.store.assertOwner(); execution.binding?.assertOwned();
    const state = this.load(execution.sessionId);
    if (this.actives.get(execution.sessionId) !== execution || state.activeRunId !== execution.runId) throw new SessionError("OWNERSHIP_LOST", "active Run ownership changed");
    const run = state.runs.find(run => run.id === execution.runId);
    if (!run || run.epoch !== state.epoch || JSON.stringify(run.selection) !== JSON.stringify(state.selection))
      throw new SessionError("OWNERSHIP_LOST", "active Run epoch or selection no longer belongs to its Session");
    return state;
  }
  private continue(execution: ActiveExecution): PublicRun {
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
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

  /** Runs the Turn's current budget: the execution budget while it works, the wait budget while it waits for the user (ADR-036). */
  private armBudget(execution: ActiveExecution): void {
    const budget = execution.budget;
    if (budget.timer !== null) clearTimeout(budget.timer);
    const waiting = budget.waiting;
    budget.timer = setTimeout(() => this.expire(execution, waiting ? "wait" : "execution"), Math.max(0, waiting ? budget.waitLeftMs : budget.executionLeftMs));
    budget.timer.unref?.();
  }
  /** The Turn waits for the user from now (if it did not already); returns how long it may still wait. */
  private enterWait(execution: ActiveExecution, run: string): number {
    const budget = execution.budget, now = performance.now();
    if (budget.waiting) return Math.max(0, budget.waitLeftMs - (now - budget.since));
    budget.executionLeftMs -= now - budget.since; budget.waiting = true; budget.since = now;
    if (execution.stopReason === null) this.armBudget(execution);
    this.commit(execution.sessionId, current => ({ next: current, events: [event("run.waiting", { runId: run, kind: "user" })] }));
    return Math.max(0, budget.waitLeftMs);
  }
  /** Back to work once no request of this Turn waits for the user any longer. */
  private leaveWait(execution: ActiveExecution): void {
    const budget = execution.budget;
    if (!budget.waiting || [...this.permissions.values()].some(value => value.execution === execution && !value.request.decided)) return;
    const now = performance.now(), waitedMs = now - budget.since;
    budget.waitLeftMs -= waitedMs; budget.waiting = false; budget.since = now;
    if (execution.stopReason === null && !execution.backendSettled) this.armBudget(execution);
    try { this.commit(execution.sessionId, current => ({ next: current, events: [event("run.waiting_ended", { runId: execution.runId, kind: "user", waitedMs: Math.round(waitedMs) })] })); }
    catch (error) { this.fail(error, execution.sessionId); }
  }
  /**
   * A budget ran out (ADR-036): requests still waiting expire first (the program gets the stop's cancellation, never an
   * approval), the conversation says why, and the Turn is stopped with the normal stop chain.
   */
  private expire(execution: ActiveExecution, kind: "execution" | "wait"): void {
    if (execution.stopReason !== null || execution.backendSettled || this.actives.get(execution.sessionId) !== execution) return;
    execution.stopReason = kind === "wait" ? "WAIT_EXPIRED" : "RUN_TIMEOUT";
    // Text streamed before the budget ran out is committed first, so the expiry never precedes it in the log (ADR-047).
    this.flushStreamQuietly(execution);
    try {
      const waiting = [...this.permissions.entries()].filter(([, value]) => value.execution === execution && value.option === null).map(([permissionId]) => permissionId);
      for (const permissionId of waiting) this.permissions.delete(permissionId);
      const budgetMs = kind === "wait" ? this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS : this.options.executionBudgetMs ?? DEFAULT_EXECUTION_BUDGET_MS;
      this.commit(execution.sessionId, current => ({ next: withNotice(current, execution.runId, budgetNotice(kind, budgetMs)),
        events: [...waiting.map(permissionId => event("permission.closed", { permissionId, runId: execution.runId, reason: "expired" })), event("run.budget_expired", { runId: execution.runId, kind, budgetMs })] }));
      // The wait ends with its requests, so it is recorded like any other end of a wait.
      this.leaveWait(execution);
    } catch (error) { this.fail(error, execution.sessionId); }
    this.stop(execution);
  }

  /**
   * One native event of the Turn. Reply text and thinking are committed per window (ADR-047); everything else is committed
   * on arrival, after the window open before it, so the log keeps the order in which the program sent its events. A refused
   * commit is thrown to the driver, which ends the Turn with it.
   */
  private output(execution: ActiveExecution, value: ControlEvent): void {
    // A Driver that declares `live: "agent_output"` (dsh) proves a packet recorded by the Turn's first agent text, thinking or
    // tool call, never by a plan or usage (ADR-055 §7.1 weak E1, C8): E1 is committed before that output (R3).
    if (execution.relay.declaration.capabilities?.delivery.live === "agent_output" && execution.relay.turn.kind === "carry" && !execution.relay.recorded
        && ((value.type === "text" || value.type === "thinking") && value.text !== "" || value.type === "tool")) this.inputRecorded(execution, undefined, "agent_output");
    if (value.type === "text" || value.type === "thinking") { this.streamChunk(execution, value); return; }
    if (value.type === "input_recorded") { this.inputRecorded(execution, value.packetId, "recorded_event"); return; }
    this.flushStream(execution);
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    if (VISIBLE_OUTPUT.has(value.type)) this.firstOutput(state, run);
    if (value.type === "permission_requested") {
      if (this.permissions.size >= 32) throw new SessionError("PERMISSION_LIMIT", "too many pending native permissions");
      // The Turn now waits for the user: its execution budget pauses and its wait budget runs (ADR-036). The request expires at
      // the earlier of the program's own deadline, as its driver says, and the end of the wait budget, on this clock (ADR-035).
      const requestedAt = this.options.now().getTime(), hubLeft = Math.round(this.enterWait(execution, run.id)), wait = value.expiresInMs;
      const native = value.expiresBy === "native" && wait !== undefined && Number.isSafeInteger(wait) && wait >= 0 && wait <= MAX_PERMISSION_WAIT_MS ? wait : null;
      const expires = native !== null && native <= hubLeft ? { expiresAt: requestedAt + native, expiresBy: "native" as const } : { expiresAt: requestedAt + hubLeft, expiresBy: "turn" as const };
      const id = "permission-" + this.options.id(), request: PermissionRequest = { id, runId: run.id, title: value.title, options: value.options, ...(value.detail===undefined?{}:{detail:value.detail}),...(value.input===undefined?{}:{input:value.input}), decided: false, requestedAt, ...expires, ...(value.kind === "question" ? { kind: "question" as const } : {}) };
      this.permissions.set(id, { request, nativeId: value.id, execution, option: null, command: null, harnessId: run.selection.harnessId });
      try { this.commit(state.id, current => ({ next: current, events: [event("permission.requested", { permissionId: id, runId: run.id, title: value.title, options: value.options, ...expires })] })); } catch (error) { this.permissions.delete(id); throw error; } return;
    }
    if (value.type === "permission") {
      // The Harness withdrew a question it had asked (for example its own dialog deadline): the public request closes too.
      const pending = [...this.permissions.entries()].find(([, item]) => item.execution === execution && item.nativeId === value.id && item.option === null);
      if (pending) {
        this.permissions.delete(pending[0]);
        this.commit(state.id, current => ({ next: current, events: [event("permission.closed", { permissionId: pending[0], runId: run.id, reason: value.decision })] }));
        this.leaveWait(execution);
        return;
      }
    }
    if (value.type === "output") { this.nativeOutput(execution, state, run, value.output); return; }
    if (value.type === "tool") {
      // The public summary keeps a bounded set of tools; a long native turn must not fail or block the Runtime because of it.
      const tools = [...(run.tools ?? [])], index = tools.findIndex(tool => tool.id === value.id);
      if (index < 0 && tools.length >= MAX_RUN_TOOLS) return;
      const detail = value.detail === undefined ? execution.details.get(value.id) : mergeDetail(execution.details.get(value.id), value.detail);
      if (value.detail !== undefined && detail !== undefined) { execution.details.set(value.id, detail); execution.dirty.add(value.id); }
      const prior = index < 0 ? undefined : tools[index];
      const tool = { id: value.id, title: value.title, status: value.status, ...(detail?.kind === undefined ? {} : { kind: detail.kind }), ...(detail?.name === undefined ? {} : { name: detail.name }),
        ...(detail?.parentId === undefined ? {} : { parentId: detail.parentId }), ...(detail?.exitCode === undefined ? {} : { exitCode: detail.exitCode }), ...(prior?.detail === undefined ? {} : { detail: prior.detail }) };
      // Refinements that only change the private detail create no public fact until the detail is stored.
      if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(tool)) {
        if (index >= 0) tools[index] = tool; else tools.push(tool);
        this.commit(state.id, current => ({ next: updatedRun(current, run.id, { tools }), events: [event("run.output", { runId: run.id, event: logged(value) })] }));
      }
      if (TERMINAL_TOOL.has(value.status) && execution.dirty.has(value.id)) this.storeDetail(execution, value.id);
      return;
    }
    if (value.type === "notice" && (run.notices ?? []).length >= MAX_RUN_NOTICES) return;
    if (value.type === "activity" && !(run.activities ?? []).some(item => item.id === value.id) && (run.activities ?? []).length >= MAX_RUN_ACTIVITIES) return;
    this.commit(state.id, current => {
      let next = current;
      if (value.type === "plan") next = updatedRun(current, run.id, { plan: { entries: value.entries.slice(0, MAX_PLAN_ENTRIES).map(entry => ({ ...entry, content: bounded(entry.content, 4096).text || "…" })), ...(value.explanation ? { explanation: bounded(value.explanation, 4096).text } : {}) } });
      if (value.type === "usage") next = updatedRun(current, run.id, { usage: { ...run.usage, ...(value.usage.turn === undefined ? {} : { turn: { ...run.usage?.turn, ...value.usage.turn } }), ...(value.usage.context === undefined ? {} : { context: value.usage.context }), ...(value.usage.cost === undefined ? {} : { cost: value.usage.cost }) } satisfies NativeUsage });
      if (value.type === "notice") {
        // Harnesses restarted per Turn repeat their startup warnings; a notice already shown in this conversation stays in the log only.
        const notice = { severity: value.severity, title: bounded(value.title, 1024).text || "提示", ...(value.detail ? { detail: bounded(value.detail, 4096).text } : {}) }, same = JSON.stringify(notice);
        if (!current.runs.some(item => item.notices?.some(prior => JSON.stringify(prior) === same))) next = updatedRun(current, run.id, { notices: [...(run.notices ?? []), notice] });
      }
      if (value.type === "activity") {
        const activities = [...(run.activities ?? [])], index = activities.findIndex(item => item.id === value.id);
        const activity = { id: bounded(value.id, 512).text, kind: value.kind, title: bounded(value.title, 1024).text || value.kind, status: value.status, ...(value.detail ? { detail: bounded(value.detail, 4096).text } : {}) };
        if (index >= 0) activities[index] = activity; else activities.push(activity);
        next = updatedRun(current, run.id, { activities });
      }
      return { next, events: [event("run.output", { runId: run.id, event: logged(value) })] };
    });
  }
  /**
   * E1 (ADR-055 §7.1, §14.2): the native side recorded this Turn's input. For a Turn carrying a packet the text window open
   * before it is committed first, then one transaction records `relay.input_recorded`, the delivery decided recorded(E1) and
   * the binding synced on the packet, with the Run's recordedAt (never its first output). A Turn without a packet only keeps
   * it in memory for its settlement (an ordinary Turn adds no event). An entry the Driver saw with another packet, a second
   * report, or one after the Turn stopped running decides nothing. `live` is the evidence the event names: the Driver's own
   * report of the entry (`recorded_event`), or the Turn's first agent output (`agent_output`, R3). An E1 the Store refuses
   * (its relay rows, a binding that changed) is not recorded, nor tried again in the Turn, and the settlement decides as without
   * it (R6, M-9); a Store that failed fails the Runtime as any commit does.
   */
  private inputRecorded(execution: ActiveExecution, packetId: RelayPacket["id"] | undefined, live: "recorded_event" | "agent_output"): void {
    const relay = execution.relay, turn = relay.turn;
    // Once per Turn: one the Store refused is not tried again at every later output (G068 fix batch 2, M-9).
    if (relay.recorded || relay.e1Refused) return;
    if (turn.kind !== "carry") { if (turn.kind === "plain") relay.recorded = true; return; }
    if (packetId !== undefined && packetId !== turn.packetId) return;
    this.flushStream(execution);
    const state = this.owned(execution), run = state.runs.find(row => row.id === execution.runId)!;
    if (run.status !== "running") return;
    const recordedAt = this.options.now().getTime();
    const ownOf = (current: SessionSnapshot) => current.nativeBindings?.find(row => row.harnessId === run.selection.harnessId && row.controlId === run.selection.controlId && row.status !== "archived");
    const before = ownOf(state);
    // A binding that is no longer pending on this packet (a bug) takes nothing from it; the settlement decides as without E1.
    if (before?.relay === undefined || recordedStep(before.relay, turn, { seq: state.lastSeq + 1, time: recordedAt }) === null) return;
    let committed = false;
    try {
      this.commit(state.id, current => {
        const own = ownOf(current), outcome = own?.relay === undefined ? null : recordedStep(own.relay, turn, { seq: current.lastSeq + 1, time: recordedAt });
        if (outcome === null) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "the binding changed while E1 was recorded");
        const mark = outcome.relay.sync.kind === "synced" ? outcome.relay.sync.mark : null;
        let next = updatedRun(current, run.id, phase(current, run.id, "recordedAt", recordedAt));
        next = { ...next, nativeBindings: next.nativeBindings?.map(row => row === own ? { ...row, relay: outcome.relay } : row) ?? [] };
        return { next, events: [event("relay.input_recorded", { runId: run.id, packetId: turn.packetId, recordedAt, mark, live })], relay: { deliveries: outcomeWrites(outcome.deliveries) } };
      }, true);
      committed = true;
    } catch (error) {
      if (!this.relayRefusal(error)) { if (!expectedFailure(error)) this.fail(error, state.id); throw error; }
      relay.e1Refused = true;
    }
    if (committed) relay.recorded = true;
  }
  /** Records the Run's first visible output at the clock's reading now, once, as its own committed fact (never held in a window). */
  private firstOutput(state: SessionSnapshot, run: PublicRun): void {
    if (run.timing === undefined || run.timing.firstOutputAt !== undefined) return;
    this.commit(state.id, current => ({ next: updatedRun(current, run.id, phase(current, run.id, "firstOutputAt", this.options.now().getTime())), events: [event("run.first_output", { runId: run.id })] }));
  }
  /**
   * A chunk of reply text or thinking joins the window open for its kind, or opens one (ADR-047); a window of the other
   * kind is committed first, so the log keeps their order. A window is committed when its timer runs out, when it holds
   * STREAM_WINDOW_BYTES, and before anything else of the Turn is committed. Ownership, the Run's status and its first output
   * are checked when a window opens, so at least once per window. The output budget is counted exactly per chunk: the chunk
   * that would exceed it commits the window before it and is refused, as it was refused on its own commit before.
   */
  private streamChunk(execution: ActiveExecution, value: Extract<ControlEvent, { type: "text" | "thinking" }>): void {
    const stream = execution.stream;
    if (stream.kind !== null && stream.kind !== value.type) this.flushStream(execution);
    let { committedBytes, bytes, last } = stream;
    if (stream.kind === null) {
      // A window opens on the Run's facts as committed: ownership, status, first output, and the bytes of its kind so far.
      const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
      if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
      this.firstOutput(state, run);
      const committed = value.type === "text" ? state.messages.find(message => message.id === run.assistantMessageId)?.text ?? "" : run.thinking ?? "";
      committedBytes = bytes = utf8Bytes(committed); last = committed.slice(-1);
    }
    const joined = joinedBytes(bytes, last, value.text);
    if (joined > MAX_OUTPUT_BYTES) {
      // A refused chunk opens no window (nothing empty is committed); what was open before it is committed first.
      this.flushStream(execution);
      throw new SessionError("OUTPUT_LIMIT", value.type === "text" ? "Run public output byte budget exhausted" : "native thinking exceeded its budget");
    }
    if (stream.kind === null) { stream.kind = value.type; stream.text = ""; stream.committedBytes = committedBytes; }
    stream.text += value.text; stream.bytes = joined; stream.last = value.text ? value.text.slice(-1) : last;
    if (stream.bytes - stream.committedBytes >= STREAM_WINDOW_BYTES) { this.flushStream(execution); return; }
    stream.cancel ??= this.timer(() => this.windowExpired(execution), STREAM_WINDOW_MS);
  }
  /**
   * Commits the open window as one run.output event of its kind, with the window's text (ADR-047); no open window is nothing
   * to do. The window is taken before the commit, so a refused commit loses that window only and never commits it twice;
   * ownership and the Run's running status are checked as for any output.
   */
  private flushStream(execution: ActiveExecution): void {
    const stream = execution.stream;
    if (stream.kind === null) return;
    const kind = stream.kind, text = stream.text;
    this.discardStream(execution);
    const state = this.owned(execution), run = state.runs.find(run => run.id === execution.runId)!;
    if (run.status !== "running") throw new SessionError("STALE_EVENT", "output arrived outside its active Run");
    this.commit(state.id, current => {
      let next: SessionSnapshot;
      if (kind === "thinking") {
        const thinking = (current.runs.find(item => item.id === run.id)?.thinking ?? "") + text;
        if (utf8Bytes(thinking) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "native thinking exceeded its budget");
        next = updatedRun(current, run.id, { thinking });
      } else {
        const message = current.messages.find(message => message.id === run.assistantMessageId), merged = (message?.text ?? "") + text;
        if (utf8Bytes(merged) > MAX_OUTPUT_BYTES) throw new SessionError("OUTPUT_LIMIT", "Run public output byte budget exhausted");
        next = { ...current, messages: message ? current.messages.map(item => item.id === message.id ? { ...item, text: merged } : item)
          : [...current.messages, { id: run.assistantMessageId, runId: run.id, role: "assistant", text: merged, seq: current.lastSeq + 1, status: run.status }] };
      }
      return { next, events: [event("run.output", { runId: run.id, event: { type: kind, text } })] };
    });
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
  /** Stores one tool's latest bounded detail and publishes its reference. Storage trouble is reported, not hidden. */
  private storeDetail(execution: ActiveExecution, toolId: string): void {
    const content = this.options.content; if (content === undefined) return;
    this.enqueue(execution, async () => {
      const detail = execution.details.get(toolId); if (detail === undefined || !execution.dirty.delete(toolId)) return;
      const state = this.owned(execution);
      let ref;
      try { ref = await content.storeOutput({ workspace: state.configuration.workspace, name: "tool-" + safeName(toolId) + ".json", mediaType: "application/json", data: new TextEncoder().encode(JSON.stringify({ toolId, ...detail })) }); }
      catch (error) { this.commit(state.id, current => ({ next: current, events: [event("run.output", { runId: execution.runId, event: { type: "diagnostic", message: "tool detail was not stored (" + fault(error).code + ")" } })] })); return; }
      const after = this.owned(execution), run = after.runs.find(row => row.id === execution.runId)!;
      if (!run.tools?.some(tool => tool.id === toolId)) return;
      this.commit(after.id, current => ({ next: updatedRun(current, run.id, { tools: run.tools!.map(tool => tool.id === toolId ? { ...tool, detail: ref } : tool) }), events: [event("run.tool_detail", { runId: run.id, toolId, content: ref })] }));
    });
  }
  /** Non-text native output: links are recorded as given; bytes go to the content owner first. */
  private nativeOutput(execution: ActiveExecution, state: SessionSnapshot, run: PublicRun, output: Extract<ControlEvent, { type: "output" }>["output"]): void {
    if ((run.outputs ?? []).length >= MAX_RUN_OUTPUTS) return;
    if (output.kind === "link") {
      this.commit(state.id, current => ({ next: updatedRun(current, run.id, { outputs: [...(run.outputs ?? []), { kind: "link", uri: bounded(output.uri, 4096).text, name: bounded(output.name, 1024).text || "链接", ...(output.title ? { title: bounded(output.title, 1024).text } : {}), ...(output.mediaType ? { mediaType: output.mediaType.slice(0, 255) } : {}) }] }),
        events: [event("run.output", { runId: run.id, event: logged({ type: "output", output }) })] }));
      return;
    }
    const content = this.options.content;
    if (content === undefined) { this.commit(state.id, current => ({ next: current, events: [event("run.output", { runId: run.id, event: { type: "diagnostic", message: "native " + output.mediaType + " output was not kept (no content storage)" } })] })); return; }
    this.enqueue(execution, async () => {
      let ref;
      try { ref = await content.storeOutput({ workspace: state.configuration.workspace, name: output.name, mediaType: output.mediaType, data: output.data }); }
      catch (error) { const owned = this.owned(execution); this.commit(owned.id, current => ({ next: current, events: [event("run.output", { runId: run.id, event: { type: "diagnostic", message: "native output was not stored (" + fault(error).code + ")" } })] })); return; }
      const after = this.owned(execution), current = after.runs.find(row => row.id === execution.runId)!;
      if ((current.outputs ?? []).length >= MAX_RUN_OUTPUTS) return;
      this.commit(after.id, snapshot => ({ next: updatedRun(snapshot, current.id, { outputs: [...(current.outputs ?? []), { kind: "content", content: ref }] }), events: [event("run.output", { runId: current.id, event: logged({ type: "output", output }) })] }));
    });
  }
  /** Keeps the write chain alive; an ownership or Store failure is retained for the Turn owner to report. */
  private enqueue(execution: ActiveExecution, job: () => Promise<void>): void {
    execution.writes = execution.writes.then(job).catch((error: unknown) => { execution.writeFailure ??= error; });
  }
  /** Drains this Turn's content writes while its binding is still owned; called before cleanup. */
  private async flushNative(execution: ActiveExecution): Promise<void> {
    for (const toolId of [...execution.dirty]) this.storeDetail(execution, toolId);
    await execution.writes;
    if (execution.writeFailure !== null) throw execution.writeFailure;
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
      backendSettled: false, stop: null, earlyClose: null, details: new Map(), dirty: new Set(), writes: Promise.resolve(), writeFailure: null, diagnosticMark: null,
      budget: { executionLeftMs: this.options.executionBudgetMs ?? DEFAULT_EXECUTION_BUDGET_MS, waitLeftMs: (this.options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS) - (this.waitUsed.get(target) ?? 0),
        waiting: false, since: performance.now(), timer: null }, stopReason: null, grace: null,
      stream: { kind: null, text: "", committedBytes: 0, bytes: 0, last: "", cancel: null }, streamFailure: null,
      relay: { declaration: relayDeclaration(null), openCheck: null, turn: { kind: "none" }, settledCheck: null, recorded: false, io: { asked: false, healthy: undefined, abandoned: [], broke: false },
        e1Refused: false, key: null, observed: undefined, endEvents: [], consent: null } };
    if (this.actives.has(id)) throw new SessionError("OWNERSHIP_LOST", "another Turn of this conversation is active");
    this.actives.set(id, execution); this.waitUsed.delete(target);
    // The execution budget runs from here: starting the program, its model, tools and result (ADR-036).
    this.armBudget(execution);
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
    // The relay reason of a relay failure before dispatch, for the Turn's end (RELAY_CHOICE_REQUIRED's cause and the like).
    let relayReason: string | null = null;
    // Whether this Turn opened a native session anew (no checkpoint: a new binding, opensNew, or C5's replacement); such a session
    // was never prompted, so a Turn that ends before dispatching into it keeps the binding opening a new one (G068 fix batch 2,
    // I-1a). C5 (I-1b): the checkpoint the Driver refused as a session it does not have, and how its connection was closed.
    let openedNew = false, replacedEmpty: string | null = null, refusedCleanup: CleanupEvidence | null = null;
    try {
      this.commit(id, current => ({ next: { ...updatedRun(current, target, { status: "preparing", selection: pinned, epoch: waitedSwitch ? current.epoch : queued.epoch, ...phase(current, target, "preparingAt", this.options.now().getTime()) }), activeRunId: target },
        events: [event("run.preparing", { runId: target, selection: state.selection, epoch: state.epoch })] }));
      const current = this.owned(execution), run = this.continue(execution);
      previousNative = run.selection.provider === undefined ? current.nativeBindings?.find(binding => binding.harnessId === run.selection.harnessId && binding.controlId === run.selection.controlId && binding.status !== "archived") : undefined;
      if (previousNative !== undefined && previousNative.status !== "ready") throw new SessionError("NATIVE_STATE_UNCONFIRMED", "原生会话状态尚未确认；可以切换其他 Harness，或明确建立新的原生分支。公共历史会保留。");
      // prePlan (ADR-055 §6.1, VF3-02): a queued input's admission again, on the conversation as it is now (a Turn before it may
      // have changed the model, cleared, or the user withdrawn a consent): one that no longer passes fails with the same error
      // before anything is started, its binding as it was.
      if (run.selection.provider === undefined && this.relayGated()) this.admitRelay(current, run.input, run.attachments?.map(file => file.kind) ?? [], this.choicesOf(current, run), run.selection, run);
      // A process the conversation kept takes the Turn when it still runs this selection and its binding needs no check at
      // an open (ADR-055 §7.4, VF1-09); any other kept process is closed first and the Turn starts the program as usual (ADR-030).
      reusing = run.selection.provider === undefined ? await this.takeKept(id, run.selection, previousNative?.relay) : null;
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
      execution.relay.key = this.readsKey(id, run.selection);
      const kinds = run.attachments?.map(file => file.kind) ?? [], reading = this.classify(control, run.input, null, kinds);
      // The relay packet (ADR-055 §5): what this binding's program and this Gateway hold as secrets never leaves in it, and an
      // input read as a possible command never opens it, so the packet cannot become a command's argument.
      // The secrets are the whole Session's (M1): the target binding's own, and those of every Harness whose history it carries.
      // They and the tool details are read only for a Turn that builds a packet (N3): a command reads nothing for one, and a
      // configuration that cannot be read fails only a Turn that would carry history.
      const relayFor = async (state: SessionSnapshot, sources: readonly PublicRun["id"][], origin: boolean): Promise<PublicContextOptions> => {
        const details = await this.relayDetails(state, sources), secrets = [...(execution.binding?.secrets ?? []), ...await this.relaySecretsOf(state, run, sources, origin)];
        this.continue(execution);
        return { origin, secrets, firstLine: reading.kind === "content", details, ...(this.options.harnessName === undefined ? {} : { names: this.options.harnessName }) };
      };
      if (native === null) {
        const observation = await control.initialize(); this.continue(execution);
        this.commit(id, current => ({ next: current, events: [event("run.protocol", { runId: target, observation })] }));
        // A requested value the native session changed itself is applied as it is now instead of being reverted (ADR-028).
        const carriedConfiguration = carriedNativeConfiguration(current, run.selection, run.epoch);
        if (carriedConfiguration !== null) this.commit(id, current => ({ next: current, events: [event("native.config_carried", { runId: target, ...carriedConfiguration })] }));
        const nativeOptions = carriedConfiguration?.options === undefined ? run.selection.nativeOptions : { ...run.selection.nativeOptions, ...carriedConfiguration.options };
        // A binding whose native session the Driver replaced by none yet (opensNew, R4) opens a new one: its checkpoint names the
        // abandoned session, never resumed.
        const resumeFrom = previousNative?.opensNew === true ? undefined : previousNative?.checkpoint;
        const open = (on: HarnessControl, from: string | undefined) => on.open(execution.binding!.workspace, carriedConfiguration?.model ?? run.selection.nativeModel, nativeOptions, from);
        try { native = await open(control, resumeFrom); }
        catch (error) {
          // C5 (ADR-055 §7.5; G068 fix batch 2, I-1b): a native session that holds nothing the relay counts on (Claude's empty
          // session after its synthesized clear, never prompted) that the Driver refuses as one it does not have — that refusal
          // only, never a timeout or a failed connection — is replaced by a new one, its relay state and floor as they are, on a
          // new connection: the refused one may be failed by the refusal. A binding with a watermark is never replaced.
          if (resumeFrom === undefined || previousNative === undefined || fault(error).code !== "NATIVE_SESSION_NOT_FOUND" || !holdsNothing(current, previousNative)) throw error;
          ({ control, closed: refusedCleanup } = await this.restartProgram(execution, run, current, id, target, error));
          native = await open(control, undefined);
          replacedEmpty = resumeFrom;
        }
        openedNew = resumeFrom === undefined || replacedEmpty !== null;
        this.continue(execution);
      }
      opened = native;
      // The endpoint and model the open session runs on, as its Driver resolved them (ADR-055 §10.4): the open's consent check
      // reads it, and the binding caches it with this Turn for the next admission.
      if (run.selection.provider === undefined && control.relayVendor !== undefined) { execution.relay.observed = await this.observeVendor(control); this.continue(execution); }
      // The Session as the binding's preparation committed it: what the relay reads below (the binding's relay state, the facts).
      let prepared: SessionSnapshot = current;
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
                  nativeEpoch: bound.relay!.nativeEpoch, epochFloor: bound.relay!.epochFloor, ...(refusedCleanup === null ? {} : { cleanup: refusedCleanup }) })])] };
          }).session;
          checkpointStored = true;
        }
      }
      // Before authorization the native reading decides whether the input is a command (ADR-055 R0b): a command goes as
      // typed and carries nothing, whatever it owes. A reading that is or may be a command is settled against the catalog
      // (its effect, and the commands the driver itself offers there).
      let classified = reading;
      if (classified.kind !== "content" && control.models) { const catalog = await control.models(); this.continue(execution); classified = this.classify(control, run.input, catalog, kinds); }
      // A Driver that declares nothing and reads nothing of its own cannot say what its native side takes for a command: a slash
      // first is one of unknown effect, whatever its catalog lists or whether it has one (G072 review I3).
      if (classified.kind !== "command" && control.relayCapabilities === undefined && control.classify === undefined && run.selection.provider === undefined) classified = undeclaredReading(run.input) ?? classified;
      // C7 (G072): admission read the input by the target's static declaration without a catalog; a definite command it asked
      // nothing for that now reads as content (or a command whose arguments the native side submits), or content it checked
      // that now reads as a command, fails before dispatch (classification_changed). A word only the catalog settles was asked
      // as content at admission, so whatever the catalog makes of it was checked.
      // It fails only a Turn the change matters to: one that would now carry a packet admission never checked, or a command
      // whose binding is owed something admission meant to send with it; a single-Harness conversation is never stopped.
      let changedReading: "to_command" | "to_content" | null = null;
      if (this.relayGated() && run.selection.provider === undefined && control.relayCapabilities !== undefined) {
        const admitted = control.relayCapabilities.commands.classify(run.input, null, kinds);
        if (admitted.kind !== "possible_command" && carriesWithReading(admitted) !== carriesWithReading(classified)) changedReading = carriesWithReading(classified) ? "to_content" : "to_command";
      }
      // A command whose arguments the native side submits as a prompt (acceptsRelay: Codex `/skill:…`, Hermes `/queue`, `/steer`)
      // is a content Turn to the relay: it may carry a packet, which its Driver places (C7).
      if (classified.kind === "command" && classified.acceptsRelay !== true) {
        const named = classified; command = named;
        prepared = this.commit(id, current => ({ next: current, events: [event("run.native_command", { runId: target, name: named.name, publicContextInjected: false, contextEffect: named.effect })] })).session;
      }
      // The open's check (ADR-055 §6.1 finalize, §7.3): planned for every Turn on a binding that keeps relay state, a skipped
      // plan included (F2), and answered by the Driver when it asks for anything; committed with the authorization below.
      const h = run.selection.harnessId, c = run.selection.controlId;
      const bound = checkpointStored ? prepared.nativeBindings?.find(row => row.harnessId === h && row.controlId === c && row.status !== "archived" && row.relay !== undefined) : undefined;
      const now = () => this.options.now().getTime();
      // The relay choices the input was accepted with; an input sent alone asks the Driver nothing at its open (M-3 below).
      const requested: RelayChoices = command === null ? this.choicesOf(prepared, run) : {};
      let rows: readonly BindingDelivery[] = [], checked: BindingRelayState | null = null;
      if (bound !== undefined) {
        // Only a binding that waits for a packet, is in doubt or stands on one has delivery rows to read (§11.1, R8): a fresh one
        // or one synced on its own Turns plans no check, so an ordinary Turn reads no row and no event for its relay.
        rows = this.rowsMatter(bound.relay!, declaration.verify) ? this.relayDeliveries(prepared, bound) : [];
        const plan = planReturnVerify(bound.relay!, { verify: declaration.verify, moment: "open", deliveries: rows });
        // Bounded like the settlement's (C6, R2): a check that does not answer in time is unavailable. The Driver is not asked
        // (every marker unavailable, and the check says why) for an input sent alone — a read could only keep it from going — nor
        // on a binding an earlier read of this process broke the connection of (G068 fix batch 2, M-3).
        const unasked = this.unasked(execution, control, plan, requested.attach === "none");
        const result = await this.verifyFor(execution, control, native, plan, unasked);
        if (plan.kind !== "skip") this.continue(execution);
        // The Driver contract asks only for packets: an unknown Turn without one cannot be looked for, so its entry is unavailable.
        execution.relay.openCheck = { plan, result, ...(plan.kind === "unknown_turn" && plan.marker === null ? { turnEntry: "unavailable" as const } : {}), ...(unasked === undefined ? {} : { unasked }), moment: "open" };
        checked = checkStep(bound.relay!, execution.relay.openCheck, run.id, { seq: prepared.lastSeq + 1, time: now() }).relay;
      }
      // C7: content admission checked now reads as a command; it fails only when its binding is owed something (a packet it waits
      // for, or facts above its mark), which admission meant to send with it. With the permissive defaults (permissive-defaults
      // §2.5) it does not fail: the Turn is decided again by the reading of the open, as the command it is — as typed, the packet
      // left owed for the next content input — and the Turn's record says so.
      // The settings are an installation read: made only where the relay has something to decide with them (an ordinary Turn makes none).
      const accepted = this.choicesOf(prepared, run);
      let known: RelaySettings | null = null;
      const settingsNow = (): RelaySettings => known ??= this.settings(), lenient = (): boolean => settingsNow().whenUnsure === "auto" && !explicitChoice(accepted);
      let reclassified: RelayDecision | null = null;
      if (changedReading === "to_command" && command !== null && checked !== null) {
        const owedNow = owed(checked, h, c, this.relayFacts(prepared, { harnessId: h, controlId: c, nativeEpoch: checked.nativeEpoch }), { originHistory: (prepared.origin?.history.length ?? 0) > 0, heldSince: heldSinceIn(prepared, h, c, checked) });
        if (checked.sync.kind === "pending" || owedNow.facts.length > 0 || owedNow.origin) {
          if (!lenient()) throw classificationChanged();
          reclassified = { kind: "alone", by: "policy", cause: "classification_changed" };
        }
      }
      // What the Turn sends (ADR-055 §7.2, §9): a command goes as typed; a content input as typed when nothing is owed, alone
      // when the user chose so, or with a packet of what is owed (a pending packet resent, a suspect one only on the user's choice).
      let decision: TurnDecision | null = null, working: BindingRelayState | null = checked, clearFloor: number | null = null;
      // G072: what the open's gates found (vendor key, consent, window and budget), the secrets the packet was redacted with, and the native title.
      let gate: OpenGate | null = null, packetSecrets: readonly string[] = [];
      // Sends the Turn as typed instead of with its packet, for a reason that concerns the packet only (set where the decision is made).
      let aloneInstead: ((found: NonNullable<ReturnType<typeof policyAloneOf>>) => void) | null = null;
      let turnText: TurnText = run.input, packet: { readonly manifest: RelayPacket; readonly body: string; readonly record: PublicContext["relay"]; readonly runs: readonly PublicRun["id"][]; readonly origin: boolean } | null = null;
      let position: DeliveryPosition | null = null;
      if (command === null) {
        const originHistory = (prepared.origin?.history.length ?? 0) > 0;
        working ??= initialBindingRelay(prepared.nativeBindings ?? [], h, c, "new");
        const factsOn = (relay: BindingRelayState) => this.relayFacts(prepared, { harnessId: h, controlId: c, nativeEpoch: relay.nativeEpoch });
        let facts = factsOn(working);
        const since = heldSinceIn(prepared, h, c, working);
        // The user's choices matter unless the binding is synced and owes nothing even below its floor: then b and n, attached or
        // not, all go as typed and leave it as it is (§7.2); only a request for the history is kept, to say there was none (A9).
        const all = owed(working, h, c, facts, { originHistory, attachOverride: true, heldSince: since });
        const choices: RelayChoices = working.sync.kind === "synced" && all.facts.length === 0 && !all.origin
          ? { ...(requested.attach === "full" ? { attach: "full" as const } : {}), ...(requested.resend === true ? { resend: true as const } : {}) } : requested;
        // The user's ［确认已清空］ (§9): e at the clear's floor candidate while the open's check left the clear undecided. A check that
        // confirmed the clear itself needs it no more; any other answer of the check fails this Run before dispatch, saying so —
        // the confirmation is acted on or refused, never dropped (G068 fix batch 2, M-1).
        if (requested.clearConfirmed === true) {
          const undecided = working.sync;
          if (bound !== undefined && undecided.kind === "suspect" && undecided.cause === "clear_unconfirmed" && undecided.floorCandidate !== null) {
            const confirmed = step(working, { kind: "cleared", seq: undecided.floorCandidate });
            if (confirmed.kind !== "applied") throw clearNotConfirmed();
            clearFloor = undecided.floorCandidate; working = confirmed.relay; facts = factsOn(working);
          } else if (!(bound !== undefined && checked !== null && checked.nativeEpoch > bound.relay!.nativeEpoch)) throw clearNotConfirmed();
        }
        const sync = working.sync, epochRows = rows.filter(row => row.nativeEpoch === working!.nativeEpoch);
        decision = decideTurn({ relay: working, harnessId: h, controlId: c, facts, originHistory, choices, declaration, firstFromSeq: epochRows[0]?.range.fromSeq ?? null,
          pendingRun: sync.kind === "pending" ? this.pendingRunOf(prepared, rows, sync.packetId) : null, recoveryFailed: prepared.relayRecoveryFailed !== undefined, heldSince: heldSinceIn(prepared, h, c, working),
          whenUnsure: () => settingsNow().whenUnsure, topOf: need => rangeOf(prepared, need, needRuns(prepared, run, need)).throughSeq });
        // C7: a command admission asked nothing for that now reads as content may carry no packet admission never checked. With the
        // permissive defaults the open's own checks (the probe gate, the data root, consent, the window) are the ones that apply.
        if (changedReading === "to_content" && decision.kind === "carry") {
          if (!lenient()) throw classificationChanged();
          if (decision.cause === undefined) decision = { ...decision, cause: "classification_changed" };
        }
        // What the preparation of the packet found that concerns the packet only: the input goes as typed (permissive-defaults §0).
        const asAlone = (found: NonNullable<ReturnType<typeof policyAloneOf>>): void => {
          decision = { kind: "alone", by: "policy", cause: found.cause, ...(found.reason === undefined ? {} : { reason: found.reason }) };
          gate = null; packet = null; turnText = run.input; packetSecrets = []; execution.relay.consent = null;
        };
        aloneInstead = asAlone;
        if (decision.kind === "carry") {
          try {
            const runs = needRuns(prepared, run, decision.need);
            // G072's checks at the open (§6.1 finalize, §9): the probe gate on this Driver's own declaration, the vendor key it
            // observed against the consent and the data root, and the refined window; each fails the Run before dispatch.
            gate = this.relayGated() ? this.openGates(prepared, run, bound, working, decision, declaration, requested, kinds) : null;
            // The renderer sees the binding on which what is owed was reckoned (a retreat's prior, else the binding as it is).
            const options = await relayFor(prepared, runs, decision.need.origin);
            packetSecrets = options.secrets ?? [];
            const context = buildPublicContext(renderView(prepared, h, c, decision.on), run, runs, gate === null ? options : { ...options, budget: gate.budget });
            this.continue(execution);
            if (!context.text.endsWith("\n" + run.input)) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render" }, "没能准备交接单：交接单与这条消息拼接不一致，这条消息没有发出。");
            const body = context.text.slice(0, context.text.length - run.input.length - 1), range = rangeOf(prepared, decision.need, runs);
            const manifest = packetManifest({ state: prepared, run, relay: working, record: context.relay, body, range, runs, attachOverride: decision.attachOverride || sync.kind === "pending" && sync.attachOverride,
              supersedes: decision.resend !== null && sync.kind === "pending" ? sync.packetId : null, firstLineOmitted: !context.relay.firstLine,
              ...(gate === null ? {} : { vendor: gate.vendor, window: gate.window, clamped: gate.clamped }) });
            packet = { manifest, body, record: context.relay, runs, origin: decision.need.origin };
            turnText = { user: run.input, relay: { packetId: manifest.id, body, firstLine: context.relay.firstLine } };
            // C3 (G072): the placed Turn measured as its Driver will place it; over the Driver's bound it fails here, before dispatch,
            // the Driver's own refusal (INPUT_LIMIT_REFUSED) staying the backstop.
            const limit = declaration.capabilities?.placement.maxInput ?? null;
            if (gate !== null && limit !== null && declaration.capabilities!.placement.measure(turnText, kinds) > limit.limit) throw inputLimit("input_limit", run.selection);
          } catch (error) {
            const found = policyAloneOf(error, settingsNow(), requested);
            if (found === null) throw error;
            asAlone(found);
          }
        }
        // Where the native history stands before a packet goes (F20): its delivery row keeps it for a later check. A Turn without a
        // packet reads none: D6's check of such a Turn is deferred for good (A16), so nothing would read it (R8).
        if (bound !== undefined && packet !== null && control.deliveryPosition !== undefined) { position = await this.positionOf(execution, control, native); this.continue(execution); }
      }
      // The relay's reads are done: none is still outstanding, and none left the connection failed (R2). Otherwise this Turn is
      // not dispatched — its input goes nowhere, the binding stays as it was — and the user sends it again.
      if (execution.relay.io.asked) { await this.relayReadsSettled(execution, control); this.continue(execution); }
      // One transaction (ADR-055 §6.1): the open's check, the packet and its delivery row, the binding's relay state, the Run's
      // relay, run.context_prepared and run.authorized. A relay row the Store refuses fails this Turn before dispatch (INV-35).
      const pendingSync = working?.sync.kind === "pending" ? working.sync : null;
      const factsSeq = prepared.lastSeq;
      const commitPrepared = (): void => { this.commit(id, latest => {
        const events: EventDraft[] = [], deliveries: RelayDeliveryWrite[] = [];
        let relay: BindingRelayState | null = latest.nativeBindings?.find(row => row.harnessId === h && row.controlId === c && row.status !== "archived")?.relay ?? null;
        if (bound === undefined) relay = null;
        const check = execution.relay.openCheck;
        if (relay !== null && check !== null) {
          const outcome = checkStep(relay, check, run.id, { seq: latest.lastSeq + 1 + events.length, time: now() });
          if (checkWorthAnEvent(check, outcome)) { events.push(verifiedEvent(check, outcome, run.id)); deliveries.push(...outcomeWrites(outcome.deliveries)); }
          relay = outcome.relay;
        }
        if (relay !== null && clearFloor !== null) {
          const confirmed = step(relay, { kind: "cleared", seq: clearFloor });
          if (confirmed.kind !== "applied") throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能确认清空：绑定的状态已经变化，这条消息没有发出。");
          relay = confirmed.relay;
          events.push(event("relay.clear_confirmed", { by: "user", runId: target, harnessId: h, controlId: c, floor: clearFloor, nativeEpoch: relay.nativeEpoch }));
        }
        if (relay !== null && working !== null && JSON.stringify(relay) !== JSON.stringify(working))
          throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能准备交接单：准备期间绑定的接力状态变了，这条消息没有发出。");
        const packets: { readonly runId: PublicRun["id"]; readonly packet: RelayPacket; readonly body: string }[] = [];
        if (packet !== null && decision?.kind === "carry") {
          packets.push({ runId: target, packet: packet.manifest, body: packet.body });
          if (relay !== null) {
            const carried = step(relay, { kind: "carry", runId: target, packet: { id: packet.manifest.id, range: packet.manifest.range }, attachOverride: decision.attachOverride, lateDelivery: decision.lateDelivery,
              resend: decision.resend, ...(decision.retreat === undefined ? {} : { retreat: decision.retreat }) });
            if (carried.kind !== "applied") throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能准备交接单：送达状态不允许携带它，这条消息没有发出。");
            relay = carried.relay;
            for (const change of carried.deliveries) {
              if (change.kind !== "insert") continue;
              deliveries.push({ kind: "insert", record: deliveryRow({ change, position: position ?? { kind: "none" }, relay, declaration, inputHmac: this.relayKeys.inputHmac(id, run.input),
                setTag: this.relayKeys.setTag(id, packetSecrets), rulesVersion: packet.record.policyVersion, keyId: this.relayKeys.keyId, consentLogSeq: gate?.consentLogSeq ?? null }) });
            }
            // The epoch's vendor key (§4 consentKey): the one the first packet went to, or the one the user consented to anew
            // (or the preference let the history go to, with the change recorded).
            // A vendor nobody saw (the read told nothing) is not the epoch's key: it neither sets one nor replaces the one the epoch has.
            if (gate !== null && !gate.unseen) relay = { ...relay, consentKey: gate.vendor };
            if (gate !== null && gate.changedFrom !== null) events.push(event("relay.vendor_changed", { harnessId: h, controlId: c, from: gate.changedFrom, to: gate.vendor, observedInRun: run.id, allowed: true }));
          }
        } else if (relay !== null && decision?.kind === "plain" && decision.owedNothing === true) {
          // A7 point 4: nothing is owed any more; the binding goes back to the pending packet's prior, nobody is asked.
          const back = step(relay, { kind: "owed_nothing" });
          if (back.kind !== "applied") throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能准备这条消息：送达状态不允许原样发送，这条消息没有发出。");
          relay = back.relay;
          events.push({ type: "relay.verified", data: { verifiedRunIds: [], moment: "open", plan: "owed_nothing", markers: [], historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 0,
            result: "nothing_owed", inRunId: run.id, recorded: [], sync: relay.sync.kind } });
        } else if (relay !== null && decision?.kind === "plain") {
          const plain = step(relay, { kind: "plain", foreign: decision.foreign, ...(decision.retreat === undefined ? {} : { retreat: decision.retreat }) });
          if (plain.kind === "applied") relay = plain.relay;
          else if (decision.retreat !== undefined) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能补发：送达状态不允许这样发送，这条消息没有发出。");
          // The user's complete packet had nothing to carry: the binding stands on the prior it moved back to (R5), recorded as a check would be.
          if (decision.retreat !== undefined) events.push(retreatEvent(relay, run.id));
        }
        // The vendor the open session runs on, cached for the next admission (§10.4, F10). A read that told nothing (null: it failed,
        // came late or the Driver could not tell) leaves what the binding last saw where it was (G072 review I1): the withdrawal
        // checks of the next admission and open stand on it.
        if (relay !== null && execution.relay.observed != null) relay = { ...relay, vendorObserved: execution.relay.observed };
        const executedOn = bound !== undefined && relay !== null ? { harnessId: h, controlId: c, nativeEpoch: relay.nativeEpoch } : null;
        const sources = packet?.runs ?? [];
        let next = updatedRun(latest, target, { contextThroughSeq: factsSeq, sourceRunIds: sources, relay: runRelayOf(packet?.manifest ?? null, continuityOf(decision, packet?.record ?? null, sources.length), executedOn) });
        next = updatedRun(next, target, phase(next, target, "contextReadyAt", now()));
        next = updatedRun(next, target, { status: "running", ...phase(next, target, "readyAt", now()) });
        if (relay !== null) { const settled = relay; next = { ...next, nativeBindings: next.nativeBindings?.map(row => row.harnessId === h && row.controlId === c && row.status !== "archived" ? { ...row, relay: settled } : row) ?? [] }; }
        // What the relay decided for the Turn and why (permissive-defaults §2.6): with the packet's record when one goes, alone otherwise;
        // an ordinary Turn that owes nothing records none. A command read differently at the open than at admission says so.
        const recorded = decisionRecord(decision) ?? reclassified, relayData = packet !== null ? { ...packet.record, ...(recorded === null ? {} : { decision: recorded }) } : recorded === null ? undefined : { decision: recorded };
        // `continuity` is the legacy word for how the Turn continued its context: a Turn the policy sent alone carried nothing of the
        // history, so it continued its native session (G072 review m12); any other keeps the word it always had.
        events.push(event("run.context_prepared", { runId: target, throughSeq: factsSeq, sourceRunIds: sources, continuity: decision?.kind === "alone" ? "native_resume" : "public_context_rehydrate",
          // The history the Session started from went too, which this binding was owed.
          ...(packet !== null && packet.origin ? { carriedOrigin: true } : {}),
          // What identifies the packet (policy, ID, sha256 of the text, the facts it carries, how it was folded); never its text.
          ...(relayData === undefined ? {} : { relay: relayData }),
          ...(packet !== null ? { range: packet.manifest.range, ...(decision?.kind === "carry" && decision.resend !== null ? { resendOf: decision.resend.of } : {}),
            ...(decision?.kind === "carry" && decision.retreat !== undefined ? { retreat: true } : {}), ...(decision?.kind === "carry" && decision.attachOverride ? { attachOverride: true } : {}) } : {}),
          // The user asked for the history and there was none to attach: it went as typed, which the conversation shows (A9).
          ...(decision?.kind === "alone" ? { alone: true } : {}), ...(decision?.kind === "plain" && decision.nothingToAttach ? { nothingToAttach: true } : {}),
          ...(decision?.kind === "plain" && decision.retreat !== undefined ? { retreat: true } : {}), ...(decision?.kind === "plain" && decision.owedNothing === true ? { owedNothing: true } : {}),
          // G072: the target's vendor key, the window the packet was budgeted against, and how a return continued (§7.3, §14.2).
          ...(gate === null ? {} : { vendor: gate.vendor, window: { size: gate.window.size, source: gate.window.source }, ...(gate.returning === null ? {} : { returnChoice: gate.returning }) }),
          // The consent the handoff rests on (permissive-defaults §2.4): what stood for the vendor, the log row it names, whether this first
          // use wrote it, and the layer the endpoint came from; and that the data directory is in the workspace's reach (a warning only).
          ...(gate === null || gate.consentVia === null ? {} : { consent: { via: gate.consentVia, logSeq: gate.consentLogSeq, ...(gate.first ? { first: true } : {}), ...(gate.layer === null ? {} : { layer: gate.layer }) } }),
          ...(gate !== null && gate.exposed ? { dataRootInWorkspace: true } : {}) }),
          event("run.authorized", { runId: target, epoch: run.epoch }));
        return { next, events, ...(packets.length || deliveries.length ? { relay: { ...(packets.length ? { packets } : {}), ...(deliveries.length ? { deliveries } : {}) } } : {}) };
      }); };
      // A first use the preference allows by itself is traced in the installation's log before the Turn that sends it is committed
      // (the delivery row names the row), and everything that concerns the packet alone — the log that cannot be written, a row the
      // Store refuses (its text, its quota) — sends the input as typed instead, once: the first attempt wrote nothing (INV-35).
      const attempt = (): void => {
        // The open's check made a synced binding suspect (its marker is gone) and the Turn retreats from it — the policy's complete
        // packet, or the user's — in the same breath: a mark goes back within an epoch only from a binding that was suspect when
        // the transaction began, so the check is committed on its own first, as the fact it is, and the retreat after it.
        const retreats = decision?.kind === "carry" && decision.retreat !== undefined || decision?.kind === "plain" && decision.retreat !== undefined;
        if (retreats && execution.relay.openCheck !== null && bound !== undefined) this.commitCheckApart(id, h, c, run.id, execution);
        if (gate !== null && gate.trace !== null) gate = { ...gate, consentLogSeq: this.traceDefaultAllow(gate.trace, run.selection, id) };
        commitPrepared();
      };
      try { attempt(); }
      catch (error) {
        const found = decision?.kind === "carry" ? policyAloneOf(error, settingsNow(), requested) : null;
        if (found === null || aloneInstead === null) throw error;
        aloneInstead(found); attempt();
      }
      execution.relay.openCheck = null;
      if (bound !== undefined) {
        if (command !== null) execution.relay.turn = { kind: "command", declared: command.effect };
        else if (packet !== null) execution.relay.turn = { kind: "carry", runId: target, packetId: packet.manifest.id, range: packet.manifest.range, bodySha256: packet.manifest.body.sha256, reanchored: packet.manifest.reanchor, recorded: false,
          resent: decision?.kind === "carry" && decision.resend !== null, superseded: decision?.kind === "carry" && decision.resend !== null && pendingSync !== null ? { packetId: pendingSync.packetId, range: pendingSync.range } : null };
        else if (decision?.kind === "alone") execution.relay.turn = { kind: "alone" };
        else execution.relay.turn = { kind: "plain", contextThroughSeq: factsSeq, agentOutput: false, recorded: false };
      }
      this.continue(execution);
      // A native session this handoff opened is named before its first prompt (ADR-055 §8.1, VF3-12; its Driver's declaration says so):
      // once the Turn that carries the packet is committed — a Turn that goes alone after all names nothing — and before it is
      // dispatched, with a name that hides what the packet hid, the known secrets of every Harness of the conversation (G072 review I7).
      if (decision?.kind === "carry" && packet !== null && openedNew && declaration.capabilities?.title === "set" && control.setTitle !== undefined) {
        const result = await this.titleFor(control, native, prepared, packetSecrets); this.continue(execution);
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
      // A connection the relay read on that failed since is not handed the input (R2): the Turn ends as never dispatched, and, as
      // when a read left it failed (relayReadsSettled), its close's protocol failure is the relay's, never the binding's: nothing
      // was dispatched, so the binding is ready again (G068 fix batch 2, M-2).
      if (execution.relay.io.asked && control.healthy?.() === false) { execution.relay.io.broke = execution.relay.io.healthy !== false; throw notReached(); }
      // The consent a carrying Turn rests on, read once more right before dispatch (§6.1, RT2-18): one withdrawn since the Turn
      // was prepared stops its packet (RELAY_CONSENT_REQUIRED{revoked}) — and with it every key the Harness control is known by
      // when its vendor could not be read (openGates knownKeys). Nothing of the history is sent. What the policy settles it does
      // as it settles the same withdrawal at the open: the input goes as typed (G072 review m1); the user's own choice and the
      // strict design fail the Run, as before.
      if (execution.relay.consent !== null) {
        const asked = execution.relay.consent, view = this.consentView(this.owned(execution), this.relayPrefs(), {});
        // A consent the request gave stands until a withdrawal of its vendor is logged after it (in this conversation or for all).
        const withdrawn = asked.requestSeq !== null ? view.records.some(record => record.vendor === asked.vendor && record.logSeq > asked.requestSeq! && record.decision === "revoked"
          && (record.scope.kind === "global" || record.scope.sessionId === view.session)) : consentStanding(asked.vendor, asked.layer, view).kind === "missing";
        const revoked: VendorKey | null = withdrawn ? asked.vendor : asked.also.find(key => { const standing = consentStanding(key, null, view); return standing.kind === "missing" && standing.revoked; }) ?? null;
        if (revoked !== null) {
          const refusal = consentRequired("revoked", revoked, asked.target), found = policyAloneOf(refusal, settingsNow(), requested);
          const carried = execution.relay.turn;
          if (found === null || carried.kind !== "carry" || packet === null) throw refusal;
          execution.relay.consent = null; execution.relay.turn = { ...carried, kind: "withheld" }; turnText = run.input;
          const withheld = packet.manifest.id;
          this.commit(id, current => ({ next: updatedRun(current, target, { sourceRunIds: [], relay: runRelayOf(null, { kind: "native_resume" }, current.runs.find(row => row.id === target)?.relay?.executedOn ?? null) }),
            events: [event("relay.withheld", { runId: target, packetId: withheld, relay: { decision: { kind: "alone", by: "policy", cause: found.cause } } })] }));
        }
      }
      this.commit(id, current => ({ next: updatedRun(current, target, phase(current, target, "dispatchedAt", this.options.now().getTime())), events: [event("run.dispatched", { runId: target })] }));
      execution.dispatched = true;
      execution.run = await control.startText(native, turnText, value => this.output(execution, value), ...(files.length ? [files] : []));
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
        // A native session the Driver replaced (Claude's synthesized clear, ADR-055 §7.5) is archived as it is: its reference
        // after the Turn is not needed, so one the Driver no longer gives (it opened no session ahead, R4) fails nothing.
        const replacing = nativeCleared?.replaced != null;
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
      // after_turn's check at the settlement (ADR-055 §6.1, F12): a packet still unconfirmed, or a binding the command made
      // suspect, is looked for now, while the connection is open (≤2 s); the result is committed with run.ended.
      if (bound !== undefined && declaration.verify === "after_turn" && execution.relay.turn.kind !== "none") {
        const latest = this.owned(execution), relayNow = latest.nativeBindings?.find(row => row.harnessId === h && row.controlId === c && row.status !== "archived")?.relay;
        if (relayNow !== undefined) {
          const provisional = settleTurn({ relay: relayNow, runId: target, openCheck: null, turn: this.settledTurn(execution, latest), dispatched: true, status: backend.status, input: evidence ?? undefined, noop,
            cleared: clearReportOf(nativeCleared, declaration.probed, true), declaration, settledCheck: null, unknownTurn: false, endedSeq: latest.lastSeq + 1, time: now() });
          if (!provisional.replaced) {
            // Only a packet still pending or a binding in doubt is looked for; a synced or fresh one reads no row (F12, R8).
            const pendingOrSuspect = provisional.relay.sync.kind === "pending" || provisional.relay.sync.kind === "suspect";
            const plan = planReturnVerify(provisional.relay, { verify: "after_turn", moment: "settled", deliveries: pendingOrSuspect ? this.relayDeliveries(latest, bound) : [] });
            if (plan.kind !== "skip") {
              // The Turn has ended: a check that fails or breaks the connection changes nothing of its result (C6, R2). Its failure is
              // the relay's (io.broke), and a check given up on leaves the connection to be closed, never kept for the next Turn.
              // A binding whose reads an earlier read broke is not asked (M-3); an input sent alone is asked here, where it is harmless.
              const io = execution.relay.io, healthy = control.healthy?.(), abandoned = io.abandoned.length, unasked = this.unasked(execution, control, plan, false);
              execution.relay.settledCheck = { plan, result: await this.verifyFor(execution, control, native, plan, unasked), ...(unasked === undefined ? {} : { unasked }), moment: "settled" };
              if (healthy !== false && (control.healthy?.() === false || io.abandoned.length > abandoned)) io.broke = true;
              this.owned(execution);
            }
          }
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
      if (abandoned.length) this.commit(id, current => ({ next: current, events: abandoned.map(([permissionId]) => event("permission.closed", { permissionId, runId: target })) }));
      if (execution.stop) {
        try { await execution.stop; } catch (error) { problem ??= fault(error); }
      }
      if (execution.binding && execution.earlyClose === null) {
        try { await this.flushNative(execution); } catch (error) { problem ??= fault(error); }
      }
      // A finished Turn of a conversation that keeps its process hands the process over instead of closing it (ADR-030); not
      // one whose Driver replaced the native session it cleared (its conversation changed, ADR-055 §7.5), nor one a relay read
      // broke or left outstanding: an abandoned check would go on in the kept process and break into the next Turn (C6, R2).
      const io = execution.relay.io;
      const keep = execution.binding === null || opened === null || nativeCleared?.replaced != null || io.broke || io.abandoned.length > 0 ? { keep: false }
        : this.keepable(id, execution, backend, problem, checkpointStored && nativeConfirmed);
      if (execution.binding && !keep.keep) {
        // A close that throws leaves the cleanup unconfirmed (the Turn is unknown); the Turn keeps the failure it ended with (M-8).
        try { execution.earlyClose ??= execution.binding.close(); cleanup = await execution.earlyClose; }
        catch (error) { problem ??= fault(error); }
      }
      // What the program logged during this Turn, kept privately in memory for the user's diagnostics (redacted on the way out).
      if (execution.binding && execution.diagnosticMark !== null) this.keepDiagnostics(id, target, execution.binding.control.diagnosticsSince?.(execution.diagnosticMark) ?? "");
      let handed = false;
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
        // Read only for a replaced native session, the one end that may clear a relay recovery failure (M-5).
        const current = this.load(id), run = current.runs.find(run => run.id === target)!, failedOn = nativeCleared?.replaced != null ? this.recoveryFailureOn(current) : null;
        const unsafe = (execution.dispatched && backend === null) || (execution.binding !== null && cleanup === null && !keep.keep) || this.fatal !== null || this.unknownOwnership(problem);
        // A connection failure the relay's own read caused — a check at the open before anything was dispatched, or a settlement's
        // check after the Turn's result was in — is the relay's, never the Turn's (C6, R2): it counts in neither the Turn's failure
        // nor whether its native state is confirmed, and its end records it apart (`relay.checkFailure`).
        const checkFailure = io.broke && cleanup?.protocolFailure != null && (!execution.dispatched || backend !== null) ? cleanup.protocolFailure : null;
        const closed = checkFailure === null ? cleanup : { ...cleanup!, protocolFailure: null };
        // A Turn the Runtime stopped on its own (a budget ran out before it settled) is cancelled when it then settled, whatever
        // it reported, and unknown when it had to be ended.
        const stopped = execution.stopReason !== null;
        const failure = stopped ? { code: execution.stopReason!, message: execution.stopReason === "WAIT_EXPIRED" ? "the wait for the user's decision ran out" : "the Turn's execution budget ran out" }
          : problem ?? closed?.protocolFailure ?? backend?.error ?? null;
        const status = unsafe ? "unknown" : run.cancelRequested || problem?.code === "CANCELLED" || stopped ? "cancelled" : failure ? "failed" : backend?.status ?? "failed";
        // The binding is ready again when the Turn's native state is confirmed (ADR-028/030). After an unknown Turn of a process
        // Driver whose program the Hub saw end (its close confirmed), the user may continue the original session (D6, ADR-055
        // §9 S6): the binding is ready and suspect{unknown_turn}, and the next open checks where the Turn's input went.
        const confirmed = checkpointStored && checkpoint !== null && (keep.keep || closed?.closed === true && closed.protocolFailure === null) && (!execution.dispatched || nativeConfirmed && backend !== null);
        const continued = unsafe && checkpointStored && execution.dispatched && backend === null && cleanup?.closed === true && cleanup.protocolFailure === null && this.fatal === null && !this.unknownOwnership(problem)
          && execution.relay.declaration.execution === "process" && execution.relay.declaration.probed;
        // What the Driver reported of a clear, as the relay may take it (clearReportOf; ADR-055 B7, G072 review I2).
        const clearReport = clearReportOf(nativeCleared, execution.relay.declaration.probed, confirmed);
        // A command's effect counts only when it ran; it goes into the Turn's end event with what the driver knew of the input. A
        // clear its Driver confirmed is a clear, as the binding records it, whatever the Turn's status (R9e).
        const input: InputOutcome = !execution.dispatched ? "not_recorded" : evidence ?? "unknown";
        const effect = command === null ? null : clearReport !== null ? "clear" as const : commandEffect(command.effect, commandOutcome(execution.dispatched, backend?.status ?? null, input, noop));
        // Claude's synthesized clear (§7.5): the session the next Turn continues, or none (null) when it opens a new one (R4).
        const replaced = confirmed && nativeCleared?.replaced != null ? nativeCleared.replaced : null;
        const replacement = replaced !== null && typeof replaced.checkpoint === "string" && replaced.checkpoint !== "" && Buffer.byteLength(replaced.checkpoint) <= 8192 && !/[\0\r\n]/u.test(replaced.checkpoint)
          ? replaced.checkpoint : null;
        // What the end did with the relay, for a retry without it (R6).
        const tried = { relayed: false, replaced: false };
        const ended = (withRelay: boolean) => (current: SessionSnapshot): SessionMutation => {
          let next: SessionSnapshot = { ...updatedRun(current, target, { status, backend, cleanup: closed,
            error: failure, ...phase(current, target, "endedAt", endedAt), ...(keep.keep ? { retained: true as const } : {}) }), activeRunId: null, status: unsafe ? "blocked" : current.status,
            ...(keep.keep ? { retained: { harnessId: pinned.harnessId, controlId: pinned.controlId, runId: target, since: reusing?.since ?? endedAt, ...(identity === undefined ? {} : { process: identity }) } } : {}) };
          // A Turn that failed on the relay before it ran says so in its relay (§12.2: blocked, with the code).
          const latestRun = next.runs.find(row => row.id === target)!;
          if (latestRun.relay === undefined && failure !== null && (BLOCKED_CODES as readonly string[]).includes(failure.code))
            next = updatedRun(next, target, { relay: runRelayOf(null, { kind: "blocked", code: failure.code as typeof BLOCKED_CODES[number] }, null) });
          // The relay part of the end (ADR-055 §6.1, §7.2): the open's check if it was not committed, the Turn's own event, after_turn's
          // check and D6, on the binding's relay state as committed now; the delivery rows decided with it.
          const own = next.nativeBindings?.find(row => row.harnessId === pinned.harnessId && row.controlId === pinned.controlId && row.status !== "archived");
          const settled = withRelay && checkpointStored && own?.relay !== undefined ? settleTurn({ relay: own.relay, runId: target, openCheck: execution.relay.openCheck, turn: this.settledTurn(execution, next),
            dispatched: execution.dispatched, status: backend?.status ?? null, input: evidence ?? undefined, noop, cleared: clearReport,
            declaration: execution.relay.declaration, settledCheck: execution.relay.settledCheck, unknownTurn: continued, endedSeq: current.lastSeq + 1, time: endedAt }) : null;
          // G072: the binding keeps what the Turn taught the next admission — the vendor its Driver observed (a Turn refused for its
          // consent included) and the context its usage reported (the window's first source, the return's warmth); a replaced
          // native session starts with neither.
          const relayed = settled === null || settled.replaced ? settled : { ...settled, relay: this.relayAfterTurn(settled.relay, execution, latestRun) };
          if (withRelay) { tried.relayed = relayed !== null; tried.replaced = relayed?.replaced === true; }
          if (checkpointStored && checkpoint !== null && (confirmed || continued)) {
            next = { ...next, nativeBindings: next.nativeBindings?.map(binding => {
              if (binding.harnessId !== pinned.harnessId || binding.controlId !== pinned.controlId || binding.status === "archived") return binding;
              // An unknown Turn continued keeps the reference it resumed from; its native position stays where it was.
              if (!confirmed) return { ...binding, status: "ready" as const, ...(relayed === null ? {} : { relay: relayed.relay }) };
              // A replaced native session (§7.5) is archived as it was, its relay state frozen; the Turn ran in it.
              if (relayed?.replaced) return { ...binding, status: "archived" as const, throughRunId: execution.dispatched ? run.id : binding.throughRunId };
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
            // Claude's synthesized clear (§7.5): the new binding of the same Harness control starts the next epoch at the clear's
            // floor and inherits what the native session was last seen running. A relay recovery failure is cleared only when it
            // names this Harness control (a Turn's end committed without its relay part, R6): the binding it named is replaced; one
            // a recovery left names no binding, and only the user's native reset clears it (§9 S15; G068 fix batch 2, M-5).
            // Without a session to continue (`replaced.checkpoint` null, R4) the next Turn opens a new one (opensNew), and the
            // binding names the abandoned session it replaces, which is never resumed.
            if (relayed?.replaced) {
              const latest = reported ? observed : own?.observed, { relayRecoveryFailed, ...rest } = next;
              const named = failedOn !== null && failedOn.harnessId === pinned.harnessId && failedOn.controlId === pinned.controlId;
              next = { ...(named ? rest : next), nativeBindings: [...next.nativeBindings!, { harnessId: pinned.harnessId, controlId: pinned.controlId, checkpoint: replacement ?? own!.checkpoint, throughRunId: null, status: "ready" as const,
                ...(latest === undefined ? {} : { observed: latest }), relay: relayed.relay, ...(replacement === null ? { opensNew: true as const } : {}) }] };
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
          // Without its relay part (R6) the end marks the conversation: a Turn that would carry relay content is refused
          // (RELAY_UNAVAILABLE{recovery_failed}) until a new native session, as after a relay recovery that could not be written.
          if (!withRelay && next.relayRecoveryFailed === undefined) next = { ...next, relayRecoveryFailed: current.lastSeq + 1 };
          const relayNote = { ...(relayReason === null ? {} : { reason: relayReason }), ...(checkFailure === null ? {} : { checkFailure }), ...(withRelay ? {} : { failed: true }) };
          return { next, events: [event("run.ended", { runId: target, status, backend, cleanup: closed, error: failure, input, ...(effect === null ? {} : { contextEffect: effect }),
              ...(nativeCleared === undefined ? {} : { native: nativeCleared }), ...(relayed?.delivery == null ? {} : { delivery: relayed.delivery }), ...(relayed === null ? {} : { binding: relayed.binding }),
              ...(relayed?.shown == null ? {} : { shown: relayed.shown }), ...(Object.keys(relayNote).length === 0 ? {} : { relay: relayNote }), ...(continued ? { continued: true } : {}) }),
            ...(relayed?.events ?? []), ...(withRelay ? execution.relay.endEvents : []),
            ...(keep.keep ? [event("native.process_retained", { runId: target, idleEndsAt: endedAt + idleMs })] : keep.skipped ? [event("native.retention_skipped", { runId: target, reason: keep.skipped })] : []),
            ...(cancelSwitch ? [event("switch.failed", { switchId: current.pendingSwitchId, reason: "cancelled by close" })] : []),
            ...(stranded === null ? [] : [event("switch.failed", { switchId: stranded, error: STRANDED_SWITCH, reason: "the Turn it waited for ended without confirmed settlement" }),
              ...waiting.map(queuedId => event("run.ended", { runId: queuedId, status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE" }, neverDispatched: true }))]),
            ...(unsafe ? [event("session.blocked", { runId: target, reason: "execution or cleanup could not be safely confirmed" })] : [])],
            ...(relayed !== null && relayed.deliveries.length ? { relay: { deliveries: relayed.deliveries } } : {}) };
        };
        try { this.commit(id, ended(true), true); this.recordWindow(execution, id, target, pinned, openedNew); }
        catch (error) {
          // The Store refused the relay part of the end (its rows, the binding's relay state): the public facts are committed
          // without it, once, and the conversation is marked (R6). A replaced native session is not split from its relay state;
          // a Store that failed, or anything else, fails the Runtime as before.
          if (!tried.relayed || tried.replaced || !this.relayRefusal(error)) throw error;
          this.commit(id, ended(false));
        }
        handed = keep.keep;
      } catch (error) { this.fail(error); }
      if (keep.keep && !handed) {
        // The hand-over was not recorded, so the process is not kept: it is closed like any other Turn's.
        const unrecorded = this.kept.get(id);
        if (unrecorded !== undefined) { this.kept.delete(id); clearTimeout(unrecorded.timer); }
        if (execution.binding !== null) try { await execution.binding.close(); } catch (error) { this.fail(error, id); }
      }
      if (this.actives.get(id) === execution) this.actives.delete(id);
      this.acceptedRelay.delete(target);
      if (execution.budget.timer !== null) clearTimeout(execution.budget.timer);
      if (execution.grace !== null) clearTimeout(execution.grace);
      this.discardStream(execution);
    }
  }
  /** What a Turn was authorized to send, as its settlement reads it now (a Turn without a packet: whether the agent answered). */
  private settledTurn(execution: ActiveExecution, state: SessionSnapshot): SettledTurn {
    const turn = execution.relay.turn;
    if (turn.kind === "carry") return { ...turn, recorded: execution.relay.recorded };
    if (turn.kind !== "plain") return turn;
    const run = state.runs.find(row => row.id === execution.runId), reply = run === undefined ? undefined : state.messages.find(message => message.id === run.assistantMessageId);
    return { ...turn, recorded: execution.relay.recorded, agentOutput: (reply?.text ?? "") !== "" || (run?.thinking ?? "") !== "" || (run?.tools?.length ?? 0) > 0 };
  }
  /**
   * Starts the Turn's program (its binding), with the installation it resolved; another conversation's kept process holding the
   * workspace is the user's to end (ADR-030, option C).
   */
  private async startProgram(execution: ActiveExecution, run: PublicRun, current: SessionSnapshot, id: SessionId, target: PublicRun["id"]): Promise<void> {
    try { execution.binding = await this.factory.prepare(run.selection, current.configuration, id, target); execution.diagnosticMark = execution.binding.control.diagnosticMark?.() ?? null; }
    catch (error) {
      if (error instanceof SessionError && error.code === "WORKSPACE_BUSY" && [...this.kept].some(([holder, kept]) => holder !== id && kept.binding.workspace === current.configuration.workspace))
        throw new SessionError("WORKSPACE_KEPT", "another conversation keeps a native process in this workspace");
      throw error;
    }
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
  private async restartProgram(execution: ActiveExecution, run: PublicRun, current: SessionSnapshot, id: SessionId, target: PublicRun["id"], refusal: unknown): Promise<{ readonly control: HarnessControl; readonly closed: CleanupEvidence }> {
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
  private recoveryFailureOn(state: SessionSnapshot): { readonly harnessId: string; readonly controlId: string } | null {
    const seq = state.relayRecoveryFailed;
    if (seq === undefined) return null;
    const recorded = this.store.events(state.id, seq - 1, 1)[0];
    if (recorded === undefined || recorded.seq !== seq || recorded.type !== "run.ended" || (recorded.data.relay as { readonly failed?: unknown } | undefined)?.failed !== true) return null;
    const run = state.runs.find(row => row.id === recorded.data.runId);
    return run === undefined || run.selection.provider !== undefined ? null : { harnessId: run.selection.harnessId, controlId: run.selection.controlId };
  }
  /**
   * The Run that carried a pending packet (ADR-055's stage-two seam, for its resend's `resend.of`): its delivery row's Run,
   * else the latest Run whose relay names the packet; null when neither does (a resend then needs the user's choice).
   */
  private pendingRunOf(state: SessionSnapshot, rows: readonly BindingDelivery[], packetId: RelayPacket["id"]): PublicRun["id"] | null {
    const row = rows.findLast(item => item.record.packetId === packetId);
    if (row !== undefined) return row.record.runId;
    return state.runs.findLast(run => run.relay?.packetId === packetId)?.id ?? null;
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
      const sources = current.runs.filter(run => terminal(run.status) && current.messages.some(message => message.id === run.userMessageId && message.seq < pending.requestedSeq)).map(run => run.id);
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
      await binding.control.open(binding.workspace, target.nativeModel, target.nativeOptions); this.store.assertOwner(); binding.assertOwned();
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
    this.commit(id, state => ({ next: { ...state, pendingSwitchId: null, selection: target, epoch: state.epoch + 1, ...(recovery ? { status: "open" as const } : {}),
      switches: state.switches.map(sw => sw.id === targetId ? { ...sw, status: "effective", throughSeq: state.lastSeq } : sw) },
      events: [event("switch.effective", { switchId: targetId, target, epoch: state.epoch + 1, throughSeq: state.lastSeq,
        sourceRunIds: state.switches.find(sw => sw.id === targetId)!.sourceRunIds, cleanup, continuity: "public_context_rehydrate", ...(recovery ? { recovered: true } : {}) })] }));
  }
  /**
   * G072's checks at the open for a Turn that carries a packet (ADR-055 §6.1 finalize, §9 "open 之后"): the probe gate on the
   * open Driver's own declaration (a setting: `relay.allowUnprobed`); the vendor key it observed after the open (relayVendor), else
   * the binding's cached one, against the data root (cross-vendor; `relay.dataRootInWorkspace` "block" refuses, "warn" goes on) and
   * the consent. A key that differs from what the epoch's first packet went to is vendor_changed, recorded as relay.vendor_changed:
   * it fails the Turn in the strict design, and goes on with the change recorded when `relay.crossVendor` allows (permissive-defaults
   * §2.4); a vendor nothing is recorded for is allowed by default and traced (the row is written before the Turn is committed,
   * `trace`); one the user withdrew fails (revoked) for the caller to settle. Then the refined window and the hard cap
   * (RELAY_INPUT_LIMIT{min_packet}); and the budget the packet is folded to. The consent a cross-vendor dispatch rests on is kept
   * for the read right before dispatch.
   */
  private openGates(state: SessionSnapshot, run: PublicRun, bound: NativeSessionBinding | undefined, relay: BindingRelayState, decision: Extract<TurnDecision, { kind: "carry" }>,
      declaration: RelayDeclaration, choices: RelayChoices, kinds: readonly ContentKind[]): OpenGate {
    const target = run.selection, h = target.harnessId, c = target.controlId, prefs = this.relayPrefs(), settings = relaySettings(prefs), execution = this.actives.get(state.id)!;
    // Another Harness's history only (Carrying.crossHarness): a target's own history coming back meets the epoch's vendor key alone.
    const crossHarness = crossHarnessFacts(state, decision.need.facts, decision.need.origin, target);
    if (crossHarness) probeGate(declaration, settings.allowUnprobed, target);
    const cached = bound?.relay?.vendorObserved ?? relay.vendorObserved ?? this.lineageVendor(state, target), observed = execution.relay.observed === undefined ? cached : execution.relay.observed;
    const predicted = vendorKeyOf(declaration.capabilities, h, cached), vendor = vendorKeyOf(declaration.capabilities, h, observed), layer = observed?.endpoint?.layer ?? null;
    const sources = sourceVendors(state, decision.need.facts, decision.need.origin, selection => this.declarationOf(selection) ?? (selection.harnessId === h && selection.controlId === c ? declaration.capabilities : undefined));
    const cross = crossHarness && crossVendor(vendor, sources), exposed = cross && !this.isolated(state.configuration.workspace, settings.dataRootInWorkspace === "block");
    if (exposed && settings.dataRootInWorkspace === "block") throw dataRootInWorkspace(target);
    const view = this.consentView(state, prefs, this.withRecordedConsent(state, run, choices));
    // A Driver that was asked and could not tell (a read that failed, came late or answered nothing) has not changed its vendor: it is
    // unseen, not another. Its packet is recorded for the honest unknown:<harness>, no change of vendor is made of it, and every key the
    // relay knew it by — the epoch's consent key, what the binding last saw, what its lineage last saw — still holds the user's
    // withdrawal: the history does not go to a vendor the user withdrew because a read failed (INV-33, G072 review I1).
    const unseen = execution.relay.observed === null, also = unseen ? this.knownKeys(state, target, bound, relay, declaration, vendor) : [];
    if (cross) for (const key of also) { const standing = consentStanding(key, null, view); if (standing.kind === "missing" && standing.revoked) throw consentRequired("revoked", key, target); }
    let outcome: ReturnType<typeof consentGate>;
    try { outcome = consentGate({ relay: unseen ? { ...relay, consentKey: null } : relay, vendor, layer, cross, consent: view, target, predicted }); }
    catch (error) {
      if (error instanceof RelayError && error.reason === "vendor_changed")
        execution.relay.endEvents.push(event("relay.vendor_changed", { harnessId: h, controlId: c, from: relay.consentKey ?? predicted, to: vendor, observedInRun: run.id }));
      throw error;
    }
    const standing = outcome.standing;
    // The consent a request gave was recorded at its acceptance: the delivery row names that record.
    const recorded = standing?.kind === "given" && standing.via === "request" ? this.relayLog()?.relayConsents?.().filter(record => record.commandId === consentCommandOf(state.id, run.commandId)).at(-1)?.logSeq ?? null : null;
    const consentLogSeq = standing?.kind === "given" ? standing.logSeq ?? recorded : null;
    execution.relay.consent = cross ? { vendor, layer, target, also, requestSeq: standing?.kind === "given" && standing.via === "request" ? recorded : null } : null;
    const window = resolveWindow({ relay, report: declaration.capabilities?.window ?? "none", stored: this.relayWindowOf(h, c, observed?.modelKey ?? ""), vendor, fixedPrefix: declaration.capabilities?.fixedPrefix ?? null, now: this.options.now().getTime() });
    const limit = declaration.capabilities?.placement.maxInput ?? null, size = declaration.capabilities?.placement.measure(run.input, kinds) ?? [...run.input].length;
    const cap = hardCap(window, estimateTokens(run.input), limit, size);
    if (crossHarness && !fitsMinPacket(cap, packetFamily(vendor, observed?.modelKey ?? ""))) throw inputLimit("min_packet", target);
    const budget = packetBudget(window, cap), standard = packetBudget(window, Number.POSITIVE_INFINITY);
    const clamped: ("window" | "input_limit")[] = [];
    if (budget.cap < standard.cap) clamped.push(limit !== null && hardCap(window, estimateTokens(run.input), null, size) >= standard.cap ? "input_limit" : "window");
    // A return (§7.3): the binding stood on a mark of its own native session; what the request chose of it, and the pref's default.
    const returning = markOf(relay.sync) === null ? null : returnChoice({ warm: cacheWarm(relay.cache, declaration.capabilities?.cacheTtl ?? "unknown", observed?.authKind ?? null, this.options.now().getTime()), sideBySide: false },
      settings.returnPreference, choices.native).choice;
    // A row the default wrote that no delivery names yet is still the vendor's first use.
    const viaRow = standing?.kind === "given" && standing.logSeq !== null ? view.records.find(record => record.logSeq === standing.logSeq) : undefined;
    const first = standing?.kind === "given" && (standing.via === "default" || viaRow !== undefined && consentSourceOf(viaRow) === "default" && this.relayLog()?.consentUsed?.(viaRow.logSeq) === false);
    return { vendor, unseen, window, budget, clamped, consentLogSeq, returning, layer, first,
      trace: standing?.kind === "given" && standing.via === "default" ? { vendor, authKind: observed?.authKind ?? null } : null, changedFrom: outcome.changedFrom,
      consentVia: standing === null ? null : standing.kind === "given" ? standing.via : "exempt", exposed };
  }
  /**
   * The vendor keys a Harness control is known by besides the one a failed read leaves (unknown:<harness>): the epoch's consent
   * key and the vendors its binding and its lineage last saw it run on. A withdrawal of any of them stands for a read that told nothing.
   */
  private knownKeys(state: SessionSnapshot, target: HarnessSelection, bound: NativeSessionBinding | undefined, relay: BindingRelayState, declaration: RelayDeclaration, except: VendorKey): readonly VendorKey[] {
    const keys = new Set<VendorKey>();
    for (const observation of [bound?.relay?.vendorObserved, relay.vendorObserved, this.lineageVendor(state, target)]) if (observation != null) keys.add(vendorKeyOf(declaration.capabilities, target.harnessId, observation));
    if (relay.consentKey !== null) keys.add(relay.consentKey);
    keys.delete(except);
    return [...keys];
  }
  /**
   * The open's check committed on its own (a transaction of its own, as the main one would have): its `relay.verified`, the
   * delivery rows it decided and the binding's relay state it moved — only when the binding was not suspect before it and the
   * check made it so; otherwise it stays for the main transaction. Afterwards the Turn has no open check left to commit.
   */
  private commitCheckApart(id: SessionId, h: string, c: string, run: PublicRun["id"], execution: ActiveExecution): void {
    const check = execution.relay.openCheck, now = this.options.now().getTime();
    if (check === null) return;
    const ownOf = (state: SessionSnapshot) => state.nativeBindings?.find(row => row.harnessId === h && row.controlId === c && row.status !== "archived");
    const settle = (state: SessionSnapshot) => {
      const own = ownOf(state);
      if (own?.relay === undefined || own.relay.sync.kind === "suspect") return null;
      const outcome = checkStep(own.relay, check, run, { seq: state.lastSeq + 1, time: now });
      return outcome.relay.sync.kind === "suspect" ? { own, outcome } : null;
    };
    if (settle(this.load(id)) === null) return;
    this.commit(id, latest => {
      const found = settle(latest);
      if (found === null) throw new RelayError({ code: "RELAY_PREPARE_FAILED", reason: "render_mismatch" }, "没能准备交接单：准备期间绑定的接力状态变了，这条消息没有发出。");
      const { own, outcome } = found, rows = outcomeWrites(outcome.deliveries);
      return { next: { ...latest, nativeBindings: latest.nativeBindings?.map(row => row === own ? { ...row, relay: outcome.relay } : row) ?? [] }, events: [verifiedEvent(check, outcome, run)],
        ...(rows.length ? { relay: { deliveries: rows } } : {}) };
    });
    execution.relay.openCheck = null;
  }
  /**
   * The row of the installation's consent log a vendor's first use writes while the preference allows it by default
   * (permissive-defaults §2.4): the trace of what left, written before the Turn that sends it is committed. A log this Gateway
   * cannot write leaves nothing to trace the history by, so the packet is not sent (RELAY_UNAVAILABLE{consent_log_full}, which the
   * policy settles by sending the input alone). A vendor the user withdrew in the meantime (the row of the same first use was
   * written by another Turn a moment ago, under a time of its own) is not allowed again: revoked.
   */
  private traceDefaultAllow(trace: NonNullable<OpenGate["trace"]>, target: HarnessSelection, session: SessionId): number {
    const log = this.relayLog();
    if (log?.appendRelayLog === undefined) throw new RelayError({ code: "RELAY_UNAVAILABLE", reason: "consent_log_full" }, "这个 Gateway 没有可写的同意记录，记不下这次交接，所以没有附上交接单。");
    const append = defaultAllowAppend(trace.vendor, trace.authKind, this.options.now().getTime());
    try { return log.appendRelayLog(append).logSeq; }
    catch (error) {
      if (!(error instanceof SessionError && error.code === "IDEMPOTENCY_CONFLICT")) throw error;
      const records = log.relayConsents?.() ?? [], own = records.find(record => record.commandId === append.commandId);
      const view: ConsentView = { session, records, crossVendor: "allow", localModelsOffline: false, request: null };
      if (consentStanding(trace.vendor, null, view).kind === "missing" || own === undefined) throw consentRequired("revoked", trace.vendor, target);
      return own.logSeq;
    }
  }
  /**
   * A binding's relay state after its Turn (G072): the vendor its Driver observed after the open (when asked), and the cache of
   * the context its usage reported (windows.ts cacheAfter; a Turn that reported no usage leaves it as it was).
   */
  private relayAfterTurn(relay: BindingRelayState, execution: ActiveExecution, run: PublicRun): BindingRelayState {
    let next = execution.relay.observed == null ? relay : { ...relay, vendorObserved: execution.relay.observed };
    if (run.usage !== undefined && execution.dispatched) next = { ...next, cache: cacheAfter(next.cache, run.usage, run.timing?.dispatchedAt ?? null) };
    return next;
  }
  /**
   * The window a Turn's usage reported, kept for its Harness control and model for later Sessions (relay_windows, the window's
   * second source, §6.2); best-effort after the end is committed: a Store that refuses it changes nothing of the Turn.
   */
  private recordWindow(execution: ActiveExecution, id: SessionId, target: PublicRun["id"], selection: HarnessSelection, firstTurn: boolean): void {
    if (selection.provider !== undefined || !execution.dispatched || execution.relay.declaration.capabilities?.window === "none") return;
    const log = this.relayLog();
    if (log?.upsertWindow === undefined) return;
    try {
      const run = this.load(id).runs.find(row => row.id === target), modelKey = execution.relay.observed?.modelKey ?? "";
      const row = windowRow(selection.harnessId, selection.controlId, modelKey, run?.usage, firstTurn, this.options.now().getTime());
      if (row !== null) log.upsertWindow(row);
    } catch { /* a window is a hint for budgets; it never fails a Turn */ }
  }
  /**
   * The native title of a session a handoff opened (ADR-055 §8.1, VF3-12), set before its first prompt within RELAY_READ_MS:
   * the conversation's public title (its first words), "新对话" when it holds anything the relay would redact (§10.2's egress
   * scan); `set`, `refused` (the Driver said no) or `unavailable` (late, or failed). Its failure never fails the Turn.
   */
  private async titleFor(control: HarnessControl, native: NativeConversationId, state: SessionSnapshot, secrets: readonly string[]): Promise<"set" | "refused" | "unavailable"> {
    const first = state.messages.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim().slice(0, 80) ?? "";
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
   * The Driver's vendor observation after the open (ADR-055 §10.4), bounded like a relay read (RELAY_READ_MS) but on no
   * connection of the relay's: what it cannot tell, fails or is late with is null (unknown:<harnessId>, never a guess).
   */
  private async observeVendor(control: HarnessControl): Promise<VendorObservation | null> {
    const read = control.relayVendor?.bind(control);
    if (read === undefined) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = read().catch(() => null);
      const value = await Promise.race([answer, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), RELAY_READ_MS); timer.unref?.(); })]);
      return value === null || value === undefined ? null : parseVendorObservation(value);
    } catch { return null; } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  /**
   * The known secrets of the Harnesses a packet carries, from the factory (M1). Its refusals pass on as they are (it names
   * a configuration it could not read with RELAY_PREPARE_FAILED; ownership and cancellation keep their codes); any other
   * failure is the relay's too (N3), never the target Harness's: the Turn fails undispatched and what it owes stays owed.
   */
  private async relaySecretsOf(state: SessionSnapshot, run: PublicRun, sources: readonly PublicRun["id"][], origin: boolean): Promise<readonly string[]> {
    if (this.factory.relaySecrets === undefined) return [];
    try { return await this.factory.relaySecrets(state.configuration, this.relayHarnesses(state, run, sources, origin)); }
    catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError("RELAY_PREPARE_FAILED", "没能准备交接单：读取交接单必须隐去的凭据时出错，这条消息没有发出。修好后再发；也可以只发这条消息，不带交接单。");
    }
  }
  /**
   * The Harnesses whose history a packet carries (ADR-055 §10.2, review M1): the owed Runs' and, when the Session's own
   * starting history is owed, its messages' (an import's Harness included), with the target's own.
   */
  private relayHarnesses(state: SessionSnapshot, run: PublicRun, sources: readonly PublicRun["id"][], origin: boolean): readonly string[] {
    const ids = new Set<string>([run.selection.harnessId]);
    for (const source of state.runs) if (sources.includes(source.id)) ids.add(source.selection.harnessId);
    if (origin && state.origin !== undefined) {
      if (state.origin.kind === "import") ids.add(state.origin.harnessId);
      for (const message of state.origin.history) if (message.harnessId !== undefined) ids.add(message.harnessId);
    }
    return [...ids].sort();
  }
  /**
   * What the relay packet may quote of the owed Runs' stored tool details (ADR-055 §6.4), read back within bounds: the
   * commands, changes, reads and searches of the first owed Run and the 12 latest, ≤32 a Run, ≤128 in all, each ≤256 KiB.
   * A detail that cannot be read (no store that reads back, gone, changed, not JSON) is left out: the packet then lists
   * that tool by its title and its ledger says how many were not read.
   */
  private async relayDetails(state: SessionSnapshot, sources: readonly PublicRun["id"][]): Promise<ReadonlyMap<string, RelayToolDetail>> {
    const content = this.options.content, details = new Map<string, RelayToolDetail>();
    if (content?.readText === undefined) return details;
    const runs = sources.flatMap(id => state.runs.filter(run => run.id === id));
    let left = 128;
    for (const run of [...new Set([...runs.slice(0, 1), ...runs.slice(-12)])]) {
      let taken = 0;
      for (const tool of run.tools ?? []) {
        if (left === 0 || taken === 32) break;
        if (tool.detail === undefined || tool.parentId !== undefined || !["execute", "edit", "delete", "move", "read", "search"].includes(tool.kind ?? "")) continue;
        taken++; left--;
        const text = await content.readText(tool.detail, 256 * 1024);
        if (text === null) continue;
        let value: unknown;
        try { value = JSON.parse(text); } catch { continue; }
        const detail = parseToolDetail(value);
        if (detail !== null) details.set(run.id + "/" + tool.id, detail);
      }
    }
    return details;
  }
  /** The relay reads of a Store that keeps relay rows (SqliteSessionStore); none for one that keeps none. */
  private relayReads(): Pick<RelayStorePort, "relayDeliveries" | "relayPackets" | "relayIndex"> | null {
    const store = this.store as Partial<RelayStorePort>;
    return typeof store.relayDeliveries === "function" && typeof store.relayPackets === "function" && typeof store.relayIndex === "function" ? store as RelayStorePort : null;
  }
  /** The conversation's public facts foreign to a binding (ADR-055 §2), with their fact seqs and where they ran. */
  private relayFacts(state: SessionSnapshot, binding: { readonly harnessId: string; readonly controlId: string; readonly nativeEpoch: number }): readonly RelayFact[] {
    let index: readonly RelayIndexRow[] = [];
    // The migration's index rows place a v12 Run (where it ran); a Session without migrated Runs needs none of them.
    if (state.runs.some(run => run.relay === undefined && terminal(run.status) && dispatched(run))) {
      try { index = this.relayReads()?.relayIndex(state.id) ?? []; } catch (error) { if (!(error instanceof SessionError) || error.code !== "INVALID_DATA") throw error; }
    }
    return this.ledger.facts(state, index, binding);
  }
  /** One binding's delivery rows as a check reads them, with the marks their recordings made (relay-coordinator). */
  private relayDeliveries(state: SessionSnapshot, binding: NativeSessionBinding): readonly BindingDelivery[] {
    const reads = this.relayReads();
    if (reads === null) return [];
    const rows = reads.relayDeliveries(state.id), packets: readonly RelayPacket[] = rows.length ? reads.relayPackets(state.id) : [];
    return bindingDeliveries(state, binding, rows, packets, (seq, run) => seq > state.lastSeq ? null : markIn(this.store.events(state.id, seq - 1, 1)[0], run));
  }
  /**
   * The relay choices this input was accepted with, as its acceptance event records them; none without a record. Those this
   * owner accepted it kept (acceptedRelay), so it reads the event only for an input an earlier owner accepted.
   */
  private choicesOf(state: SessionSnapshot, run: PublicRun): RelayChoices {
    const kept = this.acceptedRelay.get(run.id);
    if (kept !== undefined) return kept;
    const message = state.messages.find(row => row.id === run.userMessageId);
    const accepted = message === undefined ? undefined : this.store.events(state.id, message.seq - 1, 1)[0];
    return accepted?.type === "message.accepted" && accepted.data.runId === run.id ? acceptedChoices(accepted.data) : {};
  }
  /**
   * Whether the open needs a binding's delivery rows (R8): one that waits for a packet or is in doubt (its check, the packet a
   * resend supersedes, the epoch's first packet a retreat needs), or one synced on a packet that a Driver checking at the open
   * looks for; a fresh binding, one synced on its own Turns, or a synced one no check at the open looks at, reads none.
   */
  private rowsMatter(relay: BindingRelayState, verify: RelayDeclaration["verify"]): boolean {
    const sync = relay.sync;
    return sync.kind === "pending" || sync.kind === "suspect" || sync.kind === "synced" && sync.mark.lastPacketId !== null && verify === "on_next_open";
  }
  /**
   * A check's answer from the Driver (ADR-055 §7.3): nothing to ask for a skipped plan; every marker unavailable when the
   * Driver cannot check, fails, answers nothing or takes more than RELAY_READ_MS; otherwise its answer, checked marker by marker.
   */
  private async verifyFor(execution: ActiveExecution, control: HarnessControl, native: NativeConversationId, plan: Check["plan"], unasked?: Check["unasked"]): Promise<VerifyResult> {
    const request = verifyRequestOf(plan), verify = control.verifyDelivered?.bind(control);
    if (request === null || verify === undefined || unasked !== undefined) return unavailableResult(request);
    const raw = await this.relayRead<unknown>(execution, control, () => verify(native, request), null);
    return raw === null || raw === undefined ? unavailableResult(request) : checkedResult(raw, request);
  }
  /**
   * Why a check would not ask its Driver (G068 fix batch 2, M-3): `connection` on a binding an earlier read of this process broke
   * the connection of; `alone` at the open of an input sent alone; undefined when it asks — or when the plan asks nothing anyway.
   */
  private unasked(execution: ActiveExecution, control: HarnessControl, plan: Check["plan"], alone: boolean): Check["unasked"] {
    if (verifyRequestOf(plan) === null || control.verifyDelivered === undefined) return undefined;
    return this.readsOff(execution) ? "connection" : alone ? "alone" : undefined;
  }
  /** Whether the Turn's reads are off: a read of an earlier Turn of this process broke its binding's connection (M-3). */
  private readsOff(execution: ActiveExecution): boolean { return execution.relay.key !== null && this.brokenReads.has(execution.relay.key); }
  /** The key `brokenReads` keeps a conversation's Harness control by. */
  private readsKey(id: SessionId, selection: HarnessSelection): string { return id + "\0" + selection.harnessId + "\0" + selection.controlId; }
  /** A relay read of this Turn broke its connection, or was given up on: the binding's later Turns ask nothing more (M-3). */
  private readsBroke(execution: ActiveExecution): void {
    const key = execution.relay.key;
    if (key === null) return;
    this.brokenReads.add(key);
    if (this.brokenReads.size > 4096) this.brokenReads.delete(this.brokenReads.values().next().value!);
  }
  /** Where the native history stands before dispatch (ADR-055 F20); none when the Driver records none, cannot read it or is late. */
  private async positionOf(execution: ActiveExecution, control: HarnessControl, native: NativeConversationId): Promise<DeliveryPosition> {
    const read = control.deliveryPosition?.bind(control);
    if (read === undefined || this.readsOff(execution)) return { kind: "none" };
    return await this.relayRead<DeliveryPosition>(execution, control, () => read(native), { kind: "none" });
  }
  /**
   * One relay read on the Turn's connection (C6, R2): its answer, or `fallback` when it fails or takes more than RELAY_READ_MS.
   * A read given up on stays in `io.abandoned` until it ends, so that the connection is not kept and no input is dispatched
   * on it meanwhile; the connection's health before the Turn's first relay read is kept, to tell what a read broke. A read given
   * up on, or one that leaves failed a connection that was not failed before it, turns the binding's reads off (M-3).
   */
  private async relayRead<T>(execution: ActiveExecution, control: HarnessControl, read: () => Promise<T>, fallback: T): Promise<T> {
    const io = execution.relay.io;
    if (!io.asked) { io.asked = true; io.healthy = control.healthy?.(); }
    const before = control.healthy?.(), broke = () => { if (before !== false && control.healthy?.() === false) this.readsBroke(execution); };
    let answer: Promise<T>, timer: ReturnType<typeof setTimeout> | undefined;
    try { answer = read(); } catch (error) { answer = Promise.reject(error); }
    const ended = answer.then(() => {}, () => {});
    try {
      const raced = await Promise.race([answer.then(value => ({ value })), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), RELAY_READ_MS); timer.unref?.(); })]);
      if (raced !== null) { broke(); return raced.value; }
      io.abandoned.push(ended); this.readsBroke(execution);
      void ended.then(() => { const index = io.abandoned.indexOf(ended); if (index >= 0 && !io.broke) io.abandoned.splice(index, 1); });
      return fallback;
    } catch { broke(); return fallback; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  /**
   * Before anything is dispatched after the open's relay reads (R2): a read still outstanding is waited for as long again; one
   * that does not end by then, or a connection the reads left failed although it was not before them, fails the Turn as never
   * dispatched (its failure is the relay's, io.broke); a connection that had failed already fails it too, as its own.
   */
  private async relayReadsSettled(execution: ActiveExecution, control: HarnessControl): Promise<void> {
    const io = execution.relay.io;
    if (!io.asked) return;
    if (io.abandoned.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = await Promise.race([Promise.all(io.abandoned).then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), RELAY_READ_MS); timer.unref?.(); })]);
      if (timer !== undefined) clearTimeout(timer);
      if (!done) { io.broke = io.healthy !== false; throw notReached(); }
      io.abandoned.length = 0;
    }
    if (control.healthy?.() === false) { io.broke = io.healthy !== false; throw notReached(); }
  }
  /** The pending switch fails as stranded, and each input waiting for it ends as not dispatched (SWITCH_NOT_EFFECTIVE). */
  private strandSwitch(state: SessionSnapshot, switchId: string, waiting: readonly PublicRun["id"][], endedAt: number): SessionSnapshot {
    let next: SessionSnapshot = { ...state, pendingSwitchId: null, switches: state.switches.map(sw => sw.id === switchId ? { ...sw, status: "failed" as const, error: STRANDED_SWITCH } : sw) };
    for (const queued of waiting) next = updatedRun(next, queued, { status: "failed", error: { code: "SWITCH_NOT_EFFECTIVE", message: "requested Harness switch failed; this input was not dispatched" }, ...phase(next, queued, "endedAt", endedAt) });
    return next;
  }
  private unknownOwnership(problem: ReturnType<typeof fault> | null): boolean {
    return problem !== null && ["OWNER_LOST", "OWNERSHIP_LOST", "WORKSPACE_OWNERSHIP_LOST", "BINDING_CLEANUP_FAILED", "CLEANUP_FAILED", "WORKSPACE_QUARANTINED"].includes(problem.code);
  }
}
