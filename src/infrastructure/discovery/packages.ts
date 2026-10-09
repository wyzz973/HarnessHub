import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { InstallationEnumerator, InventoryDiagnostic, LocalPackageObservation, LocalPackageResolver, PackageIdentity } from "../../contexts/catalog/domain/catalog.js";
import { DiscoveryInputError } from "../../contexts/catalog/domain/discovery.js";

const MAX_PACKAGE_BYTES = 64 * 1024;
const MAX_PACKAGE_ROOTS = 64;

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
}
