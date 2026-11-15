import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TABLE_ENV, TABLE_INSTRUCTIONS_ENV, TABLE_LOAD_ENV, TABLE_MCP_NAME, TABLE_PROGRESS_ENV, TABLE_RECORD_ENV } from "../../../contracts/table.js";
import { nativeConversationId, sharedReading, type BackendResult, type CleanupEvidence, type CommandClass, type CommandLookup, type ControlEvent, type ControlLaunch, type ControlOptions,
  type ControlRun, type HarnessControl, type NativeConversationId, type NativeModelCatalog, type NativeOptions, type NativeSessionImport, type NativeSessionPage, type ProtocolObservation,
  type SteerOutcome, type StopRequestReceipt, type TurnText } from "../../../contracts/control.js";
import type { ContentKind, ContentRef, ControlAttachment } from "../../../contracts/content.js";
import type { RelayCapabilities, RelayPacketId } from "../../../contracts/relay.js";
import { levelOptions, sessionEntryOf } from "../../../contracts/flavor.js";
import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";
import { checkInputs, readAttachment } from "../../../infrastructure/control/attachments.js";
import { hubClearReading, nativeReading, relayCommands, relayDeclaration, type RelayClassify } from "../relay-classify.js";
import { carriesPacket, clearedNotice, COMMAND_REFUSED, hubCleared, measureBy, placeTurn } from "../relay-turn.js";
import { dshWebFlavor } from "../../flavors/dsh.js";
import { DshRemoteError, DshWebHost, WEB_UNAVAILABLE, type StreamHandle, type Waterfall } from "./host.js";
import { patchText, preflight, type WebFeature } from "./preflight.js";
import { added, approvalDetail, argumentsOf, callDetail, catalogOf, countersOf, DSH_EFFORTS, EFFORT_OPTION, field, historyOf, messageParts, modelId, planOf, resultDetail, routeOf, text,
  toolKind, turnResult, type Counters, type ToolCall } from "./mapping.js";

/** The only Web host command the Hub runs as a command Turn: `/compact` (dsh-command-compact, `commands/execute`), when the session's command list has it. */
export const DSH_WEB_COMMANDS = [{ name: "compact", description: "压缩上下文（dsh 的 /compact）", contextEffect: "compact" }] as const;
/**
 * The reading of dsh's inputs on either of its drivers: the Hub's clear (`/clear`, `/new`, `/reset` alone), the commands its catalog lists (the Web
 * host's `/compact`; dsh's ACP lists none, so there every other input is text, as before), and text.
 */
export function dshReading(text: string, commands: CommandLookup | null, attachments: readonly ContentKind[] = []): CommandClass {
  return hubClearReading(text, attachments) ?? sharedReading(text, commands);
}
export const dshWebClassify: RelayClassify = (text, catalog, attachments = []) => dshReading(text, catalog === null ? null : relayCommands(catalog), attachments);
/**
 * DeepSeek Harness's relay declaration on either of its drivers (ADR-055 §8.1): two text parts (dsh joins them into one user message); its first message,
 * thought or tool call is weak live evidence (the Web host also reports the durable user message, input_recorded), and a completed turn proves nothing by itself;
 * one process per connection; a native title by `session/rename` on the Web host (the ACP driver refuses it, which never fails the Turn).
 */
export const dshWebRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "agent_output", successProvesRecorded: false },
  execution: "process",
  commands: { classify: dshWebClassify },
  placement: { parts: "multiple", maxInput: null, measure: measureBy("multiple", "chars", ["file"]) },
  title: "set",
});

const APPROVAL_OPTIONS = [{ id: "allow-once", name: "允许一次" }, { id: "reject", name: "拒绝" }] as const;
/** How long a command's answer waits for its `command/done` on the follow stream. */
const COMMAND_EVENTS_WAIT_MS = 2000;
/** How long an approval waits for the call it names to arrive on the follow stream (the two come on different streams). */
const CALL_WAIT_MS = 1500;
interface Attempt { readonly turn: number; readonly step: number; text: string; reasoning: string }
interface Run {
  readonly id: NativeConversationId;
  readonly requestId: string | null;
  readonly command: string | null;
  readonly packetId: RelayPacketId | null;
  readonly onEvent: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  accepted: boolean;
  recorded: boolean;
  /** dsh turns this Run owns, and how each ended (null while it runs). */
  readonly turns: Map<number, { kind: string; code: string | null } | null>;
  lastEndSeq: number;
  readonly attempts: Map<string, Attempt>;
  readonly calls: Map<string, ToolCall>;
  readonly retries: Map<string, string>;
  /** The commands dsh reported done on the follow stream (`command/done`), by its command id. */
  readonly commands: Set<string>;
  usage: Counters | null;
  context: { used: number; size?: number } | undefined;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  settled: boolean;
}
interface OpenSession {
  readonly id: NativeConversationId;
  readonly cwd: string;
  follow: StreamHandle | null;
  state: StreamHandle | null;
  cursor: number;
  idle: { readonly cursor: number; readonly running: boolean; readonly waiting: boolean } | null;
  preset: string | null;
  route: { provider: string; model: string; reasoningEffort?: string } | null;
  contextWindow: number | null;
}
type Pending = { readonly kind: "approval"; readonly run: Run } | { readonly kind: "question"; readonly run: Run; readonly options: readonly string[]; readonly resolve: (answer: { readonly option: string; readonly input?: string } | null) => void };

/**
 * DeepSeek Harness on its Web host (`dsh --profile web`), the richer of its two drivers: words in the middle of a turn (`session/prompt` in `steer`
 * mode go into the turn's next model step), live text and thinking (`session/follow` with the Assistant stream), its own fork, title and `/compact`,
 * its permission preset set live (`/permission`), its own session list and history, images in the prompt and files through upload receipts. A Hub Turn
 * is one prompt: the dsh turns it starts and every one dsh runs on until the session is idle again (`session/observeState`: nothing running, nothing
 * queued), with the result read from the last `turn/end`. What dsh's ACP driver read back from the session log (usage, the file changes, how a turn
 * ended) comes on the follow stream itself. The process is started for the conversation's first session (open), with an overlay (`--patch`) that
 * gives its sessions the Hub's tools and model and keeps it from writing the user's profile; the user's own `~/.dsh` is its home.
 */
