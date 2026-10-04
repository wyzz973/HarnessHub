#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Check that no file in the working tree still holds merge conflict markers.
 * Usage: node tools/check-conflicts.mjs [--root <directory>]
 *
 * Scans the files git tracks plus untracked files it does not ignore, so a
 * rebase or merge stopped on a conflict cannot be checked as if it were done.
 * A marker is a line that starts with seven `<`, `|` or `>` followed by a
 * space or the line's end, or a line of exactly seven `=` after an opening
 * marker in the same file. Binary files (a NUL byte in the first 8 KiB) are
 * skipped. Exits non-zero when any marker is found or no file is scanned.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPEN = /^<{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;
const SPLIT = /^={7}$/;
const CLOSE = /^>{7}(?: |$)/;

/**
 * The 1-based line numbers of conflict markers in `text`. A separator line
 * counts only after an opening or base marker, since Markdown and other text
 * may use a line of `=` on its own.
 */
export function conflictMarkers(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  let open = false;
  lines.forEach((line, index) => {
    if (OPEN.test(line) || BASE.test(line)) {
      open = true;
      found.push(index + 1);
    } else if (CLOSE.test(line)) {
      open = false;
      found.push(index + 1);
    } else if (open && SPLIT.test(line)) found.push(index + 1);
  });
  return found;
}

/** The files to scan: tracked, plus untracked ones git does not ignore. */
export function workingTreeFiles(root) {
  const list = (args) =>
    execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  return [...new Set([...list(["--cached"]), ...list(["--others", "--exclude-standard"])])].sort();
}

/** `{file, lines}` for every scanned file with markers, and how many files were scanned. */
export async function scan(root, files = workingTreeFiles(root)) {
  const problems = [];
  let scanned = 0;
  for (const file of files) {
    let bytes;
    try {
      bytes = await readFile(path.join(root, file));
    } catch (error) {
      // Deleted in the working tree but still in the index: nothing to read.
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (bytes.subarray(0, 8192).includes(0)) continue;
    scanned++;
    const lines = conflictMarkers(bytes.toString("utf8"));
    if (lines.length) problems.push({ file, lines });
  }
  return { problems, scanned };
}

async function main() {
  const index = process.argv.indexOf("--root");
  const root = index > 0 ? path.resolve(process.argv[index + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, scanned } = await scan(root);
  if (scanned === 0) {
    console.error("No files to check for conflict markers.");
    process.exitCode = 1;
    return;
  }
  for (const { file, lines } of problems)
    console.error(`${file}: conflict marker on line ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? ", …" : ""}`);
  if (problems.length) {
    console.error(`${problems.length} file(s) still hold merge conflict markers; resolve them first.`);
    process.exitCode = 1;
    return;
  }
  console.log(`No conflict markers in ${scanned} files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
