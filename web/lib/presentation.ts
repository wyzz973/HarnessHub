import type { AgentEvent, Run } from "./contracts";

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
export function projectEvents(run: Run, events: AgentEvent[]) {
  let output = "",
    reasoning = "";
  const tools = new Map<
    string,
    {
      id: string;
      title: string;
      state:
        | "input-available"
        | "output-available"
        | "output-error"
        | "approval-requested";
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
      const status = string(details.status);
      const state =
        status === "completed" || status === "success"
          ? "output-available"
          : status === "failed" || status === "error"
            ? "output-error"
            : "input-available";
      const previous = tools.get(id);
      tools.set(id, {
        id,
        title:
          (string(details.title).toLowerCase() === "tool call"
            ? previous?.title
            : string(details.title)) ||
          string(details.name) ||
          string(event.data.text) ||
          previous?.title ||
          "工具调用",
        state,
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
  return {
    output: finalOutput,
    reasoning,
    tools: [...tools.values()],
    sources: [...sources.values()],
  };
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
