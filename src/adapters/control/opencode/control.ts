import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { TABLE_ENV, TABLE_LOAD_ENV, TABLE_MCP_NAME, TABLE_PROGRESS_ENV, TABLE_RECORD_ENV } from "../../../contracts/table.js";
import { nativeConversationId, requestExpiry, singleText, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent, type ControlLaunch, type ControlOptions, type ControlRun,
  type HarnessControl, type NativeConversationId, type NativeExtensions, type NativeModelCatalog, type NativeOption, type NativeOptions, type NativeSessionImport, type NativeSessionPage,
  type NativeToolDetail, type ProtocolObservation, type SteerOutcome, type StopRequestReceipt, type TurnText } from "../../../contracts/control.js";
import type { ContentKind, ContentRef, ControlAttachment } from "../../../contracts/content.js";
import type { RelayCapabilities, RelayPacketId } from "../../../contracts/relay.js";
import { levelOptions, type ChosenLevels } from "../../../contracts/flavor.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { checkInputs, fileMentions } from "../../../infrastructure/control/attachments.js";
import { OPENCODE_COMPACT as COMPACT, openCodeClassify, openCodeNativeClassify, relayDeclaration, relayEntries } from "../relay-classify.js";
import { carriesPacket, clearedNotice, COMMAND_REFUSED, hubCleared, measureBy, TITLE_DEADLINE_MS } from "../relay-turn.js";
import { OpenCodeApi, clearlyRefused, statusOf, tagOf, type EventStream, type Exchange, type Row } from "./http.js";
import { OpenCodeServer } from "./server.js";
import { checkSchema, type OpenCodeFeature } from "./schema.js";
import { actionKind, commandFailed, contentText, failureOf, formQuestions, line, mcpServer, permissionDiff, permissionView, planOf, record, rows, subagentOutput, tokensOf, toolKind, toolView,
  TurnUsage, type Choice, type FormQuestion } from "./mapping.js";
import { agentPaths, levelRules, sameRules, sessionRules, type Rule } from "./levels.js";

/**
 * OpenCode's relay declaration (ADR-055 §8.1): one text (the packet, a blank line, the words), no bound; live evidence from its inbox (`session.inbox.delivered`
 * for the prompt's own identity), and a completed execution proves nothing by itself; `/compact`, listed commands and the Hub's clear; one process per
 * connection; a native title by `PATCH /session/{id}`.
 */
export const openCodeServerRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "recorded_event", successProvesRecorded: false },
  execution: "process",
  commands: { classify: openCodeClassify },
  placement: { parts: "single", maxInput: null, measure: measureBy("single", "chars", ["file"]) },
  title: "set",
});

const SETUP_MS = 10 * 60_000;
const INTERRUPT_MS = 10_000;
const RECONNECTS = 5;
const RECONNECT_DELAY_MS = 1000;
const INSTRUCTIONS_KEY = "harnesshub";
/** Marks the sessions the Hub created (session metadata), which the list of the user's own sessions leaves out. */
const HUB_METADATA = { harnesshub: "1" } as const;
/** What OpenCode is told of a refusal the user gave without words: rejected with a message, the model goes on (a rejection without one ends the execution). */
const DECLINED = "The user declined this request. Do not retry it; continue without it or ask the user how to proceed.";
const OPENCODE_2_2_6 = [2, 2, 6] as const;

const NOT_RECORDED = { input: "not_recorded" } as const;
interface ToolEntry { name: string; input: unknown; title: string; status: string; detail: NativeToolDetail; diff?: string; child?: string }
interface Run {
  readonly onEvent: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  readonly kind: "prompt" | "compact" | "command";
  /** The inbox identity of what this Run sent (its prompt or compaction); null for a command, which takes none. */
  readonly inboxId: string | null;
  readonly packetId: RelayPacketId | null;
  readonly text: string;
  /** The newest message before this Run (a command's boundary). */
  before: string | null;
  sent: boolean;
  delivered: boolean;
  inboxCancelled: boolean;
  begun: boolean;
  readonly steers: Set<string>;
  held: BackendResult | null;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  settled: boolean;
  /** Text emitted so far by block (`<message>:<ordinal>`, reasoning `<message>:think:<ordinal>`). */
  readonly blocks: Map<string, string>;
  readonly tools: Map<string, ToolEntry>;
  /** Model calls whose usage is counted (their assistant message's identity). */
  readonly steps: Set<string>;
  readonly usage: TurnUsage;
  window: number | undefined;
  retrying: boolean;
  /** The user refused a request with "拒绝并停止": OpenCode ends the execution as shut down, which is the user's stop. */
  refusedStop: boolean;
  compactions: number;
}
const WITHDRAWN = Symbol("withdrawn"), STOPPED = Symbol("stopped");
type Answer = { readonly option: string; readonly input?: string } | typeof WITHDRAWN | typeof STOPPED;
interface Pending { readonly native: string; readonly run: Run; readonly options: readonly string[]; readonly validate?: (option: string, input?: string) => void; readonly resolve: (answer: Answer) => void }
interface ModelRef { readonly providerID: string; readonly id: string; readonly variant?: string }
interface Catalog { readonly models: NativeModelCatalog["models"]; readonly defaultModel: string | null; readonly agents: readonly Row[]; readonly commands: readonly { readonly name: string; readonly description: string }[]; readonly windows: ReadonlyMap<string, number> }

/** `provider/model` as OpenCode refers to it (the first slash: a model id may have more). */
function modelRef(id: string, variant?: string): ModelRef | null {
  const at = id.indexOf("/");
  return at <= 0 || at === id.length - 1 ? null : { providerID: id.slice(0, at), id: id.slice(at + 1), ...(variant && variant !== "default" ? { variant } : {}) };
}
const refId = (ref: unknown): string | null => { const row = record(ref); return typeof row?.providerID === "string" && typeof row.id === "string" ? row.providerID + "/" + row.id : null; };
function versionAtLeast(version: string | null, wanted: readonly number[]): boolean {
  const parts = (version ?? "").split(/[.-]/u).map(Number);
  for (let index = 0; index < wanted.length; index++) { const have = parts[index] ?? 0; if (!Number.isFinite(have)) return true; if (have !== wanted[index]) return have > wanted[index]!; }
  return true;
}
/** An inbox identity of this connection: OpenCode keeps message identities across every session of its database, so each carries the session and a random part. */
function inboxId(session: string, tag: string): string { return "msg_hub_" + tag + "_" + session.replace(/^ses_?/u, "").slice(0, 40) + "_" + Date.now().toString(36) + randomBytes(6).toString("hex"); }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * OpenCode 2 through its own server (research of 2026-11-14 §8): the Hub starts a private `opencode serve --stdio` per connection and speaks its HttpApi and
 * event stream. The level is the session's own ruleset, written when the session opens; words given mid-turn go in as a steer of the same turn; a refusal
 * carries a message, so the model goes on; the input's arrival in the history is the inbox's own event; a stream that broke is followed again and the
 * session's messages fill what was missed, each piece of text once. Native session ids never become public Session ids.
 */
