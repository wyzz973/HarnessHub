import { HUB_POLICIES, type HarnessFlavor, type NativeWant } from "../../contracts/flavor.js";

/** The edit approval policy a session is opened with (`session.create editor.edit_approval_policy`, `session.mutate edit_policy`). */
const POLICY = (value: "ask" | "workspace_session" | "session"): NativeWant => ({ ids: ["edit_policy"], category: "mode", value });

/**
 * Hermes Agent over its gateway (`hermes-gateway-v1`, adapters/control/hermes/, 2026-11-15). A session the Hub opens is a local editor session
 * (`source: "acp"`, the `hermes-acp` toolset: coding tools, no messaging, no clarify): its edit approval policy is its own setting
 * (gateway/session_policy.py; nothing is written to config.yaml): ask asks before every edit, workspace_session lets edits under the session's
 * cwd go unasked, session lets every edit go. Edits of sensitive paths (.git, .ssh, .env, keys) and of instruction files always ask.
 *
 * Commands ask only when they match its dangerous patterns (tools/approval.py), after its `approvals.mode` (a guardian model may approve or refuse
 * first); ordinary commands and execute_code never ask, and its hard blocks are never lifted. `yolo` is frozen at `session.create` and skips the
 * dangerous-command gate for that session only. It has no sandbox and no plan mode of its own, so "plan" is the Hub's.
 */
export const hermesFlavor: HarnessFlavor = {
  harnessId: "hermes",
  permission: {
    plan: { native: [POLICY("ask")], policy: HUB_POLICIES.plan, note: "Hermes 没有只读模式：Hub 拒绝它来问的改文件和危险命令，并提示模型只读；普通命令和 execute_code 它不来问，拦不住" },
    ask: { native: [POLICY("ask")], policy: HUB_POLICIES.ask, note: "改文件每次都问；命令只有 Hermes 认为危险的才问（它的审查模型可能先替你放行或拒绝），普通命令不问" },
    auto_edit: { native: [POLICY("workspace_session")], policy: HUB_POLICIES.auto_edit, note: "危险命令才来问，普通命令不问" },
    auto: { native: [POLICY("workspace_session")], policy: HUB_POLICIES.auto,
      note: "Hermes 没有沙箱：工作区内改文件不问；它仍来问的（工作区外或敏感文件的改动、危险命令）由 Hub 自动允许" },
    full: { native: [POLICY("session")], session: { params: { yolo: true } }, policy: HUB_POLICIES.full,
      note: "Hermes 只在开会话时能打开 yolo；它自己的硬性拦截（如删除根目录）和你配置的 approvals.deny 仍然生效" },
  },
  // The session's own reasoning level (session.create `reasoning`, session.mutate `reasoning`; no config.yaml write). Its provider takes the nearest level it supports.
  effort: { option: { ids: ["reasoning_effort"], category: "thought_level" }, values: { off: ["none"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh"] },
    note: "模型不支持的档位，Hermes 会就近降到它支持的档位" },
  asks: { read: false, edit: true, execute: true, note: "改文件按审批设置问；命令只问它认为危险的" },
  nativePlan: false,
  // Hub tools: the session's editor MCP servers (session.create `editor.mcp_servers`). No system prompt entry the Hub could add to without replacing the
  // user's own (HERMES_EPHEMERAL_SYSTEM_PROMPT replaces `agent.system_prompt`): first-prompt. Hermes has its own todo tool (`todo.updated`): planTool native.
  // Hermes defers MCP tools behind its own tool_search bridge (tools/tool_search.py, `tools.tool_search.enabled: auto`): toolLoad native.
  // Words in the middle of a turn: `session.steer`, which never starts a turn of its own.
  capabilities: { sessionMcp: "acp", systemPrompt: "first-prompt", planTool: "native", resume: "native", fork: "native", rollback: "native", attachments: "native", usage: "turn", record: "files",
    toolLoad: "native", steer: "native" },
};
