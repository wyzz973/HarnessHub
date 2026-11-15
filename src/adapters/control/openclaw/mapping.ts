import type { NativePlanEntry, NativeToolDetail, NativeUsage } from "../../../contracts/control.js";
import { classifyRemoteFailure } from "../../../infrastructure/control/json-rpc-process.js";
import { boundedRequests, usageRequest } from "../relay-turn.js";

/** How the Gateway's events and rows read as the Hub's (docs/gateway/protocol/rpc-bootstrap-and-events.md, OpenClaw 2026.11.3). Pure. */
export type Row = Record<string, unknown>;
export const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
export const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const line = (value: string, max: number): string => value.replace(/[\0-\x1f\x7f]+/gu, " ").trim().slice(0, max);

/** A tool's family by its OpenClaw name (the Hub's tool kinds; others are `other`). */
const TOOL_KIND: Readonly<Record<string, string>> = { exec: "execute", bash: "execute", process: "execute", terminal: "execute", read: "read", ls: "read", view_image: "read", dir_list: "read", file_fetch: "read",
  write: "edit", edit: "edit", apply_patch: "edit", file_write: "edit", web_search: "search", tavily_search: "search", memory_search: "search", sessions_search: "search", web_fetch: "fetch", tavily_extract: "fetch",
  sessions_spawn: "subagent", subagents: "subagent", agents_wait: "subagent", ask_user: "think", progress_card: "think", tool_describe: "think" };
