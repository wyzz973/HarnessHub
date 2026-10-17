import { ManagementError, type ManagementJobInput } from "../../../contracts/management.js";

export function managementSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,95}$/u.test(value)) throw new ManagementError("INVALID_INPUT", "invalid Harness management identity");
  return value;
}
export function managementCommand(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new ManagementError("INVALID_INPUT", "invalid management command identity");
  return value;
}
export function installationJobId(value: unknown): string {
  if (typeof value !== "string" || !/^management-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw new ManagementError("INVALID_INPUT", "invalid installation job identity");
  return value;
}
export function parseManagementInput(value: unknown): ManagementJobInput {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ManagementError("INVALID_INPUT", "management request must be a plain object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["harnessId", "controlId", "action", "commandId", "expectedDefaultRevision", "expectedNativeFingerprint", "restartServices", "installation", "expectedInstallationFingerprint", "stopServices"].includes(key)))
    throw new ManagementError("INVALID_INPUT", "unknown management request fields");
  if (row.action !== "install" && row.action !== "upgrade" && row.action !== "uninstall") throw new ManagementError("INVALID_INPUT", "unsupported management action");
  // An uninstall names one installation and the check the user confirmed; the other actions take neither (ADR-044).
  const uninstall = row.action === "uninstall";
  if (uninstall !== (row.installation !== undefined) || uninstall !== (row.expectedInstallationFingerprint !== undefined) || !uninstall && row.stopServices !== undefined
      || uninstall && (row.controlId !== undefined || row.expectedDefaultRevision !== undefined || row.expectedNativeFingerprint !== undefined || row.restartServices !== undefined))
    throw new ManagementError("INVALID_INPUT", "an uninstall names an installation and its confirmed check; other actions do not");
  if (row.installation !== undefined && !installationRef(row.installation)) throw new ManagementError("INVALID_INPUT", "invalid installation reference");
  if (row.expectedInstallationFingerprint !== undefined && (typeof row.expectedInstallationFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.expectedInstallationFingerprint))) throw new ManagementError("INVALID_INPUT", "invalid installation fingerprint");
  if (row.stopServices !== undefined && (!Array.isArray(row.stopServices) || row.stopServices.length > 16 || row.stopServices.some(label => !serviceLabel(label)) || new Set(row.stopServices).size !== row.stopServices.length))
    throw new ManagementError("INVALID_INPUT", "invalid list of services to stop");
  if (row.expectedDefaultRevision !== undefined && (typeof row.expectedDefaultRevision !== "number" || !Number.isSafeInteger(row.expectedDefaultRevision) || row.expectedDefaultRevision < 0))
    throw new ManagementError("INVALID_INPUT", "invalid expected default revision");
  if (row.expectedNativeFingerprint !== undefined && (typeof row.expectedNativeFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.expectedNativeFingerprint))) throw new ManagementError("INVALID_INPUT", "invalid native installation fingerprint");
  if (row.restartServices !== undefined && (!Array.isArray(row.restartServices) || row.restartServices.length > 16 || row.restartServices.some(label => !serviceLabel(label)) || new Set(row.restartServices).size !== row.restartServices.length))
    throw new ManagementError("INVALID_INPUT", "invalid list of services to restart");
  return { harnessId: managementSlug(row.harnessId), ...(row.controlId === undefined ? {} : { controlId: managementSlug(row.controlId) }),
    action: row.action, commandId: managementCommand(row.commandId),
    ...(row.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: row.expectedDefaultRevision }),
    ...(row.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: row.expectedNativeFingerprint }),
    ...(row.restartServices === undefined ? {} : { restartServices: [...row.restartServices as string[]].sort() }),
    ...(row.installation === undefined ? {} : { installation: row.installation as string, expectedInstallationFingerprint: row.expectedInstallationFingerprint as string,
      stopServices: [...(row.stopServices ?? []) as string[]].sort() }) };
}
/** An installation reference as the Harness list gives it: 64 lowercase hexadecimal digits. */
export function installationRef(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
/** A service manager label as launchd accepts it: reverse-DNS characters only. */
export function serviceLabel(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value); }
export function boundedManagementLimit(value: number | undefined, maximum = 100): number {
  const result = value ?? 50;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ManagementError("INVALID_INPUT", "invalid management read limit");
  return result;
}
