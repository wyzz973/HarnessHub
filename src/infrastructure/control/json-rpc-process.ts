import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type { CleanupEvidence, ControlLaunch, ControlOptions } from "../../contracts/control.js";

export class ControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ControlError"; }
}
export type RpcId = string | number;
export interface RpcRequest { readonly id: RpcId; readonly method: string; readonly params: unknown }
export interface RpcHandlers {
  readonly notification: (method: string, params: unknown) => void;
  readonly request: (request: RpcRequest) => Promise<unknown> | unknown;
  readonly failure: (error: Error) => void;
}
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ControlError("INVALID_PROTOCOL", `${label} must be an object`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value))
    throw new ControlError("INVALID_PROTOCOL", `${label} is invalid`);
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ControlError("INVALID_PROTOCOL", `${label} must be text`);
  return value;
}
export function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new ControlError("CONTROL_FAILED", "control operation failed");
}
function id(value: unknown): RpcId {
  if (typeof value === "string") return string(value, "RPC id");
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new ControlError("INVALID_PROTOCOL", "RPC id must be a bounded string or integer");
}
function key(value: RpcId): string { return JSON.stringify(value); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
/** Cumulative inbound and outbound budget for one connection; streamed output is never unbounded. */
export const MAX_CONNECTION_WIRE_BYTES = 16 * 1024 * 1024;

/** Owns one POSIX subprocess group, wire framing, request deadlines and awaited cleanup. */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pid: number | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly incomingIds = new Set<string>();
  private input = Buffer.alloc(0);
  private sequence = 0;
  private failed: Error | null = null;
  private closing = false;
  private cleanup: Promise<CleanupEvidence> | null = null;
  private closeObserved = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private diagnostic = Buffer.alloc(0);
  private diagnosticWasTruncated = false;
  private wireBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(readonly launch: ControlLaunch, readonly options: ControlOptions, private readonly handlers: RpcHandlers) {
    if (!isAbsolute(launch.executable) || !isAbsolute(options.cwd))
      throw new ControlError("INVALID_INPUT", "executable and cwd must be absolute paths");
    for (const argument of launch.args) if (typeof argument !== "string" || argument.includes("\0"))
      throw new ControlError("INVALID_INPUT", "invalid process argument");
    for (const [name, value] of Object.entries({ ...options.env, ...launch.env }))
      if (!name || /[=\0]/u.test(name) || typeof value !== "string" || value.includes("\0"))
        throw new ControlError("INVALID_INPUT", "invalid private environment");
    for (const [name, value] of Object.entries({ requestTimeoutMs: options.requestTimeoutMs,
      runTimeoutMs: options.runTimeoutMs, maxFrameBytes: options.maxFrameBytes,
      maxDiagnosticBytes: options.maxDiagnosticBytes, closeGraceMs: options.closeGraceMs }))
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new ControlError("INVALID_INPUT", `${name} must be a positive bounded integer`);
  }
  get diagnostics(): string { return this.diagnostic.toString("utf8"); }
  get diagnosticsTruncated(): boolean { return this.diagnosticWasTruncated; }
  get failure(): Error | null { return this.failed; }

  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new ControlError("CLOSED", "connection is closed"));
    if (this.pending.size >= 128) return Promise.reject(new ControlError("REQUEST_LIMIT", "too many pending requests"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
      return Promise.reject(new ControlError("INVALID_INPUT", "request timeout must be a positive bounded integer"));
    this.start();
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(new ControlError("REQUEST_TIMEOUT", `${method} exceeded its deadline`)), timeoutMs);
      this.pending.set(key(requestId), { resolve, reject, timer });
      void this.write({ id: requestId, method, params }).catch(error => this.abort(errorFrom(error)));
    });
  }
  async notify(method: string, params: unknown): Promise<void> {
    if (this.failed || this.closing) throw this.failed ?? new ControlError("CLOSED", "connection is closed");
    this.start();
    try { await this.write({ method, params }); } catch (error) { this.abort(errorFrom(error)); throw error; }
  }
  /** A protocol failure cancels pending operations and starts cleanup; close() observes its outcome. */
  abort(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = error;
    this.rejectPending(error);
    try { this.handlers.failure(error); } catch { /* Original failure remains authoritative. */ }
    void this.close().catch(() => { /* Awaited close() exposes cleanup failure to the owner. */ });
  }
  close(): Promise<CleanupEvidence> {
    if (!this.cleanup) {
      this.closing = true;
      // Install promise ownership before invoking callbacks; reentrant close() returns the same promise.
      this.cleanup = Promise.resolve().then(() => this.closeOwned());
    }
    return this.cleanup;
  }
  private start(): void {
    if (this.child) return;
    if (process.platform === "win32") throw new ControlError("UNSUPPORTED_PLATFORM", "this control slice requires POSIX process groups");
    const child = spawn(this.launch.executable, [...this.launch.args], {
      cwd: this.options.cwd, env: { ...this.options.env, ...this.launch.env }, shell: false,
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.pid = child.pid ?? null;
    child.on("error", error => this.abort(new ControlError("PROCESS_ERROR", error.message)));
    child.stdin.on("error", error => this.abort(new ControlError("WRITE_FAILED", error.message)));
    child.stdout.on("error", error => this.abort(new ControlError("READ_FAILED", error.message)));
    child.stderr.on("error", error => this.abort(new ControlError("READ_FAILED", error.message)));
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const available = this.options.maxDiagnosticBytes - this.diagnostic.length;
      if (chunk.length > available) this.diagnosticWasTruncated = true;
      if (available > 0) this.diagnostic = Buffer.concat([this.diagnostic, chunk.subarray(0, available)]);
    });
    child.stdout.on("end", () => {
      if (!this.closing && this.input.length) this.abort(new ControlError("INCOMPLETE_FRAME", "stdout ended inside a frame"));
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code; this.exitSignal = signal;
      if (!this.closing) this.abort(new ControlError("PROCESS_EXITED", `process exited before connection close (${code ?? signal})`));
    });
    child.on("close", (code, signal) => {
      this.closeObserved = true; this.exitCode = code; this.exitSignal = signal;
      if (!this.closing) this.abort(new ControlError("PROCESS_EXITED", "process closed unexpectedly"));
    });
  }
  private async write(message: Record<string, unknown>): Promise<void> {
    const wire = JSON.stringify(this.launch.protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message);
    if (Buffer.byteLength(wire) > this.options.maxFrameBytes)
      throw new ControlError("FRAME_LIMIT", "outbound frame exceeds its byte limit");
    this.accountWire(Buffer.byteLength(wire) + 1);
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new ControlError("WRITE_FAILED", "process input is closed");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ControlError("WRITE_TIMEOUT", "process input did not accept a frame")), this.options.requestTimeoutMs);
      stdin.write(`${wire}\n`, error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
    });
  }
  private read(chunk: Buffer): void {
    if (this.failed || this.closing) return;
    try { this.accountWire(chunk.length); }
    catch (error) { this.abort(errorFrom(error)); return; }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.input.length + part.length > this.options.maxFrameBytes) {
        this.abort(new ControlError("FRAME_LIMIT", "inbound frame exceeds its byte limit")); return;
      }
      this.input = Buffer.concat([this.input, part]);
      if (newline === -1) return;
      let parsed: unknown;
      try {
        const frame = this.decoder.decode(this.input);
        this.input = Buffer.alloc(0);
        parsed = JSON.parse(frame);
      } catch { this.abort(new ControlError("INVALID_FRAME", "stdout is not valid UTF-8 JSON")); return; }
      try { this.dispatch(object(parsed, "RPC frame")); }
      catch (error) { this.abort(errorFrom(error)); return; }
      if (this.failed || this.closing) return;
      offset = newline + 1;
    }
  }
  private dispatch(message: Record<string, unknown>): void {
    if ((this.launch.protocol === "acp-v1" && message.jsonrpc !== "2.0") ||
      (message.jsonrpc !== undefined && message.jsonrpc !== "2.0"))
      throw new ControlError("INVALID_PROTOCOL", "unsupported JSON-RPC version");
    if (message.method !== undefined) {
      const method = string(message.method, "RPC method");
      if ("result" in message || "error" in message) throw new ControlError("INVALID_PROTOCOL", "request contains a response payload");
      if (message.id === undefined) { this.handlers.notification(method, message.params); return; }
      const requestId = id(message.id), requestKey = key(requestId);
      if (this.incomingIds.has(requestKey)) throw new ControlError("DUPLICATE_REQUEST", "server repeated an RPC request identity");
      if (this.incomingIds.size >= 4096) throw new ControlError("REQUEST_LIMIT", "server request identity budget exhausted");
      this.incomingIds.add(requestKey);
      const request: RpcRequest = { id: requestId, method, params: message.params };
      void Promise.resolve().then(() => this.handlers.request(request)).then(
        result => this.write({ id: requestId, result }),
        error => {
          if (error instanceof ControlError && error.code === "METHOD_NOT_FOUND")
            return this.write({ id: requestId, error: { code: -32601, message: "Method not supported by this client" } });
          this.abort(errorFrom(error));
        },
      ).catch(error => this.abort(errorFrom(error)));
      return;
    }
    const responseId = id(message.id), responseKey = key(responseId);
    const pending = this.pending.get(responseKey);
    if (!pending) throw new ControlError("UNKNOWN_RESPONSE", "response has no pending request");
    if (("result" in message) === ("error" in message)) throw new ControlError("INVALID_PROTOCOL", "response must contain exactly one result or error");
    if ("error" in message) {
      const remote = object(message.error, "RPC error");
      if (!Number.isSafeInteger(remote.code) || typeof remote.message !== "string")
        throw new ControlError("INVALID_PROTOCOL", "RPC error payload is invalid");
      this.pending.delete(responseKey); clearTimeout(pending.timer);
      pending.reject(new ControlError("REMOTE_ERROR", `peer error ${remote.code}: ${remote.message.slice(0, 512)}`));
    } else {
      this.pending.delete(responseKey); clearTimeout(pending.timer); pending.resolve(message.result);
    }
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private accountWire(bytes: number): void {
    this.wireBytes += bytes;
    if (this.wireBytes > MAX_CONNECTION_WIRE_BYTES)
      throw new ControlError("WIRE_LIMIT", "connection exceeded its cumulative wire byte budget");
  }
  private groupAlive(): boolean {
    if (this.pid === null) return false;
    try { process.kill(-this.pid, 0); return true; }
    catch (error) { if (object(error, "signal error").code === "ESRCH") return false; throw error; }
  }
  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pid === null) return;
    try { process.kill(-this.pid, signal); }
    catch (error) { if (object(error, "signal error").code !== "ESRCH") throw error; }
  }
  private async waitClosed(): Promise<boolean> {
    const end = performance.now() + this.options.closeGraceMs;
    do {
      if (this.closeObserved && !this.groupAlive()) return true;
      await delay(Math.min(20, Math.max(1, end - performance.now())));
    } while (performance.now() < end);
    return this.closeObserved && !this.groupAlive();
  }
  private async closeOwned(): Promise<CleanupEvidence> {
    this.closing = true;
    const closed = new ControlError("CLOSED", "connection closed by its owner");
    this.rejectPending(this.failed ?? closed);
    if (!this.failed) {
      try { this.handlers.failure(closed); }
      catch (error) { this.failed = errorFrom(error); }
    }
    if (!this.child) return { closed: true, exitCode: null, signal: null, protocolFailure: this.protocolFailure() };
    this.child.stdin.end();
    let done = await this.waitClosed();
    if (!done) { this.signalGroup("SIGTERM"); done = await this.waitClosed(); }
    if (!done) { this.signalGroup("SIGKILL"); done = await this.waitClosed(); }
    if (!done) throw new ControlError("CLEANUP_FAILED", "owned process group or streams did not close within the cleanup budget");
    this.input = Buffer.alloc(0);
    return { closed: true, exitCode: this.exitCode, signal: this.exitSignal, protocolFailure: this.protocolFailure() };
  }
  private protocolFailure(): CleanupEvidence["protocolFailure"] {
    return this.failed === null ? null : {
      code: this.failed instanceof ControlError ? this.failed.code.slice(0, 128) : "CONTROL_FAILED",
      message: this.failed.message.slice(0, 512),
    };
  }
}
