import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { NativeSessionListView } from "../../../src/contracts/web.js";
import { errorMessage } from "../api.js";
import { Popover, PopHead } from "../ui/overlay.js";
import { Spinner } from "../ui/primitives.js";

const SOURCES: Readonly<Record<string, string>> = { cli: "终端", vscode: "编辑器", exec: "exec", appServer: "应用" };
function when(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The selected Agent's own sessions in this workspace, read from the original installation when the panel opens (again
 * only when nothing was read yet, or from its refresh button). Continuing one creates a new conversation that quotes its
 * recent history and sends the next message to that native session; a session a conversation already continues opens
 * that conversation instead. The composer's "+" menu opens it (ruling R2): it is placed against `anchor` and gives the
 * focus back to `returnFocus` when it closes. A 接续 whose conversation could not be created has the focus again once
 * `disabled` clears, while the panel is open and nothing else took the focus.
 */
export function NativeSessionsPanel({ load, onImport, onOpen, disabled, side = "top", open, onOpenChange, anchor, returnFocus }: {
  load: (cursor: string | undefined, signal: AbortSignal, probes?: boolean) => Promise<NativeSessionListView>;
  onImport: (nativeId: string) => void; onOpen: (conversationId: string) => void; disabled: boolean;
  /** Where the list opens from its anchor: above it (the default, at the foot of a conversation) or below it. */
  side?: "top" | "bottom";
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void;
  readonly anchor: RefObject<Element | null>; readonly returnFocus: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<{ loading: boolean; value: NativeSessionListView | undefined; error: string | null }>({ loading: false, value: undefined, error: null });
  // Sessions that the Hub's own model-list reads opened are empty; they stay out of the list unless asked for.
  const [probes, setProbes] = useState(false);
  // A read in flight is not started twice, also when an effect runs again (React's development checks run effects twice).
  const reading = useRef(false);
  const read = (cursor?: string, includeProbes = probes) => {
    reading.current = true;
    setState(current => ({ loading: true, value: cursor === undefined ? undefined : current.value, error: null }));
    load(cursor, new AbortController().signal, includeProbes).then(page => { reading.current = false; setState(current => ({ loading: false, error: null,
      value: cursor === undefined || !current.value?.sessions || !page.sessions ? page : { sessions: [...current.value.sessions, ...page.sessions], nextCursor: page.nextCursor, hiddenProbes: (current.value.hiddenProbes ?? 0) + (page.hiddenProbes ?? 0) } })); },
    error => { reading.current = false; setState(current => ({ loading: false, value: cursor === undefined ? undefined : current.value, error: errorMessage(error) })); });
  };
  useEffect(() => { if (open && state.value === undefined && !reading.current) read(); }, [open]);
  // 接续 is disabled while its conversation is created, which drops the focus to the page. When that conversation opens,
  // it takes the focus; when creating it fails and the panel is still open, the focus goes back to the 接续 pressed, so
  // the user can try again from where they were, unless they have moved the focus meanwhile (R03).
  const pressed = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (disabled) return;
    const button = pressed.current, focused = document.activeElement; pressed.current = null;
    if (open && button?.isConnected && (focused === null || focused === document.body)) button.focus({ preventScroll: true });
  }, [disabled]);
  const sessions = state.value?.sessions, hidden = state.value?.hiddenProbes ?? 0;
  return <Popover label="本机会话" open={open} onOpenChange={onOpenChange} anchor={anchor} returnFocus={returnFocus} side={side} align="start" className="native-sessions w-[360px] max-w-[calc(100vw-24px)]">
    <PopHead title="本机会话" closeLabel="收起本机会话"><button type="button" className="icon-btn icon-btn-sm" aria-label="重新读取本机会话" onClick={() => read()} disabled={state.loading}><RefreshCw size={13}/></button></PopHead>
    <div className="flex flex-col gap-1 p-[5px]">
      {state.error ? <p className="m-0 px-2 py-1.5 text-ui-sm text-red" role="alert">{state.error}</p> : null}
      {state.value !== undefined && sessions === null ? <p className="m-0 px-2 py-1.5 text-ui-sm text-fg-2">这个 Harness 的接口不能列出或继续它自己的会话。</p> : null}
      {sessions ? sessions.length ? <ul className="m-0 flex list-none flex-col p-0">{sessions.map(row => <li key={row.id} className="row flex items-center gap-2 rounded-row px-2 py-1.5">
        <div className="min-w-0 flex-1"><strong className="block truncate text-ui-sm font-medium">{row.title ?? "未命名会话"}</strong><small className="text-caption text-fg-3">{[when(row.updatedAt), row.source ? SOURCES[row.source] ?? row.source : ""].filter(Boolean).join(" · ")}</small></div>
        {row.conversationId
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen(row.conversationId!)}>打开对话 <ArrowUpRight size={12} aria-hidden="true"/></button>
          : <button type="button" className="btn btn-sm" disabled={disabled} onClick={event => { pressed.current = event.currentTarget; onImport(row.id); }}>接续</button>}
      </li>)}</ul> : <p className="m-0 px-2 py-1.5 text-ui-sm text-fg-3">这个工作区还没有本机会话。</p> : null}
      {state.loading ? <p className="m-0 flex items-center gap-2 px-2 py-1.5 text-ui-sm text-fg-3"><Spinner size={13} label=""/>正在从本机安装读取…</p> : null}
      {state.value?.nextCursor && !state.loading ? <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => read(state.value!.nextCursor!)}>加载更早的会话</button> : null}
      {hidden > 0 && !state.loading ? <p className="m-0 px-2 text-caption text-fg-3">已隐藏 {hidden} 个 HarnessHub 读取模型列表时建立的空会话。<button type="button" className="link-btn" onClick={() => { setProbes(true); read(undefined, true); }}>显示</button></p> : null}
      <p className="m-0 mt-1 px-2 pt-2 pb-1 text-caption text-fg-3 hairline-t">接续后别在原程序里同时继续它。</p>
    </div>
  </Popover>;
}
