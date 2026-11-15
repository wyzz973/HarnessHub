import { basename } from "node:path";
import type { ControlEvent, NativePlanEntry, NativeToolDetail, NativeUsage } from "../../../contracts/control.js";
import { unifiedDiff } from "../../../infrastructure/control/unified-diff.js";

/** Pure mapping of hermes-gateway-v1 frames to the Hub's events (research of 2026-11-14, B4). */
export type Row = Record<string, unknown>;
export const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function line(value: string, max = 200): string { const first = value.replace(/\s+/gu, " ").trim(); return first.length > max ? first.slice(0, max - 1) + "…" : first; }
function json(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  try { return JSON.stringify(value, null, 2); } catch { return undefined; }
}

// ---- tools ---------------------------------------------------------------------------------------------------------------

const READS = new Set(["read_file", "skill_view", "skills_list", "browser_snapshot", "browser_vision", "browser_get_images", "vision_analyze", "session_search"]);
const EDITS = new Set(["write_file", "patch", "skill_manage"]);
const EXECUTES = new Set(["terminal", "process", "execute_code", "browser_click", "browser_type", "browser_scroll", "browser_press", "browser_back"]);
const FETCHES = new Set(["web_search", "web_extract", "browser_navigate"]);
/** Hermes's own progressive disclosure (tools/tool_search.py): MCP and plugin tools behind three bridge tools. */
const BRIDGE = new Set(["tool_search", "tool_describe", "tool_call"]);
/** The tool kind the Hub's policy and page tell a Hermes tool by (acp_adapter/tools.py TOOL_KIND_MAP, plus MCP). */
export function toolKind(name: string): string {
  if (READS.has(name)) return "read";
  if (EDITS.has(name)) return "edit";
  if (name === "search_files") return "search";
  if (EXECUTES.has(name)) return "execute";
  if (FETCHES.has(name)) return "fetch";
  if (name === "delegate_task") return "subagent";
  if (name.startsWith("mcp_") || name.startsWith("mcp-") || BRIDGE.has(name)) return "mcp";
  if (name === "image_generate") return "image";
  return "other";
}
/** The title a call is shown by: its command, its file or its query, as Hermes's own viewers show it. */
export function toolTitle(name: string, args: Row): string {
  const path = text(args.path) ?? text(args.file_path);
  switch (name) {
    case "terminal": return line(text(args.command) ?? "命令");
    case "execute_code": return "运行代码";
    case "process": return "进程 " + line(text(args.action) ?? "");
    case "read_file": return "读取 " + (path ? basename(path) : "文件");
    case "write_file": return "写入 " + (path ? basename(path) : "文件");
    case "patch": return "修改 " + (path ? basename(path) : "文件");
    case "search_files": return "搜索 " + line(text(args.pattern) ?? text(args.query) ?? "文件");
    case "web_search": return "搜索网页 " + line(text(args.query) ?? "");
    case "web_extract": return "读取网页";
    case "browser_navigate": return "打开 " + line(text(args.url) ?? "网页");
    case "delegate_task": return "子 Agent · " + line(text(args.goal) ?? text(args.task) ?? "委派", 120);
    case "tool_search": return "查找工具 " + line(text(args.query) ?? "");
    case "tool_call": return "调用 " + line(text(args.name) ?? text(args.tool) ?? "工具");
    default: return line(name.replace(/^mcp[_-]/u, ""));
  }
}
/** One tool event from `tool.start` (running) or `tool.complete` (done, failed when Hermes says `is_error`). */
export function toolEvent(type: "tool.start" | "tool.complete", payload: Row, prior: NativeToolDetail | undefined): Extract<ControlEvent, { type: "tool" }> | null {
  const id = text(payload.tool_id) ?? text(payload.tool_call_id), name = text(payload.name) ?? text(payload.tool_name);
  if (id === undefined || name === undefined) return null;
  const args = record(payload.args) ?? {}, kind = toolKind(name), path = text(args.path) ?? text(args.file_path);
  const input = kind === "execute" ? text(args.command) ?? text(args.code) ?? json(payload.args) : json(payload.args);
  const detail: NativeToolDetail = { ...prior, kind, name, ...(input ? { input } : {}), ...(path ? { locations: [path] } : {}) };
  if (type === "tool.start") return { type: "tool", id: id.slice(0, 256), title: toolTitle(name, args), status: "in_progress", detail };
  const result = typeof payload.result === "string" ? parsed(payload.result) : payload.result, row = record(result);
  const output = text(payload.result_text) ?? (row !== null ? text(row.output) ?? text(row.content) ?? text(row.error) : undefined) ?? text(payload.summary) ?? json(payload.result);
  const exit = row !== null ? count(row.exit_code) : undefined, diff = text(payload.inline_diff);
  const failed = payload.is_error === true || (row !== null && (row.success === false || (typeof row.error === "string" && row.error !== "")));
  return { type: "tool", id: id.slice(0, 256), title: toolTitle(name, args), status: failed ? "failed" : "completed",
    detail: { ...detail, ...(output ? { output } : {}), ...(diff ? { diff } : {}), ...(exit === undefined ? {} : { exitCode: exit }) } };
}
function parsed(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return value; } }

