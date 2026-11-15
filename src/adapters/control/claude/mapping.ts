import { basename } from "node:path";
import type { NativeLimit, NativePlanEntry, NativeToolDetail, NativeUsage } from "../../../contracts/control.js";
import { diffPath, unifiedDiff } from "../../../infrastructure/control/unified-diff.js";
import { usageRequest } from "../relay-turn.js";

/**
 * Pure mappings of the Agent SDK's messages to the Hub's control events: tool calls and their results, the task list, usage, the account's
 * limits and the user's questions. The tool classification, the command output and the file-change diff are ported from T3 Code; the rest
 * reads the SDK's own fields as the research of 2026-11-14 §4 names them.
 */
export type Row = Readonly<Record<string, unknown>>;
export function record(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
export const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
/** One line of at most `max` characters. */
export function line(value: string, max = 400): string { const one = value.replace(/\s+/gu, " ").trim(); return one.length <= max ? one : one.slice(0, max - 1) + "…"; }
function json(value: unknown): string | undefined { if (value === undefined) return undefined; if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return undefined; } }

// ---- tools -----------------------------------------------------------------------------------------------------------------

/**
 * 移植自 T3 Code（MIT）d19467a5 apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts（CLAUDE_KNOWN_TOOL_CLASSIFICATIONS、
 * normalizedClaudeToolName）：Claude Code's tools by family, by their name's letters only. The family is what the Hub's policy and its items read
 * (NativeToolDetail.kind); a tool not listed is an MCP call when its name says so, else a tool of its own.
 */
const FAMILIES: Readonly<Record<string, string>> = {
  bash: "execute", bashoutput: "execute", killshell: "execute", killbash: "execute", monitor: "execute", powershell: "execute",
  read: "read", notebookread: "read", lsp: "read",
  edit: "edit", multiedit: "edit", write: "edit", notebookedit: "edit",
  grep: "search", glob: "search", ls: "search", toolsearch: "search",
  webfetch: "fetch", websearch: "fetch",
  task: "subagent", agent: "subagent",
  askuserquestion: "think", exitplanmode: "think", enterplanmode: "think", todowrite: "think", taskcreate: "think", taskupdate: "think", tasklist: "think", taskget: "think",
};
const normalized = (name: string): string => name.toLowerCase().replace(/[\s_-]/gu, "");
export function toolFamily(name: string): string { return FAMILIES[normalized(name)] ?? (name.startsWith("mcp__") ? "mcp" : "other"); }
/** The Claude Code tools whose calls are its own task list, shown as the Turn's plan and not as work. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
function field(input: Row, keys: readonly string[]): string | undefined {
  for (const key of keys) { const value = text(input[key]); if (value !== undefined) return value.trim(); }
  return undefined;
}
const PATH_KEYS = ["file_path", "notebook_path", "path", "filename", "fileName"] as const;
/** A tool call as the Hub shows it: a title in the Hub's words, the family, the native name, the input, the paths it names. */
export function toolCall(name: string, input: Row, parentId?: string): { readonly title: string; readonly detail: NativeToolDetail } {
  const kind = toolFamily(name), path = field(input, PATH_KEYS), shown = json(input);
  const detail: NativeToolDetail = { kind, name, ...(shown ? { input: shown } : {}), ...(path ? { locations: [path] } : {}), ...(parentId ? { parentId } : {}) };
  const command = field(input, ["command", "cmd", "script"]);
  const title = (() => {
    switch (normalized(name)) {
      case "bash": case "powershell": return command ? line(command) : name;
      case "read": case "notebookread": return "读取 " + (path ? basename(path) : "文件");
      case "edit": case "multiedit": case "notebookedit": return "修改 " + (path ? basename(path) : "文件");
      case "write": return "写入 " + (path ? basename(path) : "文件");
      case "grep": return "搜索 " + line(field(input, ["pattern"]) ?? "内容", 200);
      case "glob": return "查找 " + line(field(input, ["pattern"]) ?? "文件", 200);
      case "webfetch": return "打开网页 " + line(field(input, ["url"]) ?? "", 512);
      case "websearch": return "搜索：" + line(field(input, ["query"]) ?? "网页", 200);
      case "task": case "agent": return "子 Agent · " + line(field(input, ["description", "subagent_type"]) ?? "任务", 120);
      case "toolsearch": return "查找工具 " + line(field(input, ["query"]) ?? "", 200);
      case "skill": return "技能 " + line(field(input, ["skill", "command", "name"]) ?? "", 120);
      default: return name.startsWith("mcp__") ? name.slice(5).replace("__", ".") : name;
    }
  })();
  return { title: title || name, detail };
}
/** The text of a tool_result block's content: a string, or its text blocks joined. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => { const row = record(part); return row?.type === "text" && typeof row.text === "string" ? [row.text] : []; }).join("\n");
}
/** 移植自 T3 Code（MIT）d19467a5 ClaudeAdapterV2.ts claudeCommandOutputText：stdout, then stderr on a line of its own. */
function commandOutput(structured: Row | null): string | undefined {
  if (structured === null) return undefined;
  const out = typeof structured.stdout === "string" && structured.stdout.trim() ? structured.stdout : "", err = typeof structured.stderr === "string" && structured.stderr.trim() ? structured.stderr : "";
  if (!out && !err) return undefined;
  return out && err && !out.endsWith("\n") ? out + "\n" + err : out + err;
}
/**
 * 移植自 T3 Code（MIT）d19467a5 ClaudeAdapterV2.ts claudeFileChangeText：the unified diff of an Edit or Write from its structured output
 * (`structuredPatch` hunks; a created file from its content).
 */
