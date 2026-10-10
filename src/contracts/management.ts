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
  readonly latestVersion: string | null;
  readonly updateStatus: "unchecked" | "checking" | "available" | "current" | "failed" | "unsupported";
  readonly checkedAt: string | null;
  readonly activeJobId: string | null;
  readonly installationId: string | null;
  readonly defaultRevision: number;
  readonly error: { readonly code: string; readonly message: string } | null;
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
  readonly action: "install" | "upgrade";
  readonly commandId: string;
  readonly expectedDefaultRevision?: number;
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
  readonly dependencies: readonly { readonly packageName: string; readonly version: string; readonly binName: string }[];
}
export interface ManagementMetadataPort {
  resolve(recipe: ManagementRecipe, signal: AbortSignal): Promise<ResolvedInstallSpec>;
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
}
export interface SystemVersionProbeOptions {
  readonly signal: AbortSignal;
  readonly assertOwned: () => void;
  readonly redact?: (text: string) => string;
}
