// SPDX-License-Identifier: MIT
/**
 * POSIX attribution of Worker descendants that left the Worker's process group.
 *
 * Group signalling cannot reach a descendant that started its own session or
 * group (setsid, `spawn({ detached: true })`, daemonizing tools, job-control
 * shells). Such a process is owned when it runs as the Gateway's user (real
 * and effective UID) and
 *   - a snapshot taken before shutdown shows it in the Worker tree (recorded as
 *     PID plus start time, which stays valid after reparenting and tells a
 *     reused PID apart between that snapshot and a later one), or
 *   - its environment carries this Worker's {@link WORKER_TREE_ENVIRONMENT}
 *     marker, or
 *   - it descends by parent chain from a process owned by either rule.
 * A process reached by these rules but running as another user is never
 * signalled; it keeps the outcome `unconfirmed`. This process and its
 * ancestors are never owned, and ownership never passes down through them. A
 * process group is signalled only when its leader and every member are owned,
 * and never a group with ID 0 or 1 or this process's own group.
 *
 * The marker also reclaims shared daemons and applications that a Run started
 * first (a tmux or screen server, an ssh ControlPersist master, gpg-agent,
 * Gradle/Bazel/Nx daemons, an editor launched detached) and everything they
 * start later, since all of them inherit it.
 *
 * Residual gap: cleanup cannot attribute a descendant whose environment does
 * not show the marker once its parent has exited before the scan that would
 * have linked it: a descendant already reparented before the pre-shutdown
 * snapshot, or one created after that snapshot whose parent exits before the
 * final scan. The environment does not show the marker for a process started
 * with a fresh environment (`env -i`, an explicit `env` option), a process of
 * another user, a non-dumpable Linux process, or on macOS an Apple platform
 * binary such as /bin/sh or /bin/sleep, whose environment `ps -E` omits. For
 * such a process cleanup can report `confirmed` while it keeps running.
 */
import { setTimeout as delay } from "node:timers/promises";
import { WORKER_TREE_ENVIRONMENT } from "../domain/environment.js";
import { NO_LOG, type LogFields, type LogSink } from "../domain/logging.js";
import type { CleanupStatus } from "../domain/types.js";
import {
  ProcessTableError,
  readMarkerSnapshot,
  type ProcessRow,
  type ProcessTable,
} from "./process-table.js";

/** A process proven to belong to a Worker tree, identified across snapshots. */
export interface TreeProcess {
  readonly pid: number;
  readonly started: string;
}

/** The scanning process and the only user whose processes can be owned. */
export interface ScanIdentity {
  readonly self: number;
  readonly uid: number;
}

/** This Gateway's identity; throws where POSIX user IDs are unavailable. */
export function gatewayIdentity(): ScanIdentity {
  const uid = process.geteuid?.();
  if (uid === undefined)
    throw new ProcessTableError(`no POSIX user ID on ${process.platform}`);
  return { self: process.pid, uid };
}

/** `self` and its ancestors in `table`. */
function lineage(table: ProcessTable, self: number): Set<number> {
  const shielded = new Set<number>();
  for (
    let pid: number | undefined = self;
    pid !== undefined && !shielded.has(pid);
    pid = table.get(pid)?.ppid
  )
    shielded.add(pid);
  return shielded;
}

/**
 * Whether group `pgid` contains this process or one of its ancestors, or this
 * process is missing from `table` so that cannot be ruled out.
 */
export function groupShieldsSelf(
  table: ProcessTable,
  pgid: number,
  self: number,
): boolean {
  if (!table.has(self)) return true;
  return [...lineage(table, self)].some((pid) => table.get(pid)?.pgid === pgid);
}

/**
 * A snapshot that does not show this process cannot shield it or its
 * ancestors (for example a non-dumpable Gateway hidden from the Linux scanner
 * by `hidepid`), so it counts as unreadable.
 *
 * @throws ProcessTableError
 */
function requireSelf(table: ProcessTable, identity: ScanIdentity): void {
  if (!table.has(identity.self))
    throw new ProcessTableError(
      "this process is missing from the process table",
    );
}

/** Processes reachable from seeds: owned ones, and other users' ones where the walk stopped. */
export interface Ownership {
  owned: ProcessRow[];
  foreign: ProcessRow[];
}

/**
 * Walk parent links down from `seeds`, seeds included. Zombies are skipped.
 * `identity.self` and its ancestors are never included or walked through. A
 * process whose real or effective UID differs from `identity.uid` is reported
 * as foreign and the walk does not continue below it.
 */
