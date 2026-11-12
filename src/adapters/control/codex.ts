import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TABLE_ENV, TABLE_MCP_NAME } from "../../contracts/table.js";
import { nativeConversationId, requestExpiry, type BackendResult, type CleanupEvidence, type CommandClass, type ControlEvent,
  type ControlLaunch, type ControlOptions, type ControlRun, type HarnessControl,
  type NativeOptions, type NativeOption, type NativeConversationId, type NativeModelCatalog, type ProtocolObservation, type StopRequestReceipt } from "../../contracts/control.js";
import { ControlError, errorFrom, JsonRpcProcess, object, string, text, type RpcRequest } from "../../infrastructure/control/json-rpc-process.js";
import { diffPath } from "../../infrastructure/control/unified-diff.js";
import type { NativeToolDetail, NativeUsage } from "../../contracts/control.js";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { MAX_CONTENT_BYTES, type ContentKind, type ContentRef, type ControlAttachment } from "../../contracts/content.js";
import { type NativeExtensions, type NativeSessionImport, type NativeSessionPage } from "../../contracts/control.js";
import { checkInputs, fileMentions } from "../../infrastructure/control/attachments.js";
import { randomUUID } from "node:crypto";
import type { RelayCapabilities, RelayPacketId } from "../../contracts/relay.js";
import { CODEX_SKILL_INPUT as SKILL_INPUT, CODEX_THREAD_COMMANDS as THREAD_COMMANDS, codexClassify, codexNativeClassify, codexThreadOperation as threadOperation, relayDeclaration, relayEntries } from "./relay-classify.js";
import { singleText, type TurnText } from "../../contracts/control.js";
import { bodyWithoutFirstLine, boundedRequests, carriesPacket, clearedNotice, COMMAND_REFUSED, exceedsInput, hubCleared, INPUT_LIMIT_REFUSED, TITLE_DEADLINE_MS, usageRequest, measureBy } from "./relay-turn.js";

/**
 * Codex's relay declaration (ADR-055 §8.1, Codex row): one text (packet, a line break, then the user's words), at most
 * 1,048,576 characters; live evidence from the user message carrying the turn's client identity (`clientUserMessageId`,
 * which a Turn with a packet is sent with), and a completed turn proves nothing by itself (a hook can complete a turn without
 * its user message); the driver's own `/export` and `/compact`, the Hub's clear (`/clear`, `/new`, `/reset` alone) and listed
 * `/skill:` inputs, which submit their text (acceptsRelay), everything else text; compaction events; one process per
 * connection; the window from each turn's token usage; a native title by `thread/name/set` before the first turn.
 */
export const codexRelayCapabilities: RelayCapabilities = relayDeclaration({
  delivery: { live: "recorded_event", successProvesRecorded: false },
  execution: "process",
  commands: { classify: codexClassify },
  // Files go as pointers at the end of the one text, after the words; images and audio as their own items after it (G069
  // phase two, approval B8; to be probed).
  // measure: the one text (packet, blank line, words; a skill input's is shorter) and each file's pointer (ADR-055 C3).
  placement: { parts: "single", maxInput: { unit: "chars", limit: 1_048_576 }, measure: measureBy("single", "chars", ["file"]) },
  title: "set",
});

/** The longest opening a thread is waited for (see setupMs). */
const SESSION_SETUP_MS = 10 * 60_000;
interface ActiveTurn {
  readonly event: (event: ControlEvent) => void;
  readonly resolve: (result: BackendResult) => void;
  readonly reject: (error: Error) => void;
  /** The driver's own deadline for the turn, when one was set (the Gateway sets none: a Turn has no time wall); absent otherwise. */
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly started: Promise<void>;
  readonly signalStarted: () => void;
  readonly rejectStarted: (error: Error) => void;
  readonly deltaItems: Set<string>;
  /** Tool items of this turn with their accumulated native detail; streamed output is published at most every 300 ms. */
  readonly items: Map<string, { title: string; status: string; detail: NativeToolDetail; timer: ReturnType<typeof setTimeout> | null }>;
  /** Generated-image reads still in flight; the turn settles only after they are delivered or dropped. */
  readonly reads: Set<Promise<void>>;
  /** Sub-agent threads working for this turn, each shown as a tool that the thread's own tools are nested under. */
  readonly agents: Map<string, { title: string; status: string; detail: NativeToolDetail }>;
  /** Thread token totals before this turn (including a historical total reported at turn start); turn usage is the difference. */
  baseline: Tokens | null;
  /** Codex reported this turn's user input as an item of the thread (userMessage), which it does once the input is recorded. */
  inputRecorded: boolean;
  /** The client identity this turn's user message was sent with (clientUserMessageId), and the packet it carries. */
  readonly clientId: string | null;
  readonly packetId: RelayPacketId | null;
  /** This turn's model requests one by one, from each token usage report's `last` (ADR-055 VF2-09). */
  readonly requests: NonNullable<NativeUsage["requests"]>[number][];
  turnId: string | null;
  settled: boolean;
  stopping: boolean;
  stop: Promise<StopRequestReceipt> | null;
  /** Codex has reported this turn (turn/started, or any item, delta or request that belongs to it); it takes an interrupt from then on. */
  begun: boolean;
  /** Wakes a stop that waits for the turn to begin (or to end); set only while one waits. */
  wake: (() => void) | null;
}
interface Tokens { readonly totalTokens: number; readonly inputTokens: number; readonly cachedInputTokens: number; readonly cacheWriteInputTokens: number; readonly outputTokens: number; readonly reasoningOutputTokens: number }
const STREAM_MS = 300;
/**
 * Codex's refusal of turn/interrupt for a thread that has no active turn (JSON-RPC invalid request, -32600): the answer of a
 * turn it has not begun yet, or one that has already ended. Codex 0.166.0 answers turn/start at once and runs the user's hooks
 * before it reports the turn, so a stop in the first seconds meets it (probe record 2026-11-10, F4, 38 ms after the response).
 */
const NO_ACTIVE_TURN_CODE = -32600, NO_ACTIVE_TURN = "no active turn to interrupt";
/** How soon a stop asks again after that refusal when nothing of the turn arrives to wake it: the Run's deadline bounds the asking. */
const INTERRUPT_RETRY_MS = 250;
function tokens(value: unknown): Tokens | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>, read = (key: string) => typeof row[key] === "number" && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 ? row[key] as number : 0;
  return { totalTokens: read("totalTokens"), inputTokens: read("inputTokens"), cachedInputTokens: read("cachedInputTokens"), cacheWriteInputTokens: read("cacheWriteInputTokens"), outputTokens: read("outputTokens"), reasoningOutputTokens: read("reasoningOutputTokens") };
}
function line(value: string, maximum = 4096): string { return value.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, maximum); }
function json(value: unknown): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return undefined; } }
function fileDiff(change: unknown): string {
  if (change === null || typeof change !== "object") return "";
  const row = change as Record<string, unknown>, path = typeof row.path === "string" ? row.path : "file", diff = typeof row.diff === "string" ? row.diff : "";
  return /^(---|diff --git)/mu.test(diff) ? diff.endsWith("\n") ? diff : diff + "\n" : "--- a/" + diffPath(path) + "\n+++ b/" + diffPath(path) + "\n" + diff + (diff.endsWith("\n") ? "" : "\n");
}
/**
 * Thread-level permission settings Codex accepts on thread/start and thread/resume. They apply to the Hub's own thread only;
 * the user's config.toml is never written. A value the configuration does not state is not offered, never guessed.
 */
const PERMISSION_SETTINGS = {
  approval_policy: { name: "审批策略", config: "approval_policy", param: "approvalPolicy", values: { untrusted: "仅可信命令自动执行", "on-request": "按需请求审批", "on-failure": "失败时请求审批", never: "从不请求审批" } },
  sandbox: { name: "沙箱", config: "sandbox_mode", param: "sandbox", values: { "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" } },
} as const;
type PermissionSetting = keyof typeof PERMISSION_SETTINGS;
/** app-server has no slash commands; native thread operations the Hub exposes under command names. */
/** Thread sources a user continues; sub-agent threads belong to their parent thread. */
const LISTED_SOURCES = ["cli", "vscode", "exec", "appServer"] as const;
/** A continued thread's history is read whole, page by page newest first (no count bound, 2026-11-12); this is one page. */
const IMPORT_TURNS_PER_PAGE = 50;
function threadTitle(thread: Record<string, unknown>): string | null {
  const value = [thread.name, thread.preview].find(item => typeof item === "string" && item.trim()) as string | undefined;
  return value === undefined ? null : value.replace(/\s+/gu, " ").trim().slice(0, 200);
}
function threadSource(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 64);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value)[0]?.slice(0, 64) : undefined;
}
/**
 * The client identity a userMessage item echoes. Codex 0.166.0 echoes the `clientUserMessageId` a turn was started with under
 * `clientId` (probe record 2026-11-10, E1: the item's keys are clientId, completedAtMs, content, id, startedAtMs, type), so that
 * name is read first; `clientUserMessageId`, the name of the request's field, is the second reading for a Codex that echoes it so.
 */
function echoedClientId(item: Record<string, unknown>): string | null {
  return typeof item.clientId === "string" ? item.clientId : typeof item.clientUserMessageId === "string" ? item.clientUserMessageId : null;
}
/** The text a user sees for one native user input item; non-text inputs are named, never inlined. */
function inputText(value: unknown): string {
  const item = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "image" || item.type === "localImage") return "[图片]";
  if (item.type === "skill" && typeof item.name === "string") return "/skill:" + item.name;
  if (item.type === "mention" && typeof item.name === "string") return "@" + item.name;
  return "";
}
/**
 * Codex's collaboration mode (plan mode) as a native option, offered for every Codex: whether a Codex has it is what its
 * collaborationMode/list answers when a Run that chose a mode opens its thread, not the version it reports (ADR-053). The
 * protocol is experimental and enabled per connection at initialize, so only a connection opened with a chosen mode
 * declares it. The two modes were first used with app-server 0.162.1; that is evidence, not a condition.
 */
