import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { ManagementError, type ManagementInstallContext, type ManagementRecipe, type NativeInstallPlan, type ProgramEntry, type ProgramUsage, type UsedService } from "../../contracts/management.js";
import { runManagementProcess } from "./process.js";

/** The host commands one inspection or restart reads (ADR-043); replaced in tests. Outputs stay in memory and are never logged. */
export interface ProgramHost {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  /** This process: it and its descendants are HarnessHub's own and never listed as other programs. */
  readonly self: number;
  /** `ps -axw -o pid=,ppid=,command=`: one bounded command line per process. */
  processes(context: ManagementInstallContext): Promise<string>;
  /** `launchctl list`: the jobs of this user's domain. */
  jobs(context: ManagementInstallContext): Promise<string>;
  /** `launchctl list <label>`: one job's program and arguments, without its environment; null when no such job is loaded. */
  job(label: string, context: ManagementInstallContext): Promise<string | null>;
  /** `launchctl print <target>`: one job's state; null when the target is unknown. Only top-level fields are read. */
  print(target: string, context: ManagementInstallContext): Promise<string | null>;
  /** `launchctl kickstart -k <target>`. */
  kickstart(target: string, context: ManagementInstallContext): Promise<void>;
  /** `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn`, within five seconds; empty when it listens on nothing. */
  listening(pid: number, context: ManagementInstallContext): Promise<string>;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  now(): number;
}
export interface RestartTiming { readonly pollMs: number; readonly stableMs: number; readonly deadlineMs: number }
export const RESTART_TIMING: RestartTiming = { pollMs: 500, stableMs: 5000, deadlineMs: 60000 };
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python[0-9.]*|ruby|perl|sh|bash|zsh)$/u;
const MAX_JOBS = 256, MAX_ARGUMENTS = 8;

/** Process rows of `ps -axw -o pid=,ppid=,command=`; null when the table cannot be read. */
export function parseProcessTable(text: string): readonly { readonly pid: number; readonly ppid: number; readonly command: string }[] | null {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) return null;
  const rows: { pid: number; ppid: number; command: string }[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return null;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() });
  }
  return rows;
}
/** Running jobs of `launchctl list` (`PID Status Label`); jobs without a process are left out. */
export function parseJobs(text: string): readonly { readonly pid: number; readonly label: string }[] {
  const rows: { pid: number; label: string }[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(\d+)\t\S+\t([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/u.exec(line);
    if (match) rows.push({ pid: Number(match[1]), label: match[2]! });
  }
  return rows;
}
function unquote(value: string): string { return value.replace(/\\(.)/gu, "$1"); }
/** The process, program and arguments of `launchctl list <label>`. */
export function parseJob(text: string): { readonly pid: number | null; readonly program: string | null; readonly args: readonly string[] } {
  const pid = /^\s*"PID" = (\d+);$/mu.exec(text), program = /^\s*"Program" = "((?:[^"\\]|\\.)*)";$/mu.exec(text);
  const block = /^\s*"ProgramArguments" = \($([\s\S]*?)^\s*\);$/mu.exec(text);
  const args: string[] = [];
  if (block) for (const match of block[1]!.matchAll(/^\s*"((?:[^"\\]|\\.)*)";$/gmu)) { if (args.length >= 64) break; args.push(unquote(match[1]!)); }
  return { pid: pid ? Number(pid[1]) : null, program: program ? unquote(program[1]!) : null, args };
}
/** The top-level `state`, `pid` and `runs` of `launchctl print <target>`; nested blocks (resources, environment) are ignored. */
export function parseServiceState(text: string): { readonly state: string | null; readonly pid: number | null; readonly runs: number | null } {
  const field = (name: string): string | null => new RegExp("^\\t" + name + " = ([^\\n]*)$", "mu").exec(text)?.[1]?.trim() ?? null;
  const pid = field("pid"), runs = field("runs");
  return { state: field("state"), pid: pid !== null && /^\d+$/u.test(pid) ? Number(pid) : null, runs: runs !== null && /^\d+$/u.test(runs) ? Number(runs) : null };
}
/** The TCP ports in `lsof -Fn` listening output. */
export function parseListening(text: string): readonly number[] {
  const ports: number[] = [];
  for (const line of text.split(/\r?\n/u)) { const match = /^n.*:(\d{1,5})$/u.exec(line); if (match) ports.push(Number(match[1])); }
  return ports;
}
/** The port an argument list gives for `flag` (`--port 18789` or `--port=18789`); null when it gives none. */
export function portArgument(args: readonly string[], flag: string): number | null {
  for (let index = 0; index < args.length; index++) {
    const value = args[index] === flag ? args[index + 1] : args[index]!.startsWith(flag + "=") ? args[index]!.slice(flag.length + 1) : undefined;
    if (value !== undefined && /^\d{1,5}$/u.test(value) && Number(value) > 0 && Number(value) < 65536) return Number(value);
  }
  return null;
}
/** A program's base name for the user: the script for an interpreter, never arguments or directories. */
export function programName(command: string): string {
  const [first = "", second] = command.split(/\s+/u);
  const name = INTERPRETERS.test(basename(first)) && second !== undefined && isAbsolute(second) ? basename(second) : basename(first);
  return /^[A-Za-z0-9._@+-]{1,64}$/u.test(name) ? name : "program";
}
/** The paths that belong to this installation: its entry, the program it resolves to, and its package's directory. */
export function installationRoots(plan: NativeInstallPlan): readonly string[] {
  const roots = [plan.entry, plan.actualEntry];
  switch (plan.channel) {
    case "npm": roots.push(join(plan.prefix, "lib", "node_modules", plan.reference)); break;
    case "brew-formula": roots.push(join(plan.prefix, "Cellar", plan.reference), join(plan.prefix, "opt", plan.reference)); break;
    case "brew-cask": roots.push(join(plan.prefix, "Caskroom", plan.reference)); break;
    case "uv": roots.push(join(plan.prefix, plan.reference)); break;
    case "archive": roots.push(join(plan.prefix, "share", "harnesses", plan.harnessId)); break;
    case "native-cli": roots.push(plan.prefix); break;
    case "unsupported": break;
  }
  return [...new Set(roots.filter(path => path !== "" && isAbsolute(path)))];
}
function within(path: string, roots: readonly string[]): boolean { return roots.some(root => path === root || path.startsWith(root + "/")); }
/** Whether a command line names a path in `root`: the root itself or below it, not another file that shares its prefix. */
function mentions(command: string, root: string): boolean {
  for (let index = command.indexOf(root); index !== -1; index = command.indexOf(root, index + 1)) {
    const next = command[index + root.length];
    if (next === undefined || next === "/" || /\s/u.test(next)) return true;
  }
  // A narrow `ps -w` column cuts long command lines: a line that ends partway through the root still names it.
  const tail = command.slice(command.lastIndexOf(" ") + 1);
  return tail.length >= 24 && tail.length < root.length && root.startsWith(tail);
}
async function resolved(path: string): Promise<string | null> { try { return await realpath(path); } catch { return null; } }
async function jobRunsInstallation(job: ReturnType<typeof parseJob>, roots: readonly string[]): Promise<boolean> {
  for (const path of [job.program, ...job.args.slice(0, MAX_ARGUMENTS)]) {
    if (path === null || !isAbsolute(path)) continue;
    if (within(path, roots)) return true;
    const target = await resolved(path); if (target !== null && within(target, roots)) return true;
  }
  return false;
}
/**
 * The programs running one native installation, read once and never signalled (ADR-043). On macOS the user's launchd
 * jobs whose program or first arguments lie in the installation are its services; elsewhere services are not known and
 * every program is a plain process. Programs this process started are HarnessHub's own and left out.
 */