export function walkOwnership(
  table: ProcessTable,
  seeds: Iterable<number>,
  identity: ScanIdentity,
): Ownership {
  const shielded = lineage(table, identity.self);
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const visited = new Set<number>();
  const result: Ownership = { owned: [], foreign: [] };
  const pending = [...seeds];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    const row = table.get(pid);
    if (!row || visited.has(pid) || shielded.has(pid)) continue;
    visited.add(pid);
    if (row.zombie) continue;
    if (row.uid !== identity.uid || row.ruid !== identity.uid) {
      result.foreign.push(row);
      continue;
    }
    result.owned.push(row);
    pending.push(...(children.get(pid) ?? []));
  }
  return result;
}

/**
 * Record a Worker tree from `table`: the members of the root's process group
 * (the root itself while it is alive) and their descendants, including
 * processes of other users so a later scan still counts them.
 *
 * `rootUnreaped` means the Worker had not been reaped when the snapshot
 * began. Its PID then cannot have been reused; a zombie root has no children,
 * so its group members alone attribute the tree. A reaped root whose PID is
 * present again may have been reused together with its group ID, so nothing
 * is attributed.
 */
export function workerTree(
  table: ProcessTable,
  root: number,
  rootUnreaped: boolean,
  identity: ScanIdentity,
): TreeProcess[] {
  requireSelf(table, identity);
  const rootRow = table.get(root);
  if (!rootUnreaped && rootRow) return [];
  const seeds = [...table.values()]
    .filter((row) => row.pgid === root)
    .map((row) => row.pid);
  if (rootRow && !rootRow.zombie) seeds.push(root);
  const { owned, foreign } = walkOwnership(table, seeds, identity);
  return [...owned, ...foreign].map(({ pid, started }) => ({ pid, started }));
}

/**
 * Groups that may be signalled as a whole: led by an owned process, every
 * live member owned, and neither group 0/1 nor `ownGroup`. Nothing when this
 * process's own group is unknown.
 */
export function killableGroups(
  owned: readonly ProcessRow[],
  table: ProcessTable,
  ownGroup: number | undefined,
): number[] {
  if (ownGroup === undefined) return [];
  const ownedPids = new Set(owned.map((row) => row.pid));
  return owned
    .filter(
      (row) =>
        row.pgid === row.pid &&
        row.pgid > 1 &&
        row.pgid !== ownGroup &&
        [...table.values()].every(
          (member) =>
            member.pgid !== row.pgid ||
            member.zombie ||
            ownedPids.has(member.pid),
        ),
    )
    .map((row) => row.pgid);
}

/**
 * Final guard before `kill`: group targets as negative IDs and then PIDs,
 * never PID or group 0/1, this process, or its own (or an unknown) group.
 */
export function signalTargets(
  groups: readonly number[],
  pids: readonly number[],
  guard: { self: number; ownGroup: number | undefined },
): number[] {
  return [
    ...groups
      .filter(
        (pgid) =>
          guard.ownGroup !== undefined && pgid > 1 && pgid !== guard.ownGroup,
      )
      .map((pgid) => -pgid),
    ...pids.filter((pid) => pid > 1 && pid !== guard.self),
  ];
}

/** One scan's view of the processes that outlived the Worker's group. */
export interface Survivors {
  owned: ProcessRow[];
  groups: number[];
  /** Reached by the ownership rules but running as another user. */
  foreign: number;
  /** Showing the marker without a provable environment (macOS). */
  unknown: number;
  /** Listed processes whose records were unreadable (Linux hidepid). */
  hidden: number;
  ownGroup: number | undefined;
}

