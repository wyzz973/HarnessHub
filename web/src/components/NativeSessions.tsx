import { ArrowUpRight, History, RefreshCw } from "lucide-react";
import { useState } from "react";
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
 * The selected Harness's own sessions in this workspace, read on demand from the original installation. Continuing one
 * creates a new conversation that quotes its recent history and sends the next message to that native session; a
 * session a conversation already continues opens that conversation instead.
 */
export function NativeSessionsPanel({ load, onImport, onOpen, disabled, side = "top" }: {
  load: (cursor: string | undefined, signal: AbortSignal, probes?: boolean) => Promise<NativeSessionListView>;
  onImport: (nativeId: string) => void; onOpen: (conversationId: string) => void; disabled: boolean;
  /** Where the list opens from its button: above it (the default, at the foot of a conversation) or below it. */
  side?: "top" | "bottom";
}) {
  const [state, setState] = useState<{ loading: boolean; value: NativeSessionListView | undefined; error: string | null }>({ loading: false, value: undefined, error: null });
  // Sessions that the Hub's own model-list reads opened are empty; they stay out of the list unless asked for.
  const [probes, setProbes] = useState(false);
  const read = (cursor?: string, includeProbes = probes) => {
    setState(current => ({ loading: true, value: cursor === undefined ? undefined : current.value, error: null }));
    load(cursor, new AbortController().signal, includeProbes).then(page => setState(current => ({ loading: false, error: null,
      value: cursor === undefined || !current.value?.sessions || !page.sessions ? page : { sessions: [...current.value.sessions, ...page.sessions], nextCursor: page.nextCursor, hiddenProbes: (current.value.hiddenProbes ?? 0) + (page.hiddenProbes ?? 0) } })),
    error => setState(current => ({ loading: false, value: cursor === undefined ? undefined : current.value, error: errorMessage(error) })));
  };
  const sessions = state.value?.sessions, hidden = state.value?.hiddenProbes ?? 0;
  return <Popover label="本机会话" side={side} align="start" className="native-sessions w-[360px] max-w-[calc(100vw-24px)]"
    onOpenChange={open => { if (open && state.value === undefined && !state.loading) read(); }}
    trigger={<button type="button" className="icon-btn text-fg-3" aria-label="本机会话" title="继续这个 Agent 在本工作区的会话" disabled={disabled}><History size={16}/></button>}>
    <PopHead title="本机会话" closeLabel="收起本机会话"><button type="button" className="icon-btn icon-btn-sm" aria-label="重新读取本机会话" onClick={() => read()} disabled={state.loading}><RefreshCw size={13}/></button></PopHead>
    <div className="flex flex-col gap-1 p-[5px]">
      {state.error ? <p className="m-0 px-2 py-1.5 text-ui-sm text-red" role="alert">{state.error}</p> : null}
      {state.value !== undefined && sessions === null ? <p className="m-0 px-2 py-1.5 text-ui-sm text-fg-2">这个 Agent 的接口不能列出或继续它自己的会话。</p> : null}
      {sessions ? sessions.length ? <ul className="m-0 flex list-none flex-col p-0">{sessions.map(row => <li key={row.id} className="row flex items-center gap-2 rounded-[9px] px-2 py-1.5">
        <div className="min-w-0 flex-1"><strong className="block truncate text-ui-sm font-medium">{row.title ?? "未命名会话"}</strong><small className="text-caption text-fg-3">{[when(row.updatedAt), row.source ? SOURCES[row.source] ?? row.source : ""].filter(Boolean).join(" · ")}</small></div>
        {row.conversationId
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpen(row.conversationId!)}>打开对话 <ArrowUpRight size={12} aria-hidden="true"/></button>
          : <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onImport(row.id)}>接续</button>}
      </li>)}</ul> : <p className="m-0 px-2 py-1.5 text-ui-sm text-fg-3">这个工作区还没有本机会话。</p> : null}
      {state.loading ? <p className="m-0 flex items-center gap-2 px-2 py-1.5 text-ui-sm text-fg-3"><Spinner size={13} label=""/>正在从本机安装读取…</p> : null}
      {state.value?.nextCursor && !state.loading ? <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => read(state.value!.nextCursor!)}>加载更早的会话</button> : null}
      {hidden > 0 && !state.loading ? <p className="m-0 px-2 text-caption text-fg-3">已隐藏 {hidden} 个 HarnessHub 读取模型列表时建立的空会话。<button type="button" className="link-btn" onClick={() => { setProbes(true); read(undefined, true); }}>显示</button></p> : null}
      <p className="m-0 mt-1 px-2 pt-2 pb-1 text-caption text-fg-3 hairline-t">接续后，新消息直接发给这个本机会话，它记得自己的全部历史；对话里引用最近的消息。请不要同时在原程序中继续它。</p>
    </div>
  </Popover>;
}
