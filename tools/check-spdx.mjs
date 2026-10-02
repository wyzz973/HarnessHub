#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Check that every source file starts with an SPDX license identifier.
 * Usage: node tools/check-spdx.mjs [--root <directory>]
 *
 * Scans SOURCE_ROOTS below for SOURCE_EXTENSIONS, skipping generated and
 * dependency directories and tool package payloads, whose bytes their manifests
 * pin. The first line, or the second after a `#!` shebang, must be
 * `// SPDX-License-Identifier: <id>`. Project code uses MIT; files that keep a
 * third-party license are listed in THIRD_PARTY_LICENSES and must carry exactly
 * that identifier. Exits non-zero when any file fails or none is found.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOTS = ["src", "packages", "apps", "tests", "tools", "scripts", "examples", "web/app", "web/components", "web/lib"];
const ROOT_FILES = ["eslint.config.mjs", "web/next.config.ts", "web/postcss.config.mjs"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".cs", ".swift"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".next", "out", "coverage"]);
/** Tool package payloads: their bytes are pinned by size and SHA-256 in each package manifest. */
const PAYLOAD_DIRECTORIES = ["examples/tool-packages/"];
const PROJECT_LICENSE = "MIT";
/** Files copied from third parties keep their original license (see THIRD_PARTY_NOTICES.md). */
export const THIRD_PARTY_LICENSES = new Map([
  ["src/drivers/configuration/codex-default-instructions.ts", "Apache-2.0"],
  ["web/components/ai-elements/", "Apache-2.0"],
]);

function expectedLicense(relative) {
  for (const [prefix, license] of THIRD_PARTY_LICENSES)
    if (relative === prefix || (prefix.endsWith("/") && relative.startsWith(prefix))) return license;
  return PROJECT_LICENSE;
}

async function collect(root, relative, files) {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !PAYLOAD_DIRECTORIES.includes(`${child}/`))
        await collect(root, child, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(child);
  }
}

/**
 * Read the project's source files and report missing or wrong SPDX identifiers.
 *
 * @param {string} [rootDirectory] Project root; defaults to this repository.
 * @returns {Promise<{checkedFiles: number, diagnostics: string[]}>} An empty
 *   inventory is reported as a diagnostic, so a misconfigured root cannot pass.
 */
export async function checkSpdx(rootDirectory = fileURLToPath(new URL("../", import.meta.url))) {
  const root = path.resolve(rootDirectory);
  const files = [];
  for (const relative of SOURCE_ROOTS) await collect(root, relative, files);
  for (const relative of ROOT_FILES) {
    try {
      await readFile(path.join(root, relative));
      files.push(relative);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  const diagnostics = [];
  for (const relative of files.sort()) {
    const lines = (await readFile(path.join(root, relative), "utf8")).split("\n", 3);
    const header = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
    const match = header?.match(/^\/\/ SPDX-License-Identifier: ([A-Za-z0-9.+-]+)\r?$/);
    const expected = expectedLicense(relative);
    if (!match) diagnostics.push(`${relative}: missing "// SPDX-License-Identifier: ${expected}" header`);
    else if (match[1] !== expected) diagnostics.push(`${relative}: expected ${expected}, found ${match[1]}`);
  }
  if (!files.length) diagnostics.push("no source files found");
  return { checkedFiles: files.length, diagnostics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const { checkedFiles, diagnostics } = await checkSpdx(rootIndex > 0 ? process.argv[rootIndex + 1] : undefined);
  for (const line of diagnostics) console.error(line);
  if (diagnostics.length) process.exit(1);
  console.log(`SPDX headers verified for ${checkedFiles} source files.`);
}
