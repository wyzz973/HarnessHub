import type { ProviderTarget } from "./provider.js";
import type { BackendResult, CleanupEvidence, ControlEvent, HarnessControl, NativeOptions, NativePlanEntry, NativeUsage } from "./control.js";
import type { ContentPort, ContentRef } from "./content.js";

declare const sessionBrand: unique symbol;
declare const runBrand: unique symbol;
declare const messageBrand: unique symbol;
declare const switchBrand: unique symbol;
declare const commandBrand: unique symbol;
export type SessionId = string & { readonly [sessionBrand]: true };
export type RunId = string & { readonly [runBrand]: true };
export type MessageId = string & { readonly [messageBrand]: true };
export type SwitchId = string & { readonly [switchBrand]: true };
export type CommandId = string & { readonly [commandBrand]: true };
function identity(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp("^" + prefix + "-[a-zA-Z0-9-]{1,96}$", "u").test(value)) throw new SessionError("INVALID_INPUT", "invalid " + prefix + " identity");
  return value;
}
export function sessionId(value: unknown): SessionId { return identity(value, "session") as SessionId; }
export function runId(value: unknown): RunId { return identity(value, "run") as RunId; }
export function messageId(value: unknown): MessageId { return identity(value, "message") as MessageId; }
export function switchId(value: unknown): SwitchId { return identity(value, "switch") as SwitchId; }
export function commandId(value: unknown): CommandId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new SessionError("INVALID_INPUT", "invalid command identity");
  return value as CommandId;
}
export class SessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SessionError"; }
}
/** Native enum overrides only; unknown keys/values are rejected by the selected Driver before dispatch. */
export function parseNativeOptions(value: unknown): NativeOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_INPUT", "native options must be an object");
  const entries = Object.entries(value);
  if (entries.length > 64 || entries.some(([key, item]) => !/^[a-zA-Z0-9_-]{1,128}$/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || typeof item !== "string" || !item || item.length > 1024 || /[\0\r\n]/u.test(item))) throw new SessionError("INVALID_INPUT", "invalid native option identity or value");
  return Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export interface HarnessSelection { readonly harnessId: string; readonly controlId: string; readonly provider?: ProviderTarget; readonly nativeModel?: string; readonly nativeOptions?: NativeOptions }
export interface SelectionRequest { readonly harnessId: string; readonly controlId?: string; readonly provider?: ProviderTarget | null; readonly nativeModel?: string; readonly nativeOptions?: NativeOptions }
export interface SessionConfiguration {
  readonly workspace: string;
  readonly manifestPath: string | null;
  readonly manifestSha256: string | null;
  readonly configHome: string | null;
  readonly packageRoots: readonly string[];
  readonly searchDirs: readonly string[];
  readonly pathOnly: boolean;
}
export type RunStatus = "queued" | "preparing" | "running" | "settling" | "completed" | "cancelled" | "failed" | "unknown";
export interface PublicMessage {
  readonly id: MessageId;
  readonly runId: RunId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly seq: number;
  readonly status: RunStatus;
}
/** Public tool summary; the bounded native detail is a stored content reference (v7). */
export interface PublicTool {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind?: string;
  readonly name?: string;
  readonly parentId?: string;
  readonly exitCode?: number;
  readonly detail?: ContentRef;
}
export interface PublicPlan { readonly entries: readonly NativePlanEntry[]; readonly explanation?: string }
export interface PublicNotice { readonly severity: "info" | "warning" | "error"; readonly title: string; readonly detail?: string }
export interface PublicActivity { readonly id: string; readonly kind: "subagent" | "task" | "compaction" | "retry" | "review"; readonly title: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly detail?: string }
export type PublicOutput =
  | { readonly kind: "content"; readonly content: ContentRef }
  | { readonly kind: "link"; readonly uri: string; readonly name: string; readonly title?: string; readonly mediaType?: string };