function fileDiff(structured: Row | null): string | undefined {
  const path = text(structured?.filePath);
  if (structured === null || path === undefined) return undefined;
  const hunks = Array.isArray(structured.structuredPatch) ? structured.structuredPatch.map(record).filter((hunk): hunk is Row => hunk !== null) : [];
  if (hunks.length === 0) return structured.type === "create" && typeof structured.content === "string" ? unifiedDiff(path, null, structured.content) : undefined;
  const header = "--- a/" + diffPath(path) + "\n+++ b/" + diffPath(path) + "\n";
  return header + hunks.map(hunk => "@@ -" + Number(hunk.oldStart) + "," + Number(hunk.oldLines) + " +" + Number(hunk.newStart) + "," + Number(hunk.newLines) + " @@\n"
    + (Array.isArray(hunk.lines) ? hunk.lines.filter((value): value is string => typeof value === "string").join("\n") + "\n" : "")).join("");
}
/** What a tool's result adds to its detail: its output (the structured one where the tool has one), the diff of a change, the exit code. */
export function toolResult(name: string, block: Row, structured: unknown): { readonly failed: boolean; readonly detail: Partial<NativeToolDetail> } {
  const shaped = record(structured), family = toolFamily(name), plain = resultText(block.content);
  const output = (family === "execute" ? commandOutput(shaped) : undefined) ?? (plain || json(structured));
  const diff = family === "edit" ? fileDiff(shaped) : undefined;
  const exit = typeof shaped?.exitCode === "number" && Number.isSafeInteger(shaped.exitCode) ? { exitCode: shaped.exitCode } : {};
  return { failed: block.is_error === true, detail: { ...(output ? { output } : {}), ...(diff ? { diff } : {}), ...exit } };
}

// ---- the task list -------------------------------------------------------------------------------------------------------

/** TodoWrite's list as the Turn's plan. */
export function todoPlan(input: Row): readonly NativePlanEntry[] | null {
  if (!Array.isArray(input.todos)) return null;
  return input.todos.flatMap(value => {
    const todo = record(value), content = text(todo?.content);
    if (content === undefined) return [];
    return [{ content: content.trim(), status: todo?.status === "completed" ? "completed" as const : todo?.status === "in_progress" ? "in_progress" as const : "pending" as const }];
  });
}
type Status = NativePlanEntry["status"];
const taskStatus = (value: unknown): Status | undefined => value === "pending" ? "pending" : value === "in_progress" ? "in_progress" : value === "completed" ? "completed" : undefined;
/**
 * 移植自 T3 Code（MIT）d19467a5 ClaudeAdapterV2.ts applyClaudeTaskTool：Claude Code's Task tools (TaskCreate, TaskUpdate, TaskList) kept as one
 * list; null when the call changed nothing the plan shows.
 */
