import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";

export class ManagementError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ManagementError"; }
}
export type InstallationJobStatus = "queued" | "resolving" | "installing" | "verifying" | "activating" | "completed" | "cancelled" | "failed" | "unknown";
export interface InstallationJobView {
  readonly id: string;
  readonly harnessId: string;
  readonly controlId: string;
  /** `uninstall` removes one official installation through its channel (ADR-044, management schema v4). */
  readonly action: "install" | "upgrade" | "uninstall";
  readonly status: InstallationJobStatus;
  readonly phase: string;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedVersion: string | null;
  readonly installationId: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly logCursor: number;
  readonly native?: NativeJobFacts;
}
/** What a native upgrade did to the programs using the installation (ADR-043); fields after `configurationPreserved` exist from management schema v3. */
export interface NativeJobFacts {
  readonly channel: string;
  readonly location: string;
  readonly beforeVersion: string | null;
  readonly actualVersion: string | null;
  readonly dispatched: boolean;
  readonly configurationPreserved: boolean | null;
  /** The service labels the user agreed to have restarted when submitting. */
  readonly restartServices?: readonly string[];
  /** How many HarnessHub conversations' idle native processes were closed before the upgrade; they reconnect on their next message. */
  readonly closedConversations?: number;
  /** How many usage records of ended HarnessHub processes were cleared under the maintenance lock. */
  readonly clearedRecords?: number;
  /** Each agreed service after the new version was verified: restarted (with its new process), not running then, or not running again. */
  readonly services?: readonly ServiceRestartFact[];
  /** A protected configuration changed after the restart although it was unchanged right before: the restarted service wrote it. */
  readonly configurationChangedByService?: boolean;
  /** What an uninstall removed and stopped (ADR-044); present on uninstall jobs only, from management schema v4. */
  readonly uninstall?: UninstallFacts;
  /** What an official install ran and changed (ADR-044); present on official install jobs only, from management schema v5. */
  readonly official?: OfficialInstallFacts;
  /** What upgrading one installation through its channel did (ADR-044); present on those upgrade jobs only, from management schema v6. */
  readonly installation?: InstallationUpgradeFacts;
  /** The hops of a product's documented upgrade sequence (ADR-052), in the order they ran, at most 4; present on such upgrades only. */
  readonly hops?: readonly UpgradeHopFact[];
  /** That the user confirmed the product's own backup before a sequenced upgrade (ADR-052); part of the command's identity. */
  readonly backupConfirmed?: boolean;
  /** Protected configuration files (with ~) the product's Doctor rewrote during the sequence: expected there and recorded, not a failure; HarnessHub itself wrote nothing. */
  readonly configurationMigrated?: readonly string[];
}
/** One hop of a product's documented upgrade sequence (ADR-052): whether its release was installed and verified, and what its Doctor did. */
export interface UpgradeHopFact {
  readonly version: string;
  /** Whether the package was installed and its manifest read back at this version. */
  readonly installed: boolean;
  /** The product's Doctor after the install: `ok`; `failed` (the sequence stopped here, its words in the job's error); `skipped` (not reached). */
  readonly doctor: "ok" | "failed" | "skipped";
}
/** How one installation is upgraded through its own channel (ADR-044). */
export type UpgradeKind = "version" | "self-update" | "rerun";
/** One installation upgrade's facts: which installation, how, and the versions before and after. */
export interface InstallationUpgradeFacts {
  readonly label: string;
  readonly role: "product" | "adapter";
  readonly kind: UpgradeKind;
  /** The command that ran, with ~ for the home directory. */
  readonly command: string;
  /** Formulae Homebrew upgraded alongside, as its dry run listed them. */
  readonly dependencies: readonly string[];
  /** Lines the official script changed in the one shell startup file it may change, and key paths of a product configuration. */
  readonly shellChanges: readonly { readonly file: string; readonly added: readonly string[]; readonly removed: readonly string[] }[];
  readonly configChanges: readonly { readonly file: string; readonly keys: readonly { readonly path: string; readonly value: string | null }[] }[];
  readonly blocked: readonly string[];
}
/** One official install's facts: how it ran and what it changed besides the program itself. */
export interface OfficialInstallFacts {
  readonly method: "script" | "npm";
  /** The script's final URL, or the npm package and exact version. */
  readonly source: string;
  /** The SHA-256 of the script copy that ran; null for npm. */
  readonly sha256: string | null;
  /** Lines the script added to or removed from the shell startup file it was allowed to change. */
  readonly shellChanges: readonly { readonly file: string; readonly added: readonly string[]; readonly removed: readonly string[] }[];
  /** Keys the installer changed in the product configuration it was allowed to write; values only for known install fields. */
  readonly configChanges: readonly { readonly file: string; readonly keys: readonly { readonly path: string; readonly value: string | null }[] }[];
  /** Paths the installer tried to write outside what it was allowed, as its output named them; they were blocked. */
  readonly blocked: readonly string[];
  /** Whether the product was found installed in its official channel afterwards. */
  readonly installed: boolean;
}
/** One uninstall's facts: the installation by its label, the services the user agreed to stop and those stopped, and whether removal was verified. */
export interface UninstallFacts {
  /** Where it was, in the user's terms, such as "npm 全局（nvm v23.10.0）". */
  readonly label: string;
  readonly role: "product" | "adapter";
  /** The service labels the user agreed to have stopped and unregistered; an uninstall finding another one stops before changing anything. */
  readonly stopServices: readonly string[];
  /** Services stopped and unregistered with the product's own commands. */
  readonly stoppedServices: readonly string[];
  /** Whether the program's files were confirmed gone. */
  readonly removed: boolean;
}
export interface ServiceRestartFact {
  readonly label: string;
  readonly outcome: "restarted" | "not_running" | "not_recovered";
  readonly pid: number | null;
  /** Whether it listened on its declared port; null when it declares none or did not run again. */
  readonly ready: boolean | null;
}
export interface InstallationLog {
  readonly seq: number;
  readonly time: string;
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}
export interface InstallCapability {
  readonly controlId: string;
  readonly kind: "npm" | "python" | "binary";
  readonly sourceLabel: string;
  readonly packageName: string | null;
  readonly canInstall: boolean;
  readonly reason: string | null;
}
export interface HarnessManagementView {
  readonly harnessId: string;
  readonly recipe: InstallCapability | null;
  readonly source: "managed" | "system" | "missing";
  readonly installedVersion: string | null;
  /** The product's own version. It equals installedVersion unless the control entry is an adapter with its own version. */
  readonly programVersion: string | null;
  readonly latestVersion: string | null;
  readonly updateStatus: "unchecked" | "checking" | "available" | "current" | "failed" | "unsupported";
  readonly checkedAt: string | null;
  readonly activeJobId: string | null;
  readonly installationId: string | null;
  readonly defaultRevision: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly native?: NativeManagementCapability;
}
export interface NativeManagementCapability {
  readonly channel: string;
  readonly location: string;
  readonly fingerprint: string;
  readonly canInstall: boolean;
  readonly canUpgrade: boolean;
  readonly reason: string | null;
}
/** Private frozen installation plan. It contains program references, never configuration contents or credentials. */
export interface NativeInstallPlan {
  readonly harnessId: string;
  readonly controlId: string;
  readonly channel: "npm" | "brew-formula" | "brew-cask" | "uv" | "archive" | "native-cli" | "unsupported";
  readonly manager: string;
  readonly reference: string;
  readonly prefix: string;
  readonly entry: string;
  readonly actualEntry: string;
  readonly beforeVersion: string | null;
  readonly fingerprint: string;
  readonly reason: string | null;
}
export interface NativeManagementPort {
  describe(recipe: ManagementRecipe, observation: SystemInstallationObservation | undefined, version: string | null, context: ManagementInstallContext): Promise<NativeInstallPlan>;
  latest(plan: NativeInstallPlan, recipe: ManagementRecipe, context: ManagementInstallContext): Promise<string>;
  /**
   * Every check of this exact version that changes nothing: newer than the installed one, its release metadata and the
   * runtime it requires; a product HarnessHub does not upgrade this way is refused before anything is resolved. Fails
   * with the reason the upgrade cannot run.
   */
  prepare(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: ManagementInstallContext): Promise<void>;
  /** Installs the prepared version through the original channel and verifies it; services keep running (ADR-043). */
  execute(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: NativeInstallContext): Promise<{ readonly version: string; readonly configurationPreserved: boolean }>;
  /** The programs running this installation now, read once and never signalled (ADR-043). */
  usage(plan: NativeInstallPlan, recipe: ManagementRecipe, context: ManagementInstallContext): Promise<ProgramUsage>;
  /**
   * Restarts one service with the host's service manager and waits until it runs again: a new process, running and
   * unchanged for five seconds, within a minute; `ready` says whether it listened on its known port (null when none is
   * known). Resolves null without restarting when it no longer runs; rejects with SERVICE_RESTART_FAILED or
   * SERVICE_NOT_RECOVERED.
   */
  restartService(service: UsedService, context: ManagementInstallContext): Promise<{ readonly pid: number; readonly ready: boolean | null } | null>;
  /** Hashes of the protected configuration files, compared around the restart; contents never leave this call. */
  configuration(): Promise<string>;
  /** Directory names in the recipe's plugin directory; contents are never read. */
  plugins(recipe: ManagementRecipe): Promise<readonly string[]>;
  /**
   * The Node.js this exact version requires (ADR-043), against each runtime that will run it: the program's `#!`
   * interpreter, and each given service's program when that is Node.js. Empty when the release declares none. Changes nothing.
   */
  runtimes(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, services: readonly UsedService[], context: ManagementInstallContext): Promise<readonly RuntimeRequirement[]>;
  inspect(plan: NativeInstallPlan, context: ManagementInstallContext): Promise<string>;
  /**
   * Runs the product's documented upgrade sequence (ADR-052) over `hops`, in order. Every release is resolved first;
   * then (beginMutation) the gateway service among `services` is stopped with the product's command; each hop installs
   * its npm release with the product's lifecycle scripts allowed under the configuration write protection, is verified
   * by the package manifest it left, and has the product's Doctor run without that protection (it migrates the
   * configuration); after the last hop the gateway is started with the product's command and must run again (ADR-043
   * 决定 5, no kickstart), its status is captured to the log, and the services the recipe restarts are restarted with the
   * product's commands when they ran before. Each hop and service is reported through `context` as it settles, so a
   * failure keeps what ran. Rejects at the first failure (DOCTOR_FAILED with the Doctor's words, SERVICE_NOT_RECOVERED,
   * SERVICE_NOT_READY, …); nothing is retried or rolled back. Resolves with the version verified and the protected files
   * the Doctor rewrote. Only for a recipe declaring `upgradeSequence` on an npm plan.
   */
  executeSequence(plan: NativeInstallPlan, recipe: ManagementRecipe, hops: readonly string[], services: readonly UsedService[], context: SequenceContext): Promise<{ readonly version: string; readonly configurationMigrated: readonly string[] }>;
}
/** The job's view of a running upgrade sequence (ADR-052): each hop and service fact is recorded as it settles. */
export interface SequenceContext extends NativeInstallContext {
  hop(fact: UpgradeHopFact): void;
  service(fact: ServiceRestartFact): void;
}
/** A running service-manager job whose program is this installation, with the recipe's facts when it declares the job. */
export interface UsedService {
  readonly label: string;
  readonly pid: number;
  /** The domain target the service manager knows it by (launchd `gui/<uid>/<label>`). */
  readonly target: string;
  /** The TCP port its arguments give for the recipe's `portFlag`; null when it declares none or the arguments carry none. */
  readonly port: number | null;
  /** The executable its job starts (an interpreter such as node for a script); null when the job names none. */
  readonly program: string | null;
  readonly declared: RecipeService | null;
}
/** A running program by process id and base name only; arguments are never kept. `stop`: the product's command that stops it, when known. */
export interface ProgramEntry { readonly pid: number; readonly name: string; readonly stop?: string }
export interface ProgramUsage {
  /** Whether the host's service manager could be read (macOS launchd); elsewhere every program is a plain process. */
  readonly servicesKnown: boolean;
  readonly services: readonly UsedService[];
  /** Resident programs running outside a service manager, by the names the recipe declares. */
  readonly resident: readonly ProgramEntry[];
  /** Other programs running this installation, such as terminal sessions. */
  readonly processes: readonly ProgramEntry[];
}
/** HarnessHub's own conversations using a native program, as the session runtime knows them (ADR-043). */
export interface NativeProgramUsers {
  /** Conversations with a Turn of this Harness queued, waiting or running (busy), and conversations keeping its idle process. */
  list(harnessId: string): readonly { readonly sessionId: string; readonly busy: boolean }[];
  /** Closes every idle kept process of this Harness with the normal stop chain; resolves with how many, once each close is recorded. */
  closeIdle(harnessId: string): Promise<number>;
}
/**
 * A runtime a release requires, and one that will run it: the program's `#!` interpreter on the user's PATH, or the Node.js
 * a service's job starts. Services keep their own Node.js path; they do not load the user's shell (nvm and the like).
 */
