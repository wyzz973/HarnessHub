import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TABLE_ENV, TABLE_MCP_NAME, TABLE_RECORD_ENV } from "../../../contracts/table.js";
import { nativeConversationId, requestExpiry, singleText, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun,
  type HarnessControl, type NativeConversationId, type NativeExtensions, type NativeModelCatalog, type NativeOption, type NativeOptions, type NativeSessionImport, type NativeSessionPage,
  type NativeToolDetail, type NativeUsage, type ProtocolObservation, type SteerOutcome, type StopRequestReceipt, type TurnText } from "../../../contracts/control.js";
import { MAX_CONTENT_BYTES, type ContentKind, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import type { RelayCapabilities, RelayPacketId } from "../../../contracts/relay.js";
import { levelOptions, type ChosenLevels } from "../../../contracts/flavor.js";
import { ControlError, SKIP_REPLY, errorFrom, object, string, type RpcRequest } from "../../../infrastructure/control/json-rpc-process.js";
import { checkInputs, fileMentions } from "../../../infrastructure/control/attachments.js";
import { CODEX_SKILL_INPUT as SKILL_INPUT, CODEX_THREAD_COMMANDS as THREAD_COMMANDS, codexClassify, codexNativeClassify, codexThreadOperation as threadOperation, relayDeclaration, relayEntries } from "../relay-classify.js";
import { bodyWithoutFirstLine, boundedRequests, carriesPacket, clearedNotice, COMMAND_REFUSED, exceedsInput, hubCleared, INPUT_LIMIT_REFUSED, TITLE_DEADLINE_MS, usageRequest, measureBy } from "../relay-turn.js";
import { CodexHost, ConsumerFailure } from "./host.js";
import { COLLABORATION_MODE, COLLABORATION_OPTION, PERMISSION_SETTINGS, SANDBOX_TYPES, SERVICE_TIER, STANDARD_TIER, gitRootOf, permissionOptions, reasoningSummary,
  serviceTierOption, threadReport, tierOf, trustOverride, type PermissionSetting } from "./levels.js";
import { asyncQuestions, echoedClientId, fileDiff, importTurn, inputText, itemTool, line, record, status, threadSource, threadTitle, tokens, turnFailure, turnTokens, TurnUsage, type Row, type Tokens } from "./mapping.js";
import { commandApproval, elicitation, fileChangeApproval, legacyApproval, permissionsApproval, refusalOf, userInputQuestions, type Prompt, type Question } from "./requests.js";
import type { CodexFeature } from "./schema.js";

/**
 * Codex's relay declaration (ADR-055 §8.1, Codex row): one text (packet, a line break, then the user's words), at most 1,048,576 characters; live
 * evidence from the user message carrying the turn's client identity (`clientUserMessageId`), and a completed turn proves nothing by itself; the
 * driver's own `/export` and `/compact`, the Hub's clear and listed `/skill:` inputs; one process per connection; a native title by `thread/name/set`.
 */
export const codexRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "recorded_event", successProvesRecorded: false },
  execution: "process",
  commands: { classify: codexClassify },
  placement: { parts: "single", maxInput: { unit: "chars", limit: 1_048_576 }, measure: measureBy("single", "chars", ["file"]) },
  title: "set",
});

/** The longest opening a thread is waited for (see setupMs). */
const SESSION_SETUP_MS = 10 * 60_000;
const STREAM_MS = 300;
/** Codex's refusal of turn/interrupt for a thread without an active turn (-32600): a turn it has not begun yet (its hooks run first), or one that ended. */
const NO_ACTIVE_TURN_CODE = -32600, NO_ACTIVE_TURN = "no active turn to interrupt";
const INTERRUPT_RETRY_MS = 250;
/** How long a resume of a thread Codex is still closing waits for its `thread/closed`. */
const CLOSING_WAIT_MS = 10_000;
/** Thread sources a user continues; sub-agent threads belong to their parent thread. */
const LISTED_SOURCES = ["cli", "vscode", "exec", "appServer"] as const;
/** The originators of threads the Hub itself created through app-server (its clientInfo name, which Codex records): not offered for import. */
const HUB_ORIGINATORS = new Set(["harnessgateway", "harnesshub"]);
const IMPORT_TURNS_PER_PAGE = 50;
/** A result this driver writes itself when nothing reached Codex. */
const NOT_RECORDED = { input: "not_recorded" } as const;

interface ToolEntry { title: string; status: string; detail: NativeToolDetail; timer: ReturnType<typeof setTimeout> | null; changes: readonly unknown[] }
/**
 * One Hub Turn. It owns the native turn turn/start (or the compaction) began, and every turn Codex begins by itself on the thread while it runs (a
 * goal's continuation): it ends with the last of them, once nothing it owns runs. Items of its turns that arrive while it settles are still its own.
 */
interface Run {
  readonly onEvent: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly started: Promise<void>;
  readonly signalStarted: () => void;
  readonly rejectStarted: (error: Error) => void;
  primary: string | null;
  readonly turns: Set<string>;
  readonly running: Set<string>;
  primaryDone: boolean;
  outcome: BackendResult | null;
  settling: boolean;
  settled: boolean;
  /** Message, plan and reasoning items that streamed deltas (their completed item then adds nothing). */
  readonly streamed: Set<string>;
  /** The summary part each reasoning item streams now. */
  readonly parts: Map<string, number>;
  readonly items: Map<string, ToolEntry>;
  readonly reads: Set<Promise<void>>;
  readonly agents: Map<string, { title: string; status: string; detail: NativeToolDetail }>;
  readonly usage: TurnUsage;
  readonly agentUsage: Map<string, TurnUsage>;
  context: NativeUsage["context"] | undefined;
  inputRecorded: boolean;
  readonly clientId: string | null;
  readonly packetId: RelayPacketId | null;
  readonly requests: NonNullable<NativeUsage["requests"]>[number][];
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  begun: boolean;
  wake: (() => void) | null;
  readonly steers: Map<string, boolean>;
}
const WITHDRAWN = Symbol("withdrawn"), STOPPED = Symbol("stopped");
type Answer = { readonly option: string; readonly input?: string } | typeof WITHDRAWN | typeof STOPPED;
interface Pending { readonly rpc: string; readonly run: Run; readonly options: readonly string[]; readonly validate?: (option: string, input?: string) => void; readonly resolve: (answer: Answer) => void }
const PASSIVE = new Set(["thread/started", "thread/status/changed", "thread/name/updated", "thread/settings/updated", "thread/readState/changed", "thread/archived", "thread/unarchived",
  "thread/goal/updated", "thread/goal/cleared", "thread/reverted", "thread/section/changed", "thread/attachment/updated", "thread/queue/changed", "thread/prediction/updated", "thread/project/updated",
  "thread/environment/connected", "thread/environment/disconnected", "thread/compacted", "turn/diff/updated", "turn/moderationMetadata", "model/safetyBuffering/updated", "item/plan/delta",
  "item/fileChange/outputDelta", "item/commandExecution/terminalInteraction", "hook/started", "hook/completed", "autoApprovalReview/strictReviewRequired",
  "account/updated", "account/rateLimits/updated", "account/login/completed", "account/gatewayOAuth/changed", "sessionConfigured", "skills/changed", "mcpServer/startupStatus/updated",
  "mcpServer/oauthLogin/completed", "remoteControl/status/changed", "app/list/updated", "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted", "fs/changed", "project/changed"]);
function collaborationUnavailable(error: ControlError): ControlError {
  const reason = error.remoteCode === -32601 ? "它没有 collaborationMode/list 方法（-32601）" : "它拒绝了 collaborationMode/list" + (error.remoteCode === undefined ? "" : "（" + error.remoteCode + "）");
  return new ControlError("NATIVE_OPTION_UNAVAILABLE", "这个 Codex 不提供协作模式：" + reason + "。" + (error.remoteFailure?.message ?? ""));
}
const optional = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

