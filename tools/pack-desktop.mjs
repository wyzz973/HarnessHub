#!/usr/bin/env node
// Builds HarnessHub.app (macOS, this machine's architecture) from what `pnpm build` and `pnpm web:build` left: the Gateway, the page and the desktop
// shell, with only the packages the built Gateway imports, inside Electron's bundle. Usage: node tools/pack-desktop.mjs [--out <dir>]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packager } from "@electron/packager";
import { importedPackages } from "./desktop-imports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { out: { type: "string" } } });
const out = resolve(values.out ?? join(root, "dist-desktop")), stage = join(root, ".tmp", "desktop-stage");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const electron = JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")).version;

rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
for (const path of ["dist/src", "dist/desktop", "web/dist", "LICENSE"]) cpSync(join(root, path), join(stage, path), { recursive: true });

// The packages the built Gateway and shell import by name; the page's own are already inside its bundle.
const named = importedPackages([join(stage, "dist", "src"), join(stage, "dist", "desktop")]);
const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => named.has(name)));
const missing = [...named].filter(name => !(name in dependencies));
if (missing.length) { console.error("pack-desktop: imported but not a dependency: " + missing.join(", ")); process.exit(1); }
writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "harnesshub", productName: "HarnessHub", version: "0.1.0", private: true, type: "module", main: "dist/desktop/main.js", dependencies, pnpm: pkg.pnpm }, null, 2));
writeFileSync(join(stage, ".npmrc"), "node-linker=hoisted\n");
cpSync(join(root, "pnpm-lock.yaml"), join(stage, "pnpm-lock.yaml"));
execFileSync("pnpm", ["install", "--prod", "--no-frozen-lockfile", "--prefer-offline", "--ignore-scripts"], { cwd: stage, stdio: "inherit" });

const [app] = await packager({ dir: stage, name: "HarnessHub", platform: "darwin", arch: process.arch, electronVersion: electron, out, overwrite: true, prune: false, asar: false,
  icon: join(root, "desktop", "icon.icns"), appBundleId: "dev.harnesshub.desktop", appVersion: "0.1.0", appCategoryType: "public.app-category.developer-tools",
  extendInfo: { CFBundleDisplayName: "HarnessHub", LSMinimumSystemVersion: "13.0", NSHumanReadableCopyright: "HarnessHub (MIT)" }, ignore: [/^\/pnpm-lock\.yaml$/u, /^\/\.npmrc$/u] });
// A bundle changed after Electron's own signature needs one of this machine's to start on Apple silicon.
const bundle = join(app, "HarnessHub.app");
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
console.log("pack-desktop: " + bundle + " · " + Object.keys(dependencies).length + " packages");