const COLLABORATION_MODE = "collaboration_mode";
const COLLABORATION_MODES: NativeOption["values"] = [{ value: "default", name: "默认" }, { value: "plan", name: "计划" }];
/** The app-server version its user agent states (`<originator>/<x.y.z> (…)`), kept as evidence only; null when it is not stated that way. */
function userAgentVersion(userAgent: string): string | null {
  return /^[^/\s]+\/(\d{1,6}\.\d{1,6}\.\d{1,6})(?=$|[\s(;+-])/u.exec(userAgent)?.[1] ?? null;
}
/**
 * A Codex that refused collaborationMode/list has no collaboration mode to offer; the reason is the one it gave, its
 * JSON-RPC code (-32601: it has no such method), and the class of its own words when they name one.
 */
function collaborationUnavailable(error: ControlError): ControlError {
  const reason = error.remoteCode === -32601 ? "它没有 collaborationMode/list 方法（-32601）" : "它拒绝了 collaborationMode/list" + (error.remoteCode === undefined ? "" : "（" + error.remoteCode + "）");
  return new ControlError("NATIVE_OPTION_UNAVAILABLE", "这个 Codex 不提供协作模式：" + reason + "。" + (error.remoteFailure?.message ?? ""));
}
/** A result this driver writes itself when nothing reached Codex (an export, or a request it refused before inserting it). */
const NOT_RECORDED = { input: "not_recorded" } as const;
const SANDBOX_TYPES: Readonly<Record<string, string>> = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
/**
 * The settings a thread/start or thread/resume response reports, each only when present with a value an option knows: the
 * approval policy and the sandbox type (the legacy sandbox field both responses keep), and the effective collaboration mode,
 * which thread/resume reports as a stable field (absent from thread/start, and from a resume on an older server).
 */
function threadReport(response: Record<string, unknown>): { readonly settings: NativeOptions; readonly mode: string | null } {
  const approval = response.approvalPolicy, part = (value: unknown, key: string) => value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
  const sandbox = part(response.sandbox, "type"), mode = part(response.collaborationMode, "mode");
  return { settings: { ...(typeof approval === "string" && Object.hasOwn(PERMISSION_SETTINGS.approval_policy.values, approval) ? { approval_policy: approval } : {}),
    ...(typeof sandbox === "string" && Object.hasOwn(SANDBOX_TYPES, sandbox) ? { sandbox: SANDBOX_TYPES[sandbox]! } : {}) },
    mode: typeof mode === "string" && COLLABORATION_MODES.some(row => row.value === mode) ? mode : null };
}
function permissionOptions(configured: Record<string, unknown>): NativeOption[] {
  return (Object.keys(PERMISSION_SETTINGS) as PermissionSetting[]).flatMap(id => {
    // Offered whether or not the configuration names it (a thread takes either on thread/start, the unified permission levels need both); the
    // current value is the configuration's, or none said when it names none (Codex then runs on its own default, which is not claimed here).
    const setting = PERMISSION_SETTINGS[id], configuredValue = configured[setting.config], current = typeof configuredValue === "string" && Object.hasOwn(setting.values, configuredValue) ? configuredValue : "";
    // on-failure is deprecated: offered only when the configuration still uses it.
    const values = Object.entries(setting.values).filter(([value]) => value !== "on-failure" || current === "on-failure").map(([value, name]) => ({ value, name }));
    return [{ id, name: setting.name, category: "permission", currentValue: current, values }];
  });
}
/** Public title and detail (whole: nothing is cut to a preview here) for a Codex tool-like item; message, reasoning and lifecycle items return null. */
function itemTool(item: Record<string, unknown>): { title: string; detail: NativeToolDetail } | null {
  switch (item.type) {
    case "commandExecution": { const command = typeof item.command === "string" ? item.command : "";
      return { title: line(command) || "命令", detail: { kind: "execute", name: "shell", ...(command ? { input: command } : {}), ...(typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}), ...(typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode } : {}), ...(typeof item.cwd === "string" ? { locations: [item.cwd] } : {}) } }; }
    case "fileChange": { const changes = Array.isArray(item.changes) ? item.changes : [], paths = changes.flatMap(change => change !== null && typeof change === "object" && typeof (change as Record<string, unknown>).path === "string" ? [(change as Record<string, unknown>).path as string] : []);
      return { title: "修改 " + (paths.slice(0, 3).map(path => basename(path)).join(", ") || "文件") + (paths.length > 3 ? " 等 " + paths.length + " 个文件" : ""), detail: { kind: "edit", name: "apply_patch", ...(changes.length ? { diff: changes.map(fileDiff).join("") } : {}), ...(paths.length ? { locations: paths.slice(0, 16) } : {}) } }; }
    case "mcpToolCall": { const name = String(item.server ?? "mcp") + "/" + String(item.tool ?? "tool"), result = item.result !== null && typeof item.result === "object" ? item.result as Record<string, unknown> : null, error = item.error !== null && typeof item.error === "object" ? (item.error as Record<string, unknown>).message : undefined;
      const texts = Array.isArray(result?.content) ? result.content.flatMap(part => part !== null && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []) : [];
      const output = typeof error === "string" ? error : texts.length ? texts.join("\n") : json(result?.structuredContent ?? result ?? undefined), input = json(item.arguments);
      return { title: line(name.replace("/", ".")), detail: { kind: "mcp", name, ...(input ? { input } : {}), ...(output ? { output } : {}) } }; }
    case "webSearch": { const query = typeof item.query === "string" ? item.query : "";
      return { title: "搜索：" + (line(query, 200) || "网页"), detail: { kind: "search", name: "web_search", ...(query ? { input: query } : {}), ...(item.results != null ? { output: json(item.results) ?? "" } : {}) } }; }
    case "imageView": return { title: "查看图片 " + (typeof item.path === "string" ? basename(item.path) : ""), detail: { kind: "image", name: "view_image", ...(typeof item.path === "string" ? { locations: [item.path] } : {}) } };
    case "imageGeneration": return { title: "生成图片", detail: { kind: "image", name: "image_generation", ...(typeof item.revisedPrompt === "string" ? { input: item.revisedPrompt } : {}), ...(typeof item.savedPath === "string" ? { locations: [item.savedPath] } : {}) } };
    case "collabAgentToolCall": { const states = item.agentsStates !== null && typeof item.agentsStates === "object" ? Object.entries(item.agentsStates as Record<string, unknown>).map(([thread, state]) => thread + ": " + String(state !== null && typeof state === "object" ? (state as Record<string, unknown>).status : state)).join("\n") : "";
      return { title: "子 Agent · " + String(item.tool ?? "协作"), detail: { kind: "subagent", name: String(item.tool ?? "collab"), ...(typeof item.prompt === "string" ? { input: item.prompt } : {}), ...(states ? { output: states } : {}) } }; }
    case "dynamicToolCall": { const texts = Array.isArray(item.contentItems) ? item.contentItems.flatMap(part => part !== null && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []) : [], input = json(item.arguments);
      return { title: line(String(item.tool ?? "工具")), detail: { kind: "tool", name: String(item.tool ?? "tool"), ...(input ? { input } : {}), ...(texts.length ? { output: texts.join("\n") } : {}) } }; }
    case "sleep": return { title: "等待 " + Math.round(Number(item.durationMs ?? 0) / 1000) + " 秒", detail: { kind: "other", name: "sleep" } };
    default: return null;
  }
}
function status(value: unknown, started: boolean): string { return value === "inProgress" ? "in_progress" : typeof value === "string" ? value : started ? "in_progress" : "completed"; }
// thread/readState/changed (0.163.0) is an experimental notification, sent only to a connection that declared the API.
const passiveNotifications = new Set(["thread/started", "thread/status/changed", "account/updated", "account/rateLimits/updated",
  "sessionConfigured", "turn/diff/updated", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/fileChange/outputDelta", "item/plan/delta", "thread/settings/updated", "serverRequest/resolved", "thread/name/updated", "skills/changed", "hook/started", "hook/completed", "mcpServer/startupStatus/updated",
  "thread/readState/changed"]);

