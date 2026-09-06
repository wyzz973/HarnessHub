import type { EngineConfiguration } from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";

/** Build-time templates contain only bundle/state anchors, never developer paths or credentials. */
export interface BundledEngine {
  id: string;
  name: string;
  version: string;
  driver: "acp" | "cli";
  command: string[];
  env?: Record<string, string>;
  configuration?: EngineConfiguration;
  cli?: EngineRegistration["cli"];
  acp?: EngineRegistration["acp"];
  credentialEnv?: string[];
  requiredFiles?: string[];
  notes?: string[];
}

/** Immutable payload inventory. Mutable judge settings, task workspaces and evidence live under state/. */
export interface BundleManifest {
  schemaVersion: 1;
  platform: "win32";
  arch: "arm64" | "x64";
  nodeVersion: string;
  consoleEntry: string;
  engines: BundledEngine[];
  components: unknown[];
  files: { path: string; size: number; sha256: string }[];
}

export interface BundleModelProfile {
  model: string;
  provider: NonNullable<EngineConfiguration["provider"]>;
}
export interface BundleEngineSettings {
  enabled?: boolean;
  modelProfile?: string;
  model?: string;
  configuration?: EngineConfiguration;
  toolPackages?: { id: string; version: string }[];
}
export interface BundleSettings {
  schemaVersion: 1;
  defaultEngine?: string;
  modelProfiles?: Record<string, BundleModelProfile>;
  engines?: Record<string, BundleEngineSettings>;
}
export interface BundleContext {
  root: string;
  state: string;
  workspace: string;
  node: string;
}
