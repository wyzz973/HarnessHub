import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TABLE_ENV, TABLE_LOAD_ENV, TABLE_MCP_NAME, TABLE_PROGRESS_ENV, TABLE_RECORD_ENV } from "../../../contracts/table.js";
import { nativeConversationId, requestExpiry, singleText, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun,
  type HarnessControl, type NativeCommand, type NativeConversationId, type NativeModelCatalog, type NativeOption, type NativeOptions, type NativeSessionImport, type NativeSessionPage,
  type NativeToolDetail, type NativeUsage, type ProtocolObservation, type SteerOutcome, type StopRequestReceipt, type TurnText } from "../../../contracts/control.js";
import type { ContentKind, ContentRef, ControlAttachment } from "../../../contracts/content.js";
import type { RelayCapabilities, RelayPacketId } from "../../../contracts/relay.js";
import { levelOptions, type ChosenLevels } from "../../../contracts/flavor.js";
import { ControlError, errorFrom, object } from "../../../infrastructure/control/json-rpc-process.js";
import { checkInputs, fileMentions, readAttachment } from "../../../infrastructure/control/attachments.js";
import { HERMES_EFFECTS, HERMES_REGISTRY, hermesClassify, hermesCommand, hermesNativeClassify, hermesReadsSlash, relayDeclaration } from "../relay-classify.js";
import { clearedNotice, COMMAND_REFUSED, hubCleared, measureBy } from "../relay-turn.js";
import { GatewayConnection, reasonOf, resolveHermesHome } from "./connection.js";
import { READ_COMMANDS } from "./methods.js";
import { approvalPrompt, choiceOf, clarifyPrompt, contextOf, historyOf, line, modelId, planEvent, record, splitModel, toolEvent, totalsOf, turnFailure, turnUsage, userTurns, waitOf,
  type Row, type Totals } from "./mapping.js";

/**
 * Hermes's relay declaration on its gateway: one text (packet, a blank line, the user's words); live evidence from the turn's committed user row
 * (`message.complete` `persisted_turn.user_row_id`), so a turn that ended proves nothing by itself; commands as Hermes reads them (relay-classify.ts);
 * the gateway runs the session (a viewer that leaves is no quiescence); a native title by `session.mutate rename`.
 */
export const hermesRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "recorded_event", successProvesRecorded: false },
  execution: "gateway",
  commands: { classify: hermesClassify },
  placement: { parts: "single", maxInput: null, measure: measureBy("single", "chars", ["file"]) },
  title: "set",
});

/** The edit approval policy of a session the driver opens (gateway/session_policy.py): ask, workspace_session (edits under the cwd go unasked), session (none ask). */
export const EDIT_POLICY = "edit_policy";
const EDIT_POLICIES = ["ask", "workspace_session", "session"] as const;
const EDIT_POLICY_NAMES: Readonly<Record<string, string>> = { ask: "改文件前都问", workspace_session: "工作区内改文件不问", session: "改文件都不问" };
/** Hermes's reasoning levels (hermes_constants.parse_reasoning_effort); `default` is the profile's own setting. */
export const REASONING = { id: "reasoning_effort", unset: "default", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as readonly string[] } as const;
/** A compression answers after its summary and commit; Hermes's own clients wait this long (hermes_cli/gateway_client.py COMPRESS_RPC_TIMEOUT). */
const COMPRESS_MS = 660_000;
/** How long a Turn's receipt (its usage) is waited for after the turn ended. */
const RECEIPT_MS = 5_000;
/** How long a stop waits for the turn's own end before it reads the receipt. */
const STOP_SETTLE_MS = 3_000;
const NOT_RECORDED = { input: "not_recorded" } as const;
const MAX_IMAGES = 10;
/** The commands the driver carries out by protocol verbs; the read commands go to the owner's `slash.exec`. */
const DRIVER_COMMANDS: readonly NativeCommand[] = [
  { name: "compress", description: "压缩上下文（Hermes 自己的压缩）", contextEffect: "compact" },
  { name: "undo", description: "撤回最近一轮（/undo N 撤回 N 轮）", contextEffect: "rewind" },
  { name: "title", description: "给这个 Hermes 会话改名", contextEffect: "none" },
  { name: "model", description: "换模型（下一轮起生效）", contextEffect: "none" },
  { name: "reasoning", description: "换思考强度（/reasoning reset 回到 Hermes 的设置）", contextEffect: "none" },
  { name: "export", description: "导出 Hermes 的会话记录（JSON）", contextEffect: "none" },
  { name: "new", description: "开一个新的 Hermes 会话", contextEffect: "clear" },
  { name: "clear", description: "开一个新的 Hermes 会话", contextEffect: "clear" },
  ...[...READ_COMMANDS].map(name => ({ name, description: "Hermes 的 /" + name, contextEffect: "none" as const })),
];
/** The session instructions after a new session's first prompt (entry.instructions `first-prompt`): marked as the Hub's, never the user's words. */
function instructionsBlock(text: string): string {
  return "<harnesshub-session-instructions>\n（以下是 HarnessHub 给这个会话的说明，不是用户的话。）\n" + text + "\n</harnesshub-session-instructions>";
}
const optional = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;
const integer = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
/** Features the driver turns off, with one line said, when the gateway does not advertise them (runtime.describe). */
type Feature = "tools" | "client" | "transcript";
const FEATURES: Readonly<Record<Feature, { readonly capability: string; readonly said: string }>> = {
  tools: { capability: "acp-session-mcp-v1", said: "这个 Hermes 网关不接受按会话提供的 MCP 服务器，HarnessHub 的工具这次用不了。" },
  client: { capability: "session-client-v1", said: "" },
  transcript: { capability: "session-transcript-v1", said: "" },
};

interface Run {
  readonly onEvent: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly started: Promise<void>;
  readonly signalStarted: () => void;
  readonly inputId: string;
  readonly packetId: RelayPacketId | null;
  readonly instructing: boolean;
  admission: string | null;
  generation: number | null;
  recorded: boolean;
  settled: boolean;
  settling: boolean;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  /** Frames of this session that came before the admission was known (the receipt and the first events race). */
  readonly early: Row[];
  /** The reply segment streaming now (its item id); null after a boundary, so the next text starts a new one. */
  segment: string | null;
  segments: number;
  thinking: string | null;
  thoughts: number;
  readonly tools: Map<string, NativeToolDetail>;
  context: NativeUsage["context"] | undefined;
}
interface PendingPrompt { readonly run: Run; readonly kind: "approval" | "clarify"; readonly promptId: string; readonly generation: number; readonly options: readonly string[]; readonly choices: readonly string[] }

/**
 * Hermes Agent over `hermes-gateway-v1` (2026-11-15; research of 2026-11-14, Part B): one WebSocket to the user's gateway per connection, one
 * native session on it. The gateway runs the session (its model, tools and approvals) and keeps it when this connection goes: a turn still
 * running when the Hub closes goes on there. What the driver adds is the Hub's: its clear, its policy answers, its tools for the session.
 *
 * Every message's outcome comes from the protocol: the submit's durable receipt (refused: never admitted, not recorded; an answer lost: unknown,
 * never sent again), the turn's committed user row (recorded), and the receipt read after the turn (its usage). A turn the gateway lost in a
 * restart stays unknown, is never resolved or re-run here, and blocks the session until the user discards it in Hermes.
 */
