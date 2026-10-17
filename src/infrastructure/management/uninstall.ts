import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath, rm, rmdir, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ManagementError, type InstallationObservation, type InstallationRemovalPort, type ManagementInstallContext, type NativeInstallContext, type RemovalPreview } from "../../contracts/management.js";
import type { ScriptRemoval } from "../../contexts/catalog/domain/channels.js";
import { productChannels, productMaintenance } from "../../adapters/catalog-channels.js";
import { nativeBaseValues, nativeLaunchValues, nativeValues, type NativeEnvironment } from "../session/native-environment.js";
import { runManagementProcess } from "./process.js";
import { homebrewEnvironment, runHomebrewProtected } from "./homebrew.js";
import { isolatedSandboxProfile, protectedConfigurationHashes, protectedConfigurationPaths, writeOnlySandboxProfile } from "./native.js";
import { inspectRootsUsage, systemProgramHost, type ProgramHost } from "./program-usage.js";

const MAX_OUTPUT = 4 * 1024 * 1024, MAX_LAUNCHER = 4096;
function code(error: unknown): string | undefined { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function missing(error: unknown): boolean { return code(error) === "ENOENT" || code(error) === "ENOTDIR"; }
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + "/"); }
function refused(message: string): ManagementError { return new ManagementError("REMOVAL_REFUSED", message); }

/** One deletion of a script removal, with the file identity it was planned against. */
export interface RemovalStep { readonly kind: "link" | "launcher" | "file" | "directory" | "empty-directory"; readonly path: string; readonly identity: string }
/** What removing a script installation deletes, and what its layout names but this removal keeps. */
export interface RemovalPlan { readonly steps: readonly RemovalStep[]; readonly skipped: readonly { readonly path: string; readonly reason: string }[] }

async function identity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs].join(":");
}
/** An installer path below `home`; refused when the name is not a plain relative path or a parent resolves elsewhere through a link. */
async function pinned(home: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.split("/").some(part => part === "" || part === "." || part === "..")) throw refused("安装布局里的路径不是家目录下的普通相对路径：" + relativePath);
  const path = join(home, relativePath), parent = dirname(path);
  let real: string;
  try { real = await realpath(parent); } catch (error) { if (missing(error)) return path; throw error; }
  if (real !== parent) throw refused("~/" + relativePath + " 的上级目录经链接指向别处，拒绝删除。");
  return path;
}
/** The program a launcher script starts: the absolute path of its `exec "<path>" "$@"` line, when it is a short shell script. */
async function launcherTarget(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > MAX_LAUNCHER) return null;
    const buffer = Buffer.alloc(MAX_LAUNCHER), { bytesRead } = await handle.read(buffer, 0, MAX_LAUNCHER, 0), text = buffer.subarray(0, bytesRead).toString("utf8");
    if (!/^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:ba|z)?sh\b/u.test(text)) return null;
    const target = /^[ \t]*exec[ \t]+"?(\/[^"\s]+)"?[ \t]+"\$@"[ \t]*$/mu.exec(text)?.[1];
    return target === undefined ? null : resolve(target);
  } finally { await handle.close(); }
}
/**
 * What removing a script installation deletes (ADR-044), read without changing anything. A link is removed only while it
 * points into one of the installer's directories and a launcher only while it starts a program there; anything else the
 * layout names is kept and reported. A directory that is a link, or any path whose parent resolves elsewhere, is refused.
 */
