import type { CommandItem, FileChange as ProtocolFileChange, FileChangeItem, FileReadItem, ItemBase, ItemStatus, McpToolItem, PlanStep, SearchItem, SubagentItem, ToolItem, WebItem, WorkItem } from "../../../../contracts/protocol.js";
import type { PublicTool } from "../../../../contracts/session.js";
import { TABLE_MCP_NAME, TABLE_PROGRESS_TOOLS, TABLE_TOOL_SEARCH, TABLE_TOOLS } from "../../../../contracts/table.js";
import { changesFrom, diffFiles, locationOf, type ToolDetailInput } from "./changes.js";
import { unwrapShell } from "./shell.js";
import { itemStatus } from "./status.js";

/**
 * The one rule that turns a Harness's tool call into a protocol item (docs/proposals/protocol/hub-protocol.html §7). The input is
 * what the Hub already stores of a call — its title, status, kind, name, exit code, and (when read) the head of its stored detail —
 * and the output is one of the eight action types, or the verdict that the call is the Harness's task list and not an action.
 * The relay's narration and the context table read the same classification (`toolFamily`), so there is one table for six Harnesses.
 *
 * How a call is told, in this order: the family the Harness itself reported in `kind` (read, edit, search, execute, fetch, mcp,
 * subagent, think), which is what the relay has always trusted; where it reported none (`other`, nothing, or a word of its own),
 * the name table below — by the call's name, else by the name a title begins with (`terminal: ls`), else by a title that is only a
 * name (DeepSeek Harness titles a call `bash`). The protocol then refines the family into its richer types (a search the Harness
 * called `fetch` is a web search, a `delegate:` call it called `execute` is a sub-task). A call no rule knows is a `tool`, shown by
 * its own name and never dropped. Pure.
 */

/** The relay's vocabulary of what a tool is; the table and the packet are worded by it. */
export type ToolFamily = "read" | "change" | "search" | "execute" | "fetch" | "think" | "subagent" | "mcp" | "other";
/** How the family was told: by the Harness's own `kind`, or by the name table (`none`: it was not told). A call told by name only has a title that may be just its name. */
export interface ToolClass { readonly family: ToolFamily; readonly via: "kind" | "name" | "none" }

/** The facts of a call the classification reads. */
export type ToolFacts = Pick<PublicTool, "title" | "kind" | "name" | "status" | "exitCode">;

const NATIVE_FAMILY: ReadonlyMap<string, ToolFamily> = new Map<string, ToolFamily>([
  ["read", "read"], ["edit", "change"], ["delete", "change"], ["move", "change"], ["search", "search"], ["execute", "execute"],
  ["fetch", "fetch"], ["think", "think"], ["subagent", "subagent"], ["task", "subagent"], ["mcp", "mcp"],
]);

type RuleType = "command" | "file_read" | "file_change" | "search" | "web" | "subagent" | "plan";
interface Rule {
  readonly family: ToolFamily; readonly type: RuleType;
  /** A search by name (`files`: glob, ls) or inside files (`content`: grep); absent: not told. */
  readonly scope?: "files" | "content";
  /** A web call's action. */
  readonly action?: "search" | "fetch";
}
/** A name by its letters only, so `web_search`, `WebSearch` and `web-search` are one name. */
function nameKey(name: string): string { return name.toLowerCase().replace(/[\s_.-]+/gu, ""); }
const RULES = new Map<string, Rule>();
function add(rule: Rule, ...names: readonly string[]): void { for (const name of names) RULES.set(nameKey(name), rule); }
add({ family: "execute", type: "command" }, "bash", "shell", "sh", "zsh", "exec", "terminal", "run", "execute", "command", "run_command", "run_shell_command", "execute_command",
  "exec_command", "shell_command", "local_shell", "container.exec");
add({ family: "read", type: "file_read" }, "read", "read_file", "view", "view_file", "open_file", "cat", "view_image", "read_many_files");
add({ family: "change", type: "file_change" }, "edit", "multi_edit", "write", "write_file", "create_file", "edit_file", "update_file", "str_replace", "str_replace_editor",
  "str_replace_based_edit_tool", "apply_patch", "patch", "replace", "notebook_edit", "insert", "delete_file", "remove_file", "move_file", "rename_file");
