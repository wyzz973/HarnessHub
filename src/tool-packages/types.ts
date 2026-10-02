import type {
  EngineConfiguration,
  SecretReference,
} from "../domain/engine-configuration.js";

/**
 * Written into bindings wherever a value refers to the Session working directory
 * (workspace anchors, CLI working directory). The owning Worker replaces every
 * occurrence in stdio MCP arguments and environment values with the Session's
 * actual directory before any MCP process starts (ADR 0013). Bindings therefore
 * never pin an absolute workspace path.
 */
export const SESSION_WORKSPACE_PLACEHOLDER = "${HARNESSHUB_SESSION_WORKSPACE}";

export interface ToolPackageFile {
  path: string;
  size: number;
  sha256: string;
  executable?: boolean;
}
export type ToolPackageArgument =
  string | { anchor: "package"; path: string } | { anchor: "workspace" };
/** Local stdio server started from a package file. */
export interface ToolPackageStdioMcp {
  name: string;
  launch: "node" | "native";
  entry: string;
  args?: ToolPackageArgument[];
  env?: Record<string, string>;
  /** Maps destination environment variables to explicit local binding slot names. */
  secretEnv?: Record<string, string>;
}
/** Remote Streamable HTTP or SSE endpoint. The package stores only its declaration. */
export interface ToolPackageRemoteMcp {
  name: string;
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  /** Maps destination header names to explicit local binding slot names. */
  secretHeaders?: Record<string, string>;
}
export type ToolPackageMcp = ToolPackageStdioMcp | ToolPackageRemoteMcp;
export interface ToolPackageCli {
  /** Stable tool name exposed through the managed command MCP server. */
  name: string;
  description?: string;
  launch: "node" | "native";
  entry: string;
  /** Fixed arguments prepended before model-supplied argv. */
  args?: ToolPackageArgument[];
}
/** Environment-variable location used when a caller supplies no binding for a slot. */
export interface ToolPackageDefaultSecretBinding {
  kind: "env";
  value: string;
}
export interface ToolPackageManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: string;
  /** May be empty only when the package declares remote MCP endpoints alone. */
  files: ToolPackageFile[];
  skills?: { path: string }[];
  mcpServers?: ToolPackageMcp[];
  /** CLI programs are exposed as allow-listed MCP tools; no shell command is accepted. */
  cliTools?: ToolPackageCli[];
  /**
   * Optional default references for secret slots. Only environment-variable
   * names are allowed: they locate a value on the running machine and are not
   * credentials themselves. Explicit binding input always takes precedence.
   */
  defaultSecretBindings?: Record<string, ToolPackageDefaultSecretBinding>;
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
  /**
   * @deprecated Ignored since ADR 0013: workspace-bound values are written as
   * {@link SESSION_WORKSPACE_PLACEHOLDER}. Accepted only so existing callers
   * compile; it is neither read nor validated.
   */
  workspace?: string;
  secretBindings?: Record<string, SecretReference>;
}
/** A binding remains directly spreadable into EngineConfiguration for backward compatibility. */
export type ToolPackageConfiguration = Required<
  Pick<EngineConfiguration, "skills" | "mcpServers">
>;
/** Capability names added by one package, as reported by apply/import/unbind results. */
export interface ToolPackageCapabilities {
  /** Absolute SKILL.md paths inside the installed content object. */
  skills: string[];
  /** Engine-level MCP server names, including the managed `<id>-cli` server. */
  mcp: string[];
  /** Tool names exposed by the managed command MCP server (`cli_<name>`). */
  cli: string[];
}
