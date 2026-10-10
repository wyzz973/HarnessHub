import { isAbsolute } from "node:path";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl, type NativeConversationId, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { classifyRemoteFailure, ControlError, errorFrom, JsonRpcProcess, object, string, type RpcWireCodec } from "../../infrastructure/control/json-rpc-process.js";

function piCodec(): RpcWireCodec {
 const commands = new Map<string, string>();
 return {
  encode(message) {
    const method = string(message.method, "Pi command"), params = object(message.params, "Pi command parameters");
    if (message.id !== undefined) commands.set(String(message.id), method);
    return { ...params, type: method, ...(message.id === undefined ? {} : { id: String(message.id) }) };
  },
  decode(message) {
    if (message.type !== "response") return { method: "pi/event", params: message };
    const id = string(message.id, "Pi response identity");
    if (!/^[1-9][0-9]*$/u.test(id) || !Number.isSafeInteger(Number(id)) || typeof message.success !== "boolean") throw new ControlError("INVALID_PROTOCOL", "invalid Pi response identity/status");
    if (string(message.command, "Pi response command") !== commands.get(id)) throw new ControlError("IDENTITY_MISMATCH", "Pi response command does not belong to its pending request");
    commands.delete(id);
    if (!message.success && (typeof message.error !== "string" || Buffer.byteLength(message.error) > 65536)) throw new ControlError("INVALID_PROTOCOL", "invalid Pi remote error");
    return message.success ? { id: Number(id), result: message.data ?? {} }
      : { id: Number(id), error: { code: -32001, message: message.error } };
  },
};
}
interface Prompt {
  readonly event: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  acknowledged: boolean;
  settled: boolean;
  final: BackendResult | null;
  stop: Promise<StopRequestReceipt> | null;
}
function model(value: unknown): { id: string; name: string; provider: string; modelId: string } {
  const row = object(value, "Pi model"), provider = string(row.provider, "Pi provider", 128), modelId = string(row.id, "Pi model identity", 768);
  if (provider.includes("/")) throw new ControlError("INVALID_PROTOCOL", "Pi provider identity is ambiguous");
  return { id: provider + "/" + modelId, name: typeof row.name === "string" ? string(row.name, "Pi model name", 1024) : modelId, provider, modelId };
}
/** Uses the original Pi CLI RPC. Model overrides are launch flags because set_model writes the user's global default. */
export class PiControl implements HarnessControl {
  private rpc: JsonRpcProcess;
  private initialization: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private conversation: NativeConversationId | null = null;
  private active: Prompt | null = null;
  private failure: Error | null = null;
  private closed = false;
  private catalog: NativeModelCatalog = { models: [], defaultModel: null, authentication: "unknown", canSelect: false };
  private entries: ReturnType<typeof model>[] = [];
  private state: Record<string, unknown> = {};
  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "pi-rpc") throw new ControlError("INVALID_INPUT", "Pi control requires Pi RPC");
    this.rpc = this.connection();
  }
  private connection(selected?: ReturnType<typeof model>): JsonRpcProcess {
    return new JsonRpcProcess({ ...this.launch, args: [...this.launch.args, "--no-session", ...(selected ? ["--provider", selected.provider, "--model", selected.modelId] : [])] }, this.options, {
      notification: (_method, event) => this.notification(object(event, "Pi event")),
      request: () => { throw new ControlError("METHOD_NOT_FOUND", "Pi does not use inbound JSON-RPC requests"); },
      failure: error => { this.failure = error; this.rejectActive(error); },
    }, piCodec());
  }
  initialize(): Promise<ProtocolObservation> {
    this.initialization ??= this.initializeOnce(); return this.initialization;
  }
  private async readState(): Promise<void> {
    this.state = object(await this.rpc.request("get_state", {}), "Pi state");
    string(this.state.sessionId, "Pi session identity");
    const available = object(await this.rpc.request("get_available_models", {}), "Pi models");
    if (!Array.isArray(available.models) || available.models.length > 4096) throw new ControlError("INVALID_PROTOCOL", "Pi models exceed the catalog budget");
    this.entries = available.models.map(model);
    if (new Set(this.entries.map(row => row.id)).size !== this.entries.length) throw new ControlError("INVALID_PROTOCOL", "duplicate Pi model identity");
    const current = this.state.model == null ? null : model(this.state.model);
    const ready = current !== null && this.entries.some(row => row.id === current.id);
    const models = this.entries.map(({ id, name }) => ({ id, name }));
    if (current && !ready) models.push({ id: current.id, name: current.name });
    this.catalog = { models, defaultModel: current?.id ?? null, canSelect: this.entries.length > 0, authentication: ready ? "ready" : this.entries.length === 0 ? "missing" : "unknown" };
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      await this.readState(); this.initialized = true;
      return { protocol: "pi-rpc", protocolVersion: null, agentName: "pi", agentVersion: null, authenticationMethods: [], capabilities: { nativeModels: true, settlement: "agent_settled" } };
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
  }
  async open(cwd: string, selected?: string): Promise<NativeConversationId> {
    if (!this.initialized || this.closed || this.failure) throw this.failure ?? new ControlError("INVALID_STATE", "Pi is not initialized");
    if (this.conversation || !isAbsolute(cwd) || cwd !== this.options.cwd) throw new ControlError("INVALID_STATE", "Pi owns one conversation in its launch workspace");
    if (selected !== undefined && selected !== this.catalog.defaultModel) {
      const entry = this.entries.find(row => row.id === selected);
      if (!entry) throw new ControlError("MODEL_UNAVAILABLE", "selected model is unavailable in native Pi");
      const cleanup = await this.rpc.close();
      if (cleanup.protocolFailure) throw new ControlError("PROTOCOL_FAILED", "Pi model probe failed before model launch");
      this.failure = null;
      this.rpc = this.connection(entry); await this.readState();
      if (this.catalog.defaultModel !== selected) throw new ControlError("MODEL_MISMATCH", "native Pi did not apply the requested model");
    }
    this.conversation = nativeConversationId(this.state.sessionId); return this.conversation;
  }
  async models(): Promise<NativeModelCatalog> { if (!this.initialized) throw new ControlError("INVALID_STATE", "Pi is not initialized"); return this.catalog; }
  async startText(id: NativeConversationId, message: string, event: (event: ControlEvent) => void): Promise<ControlRun> {
    if (this.closed || this.failure || id !== this.conversation || this.active) throw this.failure ?? new ControlError("INVALID_STATE", "Pi conversation is not ready for a prompt");
    if (typeof message !== "string" || !message.trim()) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const result = new Promise<BackendResult>((resolve, reject) => {
      const timer = setTimeout(() => this.rpc.abort(new ControlError("RUN_TIMEOUT", "Pi run exceeded its deadline")), this.options.runTimeoutMs);
      this.active = { event, resolve, reject, timer, acknowledged: false, settled: false, final: null, stop: null };
    });
    const prompt = this.active!;
    void this.rpc.request("prompt", { message }).then(() => { prompt.acknowledged = true; this.settle(prompt); }, error => {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && !this.rpc.failure) {
        prompt.acknowledged = true; prompt.settled = true; prompt.final = { status: "failed", reason: "request_rejected", ...(error.remoteFailure ? { error: error.remoteFailure } : {}) }; this.settle(prompt);
      } else this.rpc.abort(errorFrom(error));
    });
    return { result, requestStop: () => {
      if (this.active !== prompt) return Promise.reject(new ControlError("INVALID_STATE", "Pi prompt has ended"));
      prompt.stop ??= this.rpc.request("abort", {}).then(() => ({ requested: true })); return prompt.stop;
    } };
  }
  private notification(event: Record<string, unknown>): void {
    const type = string(event.type, "Pi event type");
    if (type === "extension_ui_request") {
      const id = string(event.id, "Pi UI request"), method = string(event.method, "Pi UI method");
      if (["confirm", "select", "input", "editor"].includes(method)) {
        this.active?.event({ type: "permission", id, decision: "denied" });
        void this.rpc.notify("extension_ui_response", { id, ...(method === "confirm" ? { confirmed: false } : { cancelled: true }) }).catch(error => this.rpc.abort(errorFrom(error)));
      }
      return;
    }
    const prompt = this.active; if (!prompt) return;
    if (type === "message_update") {
      const delta = object(event.assistantMessageEvent, "Pi message event");
      if (delta.type === "text_delta") { if (typeof delta.delta !== "string") throw new ControlError("INVALID_PROTOCOL", "Pi text delta must be text"); prompt.event({ type: "text", text: delta.delta }); }
    } else if (type === "tool_execution_start" || type === "tool_execution_end") {
      prompt.event({ type: "tool", id: string(event.toolCallId, "Pi tool identity"), title: string(event.toolName, "Pi tool name"), status: type === "tool_execution_start" ? "in_progress" : event.isError === true ? "failed" : "completed" });
    } else if (type === "agent_end") {
      if (!Array.isArray(event.messages) || event.messages.length > 4096) throw new ControlError("INVALID_PROTOCOL", "invalid Pi terminal messages");
      const assistant = event.messages.map(value => object(value, "Pi terminal message")).findLast(row => row.role === "assistant");
      if (!assistant) throw new ControlError("INVALID_PROTOCOL", "Pi ended without an assistant result");
      const reason = string(assistant.stopReason, "Pi stop reason");
      if (!["stop", "length", "error", "aborted", "toolUse"].includes(reason)) throw new ControlError("INVALID_PROTOCOL", "unknown Pi stop reason");
      const error = typeof assistant.errorMessage === "string" ? classifyRemoteFailure(assistant.errorMessage) : undefined;
      prompt.final = { status: reason === "stop" ? "completed" : reason === "aborted" ? "cancelled" : "failed", reason, ...(error ? { error } : {}) };
    } else if (type === "agent_settled") { prompt.settled = true; this.settle(prompt); }
  }
  private settle(prompt: Prompt): void {
    if (this.active !== prompt || !prompt.acknowledged || !prompt.settled) return;
    if (!prompt.final) { this.rpc.abort(new ControlError("INVALID_PROTOCOL", "Pi settled without a backend result")); return; }
    clearTimeout(prompt.timer); this.active = null; prompt.resolve(prompt.final);
  }
  private rejectActive(error: Error): void { const prompt = this.active; if (prompt) { clearTimeout(prompt.timer); this.active = null; prompt.reject(error); } }
  close(): Promise<CleanupEvidence> { this.closed = true; this.rejectActive(new ControlError("CLOSED", "Pi connection closed before settlement")); return this.rpc.close(); }
}
