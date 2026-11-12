import type { ProviderTarget } from "./provider.js";
import type { BackendResult, CleanupEvidence, ControlEvent, HarnessControl, NativeOptions, NativePlanEntry, NativeUsage } from "./control.js";
import type { ContentPort, ContentRef } from "./content.js";
import type { BindingRelayState, RelayRows, RunRelay, RunRelayRequest, SwitchMode, SwitchTiming } from "./relay.js";
import type { ReadTurn } from "./protocol-read.js";

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
 * is absent; the Harness never supplies these values. The phases never go back in time, in this order: acceptedAt,
 * preparingAt, contextReadyAt, readyAt, dispatchedAt, firstOutputAt, endedAt; recordedAt lies between dispatchedAt and
 * endedAt without being one of them (ADR-055 §4, RT2-21).
 */
export interface RunTiming {
  /** The input was accepted and queued. */
  readonly acceptedAt: number;
  /** Preparation began: the original program is being started for this Run. */
  readonly preparingAt?: number;
  /** v13: what the Turn sends was prepared (its relay packet rendered and checked, or none needed); fixed once dispatched. */
  readonly contextReadyAt?: number;
  /** The program answered its handshake and its native session (new or restored) is open. */
  readonly readyAt?: number;
  /** The input was handed to the program. */
  readonly dispatchedAt?: number;
  /** The first visible native output arrived: reply text, thinking, a tool, a plan, an approval or question, an output or an activity. */
  readonly firstOutputAt?: number;
  /** The Run reached its final status. */
  readonly endedAt?: number;
  /** v13: the native side recorded the input (E1, `relay.input_recorded`); it does not set firstOutputAt. */
  readonly recordedAt?: number;
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
  /**
   * v13: the packet this Run carries (or none), how it continued its context and where it ran (ADR-055 §4); fixed once the
   * Run is running. Until G073 new Runs still write `sourceRunIds` (the Runs their packet carries); a reader takes the relay
   * packet's fold as what the packet carried (A12).
   */
  readonly relay?: RunRelay;
  /** v13: the relay choice its request made (attach the history, or send alone), with its HMAC. Fixed at acceptance. */
  readonly relayRequest?: RunRelayRequest;
  /**
   * The Run as the HarnessHub protocol (hh/1) tells it: its Turn in order, as a client draws it. Added to the conversation view and
   * its Run frames when read; never part of what is stored. A client without it draws the Run from the facts above.
   */
  readonly protocol?: ReadTurn;
  /** Set by a client's decoder when the Run's `protocol` could not be read: why, in words a reader can be told. The Run is then shown as one that cannot be shown, with this. */
  readonly protocolProblem?: string;
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
  /** The Runs before the request; on a recovery switch they cover its unknown Runs. New switches write acknowledgedUnknown instead (v13). */
  readonly sourceRunIds: readonly RunId[];
  readonly error: { readonly code: string; readonly message: string } | null;
  /** v13: whether the switch waits for the current Turn or stops it. */
  readonly mode?: SwitchMode;
  /** v13: when it was requested, validated and became effective. */
  readonly timing?: SwitchTiming;
  /**
   * v13, recovery switches only: the unknown Runs the user acknowledged keeping as they are; each ended unknown, closed its
   * resources and came before the request.
   */
  readonly acknowledgedUnknown?: readonly RunId[];
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
  /**
   * The native position: the last Run dispatched into this native session (ADR-055 §7.4, A1), whatever the relay knows of
   * what reached it; null before the first. It says nothing of the relay's delivery watermark (`relay`).
   */
  readonly throughRunId: RunId | null;
  readonly status: "ready" | "unconfirmed" | "archived" | "fork-pending" | "forking";
  /**
   * v13: the binding has no native session it can resume (ADR-055 §7.5): its Driver gave the one it cleared up and opened none
   * ahead (the Hub's clear, `native.cleared`), or the session a Turn opened for it
   * was never prompted because that Turn ended before dispatch (G068 fix batch 2, I-1a: another process cannot resume a session
   * never prompted). The next Turn opens a new native session, with this binding's relay state and observed configuration;
   * `checkpoint` names the session it gave up, which is never resumed and which the conversation no longer holds
   * (`nativeOwners`, the continue command). Gone once a Turn is dispatched into the new session; a Turn that ends before
   * dispatch leaves it, and the checkpoint, as they were. Only on a ready binding without a native position.
   */
  readonly opensNew?: true;
  /**
   * v9: the model and option values the native session reported at the end of its last dispatched Turn, including changes
   * made by its own commands. Absent when the interface cannot report them or the last report was unreadable.
   */
  readonly observed?: NativeConfiguration;
  /**
   * v13, present on every binding: its native epoch, delivery watermark and sync state (ADR-055 §4). `throughRunId` stays its
   * native position, a different fact. Frozen once the binding is archived.
   */
  readonly relay?: BindingRelayState;
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
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
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
  /**
   * v13: the seq of the event whose relay rows could not be written (ADR-055 §9 S15): a `session.recovered`, or a Turn's
   * `run.ended` committed without its relay part when the Store refused it (`relay.failed`, G068 fix batch R6); a Turn that
   * would carry relay content is then refused until the user starts a new native session.
   */
  readonly relayRecoveryFailed?: number;
}
export interface EventDraft { readonly type: string; readonly data: Readonly<Record<string, unknown>> }
export interface SessionEvent extends EventDraft {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly ownerGeneration: number;
  readonly timestamp: string;
}
/** A transaction's result: the next snapshot, its events and (v13) the relay rows to write with them. */
export interface SessionMutation { readonly next: SessionSnapshot; readonly events: readonly EventDraft[]; readonly relay?: RelayRows }
/** A committed transaction; `relay` says how the relay rows it was given went. */
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
  /**
   * The Session holding each ready or unconfirmed native reference of one Harness control (checkpoint → Session); a binding that
   * opens a new native session (opensNew) holds none.
   */
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
  /**
   * Whether the native process this binding started has the Hub's tools (src/contracts/table.ts): it was started with the context
   * table's environment (the Hub's address and its own token) and its Harness's own configuration holds the Hub's tool entry as the
   * Hub writes it. Said only by a factory that checked both when it started the process; a process kept for later Turns keeps
   * what it was started with. Absent is no: nothing is promised the packet could repeat.
   */
  readonly hubTools?: boolean;
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
   * environment. Starts nothing; in memory only, never logged, stored or sent. Asked only for a Turn that builds a packet.
   * Rejects with RELAY_PREPARE_FAILED when a configuration file it must read cannot be (its message names the Harness, the
   * file and why, never a value); the Turn then fails undispatched and the history stays owed.
   */
  relaySecrets?(configuration: SessionConfiguration, harnessIds: readonly string[]): Promise<readonly string[]>;
  /**
   * The static relay declaration of the Driver that serves `selection` (ADR-055 §3.2, F10), read at admission without
   * starting anything or building a control; null when it declares none. Absent: admission cannot tell, so it leaves every
   * relay question to the check after the open, and the Runtime then applies none of G072's gates (only a test's fake factory is
   * so; the Gateway's own, DirectorySessionBindingFactory, always answers).
   */
  relayCapabilities?(selection: HarnessSelection): import("./relay.js").RelayCapabilities | null;
  /**
   * Ends what the factory still does in the background once no binding of it runs (ADR-056 §4.12: the removal of host
   * TMPDIRs moved aside, within its bound; what is left stays for the next start). The Runtime awaits it last in its own
   * close. Idempotent; never rejects.
   */
  close?(): Promise<void>;
}
/**
 * A Turn has no time wall (decided 2026-11-12; ADR-036 is superseded by it). The two budgets below are an operator's optional
 * automatic stops, off unless given on the command line: `executionBudgetMs` stops a Turn that has worked this long (the time it
 * waits for the user does not count), `waitBudgetMs` expires an approval or question nobody answered in this long. Only their
 * smallest values are bounded, so a typing slip cannot stop every Turn at once; there is no largest.
 */
