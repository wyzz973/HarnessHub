// SPDX-License-Identifier: MIT
import { HubError } from "@harnesshub/core/errors";

/** Failure classes of global wiring; each is a stable public code. */
export type WiringErrorCode =
  | "WIRING_ADAPTER_UNKNOWN"
  | "WIRING_TARGET_INVALID"
  | "WIRING_CONTEXT_INVALID"
  | "WIRING_RECORD_INVALID"
  | "WIRING_CONFIG_UNPARSEABLE"
  | "WIRING_UNSUPPORTED_STRUCTURE"
  | "WIRING_PATH_CONFLICT"
  | "WIRING_SYMLINK_ESCAPE"
  | "WIRING_NOT_REGULAR_FILE"
  | "WIRING_CONCURRENT_MODIFICATION"
  | "WIRING_BUSY"
  | "WIRING_BACKUP_INVALID"
  | "WIRING_WRITE_FAILED"
  | "WIRING_VERIFY_FAILED";

const status: Record<WiringErrorCode, number> = {
  WIRING_ADAPTER_UNKNOWN: 404,
  WIRING_TARGET_INVALID: 400,
  WIRING_CONTEXT_INVALID: 400,
  WIRING_RECORD_INVALID: 400,
  WIRING_CONFIG_UNPARSEABLE: 409,
  WIRING_UNSUPPORTED_STRUCTURE: 409,
  WIRING_PATH_CONFLICT: 409,
  WIRING_SYMLINK_ESCAPE: 409,
  WIRING_NOT_REGULAR_FILE: 409,
  WIRING_CONCURRENT_MODIFICATION: 409,
  WIRING_BUSY: 409,
  WIRING_BACKUP_INVALID: 500,
  WIRING_WRITE_FAILED: 500,
  WIRING_VERIFY_FAILED: 500,
};

/** What happened to one file while a failed operation rolled back. */
export interface WiringRollback {
  path: string;
  restored: boolean;
  /** Present when restoring failed; the backup id lets a person restore by hand. */
  error?: string;
  backupId?: string;
}

/**
 * A wiring failure. Messages name files and key paths but never contain key
 * values or file content: parser diagnostics are reduced to a position, so a
 * secret in the user's file cannot reach a log through this error.
 */
export class WiringError extends HubError {
  override readonly code: WiringErrorCode;
  /** The configuration file concerned, when there is one. */
  readonly path: string | undefined;
  /** Files restored (or not) after a failed write; empty when nothing was written. */
  readonly rollback: WiringRollback[];

  constructor(
    code: WiringErrorCode,
    message: string,
    options: {
      path?: string;
      rollback?: WiringRollback[];
      cause?: unknown;
    } = {},
  ) {
    super(code, message, status[code]);
    this.name = "WiringError";
    this.code = code;
    this.path = options.path;
    this.rollback = options.rollback ?? [];
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
