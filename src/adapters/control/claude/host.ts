import { spawn, type ChildProcess } from "node:child_process";
import { query, type Options, type Query, type SDKUserMessage, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { CleanupEvidence } from "../../../contracts/control.js";
import { quiesce } from "../../../infrastructure/control/host-shutdown.js";
import { ControlError, errorFrom } from "../../../infrastructure/control/json-rpc-process.js";
import { darwinExitedGroupIsQuiescent } from "../../../infrastructure/control/process-group.js";

/** How much of the program's latest stderr stays readable for a Turn's diagnostics. */
const RECENT_STDERR_BYTES = 32 * 1024;

export interface ProcessEvents {
  /** One message of the query, as the SDK hands it (its types stay here and in the driver). */
  message(message: Readonly<Record<string, unknown>>): void;
  /** The query ended: null when it was asked to (close), else why. */
  ended(error: Error | null): void;
}

/**
 * One `claude` process of one session, driven by the Agent SDK in streaming-input mode (research of 2026-11-14 §2): the SDK speaks to it, and
 * this owns it. It is spawned as the leader of its own process group (the SDK's `spawnClaudeCodeProcess`), its stderr is kept in a bounded
 * window, and its close is the Hub's close chain (ADR-056 §4.11): the input ends first, so Claude Code leaves on its own, and its group is
 * signalled only after the grace. Messages are handed on in order; one the consumer cannot take ends the process.
 */
export class ClaudeProcess {
  readonly query: Query;
  /** The initialize answer (models, commands, account, the CLI's capabilities); rejects when the process cannot start. */
  readonly ready: Promise<Readonly<Record<string, unknown>>>;
  private child: ChildProcess | null = null;
  private pid: number | null = null;
  private exited = false;
  private streamsClosed = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private inputEnded = false;
  private recent = Buffer.alloc(0);
  private stderrBytes = 0;
  private closing: Promise<CleanupEvidence> | null = null;
  private failure: Error | null = null;

  constructor(options: Omit<Options, "spawnClaudeCodeProcess">, private readonly closeGraceMs: number, private readonly events: ProcessEvents) {
    this.query = query({ prompt: this.input(), options: { ...options, spawnClaudeCodeProcess: spawnOptions => this.spawn(spawnOptions) } });
    this.ready = this.query.initializationResult().then(value => value as unknown as Readonly<Record<string, unknown>>);
    void this.ready.catch(() => {});
    void this.pump();
  }
  get processGroup(): number | null { return this.pid; }
  get stderrMark(): number { return this.stderrBytes; }
  stderrSince(mark: number): string {
    const kept = Math.min(this.recent.length, Math.max(0, this.stderrBytes - mark));
    return this.recent.subarray(this.recent.length - kept).toString("utf8");
  }
  /** Whether the process can still take a message: not closing, not failed, not exited. */
  get alive(): boolean { return this.closing === null && this.failure === null && !this.exited && !this.inputEnded; }
  get failed(): Error | null { return this.failure; }
  /** Hands Claude Code one user message (a prompt, a steer, a command); the SDK writes it to the process in order. */
  send(message: SDKUserMessage): void {
    if (!this.alive) throw this.failure ?? new ControlError("CLOSED", "the Claude Code process is closed");
    this.queue.push(message); this.wake?.();
  }
  private async *input(): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      while (this.queue.length === 0 && !this.inputEnded) await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = null;
      if (this.queue.length === 0) return;
      yield this.queue.shift()!;
    }
  }
  private spawn(options: SpawnOptions): SpawnedProcess {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) if (typeof value === "string") env[name] = value;
    const child = spawn(options.command, options.args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child = child; this.pid = child.pid ?? null;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      const joined = Buffer.concat([this.recent, chunk]);
      this.recent = joined.length > RECENT_STDERR_BYTES ? joined.subarray(joined.length - RECENT_STDERR_BYTES) : joined;
    });
    child.stderr?.on("error", () => {});
    child.on("exit", (code, signal) => { this.exited = true; this.exitCode = code; this.exitSignal = signal; });
    child.on("close", () => { this.exited = true; this.streamsClosed = true; });
    // The SDK aborts this only after its own grace (stdin closed, about 2 s): the group then goes, not only the leader.
    options.signal.addEventListener("abort", () => this.signalGroup("SIGTERM"), { once: true });
    return child as unknown as SpawnedProcess;
  }
  private async pump(): Promise<void> {
    let error: Error | null = null;
    try { for await (const message of this.query) this.events.message(message as unknown as Readonly<Record<string, unknown>>); }
    catch (thrown) { error = errorFrom(thrown); }
    if (this.closing === null && error === null) error = new ControlError("PROCESS_EXITED", "Claude Code ended its session process");
    if (this.closing === null) this.failure = error;
    this.inputEnded = true; this.wake?.();
    try { this.events.ended(this.closing === null ? error : null); } catch { /* the original end stands */ }
  }
  private groupAlive(): boolean {
    if (this.pid === null) return false;
    try { process.kill(-this.pid, 0); return true; }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM" && this.streamsClosed) return !darwinExitedGroupIsQuiescent(this.pid);
      throw error;
    }
  }
  private signalGroup(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.pid === null) return;
    try { process.kill(-this.pid, signal); }
    catch (error) { const code = (error as { code?: unknown }).code; if (code !== "ESRCH" && !(code === "EPERM" && this.streamsClosed)) throw error; }
  }
  /** Ends the input (Claude Code leaves on its own), then the group by the close chain; resolves once the group is empty. Idempotent. */
  close(): Promise<CleanupEvidence> {
    this.closing ??= (async () => {
      const chain = await quiesce({ group: this.pid, leaderRunning: () => !this.exited, endInput: () => { this.inputEnded = true; this.wake?.(); },
        quiescent: () => this.child === null || (this.streamsClosed && !this.groupAlive()), signal: signal => this.signalGroup(signal) }, this.closeGraceMs);
      try { this.query.close(); } catch { /* the process is gone already */ }
      if (!chain.quiescent) throw new ControlError("CLEANUP_FAILED", "the Claude Code process group did not close within the cleanup budget");
      const failure = this.failure;
      return { closed: true, exitCode: this.exitCode, signal: this.exitSignal,
        protocolFailure: failure === null ? null : { code: failure instanceof ControlError ? failure.code.slice(0, 128) : "CONTROL_FAILED", message: failure.message.slice(0, 512) } };
    })();
    return this.closing;
  }
}
