import type { ResolvedManagedControl } from "../../contracts/management.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { loadBuiltinCatalog } from "../../adapters/catalog.js";
import { migrateLegacyManifest, parseCatalogManifest, validateDefinitions } from "../../contexts/catalog/domain/catalog-parser.js";
import { MAX_CATALOG_BYTES, type CatalogManifest, type HarnessDefinition, type InventoryReport } from "../../contexts/catalog/domain/catalog.js";
import { MAX_MANIFEST_BYTES, DiscoveryInputError, parseDiscoveryManifest } from "../../contexts/catalog/domain/discovery.js";
import { DiscoverInventory } from "../../contexts/catalog/application/inventory.js";
import { discoverSearchDirectories } from "../discovery/search.js";
import { LocalInstallationEnumerator } from "../discovery/installation-enumerator.js";
import { LocalInstalledPackageResolver } from "../discovery/packages.js";
import { LocalConfigurationLocator } from "../discovery/configuration.js";
import { catalogTarget } from "./platform.js";

export async function readJsonDocument(path: string, limit: number): Promise<{ readonly value: unknown; readonly bytes: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit)
      throw new DiscoveryInputError("manifest must be a regular file of at most " + (limit / 1024) + " KiB");
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit)
      throw new DiscoveryInputError("manifest grew beyond " + (limit / 1024) + " KiB");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))) as unknown;
    } catch {
      throw new DiscoveryInputError("manifest must contain valid UTF-8 JSON");
    }
    return { value, bytes: bytesRead };
  } finally {
    await handle.close();
  }
}

export interface InventoryInput {
  readonly environment?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly manifest?: string;
  readonly searchDirs: readonly string[];
  readonly packageRoots: readonly string[];
  readonly pathOnly: boolean;
  readonly managedResolver?: { resolveControl(harnessId: string, controlId: string): ResolvedManagedControl | null };
}

/** Shared CLI composition; callers receive one immutable catalog and its read-only observations. */
export async function inventory(input: InventoryInput): Promise<{
  readonly managedBindings: ReadonlyMap<string, ResolvedManagedControl>;
  readonly definitions: readonly HarnessDefinition[];
  readonly report: InventoryReport;
  readonly searchDiagnostics: Awaited<ReturnType<typeof discoverSearchDirectories>>["diagnostics"];
  readonly searchPath: string;
}> {
  const builtins = loadBuiltinCatalog(catalogTarget());
  if (input.manifest === "") throw new DiscoveryInputError("--manifest must name a file");
  let manifest: CatalogManifest = { version: 2, definitions: [], overrides: new Map(), installationOverrides: new Map() };
  if (input.manifest !== undefined) {
    const document = await readJsonDocument(resolve(input.manifest), MAX_CATALOG_BYTES);
    const value = document.value;
    if (value !== null && typeof value === "object" && "version" in value && value.version === 1) {
      if (document.bytes > MAX_MANIFEST_BYTES) throw new DiscoveryInputError("v1 manifest exceeds 64 KiB");
      manifest = migrateLegacyManifest(parseDiscoveryManifest(value), builtins);
    } else manifest = parseCatalogManifest(value);
  }
  const definitions = [...builtins, ...manifest.definitions];
  validateDefinitions(definitions);
  const environment = input.environment ?? process.env, home = input.home ?? homedir();
  const search = await discoverSearchDirectories({
    path: environment.PATH ?? "", home, extra: input.searchDirs,
    pathOnly: input.pathOnly, environment,
  });
  const enumerator = new LocalInstallationEnumerator(search.directories);
  const service = new DiscoverInventory(
    enumerator, new LocalInstalledPackageResolver(input.packageRoots, enumerator),
    new LocalConfigurationLocator(home), () => new Date(),
  );
  const initial = await service.execute(definitions, manifest.overrides, manifest.installationOverrides);
  const managedBindings = new Map<string, ResolvedManagedControl>();
  const report: InventoryReport = input.managedResolver === undefined ? initial : { ...initial,
    harnesses: initial.harnesses.map(harness => ({ ...harness, controls: harness.controls.map(control => {
      // User overrides remain exclusive, including invalid or blocked entries. They never fall back.
      if (manifest.overrides.has(control.id) || control.state !== "missing_dependency") return control;
      const managed = input.managedResolver!.resolveControl(harness.id, control.id);
      if (managed === null) return control;
      const path = managed.command.args[0] !== undefined && isAbsolute(managed.command.args[0]) ? managed.command.args[0] : managed.command.executable;
      const entry = { path, resolvedPath: path, source: "managed" as const, entries: [{ path, source: "managed" as const, name: control.id }] };
      managedBindings.set(control.id, managed);
      return { ...control, state: "candidate" as const, command: managed.command, missingDependencies: [],
        installation: { candidates: [entry], selected: entry, defaultResolution: "located" as const, diagnostics: [] },
        diagnostics: [{ code: "package_version_observed" as const, path, detail: "managed=" + managed.version + "; installation=" + managed.installationId }] };
    }) })) };
  return {
    managedBindings, definitions, report,
    searchDiagnostics: search.diagnostics,
    searchPath: search.directories.map((directory) => directory.path).join(":") ,
  };
}
