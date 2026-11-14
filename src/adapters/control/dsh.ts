import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import type { ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, TurnText } from "../../contracts/control.js";
import type { ControlAttachment } from "../../contracts/content.js";
import { AcpControl, dshRelayCapabilities } from "./acp.js";

/** How long the session log is waited for to show the end of the Turn the prompt answered, after the prompt response. */
const LOG_SETTLE_MS = 2000;
const zstd = typeof (zlib as { zstdDecompress?: unknown }).zstdDecompress === "function" ? promisify((zlib as unknown as { zstdDecompress: (buffer: Buffer, done: (error: Error | null, result: Buffer) => void) => void }).zstdDecompress) : null;
type Counters = { input: number; output: number; cachedInput: number; cacheWrite: number; total: number };
/** One session-log entry as far as this driver reads it: its type, the turn it belongs to, a model request's usage and how a turn ended. */
interface LogEntry { readonly type: string; readonly turn: number | null; readonly usage: Counters | null; readonly ended: string | null }
/** dsh's ACP reports a turn that ended in these as `end_turn`; its log says how it really ended. */
const DSH_FAILURES: Readonly<Record<string, { readonly code: string; readonly message: string }>> = {
  error: { code: "MODEL_REQUEST_FAILED", message: "dsh 这一轮出错结束了，原因记在 dsh 的会话日志里。" },
  blocked: { code: "NATIVE_TURN_BLOCKED", message: "dsh 拦下了这一轮，没有做完。" },
  aborted: { code: "NATIVE_TURN_ABORTED", message: "dsh 中止了这一轮，没有做完。" },
};

/** dsh-session-persistence-jsonl `encodeSegment`: one path segment, every character outside [A-Za-z0-9._-] written ~XXXX. */
function encodeSegment(raw: string): string {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i), ch = String.fromCharCode(code);
    out += ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch) ? ch : "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}
/** dsh-session-persistence-jsonl `projectKey`: the readable directory of a project path (separators as one dash, the rest as encodeSegment). */
function projectKey(cwd: string): string {
  let readable = "", run = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i), ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") { if (!run) readable += "-"; run = true; }
    else if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) { readable += ch; run = false; }
    else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); run = false; }
  }
  return "--" + (readable.replace(/^-+/u, "") || "root").slice(0, 251) + "--";
}
function amount(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }

/**
 * DeepSeek Harness (`dsh --profile acp`) on the generic ACP driver, with the Turn's usage read back from its own session log. Its ACP
 * reports only the context's occupancy (dsh-acp `usageUpdate`) and its prompt result carries no usage, but every model request of a Turn is
 * written to the session's log as an `assistant/message` entry with `usage {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 * totalTokens}` under the turn number of its `turn/start` (dsh 0.2.1-rc.5; DeepSeek's Anthropic-format API: the input leaves out the cache,
 * the output holds the thinking). The log is `<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v<N>.jsonl[.zstd]`
 * (dsh-session-persistence-jsonl); it is only read, after the prompt answered, and the Turn's numbers are the sum of the requests of the
 * turns it added. A log that cannot be found or read gives no numbers (the Turn's usage stays as dsh reported it, the context alone). The log also says
 * how the last turn ended, which its ACP does not (an error, blocked or aborted turn arrives as end_turn).
 * Requests of a subagent run in a session of its own and are not in this sum.
 */
