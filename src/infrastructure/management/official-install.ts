import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { satisfies, valid } from "semver";
import { ManagementError, type ManagementInstallContext, type ManagementMetadataPort, type NativeInstallContext, type OfficialInstallFacts, type OfficialInstallPort, type PreparedInstall, type RuntimeRequirement } from "../../contracts/management.js";
import { classifyProgram } from "../../contexts/catalog/domain/channels.js";
import { officialInstallMethod, productChannels } from "../../adapters/catalog-channels.js";
import { nativeBaseValues, nativeLaunchValues, nativeValues, type NativeEnvironment } from "../session/native-environment.js";
import { runManagementProcess } from "./process.js";
import { isolatedSandboxProfile, writeOnlySandboxProfile } from "./native.js";
import { OfficialManagementMetadata } from "./metadata.js";
import { systemVersionFromOutput } from "./system-version.js";

const MAX_SCRIPT = 1024 * 1024, MAX_OUTPUT = 8 * 1024 * 1024;
/** Configuration keys an official installer is known to write, whose values are shown; any other changed key is named only. */
const INSTALL_KEYS = new Set(["installMethod", "autoUpdates", "autoUpdatesProtectedForNative"]);
function code(error: unknown): string | undefined { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function missing(error: unknown): boolean { return code(error) === "ENOENT" || code(error) === "ENOTDIR"; }
async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; } }

/**
 * Downloads an official install script into `destination` (ADR-044): HTTPS only, every URL in its redirect chain on one of
 * `hosts`, at most 1 MiB, and a script by its first line. Resolves with the final URL and the SHA-256 of the copy; nothing
 * else is kept. `fetcher` is the platform's fetch, replaced only in tests.
 */
