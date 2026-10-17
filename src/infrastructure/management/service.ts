import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, lstat, realpath, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { gt, prerelease, valid } from "semver";
import { ManagementError, type HarnessManagementView, type InstallCapability, type InstallationJobView, type InstallationLog, type NativeManagementPort, type NativeInstallPlan, type ManagementInstallContext,
  type ManagementInstallerPort, type ManagementMetadataPort, type ManagementRecipe, type ResolvedManagedControl, type MaintenanceCheck, type NativeJobFacts, type NativeProgramUsers, type RuntimeRequirement, type ServiceRestartFact,
  type InstallationObservation, type InstallationRemovalPort, type InstallationTarget, type UninstallCheck, type UninstallFacts, type InstallCheck, type OfficialInstallPort, type PreparedInstall,
  type InstallationUpgradePort, type InstallationUpgradeCheck, type InstallationUpgradeFacts, type InstallationUpdate, type PreparedUpgrade, type UpgradeKind } from "../../contracts/management.js";
import type { SystemInstallationObservation, SystemVersionProbeOptions } from "../../contracts/management.js";
import { boundedManagementLimit, installationJobId, installationRef, managementCommand, managementSlug, parseManagementInput } from "../../contexts/management/domain/input.js";
import { builtinManagementRecipes } from "../../adapters/management/recipes.js";
import { DefaultManagementInstaller, installedNpmEntry } from "./installer.js";
import { insideManagement } from "./archive.js";
import { OfficialManagementMetadata } from "./metadata.js";
import { boundedManagementFile, managementIdentity, managementStorage, sameManagementIdentity } from "./storage.js";
import { managementInteger, managementObject, parseInstallationRecord, parseInstallationTarget, parseInstallRequest, parseManagementJob, parseManagementLog, parseManagementUpdate, parseNativePlan, parseUpgradeRequest, type InstallationRecord } from "../../contexts/management/domain/state.js";
import { probeSystemVersion } from "./system-version.js";
import { adapterVersionVerification, versionVerification } from "./verified-versions.js";
import { NativeManagement, runtimeRefusal } from "./native.js";
import { NativeInstallationLocks } from "./native-lock.js";
import { captureNativeEnvironment, type NativeEnvironment } from "../session/native-environment.js";
import { officialInstallMethod, productChannels, productMaintenance } from "../../adapters/catalog-channels.js";
import { prefixLabel } from "../../contexts/catalog/domain/channels.js";
import { LocalInstallationRemoval } from "./uninstall.js";
import { LocalOfficialInstaller } from "./official-install.js";
import { LocalInstallationUpgrader, sharedRuntimes } from "./installation-upgrade.js";

