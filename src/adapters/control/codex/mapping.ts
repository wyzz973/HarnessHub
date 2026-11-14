import { basename } from "node:path";
import type { NativeToolDetail, NativeUsage } from "../../../contracts/control.js";
import { diffPath } from "../../../infrastructure/control/unified-diff.js";

/** Codex items and events as the Hub's: pure functions over the app-server's own shapes (0.169.0). */

export type Row = Record<string, unknown>;
export const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
export function line(value: string, maximum = 4096): string { return value.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, maximum); }
export function json(value: unknown): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return undefined; } }

// ---- files ---------------------------------------------------------------------------------------------------------------

/** A change's kind (`PatchChangeKind`): add, delete, or update with an optional move. */
function changeKind(change: Row): { readonly type: "add" | "delete" | "update"; readonly moveTo?: string } {
  const kind = record(change.kind), type = kind?.type;
  if (type === "add" || type === "delete") return { type };
  return { type: "update", ...(typeof kind?.move_path === "string" && kind.move_path ? { moveTo: kind.move_path } : {}) };
}
/** One file change as a unified diff, its headers by its kind: a new file from /dev/null, a deleted one to it, a moved one with both names. */
export function fileDiff(change: unknown): string {
  const row = record(change);
  if (row === null) return "";
  const path = typeof row.path === "string" ? row.path : "file", diff = typeof row.diff === "string" ? row.diff : "", end = diff.endsWith("\n") || diff === "" ? "" : "\n";
  if (/^(---|diff --git)/mu.test(diff)) return diff + end;
  const kind = changeKind(row), from = kind.type === "add" ? "/dev/null" : "a/" + diffPath(path), to = kind.type === "delete" ? "/dev/null" : "b/" + diffPath(kind.moveTo ?? path);
  return (kind.moveTo ? "rename from " + diffPath(path) + "\nrename to " + diffPath(kind.moveTo) + "\n" : "") + "--- " + from + "\n+++ " + to + "\n" + diff + end;
}
/** The files of a change and what happens to each, as one line each (T3 Code's file-change prompt, in the Hub's words). */
export function changeLines(changes: readonly unknown[]): string[] {
  return changes.flatMap(value => {
    const row = record(value);
    if (row === null || typeof row.path !== "string") return [];
    const kind = changeKind(row);
    return [kind.type === "add" ? "新建 " + row.path : kind.type === "delete" ? "删除 " + row.path : kind.moveTo ? "移动 " + row.path + " → " + kind.moveTo : "修改 " + row.path];
  });
}
function changeTitle(changes: readonly unknown[]): string {
  const rows = changes.flatMap(value => { const row = record(value); return row !== null && typeof row.path === "string" ? [{ path: row.path, kind: changeKind(row) }] : []; });
  if (rows.length === 0) return "修改文件";
  const verb = rows.every(row => row.kind.type === "add") ? "新建 " : rows.every(row => row.kind.type === "delete") ? "删除 " : rows.length === 1 && rows[0]!.kind.moveTo ? "移动 " : "修改 ";
  const names = rows.length === 1 && rows[0]!.kind.moveTo ? basename(rows[0]!.path) + " → " + basename(rows[0]!.kind.moveTo) : rows.slice(0, 3).map(row => basename(row.path)).join(", ");
  return verb + names + (rows.length > 3 ? " 等 " + rows.length + " 个文件" : "");
}

// ---- tools ---------------------------------------------------------------------------------------------------------------

