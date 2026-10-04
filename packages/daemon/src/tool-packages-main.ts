// SPDX-License-Identifier: MIT
import { COMMAND_MCP_ENTRY } from "./command-mcp-entry.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError } from "@harnesshub/core/errors";
import { prepareEngine } from "@harnesshub/agents/engine/registry";
import { runToolPackageCli } from "@harnesshub/agents/tool-packages/index";
import { sharedProcessLauncher } from "@harnesshub/runtime/process/launcher";
import { usePlatformLauncher } from "@harnesshub/store/platform/process-launcher";

const USAGE =
  "Usage: node dist/src/tool-packages-main.js --root <absolute store directory> <package command>";

/**
 * Standalone composition; publishing wrappers can inject their own root into
 * runToolPackageCli. Package storage on Windows starts the ACL helper through
 * this process's launcher, which `main` closes.
 */
export async function toolPackagesMain(argv: string[]): Promise<unknown> {
  usePlatformLauncher(sharedProcessLauncher());
  const [flag, root, ...command] = argv;
  if (flag !== "--root" || !root || !path.isAbsolute(root))
    throw new HubError("INVALID_TOOL_PACKAGE_ARGUMENT", USAGE);
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
 * message as JSON on stderr. `--help` alone prints the usage and exits 0.
 *
 * @param argv The command-line arguments after the command itself.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(USAGE);
    return 0;
  }
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
  } finally {
    await sharedProcessLauncher().close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Not a top-level await: the single executable (tools/sea) bundles this
  // module as CommonJS, which cannot contain one. `main` reports its own errors.
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
