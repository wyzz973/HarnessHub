import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createFileSessionStore } from "acpx/runtime";
import type { AcpSessionRecord, AcpSessionStore } from "acpx/runtime";
import type { ExecutionSpec } from "../../domain/ports.js";

/** Safe failure details; backend checkpoints and credentials never enter public errors. */
export class AcpSessionRecoveryError extends Error {
  readonly code = "ACP_SESSION_RECOVERY_FAILED";
  constructor() {
    super("The pinned ACP session checkpoint cannot be restored");
  }
}

/**
 * Pins acpx's private checkpoint to the public session identity before ensureSession.
 * Missing, incompatible, orphaned, or replaced checkpoints fail before session/new.
 * acpx persistent turns additionally enforce same-session-only reconnect semantics.
 */
export async function openPinnedSessionStore(
  spec: ExecutionSpec,
): Promise<AcpSessionStore> {
  const delegate = createFileSessionStore({ stateDir: spec.stateDir });
  let backendId = spec.backendSessionId;
  const loadRecord = async (): Promise<AcpSessionRecord | undefined> => {
    // acpx 0.13.2 treats malformed files as missing. Detect that distinction
    // before ensureSession can initialize an empty replacement.
    const file = join(
      spec.stateDir,
      "sessions",
      `${encodeURIComponent(spec.sessionId)}.json`,
    );
    const stat = await lstat(file).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new AcpSessionRecoveryError();
    const record = await delegate.load(spec.sessionId);
    if (stat && !record) throw new AcpSessionRecoveryError();
    return record;
  };
  const validate = (record: AcpSessionRecord): void => {
    if (
      record.acpxRecordId !== spec.sessionId ||
      !record.acpSessionId ||
      (backendId !== undefined && record.acpSessionId !== backendId) ||
      resolve(record.cwd) !== resolve(spec.cwd) ||
      !sameArgv(record.agentArgv, spec.profile.command) ||
      record.acpx?.reset_on_next_ensure === true
    )
      throw new AcpSessionRecoveryError();
  };
  try {
    const record = await loadRecord();
    if (record) {
      if (!backendId) throw new AcpSessionRecoveryError();
      validate(record);
    } else if (backendId) {
      throw new AcpSessionRecoveryError();
    }
  } catch {
    throw new AcpSessionRecoveryError();
  }
  return {
    async load(id) {
      if (id !== spec.sessionId) throw new AcpSessionRecoveryError();
      const record = await loadRecord();
      if (record) validate(record);
      else if (backendId) throw new AcpSessionRecoveryError();
      return record;
    },
    async save(record) {
      validate(record);
      backendId ??= record.acpSessionId;
      await delegate.save(record);
    },
  };
}

function sameArgv(
  checkpoint: string[] | undefined,
  configured: string[] | undefined,
): boolean {
  return (
    checkpoint !== undefined &&
    configured !== undefined &&
    checkpoint.length === configured.length &&
    checkpoint.every((value, index) => value === configured[index])
  );
}
