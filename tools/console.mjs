#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Build or develop the console without the developer's environment.
 * Usage: node tools/console.mjs <build|dev> [next arguments]
 *
 * Next.js 16 records the environment of the build process in its Turbopack
 * cache (web/.next/cache), so a token in the developer's shell ends up on disk.
 * The console toolchain therefore gets only the system variables of
 * lib/environment.mjs, the home and temporary directories, CI and
 * HARNESSHUB_GATEWAY_URL, with Next.js telemetry disabled.
 *
 * After a build, web/.next is searched for a random canary that was placed in the
 * parent environment and for every dropped variable whose name looks like a
 * credential; a hit fails the build and names the variable, never the value.
 * Exits with Next's status, or 1.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assignEnvironment, pickEnvironment } from "./lib/environment.mjs";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const NEXT = path.join(WEB, "node_modules", "next", "dist", "bin", "next");
const ALLOWED = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "HARNESSHUB_GATEWAY_URL",
];
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PAT)(_|$)/i;
const CANARY = "HARNESSHUB_CONSOLE_CANARY";
const DEFAULT_ARGUMENTS = { build: [], dev: ["--hostname", "127.0.0.1", "--port", "3330"] };

/**
 * The console toolchain's environment and the values that must not appear in its output.
 *
 * @param {Record<string, string | undefined>} parent Usually process.env plus the canary.
 * @returns {{env: Record<string, string>, needles: Record<string, string>}}
 */
export function consoleEnvironment(parent) {
  const { env, dropped } = pickEnvironment(parent, { names: ALLOWED });
  const needles = Object.fromEntries(
    Object.entries(dropped).filter(
      ([name, value]) => (name === CANARY || CREDENTIAL_NAME.test(name)) && value.length >= 8,
    ),
  );
  return { env: assignEnvironment(env, { NEXT_TELEMETRY_DISABLED: "1" }), needles };
}

/**
 * Search every file under a directory for the given values, byte for byte.
 *
 * @param {string} directory
 * @param {Record<string, string>} needles Variable name to value.
 * @returns {Promise<string[]>} `name in relative/path` for each hit; values are never returned.
 */
export async function findLeaks(directory, needles) {
  const patterns = Object.entries(needles).map(([name, value]) => [name, Buffer.from(value)]);
  const hits = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(file);
    for (const [name, pattern] of patterns)
      if (bytes.includes(pattern)) hits.push(`${name} in ${path.relative(directory, file)}`);
  }
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "build" && command !== "dev") {
    console.error("usage: node tools/console.mjs <build|dev> [next arguments]");
    process.exit(1);
  }
  const { env, needles } = consoleEnvironment({ ...process.env, [CANARY]: randomBytes(16).toString("hex") });
  const child = spawn(process.execPath, [NEXT, command, ...(rest.length ? rest : DEFAULT_ARGUMENTS[command])], {
    cwd: WEB,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (status !== 0 || command !== "build") process.exit(status);
  const leaks = await findLeaks(path.join(WEB, ".next"), needles);
  for (const leak of leaks) console.error(`console build output contains the value of ${leak}`);
  if (leaks.length) process.exit(1);
  console.log(`Console build output checked for ${Object.keys(needles).length} environment values.`);
}
