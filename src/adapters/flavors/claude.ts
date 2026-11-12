import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/** Claude Code through claude-agent-acp: its own modes (plan, default, acceptEdits, auto, bypassPermissions) carry every level; it asks about edits and commands, which the Hub's policy answers too. */
export const claudeFlavor: HarnessFlavor = {
  harnessId: "claude",
  permission: policyLevels({ read: false, edit: true, execute: true }, { plan: [MODE("plan")], ask: [MODE("default")], auto_edit: [MODE("acceptEdits")], auto: [MODE("auto")], full: [MODE("bypassPermissions")] }),
  effort: { option: { category: "thought_level" }, values: {} },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  // claude-agent-acp 0.99.1 acp-agent.js createSession: `mcpServers` go to the SDK as the session's own servers; `_meta.systemPrompt`
  // as an object keeps Claude Code's preset and adds `append`.
  capabilities: { sessionMcp: "acp", systemPrompt: "acp-meta", planTool: "hub", resume: "native", fork: "native", attachments: "native", usage: "turn", questions: "native" },
};
