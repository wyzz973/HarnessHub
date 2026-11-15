import { createConnection } from "node:net";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, type RawData } from "ws";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { assertAllowed } from "./methods.js";

/**
 * The bootstrap and the wire of `hermes-gateway-v1` (research of 2026-11-14, Part B2), the protocol Hermes's own Desktop, TUI and `hermes acp`
 * speak to the one gateway daemon that owns every session: the same-user control socket `<home>/gateway.sock` answers `identify` (a pure
 * read) and mints a one-use `session-ticket`; the ticket opens the WebSocket `<api_origin>/api/ws` with the subprotocols
 * `hermes-gateway-v1` and `hermes-gateway-ticket.<ticket>`. Nothing here starts, stops, replaces or waits for a gateway: one that is not
 * `ready` is refused with what Hermes says of it. No token is stored or printed; the ticket lives for one dial.
 */
export const GATEWAY_PROTOCOL = "hermes-gateway-v1";
const TICKET_PREFIX = "hermes-gateway-ticket.";
const CONTROL_BYTES = 512 * 1024;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** What the owner must advertise for the driver to attach at all; the rest only turns features on. */
const REQUIRED = ["session-authority-v1"] as const;

/** Hermes's home as `hermes` resolves it without a profile flag: HERMES_HOME, else the sticky profile of `~/.hermes/active_profile`, else `~/.hermes`. */
export async function resolveHermesHome(env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const home = env.HOME || homedir();
  const explicit = env.HERMES_HOME?.trim();
  if (explicit) return resolve(explicit.replace(/^~(?=$|\/)/u, home));
  const root = join(home, ".hermes");
  const name = (await readFile(join(root, "active_profile"), "utf8").catch(() => "")).trim();
  if (!name || name === "default" || !PROFILE_NAME.test(name)) return root;
  const profile = join(root, "profiles", name);
  return (await stat(profile).catch(() => null))?.isDirectory() ? profile : root;
}

/**
 * A private node of the user's own, as Hermes's own discovery requires (hermes_cli/gateway_runtime_discovery.py `_private_node`): owned by this
 * user; the home not writable by others, the socket and the pointer readable by no one else. A socket owner other than this user is never dialled.
 */
