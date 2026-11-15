import { ControlError } from "../../../infrastructure/control/json-rpc-process.js";

export type Row = Record<string, unknown>;
/** One exchange with the server, as a recorder sees it (the replay fixtures are made of these). */
export type Exchange =
  | { readonly kind: "http"; readonly method: string; readonly path: string; readonly body?: unknown; readonly status: number; readonly response: unknown }
  | { readonly kind: "event"; readonly event: unknown };
/** OpenCode's own words of a refusal (`_tag`, `message`), bounded; its private text, which no message of the Hub quotes. */
const SAID_BYTES = 2048;
/** Heartbeats come every 10–15 s (T3 Code's reading of 2.x); a stream silent this long is stuck, not idle. */
export const SILENT_STREAM_MS = 45_000;
const FIELD = /^[A-Za-z0-9_.:/-]{1,64}$/u;

function bounded(text: string): string { return [...text.replace(/[\0-\x1f\x7f]+/gu, " ")].slice(0, SAID_BYTES).join(""); }
/**
 * A refusal of the server (REMOTE_ERROR): `remoteCode` is the HTTP status, `remoteFields._tag` the error's tag (`ConflictError`, `SessionNotFoundError`, …) with its
 * short fields (`field`, `kind`), `remoteMessage` its message, bounded. What OpenCode said never enters the error's own message.
 */
function refusal(method: string, path: string, status: number, body: unknown): ControlError {
  const row = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Row : {};
  const fields: Record<string, string> = {};
  for (const key of ["_tag", "field", "kind", "resource"]) { const value = row[key]; if (typeof value === "string" && FIELD.test(value)) fields[key] = value; }
  const message = typeof row.message === "string" ? bounded(row.message) : undefined;
  const operation = method + " " + path.replace(/\/(ses|msg|per|frm|sh)_[A-Za-z0-9_:.-]+/gu, "/$1_…").replace(/\?.*$/u, "");
  return new ControlError("REMOTE_ERROR", `OpenCode refused ${operation} (${status}${fields._tag ? " " + fields._tag : ""})`, undefined,
    { code: status, ...(message === undefined ? {} : { message }), ...(Object.keys(fields).length ? { fields } : {}) });
}
/** The tag of a refusal, when it is one. */
export function tagOf(error: unknown): string | undefined { return error instanceof ControlError && error.code === "REMOTE_ERROR" ? error.remoteFields?._tag : undefined; }
export function statusOf(error: unknown): number | undefined { return error instanceof ControlError && error.code === "REMOTE_ERROR" ? error.remoteCode : undefined; }
/**
 * What the server answers only before it takes anything in (T3 Code's CLEAR_PROMPT_REJECTIONS, v2/adapter.ts:637-644): a refusal of a bad request, a conflicting
 * identity, a failed login, an unknown session, location, command or skill. Anything else may still have admitted the input.
 */
const CLEAR_REFUSALS = new Set(["InvalidRequestError", "ConflictError", "UnauthorizedError", "SessionNotFoundError", "LocationNotFoundError", "CommandNotFoundError", "SkillNotFoundError"]);
export function clearlyRefused(error: unknown): boolean {
  const status = statusOf(error), tag = tagOf(error);
  return status !== undefined && (tag !== undefined ? CLEAR_REFUSALS.has(tag) : status >= 400 && status < 500 && status !== 408 && status !== 429);
}

export interface EventStream { close(): void }
export interface StreamHandlers {
  event(event: Row): void;
  /** A frame that is not JSON: said once, never a failure. */
  fault(): void;
  /** The stream ended, failed or fell silent; it is closed. */
  failure(error: Error): void;
}

/**
 * A thin client of OpenCode 2's HttpApi (`/api/...` under `/openapi.json`), written against the installed server's document: HTTP Basic with the user
 * `opencode` in UTF-8 (T3 Code, v2/OpenCode2Client.ts:201-205), JSON both ways, a deadline per request, and the event stream as SSE. Nothing here
 * keeps state between calls; a recorder (`tap`) sees every exchange.
 */
