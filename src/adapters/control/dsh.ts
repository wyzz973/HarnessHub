import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import type { ControlEvent, ControlLaunch, ControlOptions, ControlRun, NativeConversationId, NativePlanEntry, NativeToolDetail, TurnText } from "../../contracts/control.js";
import type { ControlAttachment } from "../../contracts/content.js";
import { unifiedDiff } from "../../infrastructure/control/unified-diff.js";
import { AcpControl, dshRelayCapabilities } from "./acp.js";

/** How long the session log is waited for to show the end of the Turn the prompt answered, after the prompt response. */
const LOG_SETTLE_MS = 2000;
const zstd = typeof (zlib as { zstdDecompress?: unknown }).zstdDecompress === "function" ? promisify((zlib as unknown as { zstdDecompress: (buffer: Buffer, done: (error: Error | null, result: Buffer) => void) => void }).zstdDecompress) : null;
type Counters = { input: number; output: number; cachedInput: number; cacheWrite: number; total: number };
/**
 * One session-log entry as far as this driver reads it: its type, the turn it belongs to, a model request's usage, how a turn ended (and the code of
 * its error), and of a tool call or result what a file change needs: the call's id, name and arguments, the result's `isError` and `meta`.
 */
interface LogEntry {
  readonly type: string; readonly turn: number | null; readonly usage: Counters | null; readonly ended: string | null; readonly failure: string | null;
  readonly call: { readonly id: string; readonly name: string; readonly arguments: unknown } | null;
  readonly result: { readonly id: string; readonly failed: boolean; readonly meta: unknown } | null;
}
/** dsh's ACP reports a turn that ended in these as `end_turn` (an error one too up to 0.2.1; from 0.2.2 it refuses the prompt instead); its log says how it really ended. */
export const DSH_FAILURES: Readonly<Record<string, { readonly code: string; readonly message: string }>> = {
  error: { code: "MODEL_REQUEST_FAILED", message: "dsh 这一轮出错结束了，原因记在 dsh 的会话日志里。" },
  blocked: { code: "NATIVE_TURN_BLOCKED", message: "dsh 拦下了这一轮，没有做完。" },
  aborted: { code: "NATIVE_TURN_ABORTED", message: "dsh 中止了这一轮，没有做完。" },
};
/** The codes of dsh's model failures (dsh-llm, dsh-llm-deepseek `failure.code`) the Hub has words for; its own message is private text and never quoted. */
export const DSH_ERROR_CODES: Readonly<Record<string, { readonly code: string; readonly message: string }>> = {
  TRANSPORT: { code: "NATIVE_CONNECTION_FAILED", message: "dsh 连不上它的模型服务，这一轮没有做完。请检查网络或它本机的模型配置。" },
  RATE_LIMIT: { code: "NATIVE_RATE_LIMITED", message: "dsh 的模型服务限流了，这一轮没有做完。请稍后再试，或换一个模型。" },
  AUTH: { code: "NATIVE_AUTH_REQUIRED", message: "dsh 的登录或密钥不可用，这一轮没有做完。请在本机的 dsh 里重新登录。" },
  INVALID_CREDENTIAL: { code: "NATIVE_AUTH_REQUIRED", message: "dsh 的登录或密钥不可用，这一轮没有做完。请在本机的 dsh 里重新登录。" },
  CONTEXT_WINDOW_EXCEEDED: { code: "NATIVE_CONTEXT_EXCEEDED", message: "对话超出了模型的上下文长度，dsh 这一轮没有做完。可以开始新对话，或换上下文更长的模型。" },
  UNKNOWN_MODEL: { code: "NATIVE_MODEL_UNAVAILABLE", message: "所选模型在 dsh 的模型服务中不可用，请换一个模型。" },
  MODEL_UNSUPPORTED: { code: "NATIVE_MODEL_UNAVAILABLE", message: "所选模型在 dsh 的模型服务中不可用，请换一个模型。" },
  SERVER: { code: "MODEL_REQUEST_FAILED", message: "dsh 的模型服务出错了，重试后仍没有做完这一轮。请稍后再试。" },
  TIMEOUT: { code: "MODEL_REQUEST_FAILED", message: "dsh 的模型服务没有及时回应，重试后仍没有做完这一轮。请稍后再试。" },
  EMPTY_RESPONSE: { code: "MODEL_REQUEST_FAILED", message: "dsh 的模型服务返回了空回答，重试后仍没有做完这一轮。请稍后再试。" },
};
export function failureOf(ended: string, code: string | null): { readonly code: string; readonly message: string } {
  if (ended === "error" && code !== null) return DSH_ERROR_CODES[code] ?? { code: "MODEL_REQUEST_FAILED", message: "dsh 这一轮出错结束了（" + code + "），详情记在 dsh 的会话日志里。" };
  return DSH_FAILURES[ended]!;
}
/** dsh's tools by name (dsh-tool-*, the acp profile's roster): their ACP updates all say `kind: "other"`. */
export const DSH_TOOL_KINDS: Readonly<Record<string, string>> = {
  bash: "execute", pwsh: "execute", job_kill: "execute", job_output: "execute", job_list: "execute", terminal_open: "execute", terminal_send: "execute", terminal_read: "execute",
  terminal_signal: "execute", terminal_close: "execute", terminal_list: "execute",
  read: "read", read_image: "read", write: "edit", edit: "edit", apply_patch: "edit", str_replace_editor: "edit", glob: "search", grep: "search",
  session_search: "search", session_event_search: "search", web_fetch: "fetch", web_search: "fetch", todo_write: "think",
  subagent: "subagent", subagent_fork: "subagent", send_message: "subagent", interrupt_agent: "subagent", list_agents: "subagent",
};
/** A file change a call of the Turn made, as its result's `meta` says (dsh-tool-fs: `diffs` of `{path, oldText, newText}`; a created file has none, its content is the call's). */
export function changeOf(call: { readonly arguments: unknown }, meta: unknown): string | null {
  const record = meta !== null && typeof meta === "object" ? meta as Record<string, unknown> : {};
  const diffs = Array.isArray(record.diffs) ? record.diffs.flatMap(item => {
    const row = item !== null && typeof item === "object" ? item as Record<string, unknown> : {};
    return typeof row.path === "string" && typeof row.newText === "string" ? [unifiedDiff(row.path, typeof row.oldText === "string" ? row.oldText : null, row.newText)] : [];
  }) : [];
  if (diffs.length) return diffs.join("");
  let args: unknown = call.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
  const given = args !== null && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : typeof given.file_path === "string" ? given.file_path : null;
  return record.operation === "create" && path !== null && typeof given.content === "string" ? unifiedDiff(path, null, given.content) : null;
}

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

