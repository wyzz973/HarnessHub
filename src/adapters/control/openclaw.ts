import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { MAX_NATIVE_EXTENSIONS, TOOL_INPUT_BYTES, TOOL_OUTPUT_BYTES, type NativeExtensions, type NativeSessionImport, type NativeSessionPage, type BackendResult, type ControlEvent, type ControlRun, type ControlLaunch, type ControlOptions, type NativeConversationId, type NativeInputs, type NativeModelCatalog, type NativeOption, type NativeOptions, type NativeToolDetail, type CleanupEvidence } from "../../contracts/control.js";
import { AcpControl } from "./acp.js";
import { classifyRemoteFailure, ControlError, object } from "../../infrastructure/control/json-rpc-process.js";
import { nativeCommand } from "../../infrastructure/control/native-command.js";
import { string } from "../../infrastructure/control/json-rpc-process.js";
import { checkInputs } from "../../infrastructure/control/attachments.js";
import type { ContentRef, ControlAttachment } from "../../contracts/content.js";

type OpenClawMethod = "agents.list" | "models.list" | "sessions.patch" | "sessions.get" | "sessions.list" | "chat.history" | "skills.status" | "tools.catalog";
/** The Hub's own Gateway session keys; no other key is patched or continued. */
const HUB_KEY = /^agent:[a-z0-9_-]+:harnesshub:[a-f0-9-]+$/u;
/** Transcript entries read back after a Turn (ADR-027); a longer Turn's earliest entries fall outside this window. */
const TRANSCRIPT_WINDOW = 200;
/** An agent id OpenClaw keeps as written (`normalizeAgentId`), so it can be the agent segment of a session key. */
const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
/** The most agents a roster may name for HarnessHub to read it. */
const MAX_AGENTS = 256;
/** Why a new session cannot be opened when OpenClaw itself has no default agent. */
const SELECTION_REQUIRED = "OpenClaw 没有默认代理（配置了多个代理却没有指定归属，或代理名册为空），要求显式选择代理；HarnessHub 不替你选。请在 OpenClaw 中设置 agents.defaults.systemAgent.agentId。";
/** One configured agent: its id as written (empty when the entry names none) and its entry (empty for the implicit `main`). */
export interface OpenClawAgent { readonly id: string; readonly entry: Readonly<Record<string, unknown>> }
/**
 * The agent roster of an openclaw.json, read the way OpenClaw reads it; pure, nothing is run. Which agent sessions without
 * an explicit target run as (`owner`):
 * - keyed `agents.entries`, the form 2026.10.5 requires (agents/agent-roster.ts and gateway/agent-list.ts at v2026.10.5):
 *   the one agent marked `default: true` unless `agents.ownership` is "explicit", else the sole agent, else in an explicit
 *   fleet the configured agent `agents.defaults.systemAgent.agentId` names; otherwise none (null), since OpenClaw then
 *   requires an explicit selection and HarnessHub does not pick one;
 * - the legacy `agents.list` array, which only Gateways that predate keyed rosters run with (2026.10.5 refuses it until
 *   its Doctor migrates it): the first agent marked `default: true`, else the first, else `main` (2026.3.23-2
 *   resolveDefaultAgentId);
 * - no roster: the implicit `main`.
 * `inherits` says whether that owner takes the shared default workspace when its own entry names none (OpenClaw's legacy
 * data owner: a marked, sole or implicit agent); the system agent of an explicit fleet does not. A shape OpenClaw would not
 * run with comes back as `problem` instead.
 */
export type OpenClawRoster = { readonly problem: string } | { readonly form: "entries" | "list" | "none"; readonly agents: readonly OpenClawAgent[];
  readonly defaults: Readonly<Record<string, unknown>>; readonly owner: OpenClawAgent | null; readonly inherits: boolean };
