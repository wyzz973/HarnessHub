// SPDX-License-Identifier: MIT
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runSuite, SUITES } from "./run-tests.mjs";

/** Required compiled suites, relative to the repository root. */
const required = [
  "packages/agents/dist/test/windows-launch.test.js",
  "dist/tests/unit/windows-secrets.test.js",
  "dist/tests/integration/windows-engine-launch.test.js",
  "dist/tests/integration/windows-file-artifacts.test.js",
  "dist/tests/integration/windows-file-lock.test.js",
  "dist/tests/integration/windows-process.test.js",
];
/** Native acceptance must include every required compiled suite and cannot run on an emulated POSIX result. */
export function windowsTestFiles(root, platform = process.platform) {
  if (platform !== "win32")
    throw new Error(
      "test:windows requires native Windows; no acceptance evidence generated",
    );
  // Shared suites in dist/tests, and package-local suites in each package's dist/test.
  const packages = path.join(root, "packages");
  const directories = [
    path.join(root, "dist", "tests", "unit"),
    path.join(root, "dist", "tests", "integration"),
    ...readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packages, entry.name, "dist", "test")),
  ];
  const files = directories.flatMap((directory) => {
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((file) => /^windows-.*\.test\.js$/.test(file))
      .map((file) => path.join(directory, file));
  });
  if (
    required.some(
      (file) => !files.includes(path.join(root, ...file.split("/"))),
    )
  )
    throw new Error(
      "Compiled Windows acceptance suites are missing; run pnpm build",
    );
  return files;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { status, diagnostics } = await runSuite({
    ...SUITES.integration,
    files: windowsTestFiles(root),
  });
  for (const line of diagnostics) console.error(`test:windows: ${line}`);
  process.exitCode = status;
}
