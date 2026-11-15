import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { forkSession, getSessionInfo, listSessions, renameSession, type CanUseTool, type Options, type PermissionResult, type PermissionUpdate, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { MAX_CONTENT_BYTES, type ContentKind, type ContentRef, type ControlAttachment } from "../../../contracts/content.js";
import { nativeConversationId, requestExpiry, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun,
  type HarnessControl, type NativeConversationId, type NativeExtensions, type NativeLimit, type NativeModelCatalog, type NativeOptions, type NativeSessionImport, type NativeSessionPage,
  type NativeToolDetail, type NativeUsage, type ProtocolObservation, type SteerOutcome, type StopRequestReceipt, type TurnText } from "../../../contracts/control.js";
import type { ChosenLevels } from "../../../contracts/flavor.js";
import type { RelayCapabilities, RelayPacketId } from "../../../contracts/relay.js";
import { TABLE_ENV, TABLE_LOAD_ENV, TABLE_MCP_NAME, TABLE_PROGRESS_ENV, TABLE_RECORD_ENV } from "../../../contracts/table.js";
import { checkInputs, fileMentions, readAttachment } from "../../../infrastructure/control/attachments.js";
import { ControlError, errorFrom } from "../../../infrastructure/control/json-rpc-process.js";
import { CLAUDE_EXPORT as EXPORT, claudeClassify, claudeListedEffect, claudeNativeClassify, relayDeclaration, relayEntries } from "../relay-classify.js";
import { carriesPacket, clearedNotice, COMMAND_REFUSED, hubCleared, measureBy, placeTurn, TITLE_DEADLINE_MS } from "../relay-turn.js";
import { checkCompat, type ClaudeCompat, type ClaudeFeature } from "./compat.js";
import { ClaudeProcess } from "./host.js";
import { catalogModels, findModel, MODE_OPTION, modelRows, settle, startMode, type ModelRow, type Settled } from "./levels.js";
import { addTotals, applyTaskTool, askedQuestions, firstError, lessTotals, limitsOf, line, modelFailure, modelTotals, record, requestUsage, TASK_TOOLS, text, todoPlan, toolCall,
  toolFamily, toolResult, turnUsage, UNCHECKED_PROMPT, type ModelTotals, type Row } from "./mapping.js";
import { chainCwd, chainHistory, cutPoint, promptId, readChain, SESSION_ID, transcriptPath } from "./transcript.js";

/**
 * Claude Code's relay declaration (ADR-055 §8.1, Claude Code row): two text blocks; live evidence from the CLI's own report that it took the prompt
 * into its history (the model request it started for it), and a completed turn proves it recorded; commands as Claude Code reads them; one process
 * per conversation; a native title, given when a new session's process starts (the SDK's `title`) or by `renameSession` once it holds a Turn.
 */
export const claudeRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "recorded_event", successProvesRecorded: true },
  execution: "process",
  commands: { classify: claudeClassify },
  placement: { parts: "multiple", maxInput: null, measure: measureBy("multiple", "chars", ["file"]) },
  title: "set",
});

/**
 * What a Claude Code session started by the Hub's own Claude Code must not inherit (T3 Code's list, Drivers/ClaudeHome.ts): a `claude` spawned with
 * them acts as part of that session. The entry point goes too, so that the SDK marks the Hub's sessions its own (`sdk-ts`, which the native
 * session list leaves out), and the ACP adapter's executable variable.
 */
const HOST_SESSION_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_DESKTOP_APP_VERSION", "CLAUDE_EFFORT", "CLAUDE_PID", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECUTABLE", "ELECTRON_RUN_AS_NODE"];
/** The approval choices: once, for the session (rules the session alone keeps), refuse (a sentence may go with it), refuse and stop the Turn. */
const CHOICES = [{ id: "allow", name: "允许一次" }, { id: "allow_session", name: "本次会话允许" }, { id: "deny", name: "拒绝" }, { id: "deny_stop", name: "拒绝并停止" }] as const;
const PLAN_CHOICES = [{ id: "approve", name: "批准，开始执行" }, { id: "keep", name: "拒绝，继续规划" }] as const;
const DENIED = "用户拒绝了这次调用。", STOPPED_WORDS = "用户停止了这一轮。";
const PLAN_KEPT = "用户想先看计划，暂时不要执行。停在这里，等用户的反馈或下一条指示。";
/** A command the Hub never sends: Claude Code's Remote Control would serve turns from claude.ai that belong to no Hub conversation. */
const REMOTE_CONTROL = "remote-control";
const REMOTE_CONTROL_REFUSED: BackendResult = { status: "failed", reason: "command_unavailable", input: "not_recorded",
  error: { code: "NATIVE_COMMAND_UNAVAILABLE", message: "/remote-control 没有发给 Claude Code：从 claude.ai 发来的回合不属于这段对话。" } };
const NOT_RECORDED = { input: "not_recorded" } as const;
const WITHDRAWN = Symbol("withdrawn"), STOPPED = Symbol("stopped");
type Answer = { readonly option: string; readonly input?: string } | typeof WITHDRAWN | typeof STOPPED;
interface Pending { readonly run: Run; readonly options: readonly string[]; readonly input: boolean; readonly resolve: (answer: Answer) => void }
interface ToolEntry { readonly name: string; readonly input: Row; readonly title: string; detail: NativeToolDetail }

/** One Hub Turn: the prompt it sent, every steer it gave, and each turn of Claude Code's that took them, until the last of those ends. */
interface Run {
  readonly onEvent: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly prompt: string;
  /** The identities whose turns are this Run's: its prompt, and each steer Claude Code took. */
  readonly uuids: Set<string>;
  readonly steers: Map<string, { readonly resolve: (outcome: SteerOutcome) => void; readonly reject: (error: Error) => void }>;
  readonly packetId: RelayPacketId | null;
  readonly command: boolean;
  begun: boolean;
  recorded: boolean;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  settled: boolean;
  keptPlan: boolean;
  modelError: string | null;
  message: string | null;
  readonly streamed: Set<string>;
  readonly tools: Map<string, ToolEntry>;
  readonly totals: Map<string, ModelTotals>;
  context: NativeUsage["context"] | undefined;
  readonly requests: NonNullable<NativeUsage["requests"]>[number][];
  compaction: string | null;
  compacting: boolean;
  boundaryDue: boolean;
  compactions: number;
}

/**
 * Claude Code through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, research of 2026-11-14), on the user's own `claude` and its own
 * login: the Hub never touches a credential, never writes the user's settings (the session's settings are the query's options and its flag
 * layer), and loads the user's settings, MCP servers, skills and CLAUDE.md as the CLI does. One process per conversation, started when the
 * conversation first needs it and kept between Turns while the Runtime keeps the connection; native ids never become public Session ids.
 */
