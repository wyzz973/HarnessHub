import type { ControlProtocol } from "./discovery.js";

export const MAX_DEFINITIONS = 128;
export const MAX_CONTROLS = 256;
export const MAX_CATALOG_BYTES = 256 * 1024;

export interface CatalogSource {
  readonly repository: string;
  readonly revision: string;
  readonly upstreamId: string;
  readonly url: string;
}
export interface PackageIdentity {
  readonly kind: "npm" | "python";
  readonly name: string;
  readonly version: string;
  readonly binNames: readonly string[];
}
export interface DistributionMetadata {
  readonly kind: "binary" | "npm" | "python";
  readonly packageSpec?: string;
  readonly archive?: string;
  readonly relativeExecutable?: string;
  readonly sha256?: string;
}
export interface ControlRecipe {
  readonly id: string;
  readonly protocol: ControlProtocol;
  readonly executableNames: readonly string[];
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly package: PackageIdentity | null;
  readonly distribution: DistributionMetadata | null;
  readonly requiredExecutables: readonly string[];
  readonly source: CatalogSource;
}
export interface HarnessDefinition {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly binaryNames: readonly string[];
  /** Home-relative known paths; only their existence is observed. */
  readonly configHints: readonly string[];
  readonly controls: readonly ControlRecipe[];
}
export interface ControlOverride { readonly executable: string }
export interface CatalogManifest {
  readonly version: 2;
  readonly definitions: readonly HarnessDefinition[];
  readonly overrides: ReadonlyMap<string, ControlOverride>;
  readonly installationOverrides: ReadonlyMap<string, string>;
}
export type InstallationSource = "override" | "path" | "configured-directory" | "known-directory" | "manager-directory" | "local-package";
export interface InstallationEntry {
  readonly path: string;
  readonly source: InstallationSource;
  readonly name: string;
}
export interface InstallationCandidate {
  readonly path: string;
  readonly resolvedPath: string;
  readonly source: InstallationSource;
  readonly entries: readonly InstallationEntry[];
}
export interface InventoryDiagnostic {
  readonly code: "not_found" | "not_file" | "not_executable" | "inaccessible" | "relative_path_ignored" | "scan_truncated" | "package_invalid" | "runtime_missing" | "package_version_observed";
  readonly path: string;
  readonly detail?: string;
}
export interface InstallationEnumeration {
  readonly candidates: readonly InstallationCandidate[];
  readonly selected: InstallationCandidate | null;
  readonly defaultResolution: "none" | "located" | "blocked";
  readonly diagnostics: readonly InventoryDiagnostic[];
}
/** Read-only enumeration. It must never execute candidates or package runners. */
export interface InstallationEnumerator {
  validateOverride(path: string): void;
  enumerate(names: readonly string[], override?: string): Promise<InstallationEnumeration>;
}
export interface ResolvedCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface LocalPackageObservation {
  readonly command: ResolvedCommand | null;
  readonly diagnostics: readonly InventoryDiagnostic[];
  readonly packageVersion?: string;
}
export interface LocalPackageResolver {
  resolve(identity: PackageIdentity): Promise<LocalPackageObservation>;
}
export interface ConfigurationEvidence { readonly path: string; readonly state: "configured" }
export interface ConfigurationLocator {
  observe(hints: readonly string[]): Promise<readonly ConfigurationEvidence[]>;
}
export interface ControlObservation {
  readonly id: string;
  readonly protocol: ControlProtocol;
  readonly source: CatalogSource;
  readonly state: "candidate" | "missing_dependency" | "blocked";
  readonly command: ResolvedCommand | null;
  readonly installation: InstallationEnumeration;
  readonly missingDependencies: readonly string[];
  readonly diagnostics: readonly InventoryDiagnostic[];
  readonly probe: "not_run";
}
export interface HarnessInventory {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly installation: InstallationEnumeration;
  readonly configuration: readonly ConfigurationEvidence[];
  readonly controls: readonly ControlObservation[];
}
export interface InventoryReport {
  readonly schemaVersion: 2;
  readonly observedAt: string;
  readonly protocolProbesRun: 0;
  readonly harnesses: readonly HarnessInventory[];
}
