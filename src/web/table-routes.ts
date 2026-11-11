import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContentPort } from "../contracts/content.js";
import { SessionError, type SessionConfiguration, type SessionId, type SessionSnapshot } from "../contracts/session.js";
import { TABLE_LIMITS, TABLE_PARTS, type TableGrant, type TableGrants, type TablePart } from "../contracts/table.js";
import {
  detailKey, directoryNeeds, directoryRange, parseTableDetail, readTurn, searchNeeds, searchTurns, tableRedaction, turnNeeds, turnsView,
  type TableDetails, type TableRedaction, type TableToolDetail, type TableToolRef,
} from "../contexts/session/domain/table.js";

/**
 * The context table's HTTP API (docs/decisions/LOG.md, 2026-11-11): what a Harness running a Turn of a conversation the Hub
 * started may read back of that conversation, through the Hub's tool process (src/cli/hub-tools.ts). Three reads, all GET:
 *
 *   /api/table/turns           the directory: a window of the Turns, one line each
 *   /api/table/turns/:n        one Turn, or one piece of it, as one page
 *   /api/table/search?q=       a word or phrase over the whole conversation
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
}
export interface TableApiOptions {
  readonly grants: TableGrants;
  /** The Session as the Runtime reads it (SESSION_NOT_FOUND for an identity it does not hold). */
  readonly read: (id: SessionId) => SessionSnapshot;
  /** Where stored tool details are read back; absent: none can be, and what they hold is told as unread. */
  readonly content?: Pick<ContentPort, "readText">;
  /** The known secret values of these Harnesses (the factory's relaySecrets), hidden wherever the table quotes them; absent: only the shape rules hide. */
  readonly secrets?: (configuration: SessionConfiguration, harnessIds: readonly string[]) => Promise<readonly string[]>;
  readonly http: TableHttp;
  readonly now?: () => number;
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

  /**
   * Answers the table's routes; false for any other request. Called after the server's own Host check, before its login: a
   * request that is none of the table's goes on to the rest of the server as it was.
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const { http } = this.options, path = url.pathname;
    const turn = /^\/api\/table\/turns\/([0-9]{1,6})$/u.exec(path), turns = path === "/api/table/turns", search = path === "/api/table/search";
    if (!turn && !turns && !search) return false;
    // In this order: only this computer; then the token (whatever else is wrong with a request, a token that is not valid is a 401); then what may be asked.
    if (!loopback(request.socket.remoteAddress)) { http.json(response, 403, { code: "TABLE_LOCAL_ONLY", message: "The table is for programs on this computer" }); return true; }
    const grant = this.authenticate(request);
    if (grant === null) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="harnesshub"');
      http.json(response, 401, { code: "TABLE_TOKEN_INVALID", message: "This conversation's token is missing, unknown or no longer valid" }); return true;
    }
    if (method !== "GET") { response.setHeader("Allow", "GET"); http.json(response, 405, { code: "METHOD_NOT_ALLOWED", message: "The table is read with GET" }); return true; }
    if (request.headers.origin !== undefined) { http.json(response, 403, { code: "TABLE_LOCAL_ONLY", message: "The table is for programs on this computer, not for pages" }); return true; }
    const state = this.options.read(grant.sessionId), hiding = await this.redaction(state, grant);
    const notes = hiding.known ? [] : [UNHIDDEN];
    if (turns) {
      http.queries(url, ["from", "limit"]);
      const from = whole(url, "from", 1, 1_000_000), limit = whole(url, "limit", 1, TABLE_LIMITS.turnsMax), range = directoryRange(state, from, limit);
      const loaded = await this.load(directoryNeeds(state, range.from, range.to), TABLE_LIMITS.directoryDetails);
      const view = turnsView(state, from, limit, loaded.details, hiding.redaction);
      http.json(response, 200, { ...view, ...(notes.length ? { notes } : {}) }); return true;
    }
    if (turn) {
      http.queries(url, ["part", "tool", "offset", "limit"]);
      const n = Number(turn[1]), part = url.searchParams.get("part");
      if (part !== null && !(TABLE_PARTS as readonly string[]).includes(part)) invalid("part must be one of " + TABLE_PARTS.join(", "));
      const tool = whole(url, "tool", 1, 100_000), offset = whole(url, "offset", 0, 1_000_000_000), limit = whole(url, "limit", 1, TABLE_LIMITS.pageMax);
      const query = { ...(part === null ? {} : { part: part as TablePart }), ...(tool === undefined ? {} : { tool }), ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
      const loaded = await this.load(turnNeeds(state, n, query.part, tool), TABLE_LIMITS.turnDetails);
      const view = readTurn(state, n, query, loaded.details, hiding.redaction);
      http.json(response, 200, { ...view, ...(notes.length ? { notes: [...(view.notes ?? []), ...notes] } : {}) }); return true;
    }
    http.queries(url, ["q", "limit"]);
    const words = url.searchParams.get("q");
    if (words === null || words.trim() === "" || words.length > TABLE_LIMITS.queryMax) invalid("q must be the words to search for, 1 to " + TABLE_LIMITS.queryMax + " characters");
    const limit = whole(url, "limit", 1, TABLE_LIMITS.searchMax), needs = searchNeeds(state), loaded = await this.load(needs, TABLE_LIMITS.searchDetails);
    const view = searchTurns(state, words, limit, loaded.details, hiding.redaction, loaded.unread);
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
  private async redaction(state: SessionSnapshot, grant: TableGrant): Promise<{ readonly redaction: TableRedaction; readonly known: boolean }> {
    const provider = this.options.secrets;
    if (provider === undefined) return { redaction: tableRedaction([]), known: true };
    const ids = [...new Set([...state.runs.map(run => run.selection.harnessId), grant.harnessId])].sort(), key = state.id + "\n" + ids.join(","), now = (this.options.now ?? Date.now)();
    let entry = this.secretsFor.get(key);
    if (entry === undefined || entry.until <= now) {
      let values: readonly string[] | null;
      try { values = await provider(state.configuration, ids); } catch { values = null; }
      entry = { values, until: now + (values === null ? SECRETS_FAILED_MS : SECRETS_FRESH_MS) };
      this.secretsFor.set(key, entry);
      if (this.secretsFor.size > 64) this.secretsFor.delete(this.secretsFor.keys().next().value!);
    }
    return { redaction: tableRedaction(entry.values ?? []), known: entry.values !== null };
  }

  /**
   * The stored details of these tool calls, read back in order within the bounds of one request (how many, how many bytes). A detail
   * that is not stored any more, was changed, is too large or is not a detail is left out; `unread` counts the ones not read.
   */
  private async load(refs: readonly TableToolRef[], most: number): Promise<{ readonly details: TableDetails; readonly unread: number }> {
    const details = new Map<string, TableToolDetail>(), content = this.options.content;
    if (content?.readText === undefined) return { details, unread: refs.length };
    let tried = 0, bytes = 0;
    for (const item of refs) {
      if (tried >= most || bytes + item.ref.bytes > TABLE_LIMITS.totalBytes) break;
      tried++; bytes += item.ref.bytes;
      let text: string | null;
      try { text = await content.readText(item.ref, TABLE_LIMITS.detailBytes); } catch { text = null; }
      if (text === null) continue;
      let value: unknown;
      try { value = JSON.parse(text); } catch { continue; }
      const detail = parseTableDetail(value);
      if (detail !== null) details.set(detailKey(item.runId, item.toolId), detail);
    }
    return { details, unread: refs.length - details.size };
  }
}
