"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Maximize2, RefreshCw } from "lucide-react";
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
  { id: "engine", label: "引擎" },
  { id: "gateway", label: "网关" },
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
    /error|fail|fatal/i.test(record.event) ||
    record.ok === false ||
    (typeof record.status === "number" && record.status >= 400)
  );
}

/**
 * Diagnostics of one Session: its engine log (engine process, ACP traffic, tool calls,
 * model calls) and its lines of the Gateway log, read through `GET /v1/sessions/{id}/logs`.
 * While `active`, new records are fetched every 2 s with the previous page's cursor;
 * filters, copy and download act on the visible records only. `enabled` pauses loading
 * while the view is hidden. Mount with `key={sessionId}` so another Session starts empty.
 */
export function LogView({
  sessionId,
  active,
  enabled = true,
  compact = false,
  onExpand,
}: {
  sessionId: string;
  /** Poll for new records (the focused Run is still running). */
  active: boolean;
  enabled?: boolean;
  /** Narrow layout for the run panel. */
  compact?: boolean;
  onExpand?: () => void;
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
  /** Token of the request in flight per source; null when idle. */
  const loading = useRef<Record<Source, symbol | null>>({
    engine: null,
    gateway: null,
  });
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const load = useCallback(
    async (which: Source, signal?: AbortSignal) => {
      if (loading.current[which]) return;
      const token = Symbol(which);
      loading.current[which] = token;
      try {
        const after = cursors.current[which];
        const page = await api.sessionLogs(
          sessionId,
          which,
          after ? { after } : { limit: FIRST_PAGE },
          signal,
        );
        // A request superseded by a remount must not apply its page a second time.
        if (signal?.aborted || loading.current[which] !== token) return;
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
        if (loading.current[which] === token) loading.current[which] = null;
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    void load(source, abort.signal);
    const timer = active
      ? window.setInterval(() => void load(source, abort.signal), POLL_MS)
      : undefined;
    return () => {
      abort.abort();
      // The aborted request settles later; a remount must not wait for it.
      loading.current[source] = null;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, active, source, load]);

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
      setError("无法写入剪贴板，请改用下载");
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

  if (unsupported)
    return (
      <p className="p-4 text-[13px] text-muted-foreground">
        当前服务版本不支持在线查看日志，可用 Collect-Logs.cmd 打包。
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="segmented" role="tablist" aria-label="日志来源">
          {sources.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={source === item.id}
              onClick={() => setSource(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {compact ? null : (
          <select
            className="field mt-0 h-8 w-auto rounded-full pr-7 text-[12.5px]"
            value={level}
            aria-label="日志级别"
            onChange={(event) => setLevel(event.target.value as Level)}
          >
            <option value="all">全部级别</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </select>
        )}
        <input
          className={cn(
            "field mt-0 h-8 rounded-full text-[12.5px]",
            compact ? "min-w-0 flex-1" : "w-60",
          )}
          placeholder="筛选，如 model.call"
          aria-label="筛选日志"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className={cn("flex items-center", !compact && "ml-auto")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="刷新日志"
            onClick={() => void load(source)}
          >
            <RefreshCw />
          </Button>
          {compact ? null : (
            <>
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
            </>
          )}
          {onExpand ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="在大窗口中查看日志"
              onClick={onExpand}
            >
              <Maximize2 />
            </Button>
          ) : null}
        </span>
      </div>
      {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      <div
        ref={list}
        className="min-h-[200px] flex-1 overflow-y-auto rounded-xl border bg-code font-mono text-[11.5px] leading-5"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
      >
        {current.exists === false ? (
          <p className="p-4 font-sans text-[13px] text-muted-foreground">
            还没有日志，第一次执行后生成。
          </p>
        ) : !visible.length ? (
          <p className="p-4 font-sans text-[13px] text-muted-foreground">
            {current.records.length ? "没有匹配的记录" : "读取中"}
          </p>
        ) : (
          visible.map((record, index) => (
            <details
              key={`${record.time}-${index}`}
              className={cn(
                "border-b border-border/70 px-3 py-1 last:border-b-0",
                failed(record) && "bg-danger-soft/70",
              )}
            >
              <summary
                className={cn(
                  "flex gap-x-3",
                  compact && "flex-wrap gap-x-2 gap-y-0",
                )}
              >
                <span className="shrink-0 text-subtle tabular-nums">
                  {clock(record.time)}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-medium",
                    record.level === "debug" && "text-muted-foreground",
                    failed(record) && "text-danger",
                  )}
                >
                  {record.event}
                </span>
                <span
                  className={cn(
                    "truncate text-muted-foreground",
                    compact && "w-full",
                  )}
                >
                  {summary(record)}
                </span>
              </summary>
              <pre className="mt-1 overflow-x-auto text-[11px] break-all whitespace-pre-wrap">
                {JSON.stringify(record, null, 2)}
              </pre>
            </details>
          ))
        )}
      </div>
      <p
        className="truncate text-[12px] text-subtle"
        title={current.file ?? undefined}
      >
        {visible.length} / {current.records.length} 条
        {current.truncated ? "，较早的记录未显示" : ""}
        {current.skipped ? `，${current.skipped} 行无法解析` : ""}
        {current.file && !compact ? ` · ${current.file}` : ""}
      </p>
    </div>
  );
}

/** Full-size diagnostics dialog for one Session. */
export function LogPanel({
  sessionId,
  active,
  open,
  onOpenChange,
}: {
  sessionId: string;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,88vh)] flex-col gap-4 sm:max-w-[1040px]">
        <DialogHeader>
          <DialogTitle>诊断日志</DialogTitle>
          <DialogDescription>
            会话 {sessionId.slice(0, 8)}
            {active ? "，执行中自动刷新" : ""}
          </DialogDescription>
        </DialogHeader>
        <LogView sessionId={sessionId} active={active} enabled={open} />
      </DialogContent>
    </Dialog>
  );
}
