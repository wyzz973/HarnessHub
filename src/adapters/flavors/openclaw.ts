import { HUB_POLICIES, type HarnessFlavor, type PermissionWay } from "../../contracts/flavor.js";

/**
 * OpenClaw (2026.10.x). Each Gateway session has a permission mode of its own (docs/gateway/permission-modes.md; sessions.patch
 * `permissionMode`): read-only (no mutation tools, exec refused), guarded (exec asks a human after its allowlist), workspace (an LLM reviewer
 * allows, refuses or asks a human), full (no limits, nothing asks); every mode but full confines the file tools to the session's root (the
 * agent's workspace, since the Hub names its own session key). The driver patches it on the Hub's session before its first prompt
 * (session.params.permissionMode here; full needs the operator.admin scope). Without a mode the session follows openclaw.json, by default
 * full access. Its file tools never ask (OpenClaw has no edit approval); its exec approvals reach the ACP client as request_permission
 * while a prompt runs (the bridge's EXEC_APPROVALS), which the Hub answers by the level. No plan mode of its own: "plan" is read-only plus
 * the Hub's read-only note.
 */
const MODE = (permissionMode: "read-only" | "guarded" | "workspace" | "full"): NonNullable<PermissionWay["session"]> => ({ params: { permissionMode } });

export const openclawFlavor: HarnessFlavor = {
  harnessId: "openclaw",
  permission: {
    plan: { session: MODE("read-only"), policy: HUB_POLICIES.plan, note: "OpenClaw 的只读权限模式（不给改动工具、不许执行命令），Hub 另外提示模型只出方案" },
    ask: { session: MODE("guarded"), policy: HUB_POLICIES.ask, note: "OpenClaw 改文件从不来问（只在工作区内改）；命令在它的允许清单之外才问" },
    auto_edit: { session: MODE("guarded"), policy: HUB_POLICIES.auto_edit, note: "命令在它的允许清单之外才问" },
    auto: { session: MODE("workspace"), policy: HUB_POLICIES.auto, note: "由 OpenClaw 的审查模型决定放行或拒绝命令，转来问的由 Hub 自动允许；文件只能在工作区内改" },
    full: { session: MODE("full"), policy: HUB_POLICIES.full },
  },
  // thought_level lists the session row's thinkingLevels (docs/tools/thinking.md: off, minimal, low, medium, high, and xhigh, max, adaptive
  // where the model has them); ultra is a harness mode, not an effort, and adaptive is no level.
  effort: { option: { ids: ["thought_level"], category: "thought_level" }, values: { off: ["off"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh"] } },
  asks: { read: false, edit: false, execute: true, note: "只问执行审批，改文件从不来问" },
  nativePlan: false,
  // docs/cli/acp.md: the bridge rejects per-session `mcpServers` (dist/server-*.mjs assertSupportedSessionSetup); sessions.patch has no
  // tool or prompt field (SessionsPatchMutationProperties), and a prompt's `_meta` takes only prefixCwd, thinking, deliver and timeoutMs.
  capabilities: { sessionMcp: "none", systemPrompt: "none", planTool: "none", resume: "native", fork: "none", attachments: "native", usage: "turn" },
};
