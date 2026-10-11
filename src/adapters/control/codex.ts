import { isAbsolute } from "node:path";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent,
  type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl,
  type NativeOptions, type NativeOption, type NativeConversationId, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { ControlError, errorFrom, JsonRpcProcess, object, string, text, type RpcRequest } from "../../infrastructure/control/json-rpc-process.js";

interface ActiveTurn {
  readonly event: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly started: Promise<void>;
  readonly signalStarted: () => void;
  readonly rejectStarted: (error: Error) => void;
  readonly deltaItems: Set<string>;
  turnId: string | null;
  settled: boolean;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
}
const passiveNotifications = new Set(["thread/started", "thread/status/changed", "account/updated", "account/rateLimits/updated",
  "model/rerouted", "configWarning", "sessionConfigured", "thread/tokenUsage/updated", "turn/diff/updated", "turn/plan/updated",
  "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta", "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta", "item/mcpToolCall/progress", "serverRequest/resolved", "warning", "error"]);

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
      started, signalStarted, rejectStarted, turnId: null, settled: false, stopping: false, stop: null, deltaItems: new Set() };
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
      this.settleTurn(active); active.resolve(result); return;
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
      if (["userMessage", "reasoning"].includes(type)) return;
      const title = typeof item.command === "string" ? item.command.slice(0, 4096) : type;
      const status = typeof item.status === "string" ? item.status : (method === "item/started" ? "in_progress" : "completed");
      active.event({ type: "tool", id: itemId, title, status }); return;
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
  private settleTurn(active: ActiveTurn): void {
    this.cancelPermissions();
    clearTimeout(active.timer); active.settled = true; active.signalStarted();
    if (this.active === active) this.active = null;
  }
  private failTurn(active: ActiveTurn, error: Error): void {
    if (active.settled) return;
    clearTimeout(active.timer); active.settled = true; active.rejectStarted(error); active.reject(error);
    if (this.active === active) this.active = null;
  }
}
