#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Run a test suite in an isolated environment.
 * Usage: node scripts/run-tests.mjs <suite> [--inventory FILE] [file ...]
 *
 * Suites are listed in SUITES. Tests never see the developer's shell: the
 * `node --test` process gets the system variables of lib/environment.mjs, any
 * `HARNESSHUB_TEST_*` opt-in switch, and private HOME, USERPROFILE, APPDATA,
 * LOCALAPPDATA, XDG and temporary directories in a fresh sandbox. Product
 * settings (HARNESSHUB_MODEL*, AGENT_ENGINE, ...) and credentials are absent
 * unless a test sets them itself, so a developer's key can never reach an
 * upstream through a test. HARNESSHUB_TEST_SYSTEM_HOME carries the account's
 * real home for the few tests that must use a per-account OS service (the macOS
 * login keychain); nothing else may read it.
 *
 * Every test gets a default timeout and the suite a wall-clock deadline; at the
 * deadline the process tree is killed and the run fails, since a test file that
 * leaves a handle open otherwise never exits. After the run, anything left in the
 * sandbox's temporary directory is a leaked resource and fails the run. The
 * sandbox is removed in every case. Exits with the test status, or 1.
 *
 * `--inventory FILE` also writes the suite's test inventory (see `runSuite`) to
 * FILE, replacing it; the spec output on stdout stays as it is. Without the
 * flag, a non-empty HARNESSHUB_TEST_INVENTORY_DIR writes it to
 * `<dir>/<suite>.jsonl`; CI sets it for `pnpm check` and uploads the directory.
 * That variable is the launcher's own setting and is not passed to the tests.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assignEnvironment, pickEnvironment } from "./lib/environment.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INVENTORY_REPORTER = new URL("./test-inventory-reporter.mjs", import.meta.url).href;

/** Default file patterns, per-test timeout and suite deadline. */
export const SUITES = {
  tooling: { files: ["scripts/check-*.test.mjs"], testTimeoutMs: 60_000, deadlineMs: 5 * 60_000 },
  unit: { files: ["dist/tests/unit/*.test.js"], testTimeoutMs: 60_000, deadlineMs: 10 * 60_000 },
  integration: { files: ["dist/tests/integration/*.test.js"], testTimeoutMs: 120_000, deadlineMs: 25 * 60_000 },
  smoke: { files: ["dist/tests/smoke/*.test.js"], testTimeoutMs: 120_000, deadlineMs: 10 * 60_000 },
};

/** Test opt-in switches; the inventory directory belongs to the launcher, not to the tests. */
const OPT_IN = /^HARNESSHUB_TEST_(?!INVENTORY_DIR$)/i;

/**
 * The environment of the test process: allowlisted parent variables plus private directories.
 *
 * @param {Record<string, string | undefined>} parent Usually process.env.
 * @param {string} sandbox Directory owned by this run.
 * @param {string} systemHome The account's real home; a nested run keeps the outer value.
 * @returns {Record<string, string>}
 */
export function testEnvironment(parent, sandbox, systemHome) {
  const { env } = pickEnvironment(parent, { patterns: [OPT_IN] });
  env.HARNESSHUB_TEST_SYSTEM_HOME ??= systemHome;
  return assignEnvironment(env, privateDirectories(sandbox));
}

function privateDirectories(sandbox) {
  const home = path.join(sandbox, "home");
  const temporary = path.join(sandbox, "tmp");
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
  };
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

/**
 * Add the suite name to the reporter's lines and write them to the inventory file.
 *
 * @param {string} reported The reporter's destination inside the sandbox.
 * @param {{suite: string, file: string}} inventory
 * @returns {Promise<string[]>} Diagnostics; a missing or cut-off reporter output is one.
 */