/**
 * When a Run reached each phase, in epoch milliseconds from the Runtime's clock (Session v10). A phase the Run did not reach
 * is absent; the Harness never supplies these values.
 */
export interface RunTiming {
  /** The input was accepted and queued. */
  readonly acceptedAt: number;
  /** Preparation began: the original program is being started for this Run. */
  readonly preparingAt?: number;
  /** The program answered its handshake and its native session (new or restored) is open. */
  readonly readyAt?: number;
  /** The input was handed to the program. */
  readonly dispatchedAt?: number;
  /** The first visible native output arrived: reply text, thinking, a tool, a plan, an approval or question, an output or an activity. */
  readonly firstOutputAt?: number;
  /** The Run reached its final status. */
  readonly endedAt?: number;
}
export interface PublicRun {
  readonly id: RunId;
  readonly commandId: CommandId;
  readonly input: string;
  readonly userMessageId: MessageId;
  readonly assistantMessageId: MessageId;
  readonly selection: HarnessSelection;
  readonly epoch: number;
  readonly status: RunStatus;
  readonly cancelRequested: boolean;
  readonly contextThroughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly backend: BackendResult | null;
  readonly cleanup: CleanupEvidence | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly thinking?: string;
  readonly tools?: readonly PublicTool[];
  readonly plan?: PublicPlan;
  readonly usage?: NativeUsage;
  readonly notices?: readonly PublicNotice[];
  readonly activities?: readonly PublicActivity[];
  readonly outputs?: readonly PublicOutput[];
  /** User attachments admitted with this input; the bytes stay in the content store. */
  readonly attachments?: readonly ContentRef[];
  readonly timing?: RunTiming;
  /**
   * The Run's native process was handed to its conversation instead of being closed (ADR-030, v11): `cleanup` stays null and
   * the conversation records the process's own close. Only for a completed Run.
   */
  readonly retained?: true;
  /** The Run ran on the process its conversation kept, without starting the program again (ADR-030, v11). */
  readonly reused?: true;
  readonly stopRequested: boolean;
  readonly awaitingSwitchId: SwitchId | null;
}
export interface PublicSwitch {
  readonly id: SwitchId;
  readonly commandId: CommandId;
  readonly requested: SelectionRequest;
  readonly requestedSeq: number;
  readonly target: HarnessSelection | null;
  readonly status: "requested" | "validated" | "effective" | "failed";
  readonly throughSeq: number;
  readonly sourceRunIds: readonly RunId[];
  readonly error: { readonly code: string; readonly message: string } | null;
}
export interface CommandRecord {
  readonly id: CommandId;
  readonly kind: "create" | "send" | "switch" | "cancel" | "close" | "permission" | "native-reset" | "retention" | "native-close";
  readonly fingerprint: string;
  readonly resultId: string;
}
/** Private original-Harness state. Waiting/archived references are never silently resumed or replaced. */
/**
 * Private native session reference. `fork-pending` holds the source checkpoint of a branch not yet sent to the Harness;
 * `forking` means the native fork was dispatched and its result is not yet known (it blocks native use like `unconfirmed`).
 */
export interface NativeSessionBinding {
  readonly harnessId: string;
  readonly controlId: string;
  readonly checkpoint: string;
  readonly throughRunId: RunId | null;
  readonly status: "ready" | "unconfirmed" | "archived" | "fork-pending" | "forking";
  /**
   * v9: the model and option values the native session reported at the end of its last dispatched Turn, including changes
   * made by its own commands. Absent when the interface cannot report them or the last report was unreadable.
   */
  readonly observed?: NativeConfiguration;
}
/** A native session's model and option values as one side saw them; option keys are the Harness's own option ids. */
export interface NativeConfiguration { readonly model: string | null; readonly options: NativeOptions }
/** Public history a branched Session starts from: quoted, immutable, and never re-executed. */
export interface ForkedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly status: RunStatus;
  readonly harnessId?: string;
  readonly attachments?: readonly ContentRef[];
}
/**
 * Where a Session's quoted history came from: a branch of another Session (v8) or a native session of the installed
 * Harness continued in the Hub (v9). The quoted history is immutable and never re-executed.
 */
