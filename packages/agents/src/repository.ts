// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";

/**
 * Absolute path of a file relative to the repository (or, in the single
 * executable, to its extraction root), resolved from this module's compiled
 * location `packages/agents/dist/src/repository.js`.
 *
 * It exists for the runtime assets that stay in `scripts/` during OSS-004,
 * whose absolute paths registered engine commands store (ADR 0017 decision 6),
 * and for the pre-migration path of the command MCP entry that stored Tool Pack
 * bindings still name. It is the only URL that leaves this package: a boundary
 * check exception owned by OSS-004 that ends with OSS-013, by when the assets
 * move into the package with an alias for the stored paths.
 *
 * @param relative Slash-separated path below the repository root.
 */
export function repositoryPath(relative: string): string {
  return fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));
}

/** Absolute path of a runtime asset in the repository's `scripts/` directory. */
export function repositoryScript(name: string): string {
  return repositoryPath(`scripts/${name}`);
}