export async function downloadScript(url: string, hosts: readonly string[], destination: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<{ readonly finalUrl: string; readonly sha256: string }> {
  let current = new URL(url), response: Response | null = null;
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== "https:" || current.username || current.password || current.port !== "") throw new ManagementError("INSTALL_SOURCE_REFUSED", "安装脚本的地址必须是 HTTPS：" + current.href);
    if (!hosts.includes(current.hostname)) throw new ManagementError("INSTALL_SOURCE_REFUSED", "安装脚本跳转到了没有登记的地址 " + current.hostname + "，没有下载。请在终端按官网命令安装。");
    if (redirects > 5) throw new ManagementError("INSTALL_SOURCE_REFUSED", "安装脚本的跳转次数过多，没有下载。");
    response = await fetcher(current, { signal, redirect: "manual", headers: { Accept: "text/x-sh, text/plain, */*" } });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location"); await response.body?.cancel();
      if (next === null) throw new ManagementError("DOWNLOAD_FAILED", "安装脚本的跳转没有目标地址。");
      current = new URL(next, current); continue;
    }
    break;
  }
  if (!response.ok || response.body === null) { await response.body?.cancel(); throw new ManagementError("DOWNLOAD_FAILED", "安装脚本下载失败（HTTP " + response.status + "）。"); }
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > MAX_SCRIPT) { await response.body.cancel(); throw new ManagementError("DOWNLOAD_LIMIT", "安装脚本超过 1 MiB，没有下载。"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > MAX_SCRIPT) { await reader.cancel(); throw new ManagementError("DOWNLOAD_LIMIT", "安装脚本超过 1 MiB，没有下载。"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const content = Buffer.concat(chunks);
  if (!content.subarray(0, 2).equals(Buffer.from("#!"))) throw new ManagementError("INSTALL_SOURCE_REFUSED", "下载到的内容不是安装脚本（可能是错误页面），没有保存。");
  const handle = await open(destination, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  return { finalUrl: current.href, sha256: createHash("sha256").update(content).digest("hex") };
}
/** The startup file Codex's installer picks for the user's shell on macOS (`pick_profile` in its install.sh). */
export function codexProfile(home: string, shell: string | undefined): string {
  return join(home, shell?.endsWith("/zsh") ? ".zprofile" : shell?.endsWith("/bash") ? ".bash_profile" : ".profile");
}
/** Lines added to and removed from a text file between two reads (null: the file did not exist). */
export function lineChanges(before: string | null, after: string | null): { readonly added: readonly string[]; readonly removed: readonly string[] } {
  const count = (text: string | null) => { const map = new Map<string, number>(); for (const line of (text ?? "").split("\n")) if (line.trim()) map.set(line, (map.get(line) ?? 0) + 1); return map; };
  const left = count(before), right = count(after), added: string[] = [], removed: string[] = [];
  for (const [line, times] of right) for (let index = left.get(line) ?? 0; index < times; index++) added.push(line);
  for (const [line, times] of left) for (let index = right.get(line) ?? 0; index < times; index++) removed.push(line);
  return { added: added.slice(0, 64), removed: removed.slice(0, 64) };
}
/**
 * The key paths that differ between two JSON documents, to depth three; values only for the keys an official installer is
 * known to write (a configuration file may hold account details). A document that does not parse counts as one change.
 */
export function keyChanges(before: string | null, after: string | null): readonly { readonly path: string; readonly value: string | null }[] {
  const flat = (text: string | null): Map<string, string> | null => {
    if (text === null) return new Map();
    let value: unknown; try { value = JSON.parse(text); } catch { return null; }
    const result = new Map<string, string>();
    const visit = (node: unknown, path: string, depth: number) => {
      if (depth < 3 && node !== null && typeof node === "object" && !Array.isArray(node)) { for (const [key, item] of Object.entries(node).slice(0, 512)) visit(item, path ? path + "." + key : key, depth + 1); return; }
      result.set(path, JSON.stringify(node) ?? "undefined");
    };
    visit(value, "", 0); return result;
  };
  const left = flat(before), right = flat(after);
  if (left === null || right === null) return [{ path: "(整个文件)", value: null }];
  const changes: { path: string; value: string | null }[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (left.get(path) === right.get(path)) continue;
    const leaf = path.split(".").at(-1) ?? path, shown = right.get(path);
    changes.push({ path, value: INSTALL_KEYS.has(leaf) && shown !== undefined && shown.length <= 64 ? shown : null });
  }
  return changes.slice(0, 64);
}
/** Paths an installer's output says it could not write: the sandbox denies them with EPERM ("Operation not permitted"). */
export function blockedWrites(output: string): readonly string[] {
  const found = new Set<string>();
  // The path is the one the error names, right before it: `mkdir: <path>: Operation not permitted`, or bash's
  // `<script>: line 8: <path>: Operation not permitted`, where the script's own path comes first and is not the one denied.
  for (const match of output.matchAll(/(\/[^\s:'"`,;)]+):?\s*(?:Operation not permitted|Permission denied)/gu)) { if (found.size >= 16) break; found.add(match[1]!.replace(/[.]+$/u, "")); }
  return [...found];
}
async function readText(path: string): Promise<string | null> {
  try { const info = await stat(path); if (!info.isFile() || info.size > 4 * 1024 * 1024) return null; return await readFile(path, "utf8"); }
  catch (error) { if (missing(error)) return null; throw error; }
}

/**
 * Installs a missing product the way its official page does, on macOS (ADR-044): a script runs as the confirmed copy with
 * writes confined to the directories it installs into (and the one shell startup file or product configuration it is
 * known to change); npm installs the exact release into the prefix of the first Node.js on PATH, writing only that prefix.
 * The network stays available, and a script can read the home directory like any `curl | bash`; HarnessHub guarantees only
 * that what runs is what the user confirmed.
 */
export class LocalOfficialInstaller implements OfficialInstallPort {
  constructor(private readonly source: NativeEnvironment, private readonly tools: { readonly npm: string | null },
    private readonly options: { readonly metadata?: ManagementMetadataPort; readonly registry?: string; readonly fetch?: typeof fetch } = {}) {}
  private get registry(): string { return this.options.registry ?? "https://registry.npmjs.org"; }
  private path(): string { return this.source.values.PATH ?? "/usr/bin:/bin"; }
  private async sandboxed(profile: string, executablePath: string, args: readonly string[], env: Readonly<Record<string, string>>, context: ManagementInstallContext): Promise<string> {
    if (process.platform !== "darwin" || !(await executable("/usr/bin/sandbox-exec"))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "安装需要 macOS 的沙箱保护，这里不可用。");
    return runManagementProcess("/usr/bin/sandbox-exec", ["-p", profile, executablePath, ...args], context.stage, env, context, MAX_OUTPUT);
  }
  /** The first Node.js on this Gateway's PATH and the npm prefix it belongs to (the directory above its bin). */
  private async firstNode(): Promise<{ readonly node: string; readonly prefix: string } | null> {
    for (const directory of this.path().split(":")) {
      if (!isAbsolute(directory)) continue;
      if (await executable(join(directory, "node"))) return { node: join(directory, "node"), prefix: dirname(directory) };
    }
    return null;
  }
  async prepare(harnessId: string, directory: string, context: ManagementInstallContext): Promise<PreparedInstall> {
    const method = officialInstallMethod(harnessId), home = this.source.home;
    if (method === null || method.kind === "terminal") throw new ManagementError("UNSUPPORTED_INSTALL", method?.kind === "terminal" ? method.reason : "HarnessHub 没有记录这个产品的官网安装方式。");
    if (method.kind === "script") {
      const script = join(directory, "install." + method.interpreter);
      const { finalUrl, sha256 } = await downloadScript(method.url, method.hosts, script, context.signal, this.options.fetch);
      return { harnessId, method: "script", source: finalUrl, sha256, script, interpreter: method.interpreter, args: method.args, env: method.env,
        writes: method.writes.map(path => join(home, path)), shellProfile: method.shellProfile === "codex" ? codexProfile(home, this.source.values.SHELL) : null,
        configFiles: method.configFiles.map(path => join(home, path)), package: null, version: null, prefix: null, npm: null,
        entry: join(home, method.installs.path), command: method.installs.command, runtime: null };
    }
    const found = await this.firstNode();
    if (found === null) throw new ManagementError("RUNTIME_UNAVAILABLE", "这台电脑的 PATH 上没有 Node.js，无法用 npm 安装；HarnessHub 不安装 Node.js。");
    const spec = await (this.options.metadata ?? new OfficialManagementMetadata()).resolve({ harnessId, controlId: harnessId, kind: "npm", packageName: method.package, referenceVersion: "latest", binName: method.bin, args: [],
      archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] }, context.signal);
    if (spec.binNames !== undefined && !spec.binNames.includes(method.bin)) throw new ManagementError("INVALID_METADATA", method.package + " " + spec.version + " 没有声明命令 " + method.bin + "。");
    let runtime: RuntimeRequirement | null = null;
    if (spec.engines.node) {
      let version: string | null = null;
      try { version = /^v?(\d+\.\d+\.\d+)/u.exec((await runManagementProcess(found.node, ["--version"], context.stage, { PATH: "/usr/bin:/bin", HOME: context.stage }, { ...context, log: () => {} })).trim())?.[1] ?? null; }
      catch (error) { if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED" && error.code !== "PROCESS_START_FAILED") throw error; }
      runtime = { runtime: "Node.js", required: spec.engines.node, found: version, path: found.node, satisfied: version !== null && valid(version) !== null && satisfies(version, spec.engines.node), service: null, restarted: true, upgradeCommand: null };
    }
    const own = join(found.prefix, "bin", "npm"), npm = await executable(own) ? own : this.tools.npm;
    if (npm === null) throw new ManagementError("RUNTIME_UNAVAILABLE", "找不到 npm，无法用 npm 安装。");
    return { harnessId, method: "npm", source: method.package + "@" + spec.version, sha256: null, script: null, interpreter: null, args: [], env: {}, writes: [found.prefix], shellProfile: null, configFiles: [],
      package: method.package, version: spec.version, prefix: found.prefix, npm, entry: join(found.prefix, "bin", method.bin), command: method.bin, runtime };
  }
  async run(prepared: PreparedInstall, context: NativeInstallContext): Promise<{ readonly exitCode: number; readonly facts: Omit<OfficialInstallFacts, "installed"> }> {
    context.assertOwned();
    let output = "";
    const logged: NativeInstallContext = { ...context, log: (stream, text) => { if (output.length < 1024 * 1024) output += text + "\n"; context.log(stream, text); } };
    if (prepared.method === "npm") {
      if (prepared.prefix === null || prepared.npm === null || prepared.package === null || prepared.version === null) throw new ManagementError("INVALID_DATA", "npm install request is incomplete");
      if (prepared.runtime !== null && !prepared.runtime.satisfied) throw new ManagementError("RUNTIME_INCOMPATIBLE", prepared.source + " 要求 Node.js " + prepared.runtime.required + "，这个前缀的 Node.js 是 " + (prepared.runtime.found ?? "读不出版本") + "。没有安装；HarnessHub 不安装 Node.js。");
      const env = { ...nativeBaseValues(this.source, context.stage), ...nativeValues(this.source, context.stage), PATH: join(prepared.prefix, "bin") + ":" + this.path(), LANG: "C.UTF-8", TMPDIR: context.stage, NO_COLOR: "1",
        npm_config_cache: join(context.stage, "cache"), npm_config_update_notifier: "false" };
      context.beginMutation();
      let exitCode = 0;
      // The package's own install scripts run (Claude Code's links its native binary), confined like npm itself.
      try { await this.sandboxed(writeOnlySandboxProfile([prepared.prefix, context.stage]), prepared.npm, ["install", "--global", "--prefix", prepared.prefix, "--no-audit", "--no-fund", "--registry=" + this.registry, prepared.package + "@" + prepared.version], env, logged); }
      catch (error) { if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED") throw error; exitCode = 1; }
      return { exitCode, facts: { method: "npm", source: prepared.source, sha256: null, shellChanges: [], configChanges: [], blocked: blockedWrites(output) } };
    }
    if (prepared.script === null || prepared.sha256 === null || prepared.interpreter === null) throw new ManagementError("INVALID_DATA", "script install request is incomplete");
    // What runs is the copy the user confirmed.
    if (createHash("sha256").update(await readFile(prepared.script)).digest("hex") !== prepared.sha256) throw new ManagementError("INSTALL_SOURCE_CHANGED", "安装脚本的副本和确认时不一致，没有运行。");
    const home = this.source.home, before = new Map<string, string | null>();
    for (const path of [...(prepared.shellProfile === null ? [] : [prepared.shellProfile]), ...prepared.configFiles]) before.set(path, await readText(path));
    // Parents an installer would create on its way to an allowed directory (~/.local/share, say) are made here, empty.
    for (const path of prepared.writes) {
      const parents: string[] = [];
      for (let parent = dirname(path); parent.startsWith(home + "/"); parent = dirname(parent)) parents.unshift(parent);
      for (const parent of parents) { try { await lstat(parent); } catch (error) { if (!missing(error)) throw error; await mkdir(parent, { mode: 0o755 }); context.log("system", "创建了空目录 " + parent + "，安装脚本需要它。"); } }
    }
    const env: Record<string, string> = { ...nativeBaseValues(this.source, null), ...nativeLaunchValues(this.source, null), PATH: this.path(), HOME: home, TMPDIR: context.stage, TERM: "dumb", NO_COLOR: "1",
      ...(this.source.values.SHELL === undefined ? {} : { SHELL: this.source.values.SHELL }), ...prepared.env };
    const profile = "(version 1)(allow default)(deny file-write*)(allow file-write* " + [...prepared.writes, context.stage, "/dev"].map(path => "(subpath " + JSON.stringify(path) + ")").join(" ")
      + " " + [...(prepared.shellProfile === null ? [] : [prepared.shellProfile]), ...prepared.configFiles].map(path => "(literal " + JSON.stringify(path) + ")").join(" ") + ")";
    context.beginMutation();
    let exitCode = 0;
    try { await this.sandboxed(profile, "/bin/" + prepared.interpreter, [prepared.script, ...prepared.args], env, logged); }
    catch (error) { if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED") throw error; exitCode = 1; }
    const shellChanges: { file: string; added: readonly string[]; removed: readonly string[] }[] = [], configChanges: { file: string; keys: readonly { path: string; value: string | null }[] }[] = [];
    if (prepared.shellProfile !== null) { const changes = lineChanges(before.get(prepared.shellProfile) ?? null, await readText(prepared.shellProfile)); if (changes.added.length || changes.removed.length) shellChanges.push({ file: prepared.shellProfile, ...changes }); }
    for (const file of prepared.configFiles) { const keys = keyChanges(before.get(file) ?? null, await readText(file)); if (keys.length) configChanges.push({ file, keys }); }
    return { exitCode, facts: { method: "script", source: prepared.source, sha256: prepared.sha256, shellChanges, configChanges, blocked: blockedWrites(output) } };
  }
  async verify(prepared: PreparedInstall, context: ManagementInstallContext): Promise<{ readonly entry: string; readonly version: string | null } | null> {
    let resolvedPath: string;
    try { resolvedPath = await realpath(prepared.entry); } catch (error) { if (missing(error)) return null; throw error; }
    const channels = productChannels(prepared.harnessId); if (channels === null) return null;
    const exists = async () => { const present = new Set<string>(); for (const layout of channels.scripts) if (layout.program !== null) { const program = join(this.source.home, layout.root, layout.program); try { await stat(program); present.add(program); } catch { /* absent */ } } return present; };
    const present = await exists(), channel = classifyProgram({ path: prepared.entry, resolvedPath }, channels, this.source.home, join(this.source.home, ".local", "share", "uv", "tools"), path => present.has(path));
    if (channel === null || (prepared.method === "npm" ? channel.kind !== "npm" || channel.prefix !== prepared.prefix : channel.kind !== "script")) return null;
    // The version, read the way discovery does: a write-protected run with a private home and no network.
    let output = "";
    try { await this.sandboxed(isolatedSandboxProfile([context.stage]), prepared.entry, ["--version"], { PATH: (prepared.prefix === null ? "" : join(prepared.prefix, "bin") + ":") + this.path(), HOME: context.stage, TMPDIR: context.stage, LANG: "C.UTF-8", NO_COLOR: "1" },
      { ...context, log: (_stream, text) => { if (output.length < 65536) output += text + "\n"; } }); }
    catch (error) { if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED") throw error; }
    return { entry: prepared.entry, version: systemVersionFromOutput(output) ?? null };
  }
}
