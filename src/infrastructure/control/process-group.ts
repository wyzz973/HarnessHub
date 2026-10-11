import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { KeptProcessIdentity, OutsideProcess, ProcessGroupPort } from "../../contracts/session.js";

/** A Darwin group can return EPERM after exit because XNU skips zombies. Every listed group member must be non-running. */
export function exitedGroupSnapshotIsQuiescent(group: number, snapshot: string): boolean {
  if (!Number.isSafeInteger(group) || group<=1 || Buffer.byteLength(snapshot)>4*1024*1024) return false;
  let rows=0;
  for(const line of snapshot.split(/\r?\n/u)) {
    if(!line.trim())continue;
    const match=/^\s*([0-9]+)\s+([A-Za-z<>+N-]{1,16})\s*$/u.exec(line);
    if(!match || !Number.isSafeInteger(Number(match[1])))return false;
    rows++;
    if(Number(match[1])===group && !match[2]!.startsWith("Z"))return false;
  }
  return rows>0;
}
/** Used only after observing this owned root's exit and an EPERM signal. Inventory errors never assert cleanup success. */
export function darwinExitedGroupIsQuiescent(group: number): boolean {
  if(process.platform!=="darwin")return false;
  try { return exitedGroupSnapshotIsQuiescent(group,execFileSync("/bin/ps",["-axo","pgid=,stat="],{encoding:"utf8",timeout:1500,maxBuffer:4*1024*1024})); }
  catch { return false; }
}

const execFileAsync = promisify(execFile);
/** Recorded and observed start times within this many seconds name the same process (elapsed time is whole seconds). */
const START_TOLERANCE_S = 2;
/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null when the text is not one. */
export function elapsedSeconds(text: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/u.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}
/** How deep below a group's members descendants are followed, and how many outside ones are kept. */
const OUTSIDE_DEPTH = 32, OUTSIDE_LIMIT = 256;
/**
 * The descendants of a group's members that left the group, from one `ps -axo pid=,ppid=,pgid=,etime=,comm=` table taken
 * at `now` (Unix seconds): with their start times and command base names (no arguments, no paths). Null when no member of
 * the group is in the table, so there is nothing to start from, or the table cannot be read.
 */
export function outsidersOf(table: string, group: number, now: number): readonly OutsideProcess[] | null {
  if (!Number.isSafeInteger(group) || group <= 1 || Buffer.byteLength(table) > 4 * 1024 * 1024) return null;
  const rows: { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly startedAt: number; readonly command: string }[] = [];
  for (const line of table.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line), elapsed = match ? elapsedSeconds(match[4]!) : null;
    if (!match || elapsed === null) return null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: now - elapsed, command: match[5]!.trim().split("/").at(-1)!.slice(0, 64) });
  }
  const children = new Map<number, typeof rows>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  let level = rows.filter(row => row.pgid === group);
  if (!level.length) return null;
  const seen = new Set(level.map(row => row.pid)), outside: OutsideProcess[] = [];
  for (let depth = 0; depth < OUTSIDE_DEPTH && level.length; depth++) {
    const next: typeof rows = [];
    for (const parent of level) for (const child of children.get(parent.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid); next.push(child);
      if (child.pgid !== group && outside.length < OUTSIDE_LIMIT) outside.push({ pid: child.pid, startedAt: child.startedAt, command: child.command });
    }
    level = next;
  }
  return outside;
}
function errorCode(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? error.code : undefined; }
/** Whether any member of the process group still runs; an unreadable answer counts as running. */
function groupAlive(group: number): boolean {
  try { process.kill(-group, 0); return true; }
  catch (error) { const code = errorCode(error); if (code === "ESRCH") return false; if (code === "EPERM") return !darwinExitedGroupIsQuiescent(group); throw error; }
}
/**
 * Recognizes and ends a previous owner's kept process group on POSIX (ADR-030). A group is the one recorded only while its
 * leader's start time matches; the leader's id given to another program means the recorded group had no members left
 * (a system does not reuse an id that still names a process group), so that program is never signalled.
 */
export class PosixProcessGroups implements ProcessGroupPort {
  /** The start of the process with this id, in Unix seconds as text (from its elapsed time, so the time zone never matters). */
  async identify(group: number): Promise<string | null> {
    if (!Number.isSafeInteger(group) || group <= 1) return null;
    let stdout: string;
    try { ({ stdout } = await execFileAsync("/bin/ps", ["-o", "etime=", "-p", String(group)], { timeout: 2000, maxBuffer: 4096, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } })); }
    catch (error) { if (errorCode(error) === 1) return null; throw error; }
    const elapsed = elapsedSeconds(stdout);
    return elapsed === null ? null : String(Math.round(Date.now() / 1000) - elapsed);
  }
  /**
   * Read once, before any signal, and only while the recorded leader still runs: once it has exited, its descendants were
   * adopted elsewhere and can no longer be told apart, so nothing found would mean nothing.
   */
  async outsiders(identity: KeptProcessIdentity): Promise<readonly OutsideProcess[] | null> {
    try {
      const leader = await this.identify(identity.group), recorded = Number(identity.startedAt);
      if (leader === null || !Number.isFinite(recorded) || Math.abs(Number(leader) - recorded) > START_TOLERANCE_S) return null;
      const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,etime=,comm="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } });
      return outsidersOf(stdout, identity.group, Math.round(Date.now() / 1000));
    } catch { return null; }
  }
  async running(processes: readonly OutsideProcess[]): Promise<readonly OutsideProcess[] | null> {
    if (!processes.length) return [];
    let stdout = "";
    try { ({ stdout } = await execFileAsync("/bin/ps", ["-o", "pid=,etime=", "-p", processes.map(item => item.pid).join(",")], { timeout: 2000, maxBuffer: 1024 * 1024, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } })); }
    catch (error) { if (errorCode(error) !== 1) return null; }
    const now = Math.round(Date.now() / 1000), alive = new Map<number, number>();
    for (const line of stdout.split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\S+)\s*$/u.exec(line), elapsed = match ? elapsedSeconds(match[2]!) : null;
      if (match && elapsed !== null) alive.set(Number(match[1]), now - elapsed);
    }
    return processes.filter(item => { const started = alive.get(item.pid); return started !== undefined && Math.abs(started - item.startedAt) <= START_TOLERANCE_S; });
  }
  async end(identity: { readonly group: number; readonly startedAt: string }): Promise<"terminated" | "gone" | "unconfirmed"> {
    const leader = await this.identify(identity.group), recorded = Number(identity.startedAt);
    if (leader !== null && (!Number.isFinite(recorded) || Math.abs(Number(leader) - recorded) > START_TOLERANCE_S)) return "gone";
    if (!groupAlive(identity.group)) return "gone";
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      try { process.kill(-identity.group, signal); }
      catch (error) { const code = errorCode(error); if (code === "ESRCH") return "terminated"; if (code !== "EPERM") throw error; }
      for (const deadline = Date.now() + 3000; Date.now() < deadline;) { if (!groupAlive(identity.group)) return "terminated"; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    return groupAlive(identity.group) ? "unconfirmed" : "terminated";
  }
}
