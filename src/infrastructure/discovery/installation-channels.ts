import { stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyProgram, type InstallationChannel, type OfficialChannels, type ScriptLayout } from "../../contexts/catalog/domain/channels.js";
import type { InstallationCandidate, InstallationClassifier } from "../../contexts/catalog/domain/catalog.js";
import { packageJson, pythonDistribution } from "./packages.js";

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
/**
 * The Python distribution an official script layout installs into the virtual environment inside its root, by the
 * layout's root: Hermes's installer keeps `venv/` in ~/.hermes/hermes-agent with the `hermes-agent` distribution. A
 * minimal table until the product descriptions carry the name (M2).
 */
const SCRIPT_DISTRIBUTIONS: Readonly<Record<string, string>> = { ".hermes/hermes-agent": "hermes-agent" };

/**
 * Classifies found programs into official channels (ADR-044) and reads the version each channel records: an npm, pnpm or
 * bun package's own package.json, a Homebrew keg's directory, a script layout's `versions/<version>` directory, or the
 * dist-info of the Python distribution a script layout keeps in its own `venv/`. It reads files only and never runs a program.
 */
export class LocalInstallationClassifier implements InstallationClassifier {
  /** `uvToolDir` is uv's tool directory (`UV_TOOL_DIR`, by default under `~/.local/share/uv/tools`). */
  constructor(private readonly home: string, private readonly uvToolDir: string) {}

  async classify(candidate: InstallationCandidate, channels: OfficialChannels): Promise<{ readonly channel: InstallationChannel; readonly version: string | null } | null> {
    // A launcher counts only when its program is present inside the script root; those files are checked first.
    const present = new Set<string>();
    for (const layout of channels.scripts) if (layout.program !== null) {
      const program = join(this.home, layout.root, layout.program);
      if (await isFile(program)) present.add(program);
    }
    const channel = classifyProgram(candidate, channels, this.home, this.uvToolDir, path => present.has(path));
    if (channel === null) return null;
    const layout = channel.kind === "script" ? channels.scripts.find(item => item.root === channel.name) : undefined;
    return { channel, version: await this.version(channel, candidate.resolvedPath, layout) };
  }

  private async version(channel: InstallationChannel, resolvedPath: string, layout: ScriptLayout | undefined): Promise<string | null> {
    switch (channel.kind) {
      case "npm": case "pnpm": case "bun":
        try { const value = await packageJson(join(channel.root, "package.json")); return value !== null && typeof value === "object" && "version" in value ? bounded(value.version) : null; }
        catch { return null; }
      case "brew-formula": case "brew-cask":
        return bounded(resolvedPath.slice(channel.root.length + 1).split("/", 1)[0]);
      case "script": {
        // Installers that keep versions side by side name each directory or file after its version.
        if (channel.root.endsWith("/versions")) return resolvedPath.startsWith(channel.root + "/") ? bounded(resolvedPath.slice(channel.root.length + 1).split("/", 1)[0]) : null;
        // A Python program in the layout's own virtual environment: the version its distribution's metadata records.
        const distribution = Object.hasOwn(SCRIPT_DISTRIBUTIONS, channel.name) ? SCRIPT_DISTRIBUTIONS[channel.name] : undefined;
        if (distribution === undefined || layout?.program?.startsWith("venv/bin/") !== true) return null;
        try { return bounded((await pythonDistribution(join(channel.root, "venv"), distribution))?.version); }
        catch (error: unknown) { if (UNREADABLE.includes(errno(error) ?? "")) return null; throw error; }
      }
      case "uv":
        return null;
    }
  }
}
