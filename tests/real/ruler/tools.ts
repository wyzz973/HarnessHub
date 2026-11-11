import { TABLE_MCP_NAME, TABLE_TOOLS, type TableTool } from "../../../src/contracts/table.js";

/*
 * What a Turn did with the repo, counted from its tool calls (relay-task.real.ts): how many tools it ran, of which kinds, which
 * files it read and edited, how often it ran the tests, and how much it explored before its first edit. This is the "cost of
 * the bridge" a Harness pays in the step after a hand-over: a Harness that was told what the last one found goes straight to
 * the file, one that was not reads and searches first.
 *
 * The counts come from what the Drivers report. Claude Code names its tools (Read, Edit, Bash, Grep...) and gives the paths they
 * touch; Codex reads and searches through shell commands (`sed -n`, `cat`, `rg`), so for it a read is recognised from the command
 * text, against the files the repo is known to hold. Those counts are approximate; the totals are not.
 */

/** One tool call of a Turn, with the detail the Runtime stored for it when it stored one. */
export interface ToolRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly kind?: string;
  readonly name?: string;
  readonly input?: string;
  readonly output?: string;
  readonly diff?: string;
  readonly locations?: readonly string[];
  readonly exitCode?: number;
}
export type ToolClass = "read" | "search" | "edit" | "run" | "other";
export interface ToolFacts {
  readonly cls: ToolClass;
  /** The repo files it read (class read) or changed (class edit), by repo-relative path. */
  readonly files: readonly string[];
  /** It ran the repo's tests. */
  readonly test: boolean;
}
export interface ToolSummary {
  readonly total: number;
  readonly byClass: Readonly<Record<ToolClass, number>>;
  readonly testRuns: number;
  /** The tools that are not edits, before the first edit (all of them when nothing was edited). */
  readonly explore: number;
  readonly filesRead: readonly string[];
  readonly filesEdited: readonly string[];
  /** Files read in this step that an earlier step of the conversation had read or edited. */
  readonly reread: readonly string[];
}

/** Where a command word may start: the beginning, after a space, a separator, a bracket or a quote (`zsh -lc "node --test"`). */
const START = String.raw`(?:^|[\s;&|('"\x60])`;
const TEST_COMMAND = new RegExp(START + String.raw`(?:node\s[^;&|]*--test\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b)`, "u");
/** Commands that change files: in-place edits, copies, moves, removals, patches, and a redirect of output into a file. */
const MUTATING = new RegExp(START + String.raw`(?:sed\s+(?:-[A-Za-z]*i\b|--in-place)|perl\s+-[A-Za-z]*i\b|tee\b|git\s+apply\b|patch\b|mv\b|cp\b|rm\b|touch\b|truncate\b)|(?<![0-9&<>=-])>>?\s*(?!&|/dev/null)[^\s&|;>]+`, "u");
const READING = new RegExp(START + String.raw`(?:cat|head|tail|sed|nl|bat|less|more|awk|wc|od|xxd|strings|git\s+(?:diff|show|log|status|blame))\b`, "u");
const SEARCHING = new RegExp(START + String.raw`(?:ls|find|tree|fd|rg|grep|ag|pwd|stat|du|git\s+ls-files)\b`, "u");

