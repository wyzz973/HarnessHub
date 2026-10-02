// SPDX-License-Identifier: MIT
/**
 * POSIX attribution of Worker descendants that left the Worker's process group.
 *
 * Group signalling cannot reach a descendant that started its own session or
 * group (setsid, `spawn({ detached: true })`, daemonizing tools, job-control
 * shells). Such a process is owned when
 *   - a snapshot taken while the Worker tree was intact shows it below the
 *     Worker (recorded as PID plus start time, which survives reparenting but
 *     not PID reuse), or
 *   - its environment carries this Worker's {@link WORKER_TREE_ENVIRONMENT}
 *     marker, or
 *   - it descends by parent chain from a process owned by either rule.
 * Nothing else is signalled. This process and its ancestors are never owned,
 * and ownership never passes down through them (a Gateway started inside an
 * older Worker tree survives its recovery). A process group is signalled only
 * when the snapshot shows its leader and every member owned.
 *
 * Residual gap: a descendant that is already reparented when cleanup starts
 * (its parent exited) and whose environment does not show the marker cannot be
 * attributed, so cleanup can report `confirmed` while it keeps running. The
 * environment does not show the marker when the process was started with a
 * fresh environment (`env -i`, an explicit `env` option), runs as another user,
 * is non-dumpable on Linux, or on macOS is an Apple platform binary such as
 * /bin/sh or /bin/sleep, whose environment `ps -E` omits.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { WORKER_TREE_ENVIRONMENT } from "../domain/environment.js";
import type { CleanupStatus } from "../domain/types.js";

/** One process of a snapshot. `started` is opaque and only compared for equality. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly zombie: boolean;
  readonly started: string;
}
/** A macOS `ps` row whose last column is the command (with `-E`, followed by the environment). */
export interface CommandRow extends ProcessRow {
  readonly command: string;
}
/** Processes of one snapshot by PID. */
export type ProcessTable = ReadonlyMap<number, ProcessRow>;
/** A process proven to belong to a Worker tree, identified across snapshots. */
export interface TreeProcess {
  readonly pid: number;
  readonly started: string;
}

const exec = promisify(execFile);
const PS_COLUMNS = "pid=,ppid=,pgid=,stat=,lstart=";
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*?))?\s*$/;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

/**
 * Parse macOS `ps -o pid=,ppid=,pgid=,stat=,lstart=[,command=]` output produced
 * with `LC_ALL=C`. Throws on any row it cannot read, so an unexpected format
 * fails the inspection instead of hiding a process.
 */
export function parsePsRows(output: string): Map<number, CommandRow> {
  const rows = new Map<number, CommandRow>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = PS_ROW.exec(line);
    if (!match) throw new Error("Unexpected process table row");
    const pid = Number(match[1]);
    rows.set(pid, {
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      zombie: match[4]!.startsWith("Z"),
      started: match[5]!.replace(/\s+/g, " "),
      command: match[6] ?? "",
    });
  }
  return rows;
}