export interface RuntimeRequirement {
  readonly runtime: "Node.js";
  /** The release's `engines` range. */
  readonly required: string;
  /** The version the interpreter reports; null when it could not be read. */
  readonly found: string | null;
  readonly path: string;
  readonly satisfied: boolean;
  /** The service that runs on it; null for the program itself. */
  readonly service: string | null;
  /** Whether the upgrade starts it on the new version: the program, or a service it restarts. Such a runtime not met blocks the upgrade. */
  readonly restarted: boolean;
  /** How the user moves it to a newer version when HarnessHub knows: `brew upgrade <formula>` for a Homebrew Node.js. */
  readonly upgradeCommand: string | null;
}
/** What upgrading one Harness would touch, read once for the user's confirmation (ADR-043). */
export interface MaintenanceCheck {
  readonly harnessId: string;
  readonly checkedAt: string;
  /** The native installation this check describes; an upgrade submitted for another one is refused. */
  readonly fingerprint: string;
  readonly channel: string;
  readonly location: string;
  readonly currentVersion: string | null;
  /** The latest version the last update check found; the exact target is resolved again when the upgrade runs. */
  readonly targetVersion: string | null;
  readonly servicesKnown: boolean;
  /** Services restarted once the new version is verified, with the exact command. */
  readonly restart: readonly { readonly label: string; readonly name: string; readonly pid: number; readonly command: string; readonly portKnown: boolean }[];
  /** Resident programs left on the old version: services the product's own update does not restart, and resident programs outside a service manager. */
  readonly resident: readonly { readonly label: string | null; readonly name: string; readonly pid: number; readonly restartCommand: string | null }[];
  /** Other programs running this installation; never signalled, they use the new version once restarted. */
  readonly processes: readonly ProgramEntry[];
  /** HarnessHub conversations using it: idle kept processes are closed first; a busy one blocks the upgrade. */
  readonly conversations: readonly { readonly sessionId: string; readonly busy: boolean }[];
  /** Other HarnessHub processes (another Gateway or a command line) using it; they block the upgrade. */
  readonly otherUsers: readonly { readonly pid: number }[];
  /** Usage records of HarnessHub processes that have ended; cleared under the maintenance lock. */
  readonly staleRecords: number;
  /** Directory names of the product's installed plugins, which the new version may not support. */
  readonly plugins: readonly string[];
  readonly notes: readonly string[];
  /** The command returning the original installation to its current version, when its channel has one. */
  readonly rollback: string | null;
  /** The target's runtime requirement against each runtime that will run it; a restarted one not met blocks the upgrade. Empty when none is declared or it could not be read. */
  readonly runtimes: readonly RuntimeRequirement[];
  /** The product's documented upgrade sequence HarnessHub drives instead of installing the package alone (ADR-052); absent for every other product. */
  readonly sequence?: UpgradeSequenceCheck;
}
/**
 * A product's documented upgrade sequence as the confirmation shows it (ADR-052). Commands are the exact lines that run,
 * with ~ for the home directory; `rollback` of the check is null then, since an older release cannot open the data a
 * newer one migrated: the previous version is only returned to from the product's own backup.
 */