add({ family: "search", type: "search", scope: "content" }, "grep", "ripgrep", "rg", "search_file_content", "codebase_search", "code_search", "search_code", "find_in_files");
add({ family: "search", type: "search", scope: "files" }, "glob", "ls", "list", "list_dir", "list_directory", "list_files", "find", "find_files", "file_search", "tree", "dir");
add({ family: "search", type: "search" }, "search", "search_files", "memory_search");
add({ family: "search", type: "web", action: "search" }, "web_search", "search_web", "internet_search", "google_search");
add({ family: "fetch", type: "web", action: "fetch" }, "web_fetch", "fetch", "fetch_url", "open_url", "read_url", "browse");
add({ family: "subagent", type: "subagent" }, "task", "agent", "delegate_task", "delegate", "sessions_spawn", "spawn_agent", "subagent", "codex-subagent", "run_subagent");
// The Harness's own task list: it is shown as the Turn's plan, not as a row of work.
add({ family: "other", type: "plan" }, "todo_write", "update_plan", "update_todos", "todo");

/** The name a call goes by: its own, else the one its title begins with (`terminal: ls`), else a title that is only a name. */
interface Named { readonly raw: string; readonly key: string; readonly source: "name" | "title-prefix" | "title" }
function namedBy(tool: Pick<PublicTool, "title" | "name">): Named | null {
  if (tool.name !== undefined && tool.name.trim() !== "") return { raw: tool.name.trim(), key: nameKey(tool.name), source: "name" };
  const title = tool.title.trim(), prefix = /^([A-Za-z][A-Za-z0-9_.-]{0,48})\s*:\s+\S/u.exec(title);
  if (prefix !== null) return { raw: prefix[1]!, key: nameKey(prefix[1]!), source: "title-prefix" };
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(title) ? { raw: title, key: nameKey(title), source: "title" } : null;
}
const MCP_PREFIXED = /^mcp__(.+?)__(.+)$/u, MCP_JOINED = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_.-]+)$/u;
/** OpenCode joins a server and a tool with an underscore; the Hub's own tools are the only ones told that way, since only they are known exactly. */
const HUB_JOINED = new RegExp("^" + TABLE_MCP_NAME + "_(" + TABLE_TOOLS.join("|") + ")$", "u");
/**
 * Hermes's gateway names a server an ACP client handed it `editor_<name>_<tag>` (gateway/session_local_mcp.py `_server_names`, the tag 8 hex
 * digits of the session): the Hub's own server is told by that name too, and no other server is renamed.
 */
const HERMES_EDITOR_HUB = new RegExp("^editor_" + TABLE_MCP_NAME + "_[0-9a-f]{8}$", "u");
/** The server and the tool of an MCP call's name: `mcp__server__tool` (Claude Code, DeepSeek Harness, Hermes), `server/tool` or `server.tool` (Codex), `harnesshub_tool` (OpenCode). */
function mcpParts(raw: string): { readonly server: string; readonly tool: string } | null {
  const prefixed = MCP_PREFIXED.exec(raw);
  if (prefixed !== null) return { server: HERMES_EDITOR_HUB.test(prefixed[1]!) ? TABLE_MCP_NAME : prefixed[1]!, tool: prefixed[2]! };
  const joined = MCP_JOINED.exec(raw);
  if (joined !== null) return { server: joined[1]!, tool: joined[2]! };
  const hub = HUB_JOINED.exec(raw);
  return hub === null ? null : { server: TABLE_MCP_NAME, tool: hub[1]! };
}
/** Whether a name tells an MCP call when the Harness reported no kind: the `mcp__` form always, `server/tool` only as a name the Harness gave, the Hub's own tools in any form. */
function mcpShaped(named: Named): boolean {
  if (MCP_PREFIXED.test(named.raw) || HUB_JOINED.test(named.raw)) return true;
  const parts = MCP_JOINED.exec(named.raw);
  return parts !== null && (named.source === "name" || parts[1] === TABLE_MCP_NAME);
}

