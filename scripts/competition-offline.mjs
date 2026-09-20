#!/usr/bin/env node
/**
 * Offline competition setup for the Windows x64 offline development kit built by
 * scripts/build-offline-source-kit.ps1. The kit root contains:
 *
 *   HarnessHub/               editable source with node_modules (pnpm hoisted, copy import)
 *   tools/node/node.exe       Node 24.20.0 x64 (runs this script)
 *   tools/pnpm-runner/        pnpm 10.12.3
 *   pnpm-store/               offline pnpm store for HarnessHub dependencies
 *   prepared/win32-x64/       fixed engine payload (open-source edition, prepared.json)
 *
 * The judge machine has no Node, pnpm or Git on PATH, so setup writes tools/shims/pnpm.cmd
 * and puts it first on every child PATH: a nested `pnpm` inside a package script (for
 * example `build:console`) runs the kit's pnpm with the kit's Node.
 *
 * `setup` never downloads. Every child process gets npm/pnpm offline mode, an unreachable
 * registry and proxy (127.0.0.1:9) and Corepack network disabled, so an accidental
 * download fails instead of silently succeeding. Steps: verify the kit -> restore
 * dependencies offline when they are missing (or with --reinstall) -> clean build of the
 * Gateway and console -> scripts/package-bundle.mjs --runtime-only with the local prepared
 * payload -> scripts/build-competition-full-bundle.mjs -> scripts/competition-selftest.mjs
 * (no model) -> publish as <kit>/competition. An existing layout is renamed to
 * competition.previous-<time>, never deleted. A failed staging directory is removed unless
 * --keep-failed is given.
 *
 * Usage:
 *   node HarnessHub/scripts/competition-offline.mjs setup [--kit DIR] [--reinstall]
 *        [--selftest-engine opencode] [--skip-selftest] [--keep-failed]
 *   node HarnessHub/scripts/competition-offline.mjs engines --bundle DIR
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const OFFLINE_BLACKHOLE = "http://127.0.0.1:9";
const nodeVersion = "24.20.0";
const pnpmVersion = "10.12.3";

/** Absolute paths of a kit rooted at `kit`. */
export function kitLayout(kit) {
  const root = path.resolve(kit);
  const repository = path.join(root, "HarnessHub");
  return {
    root,
    repository,
    node: path.join(root, "tools", "node", "node.exe"),
    pnpm: path.join(
      root,
      "tools",
      "pnpm-runner",
      "node_modules",
      "pnpm",
      "bin",
      "pnpm.cjs",
    ),
    shims: path.join(root, "tools", "shims"),
    store: path.join(root, "pnpm-store"),
    prepared: path.join(root, "prepared", "win32-x64"),
    competition: path.join(root, "competition"),
    logs: path.join(root, "logs"),
    lock: path.join(root, ".competition-setup.lock"),
  };
}

function setVariable(env, name, value) {
  for (const key of Object.keys(env))
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

/**
 * Child environment for offline setup: package managers cannot reach a registry, the
 * kit's pnpm shim and Node come first on PATH and personal npm/pnpm configuration is
 * ignored. The shim itself is written by {@link writeToolShims}.
 */
export function offlineEnvironment(base, layout, platform = process.platform) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (/^(npm_config_|pnpm_config_|COREPACK_)/i.test(key)) delete env[key];
  const settings = {
    npm_config_offline: "true",
    npm_config_prefer_offline: "true",
    npm_config_registry: `${OFFLINE_BLACKHOLE}/`,
    npm_config_proxy: OFFLINE_BLACKHOLE,
    npm_config_https_proxy: OFFLINE_BLACKHOLE,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(layout.root, "logs", "npmrc.offline"),
    HTTP_PROXY: OFFLINE_BLACKHOLE,
    HTTPS_PROXY: OFFLINE_BLACKHOLE,
    ALL_PROXY: OFFLINE_BLACKHOLE,
    NO_PROXY: "127.0.0.1,localhost,::1",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    PIP_NO_INDEX: "1",
  };
  for (const [name, value] of Object.entries(settings))
    setVariable(env, name, value);
  const windows = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  setVariable(
    env,
    "PATH",
    platform === "win32"
      ? [
          layout.shims,
          path.dirname(layout.node),
          path.join(windows, "System32"),
          windows,
          path.join(windows, "System32", "Wbem"),
          path.join(windows, "System32", "WindowsPowerShell", "v1.0"),
        ].join(";")
      : [layout.shims, path.dirname(layout.node), "/usr/bin", "/bin"].join(":"),
  );
  return env;
}