export function applyTaskTool(tasks: ReadonlyMap<string, { readonly content: string; readonly status: Status }>, name: string, input: Row, result: unknown, said: string): Map<string, { content: string; status: Status }> | null {
  const shaped = record(result);
  if (name === "TaskList") {
    if (!Array.isArray(shaped?.tasks)) return null;
    const next = new Map<string, { content: string; status: Status }>();
    for (const value of shaped.tasks) { const task = record(value), id = text(task?.id), content = text(task?.subject), status = taskStatus(task?.status); if (id && content && status) next.set(id, { content, status }); }
    return next.size === 0 && tasks.size === 0 ? null : next;
  }
  if (name === "TaskCreate") {
    const created = record(shaped?.task), fromText = /^Task #(\S+) created successfully: (.+)$/su.exec(said);
    const id = text(created?.id) ?? fromText?.[1], content = text(created?.subject) ?? fromText?.[2]?.trim() ?? text(input.subject);
    return id === undefined || content === undefined ? null : new Map(tasks).set(id, { content, status: "pending" });
  }
  if (name !== "TaskUpdate" || shaped?.success === false || (shaped === null && !said.startsWith("Updated task #"))) return null;
  const id = text(input.taskId) ?? text(shaped?.taskId), task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return null;
  if (input.status === "deleted") { const next = new Map(tasks); next.delete(id); return next; }
  const content = text(input.subject) ?? task.content, status = taskStatus(input.status) ?? task.status;
  return content === task.content && status === task.status ? null : new Map(tasks).set(id, { content, status });
}

// ---- usage ---------------------------------------------------------------------------------------------------------------

/** Per-model totals as the SDK reports them (ModelUsage), the numbers the Hub reads. */
export interface ModelTotals { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number; cost: number }
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function modelTotals(value: unknown): Map<string, ModelTotals> {
  const out = new Map<string, ModelTotals>();
  for (const [model, raw] of Object.entries(record(value) ?? {})) {
    const row = record(raw);
    if (row === null) continue;
    out.set(model, { input: count(row.inputTokens), output: count(row.outputTokens), cacheRead: count(row.cacheReadInputTokens), cacheWrite: count(row.cacheCreationInputTokens), thinking: count(row.thinkingTokens), cost: count(row.costUSD) });
  }
  return out;
}
/** `after` less `before`, model by model (the process's cumulative totals since a baseline). */
export function lessTotals(after: ReadonlyMap<string, ModelTotals>, before: ReadonlyMap<string, ModelTotals>): Map<string, ModelTotals> {
  const out = new Map<string, ModelTotals>();
  for (const [model, row] of after) {
    const prior = before.get(model);
    out.set(model, prior === undefined ? { ...row } : { input: Math.max(0, row.input - prior.input), output: Math.max(0, row.output - prior.output), cacheRead: Math.max(0, row.cacheRead - prior.cacheRead),
      cacheWrite: Math.max(0, row.cacheWrite - prior.cacheWrite), thinking: Math.max(0, row.thinking - prior.thinking), cost: Math.max(0, row.cost - prior.cost) });
  }
  return out;
}
export function addTotals(into: Map<string, ModelTotals>, more: ReadonlyMap<string, ModelTotals>): void {
  for (const [model, row] of more) {
    const prior = into.get(model);
    into.set(model, prior === undefined ? { ...row } : { input: prior.input + row.input, output: prior.output + row.output, cacheRead: prior.cacheRead + row.cacheRead,
      cacheWrite: prior.cacheWrite + row.cacheWrite, thinking: prior.thinking + row.thinking, cost: prior.cost + row.cost });
  }
}
/**
 * A Turn's usage: every model request of its turns (the main loop, sub-agents, compaction, titles: the SDK's per-model totals), the cache beside the
 * input as the Messages API counts it (session/domain/protocol/usage.ts `claude`), the context of its last main request and its cost.
 */
