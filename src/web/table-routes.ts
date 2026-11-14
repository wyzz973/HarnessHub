import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContentPort } from "../contracts/content.js";
import type { ConversationReader } from "../contracts/conversation.js";
import { BOARD_KINDS, SessionError, type SessionConfiguration, type SessionId } from "../contracts/session.js";
import { TABLE_LIMITS, TABLE_PARTS, TABLE_SEARCH_SCOPES, type TableGrant, type TableGrants, type TablePart, type TableSearchScope } from "../contracts/table.js";
import { readDetail } from "../contexts/session/domain/detail-read.js";
import {
  detailKey, directoryNeeds, directoryRange, readTurn, rowsTable, searchPage, searchWordsPage, tableDetailOf, tableDetailPolicy, tableRedaction, turnNeeds, turnsView,
  type SearchLoad, type TableConversation, type TableDetails, type TableDetailUse, type TableRedaction, type TableToolDetail, type TableToolRef,
} from "../contexts/session/domain/table.js";

/**
 * The context table's HTTP API (docs/decisions/LOG.md, 2026-11-11): what a Harness running a Turn of a conversation the Hub
 * started may read back of that conversation, through the Hub's tool process (src/cli/hub-tools.ts). Three reads, all GET:
 *
 *   /api/table/turns           the directory: a window of the Turns, one line each
 *   /api/table/turns/:n        one Turn, or one piece of it, as one page
 *   /api/table/search?q=       a word or phrase over the whole conversation, a page of places at a time (`after` goes on from the `next` of the page before)
 *
 * The caller is a program on this computer, not a browser: it brings `Authorization: Bearer <token>`, a token the Hub minted for
 * the native process it started (TableGrants), and the token names the conversation, so there is no conversation in the path
 * and no way to ask for another. The web login's cookie and CSRF token play no part here. Requests from anywhere but the
 * loopback, or with an Origin (a page), are refused; a missing, unknown or revoked token is a 401, whatever else is wrong.
 */

/** The HTTP helpers of the server this API is mounted on (they live in server.ts). */
export interface TableHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  queries(url: URL, allowed: readonly string[]): void;
  /** The JSON body of a request (the two writing routes). */
  body?(request: IncomingMessage): Promise<unknown>;
}
export interface TableApiOptions {
  readonly grants: TableGrants;
  /** The conversations as rows: the table reads the head and the Turns a request needs, one at a time (SESSION_NOT_FOUND for an identity it does not hold). */
  readonly reader: Pick<ConversationReader, "head" | "turnAt" | "runOrdinal" | "originHistory" | "harnessIds" | "search">;
  /** Where stored tool details are read back; absent: none can be, and what they hold is told as unread. */
  readonly content?: Pick<ContentPort, "readText" | "readChunks">;
  /** The known secret values of these Harnesses (the factory's relaySecrets), hidden wherever the table quotes them; absent: only the shape rules hide. */
  readonly secrets?: (configuration: SessionConfiguration, harnessIds: readonly string[]) => Promise<readonly string[]>;
  readonly http: TableHttp;
  readonly now?: () => number;
  /** What the Harness of the conversation's Turn in progress says of it (`hub_update_plan`, `hub_wrap_up`): the Runtime places it in the Turn; absent, the two routes refuse. */
  readonly progress?: (grant: TableGrant, made: TableProgress) => void;
  /**
   * `hub_delegate` and `hub_delegations` (2026-11-13): the Harness of the conversation's Turn in progress hands a part of its work to another Harness, which does it in a
   * conversation of its own, and asks how what it handed over stands. Absent, the two routes refuse.
   */
  /**
   * The task the token's conversation belongs to (task-family.ts): that conversation, the one that delegated it and everything delegated under either, each by its label. With it the
   * three reads take `c=<label>` for another conversation of the task, and `/api/table/task` gives the overview; absent, a token reads its own conversation only.
   */
  readonly family?: (grant: TableGrant) => readonly import("./task-family.js").TaskMember[];
  /** The task's board (`hub_board`, `hub_remember`): read by any Harness of the task, written by the Harness of the conversation's Turn in progress. Absent, the route refuses. */
  readonly board?: {
    readonly read: (grant: TableGrant) => import("../contracts/session.js").TaskBoard;
    readonly write: (grant: TableGrant, change: { readonly kind: import("../contracts/session.js").BoardKind; readonly text: string } | { readonly forget: string }) => import("../contracts/session.js").TaskBoard;
  };
  /** What changed in the task while the Turn in progress of the token's conversation works, as its Harness is told with a tool's answer; null for nothing. Absent: nothing is told that way. */
  readonly signals?: (grant: TableGrant) => string | null;
  readonly delegation?: {
    readonly start: (grant: TableGrant, harness: string, task: string) => Promise<{ readonly sessionId: string; readonly harness: string }>;
    readonly states: (grant: TableGrant) => readonly import("../contracts/session.js").DelegationState[];
  };
}
/** What the two writing tools bring: the whole task list, or the Turn's wrap-up. */
export type TableProgress =
  | { readonly kind: "plan"; readonly items: readonly { readonly content: string; readonly status: "pending" | "in_progress" | "completed" }[]; readonly explanation?: string }
  | { readonly kind: "recap"; readonly summary: string; readonly ask?: string; readonly actions?: readonly string[]; readonly title?: string };
