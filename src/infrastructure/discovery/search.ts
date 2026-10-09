import { opendir } from "node:fs/promises";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import { DiscoveryInputError } from "../../contexts/catalog/domain/discovery.js";
import type { InstallationSource, InventoryDiagnostic } from "../../contexts/catalog/domain/catalog.js";

export const MAX_SEARCH_DIRECTORIES = 128;
export const MAX_MANAGER_CHILDREN = 32;

export interface InventorySearchDirectory {
  readonly path: string;
  readonly source: InstallationSource;
}

function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !path.includes("\0") && isAbsolute(path);
}

function code(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

/** Read only fixed manager roots, with a hard child/total limit and no shell or config reads. */
export async function discoverSearchDirectories(input: {
  readonly path: string;
  readonly home: string;
  readonly extra: readonly string[];
  readonly pathOnly: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly directories: readonly InventorySearchDirectory[]; readonly diagnostics: InventoryDiagnostic[] }> {
  const directories: InventorySearchDirectory[] = [];
  const diagnostics: InventoryDiagnostic[] = [];
  const seen = new Set<string>();
  let totalLimitReported = false;
  const add = (path: string, source: InstallationSource, strict = false): void => {
    if (!path) {
      if (strict) throw new DiscoveryInputError("search directories must be absolute and non-empty");
      return;
    }
    if (!validPath(path)) {
      if (strict) throw new DiscoveryInputError("search directories must be bounded absolute paths");
      diagnostics.push({ code: "relative_path_ignored", path, detail: "invalid search directory ignored" });
      return;
    }
    const key = normalize(path);
    if (seen.has(key)) return;
    if (directories.length === MAX_SEARCH_DIRECTORIES) {
      if (!totalLimitReported) {
        diagnostics.push({ code: "scan_truncated", path: key, detail: "search directory limit reached; inventory is partial" });
        totalLimitReported = true;
      }
      return;
    }
    seen.add(key);
    directories.push({ path: key, source });
  };
  if (input.path.length > 512 * 1024) throw new DiscoveryInputError("PATH exceeds the input limit");
  if (input.extra.length > MAX_SEARCH_DIRECTORIES) throw new DiscoveryInputError("too many configured search directories");
  const pathEntries = input.path.split(delimiter);
  for (const path of pathEntries.slice(0, 512)) add(path, "path");
  if (pathEntries.length > 512) diagnostics.push({ code: "scan_truncated", path: "PATH", detail: "PATH entry limit reached; inventory is partial" });
  for (const path of input.extra) add(path, "configured-directory", true);
  if (input.pathOnly) return { directories, diagnostics };
  if (!validPath(input.home)) throw new DiscoveryInputError("home must be a bounded absolute path");
  const environmentRoot = (name: string, fallback: string): string => {
    const value = input.environment[name];
    if (value === undefined || value === "") return fallback;
    if (!validPath(value)) {
      diagnostics.push({ code: "relative_path_ignored", path: value, detail: name + " is not a bounded absolute path; using known root" });
      return fallback;
    }
    return normalize(value);
  };
  const nvm = environmentRoot("NVM_DIR", join(input.home, ".nvm"));
  const fnm = environmentRoot("FNM_DIR", join(input.home, "Library/Application Support/fnm"));
  const mise = environmentRoot("MISE_DATA_DIR", join(input.home, ".local/share/mise"));
  const volta = environmentRoot("VOLTA_HOME", join(input.home, ".volta"));
  const pnpm = environmentRoot("PNPM_HOME", join(input.home, "Library/pnpm"));
  // Only these reviewed installation variables may contribute paths; no shell/profile parsing.
  for (const name of ["OPENCODE_INSTALL_DIR", "XDG_BIN_DIR", "GROK_BIN_DIR", "MCODE_INSTALL_DIR"] as const) {
    const value = input.environment[name];
    if (value === undefined || value === "") continue;
    if (!validPath(value)) {
      diagnostics.push({ code: "relative_path_ignored", path: value, detail: name + " is not a bounded absolute path" });
      continue;
    }
    add(name === "MCODE_INSTALL_DIR" ? join(value, "bin") : value, "configured-directory");
  }
  const goPath = input.environment.GOPATH;
  if (goPath !== undefined && goPath !== "") {
    if (goPath.length > 512 * 1024) throw new DiscoveryInputError("GOPATH exceeds the input limit");
    const roots = goPath.split(delimiter);
    for (const root of roots.slice(0, 32)) {
      if (validPath(root)) add(join(root, "bin"), "configured-directory");
      else diagnostics.push({ code: "relative_path_ignored", path: root, detail: "invalid GOPATH root" });
    }
    if (roots.length > 32) diagnostics.push({ code: "scan_truncated", path: "GOPATH", detail: "GOPATH root limit reached; inventory is partial" });
  }

  for (const relative of [
    ".local/bin", ".npm-global/bin", ".npm/bin", "n/bin", ".bun/bin", ".cargo/bin", ".deno/bin",
    ".volta/bin", ".asdf/shims", ".local/share/mise/shims", "Library/pnpm", ".local/share/pnpm",
    ".opencode/bin", ".claude/local", ".grok/bin", ".minimax-code/bin", "bin", "go/bin",
  ]) add(join(input.home, relative), "known-directory");
  for (const path of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) add(path, "known-directory");
  add(join(volta, "bin"), "manager-directory");
  add(pnpm, "manager-directory");
  add(join(mise, "shims"), "manager-directory");

  const visitedRoots = new Set<string>();
  const children = async (root: string, suffix: string): Promise<void> => {
    const key = normalize(root);
    if (visitedRoots.has(key)) return;
    visitedRoots.add(key);
    if (directories.length >= MAX_SEARCH_DIRECTORIES) {
      add(join(root, "*", suffix), "manager-directory");
      return;
    }
    let count = 0;
    const names: string[] = [];
    try {
      const directory = await opendir(root, { bufferSize: MAX_MANAGER_CHILDREN });
      try {
        while (true) {
          const entry = await directory.read();
          if (entry === null) break;
          count++;
          if (count > MAX_MANAGER_CHILDREN) {
            diagnostics.push({ code: "scan_truncated", path: root, detail: "manager root child limit reached; inventory is partial" });
            break;
          }
          // No recursion through links: only immediate real version directories are enumerated.
          if (entry.isDirectory()) names.push(entry.name);
        }
      } finally {
        await directory.close();
      }
      names.sort();
      for (const name of names) add(join(root, name, suffix), "manager-directory");
    } catch (error: unknown) {
      if (code(error) !== "ENOENT" && code(error) !== "ENOTDIR")
        diagnostics.push({ code: "inaccessible", path: root, detail: "manager root could not be enumerated" });
    }
  };
  await children(join(nvm, "versions/node"), "bin");
  await children(join(fnm, "node-versions"), "installation/bin");
  await children(join(input.home, ".local/share/fnm/node-versions"), "installation/bin");
  await children(join(input.home, ".local/state/fnm_multishells"), "bin");
  await children(join(mise, "installs/node"), "bin");
  return { directories, diagnostics };
}
