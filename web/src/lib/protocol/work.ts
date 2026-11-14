import { ITEM_STATUS_WORDS } from "../../../../src/contracts/protocol-words.js";
import { WORK_TYPES, type FileOp, type ItemStatus, type ReasoningItem, type WorkItem } from "../../../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../../../src/contracts/protocol-read.js";
import type { PublicMessage } from "../../../../src/contracts/session.js";
import { TABLE_MCP_NAME, TABLE_PROGRESS_TOOLS, hubCommandOnly, inRecord } from "../../../../src/contracts/table.js";

/*
 * What the page says of the actions of a Turn, from the protocol's items alone (docs/proposals/protocol/hub-protocol.html §13): one
 * line for one action in three voices (in progress, done, failed), one line for a run of them, and the order a Turn's items are
 * laid out in. Nothing here knows which Harness did the work or what it called a tool: the Hub's normalization already said what
 * kind of action it was. Plain functions of the items, so every wording can be checked without a page.
 */

export function isWork(item: ReadItem): item is WorkItem { return (WORK_TYPES as readonly string[]).includes(item.type); }
/**
 * Where a window left out the middle of a long stretch of work (a Turn of thousands of actions holds its first and last few): a row of that stretch that says how many items it stands for
 * and reads them when asked. It is made by `assemble` and is no item of the conversation; it counts as no action.
 */
export const GAP_ID = "hh:gap", GAP_TYPE = "gap";
export interface GapRow { readonly id: typeof GAP_ID; readonly seq: number; readonly type: typeof GAP_TYPE; readonly count: number; readonly fromSeq: number; readonly toSeq: number; readonly ordinal: number }
export function gapOf(item: { readonly type: string }): GapRow | undefined { return item.type === GAP_TYPE ? item as unknown as GapRow : undefined; }
export const isGap = (item: { readonly type: string }): boolean => item.type === GAP_TYPE;
/** The turn's states that are over: an action not ended by then will not end. */
const OVER: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "unknown"]);
export function turnOver(turn: Pick<ReadTurn, "status">): boolean { return OVER.has(turn.status); }
const UNENDED: ReadonlySet<ItemStatus> = new Set(["pending", "running", "waiting"]);
/** An action still open when its Turn is over was never reported ended: its outcome is unknown, and never taken for completed. */
export function settled<T extends ReadItem>(item: T, over: boolean): T {
  return over && isWork(item) && UNENDED.has(item.status) ? { ...item, status: "unknown" } as T : item;
}

// ---------------------------------------------------------------------------------------------------------------------
// One action, one line
// ---------------------------------------------------------------------------------------------------------------------

/** The last part of a path: what the line names. The whole path is the line's title. */
export function baseName(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }
/** The first line of a text, cut to `limit` characters, with a mark where more of it was left out. */
export function oneLine(text: string, limit = 160): string {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean), first = [...(lines[0] ?? "")];
  return (first.length > limit ? first.slice(0, limit - 1).join("") + "…" : first.join("")) + (lines.length > 1 && first.length <= limit ? " …" : "");
}
function host(url: string): string { try { return new URL(url).hostname.replace(/^www\./u, ""); } catch { return oneLine(url, 60); } }

