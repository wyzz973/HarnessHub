import * as Popover from "@radix-ui/react-popover";
import { ArrowUpRight, History, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import type { NativeSessionListView } from "../../../src/contracts/web.js";
import { errorMessage } from "../api.js";

const SOURCES: Readonly<Record<string, string>> = { cli: "终端", vscode: "编辑器", exec: "exec", appServer: "应用" };
function when(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The selected Harness's own sessions in this workspace, read on demand from the original installation. Continuing one
 * creates a new conversation that quotes its recent history and sends the next message to that native session; a
 * session a conversation already continues opens that conversation instead.
 */
export function NativeSessionsPanel({ load, onImport, onOpen, disabled }: {
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<NativeSessionListView>;
  onImport: (nativeId: string) => void; onOpen: (conversationId: string) => void; disabled: boolean;
}) {
  const [state, setState] = useState<{ loading: boolean; value: NativeSessionListView | undefined; error: string | null }>({ loading: false, value: undefined, error: null });
  const read = (cursor?: string) => {
    setState(current => ({ loading: true, value: cursor === undefined ? undefined : current.value, error: null }));
    load(cursor, new AbortController().signal).then(page => setState(current => ({ loading: false, error: null,
      value: cursor === undefined || !current.value?.sessions || !page.sessions ? page : { sessions: [...current.value.sessions, ...page.sessions], nextCursor: page.nextCursor } })),
    error => setState(current => ({ loading: false, value: cursor === undefined ? undefined : current.value, error: errorMessage(error) })));
  };
  const sessions = state.value?.sessions;
  return <Popover.Root onOpenChange={open => { if (open && state.value === undefined && !state.loading) read(); }}>
    <Popover.Trigger asChild><button type="button" className="composer-settings-trigger" aria-label="本机会话" title="继续这个 Harness 在本工作区的会话" disabled={disabled}><History size={15}/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="composer-settings-panel native-sessions" side="top" align="end" sideOffset={12} collisionPadding={16}>
      <div className="composer-settings-heading"><h3>本机会话</h3><span>
        <button type="button" className="icon-button" aria-label="重新读取本机会话" onClick={() => read()} disabled={state.loading}><RefreshCw size={14}/></button>
        <Popover.Close className="icon-button" aria-label="收起本机会话"><X size={15}/></Popover.Close></span></div>
      {state.error ? <p className="native-muted is-error">{state.error}</p> : null}
      {state.value !== undefined && sessions === null ? <p className="settings-help">这个 Harness 的接口不能列出或继续它自己的会话。</p> : null}
      {sessions ? sessions.length ? <ul className="native-session-list">{sessions.map(row => <li key={row.id}>
        <div><strong>{row.title ?? "未命名会话"}</strong><small>{[when(row.updatedAt), row.source ? SOURCES[row.source] ?? row.source : ""].filter(Boolean).join(" · ")}</small></div>
        {row.conversationId
          ? <button type="button" className="text-button" onClick={() => onOpen(row.conversationId!)}>打开对话 <ArrowUpRight size={12} aria-hidden="true"/></button>
          : <button type="button" className="text-button" disabled={disabled} onClick={() => onImport(row.id)}>接续</button>}
      </li>)}</ul> : <p className="native-muted">这个工作区还没有本机会话。</p> : null}
      {state.loading ? <p className="native-muted"><LoaderCircle size={12} className="spin" aria-hidden="true"/> 正在从本机安装读取…</p> : null}
      {state.value?.nextCursor && !state.loading ? <button type="button" className="text-button" onClick={() => read(state.value!.nextCursor!)}>加载更早的会话</button> : null}
      <p className="settings-help">接续后，新消息直接发给这个本机会话，它记得自己的全部历史；对话里引用最近的消息。请不要同时在原程序中继续它。</p>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
