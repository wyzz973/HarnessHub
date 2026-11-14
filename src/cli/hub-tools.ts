import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { parseArgs } from "node:util";
import {
  TABLE_ENV, TABLE_INSTRUCTIONS_ENV, TABLE_LIMITS, TABLE_LOAD_ENV, TABLE_MCP_NAME, TABLE_NOT_IN_SESSION, TABLE_PARTS, TABLE_PROGRESS_ENV, TABLE_PROGRESS_TOOLS, TABLE_RECORD_ENV,
  TABLE_SEARCH_SCOPES, TABLE_TOOL_SEARCH, TABLE_TOOLS, type TableSearchHit, type TableSearchView, type TableTool, type TableTurnRead, type TableTurnsView,
} from "../contracts/table.js";
import { isMainModule } from "./main-module.js";

/**
 * The Hub's tools for a Harness running inside a conversation the Hub started (docs/decisions/LOG.md, 2026-11-11): it reads back
 * what the Hub holds of that conversation — a directory of the turns, one turn in full and in pieces, a search. One program, two
 * ways to use it, both answering in plain text for a model to read:
 *
 *   hub-tools mcp                       an MCP server on stdio (JSON-RPC written by hand: initialize, ping, tools/list, tools/call)
 *   hub-tools turns | turn <n> | search <words>   the same three tools from a command line
 *
 * Both read HARNESSHUB_URL and HARNESSHUB_SESSION (src/contracts/table.ts) and ask the Hub's /api/table routes with the second as a
 * bearer token. Without them this is no Hub conversation and there is nothing to read: the MCP server still answers initialize and
 * tools/list, and every call, like every command, answers TABLE_NOT_IN_SESSION. When the Hub cannot be reached it says so in a
 * sentence. This file imports nothing of the Gateway but the contract and the main-module check, to start fast and to stay a program of its own.
 * Where the session loads tools on demand (TABLE_LOAD_ENV), the server lists the core ones and hub_tool_search, and lists more as that finds them.
 */

const SERVER_VERSION = "1";
/** The protocol versions this server speaks, newest first; the tools it offers are the same in all of them. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const REQUEST_MS = 30_000, MAX_REPLY_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// What this session is offered
// ---------------------------------------------------------------------------------------------------------------------

/** The tools that only read the record: a session that reads it as files (TABLE_RECORD_ENV) is not offered them. */
const READING_TOOLS: readonly string[] = ["hub_turns", "hub_read_turn", "hub_search", "hub_task", "hub_board"];
const PROGRESS_TOOLS: readonly string[] = TABLE_PROGRESS_TOOLS;
type Env = Readonly<Record<string, string | undefined>>;
const recordFiles = (env: Env): boolean => env[TABLE_RECORD_ENV] === "files";
const searching = (env: Env): boolean => env[TABLE_LOAD_ENV] === "search";
const progressOn = (env: Env): boolean => env[TABLE_PROGRESS_ENV] !== "off";
/** Every tool this session may use but hub_tool_search: the reading tools unless the record is files, the task list and the wrap-up unless they are off. */
function usable(env: Env): readonly ToolDefinition[] {
  return TOOLS.filter(tool => !(recordFiles(env) && READING_TOOLS.includes(tool.name)) && !(!progressOn(env) && PROGRESS_TOOLS.includes(tool.name)));
}
/**
 * The tools this server lists to its session. Where the session loads them on demand (TABLE_LOAD_ENV `search`, T3 Code's McpToolExposure), only the core
 * tools (the task list and the wrap-up, when this session is asked for them), what hub_tool_search loaded (`loaded`), and hub_tool_search itself.
 */
export function offeredTools(env: Env, loaded: ReadonlySet<string> = new Set()): readonly ToolDefinition[] {
  const tools = usable(env);
  if (!searching(env)) return tools;
  return [...tools.filter(tool => PROGRESS_TOOLS.includes(tool.name) || loaded.has(tool.name)), searchTool(tools)];
}
/** What hub_tool_search can find, by purpose: said in its description, for the tools this session may load. */
const PURPOSES: readonly (readonly [string, readonly string[]])[] = [
  ["reading earlier turns", ["hub_turns", "hub_read_turn"]], ["searching this conversation", ["hub_search"]],
  ["the task and its board", ["hub_task", "hub_board", "hub_remember"]], ["delegating to another Harness", ["hub_delegate", "hub_delegations"]],
];
function searchTool(tools: readonly ToolDefinition[]): ToolDefinition {
  const names = new Set<string>(tools.map(tool => tool.name));
  const found = PURPOSES.flatMap(([purpose, members]) => { const here = members.filter(name => names.has(name)); return here.length ? [purpose + " (" + here.join(", ") + ")"] : []; });
  return { name: TABLE_TOOL_SEARCH, title: "Load HarnessHub tools",
    description: "Load HarnessHub tools you do not have yet, then call them by name. Search by name or purpose: " + found.join(", ") + ".",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500, description: "Tool names or what you need." } }, required: ["query"], additionalProperties: false },
    annotations: { title: "Load HarnessHub tools", ...READ_ONLY } };
}
/** Words a tool is found by beyond its name and description, for a search in Chinese. */
const FOUND_BY: Readonly<Partial<Record<TableTool, readonly string[]>>> = {
  hub_turns: ["轮次", "之前", "历史", "列出"], hub_read_turn: ["某一轮", "全文", "输出", "读"], hub_search: ["搜索", "查找", "找"],
  hub_task: ["任务", "全貌", "对话", "改了"], hub_board: ["任务板", "约束", "决定", "目标"], hub_remember: ["记住", "记下", "任务板", "约束"],
  hub_delegate: ["委派", "交给", "另一个"], hub_delegations: ["委派", "交出去", "进展", "结果"],
};
/** Words that name no tool in particular. */
const NOISE: ReadonlySet<string> = new Set(["hub", "harnesshub", "tool", "tools", "mcp", "the", "a", "of", "to", "and", "load"]);
/**
 * The tools a query finds among those this session may load (T3 Code's tool_search): scored by name and description, a Chinese word by the words above; the best and
 * those at least half as good, at most ten. A query that finds none finds them all: there are few, and the model asked for one of them.
 */
