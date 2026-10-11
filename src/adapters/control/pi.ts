import { dirname, join, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl, type NativeConversationId, type NativeOptions, type NativeOption, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
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
  private levels: ((model: Record<string, unknown>) => unknown) | null = null;
  private interactivePermissions = false;
  private readonly permissions = new Map<string, { method:string;choices:readonly string[]; resolve: (value: Readonly<Record<string, unknown>>) => void }>();
  private entries: ReturnType<typeof model>[] = [];
  private state: Record<string, unknown> = {};
  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "pi-rpc") throw new ControlError("INVALID_INPUT", "Pi control requires Pi RPC");
    this.rpc = this.connection();
  }
  private connection(selected?: ReturnType<typeof model>, persist = false, sessionPath?: string): JsonRpcProcess {
    return new JsonRpcProcess({ ...this.launch, args: [...this.launch.args, ...(sessionPath === undefined ? persist ? [] : ["--no-session"] : ["--session", sessionPath]), ...(selected ? ["--provider", selected.provider, "--model", selected.modelId] : [])] }, this.options, {
      notification: (_method, event) => this.notification(object(event, "Pi event")),
      request: () => { throw new ControlError("METHOD_NOT_FOUND", "Pi does not use inbound JSON-RPC requests"); },
      failure: error => { this.failure = error; this.rejectActive(error); },
    }, piCodec());
  }
  initialize(): Promise<ProtocolObservation> {
    this.initialization ??= this.initializeOnce(); return this.initialization;
  }
  private async loadLevels(): Promise<void> {
    try {
      const entry = await realpath(this.launch.args[0]?.startsWith("/") && /\.(?:m?js|cjs)$/u.test(this.launch.args[0]) ? this.launch.args[0] : this.launch.executable);
      const location=join(dirname(entry),"core","agent-session.js");
      const sdk: unknown = await import(pathToFileURL(location).href), api=object(sdk,"native Pi SDK");
      if(typeof api.AgentSession!=="function")throw new ControlError("NATIVE_CAPABILITY_UNAVAILABLE","native Pi session API unavailable");
      const prototype=object(api.AgentSession.prototype,"native Pi session prototype"), get=prototype.getAvailableThinkingLevels;
      if(typeof get!=="function")throw new ControlError("NATIVE_CAPABILITY_UNAVAILABLE","native Pi thinking catalog unavailable");
      this.levels=model=>get.call({model});
    } catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ENOENT"].includes(String(error.code)))) throw error; }
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
    const models = this.entries.map(({ id, name }, index) => {
      let options: readonly NativeOption[] | undefined;
      if (this.levels) {
        const raw = this.levels!(object((available.models as unknown[])[index], "native Pi model"));
        if (!Array.isArray(raw) || !raw.length || raw.length > 32 || raw.some(level => typeof level !== "string" || !level || level.length > 128)) throw new ControlError("INVALID_PROTOCOL", "native Pi thinking levels invalid");
        const values = raw.map(value => ({ value: string(value, "thinking level", 128), name: string(value, "thinking level", 128) }));
        const currentValue = typeof this.state.thinkingLevel === "string" && values.some(value => value.value === this.state.thinkingLevel) ? this.state.thinkingLevel : values[0]!.value;
        options = [{ id: "thinking_level", name: "思考强度", category: "thought_level", currentValue, values }];
      }
      return { id, name, ...(options ? { options } : {}) };
    });
    if (current && !ready) models.push({ id: current.id, name: current.name });
    this.catalog = { ...this.catalog, models, defaultModel: current?.id ?? null, canSelect: this.entries.length > 0, authentication: ready ? "ready" : this.entries.length === 0 ? "missing" : "unknown" };
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      await this.loadLevels(); await this.readState();
      const commandResult = object(await this.rpc.request("get_commands", {}), "Pi native commands");
      if (!Array.isArray(commandResult.commands) || commandResult.commands.length > 256) throw new ControlError("INVALID_PROTOCOL", "invalid Pi command catalog");
      this.catalog = { ...this.catalog, commands: commandResult.commands.map(value => { const command = object(value, "Pi command"); return { name: string(command.name, "Pi command name", 128), description: typeof command.description === "string" ? command.description.slice(0,4096) : "" }; }) }; this.initialized = true;
      return { protocol: "pi-rpc", protocolVersion: null, agentName: "pi", agentVersion: null, authenticationMethods: [], capabilities: { nativeModels: true, settlement: "agent_settled" } };
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
  }
  async checkpoint(): Promise<string | null> {
    if (this.conversation === null || this.closed) return null;
    const state = object(await this.rpc.request("get_state", {}), "native Pi checkpoint");
    if (state.sessionFile == null) return null;
    const path = string(state.sessionFile, "native Pi session file", 4096), id = string(state.sessionId, "native Pi session identity");
    if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new ControlError("INVALID_CHECKPOINT", "invalid native Pi session file");
    this.conversation = nativeConversationId(id);
    return JSON.stringify({ path, id });
  }
  async open(cwd: string, selected?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    if (!this.initialized || this.closed || this.failure) throw this.failure ?? new ControlError("INVALID_STATE", "Pi is not initialized");
    if (this.conversation || !isAbsolute(cwd) || cwd !== this.options.cwd) throw new ControlError("INVALID_STATE", "Pi owns one conversation in its launch workspace");
    let restored: { path: string; id: string } | undefined;
    if (checkpoint !== undefined) {
      let parsed: unknown; try { parsed = JSON.parse(checkpoint); } catch { throw new ControlError("INVALID_CHECKPOINT", "invalid Pi recovery reference"); }
      const value = object(parsed, "Pi recovery reference"), path = string(value.path, "Pi recovery file", 4096), id = string(value.id, "Pi recovery identity");
      if (Object.keys(value).some(key => !["path", "id"].includes(key)) || !isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new ControlError("INVALID_CHECKPOINT", "invalid native Pi recovery reference");
      restored = { path, id };
    }
    const entry = this.entries.find(row => row.id === (selected ?? this.catalog.defaultModel));
    if (selected !== undefined && !entry) throw new ControlError("MODEL_UNAVAILABLE", "selected model is unavailable in native Pi");
    {
      const cleanup = await this.rpc.close();
      if (cleanup.protocolFailure) throw new ControlError("PROTOCOL_FAILED", "Pi model probe failed before model launch");
      this.failure = null;
      this.rpc = this.connection(entry, true, restored?.path); await this.readState();
      if (selected !== undefined && this.catalog.defaultModel !== selected) throw new ControlError("MODEL_MISMATCH", "native Pi did not apply the requested model");
      if (restored !== undefined && (this.state.sessionId !== restored.id || this.state.sessionFile !== restored.path)) throw new ControlError("IDENTITY_MISMATCH", "native Pi recovery did not restore the owned session file");
    }
    for (const [key, value] of Object.entries(native ?? {})) {
      if (key !== "thinking_level" || !this.catalog.models.find(row => row.id === (selected ?? this.catalog.defaultModel))?.options?.find(option => option.id === key)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "thinking level unavailable for native Pi model");
      await this.rpc.request("set_thinking_level", { level: value });
      const state = object(await this.rpc.request("get_state", {}), "native Pi state");
      if (state.thinkingLevel !== value) throw new ControlError("NATIVE_OPTION_MISMATCH", "Pi did not apply requested thinking level");
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
      this.cancelPermissions(); prompt.stop ??= this.rpc.request("abort", {}).then(() => ({ requested: true })); return prompt.stop;
    } };
  }
  private notification(event: Record<string, unknown>): void {
    const type = string(event.type, "Pi event type");
    if (type === "extension_ui_request") {
      const id = string(event.id, "Pi UI request"), method = string(event.method, "Pi UI method");
      if (this.interactivePermissions && this.active && ["confirm","select","input","editor"].includes(method)) {
        if (this.permissions.size >= 32) throw new ControlError("PERMISSION_LIMIT", "native UI requests exceed their budget");
        const choices=method==="select" ? event.options : [];
        if (!Array.isArray(choices) || choices.length>128 || choices.some(value=>typeof value!=="string"||value.length>4096)) throw new ControlError("INVALID_PROTOCOL","invalid native UI choices");
        const pending = new Promise<Readonly<Record<string, unknown>>>(resolve => this.permissions.set(id, { method,choices,resolve }));
        const freeform=method==="input"||method==="editor";
        const options=method==="confirm" ? [{id:"yes",name:"允许"},{id:"no",name:"拒绝"}] : method==="select" ? [...choices.map((name,index)=>({id:"choice-"+index,name:String(name)})),{id:"cancel",name:"取消"}] : [{id:"submit",name:"提交"},{id:"cancel",name:"取消"}];
        const value=method==="editor"&&typeof event.prefilled==="string" ? event.prefilled : "";
        if(value.length>65536)throw new ControlError("OUTPUT_LIMIT","native editor input exceeded its budget");
        this.active.event({ type: "permission_requested", id, title: typeof event.title === "string" ? event.title.slice(0,4096) : "Pi 扩展请求交互", ...(typeof event.message==="string"?{detail:event.message.slice(0,4096)}:{}),...(freeform?{input:{kind:method==="editor"?"editor":"text",value}}:{}), options });
        void pending.then(value => this.rpc.notify("extension_ui_response", { id, ...value })).catch(error => this.rpc.abort(errorFrom(error))); return;
      }
      if (["confirm", "select", "input", "editor"].includes(method)) {
        this.active?.event({ type: "permission", id, decision: "denied" });
        void this.rpc.notify("extension_ui_response", { id, ...(method === "confirm" ? { confirmed: false } : { cancelled: true }) }).catch(error => this.rpc.abort(errorFrom(error)));
      }
      return;
    }
    const prompt = this.active; if (!prompt) return;
    if (type === "message_update") {
      const delta = object(event.assistantMessageEvent, "Pi message event");
      if (delta.type === "thinking_delta" && typeof delta.delta === "string") prompt.event({ type: "thinking", text: delta.delta });
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
  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending=this.permissions.get(id);if(!pending)throw new ControlError("PERMISSION_UNAVAILABLE","native UI request unavailable");
    let response:Readonly<Record<string,unknown>>;
    if(pending.method==="confirm"&&["yes","no"].includes(option))response={confirmed:option==="yes"};
    else if(option==="cancel")response={cancelled:true};
    else if(pending.method==="select"&&/^choice-[0-9]+$/u.test(option)&&pending.choices[Number(option.slice(7))]!==undefined)response={value:pending.choices[Number(option.slice(7))]};
    else if(["input","editor"].includes(pending.method)&&option==="submit"&&typeof input==="string"&&Buffer.byteLength(input)<=65536&&!input.includes("\0"))response=pending.method==="editor"?{text:input}:{value:input};
    else throw new ControlError("PERMISSION_UNAVAILABLE","native UI response unavailable");
    this.permissions.delete(id);pending.resolve(response);
  }
  private cancelPermissions(): void { for (const pending of this.permissions.values()) pending.resolve({ cancelled: true }); this.permissions.clear(); }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); this.closed = true; this.rejectActive(new ControlError("CLOSED", "Pi connection closed before settlement")); return this.rpc.close(); }
}