/** The four ways a line is worded: in progress, done, failed, and the neutral one of an action that is not under way or done. */
interface Verbs { readonly running: string; readonly completed: string; readonly failed: string; readonly bare: string }
const verbs = (running: string, completed: string, failed: string, bare: string): Verbs => ({ running, completed, failed, bare });
const RUN = verbs("正在运行", "运行了", "运行失败", "运行"), RUN_ONE = verbs("正在运行一条命令", "运行了一条命令", "运行失败", "运行一条命令");
const READ = verbs("正在读取", "读取了", "读取失败", "读取"), READ_ONE = verbs("正在读取一个文件", "读取了一个文件", "读取失败", "读取一个文件");
const CHANGE: Readonly<Record<FileOp, Verbs>> = {
  create: verbs("正在新建", "新建了", "新建失败", "新建"), modify: verbs("正在修改", "修改了", "修改失败", "修改"),
  delete: verbs("正在删除", "删除了", "删除失败", "删除"), rename: verbs("正在重命名", "重命名了", "重命名失败", "重命名"),
};
const CHANGE_ANY = verbs("正在修改文件", "修改了文件", "修改失败", "修改文件");
const SEARCH = verbs("正在搜索", "搜索了", "搜索失败", "搜索");
const SEARCH_ALONE = { files: verbs("正在搜索文件", "搜索了文件", "搜索失败", "搜索文件"), content: verbs("正在搜索代码", "搜索了代码", "搜索失败", "搜索代码"), unknown: verbs("正在搜索", "搜索了一次", "搜索失败", "搜索") } as const;
const WEB_SEARCH = verbs("正在搜索网页", "搜索了网页", "联网失败", "搜索网页");
const WEB_FETCH = verbs("正在读取", "读取了", "联网失败", "读取"), WEB_FETCH_ONE = verbs("正在读取网页", "读取了一个网页", "联网失败", "读取网页");
const USE = verbs("正在使用", "使用了", "工具出错", "使用"), USE_ONE = verbs("正在使用工具", "使用了一个工具", "工具出错", "使用工具");
const HUB = verbs("正在查阅对话记录", "查阅了对话记录", "查阅失败", "查阅对话记录");
const SUBTASK = verbs("正在运行子任务", "运行了子任务", "子任务失败", "运行子任务");

/** What a type of action is worded with, and what it names: `object` is null where it names nothing (then `alone` is the wording). */
interface Spec { readonly verbs: Verbs; readonly alone: Verbs; readonly object: string | null; readonly mono: boolean; readonly title: string; readonly added: number; readonly removed: number; readonly exit?: number }
const quoted = (text: string): string => "“" + text + "”";
function specOf(item: WorkItem): Spec {
  const plain = (words: Verbs, alone: Verbs, object: string | null, title = object ?? "", mono = false): Spec => ({ verbs: words, alone, object, mono, title, added: 0, removed: 0 });
  switch (item.type) {
    case "command": {
      const text = item.command.trim();
      // The Hub's tools as a command of the conversation (a Harness that takes no tool entry runs it): said as the tools are.
      if (hubCommandOnly(text) !== null || inRecord(text)) return plain(HUB, HUB, null, item.command);
      return { ...plain(RUN, RUN_ONE, text ? oneLine(text) : null, item.command, true), ...(item.exitCode === undefined ? {} : { exit: item.exitCode }) };
    }
    // The record's directory, read by a Harness that reads the record as files: the conversation's own record, not a file of the project.
    case "file_read": return item.path && inRecord(item.path) ? plain(HUB, HUB, null, item.path) : plain(READ, READ_ONE, item.path ? baseName(item.path) : null, item.path ?? "", true);
    case "file_change": {
      const changes = item.changes, ops = new Set(changes.map(change => change.op)), op: FileOp = ops.size === 1 ? [...ops][0]! : "modify";
      const added = changes.reduce((sum, change) => sum + (change.added ?? 0), 0), removed = changes.reduce((sum, change) => sum + (change.removed ?? 0), 0);
      if (changes.length === 0) return { ...plain(CHANGE_ANY, CHANGE_ANY, null), added, removed };
      if (changes.length > 1) return { ...plain(CHANGE[op], CHANGE[op], changes.length + " 个文件", changes.map(change => change.path).join("\n")), added, removed };
      const only = changes[0]!, name = only.op === "rename" && only.oldPath ? baseName(only.oldPath) + " → " + baseName(only.path) : baseName(only.path);
      return { ...plain(CHANGE[only.op], CHANGE[only.op], name, only.path, true), added, removed };
    }
    case "search": {
      const query = item.query?.trim();
      return plain(SEARCH, SEARCH_ALONE[item.scope], query ? quoted(oneLine(query, 80)) : null, item.query ?? "");
    }
    case "web": {
      const query = item.query?.trim(), title = item.title?.trim();
      if (item.action === "search") return plain(WEB_SEARCH, WEB_SEARCH, query ? quoted(oneLine(query, 80)) : null, item.query ?? "");
      return plain(WEB_FETCH, WEB_FETCH_ONE, title ? oneLine(title, 80) : item.url ? host(item.url) : null, item.url ?? "");
    }
    // The Hub's own tools are said by what they are for; any other tool by the server and the tool it is.
    case "mcp_tool": return item.hub ? plain(HUB, HUB, null) : plain(USE, USE_ONE, item.server && item.tool ? item.server + "：" + item.tool : item.tool || item.server || null);
    case "tool": return plain(USE, USE_ONE, item.name.trim() ? item.name : null);
    case "subagent": return plain(SUBTASK, SUBTASK, item.title.trim() ? quoted(oneLine(item.title, 80)) : null, item.title);
  }
}

