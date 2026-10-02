// SPDX-License-Identifier: MIT
/**
 * Bounded POSIX process-table snapshots for Worker cleanup.
 *
 * macOS: `/bin/ps`. Linux: `/proc`, read by a short-lived child
 * (`proc-scan-main.ts`). Every snapshot runs in a child process with a
 * deadline, an output limit and SIGKILL, and the caller is released at the
 * deadline even if the child cannot exit yet; the Gateway itself never
 * performs a read that can block on another process.
 *
 * Errors are {@link ProcessTableError}s whose message is a fixed reason (exit
 * status, signal, errno code). They never carry the child's output, which for
 * `ps -E` holds the environment, including credentials, of every process of
 * this user.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKER_TREE_ENVIRONMENT } from "../domain/environment.js";
import type { ProcessRow } from "./proc-scan.js";

export type { ProcessRow } from "./proc-scan.js";
/** A macOS `ps` row whose last column is the command (with `-E`, followed by the environment). */
export interface CommandRow extends ProcessRow {
  readonly command: string;
}
/** Processes of one snapshot by PID. */
export type ProcessTable = ReadonlyMap<number, ProcessRow>;
/** One snapshot plus the number of listed processes whose records were unreadable. */
export interface ProcessSnapshot {
  table: ProcessTable;
  hidden: number;
}
/** A snapshot with the processes whose environment carries a tree marker. */
export interface MarkerSnapshot extends ProcessSnapshot {
  marked: Set<number>;
  /** Processes showing the marker whose environment could not be told apart from their arguments. */
  unknown: Set<number>;
}

/** A failed snapshot. The message is a fixed reason and never contains process output. */
export class ProcessTableError extends Error {
  override readonly name = "ProcessTableError";
}

/** Deadline of one snapshot child, after which it is killed with SIGKILL. */
export const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const PS_COLUMNS = "pid=,ppid=,pgid=,uid=,ruid=,stat=,lstart=";
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*?))?\s*$/;
const SCANNER = fileURLToPath(new URL("./proc-scan-main.js", import.meta.url));

/** Exit of a bounded child; `stdout` is complete and at most `maxBuffer` bytes. */
export interface BoundedExit {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrBytes: number;
}

/**
 * Run `file` with no shell and settle by `timeoutMs`. On expiry or when stdout
 * exceeds `maxBuffer`, the child gets SIGKILL and the promise rejects at once,
 * without waiting for an exit that a read blocked in the kernel can delay; the
 * child's streams are destroyed and its handle unreferenced so it cannot keep
 * the caller alive. Stderr is counted, never kept.
 */