/** A path as repo-relative when it lies in the workspace (in either spelling of macOS's /private), null when it lies elsewhere. */
export function insideWorkspace(path: string, workspace: string): string | null {
  const roots = [workspace, workspace.startsWith("/private/") ? workspace.slice("/private".length) : "/private" + workspace];
  for (const root of roots) {
    if (path.startsWith(root + "/")) return path.slice(root.length + 1);
  }
  return path.startsWith("/") ? null : path.replace(/^\.\//u, "");
}
/** A location as the Drivers write it: a path, with ":line" after it when there is one. */
function pathOf(location: string): string { return location.replace(/:\d+$/u, ""); }
/** The workspace's path written out of a command, so the repo-relative names are what is left (cat /ws/src/a.js -> cat src/a.js). */
function relativeCommand(command: string, workspace: string): string {
  let text = command;
  for (const root of [workspace, workspace.startsWith("/private/") ? workspace.slice("/private".length) : "/private" + workspace]) text = text.split(root + "/").join("");
  return text.replace(/(^|[\s'"=(:])\.\//gu, "$1");
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** The known repo files a command line names, plainly or through a `*` glob. */
export function filesNamed(command: string, workspace: string, known: readonly string[]): readonly string[] {
  const text = relativeCommand(command, workspace), found = new Set<string>();
  for (const file of known) if (new RegExp("(?<![\\w./-])" + escape(file) + "(?![\\w-]|\\.\\w)", "u").test(text)) found.add(file);
  for (const token of text.split(/[\s'"`;&|()<>]+/u)) {
    if (!token.includes("*")) continue;
    const pattern = new RegExp("^" + token.split("**").map(part => part.split("*").map(escape).join("[^/]*")).join(".*") + "$", "u");
    for (const file of known) if (pattern.test(file)) found.add(file);
  }
  return [...found].sort();
}
/** The paths a Driver gave for a tool: its locations, else the file in its JSON input, else the files its diff names. */
function pathsOf(tool: ToolRecord, workspace: string): readonly string[] {
  const raw = [...(tool.locations ?? []).map(pathOf)];
  if (raw.length === 0 && tool.input !== undefined) {
    try {
      const parsed = JSON.parse(tool.input) as Record<string, unknown>;
      for (const key of ["file_path", "path", "filePath", "notebook_path"]) if (typeof parsed[key] === "string") raw.push(parsed[key] as string);
    } catch { /* the input is a command or plain text */ }
  }
  if (raw.length === 0 && tool.diff !== undefined) for (const found of tool.diff.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gmu)) raw.push(found[1]!);
  return [...new Set(raw.flatMap(path => { const inside = insideWorkspace(path, workspace); return inside === null ? [] : [inside]; }))].sort();
}
/** What one tool call was. `known` lists the repo's files, which the shell commands of Harnesses that read through the shell are matched against. */
export function classifyTool(tool: ToolRecord, workspace: string, known: readonly string[]): ToolFacts {
  const name = tool.name ?? "", kind = tool.kind ?? "";
  if (kind === "read" || name === "Read") return { cls: "read", files: pathsOf(tool, workspace), test: false };
  if (kind === "edit" || kind === "delete" || kind === "move" || /^(?:Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/u.test(name)) return { cls: "edit", files: pathsOf(tool, workspace), test: false };
  if (/^(?:Grep|Glob|LS)$/u.test(name) || kind === "search" && name !== "web_search") return { cls: "search", files: [], test: false };
  if (kind === "execute" || /^(?:Bash|bash|shell)$/u.test(name)) {
    const command = tool.input ?? tool.title;
    if (TEST_COMMAND.test(command)) return { cls: "run", files: [], test: true };
    if (MUTATING.test(command)) return { cls: "edit", files: filesNamed(command, workspace, known), test: false };
    if (READING.test(command)) return { cls: "read", files: filesNamed(command, workspace, known), test: false };
    if (SEARCHING.test(command)) return { cls: "search", files: [], test: false };
    return { cls: "run", files: [], test: false };
  }
  return { cls: "other", files: [], test: false };
}
/** The counts of one step's tool calls, in the order they happened; `earlier` holds the files the conversation's earlier steps read or edited. */
export function summarizeTools(facts: readonly ToolFacts[], earlier: ReadonlySet<string> = new Set()): ToolSummary {
  const byClass: Record<ToolClass, number> = { read: 0, search: 0, edit: 0, run: 0, other: 0 };
  for (const fact of facts) byClass[fact.cls]++;
  const firstEdit = facts.findIndex(fact => fact.cls === "edit");
  const unique = (cls: ToolClass): string[] => [...new Set(facts.filter(fact => fact.cls === cls).flatMap(fact => fact.files))].sort();
  const filesRead = unique("read");
  return { total: facts.length, byClass, testRuns: facts.filter(fact => fact.test).length,
    explore: (firstEdit < 0 ? facts : facts.slice(0, firstEdit)).filter(fact => fact.cls !== "edit").length,
    filesRead, filesEdited: unique("edit"), reread: filesRead.filter(file => earlier.has(file)) };
}

/** Which of the Hub's tools (hub_turns, hub_read_turn, hub_search) a tool call was, or null when it was none of them. */
export function hubToolOf(tool: Pick<ToolRecord, "name" | "title" | "kind">): TableTool | null {
  // Each Harness spells an MCP tool its own way (`mcp__harnesshub__hub_read_turn`, `harnesshub/hub_read_turn`, `harnesshub_hub_read_turn`): by what its name holds.
  // A title counts only when it also names the server (a search for the word `hub_turns` is not a call of the tool, nor is a command that holds it).
  const named = TABLE_TOOLS.find(name => (tool.name ?? "").includes(name));
  if (named !== undefined) return named;
  const shell = tool.kind === "execute" || /^(?:Bash|bash|shell)$/u.test(tool.name ?? "");
  return shell || !tool.title.includes(TABLE_MCP_NAME) ? null : TABLE_TOOLS.find(name => tool.title.includes(name)) ?? null;
}
/** The Hub's tools a Turn called, in the order it called them: how many calls, and which tool each was. */
export function hubCalls(tools: readonly Pick<ToolRecord, "name" | "title" | "kind">[]): { readonly calls: number; readonly called: readonly TableTool[] } {
  const called = tools.flatMap(tool => { const name = hubToolOf(tool); return name === null ? [] : [name]; });
  return { calls: called.length, called };
}
