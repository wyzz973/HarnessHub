import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HubError } from "../domain/errors.js";

const execute = promisify(execFile);

async function privatePaths(
  paths: string[],
  kind: "directory" | "file" | "any",
  protect: boolean,
): Promise<void> {
  if (process.platform !== "win32")
    throw new HubError("UNSUPPORTED_PLATFORM", "Windows ACLs require Windows");
  try {
    const operation = execute(
      fileURLToPath(
        new URL("../../native/harnesshub-acl.exe", import.meta.url),
      ),
      [],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 },
    );
    // The helper reads bounded path metadata from stdin and never runs a shell.
    // A pipe failure terminates the child; execute then observes its failed exit.
    operation.child.stdin?.on("error", () => operation.child.kill());
    operation.child.stdin?.end(JSON.stringify({ paths, kind, protect }));
    const { stdout } = await operation;
    if (stdout !== "private") throw new Error("Unexpected ACL response");
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
