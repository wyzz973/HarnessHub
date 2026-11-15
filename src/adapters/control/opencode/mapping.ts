// 移植自 T3 Code（MIT）d19467a5 packages/provider-opencode/src/server/toolItems.ts 与 v2/adapter.ts 的纯映射（工具展示、用量、计划、提问、出错）
import { basename } from "node:path";
import type { NativePlanEntry, NativeToolDetail, NativeUsage } from "../../../contracts/control.js";
import { TABLE_MCP_NAME } from "../../../contracts/table.js";
import { classifyRemoteFailure } from "../../../infrastructure/control/json-rpc-process.js";
import type { Row } from "./http.js";

export const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
/** The objects of a list; anything else is none. */
export function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(record).filter((item): item is Row => item !== null) : []; }
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
function field(input: unknown, ...keys: readonly string[]): string | undefined { const row = record(input); for (const key of keys) { const value = text(row?.[key]); if (value !== undefined) return value; } return undefined; }
function count(input: unknown, ...keys: readonly string[]): number | undefined { const row = record(input); for (const key of keys) { const value = row?.[key]; if (typeof value === "number" && Number.isFinite(value)) return value; } return undefined; }
export function line(value: string, max = 200): string { return [...value.replace(/\s+/gu, " ").trim()].slice(0, max).join(""); }
function json(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try { const said = JSON.stringify(value, null, 2); return said === "{}" ? undefined : said; } catch { return undefined; }
}

/** What a tool is, by its OpenCode name (T3 Code's openCodeToolProjectionKind, toolItems.ts:36-63, with the Hub's families). */
export type ToolKind = "execute" | "edit" | "read" | "search" | "web_search" | "fetch" | "plan" | "question" | "subagent" | "skill" | "mcp" | "script" | "other";
export function toolKind(name: string, servers: ReadonlySet<string> = new Set()): ToolKind {
  const lower = name.toLowerCase();
  if (lower === "todowrite") return "plan";
  if (lower === "question") return "question";
  if (lower === "subagent" || lower === "task") return "subagent";
  if (lower === "skill") return "skill";
  // OpenCode 2's Code Mode: MCP tools are called from one script (`execute`).
  if (lower === "execute") return "script";
  if (mcpServer(name, servers) !== null) return "mcp";
  if (lower.includes("bash") || lower.includes("shell")) return "execute";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "edit";
  if (lower === "websearch" || lower === "web_search" || lower === "codesearch" || lower === "code_search") return "web_search";
  if (lower.includes("web") || lower === "fetch") return "fetch";
  if (lower === "read") return "read";
  if (lower.includes("glob") || lower.includes("grep") || lower.includes("search") || lower.includes("lsp") || lower === "list" || lower === "ls") return "search";
  return "other";
}
/** The MCP server a tool name belongs to (`<server>_<tool>`, OpenCode's joining), among the servers known to run here; null for a built-in tool. */
export function mcpServer(name: string, servers: ReadonlySet<string>): string | null {
  for (const server of [TABLE_MCP_NAME, ...servers]) if (name.startsWith(server + "_") && name.length > server.length + 1) return server;
  return null;
}
/** `read`'s envelope (`<path>…<type>…<content>…`) unwrapped (toolItems.ts:101-113); anything else as it is. */
export function readOutput(output: string): string {
  const header = /^<path>[^\r\n]+<\/path>\r?\n<type>(directory|file)<\/type>\r?\n/u.exec(output);
  if (header === null) return output;
  const body = output.slice(header[0].length);
  const envelope = header[1] === "directory" ? /^<entries>\r?\n([\s\S]*?)\r?\n<\/entries>(?=\r?\n|$)/u.exec(body) : /^<content>(?:\r?\n)?([\s\S]*?)\r?\n<\/content>(?=\r?\n|$)/u.exec(body);
  return envelope === null ? output : envelope[1] + body.slice(envelope[0].length);
}
/** A tool's text content (`content[].type === "text"`). */
export function contentText(content: unknown): string {
  return Array.isArray(content) ? content.flatMap(part => { const row = record(part); return row?.type === "text" && typeof row.text === "string" ? [row.text] : []; }).join("\n") : "";
}
export interface ToolFacts { readonly name: string; readonly input: unknown; readonly output?: string; readonly metadata?: unknown; readonly diff?: string; readonly failed?: boolean }
/**
 * A tool call as the Hub shows it (toolItems.ts:115-219): its title and the bounded facts. The shell tool succeeds when its command exits non-zero, so
 * the exit code is read from the metadata (`exit`); an edit's diff comes from its metadata, else from the approval that showed it.
 */
