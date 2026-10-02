// SPDX-License-Identifier: MIT
import { BUILD_INFO, HH_ENTRY } from "../support/entries.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "../support/temporary.js";

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the installed `hh` launcher in plain Node and collect its outcome. */
function hh(cwd: string, args: string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(HH_ENTRY), ...args],
      { cwd, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code: error === null ? 0 : Number(error.code),
          stdout,
          stderr,
        });
      },
    );
  });
}

void test(
  "hh dispatches serve, benchmark and tools to the daemon and rollout to the CLI",
  { timeout: 60_000 },
  async (t) => {
    const { directory } = await temporaryDirectory(t, "harnesshub-hh-");
    const build: unknown = JSON.parse(await readFile(BUILD_INFO, "utf8"));

    const version = await hh(directory, ["serve", "--version", "--json"]);
    assert.equal(version.code, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), build);

    const benchmark = await hh(directory, ["benchmark", "--help"]);
    assert.equal(benchmark.code, 0, benchmark.stderr);
    assert.match(benchmark.stdout, /^HarnessHub Benchmark: /);

    const tools = await hh(directory, ["tools", "list"]);
    assert.equal(tools.code, 1);
    assert.equal(
      (JSON.parse(tools.stderr) as { error: { code: string } }).error.code,
      "INVALID_TOOL_PACKAGE_ARGUMENT",
    );

    const rollout = await hh(directory, ["rollout"]);
    assert.equal(rollout.code, 1);
    assert.match(rollout.stderr, /^Missing --url, --run or --output\. /);

    const unknown = await hh(directory, ["deploy"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^Unknown command: deploy\nUsage: hh /);

    const missing = await hh(directory, []);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^Usage: hh <command>/);
    assert.equal(missing.stdout, "");

    const help = await hh(directory, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: hh <command>/);
  },
);
