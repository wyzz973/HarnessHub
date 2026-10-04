// SPDX-License-Identifier: MIT
import { HubError } from "@harnesshub/core/errors";

export type LibraryErrorCode =
  | "LIBRARY_INVALID"
  | "LIBRARY_SKILL_INVALID"
  | "LIBRARY_UNSUPPORTED"
  | "LIBRARY_NOT_FOUND"
  | "LIBRARY_EXISTS"
  | "LIBRARY_CONFLICT"
  | "LIBRARY_CONCURRENT_MODIFICATION"
  | "SECRET_REF_FORBIDDEN";

const status: Record<LibraryErrorCode, number> = {
  LIBRARY_INVALID: 400,
  LIBRARY_SKILL_INVALID: 400,
  LIBRARY_UNSUPPORTED: 400,
  LIBRARY_NOT_FOUND: 404,
  LIBRARY_EXISTS: 409,
  LIBRARY_CONFLICT: 409,
  LIBRARY_CONCURRENT_MODIFICATION: 409,
  SECRET_REF_FORBIDDEN: 400,
};

/**
 * A Library failure with a stable public code. Messages name items, agents
 * and paths, never secret values or file content.
 */
export class LibraryError extends HubError {
  override readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode, message: string) {
    super(code, message, status[code]);
    this.name = "LibraryError";
    this.code = code;
  }
}
