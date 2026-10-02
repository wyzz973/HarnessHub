// SPDX-License-Identifier: MIT
import { HubError } from "@harnesshub/core/errors";
import { aclHelperPath } from "./native-helper.js";
import { platformLauncher } from "./process-launcher.js";

async function privatePaths(
  paths: string[],
  kind: "directory" | "file" | "any",
  protect: boolean,
): Promise<void> {
  if (process.platform !== "win32")
    throw new HubError("UNSUPPORTED_PLATFORM", "Windows ACLs require Windows");
  const launcher = platformLauncher();
  try {
    // The helper reads bounded path metadata from stdin and never runs a shell.
    // A pipe failure terminates the child; its failed exit is then observed.
    const result = await launcher.run({
      file: aclHelperPath(),
      args: [],
      env: "inherit",
      input: JSON.stringify({ paths, kind, protect }),
      timeoutMs: 10_000,
      maxBuffer: 16 * 1024,
    });
    if (result.error) throw result.error;
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.exceeded ||
      result.stdout.toString("utf8") !== "private"
    )
      throw new Error("Unexpected ACL response");
  } catch (cause) {
    const error = new HubError(
      "INVALID_PRIVATE_PATH",
      "Windows private path access control could not be verified",
      403,
    );
    error.cause = cause;
    throw error;
  }
}

/** Applies and verifies an inheritable DACL for gateway-owned directories only. */
export function ensurePrivateDirectories(directories: string[]): Promise<void> {
  return privatePaths(directories, "directory", true);
}

/** Applies a private DACL; caller must create and reject links before calling. */
export function ensurePrivateDirectory(directory: string): Promise<void> {
  return ensurePrivateDirectories([directory]);
}

/** Rejects foreign owners or allow grants without changing an existing directory. */
export function verifyPrivateDirectory(directory: string): Promise<void> {
  return privatePaths([directory], "directory", false);
}

/** Rejects links, foreign owners or allow grants without changing a file. */
export function verifyPrivateFile(file: string): Promise<void> {
  return privatePaths([file], "file", false);
}

/** Verifies every directory's ACL in a single native call without changing it. */
export function verifyPrivateDirectories(directories: string[]): Promise<void> {
  return privatePaths(directories, "directory", false);
}

/** Checks prevalidated file/directory paths together without changing their ACLs. */
export function verifyPrivatePaths(paths: string[]): Promise<void> {
  return privatePaths(paths, "any", false);
}
