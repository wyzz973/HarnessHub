/** Build-machine-only completion of the fixed OpenClaw package's official lifecycle. */
import { readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Run only OpenClaw 2026.9.2's package-local lifecycle; never delete its completion marker by hand. */
export async function prepareOpenClaw(directory) {
  const packageRoot = await realpath(directory);
  const metadata = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (metadata.name !== "openclaw" || metadata.version !== "2026.9.2")
    throw new Error("Expected the fixed openclaw@2026.9.2 package");
  for (const name of [
    "scripts/preinstall-package-manager-warning.mjs",
    "scripts/postinstall-bundled-plugins.mjs",
    "dist/infra/package-lifecycle.js",
  ]) {
    const file = await realpath(path.join(packageRoot, name));
    const relative = path.relative(packageRoot, file);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error(
        "OpenClaw lifecycle script escapes the installed package",
      );
  }
  const { completePendingPackageLifecycle } = await import(
    pathToFileURL(path.join(packageRoot, "dist/infra/package-lifecycle.js"))
      .href
  );
  const changed = await completePendingPackageLifecycle({
    packageRoot,
    timeoutMs: 120_000,
  });
  for (const marker of [
    ".openclaw-lifecycle-pending",
    "dist/openclaw-install-guard",
  ]) {
    try {
      await lstat(path.join(packageRoot, marker));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("OpenClaw package lifecycle is still incomplete");
  }
  return {
    id: "openclaw",
    version: metadata.version,
    lifecycleComplete: true,
    changed,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: { package: { type: "string" } },
      allowPositionals: false,
    });
    if (!values.package)
      throw new Error(
        "Usage: node scripts/prepare-openclaw.mjs --package DIRECTORY",
      );
    console.log(JSON.stringify(await prepareOpenClaw(values.package)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
