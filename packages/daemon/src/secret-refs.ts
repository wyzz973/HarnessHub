// SPDX-License-Identifier: MIT
/**
 * References to secrets outside HarnessHub's store, as they come from
 * backups and sync (second security review M5). Such a reference makes the
 * daemon read whatever it names and send it to the provider or search
 * backend the same file names, so a crafted file could have it read the
 * admin token, the secret store or an upstream key from the environment.
 * HarnessHub's own variables and directories are never read for one; any
 * other reference is shown and must be confirmed (restore), and search keys
 * come in only as stored values.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { SecretReference } from "@harnesshub/core/engine-configuration";

/** The directories that hold HarnessHub's own credentials. */
export interface OwnDirectories {
  /** Admin token, secret store entries, sync secrets. */
  dataDir: string;
  /** The secret store's master key (`secrets.key`) and the configuration. */
  configDir: string;
}

async function canonical(file: string): Promise<string> {
  const absolute = path.resolve(file);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return absolute;
    throw error;
  }
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * Why `ref` may never be read for a secret that came from outside this
 * machine, or undefined: one of HarnessHub's own environment variables
 * (`HH_`, `HARNESSHUB_`), or a file in its data or configuration directory
 * after resolving links. Store references are HarnessHub's and pass.
 */
export async function ownSecretProblem(
  ref: SecretReference,
  directories: OwnDirectories,
): Promise<string | undefined> {
  if (ref.kind === "env" && /^(HH_|HARNESSHUB_)/i.test(ref.value))
    return `${ref.value} is one of HarnessHub's own environment variables`;
  if (ref.kind !== "file") return undefined;
  const file = await canonical(ref.value);
  for (const [root, what] of [
    [directories.dataDir, "data"],
    [directories.configDir, "configuration"],
  ] as const)
    if (within(await canonical(root), file))
      return `${ref.value} is in HarnessHub's ${what} directory, which holds its own credentials`;
  return undefined;
}

/** "the environment variable X", "the file X" or "the keychain item X". */
export function referenceText(kind: string, name: string): string {
  return kind === "env"
    ? `the environment variable ${name}`
    : kind === "file"
      ? `the file ${name}`
      : `the keychain item ${name}`;
}
