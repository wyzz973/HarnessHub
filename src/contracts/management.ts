import type { ResolvedCommand } from "../contexts/catalog/domain/catalog.js";

export class ManagementError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ManagementError"; }
}
export type InstallationJobStatus = "queued" | "resolving" | "installing" | "verifying" | "activating" | "completed" | "cancelled" | "failed" | "unknown";
export interface InstallationJobView {
  readonly id: string;
  readonly harnessId: string;
  readonly controlId: string;
  readonly action: "install" | "upgrade";
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
  readonly referenceVersion: string | null;
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
  /** Whether this is a version HarnessHub verified with the real program (ADR-038); absent when that is not known. A hint only. */
  readonly verification?: HarnessVersionVerification;
}
/** The verified versions as text (one version, or a range) and whether the installed ones are among them. */
export interface HarnessVersionVerification {
  readonly state: "verified" | "unverified";
  readonly program: string;
  /** The adapter entry's verified version, for a Harness reached through an adapter. */
  readonly adapter?: string;
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
   * Every check of this exact version that changes nothing: newer than the installed one, its release metadata, and the
   * product's own compatibility check with the user's configuration. Fails with the reason the upgrade cannot run.
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
  /** The runtime this exact version requires against the one that runs the program (ADR-043); null when it declares none. Changes nothing. */
  requirements(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: ManagementInstallContext): Promise<RuntimeRequirement | null>;
  inspect(plan: NativeInstallPlan, context: ManagementInstallContext): Promise<string>;
}
/** A running service-manager job whose program is this installation, with the recipe's facts when it declares the job. */
export interface UsedService {
  readonly label: string;
  readonly pid: number;
  /** The domain target the service manager knows it by (launchd `gui/<uid>/<label>`). */
  readonly target: string;
  /** The TCP port its arguments give for the recipe's `portFlag`; null when it declares none or the arguments carry none. */
  readonly port: number | null;
  readonly declared: RecipeService | null;
}
/** A running program by process id and base name only; arguments are never kept. */
export interface ProgramEntry { readonly pid: number; readonly name: string }
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
/** A runtime a release requires, and the one that runs the installed program: its `#!` interpreter on the user's PATH. */
export interface RuntimeRequirement {
  readonly runtime: "Node.js";
  /** The release's `engines` range. */
  readonly required: string;
  /** The version the interpreter reports; null when it could not be read. */
  readonly found: string | null;
  readonly path: string;
  readonly satisfied: boolean;
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
  /** Whether HarnessHub verified its interface with the target version (ADR-038), and on which versions; null when unknown. */
  readonly target: HarnessVersionVerification | null;
  /** The target's runtime requirement against the runtime that runs the program; one not met blocks the upgrade. Null when none is declared or it could not be read. */
  readonly runtime: RuntimeRequirement | null;
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
export interface ResolvedManagedControl {
  readonly installationId: string;
  readonly revision: number;
  readonly version: string;
  readonly command: ResolvedCommand;
}
export interface ManagementJobInput {
  readonly harnessId: string;
  readonly controlId?: string;
  readonly action: "install" | "upgrade";
  readonly commandId: string;
  readonly expectedDefaultRevision?: number;
  readonly expectedNativeFingerprint?: string;
  /** The service labels the user agreed to have restarted (ADR-043); an upgrade finding another one to restart stops before changing anything. */
  readonly restartServices?: readonly string[];
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
