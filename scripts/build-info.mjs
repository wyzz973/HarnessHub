#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Write the build identity to dist/build-info.json (F04).
 * Usage: node scripts/build-info.mjs [--out FILE]
 *
 * Fields follow docs/proposals/oss/10-engineering.md section 5. CI builds take
 * the commit and ref from GITHUB_SHA and GITHUB_REF and link the workflow run;
 * local builds ask git. A value that cannot be determined is written as
 * "unknown", never guessed. builtAt honors SOURCE_DATE_EPOCH so a release can
 * be reproduced. Builds from this script are source builds on the dev channel;
 * packaged releases (milestone M1) set their own channel and install method.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const UNKNOWN = "unknown";

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function builtAt(env, now) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === "") return now.toISOString();
  if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH must be whole seconds, got ${JSON.stringify(epoch)}`);
  return new Date(Number(epoch) * 1000).toISOString();
}

/**
 * Determine the build identity of a checkout.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] Repository directory.
 * @param {Record<string, string | undefined>} [options.env]
 * @param {Date} [options.now]
 * @returns {Promise<Record<string, unknown>>}
 * @throws When package.json is unreadable or SOURCE_DATE_EPOCH is malformed.
 */
export async function collectBuildInfo({ cwd = ROOT, env = process.env, now = new Date() } = {}) {
  const { version } = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  const commit = env.GITHUB_SHA || git(cwd, ["rev-parse", "HEAD"]) || UNKNOWN;
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  const run =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  return {
    version,
    channel: "dev",
    commit,
    commitDate: (commit !== UNKNOWN && git(cwd, ["show", "-s", "--format=%cI", commit])) || UNKNOWN,
    ref: env.GITHUB_REF || git(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]) || UNKNOWN,
    dirty: status === undefined ? UNKNOWN : status !== "",
    builtAt: builtAt(env, now),
    workflowRun: run,
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    installMethod: "source",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(ROOT, "dist", "build-info.json");
  const info = await collectBuildInfo();
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`Build identity: ${info.version} ${info.commit}${info.dirty === true ? " (dirty)" : ""} -> ${path.relative(ROOT, out)}`);
}