export function searchTools(env: Env, query: string): readonly ToolDefinition[] {
  const loadable = usable(env).filter(tool => !PROGRESS_TOOLS.includes(tool.name)), text = query.toLowerCase();
  const terms = text.split(/[^a-z0-9_]+/u).filter(term => term !== "" && !NOISE.has(term)), runs = text.match(/[㐀-鿿]+/gu) ?? [];
  const scored = loadable.map(tool => {
    let score = 0;
    for (const term of terms) score += term === tool.name ? 100 : tool.name.includes(term) ? 3 : tool.description.toLowerCase().includes(term) ? 1 : 0;
    for (const run of runs) for (const word of FOUND_BY[tool.name] ?? []) if (run.includes(word)) score += 2;
    return { tool, score };
  }).filter(match => match.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return best === 0 ? loadable : scored.filter(match => match.score * 2 >= best).slice(0, 10).map(match => match.tool);
}
/**
 * What the server's `initialize` says of its tools, for every Harness that reads MCP instructions. How to use the task list and the wrap-up is the Hub's session
 * instructions, which reach the model through the Harness's own entry (its system prompt, its developer instructions); only a session whose Harness has none is
 * given them here (TABLE_INSTRUCTIONS_ENV), so that they are never said twice. Every request of the session pays for these words.
 */
export function serverInstructions(env: Env): string {
  const progress = progressOn(env) ? "hub_update_plan and hub_wrap_up show the user your task list and a wrap-up; they do not replace your reply. " : "";
  const own = recordFiles(env)
    ? "HarnessHub keeps this task's whole record as read-only files (the session instructions name the directory); read them with your own file tools. " + progress
      + "hub_delegate hands a self-contained part to another Harness; hub_delegations says how it stands. hub_remember puts on the task board what the user says must keep holding."
    : "HarnessHub keeps this conversation's whole history; a handoff note is a summary. Read back what the user or an earlier Harness said or did with hub_turns, hub_read_turn and hub_search. " + progress
      + "hub_delegate hands a self-contained part to another Harness; hub_delegations says how it stands. hub_board is what everyone on the task goes by; hub_remember puts on it what the user says must keep holding. "
      + "hub_task shows every conversation of the task; the read tools take one as `conversation`.";
  const loading = searching(env) ? " Load the tools not listed yet with " + TABLE_TOOL_SEARCH + "." : "";
  const session = env[TABLE_INSTRUCTIONS_ENV]?.trim();
  return own + loading + (session ? "\n\n" + session : "");
}

// ---------------------------------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------------------------------

interface ToolDefinition {
  readonly name: TableTool; readonly title: string; readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly properties: Readonly<Record<string, unknown>>; readonly required?: readonly string[]; readonly additionalProperties: false };
  readonly annotations: { readonly title: string; readonly readOnlyHint: boolean; readonly destructiveHint: false; readonly idempotentHint: boolean; readonly openWorldHint: false };
}
/** The two tools that tell the Hub how the turn goes: they change only what the user is shown, and calling one again with the same input changes nothing. */
const PROGRESS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const whole = (description: string, minimum: number, maximum?: number) => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }), description });
/** The argument the three read tools share: another conversation of the task, by its label. Said once and briefly: every session pays for these words. */
const CONVERSATION = { type: "string", pattern: "^c-[0-9a-f]{6}$", description: "Another conversation of this task, by its label from hub_task." } as const;
const TOOLS: readonly ToolDefinition[] = [
  { name: "hub_turns", title: "List the turns of this conversation",
    description: "List this conversation's turns, oldest first: number, Harness (and model), how it ended, the user's words and the reply shortened, how many tool calls and changed files. "
      + "Numbers match handoff notes; the last may be the turn running now. Shows the latest " + TABLE_LIMITS.turnsDefault + "; page with `from` and `limit`.",
    inputSchema: { type: "object", properties: {
      from: whole("The first turn to list. Default: the window ends at the latest.", 1),
      limit: whole("How many (default " + TABLE_LIMITS.turnsDefault + ").", 1, TABLE_LIMITS.turnsMax),
      conversation: CONVERSATION }, additionalProperties: false },
    annotations: { title: "List the turns of this conversation", ...READ_ONLY } },
  { name: "hub_read_turn", title: "Read one turn of this conversation",
    description: "Read one turn. Default: an overview (the user's words, the reply, numbered tool calls, files changed, plan), each cut with a pointer to the rest. "
      + "`part` reads one piece in full: user, reply, tools, files, plan; or one tool call's input, output or diff (`tool`: its number). "
      + "Long parts come in pages; the result gives the next `offset`. Secrets are hidden; reasoning is not kept.",
    inputSchema: { type: "object", properties: {
      n: whole("The turn's number, as in hub_turns and handoff notes.", 1),
      part: { type: "string", enum: [...TABLE_PARTS], description: "overview (default), user, reply, tools, files, plan; input, output and diff need `tool`." },
      tool: whole("A tool call's number in the turn's list, for input, output and diff.", 1),
      offset: whole("Where the page starts, in characters; the page before says.", 0),
      limit: whole("Characters per page (default " + TABLE_LIMITS.pageDefault + ").", 1, TABLE_LIMITS.pageMax),
      conversation: CONVERSATION }, required: ["n"], additionalProperties: false },
    annotations: { title: "Read one turn of this conversation", ...READ_ONLY } },
  { name: "hub_search", title: "Search this conversation",
    description: "Search the whole conversation (the user's words, replies, tool calls with their inputs, outputs and diffs) for a word or phrase, ignoring case. "
      + "Returns the places, newest turn first, each with its turn, where and an excerpt; read one with hub_read_turn. More places: the result gives `after`.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: TABLE_LIMITS.queryMax, description: "The word or phrase." },
      limit: whole("How many places (default " + TABLE_LIMITS.searchDefault + ").", 1, TABLE_LIMITS.searchMax),
      after: { type: "string", pattern: "^(w[0-9]{1,15}\\.[0-9]{1,9}(user|reply)|[0-9]{1,9}\\.[0-9]{1,9})$", description: "The `after` the page before gave." },
      in: { type: "string", enum: [...TABLE_SEARCH_SCOPES], description: "all (default): everything, turn by turn; words: only the user's words and the replies, quick." },
      conversation: CONVERSATION }, required: ["query"], additionalProperties: false },
    annotations: { title: "Search this conversation", ...READ_ONLY } },
  { name: "hub_update_plan", title: "Update the task list",
    description: "Show the user your task list, pinned above their message box; give the whole list each time, it replaces the last. "
      + "For work of three or more steps (or a list the user gave): call it at the start, one step in_progress and the rest pending, then each time a step starts or finishes. "
      + "Keep one step in_progress; add or reword steps as the plan changes. Steps are short imperative phrases. Skip it for a quick question or a one-step change.",
    inputSchema: { type: "object", properties: {
      items: { type: "array", minItems: 1, description: "The whole list, in order.", items: { type: "object", properties: {
        content: { type: "string", minLength: 1, description: "A short imperative phrase." },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"], additionalProperties: false } },
      explanation: { type: "string", description: "Optional: why the plan changed, in a sentence." } }, required: ["items"], additionalProperties: false },
    annotations: { title: "Update the task list", ...PROGRESS } },
  { name: "hub_wrap_up", title: "Wrap up this turn",
    description: "Show the user a short wrap-up above their message box: call it once, last, when your work for this message is done (not on every chat message). "
      + "`recap`: two or three short sentences to the user: what is now true or changed, what is not done or not verified. "
      + "When the next move is the user's decision, add `ask` (one short question) and `actions` (one or two answers as buttons, your recommendation first, one to four words each as the user "
      + "would say them; a button sends its label). In the conversation's first turn only, add `title`: its name in the user's language, about ten characters (eight English words), a name, not a sentence.",
    inputSchema: { type: "object", properties: {
      recap: { type: "string", minLength: 1, description: "Two or three short sentences: what is done, what is not." },
      ask: { type: "string", description: "Optional: the one question for the user." },
      actions: { type: "array", minItems: 1, maxItems: 2, description: "Optional, with ask: one or two answers, recommendation first.", items: { type: "object", properties: {
        label: { type: "string", minLength: 1, description: "As the user would say it, one to four words." } }, required: ["label"], additionalProperties: false } },
      title: { type: "string", minLength: 1, description: "First turn only: the conversation's name." } },
      required: ["recap"], additionalProperties: false },
    annotations: { title: "Wrap up this turn", ...PROGRESS } },
  { name: "hub_delegate", title: "Delegate a part of the work",
    description: "Hand part of this task to another Harness on this computer. It works in a conversation of its own, in the same folder, from this conversation's history up to the previous turn, "
      + "at the same permission level, while you go on. Use it when the user asks for another Harness, or for an independent part (a second opinion, a review, a search, a separate file); "
      + "not for what you can do in a few steps. `task` must stand alone: what to do, where, what to give back, and what it needs from this turn, which it has not seen. "
      + "Returns at once; the outcome comes with the user's next message, or now with hub_delegations and `wait`. The user sees it as a card.",
    inputSchema: { type: "object", properties: {
      harness: { type: "string", minLength: 1, description: "Its id or name, e.g. codex, claude, opencode, hermes; an unknown one is answered with the ids here." },
      task: { type: "string", minLength: 1, description: "Self-contained: what, where, what to report back." } }, required: ["harness", "task"], additionalProperties: false },
    annotations: { title: "Delegate a part of the work", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "hub_delegations", title: "How delegated work stands",
    description: "The work this conversation delegated, oldest first: who has it, the task, whether it still runs, its reply when it ended.",
    inputSchema: { type: "object", properties: { wait: whole("Seconds to wait for what still runs (at most 25; call again if needed).", 0, 25) }, additionalProperties: false },
    annotations: { title: "How delegated work stands", ...READ_ONLY } },
  { name: "hub_task", title: "The whole task: every conversation working on it",
    description: "This conversation's task: where it began and every conversation work was delegated to, each with its label, Harness, what it was asked, whether it runs, its last reply "
      + "and changed files. Use it when handed part of a larger task, before touching a file another Harness may be editing, or for a label to read with `conversation`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "The whole task", ...READ_ONLY } },
  { name: "hub_board", title: "Read the task board",
    description: "The task board: the goal, the user's constraints, decisions and notes, written by the user and every Harness on the task. "
      + "You are given it when it changes; read it when unsure what still holds, before a decision others must live with, or when handed part of the task.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Read the task board", ...READ_ONLY } },
  { name: "hub_remember", title: "Write on the task board",
    description: "Write on the task board, which every Harness on this task is given before it starts. Record only what the user says holds beyond this message: for the whole task or from now on "
      + "(\"from now on…\", \"remember…\"; constraint: \"all new files start with zz_\", \"use pnpm, never npm\"), a choice others must follow (decision), the task's goal when set or changed (goal, "
      + "replaces the old one), a lasting fact others need (note). Not what concerns only this message or turn (how to answer, \"only answer …\", \"don't put … in your reply\"); when unsure, don't. "
      + "A lasting rule beside a one-line request is still recorded. One short sentence per entry, in the user's language. Not for progress. "
      + "`forget` takes off an entry the user withdrew, by its id (in hub_board, or board.md of the record).",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["goal", "constraint", "decision", "note"] },
      text: { type: "string", minLength: 1, description: "One short sentence that stands alone." },
      forget: { type: "string", description: "Instead of kind and text: the id of an entry to take off." } }, additionalProperties: false },
    annotations: { title: "Write on the task board", ...PROGRESS } },
];

