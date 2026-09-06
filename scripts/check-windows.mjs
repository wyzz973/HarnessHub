import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const required = [
  "unit/windows-launch.test.js",
  "unit/windows-secrets.test.js",
  "integration/windows-engine-launch.test.js",
  "integration/windows-file-artifacts.test.js",
  "integration/windows-file-lock.test.js",
  "integration/windows-process.test.js",
];
/** Native acceptance must include every required compiled suite and cannot run on an emulated POSIX result. */
export function windowsTestFiles(root, platform = process.platform) {
  if (platform !== "win32")
    throw new Error(
      "test:windows requires native Windows; no acceptance evidence generated",
    );
  const files = ["unit", "integration"].flatMap((group) => {
    const directory = path.join(root, "dist", "tests", group);
    return readdirSync(directory)
      .filter((file) => /^windows-.*\.test\.js$/.test(file))
      .map((file) => path.join(directory, file));
  });
  if (
    required.some(
      (file) => !files.includes(path.join(root, "dist", "tests", file)),
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
  const result = spawnSync(
    process.execPath,
    ["--test", ...windowsTestFiles(root)],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