async function privateNode(path: string, kind: "directory" | "socket" | "file"): Promise<void> {
  const info = await lstat(path).catch(() => null);
  const uid = process.getuid?.();
  if (info === null) throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关没有在运行（没有找到它的控制套接字）。HarnessHub 不会替你启动它：在终端运行 hermes gateway start 后再试。");
  const right = kind === "directory" ? info.isDirectory() : kind === "socket" ? info.isSocket() : info.isFile();
  if (!right || (uid !== undefined && info.uid !== uid) || (info.mode & (kind === "directory" ? 0o002 : 0o077)) !== 0)
    throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关控制套接字不属于当前用户或权限不安全，HarnessHub 不连接它。可以运行 hermes gateway status 查看。");
}
/** The control socket of `home`: `gateway.sock`, or the private pointer `gateway.sock.path` Hermes writes when the path would be too long. */
async function socketPath(home: string): Promise<string> {
  await privateNode(home, "directory");
  const direct = join(home, "gateway.sock");
  if ((await lstat(direct).catch(() => null)) !== null) { await privateNode(direct, "socket"); return direct; }
  const pointer = join(home, "gateway.sock.path");
  await privateNode(pointer, "file");
  const target = (await readFile(pointer, "utf8")).trim();
  if (!target.startsWith("/") || !target.endsWith("/control.sock") || target.length > 4096) throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关控制套接字指向了无效的位置。");
  await privateNode(target, "socket");
  return target;
}
/** One request line to the control socket, its one answer line (`{ok, protocol: 1, id: 1, result}`). */
async function controlQuery(home: string, request: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<Record<string, unknown>> {
  const path = await socketPath(home);
  const line = await new Promise<string>((resolveLine, reject) => {
    const socket = createConnection(path);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关没有回应（控制套接字超时）。可以运行 hermes gateway status 查看。")); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => {
      data += chunk;
      if (data.length > CONTROL_BYTES) { clearTimeout(timer); socket.destroy(); reject(new ControlError("INVALID_PROTOCOL", "Hermes control answer exceeds its bounds")); return; }
      const end = data.indexOf("\n");
      if (end >= 0) { clearTimeout(timer); socket.end(); resolveLine(data.slice(0, end)); }
    });
    socket.on("error", () => { clearTimeout(timer); reject(new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关没有在运行（控制套接字连不上）。HarnessHub 不会替你启动它：在终端运行 hermes gateway start 后再试。")); });
    socket.on("end", () => { clearTimeout(timer); if (!data.includes("\n")) reject(new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关关闭了控制连接。")); });
  });
  let answer: unknown;
  try { answer = JSON.parse(line); } catch { throw new ControlError("INVALID_PROTOCOL", "Hermes control answer is not JSON"); }
  const row = answer !== null && typeof answer === "object" && !Array.isArray(answer) ? answer as Record<string, unknown> : {};
  if (row.ok !== true || row.protocol !== 1 || row.id !== 1 || row.result === null || typeof row.result !== "object" || Array.isArray(row.result)) {
    const said = typeof row.error === "string" && /^[A-Za-z][\w :.-]{0,120}$/u.test(row.error) ? "（" + row.error + "）" : "";
    throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关拒绝了 HarnessHub 的连接" + said + "。");
  }
  return row.result as Record<string, unknown>;
}

export interface GatewayEndpoint {
  readonly home: string;
  readonly apiOrigin: string;
  readonly profileId: string;
  readonly instanceId: string;
  readonly epoch: number;
  readonly capabilities: readonly string[];
  readonly codeSha: string | null;
  readonly codeVersion: string | null;
}
const STATE_WORDS: Readonly<Record<string, string>> = { starting: "正在启动", draining: "正在停下（可能在更新）", conflict: "和另一个网关冲突", absent: "没有在运行" };
/**
 * The owner as `identify` describes it, accepted only as Hermes's own clients accept it (hermes_cli/gateway_runtime.py `_endpoint`): runtime protocol 1,
 * this home among its served profiles, `ready`, the session authority advertised, a loopback origin. Anything else is refused, never acted on.
 */
export async function identify(home: string, timeoutMs: number): Promise<GatewayEndpoint> {
  const result = await controlQuery(home, { protocol: 1, verb: "identify", id: 1 }, timeoutMs);
  if (result.runtime_protocol !== 1) throw new ControlError("NATIVE_GATEWAY_INCOMPATIBLE", "这个 Hermes 网关的运行协议不是 HarnessHub 认识的版本（runtime_protocol " + String(result.runtime_protocol).slice(0, 8) + "）。");
  const canonical = await realpath(home).catch(() => resolve(home));
  const profiles = Array.isArray(result.served_profiles) ? result.served_profiles : [];
  let profileId: string | null = null;
  for (const value of profiles) {
    const row = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof row.home !== "string" || typeof row.profile_id !== "string" || !row.profile_id) continue;
    if ((await realpath(row.home).catch(() => resolve(row.home as string))) === canonical) profileId = row.profile_id;
  }
  if (profileId === null) throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关没有在服务这个 Hermes 配置（" + canonical.replace(/^\/Users\/[^/]+/u, "~") + "）。");
  const state = typeof result.state === "string" ? result.state : "unknown";
  if (state !== "ready") throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关" + (STATE_WORDS[state] ?? "不可用（" + state.slice(0, 32) + "）")
    + "，这次没有连接。HarnessHub 不会替你启动或重启它；稍后再试，或运行 hermes gateway status 查看。");
  const capabilities = Array.isArray(result.capabilities) ? result.capabilities.filter((item): item is string => typeof item === "string") : [];
  const missing = REQUIRED.filter(name => !capabilities.includes(name));
  if (missing.length) throw new ControlError("NATIVE_GATEWAY_INCOMPATIBLE", "这个 Hermes 网关缺少 HarnessHub 需要的能力：" + missing.join("、") + "。");
  const epoch = result.authority_epoch, instance = result.instance_id, origin = result.api_origin;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0 || typeof instance !== "string" || !instance) throw new ControlError("INVALID_PROTOCOL", "Hermes gateway identity is invalid");
  let url: URL;
  try { url = new URL(typeof origin === "string" ? origin : ""); } catch { throw new ControlError("INVALID_PROTOCOL", "Hermes gateway origin is invalid"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.port || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash
    || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new ControlError("INVALID_PROTOCOL", "Hermes gateway origin is not a loopback address");
  return { home, apiOrigin: url.origin, profileId, instanceId: instance, epoch, capabilities,
    codeSha: typeof result.code_sha === "string" && /^[0-9a-f]{7,64}$/u.test(result.code_sha) ? result.code_sha : null,
    codeVersion: typeof result.code_version === "string" && result.code_version.length <= 64 ? result.code_version : null };
}
async function ticket(endpoint: GatewayEndpoint, timeoutMs: number): Promise<string> {
  const grant = await controlQuery(endpoint.home, { protocol: 1, id: 1, verb: "session-ticket", params: { profile_id: endpoint.profileId, instance_id: endpoint.instanceId, purpose: "interactive" } }, timeoutMs);
  if (grant.profile_id !== endpoint.profileId || grant.instance_id !== endpoint.instanceId || grant.runtime_protocol !== 1 || typeof grant.ticket !== "string" || !grant.ticket || grant.ticket.length > 1024)
    throw new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "Hermes 的网关在连接时换了身份（可能刚重启），这次没有连接，可以再试一次。");
  return grant.ticket;
}

/** A refusal the owner sent: `error.message` is its bounded reason code (`not_found`, `session_busy`, …), `error.data` its scalar fields. */
export function refusal(error: unknown): ControlError {
  const row = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const data = row.data !== null && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {};
  const reason = typeof row.message === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(row.message) ? row.message : typeof data.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(data.reason) ? data.reason : "request_failed";
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (Object.keys(fields).length >= 8 || !/^[a-z_]{1,32}$/u.test(key)) continue;
    const said = typeof value === "number" || typeof value === "boolean" ? String(value) : typeof value === "string" ? value : null;
    if (said !== null && /^[A-Za-z0-9_.:/-]{1,64}$/u.test(said)) fields[key] = said;
  }
  return new ControlError("REMOTE_ERROR", "Hermes refused the request: " + reason, undefined,
    { code: typeof row.code === "number" ? row.code : 0, message: reason, ...(Object.keys(fields).length ? { fields } : {}) });
}
/** The owner's reason code of a refusal; null for any other failure. */
export function reasonOf(error: unknown): string | null { return error instanceof ControlError && error.code === "REMOTE_ERROR" ? error.remoteMessage ?? null : null; }

/**
 * A tap on the wire for recording a replay (tests/fixtures/hermes/): every frame written and read, as text, after the method list let it pass.
 * Null in the product; a recording script or a test sets it and clears it.
 */
export const wireTap: { record: ((direction: "out" | "in", frame: string) => void) | null } = { record: null };

export interface GatewayHandlers {
  /** One `event` notification's params (`{type, session_id, payload, replay_epoch, seq, execution_generation, admission_id}`). */
  event(params: Record<string, unknown>): void;
  /** A server→client request (`sudo`, `secret`, `clarify`, …); its value is the result, a thrown error the error answer. */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** The connection is gone (the owner closed it, the socket died); requests still waiting have failed with `error`. */
  closed(error: ControlError): void;
}
/** Sent and waited on; a request whose answer was lost is unknown, never known to have failed (`sent` true). */
interface Waiting { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> | undefined }

/**
 * One WebSocket to the owner. Every request goes through the method list (methods.ts) before it is written. A request whose answer was lost
 * (the socket closed after it was written) fails with NATIVE_OUTCOME_UNKNOWN: the owner may have done it. One refused before it was
 * written (the socket was already closing) fails with NATIVE_NOT_SENT: nothing reached the owner.
 */
export class GatewayConnection {
  private readonly waiting = new Map<number, Waiting>();
  private sequence = 0;
  private gone: ControlError | null = null;
  private closing: Promise<void> | null = null;
  private constructor(private readonly socket: WebSocket, readonly endpoint: GatewayEndpoint, private readonly handlers: GatewayHandlers, private readonly maxFrameBytes: number) {
    socket.on("message", (raw: RawData) => this.message(raw));
    socket.on("close", () => this.lost(new ControlError("NATIVE_DISCONNECTED", "Hermes 的网关断开了连接")));
    socket.on("error", () => this.lost(new ControlError("NATIVE_DISCONNECTED", "Hermes 的网关连接出错")));
  }
  /** identify → session-ticket → WebSocket with the ticket subprotocol; the echoed subprotocol must be the protocol's. */
  static async open(home: string, handlers: GatewayHandlers, options: { readonly timeoutMs: number; readonly maxFrameBytes: number }): Promise<GatewayConnection> {
    const endpoint = await identify(home, options.timeoutMs);
    const granted = await ticket(endpoint, options.timeoutMs);
    const url = endpoint.apiOrigin.replace(/^http/u, "ws") + "/api/ws";
    const socket = new WebSocket(url, [GATEWAY_PROTOCOL, TICKET_PREFIX + granted], { perMessageDeflate: false, maxPayload: options.maxFrameBytes, handshakeTimeout: options.timeoutMs, followRedirects: false });
    await new Promise<void>((resolveOpen, reject) => {
      const failed = () => reject(new ControlError("NATIVE_GATEWAY_UNAVAILABLE", "没能连上 Hermes 网关的会话接口（它可能刚重启），这次没有发送任何东西，可以再试一次。"));
      socket.once("open", () => { socket.off("error", failed); resolveOpen(); });
      socket.once("error", failed);
      socket.once("unexpected-response", () => { socket.off("error", failed); failed(); socket.terminate(); });
    });
    if (socket.protocol !== GATEWAY_PROTOCOL) { socket.terminate(); throw new ControlError("NATIVE_GATEWAY_INCOMPATIBLE", "Hermes 网关没有按 hermes-gateway-v1 协议应答，可能需要更新 Hermes。"); }
    return new GatewayConnection(socket, endpoint, handlers, options.maxFrameBytes);
  }
  get failure(): ControlError | null { return this.gone; }
  request(method: string, params: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown> {
    try { assertAllowed(method, params); } catch (error) { return Promise.reject(error); }
    if (this.gone !== null || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new ControlError("NATIVE_NOT_SENT", "Hermes 的网关连接已断开，这个请求没有发出"));
    const id = ++this.sequence;
    return new Promise<unknown>((resolveAnswer, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        reject(new ControlError("NATIVE_OUTCOME_UNKNOWN", "Hermes 的网关没有及时回答 " + method + "，结果未知"));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolveAnswer, reject, timer });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      wireTap.record?.("out", frame);
      this.socket.send(frame, error => {
        if (error === undefined || error === null) return;
        const entry = this.waiting.get(id);
        if (entry === undefined) return;
        this.waiting.delete(id); clearTimeout(entry.timer);
        entry.reject(new ControlError("NATIVE_OUTCOME_UNKNOWN", "发往 Hermes 网关的请求在发送时断开，结果未知"));
      });
    });
  }
  private message(raw: RawData): void {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
    if (text.length > this.maxFrameBytes) return;
    wireTap.record?.("in", text);
    let frame: Record<string, unknown>;
    try { const value: unknown = JSON.parse(text); if (value === null || typeof value !== "object" || Array.isArray(value)) return; frame = value as Record<string, unknown>; } catch { return; }
    if (typeof frame.method === "string") {
      const params = frame.params !== null && typeof frame.params === "object" && !Array.isArray(frame.params) ? frame.params as Record<string, unknown> : {};
      if (frame.id === undefined || frame.id === null) { if (frame.method === "event") this.handlers.event(params); return; }
      const id = frame.id;
      void this.handlers.request(frame.method, params).then(result => this.answer({ jsonrpc: "2.0", id, result }), (error: unknown) => {
        const message = error instanceof ControlError && /^[a-z_]{1,64}$/u.test(error.message) ? error.message : "unsupported";
        this.answer({ jsonrpc: "2.0", id, error: { code: -32601, message, data: { reason: message } } });
      });
      return;
    }
    if (typeof frame.id !== "number") return;
    const entry = this.waiting.get(frame.id);
    if (entry === undefined) return;
    this.waiting.delete(frame.id); clearTimeout(entry.timer);
    if (frame.error !== undefined) entry.reject(refusal(frame.error)); else entry.resolve(frame.result ?? {});
  }
  /** A response to one of the owner's own requests: a frame of its own, not a method, so it is not on the list. */
  private answer(frame: Readonly<Record<string, unknown>>): void {
    if (this.gone !== null || this.socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(frame);
    wireTap.record?.("out", text);
    this.socket.send(text);
  }
  private lost(error: ControlError): void {
    if (this.gone !== null) return;
    this.gone = error;
    for (const [id, entry] of this.waiting) { this.waiting.delete(id); clearTimeout(entry.timer); entry.reject(new ControlError("NATIVE_OUTCOME_UNKNOWN", error.message + "，等待中的请求结果未知")); }
    this.handlers.closed(error);
  }
  close(): Promise<void> {
    this.closing ??= new Promise<void>(resolveClose => {
      if (this.socket.readyState === WebSocket.CLOSED) { this.lost(new ControlError("NATIVE_DISCONNECTED", "closed")); resolveClose(); return; }
      const timer = setTimeout(() => { this.socket.terminate(); }, 2000);
      this.socket.once("close", () => { clearTimeout(timer); resolveClose(); });
      this.socket.close(1000);
    });
    return this.closing;
  }
}