// ---------------------------------------------------------------------------------------------------------------------
// Reaching the Hub
// ---------------------------------------------------------------------------------------------------------------------

/** What this program was given about its conversation: where the Hub is and the token that stands for the conversation. */
type Connection = { readonly kind: "none" } | { readonly kind: "refused"; readonly message: string } | { readonly kind: "ready"; readonly origin: string; readonly token: string };
export function connect(env: Readonly<Record<string, string | undefined>>): Connection {
  const url = env[TABLE_ENV.url]?.trim(), token = env[TABLE_ENV.session]?.trim();
  if (!url || !token) return { kind: "none" };
  let origin: URL;
  try { origin = new URL(url); } catch { return { kind: "refused", message: TABLE_ENV.url + " is not an address" }; }
  // The token goes to the address the Hub gave this process and to no other: only this computer.
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    return { kind: "refused", message: TABLE_ENV.url + " must be an http address on this computer (127.0.0.1, localhost or [::1])" };
  return { kind: "ready", origin: origin.origin, token };
}
/** A failure the model should be told in a sentence, without a stack. */
class ToolError extends Error {}

function get(connection: { readonly origin: string; readonly token: string }, path: string, query: Readonly<Record<string, string | number | undefined>>): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((done, fail) => {
    const url = new URL(path, connection.origin);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const call = httpRequest(url, { method: "GET", agent: false, headers: { Authorization: "Bearer " + connection.token, Accept: "application/json" } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_REPLY_BYTES) call.destroy(new Error("reply too large")); else chunks.push(chunk); });
      response.on("end", () => {
        let body: unknown = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON: the status says what it was */ }
        done({ status: response.statusCode ?? 0, body });
      });
      response.on("error", fail);
    });
    call.setTimeout(REQUEST_MS, () => call.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    call.on("error", fail);
    call.end();
  });
}
/** Tells the Hub how the turn goes (the task list, the wrap-up): a POST of JSON to one of its two writing routes. */
function post(connection: { readonly origin: string; readonly token: string }, path: string, value: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((done, fail) => {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const call = httpRequest(new URL(path, connection.origin), { method: "POST", agent: false, headers: { Authorization: "Bearer " + connection.token, Accept: "application/json", "Content-Type": "application/json", "Content-Length": String(payload.length) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.on("end", () => { let body: unknown = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* the status says what it was */ } done({ status: response.statusCode ?? 0, body }); });
      response.on("error", fail);
    });
    call.setTimeout(REQUEST_MS, () => call.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    call.on("error", fail);
    call.end(payload);
  });
}
async function tell(connection: { readonly origin: string; readonly token: string }, path: string, value: unknown): Promise<void> {
  let reply: Awaited<ReturnType<typeof post>>;
  try { reply = await post(connection, path, value); } catch (error) { throw unreachable(connection.origin, error); }
  const body = record(reply.body);
  if (reply.status === 401) throw new ToolError("HarnessHub does not accept this conversation's token (the Hub may have been restarted since this program started, or the turn has ended).");
  if (reply.status !== 200) throw new ToolError(typeof body?.message === "string" ? body.message : "HarnessHub answered with status " + reply.status + ".");
}
function unreachable(origin: string, error: unknown): ToolError {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "ECONNREFUSED") return new ToolError("HarnessHub is not running at " + origin + " (connection refused). It may have been stopped or restarted; this conversation's tools work only while it runs.");
  if (code === "ETIMEDOUT") return new ToolError("HarnessHub at " + origin + " did not answer in time.");
  return new ToolError("Could not reach HarnessHub at " + origin + " (" + (code ?? "network error") + ").");
}
function record(value: unknown): Readonly<Record<string, unknown>> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
/** The Hub's answer to a read, or a ToolError saying in a sentence why there is none. */
async function ask(connection: { readonly origin: string; readonly token: string }, path: string, query: Readonly<Record<string, string | number | undefined>>): Promise<Readonly<Record<string, unknown>>> {
  let reply: Awaited<ReturnType<typeof get>>;
  try { reply = await get(connection, path, query); } catch (error) { throw unreachable(connection.origin, error); }
  const body = record(reply.body);
  if (reply.status === 401) throw new ToolError("HarnessHub does not accept this conversation's token (the Hub may have been restarted since this program started, or the turn has ended). These tools work only inside a conversation the Hub is running.");
  if (reply.status !== 200) throw new ToolError(typeof body?.message === "string" ? body.message : "HarnessHub answered with status " + reply.status + ".");
  if (body === null) throw new ToolError("HarnessHub gave an answer these tools do not understand (a different version of the Hub?).");
  return body;
}

