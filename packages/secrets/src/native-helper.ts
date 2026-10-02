// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the system secret helper for a platform, in this package's
 * `dist/native`: `harnesshub-keychain` (macOS login keychain) or
 * `harnesshub-secrets.exe` (Windows DPAPI). `native/build-keychain.mjs` builds
 * only the current platform's helper during `pnpm build`, so the file exists
 * only after a build on that platform. Computed on every call from this
 * module's location, so a single-executable build that relocates the module
 * resolves it under its extraction root.
 */
export function secretHelperPath(platform: "darwin" | "win32"): string {
  return fileURLToPath(
    platform === "win32"
      ? new URL("../native/harnesshub-secrets.exe", import.meta.url)
      : new URL("../native/harnesshub-keychain", import.meta.url),
  );
}
