#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Remove compiled TypeScript output before `tsc` runs.
 * Usage: node tools/clean-build.mjs
 *
 * tsc never deletes the output of a source file that no longer exists, so after
 * a branch switch a stale dist/tests/**.test.js would still run and fail (or
 * pass) against code it does not belong to. dist/native is left to the native
 * helper scripts, which rebuild it on every `pnpm build`.
 */

import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

for (const directory of ["dist/src", "dist/tests"])
  await rm(fileURLToPath(new URL(`../${directory}`, import.meta.url)), { recursive: true, force: true });
