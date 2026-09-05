import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Reject unverified Node patches before the complete validation pipeline. */
export function checkRuntime(actualVersion, expectedVersion) {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Expected Node ${expectedVersion}; found ${actualVersion}. Use the version in .node-version.`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const expected = readFileSync(
      new URL("../.node-version", import.meta.url),
      "utf8",
    ).trim();
    checkRuntime(process.versions.node, expected);
    console.log(`Node ${expected} matches the pinned runtime.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
