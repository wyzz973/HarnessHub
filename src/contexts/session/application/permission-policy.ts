import { HUB_POLICIES, type HarnessFlavor, type PolicyAnswer, type RequestKind } from "../../../contracts/flavor.js";
import type { TurnText } from "../../../contracts/control.js";
import type { PermissionLevel } from "../../../contracts/protocol.js";
import { approvalRole, subjectOf } from "../domain/items-place.js";

/**
 * The Hub's answer to a permission request under the conversation's permission level (T3 Code's client policy): by the adapter's declaration
 * for that level (its `policy`), else the Hub's own table. A read, a search or a thought is never asked about; a question is always the user's;
 * without a level chosen the Harness's own behaviour stands and the user decides. `option` is the request's option the answer picks (the
 * "allow once" one, or the refusal); with none fitting, the user decides after all.
 */
export interface PolicyDecision { readonly answer: PolicyAnswer; readonly option: string | null; readonly kind: RequestKind }
const KIND_OF_FAMILY: Readonly<Record<string, RequestKind>> = { read: "read", search: "read", think: "read", fetch: "network", edit: "edit", delete: "edit", move: "edit", change: "edit", execute: "execute", mcp: "tool", subagent: "tool" };
export function requestKind(title: string, toolKind: string | undefined): RequestKind {
  const byTool = toolKind === undefined ? undefined : KIND_OF_FAMILY[toolKind];
  if (byTool !== undefined) return byTool;
  switch (subjectOf(title)) {
    case "file_read": return "read";
    case "file_change": return "edit";
    case "command": return "execute";
    case "network": return "network";
    case "tool": return "tool";
    default: return "other";
  }
}
export function policyDecision(flavor: HarnessFlavor | undefined, level: PermissionLevel | undefined, request: { readonly title: string; readonly options: readonly { readonly id: string; readonly name: string }[]; readonly question: boolean }, toolKind: string | undefined): PolicyDecision {
  const kind = requestKind(request.title, toolKind);
  if (request.question || level === undefined) return { answer: "ask", option: null, kind };
  const answer = (flavor?.permission[level].policy ?? HUB_POLICIES[level])[kind];
  if (answer === "ask") return { answer, option: null, kind };
  const roles = request.options.map(option => ({ id: option.id, role: approvalRole(option) }));
  const option = answer === "allow" ? (roles.find(row => row.role === "allow_once") ?? roles.find(row => row.role === "allow_session"))?.id ?? null : roles.find(row => row.role === "deny")?.id ?? null;
  return option === null ? { answer: "ask", option: null, kind } : { answer, option, kind };
}
/**
 * The words that tell the model it is read only, put in front of the user's words when "plan" is the Hub's policy (the Harness has no plan mode
 * of its own): its changes and commands are refused, and this says why before it tries. A command typed as such (a slash word) goes as it is.
 */
export const PLAN_NOTE = "（HarnessHub：当前是“只规划”，只读。不要修改文件，也不要运行命令；只阅读并给出方案。）";
export function withPlanNote(text: TurnText): TurnText {
  if (typeof text === "string") return text.trimStart().startsWith("/") ? text : PLAN_NOTE + "\n\n" + text;
  return text.user.trimStart().startsWith("/") ? text : { ...text, user: PLAN_NOTE + "\n\n" + text.user };
}
