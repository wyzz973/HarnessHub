import { isAbsolute } from "node:path";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent,
  type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl,
  type NativeOptions, type NativeOption, type NativeConversationId, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { ControlError, errorFrom, JsonRpcProcess, object, string, text, type RpcRequest } from "../../infrastructure/control/json-rpc-process.js";
import { diffPath } from "../../infrastructure/control/unified-diff.js";
import type { NativeToolDetail, NativeUsage } from "../../contracts/control.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_CONTENT_BYTES } from "../../contracts/content.js";

interface ActiveTurn {
  readonly event: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly started: Promise<void>;
  readonly signalStarted: () => void;
  readonly rejectStarted: (error: Error) => void;
  readonly deltaItems: Set<string>;
  /** Tool items of this turn with their accumulated native detail; streamed output is published at most every 300 ms. */
  readonly items: Map<string, { title: string; status: string; detail: NativeToolDetail; timer: ReturnType<typeof setTimeout> | null }>;
  /** Generated-image reads still in flight; the turn settles only after they are delivered or dropped. */
  readonly reads: Set<Promise<void>>;
  /** Thread token totals before this turn (including a historical total reported at turn start); turn usage is the difference. */
  baseline: Tokens | null;
  turnId: string | null;
  settled: boolean;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
}
interface Tokens { readonly totalTokens: number; readonly inputTokens: number; readonly cachedInputTokens: number; readonly cacheWriteInputTokens: number; readonly outputTokens: number; readonly reasoningOutputTokens: number }
const STREAM_MS = 300, ITEM_OUTPUT_BYTES = 128 * 1024;
function tokens(value: unknown): Tokens | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>, read = (key: string) => typeof row[key] === "number" && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 ? row[key] as number : 0;
  return { totalTokens: read("totalTokens"), inputTokens: read("inputTokens"), cachedInputTokens: read("cachedInputTokens"), cacheWriteInputTokens: read("cacheWriteInputTokens"), outputTokens: read("outputTokens"), reasoningOutputTokens: read("reasoningOutputTokens") };
}
function line(value: string, maximum = 4096): string { return value.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, maximum); }
function json(value: unknown): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return undefined; } }
function tail(value: string): string { const bytes = Buffer.from(value); return bytes.length <= ITEM_OUTPUT_BYTES ? value : new TextDecoder().decode(bytes.subarray(bytes.length - ITEM_OUTPUT_BYTES)); }
function fileDiff(change: unknown): string {
  if (change === null || typeof change !== "object") return "";
  const row = change as Record<string, unknown>, path = typeof row.path === "string" ? row.path : "file", diff = typeof row.diff === "string" ? row.diff : "";
  return /^(---|diff --git)/mu.test(diff) ? diff.endsWith("\n") ? diff : diff + "\n" : "--- a/" + diffPath(path) + "\n+++ b/" + diffPath(path) + "\n" + diff + (diff.endsWith("\n") ? "" : "\n");
}
/** Public title and bounded detail for a Codex tool-like item; message, reasoning and lifecycle items return null. */
function itemTool(item: Record<string, unknown>): { title: string; detail: NativeToolDetail } | null {
  switch (item.type) {
    case "commandExecution": { const command = typeof item.command === "string" ? item.command : "";
      return { title: line(command) || "命令", detail: { kind: "execute", name: "shell", ...(command ? { input: command } : {}), ...(typeof item.aggregatedOutput === "string" ? { output: tail(item.aggregatedOutput) } : {}), ...(typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode } : {}), ...(typeof item.cwd === "string" ? { locations: [item.cwd] } : {}) } }; }
    case "fileChange": { const changes = Array.isArray(item.changes) ? item.changes : [], paths = changes.flatMap(change => change !== null && typeof change === "object" && typeof (change as Record<string, unknown>).path === "string" ? [(change as Record<string, unknown>).path as string] : []);
      return { title: "修改 " + (paths.slice(0, 3).map(path => basename(path)).join(", ") || "文件") + (paths.length > 3 ? " 等 " + paths.length + " 个文件" : ""), detail: { kind: "edit", name: "apply_patch", ...(changes.length ? { diff: changes.map(fileDiff).join("") } : {}), ...(paths.length ? { locations: paths.slice(0, 16) } : {}) } }; }
    case "mcpToolCall": { const name = String(item.server ?? "mcp") + "/" + String(item.tool ?? "tool"), result = item.result !== null && typeof item.result === "object" ? item.result as Record<string, unknown> : null, error = item.error !== null && typeof item.error === "object" ? (item.error as Record<string, unknown>).message : undefined;
      const texts = Array.isArray(result?.content) ? result.content.flatMap(part => part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []) : [];
      const output = typeof error === "string" ? error : texts.length ? texts.join("\n") : json(result?.structuredContent ?? result ?? undefined), input = json(item.arguments);
      return { title: line(name.replace("/", ".")), detail: { kind: "mcp", name, ...(input ? { input } : {}), ...(output ? { output } : {}) } }; }
    case "webSearch": { const query = typeof item.query === "string" ? item.query : "";
      return { title: "搜索：" + (line(query, 200) || "网页"), detail: { kind: "search", name: "web_search", ...(query ? { input: query } : {}), ...(item.results != null ? { output: json(item.results) ?? "" } : {}) } }; }
    case "imageView": return { title: "查看图片 " + (typeof item.path === "string" ? basename(item.path) : ""), detail: { kind: "image", name: "view_image", ...(typeof item.path === "string" ? { locations: [item.path] } : {}) } };
    case "imageGeneration": return { title: "生成图片", detail: { kind: "image", name: "image_generation", ...(typeof item.revisedPrompt === "string" ? { input: item.revisedPrompt } : {}), ...(typeof item.savedPath === "string" ? { locations: [item.savedPath] } : {}) } };
    case "collabAgentToolCall": { const states = item.agentsStates !== null && typeof item.agentsStates === "object" ? Object.entries(item.agentsStates as Record<string, unknown>).map(([thread, state]) => thread + ": " + String(state !== null && typeof state === "object" ? (state as Record<string, unknown>).status : state)).join("\n") : "";
      return { title: "子 Agent · " + String(item.tool ?? "协作"), detail: { kind: "subagent", name: String(item.tool ?? "collab"), ...(typeof item.prompt === "string" ? { input: item.prompt } : {}), ...(states ? { output: states } : {}) } }; }
    case "dynamicToolCall": { const texts = Array.isArray(item.contentItems) ? item.contentItems.flatMap(part => part !== null && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []) : [], input = json(item.arguments);
      return { title: line(String(item.tool ?? "工具")), detail: { kind: "tool", name: String(item.tool ?? "tool"), ...(input ? { input } : {}), ...(texts.length ? { output: texts.join("\n") } : {}) } }; }
    case "sleep": return { title: "等待 " + Math.round(Number(item.durationMs ?? 0) / 1000) + " 秒", detail: { kind: "other", name: "sleep" } };
    default: return null;
  }
}
function status(value: unknown, started: boolean): string { return value === "inProgress" ? "in_progress" : typeof value === "string" ? value : started ? "in_progress" : "completed"; }
const passiveNotifications = new Set(["thread/started", "thread/status/changed", "account/updated", "account/rateLimits/updated",
  "sessionConfigured", "turn/diff/updated", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/fileChange/outputDelta", "serverRequest/resolved", "thread/name/updated", "skills/changed", "hook/started", "hook/completed", "mcpServer/startupStatus/updated"]);

/** Typed native failure (codexErrorInfo) first; message text is only a fallback for older servers. */
function turnFailure(error: Record<string, unknown>): { readonly code: string; readonly message: string } {
  const info = error.codexErrorInfo, kind = typeof info === "string" ? info : info !== null && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const message = typeof error.message === "string" ? error.message : "";
  if (kind === "unauthorized" || kind === undefined && /unauthorized|not logged|authentication|api key|401/iu.test(message)) return { code: "HARNESS_AUTH_REQUIRED", message: "本机 Codex 登录或模型认证不可用，请检查它的登录状态。" };
  if (kind === "usageLimitExceeded" || kind === "sessionBudgetExceeded") return { code: "NATIVE_QUOTA_EXCEEDED", message: "Codex 账号额度或本会话预算已用完。可等待额度恢复，或选择其他 Harness 继续。" };
  if (kind === "rateLimitExceeded" || kind === "serverOverloaded" || kind === undefined && /rate limit|quota|429/iu.test(message)) return { code: "MODEL_RATE_LIMIT", message: "模型服务当前达到额度或调用限制，请稍后再试。" };
  if (kind === "contextWindowExceeded") return { code: "CONTEXT_WINDOW_EXCEEDED", message: "对话已超过模型上下文窗口。可以压缩原生上下文或重新建立原生会话后继续。" };
  if (kind === "httpConnectionFailed" || kind === "responseStreamConnectionFailed" || kind === "responseStreamDisconnected" || kind === "responseTooManyFailedAttempts") return { code: "NATIVE_CONNECTION_FAILED", message: "Codex 无法连接模型服务。请检查网络或本机配置后重试。" };
  if (kind === "cyberPolicy" || kind === "misalignmentPolicyViolation") return { code: "MODEL_POLICY_REFUSED", message: "模型服务按其策略拒绝了这次请求。" };
  return { code: "MODEL_REQUEST_FAILED", message: "Codex 的模型请求未完成，请检查本机配置或更换模型。" };
}
/** Codex app-server anti-corruption layer; native thread and turn IDs never become public Session IDs. */
export class CodexControl implements HarnessControl {
  private readonly rpc: JsonRpcProcess;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private conversation: NativeConversationId | null = null;
  private opening = false;
  private effort: string | undefined;
  private interactivePermissions = false;
  private readonly permissions = new Map<string, { options: readonly string[]; resolve: (value: unknown) => void; reply: (option: string, input?: string) => unknown }>();
  private active: ActiveTurn | null = null;
  private failure: Error | null = null;
  private readonly turnIds = new Set<string>();
  /** Threads the app-server attached to this connection (sub-agents, reviews, internal workers) with their parent. */
  private readonly foreignThreads = new Map<string, string | null>();
  private foreignUpdates = 0;
  /** Latest thread token totals, including historical totals reported on resume. */
  private lastTotal: Tokens | null = null;

  constructor(launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "codex-app-server") throw new ControlError("INVALID_INPUT", "Codex control requires an app-server launch");
    this.rpc = new JsonRpcProcess(launch, options, {
      notification: (method, params) => this.notification(method, params), request: request => this.serverRequest(request),
      failure: error => {
        this.failure = error;
        if (this.active) this.failTurn(this.active, error);
      },
    });
  }
  initialize(): Promise<ProtocolObservation> {
    if (this.failure) return Promise.reject(this.failure);
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      const response = object(await this.rpc.request("initialize", {
        clientInfo: { name: "harnessgateway", title: "HarnessGateway", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }), "Codex initialize result");
      const userAgent = string(response.userAgent, "Codex user agent", 4096);
      await this.rpc.notify("initialized", {});
      this.initialized = true;
      return { protocol: "codex-app-server", protocolVersion: null, agentName: "codex", agentVersion: null,
        authenticationMethods: [], capabilities: { userAgent, experimentalApi: false } };
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const config = object(await this.rpc.request("config/read", { includeLayers: false, cwd: this.options.cwd }), "native configuration");
    const configured = object(config.config, "effective native configuration");
    const account = object(await this.rpc.request("account/read", { refreshToken: false }), "native account status");
    const models: { id: string; name: string; options?: readonly NativeOption[] }[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const response = object(await this.rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }) }), "native models");
      if (!Array.isArray(response.data) || response.data.length > 100) throw new ControlError("INVALID_PROTOCOL", "invalid native model page");
      for (const value of response.data) {
        const row = object(value, "native model"), id = string(row.model, "model", 1024), name = string(row.displayName, "model name", 1024);
        if (seen.has(id)) throw new ControlError("INVALID_PROTOCOL", "duplicate native model");
        let options: NativeOption[] | undefined;
        if (row.supportedReasoningEfforts !== undefined) {
          if (!Array.isArray(row.supportedReasoningEfforts) || row.supportedReasoningEfforts.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid reasoning effort catalog");
          const values = row.supportedReasoningEfforts.map(value => { const level = object(value, "reasoning effort"); const valueId = string(level.reasoningEffort, "reasoning effort", 128); return { value: valueId, name: valueId }; });
          const currentValue = id === configured.model && typeof configured.model_reasoning_effort === "string" ? configured.model_reasoning_effort : string(row.defaultReasoningEffort, "default reasoning effort", 128);
          if (values.length && !values.some(row => row.value === currentValue)) throw new ControlError("INVALID_PROTOCOL", "configured reasoning effort unavailable");
          if (values.length) options = [{ id: "reasoning_effort", name: "思考强度", category: "thought_level", currentValue, values }];
        }
        seen.add(id); models.push({ id, name, ...(options ? { options } : {}) });
        if (models.length > 4095) throw new ControlError("MODEL_LIMIT", "native model catalog exceeds its bounds");
      }
      if (response.nextCursor === null || response.nextCursor === undefined) break;
      const next = string(response.nextCursor, "model cursor", 1024);
      if (next === cursor || models.length >= 4096 || page === 63) throw new ControlError("MODEL_LIMIT", "native model catalog exceeds its bounds");
      cursor = next;
    }
    const defaultModel = configured.model == null ? null : string(configured.model, "configured model", 1024);
    if (defaultModel !== null && !seen.has(defaultModel)) models.unshift({ id: defaultModel, name: defaultModel });
    return { models, defaultModel, canSelect: models.length > 0, authentication: account.requiresOpenaiAuth === false || account.account != null ? "ready" : account.requiresOpenaiAuth === true ? "missing" : "unknown" };
  }
  async checkpoint(): Promise<string | null> { return this.conversation; }
  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation || this.opening) throw new ControlError("INVALID_STATE", "this connection already owns a thread");
    this.opening = true;
    try {
      if (model !== undefined || Object.keys(native ?? {}).length) {
        const catalog = await this.models(), selected = catalog.models.find(row => row.id === (model ?? catalog.defaultModel));
        if (!selected) throw new ControlError("MODEL_UNAVAILABLE", "selected model is not in this Harness native catalog");
        for (const [id, value] of Object.entries(native ?? {})) {
          if (id !== "reasoning_effort" || !selected.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "reasoning effort unavailable for selected native model");
          this.effort = value;
        }
      }
      if (checkpoint !== undefined) this.conversation = nativeConversationId(checkpoint);
      // A cold start or a long thread resume loads native state before answering; bounded by the run budget.
      const response = object(await this.rpc.request(checkpoint === undefined ? "thread/start" : "thread/resume", {
        cwd, ...(checkpoint === undefined ? { ephemeral: false } : { threadId: nativeConversationId(checkpoint), excludeTurns: true }), ...(model === undefined ? {} : { model }),
      }, Math.max(this.options.requestTimeoutMs, Math.min(60000, this.options.runTimeoutMs))), "native thread setup result");
      const thread = object(response.thread, "Codex thread");
      const received = nativeConversationId(thread.id);
      if (checkpoint !== undefined && received !== checkpoint) throw new ControlError("IDENTITY_MISMATCH", "native restore returned a different thread");
      if (this.conversation && this.conversation !== received) throw new ControlError("IDENTITY_MISMATCH", "thread/start response does not match thread/started");
      this.conversation = received;
      return received;
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
    finally { this.opening = false; }
  }
  async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void): Promise<ControlRun> {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "thread is not owned by this connection");
    if (this.active) throw new ControlError("INVALID_STATE", "a turn is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    let resolve!: (value: BackendResult) => void, reject!: (error: Error) => void;
    const result = new Promise<BackendResult>((res, rej) => { resolve = res; reject = rej; });
    let signalStarted!: () => void, rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((res, rej) => { signalStarted = res; rejectStarted = rej; });
    // The promise is also consumed by requestStop(); attach rejection ownership before any failure can occur.
    void started.catch(() => {});
    const active: ActiveTurn = { event: onEvent, resolve, reject,
      timer: setTimeout(() => this.rpc.abort(new ControlError("RUN_TIMEOUT", "Codex turn exceeded its deadline")), this.options.runTimeoutMs),
      started, signalStarted, rejectStarted, turnId: null, settled: false, stopping: false, stop: null, deltaItems: new Set(), items: new Map(), reads: new Set(), baseline: this.lastTotal };
    this.active = active;
    void this.rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: prompt, text_elements: [] }], ...(this.effort === undefined ? {} : { effort: this.effort }) }).then(value => {
      try {
        const response = object(value, "turn/start result"), turn = object(response.turn, "Codex turn");
        this.bindTurn(active, string(turn.id, "Codex turn identity"));
        const status = string(turn.status, "Codex turn status");
        if (!["inProgress", "completed", "interrupted", "failed"].includes(status)) throw new ControlError("INVALID_PROTOCOL", "unknown turn status");
        active.signalStarted();
      } catch (error) { this.rpc.abort(errorFrom(error)); }
    }, (error: unknown) => {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && active.turnId === null && this.rpc.failure === null) {
        this.settleTurn(active); active.resolve({ status: "failed", reason: "request_rejected" });
      } else this.rpc.abort(errorFrom(error));
    });
    return { result, requestStop: () => {
      if (active.stop) return active.stop;
      if (active.settled || this.active !== active) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      active.stopping = true; this.cancelPermissions();
      active.stop = this.stopTurn(active, id);
      return active.stop;
    } };
  }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); return this.rpc.close(); }
  private async stopTurn(active: ActiveTurn, id: NativeConversationId): Promise<StopRequestReceipt> {
    await active.started;
    if (active.settled || !active.turnId) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
    try {
      const response = object(await this.rpc.request("turn/interrupt", { threadId: id, turnId: active.turnId }), "turn/interrupt result");
      if (Object.keys(response).length !== 0) throw new ControlError("INVALID_PROTOCOL", "interrupt receipt must be empty");
      return { requested: true };
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private bindTurn(active: ActiveTurn, id: string): void {
    if (active.turnId !== null) {
      if (active.turnId !== id) throw new ControlError("IDENTITY_MISMATCH", "Codex turn identity changed");
      return;
    }
    if (this.turnIds.has(id)) throw new ControlError("DUPLICATE_TURN", "Codex reused a turn identity");
    if (this.turnIds.size >= 4096) throw new ControlError("TURN_LIMIT", "turn identity budget exhausted");
    this.turnIds.add(id); active.turnId = id; active.signalStarted();
  }
  private scope(params: Record<string, unknown>, requireTurn = false): ActiveTurn | null {
    if (!this.conversation || string(params.threadId, "Codex thread identity") !== this.conversation)
      throw new ControlError("IDENTITY_MISMATCH", "Codex message belongs to another thread");
    // Thread accounting can refer to a historical turn immediately after native resume.
    // Only turn-owned output/control may bind the current turn's identity.
    if (requireTurn) {
      const active = this.active;
      if (!active || active.settled) throw new ControlError("INVALID_STATE", "Codex output arrived without an active turn");
      this.bindTurn(active, string(params.turnId, "Codex turn identity"));
      return active;
    }
    if (params.turnId !== undefined) string(params.turnId, "Codex metadata turn identity");
    return this.active;
  }
  private foreign(id: string, parent: string | null): void {
    if (!this.foreignThreads.has(id) && this.foreignThreads.size >= 1024) throw new ControlError("THREAD_LIMIT", "foreign Codex thread budget exhausted");
    if (!this.foreignThreads.has(id) || parent !== null) this.foreignThreads.set(id, parent);
  }
  /** A sub-agent spawned (directly or transitively) by the owned thread works for the active public Run. */
  private descendant(id: string): boolean {
    let parent = this.foreignThreads.get(id) ?? null;
    for (let depth = 0; parent !== null && depth < 32; depth++) { if (parent === this.conversation) return true; parent = this.foreignThreads.get(parent) ?? null; }
    return false;
  }
  /** Request owner: the active Turn for the owned thread or its sub-agents; unrelated workers are never approved for the user. */
  private requestOwner(params: Record<string, unknown>): ActiveTurn | null {
    const thread = string(params.threadId, "Codex thread identity");
    if (this.conversation !== null && thread !== this.conversation) {
      this.foreign(thread, null);
      return this.descendant(thread) && this.active !== null && !this.active.settled ? this.active : null;
    }
    const active = this.scope(params, true);
    if (!active) throw new ControlError("INVALID_STATE", "request arrived without an active turn");
    return active;
  }
  private notification(method: string, raw: unknown): void {
    const params = raw === undefined ? {} : object(raw, "Codex notification params");
    if (method === "thread/started") {
      const thread = object(params.thread, "started thread"); const id = nativeConversationId(thread.id);
      if (this.opening && this.conversation === null) { this.conversation = id; return; }
      if (id === this.conversation) return;
      // app-server attaches every connection to every thread it creates; ownership stays with the thread/start response.
      this.foreign(id, typeof thread.parentThreadId === "string" ? thread.parentThreadId : null); return;
    }
    if (this.conversation !== null && typeof params.threadId === "string" && params.threadId !== this.conversation) {
      this.foreign(params.threadId, null); this.foreignUpdates++; return;
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = object(params.turn, "Codex turn notification");
      const active = this.scope({ ...params, turnId: turn.id }, true);
      if (!active) throw new ControlError("INVALID_STATE", "no active turn");
      if (method === "turn/started") return;
      const status = string(turn.status, "completed turn status");
      let result: BackendResult;
      switch (status) {
        case "completed": result = { status: "completed", reason: "completed" }; break;
        case "interrupted": result = { status: "cancelled", reason: "interrupted" }; break;
        case "failed": {
          const error = turn.error == null ? {} : object(turn.error, "native turn error");
          result = { status: "failed", reason: "failed", error: turnFailure(error) }; break;
        }
        default: throw new ControlError("INVALID_PROTOCOL", "turn/completed contains a nonterminal status");
      }
      const finish = () => { if (active.settled) return; this.settleTurn(active); active.resolve(result); };
      if (active.reads.size) { void Promise.all([...active.reads]).then(finish); return; }
      finish(); return;
    }
    if (method === "item/agentMessage/delta") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "no active turn");
      const itemId = string(params.itemId, "message item identity");
      if (active.deltaItems.size >= 4096 && !active.deltaItems.has(itemId)) throw new ControlError("ITEM_LIMIT", "message identity budget exhausted");
      active.deltaItems.add(itemId);
      active.event({ type: "text", text: text(params.delta, "agent message delta") }); return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "native thinking arrived without an active turn");
      string(params.itemId, "native reasoning item");
      active.event({ type: "thinking", text: text(params.delta, "native reasoning delta") }); return;
    }
    if (method === "item/started" || method === "item/completed") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "no active turn");
      const item = object(params.item, "Codex item"), type = string(item.type, "item type"), itemId = string(item.id, "item identity");
      if (type === "agentMessage") {
        if (method === "item/completed" && !active.deltaItems.has(itemId)) active.event({ type: "text", text: text(item.text, "agent message") });
        return;
      }
      if (["userMessage", "reasoning", "plan", "hookPrompt", "functionCallOutput"].includes(type)) return;
      const started = method === "item/started";
      if (type === "subAgentActivity") {
        const kind = item.kind, state = kind === "completed" ? "completed" : kind === "interrupted" ? "cancelled" : "running";
        active.event({ type: "activity", id: typeof item.agentThreadId === "string" ? item.agentThreadId : itemId, kind: "subagent", title: typeof item.agentPath === "string" ? item.agentPath : "子 Agent", status: state, ...(typeof item.model === "string" ? { detail: item.model } : {}) }); return;
      }
      if (type === "contextCompaction") { active.event({ type: "activity", id: itemId, kind: "compaction", title: "上下文压缩", status: started ? "running" : "completed" }); return; }
      if (type === "enteredReviewMode" || type === "exitedReviewMode") { active.event({ type: "activity", id: "review", kind: "review", title: typeof item.review === "string" ? line(item.review, 1024) || "代码审查" : "代码审查", status: type === "enteredReviewMode" ? "running" : "completed" }); return; }
      const tool = itemTool(item);
      if (tool === null) { active.event({ type: "tool", id: itemId, title: type, status: status(item.status, started) }); return; }
      const prior = active.items.get(itemId);
      if (prior?.timer) clearTimeout(prior.timer);
      // Completion carries the authoritative aggregate; while running keep the streamed output already seen.
      const detail = { ...prior?.detail, ...tool.detail, ...(tool.detail.output === undefined && prior?.detail.output !== undefined ? { output: prior.detail.output } : {}) };
      const entry = { title: tool.title, status: status(item.status, started), detail, timer: null };
      active.items.set(itemId, entry);
      active.event({ type: "tool", id: itemId, title: entry.title, status: entry.status, detail });
      if (!started && type === "imageGeneration" && typeof item.savedPath === "string") {
        const read = this.generatedImage(active, item.savedPath); active.reads.add(read); void read.then(() => active.reads.delete(read));
      }
      return;
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/patchUpdated" || method === "item/mcpToolCall/progress") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "native tool progress arrived without an active turn");
      const entry = active.items.get(string(params.itemId, "tool item identity"));
      if (!entry) return;
      if (method === "item/commandExecution/outputDelta") entry.detail = { ...entry.detail, output: tail((entry.detail.output ?? "") + text(params.delta, "command output delta")) };
      else if (method === "item/fileChange/patchUpdated") entry.detail = { ...entry.detail, ...(Array.isArray(params.changes) ? { diff: params.changes.map(fileDiff).join("") } : {}) };
      else entry.detail = { ...entry.detail, output: text(params.message, "tool progress") };
      const itemId = String(params.itemId);
      entry.timer ??= setTimeout(() => { entry.timer = null; if (this.active === active && !active.settled) active.event({ type: "tool", id: itemId, title: entry.title, status: entry.status, detail: entry.detail }); }, STREAM_MS);
      return;
    }
    if (method === "turn/plan/updated") {
      const active = this.scope(params);
      if (!active || active.settled || !Array.isArray(params.plan)) return;
      active.event({ type: "plan", entries: params.plan.slice(0, 256).map(value => { const step = object(value, "plan step"); return { content: typeof step.step === "string" ? step.step : "", status: step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending" }; }),
        ...(typeof params.explanation === "string" && params.explanation ? { explanation: params.explanation } : {}) });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const active = this.scope(params), usage = object(params.tokenUsage, "native token usage"), total = tokens(usage.total), last = tokens(usage.last);
      if (total !== null) this.lastTotal = total;
      // Thread totals may refer to a historical turn right after resume: they are this turn's baseline, never its usage.
      if (!active || active.settled || total === null) return;
      if (params.turnId !== active.turnId) { active.baseline = total; return; }
      const base = active.baseline, minus = (key: keyof Tokens) => Math.max(0, total[key] - (base?.[key] ?? 0));
      const window = typeof usage.modelContextWindow === "number" && Number.isSafeInteger(usage.modelContextWindow) && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined;
      const value: NativeUsage = { turn: { input: minus("inputTokens"), output: minus("outputTokens"), cachedInput: minus("cachedInputTokens"), cacheWrite: minus("cacheWriteInputTokens"), reasoning: minus("reasoningOutputTokens"), total: minus("totalTokens") },
        ...(last !== null ? { context: { used: last.totalTokens, ...(window ? { size: window } : {}) } } : {}) };
      active.event({ type: "usage", usage: value }); return;
    }
    if (method === "error" || method === "warning" || method === "configWarning" || method === "deprecationNotice" || method === "guardianWarning" || method === "model/rerouted") {
      if (params.threadId !== undefined) this.scope(params);
      const active = this.active; if (!active || active.settled) return;
      if (method === "error") {
        const failure = turnFailure(params.error !== null && typeof params.error === "object" ? params.error as Record<string, unknown> : {});
        if (params.willRetry === true) active.event({ type: "activity", id: "retry", kind: "retry", title: "模型请求重试", status: "running", detail: failure.message });
        else active.event({ type: "notice", severity: "error", title: failure.message });
        return;
      }
      if (method === "model/rerouted") { active.event({ type: "notice", severity: "warning", title: "模型已由服务端改路由", detail: String(params.fromModel ?? "") + " → " + String(params.toModel ?? "") }); return; }
      const message = typeof params.message === "string" ? params.message : typeof params.summary === "string" ? params.summary : "";
      if (message) active.event({ type: "notice", severity: method === "deprecationNotice" ? "info" : "warning", title: line(message, 1024), ...(typeof params.details === "string" ? { detail: params.details } : {}) });
      return;
    }
    if (passiveNotifications.has(method)) {
      if (params.threadId !== undefined) this.scope(params);
      if (method === "error") this.active?.event({ type: "diagnostic", message: "Codex reported an error; awaiting turn settlement" });
      return;
    }
    if (params.threadId !== undefined) this.scope(params);
    this.active?.event({ type: "diagnostic", message: `Unsupported Codex notification: ${method}` });
  }
  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> { const pending = this.permissions.get(id); if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable"); const response = pending.reply(option, input); this.permissions.delete(id); pending.resolve(response); }
  private cancelPermissions(): void { for (const pending of this.permissions.values()) pending.resolve(pending.reply("cancel")); this.permissions.clear(); }
  private serverRequest(request: RpcRequest): unknown {
    if (request.method === "item/tool/requestUserInput") return this.userInput(request);
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method))
      throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
    const params = object(request.params, "Codex approval params");
    const active = this.requestOwner(params);
    // Work outside the owned thread tree (internal reviewers, other clients' threads) is never approved for the user.
    if (!active) return { decision: "decline" };
    string(params.itemId, "approval item identity");
    if (this.interactivePermissions && !active.stopping) {
      const available = params.availableDecisions === undefined ? ["accept", "decline", "cancel"] : params.availableDecisions;
      if (!Array.isArray(available) || !available.length || available.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid native approval decisions");
      const choices = available.filter((value): value is string => typeof value === "string" && ["accept", "acceptForSession", "decline", "cancel"].includes(value));
      if (!choices.length || new Set(choices).size !== choices.length) throw new ControlError("INVALID_PROTOCOL", "no supported native approval decisions");
      const id = String(request.id);
      return new Promise<unknown>(resolve => { this.permissions.set(id, { options: choices, resolve, reply: decision => ({ decision }) }); active.event({ type: "permission_requested", id, title: (params.threadId !== this.conversation ? "子 Agent · " : "") + (typeof params.command === "string" ? params.command.slice(0,4096) : request.method.includes("fileChange") ? "Codex 请求修改文件" : "Codex 请求执行命令"), options: choices.map(id => ({ id, name: ({ accept: "允许一次", acceptForSession: "本次会话允许", decline: "拒绝", cancel: "取消" } as Record<string,string>)[id]! })) }); });
    }
    const decision = active.stopping ? "cancel" : "decline";
    active.event({ type: "permission", id: String(request.id), decision: active.stopping ? "cancelled" : "denied" });
    return { decision };
  }
  private async userInput(request: RpcRequest): Promise<unknown> {
    const params = object(request.params, "Codex native questions"), active = this.requestOwner(params);
    if (!active) return { answers: {} };
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid native question list");
    const questions = params.questions.map((value, index) => {
      const row = object(value, "native question"), id = string(row.id, "native question id", 128), title = string(row.question, "native question", 4096);
      const choices = row.options == null ? [] : row.options;
      if (!Array.isArray(choices) || choices.length > 128 || row.isOther !== undefined && typeof row.isOther !== "boolean" || row.isSecret !== undefined && typeof row.isSecret !== "boolean") throw new ControlError("INVALID_PROTOCOL", "invalid native question options");
      return { id, title, requestId: String(request.id) + ":" + index, secret: row.isSecret === true, freeform: row.isOther === true || choices.length === 0,
        choices: choices.map(value => { const option = object(value, "native question choice"); return string(option.label, "native question choice", 1024); }) };
    });
    if (new Set(questions.map(question => question.id)).size !== questions.length) throw new ControlError("INVALID_PROTOCOL", "duplicate native question identities");
    const answers = new Map<string, { answers: readonly string[] }>();
    for (const question of questions) {
      if (!this.interactivePermissions || active.stopping || active.settled || this.active !== active) return { answers: {} };
      if (this.permissions.size >= 32) throw new ControlError("PERMISSION_LIMIT", "native interactions exceeded their budget");
      const choices = [...question.choices.map((name, index) => ({ id: "answer-" + index, name })), ...(question.freeform ? [{ id: "submit", name: "提交回答" }] : []), { id: "cancel", name: "取消" }];
      const answer = await new Promise<unknown>(resolve => {
        this.permissions.set(question.requestId, { options: choices.map(choice => choice.id), resolve, reply: (option, input) => {
          if (option === "cancel") return null;
          if (option === "submit") { if (typeof input !== "string" || Buffer.byteLength(input) > 65536 || input.includes("\0")) throw new ControlError("INVALID_INPUT", "invalid native input answer"); return input; }
          const index = Number(option.slice(7)); if (!Number.isSafeInteger(index) || !question.choices[index]) throw new ControlError("INVALID_INPUT", "invalid native answer choice"); return question.choices[index];
        } });
        active.event({ type: "permission_requested", id: question.requestId, title: question.title, options: choices,
          ...(question.freeform ? { input: { kind: question.secret ? "secret" : "text", value: "" } } : {}) });
      });
      if (answer === null) return { answers: {} };
      answers.set(question.id, { answers: [text(answer, "native answer")] });
    }
    return { answers: Object.fromEntries(answers) };
  }
  /** A generated image file reported by the native turn becomes an output; only bounded regular image files are read. */
  private async generatedImage(active: ActiveTurn, path: string): Promise<void> {
    try {
      const info = await stat(path), mediaType = /\.png$/iu.test(path) ? "image/png" : /\.jpe?g$/iu.test(path) ? "image/jpeg" : /\.webp$/iu.test(path) ? "image/webp" : null;
      if (!info.isFile() || info.size < 1 || info.size > MAX_CONTENT_BYTES || mediaType === null) return;
      const data = await readFile(path);
      if (this.active === active && !active.settled) active.event({ type: "output", output: { kind: "content", name: basename(path), mediaType, data } });
    } catch { if (this.active === active && !active.settled) active.event({ type: "diagnostic", message: "generated image could not be read" }); }
  }
  private settleTurn(active: ActiveTurn): void {
    // Streamed output still waiting for its throttle window is delivered before the turn ends.
    for (const [id, entry] of active.items) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; active.event({ type: "tool", id, title: entry.title, status: entry.status, detail: entry.detail }); }
    this.cancelPermissions();
    clearTimeout(active.timer); active.settled = true; active.signalStarted();
    if (this.active === active) this.active = null;
  }
  private failTurn(active: ActiveTurn, error: Error): void {
    if (active.settled) return;
    for (const entry of active.items.values()) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    clearTimeout(active.timer); active.settled = true; active.rejectStarted(error); active.reject(error);
    if (this.active === active) this.active = null;
  }
}