export async function planScriptRemoval(removal: ScriptRemoval, home: string): Promise<RemovalPlan> {
  const base = await realpath(home), directories = removal.directories.map(path => join(base, path));
  const into = (target: string) => directories.some(directory => inside(target, directory));
  const steps: RemovalStep[] = [], skipped: { path: string; reason: string }[] = [];
  const present = async (path: string) => { try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; } };
  for (const relativePath of removal.links) {
    const path = await pinned(base, relativePath), info = await present(path); if (info === null) continue;
    if (!info.isSymbolicLink()) { skipped.push({ path, reason: "不是安装脚本创建的链接（可能是你自己的启动脚本），保留" }); continue; }
    if (!into(resolve(dirname(path), await readlink(path)))) { skipped.push({ path, reason: "指向这份安装以外的位置，保留" }); continue; }
    steps.push({ kind: "link", path, identity: await identity(path) });
  }
  for (const relativePath of removal.launchers) {
    const path = await pinned(base, relativePath), info = await present(path); if (info === null) continue;
    const target = info.isFile() ? await launcherTarget(path) : null;
    if (target === null || !into(target)) { skipped.push({ path, reason: "不是启动这份安装的启动脚本，保留" }); continue; }
    steps.push({ kind: "launcher", path, identity: await identity(path) });
  }
  for (const relativePath of removal.files) {
    const path = await pinned(base, relativePath), info = await present(path); if (info === null) continue;
    if (!info.isFile() && !info.isSymbolicLink()) throw refused("~/" + relativePath + " 不是文件，拒绝删除。");
    steps.push({ kind: "file", path, identity: await identity(path) });
  }
  for (const relativePath of removal.directories) {
    const path = await pinned(base, relativePath), info = await present(path); if (info === null) continue;
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) throw refused("~/" + relativePath + " 是链接或不是目录，拒绝删除。");
    steps.push({ kind: "directory", path, identity: await identity(path) });
  }
  for (const relativePath of removal.emptyDirectories) {
    const path = await pinned(base, relativePath), info = await present(path); if (info === null) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) throw refused("~/" + relativePath + " 是链接或不是目录，拒绝删除。");
    steps.push({ kind: "empty-directory", path, identity: await identity(path) });
  }
  return { steps, skipped };
}
/**
 * Removes exactly `expected` (ADR-044): the plan is read again first and must be unchanged, then links, launchers and
 * files go before directories, and a directory meant to be empty stays when it is not. Every deleted path is checked gone.
 */
export async function executeScriptRemoval(removal: ScriptRemoval, home: string, expected: RemovalPlan, log: (text: string) => void, beginMutation: () => void): Promise<void> {
  const plan = await planScriptRemoval(removal, home);
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw new ManagementError("INSTALLATION_CHANGED", "安装在确认之后有了变化，没有删除任何文件。请重新打开卸载确认。");
  if (plan.steps.length === 0) throw new ManagementError("INSTALLATION_CHANGED", "这份安装的文件已经不在了，没有删除任何文件。");
  beginMutation();
  for (const step of plan.steps) {
    if (step.kind === "directory") await rm(step.path, { recursive: true, force: false });
    else if (step.kind === "empty-directory") {
      try { await rmdir(step.path); } catch (error) { if (code(error) === "ENOTEMPTY" || code(error) === "EEXIST") { log("目录里还有别的文件，保留：" + step.path); continue; } throw error; }
    } else await unlink(step.path);
    log("已删除 " + step.path);
  }
  for (const step of plan.steps) if (step.kind !== "empty-directory") {
    try { await lstat(step.path); throw new ManagementError("REMOVAL_INCOMPLETE", step.path + " 删除后仍然存在。"); } catch (error) { if (!missing(error)) throw error; }
  }
}

/** The script layout of an observed script installation, with its removal; null when HarnessHub does not remove that layout. */
function scriptRemoval(target: InstallationObservation, home: string): ScriptRemoval | null {
  return productChannels(target.harnessId)?.scripts.find(layout => join(home, layout.root) === target.root)?.removal ?? null;
}
async function gone(path: string): Promise<boolean> { try { await lstat(path); return false; } catch (error) { if (missing(error)) return true; throw error; } }
async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; } }

/**
 * Removes official installations through their channels on macOS (ADR-044): npm with the prefix's own npm, Homebrew with
 * its inherited sandbox, uv with its tool command, and official script layouts by their whitelist. Package managers may
 * write only the installation's prefix and their own stage; HarnessHub never edits a shell or product configuration.
 */
