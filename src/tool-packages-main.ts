import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubError } from "./domain/errors.js";
import { prepareEngine } from "./engine/registry.js";
import { runToolPackageCli } from "./tool-packages/index.js";

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
    commandMcpEntry: fileURLToPath(
      new URL("./tool-packages/command-mcp.js", import.meta.url),
    ),
    prepareEngine,
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await toolPackagesMain(process.argv.slice(2)), null, 2),
    );
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
    process.exitCode = 1;
  }
}
