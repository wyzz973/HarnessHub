// SPDX-License-Identifier: MIT
/**
 * The secret scan of `pnpm test:real`: where a secret's plaintext appears in
 * files and in captured output. Reports names only, never the secret.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** A directory to scan, shown as `label` in the result. */
export interface ScanRoot {
  label: string;
  directory: string;
}

/**
 * Every file below `roots` (symbolic links are not followed) and every
 * named text whose bytes contain `secret`, as `label/relative path` or the
 * text's name, sorted. A file that disappears during the scan is skipped;
 * any other read failure rejects, so an unreadable file is never taken as
 * clean.
 *
 * @throws {RangeError} For a secret shorter than 8 characters, which would
 *   match by chance.
 */
export async function findSecret(
  secret: string,
  roots: readonly ScanRoot[],
  texts: readonly { name: string; text: string }[] = [],
): Promise<string[]> {
  if (secret.length < 8)
    throw new RangeError("A secret to scan for has at least 8 characters");
  const needle = Buffer.from(secret, "utf8");
  const hits: string[] = [];
  const visit = async (directory: string, label: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const shown = `${label}/${entry.name}`;
      if (entry.isDirectory()) await visit(file, shown);
      else if (entry.isFile()) {
        let bytes: Buffer;
        try {
          if ((await lstat(file)).isSymbolicLink()) continue;
          bytes = await readFile(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (bytes.includes(needle)) hits.push(shown);
      }
    }
  };
  for (const root of roots) await visit(root.directory, root.label);
  for (const { name, text } of texts)
    if (text.includes(secret)) hits.push(name);
  return hits.sort();
}
