import { parseProviderTarget, type ProviderTarget } from "../../../contracts/provider.js";
import {
  SessionError, parseNativeOptions,
  type CommandRecord, type HarnessSelection, type NativeConfiguration, type NativeSessionBinding, type PublicRun, type RunStatus, type SessionConfiguration,
} from "../../../contracts/session.js";
import type { NativeOptions } from "../../../contracts/control.js";
import { dispatched } from "./relay/advance.js";

/*
 * What the Runtime needs of a conversation that is not a reducer of its rows (those are conversation-state.ts): the parsers of the small objects a request brings
 * (a selection, a configuration, a native configuration), the words of a Run's last states, the check of an input, the idempotent replay of a command, and the
 * native values a session changed itself. There is no whole-conversation parser here any more: a conversation is rows (ADR-057), each checked when it is written (by
 * the keys and triggers of the tables and by conversation-state.ts). The frozen parser of the old snapshot is infrastructure/session/legacy/state.ts, which only the
 * migration and the read-only tools read.
 */

/**
 * The longest input a user sends in one message: only a guard against a mistaken paste of a whole dump, not a limit on what a message may say (2026-11-12: 64 KiB
 * refused real messages). The message route's request body is sized for it (web/server.ts MAX_MESSAGE_BODY_BYTES).
 */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
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
/** A reported native configuration: a bounded model identity (or null) and options shaped like requested native options. */
export function parseNativeConfiguration(value: unknown): NativeConfiguration {
  const item = record(value, "native configuration"); keys(item, ["model", "options"], "native configuration");
  if (item.model !== null && (typeof item.model !== "string" || !item.model.trim() || item.model.length > 1024 || /[\0\r\n]/u.test(item.model))) throw new SessionError("INVALID_DATA", "invalid native configuration model");
  try { return { model: item.model, options: parseNativeOptions(item.options) }; }
  catch (error) { if (error instanceof SessionError) throw new SessionError("INVALID_DATA", "invalid native configuration options"); throw error; }
}
/**
 * Requested native values that the native session itself changed (by its own commands) since its last Turn under the same
 * selection epoch. The next Turn applies these native values instead of reverting them; an effective switch (a new epoch,
 * even to the same selection) applies the selection again. Values the selection does not request are never applied. The
 * last Turn is the last one dispatched to the binding's Harness, whether or not it moved the binding's native position
 * (a command Turn owing facts does not, ADR-055 §7.6). `state` is a conversation in either shape: only its bindings and its Runs' selections, epochs and times are read.
 */
export function carriedNativeConfiguration(state: { readonly nativeBindings?: readonly NativeSessionBinding[]; readonly runs: readonly Pick<PublicRun, "selection" | "epoch" | "timing" | "backend" | "status">[] },
    selection: HarnessSelection, epoch: number): { readonly model?: string; readonly options?: NativeOptions } | null {
  if (selection.provider !== undefined) return null;
  const binding = state.nativeBindings?.find(item => item.harnessId === selection.harnessId && item.controlId === selection.controlId && item.status === "ready");
  const observed = binding?.observed, last = binding === undefined ? undefined
    : state.runs.findLast(run => run.selection.provider === undefined && run.selection.harnessId === binding.harnessId && run.selection.controlId === binding.controlId && dispatched(run));
  if (observed === undefined || last === undefined || last.epoch !== epoch) return null;
  const model = selection.nativeModel !== undefined && observed.model !== null && observed.model !== selection.nativeModel ? observed.model : undefined;
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(selection.nativeOptions ?? {})) { const seen = observed.options[key]; if (seen !== undefined && seen !== value) options[key] = seen; }
  if (model === undefined && !Object.keys(options).length) return null;
  return { ...(model === undefined ? {} : { model }), ...(Object.keys(options).length ? { options } : {}) };
}
export function assertInput(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || utf8Bytes(value) > MAX_INPUT_BYTES) throw new SessionError("INVALID_INPUT", "message must contain text within 32 MiB");
}
export function replayCommand(state: { readonly commands: readonly CommandRecord[] }, id: CommandRecord["id"], kind: CommandRecord["kind"], fingerprint: string): CommandRecord | null {
  const prior = state.commands.find(command => command.id === id);
  if (prior && (prior.kind !== kind || prior.fingerprint !== fingerprint)) throw new SessionError("IDEMPOTENCY_CONFLICT", "command key already names another request");
  return prior ?? null;
}
