import { HUB_POLICIES, type HarnessFlavor, type PermissionWay } from "../../contracts/flavor.js";

/**
 * OpenClaw (2026.11.x, its Gateway WebSocket). Each Gateway session has a permission mode of its own (docs/gateway/permission-modes.md), set in the
 * `sessions.create` that makes the Hub's session and fenced on every chat.send (`expectedPermissionMode`): read-only (no mutation tools, exec
 * refused), guarded (exec asks after its allowlist), workspace (an LLM reviewer allows, refuses or asks), full (nothing asks; needs operator.admin);
 * every mode but full confines the file tools to the session's root, which is the conversation's folder. Its file tools never ask (OpenClaw has
 * no edit approval); its exec and plugin approvals and its `ask_user` questions reach the Hub. No plan mode of its own: "plan" is read-only plus
 * the Hub's read-only note.
 */
const MODE = (permissionMode: "read-only" | "guarded" | "workspace" | "full"): NonNullable<PermissionWay["session"]> => ({ params: { permissionMode } });

export const openclawFlavor: HarnessFlavor = {
  harnessId: "openclaw",
  permission: {
    plan: { session: MODE("read-only"), policy: HUB_POLICIES.plan, note: "OpenClaw 的只读权限模式（不给改动工具、不许执行命令），Hub 另外提示模型只出方案" },
    ask: { session: MODE("guarded"), policy: HUB_POLICIES.ask, note: "OpenClaw 改文件从不来问（只在所选文件夹内改）；命令在它的允许清单之外才问" },
    auto_edit: { session: MODE("guarded"), policy: HUB_POLICIES.auto_edit, note: "命令在它的允许清单之外才问" },
    auto: { session: MODE("workspace"), policy: HUB_POLICIES.auto, note: "由 OpenClaw 的审查模型决定放行或拒绝命令，转来问的由 Hub 自动允许；文件只能在所选文件夹内改" },
    full: { session: MODE("full"), policy: HUB_POLICIES.full },
  },
  // thought_level lists the model's thinkingLevels (models.list; docs/tools/thinking.md: off, minimal, low, medium, high, and xhigh, max, adaptive
  // where the model has them); ultra is a harness mode, not an effort, and adaptive is no level.
  effort: { option: { ids: ["thought_level"], category: "thought_level" }, values: { off: ["off"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh"] } },
  asks: { read: false, edit: false, execute: true, note: "只问执行审批，改文件从不来问" },
  nativePlan: false,
  // The Gateway has no per-session MCP entry (sessions.create `toolOverrides` only switches servers already configured, and its MCP registry is
  // every session's), so the Hub's tools are a command of the conversation the agent runs with its exec tool (`cli`), not in read-only ("plan"),
  // and the instructions that name it go after the first prompt of a new session. Its own task list is `progress_card` (the `plan` stream) and it
  // asks its own questions (`ask_user`), so the Hub asks for neither. Words in the middle of a turn go in as chat.send `queueMode: "steer"`.
  // Its own tools load on demand (tool_describe, dispatch_action); the Hub's reach it as a command, so how MCP tools load does not apply (toolLoad).
  capabilities: { sessionMcp: "cli", systemPrompt: "first-prompt", planTool: "native", questions: "native", resume: "native", fork: "native", attachments: "native", usage: "turn", steer: "native" },
};