/** A command's parsed actions (`commandActions`), when every one is the same plain kind: a read of files, a search, or a listing. */
function commandShape(item: Row): { readonly kind: "read" | "search" | "list"; readonly paths: string[]; readonly query?: string } | null {
  const actions = Array.isArray(item.commandActions) ? item.commandActions.map(record).filter((row): row is Row => row !== null) : [];
  if (actions.length === 0) return null;
  const type = actions[0]!.type;
  if (!actions.every(action => action.type === type)) return null;
  const paths = actions.flatMap(action => typeof action.path === "string" && action.path ? [action.path] : []);
  if (type === "read" && paths.length === actions.length) return { kind: "read", paths };
  if (type === "search") { const query = actions.map(action => action.query).find((value): value is string => typeof value === "string" && value !== ""); return { kind: "search", paths, ...(query ? { query } : {}) }; }
  if (type === "listFiles") return { kind: "list", paths };
  return null;
}
/** The page URL and favicon of a browser-use result, from Codex's `codex/toolSurface` (T3 Code's presentation). */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}
function displayName(value: unknown, maximum = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/\s+/gu, " ");
  return name.length > 0 && name.length <= maximum ? name : undefined;
}
function browserName(value: unknown): string | undefined {
  const name = displayName(value)?.toLowerCase();
  if (!name) return undefined;
  if (name.includes("chrome") || name === "chromium") return "Chrome";
  if (name.includes("edge")) return "Microsoft Edge";
  if (name.includes("firefox")) return "Firefox";
  if (name.includes("safari")) return "Safari";
  if (name.includes("arc")) return "Arc";
  if (name === "iab" || name.includes("in-app")) return "浏览器";
  return displayName(value);
}
const KNOWN_APPS: Readonly<Record<string, string>> = { "com.apple.finder": "Finder", "com.apple.safari": "Safari", "com.google.chrome": "Chrome", "com.microsoft.edgemac": "Microsoft Edge", "org.mozilla.firefox": "Firefox", "company.thebrowser.browser": "Arc" };
/**
 * 移植自 T3 Code（MIT, © 2026 T3 Tools Inc.）：apps/server/src/provider/CodexToolPresentation.ts 与 packages/provider-core/src/server/mcpToolPresentation.ts。
 * An MCP call's title and where it acts, from what Codex attached: a browser-use result's page, a computer-use result's app, a connector's app and
 * action (`appContext`). Icons and source keys are T3's page's; the Hub keeps the title and the page URL (as a location).
 */