export class OpenCodeApi {
  private readonly authorization: string;
  constructor(readonly base: string, password: string, private readonly timeoutMs: number, private readonly tap?: (exchange: Exchange) => void) {
    this.authorization = "Basic " + Buffer.from("opencode:" + password, "utf8").toString("base64");
  }
  /** `location[directory]` and the other query values, deepObject style. */
  static query(values: Readonly<Record<string, string | number | undefined>>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
    const text = params.toString();
    return text ? "?" + text : "";
  }
  /** One request; resolves with the JSON body (null for none), rejects with REMOTE_ERROR for a refusal, NATIVE_CONNECTION_LOST or REQUEST_TIMEOUT otherwise. */
  async call(method: string, path: string, body?: unknown, timeoutMs: number | null = this.timeoutMs): Promise<unknown> {
    const abort = new AbortController(), timer = timeoutMs === null ? undefined : setTimeout(() => abort.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.base + path, { method, signal: abort.signal, headers: { authorization: this.authorization, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      clearTimeout(timer);
      throw abort.signal.aborted ? new ControlError("REQUEST_TIMEOUT", `${method} exceeded its deadline`) : new ControlError("NATIVE_CONNECTION_LOST", "OpenCode server did not answer" + (error instanceof Error && error.name ? " (" + error.name + ")" : ""));
    }
    let text: string;
    try { text = await response.text(); }
    catch { clearTimeout(timer); throw abort.signal.aborted ? new ControlError("REQUEST_TIMEOUT", `${method} exceeded its deadline`) : new ControlError("NATIVE_CONNECTION_LOST", "OpenCode server's answer broke off"); }
    clearTimeout(timer);
    let parsed: unknown = null;
    if (text !== "") {
      try { parsed = JSON.parse(text); }
      catch { if (response.ok) { this.tap?.({ kind: "http", method, path, ...(body === undefined ? {} : { body }), status: response.status, response: null }); throw new ControlError("INVALID_PROTOCOL", "OpenCode answered with something that is not JSON"); } }
    }
    this.tap?.({ kind: "http", method, path, ...(body === undefined ? {} : { body }), status: response.status, response: parsed });
    if (!response.ok) throw refusal(method, path, response.status, parsed);
    return parsed;
  }
  /** `call` for an answer shaped `{data: …}`: its data. */
  async data(method: string, path: string, body?: unknown, timeoutMs?: number | null): Promise<unknown> {
    const value = await this.call(method, path, body, timeoutMs);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row).data : undefined;
  }
  /**
   * Subscribes to `/api/event` (every location of this server). Resolves once the server accepted the subscription (its headers came), so that what is
   * done after it is seen; rejects when it refused. The stream is volatile by contract (no replay): a gap is the owner's to reconcile.
   */
  async subscribe(handlers: StreamHandlers, maxFrameBytes: number, silentMs = SILENT_STREAM_MS): Promise<EventStream> {
    const abort = new AbortController();
    let response: Response;
    const accepted = setTimeout(() => abort.abort(), this.timeoutMs);
    try { response = await fetch(this.base + "/api/event", { signal: abort.signal, headers: { authorization: this.authorization, accept: "text/event-stream" } }); }
    catch { clearTimeout(accepted); throw new ControlError(abort.signal.aborted ? "REQUEST_TIMEOUT" : "NATIVE_CONNECTION_LOST", "OpenCode did not open its event stream"); }
    clearTimeout(accepted);
    if (!response.ok || response.body === null) { const said = await response.text().catch(() => ""); let body: unknown = null; try { body = JSON.parse(said); } catch { /* none */ } throw refusal("GET", "/api/event", response.status, body); }
    let closed = false, silence: ReturnType<typeof setTimeout> | undefined;
    const end = (error: Error | null) => { if (closed) return; closed = true; clearTimeout(silence); abort.abort(); if (error) handlers.failure(error); };
    const awake = () => { clearTimeout(silence); silence = setTimeout(() => end(new ControlError("NATIVE_STREAM_SILENT", "OpenCode's event stream fell silent")), silentMs); };
    awake();
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8");
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { end(new ControlError("NATIVE_STREAM_ENDED", "OpenCode's event stream ended")); return; }
          awake();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > maxFrameBytes) { end(new ControlError("FRAME_LIMIT", "an OpenCode event exceeds its byte limit")); return; }
          for (let at = frameEnd(buffer); at !== null && !closed; at = frameEnd(buffer)) {
            const frame = buffer.slice(0, at.start); buffer = buffer.slice(at.next);
            const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(line.startsWith("data: ") ? 6 : 5)).join("\n");
            if (data === "") continue;
            let event: unknown;
            try { event = JSON.parse(data); } catch { handlers.fault(); continue; }
            if (event === null || typeof event !== "object" || Array.isArray(event)) { handlers.fault(); continue; }
            this.tap?.({ kind: "event", event });
            handlers.event(event as Row);
          }
        }
      } catch (error) { end(closed ? null : error instanceof ControlError ? error : new ControlError("NATIVE_STREAM_ENDED", "OpenCode's event stream broke off")); }
    })();
    return { close: () => end(null) };
  }
}
/** Where the first SSE frame of `text` ends (a blank line), and where the next begins. */
function frameEnd(text: string): { readonly start: number; readonly next: number } | null {
  const lf = text.indexOf("\n\n"), crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  return crlf >= 0 && (lf < 0 || crlf < lf) ? { start: crlf, next: crlf + 4 } : { start: lf, next: lf + 2 };
}
