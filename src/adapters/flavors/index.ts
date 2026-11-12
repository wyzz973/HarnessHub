import type { AsksFor, HarnessFlavor } from "../../contracts/flavor.js";
import { claudeFlavor } from "./claude.js";
import { codexFlavor } from "./codex.js";
import { cursorFlavor } from "./cursor.js";
import { dshFlavor } from "./dsh.js";
import { hermesFlavor } from "./hermes.js";
import { opencodeFlavor } from "./opencode.js";
import { openclawFlavor } from "./openclaw.js";
import { piFlavor } from "./pi.js";
import { policyLevels } from "./common.js";

const FLAVORS: ReadonlyMap<string, HarnessFlavor> = new Map([claudeFlavor, codexFlavor, opencodeFlavor, dshFlavor, hermesFlavor, openclawFlavor, piFlavor, cursorFlavor].map(flavor => [flavor.harnessId, flavor]));
const UNKNOWN: AsksFor = { read: false, edit: true, execute: true, note: "这个 Harness 还没有适配声明，按它发来的权限请求答复" };
/** A Harness's adapter declaration; one without its own (a catalog entry of a test, a Harness not adapted yet) is the Hub's policy alone. */
export function flavorOf(harnessId: string): HarnessFlavor {
  return FLAVORS.get(harnessId) ?? { harnessId, permission: policyLevels(UNKNOWN), effort: { values: {} }, asks: UNKNOWN, nativePlan: false };
}