/**
 * Write the `pnpm` command shim that package scripts resolve through PATH. It runs the
 * kit's pnpm with the kit's Node, uses paths relative to itself (a moved kit keeps
 * working) and passes the exit code through. Existing shims are replaced.
 *
 * @returns {Promise<string>} The shim directory, which {@link offlineEnvironment} puts first on PATH.
 */
export async function writeToolShims(layout, platform = process.platform) {
  await mkdir(layout.shims, { recursive: true });
  const node = path.relative(layout.shims, layout.node);
  const pnpm = path.relative(layout.shims, layout.pnpm);
  if (platform === "win32") {
    const windows = (value) => value.replaceAll("/", "\\");
    await writeFile(
      path.join(layout.shims, "pnpm.cmd"),
      `@echo off\r\n"%~dp0${windows(node)}" "%~dp0${windows(pnpm)}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
  } else {
    const file = path.join(layout.shims, "pnpm");
    await writeFile(
      file,
      `#!/bin/sh\nshims=$(dirname "$0")\nexec "$shims/${node}" "$shims/${pnpm}" "$@"\n`,
    );
    await chmod(file, 0o755);
  }
  return layout.shims;
}

/** Ordered child commands of `setup` (dependency restore is included only when needed). */
export function setupPlan(layout, staging, { install }) {
  const repository = layout.repository;
  const steps = [];
  if (install)
    steps.push({
      id: "dependencies",
      command: layout.node,
      args: [
        layout.pnpm,
        "install",
        "--offline",
        "--frozen-lockfile",
        "--store-dir",
        layout.store,
        "--config.node-linker=hoisted",
        "--package-import-method=copy",
        "--config.confirm-modules-purge=false",
      ],
      cwd: repository,
    });
  steps.push(
    {
      id: "build",
      command: layout.node,
      args: [layout.pnpm, "build"],
      cwd: repository,
    },
    {
      id: "build-console",
      command: layout.node,
      args: [layout.pnpm, "build:console"],
      cwd: repository,
    },
    {
      id: "package",
      command: layout.node,
      args: [
        path.join(repository, "scripts", "package-bundle.mjs"),
        "--prepared",
        layout.prepared,
        "--output",
        staging,
        "--runtime-only",
      ],
      cwd: repository,
    },
    {
      id: "overlay",
      command: layout.node,
      args: [
        path.join(repository, "scripts", "build-competition-full-bundle.mjs"),
        "--bundle",
        staging,
      ],
      cwd: repository,
    },
  );
  return steps;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
}

/** Verify the kit before anything is written. Returns the prepared engine ids. */
export async function verifyKit(layout, host = process) {
  if (
    host.platform !== "win32" ||
    host.arch !== "x64" ||
    host.versions.node !== nodeVersion
  )
    throw new Error(
      `Run Setup-Competition-Offline.cmd on Windows x64; it uses tools\\node\\node.exe (Node ${nodeVersion}). Current: ${host.platform}/${host.arch} Node ${host.versions.node}`,
    );
  for (const [label, file] of [
    ["HarnessHub source", path.join(layout.repository, "package.json")],
    ["HarnessHub lockfile", path.join(layout.repository, "pnpm-lock.yaml")],
    ["bundled Node", layout.node],
    ["bundled pnpm", layout.pnpm],
    ["offline pnpm store", layout.store],
    ["prepared engine catalog", path.join(layout.prepared, "prepared.json")],
    ["prepared runtime", path.join(layout.prepared, "runtime", "node.exe")],
  ])
    if (!(await exists(file)))
      throw new Error(`Offline kit is incomplete: missing ${label} (${file})`);
  const catalog = await readJson(path.join(layout.prepared, "prepared.json"));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.platform !== "win32" ||
    catalog.arch !== "x64" ||
    catalog.nodeVersion !== nodeVersion ||
    !Array.isArray(catalog.engines) ||
    catalog.engines.length === 0
  )
    throw new Error(
      "prepared/win32-x64/prepared.json is not a Windows x64 Node 24.20.0 engine catalog",
    );
  const missing = [];
  for (const engine of catalog.engines)
    for (const relative of engine.requiredFiles ?? []) {
      if (typeof relative !== "string" || relative.startsWith("scripts/"))
        continue;
      if (!(await exists(path.join(layout.prepared, relative))))
        missing.push(`${engine.id}: ${relative}`);
    }
  if (missing.length)
    throw new Error(
      `Prepared engine files are missing (antivirus quarantine or incomplete extraction?): ${missing.slice(0, 8).join(", ")}`,
    );
  return catalog.engines.map((engine) => engine.id);
}

/** True when the shipped node_modules can build without a restore. */
export async function dependenciesPresent(repository) {
  for (const relative of [
    "node_modules/.modules.yaml",
    "node_modules/typescript/package.json",
    "node_modules/fastify/package.json",
    "node_modules/next/package.json",
    "node_modules/react/package.json",
  ])
    if (!(await exists(path.join(repository, relative)))) return false;
  return true;
}