export function mcpPresentation(item: Row): { readonly title?: string; readonly locations?: readonly string[] } {
  const result = record(item.result), meta = record(result?._meta), surface = record(meta?.["codex/toolSurface"]), app = record(item.appContext);
  if (surface?.kind === "browserUse") {
    const screenshot = record(surface.screenshot), browserUse = record(meta?.browser_use);
    const tabs = (Array.isArray(surface.openTabs) ? surface.openTabs : []).map(record).reverse();
    const page = [screenshot?.pageUrl, browserUse?.url, tabs.find(tab => httpUrl(tab?.url) !== undefined)?.url].map(httpUrl).find(url => url !== undefined);
    const name = browserName(app?.appName) ?? browserName(surface.browserFamily) ?? browserName(surface.backend) ?? "浏览器";
    return { title: name + (page ? " · " + page : ""), ...(page ? { locations: [page] } : {}) };
  }
  if (surface?.kind === "computerUse") {
    const target = record(surface.app), args = record(item.arguments);
    const id = target?.kind === "appId" && typeof target.appId === "string" ? target.appId : undefined;
    const name = displayName(app?.appName) ?? displayName(args?.appName) ?? displayName(args?.application) ?? displayName(typeof args?.app === "string" ? args.app : undefined)
      ?? (target?.kind === "displayName" ? displayName(target.displayName) : undefined) ?? (id ? KNOWN_APPS[id.toLowerCase()] : undefined) ?? "电脑操作";
    return { title: name };
  }
  const tool = displayName(item.tool), action = displayName(app?.actionName), appName = displayName(app?.appName) ?? displayName(record(meta?.source)?.name);
  const title = action ?? (tool ? tool.replace(/[_-]+/gu, " ") : undefined);
  return title === undefined && appName === undefined ? {} : { title: (appName ? appName + " · " : "") + (title ?? "") };
}
/** Public title and detail (whole: nothing is cut to a preview here) for a Codex tool-like item; message, reasoning and lifecycle items return null. */
export function itemTool(item: Row): { title: string; detail: NativeToolDetail } | null {
  switch (item.type) {
    case "commandExecution": {
      const command = typeof item.command === "string" ? item.command : "", shape = commandShape(item);
      const output = typeof item.aggregatedOutput === "string" ? { output: item.aggregatedOutput } : {}, exit = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? { exitCode: item.exitCode } : {};
      // What Codex parsed the command into (`commandActions`): a read of files is shown as one, a search as a search; anything else is a command.
      if (shape?.kind === "read") return { title: "读取 " + shape.paths.map(path => basename(path)).slice(0, 3).join(", "), detail: { kind: "read", name: "read_file", ...(command ? { input: command } : {}), ...output, ...exit, locations: shape.paths.slice(0, 16) } };
      if (shape !== null) {
        const input = json({ ...(shape.query ? { query: shape.query } : {}), ...(shape.paths[0] ? { path: shape.paths[0] } : {}), command });
        return { title: (shape.kind === "list" ? "列出 " : "搜索 ") + (shape.query ?? shape.paths[0] ?? (line(command) || "文件")), detail: { kind: "search", name: shape.kind === "list" ? "list_files" : "grep", ...(input ? { input } : {}), ...output, ...exit } };
      }
      return { title: line(command) || "命令", detail: { kind: "execute", name: "shell", ...(command ? { input: command } : {}), ...output, ...exit, ...(typeof item.cwd === "string" ? { locations: [item.cwd] } : {}) } };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [], paths = changes.flatMap(change => { const row = record(change); return row !== null && typeof row.path === "string" ? [row.path] : []; });
      return { title: changeTitle(changes), detail: { kind: "edit", name: "apply_patch", ...(changes.length ? { diff: changes.map(fileDiff).join("") } : {}), ...(paths.length ? { locations: paths.slice(0, 16) } : {}) } };
    }
    case "mcpToolCall": {
      const name = String(item.server ?? "mcp") + "/" + String(item.tool ?? "tool"), result = record(item.result), error = record(item.error)?.message;
      const texts = Array.isArray(result?.content) ? result.content.flatMap(part => { const row = record(part); return row?.type === "text" && typeof row.text === "string" ? [row.text] : []; }) : [];
      const output = typeof error === "string" ? error : texts.length ? texts.join("\n") : json(result?.structuredContent ?? result ?? undefined), input = json(item.arguments), shown = mcpPresentation(item);
      return { title: shown.title ? line(shown.title, 1024) : line(name.replace("/", ".")), detail: { kind: "mcp", name, ...(input ? { input } : {}), ...(output ? { output } : {}), ...(shown.locations ? { locations: shown.locations } : {}) } };
    }
    case "webSearch": {
      // `action` (0.169.0): a search with its queries, a page opened, or a pattern looked for in a page.
      const action = record(item.action), query = typeof item.query === "string" ? item.query : "", results = item.results != null ? { output: json(item.results) ?? "" } : {};
      if (action?.type === "openPage") { const url = httpUrl(action.url) ?? (typeof action.url === "string" ? action.url : "");
        return { title: "打开网页 " + (line(url, 512) || line(query, 200)), detail: { kind: "fetch", name: "web_fetch", ...(url ? { input: url, locations: [url] } : query ? { input: query } : {}), ...results } }; }
      if (action?.type === "findInPage") { const url = typeof action.url === "string" ? action.url : "", pattern = typeof action.pattern === "string" ? action.pattern : query;
        return { title: "在网页中查找：" + (line(pattern, 200) || "内容"), detail: { kind: "search", name: "web_search", ...(pattern ? { input: pattern } : {}), ...(url ? { locations: [url] } : {}), ...results } }; }
      const queries = action?.type === "search" && Array.isArray(action.queries) ? action.queries.filter((value): value is string => typeof value === "string" && value.trim() !== "") : [];
      const said = queries.length ? queries.join("\n") : (typeof action?.query === "string" && action.query ? action.query : query);
      return { title: "搜索：" + (line(said.split("\n")[0] ?? "", 200) || "网页"), detail: { kind: "search", name: "web_search", ...(said ? { input: said } : {}), ...results } };
    }
    case "imageView": return { title: "查看图片 " + (typeof item.path === "string" ? basename(item.path) : ""), detail: { kind: "image", name: "view_image", ...(typeof item.path === "string" ? { locations: [item.path] } : {}) } };
    case "imageGeneration": return { title: "生成图片", detail: { kind: "image", name: "image_generation", ...(typeof item.revisedPrompt === "string" ? { input: item.revisedPrompt } : {}), ...(typeof item.savedPath === "string" ? { locations: [item.savedPath] } : {}) } };
    case "collabAgentToolCall": { const states = record(item.agentsStates) ? Object.entries(item.agentsStates as Row).map(([thread, state]) => thread + ": " + String(record(state)?.status ?? state)).join("\n") : "";
      return { title: "子 Agent · " + String(item.tool ?? "协作"), detail: { kind: "subagent", name: String(item.tool ?? "collab"), ...(typeof item.prompt === "string" ? { input: item.prompt } : {}), ...(states ? { output: states } : {}) } }; }
    case "dynamicToolCall": { const texts = Array.isArray(item.contentItems) ? item.contentItems.flatMap(part => { const row = record(part); return typeof row?.text === "string" ? [row.text] : []; }) : [], input = json(item.arguments);
      return { title: line(String(item.tool ?? "工具")), detail: { kind: "tool", name: String(item.tool ?? "tool"), ...(input ? { input } : {}), ...(texts.length ? { output: texts.join("\n") } : {}) } }; }
    case "sleep": return { title: "等待 " + Math.round(Number(item.durationMs ?? 0) / 1000) + " 秒", detail: { kind: "other", name: "sleep" } };
    default: return null;
  }
}
/** An item's status as the Hub says it; `declined` (a change or command the user or auto-review refused) is cancelled (T3 Code). */
export function status(value: unknown, started: boolean): string {
  return value === "inProgress" ? "in_progress" : value === "declined" ? "cancelled" : typeof value === "string" ? value : started ? "in_progress" : "completed";
}

