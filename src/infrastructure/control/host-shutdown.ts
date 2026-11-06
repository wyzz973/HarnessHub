import { performance } from "node:perf_hooks";
import type { CloseStage } from "../../contracts/native-host.js";
import type { OutsideEvidence, OutsideProcess } from "../../contracts/session.js";
import { outsidersOfGroup, stillRunning } from "./process-group.js";

/** How often the closing group is looked at while the chain waits for it to empty. */
const GROUP_POLL_MS = 20;
/** How often processes that left the group and still ran are looked at again while the chain waits for them. */
const OUTSIDE_POLL_MS = 250;
/** At most this many command names of what left the group are kept (ADR-030 supplement). */
const OUTSIDE_COMMANDS = 16;

/** The process group a close chain ends: spawned detached, so its id is its leader's pid; its owner keeps every handle. */
export interface ClosingGroup {
  /** The group's id; null when the program never got one (its spawn failed). */
  readonly group: number | null;
  /** Whether the leader's exit has not been observed yet. */
  leaderRunning(): boolean;
  /** Closes the leader's input: the request to leave on its own. */
  endInput(): void;
  /** Whether the leader's exit and its streams' close were observed and no member of the group remains. */
  quiescent(): boolean;
  /** Sends `signal` to every member of the group; a group already gone is no error. */
  signal(signal: "SIGTERM" | "SIGKILL"): void;
}
/** How the chain reads processes; reading never signals anything. */
export interface ShutdownProbes {
  /** The descendants of the group's members that left it; null when they cannot be enumerated. */
  outsiders(group: number): Promise<readonly OutsideProcess[] | null>;
  /** Which of these still run, by pid and start time; null when that cannot be read. */
  running(processes: readonly OutsideProcess[]): Promise<readonly OutsideProcess[] | null>;
}
export const POSIX_SHUTDOWN_PROBES: ShutdownProbes = { outsiders: outsidersOfGroup, running: stillRunning };
/** The first part of a close: how it ended and what had left the group before its input closed. */
export interface Quiescence {
  /** The group was confirmed empty; when false the caller must treat its cleanup as failed. */
  readonly quiescent: boolean;
  readonly stage: CloseStage;
  /** From the start of the close to the group's end (or to giving up on it), in milliseconds. */
  readonly closeMs: number;
  /** What had left the group, read before its input closed; null when it was not read or could not be. */
  readonly found: readonly OutsideProcess[] | null;
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
/** Waits up to `ms` for the group to empty; resolves with whether it did. */
async function settled(target: ClosingGroup, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  do {
    if (target.quiescent()) return true;
    await delay(Math.min(GROUP_POLL_MS, Math.max(1, end - performance.now())));
  } while (performance.now() < end);
  return target.quiescent();
}
/**
 * The first part of the close chain of ADR-056 §4.11, the part a close waits for. With `sample`, the processes that left
 * the group are read once while the leader still runs (once it has exited, what it started was adopted elsewhere and can
 * no longer be told apart, so nothing is read). Then the leader's input is closed and the chain waits up to `graceMs` for
 * the leader to exit and the group to empty, and only then signals the group: SIGTERM, up to `graceMs` more, then SIGKILL
 * and up to `graceMs` more. What left the group is never signalled. A group that is not empty after SIGKILL ends it with
 * `quiescent: false`. Rejects only when signalling or reading the group itself fails unexpectedly.
 */
export async function quiesce(target: ClosingGroup, graceMs: number, sample?: ShutdownProbes["outsiders"]): Promise<Quiescence> {
  const started = performance.now(), group = target.group;
  const found = sample !== undefined && group !== null && target.leaderRunning() ? await sample(group).catch(() => null) : null;
  let stage: CloseStage = "eof";
  target.endInput();
  let quiescent = await settled(target, graceMs);
  if (!quiescent) { stage = "sigterm"; target.signal("SIGTERM"); quiescent = await settled(target, graceMs); }
  if (!quiescent) { stage = "sigkill"; target.signal("SIGKILL"); quiescent = await settled(target, graceMs); }
  return { quiescent, stage, closeMs: Math.round(performance.now() - started), found };
}
/**
 * The second part, which no Turn waits for: the processes found outside the group, looked at by pid and start time (an id
 * given to another program since is not counted) until none runs, `waitMs` has passed, or `signal` aborts. Those gone are
 * not counted; those still running are recorded as remaining. An abort while some still run records `remaining: null`
 * (they were not looked at to the end). Nothing is signalled. Never rejects.
 */
export async function confirmOutside(found: readonly OutsideProcess[] | null, waitMs: number, running: ShutdownProbes["running"] = stillRunning, signal?: AbortSignal): Promise<OutsideEvidence> {
  if (found === null) return { state: "unknown" };
  const commands = [...new Set(found.map(item => item.command))].slice(0, OUTSIDE_COMMANDS);
  const look = (processes: readonly OutsideProcess[]) => running(processes).catch(() => null), aborted = () => signal?.aborted === true;
  let remaining = found.length ? await look(found) : [];
  for (const end = performance.now() + waitMs; remaining !== null && remaining.length > 0 && performance.now() < end && !aborted();) {
    await delay(Math.min(OUTSIDE_POLL_MS, Math.max(1, end - performance.now())), signal);
    if (aborted()) break;
    remaining = await look(remaining);
  }
  const unfinished = aborted() && remaining !== null && remaining.length > 0;
  return { state: "enumerated", found: found.length, remaining: remaining === null || unfinished ? null : remaining.length, commands };
}
