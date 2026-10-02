// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";

/**
 * Absolute path of the compiled command MCP entry, which `node` starts with
 * the managed CLI tools of a bound Tool Pack (ADR 0013). The composition roots
 * pass it to Tool Pack management as `commandMcpEntry`, where binding stores it
 * in the engine revision's MCP arguments, and to configuration preparation,
 * which starts bindings that name a former entry from it.
 */
export const COMMAND_MCP_ENTRY = fileURLToPath(
  new URL("./command-mcp-main.js", import.meta.url),
);
