import { HUB_POLICIES, type HarnessFlavor } from "../../contracts/flavor.js";
import { MODE } from "./common.js";

/**
 * Hermes Agent (`hermes acp`, the viewer of the user's Hermes gateway, v0.22.x). Its ACP modes are its edit-approval policy for this session
 * alone (acp_adapter/modes.py, gateway/session_policy.py; nothing is written to config.yaml): default asks before every edit, accept_edits
 * allows edits under the session's cwd and the temp directory, dont_ask allows every edit. Edits of sensitive paths (.git, .ssh, .env, keys)
 * and of instruction files (AGENTS.md, CLAUDE.md) always ask (acp_adapter/edit_approval.py, tools/file_tools_write_guards.py).
 *
 * Commands ask only when they match its dangerous patterns (tools/approval.py: rm -r, chmod 777, curl | sh, …), after its `approvals.mode`
 * (smart by default: a guardian model may approve or refuse first); ordinary commands and execute_code never ask, and its hard blocks are
 * never lifted. `HERMES_YOLO_MODE` in the viewer's environment freezes yolo into a session it creates (hermes_cli/gateway_chat.py
 * env_launch_flags → session.create), which skips the dangerous-command gate for that session only. It has no sandbox and no plan mode of its
 * own (`/plan` only rewrites the prompt), so "plan" is the Hub's: its edits and dangerous commands are refused, and the model is told.
 */
export const hermesFlavor: HarnessFlavor = {
  harnessId: "hermes",
  permission: {
    plan: { native: [MODE("default")], policy: HUB_POLICIES.plan, note: "Hermes 没有只读模式：Hub 拒绝它来问的改文件和危险命令，并提示模型只读；普通命令和 execute_code 它不来问，拦不住" },
    ask: { native: [MODE("default")], policy: HUB_POLICIES.ask, note: "改文件每次都问；命令只有 Hermes 认为危险的才问（它的审查模型可能先替你放行或拒绝），普通命令不问" },
    auto_edit: { native: [MODE("accept_edits")], policy: HUB_POLICIES.auto_edit, note: "危险命令才来问，普通命令不问" },
    // No sandbox: edits inside the workspace go unasked (accept_edits); what still asks (an edit outside it or of a sensitive path, a dangerous
    // command) is allowed by the Hub. Its edit approvals come titled "Approve edit: <path>" for a call the Hub has no kind for, so the Hub
    // could not refuse only those: nothing is refused.
    auto: { native: [MODE("accept_edits")], policy: HUB_POLICIES.auto,
      note: "Hermes 没有沙箱：工作区内改文件不问；它仍来问的（工作区外或敏感文件的改动、危险命令）由 Hub 自动允许" },
    full: { native: [MODE("dont_ask")], session: { env: { HERMES_YOLO_MODE: "1" } }, policy: HUB_POLICIES.full,
      note: "Hermes 自己的硬性拦截（如删除根目录）和你配置的 approvals.deny 仍然生效" },
  },
  // No ACP option: the driver offers reasoning_effort (thought_level) and sends `/reasoning <level>` for this session alone
  // (gateway/session_setting_commands.py; no config.yaml write without --global). Its provider takes the nearest level it supports.
  effort: { option: { ids: ["reasoning_effort"], category: "thought_level" }, values: { off: ["none"], low: ["low", "minimal"], medium: ["medium"], high: ["high"], max: ["max", "xhigh"] },
    note: "模型不支持的档位，Hermes 会就近降到它支持的档位" },
  asks: { read: false, edit: true, execute: true, note: "改文件按模式问；命令只问它认为危险的" },
  nativePlan: false,
  // acp_adapter/gateway_server.py new_session/_resume: ACP `mcpServers` become the gateway session's editor MCP servers (session.create
  // `editor.mcp_servers`, gateway/session_local_mcp.py; a changed spec on resume is re-bound). No system prompt entry: session.create takes no
  // prompt from the viewer (HERMES_EPHEMERAL_SYSTEM_PROMPT is read from a shell client's client_env, which the viewer does not send),
  // `/personality` writes config.yaml, and its MCP client never reads a server's instructions (tools/mcp_tool*.py): first-prompt.
  // The record is read as files with its own file tools (2026-11-13; verified on the installed program: it read the directory and answered from it).
  capabilities: { sessionMcp: "acp", systemPrompt: "first-prompt", planTool: "hub", resume: "native", fork: "native", attachments: "pointer", usage: "turn", record: "files" },
};