// ---- plan ----------------------------------------------------------------------------------------------------------------

/** Hermes's todo snapshot (`todo.updated`, tool_progress._normalize_todo_state): `{id, content, status}` rows, status pending / in_progress / completed / cancelled. */
export function planEvent(todos: unknown): Extract<ControlEvent, { type: "plan" }> | null {
  if (!Array.isArray(todos)) return null;
  const entries: NativePlanEntry[] = todos.flatMap(value => {
    const row = record(value), content = text(row?.content) ?? text(row?.text) ?? text(row?.title);
    if (row === null || content === undefined || row.status === "cancelled") return [];
    return [{ content, status: row.status === "completed" ? "completed" as const : row.status === "in_progress" ? "in_progress" as const : "pending" as const }];
  });
  return { type: "plan", entries };
}

// ---- usage ---------------------------------------------------------------------------------------------------------------

/**
 * The Turn's usage (2026-11-15, read on v0.23.1): `prompt.receipt`'s `usage` is this admission's own (`input_tokens` with the cache read
 * in it, `output_tokens`); its `result` carries the session agent's running totals, so the cache read and the cost of this Turn are the
 * totals' difference from the Turn before, when this connection saw that one and they did not go down (an agent built anew restarts them).
 */
export interface Totals { readonly cacheRead: number; readonly cacheWrite: number; readonly reasoning: number; readonly cost: number | null }
export function totalsOf(result: Row | null): Totals | null {
  if (result === null) return null;
  const cacheRead = count(result.cache_read_tokens), cacheWrite = count(result.cache_write_tokens), reasoning = count(result.reasoning_tokens);
  if (cacheRead === undefined) return null;
  const cost = typeof result.estimated_cost_usd === "number" && Number.isFinite(result.estimated_cost_usd) && result.estimated_cost_usd >= 0 ? result.estimated_cost_usd : null;
  return { cacheRead, cacheWrite: cacheWrite ?? 0, reasoning: reasoning ?? 0, cost };
}
export function turnUsage(usage: Row | null, now: Totals | null, before: Totals | null, context: NativeUsage["context"] | undefined): NativeUsage | null {
  const input = count(usage?.input_tokens), output = count(usage?.output_tokens), total = count(usage?.total_tokens);
  if (input === undefined && output === undefined) return context === undefined ? null : { context };
  const grown = now !== null && before !== null && now.cacheRead >= before.cacheRead && now.cacheWrite >= before.cacheWrite && now.reasoning >= before.reasoning;
  // The Hub counts the cache read inside the input (Codex's convention), as this receipt does.
  const cached = grown ? Math.min(input ?? Infinity, now.cacheRead - before.cacheRead) : undefined;
  const turn = { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
    ...(cached === undefined ? {} : { cachedInput: cached, cacheWrite: now!.cacheWrite - before!.cacheWrite, reasoning: Math.min(output ?? Infinity, now!.reasoning - before!.reasoning) }),
    ...(total === undefined ? {} : { total }), own: true as const };
  const cost = grown && now.cost !== null && before.cost !== null && now.cost >= before.cost ? { amount: now.cost - before.cost, currency: "USD", scope: "turn" as const } : undefined;
  return { turn, ...(context === undefined ? {} : { context }), ...(cost === undefined ? {} : { cost }) };
}
/** The context the session's agent reports (`session.usage`'s status-bar `usage`: `context_used`, `context_max`). */
export function contextOf(payload: Row): NativeUsage["context"] | undefined {
  const usage = record(payload.usage), used = count(usage?.context_used) ?? count(payload.last_prompt_tokens), size = count(usage?.context_max) ?? count(payload.context_length);
  return used === undefined ? undefined : { used, ...(size ? { size } : {}) };
}

