import { HUB_POLICIES, type HarnessFlavor, type PermissionWay } from "../../contracts/flavor.js";
import { MODE } from "./common.js";

/**
 * OpenCode 2 through its own server (2.3.0; research of 2026-11-14 §3a). Its permissions are rules `{action, resource, effect: allow|ask|deny}`, the last
 * that matches winning, every built-in agent starting from `* * allow` (only reading `.env` files asks), so out of the box it asks about nothing. A level is
 * the session's own ruleset (`permissions` on `POST /session`, `PATCH /session/{id}`), after the agent's rules, for that session only: nothing is written
 * into the user's configuration, and a resumed session gets the level it now runs at. Like T3 Code's sessionRules, the driver adds what the user allowed
 * for the session, the agent's own path allowances (plan keeps its plan files writable) and the Hub's own tools.
 *
 * - A refusal carries words (`reply {decision: "reject", message}`), so the model sees why and goes on; "拒绝并停止" refuses without words, which ends the turn.
 * - "本次会话允许" is a rule of the session, never OpenCode's `always` (that one is saved into the project's database).
 * - Managed settings (an MDM profile) keep their word over a session's rules.
 */
const RULE = (action: string, effect: "allow" | "ask" | "deny", resource = "*") => ({ action, resource, effect });
const ASKING = (edit: "allow" | "ask", shell: "allow" | "ask", network: "allow" | "ask") => [RULE("edit", edit), RULE("shell", shell), RULE("external_directory", "ask"),
  ...(network === "ask" ? [RULE("webfetch", "ask"), RULE("websearch", "ask")] : [])];
const ways: Readonly<Record<keyof typeof HUB_POLICIES, PermissionWay>> = {
  // Its plan agent refuses every edit but its plan file and still runs commands: they are refused here too.
  plan: { native: [MODE("plan")], session: { rules: [RULE("shell", "deny"), RULE("edit", "deny")] }, policy: HUB_POLICIES.plan, note: "OpenCode 自己的 plan 代理（只许写它的计划文件），Hub 另外禁止它跑命令" },
  ask: { native: [MODE("build")], session: { rules: ASKING("ask", "ask", "ask") }, policy: HUB_POLICIES.ask },
  auto_edit: { native: [MODE("build")], session: { rules: ASKING("allow", "ask", "ask") }, policy: HUB_POLICIES.auto_edit },
  // No sandbox: what stands for one is the workspace's edge. Inside it nothing asks; a call that reaches outside asks (external_directory), and the Hub
  // allows a read or a command and refuses a change there, with words, so the model goes on.
  auto: { native: [MODE("build")], session: { rules: ASKING("allow", "allow", "allow") }, policy: { ...HUB_POLICIES.auto, edit: "deny" },
    note: "OpenCode 没有沙箱：工作区内都不问；要改工作区外的文件时 Hub 替你拒绝，它会接着做别的；命令碰到工作区外照样放行" },
  full: { native: [MODE("build")], session: { rules: [RULE("*", "allow")] }, policy: HUB_POLICIES.full },
};

export const opencodeFlavor: HarnessFlavor = {
  harnessId: "opencode",
  permission: ways,
  neutral: [MODE("build")],
  // The running model's variants (`GET /model` `variants[]`: low/high/max for DeepSeek, none…xhigh for OpenAI, …) plus `default`; a model without variants
  // has no option at all. The variant goes with the session's model (`POST /session/{id}/model`), so it changes without a new session.
  effort: { option: { ids: ["effort"], category: "thought_level" }, values: { off: ["none"], low: ["low", "minimal"], medium: ["medium"], high: ["high", "thinking"], max: ["max", "xhigh"] },
    note: "按所用模型的变体给档；没有变体的模型没有思考强度可选" },
  asks: { read: false, edit: true, execute: true, note: "Hub 为每个会话写的规则让它在改文件、跑命令、碰工作区外的路径前来问" },
  nativePlan: true,
  // The Hub's tools are a runtime MCP server of the session's directory on the Hub's own `opencode serve` (`PUT /experimental/mcp/harnesshub`), the
  // instructions the session's own entry (`instructions/entries/harnesshub`); nothing is written. Tools load on demand natively (OpenCode 2's `execute`,
  // Code Mode). OpenCode 2.3.0 has no task list of its own unless the user turns on its experimental `todowrite` (`experimental.todo`): the Hub's stays.
  // Words in the middle of a turn are a steer of the same turn (`prompt {delivery: "steer"}`, taken at its next step).
  capabilities: { sessionMcp: "runtime-mcp", systemPrompt: "session-instructions", planTool: "hub", toolLoad: "native", questions: "native", resume: "native", fork: "native", rollback: "native", attachments: "native",
    usage: "turn", record: "files", steer: "native" },
};
