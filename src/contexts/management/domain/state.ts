import { ManagementError, type HarnessManagementView, type InstallationJobStatus, type InstallationJobView, type InstallationLog, type InstallationTarget, type OfficialInstallFacts, type PreparedInstall, type InstallationUpgradeFacts, type PreparedUpgrade, type ResolvedManagedControl, type NativeInstallPlan, type RuntimeRequirement, type ServiceRestartFact, type UninstallFacts } from "../../../contracts/management.js";
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
function texts(value: unknown, maximum: number, size = 512): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new ManagementError("INVALID_DATA", "management text list is invalid");
  return value.map(item => managementString(item, size, true));
}
function officialFacts(value: unknown): OfficialInstallFacts {
  const row = managementObject(value, ["method", "source", "sha256", "shellChanges", "configChanges", "blocked", "installed"]);
  if (row.method !== "script" && row.method !== "npm" || typeof row.installed !== "boolean" || row.sha256 !== null && (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256))
      || !Array.isArray(row.shellChanges) || row.shellChanges.length > 4 || !Array.isArray(row.configChanges) || row.configChanges.length > 4)
    throw new ManagementError("INVALID_DATA", "official install facts are invalid");
  return { method: row.method, source: managementString(row.source, 1024), sha256: row.sha256 as string | null,
    shellChanges: (row.shellChanges as unknown[]).map(item => { const change = managementObject(item, ["file", "added", "removed"]); return { file: managementString(change.file, 1024), added: texts(change.added, 64), removed: texts(change.removed, 64) }; }),
    configChanges: (row.configChanges as unknown[]).map(item => { const change = managementObject(item, ["file", "keys"]);
      if (!Array.isArray(change.keys) || change.keys.length > 64) throw new ManagementError("INVALID_DATA", "official install facts are invalid");
      return { file: managementString(change.file, 1024), keys: change.keys.map(key => { const entry = managementObject(key, ["path", "value"]); return { path: managementString(entry.path, 256), value: entry.value === null ? null : managementString(entry.value, 256, true) }; }) }; }),
    blocked: texts(row.blocked, 16, 1024), installed: row.installed };
}
function changeLists(row: Record<string, unknown>): Pick<InstallationUpgradeFacts, "shellChanges" | "configChanges"> {
  if (!Array.isArray(row.shellChanges) || row.shellChanges.length > 4 || !Array.isArray(row.configChanges) || row.configChanges.length > 4) throw new ManagementError("INVALID_DATA", "recorded changes are invalid");
  return { shellChanges: (row.shellChanges as unknown[]).map(item => { const change = managementObject(item, ["file", "added", "removed"]); return { file: managementString(change.file, 1024), added: texts(change.added, 64), removed: texts(change.removed, 64) }; }),
    configChanges: (row.configChanges as unknown[]).map(item => { const change = managementObject(item, ["file", "keys"]);
      if (!Array.isArray(change.keys) || change.keys.length > 64) throw new ManagementError("INVALID_DATA", "recorded changes are invalid");
      return { file: managementString(change.file, 1024), keys: change.keys.map(key => { const entry = managementObject(key, ["path", "value"]); return { path: managementString(entry.path, 256), value: entry.value === null ? null : managementString(entry.value, 256, true) }; }) }; }) };
}
function installationUpgradeFacts(value: unknown): InstallationUpgradeFacts {
  const row = managementObject(value, ["label", "role", "kind", "command", "dependencies", "shellChanges", "configChanges", "blocked"]);
  if (row.role !== "product" && row.role !== "adapter" || row.kind !== "version" && row.kind !== "self-update" && row.kind !== "rerun") throw new ManagementError("INVALID_DATA", "installation upgrade facts are invalid");
  return { label: managementString(row.label, 256), role: row.role, kind: row.kind, command: managementString(row.command, 2048), dependencies: texts(row.dependencies, 64, 256), ...changeLists(row), blocked: texts(row.blocked, 16, 1024) };
}
export function parseManagementJob(value: unknown): InstallationJobView {
  const row = managementObject(value, ["id", "harnessId", "controlId", "action", "status", "phase", "cancelRequested", "createdAt", "updatedAt", "resolvedVersion", "installationId", "error", "logCursor", "native"]);
  const status = jobStatus(row.status), phase = managementString(row.phase, 32);
  if (row.action !== "install" && row.action !== "upgrade" && row.action !== "uninstall" || typeof row.cancelRequested !== "boolean" || (phase !== status && phase !== "interrupted"))
    throw new ManagementError("INVALID_DATA", "management job action/phase/cancellation is inconsistent");
  const resolvedVersion = row.resolvedVersion === null ? null : managementString(row.resolvedVersion, 128), installationId = row.installationId === null ? null : managementInstallationId(row.installationId), error = errorValue(row.error);
  let native: InstallationJobView["native"];
  if (row.native !== undefined) {
    const value = managementObject(row.native, ["channel", "location", "beforeVersion", "actualVersion", "dispatched", "configurationPreserved", "restartServices", "closedConversations", "clearedRecords", "services", "configurationChangedByService", "uninstall", "official", "installation"]);
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
      ...(value.uninstall === undefined ? {} : { uninstall: uninstallFacts(value.uninstall) }),
      ...(value.official === undefined ? {} : { official: officialFacts(value.official) }),
      ...(value.installation === undefined ? {} : { installation: installationUpgradeFacts(value.installation) }) };
  }
  // An upgrade of one installation through its channel (ADR-044) publishes no private installation; it completes once the new version was read.
  if (native?.installation !== undefined) {
    if (row.action !== "upgrade" || installationId !== null || native.uninstall !== undefined || native.official !== undefined || native.restartServices !== undefined || native.services !== undefined
        || status === "completed" && (error !== null || !native.dispatched || native.configurationPreserved !== true || native.actualVersion === null || resolvedVersion !== native.actualVersion)
        || status === "queued" && (native.dispatched || error !== null))
      throw new ManagementError("INVALID_DATA", "installation upgrade job facts are inconsistent");
    return { id: installationJobId(row.id), harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), action: "upgrade",
      status, phase, cancelRequested: row.cancelRequested, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), resolvedVersion, installationId, error, logCursor: managementInteger(row.logCursor), native };
  }
  // An official install (ADR-044) publishes no private installation; it completes once the product was found in its channel.
  if (native?.official !== undefined) {
    if (row.action !== "install" || installationId !== null || native.uninstall !== undefined || native.restartServices !== undefined || native.services !== undefined
        || status === "completed" && (error !== null || !native.dispatched || !native.official.installed || native.configurationPreserved !== true || native.actualVersion === null || resolvedVersion !== native.actualVersion)
        || status === "queued" && (native.dispatched || error !== null || native.official.installed))
      throw new ManagementError("INVALID_DATA", "official install job facts are inconsistent");
    return { id: installationJobId(row.id), harnessId: managementSlug(row.harnessId), controlId: managementSlug(row.controlId), action: "install",
      status, phase, cancelRequested: row.cancelRequested, createdAt: date(row.createdAt), updatedAt: date(row.updatedAt), resolvedVersion, installationId, error, logCursor: managementInteger(row.logCursor), native };
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
function runtimeRequirement(value: unknown): RuntimeRequirement {
  const row = managementObject(value, ["runtime", "required", "found", "path", "satisfied", "service", "restarted", "upgradeCommand"]);
  if (row.runtime !== "Node.js" || typeof row.satisfied !== "boolean" || typeof row.restarted !== "boolean") throw new ManagementError("INVALID_DATA", "runtime requirement is invalid");
  return { runtime: "Node.js", required: managementString(row.required, 512), found: row.found === null ? null : managementString(row.found, 128), path: managementString(row.path),
    satisfied: row.satisfied, service: row.service === null ? null : managementString(row.service, 256), restarted: row.restarted, upgradeCommand: row.upgradeCommand === null ? null : managementString(row.upgradeCommand, 256) };
}
/** A prepared official install as frozen with its job (management schema v5); paths are absolute. */
export function parseInstallRequest(value: unknown): PreparedInstall & { readonly fingerprint: string } {
  const row = managementObject(value, ["harnessId", "method", "source", "sha256", "script", "interpreter", "args", "env", "writes", "shellProfile", "configFiles", "package", "version", "prefix", "npm", "entry", "command", "runtime", "fingerprint"]);
  const absolute = (field: unknown, nullable: boolean): string | null => { if (field === null && nullable) return null; const text = managementString(field); if (!isAbsolute(text)) throw new ManagementError("INVALID_DATA", "install request paths must be absolute"); return text; };
  if (row.method !== "script" && row.method !== "npm" || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.fingerprint) || row.interpreter !== null && row.interpreter !== "bash" && row.interpreter !== "sh"
      || row.sha256 !== null && (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.sha256)) || (row.method === "script") !== (row.script !== null && row.sha256 !== null && row.interpreter !== null)
      || (row.method === "npm") !== (row.package !== null && row.version !== null && row.prefix !== null && row.npm !== null))
    throw new ManagementError("INVALID_DATA", "install request is inconsistent");
  const env = managementObject(row.env, Object.keys(row.env !== null && typeof row.env === "object" ? row.env : {})), copied: Record<string, string> = {};
  if (Object.keys(env).length > 16) throw new ManagementError("INVALID_DATA", "install request environment is invalid");
  for (const [key, item] of Object.entries(env)) { if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(key)) throw new ManagementError("INVALID_DATA", "install request environment is invalid"); copied[key] = managementString(item, 256); }
  const paths = (field: unknown) => { if (!Array.isArray(field) || field.length > 16) throw new ManagementError("INVALID_DATA", "install request paths are invalid"); return field.map(item => absolute(item, false)!); };
  return { harnessId: managementSlug(row.harnessId), method: row.method, source: managementString(row.source, 1024), sha256: row.sha256 as string | null, script: absolute(row.script, true), interpreter: row.interpreter as "bash" | "sh" | null,
    args: texts(row.args, 8, 128), env: copied, writes: paths(row.writes), shellProfile: absolute(row.shellProfile, true), configFiles: paths(row.configFiles),
    package: row.package === null ? null : managementString(row.package, 214), version: row.version === null ? null : managementString(row.version, 128), prefix: absolute(row.prefix, true), npm: absolute(row.npm, true),
    entry: absolute(row.entry, false)!, command: managementString(row.command, 64), runtime: row.runtime === null ? null : runtimeRequirement(row.runtime), fingerprint: row.fingerprint };
}
/** A prepared installation upgrade as frozen with its job (management schema v6). */
export function parseUpgradeRequest(value: unknown): PreparedUpgrade & { readonly fingerprint: string } {
  const row = managementObject(value, ["target", "kind", "command", "executable", "args", "env", "writes", "shellProfile", "configFiles", "version", "dependencies", "script", "runtime", "fingerprint"]);
  const absolute = (field: unknown): string => { const text = managementString(field); if (!isAbsolute(text)) throw new ManagementError("INVALID_DATA", "upgrade request paths must be absolute"); return text; };
  if (row.kind !== "version" && row.kind !== "self-update" && row.kind !== "rerun" || typeof row.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.fingerprint) || (row.kind === "rerun") !== (row.script !== null))
    throw new ManagementError("INVALID_DATA", "upgrade request is inconsistent");
  const env = managementObject(row.env, Object.keys(row.env !== null && typeof row.env === "object" ? row.env : {})), copied: Record<string, string> = {};
  if (Object.keys(env).length > 24) throw new ManagementError("INVALID_DATA", "upgrade request environment is invalid");
  for (const [key, item] of Object.entries(env)) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)) throw new ManagementError("INVALID_DATA", "upgrade request environment is invalid"); copied[key] = managementString(item, 4096, true); }
  let script: PreparedUpgrade["script"] = null;
  if (row.script !== null) {
    const item = managementObject(row.script, ["path", "source", "sha256", "interpreter"]);
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256) || item.interpreter !== "bash" && item.interpreter !== "sh") throw new ManagementError("INVALID_DATA", "upgrade request script is invalid");
    script = { path: absolute(item.path), source: managementString(item.source, 1024), sha256: item.sha256, interpreter: item.interpreter };
  }
  if (!Array.isArray(row.writes) || row.writes.length > 16 || !Array.isArray(row.configFiles) || row.configFiles.length > 8) throw new ManagementError("INVALID_DATA", "upgrade request paths are invalid");
  return { target: parseInstallationTarget(row.target), kind: row.kind, command: managementString(row.command, 2048), executable: absolute(row.executable), args: texts(row.args, 16, 1024), env: copied,
    writes: row.writes.map(absolute), shellProfile: row.shellProfile === null ? null : absolute(row.shellProfile), configFiles: row.configFiles.map(absolute),
    version: row.version === null ? null : managementString(row.version, 128), dependencies: texts(row.dependencies, 64, 256), script,
    runtime: row.runtime === null ? null : runtimeRequirement(row.runtime), fingerprint: row.fingerprint };
}