export interface UpgradeSequenceCheck {
  /** Each release installed in order; `bridge` marks an intermediate one upstream requires first. Each hop's Node.js range against the runtimes that will run it; an unmet one of a restarted runtime blocks. */
  readonly hops: readonly { readonly version: string; readonly bridge: boolean; readonly runtimes: readonly RuntimeRequirement[] }[];
  readonly commands: readonly string[];
  /** The gateway service stopped before the first hop and started after the last (its channels are offline throughout); null when it does not run now, then it is not started. */
  readonly gateway: { readonly label: string; readonly name: string; readonly pid: number } | null;
  /** Services restarted with the product's own command once the gateway recovered, as they run now. */
  readonly restarts: readonly { readonly label: string; readonly name: string; readonly pid: number; readonly command: string }[];
  /** The product's backup command the user must have run; a submission without the confirmation is refused before anything changes. */
  readonly backupCommand: string;
  /** The product's Doctor command, the configuration files (with ~) it rewrites, and how it keeps the previous copies. */
  readonly doctor: { readonly command: string; readonly rewrites: readonly string[]; readonly backups: string };
  /** How the previous version is returned to: only from the backup. */
  readonly rollback: string;
}
/** One background service a product's default installation registers with the host's service manager (ADR-043). */
export interface RecipeService {
  /** Its launchd label. */
  readonly label: string;
  readonly name: string;
  /** Whether the product's own update restarts it; HarnessHub restarts exactly these. */
  readonly restart: boolean;
  /** The product's own command for restarting it, shown when HarnessHub does not restart it. */
  readonly restartCommand?: string;
  /** The argument flag that gives the TCP port it listens on once ready. */
  readonly portFlag?: string;
}
export interface NativeInstallContext extends ManagementInstallContext { beginMutation(): void }
/** The official channels an installation can be maintained through (ADR-044); pnpm and bun installations are listed only. */
export type MaintainedChannel = "npm" | "brew-formula" | "brew-cask" | "script" | "uv";
/**
 * One official installation as discovery found it (ADR-044), handed to management after each scan. `ref` names it without
 * its path; everything else stays on the Gateway. `active`: the one of its role this Gateway runs (first in its PATH order).
 */