// ---- messages ------------------------------------------------------------------------------------------------------------

/**
 * An agent message's text, with its asynchronous questions (`delivery: "async"`, `questions[{title, options}]`) after it when the text does not
 * already say them: Codex goes on without waiting, and the user answers them with the next message.
 */
export function asyncQuestions(item: Row, said: string): string {
  if (item.delivery !== "async" || !Array.isArray(item.questions)) return "";
  const lines = item.questions.flatMap(value => {
    const question = record(value), title = text(question?.title);
    if (question === null || title === undefined || said.includes(title)) return [];
    const options = Array.isArray(question.options) ? question.options.filter((option): option is string => typeof option === "string" && option.trim() !== "") : [];
    return ["- " + title + (options.length ? "（" + options.join(" / ") + "）" : "")];
  });
  return lines.length ? (said.trim() ? "\n\n" : "") + lines.join("\n") : "";
}
/** The text a user sees for one native user input item; non-text inputs are named, never inlined. */
export function inputText(value: unknown): string {
  const item = record(value) ?? {};
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "image" || item.type === "localImage") return "[图片]";
  if (item.type === "audio" || item.type === "localAudio") return "[音频]";
  if (item.type === "skill" && typeof item.name === "string") return "/skill:" + item.name;
  if (item.type === "mention" && typeof item.name === "string") return "@" + item.name;
  return "";
}
/** The client identity a userMessage item echoes: `clientId` (0.166.0 and later), or the request's own field name for a Codex that echoes it so. */
export function echoedClientId(item: Row): string | null {
  return typeof item.clientId === "string" ? item.clientId : typeof item.clientUserMessageId === "string" ? item.clientUserMessageId : null;
}
/**
 * One turn of a thread's full history (`thread/turns/list itemsView: "full"`) as the user's words and the agent's reply: its user messages, and its
 * agent messages after one line for each thing it did (a command, a change, a search, a tool), so a continued conversation keeps what was done.
 */
