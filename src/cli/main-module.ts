import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` (its `import.meta.url`) is the program Node was started with (`entry`, by default `process.argv[1]`). Real paths are
 * compared, so an entry reached through a link still runs: macOS's `/var` → `/private/var`, a linked checkout, a Harness given the path of a link. (A plain
 * comparison of the URLs made such a start do nothing and exit 0.) An entry named without its `.js`, as Node accepts it, is the same program.
 */
export function isMainModule(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl), given = resolve(entry);
  if (given === self) return true;
  let real: string;
  try { real = realpathSync(self); } catch { return false; }
  for (const candidate of [given, given + ".js"]) {
    try { if (realpathSync(candidate) === real) return true; } catch { /* not this spelling */ }
  }
  return false;
}