export interface WorkLabel {
  /** The whole line as plain text, for what reads it aloud, a tooltip or a test: "修改了 cart.js +2 −2". */
  readonly text: string;
  /** What is said of the action, before its object: "运行了", "正在读取", "运行失败". */
  readonly verb: string;
  /** What it was about, when it names something; the line is the verb alone otherwise. */
  readonly object: string | null;
  /** Whether the object is a command, a path or a name, which are set in code type. */
  readonly mono: boolean;
  /** Lines added and removed, for an edit that counts them. */
  readonly added?: number; readonly removed?: number;
  /** The exit code of a command, when it was not 0. */
  readonly exit?: number;
  /** The state's own word, for a state the verb does not say: 等待开始, 等你处理, 已拒绝, 已停止, 结果未知. */
  readonly status: string | null;
  /** Everything the object abbreviates, for a tooltip: the whole command, the whole path. */
  readonly title: string;
}
const VOICE: Readonly<Record<ItemStatus, keyof Verbs>> = { pending: "bare", running: "running", waiting: "bare", completed: "completed", failed: "failed", declined: "bare", cancelled: "bare", unknown: "bare" };
const SAID_BY_VERB: ReadonlySet<ItemStatus> = new Set(["running", "completed", "failed"]);
const glue = (object: string): string => object.startsWith("“") ? "" : " ";

/**
 * How one action reads as a line, in the voice of its state: "正在运行 npm test" while it runs, "运行了 npm test" when done,
 * "运行失败 npm test" when it failed. An action that has not started, waits for you, was refused, was stopped or whose outcome is
 * unknown is worded neutrally ("运行 npm test") and says its state beside it in the state's own word, so none of them reads as done.
 * An action that names nothing falls back to a wording of its own ("运行了一条命令").
 */
export function workLabel(item: WorkItem): WorkLabel {
  const spec = specOf(item), voice = VOICE[item.status], verb = (spec.object === null ? spec.alone : spec.verbs)[voice];
  // An action that has not started says so with its mark alone.
  const status = SAID_BY_VERB.has(item.status) || item.status === "pending" ? null : ITEM_STATUS_WORDS[item.status];
  const facts = [spec.added > 0 ? "+" + spec.added : "", spec.removed > 0 ? "−" + spec.removed : "", spec.exit !== undefined && spec.exit !== 0 ? "退出码 " + spec.exit : ""].filter(Boolean);
  const lead = spec.object === null ? verb : verb + glue(spec.object) + spec.object;
  return { text: [lead, ...facts].join(" ") + (status === null ? "" : " · " + status), verb, object: spec.object, mono: spec.mono && spec.object !== null, status, title: spec.title,
    ...(spec.added > 0 ? { added: spec.added } : {}), ...(spec.removed > 0 ? { removed: spec.removed } : {}), ...(spec.exit !== undefined && spec.exit !== 0 ? { exit: spec.exit } : {}) };
}