export class DshControl extends AcpControl {
  /** The highest turn number each session's log held after this connection's last read; absent before the first read. */
  private readonly turns = new Map<string, number>();
  constructor(private readonly dshLaunch: ControlLaunch, private readonly dshOptions: ControlOptions) { super(dshLaunch, dshOptions, dshRelayCapabilities); }
  private get sessionRoot(): string {
    const env = { ...this.dshOptions.env, ...this.dshLaunch.env };
    return join(env.DSH_HOME || join(env.HOME || homedir(), ".dsh"), "sessions");
  }
  /** The session's newest log generation: under its project's directory, else under any project directory that holds the session. */
  /** Each session's log once found (the search through every project directory is done once). */
  private readonly paths = new Map<string, string>();
  private async logPath(id: string, cwd: string): Promise<string | null> {
    const known = this.paths.get(id);
    if (known !== undefined) return known;
    const found = await this.findLog(id, cwd);
    if (found !== null) this.paths.set(id, found);
    return found;
  }
  private async findLog(id: string, cwd: string): Promise<string | null> {
    const root = this.sessionRoot, segment = encodeSegment(id);
    const newest = async (dir: string): Promise<string | null> => {
      let names: string[];
      try { names = await readdir(dir); } catch { return null; }
      const ranked = names.flatMap(name => { const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/u.exec(name); return match ? [{ name, version: Number(match[1] ?? 0) }] : []; }).sort((a, b) => b.version - a.version);
      return ranked[0] === undefined ? null : join(dir, ranked[0].name);
    };
    const direct = await newest(join(root, projectKey(cwd), segment));
    if (direct !== null) return direct;
    let projects: string[];
    try { projects = await readdir(root); } catch { return null; }
    for (const project of projects) { const found = await newest(join(root, project, segment)); if (found !== null) return found; }
    return null;
  }
  /** The log's entries, or null when it cannot be read whole (absent, still being written, or in a form this driver does not know). */
  private async entries(path: string): Promise<readonly LogEntry[] | null> {
    try {
      const raw = await readFile(path);
      if (path.endsWith(".zstd") && zstd === null) return null;
      const text = (path.endsWith(".zstd") ? await zstd!(raw) : raw).toString("utf8");
      return text.split("\n").filter(line => line.trim()).map(line => {
        const row = JSON.parse(line) as { type?: unknown; data?: { turn?: unknown; usage?: Record<string, unknown>; reason?: unknown } };
        const usage = row.data?.usage, reason = row.data?.reason;
        const kind = typeof reason === "string" ? reason : reason !== null && typeof reason === "object" && typeof (reason as { kind?: unknown }).kind === "string" ? (reason as { kind: string }).kind : null;
        return { type: typeof row.type === "string" ? row.type : "", turn: typeof row.data?.turn === "number" ? row.data.turn : null,
          usage: usage !== null && typeof usage === "object" ? { input: amount(usage.inputTokens), output: amount(usage.outputTokens), cachedInput: amount(usage.cacheReadTokens), cacheWrite: amount(usage.cacheWriteTokens), total: amount(usage.totalTokens) } : null,
          ended: row.type === "turn/end" ? kind : null };
      });
    } catch { return null; }
  }
  private static lastTurn(entries: readonly LogEntry[]): number { return entries.reduce((high, entry) => entry.type === "turn/start" && entry.turn !== null ? Math.max(high, entry.turn) : high, 0); }
  /** The Turn's usage and how its last turn ended: from the turns the log gained after `before`, once the last of them ended (or the wait is over). */
  private async turnOutcome(id: string, cwd: string, before: number): Promise<{ readonly usage: Counters | null; readonly ended: string | null } | null> {
    const path = await this.logPath(id, cwd);
    if (path === null) return null;
    let entries: readonly LogEntry[] | null = null;
    for (const deadline = Date.now() + LOG_SETTLE_MS; ;) {
      entries = await this.entries(path);
      const last = entries === null ? 0 : DshControl.lastTurn(entries);
      if (entries !== null && last > before && entries.some(entry => entry.type === "turn/end" && entry.turn === last)) break;
      if (Date.now() > deadline) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (entries === null) return null;
    const last = DshControl.lastTurn(entries);
    this.turns.set(id, last);
    const ended = last > before ? entries.find(entry => entry.type === "turn/end" && entry.turn === last)?.ended ?? null : null;
    const requests = entries.filter(entry => entry.type === "assistant/message" && entry.turn !== null && entry.turn > before && entry.usage !== null);
    const usage = requests.length === 0 ? null : requests.reduce<Counters>((sum, entry) => ({ input: sum.input + entry.usage!.input, output: sum.output + entry.usage!.output,
      cachedInput: sum.cachedInput + entry.usage!.cachedInput, cacheWrite: sum.cacheWrite + entry.usage!.cacheWrite, total: sum.total + entry.usage!.total }), { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0 });
    return { usage, ended };
  }
  override async startText(id: NativeConversationId, turn: TurnText, onEvent: (event: ControlEvent) => void, attachments: readonly ControlAttachment[] = []): Promise<ControlRun> {
    const cwd = this.opened?.cwd ?? null;
    // Where the log stood before this prompt: known from this connection's last read, else read now (a session with no log yet is at 0).
    let before: number | null = this.turns.get(id) ?? null;
    if (before === null && cwd !== null) {
      const path = await this.logPath(id, cwd);
      const entries = path === null ? [] : await this.entries(path);
      before = entries === null ? null : DshControl.lastTurn(entries);
    }
    const run = await super.startText(id, turn, onEvent, attachments);
    return { ...run, result: run.result.then(async result => {
      // The Hub's clear and a refused relay Turn sent nothing to dsh.
      if (before === null || cwd === null || result.input === "not_recorded") return result;
      const outcome = await this.turnOutcome(id, cwd, before);
      if (outcome?.usage) onEvent({ type: "usage", usage: { turn: outcome.usage } });
      const failure = result.status === "completed" && outcome?.ended ? DSH_FAILURES[outcome.ended] : undefined;
      return failure === undefined ? result : { ...result, status: "failed", reason: "native_error", error: failure };
    }) };
  }
}
