import type { HarnessFlavor } from "../../contracts/flavor.js";
import { policyLevels } from "./common.js";

/** OpenClaw (placeholder, filled by cc/harness-fit): its exec rights are its Gateway's; every level is the Hub's policy on the approvals it sends. */
export const openclawFlavor: HarnessFlavor = {
  harnessId: "openclaw",
  permission: policyLevels({ read: false, edit: false, execute: true, note: "按它 Gateway 的执行审批决定问不问" }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: false, execute: true, note: "按它 Gateway 的执行审批决定问不问" },
  nativePlan: false,
};
