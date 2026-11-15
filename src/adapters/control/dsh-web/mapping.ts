import type { BackendResult, NativeModelCatalog, NativeOption, NativePlanEntry, NativeSessionImport, NativeToolDetail } from "../../../contracts/control.js";
import { unifiedDiff } from "../../../infrastructure/control/unified-diff.js";
import { changeOf, DSH_FAILURES, DSH_TOOL_KINDS, failureOf } from "../dsh.js";

/**
 * What the Web host's durable Session events and its live Assistant frames mean to the Hub (dsh-session SessionEvent, dsh-api-session-controller
 * follow, 0.2.2-rc.1). Pure; the driver feeds it what one follow stream delivers.
 */

export function field(value: unknown, key: string): unknown { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
export function text(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function amount(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }

/** The Hub's id of a dsh model route: the one dsh's ACP gives it (`["<provider>","<model>"]`), so that a conversation's model reads the same on either driver. */
export function modelId(provider: string, model: string): string { return JSON.stringify([provider, model]); }
export function routeOf(id: string): { readonly provider: string; readonly model: string } | null {
  try { const value: unknown = JSON.parse(id); return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string" && value[0] && value[1] ? { provider: value[0], model: value[1] } : null; }
  catch { return null; }
}
/** The thinking option every dsh route has (dsh-llm-deepseek: off, low, high, max), the id and category its ACP gives it. */
export const EFFORT_OPTION = "reasoning_effort";
export const DSH_EFFORTS: NativeOption = { id: EFFORT_OPTION, name: "Reasoning effort", category: "thought_level", currentValue: "high",
  values: [{ value: "off", name: "Off" }, { value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] };
/** `session/modelCatalog` as the Hub's catalog: each model of each group, with its reasoning efforts; the default as dsh's own. */
export function catalogOf(value: unknown, extra: readonly { readonly provider: string; readonly model: string }[]): Omit<NativeModelCatalog, "authentication"> {
  const models: { id: string; name: string; options?: NativeOption[] }[] = [];
  for (const group of Array.isArray(field(value, "groups")) ? field(value, "groups") as unknown[] : []) {
    const provider = text(field(group, "id"));
    if (provider === undefined) continue;
    for (const row of Array.isArray(field(group, "models")) ? field(group, "models") as unknown[] : []) {
      const model = text(field(row, "id"));
      if (model === undefined) continue;
      const efforts = field(field(row, "reasoning"), "efforts"), values = Array.isArray(efforts) ? efforts.flatMap(item => { const id = text(field(item, "id")); return id ? [{ value: id, name: text(field(item, "name")) ?? id }] : []; }) : [];
      const current = text(field(field(row, "reasoning"), "defaultEffort")) ?? values[0]?.value;
      models.push({ id: modelId(provider, model), name: text(field(row, "name")) ?? model,
        ...(values.length && current !== undefined ? { options: [{ id: EFFORT_OPTION, name: "Reasoning effort", category: "thought_level", currentValue: current, values }] } : {}) });
    }
  }
  const fallback = field(value, "default"), defaultRoute = text(field(fallback, "provider")) && text(field(fallback, "model")) ? { provider: text(field(fallback, "provider"))!, model: text(field(fallback, "model"))! } : null;
  // A route a session runs that the catalog does not list (dsh keeps it, as its ACP does): kept with dsh's efforts.
  for (const route of [...(defaultRoute === null ? [] : [defaultRoute]), ...extra]) {
    const id = modelId(route.provider, route.model);
    if (!models.some(row => row.id === id)) models.push({ id, name: route.model, options: [DSH_EFFORTS] });
  }
  return { models, defaultModel: defaultRoute === null ? null : modelId(defaultRoute.provider, defaultRoute.model), canSelect: models.length > 0 };
}

/** One tool call of the Turn as its durable `tool/call` gave it, or its live block. */
export interface ToolCall { readonly id: string; readonly name: string; readonly args: unknown }
export function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
/** dsh names each call by its tool: its kind by the tool (DSH_TOOL_KINDS), an MCP tool's `mcp__<server>__<tool>` as mcp. */
export function toolKind(name: string): string | undefined { return DSH_TOOL_KINDS[name] ?? (/^mcp__|__/u.test(name) ? "mcp" : undefined); }
function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return undefined;
  try { return JSON.stringify(value, null, 2); } catch { return undefined; }
}
export function callDetail(call: ToolCall): NativeToolDetail {
  const kind = toolKind(call.name), command = field(call.args, "command"), input = typeof command === "string" ? command : preview(call.args);
  const path = text(field(call.args, "file_path")) ?? text(field(call.args, "path"));
  return { ...(kind === undefined ? {} : { kind }), name: call.name, ...(input ? { input } : {}), ...(path ? { locations: [path] } : {}) };
}
/** A durable `tool/result`: its text, failure, and for an edit the change its `meta` holds (dsh-tool-fs `diffs`, or the created file). */
export function resultDetail(call: ToolCall, result: unknown): { readonly failed: boolean; readonly detail: NativeToolDetail } {
  const message = field(result, "message"), content = field(message, "content");
  const output = Array.isArray(content) ? content.flatMap(item => field(item, "type") === "text" && typeof field(item, "text") === "string" ? [field(item, "text") as string] : []).join("\n") : "";
  const failed = field(message, "isError") === true || field(result, "error") !== undefined;
  const diff = toolKind(call.name) === "edit" ? changeOf({ arguments: call.args }, field(result, "meta")) : null;
  return { failed, detail: { ...callDetail(call), ...(output ? { output } : {}), ...(diff === null ? {} : { diff }) } };
}
/** dsh's own task list (`todo_write {todos: [{content, status}]}`, the whole list each time, and its durable `todo/write`) as the Turn's plan. */
export function planOf(todos: unknown): readonly NativePlanEntry[] | null {
  if (!Array.isArray(todos)) return null;
  return todos.flatMap(item => {
    const content = field(item, "content"), status = field(item, "status");
    return typeof content === "string" && content.trim() ? [{ content, status: status === "in_progress" || status === "completed" ? status : "pending" as const }] : [];
  });
}
/** What an approval would allow: the command, or the change a write or edit would make, and dsh's own reason (its Chinese wording when it gives one). */
export function approvalDetail(call: ToolCall | undefined, request: Readonly<Record<string, unknown>>): string {
  const args = call?.args, command = text(field(args, "command")), path = text(field(args, "file_path"));
  const content = text(field(args, "content")), before = text(field(args, "old_string")), after = text(field(args, "new_string"));
  const action = command !== undefined ? "命令：" + command
    : path !== undefined && content !== undefined ? unifiedDiff(path, null, content)
    : path !== undefined && before !== undefined && after !== undefined ? unifiedDiff(path, before, after)
    : path !== undefined ? "文件：" + path : "";
  const reason = text(field(field(request, "displayReason"), "zh")) ?? text(field(request, "reason"));
  return [action, reason === undefined ? "" : "原因：" + reason].filter(Boolean).join("\n");
}

/** Token counts of one model request (`assistant/message.usage`: DeepSeek's Anthropic-format, the input without the cache, the output with the thinking). */
export interface Counters { input: number; output: number; cachedInput: number; cacheWrite: number; total: number }
export function countersOf(usage: unknown): Counters | null {
  if (usage === null || typeof usage !== "object") return null;
  return { input: amount(field(usage, "inputTokens")), output: amount(field(usage, "outputTokens")), cachedInput: amount(field(usage, "cacheReadTokens")),
    cacheWrite: amount(field(usage, "cacheWriteTokens")), total: amount(field(usage, "totalTokens")) };
}
export function added(sum: Counters | null, more: Counters): Counters {
  return sum === null ? { ...more } : { input: sum.input + more.input, output: sum.output + more.output, cachedInput: sum.cachedInput + more.cachedInput, cacheWrite: sum.cacheWrite + more.cacheWrite, total: sum.total + more.total };
}
/** The text and the reasoning of a durable `assistant/message`. */
export function messageParts(message: unknown): { readonly text: string; readonly reasoning: string } {
  const content = field(message, "content"), blocks = Array.isArray(content) ? content : [];
  const of = (type: string) => blocks.flatMap(block => field(block, "type") === type && typeof field(block, "text") === "string" ? [field(block, "text") as string] : []).join("");
  return { text: of("text"), reasoning: of("reasoning") };
}

/** How the last turn of a Hub Turn ended (`turn/end.reason`: completed, max-tokens, aborted, interrupted, blocked, error) as the Turn's result. */
export function turnResult(kind: string | null, code: string | null, stopping: boolean): BackendResult {
  if (kind === null || kind === "completed") return { status: "completed", reason: "end_turn" };
  if (kind === "aborted" || kind === "interrupted") return stopping || kind === "interrupted" ? { status: "cancelled", reason: "cancelled" } : { status: "failed", reason: "native_error", error: DSH_FAILURES.aborted! };
  if (kind === "max-tokens") return { status: "failed", reason: "max_tokens", error: { code: "NATIVE_OUTPUT_LIMIT", message: "dsh 的回答到了模型的输出上限，这一轮没有做完。" } };
  if (kind in DSH_FAILURES) return { status: "failed", reason: "native_error", error: failureOf(kind, code) };
  return { status: "failed", reason: "native_error", error: { code: "MODEL_REQUEST_FAILED", message: "dsh 的这一轮以 " + kind + " 结束，没有做完。" } };
}

/** A session's history from its durable events (`session/events` pages, oldest first): the user's words and dsh's replies, each run of one role as one message. */
export function historyOf(records: readonly unknown[]): NativeSessionImport["history"] {
  const history: { role: "user" | "assistant"; text: string }[] = [];
  for (const row of records) {
    const event = field(row, "event"), type = field(event, "type"), data = field(event, "data");
    let role: "user" | "assistant" | null = null, said = "";
    if (type === "user/message" && field(field(data, "source"), "kind") === "user") {
      role = "user";
      const content = field(data, "content");
      said = Array.isArray(content) ? content.map(block => field(block, "type") === "text" ? text(field(block, "text")) ?? "" : field(block, "type") === "image" ? "[图片]" : "").join("") : "";
    } else if (type === "assistant/message") { role = "assistant"; said = messageParts(field(data, "message")).text; }
    if (role === null || !said) continue;
    const last = history.at(-1);
    if (last?.role === role) last.text += "\n\n" + said; else history.push({ role, text: said });
  }
  return history;
}