async function retry(action, attempts = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (
        attempt >= attempts ||
        !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)
      )
        throw error;
      await delay(1000);
    }
  }
}

async function acquireLock(lock) {
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try {
      owner = await readJson(path.join(lock, "owner.json"));
    } catch {
      owner = undefined;
    }
    let alive = false;
    if (Number.isInteger(owner?.pid))
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (probe) {
        alive = probe.code === "EPERM";
      }
    if (alive)
      throw new Error(
        `Another setup is running (pid ${owner.pid}); wait for it to finish`,
      );
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  await writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    { flag: "wx" },
  );
  return async () => {
    await unlink(path.join(lock, "owner.json")).catch(() => undefined);
    await rmdir(lock).catch(() => undefined);
  };
}

/**
 * Run one setup step with `env`, mirroring its output to stdout and `log`. Rejects with
 * the step id and the last output lines when the command cannot start or exits non-zero.
 */
export function runStep(step, env, log) {
  return new Promise((resolve, reject) => {
    log.write(
      `\n=== ${step.id}: ${path.basename(step.command)} ${step.args.map((arg) => path.basename(arg)).join(" ")}\n`,
    );
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        process.stdout.write(chunk);
        log.write(chunk);
        tail = (tail + chunk).slice(-4000);
      });
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          Object.assign(
            new Error(
              `${step.id} failed with exit code ${code}: ${tail.trim().split(/\r?\n/).slice(-5).join(" / ")}`,
            ),
            {
              step: step.id,
            },
          ),
        );
    });
  });
}

/**
 * Build <kit>/competition offline.
 *
 * @param {{kit?: string, reinstall?: boolean, selftestEngine?: string, skipSelftest?: boolean,
 *   keepFailed?: boolean}} options
 * @returns {Promise<object>} Summary also printed as a `competition.setup.completed` line.
 */
export async function runSetup(options = {}) {
  const started = Date.now();
  const layout = kitLayout(
    options.kit ?? path.resolve(scriptDirectory, "..", ".."),
  );
  const engines = await verifyKit(layout);
  const selftestEngine =
    options.selftestEngine ??
    (engines.includes("opencode") ? "opencode" : engines[0]);
  if (!engines.includes(selftestEngine))
    throw new Error(
      `--selftest-engine ${selftestEngine} is not in the prepared catalog`,
    );
  const disk = await statfs(layout.root);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  if (freeBytes < 4 * 1024 ** 3)
    throw new Error(
      `At least 4 GiB free disk space is required next to the kit; ${(freeBytes / 1024 ** 3).toFixed(1)} GiB available`,
    );
  await mkdir(layout.logs, { recursive: true });
  const logFile = path.join(
    layout.logs,
    `setup-competition-${timestamp()}.log`,
  );
  const log = createWriteStream(logFile, { flags: "wx" });
  const env = offlineEnvironment(process.env, layout);
  await writeFile(env.npm_config_userconfig, "offline=true\n");
  await writeToolShims(layout);
  const release = await acquireLock(layout.lock);
  const staging = path.join(
    layout.root,
    `competition.staging-${timestamp()}-${randomBytes(3).toString("hex")}`,
  );
  let current = "verify";
  let completed = false;
  try {
    const version = await new Promise((resolve, reject) => {
      const child = spawn(layout.node, [layout.pnpm, "--version"], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve(output.trim())
          : reject(new Error(`pnpm --version exited ${code}`)),
      );
    });
    if (version !== pnpmVersion)
      throw new Error(`Bundled pnpm must be ${pnpmVersion}; found ${version}`);
    let install =
      options.reinstall === true ||
      !(await dependenciesPresent(layout.repository));
    if (options.reinstall)
      for (const directory of [
        "node_modules",
        path.join("web", "node_modules"),
      ])
        await retry(() =>
          rm(path.join(layout.repository, directory), {
            recursive: true,
            force: true,
          }),
        );
    for (const directory of ["dist", path.join("web", ".next")])
      await retry(() =>
        rm(path.join(layout.repository, directory), {
          recursive: true,
          force: true,
        }),
      );
    log.write(
      `kit=${layout.root}\ninstall=${install}\nselftestEngine=${selftestEngine}\n`,
    );
    console.log(`[HarnessHub] Offline setup started. Log: ${logFile}`);
    console.log(
      `[HarnessHub] Dependencies: ${install ? "restoring offline from pnpm-store" : "using the included node_modules"}`,
    );
    for (const step of setupPlan(layout, staging, { install })) {
      current = step.id;
      console.log(`[HarnessHub] Step ${step.id} ...`);
      await runStep(step, env, log);
    }
    let selftest = { status: "SKIPPED" };
    if (!options.skipSelftest) {
      current = "selftest";
      console.log(
        `[HarnessHub] Step selftest (engine ${selftestEngine}, no model call) ...`,
      );
      const { runSelfTest } = await import("./competition-selftest.mjs");
      selftest = await runSelfTest({
        bundle: staging,
        engine: selftestEngine,
        env,
        logFile: path.join(layout.logs, `selftest-${timestamp()}.log`),
      });
      log.write(`\n=== selftest\n${JSON.stringify(selftest, null, 2)}\n`);
      if (selftest.status !== "PASS")
        throw new Error(
          `Startup self-test failed: ${selftest.checks
            .filter((check) => check.status !== "PASS")
            .map((check) => `${check.name}: ${check.error}`)
            .join("; ")}`,
        );
      await retry(() =>
        rm(path.join(staging, "state"), { recursive: true, force: true }),
      );
    }
    current = "publish";
    let previous;
    if (await exists(layout.competition)) {
      previous = `${layout.competition}.previous-${timestamp()}`;
      try {
        await retry(() => rename(layout.competition, previous));
      } catch (error) {
        throw new Error(
          `Cannot move the existing competition directory (${error.code}); stop any running Start-Competition.cmd window and retry`,
        );
      }
    }
    await retry(() => rename(staging, layout.competition));
    completed = true;
    const summary = {
      event: "competition.setup.completed",
      layout: layout.competition,
      launcher: path.join(layout.root, "Start-Competition.cmd"),
      engines,
      dependencies: install ? "restored offline" : "included node_modules",
      selftest: selftest.status,
      previousLayout: previous ?? null,
      durationMs: Date.now() - started,
      log: logFile,
      downloads: false,
      modelCalled: false,
    };
    log.write(`\n${JSON.stringify(summary)}\n`);
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.write(`\nFAILED at ${current}: ${message}\n`);
    throw Object.assign(new Error(message), { step: current, log: logFile });
  } finally {
    if (!completed && !options.keepFailed && (await exists(staging)))
      await retry(() => rm(staging, { recursive: true, force: true })).catch(
        () => undefined,
      );
    await new Promise((resolve) => log.end(resolve));
    await release();
  }
}