/** Typed native failure (codexErrorInfo) first; message text is only a fallback for older servers. */
function turnFailure(error: Record<string, unknown>): { readonly code: string; readonly message: string } {
  const info = error.codexErrorInfo, kind = typeof info === "string" ? info : info !== null && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const message = typeof error.message === "string" ? error.message : "";
  if (kind === "unauthorized" || kind === undefined && /unauthorized|not logged|authentication|api key|401/iu.test(message)) return { code: "HARNESS_AUTH_REQUIRED", message: "本机 Codex 登录或模型认证不可用，请检查它的登录状态。" };
  if (kind === "usageLimitExceeded" || kind === "sessionBudgetExceeded") return { code: "NATIVE_QUOTA_EXCEEDED", message: "Codex 账号额度或本会话预算已用完。可等待额度恢复，或选择其他 Harness 继续。" };
  if (kind === "rateLimitExceeded" || kind === "serverOverloaded" || kind === undefined && /rate limit|quota|429/iu.test(message)) return { code: "MODEL_RATE_LIMIT", message: "模型服务当前达到额度或调用限制，请稍后再试。" };
  if (kind === "contextWindowExceeded") return { code: "CONTEXT_WINDOW_EXCEEDED", message: "对话已超过模型上下文窗口。可以压缩原生上下文或重新建立原生会话后继续。" };
  if (kind === "httpConnectionFailed" || kind === "responseStreamConnectionFailed" || kind === "responseStreamDisconnected" || kind === "responseTooManyFailedAttempts") return { code: "NATIVE_CONNECTION_FAILED", message: "Codex 无法连接模型服务。请检查网络或本机配置后重试。" };
  if (kind === "cyberPolicy" || kind === "misalignmentPolicyViolation") return { code: "MODEL_POLICY_REFUSED", message: "模型服务按其策略拒绝了这次请求。" };
  return { code: "MODEL_REQUEST_FAILED", message: "Codex 的模型请求未完成，请检查本机配置或更换模型。" };
}
/** Codex app-server anti-corruption layer; native thread and turn IDs never become public Session IDs. */
export class CodexControl implements HarnessControl {
  readonly relayCapabilities: RelayCapabilities = codexRelayCapabilities;
  private readonly rpc: JsonRpcProcess;
  private initializing: Promise<ProtocolObservation> | null = null;
  private initialized = false;
  private conversation: NativeConversationId | null = null;
  private opening = false;
  private effort: string | undefined;
  /** Model named when the thread was opened; undefined means the configured default. */
  private openedModel: string | undefined;
  /** Declared at initialize when the connection is opened with a chosen collaboration mode. */
  private experimental = false;
  /** The collaboration mode every turn of this connection sends, with the model and effort it runs; null leaves the thread's own. */
  private collaboration: { readonly mode: string; readonly model: string; readonly effort: string | null } | null = null;
  /** The collaboration mode a turn of this connection set and Codex accepted; the thread keeps it for later turns. */
  private confirmedMode: string | null = null;
  /** The approval policy and sandbox the opened thread reported running with (thread/start or thread/resume). */
  private threadSettings: NativeOptions = {};
  /** The effective collaboration mode thread/resume reported for the opened thread; null when it reported none. */
  private threadMode: string | null = null;
  /** Whether the opened thread was resumed rather than started. */
  private resumed = false;
  /** Enabled skills by name, as the last skills/list for this workspace reported them; `/skill:<name>` invokes one. */
  private skills = new Map<string, { readonly name: string; readonly path: string }>();
  /** Set once this connection forked a thread; it then opens nothing and attributes nothing. */
  private forkConnection = false;
  /** Codex's own rollout file for the opened thread, as the thread reports it; null for an ephemeral thread. */
  private threadPath: string | null = null;
  /** What setSessionInstructions gave: added to the developer instructions of the threads this connection opens; null adds nothing. */
  private instructions: string | null = null;
  private interactivePermissions = false;
  private readonly permissions = new Map<string, { options: readonly string[]; resolve: (value: unknown) => void; reply: (option: string, input?: string) => unknown }>();
  private active: ActiveTurn | null = null;
  private failure: Error | null = null;
  private readonly turnIds = new Set<string>();
  /** Threads the app-server attached to this connection (sub-agents, reviews, internal workers) with their parent. */
  private readonly foreignThreads = new Map<string, string | null>();
  private foreignUpdates = 0;
  /** Latest thread token totals, including historical totals reported on resume. */
  private lastTotal: Tokens | null = null;
  /** Notifications that arrived outside any turn of this connection. */
  private unattributed = 0;
  /** Threads this connection gave up (the Hub's clear); what Codex still says of them is counted and dropped. */
  private readonly abandoned = new Set<string>();
  get unattributedUpdates(): number { return this.unattributed; }
  healthy(): boolean { return this.initialized && this.failure === null && this.rpc.failure === null; }
  processGroup(): number | null { return this.rpc.processGroup; }
  diagnosticMark(): number { return this.rpc.stderrMark; }
  diagnosticsSince(mark: number): string { return this.rpc.stderrSince(mark); }