/** Parse Linux `/proc/<pid>/stat`; `started` is the start time in clock ticks since boot. */
export function parseProcStat(text: string): ProcessRow {
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

async function ps(args: string[], maxBuffer: number): Promise<string> {
  try {
    const { stdout } = await exec("/bin/ps", args, {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    return stdout;
  } catch (error) {
    // `ps -p` exits 1 without output when none of the listed processes exists.
    if (
      args.includes("-p") &&
      errorCode(error) === 1 &&
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      "stderr" in error &&
      error.stdout === "" &&
      error.stderr === ""
    )
      return "";
    throw error;
  }
}

async function readProcTable(): Promise<Map<number, ProcessRow>> {
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const rows = await Promise.all(
    names.map(async (name) => {
      try {
        return parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"));
      } catch (error) {
        // The process exited after the directory listing.
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH")
          return undefined;
        throw error;
      }
    }),
  );
  return new Map(rows.flatMap((row) => (row ? [[row.pid, row] as const] : [])));
}

/**
 * Read one process-table snapshot (macOS: one `ps` run; Linux: `/proc`).
 * Rejects on other platforms and when the table cannot be read completely.
 */
export async function readProcessTable(): Promise<ProcessTable> {
  if (process.platform === "darwin")
    return parsePsRows(await ps(["-A", "-o", PS_COLUMNS], 8 * 1024 * 1024));
  if (process.platform === "linux") return readProcTable();
  throw new Error(`No supported process table on ${process.platform}`);
}

function hasToken(text: string, token: string): boolean {
  return ` ${text} `.includes(` ${token} `);
}

/**
 * Decide whether a macOS process environment carries `token`. `ps -E` prints
 * the arguments and then the environment in one column, so the marker counts
 * only after the arguments read from a second `ps` without `-E`. The second
 * read is `unknown` when the PID now names another process or the arguments
 * changed (exec) between the two reads.
 */
export function environmentCarries(
  withEnvironment: CommandRow,
  argumentsOnly: CommandRow | undefined,
  token: string,
): "marked" | "unmarked" | "unknown" {
  // Absent from the second read: it exited in between.
  if (!argumentsOnly) return "unmarked";
  if (argumentsOnly.started !== withEnvironment.started) return "unknown";
  const args = argumentsOnly.command;
  if (withEnvironment.command === args) return "unmarked";
  if (!withEnvironment.command.startsWith(`${args} `)) return "unknown";
  return hasToken(withEnvironment.command.slice(args.length + 1), token)
    ? "marked"
    : "unmarked";
}

interface MarkerInspection {
  table: ProcessTable;
  marked: Set<number>;
  /** Processes showing the marker whose environment could not be told apart from their arguments. */
  unknown: Set<number>;
}

async function inspectMarker(marker: string): Promise<MarkerInspection> {
  const token = `${WORKER_TREE_ENVIRONMENT}=${marker}`;
  if (process.platform === "linux") {
    const table = await readProcTable();
    const marked = new Set<number>();
    await Promise.all(
      [...table.values()].map(async (row) => {
        if (row.zombie || row.pid === process.pid) return;
        let environ: Buffer;
        try {
          environ = await readFile(`/proc/${row.pid}/environ`);
        } catch (error) {
          // Exited, another user's or a non-dumpable process: not attributable by marker.
          if (
            ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(
              String(errorCode(error)),
            )
          )
            return;
          throw error;
        }
        if (environ.toString("latin1").split("\0").includes(token))
          marked.add(row.pid);
      }),
    );
    return { table, marked, unknown: new Set() };
  }
  if (process.platform === "darwin") {
    const table = parsePsRows(
      await ps(
        ["-E", "-A", "-ww", "-o", `${PS_COLUMNS},command=`],
        64 * 1024 * 1024,
      ),
    );
    const candidates = [...table.values()].filter(
      (row) =>
        !row.zombie && row.pid !== process.pid && hasToken(row.command, token),
    );
    const marked = new Set<number>();
    const unknown = new Set<number>();
    if (candidates.length > 0) {
      const argumentsOnly = parsePsRows(
        await ps(
          [
            "-ww",
            "-o",
            `${PS_COLUMNS},command=`,
            "-p",
            candidates.map((row) => row.pid).join(","),
          ],
          64 * 1024 * 1024,
        ),
      );
      for (const candidate of candidates) {
        const verdict = environmentCarries(
          candidate,
          argumentsOnly.get(candidate.pid),
          token,
        );
        if (verdict === "marked") marked.add(candidate.pid);
        else if (verdict === "unknown") unknown.add(candidate.pid);
      }
    }
    return { table, marked, unknown };
  }
  throw new Error(`No supported process table on ${process.platform}`);
}

/**
 * Live processes reachable from `seeds` by parent chain, seeds included.
 * `self` (this process) and its ancestors are never returned, and the walk
 * never descends through them.
 */
export function ownedProcesses(
  table: ProcessTable,
  seeds: Iterable<number>,
  self = process.pid,
): ProcessRow[] {
  const shielded = new Set<number>();
  for (
    let pid: number | undefined = self;
    pid !== undefined && !shielded.has(pid);
    pid = table.get(pid)?.ppid
  )
    shielded.add(pid);
  const children = new Map<number, number[]>();
  for (const row of table.values()) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const owned = new Map<number, ProcessRow>();
  const pending = [...seeds];
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    const row = table.get(pid);
    if (!row || owned.has(pid) || shielded.has(pid)) continue;
    owned.set(pid, row);
    pending.push(...(children.get(pid) ?? []));
  }
  return [...owned.values()].filter((row) => !row.zombie);
}

/**
 * Every live process of a Worker tree in `table`: the root when
 * `rootVerified`, the members of the root's process group and their
 * descendants. When the root is not verified but its PID is present, the PID
 * (and with it the group ID) may have been reused, so nothing is attributed.
 */
export function workerTree(
  table: ProcessTable,
  root: number,
  rootVerified: boolean,
): TreeProcess[] {
  if (!rootVerified && table.has(root)) return [];
  const seeds = [...table.values()]
    .filter((row) => row.pgid === root)
    .map((row) => row.pid);
  if (rootVerified) seeds.push(root);
  return ownedProcesses(table, seeds).map(({ pid, started }) => ({
    pid,
    started,
  }));
}

interface Survivors {
  owned: ProcessRow[];
  /** Groups whose members in the snapshot are all owned and whose leader is owned. */
  groups: number[];
  unknown: number;
}

async function survivors(
  marker: string,
  recorded: readonly TreeProcess[],
): Promise<Survivors> {
  const inspection = await inspectMarker(marker);
  const seeds = new Set(inspection.marked);
  for (const entry of recorded)
    if (inspection.table.get(entry.pid)?.started === entry.started)
      seeds.add(entry.pid);
  const owned = ownedProcesses(inspection.table, seeds);
  const ownedPids = new Set(owned.map((row) => row.pid));
  const ownGroup = inspection.table.get(process.pid)?.pgid;
  const groups = owned
    .filter(
      (row) =>
        row.pgid === row.pid &&
        row.pgid !== ownGroup &&
        [...inspection.table.values()].every(
          (member) =>
            member.pgid !== row.pgid ||
            member.zombie ||
            ownedPids.has(member.pid),
        ),
    )
    .map((row) => row.pgid);
  return {
    owned,
    groups,
    unknown: [...inspection.unknown].filter((pid) => !ownedPids.has(pid))
      .length,
  };
}

/** Returns false on an unexpected signalling error. */
function deliver(found: Survivors, signal: NodeJS.Signals): boolean {
  for (const target of [
    ...found.groups.map((pgid) => -pgid),
    ...found.owned.map((row) => row.pid),
  ]) {
    try {
      process.kill(target, signal);
    } catch (error) {
      // ESRCH: exited since the snapshot. EPERM: another user's process; the
      // next snapshot still shows it, which keeps the outcome unconfirmed.
      if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM")
        return false;
    }
  }
  return true;
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
 * Each round takes one snapshot (macOS: `ps -E`, plus a second `ps` only when
 * a process shows the marker; Linux: `/proc`), sends SIGTERM and then SIGKILL
 * to the owned survivors, and waits up to `graceMs` for them to exit. With no
 * survivor this is a single snapshot. The `ps` children are bounded by a
 * timeout and killed on expiry.
 *
 * @param input.marker The Worker's owner token, the value of {@link WORKER_TREE_ENVIRONMENT}.
 * @param input.recorded The tree recorded before shutdown; `undefined` when it
 * could not be read, which limits the outcome to `unconfirmed`.
 * @returns `confirmed` only when a final snapshot shows no owned process and
 * nothing unattributable carrying the marker; `unconfirmed` when one survives
 * or a snapshot cannot be read; `failed` on an unexpected signalling error.
 * Undetectable survivors (see the module notes) do not change the outcome.
 */
export async function reclaimTreeSurvivors(input: {
  marker: string;
  recorded: readonly TreeProcess[] | undefined;
  graceMs: number;
}): Promise<CleanupStatus> {
  const scan = () =>
    survivors(input.marker, input.recorded ?? []).catch(
      // An unreadable process table cannot prove absence; ownership stays quarantined.
      () => undefined,
    );
  const settled = (found: Survivors) =>
    found.owned.length === 0 && found.unknown === 0;
  let found = await scan();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!found) return "unconfirmed";
    if (settled(found)) break;
    if (!deliver(found, signal)) return "failed";
    const deadline = Date.now() + input.graceMs;
    while (found.owned.some((row) => alive(row.pid)) && Date.now() < deadline)
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    found = await scan();
  }
  return found && settled(found) && input.recorded !== undefined
    ? "confirmed"
    : "unconfirmed";
}
