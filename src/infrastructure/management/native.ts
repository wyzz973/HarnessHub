import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { compare, prerelease, valid, satisfies } from "semver";
import { ManagementError, type ManagementInstallContext, type ManagementRecipe, type NativeInstallPlan, type NativeManagementPort, type SystemInstallationObservation, type NativeInstallContext, type ManagementMetadataPort, type ProgramUsage, type ResolvedInstallSpec, type RuntimeRequirement, type SequenceContext, type UpgradeSequenceRecipe, type UsedService } from "../../contracts/management.js";
import { homebrewName } from "../../contexts/catalog/domain/channels.js";
import { homebrewTap } from "../discovery/packages.js";
import { captureNativeEnvironment, nativeBaseValues, nativeValues, type NativeEnvironment } from "../session/native-environment.js";
import { OfficialManagementMetadata } from "./metadata.js";
import { DefaultManagementInstaller } from "./installer.js";
import { runManagementProcess } from "./process.js";
import { systemVersionFromOutput } from "./system-version.js";
import { homebrewEnvironment, homebrewSandboxIdentity, runHomebrewProtected } from "./homebrew.js";
import { awaitServiceRecovery, inspectProgramUsage, parseServiceState, restartProgramService, systemProgramHost, type ProgramHost } from "./program-usage.js";

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
/**
 * The sandbox profile of a read that may write only its own directories: every other file write and every network
 * operation is denied, so a query such as Homebrew's look at its local records can neither change the user's files nor
 * reach a running service or the network (ADR-043, ADR-044).
 */
export function isolatedSandboxProfile(writable: readonly string[]): string {
  return "(version 1)(allow default)(deny file-write*)(allow file-write* " + writable.map(path => "(subpath " + JSON.stringify(path) + ")").join(" ") + " (literal \"/dev/null\"))(deny network*)";
}
/** Why an upgrade stops for a runtime that does not meet the release's range; nothing has changed then. */
export function runtimeRefusal(version: string, runtime: RuntimeRequirement): string {
  return "新版本 " + version + " 要求 Node.js " + runtime.required + "，" + (runtime.service === null ? "运行它的" : runtime.service + " 启动用的") + " Node.js "
    + (runtime.found === null ? "版本读不出来" : "是 " + runtime.found) + "（" + runtime.path + "）。先升级 Node.js 再升级" + (runtime.upgradeCommand ? "（可以运行 " + runtime.upgradeCommand + "）" : "")
    + "；HarnessHub 不替你升级 Node.js。没有升级。";
}
/** A calendar version's build revision, as OpenClaw numbers them (2026.3.23-2); semver alone reads the `-2` as a prerelease. */
const CALENDAR_REVISION = /^(\d{4}\.\d{1,2}\.\d{1,2})-(\d+)$/u;
/**
 * The order of two release versions: negative when `a` is older than `b`, positive when newer, zero when the same; null
 * when either is no version this compares. Semver's order, except that a calendar version's numeric `-N` is a later
 * revision of its base release, not a prerelease of it: 2026.3.23 < 2026.3.23-2 < 2026.3.23-10 < 2026.9.5. Pure.
 */
export function compareReleases(a: string, b: string): number | null {
  const parse = (version: string): { readonly base: string; readonly revision: number } | null => {
    const revision = CALENDAR_REVISION.exec(version), base = valid(revision === null ? version : revision[1]!);
    return base === null ? null : { base, revision: revision === null ? 0 : Number(revision[2]) };
  };
  const left = parse(a), right = parse(b);
  return left === null || right === null ? null : compare(left.base, right.base) || Math.sign(left.revision - right.revision);
}
/** Whether a version is a prerelease: semver's prerelease part, except a calendar version's build revision (2026.3.23-2). */
export function isPrerelease(version: string): boolean {
  return !CALENDAR_REVISION.test(version) && valid(version) !== null && prerelease(version) !== null;
}
/**
 * Refuses installing OpenClaw's npm package on its own (the upgrade of one installation, ADR-044), before anything is
 * resolved or changed. OpenClaw upgrades through its documented sequence (ADR-052), which "升级 Harness" drives: the
 * Gateway stopped first, each release installed with its lifecycle scripts allowed and its Doctor run, the Gateway
 * started after the last. A package installed without the Doctor leaves a configuration the new Gateway refuses to start
 * on. Throws UNSUPPORTED_UPGRADE for OpenClaw and returns for every other Harness.
 */
