import { stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyProgram, type InstallationChannel, type OfficialChannels } from "../../contexts/catalog/domain/channels.js";
import type { InstallationCandidate, InstallationClassifier } from "../../contexts/catalog/domain/catalog.js";
import { packageJson } from "./packages.js";

function errno(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error: unknown) { if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(errno(error) ?? "")) return false; throw error; }
}
function bounded(version: unknown): string | null {
  return typeof version === "string" && version.length > 0 && version.length <= 128 && !/[\0\r\n]/u.test(version) ? version : null;
}

/**
 * Classifies found programs into official channels (ADR-044) and reads the version each channel records: an npm, pnpm or
 * bun package's own package.json, a Homebrew keg's directory, or a script layout's `versions/<version>` directory. It
 * reads files only and never runs a program.
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
    return channel === null ? null : { channel, version: await this.version(channel, candidate.resolvedPath) };
  }

  private async version(channel: InstallationChannel, resolvedPath: string): Promise<string | null> {
    switch (channel.kind) {
      case "npm": case "pnpm": case "bun":
        try { const value = await packageJson(join(channel.root, "package.json")); return value !== null && typeof value === "object" && "version" in value ? bounded(value.version) : null; }
        catch { return null; }
      case "brew-formula": case "brew-cask":
        return bounded(resolvedPath.slice(channel.root.length + 1).split("/", 1)[0]);
      case "script":
        // Installers that keep versions side by side name each directory or file after its version.
        return channel.root.endsWith("/versions") && resolvedPath.startsWith(channel.root + "/") ? bounded(resolvedPath.slice(channel.root.length + 1).split("/", 1)[0]) : null;
      case "uv":
        return null;
    }
  }
}
