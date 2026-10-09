import { DiscoveryInputError, parseDiscoveryManifest, type DiscoveryManifest } from "./discovery.js";
import { MAX_CONTROLS, MAX_DEFINITIONS, type CatalogManifest, type CatalogSource, type ControlRecipe, type DistributionMetadata, type HarnessDefinition, type PackageIdentity } from "./catalog.js";

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DiscoveryInputError(field + " must be an object");
  return value as Record<string, unknown>;
}

function keys(item: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(item).some((key) => !allowed.includes(key)))
    throw new DiscoveryInputError(field + " contains an unknown field");
}

function text(value: unknown, field: string, max = 512, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || /[\0\r\n]/u.test(value))
    throw new DiscoveryInputError(field + " must be a bounded string");
  return value;
}

function id(value: unknown, field: string): string {
  const result = text(value, field, 96);
  if (!/^[a-z][a-z0-9-]*$/u.test(result)) throw new DiscoveryInputError(field + " must be a lowercase identifier");
  return result;
}

function executable(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(result))
    throw new DiscoveryInputError(field + " must be an executable name, not a path or shell command");
  return result;
}

function list<T>(value: unknown, field: string, max: number, parse: (item: unknown, field: string) => T, unique = true): readonly T[] {
  if (!Array.isArray(value) || value.length > max) throw new DiscoveryInputError(field + " must be a bounded array");
  const result = value.map((item: unknown) => parse(item, field + "[]"));
  if (unique && new Set(result).size !== result.length) throw new DiscoveryInputError(field + " contains duplicate values");
  return result;
}

function relativePath(value: unknown, field: string): string {
  const result = text(value, field, 4096);
  const segments = result.split("/");
  if (result.startsWith("/") || result.includes("\\") || /^[A-Za-z]:/u.test(result) ||
      segments.some((part) => part === ".." || part === "") || segments.every((part) => part === "."))
    throw new DiscoveryInputError(field + " must be a bounded relative path without traversal");
  return result;
}

function url(value: unknown, field: string): string {
  const result = text(value, field, 4096);
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new DiscoveryInputError(field + " must be an HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new DiscoveryInputError(field + " must be an HTTPS URL");
  return result;
}

function source(value: unknown): CatalogSource {
  const item = object(value, "control.source");
  keys(item, ["repository", "revision", "upstreamId", "url"], "control.source");
  const location = text(item.url, "source.url", 4096);
  const repository = text(item.repository, "source.repository", 256);
  const revision = text(item.revision, "source.revision", 128);
  const localLegacySource = repository === "operator-manifest" && revision === "v1" && location === "urn:harnessgateway:operator-manifest:v1";
  if (!localLegacySource) url(location, "source.url");
  return { repository, revision, upstreamId: id(item.upstreamId, "source.upstreamId"), url: location };
}

function environment(value: unknown): Readonly<Record<string, string>> {
  const item = object(value, "control.env");
  if (Object.keys(item).length > 32) throw new DiscoveryInputError("control.env has too many variables");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(item)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key)) throw new DiscoveryInputError("invalid environment key");
    result[key] = text(value, "control.env[]", 4096, true);
  }
  return result;
}

function packageIdentity(value: unknown): PackageIdentity | null {
  if (value === null) return null;
  const item = object(value, "control.package");
  keys(item, ["kind", "name", "version", "binNames"], "control.package");
  if (item.kind !== "npm" && item.kind !== "python") throw new DiscoveryInputError("unsupported package kind");
  const name = text(item.name, "package.name", 256);
  const pattern = item.kind === "npm" ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u : /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
  if (!pattern.test(name)) throw new DiscoveryInputError("invalid package name");
  return { kind: item.kind, name, version: text(item.version, "package.version", 128), binNames: list(item.binNames, "package.binNames", 16, executable) };
}

