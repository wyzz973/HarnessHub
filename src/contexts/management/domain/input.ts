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
  if (Object.keys(row).some(key => !["harnessId", "controlId", "action", "commandId", "expectedDefaultRevision", "expectedNativeFingerprint"].includes(key)))
    throw new ManagementError("INVALID_INPUT", "unknown management request fields");
  if (row.action !== "install" && row.action !== "upgrade") throw new ManagementError("INVALID_INPUT", "unsupported management action");
  if (row.expectedDefaultRevision !== undefined && (typeof row.expectedDefaultRevision !== "number" || !Number.isSafeInteger(row.expectedDefaultRevision) || row.expectedDefaultRevision < 0))
    throw new ManagementError("INVALID_INPUT", "invalid expected default revision");
  if (row.expectedNativeFingerprint !== undefined && (typeof row.expectedNativeFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(row.expectedNativeFingerprint))) throw new ManagementError("INVALID_INPUT", "invalid native installation fingerprint");
  return { harnessId: managementSlug(row.harnessId), ...(row.controlId === undefined ? {} : { controlId: managementSlug(row.controlId) }),
    action: row.action, commandId: managementCommand(row.commandId),
    ...(row.expectedDefaultRevision === undefined ? {} : { expectedDefaultRevision: row.expectedDefaultRevision }),
    ...(row.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: row.expectedNativeFingerprint }) };
}
export function boundedManagementLimit(value: number | undefined, maximum = 100): number {
  const result = value ?? 50;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new ManagementError("INVALID_INPUT", "invalid management read limit");
  return result;
}
