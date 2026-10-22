import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { satisfies, valid } from "semver";
import { ManagementError, type InstallationObservation, type InstallationTarget, type InstallationUpgradeFacts, type InstallationUpgradePort, type InstallationUpdate, type ManagementInstallContext,
  type ManagementMetadataPort, type NativeInstallContext, type PreparedUpgrade, type PreparedUpgradeCheck, type RuntimeRequirement } from "../../contracts/management.js";
import { homebrewName, type ScriptUpgrade } from "../../contexts/catalog/domain/channels.js";
import { officialInstallMethod, productChannels } from "../../adapters/catalog-channels.js";
import { homebrewTap } from "../discovery/packages.js";
import { nativeBaseValues, nativeValues, type NativeEnvironment } from "../session/native-environment.js";
import { runManagementProcess } from "./process.js";
import { homebrewCache, homebrewEnvironment, runHomebrewProtected } from "./homebrew.js";
import { isolatedSandboxProfile, protectedConfigurationPaths, writeOnlySandboxProfile } from "./native.js";
import { OfficialManagementMetadata } from "./metadata.js";
import { blockedWrites, codexProfile, downloadScript, protectedProgramVersion, runConfined } from "./official-install.js";

const MAX_OUTPUT = 8 * 1024 * 1024, DRY_RUN_MS = 60_000;
/** Formulae other programs run on: upgrading one changes every program started with it, such as npm global programs on node. */
const SHARED_RUNTIMES = /^(?:node(?:@\d+)?|python(?:@[\d.]+)?|ruby(?:@[\d.]+)?|openjdk(?:@\d+)?|go|deno|bun|perl|php(?:@[\d.]+)?)$/u;
function code(error: unknown): string | undefined { return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function missing(error: unknown): boolean { return code(error) === "ENOENT" || code(error) === "ENOTDIR"; }
function inside(path: string, root: string): boolean { return path === root || path.startsWith(root + "/"); }
async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; } }

/** One package of a Homebrew upgrade plan, as its dry run printed it. */
export interface HomebrewPlanEntry { readonly name: string; readonly action: "upgrade" | "install" | "dependent"; readonly from: string | null; readonly to: string }
/**
 * The packages `brew upgrade --dry-run` would upgrade, newly install as dependencies or upgrade as installed dependents,
 * and those it marks deprecated or disabled. Lines outside those sections, such as tap warnings, are ignored.
 */
export function parseHomebrewPlan(output: string): { readonly packages: readonly HomebrewPlanEntry[]; readonly deprecated: readonly string[] } {
  let section: HomebrewPlanEntry["action"] | "deprecated" | null = null;
  const packages: HomebrewPlanEntry[] = [], deprecated: string[] = [];
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.trim().replace(/\s+/gu, " ");
    if (line.startsWith("==>")) {
      section = /^==> Would install\b/u.test(line) ? "install" : /^==> Would (?:upgrade|reinstall)\b.*\bdependents?\b/u.test(line) ? "dependent" : /^==> Would (?:upgrade|reinstall)\b/u.test(line) ? "upgrade"
        : /Deprecated or disabled/u.test(line) ? "deprecated" : null;
      continue;
    }
    if (section === null || !line) continue;
    const name = /^([A-Za-z0-9][A-Za-z0-9@._+/-]*)(?:\s|$)/u.exec(line)?.[1]; if (name === undefined) continue;
    if (section === "deprecated") { deprecated.push(name); continue; }
    const shown = line.replace(/\s\([^)]*\)$/u, ""), upgrade = /^\S+ (\S+) -> (\S+)$/u.exec(shown), install = /^\S+ (\S+)$/u.exec(shown);
    if (upgrade) packages.push({ name, action: section, from: upgrade[1]!, to: upgrade[2]! });
    else if (install) packages.push({ name, action: section === "upgrade" ? "install" : section, from: null, to: install[1]! });
  }
  return { packages: packages.slice(0, 64), deprecated: deprecated.slice(0, 64) };
}
/** A plan entry for the user: what Homebrew does with one package besides the one upgraded. */
export function homebrewPlanLine(entry: HomebrewPlanEntry): string {
  return (entry.action === "install" ? "新装 " : entry.action === "dependent" ? "升级依赖它的 " : "升级 ") + entry.name + " " + (entry.from === null ? entry.to : entry.from + " → " + entry.to);
}
/** The plan lines that change a shared runtime, such as node; every program started with it uses the new version afterwards. */
export function sharedRuntimes(dependencies: readonly string[]): readonly string[] {
  return dependencies.filter(line => SHARED_RUNTIMES.test(line.replace(/^(?:新装|升级依赖它的|升级) /u, "").split(" ", 1)[0]!));
}
/** The version Homebrew's records give an installed keg or cask: the formula's stable version with its revision, or the cask's version. */
function homebrewVersion(raw: unknown, cask: boolean): string {
  const row = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const text = (value: unknown): string => { if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.,_+-]{0,127}$/u.test(value)) throw new ManagementError("INVALID_METADATA", "Homebrew returned an unsupported version"); return value; };
  if (cask) return text(row.version);
  const versions = row.versions !== null && typeof row.versions === "object" ? row.versions as Record<string, unknown> : {}, revision = typeof row.revision === "number" && Number.isSafeInteger(row.revision) && row.revision > 0 ? row.revision : 0;
  return text(versions.stable) + (revision ? "_" + revision : "");
}