/** Steps of one reclaim, injected so tests can model each outcome. */
export interface ReclaimSteps {
  scan(): Promise<Survivors>;
  kill(target: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
}

/** Outcome of one reclaim with the reason for anything but `confirmed`. */
export interface ReclaimOutcome {
  status: CleanupStatus;
  reason?:
    | "scan_failed"
    | "tree_unrecorded"
    | "survivors"
    | "foreign"
    | "unknown"
    | "signal_failed";
  error?: string;
  last?: Survivors;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

/**
 * The reclaim loop: scan; while owned survivors or unknown verdicts remain,
 * send SIGTERM and then SIGKILL to the survivors, wait up to `graceMs` for
 * them, and scan again. `recordedComplete`
 * is false when the pre-shutdown tree could not be read, which limits the
 * outcome to `unconfirmed`.
 */
export async function reclaimWith(
  steps: ReclaimSteps,
  options: { graceMs: number; recordedComplete: boolean; self: number },
): Promise<ReclaimOutcome> {
  const scan = async (): Promise<Survivors | ProcessTableError> => {
    try {
      return await steps.scan();
    } catch (error) {
      // An unreadable table cannot prove absence; ownership stays quarantined.
      return error instanceof ProcessTableError
        ? error
        : new ProcessTableError("scan failed unexpectedly");
    }
  };
  let found = await scan();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    // An unknown verdict comes from an exec or exit between two reads; the
    // next scan usually settles it. Other users' processes do not change.
    if (
      found instanceof ProcessTableError ||
      (found.owned.length === 0 && found.unknown === 0)
    )
      break;
    for (const target of signalTargets(
      found.groups,
      found.owned.map((row) => row.pid),
      { self: options.self, ownGroup: found.ownGroup },
    )) {
      try {
        steps.kill(target, signal);
      } catch (error) {
        // ESRCH: exited since the scan. EPERM: the next scan still shows it.
        if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM")
          return { status: "failed", reason: "signal_failed", last: found };
      }
    }
    const deadline = Date.now() + options.graceMs;
    const pids = found.owned.map((row) => row.pid);
    while (pids.some((pid) => steps.alive(pid)) && Date.now() < deadline)
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    found = await scan();
  }
  if (found instanceof ProcessTableError)
    return {
      status: "unconfirmed",
      reason: "scan_failed",
      error: found.message,
    };
  const last = found;
  const unconfirmed = (
    reason: NonNullable<ReclaimOutcome["reason"]>,
  ): ReclaimOutcome => ({ status: "unconfirmed", reason, last });
  if (last.owned.length > 0) return unconfirmed("survivors");
  if (last.foreign > 0) return unconfirmed("foreign");
  if (last.unknown > 0) return unconfirmed("unknown");
  if (!options.recordedComplete) return unconfirmed("tree_unrecorded");
  return { status: "confirmed", last };
}

async function survivors(
  marker: string,
  recorded: readonly TreeProcess[],
  identity: ScanIdentity,
): Promise<Survivors> {
  const snapshot = await readMarkerSnapshot(marker);
  requireSelf(snapshot.table, identity);
  const seeds = new Set(snapshot.marked);
  for (const entry of recorded)
    if (snapshot.table.get(entry.pid)?.started === entry.started)
      seeds.add(entry.pid);
  const { owned, foreign } = walkOwnership(snapshot.table, seeds, identity);
  const ownedPids = new Set(owned.map((row) => row.pid));
  const ownGroup = snapshot.table.get(identity.self)?.pgid;
  return {
    owned,
    groups: killableGroups(owned, snapshot.table, ownGroup),
    foreign: foreign.length,
    unknown: [...snapshot.unknown].filter((pid) => !ownedPids.has(pid)).length,
    hidden: snapshot.hidden,
    ownGroup,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/**
 * Find and stop the owned processes of a Worker tree that outlived its process
 * group, then verify none remains. Call it only after the group is confirmed
 * gone.
 *
 * Each scan is one bounded snapshot (see `process-table.ts`). With no survivor
 * this is a single scan; otherwise SIGTERM, a scan, SIGKILL and a final scan,
 * each signal followed by a wait of up to `graceMs`.
 *
 * @param input.marker The Worker's owner token, the value of {@link WORKER_TREE_ENVIRONMENT}.
 * @param input.recorded The tree recorded before shutdown; `undefined` when it
 * could not be read, which limits the outcome to `unconfirmed`.
 * @param input.log Receives `worker.tree_unconfirmed` with the reason and
 * counts whenever the outcome is not `confirmed`, merged with `input.context`.
 * @returns `confirmed` only when the final scan shows no owned survivor, no
 * other user's process reached by the rules and nothing unattributable
 * carrying the marker; `unconfirmed` otherwise or when a snapshot cannot be
 * read; `failed` on an unexpected signalling error. Undetectable survivors
 * (see the module notes) do not change the outcome.
 */
export async function reclaimTreeSurvivors(input: {
  marker: string;
  recorded: readonly TreeProcess[] | undefined;
  graceMs: number;
  log?: LogSink;
  context?: LogFields;
}): Promise<CleanupStatus> {
  const log = input.log ?? NO_LOG;
  let identity: ScanIdentity;
  try {
    identity = gatewayIdentity();
  } catch {
    log.info("worker.tree_unconfirmed", {
      ...input.context,
      status: "unconfirmed",
      reason: "scan_failed",
      error: `no POSIX user ID on ${process.platform}`,
    });
    return "unconfirmed";
  }
  const outcome = await reclaimWith(
    {
      scan: () => survivors(input.marker, input.recorded ?? [], identity),
      kill: (target, signal) => process.kill(target, signal),
      alive,
    },
    {
      graceMs: input.graceMs,
      recordedComplete: input.recorded !== undefined,
      self: identity.self,
    },
  );
  if (outcome.status !== "confirmed")
    log.info("worker.tree_unconfirmed", {
      ...input.context,
      status: outcome.status,
      reason: outcome.reason,
      error: outcome.error,
      survivors: outcome.last?.owned.length,
      foreign: outcome.last?.foreign,
      unknown: outcome.last?.unknown,
      hidden: outcome.last?.hidden,
    });
  return outcome.status;
}