export function refuseOpenClawNpmUpgrade(harnessId: string): void {
  if (harnessId === "openclaw") throw new ManagementError("UNSUPPORTED_UPGRADE", "OpenClaw 要按它官方文档的步骤升级：先停 Gateway，逐个版本用 npm 安装并运行 openclaw doctor --fix，最后再启动 Gateway。HarnessHub 在“升级 Harness”里按这个顺序执行，不单独 npm 直装某一份 OpenClaw（跳过 Doctor 会让新版 Gateway 拒绝启动）；路线见 ADR-052。");
}
/**
 * The hops of a product's documented upgrade sequence (ADR-052) from `installed` to `target`: the bridge release first
 * when the installed one predates upstream's cut-off and the bridge is older than the target, otherwise the target alone.
 * Pure. Fails with INVALID_METADATA when the installed version is unknown or the versions do not compare: the sequence
 * cannot then be planned truthfully, and an upgrade is not started on a guess.
 */
export function upgradeHops(sequence: UpgradeSequenceRecipe, installed: string | null, target: string): readonly { readonly version: string; readonly bridge: boolean }[] {
  if (installed === null) throw new ManagementError("INVALID_METADATA", "the installed version is unknown, so the upgrade sequence cannot be planned");
  const before = compareReleases(installed, sequence.bridge.before), bridged = compareReleases(sequence.bridge.version, target);
  if (before === null || bridged === null) throw new ManagementError("INVALID_METADATA", "the installed, bridge and target versions do not compare");
  return before < 0 && bridged < 0 ? [{ version: sequence.bridge.version, bridge: true }, { version: target, bridge: false }] : [{ version: target, bridge: false }];
}
/** How long one product command of an upgrade sequence may take (ADR-052): its Doctor migrates and may download; the service commands only talk to launchd. */
export const SEQUENCE_DOCTOR_MS = 1800 * 1000, SEQUENCE_COMMAND_MS = 120 * 1000;
/**
 * The npm that installs a sequence's hops: the prefix's own (`<prefix>/bin/npm`, whose Node.js is the one the product's
 * services start on, so the release's preinstall checks that Node.js), else the one the plan was made with.
 */