async function writeInventory(reported, { suite, file }) {
  let text;
  try {
    text = await readFile(reported, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return ["the test inventory reporter wrote nothing"];
    throw error;
  }
  const lines = text.split("\n");
  const cutOff = lines.pop() !== "";
  const entries = lines.map((line) => `${JSON.stringify({ suite, ...JSON.parse(line) })}\n`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entries.join(""));
  return cutOff ? ["the test inventory ends in an incomplete line"] : [];
}

/**
 * Run `node --test` over the files in a fresh sandbox and remove the sandbox afterwards.
 *
 * @param {object} options
 * @param {string[]} options.files File paths or glob patterns, relative to the repository.
 * @param {number} options.testTimeoutMs Default timeout of each test.
 * @param {number} options.deadlineMs Wall-clock limit of the whole run.
 * @param {Record<string, string | undefined>} [options.parentEnv]
 * @param {string} [options.cwd]
 * @param {"inherit" | "ignore"} [options.stdio] Test output; "ignore" is for tests of this launcher.
 * @param {{suite: string, file: string}} [options.inventory] Also write the test
 *   inventory to `file`, replacing it: one JSON line per reported test,
 *   `{"suite", "file", "test", "status"}`, as test-inventory-reporter.mjs
 *   describes, in the runner's reporting order. It is written after every run
 *   that started, including failed ones, and lists only the tests the runner
 *   reported. The spec reporter still writes to stdout.
 * @returns {Promise<{status: number, diagnostics: string[]}>} status 0 only when the
 *   tests passed, the deadline held, nothing leaked and a requested inventory is complete.
 */
export async function runSuite({
  files,
  testTimeoutMs,
  deadlineMs,
  parentEnv = process.env,
  cwd = ROOT,
  stdio = "inherit",
  inventory,
}) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "hh-test-"));
  const diagnostics = [];
  let status = 1;
  try {
    const env = testEnvironment(parentEnv, sandbox, os.homedir());
    for (const directory of new Set(Object.values(privateDirectories(sandbox))))
      await mkdir(directory, { recursive: true });
    const reported = path.join(sandbox, "inventory.jsonl");
    const reporters = inventory
      ? [
          `--test-reporter=${INVENTORY_REPORTER}`,
          `--test-reporter-destination=${reported}`,
          "--test-reporter=spec",
          "--test-reporter-destination=stdout",
        ]
      : [];
    const child = spawn(process.execPath, ["--test", `--test-timeout=${testTimeoutMs}`, ...reporters, ...files], {
      cwd,
      env,
      stdio,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      killTree(child);
    }, deadlineMs);
    const interrupt = (signal) => {
      killTree(child);
      diagnostics.push(`interrupted by ${signal}`);
    };
    process.once("SIGINT", interrupt).once("SIGTERM", interrupt);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timer);
      process.off("SIGINT", interrupt).off("SIGTERM", interrupt);
    });
    if (expired)
      diagnostics.push(
        `suite exceeded its ${deadlineMs} ms deadline and was killed; a test file probably left a handle open`,
      );
    else if (exit.code !== 0) diagnostics.push(`node --test exited with ${exit.signal ?? exit.code}`);
    const leaked = await readdir(path.join(sandbox, "tmp"));
    if (leaked.length) diagnostics.push(`tests left temporary entries behind: ${leaked.sort().join(", ")}`);
    if (inventory) diagnostics.push(...(await writeInventory(reported, inventory)));
    status = diagnostics.length ? 1 : 0;
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5 });
  }
  return { status, diagnostics };
}

/**
 * Parse the command line.
 *
 * @param {string[]} args Arguments after the script path.
 * @param {Record<string, string | undefined>} env Supplies HARNESSHUB_TEST_INVENTORY_DIR.
 * @returns {{name: string, files: string[], inventory?: {suite: string, file: string}}}
 * @throws {Error} For an unknown suite or option, or `--inventory` without a file.
 */
export function parseCommandLine(args, env) {
  const usage = `usage: node scripts/run-tests.mjs <${Object.keys(SUITES).join("|")}> [--inventory FILE] [file ...]`;
  let parsed;
  try {
    parsed = parseArgs({ args, options: { inventory: { type: "string" } }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Error(`${error.message}\n${usage}`);
  }
  const [name, ...files] = parsed.positionals;
  if (!Object.hasOwn(SUITES, name)) throw new Error(usage);
  const directory = env.HARNESSHUB_TEST_INVENTORY_DIR;
  const file =
    parsed.values.inventory !== undefined
      ? parsed.values.inventory
      : directory
        ? path.join(directory, `${name}.jsonl`)
        : undefined;
  if (file === "") throw new Error(`--inventory needs a file\n${usage}`);
  return { name, files, ...(file === undefined ? {} : { inventory: { suite: name, file: path.resolve(file) } }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let command;
  try {
    command = parseCommandLine(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { name, files, inventory } = command;
  const suite = SUITES[name];
  const { status, diagnostics } = await runSuite({
    ...suite,
    files: files.length ? files : suite.files,
    ...(inventory ? { inventory } : {}),
  });
  for (const line of diagnostics) console.error(`run-tests (${name}): ${line}`);
  if (inventory && status === 0) console.error(`run-tests (${name}): test inventory written to ${inventory.file}`);
  process.exitCode = status;
}
