import { HUB_POLICIES, type HarnessFlavor, type PolicyAnswer, type RequestKind } from "../../../contracts/flavor.js";
import type { TurnText } from "../../../contracts/control.js";
import type { PermissionLevel } from "../../../contracts/protocol.js";
import { approvalRole, subjectOf } from "../domain/items-place.js";
import { isHubToolCall } from "../domain/protocol/tools.js";
import { hubCommandOnly } from "../../../contracts/table.js";

/**
 * The Hub's answer to a permission request under the conversation's permission level (T3 Code's client policy): by the adapter's declaration
 * for that level (its `policy`), else the Hub's own table. A read, a search or a thought is never asked about; a question is always the user's;
 * without a level chosen the Harness's own behaviour stands and the user decides. `option` is the request's option the answer picks (the
 * "allow once" one, or the refusal); with none fitting, the user decides after all.
 */
export interface PolicyDecision { readonly answer: PolicyAnswer; readonly option: string | null; readonly kind: RequestKind }
const KIND_OF_FAMILY: Readonly<Record<string, RequestKind>> = { read: "read", search: "read", think: "read", fetch: "network", edit: "edit", delete: "edit", move: "edit", change: "edit", execute: "execute", mcp: "tool", subagent: "tool" };
/**
 * The call a request is about, as the Hub placed it (its item): what tells the request when it says nothing of its own (DeepSeek Harness's
 * has no title and no kind). `hub`: the call is one of the Hub's own tools (the item says so).
 */
export interface RequestCall { readonly type: string; readonly title?: string; readonly name?: string; readonly hub?: boolean;
  /** The command line of a call that runs one. */
  readonly command?: string }
/**
 * Whether a request is about one of the Hub's own tools (they read this conversation back or tell the Hub how the Turn goes, and touch
 * nothing of the user's): the Hub allows those itself at every level ("plan" included), so that a Harness that asks about MCP tools does
 * not ask the user before the task list is shown.
 */
function aboutHubTool(title: string, call: RequestCall | undefined): boolean {
  if (call?.hub === true) return true;
  // The same tools as a command of the conversation (HubToolsEntry `cli`): a line that is that command's call and nothing else.
  return [title, call?.name, call?.title, call?.command].some(text => text !== undefined && text.trim() !== "" && (isHubToolCall({ title: text }) || hubCommandOnly(text) !== null));
}
function kindOfTitle(title: string): RequestKind {
  switch (subjectOf(title)) {
    case "file_read": return "read";
    case "file_change": return "edit";
    case "command": return "execute";
    case "network": return "network";
    case "tool": return "tool";
    default: return "other";
  }
}
function kindOfCall(call: RequestCall): RequestKind {
  switch (call.type) {
    case "command": return "execute";
    case "file_change": return "edit";
    case "file_read": return "read";
    case "mcp_tool": return "tool";
    default: { const named = [call.name, call.title].map(text => text === undefined ? "other" : kindOfTitle(text)).find(kind => kind !== "other"); return named ?? "other"; }
  }
}
/** What a request is about: by the kinds the program gave (the request's own, then the call's), then the request's title, then the call as the Hub placed it. */
export function requestKind(title: string, toolKinds: readonly (string | undefined)[], call?: RequestCall): RequestKind {
  for (const toolKind of toolKinds) { const byTool = toolKind === undefined ? undefined : KIND_OF_FAMILY[toolKind]; if (byTool !== undefined) return byTool; }
  const byTitle = kindOfTitle(title);
  return byTitle !== "other" || call === undefined ? byTitle : kindOfCall(call);
}
export function policyDecision(flavor: HarnessFlavor | undefined, level: PermissionLevel | undefined, request: { readonly title: string; readonly options: readonly { readonly id: string; readonly name: string }[]; readonly question: boolean }, toolKinds: readonly (string | undefined)[], call?: RequestCall): PolicyDecision {
  const hub = !request.question && aboutHubTool(request.title, call), kind = hub ? "read" : requestKind(request.title, toolKinds, call);
  if (request.question || level === undefined) return { answer: "ask", option: null, kind };
  const answer = hub ? "allow" : (flavor?.permission[level].policy ?? HUB_POLICIES[level])[kind];
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
/** The Turn's text with a note of the Hub's put before the user's words; a command typed as such (a slash word) goes as it is. */
export function withHubNote(text: TurnText, note: string): TurnText {
  if (typeof text === "string") return text.trimStart().startsWith("/") ? text : note + "\n\n" + text;
  return text.user.trimStart().startsWith("/") ? text : { ...text, user: note + "\n\n" + text.user };
}
export function withPlanNote(text: TurnText): TurnText {
  if (typeof text === "string") return text.trimStart().startsWith("/") ? text : PLAN_NOTE + "\n\n" + text;
  return text.user.trimStart().startsWith("/") ? text : { ...text, user: PLAN_NOTE + "\n\n" + text.user };
}
