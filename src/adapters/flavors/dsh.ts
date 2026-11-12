import type { HarnessFlavor } from "../../contracts/flavor.js";
import { policyLevels } from "./common.js";

/** DeepSeek Harness (placeholder, filled by cc/harness-fit): no mode over ACP; every level is the Hub's policy on the requests it sends. */
export const dshFlavor: HarnessFlavor = {
  harnessId: "dsh",
  permission: policyLevels({ read: false, edit: false, execute: false, note: "按它自己的预设决定问不问" }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: false, execute: false, note: "按它自己的预设决定问不问" },
  nativePlan: false,
};