/** Codex app-server anti-corruption layer; native thread and turn IDs never become public Session IDs. */
export class CodexControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = codexRelayCapabilities;
  private readonly host: CodexHost;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  /** Features the drift check found missing in this Codex (schema.ts). */
  private off: ReadonlySet<CodexFeature> = new Set();
  /** What is said once, in the next Turn: the drift check's line, a reviewer Codex did not take. */
  private readonly notes: string[] = [];
  private conversation: NativeConversationId | null = null;
  private opening = false;
  /** Codex closed or deleted the opened thread: this connection takes no more Turns for it. */
  private threadGone = false;
  private effort: string | undefined;
  private openedModel: string | undefined;
  /** The collaboration mode every turn sends, with the model and effort it runs; null when this Codex has none or the model is not known. */
  private collaboration: { readonly mode: string; readonly model: string; readonly effort: string | null } | null = null;
  private confirmedMode: string | null = null;
  private threadSettings: NativeOptions = {};
  private threadMode: string | null = null;
  private resumed = false;
  /** What every turn/start of the opened thread carries (research §8.4): its model, effort, summary, approval policy and reviewer, and the speed of a turn. */
  private turnSettings: Readonly<Record<string, string>> = {};
  private skills = new Map<string, { readonly name: string; readonly path: string }>();
  private forkConnection = false;
  private threadPath: string | null = null;
  private instructions: string | null = null;
  private interactivePermissions = false;
  private readonly pending = new Map<string, Pending>();
  private active: Run | null = null;
  private failure: Error | null = null;
  /** Every native turn a Run of this connection owned: a later item of one of them is late, never the current Run's. */
  private readonly turnIds = new Set<string>();
  /** The opened thread's latest token totals: the next Run's baseline. */
  private threadTotal: Tokens | null = null;
  /** The thread the Hub's clear gave up, unsubscribed once the next thread is open. */
  private cleared: NativeConversationId | null = null;
  /** Turns Codex ran by itself between Runs, said once in the next Run. */
  private idleTurns = 0;
  get unattributedUpdates(): number { return this.host.unattributed; }
  get steering(): boolean { return this.has("steer"); }
  healthy(): boolean { return this.initialized && this.failure === null && this.host.rpc.failure === null && !this.threadGone; }
  processGroup(): number | null { return this.rpc.processGroup; }
  diagnosticMark(): number { return this.rpc.stderrMark; }
  diagnosticsSince(mark: number): string { return this.rpc.stderrSince(mark); }
  private get rpc() { return this.host.rpc; }
  private has(feature: CodexFeature): boolean { return !this.off.has(feature); }

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "codex-app-server") throw new ControlError("INVALID_INPUT", "Codex control requires an app-server launch");
    this.host = new CodexHost(launch, options, {
      thread: (root, thread, method, params) => { if (thread === root) this.ownNotification(method, params); else this.childNotification(thread, method, params); },
      announced: thread => this.announced(thread),
      global: (method, params) => this.globalNotification(method, params),
      request: (root, thread, request, params) => this.serverRequest(thread === root, request, params),
      fault: method => { const run = this.live(); if (run) this.safeEmit(run, { type: "diagnostic", message: "Codex 发来了一条读不懂的消息：" + method.slice(0, 128) }); },
      failure: error => { this.failure = error; if (this.active) this.failRun(this.active, error); },
    });
  }
  initialize(): Promise<ProtocolObservation> {
    if (this.failure) return Promise.reject(this.failure);
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }
  private setupMs(): number { return Math.max(this.options.requestTimeoutMs, Math.min(SESSION_SETUP_MS, this.options.runTimeoutMs ?? SESSION_SETUP_MS)); }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      const handshake = await this.host.initialize(this.options.startupTimeoutMs ?? this.options.requestTimeoutMs);
      this.off = handshake.check.off;
      if (handshake.check.diagnostic !== null) this.notes.push(handshake.check.diagnostic);
      this.initialized = true;
      return { protocol: "codex-app-server", protocolVersion: null, agentName: "codex", agentVersion: handshake.version, authenticationMethods: [],
        capabilities: { userAgent: handshake.userAgent, experimentalApi: true, ...(this.off.size ? { featuresOff: [...this.off] } : {}) } };
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const { models, defaultModel, options } = await this.nativeCatalog(await this.readConfig(this.options.cwd));
    const account = object(await this.rpc.request("account/read", { refreshToken: false }), "native account status");
    const skills = await this.readSkills();
    const commands = [...THREAD_COMMANDS, ...skills.filter(skill => skill.enabled).map(skill => ({ name: "skill:" + skill.name, description: ("Skill · " + skill.description).slice(0, 1024), contextEffect: "keep" as const }))];
    return { models, defaultModel, canSelect: models.length > 0, ...(options.length ? { options } : {}), commands, authentication: account.requiresOpenaiAuth === false || account.account != null ? "ready" : account.requiresOpenaiAuth === true ? "missing" : "unknown" };
  }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return codexNativeClassify(text, catalog, attachments); }
  /** The effective configuration (config/read, nothing written); a Codex that refuses it is read as one that configures nothing. */
  private async readConfig(cwd: string): Promise<Row> {
    try { return object(object(await this.rpc.request("config/read", { includeLayers: false, cwd }), "native configuration").config, "effective native configuration"); }
    catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) return {}; throw error; }
  }
  private async nativeCatalog(configured: Row): Promise<{ readonly models: NativeModelCatalog["models"]; readonly defaultModel: string | null; readonly options: readonly NativeOption[] }> {
    const models: NativeModelCatalog["models"][number][] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const response = object(await this.rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }) }), "native models");
      if (!Array.isArray(response.data) || response.data.length > 100) throw new ControlError("INVALID_PROTOCOL", "invalid native model page");
      for (const value of response.data) {
        const row = object(value, "native model"), id = string(row.model, "model", 1024), name = string(row.displayName, "model name", 1024);
        if (seen.has(id)) throw new ControlError("INVALID_PROTOCOL", "duplicate native model");
        let options: NativeOption[] | undefined;
        if (row.inputModalities !== undefined && (!Array.isArray(row.inputModalities) || row.inputModalities.length > 16 || row.inputModalities.some(value => typeof value !== "string"))) throw new ControlError("INVALID_PROTOCOL", "invalid model input modalities");
        const modalities = (row.inputModalities ?? ["text", "image"]) as readonly string[];
        const inputs = { image: modalities.includes("image"), audio: modalities.includes("audio"), file: true };
        if (row.supportedReasoningEfforts !== undefined) {
          if (!Array.isArray(row.supportedReasoningEfforts) || row.supportedReasoningEfforts.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid reasoning effort catalog");
          const values = row.supportedReasoningEfforts.map(value => { const level = object(value, "reasoning effort"); const valueId = string(level.reasoningEffort, "reasoning effort", 128); return { value: valueId, name: valueId }; });
          const currentValue = id === configured.model && typeof configured.model_reasoning_effort === "string" ? configured.model_reasoning_effort : string(row.defaultReasoningEffort, "default reasoning effort", 128);
          if (values.length && !values.some(row => row.value === currentValue)) throw new ControlError("INVALID_PROTOCOL", "configured reasoning effort unavailable");
          if (values.length) options = [{ id: "reasoning_effort", name: "思考强度", category: "thought_level", currentValue, values }];
        }
        const tier = serviceTierOption(row, configured);
        if (tier !== null) options = [...(options ?? []), tier];
        seen.add(id); models.push({ id, name, ...(options ? { options } : {}), inputs });
        if (models.length > 4095) throw new ControlError("MODEL_LIMIT", "native model catalog exceeds its bounds");
      }
      if (response.nextCursor === null || response.nextCursor === undefined) break;
      const next = string(response.nextCursor, "model cursor", 1024);
      if (next === cursor || models.length >= 4096 || page === 63) throw new ControlError("MODEL_LIMIT", "native model catalog exceeds its bounds");
      cursor = next;
    }
    const defaultModel = configured.model == null ? null : string(configured.model, "configured model", 1024);
    if (defaultModel !== null && !seen.has(defaultModel)) models.unshift({ id: defaultModel, name: defaultModel });
    return { models, defaultModel, options: [COLLABORATION_OPTION, ...permissionOptions(configured)] };
  }
  async checkpoint(): Promise<string | null> { return this.conversation; }
  private levels(): ChosenLevels {
    return { ...(this.options.permission === undefined ? {} : { permission: this.options.permission }), ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.options.speed === undefined ? {} : { speed: this.options.speed }) };
  }
  private assertOwned(id: NativeConversationId): void {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation || this.opening) throw new ControlError("IDENTITY_MISMATCH", "thread is not owned by this connection");
  }
  /** Names the thread on Codex's side before its first turn (`thread/name/set`); a refusal or no answer within TITLE_DEADLINE_MS is NATIVE_TITLE_UNAVAILABLE. */
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    this.assertOwned(id);
    const name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 200).join("").trim();
    if (!name) return;
    try { await this.rpc.request("thread/name/set", { threadId: id, name }, Math.min(this.options.requestTimeoutMs, TITLE_DEADLINE_MS), "reject"); }
    catch (error) { if (error instanceof ControlError && (error.code === "REMOTE_ERROR" || error.code === "REQUEST_TIMEOUT") && this.rpc.failure === null) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "Codex did not name the thread"); throw error; }
  }
  /** HarnessControl.setSessionInstructions: Codex's `developerInstructions` on thread/start and thread/resume, after the user's own. */
  setSessionInstructions(text: string | null): void { this.instructions = text; }
  /** The Hub's tool server as a thread's own MCP server (`mcp_servers.<name>` in the thread's `config`), the table's variables forwarded by name. */
  private hubToolServer(): Readonly<Record<string, unknown>> | null {
    if (this.options.entry?.tools !== "thread-config") return null;
    const tool = fileURLToPath(new URL("../../../cli/hub-tools.js", import.meta.url));
    if (!this.options.env[TABLE_ENV.url] || !this.options.env[TABLE_ENV.session] || !existsSync(tool)) return null;
    return { command: process.execPath, args: [tool, "mcp"], env_vars: [TABLE_ENV.url, TABLE_ENV.session, ...(this.options.env[TABLE_RECORD_ENV] ? [TABLE_RECORD_ENV] : [])], default_tools_approval_mode: "approve" };
  }
  get sessionTools(): boolean { return this.hubToolServer() !== null; }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    const mode = this.confirmedMode ?? (this.collaboration === null ? this.threadMode : null);
    if (mode === null && this.resumed) return null;
    const options = { ...this.threadSettings, ...(mode === null ? {} : { [COLLABORATION_MODE]: mode }) };
    return Object.keys(options).length ? { model: null, options } : null;
  }
  /** The reviewer a level asks for (its declaration's `session.params.approvalsReviewer`, the user otherwise); nothing for no level or a Codex without reviewers. */
  private reviewerFor(level: ChosenLevels["permission"]): string | undefined {
    if (level === undefined || !this.has("approvalsReviewer")) return undefined;
    const wanted = this.options.flavor?.permission[level]?.session?.params?.approvalsReviewer;
    if (wanted === "auto_review" && !this.has("autoReview")) { this.notes.push("这个 Codex 没有自动审查（auto_review），“自动执行”时由 Hub 按档位答复它的请求。"); return "user"; }
    return typeof wanted === "string" ? wanted : "user";
  }
  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "this connection already owns a thread");
    this.opening = true;
    try {
      this.effort = undefined; this.collaboration = null; this.confirmedMode = null; this.turnSettings = {}; this.threadGone = false;
      const configured = await this.readConfig(cwd);
      const overrides: Record<string, string> = {}, levels = this.levels();
      let selected: NativeModelCatalog["models"][number] | undefined;
      if (model !== undefined || Object.keys(native ?? {}).length || levels.permission !== undefined || levels.effort !== undefined || levels.speed !== undefined) {
        const catalog = await this.nativeCatalog(configured); selected = catalog.models.find(row => row.id === (model ?? catalog.defaultModel));
        if (!selected) throw new ControlError("MODEL_UNAVAILABLE", "selected model is not in this Harness native catalog");
        native = levelOptions(this.options.flavor, [...catalog.options, ...(selected.options ?? [])], native, levels, checkpoint !== undefined);
        for (const [id, value] of Object.entries(native ?? {})) {
          if (id === COLLABORATION_MODE) {
            if (!catalog.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "Codex has no such collaboration mode");
            if (!this.has("collaborationMode") && value !== "default") throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "这个 Codex 不提供协作模式：它的协议里没有 collaborationMode。");
            continue;
          }
          if (Object.hasOwn(PERMISSION_SETTINGS, id)) {
            if (!catalog.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "permission setting unavailable in the native configuration");
            overrides[PERMISSION_SETTINGS[id as PermissionSetting].param] = value; continue;
          }
          if (id === SERVICE_TIER) {
            if (!selected.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "speed unavailable for selected native model");
            overrides.serviceTier = value; continue;
          }
          if (id !== "reasoning_effort" || !selected.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "reasoning effort unavailable for selected native model");
          this.effort = value;
        }
      }
      const reviewer = this.reviewerFor(levels.permission);
      if (reviewer !== undefined) overrides.approvalsReviewer = reviewer;
      this.openedModel = model;
      const mode = native?.[COLLABORATION_MODE];
      // Whether turns carry a collaboration mode at all: this Codex has them, and did not refuse to list them.
      let modes = this.has("collaborationMode"), chosen: { readonly model: string; readonly effort: string | null } | null = null;
      if (mode !== undefined && modes) {
        // The mode's settings replace the turn's model and effort: the chosen values, then the user's own preset for the mode, then the configured ones.
        let listed: unknown;
        try { listed = await this.rpc.request("collaborationMode/list", {}); }
        catch (error) {
          // A Codex without collaboration modes has no plan to undo: the default a level asks for is what it runs anyway.
          if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null && mode === "default" && this.options.selectedOptions?.[COLLABORATION_MODE] === undefined) listed = null;
          else throw error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null ? collaborationUnavailable(error) : error;
        }
        if (listed === null) modes = false;
        else {
          const presets = object(listed, "collaboration modes");
          if (!Array.isArray(presets.data)) throw new ControlError("INVALID_PROTOCOL", "invalid collaboration modes");
          const row = presets.data.map(value => object(value, "collaboration mode")).find(entry => entry.mode === mode);
          const turnModel = model ?? optional(row?.model) ?? selected?.id;
          if (turnModel === undefined) throw new ControlError("MODEL_UNAVAILABLE", "no model is configured for the collaboration mode");
          chosen = { model: turnModel, effort: this.effort ?? (typeof row?.reasoning_effort === "string" ? row.reasoning_effort : undefined) ?? selected?.options?.find(option => option.id === "reasoning_effort")?.currentValue ?? null };
        }
      }
      const entry = this.threadEntry(configured), sandbox = overrides.sandbox;
      // Codex would write this directory's trust into config.toml for an explicit writable sandbox; the same decision for this thread alone does not (levels.ts).
      const trust = trustOverride(configured.projects, cwd, sandbox, gitRootOf(cwd, existsSync));
      const config = { ...entry.config, ...(trust === null ? {} : { projects: trust }) };
      const clear = checkpoint === undefined && this.cleared !== null && this.has("sessionStartSource");
      if (checkpoint !== undefined) { this.conversation = nativeConversationId(checkpoint); this.host.own(this.conversation); }
      const response = await this.openThread(checkpoint === undefined ? "thread/start" : "thread/resume", {
        cwd, ...(checkpoint === undefined ? { ephemeral: false, ...(clear ? { sessionStartSource: "clear" } : {}) } : { threadId: nativeConversationId(checkpoint), excludeTurns: true }),
        ...(model === undefined ? {} : { model }), ...overrides, ...(entry.developerInstructions === undefined ? {} : { developerInstructions: entry.developerInstructions }), ...(Object.keys(config).length ? { config } : {}),
      }, checkpoint);
      if (overrides.approvalPolicy !== undefined && response.approvalPolicy !== overrides.approvalPolicy) throw new ControlError("NATIVE_OPTION_MISMATCH", "Codex did not apply the requested approval policy");
      if (overrides.sandbox !== undefined && SANDBOX_TYPES[String(object(response.sandbox, "Codex sandbox").type)] !== overrides.sandbox) throw new ControlError("NATIVE_OPTION_MISMATCH", "Codex did not apply the requested sandbox");
      if (overrides.serviceTier !== undefined && tierOf(response.serviceTier ?? STANDARD_TIER) !== tierOf(overrides.serviceTier)) throw new ControlError("NATIVE_OPTION_MISMATCH", "Codex did not apply the requested speed");
      // A reviewer Codex reports otherwise is not a failure: the Hub's policy answers what comes to it.
      let reviewed = overrides.approvalsReviewer ?? optional(response.approvalsReviewer);
      if (overrides.approvalsReviewer !== undefined && response.approvalsReviewer !== undefined && response.approvalsReviewer !== overrides.approvalsReviewer) {
        this.notes.push("Codex 没有采用所选的审批方式（" + overrides.approvalsReviewer + "），由 Hub 按档位答复它的请求。"); reviewed = optional(response.approvalsReviewer);
      }
      const thread = object(response.thread, "Codex thread");
      this.threadPath = typeof thread.path === "string" && isAbsolute(thread.path) ? thread.path : null;
      const received = nativeConversationId(thread.id);
      if (checkpoint !== undefined && received !== checkpoint) throw new ControlError("IDENTITY_MISMATCH", "native restore returned a different thread");
      if (checkpoint === undefined && this.host.isReleased(received)) throw new ControlError("IDENTITY_MISMATCH", "Codex answered a new thread with one this connection gave up");
      if (this.conversation && this.conversation !== received) throw new ControlError("IDENTITY_MISMATCH", "thread/start response does not match thread/started");
      this.conversation = received; this.host.own(received);
      const report = threadReport(response);
      this.threadSettings = report.settings; this.threadMode = report.mode; this.resumed = checkpoint !== undefined;
      // Every setting goes with every turn (T3 Code): what the thread was opened with, else what it says it runs with.
      const turnModel = model ?? optional(response.model), turnEffort = this.effort ?? optional(response.reasoningEffort);
      this.turnSettings = { ...(turnModel === undefined ? {} : { model: turnModel }), ...(turnEffort === undefined ? {} : { effort: turnEffort }),
        ...(this.has("summary") ? { summary: reasoningSummary(configured) } : {}), ...(overrides.approvalPolicy ?? optional(response.approvalPolicy) ? { approvalPolicy: overrides.approvalPolicy ?? response.approvalPolicy as string } : {}),
        ...(reviewed !== undefined && this.has("approvalsReviewer") ? { approvalsReviewer: reviewed } : {}), ...(overrides.serviceTier !== undefined && this.has("serviceTierForTurn") ? { serviceTierForTurn: overrides.serviceTier } : {}) };
      // The collaboration mode goes with every turn too, both modes (so that leaving plan mode is said, T3 Code): the chosen one with its settings, else
      // the one the thread reports, else default, with the model and effort the thread runs.
      if (chosen !== null && mode !== undefined) this.collaboration = { mode, ...chosen };
      else if (modes && mode === undefined && turnModel !== undefined) this.collaboration = { mode: this.threadMode ?? "default", model: turnModel, effort: turnEffort ?? null };
      // The thread the Hub's clear gave up is unloaded now that its successor is open.
      if (this.cleared !== null) { const old = this.cleared; this.cleared = null; if (this.has("unsubscribe")) void this.rpc.request("thread/unsubscribe", { threadId: old }, this.options.requestTimeoutMs, "reject").catch(() => {}); }
      return received;
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
    finally { this.opening = false; }
  }
  /**
   * thread/start or thread/resume, with what a resume meets (T3 Code's field-tested cases): a thread open in another Codex window ("already has an active
   * writer") is said plainly; an archived thread is unarchived and resumed; a thread Codex is still closing is resumed once it closed.
   */
  private async openThread(method: string, params: Row, checkpoint: string | undefined): Promise<Row> {
    for (let attempt = 0; ; attempt++) {
      try { return object(await this.rpc.request(method, params, this.setupMs(), "abort", "NATIVE_SESSION_TIMEOUT"), "native thread setup result"); }
      catch (error) {
        if (!(error instanceof ControlError && error.code === "REMOTE_ERROR") || this.rpc.failure !== null) throw error;
        const said = (error.remoteMessage ?? "") + " " + (error.remoteDetail ?? "");
        if (/already has an active writer/iu.test(said)) throw new ControlError("NATIVE_SESSION_BUSY", "这个会话正在另一个 Codex 窗口里用，关掉那边再试。");
        if (attempt === 0 && checkpoint !== undefined && this.has("unarchive") && /\b(?:session|thread) \S+ is archived\b|\bcodex unarchive\b/iu.test(said)) { await this.rpc.request("thread/unarchive", { threadId: checkpoint }); continue; }
        if (attempt === 0 && checkpoint !== undefined && /\bthread \S+ is closing\b/iu.test(said)) { await this.host.waitClosed(checkpoint, CLOSING_WAIT_MS); continue; }
        throw error;
      }
    }
  }
  /** `developerInstructions` (the user's own first, then the Hub's) and the Hub's tool server in the thread's `config`, from the effective configuration. */
  private threadEntry(configured: Row): { readonly developerInstructions?: string; readonly config?: Readonly<Record<string, unknown>> } {
    const server = this.hubToolServer();
    const own = typeof configured.developer_instructions === "string" ? configured.developer_instructions.trim() : "";
    return { ...(this.instructions === null ? {} : { developerInstructions: own ? own + "\n\n" + this.instructions : this.instructions }),
      ...(server === null ? {} : { config: { ["mcp_servers." + TABLE_MCP_NAME]: server } }) };
  }
  /** This workspace's threads (thread/list): not archived, newest first, without sub-agent threads and without the threads the Hub itself created. */
  async nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    const response = object(await this.rpc.request("thread/list", { cwd, limit: 50, sortKey: "updated_at", sortDirection: "desc", archived: false, sourceKinds: LISTED_SOURCES,
      ...(cursor === undefined ? {} : { cursor }) }), "Codex thread list");
    if (!Array.isArray(response.data) || response.data.length > 100) throw new ControlError("INVALID_PROTOCOL", "invalid Codex thread page");
    // The Hub's own threads are told by their originator, not their source: app-server records them as "vscode" (0.169.0, the trial workspace's nine).
    const sessions = response.data.map(value => object(value, "Codex thread")).filter(thread => thread.cwd === cwd && thread.ephemeral !== true
      && !(typeof thread.originator === "string" && HUB_ORIGINATORS.has(thread.originator))).map(thread => {
      const updated = typeof thread.updatedAt === "number" && Number.isSafeInteger(thread.updatedAt) && thread.updatedAt > 0 ? thread.updatedAt * 1000 : null, source = threadSource(thread.source);
      return { id: string(thread.id, "Codex thread identity", 1024), title: threadTitle(thread), updatedAt: updated, ...(source ? { source } : {}) };
    });
    return { sessions, nextCursor: response.nextCursor == null ? null : string(response.nextCursor, "Codex thread cursor", 1024) };
  }
  /**
   * Reads a thread of this workspace for continuing it: thread/read confirms its workspace, thread/turns/list (`itemsView: "full"`) returns its turns
   * newest first; each becomes the user's words and the agent's reply, with what it did in the turn. Nothing is resumed or sent.
   */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    this.assertInitialized();
    const thread = object(object(await this.rpc.request("thread/read", { threadId: id, includeTurns: false }), "Codex thread read").thread, "Codex thread");
    if (thread.id !== id) throw new ControlError("IDENTITY_MISMATCH", "Codex returned another thread");
    if (thread.cwd !== cwd) throw new ControlError("NATIVE_SESSION_WORKSPACE_MISMATCH", "the thread belongs to another workspace");
    if (thread.ephemeral === true) throw new ControlError("NATIVE_SESSION_UNAVAILABLE", "an ephemeral thread cannot be continued");
    const turns: { user: string; assistant: string }[] = [];
    let cursor: string | undefined, complete = false;
    const seen = new Set<string>();
    for (;;) {
      const response = object(await this.rpc.request("thread/turns/list", { threadId: id, limit: IMPORT_TURNS_PER_PAGE, sortDirection: "desc", itemsView: "full", ...(cursor === undefined ? {} : { cursor }) }), "Codex turns");
      if (!Array.isArray(response.data) || response.data.length > IMPORT_TURNS_PER_PAGE) throw new ControlError("INVALID_PROTOCOL", "invalid Codex turn page");
      for (const value of response.data) {
        const items = object(value, "Codex turn").items, turn = importTurn(Array.isArray(items) ? items : []);
        if (turn.user || turn.assistant) turns.push({ user: turn.user, assistant: turn.assistant });
      }
      if (response.nextCursor == null) { complete = true; break; }
      cursor = string(response.nextCursor, "Codex turn cursor", 1024);
      if (seen.has(cursor)) throw new ControlError("INVALID_PROTOCOL", "Codex repeated a turn cursor");
      seen.add(cursor);
    }
    const history = turns.reverse().flatMap(turn => [...(turn.user ? [{ role: "user" as const, text: turn.user }] : []), ...(turn.assistant ? [{ role: "assistant" as const, text: turn.assistant }] : [])]);
    return { checkpoint: id, title: threadTitle(thread), history, omitted: 0, complete, historyRead: true };
  }
  private async readSkills(): Promise<{ name: string; description: string; scope?: string; enabled: boolean; path: string }[]> {
    let response: unknown;
    try { response = await this.rpc.request("skills/list", { cwds: [this.options.cwd] }); }
    catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) { this.skills = new Map(); return []; } throw error; }
    const result = object(response, "native skills");
    if (!Array.isArray(result.data)) throw new ControlError("INVALID_PROTOCOL", "invalid native skill list");
    const skills = result.data.flatMap(entry => { const rows = object(entry, "native skill root").skills; return Array.isArray(rows) ? rows : []; }).flatMap(value => {
      const row = object(value, "native skill"), name = typeof row.name === "string" ? line(row.name, 256) : "", path = typeof row.path === "string" ? row.path : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(name) || !isAbsolute(path)) return [];
      return [{ name, description: typeof row.description === "string" ? line(row.description, 1024) : "", ...(typeof row.scope === "string" ? { scope: line(row.scope, 64) } : {}), enabled: row.enabled === true, path }];
    });
    this.skills = new Map(skills.filter(skill => skill.enabled).map(skill => [skill.name, { name: skill.name, path: skill.path }]));
    return skills;
  }
  async extensions(): Promise<NativeExtensions> {
    this.assertInitialized();
    const skills = await this.readSkills(), mcpServers: NativeExtensions["mcpServers"][number][] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const result = object(await this.rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100, ...(cursor === undefined ? {} : { cursor }) }), "native MCP status");
      if (!Array.isArray(result.data)) throw new ControlError("INVALID_PROTOCOL", "invalid native MCP status");
      for (const value of result.data) {
        const row = object(value, "native MCP server"), tools = row.tools !== null && typeof row.tools === "object" ? Object.keys(row.tools).length : 0;
        mcpServers.push({ name: string(row.name, "MCP server name", 256), status: typeof row.runtimeStatus === "string" ? row.runtimeStatus : "notStarted", ...(typeof row.authStatus === "string" ? { auth: row.authStatus } : {}), tools, failed: row.toolsError !== null && row.toolsError !== undefined });
      }
      if (typeof result.nextCursor !== "string") break;
      if (seen.has(result.nextCursor)) throw new ControlError("INVALID_PROTOCOL", "Codex repeated an MCP status cursor");
      cursor = result.nextCursor; seen.add(cursor);
    }
    const installed = object(await this.rpc.request("plugin/installed", { cwds: [this.options.cwd] }), "native plugins");
    const plugins = (Array.isArray(installed.marketplaces) ? installed.marketplaces : []).flatMap(value => {
      const market = object(value, "native plugin marketplace"), source = typeof market.name === "string" ? line(market.name, 256) : undefined;
      return (Array.isArray(market.plugins) ? market.plugins : []).flatMap(item => {
        const plugin = object(item, "native plugin");
        if (plugin.installed !== true || typeof plugin.name !== "string") return [];
        const version = typeof plugin.localVersion === "string" ? plugin.localVersion : typeof plugin.version === "string" ? plugin.version : undefined;
        return [{ name: line(plugin.name, 256), enabled: plugin.enabled === true, ...(version ? { version: line(version, 64) } : {}), ...(source ? { source } : {}) }];
      });
    });
    return { skills: skills.map(({ path: _path, ...skill }) => ({ ...skill, ...(skill.enabled ? { command: "skill:" + skill.name } : {}) })), mcpServers, plugins };
  }
  /** `thread/fork` of a stored thread on a connection that opened none; the source thread is not loaded into a turn. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    this.assertInitialized();
    if (this.conversation !== null || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "a fork needs its own connection");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    const source = nativeConversationId(checkpoint);
    this.forkConnection = true;
    try {
      const response = object(await this.rpc.request("thread/fork", { threadId: source, cwd, excludeTurns: true }, this.setupMs(), "abort", "NATIVE_SESSION_TIMEOUT"), "thread/fork result");
      const id = nativeConversationId(object(response.thread, "forked thread").id);
      if (id === source) throw new ControlError("IDENTITY_MISMATCH", "thread/fork returned its source thread");
      return id;
    } catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "Codex refused to fork the thread");
      this.rpc.abort(errorFrom(error)); throw error;
    }
  }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    if (!attachments.some(item => item.kind !== "file")) return;
    const catalog = await this.models(), selected = catalog.models.find(row => row.id === (this.openedModel ?? catalog.defaultModel));
    checkInputs(attachments, selected?.inputs ?? { image: true, audio: false, file: true });
  }
  /**
   * The Hub's clear (decision log of 2026-11-11): `/clear`, `/new` and `/reset` alone are not sent. The thread is given up (what Codex still says of it
   * is counted and dropped); the next Turn opens a new thread marked `sessionStartSource: "clear"`, and the old one is then unsubscribed.
   */
  private clearRun(turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[]): ControlRun | null {
    const reading = typeof turn === "string" ? codexNativeClassify(turn, null, attachments.map(file => file.kind)) : null;
    if (reading === null || reading.kind !== "command" || reading.effect !== "clear") return null;
    this.host.release(this.conversation!); this.cleared = this.conversation;
    this.conversation = null; this.threadPath = null; this.threadTotal = null;
    return { result: (async () => { onEvent(clearedNotice(reading.name, "Codex")); return hubCleared(); })(),
      requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a clear the Hub runs itself has no native turn to stop")) };
  }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    const prompt = typeof turn === "string" ? turn : turn.user;
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "thread is not owned by this connection");
    if (this.threadGone) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "Codex closed this thread");
    if (this.active) throw new ControlError("INVALID_STATE", "a turn is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const cleared = this.clearRun(turn, onEvent, attachments);
    if (cleared !== null) return cleared;
    const clientId = typeof turn === "string" ? null : randomUUID();
    const invoked = SKILL_INPUT.exec(prompt), skill = invoked ? this.skills.get(invoked[1]!) : undefined;
    const words = skill ? invoked![2]?.trim() || "$" + skill.name : prompt, mentions = fileMentions(attachments.filter(file => file.kind === "file"));
    let text = words, packetId: RelayPacketId | null = null;
    const nothingSent = (result: BackendResult): ControlRun => ({ result: Promise.resolve(result), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent, so there is no native turn to stop")) });
    if (typeof turn !== "string") {
      const entries = relayEntries([...THREAD_COMMANDS, ...[...this.skills.keys()].map(name => ({ name: "skill:" + name, description: "", contextEffect: "keep" as const }))]);
      const reading = codexClassify(prompt, entries, attachments.map(file => file.kind));
      if (threadOperation(prompt, attachments.length > 0) !== null || !(reading.kind === "content" || reading.kind === "command" && reading.acceptsRelay === true && skill !== undefined)) return nothingSent(COMMAND_REFUSED);
      text = reading.kind === "content" ? singleText(turn) : bodyWithoutFirstLine(turn) + "\n\n" + words;
      packetId = turn.relay.packetId;
      if (exceedsInput([text + mentions], codexRelayCapabilities.placement)) { onEvent({ type: "diagnostic", message: "交接单没有发出：超过 Codex 的输入上限" }); return nothingSent(INPUT_LIMIT_REFUSED); }
    }
    let resolve!: (value: BackendResult) => void, reject!: (error: Error) => void;
    const result = new Promise<BackendResult>((res, rej) => { resolve = res; reject = rej; });
    let signalStarted!: () => void, rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((res, rej) => { signalStarted = res; rejectStarted = rej; });
    void started.catch(() => {});
    const run: Run = { onEvent, resolve, reject,
      timer: this.options.runTimeoutMs === undefined ? undefined : setTimeout(() => this.rpc.abort(new ControlError("RUN_TIMEOUT", "Codex turn exceeded its deadline")), this.options.runTimeoutMs),
      started, signalStarted, rejectStarted, primary: null, turns: new Set(), running: new Set(), primaryDone: false, outcome: null, settling: false, settled: false,
      streamed: new Set(), parts: new Map(), items: new Map(), reads: new Set(), agents: new Map(), usage: new TurnUsage(this.threadTotal), agentUsage: new Map(), context: undefined,
      inputRecorded: false, clientId, packetId, requests: [], stopping: false, stop: null, begun: false, wake: null, steers: new Map() };
    this.active = run;
    // Said once: the drift check's line, a reviewer Codex did not take, turns Codex ran by itself while no Turn of the Hub's was running.
    for (const note of this.notes.splice(0)) this.safeEmit(run, { type: "diagnostic", message: note });
    if (this.idleTurns > 0) { this.safeEmit(run, { type: "diagnostic", message: "上一轮结束后 Codex 自己又跑了 " + this.idleTurns + " 轮（例如目标自动续跑），那些内容没有记进对话。" }); this.idleTurns = 0; }
    const input = [{ type: "text", text: text + mentions, text_elements: [] }, ...(skill ? [{ type: "skill", name: skill.name, path: skill.path }] : []),
      ...attachments.flatMap(file => file.kind === "image" ? [{ type: "localImage", path: file.path }] : file.kind === "audio" ? [{ type: "localAudio", path: file.path }] : [])];
    const operation = threadOperation(prompt, attachments.length > 0);
    if (operation === "export") void this.exportThread(run, id);
    else if (operation === "compact") {
      void this.rpc.request("thread/compact/start", { threadId: id }).then(value => { if (Object.keys(object(value, "thread/compact/start result")).length) this.rpc.abort(new ControlError("INVALID_PROTOCOL", "compaction receipt must be empty")); }, (error: unknown) => {
        if (error instanceof ControlError && error.code === "REMOTE_ERROR" && run.primary === null && this.rpc.failure === null) { this.settle(run); run.resolve({ status: "failed", reason: "request_rejected", ...NOT_RECORDED }); }
        else this.rpc.abort(errorFrom(error));
      });
    } else {
      const mode = this.collaboration;
      void this.rpc.request("turn/start", { threadId: id, input, ...(clientId === null ? {} : { clientUserMessageId: clientId }), ...this.turnSettings,
        // A null developer_instructions keeps the mode's built-in instructions.
        ...(mode === null ? {} : { collaborationMode: { mode: mode.mode, settings: { model: mode.model, reasoning_effort: mode.effort, developer_instructions: null } } }) }).then(value => {
        try {
          const turnId = string(object(object(value, "turn/start result").turn, "Codex turn").id, "Codex turn identity");
          this.namePrimary(run, turnId);
          if (mode !== null) this.confirmedMode = mode.mode;
          run.signalStarted();
        } catch (error) { if (error instanceof ConsumerFailure) this.rpc.abort(errorFrom(error.original)); else this.failRun(run, errorFrom(error)); }
      }, (error: unknown) => {
        // turn/start refuses only before it records anything (an unknown thread, an input too large, a draining server).
        if (error instanceof ControlError && error.code === "REMOTE_ERROR" && run.primary === null && this.rpc.failure === null) { this.settle(run); run.resolve({ status: "failed", reason: "request_rejected", ...NOT_RECORDED }); }
        else this.rpc.abort(errorFrom(error));
      });
    }
    return { result, requestStop: () => {
      if (run.stop) return run.stop;
      if (run.settled || this.active !== run) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      run.stopping = true; this.cancelPermissions(run);
      run.stop = this.stopTurn(run, id);
      return run.stop;
    } };
  }
  /** The native turn that runs now for a Run: the latest of its turns Codex started and has not completed, else the one turn/start began. */
  private current(run: Run): string | null { return [...run.running].at(-1) ?? run.primary; }
  /**
   * HarnessControl.steer: `turn/steer {threadId, expectedTurnId, input, clientUserMessageId}` on the turn that runs now. Codex answers with the turn's
   * identity once it took the words (taken), and refuses when that turn is not the one that runs: nothing was taken then.
   */
  async steer(id: NativeConversationId, text: string): Promise<SteerOutcome> {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "thread is not owned by this connection");
    if (typeof text !== "string" || text.length === 0) throw new ControlError("INVALID_INPUT", "steering words must contain text");
    if (!this.has("steer")) return "not_taken";
    const run = this.active;
    if (run === null || run.settled || run.stopping || run.settling) return "not_taken";
    if (run.primary === null) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const named = await Promise.race([run.started.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.options.requestTimeoutMs); })]);
      clearTimeout(timer);
      if (!named) return "not_taken";
    }
    const turnId = this.current(run);
    if (run.settled || run.stopping || run.settling || this.active !== run || turnId === null) return "not_taken";
    const clientId = randomUUID();
    run.steers.set(clientId, false);
    try {
      const response = object(await this.rpc.request("turn/steer", { threadId: id, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: clientId },
        this.options.requestTimeoutMs, "reject"), "turn/steer result");
      if (response.turnId !== turnId) throw new ControlError("INVALID_PROTOCOL", "Codex steered a turn it was not asked to");
      return "taken";
    } catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) { run.steers.delete(clientId); return "not_taken"; }
      throw errorFrom(error);
    }
  }
  private async exportThread(run: Run, id: NativeConversationId): Promise<void> {
    let result: BackendResult;
    try {
      if (this.threadPath === null) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "this Codex thread has no rollout record");
      const info = await stat(this.threadPath);
      if (!info.isFile() || info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "the Codex rollout record is missing or exceeds 1 GiB");
      const data = await readFile(this.threadPath);
      if (this.active === run && !run.settled) this.emit(run, { type: "output", output: { kind: "content", name: "codex-" + id.replace(/[^A-Za-z0-9-]/gu, "") + ".jsonl", mediaType: "application/x-ndjson", data } });
      result = { status: "completed", reason: "exported", ...NOT_RECORDED };
    } catch (error) {
      if (error instanceof ConsumerFailure) { this.rpc.abort(errorFrom(error.original)); return; }
      const code = error instanceof ControlError ? error.code : "NATIVE_EXPORT_UNAVAILABLE";
      result = { status: "failed", reason: "export_failed", error: { code, message: code === "NATIVE_EXPORT_UNAVAILABLE" && error instanceof Error ? error.message : "Codex rollout record could not be read" }, ...NOT_RECORDED };
    }
    if (this.active === run && !run.settled) { this.settle(run); run.resolve(result); }
  }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); return this.rpc.close(); }
  /**
   * Interrupts the turn that runs now. Codex refuses an interrupt with -32600 "no active turn to interrupt" while it has not begun the turn (its hooks
   * run first) and after it ended: the stop asks again when Codex reports the turn (or a moment later), until it takes the interrupt or the turn ends.
   */
  private async stopTurn(run: Run, id: NativeConversationId): Promise<StopRequestReceipt> {
    await run.started;
    for (;;) {
      const turnId = this.current(run);
      if (run.settled || turnId === null) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
      try {
        const response = object(await this.rpc.request("turn/interrupt", { threadId: id, turnId }), "turn/interrupt result");
        if (Object.keys(response).length !== 0) throw new ControlError("INVALID_PROTOCOL", "interrupt receipt must be empty");
        return { requested: true };
      } catch (error) {
        if (!(error instanceof ControlError && error.code === "REMOTE_ERROR" && error.remoteCode === NO_ACTIVE_TURN_CODE && error.remoteMessage === NO_ACTIVE_TURN) || this.rpc.failure !== null) { this.rpc.abort(errorFrom(error)); throw error; }
        if (run.settled) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); run.wake = null; resolve(); }, timer = setTimeout(done, INTERRUPT_RETRY_MS);
        run.wake = done;
      });
      if (this.failure) throw this.failure;
    }
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }

  // ---- events ------------------------------------------------------------------------------------------------------------

  private live(): Run | null { return this.active !== null && !this.active.settled ? this.active : null; }
  /** Hands an event to the Run's consumer; a consumer that throws ends the connection (ConsumerFailure), as it always did. */
  private emit(run: Run, event: ControlEvent): void {
    try { run.onEvent(event); } catch (error) { throw new ConsumerFailure(error); }
  }
  /** The Run Codex's turn `turnId` belongs to: one of the live Run's turns; with `claim`, a turn not seen before is taken by it (the one it began, or one Codex began by itself). */
  private runOf(turnId: unknown, claim: boolean): Run | null {
    const run = this.live();
    if (run === null) return null;
    if (typeof turnId !== "string" || turnId === "") return claim ? null : run;
    if (run.turns.has(turnId)) { this.begin(run); return run; }
    if (!claim || this.turnIds.has(turnId)) return null;
    if (run.primary === null) this.namePrimary(run, turnId); else this.attach(run, turnId);
    this.begin(run);
    return run;
  }
  /** Codex reports the Run's turn: it takes an interrupt from now on, so a stop that waited asks again (F4). */
  private begin(run: Run): void { if (!run.begun) { run.begun = true; run.wake?.(); } }
  private namePrimary(run: Run, turnId: string): void {
    if (run.primary === turnId) return;
    if (run.primary !== null) {
      // turn/start named another turn than the first one Codex reported: that one began by itself, this one is the Run's own.
      if (run.settled) return;
      run.primaryDone = false;
    } else if (this.turnIds.has(turnId) && !run.turns.has(turnId)) throw new ControlError("DUPLICATE_TURN", "Codex reused a turn identity");
    run.primary = turnId; run.turns.add(turnId); this.turnIds.add(turnId); run.signalStarted();
  }
  private attach(run: Run, turnId: string): void {
    run.turns.add(turnId); this.turnIds.add(turnId);
    this.emit(run, { type: "activity", id: "turn:" + turnId.slice(0, 200), kind: "task", title: "Codex 接着做（自动续跑）", status: "running" });
  }
  private announced(thread: Row): void {
    const id = typeof thread.id === "string" ? thread.id : null;
    if (id !== null && this.opening && this.conversation === null) { this.conversation = nativeConversationId(id); this.host.own(id); }
  }
  private globalNotification(method: string, params: Row): void {
    const run = this.live();
    if (run === null) { this.host.count(); return; }
    if (this.notice(run, method, params)) return;
    if (PASSIVE.has(method) || method.startsWith("thread/realtime/") || method.startsWith("fuzzyFileSearch/") || method.startsWith("command/exec/") || method.startsWith("process/") || method.startsWith("externalAgentConfig/") || method.startsWith("windows")) return;
    this.emit(run, { type: "diagnostic", message: "Unsupported Codex notification: " + method.slice(0, 128) });
  }
  /** Notices Codex gives (errors with or without a retry, warnings, reroutes): said in the live Run. True when `method` is one. */
  private notice(run: Run, method: string, params: Row): boolean {
    if (method === "error") {
      const failure = turnFailure(record(params.error) ?? {});
      if (params.willRetry === true) this.emit(run, { type: "activity", id: "retry", kind: "retry", title: "模型请求重试", status: "running", detail: failure.message });
      else this.emit(run, { type: "notice", severity: "error", title: failure.message });
      return true;
    }
    if (method === "model/rerouted") { this.emit(run, { type: "notice", severity: "warning", title: "模型已由服务端改路由", detail: String(params.fromModel ?? "") + " → " + String(params.toModel ?? "") }); return true; }
    if (method === "warning" || method === "configWarning" || method === "deprecationNotice" || method === "guardianWarning" || method === "model/verification") {
      const message = typeof params.message === "string" ? params.message : typeof params.summary === "string" ? params.summary : "";
      if (message) this.emit(run, { type: "notice", severity: method === "deprecationNotice" ? "info" : "warning", title: line(message, 1024), ...(typeof params.details === "string" ? { detail: params.details } : {}) });
      return true;
    }
    return false;
  }
  /** A notification about the opened thread. Nothing it says ends the connection: what belongs to no Run is counted. */
  private ownNotification(method: string, params: Row): void {
    if (this.live() === null) this.host.count();
    switch (method) {
      case "turn/started": {
        const turnId = optional(record(params.turn)?.id);
        if (turnId === undefined) return;
        const run = this.live();
        if (run === null) { if (!this.turnIds.has(turnId)) { this.idleTurns++; this.turnIds.add(turnId); } return; }
        const owner = this.runOf(turnId, true);
        if (owner !== null) owner.running.add(turnId);
        return;
      }
      case "turn/completed": return this.turnCompleted(record(params.turn) ?? {});
      case "item/agentMessage/delta": {
        const run = this.runOf(params.turnId, true), itemId = optional(params.itemId);
        if (run === null || itemId === undefined || typeof params.delta !== "string") return;
        run.streamed.add(itemId);
        this.emit(run, { type: "text", text: params.delta, item: itemId }); return;
      }
      case "item/reasoning/summaryTextDelta": case "item/reasoning/textDelta": {
        const run = this.runOf(params.turnId, true), itemId = optional(params.itemId);
        if (run === null || itemId === undefined || typeof params.delta !== "string") return;
        // The summary of one reasoning item is one segment, its parts a blank line apart; its raw text (when Codex shows it) is another.
        const raw = method === "item/reasoning/textDelta", key = raw ? itemId + ":raw" : itemId, index = raw ? 0 : typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        const prior = run.parts.get(key);
        run.streamed.add(key); run.parts.set(key, index);
        this.emit(run, { type: "thinking", text: (prior !== undefined && prior !== index ? "\n\n" : "") + params.delta, item: key }); return;
      }
      case "item/started": case "item/completed": return this.item(method === "item/started", params);
      case "item/commandExecution/outputDelta": case "item/fileChange/patchUpdated": case "item/mcpToolCall/progress": {
        const run = this.runOf(params.turnId, true), itemId = optional(params.itemId), entry = itemId === undefined ? undefined : run?.items.get(itemId);
        if (run === null || entry === undefined) return;
        if (method === "item/commandExecution/outputDelta") { if (typeof params.delta === "string") entry.detail = { ...entry.detail, output: (entry.detail.output ?? "") + params.delta }; }
        else if (method === "item/fileChange/patchUpdated") { if (Array.isArray(params.changes)) { entry.changes = params.changes; entry.detail = { ...entry.detail, diff: params.changes.map(fileDiff).join("") }; } }
        else if (typeof params.message === "string") entry.detail = { ...entry.detail, output: params.message };
        entry.timer ??= setTimeout(() => { entry.timer = null; if (this.active === run && !run.settled) this.safeEmit(run, { type: "tool", id: itemId!, title: entry.title, status: entry.status, detail: entry.detail }); }, STREAM_MS);
        return;
      }
      case "turn/plan/updated": {
        // The to-do list of the live Run; one about a turn of an earlier Run is late.
        const run = this.live();
        if (run === null || !Array.isArray(params.plan) || typeof params.turnId === "string" && this.turnIds.has(params.turnId) && !run.turns.has(params.turnId)) return;
        this.emit(run, { type: "plan", entries: params.plan.slice(0, 256).map(value => { const step = record(value) ?? {}; return { content: typeof step.step === "string" ? step.step : "", status: step.status === "completed" ? "completed" as const : step.status === "inProgress" ? "in_progress" as const : "pending" as const }; }),
          ...(typeof params.explanation === "string" && params.explanation ? { explanation: params.explanation } : {}) });
        return;
      }
      case "thread/tokenUsage/updated": return this.usage(params);
      case "serverRequest/resolved": return this.withdraw(params.requestId);
      case "thread/closed": case "thread/deleted": {
        // Codex unloaded (or deleted) the thread: a Turn that runs on it ends, and this connection takes no more.
        this.threadGone = true;
        const run = this.live();
        if (run !== null) this.failRun(run, new ControlError("NATIVE_SESSION_NOT_FOUND", "Codex closed this thread"));
        return;
      }
      case "item/autoApprovalReview/started": case "item/autoApprovalReview/completed": {
        const run = this.runOf(params.turnId, false);
        if (run === null) return;
        const review = record(params.review), state = review?.status, done = method.endsWith("completed");
        const verdict = state === "approved" ? "已批准" : state === "denied" ? "已拒绝" : state === "timedOut" ? "超时" : state === "aborted" ? "已中止" : "";
        this.emit(run, { type: "activity", id: "auto-review:" + String(params.reviewId ?? params.targetItemId ?? "").slice(0, 200), kind: "review", title: "自动审查" + (verdict ? "：" + verdict : ""),
          status: !done ? "running" : state === "denied" || state === "timedOut" ? "failed" : state === "aborted" ? "cancelled" : "completed", ...(typeof review?.rationale === "string" && review.rationale ? { detail: review.rationale } : {}) });
        return;
      }
      default: {
        const run = this.live();
        if (run === null || this.notice(run, method, params) || PASSIVE.has(method)) return;
        this.emit(run, { type: "diagnostic", message: "Unsupported Codex notification: " + method.slice(0, 128) });
      }
    }
  }
  /** A turn of the thread completed: the Run that owns it ends with it once its own turn completed and nothing else of it runs. */
  private turnCompleted(turn: Row): void {
    const turnId = optional(turn.id);
    if (turnId === undefined) return;
    const run = this.runOf(turnId, true);
    if (run === null) return;
    run.running.delete(turnId);
    const recorded = run.inputRecorded ? { input: "recorded" as const } : {};
    let result: BackendResult;
    switch (turn.status) {
      case "completed": result = { status: "completed", reason: "completed", ...recorded }; break;
      case "interrupted": result = { status: "cancelled", reason: "interrupted", ...recorded }; break;
      case "failed": result = { status: "failed", reason: "failed", error: turnFailure(record(turn.error) ?? {}), ...recorded }; break;
      default: this.failRun(run, new ControlError("INVALID_PROTOCOL", "turn/completed contains a nonterminal status")); return;
    }
    if (turnId === run.primary) run.primaryDone = true;
    else this.emit(run, { type: "activity", id: "turn:" + turnId.slice(0, 200), kind: "task", title: "Codex 接着做（自动续跑）", status: turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "cancelled" : "failed" });
    run.outcome = result;
    if (!run.primaryDone || run.running.size > 0 || run.settling) return;
    run.settling = true;
    // The stop answers of requests still waiting are written before the result is given, so that a close right after it does not lose them.
    const finish = () => { if (run.settled) return; const outcome = run.outcome!; if (this.settle(run)) setImmediate(() => run.resolve(outcome)); else run.resolve(outcome); };
    if (run.reads.size) { void Promise.all([...run.reads]).then(finish); return; }
    finish();
  }
  private item(started: boolean, params: Row): void {
    const run = this.runOf(params.turnId, true), item = record(params.item), itemId = optional(item?.id), type = item?.type;
    if (run === null || item === null || itemId === undefined || typeof type !== "string") return;
    if (type === "agentMessage") {
      if (started) return;
      const said = typeof item.text === "string" ? item.text : "", questions = asyncQuestions(item, said);
      if (!run.streamed.has(itemId) && said) this.emit(run, { type: "text", text: said, item: itemId });
      if (questions) this.emit(run, { type: "text", text: questions, item: itemId });
      return;
    }
    // Plan mode answers with a proposed plan; the completed item is authoritative over its deltas.
    if (type === "plan") { if (!started && typeof item.text === "string") this.emit(run, { type: "text", text: item.text, item: itemId }); return; }
    if (type === "reasoning") {
      // A reasoning item that streamed nothing (its summary came whole) is said once it completes.
      const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n\n") : "";
      if (!started && summary && !run.streamed.has(itemId)) this.emit(run, { type: "thinking", text: summary, item: itemId });
      return;
    }
    if (type === "userMessage") {
      const echoed = echoedClientId(item);
      if (echoed !== null && run.steers.has(echoed)) { run.steers.set(echoed, true); return; }
      if (run.clientId !== null && echoed !== null && echoed !== run.clientId) return;
      if (!run.inputRecorded) {
        run.inputRecorded = true;
        const said = Array.isArray(item.content) ? item.content.map(inputText).join("\n") : "";
        this.emit(run, { type: "input_recorded", ...(run.packetId !== null && carriesPacket(said, run.packetId) ? { packetId: run.packetId } : {}) });
      }
      return;
    }
    if (type === "hookPrompt" || type === "functionCallOutput") return;
    if (type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds) && this.conversation !== null)
      for (const thread of item.receiverThreadIds.slice(0, 64)) if (typeof thread === "string" && thread && thread !== this.conversation) this.host.adopt(thread, this.conversation, true);
    if (type === "subAgentActivity") {
      const thread = optional(item.agentThreadId);
      if (thread !== undefined && this.conversation !== null && thread !== this.conversation) { this.host.adopt(thread, this.conversation, true); this.agent(run, thread, typeof item.agentPath === "string" ? { agentNickname: item.agentPath } : undefined); }
      const kind = item.kind, state = kind === "completed" ? "completed" : kind === "interrupted" ? "cancelled" : "running";
      this.emit(run, { type: "activity", id: thread ?? itemId, kind: "subagent", title: typeof item.agentPath === "string" ? item.agentPath : "子 Agent", status: state, ...(typeof item.model === "string" ? { detail: item.model } : {}) });
      return;
    }
    if (type === "contextCompaction") { this.emit(run, { type: "activity", id: itemId, kind: "compaction", title: "上下文压缩", status: started ? "running" : "completed" }); return; }
    if (type === "enteredReviewMode" || type === "exitedReviewMode") { this.emit(run, { type: "activity", id: "review", kind: "review", title: typeof item.review === "string" ? line(item.review, 1024) || "代码审查" : "代码审查", status: type === "enteredReviewMode" ? "running" : "completed" }); return; }
    const tool = itemTool(item);
    if (tool === null) { this.emit(run, { type: "tool", id: itemId, title: type, status: status(item.status, started) }); return; }
    const prior = run.items.get(itemId);
    if (prior?.timer) clearTimeout(prior.timer);
    const detail = { ...prior?.detail, ...tool.detail, ...(tool.detail.output === undefined && prior?.detail.output !== undefined ? { output: prior.detail.output } : {}) };
    const entry: ToolEntry = { title: tool.title, status: status(item.status, started), detail, timer: null, changes: Array.isArray(item.changes) ? item.changes : prior?.changes ?? [] };
    run.items.set(itemId, entry);
    this.emit(run, { type: "tool", id: itemId, title: entry.title, status: entry.status, detail });
    if (!started && type === "imageGeneration" && typeof item.savedPath === "string") {
      const read = this.generatedImage(run, item.savedPath); run.reads.add(read); void read.then(() => run.reads.delete(read));
    }
  }
  /** Token usage of the thread: the live Run's own turns add to its usage (T3 Code's delta-with-fallback); any other turn only moves the baseline. */
  private usage(params: Row): void {
    const usage = record(params.tokenUsage), total = tokens(usage?.total), last = tokens(usage?.last);
    if (total !== null) this.threadTotal = total;
    const run = this.live();
    if (run === null || total === null) return;
    if (typeof params.turnId !== "string" || !run.turns.has(params.turnId)) { run.usage.rebase(total); return; }
    run.usage.add(total, last);
    const window = typeof usage?.modelContextWindow === "number" && Number.isSafeInteger(usage.modelContextWindow) && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined;
    const raw = record(usage?.last), request = raw === null ? null : usageRequest(raw.inputTokens, raw.cachedInputTokens, raw.cacheWriteInputTokens);
    if (request !== null) run.requests.push(request);
    if (last !== null) run.context = { used: last.totalTokens, ...(window ? { size: window } : {}) };
    this.reportUsage(run);
  }
  /** The Turn's usage: the thread's and its sub-agents' together (each sub-agent thread from its own totals), the context the thread's own. */
  private reportUsage(run: Run): void {
    const value: NativeUsage = { turn: turnTokens([run.usage.value, ...[...run.agentUsage.values()].map(usage => usage.value)]), ...(run.context ? { context: run.context } : {}),
      ...(run.requests.length ? { requests: boundedRequests(run.requests) } : {}) };
    this.emit(run, { type: "usage", usage: value });
  }

  // ---- sub-agent threads ---------------------------------------------------------------------------------------------------

  /** The tool entry of a sub-agent thread, created when the thread is first seen; nested under its parent sub-agent, if any. */
  private agent(run: Run, thread: string, info?: Row): string {
    const id = "agent:" + thread.slice(0, 200);
    if (!run.agents.has(thread)) {
      const name = [info?.agentNickname, info?.agentRole].find(value => typeof value === "string" && value.trim()) as string | undefined;
      const parent = this.host.parentOf(thread);
      const entry = { title: "子 Agent · " + (name ? line(name, 120) : thread.slice(0, 8)), status: "in_progress",
        detail: { kind: "subagent", name: "codex-subagent", ...(parent !== null && parent !== this.conversation ? { parentId: "agent:" + parent.slice(0, 200) } : {}) } as NativeToolDetail };
      run.agents.set(thread, entry);
      this.emit(run, { type: "tool", id, title: entry.title, status: entry.status, detail: entry.detail });
    }
    return id;
  }
  /** A descendant thread's update: tool items nest under its entry, its last message is the entry's output, its usage is the Turn's too. */
  private childNotification(thread: string, method: string, params: Row): void {
    const run = this.live();
    if (run === null) { this.host.count(); return; }
    if (method === "thread/started") { this.agent(run, thread, record(params.thread) ?? undefined); return; }
    if (method === "thread/tokenUsage/updated") {
      const usage = record(params.tokenUsage), total = tokens(usage?.total);
      if (total === null) return;
      const own = run.agentUsage.get(thread) ?? new TurnUsage(null);
      run.agentUsage.set(thread, own); own.add(total, tokens(usage?.last)); this.reportUsage(run); return;
    }
    if (method !== "turn/started" && method !== "turn/completed" && method !== "item/started" && method !== "item/completed") return;
    const parentId = this.agent(run, thread), agent = run.agents.get(thread)!;
    const publish = () => this.emit(run, { type: "tool", id: parentId, title: agent.title, status: agent.status, detail: agent.detail });
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params.turn) ?? {};
      agent.status = method === "turn/started" ? "in_progress" : turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "cancelled" : "completed"; publish(); return;
    }
    const item = record(params.item), itemId = optional(item?.id), type = item?.type;
    if (item === null || itemId === undefined || typeof type !== "string") return;
    if (type === "agentMessage") { if (method === "item/completed" && typeof item.text === "string" && item.text.trim()) { agent.detail = { ...agent.detail, output: item.text }; publish(); } return; }
    const tool = ["userMessage", "reasoning", "plan", "hookPrompt", "functionCallOutput", "subAgentActivity", "contextCompaction"].includes(type) ? null : itemTool(item);
    if (tool === null) return;
    this.emit(run, { type: "tool", id: (thread.slice(0, 120) + "/" + itemId).slice(0, 256), title: tool.title, status: status(item.status, method === "item/started"), detail: { ...tool.detail, parentId } });
  }

  // ---- server requests -----------------------------------------------------------------------------------------------------

  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable");
    if (pending.validate) { try { pending.validate(option, input); } catch { throw new ControlError("INVALID_INPUT", "invalid native input answer"); } }
    this.pending.delete(id); pending.resolve({ option, ...(input === undefined ? {} : { input }) });
  }
  /** Ends the waits of a Run (all of them without one): each request gets its stop answer. */
  private cancelPermissions(run?: Run): boolean {
    let ended = false;
    for (const [id, pending] of this.pending) if (run === undefined || pending.run === run) { this.pending.delete(id); pending.resolve(STOPPED); ended = true; }
    return ended;
  }
  /** Codex resolved a request elsewhere (`serverRequest/resolved`: an interrupt, auto-review, another client): its prompt closes and nothing is answered. */
  private withdraw(requestId: unknown): void {
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    for (const [id, pending] of this.pending) {
      if (pending.rpc !== String(requestId)) continue;
      this.pending.delete(id); pending.resolve(WITHDRAWN);
      if (this.active === pending.run && !pending.run.settled) this.emit(pending.run, { type: "permission", id, decision: "cancelled" });
    }
  }
  private ask(run: Run, rpc: string, id: string, request: Omit<Extract<ControlEvent, { type: "permission_requested" }>, "type" | "id">, validate?: (option: string, input?: string) => void): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      this.pending.set(id, { rpc, run, options: request.options.map(option => option.id), ...(validate ? { validate } : {}), resolve });
      try { this.emit(run, { type: "permission_requested", id, ...request }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  /** Answers one server request about the opened thread (`owned`) or a sub-agent of it; the Run it belongs to is the live one. */
  private async serverRequest(owned: boolean, request: RpcRequest, params: Row): Promise<unknown> {
    const run = owned ? (params.turnId === null || params.turnId === undefined ? this.live() : this.runOf(params.turnId, true)) : this.live();
    if (run === null || run.settling) { this.host.count(); return this.unowned(request.method); }
    switch (request.method) {
      case "item/commandExecution/requestApproval": return this.approve(run, request, commandApproval(params, owned));
      case "item/fileChange/requestApproval": { const entry = typeof params.itemId === "string" ? run.items.get(params.itemId) : undefined; return this.approve(run, request, fileChangeApproval(params, owned, entry?.changes ?? [], entry?.detail.diff)); }
      case "item/permissions/requestApproval": return this.approve(run, request, permissionsApproval(params, owned));
      case "execCommandApproval": case "applyPatchApproval": return this.approve(run, request, legacyApproval(request.method, params, owned));
      case "mcpServer/elicitation/request": return this.elicit(run, request, params, owned);
      case "item/tool/requestUserInput": return this.userInput(run, request, params);
      default: return this.unowned(request.method);
    }
  }
  /** The answer to a request no Run decides; refusalOf, else the host's own (time, credentials it does not hold), else -32601 for a method Codex does not define. */
  private unowned(method: string): unknown {
    const answer = refusalOf(method);
    if (answer !== undefined) return answer;
    if (method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
  }
  /** One approval: the user decides when this connection asks (a public Run), else it is refused, and cancelled while the Turn stops. */
  private async approve(run: Run, request: RpcRequest, prompt: Prompt): Promise<unknown> {
    const id = String(request.id);
    if (!this.interactivePermissions || run.stopping) {
      this.emit(run, { type: "permission", id, decision: run.stopping ? "cancelled" : "denied" });
      return run.stopping ? prompt.cancel : prompt.refusal;
    }
    const answer = await this.ask(run, id, id, { title: prompt.title, ...(prompt.detail ? { detail: prompt.detail } : {}), options: prompt.choices, ...(prompt.forCall ? { forCall: prompt.forCall } : {}),
      ...(prompt.toolKind ? { toolKind: prompt.toolKind } : {}), ...requestExpiry(null) });
    if (answer === WITHDRAWN) return SKIP_REPLY;
    if (answer === STOPPED) return prompt.cancel;
    return prompt.answer(answer.option);
  }
  /** Questions asked one at a time; each answer is the question's value. Undefined when the user stopped (cancel), a refusal, or the request was withdrawn. */
  private async questions(run: Run, request: RpcRequest, questions: readonly Question[]): Promise<Record<string, unknown> | "cancel" | "decline" | typeof WITHDRAWN> {
    const values: Record<string, unknown> = {}, rpc = String(request.id);
    for (const [index, question] of questions.entries()) {
      if (!this.interactivePermissions || run.stopping || run.settled || this.active !== run) return "cancel";
      const answer = await this.ask(run, rpc, rpc + ":" + index, { title: question.title, ...(question.detail ? { detail: question.detail } : {}), options: question.choices,
        ...(question.input ? { input: question.input } : {}), kind: "question", ...requestExpiry(null) }, (option, input) => { question.value(option, input); });
      if (answer === WITHDRAWN) return WITHDRAWN;
      if (answer === STOPPED) return "cancel";
      const value = question.value(answer.option, answer.input);
      if (value === "cancel" || value === "decline") return value;
      values[question.id] = value.value;
    }
    return values;
  }
  private async userInput(run: Run, request: RpcRequest, params: Row): Promise<unknown> {
    const questions = userInputQuestions(params);
    if (questions === null) { this.emit(run, { type: "diagnostic", message: "Codex 的提问格式读不懂，已按未回答处理" }); return { answers: {} }; }
    const answered = await this.questions(run, request, questions);
    if (answered === WITHDRAWN) return SKIP_REPLY;
    if (answered === "cancel" || answered === "decline") return { answers: {} };
    return { answers: Object.fromEntries(Object.entries(answered).map(([id, value]) => [id, { answers: [String(value)] }])) };
  }
  /** An MCP server's elicitation (requests.ts elicitation): an approval, questions for a simple form, or a refusal the Run is told of. */
  private async elicit(run: Run, request: RpcRequest, params: Row, owned: boolean): Promise<unknown> {
    const plan = elicitation(params, owned);
    if (plan.kind === "decline") { this.emit(run, { type: "notice", severity: "warning", title: plan.notice }); return { action: "decline" }; }
    if (plan.kind === "approval") return this.approve(run, request, plan.prompt);
    if (!this.interactivePermissions || run.stopping) { this.emit(run, { type: "permission", id: String(request.id), decision: run.stopping ? "cancelled" : "denied" }); return { action: run.stopping ? "cancel" : "decline" }; }
    const answered = await this.questions(run, request, plan.questions);
    if (answered === WITHDRAWN) return SKIP_REPLY;
    if (answered === "cancel" || answered === "decline") return { action: answered };
    return plan.answer(answered);
  }
  /** A generated image file reported by the native turn becomes an output; only bounded regular image files are read. */
  private async generatedImage(run: Run, path: string): Promise<void> {
    try {
      const info = await stat(path), mediaType = /\.png$/iu.test(path) ? "image/png" : /\.jpe?g$/iu.test(path) ? "image/jpeg" : /\.webp$/iu.test(path) ? "image/webp" : null;
      if (!info.isFile() || info.size < 1 || info.size > MAX_CONTENT_BYTES || mediaType === null) return;
      const data = await readFile(path);
      if (this.active === run && !run.settled) this.safeEmit(run, { type: "output", output: { kind: "content", name: basename(path), mediaType, data } });
    } catch { if (this.active === run && !run.settled) this.safeEmit(run, { type: "diagnostic", message: "generated image could not be read" }); }
  }
  /** Emits from a timer or a read, where a consumer failure has no caller to reach: it ends the connection there. */
  private safeEmit(run: Run, event: ControlEvent): void {
    try { this.emit(run, event); } catch (error) { this.rpc.abort(errorFrom(error instanceof ConsumerFailure ? error.original : error)); }
  }
  /** Ends a Run; true when it had requests still waiting, whose stop answers are on their way to Codex. */
  private settle(run: Run): boolean {
    for (const [id, entry] of run.items) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; this.safeEmit(run, { type: "tool", id, title: entry.title, status: entry.status, detail: entry.detail }); }
    const waited = this.cancelPermissions(run);
    clearTimeout(run.timer); run.settled = true; run.signalStarted(); run.wake?.();
    if (this.active === run) this.active = null;
    return waited;
  }
  private failRun(run: Run, error: Error): void {
    if (run.settled) return;
    for (const entry of run.items.values()) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    this.cancelPermissions(run);
    clearTimeout(run.timer); run.settled = true; run.rejectStarted(error); run.reject(error); run.wake?.();
    if (this.active === run) this.active = null;
  }
}
