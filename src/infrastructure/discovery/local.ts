import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import {
  DiscoveryInputError,
  type ExecutableLocator,
  type ExecutableLookup,
  type LookupNote,
} from "../../contexts/catalog/domain/discovery.js";

export interface SearchDirectory {
  readonly path: string;
  readonly source: "path" | "configured-directory" | "known-directory";
}

/** Build a bounded ordered search list without looking through arbitrary user files. */
export function searchDirectories(input: {
  readonly path: string;
  readonly home: string;
  readonly extra: readonly string[];
  readonly pathOnly: boolean;
}): { readonly directories: readonly SearchDirectory[]; readonly notes: readonly LookupNote[] } {
  const directories: SearchDirectory[] = [];
  const notes: LookupNote[] = [];
  const seen = new Set<string>();
  const add = (path: string, source: SearchDirectory["source"], strict: boolean) => {
    if (!path) {
      if (strict) throw new DiscoveryInputError("search directories must be absolute and non-empty");
      return;
    }
    if (path.length > 4096 || path.includes("\0"))
      throw new DiscoveryInputError("search directory exceeds the input limit");
    if (!isAbsolute(path)) {
      if (strict) throw new DiscoveryInputError("search directories must be absolute");
      notes.push({ code: "relative_path_ignored", path });
      return;
    }
    const key = normalize(path);
    if (!seen.has(key)) {
      seen.add(key);
      directories.push({ path: key, source });
    }
  };
  for (const path of input.path.split(delimiter)) add(path, "path", false);
  for (const path of input.extra) add(path, "configured-directory", true);
  if (!input.pathOnly) {
    if (!isAbsolute(input.home)) throw new DiscoveryInputError("home must be absolute");
    for (const path of [
      join(input.home, ".local/bin"),
      join(input.home, ".npm-global/bin"),
      join(input.home, ".bun/bin"),
      join(input.home, ".cargo/bin"),
      join(input.home, ".opencode/bin"),
      join(input.home, ".claude/local"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
    ]) add(path, "known-directory", true);
  }
  if (directories.length > 128) throw new DiscoveryInputError("too many search directories");
  return { directories, notes };
}

function errno(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** A lookup only stats/accesses candidates. It never reads config or executes a binary. */
export class LocalExecutableLocator implements ExecutableLocator {
  constructor(private readonly directories: readonly SearchDirectory[]) {}

  validateOverride(path: string): void {
    if (!isAbsolute(path))
      throw new DiscoveryInputError("explicit executable overrides must be absolute");
  }

  async lookup(binary: string, override: string | undefined): Promise<ExecutableLookup> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(binary))
      throw new DiscoveryInputError("invalid executable name");
    if (override !== undefined) this.validateOverride(override);
    const candidates =
      override === undefined
        ? this.directories.map((directory) => ({
            path: join(directory.path, binary),
            source: directory.source,
          }))
        : [{ path: override, source: "override" as const }];
    const notes: LookupNote[] = [];
    for (const candidate of candidates) {
      let operation: "stat" | "access" | "resolve" = "stat";
      try {
        const info = await stat(candidate.path);
        if (!info.isFile()) {
          notes.push({ code: "not_file", path: candidate.path });
          continue;
        }
        operation = "access";
        await access(candidate.path, constants.X_OK);
        operation = "resolve";
        const resolvedPath = await realpath(candidate.path);
        return { status: "found", ...candidate, resolvedPath, notes };
      } catch (error: unknown) {
        const code = errno(error);
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP")
          notes.push({ code: "not_found", path: candidate.path });
        else if ((code === "EACCES" || code === "EPERM") && operation === "access")
          notes.push({ code: "not_executable", path: candidate.path });
        else
          notes.push({ code: "inaccessible", path: candidate.path });
      }
    }
    return {
      status: notes.some((note) => note.code !== "not_found") ? "unavailable" : "missing",
      notes,
    };
  }
}
