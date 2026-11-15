import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import WebSocket from "ws";
import type { CleanupEvidence, ControlLaunch, ControlOptions } from "../../../contracts/control.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { quiesce } from "../../../infrastructure/control/host-shutdown.js";
import { darwinExitedGroupIsQuiescent } from "../../../infrastructure/control/process-group.js";

/**
 * One `dsh --profile web` process of this connection and the two ways the Web host is spoken to (dsh-client-connection, dsh-api-gateway,
 * 0.2.2-rc.1): unary calls `POST /api/<endpoint>` with `{type: "client-request", rpcId, method, payload: {args}}`, answered
 * `{type: "server-response", rpcId, result: {ok, value | error}}`; streams as `open | item | end | cancel` frames on the `/api/remote.mux`
 * WebSocket, whose `$events` stream carries the Host's forwarded events (`ready`, `emit`, `waterfall`, `cancel`) and is answered through
 * `$events/result`. The process listens on loopback, on a port the system picks; its launch token (printed once on stdout, `dsh web: <url>?token=`)
 * is traded at `GET /connect?token=…&interactions=answer` for an API cookie, and neither is ever logged, kept on disk or put into an error.
 */

/** A refusal dsh answered with one of its own codes (`session/not-found`, `gateway/input-invalid`, …); its message is dsh's own text and is not kept. */
export class DshRemoteError extends ControlError {
  /** dsh's machine word for why, when its details give one (`details.reason`: `MODEL_DOES_NOT_SUPPORT_IMAGES`). */
  readonly reason: string | null;
  constructor(readonly endpoint: string, readonly dshCode: string, reason?: unknown) {
    super("REMOTE_ERROR", "dsh refused " + endpoint + " (" + dshCode + ")"); this.name = "DshRemoteError";
    this.reason = typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(reason) ? reason : null;
  }
}
/** The Web host did not start or did not answer as it should: the connection never served anything (the driver then uses ACP instead). */
export const WEB_UNAVAILABLE = "DSH_WEB_UNAVAILABLE";
export interface Waterfall { readonly event: string; readonly eventId: string; readonly agentId: string; readonly request: Readonly<Record<string, unknown>> }
export interface HostEvents {
  emit(event: string, args: readonly unknown[]): void;
  waterfall(frame: Waterfall): void;
  /** The Host withdrew a waterfall it sent (its request was settled elsewhere or cancelled). */
  withdrawn(eventId: string): void;
  failure(error: Error): void;
}
export interface StreamHandle { cancel(): void }
interface Stream { readonly item: (value: unknown) => void; readonly end: (error: Error | null) => void }
/** The startup line of the Web app (dsh-web-app `console.log("dsh web: " + url)`), on loopback only. */
const URL_LINE = /dsh web: (http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/\S*)/u;
const RECENT_STDERR_BYTES = 32 * 1024;
/** Startup output kept while the URL line is looked for: far more than the few lines dsh prints before it. */
const STARTUP_STDOUT_BYTES = 256 * 1024;
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