export function toolView(facts: ToolFacts, servers: ReadonlySet<string> = new Set()): { readonly title: string; readonly detail: NativeToolDetail } {
  const { name, input } = facts, output = facts.output !== undefined && facts.output !== "" ? facts.output : undefined;
  const kind = toolKind(name, servers);
  switch (kind) {
    case "execute": {
      const command = field(input, "command", "cmd") ?? "", exit = count(facts.metadata, "exit", "exitCode");
      return { title: line(command) || "命令", detail: { kind: "execute", name, ...(command ? { input: command } : {}), ...(output === undefined ? {} : { output }), ...(exit === undefined ? {} : { exitCode: exit }),
        ...(field(input, "workdir", "cwd") ? { locations: [field(input, "workdir", "cwd")!] } : {}) } };
    }
    case "edit": {
      const path = field(input, "filePath", "path", "file"), diff = field(facts.metadata, "diff", "patch") ?? facts.diff ?? (facts.failed ? output : undefined);
      const verb = name.toLowerCase().includes("write") ? "写入 " : "编辑 ";
      return { title: verb + (path ? basename(path) : "文件"), detail: { kind: "edit", name, ...(json(input) ? { input: json(input)! } : {}), ...(diff ? { diff } : {}), ...(output === undefined ? {} : { output }), ...(path ? { locations: [path] } : {}) } };
    }
    case "read": {
      const path = field(input, "filePath", "path", "file");
      return { title: "读取 " + (path ? basename(path) : "文件"), detail: { kind: "read", name, ...(json(input) ? { input: json(input)! } : {}), ...(output === undefined ? {} : { output: readOutput(output) }), ...(path ? { locations: [path] } : {}) } };
    }
    case "search": {
      const pattern = field(input, "pattern", "query", "path", "filePath");
      return { title: "搜索 " + (pattern ? line(pattern, 120) : "文件"), detail: { kind: "search", name, ...(json(input) ? { input: json(input)! } : {}), ...(output === undefined ? {} : { output }) } };
    }
    case "web_search": {
      const query = field(input, "query", "pattern") ?? "";
      return { title: "搜索：" + (line(query, 200) || "网页"), detail: { kind: "search", name: "web_search", ...(query ? { input: query } : {}), ...(output === undefined ? {} : { output }) } };
    }
    case "fetch": {
      const url = field(input, "url") ?? "";
      return { title: "打开网页 " + line(url, 512), detail: { kind: "fetch", name: "web_fetch", ...(url ? { input: url, locations: [url] } : {}), ...(output === undefined ? {} : { output }) } };
    }
    case "subagent": {
      const what = field(input, "description", "title") ?? field(input, "agent") ?? "子任务";
      return { title: "子 Agent · " + line(what, 120), detail: { kind: "subagent", name, ...(field(input, "prompt") ? { input: field(input, "prompt")! } : {}), ...(output === undefined ? {} : { output: subagentOutput(output) }) } };
    }
    case "skill": {
      const skill = field(input, "id", "name") ?? "";
      return { title: "使用技能 " + line(skill, 120), detail: { kind: "read", name, ...(skill ? { input: skill } : {}), ...(output === undefined ? {} : { output }) } };
    }
    case "mcp": {
      const server = mcpServer(name, servers)!, tool = name.slice(server.length + 1);
      return { title: line(server + "." + tool), detail: { kind: "mcp", name: server + "/" + tool, ...(json(input) ? { input: json(input)! } : {}), ...(output === undefined ? {} : { output }) } };
    }
    case "script": {
      const code = field(input, "code", "script", "source");
      return { title: "运行脚本（调用 MCP 工具）", detail: { kind: "mcp", name, ...(code ? { input: code } : json(input) ? { input: json(input)! } : {}), ...(output === undefined ? {} : { output }) } };
    }
    case "plan": return { title: "更新任务清单", detail: { kind: "other", name: "todowrite", ...(json(input) ? { input: json(input)! } : {}) } };
    default: return { title: line(name) || "工具", detail: { kind: "other", name, ...(json(input) ? { input: json(input)! } : {}), ...(output === undefined ? {} : { output }) } };
  }
}
/** A subagent's answer without its `<subagent>` envelope (v2/adapter.ts subagentOutput). */
export function subagentOutput(said: string): string { return /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/u.exec(said.trim())?.[1] ?? said; }
/** The shell tool's command exited non-zero (toolItems.ts:115-120). */
export function commandFailed(name: string, metadata: unknown): boolean { const exit = count(metadata, "exit", "exitCode"); return toolKind(name) === "execute" && exit !== undefined && exit !== 0; }