/** Whether a call (or a permission request's title) names one of the Hub's own tools (TABLE_TOOLS of the server TABLE_MCP_NAME), in any Harness's spelling. */
export function isHubToolCall(tool: Pick<PublicTool, "title" | "name">): boolean {
  const named = namedBy(tool), parts = mcpParts(named?.raw ?? tool.title.trim());
  return parts !== null && parts.server === TABLE_MCP_NAME && (TABLE_TOOLS as readonly string[]).includes(parts.tool);
}
/** Whether a call is one of the Hub's two tools that tell how the Turn goes (`hub_update_plan`, `hub_wrap_up`): what it said is the Turn's task list or wrap-up, not an action. */
export function isHubProgressCall(tool: Pick<PublicTool, "title" | "name">): boolean {
  const named = namedBy(tool), parts = mcpParts(named?.raw ?? tool.title);
  return parts !== null && parts.server === TABLE_MCP_NAME && (TABLE_PROGRESS_TOOLS as readonly string[]).includes(parts.tool);
}
/** Which family a call is of; see the order above. */
export function classifyTool(tool: ToolFacts): ToolClass { return classified(tool, namedBy(tool)); }
function classified(tool: ToolFacts, named: Named | null): ToolClass {
  const native = NATIVE_FAMILY.get(tool.kind ?? "");
  if (native !== undefined) return { family: native, via: "kind" };
  if (named === null) return { family: "other", via: "none" };
  const rule = RULES.get(named.key);
  if (rule !== undefined) return { family: rule.family, via: rule.type === "plan" ? "none" : "name" };
  return mcpShaped(named) ? { family: "mcp", via: "name" } : { family: "other", via: "none" };
}
/** The family alone: what the relay's narration and the context table call a tool's kind. */
export function toolFamily(tool: ToolFacts): ToolFamily { return classifyTool(tool).family; }

// ---------------------------------------------------------------------------------------------------------------------
// What the stored detail adds
// ---------------------------------------------------------------------------------------------------------------------

/** How much of a stored input the protocol keeps to read an object out of (a command, a path, a query). */
export const HEAD_INPUT = 4096;
/** The most characters one label of an item holds (a command, a path, a query, a title); a longer one is cut with an ellipsis, the whole stays in the stored detail. */
export const LABEL_MAX = 1000;
/**
 * A stored tool detail (the JSON the Runtime keeps for a call, read back as `unknown`) as far as the protocol uses it: the head of its
 * input, up to 16 locations and its diff's files counted. The diff and the output are not kept: they are fetched when a call is
 * opened. null when it is not an object.
 */
export function detailHead(value: unknown): ToolDetailInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>;
  const locations = Array.isArray(row.locations) ? row.locations.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  const files = typeof row.diff === "string" ? diffFiles(row.diff).slice(0, 64) : [];
  return { ...(typeof row.input === "string" ? { input: row.input.slice(0, HEAD_INPUT) } : {}), ...(locations.length ? { locations } : {}), ...(files.length ? { files } : {}) };
}

function clip(text: string): string { return text.length <= LABEL_MAX ? text : text.slice(0, LABEL_MAX - 1) + "…"; }
/** A command title fully wrapped in one pair of backticks (as some Drivers write commands) without them. */
function backticks(text: string): string { return /^`[^`]+`$/u.test(text) ? text.slice(1, -1) : text; }
function unquote(text: string): string {
  const value = text.trim();
  return value.length >= 2 && /^(?:`[^`]*`|"[^"]*"|'[^']*'|“[^”]*”)$/u.test(value) ? value.slice(1, -1).trim() : value;
}
/**
 * A string field of a stored input that is a JSON object. A head cut inside the JSON still gives the fields that are whole, so a
 * write whose content runs past the head still says where it wrote.
 */