  constructor(private readonly launch: ControlLaunch, private readonly options: ControlOptions) {
    if (launch.protocol !== "codex-app-server") throw new ControlError("INVALID_INPUT", "Codex control requires an app-server launch");
    this.rpc = new JsonRpcProcess(launch, options, {
      notification: (method, params) => this.notification(method, params), request: request => this.serverRequest(request),
      failure: error => {
        this.failure = error;
        if (this.active) this.failTurn(this.active, error);
      },
    });
  }
  initialize(): Promise<ProtocolObservation> {
    if (this.failure) return Promise.reject(this.failure);
    this.initializing ??= this.initializeOnce();
    return this.initializing;
  }
  /** How long opening a thread (start, resume, fork) is waited for: a cold start or a long resume loads native state first, so minutes; less when the Turn has a deadline of its own. */
  private setupMs(): number { return Math.max(this.options.requestTimeoutMs, Math.min(SESSION_SETUP_MS, this.options.runTimeoutMs ?? SESSION_SETUP_MS)); }
  private async initializeOnce(): Promise<ProtocolObservation> {
    try {
      // Experimental fields are accepted only when declared here, for this connection.
      this.experimental = this.options.selectedOptions?.[COLLABORATION_MODE] !== undefined;
      const response = object(await this.rpc.request("initialize", {
        clientInfo: { name: "harnessgateway", title: "HarnessGateway", version: "0.0.0" },
        capabilities: { experimentalApi: this.experimental, requestAttestation: false },
      }, this.options.startupTimeoutMs ?? this.options.requestTimeoutMs, "abort", "NATIVE_INITIALIZE_TIMEOUT"), "Codex initialize result");
      const userAgent = string(response.userAgent, "Codex user agent", 4096);
      await this.rpc.notify("initialized", {});
      this.initialized = true;
      return { protocol: "codex-app-server", protocolVersion: null, agentName: "codex", agentVersion: userAgentVersion(userAgent),
        authenticationMethods: [], capabilities: { userAgent, experimentalApi: this.experimental } };
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
  }
  async models(): Promise<NativeModelCatalog> {
    this.assertInitialized();
    const { models, defaultModel, options } = await this.nativeCatalog();
    const account = object(await this.rpc.request("account/read", { refreshToken: false }), "native account status");
    const skills = await this.readSkills();
    // A skill's input enters the thread like a message (keep).
    const commands = [...THREAD_COMMANDS, ...skills.filter(skill => skill.enabled).map(skill => ({ name: "skill:" + skill.name, description: ("Skill · " + skill.description).slice(0, 1024), contextEffect: "keep" as const }))];
    return { models, defaultModel, canSelect: models.length > 0, ...(options.length ? { options } : {}), commands, authentication: account.requiresOpenaiAuth === false || account.account != null ? "ready" : account.requiresOpenaiAuth === true ? "missing" : "unknown" };
  }
  /**
   * The app-server has no slash commands: exactly `/export` and `/compact`, without attachments, are this driver's thread
   * operations, and `/skill:<name> …` is an input with that skill when the catalog lists it (only the catalog settles the
   * name), as startText sends them. Anything else, leading whitespace included, is text for Codex.
   */
  classify(text: string, catalog: NativeModelCatalog | null, attachments: readonly ContentKind[] = []): CommandClass { return codexNativeClassify(text, catalog, attachments); }
  /** The configured and listed models with the native options; opening a thread validates against this without account or skill reads. */
  private async nativeCatalog(): Promise<{ readonly models: NativeModelCatalog["models"]; readonly defaultModel: string | null; readonly options: readonly NativeOption[] }> {
    const config = object(await this.rpc.request("config/read", { includeLayers: false, cwd: this.options.cwd }), "native configuration");
    const configured = object(config.config, "effective native configuration");
    const models: NativeModelCatalog["models"][number][] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const response = object(await this.rpc.request("model/list", { limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }) }), "native models");
      if (!Array.isArray(response.data) || response.data.length > 100) throw new ControlError("INVALID_PROTOCOL", "invalid native model page");
      for (const value of response.data) {
        const row = object(value, "native model"), id = string(row.model, "model", 1024), name = string(row.displayName, "model name", 1024);
        if (seen.has(id)) throw new ControlError("INVALID_PROTOCOL", "duplicate native model");
        let options: NativeOption[] | undefined;
        // The schema default is text and image when a model does not list its modalities.
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
    const options = [{ id: COLLABORATION_MODE, name: "协作模式", category: "mode", currentValue: "default", values: COLLABORATION_MODES }, ...permissionOptions(configured)];
    return { models, defaultModel, options };
  }
  async checkpoint(): Promise<string | null> { return this.conversation; }
  private assertOwned(id: NativeConversationId): void {
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation || this.opening) throw new ControlError("IDENTITY_MISMATCH", "thread is not owned by this connection");
  }
  /**
   * Names the thread on Codex's side before its first turn (ADR-055 §8.1, `thread/name/set {threadId, name}`): one line of
   * at most 200 characters; an empty title is not sent. A refusal, or no answer within TITLE_DEADLINE_MS, rejects with
   * NATIVE_TITLE_UNAVAILABLE and leaves the connection as it was (the request is given up alone, C6).
   */
  async setTitle(id: NativeConversationId, title: string): Promise<void> {
    this.assertOwned(id);
    const name = [...title.replace(/[\0-\x1f\x7f\u2028\u2029\u0085]+/gu, " ").trim()].slice(0, 200).join("").trim();
    if (!name) return;
    try { await this.rpc.request("thread/name/set", { threadId: id, name }, Math.min(this.options.requestTimeoutMs, TITLE_DEADLINE_MS), "reject"); }
    catch (error) { if (error instanceof ControlError && (error.code === "REMOTE_ERROR" || error.code === "REQUEST_TIMEOUT") && this.rpc.failure === null) throw new ControlError("NATIVE_TITLE_UNAVAILABLE", "Codex did not name the thread"); throw error; }
  }
  /**
   * The thread's settings as Codex reported them: the approval policy and sandbox in its thread/start or thread/resume
   * response, and its collaboration mode, which is the one a turn of this connection set and Codex accepted or, for a
   * connection that follows the native configuration, the effective mode thread/resume reports. Only values an option knows
   * are reported, never a default. A mode this connection chose but no turn confirmed is not reported: the thread did not
   * change on its own, and the Runtime would carry its earlier mode into the next Turn. Each report replaces the earlier one,
   * so a resumed thread whose mode is not known reports nothing and the mode reported earlier stands (ADR-034 §5); null as
   * well when nothing is known.
   */
  /** HarnessControl.setSessionInstructions: Codex's `developerInstructions` on thread/start and thread/resume (app-server 0.166.0). */
  setSessionInstructions(text: string | null): void { this.instructions = text; }
  /**
   * The Hub's tool server as a thread's own MCP server (flavors/codex.ts `thread-config`): the Hub's tool program on the Node that runs
   * the Hub, the table's two variables forwarded from this app-server's environment (`env_vars`, so the token is not in the request),
   * and its tools never asked about (they read this conversation or tell the Hub how the turn goes). Null when the declaration does not
   * name this entry or the table is not mounted.
   */
  private hubToolServer(): Readonly<Record<string, unknown>> | null {
    if (this.options.entry?.tools !== "thread-config") return null;
    const tool = fileURLToPath(new URL("../../cli/hub-tools.js", import.meta.url));
    if (!this.options.env[TABLE_ENV.url] || !this.options.env[TABLE_ENV.session] || !existsSync(tool)) return null;
    return { command: process.execPath, args: [tool, "mcp"], env_vars: [TABLE_ENV.url, TABLE_ENV.session], default_tools_approval_mode: "approve" };
  }
  /** HarnessControl.sessionTools: every thread this connection opens or resumes is given the Hub's tool server (hubToolServer). */
  get sessionTools(): boolean { return this.hubToolServer() !== null; }
  /**
   * What a thread/start or thread/resume adds for the Hub, read with the effective configuration (config/read, nothing written):
   * `developerInstructions`, the user's own (`developer_instructions`, which the parameter would otherwise replace) and then ours, so
   * nothing the user wrote is dropped; and the Hub's tool server as the thread's `config` (`mcp_servers.<name>`, which leaves every other
   * server of the user's as it is), unless the user's configuration already has an enabled server of that name, which is kept as it is.
   */
  private async threadEntry(cwd: string): Promise<{ readonly developerInstructions?: string; readonly config?: Readonly<Record<string, unknown>> }> {
    const server = this.hubToolServer();
    if (this.instructions === null && server === null) return {};
    const configured = object(object(await this.rpc.request("config/read", { includeLayers: false, cwd }), "native configuration").config, "effective native configuration");
    const own = typeof configured.developer_instructions === "string" ? configured.developer_instructions.trim() : "";
    const servers = configured.mcp_servers !== null && typeof configured.mcp_servers === "object" ? configured.mcp_servers as Record<string, unknown> : {};
    const mine = servers[TABLE_MCP_NAME], kept = mine !== null && typeof mine === "object" && (mine as { readonly enabled?: unknown }).enabled !== false;
    return { ...(this.instructions === null ? {} : { developerInstructions: own ? own + "\n\n" + this.instructions : this.instructions }),
      ...(server === null || kept ? {} : { config: { ["mcp_servers." + TABLE_MCP_NAME]: server } }) };
  }
  async nativeConfig(): Promise<{ readonly model: string | null; readonly options: NativeOptions } | null> {
    const mode = this.confirmedMode ?? (this.collaboration === null ? this.threadMode : null);
    if (mode === null && this.resumed) return null;
    const options = { ...this.threadSettings, ...(mode === null ? {} : { [COLLABORATION_MODE]: mode }) };
    return Object.keys(options).length ? { model: null, options } : null;
  }
  async open(cwd: string, model?: string, native?: NativeOptions, checkpoint?: string): Promise<NativeConversationId> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "conversation cwd must be absolute");
    if (this.conversation || this.opening || this.forkConnection) throw new ControlError("INVALID_STATE", "this connection already owns a thread");
    this.opening = true;
    try {
      // What the options of an earlier thread of this connection chose (after a clear) is not this thread's.
      this.effort = undefined; this.collaboration = null; this.confirmedMode = null;
      const overrides: Record<string, string> = {};
      let selected: NativeModelCatalog["models"][number] | undefined;
      if (model !== undefined || Object.keys(native ?? {}).length) {
        const catalog = await this.nativeCatalog(); selected = catalog.models.find(row => row.id === (model ?? catalog.defaultModel));
        if (!selected) throw new ControlError("MODEL_UNAVAILABLE", "selected model is not in this Harness native catalog");
        for (const [id, value] of Object.entries(native ?? {})) {
          if (id === COLLABORATION_MODE) {
            if (!catalog.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "Codex has no such collaboration mode");
            if (!this.experimental) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "the collaboration mode was not chosen when this connection was prepared");
            continue;
          }
          if (Object.hasOwn(PERMISSION_SETTINGS, id)) {
            if (!catalog.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "permission setting unavailable in the native configuration");
            overrides[PERMISSION_SETTINGS[id as PermissionSetting].param] = value; continue;
          }
          if (id !== "reasoning_effort" || !selected.options?.find(option => option.id === id)?.values.some(option => option.value === value)) throw new ControlError("NATIVE_OPTION_UNAVAILABLE", "reasoning effort unavailable for selected native model");
          this.effort = value;
        }
      }
      this.openedModel = model;
      const mode = native?.[COLLABORATION_MODE];
      if (mode !== undefined) {
        // The mode's settings replace the turn's model and effort, so they carry what the turn would otherwise run: the chosen
        // values first, then the user's own preset for the mode (plan_mode_reasoning_effort), then the configured ones. A
        // Codex that refuses the list (-32601 when it has none) has no collaboration mode, which is said before any thread opens.
        let listed: unknown;
        try { listed = await this.rpc.request("collaborationMode/list", {}); }
        catch (error) { throw error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null ? collaborationUnavailable(error) : error; }
        const presets = object(listed, "collaboration modes");
        if (!Array.isArray(presets.data)) throw new ControlError("INVALID_PROTOCOL", "invalid collaboration modes");
        const preset = presets.data.map(value => object(value, "collaboration mode")).find(row => row.mode === mode);
        const presetModel = typeof preset?.model === "string" && preset.model ? preset.model : undefined, presetEffort = typeof preset?.reasoning_effort === "string" ? preset.reasoning_effort : undefined;
        const chosen = model ?? presetModel ?? selected?.id;
        if (chosen === undefined) throw new ControlError("MODEL_UNAVAILABLE", "no model is configured for the collaboration mode");
        this.collaboration = { mode, model: chosen, effort: this.effort ?? presetEffort ?? selected?.options?.find(option => option.id === "reasoning_effort")?.currentValue ?? null };
      }
      const instructions = await this.threadEntry(cwd);
      if (checkpoint !== undefined) this.conversation = nativeConversationId(checkpoint);
      // A cold start or a long thread resume loads native state before answering; bounded by the run budget.
      const response = object(await this.rpc.request(checkpoint === undefined ? "thread/start" : "thread/resume", {
        cwd, ...(checkpoint === undefined ? { ephemeral: false } : { threadId: nativeConversationId(checkpoint), excludeTurns: true }), ...(model === undefined ? {} : { model }), ...overrides, ...instructions,
      }, this.setupMs(), "abort", "NATIVE_SESSION_TIMEOUT"), "native thread setup result");
      // The thread reports the policy it actually runs with; an override it did not apply is a failure, not a silent default.
      if (overrides.approvalPolicy !== undefined && response.approvalPolicy !== overrides.approvalPolicy) throw new ControlError("NATIVE_OPTION_MISMATCH", "Codex did not apply the requested approval policy");
      if (overrides.sandbox !== undefined && SANDBOX_TYPES[String(object(response.sandbox, "Codex sandbox").type)] !== overrides.sandbox) throw new ControlError("NATIVE_OPTION_MISMATCH", "Codex did not apply the requested sandbox");
      const thread = object(response.thread, "Codex thread");
      this.threadPath = typeof thread.path === "string" && isAbsolute(thread.path) ? thread.path : null;
      const received = nativeConversationId(thread.id);
      if (checkpoint !== undefined && received !== checkpoint) throw new ControlError("IDENTITY_MISMATCH", "native restore returned a different thread");
      // A thread given up earlier on this connection and restored now is this connection's again; a new thread is never one it gave up.
      if (checkpoint === undefined && this.abandoned.has(received)) throw new ControlError("IDENTITY_MISMATCH", "Codex answered a new thread with one this connection gave up");
      this.abandoned.delete(received);
      if (this.conversation && this.conversation !== received) throw new ControlError("IDENTITY_MISMATCH", "thread/start response does not match thread/started");
      this.conversation = received;
      // What the thread says it runs with is kept for nativeConfig, value by value; nothing is assumed for what it leaves out.
      const report = threadReport(response);
      this.threadSettings = report.settings; this.threadMode = report.mode; this.resumed = checkpoint !== undefined;
      return received;
    } catch (error) { this.rpc.abort(errorFrom(error)); throw error; }
    finally { this.opening = false; }
  }
  /** This workspace's threads (thread/list): not archived, newest first, without sub-agent threads. */
  async nativeSessions(cwd: string, cursor?: string): Promise<NativeSessionPage> {
    this.assertInitialized();
    if (!isAbsolute(cwd)) throw new ControlError("INVALID_INPUT", "workspace must be absolute");
    const response = object(await this.rpc.request("thread/list", { cwd, limit: 50, sortKey: "updated_at", sortDirection: "desc", archived: false, sourceKinds: LISTED_SOURCES,
      ...(cursor === undefined ? {} : { cursor }) }), "Codex thread list");
    if (!Array.isArray(response.data) || response.data.length > 100) throw new ControlError("INVALID_PROTOCOL", "invalid Codex thread page");
    const sessions = response.data.map(value => object(value, "Codex thread")).filter(thread => thread.cwd === cwd && thread.ephemeral !== true).map(thread => {
      const updated = typeof thread.updatedAt === "number" && Number.isSafeInteger(thread.updatedAt) && thread.updatedAt > 0 ? thread.updatedAt * 1000 : null, source = threadSource(thread.source);
      return { id: string(thread.id, "Codex thread identity", 1024), title: threadTitle(thread), updatedAt: updated, ...(source ? { source } : {}) };
    });
    return { sessions, nextCursor: response.nextCursor == null ? null : string(response.nextCursor, "Codex thread cursor", 1024) };
  }
  /**
   * Reads a thread of this workspace for continuing it: thread/read confirms its workspace, thread/turns/list returns its
   * turns newest first; each turn becomes the user's input and the agent's messages. Nothing is resumed or sent.
   */
  async importSession(id: string, cwd: string): Promise<NativeSessionImport> {
    this.assertInitialized();
    const thread = object(object(await this.rpc.request("thread/read", { threadId: id, includeTurns: false }), "Codex thread read").thread, "Codex thread");
    if (thread.id !== id) throw new ControlError("IDENTITY_MISMATCH", "Codex returned another thread");
    if (thread.cwd !== cwd) throw new ControlError("NATIVE_SESSION_WORKSPACE_MISMATCH", "the thread belongs to another workspace");
    if (thread.ephemeral === true) throw new ControlError("NATIVE_SESSION_UNAVAILABLE", "an ephemeral thread cannot be continued");
    const turns: { user: string; assistant: string }[] = [];
    let cursor: string | undefined, complete = false;
    // Every page is read; a cursor the peer repeats would never end the walk, so it is refused as a protocol fault.
    const seen = new Set<string>();
    for (;;) {
      const response = object(await this.rpc.request("thread/turns/list", { threadId: id, limit: IMPORT_TURNS_PER_PAGE, sortDirection: "desc", itemsView: "full", ...(cursor === undefined ? {} : { cursor }) }), "Codex turns");
      if (!Array.isArray(response.data) || response.data.length > IMPORT_TURNS_PER_PAGE) throw new ControlError("INVALID_PROTOCOL", "invalid Codex turn page");
      for (const value of response.data) {
        const items = object(value, "Codex turn").items, user: string[] = [], assistant: string[] = [];
        for (const raw of Array.isArray(items) ? items : []) {
          const item = object(raw, "Codex turn item");
          if (item.type === "userMessage" && Array.isArray(item.content)) user.push(item.content.map(inputText).filter(Boolean).join("\n"));
          if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) assistant.push(item.text);
        }
        if (user.some(Boolean) || assistant.length) turns.push({ user: user.filter(Boolean).join("\n\n"), assistant: assistant.join("\n\n") });
      }
      if (response.nextCursor == null) { complete = true; break; }
      cursor = string(response.nextCursor, "Codex turn cursor", 1024);
      if (seen.has(cursor)) throw new ControlError("INVALID_PROTOCOL", "Codex repeated a turn cursor");
      seen.add(cursor);
    }
    const history = turns.reverse().flatMap(turn => [...(turn.user ? [{ role: "user" as const, text: turn.user }] : []), ...(turn.assistant ? [{ role: "assistant" as const, text: turn.assistant }] : [])]);
    return { checkpoint: id, title: threadTitle(thread), history, omitted: 0, complete, historyRead: true };
  }
  /** skills/list for this workspace; enabled skills become invocable as `/skill:<name>`. */
  private async readSkills(): Promise<{ name: string; description: string; scope?: string; enabled: boolean; path: string }[]> {
    let response: unknown;
    try { response = await this.rpc.request("skills/list", { cwds: [this.options.cwd] }); }
    catch (error) {
      // An app-server without skills/list (older Codex) has no skills to offer; other failures stay failures.
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && this.rpc.failure === null) { this.skills = new Map(); return []; }
      throw error;
    }
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
  /** Skills, MCP server status and installed plugins as this Codex reports them; listing never starts or changes anything it does not already. */
  async extensions(): Promise<NativeExtensions> {
    this.assertInitialized();
    const skills = await this.readSkills(), mcpServers: NativeExtensions["mcpServers"][number][] = [];
    // Every page is read (no count bound, 2026-11-12); a cursor Codex repeats would never end the walk.
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
  /** Gated by the opened model's inputModalities; a model outside the catalog keeps the schema default (text and image). */
  async checkAttachments(attachments: readonly ContentRef[]): Promise<void> {
    this.assertInitialized();
    if (!attachments.some(item => item.kind !== "file")) return;
    const catalog = await this.models(), selected = catalog.models.find(row => row.id === (this.openedModel ?? catalog.defaultModel));
    checkInputs(attachments, selected?.inputs ?? { image: true, audio: false, file: true });
  }
  /**
   * The Hub's clear (the decision log of 2026-11-11): `/clear`, `/new` and `/reset` alone, which Codex's app-server has no
   * command for, are not sent. The thread is given up (what Codex still says of it is counted and dropped, and it stays in the
   * user's Codex as it was), nothing is archived or deleted, and the Turn reports the history cleared with no checkpoint: the
   * next Turn opens a new thread (`thread/start`). Null for any other input. A relay Turn is never a clear here: its words
   * read as a command and it is refused whole.
   */
  private clearRun(turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[]): ControlRun | null {
    const reading = typeof turn === "string" ? codexNativeClassify(turn, null, attachments.map(file => file.kind)) : null;
    if (reading === null || reading.kind !== "command" || reading.effect !== "clear") return null;
    this.abandoned.add(this.conversation!);
    // Token totals are the old thread's: the next thread counts from its own.
    this.conversation = null; this.threadPath = null; this.lastTotal = null;
    return { result: (async () => { onEvent(clearedNotice(reading.name, "Codex")); return hubCleared(); })(),
      requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "a clear the Hub runs itself has no native turn to stop")) };
  }
  async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    // The words Codex reads: what decides a thread operation or a skill input; a packet goes with them only as placed below.
    const prompt = typeof turn === "string" ? turn : turn.user;
    this.assertInitialized();
    if (!this.conversation || id !== this.conversation) throw new ControlError("IDENTITY_MISMATCH", "thread is not owned by this connection");
    if (this.active) throw new ControlError("INVALID_STATE", "a turn is already active");
    if (typeof prompt !== "string" || prompt.length === 0) throw new ControlError("INVALID_INPUT", "prompt must contain text");
    // The Hub's clear: the thread is given up and nothing is sent (a relay Turn with these words is refused whole below).
    const cleared = this.clearRun(turn, onEvent, attachments);
    if (cleared !== null) return cleared;
    // A Turn that carries a packet is sent with an identity of its own (`clientUserMessageId`), which the user message Codex
    // records echoes: the live evidence that the input reached the thread (E1). It belongs to this Turn only.
    const clientId = typeof turn === "string" ? null : randomUUID();
    // `/skill:<name> …` sends Codex's own skill input next to the remaining text, as its TUI does for a skill mention.
    const invoked = SKILL_INPUT.exec(prompt), skill = invoked ? this.skills.get(invoked[1]!) : undefined;
    const words = skill ? invoked![2]?.trim() || "$" + skill.name : prompt, mentions = fileMentions(attachments.filter(file => file.kind === "file"));
    // ADR-055 §5.5, §8.1: one text, the packet, a blank line and the words; for a skill input the skill item, then the packet
    // without the copy of the first line and the rest of the words (RT5-18). A relay Turn whose words are a thread operation
    // (or any other command) is refused whole, nothing sent (B4b).
    let text = words, packetId: RelayPacketId | null = null;
    const nothingSent = (result: BackendResult): ControlRun => ({ result: Promise.resolve(result), requestStop: () => Promise.reject(new ControlError("INVALID_STATE", "nothing was sent, so there is no native turn to stop")) });
    if (typeof turn !== "string") {
      const entries = relayEntries([...THREAD_COMMANDS, ...[...this.skills.keys()].map(name => ({ name: "skill:" + name, description: "", contextEffect: "keep" as const }))]);
      const reading = codexClassify(prompt, entries, attachments.map(file => file.kind));
      // Content, or a listed skill input whose text Codex submits (acceptsRelay); a thread operation never.
      if (threadOperation(prompt, attachments.length > 0) !== null || !(reading.kind === "content" || reading.kind === "command" && reading.acceptsRelay === true && skill !== undefined)) return nothingSent(COMMAND_REFUSED);
      text = reading.kind === "content" ? singleText(turn) : bodyWithoutFirstLine(turn) + "\n\n" + words;
      packetId = turn.relay.packetId;
      if (exceedsInput([text + mentions], codexRelayCapabilities.placement)) { onEvent({ type: "diagnostic", message: "交接单没有发出：超过 Codex 的输入上限" }); return nothingSent(INPUT_LIMIT_REFUSED); }
    }
    let resolve!: (value: BackendResult) => void, reject!: (error: Error) => void;
    const result = new Promise<BackendResult>((res, rej) => { resolve = res; reject = rej; });
    let signalStarted!: () => void, rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((res, rej) => { signalStarted = res; rejectStarted = rej; });
    // The promise is also consumed by requestStop(); attach rejection ownership before any failure can occur.
    void started.catch(() => {});
    const active: ActiveTurn = { event: onEvent, resolve, reject,
      timer: this.options.runTimeoutMs === undefined ? undefined : setTimeout(() => this.rpc.abort(new ControlError("RUN_TIMEOUT", "Codex turn exceeded its deadline")), this.options.runTimeoutMs),
      started, signalStarted, rejectStarted, turnId: null, settled: false, stopping: false, stop: null, deltaItems: new Set(), items: new Map(), agents: new Map(), reads: new Set(), baseline: this.lastTotal, inputRecorded: false,
      clientId, packetId, requests: [], begun: false, wake: null };
    this.active = active;
    // Images and audio are read by Codex from the private copies; files have no input type and are named by path.
    const input = [{ type: "text", text: text + mentions, text_elements: [] }, ...(skill ? [{ type: "skill", name: skill.name, path: skill.path }] : []),
      ...attachments.flatMap(file => file.kind === "image" ? [{ type: "localImage", path: file.path }] : file.kind === "audio" ? [{ type: "localAudio", path: file.path }] : [])];
    // `/export` copies Codex's own rollout record; nothing is sent to the model.
    const operation = threadOperation(prompt, attachments.length > 0);
    if (operation === "export") {
      void this.exportThread(active, id);
    // `/compact` runs Codex's own compaction turn; its turn identity arrives with turn/started.
    } else if (operation === "compact") {
      void this.rpc.request("thread/compact/start", { threadId: id }).then(value => { if (Object.keys(object(value, "thread/compact/start result")).length) this.rpc.abort(new ControlError("INVALID_PROTOCOL", "compaction receipt must be empty")); }, (error: unknown) => {
        // Refused before any turn exists: Codex ran nothing.
        if (error instanceof ControlError && error.code === "REMOTE_ERROR" && active.turnId === null && this.rpc.failure === null) { this.settleTurn(active); active.resolve({ status: "failed", reason: "request_rejected", ...NOT_RECORDED }); }
        else this.rpc.abort(errorFrom(error));
      });
    } else void this.rpc.request("turn/start", { threadId: id, input, ...(clientId === null ? {} : { clientUserMessageId: clientId }), ...(this.effort === undefined ? {} : { effort: this.effort }),
      // A null developer_instructions keeps the mode's built-in instructions.
      ...(this.collaboration === null ? {} : { collaborationMode: { mode: this.collaboration.mode, settings: { model: this.collaboration.model, reasoning_effort: this.collaboration.effort, developer_instructions: null } } }) }).then(value => {
      try {
        const response = object(value, "turn/start result"), turn = object(response.turn, "Codex turn");
        this.bindTurn(active, string(turn.id, "Codex turn identity"));
        if (this.collaboration !== null) this.confirmedMode = this.collaboration.mode;
        const status = string(turn.status, "Codex turn status");
        if (!["inProgress", "completed", "interrupted", "failed"].includes(status)) throw new ControlError("INVALID_PROTOCOL", "unknown turn status");
        active.signalStarted();
      } catch (error) { this.rpc.abort(errorFrom(error)); }
    }, (error: unknown) => {
      // turn/start refuses only before it records anything (an unknown thread, an input too large, a draining server).
      if (error instanceof ControlError && error.code === "REMOTE_ERROR" && active.turnId === null && this.rpc.failure === null) {
        this.settleTurn(active); active.resolve({ status: "failed", reason: "request_rejected", ...NOT_RECORDED });
      } else this.rpc.abort(errorFrom(error));
    });
    return { result, requestStop: () => {
      if (active.stop) return active.stop;
      if (active.settled || this.active !== active) return Promise.reject(new ControlError("INVALID_STATE", "turn has already ended"));
      active.stopping = true; this.cancelPermissions();
      active.stop = this.stopTurn(active, id);
      return active.stop;
    } };
  }
  /** Reads the rollout file read-only within the content budget and returns it as an output of this Run. */
  private async exportThread(active: ActiveTurn, id: NativeConversationId): Promise<void> {
    let result: BackendResult;
    try {
      if (this.threadPath === null) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "this Codex thread has no rollout record");
      const info = await stat(this.threadPath);
      if (!info.isFile() || info.size < 1 || info.size > MAX_CONTENT_BYTES) throw new ControlError("NATIVE_EXPORT_UNAVAILABLE", "the Codex rollout record is missing or exceeds 1 GiB");
      const data = await readFile(this.threadPath);
      if (this.active === active && !active.settled) active.event({ type: "output", output: { kind: "content", name: "codex-" + id.replace(/[^A-Za-z0-9-]/gu, "") + ".jsonl", mediaType: "application/x-ndjson", data } });
      result = { status: "completed", reason: "exported", ...NOT_RECORDED };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "NATIVE_EXPORT_UNAVAILABLE";
      result = { status: "failed", reason: "export_failed", error: { code, message: code === "NATIVE_EXPORT_UNAVAILABLE" && error instanceof Error ? error.message : "Codex rollout record could not be read" }, ...NOT_RECORDED };
    }
    if (this.active === active && !active.settled) { this.settleTurn(active); active.resolve(result); }
  }
  close(): Promise<CleanupEvidence> { this.cancelPermissions(); return this.rpc.close(); }
  /**
   * Interrupts the turn. The receipt is Codex's acknowledgement of turn/interrupt, never the turn's end. Codex refuses an
   * interrupt with -32600 "no active turn to interrupt" while it has not begun the turn (its hooks run first) and after the
   * turn ended: that refusal is no protocol failure and breaks nothing. The turn that ended is the stop's INVALID_STATE as for
   * any turn that is over; one that has not begun is asked again when Codex reports it (or a moment later), until it takes the
   * interrupt, ends, or the Run's deadline fails the connection, so that the stop is applied as soon as Codex allows it and
   * nothing is said to be stopped that was not. Any other failure of the request still fails the connection.
   */
  private async stopTurn(active: ActiveTurn, id: NativeConversationId): Promise<StopRequestReceipt> {
    await active.started;
    for (;;) {
      if (active.settled || !active.turnId) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
      try {
        const response = object(await this.rpc.request("turn/interrupt", { threadId: id, turnId: active.turnId }), "turn/interrupt result");
        if (Object.keys(response).length !== 0) throw new ControlError("INVALID_PROTOCOL", "interrupt receipt must be empty");
        return { requested: true };
      } catch (error) {
        if (!(error instanceof ControlError && error.code === "REMOTE_ERROR" && error.remoteCode === NO_ACTIVE_TURN_CODE && error.remoteMessage === NO_ACTIVE_TURN) || this.rpc.failure !== null) { this.rpc.abort(errorFrom(error)); throw error; }
        if (active.settled) throw new ControlError("INVALID_STATE", "turn ended before interruption was requested");
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); active.wake = null; resolve(); }, timer = setTimeout(done, INTERRUPT_RETRY_MS);
        active.wake = done;
      });
      // The connection failed while the stop waited (the Run's deadline, a close): that failure is the stop's.
      if (this.failure) throw this.failure;
    }
  }
  private assertInitialized(): void {
    if (this.failure) throw this.failure;
    if (!this.initialized) throw new ControlError("INVALID_STATE", "connection is not initialized");
  }
  private bindTurn(active: ActiveTurn, id: string): void {
    if (active.turnId !== null) {
      if (active.turnId !== id) throw new ControlError("IDENTITY_MISMATCH", "Codex turn identity changed");
      return;
    }
    if (this.turnIds.has(id)) throw new ControlError("DUPLICATE_TURN", "Codex reused a turn identity");
    this.turnIds.add(id); active.turnId = id; active.signalStarted();
  }
  private scope(params: Record<string, unknown>, requireTurn = false): ActiveTurn | null {
    if (!this.conversation || string(params.threadId, "Codex thread identity") !== this.conversation)
      throw new ControlError("IDENTITY_MISMATCH", "Codex message belongs to another thread");
    // Thread accounting can refer to a historical turn immediately after native resume.
    // Only turn-owned output/control may bind the current turn's identity.
    if (requireTurn) {
      const active = this.active;
      if (!active || active.settled) throw new ControlError("INVALID_STATE", "Codex output arrived without an active turn");
      this.bindTurn(active, string(params.turnId, "Codex turn identity"));
      // Codex reports the turn: it takes an interrupt from now on, so a stop that waited for that asks again (F4).
      if (!active.begun) { active.begun = true; active.wake?.(); }
      return active;
    }
    if (params.turnId !== undefined) string(params.turnId, "Codex metadata turn identity");
    return this.active;
  }
  private foreign(id: string, parent: string | null): void {
    if (!this.foreignThreads.has(id) || parent !== null) this.foreignThreads.set(id, parent);
  }
  /** A sub-agent spawned (directly or transitively) by the owned thread works for the active public Run. */
  private descendant(id: string): boolean {
    let parent = this.foreignThreads.get(id) ?? null;
    for (let depth = 0; parent !== null && depth < 32; depth++) { if (parent === this.conversation) return true; parent = this.foreignThreads.get(parent) ?? null; }
    return false;
  }
  /** The tool entry of a sub-agent thread, created when the thread is first seen; nested under its parent sub-agent, if any. */
  private agent(active: ActiveTurn, thread: string, info?: Record<string, unknown>): string {
    const id = "agent:" + thread.slice(0, 200);
    if (!active.agents.has(thread)) {
      const name = [info?.agentNickname, info?.agentRole].find(value => typeof value === "string" && value.trim()) as string | undefined;
      const parent = this.foreignThreads.get(thread) ?? null;
      const entry = { title: "子 Agent · " + (name ? line(name, 120) : thread.slice(0, 8)), status: "in_progress",
        detail: { kind: "subagent", name: "codex-subagent", ...(parent !== null && parent !== this.conversation ? { parentId: "agent:" + parent.slice(0, 200) } : {}) } as NativeToolDetail };
      active.agents.set(thread, entry);
      active.event({ type: "tool", id, title: entry.title, status: entry.status, detail: entry.detail });
    }
    return id;
  }
  /** A descendant thread's item or turn update: tool items nest under its entry, its last message is the entry's output. */
  private childUpdate(active: ActiveTurn, thread: string, method: string, params: Record<string, unknown>): void {
    const parentId = this.agent(active, thread), agent = active.agents.get(thread)!;
    const publish = () => active.event({ type: "tool", id: parentId, title: agent.title, status: agent.status, detail: agent.detail });
    if (method === "turn/started" || method === "turn/completed") {
      const turn = params.turn !== null && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
      agent.status = method === "turn/started" ? "in_progress" : turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "cancelled" : "completed"; publish(); return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = object(params.item, "Codex sub-agent item"), type = string(item.type, "item type"), itemId = string(item.id, "item identity");
    if (type === "agentMessage") { if (method === "item/completed" && typeof item.text === "string" && item.text.trim()) { agent.detail = { ...agent.detail, output: item.text }; publish(); } return; }
    const tool = ["userMessage", "reasoning", "plan", "hookPrompt", "functionCallOutput", "subAgentActivity", "contextCompaction"].includes(type) ? null : itemTool(item);
    if (tool === null) return;
    active.event({ type: "tool", id: (thread.slice(0, 120) + "/" + itemId).slice(0, 256), title: tool.title, status: status(item.status, method === "item/started"), detail: { ...tool.detail, parentId } });
  }
  /** Request owner: the active Turn for the owned thread or its sub-agents; unrelated workers are never approved for the user. */
  private requestOwner(params: Record<string, unknown>): ActiveTurn | null {
    const thread = string(params.threadId, "Codex thread identity");
    // A thread this connection gave up belongs to no Run: nobody approves for it.
    if (this.abandoned.has(thread)) { this.unattributed++; return null; }
    if (this.conversation !== null && thread !== this.conversation) {
      this.foreign(thread, null);
      return this.descendant(thread) && this.active !== null && !this.active.settled ? this.active : null;
    }
    const active = this.scope(params, true);
    if (!active) throw new ControlError("INVALID_STATE", "request arrived without an active turn");
    return active;
  }
  private notification(method: string, raw: unknown): void {
    if (this.active === null || this.active.settled) this.unattributed++;
    const params = raw === undefined ? {} : object(raw, "Codex notification params");
    // A thread this connection gave up still talks: counted and dropped, never attributed or failed on.
    if (typeof params.threadId === "string" && this.abandoned.has(params.threadId)) { if (this.active !== null && !this.active.settled) this.unattributed++; return; }
    if (method === "thread/started") {
      const thread = object(params.thread, "started thread"); const id = nativeConversationId(thread.id);
      if (this.opening && this.conversation === null) { this.conversation = id; return; }
      if (id === this.conversation) return;
      // app-server attaches every connection to every thread it creates; ownership stays with the thread/start response.
      this.foreign(id, typeof thread.parentThreadId === "string" ? thread.parentThreadId : null);
      const active = this.active;
      if (active && !active.settled && this.descendant(id)) this.agent(active, id, thread);
      return;
    }
    // A fork connection owns no thread: whatever the source or the copy reports is counted, never scoped to a turn.
    if (this.forkConnection) { if (typeof params.threadId === "string") this.foreign(params.threadId, null); this.foreignUpdates++; return; }
    if (this.conversation !== null && typeof params.threadId === "string" && params.threadId !== this.conversation) {
      this.foreign(params.threadId, null); this.foreignUpdates++;
      // A sub-agent of this turn: its tools and final report are shown under its own entry; its text is never the reply.
      const active = this.active;
      if (active && !active.settled && this.descendant(params.threadId)) this.childUpdate(active, params.threadId, method, params);
      return;
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = object(params.turn, "Codex turn notification");
      const active = this.scope({ ...params, turnId: turn.id }, true);
      if (!active) throw new ControlError("INVALID_STATE", "no active turn");
      if (method === "turn/started") return;
      const status = string(turn.status, "completed turn status");
      // Codex reports the user input as a thread item once it recorded it, before sampling; a completed turn without that
      // item is no proof (a hook can stop a turn that then completes), so it stays unknown.
      const recorded = active.inputRecorded ? { input: "recorded" as const } : {};
      let result: BackendResult;
      switch (status) {
        case "completed": result = { status: "completed", reason: "completed", ...recorded }; break;
        case "interrupted": result = { status: "cancelled", reason: "interrupted", ...recorded }; break;
        case "failed": {
          const error = turn.error == null ? {} : object(turn.error, "native turn error");
          result = { status: "failed", reason: "failed", error: turnFailure(error), ...recorded }; break;
        }
        default: throw new ControlError("INVALID_PROTOCOL", "turn/completed contains a nonterminal status");
      }
      const finish = () => { if (active.settled) return; this.settleTurn(active); active.resolve(result); };
      if (active.reads.size) { void Promise.all([...active.reads]).then(finish); return; }
      finish(); return;
    }
    if (method === "item/agentMessage/delta") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "no active turn");
      const itemId = string(params.itemId, "message item identity");
      active.deltaItems.add(itemId);
      active.event({ type: "text", text: text(params.delta, "agent message delta") }); return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "native thinking arrived without an active turn");
      string(params.itemId, "native reasoning item");
      active.event({ type: "thinking", text: text(params.delta, "native reasoning delta") }); return;
    }
    if (method === "item/started" || method === "item/completed") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "no active turn");
      const item = object(params.item, "Codex item"), type = string(item.type, "item type"), itemId = string(item.id, "item identity");
      if (type === "agentMessage") {
        if (method === "item/completed" && !active.deltaItems.has(itemId)) active.event({ type: "text", text: text(item.text, "agent message") });
        return;
      }
      // Plan mode answers with a proposed plan; the completed item is authoritative over its deltas.
      if (type === "plan") { if (method === "item/completed") active.event({ type: "text", text: text(item.text, "proposed plan") }); return; }
      if (type === "userMessage") {
        // A user message of this turn with another client's identity is not this turn's input (Codex echoes the identity a
        // turn was started with, as `clientId` or `clientUserMessageId`; an item without one is this turn's by its turn id).
        const echoed = echoedClientId(item);
        if (active.clientId !== null && echoed !== null && echoed !== active.clientId) return;
        // E1 (ADR-055 §7.1): Codex reports the input as a thread item once it recorded it; said once, with the packet it carries.
        if (!active.inputRecorded) {
          active.inputRecorded = true;
          const said = Array.isArray(item.content) ? item.content.map(inputText).join("\n") : "";
          active.event({ type: "input_recorded", ...(active.packetId !== null && carriesPacket(said, active.packetId) ? { packetId: active.packetId } : {}) });
        }
        return;
      }
      if (["reasoning", "hookPrompt", "functionCallOutput"].includes(type)) return;
      const started = method === "item/started";
      // Codex reports a spawned sub-agent here (and in collaboration calls), not with thread/started: the child thread's own
      // items then nest under its entry.
      if (type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds) && this.conversation !== null)
        for (const thread of item.receiverThreadIds.slice(0, 64)) if (typeof thread === "string" && thread && thread !== this.conversation) this.foreign(thread, this.foreignThreads.get(thread) ?? this.conversation);
      if (type === "subAgentActivity" && typeof item.agentThreadId === "string" && item.agentThreadId && this.conversation !== null && item.agentThreadId !== this.conversation) {
        this.foreign(item.agentThreadId, this.foreignThreads.get(item.agentThreadId) ?? this.conversation);
        this.agent(active, item.agentThreadId, typeof item.agentPath === "string" ? { agentNickname: item.agentPath } : undefined);
      }
      if (type === "subAgentActivity") {
        const kind = item.kind, state = kind === "completed" ? "completed" : kind === "interrupted" ? "cancelled" : "running";
        active.event({ type: "activity", id: typeof item.agentThreadId === "string" ? item.agentThreadId : itemId, kind: "subagent", title: typeof item.agentPath === "string" ? item.agentPath : "子 Agent", status: state, ...(typeof item.model === "string" ? { detail: item.model } : {}) }); return;
      }
      if (type === "contextCompaction") { active.event({ type: "activity", id: itemId, kind: "compaction", title: "上下文压缩", status: started ? "running" : "completed" }); return; }
      if (type === "enteredReviewMode" || type === "exitedReviewMode") { active.event({ type: "activity", id: "review", kind: "review", title: typeof item.review === "string" ? line(item.review, 1024) || "代码审查" : "代码审查", status: type === "enteredReviewMode" ? "running" : "completed" }); return; }
      const tool = itemTool(item);
      if (tool === null) { active.event({ type: "tool", id: itemId, title: type, status: status(item.status, started) }); return; }
      const prior = active.items.get(itemId);
      if (prior?.timer) clearTimeout(prior.timer);
      // Completion carries the authoritative aggregate; while running keep the streamed output already seen.
      const detail = { ...prior?.detail, ...tool.detail, ...(tool.detail.output === undefined && prior?.detail.output !== undefined ? { output: prior.detail.output } : {}) };
      const entry = { title: tool.title, status: status(item.status, started), detail, timer: null };
      active.items.set(itemId, entry);
      active.event({ type: "tool", id: itemId, title: entry.title, status: entry.status, detail });
      if (!started && type === "imageGeneration" && typeof item.savedPath === "string") {
        const read = this.generatedImage(active, item.savedPath); active.reads.add(read); void read.then(() => active.reads.delete(read));
      }
      return;
    }
    if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/patchUpdated" || method === "item/mcpToolCall/progress") {
      const active = this.scope(params, true);
      if (!active) throw new ControlError("INVALID_STATE", "native tool progress arrived without an active turn");
      const entry = active.items.get(string(params.itemId, "tool item identity"));
      if (!entry) return;
      if (method === "item/commandExecution/outputDelta") entry.detail = { ...entry.detail, output: (entry.detail.output ?? "") + text(params.delta, "command output delta") };
      else if (method === "item/fileChange/patchUpdated") entry.detail = { ...entry.detail, ...(Array.isArray(params.changes) ? { diff: params.changes.map(fileDiff).join("") } : {}) };
      else entry.detail = { ...entry.detail, output: text(params.message, "tool progress") };
      const itemId = String(params.itemId);
      entry.timer ??= setTimeout(() => { entry.timer = null; if (this.active === active && !active.settled) active.event({ type: "tool", id: itemId, title: entry.title, status: entry.status, detail: entry.detail }); }, STREAM_MS);
      return;
    }
    if (method === "turn/plan/updated") {
      const active = this.scope(params);
      if (!active || active.settled || !Array.isArray(params.plan)) return;
      active.event({ type: "plan", entries: params.plan.slice(0, 256).map(value => { const step = object(value, "plan step"); return { content: typeof step.step === "string" ? step.step : "", status: step.status === "completed" ? "completed" : step.status === "inProgress" ? "in_progress" : "pending" }; }),
        ...(typeof params.explanation === "string" && params.explanation ? { explanation: params.explanation } : {}) });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const active = this.scope(params), usage = object(params.tokenUsage, "native token usage"), total = tokens(usage.total), last = tokens(usage.last);
      if (total !== null) this.lastTotal = total;
      // Thread totals may refer to a historical turn right after resume: they are this turn's baseline, never its usage.
      if (!active || active.settled || total === null) return;
      if (params.turnId !== active.turnId) { active.baseline = total; return; }
      const base = active.baseline, minus = (key: keyof Tokens) => Math.max(0, total[key] - (base?.[key] ?? 0));
      const window = typeof usage.modelContextWindow === "number" && Number.isSafeInteger(usage.modelContextWindow) && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined;
      // Each report of this turn follows one model request, whose own counts are `last` (inferred from the protocol's shape).
      const raw = usage.last !== null && typeof usage.last === "object" ? usage.last as Record<string, unknown> : null;
      const request = raw === null ? null : usageRequest(raw.inputTokens, raw.cachedInputTokens, raw.cacheWriteInputTokens);
      if (request !== null) active.requests.push(request);
      const value: NativeUsage = { turn: { input: minus("inputTokens"), output: minus("outputTokens"), cachedInput: minus("cachedInputTokens"), cacheWrite: minus("cacheWriteInputTokens"), reasoning: minus("reasoningOutputTokens"), total: minus("totalTokens") },
        ...(last !== null ? { context: { used: last.totalTokens, ...(window ? { size: window } : {}) } } : {}), ...(active.requests.length ? { requests: boundedRequests(active.requests) } : {}) };
      active.event({ type: "usage", usage: value }); return;
    }
    if (method === "error" || method === "warning" || method === "configWarning" || method === "deprecationNotice" || method === "guardianWarning" || method === "model/rerouted") {
      if (params.threadId !== undefined) this.scope(params);
      const active = this.active; if (!active || active.settled) return;
      if (method === "error") {
        const failure = turnFailure(params.error !== null && typeof params.error === "object" ? params.error as Record<string, unknown> : {});
        if (params.willRetry === true) active.event({ type: "activity", id: "retry", kind: "retry", title: "模型请求重试", status: "running", detail: failure.message });
        else active.event({ type: "notice", severity: "error", title: failure.message });
        return;
      }
      if (method === "model/rerouted") { active.event({ type: "notice", severity: "warning", title: "模型已由服务端改路由", detail: String(params.fromModel ?? "") + " → " + String(params.toModel ?? "") }); return; }
      const message = typeof params.message === "string" ? params.message : typeof params.summary === "string" ? params.summary : "";
      if (message) active.event({ type: "notice", severity: method === "deprecationNotice" ? "info" : "warning", title: line(message, 1024), ...(typeof params.details === "string" ? { detail: params.details } : {}) });
      return;
    }
    if (passiveNotifications.has(method)) {
      if (params.threadId !== undefined) this.scope(params);
      if (method === "error") this.active?.event({ type: "diagnostic", message: "Codex reported an error; awaiting turn settlement" });
      return;
    }
    if (params.threadId !== undefined) this.scope(params);
    this.active?.event({ type: "diagnostic", message: `Unsupported Codex notification: ${method}` });
  }
  enablePermissions(): void { this.interactivePermissions = true; }
  async decidePermission(id: string, option: string, input?: string): Promise<void> { const pending = this.permissions.get(id); if (!pending || !pending.options.includes(option)) throw new ControlError("PERMISSION_UNAVAILABLE", "native approval unavailable"); const response = pending.reply(option, input); this.permissions.delete(id); pending.resolve(response); }
  private cancelPermissions(): void { for (const pending of this.permissions.values()) pending.resolve(pending.reply("cancel")); this.permissions.clear(); }
  private serverRequest(request: RpcRequest): unknown {
    if (request.method === "item/tool/requestUserInput") return this.userInput(request);
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method))
      throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
    const params = object(request.params, "Codex approval params");
    const active = this.requestOwner(params);
    // Work outside the owned thread tree (internal reviewers, other clients' threads) is never approved for the user.
    if (!active) return { decision: "decline" };
    string(params.itemId, "approval item identity");
    if (this.interactivePermissions && !active.stopping) {
      const available = params.availableDecisions === undefined ? ["accept", "decline", "cancel"] : params.availableDecisions;
      if (!Array.isArray(available) || !available.length || available.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid native approval decisions");
      const choices = available.filter((value): value is string => typeof value === "string" && ["accept", "acceptForSession", "decline", "cancel"].includes(value));
      if (!choices.length || new Set(choices).size !== choices.length) throw new ControlError("INVALID_PROTOCOL", "no supported native approval decisions");
      const id = String(request.id), item = active.items.get(String(params.itemId))?.detail;
      // The user decides with what the item already reported: the files and diff of a change, or the command, its cwd and reason.
      const files = request.method.includes("fileChange") ? (item?.locations ?? []).map(path => basename(path)).slice(0, 3).join(", ") : "";
      const title = (params.threadId !== this.conversation ? "子 Agent · " : "") + (typeof params.command === "string" ? line(params.command) : request.method.includes("fileChange") ? "Codex 请求修改文件" + (files ? "：" + files : "") : "Codex 请求执行命令");
      const detail = [typeof params.reason === "string" ? line(params.reason) : "", typeof params.cwd === "string" ? "目录：" + params.cwd : "", request.method.includes("fileChange") && item?.diff ? item.diff : ""].filter(Boolean).join("\n");
      return new Promise<unknown>(resolve => { this.permissions.set(id, { options: choices, resolve, reply: decision => ({ decision }) });
      // The request names the item it is about (the id Codex gave the item in `item/started`): a refusal is recorded on that call.
      active.event({ type: "permission_requested", id, forCall: String(params.itemId), title, ...(detail ? { detail } : {}), options: choices.map(id => ({ id, name: ({ accept: "允许一次", acceptForSession: "本次会话允许", decline: "拒绝", cancel: "取消" } as Record<string,string>)[id]! })), ...requestExpiry(null) }); });
    }
    const decision = active.stopping ? "cancel" : "decline";
    active.event({ type: "permission", id: String(request.id), decision: active.stopping ? "cancelled" : "denied" });
    return { decision };
  }
  private async userInput(request: RpcRequest): Promise<unknown> {
    const params = object(request.params, "Codex native questions"), active = this.requestOwner(params);
    if (!active) return { answers: {} };
    if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 32) throw new ControlError("INVALID_PROTOCOL", "invalid native question list");
    const questions = params.questions.map((value, index) => {
      const row = object(value, "native question"), id = string(row.id, "native question id", 128), title = string(row.question, "native question", 4096);
      const choices = row.options == null ? [] : row.options;
      if (!Array.isArray(choices) || row.isOther !== undefined && typeof row.isOther !== "boolean" || row.isSecret !== undefined && typeof row.isSecret !== "boolean") throw new ControlError("INVALID_PROTOCOL", "invalid native question options");
      return { id, title, requestId: String(request.id) + ":" + index, secret: row.isSecret === true, freeform: row.isOther === true || choices.length === 0,
        choices: choices.map(value => { const option = object(value, "native question choice"); return string(option.label, "native question choice", 1024); }) };
    });
    if (new Set(questions.map(question => question.id)).size !== questions.length) throw new ControlError("INVALID_PROTOCOL", "duplicate native question identities");
    const answers = new Map<string, { answers: readonly string[] }>();
    for (const question of questions) {
      if (!this.interactivePermissions || active.stopping || active.settled || this.active !== active) return { answers: {} };
      const choices = [...question.choices.map((name, index) => ({ id: "answer-" + index, name })), ...(question.freeform ? [{ id: "submit", name: "提交回答" }] : []), { id: "cancel", name: "取消" }];
      const answer = await new Promise<unknown>(resolve => {
        this.permissions.set(question.requestId, { options: choices.map(choice => choice.id), resolve, reply: (option, input) => {
          if (option === "cancel") return null;
          if (option === "submit") { if (typeof input !== "string" || input.includes("\0")) throw new ControlError("INVALID_INPUT", "invalid native input answer"); return input; }
          const index = Number(option.slice(7)); if (!Number.isSafeInteger(index) || !question.choices[index]) throw new ControlError("INVALID_INPUT", "invalid native answer choice"); return question.choices[index];
        } });
        active.event({ type: "permission_requested", id: question.requestId, title: question.title, options: choices,
          ...(question.freeform ? { input: { kind: question.secret ? "secret" : "text", value: "" } } : {}), kind: "question", ...requestExpiry(null) });
      });
      if (answer === null) return { answers: {} };
      answers.set(question.id, { answers: [text(answer, "native answer")] });
    }
    return { answers: Object.fromEntries(answers) };
  }
  /** A generated image file reported by the native turn becomes an output; only bounded regular image files are read. */
  private async generatedImage(active: ActiveTurn, path: string): Promise<void> {
    try {
      const info = await stat(path), mediaType = /\.png$/iu.test(path) ? "image/png" : /\.jpe?g$/iu.test(path) ? "image/jpeg" : /\.webp$/iu.test(path) ? "image/webp" : null;
      if (!info.isFile() || info.size < 1 || info.size > MAX_CONTENT_BYTES || mediaType === null) return;
      const data = await readFile(path);
      if (this.active === active && !active.settled) active.event({ type: "output", output: { kind: "content", name: basename(path), mediaType, data } });
    } catch { if (this.active === active && !active.settled) active.event({ type: "diagnostic", message: "generated image could not be read" }); }
  }
  private settleTurn(active: ActiveTurn): void {
    // Streamed output still waiting for its throttle window is delivered before the turn ends.
    for (const [id, entry] of active.items) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; active.event({ type: "tool", id, title: entry.title, status: entry.status, detail: entry.detail }); }
    this.cancelPermissions();
    clearTimeout(active.timer); active.settled = true; active.signalStarted(); active.wake?.();
    if (this.active === active) this.active = null;
  }
  private failTurn(active: ActiveTurn, error: Error): void {
    if (active.settled) return;
    for (const entry of active.items.values()) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    clearTimeout(active.timer); active.settled = true; active.rejectStarted(error); active.reject(error); active.wake?.();
    if (this.active === active) this.active = null;
  }
}
