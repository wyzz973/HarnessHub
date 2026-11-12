import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/** Hermes (placeholder, filled by cc/harness-fit): its gateway viewer's modes default, accept_edits and dont_ask; the rest is the Hub's policy on the dangerous commands it asks about. */
export const hermesFlavor: HarnessFlavor = {
  harnessId: "hermes",
  permission: policyLevels({ read: false, edit: false, execute: true }, { ask: [MODE("default")], auto_edit: [MODE("accept_edits")], auto: [MODE("accept_edits")], full: [MODE("dont_ask")] }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: false, execute: true, note: "只问它认为危险的命令" },
  nativePlan: false,
};