// ---------------------------------------------------------------------------------------------------------------------
// Words for the model
// ---------------------------------------------------------------------------------------------------------------------

/** Where a result sends the model next: the call that reads on, written for the surface in use. */
type Surface = "mcp" | "cli";
interface Next { readonly n: number; readonly part?: string; readonly tool?: number; readonly offset?: number }
function nextRead(surface: Surface, next: Next): string {
  if (surface === "mcp") return "hub_read_turn " + JSON.stringify({ n: next.n, ...(next.part === undefined ? {} : { part: next.part }), ...(next.tool === undefined ? {} : { tool: next.tool }), ...(next.offset === undefined ? {} : { offset: next.offset }) });
  return "hub-tools turn " + next.n + (next.part === undefined ? "" : " --part " + next.part) + (next.tool === undefined ? "" : " --tool " + next.tool) + (next.offset === undefined ? "" : " --offset " + next.offset);
}
function nextTurns(surface: Surface, from: number, limit: number): string {
  return surface === "mcp" ? "hub_turns " + JSON.stringify({ from, limit }) : "hub-tools turns --from " + from + " --limit " + limit;
}
const count = (number: number, one: string, many = one + "s") => number + " " + (number === 1 ? one : many);

function renderTurns(view: TableTurnsView, surface: Surface): string {
  const out: string[] = [];
  if (view.total === 0) out.push("This conversation has no turns yet.");
  else if (view.lines.length === 0) out.push("There are no turns from " + view.from + ": this conversation has " + count(view.total, "turn") + ".");
  else out.push("Turns " + view.from + "-" + view.to + " of " + view.total + "." + (view.active === undefined ? "" : " Turn " + view.active + " is running now."));
  for (const line of view.lines) {
    out.push("#" + line.n + " · " + line.harnessId + (line.model === undefined ? "" : " (" + line.model + ")") + " · " + line.status + " · " + count(line.tools, "tool call") + " · "
      + (line.filesApprox === true ? "at least " : "") + count(line.files, "file") + " changed");
    out.push("  user: " + (line.user === "" ? "(empty)" : line.user));
    out.push("  reply: " + (line.reply === "" ? "(none)" : line.reply));
  }
  const window = view.lines.length;
  if (window > 0 && view.from > 1) out.push("Earlier turns: " + nextTurns(surface, Math.max(1, view.from - window), Math.min(window, view.from - 1)));
  if (window > 0 && view.to < view.total) out.push("Later turns: " + nextTurns(surface, view.to + 1, window));
  if (view.origin !== undefined) out.push("Note: this conversation also began from " + count(view.origin.messages, "earlier message") + " ("
    + (view.origin.kind === "fork" ? "a branch of another conversation" : "a native session continued in HarnessHub") + "); they are not available through these tools.");
  for (const note of view.notes ?? []) out.push("Note: " + note);
  return out.join("\n");
}

function renderTurn(view: TableTurnRead, surface: Surface): string {
  const out: string[] = [];
  if (view.part !== "overview") {
    const which = view.part + (view.tool === undefined ? "" : " of tool " + view.tool);
    out.push("Turn " + view.n + " of " + view.total + " · " + view.harnessId + (view.model === undefined ? "" : " (" + view.model + ")") + " · " + view.status + " — " + which
      + (view.offset === 0 && view.end >= view.size ? " (" + view.size + " characters)" : " (characters " + view.offset + "-" + view.end + " of " + view.size + ")"));
  }
  out.push(view.text === "" ? "(nothing here)" : view.text);
  if (view.end < view.size) out.push("[" + (view.size - view.end) + " more characters. Next page: " + nextRead(surface, { n: view.n, part: view.part, ...(view.tool === undefined ? {} : { tool: view.tool }), offset: view.end }) + "]");
  else if (view.offset >= view.size && view.size > 0) out.push("[The offset is past the end: this part is " + view.size + " characters long.]");
  for (const note of view.notes ?? []) out.push("Note: " + note);
  return out.join("\n");
}

