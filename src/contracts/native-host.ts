import type { CleanupEvidence, HarnessControl, NativeConversationId } from "./control.js";
import { MAX_PARALLEL_CONVERSATIONS, SessionError, type HarnessSelection, type KeptProcessIdentity, type NativeSessionBinding, type OutsideEvidence, type RunId,
  type SessionConfiguration, type SessionId, type WorkspaceLease } from "./session.js";

// Native hosts and session leases (ADR-056; design §4.2–4.4, §4.10–4.12). A native session is data, recorded as a binding;
// a host is the process, or the connection to a native service, that has sessions open; a Turn leases one session on one
// host and never owns the process. This file names mechanisms only: whatever differs between Harnesses reaches the
// Gateway through a driver's HostCapabilities, never through a product name.

declare const hostBrand: unique symbol;
declare const leaseBrand: unique symbol;
declare const classBrand: unique symbol;
/** One host: a native program's process, or one connection to a native service, that opens native sessions. */
export type HostId = string & { readonly [hostBrand]: true };
/** One session lease: a Turn's, or a conversation's background keep's, exclusive use of one native session on one host. */
export type SessionLeaseId = string & { readonly [leaseBrand]: true };
/**
 * A host class: lowercase sha256 hex of the Harness, its entry, the entry's installation fingerprint and its launch
 * fingerprint (design §4.3). Hosts of one class can take each other's work; an upgrade or another launch makes another class.
 */
export type HostClassKey = string & { readonly [classBrand]: true };
function identity(value: unknown, prefix: string): string {
  if (typeof value !== "string" || !new RegExp("^" + prefix + "-[a-zA-Z0-9-]{1,96}$", "u").test(value)) throw new SessionError("INVALID_INPUT", "invalid " + prefix + " identity");
  return value;
}
/** `host-` and 1–96 letters, digits or dashes; anything else is refused with INVALID_INPUT. */
export function hostId(value: unknown): HostId { return identity(value, "host") as HostId; }
/** `lease-` and 1–96 letters, digits or dashes; anything else is refused with INVALID_INPUT. */
export function sessionLeaseId(value: unknown): SessionLeaseId { return identity(value, "lease") as SessionLeaseId; }
/** Exactly 64 lowercase hex digits; anything else is refused with INVALID_INPUT. */
export function hostClassKey(value: unknown): HostClassKey {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new SessionError("INVALID_INPUT", "invalid host class key");
  return value as HostClassKey;
}

/** A selection that is a host's launch parameter: when it changes, that host cannot take the Turn. */
export type LaunchBound = "model" | "options" | "collaboration_mode" | "provider";
const LAUNCH_BOUND: readonly LaunchBound[] = ["model", "options", "collaboration_mode", "provider"];
/**
 * A driver's static declaration of how its hosts behave (ADR-056 decision 1, design §4.2). It describes mechanisms only and
 * is read without starting a program. A field the driver leaves out takes its most conservative value
 * (CONSERVATIVE_HOST_CAPABILITIES): reuse is never granted by omission.
 */
