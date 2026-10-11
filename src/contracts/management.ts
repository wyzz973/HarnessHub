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
  readonly native?: { readonly channel: string; readonly location: string; readonly beforeVersion: string | null; readonly actualVersion: string | null; readonly dispatched: boolean; readonly configurationPreserved: boolean | null };
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
  execute(plan: NativeInstallPlan, recipe: ManagementRecipe, version: string, context: NativeInstallContext): Promise<{ readonly version: string; readonly configurationPreserved: boolean }>;
  inspect(plan: NativeInstallPlan, context: ManagementInstallContext): Promise<string>;
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
