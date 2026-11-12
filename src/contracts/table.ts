import type { SessionId } from "./session.js";

/**
 * The context table: everything the Hub holds about one conversation, which a Harness may read for itself (docs/decisions/LOG.md,
 * 2026-11-11). The Hub pushes a little with each handoff; the rest is pulled through these tools.
 */

/** The environment a native process started by the Hub carries, and the Hub's tool process reads. Absent: not a Hub session. */
export const TABLE_ENV = { url: "HARNESSHUB_URL", session: "HARNESSHUB_SESSION" } as const;

/** The name of the Hub's own MCP entry in a Harness's configuration. */
export const TABLE_MCP_NAME = "harnesshub";

/** The read tools of the first slice. */
export const TABLE_TOOLS = ["hub_turns", "hub_read_turn", "hub_search", "hub_update_plan", "hub_wrap_up"] as const;
/** The Hub's tools that write: they tell the Hub how the Turn in progress goes (its task list, its wrap-up); the page shows these, and not the calls. */
export const TABLE_PROGRESS_TOOLS = ["hub_update_plan", "hub_wrap_up"] as const;
export type TableTool = typeof TABLE_TOOLS[number];
/**
 * What a Driver that can add to its session's system prompt adds there (HarnessControl.setSessionInstructions) when that session has the
 * Hub's tools and the preference `hub.progress` is on: how to use the two progress tools. It never goes into the user's message; the
 * settings page shows it word for word.
 */
export const HUB_PROGRESS_INSTRUCTIONS = "你在 HarnessHub 里工作，这个会话带有 harnesshub 的工具：\n"
  + "1. 任务要做好几步时，开始就调用 hub_update_plan 列出全部步骤（正在做的那一步标 in_progress），之后每开始或做完一步再调用一次更新。\n"
  + "2. 每一轮结束前调用一次 hub_wrap_up，用两三句话写清现在做完了什么、还有什么没做或没验证。\n"
  + "3. 需要用户拿主意时，把一个问题放进 hub_wrap_up 的 ask、一到两个回答放进 actions（推荐的放第一个），不要只在正文里问。\n"
  + "这是这个界面显示进度和下一步的唯一途径；它们不代替你的正文回复。";

/** What the tool process answers when it was not started inside a Hub session. */
export const TABLE_NOT_IN_SESSION = "Not inside a HarnessHub conversation: there is nothing to read here.";

/** Who a session token stands for: one Harness reading one conversation. */
export interface TableGrant { readonly sessionId: SessionId; readonly harnessId: string; readonly controlId: string }

/** Tokens the Hub hands a native process at launch. Opaque, unguessable, and worth nothing outside this machine. */
export interface TableGrants {
  mint(grant: TableGrant): string;
  resolve(token: string): TableGrant | null;
  revoke(sessionId: SessionId): void;
}

/**
 * One line of the directory: a Turn, who ran it, and how it ended. `n` counts from 1 in conversation order (the same number a
 * handoff note gives the Turn). `user` and `reply` are shortened and redacted; `tools` counts the Turn's tool calls without its
 * reasoning; `files` counts the distinct files its changes touched, and `filesApprox` says some change's files could not be
 * read, so that change counted as one file.
 */
export interface TableTurnLine {
  readonly n: number; readonly harnessId: string; readonly status: string;
  readonly user: string; readonly reply: string; readonly tools: number; readonly files: number;
  readonly model?: string; readonly filesApprox?: true;
}

/** How much the read tools hand back at once, and how much of the stored detail they will read to answer. */
export const TABLE_LIMITS = {
  /** The directory lists this many Turns unless asked for another number, and at most `turnsMax`. */
  turnsDefault: 40, turnsMax: 100,
  /** One page of a long text is this many characters unless asked for another number, and at most `pageMax`. */
  pageDefault: 12_000, pageMax: 40_000,
  /** A search returns this many places unless asked for another number, and at most `searchMax`; its words are at most `queryMax` long. */
  searchDefault: 20, searchMax: 50, queryMax: 200,
  /** A stored tool detail is read back when it is no larger than this. */
  detailBytes: 1024 * 1024,
  /** At most this many stored details (and bytes) are read to answer one request: a directory, one Turn, a search. */
  directoryDetails: 300, turnDetails: 200, searchDetails: 400, totalBytes: 32 * 1024 * 1024,
} as const;