export class OpenCodeServerControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = openCodeServerRelayCapabilities;
  private readonly server: OpenCodeServer;
  private api: OpenCodeApi | null = null;
  private stream: EventStream | null = null;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private version: string | null = null;
  private off: ReadonlySet<OpenCodeFeature> = new Set();
  private readonly notes: string[] = [];
  private failure: Error | null = null;
  private closing = false;
  private conversation: NativeConversationId | null = null;
  private cwd: string | null = null;
  private opening = false;
  private forkConnection = false;
  private sessionGone = false;
  private readonly catalogs = new Map<string, Promise<Catalog>>();
  private model: ModelRef | null = null;
  private agent = "build";
  private rules: Rule[] | undefined;
  private readonly grants: Rule[] = [];
  private planPaths: Rule[] = [];
  private instructions: string | null = null;
  private progress: boolean | undefined;
  private writtenInstructions: string | null | undefined;
  private mcpAdded = new Set<string>();
  private interactivePermissions = false;
  private readonly pending = new Map<string, Pending>();
  private active: Run | null = null;
  /** A Run ended without its execution's end being seen: the next one first asks whether that execution still runs. */
  private unsettled = false;
  /** Steers whose answer never came: cancelled before the next Turn, so that they do not run first. */
  private readonly stranded = new Set<string>();
  private readonly children = new Map<string, string>();
  private readonly childRules = new Set<string>();
  private idleExecutions = 0;
  private counted = 0;
  private readonly servers = new Set<string>();
  private reconnecting: Promise<void> | null = null;
  private nativeModel: string | null = null;
  private nativeAgent: string | null = null;
  private nativeVariant: string | null = null;
  private recorder: ((exchange: Exchange) => void) | undefined;

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "opencode-server") throw new ControlError("INVALID_INPUT", "OpenCode control requires an opencode-server launch");
    this.server = new OpenCodeServer(launch, options, error => this.fail(error));
  }
  get unattributedUpdates(): number { return this.counted; }
  get steering(): boolean { return this.initialized && !this.off.has("steer"); }
  healthy(): boolean { return this.initialized && this.failure === null && this.server.failure === null && !this.sessionGone; }
  processGroup(): number | null { return this.server.processGroup; }
  diagnosticMark(): number { return this.server.stderrMark; }
  diagnosticsSince(mark: number): string { return this.server.stderrSince(mark); }
  /** For the replay recorder: every exchange with the server from now on. */
  record(tap: (exchange: Exchange) => void): void { this.recorder = tap; }
  private has(feature: OpenCodeFeature): boolean { return !this.off.has(feature); }
  private get client(): OpenCodeApi {
    if (this.failure) throw this.failure;
    if (this.api === null) throw new ControlError("INVALID_STATE", "connection is not initialized");
    return this.api;
  }
  private setupMs(): number { return Math.max(this.options.requestTimeoutMs, Math.min(SETUP_MS, this.options.runTimeoutMs ?? SETUP_MS)); }

  initialize(): Promise<ProtocolObservation> {
    if (this.failure) return Promise.reject(this.failure);
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      const wait = this.options.startupTimeoutMs ?? this.options.requestTimeoutMs;
      const url = await this.server.start(wait);
      this.api = new OpenCodeApi(url, this.server.password, this.options.requestTimeoutMs, exchange => this.recorder?.(exchange));
      const info = record(await this.api.call("GET", "/api/info", undefined, wait));
      this.version = typeof info?.version === "string" ? line(info.version, 64) : null;
      let doc: unknown = null;
      try { doc = await this.api.call("GET", "/openapi.json", undefined, wait); } catch (error) { if (this.server.failure) throw error; }
      const check = checkSchema(JSON.stringify([this.launch.executable, this.version]), this.version ?? "?", doc);
      this.off = check.off;
      if (check.diagnostic) this.notes.push(check.diagnostic);
      // The stream first: what is done after this is seen (it is volatile, nothing is replayed).
      this.stream = await this.api.subscribe(this.handlers(), this.options.maxFrameBytes);
      this.initialized = true;
      return { protocol: "opencode-server", protocolVersion: null, agentName: "opencode", agentVersion: this.version, authenticationMethods: [],
        capabilities: { server: "opencode serve --stdio", ...(this.off.size ? { featuresOff: [...this.off] } : {}) } };
    } catch (error) { this.fail(error instanceof Error ? error : new ControlError("CONTROL_FAILED", "OpenCode did not start")); throw error; }
  }
  private handlers() {
    return { event: (event: Row) => this.onEvent(event), fault: () => { const run = this.live(); if (run) this.safeEmit(run, { type: "diagnostic", message: "OpenCode 发来了一条读不懂的事件" }); },
      failure: (error: Error) => this.streamLost(error) };
  }
  /** The connection fails: the Run ends with the failure, the server is closed. */
  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.stream?.close();
    for (const pending of this.pending.values()) pending.resolve(STOPPED);
    this.pending.clear();
    if (this.active) this.failRun(this.active, error);
    this.server.abort(error);
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private assertOwned(id: NativeConversationId): void {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation || this.opening) throw new ControlError("IDENTITY_MISMATCH", "session is not owned by this connection");
  }
  private levels(): ChosenLevels {
    return { ...(this.options.permission === undefined ? {} : { permission: this.options.permission }), ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.options.speed === undefined ? {} : { speed: this.options.speed }) };
  }

  // ---- catalog -------------------------------------------------------------------------------------------------------

  private catalog(cwd: string, fresh = false): Promise<Catalog> {
    let known = fresh ? undefined : this.catalogs.get(cwd);
    if (known === undefined) { known = this.readCatalog(cwd); this.catalogs.set(cwd, known); void known.catch(() => this.catalogs.delete(cwd)); }
    return known;
  }
  private async readCatalog(cwd: string): Promise<Catalog> {
    const at = OpenCodeApi.query({ "location[directory]": cwd }), wait = this.setupMs();
    const listed = await this.client.data("GET", "/api/model" + at, undefined, wait);
    if (!Array.isArray(listed)) throw new ControlError("INVALID_PROTOCOL", "invalid OpenCode model list");
    const models: NativeModelCatalog["models"][number][] = [], windows = new Map<string, number>(), seen = new Set<string>();
    for (const value of listed.slice(0, 4096)) {
      const row = record(value);
      if (row === null || typeof row.providerID !== "string" || typeof row.id !== "string" || row.enabled === false) continue;
      const id = row.providerID + "/" + row.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const input = Array.isArray(record(row.capabilities)?.input) ? record(row.capabilities)!.input as unknown[] : ["text"];
      const variants = (Array.isArray(row.variants) ? row.variants : []).flatMap(item => { const variant = record(item); return typeof variant?.id === "string" && variant.id ? [variant.id] : []; });
      const options: NativeOption[] = variants.length ? [{ id: "effort", name: "思考强度", category: "thought_level", currentValue: "default", values: [{ value: "default", name: "默认" }, ...variants.map(value => ({ value, name: value }))] }] : [];
      const context = record(row.limit)?.context;
      if (typeof context === "number" && Number.isSafeInteger(context) && context > 0) windows.set(id, context);
      models.push({ id, name: typeof row.name === "string" && row.name ? line(row.name, 256) : id, ...(options.length ? { options } : {}), inputs: { image: input.includes("image"), audio: input.includes("audio"), file: true } });
    }
    let defaultModel: string | null = null;
    if (this.has("model")) { try { defaultModel = refId(await this.client.data("GET", "/api/model/default" + at, undefined, wait)); } catch (error) { if (!clearlyRefused(error) && statusOf(error) === undefined) throw error; } }
    const agents = this.has("agent") ? await this.client.data("GET", "/api/agent" + at, undefined, wait).then(value => rows(value), () => []) : [];
    const commands = this.has("command") ? await this.client.data("GET", "/api/command" + at, undefined, wait).then(value => Array.isArray(value) ? value.flatMap(item => {
      const row = record(item); return typeof row?.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(row.name) ? [{ name: row.name, description: typeof row.description === "string" ? line(row.description, 1024) : "" }] : [];
    }) : [], () => []) : [];
    return { models, defaultModel, agents, commands, windows };
  }
  /** The primary agents a session can run (OpenCode's modes: build, plan, and any of the user's), as the catalog's mode option. */
  private modeOption(catalog: Catalog, current: string): NativeOption | null {
    const modes = catalog.agents.filter(agent => agent.mode === "primary" && agent.hidden !== true && typeof agent.id === "string");
    if (modes.length === 0) return null;
    return { id: "mode", name: "模式", category: "mode", currentValue: modes.some(agent => agent.id === current) ? current : String(modes[0]!.id),
      values: modes.map(agent => ({ value: String(agent.id), name: typeof agent.name === "string" && agent.name ? line(agent.name, 64) : String(agent.id) })) };
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const catalog = await this.catalog(this.cwd ?? this.options.cwd, true), mode = this.modeOption(catalog, this.agent);
    const commands = [...catalog.commands.map(command => ({ ...command, contextEffect: "keep" as const })), ...(catalog.commands.some(command => command.name === COMPACT.name) || !this.has("compact") ? [] : [COMPACT])];
    return { models: catalog.models, defaultModel: catalog.defaultModel, canSelect: catalog.models.length > 0, ...(mode ? { options: [mode] } : {}), commands, authentication: catalog.models.length ? "ready" : "unknown" };
  }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return openCodeNativeClassify(text, catalog, attachments); }
  async checkpoint(): Promise<string | null> { return this.conversation; }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    if (this.nativeModel === null && this.nativeAgent === null && this.nativeVariant === null) return null;
    return { model: this.nativeModel, options: { ...(this.nativeAgent === null ? {} : { mode: this.nativeAgent }), ...(this.nativeVariant === null ? {} : { effort: this.nativeVariant }) } };
  }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    if (!attachments.some(item => item.kind !== "file")) return;
    const catalog = await this.catalog(this.cwd ?? this.options.cwd), id = this.model === null ? catalog.defaultModel : this.model.providerID + "/" + this.model.id;
    checkInputs(attachments, catalog.models.find(row => row.id === id)?.inputs ?? { image: false, audio: false, file: true });
  }

  // ---- sessions ------------------------------------------------------------------------------------------------------

  /** Names the session on OpenCode's side (`PATCH /session/{id}`); a refusal or no answer within TITLE_DEADLINE_MS is NATIVE_TITLE_UNAVAILABLE. */
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    this.assertOwned(id);
    const name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 200).join("").trim();
    if (!name || !this.has("title")) return;
    try { await this.client.call("PATCH", "/api/session/" + encodeURIComponent(id), { title: name }, Math.min(this.options.requestTimeoutMs, TITLE_DEADLINE_MS)); }
    catch (error) { if (error instanceof ControlError && (error.code === "REMOTE_ERROR" || error.code === "REQUEST_TIMEOUT") && this.failure === null) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "OpenCode did not name the session"); throw error; }
  }
  /** HarnessControl.setSessionInstructions: the session's own instruction entry (`harnesshub`), written before its next prompt. */
  setSessionInstructions(text: string | null, tools?: { readonly progress: boolean }): void { this.instructions = text; this.progress = tools?.progress; }
  /** The Hub's tool server as a runtime MCP server of the session's location (`experimental.mcp.add`): the table's variables in its environment, nothing written anywhere. */
  private hubToolServer(): Row | null {
    if (this.options.entry?.tools !== "runtime-mcp" || !this.has("mcp")) return null;
    const tool = fileURLToPath(new URL("../../../cli/hub-tools.js", import.meta.url));
    const url = this.options.env[TABLE_ENV.url], token = this.options.env[TABLE_ENV.session];
    if (!url || !token || !existsSync(tool)) return null;
    const carried = Object.fromEntries([TABLE_RECORD_ENV, TABLE_LOAD_ENV].flatMap(name => this.options.env[name] ? [[name, this.options.env[name]!]] : []));
    return { type: "local", command: [process.execPath, tool, "mcp"], environment: { [TABLE_ENV.url]: url, [TABLE_ENV.session]: token, ...carried, ...(this.progress === false ? { [TABLE_PROGRESS_ENV]: "off" } : {}) } };
  }
  get sessionTools(): boolean { return this.hubToolServer() !== null; }

  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "this connection already owns a session");
    this.opening = true;
    try {
      const catalog = await this.catalog(cwd);
      let existing: Row | null = null;
      if (checkpoint !== undefined) {
        try { existing = record(await this.client.data("GET", "/api/session/" + encodeURIComponent(nativeConversationId(checkpoint)), undefined, this.setupMs())); }
        catch (error) { if (tagOf(error) === "SessionNotFoundError" || statusOf(error) === 404) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "OpenCode has no such session"); throw error; }
        if (existing === null || existing.id !== checkpoint) throw new ControlError("IDENTITY_MISMATCH", "OpenCode returned another session");
        if (record(existing.location)?.directory !== cwd) throw new ControlError("NATIVE_SESSION_WORKSPACE_MISMATCH", "the session belongs to another workspace");
      }
      const wanted = model ?? (existing === null ? catalog.defaultModel : refId(existing.model)) ?? undefined;
      const selected = wanted === undefined ? undefined : catalog.models.find(row => row.id === wanted);
      if (wanted !== undefined && selected === undefined && (model !== undefined || existing === null)) throw new ControlError("MODEL_UNAVAILABLE", "selected model is not in this Harness native catalog");
      const mode = this.modeOption(catalog, existing !== null && typeof existing.agent === "string" ? existing.agent : "build");
      const chosen = levelOptions(this.options.flavor, [...(mode ? [mode] : []), ...(selected?.options ?? [])], native, this.levels(), checkpoint !== undefined) ?? {};
      for (const [id, value] of Object.entries(chosen)) {
        if (id === "mode") { if (!mode?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "OpenCode has no such agent"); continue; }
        if (id !== "effort" || !selected?.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "thinking variant unavailable for selected native model");
      }
      this.agent = chosen.mode ?? (existing !== null && typeof existing.agent === "string" ? existing.agent : "build");
      const variant = chosen.effort ?? (existing !== null ? (record(existing.model)?.variant as string | undefined) : undefined);
      this.model = wanted === undefined ? null : modelRef(wanted, variant);
      const agentRow = catalog.agents.find(agent => agent.id === this.agent);
      this.planPaths = this.options.permission === "plan" ? agentPaths(Array.isArray(agentRow?.permissions) ? agentRow.permissions : []) : [];
      const rules = this.has("rules") ? this.currentRules() : undefined;
      let session: Row | null;
      if (existing === null) {
        session = record(await this.client.data("POST", "/api/session", { location: { directory: cwd }, ...(this.model ? { model: this.model } : {}), ...(this.has("agent") ? { agent: this.agent } : {}),
          ...(rules ? { permissions: rules } : {}), metadata: HUB_METADATA }, this.setupMs()));
        if (session === null || typeof session.id !== "string") throw new ControlError("INVALID_PROTOCOL", "OpenCode created no session");
      } else {
        session = existing;
        const id = String(existing.id);
        if (this.has("agent") && existing.agent !== this.agent) await this.client.call("POST", "/api/session/" + encodeURIComponent(id) + "/agent", { agent: this.agent });
        if (rules && !sameRules(Array.isArray(existing.permissions) ? existing.permissions as Rule[] : undefined, rules)) await this.client.call("PATCH", "/api/session/" + encodeURIComponent(id), { permissions: rules });
        const current = record(existing.model);
        if (this.model && this.has("model") && (refId(current) !== this.model.providerID + "/" + this.model.id || (current?.variant ?? "default") !== (this.model.variant ?? "default")))
          await this.client.call("POST", "/api/session/" + encodeURIComponent(id) + "/model", { model: this.model });
      }
      this.rules = rules;
      this.conversation = nativeConversationId(session.id);
      this.cwd = cwd; this.sessionGone = false; this.writtenInstructions = undefined;
      this.nativeModel = refId(session.model) ?? (this.model ? this.model.providerID + "/" + this.model.id : null);
      this.nativeAgent = this.agent; this.nativeVariant = this.model?.variant ?? null;
      return this.conversation;
    } catch (error) {
      if (this.failure === null && !(error instanceof ControlError && error.code === "REMOTE_ERROR") && !(error instanceof ControlError && /^(NATIVE_|MODEL_|IDENTITY_|INVALID_INPUT)/u.test(error.code))) this.fail(error instanceof Error ? error : new ControlError("CONTROL_FAILED", "open failed"));
      throw error;
    } finally { this.opening = false; }
  }
  /** The session's ruleset as it stands: the level's, the session's grants, the agent's own path allowances, the Hub's tools allowed. */
  private currentRules(): Rule[] { return sessionRules(levelRules(this.options.flavor, this.options.permission), this.grants, this.planPaths, this.hubToolServer() !== null); }
  /** This workspace's sessions (`GET /session`): top-level ones, not archived, newest first, without those the Hub created. */
  async nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    if (!this.has("sessions")) throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "this OpenCode cannot list its sessions");
    const limit = 50, page = record(await this.client.call("GET", "/api/session" + OpenCodeApi.query({ directory: cwd, parentID: "null", archived: "false", limit, ...(cursor === undefined ? { order: "desc" } : { cursor }) })));
    const data = rows(page?.data);
    const sessions = data.filter(row => typeof row.id === "string" && record(row.location)?.directory === cwd && record(row.metadata)?.harnesshub === undefined).map(row => {
      const time = record(row.time), updated = typeof time?.updated === "number" && Number.isSafeInteger(time.updated) && time.updated > 0 ? time.updated : null;
      return { id: String(row.id), title: typeof row.title === "string" && row.title.trim() ? line(row.title, 256) : null, updatedAt: updated };
    });
    const next = record(page?.cursor)?.next;
    return { sessions, nextCursor: data.length === limit && typeof next === "string" && next !== cursor ? next : null };
  }
  /** Reads one of the workspace's sessions for continuing it: its messages from the first, each user message and the assistant's text after it. */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    this.assertInitialized();
    const session = record(await this.client.data("GET", "/api/session/" + encodeURIComponent(nativeConversationId(id))));
    if (session?.id !== id) throw new ControlError("IDENTITY_MISMATCH", "OpenCode returned another session");
    if (record(session.location)?.directory !== cwd) throw new ControlError("NATIVE_SESSION_WORKSPACE_MISMATCH", "the session belongs to another workspace");
    const history: { role: "user" | "assistant"; text: string }[] = [];
    for (const message of await this.messages(id)) {
      if (message.type === "user" && typeof message.text === "string" && message.text.trim()) history.push({ role: "user", text: message.text });
      if (message.type !== "assistant") continue;
      const said = (Array.isArray(message.content) ? message.content : []).flatMap(part => { const row = record(part); return row?.type === "text" && typeof row.text === "string" ? [row.text] : []; }).join("\n");
      if (!said.trim()) continue;
      const last = history.at(-1);
      if (last?.role === "assistant") last.text += "\n\n" + said; else history.push({ role: "assistant", text: said });
    }
    return { checkpoint: id, title: typeof session.title === "string" && session.title.trim() ? line(session.title, 256) : null, history, omitted: 0, complete: true, historyRead: true };
  }
  /** Every message of a session, oldest first (cursor pages; a cursor page carries no order). */
  private async messages(session: string, newestFirstUntil?: string): Promise<Row[]> {
    const out: Row[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const query = OpenCodeApi.query({ limit: 100, ...(cursor === undefined ? { order: newestFirstUntil === undefined ? "asc" : "desc" } : { cursor }) });
      const answer = record(await this.client.call("GET", "/api/session/" + encodeURIComponent(session) + "/message" + query));
      const data = rows(answer?.data);
      for (const message of data) {
        out.push(message);
        if (newestFirstUntil !== undefined && message.id === newestFirstUntil) return out;
      }
      const next = record(answer?.cursor)?.next;
      if (data.length < 100 || typeof next !== "string" || seen.has(next)) break;
      seen.add(next); cursor = next;
    }
    return out;
  }
  async extensions(): Promise<NativeExtensions> {
    this.assertInitialized();
    // A location's lists are filled as it loads; its model list answers once it has (T3 Code, v2/adapter.ts:4434-4446).
    await this.catalog(this.cwd ?? this.options.cwd);
    const at = OpenCodeApi.query({ "location[directory]": this.cwd ?? this.options.cwd });
    const list = async (path: string): Promise<Row[]> => { const value = await this.client.data("GET", path + at, undefined, this.setupMs()); return rows(value); };
    const [skills, mcp, plugins] = await Promise.all([list("/api/skill").catch(() => []), list("/api/mcp").catch(() => []), list("/api/plugin").catch(() => [])]);
    return {
      skills: skills.flatMap(row => typeof row.id === "string" ? [{ name: line(typeof row.name === "string" ? row.name : row.id, 256), description: typeof row.description === "string" ? line(row.description, 1024) : "", enabled: row.enabled !== false }] : []),
      mcpServers: mcp.flatMap(row => { if (typeof row.name !== "string") return []; const status = record(row.status)?.status; return [{ name: line(row.name, 256), status: typeof status === "string" ? status : "unknown", tools: 0, failed: status === "failed" }]; }),
      // OpenCode's own built-in plugins are part of it, not the user's.
      plugins: plugins.flatMap(row => typeof row.id === "string" && record(row.source)?.type !== "builtin" ? [{ name: line(row.id, 256), enabled: record(row.state)?.status !== "disabled", ...(typeof record(row.source)?.type === "string" ? { source: String(record(row.source)!.type) } : {}) }] : []),
    };
  }
  /** `session.fork` of a stored session on a connection that opened none, moved to `cwd` when it is elsewhere; the source is left as it was. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    this.assertInitialized();
    if (this.conversation !== null || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "a fork needs its own connection");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    if (!this.has("fork")) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "this OpenCode cannot fork a session");
    this.forkConnection = true;
    const source = nativeConversationId(checkpoint);
    let forked: Row | null;
    try { forked = record(await this.client.data("POST", "/api/session/" + encodeURIComponent(source) + "/fork", {}, this.setupMs())); }
    catch (error) { if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.failure === null) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "OpenCode refused to fork the session"); throw error; }
    const id = typeof forked?.id === "string" ? nativeConversationId(forked.id) : null;
    if (id === null || id === source) throw new ControlError("IDENTITY_MISMATCH", "session.fork returned no new session");
    if (record(forked!.location)?.directory !== cwd && this.has("move")) await this.client.call("POST", "/api/session/" + encodeURIComponent(id) + "/move", { directory: cwd }, this.setupMs());
    await this.client.call("PATCH", "/api/session/" + encodeURIComponent(id), { metadata: HUB_METADATA }).catch(() => {});
    return id;
  }
  /**
   * Takes the last `turns` turns out of the session's history, their answers included, so that the next prompt goes on from there (OpenCode's revert, its
   * files left alone: the Hub keeps its own checkpoints). A turn begins at what started an execution after the session was idle: a prompt, a compaction,
   * a command's input; words steered into it are part of it. Staged and committed; a failed commit clears the stage, so that no later prompt commits it.
   */
  async rollback(id: NativeConversationId, turns: number): Promise<void> {
    this.assertOwned(id);
    if (!Number.isSafeInteger(turns) || turns < 0) throw new ControlError("INVALID_INPUT", "turns must be a whole number");
    if (turns === 0) return;
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a turn is running");
    if (!this.has("revert")) throw new ControlError("NATIVE_ROLLBACK_UNAVAILABLE", "this OpenCode cannot revert its history");
    const starts: string[] = [];
    let idle = true;
    for (const message of await this.messages(id)) {
      if (typeof message.id !== "string") continue;
      if (message.type === "idle") { idle = true; continue; }
      if (idle && (message.type === "user" || message.type === "compaction" || message.type === "synthetic" || message.type === "shell" || message.type === "skill")) { starts.push(message.id); idle = false; }
    }
    if (starts.length === 0) return;
    const boundary = starts[Math.max(0, starts.length - turns)]!, path = "/api/session/" + encodeURIComponent(id) + "/revert";
    try {
      await this.client.call("POST", path + "/stage", { messageID: boundary, files: false });
      await this.client.call("POST", path + "/commit");
    } catch (error) {
      await this.client.call("DELETE", path).catch(() => {});
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.failure === null)
        throw new ControlError(tagOf(error) === "SessionBusyError" ? "NATIVE_SESSION_BUSY" : "NATIVE_ROLLBACK_FAILED", tagOf(error) === "SessionBusyError" ? "OpenCode 的会话还在运行，回退没有做" : "OpenCode 没有接受回退");
      throw error;
    }
  }

  // ---- turns ---------------------------------------------------------------------------------------------------------

  private live(): Run | null { return this.active !== null && !this.active.settled ? this.active : null; }
  private path(...parts: string[]): string { return "/api/session/" + encodeURIComponent(this.conversation!) + (parts.length ? "/" + parts.join("/") : ""); }
  /** What goes before a prompt: steers left from before cancelled, the level's rules and the Hub's tools and instructions brought up to date. */
  private async prepare(): Promise<void> {
    for (const steer of [...this.stranded]) { await this.client.call("DELETE", this.path("inbox", encodeURIComponent(steer))).catch(() => {}); this.stranded.delete(steer); }
    const server = this.hubToolServer(), cwd = this.cwd!;
    if (server !== null && !this.mcpAdded.has(cwd)) {
      try {
        await this.client.call("PUT", "/api/experimental/mcp/" + TABLE_MCP_NAME + OpenCodeApi.query({ "location[directory]": cwd }), { config: server }, this.setupMs());
        this.mcpAdded.add(cwd);
        // Before 2.2.6 a new server's tools load 100 ms after it connects (T3 Code, v2/adapter.ts:4196-4199).
        if (!versionAtLeast(this.version, OPENCODE_2_2_6)) await sleep(250);
      } catch (error) { if (this.failure) throw error; this.notes.push("OpenCode 没有接受 HarnessHub 的工具服务，这一轮没有 Hub 工具。"); }
    }
    if (this.rules !== undefined) {
      const rules = this.currentRules();
      if (!sameRules(this.rules, rules)) { await this.client.call("PATCH", this.path(), { permissions: rules }); this.rules = rules; }
    }
    const text = this.instructions;
    if (this.has("instructions") && text !== this.writtenInstructions) {
      const key = this.path().replace("/api/session/", "/api/experimental/session/") + "/instructions/entries/" + INSTRUCTIONS_KEY;
      if (text === null) { if (this.writtenInstructions !== undefined) await this.client.call("DELETE", key).catch(() => {}); }
      else await this.client.call("PUT", key, { value: text });
      this.writtenInstructions = text;
    }
  }
  /** The Hub's clear (decision log of 2026-11-11): `/clear`, `/new` and `/reset` alone are not sent; the session is given up, and the next Turn opens a new one. */
  private clearRun(turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[]): ControlRun | null {
    const reading = typeof turn === "string" ? openCodeNativeClassify(turn, null, attachments.map(file => file.kind)) : null;
    if (reading === null || reading.kind !== "command" || reading.effect !== "clear") return null;
    this.conversation = null; this.cwd = null; this.writtenInstructions = undefined; this.unsettled = false;
    return { result: (async () => { onEvent(clearedNotice(reading.name, "OpenCode")); return hubCleared(); })(),
      requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a clear the Hub runs itself has no native turn to stop")) };
  }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    const prompt = typeof turn === "string" ? turn : turn.user;
    this.assertOwned(id);
    if (this.sessionGone) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "OpenCode deleted this session");
    if (this.active) throw new ControlError("INVALID_STATE", "a turn is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const cleared = this.clearRun(turn, onEvent, attachments);
    if (cleared !== null) return cleared;
    const nothingSent = (result: BackendResult): ControlRun => ({ result: Promise.resolve(result), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent, so there is no native turn to stop")) });
    const catalog = await this.catalog(this.cwd!);
    const listed = relayEntries([...catalog.commands.map(command => ({ ...command, contextEffect: "keep" as const })), COMPACT]);
    const reading = openCodeClassify(prompt, listed, attachments.map(file => file.kind));
    if (typeof turn !== "string" && reading.kind !== "content") return nothingSent(COMMAND_REFUSED);
    const kind: Run["kind"] = reading.kind === "command" && reading.name === COMPACT.name && this.has("compact") ? "compact" : reading.kind === "command" && this.has("command") && catalog.commands.some(command => command.name === reading.name) ? "command" : "prompt";
    const text = (typeof turn === "string" ? turn : singleText(turn)) + fileMentions(attachments.filter(file => file.kind === "file"));
    // An execution an earlier Run lost sight of may still run: a new prompt would only queue behind it.
    if (this.unsettled && this.has("active")) {
      const running = record(await this.client.data("GET", "/api/session/active").catch(() => null));
      if (running !== null && Object.hasOwn(running, id)) {
        await this.client.call("POST", this.path("interrupt"), undefined, INTERRUPT_MS).catch(() => {});
        return nothingSent({ status: "failed", reason: "previous_turn_active", error: { code: "NATIVE_SESSION_BUSY", message: "OpenCode 还在停上一轮，过一会儿再发一次。" }, ...NOT_RECORDED });
      }
      this.unsettled = false;
    }
    try { await this.prepare(); }
    catch (error) {
      if (this.failure === null && error instanceof ControlError && error.code === "REMOTE_ERROR") {
        const gone = tagOf(error) === "SessionNotFoundError";
        if (gone) this.sessionGone = true;
        return nothingSent({ status: "failed", reason: "request_rejected", error: gone ? { code: "NATIVE_SESSION_NOT_FOUND", message: "OpenCode 里这个会话已经不在了，再发一次会在新会话里继续。" } : { code: "NATIVE_REQUEST_REFUSED", message: "OpenCode 没有接受这一轮的设置，这条消息没有发出。" }, ...NOT_RECORDED });
      }
      throw error;
    }
    let resolve!: (value: BackendResult) => void, reject!: (error: Error) => void;
    const result = new Promise<BackendResult>((res, rej) => { resolve = res; reject = rej; });
    const ownId = kind === "command" ? null : inboxId(id, kind === "compact" ? "compact" : "turn");
    const run: Run = { onEvent, resolve, reject, kind, inboxId: ownId, packetId: typeof turn === "string" ? null : turn.relay.packetId, text, before: null, sent: false, delivered: false, inboxCancelled: false, begun: false,
      steers: new Set(), held: null, stopping: false, stop: null, settled: false, blocks: new Map(), tools: new Map(), steps: new Set(), usage: new TurnUsage(),
      window: this.model ? catalog.windows.get(this.model.providerID + "/" + this.model.id) : catalog.defaultModel ? catalog.windows.get(catalog.defaultModel) : undefined, retrying: false, refusedStop: false, compactions: 0 };
    if (kind === "command") {
      try { run.before = String(record((await this.client.data("GET", this.path("message") + OpenCodeApi.query({ order: "desc", limit: 1 })) as unknown[] | undefined)?.[0])?.id ?? "") || null; }
      catch { run.before = null; }
    }
    this.active = run;
    for (const note of this.notes.splice(0)) this.safeEmit(run, { type: "diagnostic", message: note });
    if (this.idleExecutions > 0) { this.safeEmit(run, { type: "diagnostic", message: "上一轮结束后 OpenCode 自己又跑了 " + this.idleExecutions + " 次（例如目标自动续跑），那些内容没有记进对话。" }); this.idleExecutions = 0; }
    void this.dispatch(run, reading, text, attachments);
    return { result, requestStop: () => {
      if (run.stop) return run.stop;
      if (run.settled || this.active !== run) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      run.stopping = true;
      run.stop = this.stopTurn(run);
      return run.stop;
    } };
  }
  /**
   * Sends what the Run carries. A refusal OpenCode gives only before it takes anything in is "not recorded"; any other failure may have admitted it: a prompt
   * or a compaction is sent once more under the same identity, which OpenCode keeps once (a repeated identity answers the item it already has), and what
   * still cannot be told stays unknown. A command takes no identity of ours, so its failure stays unknown.
   */
  private async dispatch(run: Run, reading: CommandClass, text: string, attachments: readonly ControlAttachment[]): Promise<void> {
    const files = attachments.filter(file => file.kind !== "file").map(file => ({ uri: pathToFileURL(file.path).href, name: file.name }));
    const send = (): Promise<unknown> => run.kind === "compact" ? this.client.call("POST", this.path("compact"), { id: run.inboxId })
      : run.kind === "command" ? this.client.call("POST", this.path("command"), { name: (reading as { name: string }).name, text: (reading as { args: string }).args })
      : this.client.call("POST", this.path("prompt"), { id: run.inboxId, text, ...(files.length ? { files } : {}) });
    for (let attempt = 0; ; attempt++) {
      try {
        await send(); run.sent = true;
        // A stop asked for while the prompt was on its way: it is taken back now that OpenCode has it, or its execution interrupted.
        if (run.stopping && !run.settled) {
          if (!run.delivered && run.inboxId !== null && this.has("inbox")) await this.client.call("DELETE", this.path("inbox", encodeURIComponent(run.inboxId))).catch(() => {});
          await this.client.call("POST", this.path("interrupt"), undefined, INTERRUPT_MS).catch(() => {});
        }
        return;
      }
      catch (error) {
        if (run.settled || this.active !== run) return;
        if (this.failure !== null) return;
        if (clearlyRefused(error)) {
          const gone = tagOf(error) === "SessionNotFoundError";
          if (gone) this.sessionGone = true;
          this.settle(run);
          run.resolve({ status: "failed", reason: "request_rejected", error: gone ? { code: "NATIVE_SESSION_NOT_FOUND", message: "OpenCode 里这个会话已经不在了，再发一次会在新会话里继续。" }
            : tagOf(error) === "CommandNotFoundError" ? { code: "NATIVE_COMMAND_UNAVAILABLE", message: "OpenCode 没有这个命令。" }
            : { code: "NATIVE_REQUEST_REFUSED", message: "OpenCode 拒绝了这条消息，它没有进入对话。" }, ...NOT_RECORDED });
          return;
        }
        if (attempt === 0 && run.inboxId !== null && error instanceof ControlError && (error.code === "NATIVE_CONNECTION_LOST" || error.code === "REQUEST_TIMEOUT" || (statusOf(error) ?? 0) >= 500)) continue;
        this.unsettled = true;
        this.settle(run);
        run.resolve({ status: "failed", reason: "dispatch_unknown", error: { code: "NATIVE_DELIVERY_UNKNOWN", message: "发给 OpenCode 时连接出了问题，不确定这条消息有没有进入对话；HarnessHub 不会自动重发。" } });
        return;
      }
    }
  }
  /**
   * HarnessHub's steer: the words as a prompt delivered `steer` into the execution that runs now (OpenCode takes them at its next step boundary, the same
   * turn). Taken once OpenCode admitted them; the Run then ends only after they were delivered (or cancelled), whichever execution delivers them.
   */
  async steer(id: NativeConversationId, text: string): Promise<SteerOutcome> {
    this.assertOwned(id);
    if (typeof text !== "string" || text.length === 0) throw new ControlError("INVALID_INPUT", "steering words must contain text");
    const run = this.live();
    if (!this.has("steer") || run === null || run.stopping || run.kind !== "prompt") return "not_taken";
    const steerId = inboxId(id, "steer");
    run.steers.add(steerId);
    try { await this.client.call("POST", this.path("prompt"), { id: steerId, text, delivery: "steer" }); }
    catch (error) {
      run.steers.delete(steerId);
      if (clearlyRefused(error)) { this.endIfHeld(run); return "not_taken"; }
      this.stranded.add(steerId);
      this.endIfHeld(run);
      throw error instanceof Error ? error : new ControlError("CONTROL_FAILED", "steer failed");
    }
    if (run.settled) { this.stranded.add(steerId); return "not_taken"; }
    return "taken";
  }
  /** Interrupts the execution (`POST /interrupt`); what was sent and not yet delivered is taken back from the inbox, which then says it never arrived. */
  private async stopTurn(run: Run): Promise<StopRequestReceipt> {
    this.cancelPermissions(run, true);
    for (const steer of run.steers) void this.client.call("DELETE", this.path("inbox", encodeURIComponent(steer))).catch(() => {});
    let answer: Row | null;
    try { answer = record(await this.client.call("POST", this.path("interrupt"), undefined, INTERRUPT_MS)); }
    catch (error) {
      if (run.settled) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
      throw error;
    }
    if (run.settled) return { requested: true };
    if (answer?.interrupted !== true) {
      if (!run.delivered && run.inboxId !== null && this.has("inbox")) await this.client.call("DELETE", this.path("inbox", encodeURIComponent(run.inboxId))).catch(() => {});
      else if (run.held !== null) this.finish(run, { ...run.held, status: "cancelled", reason: "interrupted" });
      else if (!run.sent && run.kind === "command") { this.unsettled = true; this.finish(run, { status: "cancelled", reason: "interrupted" }); }
    }
    return { requested: true };
  }

  // ---- events --------------------------------------------------------------------------------------------------------

  private emit(run: Run, event: ControlEvent): void { run.onEvent(event); }
  /** Hands an event to the Run's consumer; a consumer that throws ends the connection, as it always did. */
  private safeEmit(run: Run, event: ControlEvent): void {
    try { this.emit(run, event); } catch (error) { this.fail(error instanceof Error ? error : new ControlError("CONSUMER_FAILED", "event consumer failed")); }
  }
  private onEvent(event: Row): void {
    if (this.failure !== null) return;
    const type = typeof event.type === "string" ? event.type : "", data = record(event.data) ?? {};
    try {
      if (type === "permission.asked") { this.asked(data); return; }
      if (type === "permission.replied") { this.withdraw(data.requestID); return; }
      if (type === "form.created") { const form = record(data.form); if (form) this.formAsked(form); return; }
      if (type === "form.replied" || type === "form.cancelled") { this.withdraw(data.id ?? record(data.form)?.id); return; }
      if (type === "mcp.status.changed" && typeof data.name === "string") { this.servers.add(data.name); return; }
      const session = typeof data.sessionID === "string" ? data.sessionID : null;
      if (session === null) return;
      if (type === "session.created" && typeof data.parentID === "string" && (data.parentID === this.conversation || this.children.has(data.parentID))) { this.adopt(session, this.children.get(data.parentID) ?? null); return; }
      if (session === this.conversation) this.own(type, data);
      else if (this.children.has(session)) this.child(session, type, data);
      else this.counted++;
    } catch (error) { this.fail(error instanceof Error ? error : new ControlError("CONSUMER_FAILED", "event consumer failed")); }
  }
  /** An event of the session this connection opened. */
  private own(type: string, data: Row): void {
    const run = this.live();
    if (type === "session.deleted") { this.sessionGone = true; if (run) this.failRun(run, new ControlError("NATIVE_SESSION_NOT_FOUND", "OpenCode deleted this session")); return; }
    if (type === "session.model.selected") { this.nativeModel = refId(data.model) ?? this.nativeModel; const variant = record(data.model)?.variant; this.nativeVariant = typeof variant === "string" ? variant : null; return; }
    if (type === "session.agent.selected") { if (typeof data.agent === "string") this.nativeAgent = data.agent; return; }
    if (run === null) {
      this.counted++;
      if (type === "session.execution.started") this.idleExecutions++;
      return;
    }
    switch (type) {
      case "session.inbox.delivered": return this.delivered(run, String(data.inboxID ?? ""));
      case "session.inbox.cancelled": {
        const inbox = String(data.inboxID ?? "");
        if (inbox === run.inboxId) { run.inboxCancelled = true; if (run.stopping || !run.begun) this.finish(run, { status: "cancelled", reason: "interrupted", ...NOT_RECORDED }); return; }
        if (run.steers.delete(inbox)) { this.emit(run, { type: "notice", severity: "warning", title: "插话没有送到 OpenCode", detail: "这一轮先停了，插的那句话没有进入对话。" }); this.endIfHeld(run); }
        return;
      }
      case "session.execution.started": run.begun = true; run.held = null; return;
      case "session.execution.succeeded": case "session.execution.failed": case "session.execution.interrupted": return this.executionEnded(run, type, data);
      case "session.text.started": case "session.reasoning.started": case "session.tool.input.started": if (run.retrying) { run.retrying = false; this.emit(run, { type: "activity", id: "retry", kind: "retry", title: "模型请求重试", status: "completed" }); } break;
      default: break;
    }
    this.content(run, type, data, null);
  }
  /** Text, reasoning, tools, usage, retries and compaction of the Run's session (`parent` null) or of one of its sub-agent sessions. */
  private content(run: Run, type: string, data: Row, parent: string | null): void {
    const message = typeof data.assistantMessageID === "string" ? data.assistantMessageID : "";
    switch (type) {
      case "session.text.delta": case "session.reasoning.delta": case "session.text.ended": case "session.reasoning.ended": {
        if (parent !== null || !message || typeof data.ordinal !== "number") return;
        const reasoning = type.startsWith("session.reasoning."), key = message + (reasoning ? ":think:" : ":") + data.ordinal;
        if (type.endsWith(".delta")) { if (typeof data.delta === "string" && data.delta) this.say(run, key, reasoning, (run.blocks.get(key) ?? "") + data.delta); }
        else if (typeof data.text === "string") this.say(run, key, reasoning, data.text);
        return;
      }
      case "session.tool.input.started": {
        if (typeof data.id !== "string" || typeof data.name !== "string") return;
        this.tool(run, data.id, parent, { name: data.name, input: {}, status: "in_progress" });
        return;
      }
      case "session.tool.called": {
        if (typeof data.id !== "string") return;
        this.tool(run, data.id, parent, { input: data.input ?? {}, status: "in_progress" });
        return;
      }
      case "session.tool.progress": {
        if (typeof data.id !== "string") return;
        const metadata = record(data.metadata), child = typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined;
        if (child !== undefined && child !== this.conversation) this.adopt(child, this.toolKey(data.id, parent));
        const entry = run.tools.get(this.toolKey(data.id, parent)), plan = entry && toolKind(entry.name) === "plan" ? planOf(metadata) : null;
        if (plan) this.emit(run, { type: "plan", entries: plan });
        return;
      }
      case "session.tool.success": case "session.tool.failed": {
        if (typeof data.id !== "string") return;
        const key = this.toolKey(data.id, parent), entry = run.tools.get(key), name = entry?.name ?? "tool", metadata = data.metadata;
        if (type === "session.tool.success") {
          const child = typeof record(metadata)?.sessionID === "string" ? String(record(metadata)!.sessionID) : undefined;
          if (child !== undefined && child !== this.conversation) this.adopt(child, key);
          const plan = toolKind(name) === "plan" ? planOf(metadata) ?? planOf(entry?.input) : null;
          if (plan) this.emit(run, { type: "plan", entries: plan });
          const running = record(metadata)?.status === "running";
          this.tool(run, data.id, parent, { output: contentText(data.content), metadata, status: running ? "in_progress" : commandFailed(name, metadata) ? (run.stopping ? "cancelled" : "failed") : "completed" });
        } else {
          const error = record(data.error), aborted = error?.type === "aborted" || error?.type === "permission.rejected";
          this.tool(run, data.id, parent, { output: typeof error?.message === "string" ? error.message : contentText(data.content), metadata, failed: true, status: aborted || run.stopping ? "cancelled" : "failed" });
        }
        return;
      }
      case "session.step.started": {
        const model = refId(data.model);
        if (parent === null && model !== null) { this.nativeModel = model; void this.catalog(this.cwd!).then(catalog => { run.window = catalog.windows.get(model) ?? run.window; }, () => {}); }
        return;
      }
      case "session.step.ended": case "session.step.failed": {
        const tokens = tokensOf(data.tokens);
        if (tokens === null || !message || run.steps.has(message)) return;
        run.steps.add(message); run.usage.add(tokens, data.cost);
        this.emit(run, { type: "usage", usage: run.usage.value(run.window) });
        return;
      }
      case "session.retry.scheduled": {
        if (parent !== null) return;
        run.retrying = true;
        this.emit(run, { type: "activity", id: "retry", kind: "retry", title: "模型请求重试" + (typeof data.attempt === "number" ? "（第 " + data.attempt + " 次）" : ""), status: "running", detail: failureOf(data.error).message });
        return;
      }
      case "session.compaction.started": case "session.compaction.ended": case "session.compaction.failed": {
        if (parent !== null) return;
        if (type === "session.compaction.started") run.compactions++;
        const spent = type === "session.compaction.started" ? null : tokensOf(data.tokens);
        if (spent !== null && !run.steps.has("compaction:" + run.compactions)) { run.steps.add("compaction:" + run.compactions); run.usage.add(spent, data.cost); this.emit(run, { type: "usage", usage: run.usage.value(run.window) }); }
        const status = type === "session.compaction.started" ? "running" : type === "session.compaction.ended" ? "completed" : "failed";
        this.emit(run, { type: "activity", id: "compaction:" + run.compactions, kind: "compaction", title: data.reason === "auto" ? "上下文自动压缩" : "上下文压缩", status,
          ...(type === "session.compaction.failed" ? { detail: failureOf(data.error).message } : type === "session.compaction.ended" && typeof data.text === "string" && data.text.trim() ? { detail: data.text } : {}) });
        return;
      }
      default: return;
    }
  }
  /** Text of one block, said once: what the Run has not said of it yet. A block whose text no longer begins with what was said says nothing more. */
  private say(run: Run, key: string, reasoning: boolean, full: string): void {
    const said = run.blocks.get(key) ?? "";
    if (!full.startsWith(said) || full.length === said.length) return;
    run.blocks.set(key, full);
    this.emit(run, { type: reasoning ? "thinking" : "text", text: full.slice(said.length), item: key });
  }
  private toolKey(id: string, parent: string | null): string { return parent === null ? id : (parent.slice(0, 120) + "/" + id).slice(0, 256); }
  /** A tool call's state, merged and said whole (each event is the call as it stands). The question tool is the form it opens, said there. */
  private tool(run: Run, id: string, parent: string | null, change: { name?: string; input?: unknown; output?: string; metadata?: unknown; failed?: boolean; status: string }): void {
    const key = this.toolKey(id, parent), prior = run.tools.get(key);
    const name = change.name ?? prior?.name ?? "tool";
    if (toolKind(name) === "question") { if (!prior) run.tools.set(key, { name, input: {}, title: "", status: change.status, detail: {} }); return; }
    const input = change.input ?? prior?.input ?? {};
    const view = toolView({ name, input, ...(change.output !== undefined ? { output: change.output } : prior?.detail.output !== undefined ? { output: prior.detail.output } : {}),
      ...(change.metadata !== undefined ? { metadata: change.metadata } : {}), ...(prior?.diff ? { diff: prior.diff } : {}), ...(change.failed ? { failed: true } : {}) }, this.servers);
    const detail: NativeToolDetail = { ...view.detail, ...(parent === null ? {} : { parentId: parent }) };
    const entry: ToolEntry = { name, input, title: view.title, status: change.status, detail, ...(prior?.diff ? { diff: prior.diff } : {}), ...(prior?.child ? { child: prior.child } : {}) };
    run.tools.set(key, entry);
    this.emit(run, { type: "tool", id: key, title: entry.title, status: entry.status, detail });
  }
  private delivered(run: Run, inbox: string): void {
    if (inbox === run.inboxId) {
      if (run.delivered) return;
      run.delivered = true;
      this.emit(run, { type: "input_recorded", ...(run.packetId !== null && carriesPacket(run.text, run.packetId) ? { packetId: run.packetId } : {}) });
      return;
    }
    if (run.steers.delete(inbox)) { this.endIfHeld(run); return; }
    // A command takes no identity of ours: the input its template put in is the one the execution it started delivered.
    if (run.kind === "command" && !run.delivered && run.begun) { run.delivered = true; this.emit(run, { type: "input_recorded" }); }
  }
  private executionEnded(run: Run, type: string, data: Row): void {
    if (!run.begun) { this.counted++; return; }
    const recorded = run.delivered ? { input: "recorded" as const } : run.inboxCancelled ? NOT_RECORDED : {};
    const result: BackendResult = type === "session.execution.succeeded" ? (run.stopping ? { status: "cancelled", reason: "interrupted", ...recorded } : { status: "completed", reason: "completed", ...recorded })
      : type === "session.execution.interrupted" ? { status: "cancelled", reason: data.reason === "user" || run.stopping || run.refusedStop ? "interrupted" : "native_" + String(data.reason ?? "interrupted"), ...recorded }
      : { status: "failed", reason: "native_error", error: failureOf(data.error), ...recorded };
    // Words steered in and not yet delivered start another execution of this same turn.
    if (result.status === "completed" && run.steers.size > 0) { run.held = result; return; }
    this.finish(run, result);
  }
  private endIfHeld(run: Run): void { if (run.held !== null && run.steers.size === 0 && !run.settled) this.finish(run, run.held); }
  /** The Run ends: its turn's changes said as one call (`session.diff` from its prompt), then the result, once the stop answers of its requests went out. */
  private finish(run: Run, result: BackendResult): void {
    if (run.settled) return;
    run.settled = true;
    this.cancelPermissions(run, false);
    for (const steer of run.steers) this.stranded.add(steer);
    const done = () => { if (this.active === run) this.active = null; run.resolve(result); };
    if (!this.has("diff") || run.inboxId === null || !run.delivered || run.kind !== "prompt") { done(); return; }
    void this.client.data("GET", this.path("diff") + OpenCodeApi.query({ from: run.inboxId }), undefined, Math.min(this.options.requestTimeoutMs, 5000)).then(value => {
      const files = rows(value);
      const patches = files.flatMap(file => typeof file.patch === "string" ? [file.patch] : []), paths = files.flatMap(file => typeof file.file === "string" ? [file.file] : []);
      if (paths.length) this.safeEmit(run, { type: "tool", id: "turn-diff:" + run.inboxId, title: "本轮改动 " + paths.length + " 个文件", status: "completed",
        detail: { kind: "edit", name: "opencode_turn_diff", ...(patches.length ? { diff: patches.join("") } : {}), locations: paths.slice(0, 64) } });
    }, () => {}).finally(done);
  }
  private settle(run: Run): void { run.settled = true; this.cancelPermissions(run, false); if (this.active === run) this.active = null; }
  private failRun(run: Run, error: Error): void {
    if (run.settled) return;
    this.settle(run);
    run.reject(error);
  }

  // ---- sub-agent sessions --------------------------------------------------------------------------------------------

  /** A sub-agent session of the Run's (the `subagent` tool's child): its calls nest under that tool, its requests are said as the sub-agent's. */
  private adopt(child: string, parentTool: string | null): void {
    if (child === this.conversation) return;
    if (!this.children.has(child) || (parentTool !== null && this.children.get(child) === "")) this.children.set(child, parentTool ?? "");
    // The level's rules go to the child too (best effort: it outlives no Turn of its own).
    if (this.rules !== undefined && !this.childRules.has(child)) { this.childRules.add(child); void this.client.call("PATCH", "/api/session/" + encodeURIComponent(child), { permissions: this.currentRules() }).catch(() => {}); }
  }
  private child(session: string, type: string, data: Row): void {
    const run = this.live();
    if (run === null) { this.counted++; return; }
    const parent = this.children.get(session) || "agent:" + session.slice(0, 120);
    this.content(run, type, data, parent);
  }

  // ---- requests ------------------------------------------------------------------------------------------------------

  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable");
    if (pending.validate) { try { pending.validate(option, input); } catch { throw new ControlError("INVALID_INPUT", "invalid native input answer"); } }
    this.pending.delete(id); pending.resolve({ option, ...(input === undefined ? {} : { input }) });
  }
  /** Ends the waits of a Run: each request is answered as a stop (`stopping`) or withdrawn quietly. */
  private cancelPermissions(run: Run, stopping: boolean): void {
    for (const [id, pending] of this.pending) if (pending.run === run) { this.pending.delete(id); pending.resolve(stopping ? STOPPED : WITHDRAWN); }
  }
  /** OpenCode settled a request elsewhere (its reply event for one this connection did not answer): its prompt closes. */
  private withdraw(nativeId: unknown): void {
    if (typeof nativeId !== "string") return;
    for (const [id, pending] of this.pending) {
      if (pending.native !== nativeId) continue;
      this.pending.delete(id); pending.resolve(WITHDRAWN);
      if (this.active === pending.run && !pending.run.settled) this.safeEmit(pending.run, { type: "permission", id, decision: "cancelled" });
    }
  }
  private ask(run: Run, native: string, id: string, request: Omit<Extract<ControlEvent, { type: "permission_requested" }>, "type" | "id">, validate?: (option: string, input?: string) => void): Promise<Answer> {
    return new Promise<Answer>(resolve => {
      this.pending.set(id, { native, run, options: request.options.map(option => option.id), ...(validate ? { validate } : {}), resolve });
      this.emit(run, { type: "permission_requested", id, ...request });
    });
  }
  private sessionOf(id: unknown): "own" | "child" | null { return typeof id !== "string" ? null : id === this.conversation ? "own" : this.children.has(id) ? "child" : null; }
  /** `permission.asked`: the user decides on a public Run; otherwise it is refused with words, so the model goes on (refused plainly while the Turn stops). */
  private asked(request: Row): void {
    const whose = this.sessionOf(request.sessionID), nativeId = typeof request.id === "string" ? request.id : null;
    if (whose === null || nativeId === null) { if (nativeId !== null) this.counted++; return; }
    const session = String(request.sessionID), reply = (decision: "once" | "reject", message?: string) =>
      this.client.call("POST", "/api/session/" + encodeURIComponent(session) + "/permission/" + encodeURIComponent(nativeId) + "/reply", { decision, ...(message ? { message } : {}) }).then(() => {}, () => {});
    const run = this.live();
    if (run === null) { void reply("reject"); this.counted++; return; }
    if (!this.interactivePermissions || run.stopping) {
      this.emit(run, { type: "permission", id: nativeId, decision: run.stopping ? "cancelled" : "denied" });
      void reply("reject", run.stopping ? undefined : DECLINED);
      return;
    }
    const source = record(request.source), callId = typeof source?.id === "string" ? source.id : undefined;
    const parent = whose === "child" ? this.children.get(session) || "agent:" + session.slice(0, 120) : null;
    const callKey = callId === undefined ? undefined : this.toolKey(callId, parent), call = callKey === undefined ? undefined : run.tools.get(callKey);
    const diff = permissionDiff(request);
    if (diff && call) call.diff = diff;
    const view = permissionView(request, call, whose === "child"), action = typeof request.action === "string" ? request.action : "";
    const save = Array.isArray(request.save) ? request.save.filter((item): item is string => typeof item === "string" && item !== "") : [];
    const options: Choice[] = [{ id: "once", name: "允许一次" }, ...(save.length && this.rules !== undefined ? [{ id: "session", name: save.every(pattern => pattern === "*") ? "本次会话都允许" : "本次会话允许 " + line(save.join("、"), 120) }] : []),
      { id: "reject", name: "拒绝" }, { id: "stop", name: "拒绝并停止" }];
    const toolKind_ = actionKind(action, call ? toolKind(call.name, this.servers) : undefined, this.servers);
    void this.ask(run, nativeId, nativeId, { title: view.title, ...(view.detail ? { detail: view.detail } : {}), options, ...(callKey ? { forCall: callKey } : {}), ...(toolKind_ ? { toolKind: toolKind_ } : {}), ...requestExpiry(null) }).then(async answer => {
      if (answer === WITHDRAWN) return;
      if (answer === STOPPED) { await reply("reject"); return; }
      if (answer.option === "session") {
        for (const resource of save) if (!this.grants.some(rule => rule.action === action && rule.resource === resource)) this.grants.push({ action, resource, effect: "allow" });
        const rules = this.currentRules();
        await this.client.call("PATCH", this.path(), { permissions: rules }).then(() => { this.rules = rules; }, () => {});
      }
      if (answer.option === "once" || answer.option === "session") return reply("once");
      if (answer.option === "stop") run.refusedStop = true;
      return reply("reject", answer.option === "stop" ? undefined : answer.input?.trim() || DECLINED);
    }, () => {});
  }
  /** `form.created` (the `question` tool): its fields asked one at a time; a form the Hub cannot ask is cancelled, with why, so the model goes on. */
  private formAsked(form: Row): void {
    const whose = this.sessionOf(form.sessionID), nativeId = typeof form.id === "string" ? form.id : null;
    if (whose === null || nativeId === null) return;
    const session = String(form.sessionID), base = "/api/session/" + encodeURIComponent(session) + "/form/" + encodeURIComponent(nativeId);
    const cancel = (message?: string) => this.client.call("DELETE", base + (message ? OpenCodeApi.query({ message }) : "")).then(() => {}, () => {});
    const run = this.live();
    if (run === null) { void cancel("Nobody is there to answer."); return; }
    const plan = formQuestions(form);
    if ("unsupported" in plan) { this.emit(run, { type: "notice", severity: "warning", title: "OpenCode 的提问 HarnessHub 还答不了", detail: "它要的是" + plan.unsupported + "；已告诉它没人回答，它会接着做。" }); void cancel("This question cannot be answered here (" + plan.unsupported + ")."); return; }
    if (!this.interactivePermissions || run.stopping) { this.emit(run, { type: "permission", id: nativeId, decision: run.stopping ? "cancelled" : "denied" }); void cancel(run.stopping ? undefined : "The user is not available to answer."); return; }
    void (async () => {
      const answer: Record<string, string | readonly string[]> = {};
      for (const [index, question] of plan.questions.entries()) {
        const got = await this.ask(run, nativeId, nativeId + ":" + index, { title: (whose === "child" ? "子 Agent · " : "") + question.title, ...(question.detail ? { detail: question.detail } : {}), options: question.choices,
          ...(question.input ? { input: question.input } : {}), kind: "question", ...requestExpiry(null) }, (option, input) => { question.value(option, input); });
        if (got === WITHDRAWN) return;
        if (got === STOPPED) return cancel();
        const value = (question as FormQuestion).value(got.option, got.input);
        if (value === "cancel") return cancel("The user chose not to answer.");
        answer[question.key] = value;
      }
      await this.client.call("POST", base + "/reply", { answer }).catch(() => cancel());
    })().catch(() => {});
  }

  // ---- the stream ----------------------------------------------------------------------------------------------------

  /**
   * The event stream broke (ended, failed or fell silent): it is opened again (up to five times, a second apart), and what it missed is read back from the
   * session (T3 Code's reconcile, v2/adapter.ts:3505-3691): whether the execution still runs, the Run's messages (each piece of text said once, every call
   * as it stands, its usage), its end when one came, and the requests that still wait.
   */
  private streamLost(error: Error): void {
    this.stream = null;
    if (this.closing || this.failure !== null) return;
    this.reconnecting ??= (async () => {
      for (let attempt = 1; attempt <= RECONNECTS; attempt++) {
        await sleep(RECONNECT_DELAY_MS * attempt);
        if (this.closing || this.failure !== null || this.server.failure !== null) return;
        try { this.stream = await this.client.subscribe(this.handlers(), this.options.maxFrameBytes); }
        catch { continue; }
        const run = this.live();
        if (run !== null) this.safeEmit(run, { type: "diagnostic", message: "和 OpenCode 的事件流断开后又连上了，缺的部分从会话记录补齐。" });
        await this.reconcile().catch(() => {});
        return;
      }
      this.fail(error);
    })().finally(() => { this.reconnecting = null; });
  }
  private async reconcile(): Promise<void> {
    const run = this.live();
    if (run === null || this.conversation === null) return;
    const id = this.conversation, active = this.has("active") ? record(await this.client.data("GET", "/api/session/active")) : null, running = active !== null && Object.hasOwn(active, id);
    const start = run.inboxId ?? run.before;
    const recent = (start === null ? await this.messages(id) : (await this.messages(id, start)).reverse()).filter(message => typeof message.id === "string");
    const from = start === null ? 0 : Math.max(0, recent.findIndex(message => message.id === start));
    let ended: Row | null = null;
    for (const message of recent.slice(from)) {
      if (run.settled) return;
      if (message.type === "user" && message.id === run.inboxId) { run.begun = true; this.delivered(run, String(message.id)); continue; }
      if (message.type === "user" && run.steers.has(String(message.id))) { run.steers.delete(String(message.id)); continue; }
      if (message.type === "compaction" && message.id === run.inboxId) { run.begun = true; this.delivered(run, String(message.id)); continue; }
      if (message.type === "idle") { ended = message; continue; }
      if (message.type !== "assistant") continue;
      const content = Array.isArray(message.content) ? message.content : [], streaming = record(message.time)?.streamed === undefined, ordinals = { text: 0, reasoning: 0 };
      run.begun = true;
      for (const [index, value] of content.entries()) {
        const part = record(value);
        if (part === null) continue;
        if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
          const reasoning = part.type === "reasoning", key = String(message.id) + (reasoning ? ":think:" : ":") + ordinals[reasoning ? "reasoning" : "text"]++;
          // OpenCode saves a block's text when it ends: the last block of a message still streaming keeps what already arrived.
          if (!(streaming && index === content.length - 1)) this.say(run, key, reasoning, part.text);
          continue;
        }
        if (part.type === "tool" && typeof part.id === "string" && typeof part.name === "string") {
          const state = record(part.state), status = state?.status;
          this.tool(run, part.id, null, { name: part.name, input: state?.input ?? {}, ...(status === "completed" ? { output: contentText(state?.content), metadata: state?.metadata } : status === "error" ? { output: String(record(state?.error)?.message ?? ""), failed: true } : {}),
            status: status === "completed" ? (commandFailed(part.name, state?.metadata) ? "failed" : "completed") : status === "error" ? "failed" : "in_progress" });
        }
      }
      const tokens = tokensOf(message.tokens);
      if (tokens !== null && !run.steps.has(String(message.id)) && !streaming) { run.steps.add(String(message.id)); run.usage.add(tokens, message.cost); this.emit(run, { type: "usage", usage: run.usage.value(run.window) }); }
    }
    if (run.settled) return;
    if (running) {
      // Requests still waiting are asked again (one asked while the stream was gone is asked now); those gone are closed.
      if (this.has("permissions")) {
        const listed = rows(await this.client.data("GET", this.path("permission")).catch(() => null));
        for (const row of listed) if (typeof row.id === "string" && ![...this.pending.values()].some(entry => entry.native === row.id)) this.asked(row);
        const waiting = new Set(listed.map(row => row.id));
        for (const pending of [...this.pending.values()]) if (!waiting.has(pending.native) && !pending.native.startsWith("frm_")) this.withdraw(pending.native);
      }
      return;
    }
    if (ended !== null) { this.executionEnded(run, ended.outcome === "succeeded" ? "session.execution.succeeded" : ended.outcome === "failed" ? "session.execution.failed" : "session.execution.interrupted", { error: ended.error, reason: "user" }); return; }
    // Without an idle record the lost execution was interrupted (T3 Code's reading of a restarted server).
    if (run.begun) { this.unsettled = true; this.finish(run, { status: "cancelled", reason: "native_interrupted", ...(run.delivered ? { input: "recorded" as const } : {}) }); }
  }

  async close(): Promise<CleanupEvidence> {
    this.closing = true;
    this.stream?.close(); this.stream = null;
    for (const pending of this.pending.values()) pending.resolve(STOPPED);
    this.pending.clear();
    if (this.active && !this.active.settled) this.failRun(this.active, new ControlError("CLOSED", "connection closed by its owner"));
    return this.server.close();
  }
}

/** For tests and the replay recorder: the subagent output unwrapping and the inbox identity shape. */
export const internals = { subagentOutput, inboxId, mcpServer };