export const MIN_EXECUTION_BUDGET_MS = 30_000, MIN_WAIT_BUDGET_MS = 60_000;
/** How long a stopped Turn's program may take to settle before its process is ended. */
export const STOP_GRACE_MS = 15_000;
/**
 * Streamed reply text and thinking are committed per window, not per chunk (ADR-047): a window is committed once it is this
 * old or holds this many bytes, and earlier whenever anything else of its Turn is committed. An uncommitted window is never
 * published and does not advance the persistent cursor.
 */
export const STREAM_WINDOW_MS = 100, STREAM_WINDOW_BYTES = 16 * 1024;
/**
 * The operator's optional limits (command-line values: seconds, minutes, a count), each present only when given. Nothing here has a
 * default: without a value a Turn is never stopped for its time, an approval never expires on the Hub's account, and every
 * conversation runs at once.
 */
export interface TurnLimits { readonly executionBudgetMs?: number; readonly waitBudgetMs?: number; readonly maxParallel?: number }
/** The limits given on the command line; a value that is not a whole number at least as large as its minimum is refused, never adjusted. */
export function resolveTurnBudgets(input: { readonly executionSeconds?: string | undefined; readonly waitMinutes?: string | undefined; readonly maxParallel?: string | undefined } = {}): TurnLimits {
  const whole = (value: string | undefined, unit: number, minimum: number, label: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]{0,8}$/u.test(value)) throw new SessionError("INVALID_INPUT", label + " must be a whole number");
    const ms = Number(value) * unit;
    if (ms < minimum) throw new SessionError("INVALID_INPUT", label + " is below its minimum");
    return ms;
  };
  const executionBudgetMs = whole(input.executionSeconds, 1000, MIN_EXECUTION_BUDGET_MS, "execution budget (seconds)"), waitBudgetMs = whole(input.waitMinutes, 60_000, MIN_WAIT_BUDGET_MS, "wait budget (minutes)");
  const maxParallel = whole(input.maxParallel, 1, 1, "parallel conversations");
  return { ...(executionBudgetMs === undefined ? {} : { executionBudgetMs }), ...(waitBudgetMs === undefined ? {} : { waitBudgetMs }), ...(maxParallel === undefined ? {} : { maxParallel }) };
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
  /**
   * How many conversations may run a Turn, switch or native fork at once; unlimited unless set (an operator's choice, never a default).
   * Each conversation runs one at a time. Conversations in one workspace all run: the later Turn is told the others are there.
   */
  readonly maxParallel?: number;
  /** An automatic stop for a Turn that has worked this long (the time it waits for the user does not count); none unless set. */
  readonly executionBudgetMs?: number;
  /** An automatic expiry for an approval or question the user has not answered in this long; none unless set (a deadline its Harness announces stays). */
  readonly waitBudgetMs?: number;
  /**
   * When a Turn that goes on says so, and when a Harness that went quiet is mentioned: `hintsMs` are the marks of the time it has worked
   * (10 min, 30 min, 1 h, 2 h, 4 h, 8 h, then again every 8 h), `quietMs` how long without any event from its Harness (5 min) makes the
   * hint say so. A hint is a notice on the Turn; it never stops anything.
   */
  readonly pacing?: { readonly hintsMs?: readonly number[]; readonly quietMs?: number };
  /** How many native processes conversations may keep between Turns; unlimited unless set. A Turn that cannot keep its process says so. */
  readonly keptLimit?: number;
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
  /**
   * The installation's relay key (ADR-055 §10.2, D5; relay-keys.ts): the HMACs of delivery rows and of a request's relay
   * choice. Without it the Runtime keys them under a key it keeps only in memory and names EPHEMERAL_KEY_ID (A17), which no
   * reader can check; the Gateway's own entries always give one.
   */
  readonly relayKeys?: import("./relay.js").RelayKeyPort;
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
