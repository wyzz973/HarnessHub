import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { sessionId, type SessionId } from "../contracts/session.js";
import type { TerminalListView, TerminalOpenedView, TerminalView } from "../contracts/terminal.js";
import { TerminalError, terminalSize, type Terminals } from "../infrastructure/workspace/terminals.js";

/*
 * A conversation's terminals (docs/contracts/public-api.md, "对话的终端"), mounted by the server before its routes of one conversation:
 *
 *   GET    /api/v1/sessions/:id/terminals                       → { terminals: TerminalView[] }, the oldest first
 *   POST   /api/v1/sessions/:id/terminals                       { cols, rows, title? } → 201 { id, title, createdAt }: starts a login shell in the workspace
 *   PATCH  /api/v1/sessions/:id/terminals/:tid                  { title } → TerminalView
 *   DELETE /api/v1/sessions/:id/terminals/:tid                  → 204 once its shell has ended and its history is deleted
 *   GET    /api/v1/sessions/:id/terminals/:tid/socket?cols=&rows=   upgraded to a WebSocket that attaches to it (the server lets it in first)
 *
 * Every write here has passed the server's Origin and CSRF checks, as every other. A conversation that is not there, or was deleted, is not found.
 */

export interface TerminalHttp {
  json(response: ServerResponse, status: number, value: unknown): void;
  headers(response: ServerResponse): void;
  queries(url: URL, allowed: readonly string[]): void;
  body(request: IncomingMessage): Promise<unknown>;
  /** The error an answer of this status and code is made from. */
  error(status: number, code: string, message: string): Error;
}
export interface TerminalRoutesOptions {
  readonly terminals: Terminals;
  /** The conversation's workspace; throws a not-found error for a conversation that is not there or was deleted. */
  readonly workspace: (id: SessionId) => string;
  /** The shell a new terminal runs and its environment. */
  readonly launch: () => Promise<{ readonly shell: string; readonly env: Readonly<Record<string, string>> }>;
  readonly http: TerminalHttp;
}

const LIST = /^\/api\/v1\/sessions\/([^/]+)\/terminals$/u, ONE = /^\/api\/v1\/sessions\/([^/]+)\/terminals\/([^/]+)$/u, SOCKET = /^\/api\/v1\/sessions\/([^/]+)\/terminals\/([^/]+)\/socket$/u;

export class TerminalRoutes {
  constructor(private readonly options: TerminalRoutesOptions) {}

  /** Answers one of these routes; false for any other request. */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    try { return await this.route(request, response, url, method); }
    catch (error) { throw this.fault(error); }
  }
  private async route(request: IncomingMessage, response: ServerResponse, url: URL, method: string): Promise<boolean> {
    const { http, terminals } = this.options, list = LIST.exec(url.pathname), one = list === null ? ONE.exec(url.pathname) : null;
    if (list !== null && method === "GET") {
      http.queries(url, []); const id = sessionId(list[1]!); this.options.workspace(id);
      http.json(response, 200, { terminals: terminals.list(id) } satisfies TerminalListView); return true;
    }
    if (list !== null && method === "POST") {
      http.queries(url, []); const id = sessionId(list[1]!);
      const input = this.object(await http.body(request), ["cols", "rows", "title"], ["cols", "rows"]);
      if (!terminalSize(input.cols) || !terminalSize(input.rows)) throw http.error(400, "INVALID_INPUT", "cols and rows are whole numbers from 1 to 65535");
      const title = input.title === undefined ? undefined : this.title(input.title), workspace = this.options.workspace(id);
      if (!await stat(workspace).then(info => info.isDirectory(), () => false)) throw http.error(409, "WORKSPACE_UNAVAILABLE", "The conversation's folder is not there");
      const { shell, env } = await this.options.launch();
      const opened = await terminals.open(id, { shell, cwd: workspace, env, size: { cols: input.cols, rows: input.rows } }, title);
      // A conversation deleted while its shell started does not keep it.
      try { this.options.workspace(id); } catch (error) { await terminals.closeTerminal(id, opened.id).catch(() => undefined); throw error; }
      http.json(response, 201, { id: opened.id, title: opened.title, createdAt: opened.createdAt } satisfies TerminalOpenedView); return true;
    }
    if (one !== null && method === "PATCH") {
      http.queries(url, []); const id = sessionId(one[1]!);
      const input = this.object(await http.body(request), ["title"], ["title"]), title = this.title(input.title);
      this.options.workspace(id);
      http.json(response, 200, terminals.rename(id, one[2]!, title) satisfies TerminalView); return true;
    }
    if (one !== null && method === "DELETE") {
      http.queries(url, []); const id = sessionId(one[1]!); this.options.workspace(id);
      await terminals.closeTerminal(id, one[2]!);
      if (!response.destroyed && !response.writableEnded) { http.headers(response); response.statusCode = 204; response.end(); }
      return true;
    }
    return false;
  }

  /**
   * Attaches an upgrade request of `GET …/terminals/:tid/socket` that the server has let in (its Host and Origin); false for any other path.
   * `login` answers the Set-Cookie value to send with the handshake, or throws for a request without a login.
   */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, login: () => string | null): boolean {
    const route = SOCKET.exec(url.pathname);
    if (route === null || request.method !== "GET") return false;
    try {
      const setCookie = login(), { http, terminals } = this.options;
      http.queries(url, ["cols", "rows"]);
      const cols = url.searchParams.get("cols"), rows = url.searchParams.get("rows");
      if ((cols === null) !== (rows === null)) throw http.error(400, "INVALID_INPUT", "Give both cols and rows, or neither");
      const size = cols === null || rows === null ? null : { cols: this.dimension(cols), rows: this.dimension(rows) };
      const id = sessionId(route[1]!); this.options.workspace(id);
      if (!terminals.has(id, route[2]!)) throw new TerminalError("TERMINAL_NOT_FOUND", "This conversation has no such terminal");
      if (socket.destroyed) return true;
      terminals.accept(request, socket, head, id, route[2]!, size, setCookie);
      return true;
    } catch (error) { throw this.fault(error); }
  }

  private dimension(value: string): number {
    if (!/^[1-9][0-9]{0,4}$/u.test(value) || !terminalSize(Number(value))) throw this.options.http.error(400, "INVALID_INPUT", "cols and rows are whole numbers from 1 to 65535");
    return Number(value);
  }
  /** A terminal's title: a line of text that is not only spaces and has no control characters, its ends trimmed. */
  private title(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "" || /\p{Cc}/u.test(value)) throw this.options.http.error(400, "INVALID_INPUT", "A terminal's title is a line of text");
    return value.trim();
  }
  private object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw this.options.http.error(400, "INVALID_INPUT", "Expected a JSON object");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !allowed.includes(key)) || required.some(key => !(key in item))) throw this.options.http.error(400, "INVALID_INPUT", "Unexpected or missing fields");
    return item;
  }
  private fault(error: unknown): unknown {
    if (!(error instanceof TerminalError)) return error;
    const status = error.code === "TERMINAL_NOT_FOUND" ? 404 : error.code === "TERMINALS_CLOSED" ? 503 : 502;
    return this.options.http.error(status, error.code, error.message);
  }
}