export interface InstallationObservation {
  readonly harnessId: string;
  /** The catalog control this program is the entry of, or the Harness's first control for a product its controls start indirectly. */
  readonly controlId: string;
  readonly ref: string;
  readonly role: "product" | "adapter";
  readonly channel: MaintainedChannel | "pnpm" | "bun";
  /** The npm package, Homebrew formula or cask, uv tool, or the script layout's root. */
  readonly name: string;
  /** The directory the channel owns for this installation. */
  readonly root: string;
  /** The npm or Homebrew prefix; null for script and uv channels. */
  readonly prefix: string | null;
  /** The command as found, and the file it resolves to. */
  readonly entry: string;
  readonly resolvedPath: string;
  readonly version: string | null;
  readonly active: boolean;
  /** Where it is in the user's terms, without its path. */
  readonly label: string;
}
/** A frozen uninstall target: the observation with the file identities checked again right before anything changes. */
export interface InstallationTarget extends InstallationObservation { readonly fingerprint: string }
/** What removing an installation runs and deletes, read without changing anything (ADR-044). Paths are absolute here. */
export interface RemovalPreview {
  readonly commands: readonly string[];
  readonly removes: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly documented: boolean;
}
/** The host side of an uninstall (ADR-044); replaced in tests that must not touch the user's programs or services. */
export interface InstallationRemovalPort {
  /** File identities of the installation, for its fingerprint; changes when it is updated, replaced or removed. */
  identity(target: InstallationObservation): Promise<string>;
  /** What removing it runs and deletes. Refuses a script layout that resolves outside its whitelist. */
  preview(target: InstallationObservation, context: ManagementInstallContext): Promise<RemovalPreview>;
  /**
   * Programs running it now: launchd jobs, the product's resident programs, other processes, and `own`, HarnessHub's own
   * processes (this Gateway's descendants, such as a conversation's native process). Read once, never signalled.
   */
  usage(target: InstallationObservation, context: ManagementInstallContext): Promise<{ readonly servicesKnown: boolean; readonly services: readonly { readonly label: string; readonly pid: number }[];
    readonly resident: readonly ProgramEntry[]; readonly processes: readonly ProgramEntry[]; readonly own: readonly ProgramEntry[] }>;
  /** Whether any file of the installation is still there: its command resolving into it, its program or its directory. */
  remains(target: InstallationObservation): Promise<boolean>;
  /** Uncommitted changes in a git checkout the installer made, read without locking it; null when it is not one. */
  localChanges(target: InstallationObservation, context: ManagementInstallContext): Promise<number | null>;
  /** Runs the product's own commands that stop and unregister one service; resolves once the service manager no longer knows it. */
  stopService(target: InstallationObservation, service: { readonly label: string; readonly stop: readonly (readonly string[])[] }, context: ManagementInstallContext): Promise<void>;
  /** Removes the program through its channel and verifies that its files are gone; calls beginMutation before changing anything. */
  remove(target: InstallationObservation, context: NativeInstallContext): Promise<void>;
  /** Digests of the protected configuration, compared around the uninstall; contents never leave this call. */
  configuration(target: InstallationObservation): Promise<string>;
}
/**
 * What installing a missing product the official way would run, write and change (ADR-044), read once for the user's
 * confirmation. The script is downloaded here and the copy that ran is this one; npm installs this exact version.
 */
