import { ManagementError, type HarnessManagementView, type InstallationJobStatus, type InstallationJobView, type InstallationLog, type InstallationTarget, type ResolvedManagedControl, type NativeInstallPlan, type ServiceRestartFact, type UninstallFacts } from "../../../contracts/management.js";
import { installationJobId, installationRef, managementSlug, serviceLabel } from "./input.js";
import { isAbsolute } from "node:path";

export interface InstallationRecord { readonly id: string; readonly harnessId: string; readonly controlId: string; readonly version: string;
  readonly slot: string; readonly command: ResolvedManagedControl["command"]; readonly artifactSha256: string | null; readonly launchSha256: string }
export function managementObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("INVALID_DATA", "management record must be an object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !fields.includes(field))) throw new ManagementError("INVALID_DATA", "unknown management record fields"); return row;
}
export function managementString(value: unknown, maximum = 4096, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || new TextEncoder().encode(value).byteLength > maximum || /[\0\r\n]/u.test(value))
    throw new ManagementError("INVALID_DATA", "invalid management text field"); return value;
}
export function managementInteger(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new ManagementError("INVALID_DATA", "invalid management integer"); return value;
}
function date(value: unknown): string {
  const input = managementString(value, 32); if (!Number.isFinite(Date.parse(input)) || new Date(input).toISOString() !== input) throw new ManagementError("INVALID_DATA", "invalid management timestamp"); return input;
}
export function managementInstallationId(value: unknown): string {
  const input = managementString(value, 64); if (!/^installation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input)) throw new ManagementError("INVALID_DATA", "invalid installation identity"); return input;
}
function errorValue(value: unknown): InstallationJobView["error"] {
  if (value === null) return null; const row = managementObject(value, ["code", "message"]);
  return { code: managementString(row.code, 128), message: managementString(row.message, 2048) };
}
function jobStatus(value: unknown): InstallationJobStatus {
  for (const status of ["queued", "resolving", "installing", "verifying", "activating", "completed", "cancelled", "failed", "unknown"] as const) if (value === status) return status;
  throw new ManagementError("INVALID_DATA", "invalid management job status");
}
function serviceFact(value: unknown): ServiceRestartFact {
  const row = managementObject(value, ["label", "outcome", "pid", "ready"]);
  if (!serviceLabel(row.label) || row.outcome !== "restarted" && row.outcome !== "not_running" && row.outcome !== "not_recovered" || row.ready !== null && typeof row.ready !== "boolean")
    throw new ManagementError("INVALID_DATA", "service restart facts are invalid");
  return { label: row.label, outcome: row.outcome, pid: row.pid === null ? null : managementInteger(row.pid, 1), ready: row.ready };
}
function labels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(label => !serviceLabel(label))) throw new ManagementError("INVALID_DATA", "service labels are invalid");
  return (value as readonly string[]).slice();
}
function uninstallFacts(value: unknown): UninstallFacts {
  const row = managementObject(value, ["label", "role", "stopServices", "stoppedServices", "removed"]);
  if (row.role !== "product" && row.role !== "adapter" || typeof row.removed !== "boolean") throw new ManagementError("INVALID_DATA", "uninstall facts are invalid");
  return { label: managementString(row.label, 256), role: row.role, stopServices: labels(row.stopServices), stoppedServices: labels(row.stoppedServices), removed: row.removed };
}
export function parseManagementJob(value: unknown): InstallationJobView {
  const row = managementObject(value, ["id", "harnessId", "controlId", "action", "status", "phase", "cancelRequested", "createdAt", "updatedAt", "resolvedVersion", "installationId", "error", "logCursor", "native"]);
  const status = jobStatus(row.status), phase = managementString(row.phase, 32);
  if (row.action !== "install" && row.action !== "upgrade" && row.action !== "uninstall" || typeof row.cancelRequested !== "boolean" || (phase !== status && phase !== "interrupted"))
    throw new ManagementError("INVALID_DATA", "management job action/phase/cancellation is inconsistent");
  const resolvedVersion = row.resolvedVersion === null ? null : managementString(row.resolvedVersion, 128), installationId = row.installationId === null ? null : managementInstallationId(row.installationId), error = errorValue(row.error);
  let native: InstallationJobView["native"];
  if (row.native !== undefined) {
    const value = managementObject(row.native, ["channel", "location", "beforeVersion", "actualVersion", "dispatched", "configurationPreserved", "restartServices", "closedConversations", "clearedRecords", "services", "configurationChangedByService", "uninstall"]);
    if (typeof value.dispatched !== "boolean" || value.configurationPreserved !== null && typeof value.configurationPreserved !== "boolean") throw new ManagementError("INVALID_DATA", "native maintenance facts are invalid");
    if (value.restartServices !== undefined && (!Array.isArray(value.restartServices) || value.restartServices.length > 16 || value.restartServices.some(label => !serviceLabel(label)))
      || value.closedConversations !== undefined && managementInteger(value.closedConversations) > 1024 || value.clearedRecords !== undefined && managementInteger(value.clearedRecords) > 1024
      || value.configurationChangedByService !== undefined && typeof value.configurationChangedByService !== "boolean"
      || value.services !== undefined && (!Array.isArray(value.services) || value.services.length > 16)) throw new ManagementError("INVALID_DATA", "native maintenance facts are invalid");
    native = { channel: managementString(value.channel, 32), location: managementString(value.location, 4096, true), beforeVersion: value.beforeVersion === null ? null : managementString(value.beforeVersion, 128), actualVersion: value.actualVersion === null ? null : managementString(value.actualVersion, 128), dispatched: value.dispatched, configurationPreserved: value.configurationPreserved,
      ...(value.restartServices === undefined ? {} : { restartServices: (value.restartServices as readonly string[]).slice() }),
      ...(value.closedConversations === undefined ? {} : { closedConversations: managementInteger(value.closedConversations) }),
      ...(value.clearedRecords === undefined ? {} : { clearedRecords: managementInteger(value.clearedRecords) }),
      ...(value.services === undefined ? {} : { services: (value.services as readonly unknown[]).map(serviceFact) }),
      ...(value.configurationChangedByService === undefined ? {} : { configurationChangedByService: value.configurationChangedByService as boolean }),
      ...(value.uninstall === undefined ? {} : { uninstall: uninstallFacts(value.uninstall) }) };
  }
  // An uninstall carries its facts and nothing an install publishes; it completes once removal is verified, without a version afterwards.
  if (row.action === "uninstall") {
    if (native?.uninstall === undefined || installationId !== null || native.actualVersion !== null || native.restartServices !== undefined || native.services !== undefined
        || status === "completed" && (error !== null || !native.dispatched || native.configurationPreserved !== true || !native.uninstall.removed)
        || status === "queued" && (native.dispatched || error !== null || native.uninstall.stoppedServices.length > 0 || native.uninstall.removed))
      throw new ManagementError("INVALID_DATA", "uninstall job facts are inconsistent");
    return { id: installationJobId(row.id), harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), action: "uninstall",
      status, phase, cancelRequested: row.cancelRequested, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), resolvedVersion, installationId, error, logCursor: managementInteger(row.logCursor), native };
  }
  if (native?.uninstall !== undefined) throw new ManagementError("INVALID_DATA", "only an uninstall carries uninstall facts");
  if (status === "queued" && (resolvedVersion !== null || installationId !== null || error !== null || native?.dispatched) || status === "completed" && (resolvedVersion === null || error !== null || native === undefined && installationId === null || native !== undefined && (installationId !== null || !native.dispatched || native.actualVersion !== resolvedVersion || native.configurationPreserved !== true)))
    throw new ManagementError("INVALID_DATA", "management terminal/admission fields are inconsistent");
  return { id: installationJobId(row.id), harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), action: row.action as "install" | "upgrade",
    status, phase, cancelRequested: row.cancelRequested, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), resolvedVersion, installationId, error, logCursor: managementInteger(row.logCursor), ...(native === undefined ? {} : { native }) };
}
export function parseNativePlan(value: unknown): NativeInstallPlan {
  const row = managementObject(value, ["harnessId", "controlId", "channel", "manager", "reference", "prefix", "entry", "actualEntry", "beforeVersion", "fingerprint", "reason"]);
  const channel = row.channel;
  if (channel !== "npm" && channel !== "brew-formula" && channel !== "brew-cask" && channel !== "uv" && channel !== "archive" && channel !== "native-cli" && channel !== "unsupported" || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.fingerprint)) throw new ManagementError("INVALID_DATA", "native plan channel/fingerprint is invalid");
  for (const field of ["manager", "prefix", "entry", "actualEntry"] as const) {
    const path = managementString(row[field], 4096, true);
    if (path && !isAbsolute(path) || channel !== "unsupported" && field !== "actualEntry" && !(field === "manager" && channel === "archive") && !path) throw new ManagementError("INVALID_DATA", "native plan paths must be absolute");
  }
  const reference = managementString(row.reference, 256);
  if (channel !== "unsupported" && !/^(?:@[a-z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*){0,2}$/u.test(reference)) throw new ManagementError("INVALID_DATA", "native package identity is invalid");
  return { harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), channel, manager: managementString(row.manager, 4096, true), reference: managementString(row.reference, 256), prefix: managementString(row.prefix, 4096, true), entry: managementString(row.entry, 4096, true), actualEntry: managementString(row.actualEntry, 4096, true), beforeVersion: row.beforeVersion === null ? null : managementString(row.beforeVersion, 128), fingerprint: row.fingerprint, reason: row.reason === null ? null : managementString(row.reason, 512) };
}
export function parseManagementLog(value: unknown): InstallationLog {
  const row = managementObject(value, ["seq", "time", "stream", "text"]);
  if (row.stream !== "stdout" && row.stream !== "stderr" && row.stream !== "system") throw new ManagementError("INVALID_DATA", "invalid management log stream");
  if (typeof row.text !== "string" || new TextEncoder().encode(row.text).byteLength > 16384 || row.text.includes("\0")) throw new ManagementError("INVALID_DATA", "invalid management log text");
  return { seq: managementInteger(row.seq, 1), time: date(row.time), stream: row.stream, text: row.text };
}
export function parseInstallationRecord(value: unknown): InstallationRecord {
  const row = managementObject(value, ["id", "harnessId", "controlId", "version", "slot", "command", "artifactSha256", "launchSha256"]), command = managementObject(row.command, ["executable", "args", "env"]);
  if (!Array.isArray(command.args) || command.args.length > 64) throw new ManagementError("INVALID_DATA", "managed command arguments exceed their budget");
  const env = managementObject(command.env, Object.keys(command.env !== null && typeof command.env === "object" ? command.env : {}));
  if (Object.keys(env).length > 64) throw new ManagementError("INVALID_DATA", "managed command environment exceeds its budget");
  const copied: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)) throw new ManagementError("INVALID_DATA", "invalid managed environment identity");
    Object.defineProperty(copied, key, { value: managementString(value, 8192, true), enumerable: true }); }
  const artifactSha256 = row.artifactSha256 === null ? null : managementString(row.artifactSha256, 64);
  if (artifactSha256 !== null && !/^[a-f0-9]{64}$/u.test(artifactSha256)) throw new ManagementError("INVALID_DATA", "invalid observed artifact digest");
  const launchSha256 = managementString(row.launchSha256, 64); if (!/^[a-f0-9]{64}$/u.test(launchSha256)) throw new ManagementError("INVALID_DATA", "invalid managed launch receipt digest");
  return { id: managementInstallationId(row.id), harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), version: managementString(row.version, 128), slot: managementString(row.slot),
    command: { executable: managementString(command.executable), args: command.args.map(arg => managementString(arg, 4096, true)), env: copied }, artifactSha256, launchSha256 };
}
export function parseManagementUpdate(value: unknown): Pick<HarnessManagementView, "latestVersion" | "updateStatus" | "checkedAt" | "error"> {
  const row = managementObject(value, ["latestVersion", "updateStatus", "checkedAt", "error"]); let updateStatus: HarnessManagementView["updateStatus"] | null = null;
  for (const status of ["unchecked", "checking", "available", "current", "failed", "unsupported"] as const) if (row.updateStatus === status) updateStatus = status;
  if (updateStatus === null) throw new ManagementError("INVALID_DATA", "invalid management update status");
  return { latestVersion: row.latestVersion === null ? null : managementString(row.latestVersion, 128), updateStatus, checkedAt: row.checkedAt === null ? null : date(row.checkedAt), error: errorValue(row.error) };
}
/** A frozen uninstall target as stored with its job (management schema v4); paths are absolute and the reference is the list's. */
export function parseInstallationTarget(value: unknown): InstallationTarget {
  const row = managementObject(value, ["harnessId", "controlId", "ref", "role", "channel", "name", "root", "prefix", "entry", "resolvedPath", "version", "active", "label", "fingerprint"]);
  if (!installationRef(row.ref) || row.role !== "product" && row.role !== "adapter" || typeof row.active !== "boolean" || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.fingerprint))
    throw new ManagementError("INVALID_DATA", "installation target identity is invalid");
  const channel = row.channel;
  if (channel !== "npm" && channel !== "brew-formula" && channel !== "brew-cask" && channel !== "script" && channel !== "uv") throw new ManagementError("INVALID_DATA", "installation target channel is not maintained");
  const path = (field: unknown) => { const text = managementString(field); if (!isAbsolute(text)) throw new ManagementError("INVALID_DATA", "installation target paths must be absolute"); return text; };
  return { harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), ref: row.ref, role: row.role, channel, name: managementString(row.name, 256), root: path(row.root), prefix: row.prefix === null ? null : path(row.prefix),
    entry: path(row.entry), resolvedPath: path(row.resolvedPath), version: row.version === null ? null : managementString(row.version, 128), active: row.active, label: managementString(row.label, 256), fingerprint: row.fingerprint };
}
