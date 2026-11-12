import type { HarnessFlavor } from "../../contracts/flavor.js";
import { policyLevels } from "./common.js";

/** Pi: no permission requests at all; the levels are the Hub's policy, which has nothing to answer. */
export const piFlavor: HarnessFlavor = {
  harnessId: "pi",
  permission: policyLevels({ read: false, edit: false, execute: false }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: false, execute: false, note: "Pi 不发权限请求" },
  nativePlan: false,
};