function field(value: unknown, key: string): unknown { return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }

/** What the log says of the turns a prompt added: their usage, how the last one ended and with which error code, and the file changes their calls made. */
interface TurnOutcome {
  readonly added: boolean;
  readonly usage: Counters | null;
  readonly ended: string | null;
  readonly failure: string | null;
  readonly changes: readonly { readonly id: string; readonly name: string; readonly failed: boolean; readonly diff: string }[];
}

/**
 * DeepSeek Harness (`dsh --profile acp`) on the generic ACP driver, with what its ACP leaves out read back from its own session log
 * (dsh 0.2.2-rc.1, as on 0.2.1-rc.5). Its ACP reports only the context's occupancy (dsh-acp `usageUpdate`) and its prompt result carries no usage,
 * but every model request of a Turn is written to the session's log as an `assistant/message` entry with `usage {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens, totalTokens}` under the turn number of its `turn/start` (DeepSeek's Anthropic-format API: the input leaves
 * out the cache, the output holds the thinking). The log is `<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v<N>.jsonl[.zstd]`
 * (dsh-session-persistence-jsonl); it is only read, after the prompt answered, and the Turn's numbers are the sum of the requests of the
 * turns it added. A log that cannot be found or read gives no numbers (the Turn's usage stays as dsh reported it, the context alone).
 *
 * The log also says how the last turn ended, which its ACP does not: a blocked or aborted turn arrives as end_turn (an error one too up to
 * 0.2.1; 0.2.2 refuses the prompt with -32603 "turn failed: …", whose text is dsh's own), and the turn's `turn/end` holds the error's code.
 * A turn the log gained is the prompt taken into dsh's history, whatever then failed. Its ACP tool updates carry no diff and every kind is
 * `other`: the kinds come from the tool names, and the file changes from the results' `meta` once the prompt answered.
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
  /** Each session's log once found (the search through every project directory is done once). */
  private readonly paths = new Map<string, string>();
  private async logPath(id: string, cwd: string): Promise<string | null> {
    const known = this.paths.get(id);
    if (known !== undefined) return known;
    const found = await this.findLog(id, cwd);
    if (found !== null) this.paths.set(id, found);
    return found;
  }
  /** The session's newest log generation: under its project's directory, else under any project directory that holds the session. */
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
        const row = JSON.parse(line) as { type?: unknown; data?: Record<string, unknown> };
        const data = row.data ?? {}, usage = data.usage as Record<string, unknown> | null | undefined, reason = data.reason;
        const kind = typeof reason === "string" ? reason : typeof field(reason, "kind") === "string" ? field(reason, "kind") as string : null;
        const code = field(field(reason, "error"), "code"), message = data.message;
        return { type: typeof row.type === "string" ? row.type : "", turn: typeof data.turn === "number" ? data.turn : null,
          usage: usage !== null && typeof usage === "object" ? { input: amount(usage.inputTokens), output: amount(usage.outputTokens), cachedInput: amount(usage.cacheReadTokens), cacheWrite: amount(usage.cacheWriteTokens), total: amount(usage.totalTokens) } : null,
          ended: row.type === "turn/end" ? kind : null, failure: row.type === "turn/end" && typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null,
          call: row.type === "tool/call" && typeof data.callId === "string" && typeof data.name === "string" ? { id: data.callId, name: data.name, arguments: data.arguments } : null,
          result: row.type === "tool/result" && typeof field(message, "toolCallId") === "string" ? { id: field(message, "toolCallId") as string, failed: field(message, "isError") === true, meta: data.meta } : null };
      });
    } catch { return null; }
  }
  private static lastTurn(entries: readonly LogEntry[]): number { return entries.reduce((high, entry) => entry.type === "turn/start" && entry.turn !== null ? Math.max(high, entry.turn) : high, 0); }
  /** What the turns the log gained after `before` say, once the last of them ended (or the wait is over). */
  private async turnOutcome(id: string, cwd: string, before: number): Promise<TurnOutcome | null> {
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
    const end = last > before ? entries.find(entry => entry.type === "turn/end" && entry.turn === last) : undefined;
    const mine = (entry: LogEntry): boolean => entry.turn !== null && entry.turn > before;
    const requests = entries.filter(entry => entry.type === "assistant/message" && mine(entry) && entry.usage !== null);
    const usage = requests.length === 0 ? null : requests.reduce<Counters>((sum, entry) => ({ input: sum.input + entry.usage!.input, output: sum.output + entry.usage!.output,
      cachedInput: sum.cachedInput + entry.usage!.cachedInput, cacheWrite: sum.cacheWrite + entry.usage!.cacheWrite, total: sum.total + entry.usage!.total }), { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0 });
    const calls = new Map(entries.flatMap(entry => entry.call !== null && mine(entry) ? [[entry.call.id, entry.call] as const] : []));
    const changes = entries.flatMap(entry => {
      const call = entry.result === null || !mine(entry) ? undefined : calls.get(entry.result.id);
      if (call === undefined || DSH_TOOL_KINDS[call.name] !== "edit") return [];
      const diff = changeOf(call, entry.result!.meta);
      return diff === null ? [] : [{ id: call.id, name: call.name, failed: entry.result!.failed, diff }];
    });
    return { added: last > before, usage, ended: end?.ended ?? null, failure: end?.failure ?? null, changes };
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
      if (outcome === null) return result;
      if (outcome.usage) onEvent({ type: "usage", usage: { turn: outcome.usage } });
      // The same calls again, now with the change each made (the item takes the diff into its detail).
      for (const change of outcome.changes) onEvent({ type: "tool", id: change.id, title: change.name, status: change.failed ? "failed" : "completed", detail: { kind: "edit", name: change.name, diff: change.diff } });
      const recorded = outcome.added ? { input: "recorded" as const } : {};
      // A turn that ended badly is failed, whatever its ACP said of it: end_turn (blocked, aborted; error up to 0.2.1) or a refused prompt (error from 0.2.2).
      const refused = result.status === "failed" && result.reason === "request_rejected" && outcome.ended === "error";
      if (outcome.ended !== null && outcome.ended in DSH_FAILURES && (result.status === "completed" || refused))
        return { ...result, status: "failed", reason: "native_error", error: failureOf(outcome.ended, outcome.failure), ...recorded };
      return result.input === undefined ? { ...result, ...recorded } : result;
    }) };
  }
  /** dsh names each call by its tool and gives every kind as `other`: the kind its tool has, and the tool as the call's name. */
  protected override describeTool(title: string, detail: NativeToolDetail | undefined): NativeToolDetail | undefined {
    const kind = DSH_TOOL_KINDS[title] ?? (/^mcp__|__/u.test(title) ? "mcp" : undefined);
    if (kind === undefined || (detail?.kind !== undefined && detail.kind !== "other")) return detail;
    return { ...detail, kind, ...(detail?.name === undefined ? { name: title } : {}) };
  }
  /** dsh's own task list (dsh-tool-todo `todo_write {todos: [{content, status}]}`, the whole list each time) is the Turn's plan. */
  protected override toolPlan(title: string, update: Readonly<Record<string, unknown>>): readonly NativePlanEntry[] | null {
    const todos = field(update.rawInput, "todos");
    if (title !== "todo_write" || !Array.isArray(todos)) return null;
    return todos.flatMap(item => {
      const content = field(item, "content"), status = field(item, "status");
      return typeof content === "string" && content.trim() ? [{ content, status: status === "in_progress" || status === "completed" ? status : "pending" as const }] : [];
    });
  }
}
