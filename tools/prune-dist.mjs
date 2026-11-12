// Removes from dist/src and dist/tests the compiled files whose source is gone. `tsc` writes what it compiles and never deletes what it compiled
// before, so a test or a module that was removed from the sources stays in dist: `node --test dist/tests/*/*.test.js` then runs the removed test
// against the current build and fails, and a removed module can still be imported by its old path. Run after `tsc` by `pnpm build`.
//
// It touches nothing but dist/src and dist/tests, and there only a `.js` with no `.ts` (`.tsx`, `.mts`) of its name in the sources and a `.json`
// (copied by `resolveJsonModule`) with no source of its name; a directory left empty goes with them.
import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const removed = [];

function hasSource(compiled) {
  const path = join(root, relative(join(root, "dist"), compiled));
  if (compiled.endsWith(".json")) return existsSync(path);
  const stem = path.slice(0, -".js".length);
  return [".ts", ".tsx", ".mts"].some(extension => existsSync(stem + extension));
}
function prune(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { prune(path); if (readdirSync(path).length === 0) rmdirSync(path); continue; }
    if (!entry.isFile() || !(entry.name.endsWith(".js") || entry.name.endsWith(".json"))) continue;
    if (!hasSource(path)) { rmSync(path); removed.push(relative(root, path)); }
  }
}
for (const part of ["src", "tests"]) { const directory = join(root, "dist", part); if (existsSync(directory)) prune(directory); }
if (removed.length > 0) process.stdout.write("pruned " + removed.length + " compiled file(s) whose source is gone: " + removed.join(", ") + "\n");
