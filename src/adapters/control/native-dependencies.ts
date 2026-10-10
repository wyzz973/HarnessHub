import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ControlLaunch } from "../../contracts/control.js";
import { ControlError } from "../../infrastructure/control/json-rpc-process.js";

/** Bind vendor SDK adapters to the user's existing native CLI rather than an SDK-bundled replacement. */
export async function bindNativeDependencies(harness: string, launch: ControlLaunch): Promise<ControlLaunch> {
  if (!harness.startsWith("claude")) return launch;
  const explicit = launch.env.CLAUDE_CODE_EXECUTABLE;
  const candidates = explicit ? [explicit] : [...(launch.env.PATH ?? "").split(":"), join(launch.env.HOME ?? "", ".local", "bin")].filter(isAbsolute).map(root => join(root, "claude"));
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) throw new ControlError("NATIVE_DEPENDENCY_UNAVAILABLE", "native Claude Code path must be absolute");
      await access(candidate, constants.X_OK); const path = await realpath(candidate); if (!(await stat(path)).isFile()) continue;
      return { ...launch, env: { ...launch.env, CLAUDE_CODE_EXECUTABLE: path } };
    } catch (error) {
      if (explicit) throw new ControlError("NATIVE_DEPENDENCY_UNAVAILABLE", "the explicitly selected native Claude Code executable is unavailable");
      if (error !== null && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) continue;
      throw error;
    }
  }
  throw new ControlError("NATIVE_DEPENDENCY_UNAVAILABLE", "install the native Claude Code CLI before connecting its ACP adapter");
}
