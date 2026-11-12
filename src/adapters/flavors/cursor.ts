import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/** Cursor (frozen): its modes agent, plan and ask; the rest is the Hub's policy. */
export const cursorFlavor: HarnessFlavor = {
  harnessId: "cursor",
  permission: policyLevels({ read: false, edit: true, execute: true }, { plan: [MODE("plan")] }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
};
