import {
  isTerminal,
  modelCallSchema,
  type AgentEvent,
  type ModelCall,
  type Run,
  type Session,
} from "./contracts";

export const statusNames: Record<string, string> = {
  planning: "正在规划",
  draft: "等待确认",
  pending: "等待执行",
  queued: "排队中",
  starting: "启动中",
  running: "执行中",
  waiting_permission: "等待授权",
  cancelling: "正在停止",
  finalizing: "整理结果",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  timed_out: "已超时",
  interrupted: "已中断",
  blocked: "依赖未完成",
  open: "可继续",
  closing: "正在关闭",
  closed: "已关闭",
};
export function duration(ms: number | null | undefined) {
  if (ms == null) return "未提供";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}
export function quantity(n: number | null | undefined) {
  return n == null ? "未提供" : new Intl.NumberFormat("zh-CN").format(n);
}
export function bytes(n: number) {
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
}
export function dateLabel(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown) {
  return typeof value === "string" ? value : "";
}
function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function compact(value: unknown, limit: number) {
  if (typeof value === "string") return clip(value, limit);
  try {
    return clip(JSON.stringify(value) ?? String(value), limit);
  } catch {
    return "（无法显示）";
  }
}
export type ToolStatus =
  "pending" | "running" | "completed" | "failed" | "unknown";
