import { darwinExitedGroupIsQuiescent } from "./process-group.js";
import { POSIX_SHUTDOWN_PROBES, confirmOutside, quiesce } from "./host-shutdown.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CleanupEvidence, ControlLaunch, ControlOptions } from "../../contracts/control.js";
import { HOST_BUDGET_BOUNDS, type HostCleanup, type HostCloseEvidence } from "../../contracts/native-host.js";
import type { OutsideProcess } from "../../contracts/session.js";

export class ControlError extends Error {
  /** The JSON-RPC error code of a request the peer refused (REMOTE_ERROR); absent for any other failure. */
  readonly remoteCode?: number;
  /**
   * What the peer said about a request it refused, in its error data (`error.data.details`, where the ACP SDK puts the cause
   * of an internal error): at most 2 KiB, control characters removed; absent when the data carries no such text. It is the
   * peer's private text and may name the user's paths or credentials: it never enters this error's message, a log or a
   * classification's wording, and a driver quotes it only through a fixed vocabulary.
   */
  readonly remoteDetail?: string;
  /**
   * The peer's own message for a request it refused (JSON-RPC `error.message`), kept like remoteDetail: at most 2 KiB,
   * control characters removed, the peer's private text that only a driver's fixed vocabulary may quote.
   */
  readonly remoteMessage?: string;
  /**
   * The short machine-readable fields of the refusal's error data, as the peer wrote them: top-level strings of at most 64
   * bytes made only of letters, digits and `_ . : / -` (claude-agent-acp's `errorKind`, OpenCode's `errorName`, `service`,
   * `field` and `sessionId`), at most 8 of them in the order sent. Free text never qualifies; absent when none does.
   */
  readonly remoteFields?: Readonly<Record<string, string>>;
  constructor(readonly code: string, message: string, readonly remoteFailure?: { readonly code: string; readonly message: string },
    remote?: { readonly code: number; readonly detail?: string; readonly message?: string; readonly fields?: Readonly<Record<string, string>> }) {
    super(message); this.name = "ControlError";
    if (remote !== undefined) {
      this.remoteCode = remote.code;
      if (remote.detail !== undefined) this.remoteDetail = remote.detail;
      if (remote.message !== undefined) this.remoteMessage = remote.message;
      if (remote.fields !== undefined) this.remoteFields = remote.fields;
    }
  }
}
/** How much of a program's latest stderr stays readable for its driver. */
const RECENT_STDERR_BYTES = 32 * 1024;
/** How much of a peer's own words about a refusal (JSON-RPC `error.message`, `error.data.details`) is kept, each. */
const REMOTE_DETAIL_BYTES = 2048;
/** A field of a refusal's error data short and plain enough to be a name, not text (ControlError.remoteFields). */
const REMOTE_FIELD = /^[A-Za-z0-9_.:/-]{1,64}$/u, REMOTE_FIELDS = 8;
/** A peer's text without control characters, cut to 2 KiB at a character boundary; nothing when nothing is left. */
function bounded(text: string): string | undefined {
  let kept = "", bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point <= 0x1f || point === 0x7f) continue;
    const size = Buffer.byteLength(char);
    if (bytes + size > REMOTE_DETAIL_BYTES) break;
    kept += char; bytes += size;
  }
  return kept || undefined;
}
/**
 * A peer's own explanation of a refused request, as the ACP SDK carries it (`error.data.details`, a string), bounded.
 * Other data, and text that is only control characters, carry none.
 */
function remoteDetail(data: unknown): string | undefined {
  const details = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).details : undefined;
  return typeof details === "string" ? bounded(details) : undefined;
}
/** The short fields of a refusal's error data (ControlError.remoteFields); `details` is the free text and never one. */
function remoteFields(data: unknown): Readonly<Record<string, string>> | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const fields: Record<string, string> = {}; let count = 0;
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (count >= REMOTE_FIELDS) break;
    if (name === "details" || !REMOTE_FIELD.test(name) || typeof value !== "string" || !REMOTE_FIELD.test(value)) continue;
    fields[name] = value; count++;
  }
  return count ? fields : undefined;
}
/** ACP's `auth_required` error code (agent-client-protocol schema); other JSON-RPC peers use -32000 for other server errors. */
const ACP_AUTH_REQUIRED = -32000;
/**
 * Recognize actionable failures without publishing arbitrary provider text or credentials. The provider's own words (an
 * error's message, followed by the detail of its error data when it gives one) decide the class, in this order, because
 * one message can mention several (an auth error that also says "limit"); `acpCode` is the JSON-RPC error code of an ACP
 * peer, whose -32000 means authentication is required.
 */
