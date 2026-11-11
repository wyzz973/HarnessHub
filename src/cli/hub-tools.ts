import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  TABLE_ENV, TABLE_LIMITS, TABLE_MCP_NAME, TABLE_NOT_IN_SESSION, TABLE_PARTS, TABLE_TOOLS,
  type TableSearchHit, type TableSearchView, type TableTool, type TableTurnRead, type TableTurnsView,
} from "../contracts/table.js";

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
 * sentence. This file imports nothing of the Gateway but the contract, to start fast and to stay a program of its own.
 */

const SERVER_VERSION = "1";
/** The protocol versions this server speaks, newest first; the tools it offers are the same in all of them. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const REQUEST_MS = 30_000, MAX_REPLY_BYTES = 8 * 1024 * 1024;
const INSTRUCTIONS = "HarnessHub keeps the whole history of this conversation. A handoff note you were given is a summary: when it says something was left out, "
  + "or when you need what the user or an earlier Harness said or did, read it back with hub_turns, hub_read_turn and hub_search.";

// ---------------------------------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------------------------------

interface ToolDefinition {
  readonly name: TableTool; readonly title: string; readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly properties: Readonly<Record<string, unknown>>; readonly required?: readonly string[]; readonly additionalProperties: false };
  readonly annotations: { readonly title: string; readonly readOnlyHint: true; readonly destructiveHint: false; readonly idempotentHint: true; readonly openWorldHint: false };
}
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const whole = (description: string, minimum: number, maximum?: number) => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }), description });
const TOOLS: readonly ToolDefinition[] = [
  { name: "hub_turns", title: "List the turns of this conversation",
    description: "List the turns of this HarnessHub conversation, oldest first, one entry each: its number, which Harness (and model) ran it, how it ended, the user's words and the reply shortened, "
      + "and the counts of its tool calls and changed files. Use it to see what happened earlier: when a handoff note says something was left out, or the user refers to work you did not see. "
      + "Turn numbers are the same as in handoff notes; the last turn may be the one you are running now. Shows the latest " + TABLE_LIMITS.turnsDefault + " turns; page with `from` and `limit`.",
    inputSchema: { type: "object", properties: {
      from: whole("The number of the first turn to list. Default: the window ends at the latest turn.", 1),
      limit: whole("How many turns to list (default " + TABLE_LIMITS.turnsDefault + ").", 1, TABLE_LIMITS.turnsMax) }, additionalProperties: false },
    annotations: { title: "List the turns of this conversation", ...READ_ONLY } },
  { name: "hub_read_turn", title: "Read one turn of this conversation",
    description: "Read one turn of this HarnessHub conversation. By default you get an overview: the user's words, the reply, the numbered tool calls, the files changed and the plan, each cut at a sensible "
      + "length with a pointer to the rest. `part` reads one piece in full: user, reply, tools, files or plan; or, for one tool call (its number from the tools list, as `tool`), its input, complete output or diff. "
      + "Use it when a handoff note says content was left out (for example a command's full output from an earlier turn), or when you need exactly what was said or done before. "
      + "Long content comes in pages: the result says how much is left and how to fetch the next page with `offset`. Secrets are hidden; the turn's reasoning is not kept.",
    inputSchema: { type: "object", properties: {
      n: whole("The turn's number, as in hub_turns and in handoff notes.", 1),
      part: { type: "string", enum: [...TABLE_PARTS], description: "What to read: overview (the default), user, reply, tools, files, plan; or input, output, diff of one tool call, which need `tool`." },
      tool: whole("The tool call's number in the turn's tool list (part tools, or the overview). Needed for input, output and diff.", 1),
      offset: whole("Where the page starts, in characters of that part; the previous page's result says where the next one starts.", 0),
      limit: whole("How many characters one page holds (default " + TABLE_LIMITS.pageDefault + ").", 1, TABLE_LIMITS.pageMax) }, required: ["n"], additionalProperties: false },
    annotations: { title: "Read one turn of this conversation", ...READ_ONLY } },
  { name: "hub_search", title: "Search this conversation",
    description: "Search this whole HarnessHub conversation (the user's words, replies, tool calls and their inputs, outputs and diffs) for a word or phrase, ignoring case. "
      + "Returns the places that match, newest turn first, each with its turn number, where it was found and an excerpt; read one in full with hub_read_turn. "
      + "Use it to find where something was said, decided, run or changed.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: TABLE_LIMITS.queryMax, description: "The word or phrase to look for." },
      limit: whole("How many places to return (default " + TABLE_LIMITS.searchDefault + ").", 1, TABLE_LIMITS.searchMax) }, required: ["query"], additionalProperties: false },
    annotations: { title: "Search this conversation", ...READ_ONLY } },
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
function renderSearch(view: TableSearchView, surface: Surface): string {
  const out: string[] = [];
  if (view.total === 0) out.push("Nothing in this conversation matches \"" + view.query + "\" (" + count(view.turns, "turn") + " searched).");
  else out.push(count(view.total, "place") + " in this conversation match \"" + view.query + "\"" + (view.hits.length < view.total ? "; the first " + view.hits.length + ", newest turn first:" : ", newest turn first:"));
  for (const hit of view.hits) {
    out.push("#" + hit.n + " · " + WHERE[hit.where](hit) + (hit.matches > 1 ? " (" + hit.matches + " matches)" : ""));
    out.push("  " + hit.snippet);
    const part = hit.where === "tool" ? "tools" : hit.where;
    out.push("  read: " + nextRead(surface, { n: hit.n, part, ...(hit.tool === undefined || hit.where === "tool" ? {} : { tool: hit.tool }), ...(hit.where === "tool" ? {} : { offset: Math.max(0, hit.at - 200) }) }));
  }
  if (view.hits.length < view.total) out.push("There are more places than were returned: use more specific words, or a larger limit.");
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
/** Runs one tool. Never throws: what goes wrong is a result with isError. */
export async function callTool(name: string, args: Readonly<Record<string, unknown>>, surface: Surface, env: Readonly<Record<string, string | undefined>>): Promise<ToolResult> {
  const connection = connect(env);
  if (connection.kind === "none") return { text: TABLE_NOT_IN_SESSION, isError: true };
  if (connection.kind === "refused") return { text: connection.message + ".", isError: true };
  try {
    switch (name) {
      case "hub_turns": {
        const from = wholeArgument(args, "from", 1), limit = wholeArgument(args, "limit", 1, TABLE_LIMITS.turnsMax);
        const view = await ask(connection, "/api/table/turns", { from, limit });
        return { text: renderTurns(view as unknown as TableTurnsView, surface), isError: false };
      }
      case "hub_read_turn": {
        const n = wholeArgument(args, "n", 1);
        if (n === undefined) throw new ToolError("n is required: the number of the turn to read (see hub_turns).");
        const part = args.part === undefined || args.part === null ? undefined : args.part;
        if (part !== undefined && (typeof part !== "string" || !(TABLE_PARTS as readonly string[]).includes(part))) throw new ToolError("part must be one of " + TABLE_PARTS.join(", ") + ".");
        const view = await ask(connection, "/api/table/turns/" + n, { part, tool: wholeArgument(args, "tool", 1), offset: wholeArgument(args, "offset", 0), limit: wholeArgument(args, "limit", 1, TABLE_LIMITS.pageMax) });
        return { text: renderTurn(view as unknown as TableTurnRead, surface), isError: false };
      }
      case "hub_search": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (query === "" || query.length > TABLE_LIMITS.queryMax) throw new ToolError("query must be the word or phrase to look for, 1 to " + TABLE_LIMITS.queryMax + " characters.");
        const view = await ask(connection, "/api/table/search", { q: query, limit: wholeArgument(args, "limit", 1, TABLE_LIMITS.searchMax) });
        return { text: renderSearch(view as unknown as TableSearchView, surface), isError: false };
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

/** One JSON-RPC message: its response, or null when it needs none (a notification, or a response to us). */
async function answer(message: unknown, env: ToolIo["env"]): Promise<object | null> {
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
      return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: TABLE_MCP_NAME, title: "HarnessHub", version: SERVER_VERSION }, instructions: INSTRUCTIONS });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !(TABLE_TOOLS as readonly string[]).includes(name)) return failure(id, -32602, "Unknown tool: " + (typeof name === "string" ? name.slice(0, 64) : "(no name)"));
      const args = params.arguments === undefined ? {} : record(params.arguments);
      if (args === null) return failure(id, -32602, "arguments must be an object");
      const result = await callTool(name, args, "mcp", env);
      return ok(id, { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
    }
    default: return failure(id, -32601, "Method not found: " + method);
  }
}
/** A line of input: one message, or a batch of them; the text to write back, or null. */
async function handleLine(line: string, env: ToolIo["env"]): Promise<string | null> {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return JSON.stringify(failure(null, -32700, "Parse error")); }
  if (Array.isArray(message)) {
    if (message.length === 0) return JSON.stringify(failure(null, -32600, "Invalid Request"));
    const replies = (await Promise.all(message.map(item => answer(item, env)))).filter((item): item is object => item !== null);
    return replies.length ? JSON.stringify(replies) : null;
  }
  const reply = await answer(message, env);
  return reply === null ? null : JSON.stringify(reply);
}
/** Serves MCP on stdin and stdout until stdin ends; the calls still running then are answered first. */
async function serve(io: ToolIo): Promise<number> {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  lines.on("line", line => {
    if (line.trim() === "") return;
    const task: Promise<void> = handleLine(line, io.env).then(text => { if (text !== null) io.stdout.write(text + "\n"); }, () => {}).then(() => { pending.delete(task); });
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
  "  hub-tools search <words> [--limit N]             find words in the whole conversation",
  "  hub-tools mcp                                    serve these three tools as an MCP server on stdio",
  "",
  "It reads " + TABLE_ENV.url + " and " + TABLE_ENV.session + " from the environment; HarnessHub sets them for the programs it starts.",
].join("\n");

/** A command line that cannot be run: what is wrong, and how to write it, on stderr; the exit code is 2. */
function misuse(io: ToolIo, problem: string): number { io.stderr.write((problem === "" ? "" : problem + "\n") + USAGE + "\n"); return 2; }

export async function main(args: readonly string[], io: ToolIo = { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help") { io.stdout.write(USAGE + "\n"); return 0; }
  if (command === "mcp") return serve(io);
  if (command !== "turns" && command !== "turn" && command !== "search") return misuse(io, command === undefined ? "" : "Unknown command: " + command);
  let values: Record<string, string | undefined>, positionals: string[];
  try {
    const parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { from: { type: "string" }, limit: { type: "string" }, part: { type: "string" }, tool: { type: "string" }, offset: { type: "string" } } });
    values = parsed.values; positionals = parsed.positionals;
  } catch (error) { return misuse(io, error instanceof Error ? error.message : "bad arguments"); }
  const only = (names: readonly string[]) => Object.fromEntries(names.flatMap(name => values[name] === undefined ? [] : [[name, values[name]]]));
  let tool: TableTool, input: Record<string, unknown>;
  if (command === "turns") {
    if (positionals.length) return misuse(io, "turns takes no arguments but --from and --limit.");
    tool = "hub_turns"; input = only(["from", "limit"]);
  } else if (command === "turn") {
    if (positionals.length !== 1) return misuse(io, "turn takes the turn's number: hub-tools turn <n>.");
    tool = "hub_read_turn"; input = { n: positionals[0], ...only(["part", "tool", "offset", "limit"]) };
  } else {
    if (!positionals.length) return misuse(io, "search takes the words to look for: hub-tools search <words>.");
    tool = "hub_search"; input = { query: positionals.join(" "), ...only(["limit"]) };
  }
  const result = await callTool(tool, input, "cli", io.env);
  (result.isError ? io.stderr : io.stdout).write(result.text + "\n");
  return result.isError ? 1 : 0;
}
/** Whether this file is the program being run, also when it was started through a link: a Harness may be given the path of one. */
function started(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(resolve(entry)).href) return true;
  try { return realpathSync(entry) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (started()) {
  // A reader that goes away (the Harness closing its pipe) is the end of the conversation, not a crash.
  process.stdout.on("error", () => {});
  process.exitCode = await main(process.argv.slice(2));
}