export type SessionOrigin = BranchOrigin | ImportOrigin;
export interface BranchOrigin {
  readonly kind: "fork";
  readonly sessionId: SessionId;
  readonly throughRunId: RunId;
  readonly history: readonly ForkedMessage[];
}
export interface ImportOrigin {
  readonly kind: "import";
  readonly harnessId: string;
  readonly title: string | null;
  /** Older native messages read but not quoted; the native session itself still has them. */
  readonly omitted: number;
  /** False when even older native history was not read at all. */
  readonly complete: boolean;
  /** False when the Harness could not return its history; the native session still has it. */
  readonly historyRead: boolean;
  readonly history: readonly ForkedMessage[];
}
/**
 * How a kept process group is recognized after its owner ended: the group id (the leader's pid) and the leader's start
 * time as the system reports it, so a later program reusing the id is never mistaken for it.
 */
export interface KeptProcessIdentity { readonly group: number; readonly startedAt: string }
/** Recognizes and ends a previous owner's kept process group (POSIX; ADR-030). */
/** A process that descends from a kept program's group but left it (its own process group): never signalled by the Hub. */
export interface OutsideProcess { readonly pid: number; readonly startedAt: number; readonly command: string }
/**
 * What was seen of such processes when a kept program was closed or taken over: how many were found before its group was
 * ended, how many were still running after (null when that could not be checked), and their command names (no arguments,
 * no paths). "unknown" when they could not be enumerated: no process port, no recorded group, the group was no longer the
 * recorded one, no member remained to start from (descendants were adopted elsewhere), or the process list was unreadable.
 */