// ---- approvals and questions ----------------------------------------------------------------------------------------------

/**
 * Hermes's approval choices (tools/approval.py), as the Hub's options (their ids name their roles, items-place.ts approvalRole), and what each
 * changes beyond this request.
 */
const CHOICES: Readonly<Record<string, { readonly id: string; readonly name: string; readonly note?: string }>> = {
  once: { id: "allow_once", name: "允许一次" },
  session: { id: "allow_session", name: "这个会话内都允许", note: "只在这个 HarnessHub 会话内放行，不写 Hermes 的配置。" },
  always: { id: "allow_always", name: "总是允许", note: "会写入 Hermes 自己的配置（command_allowlist），之后 Hermes 的所有会话（包括终端和消息网关）遇到同一类危险命令都不再询问。" },
  deny: { id: "deny", name: "拒绝" },
};
/** The Hermes choice an option id stands for. */
export function choiceOf(option: string): string | undefined { return Object.entries(CHOICES).find(([, choice]) => choice.id === option)?.[0]; }
export interface ApprovalPrompt {
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly toolKind: string;
  /** How long Hermes waits for the answer before it gives up on the request (`timeout_s`), in milliseconds; null when it says none. */
  readonly waitMs: number | null;
}
/** An `approval.request` (a dangerous command, or an edit proposal for an ACP session's edit approval) as the Hub asks it. */
export function approvalPrompt(payload: Row): ApprovalPrompt {
  const choices = Array.isArray(payload.choices) ? payload.choices.filter((choice): choice is string => typeof choice === "string" && Object.hasOwn(CHOICES, choice)) : ["once", "deny"];
  const edit = record(payload.edit), command = text(payload.command), description = text(payload.description);
  const path = edit === null ? undefined : text(edit.path) ?? text(edit.file_path);
  const listed = choices.length ? choices : ["once", "deny"];
  const notes = listed.flatMap(choice => CHOICES[choice]!.note === undefined ? [] : ["选“" + CHOICES[choice]!.name + "”" + CHOICES[choice]!.note!]);
  // An edit proposal (acp_adapter/edit_approval.py EditProposal): the file's text before (null for a new file) and after.
  const after = edit === null ? undefined : typeof edit.new_text === "string" ? edit.new_text : undefined;
  const diff = edit === null ? undefined : text(edit.diff) ?? (after !== undefined && path !== undefined ? unifiedDiff(path, typeof edit.old_text === "string" ? edit.old_text : null, after) : undefined);
  const detail = [edit === null ? (command ? "$ " + command : undefined) : diff, description, ...notes].filter((part): part is string => part !== undefined).join("\n\n");
  return { title: edit !== null ? "修改 " + (path ? basename(path) : "文件") : "运行命令：" + line(command ?? description ?? "危险命令", 160),
    ...(detail ? { detail } : {}), options: listed.map(choice => ({ id: CHOICES[choice]!.id, name: CHOICES[choice]!.name })), toolKind: edit !== null ? "edit" : "execute", waitMs: waitOf(payload) };
}
/** Hermes's own wait for a prompt (`timeout_s`), less a margin so the Hub closes it first. */
export function waitOf(payload: Row): number | null {
  const seconds = typeof payload.timeout_s === "number" && Number.isFinite(payload.timeout_s) && payload.timeout_s > 0 ? payload.timeout_s : null;
  return seconds === null ? null : Math.max(0, seconds * 1000 - 2000);
}
/** A `clarify.request`: the question, its choices, and free text (an empty answer skips it). */
export function clarifyPrompt(payload: Row): { readonly title: string; readonly options: readonly { readonly id: string; readonly name: string }[] } {
  const choices = Array.isArray(payload.choices) ? payload.choices.filter((choice): choice is string => typeof choice === "string" && choice.trim() !== "").slice(0, 32) : [];
  return { title: line(text(payload.question) ?? "Hermes 有个问题", 1024), options: [...choices.map((choice, index) => ({ id: "choice:" + index, name: line(choice, 200) })), { id: "answer", name: "回答" }, { id: "skip", name: "跳过" }] };
}

