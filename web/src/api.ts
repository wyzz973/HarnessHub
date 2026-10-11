import { consumeSessionEventStream, SessionStreamError } from "./session-stream.js";
import { readSseBlocks } from "./attention.js";
import type { ProviderProtocol, ProviderTarget, ProviderView, ProviderWriteInput } from "../../src/contracts/provider.js";
import type { AttentionFrame, AuthSession, HarnessReadinessView, HarnessView, InstallationLogPage, KeptProcessView, LoginShellView, NativeResumeView, NativeSessionListView, SessionSummary, SessionView, SessionStreamFrame, WebState } from "../../src/contracts/web.js";
import type { HarnessManagementView, InstallationJobView, ManagementJobInput } from "../../src/contracts/management.js";
import type { AttentionItem, HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunStatus, SelectionRequest } from "../../src/contracts/session.js";
import type { NativeExtensions, NativeInputs, NativeOption, NativeModelCatalog } from "../../src/contracts/control.js";
import { parseNativeOptions, commandId, messageId, runId, sessionId, switchId } from "../../src/contracts/session.js";
import { parseContentRef, type ContentRef } from "../../src/contracts/content.js";
import type { NativeUsage } from "../../src/contracts/control.js";

export interface ToolDetailView { readonly kind?: string; readonly name?: string; readonly input?: string; readonly output?: string; readonly diff?: string; readonly parentId?: string; readonly locations?: readonly string[]; readonly exitCode?: number; readonly truncated?: boolean }
/** Same-origin URL of stored native content for img/download use; the page cookie authorizes it. */
export function contentUrl(content: ContentRef, download = false): string { return "/api/v1/content/" + encodeURIComponent(content.id) + (download ? "?download=1" : ""); }
export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ApiError"; }
}
function invalid(): never { throw new ApiError("INVALID_RESPONSE", "网关返回了无法识别的数据，请重新载入。"); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function number(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : invalid(); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function list<T>(value: unknown, decode: (row: unknown) => T, limit = 2048): readonly T[] {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  return value.map(decode);
}
function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) return invalid();
  return value as T[number];
}
const RUN_STATES = ["queued", "preparing", "running", "settling", "completed", "cancelled", "failed", "unknown"] as const;
const SESSION_STATES = ["open", "closed", "blocked"] as const;
export const PROVIDER_PROTOCOLS = ["openai-responses", "openai-chat-completions", "anthropic-messages", "gemini"] as const;
function nativeOption(value: unknown): NativeOption {
  const row = record(value), values = list(row.values,value => { const option = record(value); return { value: text(option.value), name: text(option.name) }; },4096);
  if (!values.length || new Set(values.map(option=>option.value)).size!==values.length) return invalid();
  return { id:text(row.id), name:text(row.name), category:text(row.category), currentValue:text(row.currentValue), values };
}
function target(value: unknown): ProviderTarget {
  const row = record(value);
  return { providerId: text(row.providerId), revision: number(row.revision), model: text(row.model) };
}
function selection(value: unknown): HarnessSelection {
  const row = record(value);
  if (row.provider !== undefined && row.nativeModel !== undefined) return invalid();
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), ...(row.provider === undefined ? {} : { provider: target(row.provider) }),
    ...(row.nativeModel === undefined ? {} : { nativeModel: text(row.nativeModel) }), ...(row.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(row.nativeOptions) }) };
}
function requestedSelection(value: unknown): SelectionRequest {
  const row = record(value);
  return { harnessId: text(row.harnessId), ...(row.controlId === undefined ? {} : { controlId: text(row.controlId) }),
    ...(row.provider === undefined ? {} : { provider: row.provider === null ? null : target(row.provider) }), ...(row.nativeModel === undefined ? {} : { nativeModel: text(row.nativeModel) }), ...(row.nativeOptions === undefined ? {} : { nativeOptions: parseNativeOptions(row.nativeOptions) }) };
}
function publicError(value: unknown): { code: string; message: string } | null {
  if (value === null) return null;
  const row = record(value); return { code: text(row.code), message: text(row.message) };
}
export function decodeProvider(value: unknown): ProviderView {
  const row = record(value);
  return { id: text(row.id), revision: number(row.revision), name: text(row.name), protocol: choice(row.protocol, PROVIDER_PROTOCOLS),
    baseUrl: text(row.baseUrl), models: list(row.models, text, 256), defaultModel: text(row.defaultModel), enabled: bool(row.enabled), hasCredential: bool(row.hasCredential) };
}
function decodeHarness(value: unknown): HarnessView {
  const row = record(value);
  const install = row.install === null ? null : record(row.install);
  return { id: text(row.id), name: text(row.name), installed: bool(row.installed), defaultControlId: nullableText(row.defaultControlId), providerProtocols: list(row.providerProtocols, text, 16), management: decodeManagement(row.management),
    controls: list(row.controls, value => { const control = record(value), entry = control.entry === null ? null : record(control.entry);
      return { id: text(control.id), protocol: text(control.protocol), available: bool(control.available), reason: nullableText(control.reason),
        entry: entry === null ? null : { source: choice(entry.source, ["path", "standard-directory", "custom-entry", "package-root", "managed"]) } }; }, 64),
    install: install === null ? null : { command: text(install.command), docs: text(install.docs) } };
}
function decodeLoginShell(value: unknown): LoginShellView {
  const row = record(value);
  return { available: bool(row.available), ...(row.shell === undefined ? {} : { shell: text(row.shell) }), dirs: list(row.dirs, text).slice(0, 64), readAt: row.readAt === null ? null : number(row.readAt) };
}
function decodeManagement(value: unknown): HarnessManagementView {
  const row = record(value), recipe = row.recipe === null ? null : record(row.recipe);
  return { harnessId: text(row.harnessId), recipe: recipe === null ? null : { controlId: text(recipe.controlId), kind: choice(recipe.kind, ["npm", "python", "binary"]), sourceLabel: text(recipe.sourceLabel), packageName: nullableText(recipe.packageName), referenceVersion: nullableText(recipe.referenceVersion), canInstall: bool(recipe.canInstall), reason: nullableText(recipe.reason) },
    source: choice(row.source, ["managed", "system", "missing"]), installedVersion: nullableText(row.installedVersion), programVersion: nullableText(row.programVersion), latestVersion: nullableText(row.latestVersion), updateStatus: choice(row.updateStatus, ["unchecked", "checking", "available", "current", "failed", "unsupported"]), checkedAt: nullableText(row.checkedAt), activeJobId: nullableText(row.activeJobId), installationId: nullableText(row.installationId), defaultRevision: number(row.defaultRevision), error: publicError(row.error),
    ...(row.verification === undefined ? {} : { verification: (() => { const verification = record(row.verification);
      return { state: choice(verification.state, ["verified", "unverified"]), program: text(verification.program), ...(verification.adapter === undefined ? {} : { adapter: text(verification.adapter) }) }; })() }),
    ...(row.native === undefined ? {} : { native: (() => { const native = record(row.native); return { channel: text(native.channel), location: text(native.location), fingerprint: text(native.fingerprint), canInstall: bool(native.canInstall), canUpgrade: bool(native.canUpgrade), reason: nullableText(native.reason) }; })() }) };
}
export function decodeInstallationJob(value: unknown): InstallationJobView {
  const row = record(value);
  return { id: text(row.id), harnessId: text(row.harnessId), controlId: text(row.controlId), action: choice(row.action, ["install", "upgrade"]), status: choice(row.status, ["queued", "resolving", "installing", "verifying", "activating", "completed", "cancelled", "failed", "unknown"]), phase: text(row.phase), cancelRequested: bool(row.cancelRequested), createdAt: text(row.createdAt), updatedAt: text(row.updatedAt), resolvedVersion: nullableText(row.resolvedVersion), installationId: nullableText(row.installationId), error: publicError(row.error), logCursor: number(row.logCursor),
    ...(row.native === undefined ? {} : { native: (() => { const native = record(row.native); return { channel: text(native.channel), location: text(native.location), beforeVersion: nullableText(native.beforeVersion), actualVersion: nullableText(native.actualVersion), dispatched: bool(native.dispatched), configurationPreserved: native.configurationPreserved === null ? null : bool(native.configurationPreserved) }; })() }) };
}
function decodeLogPage(value: unknown): InstallationLogPage {
  const row = record(value);
  return { entries: list(row.entries, value => { const item = record(value); return { seq: number(item.seq), time: text(item.time), stream: choice(item.stream, ["stdout", "stderr", "system"]), text: text(item.text) }; }, 256), nextSeq: number(row.nextSeq), hasMore: bool(row.hasMore) };
}
function decodeSummary(value: unknown): SessionSummary {
  const row = record(value);
  return { id: text(row.id), title: text(row.title), status: choice(row.status, SESSION_STATES), workspace: text(row.workspace),
    selection: selection(row.selection), updatedSeq: number(row.updatedSeq), activeRunId: nullableText(row.activeRunId) };
}
function decodeMessage(value: unknown): PublicMessage {
  const row = record(value);
  return { id: messageId(row.id), runId: runId(row.runId), role: choice(row.role, ["user", "assistant"]), text: text(row.text), seq: number(row.seq), status: choice(row.status, RUN_STATES) };
}
function contentRef(value: unknown): ContentRef { try { return parseContentRef(value); } catch { return invalid(); } }
function nativeInputs(value: unknown): NativeInputs { const row = record(value); return { image: bool(row.image), audio: bool(row.audio), file: bool(row.file) }; }
/** Marks a request body that is sent as raw bytes with its own media type instead of JSON. */
class RawBody { constructor(readonly blob: Blob) {} }
function optionalNumber(value: unknown): number | undefined { return value === undefined ? undefined : number(value); }
function decodeUsage(value: unknown): NativeUsage {
  const row = record(value), turn = row.turn === undefined ? undefined : record(row.turn), context = row.context === undefined ? undefined : record(row.context), cost = row.cost === undefined ? undefined : record(row.cost);
  const tokens = (key: string) => { const amount = turn === undefined ? undefined : optionalNumber(turn[key]); return amount === undefined ? {} : { [key]: amount }; };
  return { ...(turn === undefined ? {} : { turn: { ...tokens("input"), ...tokens("output"), ...tokens("cachedInput"), ...tokens("cacheWrite"), ...tokens("reasoning"), ...tokens("total") } }),
    ...(context === undefined ? {} : { context: { used: number(context.used), ...(context.size === undefined ? {} : { size: number(context.size) }) } }),
    ...(cost === undefined ? {} : { cost: { amount: typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0 ? cost.amount : invalid(), currency: text(cost.currency), scope: choice(cost.scope, ["turn", "session"]) } }) };
}
function decodeActivityFields(row: Record<string, unknown>): Pick<PublicRun, "plan" | "usage" | "notices" | "activities" | "outputs"> {
  return { ...(row.plan === undefined ? {} : { plan: (() => { const plan = record(row.plan); return { entries: list(plan.entries, value => { const entry = record(value); return { content: text(entry.content), status: choice(entry.status, ["pending", "in_progress", "completed"]), ...(entry.priority === undefined ? {} : { priority: choice(entry.priority, ["high", "medium", "low"]) }) }; }, 64), ...(plan.explanation === undefined ? {} : { explanation: text(plan.explanation) }) }; })() }),
    ...(row.usage === undefined ? {} : { usage: decodeUsage(row.usage) }),
    ...(row.notices === undefined ? {} : { notices: list(row.notices, value => { const notice = record(value); return { severity: choice(notice.severity, ["info", "warning", "error"]), title: text(notice.title), ...(notice.detail === undefined ? {} : { detail: text(notice.detail) }) }; }, 32) }),
    ...(row.activities === undefined ? {} : { activities: list(row.activities, value => { const activity = record(value); return { id: text(activity.id), kind: choice(activity.kind, ["subagent", "task", "compaction", "retry", "review"]), title: text(activity.title), status: choice(activity.status, ["running", "completed", "failed", "cancelled"]), ...(activity.detail === undefined ? {} : { detail: text(activity.detail) }) }; }, 64) }),
    ...(row.outputs === undefined ? {} : { outputs: list(row.outputs, value => { const output = record(value);
      return output.kind === "content" ? { kind: "content" as const, content: contentRef(output.content) }
        : output.kind === "link" ? { kind: "link" as const, uri: text(output.uri), name: text(output.name), ...(output.title === undefined ? {} : { title: text(output.title) }), ...(output.mediaType === undefined ? {} : { mediaType: text(output.mediaType) }) } : invalid(); }, 32) }) };
}
function decodeTool(value: unknown): NonNullable<PublicRun["tools"]>[number] {
  const tool = record(value);
  return { id: text(tool.id), title: text(tool.title), status: text(tool.status), ...(tool.kind === undefined ? {} : { kind: text(tool.kind) }), ...(tool.name === undefined ? {} : { name: text(tool.name) }),
    ...(tool.parentId === undefined ? {} : { parentId: text(tool.parentId) }), ...(tool.exitCode === undefined ? {} : { exitCode: number(tool.exitCode) }), ...(tool.detail === undefined ? {} : { detail: contentRef(tool.detail) }) };
}
/** When the Run reached its phases; each present phase is a finite number, as the Gateway recorded it. */
function decodeTiming(value: unknown): NonNullable<PublicRun["timing"]> {
  const row = record(value), at = (raw: unknown) => { const time = number(raw); return time; };
  return { acceptedAt: at(row.acceptedAt), ...(["preparingAt", "readyAt", "dispatchedAt", "firstOutputAt", "endedAt"] as const).reduce((phases, name) => row[name] === undefined ? phases : { ...phases, [name]: at(row[name]) }, {}) };
}
function decodeRun(value: unknown): PublicRun {
  const row = record(value);
  const backend = row.backend === null ? null : record(row.backend);
  const cleanup = row.cleanup === null ? null : record(row.cleanup);
  if (cleanup !== null && cleanup.closed !== true) return invalid();
  return { id: runId(row.id), commandId: commandId(row.commandId), input: text(row.input), userMessageId: messageId(row.userMessageId),
    assistantMessageId: messageId(row.assistantMessageId), selection: selection(row.selection), epoch: number(row.epoch),
    status: choice(row.status, RUN_STATES), cancelRequested: bool(row.cancelRequested), contextThroughSeq: number(row.contextThroughSeq),
    sourceRunIds: list(row.sourceRunIds, runId, 256), backend: backend === null ? null : { status: choice(backend.status, ["completed", "cancelled", "failed"]), reason: text(backend.reason),
      ...(backend.error === undefined ? {} : { error: publicError(backend.error) ?? invalid() }) },
    cleanup: cleanup === null ? null : { closed: true, exitCode: nullableNumber(cleanup.exitCode), signal: nullableText(cleanup.signal), protocolFailure: publicError(cleanup.protocolFailure) },
    error: publicError(row.error), ...(row.thinking === undefined ? {} : { thinking: text(row.thinking) }), ...(row.tools === undefined ? {} : { tools: list(row.tools, decodeTool, 128) }), ...decodeActivityFields(row),
    ...(row.attachments === undefined ? {} : { attachments: list(row.attachments, contentRef, 8) }), ...(row.timing === undefined ? {} : { timing: decodeTiming(row.timing) }),
    ...(row.retained === undefined ? {} : { retained: row.retained === true ? true as const : invalid() }), ...(row.reused === undefined ? {} : { reused: row.reused === true ? true as const : invalid() }),
    stopRequested: bool(row.stopRequested), awaitingSwitchId: row.awaitingSwitchId === null ? null : switchId(row.awaitingSwitchId) };
}
function decodeSwitch(value: unknown): PublicSwitch {
  const row = record(value);
  return { id: switchId(row.id), commandId: commandId(row.commandId), requested: requestedSelection(row.requested), requestedSeq: number(row.requestedSeq),
    target: row.target === null ? null : selection(row.target), status: choice(row.status, ["requested", "validated", "effective", "failed"]),
    throughSeq: number(row.throughSeq), sourceRunIds: list(row.sourceRunIds, runId, 256), error: publicError(row.error) };
}
function decodeKeptProcess(value: unknown): KeptProcessView {
  const row = record(value);
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), since: number(row.since), lastUsedAt: number(row.lastUsedAt), idleEndsAt: number(row.idleEndsAt), backgroundUpdates: number(row.backgroundUpdates) };
}
/** One frame of waiting approvals and questions (ADR-035); at most 32 items, each checked field by field. */
export function decodeAttentionFrame(value: unknown): AttentionFrame {
  const row = record(value);
  return { revision: number(row.revision), items: list(row.items, value => {
    const item = record(value);
    const decoded: AttentionItem = { sessionId: sessionId(text(item.sessionId)), permissionId: text(item.permissionId), runId: text(item.runId), harnessId: text(item.harnessId),
      kind: choice(item.kind, ["approval", "question"]), requestedAt: number(item.requestedAt),
      ...(item.expiresAt === undefined ? {} : { expiresAt: number(item.expiresAt), expiresBy: choice(item.expiresBy, ["native", "turn"]) }) };
    return decoded;
  }, 32) };
}
export function decodeSession(value: unknown): SessionView {
  const row = record(value);
  return { id: text(row.id), version: number(row.version), lastSeq: number(row.lastSeq), epoch: number(row.epoch), status: choice(row.status, SESSION_STATES),
    workspace: text(row.workspace), selection: selection(row.selection), activeRunId: nullableText(row.activeRunId), pendingSwitchId: nullableText(row.pendingSwitchId),
    ...(row.retention === undefined ? {} : { retention: (() => { const retention = record(row.retention); return { enabled: bool(retention.enabled), process: retention.process === null ? null : decodeKeptProcess(retention.process),
      ...(retention.lost === undefined ? {} : { lost: (() => { const lost = record(retention.lost); return { outcome: choice(lost.outcome, ["terminated", "gone", "unconfirmed"]), leaseReleased: bool(lost.leaseReleased), at: number(lost.at) }; })() }),
      ...(retention.outside === undefined ? {} : { outside: (() => { const outside = record(retention.outside); return { count: number(outside.count), at: number(outside.at) }; })() }) }; })() }),
    ...(row.queue === undefined ? {} : { queue: (() => { const queue = record(row.queue), kind = choice(queue.kind, ["workspace", "slot"]);
      return kind === "workspace" ? { kind, runId: text(queue.runId), holderSessionId: text(queue.holderSessionId), holderWaitsForUser: bool(queue.holderWaitsForUser), since: number(queue.since), endsAt: number(queue.endsAt) }
        : { kind, runId: text(queue.runId), running: number(queue.running), limit: number(queue.limit), since: number(queue.since) }; })() }),
    ...(row.busyHolders === undefined ? {} : { busyHolders: Object.fromEntries(Object.entries(record(row.busyHolders)).slice(0, 256).map(([run, holder]) => [run, text(holder)])) }),
    ...(row.nativeStates === undefined ? {} : { nativeStates: list(row.nativeStates, value => { const state = record(value);
      return { harnessId: text(state.harnessId), controlId: text(state.controlId), status: choice(state.status, ["ready", "unconfirmed", "forking"]),
        ...(state.observed === undefined ? {} : { observed: (() => { const observed = record(state.observed); return { model: observed.model === null ? null : text(observed.model), options: parseNativeOptions(observed.options) }; })() }),
        ...(state.carried === undefined ? {} : { carried: (() => { const carried = record(state.carried);
          return { ...(carried.model === undefined ? {} : { model: text(carried.model) }), ...(carried.options === undefined ? {} : { options: parseNativeOptions(carried.options) }) }; })() }) }; }, 256) }),
    ...(row.origin === undefined ? {} : { origin: (() => { const origin = record(row.origin);
      const history = list(origin.history, value => { const message = record(value);
        return { role: choice(message.role, ["user", "assistant"]), text: text(message.text), status: choice(message.status, RUN_STATES), ...(message.harnessId === undefined ? {} : { harnessId: text(message.harnessId) }), ...(message.attachments === undefined ? {} : { attachments: list(message.attachments, contentRef, 8) }) }; }, 512);
      if (origin.kind === "import") return { kind: "import" as const, harnessId: text(origin.harnessId), title: nullableText(origin.title), omitted: number(origin.omitted), complete: bool(origin.complete), historyRead: bool(origin.historyRead), history };
      if (origin.kind !== "fork") return invalid();
      return { kind: "fork" as const, sessionId: sessionId(origin.sessionId), throughRunId: runId(origin.throughRunId), history }; })() }),
    ...(row.permissions===undefined?{}:{permissions:list(row.permissions, value => { const request=record(value);return {id:text(request.id),runId:text(request.runId),title:text(request.title),decided:bool(request.decided),requestedAt:number(request.requestedAt),
      ...(request.expiresAt===undefined?{}:{expiresAt:number(request.expiresAt),expiresBy:choice(request.expiresBy,["native","turn"])}),...(request.kind===undefined?{}:{kind:choice(request.kind,["question"])}), ...(request.detail===undefined?{}:{detail:text(request.detail)}),...(request.input===undefined?{}:{input:(()=>{const value=record(request.input);return {kind:choice(value.kind,["text","editor","secret"]),value:text(value.value)};})()}),options:list(request.options,value=>{const option=record(value);return {id:text(option.id),name:text(option.name)};},128)};},32)}), messages: list(row.messages, decodeMessage, 1024), runs: list(row.runs, decodeRun, 256), switches: list(row.switches, decodeSwitch, 1024) };
}
/** Decodes only canonical public facts; stream framing and projection validate their watermarks. */
export function decodeSessionStreamFrame(value: unknown): SessionStreamFrame {
  const row = record(value);
  const keys = row.type === "snapshot" ? ["type", "session"] : row.type === "run" ? ["type", "sessionId", "version", "lastSeq", "run"] : ["type", "sessionId", "version", "lastSeq", "message"];
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) return invalid();
  if (row.type === "snapshot") return { type: "snapshot", session: decodeSession(row.session) };
  if (row.type === "run") { const version = number(row.version), lastSeq = number(row.lastSeq); if (version < 1 || lastSeq < 0) return invalid(); return { type: "run", sessionId: text(row.sessionId), version, lastSeq, run: decodeRun(row.run) }; }
  if (row.type !== "message") return invalid();
  const version = number(row.version), lastSeq = number(row.lastSeq), message = decodeMessage(row.message);
  if (version < 1 || lastSeq < 0 || message.role !== "assistant" || message.seq < 0 || message.seq > lastSeq) return invalid();
  return { type: "message", sessionId: text(row.sessionId), version, lastSeq, message };
}
function decodeReadiness(value: unknown): HarnessReadinessView {
  const row = record(value), state = choice(row.state, ["ready", "signed_out", "failed", "unchecked"]);
  return { harnessId: text(row.harnessId), controlId: text(row.controlId), state, checkedAt: nullableNumber(row.checkedAt),
    ...(row.signedIn === undefined ? {} : { signedIn: row.signedIn === null ? null : bool(row.signedIn) }), ...(row.failureCode === undefined ? {} : { failureCode: text(row.failureCode) }),
    ...(row.startupMs === undefined ? {} : { startupMs: number(row.startupMs) }) };
}
function decodeState(value: unknown): WebState {
  const row = record(value);
  return { ...(row.providerManagement === undefined ? {} : { providerManagement: bool(row.providerManagement) }), workspace: text(row.workspace), providers: list(row.providers, decodeProvider, 256), harnesses: list(row.harnesses, decodeHarness, 256), sessions: list(row.sessions, decodeSummary, 1000), jobs: list(row.jobs, decodeInstallationJob, 100),
    readiness: list(row.readiness, decodeReadiness, 512) };
}
function decodeAuth(value: unknown): AuthSession { return { csrfToken: text(record(value).csrfToken) }; }
function acknowledge(value: unknown, session: string, result: "runId" | "switchId" | "target"): void {
  const row = record(value);
  if (row.sessionId !== session || Object.keys(row).some(key => !["sessionId", result, "replayed"].includes(key))) return invalid();
  bool(row.replayed);
  try {
    if (result === "switchId") switchId(text(row.switchId));
    else if (result === "runId") runId(text(row.runId));
    else if (row.target !== null) runId(text(row.target));
  } catch { return invalid(); }
}