export class HermesGatewayControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = hermesRelayCapabilities;
  private connection: GatewayConnection | null = null;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private failure: Error | null = null;
  private readonly off = new Set<Feature>();
  /** What is said once, in the next Turn. */
  private readonly notes: string[] = [];
  private conversation: NativeConversationId | null = null;
  private subscription: string | null = null;
  private opening = false;
  private forkConnection = false;
  private watermark: { epoch: string | null; seq: number } = { epoch: null, seq: 0 };
  private info: Row = {};
  private active: Run | null = null;
  /** Every admission a Run of this connection submitted: a late frame of one of them belongs to no live Run. */
  private readonly admissions = new Set<string>();
  private readonly pending = new Map<string, PendingPrompt>();
  private interactivePermissions = false;
  private totals: Totals | null = null;
  private counted = 0;
  private instructions: string | null = null;
  private progress: boolean | undefined;
  private instructionsDue = false;
  private catalog: NativeModelCatalog | null = null;
  get unattributedUpdates(): number { return this.counted; }
  get steering(): boolean { return true; }
  healthy(): boolean { return this.initialized && this.failure === null && this.connection?.failure === null; }
  processGroup(): number | null { return null; }

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "hermes-gateway") throw new ControlError("INVALID_INPUT", "Hermes gateway control requires a hermes-gateway launch");
  }
  private get rpc(): GatewayConnection {
    if (this.failure) throw this.failure;
    if (this.connection === null || !this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
    return this.connection;
  }
  private request(method: string, params: Readonly<Record<string, unknown>>, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> { return this.rpc.request(method, params, timeoutMs); }
  initialize(): Promise<ProtocolObservation> {
    if (this.failure) return Promise.reject(this.failure);
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    const timeoutMs = this.options.startupTimeoutMs ?? this.options.requestTimeoutMs;
    try {
      const home = await resolveHermesHome({ ...this.options.env, ...this.launch.env });
      this.connection = await GatewayConnection.open(home, { event: params => this.event(params), request: method => this.serverRequest(method), closed: error => this.lost(error) },
        { timeoutMs, maxFrameBytes: this.options.maxFrameBytes });
      const described = object(await this.connection.request("runtime.describe", {}, timeoutMs), "Hermes runtime description");
      const capabilities = Array.isArray(described.capabilities) ? described.capabilities.filter((item): item is string => typeof item === "string") : [];
      const sources = Array.isArray(record(described.session_create)?.sources) ? (record(described.session_create)!.sources as unknown[]) : [];
      // The protocol check (T3 Code's drift check): a session the driver opens is a local editor session; without it nothing works.
      if (!sources.includes("acp") || !capabilities.includes("acp-editor-policy-v1"))
        throw new ControlError("NATIVE_GATEWAY_INCOMPATIBLE", "这个 Hermes 网关不支持编辑器会话（acp-editor-policy-v1），HarnessHub 用不了它；更新 Hermes 后再试。");
      for (const [feature, { capability, said }] of Object.entries(FEATURES) as [Feature, typeof FEATURES[Feature]][]) {
        if (capabilities.includes(capability)) continue;
        this.off.add(feature);
        if (said) this.notes.push(said);
      }
      this.initialized = true;
      const endpoint = this.connection.endpoint;
      return { protocol: "hermes-gateway", protocolVersion: 1, agentName: "hermes", agentVersion: endpoint.codeVersion, authenticationMethods: [],
        capabilities: { gateway: "hermes-gateway-v1", ...(endpoint.codeSha ? { codeSha: endpoint.codeSha } : {}), canonical: capabilities, ...(this.off.size ? { featuresOff: [...this.off] } : {}) } };
    } catch (error) { const failed = errorFrom(error); this.failure = failed; await this.connection?.close(); throw failed; }
  }
  private lost(error: ControlError): void {
    this.failure ??= error;
    const run = this.live();
    if (run !== null) this.failRun(run, new ControlError("NATIVE_OUTCOME_UNKNOWN", "Hermes 的网关断开了连接，这一轮的结果未知：它可能已经执行或还在 Hermes 里执行，不要重发。"));
  }
  /** The owner's own requests to this client (`sudo`, `secret`, a batch clarify): the Hub holds no secret and asked for no batch; each is refused. */
  private async serverRequest(method: string): Promise<unknown> {
    const run = this.live();
    if (run !== null && (method === "sudo" || method === "secret")) this.emit(run, { type: "notice", severity: "warning", title: "Hermes 要求输入" + (method === "sudo" ? "系统密码" : "一个密钥") + "，HarnessHub 不代为提供，已拒绝" });
    throw new ControlError("unsupported", "unsupported");
  }

  // ---- catalog ------------------------------------------------------------------------------------------------------------

  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const listed = object(await this.request("model.options", this.conversation === null ? {} : { session_id: this.conversation }), "Hermes model options");
    const providers = Array.isArray(listed.providers) ? listed.providers.map(value => record(value) ?? {}) : [];
    const models: NativeModelCatalog["models"][number][] = [], seen = new Set<string>();
    for (const provider of providers) {
      const slug = optional(provider.slug);
      if (slug === undefined || provider.authenticated === false || !Array.isArray(provider.models)) continue;
      const capabilities = record(provider.capabilities) ?? {};
      for (const name of provider.models) {
        if (typeof name !== "string" || !name || name.length > 512) continue;
        const id = modelId(slug, name);
        if (seen.has(id)) continue;
        seen.add(id);
        const reasoning = record(capabilities[name])?.reasoning !== false;
        models.push({ id, name: name + " · " + (optional(provider.name) ?? slug), ...(reasoning ? { options: [this.reasoningOption()] } : {}), inputs: { image: true, audio: false, file: true } });
      }
    }
    const current = optional(listed.model), provider = optional(listed.provider);
    const defaultModel = current === undefined ? null : provider === undefined ? current : modelId(provider, current);
    if (defaultModel !== null && !seen.has(defaultModel)) models.unshift({ id: defaultModel, name: current!, options: [this.reasoningOption()], inputs: { image: true, audio: false, file: true } });
    this.catalog = { models, defaultModel, canSelect: models.length > 0, options: [this.editPolicyOption()], commands: DRIVER_COMMANDS,
      authentication: providers.some(row => row.authenticated === true) ? "ready" : providers.length ? "missing" : "unknown", inputs: { image: true, audio: false, file: true } };
    return this.catalog;
  }
  private editPolicyOption(): NativeOption {
    const current = optional(this.info.edit_approval_policy) ?? "ask";
    return { id: EDIT_POLICY, name: "改文件的审批", category: "mode", currentValue: current, values: EDIT_POLICIES.map(value => ({ value, name: EDIT_POLICY_NAMES[value]! })) };
  }
  private reasoningOption(): NativeOption {
    return { id: REASONING.id, name: "思考强度", category: "thought_level", currentValue: optional(this.info.reasoning_effort) ?? REASONING.unset,
      values: [{ value: REASONING.unset, name: "按 Hermes 的设置" }, ...REASONING.values.map(value => ({ value, name: value }))] };
  }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return hermesNativeClassify(text, catalog, attachments); }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    checkInputs(attachments, { image: true, audio: false, file: true });
    if (attachments.filter(item => item.kind === "image").length > MAX_IMAGES) throw new ControlError("ATTACHMENT_LIMIT", "Hermes 一轮最多接受 " + MAX_IMAGES + " 张图片");
    for (const item of attachments) if (item.kind === "image" && !/^image\/(?:png|jpe?g|gif|webp)$/u.test(item.mediaType)) throw new ControlError("ATTACHMENT_UNSUPPORTED", "Hermes 只接受 PNG、JPEG、GIF、WebP 图片：" + item.name);
  }

  // ---- sessions -----------------------------------------------------------------------------------------------------------

  async checkpoint(): Promise<string | null> { return this.conversation; }
  setSessionInstructions(text: string | null, tools?: { readonly progress: boolean }): void { this.instructions = text; this.progress = tools?.progress; }
  /** The Hub's tool program as an editor MCP server of the session (ACP's stdio shape, `session.create editor.mcp_servers`), with this process's table variables. */
  private hubToolServers(): readonly Row[] {
    if (this.options.entry?.tools !== "acp" || this.off.has("tools")) return [];
    const url = this.options.env[TABLE_ENV.url], token = this.options.env[TABLE_ENV.session], tool = fileURLToPath(new URL("../../../cli/hub-tools.js", import.meta.url));
    if (!url || !token || !existsSync(tool)) return [];
    const carried = [TABLE_RECORD_ENV, TABLE_LOAD_ENV].flatMap(name => this.options.env[name] ? [{ name, value: this.options.env[name]! }] : []);
    const progress = this.progress === false ? [{ name: TABLE_PROGRESS_ENV, value: "off" }] : [];
    return [{ name: TABLE_MCP_NAME, command: process.execPath, args: [tool, "mcp"], env: [{ name: TABLE_ENV.url, value: url }, { name: TABLE_ENV.session, value: token }, ...carried, ...progress] }];
  }
  get sessionTools(): boolean { return this.hubToolServers().length > 0; }
  private levels(): ChosenLevels {
    return { ...(this.options.permission === undefined ? {} : { permission: this.options.permission }), ...(this.options.effort === undefined ? {} : { effort: this.options.effort }) };
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private assertOwned(id: NativeConversationId): void {
    this.assertInitialized();
    if (this.conversation === null || id !== this.conversation || this.opening) throw new ControlError("IDENTITY_MISMATCH", "session is not owned by this connection");
  }
  /** A snapshot taken in: the replay watermark (frames at or below it are not new), the fences, the session's policy. */
  private adopt(snapshot: Row): void {
    const epoch = optional(snapshot.replay_epoch), seq = integer(snapshot.last_sequence) ?? 0;
    if (epoch !== undefined && (epoch !== this.watermark.epoch || seq > this.watermark.seq)) this.watermark = { epoch, seq };
    const sub = optional(snapshot.subscription_id);
    if (sub !== undefined) this.subscription = sub;
    const info = record(snapshot.info);
    if (info !== null) this.info = { ...this.info, ...info };
  }
  private unknownPending(snapshot: Row): readonly string[] {
    return (Array.isArray(snapshot.pending) ? snapshot.pending : []).flatMap(value => { const row = record(value); return row?.status === "unknown" && typeof row.admission_id === "string" ? [row.admission_id] : []; });
  }
  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation !== null || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "this connection already owns a session");
    this.opening = true;
    try {
      const levels = this.levels();
      const chosen = levelOptions(this.options.flavor, [this.editPolicyOption(), this.reasoningOption()], native, levels, checkpoint !== undefined) ?? {};
      for (const id of Object.keys(chosen)) if (id !== EDIT_POLICY && id !== REASONING.id) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "native option unavailable for selected Harness");
      const policy = chosen[EDIT_POLICY], effort = chosen[REASONING.id];
      if (policy !== undefined && !(EDIT_POLICIES as readonly string[]).includes(policy)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "Hermes has no such edit approval policy");
      if (effort !== undefined && effort !== REASONING.unset && !REASONING.values.includes(effort)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "Hermes has no such reasoning effort");
      const yolo = levels.permission !== undefined && this.options.flavor?.permission[levels.permission]?.session?.params?.yolo === true;
      const servers = this.hubToolServers(), route = model === undefined ? undefined : splitModel(model);
      let snapshot: Row;
      if (checkpoint === undefined) {
        snapshot = object(await this.request("session.create", {
          request_id: randomUUID(), source: "acp", cwd, ...(route === undefined ? {} : { model: route.model, ...(route.provider ? { provider: route.provider } : {}) }),
          ...(effort !== undefined && effort !== REASONING.unset ? { reasoning: effort } : {}), ...(yolo ? { yolo: true } : {}), checkpoints: true,
          // A new editor session asks before every edit (gateway/session_local_editor.py: "every edit is approved one at a time"); another policy is a change after it.
          editor: { mcp_servers: servers, edit_approval_policy: "ask" }, ...(this.off.has("client") ? {} : { client: { name: "harnesshub", version: "0.0.0" } }),
        }, this.setupMs()), "Hermes session");
        this.totals = { cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
      } else {
        snapshot = await this.resumeWith(nativeConversationId(checkpoint), servers);
        this.totals = null;
      }
      const id = nativeConversationId(snapshot.session_id);
      if (checkpoint !== undefined && id !== checkpoint) throw new ControlError("IDENTITY_MISMATCH", "native restore returned a different session");
      this.conversation = id; this.info = {}; this.adopt(snapshot);
      if (checkpoint === undefined && policy !== undefined && policy !== "ask") await this.mutate("edit_policy", { policy });
      if (checkpoint !== undefined) {
        // What the level asks of a restored session is set on it: the edit policy, the effort and the model, each a fenced change of its own.
        if (policy !== undefined && this.info.edit_approval_policy !== policy) await this.mutate("edit_policy", { policy });
        if (effort !== undefined && (this.info.reasoning_effort ?? REASONING.unset) !== effort) await this.mutate("reasoning", { effort: effort === REASONING.unset ? null : effort });
        if (route !== undefined && (this.info.model !== route.model || (route.provider !== undefined && optional(this.info.provider)?.toLowerCase() !== route.provider))) await this.switchModel(route);
        if (yolo && this.info.yolo !== true) this.notes.push("这个 Hermes 会话开的时候不是“完全放开”，Hermes 只能在开会话时打开 yolo；Hub 会按档位自动允许它来问的操作。");
        const lost = this.unknownPending(snapshot);
        if (lost.length) this.notes.push("这个会话里有一轮在 Hermes 网关重启时丢失、结果未知，放弃它之前 Hermes 不接受新消息。先在 Hermes 里放弃它（/discard " + lost[0] + "，或 hermes sessions discard " + id + "），再继续。");
        const stats = record(await this.request("session.stats", { session_id: id }).catch(() => null));
        if (stats !== null) { const now = totalsOf(stats); if (now !== null) this.totals = { ...now, cost: null }; }
      }
      // Hermes streams reasoning only for a session a viewer asked it of (acp_adapter/gateway_server.py `_request_live_reasoning`); a display flag of this session alone.
      await this.request("config.set", { session_id: id, key: "show_reasoning", value: "1" }, 10_000).catch(() => {});
      this.instructionsDue = checkpoint === undefined && this.instructions !== null && this.options.entry?.instructions === "first-prompt";
      return id;
    } catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && reasonOf(error) === "not_found" && checkpoint !== undefined) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the Harness has no session with this identity");
      throw error;
    } finally { this.opening = false; }
  }
  private setupMs(): number { return Math.max(this.options.requestTimeoutMs, this.options.startupTimeoutMs ?? 0); }
  /**
   * `session.resume` with this connection's tool server. Hermes freezes a session's editor servers by their fingerprint, which holds this process's
   * table token, so a later process meets `acp_mcp_policy_conflict`: the servers are re-bound by the fenced `editor_mcp` change (idle only, as
   * acp_adapter/gateway_server.py `_rebind_editor_mcp` does) and the session attached again with them. A session that cannot be re-bound keeps its own.
   */
  private async resumeWith(id: NativeConversationId, servers: readonly Row[]): Promise<Row> {
    try { return object(await this.request("session.resume", { session_id: id, ...(servers.length ? { editor: { mcp_servers: servers } } : {}) }, this.setupMs()), "Hermes session"); }
    catch (error) {
      if (reasonOf(error) !== "acp_mcp_policy_conflict") throw error;
      const plain = object(await this.request("session.resume", { session_id: id }, this.setupMs()), "Hermes session");
      try {
        await this.request("session.mutate", { session_id: id, request_id: randomUUID(), expected_revision: integer(plain.revision) ?? 0, expected_generation: integer(plain.execution_generation) ?? 0,
          operation: "editor_mcp", payload: { mcp_servers: servers } }, this.setupMs());
        return object(await this.request("session.resume", { session_id: id, editor: { mcp_servers: servers } }, this.setupMs()), "Hermes session");
      } catch (failure) {
        if (reasonOf(failure) === null) throw failure;
        this.notes.push("这个 Hermes 会话没能换上这次的 HarnessHub 工具（" + reasonOf(failure) + "），它的 harnesshub 工具这一轮可能用不了。");
        return plain;
      }
    }
  }
  /** A fresh snapshot of the open session (its fences and transcript), as Hermes's own controls read one before each change. */
  private async snapshot(): Promise<Row> {
    const snapshot = object(await this.request("session.resume", { session_id: this.conversation! }, this.setupMs()), "Hermes session");
    this.adopt(snapshot);
    return snapshot;
  }
  /** One revision-fenced change of the open session (session.mutate); a rename carries no generation fence, as on Hermes's own clients. */
  private async mutate(operation: string, payload: Readonly<Record<string, unknown>>, snapshot?: Row): Promise<Row> {
    const fence = snapshot ?? await this.snapshot();
    const result = object(await this.request("session.mutate", { session_id: this.conversation!, request_id: randomUUID(), expected_revision: integer(fence.revision) ?? 0,
      ...(operation === "rename" ? {} : { expected_generation: integer(fence.execution_generation) ?? 0 }), operation, payload }, operation === "compress" ? COMPRESS_MS : this.setupMs()), "Hermes mutation");
    return result;
  }
  /** A model change: applied now while idle, or when the running turn ends (`deferred`); a guarded target that asks for a confirmation is not taken. */
  private async switchModel(route: { readonly provider?: string; readonly model: string }): Promise<Row> {
    const result = await this.mutate("model", { model: route.model, ...(route.provider ? { provider: route.provider } : {}) });
    if (result.status === "confirmation_required") throw new ControlError("NATIVE_OPTION_MISMATCH", "Hermes 要先确认才能换到这个模型（" + line(optional(result.confirm_message) ?? "", 300) + "），没有换。可以在 Hermes 里换。");
    const info = record((await this.snapshot()).info);
    if (info !== null) this.info = { ...this.info, ...info };
    return result;
  }
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    this.assertOwned(id);
    const name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 200).join("").trim();
    if (!name) return;
    try { await this.mutate("rename", { title: name }); }
    catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR") throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "Hermes did not name the session"); throw error; }
  }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    if (this.conversation === null) return null;
    const info = record(await this.request("session.info", { session_id: this.conversation }).catch(() => null));
    if (info !== null) this.info = { ...this.info, ...info };
    const model = optional(this.info.model), provider = optional(this.info.provider);
    return { model: model === undefined ? null : provider === undefined ? model : modelId(provider, model),
      options: { [EDIT_POLICY]: optional(this.info.edit_approval_policy) ?? "ask", [REASONING.id]: optional(this.info.reasoning_effort) ?? REASONING.unset } };
  }
  /**
   * Takes the last `turns` turns out of the native history (`session.mutate rewind` to the user row `turns` back: that row and everything after it
   * are archived). Idle only; NATIVE_ROLLBACK_UNAVAILABLE when the session has fewer turns, or Hermes refuses.
   */
  async rollback(id: NativeConversationId, turns: number): Promise<void> {
    this.assertOwned(id);
    if (!Number.isSafeInteger(turns) || turns < 1) throw new ControlError("INVALID_INPUT", "turns must be a positive integer");
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a turn is active");
    const snapshot = await this.snapshot(), listed = userTurns(snapshot.messages);
    if (listed.length < turns) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "Hermes 的这个会话没有那么多轮可以撤回");
    try {
      const result = await this.mutate("rewind", { target_message_id: listed[listed.length - turns]!.rowId }, snapshot);
      if (result.status === "nothing" || integer(result.rewound_count) === 0) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "Hermes 没有撤回任何内容");
    } catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR") throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "Hermes 拒绝了撤回（" + (reasonOf(error) ?? "") + "）"); throw error; }
    await this.snapshot();
  }
  /**
   * Hermes's file checkpoints of the open session (`checkpoints: true` at create; tools/checkpoint_manager.py): the newest first, each a hash and
   * Hermes's own note. Empty when checkpointing is off for the session.
   */
  async fileCheckpoints(id: NativeConversationId): Promise<readonly { readonly hash: string; readonly at: string; readonly message: string }[]> {
    this.assertOwned(id);
    const listed = object(await this.request("rollback.list", { session_id: id }), "Hermes checkpoints");
    if (listed.enabled !== true || !Array.isArray(listed.checkpoints)) return [];
    return listed.checkpoints.flatMap(value => { const row = record(value), hash = optional(row?.hash); return hash === undefined ? [] : [{ hash, at: optional(row?.timestamp) ?? "", message: optional(row?.message) ?? "" }]; });
  }
  /** Restores the working tree (or one file) to a Hermes checkpoint, keeping the user's own edits as Hermes does by default; true when it says it restored. */
  async restoreFileCheckpoint(id: NativeConversationId, hash: string, file?: string): Promise<boolean> {
    this.assertOwned(id);
    if (!/^[0-9a-f]{4,64}$|^[1-9][0-9]{0,4}$/u.test(hash)) throw new ControlError("INVALID_INPUT", "invalid checkpoint");
    const result = object(await this.request("rollback.restore", { session_id: id, hash, ...(file === undefined ? {} : { file_path: file }) }, this.setupMs()), "Hermes restore");
    return result.success === true;
  }
  /** `session.mutate branch` of a stored session on a connection that opened none: the copy's own identity; the source is left as it was. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    this.assertInitialized();
    if (this.conversation !== null || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "a fork needs its own connection");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    this.forkConnection = true;
    const source = nativeConversationId(checkpoint);
    try {
      const snapshot = object(await this.request("session.resume", { session_id: source }, this.setupMs()), "Hermes session");
      const result = object(await this.request("session.mutate", { session_id: source, request_id: randomUUID(), expected_revision: integer(snapshot.revision) ?? 0,
        expected_generation: integer(snapshot.execution_generation) ?? 0, operation: "branch", payload: {} }, this.setupMs()), "Hermes branch");
      const child = nativeConversationId(result.branched_session_id);
      if (child === source) throw new ControlError("IDENTITY_MISMATCH", "Hermes branched into its source session");
      if (optional(snapshot.subscription_id)) await this.request("session.detach", { session_id: source, subscription_id: snapshot.subscription_id }).catch(() => {});
      if (optional(record(snapshot.info)?.cwd) !== undefined && record(snapshot.info)!.cwd !== cwd) {
        const branched = object(await this.request("session.resume", { session_id: child }, this.setupMs()), "Hermes session");
        await this.request("session.mutate", { session_id: child, request_id: randomUUID(), expected_revision: integer(branched.revision) ?? 0, expected_generation: integer(branched.execution_generation) ?? 0,
          operation: "workspace", payload: { cwd } }, this.setupMs());
        if (optional(branched.subscription_id)) await this.request("session.detach", { session_id: child, subscription_id: branched.subscription_id }).catch(() => {});
      }
      return child;
    } catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR") throw new ControlError("NATIVE_FORK_UNAVAILABLE", "Hermes 拒绝了分支（" + (reasonOf(error) ?? "") + "）");
      throw error;
    }
  }
  /** This workspace's stored sessions (`session.list` with the picker's fields, Hermes's own workspace rule), newest first. */
  async nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    if (cursor !== undefined) return { sessions: [], nextCursor: null };
    const listed = object(await this.request("session.list", { scope: "stored", limit: 200, workspace: cwd, picker: true }), "Hermes session list");
    const sessions = (Array.isArray(listed.sessions) ? listed.sessions : []).flatMap(value => {
      const row = record(value), id = optional(row?.session_id);
      if (row === null || id === undefined || (row.cwd !== undefined && row.cwd !== null && row.cwd !== cwd)) return [];
      const at = typeof row.last_active_at === "number" ? row.last_active_at : typeof row.started_at === "number" ? row.started_at : null;
      return [{ id, title: optional(row.title) ?? null, updatedAt: at === null ? null : Math.round(at * 1000), ...(optional(row.source) ? { source: optional(row.source)! } : {}) }];
    });
    return { sessions, nextCursor: null };
  }
  /** Reads one stored session for continuing it: attaches as a viewer, reads its transcript, detaches. Sends nothing and changes nothing. */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    this.assertInitialized();
    const snapshot = object(await this.request("session.resume", { session_id: id }, this.setupMs()), "Hermes session");
    if (optional(snapshot.subscription_id)) await this.request("session.detach", { session_id: id, subscription_id: snapshot.subscription_id }).catch(() => {});
    const info = record(snapshot.info) ?? {};
    if (optional(info.cwd) !== undefined && info.cwd !== cwd) throw new ControlError("NATIVE_SESSION_WORKSPACE_MISMATCH", "the session belongs to another workspace");
    return { checkpoint: optional(snapshot.session_id) ?? id, title: optional(info.title) ?? null, history: historyOf(snapshot.messages), omitted: 0, complete: snapshot.messages_omitted !== true, historyRead: true };
  }

  // ---- turns --------------------------------------------------------------------------------------------------------------

  private nothingSent(result: BackendResult): ControlRun { return { result: Promise.resolve(result), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent, so there is no native turn to stop")) }; }
  private done(run: Promise<BackendResult>): ControlRun { return { result: run, requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a command the driver runs has no native turn to stop")) }; }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    this.assertOwned(id);
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a turn is already active");
    const prompt = typeof turn === "string" ? turn : turn.user, kinds = attachments.map(file => file.kind);
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    // How Hermes reads the input: a registry command (any case, aliases), unless an attachment makes it prompt text.
    const named = attachments.length === 0 && hermesReadsSlash(kinds) ? hermesCommand(prompt) : null, command = named === null ? undefined : HERMES_REGISTRY.get(named.word.toLowerCase());
    let text: string;
    if (typeof turn !== "string") {
      const reading = hermesClassify(turn.user, null, kinds);
      if (reading.kind === "content") text = singleText(turn);
      else if (reading.kind === "command" && reading.acceptsRelay === true && named !== null && named.args !== "") text = singleText({ ...turn, user: named.args });
      else return this.nothingSent(COMMAND_REFUSED);
    } else if (command !== undefined && named !== null) {
      const handled = this.command(command, named.args, onEvent);
      if (handled !== null) return handled;
      // `/queue` and `/steer` submit their words as a prompt (gateway_commands.py `_prompt`, `_steer`); a bare one only answers its usage.
      if ((command === "queue" || command === "steer") && named.args !== "") text = named.args;
      else {
        onEvent({ type: "notice", severity: "warning", title: "/" + command + " 这个 Hermes 命令在 HarnessHub 里还不能用", detail: "可以在 Hermes 自己的终端里运行它。" });
        return this.nothingSent({ status: "failed", reason: "command_unsupported", error: { code: "NATIVE_COMMAND_UNSUPPORTED", message: "这个 Hermes 命令在 HarnessHub 里还不能用" }, ...NOT_RECORDED });
      }
    } else text = prompt;
    return this.submit(id, text + fileMentions(attachments.filter(file => file.kind === "file")), onEvent, attachments, typeof turn === "string" ? null : turn.relay.packetId);
  }
  /** A command the driver carries out itself, by its registry name; null when it is not one of them. */
  private command(name: string, args: string, onEvent: (event: ControlEvent) => void): ControlRun | null {
    const effect = HERMES_EFFECTS[name];
    if (effect === "clear") {
      // The Hub's clear: nothing is sent, the session stays in the user's gateway as it was, and the next Turn opens a new one.
      const old = this.conversation!, subscription = this.subscription;
      this.conversation = null; this.subscription = null; this.info = {}; this.totals = null; this.watermark = { epoch: null, seq: 0 };
      if (subscription !== null) void this.connection?.request("session.detach", { session_id: old, subscription_id: subscription }).catch(() => {});
      onEvent(clearedNotice(name, "Hermes"));
      return this.done(Promise.resolve(hubCleared()));
    }
    const reply = (said: string): void => onEvent({ type: "text", text: said, item: "command:" + randomUUID() });
    const failed = (error: unknown): BackendResult => {
      const reason = reasonOf(error);
      if (reason !== null) { onEvent({ type: "notice", severity: "warning", title: "Hermes 没有执行 /" + name + "（" + reason + "）" }); return { status: "failed", reason: "request_rejected", error: { code: "NATIVE_COMMAND_REFUSED", message: "Hermes 拒绝了 /" + name + "（" + reason + "）" }, ...NOT_RECORDED }; }
      throw error;
    };
    const run = async (body: () => Promise<BackendResult>): Promise<BackendResult> => { try { return await body(); } catch (error) { return failed(error); } };
    switch (name) {
      case "compress": return this.done(run(async () => {
        const words = args.trim(), preview = /^--(?:preview|dry-?run)$/iu.test(words);
        onEvent({ type: "activity", id: "compress", kind: "compaction", title: "上下文压缩", status: "running" });
        try {
          const result = await this.mutate("compress", preview ? { preview: true } : words ? { focus: words } : {});
          const summary = record(result.summary) ?? {};
          const lines = [optional(summary.headline), optional(summary.token_line), ...(Array.isArray(result.lines) ? result.lines.filter((item): item is string => typeof item === "string") : [])]
            .filter((part): part is string => part !== undefined).join("\n");
          onEvent({ type: "activity", id: "compress", kind: "compaction", title: "上下文压缩", status: "completed", ...(lines ? { detail: lines } : {}) });
          return { status: "completed", reason: preview ? "previewed" : "compressed", ...NOT_RECORDED, ...(result.status === "noop" || summary.noop === true || summary.aborted === true || summary.refused_would_grow === true ? { command: "noop" as const } : {}) };
        } catch (error) {
          onEvent({ type: "activity", id: "compress", kind: "compaction", title: "上下文压缩", status: "failed" });
          if (reasonOf(error) === "nothing_to_compress") return { status: "completed", reason: "compressed", command: "noop", ...NOT_RECORDED };
          throw error;
        }
      }));
      case "title": return args.trim() ? this.done(run(async () => { await this.mutate("rename", { title: args.trim().slice(0, 200) }); reply("会话已改名：" + args.trim().slice(0, 200)); return { status: "completed", reason: "renamed", ...NOT_RECORDED }; })) : null;
      case "model": return args.trim() ? this.done(run(async () => {
        const result = await this.switchModel(splitModel(args.trim().split(/\s+/u)[0]!));
        reply(result.status === "deferred" ? "这一轮结束后换到 " + args.trim() : "已换到 " + (optional(this.info.model) ?? args.trim()));
        return { status: "completed", reason: "model_switched", ...NOT_RECORDED };
      })) : null;
      case "reasoning": return args.trim() ? this.done(run(async () => {
        const level = args.trim().toLowerCase(), effort = level === "reset" || level === REASONING.unset ? null : level;
        if (effort !== null && !REASONING.values.includes(effort)) { reply("Hermes 的思考强度可以是：" + REASONING.values.join("、") + "，或 reset。"); return { status: "completed", reason: "usage", ...NOT_RECORDED }; }
        await this.mutate("reasoning", { effort });
        reply(effort === null ? "思考强度回到 Hermes 的设置" : "思考强度：" + effort);
        return { status: "completed", reason: "reasoning_set", ...NOT_RECORDED };
      })) : null;
      case "undo": return this.done(run(async () => {
        const turns = args.trim() ? Number(args.trim()) : 1;
        if (!Number.isSafeInteger(turns) || turns < 1) { reply("用法：/undo [轮数]"); return { status: "completed", reason: "usage", ...NOT_RECORDED }; }
        await this.rollback(this.conversation!, turns);
        reply("已撤回最近 " + turns + " 轮");
        return { status: "completed", reason: "rewound", ...NOT_RECORDED };
      }));
      case "export": return this.done(run(async () => {
        const exported = object(await this.request("session.export", { session_id: this.conversation!, format: "json" }, this.setupMs()), "Hermes export");
        const content = typeof exported.content === "string" ? exported.content : "";
        onEvent({ type: "output", output: { kind: "content", name: optional(exported.filename)?.replace(/[^\w.-]/gu, "_") ?? "hermes-" + this.conversation + ".json", mediaType: "application/json", data: Buffer.from(content, "utf8") } });
        return { status: "completed", reason: "exported", ...NOT_RECORDED };
      }));
      default:
        if (!READ_COMMANDS.has(name) || (name === "usage" && args.trim() !== "")) return null;
        return this.done(run(async () => {
          const result = object(await this.request("slash.exec", { session_id: this.conversation!, command: "/" + name + (args ? " " + args : "") }), "Hermes command");
          const said = [optional(result.output), optional(result.warning), optional(result.message), optional(result.notice)].filter((part): part is string => part !== undefined).join("\n\n");
          if (said) reply(said);
          return { status: "completed", reason: "command", ...NOT_RECORDED };
        }));
    }
  }
  private async submit(id: NativeConversationId, said: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[], packetId: RelayPacketId | null): Promise<ControlRun> {
    const instructing = this.instructionsDue && this.instructions !== null;
    const text = instructing ? said + "\n\n" + instructionsBlock(this.instructions!) : said;
    // Images are staged in the profile's cache by the owner (image.attach_bytes) and handed with the submit by path.
    const staged: Row[] = [];
    for (const file of attachments) {
      if (file.kind !== "image") continue;
      const result = object(await this.request("image.attach_bytes", { session_id: id, content_base64: (await readAttachment(file)).toString("base64"), filename: file.name }, this.setupMs()), "Hermes image");
      if (typeof result.path !== "string" || typeof result.mime !== "string") throw new ControlError("INVALID_PROTOCOL", "Hermes did not stage the image");
      staged.push({ path: result.path, mime: result.mime });
    }
    let resolve!: (value: BackendResult) => void, reject!: (error: Error) => void, signalStarted!: () => void;
    const result = new Promise<BackendResult>((res, rej) => { resolve = res; reject = rej; });
    const started = new Promise<void>(res => { signalStarted = res; });
    const run: Run = { onEvent, resolve, reject, started, signalStarted, inputId: randomUUID(), packetId, instructing,
      timer: this.options.runTimeoutMs === undefined ? undefined : setTimeout(() => this.failRun(run, new ControlError("RUN_TIMEOUT", "Hermes turn exceeded its deadline")), this.options.runTimeoutMs),
      admission: null, generation: null, recorded: false, settled: false, settling: false, stopping: false, stop: null, early: [], segment: null, segments: 0, thinking: null, thoughts: 0, tools: new Map(), context: undefined };
    this.active = run;
    for (const note of this.notes.splice(0)) this.safeEmit(run, { type: "diagnostic", message: note });
    if (instructing) this.instructionsDue = false;
    void this.request("prompt.submit", { session_id: id, input_id: run.inputId, text, ...(staged.length ? { attachments: staged } : {}) }).then(value => {
      const receipt = object(value, "Hermes admission receipt"), admission = optional(receipt.admission_id);
      if (admission === undefined) { if (receipt.voice_stopped === true) this.finish(run, { status: "completed", reason: "no_turn", ...NOT_RECORDED }); else this.failRun(run, new ControlError("INVALID_PROTOCOL", "Hermes admitted nothing")); return; }
      run.admission = admission; this.admissions.add(admission); run.signalStarted();
      if (receipt.status === "unknown") { this.unknown(run, admission); return; }
      if (receipt.status === "terminal") { void this.settleFromReceipt(run); return; }
      for (const frame of run.early.splice(0)) this.sessionFrame(frame);
    }, (error: unknown) => {
      run.signalStarted();
      const reason = reasonOf(error);
      if (reason !== null) {
        if (instructing && this.conversation === id) this.instructionsDue = true;
        if (reason === "unknown_execution") this.safeEmit(run, { type: "diagnostic", message: "Hermes 没有接收这条消息：这个会话里有一轮在网关重启时丢失、结果未知，放弃它之前 Hermes 不接受新消息。先在 Hermes 里放弃它（/discard，或 hermes sessions discard " + id + "），再重新发送。" });
        // The owner refused it before admission: nothing of it is in the session.
        this.finish(run, { status: "failed", reason: "request_rejected", error: { code: "NATIVE_REQUEST_REFUSED", message: "Hermes 拒绝了这条消息（" + reason + "）" }, ...NOT_RECORDED });
        return;
      }
      if (error instanceof ControlError && error.code === "NATIVE_NOT_SENT") { this.finish(run, { status: "failed", reason: "not_sent", error: { code: "NATIVE_DISCONNECTED", message: error.message }, ...NOT_RECORDED }); return; }
      // The answer was lost: Hermes may hold the admission. Unknown, never sent again here.
      this.safeEmit(run, { type: "diagnostic", message: "这条消息发给 Hermes 后没有收到确认，结果未知：它可能已经在 Hermes 里执行，不要重发。" });
      this.finish(run, { status: "failed", reason: "unknown_outcome", error: { code: "NATIVE_OUTCOME_UNKNOWN", message: "Hermes 没有确认收到这条消息，结果未知" } });
    });
    return { result, requestStop: () => {
      if (run.stop) return run.stop;
      if (run.settled || this.active !== run) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      run.stopping = true; this.cancelPrompts(run);
      run.stop = this.stopTurn(run, id);
      return run.stop;
    } };
  }
  /** Retires the admission (`prompt.cancel`: a queued one never runs, a started one is interrupted in the same call); a stale generation falls back to `session.interrupt` of that admission's own turn. */
  private async stopTurn(run: Run, id: NativeConversationId): Promise<StopRequestReceipt> {
    await run.started;
    if (run.settled || run.admission === null) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
    try {
      const receipt = object(await this.request("prompt.cancel", { session_id: id, admission_id: run.admission }), "Hermes cancel receipt");
      if (receipt.status === "terminal") setTimeout(() => { if (!run.settled) void this.settleFromReceipt(run); }, STOP_SETTLE_MS);
    } catch (error) {
      if (reasonOf(error) !== "stale_generation") throw errorFrom(error);
      const receipt = object(await this.request("prompt.receipt", { session_id: id, admission_id: run.admission }), "Hermes receipt");
      if (receipt.status === "started" && integer(receipt.execution_generation) !== undefined) {
        await this.request("session.interrupt", { session_id: id, execution_generation: receipt.execution_generation }).catch((failure: unknown) => { if (reasonOf(failure) !== "stale_generation") throw failure; });
      }
    }
    return { requested: true };
  }
  /**
   * HarnessControl.steer: `session.steer` with the running turn's generation. Hermes queues the words for the agent's next step (taken), redirects the
   * model request in flight (taken), or rejects them: `delivered: false` says no agent saw them (not taken); a plain rejection may follow delivery
   * (it then cannot tell, and the words are never sent again). It never starts a turn of its own.
   */
  async steer(id: NativeConversationId, text: string): Promise<SteerOutcome> {
    this.assertOwned(id);
    if (typeof text !== "string" || text.length === 0) throw new ControlError("INVALID_INPUT", "steering words must contain text");
    const run = this.active;
    if (run === null || run.settled || run.stopping || run.settling) return "not_taken";
    if (run.generation === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run.started, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.requestTimeoutMs); })]);
      clearTimeout(timer);
      // Queued behind another turn: not running yet, so not this turn's to steer.
      if (run.generation === null && run.admission !== null) await new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); });
      clearTimeout(timer);
    }
    if (run.generation === null || run.settled || this.active !== run) return "not_taken";
    try {
      const ack = object(await this.request("session.steer", { session_id: id, text, execution_generation: run.generation }), "Hermes steer");
      if (ack.status === "queued" || ack.status === "redirected") return "taken";
      if (ack.status === "rejected" && ack.delivered === false) return "not_taken";
      throw new ControlError("NATIVE_OUTCOME_UNKNOWN", "Hermes 没说这段话有没有进入这一轮");
    } catch (error) {
      if (reasonOf(error) !== null) return "not_taken";
      throw errorFrom(error);
    }
  }

  // ---- events ---------------------------------------------------------------------------------------------------------------

  private live(): Run | null { return this.active !== null && !this.active.settled ? this.active : null; }
  private emit(run: Run, event: ControlEvent): void { if (!run.settled) run.onEvent(event); }
  private safeEmit(run: Run, event: ControlEvent): void {
    try { this.emit(run, event); } catch (error) { this.failure ??= errorFrom(error); this.failRun(run, errorFrom(error)); }
  }
  /** One `event` frame. Frames of another session (the gateway's broadcasts, a session given up) are counted; a frame at or below the watermark is not new. */
  private event(params: Row): void {
    const session = optional(params.session_id);
    if (session === undefined || session !== this.conversation) { if (session !== undefined) this.counted++; return; }
    const epoch = optional(params.replay_epoch), seq = integer(params.seq);
    if (epoch !== undefined && seq !== undefined) {
      if (epoch === this.watermark.epoch && seq <= this.watermark.seq) return;
      this.watermark = { epoch, seq };
    }
    const run = this.live();
    if (run !== null && run.admission === null && params.type !== "session.info") { run.early.push(params); return; }
    this.sessionFrame(params);
  }
  private sessionFrame(params: Row): void {
    const type = optional(params.type) ?? "", payload = record(params.payload) ?? {}, admission = optional(params.admission_id), run = this.live();
    if (type === "session.info") { this.sessionInfo(payload); return; }
    if (type === "session.replay_gap") { void this.replayGap(); return; }
    if (type === "session.title" || type === "session.updated") {
      if (type === "session.updated" && run !== null && payload.operation === "model" && (payload.status === "refused" || payload.status === "confirmation_required"))
        this.safeEmit(run, { type: "notice", severity: "warning", title: "Hermes 没有换模型", ...(optional(payload.reason) ? { detail: optional(payload.reason)! } : {}) });
      return;
    }
    // A frame of an admission that is not the live Run's (an earlier Run's, another viewer's) belongs to no Run.
    if (run === null || (admission !== undefined && admission !== run.admission)) { this.counted++; return; }
    const generation = integer(params.execution_generation);
    if (generation !== undefined && admission === run.admission && run.generation === null) run.generation = generation;
    try { this.frame(run, type, payload); } catch (error) { this.failure ??= errorFrom(error); this.failRun(run, errorFrom(error)); }
  }
  private frame(run: Run, type: string, payload: Row): void {
    switch (type) {
      case "message.delta": {
        if (payload.text === null) { run.segment = null; return; }
        if (typeof payload.text !== "string" || payload.text === "") return;
        const item = optional(payload.turn_id) !== undefined && integer(payload.segment) !== undefined ? payload.turn_id + ":" + payload.segment : run.segment ?? run.admission + ":" + run.segments++;
        if (run.segment !== item) { run.segment = item; run.thinking = null; }
        this.emit(run, { type: "text", text: payload.text, item });
        return;
      }
      case "message.interim": {
        // Commentary beside tool calls, sealed as its own segment; streamed commentary is already shown.
        const said = optional(payload.text);
        if (payload.already_streamed !== true && said !== undefined && said.trim()) this.emit(run, { type: "text", text: said, item: "interim:" + (optional(payload.turn_id) ?? run.admission) + ":" + (integer(payload.segment) ?? run.segments++) });
        run.segment = null;
        return;
      }
      case "reasoning.delta": case "reasoning.available": {
        const said = optional(payload.text);
        if (said === undefined) return;
        if (run.thinking === null) run.thinking = "reasoning:" + run.admission + ":" + run.thoughts++;
        this.emit(run, { type: "thinking", text: said, item: run.thinking });
        return;
      }
      case "tool.start": case "tool.complete": {
        run.segment = null; run.thinking = null;
        if (optional(payload.name) === "todo" || optional(payload.name) === "todo_list") { if (type === "tool.complete") { const plan = planEvent(payload.todos); if (plan !== null) this.emit(run, plan); } return; }
        const id = optional(payload.tool_id) ?? optional(payload.tool_call_id) ?? "", event = toolEvent(type, payload, run.tools.get(id));
        if (event === null) return;
        if (event.detail !== undefined) run.tools.set(id, event.detail);
        this.emit(run, event);
        return;
      }
      case "tool.progress": {
        const id = optional(payload.tool_id), prior = id === undefined ? undefined : run.tools.get(id), said = optional(payload.message);
        if (id === undefined || prior === undefined || said === undefined) return;
        const detail = { ...prior, output: said };
        run.tools.set(id, detail);
        this.emit(run, { type: "tool", id: id.slice(0, 256), title: prior.name ?? "工具", status: "in_progress", detail });
        return;
      }
      case "todo.updated": { const plan = planEvent(payload.todos); if (plan !== null) this.emit(run, plan); return; }
      case "approval.request": this.approval(run, payload); return;
      case "clarify.request": this.clarify(run, payload); return;
      case "approval.settled": case "clarify.settled": case "approval.cancelled": {
        const key = optional(payload.prompt_id);
        for (const [id, entry] of this.pending) if (key === undefined || entry.promptId === key) { this.pending.delete(id); this.emit(run, { type: "permission", id, decision: "cancelled" }); }
        return;
      }
      case "session.usage": {
        run.context = contextOf(payload);
        if (run.context !== undefined) this.emit(run, { type: "usage", usage: { context: run.context } });
        return;
      }
      case "status.update": {
        if (payload.kind === "compacting") this.emit(run, { type: "activity", id: "compaction:" + run.admission, kind: "compaction", title: "上下文压缩", status: "running" });
        return;
      }
      case "subagent.start": case "subagent.complete": {
        const id = optional(payload.subagent_id) ?? optional(payload.id) ?? "subagent";
        this.emit(run, { type: "activity", id: "subagent:" + id.slice(0, 200), kind: "subagent", title: "子 Agent · " + line(optional(payload.goal) ?? optional(payload.name) ?? id, 120), status: type === "subagent.start" ? "running" : payload.status === "failed" ? "failed" : "completed" });
        return;
      }
      case "notice": { const said = optional(payload.text) ?? optional(payload.message); if (said) this.emit(run, { type: "notice", severity: "info", title: line(said, 1024) }); return; }
      case "error": { const said = optional(payload.message) ?? optional(payload.text); if (said) this.emit(run, { type: "notice", severity: "error", title: line(said, 1024) }); return; }
      case "message.complete": this.complete(run, payload); return;
      default: return;
    }
  }
  /** `session.info` carries the session's policy and its pending admissions: a live Run's admission the gateway now says is unknown settles as unknown. */
  private sessionInfo(payload: Row): void {
    const { pending: _pending, ...info } = payload;
    this.info = { ...this.info, ...info };
    const run = this.live();
    if (run === null || run.admission === null || !Array.isArray(payload.pending)) return;
    const own = payload.pending.map(value => record(value)).find(row => row?.admission_id === run.admission);
    if (own?.status === "unknown") this.unknown(run, run.admission);
  }
  /** Part of the stream was lost: the session is attached again from a snapshot, and a Run whose admission is no longer pending is settled by its receipt. */
  private async replayGap(): Promise<void> {
    const run = this.live();
    try {
      const snapshot = await this.snapshot();
      if (run === null || run.admission === null) return;
      this.safeEmit(run, { type: "diagnostic", message: "和 Hermes 网关之间丢了一段实时输出，这一轮的结果以 Hermes 的记录为准。" });
      const own = (Array.isArray(snapshot.pending) ? snapshot.pending : []).map(value => record(value)).find(row => row?.admission_id === run.admission);
      if (own === undefined) await this.settleFromReceipt(run); else if (own?.status === "unknown") this.unknown(run, run.admission);
    } catch (error) { if (run !== null) this.failRun(run, errorFrom(error)); }
  }
  private recorded(run: Run, persisted: Row | null): void {
    if (run.recorded || persisted === null || integer(persisted.user_row_id) === undefined) return;
    run.recorded = true;
    this.emit(run, { type: "input_recorded", ...(run.packetId === null ? {} : { packetId: run.packetId }) });
  }
  /** The turn ended (`message.complete`): its committed rows, its outcome, and the usage its receipt reports. */
  private complete(run: Run, payload: Row): void {
    if (run.settling) return;
    run.settling = true;
    this.recorded(run, record(payload.persisted_turn));
    const outcome = optional(payload.outcome) ?? (payload.status === "complete" ? "completed" : payload.status === "interrupted" ? "cancelled" : payload.status === "error" ? "failed" : undefined);
    const input = run.recorded ? { input: "recorded" as const } : {};
    const result: BackendResult = outcome === "completed" ? { status: "completed", reason: "completed", ...input }
      : outcome === "cancelled" || outcome === "interrupted" ? { status: "cancelled", reason: "interrupted", ...input }
      : outcome === "unknown" ? { status: "failed", reason: "unknown_outcome", error: { code: "NATIVE_OUTCOME_UNKNOWN", message: "Hermes 说这一轮的结果未知" } }
      : { status: "failed", reason: "failed", error: turnFailure(payload), ...input };
    if (outcome === "unknown") this.emit(run, { type: "diagnostic", message: "Hermes 说这一轮的结果未知：它可能已经执行，不要重发。要继续这个会话，先在 Hermes 里放弃它（/discard，或 hermes sessions discard " + this.conversation + "）。" });
    void this.usage(run).then(() => this.finish(run, result));
  }
  /** The Turn's usage from its receipt (`prompt.receipt include_result`), at most RECEIPT_MS after it ended; none when it does not answer. */
  private async usage(run: Run): Promise<void> {
    if (run.admission === null || this.conversation === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = this.request("prompt.receipt", { session_id: this.conversation, admission_id: run.admission, include_result: true }, RECEIPT_MS).then(value => record(value), () => null);
    const receipt = await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), RECEIPT_MS); })]);
    clearTimeout(timer);
    if (receipt === null || run.settled) return;
    const result = record(receipt.result), now = totalsOf(result);
    this.recorded(run, record(result?.persisted_turn));
    const usage = turnUsage(record(receipt.usage), now, this.totals, run.context);
    if (now !== null) this.totals = now;
    if (usage !== null) this.safeEmit(run, { type: "usage", usage });
  }
  /** A Run whose end came by its receipt (a cancel that retired it while queued, a gap that swallowed its end). */
  private async settleFromReceipt(run: Run): Promise<void> {
    if (run.settled || run.settling || run.admission === null || this.conversation === null) return;
    const receipt = record(await this.request("prompt.receipt", { session_id: this.conversation, admission_id: run.admission, include_result: true }).catch(() => null));
    if (run.settled || run.settling) return;
    if (receipt === null) { this.finish(run, { status: "failed", reason: "unknown_outcome", error: { code: "NATIVE_OUTCOME_UNKNOWN", message: "读不到 Hermes 对这一轮的记录，结果未知" } }); return; }
    if (receipt.status !== "terminal") { if (receipt.status === "unknown") this.unknown(run, run.admission); return; }
    run.settling = true;
    const result = record(receipt.result);
    this.recorded(run, record(result?.persisted_turn));
    const said = optional(result?.final_response);
    if (said !== undefined && receipt.outcome === "completed") this.emit(run, { type: "text", text: said, item: "final:" + run.admission });
    const usage = turnUsage(record(receipt.usage), totalsOf(result), this.totals, run.context);
    if (totalsOf(result) !== null) this.totals = totalsOf(result);
    if (usage !== null) this.safeEmit(run, { type: "usage", usage });
    const input = run.recorded ? { input: "recorded" as const } : {};
    // A queued admission retired before it started never reached the session.
    const neverStarted = receipt.outcome === "cancelled" && run.generation === null && !run.recorded;
    this.finish(run, receipt.outcome === "completed" ? { status: "completed", reason: "completed", ...input }
      : receipt.outcome === "cancelled" || receipt.outcome === "interrupted" ? { status: "cancelled", reason: "interrupted", ...(neverStarted ? NOT_RECORDED : input) }
      : { status: "failed", reason: "failed", error: { code: "MODEL_REQUEST_FAILED", message: "Hermes 的这一轮失败了" }, ...input });
  }
  private unknown(run: Run, admission: string): void {
    if (run.settled) return;
    this.safeEmit(run, { type: "diagnostic", message: "Hermes 说这条消息的执行结果未知：它可能已经执行，不要重发。要继续这个会话，先在 Hermes 里放弃它（/discard " + admission + "，或 hermes sessions discard " + this.conversation + "）。" });
    this.finish(run, { status: "failed", reason: "unknown_outcome", error: { code: "NATIVE_OUTCOME_UNKNOWN", message: "Hermes 说这条消息的执行结果未知" } });
  }

  // ---- approvals and questions ----------------------------------------------------------------------------------------------

  enablePermissions(): void { this.interactivePermissions = true; }
  private approval(run: Run, payload: Row): void {
    const promptId = optional(payload.prompt_id), generation = integer(payload.execution_generation);
    if (promptId === undefined || generation === undefined) return;
    const asked = approvalPrompt(payload), id = "approval:" + promptId;
    if (!this.interactivePermissions || run.stopping) {
      this.emit(run, { type: "permission", id, decision: run.stopping ? "cancelled" : "denied" });
      void this.connection?.request("approval.respond", { session_id: this.conversation!, prompt_id: promptId, execution_generation: generation, choice: "deny" }).catch(() => {});
      return;
    }
    this.pending.set(id, { run, kind: "approval", promptId, generation, options: asked.options.map(option => option.id), choices: [] });
    this.emit(run, { type: "permission_requested", id, title: asked.title, ...(asked.detail ? { detail: asked.detail } : {}), options: asked.options, toolKind: asked.toolKind, kind: "approval", ...requestExpiry(asked.waitMs) });
  }
  private clarify(run: Run, payload: Row): void {
    const promptId = optional(payload.prompt_id), generation = integer(payload.execution_generation);
    if (promptId === undefined || generation === undefined) return;
    const asked = clarifyPrompt(payload), id = "clarify:" + promptId;
    const choices = Array.isArray(payload.choices) ? payload.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "").slice(0, 32) : [];
    if (!this.interactivePermissions || run.stopping) {
      this.emit(run, { type: "permission", id, decision: run.stopping ? "cancelled" : "denied" });
      void this.connection?.request("clarify.respond", { session_id: this.conversation!, prompt_id: promptId, execution_generation: generation, answer: "" }).catch(() => {});
      return;
    }
    this.pending.set(id, { run, kind: "clarify", promptId, generation, options: asked.options.map(option => option.id), choices });
    this.emit(run, { type: "permission_requested", id, title: asked.title, options: asked.options, input: { kind: "text", value: "" }, kind: "question", ...requestExpiry(waitOf(payload)) });
  }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending === undefined || !pending.options.includes(option) || this.conversation === null) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable");
    this.pending.delete(id);
    if (pending.kind === "approval") {
      const choice = choiceOf(option);
      if (choice === undefined) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable");
      await this.request("approval.respond", { session_id: this.conversation, prompt_id: pending.promptId, execution_generation: pending.generation, choice });
      return;
    }
    const answer = option === "skip" ? "" : option === "answer" ? (input ?? "").slice(0, 16_384) : pending.choices[Number(option.slice("choice:".length))] ?? "";
    await this.request("clarify.respond", { session_id: this.conversation, prompt_id: pending.promptId, execution_generation: pending.generation, answer });
  }
  /** A stopping Run's prompts are left to Hermes (its interrupt cancels them); they close here. */
  private cancelPrompts(run?: Run): void {
    for (const [id, entry] of this.pending) if (run === undefined || entry.run === run) { this.pending.delete(id); if (!entry.run.settled) this.safeEmit(entry.run, { type: "permission", id, decision: "cancelled" }); }
  }

  // ---- settling -------------------------------------------------------------------------------------------------------------

  private finish(run: Run, result: BackendResult): void {
    if (run.settled) return;
    this.cancelPrompts(run);
    clearTimeout(run.timer); run.settled = true; run.signalStarted();
    if (this.active === run) this.active = null;
    run.resolve(result);
  }
  private failRun(run: Run, error: Error): void {
    if (run.settled) return;
    this.cancelPrompts(run);
    clearTimeout(run.timer); run.settled = true; run.signalStarted();
    if (this.active === run) this.active = null;
    run.reject(error);
  }
  /** Leaves the session to the gateway (a detach, never an end: a turn still running goes on there) and closes the socket. */
  async close(): Promise<CleanupEvidence> {
    this.cancelPrompts();
    const run = this.live();
    if (run !== null) this.failRun(run, new ControlError("CONNECTION_CLOSED", "the connection closed while the turn ran; it goes on in Hermes"));
    const connection = this.connection;
    if (connection !== null && connection.failure === null && this.conversation !== null && this.subscription !== null)
      await connection.request("session.detach", { session_id: this.conversation, subscription_id: this.subscription }, 2000).catch(() => {});
    await connection?.close();
    const failure = this.failure instanceof ControlError && this.failure.code !== "NATIVE_DISCONNECTED" ? { code: this.failure.code, message: this.failure.message } : null;
    return { closed: true, exitCode: null, signal: null, protocolFailure: failure };
  }
}
