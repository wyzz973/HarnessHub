// SPDX-License-Identifier: MIT
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryPath } from "../repository.js";

/**
 * Absolute path of the compiled command MCP server, which `node` starts with
 * the managed CLI tools of a bound Tool Pack (ADR 0013). The composition roots
 * pass it to Tool Pack management as `commandMcpEntry`; binding stores it in
 * the engine revision's MCP arguments.
 */
export const COMMAND_MCP_ENTRY = fileURLToPath(
  new URL("./command-mcp.js", import.meta.url),
);

/**
 * Where the command MCP entry was compiled before OSS-004 step 7,
 * `dist/src/drivers/tool-command/command-mcp.js` of this checkout. Engine
 * revisions created by binding a Tool Pack before the move store this path in
 * SQLite; configuration preparation maps it to COMMAND_MCP_ENTRY. To be removed
 * in M1, when the Library replaces Tool Pack bindings (13-package-migration,
 * decision 1).
 */
export const LEGACY_COMMAND_MCP_ENTRY = repositoryPath(
  "dist/src/drivers/tool-command/command-mcp.js",
);

/**
 * COMMAND_MCP_ENTRY for an argument that names LEGACY_COMMAND_MCP_ENTRY, the
 * argument itself otherwise. Paths compare after resolution, and without regard
 * to case on Windows.
 */
export function currentCommandMcpEntry(argument: string): string {
  if (!path.isAbsolute(argument)) return argument;
  const resolved = path.resolve(argument);
  const same =
    process.platform === "win32"
      ? resolved.toLowerCase() === LEGACY_COMMAND_MCP_ENTRY.toLowerCase()
      : resolved === LEGACY_COMMAND_MCP_ENTRY;
  return same ? COMMAND_MCP_ENTRY : argument;
}