export async function sequenceNpm(plan: NativeInstallPlan): Promise<string> {
  const own = join(plan.prefix, "bin", "npm"); return await available(own) ? own : plan.manager;
}
/** The arguments of one hop's install, as documented by the product: its lifecycle scripts allowed, the public registry, the exact release. */
export function sequenceInstallArguments(plan: NativeInstallPlan, sequence: UpgradeSequenceRecipe, version: string): readonly string[] {
  return ["install", "--global", "--prefix", plan.prefix, "--no-audit", "--no-fund", ...sequence.npmFlags, "--registry=https://registry.npmjs.org", plan.reference + "@" + version];
}
const CHANNEL_REASONS = {
  project: "这个程序在源码目录或 HarnessHub 尚未支持的安装方式里，HarnessHub 不替你升级它；请用它自己的方式更新（例如在源码目录里更新，或运行它自带的更新命令）。",
  unreviewed: "这个程序的安装方式还没有经过 HarnessHub 审核，HarnessHub 不替你升级它；请用它自己的方式更新。",
  manager: "本机缺少这个程序安装方式需要的包管理器，HarnessHub 无法在这里安装或升级它。",
} as const;
/** The user's model, sign-in and shell configuration HarnessHub's package-manager runs may not write: directories and single files. */
export function protectedConfigurationPaths(source: NativeEnvironment): { readonly directories: readonly string[]; readonly files: readonly string[] } {
  const native = nativeValues(source, null);
  return { directories: [...new Set([...configDirectories.map(path => join(source.home, path)), ...[native.CODEX_HOME, native.CLAUDE_CONFIG_DIR, native.OPENCODE_CONFIG_DIR, native.XDG_CONFIG_HOME, source.values.OPENCLAW_STATE_DIR, source.values.PI_CODING_AGENT_DIR].filter((value): value is string => value !== undefined)])],
    files: [...configFiles.map(path => join(source.home, path)), ...(native.OPENCLAW_CONFIG_PATH ? [native.OPENCLAW_CONFIG_PATH] : [])] };
}
/** The sandbox profile of a package-manager run that may write only `writable` (and /dev/null); the network stays available. */
export function writeOnlySandboxProfile(writable: readonly string[]): string {
  return "(version 1)(allow default)(deny file-write*)(allow file-write* " + writable.map(path => "(subpath " + JSON.stringify(path) + ")").join(" ") + " (literal \"/dev/null\"))";
}
/** Native managers operate on standard local installation paths. The user profile remains readable and protected from writes. */
export class NativeManagement implements NativeManagementPort {
  private readonly source: NativeEnvironment;
  private prefix: Promise<string> | null = null;
  constructor(private readonly npm: string | null, private readonly uv: string | null, private readonly node: string, source?: NativeEnvironment, private readonly metadata: ManagementMetadataPort = new OfficialManagementMetadata(),
    private readonly host: ProgramHost = systemProgramHost()) { this.source = source ?? captureNativeEnvironment(); }
  private env(stage: string): Record<string, string> {
    return { ...nativeBaseValues(this.source, stage), ...nativeValues(this.source, stage), PATH: this.source.values.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", LANG: "C.UTF-8", TMPDIR: stage, NO_COLOR: "1",
      npm_config_cache: join(stage, "cache"), npm_config_update_notifier: "false", HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1" };
  }
  private nativeManagerEnvironment(): Record<string, string> {
    const values: Record<string, string> = { HOME: this.source.home };
    for (const name of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig", "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig", "NPM_CONFIG_PREFIX", "npm_config_prefix", "UV_TOOL_DIR", "UV_TOOL_BIN_DIR"]) if (this.source.values[name] !== undefined) values[name] = this.source.values[name];
    return values;
  }
  /**
   * `configuration` denies writes to the user's model, login and shell configuration; `isolated` allows writes only to
   * the stage and denies the network. Both require macOS's sandbox; elsewhere such work fails rather than runs unprotected.
   */
  private async process(executable: string, args: readonly string[], context: ManagementInstallContext, protection: "none" | "configuration" | "isolated" = "none", extra: Readonly<Record<string, string>> = {}): Promise<string> {
    context.assertOwned(); const env = { ...this.env(context.stage), ...extra };
    if (protection === "none") return runManagementProcess(executable, args, context.stage, env, context, MAX_JSON);
    if (process.platform !== "darwin" || !(await available("/usr/bin/sandbox-exec"))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "native installation requires verified configuration write protection on this host");
    if (protection === "isolated") return runManagementProcess("/usr/bin/sandbox-exec", ["-p", isolatedSandboxProfile([context.stage]), executable, ...args], context.stage, env, context, 4 * MAX_JSON);
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
      if (brew) {
        const manager = join(brew[1]!, "bin", "brew"), sdk = await homebrewSandboxIdentity(manager), channel = brew[2] === "Cellar" ? "brew-formula" as const : "brew-cask" as const;
        // The tap its receipt names belongs to the plan's identity: it decides which formula Homebrew queries and upgrades.
        const tap = await homebrewTap(channel, brew[1] + "/" + brew[2] + "/" + brew[3], actual);
        return fingerprint({ ...base, channel, manager, prefix: brew[1]!, reference: brew[3]!, entry, actualEntry: actual,
          reason: sdk === null ? "本机 Homebrew 没有受支持的配置保护接口，原安装接入可用，升级暂不可用。" : null }, identity + (sdk ?? "unsupported") + "\0" + (tap ?? ""));
      }
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
          return fingerprint({ ...base, channel: "unsupported", manager: "", prefix: directory, reference: name, entry, actualEntry: actual, reason: CHANNEL_REASONS.project }, identity);
        } catch (error) { if (!missing(error)) throw error; }
        const parent = dirname(directory); if (parent === directory) break; directory = parent;
      }
      return fingerprint({ ...base, channel: "unsupported", manager: "", prefix: dirname(actual), reference: recipe.packageName ?? recipe.binName, entry, actualEntry: actual, reason: CHANNEL_REASONS.unreviewed }, identity);
    }
    if (recipe.kind === "npm" && this.npm && recipe.packageName) {
      this.prefix ??= this.process(this.npm, ["prefix", "--global"], context, "none", this.nativeManagerEnvironment()).then(output => { const path = output.trim(); if (!isAbsolute(path) || path.includes("\n")) throw new ManagementError("INVALID_METADATA", "npm global prefix is invalid"); return path; }).finally(() => { this.prefix = null; });
      const prefix = await this.prefix;
      return fingerprint({ ...base, beforeVersion: null, channel: "npm", manager: this.npm, prefix, reference: recipe.packageName, entry: join(prefix, "bin", recipe.binName), actualEntry: "" }, "absent");
    }
    if (recipe.kind === "python" && this.uv && recipe.packageName) {
      const toolRoot = (await this.process(this.uv, ["tool", "dir"], context, "none", this.nativeManagerEnvironment())).trim(), binRoot = (await this.process(this.uv, ["tool", "dir", "--bin"], context, "none", this.nativeManagerEnvironment())).trim();
      if (!isAbsolute(toolRoot) || !isAbsolute(binRoot) || /[\0\r\n]/u.test(toolRoot + binRoot)) throw new ManagementError("INVALID_METADATA", "native uv tool directories are invalid");
      return fingerprint({ ...base, beforeVersion: null, channel: "uv", manager: this.uv, prefix: toolRoot, reference: recipe.packageName, entry: join(binRoot, recipe.binName), actualEntry: "" }, "absent");
    }
    if (recipe.kind === "binary") return fingerprint({ ...base, beforeVersion: null, channel: "archive", manager: "", prefix: join(this.source.home, ".local"), reference: recipe.harnessId, entry: join(this.source.home, ".local", "bin", recipe.binName), actualEntry: "" }, "absent");
    return fingerprint({ ...base, channel: "unsupported", manager: "", prefix: "", reference: recipe.packageName ?? recipe.binName, entry: "", actualEntry: "", reason: CHANNEL_REASONS.manager }, "absent");
  }
  async latest(plan: NativeInstallPlan, recipe: ManagementRecipe, context: ManagementInstallContext): Promise<string> {
    if (plan.channel === "unsupported") throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", plan.reason ?? "native channel is unsupported");
    if (plan.channel === "native-cli") return "vendor-latest";
    if (plan.channel === "brew-formula" || plan.channel === "brew-cask") {
      // Homebrew's local records in the user's cache, read in a sandbox that may write only the stage and reach no network;
      // the upgrade reads the same records, so the version checked is the version installed (ADR-044).
      const raw: unknown = JSON.parse(await this.process(plan.manager, ["info", "--json=v2", plan.channel === "brew-cask" ? "--cask" : "--formula", await this.formula(plan, plan.channel)], context, "isolated", homebrewEnvironment(this.source, context.stage)));
      const rows = object(raw)[plan.channel === "brew-cask" ? "casks" : "formulae"]; if (!Array.isArray(rows) || rows.length !== 1) throw new ManagementError("INVALID_METADATA", "Homebrew returned an ambiguous installation");
      const row = object(rows[0]); return parseVersion(plan.channel === "brew-cask" ? row.version : object(row.versions).stable);
    }
    const effective = plan.channel === "npm" ? { ...recipe, kind: "npm" as const, packageName: plan.reference, referenceVersion: "latest" } : recipe;
    return (await this.metadata.resolve(effective, context.signal)).version;
  }
  /**
   * The name Homebrew's commands take for a planned formula or cask: `<tap>/<name>` when its keg's (or cask's) install
   * receipt names another tap than Homebrew's own, so that Homebrew's same-named formula is never upgraded in its place.
   */
  private async formula(plan: NativeInstallPlan, channel: "brew-formula" | "brew-cask"): Promise<string> {
    return homebrewName(plan.reference, await homebrewTap(channel, join(plan.prefix, channel === "brew-cask" ? "Caskroom" : "Cellar", plan.reference), plan.actualEntry));
  }
  /** The exact npm release for `version`, refusing one that would replace another program's executable. */
  private async npmRelease(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: ManagementInstallContext): Promise<ResolvedInstallSpec> {
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
    return spec;
  }
  async prepare(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: ManagementInstallContext): Promise<void> {
    context.assertOwned();
    if (plan.reason !== null) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", plan.reason);
    if (plan.channel === "unsupported") throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", "this native update channel has not been reviewed");
    const order = plan.beforeVersion === null ? null : compareReleases(version, plan.beforeVersion);
    if (order !== null && order <= 0) throw new ManagementError("NO_UPDATE", "the original installation is already at or above its channel version");
    if (plan.channel !== "npm") return;
    // A sequence installs every hop's release on the program's interpreter: each one is resolved and its range checked, the unmet hop named.
    const hops = recipe.upgradeSequence === undefined ? [version] : upgradeHops(recipe.upgradeSequence, plan.beforeVersion, version).map(hop => hop.version);
    const interpreter = (plan.actualEntry ? await this.interpreter(plan.actualEntry) : null) ?? this.node;
    for (const hop of hops) {
      const spec = await this.npmRelease(plan, recipe, hop, context);
      const runtime = spec.engines.node ? await this.runtimeAt(interpreter, spec.engines.node, null, true, context) : null;
      if (runtime && !runtime.satisfied) throw new ManagementError("RUNTIME_INCOMPATIBLE", runtimeRefusal(hop, runtime));
    }
  }
  async execute(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: NativeInstallContext): Promise<{ version: string; configurationPreserved: boolean }> {
    context.assertOwned();
    if (plan.reason !== null) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", plan.reason);
    // Refuse an entry appearing/changing after the plan; an install must never overwrite another program.
    if (plan.actualEntry) { if (await realpath(plan.entry) !== plan.actualEntry) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "original executable changed after planning"); }
    else { try { await lstat(plan.entry); throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "native destination already exists"); } catch (error) { if (!missing(error)) throw error; } }
    const before = await this.configurationHashes();
    switch (plan.channel) {
      case "npm": {
        await this.npmRelease(plan, recipe, version, context);
        // --ignore-scripts: no lifecycle script of the package runs in this install. A package that needs them completes
        // them itself later: OpenClaw keeps .openclaw-lifecycle-pending in its package root and its launcher runs them at
        // its next start, here the protected --version check below, which fails with "package lifecycle is incomplete"
        // when they cannot run. OpenClaw's own npm installation goes through executeSequence instead (ADR-052), which
        // allows its scripts and runs its Doctor; this plain install is for the other npm products.
        await this.process(plan.manager, ["install", "--global", "--prefix", plan.prefix, "--no-audit", "--no-fund", "--ignore-scripts", "--registry=https://registry.npmjs.org", plan.reference + "@" + version], context, "configuration");
        const manifest = await json(join(plan.prefix, "lib", "node_modules", plan.reference, "package.json"));
        if (manifest.name !== plan.reference || manifest.version !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "installed npm identity/version did not match its frozen target");
        break;
      }
      case "brew-formula": case "brew-cask":
        { const { directories, files } = protectedConfigurationPaths(this.source), formula = await this.formula(plan, plan.channel);
          await runHomebrewProtected(plan.manager, ["upgrade", plan.channel === "brew-cask" ? "--cask" : "--formula", formula], directories, files, homebrewEnvironment(this.source, context.stage), context, { cache: "user" }); break;
        }
      case "uv":
        await this.process(plan.manager, ["tool", "install", "--no-progress", "--force", plan.reference + "==" + version], context, "configuration", { UV_TOOL_DIR: plan.prefix, UV_TOOL_BIN_DIR: dirname(plan.entry), UV_CACHE_DIR: join(context.stage, "cache"), UV_PYTHON_DOWNLOADS: "never" }); break;
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
        await this.process(plan.manager, ["update"], context, "configuration", { HOME: this.source.home, XDG_CONFIG_HOME: this.source.values.XDG_CONFIG_HOME ?? join(this.source.home, ".config") }); break;
      case "unsupported": throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", "this native update channel has not been reviewed");
    }
    context.assertOwned(); await access(plan.entry, constants.X_OK);
    const actualVersion = await this.protectedVersion(plan.entry, context);
    if (plan.channel !== "native-cli" && actualVersion !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "the actual native executable did not report the planned version");
    // The channel ran with writes to these files denied, so a change seen here is another running program's (a Claude Code
    // session writes ~/.claude.json, a gateway its own config): noted, not a failure of the upgrade (ADR-044).
    const after = await this.configurationHashes(), changed = Object.keys({ ...before, ...after }).filter(path => before[path] !== after[path]);
    if (changed.length) context.log("system", "升级期间这些受保护的配置文件有了变化：" + changed.map(path => "~/" + path).join("、") + "。升级在沙箱里不能写它们，变化来自仍在运行的程序。");
    return { version: actualVersion, configurationPreserved: true };
  }
  /** The interpreter of a `#!` program: absolute, or found on the user's PATH for `/usr/bin/env`; null when it has none. */
  private async interpreter(entry: string): Promise<string | null> {
    let head = "";
    try { const handle = await open(entry, "r"); try { const buffer = Buffer.alloc(256), { bytesRead } = await handle.read(buffer, 0, 256, 0); head = buffer.subarray(0, bytesRead).toString("utf8"); } finally { await handle.close(); } }
    catch (error) { if (missing(error)) return null; throw error; }
    const line = /^#![ \t]*(\S+)(?:[ \t]+(\S+))?/u.exec(head); if (!line) return null;
    if (basename(line[1]!) !== "env") return isAbsolute(line[1]!) ? line[1]! : null;
    const name = line[2]; if (name === undefined || name.startsWith("-") || name.includes("/")) return null;
    for (const directory of (this.source.values.PATH ?? "").split(":")) { if (!isAbsolute(directory)) continue; const candidate = join(directory, name); if (await available(candidate)) return candidate; }
    return null;
  }
  /** The Node.js at `path` against `required`, and how to upgrade it when it is Homebrew's. */
  private async runtimeAt(path: string, required: string, service: string | null, restarted: boolean, context: ManagementInstallContext): Promise<RuntimeRequirement> {
    let found: string | null = null;
    try { found = /^v?(\d+\.\d+\.\d+)/u.exec((await this.process(path, ["--version"], { ...context, log: () => {} })).trim())?.[1] ?? null; }
    catch (error) { if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED" && error.code !== "PROCESS_START_FAILED") throw error; }
    let upgradeCommand: string | null = null;
    try { const formula = /\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/u.exec(await realpath(path))?.[1]; if (formula) upgradeCommand = "brew upgrade " + formula; }
    catch (error) { if (!missing(error)) throw error; }
    return { runtime: "Node.js", required, found, path, satisfied: found !== null && satisfies(found, required), service, restarted, upgradeCommand };
  }
  async runtimes(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, services: readonly UsedService[], context: ManagementInstallContext): Promise<readonly RuntimeRequirement[]> {
    if (plan.channel !== "npm") return [];
    const spec = await this.metadata.resolve({ ...recipe, kind: "npm", packageName: plan.reference, referenceVersion: version }, context.signal, version), required = spec.engines.node;
    if (!required) return [];
    const result = [await this.runtimeAt((plan.actualEntry ? await this.interpreter(plan.actualEntry) : null) ?? this.node, required, null, true, context)];
    // A service's job names its own Node.js; it does not load the user's shell, so a version manager's default does not reach it.
    for (const service of services) if (service.program !== null && isAbsolute(service.program) && basename(service.program) === "node")
      result.push(await this.runtimeAt(service.program, required, service.label, service.declared?.restart === true, context));
    return result;
  }
  usage(plan: NativeInstallPlan, recipe: ManagementRecipe, context: ManagementInstallContext): Promise<ProgramUsage> { return inspectProgramUsage(plan, recipe, this.host, context); }
  restartService(service: UsedService, context: ManagementInstallContext): Promise<{ readonly pid: number; readonly ready: boolean | null } | null> { return restartProgramService(service, this.host, context); }
  async executeSequence(plan: NativeInstallPlan, recipe: ManagementRecipe, hops: readonly string[], services: readonly UsedService[], context: SequenceContext): Promise<{ readonly version: string; readonly configurationMigrated: readonly string[] }> {
    context.assertOwned();
    const sequence = recipe.upgradeSequence;
    if (sequence === undefined || plan.channel !== "npm") throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", "this installation has no documented upgrade sequence");
    if (plan.reason !== null) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", plan.reason);
    if (hops.length === 0 || hops.length > 4 || new Set(hops).size !== hops.length) throw new ManagementError("INVALID_INPUT", "an upgrade sequence has one to four distinct hops");
    if (!plan.actualEntry || await realpath(plan.entry) !== plan.actualEntry) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "original executable changed after planning");
    // Every release is resolved, and no hop may replace another program's executable, before anything stops or changes.
    for (const version of hops) await this.npmRelease(plan, recipe, version, context);
    const gateway = services.find(service => service.label === sequence.gateway.label) ?? null;
    const restarts = sequence.restarts.flatMap(item => { const service = services.find(entry => entry.label === item.label); return service === undefined ? [] : [{ service, args: item.args }]; });
    const manifest = join(plan.prefix, "lib", "node_modules", plan.reference, "package.json"), npm = await sequenceNpm(plan), before = await this.configurationHashes();
    const command = (args: readonly string[]) => [plan.entry, ...args].join(" ");
    const runs = gateway === null ? null : parseServiceState(await this.host.print(gateway.target, context) ?? "").runs;
    const startAgain = gateway === null ? "" : "可以在终端运行 " + command(sequence.gateway.start) + " 让 Gateway 恢复运行。";
    let installed = plan.beforeVersion;
    context.beginMutation();
    // 1. The gateway stops before the first release changes under it; its channels are offline until it starts again.
    if (gateway !== null) await this.product(plan, sequence.gateway.stop, context, SEQUENCE_COMMAND_MS, "GATEWAY_STOP_FAILED", "停止 " + gateway.label);
    // 2. Each hop: install with the product's lifecycle scripts allowed, verify by the manifest, then the product's Doctor.
    for (const [index, version] of hops.entries()) {
      const label = "第 " + (index + 1) + " 跳 " + version;
      try { await this.process(npm, sequenceInstallArguments(plan, sequence, version), context, "configuration"); }
      catch (error) {
        if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED" && error.code !== "PROCESS_START_FAILED" && error.code !== "OUTPUT_LIMIT") throw error;
        // npm did not finish: what is on disk is known only when its manifest still reads the release before this hop.
        const current = await this.manifestVersion(manifest, plan.reference);
        if (current !== installed) throw new ManagementError("NATIVE_VERIFICATION_FAILED", label + " 的 npm 没有成功结束，包目录现在" + (current === null ? "没有可读的清单" : "是 " + current) + "，结果未知。");
        context.hop({ version, installed: false, doctor: "skipped" });
        throw new ManagementError("HOP_INSTALL_FAILED", label + " 没有装入：npm 没有成功结束，包目录仍是 " + current + "。没有重试。" + startAgain);
      }
      const current = await this.manifestVersion(manifest, plan.reference);
      if (current !== version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", label + " 安装后包目录的版本是 " + (current ?? "读不出") + "，不是 " + version + "。");
      installed = version; context.hop({ version, installed: true, doctor: "skipped" });
      try { await this.product(plan, sequence.doctor, context, SEQUENCE_DOCTOR_MS, "DOCTOR_FAILED", label + " 的 Doctor"); }
      catch (error) {
        if (!(error instanceof ManagementError) || error.code !== "DOCTOR_FAILED") throw error;
        context.hop({ version, installed: true, doctor: "failed" });
        throw new ManagementError("DOCTOR_FAILED", error.message + " " + version + " 已装入，但它的配置迁移没有完成，Gateway 没有启动；没有回滚也没有重试。按 Doctor 的提示处理（例如先装它要求的版本并运行 " + command(sequence.doctor) + "）后，再运行 " + command(sequence.doctor) + (gateway === null ? "。" : " 与 " + command(sequence.gateway.start) + "。"));
      }
      context.hop({ version, installed: true, doctor: "ok" });
    }
    // 3. The gateway starts again with the product's command and must run again (ADR-043 决定 5); its status goes to the log.
    let failure: ManagementError | null = null;
    if (gateway !== null) {
      try { await this.product(plan, sequence.gateway.start, context, SEQUENCE_COMMAND_MS, "GATEWAY_START_FAILED", "启动 " + gateway.label); }
      catch (error) { if (!(error instanceof ManagementError) || error.code !== "GATEWAY_START_FAILED") throw error; context.service({ label: gateway.label, outcome: "not_recovered", pid: null, ready: null }); throw new ManagementError(error.code, error.message + " 新版本 " + installed + " 已安装。" + startAgain); }
      try {
        const outcome = await awaitServiceRecovery(gateway, this.host, context, runs);
        context.service({ label: gateway.label, outcome: "restarted", pid: outcome.pid, ready: outcome.ready });
        if (outcome.ready === false) failure = new ManagementError("SERVICE_NOT_READY", gateway.label + " 已重新运行（进程 " + outcome.pid + "），但 60 秒内没有在端口 " + gateway.port + " 上监听。新版本 " + installed + " 已安装。可以在终端运行 " + command(sequence.gateway.status) + " 查看它的状态，或 " + command(sequence.gateway.stop) + " 后再 " + command(sequence.gateway.start) + " 再试一次。");
        else context.log("system", gateway.label + " 已重新运行（进程 " + outcome.pid + "）" + (outcome.ready === true ? "，正在端口 " + gateway.port + " 上监听。" : "；不知道它监听的端口，可用性未验证。"));
      } catch (error) {
        if (!(error instanceof ManagementError) || error.code !== "SERVICE_NOT_RECOVERED") throw error;
        context.service({ label: gateway.label, outcome: "not_recovered", pid: null, ready: null });
        failure = new ManagementError("SERVICE_NOT_RECOVERED", "启动后 60 秒内 " + gateway.label + " 没有重新运行。新版本 " + installed + " 已安装。" + startAgain + " 没有重试。");
      }
      await this.productTail(plan, sequence.gateway.status, context);
      if (failure !== null) { if (restarts.length) context.log("system", "Gateway 没有恢复，所以没有重启 " + restarts.map(item => item.service.label).join("、") + "。"); throw failure; }
    }
    // 4. Services the product's own update leaves alone are restarted with its command, when they ran before.
    for (const { service, args } of restarts) {
      try {
        const current = parseServiceState(await this.host.print(service.target, context) ?? "").runs;
        await this.product(plan, args, context, SEQUENCE_COMMAND_MS, "SERVICE_RESTART_FAILED", "重启 " + service.label);
        const outcome = await awaitServiceRecovery({ ...service, port: null }, this.host, context, current);
        context.service({ label: service.label, outcome: "restarted", pid: outcome.pid, ready: null });
        context.log("system", service.label + " 已重新运行（进程 " + outcome.pid + "）。");
      } catch (error) {
        if (!(error instanceof ManagementError) || error.code !== "SERVICE_NOT_RECOVERED" && error.code !== "SERVICE_RESTART_FAILED") throw error;
        context.service({ label: service.label, outcome: "not_recovered", pid: null, ready: null });
        failure ??= new ManagementError(error.code, (error.code === "SERVICE_RESTART_FAILED" ? error.message : "重启后 60 秒内 " + service.label + " 没有重新运行。") + " 新版本 " + installed + " 已安装，Gateway 已恢复。可以在终端运行 " + command(args) + " 再试一次。");
      }
    }
    if (failure !== null) throw failure;
    // 5. The Doctor rewrites the product's own configuration: expected and recorded. Any other protected file that changed was another running program's.
    const after = await this.configurationHashes(), changed = Object.keys({ ...before, ...after }).filter(path => before[path] !== after[path]);
    const migrated = changed.filter(path => sequence.migrates.includes(path)), others = changed.filter(path => !sequence.migrates.includes(path));
    if (others.length) context.log("system", "升级期间这些受保护的配置文件有了变化：" + others.map(path => "~/" + path).join("、") + "。升级在沙箱里不能写它们，变化来自仍在运行的程序。");
    return { version: hops[hops.length - 1]!, configurationMigrated: migrated.map(path => "~/" + path) };
  }
  /** The version an npm package's manifest records, or null when there is no readable manifest of that package. */
  private async manifestVersion(manifest: string, reference: string): Promise<string | null> {
    try { const value = await json(manifest); return value.name === reference && typeof value.version === "string" ? parseVersion(value.version) : null; }
    catch (error) { if (missing(error) || error instanceof ManagementError || error instanceof SyntaxError) return null; throw error; }
  }
  /**
   * Runs one of the product's own commands of an upgrade sequence with the user's real home and profile (it migrates
   * configuration and talks to launchd), the stage as TMPDIR and a deadline. Its output goes to the job log; a failure or
   * the deadline becomes `code` with the command and the last lines said.
   */
  private async product(plan: NativeInstallPlan, args: readonly string[], context: ManagementInstallContext, deadlineMs: number, code: string, what: string): Promise<string> {
    const line = [plan.entry, ...args].join(" "), tail: string[] = [];
    context.log("system", what + "：" + line);
    const bounded: ManagementInstallContext = { stage: context.stage, assertOwned: context.assertOwned, signal: AbortSignal.any([context.signal, AbortSignal.timeout(deadlineMs)]),
      log: (stream, text) => { context.log(stream, text); tail.push(text.slice(0, 256)); if (tail.length > 8) tail.shift(); } };
    try { return await this.process(plan.entry, args, bounded, "none", this.productEnvironment(plan)); }
    catch (error) {
      if (!(error instanceof ManagementError)) throw error;
      if (error.code === "CANCELLED" && !context.signal.aborted) throw new ManagementError(code, what + "（" + line + "）在 " + deadlineMs / 1000 + " 秒内没有结束。");
      if (error.code === "PROCESS_FAILED" || error.code === "PROCESS_START_FAILED" || error.code === "OUTPUT_LIMIT") throw new ManagementError(code, what + "（" + line + "）没有成功结束" + (tail.length ? "：" + tail.join(" / ") : "") + "。");
      throw error;
    }
  }
  /** The user's real home, profile directories and the product's own variables (`OPENCLAW_*` for openclaw): a product command of a sequence runs where the product lives, not in the stage. */
  private productEnvironment(plan: NativeInstallPlan): Readonly<Record<string, string>> { return { ...nativeBaseValues(this.source, null, plan.harnessId), ...nativeValues(this.source, null) }; }
  /** The last lines of a product's status command, captured to the log; a status that fails is said as such and changes nothing. */
  private async productTail(plan: NativeInstallPlan, args: readonly string[], context: ManagementInstallContext): Promise<void> {
    const line = [plan.entry, ...args].join(" "), tail: string[] = [];
    const quiet: ManagementInstallContext = { stage: context.stage, assertOwned: context.assertOwned, signal: AbortSignal.any([context.signal, AbortSignal.timeout(SEQUENCE_COMMAND_MS)]),
      log: (_stream, text) => { tail.push(text.slice(0, 512)); if (tail.length > 40) tail.shift(); } };
    let outcome = "";
    try { await this.process(plan.entry, args, quiet, "none", this.productEnvironment(plan)); }
    catch (error) { if (!(error instanceof ManagementError) || error.code === "CANCELLED" && context.signal.aborted) throw error; outcome = "（命令" + (error.code === "CANCELLED" ? "在 " + SEQUENCE_COMMAND_MS / 1000 + " 秒内没有结束" : "没有成功结束") + "）"; }
    context.log("system", line + outcome + "：");
    for (const text of tail) context.log("stdout", text);
  }
  async configuration(): Promise<string> { return JSON.stringify(await this.configurationHashes()); }
  /** Directory names under the product's plugin directory, for the confirmation; hidden ones (a product's own backups) are not plugins, and contents are never read. */
  async plugins(recipe: ManagementRecipe): Promise<readonly string[]> {
    if (recipe.pluginDirectory === undefined) return [];
    try { return (await readdir(join(this.source.home, recipe.pluginDirectory), { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[A-Za-z0-9@][A-Za-z0-9._@-]{0,95}$/u.test(entry.name)).map(entry => entry.name).sort().slice(0, 32); }
    catch (error) { if (missing(error)) return []; throw error; }
  }
  private configurationHashes(): Promise<Readonly<Record<string, string>>> { return protectedConfigurationHashes(this.source.home); }
  async inspect(plan: NativeInstallPlan, context: ManagementInstallContext): Promise<string> {
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
    const output = await this.process(entry, ["--version"], readonlyContext, "configuration", { OPENCODE_DISABLE_AUTOUPDATE: "true" });
    const version = systemVersionFromOutput(output + "\n" + diagnostics);
    if (!version) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "the native executable did not report one unambiguous version"); return version;
  }
}
/**
 * Digests of the user's protected model, sign-in and shell configuration files under `home`, and of `extra` home-relative
 * files, compared around maintenance (ADR-043, ADR-044). Contents stay private; a missing file is left out.
 */
export async function protectedConfigurationHashes(home: string, extra: readonly string[] = []): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  for (const path of [".codex/config.toml", ".claude/settings.json", ".claude.json", ".openclaw/openclaw.json", ".gemini/settings.json", ".pi/agent/settings.json", ".pi/agent/models.json", ".cursor/cli-config.json", ".config/opencode/opencode.json", ...configFiles, ...extra]) {
    const file = join(home, path); try { const info = await stat(file); if (info.size > MAX_JSON) throw new ManagementError("CONFIGURATION_LIMIT", "protected configuration exceeds its budget"); result[path] = createHash("sha256").update(await readFile(file)).digest("hex"); } catch (error) { if (!missing(error)) throw error; }
  }
  return result;
}
