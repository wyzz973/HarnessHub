// SPDX-License-Identifier: MIT
/**
 * The directory of the built console (`packages/console/dist/`, a `file:`
 * URL ending in `/`). It holds `index.html` and the hashed `assets/` only
 * after `pnpm build:console`; callers check for the files themselves.
 */
export declare const consoleAssets: URL;
