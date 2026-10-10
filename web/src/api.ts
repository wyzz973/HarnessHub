import { consumeSessionEventStream, SessionStreamError } from "./session-stream.js";
import type { ProviderProtocol, ProviderTarget, ProviderView, ProviderWriteInput } from "../../src/contracts/provider.js";
import type { AuthSession, HarnessView, InstallationLogPage, SessionSummary, SessionView, SessionStreamFrame, WebState } from "../../src/contracts/web.js";
import type { HarnessManagementView, InstallationJobView, ManagementJobInput } from "../../src/contracts/management.js";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunStatus, SelectionRequest } from "../../src/contracts/session.js";
import { commandId, messageId, runId, switchId } from "../../src/contracts/session.js";

export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApiError"; }
}
function invalid(): never { throw new ApiError("INVALID_RESPONSE", "网关返回了无法识别的数据，请重新载入。"); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function number(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : invalid(); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function list<T>(value: unknown, decode: (row: unknown) => T, limit = 2048): readonly T[] {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  return value.map(decode);
}
function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) return invalid();
  return value as T[number];
}
const RUN_STATES = ["queued", "preparing", "running", "settling", "completed", "cancelled", "failed", "unknown"] as const;
const SESSION_STATES = ["open", "closed", "blocked"] as const;
export const PROVIDER_PROTOCOLS = ["openai-responses", "openai-chat-completions", "anthropic-messages", "gemini"] as const;
function target(value: unknown): ProviderTarget {
  const row = record(value);
  return { providerId: text(row.providerId), revision: number(row.revision), model: text(row.model) };
}
function selection(value: unknown): HarnessSelection {
  const row = record(value);
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), ...(row.provider === undefined ? {} : { provider: target(row.provider) }) };
}
function requestedSelection(value: unknown): SelectionRequest {
  const row = record(value);
  return { harnessId: text(row.harnessId), ...(row.controlId === undefined ? {} : { controlId: text(row.controlId) }),
    ...(row.provider === undefined ? {} : { provider: row.provider === null ? null : target(row.provider) }) };
}
function publicError(value: unknown): { code: string; message: string } | null {
  if (value === null) return null;
  const row = record(value); return { code: text(row.code), message: text(row.message) };
}
export function decodeProvider(value: unknown): ProviderView {
  const row = record(value);
  return { id: text(row.id), revision: number(row.revision), name: text(row.name), protocol: choice(row.protocol, PROVIDER_PROTOCOLS),
    baseUrl: text(row.baseUrl), models: list(row.models, text, 256), defaultModel: text(row.defaultModel), enabled: bool(row.enabled), hasCredential: bool(row.hasCredential) };
}
function decodeHarness(value: unknown): HarnessView {
  const row = record(value);
  return { id: text(row.id), name: text(row.name), installed: bool(row.installed), defaultControlId: nullableText(row.defaultControlId), providerProtocols: list(row.providerProtocols, text, 16), management: decodeManagement(row.management),
    controls: list(row.controls, value => { const control = record(value); return { id: text(control.id), protocol: text(control.protocol), available: bool(control.available), reason: nullableText(control.reason) }; }, 64) };
}
function decodeManagement(value: unknown): HarnessManagementView {
  const row = record(value), recipe = row.recipe === null ? null : record(row.recipe);
  return { harnessId: text(row.harnessId), recipe: recipe === null ? null : { controlId: text(recipe.controlId), kind: choice(recipe.kind, ["npm", "python", "binary"]), sourceLabel: text(recipe.sourceLabel), packageName: nullableText(recipe.packageName), referenceVersion: nullableText(recipe.referenceVersion), canInstall: bool(recipe.canInstall), reason: nullableText(recipe.reason) },
    source: choice(row.source, ["managed", "system", "missing"]), installedVersion: nullableText(row.installedVersion), latestVersion: nullableText(row.latestVersion), updateStatus: choice(row.updateStatus, ["unchecked", "checking", "available", "current", "failed", "unsupported"]), checkedAt: nullableText(row.checkedAt), activeJobId: nullableText(row.activeJobId), installationId: nullableText(row.installationId), defaultRevision: number(row.defaultRevision), error: publicError(row.error) };
}
export function decodeInstallationJob(value: unknown): InstallationJobView {
  const row = record(value);
  return { id: text(row.id), harnessId: text(row.harnessId), controlId: text(row.controlId), action: choice(row.action, ["install", "upgrade"]), status: choice(row.status, ["queued", "resolving", "installing", "verifying", "activating", "completed", "cancelled", "failed", "unknown"]), phase: text(row.phase), cancelRequested: bool(row.cancelRequested), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt), resolvedVersion: nullableText(row.resolvedVersion), installationId: nullableText(row.installationId), error: publicError(row.error), logCursor: number(row.logCursor) };
}
function decodeLogPage(value: unknown): InstallationLogPage {
  const row = record(value);
  return { entries: list(row.entries, value => { const item = record(value); return { seq: number(item.seq), time: text(item.time), stream: choice(item.stream, ["stdout", "stderr", "system"]), text: text(item.text) }; }, 256), nextSeq: number(row.nextSeq), hasMore: bool(row.hasMore) };
}
function decodeSummary(value: unknown): SessionSummary {
  const row = record(value);
  return { id: text(row.id), title: text(row.title), status: choice(row.status, SESSION_STATES), workspace: text(row.workspace),
    selection: selection(row.selection), updatedSeq: number(row.updatedSeq), activeRunId: nullableText(row.activeRunId) };
}
function decodeMessage(value: unknown): PublicMessage {
  const row = record(value);
  return { id: messageId(row.id), runId: runId(row.runId), role: choice(row.role, ["user", "assistant"]), text: text(row.text), seq: number(row.seq), status: choice(row.status, RUN_STATES) };
}
function decodeRun(value: unknown): PublicRun {
  const row = record(value);
  const backend = row.backend === null ? null : record(row.backend);
  const cleanup = row.cleanup === null ? null : record(row.cleanup);
  if (cleanup !== null && cleanup.closed !== true) return invalid();
  return { id: runId(row.id), commandId: commandId(row.commandId), input: text(row.input), userMessageId: messageId(row.userMessageId),
    assistantMessageId: messageId(row.assistantMessageId), selection: selection(row.selection), epoch: number(row.epoch),
    status: choice(row.status, RUN_STATES), cancelRequested: bool(row.cancelRequested), contextThroughSeq: number(row.contextThroughSeq),
    sourceRunIds: list(row.sourceRunIds, runId, 256), backend: backend === null ? null : { status: choice(backend.status, ["completed", "cancelled", "failed"]), reason: text(backend.reason) },
    cleanup: cleanup === null ? null : { closed: true, exitCode: nullableNumber(cleanup.exitCode), signal: nullableText(cleanup.signal), protocolFailure: publicError(cleanup.protocolFailure) },
    error: publicError(row.error), stopRequested: bool(row.stopRequested), awaitingSwitchId: row.awaitingSwitchId === null ? null : switchId(row.awaitingSwitchId) };
}
function decodeSwitch(value: unknown): PublicSwitch {
  const row = record(value);
  return { id: switchId(row.id), commandId: commandId(row.commandId), requested: requestedSelection(row.requested), requestedSeq: number(row.requestedSeq),
    target: row.target === null ? null : selection(row.target), status: choice(row.status, ["requested", "validated", "effective", "failed"]),
    throughSeq: number(row.throughSeq), sourceRunIds: list(row.sourceRunIds, runId, 256), error: publicError(row.error) };
}
export function decodeSession(value: unknown): SessionView {
  const row = record(value);
  return { id: text(row.id), version: number(row.version), lastSeq: number(row.lastSeq), epoch: number(row.epoch), status: choice(row.status, SESSION_STATES),
    workspace: text(row.workspace), selection: selection(row.selection), activeRunId: nullableText(row.activeRunId), pendingSwitchId: nullableText(row.pendingSwitchId),
    messages: list(row.messages, decodeMessage, 1024), runs: list(row.runs, decodeRun, 256), switches: list(row.switches, decodeSwitch, 1024) };
}
/** Decodes only canonical public facts; stream framing and projection validate their watermarks. */
export function decodeSessionStreamFrame(value: unknown): SessionStreamFrame {
  const row = record(value);
  const keys = row.type === "snapshot" ? ["type", "session"] : ["type", "sessionId", "version", "lastSeq", "message"];
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) return invalid();
  if (row.type === "snapshot") return { type: "snapshot", session: decodeSession(row.session) };
  if (row.type !== "message") return invalid();
  const version = number(row.version), lastSeq = number(row.lastSeq), message = decodeMessage(row.message);
  if (version < 1 || lastSeq < 0 || message.role !== "assistant" || message.seq < 0 || message.seq > lastSeq) return invalid();
  return { type: "message", sessionId: text(row.sessionId), version, lastSeq, message };
}
function decodeState(value: unknown): WebState {
  const row = record(value);
  return { workspace: text(row.workspace), providers: list(row.providers, decodeProvider, 256), harnesses: list(row.harnesses, decodeHarness, 256), sessions: list(row.sessions, decodeSummary, 1000), jobs: list(row.jobs, decodeInstallationJob, 100) };
}
function decodeAuth(value: unknown): AuthSession { return { csrfToken: text(record(value).csrfToken) }; }
function acknowledge(value: unknown, session: string, result: "runId" | "switchId" | "target"): void {
  const row = record(value);
  if (row.sessionId !== session || Object.keys(row).some(key => !["sessionId", result, "replayed"].includes(key))) return invalid();
  bool(row.replayed);
  try {
    if (result === "switchId") switchId(text(row.switchId));
    else if (result === "runId") runId(text(row.runId));
    else if (row.target !== null) runId(text(row.target));
  } catch { return invalid(); }
}