export class DshWebControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = dshWebRelayCapabilities;
  private host: DshWebHost | null = null;
  private starting: Promise<void> | null = null;
  private patchDir: string | null = null;
  private initialized = false;
  private version: string | null = null;
  private features: ReadonlySet<WebFeature> = new Set();
  private session: OpenSession | null = null;
  /** A new session open() named: dsh creates it with the first prompt (or title), so that one never prompted leaves nothing in the user's dsh. */
  private pendingCreate: { readonly id: NativeConversationId; readonly cwd: string } | null = null;
  private readonly abandoned = new Set<string>();
  private active: Run | null = null;
  private interactive = false;
  private instructions: string | null = null;
  private progress: boolean | undefined;
  private readonly pending = new Map<string, Pending>();
  private unattributed = 0;
  private commandNames: readonly string[] | null = null;
  private lastCatalog: NativeModelCatalog | null = null;
  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {}

  get unattributedUpdates(): number { return this.unattributed; }
  get steering(): boolean { return this.initialized && (this.host === null || this.host.failure === null); }
  get sessionTools(): boolean { return this.toolServer() !== null; }
  healthy(): boolean { return this.initialized && (this.host === null || this.host.failure === null); }
  processGroup(): number | null { return this.host?.processGroup ?? null; }
  diagnosticMark(): number { return this.host?.stderrMark ?? 0; }
  diagnosticsSince(mark: number): string { return this.host?.stderrSince(mark) ?? ""; }
  enablePermissions(): void { this.interactive = true; }
  setSessionInstructions(text: string | null, tools?: { readonly progress: boolean }): void { this.instructions = text; this.progress = tools?.progress; }

  /** The static check (preflight.ts); nothing is started. Rejects with DSH_WEB_UNAVAILABLE, saying why, when this dsh cannot be driven so. */
  async initialize(): Promise<ProtocolObservation> {
    const checked = await preflight(this.launch.executable);
    if (!checked.ok) throw new ControlError(WEB_UNAVAILABLE, checked.reason);
    this.version = checked.version; this.features = checked.features; this.initialized = true;
    return { protocol: "dsh-web", protocolVersion: null, agentName: "dsh", agentVersion: checked.version, authenticationMethods: [], capabilities: { host: "web", features: [...checked.features] } };
  }
  private assertInitialized(): void { if (!this.initialized) throw new ControlError("INVALID_STATE", "the dsh Web driver is not initialized"); }
  /** The Hub's tool server as the overlay gives it, or null: the declaration hands the tools over per session and the process carries the table. */
  private toolServer(): { readonly command: string; readonly args: readonly string[] } | null {
    const entry = this.options.entry ?? sessionEntryOf(this.options.flavor);
    if (entry.tools !== "acp") return null;
    const tool = fileURLToPath(new URL("../../../cli/hub-tools.js", import.meta.url));
    return this.options.env[TABLE_ENV.url] && this.options.env[TABLE_ENV.session] && existsSync(tool) ? { command: process.execPath, args: [tool, "mcp"] } : null;
  }
  /** Starts the Web host once, with the overlay of this process: the tools, the instructions said now, and the model a new session starts on. */
  private ensureHost(route: OpenSession["route"]): Promise<void> {
    this.assertInitialized();
    this.starting ??= (async () => {
      const server = this.toolServer(), entry = this.options.entry ?? sessionEntryOf(this.options.flavor);
      const env: Record<string, string> = {};
      if (this.progress === false) env[TABLE_PROGRESS_ENV] = "off";
      if (server !== null && this.instructions !== null && entry.instructions === "mcp-instructions") env[TABLE_INSTRUCTIONS_ENV] = this.instructions;
      const fromProcess = [TABLE_ENV.url, TABLE_ENV.session, TABLE_RECORD_ENV, TABLE_LOAD_ENV].filter(name => this.options.env[name]);
      const dir = await mkdtemp(join(this.options.env.TMPDIR && isAbsolute(this.options.env.TMPDIR) ? this.options.env.TMPDIR : tmpdir(), "dsh-web-"));
      this.patchDir = dir;
      await chmod(dir, 0o700);
      const patch = join(dir, "harnesshub.patch.yml");
      await writeFile(patch, patchText({ tools: server === null ? null : { name: TABLE_MCP_NAME, ...server, env, fromProcess }, model: route }), { mode: 0o600 });
      const host = new DshWebHost(this.launch, this.options, { emit: (event, args) => this.emitted(event, args), waterfall: frame => void this.waterfall(frame), withdrawn: id => this.withdrawn(id), failure: error => this.failed(error) });
      this.host = host;
      const rest: string[] = [];
      for (let i = 0; i < this.launch.args.length; i++) { const arg = this.launch.args[i]!; if (arg === "--profile") { i++; continue; } if (!arg.startsWith("--profile=")) rest.push(arg); }
      await host.start([...rest, "--profile", "web", "--patch", patch, "--no-open", "--host", "127.0.0.1", "--port", "0"]);
    })();
    return this.starting;
  }
  private get web(): DshWebHost {
    if (this.host === null || !this.host.started) throw new ControlError("INVALID_STATE", "the dsh Web host is not running");
    return this.host;
  }
  /** Whether the Web host could be reached for this connection: it started (a failure after that is the connection's own). */
  get hostStarted(): boolean { return this.host?.started === true; }

  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    if (this.session !== null || this.pendingCreate !== null) throw new ControlError("INVALID_STATE", "this connection already owns a session");
    const route = model === undefined ? null : routeOf(model);
    if (model !== undefined && route === null) throw new ControlError("MODEL_UNAVAILABLE", "selected model is unavailable in this Harness");
    const restored = checkpoint !== undefined;
    const values = levelOptions(this.options.flavor, [DSH_EFFORTS], native, { ...(this.options.permission === undefined ? {} : { permission: this.options.permission }),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }) }, restored);
    const effort = values?.[EFFORT_OPTION];
    const wanted = route === null ? null : { ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
    await this.ensureHost(wanted);
    if (checkpoint === undefined) {
      const id = nativeConversationId("session-" + randomUUID());
      this.pendingCreate = { id, cwd };
      this.wantedRoute = wanted; this.wantedEffort = route === null ? effort ?? null : null;
      return id;
    }
    const id = nativeConversationId(checkpoint);
    try { await this.web.call("session/events", { request: { address: { kind: "session", sessionId: id }, throughSeq: 0 } }); }
    catch (error) { if (error instanceof DshRemoteError && error.dshCode === "session/not-found") throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the Harness has no session with this identity"); throw error; }
    this.abandoned.delete(id);
    await this.attach(id, cwd);
    await this.applyLevels(wanted, route === null ? effort ?? null : null);
    return id;
  }
  private wantedRoute: OpenSession["route"] = null;
  private wantedEffort: string | null = null;
  /** Follows the session: its durable events with the live Assistant stream, and its running state; resolves with the opening snapshot. */
  private async attach(id: NativeConversationId, cwd: string): Promise<void> {
    const session: OpenSession = { id, cwd, follow: null, state: null, cursor: -1, idle: null, preset: null, route: null, contextWindow: null };
    this.session = session;
    let opened!: () => void, refused!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { opened = resolve; refused = reject; });
    session.follow = this.web.open("session/follow", { request: { address: { kind: "session", sessionId: id }, assistantStream: true } }, {
      item: value => {
        if (field(value, "type") === "snapshot") {
          const header = field(value, "header"), values = field(field(value, "projections"), "values");
          if (text(field(header, "cwd")) !== undefined && field(header, "cwd") !== cwd) { refused(new ControlError("IDENTITY_MISMATCH", "the dsh session belongs to another folder")); return; }
          session.cursor = typeof field(value, "cursor") === "number" ? field(value, "cursor") as number : session.cursor;
          session.preset = text(field(field(values, "permissions"), "currentValue")) ?? null;
          const window = field(field(values, "contextPressure"), "contextWindow");
          if (typeof window === "number" && window > 0) session.contextWindow = window;
          const selection = field(field(values, "modelSelection"), "next") ?? field(field(values, "modelSelection"), "lastUsed");
          if (text(field(selection, "provider")) && text(field(selection, "model"))) session.route = { provider: text(field(selection, "provider"))!, model: text(field(selection, "model"))!, ...(text(field(selection, "reasoningEffort")) ? { reasoningEffort: text(field(selection, "reasoningEffort"))! } : {}) };
          opened(); return;
        }
        this.followed(session, value);
      },
      end: error => { refused(error ?? new ControlError("CONNECTION_LOST", "dsh ended the session's follow stream")); if (this.session === session) this.lost(error ?? new ControlError("CONNECTION_LOST", "dsh ended the session's follow stream")); },
    });
    session.state = this.web.open("session/observeState", { request: { sessionId: id } }, {
      item: value => {
        const cursor = field(value, "cursor"), queue = field(value, "queue"), pending = field(value, "pendingInput");
        session.idle = { cursor: typeof cursor === "number" ? cursor : -1, running: field(value, "running") === true,
          waiting: (Array.isArray(queue) && queue.length > 0) || (Array.isArray(pending) && pending.length > 0) };
        this.maybeSettle();
      },
      end: error => { if (this.session === session && error !== null) this.lost(error); },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ControlError("NATIVE_SESSION_TIMEOUT", "dsh did not open the session's follow stream")), this.options.startupTimeoutMs ?? this.options.requestTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  /** The preset the Hub's level names (its environment, DSH_PERMISSION_MODE) and the model and effort asked for, applied to the session live where it differs. */
  private async applyLevels(route: OpenSession["route"], effortOnly: string | null): Promise<void> {
    const session = this.session!, preset = this.launch.env.DSH_PERMISSION_MODE;
    if (preset !== undefined && session.preset !== null && session.preset !== preset) {
      const result = await this.web.call("commands/execute", { agentId: session.id, line: "/permission " + preset, submittedAttachments: [] });
      if (field(field(result, "result"), "kind") !== "success") throw new ControlError("NATIVE_OPTION_MISMATCH", "dsh did not switch the session's permission preset");
      session.preset = preset;
    }
    let current = session.route;
    if (route === null && effortOnly !== null && current === null) {
      const fallback = field(await this.web.call("session/modelCatalog", {}), "default");
      if (text(field(fallback, "provider")) && text(field(fallback, "model"))) current = { provider: text(field(fallback, "provider"))!, model: text(field(fallback, "model"))!, ...(text(field(fallback, "reasoningEffort")) ? { reasoningEffort: text(field(fallback, "reasoningEffort"))! } : {}) };
    }
    const target = route ?? (effortOnly !== null && current !== null ? { ...current, reasoningEffort: effortOnly } : null);
    if (target === null || (current !== null && current.provider === target.provider && current.model === target.model && (target.reasoningEffort === undefined || current.reasoningEffort === target.reasoningEffort))) return;
    try { await this.web.call("session/selectModel", { request: { sessionId: session.id, provider: target.provider, model: target.model, ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }) } }); }
    catch (error) { if (error instanceof DshRemoteError && error.dshCode === "session/model-unavailable") throw new ControlError("MODEL_UNAVAILABLE", "selected model is unavailable in this Harness"); throw error; }
    session.route = { ...target };
  }
  /** Creates the session open() named, with the first thing sent to it. */
  private async ensureCreated(id: NativeConversationId): Promise<void> {
    const pending = this.pendingCreate;
    if (pending === null) { if (this.session?.id !== id) throw new ControlError("IDENTITY_MISMATCH", "conversation is not owned by this connection"); return; }
    if (pending.id !== id) throw new ControlError("IDENTITY_MISMATCH", "conversation is not owned by this connection");
    const created = await this.web.call("session/create", { request: { cwd: pending.cwd, sessionId: id } });
    if (field(created, "sessionId") !== id) throw new ControlError("IDENTITY_MISMATCH", "dsh created the session under another identity");
    this.pendingCreate = null;
    await this.attach(id, pending.cwd);
    // A new session starts on the overlay's default (the model and effort asked for), with nothing recorded of its own yet.
    if (this.session!.route === null && this.wantedRoute !== null) this.session!.route = { ...this.wantedRoute };
    await this.applyLevels(this.wantedRoute, this.wantedEffort);
  }
  async checkpoint(): Promise<string | null> { return this.session?.id ?? this.pendingCreate?.id ?? null; }

  async models(): Promise<NativeModelCatalog> {
    await this.ensureHost(null);
    const value = await this.web.call("session/modelCatalog", {});
    const route = this.session?.route;
    const catalog = catalogOf(value, route ? [route] : []);
    if (this.session !== null && this.commandNames === null) {
      try { const listed = await this.web.call("commands/list", { agentId: this.session.id }); this.commandNames = Array.isArray(listed) ? listed.flatMap(row => text(field(row, "name")) ?? []) : []; }
      catch (error) { if (!(error instanceof DshRemoteError)) throw error; }
    }
    const commands = DSH_WEB_COMMANDS.filter(command => this.commandNames === null || this.commandNames.includes(command.name)).map(command => ({ ...command }));
    const providers = field(value, "routableProviders");
    this.lastCatalog = { ...catalog, ...(route ? { defaultModel: modelId(route.provider, route.model) } : {}), authentication: Array.isArray(providers) && providers.length > 0 ? "ready" : "unknown",
      inputs: { image: true, audio: false, file: true }, commands, flavor: dshWebFlavor };
    return this.lastCatalog;
  }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    const route = this.session?.route;
    if (route === null || route === undefined) return null;
    return { model: modelId(route.provider, route.model), options: route.reasoningEffort === undefined ? {} : { [EFFORT_OPTION]: route.reasoningEffort } };
  }
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass {
    return nativeReading(dshReading(text, catalog === null ? null : name => { const listed = catalog.commands?.find(command => command.name === name); return listed === undefined ? undefined : listed.contextEffect === undefined ? {} : { effect: listed.contextEffect }; }, attachments));
  }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    const route = this.session?.route ?? this.wantedRoute, image = route === null || !this.textOnly.has(modelId(route.provider, route.model));
    checkInputs(attachments, { image, audio: false, file: this.features.has("files") }, { image: 50 * 1024 * 1024 });
  }

  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    this.assertInitialized();
    if (this.active !== null && !this.active.settled) throw new ControlError("INVALID_STATE", "a prompt is already active");
    const prompt = typeof turn === "string" ? turn : turn.user, kinds = attachments.map(file => file.kind);
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const listed: readonly { readonly name: string; readonly contextEffect?: string }[] = this.lastCatalog?.commands ?? DSH_WEB_COMMANDS;
    const reading = dshReading(prompt, name => { const command = listed.find(row => row.name === name); return command === undefined ? undefined : command.contextEffect === undefined ? {} : { effect: command.contextEffect as "compact" }; }, kinds);
    // The Hub's clear: nothing is sent; the session is given up, and the next Turn opens a new one.
    if (typeof turn === "string" && reading.kind === "command" && reading.effect === "clear") {
      if (this.session?.id !== id && this.pendingCreate?.id !== id) throw new ControlError("IDENTITY_MISMATCH", "conversation is not owned by this connection");
      this.abandon();
      onEvent(clearedNotice(reading.name, "DeepSeek Harness"));
      return { result: Promise.resolve(hubCleared()), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a clear the Hub runs itself has no native turn to stop")) };
    }
    if (typeof turn !== "string" && reading.kind !== "content") return { result: Promise.resolve(COMMAND_REFUSED), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent")) };
    await this.ensureCreated(id);
    const command = reading.kind === "command" ? reading.name : null;
    let resolve!: (result: BackendResult) => void, reject!: (error: Error) => void;
    const result = new Promise<BackendResult>((ok, fail) => { resolve = ok; reject = fail; });
    const run: Run = { id, requestId: command === null ? randomUUID() : null, command, packetId: typeof turn === "string" ? null : turn.relay.packetId, onEvent, resolve: value => { if (!run.settled) { run.settled = true; this.settled(run); resolve(value); } },
      reject: error => { if (!run.settled) { run.settled = true; this.settled(run); reject(error); } }, accepted: false, recorded: false, turns: new Map(), lastEndSeq: -1, attempts: new Map(), calls: new Map(), retries: new Map(), commands: new Set(),
      usage: null, context: undefined, stopping: false, stop: null, settled: false };
    this.active = run;
    if (command !== null) void this.runCommand(run, prompt);
    else void this.sendPrompt(run, turn, attachments);
    return { result, requestStop: () => this.requestStop(run) };
  }
  private async sendPrompt(run: Run, turn: TurnText, attachments: readonly ControlAttachment[]): Promise<void> {
    try {
      const parts: Record<string, unknown>[] = (typeof turn === "string" ? [turn] : placeTurn(turn, dshWebRelayCapabilities.placement)).map(value => ({ type: "text", text: value }));
      for (const file of attachments) {
        const data = (await readAttachment(file)).toString("base64");
        if (file.kind === "image") parts.push({ type: "image", mediaType: file.mediaType, data, name: file.name });
        else {
          const upload = await this.web.call("fileUploads/upload", { agentId: run.id, request: { data, name: file.name } });
          const receipt = text(field(upload, "receiptId"));
          if (receipt === undefined) throw new ControlError("INVALID_PROTOCOL", "dsh gave no receipt for an uploaded file");
          parts.push({ type: "file", receiptId: receipt });
        }
      }
      await this.web.call("session/prompt", { request: { requestId: run.requestId, sessionId: run.id, mode: "queue", content: parts } }, this.options.requestTimeoutMs);
      run.accepted = true;
      if (run.stopping) void this.web.call("session/cancel", { request: { sessionId: run.id } }).catch(() => {});
      this.maybeSettle();
    } catch (error) {
      // dsh refuses a prompt before it enters the inbox (dsh-api-session-controller: content, images, model admission), so nothing is in its history.
      if (error instanceof DshRemoteError) {
        if (error.reason === "MODEL_DOES_NOT_SUPPORT_IMAGES" && this.session?.route) this.textOnly.add(modelId(this.session.route.provider, this.session.route.model));
        run.resolve({ status: "failed", reason: "request_rejected", input: "not_recorded", error: refusal(error) }); return;
      }
      run.reject(error instanceof Error ? error : new ControlError("CONTROL_FAILED", "the prompt failed"));
    }
  }
  /** Models dsh refused an image for on this connection (`MODEL_DOES_NOT_SUPPORT_IMAGES`): it says so only when asked, so the next image is refused here, before anything is sent. */
  private readonly textOnly = new Set<string>();
  private async runCommand(run: Run, line: string): Promise<void> {
    try {
      const value = await this.web.call("commands/execute", { agentId: run.id, line: line.trim(), submittedAttachments: [] }, null);
      const done = field(value, "result"), kind = field(done, "kind"), commandId = text(field(value, "commandId"));
      // Its events (a compaction's start and end) come on the follow stream, which may be behind the answer: the Turn ends once they are in.
      for (const until = Date.now() + COMMAND_EVENTS_WAIT_MS; commandId !== undefined && !run.commands.has(commandId) && Date.now() < until && !run.settled;) await new Promise(resolve => setTimeout(resolve, 25));
      run.accepted = true;
      if (kind === "success") run.resolve({ status: "completed", reason: "command" });
      else run.resolve({ status: "failed", reason: "command_failed", error: { code: "NATIVE_COMMAND_FAILED", message: "dsh 没有执行 /" + run.command + "（它的说明记在 dsh 的会话里）。/" + run.command + " 要在会话空闲时才能执行。" } });
    } catch (error) {
      if (error instanceof DshRemoteError) { run.resolve({ status: "failed", reason: "request_rejected", input: "not_recorded", error: refusal(error) }); return; }
      run.reject(error instanceof Error ? error : new ControlError("CONTROL_FAILED", "the command failed"));
    }
  }
  private requestStop(run: Run): Promise<StopRequestReceipt> {
    if (run.stop) return run.stop;
    if (run.settled) return Promise.reject(new ControlError("INVALID_STATE", "prompt has already ended"));
    run.stopping = true;
    for (const [id, pending] of this.pending) if (pending.run === run) { this.pending.delete(id); if (pending.kind === "question") pending.resolve(null); else void this.answer(id, "rejected"); run.onEvent({ type: "permission", id, decision: "cancelled" }); }
    run.stop = this.web.call("session/cancel", { request: { sessionId: run.id } }).then(() => ({ requested: true as const }));
    return run.stop;
  }
  /**
   * HarnessControl.steer: `session/prompt` in `steer` mode while this connection's Turn runs; dsh puts the words into the turn's next model step (its
   * `next-step` inbox), and the Turn goes on until the session is idle, so they are answered in it. Without a running Turn nothing is sent: dsh would
   * start a turn of its own with them.
   */
  async steer(id: NativeConversationId, words: string): Promise<SteerOutcome> {
    if (this.session?.id !== id) throw new ControlError("IDENTITY_MISMATCH", "conversation is not owned by this connection");
    if (typeof words !== "string" || words.length === 0) throw new ControlError("INVALID_INPUT", "steering words must contain text");
    const run = this.active;
    if (run === null || run.settled || run.stopping || run.command !== null || !run.accepted) return "not_taken";
    try { await this.web.call("session/prompt", { request: { requestId: randomUUID(), sessionId: id, mode: "steer", content: [{ type: "text", text: words }] } }); }
    catch (error) { if (error instanceof DshRemoteError) return "not_taken"; throw error; }
    return "taken";
  }

  private followed(session: OpenSession, value: unknown): void {
    if (field(value, "type") === "event") {
      const event = field(value, "event"), seq = field(event, "seq");
      if (typeof seq === "number") session.cursor = Math.max(session.cursor, seq);
      this.durable(session, text(field(event, "type")) ?? "", field(event, "data"), typeof seq === "number" ? seq : -1);
      this.maybeSettle();
      return;
    }
    if (field(value, "type") === "assistant-stream") this.live(field(value, "frame"));
  }
  private durable(session: OpenSession, type: string, data: unknown, seq: number): void {
    if (type === "permission/preset") { session.preset = text(field(data, "preset")) ?? session.preset; return; }
    if (type === "model/selection" && text(field(data, "provider")) && text(field(data, "model"))) {
      session.route = { provider: text(field(data, "provider"))!, model: text(field(data, "model"))!, ...(text(field(data, "reasoningEffort")) ? { reasoningEffort: text(field(data, "reasoningEffort"))! } : {}) }; return;
    }
    if (type === "request/context") { const window = field(data, "contextWindow"); if (typeof window === "number") session.contextWindow = window; return; }
    if (type === "request/header") {
      const config = field(field(data, "header"), "config");
      if (text(field(config, "provider")) && text(field(config, "model"))) session.route = { provider: text(field(config, "provider"))!, model: text(field(config, "model"))!, ...(text(field(config, "reasoningEffort")) ? { reasoningEffort: text(field(config, "reasoningEffort"))! } : {}) };
      return;
    }
    const run = this.active;
    if (run === null || run.settled || run.id !== session.id) { if (type === "turn/start") this.unattributed++; return; }
    const emit = run.onEvent;
    switch (type) {
      case "turn/start": { const turn = field(data, "turn"); if (typeof turn === "number") run.turns.set(turn, null); if (run.stopping) void this.web.call("session/cancel", { request: { sessionId: run.id } }).catch(() => {}); return; }
      case "turn/end": {
        const turn = field(data, "turn"), reason = field(data, "reason"), kind = text(field(reason, "kind")) ?? "completed", code = text(field(field(reason, "error"), "code"));
        if (typeof turn === "number") run.turns.set(turn, { kind, code: code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null });
        run.lastEndSeq = Math.max(run.lastEndSeq, seq);
        for (const [id, title] of run.retries) emit({ type: "activity", id, kind: "retry", title, status: kind === "completed" ? "completed" : "failed" });
        run.retries.clear();
        return;
      }
      case "user/message": {
        if (field(field(data, "source"), "kind") !== "user" || field(field(data, "source"), "rpcId") !== run.requestId || run.recorded) return;
        run.recorded = true;
        const said = field(data, "content"), words = Array.isArray(said) ? said.map(block => text(field(block, "text")) ?? "").join("") : "";
        emit({ type: "input_recorded", ...(run.packetId !== null && carriesPacket(words, run.packetId) ? { packetId: run.packetId } : {}) });
        return;
      }
      case "assistant/message": {
        const message = field(data, "message"), parts = messageParts(message), item = text(field(message, "id")) ?? "message-" + seq;
        const turn = field(data, "turn"), step = field(data, "step");
        const found = [...run.attempts.entries()].reverse().find(([, attempt]) => attempt.turn === turn && attempt.step === step);
        if (found !== undefined) run.attempts.delete(found[0]);
        const rest = (whole: string, streamed: string | undefined): { readonly text: string; readonly item: string } =>
          streamed !== undefined && whole.startsWith(streamed) ? { text: whole.slice(streamed.length), item: found![0] } : { text: whole, item };
        const thought = rest(parts.reasoning, found?.[1].reasoning), said = rest(parts.text, found?.[1].text);
        if (thought.text) emit({ type: "thinking", text: thought.text, item: thought.item });
        if (said.text) emit({ type: "text", text: said.text, item: said.item });
        for (const [id, title] of run.retries) emit({ type: "activity", id, kind: "retry", title, status: "completed" });
        run.retries.clear();
        const counters = countersOf(field(data, "usage"));
        if (counters !== null) {
          run.usage = added(run.usage, counters);
          run.context = { used: counters.input + counters.cachedInput + counters.cacheWrite + counters.output, ...(session.contextWindow === null ? {} : { size: session.contextWindow }) };
          emit({ type: "usage", usage: { turn: { ...run.usage }, context: run.context } });
        }
        return;
      }
      case "tool/call": {
        const id = text(field(data, "callId")), name = text(field(data, "name"));
        if (id === undefined || name === undefined) return;
        const call: ToolCall = { id, name, args: argumentsOf(field(data, "arguments")) };
        run.calls.set(id, call);
        emit({ type: "tool", id, title: name, status: "in_progress", detail: callDetail(call) });
        return;
      }
      case "tool/result": {
        const id = text(field(field(data, "message"), "toolCallId")), call = id === undefined ? undefined : run.calls.get(id);
        if (call === undefined) return;
        const done = resultDetail(call, data);
        emit({ type: "tool", id: call.id, title: call.name, status: done.failed ? "failed" : "completed", detail: done.detail });
        return;
      }
      case "command/done": { const commandId = text(field(data, "commandId")); if (commandId !== undefined) run.commands.add(commandId); return; }
      case "todo/write": { const entries = planOf(field(data, "todos")); if (entries !== null) emit({ type: "plan", entries }); return; }
      case "compaction/start": case "compaction/end": {
        const id = text(field(data, "compactionId")); if (id === undefined) return;
        emit({ type: "activity", id, kind: "compaction", title: "上下文压缩", status: type === "compaction/start" ? "running" : "completed" }); return;
      }
      case "llm/retry": {
        const id = text(field(data, "retryId")), retry = field(data, "retry"), most = field(data, "maxRetries");
        if (id === undefined) return;
        const title = "模型请求出错，正在重试" + (typeof retry === "number" ? "（第 " + retry + (typeof most === "number" ? "/" + most : "") + " 次）" : "");
        run.retries.set(id, title);
        emit({ type: "activity", id, kind: "retry", title, status: "running" });
        return;
      }
      default: return;
    }
  }
  /** The live Assistant stream: text and thinking as dsh's model writes them, each attempt its own item; the durable message then adds only what was missed. */
  private live(frame: unknown): void {
    const run = this.active;
    if (run === null || run.settled) return;
    const attempt = text(field(frame, "attemptId"));
    if (attempt === undefined) return;
    if (field(frame, "type") === "start") {
      const turn = field(frame, "turn"), step = field(frame, "step");
      if (typeof turn === "number" && typeof step === "number") run.attempts.set(attempt, { turn, step, text: "", reasoning: "" });
      return;
    }
    if (field(frame, "type") !== "chunk") return;
    const known = run.attempts.get(attempt), chunk = field(frame, "chunk"), kind = field(chunk, "type"), delta = text(field(chunk, "text"));
    if (known === undefined) return;
    if (kind === "text-delta" && delta) { known.text += delta; run.onEvent({ type: "text", text: delta, item: attempt }); }
    else if (kind === "reasoning-delta" && delta) { known.reasoning += delta; run.onEvent({ type: "thinking", text: delta, item: attempt }); }
    else if (kind === "block-end" && field(field(chunk, "block"), "type") === "tool-call") {
      const block = field(chunk, "block"), id = text(field(block, "id")), name = text(field(block, "name"));
      if (id !== undefined && name !== undefined && !run.calls.has(id)) run.calls.set(id, { id, name, args: argumentsOf(field(block, "arguments")) });
    }
  }
  /** A Hub Turn ends once dsh is idle with nothing queued, every turn it started has ended, and the follow stream has caught up with that state. */
  private maybeSettle(): void {
    const run = this.active, session = this.session;
    if (run === null || run.settled || session === null || !run.accepted || run.command !== null) return;
    const idle = session.idle;
    if (idle === null || idle.running || idle.waiting || idle.cursor < run.lastEndSeq || session.cursor < idle.cursor) return;
    if ([...run.turns.values()].some(end => end === null)) return;
    // Stopped before dsh began a turn with it: the prompt left its queue unanswered, and whether it is in the history is not known.
    if (run.turns.size === 0) { if (run.stopping) run.resolve({ status: "cancelled", reason: "cancelled" }); return; }
    const last = [...run.turns.entries()].sort((a, b) => a[0] - b[0]).at(-1)![1]!;
    run.resolve({ ...turnResult(last.kind, last.code, run.stopping), ...(run.recorded ? { input: "recorded" as const } : {}) });
  }
  private settled(run: Run): void {
    for (const [id, pending] of this.pending) if (pending.run === run) { this.pending.delete(id); if (pending.kind === "question") pending.resolve(null); else void this.answer(id, "rejected"); }
  }
  private emitted(_event: string, _args: readonly unknown[]): void { /* api-session/* notices: the follow and state streams say the same, in order. */ }
  private async answer(eventId: string, value: unknown, rejected = false): Promise<void> {
    try { await this.host?.answer(eventId, rejected ? { kind: "rejected", error: { name: "AbortError", message: "cancelled" } } : { kind: "result", value }); }
    catch { /* A waterfall the Host withdrew or a closed connection: nothing waits for this answer any more. */ }
  }
  /** dsh asks (its approval waterfall: a call that wants out of its sandbox; its question tool): answered by the Hub's policy or the user. */
  private async waterfall(frame: Waterfall): Promise<void> {
    const run = this.active;
    if (frame.event !== "approval/request" && frame.event !== "user-questions/request") { await this.host?.answer(frame.eventId, { kind: "next" }).catch(() => {}); return; }
    if (run === null || run.settled || this.abandoned.has(frame.agentId)) { this.unattributed++; await this.answer(frame.eventId, frame.event === "approval/request" ? "rejected" : null, frame.event !== "approval/request"); return; }
    if (frame.event === "approval/request") {
      if (!this.interactive || run.stopping) { run.onEvent({ type: "permission", id: frame.eventId, decision: run.stopping ? "cancelled" : "denied" }); await this.answer(frame.eventId, "rejected"); return; }
      const callId = text(frame.request.callId), toolName = text(frame.request.toolName) ?? "dsh 请求执行工具";
      for (const until = Date.now() + CALL_WAIT_MS; callId !== undefined && !run.calls.has(callId) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50));
      if (run.settled) { await this.answer(frame.eventId, "rejected"); return; }
      const detail = approvalDetail(callId === undefined ? undefined : run.calls.get(callId), frame.request), kind = toolKind(toolName);
      this.pending.set(frame.eventId, { kind: "approval", run });
      run.onEvent({ type: "permission_requested", id: frame.eventId, title: toolName, ...(detail ? { detail } : {}), options: APPROVAL_OPTIONS.map(option => ({ ...option })),
        ...(callId === undefined ? {} : { forCall: callId }), ...(kind === undefined ? {} : { toolKind: kind }) });
      return;
    }
    // Its question tool (dsh-tool-ask-user): each question in turn, as the chat asks a form, then all the answers at once.
    const questions = Array.isArray(frame.request.questions) ? frame.request.questions : [], answers: { id: string; selected: string[]; custom?: string }[] = [];
    for (const [index, question] of questions.entries()) {
      const qid = text(field(question, "id")) ?? String(index), asked = text(field(question, "question")) ?? "", header = text(field(question, "header"));
      const choices = Array.isArray(field(question, "options")) ? (field(question, "options") as unknown[]).flatMap(option => text(field(option, "label")) ? [{ label: text(field(option, "label"))!, description: text(field(option, "description")) }] : []) : [];
      const options = [...choices.map((choice, at) => ({ id: "answer-" + at, name: choice.label })), { id: "submit", name: "提交回答" }, { id: "skip", name: "跳过" }, { id: "cancel", name: "取消" }];
      const detail = [text(field(question, "detail")), ...choices.filter(choice => choice.description).map(choice => choice.label + "：" + choice.description)].filter(Boolean).join("\n");
      if (!this.interactive || run.settled || run.stopping) { await this.answer(frame.eventId, null, true); return; }
      const id = frame.eventId + ":" + index;
      const answer = await new Promise<{ readonly option: string; readonly input?: string } | null>(resolve => {
        this.pending.set(id, { kind: "question", run, options: options.map(option => option.id), resolve });
        run.onEvent({ type: "permission_requested", id, kind: "question", title: header ? header + "：" + asked : asked || "dsh 提了一个问题", ...(detail ? { detail } : {}), options, input: { kind: "text", value: "" } });
      });
      if (answer === null || answer.option === "cancel") { this.pending.delete(id); await this.answer(frame.eventId, null, true); return; }
      if (answer.option === "skip") answers.push({ id: qid, selected: [] });
      else if (answer.option === "submit") answers.push({ id: qid, selected: [], ...(answer.input ? { custom: answer.input } : {}) });
      else answers.push({ id: qid, selected: [choices[Number(answer.option.slice(7))]?.label ?? ""] });
    }
    await this.answer(frame.eventId, { answers });
  }
  private withdrawn(eventId: string): void {
    for (const [id, pending] of this.pending) {
      if (id !== eventId && !id.startsWith(eventId + ":")) continue;
      this.pending.delete(id);
      if (pending.kind === "question") pending.resolve(null);
      if (!pending.run.settled) pending.run.onEvent({ type: "permission", id, decision: "cancelled" });
    }
  }
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending === undefined) throw new ControlError("INVALID_STATE", "permission request is not pending");
    if (pending.kind === "question") {
      if (!pending.options.includes(option)) throw new ControlError("INVALID_INPUT", "unknown answer");
      this.pending.delete(id); pending.resolve({ option, ...(input === undefined ? {} : { input }) }); return;
    }
    if (option !== "allow-once" && option !== "reject") throw new ControlError("INVALID_INPUT", "unknown permission option");
    this.pending.delete(id);
    await this.web.answer(id, { kind: "result", value: option === "allow-once" ? "allowed-once" : "rejected" });
  }
  private failed(error: Error): void {
    const run = this.active;
    if (run !== null && !run.settled) run.reject(error);
  }
  private lost(error: Error): void { this.failed(error); }
  /** Gives the open session up (the Hub's clear): its streams are closed and its later events dropped; nothing of it is deleted. */
  private abandon(): void {
    const session = this.session;
    if (session !== null) { session.follow?.cancel(); session.state?.cancel(); this.abandoned.add(session.id); }
    this.session = null; this.pendingCreate = null; this.commandNames = null;
  }

  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    if (!this.features.has("title")) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "this dsh cannot rename its sessions");
    await this.ensureCreated(id);
    try { await this.web.call("session/rename", { request: { sessionId: id, title } }); }
    catch (error) { if (error instanceof DshRemoteError) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "dsh refused the title"); throw error; }
  }
  /** `session/fork` of a stored session on a connection that opened none: the latest completed turn and what follows it, as a new session. */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    if (!this.features.has("fork")) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "this dsh cannot fork its sessions");
    if (this.session !== null || this.pendingCreate !== null) throw new ControlError("INVALID_STATE", "a fork needs its own connection");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    await this.ensureHost(null);
    let value: unknown;
    try { value = await this.web.call("session/fork", { request: { sessionId: nativeConversationId(checkpoint) } }); }
    catch (error) { if (error instanceof DshRemoteError) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "dsh refused to fork the session"); throw error; }
    const forked = text(field(value, "sessionId"));
    if (forked === undefined || forked === checkpoint) throw new ControlError("INVALID_PROTOCOL", "dsh returned no new session for the fork");
    return forked;
  }
  /** dsh's own sessions of `cwd`, newest first, as its list gives them (titles included); blanks and subagent sessions are left out. */
  async nativeSessions(cwd: string): Promise<NativeSessionPage> {
    if (!this.features.has("list")) throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "this dsh cannot list its sessions");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    await this.ensureHost(null);
    const listed = await this.web.call("session/list", { _request: {} }), items = field(listed, "items");
    const rows = (Array.isArray(items) ? items : []).filter(row => field(row, "cwd") === cwd && field(row, "blank") !== true && field(field(field(row, "projections"), "values"), "subagent") == null && field(row, "parentSessionId") === undefined);
    const sessions = rows.flatMap(row => {
      const id = text(field(row, "sessionId")), title = text(field(field(field(row, "projections"), "values"), "title")), updated = field(row, "updatedAt");
      return id === undefined ? [] : [{ id, title: title?.trim() ? title.replace(/\s+/gu, " ").trim().slice(0, 200) : null, updatedAt: typeof updated === "number" ? updated : null }];
    }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { sessions, nextCursor: null };
  }
  /** One listed session of `cwd` read whole for continuing it in the Hub: its durable history, page by page from the end; nothing is activated. */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    const listed = await this.nativeSessions(cwd), row = listed.sessions.find(session => session.id === id);
    if (row === undefined) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the Harness has no session with this identity in this folder");
    const records: unknown[] = [];
    for (let through: number | undefined, pages = 0; pages < 10_000; pages++) {
      const page = await this.web.call("session/events", { request: { address: { kind: "session", sessionId: id }, ...(through === undefined ? {} : { throughSeq: through }) } });
      const rows = field(page, "records"), got = Array.isArray(rows) ? rows : [];
      records.unshift(...got);
      const first = field(field(got[0], "event"), "seq");
      if (field(page, "hasMore") !== true || typeof first !== "number" || first <= 0) break;
      through = first - 1;
    }
    return { checkpoint: id, title: row.title, history: historyOf(records), omitted: 0, complete: true, historyRead: true };
  }
  async close(): Promise<CleanupEvidence> {
    const run = this.active;
    if (run !== null && !run.settled) run.reject(new ControlError("CLOSED", "connection closed by its owner"));
    this.session?.follow?.cancel(); this.session?.state?.cancel();
    try { return this.host === null ? { closed: true, exitCode: null, signal: null, protocolFailure: null } : await this.host.close(); }
    finally { if (this.patchDir !== null) await rm(this.patchDir, { recursive: true, force: true }).catch(() => {}); }
  }
}
/** dsh's refusal in the Hub's words: its codes say why; its own text is never quoted. */
function refusal(error: DshRemoteError): { readonly code: string; readonly message: string } {
  switch (error.dshCode) {
    case "session/model-unavailable": return { code: "NATIVE_MODEL_UNAVAILABLE", message: "所选模型在 dsh 的模型服务中不可用，请换一个模型。" };
    case "session/not-found": return { code: "NATIVE_SESSION_NOT_FOUND", message: "dsh 里找不到这个会话。" };
    case "session/writer-held": return { code: "NATIVE_SESSION_BUSY", message: "这个 dsh 会话正被另一个 dsh 窗口写入，请先在那里关掉它。" };
    case "session/attachment-invalid":
      return error.reason === "MODEL_DOES_NOT_SUPPORT_IMAGES" ? { code: "ATTACHMENT_UNSUPPORTED", message: "所选模型不接受图片附件，这条消息没有发出。可以换一个收图片的模型，或去掉图片再发。" }
        : { code: "ATTACHMENT_UNSUPPORTED", message: "dsh 不接受这条消息的附件，没有发出。" };
    case "gateway/input-invalid": return { code: "NATIVE_INPUT_REFUSED", message: "dsh 不接受这条消息的内容，没有发出。" };
    default: return { code: "NATIVE_REQUEST_REFUSED", message: "dsh 拒绝了这次请求（" + error.dshCode + "）。" };
  }
}
