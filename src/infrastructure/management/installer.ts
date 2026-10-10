import { access, chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { satisfies } from "semver";
import { ManagementError, type InstalledManagementArtifact, type ManagementInstallContext, type ManagementInstallerPort, type ResolvedInstallSpec } from "../../contracts/management.js";
import { boundedManagementFile } from "./storage.js";
import { insideManagement, unpackManagementArchive } from "./archive.js";
import { managementDownload, managementText } from "./download.js";
import { runManagementProcess } from "./process.js";

export interface DefaultInstallerOptions { readonly nodeExecutable: string; readonly npmExecutable: string | null; readonly uvExecutable: string | null }
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("INVALID_ARTIFACT", "installed package manifest is invalid"); return value as Record<string, unknown>; }
export function installedNpmEntry(stage: string, name: string, version: string, binName: string): string {
  const root = join(stage, "node_modules", name), data = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(boundedManagementFile(join(root, "package.json"), 1024 * 1024))));
  if (data.name !== name || data.version !== version) throw new ManagementError("INVALID_ARTIFACT", "installed package identity/version does not match its resolved recipe");
  const bins = typeof data.bin === "string" ? { [name.split("/").at(-1) ?? ""]: data.bin } : object(data.bin), entry = bins[binName];
  if (typeof entry !== "string" || !entry || !insideManagement(root, join(root, entry))) throw new ManagementError("INVALID_ARTIFACT", "installed package does not expose its reviewed executable");
  return join(root, entry);
}
export class DefaultManagementInstaller implements ManagementInstallerPort {
  constructor(private readonly options: DefaultInstallerOptions) {}
  private async node(spec: ResolvedInstallSpec, context: ManagementInstallContext): Promise<string> {
    if (spec.engines.node === undefined || satisfies(process.versions.node, spec.engines.node)) return this.options.nodeExecutable;
    context.log("system", "Preparing one private Node.js 24 runtime for this package.");
    const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
    const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
    if (!os || !architecture) throw new ManagementError("RUNTIME_UNSUPPORTED", "private Node runtime is unavailable on this host");
    const sums = await managementText("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt", context); context.assertOwned();
    const pattern = new RegExp("^([a-f0-9]{64})\\s+(node-(v24\\.[0-9]+\\.[0-9]+)-" + os + "-" + architecture + "\\.tar\\.gz)$", "mu"), found = sums.match(pattern);
    if (!found || !found[1] || !found[2] || !found[3] || !satisfies(found[3], spec.engines.node)) throw new ManagementError("RUNTIME_INCOMPATIBLE", "available private Node 24 does not satisfy the package engine");
    const url = "https://nodejs.org/dist/" + found[3] + "/" + found[2], archive = join(context.stage, "node-runtime.tar.gz");
    const digest = await managementDownload(url, archive, context); context.assertOwned();
    if (digest !== found[1]) throw new ManagementError("INTEGRITY_FAILED", "private Node artifact digest did not match official release metadata");
    await unpackManagementArchive(archive, join(context.stage, "runtime"), url, context); context.assertOwned();
    return join(context.stage, "runtime", found[2].replace(/\.tar\.gz$/u, ""), "bin", "node");
  }
  async install(spec: ResolvedInstallSpec, context: ManagementInstallContext): Promise<InstalledManagementArtifact> {
    context.assertOwned();
    for (const directory of ["home", "cache", "tmp"]) { await mkdir(join(context.stage, directory), { mode: 0o700 }); context.assertOwned(); }
    const base: Record<string, string> = { HOME: join(context.stage, "home"), TMPDIR: join(context.stage, "tmp"), LANG: "C.UTF-8", NO_COLOR: "1",
      PATH: dirname(this.options.nodeExecutable) + ":/usr/bin:/bin:/opt/homebrew/bin" };
    switch (spec.recipe.kind) {
      case "npm": {
        if (!this.options.npmExecutable || !spec.recipe.packageName) throw new ManagementError("RUNTIME_UNAVAILABLE", "npm runtime is unavailable");
        const node = await this.node(spec, context); context.assertOwned();
        const userConfig = join(context.stage, "empty-npmrc"), globalConfig = join(context.stage, "empty-global-npmrc");
        await writeFile(userConfig, "", { flag: "wx", mode: 0o600 }); context.assertOwned();
        await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 }); context.assertOwned();
        const env = { ...base, PATH: dirname(node) + ":" + base.PATH, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
          npm_config_registry: "https://registry.npmjs.org", npm_config_cache: join(context.stage, "cache"), npm_config_update_notifier: "false" };
        const packages = [spec.recipe.packageName + "@" + spec.version, ...spec.dependencies.map(dependency => dependency.packageName + "@" + dependency.version)];
        await runManagementProcess(this.options.npmExecutable, ["install", "--prefix", context.stage, "--save-exact", "--no-audit", "--no-fund", ...packages], context.stage, env, context, 4 * 1024 * 1024); context.assertOwned();
        if (spec.integrity !== null) {
          const lock = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(boundedManagementFile(join(context.stage, "package-lock.json"), 8 * 1024 * 1024))));
          const locked = object(object(lock.packages)["node_modules/" + spec.recipe.packageName]);
          if (locked.version !== spec.version || locked.integrity !== spec.integrity) throw new ManagementError("INTEGRITY_FAILED", "installed npm artifact does not match its resolved registry integrity");
        }
        const entry = await realpath(installedNpmEntry(context.stage, spec.recipe.packageName, spec.version, spec.recipe.binName)); context.assertOwned();
        if (!insideManagement(context.stage, entry)) throw new ManagementError("INVALID_ARTIFACT", "installed package executable escapes its slot");
        for (const dependency of spec.dependencies) { const executable = await realpath(installedNpmEntry(context.stage, dependency.packageName, dependency.version, dependency.binName)); context.assertOwned(); if (!insideManagement(context.stage, executable)) throw new ManagementError("INVALID_ARTIFACT", "installed dependency escapes its slot"); }
        return { observedVersion: spec.version, artifactSha256: null, command: { executable: await realpath(node), args: [entry, ...spec.recipe.args],
          env: { PATH: join(context.stage, "node_modules", ".bin") + ":" + dirname(node) + ":/usr/bin:/bin:/opt/homebrew/bin" } } };
      }
      case "binary": {
        if (!spec.artifactUrl || !spec.recipe.relativeExecutable) throw new ManagementError("INVALID_RECIPE", "binary recipe is incomplete");
        const archive = join(context.stage, "artifact.download"), digest = await managementDownload(spec.artifactUrl, archive, context); context.assertOwned();
        if (spec.integrity !== null && digest.toLowerCase() !== spec.integrity.toLowerCase()) throw new ManagementError("INTEGRITY_FAILED", "binary archive digest did not match its recipe");
        context.log("system", spec.integrity === null ? "HTTPS source; recorded observed SHA-256 (no upstream digest supplied)." : "Archive SHA-256 matched the reviewed source.");
        const destination = join(context.stage, "payload"); await unpackManagementArchive(archive, destination, spec.artifactUrl, context); context.assertOwned();
        const executable = await realpath(join(destination, spec.recipe.relativeExecutable)); context.assertOwned();
        if (!insideManagement(destination, executable) || !(await lstat(executable)).isFile()) throw new ManagementError("INVALID_ARTIFACT", "binary entry is not an owned regular executable");
        context.assertOwned(); await chmod(executable, 0o755); context.assertOwned(); await access(executable, constants.X_OK); context.assertOwned();
        return { observedVersion: spec.version, artifactSha256: digest, command: { executable, args: spec.recipe.args, env: spec.recipe.env ?? {} } };
      }
      case "python": {
        if (!this.options.uvExecutable || !spec.recipe.packageName) throw new ManagementError("RUNTIME_UNAVAILABLE", "uv runtime is unavailable");
        const env = { ...base, UV_TOOL_DIR: join(context.stage, "tools"), UV_TOOL_BIN_DIR: join(context.stage, "bin"), UV_CACHE_DIR: join(context.stage, "cache"), UV_PYTHON_DOWNLOADS: "never" };
        await runManagementProcess(this.options.uvExecutable, ["tool", "install", "--no-progress", spec.recipe.packageName + "==" + spec.version], context.stage, env, context); context.assertOwned();
        const executable = await realpath(join(context.stage, "bin", spec.recipe.binName)); context.assertOwned();
        if (!insideManagement(context.stage, executable)) throw new ManagementError("INVALID_ARTIFACT", "Python executable escapes its managed slot");
        await access(executable, constants.X_OK); context.assertOwned();
        return { observedVersion: spec.version, artifactSha256: null, command: { executable, args: spec.recipe.args, env: {} } };
      }
    }
  }
}
