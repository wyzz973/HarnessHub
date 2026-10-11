import type { ProtocolObservation } from "../contracts/control.js";
import type { PublicRun, SessionEvent, SessionSnapshot } from "../contracts/session.js";

/** The most a diagnostics text holds, and how much of a Turn's stderr it carries (ADR-037). */
export const MAX_DIAGNOSTICS_BYTES = 64 * 1024, MAX_DIAGNOSTIC_STDERR_BYTES = 4096;
const HIDDEN = "[已隐去]", PATH = "[路径]", USER = "[用户]";

/** Strings that look like credentials, each with the part kept in front of the hidden value. */
const CREDENTIALS: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_-]{8,}/gu, HIDDEN],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/gu, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/gu, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, HIDDEN],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 " + HIDDEN],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|cookie|private[_-]?key)["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s|\[已隐去\])[^\s"',;&]+/giu, "$1" + HIDDEN],
];
/** `NAME=value` the way environments and shells write them: the name stays, the value never does. */
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]{2,})=("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gu;
/** Absolute and home-relative paths (POSIX, file URLs, Windows drives and shares). */
const PATHS: readonly RegExp[] = [
  /\bfile:\/\/[^\s"'<>]+/gu,
  /(?:~|\/(?:Users|home|private|var|tmp|opt|usr|etc|Volumes|Applications|Library|System|root|mnt|srv|nix|snap|proc|dev|workspace|data))(?:\/[^\s"'<>|:;,()[\]{}]*)+/gu,
  /\b[A-Za-z]:\\[^\s"'<>|]*/gu,
  /\\\\[^\s"'<>|\\]+\\[^\s"'<>|]*/gu,
];

/**
 * Removes from text what a diagnostics report must not carry (ADR-037): first through the Gateway's own redactor (the
 * credentials it injected), then credential-like strings, environment values, paths and the user's account name. The
 * result keeps its lines, so the report stays readable; a hidden value is replaced, never silently dropped.
 */
export function scrubDiagnostics(text: string, options: { readonly redact: (text: string) => string; readonly user: string | null }): string {
  let clean = options.redact(text);
  for (const [pattern, replacement] of CREDENTIALS) clean = clean.replace(pattern, replacement);
  clean = clean.replace(ASSIGNMENT, "$1=" + HIDDEN);
  for (const pattern of PATHS) clean = clean.replace(pattern, PATH);
  const user = options.user?.trim();
  if (user && user.length >= 2) clean = clean.replace(new RegExp("(?<![\\p{L}\\p{N}_])" + user.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "(?![\\p{L}\\p{N}_])", "gu"), USER);
  return clean;
}

/**
 * Without conversation content, what a program logs of the conversation is withheld too (Hermes, for one, logs the start of
 * every prompt it receives): from where the start of any message of this conversation appears, the rest of that line goes.
 * Messages shorter than 4 characters are too common to look for.
 */
export function withholdConversation(text: string, messages: readonly string[]): string {
  const starts = [...new Set(messages.map(message => message.trim().slice(0, 32)).filter(start => [...start].length >= 4))];
  if (!starts.length) return text;
  return text.split("\n").map(line => {
    const at = Math.min(...starts.map(start => line.indexOf(start)).filter(index => index >= 0));
    return Number.isFinite(at) ? line.slice(0, at) + "[对话内容已隐去]" : line;
  }).join("\n");
}

/** What the Gateway knows about one Turn, gathered for its report; every string from a program is scrubbed when written. */
export interface RunDiagnosticsInput {
  readonly session: SessionSnapshot;
  readonly run: PublicRun;
  /** This Turn's events, in order. */
  readonly events: readonly SessionEvent[];
  /** Whether the event count is complete, or stopped at the reading budget. */
  readonly eventsComplete: boolean;
  /** The stderr its program logged during it, kept in this service's memory; null when this service has none. */
  readonly stderr: { readonly text: string; readonly truncated: boolean } | null;
  readonly harness: { readonly name: string; readonly programVersion: string | null; readonly installedVersion: string | null } | null;
  readonly build: string;
  readonly runtime: { readonly node: string; readonly platform: string; readonly release: string; readonly arch: string };
  readonly now: Date;
  readonly includeContent: boolean;
  readonly scrub: (text: string) => string;
}
function bytes(text: string): number { return Buffer.byteLength(text, "utf8"); }
/** The last `limit` bytes of `text`, starting at a whole character. */
function tail(text: string, limit: number): { readonly text: string; readonly cut: boolean } {
  if (bytes(text) <= limit) return { text, cut: false };
  return { text: Buffer.from(text, "utf8").subarray(-limit).toString("utf8").replace(/^�+/u, ""), cut: true };
}
/** The first `limit` bytes of `text`, ending at a whole character. */
function head(text: string, limit: number): { readonly text: string; readonly cut: boolean } {
  if (bytes(text) <= limit) return { text, cut: false };
  return { text: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/�+$/u, ""), cut: true };
}
function ms(from: number | undefined, to: number | undefined): string { return from === undefined || to === undefined ? "—" : Math.max(0, to - from) + " ms"; }

/**
 * One Turn's diagnostics as plain text, at most 64 KiB (ADR-037). Its first line says whether conversation content is in
 * it; without content it holds no prompt, reply, tool text or attachment. Nothing of it is stored by the Gateway.
 */
export function runDiagnostics(input: RunDiagnosticsInput): string {
  const { run, session, scrub } = input, timing = run.timing;
  const index = session.runs.findIndex(item => item.id === run.id);
  const protocol = input.events.filter(event => event.type === "run.protocol").map(event => (event.data as { observation?: ProtocolObservation }).observation).at(-1);
  const installation = input.events.filter(event => event.type === "run.installation_resolved").map(event => (event.data as { installation?: { source?: unknown; version?: unknown } }).installation).at(-1);
  const counts = new Map<string, number>();
  for (const event of input.events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  const tools = run.tools ?? [], toolStates = new Map<string, number>();
  for (const tool of tools) toolStates.set(tool.status, (toolStates.get(tool.status) ?? 0) + 1);
  const options = Object.entries(run.selection.nativeOptions ?? {}).map(([key, value]) => key + "=" + value).join(", ");
  const lines = [
    "HarnessHub 诊断 · " + (input.includeContent ? "含对话内容（只含这一轮的提示词与回复）" : "不含对话内容"),
    "已隐去路径、环境变量值和密钥样式的字符串" + (input.includeContent ? "。" : "；原程序日志中出现的对话内容也已隐去。"),
    "",
    "生成时间：" + input.now.toISOString(),
    "HarnessHub 构建：" + input.build.slice(0, 12) + " · Node " + input.runtime.node + " · " + input.runtime.platform + " " + input.runtime.release + " " + input.runtime.arch,
    "Harness：" + scrub(input.harness?.name ?? run.selection.harnessId) + "（" + run.selection.harnessId + "）· 控制入口 " + (run.selection.controlId ?? "—") + (protocol ? "（" + protocol.protocol + "）" : ""),
    "  原程序在本回合报告：" + (protocol ? scrub(protocol.agentName ?? "—") + " " + scrub(protocol.agentVersion ?? "—") + " · 协议版本 " + (protocol.protocolVersion ?? "—") : "（本回合没有建立连接）"),
    "  当前安装：产品 " + scrub(input.harness?.programVersion ?? "—") + " · 控制入口 " + scrub(input.harness?.installedVersion ?? "—")
      + (installation && typeof installation.source === "string" ? " · 来源 " + (installation.source === "managed" ? "HarnessHub 管理" : "本机") : ""),
    "回合：" + run.id + "（第 " + (index + 1) + " 轮，共 " + session.runs.length + " 轮）· 状态 " + run.status,
    "  原生模型：" + (run.selection.nativeModel === undefined ? "跟随本机配置" : scrub(run.selection.nativeModel)) + (options ? " · 原生设置：" + scrub(options) : ""),
    "  复用保留的进程：" + (run.reused ? "是" : "否") + " · 交给对话保留：" + (run.retained ? "是" : "否"),
    "阶段（距受理）：" + (timing ? ["准备 " + ms(timing.acceptedAt, timing.preparingAt), "就绪 " + ms(timing.acceptedAt, timing.readyAt), "发送 " + ms(timing.acceptedAt, timing.dispatchedAt),
      "首个输出 " + ms(timing.acceptedAt, timing.firstOutputAt), "结束 " + ms(timing.acceptedAt, timing.endedAt)].join(" · ") : "没有记录"),
    "结束：后端 " + (run.backend ? run.backend.status + "（" + scrub(run.backend.reason) + "）" : "—") + " · 错误代码 " + (run.error?.code ?? "—")
      + " · 请求停止 " + (run.stopRequested ? "是" : "否") + " · 请求取消 " + (run.cancelRequested ? "是" : "否"),
    "清理：" + (run.cleanup ? (run.cleanup.closed ? "已关闭" : "未确认关闭") + " · 退出码 " + (run.cleanup.exitCode ?? "—") + " · 信号 " + (run.cleanup.signal ?? "—")
      + " · 协议故障 " + (run.cleanup.protocolFailure?.code ?? "—") : run.retained ? "进程交给对话保留，由对话记录关闭" : "没有记录"),
    "事件：" + (input.eventsComplete ? "共 " : "至少 ") + input.events.length + " 条（" + [...counts].sort((a, b) => b[1] - a[1]).map(([type, count]) => type + " " + count).join("、") + "）",
    "工具：" + tools.length + " 个" + (tools.length ? "（" + [...toolStates].map(([status, count]) => status + " " + count).join("、") + "）" : "") + " · 提示 " + (run.notices?.length ?? 0) + " 条 · 产物 " + (run.outputs?.length ?? 0) + " 个",
  ];
  let stderr: string;
  if (input.stderr === null) stderr = "（本次服务运行期间没有这一轮的记录，例如它在服务重启之前运行）";
  else if (!input.stderr.text.trim()) stderr = "（没有输出）";
  else {
    const logged = input.includeContent ? input.stderr.text : withholdConversation(input.stderr.text, session.messages.map(message => message.text));
    const kept = tail(scrub(logged), MAX_DIAGNOSTIC_STDERR_BYTES); stderr = (input.stderr.truncated || kept.cut ? "…（只保留最后 4 KiB）\n" : "") + kept.text;
  }
  lines.push("", "stderr（本回合，最后 4 KiB）：", stderr);
  let text = lines.join("\n") + "\n";
  if (input.includeContent) {
    // Only this Turn's prompt and reply: no attachment, tool text or other Turn. The reply gives way first.
    const reply = session.messages.find(message => message.id === run.assistantMessageId)?.text ?? "";
    const room = MAX_DIAGNOSTICS_BYTES - bytes(text) - 256;
    const prompt = head(scrub(run.input), Math.max(0, Math.min(16 * 1024, room)));
    const answer = head(scrub(reply), Math.max(0, room - bytes(prompt.text)));
    text += "\n提示词：\n" + prompt.text + (prompt.cut ? "\n…（已截断）" : "") + "\n\n回复：\n" + (answer.text || "（没有回复）") + (answer.cut ? "\n…（已截断）" : "") + "\n";
  }
  return head(text, MAX_DIAGNOSTICS_BYTES).text;
}
