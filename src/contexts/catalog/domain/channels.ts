/**
 * Official installation channels (ADR-044): a product counts as installed only when a found program lies in one of the
 * channels its official documentation describes for macOS. Everything here is pure; callers resolve paths first.
 */
export type ChannelKind = "npm" | "brew-formula" | "brew-cask" | "script" | "uv" | "pnpm" | "bun";
/** Channels HarnessHub lists but does not maintain yet: an official package installed globally by pnpm or bun (ADR-044). */
export const UNMAINTAINED_CHANNELS: ReadonlySet<ChannelKind> = new Set(["pnpm", "bun"]);

/** An official script installation: the directory it owns, and launchers it writes elsewhere that start a program inside it. */
export interface ScriptLayout {
  /** The directory the official installer owns, relative to the user's home. */
  readonly root: string;
  /** Launchers the installer writes outside the root (home-relative), each starting `program` inside the root. */
  readonly launchers: readonly string[];
  /** The program a launcher starts, relative to the root; null when the installer writes no launcher. */
  readonly program: string | null;
  /** What removing the program deletes (ADR-044); null when HarnessHub does not uninstall this layout. */
  readonly removal: ScriptRemoval | null;
}
/**
 * Exactly what an official installer writes, for removing the program and nothing else (ADR-044). Paths are relative to
 * the user's home. Configuration, sign-in and session data are never listed.
 */
export interface ScriptRemoval {
  /** Links the installer writes outside its directories; each is removed only while it points into one of `directories`. */
  readonly links: readonly string[];
  /** Launcher scripts it writes; each is removed only while it starts a program inside one of `directories`. */
  readonly launchers: readonly string[];
  /** Single files it writes into a directory it does not own alone; removed one by one. */
  readonly files: readonly string[];
  /** Directories it owns, removed whole. */
  readonly directories: readonly string[];
  /** Directories it creates for its files, removed only once empty. */
  readonly emptyDirectories: readonly string[];
  /** Whether the product's official page gives this removal; false when it is read from the installer's own layout. */
  readonly documented: boolean;
}
/** A background service a product's own installation registers, with the product's commands that stop and unregister it. */
export interface ProductService {
  /** Its launchd label. */
  readonly label: string;
  readonly name: string;
  /** Argument lists run in order with the product's own command from the installation being removed. */
  readonly stop: readonly (readonly string[])[];
  /** What stopping it interrupts, said before anything runs. */
  readonly interrupts: string;
}
/** Facts about one product that removing an installation needs (ADR-044). */
export interface ProductMaintenance {
  /** Services its installation registers; a running service no product declares blocks an uninstall. */
  readonly services: readonly ProductService[];
  /** Where it keeps configuration, sign-in and session data, home-relative; kept by an uninstall and named in its confirmation. */
  readonly data: readonly string[];
  /**
   * Its resident programs as their command lines show them, and the product's command that stops each. One running when
   * an uninstall would remove its files blocks the uninstall, launched by a service manager or not.
   */
  readonly resident: readonly { readonly command: RegExp; readonly stop: string }[];
}
/** The channels a product's official documentation describes on macOS, with where the description was read. */
export interface OfficialChannels {
  readonly npm: readonly string[];
  readonly brewFormulae: readonly string[];
  readonly brewCasks: readonly string[];
  readonly scripts: readonly ScriptLayout[];
  readonly uv: readonly string[];
  /** The official page the channels were read from, and when. */
  readonly source: { readonly url: string; readonly checkedAt: string };
}
/** The official channel one found program belongs to. */
export interface InstallationChannel {
  readonly kind: ChannelKind;
  /** The npm package, Homebrew formula or cask, uv package, or the script layout's root. */
  readonly name: string;
  /** The directory the channel owns for this installation: the npm package, the keg, the script root or the uv tool. */
  readonly root: string;
  /** The npm global prefix or the Homebrew prefix the installation lives in; null for script and uv channels. */
  readonly prefix: string | null;
}
/** Where a found program is: the path it was found at and the file it resolves to. */
export interface FoundProgram { readonly path: string; readonly resolvedPath: string }

function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + "/"); }
function join(home: string, relative: string): string { return (home.endsWith("/") ? home.slice(0, -1) : home) + "/" + relative; }

/**
 * The official channel `program` belongs to, or null when it lies in none of `channels` (a source checkout, an `npm link`,
 * a copy elsewhere). Homebrew kegs are recognized before npm, since a formula may carry its own `lib/node_modules`.
 * `exists` tells whether a launcher's program is present inside its script root.
 */
export function classifyProgram(program: FoundProgram, channels: OfficialChannels, home: string, uvToolDir: string, exists: (path: string) => boolean): InstallationChannel | null {
  const path = program.resolvedPath;
  const brew = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\/[^/]+\//u.exec(path);
  if (brew) {
    const name = brew[3]!, cask = brew[2] === "Caskroom";
    if (cask ? channels.brewCasks.includes(name) : channels.brewFormulae.includes(name))
      return { kind: cask ? "brew-cask" : "brew-formula", name, root: brew[1] + "/" + brew[2] + "/" + name, prefix: brew[1]! };
    return null;
  }
  const npm = /^(.*)\/lib\/node_modules\/((?:@[^/]+\/)?[^/@.][^/]*)\//u.exec(path);
  if (npm && channels.npm.includes(npm[2]!)) return { kind: "npm", name: npm[2]!, root: npm[1] + "/lib/node_modules/" + npm[2], prefix: npm[1]! };
  // pnpm and bun keep global packages in their own directories; pnpm resolves into its virtual store.
  for (const [kind, base] of [["pnpm", join(home, "Library/pnpm")], ["pnpm", join(home, ".local/share/pnpm")], ["bun", join(home, ".bun/install/global")]] as const) {
    if (!path.startsWith(base + "/")) continue;
    const found = [...path.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/@.][^/]*)\//gu)].at(-1);
    if (found && channels.npm.includes(found[1]!)) return { kind, name: found[1]!, root: path.slice(0, found.index! + found[0].length - 1), prefix: base };
  }
  for (const layout of channels.scripts) {
    const root = join(home, layout.root);
    if (inside(path, root)) return { kind: "script", name: layout.root, root, prefix: null };
    // A launcher outside the root (a small script such as ~/.local/bin/hermes) counts when its program is in the root.
    if (layout.program !== null && layout.launchers.some(launcher => join(home, launcher) === program.path || join(home, launcher) === path) && exists(join(root, layout.program)))
      return { kind: "script", name: layout.root, root, prefix: null };
  }
  const uv = path.startsWith(uvToolDir + "/") ? path.slice(uvToolDir.length + 1).split("/", 1)[0] : undefined;
  if (uv !== undefined && channels.uv.includes(uv)) return { kind: "uv", name: uv, root: uvToolDir + "/" + uv, prefix: null };
  return null;
}