function inputField(input: string | undefined, keys: readonly string[]): string | undefined {
  const text = input?.trim();
  if (text === undefined || !text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const key of keys) { const found = (value as Readonly<Record<string, unknown>>)[key]; if (typeof found === "string" && found.trim() !== "") return found; }
      return undefined;
    }
  } catch { /* cut inside the JSON: read what is whole */ }
  for (const key of keys) {
    const match = new RegExp('"' + key + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")', "u").exec(text);
    if (match === null) continue;
    try { const found: unknown = JSON.parse(match[1]!); if (typeof found === "string" && found.trim() !== "") return found; } catch { /* not a string */ }
  }
  return undefined;
}
/** Whether a text is only the tool's own name (a title that says nothing of what it acted on), in any case. */
function isName(text: string, tool: Pick<PublicTool, "name">, named: Named | null): boolean {
  const lower = text.toLowerCase();
  return lower === (tool.name ?? "").toLowerCase() || lower === (named?.raw ?? "").toLowerCase();
}
/** A title's own words after the verb a Harness put in front of its object (`Read src/a.ts`, `修改 a.ts`); the whole title when it has none. */
function afterVerb(title: string, verbs: RegExp): string { return unquote(title.trim().replace(verbs, "")); }

/** Titles a Driver writes when the Harness gave none: they say no command and no path. */
const PLACEHOLDER = new Set(["命令", "工具调用", "terminal", "file", "文件"]);
const COMMAND_PREFIX = /^(?:terminal|exec|bash|shell|sh|zsh|command|run|execute)\s*:\s+/iu;
const READ_VERB = /^(?:查看图片|read(?:[_ ]?file)?|view(?:[_ ]?file)?|open(?:[_ ]?file)?|cat|读取|查看|阅读)\s*[:：]?\s+/iu;
const READ_RANGE = /\s+\((?:from line\s+)?\d+(?:\s*-\s*\d*)?\)$/iu;
const CHANGE_VERB = /^(?:multi[_ ]?edit|notebook[_ ]?edit|edit(?:[_ ]?file)?|write(?:[_ ]?file)?|create(?:[_ ]?file)?|update(?:[_ ]?file)?|apply[_ ]?patch|patch|delete(?:[_ ]?file)?|remove|move|rename|修改|编辑|写入|新建|创建|删除|移动|重命名)\s*[:：]?\s+/iu;
const SEARCH_VERB = /^(?:search(?:[_ ]?files)?|grep|glob|find|ls|搜索|查找)\s*[:：]?\s+/iu;
const QUOTED = /"([^"]+)"|`([^`]+)`|“([^”]+)”|'([^']+)'/gu;