export interface InstallCheck {
  readonly harnessId: string;
  readonly checkedAt: string;
  /** Names this prepared install; a submission carrying another, or after `expiresAt`, is refused. */
  readonly fingerprint: string;
  readonly expiresAt: string;
  readonly method: "script" | "npm";
  /** The command as the product's page gives it. */
  readonly officialCommand: string;
  readonly docs: string;
  /** The script's final URL after its recorded redirects, or `package@version`. */
  readonly source: string;
  readonly sha256: string | null;
  /** What HarnessHub runs, as text, with ~ for the home directory. */
  readonly runs: string;
  /** Where it may write, with ~; everything else is denied. */
  readonly writes: readonly string[];
  /** The shell startup file the installer may change (with ~), or null when it changes none. */
  readonly shellProfile: string | null;
  /** Product configuration files the installer may change (with ~); only their changed keys are recorded. */
  readonly configFiles: readonly string[];
  /** The exact npm version; null for a script, which installs its own latest. */
  readonly version: string | null;
  /** The npm prefix it installs into: the first Node.js on this Gateway's PATH. */
  readonly prefix: { readonly label: string; readonly path: string } | null;
  /** The release's Node.js range against that prefix's Node.js; an unmet one blocks the install. */
  readonly runtime: RuntimeRequirement | null;
  /** Which program the terminal's command runs afterwards (by this Gateway's PATH, which the login shell gives). */
  readonly terminal: { readonly command: string; readonly before: string | null; readonly after: "this" | "unchanged" | "not-on-path" };
  readonly notes: readonly string[];
  /** Why it cannot be installed now; null when it can. */
  readonly blocked: string | null;
}
/** The host side of an official install (ADR-044); replaced in tests that must not touch the user's home or the network. */
export interface OfficialInstallPort {
  /**
   * Prepares an install without changing the user's programs: downloads the script into `directory` (HTTPS, recorded
   * hosts only, bounded) or resolves the exact npm release and the prefix's Node.js. Rejects when the method cannot run.
   */
  prepare(harnessId: string, directory: string, context: ManagementInstallContext): Promise<PreparedInstall>;
  /** Runs the prepared install with writes confined to what it declares; resolves with what it changed besides the program. */
  run(prepared: PreparedInstall, context: NativeInstallContext): Promise<{ readonly exitCode: number; readonly facts: Omit<OfficialInstallFacts, "installed"> }>;
  /** The installed command and its version, when the product is now in its official channel; null when it is not. */
  verify(prepared: PreparedInstall, context: ManagementInstallContext): Promise<{ readonly entry: string; readonly version: string | null } | null>;
}
/** A prepared official install, frozen with its job; private paths stay on the Gateway. */
export interface PreparedInstall {
  readonly harnessId: string;
  readonly method: "script" | "npm";
  readonly source: string;
  readonly sha256: string | null;
  /** The script copy, inside the job's private directory once submitted. */
  readonly script: string | null;
  readonly interpreter: "bash" | "sh" | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly writes: readonly string[];
  readonly shellProfile: string | null;
  readonly configFiles: readonly string[];
  readonly package: string | null;
  readonly version: string | null;
  readonly prefix: string | null;
  readonly npm: string | null;
  /** Where the command lands, absolute. */
  readonly entry: string;
  readonly command: string;
  readonly runtime: RuntimeRequirement | null;
}
/** The latest version one installation's channel knows, read by an update check (ADR-044); kept in memory. */
export interface InstallationUpdate {
  readonly ref: string;
  readonly latest: string | null;
  /** `homebrew-local`: from Homebrew's local records, as current as its last `brew update`. */
  readonly source: "npm" | "homebrew-local";
  readonly checkedAt: string;
  readonly error: string | null;
}
/** What upgrading one installation through its channel would run and change, read once for the user's confirmation (ADR-044). */
export interface InstallationUpgradeCheck {
  readonly harnessId: string;
  readonly ref: string;
  readonly checkedAt: string;
  /** The installation and the prepared upgrade this check describes; a submission for another one, or after `expiresAt`, is refused. */
  readonly fingerprint: string;
  readonly expiresAt: string;
  readonly label: string;
  readonly role: "product" | "adapter";
  readonly channel: MaintainedChannel;
  /** `terminal`: HarnessHub only shows the product's own command (`terminal`); such a check cannot be confirmed. */
  readonly kind: UpgradeKind | "terminal";
  readonly current: string | null;
  /** The exact version a versioned upgrade installs; null when the product's own updater or official script picks it. */
  readonly target: string | null;
  readonly prerelease: boolean;
  /** What HarnessHub runs, with ~ for the home directory. */
  readonly runs: string;
  readonly writes: readonly string[];
  /** The official script's final URL and SHA-256, for an upgrade that reruns it. */
  readonly script: { readonly source: string; readonly sha256: string } | null;
  readonly shellProfile: string | null;
  readonly configFiles: readonly string[];
  /** Other formulae Homebrew would upgrade with it (its dry run); `sharedRuntimes` are those other programs run on, such as node. */
  readonly dependencies: readonly string[];
  readonly sharedRuntimes: readonly string[];
  readonly runtime: RuntimeRequirement | null;
  readonly active: boolean;
  /** HarnessHub conversations using it: busy ones block, idle kept processes close first. */
  readonly conversations: readonly { readonly sessionId: string; readonly busy: boolean }[];
  readonly otherUsers: readonly { readonly pid: number }[];
  /** Other programs running it: not stopped; they keep the old version until restarted. */
  readonly processes: readonly ProgramEntry[];
  /** The command to run in a terminal, what it does, and the uncommitted changes of the checkout it updates (null: not a checkout). */
  readonly terminal: { readonly command: string; readonly explains: string; readonly localChanges: number | null } | null;
  readonly notes: readonly string[];
  readonly blocked: string | null;
}
/** The host side of an installation upgrade (ADR-044); replaced in tests that must not touch the user's programs or the network. */
export interface InstallationUpgradePort {
  /**
   * How an installation upgrades through its channel: an exact newer version (npm, Homebrew), the product's own updater,
   * its official script run again, or a command only shown for the terminal; null when HarnessHub does not upgrade it.
   */
  kind(target: InstallationObservation): UpgradeKind | "terminal" | null;
  /** The latest version the channel knows: the npm registry's, or Homebrew's local records; null for channels that update themselves. */
  latest(target: InstallationObservation, context: ManagementInstallContext): Promise<{ readonly version: string; readonly source: InstallationUpdate["source"] } | null>;
  /**
   * Prepares the upgrade without changing any installed program: the exact release, Homebrew's dry run (which may write
   * its cache and is refused when it changed an installed package), or the downloaded official script in `directory`.
   */
  prepare(target: InstallationTarget, directory: string, context: ManagementInstallContext): Promise<PreparedUpgradeCheck>;
  /**
   * Runs the prepared upgrade confined to what it declares and resolves with what it changed besides the program; a
   * non-zero exit is a result. Homebrew's plan is read again first and must be the one confirmed. Calls beginMutation
   * before changing anything.
   */
  run(prepared: PreparedUpgrade, context: NativeInstallContext): Promise<{ readonly exitCode: number; readonly facts: Pick<InstallationUpgradeFacts, "shellChanges" | "configChanges" | "blocked"> }>;
  /**
   * The installation's version as the Harness list shows it: the one its channel records, or for a script without one
   * what its program reports in a write-protected run without network; null when neither can be read.
   */
  version(target: InstallationObservation, context: ManagementInstallContext): Promise<string | null>;
}
/** A prepared installation upgrade and what its confirmation shows besides it. */
export interface PreparedUpgradeCheck {
  readonly prepared: PreparedUpgrade;
  /** Packages of Homebrew's plan it marks deprecated or disabled. */
  readonly deprecated: readonly string[];
  /** When Homebrew's local records were last updated; null for other channels or when it has none. */
  readonly records: string | null;
}
/** A prepared installation upgrade, frozen with its job. */
export interface PreparedUpgrade {
  readonly target: InstallationTarget;
  readonly kind: UpgradeKind;
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly writes: readonly string[];
  readonly shellProfile: string | null;
  readonly configFiles: readonly string[];
  readonly version: string | null;
  readonly dependencies: readonly string[];
  readonly script: { readonly path: string; readonly source: string; readonly sha256: string; readonly interpreter: "bash" | "sh" } | null;
  readonly runtime: RuntimeRequirement | null;
}
/** What uninstalling one installation would remove, stop and leave, read once for the user's confirmation (ADR-044). */
export interface UninstallCheck {
  readonly harnessId: string;
  readonly ref: string;
  readonly checkedAt: string;
  /** The installation this check describes; an uninstall submitted for another one is refused. */
  readonly fingerprint: string;
  readonly channel: MaintainedChannel;
  readonly label: string;
  readonly role: "product" | "adapter";
  readonly version: string | null;
  readonly active: boolean;
  /** The commands HarnessHub runs, as text; paths under the home directory are written with ~. */
  readonly commands: readonly string[];
  /** The files and directories removed, with ~; for a package manager, the package directory it removes. */
  readonly removes: readonly string[];
  /** Paths the installer's layout names that are not what it writes (a launcher the user replaced): kept, with why. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** Whether the product's page gives this removal; false when it follows the installer's layout. */
  readonly documented: boolean;
  /** The product's data kept, with ~: configuration, sign-in and sessions. */
  readonly kept: readonly string[];
  /** Declared services running from it: stopped and unregistered with the product's own commands first. */
  readonly services: readonly { readonly label: string; readonly name: string; readonly pid: number; readonly commands: readonly string[]; readonly interrupts: string }[];
  /** Running services no product declares: they block, since HarnessHub cannot stop them the product's way. */
  readonly undeclaredServices: readonly { readonly label: string; readonly pid: number }[];
  /** The product's resident programs running outside a service manager: they block until stopped. */
  readonly resident: readonly ProgramEntry[];
  /** Other programs running it, such as terminal sessions: not stopped; they may fail once it is removed. */
  readonly processes: readonly ProgramEntry[];
  /** HarnessHub conversations using it (only for the installation this Gateway runs): busy ones block, idle kept processes close first. */
  readonly conversations: readonly { readonly sessionId: string; readonly busy: boolean }[];
  /** Other HarnessHub processes using this Harness; they block. */
  readonly otherUsers: readonly { readonly pid: number }[];
  /** Uncommitted changes in a checkout the installer made (Hermes); null when it is not one. */
  readonly localChanges: number | null;
  /** Which installation of its role this Gateway uses afterwards: another one, none (the Harness shows as not installed), or the same as before. */
  readonly after: { readonly kind: "next"; readonly label: string; readonly version: string | null } | { readonly kind: "none" } | { readonly kind: "unchanged" };
}
export interface ResolvedManagedControl {
  readonly installationId: string;
  readonly revision: number;
  readonly version: string;
  readonly command: ResolvedCommand;
}
export interface ManagementJobInput {
  readonly harnessId: string;
  readonly controlId?: string;
  readonly action: "install" | "upgrade" | "uninstall";
  /** The installation an uninstall removes, by the reference the Harness list gives it. */
  readonly installation?: string;
  /** The fingerprint of the uninstall check the user confirmed. */
  readonly expectedInstallationFingerprint?: string;
  /** The service labels the user agreed to have stopped and unregistered by an uninstall. */
  readonly stopServices?: readonly string[];
  /** The fingerprint of the official install check the user confirmed (ADR-044); marks an official install. */
  readonly expectedInstallFingerprint?: string;
  readonly commandId: string;
  readonly expectedDefaultRevision?: number;
  readonly expectedNativeFingerprint?: string;
  /** The service labels the user agreed to have restarted (ADR-043); an upgrade finding another one to restart stops before changing anything. */
  readonly restartServices?: readonly string[];
  /** That the user ran the product's own backup before a sequenced upgrade (ADR-052); only such an upgrade takes it, and it is refused without it. */
  readonly backupConfirmed?: true;
}
export interface ManagementRecipe {
  readonly harnessId: string;
  readonly controlId: string;
  readonly kind: "npm" | "python" | "binary";
  readonly packageName: string | null;
  readonly referenceVersion: string;
  readonly binName: string;
  readonly args: readonly string[];
  readonly archiveUrl: string | null;
  readonly archiveSha256: string | null;
  readonly relativeExecutable: string | null;
  readonly dependencies: readonly { readonly packageName: string; readonly binName: string }[];
  readonly upstreamId?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Background services of the product's default installation (ADR-043). */
  readonly services?: readonly RecipeService[];
  /** Names the product's resident programs give themselves when they run outside a service manager. */
  readonly processNames?: readonly string[];
  /** Where the product keeps its plugins, relative to the user's home; only directory names are read. */
  readonly pluginDirectory?: string;
  /** Product facts shown before an upgrade: what HarnessHub does not run, and how the user does it. */
  readonly upgradeNotes?: readonly string[];
  /** The product's documented upgrade sequence HarnessHub drives for its npm installation (ADR-052), instead of installing the package alone. */
  readonly upgradeSequence?: UpgradeSequenceRecipe;
}
/**
 * A product's documented upgrade sequence (ADR-052): its gateway service is stopped with the product's command, each hop
 * installs the npm release with the product's lifecycle scripts allowed and runs its Doctor, the gateway is started after
 * the last hop, and the services named are restarted with the product's own commands. Arguments are the product command's;
 * its installed entry runs them. Declared by the recipe so that the Gateway branches on no product (ADR-043 决定 9).
 */
