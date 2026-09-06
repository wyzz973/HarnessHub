import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError } from "../../domain/errors.js";
import { existsSync } from "node:fs";

/** This exact repository-owned wrapper is the only script whose env arguments are unpacked. */
export const portableLauncher = fileURLToPath(
  new URL("../../../../scripts/launch-engine.mjs", import.meta.url),
);

/** Convert our portable argv environment (or existing simple POSIX env recipe) into Worker-owned values. */
export function unwrapEnvironment(command: readonly string[]): {
  command: string[];
  env: Record<string, string>;
} {
  const result = { command: [...command], env: {} as Record<string, string> };
  const portable = result.command[1] === portableLauncher;
  if (portable) result.command.splice(0, 2);
  else if (result.command[0] === "/usr/bin/env") result.command.shift();
  else return result;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(result.command[0] ?? "")) {
    const assignment = result.command.shift()!;
    const split = assignment.indexOf("=");
    result.env[assignment.slice(0, split)] = assignment.slice(split + 1);
  }
  if (result.command[0] === "--") result.command.shift();
  else if (portable)
    throw new HubError(
      "ENGINE_CONFIGURATION_UNSUPPORTED",
      "Portable engine launcher requires an explicit argument boundary",
    );
  if (!result.command[0] || result.command[0].startsWith("-"))
    throw new HubError(
      "ENGINE_CONFIGURATION_UNSUPPORTED",
      "Engine environment launcher requires a fixed command; env options are unsupported",
    );
  return result;
}

/** Route Windows scripts through the repository launcher while leaving argv (including a CLI prompt slot) separate. */
export function portableCommand(
  command: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || !command[0]) return [...command];
  const extension = path.extname(command[0]).toLowerCase();
  if ([".exe", ".com"].includes(extension)) return [...command];
  // Leave missing absolute commands to the Driver's native spawn-error path.
  if (path.isAbsolute(command[0]) && !existsSync(command[0]))
    return [...command];
  return [process.execPath, portableLauncher, "--", ...command];
}