const STEP_STATES = ["pending", "in_progress", "completed"] as const;
/** The progress a request's body says, checked for its shape (never for its size: a task list or a recap is as long as the Harness makes it). */
function progressOf(path: string, value: unknown): TableProgress {
  const body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid("the body must be a JSON object");
  const text = (field: unknown, name: string): string => typeof field === "string" && field.trim() !== "" ? field : invalid(name + " must be a text");
  if (path === "/api/table/plan") {
    if (!Array.isArray(body.items)) invalid("items must be the whole task list: [{ content, status }]");
    const items = (body.items as unknown[]).map((entry, index) => {
      const row = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : invalid("items[" + index + "] must be { content, status }");
      if (!(STEP_STATES as readonly unknown[]).includes(row.status)) invalid("items[" + index + "].status must be one of " + STEP_STATES.join(", "));
      return { content: text(row.content, "items[" + index + "].content"), status: row.status as typeof STEP_STATES[number] };
    });
    return { kind: "plan", items, ...(typeof body.explanation === "string" && body.explanation.trim() !== "" ? { explanation: body.explanation } : {}) };
  }
  const actions = body.actions === undefined || body.actions === null ? [] : Array.isArray(body.actions) ? (body.actions as unknown[]).map((entry, index) => {
    if (typeof entry === "string") return text(entry, "actions[" + index + "]");
    const row = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : invalid("actions[" + index + "] must be { label }");
    return text(row.label, "actions[" + index + "].label");
  }) : invalid("actions must be a list of { label }");
  const ask = typeof body.ask === "string" && body.ask.trim() !== "" ? body.ask : undefined;
  // The name the first Turn's wrap-up may give the conversation (2026-11-14); the Runtime decides whether it is taken.
  if (body.title !== undefined && body.title !== null && typeof body.title !== "string") invalid("title must be a text");
  const title = typeof body.title === "string" && body.title.trim() !== "" ? body.title : undefined;
  return { kind: "recap", summary: text(body.recap, "recap"), ...(ask === undefined ? {} : { ask }), ...(actions.length === 0 ? {} : { actions }), ...(title === undefined ? {} : { title }) };
}

/** The known secrets are asked for again after this long; a failed ask is not repeated for the shorter time. */
const SECRETS_FRESH_MS = 60_000, SECRETS_FAILED_MS = 10_000;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/u;
const UNHIDDEN = "Hiding the known secrets of the Harnesses was not possible for this answer; only the pattern-based hiding was applied.";

function invalid(message: string): never { throw new SessionError("INVALID_INPUT", message); }
/** A whole number from a query parameter within its bounds; undefined when absent. */
function whole(url: URL, name: string, minimum: number, maximum: number): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]{0,8})$/u.test(value)) invalid(name + " must be a whole number");
  const number = Number(value);
  if (number < minimum || number > maximum) invalid(name + " must be between " + minimum + " and " + maximum);
  return number;
}
/** Whether a socket's far end is this computer. */
function loopback(address: string | undefined): boolean {
  return address !== undefined && (address === "::1" || address === "127.0.0.1" || /^::ffff:127\./iu.test(address) || /^127\.\d+\.\d+\.\d+$/u.test(address));
}

