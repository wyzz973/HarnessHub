import type { HarnessFlavor } from "../../contracts/flavor.js";
import { MODE, policyLevels } from "./common.js";

/**
 * Claude Code through the Claude Agent SDK: its own permission modes (plan, default, acceptEdits, auto, bypassPermissions) carry every level, each the
 * session's own (`permissionMode`, setPermissionMode); it asks about edits and commands through the SDK's permission callback, which the Hub's policy answers too.
 */
export const claudeFlavor: HarnessFlavor = {
  harnessId: "claude",
  permission: policyLevels({ read: false, edit: true, execute: true }, { plan: [MODE("plan")], ask: [MODE("default")], auto_edit: [MODE("acceptEdits")], auto: [MODE("auto")], full: [MODE("bypassPermissions")] }),
  // The model's effort levels (ModelInfo.supportedEffortLevels), given to the session's flag layer (applyFlagSettings `effortLevel`), never a settings file.
  effort: { option: { category: "thought_level" }, values: {} },
  // Fast mode (`fast`, on a model with supportsFastMode): the flag layer's `fastMode`, the session's alone.
  speed: { option: { ids: ["fast"], category: "model_config" }, standard: "off", names: { on: "fast" } },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  // The SDK's `mcpServers` of the session's query carry the Hub's tools (a stdio server; its address and token come from the environment); its
  // `systemPrompt` preset keeps Claude Code's own prompt and appends the Hub's instructions.
  // The record is read as files with its own file tools (2026-11-13; verified on the installed program: it read the directory and answered from it).
  // Words in the middle of a turn: a user message of priority `next` from a person, which Claude Code reads once the tools it runs finish.
  // Tools load on demand natively: Claude Code defers MCP tools behind ToolSearch by default on the first-party API (Haiku 4.5 on 2026-11-15: the five
  // tools cost 317 input tokens up front, 22k more with ENABLE_TOOL_SEARCH=false; a Turn that needed hub_turns called ToolSearch, then it). The Hub sets no
  // ENABLE_TOOL_SEARCH: it is on already wherever Claude Code turns it on by itself, and Claude Code keeps it off for a custom base URL on purpose.
  capabilities: { sessionMcp: "sdk", systemPrompt: "sdk-append", planTool: "native", toolLoad: "native", resume: "native", fork: "native", rollback: "native", attachments: "native", usage: "turn", questions: "native", record: "files", steer: "native" },
};