export class DshWebHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pid: number | null = null;
  private origin: string | null = null;
  private cookie: string | null = null;
  private socket: WebSocket | null = null;
  private clientId: string | null = null;
  private readonly streams = new Map<string, Stream>();
  private failed: Error | null = null;
  private closing = false;
  private closeObserved = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private recent = Buffer.alloc(0);
  private stderrBytes = 0;
  private cleanup: Promise<CleanupEvidence> | null = null;

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions, private readonly events: HostEvents) {
    if (!isAbsolute(launch.executable) || !isAbsolute(options.cwd)) throw new ControlError("INVALID_INPUT", "executable and cwd must be absolute paths");
  }
  get failure(): Error | null { return this.failed; }
  get started(): boolean { return this.socket !== null; }
  get processGroup(): number | null { return this.pid; }
  get stderrMark(): number { return this.stderrBytes; }
  stderrSince(mark: number): string {
    const kept = Math.min(this.recent.length, Math.max(0, this.stderrBytes - mark));
    return this.recent.subarray(this.recent.length - kept).toString("utf8").replace(/token=[^\s&"']+/gu, "token=<hidden>");
  }

  /**
   * Starts the process with `args` and makes the connection: the URL line, the cookie, the mux socket and the `$events` stream's `ready`. Rejects with
   * DSH_WEB_UNAVAILABLE when any of it does not come as it should within the startup wait; what was started is then closed by close().
   */
  async start(args: readonly string[]): Promise<void> {
    if (this.child !== null) throw new ControlError("INVALID_STATE", "the Web host was already started");
    const wait = this.options.startupTimeoutMs ?? this.options.requestTimeoutMs, deadline = Date.now() + wait;
    const unavailable = (reason: string) => new ControlError(WEB_UNAVAILABLE, "dsh 的 Web 宿主" + reason);
    const child = spawn(this.launch.executable, [...args], { cwd: this.options.cwd, env: { ...this.options.env, ...this.launch.env }, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.pid = child.pid ?? null;
    child.stdin.on("error", () => { /* dsh does not read its input; a closed pipe is not a failure. */ });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      const joined = Buffer.concat([this.recent, chunk]);
      this.recent = joined.length > RECENT_STDERR_BYTES ? joined.subarray(joined.length - RECENT_STDERR_BYTES) : joined;
    });
    child.on("exit", (code, signal) => { this.exitCode = code; this.exitSignal = signal; if (!this.closing) this.fail(new ControlError("PROCESS_EXITED", "dsh 的 Web 宿主退出了（" + (code ?? signal) + "）")); });
    child.on("close", () => { this.closeObserved = true; });
    child.on("error", error => this.fail(new ControlError("PROCESS_ERROR", error.message)));
    const url = await new Promise<string>((resolve, reject) => {
      let seen = "", done = false;
      const finish = (error: Error | null, value?: string) => { if (done) return; done = true; clearTimeout(timer); child.off("exit", exited); error ? reject(error) : resolve(value!); };
      const exited = () => finish(unavailable("没启动起来就退出了"));
      const timer = setTimeout(() => finish(unavailable("在 " + Math.round(wait / 1000) + " 秒内没有报出地址")), wait);
      child.once("exit", exited);
      child.stdout.on("data", (chunk: Buffer) => {
        if (done) return;
        seen = (seen + chunk.toString("utf8")).slice(-STARTUP_STDOUT_BYTES);
        const found = URL_LINE.exec(seen);
        if (found) { seen = ""; finish(null, found[1]!); }
      });
    });
    const parsed = new URL(url), token = parsed.searchParams.get("token");
    if (!token) throw unavailable("报出的地址里没有登录令牌");
    this.origin = parsed.origin;
    const left = () => Math.max(1, deadline - Date.now());
    let connect: Response;
    try { connect = await fetch(this.origin + "/connect?token=" + encodeURIComponent(token) + "&interactions=answer", { redirect: "manual", headers: { Origin: this.origin }, signal: AbortSignal.timeout(left()) }); }
    catch { throw unavailable("没有接受连接"); }
    const cookies = (connect.headers.getSetCookie?.() ?? []).map(value => value.split(";")[0]!.trim()).filter(Boolean);
    if (connect.status !== 302 || cookies.length === 0) throw unavailable("没有按预期回应连接（" + connect.status + "）");
    this.cookie = cookies.join("; ");
    const socket = new WebSocket(this.origin.replace(/^http/u, "ws") + "/api/remote.mux", { headers: { Cookie: this.cookie, Origin: this.origin }, perMessageDeflate: false, maxPayload: this.options.maxFrameBytes });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(unavailable("的事件通道没有打开")); }, left());
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(unavailable("的事件通道没有打开")); });
      socket.once("unexpected-response", () => { clearTimeout(timer); reject(unavailable("拒绝了事件通道")); });
    });
    this.socket = socket;
    socket.on("message", (data: WebSocket.RawData) => this.frame(data));
    socket.on("close", () => { if (!this.closing) this.fail(new ControlError("CONNECTION_LOST", "dsh 的 Web 宿主断开了事件通道")); });
    socket.on("error", () => { if (!this.closing) this.fail(new ControlError("CONNECTION_LOST", "dsh 的 Web 宿主的事件通道出错")); });
    // The forwarded events: its first item is `ready` with the client id the answers name.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(unavailable("的事件流没有就绪")), left());
      let ready = false;
      this.open("$events", {}, {
        item: value => {
          const frame = record(value);
          if (!ready) {
            if (frame?.type !== "ready" || typeof frame.clientId !== "string") { clearTimeout(timer); reject(unavailable("的事件流开头不是 ready")); return; }
            ready = true; this.clientId = frame.clientId; clearTimeout(timer); resolve(); return;
          }
          if (frame?.type === "emit" && typeof frame.event === "string") this.events.emit(frame.event, Array.isArray(frame.args) ? frame.args : []);
          else if (frame?.type === "waterfall" && typeof frame.event === "string" && typeof frame.eventId === "string") this.events.waterfall({ event: frame.event, eventId: frame.eventId, agentId: typeof frame.agentId === "string" ? frame.agentId : "", request: record(frame.request) ?? {} });
          else if (frame?.type === "cancel" && typeof frame.eventId === "string") this.events.withdrawn(frame.eventId);
        },
        end: error => { if (!ready) { clearTimeout(timer); reject(unavailable("的事件流没有就绪")); return; } if (!this.closing) this.fail(error ?? new ControlError("CONNECTION_LOST", "dsh 的 Web 宿主结束了事件流")); },
      });
    });
  }
  private frame(data: WebSocket.RawData): void {
    let frame: Record<string, unknown> | null = null;
    try { frame = record(JSON.parse(data.toString())); } catch { /* checked below */ }
    if (frame === null || typeof frame.streamId !== "string") { this.fail(new ControlError("INVALID_PROTOCOL", "dsh 的 Web 宿主发来了无法识别的帧")); return; }
    const stream = this.streams.get(frame.streamId);
    if (stream === undefined) return;
    if (frame.type === "item") { stream.item(frame.value); return; }
    this.streams.delete(frame.streamId);
    if (frame.type === "end") { stream.end(null); return; }
    const failure = record(frame.error);
    stream.end(new DshRemoteError("stream", typeof failure?.code === "string" ? failure.code : "gateway/internal"));
  }
  /** Opens one logical stream; `end` is called once, with the stream's failure or null. */
  open(endpoint: string, args: Readonly<Record<string, unknown>>, on: Stream): StreamHandle {
    if (this.failed || this.closing || this.socket === null) { const error = this.failed ?? new ControlError("CLOSED", "the Web host is closed"); queueMicrotask(() => on.end(error)); return { cancel: () => {} }; }
    const streamId = randomUUID(), socket = this.socket;
    this.streams.set(streamId, on);
    socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return { cancel: () => { if (this.streams.delete(streamId) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel", streamId })); } };
  }
  /** One unary call; resolves with its value, rejects with DshRemoteError for dsh's refusal and a ControlError for anything else. */
  async call(endpoint: string, args: Readonly<Record<string, unknown>>, timeoutMs: number | null = this.options.requestTimeoutMs): Promise<unknown> {
    if (this.failed || this.closing || this.origin === null || this.cookie === null) throw this.failed ?? new ControlError("CLOSED", "the Web host is closed");
    const rpcId = randomUUID();
    let response: Response;
    try {
      response = await fetch(this.origin + "/api/" + endpoint, { method: "POST", headers: { "content-type": "application/json", Cookie: this.cookie, Origin: this.origin },
        body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }), ...(timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) }) });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new ControlError("REQUEST_TIMEOUT", endpoint + " exceeded its deadline");
      throw this.failed ?? new ControlError("CONNECTION_LOST", "dsh 的 Web 宿主没有回应 " + endpoint);
    }
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try { body = record(JSON.parse(text)); } catch { /* checked below */ }
    if (response.status === 404) throw new DshRemoteError(endpoint, "gateway/not-found");
    const result = record(body?.result);
    if (response.status !== 200 || result === null || body?.rpcId !== rpcId) throw new ControlError("INVALID_PROTOCOL", "dsh 的 Web 宿主对 " + endpoint + " 的回答不对（" + response.status + "）");
    if (result.ok === true) return result.value;
    const error = record(result.error);
    throw new DshRemoteError(endpoint, typeof error?.code === "string" && /^[a-z][a-z0-9-]*\/[a-z0-9-]+$/u.test(error.code) ? error.code : "gateway/internal", record(error?.details)?.reason);
  }
  /** Answers one waterfall of the `$events` stream. */
  async answer(eventId: string, outcome: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.clientId === null) throw new ControlError("INVALID_STATE", "the event stream is not ready");
    await this.call("$events/result", { clientId: this.clientId, eventId, outcome });
  }
  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = error;
    for (const [id, stream] of this.streams) { this.streams.delete(id); stream.end(error); }
    try { this.events.failure(error); } catch { /* The failure stands. */ }
  }
  private groupAlive(): boolean {
    if (this.pid === null) return false;
    try { process.kill(-this.pid, 0); return true; }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM" && this.closeObserved) return !darwinExitedGroupIsQuiescent(this.pid);
      throw error;
    }
  }
  /**
   * Closes the connection and the process (ADR-056 §4.11): the streams and the socket first, then SIGTERM to dsh itself (it drains and exits on it,
   * as on 0.2.2-rc.1), its process group signalled only after the grace. Resolves once the group is empty; idempotent.
   */
  close(): Promise<CleanupEvidence> {
    this.cleanup ??= this.closeOwned();
    return this.cleanup;
  }
  private async closeOwned(): Promise<CleanupEvidence> {
    const failure = this.failed;
    this.closing = true;
    for (const [id, stream] of this.streams) { this.streams.delete(id); stream.end(new ControlError("CLOSED", "connection closed by its owner")); }
    if (this.socket !== null) { try { this.socket.terminate(); } catch { /* already closed */ } }
    const protocolFailure = failure === null ? null : { code: failure instanceof ControlError ? failure.code.slice(0, 128) : "CONTROL_FAILED", message: failure.message.slice(0, 512) };
    const child = this.child;
    if (child === null) return { closed: true, exitCode: null, signal: null, protocolFailure };
    const chain = await quiesce({ group: this.pid, leaderRunning: () => this.exitCode === null && this.exitSignal === null,
      endInput: () => { try { child.stdin.end(); if (this.exitCode === null && this.exitSignal === null) child.kill("SIGTERM"); } catch { /* gone */ } },
      quiescent: () => this.closeObserved && !this.groupAlive(),
      signal: signal => { if (this.pid === null) return; try { process.kill(-this.pid, signal); } catch (error) { const code = (error as { code?: unknown }).code; if (code !== "ESRCH" && !(code === "EPERM" && this.closeObserved)) throw error; } } },
    this.options.closeGraceMs);
    if (!chain.quiescent) throw new ControlError("CLEANUP_FAILED", "dsh's Web host process group did not close within the cleanup budget");
    return { closed: true, exitCode: this.exitCode, signal: this.exitSignal, protocolFailure };
  }
}