export class TableApi {
  private readonly secretsFor = new Map<string, { readonly values: readonly string[] | null; readonly until: number }>();
  constructor(private readonly options: TableApiOptions) {}
  private conversation(id: SessionId): TableConversation { return rowsTable(this.options.reader, id); }

  /**
   * Answers the table's routes; false for any other request. Called after the server's own Host check, before its login: a
   * request that is none of the table's goes on to the rest of the server as it was.
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const { http } = this.options, path = url.pathname;
    const turn = /^\/api\/table\/turns\/([0-9]{1,6})$/u.exec(path), turns = path === "/api/table/turns", search = path === "/api/table/search";
    const writes = path === "/api/table/plan" || path === "/api/table/wrap-up";
    const delegate = path === "/api/table/delegate", delegations = path === "/api/table/delegations", task = path === "/api/table/task", board = path === "/api/table/board";
    const signals = path === "/api/table/signals";
    if (!turn && !turns && !search && !writes && !delegate && !delegations && !task && !board && !signals) return false;
    // In this order: only this computer; then the token (whatever else is wrong with a request, a token that is not valid is a 401); then what may be asked.
    if (!loopback(request.socket.remoteAddress)) { http.json(response, 403, { code: "TABLE_LOCAL_ONLY", message: "The table is for programs on this computer" }); return true; }
    const grant = this.authenticate(request);
    if (grant === null) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="harnesshub"');
      http.json(response, 401, { code: "TABLE_TOKEN_INVALID", message: "This conversation's token is missing, unknown or no longer valid" }); return true;
    }
    if (request.headers.origin !== undefined) { http.json(response, 403, { code: "TABLE_LOCAL_ONLY", message: "The table is for programs on this computer, not for pages" }); return true; }
    // What changed in the task while this Turn works (2026-11-13): the tool process asks after each tool call and says it with the tool's answer.
    if (signals) {
      if (method !== "GET") { response.setHeader("Allow", "GET"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "Signals are read with GET" }); return true; }
      http.queries(url, []);
      let text: string | null = null;
      try { text = this.options.signals?.(grant) ?? null; } catch { text = null; }
      http.json(response, 200, { text }); return true;
    }
    if (writes) {
      if (method !== "POST") { response.setHeader("Allow", "POST"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "The Turn's progress is told with POST" }); return true; }
      http.queries(url, []);
      if (this.options.progress === undefined || http.body === undefined) { http.json(response, 501, { code: "PROGRESS_UNAVAILABLE", message: "This HarnessHub does not take a Turn's progress" }); return true; }
      this.options.progress(grant, progressOf(path, await http.body(request)));
      http.json(response, 200, { ok: true }); return true;
    }
    if (board) {
      const hooks = this.options.board;
      if (hooks === undefined || http.body === undefined) { http.json(response, 501, { code: "BOARD_UNAVAILABLE", message: "This HarnessHub keeps no task board" }); return true; }
      http.queries(url, []);
      if (method === "GET") { http.json(response, 200, hooks.read(grant)); return true; }
      if (method !== "POST") { response.setHeader("Allow", "GET, POST"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "The board is read with GET and written with POST" }); return true; }
      const value = await http.body(request), body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid("the body must be a JSON object");
      if (typeof body.forget === "string" && body.forget.trim() !== "") { http.json(response, 200, hooks.write(grant, { forget: body.forget.trim() })); return true; }
      if (!(BOARD_KINDS as readonly unknown[]).includes(body.kind)) invalid("kind must be one of " + BOARD_KINDS.join(", "));
      if (typeof body.text !== "string" || body.text.trim() === "") invalid("text must be what to remember");
      http.json(response, 200, hooks.write(grant, { kind: body.kind as typeof BOARD_KINDS[number], text: body.text as string })); return true;
    }
    if (delegate || delegations) {
      const hooks = this.options.delegation;
      if (hooks === undefined || http.body === undefined) { http.json(response, 501, { code: "DELEGATION_UNAVAILABLE", message: "This HarnessHub does not delegate" }); return true; }
      if (delegate) {
        if (method !== "POST") { response.setHeader("Allow", "POST"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "Work is delegated with POST" }); return true; }
        http.queries(url, []);
        const value = await http.body(request), body = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid("the body must be a JSON object");
        const text = (field: unknown, name: string): string => typeof field === "string" && field.trim() !== "" ? field.trim() : invalid(name + " must be a text");
        http.json(response, 200, await hooks.start(grant, text(body.harness, "harness"), text(body.task, "task"))); return true;
      }
      if (method !== "GET") { response.setHeader("Allow", "GET"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "Delegated work is read with GET" }); return true; }
      http.queries(url, ["wait"]);
      // `wait`: seconds to wait for what still runs to end, at most what one tool call may take; the reading is given whichever comes first.
      const wait = whole(url, "wait", 0, 25) ?? 0, until = (this.options.now ?? Date.now)() + wait * 1000;
      let states = hooks.states(grant);
      while (states.some(entry => entry.status === "running") && (this.options.now ?? Date.now)() < until && !response.destroyed) {
        await new Promise(done => setTimeout(done, 1000));
        states = hooks.states(grant);
      }
      http.json(response, 200, { delegations: states }); return true;
    }
    if (method !== "GET") { response.setHeader("Allow", "GET"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "The table is read with GET" }); return true; }
    if (task) {
      http.queries(url, []);
      const members = this.options.family?.(grant) ?? [];
      // Never an identity: the labels are what the tools take.
      http.json(response, 200, { self: members.find(member => member.sessionId === grant.sessionId)?.label ?? null, members: members.map(({ sessionId: _hidden, ...member }) => member) }); return true;
    }
    // `c`: another conversation of the same task, by its label; none but those can be named.
    const named = url.searchParams.get("c");
    const target = named === null ? grant.sessionId : (this.options.family?.(grant) ?? []).find(member => member.label === named)?.sessionId ?? invalid("c must be the label of a conversation of this task (the task overview lists them)");
    const state = this.conversation(target), hiding = await this.redaction(state, grant);
    const notes = hiding.known ? [] : [UNHIDDEN];
    if (turns) {
      http.queries(url, ["from", "limit", "c"]);
      const from = whole(url, "from", 1, 1_000_000), limit = whole(url, "limit", 1, TABLE_LIMITS.turnsMax), range = directoryRange(state, from, limit);
      const loaded = await this.load(directoryNeeds(state, range.from, range.to), TABLE_LIMITS.directoryDetails, "files");
      const view = turnsView(state, from, limit, loaded.details, hiding.redaction);
      http.json(response, 200, { ...view, ...(notes.length ? { notes } : {}) }); return true;
    }
    if (turn) {
      http.queries(url, ["part", "tool", "offset", "limit", "c"]);
      const n = Number(turn[1]), part = url.searchParams.get("part");
      if (part !== null && !(TABLE_PARTS as readonly string[]).includes(part)) invalid("part must be one of " + TABLE_PARTS.join(", "));
      const tool = whole(url, "tool", 1, 100_000), offset = whole(url, "offset", 0, 1_000_000_000), limit = whole(url, "limit", 1, TABLE_LIMITS.pageMax);
      const query = { ...(part === null ? {} : { part: part as TablePart }), ...(tool === undefined ? {} : { tool }), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
      const loaded = await this.load(turnNeeds(state, n, query.part, tool), TABLE_LIMITS.turnDetails, query.part === "input" || query.part === "output" || query.part === "diff" ? query.part : "files");
      const view = readTurn(state, n, query, loaded.details, hiding.redaction);
      http.json(response, 200, { ...view, ...(notes.length ? { notes: [...(view.notes ?? []), ...notes] } : {}) }); return true;
    }
    http.queries(url, ["q", "limit", "after", "in", "c"]);
    const words = url.searchParams.get("q"), after = url.searchParams.get("after") ?? undefined, scope = (url.searchParams.get("in") ?? "all") as TableSearchScope;
    if (!(TABLE_SEARCH_SCOPES as readonly string[]).includes(scope)) invalid("in must be one of " + TABLE_SEARCH_SCOPES.join(", "));
    if (words === null || words.trim() === "" || words.length > TABLE_LIMITS.queryMax) invalid("q must be the words to search for, 1 to " + TABLE_LIMITS.queryMax + " characters");
    const limit = whole(url, "limit", 1, TABLE_LIMITS.searchMax), reader = this.options.reader;
    // The words alone are found by the conversation's full-text indexes; everything is read Turn by Turn.
    const view = scope === "words"
      ? searchWordsPage(state, words, { limit, ...(after === undefined ? {} : { after }) }, (query, range) => reader.search(query, { sessionId: target, limit: range.limit, ...(range.after === undefined ? {} : { after: range.after }) }), hiding.redaction)
      : await searchPage(state, words, { limit, ...(after === undefined ? {} : { after }) }, this.searchLoad(), hiding.redaction);
    http.json(response, 200, { ...view, ...(notes.length ? { notes } : {}) }); return true;
  }

  /** The grant a request's bearer token stands for; null for none. */
  private authenticate(request: IncomingMessage): TableGrant | null {
    const header = request.headers.authorization;
    const token = typeof header === "string" ? BEARER.exec(header)?.[1] : undefined;
    return token === undefined ? null : this.options.grants.resolve(token);
  }

