import { isAbsolute } from "node:path";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent,
  type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl,
  type NativeOptions, type NativeOption, type NativeConversationId, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { ControlError, errorFrom, JsonRpcProcess, object, string, text, type RpcRequest } from "../../infrastructure/control/json-rpc-process.js";

interface ActivePrompt {
  readonly event: (event: ControlEvent) => void;
  readonly tools: Map<string, { title: string; status: string }>;
  stopping: boolean;
  settled: boolean;
  stop: Promise<StopRequestReceipt> | null;
}
const metadataUpdates = new Set(["plan", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update"]);

/** ACP v1 anti-corruption layer. Client filesystem and terminal capabilities are not advertised. */
export class AcpControl implements HarnessControl {
  private readonly rpc: JsonRpcProcess;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private capabilities: Record<string, unknown> = {};
  private conversation: NativeConversationId | null = null;
  private opening = false;
  private replaying = false;
  private replayBytes = 0;
  private active: ActivePrompt | null = null;
  private failure: Error | null = null;
  private catalog: NativeModelCatalog = { models: [], defaultModel: null, authentication: "unknown", canSelect: false };
  private interactivePermissions = false;
  private readonly permissions = new Map<string, { options: readonly string[]; resolve: (value: unknown) => void }>();
  private configuredDefault: string | null = null;
  private modelConfigId: string | null = null;
  private legacyModels = false;
  private readonly openingMetadata: Record<string, unknown>[] = [];

  constructor(launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "acp-v1") throw new ControlError("INVALID_INPUT", "ACP control requires an ACP launch");
    this.rpc = new JsonRpcProcess(launch, options, {
      notification: (method, params) => this.notification(method, params),
      request: request => this.serverRequest(request),
      failure: error => { this.failure = error; },
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
        protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: "harnessgateway", title: "HarnessGateway", version: "0.0.0" },
      }), "ACP initialize result");
      if (response.protocolVersion !== 1) throw new ControlError("PROTOCOL_VERSION", "peer did not negotiate ACP v1");
      const capabilities = object(response.agentCapabilities, "ACP agent capabilities");
      this.capabilities = capabilities;
      if (!Array.isArray(response.authMethods)) throw new ControlError("INVALID_PROTOCOL", "authMethods must be an array");
      const methods = response.authMethods.map(method => string(object(method, "auth method").id, "auth method id"));
      const info = response.agentInfo == null ? null : object(response.agentInfo, "agentInfo");
      const observation: ProtocolObservation = { protocol: "acp-v1", protocolVersion: 1,
        agentName: info === null ? null : string(info.name, "agent name"),
        agentVersion: info === null ? null : string(info.version, "agent version"),
        authenticationMethods: methods, capabilities };
      this.initialized = true;
      return observation;
    } catch (error) { const failure = this.nativeFailure(error); this.rpc.abort(failure); throw failure; }
  }
  private readSettings(response: Record<string, unknown>): void {
    if (response.configOptions !== undefined) {
      if (!Array.isArray(response.configOptions) || response.configOptions.length > 128) throw new ControlError("INVALID_PROTOCOL", "invalid native settings");
      const settings: NativeOption[] = [];
      for (const value of response.configOptions) {
        const row = object(value, "native setting"); if (row.type !== "select" || row.category === "model") continue;
        const id = string(row.id, "native setting identity", 128), currentValue = string(row.currentValue, "native setting value", 1024);
        if (!Array.isArray(row.options)) throw new ControlError("INVALID_PROTOCOL", "native setting values unavailable");
        const values = row.options.flatMap(value => { const item = object(value, "native setting group"); const entries = item.options === undefined ? [item] : item.options; if (!Array.isArray(entries)) throw new ControlError("INVALID_PROTOCOL", "native setting group invalid"); return entries.map(value => { const entry = object(value, "native setting choice"); return { value: string(entry.value, "native setting value", 1024), name: string(entry.name, "native setting name", 1024) }; }); });
        if (!values.length || values.length > 4096 || new Set(values.map(value => value.value)).size !== values.length) throw new ControlError("INVALID_PROTOCOL", "invalid native setting choices");
        if (!values.some(value => value.value === currentValue)) values.push({ value: currentValue, name: currentValue });
        settings.push({ id, name: typeof row.name === "string" ? string(row.name, "native setting title", 1024) : id, category: typeof row.category === "string" ? string(row.category, "native setting category", 128) : "native", currentValue, values });
      }
      if (new Set(settings.map(option => option.id)).size !== settings.length) throw new ControlError("INVALID_PROTOCOL", "duplicate native settings");
      this.catalog = { ...this.catalog, options: [...settings, ...(!settings.some(option=>option.category==="mode") ? (this.catalog.options??[]).filter(option=>option.id==="__mode") : [])] };
    }
    if (response.modes !== undefined && !this.catalog.options?.some(option => option.category === "mode")) {
      const modes = object(response.modes, "native modes"); if (!Array.isArray(modes.availableModes) || modes.availableModes.length > 128) throw new ControlError("INVALID_PROTOCOL", "invalid native modes");
      const values = modes.availableModes.map(value => { const row = object(value, "native mode"); return { value: string(row.id, "mode id", 128), name: string(row.name, "mode name", 1024) }; });
      const currentValue = string(modes.currentModeId, "current mode", 128);
      if (!values.some(row => row.value === currentValue) || new Set(values.map(row => row.value)).size !== values.length) throw new ControlError("INVALID_PROTOCOL", "invalid current native mode");
      this.catalog = { ...this.catalog, options: [...(this.catalog.options ?? []), { id: "__mode", name: "模式", category: "mode", currentValue, values }] };
    }
  }
  private readModels(response: Record<string, unknown>): void {
    this.readSettings(response);
    if (response.configOptions !== undefined) {
      if (!Array.isArray(response.configOptions) || response.configOptions.length > 128) throw new ControlError("INVALID_PROTOCOL", "invalid ACP configuration options");
      for (const value of response.configOptions) {
        const option = object(value, "ACP config option");
        if (option.category !== "model" || option.type !== "select") continue;
        const id = string(option.id, "model config identity"), selected = string(option.currentValue, "current model", 1024);
        if (!Array.isArray(option.options)) throw new ControlError("INVALID_PROTOCOL", "model options must be an array");
        const models: { id: string; name: string }[] = [];
        for (const value of option.options) {
          const item = object(value, "model option"), options = item.options === undefined ? [item] : item.options;
          if (!Array.isArray(options)) throw new ControlError("INVALID_PROTOCOL", "model group must contain options");
          for (const value of options) { const model = object(value, "model value"); models.push({ id: string(model.value, "model value", 1024), name: string(model.name, "model name", 1024) }); }
          if (models.length > 4096) throw new ControlError("MODEL_LIMIT", "native models exceed catalog budget");
        }
        if (new Set(models.map(row => row.id)).size !== models.length || !models.some(row => row.id === selected)) throw new ControlError("INVALID_PROTOCOL", "ACP models have duplicate or unknown default values");
        this.modelConfigId = id; this.legacyModels = false;
        this.catalog = { ...this.catalog, models, defaultModel: selected, authentication: "unknown", canSelect: true }; return;
      }
    }
    if (response.models !== undefined) {
      const value = object(response.models, "legacy ACP models");
      if (!Array.isArray(value.availableModels) || value.availableModels.length > 4096) throw new ControlError("INVALID_PROTOCOL", "invalid ACP models");
      const models = value.availableModels.map(value => { const row = object(value, "ACP model"); return { id: string(row.modelId, "model id", 1024), name: string(row.name, "model name", 1024) }; });
      const selected = string(value.currentModelId, "current model", 1024);
      if (new Set(models.map(row => row.id)).size !== models.length) throw new ControlError("INVALID_PROTOCOL", "ACP model identity mismatch");
      // Installed Gemini can report a configured model outside its suggested catalog.
      // Retain the peer's actual current model; never invent a replacement default.
      if (!models.some(row => row.id === selected)) models.push({ id: selected, name: selected });
      if (models.length > 4096) throw new ControlError("MODEL_LIMIT", "native models exceed catalog budget");
      this.legacyModels = true; this.catalog = { ...this.catalog, models, defaultModel: selected, authentication: "unknown", canSelect: models.length > 0 };
    }
  }
  async models(): Promise<NativeModelCatalog> { this.assertInitialized(); if (this.conversation === null) throw new ControlError("INVALID_STATE", "ACP model catalog requires a session"); return { ...this.catalog, defaultModel: this.configuredDefault }; }
  protected async sessionParameters(cwd: string): Promise<Readonly<Record<string, unknown>>> { return { cwd, mcpServers: [] }; }
  async checkpoint(): Promise<string | null> {
    const session = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
    return this.conversation !== null && (this.capabilities.loadSession === true || session.resume !== undefined) ? this.conversation : null;
  }
  async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation !== null || this.opening) throw new ControlError("INVALID_STATE", "this connection already owns a conversation");
    this.opening = true;
    try {
      let method = "session/new";
      if (checkpoint !== undefined) {
        const session = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
        method = session.resume !== undefined ? "session/resume" : this.capabilities.loadSession === true ? "session/load" : "";
        if (!method) throw new ControlError("NATIVE_RESUME_UNAVAILABLE", "installed Harness did not advertise native recovery");
        this.conversation = nativeConversationId(checkpoint); this.replaying = true;
      }
      const response = object(await this.rpc.request(method, { ...await this.sessionParameters(cwd), ...(checkpoint === undefined ? {} : { sessionId: this.conversation }) }), "native session setup result");
      if (checkpoint === undefined) this.conversation = nativeConversationId(response.sessionId);
      else if (response.sessionId !== undefined && response.sessionId !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "native restore changed the owned session identity");
      if (this.conversation === null) throw new ControlError("IDENTITY_MISMATCH", "native setup did not establish an owned conversation");
      this.replaying = false;
      this.readModels(response); this.configuredDefault=this.catalog.defaultModel;
      for (const params of this.openingMetadata.splice(0)) this.notification("session/update", params);
      if (model !== undefined) {
        if (!this.catalog.canSelect || !this.catalog.models.some(row => row.id === model)) throw new ControlError("MODEL_UNAVAILABLE", "selected model is unavailable in this Harness");
        if (this.modelConfigId !== null) {
          const selected = object(await this.rpc.request("session/set_config_option", { sessionId: this.conversation, configId: this.modelConfigId, value: model }), "model selection result");
          this.readModels(selected);
          if (this.catalog.defaultModel !== model) throw new ControlError("MODEL_MISMATCH", "Harness did not apply the selected model");
        } else if (this.legacyModels) {
          await this.rpc.request("session/set_model", { sessionId: this.conversation, modelId: model });
          this.catalog = { ...this.catalog, defaultModel: model };
        }
      }
      for (const [key, value] of Object.entries(options ?? {})) {
        const setting = this.catalog.options?.find(option => option.id === key);
        if (!setting || !setting.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "native option unavailable for selected Harness");
        if (key === "__mode") await this.rpc.request("session/set_mode", { sessionId: this.conversation, modeId: value });
        else { const response = object(await this.rpc.request("session/set_config_option", { sessionId: this.conversation, configId: key, value }), "native setting result"); this.readModels(response); if (this.catalog.options?.find(option => option.id === key)?.currentValue !== value) throw new ControlError("NATIVE_OPTION_MISMATCH", "Harness did not apply its native setting"); }
      }
      return this.conversation;
    } catch (error) { const failure = this.nativeFailure(error); if (!(failure instanceof ControlError && ["MODEL_UNAVAILABLE","NATIVE_OPTION_UNAVAILABLE"].includes(failure.code))) this.rpc.abort(failure); throw failure; }
    finally { this.opening = false; this.replaying = false; this.openingMetadata.length = 0; }
  }
  async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void): Promise<ControlRun> {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "conversation is not owned by this connection");
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a prompt is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const active: ActivePrompt = { event: onEvent, tools: new Map(), stopping: false, settled: false, stop: null };
    this.active = active;
    const result = this.rpc.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: prompt }] }, this.options.runTimeoutMs)
      .then(value => {
        const response = object(value, "session/prompt result");
        const reason = string(response.stopReason, "ACP stop reason");
        let status: BackendResult["status"];
        switch (reason) {
          case "end_turn": status = "completed"; break;
          case "cancelled": status = "cancelled"; break;
          case "max_tokens": case "max_turn_requests": case "refusal": status = "failed"; break;
          default: throw new ControlError("INVALID_PROTOCOL", "unknown ACP stop reason");
        }
        return { status, reason };
      }).catch((error: unknown): BackendResult => {
        if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null)
          return { status: "failed", reason: "request_rejected", ...(error.remoteFailure ? { error: error.remoteFailure } : {}) };
        this.rpc.abort(errorFrom(error)); throw error;
      });
    void result.then(() => this.settle(active), () => this.settle(active));
    return { result, requestStop: () => {
      if (active.stop) return active.stop;
      if (active.settled || this.active !== active) return Promise.reject(new ControlError("INVALID_STATE", "prompt has already ended"));
      active.stopping = true; this.cancelPermissions();
      active.stop = this.rpc.notify("session/cancel", { sessionId: id }).then(() => ({ requested: true }));
      return active.stop;
    } };
  }
  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string): Promise<void> {
    const pending = this.permissions.get(id); if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "permission or actual option unavailable");
    this.permissions.delete(id); pending.resolve({ outcome: { outcome: "selected", optionId: option } });
  }
  private cancelPermissions(): void { for (const pending of this.permissions.values()) pending.resolve({ outcome: { outcome: "cancelled" } }); this.permissions.clear(); }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); return this.rpc.close(); }
  private nativeFailure(error: unknown): Error { return error instanceof ControlError && error.remoteFailure ? new ControlError(error.remoteFailure.code, error.remoteFailure.message) : errorFrom(error); }
  private settle(active: ActivePrompt): void { this.cancelPermissions(); active.settled = true; if (this.active === active) this.active = null; }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private scope(params: Record<string, unknown>): void {
    const received = string(params.sessionId, "ACP session identity");
    if (!this.conversation || received !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "ACP message belongs to another session");
  }
  private notification(method: string, raw: unknown): void {
    if (method !== "session/update") {
      const params = raw === undefined ? {} : object(raw, "ACP notification params");
      if (params.sessionId !== undefined) this.scope(params);
      this.active?.event({ type: "diagnostic", message: `Unsupported ACP notification: ${method}` });
      return;
    }
    const params = object(raw, "ACP notification params");
    const update = object(params.update, "ACP session update");
    const kind = string(update.sessionUpdate, "ACP update kind");
    if (this.opening && this.conversation === null && metadataUpdates.has(kind)) {
      string(params.sessionId, "ACP session identity");
      if (this.openingMetadata.length >= 128) throw new ControlError("WIRE_LIMIT", "ACP opening metadata exceeds its budget");
      this.openingMetadata.push(params); return;
    }
    this.scope(params);
    if (this.replaying) {
      this.replayBytes += Buffer.byteLength(JSON.stringify(params));
      if (this.replayBytes > 64 * 1024 * 1024) throw new ControlError("REPLAY_LIMIT", "native history replay exceeded its budget");
      if (!metadataUpdates.has(kind)) return;
    }
    if (kind === "config_option_update") { this.readModels(update); return; }
    if (kind === "available_commands_update") {
      if (!Array.isArray(update.availableCommands) || update.availableCommands.length > 256) throw new ControlError("INVALID_PROTOCOL", "native commands exceed their budget");
      this.catalog = { ...this.catalog, commands: update.availableCommands.map(value => { const command = object(value, "native command"); return { name: string(command.name, "native command name", 128), description: typeof command.description === "string" ? text(command.description, "native command description").slice(0,4096) : "" }; }) }; return;
    }
    if (kind === "current_mode_update") { const mode = string(update.currentModeId, "current native mode", 128); this.catalog = { ...this.catalog, options: this.catalog.options?.map(option => option.id === "__mode" ? { ...option, currentValue: mode } : option) ?? [] }; return; }
    if (metadataUpdates.has(kind)) return;
    const active = this.active;
    if (!active || active.settled) throw new ControlError("INVALID_STATE", "ACP output arrived without an active prompt");
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      const content = object(update.content, "ACP message content");
      if (content.type !== "text") throw new ControlError("UNSUPPORTED_CONTENT", "this control slice supports text content only");
      const value = text(content.text, "ACP text chunk");
      if (kind === "agent_message_chunk") active.event({ type: "text", text: value });
      if (kind === "agent_thought_chunk") active.event({ type: "thinking", text: value });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolId = string(update.toolCallId, "tool call identity");
      const prior = active.tools.get(toolId);
      if (kind === "tool_call" && prior) throw new ControlError("DUPLICATE_TOOL", "ACP repeated a tool call identity");
      if (kind === "tool_call_update" && !prior) throw new ControlError("IDENTITY_MISMATCH", "ACP updated an unknown tool call");
      if (!prior && active.tools.size >= 128) throw new ControlError("TOOL_LIMIT", "tool identity budget exhausted");
      const title = update.title === undefined && prior ? prior.title : string(update.title, "tool title", 4096);
      const status = update.status === undefined ? (prior?.status ?? "pending") : string(update.status, "tool status");
      if (!["pending", "in_progress", "completed", "failed"].includes(status)) throw new ControlError("INVALID_PROTOCOL", "unknown tool status");
      active.tools.set(toolId, { title, status });
      active.event({ type: "tool", id: toolId, title, status }); return;
    }
    active.event({ type: "diagnostic", message: `Unsupported ACP session update: ${kind}` });
  }
  private serverRequest(request: RpcRequest): unknown {
    if (request.method !== "session/request_permission") throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
    const params = object(request.params, "ACP permission params"); this.scope(params);
    const active = this.active;
    if (!active || active.settled) throw new ControlError("INVALID_STATE", "permission arrived without an active prompt");
    const tool = object(params.toolCall, "permission tool call");
    string(tool.toolCallId, "permission tool identity");
    if (!Array.isArray(params.options) || params.options.length === 0 || params.options.length > 32)
      throw new ControlError("INVALID_PROTOCOL", "permission options are invalid");
    const options = params.options.map(raw => {
      const option = object(raw, "permission option");
      return { id: string(option.optionId, "permission option identity"), kind: string(option.kind, "permission option kind"), name: typeof option.name === "string" ? string(option.name, "permission name", 1024) : string(option.kind, "permission kind") };
    });
    if (new Set(options.map(option => option.id)).size !== options.length)
      throw new ControlError("INVALID_PROTOCOL", "duplicate permission option identities");
    if (this.interactivePermissions && !active.stopping) {
      if (this.permissions.size >= 32) throw new ControlError("PERMISSION_LIMIT", "too many native permission requests");
      const id = String(request.id);
      return new Promise<unknown>(resolve => { this.permissions.set(id, { options: options.map(option => option.id), resolve }); active.event({ type: "permission_requested", id, title: typeof tool.title === "string" ? tool.title.slice(0,4096) : "Harness 请求执行工具", options: options.map(({ id, name }) => ({ id, name })) }); });
    }
    const reject = options.find(option => option.kind === "reject_once") ?? options.find(option => option.kind === "reject_always");
    if (active.stopping || !reject) {
      active.event({ type: "permission", id: String(request.id), decision: "cancelled" });
      return { outcome: { outcome: "cancelled" } };
    }
    active.event({ type: "permission", id: String(request.id), decision: "denied" });
    return { outcome: { outcome: "selected", optionId: reject.id } };
  }
}
