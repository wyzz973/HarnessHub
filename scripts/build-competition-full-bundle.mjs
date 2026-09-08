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

  await writeFile(
    path.join(root, "Start-Competition.cmd"),
    '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\src\\competition-bundle-main.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
  );
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
      "2. Start the competition Gateway on the required port:",
      "   Start-Competition.cmd --engine opencode",
      "   Start-Competition.cmd --engine codex",
      "   Start-Competition.cmd --engine qwen",
      "",
      "Optional:",
      "   --port 6217 --host localhost",
      "",
      "The competition HTTP API is exposed by the same HarnessHub Runtime/Worker/EngineConfiguration chain.",
      "Tool Packages, Skills, MCP and managed CLI capabilities remain revision-pinned and apply to new sessions.",
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
