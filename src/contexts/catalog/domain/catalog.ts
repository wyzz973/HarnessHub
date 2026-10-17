import type { InstallationChannel, OfficialChannels } from "./channels.js";
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
export type InstallationSource = "override" | "path" | "configured-directory" | "known-directory" | "manager-directory" | "local-package" | "managed";
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
  readonly code: "not_found" | "not_file" | "not_executable" | "inaccessible" | "relative_path_ignored" | "scan_truncated" | "package_invalid" | "runtime_missing" | "package_version_observed" | "manifest_ignored";
  readonly path: string;
  readonly detail?: string;
}
export interface InstallationEnumeration {
  readonly candidates: readonly InstallationCandidate[];
  readonly selected: InstallationCandidate | null;
  readonly defaultResolution: "none" | "located" | "blocked";
  readonly diagnostics: readonly InventoryDiagnostic[];
}
/**
 * What a Gateway counts as an installation (ADR-044): `official` admits only programs in a channel their product's official
 * documentation describes and does not read a discovery manifest; `any` admits every entry found (development and tests).
 */
export type InstallationPolicy = "official" | "any";
/** The policy an entry runs with: `any` only when development explicitly allows unofficial entries, `official` otherwise. */
export function resolveInstallationPolicy(allowUnofficial: boolean | undefined): InstallationPolicy { return allowUnofficial === true ? "any" : "official"; }
/** A found program with the official channel it lies in. */
export interface ClassifiedCandidate extends InstallationCandidate {
  /** The official channel, or null outside every channel its product or adapter documents. */
  readonly channel: InstallationChannel | null;
  /** The version the channel records for this installation (package metadata, keg or versions directory), or null. */
  readonly version: string | null;
  /** Whether the program is the product itself or an adapter HarnessHub runs in front of it. */
  readonly role: "product" | "adapter";
}
/** An enumeration after the installation policy: under `official`, candidates outside every channel move to `unofficial`. */
export interface ObservedInstallations extends InstallationEnumeration {
  readonly candidates: readonly ClassifiedCandidate[];
  readonly selected: ClassifiedCandidate | null;
  /** Programs found outside every official channel and left out by the official policy; always empty under `any`. */
  readonly unofficial: readonly InstallationCandidate[];
  /** The one of `unofficial` that PATH resolves the command to (what a shell with this PATH runs), or null. */
  readonly unofficialDefault: InstallationCandidate | null;
}
/** Read-only classification of a found program into an official channel. It reads files and never runs the program. */
export interface InstallationClassifier {
  classify(candidate: InstallationCandidate, channels: OfficialChannels): Promise<{ readonly channel: InstallationChannel; readonly version: string | null } | null>;
}
/** The recorded official channels of products and of the adapters HarnessHub runs in front of them. */
export interface ChannelRegistry {
  /** A product's channels, or null when none are recorded. */
  product(harnessId: string): OfficialChannels | null;
  /** An adapter control's channels (the package or archive its registry entry publishes), or null when it publishes none. */
  adapter(harnessId: string, control: ControlRecipe): OfficialChannels | null;
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
  /**
   * Reads the installed package metadata behind an executable found on PATH or in a standard directory (an npm global bin,
   * a Python console script or its launcher) to observe the package's own version. It reads files only; nothing runs.
   * Returns diagnostics: `package_version_observed` when the metadata confirms the identity, otherwise nothing.
   */
  observe(identity: PackageIdentity, executable: string): Promise<readonly InventoryDiagnostic[]>;
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
  readonly installation: ObservedInstallations;
  readonly missingDependencies: readonly string[];
  readonly diagnostics: readonly InventoryDiagnostic[];
  readonly probe: "not_run";
}
export interface HarnessInventory {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly installation: ObservedInstallations;
  readonly configuration: readonly ConfigurationEvidence[];
  readonly controls: readonly ControlObservation[];
}
export interface InventoryReport {
  readonly schemaVersion: 2;
  readonly observedAt: string;
  readonly protocolProbesRun: 0;
  readonly harnesses: readonly HarnessInventory[];
}
