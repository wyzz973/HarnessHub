import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DiscoveryInputError } from "../../contexts/catalog/domain/discovery.js";
import type { ConfigurationEvidence, ConfigurationLocator } from "../../contexts/catalog/domain/catalog.js";

/** Observe known paths only. No configuration body or login file is read. */
export class LocalConfigurationLocator implements ConfigurationLocator {
  constructor(private readonly home: string) {
    if (!isAbsolute(home)) throw new DiscoveryInputError("home must be absolute");
  }
  async observe(hints: readonly string[]): Promise<readonly ConfigurationEvidence[]> {
    if (hints.length > 32) throw new DiscoveryInputError("too many configuration hints");
    const evidence: ConfigurationEvidence[] = [];
    for (const hint of hints) {
      const path = resolve(join(this.home, hint));
      const child = relative(this.home, path);
      if (isAbsolute(hint) || !child || child === ".." || child.startsWith("../") || isAbsolute(child))
        throw new DiscoveryInputError("configuration hints must stay inside home");
      try {
        const info = await lstat(path);
        if (info.isFile() || info.isDirectory()) evidence.push({ path, state: "configured" });
      } catch (error: unknown) {
        if (error !== null && typeof error === "object" && "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES" || error.code === "EPERM")) continue;
        throw error;
      }
    }
    return evidence;
  }
}
