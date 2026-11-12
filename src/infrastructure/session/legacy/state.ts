/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T2): taken from src/contexts/session/domain/state.ts (the whole-snapshot parse and its relation checks, and the bounds they hold to) as it was at the end of store v13 (commit 1a5f020), WITHOUT its bounds lifted.
 * The conversion of a v13 database (and the ladder from v1 to v13 that runs before it) reads old snapshots with exactly this code, so that nothing the
 * live code changes later (a bound opened, a field added) can change what an old snapshot means. Do not edit it and do not import a live parser into it;
 * tests/integration/legacy-parse.test.ts holds it to the live code on the repository's fixtures and holds this folder to its own imports.
 */

import { parseProviderTarget, type ProviderTarget } from "../../../contracts/provider.js";
import {
  SessionError, parseNativeOptions, commandId, messageId, runId, sessionId, switchId,
  type CommandRecord, type HarnessSelection, type PublicMessage, type PublicRun, type RunTiming,
  type PublicSwitch, type RunStatus, type SessionConfiguration, type SessionSnapshot, type NativeSessionBinding, type ForkedMessage, type SessionOrigin, type NativeConfiguration,
  type RetainedProcess,
} from "../../../contracts/session.js";
import type { BackendResult, CleanupEvidence, NativeUsage } from "../../../contracts/control.js";
import { MAX_RUN_OUTPUTS, parseAttachmentRefs, parseContentRef } from "./content-contract.js";
import { assertRunRelayBytes, parseBindingRelayState, parseRunRelay, parseRunRelayRequest, parseSwitchTiming } from "./relay-contract.js";
import type { BindingRelayState } from "../../../contracts/relay.js";

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
export const CURRENT_SCHEMA = 9;
/** A branched Session's quoted history: bounded like the complete public context it feeds. */
export const MAX_ORIGIN_MESSAGES = MAX_RUNS * 2;
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
/** A settled backend result; `input` (what the driver knew of the prompt reaching the native history) is kept from v13 on. */
function backend(value: unknown): BackendResult | null {
  if (value === null) return null;
  const item = record(value, "backend"); keys(item, ["status", "reason", "error", "input"], "backend");
  if (item.status !== "completed" && item.status !== "cancelled" && item.status !== "failed") throw new SessionError("INVALID_DATA", "unknown backend status");
  const error = item.error === undefined ? null : fault(item.error);
  return { status: item.status, reason: text(item.reason, "backend reason", 4096), ...(error === null ? {} : { error }),
    ...(item.input === undefined ? {} : { input: choiceOf(item.input, ["recorded", "not_recorded"], "backend input") }) };
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
/** The phases in the order they happen; contextReadyAt exists from v13. */
const TIMING_PHASES = ["preparingAt", "contextReadyAt", "readyAt", "dispatchedAt", "firstOutputAt", "endedAt"] as const;
/**
 * Phase times are bounded epoch milliseconds, none before acceptance; later phases may be absent but never precede earlier
 * ones. recordedAt (v13, E1) is not a phase: it only lies between dispatchedAt, which it needs, and endedAt (RT2-21).
 */
function runTiming(value: unknown): RunTiming {
  const item = record(value, "Run timing"); keys(item, ["acceptedAt", ...TIMING_PHASES, "recordedAt"], "Run timing");
  const at = (raw: unknown, field: string): number => { const time = number(raw, field); if (time > 8.64e15) throw new SessionError("INVALID_DATA", field + " is out of range"); return time; };
  const result: { -readonly [K in keyof RunTiming]: RunTiming[K] } = { acceptedAt: at(item.acceptedAt, "Run acceptedAt") };
  let previous = result.acceptedAt;
  for (const phase of TIMING_PHASES) {
    if (item[phase] === undefined) continue;
    const time = at(item[phase], "Run " + phase);
    if (time < previous) throw new SessionError("INVALID_DATA", "Run phases must not go back in time");
    result[phase] = time; previous = time;
  }
  if (item.recordedAt !== undefined) {
    const recorded = at(item.recordedAt, "Run recordedAt");
    if (result.dispatchedAt === undefined || recorded < result.dispatchedAt || (result.endedAt !== undefined && recorded > result.endedAt)) throw new SessionError("INVALID_DATA", "Run input was recorded outside its dispatch and end");
    result.recordedAt = recorded;
  }
  return result;
}
/** Runs publicRun built, so validated; parseSession takes one again as it is only when it is also frozen (ADR-055 §11.2). */
const parsedRuns = new WeakSet<PublicRun>();
/**
 * The Run at `index` of `before` when `value` is that very object, it had finished there and it is frozen: publicRun
 * built it and nothing can have changed it since, so parsing it again would only copy it (ADR-055 §11.2).
 */
function settledRun(before: SessionSnapshot | undefined, value: unknown, index: number): PublicRun | undefined {
  const prior = before?.runs[index];
  return prior !== undefined && value === prior && terminal(prior.status) && parsedRuns.has(prior) && Object.isFrozen(prior) ? prior : undefined;
}
function publicRun(value: unknown): PublicRun {
  const run = parsePublicRun(value); parsedRuns.add(run); return run;
}
function parsePublicRun(value: unknown): PublicRun {
  const item = record(value, "Run");
  keys(item, ["id", "commandId", "input", "userMessageId", "assistantMessageId", "selection", "epoch", "status", "cancelRequested", "contextThroughSeq", "sourceRunIds", "backend", "cleanup", "error", "stopRequested", "awaitingSwitchId", "thinking", "tools", "plan", "usage", "notices", "activities", "outputs", "attachments", "timing", "retained", "reused", "relay", "relayRequest"], "Run");
  const selection = parseSelection(item.selection);
  const relay = item.relay === undefined ? undefined : parseRunRelay(item.relay), relayRequest = item.relayRequest === undefined ? undefined : parseRunRelayRequest(item.relayRequest);
  // Where a Run ran is its own selection's native session; a managed Provider's Run has none (ADR-055 §4).
  if (relay?.executedOn != null && (selection.provider !== undefined || relay.executedOn.harnessId !== selection.harnessId || relay.executedOn.controlId !== selection.controlId)) throw new SessionError("INVALID_DATA", "a Run ran on its own selection's native session");
  assertRunRelayBytes(relay, relayRequest);
  return { id: runId(item.id), commandId: commandId(item.commandId), input: text(item.input, "Run input", MAX_INPUT_BYTES),
    userMessageId: messageId(item.userMessageId), assistantMessageId: messageId(item.assistantMessageId), selection,
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
    ...(item.attachments === undefined ? {} : { attachments: (() => { const refs = parseAttachmentRefs(item.attachments); if (!refs.length) throw new SessionError("INVALID_DATA", "an empty attachment list is omitted"); return refs; })() }),
    ...(item.timing === undefined ? {} : { timing: runTiming(item.timing) }),
    ...(item.retained === undefined ? {} : { retained: item.retained === true ? true : (() => { throw new SessionError("INVALID_DATA", "a retained Run is marked true"); })() }),
    ...(item.reused === undefined ? {} : { reused: item.reused === true ? true : (() => { throw new SessionError("INVALID_DATA", "a reusing Run is marked true"); })() }),
    ...(relay === undefined ? {} : { relay }), ...(relayRequest === undefined ? {} : { relayRequest }),
    awaitingSwitchId: item.awaitingSwitchId === null ? null : switchId(item.awaitingSwitchId) };
}
function publicMessage(value: unknown): PublicMessage {
  const item = record(value, "message"); keys(item, ["id", "runId", "role", "text", "seq", "status"], "message");
  if (item.role !== "user" && item.role !== "assistant") throw new SessionError("INVALID_DATA", "unknown public role");
  return { id: messageId(item.id), runId: runId(item.runId), role: item.role,
    text: text(item.text, "message text", item.role === "user" ? MAX_INPUT_BYTES : MAX_OUTPUT_BYTES, item.role === "assistant"), seq: number(item.seq, "message seq", 1), status: status(item.status) };
}
function publicSwitch(value: unknown): PublicSwitch {
  const item = record(value, "switch"); keys(item, ["id", "commandId", "requested", "requestedSeq", "target", "status", "throughSeq", "sourceRunIds", "error", "mode", "timing", "acknowledgedUnknown"], "switch");
  const requested = record(item.requested, "requested selection"); keys(requested, ["harnessId", "controlId", "provider", "nativeModel", "nativeOptions"], "requested selection");
  const harnessId = text(requested.harnessId, "requested harness", 96);
  const controlId = requested.controlId === undefined ? undefined : text(requested.controlId, "requested control", 96);
  if (![harnessId, ...(controlId === undefined ? [] : [controlId])].every(id => /^[a-z][a-z0-9-]*$/u.test(id))) throw new SessionError("INVALID_DATA", "invalid requested selection");
  if (item.status !== "requested" && item.status !== "validated" && item.status !== "effective" && item.status !== "failed") throw new SessionError("INVALID_DATA", "unknown switch status");
  return { id: switchId(item.id), commandId: commandId(item.commandId), requested: { harnessId, ...(controlId === undefined ? {} : { controlId }),
      ...(requested.provider === undefined ? {} : { provider: requested.provider === null ? null : providerTarget(requested.provider) }),
      ...(requested.nativeModel === undefined ? {} : { nativeModel: text(requested.nativeModel, "requested native model", 1024) }), ...(requested.nativeOptions === undefined ? {} : { nativeOptions: nativeOptions(requested.nativeOptions) }) },
    requestedSeq: number(item.requestedSeq, "switch requestedSeq", 1), target: item.target === null ? null : parseSelection(item.target), status: item.status,
    throughSeq: number(item.throughSeq, "switch throughSeq"), sourceRunIds: array(item.sourceRunIds, "switch sourceRunIds", MAX_RUNS, runId), error: fault(item.error),
    ...(item.mode === undefined ? {} : { mode: choiceOf(item.mode, ["wait_current", "cancel_current"], "switch mode") }),
    ...(item.timing === undefined ? {} : { timing: parseSwitchTiming(item.timing) }),
    ...(item.acknowledgedUnknown === undefined ? {} : { acknowledgedUnknown: array(item.acknowledgedUnknown, "acknowledged unknown Runs", MAX_RUNS, runId) }) };
}
const COMMAND_KINDS: readonly CommandRecord["kind"][] = ["create", "send", "switch", "cancel", "close", "permission", "native-reset", "retention", "native-close"];
function command(value: unknown): CommandRecord {
  const item = record(value, "command"); keys(item, ["id", "kind", "fingerprint", "resultId"], "command");
  const kind = choiceOf(item.kind, COMMAND_KINDS, "command kind");
  const fingerprint = text(item.fingerprint, "command fingerprint", 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new SessionError("INVALID_DATA", "invalid command fingerprint");
  const resultId = text(item.resultId, "command resultId", 128);
  return { id: commandId(item.id), kind, fingerprint, resultId };
}
function retainedProcess(value: unknown): RetainedProcess {
  const item = record(value, "kept native process"); keys(item, ["harnessId", "controlId", "runId", "since", "process"], "kept native process");
  const harnessId = text(item.harnessId, "kept native Harness", 96), controlId = text(item.controlId, "kept native control", 96);
  if (![harnessId, controlId].every(id => /^[a-z][a-z0-9-]*$/u.test(id))) throw new SessionError("INVALID_DATA", "invalid kept native process identity");
  const process = item.process === undefined ? undefined : (() => {
    const row = record(item.process, "kept process group"); keys(row, ["group", "startedAt"], "kept process group");
    return { group: number(row.group, "kept process group", 2), startedAt: text(row.startedAt, "kept process start", 64) };
  })();
  return { harnessId, controlId, runId: runId(item.runId), since: number(item.since, "kept native process time", 1), ...(process === undefined ? {} : { process }) };
}
function nativeBinding(value: unknown): NativeSessionBinding {
  const item = record(value, "native binding");
  keys(item, ["harnessId", "controlId", "checkpoint", "throughRunId", "status", "observed", "relay", "opensNew"], "native binding");
  const harnessId = text(item.harnessId, "native Harness", 96), controlId = text(item.controlId, "native control", 96);
  if (![harnessId, controlId].every(id => /^[a-z][a-z0-9-]*$/u.test(id)) || !["ready", "unconfirmed", "archived", "fork-pending", "forking"].includes(String(item.status))) throw new SessionError("INVALID_DATA", "invalid native binding identity or state");
  const checkpoint = text(item.checkpoint, "native checkpoint", 8192);
  if (/[\r\n]/u.test(checkpoint)) throw new SessionError("INVALID_DATA", "invalid native checkpoint");
  // v13: a binding whose next Turn opens a new native session (ADR-055 §7.5, R4) is ready and has no native position yet.
  if (item.opensNew !== undefined && (item.opensNew !== true || item.status !== "ready" && item.status !== "archived" || item.throughRunId !== null || item.relay === undefined))
    throw new SessionError("INVALID_DATA", "a binding that opens a new native session is ready, without a native position, with its relay state");
  return { harnessId, controlId, checkpoint, throughRunId: item.throughRunId === null ? null : runId(item.throughRunId), status: item.status as NativeSessionBinding["status"],
    ...(item.observed === undefined ? {} : { observed: parseNativeConfiguration(item.observed) }), ...(item.relay === undefined ? {} : { relay: parseBindingRelayState(item.relay) }),
    ...(item.opensNew === true ? { opensNew: true as const } : {}) };
}
/** A reported native configuration: a bounded model identity (or null) and options shaped like requested native options. */
export function parseNativeConfiguration(value: unknown): NativeConfiguration {
  const item = record(value, "native configuration"); keys(item, ["model", "options"], "native configuration");
  if (item.model !== null && (typeof item.model !== "string" || !item.model.trim() || item.model.length > 1024 || /[\0\r\n]/u.test(item.model))) throw new SessionError("INVALID_DATA", "invalid native configuration model");
  try { return { model: item.model, options: parseNativeOptions(item.options) }; }
  catch (error) { if (error instanceof SessionError) throw new SessionError("INVALID_DATA", "invalid native configuration options"); throw error; }
}
function quoted(value: unknown): readonly ForkedMessage[] {
  const history = array(value, "quoted history", MAX_ORIGIN_MESSAGES, entry => {
    const row = record(entry, "quoted message"); keys(row, ["role", "text", "status", "harnessId", "attachments"], "quoted message");
    if (row.role !== "user" && row.role !== "assistant") throw new SessionError("INVALID_DATA", "unknown quoted message role");
    const attachments = row.attachments === undefined ? undefined : parseAttachmentRefs(row.attachments);
    if (attachments !== undefined && (!attachments.length || row.role !== "user")) throw new SessionError("INVALID_DATA", "only a quoted user message carries attachments");
    return { role: row.role, text: text(row.text, "quoted message", MAX_OUTPUT_BYTES, true), status: status(row.status),
      ...(row.harnessId === undefined ? {} : { harnessId: text(row.harnessId, "quoted Harness", 96) }), ...(attachments === undefined ? {} : { attachments }) } as ForkedMessage;
  });
  if (utf8Bytes(JSON.stringify(history)) > MAX_CONTEXT_BYTES) throw new SessionError("INVALID_DATA", "quoted history exceeds the public context budget");
  return history;
}
function origin(value: unknown): SessionOrigin {
  const item = record(value, "Session origin");
  if (item.kind === "import") {
    keys(item, ["kind", "harnessId", "title", "omitted", "complete", "historyRead", "history"], "Session origin");
    const harnessId = text(item.harnessId, "imported Harness", 96);
    if (!/^[a-z][a-z0-9-]*$/u.test(harnessId)) throw new SessionError("INVALID_DATA", "invalid imported Harness");
    const title = item.title === null ? null : text(item.title, "imported title", 1024);
    if (title !== null && /[\0-\x1f\x7f]/u.test(title)) throw new SessionError("INVALID_DATA", "invalid imported title");
    const history = quoted(item.history), historyRead = boolean(item.historyRead, "imported history read");
    const complete = boolean(item.complete, "imported history completeness");
    if (!historyRead && (history.length || complete)) throw new SessionError("INVALID_DATA", "an unread native history quotes nothing");
    return { kind: "import", harnessId, title, omitted: number(item.omitted, "omitted native messages"), complete, historyRead, history };
  }
  keys(item, ["kind", "sessionId", "throughRunId", "history"], "Session origin");
  if (item.kind !== "fork") throw new SessionError("INVALID_DATA", "unknown Session origin");
  return { kind: "fork", sessionId: sessionId(item.sessionId), throughRunId: runId(item.throughRunId), history: quoted(item.history) };
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new SessionError("INVALID_DATA", "duplicate " + label);
}
/**
 * The relay fields (v13, ADR-055 §4): every binding of a v13 Session has its relay state, and none does before v13; along
 * the bindings of one Harness control, in the order they were made, native epochs strictly increase and clear floors never
 * go down (the binding lineage, §7.5, §14.4). The other v13 fields of Runs, switches, commands and the Session appear only
 * from v13.
 */
function relayFields(result: SessionSnapshot): void {
  const bindings = result.nativeBindings ?? [];
  if (result.schemaVersion < 13) {
    if (bindings.some(binding => binding.relay !== undefined) || result.relayRecoveryFailed !== undefined ||
        result.runs.some(run => run.relay !== undefined || run.relayRequest !== undefined || run.backend?.input !== undefined || run.timing?.contextReadyAt !== undefined || run.timing?.recordedAt !== undefined) ||
        result.switches.some(entry => entry.mode !== undefined || entry.timing !== undefined || entry.acknowledgedUnknown !== undefined))
      throw new SessionError("INVALID_DATA", "relay fields require Session v13");
    return;
  }
  const lineage = new Map<string, BindingRelayState>();
  for (const binding of bindings) {
    if (binding.relay === undefined) throw new SessionError("INVALID_DATA", "every v13 native binding has its relay state");
    const key = binding.harnessId + ":" + binding.controlId, earlier = lineage.get(key);
    if (earlier !== undefined && (binding.relay.epoch <= earlier.epoch || binding.relay.floor < earlier.floor))
      throw new SessionError("INVALID_DATA", "the native epochs and clear floors of one Harness control go forward along its bindings");
    lineage.set(key, binding.relay);
  }
  if (result.relayRecoveryFailed !== undefined && result.relayRecoveryFailed > result.lastSeq) throw new SessionError("INVALID_DATA", "relay recovery failure is after the Session's events");
}
/**
 * Single persisted schema boundary. Malformed state never becomes an empty conversation.
 *
 * `before`, when given, is the validated and deeply frozen state that `value` is to follow (a Store transaction's current
 * state): a finished Run of it that `value` holds as the same object at the same position is kept as it is instead of
 * being parsed again (ADR-055 §11.2). Every other Run, every other part and every relation across Runs, messages, switches
 * and commands is checked in full; whether the change itself is allowed is assertSessionTransition's to decide.
 */
export function parseSession(value: unknown, before?: SessionSnapshot): SessionSnapshot {
  const item = record(value, "Session");
  keys(item, ["schemaVersion", "id", "version", "lastSeq", "epoch", "status", "configuration", "selection", "activeRunId", "pendingSwitchId", "runs", "messages", "switches", "commands", "nativeBindings", "origin", "retainNative", "retained", "relayRecoveryFailed"], "Session");
  if (item.schemaVersion !== 1 && item.schemaVersion !== 2 && item.schemaVersion !== 3 && item.schemaVersion !== 4 && item.schemaVersion !== 5 && item.schemaVersion !== 6 && item.schemaVersion !== 7 && item.schemaVersion !== 8 && item.schemaVersion !== 9 && item.schemaVersion !== 10 && item.schemaVersion !== 11 && item.schemaVersion !== 12 && item.schemaVersion !== 13) throw new SessionError("INVALID_DATA", "unknown Session schemaVersion");
  if (item.status !== "open" && item.status !== "closed" && item.status !== "blocked") throw new SessionError("INVALID_DATA", "unknown Session status");
  const result: SessionSnapshot = { schemaVersion: item.schemaVersion, id: sessionId(item.id), version: number(item.version, "version"), lastSeq: number(item.lastSeq, "lastSeq"),
    epoch: number(item.epoch, "epoch", 1), status: item.status, configuration: parseConfiguration(item.configuration), selection: parseSelection(item.selection),
    activeRunId: item.activeRunId === null ? null : runId(item.activeRunId), pendingSwitchId: item.pendingSwitchId === null ? null : switchId(item.pendingSwitchId),
    runs: array(item.runs, "runs", MAX_RUNS, value => value).map((run, index) => settledRun(before, run, index) ?? publicRun(run)), messages: array(item.messages, "messages", MAX_RUNS * 2, publicMessage),
    switches: array(item.switches, "switches", MAX_COMMANDS, publicSwitch), commands: array(item.commands, "commands", MAX_COMMANDS, command), ...(item.nativeBindings === undefined ? {} : { nativeBindings: array(item.nativeBindings, "native bindings", MAX_RUNS, nativeBinding) }),
    ...(item.origin === undefined ? {} : { origin: origin(item.origin) }),
    ...(item.retainNative === undefined ? {} : { retainNative: item.retainNative === true ? true : (() => { throw new SessionError("INVALID_DATA", "kept native processes are marked true"); })() }),
    ...(item.retained === undefined ? {} : { retained: retainedProcess(item.retained) }),
    ...(item.relayRecoveryFailed === undefined ? {} : { relayRecoveryFailed: number(item.relayRecoveryFailed, "relay recovery failure seq", 1) }) };
  // Branches and their pending native forks exist only from v8; a fork reference always belongs to a branched Session.
  if (result.schemaVersion < 8 && (result.origin !== undefined || result.nativeBindings?.some(binding => binding.status === "fork-pending" || binding.status === "forking"))) throw new SessionError("INVALID_DATA", "branched Sessions require Session v8");
  if (result.nativeBindings?.some(binding => (binding.status === "fork-pending" || binding.status === "forking") && (result.origin?.kind !== "fork" || binding.throughRunId !== null))) throw new SessionError("INVALID_DATA", "a native fork reference needs its branch origin");
  // A continued native session (v9) keeps the reference it was imported with, even after it is archived.
  const imported = result.origin?.kind === "import" ? result.origin : undefined;
  if (imported && (result.schemaVersion < 9 || !result.nativeBindings?.some(binding => binding.harnessId === imported.harnessId)))
    throw new SessionError("INVALID_DATA", "a continued native session requires Session v9 and its native reference");
  if (result.schemaVersion < 10 && result.runs.some(run => run.timing !== undefined)) throw new SessionError("INVALID_DATA", "Run timing requires Session v10");
  // A conversation that keeps its native process (ADR-030) exists only from v11; the process it holds was handed over by a
  // completed Run of the same entry, whose process was not closed.
  if (result.schemaVersion < 11 && (result.retainNative !== undefined || result.retained !== undefined || result.runs.some(run => run.retained !== undefined || run.reused !== undefined) || result.commands.some(command => command.kind === "retention" || command.kind === "native-close")))
    throw new SessionError("INVALID_DATA", "kept native processes require Session v11");
  // The identity that lets a later owner end a kept process group exists only from v12 (ADR-030).
  if (result.schemaVersion < 12 && result.retained?.process !== undefined) throw new SessionError("INVALID_DATA", "a kept process group identity requires Session v12");
  relayFields(result);
  if (result.runs.some(run => run.retained === true && (run.status !== "completed" || run.cleanup !== null || run.backend === null))) throw new SessionError("INVALID_DATA", "only a completed Run without its own cleanup hands its process over");
  if (result.runs.some(run => run.reused === true && (run.status === "queued" || run.selection.provider !== undefined))) throw new SessionError("INVALID_DATA", "only a started native Run reuses a kept process");
  if (result.retained !== undefined) {
    const handed = result.runs.find(run => run.id === result.retained!.runId);
    if (!handed || handed.retained !== true || handed.selection.provider !== undefined || handed.selection.harnessId !== result.retained.harnessId || handed.selection.controlId !== result.retained.controlId)
      throw new SessionError("INVALID_DATA", "a kept native process belongs to the Run that handed it over");
  }
  if (result.schemaVersion < 9 && result.nativeBindings?.some(binding => binding.observed !== undefined)) throw new SessionError("INVALID_DATA", "observed native configuration requires Session v9");
  if (result.origin?.kind === "fork" && result.origin.sessionId === result.id) throw new SessionError("INVALID_DATA", "a Session cannot be branched from itself");
  if (result.schemaVersion < 6 && (result.nativeBindings !== undefined || result.commands.some(command => command.kind === "native-reset"))) throw new SessionError("INVALID_DATA", "native bindings require Session v6");
  if (result.schemaVersion < 7 && result.runs.some(run => run.plan !== undefined || run.usage !== undefined || run.notices !== undefined || run.activities !== undefined || run.outputs !== undefined || run.attachments !== undefined ||
      run.tools?.some(tool => Object.keys(tool).some(key => !["id", "title", "status"].includes(key))))) throw new SessionError("INVALID_DATA", "native activity details require Session v7");
  const activeBindings = (result.nativeBindings ?? []).filter(binding => binding.status !== "archived");
  unique(activeBindings.map(binding => binding.harnessId + ":" + binding.controlId), "active native binding");
  for (const binding of result.nativeBindings ?? []) {
    if (binding.throughRunId === null) continue;
    const run = result.runs.find(run => run.id === binding.throughRunId);
    if (!run || !terminal(run.status) || run.selection.provider !== undefined || run.selection.harnessId !== binding.harnessId || run.selection.controlId !== binding.controlId) throw new SessionError("INVALID_DATA", "native cursor is not owned by a finished native Run");
    // A Run that handed its process to the conversation has no cleanup of its own; the conversation records the close.
    if (binding.status === "ready" && (run.backend === null || run.retained !== true && (run.cleanup?.closed !== true || run.cleanup.protocolFailure !== null))) throw new SessionError("INVALID_DATA", "native binding lacks settlement and cleanup evidence");
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
  // An unknown Run in an open Session was acknowledged by an effective recovery switch: by its sources before v13 (K19) or by
  // its acknowledgedUnknown, which v13 switches write; both are read.
  if (result.status === "open" && result.runs.some(run => run.status === "unknown" && (result.schemaVersion < 3 || run.cleanup?.closed !== true ||
      !result.switches.some(sw => sw.status === "effective" && (sw.sourceRunIds.includes(run.id) || sw.acknowledgedUnknown?.includes(run.id) === true)))))
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
    // A Run that handed its process to the conversation (v11) has no closure of its own; the conversation records it.
    if (run.status === "completed" && (run.backend?.status !== "completed" || run.retained !== true && (run.cleanup?.closed !== true || run.cleanup.protocolFailure !== null))) throw new SessionError("INVALID_DATA", "completed Run lacks backend and clean closure");
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
    // RT1-m10: each acknowledged Run ended unknown, closed its resources and was accepted before the request.
    if (entry.acknowledgedUnknown !== undefined) {
      unique(entry.acknowledgedUnknown, "acknowledged unknown Run");
      if (entry.acknowledgedUnknown.some(id => { const run = result.runs.find(row => row.id === id); return run === undefined || run.status !== "unknown" || run.cleanup?.closed !== true ||
          !result.messages.some(message => message.id === run.userMessageId && message.seq < entry.requestedSeq); })) throw new SessionError("INVALID_DATA", "an acknowledged Run is not an earlier unknown Run with closed resources");
    }
  }
  const effective = result.switches.filter(entry => entry.status === "effective");
  if (result.epoch !== effective.length + 1) throw new SessionError("INVALID_DATA", "epoch does not match effective switch facts");
  const last = effective.at(-1);
  if (last?.target !== undefined && last.target !== null && !same(last.target, result.selection)) throw new SessionError("INVALID_DATA", "selection does not match last effective switch");
  if (result.commands.filter(entry => entry.kind === "create").length !== 1 || !result.commands.every(entry =>
    entry.kind === "send" ? result.runs.some(run => run.id === entry.resultId) : entry.kind === "switch" ? result.switches.some(sw => sw.id === entry.resultId) : entry.kind === "cancel" ? entry.resultId === "none" || result.runs.some(run => run.id === entry.resultId) : entry.kind === "permission" ? result.runs.some(run => run.id === entry.resultId)
      : entry.resultId === result.id)) throw new SessionError("INVALID_DATA", "command relation is inconsistent");
  if (utf8Bytes(JSON.stringify(result)) > MAX_SESSION_BYTES) throw new SessionError("SESSION_LIMIT", "Session aggregate byte limit reached");
  return result;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
