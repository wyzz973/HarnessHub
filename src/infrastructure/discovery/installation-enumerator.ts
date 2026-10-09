import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type {
  InstallationCandidate, InstallationEntry, InstallationEnumeration, InstallationEnumerator,
  InventoryDiagnostic,
} from "../../contexts/catalog/domain/catalog.js";
import { DiscoveryInputError } from "../../contexts/catalog/domain/discovery.js";
import { MAX_SEARCH_DIRECTORIES, type InventorySearchDirectory } from "./search.js";

function errno(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

interface InspectedEntry {
  readonly observed: boolean;
  readonly resolvedPath: string | null;
  readonly diagnostic: InventoryDiagnostic | null;
}

async function inspect(path: string): Promise<InspectedEntry> {
  let observed = false;
  let operation: "stat" | "access" | "resolve" = "stat";
  try {
    await lstat(path);
    observed = true;
    const information = await stat(path);
    if (!information.isFile()) return { observed, resolvedPath: null, diagnostic: { code: "not_file", path } };
    operation = "access";
    await access(path, constants.X_OK);
    operation = "resolve";
    return { observed, resolvedPath: await realpath(path), diagnostic: null };
  } catch (error: unknown) {
    const errorCode = errno(error);
    const missing = errorCode === "ENOENT" || errorCode === "ENOTDIR" || errorCode === "ELOOP";
    return {
      observed: observed || !missing,
      resolvedPath: null,
      diagnostic: {
        code: missing ? "not_found" : operation === "access" && (errorCode === "EACCES" || errorCode === "EPERM")
          ? "not_executable" : "inaccessible",
        path,
        ...(observed && missing ? { detail: "entry exists but its target cannot be resolved" } : {}),
      },
    };
  }
}

/** Enumerate existing entries without launching them. A blocked default never selects a fallback. */
export class LocalInstallationEnumerator implements InstallationEnumerator {
  constructor(private readonly directories: readonly InventorySearchDirectory[]) {
    if (directories.length > MAX_SEARCH_DIRECTORIES) throw new DiscoveryInputError("too many search directories");
    for (const directory of directories) this.validateOverride(directory.path);
  }

  validateOverride(path: string): void {
    if (!isAbsolute(path) || path.length > 4096 || path.includes("\0"))
      throw new DiscoveryInputError("explicit executable paths must be bounded absolute paths");
  }

  async enumerate(names: readonly string[], override?: string): Promise<InstallationEnumeration> {
    if (names.length > 32 || new Set(names).size !== names.length)
      throw new DiscoveryInputError("executable names must be a unique bounded list");
    for (const name of names) if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(name))
      throw new DiscoveryInputError("invalid executable name");
    if (override !== undefined) this.validateOverride(override);
    const diagnostics: InventoryDiagnostic[] = [];
    const entries: InstallationEntry[] = override === undefined
      ? this.directories.flatMap((directory) => names.map((name) => ({ path: join(directory.path, name), source: directory.source, name })))
      : [{ path: override, source: "override", name: names[0] ?? basename(override) }];
    const byCanonical = new Map<string, { readonly first: InstallationEntry; readonly entries: InstallationEntry[] }>();
    let defaultResolution: InstallationEnumeration["defaultResolution"] = "none";
    let selectedCanonical: string | null = null;
    let firstCanonical: string | null = null;
    for (const entry of entries) {
      const result = await inspect(entry.path);
      if (result.diagnostic && (result.observed || override !== undefined)) diagnostics.push(result.diagnostic);
      const isDefaultScope = entry.source === "path" || entry.source === "override";
      if (isDefaultScope && defaultResolution === "none" && (result.observed || override !== undefined)) {
        defaultResolution = result.resolvedPath === null ? "blocked" : "located";
        selectedCanonical = result.resolvedPath;
      }
      if (result.resolvedPath !== null) {
        firstCanonical ??= result.resolvedPath;
        const existing = byCanonical.get(result.resolvedPath);
        if (existing) existing.entries.push(entry);
        else byCanonical.set(result.resolvedPath, { first: entry, entries: [entry] });
      }
    }
    if (byCanonical.size === 0 && diagnostics.length === 0)
      for (const name of names) diagnostics.push({ code: "not_found", path: name, detail: "not found in the enumerated directories" });
    const candidates: InstallationCandidate[] = [...byCanonical].map(([resolvedPath, value]) => ({
      path: value.first.path, resolvedPath, source: value.first.source, entries: value.entries,
    }));
    const selectedPath = defaultResolution === "blocked" ? null : selectedCanonical ?? firstCanonical;
    const selected = candidates.find((candidate) => candidate.resolvedPath === selectedPath) ?? null;
    return { candidates, selected, defaultResolution, diagnostics };
  }
}