export function openClawRoster(config: unknown): OpenClawRoster {
  const plain = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(config)) return { problem: "the configuration is not an object" };
  const agents = config.agents === undefined ? {} : config.agents, defaults = plain(agents) ? agents.defaults === undefined ? {} : agents.defaults : null;
  if (!plain(agents) || !plain(defaults)) return { problem: "invalid native agent settings" };
  const implicit: OpenClawAgent = { id: "main", entry: {} };
  // OpenClaw reads the keyed form whenever it is present, the array only without it (readAgentRosterProperty).
  if (agents.entries !== undefined) {
    const entries = agents.entries;
    if (!plain(entries) || Object.keys(entries).length > MAX_AGENTS) return { problem: "invalid native agent roster" };
    const roster: OpenClawAgent[] = [];
    for (const [id, entry] of Object.entries(entries)) { if (!plain(entry)) return { problem: "invalid native agent" }; roster.push({ id, entry }); }
    const explicit = agents.ownership === "explicit", marked = explicit ? [] : roster.filter(agent => agent.entry.default === true);
    if (marked.length === 1) return { form: "entries", agents: roster, defaults, owner: marked[0]!, inherits: true };
    if (roster.length === 1) return { form: "entries", agents: roster, defaults, owner: roster[0]!, inherits: true };
    const system = plain(defaults.systemAgent) && typeof defaults.systemAgent.agentId === "string" ? defaults.systemAgent.agentId.trim().toLowerCase() : "";
    return { form: "entries", agents: roster, defaults, owner: explicit && system ? roster.find(agent => agent.id.toLowerCase() === system) ?? null : null, inherits: false };
  }
  if (agents.list !== undefined) {
    const list = agents.list;
    if (!Array.isArray(list) || list.length > MAX_AGENTS) return { problem: "invalid native agent catalog" };
    const roster: OpenClawAgent[] = [];
    for (const entry of list) { if (!plain(entry)) return { problem: "invalid native agent" }; roster.push({ id: typeof entry.id === "string" ? entry.id : "", entry }); }
    const chosen = roster.find(agent => agent.entry.default === true) ?? roster[0];
    // An entry without an id stands for `main`, as OpenClaw names it; an id of another type is no agent id at all.
    const owner = chosen === undefined ? implicit : chosen.entry.id == null ? { id: "main", entry: chosen.entry } : chosen;
    return { form: "list", agents: roster, defaults, owner, inherits: true };
  }
  return { form: "none", agents: [], defaults, owner: implicit, inherits: true };
}
/** A configured model reference (`model` as a string, or its `primary`); null when the entry and the defaults name none. */
function configuredModel(entry: Readonly<Record<string, unknown>> | undefined, defaults: Readonly<Record<string, unknown>>): string | null {
  const model = entry?.model ?? defaults.model;
  const primary = typeof model === "string" ? model : model == null ? null : object(model, "native model").primary;
  if (primary != null && (typeof primary !== "string" || !primary.trim() || primary.length > 1024 || /[\0\r\n]/u.test(primary))) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native configured model");
  return primary ?? null;
}
/**
 * Whether the bridge's ACP modes (the generic layer's `__mode` option) offer exactly its thinking levels. OpenClaw
 * (2026.3.23-2, 2026.10.5) builds both from one list and its set_mode patches thinkingLevel, so such a mode is the thinking
 * level again.
 */
function repeatsThinking(options: readonly NativeOption[] | undefined): boolean {
  const mode = options?.find(option => option.id === "__mode"), levels = new Set(options?.find(option => option.id === "thought_level")?.values.map(row => row.value));
  return mode !== undefined && levels.size > 0 && mode.values.length === levels.size && mode.values.every(row => levels.has(row.value));
}
/** A Turn that ended before its prompt because the selected model could not be confirmed: failed, and nothing was sent. */
function notSent(error: ControlError): ControlRun {
  return { result: Promise.resolve({ status: "failed", reason: "model_not_applied", error: { code: error.code, message: "OpenClaw 没有确认所选模型，这条消息没有发出。" } }),
    requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "this Turn ended before its prompt was sent")) };
}
/** A Gateway session row's model in the catalog's provider/model form. */
function rowModel(row: Record<string, unknown>): string | null {
  return typeof row.modelProvider === "string" && typeof row.model === "string" && row.modelProvider && row.model && (row.modelProvider + "/" + row.model).length <= 1024 && !/[\0\r\n]/u.test(row.modelProvider + row.model) ? row.modelProvider + "/" + row.model : null;
}
/** The Gateway session row's field behind each setting the bridge offers, besides fast mode (STRING_CONFIG_FIELDS at v2026.10.5). */
const SETTING_FIELDS: Readonly<Record<string, string>> = { thought_level: "thinkingLevel", verbose_level: "verboseLevel", trace_level: "traceLevel", reasoning_level: "reasoningLevel",
  response_usage: "responseUsage", elevated_level: "elevatedLevel" };
/**
 * A Gateway fast mode (a boolean, "auto" or "ultrafast") as the bridge's fast_mode value, the way the bridge presents it:
 * "auto" stays "auto", any other fast mode is "on", none is "off". Undefined for anything else.
 */
function fastMode(value: unknown): string | undefined {
  return value === "auto" ? "auto" : value === true || value === "ultrafast" ? "on" : value === false ? "off" : undefined;
}
function transcriptSeq(value: unknown): number | null {
  const meta = value !== null && typeof value === "object" ? (value as { __openclaw?: { seq?: unknown } }).__openclaw : undefined;
  return typeof meta?.seq === "number" && Number.isSafeInteger(meta.seq) ? meta.seq : null;
}
function blocks(value: unknown): readonly Record<string, unknown>[] {
  const content = value !== null && typeof value === "object" ? (value as { content?: unknown }).content : undefined;
  return Array.isArray(content) ? content.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}
