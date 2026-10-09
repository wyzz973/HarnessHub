import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
  readonly manifest?: string;
  readonly searchDirs: readonly string[];
  readonly packageRoots: readonly string[];
  readonly pathOnly: boolean;
}

/** Shared CLI composition; callers receive one immutable catalog and its read-only observations. */
export async function inventory(input: InventoryInput): Promise<{
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
  const search = await discoverSearchDirectories({
    path: process.env.PATH ?? "", home: homedir(), extra: input.searchDirs,
    pathOnly: input.pathOnly, environment: process.env,
  });
  const enumerator = new LocalInstallationEnumerator(search.directories);
  const service = new DiscoverInventory(
    enumerator, new LocalInstalledPackageResolver(input.packageRoots, enumerator),
    new LocalConfigurationLocator(homedir()), () => new Date(),
  );
  return {
    definitions, report: await service.execute(definitions, manifest.overrides, manifest.installationOverrides),
    searchDiagnostics: search.diagnostics,
    searchPath: search.directories.map((directory) => directory.path).join(":") ,
  };
}
