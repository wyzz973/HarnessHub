// SPDX-License-Identifier: MIT
/**
 * References to secrets outside HarnessHub's store that came from somewhere
 * else: a backup or a sync (second security review M5), or a Library tool
 * (07 section 4.6). Such a reference makes the daemon read whatever it
 * names and hand it to a provider, a search backend or an agent's tool, so
 * a crafted one could read the admin token, the secret store or an
 * upstream key. {@link ownSecretProblem} is the one rule for HarnessHub's
 * own variables and directories, which none of them may name.
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

/** The real path of `file`, or its absolute path while it does not exist. */
export async function canonicalPath(file: string): Promise<string> {
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
  const file = await canonicalPath(ref.value);
  for (const [root, what] of [
    [directories.dataDir, "data"],
    [directories.configDir, "configuration"],
  ] as const)
    if (within(await canonicalPath(root), file))
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