let pageBootstrapToken: string | null | undefined;
function bootstrapToken(): string | null {
  // React may invoke state initializers twice. Read and clear the URL exactly once for this page.
  if (pageBootstrapToken !== undefined) return pageBootstrapToken;
  pageBootstrapToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (pageBootstrapToken !== null) {
    const hash = new URLSearchParams(window.location.hash.slice(1)); hash.delete("token");
    window.history.replaceState(null, "", window.location.pathname + window.location.search + (hash.size ? "#" + hash.toString() : ""));
  }
  return pageBootstrapToken;
}
/** One browser tab owns authentication and requests. Credentials only travel to the same-origin local API. */
export class GatewayApi {
  private csrfToken: string | null = null;
  private bootstrapToken: string | null = null;
  private authentication: Promise<void> | null = null;
  constructor() {
    this.bootstrapToken = bootstrapToken();
  }
  async authenticate(signal?: AbortSignal): Promise<void> {
    if (this.csrfToken !== null) return;
    if (this.authentication !== null) return this.authentication;
    this.authentication = this.authenticateOnce(signal);
    try { await this.authentication; } finally { this.authentication = null; }
  }
  private async authenticateOnce(signal?: AbortSignal): Promise<void> {
    let auth: AuthSession;
    if (this.bootstrapToken === null) auth = await this.request("/auth/session", "GET", undefined, decodeAuth, signal);
    else {
      try { auth = await this.request("/auth/bootstrap", "POST", { token: this.bootstrapToken }, decodeAuth, signal); }
      catch (error: unknown) {
        if (!(error instanceof ApiError) || error.code !== "AUTH_REQUIRED") throw error;
        // A reused launch URL cannot consume its token again; an existing authenticated cookie may still be valid.
        auth = await this.request("/auth/session", "GET", undefined, decodeAuth, signal);
      }
    }
    this.csrfToken = auth.csrfToken;
    this.bootstrapToken = null;
    pageBootstrapToken = null;
  }
  state(signal?: AbortSignal): Promise<WebState> { return this.request("/state", "GET", undefined, decodeState, signal); }
  /** What the latest catalog reads and Runs showed of each Harness entry; reading it starts nothing. */
  readiness(signal?: AbortSignal): Promise<readonly HarnessReadinessView[]> { return this.request("/harnesses/readiness", "GET", undefined, value => list(record(value).readiness, decodeReadiness, 512), signal); }
  nativeModels(harness: string, control: string, workspace: string, signal: AbortSignal, refresh = false, nativeModel?: string): Promise<NativeModelCatalog> {
    const query = new URLSearchParams({ controlId: control, workspace, ...(refresh ? { refresh: "1" } : {}), ...(nativeModel ? { nativeModel } : {}) });
    return this.request(`/harnesses/${encodeURIComponent(harness)}/models?${query}`, "GET", undefined, value => {
      const row = record(value), models = list(row.models, value => { const model = record(value); return { id: text(model.id), name: text(model.name), ...(model.options === undefined ? {} : { options: list(model.options,nativeOption,128) }), ...(model.inputs === undefined ? {} : { inputs: nativeInputs(model.inputs) }) }; }, 4096);
      if (new Set(models.map(model => model.id)).size !== models.length) return invalid();
      return { models, defaultModel: nullableText(row.defaultModel), authentication: choice(row.authentication, ["ready", "missing", "unknown"]), canSelect: bool(row.canSelect), ...(row.selectionError === undefined ? {} : {selectionError:publicError(row.selectionError)??invalid()}), ...(row.options === undefined ? {} : { options: list(row.options,nativeOption,128) }), ...(row.commands === undefined ? {} : { commands: list(row.commands,value => {const command=record(value);return { name:text(command.name),description:text(command.description) };},2048) }), ...(row.inputs === undefined ? {} : { inputs: nativeInputs(row.inputs) }) };
    }, signal);
  }
  /** The selected Harness's own sessions in this workspace, newest first; `sessions` is null when it cannot list them. */
  nativeSessions(harness: string, control: string, workspace: string, cursor?: string, signal?: AbortSignal, probes = false): Promise<NativeSessionListView> {
    return this.request(`/harnesses/${encodeURIComponent(harness)}/native-sessions?${new URLSearchParams({ controlId: control, workspace, ...(cursor === undefined ? {} : { cursor }), ...(probes ? { probes: "include" } : {}) })}`, "GET", undefined, value => {
      const row = record(value), next = row.nextCursor === null ? null : text(row.nextCursor);
      if (row.sessions === null) return { sessions: null, nextCursor: null };
      return { nextCursor: next, ...(row.hiddenProbes === undefined ? {} : { hiddenProbes: number(row.hiddenProbes) }), sessions: list(row.sessions, value => { const item = record(value);
        return { id: text(item.id), title: nullableText(item.title), updatedAt: item.updatedAt === null ? null : number(item.updatedAt), ...(item.source === undefined ? {} : { source: text(item.source) }), ...(item.conversationId === undefined ? {} : { conversationId: text(item.conversationId) }) }; }, 1000) };
    }, signal);
  }
  /** The login shell's directories added to discovery (G(ii)). */
  loginShell(signal?: AbortSignal): Promise<LoginShellView> { return this.request("/discovery/login-shell", "GET", undefined, decodeLoginShell, signal); }
  /** Runs the login shell once to read its PATH, then rediscovers; this runs the user's shell login configuration. */
  readLoginShell(key: string): Promise<LoginShellView> { return this.request("/discovery/login-shell", "POST", { commandId: key }, decodeLoginShell); }
  removeLoginShellDirectory(dir: string, key: string): Promise<LoginShellView> { return this.request("/discovery/login-shell/remove", "POST", { dir, commandId: key }, decodeLoginShell); }
  /** How to continue the conversation's native session in its own program (ADR-039); null when there is nothing to show. */
  nativeResume(id: string, signal?: AbortSignal): Promise<NativeResumeView | null> {
    return this.request(`/sessions/${encodeURIComponent(id)}/native-resume`, "GET", undefined, value => {
      const row = record(value); if (row.resume === null) return null;
      const resume = record(row.resume), optional = (key: "nativeId" | "interactive" | "once" | "onceNote" | "list") => resume[key] === undefined ? {} : { [key]: text(resume[key]) };
      return { harnessId: text(resume.harnessId), ...optional("nativeId"), ...optional("interactive"), ...optional("once"), ...optional("onceNote"), ...optional("list"),
        ...(resume.note === undefined ? {} : { note: choice(resume.note, ["version-unverified", "not-verified"]) }) };
    }, signal);
  }
  /** Continues one listed native session as a new conversation; nothing is sent until the next message. */
  importNativeSession(workspace: string, selection: SelectionRequest, nativeId: string, key: string): Promise<SessionView> {
    return this.request("/sessions/import", "POST", { workspace, selection, nativeId, commandId: key }, decodeSession);
  }
  /** Native skills, MCP servers and plugins of the selected Harness in this workspace; null when its interface has no such list. */
  nativeExtensions(harness: string, control: string, workspace: string, signal?: AbortSignal): Promise<NativeExtensions | null> {
    return this.request(`/harnesses/${encodeURIComponent(harness)}/extensions?${new URLSearchParams({ controlId: control, workspace })}`, "GET", undefined, value => {
      const row = record(value); if (row.extensions === null) return null;
      const extensions = record(row.extensions), optional = (item: Record<string, unknown>, key: string) => item[key] === undefined ? {} : { [key]: text(item[key]) };
      return {
        skills: list(extensions.skills, value => { const item = record(value); return { name: text(item.name), description: text(item.description), enabled: bool(item.enabled), ...optional(item, "scope"), ...optional(item, "command") }; }, 512),
        mcpServers: list(extensions.mcpServers, value => { const item = record(value); return { name: text(item.name), status: text(item.status), tools: number(item.tools), failed: bool(item.failed), ...optional(item, "auth") }; }, 512),
        plugins: list(extensions.plugins, value => { const item = record(value); return { name: text(item.name), enabled: bool(item.enabled), ...optional(item, "version"), ...optional(item, "source") }; }, 512),
        ...(extensions.truncated === undefined ? {} : { truncated: bool(extensions.truncated) }),
      };
    }, signal);
  }
  decidePermission(id: string, permission: string, optionId: string, key: string, input?: string): Promise<{ replayed: boolean }> { return this.request(`/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permission)}`, "POST", { optionId, commandId: key, ...(input===undefined?{}:{input}) }, value => { const row=record(value);return { replayed:bool(row.replayed) }; }); }
  session(id: string, signal?: AbortSignal): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}`, "GET", undefined, decodeSession, signal); }
  /** Stored native tool detail; the JSON shape is display data and is validated field by field. */
  toolDetail(content: ContentRef, signal?: AbortSignal): Promise<ToolDetailView> {
    return this.request(`/content/${encodeURIComponent(content.id)}`, "GET", undefined, value => {
      const row = record(value), optional = (key: string) => row[key] === undefined ? {} : { [key]: text(row[key]) };
      return { ...optional("kind"), ...optional("name"), ...optional("input"), ...optional("output"), ...optional("diff"), ...optional("parentId"),
        ...(row.locations === undefined ? {} : { locations: list(row.locations, text, 16) }), ...(row.exitCode === undefined ? {} : { exitCode: number(row.exitCode) }), ...(row.truncated === undefined ? {} : { truncated: bool(row.truncated) }) };
    }, signal);
  }
  /** Owns one cancellable fact stream; reconnecting never submits a conversation command. */
  async streamSession(id: string, afterSeq: number, signal: AbortSignal, onFrame: (frame: SessionStreamFrame) => void, onAttention?: (frame: AttentionFrame) => void): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Session stream deadline exceeded", "TimeoutError")), 75_000);
    const attempt = AbortSignal.any([signal, deadline.signal]);
    try {
      let response: Response;
      try {
        response = await fetch(`/api/v1/sessions/${encodeURIComponent(id)}/events/stream?afterSeq=${afterSeq}`, {
          method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: attempt, headers: { Accept: "text/event-stream" },
        });
      } catch (error: unknown) {
        if (attempt.aborted) throw error;
        throw new ApiError("NETWORK_ERROR", "实时回复连接中断，历史和草稿已保留。");
      }
      if (!response.ok) {
        const error = publicError(await readBoundedJson(response));
        throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "实时回复连接未能建立。");
      }
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || response.body === null) {
        await response.body?.cancel(); return invalid();
      }
      let opened = false;
      await consumeSessionEventStream(response.body, { signal: attempt, decode: decodeSessionStreamFrame, maxFrameBytes: 8 * 1024 * 1024,
        ...(onAttention === undefined ? {} : { onAttention: (value: unknown) => onAttention(decodeAttentionFrame(value)) }), onFrame: frame => {
        if (!opened && frame.type !== "snapshot") throw new ApiError("STREAM_PROTOCOL", "实时连接缺少起始会话事实。");
        opened = true; onFrame(frame);
      } });
      if (!opened) throw new ApiError("STREAM_PROTOCOL", "实时连接没有返回会话事实。");
    } finally { clearTimeout(timeout); }
  }
  /** One Turn's diagnostics as the Gateway assembled and scrubbed them (ADR-037); conversation content only when asked for. */
  runDiagnostics(id: string, run: string, includeContent: boolean, signal?: AbortSignal): Promise<string> {
    return this.request(`/sessions/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}/diagnostics?content=${includeContent ? "1" : "0"}`, "GET", undefined, value => {
      const row = record(value), text = row.text;
      if (typeof text !== "string" || bool(row.includesContent) !== includeContent || !text.startsWith("HarnessHub 诊断 · ")) return invalid();
      return text;
    }, signal);
  }
  /** Waiting approvals and questions of every conversation, as they are now. */
  attention(signal?: AbortSignal): Promise<AttentionFrame> { return this.request("/attention", "GET", undefined, decodeAttentionFrame, signal); }
  /**
   * Live frames of waiting approvals and questions until the server ends the connection (its TTL) or the signal aborts;
   * the caller reconnects. Frames arrive whole, newest revision last.
   */
  async streamAttention(signal: AbortSignal, onFrame: (frame: AttentionFrame) => void): Promise<void> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Attention stream deadline exceeded", "TimeoutError")), 75_000);
    const attempt = AbortSignal.any([signal, deadline.signal]);
    try {
      let response: Response;
      try { response = await fetch("/api/v1/attention/stream", { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: attempt, headers: { Accept: "text/event-stream" } }); }
      catch (error: unknown) { if (attempt.aborted) throw error; throw new ApiError("NETWORK_ERROR", "待处理提醒的连接中断。"); }
      if (!response.ok) { const error = publicError(await readBoundedJson(response)); throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "待处理提醒的连接未能建立。"); }
      if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || response.body === null) { await response.body?.cancel(); return invalid(); }
      await readSseBlocks(response.body, attempt, block => {
        if (block.event !== "attention") return;
        let value: unknown; try { value = JSON.parse(block.data); } catch { return invalid(); }
        const frame = decodeAttentionFrame(value);
        if (block.id !== String(frame.revision)) return invalid();
        onFrame(frame);
      });
    } finally { clearTimeout(timeout); }
  }
  createSession(workspace: string, selection: SelectionRequest, key: string): Promise<SessionView> {
    return this.request("/sessions", "POST", { workspace, selection, commandId: key }, decodeSession);
  }
  async send(id: string, value: string, key: string, attachments: readonly string[] = []): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/messages`, "POST", { text: value, commandId: key, ...(attachments.length ? { attachments } : {}) }, value => acknowledge(value, id, "runId"));
  }
  /** Branches a conversation after a finished reply; the server answers with the new conversation. */
  forkSession(id: string, key: string, throughRunId?: string): Promise<SessionView> {
    return this.request(`/sessions/${encodeURIComponent(id)}/fork`, "POST", { commandId: key, ...(throughRunId === undefined ? {} : { throughRunId }) }, decodeSession);
  }
  /** Sends one file as raw bytes; the server checks the declared type against the bytes and binds it to this workspace. */
  uploadAttachment(file: Blob, name: string, key: string, signal?: AbortSignal): Promise<ContentRef> {
    return this.request(`/attachments?${new URLSearchParams({ name, commandId: key })}`, "POST", new RawBody(file), contentRef, signal);
  }
  /** Withdraws a staged upload; content already sent with a message stays with that message. */
  async discardAttachment(id: string): Promise<void> { await this.request(`/attachments/${encodeURIComponent(id)}`, "DELETE", undefined, () => undefined); }
  async switchSelection(id: string, selection: SelectionRequest, key: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/switches`, "POST", { selection, commandId: key }, value => acknowledge(value, id, "switchId"));
  }
  async resumeSelection(id: string, selection: SelectionRequest, key: string, acknowledgeUnknown: boolean): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(id)}/resume`, "POST", { selection, commandId: key, acknowledgeUnknown }, value => acknowledge(value, id, "switchId"));
  }
  async cancel(id: string, key: string): Promise<void> { await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key }, value => acknowledge(value, id, "target")); }
  /** Cancels one named Turn, such as one still waiting for its workspace (ADR-036). */
  async cancelRun(id: string, run: string, key: string): Promise<void> { await this.request(`/sessions/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key, runId: run }, value => acknowledge(value, id, "target")); }
  closeSession(id: string, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/close`, "POST", { commandId: key }, decodeSession); }
  /** Keeps this conversation's native process between Turns, or stops keeping it (which closes a kept process). */
  setRetention(id: string, enabled: boolean, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/retention`, "POST", { enabled, commandId: key }, decodeSession); }
  /** Ends the conversation's kept native process; resolves once its close is recorded. */
  endKeptProcess(id: string, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/end-process`, "POST", { commandId: key }, decodeSession); }
  /** Conversations that keep a native process, with the workspace each holds. */
  keptProcesses(signal?: AbortSignal): Promise<readonly { readonly sessionId: string; readonly workspace: string; readonly harnessId: string }[]> {
    return this.request("/kept-processes", "GET", undefined, value => list(record(value).processes, value => { const row = record(value); return { sessionId: text(row.sessionId), workspace: text(row.workspace), harnessId: text(row.harnessId) }; }, 16), signal);
  }
  branchNative(id: string, epoch: number, key: string): Promise<SessionView> { return this.request(`/sessions/${encodeURIComponent(id)}/native-branch`, "POST", { epoch, commandId: key }, decodeSession); }
  writeProvider(input: ProviderWriteInput, key: string, current?: ProviderView): Promise<ProviderView> {
    return this.request(current ? `/providers/${encodeURIComponent(current.id)}` : "/providers", current ? "PATCH" : "POST",
      { input, commandId: key, ...(current ? { expectedRevision: current.revision } : {}) }, decodeProvider);
  }
  async probeProvider(id: string): Promise<readonly string[]> {
    return this.request(`/providers/${encodeURIComponent(id)}/probe`, "POST", {}, value => {
      const row = record(value); if (row.status !== "models_reachable") return invalid(); return list(row.models, text, 1024);
    });
  }
  async rescan(signal?: AbortSignal): Promise<readonly HarnessView[]> {
    return this.request("/harnesses/rescan", "POST", {}, value => list(value, decodeHarness, 256), signal);
  }
  checkUpdates(harnessIds?: readonly string[]): Promise<readonly HarnessView[]> {
    return this.request("/harnesses/check-updates", "POST", harnessIds ? { harnessIds } : {}, value => list(value, decodeHarness, 256));
  }
  submitInstallation(input: ManagementJobInput): Promise<InstallationJobView> { return this.request("/installation-jobs", "POST", input, decodeInstallationJob); }
  jobs(signal?: AbortSignal): Promise<readonly InstallationJobView[]> { return this.request("/installation-jobs?limit=50", "GET", undefined, value => list(value, decodeInstallationJob, 100), signal); }
  cancelInstallation(id: string, key: string): Promise<InstallationJobView> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/cancel`, "POST", { commandId: key }, decodeInstallationJob); }
  inspectInstallation(id: string): Promise<InstallationJobView> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/inspect`, "POST", {}, decodeInstallationJob); }
  installationLogs(id: string, afterSeq: number, signal?: AbortSignal): Promise<InstallationLogPage> { return this.request(`/installation-jobs/${encodeURIComponent(id)}/logs?afterSeq=${afterSeq}&limit=50`, "GET", undefined, decodeLogPage, signal); }
  private async request<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body: unknown, decode: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new DOMException("Request deadline exceeded", "TimeoutError")), 15_000);
    const attempt = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const raw = body instanceof RawBody ? body.blob : null;
      const response = await fetch("/api/v1" + path, { method, credentials: "same-origin", signal: attempt,
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": raw === null ? "application/json" : raw.type || "application/octet-stream" }),
          ...(this.csrfToken === null || method === "GET" ? {} : { "X-CSRF-Token": this.csrfToken }) },
        ...(body === undefined ? {} : { body: raw ?? JSON.stringify(body) }) });
      if (response.status === 204) { await response.body?.cancel(); return decode(undefined); }
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        const error = publicError(payload);
        throw new ApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "请求未能完成。");
      }
      return decode(payload);
    } catch (error: unknown) {
      if (signal?.aborted || error instanceof ApiError) throw error;
      if (deadline.signal.aborted) throw new ApiError("REQUEST_TIMEOUT", "请求响应超时，请确认已接收的结果后重试。");
      throw new ApiError("NETWORK_ERROR", "暂时无法连接本机网关。请确认服务仍在运行，再试一次。");
    } finally { clearTimeout(timeout); }
  }
}
async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 16 * 1024 * 1024) { await reader.cancel(); return invalid(); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return value; }
  catch { return invalid(); }
}
export function requestKey(): string { return "web-" + crypto.randomUUID(); }
export function errorMessage(error: unknown): string {
  if (error instanceof SessionStreamError) return "实时回复状态暂时无法同步，历史和草稿已保留。";
  if (error instanceof DOMException && error.name === "TimeoutError") return "网关响应超时，请稍后重试。";
  return error instanceof ApiError ? failureMessage(error) : error instanceof Error ? error.message : "请求未能完成，请重试。";
}
/** Product copy for stable public failures; raw diagnostics never become recovery instructions. */
export function failureMessage(failure: { readonly code: string; readonly message: string }): string {
  const labels: Readonly<Record<string, string>> = {
    GATEWAY_AUTH_REQUIRED: "这个 Harness 尚未配置 Gateway 认证。请补充连接配置，或选择另一个 Harness 继续。",
    NATIVE_CONFIGURATION_INVALID: "本机配置与这个 Harness 的安装版本不兼容。请使用兼容的本机版本，或选择其他 Harness 继续。",
    PROCESS_EXITED: "Harness 提前退出了。历史已保留，可以重试或选择其他 Harness。",
    REMOTE_ERROR: "Harness 拒绝了这次请求。请检查连接配置，或选择其他 Harness。",
    NATIVE_AUTH_REQUIRED: "这个 Harness 尚未登录。请在本机完成登录后再试，也可以选择其他 Harness 继续。",
    NATIVE_QUOTA_EXCEEDED: "这个 Harness 的账号额度或余额不足。可等待额度恢复或充值，也可以选择其他 Harness 继续。",
    NATIVE_CLIENT_UNSUPPORTED: "模型服务已停止支持这个本机客户端。原配置已保留，可以选择其他 Harness 继续。",
    NATIVE_CONNECTION_FAILED: "这个 Harness 配置的模型服务无法连接。请检查它本机的模型配置，或选择其他模型继续。",
    NATIVE_DEPENDENCY_UNAVAILABLE: "这个接入口需要本机已安装的 Harness。请到 Harnesses 检查原程序。",
    HARNESS_BUSY: "这个 Harness 还有任务在运行。结束对应任务后可以升级，其他对话可以继续。",
    NATIVE_INSTALLATION_UNKNOWN: "本机安装结果尚待核实。请到 Harnesses 核实结果，也可以切换其他 Harness。",
    NATIVE_INSTALLATION_CHANGED: "本机程序已变化。请重新扫描后再操作。",
    CONFIGURATION_PROTECTION_UNAVAILABLE: "当前安装渠道无法保证保留原配置，暂不能在这里升级。",
    SWITCH_NOT_EFFECTIVE: "这条消息尚未执行，因为选择切换失败。重新选择后，可明确重发这条消息。",
    HARNESS_UNAVAILABLE: "这个 Harness 当前不可用。请选择其他 Harness，或到 Harnesses 检查安装。",
    PROVIDER_DISABLED: "所选 Provider 已停用。请选择其他连接，或到 Providers 启用它。",
    WORKSPACE_BUSY: "工作区正被另一项任务使用，这条消息没有发出。可以等它结束后重新发送，或为新对话选择其他工作区。",
    WAIT_EXPIRED: "等待你的决定超过了等待期限，原程序没有收到决定；它没有在停止宽限内结束，已被强制结束。结果尚待核实，不会自动重新执行。",
    WORKSPACE_QUARANTINED: "工作区仍有未核实的执行资源。请先核实并停止相关进程；历史和草稿已保留。",
    NATIVE_COMMAND_REJECTED: "原程序没有执行这个命令，原因见上方的活动记录。",
    NATIVE_EXPORT_UNAVAILABLE: "原程序暂时没有可导出的会话记录。",
    ATTACHMENT_UNAVAILABLE: "附件已失效或已移除，请重新添加后再发送。",
    NATIVE_RATE_LIMITED: "模型服务暂时限流或过载。请稍后再试，或换一个模型。",
    MODEL_RATE_LIMIT: "模型服务暂时限流或过载。请稍后再试，或换一个模型。",
    NATIVE_CONTEXT_EXCEEDED: "对话超出了模型的上下文长度。可以先用这个 Harness 的压缩命令（如 /compact），或开始新对话。",
    NATIVE_MODEL_UNAVAILABLE: "所选模型在这个 Harness 的模型服务中不可用，请换一个模型。",
    MODEL_REQUEST_FAILED: "这个 Harness 向模型服务发出的请求失败了。请检查它本机的模型配置，或换一个模型再试。",
    NATIVE_CATALOG_TIMEOUT: "这个 Harness 在 20 秒内没有给出模型列表。可以稍后刷新本机模型重试。",
    WORKSPACE_KEPT: "这个工作区正被另一个对话保留的原生进程使用。可以结束那个对话的后台进程后重试，也可以稍后再试。",
    MODEL_POLICY_REFUSED: "模型服务按自身的内容策略拒绝了这次请求。",
    MODEL_UNAVAILABLE: "所选模型当前不在这个 Harness 的本机模型目录中，请重新选择模型。",
    MODEL_MISMATCH: "Harness 没有切换到所选模型，这条消息没有发出。可以重新选择模型后重发。",
    NATIVE_OPTION_UNAVAILABLE: "所选设置当前不在这个 Harness 的可选范围内，请在输入框重新选择。",
    NATIVE_OPTION_MISMATCH: "Harness 没有应用所选设置，这条消息没有发出。可以重新选择后重发。",
    NATIVE_SESSION_NOT_FOUND: "原程序里找不到这段对话的原生会话（可能已在原程序中删除）。公共历史已保留；可以切换 Harness，或明确建立新的原生会话后继续。",
    NATIVE_RESUME_UNAVAILABLE: "原程序无法确认恢复后的原生会话，没有另建新会话。公共历史已保留，可以切换 Harness 继续。",
    NATIVE_STATE_UNCONFIRMED: "原生会话的状态尚未确认。可以切换其他 Harness，或明确建立新的原生分支；公共历史会保留。",
    SESSION_BLOCKED: "这段对话还有执行结果尚未核实，已暂停接收新消息。请在对话顶部核实后恢复；不会自动重新执行。",
    RUN_TIMEOUT: "本回合超过了 HarnessHub 的执行期限（不含等待你的时间），原程序没有按时结束，已被强制结束。结果尚待核实，不会自动重新执行。",
    LOGIN_SHELL_UNAVAILABLE: "HarnessHub 没有运行你的登录 shell：它必须是列在 /etc/shells 中的绝对路径。用 Homebrew 等方式安装、没有加入这个文件的 shell 常见这种情况。搜索目录没有变化。",
    LOGIN_SHELL_FAILED: "没有读到登录 shell 的 PATH：登录配置超过 3 秒、输出超过 64 KiB、以错误退出，或没有打印 PATH。搜索目录没有变化。",
  };
  return labels[failure.code] ?? failure.message;
}
export function protocolLabel(protocol: ProviderProtocol | string): string {
  const labels: Record<string, string> = { "openai-responses": "OpenAI Responses", "openai-chat-completions": "OpenAI Chat", "anthropic-messages": "Anthropic Messages", gemini: "Gemini", "acp-v1": "ACP", "codex-app-server": "Codex 原生", "pi-rpc": "Pi RPC" };
  return labels[protocol] ?? protocol;
}
export function runStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = { queued: "等待中", preparing: "准备中", running: "正在回复", settling: "正在结束", completed: "本轮结束", cancelled: "已取消", failed: "执行失败", unknown: "结果待核实" };
  return labels[status];
}
