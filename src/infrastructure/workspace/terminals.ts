import { randomBytes } from "node:crypto";
import { mkdir, open, rm, rmdir, type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { TerminalExitView, TerminalView } from "../../contracts/terminal.js";
import { WorkspaceTerminal, type TerminalSize } from "./terminal.js";

/**
 * Output handed to a page's socket and not yet written out. Past the high mark the socket is no longer sent the shell's output as it comes:
 * it is read the rest from the terminal's history file, a piece at a time, each once it is below the low mark again. The shell never waits
 * for a page, nothing is dropped, and what a slow page has not read yet stays on disk, not in memory.
 */
const HIGH_WATER_BYTES = 1024 * 1024, LOW_WATER_BYTES = 256 * 1024;
/** How much of a history file is read for one frame. */
const HISTORY_READ_BYTES = 256 * 1024;
/**
 * Output not yet written to the history file: past the high mark the shell's output is no longer read (the shell then waits on its own
 * writes) until the file has taken it down to the low mark. A write that fails is tried again after a second, until it succeeds or the
 * terminal is closed: what the shell printed is never skipped.
 */
const QUEUE_HIGH_BYTES = 1024 * 1024, QUEUE_LOW_BYTES = 256 * 1024, WRITE_RETRY_MS = 1000;
/** How long the sockets of ended shells have to finish their closing handshake when the Gateway closes, before they are cut. */
const CLOSE_WAIT_MS = 1000;
/** The largest size a pseudoterminal has (its rows and columns are 16-bit). */
export const TERMINAL_MAX_SIZE = 65535;
/** The frame that tells a page everything the shell had printed when it attached has been sent; live output follows. */
const REPLAYED_FRAME = JSON.stringify({ type: "replayed" });

/** What a terminal starts with: the shell, the workspace it starts in, its environment and its first size. */
export interface TerminalStart { readonly shell: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly size: TerminalSize }

export class TerminalError extends Error {
  constructor(readonly code: "TERMINAL_NOT_FOUND" | "TERMINAL_START_FAILED" | "TERMINALS_CLOSED", message: string) { super(message); this.name = "TerminalError"; }
}

/** A page's socket attached to a terminal. */
interface Attachment {
  readonly socket: WebSocket;
  /** The history's bytes are decoded as one stream for this socket: a character cut between two reads is sent whole with the second. */
  readonly decoder: TextDecoder;
  /** How much the shell had printed when the socket attached: `replayed` is sent once that much has been. */
  readonly mark: number;
  /** Bytes of the history sent so far, from its start. */
  sent: number;
  /** Bytes of frames handed to the socket and not yet written out. */
  pending: number;
  /** Sent the shell's output as it comes (it has been sent all of it before); otherwise read it from the history by its pump. */
  live: boolean;
  replayed: boolean;
  /** Told the exit, or closed: nothing more is sent. */
  done: boolean;
  pumping: boolean;
  /** Wakes the pump waiting for the socket to write its frames out, or to close. */
  wake: (() => void) | null;
}

interface Entry {
  readonly id: string;
  readonly sessionId: string;
  title: string;
  readonly createdAt: number;
  readonly file: string;
  readonly history: FileHandle;
  terminal: WorkspaceTerminal | null;
  exited: TerminalExitView | null;
  /** Bytes of output given to the history, and bytes of it written to the file. */
  appended: number;
  durable: number;
  readonly queue: Buffer[];
  queued: number;
  flushing: Promise<void> | null;
  paused: boolean;
  readonly attached: Set<Attachment>;
  /** Woken when the file takes more of the history, or the terminal is closed. */
  readonly waiting: Set<() => void>;
  ending: Promise<void> | null;
  /** Closed: its history is being deleted, its pumps stop. */
  gone: boolean;
}

/**
 * The terminals of conversations' workspaces (docs/contracts/public-api.md, "对话的终端"): a login shell each, which lives until it is
 * closed (or its conversation is deleted, or the Gateway closes), whatever sockets come and go. Everything it prints is appended to a
 * history file of its own under `root`, with no ceiling; a socket that attaches is sent the history first, then the live output, and
 * any number of sockets may be attached at once. A socket's `input` and `resize` frames go to the shell; the latest resize wins.
 */
export class Terminals {
  private readonly server: WebSocketServer;
  private readonly cookies = new WeakMap<IncomingMessage, string>();
  /** Every terminal open, in the order they were opened. */
  private readonly all = new Map<string, Entry>();
  private readonly sockets = new Set<WebSocket>();
  private readonly opening = new Set<Promise<unknown>>();
  /** Terminals being closed: out of the list already, awaited by `close()` all the same. */
  private readonly ending = new Set<Promise<void>>();
  private closing: Promise<void> | null = null;
  constructor(private readonly options: { readonly root: string; readonly maxPayload: number; readonly report: (problem: string) => void }) {
    this.server = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: options.maxPayload });
    // The login's cookie goes out again with the handshake, as it does with any answer to a logged-in request.
    this.server.on("headers", (headers, request) => { const cookie = this.cookies.get(request); if (cookie !== undefined) headers.push("Set-Cookie: " + cookie); });
  }
  /** Removes what a previous Gateway left: its shells ended with it, so their histories have nothing to attach to. Called once the data directory is owned. */
  async prepare(): Promise<void> { await rm(this.options.root, { recursive: true, force: true }); }
  /** A conversation's terminals, the oldest first. */
  list(sessionId: string): readonly TerminalView[] { return [...this.all.values()].filter(entry => entry.sessionId === sessionId).map(view); }
  has(sessionId: string, id: string): boolean { return this.all.get(id)?.sessionId === sessionId; }

  /** Starts a shell; its title is `title`, or "终端 N" with the smallest N no terminal of the conversation is called. */
  open(sessionId: string, start: TerminalStart, title?: string): Promise<TerminalView> {
    const opened = this.start(sessionId, start, title);
    this.opening.add(opened);
    void opened.then(() => this.opening.delete(opened), () => this.opening.delete(opened));
    return opened;
  }
  private async start(sessionId: string, start: TerminalStart, title: string | undefined): Promise<TerminalView> {
    if (this.closing !== null) throw new TerminalError("TERMINALS_CLOSED", "The Gateway is closing");
    const id = "terminal-" + randomBytes(12).toString("hex"), folder = join(this.options.root, sessionId), file = join(folder, id + ".log");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const history = await open(file, "wx+", 0o600);
    const entry: Entry = { id, sessionId, title: "", createdAt: Date.now(), file, history, terminal: null, exited: null, appended: 0, durable: 0, queue: [], queued: 0,
      flushing: null, paused: false, attached: new Set(), waiting: new Set(), ending: null, gone: false };
    try {
      entry.terminal = await WorkspaceTerminal.start({ ...start, output: text => this.output(entry, text), exit: exit => this.exited(entry, exit) });
    } catch (error) {
      await history.close().catch(() => undefined); await rm(file, { force: true });
      throw new TerminalError("TERMINAL_START_FAILED", "The shell did not start (" + (error instanceof Error ? error.message : String(error)).slice(0, 200) + ")");
    }
    if (entry.paused) entry.terminal.pause();
    entry.title = title ?? this.nextTitle(sessionId);
    this.all.set(id, entry);
    if (this.closing !== null) { await this.end(entry); throw new TerminalError("TERMINALS_CLOSED", "The Gateway is closing"); }
    return view(entry);
  }
  private nextTitle(sessionId: string): string {
    const taken = new Set(this.list(sessionId).map(item => item.title));
    for (let number = 1; ; number++) if (!taken.has("终端 " + number)) return "终端 " + number;
  }
  rename(sessionId: string, id: string, title: string): TerminalView {
    const entry = this.find(sessionId, id);
    entry.title = title;
    return view(entry);
  }
  /** Closes a terminal: its shell is ended (SIGTERM and a hang-up, SIGKILL after a second), its sockets are told the exit and closed, and its history is deleted. */
  closeTerminal(sessionId: string, id: string): Promise<void> { return this.end(this.find(sessionId, id)); }
  /** Closes every terminal of a conversation (it was deleted); its folder of histories goes with them. Never fails: what goes wrong is reported. */
  async closeConversation(sessionId: string): Promise<void> {
    const entries = [...this.all.values()].filter(entry => entry.sessionId === sessionId);
    if (entries.length === 0) return;
    await Promise.allSettled(entries.map(entry => this.end(entry)));
    await rmdir(join(this.options.root, sessionId)).catch(() => undefined);
  }
  private find(sessionId: string, id: string): Entry {
    const entry = this.all.get(id);
    if (entry === undefined || entry.sessionId !== sessionId) throw new TerminalError("TERMINAL_NOT_FOUND", "This conversation has no such terminal");
    return entry;
  }

  /**
   * Completes the handshake of an upgrade request the caller has let in for a terminal it found (`has`), and attaches the socket: it is
   * sent the history, then `replayed`, then the live output, or the exit of a shell that ended. `size`, when given, is applied as a resize.
   */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string, id: string, size: TerminalSize | null, setCookie: string | null): void {
    const entry = this.all.get(id);
    if (this.closing !== null || entry === undefined || entry.sessionId !== sessionId) { socket.destroy(); return; }
    if (setCookie !== null) this.cookies.set(request, setCookie);
    // The handshake completes, and the socket is counted, before this returns: `close()` sees every socket it let in.
    this.server.handleUpgrade(request, socket, head, ws => this.attach(entry, ws, size));
  }
  private attach(entry: Entry, socket: WebSocket, size: TerminalSize | null): void {
    this.sockets.add(socket);
    const attachment: Attachment = { socket, decoder: new TextDecoder("utf-8"), mark: entry.appended, sent: 0, pending: 0, live: false, replayed: false, done: false, pumping: false, wake: null };
    entry.attached.add(attachment);
    if (size !== null) entry.terminal?.resize(size);
    socket.on("message", (data, binary) => { if (!binary && entry.terminal !== null && !entry.gone) receive(entry.terminal, data); });
    socket.on("error", () => { /* the close that follows detaches it */ });
    // A socket that closes only detaches: the shell goes on.
    socket.once("close", () => {
      attachment.done = true; attachment.live = false; entry.attached.delete(attachment); this.sockets.delete(socket);
      attachment.wake?.();
    });
    this.pump(entry, attachment);
  }

  /** The shell's output: appended to the history, and sent at once to every socket that has been sent all of it before and keeps up. */
  private output(entry: Entry, text: string): void {
    const bytes = Buffer.from(text, "utf8");
    entry.appended += bytes.length;
    this.append(entry, bytes);
    for (const attachment of entry.attached) {
      if (!attachment.live) continue;
      // A socket that does not keep up reads the rest from the history, as fast as it writes it out.
      if (attachment.pending > HIGH_WATER_BYTES) { attachment.live = false; this.pump(entry, attachment); continue; }
      attachment.sent += bytes.length;
      this.frame(attachment, text);
    }
  }
  private frame(attachment: Attachment, text: string): void {
    const frame = JSON.stringify({ type: "output", data: text }), bytes = Buffer.byteLength(frame);
    attachment.pending += bytes;
    attachment.socket.send(frame, () => { attachment.pending -= bytes; if (attachment.pending <= LOW_WATER_BYTES) attachment.wake?.(); });
  }
  private exited(entry: Entry, exit: TerminalExitView): void {
    entry.exited = exit;
    // A socket sent all the output is told now; one still reading the history is told once it has read it all.
    for (const attachment of entry.attached) if (attachment.live) this.finish(attachment, exit);
  }
  private finish(attachment: Attachment, exit: TerminalExitView): void {
    if (attachment.done) return;
    attachment.done = true; attachment.live = false;
    if (attachment.socket.readyState !== WebSocket.OPEN) return;
    attachment.socket.send(JSON.stringify({ type: "exit", code: exit.code, signal: exit.signal }));
    attachment.socket.close(1000);
  }

  /**
   * Sends a socket what it has not been sent of the history, read from the file a piece at a time, each piece once the socket has written
   * out what it was handed before; when it has been sent all the shell printed, it is sent the output as it comes (or the exit). One pump
   * per socket at a time.
   */
  private pump(entry: Entry, attachment: Attachment): void {
    if (attachment.pumping || attachment.done) return;
    attachment.pumping = true;
    void (async () => {
      try {
        while (!attachment.done && !entry.gone) {
          if (!attachment.replayed && attachment.sent >= attachment.mark) { attachment.replayed = true; attachment.socket.send(REPLAYED_FRAME); }
          if (attachment.pending > LOW_WATER_BYTES) { await new Promise<void>(done => { attachment.wake = () => { attachment.wake = null; done(); }; }); continue; }
          // Up to what the file holds, and, before `replayed`, not past what the shell had printed when the socket attached.
          const limit = attachment.replayed ? entry.durable : Math.min(entry.durable, attachment.mark);
          if (attachment.sent < limit) {
            const length = Math.min(HISTORY_READ_BYTES, limit - attachment.sent), buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await entry.history.read(buffer, 0, length, attachment.sent);
            if (attachment.done || entry.gone) return;
            if (bytesRead === 0) throw new Error("the history file is shorter than what was written to it");
            attachment.sent += bytesRead;
            const text = attachment.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
            if (text !== "") this.frame(attachment, text);
            continue;
          }
          // What the shell printed last is still being written to the file.
          if (attachment.sent < entry.appended) { await new Promise<void>(done => entry.waiting.add(done)); continue; }
          // Sent all of it: from here on the output as it comes, or the exit.
          if (entry.exited !== null) this.finish(attachment, entry.exited); else attachment.live = true;
          return;
        }
      } catch (error) {
        if (attachment.done || entry.gone) return;
        this.options.report("TERMINAL_HISTORY_UNREADABLE (" + (error instanceof Error ? error.message : String(error)).slice(0, 200) + ")");
        attachment.done = true;
        attachment.socket.close(1011, "TERMINAL_HISTORY_UNREADABLE");
      } finally { attachment.pumping = false; }
    })();
  }

  /** Queues output for the history file; past the queue's high mark the shell's output is no longer read until the file catches up. */
  private append(entry: Entry, bytes: Buffer): void {
    if (entry.gone) return;
    entry.queue.push(bytes); entry.queued += bytes.length;
    if (!entry.paused && entry.queued > QUEUE_HIGH_BYTES) { entry.paused = true; entry.terminal?.pause(); }
    // The queue is not empty and the terminal is not closed: the flush waits on its first write before it can end, so it is set first.
    if (entry.flushing === null) entry.flushing = this.flush(entry);
  }
  /** Writes the queue to the file in order, as one write of all that is queued at a time; ends when the queue is empty. */
  private async flush(entry: Entry): Promise<void> {
    let failing = false;
    try {
      while (entry.queue.length > 0 && !entry.gone) {
        const count = entry.queue.length, chunk = count === 1 ? entry.queue[0]! : Buffer.concat(entry.queue.slice(0, count));
        try { await writeAt(entry.history, chunk, entry.durable); }
        catch (error) {
          if (entry.gone) return;
          if (!failing) this.options.report("TERMINAL_HISTORY_WRITE_FAILED (" + (error instanceof Error ? error.message : String(error)).slice(0, 200) + "; trying again every second)");
          failing = true;
          await new Promise(done => setTimeout(done, WRITE_RETRY_MS));
          continue;
        }
        failing = false;
        entry.queue.splice(0, count); entry.queued -= chunk.length; entry.durable += chunk.length;
        if (entry.paused && entry.queued <= QUEUE_LOW_BYTES) { entry.paused = false; entry.terminal?.resume(); }
        wakeAll(entry.waiting);
      }
    } finally { entry.flushing = null; }
  }

  /** Ends a terminal once: out of the list at once, its shell ended, its sockets told and closed, its history deleted. */
  private end(entry: Entry): Promise<void> {
    if (entry.ending !== null) return entry.ending;
    const ending = entry.ending = (async () => {
      this.all.delete(entry.id);
      const terminal = entry.terminal;
      if (terminal !== null && !await terminal.end()) this.options.report("TERMINAL_NOT_ENDED (shell " + terminal.pid + " was still there after SIGKILL)");
      entry.gone = true;
      // A socket still reading the history is told the exit without the rest of it: the user closed the terminal.
      for (const attachment of [...entry.attached]) { this.finish(attachment, entry.exited ?? { code: null, signal: null }); attachment.wake?.(); }
      wakeAll(entry.waiting);
      await entry.flushing;
      await entry.history.close().catch(() => undefined);
      await rm(entry.file, { force: true }).catch((error: unknown) => {
        this.options.report("TERMINAL_HISTORY_NOT_DELETED (" + (error instanceof Error ? error.message : String(error)).slice(0, 200) + ")");
      });
    })();
    this.ending.add(ending);
    void ending.then(() => this.ending.delete(ending), () => this.ending.delete(ending));
    return ending;
  }

  /** Ends every shell, closes every socket and deletes every history; no terminal is opened or attached after it is called. Ends once all of it is done. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.opening]);
      await Promise.allSettled([...[...this.all.values()].map(entry => this.end(entry)), ...this.ending]);
      // An ended shell's sockets were told its exit and closed; one still open a second later is cut.
      const sockets = [...this.sockets];
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(sockets.map(socket => new Promise<void>(done => { if (socket.readyState === WebSocket.CLOSED) done(); else socket.once("close", () => done()); }))),
        new Promise(done => { timer = setTimeout(done, CLOSE_WAIT_MS); })]);
      clearTimeout(timer);
      for (const socket of sockets) socket.terminate();
      this.server.close();
    })();
    return this.closing;
  }
}

function view(entry: Entry): TerminalView {
  return { id: entry.id, title: entry.title, createdAt: entry.createdAt, ...(entry.exited === null ? {} : { exited: entry.exited }) };
}
function wakeAll(waiting: Set<() => void>): void {
  const all = [...waiting]; waiting.clear();
  for (const wake of all) wake();
}
/** Writes all of `bytes` at `position`. */
async function writeAt(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    offset += bytesWritten;
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