/**
 * Upgrades one official installation through its own channel on macOS (ADR-044): npm installs the exact newer release
 * with the prefix's own npm, writing only that prefix; Homebrew upgrades in its inherited sandbox from the user's local
 * records, after a dry run that must leave every installed package as it was; a script installation runs its product's
 * own updater or its official install script again, confined like an install. Versions are read without running a
 * program where the channel records one, and otherwise in a write-protected run with a private home and no network.
 */
export class LocalInstallationUpgrader implements InstallationUpgradePort {
  constructor(private readonly source: NativeEnvironment, private readonly tools: { readonly npm: string | null },
    private readonly options: { readonly metadata?: ManagementMetadataPort; readonly registry?: string; readonly fetch?: typeof fetch; readonly homebrew?: typeof runHomebrewProtected } = {}) {}
  private get registry(): string { return this.options.registry ?? "https://registry.npmjs.org"; }
  private get metadata(): ManagementMetadataPort { return this.options.metadata ?? new OfficialManagementMetadata(); }
  private path(): string { return this.source.values.PATH ?? "/usr/bin:/bin"; }
  private layout(target: InstallationObservation): ScriptUpgrade | null {
    if (target.role !== "product") return null;
    return productChannels(target.harnessId)?.scripts.find(layout => join(this.source.home, layout.root) === target.root)?.upgrade ?? null;
  }
  /** How this installation upgrades, or null when HarnessHub does not upgrade its channel (uv, pnpm, bun, an archive layout). */
  kind(target: InstallationObservation): "version" | ScriptUpgrade["kind"] | null {
    if (target.channel === "npm" || target.channel === "brew-formula" || target.channel === "brew-cask") return "version";
    return target.channel === "script" ? this.layout(target)?.kind ?? null : null;
  }
  /**
   * The name Homebrew's commands take for a Homebrew installation: `<tap>/<name>` when its install receipt names another
   * tap than Homebrew's own, so that a same-named formula of Homebrew's own (OpenCode 2 for anomalyco/tap's OpenCode 1)
   * is never queried or upgraded in its place; the bare name otherwise. Read from the receipt each time it is used.
   */
  private async formula(target: InstallationObservation): Promise<string> {
    if (target.channel !== "brew-formula" && target.channel !== "brew-cask") throw new ManagementError("INVALID_DATA", "not a Homebrew installation");
    return homebrewName(target.name, await homebrewTap(target.channel, target.root, target.resolvedPath));
  }
  /** A read that must not change anything: Homebrew's own queries in a sandbox that may write only the stage and reach no network. */
  private async brewQuery(target: InstallationObservation, args: readonly string[], context: ManagementInstallContext): Promise<string> {
    if (process.platform !== "darwin" || !(await executable("/usr/bin/sandbox-exec"))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "升级需要 macOS 的沙箱保护，这里不可用。");
    return runManagementProcess("/usr/bin/sandbox-exec", ["-p", isolatedSandboxProfile([context.stage]), join(target.prefix!, "bin", "brew"), ...args], context.stage, homebrewEnvironment(this.source, context.stage),
      { ...context, log: () => {} }, MAX_OUTPUT);
  }
  /** What Homebrew has installed, for comparing around its dry run: `brew list --versions` and every keg and cask directory's time. */
  private async homebrewState(target: InstallationObservation, context: ManagementInstallContext): Promise<string> {
    const list = await this.brewQuery(target, ["list", "--versions"], context), directories: string[] = [];
    for (const kind of ["Cellar", "Caskroom"]) {
      let names: string[] = [];
      try { names = (await readdir(join(target.prefix!, kind))).sort(); } catch (error) { if (!missing(error)) throw error; }
      for (const name of names) {
        let versions: string[] = [];
        try { versions = (await readdir(join(target.prefix!, kind, name))).sort(); } catch (error) { if (!missing(error) && code(error) !== "ENOTDIR") throw error; }
        for (const version of versions) { try { directories.push(kind + "/" + name + "/" + version + ":" + (await stat(join(target.prefix!, kind, name, version))).mtimeMs); } catch (error) { if (!missing(error)) throw error; } }
      }
    }
    return createHash("sha256").update(list + "\0" + directories.join("\n")).digest("hex");
  }
  /**
   * Homebrew's upgrade plan for `formula` (the installation's name as Homebrew's commands take it) by its own dry run, in
   * its inherited sandbox with the user's records (it checks that it could write its prefix even when it only prints).
   * It may download manifests into its cache; anything it changes among the installed packages stops the upgrade.
   */
  private async homebrewPlan(target: InstallationObservation, formula: string, context: ManagementInstallContext): Promise<ReturnType<typeof parseHomebrewPlan>> {
    const before = await this.homebrewState(target, context), { directories, files } = protectedConfigurationPaths(this.source);
    let output = "";
    const bounded: ManagementInstallContext = { stage: context.stage, signal: AbortSignal.any([context.signal, AbortSignal.timeout(DRY_RUN_MS)]), assertOwned: context.assertOwned,
      log: (stream, text) => { if (stream === "stdout" && output.length < 1024 * 1024) output += text + "\n"; } };
    try {
      output += await (this.options.homebrew ?? runHomebrewProtected)(join(target.prefix!, "bin", "brew"), ["upgrade", "--dry-run", target.channel === "brew-cask" ? "--cask" : "--formula", formula], directories, files,
        homebrewEnvironment(this.source, context.stage), bounded, { cache: "user" });
    } catch (error) {
      if (error instanceof ManagementError && error.code === "CANCELLED" && !context.signal.aborted) throw new ManagementError("HOMEBREW_DRY_RUN_TIMEOUT", "Homebrew 的升级预演 60 秒内没有完成，没有升级。");
      if (error instanceof ManagementError && error.code === "PROCESS_FAILED") throw new ManagementError("HOMEBREW_DRY_RUN_FAILED", "Homebrew 的升级预演没有成功结束，没有升级。可以在终端运行 brew upgrade --dry-run " + formula + " 查看原因。");
      throw error;
    } finally {
      // A dry run may write the prefix inside Homebrew's sandbox; one that changed an installed package is not trusted further.
      if (await this.homebrewState(target, context) !== before)
        throw new ManagementError("HOMEBREW_DRY_RUN_CHANGED", "Homebrew 的升级预演改动了已安装的包，已停止，没有升级。请在终端运行 brew list --versions 核对。");
    }
    return parseHomebrewPlan(output);
  }
  /** When Homebrew's local records were last updated: the newest API file in its cache; null when it has none. */
  private async homebrewRecords(): Promise<string | null> {
    const api = join(homebrewCache(this.source), "api");
    let newest = 0;
    for (const directory of [api, join(api, "internal")]) {
      let names: string[] = [];
      try { names = await readdir(directory); } catch (error) { if (!missing(error)) throw error; }
      for (const name of names) if (name.endsWith(".jws.json")) { try { newest = Math.max(newest, (await stat(join(directory, name))).mtimeMs); } catch (error) { if (!missing(error)) throw error; } }
    }
    return newest ? new Date(newest).toISOString() : null;
  }
  async latest(target: InstallationObservation, context: ManagementInstallContext): Promise<{ readonly version: string; readonly source: InstallationUpdate["source"] } | null> {
    if (target.channel === "npm") {
      const spec = await this.metadata.resolve({ harnessId: target.harnessId, controlId: target.controlId, kind: "npm", packageName: target.name, referenceVersion: "latest", binName: basename(target.entry), args: [],
        archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] }, context.signal);
      return { version: spec.version, source: "npm" };
    }
    if (target.channel === "brew-formula" || target.channel === "brew-cask") {
      const cask = target.channel === "brew-cask";
      const raw: unknown = JSON.parse(await this.brewQuery(target, ["info", "--json=v2", cask ? "--cask" : "--formula", await this.formula(target)], context));
      const rows = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[cask ? "casks" : "formulae"] : undefined;
      if (!Array.isArray(rows) || rows.length !== 1) throw new ManagementError("INVALID_METADATA", "Homebrew returned an ambiguous installation");
      return { version: homebrewVersion(rows[0], cask), source: "homebrew-local" };
    }
    return null;
  }
  /** The Node.js an npm prefix runs its programs with: its own, or the first on this Gateway's PATH; null when there is none. */
  private async prefixNode(prefix: string): Promise<string | null> {
    if (await executable(join(prefix, "bin", "node"))) return join(prefix, "bin", "node");
    for (const directory of this.path().split(":")) if (isAbsolute(directory) && await executable(join(directory, "node"))) return join(directory, "node");
    return null;
  }
  async prepare(target: InstallationTarget, directory: string, context: ManagementInstallContext): Promise<PreparedUpgradeCheck> {
    const home = this.source.home, kind = this.kind(target);
    const base = { target, env: {}, shellProfile: null, configFiles: [], version: null, dependencies: [], script: null, runtime: null } as const;
    if (kind === null || kind === "terminal") throw new ManagementError("UNSUPPORTED_UPGRADE", "HarnessHub 不升级这种安装。");
    if (target.channel === "npm") {
      const prefix = target.prefix; if (prefix === null) throw new ManagementError("INVALID_DATA", "an npm installation has no prefix");
      const bin = basename(target.entry);
      const spec = await this.metadata.resolve({ harnessId: target.harnessId, controlId: target.controlId, kind: "npm", packageName: target.name, referenceVersion: "latest", binName: bin, args: [],
        archiveUrl: null, archiveSha256: null, relativeExecutable: null, dependencies: [] }, context.signal);
      if (spec.binNames !== undefined && !spec.binNames.includes(bin)) throw new ManagementError("INVALID_METADATA", target.name + " " + spec.version + " 没有声明命令 " + bin + "。");
      // A command of the new release that is another program's now would be replaced by it.
      for (const name of spec.binNames ?? []) {
        try { const resolved = await realpath(join(prefix, "bin", name)); if (!inside(resolved, target.root)) throw new ManagementError("NATIVE_DESTINATION_CONFLICT", "新版本会替换 " + join(prefix, "bin", name) + "，它现在属于另一个程序。没有升级。"); }
        catch (error) { if (!missing(error)) throw error; }
      }
      let runtime: RuntimeRequirement | null = null;
      if (spec.engines.node) {
        const node = await this.prefixNode(prefix);
        let found: string | null = null;
        if (node !== null) try { found = /^v?(\d+\.\d+\.\d+)/u.exec((await runManagementProcess(node, ["--version"], context.stage, { PATH: "/usr/bin:/bin", HOME: context.stage }, { ...context, log: () => {} })).trim())?.[1] ?? null; }
        catch (error) { if (!(error instanceof ManagementError) || error.code !== "PROCESS_FAILED" && error.code !== "PROCESS_START_FAILED") throw error; }
        runtime = { runtime: "Node.js", required: spec.engines.node, found, path: node ?? join(prefix, "bin", "node"), satisfied: found !== null && valid(found) !== null && satisfies(found, spec.engines.node), service: null, restarted: true, upgradeCommand: null };
      }
      const own = join(prefix, "bin", "npm"), npm = await executable(own) ? own : this.tools.npm;
      if (npm === null) throw new ManagementError("RUNTIME_UNAVAILABLE", "找不到这份安装所在前缀的 npm，也找不到本机的 npm。");
      return { prepared: { ...base, kind: "version", command: npm + " install --global --prefix " + prefix + " " + target.name + "@" + spec.version, executable: npm,
        args: ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--registry=" + this.registry, target.name + "@" + spec.version], writes: [prefix], version: spec.version, runtime }, deprecated: [], records: null };
    }
    if (target.channel === "brew-formula" || target.channel === "brew-cask") {
      if (target.prefix === null) throw new ManagementError("INVALID_DATA", "a Homebrew installation has no prefix");
      // Homebrew lists a package by the name it was given (another tap's formula in full), so the plan's own entry is that one.
      const formula = await this.formula(target), plan = await this.homebrewPlan(target, formula, context), own = plan.packages.find(entry => entry.name === formula && entry.action === "upgrade");
      const flag = target.channel === "brew-cask" ? "--cask" : "--formula";
      return { prepared: { ...base, kind: "version", command: "brew upgrade " + flag + " " + formula, executable: join(target.prefix, "bin", "brew"), args: ["upgrade", flag, formula],
        writes: [target.prefix], version: own?.to ?? target.version, dependencies: plan.packages.filter(entry => entry !== own).map(homebrewPlanLine) },
        // The installation itself is reported under its own name, the one the caller knows it by.
        deprecated: plan.deprecated.map(name => name === formula ? target.name : name), records: await this.homebrewRecords() };
    }
    const layout = this.layout(target), method = officialInstallMethod(target.harnessId);
    if (layout === null || method?.kind !== "script") throw new ManagementError("UNSUPPORTED_UPGRADE", "HarnessHub 不升级这种安装。");
    const writes = method.writes.map(path => join(home, path)), configFiles = method.configFiles.map(path => join(home, path));
    if (layout.kind === "self-update")
      return { prepared: { ...base, kind: "self-update", command: layout.command, executable: target.entry, args: layout.args, writes, configFiles }, deprecated: [], records: null };
    if (layout.kind !== "rerun") throw new ManagementError("UNSUPPORTED_UPGRADE", "HarnessHub 不代为运行这个产品的更新。");
    const script = join(directory, "install." + method.interpreter);
    const { finalUrl, sha256 } = await downloadScript(method.url, method.hosts, script, context.signal, this.options.fetch);
    // Shown as the install confirmation shows it: what runs is the downloaded copy, with the official script's settings.
    const command = [...Object.entries(method.env).map(([key, value]) => key + "=" + value), method.interpreter, "install." + method.interpreter, ...method.args].join(" ");
    return { prepared: { ...base, kind: "rerun", command, executable: "/bin/" + method.interpreter, args: [script, ...method.args], env: method.env, writes,
      shellProfile: method.shellProfile === "codex" ? codexProfile(home, this.source.values.SHELL) : null, configFiles, script: { path: script, source: finalUrl, sha256, interpreter: method.interpreter } }, deprecated: [], records: null };
  }
  async run(prepared: PreparedUpgrade, context: NativeInstallContext): Promise<{ readonly exitCode: number; readonly facts: Pick<InstallationUpgradeFacts, "shellChanges" | "configChanges" | "blocked"> }> {
    context.assertOwned();
    const target = prepared.target;
    let output = "";
    const logged: NativeInstallContext = { ...context, log: (stream, text) => { if (output.length < 1024 * 1024) output += text + "\n"; context.log(stream, text); } };
    const failed = (error: unknown): number => { if (error instanceof ManagementError && error.code === "PROCESS_FAILED") return 1; throw error; };
    if (prepared.kind === "version" && target.channel === "npm") {
      const prefix = target.prefix!;
      if (prepared.runtime !== null && !prepared.runtime.satisfied) throw new ManagementError("RUNTIME_INCOMPATIBLE", target.name + " " + prepared.version + " 要求 Node.js " + prepared.runtime.required + "，这个前缀的 Node.js 是 " + (prepared.runtime.found ?? "读不出版本") + "。没有升级；HarnessHub 不升级 Node.js。");
      if (process.platform !== "darwin" || !(await executable("/usr/bin/sandbox-exec"))) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", "升级需要 macOS 的沙箱保护，这里不可用。");
      const env = { ...nativeBaseValues(this.source, context.stage), ...nativeValues(this.source, context.stage), PATH: join(prefix, "bin") + ":" + this.path(), LANG: "C.UTF-8", TMPDIR: context.stage, NO_COLOR: "1",
        npm_config_cache: join(context.stage, "cache"), npm_config_update_notifier: "false" };
      context.beginMutation();
      let exitCode = 0;
      // The package's own install scripts run (Claude Code's links its native binary), confined like npm itself.
      try { await runManagementProcess("/usr/bin/sandbox-exec", ["-p", writeOnlySandboxProfile([prefix, context.stage]), prepared.executable, ...prepared.args], context.stage, env, logged, MAX_OUTPUT); }
      catch (error) { exitCode = failed(error); }
      return { exitCode, facts: { shellChanges: [], configChanges: [], blocked: blockedWrites(output) } };
    }
    if (prepared.kind === "version") {
      // The plan is read again right before the upgrade; Homebrew upgrades exactly what the user confirmed, or nothing:
      // the same formula (a receipt now naming another tap changes it), target version and packages upgraded along.
      const formula = await this.formula(target), plan = await this.homebrewPlan(target, formula, context), own = plan.packages.find(entry => entry.name === formula && entry.action === "upgrade");
      if (prepared.args.at(-1) !== formula || (own?.to ?? target.version) !== prepared.version || JSON.stringify(plan.packages.filter(entry => entry !== own).map(homebrewPlanLine)) !== JSON.stringify(prepared.dependencies))
        throw new ManagementError("HOMEBREW_PLAN_CHANGED", "Homebrew 的升级计划在确认之后变了（目标版本或一并升级的包不同），没有升级。请重新打开升级确认。");
      const { directories, files } = protectedConfigurationPaths(this.source);
      let exitCode = 0;
      context.beginMutation();
      try { await (this.options.homebrew ?? runHomebrewProtected)(prepared.executable, prepared.args, directories, files, homebrewEnvironment(this.source, context.stage), logged, { cache: "user" }); }
      catch (error) { exitCode = failed(error); }
      return { exitCode, facts: { shellChanges: [], configChanges: [], blocked: blockedWrites(output) } };
    }
    if (prepared.kind === "rerun") {
      const script = prepared.script;
      if (script === null) throw new ManagementError("INVALID_DATA", "a script upgrade has no script");
      // What runs is the copy the user confirmed.
      if (createHash("sha256").update(await readFile(script.path)).digest("hex") !== script.sha256) throw new ManagementError("INSTALL_SOURCE_CHANGED", "安装脚本的副本和确认时不一致，没有运行。");
    }
    const result = await runConfined(this.source, { executable: prepared.executable, args: prepared.args, env: prepared.env, writes: prepared.writes, shellProfile: prepared.shellProfile, configFiles: prepared.configFiles }, logged);
    return { exitCode: result.exitCode, facts: { shellChanges: result.shellChanges, configChanges: result.configChanges, blocked: blockedWrites(output) } };
  }
  async version(target: InstallationObservation, context: ManagementInstallContext): Promise<string | null> {
    // The version the channel records, as the Harness list shows it; a program runs only when its channel records none.
    switch (target.channel) {
      case "npm": {
        try {
          const manifest: unknown = JSON.parse(await readFile(join(target.root, "package.json"), "utf8"));
          const version = manifest !== null && typeof manifest === "object" && "version" in manifest ? manifest.version : null;
          return typeof version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(version) ? version : null;
        } catch (error) { if (missing(error) || error instanceof SyntaxError) return null; throw error; }
      }
      case "brew-formula": case "brew-cask": case "script": {
        let resolved: string;
        try { resolved = await realpath(target.entry); } catch (error) { if (missing(error)) return null; throw error; }
        if (target.channel !== "script" || target.root.endsWith("/versions")) {
          const below = inside(resolved, target.root) ? resolved.slice(target.root.length + 1).split("/", 1)[0] : undefined;
          return below !== undefined && /^[0-9A-Za-z][0-9A-Za-z.,_+-]{0,127}$/u.test(below) ? below : null;
        }
        return protectedProgramVersion(target.entry, dirname(target.entry) + ":" + this.path(), context);
      }
      case "uv": case "pnpm": case "bun": return null;
    }
  }
}