/** The pieces of one Turn `hub_read_turn` can return; `overview` is the default. */
export const TABLE_PARTS = ["overview", "user", "reply", "tools", "files", "plan", "input", "output", "diff"] as const;
export type TablePart = typeof TABLE_PARTS[number];
/** The parts that read one tool call of the Turn, which the request names by its number in the list `tools` gives. */
export const TABLE_TOOL_PARTS = ["input", "output", "diff"] as const;

/** The directory (`GET /api/table/turns`): a window of the Turns, oldest first. `from` and `to` are 1-based and inclusive; `to` is `from - 1` when none is listed. */
export interface TableTurnsView {
  readonly total: number; readonly from: number; readonly to: number;
  readonly lines: readonly TableTurnLine[];
  /** The Turn that is running now, when one is. */
  readonly active?: number;
  /** The conversation started from earlier history (a branch, or a native session continued in the Hub) that the Turns do not include. */
  readonly origin?: { readonly kind: "fork" | "import"; readonly messages: number };
  readonly notes?: readonly string[];
}

/**
 * One page of one part of one Turn (`GET /api/table/turns/:n`). The offsets count characters (UTF-16 code units) of the part's
 * redacted text: this page is `text`, from `offset` to `end` of `size`; `end < size` means there is more, from `end`. The
 * overview is composed to fit one page and says itself where each of its pieces continues.
 */
export interface TableTurnRead {
  readonly n: number; readonly total: number;
  readonly harnessId: string; readonly status: string; readonly model?: string;
  readonly part: TablePart; readonly tool?: number;
  readonly text: string; readonly offset: number; readonly end: number; readonly size: number;
  readonly notes?: readonly string[];
}

/**
 * What a search looks through: `all` (the default) is everything, the words and the tool calls with what they ran and printed, read Turn by Turn; `words` is the user's words and the
 * replies alone, found by the conversation's full-text indexes, which is quick however long the conversation is.
 */
export const TABLE_SEARCH_SCOPES = ["all", "words"] as const;
export type TableSearchScope = typeof TABLE_SEARCH_SCOPES[number];
/** What a search match was found in: the user's words, a reply, a tool call's title, its input, its output or its diff. */
export const TABLE_SEARCH_WHERE = ["user", "reply", "tool", "input", "output", "diff"] as const;
export type TableSearchWhere = typeof TABLE_SEARCH_WHERE[number];
/** One place a search matched: its Turn, what it was found in (and which tool call), the character where the first match starts in that text, how many matches it holds, and an excerpt. */
export interface TableSearchHit {
  readonly n: number; readonly where: TableSearchWhere; readonly tool?: number;
  readonly at: number; readonly matches: number; readonly snippet: string;
}
/** A search (`GET /api/table/search`): a page of the places found, newest Turn first (`hits`, `total` of them in this page), `next` to go on from, and how many tool details could not be searched. */
export interface TableSearchView {
  readonly query: string; readonly total: number; readonly hits: readonly TableSearchHit[];
  readonly turns: number; readonly unsearched: number;
  /** What was searched, when it was the words alone. */
  readonly scope?: "words";
  /** Where the next page of places starts (`after` of the next search); absent when this page reached the first Turn. */
  readonly next?: string;
  readonly notes?: readonly string[];
}

/** What a native process the Hub started for a Session carries: the Hub's address and that process's own token. */
export interface TableEnvironment { readonly url: string; readonly session: string }
/**
 * The table variables of a process's environment, or null when it is not a Hub Session's process: either variable absent,
 * or not what the Hub sets (its own loopback origin, an opaque token). Only that shape counts, so the tool never sends a token
 * anywhere else, and a Harness that hands a tool the text of a variable it was not given (Claude Code passes an unset
 * `${HARNESSHUB_URL}` through as that text) reads as a process outside the Hub.
 */
export function readTableEnv(env: Readonly<Record<string, string | undefined>>): TableEnvironment | null {
  const url = env[TABLE_ENV.url], session = env[TABLE_ENV.session];
  if (url === undefined || session === undefined || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u.test(url) || !/^[A-Za-z0-9_-]{16,128}$/u.test(session)) return null;
  return { url, session };
}
