import { ManagementError, type HarnessManagementView, type InstallationJobStatus, type InstallationJobView, type InstallationLog, type ResolvedManagedControl } from "../../../contracts/management.js";
import { installationJobId, managementSlug } from "./input.js";

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
export function parseManagementJob(value: unknown): InstallationJobView {
  const row = managementObject(value, ["id", "harnessId", "controlId", "action", "status", "phase", "cancelRequested", "createdAt", "updatedAt", "resolvedVersion", "installationId", "error", "logCursor"]);
  const status = jobStatus(row.status), phase = managementString(row.phase, 32);
  if (row.action !== "install" && row.action !== "upgrade" || typeof row.cancelRequested !== "boolean" || (phase !== status && phase !== "interrupted"))
    throw new ManagementError("INVALID_DATA", "management job action/phase/cancellation is inconsistent");
  const resolvedVersion = row.resolvedVersion === null ? null : managementString(row.resolvedVersion, 128), installationId = row.installationId === null ? null : managementInstallationId(row.installationId), error = errorValue(row.error);
  if (status === "queued" && (resolvedVersion !== null || installationId !== null || error !== null) || status === "completed" && (resolvedVersion === null || installationId === null || error !== null))
    throw new ManagementError("INVALID_DATA", "management terminal/admission fields are inconsistent");
  return { id: installationJobId(row.id), harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), action: row.action,
    status, phase, cancelRequested: row.cancelRequested, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), resolvedVersion, installationId, error, logCursor: managementInteger(row.logCursor) };
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