export function turnUsage(totals: ReadonlyMap<string, ModelTotals>, context: NativeUsage["context"] | undefined, requests: NonNullable<NativeUsage["requests"]>): NativeUsage {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, thinking = 0, cost = 0;
  for (const row of totals.values()) { input += row.input; output += row.output; cacheRead += row.cacheRead; cacheWrite += row.cacheWrite; thinking += row.thinking; cost += row.cost; }
  return { turn: { input, output, cachedInput: cacheRead, cacheWrite, ...(thinking ? { reasoning: thinking } : {}), total: input + output + cacheRead + cacheWrite },
    ...(context ? { context } : {}), ...(cost > 0 ? { cost: { amount: Math.round(cost * 1e6) / 1e6, currency: "USD", scope: "turn" as const } } : {}), ...(requests.length ? { requests: [...requests] } : {}) };
}
/** One model request of the Messages API (an assistant message's `usage`): what it read, the context it leaves, and its entry. */
export function requestUsage(usage: unknown): { readonly used: number; readonly entry: NonNullable<NativeUsage["requests"]>[number] | null } | null {
  const row = record(usage);
  if (row === null || typeof row.input_tokens !== "number") return null;
  return { used: count(row.input_tokens) + count(row.cache_read_input_tokens) + count(row.cache_creation_input_tokens) + count(row.output_tokens),
    entry: usageRequest(row.input_tokens, row.cache_read_input_tokens, row.cache_creation_input_tokens) };
}

// ---- the account's limits ------------------------------------------------------------------------------------------------

const WINDOWS: Readonly<Record<string, { readonly label: string; readonly minutes?: number }>> = {
  five_hour: { label: "五小时", minutes: 300 }, seven_day: { label: "七天", minutes: 10_080 }, seven_day_opus: { label: "七天（Opus）", minutes: 10_080 },
  seven_day_sonnet: { label: "七天（Sonnet）", minutes: 10_080 }, seven_day_overage_included: { label: "七天（含超额）", minutes: 10_080 }, overage: { label: "超额用量" },
};
function window(id: string, row: Row): NativeLimit {
  const known = WINDOWS[id], used = typeof row.utilization === "number" && Number.isFinite(row.utilization) ? Math.max(0, Math.min(100, Math.round(row.utilization * 1000) / 10)) : undefined;
  const resets = typeof row.resetsAt === "number" && Number.isFinite(row.resetsAt) && row.resetsAt > 0 ? Math.round(row.resetsAt < 1e11 ? row.resetsAt * 1000 : row.resetsAt) : undefined;
  const status = row.status === "rejected" ? "exceeded" as const : row.status === "allowed_warning" ? "warning" as const : row.status === "allowed" ? "ok" as const : undefined;
  return { id, ...(known ? { label: known.label } : {}), ...(used === undefined ? {} : { usedPercent: used }), ...(known?.minutes ? { windowMinutes: known.minutes } : {}),
    ...(resets === undefined ? {} : { resetsAt: resets }), ...(status === undefined ? {} : { status }) };
}
/** The windows a rate_limit_event reports: each of `unifiedWindows` when it lists them, else the one it is about (seconds turned into milliseconds). */
export function limitsOf(info: unknown): readonly NativeLimit[] {
  const row = record(info);
  if (row === null) return [];
  const windows = record(row.unifiedWindows);
  if (windows !== null && Object.keys(windows).length) return Object.entries(windows).flatMap(([id, value]) => { const shaped = record(value); return shaped === null ? [] : [window(id, shaped)]; });
  return typeof row.rateLimitType === "string" ? [window(row.rateLimitType, row)] : [window("claude", row)];
}

