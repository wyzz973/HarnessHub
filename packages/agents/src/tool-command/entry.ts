// SPDX-License-Identifier: MIT
import { namesCheckoutFile } from "../assets.js";

/**
 * Where earlier versions compiled the command MCP entry, relative to the
 * checkout: before OSS-004 step 7, then in this package until OSS-010 F08 moved
 * the entry into the daemon (the daemon's `COMMAND_MCP_ENTRY`), which can
 * inject a process launcher. Engine revisions created by binding a Tool Pack
 * store the entry's absolute path in SQLite; configuration preparation
 * replaces a former one with the current entry it is given. To be removed in
 * M1, when the Library replaces Tool Pack bindings (13-package-migration,
 * decision 1).
 */
const FORMER_COMMAND_MCP_ENTRIES = [
  "dist/src/drivers/tool-command/command-mcp.js",
  "packages/agents/dist/src/tool-command/command-mcp.js",
];

/**
 * Whether an MCP argument names a former command MCP entry of this checkout
 * (namesCheckoutFile). Paths compare after resolution, and without regard to
 * case on Windows.
 */
export function isFormerCommandMcpEntry(argument: string): boolean {
  return FORMER_COMMAND_MCP_ENTRIES.some((entry) =>
    namesCheckoutFile(argument, entry),
  );
}
