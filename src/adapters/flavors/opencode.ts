import { HUB_POLICIES, type HarnessFlavor, type PermissionWay } from "../../contracts/flavor.js";
import { MODE } from "./common.js";

/**
 * OpenCode 2 (2.2.5, anomalyco/opencode at v2.2.5). Its permissions are rules `{action, resource, effect: allow|ask|deny}` evaluated last match
 * first (packages/core/src/permission.ts `evaluate`), every built-in agent starting from `* * allow` (only reading `.env` files asks;
 * packages/schema/src/agent.ts), so out of the box it asks about nothing. `opencode acp` starts its own `opencode serve` child with this
 * process's environment, which reads `OPENCODE_CONFIG_CONTENT` as one more configuration document, the last but managed settings
 * (packages/cli/src/server-process.ts, packages/core/src/config.ts); each document's `agents.<id>.permissions` are appended to that agent
 * after every top-level rule (packages/core/src/config/plugin/agent.ts), so the level's rules here are the last word over the user's own
 * configuration, for this process only, and nothing is written. Like T3 Code's sessionRules, each level is those rules on the agents a Hub
 * session runs (build, and its general subagent, which would otherwise edit unasked), and its ACP asks the Hub about every `ask`.
 *
 * - A refusal over ACP rejects the call without a message, which ends OpenCode's turn (packages/cli/src/acp/permission.ts answers "reject");
 *   so what a level refuses is refused by a `deny` rule where it can be, which the model sees as an error and works around.
 * - Its saved "always" answers (a project's allow rules in OpenCode's database) come after every configured rule and still allow.
 * - Managed settings (an MDM profile) come after this document and keep their word.
 */
const RULE = (action: string, effect: "allow" | "ask" | "deny", resource = "*") => ({ action, resource, effect });
/** The inline configuration of one level: the rules of build and general, and of plan when the level runs it. */
function inline(agents: Readonly<Record<string, readonly ReturnType<typeof RULE>[]>>): Readonly<Record<string, string>> {
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: Object.fromEntries(Object.entries(agents).map(([id, permissions]) => [id, { permissions }])) }) };
}
const ASKING = (edit: "allow" | "ask", shell: "allow" | "ask") => [RULE("edit", edit), RULE("shell", shell), RULE("external_directory", "ask")];
const ways: Readonly<Record<keyof typeof HUB_POLICIES, PermissionWay>> = {
  // Its plan agent refuses every edit but its plan file (packages/core/src/plugin/plan.ts) and still runs commands: they are refused here too,
  // and so are the general subagent's edits and commands, which a plan session could start.
  plan: { native: [MODE("plan")], session: { env: inline({ plan: [RULE("shell", "deny")], general: [RULE("edit", "deny"), RULE("shell", "deny")] }) }, policy: HUB_POLICIES.plan,
    note: "OpenCode 自己的 plan 代理（只许写它的计划文件），Hub 另外禁止它跑命令" },
  ask: { native: [MODE("build")], session: { env: inline({ build: ASKING("ask", "ask"), general: ASKING("ask", "ask") }) }, policy: HUB_POLICIES.ask },
  auto_edit: { native: [MODE("build")], session: { env: inline({ build: ASKING("allow", "ask"), general: ASKING("allow", "ask") }) }, policy: HUB_POLICIES.auto_edit },
  // No sandbox: what stands for one is the workspace's edge. Inside it nothing asks; a call that reaches outside asks (external_directory),
  // and the Hub allows a read or a command and refuses a change there (a refusal ends OpenCode's turn).
  auto: { native: [MODE("build")], session: { env: inline({ build: ASKING("allow", "allow"), general: ASKING("allow", "allow") }) },
    policy: { ...HUB_POLICIES.auto, edit: "deny" }, note: "OpenCode 没有沙箱：工作区内都不问；要改工作区外的文件时 Hub 替你拒绝（OpenCode 收到拒绝会停下这一回合），命令碰到工作区外照样放行" },
  full: { native: [MODE("build")], session: { env: inline({ build: [RULE("*", "allow")], general: [RULE("*", "allow")] }) }, policy: HUB_POLICIES.full },
};

export const opencodeFlavor: HarnessFlavor = {
  harnessId: "opencode",
  permission: ways,
  neutral: [MODE("build")],
  // packages/cli/src/acp/config-option.ts: `effort` (category thought_level) lists the running model's variants plus `default`, and only for
  // a model that has variants (packages/core/src/variant.ts: none…xhigh for OpenAI, low/medium/high/xhigh/max for Anthropic, low/high/max for
  // DeepSeek, none/thinking for a model that only turns thinking on); a model without variants has no option at all.
  effort: { option: { ids: ["effort"], category: "thought_level" }, values: { off: ["none"], low: ["low", "minimal"], medium: ["medium"], high: ["high", "thinking"], max: ["max", "xhigh"] },
    note: "按所用模型的变体给档；没有变体的模型没有思考强度可选" },
  asks: { read: false, edit: true, execute: true, note: "Hub 为每个会话下发的规则让它在改文件、跑命令、碰工作区外的路径前来问" },
  nativePlan: true,
  // packages/cli/src/acp/sessions.ts registerMcp: ACP `mcpServers` become runtime servers of the session's directory (experimental.mcp.add,
  // "until restart", nothing written). No per-session system prompt over ACP (an agent's `system` replaces its whole prompt), but MCP server
  // instructions go into the model's instructions as `<mcp_instructions>` (McpInstructions, core/mcp-guidance): the instructions go there.
  // The record is read as files with its own file tools (2026-11-13; verified on the installed program: it read the directory and answered from it).
  capabilities: { sessionMcp: "acp", systemPrompt: "mcp-instructions", planTool: "hub", resume: "native", fork: "native", attachments: "native", usage: "turn", record: "files" },
};
