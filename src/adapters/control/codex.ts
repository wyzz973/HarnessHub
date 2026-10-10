import { isAbsolute } from "node:path";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent,
  type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl,
  type NativeConversationId, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
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

/** Codex app-server anti-corruption layer; native thread and turn IDs never become public Session IDs. */
export class CodexControl implements HarnessControl {
  private readonly rpc: JsonRpcProcess;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private conversation: NativeConversationId | null = null;
  private opening = false;
  private active: ActiveTurn | null = null;
  private failure: Error | null = null;
  private readonly turnIds = new Set<string>();

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
  async open(cwd: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation || this.opening) throw new ControlError("INVALID_STATE", "this connection already owns a thread");
    this.opening = true;
    try {
      const response = object(await this.rpc.request("thread/start", {
        cwd, sandbox: "read-only", approvalPolicy: "untrusted", ephemeral: true,
      }), "thread/start result");
      const thread = object(response.thread, "Codex thread");
      const received = nativeConversationId(thread.id);
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
    void this.rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: prompt, text_elements: [] }] }).then(value => {
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
      active.stopping = true;
      active.stop = this.stopTurn(active, id);
      return active.stop;
    } };
  }
  close(): Promise<CleanupEvidence> { return this.rpc.close(); }
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
    if (requireTurn || params.turnId !== undefined) {
      const active = this.active;
      if (!active || active.settled) throw new ControlError("INVALID_STATE", "Codex output arrived without an active turn");
      this.bindTurn(active, string(params.turnId, "Codex turn identity"));
      return active;
    }
    return this.active;
  }
  private notification(method: string, raw: unknown): void {
    const params = raw === undefined ? {} : object(raw, "Codex notification params");
    if (method === "thread/started") {
      const thread = object(params.thread, "started thread"); const id = nativeConversationId(thread.id);
      if (!this.opening && id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "unsolicited Codex thread");
      if (this.conversation && this.conversation !== id) throw new ControlError("IDENTITY_MISMATCH", "started thread identity changed");
      this.conversation = id; return;
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
        case "failed": result = { status: "failed", reason: "failed" }; break;
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
  private serverRequest(request: RpcRequest): unknown {
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method))
      throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
    const params = object(request.params, "Codex approval params");
    const active = this.scope(params, true);
    if (!active) throw new ControlError("INVALID_STATE", "approval arrived without an active turn");
    string(params.itemId, "approval item identity");
    const decision = active.stopping ? "cancel" : "decline";
    active.event({ type: "permission", id: String(request.id), decision: active.stopping ? "cancelled" : "denied" });
    return { decision };
  }
  private settleTurn(active: ActiveTurn): void {
    clearTimeout(active.timer); active.settled = true; active.signalStarted();
    if (this.active === active) this.active = null;
  }
  private failTurn(active: ActiveTurn, error: Error): void {
    if (active.settled) return;
    clearTimeout(active.timer); active.settled = true; active.rejectStarted(error); active.reject(error);
    if (this.active === active) this.active = null;
  }
}
