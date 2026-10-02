// SPDX-License-Identifier: MIT
import { COMMAND_MCP_ENTRY } from "@harnesshub/agents/tool-command/entry";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError } from "@harnesshub/core/errors";
import { prepareEngine } from "@harnesshub/agents/engine/registry";
import { runToolPackageCli } from "@harnesshub/agents/tool-packages/index";

/** Standalone composition; publishing wrappers can inject their own root into runToolPackageCli. */
export async function toolPackagesMain(argv: string[]): Promise<unknown> {
  const [flag, root, ...command] = argv;
  if (flag !== "--root" || !root || !path.isAbsolute(root))
    throw new HubError(
      "INVALID_TOOL_PACKAGE_ARGUMENT",
      "Usage: node dist/src/tool-packages-main.js --root <absolute store directory> <package command>",
    );
  return runToolPackageCli(command, {
    root,
    nodeExecutable: process.execPath,
    commandMcpEntry: COMMAND_MCP_ENTRY,
    prepareEngine,
  });
}

/**
 * Command-line entry of `tools` (`node dist/src/tool-packages-main.js` and
 * `hh tools`): prints the result as JSON on stdout, or the error code and
 * message as JSON on stderr.
 *
 * @param argv The command-line arguments after the command itself.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    console.log(JSON.stringify(await toolPackagesMain(argv), null, 2));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code:
            error instanceof HubError ? error.code : "TOOL_PACKAGE_IO_ERROR",
          message:
            error instanceof Error ? error.message : "Package operation failed",
        },
      }),
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
