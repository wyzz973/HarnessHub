export const MAX_RECIPES = 64;
export const MAX_MANIFEST_BYTES = 64 * 1024;

export type ControlProtocol = "acp-v1" | "codex-app-server" | "pi-rpc";

/** A data-only control recipe. Its presence does not prove protocol support. */
export interface HarnessRecipe {
  readonly id: string;
  readonly name: string;
  readonly binary: string;
  readonly protocol: ControlProtocol;
  readonly args: readonly string[];
  readonly adapterBinary?: string;
  /** Some wrappers provide their own runtime and do not require a global CLI. */
  readonly nativeRequired?: boolean;
}

export interface ExecutableOverride {
  readonly binary?: string;
  readonly adapter?: string;
}

export interface DiscoveryManifest {
  readonly recipes: readonly HarnessRecipe[];
  readonly overrides: ReadonlyMap<string, ExecutableOverride>;
}

export class DiscoveryInputError extends Error {
  override readonly name = "DiscoveryInputError";
}

export interface LookupNote {
  readonly code: "not_found" | "not_file" | "not_executable" | "inaccessible" | "relative_path_ignored";
  readonly path: string;
}

export type ExecutableLookup =
  | {
      readonly status: "found";
      readonly path: string;
      readonly resolvedPath: string;
      readonly source: "override" | "path" | "configured-directory" | "known-directory";
      readonly notes: readonly LookupNote[];
    }
  | {
      readonly status: "missing" | "unavailable";
      readonly notes: readonly LookupNote[];
    };

/** Read-only filesystem port. Implementations must never launch the candidate. */
export interface ExecutableLocator {
  /** Validate a configured path before any conditional lookup can skip it. */
  validateOverride(path: string): void;
  lookup(binary: string, override: string | undefined): Promise<ExecutableLookup>;
}

export interface HarnessObservation {
  readonly id: string;
  readonly name: string;
  readonly installation: ExecutableLookup;
  readonly control: {
    readonly protocol: ControlProtocol;
    readonly state: "candidate" | "adapter_missing" | "harness_missing";
    readonly command: { readonly executable: string; readonly args: readonly string[] } | null;
    readonly adapter: ExecutableLookup | null;
    readonly probe: "not_run";
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DiscoveryInputError(field + " must be an object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new DiscoveryInputError(field + " contains an unknown field");
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/u.test(value))
    throw new DiscoveryInputError(field + " must be a bounded non-empty string");
  return value;
}

function binary(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(result))
    throw new DiscoveryInputError(field + " must be an executable name, not a path or shell command");
  return result;
}

/** Validate all recipes before any lookup. Duplicate IDs never silently replace a recipe. */
export function validateRecipes(values: readonly HarnessRecipe[]): void {
  if (values.length > MAX_RECIPES)
    throw new DiscoveryInputError("too many Harness recipes");
  const ids = new Set<string>();
  for (const recipe of values) {
    parseRecipe(recipe);
    if (ids.has(recipe.id)) throw new DiscoveryInputError("duplicate Harness id: " + recipe.id);
    ids.add(recipe.id);
  }
}

function parseRecipe(value: unknown): HarnessRecipe {
  const item = object(value, "recipe");
  keys(item, ["id", "name", "binary", "protocol", "args", "adapterBinary", "nativeRequired"], "recipe");
  const id = text(item.id, "recipe.id", 64);
  if (!/^[a-z][a-z0-9-]*$/u.test(id))
    throw new DiscoveryInputError("recipe.id must be a lowercase identifier");
  const protocol = item.protocol;
  if (protocol !== "acp-v1" && protocol !== "codex-app-server" && protocol !== "pi-rpc")
    throw new DiscoveryInputError("recipe.protocol is unsupported");
  if (!Array.isArray(item.args) || item.args.length > 32)
    throw new DiscoveryInputError("recipe.args must be an array with at most 32 arguments");
  if (item.nativeRequired !== undefined && typeof item.nativeRequired !== "boolean")
    throw new DiscoveryInputError("recipe.nativeRequired must be boolean");
  if (item.nativeRequired === false && item.adapterBinary === undefined)
    throw new DiscoveryInputError("an optional native CLI requires an external adapter entry");
  return {
    id,
    name: text(item.name, "recipe.name", 128),
    binary: binary(item.binary, "recipe.binary"),
    protocol,
    args: item.args.map((arg: unknown) => text(arg, "recipe.args[]")),
    ...(item.adapterBinary === undefined
      ? {}
      : { adapterBinary: binary(item.adapterBinary, "recipe.adapterBinary") }),
    ...(item.nativeRequired === undefined ? {} : { nativeRequired: item.nativeRequired }),
  };
}

/** Parse a versioned operator manifest as data; this parser never executes a command. */
export function parseDiscoveryManifest(value: unknown): DiscoveryManifest {
  const manifest = object(value, "manifest");
  keys(manifest, ["version", "recipes", "overrides"], "manifest");
  if (manifest.version !== 1) throw new DiscoveryInputError("manifest.version must be 1");
  const rawRecipes: unknown = manifest.recipes === undefined ? [] : manifest.recipes;
  if (!Array.isArray(rawRecipes) || rawRecipes.length > MAX_RECIPES)
    throw new DiscoveryInputError("manifest.recipes must be a bounded array");
  const recipes = rawRecipes.map(parseRecipe);
  validateRecipes(recipes);
  const rawOverrides = object(manifest.overrides === undefined ? {} : manifest.overrides, "manifest.overrides");
  if (Object.keys(rawOverrides).length > MAX_RECIPES)
    throw new DiscoveryInputError("too many executable overrides");
  const overrides = new Map<string, ExecutableOverride>();
  for (const [id, value] of Object.entries(rawOverrides)) {
    const item = object(value, "override");
    keys(item, ["binary", "adapter"], "override");
    if (item.binary === undefined && item.adapter === undefined)
      throw new DiscoveryInputError("override must name an executable");
    overrides.set(id, {
      ...(item.binary === undefined ? {} : { binary: text(item.binary, "override.binary", 4096) }),
      ...(item.adapter === undefined ? {} : { adapter: text(item.adapter, "override.adapter", 4096) }),
    });
  }
  return { recipes, overrides };
}
