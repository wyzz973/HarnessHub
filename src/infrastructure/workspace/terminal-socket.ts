import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { WorkspaceTerminal, type TerminalSize } from "./terminal.js";

/**
 * Output frames handed to a page's socket and not yet written out: past the high mark the shell's output is no longer read
 * (the shell then waits on its own writes), below the low mark it is read again. Nothing is dropped.
 */
const HIGH_WATER_BYTES = 1024 * 1024, LOW_WATER_BYTES = 256 * 1024;
/** How long the sockets of ended shells have to finish their closing handshake when the Gateway closes, before they are cut. */
const CLOSE_WAIT_MS = 1000;
/** The largest size a pseudoterminal has (its rows and columns are 16-bit). */
export const TERMINAL_MAX_SIZE = 65535;

/** What a terminal starts with: the shell, the workspace it starts in, its environment and its first size. */
export interface TerminalStart { readonly shell: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly size: TerminalSize }

interface Connection { readonly socket: WebSocket; readonly started: Promise<WorkspaceTerminal | null>; readonly closed: Promise<void>; ended: Promise<void> | null }

/**
 * The terminals of conversations' workspaces, one shell per WebSocket (docs/contracts/public-api.md, "对话的终端"): the shell's
 * output goes out as `output` frames and its exit as one `exit` frame, after which the socket closes; the page's `input` and
 * `resize` frames go to the shell. A socket that closes hangs up on its shell, and `close()` ends every shell before it returns.
 */
export class TerminalSockets {
  private readonly server: WebSocketServer;
  private readonly cookies = new WeakMap<IncomingMessage, string>();
  private readonly open = new Set<Connection>();
  private closing: Promise<void> | null = null;
  constructor(private readonly options: { readonly maxPayload: number; readonly report: (problem: string) => void }) {
    this.server = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: options.maxPayload });
    // The login's cookie goes out again with the handshake, as it does with any answer to a logged-in request.
    this.server.on("headers", (headers, request) => { const cookie = this.cookies.get(request); if (cookie !== undefined) headers.push("Set-Cookie: " + cookie); });
  }
  /** Terminals open now, with those whose shells are still being ended. */
  get size(): number { return this.open.size; }
  /** Completes the handshake of an upgrade request the caller has let in, and starts its shell. */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer, start: TerminalStart, setCookie: string | null): void {
    if (this.closing !== null) { socket.destroy(); return; }
    if (setCookie !== null) this.cookies.set(request, setCookie);
    // The handshake completes, and the connection is counted, before this returns: `close()` sees every socket it let in.
    this.server.handleUpgrade(request, socket, head, ws => this.attach(ws, start));
  }
  private attach(socket: WebSocket, start: TerminalStart): void {
    let terminal: WorkspaceTerminal | null = null, pending = 0, paused = false;
    // Input that comes while the shell starts waits for it, in order.
    const early: RawData[] = [];
    const started = WorkspaceTerminal.start({ ...start,
      output: text => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const frame = JSON.stringify({ type: "output", data: text }), bytes = Buffer.byteLength(frame);
        pending += bytes;
        socket.send(frame, () => { pending -= bytes; if (paused && pending <= LOW_WATER_BYTES) { paused = false; terminal?.resume(); } });
        if (!paused && pending > HIGH_WATER_BYTES) { paused = true; terminal?.pause(); }
      },
      exit: code => { if (socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ type: "exit", code })); socket.close(1000); } } })
      .then(made => { terminal = made; for (const data of early.splice(0)) receive(made, data); return made; }, (error: unknown) => {
        this.options.report("TERMINAL_START_FAILED (" + (error instanceof Error ? error.message : String(error)).slice(0, 200) + ")");
        // A shell that never started has exited with nothing to tell.
        if (socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ type: "exit", code: null })); socket.close(1011, "TERMINAL_START_FAILED"); }
        return null;
      });
    const connection: Connection = { socket, started, closed: new Promise(done => socket.once("close", () => done())), ended: null };
    this.open.add(connection);
    socket.on("message", (data, binary) => { if (binary) return; if (terminal === null) early.push(data); else receive(terminal, data); });
    socket.on("error", () => { /* the close that follows ends the shell */ });
    socket.once("close", () => { void this.end(connection); });
  }
  /** Hangs up on a connection's shell (once its start has settled) and forgets the connection once the shell has ended. */
  private end(connection: Connection): Promise<void> {
    return connection.ended ??= (async () => {
      const terminal = await connection.started;
      if (terminal !== null && !await terminal.end()) this.options.report("TERMINAL_NOT_ENDED (shell " + terminal.pid + " was still there after SIGKILL)");
      this.open.delete(connection);
    })();
  }
  /** Ends every shell (each is hung up on, then killed) and closes every socket; no new terminal is accepted after it is called. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const all = [...this.open];
      // A shell that ends tells its page so (`exit`) and closes its socket; a socket still open a second later is cut.
      await Promise.all(all.map(connection => this.end(connection)));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(all.map(connection => connection.closed)), new Promise(done => { timer = setTimeout(done, CLOSE_WAIT_MS); })]);
      clearTimeout(timer);
      for (const connection of all) connection.socket.terminate();
      this.server.close();
    })();
    return this.closing;
  }
}

/** A page's frame: `input` is written to the shell, `resize` sets its size; anything else is ignored. */
function receive(terminal: WorkspaceTerminal, data: RawData): void {
  let message: unknown;
  try { message = JSON.parse((Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8")); } catch { return; }
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  const frame = message as Record<string, unknown>;
  if (frame.type === "input" && typeof frame.data === "string") terminal.write(frame.data);
  else if (frame.type === "resize" && terminalSize(frame.cols) && terminalSize(frame.rows)) terminal.resize({ cols: frame.cols, rows: frame.rows });
}
/** Whether a value is a row or column count a pseudoterminal can have. */
export function terminalSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= TERMINAL_MAX_SIZE;
}