export function toolKind(name: string): string { return TOOL_KIND[name] ?? "other"; }
/** The text of a tool result (`{content: [{type: "text", text}]}`), or of anything else as JSON. */
export function resultText(result: unknown): string {
  const content = record(result)?.content;
  if (Array.isArray(content)) return content.flatMap(block => { const row = record(block); return row?.type === "text" && typeof row.text === "string" ? [row.text] : []; }).join("\n");
  return result === undefined || result === null ? "" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
/** One tool call as last seen: its title, status and detail. */
export interface ToolState { title: string; status: string; detail: NativeToolDetail }
/** A tool event (`agent` stream `tool`) applied to what was known of the call (its item's title, earlier output). */
export function toolUpdate(prior: ToolState | undefined, data: Row, itemTitle: string | undefined): ToolState {
  const name = text(data.name) ?? prior?.detail.name ?? "tool", phase = text(data.phase), args = record(data.args);
  const summary = args === null ? undefined : [args.command, args.path, args.file_path, args.query, args.url].find((value): value is string => typeof value === "string");
  const title = itemTitle ?? prior?.title ?? line(name + (summary ? ": " + summary : ""), 4096);
  const details = record(record(data.result)?.details) ?? record(record(data.partialResult)?.details);
  const output = phase === "result" ? resultText(data.result) : phase === "update" ? resultText(data.partialResult) : undefined;
  const exitCode = typeof details?.exitCode === "number" && Number.isSafeInteger(details.exitCode) ? details.exitCode : undefined;
  const parent = text(data.parentToolCallId);
  const detail: NativeToolDetail = { ...prior?.detail, kind: toolKind(name), name: name.slice(0, 256), ...(args !== null && prior?.detail.input === undefined ? { input: JSON.stringify(args, null, 2) } : {}),
    ...(output ? { output } : {}), ...(exitCode === undefined ? {} : { exitCode }), ...(parent ? { parentId: parent.slice(0, 256) } : {}) };
  const status = phase === "result" ? (data.isError === true ? "failed" : "completed") : "in_progress";
  return { title, status, detail };
}
/** The `plan` stream's steps (progress_card: `{step, status}`, docs/tools/progress-card.md) as the Hub's plan. */
export function planOf(data: Row): { readonly entries: NativePlanEntry[]; readonly explanation?: string } | null {
  if (!Array.isArray(data.steps)) return null;
  const entries = data.steps.slice(0, 256).flatMap(value => { const step = record(value); return step !== null && typeof step.step === "string" ? [{ content: step.step, status: step.status === "completed" ? "completed" as const : step.status === "in_progress" ? "in_progress" as const : "pending" as const }] : []; });
  const explanation = text(data.explanation);
  return { entries, ...(explanation ? { explanation } : {}) };
}
/** The run a transcript row belongs to (`__openclaw.runId`, or the user row's `idempotencyKey` `<runId>:user`). */
export function rowRun(row: Row): string | null {
  const meta = record(row.__openclaw);
  if (typeof meta?.runId === "string") return meta.runId;
  const key = text(meta?.idempotencyKey);
  return key !== undefined && key.endsWith(":user") ? key.slice(0, -5) : null;
}
export const rowId = (row: Row): string | null => text(record(row.__openclaw)?.id) ?? null;
/**
 * The user rows that began a turn, oldest first: a user row between two rows of the same other run is words given to that run (a steer), not a
 * turn of its own.
 */
export function turnStarts(rows: readonly Row[]): Row[] {
  return rows.filter((row, index) => {
    if (row.role !== "user") return false;
    const before = rows.slice(0, index).reverse().find(other => other.role !== "user"), after = rows.slice(index + 1).find(other => other.role !== "user");
    const run = before === undefined ? null : rowRun(before);
    return !(run !== null && after !== undefined && rowRun(after) === run && run !== rowRun(row));
  });
}
/** The Turn's usage from its transcript rows (one assistant row per model request, with `usage` and `cost`), the context its last request held. */
export function usageOf(rows: readonly Row[], runs: ReadonlySet<string>, contextSize: number | undefined): NativeUsage | null {
  const turn = { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0 }, requests: NonNullable<ReturnType<typeof usageRequest>>[] = [];
  let counted = false, cost = 0, occupied: number | undefined;
  for (const row of rows) {
    const run = rowRun(row);
    if (row.role !== "assistant" || run === null || !runs.has(run)) continue;
    const usage = record(row.usage);
    if (usage === null) continue;
    counted = true;
    const add = (key: keyof typeof turn, value: unknown) => { if (typeof value === "number" && Number.isFinite(value) && value >= 0) turn[key] += value; };
    add("input", usage.input); add("output", usage.output); add("cachedInput", usage.cacheRead); add("cacheWrite", usage.cacheWrite); add("total", usage.totalTokens);
    if (typeof usage.totalTokens === "number" && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) occupied = usage.totalTokens;
    const request = usageRequest(usage.input, usage.cacheRead, usage.cacheWrite);
    if (request !== null) requests.push(request);
    const spent = record(usage.cost)?.total;
    if (typeof spent === "number" && Number.isFinite(spent) && spent > 0) cost += spent;
  }
  if (!counted) return null;
  return { turn, ...(occupied === undefined ? {} : { context: { used: occupied, ...(contextSize === undefined ? {} : { size: contextSize }) } }),
    ...(cost > 0 ? { cost: { amount: cost, currency: "USD", scope: "turn" as const } } : {}), ...(requests.length ? { requests: boundedRequests(requests) } : {}) };
}
/** A failed run (`chat` state `error`) as the Turn's error: the Hub's class by its kind or words, else OpenClaw's own. */
export function runFailure(payload: Row): { readonly code: string; readonly message: string } {
  const said = text(payload.errorMessage) ?? "", kind = text(payload.errorKind);
  const byKind = kind === "rate_limit" ? { code: "NATIVE_RATE_LIMITED", message: "模型服务暂时限流或过载。请稍后再试，或换一个模型。" }
    : kind === "context_length" ? { code: "NATIVE_CONTEXT_EXCEEDED", message: "对话超出了模型的上下文长度。可以先 /compact 压缩，或开始新对话。" }
    : kind === "refusal" ? { code: "MODEL_REFUSED", message: "模型拒绝了这个请求。" } : kind === "timeout" ? { code: "MODEL_REQUEST_TIMEOUT", message: "OpenClaw 的模型请求超时。" } : undefined;
  return byKind ?? classifyRemoteFailure(said) ?? { code: "MODEL_REQUEST_FAILED", message: "OpenClaw 的这一轮失败了" + (said ? "：" + line(said, 300) : "。") };
}

/** One question of `question.requested` as the user is asked it: a choice per option, a free answer where it takes one, and a stop. */
export interface Question {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly choices: readonly { readonly id: string; readonly name: string }[];
  readonly input?: { readonly kind: "text" | "secret"; readonly value: string };
  readonly multi: boolean;
  /** The answers for a choice (and the typed text for `submit`), or `cancel`; throws on a choice or text it cannot take. */
  value(choice: string, input?: string): readonly string[] | "cancel";
}
export function questionsOf(payload: Row): Question[] | null {
  if (!Array.isArray(payload.questions) || payload.questions.length === 0 || payload.questions.length > 16) return null;
  const questions = payload.questions.map((value): Question | null => {
    const row = record(value), id = text(row?.questionId), asked = text(row?.question);
    if (row === null || !id || asked === undefined) return null;
    const options = (Array.isArray(row.options) ? row.options : []).map(record).filter((option): option is Row => typeof option?.label === "string");
    const free = row.isOther === true || options.length === 0, header = text(row.header)?.trim();
    return { id, title: asked.slice(0, 4096), ...(header && header !== asked.trim() ? { detail: header } : {}), multi: row.multiSelect === true,
      choices: [...options.map((option, index) => ({ id: "answer-" + index, name: String(option.label) })), ...(free ? [{ id: "submit", name: "提交回答" }] : []), { id: "cancel", name: "取消" }],
      ...(free ? { input: { kind: row.isSecret === true ? "secret" as const : "text" as const, value: "" } } : {}),
      value: (choice, input) => {
        if (choice === "cancel") return "cancel";
        if (choice === "submit") { if (typeof input !== "string" || input.includes("\0")) throw new Error("invalid answer"); return row.answerFormat === "lines" ? input.split("\n").filter(Boolean) : [input]; }
        const option = choice.startsWith("answer-") ? options[Number(choice.slice(7))] : undefined;
        if (option === undefined) throw new Error("invalid choice");
        return [typeof option.value === "string" ? option.value : String(option.label)];
      } };
  });
  return questions.some(question => question === null) ? null : questions as Question[];
}

/** An approval as the user (or the Hub's level) is asked it. */
export interface Approval {
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly toolKind: string;
  readonly forCall?: string;
  /** It would send something out of the session (a message, a post, a payment): only the user decides it, never the Hub's level. */
  readonly outbound: boolean;
}
const DECISION_NAMES: Readonly<Record<string, string>> = { "allow-once": "允许", "allow-always": "总是允许", deny: "拒绝" };
const OUTBOUND = new Set(["message-send", "external-post", "payment"]);
function decisions(value: unknown): { id: string; name: string }[] {
  const listed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^[a-z-]{1,32}$/u.test(item)) : ["allow-once", "allow-always", "deny"];
  return (listed.length ? listed : ["allow-once", "deny"]).map(id => ({ id, name: DECISION_NAMES[id] ?? id }));
}
export function execApproval(payload: Row): Approval | null {
  const request = record(payload.request);
  const command = text(request?.command) ?? (Array.isArray(request?.commandArgv) ? request.commandArgv.filter((part): part is string => typeof part === "string").join(" ") : undefined);
  if (request === null || command === undefined) return null;
  const warning = text(request.warningText), cwd = text(request.cwd), scope = text(record(request.scope)?.kind);
  return { title: "运行命令：" + line(command, 1024), ...(warning || cwd ? { detail: [warning, cwd ? "目录：" + cwd : undefined].filter(Boolean).join("\n") } : {}),
    options: decisions(request.allowedDecisions), toolKind: "execute", ...(text(request.toolCallId) ? { forCall: text(request.toolCallId)! } : {}), outbound: scope !== undefined && OUTBOUND.has(scope) };
}
export function pluginApproval(payload: Row): Approval | null {
  const request = record(payload.request) ?? payload, title = text(request.title);
  if (title === undefined) return null;
  const scope = text(record(request.scope)?.kind), description = text(request.description), detail = text(request.detail);
  return { title: line(title, 1024), ...(description || detail ? { detail: [description, detail].filter(Boolean).join("\n") } : {}), options: decisions(request.allowedDecisions),
    toolKind: scope !== undefined && OUTBOUND.has(scope) ? "other" : "tool", ...(text(request.toolCallId) ? { forCall: text(request.toolCallId)! } : {}), outbound: scope !== undefined && OUTBOUND.has(scope) };
}
