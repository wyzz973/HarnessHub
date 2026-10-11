import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessGroupPort } from "../../contracts/session.js";

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