export class ClaudeSdkControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = claudeRelayCapabilities;
  private executable: string | null = null;
  private compat: ClaudeCompat | null = null;
  private initialized = false;
  private failure: Error | null = null;
  private readonly env: Readonly<Record<string, string>>;
  private conversation: NativeConversationId | null = null;
  private cwd: string;
  /** The open session was opened new by this connection and holds nothing yet (no transcript). */
  private fresh = false;
  private model: string | undefined;
  private native: NativeOptions | undefined;
  private chosen: ChosenLevels;
  /** A rollback's resume point, taken by the next process this session starts (until a prompt of it is recorded). */
  private cut: string | null = null;
  private title: string | null = null;
  private proc: ClaudeProcess | null = null;
  private starting: Promise<ClaudeProcess> | null = null;
  private init: Row | null = null;
  private rows: readonly ModelRow[] = [];
  private settledNow: Settled = {};
  /** What Claude Code last said it runs (its system/init and status frames). */
  private reported: { model?: string; mode?: string; effort?: string | null } = {};
  private capabilities: ReadonlySet<string> | null = null;
  private commandNames: readonly string[] | null = null;
  private hubExport = false;
  private instructions: string | null = null;
  private progress: boolean | undefined;
  private interactive = false;
  private active: Run | null = null;
  private readonly pending = new Map<string, Pending>();
  private unattributed = 0;
  private idleTurns = 0;
  private readonly notes: string[] = [];
  /** The process's cumulative per-model totals at the latest result: what the next result's own numbers are told from. */
  private baseline = new Map<string, ModelTotals>();
  private readonly limits = new Map<string, NativeLimit>();
  private limitsChanged = false;
  private tasks = new Map<string, { content: string; status: "pending" | "in_progress" | "completed" }>();
  /** Whether each task Claude Code reported is shown (a foreground command is its tool call already). */
  private readonly taskShown = new Map<string, boolean>();

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "claude-agent-sdk") throw new ControlError("INVALID_INPUT", "the Claude driver requires a claude-agent-sdk launch");
    const env: Record<string, string> = { ...options.env, ...launch.env };
    for (const name of HOST_SESSION_VARIABLES) delete env[name];
    this.env = env; this.cwd = options.cwd;
    this.chosen = { ...(options.permission === undefined ? {} : { permission: options.permission }), ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.speed === undefined ? {} : { speed: options.speed }) };
  }
  get unattributedUpdates(): number { return this.unattributed; }
  get steering(): boolean { return this.has("steer"); }
  healthy(): boolean { return this.initialized && this.failure === null && (this.proc === null || this.proc.alive); }
  processGroup(): number | null { return this.proc?.processGroup ?? null; }
  diagnosticMark(): number { return this.proc?.stderrMark ?? 0; }
  diagnosticsSince(mark: number): string { return this.proc?.stderrSince(mark) ?? ""; }
  private has(feature: ClaudeFeature): boolean {
    if (this.compat?.off.has(feature) === true) return false;
    // The CLI's own word, once it said it (system/init `capabilities`): command lifecycles are what steers and recorded prompts are read by.
    return !(feature === "lifecycle" && this.capabilities !== null && !this.capabilities.has("msg_lifecycle_v1"));
  }

  async initialize(): Promise<ProtocolObservation> {
    if (this.failure) throw this.failure;
    if (!this.initialized) {
      try { this.executable = await realpath(this.launch.executable); }
      catch { throw new ControlError("NATIVE_DEPENDENCY_UNAVAILABLE", "the Claude Code executable is not there any more"); }
      this.compat = await checkCompat(this.executable, this.env);
      if (this.compat.diagnostic !== null) this.notes.push(this.compat.diagnostic);
      this.initialized = true;
    }
    const compat = this.compat!;
    return { protocol: "claude-agent-sdk", protocolVersion: null, agentName: "claude", agentVersion: compat.cli, authenticationMethods: [],
      capabilities: { ...(compat.sdk ? { sdk: compat.sdk } : {}), ...(compat.paired ? { pairedCli: compat.paired } : {}), ...(compat.off.size ? { featuresOff: [...compat.off] } : {}) } };
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private assertOwned(id: NativeConversationId): void {
    this.assertInitialized();
    if (this.conversation === null || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "session is not owned by this connection");
  }

  // ---- the catalog -----------------------------------------------------------------------------------------------------

  /** The initialize answer of this connection's session process, or of a probe that sends nothing (a connection with no session open). */
  private async initialization(): Promise<Row> {
    if (this.init !== null) return this.init;
    if (this.conversation !== null) { await this.ensureProcess(); return this.init!; }
    return this.probe(async () => this.init!);
  }
  /**
   * The session's process, or for a connection with no session a probe that sends nothing and keeps nothing (`persistSession: false`, the user's
   * hooks not run), closed after `use`. The user's MCP servers, skills and plugins load as they always do.
   */
  private async probe<T>(use: (proc: ClaudeProcess) => Promise<T>): Promise<T> {
    if (this.conversation !== null) return use(await this.ensureProcess());
    const probe = this.spawnProcess({ cwd: this.cwd, persistSession: false, settings: { disableAllHooks: true } });
    try {
      this.init = await this.timed(probe.ready, "NATIVE_INITIALIZE_TIMEOUT", "Claude Code did not answer its start in time"); this.rows = modelRows(this.init.models);
      return await use(probe);
    } finally { await probe.close().catch(() => {}); }
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const init = await this.initialization(), rows = modelRows(init.models);
    const listed = (Array.isArray(init.commands) ? init.commands : []).flatMap(value => {
      const row = record(value), name = text(row?.name);
      return name === undefined || name === REMOTE_CONTROL ? [] : [{ name, description: line(text(row?.description) ?? "", 1024) }];
    });
    this.listCommands(listed.map(command => command.name));
    const commands = (this.hubExport ? [...listed, EXPORT] : listed).map(command => ({ ...command, contextEffect: "contextEffect" in command ? command.contextEffect : claudeListedEffect(command.name) ?? "keep" as const }));
    const mode = text(init.current_permission_mode);
    return { models: catalogModels(rows), defaultModel: rows.some(row => row.value === "default") ? "default" : null, canSelect: rows.length > 0,
      options: [{ ...MODE_OPTION, ...(mode !== undefined && MODE_OPTION.values.some(value => value.value === mode) ? { currentValue: mode } : {}) }], commands,
      authentication: signedIn(init.account), inputs: { image: true, audio: false, file: true } };
  }
  /** The commands Claude Code lists (its catalog, or its latest commands_changed), and the Hub's own `/export` where it lists none (the CLI has none on the SDK's lane). */
  private listCommands(names: readonly string[]): void {
    this.hubExport = !names.includes(EXPORT.name);
    this.commandNames = this.hubExport ? [...names, EXPORT.name] : names;
  }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return claudeNativeClassify(text, catalog, attachments); }
  async extensions(): Promise<NativeExtensions> {
    this.assertInitialized();
    return this.probe(async proc => {
      const [status, commands] = await Promise.all([proc.query.mcpServerStatus(), proc.query.supportedCommands()]);
      // Skills and the user's own commands are what Claude Code lists beside its built-in ones; it says nothing of plugins here.
      return { skills: commands.filter(command => command.builtin !== true && command.name !== REMOTE_CONTROL).map(command => ({ name: command.name, description: line(command.description ?? "", 1024), enabled: true, command: command.name })),
        mcpServers: status.map(server => ({ name: server.name, status: server.status, tools: server.tools?.length ?? 0, failed: server.status === "failed" })), plugins: [] };
    });
  }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> { this.assertInitialized(); checkInputs(attachments, { image: true, audio: false, file: true }); }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    if (this.proc === null) return null;
    const model = this.reported.model === undefined ? null : findModel(this.rows, this.reported.model)?.value ?? null;
    const effort = this.reported.effort ?? this.settledNow.effort, mode = this.reported.mode ?? this.settledNow.mode;
    return { model, options: { ...(mode ? { mode } : {}), ...(effort ? { effort } : {}) } };
  }

  // ---- the session -----------------------------------------------------------------------------------------------------

  checkpoint(): Promise<string | null> {
    // A rollback not yet taken by a Turn goes with the reference, so that a process started anew resumes at it.
    return Promise.resolve(this.conversation === null ? null : this.cut === null ? this.conversation : this.conversation + "#" + this.cut);
  }
  /**
   * Opens the conversation's session: new (an identity the Hub picks, so it is known before any prompt), or the one behind `checkpoint`, which
   * must have a transcript (a session never prompted has none: NATIVE_SESSION_NOT_FOUND, which the Runtime reads as an empty one). The process
   * starts when the session first needs it, with the selection resolved on the model's catalog then.
   */
  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation !== null || this.proc !== null) throw new ControlError("INVALID_STATE", "this connection already owns a session");
    this.cwd = cwd; this.model = model; this.native = native; this.title = null;
    if (checkpoint === undefined) { this.conversation = nativeConversationId(promptId()); this.fresh = true; this.cut = null; return this.conversation; }
    const [id, cut] = splitCheckpoint(checkpoint);
    if (await transcriptPath(this.env, id, cwd) === null) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "Claude Code has no session with this identity");
    this.conversation = nativeConversationId(id); this.fresh = false; this.cut = cut;
    return this.conversation;
  }
  private levels(): ChosenLevels { return this.chosen; }
  /** The process this session runs on, started now when it has none (or its last one ended). */
  private async ensureProcess(): Promise<ClaudeProcess> {
    if (this.proc?.alive === true && this.starting === null) return this.proc;
    if (this.starting !== null) return this.starting;
    if (this.proc !== null) await this.releaseProcess();
    this.starting = this.startProcess().finally(() => { this.starting = null; });
    return this.starting;
  }
  private spawnProcess(extra: Omit<Options, "spawnClaudeCodeProcess">, onMessage?: (proc: ClaudeProcess, message: Row) => void): ClaudeProcess {
    const proc: ClaudeProcess = new ClaudeProcess({ pathToClaudeCodeExecutable: this.executable!, env: { ...this.env }, includePartialMessages: true, promptSuggestions: false, ...extra },
      this.options.closeGraceMs, { message: message => onMessage?.(proc, message), ended: error => { if (onMessage !== undefined) this.processEnded(proc, error); } });
    return proc;
  }
  private timed<T>(promise: Promise<T>, code: string, message: string): Promise<T> {
    const ms = this.options.startupTimeoutMs ?? this.options.requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ControlError(code, message)), ms); })]).finally(() => clearTimeout(timer));
  }
  private async startProcess(): Promise<ClaudeProcess> {
    const id = this.conversation!, resumed = !this.fresh, levels = this.levels();
    const mode = startMode(this.options.flavor, this.native, levels, resumed), server = this.hubToolServer();
    const options: Omit<Options, "spawnClaudeCodeProcess"> = {
      cwd: this.cwd, canUseTool: this.canUseTool, allowDangerouslySkipPermissions: true,
      ...(resumed ? { resume: id, ...(this.cut === null ? {} : { resumeSessionAt: this.cut }) } : { sessionId: id, ...(this.title === null ? {} : { title: this.title }) }),
      ...(this.model === undefined ? {} : { model: this.model }), ...(mode === undefined ? {} : { permissionMode: mode }),
      // Thinking as summaries (the SDK otherwise omits its text), for this process alone.
      thinking: { type: "adaptive", display: "summarized" },
      ...(this.instructions !== null && this.options.entry?.instructions === "sdk-append" ? { systemPrompt: { type: "preset", preset: "claude_code", append: this.instructions } } : {}),
      ...(server === null ? {} : { mcpServers: { [TABLE_MCP_NAME]: server } }),
    };
    const proc = this.spawnProcess(options, (owner, message) => { if (this.proc === owner) this.onMessage(message); });
    this.proc = proc; this.baseline = new Map(); this.reported = {};
    try {
      const init = await this.timed(proc.ready, "NATIVE_INITIALIZE_TIMEOUT", "Claude Code did not answer its start in time");
      this.init = init; this.rows = modelRows(init.models);
      const row = this.model === undefined ? findModel(this.rows, "default") : findModel(this.rows, this.model);
      if (this.model !== undefined && row === undefined) throw new ControlError("MODEL_UNAVAILABLE", "selected model is not in this Harness native catalog");
      const settled = settle(this.options.flavor, row, this.native, levels, resumed);
      await this.applySettled(proc, settled, mode);
      return proc;
    } catch (error) {
      if (this.proc === proc) this.proc = null;
      await proc.close().catch(() => {});
      throw error;
    }
  }
  /** The flag layer and the mode a selection comes to, on a running process: effort and fast mode by applyFlagSettings, the mode by setPermissionMode. */
  private async applySettled(proc: ClaudeProcess, settled: Settled, startedMode: string | undefined): Promise<void> {
    if (settled.effort !== undefined || settled.fast !== undefined)
      await proc.query.applyFlagSettings({ ...(settled.effort === undefined ? {} : { effortLevel: settled.effort as "low" }), ...(settled.fast === undefined ? {} : { fastMode: settled.fast }) });
    if (settled.mode !== undefined && settled.mode !== startedMode) await proc.query.setPermissionMode(settled.mode);
    this.settledNow = settled;
  }
  /**
   * HarnessControl.reconfigure: the model with setModel, effort and fast mode in the session's flag layer, the permission mode with setPermissionMode,
   * on the running process (research §3: no new process); with no process yet, what it will start with.
   */
  async reconfigure(id: NativeConversationId, model: string | undefined, native: NativeOptions | undefined, levels?: ChosenLevels): Promise<void> {
    this.assertOwned(id);
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a turn is running");
    const chosen = levels ?? this.chosen;
    if (this.proc?.alive !== true) { this.model = model; this.native = native; this.chosen = chosen; return; }
    const proc = this.proc, row = model === undefined ? findModel(this.rows, "default") : findModel(this.rows, model);
    if (model !== undefined && row === undefined) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "selected model is not in this Harness native catalog");
    const settled = settle(this.options.flavor, row, native, chosen, true);
    if (model !== this.model) await proc.query.setModel(model);
    await this.applySettled(proc, settled, this.reported.mode ?? this.settledNow.mode);
    this.model = model; this.native = native; this.chosen = chosen;
  }
  /**
   * Names the session on Claude Code's side: a new session's process takes the title when it starts (the SDK's `title`, which also spares Claude
   * Code its own naming request); a session that holds a Turn is renamed (`renameSession`). A new session whose process started already cannot be
   * named before its first prompt: NATIVE_TITLE_UNAVAILABLE.
   */
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    this.assertOwned(id);
    const name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 200).join("").trim();
    if (!name) return;
    if (this.fresh && this.proc === null && this.starting === null) { this.title = name; return; }
    if (this.fresh) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "Claude Code names a new session only when it starts");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([renameSession(id, name, { dir: this.cwd }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("late")), TITLE_DEADLINE_MS); })]); }
    catch { throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "Claude Code did not name the session"); }
    finally { clearTimeout(timer); }
  }
  /** HarnessControl.setSessionInstructions: the SDK's `systemPrompt` preset with the Hub's text appended (Claude Code's own prompt kept). */
  setSessionInstructions(text: string | null, tools?: { readonly progress: boolean }): void { this.instructions = text; this.progress = tools?.progress; }
  /**
   * The Hub's tool server as the session's own stdio MCP server (the SDK's `mcpServers`, which reaches the CLI as `--mcp-config`): the table's
   * address and token are not in it; Claude Code's MCP servers inherit them from its environment, which the Hub started it with (TableMount).
   * Only what is not secret is given: how the record is read and the tools loaded, whether the task list and the wrap-up are asked for.
   */
  private hubToolServer(): { readonly type: "stdio"; readonly command: string; readonly args: string[]; readonly env: Record<string, string> } | null {
    if (this.options.entry?.tools !== "sdk") return null;
    const tool = fileURLToPath(new URL("../../../cli/hub-tools.js", import.meta.url));
    if (!this.env[TABLE_ENV.url] || !this.env[TABLE_ENV.session] || !existsSync(tool)) return null;
    const env: Record<string, string> = {};
    for (const name of [TABLE_RECORD_ENV, TABLE_LOAD_ENV]) if (this.env[name]) env[name] = this.env[name]!;
    if (this.progress === false) env[TABLE_PROGRESS_ENV] = "off";
    return { type: "stdio", command: process.execPath, args: [tool, "mcp"], env };
  }
  get sessionTools(): boolean { return this.hubToolServer() !== null; }
  /** Ends the session's process (its transcript stays); the next Turn starts another, resumed. */
  private async releaseProcess(): Promise<CleanupEvidence | null> {
    const proc = this.proc;
    if (proc === null) return null;
    this.proc = null;
    return proc.close();
  }
  private processEnded(proc: ClaudeProcess, error: Error | null): void {
    if (this.proc !== proc) return;
    const run = this.live();
    if (run !== null) this.failRun(run, error ?? new ControlError("PROCESS_EXITED", "Claude Code ended its session process"));
    for (const [id, pending] of this.pending) { this.pending.delete(id); pending.resolve(STOPPED); }
  }

  /** The Hub's clear: nothing is sent; the session is given up (its transcript stays, Claude Code can still resume it) and the next Turn opens a new one. */
  private clearRun(name: string, onEvent: (event: ControlEvent) => void): ControlRun {
    this.conversation = null; this.fresh = false; this.cut = null; this.title = null;
    void this.releaseProcess().catch(() => {});
    return { result: (async () => { onEvent(clearedNotice(name, "Claude Code")); return hubCleared(); })(),
      requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a clear the Hub runs itself has no native turn to stop")) };
  }
  private nothingSent(result: BackendResult): ControlRun {
    return { result: Promise.resolve(result), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent, so there is no native turn to stop")) };
  }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    this.assertOwned(id);
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a turn is already active");
    const words = typeof turn === "string" ? turn : turn.user, kinds = attachments.map(file => file.kind);
    if (typeof words !== "string" || words.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    // A relay Turn whose words read as a command (or may, before the catalog is known) is refused before anything below runs, the clear and the export included.
    const listed = () => this.commandNames === null ? null : relayEntries(this.commandNames.map(name => ({ name, description: "", contextEffect: claudeListedEffect(name) ?? "keep" })));
    if (typeof turn !== "string" && claudeClassify(words, listed(), kinds).kind !== "content") return this.nothingSent(COMMAND_REFUSED);
    // The reading before anything starts (the catalog of the running process when there is one): the Hub's clear, its export, the refused command.
    let reading = claudeNativeClassify(words, this.commandNames === null ? null : { models: [], defaultModel: null, authentication: "unknown", canSelect: false, commands: this.commandNames.map(name => ({ name, description: "" })) }, kinds);
    if (reading.kind === "command" && reading.effect === "clear") return this.clearRun(reading.name, onEvent);
    if (reading.kind === "possible_command" || reading.kind === "command") {
      if (reading.name === REMOTE_CONTROL) return this.nothingSent(REMOTE_CONTROL_REFUSED);
      if (reading.name === EXPORT.name && reading.kind === "command" && reading.args === "" && this.hubExport) return { result: this.exportTranscript(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    }
    let proc: ClaudeProcess;
    try { proc = await this.ensureProcess(); }
    catch (error) {
      const failure = errorFrom(error);
      return this.nothingSent({ status: "failed", reason: "start_failed", error: { code: failure instanceof ControlError ? failure.code : "NATIVE_START_FAILED", message: failure.message }, ...NOT_RECORDED });
    }
    if (reading.kind === "possible_command") { await this.models().catch(() => null); reading = this.classify(words, { models: [], defaultModel: null, authentication: "unknown", canSelect: false, commands: (this.commandNames ?? []).map(name => ({ name, description: "" })) }, kinds); }
    if (reading.kind === "command" && reading.name === EXPORT.name && reading.args === "" && this.hubExport) return { result: this.exportTranscript(id, onEvent), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "an export has no native turn to stop")) };
    let parts: readonly string[] = [words], packetId: RelayPacketId | null = null;
    if (typeof turn !== "string") {
      if (claudeClassify(words, listed() ?? [], kinds).kind !== "content") return this.nothingSent(COMMAND_REFUSED);
      parts = placeTurn(turn, claudeRelayCapabilities.placement); packetId = turn.relay.packetId;
    }
    // Text first, then images, then the files' pointers: Claude Code looks for a command only in the last block, so with an attachment the input is content (claudeReadsSlash).
    const content: Record<string, unknown>[] = parts.map(part => ({ type: "text", text: part }));
    try {
      for (const file of attachments) if (file.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: file.mediaType, data: (await readAttachment(file)).toString("base64") } });
    } catch (error) { const failure = errorFrom(error); return this.nothingSent({ status: "failed", reason: "attachment_failed", error: { code: failure instanceof ControlError ? failure.code : "ATTACHMENT_UNREADABLE", message: failure.message }, ...NOT_RECORDED }); }
    const mentions = fileMentions(attachments.filter(file => file.kind === "file"));
    if (mentions) content.push({ type: "text", text: mentions.trim() });
    let resolve!: (value: BackendResult) => void, reject!: (error: Error) => void;
    const result = new Promise<BackendResult>((res, rej) => { resolve = res; reject = rej; });
    const uuid = promptId();
    const run: Run = { onEvent, resolve, reject, prompt: uuid, uuids: new Set([uuid]), steers: new Map(), packetId: packetId !== null && parts.some(part => carriesPacket(part, packetId!)) ? packetId : null,
      command: reading.kind === "command", begun: !this.has("lifecycle"), recorded: false, stopping: false, stop: null, settled: false, keptPlan: false, modelError: null, message: null,
      streamed: new Set(), tools: new Map(), totals: new Map(), context: undefined, requests: [], compaction: null, compacting: false, boundaryDue: false, compactions: 0 };
    this.active = run;
    for (const note of this.notes.splice(0)) this.safeEmit(run, { type: "diagnostic", message: note });
    if (this.idleTurns > 0) { this.safeEmit(run, { type: "diagnostic", message: "上一轮结束后 Claude Code 自己又跑了 " + this.idleTurns + " 轮（例如后台任务完成后的续跑），那些内容没有记进对话。" }); this.idleTurns = 0; }
    if (this.limitsChanged && this.limits.size) { this.limitsChanged = false; this.safeEmit(run, { type: "limits", limits: [...this.limits.values()] }); }
    try { proc.send({ type: "user", message: { role: "user", content: content as never }, parent_tool_use_id: null, uuid: uuid as NonNullable<SDKUserMessage["uuid"]> }); }
    catch (error) { this.active = null; run.settled = true; return this.nothingSent({ status: "failed", reason: "send_failed", error: { code: "NATIVE_SEND_FAILED", message: errorFrom(error).message }, ...NOT_RECORDED }); }
    if (this.fresh) this.fresh = false;
    return { result, requestStop: () => {
      if (run.stop) return run.stop;
      if (run.settled || this.active !== run) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      run.stopping = true; this.cancelPermissions(run);
      run.stop = proc.query.interrupt().then(() => ({ requested: true as const }), (error: unknown) => { throw errorFrom(error); });
      return run.stop;
    } };
  }
  /**
   * HarnessControl.steer: the words as a user message of priority `next` from a person (`origin: human`), which Claude Code reads in the turn that
   * runs as soon as the tools it runs finish. Taken once Claude Code reports it started them (its command lifecycle) or a result of the Run
   * names them; a turn that ended first makes them a turn of their own, which is still this Run's (it lasts until that one ends too).
   */
  async steer(id: NativeConversationId, words: string): Promise<SteerOutcome> {
    this.assertOwned(id);
    if (typeof words !== "string" || words.length === 0) throw new ControlError("INVALID_INPUT", "steering words must contain text");
    const run = this.active;
    if (!this.has("steer") || run === null || run.settled || run.stopping || run.command || this.proc?.alive !== true) return "not_taken";
    const uuid = randomUUID();
    return new Promise<SteerOutcome>((resolve, reject) => {
      run.steers.set(uuid, { resolve, reject });
      try { this.proc!.send({ type: "user", message: { role: "user", content: [{ type: "text", text: words }] }, parent_tool_use_id: null, uuid: uuid as NonNullable<SDKUserMessage["uuid"]>, priority: "next", origin: { kind: "human" } }); }
      catch { run.steers.delete(uuid); resolve("not_taken"); }
    });
  }
  /**
   * HarnessControl.rollback: the last `turns` of the Hub's Turns go from Claude Code's history, their answers with them: the next process this session
   * starts resumes at the entry before the earliest of them (`resumeSessionAt`, on Claude Code's headless lane), which starts a branch of the
   * transcript; nothing is deleted. A running process holds the history as it was, so it is closed now. Refused while a Turn runs.
   */
  async rollback(id: NativeConversationId, turns: number): Promise<void> {
    this.assertOwned(id);
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a turn is running");
    if (!this.has("rollback")) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "这个 Claude Code 版本不能按轮回退。");
    const path = await transcriptPath(this.env, id, this.cwd);
    if (path === null) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "Claude Code 还没有这个会话的记录。");
    let chain = await readChain(path);
    if (this.cut !== null) { const at = chain.findIndex(entry => entry.uuid === this.cut); if (at >= 0) chain = chain.slice(0, at + 1); }
    const cut = cutPoint(chain, turns);
    await this.releaseProcess();
    this.cut = cut; this.fresh = false;
  }
  /** Copies the session behind `checkpoint` (to its rollback point, when it has one) with `forkSession`; the source stays as it was. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    this.assertInitialized();
    if (this.conversation !== null) throw new ControlError("INVALID_STATE", "a fork needs its own connection");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    this.sameConfigDir("NATIVE_FORK_UNAVAILABLE");
    const [id, cut] = splitCheckpoint(checkpoint);
    if (await transcriptPath(this.env, id, cwd) === null) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "Claude Code has no transcript of this session");
    try { const forked = await forkSession(id, { dir: cwd, ...(cut === null ? {} : { upToMessageId: cut }) }); return nativeConversationId(forked.sessionId); }
    catch (error) { if (error instanceof ControlError) throw error; throw new ControlError("NATIVE_FORK_UNAVAILABLE", "Claude Code could not copy the session"); }
  }
  /** The SDK's session helpers run in this process and read its CLAUDE_CONFIG_DIR: one the Harness's process is not given would read another home. */
  private sameConfigDir(code = "NATIVE_SESSION_LIST_UNAVAILABLE"): void {
    if ((this.env.CLAUDE_CONFIG_DIR ?? "") !== (process.env.CLAUDE_CONFIG_DIR ?? "")) throw new ControlError(code, "this Claude Code runs on another configuration directory");
  }
  /** This workspace's sessions the user had with Claude Code (listSessions without the programmatic ones, the Hub's among them), newest first. */
  async nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    this.sameConfigDir();
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10), limit = 50;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ControlError("INVALID_INPUT", "invalid session cursor");
    const listed = await listSessions({ dir: cwd, limit, offset, includeWorktrees: false, includeProgrammatic: false });
    const sessions = listed.filter(session => (session.cwd === undefined || session.cwd === cwd) && session.archived !== true && SESSION_ID.test(session.sessionId))
      .map(session => ({ id: session.sessionId, title: text(session.customTitle) ?? text(session.summary) ?? null, updatedAt: Number.isSafeInteger(session.lastModified) ? session.lastModified : null, source: "cli" }));
    return { sessions, nextCursor: listed.length === limit ? String(offset + limit) : null };
  }
  /** Reads one of this workspace's sessions for continuing it: its transcript's chain as words and answers; nothing is resumed or sent. */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    this.assertInitialized();
    const path = await transcriptPath(this.env, id, cwd);
    if (path === null) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "Claude Code has no session with this identity");
    const chain = await readChain(path), made = chainCwd(chain);
    if (made !== null && made !== cwd) throw new ControlError("NATIVE_SESSION_WORKSPACE_MISMATCH", "the session belongs to another workspace");
    const info = await getSessionInfo(id, { dir: cwd }).catch(() => undefined);
    return { checkpoint: id, title: text(info?.customTitle) ?? text(info?.summary) ?? null, history: chainHistory(chain), omitted: 0, complete: true, historyRead: true };
  }
  private async exportTranscript(id: NativeConversationId, onEvent: (event: ControlEvent) => void): Promise<BackendResult> {
    try {
      const path = await transcriptPath(this.env, id, this.cwd);
      if (path === null) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "Claude Code has no transcript for this session");
      const info = await stat(path);
      if (info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "the Claude Code transcript is empty or exceeds 1 GiB");
      onEvent({ type: "output", output: { kind: "content", name: "claude-" + id + ".jsonl", mediaType: "application/x-ndjson", data: await readFile(path) } });
      return { status: "completed", reason: "exported", ...NOT_RECORDED };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "NATIVE_EXPORT_UNAVAILABLE";
      return { status: "failed", reason: "export_failed", error: { code, message: error instanceof ControlError ? error.message : "the Claude Code transcript could not be read" }, ...NOT_RECORDED };
    }
  }
  async close(): Promise<CleanupEvidence> {
    this.cancelPermissions();
    const run = this.live();
    const evidence = await this.releaseProcess();
    if (run !== null) this.failRun(run, new ControlError("CLOSED", "connection closed by its owner"));
    return evidence ?? { closed: true, exitCode: null, signal: null, protocolFailure: null };
  }

  // ---- messages --------------------------------------------------------------------------------------------------------

  private live(): Run | null { return this.active !== null && !this.active.settled ? this.active : null; }
  private emit(run: Run, event: ControlEvent): void { run.onEvent(event); }
  /** Emits where a consumer failure has no caller to reach: it ends the Run. */
  private safeEmit(run: Run, event: ControlEvent): void { try { this.emit(run, event); } catch (error) { this.failRun(run, errorFrom(error)); } }
  /** The identities a frame says it answers (user_message_uuid(s)); undefined when it says none. */
  private stamped(message: Row): readonly string[] | undefined {
    if (Array.isArray(message.user_message_uuids)) return message.user_message_uuids.filter((value): value is string => typeof value === "string");
    return typeof message.user_message_uuid === "string" ? [message.user_message_uuid] : undefined;
  }
  /** The Run a frame belongs to: the live one when the frame names one of its identities, or names none once its prompt started. */
  private runOf(message: Row): Run | null {
    const run = this.live();
    if (run === null) return null;
    const stamped = this.stamped(message);
    if (stamped === undefined) return run.begun ? run : null;
    return stamped.some(uuid => run.uuids.has(uuid) || run.steers.has(uuid)) ? run : null;
  }
  private recorded(run: Run): void {
    if (run.recorded || run.command) return;
    run.recorded = true; this.cut = null;
    this.emit(run, { type: "input_recorded", ...(run.packetId === null ? {} : { packetId: run.packetId }) });
  }
  private onMessage(message: Row): void {
    const run = this.live();
    try { this.dispatch(message, run); }
    catch (error) { if (run !== null) this.failRun(run, errorFrom(error)); }
  }
  private dispatch(message: Row, live: Run | null): void {
    switch (message.type) {
      case "command_lifecycle": return this.lifecycle(message, live);
      case "system": return this.system(message);
      case "stream_event": { const run = this.runOf(message); if (run !== null && message.parent_tool_use_id == null) this.partial(run, message); return; }
      case "assistant": { const run = this.runOf(message); if (run !== null) this.assistant(run, message); else if (live === null) this.unattributed++; return; }
      case "user": { const run = this.runOf(message); if (run !== null) this.toolResults(run, message); return; }
      case "result": return this.result(message);
      case "rate_limit_event": return this.rateLimits(message);
      case "auth_status": {
        const run = this.live();
        if (run !== null && typeof message.error === "string" && message.error) this.emit(run, { type: "notice", severity: "error", title: "Claude Code 的登录出了问题：在终端运行 claude auth login 后再试。" });
        return;
      }
      default: return;
    }
  }
  private lifecycle(message: Row, live: Run | null): void {
    const uuid = message.command_uuid, state = message.state;
    if (live === null || typeof uuid !== "string") return;
    if (uuid === live.prompt && state === "started") { live.begun = true; return; }
    const steer = live.steers.get(uuid);
    if (steer !== undefined && (state === "started" || state === "completed")) { live.steers.delete(uuid); live.uuids.add(uuid); steer.resolve("taken"); return; }
    if (steer !== undefined && state === "cancelled") { live.steers.delete(uuid); steer.reject(new ControlError("STEER_UNKNOWN", "Claude Code dropped the words")); }
  }
  private system(message: Row): void {
    const run = this.runOf(message) ?? (this.stamped(message) === undefined ? this.live() : null);
    switch (message.subtype) {
      case "init": {
        if (typeof message.model === "string") this.reported.model = message.model;
        if (typeof message.permissionMode === "string") this.reported.mode = message.permissionMode;
        if (message.effort === null || typeof message.effort === "string") this.reported.effort = message.effort;
        if (Array.isArray(message.capabilities)) this.capabilities = new Set(message.capabilities.filter((value): value is string => typeof value === "string"));
        return;
      }
      case "status": {
        if (typeof message.permissionMode === "string") this.reported.mode = message.permissionMode;
        if (run === null) return;
        if (message.status === "requesting" && this.stamped(message)?.includes(run.prompt)) this.recorded(run);
        // One compaction is one activity: its start (compacting), its result, and the boundary Claude Code writes after it (with the token counts).
        if (message.status === "compacting" && !run.compacting) { run.compacting = true; run.boundaryDue = true; run.compaction = "compaction:" + run.prompt + ":" + run.compactions++; this.emit(run, { type: "activity", id: run.compaction, kind: "compaction", title: "上下文压缩", status: "running" }); }
        if (message.compact_result !== undefined && run.compaction !== null) {
          const failed = message.compact_result === "failed";
          this.emit(run, { type: "activity", id: run.compaction, kind: "compaction", title: "上下文压缩", status: failed ? "failed" : "completed", ...(failed && typeof message.compact_error === "string" ? { detail: line(message.compact_error, 600) } : {}) });
          run.compacting = false;
          if (failed) run.boundaryDue = false;
        }
        return;
      }
      case "compact_boundary": {
        if (run === null) return;
        const meta = record(message.compact_metadata), before = typeof meta?.pre_tokens === "number" ? meta.pre_tokens : undefined, after = typeof meta?.post_tokens === "number" ? meta.post_tokens : undefined;
        if (run.compaction === null || !run.boundaryDue) run.compaction = "compaction:" + run.prompt + ":" + run.compactions++;
        this.emit(run, { type: "activity", id: run.compaction, kind: "compaction", title: meta?.trigger === "auto" ? "自动压缩上下文" : "上下文压缩", status: "completed",
          ...(before === undefined ? {} : { detail: before + " → " + (after ?? "?") + " tokens" }) });
        run.compacting = false; run.boundaryDue = false;
        return;
      }
      case "api_retry": {
        if (run === null) return;
        this.emit(run, { type: "activity", id: "retry:" + run.prompt, kind: "retry", title: "模型请求重试（第 " + Number(message.attempt ?? 0) + "/" + Number(message.max_retries ?? 0) + " 次）", status: "running",
          ...(typeof message.error === "string" ? { detail: message.error } : {}) });
        return;
      }
      case "task_started": case "task_progress": case "task_updated": case "task_notification": {
        if (message.skip_transcript === true || message.ambient === true || typeof message.task_id !== "string") return;
        const patch = record(message.patch), id = message.task_id;
        // A command that runs in the foreground is its tool call already: only sub-agents, background work and tasks of their own are shown.
        const known = this.taskShown.get(id), shown = known === true || message.is_backgrounded === true || patch?.is_backgrounded === true || typeof message.subagent_type === "string"
          || (message.subtype === "task_started" && message.task_type !== "local_bash");
        this.taskShown.set(id, shown);
        if (run === null || !shown) return;
        const state = message.subtype === "task_notification" ? message.status : patch?.status;
        const status = state === "completed" ? "completed" as const : state === "failed" ? "failed" as const : state === "stopped" || state === "killed" ? "cancelled" as const : "running" as const;
        const title = text(message.description) ?? text(patch?.description) ?? "后台任务", detail = text(message.summary) ?? text(patch?.error);
        this.emit(run, { type: "activity", id: "task:" + id.slice(0, 200), kind: message.task_type === "local_agent" || typeof message.subagent_type === "string" ? "subagent" : "task",
          title: line(title, 200), status, ...(detail === undefined ? {} : { detail: line(detail, 1000) }) });
        return;
      }
      case "notification": case "informational": {
        const said = text(message.text) ?? text(message.content);
        if (run === null || said === undefined) return;
        this.emit(run, { type: "notice", severity: message.level === "warning" || message.priority === "high" || message.priority === "immediate" ? "warning" : "info", title: line(said, 1000) });
        return;
      }
      case "permission_denied": {
        if (run === null) return;
        this.emit(run, { type: "notice", severity: "warning", title: "Claude Code 没有让 " + line(String(message.tool_name ?? "工具"), 80) + " 运行", ...(text(message.message) ? { detail: line(text(message.message)!, 1000) } : {}) });
        return;
      }
      case "local_command_output": { if (run !== null && typeof message.content === "string") this.emit(run, { type: "text", text: message.content, item: "local:" + String(message.uuid ?? run.prompt) }); return; }
      case "model_refusal_fallback": case "model_refusal_no_fallback": {
        if (run !== null) this.emit(run, { type: "notice", severity: "warning", title: message.subtype === "model_refusal_fallback" ? "模型拒绝了这次回答，Claude Code 换了一个模型重答" : "模型拒绝了这次回答" });
        return;
      }
      case "session_writes_lost": { if (run !== null) this.emit(run, { type: "notice", severity: "error", title: "Claude Code 没能把记录写进磁盘（磁盘可能满了），这段会话的部分内容可能丢了。" }); return; }
      case "conversation_reset": { if (run !== null) this.emit(run, { type: "diagnostic", message: "Claude Code 在会话里自己清空了上下文。" }); return; }
      case "commands_changed": {
        if (Array.isArray(message.commands)) this.listCommands(message.commands.flatMap(value => { const name = text(record(value)?.name); return name === undefined || name === REMOTE_CONTROL ? [] : [name]; }));
        return;
      }
      default: return;
    }
  }
  /** Streamed text and thinking of the main loop: each answer's message id is its item, so what Claude says between tools and its answer are apart. */
  private partial(run: Run, message: Row): void {
    const event = record(message.event);
    if (event === null) return;
    if (event.type === "message_start") { run.message = text(record(event.message)?.id) ?? null; if (this.stamped(message)?.includes(run.prompt)) this.recorded(run); return; }
    if (event.type === "message_delta") { this.request(run, event.usage); return; }
    if (event.type !== "content_block_delta" || run.message === null) return;
    const delta = record(event.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) { run.streamed.add(run.message + ":text"); this.emit(run, { type: "text", text: delta.text, item: run.message }); }
    else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) { run.streamed.add(run.message + ":thinking"); this.emit(run, { type: "thinking", text: delta.thinking, item: run.message }); }
  }
  private request(run: Run, usage: unknown): void {
    const read = requestUsage(usage);
    if (read === null) return;
    if (read.entry !== null) run.requests.push(read.entry);
    run.context = { used: read.used, ...(run.context?.size === undefined ? {} : { size: run.context.size }) };
  }
  private assistant(run: Run, message: Row): void {
    const body = record(message.message), id = text(body?.id), parent = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : undefined;
    if (this.stamped(message)?.includes(run.prompt)) this.recorded(run);
    if (typeof message.error === "string") run.modelError = message.error;
    if (!Array.isArray(body?.content)) return;
    for (const value of body.content) {
      const block = record(value);
      if (block === null) continue;
      if (parent === undefined && block.type === "text" && typeof block.text === "string" && block.text && !(id !== undefined && run.streamed.has(id + ":text"))) this.emit(run, { type: "text", text: block.text, ...(id === undefined ? {} : { item: id }) });
      else if (parent === undefined && block.type === "thinking" && typeof block.thinking === "string" && block.thinking && !(id !== undefined && run.streamed.has(id + ":thinking"))) this.emit(run, { type: "thinking", text: block.thinking, ...(id === undefined ? {} : { item: id }) });
      else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") this.toolUse(run, block.id, block.name, record(block.input) ?? {}, parent);
    }
  }
  private toolUse(run: Run, id: string, name: string, input: Row, parent: string | undefined): void {
    if (name === "TodoWrite") { const entries = todoPlan(input); if (entries !== null) this.emit(run, { type: "plan", entries }); }
    if (TASK_TOOLS.has(name) || name === "AskUserQuestion" || name === "ExitPlanMode") { run.tools.set(id, { name, input, title: name, detail: {} }); return; }
    const call = toolCall(name, input, parent);
    run.tools.set(id, { name, input, title: call.title, detail: call.detail });
    this.emit(run, { type: "tool", id, title: call.title, status: "in_progress", detail: call.detail });
  }
  private toolResults(run: Run, message: Row): void {
    const body = record(message.message);
    if (!Array.isArray(body?.content)) return;
    for (const value of body.content) {
      const block = record(value), id = typeof block?.tool_use_id === "string" ? block.tool_use_id : undefined, entry = id === undefined ? undefined : run.tools.get(id);
      if (block?.type !== "tool_result" || entry === undefined || id === undefined) continue;
      if (TASK_TOOLS.has(entry.name)) {
        const next = applyTaskTool(this.tasks, entry.name, entry.input, message.tool_use_result, typeof block.content === "string" ? block.content : "");
        if (next !== null) { this.tasks = next; this.emit(run, { type: "plan", entries: [...next.values()].map(task => ({ content: task.content, status: task.status })) }); }
        continue;
      }
      if (entry.name === "AskUserQuestion" || entry.name === "ExitPlanMode") continue;
      const done = toolResult(entry.name, block, message.tool_use_result);
      entry.detail = { ...entry.detail, ...done.detail };
      this.emit(run, { type: "tool", id, title: entry.title, status: done.failed ? "failed" : "completed", detail: entry.detail });
    }
  }
  private rateLimits(message: Row): void {
    for (const limit of limitsOf(message.rate_limit_info)) this.limits.set(limit.id, limit);
    const run = this.live();
    if (run === null) { this.limitsChanged = true; return; }
    this.limitsChanged = false;
    this.emit(run, { type: "limits", limits: [...this.limits.values()] });
  }
  /** A result: one of the Run's turns ended (it names one of its identities), or a turn Claude Code ran by itself. */
  private result(message: Row): void {
    const cumulative = modelTotals(message.modelUsage), own = message.model_usage_since_last_result !== undefined ? modelTotals(message.model_usage_since_last_result) : lessTotals(cumulative, this.baseline);
    if (message.modelUsage !== undefined) this.baseline = cumulative;
    const run = this.live(), stamped = this.stamped(message);
    const ours = run !== null && (stamped === undefined ? run.begun : stamped.some(uuid => run.uuids.has(uuid) || run.steers.has(uuid)));
    if (!ours || run === null) { this.unattributed++; if (run === null) this.idleTurns++; return; }
    for (const uuid of stamped ?? []) { const steer = run.steers.get(uuid); if (steer !== undefined) { run.steers.delete(uuid); run.uuids.add(uuid); steer.resolve("taken"); } }
    addTotals(run.totals, own);
    const window = Object.values(record(message.modelUsage) ?? {}).map(value => record(value)?.contextWindow).find((value): value is number => typeof value === "number" && value > 0);
    if (run.context !== undefined && window !== undefined) run.context = { used: run.context.used, size: window };
    this.emit(run, { type: "usage", usage: turnUsage(run.totals, run.context, run.requests) });
    // Words given to the Turn that Claude Code holds for a turn of their own: that turn is this Run's too, and the Run ends with it.
    if (run.steers.size > 0 && typeof message.queued_turn_count === "number" && message.queued_turn_count > 0 && !run.stopping) return;
    for (const [uuid, steer] of run.steers) { run.steers.delete(uuid); steer.reject(new ControlError("STEER_UNKNOWN", "the turn ended without Claude Code saying it took the words")); }
    const outcome = this.outcome(run, message);
    this.settle(run);
    run.resolve(outcome);
  }
  private outcome(run: Run, message: Row): BackendResult {
    const subtype = message.subtype, errors = Array.isArray(message.errors) ? message.errors : [], said = firstError(errors), failure = modelFailure(run.modelError);
    const success = subtype === "success" && message.is_error !== true;
    if (success) this.recorded(run);
    const input = run.command ? {} : run.recorded || success || failure !== null ? { input: "recorded" as const }
      : typeof errors[0] === "string" && UNCHECKED_PROMPT.test(errors[0]) ? NOT_RECORDED : {};
    if (success) return { status: "completed", reason: run.keptPlan ? "plan_kept" : typeof message.terminal_reason === "string" ? message.terminal_reason : "completed", ...input };
    const reason = typeof message.terminal_reason === "string" ? message.terminal_reason : typeof subtype === "string" ? subtype : "failed";
    if (run.keptPlan && !run.stopping) return { status: "completed", reason: "plan_kept", ...input };
    if (run.stopping || /^aborted/u.test(reason)) return { status: "cancelled", reason: "interrupted", ...input };
    const error = failure ?? (subtype === "error_max_turns" ? { code: "NATIVE_TURN_LIMIT", message: "这一轮达到了 Claude Code 的最大步数。" }
      : subtype === "error_max_budget_usd" ? { code: "NATIVE_BUDGET_LIMIT", message: "这一轮达到了 Claude Code 的费用上限。" }
      : { code: "NATIVE_TURN_FAILED", message: said ?? (typeof message.result === "string" && message.result ? line(message.result, 600) : "Claude Code 这一轮失败了。") });
    return { status: "failed", reason, error, ...input };
  }
  private settle(run: Run): void {
    this.cancelPermissions(run);
    run.settled = true;
    if (this.active === run) this.active = null;
  }
  private failRun(run: Run, error: Error): void {
    if (run.settled) return;
    for (const [uuid, steer] of run.steers) { run.steers.delete(uuid); steer.reject(error); }
    this.settle(run);
    run.reject(error);
  }

  // ---- permissions and questions ---------------------------------------------------------------------------------------

  enablePermissions(): void { this.interactive = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable");
    if (input !== undefined && (!pending.input || input.includes("\0"))) throw new ControlError("INVALID_INPUT", "invalid native input answer");
    this.pending.delete(id); pending.resolve({ option, ...(input === undefined ? {} : { input }) });
  }
  private cancelPermissions(run?: Run): void {
    for (const [id, pending] of this.pending) if (run === undefined || pending.run === run) { this.pending.delete(id); pending.resolve(STOPPED); }
  }
  /** Asks the user (a public Run); the SDK's abort (Claude Code withdrew the request) closes the prompt. */
  private ask(run: Run, id: string, request: Omit<Extract<ControlEvent, { type: "permission_requested" }>, "type" | "id">, signal: AbortSignal, input = false): Promise<Answer> {
    return new Promise<Answer>(resolve => {
      const done = (answer: Answer) => { signal.removeEventListener("abort", aborted); resolve(answer); };
      const aborted = () => { if (this.pending.delete(id)) { this.safeEmit(run, { type: "permission", id, decision: "cancelled" }); done(WITHDRAWN); } };
      this.pending.set(id, { run, options: request.options.map(option => option.id), input, resolve: done });
      signal.addEventListener("abort", aborted, { once: true });
      try { this.emit(run, { type: "permission_requested", id, ...request }); } catch (error) { this.pending.delete(id); done(STOPPED); this.failRun(run, errorFrom(error)); }
    });
  }
  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const run = this.live(), toolUseID = options.toolUseID;
    if (run === null) return { behavior: "deny", message: "HarnessHub 现在没有进行中的回合，不能批准这次调用。", toolUseID };
    if (run.stopping) return { behavior: "deny", message: STOPPED_WORDS, interrupt: true, toolUseID };
    // The Hub's own tools need no approval: they read this conversation back and tell the Hub how the Turn goes.
    if (toolName.startsWith("mcp__" + TABLE_MCP_NAME + "__")) return { behavior: "allow", updatedInput: input, toolUseID };
    if (toolName === "AskUserQuestion") return this.questions(run, input, options.requestId, options.signal, toolUseID);
    if (toolName === "ExitPlanMode") return this.exitPlan(run, input, options.requestId, options.signal, toolUseID);
    const id = options.requestId, call = toolCall(toolName, input), owner = options.agentID === undefined ? "" : "子 Agent · ";
    if (!this.interactive) { this.emit(run, { type: "permission", id, decision: "denied" }); return { behavior: "deny", message: DENIED, toolUseID }; }
    const detail = [options.title, options.description, options.decisionReason, options.blockedPath === undefined ? undefined : "路径：" + options.blockedPath].filter((value): value is string => typeof value === "string" && value.trim() !== "").join("\n");
    const answer = await this.ask(run, id, { title: owner + call.title, ...(detail ? { detail } : {}), options: CHOICES, forCall: toolUseID, toolKind: toolFamily(toolName), note: true, ...requestExpiry(null) }, options.signal, true);
    if (answer === WITHDRAWN) return { behavior: "deny", message: DENIED, toolUseID };
    if (answer === STOPPED) return { behavior: "deny", message: STOPPED_WORDS, interrupt: true, toolUseID };
    switch (answer.option) {
      case "allow": return { behavior: "allow", updatedInput: input, toolUseID };
      // Rules for this session alone: Claude Code's suggestions go to the session, never to a settings file.
      case "allow_session": return { behavior: "allow", updatedInput: input, updatedPermissions: sessionRules(toolName, options.suggestions), toolUseID };
      case "deny_stop": return { behavior: "deny", message: answer.input?.trim() || STOPPED_WORDS, interrupt: true, toolUseID };
      default: return { behavior: "deny", message: answer.input?.trim() || DENIED, toolUseID };
    }
  };
  /** AskUserQuestion: each question asked in turn (a choice, or the user's own words); the answers go back as the tool's input. */
  private async questions(run: Run, input: Row, requestId: string, signal: AbortSignal, toolUseID: string): Promise<PermissionResult> {
    const asked = askedQuestions(input);
    if (asked === null) { this.emit(run, { type: "diagnostic", message: "Claude Code 的提问格式读不懂，已按未回答处理" }); return { behavior: "deny", message: "问题格式不对，没有问用户。", toolUseID }; }
    if (!this.interactive) { this.emit(run, { type: "permission", id: requestId, decision: "denied" }); return { behavior: "deny", message: "现在没有人能回答问题。", toolUseID }; }
    const answers: Record<string, string> = {};
    for (const [index, question] of asked.entries()) {
      const id = requestId + ":" + index, choices = [...question.options.map((option, at) => ({ id: "answer-" + at, name: option.label })), { id: "submit", name: "提交回答" }, { id: "cancel", name: "取消" }];
      const detail = [question.header, ...question.options.flatMap(option => option.description ? [option.label + "：" + option.description] : []), question.multiSelect ? "可以选多个：用逗号分开写在回答里。" : undefined]
        .filter((value): value is string => typeof value === "string" && value !== "").join("\n");
      const answer = await this.ask(run, id, { title: question.question, ...(detail ? { detail } : {}), options: choices, input: { kind: "text", value: "" }, kind: "question", forCall: toolUseID, ...requestExpiry(null) }, signal, true);
      if (answer === WITHDRAWN) return { behavior: "deny", message: "问题被收回了。", toolUseID };
      if (answer === STOPPED) return { behavior: "deny", message: STOPPED_WORDS, interrupt: true, toolUseID };
      if (answer.option === "cancel") return { behavior: "deny", message: "用户没有回答这个问题。", toolUseID };
      const value = answer.option === "submit" ? answer.input?.trim() ?? "" : question.options[Number(answer.option.slice(7))]?.label;
      if (value === undefined || value === "") return { behavior: "deny", message: "用户没有回答这个问题。", toolUseID };
      answers[question.question] = value;
    }
    return { behavior: "allow", updatedInput: { ...input, answers }, toolUseID };
  }
  /**
   * ExitPlanMode: the plan is the Turn's answer, and leaving plan mode an approval (a mode switch, which the Hub's "plan" level refuses for the
   * user). Kept: the tool is refused with words that make Claude stop and wait, and the Turn ends with the plan delivered (`plan_kept`).
   */
  private async exitPlan(run: Run, input: Row, requestId: string, signal: AbortSignal, toolUseID: string): Promise<PermissionResult> {
    const plan = text(input.plan);
    if (plan !== undefined) this.emit(run, { type: "text", text: plan, item: "plan:" + toolUseID });
    const keep = (): PermissionResult => { run.keptPlan = true; return { behavior: "deny", message: PLAN_KEPT, toolUseID }; };
    if (!this.interactive) return keep();
    const answer = await this.ask(run, requestId, { title: "按这个计划开始执行？", ...(plan === undefined ? {} : { detail: plan }), options: PLAN_CHOICES, forCall: toolUseID, toolKind: "switch_mode", ...requestExpiry(null) }, signal);
    if (answer === STOPPED) return { behavior: "deny", message: STOPPED_WORDS, interrupt: true, toolUseID };
    if (answer === WITHDRAWN || answer.option !== "approve") return keep();
    return { behavior: "allow", updatedInput: input, toolUseID };
  }
}

