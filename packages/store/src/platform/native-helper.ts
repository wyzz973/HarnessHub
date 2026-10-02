// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the Windows ACL helper `harnesshub-acl.exe` in this
 * package's `dist/native`, where `native/build-windows-acl.mjs` writes it
 * during `pnpm build` on Windows only. It is computed on every call from this
 * module's location, so a single-executable build that relocates the module
 * resolves it under its extraction root. The file exists only after a Windows
 * build; callers start it only on Windows.
 */
export function aclHelperPath(): string {
  return fileURLToPath(
    new URL("../../native/harnesshub-acl.exe", import.meta.url),
  );
}
