#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Remove compiled TypeScript output before `tsc -b` runs.
 * Usage: node tools/clean-build.mjs
 *
 * tsc never deletes the output of a source file that no longer exists, so after
 * a branch switch a stale dist/tests/**.test.js would still run and fail (or
 * pass) against code it does not belong to. `tsc -b` also trusts each project's
 * .tsbuildinfo: with the outputs gone but the .tsbuildinfo kept, it reports the
 * project as up to date and emits nothing. Every output directory is therefore
 * removed together with its .tsbuildinfo: `dist/{src,tests,.tsbuildinfo}` at
 * the root (the tests project, and src/ until OSS-004 step 9 removed it), and
 * `dist/{src,test,.tsbuildinfo}` of every
 * workspace package under packages/ and apps/. `dist/native` is left to the
 * native helper scripts, which rebuild it on every `pnpm build`; `dist/sea` and
 * `dist/build-info.json` belong to their own build steps.
 */

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directories that hold workspace packages, each with its own dist/. */
const WORKSPACE_DIRECTORIES = ["packages", "apps"];

async function workspaceProjects(root) {
  const projects = [];
  for (const directory of WORKSPACE_DIRECTORIES) {
    let entries;
    try {
      entries = await readdir(path.join(root, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) if (entry.isDirectory()) projects.push(path.join(root, directory, entry.name));
  }
  return projects;
}

/**
 * Remove the TypeScript outputs and build information of the repository at root.
 *
 * @param {string} [root] Repository root; defaults to this repository.
 * @returns {Promise<string[]>} The paths removed or confirmed absent, relative to root.
 */
export async function cleanBuild(root = fileURLToPath(new URL("../", import.meta.url))) {
  const targets = [
    ...["src", "tests", ".tsbuildinfo"].map((name) => path.join(root, "dist", name)),
    ...(await workspaceProjects(root)).flatMap((project) =>
      ["src", "test", ".tsbuildinfo"].map((name) => path.join(project, "dist", name)),
    ),
  ];
  for (const target of targets) await rm(target, { recursive: true, force: true });
  return targets.map((target) => path.relative(root, target).split(path.sep).join("/"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cleanBuild();
