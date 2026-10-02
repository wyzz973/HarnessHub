#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Check that every non-merge commit in a range carries a Developer Certificate
 * of Origin sign-off by its author.
 * Usage: node tools/check-dco.mjs <base>..<head>
 *
 * A commit passes when one of its `Signed-off-by` trailers names the author's
 * email (case-insensitive), which is what `git commit -s` writes. Commits
 * authored by GitHub App bots (names ending in `[bot]`, such as Dependabot) are
 * exempt: a bot cannot certify the DCO, and the maintainer who merges the
 * change is responsible for it. Exits non-zero when any commit fails or git fails.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIELD = "\u001f";
const RECORD = "\u001e";

/**
 * Read the commits of a range with their sign-off trailers.
 *
 * @param {string} range `<base>..<head>`.
 * @param {string} [cwd] Repository directory.
 * @returns {{sha: string, authorName: string, authorEmail: string, signoffs: string[]}[]}
 * @throws When git fails, for example on an unknown revision.
 */
export function readCommits(range, cwd = process.cwd()) {
  const format = ["%H", "%an", "%ae", "%(trailers:key=Signed-off-by,valueonly,separator=%x1d)"].join(FIELD);
  const output = execFileSync("git", ["log", "--no-merges", `--format=${format}${RECORD}`, range], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const [sha, authorName, authorEmail, trailers] = record.split(FIELD);
      return { sha, authorName, authorEmail, signoffs: trailers.split("\u001d").filter(Boolean) };
    });
}

/**
 * @param {{sha: string, authorName: string, authorEmail: string, signoffs: string[]}[]} commits
 * @returns {string[]} One diagnostic per commit without its author's sign-off.
 */
export function checkSignoffs(commits) {
  const diagnostics = [];
  for (const { sha, authorName, authorEmail, signoffs } of commits) {
    if (authorName.endsWith("[bot]")) continue;
    const email = `<${authorEmail.toLowerCase()}>`;
    if (!signoffs.some((value) => value.trim().toLowerCase().endsWith(email)))
      diagnostics.push(`${sha}: no "Signed-off-by: ${authorName} <${authorEmail}>" trailer (use git commit -s)`);
  }
  return diagnostics;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const range = process.argv[2];
  if (!range || !range.includes("..")) {
    console.error("usage: node tools/check-dco.mjs <base>..<head>");
    process.exit(1);
  }
  const commits = readCommits(range);
  const diagnostics = checkSignoffs(commits);
  for (const line of diagnostics) console.error(line);
  if (diagnostics.length) process.exit(1);
  console.log(`DCO sign-off verified for ${commits.length} commits.`);
}