export function importTurn(items: readonly unknown[]): { readonly user: string; readonly assistant: string } {
  const user: string[] = [], said: string[] = [], did: string[] = [];
  for (const value of items) {
    const item = record(value);
    if (item === null) continue;
    if (item.type === "userMessage" && Array.isArray(item.content)) { const words = item.content.map(inputText).filter(Boolean).join("\n"); if (words) user.push(words); continue; }
    if (item.type === "agentMessage" && typeof item.text === "string") { const words = item.text + asyncQuestions(item, item.text); if (words.trim()) said.push(words); continue; }
    if (item.type === "plan" && typeof item.text === "string" && item.text.trim()) { said.push(item.text); continue; }
    if (item.type === "fileChange" && Array.isArray(item.changes)) { did.push(...changeLines(item.changes)); continue; }
    if (item.type === "commandExecution" && typeof item.command === "string") { did.push("运行 `" + line(item.command, 300) + "`" + (typeof item.exitCode === "number" && item.exitCode !== 0 ? "（退出码 " + item.exitCode + "）" : "")); continue; }
    const tool = itemTool(item);
    if (tool !== null && item.type !== "imageView") did.push(tool.title);
  }
  const done = did.length ? "（这一轮里做了：" + did.join("；") + "）" : "";
  return { user: user.join("\n\n"), assistant: [done, ...said].filter(Boolean).join("\n\n") };
}
export function threadTitle(thread: Row): string | null {
  const value = [thread.name, thread.preview].find(item => typeof item === "string" && item.trim()) as string | undefined;
  return value === undefined ? null : value.replace(/\s+/gu, " ").trim().slice(0, 200);
}
export function threadSource(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 64);
  return record(value) ? Object.keys(value as Row)[0]?.slice(0, 64) : undefined;
}
/** The app-server version its user agent states (`<originator>/<x.y.z> (…)`); null when it is not stated that way. */
export function userAgentVersion(userAgent: string): string | null {
  return /^[^/\s]+\/(\d{1,6}\.\d{1,6}\.\d{1,6})(?=$|[\s(;+-])/u.exec(userAgent)?.[1] ?? null;
}

// ---- failures ------------------------------------------------------------------------------------------------------------

/** Typed native failure (codexErrorInfo) first; message text is only a fallback for older servers. */
export function turnFailure(error: Row): { readonly code: string; readonly message: string } {
  const info = error.codexErrorInfo, kind = typeof info === "string" ? info : record(info) ? Object.keys(info as Row)[0] : undefined;
  const message = typeof error.message === "string" ? error.message : "";
  if (kind === "unauthorized" || kind === undefined && /unauthorized|not logged|authentication|api key|401/iu.test(message)) return { code: "HARNESS_AUTH_REQUIRED", message: "本机 Codex 登录或模型认证不可用，请检查它的登录状态。" };
  if (kind === "usageLimitExceeded" || kind === "sessionBudgetExceeded") return { code: "NATIVE_QUOTA_EXCEEDED", message: "Codex 账号额度或本会话预算已用完。可等待额度恢复，或选择其他 Harness 继续。" };
  if (kind === "rateLimitExceeded" || kind === "serverOverloaded" || kind === undefined && /rate limit|quota|429/iu.test(message)) return { code: "MODEL_RATE_LIMIT", message: "模型服务当前达到额度或调用限制，请稍后再试。" };
  if (kind === "contextWindowExceeded") return { code: "CONTEXT_WINDOW_EXCEEDED", message: "对话已超过模型上下文窗口。可以压缩原生上下文或重新建立原生会话后继续。" };
  if (kind === "httpConnectionFailed" || kind === "responseStreamConnectionFailed" || kind === "responseStreamDisconnected" || kind === "responseTooManyFailedAttempts") return { code: "NATIVE_CONNECTION_FAILED", message: "Codex 无法连接模型服务。请检查网络或本机配置后重试。" };
  if (kind === "cyberPolicy" || kind === "misalignmentPolicyViolation") return { code: "MODEL_POLICY_REFUSED", message: "模型服务按其策略拒绝了这次请求。" };
  if (kind === "modelNotFound") return { code: "NATIVE_MODEL_UNAVAILABLE", message: "所选模型在 Codex 的模型服务中不可用，请换一个模型。" };
  if (kind === "sandboxError") return { code: "MODEL_REQUEST_FAILED", message: "Codex 的沙箱没能运行这一步，请检查本机沙箱设置。" };
  if (kind === "tooManyDenials") return { code: "MODEL_REQUEST_FAILED", message: "Codex 的请求被拒绝太多次，这一轮停下了。" };
  return { code: "MODEL_REQUEST_FAILED", message: "Codex 的模型请求未完成，请检查本机配置或更换模型。" };
}

// ---- usage ---------------------------------------------------------------------------------------------------------------

export interface Tokens { readonly totalTokens: number; readonly inputTokens: number; readonly cachedInputTokens: number; readonly cacheWriteInputTokens: number; readonly outputTokens: number; readonly reasoningOutputTokens: number }
const KEYS = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
const ZERO: Tokens = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
export function tokens(value: unknown): Tokens | null {
  const row = record(value);
  if (row === null) return null;
  const read = (key: string) => typeof row[key] === "number" && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 ? row[key] as number : 0;
  return { totalTokens: read("totalTokens"), inputTokens: read("inputTokens"), cachedInputTokens: read("cachedInputTokens"), cacheWriteInputTokens: read("cacheWriteInputTokens"), outputTokens: read("outputTokens"), reasoningOutputTokens: read("reasoningOutputTokens") };
}
/**
 * 移植自 T3 Code（MIT, © 2026 T3 Tools Inc.）：apps/server/src/provider/CodexTurnTokenUsage.ts。
 * One thread's usage over one Hub Turn from its running totals: each report adds the difference to the previous total, or the report's own
 * `last` (the newest model request) when any total went down (Codex's totals can). A report about another turn only moves the baseline.
 */
export class TurnUsage {
  private sum: Tokens = ZERO;
  observed = false;
  constructor(private baseline: Tokens | null) {}
  add(total: Tokens, last: Tokens | null): void {
    const previous = this.baseline, fell = previous === null || KEYS.some(key => key !== "cacheWriteInputTokens" && total[key] < previous[key]);
    const delta: Tokens = fell ? last ?? ZERO : Object.fromEntries(KEYS.map(key => [key, Math.max(0, total[key] - previous![key])])) as unknown as Tokens;
    this.baseline = total;
    if (KEYS.some(key => delta[key] > 0)) this.observed = true;
    this.sum = Object.fromEntries(KEYS.map(key => [key, this.sum[key] + delta[key]])) as unknown as Tokens;
  }
  rebase(total: Tokens): void { this.baseline = total; }
  get value(): Tokens { return this.sum; }
}
/** The Turn's own numbers: the thread's and its sub-agents' together. Codex counts cache reads and writes inside inputTokens, so neither exceeds it. */
export function turnTokens(parts: readonly Tokens[]): NonNullable<NativeUsage["turn"]> {
  const sum = (key: keyof Tokens) => parts.reduce((total, part) => total + part[key], 0);
  const input = sum("inputTokens"), output = sum("outputTokens");
  return { input, output, cachedInput: Math.min(input, sum("cachedInputTokens")), cacheWrite: Math.min(input, sum("cacheWriteInputTokens")), reasoning: Math.min(output, sum("reasoningOutputTokens")), total: sum("totalTokens") };
}
