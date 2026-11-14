import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/** Claude Code through claude-agent-acp: its own modes (plan, default, acceptEdits, auto, bypassPermissions) carry every level; it asks about edits and commands, which the Hub's policy answers too. */
export const claudeFlavor: HarnessFlavor = {
  harnessId: "claude",
  permission: policyLevels({ read: false, edit: true, execute: true }, { plan: [MODE("plan")], ask: [MODE("default")], auto_edit: [MODE("acceptEdits")], auto: [MODE("auto")], full: [MODE("bypassPermissions")] }),
  effort: { option: { category: "thought_level" }, values: {} },
  // claude-agent-acp 0.99.1 acp-agent.js: the session config option `fast` ("on"/"off", category model_config) is there only while the session's model
  // has `supportsFastMode`; session/set_config_option sends the SDK `applyFlagSettings({ fastMode })`, the session's flag layer, never a settings file.
  speed: { option: { ids: ["fast"], category: "model_config" }, standard: "off", names: { on: "fast" } },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  // claude-agent-acp 0.99.1 acp-agent.js createSession: `mcpServers` go to the SDK as the session's own servers; `_meta.systemPrompt`
  // as an object keeps Claude Code's preset and adds `append`.
  // The record is read as files with its own file tools (2026-11-13; verified on the installed program: it read the directory and answered from it).
  // Words in the middle of a turn: claude-agent-acp's `_session/steering` (0.99.1 acp-agent.js `steer`, advertised by initialize's top-level
  // `_meta.steering.supported`), asked with `idleBehavior: "promptRequired"` so that words finding no turn are refused and never start one.
  // Tools load on demand natively: Claude Code 2.1.316 defers MCP tools behind ToolSearch by default on the first-party API (Haiku 4.5 on 2026-11-15: the five
  // tools cost 317 input tokens up front, 22k more with ENABLE_TOOL_SEARCH=false; a Turn that needed hub_turns called ToolSearch, then it). The Hub sets no
  // ENABLE_TOOL_SEARCH: it is on already wherever Claude Code turns it on by itself, and Claude Code keeps it off for a custom base URL on purpose.
  capabilities: { sessionMcp: "acp", systemPrompt: "acp-meta", planTool: "native", toolLoad: "native", resume: "native", fork: "native", attachments: "native", usage: "turn", questions: "native", record: "files", steer: "native" },
};
