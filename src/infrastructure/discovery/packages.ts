import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { InstallationEnumerator, InventoryDiagnostic, LocalPackageObservation, LocalPackageResolver, PackageIdentity } from "../../contexts/catalog/domain/catalog.js";
import { DiscoveryInputError } from "../../contexts/catalog/domain/discovery.js";

const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_PACKAGE_ROOTS = 64;
/** An executable's package.json is searched this many directories up from the resolved bin. */
const MAX_PACKAGE_DEPTH = 6;
/** Launcher scripts and shebang lines are read only this far. */
const MAX_LAUNCHER_BYTES = 4096;
const MAX_METADATA_BYTES = 64 * 1024;
/** Directory entries examined in one site-packages directory. */
const MAX_SITE_ENTRIES = 8192;

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errno(error: unknown): string | undefined {
  return record(error) && typeof error.code === "string" ? error.code : undefined;
}

async function packageJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const information = await file.stat();
    if (!information.isFile() || information.size > MAX_PACKAGE_BYTES) throw new Error("package.json must be an ordinary bounded file");
    const bytes = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_PACKAGE_BYTES) throw new Error("package.json exceeds the limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))) as unknown;
  } finally { await file.close(); }
}

/** The start of a regular file as text, or null when the path is not a regular file. */
async function head(path: string, limit: number): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const information = await file.stat();
    if (!information.isFile()) return null;
    const bytes = Buffer.alloc(Math.min(limit, information.size));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

/** The interpreter a script names on its `#!` line (`/usr/bin/env bash` names `bash`), or null. */
function interpreter(text: string): string | null {
  const line = text.startsWith("#!") ? text.slice(2).split("\n", 1)[0]!.trim() : "";
  const parts = line.split(/\s+/u).filter(Boolean);
  return (parts[0] === "/usr/bin/env" ? parts[1] : parts[0]) ?? null;
}

/**
 * The virtual environment a Python console script runs in, read from its interpreter line. An installer's launcher
 * (Hermes's official installer writes one) is a short shell script whose only job is `exec "<console script>" "$@"`;
 * one such hop is followed. Nothing is executed.
 */
async function pythonEnvironment(executable: string): Promise<string | null> {
  let current = executable;
  for (let hop = 0; hop < 2; hop++) {
    const text = await head(current, MAX_LAUNCHER_BYTES);
    if (text === null) return null;
    const named = interpreter(text);
    if (named !== null && isAbsolute(named) && /^python[0-9.]*$/u.test(basename(named))) {
      const root = dirname(dirname(named));
      try { return (await stat(join(root, "pyvenv.cfg"))).isFile() ? root : null; }
      catch (error: unknown) { if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") return null; throw error; }
    }
    if (named === null || !["sh", "bash", "zsh"].includes(basename(named))) return null;
    const target = /^[ \t]*exec[ \t]+"?(\/[^"\s]+)"?[ \t]+"\$@"[ \t]*$/mu.exec(text)?.[1];
    if (target === undefined) return null;
    current = await realpath(target);
  }
  return null;
}

/** PEP 503 name comparison; dist-info directories spell the normalised name with underscores. */
function distribution(name: string): string { return name.toLowerCase().replace(/[-_.]+/gu, "-"); }