  /**
   * The redaction for a conversation: the known secrets of every Harness it ran on and of the caller's (asked of the factory,
   * kept a minute), and the shape rules. When the known secrets cannot be read, the answer says so and goes on with the shapes.
   */
  private async redaction(state: TableConversation, grant: TableGrant): Promise<{ readonly redaction: TableRedaction; readonly known: boolean }> {
    const provider = this.options.secrets;
    if (provider === undefined) return { redaction: tableRedaction([]), known: true };
    const ids = [...new Set([...state.harnessIds(), grant.harnessId])].sort(), key = state.id + "\n" + ids.join(","), now = (this.options.now ?? Date.now)();
    let entry = this.secretsFor.get(key);
    if (entry === undefined || entry.until <= now) {
      let values: readonly string[] | null;
      try { values = await provider(this.configuration(state.id), ids); } catch { values = null; }
      entry = { values, until: now + (values === null ? SECRETS_FAILED_MS : SECRETS_FRESH_MS) };
      this.secretsFor.set(key, entry);
      if (this.secretsFor.size > 64) this.secretsFor.delete(this.secretsFor.keys().next().value!);
    }
    return { redaction: tableRedaction(entry.values ?? []), known: entry.values !== null };
  }

  /** The configuration the secrets of a conversation's Harnesses are asked with: the head's. */
  private configuration(id: SessionId): SessionConfiguration { return this.options.reader.head(id).head.configuration; }

