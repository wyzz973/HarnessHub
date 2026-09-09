import type {
  EngineConfiguration,
  SecretReference,
} from "../domain/engine-configuration.js";

export interface ToolPackageFile {
  path: string;
  size: number;
  sha256: string;
  executable?: boolean;
}
export type ToolPackageArgument =
  string | { anchor: "package"; path: string } | { anchor: "workspace" };
export interface ToolPackageMcp {
  name: string;
  launch: "node" | "native";
  entry: string;
  args?: ToolPackageArgument[];
  env?: Record<string, string>;
  /** Maps destination environment variables to explicit local binding slot names. */
  secretEnv?: Record<string, string>;
}
export interface ToolPackageCli {
  /** Stable tool name exposed through the managed command MCP server. */
  name: string;
  description?: string;
  launch: "node" | "native";
  entry: string;
  /** Fixed arguments prepended before model-supplied argv. */
  args?: ToolPackageArgument[];
}
export interface ToolPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: string;
  files: ToolPackageFile[];
  skills?: { path: string }[];
  mcpServers?: ToolPackageMcp[];
  /** CLI programs are exposed as allow-listed MCP tools; no shell command is accepted. */
  cliTools?: ToolPackageCli[];
}
export interface ToolPackageInspection {
  manifest: ToolPackageManifest;
  /** SHA-256 of the canonical manifest; payload hashes are included in that manifest. */
  digest: string;
  fileCount: number;
  totalBytes: number;
}
export interface ToolPackageRecord {
  schemaVersion: 1;
  id: string;
  version: string;
  digest: string;
  installedAt: number;
  status: "installed" | "removed";
}
export interface InstalledToolPackage extends ToolPackageInspection {
  record: ToolPackageRecord;
}
export interface ToolPackageBinding {
  /** Absolute executable from the caller's bundled runtime; never resolved through PATH. */
  nodeExecutable: string;
  /** Compiled HarnessHub command MCP entry. Required only when cliTools are declared. */
  commandMcpEntry?: string;
  workspace: string;
  secretBindings?: Record<string, SecretReference>;
}
/** A binding remains directly spreadable into EngineConfiguration for backward compatibility. */
export type ToolPackageConfiguration = Required<
  Pick<EngineConfiguration, "skills" | "mcpServers">
>;