/** A readable projection of the merged `tool.update` details for one tool call. */
export interface ToolCallView {
  id: string;
  title: string;
  kind?: string;
  status: ToolStatus;
  /** Up to six argument entries; `inputMore` counts the omitted ones. */
  input: { label: string; value: string }[];
  inputMore: number;
  /** Scalar arguments, when the engine sent a string instead of an object. */
  inputText?: string;
  output?: string;
  outputTruncated: boolean;
  locations: string[];
  /** Merged engine payload shown only in the collapsed raw view. */
  raw: Record<string, unknown>;
}
export const toolStatusNames: Record<ToolStatus, string> = {
  pending: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  unknown: "已结束",
};
export const toolKindNames: Record<string, string> = {
  read: "读取",
  edit: "编辑",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "执行命令",
  fetch: "网络请求",
  think: "思考",
  other: "其他",
};
function reportedToolStatus(value: string): ToolStatus | undefined {
  switch (value.toLowerCase()) {
    case "pending":
      return "pending";
    case "in_progress":
    case "running":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}
const preferredArguments = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "description",
];
function toolInput(raw: unknown) {
  if (raw === undefined || raw === null)
    return { input: [], inputMore: 0, inputText: undefined };
  if (typeof raw !== "object")
    return { input: [], inputMore: 0, inputText: compact(raw, 400) };
  if (Array.isArray(raw))
    return { input: [], inputMore: 0, inputText: compact(raw, 400) };
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  entries.sort(([a], [b]) => {
    const rank = (key: string) => {
      const index = preferredArguments.indexOf(key);
      return index < 0 ? preferredArguments.length : index;
    };
    return rank(a) - rank(b);
  });
  return {
    input: entries.slice(0, 6).map(([label, value]) => ({
      label,
      value: compact(value, 240),
    })),
    inputMore: Math.max(0, entries.length - 6),
    inputText: undefined,
  };
}
function toolOutput(details: Record<string, unknown>) {
  const parts: string[] = [];
  if (Array.isArray(details.content))
    for (const entry of details.content) {
      const item = record(entry);
      if (item.type === "content") {
        const inner = record(item.content);
        if (inner.type === "text") parts.push(string(inner.text));
        else if (typeof inner.type === "string") parts.push(`[${inner.type}]`);
      } else if (item.type === "diff")
        parts.push(`修改文件 ${string(item.path) || "（未提供路径）"}`);
      else if (item.type === "terminal")
        parts.push(`终端 ${string(item.terminalId)}`.trim());
    }
  if (!parts.join("").trim() && details.rawOutput !== undefined) {
    const raw = details.rawOutput;
    if (typeof raw !== "object" || raw === null) parts.push(String(raw));
    else {
      const fields = record(raw);
      for (const name of [
        "output",
        "stdout",
        "text",
        "message",
        "result",
        "content",
        "stderr",
        "error",
      ])
        if (typeof fields[name] === "string" && fields[name])
          parts.push(
            name === "stderr" || name === "error"
              ? `${name}: ${fields[name]}`
              : (fields[name] as string),
          );
      if (!parts.length) parts.push(compact(raw, 2000));
    }
  }
  const text = parts.join("\n").trim();
  return text
    ? { output: clip(text, 800), outputTruncated: text.length > 800 }
    : { output: undefined, outputTruncated: false };
}
function toolLocations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const location = record(entry);
    const path = string(location.path);
    if (!path) return [];
    return [
      typeof location.line === "number" ? `${path}:${location.line}` : path,
    ];
  });
}
export function projectEvents(run: Run, events: AgentEvent[]) {
  let output = "",
    reasoning = "";
  const tools = new Map<
    string,
    {
      id: string;
      title: string;
      status?: ToolStatus;
      details: Record<string, unknown>;
    }
  >();
  const sources = new Map<string, { url: string; title: string }>();
  for (const event of events) {
    if (event.type === "message.delta") {
      if (
        ["reasoning", "thought", "analysis"].includes(string(event.data.stream))
      )
        reasoning += string(event.data.text);
      else output += string(event.data.text);
    }
    if (event.type === "tool.update") {
      const details = record(event.data.details);
      const id = string(event.data.toolCallId) || event.eventId;
      const previous = tools.get(id);
      tools.set(id, {
        id,
        title:
          (string(details.title).toLowerCase() === "tool call"
            ? previous?.title
            : string(details.title)) ||
          string(details.name) ||
          previous?.title ||
          toolKindNames[string(details.kind)] ||
          "工具调用",
        status: reportedToolStatus(string(details.status)) ?? previous?.status,
        details: { ...previous?.details, ...details },
      });
    }
    if (event.type.startsWith("source.")) {
      const url = string(event.data.url);
      if (/^https?:\/\//i.test(url)) {
        try {
          const parsed = new URL(url);
          sources.set(url, {
            url,
            title: string(event.data.title) || parsed.hostname,
          });
        } catch {
          /* Invalid source links are not navigation targets. */
        }
      }
    }
  }
  const finalOutput = run.output ?? output;
  for (const match of finalOutput.matchAll(
    /\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g,
  )) {
    try {
      const link = new URL(match[2]!);
      if (["https:", "http:"].includes(link.protocol))
        sources.set(link.href, { url: link.href, title: match[1]! });
    } catch {
      /* Invalid links remain ordinary Markdown text. */
    }
  }
  const finished = isTerminal(run.status);
  return {
    output: finalOutput,
    reasoning,
    tools: [...tools.values()].map((tool): ToolCallView => ({
      id: tool.id,
      title: tool.title,
      ...(typeof tool.details.kind === "string"
        ? { kind: tool.details.kind }
        : {}),
      status: tool.status ?? (finished ? "unknown" : "running"),
      ...toolInput(tool.details.rawInput),
      ...toolOutput(tool.details),
      locations: toolLocations(tool.details.locations),
      raw: tool.details,
    })),
    sources: [...sources.values()],
  };
}

