import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rename, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gt, valid, satisfies } from "semver";
import { ManagementError, type ManagementInstallContext, type ManagementRecipe, type NativeInstallPlan, type NativeManagementPort, type SystemInstallationObservation, type NativeInstallContext, type ManagementMetadataPort } from "../../contracts/management.js";
import { captureNativeEnvironment, nativeBaseValues, nativeValues, type NativeEnvironment } from "../session/native-environment.js";
import { OfficialManagementMetadata } from "./metadata.js";
import { DefaultManagementInstaller, installedNpmEntry } from "./installer.js";
import { runManagementProcess } from "./process.js";
import { systemVersionFromOutput } from "./system-version.js";
import { homebrewSandboxIdentity, runHomebrewProtected } from "./homebrew.js";

const MAX_JSON = 2 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ManagementError("INVALID_METADATA", "native installation metadata is invalid"); return value as Record<string, unknown>; }
function string(value: unknown, maximum = 4096): string { if (typeof value !== "string" || !value || value.length > maximum || /[\0\r\n]/u.test(value)) throw new ManagementError("INVALID_METADATA", "native metadata text is invalid"); return value; }
async function json(path: string): Promise<Record<string, unknown>> { const info = await stat(path); if (!info.isFile() || info.size > MAX_JSON) throw new ManagementError("INVALID_METADATA", "native manifest exceeds its budget"); const bytes = await readFile(path); if (bytes.length > MAX_JSON) throw new ManagementError("INVALID_METADATA", "native manifest grew beyond its budget"); const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); return object(value); }
function missing(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
async function available(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch (error) { if (missing(error)) return false; return false; } }
function fingerprint(plan: Omit<NativeInstallPlan, "fingerprint">, identity: string): NativeInstallPlan { return { ...plan, fingerprint: createHash("sha256").update(JSON.stringify(plan) + identity).digest("hex") }; }
function parseVersion(value: unknown): string { const text = string(value, 128); if (!valid(text)) throw new ManagementError("INVALID_METADATA", "native channel returned an unsupported version"); return text; }
const configDirectories = [".codex", ".claude", ".openclaw", ".gemini", ".pi", ".cursor", ".config", ".local/share/opencode"];
const configFiles = [".claude.json", ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".npmrc"];
/** Native managers operate on standard local installation paths. The user profile remains readable and protected from writes. */
export class NativeManagement implements NativeManagementPort {
  private readonly source: NativeEnvironment;
  private prefix: Promise<string> | null = null;
  constructor(private readonly npm: string | null, private readonly uv: string | null, private readonly node: string, source?: NativeEnvironment, private readonly metadata: ManagementMetadataPort = new OfficialManagementMetadata()) { this.source = source ?? captureNativeEnvironment(); }
  private env(stage: string): Record<string, string> {
    return { ...nativeBaseValues(this.source, stage), ...nativeValues(this.source, stage), PATH: this.source.values.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", LANG: "C.UTF-8", TMPDIR: stage, NO_COLOR: "1",
      npm_config_cache: join(stage, "cache"), npm_config_update_notifier: "false", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1" };
  }
  private nativeManagerEnvironment(): Record<string, string> {
    const values: Record<string, string> = { HOME: this.source.home };
    for (const name of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig", "NPM_CONFIG_PREFIX", "npm_config_prefix", "UV_TOOL_DIR", "UV_TOOL_BIN_DIR"]) if (this.source.values[name] !== undefined) values[name] = this.source.values[name];
    return values;
  }
  private async process(executable: string, args: readonly string[], context: ManagementInstallContext, protectedWrites = false, extra: Readonly<Record<string, string>> = {}): Promise<string> {
    context.assertOwned(); const env = { ...this.env(context.stage), ...extra };
    if (!protectedWrites) return runManagementProcess(executable, args, context.stage, env, context, MAX_JSON);
    if (process.platform !== "darwin" || !(await available("/usr/bin/sandbox-exec"))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "native installation requires verified configuration write protection on this host");
    const native = nativeValues(this.source, null);
    const configuredRoots = [native.CODEX_HOME, native.CLAUDE_CONFIG_DIR, native.OPENCODE_CONFIG_DIR, native.XDG_CONFIG_HOME, this.source.values.OPENCLAW_STATE_DIR, this.source.values.PI_CODING_AGENT_DIR].filter((path): path is string => path !== undefined);
    const deny = [...new Set([...configDirectories.map(path => join(this.source.home, path)), ...configuredRoots])].map(path => `(deny file-write* (subpath ${JSON.stringify(path)}))`);
    deny.push(...configFiles.map(path => `(deny file-write* (literal ${JSON.stringify(join(this.source.home, path))}))`));
    if (native.OPENCLAW_CONFIG_PATH) deny.push(`(deny file-write* (literal ${JSON.stringify(native.OPENCLAW_CONFIG_PATH)}))`);
    const profile = "(version 1)(allow default)" + deny.join("");
    if ("beginMutation" in context && typeof context.beginMutation === "function") context.beginMutation();
    return runManagementProcess("/usr/bin/sandbox-exec", ["-p", profile, executable, ...args], context.stage, env, context, 4 * MAX_JSON);
  }
  async describe(recipe: ManagementRecipe, observation: SystemInstallationObservation | undefined, version: string | null, context: ManagementInstallContext): Promise<NativeInstallPlan> {
    const base = { harnessId: recipe.harnessId, controlId: recipe.controlId, beforeVersion: version, reason: null };
    let entry = "", actual = "", identity = "";
    if (observation) {
      actual = observation.command.executable === this.node && observation.command.args[0] ? observation.command.args[0] : observation.command.executable;
      actual = await realpath(actual); const info = await stat(actual); identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      for (const directory of [...(this.source.values.PATH ?? "").split(":"), join(this.source.home, ".local", "bin")]) {
        if (!isAbsolute(directory)) continue;
        const candidate = join(directory, recipe.binName);
        try { if (await realpath(candidate) === actual) { entry = candidate; break; } } catch (error) { if (!missing(error)) throw error; }
      }
      entry ||= actual;
      if (recipe.harnessId === "cursor" && actual.includes("/cursor-agent/versions/"))
        return fingerprint({ ...base, channel: "native-cli", manager: entry, prefix: join(this.source.home, ".local", "share", "cursor-agent"), reference: "cursor-agent", entry, actualEntry: actual }, identity);
      const brew = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\/[^/]+\//u.exec(actual);
      if (brew) { const manager = join(brew[1]!, "bin", "brew"), sdk = await homebrewSandboxIdentity(manager); return fingerprint({ ...base, channel: brew[2] === "Cellar" ? "brew-formula" : "brew-cask", manager, prefix: brew[1]!, reference: brew[3]!, entry, actualEntry: actual,
        reason: sdk === null ? "本机 Homebrew 没有受支持的配置保护接口，原安装接入可用，升级暂不可用。" : null }, identity + (sdk ?? "unsupported")); }
      let directory = dirname(actual);
      for (let depth = 0; depth < 10; depth++) {
        const packageFile = join(directory, "package.json");
        try {
          const manifest = await json(packageFile), name = typeof manifest.name === "string" && manifest.name ? string(manifest.name, 256) : recipe.packageName ?? recipe.binName;
          if (directory.includes("/lib/node_modules/")) {
            const observed = parseVersion(manifest.version);
            const prefix = directory.slice(0, directory.indexOf("/lib/node_modules/"));
            if (await realpath(join(prefix, "lib", "node_modules", name)) !== directory) throw new ManagementError("INVALID_METADATA", "original npm package identity disagrees with its installation directory");
            if (!this.npm) throw new ManagementError("RUNTIME_UNAVAILABLE", "npm is unavailable for the original installation");
            return fingerprint({ ...base, beforeVersion: observed, channel: "npm", manager: this.npm, prefix, reference: name, entry, actualEntry: actual }, identity + JSON.stringify(manifest));
          }
          return fingerprint({ ...base, channel: "unsupported", manager: "", prefix: directory, reference: name, entry, actualEntry: actual, reason: "This executable belongs to a project or an unreviewed installation channel; preserve its original path." }, identity);
        } catch (error) { if (!missing(error)) throw error; }
        const parent = dirname(directory); if (parent === directory) break; directory = parent;
      }
      return fingerprint({ ...base, channel: "unsupported", manager: "", prefix: dirname(actual), reference: recipe.packageName ?? recipe.binName, entry, actualEntry: actual, reason: "The original installation channel has no reviewed native update recipe." }, identity);
    }
    if (recipe.kind === "npm" && this.npm && recipe.packageName) {
      this.prefix ??= this.process(this.npm, ["prefix", "--global"], context, false, this.nativeManagerEnvironment()).then(output => { const path = output.trim(); if (!isAbsolute(path) || path.includes("\n")) throw new ManagementError("INVALID_METADATA", "npm global prefix is invalid"); return path; }).finally(() => { this.prefix = null; });
      const prefix = await this.prefix;
      return fingerprint({ ...base, beforeVersion: null, channel: "npm", manager: this.npm, prefix, reference: recipe.packageName, entry: join(prefix, "bin", recipe.binName), actualEntry: "" }, "absent");
    }
    if (recipe.kind === "python" && this.uv && recipe.packageName) {
      const toolRoot = (await this.process(this.uv, ["tool", "dir"], context, false, this.nativeManagerEnvironment())).trim(), binRoot = (await this.process(this.uv, ["tool", "dir", "--bin"], context, false, this.nativeManagerEnvironment())).trim();
      if (!isAbsolute(toolRoot) || !isAbsolute(binRoot) || /[\0\r\n]/u.test(toolRoot + binRoot)) throw new ManagementError("INVALID_METADATA", "native uv tool directories are invalid");
      return fingerprint({ ...base, beforeVersion: null, channel: "uv", manager: this.uv, prefix: toolRoot, reference: recipe.packageName, entry: join(binRoot, recipe.binName), actualEntry: "" }, "absent");
    }
    if (recipe.kind === "binary") return fingerprint({ ...base, beforeVersion: null, channel: "archive", manager: "", prefix: join(this.source.home, ".local"), reference: recipe.harnessId, entry: join(this.source.home, ".local", "bin", recipe.binName), actualEntry: "" }, "absent");
    return fingerprint({ ...base, channel: "unsupported", manager: "", prefix: "", reference: recipe.packageName ?? recipe.binName, entry: "", actualEntry: "", reason: "The required local package manager is unavailable." }, "absent");
  }
  async latest(plan: NativeInstallPlan, recipe: ManagementRecipe, context: ManagementInstallContext): Promise<string> {
    if (plan.channel === "unsupported") throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", plan.reason ?? "native channel is unsupported");
    if (plan.channel === "native-cli") return "vendor-latest";
    if (plan.channel === "brew-formula" || plan.channel === "brew-cask") {
      const raw: unknown = JSON.parse(await this.process(plan.manager, ["info", "--json=v2", plan.channel === "brew-cask" ? "--cask" : "--formula", plan.reference], context));
      const rows = object(raw)[plan.channel === "brew-cask" ? "casks" : "formulae"]; if (!Array.isArray(rows) || rows.length !== 1) throw new ManagementError("INVALID_METADATA", "Homebrew returned an ambiguous installation");
      const row = object(rows[0]); return parseVersion(plan.channel === "brew-cask" ? row.version : object(row.versions).stable);
    }
    const effective = plan.channel === "npm" ? { ...recipe, kind: "npm" as const, packageName: plan.reference, referenceVersion: "latest" } : recipe;
    return (await this.metadata.resolve(effective, context.signal)).version;
  }
  async execute(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: NativeInstallContext): Promise<{ version: string; configurationPreserved: boolean }> {
    context.assertOwned();
    if (plan.reason !== null) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", plan.reason);
    if (plan.beforeVersion && valid(plan.beforeVersion) && valid(version) && !gt(version, plan.beforeVersion)) throw new ManagementError("NO_UPDATE", "the original installation is already at or above its channel version");
    // Refuse an entry appearing/changing after the plan; an install must never overwrite another program.
    if (plan.actualEntry) { if (await realpath(plan.entry) !== plan.actualEntry) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "original executable changed after planning"); }
    else { try { await lstat(plan.entry); throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "native destination already exists"); } catch (error) { if (!missing(error)) throw error; } }
    await this.assertIdle(plan, context);
    const before = await this.configurationHashes();
    switch (plan.channel) {
      case "npm": {
        const spec = await this.metadata.resolve({ ...recipe, kind: "npm", packageName: plan.reference, referenceVersion: version }, context.signal, version);
        if (spec.version !== version) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "native release metadata no longer matches the frozen target");
        if (!spec.binNames?.includes(recipe.binName)) throw new ManagementError("INVALID_METADATA", "native npm release does not declare the selected executable");
        const packageRoot = join(plan.prefix, "lib", "node_modules", plan.reference);
        for (const bin of spec.binNames) {
          try {
            const target = await realpath(join(plan.prefix, "bin", bin)), path = relative(packageRoot, target);
            if (!plan.actualEntry || path.startsWith("..") || isAbsolute(path)) throw new ManagementError("NATIVE_DESTINATION_CONFLICT", "native installation would replace another program's executable");
          } catch (error) { if (!missing(error)) throw error; }
        }
        if (spec.engines.node && !satisfies(process.versions.node, spec.engines.node)) throw new ManagementError("RUNTIME_INCOMPATIBLE", "the existing Node runtime does not satisfy this package");
        if (plan.harnessId === "openclaw") {
          const candidate = join(context.stage, "compatibility-candidate"); await mkdir(candidate, { mode: 0o700 });
          const readOnly: ManagementInstallContext = { stage: context.stage, signal: context.signal, assertOwned: context.assertOwned, log: () => {} };
          await this.process(plan.manager, ["install", "--prefix", candidate, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", plan.reference + "@" + version], readOnly, true);
          const candidateEntry = installedNpmEntry(candidate, plan.reference, version, recipe.binName);
          try { await this.process(this.node, [candidateEntry, "config", "validate", "--json"], readOnly, true, { OPENCLAW_CONFIG_PATH: nativeValues(this.source, null).OPENCLAW_CONFIG_PATH!, OPENCLAW_STATE_DIR: join(context.stage, "candidate-state") }); }
          catch (error) { if (error instanceof ManagementError && error.code === "PROCESS_FAILED") throw new ManagementError("NATIVE_CONFIGURATION_INCOMPATIBLE", "本机 OpenClaw 配置与目标版本不兼容，保留原安装；配置迁移需在 Harness 中明确处理。"); throw error; }
        }
        await this.process(plan.manager, ["install", "--global", "--prefix", plan.prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--registry=https://registry.npmjs.org", plan.reference + "@" + version], context, true);
        const manifest = await json(join(plan.prefix, "lib", "node_modules", plan.reference, "package.json"));
        if (manifest.name !== plan.reference || manifest.version !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "installed npm identity/version did not match its frozen target");
        break;
      }
      case "brew-formula": case "brew-cask":
        { const native = nativeValues(this.source, null);
          const directories = [...new Set([...configDirectories.map(path => join(this.source.home, path)), ...[native.CODEX_HOME, native.CLAUDE_CONFIG_DIR, native.OPENCODE_CONFIG_DIR, native.XDG_CONFIG_HOME, this.source.values.OPENCLAW_STATE_DIR, this.source.values.PI_CODING_AGENT_DIR].filter((value): value is string => value !== undefined)])];
          const files = [...configFiles.map(path => join(this.source.home, path)), ...(native.OPENCLAW_CONFIG_PATH ? [native.OPENCLAW_CONFIG_PATH] : [])];
          await runHomebrewProtected(plan.manager, ["upgrade", plan.channel === "brew-cask" ? "--cask" : "--formula", plan.reference], directories, files, this.env(context.stage), context); break;
        }
      case "uv":
        await this.process(plan.manager, ["tool", "install", "--no-progress", "--force", plan.reference + "==" + version], context, true, { UV_TOOL_DIR: plan.prefix, UV_TOOL_BIN_DIR: dirname(plan.entry), UV_CACHE_DIR: join(context.stage, "cache"), UV_PYTHON_DOWNLOADS: "never" }); break;
      case "archive": {
        const spec = await this.metadata.resolve(recipe, context.signal);
        if (spec.version !== version) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "archive target changed after planning");
        const candidate = join(context.stage, "archive-candidate"); await mkdir(candidate, { mode: 0o700 });
        const artifact = await new DefaultManagementInstaller({ nodeExecutable: this.node, npmExecutable: this.npm, uvExecutable: this.uv }).install(spec, { ...context, stage: candidate });
        const detected = await this.protectedVersion(artifact.command.executable, context);
        if (detected !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "archive executable did not report its frozen version");
        const parent = join(plan.prefix, "share", "harnesses", recipe.harnessId), destination = join(parent, version + "-" + randomUUID());
        for (const path of [plan.prefix, join(plan.prefix, "share"), join(plan.prefix, "share", "harnesses"), parent, dirname(plan.entry)]) {
          try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new ManagementError("NATIVE_DESTINATION_CONFLICT", "native program directory is not owned without links"); } catch (error) { if (!missing(error)) throw error; }
        }
        context.beginMutation();
        for (const path of [plan.prefix, join(plan.prefix, "share"), join(plan.prefix, "share", "harnesses"), parent, dirname(plan.entry)]) {
          try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
          const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new ManagementError("NATIVE_DESTINATION_CONFLICT", "native program directory is not owned without links");
        }
        const executable = join(destination, relative(candidate, artifact.command.executable));
        await rename(candidate, destination); await symlink(executable, plan.entry); break;
      }
      case "native-cli":
        await this.process(plan.manager, ["update"], context, true, { HOME: this.source.home, XDG_CONFIG_HOME: this.source.values.XDG_CONFIG_HOME ?? join(this.source.home, ".config") }); break;
      case "unsupported": throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", "this native update channel has not been reviewed");
    }
    context.assertOwned(); await access(plan.entry, constants.X_OK);
    const actualVersion = await this.protectedVersion(plan.entry, context);
    if (plan.channel !== "native-cli" && actualVersion !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "the actual native executable did not report the planned version");
    if (JSON.stringify(before) !== JSON.stringify(await this.configurationHashes())) throw new ManagementError("NATIVE_CONFIGURATION_CHANGED", "native maintenance changed a protected configuration");
    return { version: actualVersion, configurationPreserved: true };
  }
  private async configurationHashes(): Promise<Readonly<Record<string, string>>> {
    const result: Record<string, string> = {};
    // Content remains private; receipts only use digests. Directory write protection also covers credentials.
    for (const path of [".codex/config.toml", ".claude/settings.json", ".claude.json", ".openclaw/openclaw.json", ".gemini/settings.json", ".pi/agent/settings.json", ".pi/agent/models.json", ".cursor/cli-config.json", ".config/opencode/opencode.json", ...configFiles]) {
      const file = join(this.source.home, path); try { const info = await stat(file); if (info.size > MAX_JSON) throw new ManagementError("CONFIGURATION_LIMIT", "protected configuration exceeds its budget"); result[path] = createHash("sha256").update(await readFile(file)).digest("hex"); } catch (error) { if (!missing(error)) throw error; }
    }
    return result;
  }
  async inspect(plan: NativeInstallPlan, context: ManagementInstallContext): Promise<string> {
    await this.assertIdle(plan, context);
    context.assertOwned(); await access(plan.entry, constants.X_OK);
    const version = await this.protectedVersion(plan.entry, context);
    if (plan.channel === "npm") {
      const manifest = await json(join(plan.prefix, "lib", "node_modules", plan.reference, "package.json"));
      if (manifest.name !== plan.reference || manifest.version !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "native program and npm package disagree");
    }
    return version;
  }
  private async protectedVersion(entry: string, context: ManagementInstallContext): Promise<string> {
    let diagnostics = "";
    const readonlyContext: ManagementInstallContext = { stage: context.stage, signal: context.signal, assertOwned: context.assertOwned, log: (stream, text) => {
      diagnostics += text + "\n"; if (Buffer.byteLength(diagnostics) > 65536) throw new ManagementError("OUTPUT_LIMIT", "native version output exceeded its byte budget"); context.log(stream, text);
    } };
    const output = await this.process(entry, ["--version"], readonlyContext, true, { OPENCODE_DISABLE_AUTOUPDATE: "true" });
    const version = systemVersionFromOutput(output + "\n" + diagnostics);
    if (!version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "the native executable did not report one unambiguous version"); return version;
  }
  private async assertIdle(plan: NativeInstallPlan, context: ManagementInstallContext): Promise<void> {
    if (process.platform !== "darwin" && process.platform !== "linux") throw new ManagementError("UNSUPPORTED_PLATFORM", "native process inspection is unavailable on this host");
    // One -w bounds each command line to the platform's wide column width; do not read arbitrary prompt argv.
    const output = await this.process("/bin/ps", ["-axw", "-o", "pid=,command="], { ...context, log: () => {} });
    for (const line of output.split("\n")) {
      const parsed = /^\s*([0-9]+)\s+(.+)$/u.exec(line); if (!parsed || Number(parsed[1]) === process.pid) continue;
      const command = parsed[2]!, first = command.split(/\s/u, 1)[0];
      if (plan.actualEntry && (command.includes(plan.actualEntry.slice(0, 80)) || command.includes(plan.entry.slice(0, 80))) || plan.harnessId === "openclaw" && first === "openclaw-gateway")
        throw new ManagementError("HARNESS_BUSY", "本机程序仍有活动进程，请结束对应任务后再升级；其他对话可以继续。");
    }
  }
}
