import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl, type NativeConversationId, type NativeOptions, type NativeOption, type NativeModelCatalog, type NativeToolDetail, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { classifyRemoteFailure, ControlError, errorFrom, JsonRpcProcess, object, string, type RpcWireCodec } from "../../infrastructure/control/json-rpc-process.js";
import { MAX_CONTENT_BYTES, type ContentRef, type ControlAttachment } from "../../contracts/content.js";
import { checkInputs, fileMentions, readAttachment } from "../../infrastructure/control/attachments.js";

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
  /** An agent run began for this prompt; extension commands and input hooks can be handled without one. */
  started: boolean;
  settled: boolean;
  final: BackendResult | null;
  stop: Promise<StopRequestReceipt> | null;
  /** Tool calls of this prompt; streamed partial results are published at most every 300 ms. */
  readonly tools: Map<string, { title: string; detail: NativeToolDetail; timer: ReturnType<typeof setTimeout> | null }>;
  /** Accumulated assistant-message usage of this prompt (Pi reports usage per model call). */
  readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number; cost: number; costed: boolean };
}
const PI_TOOL_KINDS: Readonly<Record<string, string>> = { bash: "execute", powershell: "execute", read: "read", edit: "edit", write: "edit", grep: "search", find: "search", ls: "search" };
function textParts(value: unknown): string {
  const content = value !== null && typeof value === "object" ? (value as Record<string, unknown>).content : undefined;
  return Array.isArray(content) ? content.flatMap(part => part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "image" ? ["[image]"] : []).join("\n") : "";
}
/** Public title and native input for a Pi tool call (bash command, file path, or JSON arguments). */
function piTool(name: string, args: unknown): { title: string; detail: NativeToolDetail } {
  const row = args !== null && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const command = typeof row.command === "string" ? row.command : undefined, path = typeof row.path === "string" ? row.path : undefined;
  let input: string | undefined; try { input = command ?? (Object.keys(row).length ? JSON.stringify(row, null, 2) : undefined); } catch { input = undefined; }
  const summary = (command ?? path ?? "").replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, 4000);
  return { title: summary ? name + ": " + summary : name, detail: { kind: PI_TOOL_KINDS[name] ?? "tool", name, ...(input ? { input } : {}), ...(path ? { locations: [path] } : {}) } };
}
const PI_STREAM_MS = 300;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Pi's native Model contract (reasoning + thinkingLevelMap); the chosen level is confirmed by native state at open. */
function supportedLevels(value: Record<string, unknown>): string[] {
  if (value.reasoning !== true) return ["off"];
  const map = value.thinkingLevelMap == null ? {} : object(value.thinkingLevelMap, "Pi thinking level map");
  return THINKING_LEVELS.filter(level => { const mapped = map[level]; if (mapped === null) return false; return level === "xhigh" || level === "max" ? mapped !== undefined : true; });
}
/** Grace for a run started asynchronously by an extension command after its acknowledgement. */
const HANDLED_PROBE_MS = 150;
function model(value: unknown): { id: string; name: string; provider: string; modelId: string; image: boolean } {
  const row = object(value, "Pi model"), provider = string(row.provider, "Pi provider", 128), modelId = string(row.id, "Pi model identity", 768);
  if (provider.includes("/")) throw new ControlError("INVALID_PROTOCOL", "Pi provider identity is ambiguous");
  if (row.input !== undefined && (!Array.isArray(row.input) || row.input.length > 16 || row.input.some(item => typeof item !== "string"))) throw new ControlError("INVALID_PROTOCOL", "invalid Pi model input kinds");
  // Pi does not refuse images for text-only models; it replaces them with a placeholder, so the Hub gates on Model.input.
  return { id: provider + "/" + modelId, name: typeof row.name === "string" ? string(row.name, "Pi model name", 1024) : modelId, provider, modelId, image: Array.isArray(row.input) && row.input.includes("image") };
}
/** Uses the original Pi CLI RPC. Models are launch flags of the session process; global settings commands are never sent. */
export class PiControl implements HarnessControl {
  private rpc: JsonRpcProcess;
  private initialization: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private conversation: NativeConversationId | null = null;
  private active: Prompt | null = null;
  private failure: Error | null = null;
  private closed = false;
  private catalog: NativeModelCatalog = { models: [], defaultModel: null, authentication: "unknown", canSelect: false };
  private interactivePermissions = false;
  private readonly permissions = new Map<string, { method:string;choices:readonly string[]; resolve: (value: Readonly<Record<string, unknown>>) => void; timer: ReturnType<typeof setTimeout> | null }>();
  private entries: ReturnType<typeof model>[] = [];
  private hubCompact = false;
  private hubExport = false;
  private readonly contextWindows = new Map<string, number>();
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
  private async readState(): Promise<void> {
    this.state = object(await this.rpc.request("get_state", {}), "Pi state");
    string(this.state.sessionId, "Pi session identity");
    const available = object(await this.rpc.request("get_available_models", {}), "Pi models");
    if (!Array.isArray(available.models) || available.models.length > 4096) throw new ControlError("INVALID_PROTOCOL", "Pi models exceed the catalog budget");
    this.entries = available.models.map(model);
    for (const [index, entry] of this.entries.entries()) { const window = object((available.models as unknown[])[index], "Pi model").contextWindow; if (typeof window === "number" && Number.isSafeInteger(window) && window > 0) this.contextWindows.set(entry.id, window); }
    if (new Set(this.entries.map(row => row.id)).size !== this.entries.length) throw new ControlError("INVALID_PROTOCOL", "duplicate Pi model identity");
    const current = this.state.model == null ? null : model(this.state.model);
    const ready = current !== null && this.entries.some(row => row.id === current.id);
    // The current model's levels come from the native RPC; others follow the same native Model fields.
    let currentLevels: string[] | null = null;
    if (current !== null) {
      try {
        const reply = object(await this.rpc.request("get_available_thinking_levels", {}), "Pi thinking levels");
        if (!Array.isArray(reply.levels) || !reply.levels.length || reply.levels.length > 32) throw new ControlError("INVALID_PROTOCOL", "native Pi thinking levels invalid");
        currentLevels = reply.levels.map(level => string(level, "thinking level", 128));
      } catch (error) { if (!(error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null)) throw error; }
    }
    const models: NativeModelCatalog["models"][number][] = this.entries.map(({ id, name, image }, index) => {
      const levels = id === current?.id && currentLevels !== null ? currentLevels : supportedLevels(object((available.models as unknown[])[index], "native Pi model"));
      const values = levels.map(value => ({ value, name: value }));
      const currentValue = typeof this.state.thinkingLevel === "string" && levels.includes(this.state.thinkingLevel) ? this.state.thinkingLevel : levels[0]!;
      const options: readonly NativeOption[] = [{ id: "thinking_level", name: "思考强度", category: "thought_level", currentValue, values }];
      return { id, name, options, inputs: { image, audio: false, file: true } };
    });
    if (current && !ready) models.push({ id: current.id, name: current.name });
    this.catalog = { ...this.catalog, models, defaultModel: current?.id ?? null, canSelect: this.entries.length > 0, authentication: ready ? "ready" : this.entries.length === 0 ? "missing" : "unknown" };
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      await this.readState();
      const commandResult = object(await this.rpc.request("get_commands", {}), "Pi native commands");
      if (!Array.isArray(commandResult.commands) || commandResult.commands.length > 256) throw new ControlError("INVALID_PROTOCOL", "invalid Pi command catalog");
      const commands = commandResult.commands.map(value => { const command = object(value, "Pi command"); return { name: string(command.name, "Pi command name", 128), description: typeof command.description === "string" ? command.description.slice(0,4096) : "" }; });
      // Manual compaction is an RPC command, not a prompt command; it is offered only when no native command owns the name.
      this.hubCompact = !commands.some(command => command.name === "compact");
      this.hubExport = !commands.some(command => command.name === "export");
      this.catalog = { ...this.catalog, commands: [...commands, ...(this.hubCompact ? [{ name: "compact", description: "压缩当前会话上下文（原生 RPC compact）" }] : []), ...(this.hubExport ? [{ name: "export", description: "导出原生会话（Pi HTML）" }] : [])] }; this.initialized = true;
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
  /** Restores the source session file, then `clone` copies its current branch into a new session file Pi switches to. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    await this.open(cwd, undefined, undefined, checkpoint);
    const source = JSON.parse(checkpoint) as { path: string; id: string };
    try {
      const reply = object(await this.rpc.request("clone", {}), "Pi clone result");
      if (reply.cancelled === true) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "a Pi extension cancelled the clone");
    } catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && !this.rpc.failure) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "Pi refused to clone the session");
      throw error;
    }
    const state = object(await this.rpc.request("get_state", {}), "Pi state after clone");
    if (state.sessionFile == null) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "the Pi clone has no session file");
    const path = string(state.sessionFile, "Pi clone file", 4096), id = string(state.sessionId, "Pi clone identity");
    if (!isAbsolute(path) || /[\0\r\n]/u.test(path) || path === source.path || id === source.id) throw new ControlError("IDENTITY_MISMATCH", "Pi clone did not create a separate session");
    this.conversation = nativeConversationId(id);
    return JSON.stringify({ path, id });
  }
  /** Images only for a current model whose Model.input lists them; files are named by path for Pi's own read tool. */
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    if (!this.initialized || this.closed || this.failure) throw this.failure ?? new ControlError("INVALID_STATE", "Pi is not initialized");
    const current = this.entries.find(row => row.id === this.catalog.defaultModel);
    checkInputs(attachments, { image: current?.image === true, audio: false, file: true });
  }
  async startText(id: NativeConversationId, message: string, event: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    if (this.closed || this.failure || id !== this.conversation || this.active) throw this.failure ?? new ControlError("INVALID_STATE", "Pi conversation is not ready for a prompt");
    if (typeof message !== "string" || !message.trim()) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    for (const file of attachments) if (file.kind === "image") images.push({ type: "image", data: (await readAttachment(file)).toString("base64"), mimeType: file.mediaType });
    if (attachments.some(file => file.kind === "audio")) throw new ControlError("ATTACHMENT_UNSUPPORTED", "Pi does not accept audio");
    message += fileMentions(attachments.filter(file => file.kind === "file"));
    if (this.closed || this.failure || this.active) throw this.failure ?? new ControlError("INVALID_STATE", "Pi conversation is not ready for a prompt");
    const result = new Promise<BackendResult>((resolve, reject) => {
      const timer = setTimeout(() => this.rpc.abort(new ControlError("RUN_TIMEOUT", "Pi run exceeded its deadline")), this.options.runTimeoutMs);
      this.active = { event, resolve, reject, timer, acknowledged: false, started: false, settled: false, final: null, stop: null, tools: new Map(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0, costed: false } };
    });
    const prompt = this.active!;
    const compact = this.hubCompact && !attachments.length ? /^\/compact(?:\s+([\s\S]*))?$/u.exec(message.trim()) : null;
    if (this.hubExport && !attachments.length && message.trim() === "/export") void this.exportSession(prompt);
    else if (compact) {
      const instructions = compact[1]?.trim();
      void this.rpc.request("compact", instructions ? { customInstructions: instructions } : {}).then(value => {
        const result = object(value, "Pi compaction result"), before = result.tokensBefore, after = result.estimatedTokensAfter;
        const detail = typeof before === "number" && Number.isSafeInteger(before) ? "tokens " + before + (typeof after === "number" && Number.isSafeInteger(after) ? " → " + after : "") : undefined;
        if (this.active === prompt) prompt.event({ type: "activity", id: "compaction", kind: "compaction", title: "上下文压缩", status: "completed", ...(detail ? { detail } : {}) });
        prompt.acknowledged = true; prompt.settled = true; prompt.final = { status: "completed", reason: "compacted" }; this.settle(prompt);
      }, error => {
        // Pi's own refusal (for example a session too small to compact) is shown on the compaction activity.
        if (error instanceof ControlError && error.code === "REMOTE_ERROR" && !this.rpc.failure) { prompt.acknowledged = true; prompt.settled = true; prompt.final = { status: "failed", reason: "request_rejected", error: error.remoteFailure ?? { code: "NATIVE_COMMAND_REJECTED", message: "Pi did not compact this session; see the compaction activity" } }; this.settle(prompt); }
        else this.rpc.abort(errorFrom(error));
      });
    } else void this.rpc.request("prompt", { message, ...(images.length ? { images } : {}) }).then(() => { prompt.acknowledged = true; this.settle(prompt); if (!prompt.started && !prompt.settled) void this.probeHandled(prompt); }, error => {
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
        // Pi resolves timed dialogs itself and ignores later answers; the question is withdrawn at the same deadline.
        const timeout = typeof event.timeout === "number" && Number.isSafeInteger(event.timeout) && event.timeout > 0 ? event.timeout : null;
        const timer = timeout === null ? null : setTimeout(() => { if (this.permissions.delete(id)) this.active?.event({ type: "permission", id, decision: "cancelled" }); }, timeout);
        const pending = new Promise<Readonly<Record<string, unknown>>>(resolve => this.permissions.set(id, { method, choices, resolve, timer }));
        const freeform=method==="input"||method==="editor";
        const options=method==="confirm" ? [{id:"yes",name:"允许"},{id:"no",name:"拒绝"}] : method==="select" ? [...choices.map((name,index)=>({id:"choice-"+index,name:String(name)})),{id:"cancel",name:"取消"}] : [{id:"submit",name:"提交"},{id:"cancel",name:"取消"}];
        const value=method==="editor"&&typeof event.prefill==="string" ? event.prefill : "";
        if(value.length>65536)throw new ControlError("OUTPUT_LIMIT","native editor input exceeded its budget");
        this.active.event({ type: "permission_requested", id, title: typeof event.title === "string" ? event.title.slice(0,4096) : "Pi 扩展请求交互", ...(typeof event.message==="string"?{detail:event.message.slice(0,4096)}:{}),...(freeform?{input:{kind:method==="editor"?"editor":"text",value}}:{}), options });
        void pending.then(value => this.rpc.notify("extension_ui_response", { id, ...value })).catch(error => this.rpc.abort(errorFrom(error))); return;
      }
      if (method === "notify") {
        if (this.active && typeof event.message === "string") this.active.event({ type: "notice", severity: event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info", title: event.message.slice(0, 1024) });
        return;
      }
      if (["confirm", "select", "input", "editor"].includes(method)) {
        this.active?.event({ type: "permission", id, decision: "denied" });
        void this.rpc.notify("extension_ui_response", { id, ...(method === "confirm" ? { confirmed: false } : { cancelled: true }) }).catch(error => this.rpc.abort(errorFrom(error)));
      }
      return;
    }
    const prompt = this.active; if (!prompt) return;
    if (type === "agent_start") { prompt.started = true; return; }
    if (type === "message_update") {
      const delta = object(event.assistantMessageEvent, "Pi message event");
      if (delta.type === "thinking_delta" && typeof delta.delta === "string") prompt.event({ type: "thinking", text: delta.delta });
      if (delta.type === "text_delta") { if (typeof delta.delta !== "string") throw new ControlError("INVALID_PROTOCOL", "Pi text delta must be text"); prompt.event({ type: "text", text: delta.delta }); }
    } else if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      const id = string(event.toolCallId, "Pi tool identity"), name = string(event.toolName, "Pi tool name");
      const entry = prompt.tools.get(id) ?? { ...piTool(name, event.args), timer: null };
      prompt.tools.set(id, entry);
      if (type === "tool_execution_update") {
        const output = textParts(event.partialResult); if (output) entry.detail = { ...entry.detail, output };
        entry.timer ??= setTimeout(() => { entry.timer = null; if (this.active === prompt && !prompt.settled) prompt.event({ type: "tool", id, title: entry.title, status: "in_progress", detail: entry.detail }); }, PI_STREAM_MS);
        return;
      }
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      if (type === "tool_execution_end") {
        const result = event.result !== null && typeof event.result === "object" ? event.result as Record<string, unknown> : {}, details = result.details !== null && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
        const output = textParts(result), diff = typeof details.patch === "string" ? details.patch : typeof details.diff === "string" ? details.diff : undefined;
        entry.detail = { ...entry.detail, ...(output ? { output } : {}), ...(diff ? { diff } : {}) };
      }
      prompt.event({ type: "tool", id, title: entry.title, status: type === "tool_execution_start" ? "in_progress" : event.isError === true ? "failed" : "completed", detail: entry.detail });
    } else if (type === "message_end") {
      const message = event.message !== null && typeof event.message === "object" ? event.message as Record<string, unknown> : {}, usage = message.usage !== null && typeof message.usage === "object" ? message.usage as Record<string, unknown> : null;
      if (message.role !== "assistant" || usage === null) return;
      const amount = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0 ? usage[key] as number : 0;
      const sum = prompt.usage, cost = usage.cost !== null && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>).total : undefined;
      sum.input += amount("input"); sum.output += amount("output"); sum.cacheRead += amount("cacheRead"); sum.cacheWrite += amount("cacheWrite"); sum.reasoning += amount("reasoning"); sum.total += amount("totalTokens");
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) { sum.cost += cost; sum.costed = true; }
      const size = this.contextWindows.get(this.catalog.defaultModel ?? "");
      prompt.event({ type: "usage", usage: { turn: { input: Math.round(sum.input), output: Math.round(sum.output), cachedInput: Math.round(sum.cacheRead), cacheWrite: Math.round(sum.cacheWrite), reasoning: Math.round(sum.reasoning), total: Math.round(sum.total) },
        context: { used: Math.round(amount("totalTokens")), ...(size ? { size } : {}) }, ...(sum.costed ? { cost: { amount: sum.cost, currency: "USD", scope: "turn" as const } } : {}) } });
    } else if (type === "compaction_start" || type === "compaction_end") {
      const detail = type === "compaction_end" && typeof event.errorMessage === "string" ? event.errorMessage : typeof event.reason === "string" ? event.reason : undefined;
      prompt.event({ type: "activity", id: "compaction", kind: "compaction", title: "上下文压缩", status: type === "compaction_start" ? "running" : event.aborted === true ? "cancelled" : event.errorMessage ? "failed" : "completed", ...(detail ? { detail } : {}) });
    } else if (type === "auto_retry_start" || type === "auto_retry_end") {
      prompt.event({ type: "activity", id: "retry", kind: "retry", title: "模型请求重试", status: type === "auto_retry_start" ? "running" : event.success === true ? "completed" : "failed",
        ...(typeof event.errorMessage === "string" ? { detail: event.errorMessage.slice(0, 1024) } : typeof event.finalError === "string" ? { detail: event.finalError.slice(0, 1024) } : {}) });
    } else if (type === "extension_error") {
      prompt.event({ type: "notice", severity: "error", title: "Pi 扩展出错", ...(typeof event.error === "string" ? { detail: event.error.slice(0, 4096) } : {}) });
    } else if (type === "agent_end") {
      if (!Array.isArray(event.messages) || event.messages.length > 4096) throw new ControlError("INVALID_PROTOCOL", "invalid Pi terminal messages");
      const assistant = event.messages.map(value => object(value, "Pi terminal message")).findLast(row => row.role === "assistant");
      if (!assistant) throw new ControlError("INVALID_PROTOCOL", "Pi ended without an assistant result");
      const reason = string(assistant.stopReason, "Pi stop reason");
      if (!["stop", "length", "error", "aborted", "toolUse"].includes(reason)) throw new ControlError("INVALID_PROTOCOL", "unknown Pi stop reason");
      const error = typeof assistant.errorMessage === "string" ? classifyRemoteFailure(assistant.errorMessage) : undefined;
      // A final toolUse stop only happens when every result of the last tool batch requested termination.
      prompt.final = { status: reason === "stop" || reason === "toolUse" ? "completed" : reason === "aborted" ? "cancelled" : "failed", reason, ...(error ? { error } : {}) };
    } else if (type === "agent_settled") { prompt.settled = true; this.settle(prompt); }
  }
  /**
   * Extension commands and input hooks can fully handle a prompt: Pi acknowledges it without starting a run,
   * so no agent_settled follows. Native state decides; a run started shortly after the command still owns the Turn.
   */
  private async probeHandled(prompt: Prompt): Promise<void> {
    try {
      for (const pause of [0, HANDLED_PROBE_MS]) {
        if (pause) await new Promise(resolve => setTimeout(resolve, pause));
        if (this.active !== prompt || prompt.started || prompt.settled) return;
        const state = object(await this.rpc.request("get_state", {}), "Pi state");
        if (this.active !== prompt || prompt.started || prompt.settled || state.isStreaming !== false) return;
      }
      prompt.final = { status: "completed", reason: "handled" }; prompt.settled = true; this.settle(prompt);
    } catch (error) { if (this.active === prompt) this.rpc.abort(errorFrom(error)); }
  }
  /** Pi writes its HTML export into a private temporary directory; the Run keeps the bytes as an output. */
  private async exportSession(prompt: Prompt): Promise<void> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "hh-pi-export-")));
    try {
      const reply = object(await this.rpc.request("export_html", { outputPath: join(directory, "pi-session.html") }), "Pi export result"), path = string(reply.path, "Pi export path", 4096);
      if (!path.startsWith(directory + sep)) throw new ControlError("INVALID_PROTOCOL", "Pi exported outside the requested path");
      const info = await stat(path);
      if (!info.isFile() || info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "Pi export is missing or exceeds 20 MiB");
      const data = await readFile(path);
      if (this.active === prompt) prompt.event({ type: "output", output: { kind: "content", name: "pi-session.html", mediaType: "text/html", data } });
      prompt.final = { status: "completed", reason: "exported" };
    } catch (error) {
      if (error instanceof ControlError && error.code !== "REMOTE_ERROR" && error.code !== "NATIVE_EXPORT_UNAVAILABLE") { this.rpc.abort(errorFrom(error)); return; }
      // Pi refuses in-memory sessions and sessions without an assistant reply ("Nothing to export yet").
      prompt.final = { status: "failed", reason: "export_failed", error: { code: "NATIVE_EXPORT_UNAVAILABLE", message: "Pi has nothing to export for this session yet" } };
    } finally { await rm(directory, { recursive: true, force: true }); }
    prompt.acknowledged = true; prompt.settled = true; this.settle(prompt);
  }
  private settle(prompt: Prompt): void {
    if (this.active !== prompt || !prompt.acknowledged || !prompt.settled) return;
    for (const entry of prompt.tools.values()) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (!prompt.final) { this.rpc.abort(new ControlError("INVALID_PROTOCOL", "Pi settled without a backend result")); return; }
    clearTimeout(prompt.timer); this.active = null; prompt.resolve(prompt.final);
  }
  private rejectActive(error: Error): void { const prompt = this.active; if (prompt) { clearTimeout(prompt.timer); for (const entry of prompt.tools.values()) if (entry.timer) clearTimeout(entry.timer); this.active = null; prompt.reject(error); } }
  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending=this.permissions.get(id);if(!pending)throw new ControlError("PERMISSION_UNAVAILABLE","native UI request unavailable");
    let response:Readonly<Record<string,unknown>>;
    if(pending.method==="confirm"&&["yes","no"].includes(option))response={confirmed:option==="yes"};
    else if(option==="cancel")response={cancelled:true};
    else if(pending.method==="select"&&/^choice-[0-9]+$/u.test(option)&&pending.choices[Number(option.slice(7))]!==undefined)response={value:pending.choices[Number(option.slice(7))]};
    else if(["input","editor"].includes(pending.method)&&option==="submit"&&typeof input==="string"&&Buffer.byteLength(input)<=65536&&!input.includes("\0"))response={value:input};
    else throw new ControlError("PERMISSION_UNAVAILABLE","native UI response unavailable");
    this.permissions.delete(id);if(pending.timer)clearTimeout(pending.timer);pending.resolve(response);
  }
  private cancelPermissions(): void { for (const pending of this.permissions.values()) { if (pending.timer) clearTimeout(pending.timer); pending.resolve({ cancelled: true }); } this.permissions.clear(); }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); this.closed = true; this.rejectActive(new ControlError("CLOSED", "Pi connection closed before settlement")); return this.rpc.close(); }
}