const WHERE: Readonly<Record<TableSearchHit["where"], (hit: TableSearchHit) => string>> = {
  user: () => "the user's words", reply: () => "the reply", tool: hit => "the title of tool call #" + hit.tool,
  input: hit => "the input of tool call #" + hit.tool, output: hit => "the output of tool call #" + hit.tool, diff: hit => "the diff of tool call #" + hit.tool,
};
function nextSearch(surface: Surface, query: string, after: string, limit: number, scope: string | undefined): string {
  return surface === "mcp" ? "hub_search " + JSON.stringify({ query, after, limit, ...(scope === undefined ? {} : { in: scope }) })
    : "hub-tools search " + JSON.stringify(query) + " --after " + after + " --limit " + limit + (scope === undefined ? "" : " --in " + scope);
}
function renderSearch(view: TableSearchView, surface: Surface, asked: { readonly after: boolean }): string {
  const out: string[] = [];
  if (view.total === 0) out.push(asked.after ? "No more places match \"" + view.query + "\" before that point." : "Nothing in this conversation matches \"" + view.query + "\" (" + count(view.turns, "turn") + " searched).");
  else out.push(count(view.total, "place") + " " + (asked.after ? "more " : "in this conversation ") + "match \"" + view.query + "\"" + (view.next === undefined ? ", newest turn first:" : "; newest turn first, and there are more:"));
  for (const hit of view.hits) {
    out.push("#" + hit.n + " · " + WHERE[hit.where](hit) + (hit.matches > 1 ? " (" + hit.matches + " matches)" : ""));
    out.push("  " + hit.snippet);
    const part = hit.where === "tool" ? "tools" : hit.where;
    out.push("  read: " + nextRead(surface, { n: hit.n, part, ...(hit.tool === undefined || hit.where === "tool" ? {} : { tool: hit.tool }), ...(hit.where === "tool" ? {} : { offset: Math.max(0, hit.at - 200) }) }));
  }
  if (view.next !== undefined) out.push("More places match: " + nextSearch(surface, view.query, view.next, Math.max(1, view.hits.length), view.scope));
  if (view.scope === "words") out.push("Note: only the user's words and the replies were searched; the tool calls and what they ran and printed were not.");
  if (view.unsearched > 0) out.push("Note: " + count(view.unsearched, "tool call detail") + " could not be searched (too many to read, unreadable, or withheld because the call touches a credential file).");
  for (const note of view.notes ?? []) out.push("Note: " + note);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Calling a tool
// ---------------------------------------------------------------------------------------------------------------------

export interface ToolResult { readonly text: string; readonly isError: boolean }
/** A whole number argument within its bounds, from a JSON value or a digit string; undefined when absent. */
function wholeArgument(args: Readonly<Record<string, unknown>>, name: string, minimum: number, maximum = 1_000_000_000): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "string" && /^(0|[1-9][0-9]{0,9})$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new ToolError(name + " must be a whole number from " + minimum + " to " + maximum + ".");
  return number;
}
/**
 * The task board as words: each entry with its id, its kind and who wrote it. An entry the user wrote is the user's own; one a Harness wrote is that Harness's reading
 * of the user's words in the turn it names, which hub_read_turn reads (with `conversation` for another conversation of the task).
 */
function renderBoard(view: Readonly<Record<string, unknown>>): string {
  const entries = Array.isArray(view.entries) ? view.entries as readonly Record<string, unknown>[] : [];
  if (entries.length === 0) return "The task board is empty.";
  const source = (entry: Readonly<Record<string, unknown>>): string => {
    if (entry.by === "user") return "by the user";
    const from = record(entry.from), label = typeof from?.sessionId === "string" ? "c-" + from.sessionId.replace(/^session-/u, "").replace(/-/gu, "").slice(0, 6) : null;
    return "by " + String(entry.by) + (label !== null && typeof from?.ordinal === "number" ? ", its reading of the user's words in turn " + (from.ordinal + 1) + " of " + label : "");
  };
  return "Entries by the user are the user's own; an entry by a Harness is that Harness's reading of the user's words in the turn it names: read them there when unsure.\n"
    + entries.map(entry => "[" + String(entry.id) + "] " + String(entry.kind) + ": " + String(entry.text) + " (" + source(entry) + ")").join("\n");
}
/** The label of another conversation of the task, as the reads take it; undefined for this conversation. */
function conversationArgument(args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args.conversation;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^c-[0-9a-f]{6}$/u.test(value)) throw new ToolError("conversation must be a label from hub_task, like c-1a2b3c.");
  return value;
}
/**
 * Calls a tool, and says with its answer what changed in the task meanwhile (2026-11-13): the Hub is asked after every call, the wrap-up's too (2026-11-14: a change
 * heard at the end of a Turn is better than one heard after it). A Hub that has no such answer, or does not answer, leaves the tool's own answer as it is. Never
 * throws: what goes wrong is a result with isError.
 */
