// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";
import { namesCheckoutFile } from "../assets.js";

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
 * Where the command MCP entry was compiled before OSS-004 step 7, relative to
 * the checkout. Engine revisions created by binding a Tool Pack before the move
 * store `<checkout>/dist/src/drivers/tool-command/command-mcp.js` in SQLite;
 * configuration preparation maps it to COMMAND_MCP_ENTRY. To be removed in M1,
 * when the Library replaces Tool Pack bindings (13-package-migration, decision
 * 1).
 */
const LEGACY_COMMAND_MCP_ENTRY = "dist/src/drivers/tool-command/command-mcp.js";

/**
 * COMMAND_MCP_ENTRY for an argument that names LEGACY_COMMAND_MCP_ENTRY of
 * this checkout (namesCheckoutFile), the argument itself otherwise. Paths
 * compare after resolution, and without regard to case on Windows.
 */
export function currentCommandMcpEntry(argument: string): string {
  return namesCheckoutFile(argument, LEGACY_COMMAND_MCP_ENTRY)
    ? COMMAND_MCP_ENTRY
    : argument;
}
