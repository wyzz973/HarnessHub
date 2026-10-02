#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Write the build identity to packages/daemon/dist/build-info.json (F04),
 * next to the compiled daemon that reads it.
 * Usage: node tools/build-info.mjs [--out FILE]
 *
 * Fields follow docs/proposals/oss/10-engineering.md section 5. CI builds take
 * the commit and ref from GITHUB_SHA and GITHUB_REF and link the workflow run;
 * local builds ask git, and only when the source directory is itself the top
 * of a checkout. A value that cannot be determined is written as "unknown",
 * never guessed; `dirty` counts modified and untracked (non-ignored) files. builtAt honors SOURCE_DATE_EPOCH so a release can
 * be reproduced. Builds from this script are source builds on the dev channel;
 * packaged releases (milestone M1) set their own channel and install method.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const UNKNOWN = "unknown";

/** Variables that would point git at another repository than the checkout. */
const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

function git(cwd, args) {
  const env = { ...process.env };
  for (const name of GIT_REDIRECTS) delete env[name];
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Whether git answers for this checkout itself. A source tree unpacked inside
 * another repository must not report that repository's identity.
 */
async function ownCheckout(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top === undefined) return false;
  try {
    return (await realpath(top)) === (await realpath(cwd));
  } catch {
    return false;
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
  const local = (await ownCheckout(cwd)) ? (args) => git(cwd, args) : () => undefined;
  const commit = env.GITHUB_SHA || local(["rev-parse", "HEAD"]) || UNKNOWN;
  // Untracked files count: tsc compiles any packages/*/src/**/*.ts, tracked or not.
  const status = local(["status", "--porcelain"]);
  const symbolicRef = local(["rev-parse", "--symbolic-full-name", "HEAD"]);
  const run =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  return {
    version,
    channel: "dev",
    commit,
    commitDate: (commit !== UNKNOWN && local(["show", "-s", "--format=%cI", commit])) || UNKNOWN,
    // A detached HEAD has no ref; "HEAD" would name nothing.
    ref: env.GITHUB_REF || (symbolicRef && symbolicRef !== "HEAD" ? symbolicRef : UNKNOWN),
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
  const out = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(ROOT, "packages", "daemon", "dist", "build-info.json");
  const info = await collectBuildInfo();
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`Build identity: ${info.version} ${info.commit}${info.dirty === true ? " (dirty)" : ""} -> ${path.relative(ROOT, out)}`);
}
