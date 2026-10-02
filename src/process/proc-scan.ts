// SPDX-License-Identifier: MIT
/**
 * Linux `/proc` process-table scan.
 *
 * Reading `/proc/<pid>/environ` takes the target's memory-map lock and can
 * block for as long as another task holds it (a stuck NFS or FUSE mapping).
 * The Gateway therefore never reads `/proc` itself: `proc-scan-main.ts` runs
 * this scan in a short-lived child with a deadline, output limit and SIGKILL,
 * reading one file at a time. A blocked read stalls only that child.
 *
 * Records the scanning user may not read (`hidepid` mounts, other users'
 * processes, non-dumpable processes) are counted as hidden and skipped: no
 * rule can own another user's process, and a non-dumpable process's
 * environment is unreadable even without `hidepid`.
 */

/** One process of a snapshot. `started` is opaque and only compared for equality. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Effective user ID. */
  readonly uid: number;
  /** Real user ID. */
  readonly ruid: number;
  readonly zombie: boolean;
  readonly started: string;
}

/** Result of one `/proc` scan. */
export interface ProcScan {
  rows: ProcessRow[];
  /** PIDs whose environment holds the requested `NAME=value` entry exactly. */
  marked: number[];
  /** Listed processes whose records could not be read (EACCES/EPERM). */
  hidden: number;
}

/** Synchronous file access, injected so tests can model `hidepid` and races. */
export interface ProcFs {
  list(): string[];
  read(path: string): Buffer;
}

function code(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}
const VANISHED = new Set(["ENOENT", "ESRCH"]);
const DENIED = new Set(["EACCES", "EPERM"]);

/** Parse `/proc/<pid>/stat`; `started` is the start time in clock ticks since boot. */
export function parseProcStat(text: string): Omit<ProcessRow, "uid" | "ruid"> {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const pid = Number(text.slice(0, open));
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const started = fields[19];
  if (
    open < 1 ||
    close < open ||
    ![pid, ppid, pgid].every(Number.isSafeInteger) ||
    !fields[0] ||
    !started ||
    !/^\d+$/.test(started)
  )
    throw new Error("Unexpected /proc stat record");
  return {
    pid,
    ppid,
    pgid,
    zombie: fields[0] === "Z" || fields[0] === "X",
    started,
  };
}

/** Read the real and effective user IDs from `/proc/<pid>/status`. */
export function parseProcUids(text: string): { uid: number; ruid: number } {
  const match = /^Uid:\s+(\d+)\s+(\d+)\s/m.exec(text);
  if (!match) throw new Error("Unexpected /proc status record");
  return { ruid: Number(match[1]), uid: Number(match[2]) };
}

/**
 * Scan every process once. `token` is an exact `NAME=value` environment entry
 * to look for. Throws on an unexpected read error or record, so a partial
 * table is never mistaken for a complete one.
 */
export function scanProc(fs: ProcFs, token?: string): ProcScan {
  const result: ProcScan = { rows: [], marked: [], hidden: 0 };
  for (const name of fs.list()) {
    if (!/^\d+$/.test(name)) continue;
    let row: ProcessRow;
    try {
      row = {
        ...parseProcStat(fs.read(`/proc/${name}/stat`).toString("latin1")),
        ...parseProcUids(fs.read(`/proc/${name}/status`).toString("latin1")),
      };
    } catch (error) {
      if (VANISHED.has(String(code(error)))) continue;
      if (DENIED.has(String(code(error)))) {
        result.hidden += 1;
        continue;
      }
      throw error;
    }
    result.rows.push(row);
    if (token === undefined || row.zombie) continue;
    let environ: Buffer;
    try {
      environ = fs.read(`/proc/${name}/environ`);
    } catch (error) {
      // Exited, or not readable by this user: not attributable by marker.
      if (VANISHED.has(String(code(error))) || DENIED.has(String(code(error))))
        continue;
      throw error;
    }
    if (environ.toString("latin1").split("\0").includes(token))
      result.marked.push(row.pid);
  }
  return result;
}

/** Errno-style code of a scan failure, safe to log; anything else is "unexpected". */
export function scanFailureCode(error: unknown): string {
  const value = code(error);
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(value)
    ? value
    : "unexpected";
}
