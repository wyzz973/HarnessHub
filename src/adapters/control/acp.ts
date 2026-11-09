import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { listedCommand, nativeConversationId, requestExpiry, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent,
  type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl,
  type NativeOptions, type NativeOption, type NativeConversationId, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { ControlError, errorFrom, JsonRpcProcess, object, string, text, type RpcRequest } from "../../infrastructure/control/json-rpc-process.js";
import { unifiedDiff } from "../../infrastructure/control/unified-diff.js";
import { MAX_NATIVE_SESSIONS, type NativeOutput, type NativeSessionImport, type NativeSessionPage, type NativeToolDetail, type NativeUsage } from "../../contracts/control.js";
import { MAX_CONTENT_BYTES, textual, type ContentKind, type ContentRef, type ControlAttachment } from "../../contracts/content.js";
import { checkInputs, fileMentions, readAttachment } from "../../infrastructure/control/attachments.js";
import type { RelayCapabilities } from "../../contracts/relay.js";
import { nativeReading, relayDeclaration, relayEntries, textClassify } from "./relay-classify.js";
import { dshVendor, slashModelKey } from "./relay-vendor.js";

interface ActivePrompt {
  readonly event: (event: ControlEvent) => void;
  /** When the prompt's own last update arrived; an agent that keeps sending after its prompt response is waited for. */
  lastUpdate: number;
  /**
   * The agent answered this prompt (a reply, thinking or tool call of its own), which it does only once it took the prompt
   * into its turn: evidence that the prompt was recorded. Plans, usage and notices are no such answer (an agent can send a
   * plan before it inserts the prompt).
   */
  answered: boolean;
  readonly tools: Map<string, { title: string; status: string }>;
  readonly compaction: Map<string, string>;
  stopping: boolean;
  settled: boolean;
  stop: Promise<StopRequestReceipt> | null;
  /** When this prompt's request times out (the Turn's deadline, ADR-035). */
  readonly deadline: number;
}
const metadataUpdates = new Set(["plan", "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update"]);
/** Long agentic turns flatten subagent tools into the root session; budgets bound memory, not normal work. */
const MAX_PROMPT_TOOLS = 4096;
const MAX_NATIVE_COMMANDS = 2048;
/**
 * Some agents keep streaming session/load history after the load response (Gemini, Hermes); the prompt waits until that
 * replay has been quiet this long, counted from the response at the earliest so a slow load cannot skip the wait.
 */
const REPLAY_QUIET_MS = 150;
/** An agent's own approval deadline is honoured this much early, so a choice made at its last second is never sent too late. */
const APPROVAL_DEADLINE_MARGIN_MS = 2000;
/** Agents announce their commands just after session creation; a catalog read waits this long for that announcement. */
const COMMANDS_WAIT_MS = 1500;
/** Text files up to this size travel as embedded resources when the agent declares embedded context. */
const EMBED_TEXT_BYTES = 256 * 1024;
const REPLAY_SETTLE_MS = 3000;
/** The longest wait for an agent's updates that trail its prompt response. */
const TRAILING_SETTLE_MS = 2000;
/** Replayed history kept when a session is read for continuing it; older text beyond this is counted, not kept. */
const IMPORT_REPLAY_BYTES = 4 * 1024 * 1024, IMPORT_REPLAY_MESSAGES = 2000;
/** Pages of session/list searched to confirm that a session belongs to the workspace. */
const IMPORT_LIST_PAGES = 20;
/** Session setup starts the agent's own runtime (plugins, MCP, model catalog); a cold start can exceed a plain request. */
const SESSION_SETUP_MS = 60000;
/** Display label from native text: control characters (including newlines in multi-line commands) become spaces. */
function label(value: unknown, fallback: string, maximum = 4096): string {
  if (typeof value !== "string") return fallback;
  const result = value.replace(/[\0-\x1f\x7f]+/gu, " ").trim();
  return result ? result.slice(0, maximum) : fallback;
}

function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return undefined;
  try { return JSON.stringify(value, null, 2); } catch { return undefined; }
}
function field(value: unknown, key: string): unknown { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
/** Native tool fields as given by the agent: kind/name, raw input and output, content text, diffs and locations. */
function toolDetail(update: Record<string, unknown>): NativeToolDetail | undefined {
  const claude = field(field(update, "_meta"), "claudeCode");
  const name = typeof update.name === "string" ? update.name : typeof field(claude, "toolName") === "string" ? field(claude, "toolName") as string : undefined;
  const parentId = field(claude, "parentToolUseId");
  const command = field(update.rawInput, "command");
  const input = typeof command === "string" ? command : preview(update.rawInput);
  const texts: string[] = [], diffs: string[] = [];
  if (Array.isArray(update.content)) for (const item of update.content) {
    const type = field(item, "type");
    if (type === "content" && field(field(item, "content"), "type") === "text" && typeof field(field(item, "content"), "text") === "string") texts.push(field(field(item, "content"), "text") as string);
    if (type === "diff" && typeof field(item, "path") === "string" && typeof field(item, "newText") === "string") {
      const before = field(item, "oldText"); diffs.push(unifiedDiff(field(item, "path") as string, typeof before === "string" ? before : null, field(item, "newText") as string));
    }
  }
  const output = texts.length ? texts.join("\n") : preview(update.rawOutput);
  const locations = Array.isArray(update.locations) ? update.locations.flatMap(item => typeof field(item, "path") === "string" ? [(field(item, "path") as string) + (typeof field(item, "line") === "number" ? ":" + String(field(item, "line")) : "")] : []) : [];
  const detail: NativeToolDetail = { ...(typeof update.kind === "string" ? { kind: update.kind } : {}), ...(name ? { name } : {}), ...(typeof parentId === "string" ? { parentId } : {}),
    ...(input ? { input } : {}), ...(output ? { output } : {}), ...(diffs.length ? { diff: diffs.join("") } : {}), ...(locations.length ? { locations } : {}) };
  return Object.keys(detail).length ? detail : undefined;
}
/** What an approval would allow, as the request describes it: the proposed diff, else the command or input, and where. */
function permissionDetail(tool: Record<string, unknown>): string {
  const described = toolDetail(tool), command = field(tool.rawInput, "command");
  const action = described?.diff ?? (typeof command === "string" ? "命令：" + command : described?.input ?? "");
  const where = !described?.diff && described?.locations?.length ? "位置：" + described.locations.join("、") : "";
  return [action, where].filter(Boolean).join("\n").slice(0, 4096);
}
function decoded(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length > Math.ceil(MAX_CONTENT_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(data, "base64"); return bytes.length > 0 && bytes.length <= MAX_CONTENT_BYTES ? bytes : null;
}
/** Non-text ACP content as a native output; unknown or oversized shapes become a diagnostic instead. */
function outputOf(content: Record<string, unknown>): NativeOutput | null {
  const type = content.type, mime = typeof content.mimeType === "string" ? content.mimeType : undefined;
  if ((type === "image" || type === "audio") && typeof content.data === "string" && mime) {
    const data = decoded(content.data); if (!data) return null;
    return { kind: "content", name: (type === "image" ? "image." : "audio.") + (mime.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "bin"), mediaType: mime, data };
  }
  if (type === "resource_link" && typeof content.uri === "string" && typeof content.name === "string") return { kind: "link", uri: content.uri, name: content.name, ...(typeof content.title === "string" ? { title: content.title } : {}), ...(mime ? { mediaType: mime } : {}) };
  const resource = field(content, "resource");
  if (type === "resource" && typeof field(resource, "uri") === "string") {
    const uri = field(resource, "uri") as string, name = uri.split(/[\\/]/u).filter(Boolean).at(-1)?.slice(0, 200) || "resource", type = typeof field(resource, "mimeType") === "string" ? field(resource, "mimeType") as string : undefined;
    if (typeof field(resource, "text") === "string") return { kind: "content", name, mediaType: type ?? "text/plain", data: new TextEncoder().encode(field(resource, "text") as string) };
    if (typeof field(resource, "blob") === "string") { const data = decoded(field(resource, "blob") as string); if (data) return { kind: "content", name, mediaType: type ?? "application/octet-stream", data }; }
  }
  return null;
}
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
/** A session/load result. An agent that answers an identity it does not have with null (Hermes 0.12) has no such session. */
function loaded(value: unknown): Record<string, unknown> {
  if (value === null) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the Harness has no session with this identity");
  return object(value, "native session load result");
}

/**
 * DeepSeek Harness's relay declaration (ADR-055 §8.1, DeepSeek Harness row). dsh runs on this generic driver, which the
 * factory hands this declaration: two text blocks (dsh joins them into one user message); its first message, thought or
 * tool call is weak live evidence, there is no check, and a completed turn proves nothing by itself; dsh has no commands,
 * so every input, a slash one included, is text; no compaction evidence; one process per connection; the vendor by the
 * endpoint the layers read here resolve (the inherited DEEPSEEK_BASE_URL, then the two `.env` files), otherwise DeepSeek;
 * the window from its usage reports; no native title entry (not guaranteed before P13). Not probed.
 *
 * The vendor key is exact only for the layers read: the plugin configuration's `baseURL` (dsh-llm-deepseek's highest layer)
 * and the routes of its other providers (dsh-llm-pi-ai) are not read, so a profile that sets either is keyed wrongly. The
 * probe gate covers it: with probed=false a relay to dsh is refused (RELAY_TARGET_UNVERIFIED), and P14 must cover the
 * profile and plugin configuration layers before this flips.
 */
export const dshRelayCapabilities: RelayCapabilities = relayDeclaration({
  probed: false,
  delivery: { live: "agent_output", verify: "none", successProvesRecorded: false, lateDelivery: false },
  execution: "process",
  commands: { unlistedSlash: "text", hidden: [], classify: textClassify },
  placement: { parts: "multiple", maxInput: null, pointersAfterUser: false },
  window: "session_report",
  fixedPrefix: null,
  cacheTtl: "hours",
  compactionEvidence: "none",
  resolveVendor: dshVendor,
  normalizeModel: slashModelKey,
  title: "none",
  hostPathRead: "none",
  sessionTools: null,
});

/** ACP v1 anti-corruption layer. Client filesystem and terminal capabilities are not advertised. */
export class AcpControl implements HarnessControl {
  /**
   * The relay declaration this connection's Driver makes (ADR-055 §8.1): a subclass's own, or the one its factory hands
   * the generic driver for a Harness that runs on it (dsh); none for any other Harness on the generic driver.
   */
  readonly relayCapabilities?: RelayCapabilities;
  private readonly rpc: JsonRpcProcess;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private version: string | null = null;
  private capabilities: Record<string, unknown> = {};
  private conversation: NativeConversationId | null = null;
  private opening = false;
  private replaying = false;
  private replayBytes = 0;
  private lastReplay = 0;
  private active: ActivePrompt | null = null;
  private failure: Error | null = null;
  private catalog: NativeModelCatalog = { models: [], defaultModel: null, authentication: "unknown", canSelect: false };
  /** A sign-in state the agent reported on its own (setAuthentication); null until it reports one. */
  private reportedAuthentication: NativeModelCatalog["authentication"] | null = null;
  private interactivePermissions = false;
  /**
   * Pending native interactions by their public id: `request` is the agent's own request they answer (its JSON-RPC id),
   * `reply` maps the user's choice for a form question (otherwise the option is selected), and `dispose` ends what the
   * interaction holds (a deadline timer) when the agent withdraws its request and nothing is answered.
   */
  private readonly permissions = new Map<string, { readonly request: string; readonly options: readonly string[]; readonly resolve: (value: unknown) => void; readonly reply?: (option: string, input?: string) => unknown; readonly dispose?: () => void }>();
  private configuredDefault: string | null = null;
  private modelConfigId: string | null = null;
  private legacyModels = false;
  private readonly openingMetadata: Record<string, unknown>[] = [];
  /** While a session is read for continuing it, replayed user and agent text is collected here instead of dropped. */
  private collected: { messages: { role: "user" | "assistant"; text: string }[]; bytes: number; dropped: number } | null = null;
  /** Updates outside any active prompt (autonomous native follow-ups); never attributed to a public Run. */
  private unattributed = 0;
  /** Resolved by the first available_commands_update; catalog reads wait briefly for it instead of racing it. */
  private commandsAnnounced!: () => void;
  private readonly commandsArrived = new Promise<void>(resolve => { this.commandsAnnounced = resolve; });
  get unattributedUpdates(): number { return this.unattributed; }
  healthy(): boolean { return this.initialized && this.failure === null && this.rpc.failure === null; }
  processGroup(): number | null { return this.rpc.processGroup; }
  diagnosticMark(): number { return this.rpc.stderrMark; }
  diagnosticsSince(mark: number): string { return this.rpc.stderrSince(mark); }

  constructor(launch: ControlLaunch, private readonly options: ControlOptions, relayCapabilities?: RelayCapabilities) {
    if (launch.protocol !== "acp-v1") throw new ControlError("INVALID_INPUT", "ACP control requires an ACP launch");
    if (relayCapabilities !== undefined) this.relayCapabilities = relayCapabilities;
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
      await this.beforeConnect();
      const response = object(await this.rpc.request("initialize", {
        // Notices and compaction arrive as their own updates instead of being folded into reply text or fake tools.
        // elicitation.form lets an agent ask the user through a form (Claude's AskUserQuestion); the chat asks it field by field.
        protocolVersion: 1, clientCapabilities: { session: { notices: {}, compaction: {} }, elicitation: { form: {} } },
        clientInfo: { name: "harnessgateway", title: "HarnessGateway", version: "0.0.0" },
      }), "ACP initialize result");
      if (response.protocolVersion !== 1) throw new ControlError("PROTOCOL_VERSION", "peer did not negotiate ACP v1");
      const capabilities = object(response.agentCapabilities, "ACP agent capabilities");
      this.capabilities = capabilities;
      // ACP's schema defaults authMethods to an empty list; Hermes 0.12 leaves it out when it has no provider credentials.
      const advertised = response.authMethods === undefined ? [] : response.authMethods;
      if (!Array.isArray(advertised) || advertised.length > 64) throw new ControlError("INVALID_PROTOCOL", "authMethods must be a bounded array");
      // A method without a type is an agent method (ACP AuthMethod).
      const methods = advertised.map(method => { const row = object(method, "auth method"); return { id: string(row.id, "auth method id"), type: row.type === undefined ? "agent" : string(row.type, "auth method type", 64) }; });
      const info = response.agentInfo == null ? null : object(response.agentInfo, "agentInfo");
      const observation: ProtocolObservation = { protocol: "acp-v1", protocolVersion: 1,
        agentName: info === null ? null : string(info.name, "agent name"),
        agentVersion: info === null ? null : string(info.version, "agent version"),
        authenticationMethods: methods.map(method => method.id), capabilities };
      this.version = observation.agentVersion;
      // A report read together with this response (same stdout chunk) is the agent's own word and outranks its methods.
      this.catalog = { ...this.catalog, authentication: this.reportedAuthentication ?? this.authentication(methods) };
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
        if (new Set(models.map(row => row.id)).size !== models.length) throw new ControlError("INVALID_PROTOCOL", "ACP models have duplicate values");
        // A resumed or natively switched session can run a model its picker does not list; keep the actual value.
        if (!models.some(row => row.id === selected)) models.push({ id: selected, name: selected });
        this.modelConfigId = id; this.legacyModels = false;
        this.catalog = { ...this.catalog, models, defaultModel: selected, canSelect: true }; return;
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
      this.legacyModels = true; this.catalog = { ...this.catalog, models, defaultModel: selected, canSelect: models.length > 0 };
    }
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized(); if (this.conversation === null) throw new ControlError("INVALID_STATE", "ACP model catalog requires a session");
    // An agent without commands never announces any; the wait is bounded and happens at most once per connection.
    if (this.catalog.commands === undefined) { let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([this.commandsArrived, new Promise<void>(resolve => { timer = setTimeout(resolve, COMMANDS_WAIT_MS); })]); clearTimeout(timer); if (this.catalog.commands === undefined) this.catalog = { ...this.catalog, commands: [] }; }
    return { ...this.catalog, defaultModel: this.configuredDefault, inputs: this.inputs() };
  }
  /**
   * The model and option values the agent last announced for this session: its configuration replies and its own
   * config_option_update / current_mode_update notifications, which include changes made during a Turn.
   */
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions }> {
    this.assertInitialized(); if (this.conversation === null) throw new ControlError("INVALID_STATE", "native configuration requires a session");
    return { model: this.catalog.canSelect ? this.catalog.defaultModel : null, options: Object.fromEntries((this.catalog.options ?? []).map(option => [option.id, option.currentValue])) };
  }
  /** Consecutive replayed chunks of one role form one message; the oldest messages give way to the budget. */
  private collect(role: "user" | "assistant", content: unknown): void {
    const collected = this.collected!, item = content !== null && typeof content === "object" ? content as Record<string, unknown> : {};
    const value = item.type === "text" && typeof item.text === "string" ? item.text : item.type === "image" ? "[图片]" : item.type === "resource_link" && typeof item.name === "string" ? "[文件 " + item.name + "]" : "";
    if (!value) return;
    const last = collected.messages.at(-1);
    if (last?.role === role) last.text += value; else collected.messages.push({ role, text: value });
    collected.bytes += Buffer.byteLength(value);
    while (collected.messages.length > 1 && (collected.bytes > IMPORT_REPLAY_BYTES || collected.messages.length > IMPORT_REPLAY_MESSAGES)) {
      const oldest = collected.messages.shift()!; collected.bytes -= Buffer.byteLength(oldest.text); collected.dropped++;
    }
  }
  /** session/list for this workspace when the agent declares it; an agent that refuses it cannot list sessions. */
  async nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    const sessions = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
    if (sessions.list === undefined) throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "this agent does not declare session/list");
    let response: Record<string, unknown>;
    try { response = object(await this.rpc.request("session/list", { cwd, ...(cursor === undefined ? {} : { cursor }) }), "session/list result"); }
    catch (error) {
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "the agent refused session/list");
      throw this.nativeFailure(error);
    }
    if (!Array.isArray(response.sessions) || response.sessions.length > 1000) throw new ControlError("INVALID_PROTOCOL", "invalid native session list");
    const rows = response.sessions.map(value => object(value, "native session")).filter(row => row.cwd === cwd).map(row => {
      const updated = typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : NaN;
      return { id: string(row.sessionId, "native session identity", 1024), title: typeof row.title === "string" && row.title.trim() ? row.title.replace(/\s+/gu, " ").trim().slice(0, 200) : null, updatedAt: Number.isFinite(updated) ? updated : null };
    });
    return { sessions: rows.slice(0, MAX_NATIVE_SESSIONS), nextCursor: response.nextCursor == null ? null : string(response.nextCursor, "native session cursor", 1024) };
  }
  /**
   * Reads a session of this workspace for continuing it: the listing confirms its workspace and title, session/load
   * replays its history, which is kept as messages. An agent that can only resume continues without its history.
   */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    this.assertInitialized();
    if (this.conversation !== null || this.opening || this.forking) throw new ControlError("INVALID_STATE", "reading a session needs its own connection");
    let title: string | null = null, found = false, cursor: string | undefined;
    for (let page = 0; page < IMPORT_LIST_PAGES && !found; page++) {
      const listed = await this.nativeSessions(cwd, cursor), row = listed.sessions.find(item => item.id === id);
      if (row) { found = true; title = row.title; } else if (listed.nextCursor === null) break; else cursor = listed.nextCursor;
    }
    if (!found) throw new ControlError("NATIVE_SESSION_NOT_FOUND", "the agent does not list this session for the workspace");
    const sessions = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
    if (this.capabilities.loadSession !== true) {
      if (sessions.resume === undefined) throw new ControlError("NATIVE_RESUME_UNAVAILABLE", "installed Harness did not advertise native recovery");
      return { checkpoint: id, title, history: [], omitted: 0, complete: false, historyRead: false };
    }
    this.opening = true; this.conversation = nativeConversationId(id); this.replaying = true; this.lastReplay = Date.now();
    this.collected = { messages: [], bytes: 0, dropped: 0 };
    try {
      const setup = Math.max(this.options.requestTimeoutMs, Math.min(SESSION_SETUP_MS, this.options.runTimeoutMs));
      const response = loaded(await this.sessionRequest("session/load", { ...await this.sessionParameters(cwd), sessionId: id }, setup));
      if (response.sessionId !== undefined && response.sessionId !== id) throw new ControlError("IDENTITY_MISMATCH", "native load changed the session identity");
      await this.replaySettled();
      const collected = this.collected;
      return { checkpoint: id, title, history: collected.messages.map(message => ({ role: message.role, text: message.text })), omitted: collected.dropped, complete: true, historyRead: true };
    } catch (error) { const failure = this.nativeFailure(error); this.rpc.abort(failure); throw failure; }
    finally { this.opening = false; this.replaying = false; this.collected = null; this.openingMetadata.length = 0; }
  }
  private forking = false;
  /**
   * ACP `session/fork` when the agent declares it; the copy's replay is ignored and the source is untouched. The agent may
   * start the copy as a session before it answers (claude-agent-acp 0.90.0 and later), so the request waits as long as
   * opening a session does. Only -32601 says the agent cannot fork, so nothing was copied (NATIVE_FORK_UNAVAILABLE); any
   * other refusal can come after the copy was written, and its failure leaves the copy's existence unknown.
   */
  async fork(checkpoint: string, cwd: string): Promise<string> {
    this.assertInitialized();
    if (this.conversation !== null || this.opening || this.forking) throw new ControlError("INVALID_STATE", "a fork needs its own connection");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "fork cwd must be absolute");
    const sessions = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
    if (sessions.fork === undefined) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "this agent does not declare session/fork");
    this.forking = true;
    try {
      const setup = Math.max(this.options.requestTimeoutMs, Math.min(SESSION_SETUP_MS, this.options.runTimeoutMs)), meta = this.sessionMeta;
      const response = object(await this.sessionRequest("session/fork", { sessionId: nativeConversationId(checkpoint), cwd, mcpServers: [], ...(meta === null ? {} : { _meta: meta }) }, setup), "session/fork result");
      const id = nativeConversationId(response.sessionId);
      if (id === checkpoint) throw new ControlError("IDENTITY_MISMATCH", "session/fork returned its source session");
      return id;
    } catch (error) {
      // claude-agent-acp 0.90.0 and later copy the transcript and then start the copy before answering, so a refusal other
      // than -32601 can come after the copy exists. The Runtime's archiving of a fork refused with a class it treats as
      // "nothing copied" (forkNative in runtime.ts) still assumes no copy; that assumption is left to the fourth batch.
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null && error.remoteCode === -32601) throw new ControlError("NATIVE_FORK_UNAVAILABLE", "the agent has no session/fork");
      throw this.nativeFailure(error);
    }
  }
  /** ACP promptCapabilities; every agent must accept resource links, so files are always offered. */
  private promptCapabilities(): { readonly image: boolean; readonly audio: boolean; readonly embeddedContext: boolean } {
    const value = this.capabilities.promptCapabilities, caps = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return { image: caps.image === true, audio: caps.audio === true, embeddedContext: caps.embeddedContext === true };
  }
  private inputs(): { readonly image: boolean; readonly audio: boolean; readonly file: boolean } { const caps = this.promptCapabilities(); return { image: caps.image, audio: caps.audio, file: true }; }
  /** Largest inline image this agent forwards to its model. */
  protected get maxInlineImageBytes(): number { return MAX_CONTENT_BYTES; }
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    checkInputs(attachments, this.inputs(), { image: this.maxInlineImageBytes });
  }
  /** Native ACP content blocks: inline image/audio, embedded small text, otherwise a file link the agent reads itself. */
  private async promptBlock(file: ControlAttachment): Promise<Record<string, unknown>> {
    const uri = pathToFileURL(file.path).href;
    if (file.kind === "image" || file.kind === "audio") return { type: file.kind, data: (await readAttachment(file)).toString("base64"), mimeType: file.mediaType };
    if (textual(file.mediaType) && file.bytes <= EMBED_TEXT_BYTES && this.promptCapabilities().embeddedContext) {
      try { return { type: "resource", resource: { uri, mimeType: file.mediaType, text: new TextDecoder("utf-8", { fatal: true }).decode(await readAttachment(file)) } }; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
    }
    return { type: "resource_link", uri, name: file.name, mimeType: file.mediaType, size: file.bytes };
  }
  /**
   * The `_meta` this agent's session requests carry (session/new, session/load, session/resume and session/fork), or null
   * to send none. It holds only options the agent documents for its own sessions; read once per request.
   */
  protected get sessionMeta(): Readonly<Record<string, unknown>> | null { return null; }
  protected async sessionParameters(cwd: string): Promise<Readonly<Record<string, unknown>>> { const meta = this.sessionMeta; return { cwd, mcpServers: [], ...(meta === null ? {} : { _meta: meta }) }; }
  /**
   * Runs once, before the agent's program is started (initialize is the first request, and the process is spawned for it).
   * A driver whose program would act on the user's machine merely by starting (Hermes's `hermes acp` starts, stops or
   * replaces the user's gateway when no compatible one runs, ADR-051) judges that here from read-only facts and throws a
   * ControlError to refuse: nothing has been spawned then, the connection fails as a failed initialize does, and open(),
   * the catalog read and every later call refuse with the same error. The default does nothing.
   */
  protected async beforeConnect(): Promise<void> {}
  /** Recovery uses session/load even when session/resume is declared, for an agent whose resume of an unknown identity starts a new session. */
  protected get restoreByLoad(): boolean { return false; }
  /** How long the agent itself waits for an approval before refusing it, or null when it waits for the user. */
  protected get approvalDeadlineMs(): number | null { return null; }
  /** The status a tool update reports; an agent that reports failures as completed calls with failure text says so here. */
  protected toolStatus(status: string, _detail: NativeToolDetail | undefined): string { return status; }
  /**
   * Names a request the agent refused (`method`; REMOTE_ERROR on a healthy connection) from what only its error data says
   * (ControlError.remoteDetail): the failure to report in place of the generic one, or null to keep the generic handling,
   * which is the class the agent's own words name, else the refusal itself. It applies to session setup (session/new,
   * session/load, session/resume and the model, mode and setting requests of open()), to session/load when a session is
   * read for continuing it, to session/fork, and to session/prompt, where `report` adds an event to the Turn (it is absent
   * elsewhere) and the failure becomes the failed result's error. The detail is the agent's private text, which may name
   * the user's paths or credentials, so a failure quotes it only through a fixed vocabulary. The default names nothing.
   */
  protected refusal(_method: string, _error: ControlError, _report?: (event: ControlEvent) => void): { readonly code: string; readonly message: string } | null { return null; }
  /**
   * Where a refused prompt (session/prompt answered with REMOTE_ERROR on a healthy connection) stands, as only the agent's
   * own error says it (ADR-055 §7.1, R0c; its code, message, detail and fields on ControlError): "not_recorded" for a
   * refusal the agent gives only before inserting the prompt, "recorded" for one it gives only after (a model call that
   * failed), null when the same error can come either way — then only the agent's answer to a content prompt proves it
   * recorded. A command prompt is never reported recorded. The default knows no error.
   */
  protected refusedPrompt(_error: ControlError): "recorded" | "not_recorded" | null { return null; }
  /**
   * Whether this agent's stop reason for a content prompt proves the prompt reached its history (ADR-055 §7.1, E3), as
   * its own protocol semantics say: an agent that records the prompt before calling its model can say so of end_turn and
   * of failures after insertion. The default proves nothing by stop reason alone; an answer to the prompt still does.
   */
  protected promptRecorded(_reason: string): boolean { return false; }
  /**
   * How the native side reads an input: the relay declaration's reading when the factory handed this generic driver one
   * (dsh: one reading for the Runtime and the relay, VF1-06), otherwise the shared one (listedCommand). A driver whose agent
   * parses commands otherwise reproduces that here.
   */
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass {
    const declared = this.relayCapabilities;
    return declared === undefined ? listedCommand(text, catalog) : nativeReading(declared.commands.classify(text, catalog === null ? null : relayEntries(catalog.commands ?? []), attachments));
  }
  /**
   * Whether the agent's answer or stop reason can prove this prompt recorded as content: it reads the prompt as content,
   * against the commands it announced to this connection so far. A driver narrows it where its reading may be out of date.
   */
  protected readsAsContent(prompt: string, attachments: readonly ContentKind[]): boolean { return this.classify(prompt, this.catalog, attachments).kind === "content"; }
  /** Whether the agent hands ACP file blocks to its model; when it drops them, files travel as text pointers it reads with its own tools. */
  protected get fileBlocks(): boolean { return true; }
  /** A position in the agent's stderr and what it logged since, for an agent that reports some failures only there. */
  protected get stderrMark(): number { return this.rpc.stderrMark; }
  protected stderrSince(mark: number): string { return this.rpc.stderrSince(mark); }
  /** The version the agent reported in initialize, for behaviour that differs between its versions; null before it or when absent. */
  protected get agentVersion(): string | null { return this.version; }
  /**
   * How long the agent's updates must stay quiet after its prompt response before the turn is settled, for an agent that
   * sends its last reply chunks after that response (Hermes); 0 settles at the response, as ACP v1 requires of agents.
   */
  protected get trailingQuietMs(): number { return 0; }
  /**
   * What the agent's advertised authentication methods say about its readiness. ACP lists the methods an agent offers,
   * not whether one is set up, so the default is "unknown". An agent that advertises a method only once it is set up
   * (Hermes) reports "missing" without one; no session is opened then, and the catalog read reports the missing sign-in.
   */
  protected authentication(methods: readonly { readonly id: string; readonly type: string }[]): NativeModelCatalog["authentication"] { return "unknown"; }
  /**
   * Records a sign-in state that the agent reported on its own, outside initialize. From then on, catalog reads return
   * it, and open() refuses with NATIVE_AUTH_REQUIRED while it is "missing". A session that is already being opened and a
   * Turn that is already running are left alone: the agent itself decides whether they still reach a model. The reported
   * state outranks what the advertised authentication methods suggest, including when it arrives in the same stdout
   * chunk as the initialize response.
   */
  protected setAuthentication(state: NativeModelCatalog["authentication"]): void {
    this.reportedAuthentication = state; this.catalog = { ...this.catalog, authentication: state };
  }
  /**
   * Handles a notification outside session/update that this agent's driver understands, such as claude-agent-acp's
   * connection-level `_auth/status_update`. Returning true means the driver handled it, so the active Run records no
   * "Unsupported ACP notification" diagnostic. The default handles nothing; `$/cancel_request` is handled for every agent
   * before this hook and never reaches it. If the parameters name a session, the
   * notification reaches this hook only after that session is matched against the owned one. The hook runs on the
   * connection's reader, in stream order: it can run before initialize() resolves, during session setup, and during or
   * between Turns, so it must return without waiting. Throwing fails the connection, as a malformed message does, so a
   * driver should read the fields it needs leniently. Nothing from the parameters reaches a Run unless the driver emits it.
   */
  protected extensionNotification(_method: string, _params: Readonly<Record<string, unknown>>): boolean { return false; }
  /**
   * What one of the agent's own approval options changes beyond this request, shown with the request; empty when the
   * option names already say it (Claude's name the rule they would write).
   */
  protected permissionNote(options: readonly { readonly id: string; readonly kind: string; readonly name: string }[]): string { return ""; }
  /** A model the agent switched to on its own (its own command) without announcing it; reported as the session's model from now on. */
  protected adoptModel(id: string): void {
    if (!this.catalog.canSelect || !id || id.length > 1024 || /[\0\r\n]/u.test(id)) return;
    this.catalog = { ...this.catalog, models: this.catalog.models.some(row => row.id === id) ? this.catalog.models : [...this.catalog.models, { id, name: id }], defaultModel: id };
  }
  /** Waits for history replayed around a session/load response to go quiet; the window starts at the response. */
  private async replaySettled(): Promise<void> {
    this.lastReplay = Date.now();
    for (const deadline = Date.now() + REPLAY_SETTLE_MS; Date.now() - this.lastReplay < REPLAY_QUIET_MS && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, REPLAY_QUIET_MS));
  }
  async checkpoint(): Promise<string | null> {
    const session = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
    return this.conversation !== null && (this.capabilities.loadSession === true || session.resume !== undefined) ? this.conversation : null;
  }
  async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (this.catalog.authentication === "missing") throw new ControlError("NATIVE_AUTH_REQUIRED", "the Harness reported no usable sign-in or provider configuration");
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation !== null || this.opening || this.forking) throw new ControlError("INVALID_STATE", "this connection already owns a conversation");
    this.opening = true;
    try {
      let method = "session/new";
      if (checkpoint !== undefined) {
        const session = this.capabilities.sessionCapabilities == null ? {} : object(this.capabilities.sessionCapabilities, "native session capabilities");
        const load = this.capabilities.loadSession === true;
        method = session.resume !== undefined && !(this.restoreByLoad && load) ? "session/resume" : load ? "session/load" : "";
        if (!method) throw new ControlError("NATIVE_RESUME_UNAVAILABLE", "installed Harness did not advertise native recovery");
        this.conversation = nativeConversationId(checkpoint); this.replaying = true; this.lastReplay = Date.now();
      }
      const setup = Math.max(this.options.requestTimeoutMs, Math.min(SESSION_SETUP_MS, this.options.runTimeoutMs));
      const raw = await this.sessionRequest(method, { ...await this.sessionParameters(cwd), ...(checkpoint === undefined ? {} : { sessionId: this.conversation }) }, setup);
      const response = method === "session/load" ? loaded(raw) : object(raw, "native session setup result");
      if (checkpoint === undefined) this.conversation = nativeConversationId(response.sessionId);
      else if (response.sessionId !== undefined && response.sessionId !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "native restore changed the owned session identity");
      if (this.conversation === null) throw new ControlError("IDENTITY_MISMATCH", "native setup did not establish an owned conversation");
      if (method === "session/load") await this.replaySettled();
      this.replaying = false;
      this.readModels(response); this.configuredDefault=this.catalog.defaultModel;
      for (const params of this.openingMetadata.splice(0)) this.notification("session/update", params);
      // A value the session already runs is not requested again (Hermes's set_model can reroute an unchanged model).
      if (model !== undefined) {
        if (!this.catalog.canSelect || !this.catalog.models.some(row => row.id === model)) throw new ControlError("MODEL_UNAVAILABLE", "selected model is unavailable in this Harness");
        if (model === this.catalog.defaultModel) { /* already the session's model */ }
        else if (this.modelConfigId !== null) {
          const selected = object(await this.sessionRequest("session/set_config_option", { sessionId: this.conversation, configId: this.modelConfigId, value: model }), "model selection result");
          this.readModels(selected);
          if (this.catalog.defaultModel !== model) throw new ControlError("MODEL_MISMATCH", "Harness did not apply the selected model");
        } else if (this.legacyModels) {
          await this.sessionRequest("session/set_model", { sessionId: this.conversation, modelId: model });
          this.catalog = { ...this.catalog, defaultModel: model };
        }
      }
      for (const [key, value] of Object.entries(options ?? {})) {
        const setting = this.catalog.options?.find(option => option.id === key);
        if (!setting || !setting.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "native option unavailable for selected Harness");
        if (setting.currentValue === value) continue;
        // An agent need not echo its own mode change, so the applied mode is recorded as current.
        if (key === "__mode") { await this.sessionRequest("session/set_mode", { sessionId: this.conversation, modeId: value }); this.catalog = { ...this.catalog, options: this.catalog.options?.map(option => option.id === "__mode" ? { ...option, currentValue: value } : option) ?? [] }; }
        else { const response = object(await this.sessionRequest("session/set_config_option", { sessionId: this.conversation, configId: key, value }), "native setting result"); this.readModels(response); if (this.catalog.options?.find(option => option.id === key)?.currentValue !== value) throw new ControlError("NATIVE_OPTION_MISMATCH", "Harness did not apply its native setting"); }
      }
      return this.conversation;
    } catch (error) { const failure = this.nativeFailure(error); if (!(failure instanceof ControlError && ["MODEL_UNAVAILABLE","NATIVE_OPTION_UNAVAILABLE"].includes(failure.code))) this.rpc.abort(failure); throw failure; }
    finally { this.opening = false; this.replaying = false; this.openingMetadata.length = 0; }
  }
  async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "conversation is not owned by this connection");
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a prompt is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    const pointers = this.fileBlocks ? [] : attachments.filter(file => file.kind === "file");
    const blocks: Record<string, unknown>[] = [{ type: "text", text: prompt + fileMentions(pointers) }];
    for (const file of attachments) if (!pointers.includes(file)) blocks.push(await this.promptBlock(file));
    if (this.active !== null) throw new ControlError("INVALID_STATE", "a prompt is already active");
    const active: ActivePrompt = { event: onEvent, lastUpdate: 0, answered: false, tools: new Map(), compaction: new Map(), stopping: false, settled: false, stop: null, deadline: Date.now() + this.options.runTimeoutMs };
    this.active = active;
    // Evidence of the prompt reaching the history is about content: a command's answer (a local reply) proves no such thing.
    const content = this.readsAsContent(prompt, attachments.map(file => file.kind));
    const recorded = (reason: string | null): { readonly input?: "recorded" } => content && (active.answered || reason !== null && this.promptRecorded(reason)) ? { input: "recorded" } : {};
    const result = this.rpc.request("session/prompt", { sessionId: id, prompt: blocks }, this.options.runTimeoutMs)
      .then(value => {
        const response = object(value, "session/prompt result");
        const reason = string(response.stopReason, "ACP stop reason");
        const usage = response.usage == null ? null : object(response.usage, "ACP prompt usage");
        if (usage !== null && !active.settled) {
          const turn = { input: count(usage.inputTokens), output: count(usage.outputTokens), cachedInput: count(usage.cachedReadTokens), cacheWrite: count(usage.cachedWriteTokens), reasoning: count(usage.thoughtTokens), total: count(usage.totalTokens) };
          const defined = Object.fromEntries(Object.entries(turn).filter(([, amount]) => amount !== undefined));
          if (Object.keys(defined).length) active.event({ type: "usage", usage: { turn: defined } });
        }
        let status: BackendResult["status"];
        switch (reason) {
          case "end_turn": status = "completed"; break;
          case "cancelled": status = "cancelled"; break;
          case "max_tokens": case "max_turn_requests": case "refusal": status = "failed"; break;
          default: throw new ControlError("INVALID_PROTOCOL", "unknown ACP stop reason");
        }
        return { status, reason } as BackendResult;
      }).then(async result => {
        // Late chunks of this prompt still belong to it: the turn settles only once they have stopped.
        const quiet = this.trailingQuietMs;
        if (quiet > 0) for (const answered = Date.now(); Date.now() - Math.max(active.lastUpdate, answered) < quiet && Date.now() - answered < TRAILING_SETTLE_MS;) await new Promise(resolve => setTimeout(resolve, Math.min(quiet, 50)));
        return { ...result, ...recorded(result.reason) };
      }).catch((error: unknown): BackendResult => {
        if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) {
          const named = this.refusal("session/prompt", error, active.event), stands = this.refusedPrompt(error);
          // Where the driver cannot place the refusal before or after insertion, only the agent's answer proves the prompt recorded.
          return { status: "failed", reason: "request_rejected", ...(named !== null ? { error: { code: named.code, message: named.message } } : error.remoteFailure ? { error: error.remoteFailure } : {}),
            ...(stands === "not_recorded" ? { input: stands } : stands === "recorded" && content ? { input: stands } : recorded(null)) };
        }
        // The prompt request's own timeout is the Turn's deadline, reported as every driver reports it.
        const failure = error instanceof ControlError && error.code === "REQUEST_TIMEOUT" ? new ControlError("RUN_TIMEOUT", "ACP prompt exceeded its deadline") : errorFrom(error);
        this.rpc.abort(failure); throw failure;
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
  async decidePermission(id: string, option: string, input?: string): Promise<void> {
    const pending = this.permissions.get(id); if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "permission or actual option unavailable");
    this.permissions.delete(id); pending.resolve(pending.reply ? pending.reply(option, input) : { outcome: { outcome: "selected", optionId: option } });
  }
  private cancelPermissions(): void { for (const pending of this.permissions.values()) pending.resolve(pending.reply ? pending.reply("cancel") : { outcome: { outcome: "cancelled" } }); this.permissions.clear(); }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); return this.rpc.close(); }
  private nativeFailure(error: unknown): Error { return error instanceof ControlError && error.remoteFailure ? new ControlError(error.remoteFailure.code, error.remoteFailure.message) : errorFrom(error); }
  /** One session request whose refusal the driver may name (refusal()); any other outcome is the request's own. */
  private async sessionRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    try { return await this.rpc.request(method, params, timeoutMs); }
    catch (error) {
      const named = error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null ? this.refusal(method, error) : null;
      throw named === null ? error : new ControlError(named.code, named.message);
    }
  }
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
    // A fork connection opens no conversation; the agent's replay of the copied history is counted, never attributed.
    if (this.forking) { this.replayBytes += Buffer.byteLength(JSON.stringify(raw ?? null)); if (this.replayBytes > 64 * 1024 * 1024) throw new ControlError("REPLAY_LIMIT", "native fork replay exceeded its budget"); this.unattributed++; return; }
    if (method !== "session/update") {
      const params = raw === undefined ? {} : object(raw, "ACP notification params");
      if (params.sessionId !== undefined) this.scope(params);
      if (method === "$/cancel_request") { this.withdraw(params.requestId); return; }
      if (!this.extensionNotification(method, params)) this.active?.event({ type: "diagnostic", message: `Unsupported ACP notification: ${method}` });
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
      this.lastReplay = Date.now();
      this.replayBytes += Buffer.byteLength(JSON.stringify(params));
      if (this.replayBytes > 64 * 1024 * 1024) throw new ControlError("REPLAY_LIMIT", "native history replay exceeded its budget");
      if (this.collected && (kind === "user_message_chunk" || kind === "agent_message_chunk")) { this.collect(kind === "user_message_chunk" ? "user" : "assistant", update.content); return; }
      if (!metadataUpdates.has(kind)) return;
    }
    if (kind === "config_option_update") { this.readModels(update); return; }
    if (kind === "available_commands_update") {
      if (!Array.isArray(update.availableCommands) || update.availableCommands.length > MAX_NATIVE_COMMANDS) throw new ControlError("INVALID_PROTOCOL", "native commands exceed their budget");
      this.catalog = { ...this.catalog, commands: update.availableCommands.map(value => { const command = object(value, "native command"); return { name: string(command.name, "native command name", 256), description: typeof command.description === "string" ? text(command.description, "native command description").slice(0, 1024) : "" }; }) };
      this.commandsAnnounced(); return;
    }
    if (kind === "current_mode_update") { const mode = string(update.currentModeId, "current native mode", 128); this.catalog = { ...this.catalog, options: this.catalog.options?.map(option => option.id === "__mode" ? { ...option, currentValue: mode } : option) ?? [] }; return; }
    const active = this.active;
    if (kind === "usage_update" || kind === "plan") {
      if (!active || active.settled) return;
      if (kind === "plan") {
        if (!Array.isArray(update.entries) || update.entries.length > 256) throw new ControlError("INVALID_PROTOCOL", "invalid native plan");
        active.event({ type: "plan", entries: update.entries.map(value => { const entry = object(value, "plan entry"); const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
          return { content: typeof entry.content === "string" ? entry.content : "", status, ...(entry.priority === "high" || entry.priority === "medium" || entry.priority === "low" ? { priority: entry.priority } : {}) }; }) });
      } else {
        const used = count(update.used), size = count(update.size), cost = update.cost == null ? null : object(update.cost, "native cost");
        const usage: NativeUsage = { ...(used === undefined ? {} : { context: { used, ...(size ? { size } : {}) } }),
          ...(cost !== null && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0 && typeof cost.currency === "string" ? { cost: { amount: cost.amount, currency: cost.currency.slice(0, 16), scope: "session" as const } } : {}) };
        if (Object.keys(usage).length) active.event({ type: "usage", usage });
      }
      return;
    }
    if (metadataUpdates.has(kind)) return;
    // Native agents can stream autonomous follow-ups (background task completions, late frames) between
    // prompts. They belong to no public Run, so they are counted and never attributed to another Turn.
    if (!active || active.settled) { this.unattributed++; return; }
    active.lastUpdate = Date.now();
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call" || kind === "tool_call_update") active.answered = true;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      const content = object(update.content, "ACP message content");
      if (content.type !== "text") {
        if (kind !== "agent_message_chunk") return;
        const output = outputOf(content);
        if (output) active.event({ type: "output", output });
        else active.event({ type: "diagnostic", message: "Harness returned " + string(content.type, "ACP content type", 64) + " content that could not be kept" });
        return;
      }
      const value = text(content.text, "ACP text chunk");
      if (kind === "agent_message_chunk") active.event({ type: "text", text: value });
      if (kind === "agent_thought_chunk") active.event({ type: "thinking", text: value });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolId = string(update.toolCallId, "tool call identity");
      // Agents may announce a call from a permission request and again from the model stream, or update a call
      // first seen in a replay window. Identity is merged within this prompt; it never crosses prompts.
      const prior = active.tools.get(toolId);
      if (!prior && active.tools.size >= MAX_PROMPT_TOOLS) throw new ControlError("TOOL_LIMIT", "tool identity budget exhausted");
      const title = update.title == null ? prior?.title ?? "工具调用" : label(update.title, prior?.title ?? "工具调用");
      const detail = toolDetail(update);
      const status = this.toolStatus(update.status == null ? (prior?.status ?? "pending") : string(update.status, "tool status", 64), detail);
      active.tools.set(toolId, { title, status });
      active.event({ type: "tool", id: toolId, title, status, ...(detail ? { detail } : {}) });
      return;
    }
    if (kind === "notice") {
      const severity = update.severity === "warning" || update.severity === "error" ? update.severity : "info";
      active.event({ type: "notice", severity, title: label(update.title, "提示", 1024), ...(typeof update.description === "string" && update.description ? { detail: update.description.slice(0, 4096) } : {}) }); return;
    }
    if (kind === "compaction_update" || kind === "compaction_summary_chunk") {
      const id = string(update.compactionId, "compaction identity", 512);
      if (kind === "compaction_summary_chunk") { const content = object(update.content, "compaction summary"); if (content.type === "text") active.compaction.set(id, ((active.compaction.get(id) ?? "") + text(content.text, "compaction summary")).slice(-4096)); return; }
      const status = update.status === "completed" || update.status === "failed" || update.status === "cancelled" ? update.status : "running";
      const summary = Array.isArray(update.summary) ? update.summary.flatMap(item => field(item, "type") === "text" && typeof field(item, "text") === "string" ? [field(item, "text") as string] : []).join("\n") : active.compaction.get(id);
      active.event({ type: "activity", id, kind: "compaction", title: "上下文压缩", status, ...(typeof update.error === "string" ? { detail: update.error } : summary ? { detail: summary.slice(0, 4096) } : {}) }); return;
    }
    active.event({ type: "diagnostic", message: `Unsupported ACP session update: ${kind}` });
  }
  /**
   * The agent withdrew a request it still had open (`$/cancel_request {requestId}`; claude-agent-acp sends it when Claude
   * Code takes back an approval or a question). The approval, or the form field being asked, closes as cancelled and the
   * Turn says why; nothing is answered, since the agent no longer waits for it. A request that is no longer pending here
   * (already answered, or never asked) closes nothing, and only the diagnostic records the withdrawal.
   */
  private withdraw(requestId: unknown): void {
    const request = typeof requestId === "string" || (typeof requestId === "number" && Number.isSafeInteger(requestId)) ? String(requestId) : null;
    const withdrawn = request === null ? [] : [...this.permissions].filter(([, pending]) => pending.request === request);
    for (const [id, pending] of withdrawn) {
      this.permissions.delete(id); pending.dispose?.();
      this.active?.event({ type: "permission", id, decision: "cancelled" });
    }
    this.active?.event({ type: "diagnostic", message: withdrawn.length ? "原程序撤回了这项请求" : "原程序撤回了一项已不在等待中的请求" });
  }
  /**
   * A native form (Claude's AskUserQuestion, or an MCP server's form passed on by the agent), asked field by field like a
   * native question: a choice, a free-text answer (a select's "_custom" companion becomes its "提交回答"), yes/no, or several
   * picks. "跳过" declines the whole form and "取消" cancels it. A form with fields the chat cannot ask is declined, not guessed.
   */
  private async elicitation(request: RpcRequest): Promise<unknown> {
    const params = object(request.params, "ACP elicitation"); this.scope(params);
    const active = this.active;
    if (!active || active.settled || active.stopping || !this.interactivePermissions || (params.mode !== undefined && params.mode !== "form")) { if (active && !active.settled) active.event({ type: "permission", id: String(request.id), decision: "denied" }); return { action: "decline" }; }
    const schema = object(params.requestedSchema, "elicitation schema"), properties = object(schema.properties, "elicitation fields"), keys = Object.keys(properties);
    if (!keys.length || keys.length > 64) throw new ControlError("INVALID_PROTOCOL", "invalid elicitation fields");
    const message = typeof params.message === "string" ? params.message.slice(0, 4096) : "";
    const companions = new Set(keys.filter(key => key.endsWith("_custom") && keys.includes(key.slice(0, -7)) && object(properties[key], "elicitation field").type === "string"));
    type Field = { key: string; title: string; kind: "choice" | "multi" | "text" | "boolean"; choices: { value: unknown; label: string; description?: string }[]; custom: string | null };
    const fields: Field[] = []; let unsupported = false;
    const choicesOf = (value: unknown): Field["choices"] | null => {
      const field = value !== null && typeof value === "object" ? value as Record<string, unknown> : {}, listed = Array.isArray(field.oneOf) ? field.oneOf : Array.isArray(field.anyOf) ? field.anyOf : null;
      if (listed) return listed.slice(0, 128).flatMap(item => { const row = object(item, "elicitation choice"); return typeof row.const === "string" ? [{ value: row.const, label: typeof row.title === "string" ? row.title.slice(0, 1024) : row.const, ...(typeof row.description === "string" ? { description: row.description.slice(0, 1024) } : {}) }] : []; });
      if (Array.isArray(field.enum)) { const names = Array.isArray(field.enumNames) ? field.enumNames : []; return field.enum.slice(0, 128).flatMap((item, index) => typeof item === "string" ? [{ value: item, label: typeof names[index] === "string" ? names[index] as string : item }] : []); }
      return null;
    };
    for (const key of keys) {
      if (companions.has(key)) continue;
      const field = object(properties[key], "elicitation field"), custom = companions.has(key + "_custom") ? key + "_custom" : null;
      const title = (keys.length - companions.size === 1 && message ? message : typeof field.description === "string" ? field.description : typeof field.title === "string" ? field.title : message || key).slice(0, 4096);
      if (field.type === "string") { const choices = choicesOf(field); fields.push({ key, title, kind: choices?.length ? "choice" : "text", choices: choices ?? [], custom }); }
      else if (field.type === "boolean") fields.push({ key, title, kind: "boolean", choices: [{ value: true, label: "是" }, { value: false, label: "否" }], custom: null });
      else if (field.type === "array") { const choices = choicesOf(field.items); if (choices?.length) fields.push({ key, title, kind: "multi", choices, custom }); else unsupported = true; }
      else unsupported = true;
    }
    if (unsupported) { active.event({ type: "notice", severity: "warning", title: "原生表单含无法在对话中填写的字段，已拒绝" }); return { action: "decline" }; }
    const content: Record<string, unknown> = {};
    for (const [index, field] of fields.entries()) {
      if (this.active !== active || active.settled || active.stopping) return { action: "cancel" };
      if (this.permissions.size >= 32) throw new ControlError("PERMISSION_LIMIT", "too many native permission requests");
      const id = String(request.id) + ":" + index, text = field.kind === "text" || field.custom !== null;
      const options = [...field.choices.map((choice, position) => ({ id: "answer-" + position, name: choice.label })), ...(text ? [{ id: "submit", name: "提交回答" }] : []), { id: "skip", name: "跳过" }, { id: "cancel", name: "取消" }];
      const detail = field.choices.filter(choice => choice.description).map(choice => choice.label + "：" + choice.description).join("\n").slice(0, 4096);
      type Answer = { readonly kind: "value"; readonly value: unknown; readonly typed: boolean } | { readonly kind: "skip" } | { readonly kind: "cancel" };
      const answer = await new Promise<unknown>(resolve => {
        this.permissions.set(id, { request: String(request.id), options: options.map(option => option.id), resolve, reply: (option, input) => {
          if (option === "cancel" || option === "skip") return { kind: option };
          if (option === "submit") return { kind: "value", value: typeof input === "string" ? input : "", typed: true };
          return { kind: "value", value: field.choices[Number(option.slice(7))]?.value ?? null, typed: false };
        } });
        active.event({ type: "permission_requested", id, title: field.title, ...(detail ? { detail } : {}), options, ...(text ? { input: { kind: "text", value: "" } } : {}), kind: "question", ...requestExpiry(active.deadline, null) });
      }) as Answer;
      if (answer.kind === "cancel") return { action: "cancel" };
      if (answer.kind === "skip") return { action: "decline" };
      if (answer.typed && field.custom !== null) content[field.custom] = answer.value;
      else content[field.key] = field.kind === "multi" ? [answer.value] : answer.value;
    }
    return { action: "accept", content };
  }
  private serverRequest(request: RpcRequest): unknown {
    if (request.method === "elicitation/create") return this.elicitation(request);
    if (request.method !== "session/request_permission") {
      // Unadvertised client methods (OpenCode fs/write_text_file after an approved edit, Cursor extensions) get -32601; the Run keeps an audit line.
      if (this.active && !this.active.settled) this.active.event({ type: "diagnostic", message: "Harness called unsupported client method " + label(request.method, "unknown", 128) });
      throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
    }
    const params = object(request.params, "ACP permission params"); this.scope(params);
    const active = this.active;
    // No public Run owns an autonomous follow-up, so nobody can approve it: cancel instead of tearing down the connection.
    if (!active || active.settled) { this.unattributed++; return { outcome: { outcome: "cancelled" } }; }
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
    const reject = options.find(option => option.kind === "reject_once") ?? options.find(option => option.kind === "reject_always");
    if (this.interactivePermissions && !active.stopping) {
      if (this.permissions.size >= 32) throw new ControlError("PERMISSION_LIMIT", "too many native permission requests");
      const id = String(request.id), deadline = this.approvalDeadlineMs, seconds = deadline === null ? 0 : Math.round(deadline / 1000);
      const detail = [permissionDetail(tool), this.permissionNote(options), deadline === null ? "" : `原程序最多等待 ${seconds} 秒，超时会自动拒绝。`].filter(Boolean).join("\n");
      return new Promise<unknown>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (value: unknown): void => { clearTimeout(timer); resolve(value); };
        this.permissions.set(id, { request: id, options: options.map(option => option.id), resolve: settle, dispose: () => clearTimeout(timer) });
        active.event({ type: "permission_requested", id, title: typeof tool.title === "string" ? tool.title.slice(0,4096) : "Harness 请求执行工具", ...(detail ? { detail } : {}), options: options.map(({ id, name }) => ({ id, name })),
          ...requestExpiry(active.deadline, deadline === null ? null : Math.max(0, deadline - APPROVAL_DEADLINE_MARGIN_MS)) });
        // The agent refuses on its own at its deadline; the public request closes just before, so no late choice looks applied.
        if (deadline !== null) timer = setTimeout(() => {
          if (this.permissions.get(id)?.resolve !== settle || this.active !== active || active.settled) return;
          this.permissions.delete(id);
          active.event({ type: "notice", severity: "warning", title: "审批已超时", detail: `原程序等待审批的 ${seconds} 秒已到，按它的规则拒绝了这次请求。` });
          active.event({ type: "permission", id, decision: "denied" });
          settle(reject ? { outcome: { outcome: "selected", optionId: reject.id } } : { outcome: { outcome: "cancelled" } });
        }, Math.max(0, deadline - APPROVAL_DEADLINE_MARGIN_MS));
      });
    }
    if (active.stopping || !reject) {
      active.event({ type: "permission", id: String(request.id), decision: "cancelled" });
      return { outcome: { outcome: "cancelled" } };
    }
    active.event({ type: "permission", id: String(request.id), decision: "denied" });
    return { outcome: { outcome: "selected", optionId: reject.id } };
  }
}
