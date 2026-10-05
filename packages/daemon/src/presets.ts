// SPDX-License-Identifier: MIT
/**
 * The provider presets this build ships, which the daemon serves at
 * `GET /api/v1/presets`; `hh provider presets` lists them from here when no
 * daemon answers (apps/hh).
 */
export { listPresets } from "@harnesshub/gateway/presets";
