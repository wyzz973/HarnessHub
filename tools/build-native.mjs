#!/usr/bin/env node
// Builds the desktop shell's one native module (the system's Liquid Glass behind the page) into dist/desktop/native. macOS only; needs the
// Xcode command line tools. Node-API is the same in every runtime, so the module built against this Node's header loads in Electron.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") { console.log("build-native: skipped (macOS only)"); process.exit(0); }
const include = join(dirname(process.execPath), "..", "include", "node");
if (!existsSync(join(include, "node_api.h"))) { console.error("build-native: node_api.h not found beside this Node (" + include + ")"); process.exit(1); }
const out = join(root, "dist", "desktop", "native");
mkdirSync(out, { recursive: true });
execFileSync("clang++", ["-std=c++17", "-fobjc-arc", "-O2", "-shared", "-undefined", "dynamic_lookup", "-mmacosx-version-min=13.0", "-DNODE_GYP_MODULE_NAME=glass",
  "-I", include, "-framework", "AppKit", "-framework", "QuartzCore", "-o", join(out, "glass.node"), join(root, "desktop", "native", "glass.mm")], { stdio: "inherit" });
console.log("build-native: dist/desktop/native/glass.node");
