// SPDX-License-Identifier: MIT
/**
 * Main script of the HarnessHub single executable (SEA feasibility spike, OSS-008).
 *
 * tools/sea/build.mjs bundles this file together with the Gateway, the Worker and our own
 * child-process scripts into one CommonJS script that Node runs as the SEA main. It only
 * works inside that executable and is never run from the repository.
 *
 * Every HarnessHub process is the same binary; argv selects what it runs:
 * - `harnesshub serve [Gateway options]` and `harnesshub version [--json]`: user commands.
 * - `harnesshub <root>/<role entry> ...`: a child started by our own code. The code keeps
 *   computing child entry paths from `import.meta.url`; the build rewrites `import.meta.url`
 *   of every bundled module to the module's repository-relative location under the extraction
 *   root. `fork(<root>/dist/src/worker/main.js)` therefore re-executes this binary
 *   (`process.execPath`) with that path, and the dispatcher runs the bundled Worker. The child
 *   takes the root from that path, so a Worker whose HOME is private resolves the same files.
 * - `harnesshub <file.js|.mjs|.cjs> ...`: any other script runs as with `node <file>`
 *   ("node-compat"), for third-party Node agents and tool packages launched with the
 *   bundled Node executable, which is this binary.
 *
 * Extraction root: files that other programs read from disk (build identity, native helpers,
 * the Pi extension) and placeholders for role entries (tool package binding checks that its
 * entry is a regular file) are written once per build under a per-user cache directory
 * (`HARNESSHUB_SEA_ROOT` overrides it for measurements) and verified by SHA-256 whenever a user
 * command starts. A child accepts a root only when its marker names this build.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import Module from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { getAsset, isSea } from "node:sea";
import { pathToFileURL } from "node:url";

/* global __HH_SEA_BUILD_ID__, __HH_SEA_FILES__ -- replaced by tools/sea/build.mjs */
const BUILD_ID = __HH_SEA_BUILD_ID__;
/** @type {{path: string, asset: string, sha256: string, size: number, executable: boolean}[]} */
const FILES = __HH_SEA_FILES__;
const MARKER = ".harnesshub-sea.json";
const USAGE =
  "Usage: harnesshub serve [--demo] [--host localhost] [--port 3180] [--data-dir ./data] [--config FILE] [--engine ID] | harnesshub version [--json]";

/** Role entries, keyed by the repository-relative path their callers compute. */
const ROLES = new Map([
  ["dist/src/main.js", () => import("../../dist/src/main.js")],
  ["dist/src/worker/main.js", () => import("../../dist/src/worker/main.js")],
  [
    "dist/src/drivers/tool-command/command-mcp.js",
    () => import("../../dist/src/drivers/tool-command/command-mcp.js"),
  ],
  [
    "scripts/launch-engine.mjs",
    () => import("../../scripts/launch-engine.mjs"),
  ],
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const under = (root, relative) => path.join(root, ...relative.split("/"));

function defaultRoot() {
  const override = process.env.HARNESSHUB_SEA_ROOT;
  if (override) return path.resolve(override);
  let base;
  if (process.platform === "win32")
    base = path.join(
      process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
      "HarnessHub",
    );
  else if (process.platform === "darwin")
    base = path.join(homedir(), "Library", "Caches", "HarnessHub");
  else {
    const cache = process.env.XDG_CACHE_HOME;
    base = path.join(
      cache && path.isAbsolute(cache) ? cache : path.join(homedir(), ".cache"),
      "harnesshub",
    );
  }
  return path.join(base, "sea", BUILD_ID);
}

function readMarker(root) {
  try {
    const value = JSON.parse(readFileSync(path.join(root, MARKER), "utf8"));
    return typeof value?.buildId === "string" ? value.buildId : undefined;
  } catch {
    return undefined;
  }
}

function sameFile(target, file) {
  try {
    const stat = lstatSync(target);
    return (
      stat.isFile() &&
      stat.size === file.size &&
      sha256(readFileSync(target)) === file.sha256
    );
  } catch {
    return false;
  }
}

function writeAtomically(target, bytes, mode) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode, flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Create or repair the extraction root; returns the number of files written. */
function ensureRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`SEA root ${root} must be an ordinary directory`);
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid())
      throw new Error(`SEA root ${root} must be owned by the current user`);
    chmodSync(root, 0o700);
  }
  let written = 0;
  for (const file of FILES) {
    const target = under(root, file.path);
    if (sameFile(target, file)) continue;
    const bytes = Buffer.from(getAsset(file.asset));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw new Error(
        `SEA asset ${file.asset} does not match its build record`,
      );
    writeAtomically(target, bytes, file.executable ? 0o700 : 0o600);
    written += 1;
  }
  if (readMarker(root) !== BUILD_ID) {
    writeAtomically(
      path.join(root, MARKER),
      `${JSON.stringify({ buildId: BUILD_ID })}\n`,
      0o600,
    );
    written += 1;
  }
  return written;
}

/** A child started by our own code names a role entry under a root of this build. */
function matchRole(argument) {
  if (typeof argument !== "string" || !path.isAbsolute(argument)) return;
  for (const relative of ROLES.keys()) {
    const suffix = path.join(...relative.split("/"));
    if (!argument.endsWith(path.sep + suffix)) continue;
    const root = argument.slice(0, argument.length - suffix.length - 1);
    if (readMarker(root) === BUILD_ID) return { root, relative };
  }
  return undefined;
}

async function runRole(root, relative, args) {
  globalThis.__harnesshubSeaModuleUrl = (moduleRelative) =>
    pathToFileURL(under(root, moduleRelative)).href;
  // Role modules read their arguments as `node <entry> ...args` would see them.
  process.argv = [process.execPath, under(root, relative), ...args];
  await ROLES.get(relative)();
}

function runAsNode(script, args) {
  process.argv = [process.execPath, path.resolve(script), ...args];
  Module.runMain();
}

async function main() {
  if (!isSea()) throw new Error("This script runs only as the SEA main");
  // In a SEA, argv[1] repeats argv[0]; the caller's arguments start at argv[2].
  const [command, ...rest] = process.argv.slice(2);
  const role = matchRole(command);
  if (role) return runRole(role.root, role.relative, rest);
  if (
    command &&
    /\.[cm]?js$/i.test(command) &&
    statSync(command, { throwIfNoEntry: false })?.isFile()
  )
    return runAsNode(command, rest);
  switch (command) {
    case "serve":
    case "version":
    case "--version": {
      const root = defaultRoot();
      const started = performance.now();
      const written = ensureRoot(root);
      if (process.env.HARNESSHUB_SEA_TRACE === "1")
        process.stderr.write(
          `${JSON.stringify({ event: "sea.root", root, written, ms: Math.round(performance.now() - started) })}\n`,
        );
      return runRole(
        root,
        "dist/src/main.js",
        command === "serve" ? rest : ["--version", ...rest],
      );
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

// A rejection ends the process with exit code 1, like a failed `node <entry>`.
void main();
