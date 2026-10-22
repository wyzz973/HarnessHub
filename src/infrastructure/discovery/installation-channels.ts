import { stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyProgram, launcherPrograms, type InstallationChannel, type OfficialChannels, type ScriptLayout } from "../../contexts/catalog/domain/channels.js";
import type { InstallationCandidate, InstallationClassifier } from "../../contexts/catalog/domain/catalog.js";
import { homebrewTap, packageJson, placeholderVersion, pythonDistribution, recordedJson } from "./packages.js";

/** Errors that leave a file unreadable here rather than the read broken: the file counts as absent, its version unknown. */
const UNREADABLE = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"];
function errno(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error: unknown) { if (UNREADABLE.includes(errno(error) ?? "")) return false; throw error; }
}
function bounded(version: unknown): string | null {
  return typeof version === "string" && version.length > 0 && version.length <= 128 && !/[\0\r\n]/u.test(version) ? version : null;
}
/** A version an install stamp names: a bounded version string other than the 0.0.0 placeholder; null otherwise (`unknown`, `git.<sha>`). */
function stamped(value: unknown): string | null {
  return typeof value === "string" && value.length <= 128 && /^[0-9][0-9A-Za-z.+_-]*$/u.test(value) && !placeholderVersion(value) ? value : null;
}
/**
 * Where an official script layout without a versions directory records its version, by the layout's root (a minimal
 * table until the product descriptions carry it, M2). Hermes writes `install-stamp.json` into its checkout when an
 * install or update completes (`displayVersion` such as 0.22.4+3.gabc1234, else `baseVersion`; v0.22.4
 * hermes_cli/source_stamp.py); a checkout without a stamp (0.12) has the version in the dist-info of the `hermes-agent`
 * distribution in the `venv/` its former program runs from.
 */
const SCRIPT_VERSIONS: Readonly<Record<string, { readonly stamp: string; readonly distribution: string }>> = { ".hermes/hermes-agent": { stamp: "install-stamp.json", distribution: "hermes-agent" } };

/**
 * Classifies found programs into official channels (ADR-044) and reads the version each channel records: an npm, pnpm or
 * bun package's own package.json, a Homebrew keg's directory, a script layout's `versions/<version>` directory, its install
 * stamp, or the dist-info of the Python distribution a script layout keeps in its own `venv/`. A Homebrew formula or cask
 * from another tap than Homebrew's own also records that tap, read from its install receipt. It reads files only and never
 * runs a program.
 */
export class LocalInstallationClassifier implements InstallationClassifier {
  /** `uvToolDir` is uv's tool directory (`UV_TOOL_DIR`, by default under `~/.local/share/uv/tools`). */
  constructor(private readonly home: string, private readonly uvToolDir: string) {}

  async classify(candidate: InstallationCandidate, channels: OfficialChannels): Promise<{ readonly channel: InstallationChannel; readonly version: string | null } | null> {
    // A launcher counts only when a program it may start is present inside the script root; those files are checked first.
    const present = new Set<string>();
    for (const layout of channels.scripts) for (const relative of launcherPrograms(layout)) {
      const program = join(this.home, layout.root, relative);
      if (await isFile(program)) present.add(program);
    }
    const found = classifyProgram(candidate, channels, this.home, this.uvToolDir, path => present.has(path));
    if (found === null) return null;
    // Homebrew's commands must name a formula or cask from another tap in full; its bare name may find Homebrew's own.
    const tap = found.kind === "brew-formula" || found.kind === "brew-cask" ? await homebrewTap(found.kind, found.root, candidate.resolvedPath) : null;
    const channel: InstallationChannel = tap === null ? found : { ...found, tap };
    const layout = channel.kind === "script" ? channels.scripts.find(item => item.root === channel.name) : undefined;
    return { channel, version: await this.version(channel, candidate.resolvedPath, layout, present) };
  }

  private async version(channel: InstallationChannel, resolvedPath: string, layout: ScriptLayout | undefined, present: ReadonlySet<string>): Promise<string | null> {
    switch (channel.kind) {
      case "npm": case "pnpm": case "bun":
        try { const value = await packageJson(join(channel.root, "package.json")); return value !== null && typeof value === "object" && "version" in value ? bounded(value.version) : null; }
        catch { return null; }
      case "brew-formula": case "brew-cask":
        return bounded(resolvedPath.slice(channel.root.length + 1).split("/", 1)[0]);
      case "script": {
        // Installers that keep versions side by side name each directory or file after its version.
        if (channel.root.endsWith("/versions")) return resolvedPath.startsWith(channel.root + "/") ? bounded(resolvedPath.slice(channel.root.length + 1).split("/", 1)[0]) : null;
        const recorded = Object.hasOwn(SCRIPT_VERSIONS, channel.name) ? SCRIPT_VERSIONS[channel.name] : undefined;
        if (recorded === undefined || layout === undefined) return null;
        // A stamp decides when there is one: a version it does not name is unknown, whatever else lies in the checkout.
        const stamp = (await recordedJson(join(channel.root, recorded.stamp)))?.value;
        if (stamp !== null && typeof stamp === "object" && !Array.isArray(stamp))
          return stamped("displayVersion" in stamp ? stamp.displayVersion : undefined) ?? stamped("baseVersion" in stamp ? stamp.baseVersion : undefined);
        // Without one, only a layout whose present program runs from the root's own venv/ has the version in its dist-info;
        // a venv/ left beside today's program is a former layout's, and its version is not this installation's.
        const program = launcherPrograms(layout).find(relative => present.has(join(channel.root, relative)));
        if (program === undefined || !program.startsWith("venv/bin/")) return null;
        try { const distribution = await pythonDistribution(join(channel.root, "venv"), recorded.distribution); return distribution === null || placeholderVersion(distribution.version) ? null : bounded(distribution.version); }
        catch (error: unknown) { if (UNREADABLE.includes(errno(error) ?? "")) return null; throw error; }
      }
      case "uv":
        return null;
    }
  }
}
