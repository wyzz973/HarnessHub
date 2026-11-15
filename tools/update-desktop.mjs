#!/usr/bin/env node
// Puts this checkout's build into an installed HarnessHub.app without changing what the system knows the app by. Only the app's own files under
// Contents/Resources/app are replaced (the Gateway, the shell's scripts and native module, the page); the executable, Info.plist and the
// signature stay as they are, so the folders the user has allowed the app to read stay allowed (a bundle packed and signed afresh is asked
// about again). Run after `pnpm build`, `node tools/build-native.mjs` and `pnpm web:build`, with the app not running.
// Usage: node tools/update-desktop.mjs [/Applications/HarnessHub.app]
import { cpSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importedPackages } from "./desktop-imports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(process.argv[2] ?? "/Applications/HarnessHub.app"), inside = join(app, "Contents", "Resources", "app");
const fail = message => { console.error("update-desktop: " + message); process.exit(1); };
if (!existsSync(join(inside, "package.json"))) fail("no HarnessHub.app at " + app);
let running = "";
try { running = execFileSync("/usr/bin/pgrep", ["-f", join(app, "Contents", "MacOS") + "/"], { encoding: "utf8" }).trim(); } catch { /* none */ }
if (running) fail("the app is running (pid " + running.split("\n").join(", ") + "): quit it first");
const parts = ["dist/src", "dist/desktop", "web/dist"];
for (const part of parts) if (!existsSync(join(root, part))) fail("not built: " + part);
if (!existsSync(join(root, "dist", "desktop", "native", "glass.node"))) fail("not built: dist/desktop/native/glass.node (node tools/build-native.mjs)");
// A package the new build imports and the bundle does not hold needs a full pack.
const absent = [...importedPackages([join(root, "dist", "src"), join(root, "dist", "desktop")])].filter(name => !existsSync(join(inside, "node_modules", name)));
if (absent.length) fail("the installed app has no " + absent.join(", ") + ": pack it afresh (pnpm desktop:pack)");
for (const part of parts) { rmSync(join(inside, part), { recursive: true, force: true }); cpSync(join(root, part), join(inside, part), { recursive: true }); }
console.log("update-desktop: " + app + " now holds this build (" + parts.join(", ") + ")");
