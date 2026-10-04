// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { conflictMarkers, scan } from "./check-conflicts.mjs";

// Built at run time so this file holds no marker lines of its own.
const open = "<".repeat(7);
const base = "|".repeat(7);
const split = "=".repeat(7);
const close = ">".repeat(7);

test("finds the markers of a two-way and a three-way conflict", () => {
  const twoWay = ["a", `${open} HEAD`, "ours", split, "theirs", `${close} feat/x`, "b"].join("\n");
  assert.deepEqual(conflictMarkers(twoWay), [2, 4, 6]);
  const threeWay = [`${open} HEAD`, "ours", `${base} merged common ancestors`, "base", split, "theirs", close].join("\r\n");
  assert.deepEqual(conflictMarkers(threeWay), [1, 3, 5, 7]);
});

test("leaves text that only looks similar alone", () => {
  const text = [
    "Title",
    split, // a Markdown heading underline with no opening marker before it
    `${open}x`, // not followed by a space
    `  ${close} indented`,
    "=".repeat(8),
    "a <<<<<<< in the middle",
  ].join("\n");
  assert.deepEqual(conflictMarkers(text), []);
});

test("scans tracked and untracked files, skips binary and ignored ones", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hh-conflicts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "clean.md"), `Title\n${split}\n`);
  await writeFile(path.join(root, "tracked.ts"), `${open} HEAD\na\n${split}\nb\n${close} other\n`);
  git("add", ".gitignore", "clean.md", "tracked.ts");
  await writeFile(path.join(root, "untracked.md"), `x\n${close} theirs\n`);
  await writeFile(path.join(root, "ignored.txt"), `${open} HEAD\n`);
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, ...Buffer.from(`\n${open} HEAD\n`)]));
  const { problems, scanned } = await scan(root);
  assert.deepEqual(problems, [
    { file: "tracked.ts", lines: [1, 3, 5] },
    { file: "untracked.md", lines: [2] },
  ]);
  assert.equal(scanned, 4);
});

test("the command fails on a marker and passes on a clean tree", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "hh-conflicts-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./check-conflicts.mjs", import.meta.url));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const run = () => {
    try {
      execFileSync(process.execPath, [script, "--root", root], { stdio: "pipe" });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run(), 1, "no files to scan fails");
  await writeFile(path.join(root, "a.md"), "fine\n");
  assert.equal(run(), 0);
  await writeFile(path.join(root, "b.md"), `${open} HEAD\n`);
  assert.equal(run(), 1);
});

test("the repository holds no conflict markers", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { problems, scanned } = await scan(root);
  assert.deepEqual(problems, []);
  assert.ok(scanned > 0);
});
