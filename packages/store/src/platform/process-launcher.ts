// SPDX-License-Identifier: MIT
import { HubError } from "@harnesshub/core/errors";
import type { ProcessLauncher } from "@harnesshub/core/process-launcher";

let installed: ProcessLauncher | undefined;

/**
 * Sets the launcher that the Windows filesystem primitives start their ACL
 * helper with. Each process's composition root sets its process launcher once
 * at startup, before any primitive runs (they are called from deep inside
 * artifacts and Tool Pack storage, where no context reaches them). Setting the
 * same launcher again is allowed; setting a different one throws, so a process
 * cannot end up with two owners for these helpers.
 */
export function usePlatformLauncher(launcher: ProcessLauncher): void {
  if (installed !== undefined && installed !== launcher)
    throw new Error("The platform process launcher is already set");
  installed = launcher;
}

/**
 * The launcher set by usePlatformLauncher.
 *
 * @throws HubError PROCESS_LAUNCHER_NOT_INJECTED (500) when none is set, a
 *   composition defect.
 */
export function platformLauncher(): ProcessLauncher {
  if (installed === undefined)
    throw new HubError(
      "PROCESS_LAUNCHER_NOT_INJECTED",
      "The Windows ACL helper needs a process launcher from the composition root",
      500,
    );
  return installed;
}
