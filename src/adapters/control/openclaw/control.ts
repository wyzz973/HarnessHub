import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { nativeConversationId, requestExpiry, singleText, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun,
  type HarnessControl, type NativeCommand, type NativeConversationId, type NativeExtensions, type NativeModelCatalog, type NativeOption, type NativeOptions, type NativeSessionImport, type NativeSessionPage,
  type ProtocolObservation, type SteerOutcome, type StopRequestReceipt, type TurnText } from "../../../contracts/control.js";
import type { ContentKind, ContentRef, ControlAttachment } from "../../../contracts/content.js";
import type { RelayCapabilities, RelayPacketId } from "../../../contracts/relay.js";
import { levelOptions } from "../../../contracts/flavor.js";
import { ControlError, object } from "../../../infrastructure/control/json-rpc-process.js";
import { checkInputs } from "../../../infrastructure/control/attachments.js";
import { hubClearReading, openClawClassify, openClawCommandEffect, openClawNativeClassify, relayDeclaration, relayEntries } from "../relay-classify.js";
import { clearedNotice, COMMAND_REFUSED, exceedsInput, hubCleared, INPUT_LIMIT_REFUSED, measureBy, TITLE_DEADLINE_MS } from "../relay-turn.js";
import { openclawFlavor } from "../../flavors/openclaw.js";
import { connectGateway, type GatewayConnector, type GatewayHello, type GatewayLink } from "./link.js";
import { guard, HUB_KEY, type GatewayMethod } from "./methods.js";
import { execApproval, planOf, pluginApproval, questionsOf, record, rowId, runFailure, text, toolUpdate, turnStarts, usageOf, type Approval, type Question, type Row, type ToolState } from "./mapping.js";

/**
 * OpenClaw's relay declaration (ADR-055 §8.1): one text, at most 2,097,152 bytes; the Gateway says when it committed the user's turn (the
 * `messageSeq` of chat.send, else the run starting), and a completed turn proves nothing by itself; the Hub's clear, OpenClaw's own commands by
 * their arguments; the Gateway runs the session; a native title by `sessions.patch label`.
 */
export const openClawRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "recorded_event", successProvesRecorded: false },
  execution: "gateway",
  commands: { classify: openClawClassify },
  placement: { parts: "single", maxInput: { unit: "bytes", limit: 2_097_152 }, measure: measureBy("single", "bytes", []) },
  title: "set",
});

/** What a protocol feature needs of the Gateway: one it does not serve is turned off, and said once. */
const FEATURES = {
  questions: ["question.resolve"], approvals: ["exec.approval.resolve", "plugin.approval.resolve"], compact: ["sessions.compact"], rollback: ["sessions.rewind"],
  commands: ["commands.list"], extensions: ["skills.status", "tools.catalog"], subscribe: ["sessions.messages.subscribe", "sessions.messages.unsubscribe"], backfill: ["question.list"],
} as const satisfies Record<string, readonly GatewayMethod[]>;
type Feature = keyof typeof FEATURES;
const CORE: readonly GatewayMethod[] = ["chat.send", "chat.abort", "chat.history", "sessions.create", "sessions.patch", "sessions.describe", "agents.list", "models.list"];
/** What only operator.admin may do (docs/gateway/protocol/operator-methods.md): without it these are off. */
const ADMIN: readonly Feature[] = ["compact", "rollback"];
const FEATURE_NAMES: Readonly<Record<Feature, string>> = { questions: "提问", approvals: "审批", compact: "压缩", rollback: "回退", commands: "命令列表", extensions: "技能与插件列表", subscribe: "会话订阅", backfill: "断线后补回提问" };
const SELECTION_REQUIRED = "OpenClaw 没有默认代理（配置了多个代理却没有指定归属），要求显式选择代理；HarnessHub 不替你选。请在 OpenClaw 中设置默认代理。";
/** The Hub's sessions in the user's Gateway: their own category, and no messages to or from other sessions. */
const SESSION_DEFAULTS = { category: "HarnessHub", communication: { send: "never", receive: "never" } } as const;
const STREAM_MS = 300;
const HISTORY_PAGE = 500, HISTORY_ROWS = 100_000;
/** How long a Turn's usage is waited for after it ended (its transcript read). */
const USAGE_READ_MS = 5000;
const NOT_RECORDED = { input: "not_recorded" } as const;

function instructionsBlock(text: string): string {
  return "<harnesshub-session-instructions>\n（以下是 HarnessHub 给这个会话的说明，不是用户的话。）\n" + text + "\n</harnesshub-session-instructions>";
}
const optional = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;
const modelOf = (row: Row | null): string | null => row !== null && typeof row.modelProvider === "string" && typeof row.model === "string" && row.modelProvider && row.model ? row.modelProvider + "/" + row.model : null;

interface Tool extends ToolState { timer: ReturnType<typeof setTimeout> | null; output: string }
/** One Hub Turn: the run chat.send began and every run of words given to it while it ran (steers); it ends once all of them ended. */
interface Run {
  readonly onEvent: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly started: Promise<void>;
  readonly signalStarted: () => void;
  primary: string | null;
  readonly owned: Set<string>;
  readonly ended: Map<string, Row>;
  readonly tools: Map<string, Tool>;
  readonly titles: Map<string, string>;
  /** Text said so far, by item. */
  readonly said: Map<string, string>;
  inputRecorded: boolean;
  readonly packetId: RelayPacketId | null;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  settling: boolean;
  settled: boolean;
  /** Steers sent and not answered yet: the Turn does not end before their run is known. */
  steering: number;
}
const WITHDRAWN = Symbol("withdrawn"), STOPPED = Symbol("stopped");
type Answer = { readonly option: string; readonly input?: string } | typeof WITHDRAWN | typeof STOPPED;
interface Pending { readonly native: string; readonly run: Run; readonly options: readonly string[]; readonly validate?: (option: string, input?: string) => void; readonly resolve: (answer: Answer) => void }

/**
 * OpenClaw through its Gateway WebSocket (docs/gateway/external-apps.md: the official way in for other programs), one connection per Hub
 * conversation, as HarnessHub's own paired device. The session is the Gateway's: made with the conversation's folder as its root, its model,
 * thinking and permission mode in one `sessions.create`, kept under the Hub's own key `agent:<agent>:harnesshub:<uuid>`. Nothing here sends to
 * a channel: only the methods of methods.ts are called, and only on the Hub's own keys.
 */