  /** One stored detail, read by what it is wanted for; null when it is not stored any more, was changed, is not a detail, or cannot be read. */
  private async detail(item: TableToolRef, use: TableDetailUse): Promise<TableToolDetail | null> {
    const content = this.options.content;
    if (content === undefined || (content.readText === undefined && content.readChunks === undefined)) return null;
    try {
      const read = await readDetail(content, item.ref, tableDetailPolicy(use));
      return read === null ? null : tableDetailOf(read);
    } catch { return null; }
  }
  /**
   * The stored details of these tool calls, read back in order within the bounds of one request (how many, how many bytes in all: the first is always read, whatever its size, which the
   * policy of `use` reduces to what the request can use). A detail that is not stored any more, was changed, or is not a detail is left out; `unread` counts the ones not read.
   */
  private async load(refs: readonly TableToolRef[], most: number, use: TableDetailUse): Promise<{ readonly details: TableDetails; readonly unread: number }> {
    const details = new Map<string, TableToolDetail>();
    let tried = 0, bytes = 0;
    for (const item of refs) {
      if (tried >= most || (tried > 0 && bytes + item.ref.bytes > TABLE_LIMITS.totalBytes)) break;
      tried++; bytes += item.ref.bytes;
      const detail = await this.detail(item, use);
      if (detail !== null) details.set(detailKey(item.runId, item.toolId), detail);
    }
    return { details, unread: refs.length - details.size };
  }
  /** The details a search reads as it goes from Turn to Turn: within the bounds of the one request, newest Turn first. */
  private searchLoad(): SearchLoad {
    const spent = { tried: 0, bytes: 0 };
    return async refs => {
      const details = new Map<string, TableToolDetail>();
      let unread = 0;
      for (const item of refs) {
        if (spent.tried >= TABLE_LIMITS.searchDetails || (spent.tried > 0 && spent.bytes + item.ref.bytes > TABLE_LIMITS.totalBytes)) { unread++; continue; }
        spent.tried++; spent.bytes += item.ref.bytes;
        const detail = await this.detail(item, "search");
        if (detail !== null) details.set(detailKey(item.runId, item.toolId), detail); else unread++;
      }
      return { details, unread };
    };
  }
}
