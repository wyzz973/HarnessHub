import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/**
 * CodeBuddy Code 2.184 (`codebuddy --acp`). Its permission modes are the session's config option `mode` (set by `session/set_config_option`, kept in the
 * process, nothing written to ~/.codebuddy): default asks before each tool's first use, acceptEdits lets edits go, plan is its own read-only planning,
 * bypassPermissions skips its prompts (its own high-risk checks may still ask, and the Hub allows them), fullAccess skips every check. Its `auto`
 * (an AI reviewer that refuses risky actions) and `dontAsk` (refuses what would ask) are not used: they refuse where the Hub's levels allow.
 */
export const codebuddyCodeFlavor: HarnessFlavor = {
  harnessId: "codebuddy-code",
  permission: policyLevels({ read: false, edit: true, execute: true },
    { plan: [MODE("plan")], ask: [MODE("default")], auto_edit: [MODE("acceptEdits")], auto: [MODE("bypassPermissions")], full: [MODE("fullAccess")] }),
  // Its config option `thought_level`: disabled (on a model that may think less), minimal … max by the model's supported efforts, and `enabled`, the model's own.
  effort: { option: { ids: ["thought_level"], category: "thought_level" }, values: { off: ["disabled"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh"] } },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  // The Hub's tools are the session's ACP `mcpServers` (new and load); its system prompt has no entry from a client and MCP instructions reach only its
  // channels, so the session instructions follow the first prompt. Its TodoWrite reaches the Turn as ACP `plan`: planTool native. Resume by session/load;
  // no session/fork over ACP. Read statically from 2.184.0 only: the user was not signed in on 2026-11-15, so steer (`session/steer`) and rollback
  // (`_codebuddy.ai/session/rollback`) stay off until a real Turn shows them, and toolLoad and questions are not declared yet.
  capabilities: { keep: "session", sessionMcp: "acp", systemPrompt: "first-prompt", planTool: "native", resume: "native", fork: "none", attachments: "native", record: "files",
    steer: "none", rollback: "none" },
};
