#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Compare two test inventories written by `run-tests.mjs --inventory`.
 * Usage: node tools/compare-inventory.mjs <before> <after> [--allow FILE]
 *
 * <before> and <after> are inventory files, or directories whose `*.jsonl`
 * files together form the inventory (as CI uploads them). Entries match by
 * suite, test name path and status; the test file is ignored, because files
 * move between packages. Entries are counted, so a test name that appears
 * twice must still appear twice. Every entry that is missing from <after>, or
 * added to it, is printed with its count.
 *
 * `--allow FILE` lists expected additions in the same JSON-lines format (the
 * `file` field may be left out); each line allows one added entry. An allowed
 * addition that does not happen is reported too, so the allowlist stays exact.
 *
 * Exits 0 when nothing differs, 1 when something does, and 2 for invalid
 * arguments or input, including an inventory without entries.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const STATUSES = new Set(["pass", "fail", "skip", "todo"]);

/**
 * @typedef {{suite: string, file: string | null, test: string[], status: string}} Entry
 * @typedef {Entry & {count: number}} Difference An entry and how many of its occurrences differ.
 */

/** Thrown for unreadable or malformed input; the CLI exits 2. */
export class InventoryError extends Error {}

function parseEntry(line, where) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    throw new InventoryError(`${where}: not JSON`);
  }
  const valid =
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.suite === "string" &&
    entry.suite !== "" &&
    Array.isArray(entry.test) &&
    entry.test.length > 0 &&
    entry.test.every((name) => typeof name === "string") &&
    STATUSES.has(entry.status) &&
    (entry.file === undefined || entry.file === null || typeof entry.file === "string");
  if (!valid) throw new InventoryError(`${where}: expected {"suite", "file", "test": [names], "status"}`);
  return { suite: entry.suite, file: entry.file ?? null, test: entry.test, status: entry.status };
}

/**
 * Read an inventory file, or every `*.jsonl` file of a directory.
 *
 * @param {string} location
 * @returns {Promise<Entry[]>}
 * @throws {InventoryError} When the location cannot be read, a line is malformed or there is no entry.
 */
export async function readInventory(location) {
  let files;
  try {
    files = (await stat(location)).isDirectory()
      ? (await readdir(location))
          .filter((name) => name.endsWith(".jsonl"))
          .sort()
          .map((name) => path.join(location, name))
      : [location];
  } catch (error) {
    throw new InventoryError(`${location}: ${error.code ?? error.message}`);
  }
  const entries = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (line.trim() !== "") entries.push(parseEntry(line, `${file}:${index + 1}`));
    });
  }
  if (!entries.length) throw new InventoryError(`${location}: no inventory entries`);
  return entries;
}

const keyOf = ({ suite, test, status }) => JSON.stringify([suite, status, test]);

function count(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { entry, count: 1 });
  }
  return counts;
}

/**
 * Compare two inventories, ignoring test files.
 *
 * @param {Entry[]} before
 * @param {Entry[]} after
 * @param {Entry[]} [allowed] Expected additions, one entry per allowed occurrence.
 * @returns {{missing: Difference[], added: Difference[], unusedAllowance: Difference[]}} Sorted
 *   differences; all empty when the inventories match apart from the allowed additions.
 */
export function compareInventories(before, after, allowed = []) {
  const old = count(before);
  const now = count(after);
  const allowance = count(allowed);
  const missing = [];
  const added = [];
  const unusedAllowance = [];
  const difference = (counted, number) => ({ ...counted.entry, count: number });
  for (const key of new Set([...old.keys(), ...now.keys(), ...allowance.keys()])) {
    const was = old.get(key)?.count ?? 0;
    const is = now.get(key)?.count ?? 0;
    const permitted = allowance.get(key)?.count ?? 0;
    const extra = Math.max(is - was, 0);
    if (was > is) missing.push(difference(old.get(key), was - is));
    if (extra > permitted) added.push(difference(now.get(key), extra - permitted));
    if (permitted > extra) unusedAllowance.push(difference(allowance.get(key), permitted - extra));
  }
  const order = (a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  return { missing: missing.sort(order), added: added.sort(order), unusedAllowance: unusedAllowance.sort(order) };
}

/**
 * @param {ReturnType<typeof compareInventories>} differences
 * @returns {string[]} One readable line per difference.
 */
export function formatDifferences({ missing, added, unusedAllowance }) {
  const line = (label, { suite, status, test, file, count: number }) =>
    `${label} ${suite} ${status} ${JSON.stringify(test)}${file ? ` (${file})` : ""}${number > 1 ? ` x${number}` : ""}`;
  return [
    ...missing.map((entry) => line("missing", entry)),
    ...added.map((entry) => line("added", entry)),
    ...unusedAllowance.map((entry) => line("allowed but not added", entry)),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "usage: node tools/compare-inventory.mjs <before> <after> [--allow FILE]";
  try {
    let parsed;
    try {
      parsed = parseArgs({ options: { allow: { type: "string" } }, allowPositionals: true, strict: true });
    } catch (error) {
      throw new InventoryError(`${error.message}\n${usage}`);
    }
    if (parsed.positionals.length !== 2) throw new InventoryError(usage);
    const [beforePath, afterPath] = parsed.positionals;
    const before = await readInventory(beforePath);
    const after = await readInventory(afterPath);
    const allowed = parsed.values.allow === undefined ? [] : await readInventory(parsed.values.allow);
    const lines = formatDifferences(compareInventories(before, after, allowed));
    for (const line of lines) console.log(line);
    console.log(
      `${before.length} entries before, ${after.length} after, ${allowed.length} allowed additions: ` +
        (lines.length ? `${lines.length} differences` : "no differences"),
    );
    process.exitCode = lines.length ? 1 : 0;
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    console.error(`compare-inventory: ${error.message}`);
    process.exitCode = 2;
  }
}
