import type { HarnessFlavor, NativeWant } from "../../contracts/flavor.js";
import { policyLevels } from "./common.js";

// Codex's collaboration mode is named for plan only: naming it needs the app-server's experimental API, which an older Codex lacks; leaving plan
// sets it back to default (the neutral), since a thread keeps the mode it was last given.
const CODEX = (approval: string, sandbox: string, plan = false): readonly NativeWant[] => [
  ...(plan ? [{ ids: ["collaboration_mode"], category: "mode", value: "plan" }] : []), { ids: ["approval_policy"], category: "permission", value: approval }, { ids: ["sandbox"], category: "permission", value: sandbox }];
const LEVELS = policyLevels({ read: false, edit: true, execute: true }, { plan: CODEX("on-request", "read-only", true), ask: CODEX("untrusted", "workspace-write"), auto_edit: CODEX("untrusted", "workspace-write"),
  auto: CODEX("on-request", "workspace-write"), full: CODEX("never", "danger-full-access") });
/**
 * Codex: its thread settings (approval policy and sandbox) and its collaboration mode carry every level; it asks about commands and patches.
 * "auto_edit" is "untrusted" like "ask" (on-request runs a sandboxed command unasked): Codex asks about every patch and untrusted command,
 * and the Hub's policy allows the patches, so only the commands come to the user. "auto" is "on-request" with Codex's own auto-review
 * (`approvalsReviewer: "auto_review"`, T3 Code's choice): what leaves the sandbox (the network, more paths) is reviewed by Codex instead of
 * failing silently as under "never"; a Codex without auto-review asks, and the Hub's policy allows (codex/control.ts reviewerFor). Every
 * other level says the user reviews, so that a thread leaves auto-review when its level does. `on-failure` is gone (app-server 0.169.0).
 */
export const codexFlavor: HarnessFlavor = {
  harnessId: "codex",
  permission: { ...LEVELS, auto: { ...LEVELS.auto, session: { params: { approvalsReviewer: "auto_review" } } } },
  neutral: [{ ids: ["collaboration_mode"], category: "mode", value: "default" }],
  effort: { option: { ids: ["reasoning_effort"], category: "thought_level" }, values: {} },
  // app-server 0.166.0: model/list gives each model its `serviceTiers` (here `priority`, named "Fast"); thread/start and thread/resume take
  // `serviceTier` for the thread and report the one it runs. "default" is standard (`serviceTierForTurn`'s own words), "fast" an alias of priority.
  speed: { option: { ids: ["service_tier"], category: "speed" }, standard: "default", names: { priority: "fast", fast: "fast" } },
  asks: { read: false, edit: true, execute: true },
  nativePlan: true,
  // app-server 0.166.0 ThreadStartParams / ThreadResumeParams: `config` (dotted overrides of this thread alone, as `-c`) carries
  // `mcp_servers.harnesshub` (stdio, `env_vars` forwarded, default_tools_approval_mode "approve"); `developerInstructions` the instructions.
  // The record is read as files with its own file tools (2026-11-13; verified on the installed program: it read the directory and answered from it).
  // Words in the middle of a turn: app-server's `turn/steer {threadId, expectedTurnId, input, clientUserMessageId}` (0.166.0), which Codex
  // refuses when the turn named is not the active one, so words that find no turn are never a turn of their own.
  capabilities: { sessionMcp: "thread-config", systemPrompt: "developer-instructions", planTool: "native", resume: "native", fork: "native", attachments: "native", usage: "turn", questions: "native", record: "files", steer: "native" },
};