export class OpenClawControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = openClawRelayCapabilities;
  private link: GatewayLink | null = null;
  private hello: GatewayHello | null = null;
  private initializing: Promise<ProtocolObservation> | null = null;
  private off = new Set<Feature>();
  private readonly notes: string[] = [];
  private failure: Error | null = null;
  private key: string | null = null;
  private opening = false;
  private model: string | undefined;
  private permissionMode: string | undefined;
  private instructions: string | null = null;
  private instructionsDue = false;
  private interactive = false;
  private active: Run | null = null;
  private readonly known = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private counted = 0;
  private catalog: Promise<{ readonly models: readonly Row[]; readonly agent: Row | null; readonly defaultId: string | null; readonly selectionRequired: boolean }> | null = null;
  private commandList: readonly NativeCommand[] | null = null;
  private closed = false;
  private unavailableSaid = false;

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions, private readonly connector: GatewayConnector = connectGateway) {
    if (launch.protocol !== "openclaw-gateway") throw new ControlError("INVALID_INPUT", "OpenClaw control requires its Gateway protocol");
  }
  get unattributedUpdates(): number { return this.counted; }
  get steering(): boolean { return this.link !== null; }
  healthy(): boolean { return this.link !== null && this.failure === null && !this.closed && this.link.connected(); }
  processGroup(): number | null { return null; }
  private has(feature: Feature): boolean { return !this.off.has(feature); }

  // ---- connection ----------------------------------------------------------------------------------------------------------

  initialize(): Promise<ProtocolObservation> {
    if (this.failure) return Promise.reject(this.failure);
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    const link = await this.connector({
      event: (name, payload) => this.event(name, payload),
      reconnected: hello => { this.hello = hello; void this.recover(); },
      disconnected: () => {},
      lost: error => { this.failure = error; const run = this.live(); if (run) this.finish(run, { status: "failed", reason: "connection_lost", error: { code: "NATIVE_CONNECTION_FAILED", message: "和 OpenClaw Gateway 的连接断了，这一轮的结果不确定。" } }); },
    }, this.options.env, this.options.startupTimeoutMs ?? this.options.requestTimeoutMs);
    this.link = link; this.hello = link.hello;
    // The protocol check of each start: v4 exactly, and the methods this driver uses; what this Gateway lacks is turned off and said once.
    if (link.hello.protocol !== PROTOCOL_VERSION) { await link.close(); throw new ControlError("NATIVE_PROTOCOL_UNSUPPORTED", "OpenClaw Gateway speaks protocol " + link.hello.protocol + ", HarnessHub speaks " + PROTOCOL_VERSION); }
    const methods = link.hello.methods;
    if (methods !== null) {
      const missing = CORE.filter(method => !methods.has(method));
      if (missing.length) { await link.close(); throw new ControlError("NATIVE_PROTOCOL_UNSUPPORTED", "this OpenClaw Gateway lacks " + missing.join(", ")); }
      for (const [feature, needs] of Object.entries(FEATURES) as [Feature, readonly string[]][]) if (needs.some(method => !methods.has(method))) this.off.add(feature);
    }
    if (!link.hello.scopes.includes("operator.admin")) for (const feature of ADMIN) this.off.add(feature);
    if (this.off.size) this.notes.push("这个 OpenClaw Gateway（" + (link.hello.serverVersion ?? "版本未知") + "）缺少 HarnessHub 用到的协议内容，相关功能已关闭：" + [...this.off].map(feature => FEATURE_NAMES[feature]).join("、"));
    return { protocol: "openclaw-gateway", protocolVersion: link.hello.protocol, agentName: "openclaw", agentVersion: link.hello.serverVersion, authenticationMethods: [],
      capabilities: { scopes: link.hello.scopes, ...(this.off.size ? { featuresOff: [...this.off] } : {}) } };
  }
  /** One call: only a method methods.ts allows, only on the Hub's keys (guard throws before anything is sent). */
  private async call(method: string, params: Readonly<Record<string, unknown>>, timeoutMs = this.options.requestTimeoutMs): Promise<Row> {
    guard(method, params);
    if (this.failure) throw this.failure;
    if (this.link === null) throw new ControlError("INVALID_STATE", "connection is not initialized");
    const value = await this.link.request(method, params, timeoutMs);
    return value === undefined || value === null ? {} : object(value, "OpenClaw " + method + " result");
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (this.link === null) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private assertOwned(id: NativeConversationId): string {
    this.assertInitialized();
    if (this.key === null || id !== this.key || this.opening) throw new ControlError("IDENTITY_MISMATCH", "session is not owned by this connection");
    return this.key;
  }
  /** After a reconnect: the session is followed again, and a Turn whose end was missed is settled from the transcript. */
  private async recover(): Promise<void> {
    const key = this.key;
    if (key === null) return;
    try {
      if (this.has("subscribe")) await this.call("sessions.messages.subscribe", { key, subscriptionId: "harnesshub", includeApprovals: true });
      const run = this.live();
      if (run === null || run.primary === null) return;
      const history = await this.call("chat.history", { sessionKey: key, limit: 50 });
      const info = record(history.sessionInfo), active = Array.isArray(info?.activeRunIds) ? info.activeRunIds : null;
      if (active !== null && [...run.owned].some(id => active.includes(id))) return;
      if (this.live() !== run) return;
      const rows = (Array.isArray(history.messages) ? history.messages : []).map(record).filter((row): row is Row => row !== null);
      const last = rows.filter(row => row.role === "assistant" && run.owned.has(text(record(row.__openclaw)?.runId) ?? "")).at(-1);
      this.diagnostic(run, "和 OpenClaw Gateway 的连接断开后又接上了，这一轮的结尾按会话记录补齐。");
      for (const id of run.owned) if (!run.ended.has(id)) run.ended.set(id, last === undefined ? { state: "error", errorMessage: "" } : { state: last.stopReason === "error" ? "error" : "final", message: last });
      this.maybeSettle(run);
    } catch { /* the next event or the Turn's own stop settles it */ }
  }

  // ---- catalog -------------------------------------------------------------------------------------------------------------

  private readCatalog(): NonNullable<typeof this.catalog> {
    this.catalog ??= (async () => {
      const [models, agents] = await Promise.all([this.call("models.list", {}), this.call("agents.list", {})]);
      if (!Array.isArray(models.models) || !Array.isArray(agents.agents)) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw catalog");
      const defaultId = optional(agents.defaultId) ?? null;
      const agent = agents.agents.map(record).find(row => row !== null && row.id === defaultId) ?? null;
      return { models: models.models.map(record).filter((row): row is Row => row !== null && typeof row.id === "string" && typeof row.provider === "string"), agent, defaultId, selectionRequired: agents.selectionRequired === true };
    })();
    this.catalog.catch(() => { this.catalog = null; });
    return this.catalog;
  }
  private thinkingOption(row: Row | null, current?: string): NativeOption | undefined {
    const levels = Array.isArray(row?.thinkingLevels) ? row.thinkingLevels.map(record).filter((level): level is Row => typeof level?.id === "string") : [];
    if (levels.length === 0) return undefined;
    const fallback = optional(row?.thinkingDefault) ?? String(levels[0]!.id);
    return { id: "thought_level", name: "思考强度", category: "thought_level", currentValue: current !== undefined && levels.some(level => level.id === current) ? current : fallback,
      values: levels.map(level => ({ value: String(level.id), name: typeof level.label === "string" ? level.label : String(level.id) })) };
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const catalog = await this.readCatalog();
    const available = catalog.models.filter(row => row.available !== false), unavailable = catalog.models.filter(row => row.available === false);
    if (unavailable.length && !this.unavailableSaid) this.unavailableSaid = true, this.notes.push("OpenClaw 报告 " + unavailable.length + " 个模型暂不可用，没有列出：" + unavailable.map(row => row.provider + "/" + row.id + (typeof row.unavailableReason === "string" ? "（" + row.unavailableReason + "）" : "")).join("、").slice(0, 2048));
    const models = available.map(row => {
      // A model that names no input kinds is not refused an image: the Gateway decides (it can hand images to another model).
      const input = Array.isArray(row.input) ? row.input : ["text", "image"], option = this.thinkingOption(row);
      return { id: row.provider + "/" + row.id, name: typeof row.name === "string" ? row.name : String(row.id), inputs: { image: input.includes("image"), audio: input.includes("audio"), file: true }, ...(option ? { options: [option] } : {}) };
    });
    const agentOption = this.thinkingOption(catalog.agent), primary = optional(record(catalog.agent?.model)?.primary) ?? null;
    return { models, defaultModel: primary, canSelect: models.length > 0, authentication: models.length > 0 ? "ready" : catalog.models.some(row => row.unavailableReason === "missing-auth") ? "missing" : "unknown",
      ...(agentOption ? { options: [agentOption] } : {}), commands: await this.commands(catalog.defaultId), flavor: openclawFlavor };
  }
  /** OpenClaw's commands (commands.list) with what each does to the session (relay-classify.ts OPENCLAW_COMMAND_EFFECTS). */
  private async commands(agentId: string | null): Promise<readonly NativeCommand[]> {
    if (this.commandList !== null) return this.commandList;
    if (!this.has("commands") || agentId === null) return [];
    try {
      const listed = await this.call("commands.list", { agentId, includeArgs: false });
      this.commandList = (Array.isArray(listed.commands) ? listed.commands : []).map(record).flatMap(row => typeof row?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/u.test(row.name)
        ? [{ name: row.name, description: typeof row.description === "string" ? row.description.slice(0, 1024) : "", contextEffect: openClawCommandEffect(row.name) ?? "unknown" as const }] : []);
    } catch { this.commandList = []; }
    return this.commandList;
  }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return openClawNativeClassify(text, catalog, attachments); }
  async checkpoint(): Promise<string | null> { return this.key === null ? null : JSON.stringify({ key: this.key }); }

  // ---- sessions ------------------------------------------------------------------------------------------------------------

  /** The Hub's level as the session's permission mode (flavors/openclaw.ts); undefined without a level, when the Gateway's own setting stands. */
  private levelMode(): string | undefined {
    const level = this.options.permission, mode = level === undefined ? undefined : (this.options.flavor ?? openclawFlavor).permission[level].session?.params?.permissionMode;
    return typeof mode === "string" ? mode : undefined;
  }
  /** The thinking value the selection and the Hub's effort come to on this model's levels. */
  private thinking(row: Row | null, native: NativeOptions | undefined, restored: boolean): string | undefined {
    const option = this.thinkingOption(row);
    const levels = { ...(this.options.effort === undefined ? {} : { effort: this.options.effort }) };
    const resolved = levelOptions(this.options.flavor ?? openclawFlavor, option ? [option] : [], native, levels, restored);
    const value = resolved?.thought_level;
    if (value !== undefined && option !== undefined && !option.values.some(entry => entry.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "thinking level unavailable for the selected OpenClaw model");
    return value;
  }
  setSessionInstructions(text: string | null): void { this.instructions = text; }
  private parseCheckpoint(checkpoint: string): string {
    let parsed: unknown; try { parsed = JSON.parse(checkpoint); } catch { throw new ControlError("INVALID_CHECKPOINT", "invalid native recovery reference"); }
    const key = record(parsed)?.key;
    if (typeof key !== "string" || !HUB_KEY.test(key)) throw new ControlError("INVALID_CHECKPOINT", "native key is not a Hub-owned conversation");
    return key;
  }
  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.key !== null || this.opening) throw new ControlError("INVALID_STATE", "this connection already owns a session");
    this.opening = true;
    try {
      const catalog = await this.readCatalog(), mode = this.levelMode();
      const chosen = model === undefined ? null : catalog.models.find(row => row.provider + "/" + row.id === model) ?? null;
      if (model !== undefined && chosen === null) throw new ControlError("MODEL_UNAVAILABLE", "model unavailable in original OpenClaw catalog");
      if (chosen !== null && chosen.available === false) throw new ControlError("MODEL_UNAVAILABLE", "OpenClaw reports this model unavailable: " + String(chosen.unavailableReason ?? "unavailable"));
      if (checkpoint !== undefined) {
        const key = this.parseCheckpoint(checkpoint);
        let row: Row | null;
        try { row = record((await this.call("sessions.describe", { key })).session); }
        catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR") throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the OpenClaw session is gone"); throw error; }
        if (row === null) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the OpenClaw session is gone");
        const running = modelOf(row), thinking = this.thinking(chosen ?? catalog.models.find(entry => entry.provider + "/" + entry.id === running) ?? catalog.agent, native, true);
        const patch: Record<string, unknown> = { ...(model !== undefined && model !== running ? { model } : {}), ...(thinking !== undefined && thinking !== row.thinkingLevel ? { thinkingLevel: thinking } : {}),
          ...(mode !== undefined && mode !== row.permissionMode ? { permissionMode: mode } : {}) };
        if (Object.keys(patch).length) {
          const patched = await this.call("sessions.patch", { key, ...patch });
          if (model !== undefined && modelOf(record(patched.resolved)) !== null && modelOf(record(patched.resolved)) !== model) throw new ControlError("MODEL_MISMATCH", "OpenClaw did not apply the selected session model");
        }
        if (typeof row.sessionRoot === "string" && row.sessionRoot !== cwd) this.notes.push("这个 OpenClaw 会话的根目录是它创建时的文件夹，不是这次所选的文件夹。");
        this.key = key; this.model = model ?? running ?? undefined; this.permissionMode = mode ?? optional(row.permissionMode); this.instructionsDue = false;
      } else {
        if (catalog.selectionRequired || catalog.defaultId === null) throw new ControlError("NATIVE_CONFIGURATION_INVALID", SELECTION_REQUIRED);
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(catalog.defaultId)) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native default agent");
        const key = "agent:" + catalog.defaultId + ":harnesshub:" + randomUUID(), thinking = this.thinking(chosen ?? catalog.models.find(entry => entry.provider + "/" + entry.id === optional(record(catalog.agent?.model)?.primary)) ?? catalog.agent, native, false);
        const created = await this.call("sessions.create", { key, agentId: catalog.defaultId, cwd, ...SESSION_DEFAULTS, ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
          ...(mode === undefined ? {} : { permissionMode: mode }) }, this.options.startupTimeoutMs ?? this.options.requestTimeoutMs);
        if (created.ok !== true || created.key !== key) throw new ControlError("IDENTITY_MISMATCH", "OpenClaw created another session than the one asked for");
        if (model !== undefined && modelOf(record(created.resolved)) !== null && modelOf(record(created.resolved)) !== model) throw new ControlError("MODEL_MISMATCH", "OpenClaw did not apply the selected session model");
        const entry = record(created.entry);
        if (mode !== undefined && entry?.permissionMode !== undefined && entry.permissionMode !== mode) throw new ControlError("NATIVE_OPTION_MISMATCH", "OpenClaw did not apply the permission mode");
        if (entry?.sessionRoot !== undefined && entry.sessionRoot !== cwd) throw new ControlError("NATIVE_OPTION_MISMATCH", "OpenClaw did not root the session in the selected folder");
        this.key = key; this.model = model ?? modelOf(record(created.resolved)) ?? undefined; this.permissionMode = mode;
        this.instructionsDue = this.instructions !== null && this.options.entry?.instructions === "first-prompt";
      }
      if (this.has("subscribe")) await this.call("sessions.messages.subscribe", { key: this.key, subscriptionId: "harnesshub", includeApprovals: true }).catch(() => {});
      return nativeConversationId(this.key);
    } finally { this.opening = false; }
  }
  /** A copy of the whole session behind `checkpoint` (sessions.create `fork`, up to its last completed turn), in the Hub's own namespace; the source is left as it was. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    const source = this.parseCheckpoint(checkpoint), agent = source.split(":")[1]!, key = "agent:" + agent + ":harnesshub:" + randomUUID(), mode = this.levelMode();
    try {
      const created = await this.call("sessions.create", { key, agentId: agent, parentSessionKey: source, fork: true, forkFrom: "last-completed", cwd, ...SESSION_DEFAULTS, ...(mode === undefined ? {} : { permissionMode: mode }) },
        this.options.startupTimeoutMs ?? this.options.requestTimeoutMs);
      if (created.ok !== true || created.key !== key) throw new ControlError("IDENTITY_MISMATCH", "OpenClaw forked into another session");
    } catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR") throw new ControlError("NATIVE_FORK_UNAVAILABLE", "OpenClaw refused to fork the session"); throw error; }
    return JSON.stringify({ key });
  }
  /** Takes the last `turns` turns out of the session's history (sessions.rewind to the user entry that began the first of them); files are not reverted. */
  async rollback(id: NativeConversationId, turns: number): Promise<void> {
    const key = this.assertOwned(id);
    if (!Number.isSafeInteger(turns) || turns < 1) throw new ControlError("INVALID_INPUT", "turns must be a positive integer");
    if (!this.has("rollback")) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "this OpenClaw Gateway cannot rewind a session");
    if (this.live() !== null) throw new ControlError("INVALID_STATE", "a turn is running");
    const starts = turnStarts(await this.transcript(key));
    if (turns > starts.length) throw new ControlError("INVALID_INPUT", "the session has only " + starts.length + " turns");
    const entryId = rowId(starts[starts.length - turns]!);
    if (entryId === null) throw new ControlError("INVALID_PROTOCOL", "the OpenClaw transcript entry has no id");
    // The session settles its last run a moment after the run ended (titles, memory): a rewind it refuses as busy is asked again.
    for (let attempt = 0; ; attempt++) {
      try { await this.call("sessions.rewind", { sessionKey: key, entryId }); return; }
      catch (error) {
        if (!(error instanceof ControlError && error.code === "REMOTE_ERROR")) throw error;
        if (attempt < 40 && (error.remoteFields?.gatewayCode === "UNAVAILABLE" || /working|busy|active|running|in progress/iu.test(error.remoteMessage ?? ""))) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
        throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "OpenClaw refused to rewind the session", undefined, { code: error.remoteCode ?? -32000, ...(error.remoteMessage ? { message: error.remoteMessage } : {}), ...(error.remoteFields ? { fields: error.remoteFields } : {}) });
      }
    }
  }
  /** The whole transcript projection, oldest first (chat.history pages backward). */
  private async transcript(key: string): Promise<Row[]> {
    const pages: Row[][] = [];
    let offset: number | undefined, read = 0;
    for (;;) {
      const page = await this.call("chat.history", { sessionKey: key, limit: HISTORY_PAGE, ...(offset === undefined ? {} : { offset }) });
      const rows = (Array.isArray(page.messages) ? page.messages : []).map(record).filter((row): row is Row => row !== null);
      pages.unshift(rows); read += rows.length;
      if (page.hasMore !== true || typeof page.nextOffset !== "number" || page.nextOffset === offset || read >= HISTORY_ROWS || rows.length === 0) break;
      offset = page.nextOffset;
    }
    return pages.flat();
  }
  /** Names the session as OpenClaw shows it (`label`, which the Gateway keeps unique: a taken one gets the key's tail). */
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    const key = this.assertOwned(id), name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 120).join("").trim();
    if (!name) return;
    for (const label of [name, name + " · " + key.slice(-4)]) {
      try { await this.call("sessions.patch", { key, label }, Math.min(this.options.requestTimeoutMs, TITLE_DEADLINE_MS)); return; }
      catch (error) { if (!(error instanceof ControlError && error.code === "REMOTE_ERROR" && /label already in use/iu.test(error.remoteMessage ?? ""))) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "OpenClaw did not name the session"); }
    }
    throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "OpenClaw did not name the session");
  }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    if (this.key === null) return null;
    const row = record((await this.call("sessions.describe", { key: this.key })).session);
    if (row === null) return null;
    return { model: modelOf(row), options: typeof row.thinkingLevel === "string" && row.thinkingLevel ? { thought_level: row.thinkingLevel } : {} };
  }
  /** OpenClaw's skills (skills.status) and plugin tool groups (tools.catalog); read only. */
  async extensions(): Promise<NativeExtensions> {
    this.assertInitialized();
    if (!this.has("extensions")) return { skills: [], mcpServers: [], plugins: [] };
    const [status, catalog] = await Promise.all([this.call("skills.status", {}), this.call("tools.catalog", { includePlugins: true })]);
    const skills = Array.isArray(status.skills) ? status.skills.map(record).filter((row): row is Row => typeof row?.name === "string") : [];
    const groups = Array.isArray(catalog.groups) ? catalog.groups.map(record).filter((row): row is Row => row !== null && row.source === "plugin") : [];
    return { skills: skills.map(row => ({ name: String(row.name).slice(0, 256), description: typeof row.description === "string" ? row.description.slice(0, 1024) : "", ...(typeof row.source === "string" ? { scope: row.source.slice(0, 64) } : {}),
      enabled: row.eligible === true && row.disabled !== true && row.blockedByAllowlist !== true })), mcpServers: [],
      plugins: groups.map(group => ({ name: typeof group.label === "string" ? group.label.slice(0, 256) : String(group.id ?? "plugin").slice(0, 256), enabled: true, source: (Array.isArray(group.tools) ? group.tools.length : 0) + " 个工具" })) };
  }
  /** OpenClaw's own sessions belong to its channels and agents; only the sessions the Hub made are continued (a product decision). */
  async nativeSessions(): Promise<NativeSessionPage> { throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "OpenClaw sessions are not continued from the Hub"); }
  async importSession(): Promise<NativeSessionImport> { throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "OpenClaw sessions are not continued from the Hub"); }
  /** The running model's input kinds, and the Gateway's own limits per attachment (hello-ok `policy.attachments`). */
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    if (attachments.length === 0) return;
    const catalog = await this.readCatalog(), running = this.model ?? optional(record(catalog.agent?.model)?.primary);
    const row = catalog.models.find(entry => entry.provider + "/" + entry.id === running), input = Array.isArray(row?.input) ? row.input : ["text", "image"];
    const limits = this.hello?.attachments;
    checkInputs(attachments, { image: input.includes("image"), audio: input.includes("audio"), file: true }, limits ? { image: limits.maxImageBytes, audio: limits.maxBytes } : {});
    if (limits) for (const item of attachments) if (item.kind === "file" && item.bytes > limits.maxBytes) throw new ControlError("ATTACHMENT_LIMIT", "附件超过 OpenClaw 的单个附件上限：" + item.name);
  }

  // ---- turns ---------------------------------------------------------------------------------------------------------------

  private live(): Run | null { return this.active !== null && !this.active.settled ? this.active : null; }
  private emit(run: Run, event: ControlEvent): void { if (!run.settled) run.onEvent(event); }
  private diagnostic(run: Run, message: string): void { this.emit(run, { type: "diagnostic", message }); }
  private nothingSent(result: BackendResult): ControlRun {
    return { result: Promise.resolve(result), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent, so there is no native turn to stop")) };
  }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    const key = this.assertOwned(id), prompt = typeof turn === "string" ? turn : turn.user, kinds = attachments.map(file => file.kind);
    if (this.live() !== null) throw new ControlError("INVALID_STATE", "a turn is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    let message = prompt, packetId: RelayPacketId | null = null;
    if (typeof turn !== "string") {
      const reading = openClawClassify(prompt, relayEntries(this.commandList ?? []), kinds);
      if (reading.kind !== "content") return this.nothingSent(COMMAND_REFUSED);
      message = singleText(turn); packetId = turn.relay.packetId;
      if (exceedsInput([message], openClawRelayCapabilities.placement)) { onEvent({ type: "diagnostic", message: "交接单没有发出：超过 OpenClaw 的输入上限" }); return this.nothingSent(INPUT_LIMIT_REFUSED); }
    } else {
      // The Hub's clear: nothing is sent; the session is given up (it stays in OpenClaw) and the next Turn opens a new one.
      const clear = hubClearReading(prompt, kinds);
      if (clear !== null && clear.kind === "command") { this.release(); onEvent(clearedNotice(clear.name, "OpenClaw")); return this.nothingSent(hubCleared()); }
    }
    let resolve!: (result: BackendResult) => void, signalStarted!: () => void;
    const result = new Promise<BackendResult>(res => { resolve = res; }), started = new Promise<void>(res => { signalStarted = res; });
    const run: Run = { onEvent, resolve, started, signalStarted, primary: null, owned: new Set(), ended: new Map(), tools: new Map(), titles: new Map(), said: new Map(),
      inputRecorded: false, packetId, stopping: false, stop: null, settling: false, settled: false, steering: 0 };
    this.active = run;
    for (const note of this.notes.splice(0)) this.diagnostic(run, note);
    if (typeof turn === "string" && prompt.trim() === "/compact" && attachments.length === 0) void this.compactRun(run, key);
    else void this.send(run, key, message, attachments);
    return { result, requestStop: () => {
      if (run.stop) return run.stop;
      if (run.settled) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      run.stopping = true; this.cancelPermissions(run);
      run.stop = (async () => {
        await run.started;
        if (run.settled) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
        await this.call("chat.abort", { sessionKey: key });
        return { requested: true } as const;
      })();
      return run.stop;
    } };
  }
  private release(): void {
    const key = this.key;
    this.key = null; this.model = undefined; this.permissionMode = undefined; this.instructionsDue = false;
    if (key !== null && this.has("subscribe")) void this.call("sessions.messages.unsubscribe", { key, subscriptionId: "harnesshub" }).catch(() => {});
  }
  private async send(run: Run, key: string, words: string, attachments: readonly ControlAttachment[]): Promise<void> {
    const instructing = this.instructionsDue && this.instructions !== null;
    const message = instructing ? words + "\n\n" + instructionsBlock(this.instructions!) : words;
    if (instructing) this.instructionsDue = false;
    let ack: Row;
    try {
      const files = await Promise.all(attachments.map(async file => ({ type: file.kind === "image" ? "image" : file.kind === "audio" ? "audio" : "file", mimeType: file.mediaType, fileName: file.name, content: (await readFile(file.path)).toString("base64") })));
      ack = await this.call("chat.send", { sessionKey: key, message, idempotencyKey: randomUUID(), ...(files.length ? { attachments: files } : {}),
        ...(this.permissionMode === undefined ? {} : { expectedPermissionMode: this.permissionMode }) });
    } catch (error) {
      if (instructing) this.instructionsDue = true;
      // The Gateway validates a chat.send before it keeps anything; one that did not answer may have taken it.
      const refused = error instanceof ControlError && (error.code === "REMOTE_ERROR" || error.code === "METHOD_NOT_ALLOWED") || !(error instanceof ControlError);
      this.finish(run, { status: "failed", reason: refused ? "request_rejected" : "request_unanswered", error: { code: error instanceof ControlError ? error.code : "ATTACHMENT_UNREADABLE",
        message: refused ? "OpenClaw 没有接受这条消息" + (error instanceof ControlError && error.remoteMessage ? "：" + error.remoteMessage.slice(0, 300) : "。") : "OpenClaw 没有回答这条消息是否收到，结果不确定。" }, ...(refused ? NOT_RECORDED : {}) });
      return;
    }
    const runId = optional(ack.runId);
    if (runId === undefined) { this.finish(run, { status: "failed", reason: "invalid_receipt", error: { code: "INVALID_PROTOCOL", message: "OpenClaw 的回执没有 runId。" } }); return; }
    this.claim(run, runId, true);
    if (typeof ack.messageSeq === "number") this.recorded(run);
    run.signalStarted();
    this.maybeSettle(run);
  }
  /** `/compact` alone: sessions.compact (an LLM summary of the session; operator.admin), not a turn. */
  private async compactRun(run: Run, key: string): Promise<void> {
    run.signalStarted();
    if (!this.has("compact")) { this.finish(run, { status: "failed", reason: "compaction_unavailable", error: { code: "NATIVE_COMPACTION_UNAVAILABLE", message: "这个 OpenClaw Gateway 不能压缩会话。" }, ...NOT_RECORDED }); return; }
    this.emit(run, { type: "activity", id: "compaction", kind: "compaction", title: "上下文压缩", status: "running" });
    try {
      const compacted = await this.call("sessions.compact", { key }, Math.max(this.options.requestTimeoutMs, 10 * 60_000)), done = record(compacted.result);
      this.emit(run, { type: "activity", id: "compaction", kind: "compaction", title: "上下文压缩", status: "completed", ...(typeof done?.tokensBefore === "number" ? { detail: "压缩前 " + done.tokensBefore + " tokens" } : {}) });
      this.finish(run, { status: "completed", reason: compacted.compacted === false ? "nothing_to_compact" : "compacted", ...NOT_RECORDED, ...(compacted.compacted === false ? { command: "noop" as const } : {}) });
    } catch (error) {
      this.emit(run, { type: "activity", id: "compaction", kind: "compaction", title: "上下文压缩", status: "failed" });
      this.finish(run, { status: "failed", reason: "compaction_failed", error: { code: error instanceof ControlError ? error.code : "CONTROL_FAILED", message: "OpenClaw 没有完成压缩。" }, ...NOT_RECORDED });
    }
  }
  /**
   * HarnessControl.steer: chat.send `queueMode: "steer"` while the Turn's run runs. OpenClaw puts the words into that run at its next step, or,
   * when the run can no longer take them, runs them right after it as a follow-up of the same session; either way the Turn owns their run and
   * ends once it ended. Words that find no run of the Turn running are not sent.
   */
  async steer(id: NativeConversationId, words: string): Promise<SteerOutcome> {
    const key = this.assertOwned(id);
    if (typeof words !== "string" || words.length === 0) throw new ControlError("INVALID_INPUT", "steering words must contain text");
    const run = this.live();
    if (run === null || run.stopping || run.settling) return "not_taken";
    await run.started;
    if (run.primary === null || run.settled || run.stopping || run.settling || run.ended.has(run.primary)) return "not_taken";
    let ack: Row;
    run.steering++;
    try {
      try { ack = await this.call("chat.send", { sessionKey: key, message: words, queueMode: "steer", idempotencyKey: randomUUID() }); }
      catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR") return "not_taken"; throw error; }
      const runId = optional(ack.runId);
      if (runId === undefined) throw new ControlError("INVALID_PROTOCOL", "OpenClaw's steer receipt has no runId");
      this.claim(run, runId, false);
      return "taken";
    } finally { run.steering--; this.maybeSettle(run); }
  }
  /** A run of the session the Turn owns from now on (its own, or words given to it). */
  private claim(run: Run, runId: string, primary: boolean): void {
    if (primary) run.primary = runId;
    run.owned.add(runId); this.known.add(runId);
  }
  private recorded(run: Run): void {
    if (run.inputRecorded) return;
    run.inputRecorded = true;
    this.emit(run, { type: "input_recorded", ...(run.packetId !== null ? { packetId: run.packetId } : {}) });
  }
  /** The Turn ends once its own run and every run of words given to it ended; its usage is read from the transcript first. */
  private maybeSettle(run: Run): void {
    if (run.settled || run.settling || run.steering > 0 || run.primary === null || [...run.owned].some(id => !run.ended.has(id))) return;
    run.settling = true;
    void (async () => {
      const ended = run.ended.get(run.primary!)!, state = ended.state;
      if (state === "final") {
        const said = [...run.said.values()].join(""), final = text(record(ended.message)?.content) ?? (Array.isArray(record(ended.message)?.content) ? (record(ended.message)!.content as unknown[]).map(record).flatMap(block => block?.type === "text" && typeof block.text === "string" ? [block.text] : []).join("") : "");
        if (!said && final) this.emit(run, { type: "text", text: final, item: "final:" + run.primary });
      }
      for (const [callId, tool] of run.tools) if (tool.timer) { clearTimeout(tool.timer); tool.timer = null; this.emit(run, { type: "tool", id: callId, title: tool.title, status: tool.status, detail: tool.detail }); }
      if (this.key !== null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const history = await Promise.race([this.call("chat.history", { sessionKey: this.key, limit: HISTORY_PAGE }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("usage read timed out")), USAGE_READ_MS); })]);
          const rows = (Array.isArray(history.messages) ? history.messages : []).map(record).filter((row): row is Row => row !== null), info = record(history.sessionInfo);
          const usage = usageOf(rows, run.owned, typeof info?.contextTokens === "number" && info.contextTokens > 0 ? info.contextTokens : undefined);
          if (usage !== null) this.emit(run, { type: "usage", usage });
          if (!run.inputRecorded && rows.some(row => row.role === "user" && run.owned.has(String(text(record(row.__openclaw)?.idempotencyKey) ?? "").replace(/:user$/u, "")))) this.recorded(run);
        } catch { this.diagnostic(run, "这一轮结束后没能读到 OpenClaw 的会话记录，用量没有记上。"); }
        finally { clearTimeout(timer); }
      }
      // Words given to the Turn while its usage was read: it ends with their run instead.
      if (run.steering > 0 || [...run.owned].some(id => !run.ended.has(id))) { run.settling = false; return; }
      const recorded = run.inputRecorded ? { input: "recorded" as const } : {};
      this.finish(run, state === "final" ? { status: "completed", reason: optional(ended.stopReason) ?? "completed", ...recorded }
        : state === "aborted" ? { status: "cancelled", reason: run.stopping ? "user_stopped" : "aborted", ...recorded }
        : { status: "failed", reason: "native_error", error: runFailure(ended), ...recorded });
    })();
  }
  private finish(run: Run, result: BackendResult): void {
    if (run.settled) return;
    for (const tool of run.tools.values()) if (tool.timer) { clearTimeout(tool.timer); tool.timer = null; }
    this.cancelPermissions(run);
    run.settled = true; run.signalStarted();
    if (this.active === run) this.active = null;
    run.resolve(result);
  }

  // ---- events --------------------------------------------------------------------------------------------------------------

  /** The live Turn a run of this session belongs to: one it owns; a run not seen before while its own chat.send has not answered yet is that one. */
  private runOf(runId: unknown): Run | null {
    const run = this.live();
    if (run === null || typeof runId !== "string") return null;
    if (run.owned.has(runId)) return run;
    if (run.primary === null && !this.known.has(runId)) { this.claim(run, runId, true); return run; }
    return null;
  }
  private event(name: string, raw: unknown): void {
    const payload = record(raw);
    if (payload === null || this.key === null) return;
    try {
      if (name === "chat" || name === "agent") {
        if (payload.sessionKey !== this.key) return;
        const run = this.runOf(payload.runId);
        if (run === null) { this.counted++; return; }
        if (name === "chat") this.chat(run, payload); else this.agent(run, payload);
        return;
      }
      if (name === "exec.approval.requested" || name === "plugin.approval.requested") return this.approval(name, payload);
      if (name === "question.requested") return this.question(payload);
      if (name === "exec.approval.resolved" || name === "plugin.approval.resolved" || name === "question.resolved") return this.withdraw(text(payload.id));
    } catch (error) {
      const run = this.live();
      if (run !== null) this.finish(run, { status: "failed", reason: "consumer_failed", error: { code: "CONTROL_FAILED", message: error instanceof Error ? error.message.slice(0, 300) : "event consumer failed" } });
    }
  }
  private chat(run: Run, payload: Row): void {
    const state = payload.state, runId = String(payload.runId);
    if (state === "final" || state === "aborted" || state === "error") { run.ended.set(runId, payload); this.maybeSettle(run); }
  }
  private agent(run: Run, payload: Row): void {
    const data = record(payload.data) ?? {}, stream = payload.stream, runId = String(payload.runId);
    if (runId === run.primary && (stream === "lifecycle" || stream === "assistant" || stream === "tool")) this.recorded(run);
    switch (stream) {
      case "assistant": {
        const item = optional(data.itemId) ?? "assistant:" + runId, prior = run.said.get(item) ?? "", whole = text(data.text), delta = text(data.delta) ?? "";
        // An item's snapshot replaces what it said; the Hub's text only grows, so only what extends it is said.
        const next = data.replace === true && whole !== undefined ? whole : whole !== undefined && whole.startsWith(prior) ? whole : prior + delta;
        if (next.startsWith(prior) && next.length > prior.length) { run.said.set(item, next); this.emit(run, { type: "text", text: next.slice(prior.length), item }); }
        return;
      }
      case "thinking": {
        if (data.phase === "persisted") return;
        const item = "thinking:" + (optional(data.itemId) ?? runId), delta = text(data.delta);
        if (delta) this.emit(run, { type: "thinking", text: delta, item });
        return;
      }
      case "item": { const call = optional(data.toolCallId), title = optional(data.title); if (call !== undefined && title !== undefined && !run.titles.has(call)) run.titles.set(call, title.slice(0, 4096)); return; }
      case "tool": {
        const call = optional(data.toolCallId);
        if (call === undefined) return;
        const prior = run.tools.get(call), next = toolUpdate(prior, data, run.titles.get(call));
        const tool: Tool = { ...next, timer: prior?.timer ?? null, output: prior?.output ?? "" };
        run.tools.set(call, tool);
        if (data.phase === "update") { this.later(run, call, tool); return; }
        if (tool.timer) { clearTimeout(tool.timer); tool.timer = null; }
        this.emit(run, { type: "tool", id: call, title: tool.title, status: tool.status, detail: tool.detail });
        return;
      }
      case "command_output": {
        const call = optional(data.toolCallId), tool = call === undefined ? undefined : run.tools.get(call), output = text(data.output);
        // The live output of a command still running; once its result came, the result is what the call said.
        if (tool === undefined || output === undefined || tool.status !== "in_progress") return;
        tool.output = output.startsWith(tool.output) ? output : tool.output + output;
        tool.detail = { ...tool.detail, output: tool.output };
        if (typeof data.exitCode === "number" && Number.isSafeInteger(data.exitCode)) tool.detail = { ...tool.detail, exitCode: data.exitCode };
        this.later(run, call!, tool);
        return;
      }
      case "plan": { const plan = planOf(data); if (plan !== null) this.emit(run, { type: "plan", ...plan }); return; }
      case "compaction": this.emit(run, { type: "activity", id: "compaction:" + runId, kind: "compaction", title: "上下文压缩", status: data.phase === "start" ? "running" : "completed" }); return;
      case "error": { const said = text(data.message) ?? text(data.error); if (said) this.emit(run, { type: "notice", severity: "error", title: said.slice(0, 1024) }); return; }
      default: return;
    }
  }
  /** A tool call's streamed output is shown at most every STREAM_MS. */
  private later(run: Run, call: string, tool: Tool): void {
    tool.timer ??= setTimeout(() => { tool.timer = null; if (!run.settled) this.emit(run, { type: "tool", id: call, title: tool.title, status: tool.status, detail: tool.detail }); }, STREAM_MS);
  }

  // ---- approvals and questions ---------------------------------------------------------------------------------------------

  enablePermissions(): void { this.interactive = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable");
    if (pending.validate) { try { pending.validate(option, input); } catch { throw new ControlError("INVALID_INPUT", "invalid native input answer"); } }
    this.pending.delete(id); pending.resolve({ option, ...(input === undefined ? {} : { input }) });
  }
  private cancelPermissions(run?: Run): void {
    for (const [id, pending] of this.pending) if (run === undefined || pending.run === run) { this.pending.delete(id); pending.resolve(STOPPED); }
  }
  /** Someone else resolved a request (another client, its expiry): its prompt closes and nothing is answered. */
  private withdraw(native: string | undefined): void {
    if (native === undefined) return;
    for (const [id, pending] of this.pending) if (pending.native === native) { this.pending.delete(id); pending.resolve(WITHDRAWN); this.emit(pending.run, { type: "permission", id, decision: "cancelled" }); }
  }
  private ask(run: Run, native: string, id: string, request: Omit<Extract<ControlEvent, { type: "permission_requested" }>, "type" | "id">, validate?: (option: string, input?: string) => void): Promise<Answer> {
    return new Promise<Answer>(resolve => {
      this.pending.set(id, { native, run, options: request.options.map(option => option.id), ...(validate ? { validate } : {}), resolve });
      this.emit(run, { type: "permission_requested", id, ...request });
    });
  }
  private approval(name: string, payload: Row): void {
    const request = record(payload.request) ?? payload, id = text(payload.id);
    if (request.sessionKey !== this.key || id === undefined || [...this.pending.values()].some(pending => pending.native === id)) return;
    const run = this.live(), exec = name === "exec.approval.requested", method = exec ? "exec.approval.resolve" : "plugin.approval.resolve";
    // A request of this session while no Turn of the Hub's runs (a run OpenClaw began by itself) is refused: nobody is there to answer it.
    if (run === null) { this.counted++; void this.call(method, { id, decision: "deny" }).catch(() => {}); return; }
    const prompt: Approval | null = exec ? execApproval(payload) : pluginApproval(payload);
    const answer = (decision: string) => this.call(method, { id, decision }).catch(() => this.diagnostic(run, "OpenClaw 没有收下这个审批的答复。"));
    if (prompt === null) { this.diagnostic(run, "OpenClaw 的审批格式读不懂，已拒绝"); void answer("deny"); return; }
    if (!this.interactive || run.stopping || !this.has("approvals")) { this.emit(run, { type: "permission", id, decision: run.stopping ? "cancelled" : "denied" }); void answer("deny"); return; }
    const expires = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs - Date.now() - 1000 : null;
    // What would leave the session (a message, a post, a payment) is the user's own decision: it is asked as a question, which no level answers.
    void this.ask(run, id, id, { title: prompt.title, ...(prompt.detail ? { detail: prompt.detail } : {}), options: prompt.options, toolKind: prompt.toolKind, ...(prompt.forCall ? { forCall: prompt.forCall } : {}),
      ...(prompt.outbound ? { kind: "question" as const } : {}), ...requestExpiry(expires) }).then(given => {
      if (given === WITHDRAWN) return;
      void answer(given === STOPPED ? "deny" : given.option);
    });
  }
  private question(payload: Row): void {
    const id = text(payload.id);
    if (payload.sessionKey !== this.key || id === undefined || [...this.pending.values()].some(pending => pending.native === id)) return;
    const run = this.live();
    if (run === null) { this.counted++; void this.call("question.resolve", { id, cancel: true }).catch(() => {}); return; }
    const cancel = () => this.call("question.resolve", { id, cancel: true }).catch(() => {});
    const questions = questionsOf(payload);
    if (questions === null) { this.diagnostic(run, "OpenClaw 的提问格式读不懂，已按未回答处理"); void cancel(); return; }
    if (!this.interactive || run.stopping || !this.has("questions")) { this.emit(run, { type: "permission", id, decision: run.stopping ? "cancelled" : "denied" }); void cancel(); return; }
    const expires = typeof payload.expiresAtMs === "number" ? payload.expiresAtMs - Date.now() - 1000 : null;
    void (async () => {
      const answers: Record<string, string[]> = {};
      for (const [index, question] of questions.entries()) {
        const given: Answer = await this.ask(run, id, id + ":" + index, this.questionRequest(question, expires), (option, input) => { question.value(option, input); });
        if (given === WITHDRAWN) return;
        const value = given === STOPPED ? "cancel" : question.value(given.option, given.input);
        if (value === "cancel") { void cancel(); return; }
        answers[question.id] = [...value];
      }
      await this.call("question.resolve", { id, answers: { answers } }).catch(() => this.diagnostic(run, "OpenClaw 没有收下这个提问的回答。"));
    })();
  }
  private questionRequest(question: Question, expires: number | null): Omit<Extract<ControlEvent, { type: "permission_requested" }>, "type" | "id"> {
    return { title: question.title, ...(question.detail ? { detail: question.detail } : {}), options: question.choices, ...(question.input ? { input: question.input } : {}), kind: "question", ...requestExpiry(expires) };
  }

  async close(): Promise<CleanupEvidence> {
    this.closed = true; this.cancelPermissions();
    const run = this.live();
    if (run !== null) this.finish(run, { status: "failed", reason: "connection_closed", error: { code: "NATIVE_CONNECTION_FAILED", message: "HarnessHub 关闭了和 OpenClaw 的连接，这一轮在 OpenClaw 里可能还在跑。" } });
    const link = this.link;
    if (link !== null) {
      if (this.key !== null && this.has("subscribe")) await this.call("sessions.messages.unsubscribe", { key: this.key, subscriptionId: "harnesshub" }, 2000).catch(() => {});
      this.link = null; await link.close();
    }
    return { closed: true, exitCode: null, signal: null, protocolFailure: this.failure === null ? null : { code: this.failure instanceof ControlError ? this.failure.code : "CONTROL_FAILED", message: this.failure.message } };
  }
}

