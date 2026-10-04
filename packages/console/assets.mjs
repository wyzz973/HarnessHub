// SPDX-License-Identifier: MIT
/**
 * Where the built console lives: `dist/` of this package, written by
 * `pnpm build:console` (Vite). The daemon serves these files (ADR-P10); the
 * single executable embeds them at the same repository-relative path.
 */
export const consoleAssets = new URL("./dist/", import.meta.url);
