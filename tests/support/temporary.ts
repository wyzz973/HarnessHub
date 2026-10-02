// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export interface TemporaryDirectory {
  readonly directory: string;
  /** Register cleanup of a resource started in the directory; runs before removal, last registered first. */
  defer(cleanup: () => unknown): void;
}

/**
 * Create a temporary directory owned by the test.
 *
 * Removal is registered before the caller starts anything, so a setup step that
 * throws (a Gateway that fails to start, a rejected configuration) cannot leak
 * the directory. Deferred callbacks all run, even when one fails; the directory
 * is then removed and the first error is rethrown so the test still fails.
 */
export async function temporaryDirectory(
  t: TestContext,
  prefix: string,
): Promise<TemporaryDirectory> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const cleanups: (() => unknown)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    if (errors.length) throw errors[0];
  });
  return { directory, defer: (cleanup) => void cleanups.push(cleanup) };
}