export type OutsideEvidence = { readonly state: "enumerated"; readonly found: number; readonly remaining: number | null; readonly commands: readonly string[] } | { readonly state: "unknown" };
export interface ProcessGroupPort {
  /** The start time of the process with this id as the system reports it; null when no such process runs. */
  identify(group: number): Promise<string | null>;
  /**
   * The descendants of the recorded group's members that left the group, read once before the group is ended; null when
   * they cannot be enumerated (see OutsideEvidence). Reading signals nothing.
   */
  outsiders?(identity: KeptProcessIdentity): Promise<readonly OutsideProcess[] | null>;
  /** Which of these still run (the same id and start time); null when that cannot be read. */
  running?(processes: readonly OutsideProcess[]): Promise<readonly OutsideProcess[] | null>;
  /**
   * Ends the recorded group if it still exists: "terminated" once no member remains after SIGTERM and then SIGKILL; "gone"
   * when the group no longer exists (its id may since name another program, which is left alone); "unconfirmed" when
   * members remain or the group cannot be told apart.
   */
  end(identity: KeptProcessIdentity): Promise<"terminated" | "gone" | "unconfirmed">;
}
/** The native process a conversation keeps between Turns (ADR-030, v11), held since its last Run handed it over. */
export interface RetainedProcess {
  readonly harnessId: string;
  readonly controlId: string;
  /** The Run that handed the process over most recently. */
  readonly runId: RunId;
  /** When the conversation first took the process (milliseconds since the epoch). */
  readonly since: number;
  /** v12: how to recognize the process group after this owner ends without closing it; absent when it could not be read. */
  readonly process?: KeptProcessIdentity;
}
export interface SessionSnapshot {
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  readonly id: SessionId;
  readonly version: number;
  readonly lastSeq: number;
  readonly epoch: number;
  readonly status: "open" | "closed" | "blocked";
  readonly configuration: SessionConfiguration;
  readonly selection: HarnessSelection;
  readonly activeRunId: RunId | null;
  readonly pendingSwitchId: SwitchId | null;
  readonly runs: readonly PublicRun[];
  readonly messages: readonly PublicMessage[];
  readonly switches: readonly PublicSwitch[];
  readonly commands: readonly CommandRecord[];
  readonly nativeBindings?: readonly NativeSessionBinding[];
  /** Present on a branched Session (v8): the public history it was branched from. */
  readonly origin?: SessionOrigin;
  /** v11: the user chose to keep this conversation's native process between Turns for background work (ADR-030). */
  readonly retainNative?: true;
  /** v11: the native process this conversation holds now; cleared when it is closed. */
  readonly retained?: RetainedProcess;
}
export interface EventDraft { readonly type: string; readonly data: Readonly<Record<string, unknown>> }
export interface SessionEvent extends EventDraft {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly ownerGeneration: number;
  readonly timestamp: string;
}
export interface SessionMutation { readonly next: SessionSnapshot; readonly events: readonly EventDraft[] }
export interface SessionCommit { readonly session: SessionSnapshot; readonly events: readonly SessionEvent[] }
/** Aggregate-scoped synchronous transaction boundary. Callbacks cannot return promises. */
export interface SessionStore {
  readonly ownerGeneration: number;
  assertOwner(): void;
  create(snapshot: SessionSnapshot, events: readonly EventDraft[]): SessionCommit;
  get(id: SessionId): SessionSnapshot;
  findByCreateKey(key: CommandId): SessionSnapshot | null;
  list(limit?: number): readonly SessionSnapshot[];
  /** Every Session whose state still records a kept native process (ADR-030), whatever its age. */
  listKept(): readonly SessionSnapshot[];
  /** The Session holding each ready or unconfirmed native reference of one Harness control (checkpoint → Session). */
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId>;
  transact(id: SessionId, expectedVersion: number, mutate: (current: SessionSnapshot) => SessionMutation): SessionCommit;
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
  close(): void;
}
export interface WorkspaceLease { assertOwned(): void; release(quiescent: boolean): void }
export interface WorkspaceLeaseProvider {
  acquire(workspace: string, session: SessionId, run: string): WorkspaceLease;
  /**
   * Clears a held record an ended owner left for `session`, once the caller confirmed that the processes it guarded are
   * gone (ADR-030). A live holder or a record for another Session makes it return false; it never infers the end itself.
   */
  releaseAbandoned?(workspace: string, session: SessionId): boolean;
  /**
   * The directory the leases are kept in, when they are kept in one: the providers given one directory exclude each other.
   * What must be shared exactly where the leases are (the host classes' TMPDIRs, ADR-056 §4.12) is placed by it.
   */
  readonly namespace?: string;
}
/**
 * Per-Turn owner; close also releases the workspace lease and removes only its own private directories. The TMPDIR its
 * program was given is its host class's (ADR-056 §4.12): close hands it back, and it outlives the binding.
 */