/** `todowrite`'s list (`metadata.todos` or its input's `todos`), as the Hub's plan (v2/adapter.ts:1304-1307); null when it holds none. */
export function planOf(value: unknown): NativePlanEntry[] | null {
  const todos = record(value)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.slice(0, 256).flatMap((item): NativePlanEntry[] => {
    const row = record(item), content = text(row?.content);
    if (content === undefined) return [];
    const status = row?.status === "completed" || row?.status === "cancelled" ? "completed" as const : row?.status === "in_progress" ? "in_progress" as const : "pending" as const;
    const priority = row?.priority === "high" || row?.priority === "medium" || row?.priority === "low" ? { priority: row.priority as "high" | "medium" | "low" } : {};
    return [{ content, status, ...priority }];
  });
}

/** One model call's tokens (`TokenUsage.Info`); null for anything else. */
export interface Tokens { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number }
export function tokensOf(value: unknown): Tokens | null {
  const row = record(value), cache = record(row?.cache), n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0;
  if (row === null || typeof row.input !== "number") return null;
  return { input: n(row.input), output: n(row.output), reasoning: n(row.reasoning), cacheRead: n(cache?.read), cacheWrite: n(cache?.write) };
}
/**
 * A Turn's usage from its model calls (`session.step.ended`): T3 Code's sum (v2/adapter.ts:2802-2813), input with what the cache read and wrote, output with
 * the reasoning; each call one request; the context the last call read, of the model's window; the cost in US dollars.
 */
export class TurnUsage {
  private input = 0; private output = 0; private reasoning = 0; private cached = 0; private written = 0; private cost = 0;
  private last: Tokens | null = null;
  readonly requests: { input: number; cachedInput?: number; cacheWrite?: number }[] = [];
  add(tokens: Tokens, cost: unknown): void {
    const read = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    this.input += read; this.cached += tokens.cacheRead; this.written += tokens.cacheWrite; this.output += tokens.output + tokens.reasoning; this.reasoning += tokens.reasoning;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) this.cost += cost;
    this.last = tokens;
    this.requests.push({ input: read, ...(tokens.cacheRead ? { cachedInput: tokens.cacheRead } : {}), ...(tokens.cacheWrite ? { cacheWrite: tokens.cacheWrite } : {}) });
  }
  get empty(): boolean { return this.last === null; }
  value(window: number | undefined): NativeUsage {
    const last = this.last;
    return { turn: { input: this.input, output: this.output, cachedInput: this.cached, cacheWrite: this.written, reasoning: this.reasoning, total: this.input + this.output },
      ...(last === null ? {} : { context: { used: last.input + last.cacheRead + last.cacheWrite + last.output, ...(window ? { size: window } : {}) } }),
      ...(this.cost > 0 ? { cost: { amount: this.cost, currency: "USD", scope: "turn" as const } } : {}),
      ...(this.requests.length ? { requests: [...this.requests] } : {}) };
  }
}

