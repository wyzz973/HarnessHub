// SPDX-License-Identifier: MIT
/**
 * Compiled entry points that tests start by path, resolved from this file's
 * compiled location `dist/tests/support/entries.js`. ProcessWorkerHost requires
 * its Worker entry (ADR 0017 decision 5); tests pass WORKER_ENTRY, the same
 * Worker that the composition root forks.
 */
export const WORKER_ENTRY = new URL(
  "../../src/worker/main.js",
  import.meta.url,
);