/** Engine ids of a competition layout, as recorded in its bundle.json. */
export async function listEngines(bundle) {
  const manifest = await readJson(
    path.join(path.resolve(bundle), "bundle.json"),
  );
  if (!Array.isArray(manifest.engines))
    throw new Error("bundle.json has no engine list");
  return manifest.engines.map((engine) => ({
    id: engine.id,
    name: engine.name ?? engine.id,
    version: engine.version ?? "",
  }));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv[2];
  try {
    if (command === "setup") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          kit: { type: "string" },
          reinstall: { type: "boolean", default: false },
          "selftest-engine": { type: "string" },
          "skip-selftest": { type: "boolean", default: false },
          "keep-failed": { type: "boolean", default: false },
        },
        strict: true,
      });
      const summary = await runSetup({
        reinstall: values.reinstall,
        skipSelftest: values["skip-selftest"],
        keepFailed: values["keep-failed"],
        ...(values.kit ? { kit: values.kit } : {}),
        ...(values["selftest-engine"]
          ? { selftestEngine: values["selftest-engine"] }
          : {}),
      });
      console.log(`[HarnessHub] Competition layout ready: ${summary.layout}`);
      console.log(
        "[HarnessHub] Next: set HARNESSHUB_MODEL* and AGENT_ENGINE, then run Start-Competition.cmd (see INSTRUCTION.md).",
      );
      console.log(JSON.stringify(summary));
    } else if (command === "engines") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: { bundle: { type: "string" } },
        strict: true,
      });
      if (!values.bundle) throw new Error("engines requires --bundle DIR");
      const engines = await listEngines(values.bundle);
      console.log("Available AGENT_ENGINE values:");
      for (const engine of engines)
        console.log(
          `  ${engine.id.padEnd(10)} ${engine.name} ${engine.version}`.trimEnd(),
        );
    } else {
      console.error(
        "Usage: competition-offline.mjs setup [--kit DIR] [--reinstall] [--selftest-engine ID] [--skip-selftest] [--keep-failed]\n       competition-offline.mjs engines --bundle DIR",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(
      `[HarnessHub] ${command ?? "command"} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      JSON.stringify({
        event: `competition.${command ?? "command"}.failed`,
        step: error?.step ?? null,
        error: error instanceof Error ? error.message : String(error),
        log: error?.log ?? null,
      }),
    );
    process.exitCode = 1;
  }
}