function distribution(value: unknown): DistributionMetadata | null {
  if (value === null) return null;
  const item = object(value, "control.distribution");
  keys(item, ["kind", "packageSpec", "archive", "relativeExecutable", "sha256"], "control.distribution");
  if (item.kind !== "binary" && item.kind !== "npm" && item.kind !== "python") throw new DiscoveryInputError("unsupported distribution kind");
  if (item.kind === "binary") {
    if (item.packageSpec !== undefined) throw new DiscoveryInputError("binary distribution cannot name a package");
    const hash = item.sha256 === undefined ? undefined : text(item.sha256, "distribution.sha256", 64);
    if (hash !== undefined && !/^[a-fA-F0-9]{64}$/u.test(hash)) throw new DiscoveryInputError("invalid archive sha256");
    return { kind: "binary", archive: url(item.archive, "distribution.archive"), relativeExecutable: relativePath(item.relativeExecutable, "distribution.relativeExecutable"), ...(hash === undefined ? {} : { sha256: hash }) };
  }
  if (item.archive !== undefined || item.relativeExecutable !== undefined || item.sha256 !== undefined)
    throw new DiscoveryInputError("package distribution contains binary fields");
  return { kind: item.kind, packageSpec: text(item.packageSpec, "distribution.packageSpec", 384) };
}

function control(value: unknown): ControlRecipe {
  const item = object(value, "control");
  keys(item, ["id", "protocol", "executableNames", "args", "env", "package", "distribution", "requiredExecutables", "source"], "control");
  if (item.protocol !== "acp-v1" && item.protocol !== "codex-app-server" && item.protocol !== "pi-rpc") throw new DiscoveryInputError("unsupported control protocol");
  const recipe: ControlRecipe = {
    id: id(item.id, "control.id"), protocol: item.protocol,
    executableNames: list(item.executableNames, "control.executableNames", 16, executable),
    args: list(item.args, "control.args", 32, (value, field) => text(value, field, 4096, true), false),
    env: environment(item.env), package: packageIdentity(item.package), distribution: distribution(item.distribution),
    requiredExecutables: list(item.requiredExecutables, "control.requiredExecutables", 16, executable), source: source(item.source),
  };
  if (recipe.executableNames.length === 0 && recipe.package === null && recipe.distribution === null)
    throw new DiscoveryInputError("control needs a local entry or distribution identity");
  if (recipe.package !== null && recipe.distribution !== null && recipe.package.kind !== recipe.distribution.kind)
    throw new DiscoveryInputError("package and distribution kinds differ");
  return recipe;
}

function definition(value: unknown): HarnessDefinition {
  const item = object(value, "definition");
  keys(item, ["id", "name", "aliases", "binaryNames", "configHints", "controls"], "definition");
  return { id: id(item.id, "definition.id"), name: text(item.name, "definition.name", 128), aliases: list(item.aliases, "definition.aliases", 16, id), binaryNames: list(item.binaryNames, "definition.binaryNames", 16, executable), configHints: list(item.configHints, "definition.configHints", 16, relativePath), controls: list(item.controls, "definition.controls", 16, (value) => control(value)) };
}

/** Validate public identities and aliases before any installation lookup. */
export function validateDefinitions(definitions: readonly HarnessDefinition[]): void {
  if (definitions.length > MAX_DEFINITIONS) throw new DiscoveryInputError("too many Harness definitions");
  const names = new Set<string>();
  const controls = new Set<string>();
  for (const input of definitions) {
    const item = definition(input);
    for (const name of [item.id, ...item.aliases]) {
      if (names.has(name)) throw new DiscoveryInputError("duplicate Harness id or alias: " + name);
      names.add(name);
    }
    for (const entry of item.controls) {
      if (controls.has(entry.id)) throw new DiscoveryInputError("duplicate control id: " + entry.id);
      controls.add(entry.id);
    }
  }
  if (controls.size > MAX_CONTROLS) throw new DiscoveryInputError("too many control entries");
}

function absolutePath(value: unknown, field: string): string {
  const result = text(value, field, 4096);
  if (!result.startsWith("/")) throw new DiscoveryInputError(field + " must be absolute");
  return result;
}

