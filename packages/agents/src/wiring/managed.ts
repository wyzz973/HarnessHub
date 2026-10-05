// SPDX-License-Identifier: MIT
/**
 * An administrator's policy over an agent's own configuration: Claude
 * Code applies its managed settings over the user's settings, so an entry
 * wiring writes that the policy also sets has no effect. Read only; these
 * files are never written.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { WiringRecord } from "@harnesshub/core/model-plane";
import { wiringAdapter } from "./adapters/index.js";
import { readManifest } from "./backups.js";
import { isCode } from "./files.js";
import { editors, type KeyPath } from "./formats/index.js";
import { formatPath, getPath } from "./formats/values.js";
import type { WiringContext } from "./operations.js";

/** The largest managed file read: a policy is a small JSON file. */
const MAX_MANAGED_BYTES = 1024 * 1024;

/** Codes of a managed file that is absent, or not this user's (nor so the agent's) to read. */
const ABSENT = ["ENOENT", "ENOTDIR", "EACCES", "EPERM"];

/**
 * A managed file's text; `absent` when there is none to read; `unreadable`
 * for anything but a regular file of at most {@link MAX_MANAGED_BYTES}
 * (a directory, a pipe, a link, a device) or a failed read. Never waits on
 * a pipe and never follows a link: a directory another user made in a
 * shared system path must not fail or stop wiring.
 */
async function readManaged(
  file: string,
): Promise<string | "absent" | "unreadable"> {
  const absent = (error: unknown) =>
    ABSENT.some((code) => isCode(error, code)) ? "absent" : "unreadable";
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    return absent(error);
  }
  if (!info.isFile() || info.size > MAX_MANAGED_BYTES) return "unreadable";
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    return absent(error);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_MANAGED_BYTES)
      return "unreadable";
    const bytes = Buffer.alloc(MAX_MANAGED_BYTES + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        bytes,
        read,
        bytes.length - read,
        read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > MAX_MANAGED_BYTES) return "unreadable";
    }
    return bytes.subarray(0, read).toString("utf8");
  } catch {
    // A read that fails half way: the file is reported, never a 500.
    return "unreadable";
  } finally {
    await handle.close();
  }
}

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
 * A missing file sets nothing; one that does not parse, or that is no
 * regular file of at most 1 MiB, is reported with no entries ("could not be
 * read"), as the agent may still apply it. Never throws for a file's
 * state and never waits on one. Reads only; `context.systemRoot` relocates
 * the system paths for tests.
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
    const text = await readManaged(file);
    if (text === "absent") continue;
    if (text === "unreadable") {
      overrides.push({ path: managed, keyPaths: [] });
      continue;
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