export function runBounded(
  label: string,
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<BoundedExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new ProcessTableError(`${label} ${reason}`));
    };
    const timer = setTimeout(
      () => fail(`timed out after ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > options.maxBuffer) fail("output exceeded its limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
    });
    // Stream errors surface as a failed exit below.
    child.stdout.on("error", () => undefined);
    child.stderr.on("error", () => undefined);
    child.once("error", (error) => {
      const code =
        "code" in error && typeof error.code === "string"
          ? error.code
          : "unknown";
      fail(`could not run (${code})`);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderrBytes,
      });
    });
  });
}

async function ps(args: string[]): Promise<string> {
  const exit = await runBounded("ps", "/bin/ps", args, {
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    maxBuffer: SNAPSHOT_MAX_BYTES,
    // C locale and UTC keep `lstart` comparable across reads.
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC0" },
  });
  if (exit.status === 0) return exit.stdout;
  // `ps -p` exits 1 without output when none of the listed processes exists.
  if (
    args.includes("-p") &&
    exit.status === 1 &&
    exit.stdout === "" &&
    exit.stderrBytes === 0
  )
    return "";
  throw new ProcessTableError(`ps exited with ${exit.status ?? exit.signal}`);
}

/**
 * Parse macOS `ps -o pid=,ppid=,pgid=,uid=,ruid=,stat=,lstart=[,command=]`
 * output produced with `LC_ALL=C`. Throws on any row it cannot read, so an
 * unexpected format fails the inspection instead of hiding a process.
 */
export function parsePsRows(output: string): Map<number, CommandRow> {
  const rows = new Map<number, CommandRow>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = PS_ROW.exec(line);
    if (!match) throw new ProcessTableError("ps printed an unexpected row");
    const pid = Number(match[1]);
    rows.set(pid, {
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      uid: Number(match[4]),
      ruid: Number(match[5]),
      zombie: match[6]!.startsWith("Z"),
      started: match[7]!.replace(/\s+/g, " "),
      command: match[8] ?? "",
    });
  }
  return rows;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Validate the scanner child's output; see `proc-scan-main.ts`. */
export function parseProcScanOutput(output: string): {
  rows: ProcessRow[];
  marked: number[];
  hidden: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new ProcessTableError("proc scan printed invalid output");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("rows" in value) ||
    !Array.isArray(value.rows) ||
    !("marked" in value) ||
    !Array.isArray(value.marked) ||
    !value.marked.every(integer) ||
    !("hidden" in value) ||
    !integer(value.hidden)
  )
    throw new ProcessTableError("proc scan printed invalid output");
  const rows = value.rows.map((entry: unknown): ProcessRow => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 7 ||
      !entry.slice(0, 5).every(integer) ||
      (entry[5] !== 0 && entry[5] !== 1) ||
      typeof entry[6] !== "string" ||
      !/^\d+$/.test(entry[6])
    )
      throw new ProcessTableError("proc scan printed invalid output");
    const [pid, ppid, pgid, uid, ruid, zombie, started] = entry as [
      number,
      number,
      number,
      number,
      number,
      number,
      string,
    ];
    return { pid, ppid, pgid, uid, ruid, zombie: zombie === 1, started };
  });
  return { rows, marked: value.marked, hidden: value.hidden };
}

async function procScan(token?: string) {
  const exit = await runBounded(
    "proc scan",
    process.execPath,
    [SCANNER, ...(token === undefined ? [] : [`--token=${token}`])],
    { timeoutMs: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_BYTES, env: {} },
  );
  if (exit.status === 0) return parseProcScanOutput(exit.stdout);
  let failure = "";
  if (exit.status === 2) {
    const match = /^\{"failure":"([A-Za-z0-9_]{1,32})"\}$/.exec(exit.stdout);
    if (match) failure = ` (${match[1]})`;
  }
  throw new ProcessTableError(
    `proc scan exited with ${exit.status ?? exit.signal}${failure}`,
  );
}

/**
 * Read one process-table snapshot. Rejects with a {@link ProcessTableError}
 * on other platforms and whenever the table cannot be read completely.
 */
export async function readProcessTable(): Promise<ProcessSnapshot> {
  if (process.platform === "darwin")
    return {
      table: parsePsRows(await ps(["-A", "-o", PS_COLUMNS])),
      hidden: 0,
    };
  if (process.platform === "linux") {
    const scan = await procScan();
    return {
      table: new Map(scan.rows.map((row) => [row.pid, row])),
      hidden: scan.hidden,
    };
  }
  throw new ProcessTableError(`no process table on ${process.platform}`);
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
  // Absent from the second read, or a zombie there: it exited in between.
  if (!argumentsOnly || argumentsOnly.zombie) return "unmarked";
  if (argumentsOnly.started !== withEnvironment.started) return "unknown";
  const args = argumentsOnly.command;
  if (withEnvironment.command === args) return "unmarked";
  if (!withEnvironment.command.startsWith(`${args} `)) return "unknown";
  return hasToken(withEnvironment.command.slice(args.length + 1), token)
    ? "marked"
    : "unmarked";
}

/**
 * Read one snapshot together with the processes whose environment carries
 * `WORKER_TREE_ENVIRONMENT=marker`. macOS: `ps -E -A -ww`, plus a second `ps`
 * without `-E` only for processes that show the marker text. Linux: the
 * `/proc` scan reads each environment exactly.
 */
export async function readMarkerSnapshot(
  marker: string,
): Promise<MarkerSnapshot> {
  const token = `${WORKER_TREE_ENVIRONMENT}=${marker}`;
  if (process.platform === "linux") {
    const scan = await procScan(token);
    return {
      table: new Map(scan.rows.map((row) => [row.pid, row])),
      hidden: scan.hidden,
      marked: new Set(scan.marked),
      unknown: new Set(),
    };
  }
  if (process.platform !== "darwin")
    throw new ProcessTableError(`no process table on ${process.platform}`);
  const table = parsePsRows(
    await ps(["-E", "-A", "-ww", "-o", `${PS_COLUMNS},command=`]),
  );
  const candidates = [...table.values()].filter(
    (row) => !row.zombie && hasToken(row.command, token),
  );
  const marked = new Set<number>();
  const unknown = new Set<number>();
  if (candidates.length > 0) {
    const argumentsOnly = parsePsRows(
      await ps([
        "-ww",
        "-o",
        `${PS_COLUMNS},command=`,
        "-p",
        candidates.map((row) => row.pid).join(","),
      ]),
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
  return { table, hidden: 0, marked, unknown };
}