export async function callTool(name: string, args: Readonly<Record<string, unknown>>, surface: Surface, env: Readonly<Record<string, string | undefined>>): Promise<ToolResult> {
  const result = await runTool(name, args, surface, env);
  if (result.isError) return result;
  const connection = connect(env);
  if (connection.kind !== "ready") return result;
  try {
    const text = (await ask(connection, "/api/table/signals", {})).text;
    return typeof text === "string" && text.trim() !== "" ? { ...result, text: result.text + "\n\n" + text } : result;
  } catch { return result; }
}
async function runTool(name: string, args: Readonly<Record<string, unknown>>, surface: Surface, env: Readonly<Record<string, string | undefined>>): Promise<ToolResult> {
  const connection = connect(env);
  if (connection.kind === "none") return { text: TABLE_NOT_IN_SESSION, isError: true };
  if (connection.kind === "refused") return { text: connection.message + ".", isError: true };
  try {
    switch (name) {
      case "hub_turns": {
        const from = wholeArgument(args, "from", 1), limit = wholeArgument(args, "limit", 1, TABLE_LIMITS.turnsMax);
        const view = await ask(connection, "/api/table/turns", { from, limit, c: conversationArgument(args) });
        return { text: renderTurns(view as unknown as TableTurnsView, surface), isError: false };
      }
      case "hub_read_turn": {
        const n = wholeArgument(args, "n", 1);
        if (n === undefined) throw new ToolError("n is required: the number of the turn to read (see hub_turns).");
        const part = args.part === undefined || args.part === null ? undefined : args.part;
        if (part !== undefined && (typeof part !== "string" || !(TABLE_PARTS as readonly string[]).includes(part))) throw new ToolError("part must be one of " + TABLE_PARTS.join(", ") + ".");
        const view = await ask(connection, "/api/table/turns/" + n, { part, tool: wholeArgument(args, "tool", 1), offset: wholeArgument(args, "offset", 0), limit: wholeArgument(args, "limit", 1, TABLE_LIMITS.pageMax), c: conversationArgument(args) });
        return { text: renderTurn(view as unknown as TableTurnRead, surface), isError: false };
      }
      case "hub_search": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query === "" || query.length > TABLE_LIMITS.queryMax) throw new ToolError("query must be the word or phrase to look for, 1 to " + TABLE_LIMITS.queryMax + " characters.");
        const after = args.after === undefined || args.after === null ? undefined : args.after;
        if (after !== undefined && (typeof after !== "string" || !/^(w[0-9]{1,15}\.[0-9]{1,9}(user|reply)|[0-9]{1,9}\.[0-9]{1,9})$/u.test(after))) throw new ToolError("after must be the value a previous search gave for its next page.");
        const scope = args.in === undefined || args.in === null ? undefined : args.in;
        if (scope !== undefined && (typeof scope !== "string" || !(TABLE_SEARCH_SCOPES as readonly string[]).includes(scope))) throw new ToolError("in must be one of " + TABLE_SEARCH_SCOPES.join(", ") + ".");
        const view = await ask(connection, "/api/table/search", { q: query, limit: wholeArgument(args, "limit", 1, TABLE_LIMITS.searchMax), after, in: scope, c: conversationArgument(args) });
        return { text: renderSearch(view as unknown as TableSearchView, surface, { after: after !== undefined }), isError: false };
      }
      case "hub_update_plan": {
        const items = Array.isArray(args.items) ? args.items : null;
        if (items === null || items.length === 0) throw new ToolError("items must be the whole task list: [{ content, status }], status one of pending, in_progress, completed.");
        await tell(connection, "/api/table/plan", { items, ...(typeof args.explanation === "string" ? { explanation: args.explanation } : {}) });
        const steps = items as { readonly status?: unknown }[], done = steps.filter(step => step.status === "completed").length;
        return { text: "Task list shown to the user (" + done + " of " + steps.length + " done).", isError: false };
      }
      case "hub_wrap_up": {
        if (typeof args.recap !== "string" || args.recap.trim() === "") throw new ToolError("recap is required: two or three short sentences of what is done and what is not.");
        if (args.title !== undefined && typeof args.title !== "string") throw new ToolError("title must be a text: the conversation's name, given in its first turn only.");
        await tell(connection, "/api/table/wrap-up", { recap: args.recap, ...(typeof args.ask === "string" ? { ask: args.ask } : {}), ...(Array.isArray(args.actions) ? { actions: args.actions } : {}),
          ...(typeof args.title === "string" && args.title.trim() !== "" ? { title: args.title } : {}) });
        return { text: "Wrap-up shown to the user.", isError: false };
      }
      case "hub_task": {
        const view = await ask(connection, "/api/table/task", {});
        const members = Array.isArray(view.members) ? view.members as readonly Record<string, unknown>[] : [], self = typeof view.self === "string" ? view.self : null;
        if (members.length === 0) return { text: "This conversation is the whole task: nothing was delegated from it, and nothing delegated it.", isError: false };
        const line = (row: Readonly<Record<string, unknown>>): string => {
          const status = String(row.status), state = status === "running" ? "running" : status === "completed" ? "done" : status === "empty" ? "not started" : status === "failed" ? "failed" : status === "cancelled" ? "stopped" : "outcome unknown";
          const files = Array.isArray(row.files) && row.files.length ? "\n" + "  ".repeat(Number(row.depth) + 1) + "files changed: " + (row.files as unknown[]).map(String).join(", ") : "";
          const reply = typeof row.reply === "string" && row.reply !== "" ? "\n" + "  ".repeat(Number(row.depth) + 1) + "last reply: " + row.reply : "";
          return "  ".repeat(Number(row.depth)) + "[" + String(row.label) + "]" + (row.label === self ? " (this conversation)" : "") + " " + String(row.harness) + " · " + state + " · " + String(row.turns) + " turn(s)"
            + (row.parent === null ? " · where the task began" : " · delegated by " + String(row.parent) + (row.by === "harness" ? " (its Harness)" : " (the user)"))
            + "\n" + "  ".repeat(Number(row.depth) + 1) + "asked: " + String(row.task) + reply + files;
        };
        const how = surface === "mcp" ? "Read any of them with hub_turns, hub_read_turn or hub_search and conversation: \"<label>\"." : "Read any of them with turns, turn or search and --conversation <label>.";
        return { text: "This task spans " + members.length + " conversation(s):\n" + members.map(line).join("\n") + "\n" + how, isError: false };
      }
      case "hub_board": {
        const view = await ask(connection, "/api/table/board", {});
        return { text: renderBoard(view), isError: false };
      }
      case "hub_remember": {
        const forget = typeof args.forget === "string" && args.forget.trim() !== "" ? args.forget.trim() : undefined;
        if (forget === undefined && (typeof args.kind !== "string" || typeof args.text !== "string" || args.text.trim() === "")) throw new ToolError("give kind (goal, constraint, decision or note) and text, or forget with an entry's id.");
        let reply: Awaited<ReturnType<typeof post>>;
        try { reply = await post(connection, "/api/table/board", forget === undefined ? { kind: args.kind, text: args.text } : { forget }); } catch (error) { throw unreachable(connection.origin, error); }
        const body = record(reply.body);
        if (reply.status === 401) throw new ToolError("HarnessHub does not accept this conversation's token (the Hub may have been restarted since this program started, or the turn has ended).");
        if (reply.status !== 200 || body === null) throw new ToolError(typeof body?.message === "string" ? body.message : "HarnessHub answered with status " + reply.status + ".");
        return { text: (forget === undefined ? "Written on the task board; every Harness on this task is given it. " : "Taken off the task board. ") + "The board now:\n" + renderBoard(body), isError: false };
      }
      case "hub_delegate": {
        if (typeof args.harness !== "string" || args.harness.trim() === "") throw new ToolError("harness is required: the id or name of the Harness to hand the work to.");
        if (typeof args.task !== "string" || args.task.trim() === "") throw new ToolError("task is required: the work to do, self-contained.");
        let reply: Awaited<ReturnType<typeof post>>;
        try { reply = await post(connection, "/api/table/delegate", { harness: args.harness, task: args.task }); } catch (error) { throw unreachable(connection.origin, error); }
        const body = record(reply.body);
        if (reply.status === 401) throw new ToolError("HarnessHub does not accept this conversation's token (the Hub may have been restarted since this program started, or the turn has ended).");
        if (reply.status !== 200 || body === null) throw new ToolError(typeof body?.message === "string" ? body.message : "HarnessHub answered with status " + reply.status + ".");
        return { text: "Delegated to " + String(body.harness) + ". It works in a conversation of its own while you go on; the user sees it as a card here. "
          + "Its outcome reaches you with the user's next message. If you need it in this turn, call hub_delegations with wait.", isError: false };
      }
      case "hub_delegations": {
        const view = await ask(connection, "/api/table/delegations", { wait: wholeArgument(args, "wait", 0, 25) });
        const rows = Array.isArray(view.delegations) ? view.delegations as readonly Record<string, unknown>[] : [];
        if (rows.length === 0) return { text: "This conversation has delegated no work.", isError: false };
        const said = (row: Readonly<Record<string, unknown>>): string => {
          const status = String(row.status), state = status === "running" ? "still running" : status === "completed" ? "done" : status === "failed" ? "failed" : status === "cancelled" ? "stopped" : "outcome unknown";
          const reply = typeof row.reply === "string" && row.reply !== "" ? "\nReply:\n" + row.reply : status === "running" ? "" : "\n(no text reply)";
          return "[" + String(row.harness) + " · " + state + "]\nTask: " + String(row.task) + reply;
        };
        return { text: rows.map(said).join("\n\n"), isError: false };
      }
      default: return { text: "Unknown tool: " + name + ".", isError: true };
    }
  } catch (error) {
    return { text: error instanceof ToolError ? error.message : "The HarnessHub tool failed: " + (error instanceof Error ? error.message.slice(0, 200) : "unknown error"), isError: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// MCP over stdio
// ---------------------------------------------------------------------------------------------------------------------

export interface ToolIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}
const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
/** One server process's session: the tools hub_tool_search loaded, and how to tell the client its list changed. */
interface Exposure { readonly loaded: Set<string>; readonly listChanged: () => void }
/** hub_tool_search: what the query finds, listed to the session from now on (the client is told the list changed when it grew). Calls are never gated by it. */
function loadTools(query: unknown, env: ToolIo["env"], exposure: Exposure): { readonly content: readonly object[]; readonly isError?: true } {
  if (typeof query !== "string" || query.trim() === "") return { content: [{ type: "text", text: "query is required: tool names or what you need." }], isError: true };
  const found = searchTools(env, query.slice(0, 500)), before = exposure.loaded.size;
  for (const tool of found) exposure.loaded.add(tool.name);
  if (exposure.loaded.size > before) exposure.listChanged();
  return { content: [{ type: "text", text: (found.length ? "Loaded; call them by name:\n" + found.map(tool => tool.name + ": " + tool.description).join("\n") : "There is nothing more to load.") }] };
}

/** One JSON-RPC message: its response, or null when it needs none (a notification, or a response to us). */
async function answer(message: unknown, env: ToolIo["env"], exposure: Exposure): Promise<object | null> {
  const body = record(message);
  if (body === null) return failure(null, -32600, "Invalid Request");
  const { id, method } = body;
  const isRequest = typeof method === "string" && id !== undefined && id !== null;
  if (typeof method !== "string") return id !== undefined && id !== null && ("result" in body || "error" in body) ? null : failure(id ?? null, -32600, "Invalid Request");
  if (!isRequest) return null;
  const params = record(body.params) ?? {};
  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const version = typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion: version, capabilities: { tools: env[TABLE_LOAD_ENV] === "search" ? { listChanged: true } : {} }, serverInfo: { name: TABLE_MCP_NAME, title: "HarnessHub", version: SERVER_VERSION }, instructions: serverInstructions(env) });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: offeredTools(env, exposure.loaded) });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !(TABLE_TOOLS as readonly string[]).includes(name)) return failure(id, -32602, "Unknown tool: " + (typeof name === "string" ? name.slice(0, 64) : "(no name)"));
      const args = params.arguments === undefined ? {} : record(params.arguments);
      if (args === null) return failure(id, -32602, "arguments must be an object");
      if (name === TABLE_TOOL_SEARCH) return ok(id, loadTools(args.query, env, exposure));
      const result = await callTool(name, args, "mcp", env);
      return ok(id, { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
    }
    default: return failure(id, -32601, "Method not found: " + method);
  }
}
/** A line of input: one message, or a batch of them; the text to write back, or null. */
async function handleLine(line: string, env: ToolIo["env"], exposure: Exposure): Promise<string | null> {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return JSON.stringify(failure(null, -32700, "Parse error")); }
  if (Array.isArray(message)) {
    if (message.length === 0) return JSON.stringify(failure(null, -32600, "Invalid Request"));
    const replies = (await Promise.all(message.map(item => answer(item, env, exposure)))).filter((item): item is object => item !== null);
    return replies.length ? JSON.stringify(replies) : null;
  }
  const reply = await answer(message, env, exposure);
  return reply === null ? null : JSON.stringify(reply);
}
/** Serves MCP on stdin and stdout until stdin ends; the calls still running then are answered first. */
async function serve(io: ToolIo): Promise<number> {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  // Said before the answer of the call that grew the list, so that the client lists again before the model reads that answer.
  const exposure: Exposure = { loaded: new Set(), listChanged: () => { io.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\n"); } };
  lines.on("line", line => {
    if (line.trim() === "") return;
    const task: Promise<void> = handleLine(line, io.env, exposure).then(text => { if (text !== null) io.stdout.write(text + "\n"); }, () => {}).then(() => { pending.delete(task); });
    pending.add(task);
  });
  await once(lines, "close");
  await Promise.all(pending);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------------------------------

const USAGE = [
  "hub-tools — read back the HarnessHub conversation this program was started in",
  "",
  "  hub-tools turns [--from N] [--limit N]           list the turns, one entry each",
  "  hub-tools turn <n> [--part PART] [--tool K] [--offset N] [--limit N]",
  "                                                   read turn n; PART is one of " + TABLE_PARTS.join(", "),
  "                                                   (input, output and diff need --tool K, a tool call's number in the turn)",
  "  hub-tools search <words> [--limit N] [--after C] [--in all|words]",
  "                                                   find words in the whole conversation, a page at a time (C: the cursor the page before gave); --in words searches only the user's words and the replies, quickly",
  "  hub-tools plan <step>...                         show the user your task list: each step is \"[x] done\", \"[~] in progress\" or \"[ ] to do\"; give the whole list every time",
  "  hub-tools wrap-up <recap> [--ask Q] [--action A]... [--title T]",
  "                                                   show the user a short wrap-up of this turn, with one question and one or two answers when the next move is theirs;",
  "                                                   --title names the conversation (its first turn only: a name of about ten characters, or eight words, in the user's language)",
  "  hub-tools delegate <harness> <task>              hand a self-contained part of the work to another Harness, which does it in a conversation of its own",
  "  hub-tools delegations [--wait N]                 how the work handed over stands; --wait N waits up to N seconds (25 at most) for what still runs",
  "  hub-tools board                                  the task board: the goal, the user's constraints, decisions and notes everyone on the task goes by",
  "  hub-tools remember <kind> <text>                 write on the task board (kind: goal, constraint, decision or note); remember --forget <id> takes an entry off",
  "  hub-tools task                                   the whole task: every conversation working on it, what each was asked, replied and changed",
  "                                                   (turns, turn and search take --conversation <label> to read another conversation of the task)",
  "  hub-tools mcp                                    serve these tools as an MCP server on stdio",
  "",
  "It reads " + TABLE_ENV.url + " and " + TABLE_ENV.session + " from the environment; HarnessHub sets them for the programs it starts.",
].join("\n");

/** A command line that cannot be run: what is wrong, and how to write it, on stderr; the exit code is 2. */
function misuse(io: ToolIo, problem: string): number { io.stderr.write((problem === "" ? "" : problem + "\n") + USAGE + "\n"); return 2; }

export async function main(args: readonly string[], io: ToolIo = { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help") { io.stdout.write(USAGE + "\n"); return 0; }
  if (command === "mcp") return serve(io);
  if (!["turns", "turn", "search", "plan", "wrap-up", "delegate", "delegations", "task", "board", "remember"].includes(command ?? "")) return misuse(io, command === undefined ? "" : "Unknown command: " + command);
  let values: Record<string, string | undefined>, positionals: string[], actions: readonly string[] = [];
  try {
    const parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { from: { type: "string" }, limit: { type: "string" }, part: { type: "string" }, tool: { type: "string" }, offset: { type: "string" }, after: { type: "string" }, in: { type: "string" },
      wait: { type: "string" }, ask: { type: "string" }, explanation: { type: "string" }, conversation: { type: "string" }, forget: { type: "string" }, title: { type: "string" }, action: { type: "string", multiple: true } } });
    const { action, ...single } = parsed.values;
    values = single; positionals = parsed.positionals; actions = action ?? [];
  } catch (error) { return misuse(io, error instanceof Error ? error.message : "bad arguments"); }
  const only = (names: readonly string[]) => Object.fromEntries(names.flatMap(name => values[name] === undefined ? [] : [[name, values[name]]]));
  let tool: TableTool, input: Record<string, unknown>;
  if (command === "turns") {
    if (positionals.length) return misuse(io, "turns takes no arguments but --from and --limit.");
    tool = "hub_turns"; input = only(["from", "limit", "conversation"]);
  } else if (command === "turn") {
    if (positionals.length !== 1) return misuse(io, "turn takes the turn's number: hub-tools turn <n>.");
    tool = "hub_read_turn"; input = { n: positionals[0], ...only(["part", "tool", "offset", "limit", "conversation"]) };
  } else if (command === "search") {
    if (!positionals.length) return misuse(io, "search takes the words to look for: hub-tools search <words>.");
    tool = "hub_search"; input = { query: positionals.join(" "), ...only(["limit", "after", "in", "conversation"]) };
  } else if (command === "plan") {
    if (!positionals.length) return misuse(io, "plan takes the whole task list, a step each: \"[x] done\" \"[~] in progress\" \"[ ] to do\".");
    // A step's mark says its state; a step without one is still to do.
    const items = positionals.map(step => { const marked = /^\s*\[( |x|X|~|>|-)\]\s*(.*)$/su.exec(step), mark = marked?.[1] ?? " ";
      return { content: (marked?.[2] ?? step).trim(), status: mark === "x" || mark === "X" ? "completed" : mark === "~" || mark === ">" ? "in_progress" : "pending" }; });
    if (items.some(item => item.content === "")) return misuse(io, "every step of the plan needs its words.");
    tool = "hub_update_plan"; input = { items, ...only(["explanation"]) };
  } else if (command === "wrap-up") {
    if (!positionals.length) return misuse(io, "wrap-up takes the recap: two or three short sentences of what is done and what is not.");
    tool = "hub_wrap_up"; input = { recap: positionals.join(" "), ...only(["ask", "title"]), ...(actions.length ? { actions: actions.map(label => ({ label })) } : {}) };
  } else if (command === "delegate") {
    if (positionals.length < 2) return misuse(io, "delegate takes the Harness and the task: hub-tools delegate <harness> \"<task>\".");
    tool = "hub_delegate"; input = { harness: positionals[0], task: positionals.slice(1).join(" ") };
  } else if (command === "board") {
    if (positionals.length) return misuse(io, "board takes no arguments.");
    tool = "hub_board"; input = {};
  } else if (command === "remember") {
    if (values.forget !== undefined) { tool = "hub_remember"; input = { forget: values.forget }; }
    else {
      if (positionals.length < 2) return misuse(io, "remember takes the kind and the words: hub-tools remember constraint \"<text>\".");
      tool = "hub_remember"; input = { kind: positionals[0], text: positionals.slice(1).join(" ") };
    }
  } else if (command === "task") {
    if (positionals.length) return misuse(io, "task takes no arguments.");
    tool = "hub_task"; input = {};
  } else {
    if (positionals.length) return misuse(io, "delegations takes no arguments but --wait.");
    tool = "hub_delegations"; input = only(["wait"]);
  }
  const result = await callTool(tool, input, "cli", io.env);
  (result.isError ? io.stderr : io.stdout).write(result.text + "\n");
  return result.isError ? 1 : 0;
}
// This file is the program being run also when it was started through a link: a Harness may be given the path of one.
if (isMainModule(import.meta.url)) {
  // A reader that goes away (the Harness closing its pipe) is the end of the conversation, not a crash.
  process.stdout.on("error", () => {});
  process.exitCode = await main(process.argv.slice(2));
}