export interface UpgradeSequenceRecipe {
  /** Installations older than `before` go through `version` first: upstream's migration bridge, not a version gate. */
  readonly bridge: { readonly before: string; readonly version: string };
  /** npm flags the product's install documents, such as `--allow-scripts=openclaw`. */
  readonly npmFlags: readonly string[];
  /** The gateway service by the label declared in `services`, and the product's arguments that stop, start and report it. */
  readonly gateway: { readonly label: string; readonly stop: readonly string[]; readonly start: readonly string[]; readonly status: readonly string[] };
  /** The product's Doctor, run after each hop's install; it may rewrite `migrates`. */
  readonly doctor: readonly string[];
  /** Services restarted with the product's own arguments once the gateway recovered, when they ran before the upgrade. */
  readonly restarts: readonly { readonly label: string; readonly args: readonly string[] }[];
  /** The product's backup command the user runs before confirming, as shown. */
  readonly backupCommand: string;
  /** Configuration files, relative to the home, the Doctor rewrites; `migrationBackups` says how it keeps the previous copies. */
  readonly migrates: readonly string[];
  readonly migrationBackups: string;
  /** How the user returns to the previous version: only from the backup. */
  readonly rollback: string;
}
export interface ResolvedInstallSpec {
  readonly recipe: ManagementRecipe;
  readonly version: string;
  readonly artifactUrl: string | null;
  readonly integrity: string | null;
  readonly engines: Readonly<Record<string, string>>;
  readonly binNames?: readonly string[];
  readonly dependencies: readonly { readonly packageName: string; readonly version: string; readonly binName: string }[];
}
export interface ManagementMetadataPort {
  resolve(recipe: ManagementRecipe, signal: AbortSignal, exactVersion?: string): Promise<ResolvedInstallSpec>;
}
export interface ManagementInstallContext {
  readonly stage: string;
  readonly signal: AbortSignal;
  readonly log: (stream: InstallationLog["stream"], text: string) => void;
  readonly assertOwned: () => void;
}
export interface InstalledManagementArtifact {
  readonly command: ResolvedCommand;
  readonly observedVersion: string;
  readonly artifactSha256: string | null;
}
/** Only the external package/archive work is replaceable. SQLite, fencing, activation and API remain real. */
export interface ManagementInstallerPort {
  install(spec: ResolvedInstallSpec, context: ManagementInstallContext): Promise<InstalledManagementArtifact>;
}
export interface SystemInstallationObservation {
  readonly harnessId: string;
  readonly controlId: string;
  readonly command: ResolvedCommand;
  readonly packageVersion?: string;
  /** The product's own command when the control entry is an adapter in front of it (Claude Code behind claude-agent-acp). */
  readonly program?: ResolvedCommand;
}
export interface SystemVersionProbeOptions {
  readonly signal: AbortSignal;
  readonly assertOwned: () => void;
  readonly redact?: (text: string) => string;
}
