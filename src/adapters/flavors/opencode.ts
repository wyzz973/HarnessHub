import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/** OpenCode (placeholder, filled by cc/harness-fit): plan is its own plan agent; the other levels are the Hub's policy on the requests it sends, its build agent otherwise. */
export const opencodeFlavor: HarnessFlavor = {
  harnessId: "opencode",
  permission: policyLevels({ read: false, edit: false, execute: false, note: "按它自己的权限配置决定问不问" }, { plan: [MODE("plan")] }),
  neutral: [MODE("build")],
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: false, execute: false, note: "按它自己的权限配置决定问不问" },
  nativePlan: true,
};
