// SPDX-License-Identifier: MIT
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The runtime assets of this package: plain JavaScript programs in `assets/`
 * that engine commands run by path (the portable launcher, the fixed engine
 * launchers and their Windows spawn helper) and the Pi extension that Pi loads
 * by path. Each is named by its path below `assets/`, which was also its path
 * below the repository's `scripts/` until they moved here (ADR 0017,
 * addendum). They are not compiled, so these paths hold without a build.
 */
const ASSETS = {
  "launch-engine.mjs": new URL(
    "../../assets/launch-engine.mjs",
    import.meta.url,
  ),
  "spawn-engine.mjs": new URL("../../assets/spawn-engine.mjs", import.meta.url),
  "launch-dsh-acp.mjs": new URL(
    "../../assets/launch-dsh-acp.mjs",
    import.meta.url,
  ),
  "launch-openclaw-acp.mjs": new URL(
    "../../assets/launch-openclaw-acp.mjs",
    import.meta.url,
  ),
  "launch-opencode-acp.mjs": new URL(
    "../../assets/launch-opencode-acp.mjs",
    import.meta.url,
  ),
  "launch-pi-acp.mjs": new URL(
    "../../assets/launch-pi-acp.mjs",
    import.meta.url,
  ),
  "native-mcp/pi-extension.mjs": new URL(
    "../../assets/native-mcp/pi-extension.mjs",
    import.meta.url,
  ),
} as const satisfies Record<string, URL>;

/** Name of a runtime asset: its path below `assets/`. */
export type AssetName = keyof typeof ASSETS;

/** Every runtime asset of this package. */
export const ASSET_NAMES = Object.keys(ASSETS) as AssetName[];

/** Absolute path of a runtime asset of this package. */
export function assetPath(name: AssetName): string {
  return fileURLToPath(ASSETS[name]);
}

/** This package's directory, `packages/agents` of its checkout. */
const PACKAGE_DIRECTORY = path.dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

const samePath = (left: string, right: string) =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

/**
 * Whether `argument` is the absolute path `<checkout>/<relative>` of the
 * checkout this package belongs to, the one whose `packages/agents` it is.
 * Records saved before files moved into packages store such paths. The
 * checkout is derived from the argument and confirmed by this package's own
 * location, so no path outside the package is computed or read; a path in
 * another checkout does not match. Paths compare after resolution, and without
 * regard to case on Windows.
 *
 * @param argument A stored command or MCP argument.
 * @param relative Slash-separated path below the checkout's root.
 */
export function namesCheckoutFile(argument: string, relative: string): boolean {
  if (!path.isAbsolute(argument)) return false;
  const file = path.resolve(argument);
  const parts = relative.split("/");
  const checkout = path.resolve(file, ...parts.map(() => ".."));
  return (
    samePath(path.join(checkout, ...parts), file) &&
    samePath(path.join(checkout, "packages", "agents"), PACKAGE_DIRECTORY)
  );
}

/**
 * The asset's current path for an argument that names a runtime asset where
 * it was before the move, `<checkout>/scripts/<name>` (namesCheckoutFile); the
 * argument itself otherwise. Engine commands registered before the move keep
 * that path in SQLite, as do copies of the former example configurations; the
 * stored records are not rewritten.
 */
export function currentAssetPath(argument: string): string {
  const name = ASSET_NAMES.find((asset) =>
    namesCheckoutFile(argument, `scripts/${asset}`),
  );
  return name === undefined ? argument : assetPath(name);
}

/**
 * A stored engine command with every argument that names a moved runtime
 * asset replaced by the asset's current path (currentAssetPath). Configuration
 * preparation and installation inspection read commands through it; the
 * stored command is unchanged.
 */
export function currentEngineCommand(command: readonly string[]): string[] {
  return command.map(currentAssetPath);
}