export interface HostCapabilities {
  /** How many native sessions one host carries: exactly one, several of which one is active (switching), or several at once. */
  readonly sessions: "one_per_process" | "switchable" | "concurrent";
  /** Whether a session's workspace may differ from the host's launch directory; launch_cwd_only puts the workspace in the class. */
  readonly sessionCwd: "launch_cwd_only" | "per_session";
  /** What reopening an existing session costs: replaying its whole history, passing a reference only, or unknown; byLoadOnly when replay is the only way. */
  readonly reopen: { readonly cost: "replay" | "reference" | "unknown"; readonly byLoadOnly: boolean };
  /** What one open session keeps resident (measured): light does not grow with sessions, heavy brings its own child processes. */
  readonly sessionMemory: "light" | "heavy" | "unknown";
  /** Whether closing a session inside the host returns its resources (its child processes exit), or only ending the process does. */
  readonly sessionRelease: "in_process" | "process_only" | "unknown";
  /** The selections that are the host's launch parameters. */
  readonly launchBound: readonly LaunchBound[];
  /** As RelayCapabilities.execution: under gateway the host's exit is no evidence that its native session is quiescent. */
  readonly execution: "process" | "gateway";
  /** Whether the program may still write the workspace with no Turn running; a possible writer is never idle in the pool, only pinned or closed. */
  readonly idleActivity: "none" | "background_possible" | "unknown";
  /** Whether initialize creates a session or writes user state; only none lets a host without sessions be kept alive. No value allows creating a session to warm up (INV-42). */
  readonly initializeSideEffects: "none" | "creates_session" | "writes_state" | "unknown";
  /** Whether different sessions of one host can run Turns at the same time; only a host carrying sessions at once can. */
  readonly concurrentTurns: boolean;
  /** Whether Turns made outside the Hub (in the original program, by another client) can be told, and how; drives freshness. */
  readonly foreignTurns: "detectable_on_open" | "detectable_by_listing" | "undetectable";
  /** Set once the driver's host probes passed on the latest release (ADR-053); only then is multi-session reuse open in production. */
  readonly probed: boolean;
}
/** The value of every field a declaration leaves out. */
export const CONSERVATIVE_HOST_CAPABILITIES: HostCapabilities = Object.freeze({
  sessions: "one_per_process", sessionCwd: "launch_cwd_only", reopen: Object.freeze({ cost: "unknown", byLoadOnly: true }), sessionMemory: "unknown",
  sessionRelease: "unknown", launchBound: Object.freeze([...LAUNCH_BOUND]), execution: "gateway", idleActivity: "unknown", initializeSideEffects: "unknown",
  concurrentTurns: false, foreignTurns: "undetectable", probed: false,
});
function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new SessionError("INVALID_INPUT", label + " must be a plain object");
  return value as Record<string, unknown>;
}
function known(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new SessionError("INVALID_INPUT", "unknown " + label + " fields");
}
function choice<T extends string>(row: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T, label: string): T {
  const value = row[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new SessionError("INVALID_INPUT", label + "." + key + " is not a known value");
  return value as T;
}
function flag(row: Record<string, unknown>, key: string, fallback: boolean, label: string): boolean {
  const value = row[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new SessionError("INVALID_INPUT", label + "." + key + " must be boolean");
  return value;
}
/**
 * Reads a driver's declaration (external input until checked). A missing field takes its conservative value; a field of
 * the wrong type, an unknown value or field, a repeated launch parameter, or a contradiction (concurrent Turns on a host
 * that does not carry sessions at once, a reference-cost reopen that only replay can do) is refused with INVALID_INPUT,
 * never repaired.
 */
export function parseHostCapabilities(value: unknown): HostCapabilities {
  const row = plain(value, "host capabilities"), fallback = CONSERVATIVE_HOST_CAPABILITIES;
  known(row, Object.keys(fallback), "host capabilities");
  const reopenRow = row.reopen === undefined ? {} : plain(row.reopen, "host capabilities.reopen");
  known(reopenRow, ["cost", "byLoadOnly"], "host capabilities.reopen");
  const reopen = { cost: choice(reopenRow, "cost", ["replay", "reference", "unknown"] as const, fallback.reopen.cost, "host capabilities.reopen"),
    byLoadOnly: flag(reopenRow, "byLoadOnly", fallback.reopen.byLoadOnly, "host capabilities.reopen") };
  if (reopen.byLoadOnly && reopen.cost === "reference") throw new SessionError("INVALID_INPUT", "a reopen that only replay can do cannot cost a reference");
  let launchBound: readonly LaunchBound[] = fallback.launchBound;
  if (row.launchBound !== undefined) {
    if (!Array.isArray(row.launchBound) || row.launchBound.length > LAUNCH_BOUND.length || row.launchBound.some(item => typeof item !== "string" || !LAUNCH_BOUND.includes(item as LaunchBound))
      || new Set(row.launchBound).size !== row.launchBound.length) throw new SessionError("INVALID_INPUT", "host capabilities.launchBound must list distinct known selections");
    launchBound = [...row.launchBound as LaunchBound[]];
  }
  const sessions = choice(row, "sessions", ["one_per_process", "switchable", "concurrent"] as const, fallback.sessions, "host capabilities");
  const concurrentTurns = flag(row, "concurrentTurns", fallback.concurrentTurns, "host capabilities");
  if (concurrentTurns && sessions !== "concurrent") throw new SessionError("INVALID_INPUT", "concurrent Turns need a host that carries sessions at once");
  return { sessions, sessionCwd: choice(row, "sessionCwd", ["launch_cwd_only", "per_session"] as const, fallback.sessionCwd, "host capabilities"), reopen,
    sessionMemory: choice(row, "sessionMemory", ["light", "heavy", "unknown"] as const, fallback.sessionMemory, "host capabilities"),
    sessionRelease: choice(row, "sessionRelease", ["in_process", "process_only", "unknown"] as const, fallback.sessionRelease, "host capabilities"), launchBound,
    execution: choice(row, "execution", ["process", "gateway"] as const, fallback.execution, "host capabilities"),
    idleActivity: choice(row, "idleActivity", ["none", "background_possible", "unknown"] as const, fallback.idleActivity, "host capabilities"),
    initializeSideEffects: choice(row, "initializeSideEffects", ["none", "creates_session", "writes_state", "unknown"] as const, fallback.initializeSideEffects, "host capabilities"),
    concurrentTurns, foreignTurns: choice(row, "foreignTurns", ["detectable_on_open", "detectable_by_listing", "undetectable"] as const, fallback.foreignTurns, "host capabilities"),
    probed: flag(row, "probed", fallback.probed, "host capabilities") };
}
/**
 * The budget kind of a host class (design §4.3, §5), from its sessions, sessionMemory and sessionRelease alone: one session
 * per process or switching between them is single; several light sessions at once is light; heavy sessions whose close
 * returns their resources are heavy_reclaimable; heavy or unknown sessions otherwise are heavy_process_only, so an unknown
 * declaration gets the strictest kind.
 */
export type HostKind = "single" | "light" | "heavy_reclaimable" | "heavy_process_only";
export function hostKind(capabilities: Pick<HostCapabilities, "sessions" | "sessionMemory" | "sessionRelease">): HostKind {
  switch (capabilities.sessions) {
    case "one_per_process": case "switchable": return "single";
    case "concurrent":
      switch (capabilities.sessionMemory) {
        case "light": return "light";
        case "heavy": return capabilities.sessionRelease === "in_process" ? "heavy_reclaimable" : "heavy_process_only";
        case "unknown": return "heavy_process_only";
      }
  }
}

/** A host's lifecycle: starting, idle in the pool, leased to a Turn, pinned to a conversation (ADR-030), draining, closing, dead. */
export type HostState = "starting" | "idle" | "leased" | "pinned" | "draining" | "closing" | "dead";
export const HOST_STATES: readonly HostState[] = ["starting", "idle", "leased", "pinned", "draining", "closing", "dead"];
/** Why a host or one of its sessions was closed; each close is recorded with its evidence. */
export type HostCloseReason = "idle" | "evicted" | "budget" | "stale_class" | "harness_upgrade" | "config_changed" | "exited" | "unhealthy" | "gateway_shutdown"
  | "ended_by_user" | "conversation_closed" | "native_reset" | "branched" | "disabled" | "selection_changed";
export const HOST_CLOSE_REASONS: readonly HostCloseReason[] = ["idle", "evicted", "budget", "stale_class", "harness_upgrade", "config_changed", "exited", "unhealthy",
  "gateway_shutdown", "ended_by_user", "conversation_closed", "native_reset", "branched", "disabled", "selection_changed"];
/** Why an open session was found not fresh (design §4.4); any one of them reopens the session or checks it first. */
export type StaleReason = "foreign_turns" | "unknown_outcome" | "binding_unconfirmed" | "binding_forking" | "relay_pending" | "relay_suspect" | "context_effect"
  | "config_changed" | "harness_upgraded" | "launch_bound_changed" | "workspace_identity_changed" | "host_unhealthy" | "undetectable";
export const STALE_REASONS: readonly StaleReason[] = ["foreign_turns", "unknown_outcome", "binding_unconfirmed", "binding_forking", "relay_pending", "relay_suspect",
  "context_effect", "config_changed", "harness_upgraded", "launch_bound_changed", "workspace_identity_changed", "host_unhealthy", "undetectable"];
/** The freshness of a session open on a host before it is leased again, with what decided it; what cannot be decided is not fresh. */
export type FreshnessVerdict =
  | { readonly fresh: true; readonly basis: "just_opened" | "same_owner_no_foreign" | "verified_on_open" | "native_session_unchanged" }
  | { readonly fresh: false; readonly reason: StaleReason };

/** A native session open on a host. */
export interface HostedSession {
  readonly native: NativeConversationId;
  readonly binding: { readonly sessionId: SessionId; readonly harnessId: string; readonly controlId: string; readonly checkpoint: string };
  /** The last verdict that found it fresh, and on what; judged again (design §4.4) before every lease. */
  readonly freshness: FreshnessVerdict;
  /** Milliseconds since the epoch. */
  readonly lastUsedAt: number;
}
/** A host's process identity and latest sample, for the registry and the budget; times are milliseconds since the epoch. */
export interface HostHealth {
  readonly identity: KeptProcessIdentity | null;
  readonly healthy: boolean;
  readonly startedAt: number;
  readonly lastUsedAt: number;
  readonly idleSinceAt: number | null;
  /** The resident memory of the host's whole process tree when last sampled; null when it was not or could not be sampled. */
  readonly rssBytes: number | null;
  readonly sampledAt: number | null;
}
/** How far a host's close went (design §4.11): its program left on its own once its input closed, or its process group was sent SIGTERM, then SIGKILL. */
export type CloseStage = "eof" | "sigterm" | "sigkill";
/**
 * A host's own cleanup: the connection's CleanupEvidence, the stage the close chain reached (null when no program had
 * started) and how long the chain took, in milliseconds. A Run keeps only the CleanupEvidence fields; the stage and the
 * time belong to the host's close record.
 */
export interface HostCleanup extends CleanupEvidence {
  readonly stage: CloseStage | null;
  readonly closeMs: number;
}
/** A host's close: its cleanup, and what had left its process group (found before its input closed, still running after the wait). */
export interface HostCloseEvidence { readonly cleanup: HostCleanup; readonly outside: OutsideEvidence }
export interface NativeHost {
  readonly id: HostId;
  readonly classKey: HostClassKey;
  readonly state: HostState;
  readonly control: HarnessControl;
  readonly sessions: ReadonlyMap<NativeConversationId, HostedSession>;
  /** The process identity and the latest sample; synchronous and without I/O. */
  health(): HostHealth;
  /** Takes no new lease; closes once the current leases end. Resolves when the host is closed. */
  drain(reason: HostCloseReason): Promise<void>;
  /**
   * Closes the host by the close chain (design §4.11) and resolves with its evidence; idempotent. Rejects when the process
   * group cannot be confirmed ended, and then the host stays dead and any workspace lease it held stays quarantined.
   */
  close(reason: HostCloseReason): Promise<HostCloseEvidence>;
}
/** What a Turn asks of the pool: its native session (null for a new one) under the workspace lease it already holds. */
export interface SessionLeaseRequest {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly epoch: number;
  readonly selection: HarnessSelection;
  readonly configuration: SessionConfiguration;
  readonly binding: NativeSessionBinding | null;
  /** The Turn's workspace lease; the pool checks it and never acquires one on the Turn's behalf. */
  readonly workspaceLease: WorkspaceLease;
}
export interface SessionLease {
  readonly id: SessionLeaseId;
  readonly host: HostId;
  readonly native: NativeConversationId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly epoch: number;
  /** The host was already in the pool. */
  readonly reused: boolean;
  /** Why the session was reopened; null when it was used as it was. */
  readonly reopened: StaleReason | null;
  /** Throws once the lease was released or its host lost. */
  assertHeld(): void;
  /**
   * Hands the session back: settled returns the host to the pool, pin gives it to the conversation (ADR-030), unknown makes
   * the host dead and starts its close. Idempotent; resolves when the host's state is recorded.
   */
  release(outcome: "settled" | "pin" | "unknown"): Promise<void>;
}
/** A distribution of durations in milliseconds; the percentiles are null when nothing was measured. */
export interface DurationSummary { readonly count: number; readonly p50Ms: number | null; readonly p90Ms: number | null; readonly maxMs: number | null }
/** One host as the metrics show it: no paths, environment values or session content. */
export interface HostMetric {
  readonly host: HostId;
  readonly classKey: HostClassKey;
  readonly kind: HostKind;
  readonly harnessId: string;
  readonly sessionId: SessionId | null;
  readonly state: HostState;
  readonly sessions: number;
  readonly idleMs: number | null;
  readonly rssBytes: number | null;
}
/** The pool's metrics (design §4.10): hosts, reuse, start and reopen times, evictions, takeovers and Turns waiting for a host. */
export interface HostPoolMetrics {
  readonly hosts: readonly HostMetric[];
  /** Turns that took a session, and how many of them took it on a host already in the pool. */
  readonly dispatched: number;
  readonly reused: number;
  readonly coldStart: DurationSummary;
  readonly reopen: DurationSummary;
  readonly evictions: Readonly<Partial<Record<HostCloseReason, number>>>;
  readonly takeovers: { readonly terminated: number; readonly gone: number; readonly unconfirmed: number };
  readonly waiting: { readonly turns: number; readonly longestMs: number | null };
}
export interface HostPool {
  /**
   * Picks a host (design §4.3): a live, fresh session on a host of the class; the same host with the session reopened; a
   * host of the class that opens it; a new host within the budget after evicting idle unpinned ones; otherwise the Turn
   * waits, visibly, for a host. Never takes a leased, pinned or draining host or its active sessions.
   */
  lease(request: SessionLeaseRequest): Promise<SessionLease>;
  /** Gives the lease's host to the conversation (ADR-030): it keeps the workspace lease and counts against maxPinned. */
  pin(sessionId: SessionId, lease: SessionLease): void;
  unpin(sessionId: SessionId, reason: HostCloseReason): Promise<void>;
  /** Drains every host of the class; resolves with how many there were. */
  drainClass(classKey: HostClassKey, reason: HostCloseReason): Promise<number>;
  /** Closes every host and resolves once each close is recorded. */
  shutdown(): Promise<void>;
  metrics(): HostPoolMetrics;
}

/** Conversation events of hosts (design §4.10), beside the native.process_* events of ADR-030. */
export const HOST_EVENTS = ["native.host_started", "native.session_reused", "native.session_reopened", "native.session_closed", "native.host_closed",
  "native.host_evicted", "native.host_lost", "native.host_drained"] as const;
export type HostEventType = typeof HOST_EVENTS[number];
/** The data of each host event; no paths, environment values or session content. */
export interface HostEventData {
  readonly "native.host_started": { readonly hostId: HostId; readonly classKey: HostClassKey; readonly coldStartMs: number };
  readonly "native.session_reused": { readonly hostId: HostId; readonly basis: Extract<FreshnessVerdict, { readonly fresh: true }>["basis"] };
  readonly "native.session_reopened": { readonly hostId: HostId; readonly reason: StaleReason; readonly replayMs?: number; readonly replayBytes?: number };
  readonly "native.session_closed": { readonly hostId: HostId; readonly reason: HostCloseReason };
  readonly "native.host_closed": { readonly hostId: HostId; readonly reason: HostCloseReason; readonly cleanup: HostCleanup; readonly outside: OutsideEvidence };
  readonly "native.host_evicted": { readonly hostId: HostId; readonly lruAgeMs: number; readonly rssBytes: number | null };
  readonly "native.host_lost": { readonly hostId: HostId; readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean };
  readonly "native.host_drained": { readonly classKey: HostClassKey; readonly reason: HostCloseReason; readonly count: number };
}

/** Each kind's caps (design §4.3); times in milliseconds. */
export interface HostClassCaps {
  /** One process per conversation, closed after this long without a Turn. */
  readonly single: { readonly hostIdleMs: number };
  /** Several sessions per process, the process kept this long without a Turn. */
  readonly light: { readonly maxSessionsPerHost: number; readonly hostIdleMs: number };
  /** Sessions alive at once, each closed in the host after its idle time; the host closed once it has had no session this long. */
  readonly heavy_reclaimable: { readonly maxLiveSessions: number; readonly sessionIdleMs: number; readonly emptyHostIdleMs: number };
  /** One process per conversation, at most this many at once, each closed after its idle time. */
  readonly heavy_process_only: { readonly maxProcesses: number; readonly hostIdleMs: number };
}
/**
 * The host budgets (design §4.3, §4.11, §4.12), resolved in one place: memory first, capped per kind; byte counts and
 * milliseconds. Start values come from the 2026-11-03 measurements on one 64 GiB machine and are meant to be tuned.
 */
export interface HostBudgets {
  /** The resident memory, summed over each host's sampled process tree, beyond which idle unpinned hosts are evicted. */
  readonly hostMemoryBudgetBytes: number;
  /** Hosts of every state together, a backstop beside the memory budget. */
  readonly maxHosts: number;
  /** Hosts pinned to conversations (ADR-030); never more than maxHosts. */
  readonly maxPinned: number;
  /** Conversations running a Turn at once (ADR-036). */
  readonly maxParallel: number;
  /** A pinned host with neither a Turn nor a native event for this long is closed (ADR-030). */
  readonly pinnedIdleTtlMs: number;
  /** A pinned host is closed this long after its last Turn whatever it does; never shorter than pinnedIdleTtlMs. */
  readonly pinnedHardCapMs: number;
  readonly classCaps: HostClassCaps;
  /** How long a closing host's program has, once its input closed, before its process group is sent SIGTERM; and again before SIGKILL. */
  readonly closeGraceMs: number;
  /**
   * How long a host's close evidence waits for processes that left its group to exit on their own before recording them as
   * remaining; they are never signalled, and no Turn waits for this.
   */
  readonly closeOutsideWaitMs: number;
  /** A host class's TMPDIR whose files take more than this on disk is emptied once the class has no live host. */
  readonly hostTmpdirMaxBytes: number;
  /**
   * Likewise a TMPDIR holding more entries than this (files and directories together): the bytes alone never catch the empty
   * directories a program can leave at every start, and the walk that counts them is on a Turn's close.
   */
  readonly hostTmpdirMaxEntries: number;
  /** A host class's TMPDIR unused this long is deleted when the Hub starts. */
  readonly hostTmpdirUnusedMs: number;
  /**
   * How long a service's shutdown waits for the TMPDIRs it moved aside to be removed in the background; what is left then
   * stays for the next start's sweep.
   */
  readonly hostTmpdirCloseWaitMs: number;
}
const MIB = 1024 * 1024, MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
type Bounds = { readonly min: number; readonly max: number; readonly fallback: number };
type ScalarBudget = Exclude<keyof HostBudgets, "hostMemoryBudgetBytes" | "classCaps">;
/** Every scalar budget's bounds and default; the one place they are decided. */
export const HOST_BUDGET_BOUNDS: { readonly [K in ScalarBudget]: Bounds } = Object.freeze({
  maxHosts: { min: 1, max: 64, fallback: 8 },
  maxPinned: { min: 1, max: 16, fallback: 4 },
  maxParallel: { min: 1, max: 16, fallback: MAX_PARALLEL_CONVERSATIONS },
  pinnedIdleTtlMs: { min: MINUTE, max: 4 * HOUR, fallback: 30 * MINUTE },
  pinnedHardCapMs: { min: 30 * MINUTE, max: DAY, fallback: 4 * HOUR },
  closeGraceMs: { min: 1_500, max: 30_000, fallback: 1_500 },
  closeOutsideWaitMs: { min: 1_000, max: 60_000, fallback: 10_000 },
  hostTmpdirMaxBytes: { min: 16 * MIB, max: 16 * 1024 * MIB, fallback: 256 * MIB },
  hostTmpdirMaxEntries: { min: 256, max: 65_536, fallback: 4_096 },
  hostTmpdirUnusedMs: { min: DAY, max: 90 * DAY, fallback: 7 * DAY },
  hostTmpdirCloseWaitMs: { min: 1_000, max: 60_000, fallback: 5_000 },
});
/** Every kind cap's bounds and default. */
export const HOST_CLASS_CAP_BOUNDS: { readonly [K in HostKind]: { readonly [F in keyof HostClassCaps[K]]: Bounds } } = Object.freeze({
  single: { hostIdleMs: { min: MINUTE, max: HOUR, fallback: 5 * MINUTE } },
  light: { maxSessionsPerHost: { min: 1, max: 32, fallback: 8 }, hostIdleMs: { min: MINUTE, max: HOUR, fallback: 15 * MINUTE } },
  heavy_reclaimable: { maxLiveSessions: { min: 1, max: 16, fallback: 3 }, sessionIdleMs: { min: MINUTE, max: HOUR, fallback: 10 * MINUTE },
    emptyHostIdleMs: { min: 10_000, max: 30 * MINUTE, fallback: 2 * MINUTE } },
  heavy_process_only: { maxProcesses: { min: 1, max: 16, fallback: 3 }, hostIdleMs: { min: MINUTE, max: HOUR, fallback: 5 * MINUTE } },
});
/** The memory budget's floor, and the least physical memory whose default (an eighth of it) reaches that floor. */
export const MIN_HOST_MEMORY_BUDGET_BYTES = 256 * MIB, MIN_PHYSICAL_MEMORY_BYTES = 8 * MIN_HOST_MEMORY_BUDGET_BYTES;
function whole(value: unknown, bounds: Bounds, label: string): number {
  if (value === undefined) return bounds.fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SessionError("INVALID_INPUT", label + " must be a whole number");
  if (value < bounds.min || value > bounds.max) throw new SessionError("INVALID_INPUT", label + " is out of bounds");
  return value;
}
/**
 * The host budgets: each configured value (external input until checked) within its bounds, every other one its default.
 * `physicalMemoryBytes` is the machine's memory, read by the caller; the memory budget defaults to an eighth of it and may
 * be set between 256 MiB and all of it. A value that is not a whole number, out of its bounds or unknown, maxPinned above
 * maxHosts, a kind's process cap above maxHosts, or a pinned idle time beyond the hard cap is refused with INVALID_INPUT,
 * never adjusted; so is less physical memory than 2 GiB.
 */
export function resolveHostBudgets(input: { readonly physicalMemoryBytes: number; readonly configured?: unknown }): HostBudgets {
  const physical = input.physicalMemoryBytes;
  if (typeof physical !== "number" || !Number.isSafeInteger(physical) || physical < MIN_PHYSICAL_MEMORY_BYTES) throw new SessionError("INVALID_INPUT", "physical memory must be a whole number of at least 2 GiB");
  const row = input.configured === undefined ? {} : plain(input.configured, "host budgets");
  known(row, ["hostMemoryBudgetBytes", "classCaps", ...Object.keys(HOST_BUDGET_BOUNDS)], "host budgets");
  const scalar = (key: ScalarBudget) => whole(row[key], HOST_BUDGET_BOUNDS[key], key);
  const capsRow = row.classCaps === undefined ? {} : plain(row.classCaps, "classCaps");
  known(capsRow, Object.keys(HOST_CLASS_CAP_BOUNDS), "classCaps");
  // A kind's configured caps, checked for unknown fields; each field is then read within its own bounds.
  const kind = (name: HostKind): ((field: string) => number) => {
    const fields = capsRow[name] === undefined ? {} : plain(capsRow[name], "classCaps." + name), bounds: Readonly<Record<string, Bounds>> = HOST_CLASS_CAP_BOUNDS[name];
    known(fields, Object.keys(bounds), "classCaps." + name);
    return field => whole(fields[field], bounds[field]!, "classCaps." + name + "." + field);
  };
  const single = kind("single"), light = kind("light"), reclaimable = kind("heavy_reclaimable"), processOnly = kind("heavy_process_only");
  const budgets: HostBudgets = { hostMemoryBudgetBytes: whole(row.hostMemoryBudgetBytes, { min: MIN_HOST_MEMORY_BUDGET_BYTES, max: physical, fallback: Math.floor(physical / 8) }, "hostMemoryBudgetBytes"),
    maxHosts: scalar("maxHosts"), maxPinned: scalar("maxPinned"), maxParallel: scalar("maxParallel"), pinnedIdleTtlMs: scalar("pinnedIdleTtlMs"), pinnedHardCapMs: scalar("pinnedHardCapMs"),
    classCaps: { single: { hostIdleMs: single("hostIdleMs") }, light: { maxSessionsPerHost: light("maxSessionsPerHost"), hostIdleMs: light("hostIdleMs") },
      heavy_reclaimable: { maxLiveSessions: reclaimable("maxLiveSessions"), sessionIdleMs: reclaimable("sessionIdleMs"), emptyHostIdleMs: reclaimable("emptyHostIdleMs") },
      heavy_process_only: { maxProcesses: processOnly("maxProcesses"), hostIdleMs: processOnly("hostIdleMs") } },
    closeGraceMs: scalar("closeGraceMs"), closeOutsideWaitMs: scalar("closeOutsideWaitMs"), hostTmpdirMaxBytes: scalar("hostTmpdirMaxBytes"), hostTmpdirMaxEntries: scalar("hostTmpdirMaxEntries"),
    hostTmpdirUnusedMs: scalar("hostTmpdirUnusedMs"), hostTmpdirCloseWaitMs: scalar("hostTmpdirCloseWaitMs") };
  if (budgets.maxPinned > budgets.maxHosts) throw new SessionError("INVALID_INPUT", "maxPinned cannot exceed maxHosts");
  if (budgets.classCaps.heavy_process_only.maxProcesses > budgets.maxHosts) throw new SessionError("INVALID_INPUT", "classCaps.heavy_process_only.maxProcesses cannot exceed maxHosts");
  if (budgets.pinnedIdleTtlMs > budgets.pinnedHardCapMs) throw new SessionError("INVALID_INPUT", "pinnedIdleTtlMs cannot exceed pinnedHardCapMs");
  return budgets;
}