// ---- models ---------------------------------------------------------------------------------------------------------------

/** A model as the Hub names it: `<provider>:<model>`, the provider lower-cased, as Hermes's ACP named it (server.py `_encode_model_choice`), so a choice made before stays valid. */
export function modelId(provider: string, model: string): string { return provider.toLowerCase() + ":" + model; }
export function splitModel(id: string): { readonly provider?: string; readonly model: string } {
  const at = id.indexOf(":");
  return at > 0 && /^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(id.slice(0, at)) ? { provider: id.slice(0, at), model: id.slice(at + 1) } : { model: id };
}

// ---- history ----------------------------------------------------------------------------------------------------------------

const COMPACTION = /^\s*\[(?:CONTEXT COMPACTION|CONTEXT SUMMARY\])/u, SUMMARY_END = "--- END OF CONTEXT SUMMARY";
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap(part => { const row = record(part); return row !== null && typeof row.text === "string" ? [row.text] : []; }).join("\n") : "";
}
/**
 * The user turns a rewind can go back to (hermes_cli/gateway_chat_commands.py `_user_turns`): live user rows with a durable `row_id`, typed by a
 * person (no display-only kind but a typed steer), never archived by a compression, and never a compaction handoff that carries no live ask.
 */
export function userTurns(messages: unknown): readonly { readonly rowId: number; readonly text: string }[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap(value => {
    const row = record(value);
    if (row === null || row.role !== "user" || typeof row.row_id !== "number" || !Number.isSafeInteger(row.row_id) || row.row_id <= 0 || row.archived === true) return [];
    if (row.display_kind !== undefined && row.display_kind !== null && row.display_kind !== "" && row.display_kind !== "steer") return [];
    const said = contentText(row.content);
    if (COMPACTION.test(said) && !said.slice(said.indexOf(SUMMARY_END) + SUMMARY_END.length).replace(/^[^\n]*\n/u, "").trim()) return [];
    return [{ rowId: row.row_id, text: said }];
  });
}
/** A stored transcript as the user's words and the replies, for an import: tool rows and reasoning are left out. */
export function historyOf(messages: unknown): { role: "user" | "assistant"; text: string }[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap(value => {
    const row = record(value);
    if (row === null || row.archived === true || (row.role !== "user" && row.role !== "assistant")) return [];
    const said = contentText(row.content).trim();
    return said ? [{ role: row.role as "user" | "assistant", text: said }] : [];
  });
}

// ---- failures ----------------------------------------------------------------------------------------------------------------

/** A failed turn's error (`message.complete` `error_surface`, `failure_reason`): a fixed code and Hermes's short reason, never its raw text. */
export function turnFailure(payload: Row): { readonly code: string; readonly message: string } {
  const surface = record(payload.error_surface), code = text(surface?.code), reason = text(payload.failure_reason);
  const plain = (value: string | undefined) => value !== undefined && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : undefined;
  const said = plain(code) ?? plain(reason);
  if (said !== undefined && /rate|quota|limit/iu.test(said)) return { code: "MODEL_RATE_LIMITED", message: "Hermes 的模型请求被限流或额度不足（" + said + "）。" };
  if (said !== undefined && /auth|credential|key/iu.test(said)) return { code: "MODEL_AUTH_FAILED", message: "Hermes 的模型凭据不可用（" + said + "）。" };
  return { code: "MODEL_REQUEST_FAILED", message: "Hermes 的这一轮失败了" + (said === undefined ? "" : "（" + said + "）") + "，原因记录在 Hermes 自己的日志里。" };
}