export async function inspectProgramUsage(plan: NativeInstallPlan, recipe: ManagementRecipe, host: ProgramHost, context: ManagementInstallContext): Promise<ProgramUsage> {
  const roots = installationRoots(plan), table = parseProcessTable(await host.processes(context));
  if (table === null) throw new ManagementError("PROCESS_INSPECTION_FAILED", "the process table could not be read");
  const children = new Map<number, number[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const own = new Set<number>([host.self]);
  let level = [host.self];
  for (let depth = 0; level.length && depth < 64; depth++) {
    const next: number[] = [];
    for (const pid of level) for (const child of children.get(pid) ?? []) if (!own.has(child)) { own.add(child); next.push(child); }
    level = next;
  }
  const services: UsedService[] = [];
  if (host.platform === "darwin") {
    const jobs = parseJobs(await host.jobs(context)).filter(job => !job.label.startsWith("com.apple.")).slice(0, MAX_JOBS);
    for (const job of jobs) {
      if (own.has(job.pid)) continue;
      const text = await host.job(job.label, context); if (text === null) continue;
      const details = parseJob(text); if (details.pid !== job.pid || !await jobRunsInstallation(details, roots)) continue;
      let target: string | null = null;
      for (const domain of ["gui/" + host.uid, "user/" + host.uid]) if (await host.print(domain + "/" + job.label, context) !== null) { target = domain + "/" + job.label; break; }
      if (target === null) continue;
      const declared = recipe.services?.find(service => service.label === job.label) ?? null;
      services.push({ label: job.label, pid: job.pid, target, port: declared?.portFlag === undefined ? null : portArgument(details.args, declared.portFlag),
        program: details.program ?? details.args[0] ?? null, declared });
    }
  }
  const servicePids = new Set(services.map(service => service.pid)), names = new Set(recipe.processNames ?? []);
  const resident: ProgramEntry[] = [], processes: ProgramEntry[] = [];
  for (const row of table) {
    if (own.has(row.pid) || servicePids.has(row.pid)) continue;
    const name = programName(row.command);
    if (names.has(basename(row.command.split(/\s+/u, 1)[0]!))) { resident.push({ pid: row.pid, name }); continue; }
    if (roots.some(root => mentions(row.command, root))) processes.push({ pid: row.pid, name });
  }
  return { servicesKnown: host.platform === "darwin", services, resident: resident.slice(0, 64), processes: processes.slice(0, 64) };
}
/**
 * Restarts one running service with `launchctl kickstart -k` and waits until it runs again (ADR-043); resolves null,
 * restarting nothing, when it no longer runs. Running again means `state = running` under a
 * new process that stays the same for `stableMs`, launched once since the restart, within `deadlineMs`. A service with a
 * known port is ready once it listened on it at some point in that window; one that runs but never listened resolves with
 * `ready: false`. Rejects with SERVICE_RESTART_FAILED when the service manager refuses the restart and
 * SERVICE_NOT_RECOVERED when it does not run again.
 */
export async function restartProgramService(service: UsedService, host: ProgramHost, context: ManagementInstallContext, timing: RestartTiming = RESTART_TIMING): Promise<{ readonly pid: number; readonly ready: boolean | null } | null> {
  const before = await host.print(service.target, context), current = before === null ? null : parseServiceState(before);
  // A service that stopped since it was agreed to is left stopped: restarting it would start something the user did not run.
  if (current === null || current.state !== "running") return null;
  const runs = current.runs;
  try { await host.kickstart(service.target, context); }
  catch (error) { if (error instanceof ManagementError && error.code === "PROCESS_FAILED") throw new ManagementError("SERVICE_RESTART_FAILED", "the service manager refused to restart " + service.label); throw error; }
  const start = host.now();
  let stable = null as { readonly pid: number; readonly since: number } | null, listened = false;
  while (host.now() - start < timing.deadlineMs) {
    context.assertOwned();
    const text = await host.print(service.target, context), state = text === null ? null : parseServiceState(text);
    const pid = state?.state === "running" ? state.pid : null;
    if (pid !== null && pid !== service.pid && (runs === null || state!.runs === null || state!.runs <= runs + 1)) {
      if (stable?.pid !== pid) stable = { pid, since: host.now() };
      if (service.port !== null && !listened) listened = parseListening(await host.listening(pid, context)).includes(service.port);
      if (host.now() - stable.since >= timing.stableMs && (service.port === null || listened)) return { pid, ready: service.port === null ? null : true };
    } else stable = null;
    await host.sleep(timing.pollMs, context.signal);
  }
  // Running and stable, but it never listened on its port in the window: the caller reports it as not ready.
  if (stable !== null && host.now() - stable.since >= timing.stableMs) return { pid: stable.pid, ready: false };
  throw new ManagementError("SERVICE_NOT_RECOVERED", service.label + " did not run again within " + timing.deadlineMs / 1000 + " seconds");
}
function quiet(context: ManagementInstallContext, signal = context.signal): ManagementInstallContext { return { stage: context.stage, signal, assertOwned: context.assertOwned, log: () => {} }; }
const HOST_ENV = { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
async function optional(run: () => Promise<string>): Promise<string | null> {
  try { return await run(); } catch (error) { if (error instanceof ManagementError && error.code === "PROCESS_FAILED") return null; throw error; }
}
/** The real host: `/bin/ps`, `/bin/launchctl` and `/usr/sbin/lsof`, each owned and bounded like every management process. */
export function systemProgramHost(): ProgramHost {
  const run = (executable: string, args: readonly string[], context: ManagementInstallContext, signal?: AbortSignal) =>
    runManagementProcess(executable, args, context.stage, HOST_ENV, quiet(context, signal), 4 * 1024 * 1024);
  return {
    platform: process.platform, uid: process.getuid?.() ?? -1, self: process.pid,
    processes: context => run("/bin/ps", ["-axw", "-o", "pid=,ppid=,command="], context),
    jobs: context => run("/bin/launchctl", ["list"], context),
    job: (label, context) => optional(() => run("/bin/launchctl", ["list", label], context)),
    print: (target, context) => optional(() => run("/bin/launchctl", ["print", target], context)),
    kickstart: async (target, context) => { await run("/bin/launchctl", ["kickstart", "-k", target], context); },
    listening: async (pid, context) => {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
      try { return await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], context, signal); }
      catch (error) { if (error instanceof ManagementError && (error.code === "PROCESS_FAILED" || error.code === "CANCELLED" && !context.signal.aborted)) return ""; throw error; }
    },
    sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(new ManagementError("CANCELLED", "native maintenance was cancelled")); return; }
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
      const stop = () => { clearTimeout(timer); reject(new ManagementError("CANCELLED", "native maintenance was cancelled")); };
      signal.addEventListener("abort", stop, { once: true });
    }),
    now: () => performance.now(),
  };
}
