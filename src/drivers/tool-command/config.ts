import path from "node:path";

/**
 * Same literal as tool-packages SESSION_WORKSPACE_PLACEHOLDER (drivers cannot
 * import tool-packages). The Worker replaces it in MCP arguments before this
 * process starts; seeing it here means no substitution happened.
 */
export const SESSION_WORKSPACE_PLACEHOLDER = "${HARNESSHUB_SESSION_WORKSPACE}";
export const MAX_ARG = 4096;

export interface CommandTool {
  name: string;
  description?: string;
  command: string;
  /** Fixed argv prepended to model-supplied arguments, workspace anchors resolved. */
  prefixArgs: string[];
}
export interface CommandConfiguration {
  /** Absolute Session directory used as every tool's working directory. */
  workspace: string;
  tools: CommandTool[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(message);
}

/**
 * The working directory comes from `--workspace <dir>` (current bindings, where
 * the Worker substituted the Session directory) or, for revisions bound before
 * ADR 0013, from HHCAP_CLI_WORKSPACE. An unsubstituted placeholder or relative
 * path fails instead of falling back to the inherited process directory.
 */
function workspace(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let value: string | undefined;
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== "--workspace")
      fail("Managed CLI MCP accepts only --workspace <directory>");
    value = argv[1];
  } else value = environment.HHCAP_CLI_WORKSPACE;
  if (value?.includes(SESSION_WORKSPACE_PLACEHOLDER))
    fail(
      "The Session workspace placeholder was not substituted; this Worker cannot run Tool Pack CLI tools",
    );
  if (!value || !path.isAbsolute(value))
    fail("Managed CLI MCP requires an absolute Session workspace");
  return value;
}

/** Parses and bounds the whole managed CLI declaration before any tool can run. */
export function parseCommandConfiguration(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): CommandConfiguration {
  const root = workspace(argv, environment);
  const raw = environment.HHCAP_CLI_TOOLS_JSON;
  if (!raw) fail("Managed CLI MCP configuration is missing");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail("Managed CLI MCP configuration is invalid JSON");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    fail("Managed CLI MCP must contain 1-16 tools");
  const tools = value.map((item): CommandTool => {
    if (!object(item)) fail("Invalid managed CLI tool");
    const { name, description, command, prefixArgs } = item;
    if (
      typeof name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/.test(name) ||
      typeof command !== "string" ||
      !path.isAbsolute(command) ||
      !Array.isArray(prefixArgs) ||
      prefixArgs.length > 128 ||
      (description !== undefined &&
        (typeof description !== "string" || description.length > 512))
    )
      fail("Invalid managed CLI tool declaration");
    const resolved = prefixArgs.map((arg: unknown) => {
      if (object(arg)) {
        if (
          Object.keys(arg).join(",") !== "anchor" ||
          arg.anchor !== "workspace"
        )
          fail("Invalid managed CLI tool declaration");
        return root;
      }
      if (
        typeof arg !== "string" ||
        arg.length === 0 ||
        arg.length > MAX_ARG ||
        arg.includes("\0")
      )
        fail("Invalid managed CLI tool declaration");
      return arg;
    });
    return {
      name,
      command,
      prefixArgs: resolved,
      ...(typeof description === "string" ? { description } : {}),
    };
  });
  if (
    new Set(tools.map((tool) => tool.name.toLowerCase())).size !== tools.length
  )
    fail("Managed CLI tool names must be unique");
  return { workspace: root, tools };
}
