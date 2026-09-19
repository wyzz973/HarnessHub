"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, UnsupportedFeatureError } from "@/lib/api";
import type { LogRecord } from "@/lib/contracts";
import { cn } from "@/lib/utils";

type Source = "engine" | "gateway";
type Level = "all" | "info" | "debug";
interface SourceState {
  records: LogRecord[];
  file?: string;
  exists?: boolean;
  truncated: boolean;
  skipped: number;
}

/** Newest records requested when a source is first opened. */
const FIRST_PAGE = 500;
/** Records kept per source in the browser; older ones are dropped from view. */
const KEEP = 5000;
const POLL_MS = 2000;
const sources: { id: Source; label: string }[] = [
  { id: "engine", label: "引擎日志" },
  { id: "gateway", label: "Gateway 日志" },
];
const empty = (): SourceState => ({
  records: [],
  truncated: false,
  skipped: 0,
});

function clock(time: string) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return `${date.toLocaleTimeString("zh-CN", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/** Fields other than time/level/event, compact for one row. */
function summary(record: LogRecord) {
  const rest = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== "time" && key !== "level" && key !== "event",
    ),
  );
  const text = JSON.stringify(rest);
  return text === "{}"
    ? ""
    : text.length > 320
      ? `${text.slice(0, 320)}…`
      : text;
}

function failed(record: LogRecord) {
  return (
    /error|fail|fatal|exit/i.test(record.event) ||
    record.ok === false ||
    (typeof record.status === "number" && record.status >= 400)
  );
}

/**
 * Diagnostics of one Session: its engine log (engine process, ACP traffic, tool
 * calls, model calls) and its lines of the Gateway log, read through
 * `GET /v1/sessions/{id}/logs`. While `active`, new records are fetched every 2 s
 * with the previous page's cursor; filters, copy and download act on the visible
 * records only. Mount it with `key={sessionId}` so another Session starts empty.
 */
export function LogPanel({
  sessionId,
  active,
  open,
  onOpenChange,
}: {
  sessionId: string;
  /** Poll for new records (the focused Run is still running). */
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [source, setSource] = useState<Source>("engine");
  const [state, setState] = useState<Record<Source, SourceState>>({
    engine: empty(),
    gateway: empty(),
  });
  const [level, setLevel] = useState<Level>("all");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();
  const [unsupported, setUnsupported] = useState(false);
  const [copied, setCopied] = useState(false);
  const cursors = useRef<Record<Source, string | null>>({
    engine: null,
    gateway: null,
  });
  const loading = useRef<Record<Source, boolean>>({
    engine: false,
    gateway: false,
  });
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const load = useCallback(
    async (which: Source, signal?: AbortSignal) => {
      if (loading.current[which]) return;
      loading.current[which] = true;
      try {
        const after = cursors.current[which];
        const page = await api.sessionLogs(
          sessionId,
          which,
          after ? { after } : { limit: FIRST_PAGE },
          signal,
        );
        cursors.current[which] = page.cursor;
        setState((previous) => ({
          ...previous,
          [which]: {
            records: [...previous[which].records, ...page.records].slice(-KEEP),
            file: page.file,
            exists: page.exists,
            truncated: previous[which].truncated || page.truncated,
            skipped: previous[which].skipped + page.skipped,
          },
        }));
        setError(undefined);
      } catch (reason) {
        if (signal?.aborted) return;
        if (reason instanceof UnsupportedFeatureError) setUnsupported(true);
        else setError(reason instanceof Error ? reason.message : "读取失败");
      } finally {
        loading.current[which] = false;
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void load(source, abort.signal);
    const timer = active
      ? window.setInterval(() => void load(source, abort.signal), POLL_MS)
      : undefined;
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [open, active, source, load]);

  const current = state[source];
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return current.records.filter(
      (record) =>
        (level === "all" || record.level === level) &&
        (!needle || JSON.stringify(record).toLowerCase().includes(needle)),
    );
  }, [current.records, level, filter]);

  useEffect(() => {
    const element = list.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [visible]);

  const lines = () =>
    visible.map((record) => JSON.stringify(record)).join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("浏览器不允许写入剪贴板，请改用下载");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([`${lines()}\n`], { type: "application/x-ndjson" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-${sessionId.slice(0, 8)}-${source}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-3 sm:max-w-[980px]">
        <DialogHeader>
          <DialogTitle>诊断日志</DialogTitle>
          <DialogDescription>
            会话 {sessionId.slice(0, 8)} 的引擎进程、ACP
            协议、工具调用与模型调用记录，已脱敏。
            {active ? "任务进行中，每 2 秒自动刷新。" : ""}
          </DialogDescription>
        </DialogHeader>
        {unsupported ? (
          <p className="text-xs leading-6 text-muted-foreground">
            当前 Gateway 不支持在控制台读取诊断日志，请使用 Collect-Logs.cmd
            打包日志。
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="flex rounded-md border p-0.5"
                role="tablist"
                aria-label="日志来源"
              >
                {sources.map((item) => (
                  <button
                    key={item.id}
                    role="tab"
                    aria-selected={source === item.id}
                    className={cn(
                      "rounded px-3 py-1 text-xs",
                      source === item.id
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                    onClick={() => setSource(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <select
                className="form-input mt-0 w-auto py-1 text-xs"
                value={level}
                aria-label="日志级别"
                onChange={(event) => setLevel(event.target.value as Level)}
              >
                <option value="all">全部级别</option>
                <option value="info">info</option>
                <option value="debug">debug</option>
              </select>
              <input
                className="form-input mt-0 w-56 py-1 text-xs"
                placeholder="筛选事件或内容，如 model.call"
                aria-label="筛选日志"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="刷新日志"
                  onClick={() => void load(source)}
                >
                  <RefreshCw />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="复制显示的日志"
                  disabled={!visible.length}
                  onClick={() => void copy()}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="下载显示的日志"
                  disabled={!visible.length}
                  onClick={download}
                >
                  <Download />
                </Button>
              </span>
            </div>
            {current.file ? (
              <p
                className="truncate font-mono text-[10px] text-muted-foreground"
                title={current.file}
              >
                {current.file}
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div
              ref={list}
              className="min-h-[240px] flex-1 overflow-y-auto rounded-md border bg-white font-mono text-[11px] leading-5"
              onScroll={(event) => {
                const element = event.currentTarget;
                pinned.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  24;
              }}
            >
              {current.exists === false ? (
                <p className="p-4 font-sans text-xs text-muted-foreground">
                  尚无日志：引擎日志在会话第一次执行时创建。
                </p>
              ) : !visible.length ? (
                <p className="p-4 font-sans text-xs text-muted-foreground">
                  {current.records.length
                    ? "没有符合筛选条件的记录。"
                    : "读取中…"}
                </p>
              ) : (
                visible.map((record, index) => (
                  <details
                    key={`${record.time}-${index}`}
                    className={cn(
                      "border-b border-[#f0f2ec] px-3 py-1",
                      failed(record) && "bg-red-50/60",
                    )}
                  >
                    <summary className="flex cursor-pointer list-none gap-3">
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {clock(record.time)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 font-medium",
                          record.level === "debug" && "text-muted-foreground",
                          failed(record) && "text-destructive",
                        )}
                      >
                        {record.event}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {summary(record)}
                      </span>
                    </summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[10px]">
                      {JSON.stringify(record, null, 2)}
                    </pre>
                  </details>
                ))
              )}
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              显示 {visible.length} / {current.records.length} 条
              {current.truncated
                ? "；较早的记录因数量、大小或轮转限制未显示，完整日志请用 Collect-Logs.cmd 打包"
                : ""}
              {current.skipped ? `；${current.skipped} 行无法解析已跳过` : ""}。
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