/** Parse a strict v2 manifest; callers validate v1 with its original parser before migration. */
export function parseCatalogManifest(value: unknown): CatalogManifest {
  const item = object(value, "manifest");
  keys(item, ["version", "definitions", "overrides", "installationOverrides"], "manifest");
  if (item.version !== 2) throw new DiscoveryInputError("manifest.version must be 2");
  const definitions = list(item.definitions === undefined ? [] : item.definitions, "manifest.definitions", MAX_DEFINITIONS, (value) => definition(value));
  validateDefinitions(definitions);
  const rawOverrides = object(item.overrides === undefined ? {} : item.overrides, "manifest.overrides");
  if (Object.keys(rawOverrides).length > MAX_CONTROLS) throw new DiscoveryInputError("too many control overrides");
  const overrides = new Map<string, { readonly executable: string }>();
  for (const [key, value] of Object.entries(rawOverrides)) {
    id(key, "override control id");
    const entry = object(value, "override"); keys(entry, ["executable"], "override");
    const executable = absolutePath(entry.executable, "override.executable");
    overrides.set(key, { executable });
  }
  const rawInstallations = object(item.installationOverrides === undefined ? {} : item.installationOverrides, "manifest.installationOverrides");
  if (Object.keys(rawInstallations).length > MAX_DEFINITIONS) throw new DiscoveryInputError("too many installation overrides");
  const installationOverrides = new Map<string, string>();
  for (const [key, value] of Object.entries(rawInstallations)) {
    id(key, "installation override product id");
    installationOverrides.set(key, absolutePath(value, "installation override"));
  }
  return { version: 2, definitions, overrides, installationOverrides };
}

/** Migrate data only; no package runner or implicit shell is introduced. */
export function migrateLegacyManifest(manifest: DiscoveryManifest, base: readonly HarnessDefinition[]): CatalogManifest {
  // Reuse the original input boundary even when a programmatic caller supplied this typed object.
  const checked = parseDiscoveryManifest({ version: 1, recipes: manifest.recipes, overrides: Object.fromEntries(manifest.overrides) });
  validateDefinitions(base);
  const definitions: HarnessDefinition[] = checked.recipes.map((recipe) => ({
    id: recipe.id, name: recipe.name, aliases: [], binaryNames: [recipe.binary], configHints: [],
    controls: [{ id: recipe.id + "-legacy", protocol: recipe.protocol, executableNames: [recipe.adapterBinary ?? recipe.binary], args: recipe.args,
      env: {}, package: null, distribution: null, requiredExecutables: recipe.adapterBinary !== undefined && recipe.nativeRequired !== false ? [recipe.binary] : [],
      source: { repository: "operator-manifest", revision: "v1", upstreamId: recipe.id, url: "urn:harnessgateway:operator-manifest:v1" } }],
  }));
  validateDefinitions(definitions);
  const allDefinitions = [...base, ...definitions];
  validateDefinitions(allDefinitions);
  const overrides = new Map<string, { readonly executable: string }>();
  const installationOverrides = new Map<string, string>();
  for (const [recipeId, override] of checked.overrides) {
    if (override.binary !== undefined) installationOverrides.set(recipeId, absolutePath(override.binary, "legacy binary override"));
    if (override.adapter !== undefined) absolutePath(override.adapter, "legacy adapter override");
    const target = allDefinitions.find((item) => item.id === recipeId || item.aliases.includes(recipeId));
    if (target === undefined) throw new DiscoveryInputError("unknown Harness override: " + recipeId);
    const custom = checked.recipes.find((item) => item.id === recipeId);
    const usesAdapter = custom?.adapterBinary !== undefined || (custom === undefined && recipeId === "claude");
    if (override.adapter !== undefined && !usesAdapter) throw new DiscoveryInputError("unused adapter override: " + recipeId);
    const candidates = target.controls.filter((entry) => custom !== undefined ? entry.id === recipeId + "-legacy" :
      recipeId === "codex" ? entry.protocol === "codex-app-server" : recipeId === "pi" ? entry.protocol === "pi-rpc" : entry.protocol === "acp-v1");
    const chosen = candidates.find((entry) => recipeId === "claude" ? entry.executableNames.includes("claude-agent-acp") : entry.executableNames.some((name) => target.binaryNames.includes(name))) ?? candidates[0];
    if (chosen === undefined) throw new DiscoveryInputError("legacy Harness has no matching control: " + recipeId);
    const executable = usesAdapter ? override.adapter : override.binary;
    if (executable !== undefined) overrides.set(chosen.id, { executable });
    if (override.binary !== undefined && target.id !== recipeId) {
      installationOverrides.delete(recipeId); installationOverrides.set(target.id, override.binary);
    }
  }
  return { version: 2, definitions, overrides, installationOverrides };
}