let pageBootstrapToken: string | null | undefined;
function bootstrapToken(): string | null {
  // React may invoke state initializers twice. Read and clear the URL exactly once for this page.
  if (pageBootstrapToken !== undefined) return pageBootstrapToken;
  pageBootstrapToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (pageBootstrapToken !== null) {
    const hash = new URLSearchParams(window.location.hash.slice(1)); hash.delete("token");
    window.history.replaceState(null, "", window.location.pathname + window.location.search + (hash.size ? "#" + hash.toString() : ""));
  }
  return pageBootstrapToken;
}
/** One browser tab owns authentication and requests. Credentials only travel to the same-origin local API. */
export class GatewayApi {
  private csrfToken: string | null = null;
  private bootstrapToken: string | null = null;
  private authentication: Promise<void> | null = null;
  constructor() {
    this.bootstrapToken = bootstrapToken();
  }
  async authenticate(signal?: AbortSignal): Promise<void> {
    if (this.csrfToken !== null) return;
    if (this.authentication !== null) return this.authentication;
    this.authentication = this.authenticateOnce(signal);
    try { await this.authentication; } finally { this.authentication = null; }
  }
  private async authenticateOnce(signal?: AbortSignal): Promise<void> {
    let auth: AuthSession;
    if (this.bootstrapToken === null) auth = await this.request("/auth/session", "GET", undefined, decodeAuth, signal);
    else {
      try { auth = await this.request("/auth/bootstrap", "POST", { token: this.bootstrapToken }, decodeAuth, signal); }
      catch (error: unknown) {
        if (!(error instanceof ApiError) || error.code !== "AUTH_REQUIRED") throw error;
        // A reused launch URL cannot consume its token again; an existing authenticated cookie may still be valid.
        auth = await this.request("/auth/session", "GET", undefined, decodeAuth, signal);
      }
    }
    this.csrfToken = auth.csrfToken;
    this.bootstrapToken = null;
    pageBootstrapToken = null;
  }
  state(signal?: AbortSignal): Promise<WebState> { return this.request("/state", "GET", undefined, decodeState, signal); }
  session(id: string, signal?: AbortSignal): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}`, "GET", undefined, decodeSession, signal); }
  /** Owns one cancellable fact stream; reconnecting never submits a conversation command. */
  async streamSession(id: string, afterSeq: number, signal: AbortSignal, onFrame: (frame: SessionStreamFrame) => void): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Session stream deadline exceeded", "TimeoutError")), 75_000);
    const attempt = AbortSignal.any([signal, deadline.signal]);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/v1/sessions/${encodeURIComponent(id)}/events/stream?afterSeq=${afterSeq}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: attempt, headers: { Accept: "text/event-stream" },
        });
      } catch (error: unknown) {
        if (attempt.aborted) throw error;
        throw new ApiError("NETWORK_ERROR", "实时回复连接中断，历史和草稿已保留。");
      }
      if (!response.ok) {
        const error = publicError(await readBoundedJson(response));
        throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "实时回复连接未能建立。");
      }
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || response.body === null) {
        await response.body?.cancel(); return invalid();
      }
      let opened = false;
      await consumeSessionEventStream(response.body, { signal: attempt, decode: decodeSessionStreamFrame, maxFrameBytes: 8 * 1024 * 1024, onFrame: frame => {
        if (!opened && frame.type !== "snapshot") throw new ApiError("STREAM_PROTOCOL", "实时连接缺少起始会话事实。");
        opened = true; onFrame(frame);
      } });
      if (!opened) throw new ApiError("STREAM_PROTOCOL", "实时连接没有返回会话事实。");
    } finally { clearTimeout(timeout); }
  }
  createSession(workspace: string, selection: SelectionRequest, key: string): Promise<SessionView> {
    return this.request("/sessions", "POST", { workspace, selection, commandId: key }, decodeSession);
  }
  async send(id: string, value: string, key: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/messages`, "POST", { text: value, commandId: key }, value => acknowledge(value, id, "runId"));
  }
  async switchSelection(id: string, selection: SelectionRequest, key: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/switches`, "POST", { selection, commandId: key }, value => acknowledge(value, id, "switchId"));
  }
  async resumeSelection(id: string, selection: SelectionRequest, key: string, acknowledgeUnknown: boolean): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/resume`, "POST", { selection, commandId: key, acknowledgeUnknown }, value => acknowledge(value, id, "switchId"));
  }
  async cancel(id: string, key: string): Promise<void> { await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key }, value => acknowledge(value, id, "target")); }
  closeSession(id: string, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/close`, "POST", { commandId: key }, decodeSession); }
  writeProvider(input: ProviderWriteInput, key: string, current?: ProviderView): Promise<ProviderView> {
    return this.request(current ? `/providers/${encodeURIComponent(current.id)}` : "/providers", current ? "PATCH" : "POST",
      { input, commandId: key, ...(current ? { expectedRevision: current.revision } : {}) }, decodeProvider);
  }
  async probeProvider(id: string): Promise<readonly string[]> {
    return this.request(`/providers/${encodeURIComponent(id)}/probe`, "POST", {}, value => {
      const row = record(value); if (row.status !== "models_reachable") return invalid(); return list(row.models, text, 1024);
    });
  }
  async rescan(signal?: AbortSignal): Promise<readonly HarnessView[]> {
    return this.request("/harnesses/rescan", "POST", {}, value => list(value, decodeHarness, 256), signal);
  }
  checkUpdates(harnessIds?: readonly string[]): Promise<readonly HarnessView[]> {
    return this.request("/harnesses/check-updates", "POST", harnessIds ? { harnessIds } : {}, value => list(value, decodeHarness, 256));
  }
  submitInstallation(input: ManagementJobInput): Promise<InstallationJobView> { return this.request("/installation-jobs", "POST", input, decodeInstallationJob); }
  jobs(signal?: AbortSignal): Promise<readonly InstallationJobView[]> { return this.request("/installation-jobs?limit=50", "GET", undefined, value => list(value, decodeInstallationJob, 100), signal); }
  cancelInstallation(id: string, key: string): Promise<InstallationJobView> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key }, decodeInstallationJob); }
  installationLogs(id: string, afterSeq: number, signal?: AbortSignal): Promise<InstallationLogPage> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/logs?afterSeq=${afterSeq}&limit=50`, "GET", undefined, decodeLogPage, signal); }
  private async request<T>(path: string, method: "GET" | "POST" | "PATCH", body: unknown, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError")), 15_000);
    const attempt = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const response = await fetch("/api/v1" + path, { method, credentials: "same-origin", signal: attempt,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.csrfToken === null || method === "GET" ? {} : { "X-CSRF-Token": this.csrfToken }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        const error = publicError(payload);
        throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "请求未能完成。");
      }
      return decode(payload);
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof ApiError) throw error;
      if (deadline.signal.aborted) throw new ApiError("REQUEST_TIMEOUT", "请求响应超时，请确认已接收的结果后重试。");
      throw new ApiError("NETWORK_ERROR", "暂时无法连接本机网关。请确认服务仍在运行，再试一次。");
    } finally { clearTimeout(timeout); }
  }
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 16 * 1024 * 1024) { await reader.cancel(); return invalid(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return value; }
  catch { return invalid(); }
}
export function requestKey(): string { return "web-" + crypto.randomUUID(); }
export function errorMessage(error: unknown): string {
  if (error instanceof SessionStreamError) return "实时回复状态暂时无法同步，历史和草稿已保留。";
  if (error instanceof DOMException && error.name === "TimeoutError") return "网关响应超时，请稍后重试。";
  return error instanceof ApiError ? failureMessage(error) : error instanceof Error ? error.message : "请求未能完成，请重试。";
}
/** Product copy for stable public failures; raw diagnostics never become recovery instructions. */
export function failureMessage(failure: { readonly code: string; readonly message: string }): string {
  const labels: Readonly<Record<string, string>> = {
    GATEWAY_AUTH_REQUIRED: "这个 Harness 尚未配置 Gateway 认证。请补充连接配置，或选择另一个 Harness 继续。",
    PROCESS_EXITED: "Harness 提前退出了。历史已保留，可以重试或选择其他 Harness。",
    REMOTE_ERROR: "Harness 拒绝了这次请求。请检查连接配置，或选择其他 Harness。",
    SWITCH_NOT_EFFECTIVE: "这条消息尚未执行，因为选择切换失败。重新选择后，可明确重发这条消息。",
    HARNESS_UNAVAILABLE: "这个 Harness 当前不可用。请选择其他 Harness，或到 Harnesses 检查安装。",
    PROVIDER_DISABLED: "所选 Provider 已停用。请选择其他连接，或到 Providers 启用它。",
    WORKSPACE_BUSY: "工作区正被另一项任务使用。可以等待它结束，或为新对话选择其他工作区。",
    WORKSPACE_QUARANTINED: "工作区仍有未核实的执行资源。请先核实并停止相关进程；历史和草稿已保留。",
  };
  return labels[failure.code] ?? failure.message;
}
export function protocolLabel(protocol: ProviderProtocol | string): string {
  const labels: Record<string, string> = { "openai-responses": "OpenAI Responses", "openai-chat-completions": "OpenAI Chat", "anthropic-messages": "Anthropic Messages", gemini: "Gemini", "acp-v1": "ACP", "codex-app-server": "Codex 原生", "pi-rpc": "Pi RPC" };
  return labels[protocol] ?? protocol;
}
export function runStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = { queued: "等待中", preparing: "准备中", running: "正在回复", settling: "正在结束", completed: "本轮结束", cancelled: "已停止", failed: "执行失败", unknown: "结果待核实" };
  return labels[status];
}