/**
 * What a failed execution (`Session.StructuredError`: `type`, `message`, `status`) is to the user, in the Hub's words (v2/adapter.ts:2826-2843): a spent
 * allowance or a rate limit (`provider.quota` other than 402, `provider.rate-limit`), a provider's sign-in, an empty balance, a context too long.
 * OpenCode's message decides the rest by the shared classes; its words are never shown.
 */
export function failureOf(error: unknown): { readonly code: string; readonly message: string } {
  const row = record(error), type = typeof row?.type === "string" ? row.type : "", status = typeof row?.status === "number" ? row.status : undefined, said = typeof row?.message === "string" ? row.message : "";
  if (type === "provider.rate-limit" || type === "provider.quota" && status !== 402) return { code: "NATIVE_RATE_LIMITED", message: "模型服务的额度或调用频率到了上限，请稍后再试，或换一个模型。" };
  if (type === "provider.quota") return { code: "NATIVE_QUOTA_EXCEEDED", message: "模型服务的余额不足。可以充值，或选择其他模型、其他 Harness 继续。" };
  if (/^provider\.auth|unauthori[sz]ed/iu.test(type)) return { code: "NATIVE_AUTH_REQUIRED", message: "OpenCode 的模型服务登录或密钥不可用，请在 OpenCode 里完成登录后再试。" };
  if (/context/iu.test(type)) return { code: "NATIVE_CONTEXT_EXCEEDED", message: "对话超出了模型的上下文长度。可以先 /compact 压缩，或开始新对话。" };
  return classifyRemoteFailure(said) ?? { code: "MODEL_REQUEST_FAILED", message: "OpenCode 的模型请求没有完成" + (type ? "（" + line(type, 64) + "）" : "") + "，请检查它的模型配置或换一个模型。" };
}

// ---- forms (the `question` tool) -------------------------------------------------------------------------------------

export interface Choice { readonly id: string; readonly name: string }
/** One field of a form as the Hub asks it: the choices, a free answer where the field takes one, and the field's value for an answer. */
export interface FormQuestion {
  readonly key: string;
  readonly title: string;
  readonly detail?: string;
  readonly choices: readonly Choice[];
  readonly input?: { readonly kind: "text"; readonly value: string };
  value(choice: string, input?: string): string | readonly string[] | "cancel";
}
const CANCEL: Choice = { id: "cancel", name: "取消" };
/**
 * A form's fields as questions (v2/adapter.ts formQuestions, :469-497): only text and multiple-choice fields; a field of another kind (a number, a
 * link to open, one that depends on another, a hidden one) makes the form unanswerable here, and says why.
 */
export function formQuestions(form: Row): { readonly questions: readonly FormQuestion[] } | { readonly unsupported: string } {
  const fields = Array.isArray(form.fields) ? form.fields.map(record) : [];
  if (fields.length === 0 || fields.length > 64) return { unsupported: "一个没有问题的表单" };
  const questions: FormQuestion[] = [];
  for (const [index, row] of fields.entries()) {
    if (row === null || typeof row.key !== "string") return { unsupported: "读不懂的问题" };
    if (row.type === "external") return { unsupported: "需要打开链接" };
    if (row.type !== "string" && row.type !== "multiselect") return { unsupported: "一个" + String(row.type) + "类型的值" };
    if (row.hidden === true) return { unsupported: "隐藏的问题" };
    if (Array.isArray(row.when) && row.when.length > 0) return { unsupported: "依赖前一个回答的问题" };
    const options = (Array.isArray(row.options) ? row.options : []).flatMap(option => { const value = record(option); return typeof value?.value === "string" ? [{ value: value.value, label: text(value.label) ?? value.value }] : []; });
    const free = row.custom === true || options.length === 0, multi = row.type === "multiselect";
    const header = text(row.title) ?? "问题 " + (index + 1), asked = text(row.description) ?? header;
    questions.push({ key: row.key, title: asked.slice(0, 4096), ...(asked !== header ? { detail: header } : {}),
      choices: [...options.map((option, at) => ({ id: "answer-" + at, name: option.label })), ...(free ? [{ id: "submit", name: "提交回答" }] : []), CANCEL],
      ...(free ? { input: { kind: "text" as const, value: "" } } : {}),
      value: (choice, input) => {
        if (choice === "cancel") return "cancel";
        if (choice === "submit") { if (typeof input !== "string" || input.includes("\0")) throw new Error("invalid answer"); return multi ? input.split(/[,，\n]/u).map(part => part.trim()).filter(Boolean) : input; }
        const option = options[Number(choice.slice(7))];
        if (!choice.startsWith("answer-") || option === undefined) throw new Error("invalid answer choice");
        return multi ? [option.value] : option.value;
      } });
  }
  return { questions };
}

