// SPDX-License-Identifier: MIT
/**
 * Process entry of the command MCP server (COMMAND_MCP_ENTRY): the engine
 * starts it with `node` for a bound Tool Pack's managed CLI tools. As the
 * composition root of its process it owns the process launcher that starts
 * the tools, and closes it when the server is stopped, so no tool outlives
 * the server. It runs when loaded, also as a role of the single executable.
 */
import { serveCommandMcp } from "@harnesshub/agents/tool-command/server";
import { sharedProcessLauncher } from "@harnesshub/runtime/process/launcher";

const launcher = sharedProcessLauncher();
serveCommandMcp(launcher, () => {
  void launcher.close();
});
