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
  await copyTree(path.join(repository, "examples", "tool-packages"), toolPacks, {
    allowedRoots: [repository],
  });

  const fullAccessLauncher =
    '@echo off\r\nsetlocal\r\nset "HARNESSHUB_FULL_ACCESS=1"\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\competition-bundle-main.js" %*\r\nexit /b %ERRORLEVEL%\r\n';
  const safeLauncher =
    '@echo off\r\nsetlocal\r\nset "HARNESSHUB_FULL_ACCESS="\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\competition-bundle-main.js" --safe-permissions %*\r\nexit /b %ERRORLEVEL%\r\n';
  const toolPackLauncher =
    '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\tool-packages-oneclick-main.js" %*\r\nexit /b %ERRORLEVEL%\r\n';
  await writeFile(path.join(root, "Start-Competition.cmd"), fullAccessLauncher);
  await writeFile(path.join(root, "gateway.cmd"), fullAccessLauncher);
  await writeFile(path.join(root, "gateway-safe.cmd"), safeLauncher);
  await writeFile(path.join(root, "Install-Tool-Pack.cmd"), toolPackLauncher);
  await writeFile(
    path.join(root, "README-COMPETITION.txt"),
    [
      "HarnessHub Competition Full Bundle",
      "",
      "This directory contains the portable HarnessHub runtime plus bundled Agent engines.",
      "No Node, pnpm, npm, pip or engine installation is required on the target machine.",
      "",
      "1. Configure the bundled model/provider once:",
      "   hub.cmd configure --file <absolute-settings-json>",
      "",
      "2. Optional: install one Capability Pack (Skill + MCP + CLI) across engines:",
      "   Install-Tool-Pack.cmd --source <tool-pack-directory> --engines all --workspace <project-directory>",
      "   Add --bindings <json-file> when the pack declares secret binding slots.",
      "   Built-in examples are under .\\tool-packs\\",
      "",
      "3. Start the competition Gateway. gateway.cmd and Start-Competition.cmd enable Full Access:",
      "   gateway.cmd --engine opencode",
      "   gateway.cmd --engine codex",
      "   gateway.cmd --engine qwen",
      "",
      "   Full Access sets HARNESSHUB_FULL_ACCESS=1, auto-approves ACP writes/shell requests,",
      "   and maps supported harnesses to their native YOLO/full-access mode.",
      "   Use gateway-safe.cmd --engine <id> to retain normal permission prompts/denials.",
      "",
      "Optional Gateway arguments: --port 6217 --host localhost",
      "",
      "The competition HTTP API is exposed by the same HarnessHub Runtime/Worker/EngineConfiguration chain.",
      "Capability Pack installation verifies file hashes and preflights every selected Engine independently;",
      "incompatible Engines are reported as skipped without preventing compatible Engines from being configured.",
      "New Sessions use the saved Skill/MCP/CLI configuration; existing Sessions keep their pinned revision.",
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { bundle: { type: "string" } },
    });
    if (!values.bundle)
      throw new Error(
        "Usage: node scripts/build-competition-full-bundle.mjs --bundle DIRECTORY",
      );
    console.log(JSON.stringify(await buildCompetitionFullBundle(values.bundle)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