export interface ManagementOptions {
  readonly installationMode?: "native" | "private-fixture";
  readonly native?: NativeManagementPort;
  readonly nativeEnvironment?: NativeEnvironment;
  readonly nativeLocks?: NativeInstallationLocks;
  readonly assertOwner: () => void;
  readonly ownerGeneration: number;
  readonly metadata?: ManagementMetadataPort;
  readonly installer?: ManagementInstallerPort;
  readonly recipes?: readonly ManagementRecipe[];
  readonly npmExecutable?: string;
  readonly nodeExecutable?: string;
  readonly uvExecutable?: string;
  readonly now?: () => Date;
  readonly runTimeoutMs?: number;
  readonly redactor?: (text: string) => string;
  readonly systemVersionProbe?: (observation: SystemInstallationObservation, options: SystemVersionProbeOptions) => Promise<{ version: string | null; reason: string | null }>;
  /** Removes official installations (ADR-044); the host's own by default, none in private-fixture mode unless given. */
  readonly removal?: InstallationRemovalPort;
  /** Installs missing products the official way (ADR-044); the host's own by default, none in private-fixture mode unless given. */
  readonly officialInstaller?: OfficialInstallPort;
  /** The npm registry official npm installs use; the public registry unless a test serves its own. */
  readonly npmRegistry?: string;
  /** Upgrades one official installation through its channel (ADR-044); the host's own by default, none in private-fixture mode unless given. */
  readonly installationUpgrader?: InstallationUpgradePort;
}
/** How long a prepared official install or installation upgrade waits for the user's confirmation (ADR-044). */
const INSTALL_CHECK_MS = 15 * 60 * 1000;
/** A Homebrew upgrade may build or download for longer than other maintenance (ADR-044). */
const HOMEBREW_UPGRADE_MS = 15 * 60 * 1000;
const openRoots = new Set<string>();
function importedFile(path: string): string { return new TextDecoder("utf8", { fatal: true }).decode(boundedManagementFile(path, 4096)); }
function relativeSlot(root: string, path: string): string { return relative(root, path).replaceAll("\\", "/"); }
const terminal = (status: InstallationJobView["status"]): boolean => ["completed", "cancelled", "failed", "unknown"].includes(status);
function json(value: unknown): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 65536) throw new ManagementError("INVALID_DATA", "management record exceeded its byte budget");
  try { return JSON.parse(value); } catch { throw new ManagementError("INVALID_DATA", "management record is invalid"); }
}
function executable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    try { const path = realpathSync(join(directory, name)); if (lstatSync(path).isFile()) return path; } catch { /* unavailable candidate */ }
  } return null;
}
/** The command that returns an original installation to its version before an upgrade, where its channel has one. */
function rollbackCommand(plan: NativeInstallPlan): string | null {
  if (plan.beforeVersion === null) return null;
  if (plan.channel === "npm") return "npm install --global " + plan.reference + "@" + plan.beforeVersion;
  if (plan.channel === "uv") return "uv tool install --force " + plan.reference + "==" + plan.beforeVersion;
  return null;
}
export class LocalHarnessManagement {
  private readonly storage: ReturnType<typeof managementStorage>;
  private readonly recipes: readonly ManagementRecipe[];
  private readonly metadata: ManagementMetadataPort;
  private readonly installer: ManagementInstallerPort;
  private readonly node: string;
  private readonly npm: string | null;
  private readonly uv: string | null;
  private readonly timeout: number;
  private readonly native: NativeManagementPort | null;
  private readonly nativePlans = new Map<string, NativeInstallPlan>();
  private readonly nativeLocks: NativeInstallationLocks;
  private readonly redactor: (text: string) => string;
  private runner: Promise<void> | null = null;
  private readonly checks = new Set<Promise<unknown>>();
  private readonly checkControllers = new Set<AbortController>();
  private readonly system = new Map<string, SystemInstallationObservation>();
  private readonly systemVersions = new Map<string, { fingerprint: string; version: string | null }>();
  /** Versions of products whose control entry is an adapter, keyed by Harness; the product command is the fingerprint. */
  private readonly programVersions = new Map<string, { fingerprint: string; version: string | null }>();
  private active: { id: string; controller: AbortController; timedOut: boolean } | null = null;
  /** HarnessHub's own conversations using native programs; attached once the session runtime exists (ADR-043). */
  private users: NativeProgramUsers | null = null;
  private accepting = true;
  private closed = false;
  private stopping: Promise<void> | null = null;
  /** The official installations of each Harness in search order, from the latest scan (ADR-044). */
  private readonly installations = new Map<string, readonly InstallationObservation[]>();
  private readonly removal: InstallationRemovalPort | null;
  /** The user's home as given and as resolved: paths shown to the user are written with ~ (ADR-044). */
  private readonly homes: readonly string[];
  private readonly source: NativeEnvironment;
  private readonly officialInstaller: OfficialInstallPort | null;
  /** Official installs prepared for a confirmation, by fingerprint, until they expire or are submitted (ADR-044). */
  private readonly prepared = new Map<string, { readonly harnessId: string; readonly prepared: PreparedInstall; readonly directory: string; readonly expires: number }>();
  private readonly upgrader: InstallationUpgradePort | null;
  /** The latest version each installation's channel knew at the last update check, by reference; kept in memory only (ADR-044). */
  private readonly updates = new Map<string, InstallationUpdate>();
  /** Installation upgrades prepared for a confirmation, by fingerprint, until they expire or are submitted (ADR-044). */
  private readonly preparedUpgrades = new Map<string, { readonly harnessId: string; readonly ref: string; readonly prepared: PreparedUpgrade; readonly directory: string; readonly expires: number }>();
  constructor(root: string, private readonly options: ManagementOptions) {
    options.assertOwner(); this.timeout = options.runTimeoutMs ?? 10 * 60 * 1000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 20 || this.timeout > 10 * 60 * 1000) throw new ManagementError("INVALID_INPUT", "invalid installation timeout");
    this.node = realpathSync(options.nodeExecutable ?? process.execPath); this.npm = options.npmExecutable ?? executable("npm"); this.uv = options.uvExecutable ?? executable("uv");
    this.redactor = options.redactor ?? (text => text); this.recipes = options.recipes ?? builtinManagementRecipes();
    this.metadata = options.metadata ?? new OfficialManagementMetadata();
    this.native = options.installationMode === "private-fixture" ? null : options.native ?? new NativeManagement(this.npm, this.uv, this.node, options.nativeEnvironment);
    const source = options.nativeEnvironment ?? captureNativeEnvironment(); this.source = source;
    this.removal = options.removal ?? (options.installationMode === "private-fixture" ? null : new LocalInstallationRemoval(source, { npm: this.npm, uv: this.uv }));
    this.officialInstaller = options.officialInstaller ?? (options.installationMode === "private-fixture" ? null
      : new LocalOfficialInstaller(source, { npm: this.npm }, { metadata: this.metadata, ...(options.npmRegistry === undefined ? {} : { registry: options.npmRegistry }) }));
    this.upgrader = options.installationUpgrader ?? (options.installationMode === "private-fixture" ? null
      : new LocalInstallationUpgrader(source, { npm: this.npm }, { metadata: this.metadata, ...(options.npmRegistry === undefined ? {} : { registry: options.npmRegistry }) }));
    let realHome = source.home; try { realHome = realpathSync(source.home); } catch { /* a home that cannot be resolved is shown as given */ }
    this.homes = [...new Set([realHome, source.home])].sort((left, right) => right.length - left.length);
    this.nativeLocks = options.nativeLocks ?? new NativeInstallationLocks();
    this.installer = options.installer ?? new DefaultManagementInstaller({ nodeExecutable: this.node, npmExecutable: this.npm, uvExecutable: this.uv });
    if (openRoots.has(join(realpathSync(root), "management"))) throw new ManagementError("MANAGEMENT_BUSY", "management root already has an owner in this process");
    this.storage = managementStorage(root, options.ownerGeneration);
    if (openRoots.has(this.storage.root)) { this.storage.db.close(); throw new ManagementError("MANAGEMENT_BUSY", "management root already has an owner in this process"); }
    openRoots.add(this.storage.root);
    try {
      this.auditStorage();
      for (const row of this.storage.db.prepare("SELECT id FROM management_jobs WHERE status NOT IN('completed','cancelled','failed','unknown')").all()) {
        if (typeof row.id !== "string") throw new ManagementError("INVALID_DATA", "invalid interrupted job identity");
        const job = this.readJob(row.id); this.saveJob({ ...job,
        status: job.status === "queued" ? "cancelled" : "unknown", phase: "interrupted", updatedAt: this.now(),
        error: { code: "INTERRUPTED", message: "previous management owner ended before installation settlement; work is not replayed" } });
      }
      // Prepared installs live only as long as this owner; the copies of finished jobs are no longer needed.
      rmSync(join(this.storage.root, "install-checks"), { recursive: true, force: true });
      const jobs = join(this.storage.root, "install-jobs");
      if (existsSync(jobs)) for (const name of readdirSync(jobs)) if (/^management-[0-9a-f-]{36}$/u.test(name)) rmSync(join(jobs, name), { recursive: true, force: true });
    } catch (error) { openRoots.delete(this.storage.root); this.storage.db.close(); throw error; }
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private own(): void {
    if (this.closed) throw new ManagementError("MANAGEMENT_CLOSED", "management service is closed");
    try { this.options.assertOwner(); this.storage.assertIdentity(); }
    catch (error) { this.accepting = false; this.active?.controller.abort(); for (const check of this.checkControllers) check.abort(); throw error; }
  }
  private admission(): void { this.own(); if (!this.accepting) throw new ManagementError("MANAGEMENT_CLOSED", "management service is shutting down"); }
  private recipe(harness: string, control?: string): ManagementRecipe | null {
    const candidates = this.recipes.filter(item => item.harnessId === harness);
    if (control !== undefined) return candidates.find(item => item.controlId === control) ?? null;
    return candidates.find(item => item.controlId === "codex-native" || item.controlId === "openclaw-native" || item.controlId === "pi-native") ?? candidates.find(item => item.kind === "npm") ?? candidates[0] ?? null;
  }
  capability(harnessId: string): InstallCapability | null {
    this.own(); const recipe = this.recipe(managementSlug(harnessId)); if (!recipe) return null;
    let reason: string | null = null;
    if (harnessId === "kimi") reason = "legacy Kimi CLI description is archived; the new Kimi Code recipe must be reviewed";
    else if (recipe.kind === "npm" && this.npm === null && this.options.installer === undefined) reason = "npm runtime was not found";
    else if (recipe.kind === "python" && this.uv === null && this.options.installer === undefined) reason = "uv runtime was not found";
    return { controlId: recipe.controlId, kind: recipe.kind, sourceLabel: recipe.kind === "binary" ? "ACP reviewed release archive" : recipe.kind === "npm" ? "npm registry" : "PyPI / private uv tool",
      packageName: recipe.packageName, referenceVersion: recipe.referenceVersion, canInstall: reason === null, reason };
  }
  private systemFingerprint(observation: SystemInstallationObservation): string { return createHash("sha256").update(JSON.stringify(observation)).digest("hex"); }
  /** Read-only inventory observations do not launch programs and do not erase an unchanged version observation. */
  setSystemObservations(entries: readonly SystemInstallationObservation[]): void {
    this.own(); const external: unknown = entries;
    if (!Array.isArray(external) || entries.length > 256) throw new ManagementError("INVALID_INPUT", "too many system installations observed");
    const chosen = new Map<string, SystemInstallationObservation>();
    for (const entry of entries) {
      managementSlug(entry.harnessId); managementSlug(entry.controlId);
      if (!isAbsolute(entry.command.executable) || entry.command.args.length > 64 || entry.command.args.some(arg => typeof arg !== "string" || arg.length > 4096))
        throw new ManagementError("INVALID_INPUT", "invalid system installation command observation");
      if (entry.program !== undefined && (!isAbsolute(entry.program.executable) || entry.program.args.length > 64 || entry.program.args.some(arg => typeof arg !== "string" || arg.length > 4096)))
        throw new ManagementError("INVALID_INPUT", "invalid product command observation");
      const preferred = this.recipe(entry.harnessId)?.controlId, existing = chosen.get(entry.harnessId);
      if (existing === undefined || entry.controlId === preferred) chosen.set(entry.harnessId, {
        harnessId: entry.harnessId, controlId: entry.controlId, command: { executable: entry.command.executable, args: [...entry.command.args], env: { ...entry.command.env } },
        ...(entry.packageVersion === undefined ? {} : { packageVersion: entry.packageVersion }),
        ...(entry.program === undefined ? {} : { program: { executable: entry.program.executable, args: [...entry.program.args], env: { ...entry.program.env } } }) });
    }
    this.system.clear(); for (const [id, entry] of chosen) this.system.set(id, entry);
  }
  private systemVersion(harnessId: string): string | null {
    const observation = this.system.get(harnessId); if (!observation) return null;
    const cached = this.systemVersions.get(harnessId); if (cached?.fingerprint === this.systemFingerprint(observation)) return cached.version;
    return observation.packageVersion !== undefined && valid(observation.packageVersion) ? observation.packageVersion : null;
  }
  /** Resolve local channels after discovery. Inspection never installs packages. */
  refreshNativeCapabilities(): Promise<void> {
    this.admission(); const operation = this.refreshNativeOwned(); this.checks.add(operation);
    void operation.then(() => this.checks.delete(operation), () => this.checks.delete(operation)); return operation;
  }
  private async refreshNativeOwned(): Promise<void> {
    if (!this.native) return;
    const recipes = this.recipes; let index = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const recipe = recipes[index++]; if (!recipe || !this.accepting) return;
        const observation = this.system.get(recipe.harnessId);
        let plan: NativeInstallPlan;
        try { plan = await this.nativeInspection(context => this.native!.describe(recipe, observation?.controlId === recipe.controlId ? observation : undefined, observation?.controlId === recipe.controlId ? this.systemVersion(recipe.harnessId) : null, context)); }
        catch (error) {
          if (error instanceof ManagementError && ["OWNER_LOST", "OWNERSHIP_LOST", "MANAGEMENT_CLOSED", "CLEANUP_FAILED", "INVALID_STORAGE"].includes(error.code)) throw error;
          const entry = observation?.command.executable ?? "";
          plan = { harnessId: recipe.harnessId, controlId: recipe.controlId, channel: "unsupported", manager: "", prefix: "", entry, actualEntry: entry, beforeVersion: this.systemVersion(recipe.harnessId), reference: recipe.packageName ?? recipe.binName,
            fingerprint: createHash("sha256").update(JSON.stringify({ recipe: recipe.controlId, entry })).digest("hex"), reason: "无法确认这个本机入口的安装渠道；原程序保留，其他 Harness 可继续使用。" };
        }
        this.own(); this.nativePlans.set(recipe.harnessId + ":" + recipe.controlId, parseNativePlan(plan));
      }
    }));
  }
  private async nativeInspection<T>(action: (context: ManagementInstallContext) => Promise<T>, timeoutMs = 15000): Promise<T> {
    const stage = await realpath(await mkdtemp(join(this.storage.root, "native-inspect-"))), identity = managementIdentity(stage, true);
    const controller = new AbortController(); this.checkControllers.add(controller); const timer = setTimeout(() => controller.abort(), timeoutMs); let quiescent = true;
    const owned = () => { this.own(); if (!sameManagementIdentity(identity, managementIdentity(stage, true))) throw new ManagementError("OWNERSHIP_LOST", "native inspection directory changed"); };
    try { return await action({ stage, signal: controller.signal, assertOwned: owned, log: () => {} }); }
    catch (error) { if (error instanceof ManagementError && error.code === "CLEANUP_FAILED") quiescent = false; throw error; }
    finally { clearTimeout(timer); this.checkControllers.delete(controller); owned(); if (quiescent) await rm(stage, { recursive: true, force: true }); }
  }
  /** Lets upgrades see and close HarnessHub's own conversations' processes (ADR-043); attached once, after the runtime exists. */
  attachProgramUsers(users: NativeProgramUsers): void {
    if (this.users !== null) throw new ManagementError("INVALID_STATE", "program users are already attached"); this.users = users;
  }
  /**
   * The official installations the latest scan found (ADR-044), each Harness's in search order. Replaces the previous
   * set; an uninstall check or submission names one of these by its reference.
   */
  setInstallations(entries: readonly InstallationObservation[]): void {
    this.own(); const external: unknown = entries;
    if (!Array.isArray(external) || entries.length > 1024) throw new ManagementError("INVALID_INPUT", "too many installations observed");
    const grouped = new Map<string, InstallationObservation[]>();
    for (const entry of entries) {
      managementSlug(entry.harnessId); managementSlug(entry.controlId);
      if (!installationRef(entry.ref) || entry.role !== "product" && entry.role !== "adapter" || !["npm", "brew-formula", "brew-cask", "script", "uv", "pnpm", "bun"].includes(entry.channel) || typeof entry.active !== "boolean"
          || [entry.root, entry.entry, entry.resolvedPath, ...(entry.prefix === null ? [] : [entry.prefix])].some(path => typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/u.test(path))
          || typeof entry.name !== "string" || !entry.name || entry.name.length > 256 || typeof entry.label !== "string" || !entry.label || entry.label.length > 256 || entry.version !== null && (typeof entry.version !== "string" || entry.version.length > 128))
        throw new ManagementError("INVALID_INPUT", "invalid installation observation");
      grouped.set(entry.harnessId, [...(grouped.get(entry.harnessId) ?? []), { ...entry }]);
    }
    this.installations.clear(); for (const [id, list] of grouped) this.installations.set(id, list);
  }
  /** A path or command for the user: the home directory written as ~; nothing else is rewritten. */
  private shown(text: string): string {
    let result = text;
    for (const home of this.homes) result = result.split(home + "/").join("~/").replace(new RegExp("(^|\\s)" + home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "(?=\\s|$)", "gu"), "$1~");
    return result;
  }
  private observation(harnessId: string, ref: string, action: "uninstall" | "upgrade" = "uninstall"): InstallationObservation {
    const found = this.installations.get(harnessId)?.find(item => item.ref === ref);
    if (!found) throw new ManagementError("INSTALLATION_NOT_FOUND", "没有找到这份安装，它可能已经变化。请重新检测后再试。");
    if (found.channel === "pnpm" || found.channel === "bun") throw new ManagementError(action === "uninstall" ? "UNSUPPORTED_UNINSTALL" : "UNSUPPORTED_UPGRADE", "当前版本不维护 pnpm、bun 全局安装。");
    return found;
  }
  /** The observation with its file identities: the fingerprint changes once the installation is updated, replaced or removed. */
  private async targetOf(observation: InstallationObservation): Promise<InstallationTarget> {
    const identity = await this.removal!.identity(observation);
    return { ...observation, fingerprint: createHash("sha256").update(JSON.stringify(observation) + "\0" + identity).digest("hex") };
  }
  /**
   * What uninstalling one installation would remove, stop and leave (ADR-044), read once for the user's confirmation:
   * the channel's commands or the whitelisted files, the product's services it stops and unregisters first, what blocks it,
   * the data it keeps, and which installation is used afterwards. Changes nothing; the uninstall checks again before it does.
   */
  async uninstallCheck(harnessId: string, ref: string): Promise<UninstallCheck> {
    this.admission(); const id = managementSlug(harnessId);
    if (!installationRef(ref)) throw new ManagementError("INVALID_INPUT", "invalid installation reference");
    if (this.removal === null) throw new ManagementError("UNSUPPORTED_UNINSTALL", "这里不提供卸载。");
    const removal = this.removal, observation = this.observation(id, ref), target = await this.targetOf(observation);
    const preview = await this.nativeInspection(context => removal.preview(observation, context)); this.own();
    const usage = await this.nativeInspection(context => removal.usage(observation, context)); this.own();
    const localChanges = await this.nativeInspection(context => removal.localChanges(observation, context)); this.own();
    const maintenance = productMaintenance(id), records = observation.active ? await this.nativeLocks.users(id) : { live: [], stale: 0 };
    const siblings = (this.installations.get(id) ?? []).filter(item => item.role === observation.role && item.ref !== observation.ref);
    const kept: string[] = [];
    for (const path of maintenance.data) {
      const absolute = join(this.homes[this.homes.length - 1]!, path);
      try { await lstat(absolute); } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error; }
      const inner = preview.removes.filter(removed => removed.startsWith(absolute + "/") || this.homes.some(home => removed.startsWith(join(home, path) + "/")));
      kept.push(this.shown(absolute) + (inner.length ? "（其中的 " + inner.map(item => this.shown(item)).join("、") + " 会删除）" : ""));
    }
    return { harnessId: id, ref, checkedAt: this.now(), fingerprint: target.fingerprint, channel: observation.channel as UninstallCheck["channel"], label: observation.label, role: observation.role,
      version: observation.version, active: observation.active, commands: preview.commands.map(command => this.shown(command)), removes: preview.removes.map(path => this.shown(path)),
      skipped: preview.skipped.map(item => ({ path: this.shown(item.path), reason: item.reason })), documented: preview.documented, kept,
      services: usage.services.flatMap(service => { const declared = maintenance.services.find(item => item.label === service.label);
        return declared === undefined ? [] : [{ label: service.label, name: declared.name, pid: service.pid, commands: declared.stop.map(args => this.shown([observation.entry, ...args].join(" "))), interrupts: declared.interrupts }]; }),
      undeclaredServices: usage.services.filter(service => !maintenance.services.some(item => item.label === service.label)).map(service => ({ label: service.label, pid: service.pid })),
      resident: usage.resident, processes: usage.processes, conversations: observation.active ? this.users?.list(id) ?? [] : [], otherUsers: records.live.map(pid => ({ pid })), localChanges,
      after: !observation.active ? { kind: "unchanged" } : siblings[0] === undefined ? { kind: "none" } : { kind: "next", label: siblings[0].label, version: siblings[0].version } };
  }
  /**
   * Queues the uninstall of one installation the user confirmed (ADR-044). Refused when the installation changed since
   * the confirmation, and idempotent per command identity like every management job.
   */
  async submitUninstall(input: unknown): Promise<InstallationJobView> {
    this.admission(); this.payloadBudgets(); const request = parseManagementInput(input);
    if (request.action !== "uninstall" || request.installation === undefined || request.expectedInstallationFingerprint === undefined) throw new ManagementError("INVALID_INPUT", "an uninstall names an installation and its confirmed check");
    if (this.removal === null) throw new ManagementError("UNSUPPORTED_UNINSTALL", "这里不提供卸载。");
    const stopServices = request.stopServices ?? [];
    const fingerprint = createHash("sha256").update(JSON.stringify({ harnessId: request.harnessId, action: "uninstall", installation: request.installation, expectedInstallationFingerprint: request.expectedInstallationFingerprint, stopServices })).digest("hex");
    const existing = () => { const prior = this.storage.db.prepare("SELECT id,fingerprint FROM management_jobs WHERE command_id=?").get(request.commandId);
      if (!prior) return null; if (prior.fingerprint !== fingerprint || typeof prior.id !== "string") throw new ManagementError("COMMAND_CONFLICT", "management command already used different input"); return this.readJob(prior.id); };
    const prior = existing(); if (prior) return prior;
    const observation = this.observation(request.harnessId, request.installation), target = await this.targetOf(observation); this.admission();
    if (target.fingerprint !== request.expectedInstallationFingerprint) throw new ManagementError("INSTALLATION_CHANGED", "这份安装在确认之后有了变化，没有卸载。请重新打开卸载确认。");
    const again = existing(); if (again) return again;
    if (this.storage.db.prepare("SELECT id FROM management_commands WHERE id=?").get(request.commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used by cancellation");
    if (this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(request.harnessId)) throw new ManagementError("MANAGEMENT_BUSY", "this Harness already has an active installation job");
    const queued = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs WHERE status='queued'").get()?.n;
    if (typeof queued !== "number" || queued >= 8 || this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n === 2048) throw new ManagementError("QUEUE_LIMIT", "installation job queue or storage budget exhausted");
    const time = this.now(), job: InstallationJobView = { id: "management-" + randomUUID(), harnessId: target.harnessId, controlId: target.controlId, action: "uninstall", status: "queued", phase: "queued",
      cancelRequested: false, createdAt: time, updatedAt: time, resolvedVersion: target.version, installationId: null, error: null, logCursor: 0,
      native: { channel: target.channel, location: this.shown(target.entry), beforeVersion: target.version, actualVersion: null, dispatched: false, configurationPreserved: null,
        uninstall: { label: target.label, role: target.role, stopServices, stoppedServices: [], removed: false } } };
    parseManagementJob(job); parseInstallationTarget(target);
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
      this.storage.db.prepare("INSERT INTO management_jobs(id,harness_id,status,command_id,fingerprint,expected_revision,view_json) VALUES(?,?,?,?,?,?,?)").run(job.id, job.harnessId, job.status, request.commandId, fingerprint, this.defaultRevision(job.harnessId), JSON.stringify(job));
      this.storage.db.prepare("INSERT INTO management_installation_targets(job_id,target_json) VALUES(?,?)").run(job.id, JSON.stringify(target));
      this.storage.db.exec("COMMIT");
    } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
    this.schedule(); return job;
  }
  /** Whether this Gateway installs missing products the official way (ADR-044); not in private-fixture mode unless given an installer. */
  offersOfficialInstall(): boolean { return this.officialInstaller !== null; }
  /** A private directory under the management root for one prepared or submitted install. */
  private installDirectory(kind: "install-checks" | "install-jobs", name: string): string {
    const parent = join(this.storage.root, kind); mkdirSync(parent, { recursive: true, mode: 0o700 }); managementIdentity(parent, true);
    const directory = join(parent, name); mkdirSync(directory, { mode: 0o700 }); managementIdentity(directory, true); return directory;
  }
  private pruneChecks(): void {
    for (const [fingerprint, entry] of this.prepared) if (entry.expires < Date.now()) { this.prepared.delete(fingerprint); rmSync(entry.directory, { recursive: true, force: true }); }
  }
  /** Which program a terminal with this Gateway's PATH runs for `command` now, and whether the new installation comes first. */
  private terminalAfter(prepared: PreparedInstall): InstallCheck["terminal"] {
    const directories = (this.source.values.PATH ?? "").split(":").filter(isAbsolute), target = dirname(prepared.entry);
    let current: string | null = null;
    for (const directory of directories) { try { const path = join(directory, prepared.command); if (lstatSync(path)) { current = directory; break; } } catch { /* not in this directory */ } }
    const known = current === null ? undefined : (this.installations.get(prepared.harnessId) ?? []).find(item => dirname(item.entry) === current && basename(item.entry) === prepared.command);
    const before = current === null ? null : known?.label ?? "非官网安装（" + this.shown(join(current, prepared.command)) + "）";
    const index = directories.indexOf(target);
    return { command: prepared.command, before, after: index === -1 ? "not-on-path" : current === null || index <= directories.indexOf(current) ? "this" : "unchanged" };
  }
  /**
   * What installing a missing product the official way would run, write and change (ADR-044), prepared once for the user's
   * confirmation: the script is downloaded and hashed here, or the exact npm release and the prefix's Node.js are read.
   * Changes nothing of the user's; the prepared install waits 15 minutes for its submission.
   */
  async installCheck(harnessId: string): Promise<InstallCheck> {
    this.admission(); const id = managementSlug(harnessId), method = officialInstallMethod(id), installer = this.officialInstaller;
    if (installer === null) throw new ManagementError("UNSUPPORTED_INSTALL", "这里不提供安装。");
    if (method === null || method.kind === "terminal") throw new ManagementError("UNSUPPORTED_INSTALL", method?.kind === "terminal" ? method.reason : "HarnessHub 没有记录这个产品的官网安装方式。");
    this.pruneChecks();
    const directory = this.installDirectory("install-checks", randomUUID());
    let prepared: PreparedInstall;
    try { prepared = await this.nativeInspection(context => installer.prepare(id, directory, { ...context, signal: AbortSignal.any([context.signal]) })); this.own(); }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    const fingerprint = createHash("sha256").update(JSON.stringify(prepared)).digest("hex"), expires = Date.now() + INSTALL_CHECK_MS;
    this.prepared.set(fingerprint, { harnessId: id, prepared, directory, expires });
    const installed = (this.installations.get(id) ?? []).filter(item => item.role === "product");
    const blocked = installed.length ? "这台电脑上已经有 " + installed.map(item => item.label).join("、") + " 的官网安装，HarnessHub 不再安装第二份。"
      : prepared.runtime !== null && !prepared.runtime.satisfied ? prepared.source + " 要求 Node.js " + prepared.runtime.required + "，安装用的 Node.js（" + this.shown(prepared.runtime.path) + "）是 " + (prepared.runtime.found ?? "读不出版本") + "。请先升级这个 Node.js；HarnessHub 不安装 Node.js。" : null;
    const target = prepared.version === null ? null : versionVerification(id, prepared.version, null);
    const runs = prepared.method === "npm" ? this.shown([prepared.npm!, "install", "--global", "--prefix", prepared.prefix!, prepared.package + "@" + prepared.version].join(" "))
      : [...Object.entries(prepared.env).map(([key, value]) => key + "=" + value), prepared.interpreter!, "install." + prepared.interpreter, ...prepared.args].join(" ");
    return { harnessId: id, checkedAt: this.now(), fingerprint, expiresAt: new Date(expires).toISOString(), method: prepared.method, officialCommand: method.command,
      docs: method.kind === "npm" ? "https://www.npmjs.com/package/" + method.package : method.url, source: prepared.source, sha256: prepared.sha256, runs,
      writes: prepared.writes.map(path => this.shown(path)), shellProfile: prepared.shellProfile === null ? null : this.shown(prepared.shellProfile), configFiles: prepared.configFiles.map(path => this.shown(path)),
      version: prepared.version, prefix: prepared.prefix === null ? null : { label: prefixLabel(prepared.prefix, this.source.home), path: this.shown(prepared.prefix) },
      runtime: prepared.runtime === null ? null : { ...prepared.runtime, path: this.shown(prepared.runtime.path) }, terminal: this.terminalAfter(prepared), target,
      notes: [...method.notes, ...(prepared.method === "script" ? ["装好后，如果不是 HarnessHub 用真实程序验证过的版本，会提示“未经验证的版本”。"] : [])], blocked };
  }
  /** Queues the official install the user confirmed (ADR-044); the prepared copy moves into the job's own directory. */
  submitOfficialInstall(input: unknown): InstallationJobView {
    this.admission(); this.payloadBudgets(); const request = parseManagementInput(input);
    if (request.action !== "install" || request.expectedInstallFingerprint === undefined) throw new ManagementError("INVALID_INPUT", "an official install names its confirmed check");
    const fingerprint = createHash("sha256").update(JSON.stringify({ harnessId: request.harnessId, action: "install", expectedInstallFingerprint: request.expectedInstallFingerprint })).digest("hex");
    const prior = this.storage.db.prepare("SELECT id,fingerprint FROM management_jobs WHERE command_id=?").get(request.commandId);
    if (prior) { if (prior.fingerprint !== fingerprint || typeof prior.id !== "string") throw new ManagementError("COMMAND_CONFLICT", "management command already used different input"); return this.readJob(prior.id); }
    this.pruneChecks();
    const entry = this.prepared.get(request.expectedInstallFingerprint);
    if (entry === undefined || entry.harnessId !== request.harnessId) throw new ManagementError("INSTALL_CHECK_EXPIRED", "安装确认已过期或已经用过，请重新打开安装确认。");
    if ((this.installations.get(request.harnessId) ?? []).some(item => item.role === "product")) throw new ManagementError("INSTALLATION_CHANGED", "这个产品已经有官网安装了，没有安装第二份。");
    if (entry.prepared.runtime !== null && !entry.prepared.runtime.satisfied) throw new ManagementError("RUNTIME_INCOMPATIBLE", "安装用的 Node.js 不满足新版本的要求，没有安装。");
    if (this.storage.db.prepare("SELECT id FROM management_commands WHERE id=?").get(request.commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used by cancellation");
    if (this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(request.harnessId)) throw new ManagementError("MANAGEMENT_BUSY", "this Harness already has an active installation job");
    const queued = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs WHERE status='queued'").get()?.n;
    if (typeof queued !== "number" || queued >= 8 || this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n === 2048) throw new ManagementError("QUEUE_LIMIT", "installation job queue or storage budget exhausted");
    const id = "management-" + randomUUID(), parent = join(this.storage.root, "install-jobs"); mkdirSync(parent, { recursive: true, mode: 0o700 }); managementIdentity(parent, true);
    const directory = join(parent, id); renameSync(entry.directory, directory); managementIdentity(directory, true); this.prepared.delete(request.expectedInstallFingerprint);
    const prepared: PreparedInstall = { ...entry.prepared, script: entry.prepared.script === null ? null : join(directory, basename(entry.prepared.script)) };
    const time = this.now(), job: InstallationJobView = { id, harnessId: request.harnessId, controlId: request.harnessId, action: "install", status: "queued", phase: "queued", cancelRequested: false, createdAt: time, updatedAt: time,
      resolvedVersion: null, installationId: null, error: null, logCursor: 0,
      native: { channel: prepared.method, location: this.shown(prepared.entry), beforeVersion: null, actualVersion: null, dispatched: false, configurationPreserved: null,
        official: { method: prepared.method, source: prepared.source, sha256: prepared.sha256, shellChanges: [], configChanges: [], blocked: [], installed: false } } };
    parseManagementJob(job); parseInstallRequest({ ...prepared, fingerprint: request.expectedInstallFingerprint });
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
      this.storage.db.prepare("INSERT INTO management_jobs(id,harness_id,status,command_id,fingerprint,expected_revision,view_json) VALUES(?,?,?,?,?,?,?)").run(id, job.harnessId, job.status, request.commandId, fingerprint, this.defaultRevision(job.harnessId), JSON.stringify(job));
      this.storage.db.prepare("INSERT INTO management_install_requests(job_id,request_json) VALUES(?,?)").run(id, JSON.stringify({ ...prepared, fingerprint: request.expectedInstallFingerprint }));
      this.storage.db.exec("COMMIT");
    } catch (error) { this.storage.db.exec("ROLLBACK"); renameSync(directory, entry.directory); throw error; }
    this.schedule(); return job;
  }
  /**
   * Runs one official install (ADR-044): the product must still be missing; the prepared script or npm release runs
   * confined to what it declares; then the product must be found in its official channel and report its version. A
   * failed install is not retried or rolled back; whatever it left can be uninstalled from the Harness list.
   */
  private async runOfficialInstallJob(job: InstallationJobView): Promise<void> {
    const installer = this.officialInstaller, row = this.storage.db.prepare("SELECT request_json FROM management_install_requests WHERE job_id=?").get(job.id);
    const request = parseInstallRequest(json(row?.request_json));
    if (installer === null || job.native?.official === undefined || request.harnessId !== job.harnessId) { this.phase(job.id, "failed", { error: { code: "UNSUPPORTED_INSTALL", message: "这里不提供安装。" } }); return; }
    const controller = new AbortController(), active = { id: job.id, controller, timedOut: false }; this.active = active;
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, this.timeout);
    let stage: string | undefined, identity: ReturnType<typeof managementIdentity> | undefined, dispatched = false, ran = false, quiescent = true;
    const owned = () => { this.own(); if (controller.signal.aborted) throw new ManagementError("CANCELLED", "install was cancelled"); if (!stage || !identity || !sameManagementIdentity(identity, managementIdentity(stage, true))) throw new ManagementError("OWNERSHIP_LOST", "install directory changed"); };
    const note = (text: string) => this.log(job.id, "system", this.shown(text));
    const official = (patch: Partial<NonNullable<NativeJobFacts["official"]>>, native: Partial<NativeJobFacts> = {}) => {
      const current = this.readJob(job.id); if (!current.native?.official) throw new ManagementError("INVALID_DATA", "official install facts are missing");
      this.saveJob({ ...current, native: { ...current.native, ...native, official: { ...current.native.official, ...patch } }, updatedAt: this.now() });
    };
    try {
      stage = await realpath(await mkdtemp(join(this.storage.root, "install-job-"))); identity = managementIdentity(stage, true);
      const context: ManagementInstallContext = { stage, signal: controller.signal, assertOwned: owned, log: (stream, text) => this.log(job.id, stream, this.shown(text)) };
      this.phase(job.id, "resolving");
      if ((this.installations.get(job.harnessId) ?? []).some(item => item.role === "product")) throw new ManagementError("INSTALLATION_CHANGED", "这个产品已经有官网安装了，没有安装第二份。");
      note(request.method === "npm" ? "用 npm 安装 " + request.source + "，装到 " + request.prefix + "。" : "运行官方安装脚本 " + request.source + "（SHA-256 " + request.sha256 + "）。");
      this.phase(job.id, "installing");
      const outcome = await installer.run(request, { ...context, beginMutation: () => { owned(); if (dispatched) return; official({}, { dispatched: true }); dispatched = true; } }); owned(); ran = true;
      const shown = { ...outcome.facts, shellChanges: outcome.facts.shellChanges.map(change => ({ file: this.shown(change.file), added: change.added.map(line => this.redactor(this.shown(line))), removed: change.removed.map(line => this.redactor(this.shown(line))) })),
        configChanges: outcome.facts.configChanges.map(change => ({ file: this.shown(change.file), keys: change.keys })), blocked: outcome.facts.blocked.map(path => this.shown(path)) };
      official(shown);
      for (const change of shown.shellChanges) note("安装脚本改了 " + change.file + "：加了 " + change.added.length + " 行，删了 " + change.removed.length + " 行。");
      for (const change of shown.configChanges) note("安装程序改了 " + change.file + " 的 " + change.keys.map(key => key.path).join("、") + "。");
      for (const path of shown.blocked) note("安装程序尝试写入 " + path + "，已被阻止。");
      this.phase(job.id, "verifying");
      const found = await installer.verify(request, context); owned();
      if (outcome.exitCode !== 0) throw new ManagementError("INSTALL_FAILED", "安装程序没有成功结束" + (shown.blocked.length ? "（它尝试写入 " + shown.blocked.join("、") + "，已被阻止）" : "") + "。没有重试；留下的文件可以在“我的 Agent”里卸载。");
      if (found === null) throw new ManagementError("INSTALL_NOT_FOUND", "安装结束了，但没有在官网渠道里找到 " + request.command + "（" + this.shown(request.entry) + "）。没有重试。");
      if (found.version === null) throw new ManagementError("INSTALL_VERSION_UNKNOWN", "已经装好 " + request.command + "，但读不出它的版本。");
      official({ installed: true }, { actualVersion: found.version, configurationPreserved: true });
      const verification = versionVerification(job.harnessId, found.version, null);
      if (verification?.state === "unverified") note("这个版本还不是 HarnessHub 用真实程序验证过的版本（验证过的是 " + verification.program + "）。仍然可以使用，部分能力可能不同。");
      note("已核实：" + request.command + " " + found.version + " 装在官网渠道里。");
      this.phase(job.id, "completed", { resolvedVersion: found.version });
      this.systemVersions.delete(job.harnessId);
    } catch (error) {
      this.own(); const failure = error instanceof ManagementError ? error : new ManagementError("INSTALL_FAILED", "install did not finish");
      quiescent = failure.code !== "CLEANUP_FAILED";
      // The installer's own result is known once it ran; an interruption while it ran leaves the result unknown.
      const known = ran && ["INSTALL_FAILED", "INSTALL_NOT_FOUND", "INSTALL_VERSION_UNKNOWN"].includes(failure.code);
      const status = known ? "failed" : dispatched || !quiescent || failure.code === "OWNERSHIP_LOST" ? "unknown" : controller.signal.aborted ? "cancelled" : "failed";
      this.phase(job.id, status, { error: { code: active.timedOut ? "INSTALL_TIMEOUT" : failure.code, message: this.redactor(this.shown(failure.message)) } });
    } finally {
      clearTimeout(timer); this.active = null;
      if (quiescent && stage && identity && sameManagementIdentity(identity, managementIdentity(stage, true))) await rm(stage, { recursive: true, force: true });
      if (quiescent) rmSync(join(this.storage.root, "install-jobs", job.id), { recursive: true, force: true });
    }
  }
  private uninstallFacts(id: string, patch: Partial<UninstallFacts>, native: Partial<NativeJobFacts> = {}): void {
    const current = this.readJob(id); if (!current.native?.uninstall) throw new ManagementError("INVALID_DATA", "uninstall job facts are missing");
    this.saveJob({ ...current, native: { ...current.native, ...native, uninstall: { ...current.native.uninstall, ...patch } }, updatedAt: this.now() });
  }
  private storedTarget(id: string): InstallationTarget {
    const row = this.storage.db.prepare("SELECT target_json FROM management_installation_targets WHERE job_id=?").get(id);
    return parseInstallationTarget(json(row?.target_json));
  }
  /**
   * Runs one uninstall (ADR-044). Everything that changes nothing comes first: the installation must be the one confirmed,
   * its removal is planned again, and services the product does not declare, its resident programs, HarnessHub conversations
   * in a Turn (for the installation this Gateway runs) and services the user did not agree to stop refuse it. Then idle kept
   * processes close, the product's own commands stop and unregister its services, and the channel removes the program; the
   * protected configuration is compared around the removal, and the files are checked gone. Nothing is retried or rolled back.
   */
  private async runUninstallJob(job: InstallationJobView): Promise<void> {
    const target = this.storedTarget(job.id), facts = job.native?.uninstall;
    if (this.removal === null || facts === undefined) { this.phase(job.id, "failed", { error: { code: "UNSUPPORTED_UNINSTALL", message: "这里不提供卸载。" } }); return; }
    if (target.harnessId !== job.harnessId) throw new ManagementError("INVALID_DATA", "installation target is not owned by this job");
    const removal = this.removal, controller = new AbortController(), active = { id: job.id, controller, timedOut: false }; this.active = active;
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, this.timeout);
    let stage: string | undefined, identity: ReturnType<typeof managementIdentity> | undefined;
    let dispatched = false, verified = false, quiescent = true, lock: ReturnType<NativeInstallationLocks["write"]> | undefined;
    const owned = () => { this.own(); if (controller.signal.aborted) throw new ManagementError("CANCELLED", "uninstall was cancelled"); if (!stage || !identity || !sameManagementIdentity(identity, managementIdentity(stage, true))) throw new ManagementError("OWNERSHIP_LOST", "uninstall directory changed"); lock?.assertOwned(); };
    const note = (text: string) => this.log(job.id, "system", this.shown(text));
    const begin = () => { owned(); if (dispatched) return; this.uninstallFacts(job.id, {}, { dispatched: true }); dispatched = true; };
    const stopped: string[] = [];
    try {
      stage = await realpath(await mkdtemp(join(this.storage.root, "uninstall-job-"))); identity = managementIdentity(stage, true);
      const context: ManagementInstallContext = { stage, signal: controller.signal, assertOwned: owned, log: (stream, text) => this.log(job.id, stream, this.shown(text)) };
      this.phase(job.id, "resolving");
      const current = this.installations.get(job.harnessId)?.find(item => item.ref === target.ref);
      if (current === undefined || (await this.targetOf(current)).fingerprint !== target.fingerprint) throw new ManagementError("INSTALLATION_CHANGED", "这份安装在确认之后有了变化，没有卸载。请重新打开卸载确认。");
      owned(); const preview = await removal.preview(target, context); owned();
      if (preview.removes.length) note("将删除：" + preview.removes.join("、") + "。");
      for (const item of preview.skipped) note("保留 " + item.path + "：" + item.reason + "。");
      const usage = await removal.usage(target, context); owned();
      const maintenance = productMaintenance(job.harnessId), consent = new Set(facts.stopServices);
      const undeclared = usage.services.filter(service => !maintenance.services.some(item => item.label === service.label));
      if (undeclared.length) throw new ManagementError("SERVICE_UNDECLARED", "这份安装有后台服务 " + undeclared.map(item => item.label).join("、") + " 在运行，HarnessHub 不知道怎样按产品的方式停止它们，没有卸载。请先在终端停止它们。");
      if (usage.resident.length) throw new ManagementError("PROGRAM_RUNNING", usage.resident.map(item => item.name + "（进程 " + item.pid + "）").join("、") + " 正在运行，没有卸载。"
        + [...new Set(usage.resident.flatMap(item => item.stop === undefined ? [] : [item.stop]))].map(command => "可以运行 " + command + " 停止它，").join("") + "停止后再卸载。");
      const stops = usage.services.map(service => maintenance.services.find(item => item.label === service.label)!);
      const unagreed = stops.filter(service => !consent.has(service.label));
      if (unagreed.length) throw new ManagementError("SERVICE_CONSENT_REQUIRED", "卸载需要先停止并注销 " + unagreed.map(service => service.label).join("、") + "，这次请求没有同意。请重新打开卸载确认。");
      if (target.active) {
        const busy = this.users?.list(job.harnessId).filter(item => item.busy).length ?? 0;
        if (busy) throw new ManagementError("HARNESS_BUSY", "有 " + busy + " 个 HarnessHub 对话正在使用这个程序（正在回复或等你处理），等它们结束或停止后再卸载。");
        const others = await this.nativeLocks.users(job.harnessId);
        if (others.live.length) throw new ManagementError("HARNESS_BUSY", "另一个 HarnessHub 进程（进程 " + others.live.slice(0, 4).join("、") + "）正在使用这个程序，等它结束后再卸载。");
      }
      if (usage.processes.length) note("这些程序仍在运行这份安装，不会被关闭，卸载后可能出错：" + usage.processes.slice(0, 12).map(item => item.name + "（进程 " + item.pid + "）").join("、") + "。");
      this.phase(job.id, "installing");
      if (target.active) {
        const closed = this.users === null ? 0 : await this.users.closeIdle(job.harnessId); owned();
        if (closed) { this.uninstallFacts(job.id, {}, { closedConversations: closed }); note("关闭了 " + closed + " 个对话保留的进程。"); }
        lock = this.nativeLocks.write(job.harnessId, job.id);
        if (lock.cleared.length) { this.uninstallFacts(job.id, {}, { clearedRecords: lock.cleared.length }); note("清除了 " + lock.cleared.length + " 条已结束的 HarnessHub 进程留下的使用记录。"); }
      }
      const before = await removal.configuration(target);
      for (const service of stops) {
        begin(); note("停止并注销 " + service.label + "（" + service.name + "）。");
        await removal.stopService(target, service, context); owned();
        stopped.push(service.label); this.uninstallFacts(job.id, { stoppedServices: [...stopped] });
      }
      if (stops.length) {
        const again = await removal.usage(target, context); owned();
        if (again.services.length || again.resident.length) throw new ManagementError("SERVICE_STILL_RUNNING", "停止并注销服务之后，" + [...again.services.map(item => item.label), ...again.resident.map(item => item.name)].join("、") + " 仍在运行，没有删除程序。");
      }
      const afterServices = await removal.configuration(target);
      if (afterServices !== before) { this.uninstallFacts(job.id, {}, { configurationChangedByService: true }); note("停止服务时受保护的配置文件有了变化：这是产品自己的命令写入的，HarnessHub 没有写入。"); }
      await removal.remove(target, { ...context, beginMutation: begin }); owned();
      this.phase(job.id, "verifying");
      if (await removal.remains(target)) throw new ManagementError("REMOVAL_INCOMPLETE", "卸载命令结束了，但这份安装还有文件留在原处。");
      // The removal cannot write configuration (package managers run sandboxed, scripts are removed by whitelist); a change
      // seen here comes from programs still running, such as a Claude Code session writing ~/.claude.json, and is only noted.
      if (await removal.configuration(target) !== afterServices) note("卸载期间受保护的配置文件有了变化。卸载没有写入它们（包管理器在沙箱里不能写配置，脚本安装只删白名单里的文件），变化来自仍在运行的程序。");
      verified = true; this.uninstallFacts(job.id, { removed: true }, { configurationPreserved: true });
      note("已核实程序已删除，配置、登录和会话数据保留。");
      this.phase(job.id, "completed");
      this.systemVersions.delete(job.harnessId); this.programVersions.delete(job.harnessId);
    } catch (error) {
      this.own(); const failure = error instanceof ManagementError ? error : new ManagementError("UNINSTALL_FAILED", "uninstall did not finish");
      quiescent = failure.code !== "CLEANUP_FAILED";
      const status = dispatched || !quiescent || failure.code === "OWNERSHIP_LOST" ? "unknown" : controller.signal.aborted ? "cancelled" : "failed";
      const done = stopped.length ? "已停止并注销 " + stopped.join("、") + "。" : "";
      this.phase(job.id, status, { error: { code: active.timedOut ? "INSTALL_TIMEOUT" : failure.code, message: this.redactor(this.shown(failure.message + (status === "unknown" && done ? done : ""))) } });
    } finally {
      clearTimeout(timer); this.active = null;
      lock?.release(verified || !dispatched && quiescent);
      if (quiescent && stage && identity && sameManagementIdentity(identity, managementIdentity(stage, true))) await rm(stage, { recursive: true, force: true });
    }
  }
  /**
   * How one installation upgrades (ADR-044): through ADR-043's upgrade (`maintenance`) when it is the installation the
   * Harness's control runs and its product declares services that upgrade restarts; otherwise through its own channel, or
   * only by a command for the terminal; null when HarnessHub does not upgrade it.
   */
  installationUpgrade(harnessId: string, ref: string): { readonly kind: UpgradeKind | "terminal" | "maintenance"; readonly update: InstallationUpdate | null } | null {
    this.own(); const observation = this.installations.get(harnessId)?.find(item => item.ref === ref);
    if (observation === undefined || this.upgrader === null || observation.channel === "pnpm" || observation.channel === "bun") return null;
    const kind = this.upgrader.kind(observation); if (kind === null) return null;
    return { kind: this.throughMaintenance(observation) ? "maintenance" : kind, update: this.updates.get(ref) ?? null };
  }
  /** Whether ADR-043's upgrade owns this installation: the product declares services and its control runs from this installation. */
  private throughMaintenance(observation: InstallationObservation): boolean {
    if (productMaintenance(observation.harnessId).services.length === 0 || observation.role !== "product") return false;
    const recipe = this.recipe(observation.harnessId), plan = recipe && this.native ? this.nativePlans.get(observation.harnessId + ":" + recipe.controlId) : undefined;
    return plan !== undefined && plan.channel !== "unsupported" && !!plan.actualEntry && (plan.actualEntry === observation.resolvedPath || plan.actualEntry.startsWith(observation.root + "/"));
  }
  /** The latest version of every npm and Homebrew installation of `harnessIds`, each within 15 seconds; failures are kept per installation. */
  private async checkInstallations(harnessIds: readonly string[] | null): Promise<void> {
    const upgrader = this.upgrader; if (upgrader === null) return;
    const targets = [...this.installations.entries()].filter(([id]) => harnessIds === null || harnessIds.includes(id)).flatMap(([, list]) => list)
      .filter(item => item.channel === "npm" || item.channel === "brew-formula" || item.channel === "brew-cask");
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
      for (;;) {
        const target = targets[index++]; if (target === undefined || !this.accepting) return;
        try {
          const latest = await this.nativeInspection(context => upgrader.latest(target, context)); this.own();
          if (latest !== null) this.updates.set(target.ref, { ref: target.ref, latest: latest.version, source: latest.source, checkedAt: this.now(), error: null });
        } catch (error) {
          this.own(); if (error instanceof ManagementError && ["OWNER_LOST", "OWNERSHIP_LOST", "MANAGEMENT_CLOSED", "INVALID_STORAGE"].includes(error.code)) throw error;
          this.updates.set(target.ref, { ref: target.ref, latest: null, source: target.channel === "npm" ? "npm" : "homebrew-local", checkedAt: this.now(), error: "没有查到最新版本" });
        }
      }
    }));
  }
  private pruneUpgrades(): void {
    for (const [fingerprint, entry] of this.preparedUpgrades) if (entry.expires < Date.now()) { this.preparedUpgrades.delete(fingerprint); rmSync(entry.directory, { recursive: true, force: true }); }
  }
  /**
   * What upgrading one installation through its channel would run, write and change (ADR-044), prepared once for the
   * user's confirmation: the exact release and the Node.js it needs, Homebrew's dry run, or the downloaded official script;
   * which programs run the installation now, and what blocks it. Changes no installed program; the prepared upgrade waits
   * 15 minutes for its submission, and the upgrade checks again before it changes anything.
   */
  async upgradeCheck(harnessId: string, ref: string): Promise<InstallationUpgradeCheck> {
    this.admission(); const id = managementSlug(harnessId);
    if (!installationRef(ref)) throw new ManagementError("INVALID_INPUT", "invalid installation reference");
    if (this.upgrader === null || this.removal === null) throw new ManagementError("UNSUPPORTED_UPGRADE", "这里不提供升级。");
    const upgrader = this.upgrader, removal = this.removal, observation = this.observation(id, ref, "upgrade"), kind = upgrader.kind(observation);
    if (kind === null) throw new ManagementError("UNSUPPORTED_UPGRADE", "HarnessHub 不升级这种安装。");
    if (this.throughMaintenance(observation)) throw new ManagementError("UNSUPPORTED_UPGRADE", "这份安装有产品的后台服务，请用“升级 Harness”：它会在升级后按产品的方式重启服务。");
    const target = await this.targetOf(observation), checkedAt = this.now(), others = (this.installations.get(id) ?? []).filter(item => item.role === observation.role && item.ref !== observation.ref);
    const common = { harnessId: id, ref, checkedAt, label: observation.label, role: observation.role, channel: observation.channel as InstallationUpgradeCheck["channel"], active: observation.active };
    if (kind === "terminal") {
      const layout = productChannels(id)?.scripts.find(item => join(this.source.home, item.root) === observation.root)?.upgrade;
      if (layout?.kind !== "terminal") throw new ManagementError("UNSUPPORTED_UPGRADE", "HarnessHub 不升级这种安装。");
      const localChanges = await this.nativeInspection(context => removal.localChanges(observation, context)); this.own();
      return { ...common, fingerprint: target.fingerprint, expiresAt: checkedAt, kind, current: observation.version, target: null, prerelease: false, runs: layout.command, writes: [], script: null, shellProfile: null, configFiles: [],
        dependencies: [], sharedRuntimes: [], runtime: null, conversations: [], otherUsers: [], processes: [], verification: null,
        terminal: { command: layout.command, explains: layout.explains, localChanges },
        notes: localChanges ? ["这份安装的目录里有 " + localChanges + " 处没有提交的改动，" + layout.command + " 会先把它们 git stash 起来。"] : [],
        blocked: "HarnessHub 不代为运行这个产品的更新，请在终端运行 " + layout.command + "。" };
    }
    const usage = await this.nativeInspection(context => removal.usage(observation, context)); this.own();
    const records = observation.active ? await this.nativeLocks.users(id) : { live: [], stale: 0 };
    const conversations = usage.own.length ? this.users?.list(id) ?? [] : [];
    this.pruneUpgrades();
    const directory = this.installDirectory("install-checks", randomUUID());
    let check: Awaited<ReturnType<InstallationUpgradePort["prepare"]>>;
    try { check = await this.nativeInspection(context => upgrader.prepare(target, directory, context), 90_000); this.own(); }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    // The version now, as the upgrade reads it before it runs; the latest scan may predate an upgrade since.
    const prepared = check.prepared, current = await this.nativeInspection(context => upgrader.version(observation, context)) ?? observation.version; this.own();
    const fingerprint = createHash("sha256").update(JSON.stringify({ target: target.fingerprint, prepared })).digest("hex"), expires = Date.now() + INSTALL_CHECK_MS;
    this.preparedUpgrades.set(fingerprint, { harnessId: id, ref, prepared, directory, expires });
    const newer = prepared.version === null || current === null || (valid(prepared.version) && valid(current) ? gt(prepared.version, current) : prepared.version !== current);
    const shared = sharedRuntimes(prepared.dependencies), busy = conversations.filter(item => item.busy).length;
    const verification = prepared.version === null ? null : observation.role === "adapter" ? adapterVersionVerification(id, prepared.version) : versionVerification(id, prepared.version, null);
    const notes: string[] = [];
    if (observation.active) notes.push("这是 HarnessHub 当前使用的那份：升级后，HarnessHub 的对话下次发消息起使用新版本。");
    else notes.push("这不是 HarnessHub 当前使用的那份" + (others.find(item => item.active) ? "（当前使用 " + others.find(item => item.active)!.label + "）" : "") + "；升级后“当前使用”不变。");
    if (observation.role === "adapter" && verification?.state === "unverified")
      notes.push("HarnessHub 对这个产品的控制在适配器 " + verification.adapter + " 上验证过；新版本 " + prepared.version + " 未经验证（ADR-038），仍可使用，部分能力可能不同。");
    if (prepared.kind === "self-update") notes.push("由 " + prepared.command + " 自己决定装哪个版本；完成后显示升级前后的版本。");
    if (prepared.kind === "rerun") { const method = officialInstallMethod(id); notes.push("重新运行官方安装脚本" + (method?.kind === "script" ? "（官网命令 " + method.command + "）" : "") + "，装入它现在提供的版本；完成后显示升级前后的版本。"); }
    if (observation.channel === "brew-formula" || observation.channel === "brew-cask") {
      notes.push("以 Homebrew 本地记录为准" + (check.records === null ? "" : "（更新于 " + check.records.slice(0, 10) + "）") + "，没有运行 brew update；需要最新版请先在终端运行 brew update。");
      notes.push("预演由 Homebrew 在它的沙箱里运行，可能下载清单到它的缓存，不改已装的程序。");
      if (check.deprecated.includes(observation.name)) notes.push("Homebrew 把 " + observation.name + " 标为已弃用或停用。" + (() => { const method = officialInstallMethod(id); return method !== null && method.kind !== "terminal" ? method.notes.join("") : ""; })());
    }
    const blocked = !newer ? "这份安装已是" + (observation.channel === "npm" ? " npm 上的" : observation.channel === "script" ? "" : " Homebrew 本地记录里的") + "最新版本 " + current + "。"
      : prepared.runtime !== null && !prepared.runtime.satisfied ? "新版本 " + prepared.version + " 要求 Node.js " + prepared.runtime.required + "，这份安装用的 Node.js（" + this.shown(prepared.runtime.path) + "）是 " + (prepared.runtime.found ?? "读不出版本") + "。请先升级这个 Node.js；HarnessHub 不升级 Node.js。"
      : usage.services.length ? "这份安装有后台服务 " + usage.services.map(item => item.label).join("、") + " 在运行。HarnessHub 只在“升级 Harness”里按产品的方式重启服务；请先在终端停止它们，或升级当前使用的那份。"
      : busy ? "有 " + busy + " 个 HarnessHub 对话正在使用这份安装（正在回复或等你处理），等它们结束或停止后再升级。"
      : records.live.length ? "另一个 HarnessHub 进程（进程 " + records.live.slice(0, 4).join("、") + "）正在使用这个程序，等它结束后再升级。" : null;
    return { ...common, fingerprint, expiresAt: new Date(expires).toISOString(), kind: prepared.kind, current, target: prepared.version, prerelease: prepared.version !== null && (valid(prepared.version) ? prerelease(prepared.version) !== null : false),
      runs: this.shown(prepared.command), writes: prepared.writes.map(path => this.shown(path)), script: prepared.script === null ? null : { source: prepared.script.source, sha256: prepared.script.sha256 },
      shellProfile: prepared.shellProfile === null ? null : this.shown(prepared.shellProfile), configFiles: prepared.configFiles.map(path => this.shown(path)),
      dependencies: prepared.dependencies, sharedRuntimes: shared, runtime: prepared.runtime === null ? null : { ...prepared.runtime, path: this.shown(prepared.runtime.path) },
      conversations, otherUsers: records.live.map(pid => ({ pid })), processes: [...usage.processes, ...usage.resident], verification, terminal: null, notes, blocked };
  }
  /**
   * Queues the installation upgrade the user confirmed (ADR-044). Refused when the confirmation expired or was used, or
   * the installation changed since; idempotent per command identity like every management job.
   */
  async submitInstallationUpgrade(input: unknown): Promise<InstallationJobView> {
    this.admission(); this.payloadBudgets(); const request = parseManagementInput(input);
    if (request.action !== "upgrade" || request.installation === undefined || request.expectedInstallationFingerprint === undefined) throw new ManagementError("INVALID_INPUT", "an installation upgrade names the installation and its confirmed check");
    if (this.upgrader === null || this.removal === null) throw new ManagementError("UNSUPPORTED_UPGRADE", "这里不提供升级。");
    const fingerprint = createHash("sha256").update(JSON.stringify({ harnessId: request.harnessId, action: "upgrade", installation: request.installation, expectedInstallationFingerprint: request.expectedInstallationFingerprint })).digest("hex");
    const existing = () => { const prior = this.storage.db.prepare("SELECT id,fingerprint FROM management_jobs WHERE command_id=?").get(request.commandId);
      if (!prior) return null; if (prior.fingerprint !== fingerprint || typeof prior.id !== "string") throw new ManagementError("COMMAND_CONFLICT", "management command already used different input"); return this.readJob(prior.id); };
    const prior = existing(); if (prior) return prior;
    this.pruneUpgrades();
    const entry = this.preparedUpgrades.get(request.expectedInstallationFingerprint);
    if (entry === undefined || entry.harnessId !== request.harnessId || entry.ref !== request.installation) throw new ManagementError("INSTALL_CHECK_EXPIRED", "升级确认已过期或已经用过，请重新打开升级确认。");
    const observation = this.observation(request.harnessId, request.installation, "upgrade"), target = await this.targetOf(observation); this.admission();
    if (target.fingerprint !== entry.prepared.target.fingerprint) throw new ManagementError("INSTALLATION_CHANGED", "这份安装在确认之后有了变化，没有升级。请重新打开升级确认。");
    const again = existing(); if (again) return again;
    if (this.storage.db.prepare("SELECT id FROM management_commands WHERE id=?").get(request.commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used by cancellation");
    if (this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(request.harnessId)) throw new ManagementError("MANAGEMENT_BUSY", "this Harness already has an active installation job");
    const queued = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs WHERE status='queued'").get()?.n;
    if (typeof queued !== "number" || queued >= 8 || this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n === 2048) throw new ManagementError("QUEUE_LIMIT", "installation job queue or storage budget exhausted");
    if (entry.prepared.runtime !== null && !entry.prepared.runtime.satisfied) throw new ManagementError("RUNTIME_INCOMPATIBLE", "这份安装用的 Node.js 不满足新版本的要求，没有升级。");
    const id = "management-" + randomUUID(), parent = join(this.storage.root, "install-jobs"); mkdirSync(parent, { recursive: true, mode: 0o700 }); managementIdentity(parent, true);
    const directory = join(parent, id); renameSync(entry.directory, directory); managementIdentity(directory, true); this.preparedUpgrades.delete(request.expectedInstallationFingerprint);
    const script = entry.prepared.script === null ? null : { ...entry.prepared.script, path: join(directory, basename(entry.prepared.script.path)) };
    const prepared: PreparedUpgrade = { ...entry.prepared, script, args: script === null ? entry.prepared.args : entry.prepared.args.map(arg => arg === entry.prepared.script!.path ? script.path : arg) };
    const time = this.now(), job: InstallationJobView = { id, harnessId: target.harnessId, controlId: target.controlId, action: "upgrade", status: "queued", phase: "queued", cancelRequested: false, createdAt: time, updatedAt: time,
      resolvedVersion: prepared.version, installationId: null, error: null, logCursor: 0,
      native: { channel: target.channel, location: this.shown(target.entry), beforeVersion: target.version, actualVersion: null, dispatched: false, configurationPreserved: null,
        installation: { label: target.label, role: target.role, kind: prepared.kind, command: this.shown(prepared.command), dependencies: prepared.dependencies, shellChanges: [], configChanges: [], blocked: [] } } };
    parseManagementJob(job); parseUpgradeRequest({ ...prepared, fingerprint: request.expectedInstallationFingerprint });
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
      this.storage.db.prepare("INSERT INTO management_jobs(id,harness_id,status,command_id,fingerprint,expected_revision,view_json) VALUES(?,?,?,?,?,?,?)").run(id, job.harnessId, job.status, request.commandId, fingerprint, this.defaultRevision(job.harnessId), JSON.stringify(job));
      this.storage.db.prepare("INSERT INTO management_installation_upgrades(job_id,request_json) VALUES(?,?)").run(id, JSON.stringify({ ...prepared, fingerprint: request.expectedInstallationFingerprint }));
      this.storage.db.exec("COMMIT");
    } catch (error) { this.storage.db.exec("ROLLBACK"); renameSync(directory, entry.directory); throw error; }
    this.schedule(); return job;
  }
  private upgradeFacts(id: string, patch: Partial<InstallationUpgradeFacts>, native: Partial<NativeJobFacts> = {}): void {
    const current = this.readJob(id); if (!current.native?.installation) throw new ManagementError("INVALID_DATA", "installation upgrade facts are missing");
    this.saveJob({ ...current, native: { ...current.native, ...native, installation: { ...current.native.installation, ...patch } }, updatedAt: this.now() });
  }
  private storedUpgrade(id: string): ReturnType<typeof parseUpgradeRequest> {
    const row = this.storage.db.prepare("SELECT request_json FROM management_installation_upgrades WHERE job_id=?").get(id);
    return parseUpgradeRequest(json(row?.request_json));
  }
  /**
   * Runs one installation upgrade (ADR-044). Everything that changes nothing comes first: the installation must be the one
   * confirmed; services running from it, HarnessHub conversations in a Turn on it and, for the installation this Gateway
   * runs, other HarnessHub processes refuse it. Then the version is read, idle kept processes running it close, and the
   * prepared upgrade runs through its channel (Homebrew checks its plan again first); the version is read again after.
   * Nothing is retried or rolled back.
   */
  private async runInstallationUpgradeJob(job: InstallationJobView): Promise<void> {
    const request = this.storedUpgrade(job.id), target = request.target, facts = job.native?.installation;
    if (this.upgrader === null || this.removal === null || facts === undefined) { this.phase(job.id, "failed", { error: { code: "UNSUPPORTED_UPGRADE", message: "这里不提供升级。" } }); return; }
    if (target.harnessId !== job.harnessId) throw new ManagementError("INVALID_DATA", "installation target is not owned by this job");
    const upgrader = this.upgrader, removal = this.removal, controller = new AbortController(), active = { id: job.id, controller, timedOut: false }; this.active = active;
    const homebrew = target.channel === "brew-formula" || target.channel === "brew-cask";
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, this.options.runTimeoutMs === undefined && homebrew ? HOMEBREW_UPGRADE_MS : this.timeout);
    let stage: string | undefined, identity: ReturnType<typeof managementIdentity> | undefined;
    let dispatched = false, ran = false, verified = false, quiescent = true, lock: ReturnType<NativeInstallationLocks["write"]> | undefined;
    const owned = () => { this.own(); if (controller.signal.aborted) throw new ManagementError("CANCELLED", "upgrade was cancelled"); if (!stage || !identity || !sameManagementIdentity(identity, managementIdentity(stage, true))) throw new ManagementError("OWNERSHIP_LOST", "upgrade directory changed"); lock?.assertOwned(); };
    const note = (text: string) => this.log(job.id, "system", this.shown(text));
    try {
      stage = await realpath(await mkdtemp(join(this.storage.root, "upgrade-job-"))); identity = managementIdentity(stage, true);
      const context: ManagementInstallContext = { stage, signal: controller.signal, assertOwned: owned, log: (stream, text) => this.log(job.id, stream, this.shown(text)) };
      this.phase(job.id, "resolving");
      const current = this.installations.get(job.harnessId)?.find(item => item.ref === target.ref);
      if (current === undefined || (await this.targetOf(current)).fingerprint !== target.fingerprint) throw new ManagementError("INSTALLATION_CHANGED", "这份安装在确认之后有了变化，没有升级。请重新打开升级确认。");
      owned(); const usage = await removal.usage(target, context); owned();
      if (usage.services.length) throw new ManagementError("SERVICE_RUNNING", "这份安装有后台服务 " + usage.services.map(item => item.label).join("、") + " 在运行，没有升级。请先在终端停止它们，或用“升级 Harness”。");
      const users = usage.own.length ? this.users?.list(job.harnessId) ?? [] : [], busy = users.filter(item => item.busy).length;
      if (busy) throw new ManagementError("HARNESS_BUSY", "有 " + busy + " 个 HarnessHub 对话正在使用这份安装（正在回复或等你处理），等它们结束或停止后再升级。");
      if (target.active) {
        const others = await this.nativeLocks.users(job.harnessId);
        if (others.live.length) throw new ManagementError("HARNESS_BUSY", "另一个 HarnessHub 进程（进程 " + others.live.slice(0, 4).join("、") + "）正在使用这个程序，等它结束后再升级。");
      }
      const left = [...usage.processes, ...usage.resident];
      if (left.length) note("这些程序不会被关闭，继续使用旧版本，重开后才用新版本：" + left.slice(0, 12).map(item => item.name + "（进程 " + item.pid + "）").join("、") + "。");
      const before = await upgrader.version(target, context); owned();
      this.upgradeFacts(job.id, {}, { beforeVersion: before });
      note("升级前：" + target.label + " " + (before ?? "版本读不出") + "。运行 " + request.command + "。");
      this.phase(job.id, "installing");
      if (users.length) {
        const closed = this.users === null ? 0 : await this.users.closeIdle(job.harnessId); owned();
        if (closed) { this.upgradeFacts(job.id, {}, { closedConversations: closed }); note("关闭了 " + closed + " 个对话保留的进程，它们下次发消息时会重新连接。"); }
      }
      if (target.active) {
        lock = this.nativeLocks.write(job.harnessId, job.id);
        if (lock.cleared.length) { this.upgradeFacts(job.id, {}, { clearedRecords: lock.cleared.length }); note("清除了 " + lock.cleared.length + " 条已结束的 HarnessHub 进程留下的使用记录。"); }
      }
      const outcome = await upgrader.run(request, { ...context, beginMutation: () => { owned(); if (dispatched) return; this.upgradeFacts(job.id, {}, { dispatched: true }); dispatched = true; } }); owned(); ran = true;
      const shown = { shellChanges: outcome.facts.shellChanges.map(change => ({ file: this.shown(change.file), added: change.added.map(line => this.redactor(this.shown(line))), removed: change.removed.map(line => this.redactor(this.shown(line))) })),
        configChanges: outcome.facts.configChanges.map(change => ({ file: this.shown(change.file), keys: change.keys })), blocked: outcome.facts.blocked.map(path => this.shown(path)) };
      this.upgradeFacts(job.id, shown);
      for (const change of shown.shellChanges) note("更新程序改了 " + change.file + "：加了 " + change.added.length + " 行，删了 " + change.removed.length + " 行。");
      for (const change of shown.configChanges) note("更新程序改了 " + change.file + " 的 " + change.keys.map(key => key.path).join("、") + "。");
      for (const path of shown.blocked) note("更新程序尝试写入 " + path + "，已被阻止。");
      this.phase(job.id, "verifying");
      const after = await upgrader.version(target, context); owned();
      this.upgradeFacts(job.id, {}, { actualVersion: after });
      if (outcome.exitCode !== 0) throw new ManagementError("UPGRADE_FAILED", "升级程序没有成功结束" + (shown.blocked.length ? "（它尝试写入 " + shown.blocked.join("、") + "，已被阻止）" : "") + "，现在的版本是 " + (after ?? "读不出") + "。没有重试。");
      if (after === null) throw new ManagementError("UPGRADE_VERSION_UNKNOWN", "升级结束了，但读不出这份安装现在的版本。");
      if (request.kind === "version" && after !== request.version) throw new ManagementError("UPGRADE_VERSION_MISMATCH", "升级结束了，但这份安装现在是 " + after + "，不是确认的 " + request.version + "。没有重试。");
      verified = true; this.upgradeFacts(job.id, {}, { configurationPreserved: true });
      const verification = target.role === "adapter" ? adapterVersionVerification(job.harnessId, after) : versionVerification(job.harnessId, after, null);
      if (verification?.state === "unverified") note("这个版本还不是 HarnessHub 用真实程序验证过的版本（验证过的是 " + (target.role === "adapter" ? "适配器 " + verification.adapter : verification.program) + "）。仍然可以使用，部分能力可能不同。");
      note(before === after ? "已是最新：" + target.label + " " + after + "。" : "已核实：" + target.label + " " + (before ?? "原版本") + " → " + after + "。");
      this.phase(job.id, "completed", { resolvedVersion: after });
      this.updates.delete(target.ref); this.systemVersions.delete(job.harnessId); this.programVersions.delete(job.harnessId); this.nativePlans.delete(job.harnessId + ":" + job.controlId);
    } catch (error) {
      this.own(); const failure = error instanceof ManagementError ? error : new ManagementError("UPGRADE_FAILED", "upgrade did not finish");
      quiescent = failure.code !== "CLEANUP_FAILED";
      // The updater's own result is known once it ran and the version was read again; an interruption while it ran leaves it unknown.
      const known = ran && ["UPGRADE_FAILED", "UPGRADE_VERSION_UNKNOWN", "UPGRADE_VERSION_MISMATCH"].includes(failure.code);
      const status = known ? "failed" : dispatched || !quiescent || failure.code === "OWNERSHIP_LOST" ? "unknown" : controller.signal.aborted ? "cancelled" : "failed";
      this.phase(job.id, status, { error: { code: active.timedOut ? "INSTALL_TIMEOUT" : failure.code, message: this.redactor(this.shown(failure.message)) } });
      if (ran) { this.updates.delete(target.ref); this.systemVersions.delete(job.harnessId); this.programVersions.delete(job.harnessId); }
    } finally {
      clearTimeout(timer); this.active = null;
      lock?.release(verified || !dispatched && quiescent);
      if (quiescent && stage && identity && sameManagementIdentity(identity, managementIdentity(stage, true))) await rm(stage, { recursive: true, force: true });
      if (quiescent) rmSync(join(this.storage.root, "install-jobs", job.id), { recursive: true, force: true });
    }
  }
  /**
   * What upgrading this Harness would touch, for the user's confirmation (ADR-043): the services restarted, resident and
   * other programs left on the old version, HarnessHub's conversations using it, other HarnessHub processes using it, and
   * usage records left over. Reads only; the upgrade checks again before changing anything.
   */
  async maintenance(harnessId: string): Promise<MaintenanceCheck> {
    this.admission(); const id = managementSlug(harnessId), recipe = this.recipe(id);
    const plan = recipe && this.native ? this.nativePlans.get(id + ":" + recipe.controlId) : undefined;
    if (!recipe || !this.native || !plan || plan.channel === "unsupported" || plan.reason !== null || !plan.actualEntry)
      throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", plan?.reason ?? "this Harness has no native installation HarnessHub can upgrade");
    const native = this.native, usage = await this.nativeInspection(context => native.usage(plan, recipe, context)); this.own();
    const records = await this.nativeLocks.users(id), plugins = await native.plugins(recipe), view = this.views([id])[0]!, target = view.latestVersion;
    // The target's runtime requirement is read from its release; when it cannot be read the upgrade still checks it before changing anything.
    let runtimes: readonly RuntimeRequirement[] = [];
    if (target !== null) try { runtimes = await this.nativeInspection(context => native.runtimes(plan, recipe, target, usage.services, context)); this.own(); }
    catch (error) { if (error instanceof ManagementError && ["OWNER_LOST", "OWNERSHIP_LOST", "MANAGEMENT_CLOSED", "INVALID_STORAGE"].includes(error.code)) throw error; runtimes = []; }
    return { harnessId: id, checkedAt: this.now(), fingerprint: plan.fingerprint, channel: plan.channel, location: plan.entry,
      currentVersion: plan.beforeVersion, targetVersion: view.latestVersion, servicesKnown: usage.servicesKnown,
      restart: usage.services.filter(service => service.declared?.restart === true).map(service => ({ label: service.label, name: service.declared!.name, pid: service.pid,
        command: "launchctl kickstart -k " + service.target, portKnown: service.port !== null })),
      resident: [...usage.services.filter(service => service.declared?.restart !== true).map(service => ({ label: service.label, name: service.declared?.name ?? service.label, pid: service.pid,
        restartCommand: service.declared?.restartCommand ?? "launchctl kickstart -k " + service.target })), ...usage.resident.map(program => ({ label: null, name: program.name, pid: program.pid, restartCommand: null }))],
      processes: usage.processes, conversations: this.users?.list(id) ?? [], otherUsers: records.live.map(pid => ({ pid })), staleRecords: records.stale,
      plugins, notes: recipe.upgradeNotes ?? [], rollback: rollbackCommand(plan), target: target === null ? null : versionVerification(id, target, null), runtimes };
  }
  listJobs(limit?: number): readonly InstallationJobView[] {
    this.own(); const count = boundedManagementLimit(limit, 1000);
    const total = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n;
    if (typeof total !== "number" || total > 2048) throw new ManagementError("STORAGE_LIMIT", "installation job budget exceeded");
    this.payloadBudgets();
    return this.storage.db.prepare("SELECT id,harness_id,status,view_json FROM management_jobs ORDER BY rowid DESC LIMIT ?").all(count).map(row => this.parseJobRow(row));
  }
  readJob(id: string): InstallationJobView {
    this.own(); installationJobId(id);
    const budget = this.storage.db.prepare("SELECT length(CAST(view_json AS BLOB)) AS bytes FROM management_jobs WHERE id=?").get(id);
    if (!budget) throw new ManagementError("JOB_NOT_FOUND", "installation job was not found");
    if (typeof budget.bytes !== "number" || budget.bytes > 65536) throw new ManagementError("INVALID_DATA", "installation job exceeded its byte budget");
    const row = this.storage.db.prepare("SELECT id,harness_id,status,view_json FROM management_jobs WHERE id=? AND length(CAST(view_json AS BLOB))<=65536").get(id);
    if (!row) throw new ManagementError("INVALID_DATA", "installation job changed during reading");
    return this.parseJobRow(row);
  }
  logs(id: string, afterSeq: number, limit?: number): readonly InstallationLog[] {
    this.readJob(id); if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new ManagementError("INVALID_INPUT", "invalid installation log cursor");
    this.payloadBudgets();
    return this.storage.db.prepare("SELECT seq,entry_json FROM management_logs WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?").all(id, afterSeq, boundedManagementLimit(limit, 1000)).map(row => {
      const entry = parseManagementLog(json(row.entry_json)); if (entry.seq !== row.seq) throw new ManagementError("INVALID_DATA", "installation log sequence changed"); return entry;
    });
  }
  private saveJob(job: InstallationJobView): void {
    this.own(); parseManagementJob(job); this.storage.db.prepare("UPDATE management_jobs SET status=?,view_json=? WHERE id=?").run(job.status, JSON.stringify(job), job.id);
  }
  private payloadBudgets(): void {
    for (const [table, column, size, maximum] of [["management_jobs", "view_json", 65536, 2048], ["management_installations", "record_json", 65536, 2048],
      ["management_updates", "view_json", 65536, 256], ["management_logs", "entry_json", 32768, 65536], ["management_native_plans", "plan_json", 32768, 2048], ["management_installation_targets", "target_json", 32768, 2048], ["management_install_requests", "request_json", 32768, 2048], ["management_installation_upgrades", "request_json", 32768, 2048]] as const) {
      const total = this.storage.db.prepare("SELECT count(*) AS count,coalesce(sum(length(CAST(" + column + " AS BLOB))),0) AS bytes FROM " + table).get();
      if (!total || typeof total.count !== "number" || total.count > maximum || typeof total.bytes !== "number" || total.bytes > 32 * 1024 * 1024)
        throw new ManagementError("STORAGE_LIMIT", "management storage exceeded its row or byte budget");
      if (this.storage.db.prepare("SELECT 1 FROM " + table + " WHERE length(CAST(" + column + " AS BLOB))>? LIMIT 1").get(size))
        throw new ManagementError("INVALID_DATA", "management payload exceeded its byte budget");
    }
    if (this.storage.db.prepare("SELECT 1 FROM management_jobs WHERE length(CAST(id AS BLOB))>64 OR length(CAST(harness_id AS BLOB))>96 OR length(CAST(status AS BLOB))>16 OR length(CAST(command_id AS BLOB))>128 OR length(CAST(fingerprint AS BLOB))>64 OR expected_revision NOT BETWEEN 0 AND 2048 LIMIT 1").get() ||
        this.storage.db.prepare("SELECT 1 FROM management_commands WHERE length(CAST(id AS BLOB))>128 OR length(CAST(fingerprint AS BLOB))>64 OR length(CAST(job_id AS BLOB))>64 LIMIT 1").get() ||
        this.storage.db.prepare("SELECT 1 FROM management_installations WHERE length(CAST(id AS BLOB))>64 OR length(CAST(harness_id AS BLOB))>96 OR length(CAST(control_id AS BLOB))>96 LIMIT 1").get() ||
        this.storage.db.prepare("SELECT 1 FROM management_defaults WHERE length(CAST(harness_id AS BLOB))>96 OR length(CAST(installation_id AS BLOB))>64 OR revision NOT BETWEEN 1 AND 2048 LIMIT 1").get())
      throw new ManagementError("INVALID_DATA", "management index metadata exceeded its byte or revision budget");
  }
  private parseJobRow(row: Record<string, unknown>): InstallationJobView {
    const job = parseManagementJob(json(row.view_json));
    if (row.id !== job.id || row.harness_id !== job.harnessId || row.status !== job.status) throw new ManagementError("INVALID_DATA", "installation job row disagrees with its public facts");
    const water = this.storage.db.prepare("SELECT count(*) AS count,coalesce(max(seq),0) AS seq FROM management_logs WHERE job_id=?").get(job.id);
    if (!water || water.count !== job.logCursor || water.seq !== job.logCursor) throw new ManagementError("INVALID_DATA", "installation log watermark is inconsistent");
    return job;
  }
  private auditStorage(): void {
    this.own(); this.payloadBudgets();
    const ids = new Set<string>();
    for (const row of this.storage.db.prepare("SELECT id,harness_id,status,view_json FROM management_jobs").all()) ids.add(this.parseJobRow(row).id);
    for (const row of this.storage.db.prepare("SELECT job_id,seq,entry_json FROM management_logs").all()) {
      const log = parseManagementLog(json(row.entry_json)); if (row.seq !== log.seq || typeof row.job_id !== "string" || !ids.has(row.job_id)) throw new ManagementError("INVALID_DATA", "orphan or inconsistent installation log");
    }
    const nativeIds = new Set<string>();
    for (const row of this.storage.db.prepare("SELECT job_id,plan_json FROM management_native_plans").all()) {
      const plan = parseNativePlan(json(row.plan_json));
      if (typeof row.job_id !== "string" || !ids.has(row.job_id)) throw new ManagementError("INVALID_DATA", "orphan native installation plan");
      const job = this.readJob(row.job_id);
      if (!job.native || job.harnessId !== plan.harnessId || job.controlId !== plan.controlId || job.native.channel !== plan.channel) throw new ManagementError("INVALID_DATA", "native job and plan disagree"); nativeIds.add(job.id);
    }
    const targetIds = new Set<string>();
    for (const row of this.storage.db.prepare("SELECT job_id,target_json FROM management_installation_targets").all()) {
      const target = parseInstallationTarget(json(row.target_json));
      if (typeof row.job_id !== "string" || !ids.has(row.job_id)) throw new ManagementError("INVALID_DATA", "orphan installation target");
      const job = this.readJob(row.job_id);
      if (job.action !== "uninstall" || job.harnessId !== target.harnessId || nativeIds.has(job.id)) throw new ManagementError("INVALID_DATA", "uninstall job and target disagree"); targetIds.add(job.id);
    }
    const requestIds = new Set<string>();
    for (const row of this.storage.db.prepare("SELECT job_id,request_json FROM management_install_requests").all()) {
      const request = parseInstallRequest(json(row.request_json));
      if (typeof row.job_id !== "string" || !ids.has(row.job_id)) throw new ManagementError("INVALID_DATA", "orphan official install request");
      const job = this.readJob(row.job_id);
      if (job.native?.official === undefined || job.harnessId !== request.harnessId || nativeIds.has(job.id) || targetIds.has(job.id)) throw new ManagementError("INVALID_DATA", "official install job and request disagree"); requestIds.add(job.id);
    }
    const upgradeIds = new Set<string>();
    for (const row of this.storage.db.prepare("SELECT job_id,request_json FROM management_installation_upgrades").all()) {
      const request = parseUpgradeRequest(json(row.request_json));
      if (typeof row.job_id !== "string" || !ids.has(row.job_id)) throw new ManagementError("INVALID_DATA", "orphan installation upgrade request");
      const job = this.readJob(row.job_id);
      if (job.native?.installation === undefined || job.harnessId !== request.target.harnessId || nativeIds.has(job.id) || targetIds.has(job.id) || requestIds.has(job.id))
        throw new ManagementError("INVALID_DATA", "installation upgrade job and request disagree"); upgradeIds.add(job.id);
    }
    for (const id of ids) { const job = this.readJob(id);
      const frozen = job.action === "uninstall" ? targetIds.has(id) : job.native?.official !== undefined ? requestIds.has(id) : job.native?.installation !== undefined ? upgradeIds.has(id) : !job.native || nativeIds.has(id);
      if (!frozen) throw new ManagementError("INVALID_DATA", job.action === "uninstall" ? "uninstall job has no frozen target" : job.native?.official !== undefined ? "official install job has no frozen request"
        : job.native?.installation !== undefined ? "installation upgrade job has no frozen request" : "native job has no frozen plan"); }
    for (const row of this.storage.db.prepare("SELECT id,harness_id,control_id,record_json FROM management_installations").all()) {
      const record = parseInstallationRecord(json(row.record_json));
      if (record.id !== row.id || record.harnessId !== row.harness_id || record.controlId !== row.control_id) throw new ManagementError("INVALID_DATA", "installation record row identity disagrees");
      this.verifyStoredRecord(record);
    }
    for (const row of this.storage.db.prepare("SELECT harness_id,installation_id,revision FROM management_defaults").all()) {
      if (typeof row.harness_id !== "string" || typeof row.installation_id !== "string") throw new ManagementError("INVALID_DATA", "managed default pointer is invalid");
      managementSlug(row.harness_id); managementInteger(row.revision, 1);
      const matched = this.storage.db.prepare("SELECT harness_id FROM management_installations WHERE id=?").get(row.installation_id);
      if (!matched || matched.harness_id !== row.harness_id) throw new ManagementError("INVALID_DATA", "managed default pointer is dangling");
    }
    for (const row of this.storage.db.prepare("SELECT harness_id,view_json FROM management_updates").all()) { managementSlug(row.harness_id); parseManagementUpdate(json(row.view_json)); }
  }
  /**
   * Verifies a stored private installation and says whether it can still run. An npm package installed with HarnessHub's
   * own Node.js at the time cannot once that Node.js changed (the user upgraded it, or its version is gone): the record
   * stays as history and no longer resolves, and startup does not fail on it (ADR-043). Every other mismatch is a tampered
   * or corrupt record and fails.
   */
  private verifyStoredRecord(record: InstallationRecord): boolean {
    if (record.slot !== join(this.storage.root, "slots", record.id)) throw new ManagementError("INVALID_DATA", "managed installation slot namespace changed");
    managementIdentity(record.slot, true); const markerPath = join(record.slot, ".slot.json"); managementIdentity(markerPath);
    const marker = managementObject(json(importedFile(markerPath)), ["installationId", "jobId", "ownerGeneration"]);
    if (marker.installationId !== record.id || typeof marker.jobId !== "string") throw new ManagementError("INVALID_DATA", "managed slot marker identity changed");
    managementInteger(marker.ownerGeneration, 1); const job = this.readJob(marker.jobId);
    if (job.status !== "completed" || job.installationId !== record.id || job.harnessId !== record.harnessId || job.controlId !== record.controlId || job.resolvedVersion !== record.version)
      throw new ManagementError("INVALID_DATA", "managed slot has no completed publication evidence");
    const recipe = this.recipe(record.harnessId, record.controlId); if (!recipe) throw new ManagementError("INVALID_DATA", "managed installation recipe disappeared");
    const launchPath = join(record.slot, ".launch.json"); managementIdentity(launchPath);
    const launchBytes = boundedManagementFile(launchPath, 65536);
    if (createHash("sha256").update(launchBytes).digest("hex") !== record.launchSha256 ||
        new TextDecoder("utf8", { fatal: true }).decode(launchBytes) !== JSON.stringify(record.command)) throw new ManagementError("INVALID_DATA", "managed launch receipt disagrees with committed command");
    if (recipe.kind === "npm") {
      if (!recipe.packageName) throw new ManagementError("INVALID_DATA", "managed package identity disappeared");
      const entry = realpathSync(installedNpmEntry(record.slot, recipe.packageName, record.version, recipe.binName));
      if (!insideManagement(record.slot, entry) || record.command.args[0] !== entry || !lstatSync(entry).isFile())
        throw new ManagementError("INVALID_DATA", "managed package entry changed");
      if (JSON.stringify(record.command.args.slice(1)) !== JSON.stringify(recipe.args) || Object.keys(record.command.env).some(key => key !== "PATH"))
        throw new ManagementError("INVALID_DATA", "managed npm arguments or environment no longer match its recipe");
      // Its runtime is a private Node.js in the slot, or HarnessHub's own Node.js when it was installed.
      if (insideManagement(record.slot, record.command.executable)) {
        if (!/^runtime\/node-v24\.[0-9]+\.[0-9]+-[a-z0-9-]+\/bin\/node$/u.test(relativeSlot(record.slot, realpathSync(record.command.executable))))
          throw new ManagementError("INVALID_DATA", "managed package runtime identity changed");
        return true;
      }
      let runtime: string | null = null;
      try { runtime = realpathSync(record.command.executable); } catch (error) { if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      return runtime === this.node;
    }
    const executable = realpathSync(record.command.executable);
    if (!insideManagement(record.slot, executable) || !lstatSync(executable).isFile()) throw new ManagementError("INVALID_DATA", "managed binary entry escaped its slot");
    return true;
  }
  private defaultRevision(harnessId: string): number {
    const row = this.storage.db.prepare("SELECT revision FROM management_defaults WHERE harness_id=?").get(harnessId);
    if (!row) return 0; if (typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ManagementError("INVALID_DATA", "managed default revision is invalid"); return row.revision;
  }
  submit(input: unknown): InstallationJobView {
    this.admission(); this.payloadBudgets(); const request = parseManagementInput(input), recipe = this.recipe(request.harnessId, request.controlId);
    if (!recipe) throw new ManagementError("UNSUPPORTED_MANAGEMENT", "this Harness has no reviewed installation recipe");
    const capability = this.capability(request.harnessId);
    if (!this.native && capability?.canInstall === false && capability.controlId === recipe.controlId) throw new ManagementError("UNSUPPORTED_MANAGEMENT", capability.reason ?? "installation is unavailable");
    const fingerprint = createHash("sha256").update(JSON.stringify({ harnessId: request.harnessId, controlId: recipe.controlId, action: request.action,
      expectedDefaultRevision: request.expectedDefaultRevision ?? null, ...(request.expectedNativeFingerprint === undefined ? {} : { expectedNativeFingerprint: request.expectedNativeFingerprint }),
      ...(request.restartServices === undefined ? {} : { restartServices: request.restartServices }) })).digest("hex"), prior = this.storage.db.prepare("SELECT id,fingerprint FROM management_jobs WHERE command_id=?").get(request.commandId);
    if (prior) { if (prior.fingerprint !== fingerprint || typeof prior.id !== "string") throw new ManagementError("COMMAND_CONFLICT", "management command already used different input"); return this.readJob(prior.id); }
    const nativePlan = this.native ? this.nativePlans.get(request.harnessId + ":" + recipe.controlId) : undefined;
    if (this.native && (!nativePlan || nativePlan.channel === "unsupported")) throw new ManagementError("UNSUPPORTED_NATIVE_MANAGEMENT", nativePlan?.reason ?? "Refresh the actual native installation before submitting");
    if (nativePlan?.reason) throw new ManagementError("CONFIGURATION_PROTECTION_UNAVAILABLE", nativePlan.reason);
    if (nativePlan && request.expectedNativeFingerprint !== nativePlan.fingerprint) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "native installation differs from the selected observation; refresh before continuing");
    if (!this.native && this.system.has(request.harnessId)) throw new ManagementError("NATIVE_UPGRADE_UNSUPPORTED", "Use the installed Harness update command; replacing it with a private copy is not a native upgrade");
    if (this.storage.db.prepare("SELECT id FROM management_commands WHERE id=?").get(request.commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used by cancellation");
    const active = this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(request.harnessId);
    if (active) throw new ManagementError("MANAGEMENT_BUSY", "this Harness already has an active installation job");
    const queued = this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs WHERE status='queued'").get()?.n;
    if (typeof queued !== "number" || queued >= 8 || this.storage.db.prepare("SELECT count(*) AS n FROM management_jobs").get()?.n === 2048)
      throw new ManagementError("QUEUE_LIMIT", "installation job queue or storage budget exhausted");
    const revision = this.defaultRevision(request.harnessId);
    if (request.expectedDefaultRevision !== undefined && request.expectedDefaultRevision !== revision) throw new ManagementError("DEFAULT_CONFLICT", "managed default changed since it was read");
    const time = this.now(), job: InstallationJobView = { id: "management-" + randomUUID(), harnessId: recipe.harnessId, controlId: recipe.controlId,
      action: request.action, status: "queued", phase: "queued", cancelRequested: false, createdAt: time, updatedAt: time,
      resolvedVersion: null, installationId: null, error: null, logCursor: 0,
      ...(nativePlan === undefined ? {} : { native: { channel: nativePlan.channel, location: nativePlan.entry, beforeVersion: nativePlan.beforeVersion, actualVersion: null, dispatched: false, configurationPreserved: null,
        ...(request.restartServices === undefined ? {} : { restartServices: request.restartServices }) } }) };
    this.storage.db.exec("BEGIN IMMEDIATE");
    try {
      this.storage.db.prepare("INSERT INTO management_jobs(id,harness_id,status,command_id,fingerprint,expected_revision,view_json) VALUES(?,?,?,?,?,?,?)").run(job.id, job.harnessId, job.status, request.commandId, fingerprint, revision, JSON.stringify(job));
      if (nativePlan) this.storage.db.prepare("INSERT INTO management_native_plans(job_id,plan_json) VALUES(?,?)").run(job.id, JSON.stringify(nativePlan));
      this.storage.db.exec("COMMIT");
    } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
    this.schedule(); return job;
  }
  cancel(id: string, commandId: string): InstallationJobView {
    this.admission(); this.payloadBudgets(); managementCommand(commandId); const job = this.readJob(id), fingerprint = createHash("sha256").update("cancel:" + id).digest("hex");
    const existing = this.storage.db.prepare("SELECT fingerprint FROM management_commands WHERE id=?").get(commandId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new ManagementError("COMMAND_CONFLICT", "management cancel command used different input"); return this.readJob(id); }
    if (this.storage.db.prepare("SELECT id FROM management_jobs WHERE command_id=?").get(commandId)) throw new ManagementError("COMMAND_CONFLICT", "management command identity already used");
    this.storage.db.exec("BEGIN IMMEDIATE");
    try { this.storage.db.prepare("INSERT INTO management_commands(id,fingerprint,job_id) VALUES(?,?,?)").run(commandId, fingerprint, id);
      if (!terminal(job.status)) this.saveJob({ ...job, cancelRequested: true, ...(job.status === "queued" ? { status: "cancelled" as const, phase: "cancelled" } : {}), updatedAt: this.now() });
      this.storage.db.exec("COMMIT"); } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
    if (this.active?.id === id) this.active.controller.abort(); return this.readJob(id);
  }
  private log(id: string, stream: InstallationLog["stream"], text: string): void {
    let job = this.readJob(id); const cleaned = this.redactor(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, ""));
    const chunks: string[] = []; let part = "", bytes = 0;
    for (const char of cleaned) { const size = Buffer.byteLength(char, "utf8"); if (bytes + size > 4096) { chunks.push(part); part = ""; bytes = 0; } part += char; bytes += size; }
    if (part || chunks.length === 0) chunks.push(part);
    if (job.logCursor + chunks.length > 2048) throw new ManagementError("LOG_LIMIT", "installation log budget exhausted");
    this.storage.db.exec("BEGIN IMMEDIATE"); try {
      for (const text of chunks) { const entry: InstallationLog = { seq: job.logCursor + 1, time: this.now(), stream, text };
        this.storage.db.prepare("INSERT INTO management_logs(job_id,seq,entry_json) VALUES(?,?,?)").run(id, entry.seq, JSON.stringify(entry)); job = { ...job, logCursor: entry.seq, updatedAt: entry.time }; }
      this.saveJob(job); this.storage.db.exec("COMMIT");
    } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
  }
  private phase(id: string, status: InstallationJobView["status"], patch: Partial<InstallationJobView> = {}): void {
    this.saveJob({ ...this.readJob(id), ...patch, status, phase: status, updatedAt: this.now() });
  }
  private schedule(): void {
    if (this.runner !== null || !this.accepting) return;
    this.runner = Promise.resolve().then(() => this.runQueue()).finally(() => { this.runner = null; });
    void this.runner.catch(() => { this.accepting = false; });
  }
  private async runQueue(): Promise<void> {
    while (this.accepting) {
      this.own(); const next = this.storage.db.prepare("SELECT id FROM management_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get()?.id;
      if (typeof next !== "string") return; await this.runJob(next);
    }
  }
  private async runJob(id: string): Promise<void> {
    const job = this.readJob(id);
    if (job.action === "uninstall") { await this.runUninstallJob(job); return; }
    if (job.native?.official !== undefined) { await this.runOfficialInstallJob(job); return; }
    if (job.native?.installation !== undefined) { await this.runInstallationUpgradeJob(job); return; }
    const recipe = this.recipe(job.harnessId, job.controlId);
    if (!recipe) { this.phase(id, "failed", { error: { code: "RECIPE_CHANGED", message: "installation recipe is unavailable" } }); return; }
    if (job.native !== undefined) { await this.runNativeJob(job, recipe); return; }
    const controller = new AbortController(), active = { id, controller, timedOut: false }; this.active = active;
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, this.timeout);
    let stage: string | null = null;
    try {
      this.phase(id, "resolving"); const spec = await this.metadata.resolve(recipe, controller.signal); this.own();
      if (controller.signal.aborted) throw new ManagementError("CANCELLED", "installation was cancelled");
      if (spec.recipe.harnessId !== recipe.harnessId || spec.recipe.controlId !== recipe.controlId || !spec.version || spec.version.length > 128 || /[\0\r\n]/u.test(spec.version))
        throw new ManagementError("INVALID_METADATA", "resolved installation identity is inconsistent");
      const installId = "installation-" + randomUUID(); stage = join(this.storage.root, "slots", installId); mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, ".slot.json"), JSON.stringify({ installationId: installId, jobId: id, ownerGeneration: this.options.ownerGeneration }), { flag: "wx", mode: 0o600 });
      const slotIdentity = managementIdentity(stage, true), markerIdentity = managementIdentity(join(stage, ".slot.json"));
      const markerHash = createHash("sha256").update(boundedManagementFile(join(stage, ".slot.json"), 4096)).digest("hex");
      const owned = (): void => { this.own(); if (controller.signal.aborted) throw new ManagementError("CANCELLED", "installation was cancelled");
        if (!sameManagementIdentity(slotIdentity, managementIdentity(stage!, true)) || !sameManagementIdentity(markerIdentity, managementIdentity(join(stage!, ".slot.json"))) ||
            createHash("sha256").update(boundedManagementFile(join(stage!, ".slot.json"), 4096)).digest("hex") !== markerHash)
          throw new ManagementError("OWNERSHIP_LOST", "installation slot ownership changed"); };
      this.phase(id, "installing", { resolvedVersion: spec.version, installationId: installId });
      const artifact = await this.installer.install(spec, { stage, signal: controller.signal, assertOwned: owned, log: (stream, text) => this.log(id, stream, text) }); owned();
      this.phase(id, "verifying");
      if (artifact.observedVersion !== spec.version || !isAbsolute(artifact.command.executable) || artifact.command.args.length > 64)
        throw new ManagementError("INVALID_ARTIFACT", "installed version or command differs from its resolved target");
      const entry = await realpath(artifact.command.executable); owned(); await access(entry, constants.X_OK); owned();
      if (spec.recipe.kind === "npm") {
        if (!spec.recipe.packageName || artifact.command.args[0] === undefined) throw new ManagementError("INVALID_ARTIFACT", "npm entry is missing");
        const packageEntry = await realpath(installedNpmEntry(stage, spec.recipe.packageName, spec.version, recipe.binName)); owned();
        if (!insideManagement(stage, packageEntry) || artifact.command.args[0] !== packageEntry || !(await lstat(packageEntry)).isFile())
          throw new ManagementError("INVALID_ARTIFACT", "npm executable does not belong to its immutable slot");
        owned(); if (entry !== this.node && !insideManagement(stage, entry)) throw new ManagementError("INVALID_ARTIFACT", "npm runtime is not the admitted runtime");
      } else if (!insideManagement(stage, entry) || !(await lstat(entry)).isFile()) throw new ManagementError("INVALID_ARTIFACT", "installation executable escapes its immutable slot");
      owned();
      if (spec.recipe.kind === "npm" && (JSON.stringify(artifact.command.args.slice(1)) !== JSON.stringify(spec.recipe.args) || Object.keys(artifact.command.env).some(key => key !== "PATH")))
        throw new ManagementError("INVALID_ARTIFACT", "installed npm arguments/environment differ from their reviewed recipe");
      if (spec.recipe.kind === "python" && Object.keys(artifact.command.env).some(key => key !== "PATH")) throw new ManagementError("INVALID_ARTIFACT", "Python managed environment contains unsupported injection");
      if (spec.recipe.kind === "binary" && (JSON.stringify(artifact.command.args) !== JSON.stringify(spec.recipe.args) || JSON.stringify(artifact.command.env) !== JSON.stringify(spec.recipe.env ?? {})))
        throw new ManagementError("INVALID_ARTIFACT", "binary managed arguments/environment differ from resolved official metadata");
      const launch = JSON.stringify(artifact.command); if (Buffer.byteLength(launch, "utf8") > 65536) throw new ManagementError("ARTIFACT_LIMIT", "managed launch receipt exceeded its byte budget");
      const launchSha256 = createHash("sha256").update(launch).digest("hex");
      owned(); writeFileSync(join(stage, ".launch.json"), launch, { flag: "wx", mode: 0o600 }); owned();
      const record: InstallationRecord = { id: installId, harnessId: recipe.harnessId, controlId: recipe.controlId, version: spec.version, slot: stage,
        command: artifact.command, artifactSha256: artifact.artifactSha256, launchSha256 };
      parseInstallationRecord(record);
      if (Buffer.byteLength(JSON.stringify(record), "utf8") > 65536) throw new ManagementError("ARTIFACT_LIMIT", "installation receipt exceeded its byte budget");
      this.phase(id, "activating"); this.storage.db.exec("BEGIN IMMEDIATE");
      try {
        owned(); const expected = this.storage.db.prepare("SELECT expected_revision FROM management_jobs WHERE id=?").get(id)?.expected_revision;
        const current = this.defaultRevision(recipe.harnessId); if (expected !== current) throw new ManagementError("DEFAULT_CONFLICT", "managed default changed before installation activation");
        this.storage.db.prepare("INSERT INTO management_installations(id,harness_id,control_id,record_json) VALUES(?,?,?,?)").run(installId, recipe.harnessId, recipe.controlId, JSON.stringify(record));
        this.storage.db.prepare("INSERT INTO management_defaults(harness_id,installation_id,revision) VALUES(?,?,?) ON CONFLICT(harness_id) DO UPDATE SET installation_id=excluded.installation_id,revision=excluded.revision").run(recipe.harnessId, installId, current + 1);
        this.phase(id, "completed"); owned(); this.storage.db.exec("COMMIT");
      } catch (error) { this.storage.db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      this.own(); const current = this.readJob(id);
      const failure = error instanceof ManagementError ? error : new ManagementError("INSTALL_FAILED", "installation could not be completed");
      const cancelled = current.cancelRequested || !this.accepting;
      this.phase(id, failure.code === "CLEANUP_FAILED" || failure.code === "OWNERSHIP_LOST" ? "unknown" : cancelled ? "cancelled" : "failed",
        { error: { code: active.timedOut ? "INSTALL_TIMEOUT" : this.redactor(failure.code), message: this.redactor(active.timedOut ? "installation exceeded its deadline" : failure.message) } });
    } finally { clearTimeout(timer); this.active = null; }
  }
  /** Merges facts into a native job's record. */
  private nativeFacts(id: string, patch: Partial<NativeJobFacts>): void {
    const current = this.readJob(id); if (!current.native) throw new ManagementError("INVALID_DATA", "native job facts are missing");
    this.saveJob({ ...current, native: { ...current.native, ...patch }, updatedAt: this.now() });
  }
  /**
   * Runs one native upgrade (ADR-017, ADR-043). Everything that changes nothing comes first: the exact version, the
   * product's own compatibility check, HarnessHub's conversations in a Turn, and the services to restart against the
   * user's consent. Then HarnessHub's idle kept processes close, the maintenance lock clears left-over usage records, the
   * original channel installs, and the version is verified. The agreed services restart right after that; one that does
   * not run again fails the job with the installed version recorded, and nothing is rolled back or retried.
   */
  private async runNativeJob(job: InstallationJobView, recipe: ManagementRecipe): Promise<void> {
    if (!this.native || !job.native) { this.phase(job.id, "failed", { error: { code: "NATIVE_UNAVAILABLE", message: "native maintenance is unavailable" } }); return; }
    const row = this.storage.db.prepare("SELECT plan_json FROM management_native_plans WHERE job_id=?").get(job.id);
    const plan = parseNativePlan(json(row?.plan_json));
    if (plan.harnessId !== job.harnessId || plan.controlId !== job.controlId) throw new ManagementError("INVALID_DATA", "native plan is not owned by this job");
    const native = this.native, controller = new AbortController(), active = { id: job.id, controller, timedOut: false }; this.active = active;
    const timer = setTimeout(() => { active.timedOut = true; controller.abort(); }, this.timeout);
    let stage: string | undefined, identity: ReturnType<typeof managementIdentity> | undefined;
    let dispatched = false, verified = false, quiescent = true, lock: ReturnType<NativeInstallationLocks["write"]> | undefined;
    const owned = () => { this.own(); if (controller.signal.aborted) throw new ManagementError("CANCELLED", "native maintenance was cancelled"); if (!stage || !identity || !sameManagementIdentity(identity, managementIdentity(stage, true))) throw new ManagementError("OWNERSHIP_LOST", "native maintenance directory changed"); lock?.assertOwned(); };
    const note = (text: string) => this.log(job.id, "system", text);
    try {
      stage = await realpath(await mkdtemp(join(this.storage.root, "native-job-"))); identity = managementIdentity(stage, true);
      const context: ManagementInstallContext = { stage, signal: controller.signal, assertOwned: owned, log: (stream, text) => this.log(job.id, stream, text) };
      this.phase(job.id, "resolving");
      const observed = this.system.get(job.harnessId);
      const refreshedPlan = await native.describe(recipe, observed?.controlId === job.controlId ? observed : undefined, observed?.controlId === job.controlId ? this.systemVersion(job.harnessId) : null, context);
      if (refreshedPlan.fingerprint !== plan.fingerprint) throw new ManagementError("NATIVE_INSTALLATION_CHANGED", "native installation changed since submission");
      const version = await native.latest(plan, recipe, context); owned();
      note("目标版本 " + version + "，沿用原安装渠道。");
      await native.prepare(plan, recipe, version, context); owned();
      if (plan.harnessId === "openclaw") note("目标版本用你现在的配置校验通过（校验在隔离环境中进行，不能写文件、不能联网）。");
      // Who uses the program is read right before anything changes; nothing has changed if any of these refuse.
      const busy = this.users?.list(job.harnessId).filter(item => item.busy).length ?? 0;
      if (busy) throw new ManagementError("HARNESS_BUSY", "有 " + busy + " 个 HarnessHub 对话正在使用这个程序（正在回复或等你处理），等它们结束或停止后再升级。");
      const others = await this.nativeLocks.users(job.harnessId);
      if (others.live.length) throw new ManagementError("HARNESS_BUSY", "另一个 HarnessHub 进程（进程 " + others.live.slice(0, 4).join("、") + "）正在使用这个程序，等它结束后再升级。");
      const usage = await native.usage(plan, recipe, context); owned();
      const consent = new Set(job.native.restartServices ?? []), restart = usage.services.filter(service => service.declared?.restart === true);
      const unagreed = restart.filter(service => !consent.has(service.label));
      if (unagreed.length) throw new ManagementError("SERVICE_CONSENT_REQUIRED", "升级需要重启 " + unagreed.map(service => service.label).join("、") + "，这次请求没有同意重启它。请重新打开升级确认后再升级。");
      // A service the upgrade restarts starts the new version on its own Node.js, which must meet the release's range too.
      const blocking = (await native.runtimes(plan, recipe, version, restart.filter(service => consent.has(service.label)), context)).find(runtime => runtime.service !== null && !runtime.satisfied); owned();
      if (blocking) throw new ManagementError("RUNTIME_INCOMPATIBLE", runtimeRefusal(version, blocking));
      const left = [...usage.services.filter(service => service.declared?.restart !== true).map(service => service.label), ...usage.resident.map(program => program.name + "（进程 " + program.pid + "）"), ...usage.processes.map(program => program.name + "（进程 " + program.pid + "）")];
      if (left.length) note("这些程序不会被关闭，继续使用旧版本，重开后才用新版本：" + left.slice(0, 12).join("、") + (left.length > 12 ? " 等 " + left.length + " 个" : "") + "。");
      const closed = this.users === null ? 0 : await this.users.closeIdle(job.harnessId); owned();
      if (closed) { this.nativeFacts(job.id, { closedConversations: closed }); note("关闭了 " + closed + " 个对话保留的进程，它们下次发消息时会重新连接。"); }
      this.phase(job.id, "installing", { resolvedVersion: version }); lock = this.nativeLocks.write(job.harnessId, job.id);
      if (lock.cleared.length) {
        this.nativeFacts(job.id, { clearedRecords: lock.cleared.length });
        for (const record of lock.cleared) note("清除了一条旧的使用记录：写入它的 HarnessHub 进程" + (record.pid === null ? "" : " " + record.pid) + " 已不再使用这个程序。");
      }
      const result = await native.execute(plan, recipe, version, { ...context, beginMutation: () => {
        owned(); if (dispatched) return; const current = this.readJob(job.id); if (!current.native) throw new ManagementError("INVALID_DATA", "native job facts are missing");
        this.saveJob({ ...current, native: { ...current.native, dispatched: true } }); dispatched = true;
      } }); owned();
      this.phase(job.id, "verifying");
      if (!dispatched || plan.channel !== "native-cli" && result.version !== version || !result.configurationPreserved) throw new ManagementError("NATIVE_VERIFICATION_FAILED", "native result did not match the planned version and configuration protection");
      verified = true; this.nativeFacts(job.id, { actualVersion: result.version, configurationPreserved: true });
      note("已核实本机程序为 " + result.version + "，受保护的配置文件没有改动。");
      // Old processes and new files coexist until the restart, so it follows the verification at once.
      const agreed = restart.filter(service => consent.has(service.label));
      if (agreed.length) {
        this.phase(job.id, "activating");
        const before = await native.configuration(), facts: ServiceRestartFact[] = []; let failure: ManagementError | null = null;
        for (const service of agreed) {
          note("正在重启 " + service.label + "：launchctl kickstart -k " + service.target);
          try {
            const outcome = await native.restartService(service, context); owned();
            if (outcome === null) { facts.push({ label: service.label, outcome: "not_running", pid: null, ready: null }); note(service.label + " 已不在运行，没有重启它。"); continue; }
            facts.push({ label: service.label, outcome: "restarted", pid: outcome.pid, ready: outcome.ready });
            if (outcome.ready === false) { failure ??= new ManagementError("SERVICE_NOT_READY", service.label + " 已重新运行（进程 " + outcome.pid + "），但 60 秒内没有在端口 " + service.port + " 上监听。可以在终端运行 launchctl kickstart -k " + service.target + " 再试一次。"); note(failure.message); }
            else note(service.label + " 已重新运行（进程 " + outcome.pid + "）" + (outcome.ready === true ? "，正在端口 " + service.port + " 上监听。" : "；不知道它监听的端口，可用性未验证。"));
          } catch (error) {
            if (!(error instanceof ManagementError) || error.code !== "SERVICE_NOT_RECOVERED" && error.code !== "SERVICE_RESTART_FAILED") throw error;
            facts.push({ label: service.label, outcome: "not_recovered", pid: null, ready: null });
            failure ??= new ManagementError(error.code, (error.code === "SERVICE_RESTART_FAILED" ? "系统服务管理器拒绝重启 " : "重启后 60 秒内 ") + service.label + (error.code === "SERVICE_RESTART_FAILED" ? "。" : " 没有重新运行。")
              + "新版本 " + result.version + " 已安装。可以在终端运行 launchctl kickstart -k " + service.target + " 再试一次" + (rollbackCommand(plan) ? "；要退回原版本，运行 " + rollbackCommand(plan) + " 后再执行同一条重启命令。" : "。"));
            note(failure.message);
          }
        }
        const changed = before !== await native.configuration();
        this.nativeFacts(job.id, { services: facts, ...(changed ? { configurationChangedByService: true } : {}) });
        if (changed) note("重启后受保护的配置文件有了变化：这是重启后的服务自己写入的，HarnessHub 没有写入。");
        if (failure) throw failure;
      }
      const current = this.readJob(job.id); if (!current.native) throw new ManagementError("INVALID_DATA", "native result lost its facts");
      this.phase(job.id, "completed", { resolvedVersion: result.version, native: { ...current.native, actualVersion: result.version, configurationPreserved: true } });
      this.systemVersions.delete(job.harnessId); this.nativePlans.delete(job.harnessId + ":" + job.controlId);
    } catch (error) {
      this.own(); const failure = error instanceof ManagementError ? error : new ManagementError("NATIVE_FAILED", "native maintenance did not finish");
      quiescent = failure.code !== "CLEANUP_FAILED";
      // A verified installation is a known one: a later failure (a service that did not run again) fails the job.
      const status = verified ? "failed" : dispatched || !quiescent || failure.code === "OWNERSHIP_LOST" ? "unknown" : controller.signal.aborted ? "cancelled" : "failed";
      this.phase(job.id, status, { error: { code: active.timedOut ? "INSTALL_TIMEOUT" : failure.code, message: this.redactor(failure.message) } });
      if (verified) { this.systemVersions.delete(job.harnessId); this.nativePlans.delete(job.harnessId + ":" + job.controlId); }
    } finally {
      clearTimeout(timer); this.active = null;
      lock?.release(verified || !dispatched && quiescent);
      if (quiescent && stage && identity && sameManagementIdentity(identity, managementIdentity(stage, true))) await rm(stage, { recursive: true, force: true });
    }
  }
  /** Explicit inspection verifies the current program without replaying an uncertain mutation. */
  async inspectNativeResult(id: string): Promise<InstallationJobView> {
    this.admission(); const job = this.readJob(id);
    const official = job.native?.official !== undefined, upgrade = job.native?.installation !== undefined;
    if (job.status !== "unknown" || !job.native || (job.action === "uninstall" ? !this.removal : official ? !this.officialInstaller : upgrade ? !this.upgrader : !this.native) || job.error?.code === "CLEANUP_FAILED") throw new ManagementError("INSPECTION_UNAVAILABLE", "this native result cannot yet be inspected safely");
    const operation = job.action === "uninstall" ? this.inspectUninstallOwned(job) : official ? this.inspectOfficialInstallOwned(job) : upgrade ? this.inspectUpgradeOwned(job) : this.inspectNativeOwned(job); this.checks.add(operation);
    void operation.then(() => this.checks.delete(operation), () => this.checks.delete(operation)); return operation;
  }
  private async inspectNativeOwned(job: InstallationJobView): Promise<InstallationJobView> {
    const row = this.storage.db.prepare("SELECT plan_json FROM management_native_plans WHERE job_id=?").get(job.id), plan = parseNativePlan(json(row?.plan_json));
    const lock = this.nativeLocks.write(job.harnessId, job.id, true); let verified = false;
    try {
      const version = await this.nativeInspection(context => this.native!.inspect(plan, context)); lock.assertOwned(); this.own();
      const current = this.readJob(job.id); if (!current.native || current.status !== "unknown") throw new ManagementError("DEFAULT_CONFLICT", "native result changed during inspection");
      this.phase(job.id, "failed", { native: { ...current.native, actualVersion: version }, error: { code: "NATIVE_RESULT_INSPECTED", message: "已核实本机当前版本为 " + version + "；原任务未确认为完成，未重跑安装。" } });
      verified = true; this.systemVersions.delete(job.harnessId); this.nativePlans.delete(job.harnessId + ":" + job.controlId); return this.readJob(job.id);
    } finally { lock.release(verified); }
  }
  /** Whether an official install of unknown result left the product in its channel; settles the job as failed with what was found, never reruns it. */
  private async inspectOfficialInstallOwned(job: InstallationJobView): Promise<InstallationJobView> {
    const row = this.storage.db.prepare("SELECT request_json FROM management_install_requests WHERE job_id=?").get(job.id), request = parseInstallRequest(json(row?.request_json));
    const found = await this.nativeInspection(context => this.officialInstaller!.verify(request, context)); this.own();
    const current = this.readJob(job.id); if (current.status !== "unknown" || !current.native?.official) throw new ManagementError("DEFAULT_CONFLICT", "install result changed during inspection");
    this.saveJob({ ...current, status: "failed", phase: "failed", updatedAt: this.now(), native: { ...current.native, actualVersion: found?.version ?? null, official: { ...current.native.official, installed: found !== null } },
      error: { code: "NATIVE_RESULT_INSPECTED", message: found === null ? "已核实：没有在官网渠道里找到它。原任务没有完成安装，没有重跑。" : "已核实：" + request.command + (found.version ? " " + found.version : "") + " 装在官网渠道里。原任务未确认为完成，没有重跑。" } });
    this.systemVersions.delete(job.harnessId); return this.readJob(job.id);
  }
  /** The version an installation upgrade of unknown result left; settles the job as failed with what was found, never reruns it. */
  private async inspectUpgradeOwned(job: InstallationJobView): Promise<InstallationJobView> {
    const target = this.storedUpgrade(job.id).target;
    const lock = target.active && job.native?.dispatched ? this.nativeLocks.write(job.harnessId, job.id, true) : undefined; let known = false;
    try {
      const version = await this.nativeInspection(context => this.upgrader!.version(target, context)); lock?.assertOwned(); this.own();
      const current = this.readJob(job.id); if (current.status !== "unknown" || !current.native?.installation) throw new ManagementError("DEFAULT_CONFLICT", "upgrade result changed during inspection");
      this.saveJob({ ...current, status: "failed", phase: "failed", updatedAt: this.now(), native: { ...current.native, actualVersion: version },
        error: { code: "NATIVE_RESULT_INSPECTED", message: version === null ? "读不出这份安装现在的版本。原任务未确认为完成，没有重跑。" : "已核实：这份安装现在是 " + version + "。原任务未确认为完成，没有重跑。" } });
      known = true; this.updates.delete(target.ref); this.systemVersions.delete(job.harnessId); this.programVersions.delete(job.harnessId); return this.readJob(job.id);
    } finally { lock?.release(known); }
  }
  /** Whether an uninstall of unknown result left the installation's files; settles the job as failed with what was found, never reruns it. */
  private async inspectUninstallOwned(job: InstallationJobView): Promise<InstallationJobView> {
    const target = this.storedTarget(job.id);
    // The maintenance lock of the installation this Gateway runs was taken before anything changed; inspection settles it.
    const lock = target.active && job.native?.dispatched ? this.nativeLocks.write(job.harnessId, job.id, true) : undefined; let known = false;
    try {
      const remains = await this.removal!.remains(target); lock?.assertOwned(); this.own();
      const current = this.readJob(job.id); if (current.status !== "unknown" || !current.native?.uninstall) throw new ManagementError("DEFAULT_CONFLICT", "uninstall result changed during inspection");
      this.saveJob({ ...current, status: "failed", phase: "failed", updatedAt: this.now(), native: { ...current.native, uninstall: { ...current.native.uninstall, removed: !remains } },
        error: { code: "NATIVE_RESULT_INSPECTED", message: remains ? "已核实：这份安装的文件仍在。原任务没有完成卸载，没有重跑。" : "已核实：这份安装已删除。原任务未确认为完成，没有重跑。" } });
      known = true; this.systemVersions.delete(job.harnessId); return this.readJob(job.id);
    } finally { lock?.release(known); }
  }
  resolveControl(harnessId: string, controlId: string): ResolvedManagedControl | null {
    this.own(); this.payloadBudgets(); managementSlug(harnessId); managementSlug(controlId);
    const pointer = this.storage.db.prepare("SELECT installation_id,revision FROM management_defaults WHERE harness_id=?").get(harnessId);
    if (!pointer) return null;
    if (typeof pointer.installation_id !== "string" || typeof pointer.revision !== "number") throw new ManagementError("INVALID_DATA", "managed installation pointer is invalid");
    const row = this.storage.db.prepare("SELECT record_json FROM management_installations WHERE id=? AND length(CAST(record_json AS BLOB))<=65536").get(pointer.installation_id);
    if (!row) throw new ManagementError("INVALID_DATA", "managed installation default is dangling");
    const record = parseInstallationRecord(json(row.record_json));
    if (record.id !== pointer.installation_id || record.harnessId !== harnessId) throw new ManagementError("INVALID_DATA", "managed installation identity changed");
    if (record.controlId !== controlId) return null;
    // One installed with a Node.js that has since changed is not run with another (ADR-043).
    if (!this.verifyStoredRecord(record)) return null;
    return { installationId: record.id, revision: pointer.revision, version: record.version,
      command: { executable: record.command.executable, args: [...record.command.args], env: { ...record.command.env } } };
  }
  views(harnessIds: readonly string[]): readonly HarnessManagementView[] {
    this.own(); this.payloadBudgets(); if (harnessIds.length > 256) throw new ManagementError("INVALID_INPUT", "too many management views requested");
    return harnessIds.map(harness => {
      managementSlug(harness); const recipe = this.capability(harness), pointer = this.storage.db.prepare("SELECT installation_id,revision FROM management_defaults WHERE harness_id=?").get(harness);
      let installedVersion: string | null = null, installationId: string | null = null;
      if (pointer) {
        if (typeof pointer.installation_id !== "string") throw new ManagementError("INVALID_DATA", "managed installation pointer is invalid");
        const row = this.storage.db.prepare("SELECT record_json FROM management_installations WHERE id=? AND length(CAST(record_json AS BLOB))<=65536").get(pointer.installation_id);
        if (!row) throw new ManagementError("INVALID_DATA", "managed installation default is dangling");
        const record = parseInstallationRecord(json(row.record_json));
        if (this.verifyStoredRecord(record)) { installedVersion = record.version; installationId = record.id; }
      }
      const update = this.storage.db.prepare("SELECT view_json FROM management_updates WHERE harness_id=? AND length(CAST(view_json AS BLOB))<=65536").get(harness);
      const checked = update ? parseManagementUpdate(json(update.view_json)) : null;
      const active = this.storage.db.prepare("SELECT id FROM management_jobs WHERE harness_id=? AND status NOT IN('completed','cancelled','failed','unknown')").get(harness)?.id;
      const system = this.system.has(harness);
      const currentVersion = system || installationId === null ? this.systemVersion(harness) : installedVersion;
      const nativeRecipe = this.recipe(harness), nativePlan = nativeRecipe ? this.nativePlans.get(harness + ":" + nativeRecipe.controlId) : undefined;
      let updateStatus = checked?.updateStatus ?? (recipe?.canInstall ? "unchecked" : "unsupported");
      if (checked?.latestVersion != null && checked.error === null && ["unchecked", "available", "current"].includes(updateStatus)) {
        const newer = currentVersion !== null && (valid(checked.latestVersion) && valid(currentVersion)
          ? gt(checked.latestVersion, currentVersion) : checked.latestVersion !== currentVersion);
        updateStatus = currentVersion === null ? "unchecked" : newer ? "available" : "current";
      }
      const programVersion = system ? this.programVersion(harness, currentVersion) : currentVersion, verification = versionVerification(harness, programVersion, currentVersion);
      return { harnessId: harness, recipe, source: system ? "system" : installationId === null ? "missing" : "managed",
        installedVersion: currentVersion, programVersion, installationId: system ? null : installationId, ...(verification === null ? {} : { verification }),
        latestVersion: checked?.latestVersion ?? null, updateStatus,
        checkedAt: checked?.checkedAt ?? null, activeJobId: typeof active === "string" ? active : null, defaultRevision: this.defaultRevision(harness), error: checked?.error ?? null,
        ...(nativePlan === undefined ? {} : { native: { channel: nativePlan.channel, location: nativePlan.entry, fingerprint: nativePlan.fingerprint,
          canInstall: nativePlan.channel !== "unsupported" && nativePlan.reason === null && !nativePlan.actualEntry,
          canUpgrade: nativePlan.channel !== "unsupported" && nativePlan.reason === null && nativePlan.beforeVersion !== null && !!nativePlan.actualEntry && !(checked?.latestVersion && valid(checked.latestVersion) && valid(nativePlan.beforeVersion) && !gt(checked.latestVersion, nativePlan.beforeVersion)),
          reason: nativePlan.reason } }) };
    });
  }
  /**
   * Checks the latest version of each Harness's control program and of each npm and Homebrew installation (ADR-044) of
   * `harnessIds`, or of every one when none are given. Network reads only; installation results stay in memory.
   */
  checkUpdates(harnessIds?: readonly string[]): Promise<readonly HarnessManagementView[]> {
    this.admission(); if (this.checks.size >= 4) return Promise.reject(new ManagementError("CHECK_LIMIT", "too many update checks are already active"));
    const operation = this.checkOwned(harnessIds ?? [...new Set(this.recipes.map(item => item.harnessId))]).then(async views => { await this.checkInstallations(harnessIds ?? null); return views; });
    this.checks.add(operation); void operation.then(() => this.checks.delete(operation), () => this.checks.delete(operation)); return operation;
  }
  /** Read the selected local program's version without downloading releases or changing its configuration. */
  refreshSystemVersions(): Promise<readonly HarnessManagementView[]> {
    this.admission();
    const operation = this.readSystemVersions(); this.checks.add(operation);
    void operation.then(() => this.checks.delete(operation), () => this.checks.delete(operation)); return operation;
  }
  private async readSystemVersions(): Promise<readonly HarnessManagementView[]> {
    const entries = [...this.system.entries()]; let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      for (;;) {
        const entry = entries[index++]; if (!entry || !this.accepting) return;
        const [id, observation] = entry, fingerprint = this.systemFingerprint(observation);
        if (this.systemVersions.get(id)?.fingerprint === fingerprint) { await this.readProgramVersion(id, observation); continue; }
        const controller = new AbortController(); this.checkControllers.add(controller);
        try {
          const result = await (this.options.systemVersionProbe ?? probeSystemVersion)(observation, { signal: controller.signal, assertOwned: () => this.own(), redact: this.redactor }); this.own();
          if (this.system.get(id) === observation) this.systemVersions.set(id, { fingerprint, version: result.version });
        } finally { this.checkControllers.delete(controller); }
        await this.readProgramVersion(id, observation);
      }
    }));
    return this.views(entries.map(([id]) => id));
  }
  /** The adapter's product version through the same isolated --version probe; read once per product command. */
  private async readProgramVersion(id: string, observation: SystemInstallationObservation): Promise<void> {
    const program = observation.program; if (program === undefined || !this.accepting) return;
    const fingerprint = createHash("sha256").update(JSON.stringify(program)).digest("hex");
    if (this.programVersions.get(id)?.fingerprint === fingerprint) return;
    const controller = new AbortController(); this.checkControllers.add(controller);
    try {
      const result = await (this.options.systemVersionProbe ?? probeSystemVersion)({ harnessId: observation.harnessId, controlId: observation.controlId, command: program },
        { signal: controller.signal, assertOwned: () => this.own(), redact: this.redactor }); this.own();
      if (this.system.get(id) === observation) this.programVersions.set(id, { fingerprint, version: result.version });
    } finally { this.checkControllers.delete(controller); }
  }
  private programVersion(harnessId: string, entryVersion: string | null): string | null {
    const program = this.system.get(harnessId)?.program; if (program === undefined) return entryVersion;
    const cached = this.programVersions.get(harnessId);
    return cached?.fingerprint === createHash("sha256").update(JSON.stringify(program)).digest("hex") ? cached.version : null;
  }
  private async checkOwned(ids: readonly string[]): Promise<readonly HarnessManagementView[]> {
    if (ids.length > 256) throw new ManagementError("INVALID_INPUT", "too many update targets");
    for (const id of ids) managementSlug(id);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        if (!this.accepting) return;
        const id = ids[index++]; if (id === undefined) return; this.own(); const recipe = this.recipe(id), capability = this.capability(id);
        if (!recipe || !capability?.canInstall) continue;
        const controller = new AbortController(); this.checkControllers.add(controller); const timer = setTimeout(() => controller.abort(), 15000);
        this.storeUpdate(id, { latestVersion: null, updateStatus: "checking", checkedAt: null, error: null });
        try {
          if (this.system.has(id)) {
            const observation = this.system.get(id);
            if (observation) {
              const observed = await (this.options.systemVersionProbe ?? probeSystemVersion)(observation, { signal: controller.signal, assertOwned: () => this.own(), redact: this.redactor }); this.own();
              this.systemVersions.set(id, { fingerprint: this.systemFingerprint(observation), version: observed.version });
            }
          }
          const nativePlan = this.nativePlans.get(id + ":" + recipe.controlId);
          const spec = this.native && nativePlan
            ? { version: await this.nativeInspection(context => this.native!.latest(nativePlan, recipe, { ...context, signal: AbortSignal.any([context.signal, controller.signal]) })) }
            : await this.metadata.resolve(recipe, controller.signal); this.own();
          const installed = this.views([id])[0]!.installedVersion;
          if (spec.version === "vendor-latest") { this.storeUpdate(id, { latestVersion: null, updateStatus: "unchecked", checkedAt: this.now(), error: null }); continue; }
          const available = installed !== null && (valid(spec.version) && valid(installed) ? gt(spec.version, installed) : spec.version !== installed);
          this.storeUpdate(id, { latestVersion: spec.version, updateStatus: available ? "available" : installed === null ? "unchecked" : "current", checkedAt: this.now(), error: null });
        } catch (error) { this.own(); this.storeUpdate(id, { latestVersion: null, updateStatus: "failed", checkedAt: this.now(), error: { code: error instanceof ManagementError ? error.code : "CHECK_FAILED", message: "latest version could not be checked" } }); }
        finally { clearTimeout(timer); this.checkControllers.delete(controller); }
      }
    })); return this.views(ids);
  }
  private storeUpdate(id: string, value: Pick<HarnessManagementView, "latestVersion" | "updateStatus" | "checkedAt" | "error">): void {
    this.own(); this.storage.db.prepare("INSERT INTO management_updates(harness_id,view_json) VALUES(?,?) ON CONFLICT(harness_id) DO UPDATE SET view_json=excluded.view_json").run(id, JSON.stringify(value));
  }
  shutdown(): Promise<void> {
    this.stopping ??= this.shutdownOwned(); return this.stopping;
  }
  close(): void {
    if (this.closed) return;
    if (this.runner !== null || this.active !== null || this.checks.size !== 0) throw new ManagementError("MANAGEMENT_ACTIVE", "active management work requires awaitable shutdown");
    this.accepting = false; this.closed = true; this.storage.db.close(); openRoots.delete(this.storage.root);
  }
  private async shutdownOwned(): Promise<void> {
    if (this.closed) return; this.accepting = false;
    const pending = [ ...(this.runner === null ? [] : [this.runner]), ...this.checks ];
    this.active?.controller.abort();
    for (const check of this.checkControllers) check.abort();
    let failure: unknown = null;
    try {
      this.own();
      for (const row of this.storage.db.prepare("SELECT id FROM management_jobs WHERE status='queued'").all()) {
        if (typeof row.id !== "string") throw new ManagementError("INVALID_DATA", "queued installation identity is invalid");
        this.phase(row.id, "cancelled", { cancelRequested: true });
      }
      if (this.active !== null) { const job = this.readJob(this.active.id); this.saveJob({ ...job, cancelRequested: true }); }
    } catch (error) { failure = error; }
    const settled = await Promise.allSettled(pending);
    for (const result of settled) if (result.status === "rejected") failure ??= result.reason;
    this.closed = true;
    try { this.storage.db.close(); } catch { failure ??= new ManagementError("CLEANUP_FAILED", "management database close could not be confirmed"); }
    finally { openRoots.delete(this.storage.root); }
    if (failure !== null) throw failure;
  }
}
