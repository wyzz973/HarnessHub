// SPDX-License-Identifier: MIT
/**
 * The process launcher for tests that call packages directly instead of
 * through a composition root: this test process's shared launcher, the one
 * `startHub` also uses. Importing this module also sets it for the Windows
 * filesystem primitives, as `startHub` and the Tool Pack command do; it is
 * imported for that effect by tests that use those primitives (directly, or
 * through artifacts and Tool Pack storage) before or without a Gateway.
 */
import { sharedProcessLauncher } from "@harnesshub/runtime/process/launcher";
import { usePlatformLauncher } from "@harnesshub/store/platform/process-launcher";

export const PROCESS_LAUNCHER = sharedProcessLauncher();
usePlatformLauncher(PROCESS_LAUNCHER);
