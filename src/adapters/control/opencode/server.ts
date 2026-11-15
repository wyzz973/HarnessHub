import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import type { CleanupEvidence, ControlLaunch, ControlOptions } from "../../../contracts/control.js";
import { HOST_BUDGET_BOUNDS, type HostCleanup, type HostCloseEvidence } from "../../../contracts/native-host.js";
import type { OutsideProcess } from "../../../contracts/session.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { POSIX_SHUTDOWN_PROBES, confirmOutside, quiesce } from "../../../infrastructure/control/host-shutdown.js";
import { darwinExitedGroupIsQuiescent } from "../../../infrastructure/control/process-group.js";

const RECENT_STDERR_BYTES = 32 * 1024;
/** `serve --stdio` says where it listens in one JSON line; older builds print `server listening on <url>`. */
const LISTENING = /server listening on (https?:\/\/\S+)/u;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function code(error: unknown): unknown { return error !== null && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined; }

/**
 * The Hub's own `opencode serve --stdio --hostname 127.0.0.1 --port 0` (research of 2026-11-14 §8.1): one process group, spawned detached, with a random
 * password of this process's alone (OPENCODE_PASSWORD, never written anywhere; the inherited OpenCode 1 variable dropped). Its lifetime is its stdin:
 * closing it is the request to leave, and the group is signalled only after the grace (ADR-056 §4.11), as every host is.
 */