// ---- questions -----------------------------------------------------------------------------------------------------------

/** One AskUserQuestion question: its words, its header, the labels it offers, whether several may be picked. */
export interface AskedQuestion { readonly question: string; readonly header?: string; readonly options: readonly { readonly label: string; readonly description?: string }[]; readonly multiSelect: boolean }
export function askedQuestions(input: Row): readonly AskedQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > 32) return null;
  const questions = input.questions.map(value => {
    const row = record(value), question = text(row?.question);
    if (row === null || question === undefined) return null;
    const options = (Array.isArray(row.options) ? row.options : []).flatMap(option => { const shaped = record(option), label = text(shaped?.label); return label === undefined ? [] : [{ label, ...(text(shaped?.description) ? { description: text(shaped?.description)! } : {}) }]; });
    return { question, ...(text(row.header) ? { header: text(row.header)! } : {}), options, multiSelect: row.multiSelect === true };
  });
  return questions.some(question => question === null) ? null : questions as AskedQuestion[];
}

// ---- failures ------------------------------------------------------------------------------------------------------------

/** The SDK's error kinds of a model call (SDKAssistantMessageError), as the Hub's codes and words. */
const MODEL_ERRORS: Readonly<Record<string, { readonly code: string; readonly message: string }>> = {
  authentication_failed: { code: "NATIVE_AUTH_REQUIRED", message: "Claude Code 没有登录或登录已失效：在终端运行 claude auth login 后再试。" },
  oauth_org_not_allowed: { code: "NATIVE_AUTH_REQUIRED", message: "这个 Claude 账号所在的组织不允许这样使用，请在 Claude Code 里换一个账号登录。" },
  account_on_hold: { code: "NATIVE_ACCOUNT_UNAVAILABLE", message: "Claude 账号被暂停，Claude Code 没法调用模型。" },
  verification_required: { code: "NATIVE_ACCOUNT_UNAVAILABLE", message: "Claude 账号需要先完成验证。" },
  billing_error: { code: "NATIVE_BILLING", message: "Claude 账号的计费有问题，模型请求被拒绝。" },
  rate_limit: { code: "NATIVE_RATE_LIMITED", message: "Claude 账号的用量额度到了，等额度恢复后再试。" },
  overloaded: { code: "NATIVE_MODEL_ERROR", message: "Claude 的服务现在过载，稍后再试。" },
  server_error: { code: "NATIVE_MODEL_ERROR", message: "Claude 的服务出错了，稍后再试。" },
  invalid_request: { code: "NATIVE_INVALID_REQUEST", message: "Claude 拒绝了这次模型请求。" },
  model_not_found: { code: "MODEL_UNAVAILABLE", message: "所选的模型在这个 Claude 账号里用不了。" },
  max_output_tokens: { code: "NATIVE_OUTPUT_LIMIT", message: "回复超过了模型的输出上限。" },
  cloud_credential_error: { code: "NATIVE_AUTH_REQUIRED", message: "Claude Code 的云端凭据出错。" },
  unknown: { code: "NATIVE_MODEL_ERROR", message: "Claude 的模型请求失败。" },
};
/** Whether an error kind is a model call that failed after the prompt was written to the transcript (Claude Code writes it before it calls the model). */
export function modelFailure(kind: string | null): { readonly code: string; readonly message: string } | null { return kind !== null && Object.hasOwn(MODEL_ERRORS, kind) ? MODEL_ERRORS[kind]! : null; }
/** The words a result's `errors` say first, bounded; private text of the CLI's, shown only as the failure's detail. */
export function firstError(errors: unknown): string | undefined {
  const said = Array.isArray(errors) ? errors.find((value): value is string => typeof value === "string" && value.trim() !== "") : undefined;
  return said === undefined ? undefined : line(said, 600);
}
/** A result Claude Code wrote for a turn stopped before its prompt was checked: the prompt never reached the transcript (seen on 2.1.325). */
export const UNCHECKED_PROMPT = /^prompt_check:/u;