export const inboundNames: Record<ModelCall["inbound"], string> = {
  "openai-completions": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  google: "Google Gemini",
};
/** Valid `model.call` records in event order; malformed records are counted, not guessed. */
export function projectModelCalls(events: AgentEvent[]) {
  const calls: ModelCall[] = [];
  let invalid = 0;
  for (const event of events) {
    if (event.type !== "model.call") continue;
    const parsed = modelCallSchema.safeParse(event.data);
    if (parsed.success) calls.push(parsed.data);
    else invalid += 1;
  }
  return { calls, invalid };
}
export interface ModelEvidence {
  /**
   * `unified`: every observed call went to the configured unified model; `mismatch`: one other
   * model; `single`: one model but no unified model to compare; `mixed`: several upstream models.
   */
  verdict: "none" | "unified" | "single" | "mismatch" | "mixed";
  total: number;
  failed: number;
  models: { model: string; count: number }[];
  requested: string[];
  usageReported: number;
  tokens: { input: number | null; output: number | null; total: number | null };
  durationMs: number;
}
/** Summarize only observed calls; calls that bypass the model gateway cannot appear here. */
export function modelEvidence(
  calls: ModelCall[],
  unifiedModel?: string,
): ModelEvidence {
  const counts = new Map<string, number>();
  for (const call of calls)
    counts.set(call.upstreamModel, (counts.get(call.upstreamModel) ?? 0) + 1);
  const models = [...counts].map(([model, count]) => ({ model, count }));
  const sum = (pick: (call: ModelCall) => number | undefined) => {
    const values = calls
      .map(pick)
      .filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const only = models.length === 1 ? models[0]!.model : undefined;
  return {
    verdict: !calls.length
      ? "none"
      : models.length > 1
        ? "mixed"
        : unifiedModel === undefined
          ? "single"
          : only === unifiedModel
            ? "unified"
            : "mismatch",
    total: calls.length,
    failed: calls.filter((call) => !call.ok).length,
    models,
    requested: [
      ...new Set(
        calls.flatMap((call) =>
          call.requestedModel ? [call.requestedModel] : [],
        ),
      ),
    ],
    usageReported: calls.filter((call) => call.usage).length,
    tokens: {
      input: sum((call) => call.usage?.input),
      output: sum((call) => call.usage?.output),
      total: sum((call) => call.usage?.total),
    },
    durationMs: calls.reduce((total, call) => total + call.durationMs, 0),
  };
}
/** Sessions created by the Competition API carry `configSnapshot.routing.competition`. */
export function competitionOrigin(
  session: Session | undefined,
): { title?: string } | undefined {
  const routing = record(record(session?.configSnapshot).routing);
  if (!("competition" in routing)) return undefined;
  const title = string(record(routing.competition).title);
  return title ? { title } : {};
}
/**
 * Parse the composer's expected output lines. Windows separators become `/` because the
 * Gateway accepts portable relative paths only; the Gateway still validates every path.
 */
export function parseOutputPaths(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .map((path) => ({ path, name: path.split("/").at(-1) || path }));
}

/** Render provider-specific serialized model identities without changing their backend meaning. */
export function modelLabel(value: string | null | undefined) {
  if (!value) return "未提供";
  if (value.startsWith("[")) {
    try {
      const parts: unknown = JSON.parse(value);
      if (
        Array.isArray(parts) &&
        parts.length === 2 &&
        parts.every((p) => typeof p === "string")
      )
        return parts.join(" / ");
    } catch {
      /* Preserve an opaque model ID. */
    }
  }
  return value;
}
export function observationReason(reason: string) {
  const labels: Record<string, string> = {
    "run-cost-not-reported": "引擎未提供本次费用",
    "backend-cost-not-reported": "引擎未提供费用",
    "run-token-usage-not-reported": "引擎未提供可归属到本次执行的用量",
    "acp-token-usage-not-reported": "协议未提供用量",
    "actual-model-not-reported": "引擎未报告实际模型",
    "installation-snapshot-not-recorded": "此历史任务没有安装快照",
    "cleanup-duration-not-recorded": "此历史任务没有清理耗时",
    "event-projection-limit-or-sequence-gap": "事件记录尚未完整同步",
    "dsh-private-token-projection-v4": "DSH 会话用量记录",
    "pi-private-session-jsonl": "Pi 会话用量记录",
    "opencode-private-messages": "OpenCode 消息用量记录",
    "native-reader-not-supported": "此引擎尚未提供可读取的原生用量",
  };
  return labels[reason] ?? reason;
}