export interface PreparedSessionBinding {
  readonly installation?: { readonly source: "system" } | { readonly source: "managed"; readonly id: string; readonly revision: number; readonly version: string };
  readonly control: HarnessControl;
  readonly workspace: string;
  /**
   * The known secrets the relay replaces before any history leaves for a Harness (ADR-055 §10.2): the values this
   * binding's program was given or the Gateway's own environment holds under credential names, and the values the
   * Harness's configuration references by name. In memory only: never logged, stored, published or sent. Absent is none.
   */
  readonly secrets?: readonly string[];
  assertOwned(): void;
  close(): Promise<CleanupEvidence>;
}
export interface SessionBindingFactory {
  validate(selection: SelectionRequest, configuration: SessionConfiguration): Promise<HarnessSelection>;
  prepare(selection: HarnessSelection, configuration: SessionConfiguration, session: SessionId, run: string): Promise<PreparedSessionBinding>;
  /** Reads one native session of the workspace for continuing it (no prompt, no workspace writer); absent when unsupported. */
  readNativeSession?(selection: HarnessSelection, configuration: SessionConfiguration, nativeId: string): Promise<import("./control.js").NativeSessionImport>;
  /** Releases the workspace lease an ended owner left for `session`, after its kept processes were confirmed ended (ADR-030). */
  releaseAbandonedLease?(configuration: SessionConfiguration, session: SessionId): boolean;
  /**
   * The known secrets of these Harnesses for the relay (ADR-055 §10.2 at Session level): what their configurations
   * reference by name and their catalog controls' credential-named env values, with this Gateway's own credential-named
   * environment. Starts nothing; in memory only, never logged, stored or sent. Rejects when a configuration cannot be read.
   */
  relaySecrets?(configuration: SessionConfiguration, harnessIds: readonly string[]): Promise<readonly string[]>;
  /**
   * Ends what the factory still does in the background once no binding of it runs (ADR-056 §4.12: the removal of host
   * TMPDIRs moved aside, within its bound; what is left stays for the next start). The Runtime awaits it last in its own
   * close. Idempotent; never rejects.
   */
  close?(): Promise<void>;
}
/** A Turn's budgets unless configured, and their bounds (ADR-036). */
export const DEFAULT_EXECUTION_BUDGET_MS = 300_000, MAX_EXECUTION_BUDGET_MS = 60 * 60_000, MIN_EXECUTION_BUDGET_MS = 30_000;
export const DEFAULT_WAIT_BUDGET_MS = 30 * 60_000, MAX_WAIT_BUDGET_MS = 2 * 60 * 60_000, MIN_WAIT_BUDGET_MS = 60_000;
/** How long a stopped Turn's program may take to settle before its process is ended. */
/** How many conversations run work at once (ADR-036); the same as the kept-process limit. */
export const MAX_PARALLEL_CONVERSATIONS = 4;
export const STOP_GRACE_MS = 15_000;
/**
 * Streamed reply text and thinking are committed per window, not per chunk (ADR-047): a window is committed once it is this
 * old or holds this many bytes, and earlier whenever anything else of its Turn is committed. An uncommitted window is never
 * published and does not advance the persistent cursor.
 */
export const STREAM_WINDOW_MS = 100, STREAM_WINDOW_BYTES = 16 * 1024;
/** The drivers' own per-Turn timeout: only a backstop against a hung protocol, beyond both budgets at their largest. */
export const NATIVE_TURN_HARD_CAP_MS = MAX_EXECUTION_BUDGET_MS + MAX_WAIT_BUDGET_MS + 60 * 60_000;
/**
 * The configured budgets (command-line values in seconds and minutes), with their defaults and bounds (ADR-036). A value
 * that is not a whole number within its bounds is refused, never adjusted.
 */
export function resolveTurnBudgets(input: { readonly executionSeconds?: string | undefined; readonly waitMinutes?: string | undefined } = {}): { readonly executionBudgetMs: number; readonly waitBudgetMs: number } {
  const whole = (value: string | undefined, unit: number, fallback: number, minimum: number, maximum: number, label: string): number => {
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]{0,5}$/u.test(value)) throw new SessionError("INVALID_INPUT", label + " must be a whole number");
    const ms = Number(value) * unit;
    if (ms < minimum || ms > maximum) throw new SessionError("INVALID_INPUT", label + " is out of bounds");
    return ms;
  };
  return { executionBudgetMs: whole(input.executionSeconds, 1000, DEFAULT_EXECUTION_BUDGET_MS, MIN_EXECUTION_BUDGET_MS, MAX_EXECUTION_BUDGET_MS, "execution budget (seconds)"),
    waitBudgetMs: whole(input.waitMinutes, 60_000, DEFAULT_WAIT_BUDGET_MS, MIN_WAIT_BUDGET_MS, MAX_WAIT_BUDGET_MS, "wait budget (minutes)") };
}
/**
 * Why a cancelled Turn ended, in the user's words, so the Runtime's own stops are never shown or exported as the user's
 * (ADR-036): its execution budget, its wait for the user, a restart before it was sent, or the user's stop.
 */