// ---- permissions ------------------------------------------------------------------------------------------------------

/** The kind the Hub's policy tells a permission by (KIND_OF_FAMILY), from OpenCode's action and, for a path outside the workspace, the call it is for. */
export function actionKind(action: string, callKind: ToolKind | undefined, servers: ReadonlySet<string>): string | undefined {
  switch (action) {
    case "edit": return "edit";
    case "shell": case "bash": return "execute";
    case "read": case "list": return "read";
    case "glob": case "grep": case "lsp": return "search";
    case "webfetch": case "websearch": return "fetch";
    case "subagent": case "task": return "subagent";
    case "external_directory": return callKind === undefined ? undefined : kindOfTool(callKind);
    default: return mcpServer(action, servers) !== null ? "mcp" : undefined;
  }
}
function kindOfTool(kind: ToolKind): string | undefined {
  return kind === "execute" ? "execute" : kind === "edit" ? "edit" : kind === "read" || kind === "skill" ? "read" : kind === "search" ? "search" : kind === "fetch" || kind === "web_search" ? "fetch" : kind === "mcp" || kind === "script" ? "mcp" : undefined;
}
/** A permission request's title and detail (`action`, `resources`, the files it would change). */
export function permissionView(request: Row, call: { readonly title: string } | undefined, child: boolean): { readonly title: string; readonly detail?: string } {
  const action = typeof request.action === "string" ? request.action : "", resources = Array.isArray(request.resources) ? request.resources.filter((item): item is string => typeof item === "string") : [];
  const first = resources[0] ?? "", prefix = child ? "子 Agent · " : "";
  const title = prefix + (action === "shell" || action === "bash" ? line(first) || "OpenCode 请求执行命令"
    : action === "edit" ? "修改 " + (resources.slice(0, 3).map(path => basename(path)).join(", ") || "文件")
    : action === "external_directory" ? "访问工作区外的 " + (line(first, 256) || "路径") + (call ? "（" + line(call.title, 120) + "）" : "")
    : action === "read" ? "读取 " + (line(first, 256) || "文件")
    : action === "webfetch" ? "打开网页 " + line(first, 512)
    : action === "websearch" ? "搜索：" + line(first, 200)
    : line(action) + (first ? "：" + line(first, 200) : ""));
  const files = Array.isArray(record(request.metadata)?.files) ? (record(request.metadata)!.files as unknown[]).flatMap(item => { const row = record(item); return typeof row?.patch === "string" ? [row.patch] : []; }) : [];
  const detail = [typeof request.message === "string" ? line(request.message, 1024) : "", resources.length > 1 ? resources.slice(0, 16).join("\n") : "", files.join("\n")].filter(Boolean).join("\n");
  return { title, ...(detail ? { detail } : {}) };
}
/** The patch an edit's approval showed (`metadata.files[].patch`), for the call's own detail. */
export function permissionDiff(request: Row): string | undefined {
  const files = record(request.metadata)?.files;
  const patches = Array.isArray(files) ? files.flatMap(item => { const row = record(item); return typeof row?.patch === "string" ? [row.patch] : []; }) : [];
  return patches.length ? patches.join("") : undefined;
}
