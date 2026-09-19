#!/usr/bin/env node

import { rm, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { copyTree, inventory } from "./lib/bundle-copy.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

export async function buildCompetitionFullBundle(bundleDirectory) {
  const root = path.resolve(bundleDirectory);
  const bundleFile = path.join(root, "bundle.json");
  const manifest = JSON.parse(await readFile(bundleFile, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== "win32" ||
    !["arm64", "x64"].includes(manifest.arch) ||
    manifest.nodeVersion !== "24.20.0"
  )
    throw new Error("Unsupported HarnessHub portable bundle");

  const compiled = path.join(
    repository,
    "dist",
    "src",
    "competition-bundle-main.js",
  );
  if (!(await lstat(compiled)).isFile())
    throw new Error("Run pnpm build before creating a Competition Full Bundle");

  const target = path.join(root, "dist", "src");
  await rm(target, { recursive: true, force: true });
  await copyTree(path.join(repository, "dist", "src"), target, {
    allowedRoots: [repository],
    filter: (_relative, name) =>
      !path.extname(name) || name.endsWith(".js") || name.endsWith(".json"),
  });

  // Ship the repository's self-contained Capability Pack examples so the
  // one-click installer can be exercised without downloading any dependency.
  const toolPacks = path.join(root, "tool-packs");
  await rm(toolPacks, { recursive: true, force: true });
  await copyTree(
    path.join(repository, "examples", "tool-packages"),
    toolPacks,
    {
      allowedRoots: [repository],
    },
  );

  const fullAccessLauncher =
    '@echo off\r\nsetlocal\r\nset "HARNESSHUB_FULL_ACCESS=1"\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\competition-bundle-main.js" %*\r\nexit /b %ERRORLEVEL%\r\n';
  const safeLauncher =
    '@echo off\r\nsetlocal\r\nset "HARNESSHUB_FULL_ACCESS="\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\competition-bundle-main.js" --safe-permissions %*\r\nexit /b %ERRORLEVEL%\r\n';
  const toolPackLauncher =
    '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\tool-packages-oneclick-main.js" %*\r\nexit /b %ERRORLEVEL%\r\n';
  const collectLogsLauncher =
    '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\collect-logs-main.js" --root "%~dp0state" %*\r\nexit /b %ERRORLEVEL%\r\n';
  await writeFile(path.join(root, "Start-Competition.cmd"), fullAccessLauncher);
  await writeFile(path.join(root, "gateway.cmd"), fullAccessLauncher);
  await writeFile(path.join(root, "gateway-safe.cmd"), safeLauncher);
  await writeFile(path.join(root, "Install-Tool-Pack.cmd"), toolPackLauncher);
  await writeFile(path.join(root, "Collect-Logs.cmd"), collectLogsLauncher);
  await writeFile(
    path.join(root, "README-COMPETITION.txt"),
    [
      "HarnessHub Competition Full Bundle",
      "",
      "Portable HarnessHub runtime plus bundled Agent engines. No Node, pnpm, npm, pip, Git",
      "or engine installation is needed and nothing is downloaded at runtime.",
      "",
      "1. Unified model (PowerShell). Every engine uses only this model through HarnessHub;",
      "   engine-specific API keys, logins and subscriptions are not used:",
      '   $env:HARNESSHUB_MODEL = "<upstream model id>"',
      '   $env:HARNESSHUB_MODEL_BASE_URL = "https://<model gateway>/v1"   (required with HARNESSHUB_MODEL)',
      '   $env:HARNESSHUB_MODEL_API_KEY = "<key value>"',
      "   Optional: HARNESSHUB_MODEL_PROTOCOL (default openai-completions),",
      "   HARNESSHUB_MODEL_CONTEXT_WINDOW, HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS (positive integers).",
      "   Persistent alternative: hub.cmd model set --model ID --base-url URL --api-key-env NAME",
      "",
      "2. Select the engine with AGENT_ENGINE and start. Keep this window open; Ctrl+C stops it:",
      '   $env:AGENT_ENGINE = "opencode"',
      "   .\\gateway.cmd",
      "   Engines: codex, gemini, qwen, pi, mimo, dsh, openclaw, kimi, opencode, hermes.",
      "   Options: --port 6217 --host localhost --console-port 3330 --no-console --open",
      "   (--engine <id> overrides AGENT_ENGINE). The default binding accepts local clients only;",
      "   for a judge on another machine or container use --host 0.0.0.0. That binding has no",
      "   authentication: use it only on an isolated evaluation network.",
      "   gateway.cmd and Start-Competition.cmd enable Full Access (HARNESSHUB_FULL_ACCESS=1:",
      "   tool/permission requests are approved automatically); gateway-safe.cmd keeps normal",
      "   permission prompts and denials.",
      "",
      '3. Ready: stdout prints {"event":"competition.ready",...} and',
      '   GET http://127.0.0.1:6217/health/ready returns 200 {"ready":true}.',
      "   The console starts on http://127.0.0.1:3330 (a busy port falls back to a free one;",
      "   see consoleUrl in the ready line or GET /v1/runtime/info). http://localhost:6217/",
      "   redirects to it. The competition API only needs port 6217; the console never blocks",
      "   or stops the Gateway.",
      "",
      "4. Competition API v1.1: POST /session, POST /session/{id}/prompt_async (blocks until the",
      "   turn ends: 204, or 502 with {code,message}), GET /session/{id}/message, GET /event,",
      "   POST /session/{id}/abort, DELETE /session/{id}.",
      "   Each turn may run up to 1 hour, then ends with RUN_TIMED_OUT (502). To change it, set",
      '   $env:HARNESSHUB_RUN_TIMEOUT_MS = "<milliseconds, 1-86400000>" before starting.',
      "",
      "5. Optional Tool Pack for every engine (restart the Gateway afterwards):",
      "   .\\Install-Tool-Pack.cmd --source <directory, mcp.json or cli.json> --engines all",
      '   While running: POST /v1/tool-packs/import {"source":"<path>","applyTo":"all"}',
      "   Examples are under .\\tool-packs\\. MCP servers and CLI tools run in each Session's",
      "   own directory.",
      "",
      "6. Diagnostic logs (JSON Lines, secrets redacted, rotated at 16 MiB):",
      "   state\\competition-data\\logs\\gateway.log  - HTTP access, Session/Run lifecycle, Workers,",
      "     permissions and one line per model call; lifecycle lines are also printed here.",
      "   state\\competition-data\\backends\\<sessionId>\\diagnostics\\engine.log  - engine process,",
      "     stderr, every ACP request/response, tool calls and model calls of that Session.",
      '   $env:HARNESSHUB_LOG_LEVEL = "debug" adds 2 KiB payload excerpts (prompt text included).',
      "   .\\Collect-Logs.cmd packs all of them plus engine-native *.log tails into logs-<time>.zip.",
      "",
      "Runs, settings and evidence live under state\\ (state\\competition-data\\harnesshub.sqlite).",
      "Use a fresh extraction for a clean evaluation.",
      "",
    ].join("\r\n"),
  );

  const files = await inventory(root, manifest.arch, [repository]);
  manifest.files = files;
  await writeFile(bundleFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    root,
    platform: manifest.platform,
    arch: manifest.arch,
    engines: manifest.engines?.map((engine) => engine.id) ?? [],
    files: files.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: { bundle: { type: "string" } },
    });
    if (!values.bundle)
      throw new Error(
        "Usage: node scripts/build-competition-full-bundle.mjs --bundle DIRECTORY",
      );
    console.log(
      JSON.stringify(await buildCompetitionFullBundle(values.bundle)),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