/** A checkpoint: the session's identity, with the rollback point the next resume takes after `#` when there is one. */
function splitCheckpoint(checkpoint: string): readonly [string, string | null] {
  const at = checkpoint.indexOf("#"), id = at < 0 ? checkpoint : checkpoint.slice(0, at), cut = at < 0 ? null : checkpoint.slice(at + 1);
  if (!SESSION_ID.test(id) || (cut !== null && !SESSION_ID.test(cut))) throw new ControlError("INVALID_INPUT", "invalid Claude Code session reference");
  return [id, cut];
}
/** Claude Code's suggestions for the session (their destination made `session`, never a settings file), else an allow rule of the tool for the session. */
function sessionRules(toolName: string, suggestions: readonly PermissionUpdate[] | undefined): PermissionUpdate[] {
  const updates = (suggestions ?? []).map(suggestion => ({ ...suggestion, destination: "session" as const }));
  return updates.length ? updates : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}
/** The sign-in as the initialize answer's account says it (only whether one is there; nothing of it is kept). */
function signedIn(account: unknown): NativeModelCatalog["authentication"] {
  const row = record(account);
  if (row === null) return "unknown";
  const source = [row.tokenSource, row.apiKeySource, row.apiProvider].find(value => typeof value === "string" && value !== "" && value !== "none");
  return source !== undefined || typeof row.email === "string" || typeof row.subscriptionType === "string" ? "ready" : "unknown";
}