export function cancelledLabel(run: { readonly error?: { readonly code: string } | null; readonly cancelRequested?: boolean }): string {
  switch (run.error?.code) {
    case "RUN_TIMEOUT": return "已取消（执行预算用尽）";
    case "WAIT_EXPIRED": return "已取消（等待你的决定超时）";
    case "OWNER_ENDED": return "已取消（服务重启，这条消息没有发出）";
  }
  return run.cancelRequested === true ? "已取消（用户停止）" : "已取消";
}
export interface SessionRuntimeOptions {
  readonly id: () => string;
  readonly now: () => Date;
  readonly publish: (event: SessionEvent) => void;
  readonly fingerprint: (value: string) => string;
  /** Stores native outputs and tool details; without it those facts stay summaries/diagnostics. */
  readonly content?: ContentPort;
  /** How long a kept native process may stay without a Turn before it is closed (ADR-030); 30 minutes unless shortened. */
  readonly keptIdleMs?: number;
  /** How many conversations may run a Turn, switch or native fork at once (ADR-036); 4 unless set. Each conversation runs one at a time. */
  readonly maxParallel?: number;
  /** A Turn's execution budget (ADR-036): it runs while the Turn works and pauses while it waits for the user. */
  readonly executionBudgetMs?: number;
  /** A Turn's wait budget (ADR-036): time spent waiting for the user's decisions and for a workspace another conversation holds. */
  readonly waitBudgetMs?: number;
  /** How long a stopped Turn's program may take to settle before its process is ended. */
  readonly stopGraceMs?: number;
  /** Recognizes kept process groups across owner restarts; without it a previous owner's kept process cannot be ended. */
  readonly processes?: ProcessGroupPort;
  /**
   * Runs `fn` once after `ms` milliseconds and returns what cancels it: the timer that commits a window of streamed text
   * (ADR-047). Tests inject one and expire windows themselves; setTimeout, kept from holding the process open, unless set.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * A Harness's display name by its id (its catalog name), for the relay packet's sentences (ADR-055 §5.4); the id is
   * shown when absent or when it returns null. Must be synchronous and side-effect free.
   */
  readonly harnessName?: (harnessId: string) => string | null;
}
export interface SendReceipt { readonly sessionId: SessionId; readonly runId: RunId; readonly replayed: boolean }
export interface SwitchReceipt { readonly sessionId: SessionId; readonly switchId: SwitchId; readonly replayed: boolean }
export interface CancelReceipt { readonly sessionId: SessionId; readonly target: RunId | null; readonly replayed: boolean }
export interface PermissionRequest {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly detail?: string;
  readonly input?: {readonly kind:"text"|"editor"|"secret";readonly value:string};
  readonly decided: boolean;
  /** When the Runtime received the request (milliseconds since the epoch, its clock). */
  readonly requestedAt: number;
  /**
   * When the request closes unless decided, and whose deadline it is (ADR-035): the program's own ("native"), or the
   * Turn's wait budget ("turn", ADR-036), after which the Turn is cancelled without an approval reaching the program.
   */
  readonly expiresAt?: number;
  readonly expiresBy?: "native" | "turn";
  /** A question the program asks rather than an approval of its own action; approval when absent. */
  readonly kind?: "question";
}
/**
 * An approval or question still waiting for the user, in any conversation (ADR-035). Only live requests of this owner are
 * listed: a restarted owner lists none, since nothing can answer a request its process no longer holds. The request's
 * title and details stay in its conversation.
 */
export interface AttentionItem {
  readonly sessionId: SessionId;
  readonly permissionId: string;
  readonly runId: string;
  readonly harnessId: string;
  readonly kind: "approval" | "question";
  readonly requestedAt: number;
  readonly expiresAt?: number;
  readonly expiresBy?: "native" | "turn";
}
export type PersistedControlEvent = ControlEvent;