/** The tools a script calls as `tools.<server>.<tool>(` or `tools["<server>"].<tool>(` (OpenCode's Code Mode), in the order they are written. */
function scriptCalls(code: string | undefined): readonly { readonly server: string; readonly tool: string }[] {
  if (code === undefined) return [];
  const found: { server: string; tool: string }[] = [];
  for (const match of code.matchAll(/\btools\s*(?:\.\s*([A-Za-z0-9_-]+)|\[\s*["']([A-Za-z0-9_-]+)["']\s*\])\s*(?:\?\.|\.)\s*([A-Za-z0-9_]+)\s*\(/gu)) found.push({ server: match[1] ?? match[2]!, tool: match[3]! });
  return found;
}
/** The command a call ran: its stored input when that is the command, else its title when the Harness writes the command as its title. Empty: not told. */
function commandText(tool: PublicTool, detail: ToolDetailInput | null, named: Named | null): string {
  const input = detail?.input?.trim() ?? "";
  if (input !== "") {
    if (!input.startsWith("{")) return input;
    // `code`: the script of a tool that runs one (OpenCode's Code Mode), shown as the command it is.
    const field = inputField(input, ["command", "cmd", "script", "shell_command", "code"]);
    if (field !== undefined) return field;
  }
  // The title is the command only where the Harness says it ran one, never where it is just the tool's name.
  if (tool.kind !== "execute" && named?.source !== "title-prefix") return "";
  const text = backticks(tool.title.trim().replace(COMMAND_PREFIX, "").trim());
  return PLACEHOLDER.has(text.toLowerCase()) ? "" : text;
}
/** The command a call ran as the Harness wrote it (not unwrapped from its shell, not cut), from its stored input or its title; empty when the call says none. */
export function commandTextOf(tool: PublicTool, detail: ToolDetailInput | null): string { return commandText(tool, detail, namedBy(tool)); }
function readPath(tool: PublicTool, detail: ToolDetailInput | null, named: Named | null): string | null {
  const located = locationOf(detail ?? undefined);
  if (located !== null) return clip(located);
  const field = inputField(detail?.input, ["file_path", "path", "filePath", "file", "filename", "target_file", "notebook_path", "uri"]);
  if (field !== undefined) return clip(field);
  const text = afterVerb(tool.title, READ_VERB).replace(READ_RANGE, "").trim();
  return text === "" || PLACEHOLDER.has(text.toLowerCase()) || isName(text, tool, named) ? null : clip(text);
}
const OPS: Readonly<Record<"create" | "delete" | "edit" | "move", ProtocolFileChange["op"]>> = { create: "create", delete: "delete", edit: "modify", move: "rename" };
/** What a change call changed: the files its stored detail names (its diff, its locations), else the one path its title gives; none when neither says. */
function changesOf(tool: PublicTool, detail: ToolDetailInput | null, named: Named | null): readonly ProtocolFileChange[] {
  const found = changesFrom(tool, detail ?? undefined);
  if (found !== null) return found.map(file => ({ path: clip(file.path), op: OPS[file.op], ...(file.added === null ? {} : { added: file.added }), ...(file.removed === null ? {} : { removed: file.removed }) }));
  const field = inputField(detail?.input, ["file_path", "path", "filePath", "notebook_path", "target_file"]);
  const text = field ?? (/[,，]|等\s*\d+\s*个文件|\n/u.test(tool.title) ? "" : afterVerb(tool.title, CHANGE_VERB));
  if (text === "" || PLACEHOLDER.has(text.toLowerCase()) || isName(text, tool, named)) return [];
  const op = tool.kind === "delete" ? "delete" : tool.kind === "move" ? "move" : /^(?:create|新建|创建)/iu.test(tool.title.trim()) ? "create" : "edit";
  return [{ path: clip(text), op: OPS[op] }];
}
/** The words of a search: its pattern or query out of its stored input, else what is quoted in its title, else its title without the verb. */
function searchTerms(tool: PublicTool, detail: ToolDetailInput | null, named: Named | null): { readonly query: string | null; readonly path?: string } {
  const path = inputField(detail?.input, ["path", "directory", "dir"]);
  const field = inputField(detail?.input, ["pattern", "query", "q", "regex", "search", "glob", "term", "keyword", "search_query"]);
  const where = path === undefined ? {} : { path: clip(path) };
  if (field !== undefined) return { query: clip(field), ...where };
  const input = detail?.input?.trim() ?? "";
  if (input !== "" && !input.startsWith("{") && !input.includes("\n") && input.length <= 300) return { query: input, ...where };
  const quoted = [...tool.title.matchAll(QUOTED)].map(match => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").filter(Boolean).at(-1);
  if (quoted !== undefined) return { query: clip(quoted), ...where };
  const text = afterVerb(tool.title, SEARCH_VERB).replace(/^网页\s*$/u, "");
  return { query: text === "" || isName(text, tool, named) ? null : clip(text), ...where };
}
function webTerms(tool: PublicTool, detail: ToolDetailInput | null, named: Named | null, action: "search" | "fetch"): { readonly query?: string; readonly url?: string } {
  const url = inputField(detail?.input, ["url", "uri"]) ?? /https?:\/\/[^\s"'`<>]+/u.exec(tool.title)?.[0] ?? (/^https?:\/\/\S+$/u.test(detail?.input?.trim() ?? "") ? detail!.input!.trim() : undefined);
  if (action === "fetch") return url === undefined ? {} : { url: clip(url) };
  const search = searchTerms(tool, detail, named);
  return search.query === null ? {} : { query: search.query };
}
function subagentTitle(tool: PublicTool, named: Named | null): string {
  // A title a Harness wrote as `name: what`, or the Hub's own `子 Agent · who`, without that front.
  const own = named === null ? null : new RegExp("^" + named.raw.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "\\s*:\\s+", "iu");
  const text = unquote(tool.title.trim().replace(/^(?:子 Agent\s*·\s*|delegate\s*:\s*|task\s*:\s*|agent\s*:\s*)/iu, "").replace(own ?? /^$/u, ""));
  return text === "" || isName(text, tool, named) ? "" : clip(text);
}

/**
 * The Harness's task list from a stored input (`{"todos": [{"content": …, "status": …}]}`: OpenCode's todowrite, DeepSeek Harness's
 * todo_write), when every step has a text and a status the plan knows; null otherwise, so that a list that cannot be read exactly
 * stays visible as the call it is.
 */
export function planFromInput(input: string | undefined): readonly PlanStep[] | null {
  const text = input?.trim();
  if (text === undefined || !text.startsWith("{")) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const todos = value !== null && typeof value === "object" ? (value as Readonly<Record<string, unknown>>).todos : undefined;
  if (!Array.isArray(todos) || todos.length === 0 || todos.length > 64) return null;
  const steps: PlanStep[] = [];
  for (const row of todos) {
    if (row === null || typeof row !== "object") return null;
    const step = row as Readonly<Record<string, unknown>>, words = [step.content, step.text, step.step, step.title].find((item): item is string => typeof item === "string" && item.trim() !== "");
    const status = itemStatus(typeof step.status === "string" ? step.status : "");
    if (words === undefined || (status !== "pending" && status !== "running" && status !== "completed")) return null;
    steps.push({ text: words, status: status === "running" ? "in_progress" : status });
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------------------------------------

/** Where the call stands in its Turn. */
export interface ToolContext {
  /** The call's place in the Turn. */
  readonly seq: number;
  /** The head of its stored detail, when it was read; null when it is not stored yet, could not be read, or the Harness stored none. */
  readonly detail: ToolDetailInput | null;
  /** `going`: the Turn is still running; `ended`: it is over; `cancelled`: it is over because it was stopped. A call still open in an over Turn did not finish. */
  readonly turn: "going" | "ended" | "cancelled";
}
/** A call as the protocol tells it: a row of work, or the Harness's task list (the Turn's plan, shown as such and not as a row). */
export type Normalized = { readonly row: true; readonly item: WorkItem } | { readonly row: false; readonly reason: "plan" };

function stateOf(tool: PublicTool, ctx: ToolContext, command: boolean): ItemStatus {
  let status = itemStatus(tool.status);
  // A command that exited with anything but 0 failed, whatever word the Harness used.
  if (command && tool.exitCode !== undefined && tool.exitCode !== 0 && status !== "declined" && status !== "cancelled") status = "failed";
  if ((status === "pending" || status === "running" || status === "waiting") && ctx.turn !== "going") status = ctx.turn === "cancelled" ? "cancelled" : "unknown";
  return status;
}
/** A call as the fallback type tells it: its own name and nothing else. The task-list call the Turn's plan could not be read from stays visible as this. */
export function plainTool(tool: PublicTool, ctx: ToolContext): ToolItem {
  const named = namedBy(tool), nativeName = named?.raw;
  return { id: tool.id, seq: ctx.seq, status: stateOf(tool, ctx, false), ...(tool.parentId === undefined ? {} : { parentId: tool.parentId }),
    ...(nativeName === undefined ? {} : { nativeName }), ...(tool.detail === undefined ? {} : { detail: tool.detail }), type: "tool", name: clip(nativeName ?? tool.title) };
}

/** The protocol's item for one tool call (or the verdict that it is the task list). */
export function normalizeTool(tool: PublicTool, ctx: ToolContext): Normalized {
  const named = namedBy(tool), { family, via } = classified(tool, named), rule = named === null ? undefined : RULES.get(named.key), detail = ctx.detail;
  // The Harness's task list is the plan, unless the Harness itself filed the call as something it does (a command that is called `todo` is a command).
  if (rule?.type === "plan" && (via !== "kind" || family === "think")) return { row: false, reason: "plan" };
  const nativeName = named?.raw;
  const base = (status: ItemStatus): ItemBase => ({ id: tool.id, seq: ctx.seq, status, ...(tool.parentId === undefined ? {} : { parentId: tool.parentId }),
    ...(nativeName === undefined ? {} : { nativeName }), ...(tool.detail === undefined ? {} : { detail: tool.detail }) });
  const asTool = (): Normalized => ({ row: true, item: plainTool(tool, ctx) });
  const done = (item: WorkItem): Normalized => ({ row: true, item });

  // A sub-task by its name (a Claude Code Task, a Hermes delegate) is one whatever family the Harness filed it under.
  if (rule?.type === "subagent" && (family === "think" || family === "execute" || family === "subagent" || family === "other")) {
    const item: SubagentItem = { ...base(stateOf(tool, ctx, false)), type: "subagent", title: subagentTitle(tool, named) }; return done(item);
  }
  switch (family) {
    case "execute": {
      // OpenCode's Code Mode runs tools from a script (`execute` with `code`: `await tools.<server>.<tool>(…)`). A script that calls only the
      // Hub's own tools is a use of those tools, told as one: a read of the conversation when it makes one, else the first tool it calls.
      const called = scriptCalls(inputField(detail?.input, ["code"]));
      if (called.length > 0 && called.every(call => call.server === TABLE_MCP_NAME && (TABLE_TOOLS as readonly string[]).includes(call.tool))) {
        const shown = called.find(call => !(TABLE_PROGRESS_TOOLS as readonly string[]).includes(call.tool) && call.tool !== "hub_delegate" && call.tool !== "hub_delegations" && call.tool !== "hub_remember" && call.tool !== TABLE_TOOL_SEARCH) ?? called[0]!;
        const item: McpToolItem = { ...base(stateOf(tool, ctx, false)), type: "mcp_tool", server: TABLE_MCP_NAME, tool: shown.tool, hub: true as const };
        return done(item);
      }
      const text = commandText(tool, detail, named), { command, raw } = text === "" ? { command: "", raw: undefined } : unwrapShell(text), cwd = locationOf(detail ?? undefined);
      const item: CommandItem = { ...base(stateOf(tool, ctx, true)), type: "command", command: clip(command), ...(raw === undefined ? {} : { raw: clip(raw) }),
        ...(cwd !== null && cwd.startsWith("/") ? { cwd: clip(cwd) } : {}), ...(tool.exitCode === undefined ? {} : { exitCode: tool.exitCode }) };
      return done(item);
    }
    case "read": { const item: FileReadItem = { ...base(stateOf(tool, ctx, false)), type: "file_read", path: readPath(tool, detail, named) }; return done(item); }
    case "change": { const item: FileChangeItem = { ...base(stateOf(tool, ctx, false)), type: "file_change", changes: changesOf(tool, detail, named) }; return done(item); }
    case "search": case "fetch": {
      if (family === "fetch" || rule?.type === "web") {
        const action = rule?.type === "web" ? rule.action ?? "fetch" : "fetch", terms = webTerms(tool, detail, named, action);
        const item: WebItem = { ...base(stateOf(tool, ctx, false)), type: "web", action, ...terms }; return done(item);
      }
      const terms = searchTerms(tool, detail, named);
      const item: SearchItem = { ...base(stateOf(tool, ctx, false)), type: "search", scope: rule?.scope ?? "unknown", query: terms.query, ...(terms.path === undefined ? {} : { path: terms.path }) };
      return done(item);
    }
    case "mcp": {
      const parts = mcpParts(named?.raw ?? tool.title);
      if (parts === null || parts.server === "" || parts.tool === "") return asTool();
      const item: McpToolItem = { ...base(stateOf(tool, ctx, false)), type: "mcp_tool", server: clip(parts.server), tool: clip(parts.tool), ...(parts.server === TABLE_MCP_NAME ? { hub: true as const } : {}) };
      return done(item);
    }
    case "subagent": { const item: SubagentItem = { ...base(stateOf(tool, ctx, false)), type: "subagent", title: subagentTitle(tool, named) }; return done(item); }
    default: return asTool();
  }
}
