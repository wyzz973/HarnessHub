// SPDX-License-Identifier: MIT
/**
 * Compiled entry points that tests start by path, resolved through the
 * workspace packages' exports to their compiled files, as Node resolves them
 * at run time. ProcessWorkerHost requires its Worker entry (ADR 0017 decision
 * 5); tests pass WORKER_ENTRY, the same Worker that the daemon forks.
 */
const entry = (specifier: string): URL =>
  new URL(import.meta.resolve(specifier));

/** The daemon's command-line and composition entry (`startHub`). */
export const MAIN_ENTRY = entry("@harnesshub/daemon/main");
/** The Session Worker the daemon forks. */
export const WORKER_ENTRY = entry("@harnesshub/daemon/worker/main");
/** The Benchmark command. */
export const BENCHMARK_ENTRY = entry("@harnesshub/daemon/benchmark-main");
/** The Tool Pack command. */
export const TOOL_PACKAGES_ENTRY = entry(
  "@harnesshub/daemon/tool-packages-main",
);
/** The `rollout` command line. */
export const CLI_ENTRY = entry("@harnesshub/cli/cli");
/** The `hh` command as installed: the `harnesshub` application's bin launcher. */
export const HH_ENTRY = new URL("../../bin/hh.mjs", entry("harnesshub/main"));
/** The build identity that `pnpm build` writes next to the daemon's compiled code. */
export const BUILD_INFO = new URL("../build-info.json", MAIN_ENTRY);