export class OpenCodeServer {
  readonly password = randomBytes(32).toString("base64url");
  private child: ChildProcessWithoutNullStreams | null = null;
  private pid: number | null = null;
  private starting: Promise<string> | null = null;
  private failed: Error | null = null;
  private closing = false;
  private closeObserved = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private quiet: Promise<{ readonly cleanup: HostCleanup; readonly found: readonly OutsideProcess[] | null }> | null = null;
  private cleanup: Promise<CleanupEvidence> | null = null;
  private evidence: Promise<HostCloseEvidence> | null = null;
  private diagnostic = Buffer.alloc(0);
  private recentStderr = Buffer.alloc(0);
  private stderrBytes = 0;
  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions, private readonly onFailure: (error: Error) => void) {
    if (!isAbsolute(launch.executable) || !isAbsolute(options.cwd)) throw new ControlError("INVALID_INPUT", "executable and cwd must be absolute paths");
    for (const argument of launch.args) if (typeof argument !== "string" || argument.includes("\0")) throw new ControlError("INVALID_INPUT", "invalid process argument");
  }
  get failure(): Error | null { return this.failed; }
  get processGroup(): number | null { return this.pid; }
  get stderrMark(): number { return this.stderrBytes; }
  stderrSince(mark: number): string {
    const kept = Math.min(this.recentStderr.length, Math.max(0, this.stderrBytes - mark));
    return this.recentStderr.subarray(this.recentStderr.length - kept).toString("utf8");
  }
  get diagnostics(): string { return this.diagnostic.toString("utf8"); }
  /** Starts the server once and resolves with its loopback address. */
  start(timeoutMs: number): Promise<string> {
    this.starting ??= this.spawnOnce(timeoutMs);
    return this.starting;
  }
  private spawnOnce(timeoutMs: number): Promise<string> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new ControlError("CLOSED", "connection is closed"));
    if (process.platform === "win32") return Promise.reject(new ControlError("UNSUPPORTED_PLATFORM", "this control slice requires POSIX process groups"));
    const env: Record<string, string> = { ...this.options.env, ...this.launch.env, OPENCODE_PASSWORD: this.password };
    delete env.OPENCODE_SERVER_PASSWORD;
    const child = spawn(this.launch.executable, [...this.launch.args], { cwd: this.options.cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.pid = child.pid ?? null;
    return new Promise<string>((resolve, reject) => {
      let line = "", settled = false;
      const done = (error: Error | null, url?: string) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { this.abort(error); reject(error); } else resolve(url!); };
      const timer = setTimeout(() => done(new ControlError("NATIVE_INITIALIZE_TIMEOUT", "OpenCode server did not say where it listens")), timeoutMs);
      child.on("error", error => done(new ControlError("PROCESS_ERROR", error.message)));
      child.stdin.on("error", error => this.abort(new ControlError("WRITE_FAILED", error.message)));
      child.stdout.on("error", error => this.abort(new ControlError("READ_FAILED", error.message)));
      child.stderr.on("error", error => this.abort(new ControlError("READ_FAILED", error.message)));
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        line += chunk.toString("utf8");
        for (let at = line.indexOf("\n"); at >= 0 && !settled; at = line.indexOf("\n")) {
          const head = line.slice(0, at).trim(); line = line.slice(at + 1);
          const url = this.address(head);
          if (url !== null) done(null, url);
        }
        if (line.length > 64 * 1024) done(new ControlError("INVALID_PROTOCOL", "OpenCode server printed no address"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const room = this.options.maxDiagnosticBytes - this.diagnostic.length;
        if (room > 0) this.diagnostic = Buffer.concat([this.diagnostic, chunk.subarray(0, room)]);
        this.stderrBytes += chunk.length;
        const recent = Buffer.concat([this.recentStderr, chunk]);
        this.recentStderr = recent.length > RECENT_STDERR_BYTES ? recent.subarray(recent.length - RECENT_STDERR_BYTES) : recent;
      });
      child.on("exit", (exit, signal) => {
        this.exitCode = exit; this.exitSignal = signal;
        if (!this.closing) { const error = this.exitFailure(exit ?? signal); done(error); this.abort(error); }
      });
      child.on("close", (exit, signal) => {
        this.closeObserved = true; this.exitCode = exit; this.exitSignal = signal;
        if (!this.closing) this.abort(new ControlError("PROCESS_EXITED", "OpenCode server closed unexpectedly"));
      });
    });
  }
  /** The loopback URL a line names; anything else (another host, a non-URL) is no address. */
  private address(text: string): string | null {
    let url: string | undefined;
    try { const parsed: unknown = JSON.parse(text); if (parsed !== null && typeof parsed === "object" && typeof (parsed as { url?: unknown }).url === "string") url = (parsed as { url: string }).url; }
    catch { url = LISTENING.exec(text)?.[1]; }
    if (url === undefined) return null;
    try { const parsed = new URL(url); return (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname)) ? parsed.origin : null; } catch { return null; }
  }
  private exitFailure(status: number | NodeJS.Signals | null): ControlError {
    if (/config(?:uration)? is invalid|ConfigInvalidError/iu.test(this.diagnostics)) return new ControlError("NATIVE_CONFIGURATION_INVALID", "OpenCode rejected its local configuration; run its own doctor");
    return new ControlError("PROCESS_EXITED", `OpenCode server exited (${status})`);
  }
  /** A failure of the connection: said once to the owner, and the group is closed. */
  abort(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = error;
    try { this.onFailure(error); } catch { /* the original failure stays authoritative */ }
    void this.close().catch(() => {});
  }
  close(): Promise<CleanupEvidence> { this.begin(false); return this.cleanup!; }
  closeEvidence(signal?: AbortSignal): Promise<HostCloseEvidence> {
    this.begin(true);
    this.evidence ??= this.quiet!.then(async closed => ({ cleanup: closed.cleanup,
      outside: await confirmOutside(closed.found, this.options.closeOutsideWaitMs ?? HOST_BUDGET_BOUNDS.closeOutsideWaitMs.fallback, POSIX_SHUTDOWN_PROBES.running, signal) }));
    return this.evidence;
  }
  private begin(sample: boolean): void {
    if (this.cleanup) return;
    this.closing = true;
    const quiet = Promise.resolve().then(() => this.closeOwned(sample));
    this.quiet = quiet;
    this.cleanup = quiet.then(closed => ({ closed: true, exitCode: closed.cleanup.exitCode, signal: closed.cleanup.signal, protocolFailure: closed.cleanup.protocolFailure }));
    void this.cleanup.catch(() => {});
  }
  private groupAlive(): boolean {
    if (this.pid === null) return false;
    try { process.kill(-this.pid, 0); return true; }
    catch (error) { if (code(error) === "ESRCH") return false; if (code(error) === "EPERM" && this.closeObserved) return !darwinExitedGroupIsQuiescent(this.pid); throw error; }
  }
  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pid === null) return;
    try { process.kill(-this.pid, signal); }
    catch (error) { if (code(error) !== "ESRCH" && !(code(error) === "EPERM" && this.closeObserved)) throw error; }
  }
  private async closeOwned(sample: boolean): Promise<{ readonly cleanup: HostCleanup; readonly found: readonly OutsideProcess[] | null }> {
    const child = this.child;
    const failure = this.failed === null ? null : { code: this.failed instanceof ControlError ? this.failed.code.slice(0, 128) : "CONTROL_FAILED", message: this.failed.message.slice(0, 512) };
    if (!child) return { cleanup: { closed: true, exitCode: null, signal: null, protocolFailure: failure, stage: null, closeMs: 0 }, found: null };
    const chain = await quiesce({ group: this.pid, leaderRunning: () => this.exitCode === null && this.exitSignal === null, endInput: () => child.stdin.end(),
      quiescent: () => this.closeObserved && !this.groupAlive(), signal: signal => this.signalGroup(signal) }, this.options.closeGraceMs, sample ? POSIX_SHUTDOWN_PROBES.outsiders : undefined);
    if (!chain.quiescent) throw new ControlError("CLEANUP_FAILED", "owned process group or streams did not close within the cleanup budget");
    return { cleanup: { closed: true, exitCode: this.exitCode, signal: this.exitSignal, protocolFailure: failure, stage: chain.stage, closeMs: chain.closeMs }, found: chain.found };
  }
}