/** How long a thought took, in the words of the line: "3 秒", "1 分 5 秒", "1 小时 2 分". Never under one second. */
export function thoughtTime(milliseconds: number): string {
  const total = Math.max(1, Math.round(milliseconds / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (hours > 0) return hours + " 小时" + (minutes ? " " + minutes + " 分" : "");
  return minutes > 0 ? minutes + " 分" + (seconds ? " " + seconds + " 秒" : "") : seconds + " 秒";
}
/** The line of a thought: "思考中" while it goes on, "思考了 3 秒" when its time is known, "思考过程" when it is not. */
export function reasoningLabel(item: Pick<ReasoningItem, "status" | "durationMs">, over: boolean): string {
  if (!over && (item.status === "running" || item.status === "pending")) return "思考中";
  return item.durationMs !== undefined && item.status === "completed" ? "思考了 " + thoughtTime(item.durationMs) : "思考过程";
}

// ---------------------------------------------------------------------------------------------------------------------
// A run of actions, one line
// ---------------------------------------------------------------------------------------------------------------------

type Kind = "command" | "change" | "subagent" | "read" | "search" | "web_search" | "web_fetch" | "hub" | "tool";
/** What is said first: what ran, what was changed and what was delegated, then what was looked at, searched, fetched and used. */
const ORDER: readonly Kind[] = ["command", "change", "subagent", "read", "search", "web_search", "web_fetch", "hub", "tool"];
const NOUN: Readonly<Record<Exclude<Kind, "change">, (n: number) => string>> = {
  command: n => `运行了 ${n} 条命令`, subagent: n => `运行了 ${n} 个子任务`, read: n => `读取了 ${n} 个文件`, search: n => `搜索了 ${n} 处`,
  web_search: n => `搜索了 ${n} 次网页`, web_fetch: n => `读取了 ${n} 个网页`, hub: n => `查阅了 ${n} 次对话记录`, tool: n => `使用了 ${n} 个工具`,
};
const CHANGED = (ops: ReadonlySet<FileOp>): FileOp => ops.size === 1 ? [...ops][0]! : "modify";
/** The verbs of what was done to one file, in the order it was done: 读取, 新建, 修改, 删除, 重命名. */
const DONE: readonly (readonly [FileOp | "read", string])[] = [["read", "读取"], ["create", "新建"], ["modify", "修改"], ["delete", "删除"], ["rename", "重命名"]];

interface Targets { readonly keys: Map<string, Set<ItemStatus>> }
interface Problems { failed: number; declined: number; cancelled: number; unknown: number }
const NO_PROBLEMS = (): Problems => ({ failed: 0, declined: 0, cancelled: 0, unknown: 0 });
function problemsOf(targets: readonly Set<ItemStatus>[]): Problems {
  const found = NO_PROBLEMS();
  for (const statuses of targets) for (const kind of ["failed", "declined", "cancelled", "unknown"] as const) if (statuses.has(kind)) found[kind]++;
  return found;
}
/** What did not go well, after the words it belongs to: "（1 个失败）", "（1 个失败，2 个已停止）". */
function annotation(found: Problems): string {
  const parts = [found.failed && `${found.failed} 个${ITEM_STATUS_WORDS.failed}`, found.declined && `${found.declined} 个${ITEM_STATUS_WORDS.declined}`,
    found.cancelled && `${found.cancelled} 个${ITEM_STATUS_WORDS.cancelled}`, found.unknown && `${found.unknown} 个${ITEM_STATUS_WORDS.unknown}`].filter(Boolean);
  return parts.length ? "（" + parts.join("，") + "）" : "";
}

export interface SummaryPart {
  /** One kind of action as counted: "运行了 6 条命令（1 个失败）". */
  readonly text: string;
  /** How many it counts (the number in the words). */
  readonly count: number;
  /** Every one of them failed, which the line sets in the failure's color. */
  readonly failed: boolean;
}
export interface GroupSummary {
  /** The run as one line: "运行了 6 条命令，读取了 7 个文件". */
  readonly text: string;
  readonly parts: readonly SummaryPart[];
  /** How many actions the last words ("还有 N 个动作") fold in; 0 when nothing was folded. */
  readonly folded: number;
  /** How many targets did not go well (failed, refused, stopped, unknown). */
  readonly problems: number;
}

/**
 * One line for a run of actions, as Claude's desktop app writes it: the kinds counted ("运行了 6 条命令，读取了 7 个文件"), what
 * went wrong said after the words it belongs to ("（1 个失败）"), and at most three kinds named when there are more than four,
 * the rest as "还有 N 个动作". What is counted is distinct targets: a file read three times is one file, a command run twice is two
 * commands (each ran). When every file touched is the same one, the line names it instead and says what was done to it: "读取并修改了
 * cart.js". The kinds come in a fixed order, not the order they happened in.
 */
export function summarizeGroup(items: readonly WorkItem[]): GroupSummary {
  const buckets = new Map<Kind, Targets>(), ops = new Set<FileOp>();
  const add = (kind: Kind, key: string, status: ItemStatus) => {
    const targets = buckets.get(kind) ?? { keys: new Map<string, Set<ItemStatus>>() };
    buckets.set(kind, targets);
    const statuses = targets.keys.get(key) ?? new Set<ItemStatus>();
    targets.keys.set(key, statuses.add(status));
  };
  for (const item of items) switch (item.type) {
    case "command": add(hubCommandOnly(item.command) !== null || inRecord(item.command) ? "hub" : "command", "id:" + item.id, item.status); break;
    case "file_change":
      if (item.changes.length === 0) { add("change", "id:" + item.id, item.status); ops.add("modify"); }
      else for (const change of item.changes) { add("change", "path:" + change.path, item.status); ops.add(change.op); }
      break;
    case "subagent": add("subagent", "id:" + item.id, item.status); break;
    case "file_read": if (item.path !== null && inRecord(item.path)) add("hub", "id:" + item.id, item.status); else add("read", item.path === null ? "id:" + item.id : "path:" + item.path, item.status); break;
    case "search": add("search", "id:" + item.id, item.status); break;
    case "web": if (item.action === "search") add("web_search", "id:" + item.id, item.status); else add("web_fetch", item.url ? "url:" + item.url : "id:" + item.id, item.status); break;
    case "mcp_tool": add(item.hub ? "hub" : "tool", "id:" + item.id, item.status); break;
    case "tool": add("tool", "id:" + item.id, item.status); break;
  }
  // The files touched, read or changed, by their paths; a read that names no path is a file of its own.
  const files = new Set([...(buckets.get("read")?.keys.keys() ?? []), ...(buckets.get("change")?.keys.keys() ?? [])]);
  const only = files.size === 1 ? [...files][0]! : null, named = only !== null && only.startsWith("path:") ? baseName(only.slice("path:".length)) : null;
  const parts: (SummaryPart & { readonly problems: Problems })[] = [];
  const part = (text: string, targets: readonly Set<ItemStatus>[]) => {
    const found = problemsOf(targets);
    parts.push({ text: text + annotation(found), count: targets.length, failed: targets.length > 0 && found.failed === targets.length, problems: found });
  };
  for (const kind of ORDER) {
    const targets = buckets.get(kind);
    if (targets === undefined) continue;
    const statuses = [...targets.keys.values()];
    if (named !== null && (kind === "change" || kind === "read")) {
      // One file in all: the line says what was done to it, once, where the first of the two kinds would stand.
      if (kind === "read" && buckets.has("change")) continue;
      const did = DONE.filter(([what]) => what === "read" ? buckets.has("read") : ops.has(what)).map(([, word]) => word);
      // One file: what happened to it, whichever of the two kinds the action was, counted once.
      const merged = new Set<ItemStatus>();
      for (const kinds of [buckets.get("read"), buckets.get("change")]) for (const set of kinds?.keys.values() ?? []) for (const status of set) merged.add(status);
      part(did.length > 1 ? did.slice(0, -1).join("、") + "并" + did.at(-1) + "了 " + named : did[0] + "了 " + named, [merged]);
    } else if (kind === "change") part(CHANGE[CHANGED(ops)].completed + ` ${statuses.length} 个文件`, statuses);
    else part(NOUN[kind](statuses.length), statuses);
  }
  const listed = parts.length > 4 ? parts.slice(0, 3) : parts, rest = parts.slice(listed.length);
  const folded = rest.reduce((sum, row) => sum + row.count, 0), foldedProblems = rest.reduce((sum, row) => { for (const key of Object.keys(sum) as (keyof Problems)[]) sum[key] += row.problems[key]; return sum; }, NO_PROBLEMS());
  const shown: SummaryPart[] = listed.map(({ text, count, failed }) => ({ text, count, failed }));
  if (rest.length) shown.push({ text: `还有 ${folded} 个动作` + annotation(foldedProblems), count: folded, failed: false });
  const problems = parts.reduce((sum, row) => sum + row.problems.failed + row.problems.declined + row.problems.cancelled + row.problems.unknown, 0);
  return { text: shown.map(row => row.text).join("，"), parts: shown, folded: rest.length ? folded : 0, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// Where a Turn's items go
// ---------------------------------------------------------------------------------------------------------------------

/** A single item drawn as itself: a message, a notice, a switch, a thought on its own. */
export interface ItemBlock { readonly kind: "item"; readonly item: ReadItem }
/**
 * Consecutive actions: one line for one action, a summary line for several that opens to their lines. `rows` are the actions with
 * the thoughts that came between them, in order; `work` the actions alone. `key` is the first action's id, so a run that grows keeps
 * the same identity. `tail` says nothing but thoughts follows it, so more actions may still join it while the Turn runs.
 */
export interface WorkBlock { readonly kind: "work"; readonly key: string; readonly rows: readonly ReadItem[]; readonly work: readonly WorkItem[]; readonly tail: boolean }
export type Block = ItemBlock | WorkBlock;
export interface Arrangement {
  readonly blocks: readonly Block[];
  /** What happened inside a delegated task, by the task's id: drawn under it, never beside it. */
  readonly children: ReadonlyMap<string, readonly ReadItem[]>;
  readonly over: boolean;
}
/**
 * Calls the timeline does not draw: the Hub's two tools that tell how the Turn goes (`hub_update_plan`, `hub_wrap_up`). What they said is the Turn's task list and wrap-up,
 * each one line in the transcript and shown whole above the message box; the call itself would only say it again.
 */
// The same goes for the Hub's delegation tools: the work handed over stands as a card after the Turn, and asking how it stands is not an action of the task.
const PROGRESS: ReadonlySet<string> = new Set<string>([...TABLE_PROGRESS_TOOLS, "hub_delegate", "hub_delegations", "hub_remember"]);
const COMMAND_ELSEWHERE: ReadonlySet<string> = new Set(["plan", "wrap-up", "delegate", "delegations", "remember"]);
const elsewhere = (item: ReadItem): boolean => item.type === "mcp_tool" ? item.server === TABLE_MCP_NAME && PROGRESS.has(item.tool)
  : item.type === "command" && COMMAND_ELSEWHERE.has(hubCommandOnly(item.command)?.verb ?? "");

/**
 * Lays items out in the order they come in: an action that comes after another with nothing but thoughts between them joins its
 * run; anything else (a message, a notice, a switch) ends it, so when a Turn gives its items interleaved with text the page needs
 * no other rule. Thoughts before the first action and after the last of a stretch stand on their own; those between actions go
 * with them.
 */
export function lay(items: readonly ReadItem[]): readonly Block[] {
  const top = items.filter(item => !elsewhere(item)), blocks: Block[] = [], stands = (item: ReadItem) => isWork(item) || item.type === "reasoning" || isGap(item);
  for (let at = 0; at < top.length;) {
    if (!stands(top[at]!)) { blocks.push({ kind: "item", item: top[at]! }); at++; continue; }
    let end = at;
    while (end < top.length && stands(top[end]!)) end++;
    const stretch = top.slice(at, end), first = stretch.findIndex(isWork), last = stretch.findLastIndex(isWork);
    if (first < 0) for (const item of stretch) blocks.push({ kind: "item", item });
    else {
      for (const item of stretch.slice(0, first)) blocks.push({ kind: "item", item });
      const rows = stretch.slice(first, last + 1);
      blocks.push({ kind: "work", key: rows[0]!.id, rows, work: rows.filter(isWork), tail: false });
      for (const item of stretch.slice(last + 1)) blocks.push({ kind: "item", item });
    }
    at = end;
  }
  return blocks.map((block, index) => block.kind === "work" && blocks.slice(index + 1).every(next => next.kind === "item" && next.item.type === "reasoning") ? { ...block, tail: true } : block);
}

/**
 * A Turn's items laid out (`lay`), with what happened inside a delegated task hung under that task instead of beside it, an action still
 * open when the Turn is over taken as unknown (`settled`), and, while the Turn waits for an approval (`asking`), the step it asks for
 * marked as waiting: the latest of the Turn's own actions that has not ended (a delegated task, when the approval is for one of its
 * tools: which of them it is, is not guessed at). Its line then says what it wants to do, with the state's word, "等你处理".
 */
export function arrange(turn: Pick<ReadTurn, "status" | "items">, options: { readonly asking?: boolean } = {}): Arrangement {
  // The Hub's record of the workspace is said once at the Turn's end (ProtocolTurn's WorkspaceLine), not among the Harness's own actions.
  // An answer said twice in one Turn (a Harness that says it, calls a tool such as the Hub's wrap-up, and says it again to end) is drawn once, where it ends:
  // the same message named by two segments, or two segments with the same words.
  const lastOf = new Map<string, string>();
  const words = (item: ReadItem): string | null => { const text = item.type === "assistant_message" ? item.text?.trim() : undefined; return text ? "text:" + text : null; };
  for (const item of turn.items) if (item.type === "assistant_message") { lastOf.set("id:" + item.messageId, item.id); const said = words(item); if (said !== null) lastOf.set(said, item.id); }
  const repeated = (item: ReadItem): boolean => { if (item.type !== "assistant_message") return false; const said = words(item); return lastOf.get("id:" + item.messageId) !== item.id || (said !== null && lastOf.get(said) !== item.id); };
  const over = turnOver(turn), items = turn.items.filter(item => !(item.type === "file_change" && item.by === "hub") && !repeated(item)).map(item => settled(item, over));
  const tasks = new Set(items.filter(item => item.type === "subagent").map(item => item.id));
  // The task an item happened inside, when that task is one of the Turn's own. A chain of tasks that leads back to itself is shown flat, so that every item is shown once.
  const parents = new Map(items.map(item => [item.id, item.parentId !== undefined && tasks.has(item.parentId) && item.parentId !== item.id ? item.parentId : undefined]));
  const looped = (item: ReadItem): boolean => {
    const seen = new Set([item.id]);
    for (let id = parents.get(item.id); id !== undefined; id = parents.get(id)) { if (seen.has(id)) return true; seen.add(id); }
    return false;
  };
  const children = new Map<string, ReadItem[]>(), top: ReadItem[] = [];
  for (const item of items) {
    const parent = parents.get(item.id);
    if (parent !== undefined && !looped(item)) children.set(parent, [...(children.get(parent) ?? []), item]);
    else top.push(item);
  }
  const asked = options.asking === true && !over ? askingFor(items) : undefined;
  return { blocks: lay(asked === undefined ? top : top.map(item => item === asked ? { ...item, status: "waiting" } as ReadItem : item)), children, over };
}

/**
 * The action an approval that waits is about, as far as the Turn's facts tell: the latest of the Turn's own actions (not the inner ones of
 * a delegated task, whose tool the approval is for is not guessed at) that has not ended, pending or in progress. The Harnesses report the
 * call they ask about as pending until it is allowed, or as in progress; the interface says it waits for you.
 */
export function askingFor(items: readonly ReadItem[]): WorkItem | undefined {
  const tasks = new Set(items.filter(item => item.type === "subagent").map(item => item.id));
  const inside = (item: ReadItem) => item.parentId !== undefined && tasks.has(item.parentId) && item.parentId !== item.id;
  return items.findLast((item): item is WorkItem => isWork(item) && (item.status === "pending" || item.status === "running") && !inside(item));
}

/**
 * Whether a run of actions is open when the page opens it: the run that goes on (an action in progress or waiting for you, or the last
 * run of a Turn that is still going, which more actions may join), and every run in the detailed density. A run with a failure is folded
 * like any other: its summary line says how many failed ("3 个失败"), and that is where a failed test run, which is common, belongs.
 */
export function opensByDefault(block: WorkBlock, active: boolean, detailed: boolean): boolean {
  if (detailed) return true;
  return block.work.some(item => item.status === "pending" || item.status === "running" || item.status === "waiting") || active && block.tail;
}

/**
 * The blocks of a Turn as the two quieter ways of showing its process leave them (the `density` preference). `failures`: of its actions only those that failed or whose
 * result is unknown, each as its own line, and no thoughts. `answer`: no actions and no thoughts at all, and — once the Turn is over — of what the Harness said only
 * the last, which is its answer. Everything else (a failure, a notice, something it made, a question) stays, in the order it came.
 */
export function quietBlocks(blocks: readonly Block[], way: "failures" | "answer", over: boolean): readonly Block[] {
  const last = blocks.findLastIndex(block => block.kind === "item" && block.item.type === "assistant_message");
  return blocks.flatMap((block, index): readonly Block[] => {
    if (block.kind === "work") {
      if (way === "answer") return [];
      const bad = block.work.filter(item => item.status === "failed" || item.status === "unknown");
      return bad.map(item => ({ kind: "work" as const, key: block.key + ":" + item.id, rows: [item], work: [item], tail: false }));
    }
    if (block.item.type === "reasoning") return [];
    if (way === "answer" && over && block.item.type === "assistant_message" && index !== last) return [];
    return [block];
  });
}

/**
 * What a Turn that is over folds behind one line (2026-11-14, after T3 Code's "Worked for 1m 3s"): everything it did before its final answer — its runs of actions, the
 * thoughts and the words it said between them — when that is more than the one line a single run of actions already is. The answer stays below it, and so does whatever
 * must stay in sight (`kept`: a failure, a notice, something it made, a plan it proposes, an interruption, what happened to the context), in the order it came.
 * Null when there is nothing to fold.
 */
export interface TurnFold { readonly folded: readonly Block[]; readonly kept: readonly Block[]; readonly answer: readonly Block[]; readonly work: readonly WorkItem[] }
export function turnFold(blocks: readonly Block[]): TurnFold | null {
  const last = blocks.findLastIndex(block => block.kind === "item" && block.item.type === "assistant_message");
  const before = last < 0 ? blocks : blocks.slice(0, last), answer = last < 0 ? [] : blocks.slice(last);
  const folds = (block: Block): boolean => block.kind === "work" || block.item.type === "assistant_message" || block.item.type === "reasoning";
  const folded = before.filter(folds), work = folded.flatMap(block => block.kind === "work" ? block.work : []);
  if (work.length === 0 || folded.length < 2) return null;
  return { folded, kept: before.filter(block => !folds(block)), answer, work };
}

/** An item's state from a Run's: its reply is running while the Run is, and over when it is. */
function replyStatus(status: PublicMessage["status"]): ItemStatus {
  switch (status) {
    case "queued": return "pending";
    case "preparing": case "running": case "settling": return "running";
    default: return status;
  }
}
/**
 * The Turn with its reply among its items. The reply is a message of the conversation, which arrives on the stream apart from the Turn's
 * other items, and the Turn does not list it until the Run's next frame: the words the Harness is writing now are shown from the message,
 * where the reply's item would stand (after the notices, before an error, the artifacts and the context events). A Turn that lists its
 * reply is returned as it is.
 */
export function withReply(turn: ReadTurn, message: PublicMessage | undefined): ReadTurn {
  if (message === undefined || message.role !== "assistant" || message.text === "") return turn;
  if (turn.items.some(item => item.type === "assistant_message" && item.messageId === message.id)) return turn;
  const reply: ReadItem = { id: "hh:reply", seq: turn.items.length, status: replyStatus(message.status), type: "assistant_message", messageId: message.id, phase: "final" };
  const after = turn.items.findIndex(item => item.type === "error" || item.type === "artifact" || item.type === "context_event"), at = after < 0 ? turn.items.length : after;
  return { ...turn, items: [...turn.items.slice(0, at), reply, ...turn.items.slice(at)] };
}
