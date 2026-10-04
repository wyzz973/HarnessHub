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
  "Usage: hh tools --root <absolute store directory> <command> [options]";

const HELP = `${USAGE}

Commands:
  inspect --source DIR        validate a package directory; installs nothing
  install --source DIR        copy a package into the store and register it
  import --source PATH [--kind K] [--id ID] [--version V] [--display-name N]
                              register a skill directory or MCP configuration
                              as a package (installs, does not bind)
  list [--include-removed]    the registered packages
  verify --id ID --version V  validate every file of an installed package
  remove --id ID --version V  mark a package removed; its files stay
  bind --id ID --version V --engine FILE [--bindings FILE] [--replace]
                              an engine registration that uses the package

--root comes first. A result is JSON on stdout; a failure is JSON with its
code and message on stderr (exit 1).`;

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
 * message as JSON on stderr. `--help` (or `-h`) anywhere prints the usage
 * and exits 0.
 *
 * @param argv The command-line arguments after the command itself.
 * @returns The process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
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