/** The installed version a Python distribution records in its dist-info METADATA inside the environment. */
async function pythonDistribution(environment: string, name: string): Promise<{ readonly version: string; readonly manifest: string } | null> {
  const wanted = distribution(name), prefix = wanted.replaceAll("-", "_") + "-", lib = join(environment, "lib");
  let pythons: string[];
  try { pythons = (await readdir(lib)).filter(entry => /^python3\.[0-9]+$/u.test(entry)).sort().slice(0, 8); }
  catch (error: unknown) { if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") return null; throw error; }
  for (const python of pythons) {
    const site = join(lib, python, "site-packages");
    let entries: string[];
    try { entries = (await readdir(site)).slice(0, MAX_SITE_ENTRIES); }
    catch (error: unknown) { if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") continue; throw error; }
    for (const entry of entries.filter(entry => entry.toLowerCase().startsWith(prefix) && entry.endsWith(".dist-info"))) {
      const manifest = join(site, entry, "METADATA");
      let text: string | null;
      try { text = await head(manifest, MAX_METADATA_BYTES); }
      catch (error: unknown) { if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") continue; throw error; }
      const declared = text === null ? undefined : /^Name:[ \t]*(\S.*?)[ \t]*$/mu.exec(text)?.[1], version = text === null ? undefined : /^Version:[ \t]*(\S+)[ \t]*$/mu.exec(text)?.[1];
      if (declared !== undefined && version !== undefined && distribution(declared) === wanted && version.length <= 128) return { version, manifest };
    }
  }
  return null;
}

/** The npm package whose declared bin is this executable: its package.json is found walking up from the resolved bin. */
async function npmPackage(executable: string, identity: PackageIdentity): Promise<{ readonly version: string; readonly manifest: string } | null> {
  const resolved = await realpath(executable);
  let directory = dirname(resolved);
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH; depth++) {
    const manifest = join(directory, "package.json");
    try {
      const value = await packageJson(manifest);
      if (record(value) && value.name === identity.name && typeof value.version === "string" && value.version && value.version.length <= 128 && !/[\0\r\n]/u.test(value.version)) {
        const bins = typeof value.bin === "string" ? [value.bin] : record(value.bin) ? Object.values(value.bin).filter((bin): bin is string => typeof bin === "string") : [];
        for (const bin of bins) {
          if (isAbsolute(bin) || bin.length > 4096) continue;
          try { if (await realpath(join(directory, bin)) === resolved) return { version: value.version, manifest }; }
          catch (error: unknown) { if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") throw error; }
        }
        return null;
      }
    } catch (error: unknown) {
      if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR" && !(error instanceof SyntaxError) && !(error instanceof Error && /package\.json/u.test(error.message))) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** Resolve only a package already present in an explicit root; never runs npm/npx/uvx. */
export class LocalInstalledPackageResolver implements LocalPackageResolver {
  constructor(private readonly packageRoots: readonly string[], private readonly enumerator: InstallationEnumerator) {
    if (packageRoots.length > MAX_PACKAGE_ROOTS) throw new DiscoveryInputError("too many package roots");
    for (const root of packageRoots) enumerator.validateOverride(root);
  }

  async resolve(identity: PackageIdentity): Promise<LocalPackageObservation> {
    const diagnostics: InventoryDiagnostic[] = [];
    if (identity.kind === "python") {
      // A filename or an installed uvx does not establish Python distribution identity/version.
      const observation = identity.binNames.length ? await this.enumerator.enumerate(identity.binNames) : null;
      diagnostics.push(...(observation?.diagnostics ?? []));
      diagnostics.push({ code: "package_invalid", path: identity.name, detail: "Python distribution identity/version is not verified by an executable name; explicit control entry may be supplied" });
      return { command: null, diagnostics };
    }
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(identity.name) || identity.name.length > 128)
      throw new DiscoveryInputError("invalid npm package identity");
    if (!identity.version || identity.version.length > 128 || /[\0\r\n]/u.test(identity.version))
      throw new DiscoveryInputError("invalid npm package version");
    if (identity.binNames.length > 32)
      throw new DiscoveryInputError("npm package must declare bounded bin identities");
    for (const name of identity.binNames) if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(name))
      throw new DiscoveryInputError("invalid npm executable identity");
    const runtime = await this.enumerator.enumerate(["node"]);
    if (!runtime.selected) {
      return { command: null, diagnostics: [...runtime.diagnostics, { code: "runtime_missing", path: "node", detail: runtime.defaultResolution === "blocked" ? "default Node entry is blocked" : "Node entry was not found" }] };
    }
    const seen = new Set<string>();
    for (const root of this.packageRoots) {
      let realRoot: string;
      try { realRoot = await realpath(root); }
      catch (error: unknown) {
        if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") diagnostics.push({ code: "inaccessible", path: root });
        continue;
      }
      for (const directory of [join(root, "node_modules", identity.name), join(root, identity.name)]) {
        if (seen.has(directory)) continue;
        seen.add(directory);
        const manifest = join(directory, "package.json");
        try {
          const realDirectory = await realpath(directory);
          if (!inside(realRoot, realDirectory)) throw new Error("package directory resolves outside its declared root");
          const value = await packageJson(manifest);
          if (!record(value) || value.name !== identity.name || typeof value.version !== "string" || !value.version || value.version.length > 128 || /[\0\r\n]/u.test(value.version))
            throw new Error("package name/version is not a valid observed identity");
          const declaredBins = value.bin;
          const soleBin = record(declaredBins) && Object.keys(declaredBins).length === 1 ? Object.values(declaredBins)[0] : undefined;
          const candidates: string[] = typeof declaredBins === "string"
            ? (identity.binNames.length === 0 || identity.binNames.includes(identity.name.split("/").at(-1) ?? "") ? [declaredBins] : [])
            : record(declaredBins)
              ? identity.binNames.length > 0
                ? identity.binNames.flatMap((name) => typeof declaredBins[name] === "string" ? [declaredBins[name]] : [])
                : typeof soleBin === "string" ? [soleBin] : []
              : [];
          if (candidates.length === 0) throw new Error("package.json has no matching bin identity");
          for (const bin of candidates) {
            if (!bin || bin.length > 4096 || isAbsolute(bin) || /[\0\r\n]/u.test(bin))
              throw new Error("package bin is not a bounded relative path");
            const binPath = join(realDirectory, bin);
            if (!inside(realDirectory, binPath)) throw new Error("package bin escapes its package directory");
            const resolvedBin = await realpath(binPath);
            if (!inside(realDirectory, resolvedBin)) throw new Error("package bin link escapes its package directory");
            if (!(await stat(resolvedBin)).isFile()) throw new Error("package bin is not an ordinary file");
            await access(resolvedBin, constants.R_OK);
            diagnostics.push({ code: "package_version_observed", path: manifest, detail: "installed=" + value.version + "; catalog-reference=" + identity.version + "; protocol not probed" });
            return { command: { executable: runtime.selected.path, args: [resolvedBin], env: {} }, diagnostics, packageVersion: value.version };
          }
        } catch (error: unknown) {
          if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR")
            diagnostics.push({ code: "package_invalid", path: manifest, detail: error instanceof Error ? error.message : "package could not be validated" });
        }
      }
    }
    diagnostics.push({ code: "not_found", path: identity.name, detail: "package/bin not found inside declared package roots" });
    return { command: null, diagnostics };
  }

  async observe(identity: PackageIdentity, executable: string): Promise<readonly InventoryDiagnostic[]> {
    if (!isAbsolute(executable)) return [];
    try {
      const found = identity.kind === "npm" ? await npmPackage(executable, identity)
        : await (async () => { const environment = await pythonEnvironment(executable); return environment === null ? null : pythonDistribution(environment, identity.name); })();
      return found === null ? [] : [{ code: "package_version_observed", path: found.manifest, detail: "installed=" + found.version + "; catalog-reference=" + identity.version + "; installed package metadata; protocol not probed" }];
    } catch (error: unknown) {
      if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR" || errno(error) === "EACCES" || errno(error) === "EPERM") return [];
      return [{ code: "package_invalid", path: identity.name, detail: "installed package metadata could not be read" }];
    }
  }
}
