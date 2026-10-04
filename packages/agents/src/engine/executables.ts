// SPDX-License-Identifier: MIT
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/** Windows only searches executable/script extensions we can launch; PATHEXT orders the supported extensions. */
export function executableNames(
  name: string,
  platform: NodeJS.Platform = process.platform,
  pathExt = ".COM;.EXE;.BAT;.CMD",
): string[] {
  if (platform !== "win32") return [name];
  const supported = [".exe", ".com", ".cmd", ".bat", ".ps1"];
  if (path.extname(name))
    return supported.includes(path.extname(name).toLowerCase()) ? [name] : [];
  const extensions = [
    ...new Set([
      ...pathExt
        .split(";")
        .map((value) => value.toLowerCase())
        .filter((value) => supported.includes(value)),
      ...supported,
    ]),
  ];
  // npm also supplies extensionless shebang launchers; scripts are launched by the portable wrapper.
  return [...extensions.map((extension) => `${name}${extension}`), name];
}

/** Tests ordinary readable/executable files, following valid file links without executing them. */
export async function availableExecutable(
  location: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    if (!(await stat(location)).isFile()) return false;
    await access(
      location,
      platform === "win32" ? constants.R_OK : constants.X_OK,
    );
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

/**
 * Whether a PATH directory holds wrappers that run something else than the
 * command they are named after: cmux's shims (`…/cmux-cli-shims/…`, and
 * those inside `cmux.app`) re-launch an agent through the developer's
 * cmux session, so an agent found only there is not installed. Agent
 * detection and the real-agent suites skip these directories.
 */
export function isWrapperDirectory(directory: string): boolean {
  const normal = directory.replaceAll("\\", "/");
  return (
    normal.split("/").includes("cmux-cli-shims") ||
    /(^|\/)cmux\.app(\/|$)/.test(normal)
  );
}

/** Directory order wins over extension order; no empty PATH entry searches the current directory. */
export async function locateExecutable(
  names: readonly string[],
  directories: readonly string[],
  platform: NodeJS.Platform = process.platform,
  pathExt?: string,
): Promise<string | undefined> {
  for (const directory of directories) {
    for (const name of names) {
      for (const filename of executableNames(name, platform, pathExt)) {
        const location = path.join(directory, filename);
        if (await availableExecutable(location, platform)) return location;
      }
    }
  }
  return undefined;
}
