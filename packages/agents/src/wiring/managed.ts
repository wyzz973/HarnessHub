// SPDX-License-Identifier: MIT
/**
 * An administrator's policy over an agent's own configuration: Claude
 * Code applies its managed settings over the user's settings, so an entry
 * wiring writes that the policy also sets has no effect. Read only; these
 * files are never written.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WiringRecord } from "@harnesshub/core/model-plane";
import { wiringAdapter } from "./adapters/index.js";
import { readManifest } from "./backups.js";
import { isCode } from "./files.js";
import { editors, type KeyPath } from "./formats/index.js";
import { formatPath, getPath } from "./formats/values.js";
import type { WiringContext } from "./operations.js";

/** Entries wiring writes that an administrator's file sets too. */
export interface ManagedOverride {
  /** The managed file, as the agent reads it. */
  path: string;
  /** Each entry it sets that wiring writes, as key segments. */
  keyPaths: string[][];
}

/**
 * The adapter's managed files (`WiringAdapter.managedFiles`) that set any
 * of `keyPaths` (entries of the adapter's first file), with those entries.
 * A missing file sets nothing; one that does not parse is reported with no
 * entries, as the agent may still apply it. Reads only; `context.systemRoot`
 * relocates the system paths for tests.
 */
export async function managedOverrides(
  adapterId: string,
  keyPaths: readonly KeyPath[],
  context: Pick<WiringContext, "systemRoot">,
): Promise<ManagedOverride[]> {
  const adapter = wiringAdapter(adapterId);
  const spec = adapter.files[0];
  if (!adapter.managedFiles || !spec) return [];
  const overrides: ManagedOverride[] = [];
  for (const managed of adapter.managedFiles(process.platform)) {
    const file = context.systemRoot
      ? path.join(context.systemRoot, managed.replace(/^[A-Za-z]:/, ""))
      : managed;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      // Absent, or unreadable to this user and so to the agent it runs as.
      if (
        ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].some((code) =>
          isCode(error, code),
        )
      )
        continue;
      throw error;
    }
    let document: unknown;
    try {
      document = editors[spec.format].parse(text);
    } catch {
      overrides.push({ path: managed, keyPaths: [] });
      continue;
    }
    const set = keyPaths.filter(
      (keyPath) => getPath(document, keyPath) !== undefined,
    );
    if (set.length)
      overrides.push({
        path: managed,
        keyPaths: set.map((keyPath) =>
          keyPath.map((segment) =>
            typeof segment === "string" ? segment : formatPath([segment]),
          ),
        ),
      });
  }
  return overrides;
}

/**
 * The entries a wiring wrote (or removed) in the adapter's first file, from
 * its backup manifest: what an administrator's file may override. Empty
 * when that file is not among the record's.
 */
export async function wiredEntries(
  record: WiringRecord,
  context: Pick<WiringContext, "dataDir">,
): Promise<KeyPath[]> {
  const adapter = wiringAdapter(record.adapterId);
  const fileId = adapter.files[0]?.id;
  for (const entry of record.files) {
    if (!entry.backupId) continue;
    const manifest = await readManifest(
      context.dataDir,
      adapter.id,
      entry.backupId,
    );
    if (manifest.fileId !== fileId) continue;
    return [
      ...manifest.expected.map((expected) => expected.path),
      ...(manifest.absent ?? []),
    ];
  }
  return [];
}
