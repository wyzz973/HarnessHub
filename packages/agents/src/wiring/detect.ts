// SPDX-License-Identifier: MIT
import { stat } from "node:fs/promises";
import path from "node:path";
import { locateExecutable } from "../engine/executables.js";
import { wiringAdapter } from "./adapters/index.js";
import { isCode } from "./files.js";
import {
  adapterEnvironment,
  checkContext,
  type WiringContext,
} from "./operations.js";

/** Whether an agent is on this machine, as far as can be told without running it. */
export interface AgentInstallation {
  /**
   * `installed`: one of its commands is on PATH; `configured-only`: no
   * command, but a configuration directory exists; `not-found`: neither.
   */
  status: "installed" | "configured-only" | "not-found";
  /** The command found on PATH. */
  executable?: string;
  /** The adapter's configuration directories that exist. */
  configDirectories: string[];
}

/**
 * Detects an agent from the explicit context only: PATH and PATHEXT come
 * from `context.env` (never `process.env`) and directories from the adapter's
 * own file locations under `context.home` (not the files it shares with
 * another agent). Nothing is executed and no file is
 * read; a command counts when it is an executable regular file. Unknown
 * adapters fail with WIRING_ADAPTER_UNKNOWN.
 */
export async function detectAgent(
  adapterId: string,
  context: WiringContext,
): Promise<AgentInstallation> {
  const adapter = wiringAdapter(adapterId);
  await checkContext(context);
  const environment = adapterEnvironment(context);
  const directories = [
    ...new Set(
      adapter.files
        .filter((file) => !file.shared)
        .map((file) => path.dirname(file.locate(environment).create)),
    ),
  ];
  const configDirectories: string[] = [];
  for (const directory of directories)
    try {
      if ((await stat(directory)).isDirectory())
        configDirectories.push(directory);
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
    }
  const searchPath = (context.env?.PATH ?? context.env?.Path ?? "")
    .split(path.delimiter)
    .filter((entry) => entry !== "" && path.isAbsolute(entry));
  const executable = await locateExecutable(
    adapter.executables,
    searchPath,
    process.platform,
    context.env?.PATHEXT,
  );
  return {
    status: executable
      ? "installed"
      : configDirectories.length
        ? "configured-only"
        : "not-found",
    ...(executable ? { executable } : {}),
    configDirectories,
  };
}