function textOf(value: unknown): string { return blocks(value).flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n"); }
function cap(value: string, limit: number, tail = false): { text: string; cut: boolean } {
  const bytes = Buffer.from(value); if (bytes.length <= limit) return { text: value, cut: false };
  return { text: new TextDecoder().decode(tail ? bytes.subarray(bytes.length - limit) : bytes.subarray(0, limit)), cut: true };
}
const TOOL_KIND: Readonly<Record<string, string>> = { exec: "execute", bash: "execute", process: "execute", read: "read", write: "edit", edit: "edit", apply_patch: "edit", web_search: "search", web_fetch: "fetch", memory_search: "search", sessions_spawn: "subagent" };
/** The ACP tool statuses that end a call; a streamed call left before them has not told its outcome. */
const SETTLED_TOOL = new Set(["completed", "failed"]);
/** A tool call the bridge streamed during the Turn, as last shown: its title and status. */
interface ShownTool { readonly title: string; readonly status: string }
/**
 * Maps the turn's own transcript entries (Pi-format agent messages) to public tool, thinking and usage facts and the real
 * outcome. A tool call the bridge already streamed under the same id (`live`) keeps its row and live title: it is not
 * emitted again, and only an outcome the stream never settled is added from the transcript's result, as a status update.
 */
function reconcileTurn(entries: readonly unknown[], backend: BackendResult, emit: (event: ControlEvent) => void, withThinking: boolean, live: ReadonlyMap<string, ShownTool>): BackendResult {
  const results = new Map<string, { output: string; failed: boolean }>();
  for (const entry of entries) {
    const row = entry as Record<string, unknown>;
    if (row.role === "toolResult" && typeof row.toolCallId === "string") results.set(row.toolCallId, { output: textOf(row), failed: row.isError === true });
  }
  const usage = { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0 }, cost = { amount: 0 };
  let counted = false, last: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const row = entry as Record<string, unknown>;
    if (row.role !== "assistant") continue;
    last = row;
    for (const block of blocks(row)) {
      if (withThinking && block.type === "thinking" && typeof block.thinking === "string" && block.thinking) emit({ type: "thinking", text: block.thinking + "\n" });
      if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      const done = results.get(block.id), shown = live.get(block.id);
      if (shown !== undefined) {
        if (done !== undefined && !SETTLED_TOOL.has(shown.status)) emit({ type: "tool", id: block.id, title: shown.title, status: done.failed ? "failed" : "completed" });
        continue;
      }
      const input = cap(JSON.stringify(block.arguments ?? {}, null, 2), TOOL_INPUT_BYTES), output = done ? cap(done.output, TOOL_OUTPUT_BYTES, true) : null;
      const args = block.arguments !== null && typeof block.arguments === "object" ? block.arguments as Record<string, unknown> : {};
      const summary = [args.command, args.path, args.file_path, args.query, args.url].find(value => typeof value === "string") as string | undefined;
      emit({ type: "tool", id: block.id.slice(0, 256), title: (block.name + (summary ? ": " + summary : "")).replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, 4096), status: done ? (done.failed ? "failed" : "completed") : "completed",
        detail: { kind: TOOL_KIND[block.name] ?? "other", name: block.name.slice(0, 256), input: input.text, ...(output?.text ? { output: output.text } : {}), ...(input.cut || output?.cut ? { truncated: true } : {}) } satisfies NativeToolDetail });
    }
    const call = row.usage !== null && typeof row.usage === "object" ? row.usage as Record<string, unknown> : null;
    if (call) {
      counted = true;
      const add = (key: keyof typeof usage, value: unknown) => { if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] += value; };
      add("input", call.input); add("output", call.output); add("cachedInput", call.cacheRead); add("cacheWrite", call.cacheWrite); add("total", call.totalTokens);
      const spent = call.cost !== null && typeof call.cost === "object" ? (call.cost as { total?: unknown }).total : undefined;
      if (typeof spent === "number" && Number.isFinite(spent) && spent > 0) cost.amount += spent;
    }
  }
  if (counted) emit({ type: "usage", usage: { turn: usage, ...(cost.amount > 0 ? { cost: { amount: cost.amount, currency: "USD", scope: "turn" } } : {}) } });
  // The bridge turns a model or provider error into end_turn; the transcript keeps the real stop reason.
  if (backend.status === "completed" && last?.stopReason === "error") {
    const classified = typeof last.errorMessage === "string" ? classifyRemoteFailure(last.errorMessage) : undefined;
    return { status: "failed", reason: "native_error", error: classified ?? { code: "MODEL_REQUEST_FAILED", message: "OpenClaw 的模型请求失败；原生会话记录了这个错误。" } };
  }
  return backend;
}

/** One model of the original catalog; `unavailable` is why the Gateway reports it unavailable (`available: false`), else null. */
interface OpenClawModel { readonly id: string; readonly name: string; readonly inputs?: NativeInputs; readonly unavailable: string | null }
/** Why the Gateway reports a model unavailable: its reason (missing-auth, auth-failed, cooldown) and, when it says, until when. */
function unavailability(row: Readonly<Record<string, unknown>>): string {
  const reason = typeof row.unavailableReason === "string" && /^[a-z0-9-]{1,64}$/u.test(row.unavailableReason) ? row.unavailableReason : "unavailable";
  const until = typeof row.unavailableUntil === "number" && Number.isSafeInteger(row.unavailableUntil) && row.unavailableUntil > 0 && row.unavailableUntil <= 8.64e15 ? row.unavailableUntil : null;
  return until === null ? reason : reason + " until " + new Date(until).toISOString();
}