export class LocalInstallationRemoval implements InstallationRemovalPort {
  constructor(private readonly source: NativeEnvironment, private readonly tools: { readonly npm: string | null; readonly uv: string | null }, private readonly host: ProgramHost = systemProgramHost()) {}
  /** Package-manager environment: a private HOME and caches in the stage, so neither the user's npmrc nor their caches are written. */
  private env(stage: string, prefixBin: string | null): Record<string, string> {
    return { ...nativeBaseValues(this.source, stage), ...nativeValues(this.source, stage), PATH: (prefixBin === null ? "" : prefixBin + ":") + (this.source.values.PATH ?? "/usr/bin:/bin"), LANG: "C.UTF-8", TMPDIR: stage, NO_COLOR: "1",
      npm_config_cache: join(stage, "cache"), npm_config_update_notifier: "false", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_AUTOREMOVE: "1" };
  }
  private async sandboxed(profile: string, executablePath: string, args: readonly string[], env: Readonly<Record<string, string>>, context: ManagementInstallContext): Promise<string> {
    if (process.platform !== "darwin" || !(await executable("/usr/bin/sandbox-exec"))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "卸载需要 macOS 的沙箱保护，这里不可用。");
    return runManagementProcess("/usr/bin/sandbox-exec", ["-p", profile, executablePath, ...args], context.stage, env, context, MAX_OUTPUT);
  }
  /** The npm that belongs to an npm prefix (it runs with that prefix's Node.js); HarnessHub's own npm when the prefix has none. */
  private async npmFor(prefix: string): Promise<string> {
    const own = join(prefix, "bin", "npm");
    if (await executable(own)) return own;
    if (this.tools.npm === null) throw new ManagementError("RUNTIME_UNAVAILABLE", "找不到这份安装所在前缀的 npm，也找不到本机的 npm。");
    return this.tools.npm;
  }
  private roots(target: InstallationObservation): readonly string[] {
    const roots = [target.entry, target.resolvedPath, target.root];
    if (target.channel === "brew-formula" && target.prefix !== null) roots.push(join(target.prefix, "opt", target.name));
    const removal = target.channel === "script" ? scriptRemoval(target, this.source.home) : null;
    if (removal) roots.push(...removal.directories.map(path => join(this.source.home, path)));
    return [...new Set(roots)];
  }
  async identity(target: InstallationObservation): Promise<string> {
    const parts: string[] = [];
    for (const path of [target.entry, target.resolvedPath, target.root]) { try { parts.push(await identity(path)); } catch (error) { if (!missing(error)) throw error; parts.push("missing"); } }
    return createHash("sha256").update(parts.join("|")).digest("hex");
  }
  async preview(target: InstallationObservation, _context: ManagementInstallContext): Promise<RemovalPreview> {
    switch (target.channel) {
      case "npm": {
        const prefix = target.prefix ?? "", npm = await this.npmFor(prefix);
        return { commands: [npm + " uninstall --global --prefix " + prefix + " " + target.name], removes: [target.root, target.entry], skipped: [], documented: true };
      }
      case "brew-formula": case "brew-cask":
        return { commands: ["brew uninstall " + (target.channel === "brew-cask" ? "--cask " : "--formula ") + target.name], removes: [target.root], skipped: [], documented: true };
      case "uv":
        return { commands: ["uv tool uninstall " + target.name], removes: [target.root, target.entry], skipped: [], documented: true };
      case "script": {
        const removal = scriptRemoval(target, this.source.home);
        if (removal === null) throw new ManagementError("UNSUPPORTED_UNINSTALL", "HarnessHub 不卸载这种安装布局。");
        const plan = await planScriptRemoval(removal, this.source.home);
        return { commands: [], removes: plan.steps.map(step => step.path), skipped: plan.skipped, documented: removal.documented };
      }
      case "pnpm": case "bun":
        throw new ManagementError("UNSUPPORTED_UNINSTALL", "当前版本不维护 pnpm、bun 全局安装。");
    }
  }
  async usage(target: InstallationObservation, context: ManagementInstallContext) {
    const resident = productMaintenance(target.harnessId).resident;
    const usage = await inspectRootsUsage(this.roots(target), [target.resolvedPath], command => { const found = resident.find(item => item.command.test(command)); return found === undefined ? null : { stop: found.stop }; }, this.host, context);
    return { servicesKnown: usage.servicesKnown, services: usage.services.map(service => ({ label: service.label, pid: service.pid })), resident: usage.resident, processes: usage.processes, own: usage.own };
  }
  async remains(target: InstallationObservation): Promise<boolean> {
    try { if (inside(await realpath(target.entry), target.root)) return true; } catch (error) { if (!missing(error)) throw error; }
    return !await gone(target.resolvedPath) || !await gone(target.root);
  }
  async localChanges(target: InstallationObservation, context: ManagementInstallContext): Promise<number | null> {
    if (target.channel !== "script" || await gone(join(target.root, ".git"))) return null;
    const quiet: ManagementInstallContext = { ...context, log: () => {} };
    try {
      // Read-only: no optional locks (no index refresh) and no filesystem monitor; it may write only its own stage.
      const output = await this.sandboxed(isolatedSandboxProfile([context.stage]), "/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", target.root, "status", "--porcelain"],
        { PATH: "/usr/bin:/bin", HOME: context.stage, LANG: "C", GIT_CONFIG_NOSYSTEM: "1" }, quiet);
      return output.split("\n").filter(line => line.trim() !== "").length;
    } catch (error) { if (error instanceof ManagementError && error.code === "PROCESS_FAILED") return null; throw error; }
  }
  async stopService(target: InstallationObservation, service: { readonly label: string; readonly stop: readonly (readonly string[])[] }, context: ManagementInstallContext): Promise<void> {
    // The product's own commands, with the user's profile so they find the job they registered; npm programs run on their prefix's Node.js.
    const env = { ...nativeBaseValues(this.source, null, target.harnessId), ...nativeLaunchValues(this.source, null), LANG: "C.UTF-8", NO_COLOR: "1", TMPDIR: context.stage,
      PATH: (target.channel === "npm" && target.prefix !== null ? join(target.prefix, "bin") + ":" : "") + (this.source.values.PATH ?? "/usr/bin:/bin") };
    for (const args of service.stop) {
      context.log("system", "运行 " + [target.entry, ...args].join(" "));
      await runManagementProcess(target.entry, args, context.stage, env, context, MAX_OUTPUT);
    }
    for (const domain of ["gui/" + this.host.uid, "user/" + this.host.uid]) if (await this.host.print(domain + "/" + service.label, context) !== null)
      throw new ManagementError("SERVICE_STOP_FAILED", service.label + " 在运行产品自己的停止和注销命令之后仍然登记在系统服务管理器里，没有删除程序。");
  }
  async remove(target: InstallationObservation, context: NativeInstallContext): Promise<void> {
    context.assertOwned();
    switch (target.channel) {
      case "npm": {
        const prefix = target.prefix; if (prefix === null) throw new ManagementError("INVALID_DATA", "an npm installation has no prefix");
        const npm = await this.npmFor(prefix); context.beginMutation();
        await this.sandboxed(writeOnlySandboxProfile([prefix, context.stage]), npm, ["uninstall", "--global", "--prefix", prefix, "--no-audit", "--no-fund", target.name], this.env(context.stage, join(prefix, "bin")), context);
        if (!await gone(target.root)) throw new ManagementError("REMOVAL_INCOMPLETE", "npm 卸载结束了，但包目录仍在：" + target.root);
        break;
      }
      case "brew-formula": case "brew-cask": {
        if (target.prefix === null) throw new ManagementError("INVALID_DATA", "a Homebrew installation has no prefix");
        const { directories, files } = protectedConfigurationPaths(this.source);
        await runHomebrewProtected(join(target.prefix, "bin", "brew"), ["uninstall", target.channel === "brew-cask" ? "--cask" : "--formula", target.name], directories, files, homebrewEnvironment(this.source, context.stage), context, { cache: "user" });
        if (!await gone(target.root)) throw new ManagementError("REMOVAL_INCOMPLETE", "Homebrew 卸载结束了，但安装目录仍在：" + target.root);
        break;
      }
      case "uv": {
        if (this.tools.uv === null) throw new ManagementError("RUNTIME_UNAVAILABLE", "本机没有 uv，无法按 uv 的方式卸载。");
        const toolDir = dirname(target.root), binDir = dirname(target.entry); context.beginMutation();
        await this.sandboxed(writeOnlySandboxProfile([toolDir, binDir, context.stage]), this.tools.uv, ["tool", "uninstall", target.name], { ...this.env(context.stage, null), UV_TOOL_DIR: toolDir, UV_TOOL_BIN_DIR: binDir, UV_CACHE_DIR: join(context.stage, "cache") }, context);
        if (!await gone(target.root)) throw new ManagementError("REMOVAL_INCOMPLETE", "uv 卸载结束了，但工具目录仍在：" + target.root);
        break;
      }
      case "script": {
        const removal = scriptRemoval(target, this.source.home);
        if (removal === null) throw new ManagementError("UNSUPPORTED_UNINSTALL", "HarnessHub 不卸载这种安装布局。");
        const plan = await planScriptRemoval(removal, this.source.home); context.assertOwned();
        await executeScriptRemoval(removal, this.source.home, plan, text => context.log("system", text), () => context.beginMutation());
        break;
      }
      case "pnpm": case "bun": throw new ManagementError("UNSUPPORTED_UNINSTALL", "当前版本不维护 pnpm、bun 全局安装。");
    }
    // The command must not resolve to the removed program any more; another installation's link with the same name may remain.
    try { const resolved = await realpath(target.entry); if (inside(resolved, target.root)) throw new ManagementError("REMOVAL_INCOMPLETE", "命令仍然指向被卸载的程序：" + target.entry); }
    catch (error) { if (!missing(error)) throw error; }
  }
  async configuration(target: InstallationObservation): Promise<string> {
    return JSON.stringify(await protectedConfigurationHashes(this.source.home, target.harnessId === "hermes" ? [".hermes/config.yaml"] : []));
  }
}
