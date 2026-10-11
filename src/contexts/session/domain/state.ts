import { parseProviderTarget, type ProviderTarget } from "../../../contracts/provider.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId,
  type CommandRecord, type HarnessSelection, type PublicMessage, type PublicRun,
  type PublicSwitch, type RunStatus, type SessionConfiguration, type SessionMutation, type SessionSnapshot, type NativeSessionBinding,
} from "../../../contracts/session.js";
import type { BackendResult, CleanupEvidence, NativeUsage } from "../../../contracts/control.js";
import { MAX_RUN_OUTPUTS, parseContentRef } from "../../../contracts/content.js";

export const MAX_RUNS = 256;
export const MAX_COMMANDS = 1024;
export const MAX_QUEUE = 8;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_CONTEXT_BYTES = 1024 * 1024;
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_EVENTS = 16384;
export const MAX_EVENT_BYTES = 2 * 1024 * 1024 + 4096;
export const MAX_EVENT_LOG_BYTES = 32 * 1024 * 1024;
export const MAX_READ_BYTES = 8 * 1024 * 1024;
export const MAX_READ_ITEMS = 100;
/** Public tool summaries per Run; later native tools stay in the Harness and are not attributed. */
export const MAX_RUN_TOOLS = 128;
export const MAX_RUN_NOTICES = 32;
export const MAX_RUN_ACTIVITIES = 64;
export const MAX_PLAN_ENTRIES = 64;
export const CURRENT_SCHEMA = 7;
const statuses: readonly RunStatus[] = ["queued", "preparing", "running", "settling", "completed", "cancelled", "failed", "unknown"];
const terminalStatuses: readonly RunStatus[] = ["completed", "cancelled", "failed", "unknown"];
export function terminal(status: RunStatus): boolean { return terminalStatuses.includes(status); }
export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SessionError("INVALID_DATA", label + " must be an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SessionError("INVALID_DATA", label + " has unknown fields");
}
function text(value: unknown, label: string, maximum = 4096, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0") || utf8Bytes(value) > maximum) throw new SessionError("INVALID_DATA", label + " is invalid or exceeds its byte budget");
  return value;
}
function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new SessionError("INVALID_DATA", label + " must be a safe nonnegative integer");
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new SessionError("INVALID_DATA", label + " must be boolean"); return value;
}
function array<T>(value: unknown, label: string, maximum: number, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new SessionError("INVALID_DATA", label + " must be a bounded array"); return value.map(parse);
}
function path(value: unknown, label: string): string {
  const result = text(value, label);
  if (!result.startsWith("/") || /[\r\n]/u.test(result) || result.split("/").includes("..")) throw new SessionError("INVALID_DATA", label + " must be a bounded absolute path");
  return result;
}
function nativeOptions(value: unknown) { try { return parseNativeOptions(value); } catch { throw new SessionError("INVALID_DATA","invalid persisted native options"); } }
function providerTarget(value: unknown): ProviderTarget {
  try { return parseProviderTarget(value); }
  catch { throw new SessionError("INVALID_DATA", "invalid or unknown Provider target fields"); }
}
export function parseSelection(value: unknown): HarnessSelection {
  const item = record(value, "selection"); keys(item, ["harnessId", "controlId", "provider", "nativeModel", "nativeOptions"], "selection");
  const harnessId = text(item.harnessId, "harnessId", 96), controlId = text(item.controlId, "controlId", 96);
  if (![harnessId, controlId].every(id => /^[a-z][a-z0-9-]*$/u.test(id))) throw new SessionError("INVALID_DATA", "selection must name catalog identities");
  if (item.provider !== undefined && (item.nativeModel !== undefined || item.nativeOptions !== undefined)) throw new SessionError("INVALID_DATA", "native model and managed Provider are mutually exclusive");
  return { harnessId, controlId, ...(item.provider === undefined ? {} : { provider: providerTarget(item.provider) }),
    ...(item.nativeModel === undefined ? {} : { nativeModel: text(item.nativeModel, "nativeModel", 1024) }), ...(item.nativeOptions === undefined ? {} : { nativeOptions: nativeOptions(item.nativeOptions) }) };
}
export function parseConfiguration(value: unknown): SessionConfiguration {
  const item = record(value, "configuration");
  keys(item, ["workspace", "manifestPath", "manifestSha256", "configHome", "packageRoots", "searchDirs", "pathOnly"], "configuration");
  const manifestPath = item.manifestPath === null ? null : path(item.manifestPath, "manifestPath");
  const digest = item.manifestSha256 === null ? null : text(item.manifestSha256, "manifestSha256", 64);
  if ((manifestPath === null) !== (digest === null) || (digest !== null && !/^[a-f0-9]{64}$/u.test(digest))) throw new SessionError("INVALID_DATA", "manifest path and fingerprint must agree");
  return { workspace: path(item.workspace, "workspace"), manifestPath, manifestSha256: digest,
    configHome: item.configHome === null ? null : path(item.configHome, "configHome"),
    packageRoots: array(item.packageRoots, "packageRoots", 64, value => path(value, "packageRoot")),
    searchDirs: array(item.searchDirs, "searchDirs", 128, value => path(value, "searchDir")), pathOnly: boolean(item.pathOnly, "pathOnly") };
}
function status(value: unknown): RunStatus {
  if (typeof value !== "string" || !statuses.includes(value as RunStatus)) throw new SessionError("INVALID_DATA", "unknown Run status"); return value as RunStatus;
}
function fault(value: unknown): PublicRun["error"] {
  if (value === null) return null;
  const item = record(value, "fault"); keys(item, ["code", "message"], "fault");
  return { code: text(item.code, "fault code", 128), message: text(item.message, "fault message", 4096, true) };
}
function backend(value: unknown): BackendResult | null {
  if (value === null) return null;
  const item = record(value, "backend"); keys(item, ["status", "reason", "error"], "backend");
  if (item.status !== "completed" && item.status !== "cancelled" && item.status !== "failed") throw new SessionError("INVALID_DATA", "unknown backend status");
  const error = item.error === undefined ? null : fault(item.error);
  return { status: item.status, reason: text(item.reason, "backend reason", 4096), ...(error === null ? {} : { error }) };
}
function cleanup(value: unknown): CleanupEvidence | null {
  if (value === null) return null;
  const item = record(value, "cleanup"); keys(item, ["closed", "exitCode", "signal", "protocolFailure"], "cleanup");
  if (item.closed !== true) throw new SessionError("INVALID_DATA", "cleanup.closed must be confirmed true");
  const failure = fault(item.protocolFailure);
  return { closed: true, exitCode: item.exitCode === null ? null : number(item.exitCode, "exitCode", -2147483648),
    signal: item.signal === null ? null : text(item.signal, "signal", 64), protocolFailure: failure };
}
function choiceOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new SessionError("INVALID_DATA", label + " is not a known value");
  return value as T;
}
function count(value: unknown, label: string): number { return number(value, label); }
function usage(value: unknown): NativeUsage {
  const item = record(value, "native usage"); keys(item, ["turn", "context", "cost"], "native usage");
  const result: { turn?: NonNullable<NativeUsage["turn"]>; context?: NonNullable<NativeUsage["context"]>; cost?: NonNullable<NativeUsage["cost"]> } = {};
  if (item.turn !== undefined) {
    const turn = record(item.turn, "turn usage"); keys(turn, ["input", "output", "cachedInput", "cacheWrite", "reasoning", "total"], "turn usage");
    result.turn = Object.fromEntries(Object.entries(turn).map(([key, amount]) => [key, count(amount, "turn usage " + key)]));
  }
  if (item.context !== undefined) {
    const context = record(item.context, "context usage"); keys(context, ["used", "size"], "context usage");
    result.context = { used: count(context.used, "context used"), ...(context.size === undefined ? {} : { size: number(context.size, "context size", 1) }) };
  }
  if (item.cost !== undefined) {
    const cost = record(item.cost, "native cost"); keys(cost, ["amount", "currency", "scope"], "native cost");
    if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0 || cost.amount > 1e9) throw new SessionError("INVALID_DATA", "native cost amount is invalid");
    result.cost = { amount: cost.amount, currency: text(cost.currency, "cost currency", 16), scope: choiceOf(cost.scope, ["turn", "session"], "cost scope") };
  }
  return result;
}
function publicTool(value: unknown): NonNullable<PublicRun["tools"]>[number] {
  const row = record(value, "native tool"); keys(row, ["id", "title", "status", "kind", "name", "parentId", "exitCode", "detail"], "native tool");
  return { id: text(row.id, "tool identity", 512), title: text(row.title, "tool title", 4096), status: text(row.status, "tool status", 128),
    ...(row.kind === undefined ? {} : { kind: text(row.kind, "tool kind", 64) }), ...(row.name === undefined ? {} : { name: text(row.name, "tool name", 256) }),
    ...(row.parentId === undefined ? {} : { parentId: text(row.parentId, "tool parent", 512) }),
    ...(row.exitCode === undefined ? {} : { exitCode: number(row.exitCode, "tool exit code", -2147483648) }),
    ...(row.detail === undefined ? {} : { detail: parseContentRef(row.detail) }) };
}
function publicOutput(value: unknown): NonNullable<PublicRun["outputs"]>[number] {
  const row = record(value, "native output");
  if (row.kind === "content") { keys(row, ["kind", "content"], "native output"); return { kind: "content", content: parseContentRef(row.content) }; }
  keys(row, ["kind", "uri", "name", "title", "mediaType"], "native link");
  if (row.kind !== "link") throw new SessionError("INVALID_DATA", "unknown native output kind");
  const uri = text(row.uri, "native link", 4096);
  if (!/^(https?|file):\/\//iu.test(uri) || /[\r\n]/u.test(uri)) throw new SessionError("INVALID_DATA", "native link must be an http(s) or file URI");
  return { kind: "link", uri, name: text(row.name, "native link name", 1024), ...(row.title === undefined ? {} : { title: text(row.title, "native link title", 1024) }), ...(row.mediaType === undefined ? {} : { mediaType: text(row.mediaType, "native link type", 255) }) };
}
function publicRun(value: unknown): PublicRun {
  const item = record(value, "Run");
  keys(item, ["id", "commandId", "input", "userMessageId", "assistantMessageId", "selection", "epoch", "status", "cancelRequested", "contextThroughSeq", "sourceRunIds", "backend", "cleanup", "error", "stopRequested", "awaitingSwitchId", "thinking", "tools", "plan", "usage", "notices", "activities", "outputs"], "Run");
  return { id: runId(item.id), commandId: commandId(item.commandId), input: text(item.input, "Run input", MAX_INPUT_BYTES),
    userMessageId: messageId(item.userMessageId), assistantMessageId: messageId(item.assistantMessageId), selection: parseSelection(item.selection),
    epoch: number(item.epoch, "Run epoch", 1), status: status(item.status), cancelRequested: boolean(item.cancelRequested, "cancelRequested"),
    contextThroughSeq: number(item.contextThroughSeq, "contextThroughSeq"), sourceRunIds: array(item.sourceRunIds, "sourceRunIds", MAX_RUNS, runId),
    backend: backend(item.backend), cleanup: cleanup(item.cleanup), error: fault(item.error), stopRequested: boolean(item.stopRequested, "stopRequested"),
    ...(item.thinking === undefined ? {} : { thinking: text(item.thinking, "native thinking", MAX_OUTPUT_BYTES, true) }),
    ...(item.tools === undefined ? {} : { tools: array(item.tools, "native tools", MAX_RUN_TOOLS, publicTool) }),
    ...(item.plan === undefined ? {} : { plan: (() => { const plan = record(item.plan, "native plan"); keys(plan, ["entries", "explanation"], "native plan"); return {
      entries: array(plan.entries, "native plan entries", MAX_PLAN_ENTRIES, value => { const entry = record(value, "plan entry"); keys(entry, ["content", "status", "priority"], "plan entry");
        return { content: text(entry.content, "plan entry", 4096), status: choiceOf(entry.status, ["pending", "in_progress", "completed"], "plan status"), ...(entry.priority === undefined ? {} : { priority: choiceOf(entry.priority, ["high", "medium", "low"], "plan priority") }) }; }),
      ...(plan.explanation === undefined ? {} : { explanation: text(plan.explanation, "plan explanation", 4096) }) }; })() }),
    ...(item.usage === undefined ? {} : { usage: usage(item.usage) }),
    ...(item.notices === undefined ? {} : { notices: array(item.notices, "native notices", MAX_RUN_NOTICES, value => { const row = record(value, "native notice"); keys(row, ["severity", "title", "detail"], "native notice");
      return { severity: choiceOf(row.severity, ["info", "warning", "error"], "notice severity"), title: text(row.title, "notice title", 1024), ...(row.detail === undefined ? {} : { detail: text(row.detail, "notice detail", 4096) }) }; }) }),
    ...(item.activities === undefined ? {} : { activities: array(item.activities, "native activities", MAX_RUN_ACTIVITIES, value => { const row = record(value, "native activity"); keys(row, ["id", "kind", "title", "status", "detail"], "native activity");
      return { id: text(row.id, "activity identity", 512), kind: choiceOf(row.kind, ["subagent", "task", "compaction", "retry", "review"], "activity kind"), title: text(row.title, "activity title", 1024),
        status: choiceOf(row.status, ["running", "completed", "failed", "cancelled"], "activity status"), ...(row.detail === undefined ? {} : { detail: text(row.detail, "activity detail", 4096) }) }; }) }),
    ...(item.outputs === undefined ? {} : { outputs: array(item.outputs, "native outputs", MAX_RUN_OUTPUTS, publicOutput) }),
    awaitingSwitchId: item.awaitingSwitchId === null ? null : switchId(item.awaitingSwitchId) };
}
function publicMessage(value: unknown): PublicMessage {
  const item = record(value, "message"); keys(item, ["id", "runId", "role", "text", "seq", "status"], "message");
  if (item.role !== "user" && item.role !== "assistant") throw new SessionError("INVALID_DATA", "unknown public role");
  return { id: messageId(item.id), runId: runId(item.runId), role: item.role,
    text: text(item.text, "message text", item.role === "user" ? MAX_INPUT_BYTES : MAX_OUTPUT_BYTES, item.role === "assistant"), seq: number(item.seq, "message seq", 1), status: status(item.status) };
}
function publicSwitch(value: unknown): PublicSwitch {
  const item = record(value, "switch"); keys(item, ["id", "commandId", "requested", "requestedSeq", "target", "status", "throughSeq", "sourceRunIds", "error"], "switch");
  const requested = record(item.requested, "requested selection"); keys(requested, ["harnessId", "controlId", "provider", "nativeModel", "nativeOptions"], "requested selection");
  const harnessId = text(requested.harnessId, "requested harness", 96);
  const controlId = requested.controlId === undefined ? undefined : text(requested.controlId, "requested control", 96);
  if (![harnessId, ...(controlId === undefined ? [] : [controlId])].every(id => /^[a-z][a-z0-9-]*$/u.test(id))) throw new SessionError("INVALID_DATA", "invalid requested selection");
  if (item.status !== "requested" && item.status !== "validated" && item.status !== "effective" && item.status !== "failed") throw new SessionError("INVALID_DATA", "unknown switch status");
  return { id: switchId(item.id), commandId: commandId(item.commandId), requested: { harnessId, ...(controlId === undefined ? {} : { controlId }),
      ...(requested.provider === undefined ? {} : { provider: requested.provider === null ? null : providerTarget(requested.provider) }),
      ...(requested.nativeModel === undefined ? {} : { nativeModel: text(requested.nativeModel, "requested native model", 1024) }), ...(requested.nativeOptions === undefined ? {} : { nativeOptions: nativeOptions(requested.nativeOptions) }) },
    requestedSeq: number(item.requestedSeq, "switch requestedSeq", 1), target: item.target === null ? null : parseSelection(item.target), status: item.status,
    throughSeq: number(item.throughSeq, "switch throughSeq"), sourceRunIds: array(item.sourceRunIds, "switch sourceRunIds", MAX_RUNS, runId), error: fault(item.error) };
}
function command(value: unknown): CommandRecord {
  const item = record(value, "command"); keys(item, ["id", "kind", "fingerprint", "resultId"], "command");
  if (item.kind !== "create" && item.kind !== "send" && item.kind !== "switch" && item.kind !== "cancel" && item.kind !== "close" && item.kind !== "permission" && item.kind !== "native-reset") throw new SessionError("INVALID_DATA", "unknown command kind");
  const fingerprint = text(item.fingerprint, "command fingerprint", 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new SessionError("INVALID_DATA", "invalid command fingerprint");
  return { id: commandId(item.id), kind: item.kind, fingerprint, resultId: text(item.resultId, "command resultId", 128) };
}
function nativeBinding(value: unknown): NativeSessionBinding {
  const item = record(value, "native binding");
  keys(item, ["harnessId", "controlId", "checkpoint", "throughRunId", "status"], "native binding");
  const harnessId = text(item.harnessId, "native Harness", 96), controlId = text(item.controlId, "native control", 96);
  if (![harnessId, controlId].every(id => /^[a-z][a-z0-9-]*$/u.test(id)) || !["ready", "unconfirmed", "archived"].includes(String(item.status))) throw new SessionError("INVALID_DATA", "invalid native binding identity or state");
  const checkpoint = text(item.checkpoint, "native checkpoint", 8192);
  if (/[\r\n]/u.test(checkpoint)) throw new SessionError("INVALID_DATA", "invalid native checkpoint");
  return { harnessId, controlId, checkpoint, throughRunId: item.throughRunId === null ? null : runId(item.throughRunId), status: item.status as NativeSessionBinding["status"] };
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new SessionError("INVALID_DATA", "duplicate " + label);
}
/** Single persisted schema boundary. Malformed state never becomes an empty conversation. */
export function parseSession(value: unknown): SessionSnapshot {
  const item = record(value, "Session");
  keys(item, ["schemaVersion", "id", "version", "lastSeq", "epoch", "status", "configuration", "selection", "activeRunId", "pendingSwitchId", "runs", "messages", "switches", "commands", "nativeBindings"], "Session");
  if (item.schemaVersion !== 1 && item.schemaVersion !== 2 && item.schemaVersion !== 3 && item.schemaVersion !== 4 && item.schemaVersion !== 5 && item.schemaVersion !== 6 && item.schemaVersion !== 7) throw new SessionError("INVALID_DATA", "unknown Session schemaVersion");
  if (item.status !== "open" && item.status !== "closed" && item.status !== "blocked") throw new SessionError("INVALID_DATA", "unknown Session status");
  const result: SessionSnapshot = { schemaVersion: item.schemaVersion, id: sessionId(item.id), version: number(item.version, "version"), lastSeq: number(item.lastSeq, "lastSeq"),
    epoch: number(item.epoch, "epoch", 1), status: item.status, configuration: parseConfiguration(item.configuration), selection: parseSelection(item.selection),
    activeRunId: item.activeRunId === null ? null : runId(item.activeRunId), pendingSwitchId: item.pendingSwitchId === null ? null : switchId(item.pendingSwitchId),
    runs: array(item.runs, "runs", MAX_RUNS, publicRun), messages: array(item.messages, "messages", MAX_RUNS * 2, publicMessage),
    switches: array(item.switches, "switches", MAX_COMMANDS, publicSwitch), commands: array(item.commands, "commands", MAX_COMMANDS, command), ...(item.nativeBindings === undefined ? {} : { nativeBindings: array(item.nativeBindings, "native bindings", MAX_RUNS, nativeBinding) }) };
  if (result.schemaVersion < 6 && (result.nativeBindings !== undefined || result.commands.some(command => command.kind === "native-reset"))) throw new SessionError("INVALID_DATA", "native bindings require Session v6");
  if (result.schemaVersion < 7 && result.runs.some(run => run.plan !== undefined || run.usage !== undefined || run.notices !== undefined || run.activities !== undefined || run.outputs !== undefined ||
      run.tools?.some(tool => Object.keys(tool).some(key => !["id", "title", "status"].includes(key))))) throw new SessionError("INVALID_DATA", "native activity details require Session v7");
  const activeBindings = (result.nativeBindings ?? []).filter(binding => binding.status !== "archived");
  unique(activeBindings.map(binding => binding.harnessId + ":" + binding.controlId), "active native binding");
  for (const binding of result.nativeBindings ?? []) {
    if (binding.throughRunId === null) continue;
    const run = result.runs.find(run => run.id === binding.throughRunId);
    if (!run || !terminal(run.status) || run.selection.provider !== undefined || run.selection.harnessId !== binding.harnessId || run.selection.controlId !== binding.controlId) throw new SessionError("INVALID_DATA", "native cursor is not owned by a finished native Run");
    if (binding.status === "ready" && (run.backend === null || run.cleanup?.closed !== true || run.cleanup.protocolFailure !== null)) throw new SessionError("INVALID_DATA", "native binding lacks settlement and cleanup evidence");
  }
  if (item.schemaVersion === 1 && (result.selection.provider !== undefined || result.runs.some(run => run.selection.provider !== undefined) ||
      result.switches.some(entry => entry.requested.provider !== undefined || entry.target?.provider !== undefined)))
    throw new SessionError("INVALID_DATA", "legacy Session schema cannot contain Provider targets");
  if (item.schemaVersion < 4 && (result.selection.nativeModel !== undefined || result.runs.some(run => run.selection.nativeModel !== undefined || run.backend?.error !== undefined) ||
      result.switches.some(entry => entry.requested.nativeModel !== undefined || entry.target?.nativeModel !== undefined)))
    throw new SessionError("INVALID_DATA", "legacy Session schema cannot contain native model targets or backend errors");
  unique(result.runs.map(run => run.id), "Run"); unique(result.messages.map(message => message.id), "message");
  unique(result.runs.flatMap(run => [run.userMessageId, run.assistantMessageId]), "declared message identity");
  if (result.schemaVersion < 5 && [result.selection, ...result.runs.map(run => run.selection), ...result.switches.flatMap(sw => [sw.requested, ...(sw.target ? [sw.target] : [])])].some(selection => selection.nativeOptions !== undefined)) throw new SessionError("INVALID_DATA", "native options require Session v5");
  if (result.schemaVersion < 5 && (result.runs.some(run=>run.thinking!==undefined || run.tools!==undefined) || result.commands.some(command=>command.kind==="permission"))) throw new SessionError("INVALID_DATA","native activity requires Session v5");
  unique(result.switches.map(entry => entry.id), "switch"); unique(result.commands.map(entry => entry.id), "command");
  if (result.lastSeq > MAX_SESSION_EVENTS) throw new SessionError("EVENT_LIMIT", "Session event budget exhausted");
  const active = result.runs.filter(run => ["preparing", "running", "settling"].includes(run.status));
  if (active.length > 1 || (result.activeRunId === null ? active.length !== 0 : active.length !== 1 || active[0]?.id !== result.activeRunId)) throw new SessionError("INVALID_DATA", "active Run ownership is inconsistent");
  if (result.runs.filter(run => run.status === "queued").length > MAX_QUEUE) throw new SessionError("QUEUE_FULL", "Session queued input limit reached");
  if (result.status === "closed" && (result.activeRunId !== null || result.pendingSwitchId !== null || result.runs.some(run => run.status === "queued"))) throw new SessionError("INVALID_DATA", "closed Session still admits work");
  if (result.status === "open" && result.runs.some(run => run.status === "unknown" && (result.schemaVersion < 3 || run.cleanup?.closed !== true ||
      !result.switches.some(sw => sw.status === "effective" && sw.sourceRunIds.includes(run.id)))))
    throw new SessionError("INVALID_DATA", "unknown execution requires a blocked Session or explicit quiescent recovery");
  const pending = result.switches.filter(entry => entry.status === "requested" || entry.status === "validated");
  if (pending.length > 1 || (result.pendingSwitchId === null ? pending.length !== 0 : pending.length !== 1 || pending[0]?.id !== result.pendingSwitchId)) throw new SessionError("INVALID_DATA", "pending switch ownership is inconsistent");
  for (const message of result.messages) {
    const run = result.runs.find(run => run.id === message.runId);
    if (!run || message.id !== (message.role === "user" ? run.userMessageId : run.assistantMessageId) || message.seq > result.lastSeq || message.status !== run.status) throw new SessionError("INVALID_DATA", "message relation/watermark/status is inconsistent");
  }
  for (let index = 1; index < result.messages.length; index++) if (result.messages[index]!.seq <= result.messages[index - 1]!.seq) throw new SessionError("INVALID_DATA", "message creation sequence is not strictly increasing");
  for (const run of result.runs) {
    const user = result.messages.find(message => message.id === run.userMessageId && message.runId === run.id && message.role === "user");
    if (!user || user.text !== run.input || run.epoch > result.epoch || run.contextThroughSeq > result.lastSeq) throw new SessionError("INVALID_DATA", "Run/user relation is inconsistent");
    if (result.commands.filter(command => command.id === run.commandId && command.kind === "send" && command.resultId === run.id).length !== 1) throw new SessionError("INVALID_DATA", "Run/send command relation is inconsistent");
    if (run.status === "queued" && (run.backend !== null || run.cleanup !== null || run.stopRequested || run.contextThroughSeq !== 0 || run.sourceRunIds.length !== 0 || result.messages.some(message => message.id === run.assistantMessageId))) throw new SessionError("INVALID_DATA", "queued Run contains execution evidence");
    if (run.status === "running" && (run.backend !== null || run.cleanup !== null)) throw new SessionError("INVALID_DATA", "running Run has premature settlement evidence");
    if (run.status === "settling" && run.backend === null) throw new SessionError("INVALID_DATA", "settling Run lacks backend evidence");
    unique(run.sourceRunIds, "source Run");
    if (run.awaitingSwitchId !== null && !result.switches.some(entry => entry.id === run.awaitingSwitchId)) throw new SessionError("INVALID_DATA", "Run awaits an unknown switch");
    if (run.sourceRunIds.some(id => id === run.id || !result.runs.some(source => source.id === id && terminal(source.status) &&
      result.messages.some(message => message.id === source.userMessageId && message.seq < user.seq)))) throw new SessionError("INVALID_DATA", "Run context sources are inconsistent or from future input");
    if (result.messages.some(message => run.sourceRunIds.includes(message.runId) && message.seq > run.contextThroughSeq)) throw new SessionError("INVALID_DATA", "Run source message exceeds its context watermark");
    if (run.status === "completed" && (run.backend?.status !== "completed" || run.cleanup?.closed !== true || run.cleanup.protocolFailure !== null)) throw new SessionError("INVALID_DATA", "completed Run lacks backend and clean closure");
  }
  for (const entry of result.switches) {
    const preparingSwitch = entry.status === "requested" || entry.status === "validated";
    if (result.commands.filter(command => command.id === entry.commandId && command.kind === "switch" && command.resultId === entry.id).length !== 1) throw new SessionError("INVALID_DATA", "switch/command relation is inconsistent");
    if (entry.status === "validated" && entry.target === null) throw new SessionError("INVALID_DATA", "validated switch lacks target");
    unique(entry.sourceRunIds, "switch source Run");
    if (entry.requestedSeq > result.lastSeq || entry.throughSeq > result.lastSeq || entry.sourceRunIds.some(id => !result.runs.some(run => run.id === id &&
      (terminal(run.status) || (preparingSwitch && run.id === result.activeRunId))))) throw new SessionError("INVALID_DATA", "switch watermark/sources are inconsistent");
    if (entry.status === "effective" && entry.target === null) throw new SessionError("INVALID_DATA", "effective switch lacks target");
    if (entry.sourceRunIds.some(id => !result.messages.some(message => message.runId === id && message.role === "user" && message.seq < entry.requestedSeq))) throw new SessionError("INVALID_DATA", "switch source input is after its request");
  }
  const effective = result.switches.filter(entry => entry.status === "effective");
  if (result.epoch !== effective.length + 1) throw new SessionError("INVALID_DATA", "epoch does not match effective switch facts");
  const last = effective.at(-1);
  if (last?.target !== undefined && last.target !== null && !same(last.target, result.selection)) throw new SessionError("INVALID_DATA", "selection does not match last effective switch");
  if (result.commands.filter(entry => entry.kind === "create").length !== 1 || !result.commands.every(entry =>
    entry.kind === "send" ? result.runs.some(run => run.id === entry.resultId) : entry.kind === "switch" ? result.switches.some(sw => sw.id === entry.resultId) : entry.kind === "cancel" ? entry.resultId === "none" || result.runs.some(run => run.id === entry.resultId) : entry.kind === "permission" ? result.runs.some(run => run.id === entry.resultId) : entry.resultId === result.id)) throw new SessionError("INVALID_DATA", "command relation is inconsistent");
  if (utf8Bytes(JSON.stringify(result)) > MAX_SESSION_BYTES) throw new SessionError("SESSION_LIMIT", "Session aggregate byte limit reached");
  return result;
}
export function assertInput(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || utf8Bytes(value) > MAX_INPUT_BYTES) throw new SessionError("INVALID_INPUT", "message must contain text within 64 KiB");
}
export function replayCommand(state: SessionSnapshot, id: CommandRecord["id"], kind: CommandRecord["kind"], fingerprint: string): CommandRecord | null {
  const prior = state.commands.find(command => command.id === id);
  if (prior && (prior.kind !== kind || prior.fingerprint !== fingerprint)) throw new SessionError("IDEMPOTENCY_CONFLICT", "command key already names another request");
  return prior ?? null;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
/** Persisted history is append-only; an application bug cannot silently erase prior public facts. */
export function assertSessionTransition(before: SessionSnapshot, after: SessionSnapshot): void {
  if (before.schemaVersion !== after.schemaVersion || before.id !== after.id || !same(before.configuration, after.configuration)) throw new SessionError("INVALID_TRANSITION", "Session identity/configuration reference is immutable");
  const oldBindings = before.nativeBindings ?? [], newBindings = after.nativeBindings ?? [];
  if (newBindings.length < oldBindings.length) throw new SessionError("INVALID_TRANSITION", "native state references cannot be silently erased");
  for (let index = 0; index < newBindings.length; index++) {
    const old = oldBindings[index], next = newBindings[index]!;
    if (old !== undefined && same(old, next)) continue;
    if (old?.status === "archived" || old !== undefined && (old.harnessId !== next.harnessId || old.controlId !== next.controlId)) throw new SessionError("INVALID_TRANSITION", "native state ownership or archived state changed");
    const writer = after.runs.find(run => run.id === (before.activeRunId ?? after.activeRunId));
    const reset = old !== undefined && next.status === "archived" && next.checkpoint === old.checkpoint && next.throughRunId === old.throughRunId && after.selection.harnessId === next.harnessId && after.selection.controlId === next.controlId && after.commands.slice(before.commands.length).some(command => command.kind === "native-reset");
    if (!reset && (!writer || writer.selection.provider !== undefined || writer.selection.harnessId !== next.harnessId || writer.selection.controlId !== next.controlId || next.throughRunId !== null && next.throughRunId !== old?.throughRunId && next.throughRunId !== writer.id)) throw new SessionError("INVALID_TRANSITION", "native state changed without its original Run owner");
  }
  if ((before.status === "closed" && after.status !== "closed") || (before.status === "blocked" && after.status === "open" &&
      (after.epoch !== before.epoch + 1 || !after.switches.some(sw => sw.id === before.pendingSwitchId && sw.status === "effective") ||
       after.runs.some(run => run.status === "unknown" && run.cleanup?.closed !== true))))
    throw new SessionError("INVALID_TRANSITION", "closed or blocked Session cannot reopen implicitly");
  if (after.epoch < before.epoch || after.epoch > before.epoch + 1 ||
      (after.epoch === before.epoch && !same(before.selection, after.selection))) throw new SessionError("INVALID_TRANSITION", "selection can change only with one effective switch epoch");
  for (const [oldItems, newItems, label] of [
    [before.runs, after.runs, "Run"], [before.messages, after.messages, "message"],
    [before.switches, after.switches, "switch"], [before.commands, after.commands, "command"],
  ] as const) {
    if (newItems.length < oldItems.length || oldItems.some((entry, index) => newItems[index]?.id !== entry.id)) throw new SessionError("INVALID_TRANSITION", label + " history cannot be removed or reordered");
  }
  for (let index = 0; index < before.commands.length; index++) if (!same(before.commands[index], after.commands[index])) throw new SessionError("INVALID_TRANSITION", "committed command identity/result cannot be rewritten");
  for (let index = 0; index < before.runs.length; index++) {
    const old = before.runs[index]!, next = after.runs[index]!;
    if (terminal(old.status) && !same(old, next)) throw new SessionError("INVALID_TRANSITION", "terminal Run evidence cannot be rewritten");
    if (old.commandId !== next.commandId || old.input !== next.input || old.userMessageId !== next.userMessageId || old.assistantMessageId !== next.assistantMessageId || old.awaitingSwitchId !== next.awaitingSwitchId)
      throw new SessionError("INVALID_TRANSITION", "accepted Run input and identities are immutable");
    if ((old.cancelRequested && !next.cancelRequested) || (old.stopRequested && !next.stopRequested)) throw new SessionError("INVALID_TRANSITION", "cancel/stop tombstones cannot be undone");
    if ((old.backend !== null && !same(old.backend, next.backend)) || (old.cleanup !== null && !same(old.cleanup, next.cleanup))) throw new SessionError("INVALID_TRANSITION", "backend/cleanup facts cannot be overwritten");
    if (old.status !== "queued" && (!same(old.selection, next.selection) || old.epoch !== next.epoch)) throw new SessionError("INVALID_TRANSITION", "dispatched Run selection is immutable");
    if (["running", "settling"].includes(old.status) && (old.contextThroughSeq !== next.contextThroughSeq || !same(old.sourceRunIds, next.sourceRunIds))) throw new SessionError("INVALID_TRANSITION", "dispatched context cannot change");
  }
  for (let index = 0; index < before.messages.length; index++) {
    const old = before.messages[index]!, next = after.messages[index]!;
    if (old.runId !== next.runId || old.role !== next.role || old.seq !== next.seq ||
        (old.role === "user" ? old.text !== next.text : !next.text.startsWith(old.text))) throw new SessionError("INVALID_TRANSITION", "public messages cannot be rebound or overwritten");
    const oldRun = before.runs.find(run => run.id === old.runId)!;
    if (terminal(oldRun.status) && old.text !== next.text) throw new SessionError("INVALID_TRANSITION", "terminal public output is immutable");
  }
  for (let index = 0; index < before.switches.length; index++) {
    const old = before.switches[index]!, next = after.switches[index]!;
    if (old.status === "effective" || old.status === "failed") {
      if (!same(old, next)) throw new SessionError("INVALID_TRANSITION", "terminal switch evidence cannot be rewritten");
    } else if (old.commandId !== next.commandId || old.requestedSeq !== next.requestedSeq || !same(old.requested, next.requested) ||
        next.throughSeq < old.throughSeq || (old.target !== null && !same(old.target, next.target))) throw new SessionError("INVALID_TRANSITION", "switch request or validated target cannot change");
  }
}
/** Recovery creates public unknown facts; it never reconstructs a dispatch or kills a PID. */
export function recoverSession(state: SessionSnapshot): SessionMutation | null {
  const unfinished = state.runs.filter(run => !terminal(run.status));
  const pending = state.pendingSwitchId !== null;
  if (unfinished.length === 0 && !pending) return null;
  const unknown = unfinished.some(run => run.status !== "queued");
  const runs = state.runs.map(run => terminal(run.status) ? run : { ...run, status: run.status === "queued" ? "cancelled" as const : "unknown" as const,
    error: { code: "OWNER_ENDED", message: "previous owner ended without confirmed settlement; input was not replayed" } });
  const messages = state.messages.map(message => ({ ...message, status: runs.find(run => run.id === message.runId)!.status }));
  const switches = state.switches.map(entry => entry.id === state.pendingSwitchId ? { ...entry, status: "failed" as const, error: { code: "OWNER_ENDED", message: "pending switch was not activated after owner exit" } } : entry);
  return { next: { ...state, status: unknown ? "blocked" : state.status, activeRunId: null, pendingSwitchId: null, runs, messages, switches },
    events: [{ type: "session.recovered", data: { unknownRunIds: runs.filter(run => run.status === "unknown").map(run => run.id), cancelledRunIds: unfinished.filter(run => run.status === "queued").map(run => run.id), replayed: false } }] };
}