/**
 * The installed OpenClaw bridge accepts sessionKey in _meta. A normal chat key avoids its ACP-runtime namespace. Session
 * forks follow the generic declaration check: neither 2026.3.23-2's bridge nor 2026.10.5's declares session/fork, so a
 * branch is refused with NATIVE_FORK_UNAVAILABLE by the program's own report rather than by this driver.
 */
export class OpenClawControl extends AcpControl {
  private configuredModel: string | null = null;
  /** The model chosen at open(), found in the original catalog; the session runs it from its first prompt on. */
  private selectedModel: string | undefined;
  /** The selected model once confirmed as the session's own before its first prompt; later Turns leave the model alone. */
  private appliedModel: string | undefined;
  private sessionKey: string | null = null;
  private restoredKey: string | null = null;
  private readonly abort = new AbortController();
  private readonly commands = new Set<Promise<unknown>>();
  private nativeModels: Promise<readonly OpenClawModel[]> | null = null;
  /** Models the read catalog reports unavailable, not yet said in a Turn's diagnostics; said once per connection. */
  private unreported: readonly OpenClawModel[] = [];
  /** Session settings read back after the latest Turn; the bridge never pushes changes made by slash commands. */
  private sessionSettings: Promise<{ readonly model: string | null; readonly values: Readonly<Record<string, string>> }> | null = null;
  constructor(private readonly nativeLaunch: ControlLaunch, private readonly nativeOptions: ControlOptions,
    private readonly nativeRequest?: (method: OpenClawMethod, params: Readonly<Record<string, unknown>>) => Promise<unknown>) { super(nativeLaunch, nativeOptions); }
  /**
   * The Hub's session key and the configured model. A restored session keeps its own key and so its agent. A new one runs
   * as OpenClaw's own default agent: with a legacy `agents.list` array the file decides (only Gateways that predate keyed
   * rosters run with one); otherwise the Gateway's agents.list decides, as it also resolves migrated ownership and the
   * effective model, and the file's keyed roster stands in when the Gateway does not provide it (openClawRoster). A roster
   * without an owner fails with NATIVE_CONFIGURATION_INVALID: HarnessHub does not pick an agent for the user. The
   * configured model is the Gateway's primary for that agent, else the agent's or the defaults' `model` in the file.
   */
  protected override async sessionParameters(cwd: string): Promise<Readonly<Record<string, unknown>>> {
    const roster = await this.readRoster();
    const find = (agent: string) => roster.agents.find(item => item.id.toLowerCase() === agent.toLowerCase())?.entry;
    if (this.restoredKey !== null) {
      this.configuredModel = configuredModel(find(this.restoredKey.split(":")[1]!), roster.defaults);
      this.sessionKey = this.restoredKey;
    } else {
      const gateway = roster.form === "list" ? null : await this.gatewayAgent();
      const owner = gateway === null ? roster.owner : { id: gateway.agent, entry: find(gateway.agent) ?? {} };
      if (owner === null) throw new ControlError("NATIVE_CONFIGURATION_INVALID", SELECTION_REQUIRED);
      if (!AGENT_ID.test(owner.id)) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "invalid native default agent");
      this.configuredModel = gateway?.model ?? configuredModel(owner.entry, roster.defaults);
      this.sessionKey = "agent:" + owner.id.toLowerCase() + ":harnesshub:" + randomUUID();
    }
    return { ...await super.sessionParameters(cwd), _meta: { sessionKey: this.sessionKey, ...(this.restoredKey === null ? {} : { requireExistingSession: true, resetSession: false }) } };
  }
  /** The agent roster of the native configuration file; a missing file is no roster. Rejects with NATIVE_CONFIGURATION_INVALID. */
  private async readRoster(): Promise<Exclude<OpenClawRoster, { readonly problem: string }>> {
    const env = this.nativeLaunch.env, path = env.OPENCLAW_CONFIG_PATH ?? join(env.OPENCLAW_STATE_DIR ?? join(env.HOME ?? homedir(), ".openclaw"), "openclaw.json");
    let config: unknown;
    try {
      const info = await stat(path); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "native configuration exceeds its budget");
      const source = await readFile(path, "utf8"); if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new ControlError("NATIVE_CONFIGURATION_INVALID", "native configuration grew beyond its budget");
      config = JSON5.parse(source);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") config = {};
      else throw new ControlError("NATIVE_CONFIGURATION_INVALID", "cannot read the native OpenClaw configuration");
    }
    const roster = openClawRoster(config);
    if ("problem" in roster) throw new ControlError("NATIVE_CONFIGURATION_INVALID", roster.problem);
    return roster;
  }
  /**
   * The Gateway's own default agent (agents.list, operator.read; result shape of gateway-protocol agents-models-skills.ts
   * at v2026.10.5): its id and configured primary model. Null when this Gateway does not provide the list: any failed call
   * (a Gateway without the method, an unreachable one, a fake that throws or answers something else) or a result of another
   * shape, so the configuration file decides and the connection is not failed by it. Rejects with
   * NATIVE_CONFIGURATION_INVALID when the Gateway reports `selectionRequired`: it then still names a `defaultId`, but only as
   * the first configured agent (gateway/agent-list.ts), and HarnessHub does not pick one. Writes nothing.
   */
  private async gatewayAgent(): Promise<{ readonly agent: string; readonly model: string | undefined } | null> {
    let value: unknown;
    try { value = await this.call("agents.list", {}); } catch { return null; }
    const result = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
    if (result === null || !Array.isArray(result.agents)) return null;
    if (result.selectionRequired === true) throw new ControlError("NATIVE_CONFIGURATION_INVALID", SELECTION_REQUIRED);
    const agent = result.defaultId;
    if (typeof agent !== "string" || !AGENT_ID.test(agent)) return null;
    const row: unknown = result.agents.find(item => item !== null && typeof item === "object" && (item as { readonly id?: unknown }).id === agent);
    const model = row !== null && typeof row === "object" ? (row as { readonly model?: unknown }).model : undefined;
    const primary = model !== null && typeof model === "object" ? (model as { readonly primary?: unknown }).primary : undefined;
    return { agent, model: typeof primary === "string" && primary.trim() && primary.length <= 1024 && !/[\0\r\n]/u.test(primary) ? primary : undefined };
  }
  private call(method: OpenClawMethod, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.nativeRequest) return this.nativeRequest(method, params);
    const index = this.nativeLaunch.args.lastIndexOf("acp");
    if (index < 0) return Promise.reject(new ControlError("UNSUPPORTED_CONTROL", "OpenClaw native CLI prefix unavailable"));
    const pending = nativeCommand(this.nativeLaunch, [...this.nativeLaunch.args.slice(0, index), "gateway", "call", method, "--json", "--params", JSON.stringify(params)], this.nativeOptions, this.abort.signal).then(value => { let parsed: unknown; try { parsed=JSON.parse(value); } catch { throw new ControlError("INVALID_NATIVE_METADATA","native CLI returned invalid JSON"); } return parsed; });
    this.commands.add(pending); void pending.finally(() => this.commands.delete(pending)).catch(() => {}); return pending;
  }
  /**
   * The original catalog (models.list), read once per connection. Every model is kept with its input kinds; one the Gateway
   * reports unavailable (2026.10.5's `available: false`, with `unavailableReason`; absent means available) is marked so,
   * and it is neither offered nor accepted as a selection.
   */
  private readNativeModels(): Promise<readonly OpenClawModel[]> {
    this.nativeModels ??= this.call("models.list", {}).then(value => {
      const data = object(value, "OpenClaw native models");
      if (!Array.isArray(data.models) || data.models.length > 4096) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw model catalog");
      const models = data.models.map((value): OpenClawModel => {
        const row = object(value, "OpenClaw model"), provider = string(row.provider, "model provider", 128), id = string(row.id, "model identity", 768);
        if (row.input !== undefined && (!Array.isArray(row.input) || row.input.length > 16 || row.input.some(item => typeof item !== "string"))) throw new ControlError("INVALID_PROTOCOL", "invalid OpenClaw model input kinds");
        // The bridge forwards only images as attachments (audio is dropped); a model without image input would answer without seeing it.
        return { id: provider + "/" + id, name: string(row.name, "model name", 1024), ...(Array.isArray(row.input) ? { inputs: { image: row.input.includes("image"), audio: false, file: true } } : {}),
          unavailable: row.available === false ? unavailability(row) : null };
      });
      if (new Set(models.map(row => row.id)).size !== models.length) throw new ControlError("INVALID_PROTOCOL", "duplicate OpenClaw models");
      this.unreported = models.filter(row => row.unavailable !== null);
      return models;
    });
    return this.nativeModels;
  }
  /**
   * OpenClaw's own sessions are not continued from the Hub: the Gateway's other sessions belong to channels and agents the
   * Hub must not write to, so only conversations the Hub created are continued (by their own reference). This is a product
   * decision, not a missing interface: 2026.10.5's bridge declares session/list, 2026.3.23-2's does not.
   */
  override async nativeSessions(): Promise<NativeSessionPage> { throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "OpenClaw sessions are not continued from the Hub"); }
  override async importSession(): Promise<NativeSessionImport> { throw new ControlError("NATIVE_SESSION_LIST_UNAVAILABLE", "OpenClaw sessions are not continued from the Hub"); }
  /**
   * The Gateway's own read-only reports: the workspace skill status (eligible, disabled or blocked by the allowlist) and the
   * plugin tool groups of the tool catalog. These reports carry no MCP servers; OpenClaw 2026.3.23-2 keeps them in
   * openclaw.json `mcp.servers`, which the capabilities page reads, read-only (ADR-045). The agent uses its skills itself;
   * nothing is invoked.
   */
  async extensions(): Promise<NativeExtensions> {
    const [status, catalog] = await Promise.all([this.call("skills.status", {}), this.call("tools.catalog", { includePlugins: true })]);
    const skills = object(status, "OpenClaw skill status").skills, groups = object(catalog, "OpenClaw tool catalog").groups;
    if (!Array.isArray(skills) || !Array.isArray(groups)) throw new ControlError("INVALID_NATIVE_METADATA", "invalid OpenClaw extension report");
    const listed = skills.slice(0, MAX_NATIVE_EXTENSIONS).map(value => { const row = object(value, "OpenClaw skill");
      return { name: string(row.name, "skill name", 256), description: typeof row.description === "string" ? row.description.slice(0, 1024) : "", ...(typeof row.source === "string" ? { scope: row.source.slice(0, 64) } : {}),
        enabled: row.eligible === true && row.disabled !== true && row.blockedByAllowlist !== true }; });
    const plugins = groups.map(value => object(value, "OpenClaw tool group")).filter(group => group.source === "plugin").slice(0, MAX_NATIVE_EXTENSIONS).map(group => ({
      name: typeof group.label === "string" ? group.label.slice(0, 256) : string(group.id, "plugin group", 256), enabled: true, source: (Array.isArray(group.tools) ? group.tools.length : 0) + " 个工具" }));
    return { skills: listed, mcpServers: [], plugins, ...(skills.length > MAX_NATIVE_EXTENSIONS ? { truncated: true } : {}) };
  }
  /**
   * Images above 5,000,000 bytes are refused up front, which keeps them within what every Gateway takes: 2026.3.23-2 took
   * no more than that, and 2026.10.5 takes up to 6,291,456 bytes and fails the request with an error above it.
   */
  protected override get maxInlineImageBytes(): number { return 5_000_000; }
  override async checkpoint(): Promise<string | null> {
    const conversation = await super.checkpoint();
    return conversation !== null && this.sessionKey !== null ? JSON.stringify({ conversation, key: this.sessionKey }) : null;
  }
  /**
   * Opens or restores the Hub's own session and only checks a selected model against the original catalog: one it does not
   * list, or reports unavailable (the reason is in the error), fails with MODEL_UNAVAILABLE. The model is applied before
   * the first prompt (applySelectedModel). Besides reading agents.list for a new session's default agent
   * (sessionParameters), the driver writes nothing to the Gateway here, so a catalog probe, which opens with at most a
   * model, reads and closes, leaves no session row behind. Native options given here are still applied by the bridge itself
   * (session/set_config_option, session/set_mode), which records them in the session row.
   */
  override async open(cwd: string, model?: string, options?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    let conversation: string | undefined;
    if (checkpoint !== undefined) {
      let parsed: unknown; try { parsed = JSON.parse(checkpoint); } catch { throw new ControlError("INVALID_CHECKPOINT", "invalid native recovery reference"); }
      const value = object(parsed, "OpenClaw recovery reference");
      if (Object.keys(value).some(key => !["conversation", "key"].includes(key)) || typeof value.key !== "string" || !HUB_KEY.test(value.key)) throw new ControlError("INVALID_CHECKPOINT", "native key is not a Hub-owned conversation");
      this.restoredKey = value.key; conversation = string(value.conversation, "native conversation");
    }
    const id = await super.open(cwd, undefined, options, conversation);
    if (model !== undefined) {
      const entry = (await this.readNativeModels()).find(row => row.id === model);
      if (entry === undefined) throw new ControlError("MODEL_UNAVAILABLE", "model unavailable in original OpenClaw catalog");
      if (entry.unavailable !== null) throw new ControlError("MODEL_UNAVAILABLE", "OpenClaw reports this model unavailable: " + entry.unavailable);
      this.selectedModel = model;
    }
    return id;
  }
  /**
   * Makes the model chosen at open() the session's own just before its first prompt. Nothing is written when the session
   * already runs it: a new session runs the agent's configured model, a restored one the model its Gateway row holds
   * (unknown when the row cannot be read, so the selection is then applied). Otherwise sessions.patch, an operator.write
   * call that also creates a new session's row, sets it on the Hub's own key, and the Gateway must resolve exactly the
   * selected model (MODEL_MISMATCH). Rejects with the failing ControlError; the selection then still counts as unapplied,
   * so the connection's next Turn tries again. Once it is confirmed, later Turns of this connection do not apply it again,
   * so a native /model change then stands. The Gateway calls it makes are owned like every other command and awaited by
   * close(). One Turn at a time, as the Runtime runs them.
   */
  private async applySelectedModel(): Promise<void> {
    const model = this.selectedModel;
    if (model === undefined || this.appliedModel === model) return;
    let running = this.configuredModel;
    if (this.restoredKey !== null) {
      // The row only spares a write; when it cannot be read, the selection is applied and confirmed below all the same.
      try { const row = await this.sessionRow(this.restoredKey); running = row === undefined ? null : rowModel(row); } catch { running = null; }
    }
    if (model !== running) {
      if (this.sessionKey === null || !HUB_KEY.test(this.sessionKey)) throw new ControlError("IDENTITY_MISMATCH", "OpenClaw session override has no owned key");
      const patched = object(await this.call("sessions.patch", { key: this.sessionKey, model }), "OpenClaw model override");
      const resolved = object(patched.resolved, "OpenClaw resolved model");
      if (resolved.modelProvider + "/" + resolved.model !== model) throw new ControlError("MODEL_MISMATCH", "OpenClaw did not apply the selected session model");
    }
    this.appliedModel = model;
  }
  /**
   * This key's Gateway session row; undefined until something writes the session: the bridge applying native options at
   * open(), the model patch just before the first prompt, or that prompt. A catalog probe writes nothing, so it leaves no row.
   */
  private async sessionRow(key: string): Promise<Record<string, unknown> | undefined> {
    const rows = object(await this.call("sessions.list", { search: key, limit: 50 }), "OpenClaw sessions").sessions;
    if (!Array.isArray(rows) || rows.length > 50) throw new ControlError("INVALID_NATIVE_METADATA", "invalid OpenClaw session list");
    return rows.map(value => object(value, "OpenClaw session")).find(value => value.key === key);
  }
  /** Agent-level checks first, then the running model's own input kinds from the original catalog when it lists them. */
  override async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    await super.checkAttachments(attachments);
    if (!attachments.some(item => item.kind === "image")) return;
    // The model the session is about to run: the selection (applied before the first prompt, so not yet before it), else the
    // model a restored session's Gateway row holds (a native /model change persists there), else the configured one.
    const restored = this.selectedModel === undefined && this.restoredKey !== null ? await this.sessionRow(this.restoredKey) : undefined;
    const model = this.selectedModel ?? (restored === undefined ? null : rowModel(restored)) ?? this.configuredModel, entry = (await this.readNativeModels()).find(row => row.id === model);
    if (entry?.inputs) checkInputs(attachments, entry.inputs);
  }
  /** Highest transcript sequence of the Hub-owned session; null when it cannot be read (the turn then stays as the bridge reported it). */
  private async transcriptSeq(): Promise<number | null> {
    if (this.sessionKey === null) return null;
    try {
      const messages = object(await this.call("sessions.get", { key: this.sessionKey, limit: 1 }), "OpenClaw transcript").messages;
      if (!Array.isArray(messages)) return null;
      return messages.reduce((max: number, value) => Math.max(max, transcriptSeq(value) ?? 0), 0);
    } catch { return null; }
  }
  /**
   * Before the prompt, the model chosen at open() is applied (applySelectedModel); when it cannot be confirmed the Turn's
   * result is failed and no prompt is sent. Models the catalog read for this connection reports unavailable are named in
   * the Turn's diagnostics, once. The bridge streams reply text and reasoning, and tool calls live where it subscribes to
   * the Gateway's tool events (2026.10.5 does; 2026.3.23-2 does not, so its Turns show tools from the transcript alone, as
   * before); it reports Gateway errors as end_turn. After the turn, this session's own transcript (read through the
   * original CLI) supplies what the stream did not: the tool calls and results it did not stream (a call it streamed keeps
   * its live row and title, and only an outcome the stream never settled is added), reasoning when none streamed, per-call
   * usage and the real stop reason, of exactly the messages this turn appended; a full window that starts after the turn's
   * first entry is reported as a diagnostic, and the entries it holds are still reconciled.
   */
  override async startText(id: NativeConversationId, prompt: string, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // Nothing was sent, so this is the Turn's own failure rather than a dispatch with an unknown outcome.
    try { await this.applySelectedModel(); }
    catch (error) { if (error instanceof ControlError) return notSent(error); throw error; }
    if (this.unreported.length) {
      const named = this.unreported.map(row => row.id + " (" + row.unavailable + ")").join(", ");
      onEvent({ type: "diagnostic", message: `OpenClaw reports ${this.unreported.length} model(s) unavailable, left out of the model choice: ${named.length > 2048 ? named.slice(0, 2048) + "…" : named}` });
      this.unreported = [];
    }
    const before = await this.transcriptSeq();
    // What the bridge showed live in this Turn: any reasoning, and each tool call by id as last shown.
    let thought = false;
    const live = new Map<string, ShownTool>();
    const run = await super.startText(id, prompt, event => {
      if (event.type === "thinking") thought = true;
      if (event.type === "tool") live.set(event.id, { title: event.title, status: event.status });
      onEvent(event);
    }, attachments);
    const result = run.result.then(async backend => {
      if (this.sessionKey !== null) { const pending = this.readSessionSettings(this.sessionKey); this.sessionSettings = pending; pending.catch(() => {}); }
      if (before === null || this.sessionKey === null || backend.status === "cancelled") return backend;
      let messages: unknown;
      try { messages = object(await this.call("sessions.get", { key: this.sessionKey, limit: TRANSCRIPT_WINDOW }), "OpenClaw transcript").messages; }
      catch { onEvent({ type: "diagnostic", message: "OpenClaw transcript was not readable after the turn" }); return backend; }
      if (!Array.isArray(messages)) return backend;
      const first = messages.reduce<number | null>((lowest, value) => { const seq = transcriptSeq(value); return seq !== null && (lowest === null || seq < lowest) ? seq : lowest; }, null);
      if (messages.length >= TRANSCRIPT_WINDOW && first !== null && first > before + 1)
        onEvent({ type: "diagnostic", message: `OpenClaw transcript window held ${messages.length} entries; ${first - before - 1} earlier entries of this turn were not reconciled` });
      return reconcileTurn(messages.filter(value => (transcriptSeq(value) ?? 0) > before), backend, onEvent, !thought, live);
    });
    return { result, requestStop: run.requestStop };
  }
  /**
   * What the Gateway holds for this session after the Turn: its model and each setting the bridge offers that the row (and
   * chat.history, for fast mode) has a value for, in the bridge's own option values; a setting the row leaves unset is
   * absent, so nativeConfig reports the value the bridge announced. Fields as the bridge itself reads them
   * (translator.presentation.ts at v2026.10.5): 2026.10.5 keeps fast mode on the row, effective value first, and adds the
   * trace level; 2026.3.23-2 has fast mode only in chat.history. The row has no field for a mode: the bridge's modes repeat
   * the thinking level, which thought_level already reports.
   */
  private async readSessionSettings(key: string): Promise<{ readonly model: string | null; readonly values: Readonly<Record<string, string>> }> {
    const [row, history] = await Promise.all([this.sessionRow(key), this.call("chat.history", { sessionKey: key, limit: 1 })]);
    if (row === undefined) throw new ControlError("NATIVE_CONFIG_UNAVAILABLE", "the Hub-owned OpenClaw session is not listed");
    const chat = object(history, "OpenClaw chat history"), values: Record<string, string> = {};
    for (const [id, field] of Object.entries(SETTING_FIELDS)) {
      const value = row[field];
      if (typeof value === "string" && value && value.length <= 128 && !/[\0\r\n]/u.test(value)) values[id] = value;
    }
    const fast = fastMode(row.effectiveFastMode ?? row.fastMode ?? chat.effectiveFastMode ?? chat.fastMode);
    if (fast !== undefined) values.fast_mode = fast;
    return { model: rowModel(row), values };
  }
  /**
   * The bridge's option ids with the values the Gateway holds after the Turn, including changes made by /think, /model and
   * the like; only ids the bridge offers are reported. A setting the Gateway row leaves unset reports the value the bridge
   * announced for this session, which for a new session is the bridge's own default (response_usage "inherit" on
   * 2026.10.5, "off" on 2026.3.23-2); one cleared after the bridge announced another value still reports that value. A
   * mode that only repeats the thinking levels is left out, as the catalog leaves it out; a mode with other values has no
   * Gateway field, so the value the bridge announced for it is reported.
   */
  override async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions }> {
    const announced = await super.nativeConfig();
    if (this.sessionSettings === null) throw new ControlError("NATIVE_CONFIG_UNAVAILABLE", "OpenClaw settings were not read after the turn");
    const current = await this.sessionSettings;
    const mode = announced.options.__mode !== undefined && !repeatsThinking((await super.models()).options) ? announced.options.__mode : undefined;
    const options = Object.fromEntries(Object.entries(announced.options).flatMap(([id, value]) => id === "__mode" ? [] : [[id, current.values[id] ?? value]]));
    return { model: current.model, options: { ...options, ...(mode === undefined ? {} : { __mode: mode }) } };
  }
  /**
   * The original catalog's selectable models and the configured default; a model the Gateway reports unavailable is left
   * out (the catalog has no field to show it as such; open() refuses it and the next Turn's diagnostics name it). The
   * bridge's modes are offered once, as thought_level, when they only repeat its thinking levels.
   */
  override async models(): Promise<NativeModelCatalog> {
    const catalog = await super.models();
    const models = (await this.readNativeModels()).flatMap(({ unavailable, ...row }) => unavailable === null ? [row] : []);
    const options = catalog.options !== undefined && repeatsThinking(catalog.options) ? catalog.options.filter(option => option.id !== "__mode") : catalog.options;
    return { ...catalog, ...(options === undefined ? {} : { options }), defaultModel: this.configuredModel, models, canSelect: models.length > 0 };
  }
  override async close(): Promise<CleanupEvidence> { this.abort.abort(); const commands = [...this.commands]; const results = await Promise.allSettled(commands); const cleanup = await super.close(); const failed = results.find(result => result.status === "rejected" && result.reason instanceof ControlError && result.reason.code === "CLEANUP_FAILED"); if (failed?.status === "rejected") throw failed.reason; return cleanup; }
}
