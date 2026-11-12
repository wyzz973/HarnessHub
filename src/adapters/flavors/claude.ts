import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/** Claude Code through claude-agent-acp: its own modes (plan, default, acceptEdits, auto, bypassPermissions) carry every level; it asks about edits and commands, which the Hub's policy answers too. */
export const claudeFlavor: HarnessFlavor = {
  harnessId: "claude",
  permission: policyLevels({ read: false, edit: true, execute: true }, { plan: [MODE("plan")], ask: [MODE("default")], auto_edit: [MODE("acceptEdits")], auto: [MODE("auto")], full: [MODE("bypassPermissions")] }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  capabilities: { sessionMcp: "native", resume: "native", fork: "native", attachments: "native", usage: "turn", questions: "native" },
};