export function classifyRemoteFailure(message: string, acpCode?: number): { readonly code: string; readonly message: string } | undefined {
  if (/this client is no longer supported|unsupported client version/iu.test(message)) return { code: "NATIVE_CLIENT_UNSUPPORTED", message: "模型服务已停止支持这个本机客户端。原配置已保留，可以选择其他 Harness 继续。" };
  if (/authentication (?:required|fails?|failed)|not (?:logged|signed) in|login required|unauthorized|\b401\b|(?:invalid|incorrect) (?:x-)?api[ _-]?key|API key.*(?:missing|not configured|invalid)|no API key/iu.test(message) || acpCode === ACP_AUTH_REQUIRED)
    return { code: "NATIVE_AUTH_REQUIRED", message: "这个 Harness 的本机登录或密钥不可用，请在本机完成认证后再试。" };
  if (/weekly limit|daily limit|quota (?:exceeded|exhausted)|usage limit|hit your .*limit|insufficient[ _](?:balance|quota|credits?)|payment required|\b402\b|余额不足/iu.test(message))
    return { code: "NATIVE_QUOTA_EXCEEDED", message: "这个 Harness 的账号额度或余额不足。可等待额度恢复或充值，也可以选择其他 Harness 继续。" };
  if (/rate[ _-]?limit|too many requests|\b429\b|overloaded|\b529\b/iu.test(message)) return { code: "NATIVE_RATE_LIMITED", message: "模型服务暂时限流或过载。请稍后再试，或换一个模型。" };
  if (/context[ _](?:length|window)[ _](?:exceeded|is too long)|maximum context length|context_length_exceeded|prompt is too long|too many tokens/iu.test(message))
    return { code: "NATIVE_CONTEXT_EXCEEDED", message: "对话超出了模型的上下文长度。可以先用这个 Harness 的压缩命令（如 /compact），或开始新对话。" };
  if (/model[ _](?:not[ _](?:found|exists?)|does not exist|is not (?:available|supported))|unknown model|invalid model/iu.test(message)) return { code: "NATIVE_MODEL_UNAVAILABLE", message: "所选模型在这个 Harness 的模型服务中不可用，请换一个模型。" };
  if (/connection error|fetch failed|ECONNREFUSED|ENOTFOUND/iu.test(message)) return { code: "NATIVE_CONNECTION_FAILED", message: "这个 Harness 配置的模型服务无法连接。请检查它本机的模型配置，或选择其他模型继续。" };
  return undefined;
}
export type RpcId = string | number;
export interface RpcRequest { readonly id: RpcId; readonly method: string; readonly params: unknown }
export interface RpcHandlers {
  readonly notification: (method: string, params: unknown) => void;
  readonly request: (request: RpcRequest) => Promise<unknown> | unknown;
  readonly failure: (error: Error) => void;
}
/** Adapter-owned wire translation; framing, deadlines and process cleanup keep one owner. */
export interface RpcWireCodec {
  encode(message: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  decode(message: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}
interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** Absent for a request that has no deadline (a Turn's prompt: a Turn has no time wall). */
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}
/**
 * What a request's deadline does (JsonRpcProcess.request): "abort" fails the connection (every caller's default: a peer that
 * misses a deadline is not trusted further); "reject" gives up that one request only, for a read whose answer is optional (a
 * relay check, a native title, ADR-055 C6): it rejects with REQUEST_TIMEOUT, the connection stays usable, and the peer's late
 * answer to it is dropped when it comes. That holds for at most MAX_ABANDONED_REQUESTS given-up requests still unanswered at
 * a time; past them a "reject" deadline does what "abort" does.
 */
export type RequestDeadline = "abort" | "reject";
/**
 * Requests given up at a "reject" deadline whose answers may still come, remembered so that a late answer is dropped rather
 * than failing the connection as an unknown response. A late answer frees its place. With this many still unanswered, the
 * next "reject" deadline fails the connection with its REQUEST_TIMEOUT, as "abort" does: a peer that leaves 64 requests
 * unanswered is not trusted further, and what the connection remembers stays bounded. Every later request then rejects
 * with that failure, so a Driver's check that meets it rejects (its connection failed, the one case in which a check may
 * reject, VerifyRequest's contract) instead of answering unavailable, and the Driver reports itself unhealthy (the second
 * review's minor 1).
 */
const MAX_ABANDONED_REQUESTS = 64;
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
/**
 * One native frame can carry a whole read file, a run summary several times over or a long history replayed on load; this bounds
 * the memory one frame can take (a frame is held whole, then decoded and parsed, so a frame costs about three times its size while it
 * is handled). Far larger than any frame a Harness sends in normal work: it is a guard against a runaway stream, not a limit on what
 * a Turn may carry. A connection has no cumulative budget (2026-11-12): a kept process serves many Turns on one connection, and
 * what it replays on load grows with the conversation, so a total would be a conversation-size limit in another place.
 */
export const NATIVE_FRAME_BYTES = 256 * 1024 * 1024;
/** The cleanup fields a Run keeps (CleanupEvidence, the persisted shape), without the host close's own stage and time. */
function persisted(cleanup: HostCleanup): CleanupEvidence {
  return { closed: true, exitCode: cleanup.exitCode, signal: cleanup.signal, protocolFailure: cleanup.protocolFailure };
}

/** Owns one POSIX subprocess group, wire framing, request deadlines and awaited cleanup. */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pid: number | null = null;
  private readonly pending = new Map<string, Pending>();
  /** Requests given up at a "reject" deadline: their late answers are dropped instead of failing the connection. */
  private readonly abandoned = new Set<string>();
  private readonly incomingIds = new Set<string>();
  /** The inbound frame being assembled: its pieces as they came, and their total (concatenated once, when the line ends). */
  private input: Buffer[] = [];
  private inputBytes = 0;
  private sequence = 0;
  private failed: Error | null = null;
  private closing = false;
  /** The first part of the close (the group's end) and the cleanup taken from it; installed together on the first close. */
  private quiet: Promise<{ readonly cleanup: HostCleanup; readonly found: readonly OutsideProcess[] | null }> | null = null;
  private cleanup: Promise<CleanupEvidence> | null = null;
  /** The whole evidence, once asked for: only closeEvidence() looks again at what left the group, and waits for it. */
  private evidence: Promise<HostCloseEvidence> | null = null;
  private closeObserved = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private diagnostic = Buffer.alloc(0);
  private diagnosticWasTruncated = false;
  /** The latest stderr bytes, for a driver that reads what the program logged during one turn; `stderrBytes` counts all of it. */
  private recentStderr = Buffer.alloc(0);
  private stderrBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(readonly launch: ControlLaunch, readonly options: ControlOptions, private readonly handlers: RpcHandlers, private readonly codec?: RpcWireCodec) {
    if (!isAbsolute(launch.executable) || !isAbsolute(options.cwd))
      throw new ControlError("INVALID_INPUT", "executable and cwd must be absolute paths");
    for (const argument of launch.args) if (typeof argument !== "string" || argument.includes("\0"))
      throw new ControlError("INVALID_INPUT", "invalid process argument");
    for (const [name, value] of Object.entries({ ...options.env, ...launch.env }))
      if (!name || /[=\0]/u.test(name) || typeof value !== "string" || value.includes("\0"))
        throw new ControlError("INVALID_INPUT", "invalid private environment");
    for (const [name, value] of Object.entries({ requestTimeoutMs: options.requestTimeoutMs,
      runTimeoutMs: options.runTimeoutMs ?? 1, maxFrameBytes: options.maxFrameBytes,
      maxDiagnosticBytes: options.maxDiagnosticBytes, closeGraceMs: options.closeGraceMs, closeOutsideWaitMs: options.closeOutsideWaitMs ?? HOST_BUDGET_BOUNDS.closeOutsideWaitMs.fallback }))
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new ControlError("INVALID_INPUT", `${name} must be a positive bounded integer`);
  }
  get diagnostics(): string { return this.diagnostic.toString("utf8"); }
  /** A position in the program's stderr, to read what it logs after this point. */
  get stderrMark(): number { return this.stderrBytes; }
  /** What the program logged after `mark`, as far as the bounded recent window still holds it (lossy UTF-8 at the cut). */
  stderrSince(mark: number): string {
    const kept = Math.min(this.recentStderr.length, Math.max(0, this.stderrBytes - mark));
    return this.recentStderr.subarray(this.recentStderr.length - kept).toString("utf8");
  }
  get diagnosticsTruncated(): boolean { return this.diagnosticWasTruncated; }
  get failure(): Error | null { return this.failed; }
  /** The process group this connection's program leads (spawned detached, so its pid); null before it started. */
  get processGroup(): number | null { return this.pid; }

  /**
   * One request with its own deadline (the connection's request timeout by default; `null`: no deadline, for a Turn's prompt,
   * which runs as long as the Turn does). At the deadline the connection fails (`deadline` "abort", the default), or only this
   * request is given up ("reject", see RequestDeadline). A deadline that runs out fails with `timeoutCode`: a step of a Harness's start
   * names itself (NATIVE_INITIALIZE_TIMEOUT, NATIVE_SESSION_TIMEOUT), so the user is told what was waited for.
   */
  request(method: string, params: unknown, timeoutMs: number | null = this.options.requestTimeoutMs, deadline: RequestDeadline = "abort", timeoutCode = "REQUEST_TIMEOUT"): Promise<unknown> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new ControlError("CLOSED", "connection is closed"));
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647))
      return Promise.reject(new ControlError("INVALID_INPUT", "request timeout must be a positive bounded integer"));
    this.start();
    const requestId = ++this.sequence, requestKey = key(requestId);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        const expired = new ControlError(timeoutCode, `${method} exceeded its deadline`);
        if (deadline === "abort" || this.abandoned.size >= MAX_ABANDONED_REQUESTS) { this.abort(expired); return; }
        // Only this request is given up; its answer, should it still come, is dropped by dispatch().
        if (!this.pending.delete(requestKey)) return;
        this.abandoned.add(requestKey); reject(expired);
      }, timeoutMs);
      this.pending.set(requestKey, { resolve, reject, timer });
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
  /**
   * Closes the connection (ADR-056 §4.11): its input first, its process group signalled only after the grace, and resolves
   * once the group is empty with its cleanup, the fields a Run keeps. Nothing about processes that left the group is waited
   * for. Rejects with CLEANUP_FAILED when the group cannot be confirmed ended. Idempotent: every call returns one promise.
   */
  close(): Promise<CleanupEvidence> {
    this.begin(false);
    return this.cleanup!;
  }
  /**
   * The whole evidence of a host's close: how far it went (no signal, SIGTERM or SIGKILL) and how long the group took to end,
   * and what had left the group, read before its input closed and looked at again after it, waiting up to the configured
   * outside wait for those still running (never signalling them). `signal` cuts that wait short, which records them as
   * `remaining: null`; only the first call's signal counts. Started by this call, the close reads what left the group; a
   * close already started by close() did not, and its outside evidence is unknown. Rejects as close() does, with the same
   * error; a close asked for only through this call leaves no other rejection behind.
   */
  closeEvidence(signal?: AbortSignal): Promise<HostCloseEvidence> {
    this.begin(true);
    this.evidence ??= this.quiet!.then(async closed => ({ cleanup: closed.cleanup,
      outside: await confirmOutside(closed.found, this.options.closeOutsideWaitMs ?? HOST_BUDGET_BOUNDS.closeOutsideWaitMs.fallback, POSIX_SHUTDOWN_PROBES.running, signal) }));
    return this.evidence;
  }
  /** Starts the close once; `sample` reads what left the group before its input closes. */
  private begin(sample: boolean): void {
    if (this.cleanup) return;
    this.closing = true;
    // Install promise ownership before invoking callbacks; reentrant close() returns the same promise.
    const quiet = Promise.resolve().then(() => this.closeOwned(sample));
    this.quiet = quiet;
    this.cleanup = quiet.then(closed => persisted(closed.cleanup));
    // A close asked for only through closeEvidence() hands this promise to nobody: its failure reaches that caller there,
    // and a later close() returns this promise with the same rejection.
    void this.cleanup.catch(() => {});
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
      this.stderrBytes += chunk.length;
      const recent = Buffer.concat([this.recentStderr, chunk]);
      this.recentStderr = recent.length > RECENT_STDERR_BYTES ? recent.subarray(recent.length - RECENT_STDERR_BYTES) : recent;
    });
    child.stdout.on("end", () => {
      if (!this.closing && this.inputBytes > 0) this.abort(new ControlError("INCOMPLETE_FRAME", "stdout ended inside a frame"));
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code; this.exitSignal = signal;
      if (!this.closing) this.abort(this.exitFailure(code ?? signal));
    });
    child.on("close", (code, signal) => {
      this.closeObserved = true; this.exitCode = code; this.exitSignal = signal;
      if (!this.closing) this.abort(new ControlError("PROCESS_EXITED", "process closed unexpectedly"));
    });
  }
  private exitFailure(status: number | NodeJS.Signals | null): ControlError {
    // Classify known startup failures without forwarding arbitrary stderr or credentials.
    if (/config(?:uration)? is invalid/iu.test(this.diagnostics))
      return new ControlError("NATIVE_CONFIGURATION_INVALID", "Harness rejected its local configuration; run its own doctor/migration");
    if (/unauthorized:\s*gateway token missing|gateway auth.*token.*missing/iu.test(this.diagnostics))
      return new ControlError("GATEWAY_AUTH_REQUIRED", "Harness Gateway authentication is required; configure its connection or choose another Harness");
    return new ControlError("PROCESS_EXITED", `process exited before connection close (${status})`);
  }
  private async write(message: Record<string, unknown>): Promise<void> {
    const wire = JSON.stringify(this.codec ? this.codec.encode(message) : this.launch.protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message);
    const bytes = Buffer.byteLength(wire);
    if (bytes > this.options.maxFrameBytes)
      throw new ControlError("FRAME_LIMIT", "outbound frame exceeds its byte limit");
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new ControlError("WRITE_FAILED", "process input is closed");
    // A program that takes in a MiB a second is reading: the frame gets the plain deadline and a second for every MiB it holds, so that
    // a large one (a file inlined into a message can be tens of MiB) is not mistaken for a stuck program (2026-11-12).
    const takeInMs = this.options.requestTimeoutMs + Math.ceil(bytes / 1024);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ControlError("WRITE_TIMEOUT", "process input did not accept a frame")), takeInMs);
      stdin.write(`${wire}\n`, error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
    });
  }
  private read(chunk: Buffer): void {
    if (this.failed || this.closing) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.inputBytes + part.length > this.options.maxFrameBytes) {
        this.abort(new ControlError("FRAME_LIMIT", "inbound frame exceeds its byte limit")); return;
      }
      // The pieces of a frame are kept as they came and joined once, when its line ends: joining at every chunk copies everything
      // received so far each time, which for a large frame grows with the square of its size.
      if (part.length > 0) { this.input.push(part); this.inputBytes += part.length; }
      if (newline === -1) return;
      let parsed: unknown;
      try {
        const frame = this.decoder.decode(this.input.length === 1 ? this.input[0]! : Buffer.concat(this.input, this.inputBytes));
        this.input = []; this.inputBytes = 0;
        parsed = JSON.parse(frame);
      } catch { this.abort(new ControlError("INVALID_FRAME", "stdout is not valid UTF-8 JSON")); return; }
      try { const message = object(parsed, "RPC frame"); this.dispatch(this.codec ? this.codec.decode(message) : message); }
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
      // The ids of the peer's requests on this connection: one that repeats is a protocol failure. The set has no count bound (it ended a Turn at
      // its 4,097th peer request until 2026-11-12); an entry is a short string, and a connection that has seen a million of them holds a few dozen MB.
      if (this.incomingIds.has(requestKey)) throw new ControlError("DUPLICATE_REQUEST", "server repeated an RPC request identity");
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
    // The late answer to a request given up at its deadline: nobody waits for it any more.
    if (!pending && this.abandoned.delete(responseKey)) return;
    if (!pending) throw new ControlError("UNKNOWN_RESPONSE", "response has no pending request");
    if (("result" in message) === ("error" in message)) throw new ControlError("INVALID_PROTOCOL", "response must contain exactly one result or error");
    if ("error" in message) {
      const remote = object(message.error, "RPC error");
      if (!Number.isSafeInteger(remote.code) || typeof remote.message !== "string")
        throw new ControlError("INVALID_PROTOCOL", "RPC error payload is invalid");
      this.pending.delete(responseKey); clearTimeout(pending.timer);
      // The class may come from the detail too (an ACP agent's message is often only "Internal error"); neither text is kept
      // in the error's message.
      const code = remote.code as number, detail = remoteDetail(remote.data), said = bounded(remote.message), fields = remoteFields(remote.data);
      pending.reject(new ControlError("REMOTE_ERROR", `Harness rejected the protocol request (${code})`,
        classifyRemoteFailure(detail === undefined ? remote.message : remote.message + " " + detail, this.launch.protocol === "acp-v1" ? code : undefined),
        { code, ...(detail === undefined ? {} : { detail }), ...(said === undefined ? {} : { message: said }), ...(fields === undefined ? {} : { fields }) }));
    } else {
      this.pending.delete(responseKey); clearTimeout(pending.timer); pending.resolve(message.result);
    }
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private groupAlive(): boolean {
    if (this.pid === null) return false;
    try { process.kill(-this.pid, 0); return true; }
    catch (error) { if (object(error, "signal error").code === "ESRCH") return false; if (object(error,"signal error").code === "EPERM" && this.closeObserved) return !darwinExitedGroupIsQuiescent(this.pid); throw error; }
  }
  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pid === null) return;
    try { process.kill(-this.pid, signal); }
    catch (error) { if (object(error, "signal error").code !== "ESRCH" && !(object(error,"signal error").code==="EPERM"&&this.closeObserved)) throw error; }
  }
  private async closeOwned(sample: boolean): Promise<{ readonly cleanup: HostCleanup; readonly found: readonly OutsideProcess[] | null }> {
    this.closing = true;
    const closed = new ControlError("CLOSED", "connection closed by its owner");
    this.rejectPending(this.failed ?? closed);
    if (!this.failed) {
      try { this.handlers.failure(closed); }
      catch (error) { this.failed = errorFrom(error); }
    }
    const child = this.child;
    if (!child) return { cleanup: { closed: true, exitCode: null, signal: null, protocolFailure: this.protocolFailure(), stage: null, closeMs: 0 }, found: null };
    // EOF first; signals to the group only after the grace; what left the group is never signalled (ADR-056 §4.11).
    const chain = await quiesce({ group: this.pid, leaderRunning: () => this.exitCode === null && this.exitSignal === null, endInput: () => child.stdin.end(),
      quiescent: () => this.closeObserved && !this.groupAlive(), signal: signal => this.signalGroup(signal) }, this.options.closeGraceMs, sample ? POSIX_SHUTDOWN_PROBES.outsiders : undefined);
    if (!chain.quiescent) throw new ControlError("CLEANUP_FAILED", "owned process group or streams did not close within the cleanup budget");
    this.input = []; this.inputBytes = 0;
    return { cleanup: { closed: true, exitCode: this.exitCode, signal: this.exitSignal, protocolFailure: this.protocolFailure(), stage: chain.stage, closeMs: chain.closeMs }, found: chain.found };
  }
  private protocolFailure(): CleanupEvidence["protocolFailure"] {
    return this.failed === null ? null : {
      code: this.failed instanceof ControlError ? this.failed.code.slice(0, 128) : "CONTROL_FAILED",
      message: this.failed.message.slice(0, 512),
    };
  }
}
